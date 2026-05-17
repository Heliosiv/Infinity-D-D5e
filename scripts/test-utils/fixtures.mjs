/**
 * Hand-rolled item fixtures for unit tests.
 * Mirrors the v3 tag schema in packs/infinity-dnd5e-items.db but
 * keeps each entry small so test failures are readable.
 */

/**
 * Build a fake item entry with sensible defaults.
 * @param {object} overrides
 * @returns {object} item-shaped POJO
 */
export function fakeItem(overrides = {}) {
  const id =
    overrides._id ??
    overrides.id ??
    `it-${Math.random().toString(36).slice(2, 8)}`;
  const rarity = overrides.rarity ?? "common";
  const tier = overrides.tier ?? "t1";
  const valueBand = overrides.valueBand ?? "v1";
  const lootType = overrides.lootType ?? "loot.weapon.mundane";
  const gpValue = overrides.gpValue ?? 10;
  const lootWeight = overrides.lootWeight ?? 1;
  const maxRecommendedQty = overrides.maxRecommendedQty ?? 1;
  const keywords = overrides.keywords ?? [
    `rarity.${rarity}`,
    `tier.${tier}`,
    `value.${valueBand}`,
    lootType,
  ];

  return {
    _id: id,
    name: overrides.name ?? `Item ${id}`,
    img: overrides.img ?? "icons/svg/item-bag.svg",
    type: overrides.type ?? "weapon",
    system: {
      rarity,
      price: { value: gpValue, denomination: "gp" },
    },
    flags: {
      "party-operations": {
        keywords,
        lootType,
        tier: `tier.${tier}`,
        rarityNormalized: rarity,
        valueBand: `value.${valueBand}`,
        gpValue,
        lootWeight,
        maxRecommendedQty,
        lootEligible: overrides.lootEligible ?? true,
        tagSchema: "po-loot-v3",
      },
    },
  };
}

/**
 * Build a small heterogeneous pool for roller tests.
 * Five items spanning rarities and tiers.
 */
export function smallPool() {
  return [
    fakeItem({
      _id: "a",
      name: "Dagger",
      rarity: "common",
      tier: "t1",
      valueBand: "v1",
      gpValue: 5,
      lootType: "loot.weapon.mundane",
    }),
    fakeItem({
      _id: "b",
      name: "Healing Potion",
      rarity: "common",
      tier: "t1",
      valueBand: "v2",
      gpValue: 50,
      lootType: "loot.consumable",
      maxRecommendedQty: 4,
    }),
    fakeItem({
      _id: "c",
      name: "Magic Greatsword",
      rarity: "uncommon",
      tier: "t2",
      valueBand: "v3",
      gpValue: 500,
      lootType: "loot.weapon.magic",
    }),
    fakeItem({
      _id: "d",
      name: "Wand of Magic Missile",
      rarity: "uncommon",
      tier: "t2",
      valueBand: "v3",
      gpValue: 800,
      lootType: "loot.wand",
    }),
    fakeItem({
      _id: "e",
      name: "Crown of Stars",
      rarity: "legendary",
      tier: "t4",
      valueBand: "v5",
      gpValue: 50000,
      lootType: "loot.wondrous",
    }),
  ];
}
