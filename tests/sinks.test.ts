import { createHmac } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { renderReport } from "../src/sinks.js";
import { fixture, sandbox, stub, task } from "./helpers.js";

async function sendAndReply(s: ReturnType<typeof sandbox>, replyTo: object, args: string[] = ["--status", "done", "--summary", "all good"]) {
  const e = task({ reply_to: replyTo });
  expect((await s.run(["send", "--json"], JSON.stringify(e))).code).toBe(0);
  const r = await s.run(["reply", e.id, ...args, "--json"]);
  return { e, r };
}

describe("file sink", () => {
  it("writes the reply envelope into inbox/replies", async () => {
    const s = sandbox();
    const { e, r } = await sendAndReply(s, { sink: "file", file: "answer.json" });
    expect(r.code).toBe(0);
    const got = JSON.parse(fs.readFileSync(path.join(s.inbox, "replies", "answer.json"), "utf8"));
    expect(got).toMatchObject({ status: "done", thread: e.id, summary: "all good" });
    expect(r.json().replies[0].sink_result).toMatch(/^ok/);
  });
  it("honours sinks.file.dir", async () => {
    const s = sandbox({ sinks: { file: { dir: "out" } } });
    const { e } = await sendAndReply(s, { sink: "file" });
    expect(fs.readdirSync(path.join(s.dir, "out"))).toEqual([`${e.id}.reply.json`]);
  });
});

describe("webhook sink", () => {
  it("POSTs the reply with an HMAC-SHA256 signature; URL and secret only via config names", async () => {
    const srv = await stub();
    const s = sandbox({ sinks: { webhooks: { "my-hook": { url_env: "MY_HOOK_URL", secret_env: "MY_HOOK_SECRET" } } } }, { MY_HOOK_URL: srv.url, MY_HOOK_SECRET: "hook-secret-for-tests" });
    const { r } = await sendAndReply(s, { sink: "webhook", url_ref: "my-hook" });
    expect(r.code).toBe(0);
    const h = srv.hits[0]!;
    const ts = String(h.headers["x-wake-grokbot-timestamp"]);
    const want = "sha256=" + createHmac("sha256", "hook-secret-for-tests").update(`${ts}.${h.body}`).digest("hex");
    expect(h.headers["x-wake-grokbot-signature"]).toBe(want);
    expect(JSON.parse(h.body).status).toBe("done");
  });
  it("unknown webhook name, missing secret, redirect → reply stored but exit 5", async () => {
    const srv2 = await stub();
    const srv = await stub(() => ({ status: 307, headers: { location: srv2.url } }));
    const s = sandbox({ sinks: { webhooks: { h: { url_env: "H_URL", secret_env: "H_SECRET" }, nosecret: { url_env: "H_URL", secret_env: "UNSET" } } } }, { H_URL: srv.url, H_SECRET: "x-secret-value-1" });
    const a = await sendAndReply(s, { sink: "webhook", url_ref: "nope" });
    expect(a.r.code).toBe(5);
    expect(a.r.json().status).toBe("done");
    expect((await sendAndReply(s, { sink: "webhook", url_ref: "nosecret" })).r.code).toBe(5);
    const c = await sendAndReply(s, { sink: "webhook", url_ref: "h" });
    expect(c.r.code).toBe(5);
    expect(c.r.out).toMatch(/redirect refused/);
    expect(srv2.hits).toHaveLength(0);
    expect(c.r.out + c.r.err).not.toContain("127.0.0.1");
  });
});

describe("command sink", () => {
  it("runs the configured command with the reply on stdin", async () => {
    const s0 = sandbox();
    const out = path.join(s0.dir, "cmd.json");
    const s = sandbox({ sinks: { commands: { "my-engine": { argv: [process.execPath, "-e", `require('fs').writeFileSync(${JSON.stringify(out)}, require('fs').readFileSync(0))`] } } } });
    const { r } = await sendAndReply(s, { sink: "command", command_ref: "my-engine" });
    expect(r.code).toBe(0);
    expect(JSON.parse(fs.readFileSync(out, "utf8")).status).toBe("done");
  });
  it("non-zero exit or unknown name → exit 5", async () => {
    const s = sandbox({ sinks: { commands: { bad: { argv: [process.execPath, "-e", "process.exit(3)"] } } } });
    expect((await sendAndReply(s, { sink: "command", command_ref: "bad" })).r.code).toBe(5);
    expect((await sendAndReply(s, { sink: "command", command_ref: "nope" })).r.code).toBe(5);
  });
});

