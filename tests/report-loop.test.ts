/**
 * The report-file + .DONE loop, end to end, using only the public fixture task-hufu-report.json.
 * An engine ingests the task, the worker acks and replies; the hufu-report sink writes the report, then `.DONE`.
 * Everything happens in a fresh temp folder.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { fixture, sandbox } from "./helpers.js";

function setup() {
  const base = sandbox();
  const root = path.join(base.dir, "reports");
  fs.mkdirSync(root);
  const s = sandbox({ sources: { "my-engine": { require_sig: false } }, sinks: { report_roots: [root] } });
  const e = fixture("task-hufu-report.json");
  e.reply_to.report_path = path.join(root, path.basename(e.reply_to.report_path));
  return { s, e, root, report: e.reply_to.report_path as string };
}

describe("report file + .DONE loop (public fixture task-hufu-report.json)", () => {
  it("ingest → ack → reply done writes the report, then .DONE; first line is `就绪：<summary>`", async () => {
    const { s, e, report } = setup();
    const ing = await s.run(["ingest", "--from", "my-engine", "-", "--json"], JSON.stringify(e));
    expect(ing.code).toBe(0);
    expect(ing.json()).toMatchObject({ id: e.id, from: "my-engine", status: "queued", ingested_from: "my-engine" });
    expect(fs.existsSync(report)).toBe(false);

    const ack = await s.run(["ack", e.id, "--json"]);
    expect(ack.code).toBe(0);
    expect(ack.json().status).toBe("working");

    const body = path.join(s.dir, "body.md");
    fs.writeFileSync(body, "Build #42 passed.\nNo warnings.\n");
    const r = await s.run(["reply", e.id, "--status", "done", "--summary", "build passed", "--body-file", body, "--json"]);
    expect(r.code).toBe(0);
    const rec = r.json();
    expect(rec.status).toBe("done");
    expect(rec.replies.at(-1)).toMatchObject({ status: "done", sink: "hufu-report", sink_result: "ok: hufu-report build-summary.md" });

    const text = fs.readFileSync(report, "utf8");
    expect(text.split("\n")[0]).toBe("就绪：build passed");
    expect(text.startsWith("就绪：build passed\n\nBuild #42 passed.\nNo warnings.\n\n---\n")).toBe(true);
    expect(text).toMatch(/\n任务执行：开始 北京时间 \d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}，完成 北京时间 [^\n]+，耗时 [^\n]+\n$/);
    const done = JSON.parse(fs.readFileSync(report + ".DONE", "utf8"));
    expect(done).toMatchObject({ id: rec.reply_id, status: "done" });
    expect(Number.isNaN(Date.parse(done.at))).toBe(false);
    expect(fs.statSync(report + ".DONE").mtimeMs).toBeGreaterThanOrEqual(fs.statSync(report).mtimeMs);

    // the reply envelope also lands in the dispatcher-side inbox, threaded to the task
    const back = JSON.parse(fs.readFileSync(path.join(s.inbox, "msg", "to-dispatcher", "unread", `${rec.reply_id}.json`), "utf8"));
    expect(back).toMatchObject({ type: "receipt", from: "worker", to: "my-engine", status: "done", thread: e.id });
  });

  it("needs_input writes `等待：` plus a decision line; no .DONE for a non-terminal status; a later failed writes report and .DONE", async () => {
    const { s, e, report } = setup();
    await s.run(["ingest", "--from", "my-engine", "-"], JSON.stringify(e));
    const q = await s.run(["reply", e.id, "--status", "needs_input", "--summary", "which log?", "--question", "nightly or release?"]);
    expect(q.code).toBe(0);
    expect(fs.readFileSync(report, "utf8").split("\n").slice(0, 2)).toEqual(["等待：which log?", "待人工决定：nightly or release?"]);
    expect(fs.existsSync(report + ".DONE")).toBe(false); // v1: only terminal statuses write the marker
    expect((await s.run(["reply", e.id, "--status", "failed", "--summary", "log missing"])).code).toBe(0);
    expect(fs.readFileSync(report, "utf8").split("\n")[0]).toBe("失败：log missing");
    expect(JSON.parse(fs.readFileSync(report + ".DONE", "utf8")).status).toBe("failed");
  });

  it("the fixture's own report_path (outside the temp roots) is refused: exit 5, no files", async () => {
    const { s } = setup();
    const e = fixture("task-hufu-report.json");
    await s.run(["ingest", "--from", "my-engine", "-"], JSON.stringify(e));
    const r = await s.run(["reply", e.id, "--status", "done", "--summary", "x"]);
    expect(r.code).toBe(5);
    expect(fs.existsSync(e.reply_to.report_path)).toBe(false);
    expect(fs.existsSync(e.reply_to.report_path + ".DONE")).toBe(false);
  });
});
