/** Reply sinks: where a worker's answer/receipt for a task is delivered, chosen per task by reply_to.sink. */
import { createHash, createHmac } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { run } from "./channels/script.js";
import type { Config } from "./config.js";
import { type Envelope, isTerminal, REPORT_WORDS, REPORT_WORD_EXCEPTIONS, type ReplyTo } from "./envelope.js";
import { atomicWrite, isInside, tryLock } from "./fsutil.js";
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
  /** report sinks only: fixed footer appended to a terminal report (never sent to webhooks or commands) */
  reportFooter?: string;
  /** Explicit operator consent to adopt an existing hufu-report. */
  keepReport?: boolean;
}

export const STATE_FORMAT = "wake-sink-state/1";
export const DONE_FORMAT = "wake-report-done/1";
export const DELIVERY_ID_HEADER = "x-wake-grokbot-delivery-id";
/** Write windows of a file/report delivery, in order. */
export type WriteWindow = "intent" | "report" | "sidecar" | "marker";
/**
 * Test-only fault injection: not exported from the package entry (src/index.ts), not reachable from the CLI,
 * config or environment. Tests set `fault` to throw (or block) right after a write window.
 */
export const _testHooks: { fault?: (after: WriteWindow) => void } = {};

/** True when the sink can be replayed safely with the same delivery (file and report sinks are idempotent). */
export function sinkReplaySafe(to: ReplyTo): boolean {
  return to.sink === "file" || to.sink === "hufu-report" || to.sink === "report-file";
}

export const SIGNATURE_HEADER = "x-wake-grokbot-signature";
export const TIMESTAMP_HEADER = "x-wake-grokbot-timestamp";

/** HMAC-SHA256 over `<timestamp>.<body>`; header value `sha256=<hex>`. */
export function webhookSignature(secret: string, timestamp: string, body: string): string {
  return "sha256=" + createHmac("sha256", secret).update(`${timestamp}.${body}`).digest("hex");
}

/**
 * First line, optional decision line, blank line, body. Status words follow the Hufu-style report convention.
 * A terminal report may end with a fixed footer (blank line, then the footer block); non-terminal reports never do.
 */
export function renderReport(reply: Envelope, footer?: string): string {
  const word = REPORT_WORDS[reply.status ?? "working"];
  const one = (s: string) => s.replace(/\s+/g, " ").trim();
  const lines = [`${word}：${one(reply.summary ?? reply.title ?? "")}`];
  if (reply.status === "needs_input" && reply.question) lines.push(`待人工决定：${one(reply.question)}`);
  lines.push("", (reply.body ?? "").replace(/\r\n/g, "\n").trimEnd(), "");
  if (footer && isTerminal(reply.status)) lines.push(footer, "");
  return lines.join("\n");
}

/** Preserve authored text; only supply a missing protocol header/footer. Called under the target lock. */
function adoptReport(reply: Envelope, text: string, ctx: SinkContext): string {
  const word = REPORT_WORDS[reply.status ?? "working"];
  const first = text.split(/\r?\n/, 1)[0] ?? "";
  const present = Object.values(REPORT_WORDS).find((w) => first.startsWith(`${w}：`));
  const allowed = REPORT_WORD_EXCEPTIONS.some((x) => x.word === present && x.status === reply.status && x.keepReport === ctx.keepReport);
  if (present && present !== word && !allowed) throw new Error("report first-line status does not match reply status");
  if (!present) text = `${word}：${(reply.summary ?? reply.title ?? "").replace(/\s+/g, " ").trim()}\n\n${text}`;
  if (isTerminal(reply.status) && ctx.reportFooter && !/(?:^|\r?\n)---\r?\n(?:账号用量|Grok Bot额度)[^\r\n]*(?:\r?\n[^\r\n]*)*$/.test(text)) {
    text += `${text.endsWith("\n") ? "\n" : "\n\n"}${ctx.reportFooter}\n`;
  }
  return text;
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
      case "report-file":
      case "hufu-report":
        return reportFile(reply, to, ctx);
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
  const lk = tryLock(`${t.file}.lock`);
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
    if (ctx.keepReport && t.marker && !existing) return notSent(`${t.label}: keep-report requires an existing report`, "conflict");
    const bytes = Buffer.from(ctx.keepReport && t.marker ? adoptReport(reply, existing!.toString("utf8"), ctx) : t.content, "utf8");
    const fileHash = sha256(bytes);
    const assoc = d ? { task_id: d.taskId, revision: d.revision, reply_hash: d.replyHash } : {};
    if (!d) {
      if (st || fs.existsSync(stateFile)) return notSent(`${t.label}: target is owned by a task delivery; legacy call refused`);
    } else {
      const claim = ctx.keepReport && t.marker && existing && !fs.existsSync(stateFile);
      const marker = parseMaybe(readMaybe(done));
      if (claim && marker?.task_id && marker.task_id !== d.taskId) return notSent(`${t.label}: marker belongs to another task`, "conflict");
      if (!st && !claim && (existing || fs.existsSync(done) || fs.existsSync(stateFile))) return notSent(`${t.label}: target exists and is not owned by this delivery`, "conflict");
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
function reportFile(reply: Envelope, to: ReplyTo, ctx: SinkContext): SinkResult {
  const roots = ctx.cfg.sinks.report_roots;
  if (!roots.length) return notSent("hufu-report sink: no sinks.report_roots configured");
  const target = path.resolve(to.report_path ?? "");
  if (!to.report_path || !path.isAbsolute(to.report_path)) return notSent("hufu-report sink: report_path must be absolute");
  if (/(^|[\\/])\.\.([\\/]|$)/.test(to.report_path)) return notSent("hufu-report sink: report_path must not contain ..");
  if (!roots.some((r) => isInside(r, target) && path.resolve(r) !== target)) return notSent("hufu-report sink: report_path is outside the allowed report roots");
  return writeTarget(reply, { file: target, content: ctx.keepReport ? "" : renderReport(reply, ctx.reportFooter), marker: true, label: `hufu-report ${path.basename(target)}` }, ctx);
}
