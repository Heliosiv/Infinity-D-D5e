import assert from "node:assert/strict";

import {
  HOARD_DEFAULT_ITEM_CEILING,
  HOARD_SCALE_PRESETS,
  PILE_BIAS_PRESETS,
  PILE_BIAS_RANGE,
  coinDenominationBreakdown,
  computeHoardBudget,
  formatCoinBreakdown,
  getHoardCurve,
  splitCoinPile,
} from "./loot/hoard-budget.js";

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

process.stdout.write("hoard-budget validation passed\n");
