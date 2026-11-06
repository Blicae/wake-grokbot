/** Lead review of 3ab5bf8: webhook outcomes, lock ownership, crash windows, real multi-process contention, pinned scripts. */
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as http from "node:http";
import { createRequire } from "node:module";
import * as os from "node:os";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { DEFAULTS, type Config } from "../src/config.js";
import { contentHash, type Envelope, type ReplyTo } from "../src/envelope.js";
import { _testHooks, deliver, type SinkContext } from "../src/sinks.js";
import { stub, uuid } from "./helpers.js";

const ROOT = path.join(import.meta.dirname, "..");
const TASK = uuid();
const sha = (f: string) => createHash("sha256").update(fs.readFileSync(f)).digest("hex");
function reply(status: Envelope["status"], summary = "s"): Envelope {
  return { v: "wake-envelope/1", id: uuid(), type: "answer", from: "worker", to: "dispatcher", status, summary, body: "b", thread: TASK, sent_at: "2026-11-05T01:00:00Z", ...(status === "needs_input" ? { question: "q?" } : {}) };
}
function setup(sinks: Partial<Config["sinks"]> = {}, env: NodeJS.ProcessEnv = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wg-rep-"));
  const root = path.join(dir, "reports");
  fs.mkdirSync(root);
  const cfg: Config = JSON.parse(JSON.stringify(DEFAULTS));
  cfg.sinks = { ...cfg.sinks, report_roots: [root], ...sinks };
  const report = path.join(root, "r.md");
  const to: ReplyTo = { sink: "hufu-report", report_path: report };
  const ctx = (r: Envelope, rev: number, taskId = TASK): SinkContext => ({ cfg, inbox: dir, env, timeoutMs: 2000, delivery: { taskId, replyHash: contentHash(r), revision: rev } });
  const send = (r: Envelope, rev: number, t: ReplyTo = to, taskId = TASK) => deliver(r, t, ctx(r, rev, taskId));
  return { dir, root, cfg, report, done: report + ".DONE", state: report + ".wake.json", lock: report + ".lock", to, send };
}
afterEach(() => {
  delete _testHooks.fault;
});

describe("webhook outcomes (local mock servers only)", () => {
  async function hook(status: number, headers: Record<string, string> = {}) {
    const srv = await stub(() => ({ status, headers }));
    const s = setup({ webhooks: { h: { url_env: "U", secret_env: "S" } } }, { U: srv.url, S: "secret-value-123" });
    return { srv, s, to: { sink: "webhook", url_ref: "h" } as ReplyTo };
  }
  it("4xx after the request reached the peer is unknown, not not_sent", async () => {
    const { srv, s, to } = await hook(422);
    expect(await s.send(reply("done"), 1, to)).toMatchObject({ ok: false, outcome: "unknown" });
    expect(srv.hits.length).toBe(1);
  });
  it("3xx is unknown and the redirect is not followed", async () => {
    const { srv, s, to } = await hook(307, { location: "/elsewhere" });
    expect(await s.send(reply("done"), 1, to)).toMatchObject({ ok: false, outcome: "unknown" });
    expect(srv.hits.map((h) => h.url)).toEqual(["/hook"]);
  });
  it("429 is unknown too (the peer saw the request)", async () => {
    const { s, to } = await hook(429);
    expect((await s.send(reply("done"), 1, to)).outcome).toBe("unknown");
  });
  it("connection refused before any byte is not_sent", async () => {
    const srv = http.createServer();
    await new Promise<void>((ok) => srv.listen(0, "127.0.0.1", ok));
    const port = (srv.address() as { port: number }).port;
    await new Promise<void>((ok) => srv.close(() => ok()));
    const s = setup({ webhooks: { h: { url_env: "U", secret_env: "S" } } }, { U: `http://127.0.0.1:${port}/hook`, S: "secret-value-123" });
    expect(await s.send(reply("done"), 1, { sink: "webhook", url_ref: "h" })).toMatchObject({ ok: false, outcome: "not_sent" });
  });
});

