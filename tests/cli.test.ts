import * as fs from "node:fs";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { fixture, sandbox, task, uuid } from "./helpers.js";

describe("basic CLI", () => {
  it("help, version, unknown command, bad flag", async () => {
    const s = sandbox();
    const h = await s.run(["--help"]);
    expect(h.code).toBe(0);
    expect(h.out).toMatch(/Exit codes/);
    expect(h.out).toMatch(/中文/);
    expect((await s.run(["--version"])).out.trim()).toBe("0.1.0");
    expect((await s.run(["frobnicate"])).code).toBe(2);
    expect((await s.run(["status", "--nope"])).code).toBe(2);
  });
  it("guide is Chinese", async () => {
    const r = await sandbox().run(["guide"]);
    expect(r.code).toBe(0);
    expect(r.out).toMatch(/使用指引/);
  });
  it("init writes the example config once and creates the inbox", async () => {
    const s = sandbox();
    const cfg = path.join(s.dir, "fresh", "wake-grokbot.json");
    const r = await s.run(["--config", cfg, "init"]);
    expect(r.code).toBe(0);
    expect(fs.existsSync(cfg)).toBe(true);
    fs.appendFileSync(cfg, " ");
    const r2 = await s.run(["--config", cfg, "init"]);
    expect(r2.out).toMatch(/left as is/);
    expect(fs.readFileSync(cfg, "utf8").endsWith(" ")).toBe(true);
    expect((await s.run(["init", "--print-config"])).out).toMatch(/WAKE_GROKBOT_KEY/);
  });
  it("init with no explicit config uses the temp APPDATA/XDG folder", async () => {
    const s = sandbox();
    const { main } = await import("../src/main.js");
    const { Readable } = await import("node:stream");
    let out = "";
    const code = await main(["init"], { stdin: Readable.from([]), out: (x) => (out += x), err: () => {}, env: s.env });
    expect(code).toBe(0);
    expect(out).toContain(path.join(s.dir, "home"));
  });
});

describe("send / status / ack / reply without a wake target", () => {
  it("send --json writes the message and receipt, wake none, exit 0", async () => {
    const s = sandbox();
    const e = task();
    const r = await s.run(["send", "--json", "--json"], JSON.stringify(e));
    expect(r.code).toBe(0);
    expect(r.json().wake.state).toBe("none");
    expect(fs.existsSync(path.join(s.inbox, "msg", "to-worker", "unread", `${e.id}.json`))).toBe(true);
    const st = await s.run(["status", e.id, "--json"]);
    expect(st.json().status).toBe("queued");
  });
  it("send from flags generates an id", async () => {
    const s = sandbox();
    const r = await s.run(["send", "--to", "worker", "--title", "Hello", "--acceptance", "a", "--acceptance", "b"]);
    expect(r.code).toBe(0);
    const id = /accepted ([0-9a-f-]{36})/.exec(r.out)![1]!;
    const env = JSON.parse(fs.readFileSync(path.join(s.inbox, "msg", "to-worker", "unread", `${id}.json`), "utf8"));
    expect(env.acceptance).toEqual(["a", "b"]);
    expect(env.objective).toBe("Hello");
  });
  it("messages to anyone but the worker land on the dispatcher side", async () => {
    const s = sandbox();
    const e = fixture("answer-needs-input.json");
    e.id = uuid();
    expect((await s.run(["send", "--json"], JSON.stringify(e))).code).toBe(0);
    expect(fs.existsSync(path.join(s.inbox, "msg", "to-dispatcher", "unread", `${e.id}.json`))).toBe(true);
  });
  it("idempotency: same id + same content → same receipt (0); different content → 7, nothing written", async () => {
    const s = sandbox();
    const e = task();
    const a = await s.run(["send", "--json", "--json"], JSON.stringify(e));
    const b = await s.run(["send", "--json", "--json"], JSON.stringify(e));
    expect(b.code).toBe(0);
    expect(b.json()).toEqual(a.json());
    const c = await s.run(["send", "--json"], JSON.stringify({ ...e, title: "Other" }));
    expect(c.code).toBe(7);
    const stored = JSON.parse(fs.readFileSync(path.join(s.inbox, "msg", "to-worker", "unread", `${e.id}.json`), "utf8"));
    expect(stored.title).toBe("Do a thing");
  });
  it("invalid envelope → exit 1; invalid JSON → exit 2", async () => {
    const s = sandbox();
    expect((await s.run(["send", "--json"], JSON.stringify(fixture("invalid/url-in-body.json")))).code).toBe(1);
    expect((await s.run(["send", "--json"], "{not json")).code).toBe(2);
  });
  it("send --json from a file", async () => {
    const s = sandbox();
    const f = path.join(s.dir, "e.json");
    fs.writeFileSync(f, "\uFEFF" + JSON.stringify(task()));
    expect((await s.run(["send", "--json", f])).code).toBe(0);
  });
  it("ack moves the message to read and sets working", async () => {
    const s = sandbox();
    const e = task();
    await s.run(["send", "--json"], JSON.stringify(e));
    const r = await s.run(["ack", e.id, "--json"]);
    expect(r.code).toBe(0);
    expect(r.json().status).toBe("working");
    expect(r.json().acked_at).toBeTruthy();
    expect(fs.existsSync(path.join(s.inbox, "msg", "to-worker", "read", `${e.id}.json`))).toBe(true);
    expect((await s.run(["ack", uuid()])).code).toBe(1);
  });
  it("reply needs_input requires a question; done writes an answer envelope back", async () => {
    const s = sandbox();
    const e = task();
    await s.run(["send", "--json"], JSON.stringify(e));
    expect((await s.run(["reply", e.id, "--status", "needs_input", "--summary", "?"])).code).toBe(1);
    expect((await s.run(["reply", e.id, "--status", "bogus"])).code).toBe(2);
    const q = await s.run(["reply", e.id, "--status", "needs_input", "--summary", "which one?", "--question", "A or B?", "--json"]);
    expect(q.code).toBe(0);
    expect(q.json().status).toBe("needs_input");
    const body = path.join(s.dir, "body.md");
    fs.writeFileSync(body, "All done.\n");
    const d = await s.run(["reply", e.id, "--status", "done", "--summary", "finished", "--next", "review", "--body-file", body, "--json"]);
    expect(d.code).toBe(0);
    const rec = d.json();
    expect(rec.status).toBe("done");
    expect(rec.next).toBe("review");
    expect(rec.replies).toHaveLength(2);
    const replyEnv = JSON.parse(fs.readFileSync(path.join(s.inbox, "msg", "to-dispatcher", "unread", `${rec.reply_id}.json`), "utf8"));
    expect(replyEnv).toMatchObject({ type: "receipt", from: "worker", to: "dispatcher", status: "done", thread: e.id, body: "All done.\n" });
  });
  it("reply --json takes a partial envelope from stdin", async () => {
    const s = sandbox();
    const e = task();
    await s.run(["send", "--json"], JSON.stringify(e));
    const r = await s.run(["reply", e.id, "--json"], JSON.stringify({ status: "blocked", summary: "no access" }));
    expect(r.code).toBe(0);
    expect(r.json().status).toBe("blocked");
  });
  it("status of an unknown id → 1; status overview works", async () => {
    const s = sandbox();
    expect((await s.run(["status", uuid()])).code).toBe(1);
    const o = await s.run(["status"]);
    expect(o.code).toBe(0);
    expect(o.out).toMatch(/kill switch: off/);
  });
});

