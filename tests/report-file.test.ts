/** Frozen v1 sinks contract: ctx.delivery, ordering, ownership, idempotency, outcomes. Calls deliver directly. */
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { DEFAULTS, type Config } from "../src/config.js";
import { contentHash, type Envelope, type ReplyTo } from "../src/envelope.js";
import { deliver, type SinkContext } from "../src/sinks.js";
import { uuid } from "./helpers.js";

const TASK = uuid();
function reply(status: Envelope["status"], summary = "s", over: Partial<Envelope> = {}): Envelope {
  return { v: "wake-envelope/1", id: uuid(), type: "answer", from: "worker", to: "dispatcher", status, summary, body: "b", thread: TASK, sent_at: "2026-11-05T01:00:00Z", ...(status === "needs_input" ? { question: "q?" } : {}), ...over };
}
function setup(extra: Partial<Config["sinks"]> = {}, env: NodeJS.ProcessEnv = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wg-sinks-"));
  const root = path.join(dir, "reports");
  fs.mkdirSync(root);
  const cfg: Config = JSON.parse(JSON.stringify(DEFAULTS));
  cfg.sinks = { ...cfg.sinks, report_roots: [root], file: { dir: path.join(dir, "out") }, ...extra };
  const report = path.join(root, "r.md");
  const ctx = (rev?: number, r?: Envelope, taskId = TASK): SinkContext => ({ cfg, inbox: dir, env, timeoutMs: 2000, ...(rev !== undefined && r ? { delivery: { taskId, replyHash: contentHash(r), revision: rev } } : {}) });
  const to: ReplyTo = { sink: "report-file", report_path: report };
  const send = (r: Envelope, rev?: number, taskId?: string, t: ReplyTo = to) => deliver(r, t, ctx(rev, r, taskId));
  return { dir, root, report, done: report + ".DONE", state: report + ".wake.json", to, send, ctx };
}
const sha = (f: string) => createHash("sha256").update(fs.readFileSync(f)).digest("hex");

