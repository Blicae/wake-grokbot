import type { TargetConfig } from "../config.js";
import type { Envelope } from "../envelope.js";
import { GrokBotChannel } from "./grokbot.js";
import { ScriptChannel } from "./script.js";

/** What a wake tells the target: ids and short summaries only, never result bodies or secrets. */
export interface WakePayload {
  id: string;
  type: Envelope["type"];
  summary: string;
  inbox_path: string;
  ids: string[];
  count: number;
}

export interface WakeOutcome {
  state: "started" | "not_started" | "unknown";
  detail: string;
  /** The target said "too many requests": back off longer (Retry-After, else from 15 minutes). */
  rateLimited?: boolean;
  retryAfterMs?: number;
}

export interface ChannelContext {
  env: NodeJS.ProcessEnv;
  timeoutMs: number;
  /** a key handed in on stdin (overrides key_env / key_file) */
  stdinKey?: string;
}

export interface Channel {
  /** Validate the target config; throw ChannelConfigError (message without secrets). */
  check(ctx: ChannelContext): void;
  /** Optional: what a wake would send, with no URL and no key (for `doctor --dry-run`). */
  preview?(payload: WakePayload): unknown;
  describe(): string;
  wake(p: WakePayload, ctx: ChannelContext): Promise<WakeOutcome>;
}

export type ChannelFactory = (name: string, cfg: TargetConfig) => Channel;

const registry = new Map<string, ChannelFactory>([
  ["grokbot", (n, c) => new GrokBotChannel(n, c)],
  ["script", (n, c) => new ScriptChannel(n, c)],
]);

/** Add a channel (e.g. from a wrapper script). Only grokbot and script ship today. */
export function registerChannel(name: string, f: ChannelFactory): void {
  registry.set(name, f);
}

export function channelNames(): string[] {
  return [...registry.keys()].sort();
}

export function makeChannel(name: string, cfg: TargetConfig): Channel {
  const f = registry.get(cfg.channel);
  if (!f) throw new Error(`target ${name}: unknown channel ${cfg.channel} (available: ${channelNames().join(", ")})`);
  return f(name, cfg);
}
