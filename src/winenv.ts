/**
 * Windows: an environment variable set with [Environment]::SetEnvironmentVariable(..., 'User'|'Machine')
 * is not visible to terminals opened before the change. When a variable we need is missing from the
 * process, read it from HKCU\Environment, then HKLM\...\Session Manager\Environment with `reg query`
 * (execFileSync, no shell). Values are never logged. Other platforms: process environment only.
 */
import { execFileSync } from "node:child_process";
import { registerSecret } from "./secrets.js";

export type EnvSource = "process" | "user" | "machine" | "missing";
export type RegistryReader = (scope: "user" | "machine", name: string) => string | undefined;

const KEYS = {
  user: "HKCU\\Environment",
  machine: "HKLM\\SYSTEM\\CurrentControlSet\\Control\\Session Manager\\Environment",
} as const;

const NAME_RE = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/;

/** Parse `reg query <key> /v <name>` output. REG_EXPAND_SZ values get %VAR% expanded from `env`. */
export function parseRegQuery(out: string, name: string, env: NodeJS.ProcessEnv = process.env): string | undefined {
  for (const line of out.split(/\r?\n/)) {
    const m = /^\s+(\S+)\s+(REG_SZ|REG_EXPAND_SZ)\s+(.*)$/.exec(line);
    if (!m || m[1]!.toLowerCase() !== name.toLowerCase()) continue;
    const v = m[3]!.trimEnd();
    return m[2] === "REG_EXPAND_SZ" ? v.replace(/%([^%]+)%/g, (all, k: string) => env[k] ?? all) : v;
  }
  return undefined;
}

const defaultReader: RegistryReader = (scope, name) => {
  if (process.platform !== "win32") return undefined;
  try {
    const out = execFileSync("reg.exe", ["query", KEYS[scope], "/v", name], {
      encoding: "utf8",
      windowsHide: true,
      timeout: 5000,
      stdio: ["ignore", "pipe", "ignore"],
    });
    return parseRegQuery(out, name);
  } catch {
    return undefined; // not set (reg exits 1) or reg unavailable
  }
};

let reader: RegistryReader = defaultReader;

/** For tests: replace the registry reader (null restores the default). */
export function setRegistryReader(r: RegistryReader | null): void {
  reader = r ?? defaultReader;
}

const SECRET_NAME = /(KEY|SECRET|TOKEN|URL|PASSWORD)$/i;

/** Fill in missing variables from the registry. Returns a new env and where each name came from. */
export function resolveEnv(env: NodeJS.ProcessEnv, names: Iterable<string>): { env: NodeJS.ProcessEnv; sources: Record<string, EnvSource> } {
  const out: NodeJS.ProcessEnv = { ...env };
  const sources: Record<string, EnvSource> = {};
  for (const name of names) {
    if (!name || !NAME_RE.test(name) || name in sources) continue;
    if (out[name]) {
      sources[name] = "process";
      continue;
    }
    let src: EnvSource = "missing";
    for (const scope of ["user", "machine"] as const) {
      const v = reader(scope, name);
      if (v) {
        out[name] = v;
        if (SECRET_NAME.test(name)) registerSecret(v);
        src = scope;
        break;
      }
    }
    sources[name] = src;
  }
  return { env: out, sources };
}