describe("report sink v1 contract", () => {
  it("non-terminal writes a progress view and no .DONE", async () => {
    const s = setup();
    for (const st of ["working", "needs_input", "blocked"] as const) {
      const res = await s.send(reply(st), { working: 1, needs_input: 2, blocked: 3 }[st]);
      expect(res).toMatchObject({ ok: true, outcome: "delivered", state: "delivered" });
      expect(fs.existsSync(s.done)).toBe(false);
    }
    expect(fs.readFileSync(s.report, "utf8").startsWith("受阻：")).toBe(true);
  });
  it("terminal writes a versioned marker with task, reply, revision, reply_hash and report_sha256", async () => {
    const s = setup();
    const r = reply("done", "ok");
    expect(await s.send(r, 1)).toMatchObject({ ok: true, outcome: "delivered", state: "delivered" });
    const m = JSON.parse(fs.readFileSync(s.done, "utf8"));
    expect(m).toMatchObject({ format: "wake-report-done/1", id: r.id, task_id: TASK, status: "done", revision: 1, reply_hash: contentHash(r), report_sha256: sha(s.report) });
    expect(m.reply_hash).not.toBe(m.report_sha256);
  });
  it("an older revision is superseded without side effects", async () => {
    const s = setup();
    await s.send(reply("done", "new"), 5);
    const before = [fs.readFileSync(s.report, "utf8"), fs.readFileSync(s.done, "utf8")];
    expect(await s.send(reply("working", "old"), 4)).toMatchObject({ ok: true, outcome: "not_sent", state: "superseded" });
    expect(await s.send(reply("failed", "old"), 3)).toMatchObject({ state: "superseded" });
    expect([fs.readFileSync(s.report, "utf8"), fs.readFileSync(s.done, "utf8")]).toEqual(before);
  });
  it("a newer non-terminal never rolls back a terminal state", async () => {
    const s = setup();
    await s.send(reply("done", "fin"), 1);
    const before = fs.readFileSync(s.done, "utf8");
    expect(await s.send(reply("working", "late"), 2)).toMatchObject({ state: "superseded", outcome: "not_sent" });
    expect(fs.readFileSync(s.done, "utf8")).toBe(before);
    expect(fs.readFileSync(s.report, "utf8").startsWith("就绪：fin")).toBe(true);
  });
  it("same revision, different hash -> conflict; same revision+hash -> duplicate when consistent", async () => {
    const s = setup();
    const r = reply("done");
    await s.send(r, 1);
    const m1 = fs.statSync(s.done).mtimeMs;
    expect(await s.send(reply("done", "other"), 1)).toMatchObject({ ok: false, outcome: "not_sent", state: "conflict" });
    expect(await s.send(r, 1)).toMatchObject({ ok: true, outcome: "delivered", state: "duplicate" });
    expect(fs.statSync(s.done).mtimeMs).toBe(m1);
  });
  it("missing or corrupt marker is recovered, not reported as duplicate", async () => {
    const s = setup();
    const r = reply("done");
    await s.send(r, 1);
    fs.rmSync(s.done);
    expect(await s.send(r, 1)).toMatchObject({ ok: true, state: "delivered" });
    expect(JSON.parse(fs.readFileSync(s.done, "utf8")).reply_hash).toBe(contentHash(r));
    fs.writeFileSync(s.done, "{broken");
    expect(await s.send(r, 1)).toMatchObject({ ok: true, state: "delivered" });
    fs.writeFileSync(s.report, "tampered");
    expect(await s.send(r, 1)).toMatchObject({ ok: true, state: "delivered" });
    expect(JSON.parse(fs.readFileSync(s.done, "utf8")).report_sha256).toBe(sha(s.report));
  });
  it("a path owned by another task, or an unowned existing file, is a conflict", async () => {
    const s = setup();
    await s.send(reply("working"), 1);
    expect(await s.send(reply("done"), 1, uuid())).toMatchObject({ ok: false, state: "conflict", outcome: "not_sent" });
    const other = path.join(s.root, "pre.md");
    fs.writeFileSync(other, "someone else's");
    expect(await s.send(reply("done"), 1, TASK, { sink: "report-file", report_path: other })).toMatchObject({ state: "conflict" });
    expect(fs.readFileSync(other, "utf8")).toBe("someone else's");
  });
  it("lock busy is a retryable not_sent failure with no side effects", async () => {
    const s = setup();
    fs.writeFileSync(s.report + ".lock", "held");
    const res = await s.send(reply("done"), 1);
    expect(res).toMatchObject({ ok: false, outcome: "not_sent", state: "failed" });
    expect(res.detail).toMatch(/retry/);
    expect(fs.existsSync(s.report)).toBe(false);
  });
  it("paths outside the roots are not remapped", async () => {
    const s = setup();
    const out = path.join(s.dir, "elsewhere.md");
    expect(await s.send(reply("done"), 1, TASK, { sink: "report-file", report_path: out })).toMatchObject({ ok: false, outcome: "not_sent" });
    expect(fs.readdirSync(s.root)).toEqual([]);
  });
  it("legacy call (no ctx.delivery): terminal-only marker, no invented task association, refuses owned paths", async () => {
    const s = setup();
    expect(await s.send(reply("needs_input"))).toMatchObject({ ok: true, outcome: "delivered" });
    expect(fs.existsSync(s.done)).toBe(false);
    const r = reply("done");
    const res = await s.send(r);
    expect(res.state).toBeUndefined();
    const m = JSON.parse(fs.readFileSync(s.done, "utf8"));
    expect(m).toMatchObject({ format: "wake-report-done/1", id: r.id, status: "done", report_sha256: sha(s.report) });
    expect(m.task_id).toBeUndefined();
    const s2 = setup();
    await s2.send(reply("working"), 1);
    expect(await s2.send(reply("done"))).toMatchObject({ ok: false, outcome: "not_sent" });
  });
});