describe("ingest and signatures", () => {
  it("ingest needs a configured source and a matching from", async () => {
    const s = sandbox({ sources: { "my-engine": { require_sig: false } } });
    const e = fixture("task-command.json");
    e.id = uuid();
    expect((await s.run(["ingest", "-"], JSON.stringify(e))).code).toBe(2);
    expect((await s.run(["ingest", "--from", "other", "-"], JSON.stringify(e))).code).toBe(2);
    expect((await s.run(["ingest", "--from", "my-engine", "-"], JSON.stringify(e))).code).toBe(1);
    const r = await s.run(["ingest", "--from", "my-engine", "-", "--json"], JSON.stringify({ ...e, from: "my-engine" }));
    expect(r.code).toBe(0);
    expect(r.json().ingested_from).toBe("my-engine");
  });
  it("send signs when a key is configured; tampering or missing sigs fail with 4", async () => {
    const s0 = sandbox();
    const keyFile = path.join(s0.dir, "sign.key");
    fs.writeFileSync(keyFile, "a-signing-key-of-decent-length\n");
    const s = sandbox({ sign: { key_file: keyFile, require: true }, sources: { ext: { require_sig: true } } });
    const e = task();
    expect((await s.run(["send", "--json"], JSON.stringify(e))).code).toBe(4); // require + unsigned
    const { sign } = await import("../src/envelope.js");
    const signed = { ...e, sig: sign(e as never, Buffer.from("a-signing-key-of-decent-length")) };
    expect((await s.run(["send", "--json"], JSON.stringify(signed))).code).toBe(0);
    const t = task();
    const bad = { ...t, sig: sign(t as never, Buffer.from("a-signing-key-of-decent-length")), title: "tampered" };
    expect((await s.run(["send", "--json"], JSON.stringify(bad))).code).toBe(4);
    const ext = task({ from: "ext" });
    expect((await s.run(["ingest", "--from", "ext", "-"], JSON.stringify(ext))).code).toBe(4);
  });
  it("signs outgoing envelopes when a key is configured but not required", async () => {
    const s0 = sandbox();
    const keyFile = path.join(s0.dir, "sign.key");
    fs.writeFileSync(keyFile, "a-signing-key-of-decent-length");
    const s = sandbox({ sign: { key_file: keyFile } });
    const e = task();
    expect((await s.run(["send", "--json"], JSON.stringify(e))).code).toBe(0);
    const stored = JSON.parse(fs.readFileSync(path.join(s.inbox, "msg", "to-worker", "unread", `${e.id}.json`), "utf8"));
    expect(stored.sig).toMatch(/^hmac-sha256:[0-9a-f]{64}$/);
  });
  it("too-short signing key is refused", async () => {
    const s0 = sandbox();
    const keyFile = path.join(s0.dir, "k");
    fs.writeFileSync(keyFile, "short");
    const s = sandbox({ sign: { key_file: keyFile } });
    const r = await s.run(["send", "--json"], JSON.stringify(task()));
    expect(r.code).toBe(2);
    expect(r.err).not.toContain("short");
  });
});
