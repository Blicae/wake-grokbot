import * as fs from "node:fs";
import * as path from "node:path";
import { Readable } from "node:stream";
import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";
import { main } from "../src/main.js";
import { configCandidates } from "../src/paths.js";
import { sandbox } from "./helpers.js";

describe("config discovery order", () => {
  it("--config, then $WAKE_GROKBOT_CONFIG, then ./wake-grokbot.json, then the user folder", () => {
    const s = sandbox();
    const cwd = path.join(s.dir, "work");
    fs.mkdirSync(cwd);
    expect(configCandidates("x.json", s.env, cwd).paths).toEqual([path.join(cwd, "x.json")]);
    expect(configCandidates(undefined, { ...s.env, WAKE_GROKBOT_CONFIG: "/abs/c.json" }, cwd).paths).toEqual([path.resolve("/abs/c.json")]);
    const auto = configCandidates(undefined, s.env, cwd);
    expect(auto.explicit).toBe(false);
    expect(auto.paths[0]).toBe(path.join(cwd, "wake-grokbot.json"));
    expect(auto.paths[1]).toContain(path.join(s.dir, "home"));
  });
  it("picks ./wake-grokbot.json from the current folder before the user folder", () => {
    const s = sandbox();
    const cwd = path.join(s.dir, "work");
    fs.mkdirSync(cwd);
    fs.writeFileSync(path.join(cwd, "wake-grokbot.json"), JSON.stringify({ inbox: "here-inbox" }));
    const l = loadConfig({ env: s.env, cwd });
    expect(l.path).toBe(path.join(cwd, "wake-grokbot.json"));
    expect(l.inbox).toBe(path.join(cwd, "here-inbox"));
  });
  it("no config anywhere: defaults, and doctor names the searched paths", async () => {
    const s = sandbox();
    const empty = path.join(s.dir, "empty");
    fs.mkdirSync(empty);
    const l = loadConfig({ env: s.env, cwd: empty });
    expect(l.path).toBeNull();
    expect(l.searched).toHaveLength(2);
    let out = "";
    await main(["doctor"], { stdin: Readable.from([]), out: (x) => (out += x), err: () => {}, env: s.env });
    expect(out).toMatch(/config: none found; searched: /);
  });
});

describe("errors name the config", () => {
  it("missing explicit config lists the searched path", async () => {
    const s = sandbox();
    const r = await s.run(["--config", path.join(s.dir, "nope.json"), "status"]);
    expect(r.code).toBe(2);
    expect(r.err).toMatch(/config: none found; searched: .*nope\.json/);
  });
  it("unknown target says which config was loaded and lists known targets", async () => {
    const s = sandbox({ targets: { a: { channel: "script", argv: ["x"] } } });
    const r = await s.run(["release", "grokbot-test"]);
    expect(r.code).toBe(1);
    expect(r.err).toContain("unknown target grokbot-test");
    expect(r.err).toContain("known: a");
    expect(r.err).toContain(`config: ${s.cfgPath}`);
  });
  it("config validation errors name the file", async () => {
    const s = sandbox({ wake: { targets: { worker: "ghost" } } });
    const r = await s.run(["status"]);
    expect(r.code).toBe(2);
    expect(r.err).toContain(`config: ${s.cfgPath}`);
  });
  it("unknown ingest source names the file", async () => {
    const s = sandbox();
    const r = await s.run(["ingest", "--from", "nobody", "-"], "{}");
    expect(r.err).toContain(`config: ${s.cfgPath}`);
  });
});
