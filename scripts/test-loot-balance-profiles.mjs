import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { computeLootBudget } from "./loot/budget.js";
import {
  LOOT_BALANCE_PROFILE_IDS,
  getLootBundleBalanceOptions,
  getLootBundleCategoryWeights,
  getLootBundleRarityWeights,
} from "./loot/category-balance.js";
import {
  HOARD_DEFAULT_ITEM_CEILING,
  computeHoardBudget,
  getDefaultRarities,
  splitCoinPile,
} from "./loot/hoard-budget.js";
import { getItemRollCategory } from "./loot/item-categories.js";
import {
  estimateLootChances,
  filterCandidates,
  getEffectiveRarity,
  rollLoot,
} from "./loot/roller.js";
import {
  LOOT_TYPES,
  RARITIES,
  TIERS,
  getItemMagicNature,
  tierWindow,
} from "./loot/tag-vocabulary.js";
import { fakeItem } from "./test-utils/fixtures.mjs";
import { mulberry32 } from "./test-utils/rng.mjs";

const PROFILE_IDS = Object.values(LOOT_BALANCE_PROFILE_IDS);

/* Every selection profile is complete and normalized. */
for (const profileId of PROFILE_IDS) {
  for (const tier of TIERS) {
    const categoryWeights = getLootBundleCategoryWeights(tier, profileId);
    assert.deepEqual(
      Object.keys(categoryWeights).sort(),
      [...LOOT_TYPES].sort(),
      `${profileId}/${tier}: every visible category has an explicit weight`,
    );
    assert.ok(
      Math.abs(
        Object.values(categoryWeights).reduce(
          (sum, weight) => sum + weight,
          0,
        ) - 100,
      ) < 1e-9,
      `${profileId}/${tier}: category percentages total 100`,
    );

    const rarityWeights = getLootBundleRarityWeights(tier, profileId);
    assert.deepEqual(
      Object.keys(rarityWeights).sort(),
      [...RARITIES].sort(),
      `${profileId}/${tier}: every rarity has an explicit weight`,
    );
  }
}

/* Caps match each generator's bundle semantics. */
{
  const encounter = getLootBundleBalanceOptions({
    profileId: LOOT_BALANCE_PROFILE_IDS.ENCOUNTER,
  });
  const creature = getLootBundleBalanceOptions({
    profileId: LOOT_BALANCE_PROFILE_IDS.CREATURE,
  });
  assert.equal(encounter.categoryCaps["loot.scroll"], 1);
  assert.equal(creature.categoryCaps["loot.scroll"], 1);

  for (const [scale, expectedCap] of [
    ["small", 1],
    ["standard", 1],
    ["large", 2],
    ["massive", 2],
  ]) {
    const hoard = getLootBundleBalanceOptions({
      profileId: LOOT_BALANCE_PROFILE_IDS.HOARD,
      scale,
    });
    assert.equal(
      hoard.categoryCaps["loot.scroll"],
      expectedCap,
      `${scale} hoard scroll cap`,
    );
  }

  const merchant = getLootBundleBalanceOptions({
    profileId: LOOT_BALANCE_PROFILE_IDS.MERCHANT,
  });
  assert.equal(
    merchant.categoryCaps["loot.scroll"],
    undefined,
    "merchant shelves do not impose a loot-bundle scroll cap",
  );

  for (const profileId of PROFILE_IDS) {
    const scrollOnly = getLootBundleBalanceOptions({
      profileId,
      lootTypes: ["loot.scroll"],
    });
    assert.equal(
      scrollOnly.categoryCaps["loot.scroll"],
      undefined,
      `${profileId}: explicit Scroll-only selection is uncapped`,
    );
  }
}

/* An explicit caller rarity control replaces the profile curve. */
{
  const override = Object.fromEntries(
    RARITIES.map((rarity, index) => [rarity, index + 0.25]),
  );
  const options = getLootBundleBalanceOptions({
    profileId: LOOT_BALANCE_PROFILE_IDS.HOARD,
    tier: "t5",
    rarityWeights: override,
  });
  assert.deepEqual(options.rarityWeights, override);
}

/* Merchant category odds are independent of documents-per-category. */
{
  const weapons = Array.from({ length: 100 }, (_, index) =>
    fakeItem({
      _id: `merchant-weapon-${index}`,
      lootType: "loot.weapon.mundane",
    }),
  );
  const potion = fakeItem({
    _id: "merchant-potion",
    type: "consumable",
    lootType: "loot.potion",
    properties: ["mgc"],
  });
  const options = getLootBundleBalanceOptions({
    profileId: LOOT_BALANCE_PROFILE_IDS.MERCHANT,
  });
  const chance = estimateLootChances([...weapons, potion], options);
  const byCategory = new Map(
    chance.categories.map(({ key, probability }) => [key, probability]),
  );
  const expectedWeapon = 8 / (8 + 10);
  assert.ok(
    Math.abs(byCategory.get("loot.weapon.mundane") - expectedWeapon) < 1e-12,
    "100 weapon documents still receive only the configured category share",
  );
  assert.ok(
    Math.abs(byCategory.get("loot.potion") - (1 - expectedWeapon)) < 1e-12,
  );
}

