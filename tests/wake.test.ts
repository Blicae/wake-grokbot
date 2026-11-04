import * as fs from "node:fs";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";
import { Engine } from "../src/core.js";
import { grokCfg, KEY, sandbox, stub, task } from "./helpers.js";

async function setup(reply?: Parameters<typeof stub>[0], extra: Record<string, any> = {}, env: Record<string, string> = {}) {
  const srv = await stub(reply);
  const s = sandbox(grokCfg(extra), { WAKE_GROKBOT_URL: srv.url, WAKE_GROKBOT_KEY: KEY, ...env });
  return { srv, s };
}

describe("grokbot wake channel", () => {
  it("2xx → started; Bearer key; summary payload only, no body", async () => {
    const { srv, s } = await setup();
    const e = task({ body: "SECRET-ISH BODY TEXT that must not be posted" });
    const r = await s.run(["send", "--json", "--json"], JSON.stringify(e));
    expect(r.code).toBe(0);
    expect(r.json().wake.state).toBe("started");
    expect(srv.hits).toHaveLength(1);
    const h = srv.hits[0]!;
    expect(h.headers.authorization).toBe(`Bearer ${KEY}`);
    const body = JSON.parse(h.body);
    expect(body.wake).toMatchObject({ id: e.id, type: "task", summary: "Do a thing", count: 1 });
    expect(body.wake.inbox_path).toContain("to-worker");
    expect(typeof body.text).toBe("string");
    expect(h.body).not.toContain("SECRET-ISH");
    expect(r.out).not.toContain(KEY);
  });
  it("payload_key and template are configurable", async () => {
    const { srv, s } = await setup(undefined, { target: { payload_key: "message", template: "wake {id} ({count})" } });
    const e = task();
    await s.run(["send", "--json"], JSON.stringify(e));
    expect(JSON.parse(srv.hits[0]!.body).message).toBe(`wake ${e.id} (1)`);
  });
  it("key via --key-stdin, pasted 'Authorization: Bearer' prefix stripped, never in argv", async () => {
    const srv = await stub();
    const s = sandbox(grokCfg({ target: { key_env: "UNSET_KEY_VAR" } }), { WAKE_GROKBOT_URL: srv.url });
    const f = path.join(s.dir, "e.json");
    fs.writeFileSync(f, JSON.stringify(task()));
    const r = await s.run(["send", "--json", f, "--key-stdin"], `Authorization: Bearer ${KEY}\n`);
    expect(r.code).toBe(0);
    expect(srv.hits[0]!.headers.authorization).toBe(`Bearer ${KEY}`);
    expect((await s.run(["send", "--json", "--key-stdin"], "{}")).code).toBe(2);
  });
  it("4xx → not started (exit 5), backoff, retried later by watch", async () => {
    const { srv, s } = await setup((_, n) => ({ status: n === 1 ? 400 : 200 }));
    const e = task();
    const r = await s.run(["send", "--json", "--json"], JSON.stringify(e));
    expect(r.code).toBe(5);
    expect(r.json().wake.state).toBe("not_started");
    await s.run(["watch", "--once"]);
    expect(srv.hits).toHaveLength(1); // still backing off
    const ob = JSON.parse(fs.readFileSync(path.join(s.state, "outbox.json"), "utf8"));
    ob.targets.grokbot.next_at = new Date(Date.now() - 1000).toISOString();
    fs.writeFileSync(path.join(s.state, "outbox.json"), JSON.stringify(ob));
    await s.run(["watch", "--once"]);
    expect(srv.hits).toHaveLength(2);
    expect((await s.run(["status", e.id, "--json"])).json().wake.state).toBe("started");
  });
  it("5xx → unknown (exit 6), never resent automatically, reconciled by hand", async () => {
    const { srv, s } = await setup((_, n) => ({ status: n === 1 ? 502 : 200 }));
    const e = task();
    expect((await s.run(["send", "--json"], JSON.stringify(e))).code).toBe(6);
    await s.run(["watch", "--once"]);
    const e2 = task();
    const r2 = await s.run(["send", "--json", "--json"], JSON.stringify(e2));
    expect(r2.json().wake.state).toBe("coalesced");
    expect(srv.hits).toHaveLength(1);
    // the same id again is idempotent and still reports unknown
    expect((await s.run(["send", "--json"], JSON.stringify(e))).code).toBe(6);
    expect(srv.hits).toHaveLength(1);
    const m = await s.run(["status", e.id, "--mark-wake", "not_started", "--json"]);
    expect(m.code).toBe(0);
    expect(srv.hits).toHaveLength(2);
    const sent = JSON.parse(srv.hits[1]!.body).wake;
    expect(sent.ids).toEqual([e.id, e2.id]);
  });
  it("timeout → unknown (exit 6)", async () => {
    const { s } = await setup(() => ({ status: 200, delayMs: 3000 }), { wake: { timeout_seconds: 1 } });
    const r = await s.run(["send", "--json", "--json"], JSON.stringify(task()));
    expect(r.code).toBe(6);
    expect(r.json().wake.detail).toMatch(/timed out/);
  });
  it("redirects are refused, not followed", async () => {
    const srv2 = await stub();
    const { srv, s } = await setup(() => ({ status: 302, headers: { location: srv2.url } }));
    const r = await s.run(["send", "--json", "--json"], JSON.stringify(task()));
    expect(r.code).toBe(5);
    expect(r.json().wake.detail).toMatch(/redirect refused/);
    expect(srv.hits).toHaveLength(1);
    expect(srv2.hits).toHaveLength(0);
  });
  it("connection refused → not started (5)", async () => {
    const net = await import("node:net");
    const port = await new Promise<number>((ok) => {
      const srv = net.createServer().listen(0, "127.0.0.1", () => {
        const p = (srv.address() as { port: number }).port;
        srv.close(() => ok(p));
      });
    });
    const s = sandbox(grokCfg(), { WAKE_GROKBOT_URL: `http://127.0.0.1:${port}/hook`, WAKE_GROKBOT_KEY: KEY });
    expect((await s.run(["send", "--json"], JSON.stringify(task()))).code).toBe(5);
  });
  it("plain http to a non-loopback host is refused before any request", async () => {
    const s = sandbox(grokCfg(), { WAKE_GROKBOT_URL: "http://wake.example.invalid/hook", WAKE_GROKBOT_KEY: KEY });
    const r = await s.run(["send", "--json", "--json"], JSON.stringify(task()));
    expect(r.code).toBe(5);
    expect(r.json().wake.detail).toMatch(/https/);
    expect(r.out).not.toContain("wake.example.invalid");
  });
  it("missing key → not started, message names the variable but no secret", async () => {
    const srv = await stub();
    const s = sandbox(grokCfg(), { WAKE_GROKBOT_URL: srv.url });
    const r = await s.run(["send", "--json", "--json"], JSON.stringify(task()));
    expect(r.code).toBe(5);
    expect(r.json().wake.detail).toMatch(/WAKE_GROKBOT_KEY/);
    expect(srv.hits).toHaveLength(0);
  });
});

