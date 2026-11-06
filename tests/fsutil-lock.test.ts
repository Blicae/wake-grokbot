/** Shared lock primitive (fsutil): owner liveness, never steal by age, legacy format, release, real processes. */
import { spawn, spawnSync } from "node:child_process";
import * as fs from "node:fs";
import { createRequire } from "node:module";
import * as os from "node:os";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { withLock } from "../src/fsutil.js";

const ROOT = path.join(import.meta.dirname, "..");
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "wg-lock-"));
const deadPid = () => Number(spawnSync(process.execPath, ["-e", "process.stdout.write(String(process.pid))"], { encoding: "utf8" }).stdout);
const old = (f: string) => {
  const t = new Date(Date.now() - 24 * 3600_000);
  fs.utimesSync(f, t, t);
};
const owner = (o: Record<string, unknown>) => JSON.stringify({ format: "wake-lock/1", host: os.hostname(), started_at: 1, token: "other", ...o });

describe("withLock never steals by age", () => {
  it("an old lock of a live pid stays; busy error has a manual hint", () => {
    const f = path.join(tmp(), "state.lock");
    fs.writeFileSync(f, owner({ pid: process.ppid }));
    old(f);
    expect(() => withLock(f, () => 1, 200)).toThrow(/state lock busy.*manual/s);
    expect(JSON.parse(fs.readFileSync(f, "utf8")).token).toBe("other");
  });
  it("legacy `<token> <pid>` lock file is never deleted by age", () => {
    const f = path.join(tmp(), "state.lock");
    fs.writeFileSync(f, `abc ${deadPid()}\n`);
    old(f);
    expect(() => withLock(f, () => 1, 200)).toThrow(/state lock busy.*manual/s);
    expect(fs.readFileSync(f, "utf8")).toMatch(/^abc /);
  });
  it("another host's lock is never stolen", () => {
    const f = path.join(tmp(), "state.lock");
    fs.writeFileSync(f, owner({ host: "elsewhere", pid: 1 }));
    old(f);
    expect(() => withLock(f, () => 1, 200)).toThrow(/state lock busy/);
    expect(fs.existsSync(f)).toBe(true);
  });
  it("own pid with another token (second module copy, other start estimate) is never treated as dead", () => {
    const f = path.join(tmp(), "state.lock");
    fs.writeFileSync(f, owner({ pid: process.pid, started_at: 12345 }));
    old(f);
    expect(() => withLock(f, () => 1, 200)).toThrow(/state lock busy/);
    expect(JSON.parse(fs.readFileSync(f, "utf8")).token).toBe("other");
  });
  it("a provably dead owner (same host, pid gone) is reclaimed at once", () => {
    const f = path.join(tmp(), "state.lock");
    fs.writeFileSync(f, owner({ pid: deadPid() }));
    expect(withLock(f, () => 42, 2000)).toBe(42);
    expect(fs.existsSync(f)).toBe(false);
    expect(fs.existsSync(f + ".reclaim")).toBe(false);
  });
});

describe("release", () => {
  it("releases on exceptions and rethrows", () => {
    const f = path.join(tmp(), "state.lock");
    expect(() => withLock(f, () => { throw new Error("boom"); })).toThrow("boom");
    expect(fs.existsSync(f)).toBe(false);
  });
  it("never deletes a lock that is not its own", () => {
    const f = path.join(tmp(), "state.lock");
    withLock(f, () => fs.writeFileSync(f, owner({ pid: process.ppid, token: "someone" })));
    expect(JSON.parse(fs.readFileSync(f, "utf8")).token).toBe("someone");
  });
  it("lock file records the owner identity", () => {
    const f = path.join(tmp(), "state.lock");
    const seen = withLock(f, () => JSON.parse(fs.readFileSync(f, "utf8")));
    expect(seen).toMatchObject({ format: "wake-lock/1", host: os.hostname(), pid: process.pid });
    expect(typeof seen.token).toBe("string");
  });
});

describe("duplicate module load in one process", () => {
  it("a second copy of fsutil does not steal the first copy's lock", async () => {
    const f = path.join(tmp(), "state.lock");
    vi.resetModules();
    const copy = (await import("../src/fsutil.js")) as typeof import("../src/fsutil.js");
    const inner = withLock(f, () => {
      try {
        copy.withLock(f, () => "stolen", 200);
        return "stolen";
      } catch (e) {
        return (e as Error).message;
      }
    });
    expect(inner).toMatch(/state lock busy/);
  });
});

// Real child processes need compiled JS.
let dist = "";
beforeAll(() => {
  dist = fs.mkdtempSync(path.join(os.tmpdir(), "wg-lock-dist-"));
  const tsc = createRequire(import.meta.url).resolve("typescript/bin/tsc");
  const r = spawnSync(process.execPath, [tsc, "-p", path.join(ROOT, "tsconfig.build.json"), "--outDir", dist], { encoding: "utf8" });
  if (r.status !== 0) throw new Error(`build failed: ${r.stdout}${r.stderr}`);
}, 120_000);
afterAll(() => fs.rmSync(dist, { recursive: true, force: true }));

function child(lock: string, counter: string, n: number, hang = false) {
  const url = pathToFileURL(path.join(dist, "fsutil.js")).href;
  const code = `
    import * as fs from "node:fs";
    const { withLock } = await import(${JSON.stringify(url)});
    const [lock, counter, n, hang] = JSON.parse(process.env.WG_ARGS);
    for (let i = 0; i < n; i++)
      withLock(lock, () => {
        if (hang) { fs.writeSync(1, "HELD\\n"); for (;;) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1000); }
        const v = fs.existsSync(counter) ? Number(fs.readFileSync(counter, "utf8")) : 0;
        fs.writeFileSync(counter, String(v + 1));
      }, 30000);`;
  const p = spawn(process.execPath, ["--input-type=module", "-e", code], { env: { ...process.env, WG_ARGS: JSON.stringify([lock, counter, n, hang]) }, stdio: ["ignore", "pipe", "pipe"] });
  let out = "";
  let err = "";
  p.stdout.on("data", (d) => (out += d));
  p.stderr.on("data", (d) => (err += d));
  const held = new Promise<void>((ok) => p.stdout.on("data", () => out.includes("HELD") && ok()));
  const done = new Promise<{ code: number | null; err: string }>((ok) => p.on("close", (code) => ok({ code, err })));
  return { p, held, done };
}

describe("real processes", () => {
  it("8 processes x 40 locked increments: no lost update, no leftover lock files", async () => {
    const d = tmp();
    const lock = path.join(d, "state.lock");
    const counter = path.join(d, "n");
    const res = await Promise.all(Array.from({ length: 8 }, () => child(lock, counter, 40).done));
    for (const r of res) expect(r.code, r.err).toBe(0);
    expect(Number(fs.readFileSync(counter, "utf8"))).toBe(320);
    expect(fs.readdirSync(d).sort()).toEqual(["n"]);
  }, 60_000);
  it.skipIf(process.platform === "win32")("a SIGKILLed holder's lock is reclaimed at once (no 120 s wait); a live holder is not", async () => {
    const d = tmp();
    const lock = path.join(d, "state.lock");
    const k = child(lock, path.join(d, "n"), 1, true);
    await k.held;
    expect(() => withLock(lock, () => 1, 300)).toThrow(/state lock busy/);
    k.p.kill("SIGKILL");
    await k.done;
    const t0 = Date.now();
    expect(withLock(lock, () => "mine", 3000)).toBe("mine");
    expect(Date.now() - t0).toBeLessThan(2000);
    expect(fs.readdirSync(d)).toEqual([]);
  }, 60_000);
});
