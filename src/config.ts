import * as fs from "node:fs";
import * as path from "node:path";
import type { ReportLocale } from "./envelope.js";
import { usage } from "./errors.js";
import { channelNames } from "./channels/index.js";
import { readJson } from "./fsutil.js";
import { ENV, configCandidates, dataDir, stateDir } from "./paths.js";

export interface TargetConfig {
  channel: "grokbot" | "script" | string;
  /** grokbot: routine name, used for the per-routine rate limit */
  routine?: string;
  /** grokbot: env var holding the webhook URL (never the URL itself) */
  url_env?: string;
  /** grokbot: file whose first line is the webhook URL (outside any repo) */
  url_file?: string;
  /** grokbot: env var holding the API key */
  key_env?: string;
  /** grokbot: file holding the API key */
  key_file?: string;
  payload_key?: string;
  template?: string;
  per_routine_hourly_cap?: number;
  /** Agent-card style notes: what this target is and what it can do (shown by doctor; never secrets). */
  description?: string;
  capabilities?: string[];
  /** script: argv of the wake command; the wake summary is passed as JSON on stdin */
  argv?: string[];
  [k: string]: unknown;
}

export interface Config {
  inbox: string;
  state_dir: string;
  sign: { key_file: string; require: boolean };
  wake: {
    targets: Partial<Record<"worker" | "dispatcher", string>>;
    hourly_cap: number;
    max_attempts: number;
    inflight_ttl_minutes: number;
    timeout_seconds: number;
  };
  targets: Record<string, TargetConfig>;
  sinks: {
    file: { dir: string };
    webhooks: Record<string, { url_env: string; secret_env: string }>;
    commands: Record<string, { argv: string[]; timeout_seconds?: number }>;
    report_roots: string[];
  };
  report: { locale: ReportLocale; timezone: string; quota_line: boolean };
  sources: Record<string, { require_sig?: boolean }>;
}

/** Platform hard limits for Grok Bot wakes. Config may only go lower. */
export const HARD_HOURLY_TOTAL = 300;
export const HARD_HOURLY_PER_ROUTINE = 200;

export const DEFAULTS: Config = {
  inbox: "",
  state_dir: "",
  sign: { key_file: "", require: false },
  wake: { targets: {}, hourly_cap: 60, max_attempts: 5, inflight_ttl_minutes: 30, timeout_seconds: 20 },
  targets: {},
  sinks: { file: { dir: "" }, webhooks: {}, commands: {}, report_roots: [] },
  report: { locale: "en", timezone: "UTC", quota_line: false },
  sources: {},
};

export const EXAMPLE_CONFIG = {
  $comment:
    "wake-grokbot config. Never put secrets or URLs here: only names of environment variables or files outside the repo.",
  inbox: "",
  state_dir: "",
  sign: { key_file: "", require: false },
  wake: { targets: { worker: "grokbot" }, hourly_cap: 60, max_attempts: 5, inflight_ttl_minutes: 30, timeout_seconds: 20 },
  targets: {
    grokbot: {
      channel: "grokbot",
      routine: "default",
      url_env: "WAKE_GROKBOT_URL",
      key_env: "WAKE_GROKBOT_KEY",
      payload_key: "text",
      template: "",
      per_routine_hourly_cap: 200,
    },
  },
  sinks: {
    file: { dir: "" },
    webhooks: {}, // add e.g. "my-hook": { url_env, secret_env } when you use the webhook sink
    commands: { "my-engine": { argv: ["my-engine", "ingest", "--from", "wake-grokbot", "-"], timeout_seconds: 60 } },
    report_roots: [],
  },
  sources: { "my-engine": { require_sig: false } },
};

export interface Loaded {
  cfg: Config;
  /** the config file that was loaded, or null when none was found */
  path: string | null;
  /** every path looked at, in order */
  searched: string[];
  inbox: string;
  state: string;
}

/** "config: <path or none>; searched: a, b" for error messages. */
export function configInfo(l: Pick<Loaded, "path" | "searched">): string {
  return `config: ${l.path ?? "none found"}; searched: ${l.searched.join(", ")}`;
}

const isObj = (x: unknown): x is Record<string, unknown> => !!x && typeof x === "object" && !Array.isArray(x);

function merge<T>(base: T, over: unknown): T {
  if (!isObj(base) || !isObj(over)) return (over === undefined ? base : over) as T;
  const out: Record<string, unknown> = { ...(base as Record<string, unknown>) };
  for (const [k, v] of Object.entries(over)) out[k] = merge((base as Record<string, unknown>)[k], v);
  return out as T;
}

const FORBIDDEN_KEYS = /^(url|webhook|webhook_url|token|key|secret|password|authorization)$/i;

