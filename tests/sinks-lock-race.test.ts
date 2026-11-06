/** Lock reclaim races: a live lock must never be moved away or replaced by a reclaimer. */
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { DEFAULTS, type Config } from "../src/config.js";
import { contentHash, type Envelope } from "../src/envelope.js";
import { _lockTestHooks } from "../src/fsutil.js";
import { _testHooks, deliver } from "../src/sinks.js";
import { uuid } from "./helpers.js";

afterEach(() => {
  delete _testHooks.fault;
  delete _lockTestHooks.reclaim;
});

function deadPid(): number {
  const r = spawnSync(process.execPath, ["-e", "process.stdout.write(String(process.pid))"], { encoding: "utf8" });
  return Number(r.stdout); // exited: pid is gone (reuse within the test is practically impossible)
}

describe("lock reclaim race", () => {
  it("a live lock created between the dead-owner check and the reclaim is never moved or replaced", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wg-race-"));
    const root = path.join(dir, "reports");
    fs.mkdirSync(root);
    const cfg: Config = JSON.parse(JSON.stringify(DEFAULTS));
    cfg.sinks.report_roots = [root];
    const report = path.join(root, "r.md");
    const lock = report + ".lock";
    fs.writeFileSync(lock, JSON.stringify({ host: os.hostname(), pid: deadPid(), started_at: 1, token: "dead" }));
    const live = JSON.stringify({ host: os.hostname(), pid: process.ppid, started_at: 1, token: "live-B" });
    const seen: string[] = [];
    let calls = 0;
    // another reclaimer (B) wins the race right after our check: removes the dead lock and takes a fresh live one;
    // a third process (C) is ready to grab the path the moment it is free
    _lockTestHooks.reclaim = (phase) => {
      if (phase === "checked" && calls++ === 0) {
        fs.rmSync(lock);
        fs.writeFileSync(lock, live, { flag: "wx" });
      }
    };
    const r: Envelope = { v: "wake-envelope/1", id: uuid(), type: "receipt", from: "w", to: "d", status: "done", summary: "x", sent_at: "2026-11-05T01:00:00Z" };
    const res = await deliver(r, { sink: "hufu-report", report_path: report }, { cfg, inbox: dir, env: {}, timeoutMs: 1000, delivery: { taskId: uuid(), replyHash: contentHash(r), revision: 1 } });
    seen.push(fs.readFileSync(lock, "utf8"));
    expect(res).toMatchObject({ ok: false, outcome: "not_sent", state: "failed" });
    expect(seen).toEqual([live]); // B's live lock is still in place, untouched
    expect(fs.readdirSync(root).filter((f) => f.includes(".stale-") || f.endsWith(".reclaim"))).toEqual([]);
    expect(fs.existsSync(report)).toBe(false);
  });
  it("a stuck reclaim mutex is never stolen: busy with manual recovery", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wg-race-"));
    const root = path.join(dir, "reports");
    fs.mkdirSync(root);
    const cfg: Config = JSON.parse(JSON.stringify(DEFAULTS));
    cfg.sinks.report_roots = [root];
    const report = path.join(root, "r.md");
    fs.writeFileSync(report + ".lock", JSON.stringify({ host: os.hostname(), pid: deadPid(), started_at: 1, token: "dead" }));
    fs.writeFileSync(report + ".lock.reclaim", "stuck");
    const r: Envelope = { v: "wake-envelope/1", id: uuid(), type: "receipt", from: "w", to: "d", status: "done", summary: "x", sent_at: "2026-11-05T01:00:00Z" };
    const res = await deliver(r, { sink: "hufu-report", report_path: report }, { cfg, inbox: dir, env: {}, timeoutMs: 1000, delivery: { taskId: uuid(), replyHash: contentHash(r), revision: 1 } });
    expect(res).toMatchObject({ ok: false, outcome: "not_sent", state: "failed" });
    expect(res.detail).toMatch(/manual/);
    expect(fs.readFileSync(report + ".lock.reclaim", "utf8")).toBe("stuck");
  });
});

describe("duplicate module load in one process (S2)", () => {
  it("a second copy of sinks never judges this process's lock as dead", async () => {
    const { vi } = await import("vitest");
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wg-dup-"));
    const root = path.join(dir, "reports");
    fs.mkdirSync(root);
    const cfg: Config = JSON.parse(JSON.stringify(DEFAULTS));
    cfg.sinks.report_roots = [root];
    const report = path.join(root, "r.md");
    const mk = (s: string): [Envelope, { taskId: string; replyHash: string; revision: number }] => {
      const r: Envelope = { v: "wake-envelope/1", id: uuid(), type: "receipt", from: "w", to: "d", status: "done", summary: s, sent_at: "2026-11-05T01:00:00Z" };
      return [r, { taskId: "T", replyHash: contentHash(r), revision: 1 }];
    };
    for (let round = 0; round < 20; round++) {
      vi.resetModules();
      const copy = (await import("../src/sinks.js")) as typeof import("../src/sinks.js");
      expect(copy._testHooks).not.toBe(_testHooks); // really a second module instance
      for (const f of fs.readdirSync(root)) fs.rmSync(path.join(root, f));
      const [a, da] = mk("a");
      const [b, db] = mk("b");
      let inner: Awaited<ReturnType<typeof deliver>> | undefined;
      _testHooks.fault = (w) => {
        if (w === "intent" && !inner) void copy.deliver(b, { sink: "hufu-report", report_path: report }, { cfg, inbox: dir, env: {}, timeoutMs: 1000, delivery: db }).then((x) => (inner = x));
      };
      const res = await deliver(a, { sink: "hufu-report", report_path: report }, { cfg, inbox: dir, env: {}, timeoutMs: 1000, delivery: da });
      await new Promise((ok) => setTimeout(ok, 0));
      delete _testHooks.fault;
      expect(res.ok, `round ${round}`).toBe(true);
      expect(inner, `round ${round}`).toMatchObject({ ok: false, outcome: "not_sent", state: "failed" });
    }
  });
});

it("own pid with a different start estimate in the lock is never treated as dead (S2)", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wg-own-"));
  const root = path.join(dir, "reports");
  fs.mkdirSync(root);
  const cfg: Config = JSON.parse(JSON.stringify(DEFAULTS));
  cfg.sinks.report_roots = [root];
  const report = path.join(root, "r.md");
  fs.writeFileSync(report + ".lock", JSON.stringify({ format: "wake-lock/1", host: os.hostname(), pid: process.pid, started_at: 1, token: "other-copy" }));
  const r: Envelope = { v: "wake-envelope/1", id: uuid(), type: "receipt", from: "w", to: "d", status: "done", summary: "x", sent_at: "2026-11-05T01:00:00Z" };
  const res = await deliver(r, { sink: "hufu-report", report_path: report }, { cfg, inbox: dir, env: {}, timeoutMs: 1000, delivery: { taskId: "T", replyHash: contentHash(r), revision: 1 } });
  expect(res).toMatchObject({ ok: false, outcome: "not_sent", state: "failed" });
  expect(JSON.parse(fs.readFileSync(report + ".lock", "utf8")).token).toBe("other-copy");
});
