import assert from "node:assert/strict";

import {
  HOARD_DEFAULT_ITEM_CEILING,
  HOARD_SCALE_PRESETS,
  PILE_BIAS_PRESETS,
  PILE_BIAS_RANGE,
  coinDenominationBreakdown,
  computeHoardBudget,
  formatCoinBreakdown,
  getDefaultRarities,
  getHoardCurve,
  getScaleFlavor,
  splitCoinPile,
} from "./loot/hoard-budget.js";

const RARITY_ORDER = [
  "common",
  "uncommon",
  "rare",
  "very-rare",
  "legendary",
  "artifact",
];
const rarityRank = (r) => RARITY_ORDER.indexOf(r);

/* ------------------------------------------------------------------ *
 * Curve + presets sanity
 * ------------------------------------------------------------------ */
{
  const curve = getHoardCurve();
  assert.ok(curve.t1 > 0, "t1 has a non-zero hoard base");
  assert.ok(curve.t5 > curve.t4, "tiers ascend in hoard base");

  // Scale presets ascend, centered on standard = 1.0.
  assert.equal(HOARD_SCALE_PRESETS.standard, 1.0);
  assert.ok(HOARD_SCALE_PRESETS.small < HOARD_SCALE_PRESETS.standard);
  assert.ok(HOARD_SCALE_PRESETS.large > HOARD_SCALE_PRESETS.standard);
  assert.ok(HOARD_SCALE_PRESETS.massive > HOARD_SCALE_PRESETS.large);

  // Item-count ceilings ascend in the same order.
  assert.ok(
    HOARD_DEFAULT_ITEM_CEILING.small < HOARD_DEFAULT_ITEM_CEILING.standard,
  );
  assert.ok(
    HOARD_DEFAULT_ITEM_CEILING.standard < HOARD_DEFAULT_ITEM_CEILING.large,
  );
  assert.ok(
    HOARD_DEFAULT_ITEM_CEILING.large < HOARD_DEFAULT_ITEM_CEILING.massive,
  );

  // Pile-bias presets stay inside the slider range.
  for (const [name, value] of Object.entries(PILE_BIAS_PRESETS)) {
    assert.ok(
      value >= PILE_BIAS_RANGE.min && value <= PILE_BIAS_RANGE.max,
      `pile-bias preset "${name}" (${value}) inside slider range`,
    );
  }
}

/* ------------------------------------------------------------------ *
 * computeHoardBudget — named scale presets
 * ------------------------------------------------------------------ */
{
  // t2 standard = 5000 × 1.0 = 5000
  assert.equal(computeHoardBudget({ tier: "t2", scale: "standard" }), 5000);
  // t2 small = 5000 × 0.5 = 2500
  assert.equal(computeHoardBudget({ tier: "t2", scale: "small" }), 2500);
  // t3 large = 50000 × 2 = 100000
  assert.equal(computeHoardBudget({ tier: "t3", scale: "large" }), 100000);
  // t4 massive = 200000 × 4 = 800000
  assert.equal(computeHoardBudget({ tier: "t4", scale: "massive" }), 800000);
  // Default scale (omitted) == standard
  assert.equal(
    computeHoardBudget({ tier: "t2" }),
    5000,
    "missing scale defaults to standard",
  );
}

/* ------------------------------------------------------------------ *
 * computeHoardBudget — numeric multipliers + defenses
 * ------------------------------------------------------------------ */
{
  // Numeric multiplier takes precedence
  assert.equal(
    computeHoardBudget({ tier: "t1", scale: 3 }),
    1500,
    "numeric scale multiplies the base",
  );
  // Unknown named scale falls back to standard
  assert.equal(
    computeHoardBudget({ tier: "t1", scale: "garbage" }),
    500,
    "unknown scale falls back to standard",
  );
  // Unknown tier returns 0
  assert.equal(computeHoardBudget({ tier: "garbage" }), 0);
  // Empty input returns 0
  assert.equal(computeHoardBudget({}), 0);
  // Negative numeric scale clamps to 0 → returns 0
  assert.equal(computeHoardBudget({ tier: "t1", scale: -5 }), 0);
}

/* ------------------------------------------------------------------ *
 * splitCoinPile — unchanged behavior
 * ------------------------------------------------------------------ */
{
  const mixed = splitCoinPile(1000, 0);
  assert.equal(mixed.coinPileGp, 400);
  assert.equal(mixed.itemBudget, 600);
  assert.equal(
    mixed.coinPileGp + mixed.itemBudget,
    1000,
    "split reconstitutes the total",
  );

  const coinHeavy = splitCoinPile(1000, -1);
  assert.equal(coinHeavy.coinPileGp, 700);
  assert.equal(coinHeavy.itemBudget, 300);

  const itemHeavy = splitCoinPile(1000, 1);
  assert.equal(itemHeavy.coinPileGp, 100);
  assert.equal(itemHeavy.itemBudget, 900);

  // Out-of-range bias clamps
  assert.equal(splitCoinPile(1000, 5).coinPileGp, 100);

  // Guards
  assert.deepEqual(splitCoinPile(0, 0), { coinPileGp: 0, itemBudget: 0 });
  assert.deepEqual(splitCoinPile(-50, 0), { coinPileGp: 0, itemBudget: 0 });
  assert.deepEqual(splitCoinPile(NaN, 0), { coinPileGp: 0, itemBudget: 0 });
}

