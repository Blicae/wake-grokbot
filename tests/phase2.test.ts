import * as fs from "node:fs";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { grokCfg, KEY, sandbox, stub, task, uuid } from "./helpers.js";

async function setup(reply?: Parameters<typeof stub>[0], extra: Record<string, any> = {}) {
  const srv = await stub(reply);
  const s = sandbox(grokCfg(extra), { WAKE_GROKBOT_URL: srv.url, WAKE_GROKBOT_KEY: KEY });
  return { srv, s };
}

describe("release (the woken run reports it is finished)", () => {
  it("frees the slot and sends what queued meanwhile as one wake", async () => {
    const { srv, s } = await setup();
    const a = task();
    const b = task();
    const c = task();
    for (const e of [a, b, c]) await s.run(["send", "--json"], JSON.stringify(e));
    expect(srv.hits).toHaveLength(1);
    const r = await s.run(["release", "grokbot", "--json"]);
    expect(r.code).toBe(0);
    expect(r.json().released).toEqual(["grokbot"]);
    expect(srv.hits).toHaveLength(2);
    expect(JSON.parse(srv.hits[1]!.body).wake.ids).toEqual([b.id, c.id]);
    expect((await s.run(["release"])).out).toMatch(/released: grokbot/);
    expect((await s.run(["release"])).out).toMatch(/nothing was in flight/);
    expect((await s.run(["release", "nope"])).code).toBe(1);
  });
  it("an unknown wake that the run reports on becomes started", async () => {
    const { s } = await setup(() => ({ status: 503 }));
    const e = task();
    expect((await s.run(["send", "--json"], JSON.stringify(e))).code).toBe(6);
    await s.run(["release", "grokbot"]);
    expect((await s.run(["status", e.id, "--json"])).json().wake.state).toBe("started");
  });
});

