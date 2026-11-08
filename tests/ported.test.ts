/** Scenarios carried over from the Python 0.7.0 suite. */
import * as fs from "node:fs";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { registerChannel } from "../src/channels/index.js";
import { EXAMPLE_CONFIG } from "../src/config.js";
import { grokCfg, KEY, sandbox, stub, task } from "./helpers.js";

describe("ported from the Python suite", () => {
  it("watch --once is idle and quiet without any channel", async () => {
    const r = await sandbox().run(["watch", "--once"]);
    expect(r.code).toBe(0);
    expect(r.out).toBe("");
  });
  it("nothing new: watch sends no wake", async () => {
    const srv = await stub();
    const s = sandbox(grokCfg(), { WAKE_GROKBOT_URL: srv.url, WAKE_GROKBOT_KEY: KEY });
    await s.run(["watch", "--once"]);
    expect(srv.hits).toHaveLength(0);
  });
  it("doctor checks the channel but sends nothing", async () => {
    const srv = await stub();
    const s = sandbox(grokCfg(), { WAKE_GROKBOT_URL: srv.url, WAKE_GROKBOT_KEY: KEY });
    const d = await s.run(["doctor"]);
    expect(d.code).toBe(0);
    expect(d.out).toMatch(/target grokbot: grokbot routine r1/);
    expect(srv.hits).toHaveLength(0);
    const bad = sandbox(grokCfg(), {});
    expect((await bad.run(["doctor"])).code).toBe(2);
  });
  it("unknown channel is a config error (exit 2)", async () => {
    const s = sandbox({ targets: { x: { channel: "carrier-pigeon" } } });
    const r = await s.run(["status"]);
    expect(r.code).toBe(2);
    expect(r.err).toMatch(/unknown channel/);
  });
  it("a URL inside the config is refused", async () => {
    const s = sandbox({ targets: { g: { channel: "grokbot", url_env: "https://hooks.example.invalid/x" } } });
    const r = await s.run(["status"]);
    expect(r.code).toBe(2);
    expect(r.err).not.toContain("hooks.example.invalid");
  });
  it("url_file and template", async () => {
    const srv = await stub();
    const s = sandbox(grokCfg({ target: { url_env: "", url_file: "hook.url", template: "{type}:{summary}" } }), { WAKE_GROKBOT_KEY: KEY });
    fs.writeFileSync(path.join(s.dir, "hook.url"), "\uFEFF" + srv.url + "\r\n");
    expect((await s.run(["send", "--json"], JSON.stringify(task()))).code).toBe(0);
    expect(JSON.parse(srv.hits[0]!.body).text).toBe("task:Do a thing");
  });
  it("plugin channels can be registered", async () => {
    const seen: string[] = [];
    registerChannel("test-plugin", (name) => ({
      check() {},
      describe: () => `plugin ${name}`,
      async wake(p) {
        seen.push(p.id);
        return { state: "started", detail: "ok" };
      },
    }));
    const s = sandbox({ wake: { targets: { worker: "p" } }, targets: { p: { channel: "test-plugin" } } });
    const e = task();
    expect((await s.run(["send", "--json"], JSON.stringify(e))).code).toBe(0);
    expect(seen).toEqual([e.id]);
  });
  it("the shipped example config matches the built-in template", () => {
    const file = JSON.parse(fs.readFileSync(path.join(import.meta.dirname, "..", "wake-grokbot.example.json"), "utf8"));
    expect(file).toEqual(EXAMPLE_CONFIG);
  });
  it("init --print-config writes nothing", async () => {
    const s = sandbox();
    const cfg = path.join(s.dir, "nope", "c.json");
    await s.run(["--config", cfg, "init", "--print-config"]);
    expect(fs.existsSync(cfg)).toBe(false);
  });
  it("sensitive data in a message is refused (exit 1) and nothing is written", async () => {
    const s = sandbox();
    const e = task({ body: "use Bearer abcdefghijklmnop" });
    expect((await s.run(["send", "--json"], JSON.stringify(e))).code).toBe(1);
    expect(fs.existsSync(path.join(s.inbox, "msg", "to-worker", "unread", `${e.id}.json`))).toBe(false);
  });
  it("message round trip: worker reads, acks, answers; dispatcher sees it", async () => {
    const s = sandbox();
    const e = task();
    await s.run(["send", "--json"], JSON.stringify(e));
    await s.run(["ack", e.id]);
    const r = await s.run(["reply", e.id, "--status", "done", "--summary", "ok", "--json"]);
    const id = r.json().reply_id as string;
    const st = await s.run(["status", id, "--json"]);
    expect(st.json()).toMatchObject({ from: "worker", to: "dispatcher", status: "done" });
    const ack2 = await s.run(["ack", id]);
    expect(ack2.code).toBe(0);
    expect(fs.existsSync(path.join(s.inbox, "msg", "to-dispatcher", "read", `${id}.json`))).toBe(true);
  });
  it("a terminal status is not overwritten by a later ack", async () => {
    const s = sandbox();
    const e = task();
    await s.run(["send", "--json"], JSON.stringify(e));
    await s.run(["reply", e.id, "--status", "failed", "--summary", "broke"]);
    expect((await s.run(["ack", e.id, "--json"])).json().status).toBe("failed");
  });
  it("Chinese text round-trips in envelopes and reports", async () => {
    const s = sandbox();
    const e = task({ title: "整理说明", objective: "把安装部分写清楚" });
    expect((await s.run(["send", "--json"], JSON.stringify(e))).code).toBe(0);
    const stored = JSON.parse(fs.readFileSync(path.join(s.inbox, "msg", "to-worker", "unread", `${e.id}.json`), "utf8"));
    expect(stored.title).toBe("整理说明");
  });
});
