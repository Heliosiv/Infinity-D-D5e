/**
 * Rarity-balance presets and helpers for weighted loot rolls.
 *
 * The rarity filter answers "which rarities can appear"; these multipliers
 * answer "how often should each allowed rarity appear relative to the rest."
 */

import { formatMultiplier, prettyRarity } from "../ui-util.js";
import { RARITIES, normalizeRarity } from "./tag-vocabulary.js";

export const RARITY_BALANCE_CUSTOM_KEY = "custom";
export const RARITY_BALANCE_DEFAULT_KEY = "even";
export const RARITY_BALANCE_WEIGHT_RANGE = Object.freeze({
  min: 0,
  max: 10,
  step: 0.05,
});

const EVEN_WEIGHTS = freezeWeights({
  common: 1,
  uncommon: 1,
  rare: 1,
  "very-rare": 1,
  legendary: 1,
  artifact: 1,
});

export const RARITY_BALANCE_PRESETS = Object.freeze({
  even: Object.freeze({
    label: "Even",
    weights: EVEN_WEIGHTS,
  }),
  shop: Object.freeze({
    label: "Shop Stock",
    weights: freezeWeights({
      common: 3,
      uncommon: 1.75,
      rare: 0.75,
      "very-rare": 0.35,
      legendary: 0.12,
      artifact: 0.05,
    }),
  }),
  hoard: Object.freeze({
    label: "Treasure Hoard",
    weights: freezeWeights({
      common: 0.8,
      uncommon: 1.1,
      rare: 1.4,
      "very-rare": 0.9,
      legendary: 0.35,
      artifact: 0.1,
    }),
  }),
  highMagic: Object.freeze({
    label: "High Magic",
    weights: freezeWeights({
      common: 0.35,
      uncommon: 0.75,
      rare: 1.4,
      "very-rare": 1.7,
      legendary: 1.2,
      artifact: 0.35,
    }),
  }),
});

const RARITY_BALANCE_LABELS = Object.freeze({
  ...Object.fromEntries(
    Object.entries(RARITY_BALANCE_PRESETS).map(([key, preset]) => [
      key,
      preset.label,
    ]),
  ),
  [RARITY_BALANCE_CUSTOM_KEY]: "Custom",
});

export const RARITY_BALANCE_KEYS = Object.freeze([
  ...Object.keys(RARITY_BALANCE_PRESETS),
  RARITY_BALANCE_CUSTOM_KEY,
]);

export function normalizeRarityBalanceKey(value) {
  const raw = String(value ?? "")
    .trim()
    .toLowerCase();
  if (raw === RARITY_BALANCE_CUSTOM_KEY) return RARITY_BALANCE_CUSTOM_KEY;
  if (raw === "highmagic" || raw === "high-magic" || raw === "high_magic")
    return "highMagic";
  if (RARITY_BALANCE_PRESETS[raw]) return raw;
  return RARITY_BALANCE_DEFAULT_KEY;
}

export function getRarityBalancePresetWeights(key) {
  const normalized = normalizeRarityBalanceKey(key);
  const preset =
    normalized === RARITY_BALANCE_CUSTOM_KEY
      ? RARITY_BALANCE_PRESETS[RARITY_BALANCE_DEFAULT_KEY]
      : RARITY_BALANCE_PRESETS[normalized];
  return { ...preset.weights };
}

export function resolveRarityWeights(balanceKey, rawWeights) {
  const normalized = normalizeRarityBalanceKey(balanceKey);
  if (normalized !== RARITY_BALANCE_CUSTOM_KEY) {
    return getRarityBalancePresetWeights(normalized);
  }
  return normalizeRarityWeights(rawWeights, EVEN_WEIGHTS);
}

export function normalizeRarityWeights(rawWeights, fallback = EVEN_WEIGHTS) {
  const source = normalizeWeightSource(rawWeights);
  const fallbackSource = normalizeWeightSource(fallback);
  const out = {};
  for (const rarity of RARITIES) {
    out[rarity] = clampRarityWeight(
      source[rarity],
      clampRarityWeight(fallbackSource[rarity], 1),
    );
  }
  return out;
}

export function rarityWeightForRarity(rarity, weights) {
  const normalized = normalizeRarity(rarity);
  if (!normalized) return 1;
  const value = Number(weights?.[normalized]);
  return Number.isFinite(value) && value >= 0 ? value : 1;
}

export function rarityBalanceOptions(selectedKey) {
  const selected = normalizeRarityBalanceKey(selectedKey);
  return RARITY_BALANCE_KEYS.map((key) => ({
    value: key,
    label: RARITY_BALANCE_LABELS[key] ?? key,
    selected: key === selected,
  }));
}

export function rarityWeightRows(weights) {
  const normalized = normalizeRarityWeights(weights);
  return RARITIES.map((rarity) => ({
    rarity,
    label: prettyRarity(rarity),
    weight: formatMultiplier(normalized[rarity]),
    min: RARITY_BALANCE_WEIGHT_RANGE.min,
    max: RARITY_BALANCE_WEIGHT_RANGE.max,
    step: RARITY_BALANCE_WEIGHT_RANGE.step,
  }));
}

export function clampRarityWeight(raw, fallback = 1) {
  const value = Number(raw);
  if (!Number.isFinite(value)) return fallback;
  return Math.max(
    RARITY_BALANCE_WEIGHT_RANGE.min,
    Math.min(RARITY_BALANCE_WEIGHT_RANGE.max, value),
  );
}

function normalizeWeightSource(rawWeights) {
  if (!rawWeights || typeof rawWeights !== "object") return {};
  const out = {};
  for (const [rawKey, rawValue] of Object.entries(rawWeights)) {
    const key = normalizeRarity(rawKey);
    if (key) out[key] = rawValue;
  }
  return out;
}

function freezeWeights(weights) {
  return Object.freeze(normalizeRarityWeights(weights, {}));
}
