/** R1: a stale `.reclaim` must never make a resident process lock itself out; reclaim stays safe. */
import { spawn, spawnSync } from "node:child_process";
import * as fs from "node:fs";
import { createRequire } from "node:module";
import * as os from "node:os";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { _lockTestHooks, withLock } from "../src/fsutil.js";

const ROOT = path.join(import.meta.dirname, "..");
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "wg-r1-"));
const deadPid = () => Number(spawnSync(process.execPath, ["-e", "process.stdout.write(String(process.pid))"], { encoding: "utf8" }).stdout);
const ident = (pid: number, token = `t-${pid}`, host = os.hostname()) => JSON.stringify({ format: "wake-lock/1", host, pid, token }) + "\n";
/** A dead reclaim mutex in the current (directory) layout. */
function deadReclaimDir(lock: string, pid = deadPid()) {
  fs.mkdirSync(lock + ".reclaim");
  fs.writeFileSync(path.join(lock + ".reclaim", `owner-t-${pid}`), ident(pid));
}
afterEach(() => {
  delete _lockTestHooks.reclaim;
  delete _lockTestHooks.release;
});

let dist = "";
beforeAll(() => {
  dist = fs.mkdtempSync(path.join(os.tmpdir(), "wg-r1-dist-"));
  const tsc = createRequire(import.meta.url).resolve("typescript/bin/tsc");
  const r = spawnSync(process.execPath, [tsc, "-p", path.join(ROOT, "tsconfig.build.json"), "--outDir", dist], { encoding: "utf8" });
  if (r.status !== 0) throw new Error(`build failed: ${r.stdout}${r.stderr}`);
}, 120_000);
afterAll(() => fs.rmSync(dist, { recursive: true, force: true }));

function node(code: string, env: Record<string, string> = {}) {
  const p = spawn(process.execPath, ["--input-type=module", "-e", code], { env: { ...process.env, WG_DIST: pathToFileURL(dist).href + "/", ...env }, stdio: ["ignore", "pipe", "pipe"] });
  let out = "";
  let err = "";
  p.stdout.on("data", (d) => (out += d));
  p.stderr.on("data", (d) => (err += d));
  const done = new Promise<{ code: number | null; out: string; err: string }>((ok) => p.on("close", (c) => ok({ code: c, out, err })));
  const held = new Promise<void>((ok, no) => {
    p.stdout.on("data", () => out.includes("HELD") && ok());
    setTimeout(() => no(new Error(`child never reported HELD: ${out}${err}`)), 8000);
  });
  held.catch(() => {});
  return { p, done, held };
}

describe("r3 replay against built dist (same resident Engine)", () => {
  it("stale state.lock.reclaim (legacy file, dead pid): both accepts succeed fast, no lock left", async () => {
    const d = tmp();
    const r = await node(`
      import * as fs from "node:fs"; import * as path from "node:path"; import * as os from "node:os"; import { randomUUID } from "node:crypto";
      import { spawnSync } from "node:child_process";
      const D = process.env.WG_DIST; const d = process.env.WG_DIR;
      const { Engine } = await import(D + "core.js"); const { loadConfig } = await import(D + "config.js");
      fs.writeFileSync(path.join(d, "c.json"), JSON.stringify({ inbox: "in", state_dir: "st" }));
      fs.mkdirSync(path.join(d, "st"), { recursive: true });
      const dead = Number(spawnSync(process.execPath, ["-e", "process.stdout.write(String(process.pid))"], { encoding: "utf8" }).stdout);
      fs.writeFileSync(path.join(d, "st", "state.lock.reclaim"), JSON.stringify({ format: "wake-lock/1", host: os.hostname(), pid: dead, token: "x" }) + "\\n");
      const e = new Engine(loadConfig({ config: path.join(d, "c.json"), env: {} }), { env: {} });
      const task = () => ({ v: "wake-envelope/1", id: randomUUID(), type: "task", from: "dispatcher", to: "worker", title: "t", objective: "o", sent_at: new Date().toISOString() });
      const t0 = Date.now();
      const out = {};
      const t1 = task();
      out.first = await e.accept(t1).then((r) => r.code, (x) => "ERR " + x.message);
      out.lockLeftAfterFirst = fs.existsSync(path.join(d, "st", "state.lock"));
      out.second = await e.accept(task()).then((r) => r.code, (x) => "ERR " + x.message);
      out.ack = await e.ack(t1.id).then((r) => r.code, (x) => "ERR " + x.message);
      out.reply = await e.reply(t1.id, { status: "done", summary: "ok" }).then((r) => r.code, (x) => "ERR " + x.message);
      out.pump = await e.pump().then(() => "ok", (x) => "ERR " + x.message);
      out.third = await e.accept(task()).then((r) => r.code, (x) => "ERR " + x.message);
      out.ms = Date.now() - t0;
      out.leftovers = fs.readdirSync(path.join(d, "st")).filter((f) => f.startsWith("state.lock"));
      console.log(JSON.stringify(out));`, { WG_DIR: d }).done;
    expect(r.code, r.err).toBe(0);
    const out = JSON.parse(r.out.trim().split("\n").at(-1)!);
    expect(out).toMatchObject({ first: 0, lockLeftAfterFirst: false, second: 0, ack: 0, reply: 0, pump: "ok", third: 0 });
    expect(out.ms).toBeLessThan(1500);
    expect(out.leftovers.filter((f: string) => f === "state.lock")).toEqual([]);
  }, 60_000);
});