describe("hufu-report sink (Hufu-style report file)", () => {
  it("renders a status word first line and the decision line", () => {
    const base = fixture("answer-needs-input.json");
    const t = renderReport(base);
    const lines = t.split("\n");
    expect(lines[0]).toBe("等待：Two install paths exist; which one is primary?");
    expect(lines[1]).toBe("待人工决定：Should npx or a global install be the main instruction?");
    expect(renderReport({ ...base, status: "done", summary: "ok" }).split("\n")[0]).toBe("就绪：ok");
    const words = { working: "进展", blocked: "受阻", failed: "失败", declined: "无需处理" } as const;
    for (const [st, w] of Object.entries(words)) expect(renderReport({ ...base, status: st as never }).startsWith(w + "：")).toBe(true);
  });
  it("writes the report, then the .DONE marker", async () => {
    const s0 = sandbox();
    const root = path.join(s0.dir, "reports");
    fs.mkdirSync(root);
    const s = sandbox({ sinks: { report_roots: [root] } });
    const report = path.join(root, "sub", "r.md");
    fs.mkdirSync(path.dirname(report));
    const body = path.join(s.dir, "b.md");
    fs.writeFileSync(body, "Details here.");
    const { e, r } = await sendAndReply(s, { sink: "hufu-report", report_path: report }, ["--status", "done", "--summary", "finished it", "--body-file", body]);
    expect(r.code).toBe(0);
    expect(fs.readFileSync(report, "utf8")).toBe("就绪：finished it\n\nDetails here.\n");
    const done = JSON.parse(fs.readFileSync(report + ".DONE", "utf8"));
    expect(done.status).toBe("done");
    expect(fs.statSync(report + ".DONE").mtimeMs).toBeGreaterThanOrEqual(fs.statSync(report).mtimeMs);
    expect(e.id).toBeTruthy();
  });
  it("a stale .DONE is removed and not recreated when writing the report fails", async () => {
    const s0 = sandbox();
    const root = path.join(s0.dir, "reports");
    const report = path.join(root, "r.md");
    fs.mkdirSync(report, { recursive: true }); // a folder in the way: the report write fails
    fs.writeFileSync(report + ".DONE", "stale");
    const s = sandbox({ sinks: { report_roots: [root] } });
    const { r } = await sendAndReply(s, { sink: "hufu-report", report_path: report });
    expect(r.code).toBe(5);
    expect(fs.existsSync(report + ".DONE")).toBe(false);
  });
  it("rejects paths outside the allowed roots, traversal, relative paths and no roots", async () => {
    const s0 = sandbox();
    const root = path.join(s0.dir, "reports");
    fs.mkdirSync(root);
    const s = sandbox({ sinks: { report_roots: [root] } });
    for (const p of [path.join(s0.dir, "elsewhere.md"), path.join(root, "..", "escape.md"), "relative.md", root]) {
      const { r } = await sendAndReply(s, { sink: "hufu-report", report_path: p });
      expect(r.code, p).toBe(5);
    }
    expect(fs.existsSync(path.join(s0.dir, "escape.md"))).toBe(false);
    const none = sandbox();
    expect((await sendAndReply(none, { sink: "hufu-report", report_path: path.join(root, "x.md") })).r.code).toBe(5);
  });
  it.skipIf(process.platform === "win32")("rejects a symlink that escapes the root", async () => {
    const s0 = sandbox();
    const root = path.join(s0.dir, "reports");
    const outside = path.join(s0.dir, "outside");
    fs.mkdirSync(root);
    fs.mkdirSync(outside);
    fs.symlinkSync(outside, path.join(root, "link"));
    const s = sandbox({ sinks: { report_roots: [root] } });
    const { r } = await sendAndReply(s, { sink: "hufu-report", report_path: path.join(root, "link", "x.md") });
    expect(r.code).toBe(5);
    expect(fs.readdirSync(outside)).toEqual([]);
  });
});
