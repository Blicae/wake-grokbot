#!/usr/bin/env node
// Checks that `npm pack --dry-run` ships exactly the package.json "files" whitelist (plus package.json itself),
// that every whitelist entry is actually present, and that nothing secret-looking is packed.
// Run after `npm run build` (dist must exist).
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

const pkg = JSON.parse(readFileSync("package.json", "utf8"));
const allowed = new Set([...pkg.files, "package.json"]);
const win = process.platform === "win32";
const out = execFileSync(win ? "npm.cmd" : "npm", ["pack", "--dry-run", "--json", "--ignore-scripts"], { encoding: "utf8", shell: win });
const files = JSON.parse(out)[0].files.map((f) => f.path.replace(/\\/g, "/"));
const problems = [];
const tops = new Set(files.map((p) => p.split("/")[0]));
for (const p of files) if (!allowed.has(p.split("/")[0])) problems.push(`not whitelisted: ${p}`);
for (const a of allowed) if (!tops.has(a)) problems.push(`whitelisted but missing from the pack: ${a}`);
const FORBIDDEN = [/(^|\/)\.env(\.|$)/, /\.key$/, /\.url$/, /(^|\/)wake-grokbot\.json$/, /\.tgz$/, /(^|\/)node_modules\//];
for (const p of files) if (FORBIDDEN.some((r) => r.test(p))) problems.push(`forbidden file packed: ${p}`);
if (problems.length) {
  console.error(problems.join("\n"));
  process.exit(1);
}
console.log(`pack whitelist ok: ${files.length} files; top-level: ${[...tops].sort().join(", ")}`);