describe("structured log", () => {
  it("wake.log is JSON lines with masked content", async () => {
    const { s } = await setup();
    await s.run(["send", "--json"], JSON.stringify(task()));
    const lines = fs.readFileSync(path.join(s.state, "wake.log"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
    expect(lines[0]).toMatchObject({ event: "wake", target: "grokbot", state: "started" });
    expect(JSON.stringify(lines)).not.toContain(KEY);
    expect(JSON.stringify(lines)).not.toContain("127.0.0.1");
  });
});

describe("doctor --dry-run", () => {
  it("shows the request body with URL and key hidden, and sends nothing", async () => {
    const { srv, s } = await setup(undefined, { target: { description: "test routine", capabilities: ["code", "review"] } });
    const r = await s.run(["doctor", "--dry-run"]);
    expect(r.code).toBe(0);
    expect(r.out).toMatch(/would send \(nothing sent\)/);
    expect(r.out).toMatch(/Bearer \*\*\*/);
    expect(r.out).toMatch(/test routine \[code, review\]/);
    expect(r.out).not.toContain(KEY);
    expect(r.out).not.toContain("127.0.0.1:");
    expect(srv.hits).toHaveLength(0);
  });
});

describe("prune (retention)", () => {
  it("lists, then deletes, only settled read items older than N days", async () => {
    const s = sandbox();
    const done = task();
    const open = task();
    const unread = task();
    for (const e of [done, open, unread]) await s.run(["send", "--json"], JSON.stringify(e));
    await s.run(["reply", done.id, "--status", "done", "--summary", "ok"]);
    await s.run(["ack", open.id]);
    const old = new Date(Date.now() - 40 * 86_400_000);
    for (const side of ["to-worker", "to-dispatcher"])
      for (const sub of ["read", "unread"]) {
        const d = path.join(s.inbox, "msg", side, sub);
        for (const f of fs.readdirSync(d)) fs.utimesSync(path.join(d, f), old, old);
      }
    const dry = await s.run(["prune", "--days", "30", "--json"]);
    expect(dry.json().applied).toBe(false);
    const files: string[] = dry.json().files;
    expect(files).toContain(`msg/to-worker/read/${done.id}.json`);
    expect(files).toContain(`receipts/${done.id}.json`);
    expect(files.some((f) => f.includes(open.id))).toBe(false); // still working
    expect(files.some((f) => f.includes(unread.id))).toBe(false); // never read
    expect(fs.existsSync(path.join(s.inbox, "msg", "to-worker", "read", `${done.id}.json`))).toBe(true);
    await s.run(["prune", "--days", "30", "--apply"]);
    expect(fs.existsSync(path.join(s.inbox, "msg", "to-worker", "read", `${done.id}.json`))).toBe(false);
    expect(fs.existsSync(path.join(s.inbox, "msg", "to-worker", "read", `${open.id}.json`))).toBe(true);
    expect((await s.run(["prune", "--days", "0"])).code).toBe(2);
  });
});

describe("send from flags: notes, ids, threads", () => {
  it("--type note --to dispatcher --id --thread", async () => {
    const s = sandbox();
    const id = uuid();
    const thread = uuid();
    const r = await s.run(["send", "--type", "note", "--to", "dispatcher", "--from", "claude-code", "--title", "Session finished", "--id", id, "--thread", thread]);
    expect(r.code).toBe(0);
    const env = JSON.parse(fs.readFileSync(path.join(s.inbox, "msg", "to-dispatcher", "unread", `${id}.json`), "utf8"));
    expect(env).toMatchObject({ type: "note", from: "claude-code", thread });
    expect(env.objective).toBeUndefined();
  });
});

describe("live-test style config", () => {
  it("a target named grokbot-test reads WAKE_GROKBOT_TEST_URL / WAKE_GROKBOT_TEST_KEY; three sends give one wake", async () => {
    const srv = await stub();
    const s = sandbox(
      { wake: { targets: { worker: "grokbot-test" } }, targets: { "grokbot-test": { channel: "grokbot", routine: "livetest", url_env: "WAKE_GROKBOT_TEST_URL", key_env: "WAKE_GROKBOT_TEST_KEY" } } },
      { WAKE_GROKBOT_TEST_URL: srv.url, WAKE_GROKBOT_TEST_KEY: KEY },
    );
    const states: string[] = [];
    for (let i = 0; i < 3; i++) states.push((await s.run(["send", "--json", "--json"], JSON.stringify(task()))).json().wake.state);
    expect(states).toEqual(["started", "coalesced", "coalesced"]);
    expect(srv.hits).toHaveLength(1);
    expect(srv.hits[0]!.headers.authorization).toBe(`Bearer ${KEY}`);
  });
});

describe("release delivers queued wakes even when nothing is in flight", () => {
  it("retries a not_started wake right away (no backoff wait) after the key is fixed", async () => {
    const srv = await stub();
    const s = sandbox(grokCfg(), { WAKE_GROKBOT_URL: srv.url });
    const e = task();
    expect((await s.run(["send", "--json"], JSON.stringify(e))).code).toBe(5); // key missing
    const r1 = await s.run(["release", "grokbot"]);
    expect(r1.code).toBe(5);
    expect(r1.out).toMatch(/nothing was in flight/);
    expect(r1.out).toMatch(/grokbot: wake not_started/);
    s.env.WAKE_GROKBOT_KEY = KEY;
    const r2 = await s.run(["release", "grokbot"]);
    expect(r2.code).toBe(0);
    expect(r2.out).toMatch(/grokbot: wake started/);
    expect(srv.hits).toHaveLength(1);
    expect((await s.run(["status", e.id, "--json"])).json().wake.state).toBe("started");
  });
  it("says so when there is nothing queued", async () => {
    const { s } = await setup();
    const r = await s.run(["release", "grokbot"]);
    expect(r.code).toBe(0);
    expect(r.out).toMatch(/nothing queued to deliver/);
  });
});

describe("prune keeps a light record of pruned ids", () => {
  it("prune --apply records id + settled_at only; the same id again is refused (exit 1, nothing written)", async () => {
    const s = sandbox();
    const done = task();
    await s.run(["send", "--json"], JSON.stringify(done));
    await s.run(["reply", done.id, "--status", "done", "--summary", "ok"]);
    const old = new Date(Date.now() - 40 * 86_400_000);
    const d = path.join(s.inbox, "msg", "to-worker", "read");
    for (const f of fs.readdirSync(d)) fs.utimesSync(path.join(d, f), old, old);
    await s.run(["prune", "--days", "30"]);
    expect(fs.existsSync(path.join(s.inbox, "pruned-ids.jsonl"))).toBe(false); // dry run records nothing
    expect((await s.run(["prune", "--days", "30", "--apply"])).code).toBe(0);
    const lines = fs.readFileSync(path.join(s.inbox, "pruned-ids.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
    expect(lines).toHaveLength(1);
    expect(Object.keys(lines[0]).sort()).toEqual(["id", "settled_at"]);
    expect(lines[0].id).toBe(done.id);
    expect(Number.isNaN(Date.parse(lines[0].settled_at))).toBe(false);
    expect(fs.existsSync(path.join(s.inbox, "receipts", `${done.id}.json`))).toBe(false);
    for (const env of [done, { ...done, title: "changed" }]) {
      const r = await s.run(["send", "--json"], JSON.stringify(env));
      expect(r.code).toBe(1);
      expect(r.err).toContain("receipt was pruned");
      expect(fs.existsSync(path.join(s.state, "state.lock"))).toBe(false); // lock released on refusal
    }
    expect(fs.existsSync(path.join(s.inbox, "receipts", `${done.id}.json`))).toBe(false);
    expect(fs.existsSync(path.join(s.inbox, "msg", "to-worker", "unread", `${done.id}.json`))).toBe(false);
    expect((await s.run(["send", "--json"], JSON.stringify(task()))).code).toBe(0); // other ids are fine
  });
});

describe("prune records ids of read envelopes that have no receipt", () => {
  it("a receipt-less read envelope is recorded (settled_at = file time) and its id is refused afterwards", async () => {
    const s = sandbox();
    const e = task();
    await s.run(["send", "--json"], JSON.stringify(e));
    await s.run(["ack", e.id]);
    fs.rmSync(path.join(s.inbox, "receipts", `${e.id}.json`)); // as if a crash lost the receipt
    const old = new Date(Date.now() - 40 * 86_400_000);
    const file = path.join(s.inbox, "msg", "to-worker", "read", `${e.id}.json`);
    fs.utimesSync(file, old, old);
    expect((await s.run(["prune", "--days", "30", "--apply"])).code).toBe(0);
    expect(fs.existsSync(file)).toBe(false);
    const lines = fs.readFileSync(path.join(s.inbox, "pruned-ids.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
    const rec = lines.find((l) => l.id === e.id);
    expect(rec).toBeTruthy();
    expect(Math.abs(Date.parse(rec.settled_at) - old.getTime())).toBeLessThan(2000);
    const again = await s.run(["send", "--json"], JSON.stringify(e));
    expect(again.code).toBe(1);
    expect(again.err).toContain("receipt was pruned");
    expect(fs.existsSync(path.join(s.inbox, "msg", "to-worker", "unread", `${e.id}.json`))).toBe(false);
    expect(fs.existsSync(path.join(s.inbox, "receipts", `${e.id}.json`))).toBe(false);
  });
});
