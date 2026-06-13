import assert from "node:assert/strict";

import {
  computePackStats,
  computeTierFilteredStats,
  countBy,
} from "./loot/pack-stats.js";

import { fakeItem, smallPool } from "./test-utils/fixtures.mjs";

/* empty pool returns a zeroed snapshot */
{
  const stats = computePackStats([]);
  assert.equal(stats.totalItems, 0);
  assert.equal(stats.eligibleItems, 0);
  assert.deepEqual(stats.byTier, {});
  assert.deepEqual(stats.byRarity, {});
  assert.deepEqual(stats.byLootType, {});
  assert.deepEqual(stats.byMagicNature, { magic: 0, mundane: 0, neutral: 0 });
  assert.equal(stats.gp.min, 0);
  assert.equal(stats.gp.max, 0);
}

/* small pool — counts shake out the way we'd expect */
{
  const stats = computePackStats(smallPool());
  assert.equal(stats.totalItems, 5);
  assert.equal(stats.eligibleItems, 5, "all small-pool items are eligible");
  // byTier
  assert.equal(stats.byTier.t1, 2, "Dagger + Healing Potion are t1");
  assert.equal(stats.byTier.t2, 2, "Greatsword + Wand are t2");
  assert.equal(stats.byTier.t4, 1, "Crown of Stars is t4");
  // byRarity
  assert.equal(stats.byRarity.common, 2);
  assert.equal(stats.byRarity.uncommon, 2);
  assert.equal(stats.byRarity.legendary, 1);
  // gp
  assert.equal(stats.gp.min, 5);
  assert.equal(stats.gp.max, 50000);
  assert.equal(stats.gp.total, 5 + 50 + 500 + 800 + 50000);
}

/* magic-nature buckets reflect the loot type classification */
{
  const stats = computePackStats(smallPool());
  // Magic: Greatsword (magic), Wand, Crown of Stars, Potion (consumable→magic) = 4
  // Mundane: Dagger = 1
  // Neutral: 0
  assert.equal(stats.byMagicNature.magic, 4);
  assert.equal(stats.byMagicNature.mundane, 1);
  assert.equal(stats.byMagicNature.neutral, 0);
}

/* ineligible items are excluded from eligibleItems but counted in totalItems */
{
  const pool = [
    fakeItem({ _id: "ok", lootEligible: true }),
    fakeItem({ _id: "no", lootEligible: false }),
  ];
  const stats = computePackStats(pool);
  assert.equal(stats.totalItems, 2);
  assert.equal(stats.eligibleItems, 1);
}

/* gp.median and gp.p95 are populated when there are items with prices */
{
  const stats = computePackStats(smallPool());
  assert.ok(stats.gp.median > 0, "median is non-zero");
  assert.ok(stats.gp.p95 >= stats.gp.median, "p95 ≥ median");
}

/* countBy — small utility for ad-hoc grouping */
{
  const pool = smallPool();
  const byType = countBy(
    pool,
    (item) => item.flags["party-operations"].lootType,
  );
  assert.equal(byType["loot.weapon.mundane"], 1);
  assert.equal(byType["loot.wondrous"], 1);
  assert.throws(
    () => countBy(pool, "not-a-function"),
    /key must be a function/,
    "non-function key is rejected",
  );
}

