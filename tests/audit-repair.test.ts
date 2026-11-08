/**
 * audit repair (M1–M5, S3) against 97243e8. Each case reproduces an audit finding with local mocks only
 * (127.0.0.1 stub server, sandbox report roots); nothing real is sent.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";
import { Engine } from "../src/core.js";
import * as root from "../src/index.js";
import { _testHooks as sinkHooks } from "../src/sinks.js";
import { _setCoreTestHooks } from "../src/testhooks.js";
import { sandbox, stub, task, uuid } from "./helpers.js";

type S = ReturnType<typeof sandbox>;
const engine = (s: S, now?: () => number) => new Engine(loadConfig({ config: s.cfgPath, env: s.env }), { env: s.env, ...(now ? { now } : {}) });
const receipt = (s: S, id: string) => JSON.parse(fs.readFileSync(path.join(s.inbox, "receipts", `${id}.json`), "utf8"));
const later = () => Date.now() + 3600_000;

const hookBox = async (status = 500) => {
  const srv = await stub(() => ({ status }));
  const s = sandbox({ sinks: { webhooks: { h: { url_env: "H_URL", secret_env: "H_SECRET" } } }, wake: { timeout_seconds: 1 } }, { H_URL: srv.url, H_SECRET: "hook-secret-for-tests" });
  return { srv, s };
};
const reportBox = (extra: Record<string, unknown> = {}) => {
  const base = sandbox();
  const rootDir = path.join(base.dir, "rep");
  fs.mkdirSync(rootDir);
  const s = sandbox({ sinks: { report_roots: [rootDir] }, ...extra });
  return { s, rootDir };
};

describe("M1: an unconfirmed delivery is never reported as success on an idempotent retry", () => {
  it("webhook 500 → exit 5 unknown; the same reply again is still exit 5 and says UNKNOWN, no new HTTP", async () => {
    const { srv, s } = await hookBox(500);
    const e = task({ reply_to: { sink: "webhook", url_ref: "h" } });
    await s.run(["send", "--json", "-"], JSON.stringify(e));
    const rid = uuid();
    const input = { id: rid, status: "done" as const, summary: "s", sent_at: "2026-11-06T02:00:00Z" };
    const a = await engine(s).reply(e.id, { ...input });
    expect(a.code).toBe(5);
    expect(srv.hits).toHaveLength(1);
    const b = await engine(s).reply(e.id, { ...input });
    expect(b.code).not.toBe(0);
    expect(b.message).toMatch(/UNKNOWN/);
    expect(srv.hits).toHaveLength(1);
    expect(receipt(s, e.id).replies[0].delivery.state).toBe("unknown");
  });
});

describe("M2: after a terminal status, new non-terminal replies are refused before anything is written", () => {
  it("done then working → rule (exit 1); no revision, intent, envelope or receipt change", async () => {
    const { s, rootDir } = reportBox();
    const rp = path.join(rootDir, "r.md");
    const e = task({ reply_to: { sink: "hufu-report", report_path: rp } });
    await s.run(["send", "--json", "-"], JSON.stringify(e));
    expect((await engine(s).reply(e.id, { status: "done", summary: "ok" })).code).toBe(0);
    const before = receipt(s, e.id);
    const wid = uuid();
    const r = await s.run(["reply", e.id, "--status", "working", "--summary", "more", "--id", wid]);
    expect(r.code).toBe(1);
    expect(r.err).toMatch(/terminal/);
    const after = receipt(s, e.id);
    expect(after).toEqual(before);
    expect(after.status).toBe("done");
    expect(fs.existsSync(path.join(s.inbox, "receipts", `${wid}.json`))).toBe(false);
    const intents = path.join(s.state, "pending-replies");
    if (fs.existsSync(intents)) expect(fs.readdirSync(intents).join(",")).not.toContain(wid);
    expect(fs.readFileSync(rp, "utf8")).toMatch(/ok/);
  });

  it("a legacy pending working intent replayed after done: superseded is settled, status stays done, recover does not retry", async () => {
    const { s, rootDir } = reportBox();
    const rp = path.join(rootDir, "r.md");
    const e = task({ reply_to: { sink: "hufu-report", report_path: rp } });
    await s.run(["send", "--json", "-"], JSON.stringify(e));
    // a working reply whose intent was written before the done (older revision), crash before the task update
    class Crash extends Error {}
    const eng = engine(s);
    _setCoreTestHooks(eng, { fault: (p) => { if (p === "reply:after-enqueue") throw new Crash(p); } });
    await expect(eng.reply(e.id, { status: "working", summary: "old" })).rejects.toBeInstanceOf(Crash);
    expect((await engine(s).reply(e.id, { status: "done", summary: "ok" })).code).toBe(0);
    for (let k = 0; k < 3; k++) await engine(s, later).recover();
    const r = receipt(s, e.id);
    expect(r.status).toBe("done");
    const w = r.replies.find((x: { status: string }) => x.status === "working");
    expect(w.delivery.sink_state).toBe("superseded");
    expect(w.delivery.state).not.toBe("failed");
    expect(w.delivery.attempts).toBe(1);
    expect(fs.readFileSync(rp, "utf8")).toMatch(/ok/);
  });
});

describe("M3: a replay-safe report whose outcome is unknown is repaired by recover", () => {
  it("I/O error after the report write → unknown; recover writes the marker; webhook unknown is still not resent", async () => {
    const { s, rootDir } = reportBox();
    const rp = path.join(rootDir, "c.md");
    const e = task({ reply_to: { sink: "hufu-report", report_path: rp } });
    await s.run(["send", "--json", "-"], JSON.stringify(e));
    sinkHooks.fault = (w) => { if (w === "report") throw new Error("injected io error"); };
    let r;
    try { r = await engine(s).reply(e.id, { status: "done", summary: "ok" }); } finally { delete sinkHooks.fault; }
    expect(r.code).toBe(5);
    expect(receipt(s, e.id).replies[0].delivery.state).toBe("unknown");
    const rec = await engine(s).recover();
    expect(rec.delivered).toHaveLength(1);
    expect(fs.existsSync(rp + ".DONE")).toBe(true);
    expect(receipt(s, e.id).replies[0].delivery.state).toBe("delivered");

    const { srv, s: h } = await hookBox(500);
    const t = task({ reply_to: { sink: "webhook", url_ref: "h" } });
    await h.run(["send", "--json", "-"], JSON.stringify(t));
    await engine(h).reply(t.id, { status: "done", summary: "x" });
    await engine(h, later).recover();
    expect(srv.hits).toHaveLength(1);
  });
});

describe("M4: a delivery that gave up keeps its intent for manual repair", () => {
  it("conflict until max_attempts → failed; after the conflict is cleared, redeliver delivers the original reply", async () => {
    const { s, rootDir } = reportBox({ wake: { max_attempts: 2 } });
    const rp = path.join(rootDir, "d.md");
    fs.writeFileSync(rp, "foreign");
    const e = task({ reply_to: { sink: "hufu-report", report_path: rp } });
    await s.run(["send", "--json", "-"], JSON.stringify(e));
    await engine(s).reply(e.id, { status: "done", summary: "ok" });
    for (let k = 0; k < 3; k++) await engine(s).recover();
    const rr = receipt(s, e.id).replies[0];
    expect(rr.delivery.state).toBe("failed");
    expect(rr.delivery.attempts).toBe(2);
    const st = await s.run(["status", e.id]);
    expect(st.out).toMatch(/report=failed/);
    expect(st.out).toMatch(/redeliver/);
    fs.rmSync(rp);
    const red = await s.run(["redeliver", rr.id]);
    expect(red.code).toBe(0);
    const d = receipt(s, e.id).replies[0];
    expect(d.delivery.state).toBe("delivered");
    expect(d.revision).toBe(rr.revision);
    expect(JSON.parse(fs.readFileSync(rp + ".DONE", "utf8")).id).toBe(rr.id);
    const again = await s.run(["redeliver", rr.id]);
    expect(again.code).toBe(1);
    expect(again.err).toMatch(/already delivered/);
  });
});

describe("S3: redeliver and recover share one stale-attempt rule", () => {
  it("an open attempt younger than max(timeout*3, 10 min) blocks both; older than the long timeout but past 10 min is still live", async () => {
    const { s, rootDir } = reportBox({ wake: { timeout_seconds: 600 } }); // stale after 30 min
    const rp = path.join(rootDir, "s.md");
    const e = task({ reply_to: { sink: "hufu-report", report_path: rp } });
    await s.run(["send", "--json", "-"], JSON.stringify(e));
    class Crash extends Error {}
    const eng = engine(s);
    _setCoreTestHooks(eng, { fault: (p) => { if (p === "reply:before-deliver") throw new Crash(p); } });
    await expect(eng.reply(e.id, { status: "done", summary: "ok" })).rejects.toBeInstanceOf(Crash);
    const rid = receipt(s, e.id).replies[0].id;
    const at15 = () => Date.now() + 15 * 60_000;
    await expect(engine(s, at15).redeliver(rid)).rejects.toThrow(/in progress/);
    expect((await engine(s, at15).recover()).delivered).toHaveLength(0);
    expect(fs.existsSync(rp)).toBe(false);
    const at31 = () => Date.now() + 31 * 60_000;
    expect((await engine(s, at31).redeliver(rid)).code).toBe(0);
  });
});

describe("M5: no fault injection through the package root", () => {
  it("EngineOptions ignores fault/deliverFn; Engine has no public onDeliver; root exports no hook setter", async () => {
    const { s } = reportBox();
    const e = task();
    await s.run(["send", "--json", "-"], JSON.stringify(e));
    const eng = new Engine(loadConfig({ config: s.cfgPath, env: s.env }), { env: s.env, fault: () => { throw new Error("hook ran"); } } as never);
    await expect(eng.reply(e.id, { status: "done", summary: "x" })).resolves.toBeTruthy();
    expect("onDeliver" in eng).toBe(false);
    expect(Object.keys(root)).not.toContain("_setCoreTestHooks");
    const core = fs.readFileSync(path.join(import.meta.dirname, "..", "src", "core.ts"), "utf8");
    const opts = core.slice(core.indexOf("export interface EngineOptions"), core.indexOf("}", core.indexOf("export interface EngineOptions")));
    expect(opts).not.toMatch(/fault|deliverFn/);
    const idx = fs.readFileSync(path.join(import.meta.dirname, "..", "src", "index.ts"), "utf8");
    expect(idx).not.toMatch(/testhooks/);
  });
});

describe("contract violation: never replayed automatically, kept for an explicit manual repair", () => {
  const noOutcome = async () => ({ ok: true, detail: "stub without outcome field" }) as never;
  it("file sink: status/reply say contract violation; recover skips; redeliver needs --after-contract-fix (not the risk flag)", async () => {
    const { s, rootDir } = reportBox();
    const rp = path.join(rootDir, "cv.md");
    const e = task({ reply_to: { sink: "hufu-report", report_path: rp } });
    await s.run(["send", "--json", "-"], JSON.stringify(e));
    const eng = engine(s);
    _setCoreTestHooks(eng, { deliverFn: noOutcome });
    const r = await eng.reply(e.id, { status: "done", summary: "ok" });
    expect(r.code).toBe(5);
    expect(r.message).toMatch(/CONTRACT VIOLATION/);
    const rid = receipt(s, e.id).replies[0].id;
    expect(fs.readdirSync(path.join(s.state, "pending-replies")).join(",")).toContain(rid);
    await engine(s, later).recover();
    expect(fs.existsSync(rp)).toBe(false);
    const st = await s.run(["status", e.id]);
    expect(st.out).toMatch(/report=unknown\/contract_violation/);
    expect(st.out).toMatch(/after-contract-fix/);
    const blind = await s.run(["redeliver", rid, "--accept-duplicate-risk"]);
    expect(blind.code).toBe(1);
    expect(blind.err).toMatch(/contract violation/);
    expect(fs.existsSync(rp)).toBe(false);
    const fix = await s.run(["redeliver", rid, "--after-contract-fix"]);
    expect(fix.code).toBe(0);
    expect(fs.existsSync(rp + ".DONE")).toBe(true);
    expect(receipt(s, e.id).replies[0].delivery.contract_violation).toBeUndefined();
  });

  it("webhook sink: the contract flag alone is not enough when an outside side effect may have happened", async () => {
    const { srv, s } = await hookBox(200);
    const e = task({ reply_to: { sink: "webhook", url_ref: "h" } });
    await s.run(["send", "--json", "-"], JSON.stringify(e));
    const eng = engine(s);
    _setCoreTestHooks(eng, { deliverFn: noOutcome });
    await eng.reply(e.id, { status: "done", summary: "ok" });
    const rid = receipt(s, e.id).replies[0].id;
    expect((await s.run(["redeliver", rid, "--accept-duplicate-risk"])).code).toBe(1);
    expect((await s.run(["redeliver", rid, "--after-contract-fix"])).code).toBe(1);
    expect(srv.hits).toHaveLength(0);
    expect((await s.run(["redeliver", rid, "--after-contract-fix", "--accept-duplicate-risk"])).code).toBe(0);
    expect(srv.hits).toHaveLength(1);
  });
});

describe("superseded: exit 0 means the old delivery was handled safely, not that a report arrived", () => {
  it("re-running a legacy older reply after done: exit 0, explicit superseded wording, nothing delivered, done kept", async () => {
    const { s, rootDir } = reportBox();
    const rp = path.join(rootDir, "sp.md");
    const e = task({ reply_to: { sink: "hufu-report", report_path: rp } });
    await s.run(["send", "--json", "-"], JSON.stringify(e));
    class Crash extends Error {}
    const wid = uuid();
    const input = { id: wid, status: "working" as const, summary: "old", sent_at: "2026-11-06T02:00:00Z" };
    const eng = engine(s);
    _setCoreTestHooks(eng, { fault: (p) => { if (p === "reply:after-enqueue") throw new Crash(p); } });
    await expect(eng.reply(e.id, { ...input })).rejects.toBeInstanceOf(Crash);
    await engine(s).reply(e.id, { status: "done", summary: "ok" });
    const report = fs.readFileSync(rp, "utf8");
    const r = await engine(s).reply(e.id, { ...input });
    expect(r.code).toBe(0);
    expect(r.message).toMatch(/superseded/);
    expect(r.message).toMatch(/not delivered/);
    expect(r.message).toMatch(/unchanged/);
    expect(r.message).not.toMatch(/sink delivered/);
    const w = receipt(s, e.id).replies.find((x: { id: string }) => x.id === wid);
    expect(w.delivery).toMatchObject({ state: "not_sent", sink_state: "superseded" });
    expect(w.delivery.detail).toMatch(/superseded.*unchanged/);
    expect(receipt(s, e.id).status).toBe("done");
    expect(fs.readFileSync(rp, "utf8")).toBe(report);
    const st = await s.run(["status", e.id]);
    expect(st.out).not.toMatch(/report=delivered/);
  });
});
