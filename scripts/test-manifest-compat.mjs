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

// Release-state guard: development builds must be newer than the latest
// released tag. Equality is only valid when HEAD is that exact tagged commit.
// This catches a diverged checkout or forgotten version bump that would ship
// the same or an older version than what is already published, breaking Forge
// manifest-URL installs and updates.
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
    .map((name) => ({ name, version: parseSemver(name) }))
    .filter((tag) => tag.version);
  if (tags.length > 0) {
    const latest = tags.reduce((max, tag) =>
      compareSemver(tag.version, max.version) > 0 ? tag : max,
    );
    const current = parseSemver(manifest.version);
    assert.ok(current, `manifest version is not semver: ${manifest.version}`);
    const comparison = compareSemver(current, latest.version);
    assert.ok(
      comparison >= 0,
      `manifest version ${manifest.version} is behind the latest released ` +
        `tag ${latest.name} — the working tree looks stale/diverged. ` +
        `Sync to origin or bump the version before releasing.`,
    );
    if (comparison === 0) {
      const headResult = spawnSync("git", ["rev-parse", "HEAD"], {
        encoding: "utf8",
      });
      const tagCommitResult = spawnSync(
        "git",
        ["rev-list", "-n", "1", latest.name],
        { encoding: "utf8" },
      );
      if (headResult.status === 0 && tagCommitResult.status === 0) {
        assert.equal(
          headResult.stdout.trim(),
          tagCommitResult.stdout.trim(),
          `manifest version ${manifest.version} is already released as ` +
            `${latest.name}, but HEAD contains unreleased work. Bump the ` +
            `package and manifest versions before building a release.`,
        );
      } else {
        process.stdout.write(
          "  (exact HEAD-to-tag check skipped: git history unavailable)\n",
        );
      }
    }
  }
} else {
  process.stdout.write(
    "  (manifest release-state check skipped: git tags unavailable)\n",
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
