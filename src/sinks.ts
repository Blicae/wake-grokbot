/** Reply sinks: where a worker's answer/receipt for a task is delivered, chosen per task by reply_to.sink. */
import { createHash, createHmac, randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { run } from "./channels/script.js";
import type { Config } from "./config.js";
import { type Envelope, isTerminal, REPORT_WORDS, type ReplyTo } from "./envelope.js";
import { atomicWrite, isInside } from "./fsutil.js";
import { postJson, resolveUrl } from "./net.js";
import { mask, registerSecret } from "./secrets.js";

/** Outcome for the caller's retry decision: not_sent = nothing happened (safe to retry); unknown = may have happened. */
export type SinkOutcome = "delivered" | "not_sent" | "unknown";
/** File and report sinks only: what happened against the on-disk state. */
export type SinkState = "delivered" | "duplicate" | "superseded" | "conflict" | "failed";

export interface SinkResult {
  ok: boolean;
  detail: string;
  outcome?: SinkOutcome;
  state?: SinkState;
}

/** Task association allocated by core: revision is monotonic per task and reused unchanged on resend. */
export interface SinkDelivery {
  taskId: string;
  /** contentHash(reply): hash of the reply envelope, not of any file */
  replyHash: string;
  revision: number;
}

export interface SinkContext {
  cfg: Config;
  inbox: string;
  env: NodeJS.ProcessEnv;
  timeoutMs: number;
  /** absent = legacy call: no task association, no ordering or replay guarantees */
  delivery?: SinkDelivery;
}

export const STATE_FORMAT = "wake-sink-state/1";
export const DONE_FORMAT = "wake-report-done/1";
export const DELIVERY_ID_HEADER = "x-wake-grokbot-delivery-id";
/** Identity of this process for lock ownership: host + pid + start time + a random token per lock. */
const PROCESS_START = Math.round(Date.now() - process.uptime() * 1000);

/** Write windows of a file/report delivery, in order. */
export type WriteWindow = "intent" | "report" | "sidecar" | "marker";
/**
 * Test-only fault injection: not exported from the package entry (src/index.ts), not reachable from the CLI,
 * config or environment. Tests set `fault` to throw (or block) right after a write window.
 */
export const _testHooks: { fault?: (after: WriteWindow) => void; lockReclaim?: (phase: "checked") => void } = {};

/** True when the sink can be replayed safely with the same delivery (file and report sinks are idempotent). */
export function sinkReplaySafe(to: ReplyTo): boolean {
  return to.sink === "file" || to.sink === "hufu-report";
}

export const SIGNATURE_HEADER = "x-wake-grokbot-signature";
export const TIMESTAMP_HEADER = "x-wake-grokbot-timestamp";

/** HMAC-SHA256 over `<timestamp>.<body>`; header value `sha256=<hex>`. */
export function webhookSignature(secret: string, timestamp: string, body: string): string {
  return "sha256=" + createHmac("sha256", secret).update(`${timestamp}.${body}`).digest("hex");
}

/** First line, optional decision line, blank line, body. Status words follow the Hufu-style report convention. */
export function renderReport(reply: Envelope): string {
  const word = REPORT_WORDS[reply.status ?? "working"];
  const one = (s: string) => s.replace(/\s+/g, " ").trim();
  const lines = [`${word}：${one(reply.summary ?? reply.title ?? "")}`];
  if (reply.status === "needs_input" && reply.question) lines.push(`待人工决定：${one(reply.question)}`);
  lines.push("", (reply.body ?? "").replace(/\r\n/g, "\n").trimEnd(), "");
  return lines.join("\n");
}

export async function deliver(reply: Envelope, to: ReplyTo, ctx: SinkContext): Promise<SinkResult> {
  try {
    switch (to.sink) {
      case "file":
        return fileSink(reply, to, ctx);
      case "webhook":
        return await webhookSink(reply, to, ctx);
      case "command":
        return await commandSink(reply, to, ctx);
      case "hufu-report":
        return hufuReport(reply, to, ctx);
      default:
        return { ok: false, outcome: "not_sent", detail: `unknown sink ${String((to as ReplyTo).sink)}` };
    }
  } catch (e) {
    return { ok: false, outcome: "unknown", detail: mask((e as Error).message) };
  }
}

const sha256 = (b: string | Buffer) => createHash("sha256").update(b).digest("hex");
const notSent = (detail: string, state?: SinkState): SinkResult => ({ ok: false, outcome: "not_sent", detail, ...(state ? { state } : {}) });

function readMaybe(file: string): Buffer | undefined {
  try {
    return fs.readFileSync(file);
  } catch {
    return undefined;
  }
}
function parseMaybe(b: Buffer | undefined): Record<string, unknown> | undefined {
  if (!b) return undefined;
  try {
    const v = JSON.parse(b.toString("utf8")) as unknown;
    return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined;
  } catch {
    return undefined;
  }
}

interface LockOwner {
  host: string;
  pid: number;
  started_at: number;
  token: string;
}

/** Is the recorded owner provably gone? Only for a lock of this host whose pid no longer exists (or is reused by us). */
function ownerGone(o: LockOwner): { gone: boolean; why: string } {
  if (o.host !== os.hostname()) return { gone: false, why: `held on another host (${o.host})` };
  if (o.pid === process.pid) return o.started_at === PROCESS_START ? { gone: false, why: "held by this process" } : { gone: true, why: "pid reused by this process" };
  try {
    process.kill(o.pid, 0);
    return { gone: false, why: `pid ${o.pid} is alive (or reused; cannot prove it is gone)` };
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    return code === "ESRCH" ? { gone: true, why: `pid ${o.pid} is gone` } : { gone: false, why: `pid ${o.pid} exists (${code})` };
  }
}

/**
 * Per-path lock: exclusive create, no waiting. Never stolen by age: reclaimed only when the owner is provably gone
 * (same host, pid no longer exists). Otherwise busy, with a manual-recovery hint.
 */
function tryLock(target: string): { release: () => void } | { busy: string } {
  const lock = `${target}.lock`;
  fs.mkdirSync(path.dirname(lock), { recursive: true });
  const me: LockOwner = { host: os.hostname(), pid: process.pid, started_at: PROCESS_START, token: randomUUID() };
  const manual = `retryable; if no wake-grokbot process holds it, remove ${path.basename(lock)} manually`;
  for (let i = 0; i < 3; i++) {
    try {
      fs.writeFileSync(lock, JSON.stringify(me) + "\n", { flag: "wx" });
      return {
        release: () => {
          const cur = parseMaybe(readMaybe(lock));
          if (cur?.token === me.token) fs.rmSync(lock, { force: true });
        },
      };
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
    }
    const raw = readMaybe(lock);
    if (!raw) continue; // released meanwhile
    const o = parseMaybe(raw) as LockOwner | undefined;
    if (!o || typeof o.pid !== "number" || typeof o.host !== "string" || typeof o.token !== "string") return { busy: `lock is unreadable; ${manual}` };
    const g = ownerGone(o);
    if (!g.gone) return { busy: `locked (${g.why}); ${manual}` };
    _testHooks.lockReclaim?.("checked");
    // Reclaim under a separate reclaim mutex, never by moving the lock: the lock is only removed by its owner or by
    // a reclaimer holding `<lock>.reclaim`, so re-checking the token under that mutex proves the file we remove is
    // still the dead owner's (a fresh live lock can never be moved or removed). A stuck reclaim mutex is never
    // stolen either: manual recovery.
    const reclaim = `${lock}.reclaim`;
    try {
      fs.writeFileSync(reclaim, JSON.stringify(me) + "\n", { flag: "wx" });
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
      return { busy: `lock is being reclaimed (${path.basename(reclaim)}); ${manual} and ${path.basename(reclaim)}` };
    }
    try {
      const again = parseMaybe(readMaybe(lock));
      if (again && again.token === o.token) fs.rmSync(lock, { force: true });
      else if (again) return { busy: `locked by a new owner; ${manual}` };
    } finally {
      if (parseMaybe(readMaybe(reclaim))?.token === me.token) fs.rmSync(reclaim, { force: true });
    }
  }
  return { busy: `lock is contended; ${manual}` };
}

interface Target {
  file: string;
  content: string;
  /** report sink: write `<file>.DONE` for terminal statuses */
  marker: boolean;
  label: string;
}

/**
 * Write a target with ordering, ownership and idempotency checks against `<file>.wake.json` (when ctx.delivery
 * is set), under a per-path lock. Write windows, in order: intent (state, phase "intent", expected report hash)
 * -> report (old marker removed first) -> sidecar (state, phase "committed") -> marker (terminal only).
 * A retry of the same delivery repairs its own half-finished writes; unowned files are never overwritten.
 */
function writeTarget(reply: Envelope, t: Target, ctx: SinkContext): SinkResult {
  const lk = tryLock(t.file);
  if ("busy" in lk) return notSent(`${t.label}: ${lk.busy}`, "failed");
  let touched = false;
  const hook = (w: WriteWindow) => _testHooks.fault?.(w);
  try {
    const d = ctx.delivery;
    const stateFile = `${t.file}.wake.json`;
    const done = `${t.file}.DONE`;
    const terminal = isTerminal(reply.status);
    const st = parseMaybe(readMaybe(stateFile));
    const existing = readMaybe(t.file);
    const bytes = Buffer.from(t.content, "utf8");
    const fileHash = sha256(bytes);
    const assoc = d ? { task_id: d.taskId, revision: d.revision, reply_hash: d.replyHash } : {};
    if (!d) {
      if (st || fs.existsSync(stateFile)) return notSent(`${t.label}: target is owned by a task delivery; legacy call refused`);
    } else {
      if (!st && (existing || fs.existsSync(done) || fs.existsSync(stateFile))) return notSent(`${t.label}: target exists and is not owned by this delivery`, "conflict");
      if (st && st.format !== STATE_FORMAT) return notSent(`${t.label}: unknown state format`, "conflict");
      if (st) {
        if (st.task_id !== d.taskId) return notSent(`${t.label}: target belongs to another task`, "conflict");
        const rev = Number(st.revision);
        if (d.revision < rev) return { ok: true, outcome: "not_sent", state: "superseded", detail: `${t.label}: revision ${d.revision} superseded by ${rev}` };
        if (d.revision === rev) {
          if (st.reply_hash !== d.replyHash) return notSent(`${t.label}: same revision ${rev} with different content`, "conflict");
          const onDisk = existing ? sha256(existing) : "";
          const m = parseMaybe(readMaybe(done));
          const markerOk = !t.marker
            ? true
            : terminal
              ? !!m && m.format === DONE_FORMAT && m.id === reply.id && m.status === reply.status && m.task_id === d.taskId && m.revision === rev && m.reply_hash === d.replyHash && m.report_sha256 === fileHash
              : !fs.existsSync(done);
          const consistent = st.phase === "committed" && st.reply_id === reply.id && st.status === reply.status && st.report_sha256 === fileHash && onDisk === fileHash && markerOk;
          if (consistent) return { ok: true, outcome: "delivered", state: "duplicate", detail: `${t.label}: already delivered` };
          // else: our own delivery, half finished or damaged: repair below
        } else if (isTerminal(st.status as Envelope["status"]) && !terminal) {
          return { ok: true, outcome: "not_sent", state: "superseded", detail: `${t.label}: terminal state is kept` };
        }
      }
    }
    touched = true;
    const record = (phase: string) => JSON.stringify({ format: STATE_FORMAT, ...assoc, reply_id: reply.id, status: reply.status, report_sha256: fileHash, phase }) + "\n";
    if (d) atomicWrite(stateFile, record("intent"));
    hook("intent");
    if (t.marker) fs.rmSync(done, { force: true }); // a stale marker must never point at a half-written report
    atomicWrite(t.file, bytes);
    hook("report");
    if (d) atomicWrite(stateFile, record("committed"));
    hook("sidecar");
    if (t.marker && terminal) {
      atomicWrite(done, JSON.stringify({ format: DONE_FORMAT, id: reply.id, ...assoc, status: reply.status, report_sha256: fileHash, at: new Date().toISOString() }) + "\n");
      hook("marker");
    }
    return { ok: true, outcome: "delivered", ...(d ? { state: "delivered" as const } : {}), detail: t.label };
  } catch (e) {
    return { ok: false, outcome: touched ? "unknown" : "not_sent", ...(ctx.delivery ? { state: "failed" as const } : {}), detail: mask(`${t.label}: ${(e as Error).message}`) };
  } finally {
    lk.release();
  }
}

function fileSink(reply: Envelope, to: ReplyTo, ctx: SinkContext): SinkResult {
  const dir = ctx.cfg.sinks.file.dir ? path.resolve(ctx.cfg.sinks.file.dir) : path.join(ctx.inbox, "replies");
  const name = to.file ?? `${reply.task?.ref?.ticket_id ?? reply.thread ?? reply.id}.reply.json`;
  if (!/^[A-Za-z0-9._-]{1,128}$/.test(name) || name.startsWith(".")) return notSent("file sink: invalid file name");
  return writeTarget(reply, { file: path.join(dir, name), content: JSON.stringify(reply, null, 2) + "\n", marker: false, label: `file ${name}` }, ctx);
}

async function webhookSink(reply: Envelope, to: ReplyTo, ctx: SinkContext): Promise<SinkResult> {
  const hook = to.url_ref ? ctx.cfg.sinks.webhooks[to.url_ref] : undefined;
  if (!hook) return notSent(`webhook sink: no webhook named ${to.url_ref ?? "?"} in the config`);
  let url: string;
  try {
    url = resolveUrl({ env: hook.url_env, what: `webhook ${to.url_ref}` }, ctx.env);
  } catch (e) {
    return notSent(mask((e as Error).message));
  }
  registerSecret(url);
  const secret = ctx.env[hook.secret_env] ?? "";
  if (!secret) return notSent(`webhook sink: signing secret not set (${hook.secret_env})`);
  registerSecret(secret);
  const body = JSON.stringify(reply);
  const ts = String(Math.floor(Date.now() / 1000));
  // the delivery id lets a receiver spot repeats; it is not a server-side idempotency guarantee
  const r = await postJson(url, reply, { [SIGNATURE_HEADER]: webhookSignature(secret, ts, body), [TIMESTAMP_HEADER]: ts, [DELIVERY_ID_HEADER]: reply.id }, ctx.timeoutMs);
  // not_sent only when provably nothing reached the peer (connection refused/unresolvable before any byte, no HTTP
  // status). Any HTTP answer other than 2xx (3xx is never followed, 4xx, 429, 5xx) or a timeout: the peer may have
  // acted, so the outcome is unknown and must not be resent automatically.
  const outcome: SinkOutcome = r.state === "started" ? "delivered" : r.state === "not_started" && r.status === undefined ? "not_sent" : "unknown";
  return { ok: r.state === "started", outcome, detail: `webhook ${to.url_ref}: ${r.detail}` };
}

async function commandSink(reply: Envelope, to: ReplyTo, ctx: SinkContext): Promise<SinkResult> {
  const c = to.command_ref ? ctx.cfg.sinks.commands[to.command_ref] : undefined;
  if (!c) return notSent(`command sink: no command named ${to.command_ref ?? "?"} in the config`);
  const r = await run(c.argv, JSON.stringify(reply) + "\n", (c.timeout_seconds ?? 60) * 1000, ctx.env);
  if (r.error) return notSent(mask(`command ${to.command_ref} could not start: ${r.error}`));
  if (r.timedOut) return { ok: false, outcome: "unknown", detail: `command ${to.command_ref} timed out` };
  return { ok: r.code === 0, outcome: r.code === 0 ? "delivered" : "unknown", detail: mask(`command ${to.command_ref} exit ${r.code}${r.code ? ": " + r.stderr.trim().slice(-200) : ""}`) };
}

/** Report sink: the path must be absolute and inside an allowed root (never remapped). `.DONE` only for terminal statuses. */
function hufuReport(reply: Envelope, to: ReplyTo, ctx: SinkContext): SinkResult {
  const roots = ctx.cfg.sinks.report_roots;
  if (!roots.length) return notSent("hufu-report sink: no sinks.report_roots configured");
  const target = path.resolve(to.report_path ?? "");
  if (!to.report_path || !path.isAbsolute(to.report_path)) return notSent("hufu-report sink: report_path must be absolute");
  if (/(^|[\\/])\.\.([\\/]|$)/.test(to.report_path)) return notSent("hufu-report sink: report_path must not contain ..");
  if (!roots.some((r) => isInside(r, target) && path.resolve(r) !== target)) return notSent("hufu-report sink: report_path is outside the allowed report roots");
  return writeTarget(reply, { file: target, content: renderReport(reply), marker: true, label: `hufu-report ${path.basename(target)}` }, ctx);
}
