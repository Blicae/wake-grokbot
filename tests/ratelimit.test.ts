import * as fs from "node:fs";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { parseRetryAfter } from "../src/net.js";
import { grokCfg, KEY, sandbox, stub, task } from "./helpers.js";

type Reply = Parameters<typeof stub>[0];

async function sendOnce(reply: Reply) {
  const srv = await stub(reply);
  const s = sandbox(grokCfg(), { WAKE_GROKBOT_URL: srv.url, WAKE_GROKBOT_KEY: KEY });
  const before = Date.now();
  const r = await s.run(["send", "--json", "--json"], JSON.stringify(task()));
  const after = Date.now();
  const ts = JSON.parse(fs.readFileSync(path.join(s.state, "outbox.json"), "utf8")).targets.grokbot;
  return { srv, s, r, wait: { min: Date.parse(ts.next_at) - after, max: Date.parse(ts.next_at) - before }, ts };
}

const MIN = 60_000;

describe("rate limits (HTTP 429, or 400 with a rate-limit message)", () => {
  it("429 + Retry-After seconds: waits exactly that long", async () => {
    const { r, wait, srv } = await sendOnce(() => ({ status: 429, headers: { "retry-after": "120" } }));
    expect(r.code).toBe(5);
    expect(r.json().wake.state).toBe("not_started");
    expect(r.json().wake.detail).toContain("rate limited (HTTP 429)");
    expect(wait.min).toBeLessThanOrEqual(120_000);
    expect(wait.max).toBeGreaterThanOrEqual(120_000);
    expect(srv.hits).toHaveLength(1);
  });
  it("429 + Retry-After HTTP date: waits until that date", async () => {
    const at = new Date(Math.ceil(Date.now() / 1000) * 1000 + 45 * MIN);
    const { ts } = await sendOnce(() => ({ status: 429, headers: { "retry-after": at.toUTCString() } }));
    expect(Math.abs(Date.parse(ts.next_at) - at.getTime())).toBeLessThan(2000);
  });
  it("429 without Retry-After: backs off from 15 minutes, then 30", async () => {
    const { wait, s, srv } = await sendOnce(() => ({ status: 429 }));
    expect(wait.min).toBeLessThanOrEqual(15 * MIN);
    expect(wait.max).toBeGreaterThanOrEqual(15 * MIN);
    await s.run(["watch", "--once"]);
    expect(srv.hits).toHaveLength(1); // still backing off
    const ob = JSON.parse(fs.readFileSync(path.join(s.state, "outbox.json"), "utf8"));
    ob.targets.grokbot.next_at = new Date(Date.now() - 1000).toISOString();
    fs.writeFileSync(path.join(s.state, "outbox.json"), JSON.stringify(ob));
    const before = Date.now();
    await s.run(["watch", "--once"]);
    expect(srv.hits).toHaveLength(2);
    const next = Date.parse(JSON.parse(fs.readFileSync(path.join(s.state, "outbox.json"), "utf8")).targets.grokbot.next_at);
    expect(next - before).toBeGreaterThanOrEqual(30 * MIN - 1000);
    expect(next - before).toBeLessThanOrEqual(30 * MIN + 5000);
  });
  it("400 whose body says rate limit: treated as a rate limit", async () => {
    const { r, wait } = await sendOnce(() => ({ status: 400, body: JSON.stringify({ error: "Rate limit exceeded, try again later" }) }));
    expect(r.code).toBe(5);
    expect(r.json().wake.detail).toContain("rate limited (HTTP 400)");
    expect(wait.min).toBeLessThanOrEqual(15 * MIN);
    expect(wait.max).toBeGreaterThanOrEqual(15 * MIN);
  });
  it("400 'Too Many Requests' with Retry-After: follows Retry-After", async () => {
    const { wait } = await sendOnce(() => ({ status: 400, headers: { "retry-after": "300" }, body: "Too Many Requests" }));
    expect(wait.min).toBeLessThanOrEqual(5 * MIN);
    expect(wait.max).toBeGreaterThanOrEqual(5 * MIN);
  });
  it("plain 400 is an ordinary 4xx: 1 minute backoff, Retry-After ignored, body not echoed", async () => {
    const { r, wait } = await sendOnce(() => ({ status: 400, headers: { "retry-after": "900" }, body: JSON.stringify({ error: "invalid payload field" }) }));
    expect(r.code).toBe(5);
    const d = r.json().wake.detail as string;
    expect(d).not.toContain("rate limited");
    expect(d).not.toContain("invalid payload");
    expect(wait.min).toBeLessThanOrEqual(1 * MIN);
    expect(wait.max).toBeGreaterThanOrEqual(1 * MIN);
  });
  it("parseRetryAfter: seconds, HTTP date, past date, garbage", () => {
    const now = Date.parse("2026-11-05T00:00:00Z");
    expect(parseRetryAfter("0", now)).toBe(0);
    expect(parseRetryAfter(" 90 ", now)).toBe(90_000);
    expect(parseRetryAfter("Thu, 05 Nov 2026 00:10:00 GMT", now)).toBe(10 * MIN);
    expect(parseRetryAfter("Wed, 04 Nov 2026 00:00:00 GMT", now)).toBe(0);
    expect(parseRetryAfter("soon", now)).toBeUndefined();
    expect(parseRetryAfter("-5", now)).toBeUndefined();
    expect(parseRetryAfter(undefined, now)).toBeUndefined();
  });
});
