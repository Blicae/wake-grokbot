import * as fs from "node:fs";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { renderFooter, parseTime } from "../src/footer.js";
import { renderReport } from "../src/sinks.js";
import { loadConfig } from "../src/config.js";
import { sinkReplaySafe } from "../src/sinks.js";
import { fixture, sandbox } from "./helpers.js";

describe("localized reports", () => {
  it("pins both status dictionaries and decision labels", () => {
    for (const [locale, words, decision, colon] of [
      ["en", ["Progress", "Waiting", "Ready", "Blocked", "Failed", "No action needed"], "Decision required", ":"],
      ["zh-CN", ["进展", "等待", "就绪", "受阻", "失败", "无需处理"], "待人工决定", "："],
    ] as const) {
      for (const [i, status] of (["working", "needs_input", "done", "blocked", "failed", "declined"] as const).entries()) {
        const report = renderReport({ ...fixture("receipt-done.json"), status, summary: "s", question: "q" }, undefined, locale);
        expect(report.startsWith(`${words[i]}${colon}`)).toBe(true);
        if (status === "needs_input") expect(report).toContain(`${decision}${colon}`);
      }
    }
  });
  for (const locale of ["en", "zh-CN"] as const) {
    for (const [timezone, before, after] of [
      ["UTC", "2026-11-01 08:30:00", "2026-11-01 09:30:00"],
      ["America/Los_Angeles", "2026-11-01 01:30:00", "2026-11-01 01:30:00"],
      ["Asia/Shanghai", "2026-11-01 16:30:00", "2026-11-01 17:30:00"],
    ]) {
      it(`${locale} / ${timezone} formats both sides of DST from absolute times`, () => {
        const text = renderFooter({ locale, timezone, quotaLine: false, startedAt: Date.parse("2026-11-01T08:30:00Z"), completedAt: Date.parse("2026-11-01T09:30:00Z") });
        expect(text).toContain(before!); expect(text).toContain(after!);
        expect(text).toContain(locale === "en" ? "1h" : "1小时");
        expect(text).not.toMatch(/quota|额度/);
        const quota = renderFooter({ locale, timezone, quotaLine: false, quota: { used: "1", reset: "2026-11-01T09:30:00Z" }, completedAt: Date.parse("2026-11-01T09:30:00Z") });
        expect(quota).toContain(locale === "en" ? "Account quota" : "Grok Bot额度");
        expect(quota).toContain(after!);
      });
    }
  }
  it("date-only reset stays unconverted", () => { expect(parseTime("2026-11-10")).toBeUndefined(); });
  for (const report of [{ timezone: "Not/AZone" }, { locale: "fr" }, { quota_line: "yes" }, null]) {
    it(`rejects invalid report config ${JSON.stringify(report)} at load and doctor with exit 2`, async () => {
      const s = sandbox({ report });
      expect(() => loadConfig({ config: s.cfgPath, env: s.env })).toThrow(/report/);
      expect((await s.run(["doctor"])).code).toBe(2);
      expect((await s.run(["status", "--json"])).code).toBe(2);
    });
  }
  for (const sink of ["report-file", "hufu-report"]) {
    it(`${sink} defaults and legacy override isolation through CLI`, async () => {
      const s = sandbox({ report: sink === "hufu-report" ? { locale: "en", timezone: "UTC", quota_line: false } : undefined });
      const report = path.join(s.dir, "result.md");
      const cfg = JSON.parse(fs.readFileSync(s.cfgPath, "utf8")); cfg.sinks = { report_roots: [s.dir] }; fs.writeFileSync(s.cfgPath, JSON.stringify(cfg));
      const e = fixture("task-report-file.json"); e.reply_to = { sink, report_path: report };
      expect((await s.run(["send", "--json", "-"], JSON.stringify(e))).code).toBe(0);
      expect((await s.run(["reply", e.id, "--status", "done", "--summary", "ok"])).code).toBe(0);
      const text = fs.readFileSync(report, "utf8");
      expect(text.startsWith(sink === "hufu-report" ? "就绪：" : "Ready:")).toBe(true);
      expect(text.includes("Grok Bot额度")).toBe(sink === "hufu-report");
      expect(text).toContain(sink === "hufu-report" ? "北京时间" : "UTC");
    });
  }
  for (const [header, status, ok] of [["Blocked: authored", "done", true], ["Ready: authored", "failed", false], ["Waiting: authored", "done", false], ["受阻：authored", "done", true], ["就绪：authored", "failed", false]] as const) {
    it(`adopts by authored locale: ${header} / ${status}`, async () => {
      const s = sandbox({ report: { locale: "en" }, sinks: { report_roots: [] } });
      const report = path.join(s.dir, "authored.md");
      const cfg = JSON.parse(fs.readFileSync(s.cfgPath, "utf8")); cfg.sinks.report_roots = [s.dir]; fs.writeFileSync(s.cfgPath, JSON.stringify(cfg));
      const e = fixture("task-report-file.json"); e.reply_to.report_path = report;
      expect((await s.run(["send", "--json", "-"], JSON.stringify(e))).code).toBe(0);
      fs.writeFileSync(report, header + "\n\nbody\n");
      expect((await s.run(["reply", e.id, "--status", status, "--summary", "ok", "--keep-report"])).code).toBe(ok ? 0 : 5);
      expect(fs.existsSync(report + ".DONE")).toBe(ok);
    });
  }
});

it("new report sink is replay safe", () => { expect(sinkReplaySafe({ sink: "report-file", report_path: "/reports/a.md" })).toBe(true); });
for (const locale of ["en", "zh-CN"] as const) {
  for (const quotaLine of [true, false]) {
    it(`${locale}: configured quota line ${quotaLine} and explicit quota precedence`, () => {
      const o = { locale, timezone: "UTC", quotaLine, completedAt: 0 };
      const label = locale === "en" ? "Account quota" : "Grok Bot额度";
      expect(renderFooter(o).includes(label)).toBe(quotaLine);
      expect(renderFooter({ ...o, quota: { remaining: "42" } })).toContain(label);
      expect(renderFooter({ ...o, quota: { reset: "2026-11-10" } })).toContain(locale === "en" ? "2026-11-10 (as given, not converted)" : "2026-11-10（原样，未换算）");
    });
  }
}
for (const footer of ["账号用量：old", "Grok Bot额度：old", "Account quota: old", "Execution: old", "任务执行：old"]) {
  it(`adoption preserves existing footer ${footer}`, async () => {
    const s = sandbox();
    const report = path.join(s.dir, "existing.md");
    const cfg = JSON.parse(fs.readFileSync(s.cfgPath, "utf8")); cfg.sinks = { report_roots: [s.dir] }; fs.writeFileSync(s.cfgPath, JSON.stringify(cfg));
    const e = fixture("task-report-file.json"); e.reply_to.report_path = report;
    expect((await s.run(["send", "--json", "-"], JSON.stringify(e))).code).toBe(0);
    const text = `Ready: original\n\nbody\n\n---\n${footer}\n`;
    fs.writeFileSync(report, text);
    expect((await s.run(["reply", e.id, "--status", "done", "--summary", "ok", "--keep-report"])).code).toBe(0);
    expect(fs.readFileSync(report, "utf8")).toBe(text);
  });
}
