// Run from a fresh directory; all state stays in that directory.
import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
const here = path.dirname(fileURLToPath(import.meta.url));
const config = path.resolve("wake-grokbot.json");
const env = { ...process.env, WAKE_GROKBOT_INBOX: path.resolve("inbox"), WAKE_GROKBOT_STATE: path.resolve("state") };
function cli(args, input) {
  const r = spawnSync(process.execPath, [path.resolve(here, "../../dist/cli.js"), "--config", config, ...args], { input, env, encoding: "utf8" });
  if (r.error) throw r.error;
  if (r.status !== 0) throw new Error(`CLI exit ${r.status}: ${r.stderr || r.stdout}`);
  return r.stdout;
}
try {
  const action = process.argv[2];
  if (action === "init") {
    const target = { channel: "script", argv: [process.execPath, path.join(here, "notify.mjs")] };
    fs.writeFileSync(config, JSON.stringify({ inbox: "inbox", state_dir: "state", wake: { targets: { worker: "worker", dispatcher: "dispatcher" } }, targets: { worker: target, dispatcher: target }, sinks: { report_roots: [path.resolve("reports")] } }, null, 2) + "\n", { flag: "wx" });
    fs.mkdirSync("reports", { recursive: true });
    console.log("Initialized local-only script targets; no credentials required.");
  } else if (action === "send") {
    const task = { v: "wake-envelope/1", id: randomUUID(), type: "task", from: "dispatcher", to: "worker", objective: "Write a greeting", acceptance: ["Report says hello"], authorization: "explicit", sent_at: new Date().toISOString(), reply_to: { sink: "report-file", report_path: path.resolve("reports/greeting.md") } };
    // One task per fresh demo directory; never silently replace a previous task id.
    fs.writeFileSync("task.json", JSON.stringify(task, null, 2) + "\n", { flag: "wx" });
    process.stdout.write(cli(["send", "--json", "-"], JSON.stringify(task)));
  } else if (["reply", "status", "receive"].includes(action)) {
    const task = JSON.parse(fs.readFileSync("task.json", "utf8"));
    if (action === "reply") {
      process.stdout.write(cli(["ack", task.id]));
      process.stdout.write(cli(["reply", task.id, "--json", "-"], JSON.stringify({ status: "done", summary: "Greeting ready", body: "hello" })));
    } else if (action === "status") process.stdout.write(cli(["status", task.id, "--json"]));
    else {
      const dir = path.resolve("inbox/msg/to-dispatcher/unread");
      for (const f of fs.readdirSync(dir).filter((f) => f.endsWith(".json"))) {
        const reply = JSON.parse(fs.readFileSync(path.join(dir, f), "utf8"));
        console.log(`${reply.status}: ${reply.summary}`);
        process.stdout.write(cli(["ack", reply.id]));
      }
    }
  } else throw new Error("Usage: node demo.mjs init|send|reply|receive|status");
} catch (e) { console.error(e.message); process.exitCode = 1; }
