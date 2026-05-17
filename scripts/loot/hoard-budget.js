/**
 * Infinity D&D5e — Hoard Budget
 *
 * Math for the Hoard Loot window. A "hoard" is a single treasure
 * cache (a chest, a dragon's pile, a defeated boss's stash), so its
 * budget is derived from the *tier* of the threat plus a *scale*
 * preset, NOT from a creature count.
 *
 * Pure functions — no Foundry imports, deterministic, fully unit
 * testable.
 */

/**
 * Canonical per-tier hoard value, loosely tracking the DMG 2014
 * "Treasure: Hoard" tables at the mid-CR row of each band.
 *
 * t1 (CR 0–4)   ≈ 500 gp
 * t2 (CR 5–10)  ≈ 5,000 gp
 * t3 (CR 11–16) ≈ 50,000 gp
 * t4 (CR 17–20) ≈ 200,000 gp
 * t5 (epic)     ≈ 500,000 gp
 */
const HOARD_BASE_BUDGET = Object.freeze({
  t1: 500,
  t2: 5000,
  t3: 50000,
  t4: 200000,
  t5: 500000,
});

/**
 * Named scale presets. Multiply the tier base to get the hoard's
 * total gp budget. Small is a minor cache; Massive is a dragon-tier
 * hoard. Standard is the canonical DMG value.
 */
export const HOARD_SCALE_PRESETS = Object.freeze({
  small: 0.5,
  standard: 1.0,
  large: 2.0,
  massive: 4.0,
});

/** Default item-count ceiling per scale. UX hint, not a hard cap. */
export const HOARD_DEFAULT_ITEM_CEILING = Object.freeze({
  small: 4,
  standard: 8,
  large: 12,
  massive: 16,
});

/** Slider bounds for the Pile Bias dial (unchanged). */
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
 * Compute the total gp budget for a hoard.
 *
 * @param {object} input
 * @param {string} input.tier              - "t1".."t5"
 * @param {string|number} [input.scale]    - named preset
 *                                           ("small"|"standard"|"large"|"massive")
 *                                           OR a raw numeric multiplier. Default "standard".
 * @returns {number} integer gp, rounded
 */
export function computeHoardBudget(input = {}) {
  const tier = String(input.tier ?? "")
    .trim()
    .toLowerCase();
  const base = HOARD_BASE_BUDGET[tier] ?? 0;
  if (base <= 0) return 0;

  const scale = resolveScaleMultiplier(input.scale);
  if (scale <= 0) return 0;

  return Math.round(base * scale);
}

/** Coin pile + item budget split — unchanged from the previous design. */
export function splitCoinPile(totalBudget, pileBias) {
  const total = Math.max(0, Math.round(Number(totalBudget) || 0));
  if (total <= 0) return { coinPileGp: 0, itemBudget: 0 };
  const bias = clampFloat(pileBias, -1, 1, 0);
  const portion = Math.max(0.05, Math.min(0.85, 0.4 - 0.3 * bias));
  const coinPileGp = Math.round(total * portion);
  return { coinPileGp, itemBudget: total - coinPileGp };
}

/**
 * Convert a gp value into a stylized D&D coin breakdown.
 * Ratios: 10% as pp (÷10), 50% as gp, 30% as sp (×10), 10% as cp (×100).
 * Total value preserved within ±1 gp (rounding noise).
 */
export function coinDenominationBreakdown(gpValue) {
  const total = Math.max(0, Math.round(Number(gpValue) || 0));
  if (total <= 0) return { pp: 0, gp: 0, sp: 0, cp: 0 };
  return {
    pp: Math.floor((total * 0.1) / 10),
    gp: Math.floor(total * 0.5),
    sp: Math.floor(total * 0.3 * 10),
    cp: Math.floor(total * 0.1 * 100),
  };
}

/** Render a coin breakdown to a single-line label, skipping zero columns. */
export function formatCoinBreakdown(breakdown) {
  const parts = [];
  if (breakdown?.pp > 0) parts.push(`${breakdown.pp.toLocaleString()} pp`);
  if (breakdown?.gp > 0) parts.push(`${breakdown.gp.toLocaleString()} gp`);
  if (breakdown?.sp > 0) parts.push(`${breakdown.sp.toLocaleString()} sp`);
  if (breakdown?.cp > 0) parts.push(`${breakdown.cp.toLocaleString()} cp`);
  return parts.join(" · ");
}

/** Read-only view of the per-tier hoard base values. Useful for UI hints. */
export function getHoardCurve() {
  return { ...HOARD_BASE_BUDGET };
}

/* ------------------------------------------------------------------ *
 * Local helpers
 * ------------------------------------------------------------------ */

function resolveScaleMultiplier(raw) {
  // Number-typed input is honored explicitly: negatives clamp to 0,
  // NaN/Infinity fall back to the standard preset, finite positives
  // are used as-is. String inputs route through the named-preset map.
  if (typeof raw === "number") {
    if (!Number.isFinite(raw)) return HOARD_SCALE_PRESETS.standard;
    return Math.max(0, raw);
  }
  const key = String(raw ?? "standard")
    .trim()
    .toLowerCase();
  return HOARD_SCALE_PRESETS[key] ?? HOARD_SCALE_PRESETS.standard;
}

function clampFloat(raw, min, max, fallback) {
  const value = Number(raw);
  if (!Number.isFinite(value)) return fallback;
  return Math.max(min, Math.min(max, value));
}
