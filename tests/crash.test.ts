import { spawn, spawnSync } from "node:child_process";
import * as fs from "node:fs";
import { createRequire } from "node:module";
import * as os from "node:os";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";
import { Engine } from "../src/core.js";
import { grokCfg, KEY, sandbox, stub, task } from "./helpers.js";

// Real child processes need compiled JS: build src into a temp folder once.
const root = path.join(import.meta.dirname, "..");
let dist = "";
beforeAll(() => {
  dist = fs.mkdtempSync(path.join(os.tmpdir(), "wgb-dist-"));
  const tsc = createRequire(import.meta.url).resolve("typescript/bin/tsc");
  const r = spawnSync(process.execPath, [tsc, "-p", path.join(root, "tsconfig.build.json"), "--outDir", dist], { encoding: "utf8" });
  if (r.status !== 0) throw new Error(`build failed: ${r.stdout}${r.stderr}`);
}, 120_000);
afterAll(() => fs.rmSync(dist, { recursive: true, force: true }));

type Box = ReturnType<typeof sandbox>;

/** A child process that runs `main` for each argv in turn (stdin per call), printing one JSON line per result. */
function child(s: Box, calls: { args: string[]; stdin?: string }[]) {
  const mainUrl = pathToFileURL(path.join(dist, "main.js")).href;
  const code = `
    import { Readable } from "node:stream";
    const { main } = await import(${JSON.stringify(mainUrl)});
    const calls = JSON.parse(process.env.WGB_CALLS);
    for (const c of calls) {
      let out = "";
      const code = await main(["--config", ${JSON.stringify(s.cfgPath)}, ...c.args], {
        stdin: Readable.from([Buffer.from(c.stdin ?? "")]), out: (x) => (out += x), err: () => {}, env: process.env,
      });
      process.stdout.write(JSON.stringify({ code, out }) + "\\n");
    }`;
  const p = spawn(process.execPath, ["--input-type=module", "-e", code], { env: { ...s.env, WGB_CALLS: JSON.stringify(calls) }, stdio: ["ignore", "pipe", "pipe"] });
  let out = "";
  p.stdout.on("data", (d) => (out += d));
  const done = new Promise<{ code: number | null; results: { code: number; out: string }[] }>((ok) =>
    p.on("close", (code) => ok({ code, results: out.trim() ? out.trim().split("\n").map((l) => JSON.parse(l)) : [] })),
  );
  return { p, done };
}

const files = (d: string) => (fs.existsSync(d) ? fs.readdirSync(d) : []);

