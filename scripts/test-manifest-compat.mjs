import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { validateReleaseVersion } from "./release-version.mjs";

const manifest = JSON.parse(readFileSync("module.json", "utf8"));
const pkg = JSON.parse(readFileSync("package.json", "utf8"));
const lock = JSON.parse(readFileSync("package-lock.json", "utf8"));

assert.equal(manifest.id, "infinity-dnd5e");
assert.equal(
  manifest.version,
  pkg.version,
  "package and manifest versions match",
);
assert.equal(lock.version, pkg.version, "lockfile and package versions match");
assert.equal(
  lock.packages?.[""]?.version,
  pkg.version,
  "lockfile root package version matches",
);

// Cross-client play (shops, sessions, bargains) and broadcast audio all
// ride raw game.socket on `module.infinity-dnd5e`. Foundry only relays
// those frames between clients when the manifest declares socket:true.
// Omitting it silently breaks every player↔GM feature while the GM's own
// UI still renders locally — the worst regression in this module's history
// (see project_player_socket_interaction). Guard it so it can never drop again.
assert.equal(
  manifest.socket,
  true,
  'module.json must declare "socket": true or all cross-client features break',
);

// Release versions include prerelease identifiers; stable builds sort after previews.
const tagResult = spawnSync("git", ["tag", "--list", "v*"], {
  encoding: "utf8",
});
const headTagResult = spawnSync("git", ["tag", "--points-at", "HEAD"], {
  encoding: "utf8",
});
const requireExactTag = process.env.INFINITY_REQUIRE_RELEASE_VERSION === "1";
if (requireExactTag) {
  assert.equal(tagResult.status, 0, "Release verification requires git tags");
  assert.equal(
    headTagResult.status,
    0,
    "Release verification requires HEAD history",
  );
}
if (tagResult.status === 0) {
  validateReleaseVersion({
    version: manifest.version,
    tags: tagResult.stdout.trim().split(/\r?\n/).filter(Boolean),
    headTags: (headTagResult.stdout ?? "")
      .trim()
      .split(/\r?\n/)
      .filter(Boolean),
    requireExactTag,
  });
} else {
  process.stdout.write(
    "  (development release-state check skipped: git tags unavailable)\n",
  );
}

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
  "4.4.4",
  "manifest should reference the dnd5e system line actually tested against",
);

assert.deepEqual(manifest.esmodules, ["scripts/module.js"]);
assert.ok(
  !("scripts" in manifest),
  "manifest uses esmodules, not legacy scripts",
);

for (const stylesheet of ["styles/downtime.css"]) {
  assert.ok(
    manifest.styles?.includes(stylesheet),
    `manifest should load downtime stylesheet ${stylesheet}`,
  );
}
for (const template of [
  "templates/downtime-workspace.hbs",
  "templates/downtime-activities.hbs",
]) {
  assert.ok(
    manifest.templates?.includes(template),
    `manifest should preload downtime template ${template}`,
  );
}

process.stdout.write("manifest compatibility validation passed\n");
