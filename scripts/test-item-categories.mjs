import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  getItemLootCategories,
  getItemRollCategory,
  isReagentItem,
  isVariableGemItem,
  VIRTUAL_LOOT_TYPES,
} from "./loot/item-categories.js";
import { filterCandidates } from "./loot/roller.js";
import { computeTierFilteredStats } from "./loot/pack-stats.js";
import {
  LOOT_TYPES,
  getItemLootType,
  getItemMagicNature,
  isBareSpellLootItem,
  isLootEligible,
} from "./loot/tag-vocabulary.js";
import { itemBuyCategories } from "./merchant/buy-filter.js";
import { fakeItem, legacyNamespaceItem } from "./test-utils/fixtures.mjs";

/* malformed input is harmless */
assert.deepEqual([...getItemLootCategories(null)], []);
assert.deepEqual([...getItemLootCategories("not-an-item")], []);
assert.deepEqual(VIRTUAL_LOOT_TYPES, [
  "loot.gem",
  "loot.art",
  "loot.ammunition",
  "loot.reagent",
]);

{
  const futureItem = fakeItem({
    lootType: "loot.future-category",
    keywords: ["loot.future-category", "loot.tool"],
  });
  assert.equal(
    getItemRollCategory(futureItem),
    "loot.tool",
    "an unknown canonical type falls back to a visible category keyword",
  );
}

/* canonical + virtual categories work through the legacy flag namespace */
{
  const gem = legacyNamespaceItem({
    type: "loot",
    lootType: "loot.loot",
    variableTreasureKind: "gem",
    keywords: ["loot.loot", "loot.variable.gem", "treasure.gem"],
  });
  assert.equal(isVariableGemItem(gem), true);
  assert.deepEqual(
    [...getItemLootCategories(gem)].sort(),
    ["loot.gem", "loot.trade-good"],
    "a variable gem keeps its broad Trade Goods category and gains Gems",
  );
  assert.equal(
    getItemRollCategory(gem),
    "loot.gem",
    "a variable gem receives probability only from the Gems category",
  );
}

/* magic items with inherited gem tags never leak into mundane treasure */
{
  const gemOfSeeing = fakeItem({
    type: "consumable",
    lootType: "loot.consumable",
    variableTreasureKind: "gem",
    keywords: [
      "loot.consumable",
      "loot.gem",
      "loot.variable.gem",
      "treasure.gem",
      "merchant.gem",
    ],
  });
  assert.equal(isVariableGemItem(gemOfSeeing), false);
  assert.deepEqual(
    [...getItemLootCategories(gemOfSeeing)],
    ["loot.consumable"],
  );
}

/* virtual ammunition overlaps Consumables without pulling ordinary potions */
{
  const arrow = fakeItem({
    type: "consumable",
    lootType: "loot.consumable",
    keywords: ["loot.consumable", "subtype.ammo"],
  });
  const potion = fakeItem({
    type: "consumable",
    lootType: "loot.potion",
    keywords: ["loot.potion"],
  });
  assert.deepEqual([...getItemLootCategories(arrow)].sort(), [
    "loot.ammunition",
    "loot.consumable",
  ]);
  assert.equal(getItemRollCategory(arrow), "loot.ammunition");
  assert.deepEqual([...getItemLootCategories(potion)], ["loot.potion"]);
  assert.equal(getItemRollCategory(potion), "loot.potion");
}

/* pre-tag-schema reagent-folder goods join Reagents without losing Trade Goods */
{
  const incense = fakeItem({
    type: "loot",
    lootType: "loot.loot",
    keywords: ["loot.loot", "folder.path.sundries.herbs-reagents.reagents"],
  });
  assert.equal(isReagentItem(incense), true);
  assert.deepEqual([...getItemLootCategories(incense)].sort(), [
    "loot.reagent",
    "loot.trade-good",
  ]);
  assert.equal(getItemRollCategory(incense), "loot.reagent");
  assert.equal(
    getItemMagicNature(fakeItem({ lootType: "loot.reagent" })),
    "mundane",
    "raw reagents respond to the mundane side of Magic Bias",
  );
}

/* reagent-looking text on an unrelated document is not enough */
{
  const spell = {
    name: "Reagent Ward",
    type: "spell",
    system: { type: { value: "utility" } },
    flags: {
      "infinity-dnd5e": {
        keywords: ["folder.path.sundries.herbs-reagents.reagents"],
      },
    },
  };
  assert.equal(isReagentItem(spell), false);
  assert.equal(getItemLootCategories(spell).has("loot.reagent"), false);
}

/* full-pack contract: rolling, tier chip counts, and tagged buy filters agree */
{
  const items = readFileSync("packs/infinity-dnd5e-items.db", "utf8")
    .split(/\r?\n/)
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line));
  const eligible = items.filter(
    (item) => isLootEligible(item) && !isBareSpellLootItem(item),
  );
  const stats = computeTierFilteredStats(items);

  for (const lootType of LOOT_TYPES) {
    const expectedIds = eligible
      .filter((item) => getItemLootCategories(item).has(lootType))
      .map((item) => item._id)
      .sort();
    const rolledIds = filterCandidates(items, { lootTypes: [lootType] })
      .map((item) => item._id)
      .sort();

    assert.deepEqual(
      rolledIds,
      expectedIds,
      `${lootType}: roller membership follows the shared classifier`,
    );
    assert.equal(
      stats.byLootType[lootType] ?? 0,
      expectedIds.length,
      `${lootType}: chip count matches the rollable pool`,
    );
  }

  for (const item of items) {
    if (!getItemLootType(item)) continue;
    assert.deepEqual(
      [...itemBuyCategories(item)].sort(),
      [...getItemLootCategories(item)].sort(),
      `${item.name} (${item._id}): tagged buy categories match stock categories`,
    );
  }

  const chipCounts = Object.fromEntries(
    LOOT_TYPES.map((lootType) => [lootType, stats.byLootType[lootType] ?? 0]),
  );
  assert.ok(chipCounts["loot.gem"] > 0, "the shipped Gems chip is populated");
  assert.ok(chipCounts["loot.art"] > 0, "the shipped Art chip is populated");
  assert.ok(
    chipCounts["loot.reagent"] > 0,
    "the shipped Reagents chip is populated",
  );

  process.stdout.write(
    `item-category validation passed (${items.length} items; gems ${chipCounts["loot.gem"]}, art ${chipCounts["loot.art"]}, reagents ${chipCounts["loot.reagent"]})\n`,
  );
}
