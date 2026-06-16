import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";

const manifest = JSON.parse(readFileSync("module.json", "utf8"));
const pkg = JSON.parse(readFileSync("package.json", "utf8"));

assert.equal(manifest.id, "infinity-dnd5e");
assert.equal(
  manifest.version,
  pkg.version,
  "package and manifest versions match",
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

// Stale-tree guard: the manifest version must never be BEHIND the latest
// released git tag. Catches the failure mode where a diverged local
// checkout (or forgotten version bump) would ship an older version than
// what is already published — breaking Forge manifest-URL installs/updates.
// Graceful when git/tags are unavailable (e.g. a tarball checkout).
function parseSemver(value) {
  const match = /^v?(\d+)\.(\d+)\.(\d+)/.exec(String(value).trim());
  if (!match) return null;
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

function compareSemver(a, b) {
  for (let i = 0; i < 3; i += 1) {
    if (a[i] !== b[i]) return a[i] - b[i];
  }
  return 0;
}

const tagResult = spawnSync("git", ["tag", "--list", "v*"], {
  encoding: "utf8",
});
if (tagResult.status === 0 && tagResult.stdout.trim()) {
  const tags = tagResult.stdout
    .split(/\r?\n/)
    .map((line) => parseSemver(line))
    .filter(Boolean);
  if (tags.length > 0) {
    const latest = tags.reduce((max, t) => (compareSemver(t, max) > 0 ? t : max));
    const current = parseSemver(manifest.version);
    assert.ok(current, `manifest version is not semver: ${manifest.version}`);
    assert.ok(
      compareSemver(current, latest) >= 0,
      `manifest version ${manifest.version} is behind the latest released ` +
        `tag v${latest.join(".")} — the working tree looks stale/diverged. ` +
        `Sync to origin or bump the version before releasing.`,
    );
  }
} else {
  process.stdout.write(
    "  (manifest version>=tag check skipped: git tags unavailable)\n",
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
  "4.0.4",
  "manifest should reference the dnd5e system line actually tested against",
);

assert.deepEqual(manifest.esmodules, ["scripts/module.js"]);
assert.ok(
  !("scripts" in manifest),
  "manifest uses esmodules, not legacy scripts",
);

process.stdout.write("manifest compatibility validation passed\n");