describe("crash windows: a retry of the same delivery repairs its own half-finished writes", () => {
  for (const w of ["intent", "report", "sidecar", "marker"] as const) {
    it(`fault after ${w}`, async () => {
      const s = setup();
      const r = reply("done", "fin");
      _testHooks.fault = (at) => {
        if (at === w) throw new Error(`injected after ${w}`);
      };
      const first = await s.send(r, 1);
      expect(first.ok).toBe(false);
      expect(first.outcome).toBe("unknown");
      expect(fs.existsSync(s.lock)).toBe(false);
      // another task must not take over the half-finished path
      expect(await s.send(reply("done"), 1, s.to, uuid())).toMatchObject({ state: "conflict" });
      delete _testHooks.fault;
      const again = await s.send(r, 1);
      expect(again).toMatchObject({ ok: true, outcome: "delivered" });
      const m = JSON.parse(fs.readFileSync(s.done, "utf8"));
      expect(m).toMatchObject({ id: r.id, status: "done", revision: 1, reply_hash: contentHash(r), report_sha256: sha(s.report) });
      expect(JSON.parse(fs.readFileSync(s.state, "utf8"))).toMatchObject({ phase: "committed", reply_id: r.id });
      expect(fs.readFileSync(s.report, "utf8").startsWith("就绪：fin")).toBe(true);
      expect((await s.send(r, 1)).state).toBe("duplicate");
    });
  }
  it("the intent is written before the report", async () => {
    const s = setup();
    const r = reply("done");
    _testHooks.fault = (at) => {
      if (at === "intent") throw new Error("stop");
    };
    await s.send(r, 1);
    expect(fs.existsSync(s.report)).toBe(false);
    expect(JSON.parse(fs.readFileSync(s.state, "utf8"))).toMatchObject({ phase: "intent", task_id: TASK, revision: 1, reply_id: r.id, reply_hash: contentHash(r), status: "done" });
  });
  it("duplicate needs reply_id, status, report bytes and marker all consistent", async () => {
    const s = setup();
    const r = reply("done");
    await s.send(r, 1);
    const st = JSON.parse(fs.readFileSync(s.state, "utf8"));
    fs.writeFileSync(s.state, JSON.stringify({ ...st, reply_id: uuid() }));
    expect((await s.send(r, 1)).state).toBe("delivered");
    const m = JSON.parse(fs.readFileSync(s.done, "utf8"));
    fs.writeFileSync(s.done, JSON.stringify({ ...m, status: "failed" }));
    expect((await s.send(r, 1)).state).toBe("delivered");
    expect(JSON.parse(fs.readFileSync(s.done, "utf8")).status).toBe("done");
    expect((await s.send(r, 1)).state).toBe("duplicate");
  });
});

describe("lock ownership", () => {
  it("a lock held by another host is never stolen; detail says how to recover", async () => {
    const s = setup();
    fs.writeFileSync(s.lock, JSON.stringify({ host: "some-other-host", pid: 1, token: "t", started_at: 0 }));
    const res = await s.send(reply("done"), 1);
    expect(res).toMatchObject({ ok: false, outcome: "not_sent", state: "failed" });
    expect(res.detail).toMatch(/retry/);
    expect(res.detail).toMatch(/manual/);
    expect(fs.existsSync(s.lock)).toBe(true);
  });
  it("an old lock of a live process is not stolen by age", async () => {
    const s = setup();
    fs.writeFileSync(s.lock, JSON.stringify({ host: os.hostname(), pid: process.ppid, token: "t", started_at: 0 }));
    const old = new Date(Date.now() - 24 * 3600_000);
    fs.utimesSync(s.lock, old, old);
    expect(await s.send(reply("done"), 1)).toMatchObject({ outcome: "not_sent", state: "failed" });
    expect(fs.existsSync(s.lock)).toBe(true);
  });
  it("an unreadable lock is not stolen", async () => {
    const s = setup();
    fs.writeFileSync(s.lock, "garbage");
    const old = new Date(Date.now() - 24 * 3600_000);
    fs.utimesSync(s.lock, old, old);
    expect((await s.send(reply("done"), 1)).outcome).toBe("not_sent");
    expect(fs.readFileSync(s.lock, "utf8")).toBe("garbage");
  });
});

