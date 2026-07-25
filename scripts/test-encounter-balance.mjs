import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { computeLootBudget } from "./loot/budget.js";
import {
  ENCOUNTER_CATEGORY_REPEAT_PENALTY,
  ENCOUNTER_SCROLL_CAP,
  getEncounterBalanceOptions,
  getEncounterCategoryWeights,
  getEncounterRarityWeights,
} from "./loot/category-balance.js";
import {
  getItemRollCategory,
  restoreStoredRollCategories,
} from "./loot/item-categories.js";
import {
  estimateLootChances,
  filterCandidates,
  getEffectiveRarity,
  rollLoot,
} from "./loot/roller.js";
import {
  LOOT_TYPES,
  TIERS,
  getItemMagicNature,
  tierWindow,
} from "./loot/tag-vocabulary.js";
import { fakeItem } from "./test-utils/fixtures.mjs";
import { mulberry32 } from "./test-utils/rng.mjs";

for (const tier of TIERS) {
  const categoryWeights = getEncounterCategoryWeights(tier);
  assert.deepEqual(
    Object.keys(categoryWeights).sort(),
    [...LOOT_TYPES].sort(),
    `${tier}: every visible item category has an explicit probability`,
  );
  assert.ok(
    Math.abs(
      Object.values(categoryWeights).reduce((sum, weight) => sum + weight, 0) -
        100,
    ) < 1e-9,
    `${tier}: category percentages total 100`,
  );
  assert.ok(
    Object.values(getEncounterRarityWeights(tier)).every(
      (weight) => Number.isFinite(weight) && weight > 0,
    ),
    `${tier}: narrow rarity filters always retain a possible outcome`,
  );
}

assert.deepEqual(
  getEncounterCategoryWeights("unknown"),
  getEncounterCategoryWeights("t2"),
  "malformed tiers fall back to the standard T2 balance",
);

/* Pool cardinality cannot change category probability. */
{
  const weapons = Array.from({ length: 100 }, (_, index) =>
    fakeItem({
      _id: `weapon-${index}`,
      lootType: "loot.weapon.mundane",
    }),
  );
  const potion = fakeItem({
    _id: "only-potion",
    type: "consumable",
    lootType: "loot.potion",
    properties: ["mgc"],
  });
  const chances = estimateLootChances([...weapons, potion], {
    categoryWeights: {
      "loot.weapon.mundane": 1,
      "loot.potion": 1,
    },
  });
  const byCategory = new Map(
    chances.categories.map(({ key, probability }) => [key, probability]),
  );
  assert.ok(
    Math.abs(byCategory.get("loot.weapon.mundane") - 0.5) < 1e-12,
    "100 weapon documents still receive one 50% category slot",
  );
  assert.ok(
    Math.abs(byCategory.get("loot.potion") - 0.5) < 1e-12,
    "one potion document receives the other 50% category slot",
  );

  let potions = 0;
  for (let seed = 1; seed <= 2000; seed += 1) {
    const result = rollLoot([...weapons, potion], {
      count: 1,
      categoryWeights: {
        "loot.weapon.mundane": 1,
        "loot.potion": 1,
      },
      rng: mulberry32(seed),
    });
    if (getItemRollCategory(result.items[0]?.item) === "loot.potion") {
      potions += 1;
    }
  }
  assert.ok(
    potions >= 900 && potions <= 1100,
    `category-first draws remain near 50/50 (${potions}/2000 potions)`,
  );
}

/* Unavailable categories renormalize instead of wasting their percentage. */
{
  const weapon = fakeItem({ _id: "weapon-only" });
  const chances = estimateLootChances([weapon], {
    categoryWeights: {
      "loot.weapon.mundane": 1,
      "loot.potion": 99,
    },
  });
  assert.equal(chances.categories.length, 1);
  assert.equal(chances.categories[0].key, "loot.weapon.mundane");
  assert.equal(chances.categories[0].probability, 1);
}

/* Exhausted high-weight items cannot starve valid low-weight alternatives. */
{
  const dominant = fakeItem({
    _id: "dominant-once",
    lootType: "loot.weapon.mundane",
  });
  const alternative = fakeItem({
    _id: "alternative-once",
    lootType: "loot.tool",
  });
  for (let seed = 1; seed <= 5; seed += 1) {
    const result = rollLoot([dominant, alternative], {
      count: 2,
      categoryWeights: {
        "loot.weapon.mundane": 10_000,
        "loot.tool": 1,
      },
      categoryRepeatPenalty: 1,
      rng: mulberry32(seed),
    });
    assert.deepEqual(
      new Set(result.items.map((entry) => entry.item._id)),
      new Set(["dominant-once", "alternative-once"]),
      `seed ${seed}: exhausted dominant item is removed from later draws`,
    );
  }

  const stackableButNotAmmo = fakeItem({
    _id: "single-potion",
    type: "consumable",
    lootType: "loot.potion",
    maxRecommendedQty: 10,
    properties: ["mgc"],
  });
  const result = rollLoot([stackableButNotAmmo], {
    count: 3,
    categoryWeights: { "loot.potion": 1 },
    rng: mulberry32(3),
  });
  assert.equal(result.items.length, 1);
  assert.equal(
    result.items[0].quantity,
    1,
    "non-ammunition loot never silently becomes a multi-quantity stack",
  );
}

