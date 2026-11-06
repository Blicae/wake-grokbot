import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const RETRIES = 8;

function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/** rename with retries: Windows reports EPERM/EBUSY/EACCES while another process (indexer, AV) holds the file. */
export function renameRetry(src: string, dst: string): void {
  for (let i = 0; ; i++) {
    try {
      fs.renameSync(src, dst);
      return;
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code;
      if (i >= RETRIES || !["EPERM", "EBUSY", "EACCES"].includes(code ?? "")) throw e;
      sleepSync(50 * (i + 1));
    }
  }
}

function tmpFor(file: string): string {
  return path.join(path.dirname(file), `.${path.basename(file)}.${randomUUID()}.tmp`);
}

function writeTmp(file: string, data: string | Buffer): string {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = tmpFor(file);
  const fd = fs.openSync(tmp, "wx", 0o644);
  try {
    fs.writeFileSync(fd, data);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  return tmp;
}

/** Write a file atomically (temp file in the same folder, fsync, rename). Replaces an existing file. */
export function atomicWrite(file: string, data: string | Buffer): void {
  const tmp = writeTmp(file, data);
  try {
    renameRetry(tmp, file);
  } catch (e) {
    fs.rmSync(tmp, { force: true });
    throw e;
  }
}

/** Write a file atomically and fail with EEXIST if it already exists (hard link is atomic and never overwrites). */
export function atomicCreate(file: string, data: string | Buffer): void {
  const tmp = writeTmp(file, data);
  try {
    try {
      fs.linkSync(tmp, file);
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code;
      if (code === "EEXIST") throw e;
      // file systems without hard links: best effort no-overwrite
      if (fs.existsSync(file)) {
        const err = new Error(`EEXIST: ${file}`) as NodeJS.ErrnoException;
        err.code = "EEXIST";
        throw err;
      }
      renameRetry(tmp, file);
      return;
    }
  } finally {
    fs.rmSync(tmp, { force: true });
  }
}

export function readJson<T>(file: string): T {
  return JSON.parse(fs.readFileSync(file, "utf8").replace(/^\uFEFF/, "")) as T;
}

export const LOCK_FORMAT = "wake-lock/1";

interface LockOwner {
  format?: string;
  host: string;
  pid: number;
  started_at?: number;
  token: string;
}

/** Process start estimate, computed once per process (shared by all module copies); diagnostic only, never a death proof. */
const START_KEY = Symbol.for("wake-grokbot.process-start");
function processStart(): number {
  const g = globalThis as Record<symbol, unknown>;
  if (typeof g[START_KEY] !== "number") g[START_KEY] = Math.round(Date.now() - process.uptime() * 1000);
  return g[START_KEY] as number;
}

/** Test-only interleaving point (not exported from the package entry; not reachable from CLI, env or config). */
export const _lockTestHooks: {
  reclaim?: (phase: "checked" | "holding") => void;
  release?: () => void;
  /** replaces the directory rename that takes the reclaim mutex (simulates other platforms' rename semantics) */
  renameDir?: (src: string, dst: string) => void;
  /** replaces the exclusive create of the lock file (simulates EPERM/EACCES conflicts) */
  createExclusive?: (file: string, data: string) => void;
} = {};

/** Tokens of locks this process created, shared by all module copies: "leftover" = its release failed. */
const REG_KEY = Symbol.for("wake-grokbot.lock-tokens");
function registry(): Map<string, "held" | "leftover"> {
  const g = globalThis as Record<symbol, unknown>;
  if (!(g[REG_KEY] instanceof Map)) g[REG_KEY] = new Map<string, "held" | "leftover">();
  return g[REG_KEY] as Map<string, "held" | "leftover">;
}

function readText(file: string): string | undefined {
  try {
    return fs.readFileSync(file, "utf8");
  } catch {
    return undefined;
  }
}
/** lstat-based existence: a path that exists but cannot be stat'ed (EPERM/EACCES/EBUSY) counts as existing. */
function pathExists(file: string): boolean {
  try {
    fs.lstatSync(file);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code !== "ENOENT";
  }
}
function parseOwner(text: string | undefined): LockOwner | undefined {
  if (!text) return undefined;
  try {
    const o = JSON.parse(text) as Partial<LockOwner>;
    return o && typeof o.host === "string" && typeof o.pid === "number" && typeof o.token === "string" ? (o as LockOwner) : undefined;
  } catch {
    return undefined;
  }
}

/** Provably gone only when: same host and the pid no longer exists. This process's own pid is always alive. */
function ownerGone(o: LockOwner): { gone: boolean; why: string } {
  if (o.host !== os.hostname()) return { gone: false, why: `held on another host (${o.host})` };
  if (o.pid === process.pid) return { gone: false, why: "held by this process" };
  try {
    process.kill(o.pid, 0);
    return { gone: false, why: `pid ${o.pid} is alive (or reused; cannot prove it is gone)` };
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    return code === "ESRCH" ? { gone: true, why: `pid ${o.pid} is gone` } : { gone: false, why: `pid ${o.pid} exists (${code})` };
  }
}

/**
 * Reclaim mutex: the directory `<lock>.reclaim` holding exactly one `owner-<token>` file (wake-lock/1 identity).
 * Taken by renaming a private, already filled temp directory onto that path (atomic; fails while a holder's file
 * is in it), so a holder is never displaced. A dead holder (same host, pid gone) is cleared by removing exactly its
 * own `owner-<token>` file, then the directory only if empty: a new holder's file is never touched. No nested mutex.
 */
function takeReclaim(lockFile: string, me: LockOwner, manual: string): { release: () => void } | { busy: string } {
  const dir = `${lockFile}.reclaim`;
  const name = path.basename(dir);
  const mine = `owner-${me.token}`;
  for (let i = 0; i < 4; i++) {
    // Never rename onto a regular file: Windows lets rename(dir, file) overwrite it. A file-form mutex (earlier
    // development builds) follows the live/dead rules: live, unknown or foreign = busy; proven dead = removed.
    let pre: fs.Stats | undefined;
    try {
      pre = fs.lstatSync(dir);
    } catch {
      pre = undefined;
    }
    if (pre && !pre.isDirectory()) {
      const holder = parseOwner(readText(dir));
      if (!holder) return { busy: `reclaim mutex ${name} is unreadable; ${manual} and ${name}` };
      const g = ownerGone(holder);
      if (!g.gone) return { busy: `reclaim mutex ${name} is held (${g.why}); ${manual} and ${name}` };
      try {
        fs.unlinkSync(dir); // never removes a directory (a new holder)
      } catch {
        /* gone or replaced */
      }
      continue;
    }
    const tmpDir = `${dir}.tmp-${me.token}`;
    fs.mkdirSync(tmpDir);
    try {
      fs.writeFileSync(path.join(tmpDir, mine), JSON.stringify(me) + "\n");
      (_lockTestHooks.renameDir ?? renameRetry)(tmpDir, dir);
      return {
        release: () => {
          fs.rmSync(path.join(dir, mine), { force: true });
          try {
            fs.rmdirSync(dir); // only if empty
          } catch {
            /* a new holder is already in */
          }
        },
      };
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code ?? "";
      if (!["EEXIST", "ENOTEMPTY", "ENOTDIR", "EISDIR", "EPERM", "EACCES"].includes(code)) throw e;
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
    let st: fs.Stats;
    try {
      st = fs.lstatSync(dir);
    } catch {
      continue; // released meanwhile
    }
    if (st.isDirectory()) {
      let entries: string[];
      try {
        entries = fs.readdirSync(dir);
      } catch {
        continue;
      }
      if (entries.length === 0) {
        try {
          fs.rmdirSync(dir); // abandoned between a holder's unlink and rmdir
        } catch {
          /* someone moved in */
        }
        continue;
      }
      const holder = entries.length === 1 ? parseOwner(readText(path.join(dir, entries[0]!))) : undefined;
      if (!holder || entries[0] !== `owner-${holder.token}`) return { busy: `reclaim mutex ${name} has unexpected content; ${manual} and ${name}` };
      const g = ownerGone(holder);
      if (!g.gone) return { busy: `reclaim mutex ${name} is held (${g.why}); ${manual}` };
      fs.rmSync(path.join(dir, entries[0]!), { force: true });
      try {
        fs.rmdirSync(dir);
      } catch {
        /* someone moved in */
      }
      continue;
    }
    // a non-directory appeared after the check: handled at the top of the next round
  }
  return { busy: `reclaim mutex ${name} is contended; ${manual}` };
}

/**
 * One attempt at a cross-process lock file. Never steals by age. Who may delete `<lock>`:
 * - its owner, after reading its own token (no mutex needed: nobody else ever deletes a live owner's lock, so the
 *   file read is still the owner's at unlink time);
 * - a reclaimer holding the reclaim mutex, after re-reading the token of a provably dead owner (same host, pid gone)
 *   under that mutex; only one reclaimer can be in that section, and the dead owner cannot act.
 * Unknown/legacy, other-host, live or own-pid locks are never deleted: busy, with a manual-recovery hint. The one
 * exception is a lock of this process whose release failed (in-process registry): this process removes it.
 */
export function tryLock(lockFile: string): { release: () => void } | { busy: string } {
  fs.mkdirSync(path.dirname(lockFile), { recursive: true });
  const me: LockOwner = { format: LOCK_FORMAT, host: os.hostname(), pid: process.pid, started_at: processStart(), token: randomUUID() };
  const name = path.basename(lockFile);
  const manual = `retryable; if no wake-grokbot process holds it, remove ${name} manually`;
  const reg = registry();
  let permRetries = 0;
  for (let i = 0; i < 3; i++) {
    try {
      const data = JSON.stringify(me) + "\n";
      if (_lockTestHooks.createExclusive) _lockTestHooks.createExclusive(lockFile, data);
      else fs.writeFileSync(lockFile, data, { flag: "wx" });
      reg.set(me.token, "held");
      return {
        release: () => {
          try {
            _lockTestHooks.release?.();
            if (parseOwner(readText(lockFile))?.token === me.token) fs.rmSync(lockFile, { force: true });
            reg.delete(me.token);
          } catch {
            reg.set(me.token, "leftover"); // removed by this process on its next attempt
          }
        },
      };
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code;
      if (code === "EPERM" || code === "EACCES") {
        // Windows reports a conflict on the path (open handle, delete pending) as EPERM/EACCES. Treat it as a
        // conflict only with evidence: the path exists, or it vanishes and a retry succeeds; otherwise it is a
        // real permission problem and is thrown.
        if (!pathExists(lockFile)) {
          if (++permRetries > 5) throw e;
          sleepSync(10 * permRetries);
          i--;
          continue;
        }
      } else if (code !== "EEXIST") throw e;
    }
    const text = readText(lockFile);
    if (text === undefined) continue; // released meanwhile
    const o = parseOwner(text);
    if (!o) return { busy: `lock is unreadable or in an old format; ${manual}` };
    if (o.host === me.host && o.pid === process.pid && reg.get(o.token) === "leftover") {
      fs.rmSync(lockFile, { force: true }); // our own leftover: only we delete our locks
      reg.delete(o.token);
      continue;
    }
    const g = ownerGone(o);
    if (!g.gone) return { busy: `locked (${g.why}); ${manual}` };
    _lockTestHooks.reclaim?.("checked");
    const m = takeReclaim(lockFile, me, manual);
    if ("busy" in m) return m;
    try {
      _lockTestHooks.reclaim?.("holding");
      const again = parseOwner(readText(lockFile));
      if (again && again.token === o.token) fs.rmSync(lockFile, { force: true });
      else if (readText(lockFile) !== undefined) return { busy: `locked by a new owner; ${manual}` };
    } finally {
      m.release();
    }
  }
  return { busy: `lock is contended; ${manual}` };
}

/**
 * Cross-process lock around `fn`, waiting up to `timeoutMs`. Never steals by age (`_staleMs` is ignored and kept
 * only for signature compatibility). Throws `state lock busy: <file> (<reason>)` on timeout; always releases.
 */
export function withLock<T>(lockFile: string, fn: () => T, timeoutMs = 10_000, _staleMs?: number): T {
  void _staleMs;
  const deadline = Date.now() + timeoutMs;
  let got = tryLock(lockFile);
  while ("busy" in got) {
    if (Date.now() > deadline) throw new Error(`state lock busy: ${lockFile} (${got.busy})`);
    sleepSync(25);
    got = tryLock(lockFile);
  }
  try {
    return fn();
  } finally {
    got.release();
  }
}

/** True if `child` (resolved, symlinks followed where they exist) lies inside `root`. */
export function isInside(root: string, child: string): boolean {
  const real = (p: string): string => {
    let cur = path.resolve(p);
    const tail: string[] = [];
    while (!fs.existsSync(cur)) {
      const parent = path.dirname(cur);
      if (parent === cur) break;
      tail.unshift(path.basename(cur));
      cur = parent;
    }
    const base = fs.existsSync(cur) ? fs.realpathSync.native(cur) : cur;
    return path.join(base, ...tail);
  };
  const r = real(root);
  const c = real(child);
  const rel = path.relative(r, c);
  const same = process.platform === "win32" ? r.toLowerCase() === c.toLowerCase() : r === c;
  return same || (!!rel && !rel.startsWith("..") && !path.isAbsolute(rel));
}
