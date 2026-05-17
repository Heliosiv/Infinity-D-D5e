import assert from "node:assert/strict";

import {
  classifyBudgetTier,
  computeLootBudget,
  getBudgetCurves,
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

/* default computation */
{
  const base = computeLootBudget({ tier: "t2" });
  const expected = 400; // t2 base × 1 scale × 1 generosity × (4/4 party)
  assert.equal(base, expected, "default t2 budget hits the canonical curve");
}

/* scaled inputs */
{
  const hardly = computeLootBudget({ tier: "t2", scale: "hoard" });
  assert.equal(hardly, 2400, "hoard multiplier of 6 applies");
  const stingyBigParty = computeLootBudget({
    tier: "t2",
    generosity: "stingy",
    partySize: 8,
  });
  // 400 × 1 × 0.6 × (8/4) = 480
  assert.equal(stingyBigParty, 480);
}

/* override short-circuits the curve */
{
  const value = computeLootBudget({ tier: "t4", override: 1234 });
  assert.equal(value, 1234, "override returns verbatim regardless of tier");
}

/* clamp + zero defenses */
{
  assert.equal(computeLootBudget({ tier: "" }), 0, "unknown tier returns 0");
  // 50 × 0.25 = 12.5 → Math.round → 13. Below-1 party sizes clamp UP to 1.
  assert.equal(
    computeLootBudget({ tier: "t1", partySize: 0 }),
    Math.round(50 * 0.25),
    "party size 1 → 1/4 factor (rounded)",
  );
  // 50 × 2.5 = 125. Above-10 sizes clamp DOWN to 10.
  assert.equal(
    computeLootBudget({ tier: "t1", partySize: 999 }),
    Math.round(50 * 2.5),
    "party size capped at 10 → 10/4 factor",
  );
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

process.stdout.write("budget validation passed\n");