// Real child processes need compiled JS: build src into a temp folder once.
let dist = "";
beforeAll(() => {
  dist = fs.mkdtempSync(path.join(os.tmpdir(), "wg-rep-dist-"));
  const tsc = createRequire(import.meta.url).resolve("typescript/bin/tsc");
  const r = spawnSync(process.execPath, [tsc, "-p", path.join(ROOT, "tsconfig.build.json"), "--outDir", dist], { encoding: "utf8" });
  if (r.status !== 0) throw new Error(`build failed: ${r.stdout}${r.stderr}`);
}, 120_000);
afterAll(() => fs.rmSync(dist, { recursive: true, force: true }));

/** Child: deliver one reply to the report path; retries while the lock is busy. hang=<window> blocks forever there. */
function child(s: ReturnType<typeof setup>, r: Envelope, rev: number, hang?: string) {
  const url = pathToFileURL(path.join(dist, "sinks.js")).href;
  const code = `
    import * as fs from "node:fs";
    const { deliver, _testHooks } = await import(${JSON.stringify(url)});
    const a = JSON.parse(process.env.WG_ARGS);
    if (a.hang) _testHooks.fault = (at) => { if (at === a.hang) { fs.writeSync(1, "HELD\\n"); for (;;) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1000); } };
    let res;
    for (let i = 0; i < 4000; i++) {
      res = await deliver(a.reply, a.to, { cfg: a.cfg, inbox: a.inbox, env: {}, timeoutMs: 1000, delivery: a.delivery });
      if (!(res.state === "failed" && res.outcome === "not_sent")) break;
      await new Promise((ok) => setTimeout(ok, 2 + Math.random() * 5));
    }
    fs.writeSync(1, JSON.stringify(res) + "\\n");`;
  const args = { reply: r, to: s.to, cfg: s.cfg, inbox: s.dir, delivery: { taskId: TASK, replyHash: contentHash(r), revision: rev }, hang };
  const p = spawn(process.execPath, ["--input-type=module", "-e", code], { env: { ...process.env, WG_ARGS: JSON.stringify(args) }, stdio: ["ignore", "pipe", "pipe"] });
  let out = "";
  let err = "";
  p.stdout.on("data", (d) => (out += d));
  p.stderr.on("data", (d) => (err += d));
  const done = new Promise<{ code: number | null; out: string; err: string }>((ok) => p.on("close", (code) => ok({ code, out, err })));
  const held = new Promise<void>((ok) => p.stdout.on("data", () => out.includes("HELD") && ok()));
  return { p, done, held };
}

