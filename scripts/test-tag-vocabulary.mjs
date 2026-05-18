import assert from "node:assert/strict";

import {
  ELEVATED_RARITIES,
  LOOT_TYPES,
  MAGIC_LOOT_TYPES,
  MUNDANE_LOOT_TYPES,
  RARITIES,
  TIERS,
  VALUE_BANDS,
  getItemGpValue,
  getItemKeywords,
  getItemLootType,
  getItemLootWeight,
  getItemMagicNature,
  getItemMaxQty,
  getItemRarity,
  getItemTier,
  getItemValueBand,
  isLootEligible,
  normalizeRarity,
  rarityKeyword,
  tierKeyword,
  valueKeyword,
} from "./loot/tag-vocabulary.js";

import { fakeItem } from "./test-utils/fixtures.mjs";

/* enums frozen */
assert.deepEqual(
  [...RARITIES],
  ["common", "uncommon", "rare", "very-rare", "legendary", "artifact"],
);
assert.equal(TIERS.length, 5);
assert.equal(VALUE_BANDS.length, 5);
assert.ok(LOOT_TYPES.includes("loot.weapon.magic"));
assert.ok(ELEVATED_RARITIES.includes("legendary"));
assert.throws(() => RARITIES.push("garbage"));

/* keyword builders */
assert.equal(tierKeyword("T2"), "tier.t2", "tierKeyword normalizes case");
assert.equal(valueKeyword("V5"), "value.v5");
assert.equal(
  rarityKeyword("veryRare"),
  "rarity.very-rare",
  "rarityKeyword normalizes legacy veryRare",
);
assert.equal(
  rarityKeyword("unknown"),
  "rarity.",
  "rarityKeyword on unknown returns empty bucket",
);

/* normalizeRarity */
assert.equal(normalizeRarity("Rare"), "rare");
assert.equal(normalizeRarity("veryRare"), "very-rare");
assert.equal(normalizeRarity("very_rare"), "very-rare");
assert.equal(normalizeRarity(""), "");
assert.equal(normalizeRarity("nonexistent"), "");

/* item accessors — happy path */
{
  const item = fakeItem({
    rarity: "rare",
    tier: "t3",
    valueBand: "v4",
    gpValue: 1500,
    lootWeight: 0.8,
    maxRecommendedQty: 2,
    lootType: "loot.weapon.magic",
  });
  assert.ok(
    getItemKeywords(item).includes("rarity.rare"),
    "keywords surfaced from flag namespace",
  );
  assert.equal(getItemLootType(item), "loot.weapon.magic");
  assert.equal(getItemTier(item), "t3", "tier strips tier. prefix");
  assert.equal(getItemValueBand(item), "v4", "value band strips value. prefix");
  assert.equal(getItemRarity(item), "rare");
  assert.equal(getItemGpValue(item), 1500);
  assert.equal(getItemLootWeight(item), 0.8);
  assert.equal(getItemMaxQty(item), 2);
  assert.equal(isLootEligible(item), true);
}

/* item accessors — defaults / missing flags */
{
  const item = { _id: "x", name: "Anonymous", flags: {} };
  assert.deepEqual(
    getItemKeywords(item),
    [],
    "missing flags returns empty array",
  );
  assert.equal(getItemLootType(item), "");
  assert.equal(getItemTier(item), "");
  assert.equal(getItemValueBand(item), "");
  assert.equal(getItemRarity(item), "", "missing rarity returns empty");
  assert.equal(getItemGpValue(item), 0);
  assert.equal(getItemLootWeight(item), 1, "default loot weight is 1");
  assert.equal(getItemMaxQty(item), 1, "default max qty is 1");
  assert.equal(
    isLootEligible(item),
    true,
    "missing eligibility flag is treated as eligible",
  );
}

/* item accessors — rarity falls back through layers */
{
  const item = { _id: "y", flags: {}, system: { rarity: "very-rare" } };
  assert.equal(
    getItemRarity(item),
    "very-rare",
    "falls back to system.rarity when flag missing",
  );
}

/* item accessors — lootEligible false short-circuits */
{
  const item = fakeItem({ lootEligible: false });
  assert.equal(isLootEligible(item), false);
}

/* magic-nature classifier */
{
  // Sanity: magic and mundane sets must not overlap.
  for (const lootType of MAGIC_LOOT_TYPES) {
    assert.ok(
      !MUNDANE_LOOT_TYPES.has(lootType),
      `loot type "${lootType}" must not appear in both magic and mundane sets`,
    );
  }

  const magicItem = fakeItem({ lootType: "loot.weapon.magic" });
  const mundaneItem = fakeItem({ lootType: "loot.weapon.mundane" });
  const neutralItem = fakeItem({ lootType: "loot.equipment" });
  assert.equal(getItemMagicNature(magicItem), "magic");
  assert.equal(getItemMagicNature(mundaneItem), "mundane");
  assert.equal(
    getItemMagicNature(neutralItem),
    "neutral",
    "loot types outside both sets fall through to neutral",
  );

  // Items with no lootType at all are treated as neutral so the
  // magic bias slider can't accidentally exclude them.
  assert.equal(
    getItemMagicNature({ flags: {} }),
    "neutral",
    "missing lootType → neutral",
  );
}

/* future-proofing: infinity-dnd5e flag namespace works alongside legacy */
{
  const item = {
    _id: "z",
    flags: {
      "infinity-dnd5e": {
        keywords: ["rarity.uncommon", "tier.t2"],
        lootType: "loot.armor.magic",
        tier: "t2",
        valueBand: "v3",
        rarityNormalized: "uncommon",
        gpValue: 700,
        lootWeight: 0.5,
        maxRecommendedQty: 1,
      },
    },
  };
  assert.deepEqual(getItemKeywords(item), ["rarity.uncommon", "tier.t2"]);
  assert.equal(getItemLootType(item), "loot.armor.magic");
  assert.equal(getItemTier(item), "t2");
  assert.equal(getItemValueBand(item), "v3");
  assert.equal(getItemRarity(item), "uncommon");
  assert.equal(getItemGpValue(item), 700);
}

process.stdout.write("tag-vocabulary validation passed\n");
