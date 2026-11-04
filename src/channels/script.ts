import { spawn } from "node:child_process";
import type { TargetConfig } from "../config.js";
import { ChannelConfigError } from "../net.js";
import { mask } from "../secrets.js";
import type { Channel, ChannelContext, WakeOutcome, WakePayload } from "./index.js";

export interface RunResult {
  code: number | null;
  timedOut: boolean;
  stdout: string;
  stderr: string;
  error?: string;
}

/** Run argv (no shell) with `input` on stdin. */
export function run(argv: string[], input: string, timeoutMs: number, env: NodeJS.ProcessEnv = process.env): Promise<RunResult> {
  return new Promise((resolve) => {
    const [cmd, ...args] = argv;
    let out = "";
    let err = "";
    let timedOut = false;
    let child;
    try {
      child = spawn(cmd!, args, { env, stdio: ["pipe", "pipe", "pipe"], windowsHide: true, shell: false });
    } catch (e) {
      resolve({ code: null, timedOut: false, stdout: "", stderr: "", error: (e as Error).message });
      return;
    }
    const t = setTimeout(() => {
      timedOut = true;
      child.kill();
    }, timeoutMs);
    child.stdout.on("data", (d: Buffer) => (out += d.toString()));
    child.stderr.on("data", (d: Buffer) => (err += d.toString()));
    child.on("error", (e) => {
      clearTimeout(t);
      resolve({ code: null, timedOut, stdout: out, stderr: err, error: e.message });
    });
    child.on("close", (code) => {
      clearTimeout(t);
      resolve({ code, timedOut, stdout: out, stderr: err });
    });
    child.stdin.on("error", () => undefined);
    child.stdin.end(input);
  });
}

/** Generic wake: run a configured command with the wake payload as JSON on stdin. Exit 0 = started. */
export class ScriptChannel implements Channel {
  constructor(
    readonly name: string,
    readonly cfg: TargetConfig,
  ) {}

  check(): void {
    if (!Array.isArray(this.cfg.argv) || this.cfg.argv.length === 0) throw new ChannelConfigError(`target ${this.name}: argv is required for the script channel`);
  }

  describe(): string {
    return `script ${(this.cfg.argv ?? [])[0] ?? "?"}`;
  }

  async wake(p: WakePayload, ctx: ChannelContext): Promise<WakeOutcome> {
    this.check();
    const r = await run(this.cfg.argv!, JSON.stringify(p) + "\n", ctx.timeoutMs, ctx.env);
    if (r.error) return { state: "not_started", detail: mask(`script could not start: ${r.error}`) };
    if (r.timedOut) return { state: "unknown", detail: "script timed out; outcome unknown" };
    if (r.code === 0) return { state: "started", detail: "script exit 0" };
    return { state: "not_started", detail: mask(`script exit ${r.code}${r.stderr.trim() ? ": " + r.stderr.trim().slice(-200) : ""}`) };
  }
}