/* computeTierFilteredStats — tier window narrows the counts */
{
  const pool = smallPool();
  // smallPool tiers: a=t1, b=t1, c=t2, d=t2, e=t4
  const t1Only = computeTierFilteredStats(pool, ["t1"]);
  assert.equal(t1Only.total, 2, "two t1 items");
  assert.equal(t1Only.byRarity.common, 2);
  assert.equal(t1Only.byRarity.uncommon, undefined);

  const t1t2 = computeTierFilteredStats(pool, ["t1", "t2"]);
  assert.equal(t1t2.total, 4, "T1+T2 covers four items");
  assert.equal(t1t2.byRarity.common, 2);
  assert.equal(t1t2.byRarity.uncommon, 2);
  assert.equal(
    t1t2.byRarity.legendary,
    undefined,
    "legendary T4 item is outside the window",
  );

  // null / empty window returns pack-wide counts
  const wide = computeTierFilteredStats(pool, null);
  assert.equal(wide.total, 5);
  assert.equal(wide.byRarity.legendary, 1, "legendary surfaces when unscoped");

  // Loot types are counted too
  const t2 = computeTierFilteredStats(pool, ["t2"]);
  assert.equal(t2.byLootType["loot.weapon.magic"], 1);
  assert.equal(t2.byLootType["loot.wand"], 1);

  // Ineligible items are excluded
  const mixedPool = [
    fakeItem({ _id: "ok", tier: "t1", lootEligible: true, rarity: "common" }),
    fakeItem({ _id: "no", tier: "t1", lootEligible: false, rarity: "common" }),
  ];
  const eligibleOnly = computeTierFilteredStats(mixedPool, ["t1"]);
  assert.equal(eligibleOnly.total, 1, "ineligible items not counted");
  assert.equal(eligibleOnly.byRarity.common, 1);
}

/* ammunition — synthetic loot.ammunition bucket counts arrows/bolts/bullets
   even though the pack tags them loot.consumable */
{
  const ammo = fakeItem({
    _id: "arrow",
    name: "Arrow",
    tier: "t1",
    lootType: "loot.consumable",
    keywords: [
      "subtype.ammo",
      "rarity.common",
      "tier.t1",
      "value.v1",
      "loot.consumable",
    ],
  });
  const potion = fakeItem({
    _id: "potion",
    name: "Healing Potion",
    tier: "t1",
    lootType: "loot.consumable",
  });

  const stats = computePackStats([ammo, potion]);
  assert.equal(
    stats.byLootType["loot.consumable"],
    2,
    "both still count as consumables",
  );
  assert.equal(
    stats.byLootType["loot.ammunition"],
    1,
    "only the arrow counts toward the synthetic ammunition chip",
  );

  const tierStats = computeTierFilteredStats([ammo, potion], ["t1"]);
  assert.equal(
    tierStats.byLootType["loot.ammunition"],
    1,
    "ammo is counted in the tier-windowed chip stats too",
  );
  assert.equal(tierStats.byLootType["loot.consumable"], 2);
}

/* variable gem/art — synthetic loot.gem / loot.art buckets count treasure
   that ships tagged loot.loot, matching what selecting those chips returns */
{
  const gem = fakeItem({
    _id: "gem",
    name: "Star Sapphire",
    type: "loot",
    tier: "t2",
    lootType: "loot.loot",
    keywords: ["loot", "loot.loot", "loot.variable.gem", "treasure.gem"],
  });
  const art = fakeItem({
    _id: "art",
    name: "Court Tapestry",
    type: "loot",
    tier: "t2",
    lootType: "loot.loot",
    keywords: [
      "loot",
      "loot.loot",
      "loot.variable.art",
      "treasure.art",
      "folder.path.sundries.art-objects.wall-art",
    ],
  });

  const stats = computePackStats([gem, art]);
  // Both also land in the trade-good count (loot.loot → loot.trade-good).
  assert.equal(stats.byLootType["loot.trade-good"], 2);
  assert.equal(stats.byLootType["loot.gem"], 1, "Gem chip count is non-zero");
  assert.equal(stats.byLootType["loot.art"], 1, "Art chip count is non-zero");

  const tierStats = computeTierFilteredStats([gem, art], ["t2"]);
  assert.equal(tierStats.byLootType["loot.gem"], 1);
  assert.equal(tierStats.byLootType["loot.art"], 1);
  assert.equal(tierStats.byLootType["loot.trade-good"], 2);
}

process.stdout.write("pack-stats validation passed\n");
