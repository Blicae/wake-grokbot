/**
 * R1 (4b9e00e): release no longer needs `<lock>.reclaim`. A foreign/stuck reclaim mutex present at release time
 * must not leave our lock behind, must never be removed by us, and must never turn finished work into a failure or
 * a second execution. Also: a reclaimer that crashed after deleting its owner file leaves an empty `.reclaim/`
 * directory, which later attempts recover from safely.
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
const deadPid = () =>
  Number(
    spawnSync(
      process.execPath,
      ["-e", "process.stdout.write(String(process.pid))"],
      { encoding: "utf8" },
    ).stdout,
  );
const other = (token: string, pid = process.ppid) =>
  JSON.stringify({
    format: "wake-lock/1",
    host: os.hostname(),
    pid,
    started_at: 1,
    token,
  }) + "\n";
const tokenOf = (f: string) =>
  JSON.parse(fs.readFileSync(f, "utf8")).token as string;

const mkReclaimDir = (f: string, token: string, pid = process.ppid) => {
  fs.mkdirSync(`${f}.reclaim`);
  fs.writeFileSync(
    path.join(`${f}.reclaim`, `owner-${token}`),
    other(token, pid),
  );
};

describe("release does not depend on .reclaim (R1)", () => {
  it("withLock: a live foreign .reclaim at release time: fn runs once, result returned, lock released fast, .reclaim untouched", () => {
    const f = path.join(tmp(), "state.lock");
    let runs = 0;
    const t0 = Date.now();
    const out = withLock(f, () => {
      runs++;
      fs.writeFileSync(`${f}.reclaim`, other("reclaimer-X")); // legacy file form, live pid
      return "done";
    });
    expect(Date.now() - t0).toBeLessThan(1500); // no wait for the mutex any more
    expect(out).toBe("done");
    expect(runs).toBe(1);
    expect(fs.existsSync(f)).toBe(false); // released
    expect(tokenOf(`${f}.reclaim`)).toBe("reclaimer-X"); // someone else's mutex never removed
    // next caller in the same process is NOT busy and runs exactly once
    let again = 0;
    expect(withLock(f, () => ++again, 500)).toBe(1);
    expect(again).toBe(1);
    expect(tokenOf(`${f}.reclaim`)).toBe("reclaimer-X");
  });

  it("same with a live foreign directory-form .reclaim: released, holder's owner file untouched", () => {
    const f = path.join(tmp(), "state.lock");
    expect(
      withLock(f, () => {
        mkReclaimDir(f, "reclaimer-Y");
        return 7;
      }),
    ).toBe(7);
    expect(fs.existsSync(f)).toBe(false);
    expect(fs.readdirSync(`${f}.reclaim`)).toEqual(["owner-reclaimer-Y"]);
  });

  it("another owner's lock that replaced ours before release is never deleted, nor its .reclaim", () => {
    const f = path.join(tmp(), "state.lock");
    withLock(f, () => {
      fs.writeFileSync(f, other("owner-B"));
      fs.writeFileSync(`${f}.reclaim`, other("reclaimer-X"));
    });
    expect(tokenOf(f)).toBe("owner-B");
    expect(tokenOf(`${f}.reclaim`)).toBe("reclaimer-X");
  });

  it("dead lock + live foreign .reclaim: busy with accurate hint, nothing deleted; after manual mutex removal it recovers", () => {
    const f = path.join(tmp(), "state.lock");
    fs.writeFileSync(f, other("dead-owner", deadPid()));
    fs.writeFileSync(`${f}.reclaim`, other("reclaimer-X"));
    let ran = 0;
    expect(() => withLock(f, () => ran++, 200)).toThrow(/state\.lock\.reclaim/);
    expect(ran).toBe(0);
    expect(tokenOf(f)).toBe("dead-owner");
    expect(tokenOf(`${f}.reclaim`)).toBe("reclaimer-X");
    fs.rmSync(`${f}.reclaim`); // manual step after confirming no reclaimer runs
    expect(withLock(f, () => "ran", 1000)).toBe("ran");
    expect(fs.existsSync(f)).toBe(false);
    expect(fs.existsSync(`${f}.reclaim`)).toBe(false);
  });

  it("report sink: foreign .reclaim at release: delivered once, lock released, retry is duplicate (no rewrite), .reclaim untouched", async () => {
    const dir = tmp();
    const root = path.join(dir, "reports");
    fs.mkdirSync(root);
    const cfg: Config = JSON.parse(JSON.stringify(DEFAULTS));
    cfg.sinks.report_roots = [root];
    const report = path.join(root, "r.md");
    const r: Envelope = {
      v: "wake-envelope/1",
      id: uuid(),
      type: "receipt",
      from: "w",
      to: "d",
      status: "done",
      summary: "x",
      sent_at: "2026-11-05T01:00:00Z",
    };
    const ctx = {
      cfg,
      inbox: dir,
      env: {},
      timeoutMs: 1000,
      delivery: { taskId: uuid(), replyHash: contentHash(r), revision: 1 },
    };
    let writes = 0;
    _testHooks.fault = (w) => {
      if (w === "report") writes++;
      if (w === "sidecar" && !fs.existsSync(`${report}.lock.reclaim`))
        fs.writeFileSync(`${report}.lock.reclaim`, other("reclaimer-X"));
    };
    const first = await deliver(
      r,
      { sink: "hufu-report", report_path: report },
      ctx,
    );
    expect(first).toMatchObject({ ok: true, outcome: "delivered" });
    expect(fs.existsSync(`${report}.DONE`)).toBe(true);
    expect(fs.existsSync(`${report}.lock`)).toBe(false);
    const mtime = fs.statSync(report).mtimeMs;
    const retry = await deliver(
      r,
      { sink: "hufu-report", report_path: report },
      ctx,
    );
    expect(retry).toMatchObject({
      ok: true,
      outcome: "delivered",
      state: "duplicate",
    });
    expect(writes).toBe(1);
    expect(fs.statSync(report).mtimeMs).toBe(mtime);
    expect(tokenOf(`${report}.lock.reclaim`)).toBe("reclaimer-X");
  });
});

describe("reclaimer crashed after deleting its owner file (empty .reclaim/ left)", () => {
  it("dead lock + empty .reclaim/: recovered automatically, work runs once, nothing left", () => {
    const f = path.join(tmp(), "state.lock");
    fs.writeFileSync(f, other("dead-owner", deadPid()));
    fs.mkdirSync(`${f}.reclaim`); // owner-<token> removed, crash before rmdir
    let runs = 0;
    expect(withLock(f, () => ++runs, 2000)).toBe(1);
    expect(runs).toBe(1);
    expect(fs.existsSync(f)).toBe(false);
    expect(fs.existsSync(`${f}.reclaim`)).toBe(false);
  });

  it("no lock + empty .reclaim/: lock taken and released normally", () => {
    const f = path.join(tmp(), "state.lock");
    fs.mkdirSync(`${f}.reclaim`);
    expect(withLock(f, () => "ok", 1000)).toBe("ok");
    expect(fs.existsSync(f)).toBe(false);
  });

  it("live lock of another process + empty .reclaim/: busy, live lock never deleted", () => {
    const f = path.join(tmp(), "state.lock");
    fs.writeFileSync(f, other("live-owner"));
    fs.mkdirSync(`${f}.reclaim`);
    let ran = 0;
    expect(() => withLock(f, () => ran++, 200)).toThrow(/state lock busy/);
    expect(ran).toBe(0);
    expect(tokenOf(f)).toBe("live-owner");
  });
});
