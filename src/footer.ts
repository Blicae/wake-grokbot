/**
 * The fixed summary block at the end of a terminal report file (done / failed / declined).
 * Times are computed by the CLI from the task receipt (ack / working) and the reply's sent_at, shown in
 * Asia/Shanghai (北京时间). The account quota is passed in by the woken Bot (the CLI cannot read it).
 * This is receipt information only: it never changes the envelope, the webhook body or any public field.
 */
import type { ReplyRecord } from "./store.js";

/** Account-level weekly quota as the woken Bot saw it in its session (not what this task used). */
export interface Quota {
  used?: string;
  remaining?: string;
  reset?: string;
}

export const FOOTER_RULE = "---";
export const NO_ACK_START = "开始时间：未记录领单（ack）时间";
export const NOT_PROVIDED = "未提供";
export const NO_DURATION = "无法计算";

const URL_RE = /\b[a-z][a-z0-9+.-]*:\/\/\S+/i;
const SECRETISH_RE = /(authorization\s*:|bearer\s+[A-Za-z0-9._~+/=-]{8,}|\b(sk-|ghp_|xox[abprs]-|glpat-)[A-Za-z0-9_-]{8,}|-----BEGIN [A-Z ]*PRIVATE KEY-----)/i;

/** Problems with quota values (empty = fine). Quota text must be short, one line, and carry no URL or secret. */
export function quotaProblems(q: Quota | undefined): string[] {
  const p: string[] = [];
  if (!q) return p;
  for (const k of ["used", "remaining", "reset"] as const) {
    const v = q[k];
    if (v === undefined) continue;
    if (typeof v !== "string") p.push(`quota.${k} must be a string`);
    else if (v.length > 200) p.push(`quota.${k} is too long`);
    else if (URL_RE.test(v)) p.push(`quota.${k} must not contain a URL`);
    else if (SECRETISH_RE.test(v)) p.push(`quota.${k} looks like a secret`);
  }
  return p;
}

const pad = (n: number) => String(n).padStart(2, "0");
/** `YYYY-MM-DD HH:MM:SS` in Asia/Shanghai (UTC+8, no daylight saving). */
export function beijing(ms: number): string {
  const d = new Date(ms + 8 * 3600_000);
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}`;
}

const ISO_RE = /^\d{4}-\d{2}-\d{2}([T ]\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}(:?\d{2})?)?)?$/i;
/** An ISO-8601 time or an epoch (seconds or milliseconds) as ms; undefined when it is not a time we can trust. */
export function parseTime(s: string): number | undefined {
  const t = s.trim();
  if (/^\d{9,13}$/.test(t)) {
    const n = Number(t);
    return t.length <= 10 ? n * 1000 : n;
  }
  if (!ISO_RE.test(t)) return undefined;
  // a date or time without a zone is ambiguous: refuse rather than guess
  if (!/(Z|[+-]\d{2}(:?\d{2})?)$/i.test(t)) return undefined;
  const ms = Date.parse(t.replace(" ", "T"));
  return Number.isNaN(ms) ? undefined : ms;
}

/** Chinese duration, zero units omitted: 1小时5秒, 23分, 0秒. */
export function duration(ms: number): string {
  const s = Math.floor(ms / 1000);
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  const out = (d ? `${d}天` : "") + (h ? `${h}小时` : "") + (m ? `${m}分` : "") + (sec ? `${sec}秒` : "");
  return out || "0秒";
}

/**
 * Start of execution: the earliest ack (`acked_at`) or non-terminal (working / needs_input) reply, never the
 * ingest/queue time. An `acked_at` equal to any reply's time was filled in by that reply (no ack before it) and is
 * not an ack; working / needs_input replies are collected from the reply list on their own.
 */
export function startedAt(r: { acked_at?: string; replies: ReplyRecord[] } | undefined): number | undefined {
  if (!r) return undefined;
  const replyAt = new Set(r.replies.map((x) => x.at));
  const c: number[] = [];
  if (r.acked_at && !replyAt.has(r.acked_at)) c.push(Date.parse(r.acked_at));
  for (const x of r.replies) if (x.status === "working" || x.status === "needs_input") c.push(Date.parse(x.at));
  const ok = c.filter((n) => !Number.isNaN(n));
  return ok.length ? Math.min(...ok) : undefined;
}

const one = (s: string) => s.replace(/\s+/g, " ").trim();

/** The fixed footer (no trailing newline). `completedAt` is the terminal reply's sent_at. */
export function renderFooter(o: { quota?: Quota; startedAt?: number; completedAt: number }): string {
  const q = o.quota ?? {};
  const val = (v: string | undefined) => (v && one(v) ? one(v) : NOT_PROVIDED);
  let reset: string;
  if (!q.reset || !one(q.reset)) reset = NOT_PROVIDED;
  else {
    const ms = parseTime(q.reset);
    reset = ms === undefined ? `${one(q.reset)}（原样，未换算）` : `北京时间 ${beijing(ms)}`;
  }
  const done = `完成 北京时间 ${beijing(o.completedAt)}`;
  const run =
    o.startedAt === undefined
      ? `任务执行：${NO_ACK_START}，${done}，耗时 ${NO_DURATION}`
      : `任务执行：开始 北京时间 ${beijing(o.startedAt)}，${done}，耗时 ${o.completedAt >= o.startedAt ? duration(o.completedAt - o.startedAt) : NO_DURATION}`;
  return [FOOTER_RULE, `Grok Bot额度（周额度，非本单消耗）：已用 ${val(q.used)}，剩余 ${val(q.remaining)}，重置：${reset}`, run].join("\n");
}
