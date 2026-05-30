import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const manifest = JSON.parse(readFileSync("module.json", "utf8"));
const pkg = JSON.parse(readFileSync("package.json", "utf8"));

assert.equal(manifest.id, "infinity-dnd5e");
assert.equal(
  manifest.version,
  pkg.version,
  "package and manifest versions match",
);

assert.ok(
  Number.parseInt(manifest.compatibility?.minimum, 10) <= 13,
  "Foundry V13 must satisfy the minimum compatibility generation",
);
assert.equal(
  manifest.compatibility?.verified,
  "13.351",
  "manifest should explicitly verify against the current V13 stable line",
);
assert.ok(
  !manifest.compatibility?.maximum ||
    Number.parseInt(manifest.compatibility.maximum, 10) >= 13,
  "Foundry V13 must not be blocked by maximum compatibility",
);

assert.deepEqual(
  manifest.system,
  ["dnd5e"],
  "module is scoped to dnd5e worlds",
);

const dnd5eRelationship = manifest.relationships?.systems?.find(
  (system) => system?.id === "dnd5e",
);
assert.ok(dnd5eRelationship, "manifest declares a dnd5e system relationship");
assert.equal(
  dnd5eRelationship.compatibility?.verified,
  "5.3.3",
  "manifest should reference the current dnd5e V13-compatible system line",
);

assert.deepEqual(manifest.esmodules, ["scripts/module.js"]);
assert.ok(
  !("scripts" in manifest),
  "manifest uses esmodules, not legacy scripts",
);

process.stdout.write("manifest compatibility validation passed\n");
