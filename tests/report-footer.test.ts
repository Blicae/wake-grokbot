/**
 * RD-004-A: the fixed footer at the end of a terminal report file (account weekly quota + execution time in 北京时间).
 * Start = ack / working (never ingest), finish = the terminal reply's sent_at; quota comes from the woken Bot.
 */
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { beijing, duration, parseTime, renderFooter, startedAt } from "../src/footer.js";
import { fixture, sandbox } from "./helpers.js";

const ACK = "2026-11-07T02:00:00.000Z"; // 北京时间 10:00:00
const INGEST = "2026-11-07T01:00:00.000Z"; // 北京时间 09:00:00 (queue time, must never be the start)
const DONE = "2026-11-07T03:23:45.000Z"; // 北京时间 11:23:45

function setup() {
  const base = sandbox();
  const root = path.join(base.dir, "reports");
  fs.mkdirSync(root);
  const s = sandbox({ sources: { "my-engine": { require_sig: false } }, sinks: { report_roots: [root] } });
  const e = fixture("task-hufu-report.json");
  e.reply_to.report_path = path.join(root, path.basename(e.reply_to.report_path));
  return { s, e, report: e.reply_to.report_path as string };
}
const receiptFile = (s: { inbox: string }, id: string) => path.join(s.inbox, "receipts", `${id}.json`);
function patchReceipt(s: { inbox: string }, id: string, f: (r: Record<string, any>) => void) {
  const p = receiptFile(s, id);
  const r = JSON.parse(fs.readFileSync(p, "utf8"));
  f(r);
  fs.writeFileSync(p, JSON.stringify(r, null, 2) + "\n");
}
async function ingestAck(s: ReturnType<typeof sandbox>, e: Record<string, any>, ack = true) {
  expect((await s.run(["ingest", "--from", "my-engine", "-"], JSON.stringify(e))).code).toBe(0);
  patchReceipt(s, e.id, (r) => (r.created_at = INGEST));
  if (ack) {
    expect((await s.run(["ack", e.id])).code).toBe(0);
    patchReceipt(s, e.id, (r) => (r.acked_at = ACK));
  }
}
const reply = (s: ReturnType<typeof sandbox>, id: string, obj: Record<string, unknown>, extra: string[] = []) =>
  s.run(["reply", id, "--json", "-", ...extra], JSON.stringify({ sent_at: DONE, summary: "s", body: "正文第一行\n正文第二行", ...obj }));
const footerOf = (text: string) => text.slice(text.lastIndexOf("\n---\n") + 1);

describe("report footer helpers", () => {
  it("duration: Chinese units, zero units omitted, all zero = 0秒", () => {
    expect(duration(0)).toBe("0秒");
    expect(duration(999)).toBe("0秒");
    expect(duration(5_000)).toBe("5秒");
    expect(duration(3600_000 + 5_000)).toBe("1小时5秒");
    expect(duration((3600 + 23 * 60 + 45) * 1000)).toBe("1小时23分45秒");
    expect(duration(23 * 60_000)).toBe("23分");
    expect(duration((86400 + 3600) * 1000)).toBe("1天1小时");
  });
  it("beijing: UTC+8 fixed format; parseTime accepts zoned ISO-8601 and epoch, refuses the rest", () => {
    expect(beijing(Date.parse("2026-11-07T16:30:00Z"))).toBe("2026-11-08 00:30:00");
    expect(parseTime("2026-11-10T00:00:00Z")).toBe(Date.parse("2026-11-10T00:00:00Z"));
    expect(parseTime("2026-11-10T08:00:00+08:00")).toBe(Date.parse("2026-11-10T00:00:00Z"));
    expect(parseTime("1794268800")).toBe(1794268800_000);
    expect(parseTime("1794268800000")).toBe(1794268800_000);
    expect(parseTime("下周一")).toBeUndefined();
    expect(parseTime("2026-11-10 08:00")).toBeUndefined(); // no zone: not guessed
  });
  it("startedAt: earliest ack/working; an acked_at filled by a terminal reply is not an ack", () => {
    expect(startedAt(undefined)).toBeUndefined();
    expect(startedAt({ replies: [] })).toBeUndefined();
    expect(startedAt({ acked_at: DONE, replies: [{ id: "x", status: "done", at: DONE }] })).toBeUndefined();
    expect(startedAt({ acked_at: DONE, replies: [{ id: "w", status: "working", at: ACK }] })).toBe(Date.parse(ACK));
  });
  it("renderFooter: three blocks, 北京时间 labels, unparseable reset shown as given", () => {
    const f = renderFooter({ quota: { used: "62%", remaining: "38%", reset: "下周一" }, startedAt: Date.parse(ACK), completedAt: Date.parse(DONE) });
    expect(f).toBe(
      "---\nGrok Bot额度（周额度，非本单消耗）：已用 62%，剩余 38%，重置：下周一（原样，未换算）\n" +
        "任务执行：开始 北京时间 2026-11-07 10:00:00，完成 北京时间 2026-11-07 11:23:45，耗时 1小时23分45秒",
    );
  });
});

