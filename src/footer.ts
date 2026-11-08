/**
 * The fixed summary block at the end of a terminal report file (done / failed / declined).
 * Times are computed by the CLI from the task receipt (ack / working) and the reply's sent_at, shown in
 * the configured timezone. The account quota is passed in by the woken Bot (the CLI cannot read it).
 * This is receipt information only: it never changes the envelope, the webhook body or any public field.
 */
import type { ReportLocale } from "./envelope.js";
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

/** Rejects non-strings, >200 characters, scheme URLs and listed secret patterns; not an exhaustive secret detector. */
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

/** Stable numeric date/time in an IANA timezone, including daylight-saving transitions. */
export function zonedTime(ms: number, timezone: string): string {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23" }).formatToParts(ms);
  const get = (key: string) => parts.find((p) => p.type === key)!.value;
  return `${get("year")}-${get("month")}-${get("day")} ${get("hour")}:${get("minute")}:${get("second")}`;
}
/** Compatibility helper: the original Shanghai date/time format. */
export function beijing(ms: number): string { return zonedTime(ms, "Asia/Shanghai"); }

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
  if (!/[T ]\d{2}:\d{2}.*(Z|[+-]\d{2}(:?\d{2})?)$/i.test(t)) return undefined;
  const ms = Date.parse(t.replace(" ", "T"));
  return Number.isNaN(ms) ? undefined : ms;
}

/** Chinese duration, zero units omitted: 1小时5秒, 23分, 0秒. */
export function duration(ms: number, locale: ReportLocale = "zh-CN"): string {
  const s = Math.floor(ms / 1000);
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  if (locale === "en") return [(d ? `${d}d` : ""), (h ? `${h}h` : ""), (m ? `${m}m` : ""), (sec ? `${sec}s` : "")].join("") || "0s";
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
export function renderFooter(o: { quota?: Quota; startedAt?: number; completedAt: number; locale?: ReportLocale; timezone?: string; quotaLine?: boolean }): string {
  // Omitted options preserve the historical public helper's output.
  const locale = o.locale ?? "zh-CN";
  const zh = locale === "zh-CN";
  const timezone = o.timezone ?? "Asia/Shanghai";
  const zone = zh && timezone === "Asia/Shanghai" ? "北京时间" : timezone;
  const time = (ms: number) => `${zone} ${zonedTime(ms, timezone)}`;
  const q = o.quota ?? {};
  const missing = zh ? NOT_PROVIDED : "not provided";
  const unavailable = zh ? NO_DURATION : "unavailable";
  const val = (v: string | undefined) => (v && one(v) ? one(v) : missing);
  let reset: string;
  if (!q.reset || !one(q.reset)) reset = missing;
  else {
    const ms = parseTime(q.reset);
    reset = ms === undefined ? `${one(q.reset)}${zh ? "（原样，未换算）" : " (as given, not converted)"}` : time(ms);
  }
  const elapsed = o.startedAt !== undefined && o.completedAt >= o.startedAt ? duration(o.completedAt - o.startedAt, locale) : unavailable;
  const run = zh
    ? `任务执行：${o.startedAt === undefined ? NO_ACK_START : `开始 ${time(o.startedAt)}`}，完成 ${time(o.completedAt)}，耗时 ${elapsed}`
    : `Execution: ${o.startedAt === undefined ? "start: no ack recorded" : `started ${time(o.startedAt)}`}, completed ${time(o.completedAt)}, duration ${elapsed}`;
  const quota = zh
    ? `Grok Bot额度（周额度，非本单消耗）：已用 ${val(q.used)}，剩余 ${val(q.remaining)}，重置：${reset}`
    : `Account quota (weekly, not task usage): used ${val(q.used)}, remaining ${val(q.remaining)}, reset: ${reset}`;
  return [FOOTER_RULE, ...(o.quota !== undefined || (o.quotaLine ?? true) ? [quota] : []), run].join("\n");
}
