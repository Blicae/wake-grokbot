import * as fs from "node:fs";
import * as http from "node:http";
import type { AddressInfo } from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import { Readable } from "node:stream";
import { afterEach } from "vitest";
import { main } from "../src/main.js";
import { setRegistryReader } from "../src/winenv.js";

// Tests never read the real Windows registry; individual tests install a fake reader.
setRegistryReader(() => undefined);

const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  setRegistryReader(() => undefined);
  while (cleanups.length) await cleanups.pop()!();
});

export const KEY = "fake-key-for-tests";

/** An isolated sandbox: temp HOME/APPDATA/LOCALAPPDATA/XDG dirs and a config file. Never touches the real user folders. */
export function sandbox(cfg: Record<string, unknown> = {}, extraEnv: Record<string, string> = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wgb-"));
  cleanups.push(() => fs.rmSync(dir, { recursive: true, force: true }));
  const home = path.join(dir, "home");
  fs.mkdirSync(home);
  const env: NodeJS.ProcessEnv = {
    PATH: process.env.PATH,
    SystemRoot: process.env.SystemRoot,
    HOME: home,
    USERPROFILE: home,
    APPDATA: path.join(home, "AppData", "Roaming"),
    LOCALAPPDATA: path.join(home, "AppData", "Local"),
    XDG_CONFIG_HOME: path.join(home, ".config"),
    XDG_STATE_HOME: path.join(home, ".local", "state"),
    XDG_DATA_HOME: path.join(home, ".local", "share"),
    WAKE_GROKBOT_STATE: path.join(dir, "state"),
    ...extraEnv,
  };
  const cfgPath = path.join(dir, "wake-grokbot.json");
  fs.writeFileSync(cfgPath, JSON.stringify({ inbox: "inbox", ...cfg }, null, 2));
  const inbox = path.join(dir, "inbox");
  const run = async (args: string[], stdin = "") => {
    let out = "";
    let err = "";
    const code = await main(["--config", cfgPath, ...args], {
      stdin: Readable.from([Buffer.from(stdin)]),
      out: (s) => (out += s),
      err: (s) => (err += s),
      env,
    });
    return { code, out, err, json: () => JSON.parse(out) as Record<string, any> };
  };
  return { dir, env, cfgPath, inbox, state: env.WAKE_GROKBOT_STATE!, run };
}

export interface Hit {
  method: string;
  url: string;
  headers: http.IncomingHttpHeaders;
  body: string;
}

/** Local stub HTTP server on 127.0.0.1. `reply` decides each response. */
export async function stub(reply: (hit: Hit, n: number) => { status: number; headers?: Record<string, string>; delayMs?: number; body?: string; hang?: boolean } = () => ({ status: 200 })) {
  const hits: Hit[] = [];
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      const hit = { method: req.method ?? "", url: req.url ?? "", headers: req.headers, body };
      hits.push(hit);
      const r = reply(hit, hits.length);
      if (r.hang) return; // never answer: the client times out or is killed mid-send
      const send = () => {
        if (res.destroyed) return;
        res.writeHead(r.status, r.headers);
        res.end(r.body ?? "{}");
      };
      if (r.delayMs) setTimeout(send, r.delayMs);
      else send();
    });
  });
  await new Promise<void>((ok) => server.listen(0, "127.0.0.1", ok));
  cleanups.push(() => new Promise<void>((ok) => { server.closeAllConnections(); server.close(() => ok()); }));
  const port = (server.address() as AddressInfo).port;
  return { url: `http://127.0.0.1:${port}/hook`, base: `http://127.0.0.1:${port}`, hits };
}

/** Config with a grokbot wake target for the worker side. */
export function grokCfg(extra: Record<string, any> = {}) {
  return {
    wake: { targets: { worker: "grokbot" }, timeout_seconds: 2, ...(extra.wake ?? {}) },
    targets: { grokbot: { channel: "grokbot", routine: "r1", url_env: "WAKE_GROKBOT_URL", key_env: "WAKE_GROKBOT_KEY", ...(extra.target ?? {}) } },
    ...Object.fromEntries(Object.entries(extra).filter(([k]) => k !== "wake" && k !== "target")),
  };
}

let n = 0;
export function uuid(): string {
  n++;
  return `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
}

export function task(over: Record<string, unknown> = {}) {
  return { v: "wake-envelope/1", id: uuid(), type: "task", from: "dispatcher", to: "worker", title: "Do a thing", objective: "Do the thing well.", sent_at: "2026-11-05T01:00:00Z", ...over };
}

export const fixture = (name: string) => JSON.parse(fs.readFileSync(path.join(import.meta.dirname, "..", "fixtures", name), "utf8"));
