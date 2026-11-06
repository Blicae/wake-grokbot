import * as fs from "node:fs";
import * as path from "node:path";
import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import { describe, expect, it } from "vitest";
import { validate } from "../src/envelope.js";
import { task } from "./helpers.js";

const ajv = new Ajv2020.default({ allErrors: true, strict: false });
addFormats.default(ajv);
const schemaOk = ajv.compile(JSON.parse(fs.readFileSync(path.join(import.meta.dirname, "..", "schema", "wake-envelope-1.schema.json"), "utf8")));

describe("task object: runtime matches schema additionalProperties:false", () => {
  const cases: [string, unknown, boolean][] = [
    ["empty task", {}, true],
    ["task.ref with ticket_id", { ref: { ticket_id: "T-1" } }, true],
    ["task.ref with both", { ref: { ticket_id: "T-1", card_path: "cards/T-1.md" } }, true],
    ["extra key in task", { foo: "x" }, false],
    ["extra key next to ref", { ref: { ticket_id: "T-1" }, foo: "x" }, false],
    ["extra key in task.ref (already rejected)", { ref: { x: "y" } }, false],
  ];
  for (const [name, t, ok] of cases)
    it(name, () => {
      const e = task({ task: t });
      expect(schemaOk(e)).toBe(ok);
      expect(validate(e).length === 0).toBe(ok);
    });
  it("names the unknown task field", () => {
    expect(validate(task({ task: { foo: "x" } }))).toContain("unknown field: task.foo");
  });
});
