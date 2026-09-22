// Runs every demo in order and fails loudly if any of them does.
// Each demo is its own process so one failure can't hide behind another.
import { readdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

const root = new URL("..", import.meta.url).pathname;
const demos = readdirSync(join(root, "demos"), { withFileTypes: true })
  .filter((d) => d.isDirectory() && existsSync(join(root, "demos", d.name, "demo.mjs")))
  .map((d) => d.name)
  .sort();

let failed = 0;
for (const name of demos) {
  const r = spawnSync(process.execPath, [join("demos", name, "demo.mjs")], { cwd: root, encoding: "utf8" });
  if (r.status === 0) {
    console.log(`PASS  ${name}`);
  } else {
    failed++;
    console.log(`FAIL  ${name}`);
    console.log((r.stderr || r.stdout).trim().split("\n").slice(-8).map((l) => `      ${l}`).join("\n"));
  }
}

console.log(`\n${demos.length - failed}/${demos.length} demos passed`);
process.exit(failed ? 1 : 0);