describe("coalescing", () => {
  it("one in-flight wake per target; later items ride on the next wake after ack", async () => {
    const { srv, s } = await setup();
    const a = task();
    const b = task();
    const c = task();
    expect((await s.run(["send", "--json", "--json"], JSON.stringify(a))).json().wake.state).toBe("started");
    expect((await s.run(["send", "--json", "--json"], JSON.stringify(b))).json().wake.state).toBe("coalesced");
    expect((await s.run(["send", "--json"], JSON.stringify(c))).code).toBe(0);
    expect(srv.hits).toHaveLength(1);
    await s.run(["ack", a.id]);
    expect(srv.hits).toHaveLength(2);
    expect(JSON.parse(srv.hits[1]!.body).wake).toMatchObject({ ids: [b.id, c.id], count: 2, id: c.id });
  });
  it("a reply also frees the target", async () => {
    const { srv, s } = await setup();
    const a = task();
    const b = task();
    await s.run(["send", "--json"], JSON.stringify(a));
    await s.run(["send", "--json"], JSON.stringify(b));
    await s.run(["reply", a.id, "--status", "done", "--summary", "ok"]);
    expect(srv.hits).toHaveLength(2);
  });
  it("in-flight expires after the TTL", async () => {
    const { srv, s } = await setup();
    await s.run(["send", "--json"], JSON.stringify(task()));
    await s.run(["send", "--json"], JSON.stringify(task()));
    const l = loadConfig({ config: s.cfgPath, env: s.env });
    const later = new Engine(l, { env: s.env, now: () => Date.now() + 31 * 60_000 });
    await later.pump();
    expect(srv.hits).toHaveLength(2);
  });
});

