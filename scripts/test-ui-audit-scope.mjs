import assert from "node:assert/strict";

import { selectUiAuditScope } from "./ui-audit-scope.mjs";

assert.deepEqual(selectUiAuditScope(["scripts/loot/loot-app-base.js"]), {
  kind: "targeted",
  fixtures: [
    "per-encounter",
    "per-encounter-loading",
    "per-encounter-unavailable",
    "hoard",
    "hoard-loading",
    "hoard-unavailable",
    "per-creature",
    "per-creature-loading",
    "per-creature-unavailable",
  ],
  scenarios: ["comfortable-380", "compact-380", "short-720"],
  reason: "Loot Studio",
});
assert.deepEqual(selectUiAuditScope(["styles/dashboard.css"]), {
  kind: "targeted",
  fixtures: [
    "dashboard",
    "home-recovery-blocked-authority",
    "home-recovery-blocked-secondary",
    "home-player",
  ],
  scenarios: ["comfortable-380", "compact-380", "short-720"],
  reason: "Home",
});
assert.deepEqual(selectUiAuditScope(["styles/ui-system.css"]), {
  kind: "full",
  reason: "shared UI foundation changed",
});
assert.deepEqual(selectUiAuditScope(["scripts/resource-manager.js"]), {
  kind: "full",
  reason: "UI path has no focused audit map",
});
assert.deepEqual(selectUiAuditScope(["scripts/test-roller.mjs"]), {
  kind: "skip",
  reason: "no UI paths changed",
});

process.stdout.write("changed UI audit scope validation passed\n");
