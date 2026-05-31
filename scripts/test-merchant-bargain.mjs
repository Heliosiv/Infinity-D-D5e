import assert from "node:assert/strict";

import {
  computeBargainOutcome,
  loadBargainTiers,
} from "./merchant/bargain.js";

/* ------------------------------------------------------------------ *
 * computeBargainOutcome — default tiers
 *
 * Default schedule:
 *   crit-success → margin ≥ 10 → −20%
 *   success      → margin ≥ 0  → −10%
 *   failure      → margin ≥ -9 → +10%
 *   crit-failure → margin < -9 → +20%
 * ------------------------------------------------------------------ */
{
  const dc = 15;
  // Roll 25 → margin 10 → crit-success
  const crit = computeBargainOutcome(25, dc);
  assert.equal(crit.tier?.id, "crit-success");
  assert.equal(crit.deltaPct, -20);
  assert.equal(crit.margin, 10);
}
{
  // Roll exactly 15 → margin 0 → success
  const success = computeBargainOutcome(15, 15);
  assert.equal(success.tier?.id, "success");
  assert.equal(success.deltaPct, -10);
}
{
  // Roll 14 → margin -1 → failure
  const failure = computeBargainOutcome(14, 15);
  assert.equal(failure.tier?.id, "failure");
  assert.equal(failure.deltaPct, 10);
}
{
  // Roll 5 → margin -10 → crit-failure
  const critFail = computeBargainOutcome(5, 15);
  assert.equal(critFail.tier?.id, "crit-failure");
  assert.equal(critFail.deltaPct, 20);
}

/* ------------------------------------------------------------------ *
 * Custom tiers — narrow bands
 * ------------------------------------------------------------------ */
{
  const tiers = [
    { id: "amazing", minMargin: 20, deltaPct: -50 },
    { id: "ok", minMargin: 0, deltaPct: -5 },
    { id: "bad", minMargin: -Infinity, deltaPct: 25 },
  ];
  assert.equal(computeBargainOutcome(35, 15, tiers).tier.id, "amazing");
  assert.equal(computeBargainOutcome(15, 15, tiers).tier.id, "ok");
  assert.equal(computeBargainOutcome(1, 15, tiers).tier.id, "bad");
  assert.equal(computeBargainOutcome(1, 15, tiers).deltaPct, 25);
}

/* ------------------------------------------------------------------ *
 * Malformed input — falls back to defaults gracefully
 * ------------------------------------------------------------------ */
{
  const outcome = computeBargainOutcome(15, 15, "not an array");
  assert.equal(outcome.tier?.id, "success");
}

/* ------------------------------------------------------------------ *
 * loadBargainTiers — returns defaults when game.settings is absent
 * ------------------------------------------------------------------ */
{
  const originalGame = globalThis.game;
  try {
    delete globalThis.game;
    const tiers = loadBargainTiers();
    assert.ok(Array.isArray(tiers));
    assert.ok(tiers.length >= 4);
    assert.equal(
      tiers.find((t) => t.id === "crit-success")?.deltaPct,
      -20,
    );
  } finally {
    if (originalGame === undefined) delete globalThis.game;
    else globalThis.game = originalGame;
  }
}

/* ------------------------------------------------------------------ *
 * loadBargainTiers — honors a sane setting
 * ------------------------------------------------------------------ */
{
  const originalGame = globalThis.game;
  try {
    globalThis.game = {
      settings: {
        get(moduleId, key) {
          if (key === "merchantBargainTiers") {
            return [
              { id: "score", minMargin: 5, deltaPct: -15 },
              { id: "miss", minMargin: -Infinity, deltaPct: 5 },
            ];
          }
          return undefined;
        },
      },
    };
    const tiers = loadBargainTiers();
    assert.equal(tiers.length, 2);
    assert.equal(tiers[0].id, "score");
  } finally {
    if (originalGame === undefined) delete globalThis.game;
    else globalThis.game = originalGame;
  }
}

process.stdout.write("merchant-bargain validation passed\n");
