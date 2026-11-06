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
export const _lockTestHooks: { reclaim?: (phase: "checked") => void } = {};

function readText(file: string): string | undefined {
  try {
    return fs.readFileSync(file, "utf8");
  } catch {
    return undefined;
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

/** Take `<lock>.reclaim` (exclusive create), waiting at most `waitMs`. Returns its release, or undefined. */
function takeReclaim(lockFile: string, me: LockOwner, waitMs: number): (() => void) | undefined {
  const reclaim = `${lockFile}.reclaim`;
  const deadline = Date.now() + waitMs;
  for (;;) {
    try {
      fs.writeFileSync(reclaim, JSON.stringify(me) + "\n", { flag: "wx" });
      return () => {
        if (parseOwner(readText(reclaim))?.token === me.token) fs.rmSync(reclaim, { force: true });
      };
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
    }
    if (Date.now() >= deadline) return undefined;
    sleepSync(5);
  }
}

/**
 * One attempt at a cross-process lock file. Never steals by age. A lock is removed only by its owner or by a
 * reclaimer holding `<lock>.reclaim` that re-read the token of a provably dead owner, so a live lock is never
 * moved or removed. Unknown/legacy, other-host, live or own-pid locks: busy, with a manual-recovery hint.
 */
export function tryLock(lockFile: string): { release: () => void } | { busy: string } {
  fs.mkdirSync(path.dirname(lockFile), { recursive: true });
  const me: LockOwner = { format: LOCK_FORMAT, host: os.hostname(), pid: process.pid, started_at: processStart(), token: randomUUID() };
  const name = path.basename(lockFile);
  const manual = `retryable; if no wake-grokbot process holds it, remove ${name} manually`;
  for (let i = 0; i < 3; i++) {
    try {
      fs.writeFileSync(lockFile, JSON.stringify(me) + "\n", { flag: "wx" });
      return {
        release: () => {
          // same protocol as a reclaimer: verify our token under the reclaim mutex, then delete
          const done = takeReclaim(lockFile, me, 2000);
          if (!done) return; // left in place; reclaimable once this process has exited
          try {
            if (parseOwner(readText(lockFile))?.token === me.token) fs.rmSync(lockFile, { force: true });
          } finally {
            done();
          }
        },
      };
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
    }
    const text = readText(lockFile);
    if (text === undefined) continue; // released meanwhile
    const o = parseOwner(text);
    if (!o) return { busy: `lock is unreadable or in an old format; ${manual}` };
    const g = ownerGone(o);
    if (!g.gone) return { busy: `locked (${g.why}); ${manual}` };
    _lockTestHooks.reclaim?.("checked");
    const done = takeReclaim(lockFile, me, 0);
    if (!done) return { busy: `lock is being reclaimed (${name}.reclaim); ${manual} and ${name}.reclaim` };
    try {
      const again = parseOwner(readText(lockFile));
      if (again && again.token === o.token) fs.rmSync(lockFile, { force: true });
      else if (again || readText(lockFile) !== undefined) return { busy: `locked by a new owner; ${manual}` };
    } finally {
      done();
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
