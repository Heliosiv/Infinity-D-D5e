import assert from "node:assert/strict";

import {
  MOB_SIZE_RANGE,
  PILE_BIAS_PRESETS,
  PILE_BIAS_RANGE,
  coinDenominationBreakdown,
  computeHordeBudget,
  formatCoinBreakdown,
  getHordeCurve,
  splitCoinPile,
} from "./loot/horde-budget.js";

/* ------------------------------------------------------------------ *
 * Curve sanity
 * ------------------------------------------------------------------ */
{
  const curve = getHordeCurve();
  assert.ok(curve.t1 > 0, "t1 has a non-zero per-creature gp");
  assert.ok(curve.t5 > curve.t4, "tiers ascend in gp/creature");
  assert.ok(MOB_SIZE_RANGE.min < MOB_SIZE_RANGE.max);
  assert.ok(PILE_BIAS_RANGE.min < PILE_BIAS_RANGE.max);
  // Named pile-bias presets stay inside the slider range.
  for (const [name, value] of Object.entries(PILE_BIAS_PRESETS)) {
    assert.ok(
      value >= PILE_BIAS_RANGE.min && value <= PILE_BIAS_RANGE.max,
      `pile-bias preset "${name}" (${value}) inside slider range`,
    );
  }
}

/* ------------------------------------------------------------------ *
 * computeHordeBudget — happy path
 * ------------------------------------------------------------------ */
{
  // t2 = 50 gp/creature × 8 mobs × 1.0 = 400
  assert.equal(computeHordeBudget({ tier: "t2", mobSize: 8 }), 400);
  // t3 = 250 × 12 = 3000
  assert.equal(computeHordeBudget({ tier: "t3", mobSize: 12 }), 3000);
  // Generosity multiplier applies linearly
  assert.equal(
    computeHordeBudget({ tier: "t2", mobSize: 8, generosityMultiplier: 1.5 }),
    600,
    "generosity multiplier scales the total",
  );
}

/* ------------------------------------------------------------------ *
 * computeHordeBudget — defenses
 * ------------------------------------------------------------------ */
{
  assert.equal(computeHordeBudget({}), 0, "missing tier returns 0");
  assert.equal(
    computeHordeBudget({ tier: "garbage", mobSize: 10 }),
    0,
    "unknown tier returns 0",
  );
  // Below-min mob size clamps up to MOB_SIZE_RANGE.min, not 1.
  const tinyMob = computeHordeBudget({ tier: "t1", mobSize: 0 });
  assert.equal(
    tinyMob,
    8 * MOB_SIZE_RANGE.min,
    "mob size 0 clamps to the floor of the slider",
  );
  // Above-max clamps to MOB_SIZE_RANGE.max
  const giantMob = computeHordeBudget({ tier: "t1", mobSize: 999 });
  assert.equal(
    giantMob,
    8 * MOB_SIZE_RANGE.max,
    "absurd mob sizes clamp to 60",
  );
  // Negative generosity clamps at 0 (silent zero, not a throw)
  assert.equal(
    computeHordeBudget({
      tier: "t1",
      mobSize: 10,
      generosityMultiplier: -3,
    }),
    0,
  );
}

/* ------------------------------------------------------------------ *
 * splitCoinPile — bias drives portion
 * ------------------------------------------------------------------ */
{
  // bias 0 → 40% coins
  const mixed = splitCoinPile(1000, 0);
  assert.equal(mixed.coinPileGp, 400);
  assert.equal(mixed.itemBudget, 600);
  assert.equal(
    mixed.coinPileGp + mixed.itemBudget,
    1000,
    "coin + item budgets reconstitute the total",
  );

  // bias -1 → 70% coins (clamps at 0.85)
  const coinHeavy = splitCoinPile(1000, -1);
  assert.equal(coinHeavy.coinPileGp, 700);
  assert.equal(coinHeavy.itemBudget, 300);

  // bias +1 → 10% coins
  const itemHeavy = splitCoinPile(1000, 1);
  assert.equal(itemHeavy.coinPileGp, 100);
  assert.equal(itemHeavy.itemBudget, 900);

  // Out-of-range bias clamps
  const extreme = splitCoinPile(1000, 5);
  assert.equal(extreme.coinPileGp, 100, "bias clamps to +1 → 10% coins");
}

/* ------------------------------------------------------------------ *
 * splitCoinPile — guards
 * ------------------------------------------------------------------ */
{
  assert.deepEqual(splitCoinPile(0, 0), { coinPileGp: 0, itemBudget: 0 });
  assert.deepEqual(splitCoinPile(-50, 0), { coinPileGp: 0, itemBudget: 0 });
  assert.deepEqual(splitCoinPile(NaN, 0), { coinPileGp: 0, itemBudget: 0 });
}

/* ------------------------------------------------------------------ *
 * coinDenominationBreakdown — values + ratios
 * ------------------------------------------------------------------ */
{
  const breakdown = coinDenominationBreakdown(1000);
  // pp = floor(100/10)        = 10
  // gp = floor(500)           = 500
  // sp = floor(300 * 10)      = 3000
  // cp = floor(100 * 100)     = 10000
  assert.equal(breakdown.pp, 10);
  assert.equal(breakdown.gp, 500);
  assert.equal(breakdown.sp, 3000);
  assert.equal(breakdown.cp, 10000);

  // Reconstructed gp value should match within rounding noise.
  const reconstructed =
    breakdown.pp * 10 + breakdown.gp + breakdown.sp / 10 + breakdown.cp / 100;
  assert.ok(
    Math.abs(reconstructed - 1000) <= 1,
    `reconstructed value ${reconstructed} within ±1 of input 1000`,
  );
}

/* ------------------------------------------------------------------ *
 * coinDenominationBreakdown — guards
 * ------------------------------------------------------------------ */
{
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
  const out = formatCoinBreakdown({ pp: 10, gp: 500, sp: 3000, cp: 10000 });
  assert.equal(out, "10 pp · 500 gp · 3,000 sp · 10,000 cp");

  const partial = formatCoinBreakdown({ pp: 0, gp: 5, sp: 0, cp: 12 });
  assert.equal(partial, "5 gp · 12 cp", "zero denominations are skipped");

  const empty = formatCoinBreakdown({ pp: 0, gp: 0, sp: 0, cp: 0 });
  assert.equal(empty, "");

  assert.equal(formatCoinBreakdown(null), "", "null payload is safe");
}

process.stdout.write("horde-budget validation passed\n");