/* Diversity is dynamic and mathematically visible in the estimator. */
{
  const pool = [
    fakeItem({ _id: "weapon-repeat" }),
    fakeItem({
      _id: "potion-diversity",
      type: "consumable",
      lootType: "loot.potion",
      properties: ["mgc"],
    }),
  ];
  const chances = estimateLootChances(pool, {
    categoryWeights: {
      "loot.weapon.mundane": 1,
      "loot.potion": 1,
    },
    categoryRepeatPenalty: ENCOUNTER_CATEGORY_REPEAT_PENALTY,
    initialCategoryCounts: { "loot.weapon.mundane": 1 },
  });
  const byCategory = new Map(
    chances.categories.map(({ key, probability }) => [key, probability]),
  );
  const expectedWeapon =
    ENCOUNTER_CATEGORY_REPEAT_PENALTY / (1 + ENCOUNTER_CATEGORY_REPEAT_PENALTY);
  assert.ok(
    Math.abs(byCategory.get("loot.weapon.mundane") - expectedWeapon) < 1e-12,
    "one prior category hit applies exactly one diversity penalty",
  );
}

/* Mixed bundles cap scrolls; an explicit Scroll-only roll does not. */
{
  const scrolls = Array.from({ length: 6 }, (_, index) => ({
    ...fakeItem({
      _id: `scroll-${index}`,
      type: "consumable",
      lootType: "loot.scroll",
      properties: ["mgc"],
    }),
    uuid: `Compendium.infinity-dnd5e.scroll-${index}`,
  }));
  const weapons = Array.from({ length: 6 }, (_, index) =>
    fakeItem({ _id: `mixed-weapon-${index}` }),
  );
  const mixedOptions = getEncounterBalanceOptions({
    tier: "t2",
    lootTypes: [],
  });
  assert.equal(mixedOptions.categoryCaps["loot.scroll"], ENCOUNTER_SCROLL_CAP);
  for (let seed = 1; seed <= 100; seed += 1) {
    const result = rollLoot([...scrolls, ...weapons], {
      count: 8,
      ...mixedOptions,
      rng: mulberry32(seed),
    });
    const scrollCount = result.items.filter(
      (entry) => getItemRollCategory(entry.item) === "loot.scroll",
    ).length;
    assert.ok(
      scrollCount <= 1,
      `seed ${seed}: mixed roll has at most one scroll`,
    );
  }

  const scrollOnlyOptions = getEncounterBalanceOptions({
    tier: "t2",
    lootTypes: ["loot.scroll"],
  });
  assert.equal(
    scrollOnlyOptions.categoryCaps["loot.scroll"],
    undefined,
    "an explicit Scroll-only filter removes the mixed-bundle cap",
  );
  const scrollOnly = rollLoot(scrolls, {
    count: 3,
    ...scrollOnlyOptions,
    rng: mulberry32(7),
  });
  assert.equal(scrollOnly.items.length, 3);
  assert.ok(
    scrollOnly.items.every(
      (entry) => getItemRollCategory(entry.item) === "loot.scroll",
    ),
  );

  const legacyHistoryEntries = [
    {
      item: {
        uuid: scrolls[0].uuid,
        name: scrolls[0].name,
        img: scrolls[0].img,
      },
    },
  ];
  restoreStoredRollCategories(legacyHistoryEntries, [...scrolls, ...weapons]);
  assert.equal(
    legacyHistoryEntries[0].rollCategory,
    "loot.scroll",
    "pre-update slim history entries recover categories from pack UUIDs",
  );
  const restoredOptions = getEncounterBalanceOptions({
    tier: "t2",
    existingItems: legacyHistoryEntries,
  });
  const afterHistoryRestore = rollLoot([...scrolls, ...weapons], {
    count: 4,
    ...restoredOptions,
    rng: mulberry32(19),
  });
  assert.equal(
    afterHistoryRestore.items.some(
      (entry) => getItemRollCategory(entry.item) === "loot.scroll",
    ),
    false,
    "a slim history entry still consumes the mixed-bundle scroll cap",
  );
}

/* Hard Magic Bias endpoints never leak the excluded side. */
{
  const mundane = fakeItem({
    _id: "endpoint-mundane",
    lootType: "loot.weapon.mundane",
  });
  const magic = fakeItem({
    _id: "endpoint-magic",
    rarity: "uncommon",
    tier: "t2",
    lootType: "loot.weapon.magic",
  });
  const categoryWeights = {
    "loot.weapon.mundane": 1,
    "loot.weapon.magic": 1,
  };
  const magicOnly = rollLoot([mundane, magic], {
    count: 1,
    magicBias: 1,
    categoryWeights,
    rng: mulberry32(11),
  });
  assert.equal(
    getItemRollCategory(magicOnly.items[0]?.item),
    "loot.weapon.magic",
  );

  const mundaneOnly = rollLoot([mundane, magic], {
    count: 1,
    magicBias: -1,
    categoryWeights,
    rng: mulberry32(11),
  });
  assert.equal(
    getItemRollCategory(mundaneOnly.items[0]?.item),
    "loot.weapon.mundane",
  );

  const impossible = rollLoot([mundane], {
    count: 1,
    magicBias: 1,
    categoryWeights,
    rng: mulberry32(11),
  });
  assert.equal(
    impossible.items.length,
    0,
    "a hard endpoint does not fall back to its excluded side",
  );
}

