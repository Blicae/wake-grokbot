import * as os from "node:os";
import * as path from "node:path";

export const PROG = "wake-grokbot";
export const ENV = {
  CONFIG: "WAKE_GROKBOT_CONFIG",
  INBOX: "WAKE_GROKBOT_INBOX",
  STATE: "WAKE_GROKBOT_STATE",
  DISABLED: "WAKE_GROKBOT_DISABLED",
  KEY: "WAKE_GROKBOT_KEY",
} as const;

type Env = NodeJS.ProcessEnv;

export function configDir(env: Env = process.env): string {
  if (process.platform === "win32" && env.APPDATA) return path.join(env.APPDATA, PROG);
  if (process.platform === "darwin" && !env.XDG_CONFIG_HOME) return path.join(os.homedir(), "Library", "Application Support", PROG);
  return path.join(env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config"), PROG);
}

export function stateDir(env: Env = process.env): string {
  if (env[ENV.STATE]) return path.resolve(env[ENV.STATE]!);
  if (process.platform === "win32" && env.LOCALAPPDATA) return path.join(env.LOCALAPPDATA, PROG, "state");
  if (process.platform === "darwin" && !env.XDG_STATE_HOME) return path.join(os.homedir(), "Library", "Application Support", PROG, "state");
  return path.join(env.XDG_STATE_HOME || path.join(os.homedir(), ".local", "state"), PROG);
}

export function dataDir(env: Env = process.env): string {
  if (process.platform === "win32" && env.LOCALAPPDATA) return path.join(env.LOCALAPPDATA, PROG);
  if (process.platform === "darwin" && !env.XDG_DATA_HOME) return path.join(os.homedir(), "Library", "Application Support", PROG);
  return path.join(env.XDG_DATA_HOME || path.join(os.homedir(), ".local", "share"), PROG);
}

export function configPath(explicit?: string, env: Env = process.env): string {
  if (explicit) return path.resolve(explicit);
  if (env[ENV.CONFIG]) return path.resolve(env[ENV.CONFIG]!);
  return path.join(configDir(env), `${PROG}.json`);
}
