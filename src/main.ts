/** CLI implementation; `cli.ts` is only the executable entry point. */
import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { parseArgs } from "node:util";
import { makeChannel } from "./channels/index.js";
import { type Config, configInfo, EXAMPLE_CONFIG, loadConfig } from "./config.js";
import { Engine } from "./core.js";
import { type Envelope, isExpired, isTerminal, type Status, STATUSES, VERSION } from "./envelope.js";
import { CliError, EXIT, usage } from "./errors.js";
import { atomicWrite } from "./fsutil.js";
import { GUIDE_ZH } from "./guide.js";
import { configPath, ENV, PROG } from "./paths.js";
import { mask, normalizeKey, readStream, registerSecret } from "./secrets.js";
import { type EnvSource, resolveEnv } from "./winenv.js";

export const VERSION_STRING = "0.1.0";

export interface Io {
  stdin: NodeJS.ReadableStream;
  out: (s: string) => void;
  err: (s: string) => void;
  env: NodeJS.ProcessEnv;
}

export const HELP = `${PROG} ${VERSION_STRING}
（中文说明：wake-grokbot guide）
Local inbox + wake-up messages between a dispatcher and a worker agent.

Usage: ${PROG} <command> [options]

Commands:
  send --json [file|-]        accept a wake-envelope/1 from a file or stdin, then wake the other side
  send --to <role> --title <t> [--objective <o>] [--body-file <f>] [--acceptance <a>]...
                              build an envelope from flags (prints the id); --type note, --to dispatcher,
                              --id <uuid>, --thread <uuid>
  ingest --from <name> <file|->  accept an envelope from a configured external source
  status [<id>] [--json] [--mark-wake started|not_started]
                              show a receipt (or the outbox); reconcile an unknown wake by hand
  ack <id> [--status working] mark a message as picked up
  reply <id> --status <s> [--summary <t>] [--question <q>] [--next <n>] [--body-file <f>|-]
  reply <id> --json [file|-]  reply with a partial envelope from a file or stdin (status, summary, body, ...)
  watch [--once] [--interval <seconds>]   deliver queued wakes (for a scheduled task)
  release [<target>]          the woken run is finished: free the wake slot, send what queued meanwhile
  prune [--days 30] [--apply] list (or delete) settled read messages, receipts and replies older than N days
  init [--print-config] [--force]         write an example config and create the inbox
  guide                       Chinese walkthrough
  doctor [--dry-run]          check config, inbox, channels and kill switch (no secrets printed);
                              --dry-run also shows the exact wake request, URL and key hidden, sends nothing

Global options:
  --config <file>   config file. Search order: --config, $${ENV.CONFIG}, ./${PROG}.json (current folder),
                    then ${PROG}.json in the user config folder
  --inbox <dir>     inbox folder (or $${ENV.INBOX})
  --key-stdin       read the wake key from stdin (never pass keys as arguments)
  --json            machine-readable output
  -h, --help        this help;  -v, --version

Exit codes: 0 ok, 1 rejected by a rule, 2 usage/config error, 3 internal error,
  4 signature error, 5 written but not woken (or reply sink failed),
  6 wake outcome unknown (do not resend), 7 same id with different content.
`;

const OPTIONS = {
  config: { type: "string" },
  inbox: { type: "string" },
  "key-stdin": { type: "boolean" },
  json: { type: "boolean" },
  help: { type: "boolean", short: "h" },
  version: { type: "boolean", short: "v" },
  to: { type: "string" },
  from: { type: "string" },
  type: { type: "string" },
  title: { type: "string" },
  objective: { type: "string" },
  project: { type: "string" },
  "body-file": { type: "string" },
  acceptance: { type: "string", multiple: true },
  status: { type: "string" },
  summary: { type: "string" },
  question: { type: "string" },
  next: { type: "string" },
  "mark-wake": { type: "string" },
  "no-wake": { type: "boolean" },
  id: { type: "string" },
  thread: { type: "string" },
  target: { type: "string" },
  days: { type: "string" },
  apply: { type: "boolean" },
  "dry-run": { type: "boolean" },
  once: { type: "boolean" },
  interval: { type: "string" },
  "print-config": { type: "boolean" },
  force: { type: "boolean" },
} as const;

