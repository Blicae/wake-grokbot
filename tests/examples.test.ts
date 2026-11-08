import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { sandbox } from "./helpers.js";

const root = path.join(import.meta.dirname, "..");

describe("Claude Code hook example", () => {
  it("settings.json is valid JSON and points at the hook script", () => {
    const j = JSON.parse(fs.readFileSync(path.join(root, "examples", "claude-code", "settings.json"), "utf8"));
    expect(JSON.stringify(j.hooks.Stop)).toContain("stop-hook.mjs");
    expect(JSON.stringify(j.hooks.SubagentStop)).toContain("stop-hook.mjs");
  });
  it("stop-hook.mjs turns a Stop event into one note for the dispatcher and never fails the session", () => {
    const s = sandbox();
    const fake = path.join(s.dir, "fake-cli.mjs");
    const got = path.join(s.dir, "got.json");
    fs.writeFileSync(fake, `import fs from "node:fs"; fs.writeFileSync(${JSON.stringify(got)}, JSON.stringify(process.argv.slice(2))); process.exit(5);`);
    const r = spawnSync(process.execPath, [path.join(root, "examples", "claude-code", "stop-hook.mjs")], {
      input: JSON.stringify({ hook_event_name: "Stop", session_id: "abc-123", cwd: "/work/project-x", stop_hook_active: false }),
      env: { ...s.env, WAKE_GROKBOT_HOOK_CLI: `${process.execPath}|${fake}` },
      encoding: "utf8",
    });
    expect(r.status).toBe(0);
    const args: string[] = JSON.parse(fs.readFileSync(got, "utf8"));
    expect(args).toEqual(expect.arrayContaining(["send", "--type", "note", "--to", "dispatcher", "--from", "claude-code"]));
    expect(args.join(" ")).toContain("project-x");
  });
  it("does nothing on a repeated stop (stop_hook_active) or when disabled", () => {
    const s = sandbox();
    const got = path.join(s.dir, "got.json");
    const fake = path.join(s.dir, "fake-cli.mjs");
    fs.writeFileSync(fake, `import fs from "node:fs"; fs.writeFileSync(${JSON.stringify(got)}, "x");`);
    for (const [input, extra] of [
      [{ hook_event_name: "Stop", stop_hook_active: true }, {}],
      [{ hook_event_name: "Stop" }, { WAKE_GROKBOT_DISABLED: "1" }],
    ] as const) {
      const r = spawnSync(process.execPath, [path.join(root, "examples", "claude-code", "stop-hook.mjs")], {
        input: JSON.stringify(input),
        env: { ...s.env, ...extra, WAKE_GROKBOT_HOOK_CLI: `${process.execPath}|${fake}` },
        encoding: "utf8",
      });
      expect(r.status).toBe(0);
    }
    expect(fs.existsSync(got)).toBe(false);
  });
});


describe("local demo", () => {
  it("follows getting-started commands in a clean directory: send -> reply -> receipt -> done", () => {
    const s = sandbox();
    const build = spawnSync(process.execPath, [path.join(root, "node_modules/typescript/bin/tsc"), "-p", "tsconfig.build.json"], { cwd: root, encoding: "utf8" });
    expect(build.status, build.stderr || build.stdout).toBe(0);
    const script = path.join(root, "examples/local-demo/demo.mjs");
    // sandbox creates a config; the documented demo requires a fresh directory.
    const clean = path.join(s.dir, "clean"); fs.mkdirSync(clean);
    const demo = (action: string) => {
      const r = spawnSync(process.execPath, [script, action], { cwd: clean, env: s.env, encoding: "utf8" });
      expect(r.status, r.stderr || r.stdout).toBe(0); return r.stdout;
    };
    demo("init"); demo("send"); demo("reply");
    expect(demo("receive")).toContain("done: Greeting ready");
    expect(JSON.parse(demo("status")).status).toBe("done");
    expect(fs.readFileSync(path.join(clean, "reports/greeting.md"), "utf8")).toContain("Ready: Greeting ready");
    expect(fs.existsSync(path.join(clean, "reports/greeting.md.DONE"))).toBe(true);
    expect(fs.readFileSync(path.join(clean, "wake.log"), "utf8").trim().split("\n")).toHaveLength(2);
  }, 30_000);
});
