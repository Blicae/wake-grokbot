import { describe, expect, it } from "vitest";
import { mask, normalizeKey, registerSecret } from "../src/secrets.js";

describe("secrets", () => {
  it("strips pasted Authorization/Bearer prefixes and quotes", () => {
    expect(normalizeKey("Authorization: Bearer abc123\n")).toBe("abc123");
    expect(normalizeKey("Bearer abc123")).toBe("abc123");
    expect(normalizeKey('"abc123"')).toBe("abc123");
    expect(normalizeKey("  abc123  ")).toBe("abc123");
  });
  it("masks registered secrets, bearer tokens and URLs", () => {
    registerSecret("supersecretvalue42");
    const m = mask("failed with supersecretvalue42 at https://hooks.example.invalid/x?token=abc and Bearer zzzzzzzzzz");
    expect(m).not.toContain("supersecretvalue42");
    expect(m).not.toContain("hooks.example.invalid");
    expect(m).not.toContain("zzzzzzzzzz");
  });
});
