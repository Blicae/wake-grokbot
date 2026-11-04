import { describe, expect, it } from "vitest";
import { parseRegQuery, resolveEnv, setRegistryReader } from "../src/winenv.js";
import { grokCfg, KEY, sandbox, stub, task } from "./helpers.js";

const REG = "\r\nHKEY_CURRENT_USER\\Environment\r\n    WAKE_GROKBOT_TEST_KEY    REG_SZ    abc def\r\n\r\n";

describe("registry fallback (Windows user/machine environment)", () => {
  it("parses reg query output, including REG_EXPAND_SZ", () => {
    expect(parseRegQuery(REG, "wake_grokbot_test_key")).toBe("abc def");
    expect(parseRegQuery("    P    REG_EXPAND_SZ    %HOMEX%\\x\r\n", "P", { HOMEX: "C:\\h" })).toBe("C:\\h\\x");
    expect(parseRegQuery("ERROR: not found", "P")).toBeUndefined();
  });
  it("process wins, then user, then machine; reports the source, never the value", () => {
    setRegistryReader((scope, name) => (scope === "user" && name === "U" ? "from-user" : scope === "machine" && (name === "M" || name === "U") ? "from-machine" : undefined));
    const r = resolveEnv({ P: "p" }, ["P", "U", "M", "X", "bad name;"]);
    expect(r.sources).toEqual({ P: "process", U: "user", M: "machine", X: "missing" });
    expect(r.env.U).toBe("from-user");
    expect(r.env.M).toBe("from-machine");
  });
  it("a wake works when URL and key exist only in the user registry; doctor shows the source only", async () => {
    const srv = await stub();
    const reg: Record<string, string> = { WAKE_GROKBOT_TEST_URL: srv.url, WAKE_GROKBOT_TEST_KEY: KEY };
    setRegistryReader((scope, name) => (scope === "user" ? reg[name] : undefined));
    const s = sandbox(grokCfg({ target: { url_env: "WAKE_GROKBOT_TEST_URL", key_env: "WAKE_GROKBOT_TEST_KEY" } }));
    const d = await s.run(["doctor"]);
    expect(d.code).toBe(0);
    expect(d.out).toContain("env WAKE_GROKBOT_TEST_URL: found (user registry)");
    expect(d.out).toContain("env WAKE_GROKBOT_TEST_KEY: found (user registry)");
    expect(d.out).not.toContain(KEY);
    expect(d.out).not.toContain("127.0.0.1:");
    expect((await s.run(["send", "--json"], JSON.stringify(task()))).code).toBe(0);
    expect(srv.hits[0]!.headers.authorization).toBe(`Bearer ${KEY}`);
  });
  it("WAKE_GROKBOT_* variables (e.g. the kill switch) are picked up too", async () => {
    const srv = await stub();
    setRegistryReader((scope, name) => (scope === "machine" && name === "WAKE_GROKBOT_DISABLED" ? "1" : undefined));
    const s = sandbox(grokCfg(), { WAKE_GROKBOT_URL: srv.url, WAKE_GROKBOT_KEY: KEY });
    expect((await s.run(["send", "--json"], JSON.stringify(task()))).code).toBe(5);
    expect(srv.hits).toHaveLength(0);
  });
  it("missing everywhere: doctor says missing", async () => {
    const s = sandbox(grokCfg());
    const d = await s.run(["doctor"]);
    expect(d.out).toContain("env WAKE_GROKBOT_URL: missing");
  });
});
