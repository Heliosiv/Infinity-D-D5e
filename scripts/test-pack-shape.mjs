/**
 * Smoke-test that the bundled compendium still parses, that every
 * line is a valid item document, and that the loot tag schema is
 * present on enough items for the roller to function.
 *
 * Cheap to run, catches a corrupt copy / line-ending mangle / merge
 * conflict markers in the pack file before they land in Foundry.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  getItemGpValue,
  getItemKeywords,
  getItemLootType,
  getItemRarity,
  getItemTier,
} from "./loot/tag-vocabulary.js";

const PACK_PATH = "packs/infinity-dnd5e-items.db";

const text = readFileSync(PACK_PATH, "utf8");
const lines = text.split(/\r?\n/).filter((line) => line.trim().length > 0);

assert.ok(
  lines.length > 1000,
  `expected 1000+ items in pack, got ${lines.length}`,
);

let withKeywords = 0;
let withLootType = 0;
let withTier = 0;
let withRarity = 0;
let withGpValue = 0;
let totalGp = 0;
let badJson = 0;

for (const [index, line] of lines.entries()) {
  let item;
  try {
    item = JSON.parse(line);
  } catch {
    badJson += 1;
    continue;
  }

  assert.ok(item._id, `line ${index} missing _id`);
  assert.ok(item.name, `line ${index} missing name`);
  assert.ok(item.type, `line ${index} missing type`);

  if (getItemKeywords(item).length > 0) withKeywords += 1;
  if (getItemLootType(item)) withLootType += 1;
  if (getItemTier(item)) withTier += 1;
  if (getItemRarity(item)) withRarity += 1;
  const gp = getItemGpValue(item);
  if (gp > 0) {
    withGpValue += 1;
    totalGp += gp;
  }
}

assert.equal(badJson, 0, `${badJson} unparseable lines in pack`);
const coverage = (count) => (count / lines.length) * 100;

// At minimum, 80% of the pack must carry the loot tag schema. The
// current pack hits ~100% but we leave headroom for partial-schema
// experimentation without breaking CI.
assert.ok(
  coverage(withKeywords) >= 80,
  `only ${coverage(withKeywords).toFixed(1)}% of items have keyword tags`,
);
assert.ok(
  coverage(withLootType) >= 80,
  `only ${coverage(withLootType).toFixed(1)}% of items have lootType`,
);
assert.ok(
  coverage(withTier) >= 80,
  `only ${coverage(withTier).toFixed(1)}% of items have tier`,
);
assert.ok(
  coverage(withRarity) >= 80,
  `only ${coverage(withRarity).toFixed(1)}% of items have rarity`,
);
assert.ok(
  coverage(withGpValue) >= 80,
  `only ${coverage(withGpValue).toFixed(1)}% of items have gpValue`,
);

process.stdout.write(
  `pack shape validation passed (${lines.length} items, ${Math.round(totalGp).toLocaleString()} gp total)\n`,
);
