/**
 * Rarity invariants:
 *   1. system.rarity uses the dnd5e camelCase enum (or is empty).
 *   2. system.rarity and flag.rarityNormalized agree (via normalizeRarity).
 *   3. Mundane-rarity policy: pure type:loot (trade goods/gems/art/treasure) is
 *      never graded "common" — it's either ungraded (mundane) or a real magic
 *      rarity; and base physical gear (weapon/tool) always carries a rarity.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { normalizeRarity } from "./loot/tag-vocabulary.js";

const PACK_PATH = "packs/infinity-dnd5e-items.db";
const DND5E_RARITIES = new Set([
  "common",
  "uncommon",
  "rare",
  "veryRare",
  "legendary",
  "artifact",
]);

const items = readFileSync(PACK_PATH, "utf8")
  .split(/\r?\n/)
  .filter((line) => line.trim().length > 0)
  .map((line) => JSON.parse(line));

const badFormat = [];
const drift = [];
const lootCommon = [];
const gearMissing = [];

for (const item of items) {
  const sys = String(item.system?.rarity ?? "");
  const norm = item.flags?.["infinity-dnd5e"]?.rarityNormalized ?? "";

  if (sys !== "" && !DND5E_RARITIES.has(sys)) {
    badFormat.push(`${item.name} (${item._id}): system.rarity "${sys}"`);
  }
  if (sys !== "" && norm !== "" && normalizeRarity(sys) !== norm) {
    drift.push(
      `${item.name} (${item._id}): system "${sys}" vs normalized "${norm}"`,
    );
  }
  if (item.type === "loot" && sys === "common") {
    lootCommon.push(`${item.name} (${item._id})`);
  }
  if ((item.type === "weapon" || item.type === "tool") && sys === "") {
    gearMissing.push(`${item.name} (${item._id})`);
  }
}

assert.equal(
  badFormat.length,
  0,
  `system.rarity must use the dnd5e enum (common/uncommon/rare/veryRare/legendary/artifact):\n  ${badFormat.slice(0, 30).join("\n  ")}`,
);
assert.equal(
  drift.length,
  0,
  `system.rarity vs rarityNormalized drift:\n  ${drift.slice(0, 30).join("\n  ")}`,
);
assert.equal(
  lootCommon.length,
  0,
  `type:loot items must not be graded "common" (mundane = ungraded):\n  ${lootCommon.slice(0, 30).join("\n  ")}`,
);
assert.equal(
  gearMissing.length,
  0,
  `weapon/tool items must carry a rarity:\n  ${gearMissing.slice(0, 30).join("\n  ")}`,
);

process.stdout.write(
  `pack rarity check passed (${items.length} items; format + policy consistent)\n`,
);