async function readInput(io: Io, src: string | undefined): Promise<string> {
  if (!src || src === "-") return readStream(io.stdin);
  try {
    return fs.readFileSync(src, "utf8").replace(/^\uFEFF/, "");
  } catch {
    throw usage(`cannot read ${src}`);
  }
}

function parseJson(text: string, what: string): unknown {
  try {
    return JSON.parse(text.replace(/^\uFEFF/, ""));
  } catch (e) {
    throw usage(`${what} is not valid JSON: ${(e as Error).message}`);
  }
}

function status(s: string | undefined, dflt?: Status): Status {
  const v = s ?? dflt;
  if (!v || !(STATUSES as readonly string[]).includes(v)) throw usage(`--status must be one of ${STATUSES.join(", ")}`);
  return v as Status;
}

export async function main(argv: string[], io: Io): Promise<number> {
  try {
    return await run(argv, io);
  } catch (e) {
    const code = e instanceof CliError ? e.code : EXIT.INTERNAL;
    io.err(`${PROG}: ${mask(e instanceof Error ? e.message : String(e))}\n`);
    return code;
  }
}

async function run(argv: string[], io: Io): Promise<number> {
  let parsed;
  try {
    parsed = parseArgs({ args: argv, options: OPTIONS, allowPositionals: true, strict: true });
  } catch (e) {
    throw usage((e as Error).message);
  }
  const { values: o, positionals: pos } = parsed;
  const cmd = pos.shift();
  if (o.version) return (io.out(VERSION_STRING + "\n"), 0);
  if (o.help || !cmd || cmd === "help") return (io.out(HELP), cmd || o.help ? 0 : EXIT.USAGE);
  if (cmd === "guide") return (io.out(GUIDE_ZH), 0);

  let stdinKey: string | undefined;
  if (o["key-stdin"]) {
    if (pos.includes("-") || (o.json && pos.length === 0 && (cmd === "send" || cmd === "reply"))) throw usage("--key-stdin cannot be combined with reading the envelope from stdin");
    stdinKey = normalizeKey(await readStream(io.stdin));
    if (!stdinKey) throw usage("--key-stdin: nothing on stdin");
    registerSecret(stdinKey);
  }
  // Windows: pick up User/Machine variables that this terminal has not seen yet (values never printed)
  const pre = resolveEnv(io.env, [...Object.values(ENV), "WAKE_GROKBOT_URL"]);
  io = { ...io, env: pre.env };
  for (const k of [ENV.KEY, "WAKE_GROKBOT_URL"]) registerSecret(io.env[k]);

  if (cmd === "init") return init(o, io);
  const loaded0 = loadConfig({ config: o.config, inbox: o.inbox, env: io.env });
  const post = resolveEnv(io.env, configEnvRefs(loaded0.cfg));
  io = { ...io, env: post.env };
  const envSources = { ...pre.sources, ...post.sources };
  const loaded = loaded0;
  const eng = new Engine(loaded, { env: io.env, stdinKey });
  const print = (r: { code: number; message: string; receipt: unknown }, extra: Record<string, unknown> = {}) => {
    if (o.json) io.out(JSON.stringify({ ...(r.receipt as object), ...extra }, null, 2) + "\n");
    else io.out(r.message + "\n");
    return r.code;
  };

  switch (cmd) {
    case "send": {
      let env: unknown;
      if (o.json) env = parseJson(await readInput(io, pos[0]), "envelope");
      else {
        if (!o.to || !o.title) throw usage("send needs --json, or --to and --title");
        const body = o["body-file"] ? await readInput(io, o["body-file"]) : undefined;
        env = {
          v: VERSION,
          id: o.id ?? randomUUID(),
          ...(o.thread ? { thread: o.thread } : {}),
          type: o.type ?? "task",
          from: o.from ?? (o.to === "worker" ? "dispatcher" : "worker"),
          to: o.to,
          ...(o.project ? { project: o.project } : {}),
          title: o.title,
          ...(o.objective ? { objective: o.objective } : {}),
          ...(body !== undefined ? { body } : {}),
          ...(o.acceptance ? { acceptance: o.acceptance } : {}),
          authorization: "explicit",
          sent_at: new Date().toISOString(),
        };
        if ((env as Envelope).type === "task" && !o.objective && body === undefined) (env as Envelope).objective = o.title;
      }
      return print(await eng.accept(env, { noWake: o["no-wake"] }));
    }
    case "ingest": {
      if (!o.from) throw usage("ingest needs --from <source name>");
      const src = eng.cfg.sources[o.from];
      if (!src) throw usage(`unknown source ${o.from}; add it under "sources" in the config (${configInfo(loaded)})`);
      const env = parseJson(await readInput(io, pos[0]), "envelope") as Envelope;
      if (env && typeof env === "object" && env.from !== o.from) throw new CliError(`envelope.from must be ${o.from}`, EXIT.RULE);
      return print(await eng.accept(env, { ingestedFrom: o.from, requireSig: !!src.require_sig, noWake: o["no-wake"], rejectExpired: true }));
    }
    case "status": {
      const id = pos[0];
      if (!id) {
        const ob = eng.store.loadOutbox();
        const view = { disabled: eng.disabled(), targets: ob.targets, sent_last_hour: ob.sent.filter((s) => Date.parse(s.at) > Date.now() - 3600_000).length, expired: expiredOpen(eng) };
        io.out(o.json ? JSON.stringify(view, null, 2) + "\n" : summaryText(view));
        return 0;
      }
      if (o["mark-wake"]) {
        const m = o["mark-wake"];
        if (m !== "started" && m !== "not_started") throw usage("--mark-wake must be started or not_started");
        const r = eng.markWake(id, m);
        if (m === "not_started") await eng.pump(r.wake.target);
        const fresh = eng.store.readReceipt(id)!;
        return print({ code: 0, receipt: fresh, message: `${id}: wake ${fresh.wake.state}` });
      }
      const r = eng.store.readReceipt(id);
      if (!r) throw new CliError(`no such id: ${id}`, EXIT.RULE);
      const env = eng.store.readEnvelope(id);
      const expired = !isTerminal(r.status === "queued" ? undefined : r.status) && isExpired(env);
      const line = `${r.id} ${r.type} ${r.from}->${r.to} status=${r.status} wake=${r.wake.state}${r.wake.detail ? ` (${r.wake.detail})` : ""}${r.next ? ` next=${r.next}` : ""}${expired ? ` EXPIRED (expires_at ${env!.expires_at})` : ""}`;
      return print({ code: 0, receipt: r, message: line }, expired ? { expired: true, expires_at: env!.expires_at } : {});
    }
    case "ack": {
      const id = pos[0];
      if (!id) throw usage("ack <id>");
      return print(await eng.ack(id, status(o.status, "working")));
    }
    case "reply": {
      const id = pos[0];
      if (!id) throw usage("reply <id> --status <status>");
      let input: Partial<Envelope> & { status: Status };
      if (!o.status && (o.json || pos[1])) {
        const j = parseJson(await readInput(io, pos[1]), "reply") as Partial<Envelope>;
        if (!j || typeof j !== "object") throw usage("reply --json needs an object");
        input = { ...j, status: status(j.status) };
      } else {
        input = {
          status: status(o.status),
          ...(o.summary ? { summary: o.summary } : {}),
          ...(o.question ? { question: o.question } : {}),
          ...(o.next ? { next: o.next } : {}),
          ...(o["body-file"] ? { body: await readInput(io, o["body-file"]) } : {}),
        };
      }
      const r = await eng.reply(id, input);
      return print(r, { reply_id: r.replyId });
    }
    case "watch": {
      const interval = Number(o.interval ?? 60);
      if (!Number.isFinite(interval) || interval < 5) throw usage("--interval must be >= 5 seconds");
      for (;;) {
        const ev = await eng.pump();
        for (const e of ev) io.out(`${new Date().toISOString()} ${e.target}: ${e.state} ${e.detail}\n`);
        for (const x of expiredOpen(eng)) io.out(`${new Date().toISOString()} expired: ${x.id} (expires_at ${x.expires_at}, status ${x.status})\n`);
        if (o.once) return 0;
        await new Promise((r) => setTimeout(r, interval * 1000));
      }
    }
    case "release": {
      const r = await eng.release(o.target ?? pos[0]);
      if (o.json) io.out(JSON.stringify(r, null, 2) + "\n");
      else {
        io.out(r.released.length ? `released: ${r.released.join(", ")}\n` : "nothing was in flight\n");
        if (!r.events.length) io.out("nothing queued to deliver\n");
        for (const e of r.events) io.out(`${e.target}: wake ${e.state} (${e.detail})\n`);
      }
      const states = r.events.map((e) => e.state);
      return states.includes("unknown") ? EXIT.UNKNOWN : states.some((x) => x !== "started" && x !== "coalesced") ? EXIT.NOT_WOKEN : 0;
    }
    case "prune": {
      const days = Number(o.days ?? 30);
      if (!Number.isFinite(days) || days < 1) throw usage("--days must be >= 1");
      const r = eng.prune(days, !!o.apply);
      if (o.json) io.out(JSON.stringify({ applied: !!o.apply, ...r }, null, 2) + "\n");
      else io.out(`${o.apply ? "deleted" : "would delete (add --apply)"}: ${r.files.length} file(s)\n` + r.files.map((f) => `  ${f}\n`).join(""));
      return 0;
    }
    case "doctor":
      return doctor(eng, loaded.path, io, stdinKey, !!o["dry-run"], envSources, configEnvRefs(loaded.cfg));
    default:
      throw usage(`unknown command ${cmd}; see ${PROG} --help`);
  }
}