describe("terminal report footer (hufu-report sink)", () => {
  for (const st of ["done", "failed", "declined"] as const) {
    it(`${st}: header unchanged, footer at the end, time = ack → reply in 北京时间, quota rendered`, async () => {
      const { s, e, report } = setup();
      await ingestAck(s, e);
      const r = await reply(s, e.id, { status: st, quota: { used: "1,234 次", remaining: "766 次", reset: "2026-11-10T00:00:00Z" } });
      expect(r.code).toBe(0);
      const text = fs.readFileSync(report, "utf8");
      const word = { done: "就绪", failed: "失败", declined: "无需处理" }[st];
      expect(text).toBe(
        `${word}：s\n\n正文第一行\n正文第二行\n\n---\n` +
          "Grok Bot额度（周额度，非本单消耗）：已用 1,234 次，剩余 766 次，重置：北京时间 2026-11-10 08:00:00\n" +
          "任务执行：开始 北京时间 2026-11-07 10:00:00，完成 北京时间 2026-11-07 11:23:45，耗时 1小时23分45秒\n",
      );
      expect(text).not.toContain("09:00:00"); // the ingest/queue time is never the start
      const done = JSON.parse(fs.readFileSync(report + ".DONE", "utf8"));
      expect(done.report_sha256).toBe(createHash("sha256").update(fs.readFileSync(report)).digest("hex"));
    });
  }

  it("working / needs_input reports carry no footer", async () => {
    const { s, e, report } = setup();
    await ingestAck(s, e);
    expect((await reply(s, e.id, { status: "working", quota: { used: "1" } })).code).toBe(0);
    expect(fs.readFileSync(report, "utf8")).toBe("进展：s\n\n正文第一行\n正文第二行\n");
    expect((await reply(s, e.id, { status: "needs_input", question: "选哪个？", sent_at: "2026-11-07T02:30:00Z" })).code).toBe(0);
    const t = fs.readFileSync(report, "utf8");
    expect(t).toBe("等待：s\n待人工决定：选哪个？\n\n正文第一行\n正文第二行\n");
    expect(t).not.toContain("Grok Bot额度");
  });

  it("a working reply counts as the start when there was no ack", async () => {
    const { s, e, report } = setup();
    await ingestAck(s, e, false);
    expect((await reply(s, e.id, { status: "working", sent_at: "2026-11-07T03:00:00Z" })).code).toBe(0);
    expect((await reply(s, e.id, { status: "done" })).code).toBe(0);
    expect(footerOf(fs.readFileSync(report, "utf8"))).toContain("任务执行：开始 北京时间 2026-11-07 11:00:00，完成 北京时间 2026-11-07 11:23:45，耗时 23分45秒\n");
  });

  it("no ack and no working: no fake start, duration 无法计算; missing quota = 未提供 and the reply still succeeds", async () => {
    const { s, e, report } = setup();
    await ingestAck(s, e, false);
    const r = await reply(s, e.id, { status: "done" });
    expect(r.code).toBe(0);
    expect(footerOf(fs.readFileSync(report, "utf8"))).toBe(
      "---\nGrok Bot额度（周额度，非本单消耗）：已用 未提供，剩余 未提供，重置：未提供\n" +
        "任务执行：开始时间：未记录领单（ack）时间，完成 北京时间 2026-11-07 11:23:45，耗时 无法计算\n",
    );
  });

  it("M1: no ack, blocked then done: the acked_at blocked filled in is not a start", async () => {
    const { s, e, report } = setup();
    await ingestAck(s, e, false);
    expect((await reply(s, e.id, { status: "blocked", sent_at: "2026-11-07T03:00:00Z" })).code).toBe(0);
    expect(JSON.parse(fs.readFileSync(receiptFile(s, e.id), "utf8")).acked_at).toBe("2026-11-07T03:00:00Z");
    expect((await reply(s, e.id, { status: "done" })).code).toBe(0);
    const f = footerOf(fs.readFileSync(report, "utf8"));
    expect(f).toContain("任务执行：开始时间：未记录领单（ack）时间，完成 北京时间 2026-11-07 11:23:45，耗时 无法计算\n");
    expect(f).not.toContain("11:00:00");
  });

  it("needs_input reply (no ack) still counts as the start", async () => {
    const { s, e, report } = setup();
    await ingestAck(s, e, false);
    expect((await reply(s, e.id, { status: "needs_input", question: "q?", sent_at: "2026-11-07T03:00:00Z" })).code).toBe(0);
    expect((await reply(s, e.id, { status: "done" })).code).toBe(0);
    expect(footerOf(fs.readFileSync(report, "utf8"))).toContain("任务执行：开始 北京时间 2026-11-07 11:00:00，完成 北京时间 2026-11-07 11:23:45，耗时 23分45秒\n");
  });

  it("CLI flags --quota-used / --quota-remaining / --quota-reset (epoch reset converted)", async () => {
    const { s, e, report } = setup();
    await ingestAck(s, e);
    const body = path.join(s.dir, "b.md");
    fs.writeFileSync(body, "ok");
    const r = await s.run(["reply", e.id, "--status", "done", "--summary", "ok", "--body-file", body, "--quota-used", "40%", "--quota-remaining", "60%", "--quota-reset", "1794268800"]);
    expect(r.code).toBe(0);
    const t = fs.readFileSync(report, "utf8");
    expect(t.startsWith("就绪：ok\n\nok\n\n---\n")).toBe(true);
    expect(t).toContain(`Grok Bot额度（周额度，非本单消耗）：已用 40%，剩余 60%，重置：北京时间 ${beijing(1794268800_000)}\n`);
    expect(t).toMatch(/任务执行：开始 北京时间 2026-11-07 10:00:00，完成 北京时间 \d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}，耗时 \S+\n$/);
  });

  it("quota is not part of the envelope: the reply envelope has no quota/footer, and URLs/secrets in quota are refused", async () => {
    const { s, e, report } = setup();
    await ingestAck(s, e);
    const bad = await reply(s, e.id, { status: "done", quota: { used: "see https://example.invalid/usage" } });
    expect(bad.code).not.toBe(0);
    expect(fs.existsSync(report)).toBe(false);
    const bad2 = await reply(s, e.id, { status: "done", quota: { reset: "Bearer abcdefghijklmnop" } });
    expect(bad2.code).not.toBe(0);
    const ok = await reply(s, e.id, { status: "done", quota: { used: "1", remaining: "2", reset: "3" } }, ["--json"]);
    expect(ok.code).toBe(0);
    const env = JSON.parse(fs.readFileSync(path.join(s.inbox, "msg", "to-dispatcher", "unread", `${ok.json().reply_id}.json`), "utf8"));
    expect(env).not.toHaveProperty("quota");
    expect(JSON.stringify(env)).not.toContain("Grok Bot额度");
    const f = footerOf(fs.readFileSync(report, "utf8"));
    expect(f).not.toMatch(/:\/\/|bearer|webhook|secret|token/i);
  });

  it("redelivery / resend of the same reply writes the same bytes (footer fixed in the intent)", async () => {
    const { s, e, report } = setup();
    await ingestAck(s, e);
    const obj = { id: "11111111-2222-4333-8444-555555555555", status: "done", quota: { used: "a", remaining: "b", reset: "c" } };
    expect((await reply(s, e.id, obj)).code).toBe(0);
    const first = fs.readFileSync(report);
    patchReceipt(s, e.id, (r) => (r.acked_at = "2026-11-07T00:00:00Z"));
    await reply(s, e.id, obj);
    expect(fs.readFileSync(report).equals(first)).toBe(true);
  });
});
