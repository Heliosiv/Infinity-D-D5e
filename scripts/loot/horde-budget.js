/**
 * Infinity D&D5e — Horde Budget
 *
 * Math for the Horde Loot window. Horde loot differs from a single
 * encounter in two key ways:
 *
 *  1. Budget scales with the mob count, not party APL — a defeated
 *     pile of 30 goblins should drop more raw coin than a single hard
 *     fight, even though the items themselves are lower-rarity.
 *  2. Some of the budget is paid out as a *coin pile* before items
 *     are rolled. The Pile Bias slider lets the GM dial how much of
 *     the loot is raw currency vs. tagged items.
 *
 * Pure functions — no Foundry imports, deterministic, fully unit
 * testable.
 */

/**
 * gp per defeated creature, by threat tier. Tracks the DMG 2014
 * "Treasure: Hoard by CR" tables flattened so the GM doesn't need
 * to think about CR — just pick the tier band the mob fits.
 */
const HORDE_PER_CREATURE = Object.freeze({
  t1: 8,
  t2: 50,
  t3: 250,
  t4: 1200,
  t5: 6000,
});

/** Slider bounds for the mob-size dial. */
export const MOB_SIZE_RANGE = Object.freeze({ min: 3, max: 60, step: 1 });

/** Slider bounds for the pile-bias dial. */
export const PILE_BIAS_RANGE = Object.freeze({
  min: -1,
  max: 1,
  step: 0.05,
});

/** Named snap targets for the Pile Bias slider. */
export const PILE_BIAS_PRESETS = Object.freeze({
  coinHeavy: -0.7,
  mixed: 0,
  itemHeavy: 0.7,
});

/* ------------------------------------------------------------------ *
 * Budget primitives
 * ------------------------------------------------------------------ */

/**
 * Compute the total gp budget for a horde.
 *
 * @param {object} input
 * @param {string} input.tier      - "t1".."t5"
 * @param {number} input.mobSize   - 3..60 (clamped)
 * @param {number} [input.generosityMultiplier] - optional extra multiplier (default 1)
 * @returns {number} integer gp, rounded
 */
export function computeHordeBudget(input = {}) {
  const tier = String(input.tier ?? "")
    .trim()
    .toLowerCase();
  const perCreature = HORDE_PER_CREATURE[tier] ?? 0;
  if (perCreature <= 0) return 0;

  const mob = clampInt(
    input.mobSize,
    MOB_SIZE_RANGE.min,
    MOB_SIZE_RANGE.max,
    MOB_SIZE_RANGE.min,
  );
  const generosity = clampFloat(input.generosityMultiplier, 0, 5, 1);

  return Math.round(perCreature * mob * generosity);
}

/**
 * Split a total horde budget into a coin pile + remaining item budget.
 * Bias values:
 *   -1.0 → 70% coins (the curve clamps at 0.85 to leave headroom)
 *    0.0 → 40% coins
 *   +1.0 → 10% coins (clamps at 0.05 minimum)
 *
 * @returns {{ coinPileGp: number, itemBudget: number }}
 */
export function splitCoinPile(totalBudget, pileBias) {
  const total = Math.max(0, Math.round(Number(totalBudget) || 0));
  if (total <= 0) return { coinPileGp: 0, itemBudget: 0 };
  const bias = clampFloat(pileBias, -1, 1, 0);
  const portion = Math.max(0.05, Math.min(0.85, 0.4 - 0.3 * bias));
  const coinPileGp = Math.round(total * portion);
  return { coinPileGp, itemBudget: total - coinPileGp };
}

/**
 * Convert a gp value into a stylized D&D coin breakdown. Not exact
 * change — the ratios deliberately spread the pile across all four
 * denominations so it feels like a real hoard ("a pile of mixed
 * coins") rather than just a stack of gold.
 *
 * Total value preserved within ±1 gp (rounding noise).
 *
 * @returns {{ pp: number, gp: number, sp: number, cp: number }}
 */
export function coinDenominationBreakdown(gpValue) {
  const total = Math.max(0, Math.round(Number(gpValue) || 0));
  if (total <= 0) return { pp: 0, gp: 0, sp: 0, cp: 0 };
  // Ratios: 10% as platinum (×10gp), 50% as gold, 30% as silver
  // (÷10gp), 10% as copper (÷100gp). Floor each so the visible total
  // never exceeds the input.
  return {
    pp: Math.floor((total * 0.1) / 10),
    gp: Math.floor(total * 0.5),
    sp: Math.floor(total * 0.3 * 10),
    cp: Math.floor(total * 0.1 * 100),
  };
}

/** Render a coin breakdown to a single-line label. */
export function formatCoinBreakdown(breakdown) {
  const parts = [];
  if (breakdown?.pp > 0) parts.push(`${breakdown.pp.toLocaleString()} pp`);
  if (breakdown?.gp > 0) parts.push(`${breakdown.gp.toLocaleString()} gp`);
  if (breakdown?.sp > 0) parts.push(`${breakdown.sp.toLocaleString()} sp`);
  if (breakdown?.cp > 0) parts.push(`${breakdown.cp.toLocaleString()} cp`);
  return parts.join(" · ");
}

/** Read-only view of the per-creature gp curve. Useful for UI hints. */
export function getHordeCurve() {
  return { ...HORDE_PER_CREATURE };
}

/* ------------------------------------------------------------------ *
 * Local helpers
 * ------------------------------------------------------------------ */

function clampInt(raw, min, max, fallback) {
  const value = Number(raw);
  if (!Number.isFinite(value)) return fallback;
  return Math.max(min, Math.min(max, Math.floor(value)));
}

function clampFloat(raw, min, max, fallback) {
  const value = Number(raw);
  if (!Number.isFinite(value)) return fallback;
  return Math.max(min, Math.min(max, value));
}
