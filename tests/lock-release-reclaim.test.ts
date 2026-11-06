/**
 * Untested branch of 0a68479: release cannot take `<lock>.reclaim` within 2 s, so the lock is left in place.
 * Regression only (fsutil unchanged): never removes another owner's lock/.reclaim, never re-runs finished work,
 * busy message is accurate and the leftover lock is recoverable once this process is provably gone.
 */
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { DEFAULTS, type Config } from "../src/config.js";
import { contentHash, type Envelope } from "../src/envelope.js";
import { withLock } from "../src/fsutil.js";
import { _testHooks, deliver } from "../src/sinks.js";
import { uuid } from "./helpers.js";

afterEach(() => {
  delete _testHooks.fault;
});
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "wg-rel-"));
const deadPid = () => Number(spawnSync(process.execPath, ["-e", "process.stdout.write(String(process.pid))"], { encoding: "utf8" }).stdout);
const other = (token: string, pid = process.ppid) => JSON.stringify({ format: "wake-lock/1", host: os.hostname(), pid, started_at: 1, token }) + "\n";
const tokenOf = (f: string) => JSON.parse(fs.readFileSync(f, "utf8")).token as string;

describe("release cannot take .reclaim within 2 s (lock left in place)", () => {
  it("withLock: fn runs once and its result is returned; the lock stays ours; another owner's .reclaim is untouched", () => {
    const f = path.join(tmp(), "state.lock");
    let runs = 0;
    let mine = "";
    const t0 = Date.now();
    const out = withLock(f, () => {
      runs++;
      mine = tokenOf(f);
      fs.writeFileSync(`${f}.reclaim`, other("reclaimer-X"));
      return "done";
    });
    expect(Date.now() - t0).toBeGreaterThanOrEqual(1900); // waited for the mutex, then gave up
    expect(out).toBe("done");
    expect(runs).toBe(1);
    expect(tokenOf(f)).toBe(mine); // left in place, not half-removed
    expect(tokenOf(`${f}.reclaim`)).toBe("reclaimer-X"); // never removed someone else's mutex
    // next caller in the same process: busy, accurate reason, work is NOT executed again
    let again = 0;
    expect(() => withLock(f, () => again++, 200)).toThrow(/state lock busy: .*state\.lock \(locked \(held by this process\); .*manual/s);
    expect(again).toBe(0);
  });

  it("another owner's lock that replaced ours before release is never deleted", () => {
    const f = path.join(tmp(), "state.lock");
    withLock(f, () => {
      fs.writeFileSync(f, other("owner-B"));
      fs.writeFileSync(`${f}.reclaim`, other("reclaimer-X"));
    });
    expect(tokenOf(f)).toBe("owner-B");
    expect(tokenOf(`${f}.reclaim`)).toBe("reclaimer-X");
  });

  it("recoverable: once the stuck .reclaim is cleared and the holder is provably gone, the lock is reclaimed and work proceeds", () => {
    const f = path.join(tmp(), "state.lock");
    withLock(f, () => fs.writeFileSync(`${f}.reclaim`, other("reclaimer-X")));
    // a stuck .reclaim keeps it busy with a hint naming both files
    const lock = JSON.parse(fs.readFileSync(f, "utf8"));
    fs.writeFileSync(f, JSON.stringify({ ...lock, pid: deadPid() }) + "\n"); // simulate: this holder process has exited
    expect(() => withLock(f, () => 1, 200)).toThrow(/state\.lock\.reclaim/);
    expect(fs.existsSync(f)).toBe(true);
    // manual step after checking no process is reclaiming: remove the stale mutex
    fs.rmSync(`${f}.reclaim`);
    expect(withLock(f, () => "ran", 1000)).toBe("ran");
    expect(fs.existsSync(f)).toBe(false);
    expect(fs.existsSync(`${f}.reclaim`)).toBe(false);
  });

  it("report sink: delivered once; the left lock makes a retry not_sent (busy), never a second write or a lost success", async () => {
    const dir = tmp();
    const root = path.join(dir, "reports");
    fs.mkdirSync(root);
    const cfg: Config = JSON.parse(JSON.stringify(DEFAULTS));
    cfg.sinks.report_roots = [root];
    const report = path.join(root, "r.md");
    const r: Envelope = { v: "wake-envelope/1", id: uuid(), type: "receipt", from: "w", to: "d", status: "done", summary: "x", sent_at: "2026-11-05T01:00:00Z" };
    const ctx = { cfg, inbox: dir, env: {}, timeoutMs: 1000, delivery: { taskId: uuid(), replyHash: contentHash(r), revision: 1 } };
    let writes = 0;
    _testHooks.fault = (w) => {
      if (w === "report") writes++;
      if (w === "sidecar" && !fs.existsSync(`${report}.lock.reclaim`)) fs.writeFileSync(`${report}.lock.reclaim`, other("reclaimer-X"));
    };
    const first = await deliver(r, { sink: "hufu-report", report_path: report }, ctx);
    expect(first).toMatchObject({ ok: true, outcome: "delivered" });
    expect(fs.existsSync(`${report}.DONE`)).toBe(true);
    expect(fs.existsSync(`${report}.lock`)).toBe(true);
    const mtime = fs.statSync(report).mtimeMs;
    const retry = await deliver(r, { sink: "hufu-report", report_path: report }, ctx);
    expect(retry).toMatchObject({ ok: false, outcome: "not_sent" });
    expect(retry.detail).toMatch(/held by this process.*manual/s);
    expect(writes).toBe(1);
    expect(fs.statSync(report).mtimeMs).toBe(mtime);
    expect(tokenOf(`${report}.lock.reclaim`)).toBe("reclaimer-X");
    // after manual recovery the same delivery is recognised as already delivered (no rewrite)
    fs.rmSync(`${report}.lock.reclaim`);
    const l = JSON.parse(fs.readFileSync(`${report}.lock`, "utf8"));
    fs.writeFileSync(`${report}.lock`, JSON.stringify({ ...l, pid: deadPid() }) + "\n");
    const after = await deliver(r, { sink: "hufu-report", report_path: report }, ctx);
    expect(after).toMatchObject({ ok: true, outcome: "delivered", state: "duplicate" });
    expect(writes).toBe(1);
  });
});
