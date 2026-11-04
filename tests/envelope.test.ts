import * as fs from "node:fs";
import * as path from "node:path";
import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import { describe, expect, it } from "vitest";
import { canonical, contentHash, type Envelope, sign, validate, verify } from "../src/envelope.js";
import { fixture } from "./helpers.js";

const root = path.join(import.meta.dirname, "..");
const schema = JSON.parse(fs.readFileSync(path.join(root, "schema", "wake-envelope-1.schema.json"), "utf8"));
const ajv = new Ajv2020.default({ allErrors: true, strict: false });
addFormats.default(ajv);
const check = ajv.compile(schema);
const good = fs.readdirSync(path.join(root, "fixtures")).filter((f) => f.endsWith(".json"));
const bad = fs.readdirSync(path.join(root, "fixtures", "invalid"));

describe("fixtures vs schema and validator", () => {
  it("has fixtures", () => {
    expect(good.length).toBeGreaterThanOrEqual(6);
    expect(bad.length).toBeGreaterThanOrEqual(5);
  });
  for (const f of good)
    it(`valid: ${f}`, () => {
      const e = fixture(f);
      expect(check(e), JSON.stringify(check.errors)).toBe(true);
      expect(validate(e)).toEqual([]);
    });
  for (const f of bad)
    it(`invalid: ${f}`, () => {
      const e = fixture(`invalid/${f}`);
      expect(validate(e).length).toBeGreaterThan(0);
      if (f !== "url-in-body.json") expect(check(e)).toBe(false); // the URL rule is a content rule, not schema
    });
});

describe("content rules", () => {
  it("rejects secret-looking text", () => {
    expect(validate({ ...fixture("note.json"), body: "Authorization: Bearer abcdefghijkl" }).join()).toMatch(/secret/);
    expect(validate({ ...fixture("note.json"), body: "token ghp_abcdefghijklmnop" }).join()).toMatch(/secret/);
  });
  it("rejects URLs anywhere", () => {
    expect(validate({ ...fixture("note.json"), title: "ftp://x.example.invalid" }).join()).toMatch(/URL/);
  });
  it("url_ref must be a name, not a URL", () => {
    expect(validate({ ...fixture("task-webhook.json"), reply_to: { sink: "webhook", url_ref: "a/b" } }).join()).toMatch(/config name/);
  });
  it("receipt needs status", () => {
    const e = fixture("receipt-done.json");
    delete e.status;
    expect(validate(e).join()).toMatch(/needs status/);
  });
});

describe("canonical form and signatures", () => {
  const e = fixture("task.json") as Envelope;
  const key = Buffer.from("signing-key-for-tests-only");
  it("is key-order independent and ignores sig", () => {
    const shuffled = Object.fromEntries(Object.entries(e).reverse()) as unknown as Envelope;
    expect(canonical(shuffled)).toBe(canonical(e));
    expect(contentHash({ ...e, sig: "hmac-sha256:" + "0".repeat(64) })).toBe(contentHash(e));
  });
  it("verifies ok / wrong / malformed / missing", () => {
    const s = { ...e, sig: sign(e, key) };
    expect(verify(s, key)).toBe("ok");
    expect(verify({ ...s, title: "changed" }, key)).toBe("wrong");
    expect(verify(s, Buffer.from("another-key-entirely"))).toBe("wrong");
    expect(verify({ ...e, sig: "hmac-sha256:zz" }, key)).toBe("malformed");
    expect(verify(e, key)).toBe("missing");
  });
});
