/** The public `wake-envelope/1` format. See schema/wake-envelope-1.schema.json and docs/protocol.md. */
import { createHash, createHmac, timingSafeEqual } from "node:crypto";

export const VERSION = "wake-envelope/1";
export const TYPES = ["task", "note", "answer", "receipt"] as const;
export const STATUSES = ["working", "needs_input", "done", "blocked", "failed", "declined"] as const;
export const ROLES = ["dispatcher", "worker"] as const;
export const SINKS = ["file", "webhook", "command", "hufu-report"] as const;

export type EnvelopeType = (typeof TYPES)[number];
export type Status = (typeof STATUSES)[number];
export type Role = (typeof ROLES)[number];

export interface ReplyTo {
  sink: (typeof SINKS)[number];
  /** file sink: file name inside the configured reply folder */
  file?: string;
  /** webhook sink: name of a configured webhook (never a URL) */
  url_ref?: string;
  /** command sink: name of a configured command */
  command_ref?: string;
  /** hufu-report sink: path of the report file, must be inside an allowed report root */
  report_path?: string;
}

export interface Envelope {
  v: typeof VERSION;
  id: string;
  type: EnvelopeType;
  from: string;
  to: string;
  project?: string;
  title?: string;
  body?: string;
  objective?: string;
  acceptance?: string[];
  authorization?: "explicit" | "inferred";
  quote?: string;
  quoted_at?: string;
  thread?: string;
  reply_to?: ReplyTo;
  status?: Status;
  question?: string;
  summary?: string;
  next?: string;
  task?: { ref?: { ticket_id?: string; card_path?: string } };
  sent_at: string;
  /** optional: after this time the envelope is stale (status and watch flag it) */
  expires_at?: string;
  sig?: string;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
/** RFC 3339 date-time, the same rule as JSON Schema `format: date-time` (ajv-formats). */
const DATE_TIME_RE = /^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])[T\s]([01]\d|2[0-3]):[0-5]\d:([0-5]\d|60)(\.\d+)?(Z|[+-]([01]\d|2[0-3])(:?[0-5]\d)?)$/i;
const isDateTime = (v: unknown) => typeof v === "string" && DATE_TIME_RE.test(v);
const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const URL_RE = /\b[a-z][a-z0-9+.-]*:\/\/\S+/i;
const SECRETISH_RE = /(authorization\s*:|bearer\s+[A-Za-z0-9._~+/=-]{8,}|\b(sk-|ghp_|xox[abprs]-|glpat-)[A-Za-z0-9_-]{8,}|-----BEGIN [A-Z ]*PRIVATE KEY-----)/i;
const KNOWN = new Set([
  "v", "id", "type", "from", "to", "project", "title", "body", "objective", "acceptance", "authorization", "quote",
  "quoted_at", "thread", "reply_to", "status", "question", "summary", "next", "task", "sent_at", "expires_at", "sig",
]);