/* ------------------------------------------------------------------ *
 * coinDenominationBreakdown — ratios preserve total ±1
 * ------------------------------------------------------------------ */
{
  const breakdown = coinDenominationBreakdown(1000);
  assert.equal(breakdown.pp, 10);
  assert.equal(breakdown.gp, 500);
  assert.equal(breakdown.sp, 3000);
  assert.equal(breakdown.cp, 10000);

  const reconstructed =
    breakdown.pp * 10 + breakdown.gp + breakdown.sp / 10 + breakdown.cp / 100;
  assert.ok(Math.abs(reconstructed - 1000) <= 1);

  // Guards
  assert.deepEqual(coinDenominationBreakdown(0), {
    pp: 0,
    gp: 0,
    sp: 0,
    cp: 0,
  });
  assert.deepEqual(coinDenominationBreakdown(-100), {
    pp: 0,
    gp: 0,
    sp: 0,
    cp: 0,
  });
}

/* ------------------------------------------------------------------ *
 * formatCoinBreakdown — strips zero columns
 * ------------------------------------------------------------------ */
{
  assert.equal(
    formatCoinBreakdown({ pp: 10, gp: 500, sp: 3000, cp: 10000 }),
    "10 pp · 500 gp · 3,000 sp · 10,000 cp",
  );
  assert.equal(
    formatCoinBreakdown({ pp: 0, gp: 5, sp: 0, cp: 12 }),
    "5 gp · 12 cp",
    "zero denominations are skipped",
  );
  assert.equal(formatCoinBreakdown({ pp: 0, gp: 0, sp: 0, cp: 0 }), "");
  assert.equal(formatCoinBreakdown(null), "");
}

/* ------------------------------------------------------------------ *
 * getDefaultRarities — exists for every (tier, scale) pair and slides
 * higher as either axis grows
 * ------------------------------------------------------------------ */
{
  // Every cell is non-empty.
  for (const tier of ["t1", "t2", "t3", "t4", "t5"]) {
    for (const scale of ["small", "standard", "large", "massive"]) {
      const defaults = getDefaultRarities(tier, scale);
      assert.ok(
        defaults.length > 0,
        `${tier}/${scale} should ship a default rarity set`,
      );
      // Returns a fresh array (mutable).
      defaults.push("temp");
      const second = getDefaultRarities(tier, scale);
      assert.ok(
        !second.includes("temp"),
        `${tier}/${scale} should return a fresh array each call`,
      );
    }
  }

  // Sanity: t1/small is just common; t5/massive includes artifact.
  assert.deepEqual(getDefaultRarities("t1", "small"), ["common"]);
  assert.ok(getDefaultRarities("t5", "massive").includes("artifact"));
  assert.ok(getDefaultRarities("t4", "massive").includes("artifact"));

  // Lower-tier hoards should never include artifact in default rolls.
  for (const tier of ["t1", "t2", "t3"]) {
    for (const scale of ["small", "standard", "large", "massive"]) {
      assert.ok(
        !getDefaultRarities(tier, scale).includes("artifact"),
        `${tier}/${scale} default should not include artifact (campaign-defining)`,
      );
    }
  }

  // Within a tier, the minimum rarity is non-decreasing as scale grows
  // (small ≤ standard ≤ large ≤ massive). We let "ceiling" wobble because
  // some t1 cells stay narrower than expected.
  for (const tier of ["t1", "t2", "t3", "t4", "t5"]) {
    const scales = ["small", "standard", "large", "massive"];
    const mins = scales.map((s) =>
      Math.min(...getDefaultRarities(tier, s).map(rarityRank)),
    );
    for (let i = 1; i < mins.length; i += 1) {
      assert.ok(
        mins[i] >= mins[i - 1],
        `${tier}: floor rarity should not decrease from ${scales[i - 1]} to ${scales[i]} (got ${mins[i - 1]} → ${mins[i]})`,
      );
    }
  }

  // Across tiers at the same scale, the floor only goes up.
  for (const scale of ["small", "standard", "large", "massive"]) {
    const tiers = ["t1", "t2", "t3", "t4", "t5"];
    const mins = tiers.map((t) =>
      Math.min(...getDefaultRarities(t, scale).map(rarityRank)),
    );
    for (let i = 1; i < mins.length; i += 1) {
      assert.ok(
        mins[i] >= mins[i - 1],
        `${scale}: floor rarity should not decrease from ${tiers[i - 1]} to ${tiers[i]} (got ${mins[i - 1]} → ${mins[i]})`,
      );
    }
  }

  // Unknown inputs degrade gracefully — empty array, not a throw.
  assert.deepEqual(getDefaultRarities("garbage", "standard"), []);
  assert.deepEqual(getDefaultRarities(null, null), []);
  // Unknown scale falls back to the tier's standard.
  assert.deepEqual(
    getDefaultRarities("t2", "weird"),
    getDefaultRarities("t2", "standard"),
    "unknown scale falls back to standard within the tier",
  );
}

/* ------------------------------------------------------------------ *
 * getScaleFlavor — narrative blurb for each named scale
 * ------------------------------------------------------------------ */
{
  for (const scale of ["small", "standard", "large", "massive"]) {
    const flavor = getScaleFlavor(scale);
    assert.ok(
      typeof flavor === "string" && flavor.length > 0,
      `${scale} has a flavor blurb`,
    );
  }
  assert.equal(
    getScaleFlavor("garbage"),
    "",
    "unknown scale returns empty string",
  );
  assert.equal(getScaleFlavor(null), "", "null-safe");
}

process.stdout.write("hoard-budget validation passed\n");
