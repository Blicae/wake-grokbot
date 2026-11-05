import * as fs from "node:fs";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";
import { Engine } from "../src/core.js";
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
  it("Retry-After is capped at 24 hours (seconds and HTTP date)", () => {
    const now = Date.parse("2026-11-05T00:00:00Z");
    expect(parseRetryAfter(String(24 * 3600), now)).toBe(24 * 3600_000);
    expect(parseRetryAfter(String(3 * 24 * 3600), now)).toBe(24 * 3600_000);
    expect(parseRetryAfter("Sun, 08 Nov 2026 00:00:00 GMT", now)).toBe(24 * 3600_000);
  });
  it("429 with a huge Retry-After waits 24 hours", async () => {
    const { wait } = await sendOnce(() => ({ status: 429, headers: { "retry-after": "9999999" } }));
    expect(wait.min).toBeLessThanOrEqual(24 * 60 * MIN);
    expect(wait.max).toBeGreaterThanOrEqual(24 * 60 * MIN);
  });
});

const HOUR = 3600_000;

describe("rate limits and dead state", () => {
  async function at(s: Awaited<ReturnType<typeof sendOnce>>["s"], ms: number) {
    const l = loadConfig({ config: s.cfgPath, env: s.env });
    await new Engine(l, { env: s.env, now: () => ms }).pump();
    return JSON.parse(fs.readFileSync(path.join(s.state, "outbox.json"), "utf8")).targets.grokbot;
  }
  const receipt = (s: Awaited<ReturnType<typeof sendOnce>>["s"], id: string) => JSON.parse(fs.readFileSync(path.join(s.inbox, "receipts", `${id}.json`), "utf8"));

  it("rate limits for less than 24 hours: never dead, even past max_attempts; first time persisted", async () => {
    const t0 = Date.now();
    const { s, r, ts, srv } = await sendOnce(() => ({ status: 429 }));
    const id = r.json().id as string;
    expect(Date.parse(ts.rate_limited_since)).toBeGreaterThanOrEqual(t0 - 1000);
    let t = ts;
    // 4.5, 9 ... 22.5 hours (past the 240-minute backoff cap each time): 6 rate limits > max_attempts 5
    for (let i = 1; i <= 5; i++) t = await at(s, t0 + i * 4.5 * HOUR);
    expect(srv.hits).toHaveLength(6);
    expect(t.attempts).toBe(0);
    expect(t.rate_limit_count).toBe(6);
    expect(t.dead).toEqual([]);
    expect(t.queue).toContain(id);
    expect(receipt(s, id).wake.state).toBe("not_started");
  });
  it("rate limited for more than 24 hours since the first one: dead", async () => {
    const t0 = Date.now();
    const { s, r } = await sendOnce(() => ({ status: 429 }));
    const id = r.json().id as string;
    await at(s, t0 + 12 * HOUR);
    const t = await at(s, t0 + 24 * HOUR + 60_000);
    expect(t.dead).toHaveLength(1);
    expect(t.dead[0].ids).toEqual([id]);
    expect(t.queue).toEqual([]);
    expect(t.rate_limited_since).toBeNull();
    expect(receipt(s, id).wake.state).toBe("dead");
    expect(receipt(s, id).wake.detail).toContain("24 hours of rate limits");
  });
  it("a non-rate-limit result in between restarts the 24-hour clock", async () => {
    const t0 = Date.now();
    const { s, r } = await sendOnce((_, n) => ({ status: n === 2 ? 403 : 429 }));
    const id = r.json().id as string;
    let t = await at(s, t0 + 20 * HOUR); // 403: ordinary 4xx, clock reset, attempts 1
    expect(t.rate_limited_since).toBeNull();
    expect(t.attempts).toBe(1);
    t = await at(s, t0 + 22 * HOUR); // 429 again: new run starts here
    expect(Date.parse(t.rate_limited_since)).toBe(t0 + 22 * HOUR);
    t = await at(s, t0 + 30 * HOUR); // 30h after the first, but only 8h into this run
    expect(t.dead).toEqual([]);
    t = await at(s, t0 + 46 * HOUR + 60_000); // > 24h into this run
    expect(t.dead).toHaveLength(1);
    expect(receipt(s, id).wake.state).toBe("dead");
  });
  it("ordinary 4xx still gives up after max_attempts", async () => {
    const t0 = Date.now();
    const { s, r, srv } = await sendOnce(() => ({ status: 403 }));
    const id = r.json().id as string;
    let t;
    for (let i = 1; i <= 4; i++) t = await at(s, t0 + i * 2 * HOUR);
    expect(srv.hits).toHaveLength(5);
    expect(t.dead).toHaveLength(1);
    expect(receipt(s, id).wake.state).toBe("dead");
    expect(receipt(s, id).wake.detail).toContain("gave up after 5 attempts");
  });
});