describe("outbox: backoff, dead state, caps", () => {
  it("gives up after max_attempts and marks the item dead", async () => {
    const { srv, s } = await setup(() => ({ status: 403 }), { wake: { max_attempts: 3 } });
    const e = task();
    await s.run(["send", "--json"], JSON.stringify(e));
    let t = Date.now();
    const l = loadConfig({ config: s.cfgPath, env: s.env });
    for (let i = 0; i < 3; i++) {
      t += 61 * 60_000;
      const now = t;
      await new Engine(l, { env: s.env, now: () => now }).pump();
    }
    expect(srv.hits).toHaveLength(3);
    const st = (await s.run(["status", e.id, "--json"])).json();
    expect(st.wake.state).toBe("dead");
    const ob = JSON.parse(fs.readFileSync(path.join(s.state, "outbox.json"), "utf8"));
    expect(ob.targets.grokbot.dead).toHaveLength(1);
    expect((await s.run(["doctor"])).out).toMatch(/dead wake/);
  });
  it("backoff doubles: 1, 2, 4 minutes", async () => {
    const { s } = await setup(() => ({ status: 429 }));
    await s.run(["send", "--json"], JSON.stringify(task()));
    const read = () => JSON.parse(fs.readFileSync(path.join(s.state, "outbox.json"), "utf8")).targets.grokbot;
    const l = loadConfig({ config: s.cfgPath, env: s.env });
    const first = Date.parse(read().next_at);
    const now2 = first + 1;
    await new Engine(l, { env: s.env, now: () => now2 }).pump();
    expect(Date.parse(read().next_at) - now2).toBe(2 * 60_000);
    expect(read().attempts).toBe(2);
  });
  it("hourly total cap", async () => {
    const { srv, s } = await setup(undefined, { wake: { hourly_cap: 2 } });
    for (let i = 0; i < 2; i++) {
      const e = task();
      await s.run(["send", "--json"], JSON.stringify(e));
      await s.run(["ack", e.id]);
    }
    const r = await s.run(["send", "--json", "--json"], JSON.stringify(task()));
    expect(r.code).toBe(5);
    expect(r.json().wake.state).toBe("capped");
    expect(srv.hits).toHaveLength(2);
  });
  it("per-routine cap", async () => {
    const { srv, s } = await setup(undefined, { target: { per_routine_hourly_cap: 1 } });
    const e = task();
    await s.run(["send", "--json"], JSON.stringify(e));
    await s.run(["ack", e.id]);
    const r = await s.run(["send", "--json", "--json"], JSON.stringify(task()));
    expect(r.json().wake.detail).toMatch(/routine r1/);
    expect(srv.hits).toHaveLength(1);
  });
});

describe("kill switch", () => {
  it("env WAKE_GROKBOT_DISABLED: message written, no wake, exit 5; resumes when cleared", async () => {
    const { srv, s } = await setup(undefined, {}, { WAKE_GROKBOT_DISABLED: "1" });
    const e = task();
    const r = await s.run(["send", "--json", "--json"], JSON.stringify(e));
    expect(r.code).toBe(5);
    expect(r.json().wake.state).toBe("disabled");
    expect(fs.existsSync(path.join(s.inbox, "msg", "to-worker", "unread", `${e.id}.json`))).toBe(true);
    expect(srv.hits).toHaveLength(0);
    expect((await s.run(["doctor"])).out).toMatch(/kill switch ON/);
    s.env.WAKE_GROKBOT_DISABLED = "0";
    await s.run(["watch", "--once"]);
    expect(srv.hits).toHaveLength(1);
  });
  it("a `disabled` file in the state folder", async () => {
    const { srv, s } = await setup();
    fs.mkdirSync(s.state, { recursive: true });
    fs.writeFileSync(path.join(s.state, "disabled"), "");
    expect((await s.run(["send", "--json"], JSON.stringify(task()))).code).toBe(5);
    expect(srv.hits).toHaveLength(0);
  });
});

describe("secret masking", () => {
  it("never prints the key or the URL, even in errors", async () => {
    const s = sandbox(grokCfg({ target: { url_env: "", url_file: "url.txt" } }), { WAKE_GROKBOT_KEY: KEY });
    fs.writeFileSync(path.join(s.dir, "url.txt"), "https://hooks.example.invalid/x?token=tok-fake-for-tests\n");
    const r = await s.run(["send", "--json", "--json"], JSON.stringify(task()));
    const all = r.out + r.err + fs.readFileSync(path.join(s.state, "wake.log"), "utf8");
    expect(all).not.toContain("tok-fake-for-tests");
    expect(all).not.toContain("hooks.example.invalid");
    expect(all).not.toContain(KEY);
    const d = await s.run(["doctor"]);
    expect(d.out + d.err).not.toContain("hooks.example.invalid");
    expect(d.out).toMatch(/not shown/);
  });
});

describe("script channel", () => {
  it("exit 0 → started (wake summary on stdin); exit 1 → not started", async () => {
    const s0 = sandbox();
    const out = path.join(s0.dir, "got.json");
    const ok = sandbox({
      wake: { targets: { worker: "sh" } },
      targets: { sh: { channel: "script", argv: [process.execPath, "-e", `require('fs').writeFileSync(${JSON.stringify(out)}, require('fs').readFileSync(0))`] } },
    });
    const e = task();
    expect((await ok.run(["send", "--json"], JSON.stringify(e))).code).toBe(0);
    expect(JSON.parse(fs.readFileSync(out, "utf8")).id).toBe(e.id);
    const bad = sandbox({ wake: { targets: { worker: "sh" } }, targets: { sh: { channel: "script", argv: [process.execPath, "-e", "process.exit(1)"] } } });
    expect((await bad.run(["send", "--json"], JSON.stringify(task()))).code).toBe(5);
  });
});