/* Seeded full-pack calibration for the new Hoard and Creature profiles. */
{
  const items = readFileSync("packs/infinity-dnd5e-items.db", "utf8")
    .split(/\r?\n/)
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line));
  const creatureMagicBands = {
    t1: [0, 0.05],
    t2: [0.05, 0.2],
    t3: [0.5, 0.75],
    t4: [0.65, 0.8],
    t5: [0.74, 0.86],
  };
  const measuredCreatureMagicShares = [];

  for (const tier of TIERS) {
    const candidates = filterCandidates(items, {
      tiers: tierWindow(tier),
      rarities: [],
      lootTypes: [],
      requireEligible: true,
    });
    const creatureBudget = computeLootBudget({
      tier,
      scale: "trivial",
      partySize: 4,
    });
    const categoryCounts = new Map();
    const rarityCounts = new Map();
    let totalLines = 0;
    let magicLines = 0;
    let scrollBundles = 0;

    for (let seed = 1; seed <= 300; seed += 1) {
      const result = rollLoot(candidates, {
        count: 2,
        budgetGp: creatureBudget,
        magicBias: 0,
        ...getLootBundleBalanceOptions({
          profileId: LOOT_BALANCE_PROFILE_IDS.CREATURE,
          tier,
        }),
        rng: mulberry32(seed * 811 + Number(tier.slice(1)) * 50_000),
      });
      assert.ok(result.items.length > 0, `${tier}: creature roll is nonempty`);
      assert.ok(
        result.items.length <= 2,
        `${tier}: creature count stays capped`,
      );
      let scrolls = 0;
      for (const entry of result.items) {
        const category = getItemRollCategory(entry.item);
        const rarity = getEffectiveRarity(entry.item);
        categoryCounts.set(category, (categoryCounts.get(category) ?? 0) + 1);
        rarityCounts.set(rarity, (rarityCounts.get(rarity) ?? 0) + 1);
        if (getItemMagicNature(entry.item) === "magic") magicLines += 1;
        if (category === "loot.scroll") scrolls += 1;
        totalLines += 1;
      }
      assert.ok(
        scrolls <= 1,
        `${tier}: creature bundle has at most one scroll`,
      );
      if (scrolls > 0) scrollBundles += 1;
    }

    const largestCategoryShare =
      Math.max(...categoryCounts.values()) / totalLines;
    const magicShare = magicLines / totalLines;
    const [minMagicShare, maxMagicShare] = creatureMagicBands[tier];
    measuredCreatureMagicShares.push(magicShare);
    assert.ok(
      largestCategoryShare <= 0.35,
      `${tier}: creature category share ${largestCategoryShare.toFixed(3)}`,
    );
    assert.ok(
      scrollBundles / 300 <= 0.07,
      `${tier}: creature scroll bundles stay rare (${scrollBundles}/300)`,
    );
    assert.ok(
      magicShare >= minMagicShare && magicShare <= maxMagicShare,
      `${tier}: creature magic share ${magicShare.toFixed(3)} stays in ${minMagicShare.toFixed(2)}-${maxMagicShare.toFixed(2)}`,
    );
    assert.ok(
      rarityCounts.size > 0,
      `${tier}: creature rarity distribution was measured`,
    );
    if (tier === "t4") {
      const rareShare = (rarityCounts.get("rare") ?? 0) / totalLines;
      const veryRareShare = (rarityCounts.get("very-rare") ?? 0) / totalLines;
      const legendaryShare = (rarityCounts.get("legendary") ?? 0) / totalLines;
      assert.ok(
        rareShare >= 0.7 && rareShare <= 0.86,
        `t4: rare share ${rareShare.toFixed(3)}`,
      );
      assert.ok(
        veryRareShare >= 0.14 && veryRareShare <= 0.3,
        `t4: very-rare share ${veryRareShare.toFixed(3)}`,
      );
      assert.ok(
        legendaryShare <= 0.01,
        `t4: legendary share ${legendaryShare.toFixed(3)}`,
      );
    }
    if (tier === "t5") {
      const veryRareShare = (rarityCounts.get("very-rare") ?? 0) / totalLines;
      const legendaryShare = (rarityCounts.get("legendary") ?? 0) / totalLines;
      const artifactShare = (rarityCounts.get("artifact") ?? 0) / totalLines;
      assert.ok(
        veryRareShare >= 0.82 && veryRareShare <= 0.95,
        `t5: very-rare share ${veryRareShare.toFixed(3)}`,
      );
      assert.ok(
        legendaryShare >= 0.05 && legendaryShare <= 0.18,
        `t5: legendary share ${legendaryShare.toFixed(3)}`,
      );
      assert.ok(
        artifactShare <= 0.01,
        `t5: artifact share ${artifactShare.toFixed(3)}`,
      );
    }
  }
  for (let index = 1; index < measuredCreatureMagicShares.length; index += 1) {
    assert.ok(
      measuredCreatureMagicShares[index] >=
        measuredCreatureMagicShares[index - 1],
      `${TIERS[index]}: creature magic share progresses with threat tier`,
    );
  }

  for (const tier of TIERS) {
    const scale = "standard";
    const totalBudget = computeHoardBudget({ tier, scale });
    const { coinPileGp, itemBudget } = splitCoinPile(totalBudget, 0);
    const candidates = filterCandidates(items, {
      tiers: tierWindow(tier),
      rarities: getDefaultRarities(tier, scale),
      lootTypes: [],
      requireEligible: true,
    });
    const categoryCounts = new Map();
    let totalLines = 0;
    let scrollBundles = 0;
    let totalCoverage = 0;

    for (let seed = 1; seed <= 200; seed += 1) {
      const result = rollLoot(candidates, {
        count: 8,
        budgetGp: itemBudget,
        magicBias: 0,
        ...getLootBundleBalanceOptions({
          profileId: LOOT_BALANCE_PROFILE_IDS.HOARD,
          tier,
          scale,
          rarityWeights: Object.fromEntries(
            RARITIES.map((rarity) => [rarity, 1]),
          ),
        }),
        rng: mulberry32(seed * 613 + Number(tier.slice(1)) * 70_000),
      });
      assert.ok(result.items.length > 0, `${tier}: hoard items are nonempty`);
      let scrolls = 0;
      for (const entry of result.items) {
        const category = getItemRollCategory(entry.item);
        categoryCounts.set(category, (categoryCounts.get(category) ?? 0) + 1);
        if (category === "loot.scroll") scrolls += 1;
        totalLines += 1;
      }
      assert.ok(scrolls <= 1, `${tier}: standard hoard respects scroll cap`);
      if (scrolls > 0) scrollBundles += 1;
      totalCoverage += (coinPileGp + result.totalGp) / totalBudget;
    }

    const largestCategoryShare =
      Math.max(...categoryCounts.values()) / totalLines;
    assert.ok(
      largestCategoryShare <= 0.35,
      `${tier}: hoard category share ${largestCategoryShare.toFixed(3)}`,
    );
    assert.ok(
      scrollBundles / 200 <= 0.25,
      `${tier}: hoard scroll bundles stay occasional (${scrollBundles}/200)`,
    );
    assert.ok(
      totalCoverage / 200 >= 0.55 && totalCoverage / 200 <= 1.05,
      `${tier}: hoard value coverage ${(totalCoverage / 200).toFixed(3)}`,
    );
  }

  /* Massive high-tier hoards remain epic without returning scrolls in every
   * other cache or collapsing the candidate pool to magic-only items. */
  for (const tier of ["t4", "t5"]) {
    const scale = "massive";
    const totalBudget = computeHoardBudget({ tier, scale });
    const { itemBudget } = splitCoinPile(totalBudget, 0);
    const candidates = filterCandidates(items, {
      tiers: tierWindow(tier),
      rarities: getDefaultRarities(tier, scale),
      lootTypes: [],
      requireEligible: true,
    });
    let totalLines = 0;
    let magicLines = 0;
    let scrollBundles = 0;
    let multiScrollBundles = 0;

    if (tier === "t5") {
      assert.ok(
        candidates.length >= 250,
        "T5 Massive defaults retain a broad very-rare through artifact pool",
      );
    }

    for (let seed = 1; seed <= 150; seed += 1) {
      const result = rollLoot(candidates, {
        count: HOARD_DEFAULT_ITEM_CEILING[scale],
        budgetGp: itemBudget,
        magicBias: 0,
        ...getLootBundleBalanceOptions({
          profileId: LOOT_BALANCE_PROFILE_IDS.HOARD,
          tier,
          scale,
          rarityWeights: Object.fromEntries(
            RARITIES.map((rarity) => [rarity, 1]),
          ),
        }),
        rng: mulberry32(seed * 991 + Number(tier.slice(1)) * 90_000),
      });
      let scrolls = 0;
      for (const entry of result.items) {
        const category = getItemRollCategory(entry.item);
        if (category === "loot.scroll") scrolls += 1;
        if (getItemMagicNature(entry.item) === "magic") magicLines += 1;
        totalLines += 1;
      }
      assert.ok(scrolls <= 2, `${tier}: Massive hoard scroll cap`);
      if (scrolls > 0) scrollBundles += 1;
      if (scrolls > 1) multiScrollBundles += 1;
    }

    assert.ok(
      scrollBundles / 150 <= 0.35,
      `${tier}: Massive hoard scroll bundles stay occasional (${scrollBundles}/150)`,
    );
    assert.ok(
      multiScrollBundles / 150 <= 0.08,
      `${tier}: Massive multi-scroll bundles stay rare (${multiScrollBundles}/150)`,
    );
    assert.ok(
      magicLines / totalLines <= 0.9,
      `${tier}: Massive hoards retain non-magic treasure`,
    );
  }
}

process.stdout.write("loot-balance profile validation passed\n");