describe("stale and live reclaim mutexes", () => {
  it("release never needs the reclaim mutex (a stale one does not leave our lock behind)", () => {
    const d = tmp();
    const lock = path.join(d, "state.lock");
    deadReclaimDir(lock);
    for (let i = 0; i < 3; i++) expect(withLock(lock, () => i, 500)).toBe(i);
    expect(fs.existsSync(lock)).toBe(false);
  });
  it("dead lock + dead reclaim mutex: recovered automatically, nothing left", () => {
    const d = tmp();
    const lock = path.join(d, "state.lock");
    fs.writeFileSync(lock, ident(deadPid()));
    deadReclaimDir(lock);
    expect(withLock(lock, () => "ok", 2000)).toBe("ok");
    expect(fs.readdirSync(d)).toEqual([]);
  });
  it("dead lock + legacy dead reclaim file: recovered", () => {
    const d = tmp();
    const lock = path.join(d, "state.lock");
    fs.writeFileSync(lock, ident(deadPid()));
    fs.writeFileSync(lock + ".reclaim", ident(deadPid()));
    expect(withLock(lock, () => "ok", 2000)).toBe("ok");
    expect(fs.readdirSync(d)).toEqual([]);
  });
  it("dead lock + reclaim mutex of another host: busy, both kept (manual procedure)", () => {
    const d = tmp();
    const lock = path.join(d, "state.lock");
    fs.writeFileSync(lock, ident(deadPid()));
    fs.mkdirSync(lock + ".reclaim");
    fs.writeFileSync(path.join(lock + ".reclaim", "owner-x"), ident(1, "x", "elsewhere"));
    expect(() => withLock(lock, () => 1, 300)).toThrow(/state lock busy.*reclaim.*manual/s);
    expect(fs.existsSync(lock)).toBe(true);
    expect(fs.existsSync(path.join(lock + ".reclaim", "owner-x"))).toBe(true);
  });
  it("a leftover lock of this process (release failed) is recovered by this process", () => {
    const d = tmp();
    const lock = path.join(d, "state.lock");
    _lockTestHooks.release = () => {
      throw new Error("injected release failure");
    };
    expect(withLock(lock, () => "done", 500)).toBe("done"); // fn's result is not turned into a failure
    delete _lockTestHooks.release;
    expect(fs.existsSync(lock)).toBe(true);
    expect(withLock(lock, () => "again", 500)).toBe("again");
    expect(fs.existsSync(lock)).toBe(false);
  });
});

describe("real processes", () => {
  it.skipIf(process.platform === "win32")("live reclaimer is never disturbed; after SIGKILL its mutex is cleared and the dead lock reclaimed", async () => {
    const d = tmp();
    const lock = path.join(d, "state.lock");
    fs.writeFileSync(lock, ident(deadPid()));
    const k = node(`
      import * as fs from "node:fs";
      const { withLock, _lockTestHooks } = await import(process.env.WG_DIST + "fsutil.js");
      _lockTestHooks.reclaim = (p) => { if (p === "holding") { fs.writeSync(1, "HELD\\n"); for (;;) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1000); } };
      withLock(process.env.WG_LOCK, () => {}, 5000);`, { WG_LOCK: lock });
    await k.held;
    const before = fs.readdirSync(lock + ".reclaim");
    expect(() => withLock(lock, () => 1, 300)).toThrow(/state lock busy/);
    expect(fs.readdirSync(lock + ".reclaim")).toEqual(before);
    expect(fs.existsSync(lock)).toBe(true);
    k.p.kill("SIGKILL");
    await k.done;
    expect(withLock(lock, () => "mine", 3000)).toBe("mine");
    expect(fs.readdirSync(d)).toEqual([]);
  }, 60_000);
  it("8 processes x 30 increments starting from a dead lock and a dead reclaim mutex: no lost update", async () => {
    const d = tmp();
    const lock = path.join(d, "state.lock");
    const counter = path.join(d, "n");
    fs.writeFileSync(lock, ident(deadPid()));
    deadReclaimDir(lock);
    const code = `
      import * as fs from "node:fs";
      const { withLock } = await import(process.env.WG_DIST + "fsutil.js");
      for (let i = 0; i < 30; i++) withLock(process.env.WG_LOCK, () => {
        const f = process.env.WG_N; const v = fs.existsSync(f) ? Number(fs.readFileSync(f, "utf8")) : 0; fs.writeFileSync(f, String(v + 1));
      }, 30000);`;
    const res = await Promise.all(Array.from({ length: 8 }, () => node(code, { WG_LOCK: lock, WG_N: counter }).done));
    for (const r of res) expect(r.code, r.err).toBe(0);
    expect(Number(fs.readFileSync(counter, "utf8"))).toBe(240);
    expect(fs.readdirSync(d)).toEqual(["n"]);
  }, 60_000);
});
