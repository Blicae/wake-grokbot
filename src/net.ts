import * as fs from "node:fs";
import { mask } from "./secrets.js";

const LOOPBACK = new Set(["127.0.0.1", "localhost", "::1", "[::1]"]);

/** Resolve a URL from an env var name or a file; https required except for loopback. Never returns it in errors. */
export function resolveUrl(opts: { env?: string; file?: string; what: string }, env: NodeJS.ProcessEnv = process.env): string {
  let url = opts.env ? (env[opts.env] ?? "").trim() : "";
  if (!url && opts.file) {
    try {
      url = (fs.readFileSync(opts.file, "utf8").replace(/^\uFEFF/, "").split(/\r?\n/).find((l) => l.trim()) ?? "").trim();
    } catch (e) {
      throw new ChannelConfigError(`${opts.what}: cannot read the URL file (${(e as NodeJS.ErrnoException).code ?? "error"})`);
    }
  }
  if (!url) throw new ChannelConfigError(`${opts.what}: URL not set (environment variable ${opts.env ?? "?"}${opts.file ? " or url_file" : ""})`);
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    throw new ChannelConfigError(`${opts.what}: the configured URL is not valid`);
  }
  if (u.protocol !== "https:" && !(u.protocol === "http:" && LOOPBACK.has(u.hostname)))
    throw new ChannelConfigError(`${opts.what}: the URL must use https`);
  return url;
}

export class ChannelConfigError extends Error {}

export type PostOutcome = {
  state: "started" | "not_started" | "unknown";
  status?: number;
  detail: string;
  /** HTTP 429, or a 400 whose body says it is a rate limit. */
  rateLimited?: boolean;
  /** From a Retry-After header (seconds or HTTP date), when present and valid. */
  retryAfterMs?: number;
};

const RATE_LIMIT_TEXT = /rate[\s_-]?limit|too many requests|throttl|quota exceeded|slow down/i;

/** Longest Retry-After honored; anything longer waits this long. */
export const RETRY_AFTER_MAX_MS = 24 * 3600_000;

/** Retry-After as milliseconds from `now`: delta-seconds or an HTTP date. Capped at 24 hours; undefined when absent or invalid. */
export function parseRetryAfter(v: string | null | undefined, now = Date.now()): number | undefined {
  const t = (v ?? "").trim();
  if (!t) return undefined;
  let ms: number;
  if (/^\d+$/.test(t)) ms = Number(t) * 1000;
  else {
    if (!/[a-z]/i.test(t)) return undefined; // HTTP dates name the weekday/month; "-5" etc. are invalid
    const d = Date.parse(t);
    if (Number.isNaN(d)) return undefined;
    ms = Math.max(0, d - now);
  }
  return Math.min(ms, RETRY_AFTER_MAX_MS);
}

/**
 * POST JSON. Redirects are refused (never followed). 2xx = accepted/started; 3xx/4xx = not started (safe to
 * resend); 5xx or timeout = unknown (the request may have been acted on: never resend automatically).
 */
export async function postJson(url: string, body: unknown, headers: Record<string, string>, timeoutMs: number): Promise<PostOutcome> {
  let res: Response;
  try {
    res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json", "user-agent": "wake-grokbot", ...headers },
      body: JSON.stringify(body),
      redirect: "manual",
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (e) {
    const err = e as Error & { cause?: { code?: string; message?: string; errors?: { code?: string }[] } };
    const code = err.cause?.code ?? err.cause?.errors?.find((x) => x.code)?.code ?? "";
    if (err.cause?.message === "bad port") return { state: "not_started", detail: "connection failed (port not allowed)" };
    if (["ECONNREFUSED", "ENOTFOUND", "EAI_AGAIN", "ECONNRESET_BEFORE"].includes(code))
      return { state: "not_started", detail: `connection failed (${code})` };
    if (err.name === "TimeoutError" || err.name === "AbortError") return { state: "unknown", detail: "timed out; outcome unknown" };
    return { state: "unknown", detail: mask(`request failed (${code || err.name}); outcome unknown`) };
  }
  const s = res.status;
  // Read at most a small prefix of the body; it is only scanned for a rate-limit hint, never logged.
  const text = s === 400 ? await res.text().catch(() => "") : (await res.arrayBuffer().catch(() => undefined), "");
  if (s === 429 || (s === 400 && RATE_LIMIT_TEXT.test(text.slice(0, 4096)))) {
    const retryAfterMs = parseRetryAfter(res.headers.get("retry-after"));
    return { state: "not_started", status: s, detail: `rate limited (HTTP ${s})`, rateLimited: true, ...(retryAfterMs !== undefined ? { retryAfterMs } : {}) };
  }
  if (res.type === "opaqueredirect" || (s >= 300 && s < 400)) return { state: "not_started", status: s, detail: `redirect refused (HTTP ${s || 3})` };
  if (s >= 200 && s < 300) return { state: "started", status: s, detail: `HTTP ${s}` };
  if (s >= 400 && s < 500) return { state: "not_started", status: s, detail: `HTTP ${s}` };
  return { state: "unknown", status: s, detail: `HTTP ${s}; outcome unknown` };
}
