import assert from "node:assert/strict";

import {
  CREATURE_NAME_LIMIT,
  PER_CREATURE_ROSTER_LIMIT,
  normalizeEncounterLootForm,
  normalizeHoardLootForm,
  normalizePerCreatureLootForm,
} from "./loot/form-state.js";
import {
  HOARD_DEFAULT_ITEM_CEILING,
  getDefaultRarities,
} from "./loot/hoard-budget.js";
import { getRarityBalancePresetWeights } from "./loot/rarity-balance.js";
import { LOOT_TYPES } from "./loot/tag-vocabulary.js";

const encounterDefaults = {
  tier: "t2",
  scaleMultiplier: 1,
  generosityMultiplier: 1,
  partySize: 4,
  itemLimitEnabled: false,
  count: 6,
  budgetOverride: 0,
  artVariants: true,
  magicBias: 0,
  rarities: ["common", "uncommon"],
  lootTypes: [],
  minItemGp: 0,
  maxItemGp: 0,
};

{
  const normalized = normalizeEncounterLootForm(
    {
      tier: "T5",
      scaleMultiplier: Infinity,
      generosityMultiplier: -20,
      partySize: 99,
      itemLimitEnabled: "true",
      count: 0,
      budgetOverride: Number.MAX_VALUE,
      artVariants: false,
      magicBias: 4,
      rarities: ["COMMON", "common", "not-a-rarity"],
      lootTypes: "loot.potion",
      minItemGp: -10,
      maxItemGp: Infinity,
      injected: "drop me",
    },
    encounterDefaults,
  );

  assert.deepEqual(normalized, {
    tier: "t5",
    scaleMultiplier: 1,
    generosityMultiplier: 0.4,
    partySize: 10,
    itemLimitEnabled: false,
    count: 1,
    budgetOverride: Number.MAX_SAFE_INTEGER,
    artVariants: false,
    magicBias: 1,
    rarities: ["common"],
    lootTypes: [],
    minItemGp: 0,
    maxItemGp: 0,
  });
  assert.equal(
    Object.hasOwn(normalized, "injected"),
    false,
    "unknown imported fields are discarded",
  );
}

{
  const normalized = normalizeEncounterLootForm(null, {
    ...encounterDefaults,
    tier: "future-tier",
    scaleMultiplier: 999,
    generosityMultiplier: -999,
    partySize: 999,
    count: 999,
    magicBias: 999,
  });
  assert.equal(normalized.tier, "t2");
  assert.equal(normalized.scaleMultiplier, 6);
  assert.equal(normalized.generosityMultiplier, 0.4);
  assert.equal(normalized.partySize, 10);
  assert.equal(normalized.count, 20);
  assert.equal(normalized.magicBias, 1);
}

const hoardDefaults = {
  tier: "t2",
  scale: "standard",
  pileBias: 0,
  magicBias: 0,
  maxItems: HOARD_DEFAULT_ITEM_CEILING.standard,
  artVariants: true,
  rarityBalance: "even",
  rarityWeights: getRarityBalancePresetWeights("even"),
  rarities: ["common", "uncommon"],
  lootTypes: [...LOOT_TYPES],
  minItemGp: 0,
  maxItemGp: 0,
};

{
  const normalized = normalizeHoardLootForm(
    {
      tier: "T5",
      scale: "MASSIVE",
      pileBias: 5,
      magicBias: -8,
      rarityWeights: { artifact: 99, common: -10 },
      rarities: ["future-rarity"],
      lootTypes: ["LOOT.POTION", "future-type"],
    },
    hoardDefaults,
  );

  assert.equal(normalized.tier, "t5");
  assert.equal(normalized.scale, "massive");
  assert.equal(normalized.maxItems, HOARD_DEFAULT_ITEM_CEILING.massive);
  assert.equal(normalized.pileBias, 1);
  assert.equal(normalized.magicBias, -1);
  assert.equal(normalized.rarityBalance, "custom");
  assert.equal(normalized.rarityWeights.artifact, 10);
  assert.equal(normalized.rarityWeights.common, 0);
  assert.deepEqual(
    normalized.rarities,
    getDefaultRarities("t5", "massive"),
    "a legacy hoard missing valid rarities derives defaults from its tier and scale",
  );
  assert.deepEqual(normalized.lootTypes, ["loot.potion"]);
}

{
  const normalized = normalizeHoardLootForm(
    { rarities: [], lootTypes: [] },
    hoardDefaults,
  );
  assert.deepEqual(
    normalized.rarities,
    [],
    "an intentional all-rarity filter survives",
  );
  assert.deepEqual(
    normalized.lootTypes,
    [],
    "an intentional all-type filter survives",
  );
}

const rosterDefaults = {
  defaultTier: "t2",
  itemsPerCreature: 2,
  magicBias: 0,
  rarities: ["common", "uncommon"],
  lootTypes: [],
  minItemGp: 0,
  maxItemGp: 0,
  roster: [
    { id: "default-1", name: "Creature 1", tier: "t2" },
    { id: "default-2", name: "Creature 2", tier: "t2" },
  ],
};

{
  const oversizedRoster = Array.from(
    { length: PER_CREATURE_ROSTER_LIMIT + 5 },
    (_, index) => ({
      id: index < 2 ? "duplicate" : `creature-${index}`,
      name: index === 0 ? "X".repeat(CREATURE_NAME_LIMIT + 20) : `Mob ${index}`,
      tier: index % 2 === 0 ? "T5" : "future-tier",
    }),
  );
  const normalized = normalizePerCreatureLootForm(
    {
      defaultTier: "future-tier",
      itemsPerCreature: 500,
      magicBias: -4,
      rarities: ["future-rarity"],
      roster: oversizedRoster,
      unknown: true,
    },
    rosterDefaults,
  );

  assert.equal(normalized.defaultTier, "t2");
  assert.equal(normalized.itemsPerCreature, 5);
  assert.equal(normalized.magicBias, -1);
  assert.deepEqual(normalized.rarities, rosterDefaults.rarities);
  assert.equal(normalized.roster.length, PER_CREATURE_ROSTER_LIMIT);
  assert.equal(
    new Set(normalized.roster.map((creature) => creature.id)).size,
    PER_CREATURE_ROSTER_LIMIT,
    "duplicate creature ids are repaired",
  );
  assert.equal(normalized.roster[0].name.length, CREATURE_NAME_LIMIT);
  assert.equal(normalized.roster[0].tier, "t5");
  assert.equal(normalized.roster[1].tier, "t2");
  assert.equal(Object.hasOwn(normalized, "unknown"), false);
}

{
  assert.deepEqual(
    normalizePerCreatureLootForm({ roster: [] }, rosterDefaults).roster,
    [],
    "a deliberately cleared roster stays empty",
  );
  assert.deepEqual(
    normalizePerCreatureLootForm({ roster: "broken" }, rosterDefaults).roster,
    rosterDefaults.roster,
    "a malformed roster falls back to a usable default",
  );
}

process.stdout.write("loot form-state validation passed\n");