describe("crash and concurrency (real child processes)", () => {
  it("two processes sending at once: unique ids, every receipt intact, no lost or duplicate files", async () => {
    const srv = await stub(() => ({ status: 200 }));
    const s = sandbox(grokCfg(), { WAKE_GROKBOT_URL: srv.url, WAKE_GROKBOT_KEY: KEY });
    const K = 15;
    const shared = task();
    const calls = (tag: string) => [
      ...Array.from({ length: K }, (_, i) => ({ args: ["send", "--to", "worker", "--title", `${tag}-${i}`] })),
      { args: ["send", "--json", "--json"], stdin: JSON.stringify(shared) },
    ];
    const [a, b] = [child(s, calls("a")), child(s, calls("b"))];
    const [ra, rb] = await Promise.all([a.done, b.done]);
    expect(ra.code).toBe(0);
    expect(rb.code).toBe(0);
    const results = [...ra.results, ...rb.results];
    expect(results).toHaveLength(2 * (K + 1));
    for (const r of results) expect([0, 5]).toContain(r.code); // 0 woken/coalesced; never an internal error
    const ids = results.map((r) => (r.out.trimStart().startsWith("{") ? (JSON.parse(r.out).id as string) : /accepted ([0-9a-f-]{36})/.exec(r.out)![1]!));
    const generated = ids.filter((id) => id !== shared.id);
    expect(generated).toHaveLength(2 * K);
    expect(new Set(generated).size).toBe(2 * K);
    expect(ids.filter((id) => id === shared.id)).toHaveLength(2);

    const inbox = s.inbox;
    const msgs = [...files(path.join(inbox, "msg/to-worker/unread")), ...files(path.join(inbox, "msg/to-worker/read"))];
    const receipts = files(path.join(inbox, "receipts"));
    expect(msgs.sort()).toEqual([...new Set([...generated, shared.id])].map((id) => `${id}.json`).sort());
    expect(receipts.sort()).toEqual(msgs.sort());
    for (const f of receipts) {
      const r = JSON.parse(fs.readFileSync(path.join(inbox, "receipts", f), "utf8"));
      expect(`${r.id}.json`).toBe(f);
      expect(["started", "coalesced", "queued"]).toContain(r.wake.state);
    }
    for (const d of ["receipts", "msg/to-worker/unread", "msg/to-worker/read"]) expect(files(path.join(inbox, d)).filter((f) => f.endsWith(".tmp"))).toEqual([]);
    expect(files(s.state).filter((f) => f.endsWith(".tmp") || f === "state.lock")).toEqual([]);
    const ob = JSON.parse(fs.readFileSync(path.join(s.state, "outbox.json"), "utf8"));
    const t = ob.targets.grokbot;
    // every id is either covered by the wake in flight or queued for the next one: none lost, none twice
    const tracked = [...(t.inflight?.ids ?? []), ...t.queue];
    const woken = srv.hits.flatMap((h) => JSON.parse(h.body).wake.ids as string[]);
    expect(new Set(woken).size).toBe(woken.length);
    for (const id of new Set([...generated, shared.id])) expect(woken.includes(id) || tracked.includes(id)).toBe(true);
  }, 60_000);

  it("killed mid-send: recovers as unknown and is never resent automatically", async () => {
    let hit!: () => void;
    const gotHit = new Promise<void>((ok) => (hit = ok));
    const srv = await stub(() => {
      hit();
      return { status: 200, hang: true };
    });
    const s = sandbox(grokCfg({ wake: { timeout_seconds: 30 } }), { WAKE_GROKBOT_URL: srv.url, WAKE_GROKBOT_KEY: KEY });
    const e = task();
    const c = child(s, [{ args: ["send", "--json", "--json"], stdin: JSON.stringify(e) }]);
    await gotHit;
    c.p.kill("SIGKILL");
    const r = await c.done;
    expect(r.results).toEqual([]); // died before answering
    expect(srv.hits).toHaveLength(1);

    const read = () => JSON.parse(fs.readFileSync(path.join(s.inbox, "receipts", `${e.id}.json`), "utf8"));
    const ob = () => JSON.parse(fs.readFileSync(path.join(s.state, "outbox.json"), "utf8")).targets.grokbot;
    expect(ob().inflight).toMatchObject({ ids: [e.id], sending: true });

    // Right after the crash: the wake is still considered in flight, nothing is sent.
    expect((await s.run(["watch", "--once"])).code).toBe(0);
    expect(srv.hits).toHaveLength(1);

    // Once the send window (3 x timeout) has passed: recovered as unknown, not re-queued, not resent.
    const l = loadConfig({ config: s.cfgPath, env: s.env });
    const later = Date.now() + 3 * 30_000 + 1000;
    await new Engine(l, { env: s.env, now: () => later }).pump();
    expect(read().wake.state).toBe("unknown");
    expect(read().wake.detail).toContain("outcome unknown");
    expect(ob().inflight).toBeNull();
    expect(ob().queue).not.toContain(e.id);
    await new Engine(l, { env: s.env, now: () => later + 60_000 }).pump();
    // the same id again stays idempotent and reports unknown (exit 6) without a new wake
    expect((await s.run(["send", "--json"], JSON.stringify(e))).code).toBe(6);
    expect(srv.hits).toHaveLength(1);
    expect(files(s.state).filter((f) => f.endsWith(".tmp"))).toEqual([]);
  }, 60_000);
});
