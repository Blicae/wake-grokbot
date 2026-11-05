/**
 * CLI contract tests (M4): for each command's typical input, lock the exit code, stdout, stderr and receipt fields.
 * Volatile parts (times, the sandbox folder, generated ids, node version) are normalised before snapshotting.
 * Changing CLI output on purpose means updating the snapshot (`npx vitest run -u`) in the same commit.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { fixture, sandbox } from "./helpers.js";

const ID = "c0000000-0000-4000-8000-000000000001";
const ID2 = "c0000000-0000-4000-8000-000000000002";

type Box = ReturnType<typeof sandbox>;

function norm(s: string, box: Box): string {
  let t = s.replace(/\\\\/g, "/").replace(/\\/g, "/");
  const dirs = [box.dir, fs.realpathSync(box.dir)].map((d) => d.replace(/\\/g, "/"));
  for (const d of dirs) t = t.split(d).join("<DIR>");
  return t
    .replace(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z/g, "<TIME>")
    .replace(/node \d+\.\d+\.\d+/g, "node <VER>")
    .replace(/\b(?!c0000000|00000000)[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\b/g, "<UUID>");
}

async function call(box: Box, args: string[], stdin = "") {
  const r = await box.run(args, stdin);
  return { code: r.code, out: norm(r.out, box), err: norm(r.err, box) };
}

const taskEnv = (over: Record<string, unknown> = {}) => ({ ...fixture("task.json"), id: ID, thread: ID, ...over });

describe("CLI contract", () => {
  it("--version", async () => {
    expect(await call(sandbox(), ["--version"])).toMatchSnapshot();
  });
  it("no command → help on stdout, exit 2", async () => {
    expect(await call(sandbox(), [])).toMatchSnapshot();
  });
  it("unknown command and unknown flag → exit 2", async () => {
    const s = sandbox();
    expect(await call(s, ["frobnicate"])).toMatchSnapshot();
    // the wording after the prefix comes from node:util parseArgs and may change between Node versions
    const flag = await call(s, ["status", "--nope"]);
    expect({ code: flag.code, out: flag.out, err: flag.err.split("'")[0] }).toMatchSnapshot();
  });
  it("send --json (public task fixture) → receipt, exit 0", async () => {
    expect(await call(sandbox(), ["send", "--json", "--json"], JSON.stringify(taskEnv()))).toMatchSnapshot();
  });
  it("send the same envelope twice → exit 0, same receipt; text output", async () => {
    const s = sandbox();
    expect(await call(s, ["send", "--json"], JSON.stringify(taskEnv()))).toMatchSnapshot();
    expect(await call(s, ["send", "--json"], JSON.stringify(taskEnv()))).toMatchSnapshot();
  });
  it("same id, different content → exit 7", async () => {
    const s = sandbox();
    await call(s, ["send", "--json"], JSON.stringify(taskEnv()));
    expect(await call(s, ["send", "--json"], JSON.stringify(taskEnv({ title: "Other" })))).toMatchSnapshot();
  });
  it("invalid envelope → exit 1; invalid JSON → exit 2", async () => {
    const s = sandbox();
    expect(await call(s, ["send", "--json"], JSON.stringify(fixture("invalid/url-in-body.json")))).toMatchSnapshot();
    // the parser's own message differs between Node versions; lock only our prefix
    const bad = await call(s, ["send", "--json"], "{not json");
    expect({ code: bad.code, out: bad.out, err: bad.err.split(":").slice(0, 2).join(":") }).toMatchSnapshot();
  });
  it("send from flags with --id → text output", async () => {
    expect(await call(sandbox(), ["send", "--to", "worker", "--title", "Hello", "--id", ID])).toMatchSnapshot();
  });
  it("status <id> text and --json; unknown id → exit 1", async () => {
    const s = sandbox();
    await call(s, ["send", "--json"], JSON.stringify(taskEnv()));
    expect(await call(s, ["status", ID])).toMatchSnapshot();
    expect(await call(s, ["status", ID, "--json"])).toMatchSnapshot();
    expect(await call(s, ["status", ID2])).toMatchSnapshot();
  });
  it("status overview text and --json", async () => {
    const s = sandbox();
    expect(await call(s, ["status"])).toMatchSnapshot();
    expect(await call(s, ["status", "--json"])).toMatchSnapshot();
  });
  it("ack → receipt with status working", async () => {
    const s = sandbox();
    await call(s, ["send", "--json"], JSON.stringify(taskEnv()));
    expect(await call(s, ["ack", ID, "--json"])).toMatchSnapshot();
    expect(await call(s, ["ack", ID2])).toMatchSnapshot();
  });
  it("reply: needs_input without question → 1; bad status → 2; done → receipt", async () => {
    const s = sandbox();
    await call(s, ["send", "--json"], JSON.stringify(taskEnv()));
    expect(await call(s, ["reply", ID, "--status", "needs_input", "--summary", "?"])).toMatchSnapshot();
    expect(await call(s, ["reply", ID, "--status", "bogus"])).toMatchSnapshot();
    expect(await call(s, ["reply", ID, "--status", "done", "--summary", "finished", "--next", "review", "--json"])).toMatchSnapshot();
  });
  it("ingest: missing --from → 2; wrong from → 1; configured source → 0", async () => {
    const s = sandbox({ sources: { "my-engine": { require_sig: false } } });
    const e = { ...fixture("task-command.json"), id: ID2 };
    expect(await call(s, ["ingest", "-"], JSON.stringify(e))).toMatchSnapshot();
    expect(await call(s, ["ingest", "--from", "my-engine", "-"], JSON.stringify({ ...e, from: "dispatcher" }))).toMatchSnapshot();
    expect(await call(s, ["ingest", "--from", "my-engine", "-", "--json"], JSON.stringify({ ...e, from: "my-engine" }))).toMatchSnapshot();
  });
  it("signing required, unsigned envelope → exit 4", async () => {
    const s0 = sandbox();
    const keyFile = path.join(s0.dir, "sign.key");
    fs.writeFileSync(keyFile, "a-signing-key-of-decent-length\n");
    const s = sandbox({ sign: { key_file: keyFile, require: true } });
    expect(await call(s, ["send", "--json"], JSON.stringify(taskEnv()))).toMatchSnapshot();
  });
  it("watch --once, release, prune with nothing to do", async () => {
    const s = sandbox();
    expect(await call(s, ["watch", "--once"])).toMatchSnapshot();
    expect(await call(s, ["release"])).toMatchSnapshot();
    expect(await call(s, ["prune"])).toMatchSnapshot();
    expect(await call(s, ["watch", "--once", "--interval", "1"])).toMatchSnapshot();
  });
  it("doctor without wake targets; init --print-config", async () => {
    const s = sandbox();
    expect(await call(s, ["doctor"])).toMatchSnapshot();
    expect(await call(s, ["init", "--print-config"])).toMatchSnapshot();
  });
});
