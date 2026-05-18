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
 *
 * Both `scale` and `generosity` accept either a named preset (legacy
 * dropdowns) or a numeric multiplier (slider in the redesigned form).
 * Numeric multipliers take precedence — the named preset is only
 * consulted when its sibling `*Multiplier` value is absent.
 */

/** Default budget anchors keyed by tier. gp per encounter. */
const TIER_BASE_BUDGET = Object.freeze({
  t1: 50,
  t2: 400,
  t3: 4000,
  t4: 20000,
  t5: 100000,
});

/** Named scale presets — also used as slider snap targets. */
export const SCALE_PRESETS = Object.freeze({
  trivial: 0.4,
  standard: 1.0,
  hard: 1.5,
  deadly: 2.2,
  hoard: 6.0,
});

/** Named generosity presets — also used as slider snap targets. */
export const GENEROSITY_PRESETS = Object.freeze({
  stingy: 0.6,
  balanced: 1.0,
  generous: 1.6,
});

/** Slider bounds for the encounter scale dial. */
export const SCALE_RANGE = Object.freeze({ min: 0.4, max: 6.0, step: 0.05 });

/** Slider bounds for the generosity dial. */
export const GENEROSITY_RANGE = Object.freeze({
  min: 0.4,
  max: 2.0,
  step: 0.05,
});

/**
 * Compute the gp budget for a loot roll.
 *
 * @param {object} input
 * @param {string} input.tier              - one of "t1".."t5"
 * @param {number} [input.scaleMultiplier] - numeric encounter-scale multiplier (slider). Takes precedence.
 * @param {string} [input.scale]           - named preset ("trivial".."hoard"). Used when scaleMultiplier missing.
 * @param {number} [input.generosityMultiplier] - numeric generosity multiplier (slider). Takes precedence.
 * @param {string} [input.generosity]      - named preset ("stingy".."generous"). Used when generosityMultiplier missing.
 * @param {number} [input.partySize]       - 1–10, default 4. Linear factor off 4 (4 PCs = 1.0×).
 * @param {number} [input.override]        - if > 0, returns this verbatim and skips the curve.
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

  const scale = resolveMultiplier({
    numeric: input.scaleMultiplier,
    preset: input.scale,
    presets: SCALE_PRESETS,
    fallback: 1,
  });
  const generosity = resolveMultiplier({
    numeric: input.generosityMultiplier,
    preset: input.generosity,
    presets: GENEROSITY_PRESETS,
    fallback: 1,
  });

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

/**
 * Resolve a continuous slider value to its closest named preset.
 * Used by the UI to display "Hard" next to ×1.5, "Generous" next to
 * ×1.6, etc. Returns "" if no preset is within `tolerance`.
 *
 * @param {number} value
 * @param {Record<string, number>} presets
 * @param {number} [tolerance] - default 0.06 (slightly above the slider step)
 * @returns {string}
 */
export function nearestPreset(value, presets, tolerance = 0.06) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || !presets) return "";
  let best = "";
  let bestDelta = Infinity;
  for (const [name, target] of Object.entries(presets)) {
    const delta = Math.abs(numeric - target);
    if (delta < bestDelta) {
      best = name;
      bestDelta = delta;
    }
  }
  return bestDelta <= tolerance ? best : "";
}

/** Public read-only view of the base curves — useful for UI labels. */
export function getBudgetCurves() {
  return {
    tiers: { ...TIER_BASE_BUDGET },
    scales: { ...SCALE_PRESETS },
    generosity: { ...GENEROSITY_PRESETS },
  };
}

/* ------------------------------------------------------------------ *
 * Helpers
 * ------------------------------------------------------------------ */

function resolveMultiplier({ numeric, preset, presets, fallback }) {
  const direct = Number(numeric);
  if (Number.isFinite(direct) && direct >= 0) return direct;
  const named =
    presets[
      String(preset ?? "")
        .trim()
        .toLowerCase()
    ];
  return Number.isFinite(named) ? named : fallback;
}
