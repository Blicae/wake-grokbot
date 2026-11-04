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

export type PostOutcome = { state: "started" | "not_started" | "unknown"; status?: number; detail: string };

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
  await res.arrayBuffer().catch(() => undefined);
  const s = res.status;
  if (res.type === "opaqueredirect" || (s >= 300 && s < 400)) return { state: "not_started", status: s, detail: `redirect refused (HTTP ${s || 3})` };
  if (s >= 200 && s < 300) return { state: "started", status: s, detail: `HTTP ${s}` };
  if (s >= 400 && s < 500) return { state: "not_started", status: s, detail: `HTTP ${s}` };
  return { state: "unknown", status: s, detail: `HTTP ${s}; outcome unknown` };
}
