import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { DEFAULTS, EXAMPLE_CONFIG, loadConfig, validateConfig, type Config } from "../src/config.js";
import { sandbox } from "./helpers.js";

const merged = (o: Record<string, any>) => ({ ...structuredClone(DEFAULTS), ...o }) as Config;

describe("config", () => {
  it("example config is valid", () => {
    const { $comment, ...c } = structuredClone(EXAMPLE_CONFIG);
    void $comment;
    expect(validateConfig(c as unknown as Config)).toEqual([]);
  });
  it("refuses secret keys and URL values", () => {
    expect(validateConfig(merged({ targets: { a: { channel: "grokbot", url: "x" } } })).join()).toMatch(/secrets and URLs never/);
    expect(validateConfig(merged({ targets: { a: { channel: "grokbot", token: "x" } } })).join()).toMatch(/secrets/);
    expect(validateConfig(merged({ inbox: "https://example.invalid/x" })).join()).toMatch(/URLs never/);
  });
  it("enforces hard rate caps", () => {
    expect(validateConfig(merged({ wake: { ...DEFAULTS.wake, hourly_cap: 301 } })).join()).toMatch(/<= 300/);
    expect(validateConfig(merged({ targets: { a: { channel: "grokbot", per_routine_hourly_cap: 201 } } })).join()).toMatch(/1\.\.200/);
  });
  it("wake targets must exist", () => {
    expect(validateConfig(merged({ wake: { ...DEFAULTS.wake, targets: { worker: "nope" } } })).join()).toMatch(/unknown target/);
  });
  it("resolves relative paths against the config file; env overrides inbox", async () => {
    const s = sandbox({ sinks: { report_roots: ["reports"] } });
    const l = loadConfig({ config: s.cfgPath, env: s.env });
    expect(l.inbox).toBe(path.join(s.dir, "inbox"));
    expect(l.cfg.sinks.report_roots).toEqual([path.join(s.dir, "reports")]);
    const l2 = loadConfig({ config: s.cfgPath, env: { ...s.env, WAKE_GROKBOT_INBOX: path.join(s.dir, "other") } });
    expect(l2.inbox).toBe(path.join(s.dir, "other"));
  });
  it("missing explicit config is a usage error (exit 2)", async () => {
    const s = sandbox();
    const r = await s.run(["--config", path.join(s.dir, "missing.json"), "status"]);
    expect(r.code).toBe(2);
  });
  it("bad JSON is a usage error", async () => {
    const s = sandbox();
    const fs = await import("node:fs");
    fs.writeFileSync(s.cfgPath, "{nope");
    expect((await s.run(["status"])).code).toBe(2);
  });
});
