import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { computePackStats } from "./loot/pack-stats.js";
import { rollLoot } from "./loot/roller.js";
import { getItemLootType, getItemMagicNature } from "./loot/tag-vocabulary.js";

const items = readFileSync("packs/infinity-dnd5e-items.db", "utf8")
  .split(/\r?\n/)
  .filter((line) => line.trim().length > 0)
  .map((line) => JSON.parse(line));
const consumables = items.filter(
  (item) => getItemLootType(item) === "loot.consumable",
);

function byName(name) {
  const item = consumables.find((candidate) => candidate.name === name);
  assert.ok(item, `missing pack fixture: ${name}`);
  return item;
}

for (const name of [
  "Arrow",
  "Hempen Rope (50 ft.)",
  "Hooded Lantern",
  "Rations",
  "Truth Serum",
  "Waterskin",
]) {
  assert.equal(
    getItemMagicNature(byName(name)),
    "mundane",
    `${name} is an ordinary consumable, not magic`,
  );
}

for (const name of [
  "Arrow +1",
  "Bead of Force",
  "Dust of Dryness",
  "Rope of Climbing",
]) {
  assert.equal(
    getItemMagicNature(byName(name)),
    "magic",
    `${name} remains a magic consumable`,
  );
}

const stats = computePackStats(consumables);
assert.deepEqual(
  stats.byMagicNature,
  { magic: 123, mundane: 36, neutral: 0 },
  "the mixed consumable bucket has the reviewed 123 magic / 36 mundane split",
);

const baseArrow = byName("Arrow");
const magicArrow = byName("Arrow +1");
const magicOnly = rollLoot([baseArrow, magicArrow], {
  count: 1,
  magicBias: 1,
  rng: () => 0,
});
assert.equal(
  magicOnly.items[0]?.item?._id,
  magicArrow._id,
  "+100% Magic Bias excludes the mundane base arrow",
);

const mundaneOnly = rollLoot([baseArrow, magicArrow], {
  count: 1,
  magicBias: -1,
  rng: () => 0,
});
assert.equal(
  mundaneOnly.items[0]?.item?._id,
  baseArrow._id,
  "-100% Magic Bias excludes the magic arrow",
);

process.stdout.write(
  `magic-bias validation passed (${consumables.length} consumables; 123 magic, 36 mundane)\n`,
);