/** Envelopes past their `expires_at` that are not settled yet (no done/failed/declined). Read-only. */
function expiredOpen(eng: Engine): { id: string; expires_at: string; status: string }[] {
  const dir = path.join(eng.store.inbox, "receipts");
  if (!fs.existsSync(dir)) return [];
  const out: { id: string; expires_at: string; status: string }[] = [];
  for (const f of fs.readdirSync(dir).sort()) {
    if (!f.endsWith(".json")) continue;
    const id = f.slice(0, -5);
    try {
      const r = eng.store.readReceipt(id);
      if (!r || isTerminal(r.status === "queued" ? undefined : r.status)) continue;
      const env = eng.store.readEnvelope(id);
      if (isExpired(env)) out.push({ id, expires_at: env!.expires_at!, status: r.status });
    } catch {
      /* an unreadable file is reported elsewhere; never break status */
    }
  }
  return out;
}

function summaryText(v: { disabled: string | null; targets: Record<string, { inflight: unknown; queue: string[]; dead: unknown[]; next_at: string | null }>; sent_last_hour: number; expired: { id: string; expires_at: string; status: string }[] }): string {
  const lines = [`kill switch: ${v.disabled ?? "off"}`, `wakes in the last hour: ${v.sent_last_hour}`];
  for (const x of v.expired) lines.push(`expired: ${x.id} (expires_at ${x.expires_at}, status ${x.status})`);
  for (const [n, t] of Object.entries(v.targets))
    lines.push(`${n}: in flight=${t.inflight ? "yes" : "no"} queued=${t.queue.length} dead=${t.dead.length}${t.next_at ? ` retry after ${t.next_at}` : ""}`);
  return lines.join("\n") + "\n";
}