describe("real multi-process contention", () => {
  it("8 processes racing different revisions on one path: highest revision wins, files consistent", async () => {
    const s = setup();
    const replies = Array.from({ length: 8 }, (_, i) => reply(i === 7 ? "done" : "working", `rev${i + 1}`));
    const kids = replies.map((r, i) => child(s, r, i + 1));
    const results = await Promise.all(kids.map((k) => k.done));
    for (const x of results) expect(x.code, x.err).toBe(0);
    const states = results.map((x) => JSON.parse(x.out.trim().split("\n").at(-1)!).state);
    for (const st of states) expect(["delivered", "superseded"]).toContain(st);
    const st = JSON.parse(fs.readFileSync(s.state, "utf8"));
    expect(st).toMatchObject({ revision: 8, phase: "committed", status: "done", report_sha256: sha(s.report) });
    expect(fs.readFileSync(s.report, "utf8").startsWith("就绪：rev8")).toBe(true);
    expect(JSON.parse(fs.readFileSync(s.done, "utf8"))).toMatchObject({ revision: 8, report_sha256: sha(s.report) });
    expect(fs.existsSync(s.lock)).toBe(false);
  }, 60_000);
  it("6 processes delivering the same reply: one consistent result, the rest duplicate", async () => {
    const s = setup();
    const r = reply("done", "same");
    const results = await Promise.all(Array.from({ length: 6 }, () => child(s, r, 1).done));
    const states = results.map((x) => JSON.parse(x.out.trim().split("\n").at(-1)!).state);
    expect(states.filter((x) => x === "delivered").length).toBe(1);
    expect(states.filter((x) => x === "duplicate").length).toBe(5);
    expect(JSON.parse(fs.readFileSync(s.done, "utf8")).report_sha256).toBe(sha(s.report));
  }, 60_000);
  it.skipIf(process.platform === "win32")("a SIGKILLed lock holder is recovered; a live holder is not stolen", async () => {
    const s = setup();
    const r = reply("done", "after-kill");
    const k = child(s, r, 1, "report");
    await k.held;
    const live = await s.send(r, 1);
    expect(live).toMatchObject({ ok: false, outcome: "not_sent", state: "failed" });
    expect(JSON.parse(fs.readFileSync(s.lock, "utf8")).pid).toBe(k.p.pid);
    k.p.kill("SIGKILL");
    await k.done;
    const again = await s.send(r, 1);
    expect(again).toMatchObject({ ok: true, outcome: "delivered", state: "delivered" });
    expect(JSON.parse(fs.readFileSync(s.done, "utf8"))).toMatchObject({ id: r.id, report_sha256: sha(s.report) });
    expect(fs.existsSync(s.lock)).toBe(false);
  }, 60_000);
});

describe("watch.sh runs exactly the pinned version (stubs, no downloads)", () => {
  function run(globalVersion: string | null) {
    const bin = fs.mkdtempSync(path.join(os.tmpdir(), "wg-bin-"));
    const log = path.join(bin, "log");
    if (globalVersion !== null)
      fs.writeFileSync(path.join(bin, "wake-grokbot"), `#!/bin/sh\nif [ "$1" = "--version" ] || [ "$1" = "-v" ]; then echo ${globalVersion}; exit 0; fi\necho "global $*" >> "${log}"\n`, { mode: 0o755 });
    fs.writeFileSync(path.join(bin, "npx"), `#!/bin/sh\necho "npx $*" >> "${log}"\n`, { mode: 0o755 });
    const r = spawnSync("/bin/sh", [path.join(ROOT, "examples", "watch.sh")], { encoding: "utf8", env: { PATH: `${bin}:/usr/bin:/bin`, HOME: bin, WAKE_GROKBOT_CONFIG: "/cfg/w.json" } });
    return { code: r.status, err: r.stderr, log: fs.existsSync(log) ? fs.readFileSync(log, "utf8") : "" };
  }
  it("global with the pinned version: runs it with the explicit config", () => {
    const r = run("0.1.0");
    expect(r.code).toBe(0);
    expect(r.log).toBe("global --config /cfg/w.json watch --once\n");
  });
  it("global with another version: fails, runs nothing", () => {
    const r = run("0.0.9");
    expect(r.code).not.toBe(0);
    expect(r.err).toMatch(/0\.0\.9.*0\.1\.0|0\.1\.0.*0\.0\.9/);
    expect(r.log).toBe("");
  });
  it("no global: npx with the pinned version and the explicit config", () => {
    const r = run(null);
    expect(r.code).toBe(0);
    expect(r.log).toBe("npx --yes wake-grokbot@0.1.0 --config /cfg/w.json watch --once\n");
  });
  it("install-watch-task.ps1 checks the global version and refuses a mismatch (static check; no pwsh here)", () => {
    const t = fs.readFileSync(path.join(ROOT, "examples", "install-watch-task.ps1"), "utf8");
    expect(t).toMatch(/--version/);
    expect(t).toMatch(/-ne \$Version/);
    expect(t).toMatch(/throw/);
  });
});
