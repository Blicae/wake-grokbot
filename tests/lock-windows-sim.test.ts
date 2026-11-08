/** Windows filesystem behaviours simulated on any OS (test-only fs injection in fsutil). */
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { _lockTestHooks, tryLock, withLock } from "../src/fsutil.js";

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "wg-win-"));
const deadPid = () => Number(spawnSync(process.execPath, ["-e", "process.stdout.write(String(process.pid))"], { encoding: "utf8" }).stdout);
const ident = (pid: number, token = `t-${pid}`, host = os.hostname()) => JSON.stringify({ format: "wake-lock/1", host, pid, token }) + "\n";
afterEach(() => {
  delete _lockTestHooks.renameDir;
  delete _lockTestHooks.createExclusive;
});
/** Windows: rename(directory, existing regular file) succeeds and overwrites the file. */
function windowsRename() {
  _lockTestHooks.renameDir = (src, dst) => {
    let st: fs.Stats | undefined;
    try {
      st = fs.lstatSync(dst);
    } catch {
      /* absent */
    }
    if (st && !st.isDirectory()) fs.unlinkSync(dst);
    fs.renameSync(src, dst);
  };
}

describe("file-form reclaim mutex is never overwritten (Windows rename semantics simulated)", () => {
  it("live foreign file-form .reclaim: busy with a hint, nothing deleted, fn not run; recovers after manual removal", () => {
    windowsRename();
    const d = tmp();
    const lock = path.join(d, "state.lock");
    fs.writeFileSync(lock, ident(deadPid()));
    const mutex = ident(process.ppid, "live-holder");
    fs.writeFileSync(lock + ".reclaim", mutex);
    let ran = false;
    expect(() => withLock(lock, () => (ran = true), 300)).toThrow(/state lock busy.*reclaim.*manual/s);
    expect(ran).toBe(false);
    expect(fs.readFileSync(lock + ".reclaim", "utf8")).toBe(mutex);
    expect(fs.existsSync(lock)).toBe(true);
    fs.unlinkSync(lock + ".reclaim"); // manual removal
    expect(withLock(lock, () => "ok", 2000)).toBe("ok");
  });
  it("stuck (unreadable) file-form .reclaim: busy, kept", () => {
    windowsRename();
    const d = tmp();
    const lock = path.join(d, "state.lock");
    fs.writeFileSync(lock, ident(deadPid()));
    fs.writeFileSync(lock + ".reclaim", "stuck");
    expect(() => withLock(lock, () => 1, 300)).toThrow(/state lock busy.*manual/s);
    expect(fs.readFileSync(lock + ".reclaim", "utf8")).toBe("stuck");
    expect(fs.existsSync(lock)).toBe(true);
  });
  it("other-host file-form .reclaim: busy, kept", () => {
    windowsRename();
    const d = tmp();
    const lock = path.join(d, "state.lock");
    fs.writeFileSync(lock, ident(deadPid()));
    const m = ident(1, "x", "elsewhere");
    fs.writeFileSync(lock + ".reclaim", m);
    expect(() => withLock(lock, () => 1, 300)).toThrow(/state lock busy/);
    expect(fs.readFileSync(lock + ".reclaim", "utf8")).toBe(m);
  });
  it("proven-dead file-form .reclaim is cleaned, then the dead lock is reclaimed", () => {
    windowsRename();
    const d = tmp();
    const lock = path.join(d, "state.lock");
    fs.writeFileSync(lock, ident(deadPid()));
    fs.writeFileSync(lock + ".reclaim", ident(deadPid()));
    expect(withLock(lock, () => "ok", 2000)).toBe("ok");
    expect(fs.readdirSync(d)).toEqual([]);
  });
});

describe("exclusive create: EPERM/EACCES (Windows delete-pending / sharing conflicts)", () => {
  const eperm = (code: string) => Object.assign(new Error(`${code}: operation not permitted, open`), { code });
  for (const code of ["EPERM", "EACCES"]) {
    it(`${code} while the lock path exists: busy, not thrown`, () => {
      const d = tmp();
      const lock = path.join(d, "state.lock");
      fs.writeFileSync(lock, ident(process.ppid, "live"));
      _lockTestHooks.createExclusive = () => {
        throw eperm(code);
      };
      const r = tryLock(lock);
      expect("busy" in r).toBe(true);
      expect(fs.readFileSync(lock, "utf8")).toContain("live");
    });
    it(`${code} once while the path is briefly absent (delete pending): retried, then acquired`, () => {
      const d = tmp();
      const lock = path.join(d, "state.lock");
      let n = 0;
      _lockTestHooks.createExclusive = (f, data) => {
        if (n++ === 0) throw eperm(code);
        fs.writeFileSync(f, data, { flag: "wx" });
      };
      expect(withLock(lock, () => "ok", 2000)).toBe("ok");
    });
    it(`${code} persistently with no lock file: a real permission error is thrown, not swallowed as busy`, () => {
      const d = tmp();
      const lock = path.join(d, "state.lock");
      _lockTestHooks.createExclusive = () => {
        throw eperm(code);
      };
      expect(() => tryLock(lock)).toThrow(new RegExp(code));
    });
  }
});