/** Validate an envelope. Returns a list of problems (empty = valid). Mirrors the JSON Schema plus content rules. */
export function validate(x: unknown): string[] {
  const p: string[] = [];
  if (!x || typeof x !== "object" || Array.isArray(x)) return ["envelope must be a JSON object"];
  const e = x as Record<string, unknown>;
  for (const k of Object.keys(e)) if (!KNOWN.has(k)) p.push(`unknown field: ${k}`);
  if (e.v !== VERSION) p.push(`v must be "${VERSION}"`);
  if (typeof e.id !== "string" || !UUID_RE.test(e.id)) p.push("id must be a UUID");
  if (!TYPES.includes(e.type as EnvelopeType)) p.push(`type must be one of ${TYPES.join(", ")}`);
  for (const k of ["from", "to"]) if (typeof e[k] !== "string" || !NAME_RE.test(e[k] as string)) p.push(`${k} must be a short name`);
  if (!isDateTime(e.sent_at)) p.push("sent_at must be an RFC 3339 date-time");
  for (const k of ["project", "title", "body", "objective", "quote", "thread", "question", "summary", "next", "sig"])
    if (e[k] !== undefined && typeof e[k] !== "string") p.push(`${k} must be a string`);
  if (e.quoted_at !== undefined && !isDateTime(e.quoted_at)) p.push("quoted_at must be an RFC 3339 date-time");
  if (e.expires_at !== undefined && !isDateTime(e.expires_at)) p.push("expires_at must be an RFC 3339 date-time");
  if (e.thread !== undefined && typeof e.thread === "string" && !UUID_RE.test(e.thread)) p.push("thread must be a UUID");
  if (e.acceptance !== undefined && (!Array.isArray(e.acceptance) || !e.acceptance.every((a) => typeof a === "string")))
    p.push("acceptance must be a list of strings");
  if (e.authorization !== undefined && e.authorization !== "explicit" && e.authorization !== "inferred")
    p.push("authorization must be explicit or inferred");
  if (e.status !== undefined && !STATUSES.includes(e.status as Status)) p.push(`status must be one of ${STATUSES.join(", ")}`);
  if (e.type === "task" && typeof e.body !== "string" && typeof e.objective !== "string") p.push("a task needs body or objective");
  if ((e.type === "answer" || e.type === "receipt") && e.status === undefined) p.push(`${String(e.type)} needs status`);
  if (e.status === "needs_input" && typeof e.question !== "string") p.push("status needs_input needs question");
  if (e.reply_to !== undefined) {
    const r = e.reply_to as Record<string, unknown>;
    if (!r || typeof r !== "object" || Array.isArray(r)) p.push("reply_to must be an object");
    else {
      if (!SINKS.includes(r.sink as ReplyTo["sink"])) p.push(`reply_to.sink must be one of ${SINKS.join(", ")}`);
      for (const k of Object.keys(r)) if (!["sink", "file", "url_ref", "command_ref", "report_path"].includes(k)) p.push(`unknown field: reply_to.${k}`);
      for (const k of ["file", "url_ref", "command_ref", "report_path"]) if (r[k] !== undefined && typeof r[k] !== "string") p.push(`reply_to.${k} must be a string`);
      for (const k of ["url_ref", "command_ref"]) if (typeof r[k] === "string" && !NAME_RE.test(r[k] as string)) p.push(`reply_to.${k} must be a config name, not a URL or command`);
      if (r.sink === "webhook" && typeof r.url_ref !== "string") p.push("reply_to.url_ref is required for the webhook sink");
      if (r.sink === "command" && typeof r.command_ref !== "string") p.push("reply_to.command_ref is required for the command sink");
      if (r.sink === "hufu-report" && typeof r.report_path !== "string") p.push("reply_to.report_path is required for the hufu-report sink");
      if (r.sink === "file" && typeof r.file === "string" && !/^[A-Za-z0-9._-]{1,128}$/.test(r.file)) p.push("reply_to.file must be a plain file name");
    }
  }
  if (e.task !== undefined) {
    const t = e.task as Record<string, unknown>;
    const ref = t && typeof t === "object" ? (t.ref as Record<string, unknown> | undefined) : undefined;
    if (!t || typeof t !== "object" || (ref !== undefined && (typeof ref !== "object" || ref === null)))
      p.push("task.ref must be an object");
    else if (ref) for (const k of Object.keys(ref)) if (!["ticket_id", "card_path"].includes(k) || typeof ref[k] !== "string") p.push(`task.ref.${k} invalid`);
  }
  // content rules: envelopes carry no URLs and no secrets (config names only)
  const text = JSON.stringify({ ...e, sig: undefined });
  if (URL_RE.test(text)) p.push("envelopes must not contain URLs (use config names such as reply_to.url_ref)");
  if (SECRETISH_RE.test(text)) p.push("envelope looks like it contains a secret");
  return p;
}

/** Canonical JSON: keys sorted recursively, `sig` dropped, undefined removed. Used for hashing and signing. */
export function canonical(e: Envelope | Record<string, unknown>): string {
  const norm = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(norm);
    if (v && typeof v === "object") {
      const o: Record<string, unknown> = {};
      for (const k of Object.keys(v as object).sort()) {
        const val = (v as Record<string, unknown>)[k];
        if (val !== undefined) o[k] = norm(val);
      }
      return o;
    }
    return v;
  };
  const { sig: _sig, ...rest } = e as Record<string, unknown>;
  void _sig;
  return JSON.stringify(norm(rest));
}

/** Content hash for idempotency (sent_at is part of the content: re-sending must reuse the original envelope). */
export function contentHash(e: Envelope): string {
  return createHash("sha256").update(canonical(e)).digest("hex");
}

const SIG_DOMAIN = "wake-envelope/1\n";

export function sign(e: Envelope, key: Buffer): string {
  return "hmac-sha256:" + createHmac("sha256", key).update(SIG_DOMAIN + canonical(e)).digest("hex");
}

export function verify(e: Envelope, key: Buffer): "ok" | "missing" | "malformed" | "wrong" {
  if (!e.sig) return "missing";
  const m = /^hmac-sha256:([0-9a-f]{64})$/.exec(e.sig);
  if (!m) return "malformed";
  const want = Buffer.from(sign(e, key).slice(12), "hex");
  return timingSafeEqual(Buffer.from(m[1]!, "hex"), want) ? "ok" : "wrong";
}

/** A-2-A aligned status words, and the Chinese words used by Hufu-style report files. */
export const REPORT_WORDS: Record<Status, string> = {
  working: "进展",
  needs_input: "等待",
  done: "就绪",
  blocked: "受阻",
  failed: "失败",
  declined: "无需处理",
};

/** True when the envelope carries `expires_at` and that time has passed. */
export function isExpired(e: Pick<Envelope, "expires_at"> | null | undefined, now = Date.now()): boolean {
  if (!e?.expires_at) return false;
  const t = Date.parse(e.expires_at);
  return !Number.isNaN(t) && t <= now;
}

export function isTerminal(s: Status | undefined): boolean {
  return s === "done" || s === "failed" || s === "declined";
}