/* The same effective rarity used by filters is available to result displays. */
{
  const variableGem = fakeItem({
    _id: "effective-gem",
    type: "loot",
    rarity: "",
    valueBand: "v4",
    lootType: "loot.loot",
    variableTreasureKind: "gem",
    keywords: ["loot.loot", "loot.variable.gem", "treasure.gem"],
  });
  assert.equal(getEffectiveRarity(variableGem), "rare");
}

/* Seeded full-pack calibration guards the intended tier progression. */
{
  const items = readFileSync("packs/infinity-dnd5e-items.db", "utf8")
    .split(/\r?\n/)
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line));
  const expectations = {
    t1: {
      rarities: { common: [0.95, 1] },
      magic: [0.02, 0.15],
    },
    t2: {
      rarities: { common: [0.6, 0.9], uncommon: [0.1, 0.4] },
      magic: [0.1, 0.3],
    },
    t3: {
      rarities: {
        uncommon: [0.4, 0.7],
        rare: [0.25, 0.6],
        "very-rare": [0.005, 0.03],
      },
      magic: [0.45, 0.75],
    },
    t4: {
      rarities: {
        rare: [0.45, 0.75],
        "very-rare": [0.2, 0.55],
        legendary: [0.015, 0.06],
      },
      magic: [0.6, 0.9],
    },
    t5: {
      rarities: { "very-rare": [0.55, 0.85], legendary: [0.15, 0.45] },
      magic: [0.7, 0.95],
    },
  };

  for (const tier of TIERS) {
    const candidates = filterCandidates(items, {
      tiers: tierWindow(tier),
      rarities: [],
      lootTypes: [],
      requireEligible: true,
    });
    const budgetGp = computeLootBudget({
      tier,
      scaleMultiplier: 1,
      generosityMultiplier: 1,
      partySize: 4,
    });
    const categoryCounts = new Map();
    const rarityCounts = new Map();
    let totalLines = 0;
    let totalGp = 0;
    let magicLines = 0;
    let scrollBundles = 0;

    for (let seed = 1; seed <= 400; seed += 1) {
      const result = rollLoot(candidates, {
        count: 0,
        budgetGp,
        magicBias: 0,
        ...getEncounterBalanceOptions({ tier }),
        rng: mulberry32(seed * 997 + Number(tier.slice(1)) * 100_000),
      });
      assert.ok(result.items.length > 0, `${tier} seed ${seed}: nonempty roll`);
      totalGp += result.totalGp;
      totalLines += result.items.length;
      let bundleScrolls = 0;
      for (const entry of result.items) {
        const category = getItemRollCategory(entry.item);
        const rarity = getEffectiveRarity(entry.item);
        categoryCounts.set(category, (categoryCounts.get(category) ?? 0) + 1);
        rarityCounts.set(rarity, (rarityCounts.get(rarity) ?? 0) + 1);
        if (getItemMagicNature(entry.item) === "magic") magicLines += 1;
        if (category === "loot.scroll") bundleScrolls += 1;
      }
      assert.ok(
        bundleScrolls <= 1,
        `${tier} seed ${seed}: mixed bundle never exceeds one scroll`,
      );
      if (bundleScrolls > 0) scrollBundles += 1;
    }

    const averageBudgetUse = totalGp / 400 / budgetGp;
    assert.ok(
      averageBudgetUse >= 0.75 && averageBudgetUse <= 1.05,
      `${tier}: average budget use stays practical (${averageBudgetUse.toFixed(3)})`,
    );
    assert.ok(
      scrollBundles / 400 <= 0.18,
      `${tier}: scroll-bearing bundles stay occasional (${scrollBundles}/400)`,
    );
    const largestCategoryShare =
      Math.max(...categoryCounts.values()) / totalLines;
    assert.ok(
      largestCategoryShare <= 0.35,
      `${tier}: no category dominates (${largestCategoryShare.toFixed(3)})`,
    );
    for (const [rarity, [low, high]] of Object.entries(
      expectations[tier].rarities,
    )) {
      const share = (rarityCounts.get(rarity) ?? 0) / totalLines;
      assert.ok(
        share >= low && share <= high,
        `${tier}: ${rarity} share ${share.toFixed(3)} is within ${low}-${high}`,
      );
    }
    const magicShare = magicLines / totalLines;
    const [magicLow, magicHigh] = expectations[tier].magic;
    assert.ok(
      magicShare >= magicLow && magicShare <= magicHigh,
      `${tier}: magic share ${magicShare.toFixed(3)} is within ${magicLow}-${magicHigh}`,
    );
  }
}

process.stdout.write("encounter-balance validation passed\n");
