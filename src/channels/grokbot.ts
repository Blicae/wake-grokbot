import * as fs from "node:fs";
import type { TargetConfig } from "../config.js";
import { ChannelConfigError, postJson, resolveUrl } from "../net.js";
import { normalizeKey, registerSecret } from "../secrets.js";
import type { Channel, ChannelContext, WakeOutcome, WakePayload } from "./index.js";

const DEFAULT_TEMPLATE = "wake-grokbot: {count} new item(s) for you. Latest {type} {id}: {summary}. Inbox: {inbox_path}";

/**
 * Grok Bot wake: POST to the routine's webhook with `Authorization: Bearer <key>` and a JSON body
 * `{ <payload_key>: <text>, wake: { id, type, summary, inbox_path, ids, count } }`.
 * A 2xx means the routine STARTED, not that the work is done: results are read from the inbox.
 */
export class GrokBotChannel implements Channel {
  constructor(
    readonly name: string,
    readonly cfg: TargetConfig,
  ) {}

  private url(ctx: ChannelContext): string {
    return resolveUrl({ env: this.cfg.url_env ?? "WAKE_GROKBOT_URL", file: this.cfg.url_file, what: `target ${this.name}` }, ctx.env);
  }

  private key(ctx: ChannelContext): string {
    let raw = ctx.stdinKey ?? "";
    if (!raw && this.cfg.key_env) raw = ctx.env[this.cfg.key_env] ?? "";
    if (!raw && !this.cfg.key_env) raw = ctx.env.WAKE_GROKBOT_KEY ?? "";
    if (!raw && this.cfg.key_file) {
      try {
        raw = fs.readFileSync(this.cfg.key_file, "utf8");
      } catch {
        throw new ChannelConfigError(`target ${this.name}: cannot read key_file`);
      }
    }
    const k = normalizeKey(raw);
    if (!k) throw new ChannelConfigError(`target ${this.name}: API key not set (${this.cfg.key_env ?? "WAKE_GROKBOT_KEY"}, key_file or --key-stdin)`);
    if (/\s/.test(k)) throw new ChannelConfigError(`target ${this.name}: API key contains whitespace`);
    registerSecret(k);
    return k;
  }

  check(ctx: ChannelContext): void {
    registerSecret(this.url(ctx));
    this.key(ctx);
    const t = this.cfg.template;
    if (t !== undefined && typeof t !== "string") throw new ChannelConfigError(`target ${this.name}: template must be a string`);
  }

  describe(): string {
    return `grokbot routine ${this.cfg.routine ?? "default"} (URL from ${this.cfg.url_file ? "url_file" : (this.cfg.url_env ?? "WAKE_GROKBOT_URL")}, not shown)`;
  }

  text(p: WakePayload): string {
    const tpl = (this.cfg.template as string) || DEFAULT_TEMPLATE;
    const vals: Record<string, string> = { id: p.id, type: p.type, summary: p.summary, inbox_path: p.inbox_path, count: String(p.count), ids: p.ids.join(", ") };
    return tpl.replace(/\{(\w+)\}/g, (m, k: string) => vals[k] ?? m);
  }

  preview(p: WakePayload): unknown {
    return {
      method: "POST",
      url: "<hidden>",
      headers: { authorization: "Bearer ***", "content-type": "application/json" },
      body: { [String(this.cfg.payload_key || "text")]: this.text(p), wake: p },
    };
  }

  async wake(p: WakePayload, ctx: ChannelContext): Promise<WakeOutcome> {
    const url = this.url(ctx);
    registerSecret(url);
    const key = this.key(ctx);
    const body = { [String(this.cfg.payload_key || "text")]: this.text(p), wake: p };
    const r = await postJson(url, body, { authorization: `Bearer ${key}` }, ctx.timeoutMs);
    return {
      state: r.state,
      detail: `grokbot ${r.detail}`,
      ...(r.rateLimited ? { rateLimited: true } : {}),
      ...(r.retryAfterMs !== undefined ? { retryAfterMs: r.retryAfterMs } : {}),
    };
  }
}
