#!/usr/bin/env node
import { main } from "./main.js";

const code = await main(process.argv.slice(2), {
  stdin: process.stdin,
  out: (s) => process.stdout.write(s),
  err: (s) => process.stderr.write(s),
  env: process.env,
});
process.exitCode = code;
