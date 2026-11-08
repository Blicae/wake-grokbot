// A local wake nudge only: no network and no autonomous task execution.
import * as fs from "node:fs";
let input = "";
for await (const chunk of process.stdin) input += chunk;
JSON.parse(input);
fs.appendFileSync("wake.log", "inbox changed; read it before acting\n");
