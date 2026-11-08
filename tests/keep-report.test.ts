import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { fixture, sandbox } from "./helpers.js";

async function setup() {
  const base = sandbox();
  const root = path.join(base.dir, "reports");
  fs.mkdirSync(root);
  const s = sandbox({ sources: { "my-engine": { require_sig: false } }, sinks: { report_roots: [root] } });
  const e = fixture("task-hufu-report.json");
  e.reply_to.report_path = path.join(root, "report.md");
  expect((await s.run(["ingest", "--from", "my-engine", "-"], JSON.stringify(e))).code).toBe(0);
  expect((await s.run(["ack", e.id])).code).toBe(0);
  return { s, e, report: e.reply_to.report_path as string };
}
const status = async (s: ReturnType<typeof sandbox>, id: string) => (await s.run(["status", id, "--json"])).json();

describe("keep-report public CLI and report delivery", () => {
  it("unowned existing report: exit 5, unchanged bytes and business status, pending reply visible", async () => {
    const { s, e, report } = await setup();
    const original = "就绪：已有报告\n\nhttps://example.invalid/result\n";
    fs.writeFileSync(report, original);
    const r = await s.run(["reply", e.id, "--status", "done", "--summary", "ready", "--json"]);
    expect(r.code).toBe(5);
    expect(fs.readFileSync(report, "utf8")).toBe(original);
    const rec = await status(s, e.id);
    expect(rec.status).toBe("working");
    expect(rec.replies.at(-1)).toMatchObject({ status: "done", delivery: { state: "not_sent" } });
    expect(fs.existsSync(report + ".DONE")).toBe(false);
  });
  it("A: keep-report adopts existing ready bytes including URLs and secrets without putting the body in the envelope", async () => {
    const { s, e, report } = await setup();
    const original = "就绪：保留原题\n\nhttps://example.invalid/result\nBearer abcdefghijklmnop\n";
    fs.writeFileSync(report, original);
    const r = await s.run(["reply", e.id, "--status", "done", "--keep-report", "--summary", "safe summary", "--json"]);
    expect(r.code).toBe(0);
    const bytes = fs.readFileSync(report);
    expect(bytes.toString().startsWith(original)).toBe(true);
    expect(bytes.toString()).toContain("\n---\n账号用量");
    const hash = createHash("sha256").update(bytes).digest("hex");
    expect(JSON.parse(fs.readFileSync(report + ".DONE", "utf8"))).toMatchObject({ format: "wake-report-done/1", task_id: e.id, status: "done", report_sha256: hash });
    expect(JSON.parse(fs.readFileSync(report + ".wake.json", "utf8"))).toMatchObject({ format: "wake-sink-state/1", task_id: e.id, status: "done", phase: "committed", report_sha256: hash });
    expect((await status(s, e.id)).status).toBe("done");
    expect(r.json().replies.at(-1).delivery.state).toBe("delivered");
    const env = JSON.parse(fs.readFileSync(path.join(s.inbox, "msg", "to-dispatcher", "unread", `${r.json().reply_id}.json`), "utf8"));
    expect(env).not.toHaveProperty("body");
    expect(env).not.toHaveProperty("keepReport");
    expect(JSON.stringify(env)).not.toMatch(/example.invalid|Bearer|keep.report/);
  });

  it("redeliver --keep-report repairs an unowned-file conflict without rendering the old envelope body", async () => {
    const { s, e, report } = await setup();
    const original = "就绪：磁盘标题\n\nhttps://example.invalid/authored\n";
    fs.writeFileSync(report, original);
    const r = await s.run(["reply", e.id, "--json", "-", "--json"], JSON.stringify({ status: "done", summary: "safe", body: "must not replace disk text" }));
    expect(r.code).toBe(5);
    const id = r.json().reply_id;
    expect((await s.run(["watch", "--once"])).code).toBe(0);
    expect((await s.run(["watch", "--once"])).code).toBe(0);
    expect((await status(s, e.id)).status).toBe("working");
    expect(fs.readFileSync(report, "utf8")).toBe(original);
    expect((await s.run(["redeliver", id, "--keep-report", "--json"])).code).toBe(0);
    const bytes = fs.readFileSync(report);
    expect(bytes.toString().startsWith(original)).toBe(true);
    expect(bytes.toString()).not.toContain("must not replace disk text");
    expect(JSON.parse(fs.readFileSync(report + ".DONE", "utf8")).report_sha256).toBe(createHash("sha256").update(bytes).digest("hex"));
    expect(JSON.parse(fs.readFileSync(report + ".wake.json", "utf8")).report_sha256).toBe(createHash("sha256").update(bytes).digest("hex"));
    expect((await status(s, e.id)).status).toBe("done");
    expect((await status(s, e.id)).replies.at(-1).delivery.state).toBe("delivered");
  });

  it("blocked keep-report preserves its header, without a terminal footer or marker", async () => {
    const { s, e, report } = await setup();
    const original = "受阻：等待外部资源\n\nhttps://example.invalid/context\n";
    fs.writeFileSync(report, original);
    const r = await s.run(["reply", e.id, "--status", "blocked", "--keep-report", "--summary", "waiting"]);
    expect(r.code).toBe(0);
    expect(fs.readFileSync(report, "utf8")).toBe(original);
    expect(fs.existsSync(report + ".DONE")).toBe(false);
    expect((await status(s, e.id)).status).toBe("blocked");
  });

  for (const mode of ["body-file", "JSON body", "empty JSON body"]) {
    it(`keep-report refuses ${mode} before changing the report or receipt`, async () => {
      const { s, e, report } = await setup();
      fs.writeFileSync(report, "就绪：existing\n");
      const before = await status(s, e.id);
      const body = path.join(s.dir, "body.md");
      fs.writeFileSync(body, "replacement");
      const r = mode === "body-file"
        ? await s.run(["reply", e.id, "--status", "done", "--keep-report", "--body-file", body])
        : await s.run(["reply", e.id, "--keep-report", "--json", "-"], JSON.stringify({ status: "done", body: mode === "empty JSON body" ? "" : "replacement" }));
      expect(r.code).toBe(2);
      expect(r.err).toContain("mutually exclusive");
      expect(fs.readFileSync(report, "utf8")).toBe("就绪：existing\n");
      expect(await status(s, e.id)).toEqual(before);
      expect(fs.existsSync(report + ".DONE")).toBe(false);
      expect(fs.existsSync(report + ".wake.json")).toBe(false);
    });
  }

  it("B: body-file without keep-report still generates the complete report", async () => {
    const { s, e, report } = await setup();
    const body = path.join(s.dir, "body.md");
    fs.writeFileSync(body, "authored body\n");
    expect((await s.run(["reply", e.id, "--status", "done", "--summary", "safe summary", "--body-file", body])).code).toBe(0);
    expect(fs.readFileSync(report, "utf8")).toMatch(/^就绪：safe summary\n\nauthored body\n\n---\n账号用量/);
    expect((await status(s, e.id)).status).toBe("done");
  });

  it("keep-report refuses a report owned by another task without changing either file", async () => {
    const { s, e, report } = await setup();
    fs.writeFileSync(report, "就绪：other task\n");
    const owner = JSON.stringify({ format: "wake-sink-state/1", task_id: "other-task", revision: 1 });
    fs.writeFileSync(report + ".wake.json", owner);
    expect((await s.run(["reply", e.id, "--status", "done", "--keep-report", "--summary", "safe"])).code).toBe(5);
    expect(fs.readFileSync(report, "utf8")).toBe("就绪：other task\n");
    expect(fs.readFileSync(report + ".wake.json", "utf8")).toBe(owner);
    expect((await status(s, e.id)).status).toBe("working");
    expect(fs.existsSync(report + ".DONE")).toBe(false);
  });

  it("keep-report refuses a missing report rather than generating one", async () => {
    const { s, e, report } = await setup();
    expect((await s.run(["reply", e.id, "--status", "done", "--keep-report", "--summary", "safe"])).code).toBe(5);
    expect((await status(s, e.id)).status).toBe("working");
    expect(fs.existsSync(report)).toBe(false);
    expect(fs.existsSync(report + ".wake.json")).toBe(false);
    expect(fs.existsSync(report + ".DONE")).toBe(false);
  });

  it("keep-report supplies a missing status line and footer and hashes the final bytes", async () => {
    const { s, e, report } = await setup();
    const original = "# Report\r\n\r\nhttps://example.invalid/original\r\n";
    fs.writeFileSync(report, original);
    expect((await s.run(["reply", e.id, "--status", "done", "--keep-report", "--summary", "safe"])).code).toBe(0);
    const bytes = fs.readFileSync(report);
    expect(bytes.toString().startsWith(`就绪：safe\n\n${original}`)).toBe(true);
    expect(bytes.toString()).toContain("\n---\n账号用量");
    expect(JSON.parse(fs.readFileSync(report + ".DONE", "utf8")).report_sha256).toBe(createHash("sha256").update(bytes).digest("hex"));
  });

  it("keep-report preserves an existing terminal footer byte for byte", async () => {
    const { s, e, report } = await setup();
    const original = "就绪：existing\n\nbody\n\n---\n账号用量：author supplied\n任务执行：author supplied\n";
    fs.writeFileSync(report, original);
    expect((await s.run(["reply", e.id, "--status", "done", "--keep-report", "--summary", "safe"])).code).toBe(0);
    expect(fs.readFileSync(report, "utf8")).toBe(original);
  });

  for (const summary of ["https://example.invalid/route", "Bearer abcdefghijklmnop"]) {
    it(`keep-report still refuses unsafe envelope summary ${summary.split(" ")[0]}`, async () => {
      const { s, e, report } = await setup();
      fs.writeFileSync(report, "就绪：existing\n");
      const before = await status(s, e.id);
      expect((await s.run(["reply", e.id, "--status", "done", "--keep-report", "--summary", summary])).code).toBe(1);
      expect(await status(s, e.id)).toEqual(before);
      expect(fs.readFileSync(report, "utf8")).toBe("就绪：existing\n");
      expect(fs.existsSync(report + ".DONE")).toBe(false);
    });
  }

  it("needs_input --question remains available", async () => {
    const { s, e, report } = await setup();
    expect((await s.run(["reply", e.id, "--status", "needs_input", "--question", "which option?", "--summary", "choose"])).code).toBe(0);
    expect(fs.readFileSync(report, "utf8")).toBe("等待：choose\n待人工决定：which option?\n\n\n");
    expect((await status(s, e.id)).status).toBe("needs_input");
    expect(fs.existsSync(report + ".DONE")).toBe(false);
  });

  it("terminal blocked closure: done keep-report preserves 受阻 and writes terminal ownership and checksum", async () => {
    const { s, e, report } = await setup();
    const original = "受阻：范围外资源未到位\n\nhttps://example.invalid/blocker\n";
    fs.writeFileSync(report, original);
    const r = await s.run(["reply", e.id, "--status", "done", "--keep-report", "--summary", "scope closed", "--json"]);
    expect(r.code).toBe(0);
    const bytes = fs.readFileSync(report);
    expect(bytes.toString().startsWith(original)).toBe(true);
    expect(bytes.toString()).not.toContain("就绪：");
    expect(bytes.toString()).toContain("\n---\n账号用量");
    const hash = createHash("sha256").update(bytes).digest("hex");
    expect(JSON.parse(fs.readFileSync(report + ".DONE", "utf8"))).toMatchObject({ format: "wake-report-done/1", task_id: e.id, status: "done", report_sha256: hash });
    expect(JSON.parse(fs.readFileSync(report + ".wake.json", "utf8"))).toMatchObject({ status: "done", report_sha256: hash, phase: "committed" });
    expect((await status(s, e.id)).status).toBe("done");
    const env = fs.readFileSync(path.join(s.inbox, "msg", "to-dispatcher", "unread", `${r.json().reply_id}.json`), "utf8");
    expect(JSON.parse(env)).not.toHaveProperty("body");
    expect(env).not.toContain("example.invalid");
  });

  for (const [header, terminal] of [["失败", "done"], ["受阻", "failed"]]) {
    it(`keep-report refuses mismatched ${header} header with ${terminal}`, async () => {
      const { s, e, report } = await setup();
      const original = `${header}：authored title\n\nbody\n`;
      fs.writeFileSync(report, original);
      expect((await s.run(["reply", e.id, "--status", terminal, "--keep-report", "--summary", "safe"])).code).toBe(5);
      expect(fs.readFileSync(report, "utf8")).toBe(original);
      expect((await status(s, e.id)).status).toBe("working");
      expect(fs.existsSync(report + ".wake.json")).toBe(false);
      expect(fs.existsSync(report + ".DONE")).toBe(false);
    });
  }

  for (const [terminal, header] of [["failed", "失败"], ["declined", "无需处理"]]) {
    it(`keep-report preserves matching ${terminal} title and writes its terminal marker`, async () => {
      const { s, e, report } = await setup();
      const original = `${header}：authored title\n\nbody\n`;
      fs.writeFileSync(report, original);
      expect((await s.run(["reply", e.id, "--status", terminal, "--keep-report", "--summary", "safe"])).code).toBe(0);
      expect(fs.readFileSync(report, "utf8").startsWith(original)).toBe(true);
      expect(JSON.parse(fs.readFileSync(report + ".DONE", "utf8")).status).toBe(terminal);
      expect((await status(s, e.id)).status).toBe(terminal);
    });
  }

  for (const existing of [false, true]) {
    it(`a marker alone cannot establish delivery or ownership (report exists: ${existing})`, async () => {
      const { s, e, report } = await setup();
      if (existing) fs.writeFileSync(report, "就绪：orphan\n");
      const marker = JSON.stringify({ format: "wake-report-done/1", task_id: e.id, status: "done", report_sha256: "invalid" });
      fs.writeFileSync(report + ".DONE", marker);
      expect((await s.run(["reply", e.id, "--status", "done", "--summary", "safe"])).code).toBe(5);
      expect((await status(s, e.id)).status).toBe("working");
      expect(fs.readFileSync(report + ".DONE", "utf8")).toBe(marker);
      expect(fs.existsSync(report + ".wake.json")).toBe(false);
    });
  }

  it("keep-report is the only adoption spelling; claim-report is not accepted", async () => {
    const { s, e, report } = await setup();
    fs.writeFileSync(report, "就绪：existing\n");
    expect((await s.run(["reply", e.id, "--status", "done", "--claim-report"])).code).toBe(2);
    expect((await status(s, e.id)).status).toBe("working");
  });

  it("an existing footer is detected by the separator and account line, not by rewritten content", async () => {
    const { s, e, report } = await setup();
    const original = "就绪：existing\n\nbody\n\n---\n账号用量：already supplied\n";
    fs.writeFileSync(report, original);
    expect((await s.run(["reply", e.id, "--status", "done", "--keep-report", "--summary", "safe"])).code).toBe(0);
    expect(fs.readFileSync(report, "utf8")).toBe(original);
  });

  it("a corrupt checksum is repaired, not accepted as a duplicate by keep-report", async () => {
    const { s, e, report } = await setup();
    const original = "就绪：authored\n\nhttps://example.invalid/keep\n";
    fs.writeFileSync(report, original);
    const r = await s.run(["reply", e.id, "--status", "done", "--summary", "safe", "--json"]);
    expect(r.code).toBe(5);
    const replyId = r.json().reply_id;
    const replyHash = (await status(s, replyId)).hash;
    const assoc = { task_id: e.id, revision: 1, reply_hash: replyHash, status: "done", report_sha256: "wrong-checksum" };
    fs.writeFileSync(report + ".wake.json", JSON.stringify({ format: "wake-sink-state/1", ...assoc, reply_id: replyId, phase: "committed" }));
    fs.writeFileSync(report + ".DONE", JSON.stringify({ format: "wake-report-done/1", ...assoc, id: replyId }));
    const delivered = await s.run(["redeliver", replyId, "--keep-report", "--json"]);
    expect(delivered.code).toBe(0);
    const rec = await status(s, e.id);
    expect(rec.replies.at(-1).delivery).toMatchObject({ state: "delivered", sink_state: "delivered" });
    const hash = createHash("sha256").update(fs.readFileSync(report)).digest("hex");
    expect(JSON.parse(fs.readFileSync(report + ".wake.json", "utf8")).report_sha256).toBe(hash);
    expect(JSON.parse(fs.readFileSync(report + ".DONE", "utf8")).report_sha256).toBe(hash);
    expect(fs.readFileSync(report, "utf8").startsWith(original)).toBe(true);
  });

  it("keep-report persists across recovery and only then completes the task", async () => {
    const { s, e, report } = await setup();
    expect((await s.run(["reply", e.id, "--status", "done", "--keep-report", "--summary", "safe"])).code).toBe(5);
    expect((await status(s, e.id)).status).toBe("working");
    fs.writeFileSync(report, "就绪：written after failed delivery\n");
    expect((await s.run(["watch", "--once"])).code).toBe(0);
    expect((await status(s, e.id)).status).toBe("done");
    expect((await status(s, e.id)).replies).toHaveLength(1);
    const first = fs.readFileSync(report);
    expect((await s.run(["watch", "--once"])).code).toBe(0);
    expect(fs.readFileSync(report)).toEqual(first);
    expect((await status(s, e.id)).replies).toHaveLength(1);
  });

  it("reply without a sink still commits terminal business status immediately", async () => {
    const s = sandbox({ sources: { "my-engine": { require_sig: false } } });
    const e = fixture("task-hufu-report.json");
    delete e.reply_to;
    expect((await s.run(["ingest", "--from", "my-engine", "-"], JSON.stringify(e))).code).toBe(0);
    expect((await s.run(["reply", e.id, "--status", "done", "--summary", "safe"])).code).toBe(0);
    expect((await status(s, e.id)).status).toBe("done");
  });

  it("a failed non-terminal sink write also leaves the prior business state intact", async () => {
    const { s, e, report } = await setup();
    fs.writeFileSync(report, "受阻：unowned report\n");
    expect((await s.run(["reply", e.id, "--status", "blocked", "--summary", "waiting"])).code).toBe(5);
    expect((await status(s, e.id)).status).toBe("working");
    expect((await status(s, e.id)).replies.at(-1).status).toBe("blocked");
  });

  it("redeliver keep-report also refuses body-file instead of silently ignoring it", async () => {
    const { s, e, report } = await setup();
    fs.writeFileSync(report, "就绪：existing\n");
    const r = await s.run(["reply", e.id, "--status", "done", "--summary", "safe", "--json"]);
    expect(r.code).toBe(5);
    const before = await status(s, e.id);
    const body = path.join(s.dir, "body.md");
    fs.writeFileSync(body, "replacement");
    expect((await s.run(["redeliver", r.json().reply_id, "--keep-report", "--body-file", body])).code).toBe(2);
    expect(await status(s, e.id)).toEqual(before);
    expect(fs.readFileSync(report, "utf8")).toBe("就绪：existing\n");
    expect(fs.existsSync(report + ".DONE")).toBe(false);
  });

});
