/** Reply sinks: where a worker's answer/receipt for a task is delivered, chosen per task by reply_to.sink. */
import { createHmac } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { run } from "./channels/script.js";
import type { Config } from "./config.js";
import { type Envelope, REPORT_WORDS, type ReplyTo } from "./envelope.js";
import { atomicWrite, isInside } from "./fsutil.js";
import { postJson, resolveUrl } from "./net.js";
import { mask, registerSecret } from "./secrets.js";

export interface SinkResult {
  ok: boolean;
  detail: string;
}

export interface SinkContext {
  cfg: Config;
  inbox: string;
  env: NodeJS.ProcessEnv;
  timeoutMs: number;
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
        return { ok: false, detail: `unknown sink ${String((to as ReplyTo).sink)}` };
    }
  } catch (e) {
    return { ok: false, detail: mask((e as Error).message) };
  }
}

function fileSink(reply: Envelope, to: ReplyTo, ctx: SinkContext): SinkResult {
  const dir = ctx.cfg.sinks.file.dir ? path.resolve(ctx.cfg.sinks.file.dir) : path.join(ctx.inbox, "replies");
  const name = to.file ?? `${reply.task?.ref?.ticket_id ?? reply.thread ?? reply.id}.reply.json`;
  if (!/^[A-Za-z0-9._-]{1,128}$/.test(name) || name.startsWith(".")) return { ok: false, detail: "file sink: invalid file name" };
  const file = path.join(dir, name);
  atomicWrite(file, JSON.stringify(reply, null, 2) + "\n");
  return { ok: true, detail: `file ${name}` };
}

async function webhookSink(reply: Envelope, to: ReplyTo, ctx: SinkContext): Promise<SinkResult> {
  const hook = to.url_ref ? ctx.cfg.sinks.webhooks[to.url_ref] : undefined;
  if (!hook) return { ok: false, detail: `webhook sink: no webhook named ${to.url_ref ?? "?"} in the config` };
  const url = resolveUrl({ env: hook.url_env, what: `webhook ${to.url_ref}` }, ctx.env);
  registerSecret(url);
  const secret = ctx.env[hook.secret_env] ?? "";
  if (!secret) return { ok: false, detail: `webhook sink: signing secret not set (${hook.secret_env})` };
  registerSecret(secret);
  const body = JSON.stringify(reply);
  const ts = String(Math.floor(Date.now() / 1000));
  const r = await postJson(url, reply, { [SIGNATURE_HEADER]: webhookSignature(secret, ts, body), [TIMESTAMP_HEADER]: ts }, ctx.timeoutMs);
  return { ok: r.state === "started", detail: `webhook ${to.url_ref}: ${r.detail}` };
}

async function commandSink(reply: Envelope, to: ReplyTo, ctx: SinkContext): Promise<SinkResult> {
  const c = to.command_ref ? ctx.cfg.sinks.commands[to.command_ref] : undefined;
  if (!c) return { ok: false, detail: `command sink: no command named ${to.command_ref ?? "?"} in the config` };
  const r = await run(c.argv, JSON.stringify(reply) + "\n", (c.timeout_seconds ?? 60) * 1000, ctx.env);
  if (r.error) return { ok: false, detail: mask(`command ${to.command_ref} could not start: ${r.error}`) };
  if (r.timedOut) return { ok: false, detail: `command ${to.command_ref} timed out` };
  return { ok: r.code === 0, detail: mask(`command ${to.command_ref} exit ${r.code}${r.code ? ": " + r.stderr.trim().slice(-200) : ""}`) };
}

/** Write the report atomically, then atomically create `<report>.DONE`. The path must be inside an allowed root. */
function hufuReport(reply: Envelope, to: ReplyTo, ctx: SinkContext): SinkResult {
  const roots = ctx.cfg.sinks.report_roots;
  if (!roots.length) return { ok: false, detail: "hufu-report sink: no sinks.report_roots configured" };
  const target = path.resolve(to.report_path ?? "");
  if (!to.report_path || !path.isAbsolute(to.report_path)) return { ok: false, detail: "hufu-report sink: report_path must be absolute" };
  if (/(^|[\\/])\.\.([\\/]|$)/.test(to.report_path)) return { ok: false, detail: "hufu-report sink: report_path must not contain .." };
  if (!roots.some((r) => isInside(r, target) && path.resolve(r) !== target)) return { ok: false, detail: "hufu-report sink: report_path is outside the allowed report roots" };
  const done = `${target}.DONE`;
  fs.rmSync(done, { force: true }); // a stale marker must never point at a half-written report
  atomicWrite(target, renderReport(reply));
  atomicWrite(done, JSON.stringify({ id: reply.id, status: reply.status, at: new Date().toISOString() }) + "\n");
  return { ok: true, detail: `hufu-report ${path.basename(target)}` };
}
