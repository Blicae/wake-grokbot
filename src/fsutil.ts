import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
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

/** Cross-process lock via an exclusive lock file. Stale locks (older than staleMs) are broken. */
export function withLock<T>(lockFile: string, fn: () => T, timeoutMs = 10_000, staleMs = 120_000): T {
  fs.mkdirSync(path.dirname(lockFile), { recursive: true });
  const token = randomUUID();
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      fs.writeFileSync(lockFile, `${token} ${process.pid}\n`, { flag: "wx" });
      break;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
      try {
        const age = Date.now() - fs.statSync(lockFile).mtimeMs;
        if (age > staleMs) {
          fs.rmSync(lockFile, { force: true });
          continue;
        }
      } catch {
        continue;
      }
      if (Date.now() > deadline) throw new Error(`state lock busy: ${lockFile}`);
      sleepSync(25);
    }
  }
  try {
    return fn();
  } finally {
    try {
      if (fs.readFileSync(lockFile, "utf8").startsWith(token)) fs.rmSync(lockFile, { force: true });
    } catch {
      /* already gone */
    }
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
