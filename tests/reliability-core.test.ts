/**
 * RD-001-G-A reliability core: crash windows in accept/reply, delivery state separate from business status,
 * no silent webhook resend, expiry before execution. Crashes are simulated with the test-only `fault` hook.
 * All network traffic goes to a local stub server; nothing real is sent.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";
import { Engine } from "../src/core.js";
import { grokCfg, KEY, sandbox, stub, task, uuid } from "./helpers.js";

class Crash extends Error {}
const crashAt = (point: string) => (p: string) => {
  if (p === point) throw new Crash(`simulated crash at ${p}`);
};
type S = ReturnType<typeof sandbox>;
const engine = (s: S, o: { fault?: (p: string) => void; now?: () => number } = {}) =>
  new Engine(loadConfig({ config: s.cfgPath, env: s.env }), { env: s.env, ...o });
const later = () => Date.now() + 3600_000; // "after a restart, long after the crash"
const files = (d: string) => (fs.existsSync(d) ? fs.readdirSync(d).filter((f) => f.endsWith(".json")) : []);
const receipt = (s: S, id: string) => JSON.parse(fs.readFileSync(path.join(s.inbox, "receipts", `${id}.json`), "utf8"));

describe("accept crash windows", () => {
  for (const point of ["accept:after-envelope", "accept:after-receipt"]) {
    it(`${point}: resending the same envelope completes receipt + queue and wakes exactly once`, async () => {
      const srv = await stub(() => ({ status: 200 }));
      const s = sandbox(grokCfg(), { WAKE_GROKBOT_URL: srv.url, WAKE_GROKBOT_KEY: KEY });
      const e = task();
      await expect(engine(s, { fault: crashAt(point) }).accept(structuredClone(e))).rejects.toBeInstanceOf(Crash);
      expect(srv.hits).toHaveLength(0);
      const r = await s.run(["send", "--json", "-", "--json"], JSON.stringify(e));
      expect(r.code).toBe(0);
      expect(receipt(s, e.id).wake.state).toBe("started");
      expect(srv.hits).toHaveLength(1);
      expect((await s.run(["send", "--json", "-"], JSON.stringify(e))).code).toBe(0);
      expect(srv.hits).toHaveLength(1);
      expect((await s.run(["send", "--json", "-"], JSON.stringify({ ...e, title: "changed" }))).code).toBe(7);
    });

    it(`${point}: watch recovers without a resend, wakes once`, async () => {
      const srv = await stub(() => ({ status: 200 }));
      const s = sandbox(grokCfg(), { WAKE_GROKBOT_URL: srv.url, WAKE_GROKBOT_KEY: KEY });
      const e = task();
      await expect(engine(s, { fault: crashAt(point) }).accept(structuredClone(e))).rejects.toBeInstanceOf(Crash);
      expect((await s.run(["watch", "--once"])).code).toBe(0);
      expect(receipt(s, e.id).wake.state).toBe("started");
      await s.run(["watch", "--once"]);
      expect(srv.hits).toHaveLength(1);
    });
  }

  it("a different envelope under an id whose receipt is missing is a conflict (7), not an internal error", async () => {
    const s = sandbox();
    const e = task();
    await expect(engine(s, { fault: crashAt("accept:after-envelope") }).accept(structuredClone(e))).rejects.toBeInstanceOf(Crash);
    expect((await s.run(["send", "--json", "-"], JSON.stringify({ ...e, title: "other" }))).code).toBe(7);
  });
});

function fileSinkTask(over: Record<string, unknown> = {}) {
  return task({ reply_to: { sink: "file" }, ...over });
}

describe("reply crash windows (file sink)", () => {
  for (const point of ["reply:after-intent", "reply:after-envelope", "reply:after-receipt", "reply:after-enqueue", "reply:after-task", "reply:before-deliver", "reply:after-deliver"]) {
    it(`${point}: recover completes the reply once and delivers the report`, async () => {
      const s = sandbox();
      const e = fileSinkTask();
      expect((await s.run(["send", "--json", "-"], JSON.stringify(e))).code).toBe(0);
      await expect(engine(s, { fault: crashAt(point) }).reply(e.id, { status: "done", summary: "ok" })).rejects.toBeInstanceOf(Crash);
      await engine(s, { now: later }).recover();
      const r = receipt(s, e.id);
      expect(r.status).toBe("done");
      expect(r.replies).toHaveLength(1);
      expect(r.replies[0].delivery.state).toBe("delivered");
      expect(r.replies[0].revision).toBe(1);
      const back = files(path.join(s.inbox, "msg", "to-dispatcher", "unread"));
      expect(back).toHaveLength(1);
      expect(fs.existsSync(path.join(s.inbox, "receipts", back[0]!))).toBe(true);
      expect(files(path.join(s.inbox, "replies"))).toHaveLength(1);
      await engine(s, { now: later }).recover(); // idempotent
      expect(receipt(s, e.id).replies).toHaveLength(1);
    });
  }

  it("hufu-report: report written but .DONE marker missing after a crash → recover rewrites both", async () => {
    const base = sandbox();
    const root = path.join(base.dir, "reports");
    fs.mkdirSync(root);
    const s = sandbox({ sinks: { report_roots: [root] } });
    const report = path.join(root, "r.md");
    const e = task({ reply_to: { sink: "hufu-report", report_path: report } });
    await s.run(["send", "--json", "-"], JSON.stringify(e));
    await expect(engine(s, { fault: crashAt("reply:after-deliver") }).reply(e.id, { status: "done", summary: "fine" })).rejects.toBeInstanceOf(Crash);
    fs.rmSync(report + ".DONE"); // as if the process died between report and marker
    await engine(s, { now: later }).recover();
    expect(fs.existsSync(report + ".DONE")).toBe(true);
    expect(receipt(s, e.id).replies[0].delivery.state).toBe("delivered");
  });

  it("an old `working` reply recovered later never overwrites a newer `done`", async () => {
    const s = sandbox();
    const e = fileSinkTask();
    await s.run(["send", "--json", "-"], JSON.stringify(e));
    await expect(engine(s, { fault: crashAt("reply:after-envelope") }).reply(e.id, { status: "working", summary: "busy" })).rejects.toBeInstanceOf(Crash);
    expect((await s.run(["reply", e.id, "--status", "done", "--summary", "finished"])).code).toBe(0);
    await engine(s, { now: later }).recover();
    const r = receipt(s, e.id);
    expect(r.status).toBe("done");
    expect(r.replies.map((x: { revision: number }) => x.revision).sort()).toEqual([1, 2]);
  });

  it("sink not_sent (no report_roots) keeps status done, reports FAILED (exit 5); after fixing config watch delivers", async () => {
    const s = sandbox();
    const root = path.join(s.dir, "reports");
    fs.mkdirSync(root);
    const report = path.join(root, "r.md");
    const e = task({ reply_to: { sink: "hufu-report", report_path: report } });
    await s.run(["send", "--json", "-"], JSON.stringify(e));
    const r = await s.run(["reply", e.id, "--status", "done", "--summary", "x"]);
    expect(r.code).toBe(5);
    expect(receipt(s, e.id).status).toBe("done");
    expect(receipt(s, e.id).replies[0].delivery.state).toBe("not_sent");
    const st = await s.run(["status", e.id]);
    expect(st.out).toMatch(/report=not_sent/);
    const cfg = JSON.parse(fs.readFileSync(s.cfgPath, "utf8"));
    fs.writeFileSync(s.cfgPath, JSON.stringify({ ...cfg, sinks: { report_roots: [root] } }));
    await s.run(["watch", "--once"]);
    expect(receipt(s, e.id).replies[0].delivery.state).toBe("delivered");
    expect(fs.existsSync(report + ".DONE")).toBe(true);
  });
});

describe("webhook: unknown outcomes are never resent automatically", () => {
  const hookCfg = { sinks: { webhooks: { h: { url_env: "H_URL", secret_env: "H_SECRET" } } }, wake: { timeout_seconds: 1 } };
  const hookTask = () => task({ reply_to: { sink: "webhook", url_ref: "h" } });

  for (const point of ["reply:before-deliver", "reply:after-deliver"]) {
    it(`${point}: crash → recover marks unknown, no extra HTTP; redeliver needs explicit risk flag`, async () => {
      const srv = await stub(() => ({ status: 200 }));
      const s = sandbox(hookCfg, { H_URL: srv.url, H_SECRET: "hook-secret-for-tests" });
      const e = hookTask();
      await s.run(["send", "--json", "-"], JSON.stringify(e));
      await expect(engine(s, { fault: crashAt(point) }).reply(e.id, { status: "done", summary: "x", id: uuid() })).rejects.toBeInstanceOf(Crash);
      const before = srv.hits.length;
      expect(before).toBe(point === "reply:after-deliver" ? 1 : 0);
      await engine(s, { now: later }).recover();
      await engine(s, { now: later }).recover();
      await s.run(["watch", "--once"]);
      expect(srv.hits).toHaveLength(before);
      const rec = receipt(s, e.id).replies[0];
      expect(rec.delivery.state).toBe("unknown");
      expect(receipt(s, e.id).status).toBe("done");
      const no = await s.run(["redeliver", rec.id]);
      expect(no.code).toBe(1);
      expect(srv.hits).toHaveLength(before);
      const yes = await s.run(["redeliver", rec.id, "--accept-duplicate-risk"]);
      expect(yes.code).toBe(0);
      expect(srv.hits).toHaveLength(before + 1);
      expect(receipt(s, e.id).replies[0].delivery.state).toBe("delivered");
    });
  }

  it("a timed-out webhook is unknown (exit 5) and watch does not POST again", async () => {
    const srv = await stub(() => ({ status: 200, hang: true }));
    const s = sandbox(hookCfg, { H_URL: srv.url, H_SECRET: "hook-secret-for-tests" });
    const e = hookTask();
    await s.run(["send", "--json", "-"], JSON.stringify(e));
    const r = await s.run(["reply", e.id, "--status", "done", "--summary", "x"]);
    expect(r.code).toBe(5);
    expect(receipt(s, e.id).replies[0].delivery.state).toBe("unknown");
    await s.run(["watch", "--once"]);
    await engine(s, { now: later }).recover();
    expect(srv.hits).toHaveLength(1);
  });

  it("passes ctx.delivery { taskId, replyHash, revision } to the sink call", async () => {
    const srv = await stub(() => ({ status: 200 }));
    const s = sandbox(hookCfg, { H_URL: srv.url, H_SECRET: "hook-secret-for-tests" });
    const e = hookTask();
    await s.run(["send", "--json", "-"], JSON.stringify(e));
    const eng = engine(s);
    const seen: unknown[] = [];
    eng.onDeliver = (ctx) => seen.push(ctx.delivery);
    await eng.reply(e.id, { status: "done", summary: "x" });
    expect(seen).toEqual([{ taskId: e.id, replyHash: expect.stringMatching(/.+/), revision: 1 }]);
  });
});

describe("expiry before execution (send / ingest / pump agree)", () => {
  it("send refuses a new expired envelope: exit 1, nothing written", async () => {
    const s = sandbox();
    const e = task({ expires_at: "2020-01-01T00:00:00Z" });
    expect((await s.run(["send", "--json", "-"], JSON.stringify(e))).code).toBe(1);
    expect(fs.existsSync(path.join(s.inbox, "receipts", `${e.id}.json`))).toBe(false);
  });

  it("queued, then expired before the wake: not woken (not_started, expired reason), business status unchanged", async () => {
    const srv = await stub(() => ({ status: 200 }));
    const s = sandbox(grokCfg(), { WAKE_GROKBOT_URL: srv.url, WAKE_GROKBOT_KEY: KEY });
    const e = task({ expires_at: new Date(Date.now() + 60_000).toISOString() });
    expect((await s.run(["send", "--json", "-", "--no-wake"], JSON.stringify(e))).code).toBe(0);
    await engine(s, { now: later }).pump();
    expect(srv.hits).toHaveLength(0);
    const r = receipt(s, e.id);
    expect(r.wake.state).toBe("not_started");
    expect(r.wake.detail).toMatch(/expired/);
    expect(r.status).toBe("queued");
    // known id after expiry: idempotency first
    expect((await engine(s, { now: later }).accept(structuredClone(e))).code).toBe(5);
    expect(srv.hits).toHaveLength(0);
  });
});