function init(o: { config?: string; inbox?: string; "print-config"?: boolean; force?: boolean }, io: Io): number {
  const text = JSON.stringify(EXAMPLE_CONFIG, null, 2) + "\n";
  if (o["print-config"]) return (io.out(text), 0);
  const file = configPath(o.config, io.env);
  if (fs.existsSync(file) && !o.force) io.out(`config exists, left as is: ${file}\n`);
  else {
    atomicWrite(file, text);
    io.out(`wrote example config: ${file}\n`);
  }
  const loaded = loadConfig({ config: file, inbox: o.inbox, env: io.env });
  const eng = new Engine(loaded, { env: io.env });
  eng.store.ensure();
  fs.mkdirSync(eng.store.state, { recursive: true });
  io.out(`inbox: ${loaded.inbox}\nstate: ${loaded.state}\nnext: put the wake URL and key in environment variables, then run \`${PROG} doctor\`\n`);
  return 0;
}

/** Names of environment variables the config refers to (never values). */
export function configEnvRefs(cfg: Config): string[] {
  const names: string[] = [];
  for (const t of Object.values(cfg.targets)) {
    if (t.channel === "grokbot") {
      names.push(t.url_env || (t.url_file ? "" : "WAKE_GROKBOT_URL"));
      names.push(t.key_env || (t.key_file ? "" : ENV.KEY));
    }
  }
  for (const h of Object.values(cfg.sinks.webhooks)) names.push(h.url_env, h.secret_env);
  return [...new Set(names.filter(Boolean))];
}

