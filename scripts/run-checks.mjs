#!/usr/bin/env node
/**
 * Run every `scripts/test-*.mjs` in series and exit non-zero on
 * first failure. Equivalent to AGENTS-style `npm run check` in the
 * party-operations repo, scoped to this module's scripts/ dir.
 */

import { readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const here = path.dirname(fileURLToPath(import.meta.url));
const tests = readdirSync(here)
  .filter((name) => name.startsWith("test-") && name.endsWith(".mjs"))
  .sort();

if (tests.length === 0) {
  console.log("No test-*.mjs files found.");
  process.exit(0);
}

let failed = 0;
for (const test of tests) {
  const result = spawnSync(process.execPath, [path.join(here, test)], {
    cwd: path.resolve(here, ".."),
    stdio: "inherit",
  });
  if (result.status !== 0) {
    failed += 1;
    console.error(`  ✗ ${test}`);
  }
}

if (failed > 0) {
  console.error(`\n${failed} of ${tests.length} checks failed.`);
  process.exit(1);
}
console.log(`\nAll ${tests.length} checks passed.`);
