import * as fs from "node:fs";
import * as path from "node:path";
import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import { describe, expect, it } from "vitest";
import { EXAMPLE_CONFIG } from "../src/config.js";
import { validate } from "../src/envelope.js";
import { sandbox, task } from "./helpers.js";

const ROOT = path.join(import.meta.dirname, "..");
const ajv = new Ajv2020.default({ allErrors: true, strict: false });
addFormats.default(ajv);
const schemaOk = ajv.compile(JSON.parse(fs.readFileSync(path.join(ROOT, "schema", "wake-envelope-1.schema.json"), "utf8")));

describe("date-time: runtime matches schema (RFC 3339)", () => {
  const cases = ["2026-11-05T01:00:00Z", "2026-11-05T01:00:00.123+08:00", "2026-11-05", "2026-11-05 01:00:00Z", "Nov 5 2026", "2026-11-05T01:00:00"];
  for (const v of cases)
    for (const k of ["sent_at", "quoted_at", "expires_at"])
      it(`${k}=${v}`, () => {
        const e = task({ [k]: v });
        expect(validate(e).length === 0, `${k}=${v}`).toBe(schemaOk(e));
      });
});

describe("example config", () => {
  it("has no example webhook whose env vars make doctor warn", async () => {
    expect(Object.keys(EXAMPLE_CONFIG.sinks.webhooks)).toEqual([]);
    const s = sandbox();
    const cfg = path.join(s.dir, "cfg.json");
    expect((await s.run(["--config", cfg, "init"])).code).toBe(0);
    const out = (await s.run(["--config", cfg, "doctor"])).out;
    expect(out).not.toMatch(/MY_HOOK/);
  });
});

describe("install docs and scripts pin a version and an explicit config", () => {
  const files = ["README.md", "README.zh-CN.md", "BOOTSTRAP.md", "examples/watch.sh", "examples/install-watch-task.ps1"];
  for (const f of files)
    it(f, () => {
      const text = fs.readFileSync(path.join(ROOT, f), "utf8");
      expect(text).not.toMatch(/npx (--yes )?wake-grokbot(?!@)/);
      expect(text).not.toMatch(/install -g wake-grokbot(?!@)/);
      expect(text).not.toMatch(/"--yes wake-grokbot /);
    });
  it("scheduled scripts pass --config", () => {
    for (const f of ["examples/watch.sh", "examples/install-watch-task.ps1"]) expect(fs.readFileSync(path.join(ROOT, f), "utf8")).toMatch(/--config/);
  });
});
