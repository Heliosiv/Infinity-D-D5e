import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { selectUiAuditScope } from "./ui-audit-scope.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const [
  base = process.env.INFINITY_UI_AUDIT_BASE,
  head = process.env.INFINITY_UI_AUDIT_HEAD,
] = process.argv.slice(2);
const changed = changedPaths(resolveBase(base), head || "HEAD");
const scope = selectUiAuditScope(changed);

if (scope.kind === "skip") {
  console.log(`Changed UI audit skipped: ${scope.reason}.`);
  process.exit(0);
}

const env = { ...process.env };
if (scope.kind === "targeted") {
  env.INFINITY_UI_AUDIT_FIXTURE = scope.fixtures.join(",");
  env.INFINITY_UI_AUDIT_SCENARIO = scope.scenarios.join(",");
  console.log(
    `Changed UI audit: ${scope.reason} (${scope.fixtures.length} fixture(s), ${scope.scenarios.length} scenario(s)).`,
  );
} else {
  console.log(`Changed UI audit: full suite (${scope.reason}).`);
}

const result = spawnSync(
  process.execPath,
  [path.join(here, "audit-ui-layout.mjs")],
  {
    cwd: path.resolve(here, ".."),
    env,
    stdio: "inherit",
  },
);
process.exit(result.status ?? 1);

function resolveBase(value) {
  const candidate = String(value ?? "").trim();
  if (candidate && !/^0+$/.test(candidate)) return candidate;
  return "HEAD~1";
}

function changedPaths(baseRef, headRef) {
  const result = spawnSync(
    "git",
    ["diff", "--name-only", "--diff-filter=ACMR", baseRef, headRef],
    { cwd: path.resolve(here, ".."), encoding: "utf8" },
  );
  if (result.status !== 0) {
    throw new Error(
      `Could not determine changed files from ${baseRef} to ${headRef}: ${result.stderr.trim()}`,
    );
  }
  return result.stdout.split(/\r?\n/).filter(Boolean);
}
