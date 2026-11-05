import { describe, expect, it } from "vitest";
import { isExpired, validate } from "../src/envelope.js";
import { fixture, sandbox, task, uuid } from "./helpers.js";

const PAST = "2000-01-01T00:00:00Z";
const FUTURE = "2999-01-01T00:00:00Z";

describe("expires_at (optional replay/staleness window)", () => {
  it("validator accepts an ISO time and rejects anything else", () => {
    expect(validate(fixture("task-expires.json"))).toEqual([]);
    expect(validate(task({ expires_at: "tomorrow" })).join()).toMatch(/expires_at must be an ISO 8601 time/);
    expect(validate(task({ expires_at: 5 })).join()).toMatch(/expires_at/);
  });
  it("isExpired", () => {
    expect(isExpired({})).toBe(false);
    expect(isExpired({ expires_at: PAST })).toBe(true);
    expect(isExpired({ expires_at: FUTURE })).toBe(false);
    expect(isExpired({ expires_at: "2026-11-05T13:00:00Z" }, Date.parse("2026-11-05T13:00:01Z"))).toBe(true);
  });
  it("status <id> flags an unsettled expired envelope (text and --json), not a future one", async () => {
    const s = sandbox();
    const old = task({ expires_at: PAST });
    const fresh = task({ expires_at: FUTURE });
    expect((await s.run(["send", "--json"], JSON.stringify(old))).code).toBe(0);
    expect((await s.run(["send", "--json"], JSON.stringify(fresh))).code).toBe(0);
    const t = await s.run(["status", old.id]);
    expect(t.code).toBe(0);
    expect(t.out).toContain(`EXPIRED (expires_at ${PAST})`);
    const j = await s.run(["status", old.id, "--json"]);
    expect(j.json()).toMatchObject({ id: old.id, expired: true, expires_at: PAST });
    expect((await s.run(["status", fresh.id])).out).not.toContain("EXPIRED");
    expect((await s.run(["status", fresh.id, "--json"])).json().expired).toBeUndefined();
  });
  it("a settled envelope is not flagged even when expired", async () => {
    const s = sandbox();
    const e = task({ expires_at: PAST });
    await s.run(["send", "--json"], JSON.stringify(e));
    await s.run(["reply", e.id, "--status", "done", "--summary", "ok"]);
    expect((await s.run(["status", e.id])).out).not.toContain("EXPIRED");
    expect((await s.run(["status"])).out).not.toContain("expired:");
  });
  it("status overview and watch --once list expired envelopes", async () => {
    const s = sandbox();
    const e = task({ expires_at: PAST });
    await s.run(["send", "--json"], JSON.stringify(e));
    await s.run(["send", "--json"], JSON.stringify(task({ id: uuid() })));
    const o = await s.run(["status"]);
    expect(o.out).toContain(`expired: ${e.id} (expires_at ${PAST}, status queued)`);
    expect((await s.run(["status", "--json"])).json().expired).toEqual([{ id: e.id, expires_at: PAST, status: "queued" }]);
    const w = await s.run(["watch", "--once"]);
    expect(w.code).toBe(0);
    expect(w.out).toMatch(new RegExp(`expired: ${e.id} \\(expires_at ${PAST}, status queued\\)`));
  });
});
