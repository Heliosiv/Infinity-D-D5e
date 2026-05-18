import assert from "node:assert/strict";

import { computePackStats, countBy } from "./loot/pack-stats.js";

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

process.stdout.write("pack-stats validation passed\n");