async function doctor(
  eng: Engine,
  cfgPath: string | null,
  io: Io,
  stdinKey?: string,
  dryRun = false,
  sources: Record<string, EnvSource> = {},
  refs: string[] = [],
): Promise<number> {
  let bad = 0;
  const say = (ok: boolean | "warn", m: string) => {
    if (ok === false) bad++;
    io.out(`${ok === true ? "ok  " : ok === "warn" ? "warn" : "FAIL"} ${m}\n`);
  };
  const major = Number(process.versions.node.split(".")[0]);
  say(major >= 22, `node ${process.versions.node} (need >= 22)`);
  say(cfgPath ? true : "warn", cfgPath ? `config ${cfgPath}` : `no config file; using defaults (run init). ${configInfo(eng.loaded)}`);
  try {
    eng.store.ensure();
    const probe = path.join(eng.store.inbox, `.doctor-${process.pid}`);
    fs.writeFileSync(probe, "x");
    fs.rmSync(probe);
    say(true, `inbox writable: ${eng.store.inbox}`);
  } catch (e) {
    say(false, `inbox not writable: ${mask((e as Error).message)}`);
  }
  for (const name of refs) {
    const src = sources[name] ?? "missing";
    say(src === "missing" ? "warn" : true, `env ${name}: ${src === "missing" ? "missing" : `found (${src === "process" ? "process" : src === "user" ? "user registry" : "machine registry"})`}`);
  }
  const off = eng.disabled();
  say(off ? "warn" : true, `kill switch ${off ? "ON: " + off : "off"}`);
  for (const [role, t] of Object.entries(eng.cfg.wake.targets)) say(true, `wake target for ${role}: ${t}`);
  if (!Object.keys(eng.cfg.wake.targets).length) say("warn", "no wake targets: messages are written but nobody is woken");
  for (const [name, t] of Object.entries(eng.cfg.targets)) {
    try {
      const ch = makeChannel(name, t);
      ch.check({ env: io.env, timeoutMs: 1000, stdinKey });
      say(true, `target ${name}: ${ch.describe()}${t.description ? ` - ${t.description}` : ""}${t.capabilities?.length ? ` [${t.capabilities.join(", ")}]` : ""}`);
      if (dryRun && ch.preview) {
        const sample = { id: "00000000-0000-4000-8000-000000000000", type: "task" as const, summary: "doctor dry run", inbox_path: eng.store.msgDir("worker"), ids: ["00000000-0000-4000-8000-000000000000"], count: 1 };
        io.out(`     would send (nothing sent): ${mask(JSON.stringify(ch.preview(sample)))}\n`);
      }
    } catch (e) {
      say(false, `target ${name}: ${mask((e as Error).message)}`);
    }
  }
  try {
    if (eng.signKey()) say(true, "signing key readable");
  } catch (e) {
    say(false, mask((e as Error).message));
  }
  const ob = eng.store.loadOutbox();
  for (const [n, t] of Object.entries(ob.targets)) {
    if (t.dead.length) say("warn", `target ${n}: ${t.dead.length} dead wake(s); see status`);
    if (t.inflight?.unknown) say("warn", `target ${n}: a wake with unknown outcome is pending reconciliation`);
  }
  return bad ? EXIT.USAGE : 0;
}
