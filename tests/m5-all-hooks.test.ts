/** M5 across every test hook (core, sinks, fsutil): none reachable from the package root, CLI, env or config. */
import * as fs from "node:fs";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import * as root from "../src/index.js";

const SRC = path.join(import.meta.dirname, "..", "src");
const files = (d: string): string[] =>
  fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? files(path.join(d, e.name)) : e.name.endsWith(".ts") ? [path.join(d, e.name)] : []));
const all = files(SRC).map((f) => ({ f: path.relative(SRC, f), s: fs.readFileSync(f, "utf8") }));
const HOOKS = ["_lockTestHooks", "_testHooks", "_setCoreTestHooks", "coreTestHooks"];

describe("M5: all test hooks stay test-only", () => {
  it("every hook found in src is in the audited list (a new hook must be added here)", () => {
    const found = new Set(all.flatMap(({ s }) => [...s.matchAll(/export (?:const|function) (_\w+|\w*TestHooks\w*)/g)].map((m) => m[1])));
    expect([...found].sort()).toEqual(["_lockTestHooks", "_setCoreTestHooks", "_testHooks", "coreTestHooks"]);
  });
  it("package root exports no hook and no underscore name; index.ts re-exports neither fsutil nor testhooks nor a sinks hook", () => {
    const keys = Object.keys(root);
    for (const h of HOOKS) expect(keys).not.toContain(h);
    expect(keys.filter((k) => k.startsWith("_"))).toEqual([]);
    const idx = fs.readFileSync(path.join(SRC, "index.ts"), "utf8");
    expect(idx).not.toMatch(/fsutil|testhooks|_testHooks|_lockTestHooks|export \*/);
  });
  it("no src file assigns a hook; hooks are only read where defined/used (no CLI flag, env var or config key sets one)", () => {
    for (const { f, s } of all) {
      expect([f, /(_lockTestHooks|_testHooks)\.\w+\s*=[^=]/.test(s)]).toEqual([f, false]);
      expect([f, /_setCoreTestHooks\(/.test(s) && f !== "testhooks.ts"]).toEqual([f, false]);
      if (/TestHooks|_testHooks/.test(s)) expect([f, /process\.env|argv|cfg\.|config\./.test(s.split("\n").filter((l) => /TestHooks|_testHooks/.test(l)).join("\n"))]).toEqual([f, false]);
    }
  });
  it("built package entry (dist) does not expose hooks when present", () => {
    const dist = path.join(SRC, "..", "dist", "index.js");
    if (!fs.existsSync(dist)) return;
    expect(fs.readFileSync(dist, "utf8")).not.toMatch(/TestHooks|_testHooks|fsutil|testhooks/);
  });
});