export function validateConfig(cfg: Config): string[] {
  const p: string[] = [];
  const walk = (o: unknown, at: string) => {
    if (isObj(o)) for (const [k, v] of Object.entries(o)) {
      if (FORBIDDEN_KEYS.test(k)) p.push(`${at}${k}: secrets and URLs never go into the config; use *_env or *_file names`);
      walk(v, `${at}${k}.`);
    }
    else if (typeof o === "string" && /\b[a-z][a-z0-9+.-]*:\/\/\S+/i.test(o)) p.push(`${at.slice(0, -1)}: URLs never go into the config`);
  };
  walk(cfg, "");
  if (cfg.report !== undefined && !isObj(cfg.report)) p.push("report must be an object");
  else if (cfg.report !== undefined) {
    if (!["en", "zh-CN"].includes(cfg.report.locale)) p.push("report.locale must be en or zh-CN");
    if (typeof cfg.report.quota_line !== "boolean") p.push("report.quota_line must be a boolean");
    try {
      if (typeof cfg.report.timezone !== "string" || !cfg.report.timezone.trim() || /^[+-]/.test(cfg.report.timezone)) throw new Error();
      new Intl.DateTimeFormat("en", { timeZone: cfg.report.timezone }).format(0);
    } catch { p.push("report.timezone must be an IANA timezone"); }
  }
  const w = cfg.wake;
  for (const k of ["hourly_cap", "max_attempts", "inflight_ttl_minutes", "timeout_seconds"] as const)
    if (!Number.isInteger(w[k]) || w[k] < 1) p.push(`wake.${k} must be a positive integer`);
  if (w.hourly_cap > HARD_HOURLY_TOTAL) p.push(`wake.hourly_cap must be <= ${HARD_HOURLY_TOTAL}`);
  for (const [role, t] of Object.entries(w.targets ?? {})) {
    if (!["worker", "dispatcher"].includes(role)) p.push(`wake.targets.${role}: role must be worker or dispatcher`);
    if (t && !cfg.targets[t]) p.push(`wake.targets.${role}: unknown target ${t}`);
  }
  for (const [name, t] of Object.entries(cfg.targets)) {
    if (!isObj(t) || typeof t.channel !== "string") { p.push(`targets.${name}.channel is required`); continue; }
    if (!channelNames().includes(t.channel)) p.push(`targets.${name}.channel: unknown channel ${t.channel} (known: ${channelNames().join(", ")})`);
    const cap = t.per_routine_hourly_cap;
    if (cap !== undefined && (!Number.isInteger(cap) || cap < 1 || cap > HARD_HOURLY_PER_ROUTINE))
      p.push(`targets.${name}.per_routine_hourly_cap must be 1..${HARD_HOURLY_PER_ROUTINE}`);
    if (t.argv !== undefined && (!Array.isArray(t.argv) || !t.argv.every((a) => typeof a === "string") || t.argv.length === 0))
      p.push(`targets.${name}.argv must be a non-empty list of strings`);
  }
  for (const [n, c] of Object.entries(cfg.sinks.commands))
    if (!Array.isArray(c.argv) || c.argv.length === 0 || !c.argv.every((a) => typeof a === "string")) p.push(`sinks.commands.${n}.argv must be a non-empty list of strings`);
  for (const [n, h] of Object.entries(cfg.sinks.webhooks))
    if (typeof h.url_env !== "string" || typeof h.secret_env !== "string") p.push(`sinks.webhooks.${n} needs url_env and secret_env`);
  if (!Array.isArray(cfg.sinks.report_roots) || !cfg.sinks.report_roots.every((r) => typeof r === "string")) p.push("sinks.report_roots must be a list of folders");
  return p;
}

export function loadConfig(opts: { config?: string; inbox?: string; env?: NodeJS.ProcessEnv; cwd?: string } = {}): Loaded {
  const env = opts.env ?? process.env;
  const cand = configCandidates(opts.config, env, opts.cwd ?? process.cwd());
  const searched = cand.paths;
  const file = searched.find((p) => fs.existsSync(p));
  let cfg = DEFAULTS;
  let used: string | null = null;
  if (file) {
    try {
      cfg = merge(DEFAULTS, readJson<unknown>(file));
    } catch (e) {
      throw usage(`config is not valid JSON: ${file} (${(e as Error).message})`);
    }
    used = file;
  } else if (cand.explicit) {
    throw usage(`config file not found (${configInfo({ path: null, searched })})`);
  }
  delete (cfg as unknown as Record<string, unknown>).$comment;
  const problems = validateConfig(cfg);
  if (problems.length) throw usage(`config error: ${problems.join("; ")} (${configInfo({ path: used, searched })})`);
  const base = used ? path.dirname(used) : process.cwd();
  const res = (p: string) => path.resolve(base, p.replace(/^~(?=$|[\\/])/, process.env.HOME || process.env.USERPROFILE || "~"));
  const inbox = opts.inbox ? path.resolve(opts.inbox) : env[ENV.INBOX] ? path.resolve(env[ENV.INBOX]!) : cfg.inbox ? res(cfg.inbox) : path.join(dataDir(env), "inbox");
  const state = env[ENV.STATE] ? path.resolve(env[ENV.STATE]!) : cfg.state_dir ? res(cfg.state_dir) : stateDir(env);
  cfg.sinks.report_roots = cfg.sinks.report_roots.map(res);
  if (cfg.sinks.file.dir) cfg.sinks.file.dir = res(cfg.sinks.file.dir);
  if (cfg.sign.key_file) cfg.sign.key_file = res(cfg.sign.key_file);
  for (const t of Object.values(cfg.targets)) {
    if (t.url_file) t.url_file = res(t.url_file);
    if (t.key_file) t.key_file = res(t.key_file);
  }
  return { cfg, path: used, searched, inbox, state };
}
