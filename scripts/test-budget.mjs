import assert from "node:assert/strict";

import {
  GENEROSITY_PRESETS,
  GENEROSITY_RANGE,
  SCALE_PRESETS,
  SCALE_RANGE,
  classifyBudgetTier,
  computeLootBudget,
  getBudgetCurves,
  nearestPreset,
} from "./loot/budget.js";

/* baseline curves are exposed */
{
  const curves = getBudgetCurves();
  assert.ok(curves.tiers.t1 > 0);
  assert.ok(curves.tiers.t5 > curves.tiers.t4, "tiers ascend in budget");
  assert.equal(curves.scales.standard, 1, "standard scale is the baseline 1x");
  assert.equal(
    curves.generosity.balanced,
    1,
    "balanced generosity is the baseline 1x",
  );
}

/* slider ranges fully enclose every named preset */
{
  for (const [name, value] of Object.entries(SCALE_PRESETS)) {
    assert.ok(
      value >= SCALE_RANGE.min && value <= SCALE_RANGE.max,
      `scale preset "${name}" (${value}) inside slider range`,
    );
  }
  for (const [name, value] of Object.entries(GENEROSITY_PRESETS)) {
    assert.ok(
      value >= GENEROSITY_RANGE.min && value <= GENEROSITY_RANGE.max,
      `generosity preset "${name}" (${value}) inside slider range`,
    );
  }
}

/* default computation (named preset path) */
{
  const base = computeLootBudget({ tier: "t2" });
  const expected = 400; // t2 base × 1 scale × 1 generosity × (4/4 party)
  assert.equal(base, expected, "default t2 budget hits the canonical curve");
}

/* numeric multipliers override named presets */
{
  // 400 * 1.5 * 1 * 1 = 600
  const sliderScale = computeLootBudget({
    tier: "t2",
    scale: "trivial", // would be 0.4 if named path used
    scaleMultiplier: 1.5, // takes precedence
  });
  assert.equal(sliderScale, 600, "scaleMultiplier wins over scale preset");

  // 400 * 1 * 1.25 * 1 = 500
  const sliderGenerosity = computeLootBudget({
    tier: "t2",
    generosityMultiplier: 1.25,
  });
  assert.equal(sliderGenerosity, 500, "generosityMultiplier applied");
}

/* both axes can be slider-driven simultaneously */
{
  // 400 * 1.4 * 0.8 * (6/4) = 672
  const both = computeLootBudget({
    tier: "t2",
    scaleMultiplier: 1.4,
    generosityMultiplier: 0.8,
    partySize: 6,
  });
  assert.equal(both, Math.round(400 * 1.4 * 0.8 * (6 / 4)), "slider stacking");
}

/* legacy named inputs still work */
{
  const hoarded = computeLootBudget({ tier: "t2", scale: "hoard" });
  assert.equal(hoarded, 2400, "hoard multiplier of 6 still applies");
  const stingyBigParty = computeLootBudget({
    tier: "t2",
    generosity: "stingy",
    partySize: 8,
  });
  assert.equal(stingyBigParty, 480, "named generosity preset still applies");
}

/* override short-circuits the curve */
{
  const value = computeLootBudget({ tier: "t4", override: 1234 });
  assert.equal(value, 1234, "override returns verbatim regardless of tier");
}

/* clamp + zero defenses */
{
  assert.equal(computeLootBudget({ tier: "" }), 0, "unknown tier returns 0");
  assert.equal(
    computeLootBudget({ tier: "t1", partySize: 0 }),
    Math.round(50 * 0.25),
    "party size 1 → 1/4 factor (rounded)",
  );
  assert.equal(
    computeLootBudget({ tier: "t1", partySize: 999 }),
    Math.round(50 * 2.5),
    "party size capped at 10 → 10/4 factor",
  );
}

/* invalid multipliers fall back to neutral 1.0 */
{
  const garbage = computeLootBudget({
    tier: "t2",
    scaleMultiplier: "wat",
    generosityMultiplier: NaN,
  });
  assert.equal(garbage, 400, "garbage multipliers behave like 1.0");
}

/* non-numeric partySize falls back to the canonical 4 — never NaN, which would
 * silently disable budget enforcement downstream (rollLoot reads it as
 * unbounded). null/undefined keep defaulting to 4 via the nullish guard. */
{
  for (const bad of ["abc", NaN, {}]) {
    assert.equal(
      computeLootBudget({ tier: "t2", partySize: bad }),
      400,
      "non-numeric partySize → default 4 (400 gp), not NaN",
    );
  }
  assert.equal(computeLootBudget({ tier: "t2", partySize: null }), 400);
  assert.equal(computeLootBudget({ tier: "t2", partySize: undefined }), 400);
}

/* tier classification */
{
  assert.equal(classifyBudgetTier(0), "");
  assert.equal(classifyBudgetTier(45), "t1", "45 gp ≈ t1");
  assert.equal(classifyBudgetTier(380), "t2", "380 gp ≈ t2");
  assert.equal(classifyBudgetTier(3800), "t3");
  assert.equal(classifyBudgetTier(18000), "t4");
  assert.equal(classifyBudgetTier(110000), "t5");
}

/* nearestPreset snaps to canonical multiplier names within tolerance */
{
  assert.equal(
    nearestPreset(1.0, SCALE_PRESETS),
    "standard",
    "exact match returns the preset name",
  );
  assert.equal(
    nearestPreset(1.05, SCALE_PRESETS),
    "standard",
    "near-match still snaps inside tolerance",
  );
  assert.equal(
    nearestPreset(1.3, SCALE_PRESETS),
    "",
    "outside tolerance returns empty (no spurious snapping)",
  );
  assert.equal(
    nearestPreset(0.6, GENEROSITY_PRESETS),
    "stingy",
    "generosity preset detected",
  );
  assert.equal(nearestPreset(NaN, SCALE_PRESETS), "", "NaN returns empty");
}

process.stdout.write("budget validation passed\n");
