/** Version-pin branches of the scheduled-watch scripts, with isolated stubs (no downloads, no real scheduled task). */
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = path.join(import.meta.dirname, "..");
const PIN = "0.1.0";

// POSIX shell tests need /bin/sh; Windows has none (watch.sh is the Linux/macOS example).
const HAS_SH = process.platform !== "win32" && fs.existsSync("/bin/sh");
const SH_REASON = "watch.sh is a POSIX script: needs /bin/sh (not available on Windows)";

function findPwsh(): string | undefined {
  for (const exe of ["pwsh", "powershell"]) {
    const r = spawnSync(exe, ["-NoProfile", "-NonInteractive", "-Command", "$PSVersionTable.PSVersion.Major"], { encoding: "utf8" });
    if (r.status === 0) return exe;
  }
  return undefined;
}
const PWSH = findPwsh();
const PS_REASON = "install-watch-task.ps1 tests need pwsh or powershell on PATH";

describe.skipIf(!HAS_SH)(`watch.sh runs exactly the pinned version (skipped when: ${SH_REASON})`, () => {
  function run(globalVersion: string | null) {
    const bin = fs.mkdtempSync(path.join(os.tmpdir(), "wg-bin-"));
    const log = path.join(bin, "log");
    if (globalVersion !== null)
      fs.writeFileSync(path.join(bin, "wake-grokbot"), `#!/bin/sh\nif [ "$1" = "--version" ] || [ "$1" = "-v" ]; then echo ${globalVersion}; exit 0; fi\necho "global $*" >> "${log}"\n`, { mode: 0o755 });
    fs.writeFileSync(path.join(bin, "npx"), `#!/bin/sh\necho "npx $*" >> "${log}"\n`, { mode: 0o755 });
    const r = spawnSync("/bin/sh", [path.join(ROOT, "examples", "watch.sh")], { encoding: "utf8", env: { PATH: `${bin}:/usr/bin:/bin`, HOME: bin, WAKE_GROKBOT_CONFIG: "/cfg/w.json" } });
    return { code: r.status, err: r.stderr, log: fs.existsSync(log) ? fs.readFileSync(log, "utf8") : "" };
  }
  it("global with the pinned version: runs it with the explicit config", () => {
    const r = run(PIN);
    expect(r.code).toBe(0);
    expect(r.log).toBe("global --config /cfg/w.json watch --once\n");
  });
  it("global with another version: exit 2, runs nothing", () => {
    const r = run("0.0.9");
    expect(r.code).toBe(2);
    expect(r.err).toMatch(/'0\.0\.9'.*0\.1\.0/);
    expect(r.log).toBe("");
  });
  it("no global: npx with the pinned version and the explicit config", () => {
    const r = run(null);
    expect(r.code).toBe(0);
    expect(r.log).toBe(`npx --yes wake-grokbot@${PIN} --config /cfg/w.json watch --once\n`);
  });
});

describe.skipIf(!PWSH)(`install-watch-task.ps1 version pin (skipped when: ${PS_REASON})`, () => {
  /** Runs the script with stubbed scheduled-task cmdlets and an isolated PATH holding only the stubs. */
  function run(globalVersion: string | null) {
    const bin = fs.mkdtempSync(path.join(os.tmpdir(), "wg-ps-"));
    const log = path.join(bin, "log.txt");
    const cfg = path.join(bin, "w.json");
    fs.writeFileSync(cfg, "{}");
    if (globalVersion !== null) fs.writeFileSync(path.join(bin, "wake-grokbot.ps1"), `if ($args[0] -eq '--version') { '${globalVersion}' } else { Add-Content -LiteralPath '${log}' ('global ' + ($args -join ' ')) }\n`);
    fs.writeFileSync(path.join(bin, "npx.ps1"), `Add-Content -LiteralPath '${log}' ('npx ' + ($args -join ' '))\n`);
    const script = `
      $ErrorActionPreference = 'Stop'
      $env:PATH = '${bin}'
      function New-ScheduledTaskAction { param($Execute, $Argument) Add-Content -LiteralPath '${log}' ("action|" + (Split-Path -Leaf $Execute) + "|" + $Argument); 'a' }
      function New-ScheduledTaskTrigger { 't' }
      function New-ScheduledTaskSettingsSet { 's' }
      function Register-ScheduledTask { Add-Content -LiteralPath '${log}' 'registered' }
      & '${path.join(ROOT, "examples", "install-watch-task.ps1")}' -Config '${cfg}' -TaskName 'wg-test-not-real'`;
    const r = spawnSync(PWSH!, ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", script], { encoding: "utf8" });
    return { code: r.status, out: r.stdout + r.stderr, log: fs.existsSync(log) ? fs.readFileSync(log, "utf8").replace(/\r/g, "") : "", cfg: fs.realpathSync(cfg) };
  }
  it("global with the pinned version: registers it with the explicit config", () => {
    const r = run(PIN);
    expect(r.code, r.out).toBe(0);
    expect(r.log).toContain(`action|wake-grokbot.ps1|--config "${r.cfg}" watch --once`);
    expect(r.log).toContain("registered");
  });
  it("global with another version: fails, registers nothing", () => {
    const r = run("0.0.9");
    expect(r.code).not.toBe(0);
    expect(r.out).toMatch(/0\.0\.9/);
    expect(r.log).not.toContain("registered");
  });
  it("no global: npx with the pinned version and the explicit config", () => {
    const r = run(null);
    expect(r.code, r.out).toBe(0);
    expect(r.log).toContain(`action|npx.ps1|--yes wake-grokbot@${PIN} --config "${r.cfg}" watch --once`);
  });
});

it("install-watch-task.ps1 refuses a mismatching global (static check, runs everywhere)", () => {
  const t = fs.readFileSync(path.join(ROOT, "examples", "install-watch-task.ps1"), "utf8");
  expect(t).toMatch(/--version/);
  expect(t).toMatch(/-ne \$Version/);
  expect(t).toMatch(/throw/);
});
