/** CLI implementation; `cli.ts` is only the executable entry point. */
import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { parseArgs } from "node:util";
import { makeChannel } from "./channels/index.js";
import { EXAMPLE_CONFIG, loadConfig } from "./config.js";
import { Engine } from "./core.js";
import { type Envelope, type Status, STATUSES, VERSION } from "./envelope.js";
import { CliError, EXIT, usage } from "./errors.js";
import { atomicWrite } from "./fsutil.js";
import { GUIDE_ZH } from "./guide.js";
import { configPath, ENV, PROG } from "./paths.js";
import { mask, normalizeKey, readStream, registerSecret } from "./secrets.js";

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
                              build a task envelope from flags (prints the new id)
  ingest --from <name> <file|->  accept an envelope from a configured external source
  status [<id>] [--json] [--mark-wake started|not_started]
                              show a receipt (or the outbox); reconcile an unknown wake by hand
  ack <id> [--status working] mark a message as picked up
  reply <id> --status <s> [--summary <t>] [--question <q>] [--next <n>] [--body-file <f>|-]
  reply <id> --json [file|-]  reply with a partial envelope from a file or stdin (status, summary, body, ...)
  watch [--once] [--interval <seconds>]   deliver queued wakes (for a scheduled task)
  init [--print-config] [--force]         write an example config and create the inbox
  guide                       Chinese walkthrough
  doctor                      check config, inbox, channels and kill switch (no secrets printed)

Global options:
  --config <file>   config file (default: ${PROG}.json in the user config folder, or $${ENV.CONFIG})
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
  for (const k of [ENV.KEY, "WAKE_GROKBOT_URL"]) registerSecret(io.env[k]);

  if (cmd === "init") return init(o, io);
  const loaded = loadConfig({ config: o.config, inbox: o.inbox, env: io.env });
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
          id: randomUUID(),
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
      if (!src) throw usage(`unknown source ${o.from}; add it under "sources" in the config`);
      const env = parseJson(await readInput(io, pos[0]), "envelope") as Envelope;
      if (env && typeof env === "object" && env.from !== o.from) throw new CliError(`envelope.from must be ${o.from}`, EXIT.RULE);
      return print(await eng.accept(env, { ingestedFrom: o.from, requireSig: !!src.require_sig, noWake: o["no-wake"] }));
    }
    case "status": {
      const id = pos[0];
      if (!id) {
        const ob = eng.store.loadOutbox();
        const view = { disabled: eng.disabled(), targets: ob.targets, sent_last_hour: ob.sent.filter((s) => Date.parse(s.at) > Date.now() - 3600_000).length };
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
      const line = `${r.id} ${r.type} ${r.from}->${r.to} status=${r.status} wake=${r.wake.state}${r.wake.detail ? ` (${r.wake.detail})` : ""}${r.next ? ` next=${r.next}` : ""}`;
      return print({ code: 0, receipt: r, message: line });
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
        if (o.once) return 0;
        await new Promise((r) => setTimeout(r, interval * 1000));
      }
    }
    case "doctor":
      return doctor(eng, loaded.path, io, stdinKey);
    default:
      throw usage(`unknown command ${cmd}; see ${PROG} --help`);
  }
}

function summaryText(v: { disabled: string | null; targets: Record<string, { inflight: unknown; queue: string[]; dead: unknown[]; next_at: string | null }>; sent_last_hour: number }): string {
  const lines = [`kill switch: ${v.disabled ?? "off"}`, `wakes in the last hour: ${v.sent_last_hour}`];
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

async function doctor(eng: Engine, cfgPath: string | null, io: Io, stdinKey?: string): Promise<number> {
  let bad = 0;
  const say = (ok: boolean | "warn", m: string) => {
    if (ok === false) bad++;
    io.out(`${ok === true ? "ok  " : ok === "warn" ? "warn" : "FAIL"} ${m}\n`);
  };
  const major = Number(process.versions.node.split(".")[0]);
  say(major >= 22, `node ${process.versions.node} (need >= 22)`);
  say(cfgPath ? true : "warn", cfgPath ? `config ${cfgPath}` : "no config file; using defaults (run init)");
  try {
    eng.store.ensure();
    const probe = path.join(eng.store.inbox, `.doctor-${process.pid}`);
    fs.writeFileSync(probe, "x");
    fs.rmSync(probe);
    say(true, `inbox writable: ${eng.store.inbox}`);
  } catch (e) {
    say(false, `inbox not writable: ${mask((e as Error).message)}`);
  }
  const off = eng.disabled();
  say(off ? "warn" : true, `kill switch ${off ? "ON: " + off : "off"}`);
  for (const [role, t] of Object.entries(eng.cfg.wake.targets)) say(true, `wake target for ${role}: ${t}`);
  if (!Object.keys(eng.cfg.wake.targets).length) say("warn", "no wake targets: messages are written but nobody is woken");
  for (const [name, t] of Object.entries(eng.cfg.targets)) {
    try {
      const ch = makeChannel(name, t);
      ch.check({ env: io.env, timeoutMs: 1000, stdinKey });
      say(true, `target ${name}: ${ch.describe()}`);
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
