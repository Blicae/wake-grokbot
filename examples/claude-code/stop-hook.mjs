#!/usr/bin/env node
// Claude Code Stop / SubagentStop hook: when a session (or subagent) finishes, send ONE note to the
// dispatcher through wake-grokbot so it gets woken and can read the inbox.
//
// - Never blocks or fails the session: always exits 0, gives up after 15 s.
// - Does nothing on a repeated stop (stop_hook_active) or when WAKE_GROKBOT_DISABLED is set.
// - Sends only the project folder name and event; no transcript, no paths, no secrets.
// - CLI to run: WAKE_GROKBOT_HOOK_CLI as "program|arg|arg" (for example "node|C:\\tools\\wake-grokbot\\dist\\cli.js").
//   Default: "wake-grokbot" on PATH (Linux/macOS). On Windows set WAKE_GROKBOT_HOOK_CLI.
import { spawnSync } from "node:child_process";
import { basename } from "node:path";

const chunks = [];
for await (const c of process.stdin) chunks.push(c);
let ev = {};
try {
  ev = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
} catch {
  process.exit(0);
}
const off = (process.env.WAKE_GROKBOT_DISABLED ?? "").trim().toLowerCase();
if (ev.stop_hook_active || (off && off !== "0" && off !== "false")) process.exit(0);

const spec = process.env.WAKE_GROKBOT_HOOK_CLI;
if (!spec && process.platform === "win32") {
  process.stderr.write("wake-grokbot hook: set WAKE_GROKBOT_HOOK_CLI (e.g. node|<path>\\dist\\cli.js)\n");
  process.exit(0);
}
const [cmd, ...pre] = (spec || "wake-grokbot").split("|");
const project = basename(String(ev.cwd || process.cwd())).replace(/[^\p{L}\p{N}._ -]/gu, "").slice(0, 60) || "project";
const event = ev.hook_event_name === "SubagentStop" ? "subagent finished" : "session finished";
const r = spawnSync(
  cmd,
  [...pre, "send", "--type", "note", "--to", "dispatcher", "--from", "claude-code",
    "--title", `Claude Code ${event}: ${project}`, "--project", project],
  { stdio: ["ignore", "ignore", "pipe"], timeout: 15_000, windowsHide: true, encoding: "utf8" },
);
if (r.status !== 0 && r.status !== 5 && r.status !== 6) process.stderr.write(`wake-grokbot hook: send exited ${r.status ?? r.error?.code}\n`);
process.exit(0);
