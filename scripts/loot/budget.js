/**
 * Infinity D&D5e — Loot Budget
 *
 * Translates the UI controls (encounter scale, party APL, generosity)
 * into a numeric gp budget the roller can spend.
 *
 * Pure function — no Foundry globals, no I/O. Drop-in unit testable.
 *
 * The numbers below are anchored to DMG 2014 "Treasure by CR" tables
 * but flattened into a single scale curve so v0.1 doesn't need to
 * track encounter difficulty separately. v0.2 may swap to a richer
 * curve once we see how it plays.
 */

/** Default budget anchors keyed by tier. gp per encounter. */
const TIER_BASE_BUDGET = Object.freeze({
  t1: 50,
  t2: 400,
  t3: 4000,
  t4: 20000,
  t5: 100000,
});

/** Encounter scale multipliers. */
const SCALE_MULTIPLIER = Object.freeze({
  trivial: 0.4,
  standard: 1.0,
  hard: 1.5,
  deadly: 2.2,
  hoard: 6.0,
});

/** Generosity multipliers — GM-tuned dial for stinginess vs. plenty. */
const GENEROSITY_MULTIPLIER = Object.freeze({
  stingy: 0.6,
  balanced: 1.0,
  generous: 1.6,
});

/**
 * Compute the gp budget for a loot roll.
 *
 * @param {object} input
 * @param {string} input.tier        - one of "t1".."t5"
 * @param {string} [input.scale]     - "trivial"|"standard"|"hard"|"deadly"|"hoard"; default "standard"
 * @param {string} [input.generosity]- "stingy"|"balanced"|"generous"; default "balanced"
 * @param {number} [input.partySize] - 1–10, default 4. Multiplies linearly off 4 (4 players = 1.0x).
 * @param {number} [input.override]  - if > 0, returns this verbatim and skips the curve.
 * @returns {number} gp budget, rounded to the nearest integer.
 */
export function computeLootBudget(input = {}) {
  const override = Number(input.override);
  if (Number.isFinite(override) && override > 0) {
    return Math.round(override);
  }

  const base =
    TIER_BASE_BUDGET[
      String(input.tier ?? "")
        .trim()
        .toLowerCase()
    ] ?? 0;
  if (base <= 0) return 0;

  const scale =
    SCALE_MULTIPLIER[
      String(input.scale ?? "standard")
        .trim()
        .toLowerCase()
    ] ?? 1;
  const generosity =
    GENEROSITY_MULTIPLIER[
      String(input.generosity ?? "balanced")
        .trim()
        .toLowerCase()
    ] ?? 1;
  const partySize = Math.max(
    1,
    Math.min(10, Math.floor(Number(input.partySize ?? 4))),
  );
  const partyFactor = partySize / 4; // 4 PCs = canonical baseline

  return Math.round(base * scale * generosity * partyFactor);
}

/**
 * Reverse the budget into "what tier does this gp number feel like?"
 * Useful for UI hints ("This is ~T3 loot").
 *
 * @param {number} gp
 * @returns {string} closest tier id, or "" if gp <= 0
 */
export function classifyBudgetTier(gp) {
  const value = Number(gp);
  if (!Number.isFinite(value) || value <= 0) return "";
  let best = "";
  let bestDistance = Infinity;
  for (const [tier, base] of Object.entries(TIER_BASE_BUDGET)) {
    const distance = Math.abs(Math.log(value / base));
    if (distance < bestDistance) {
      best = tier;
      bestDistance = distance;
    }
  }
  return best;
}

/** Public read-only view of the base curves — useful for UI labels. */
export function getBudgetCurves() {
  return {
    tiers: { ...TIER_BASE_BUDGET },
    scales: { ...SCALE_MULTIPLIER },
    generosity: { ...GENEROSITY_MULTIPLIER },
  };
}
