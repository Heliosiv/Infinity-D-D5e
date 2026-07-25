/**
 * Normalize persisted or imported loot-tool forms before UI code reads them.
 *
 * Stored forms are untrusted compatibility boundaries: they may come from an
 * older module version, a hand-edited preset export, or a damaged world
 * setting. These helpers return only current known fields with bounded values.
 */

import { GENEROSITY_RANGE, SCALE_RANGE } from "./budget.js";
import {
  HOARD_DEFAULT_ITEM_CEILING,
  PILE_BIAS_RANGE,
  getDefaultRarities,
} from "./hoard-budget.js";
import {
  RARITY_BALANCE_CUSTOM_KEY,
  RARITY_BALANCE_DEFAULT_KEY,
  normalizeRarityBalanceKey,
  resolveRarityWeights,
} from "./rarity-balance.js";
import { MAGIC_BIAS_RANGE } from "./roller.js";
import { LOOT_TYPES, RARITIES, TIERS } from "./tag-vocabulary.js";
import { clampFloat, clampInt } from "../ui-util.js";

export const ENCOUNTER_COUNT_RANGE = Object.freeze({
  min: 1,
  max: 20,
  step: 1,
});
export const ENCOUNTER_PARTY_RANGE = Object.freeze({
  min: 1,
  max: 10,
  step: 1,
});
const HOARD_MAX_ITEMS_RANGE = Object.freeze({ min: 0, max: 30 });
export const HOARD_SCALE_ORDER = Object.freeze([
  "small",
  "standard",
  "large",
  "massive",
]);
export const PER_CREATURE_ITEM_RANGE = Object.freeze({
  min: 1,
  max: 5,
  step: 1,
});
export const PER_CREATURE_ROSTER_LIMIT = 30;
export const CREATURE_NAME_LIMIT = 40;

const MAX_GP_INPUT = Number.MAX_SAFE_INTEGER;

export function normalizeEncounterLootForm(rawForm, defaults = {}) {
  const raw = asRecord(rawForm);
  const base = asRecord(defaults);
  return {
    tier: normalizeEnum(raw.tier, TIERS, base.tier, "t2"),
    scaleMultiplier: clampFloat(
      raw.scaleMultiplier,
      SCALE_RANGE.min,
      SCALE_RANGE.max,
      clampFloat(base.scaleMultiplier, SCALE_RANGE.min, SCALE_RANGE.max, 1),
    ),
    generosityMultiplier: clampFloat(
      raw.generosityMultiplier,
      GENEROSITY_RANGE.min,
      GENEROSITY_RANGE.max,
      clampFloat(
        base.generosityMultiplier,
        GENEROSITY_RANGE.min,
        GENEROSITY_RANGE.max,
        1,
      ),
    ),
    partySize: clampInt(
      raw.partySize,
      ENCOUNTER_PARTY_RANGE.min,
      ENCOUNTER_PARTY_RANGE.max,
      clampInt(
        base.partySize,
        ENCOUNTER_PARTY_RANGE.min,
        ENCOUNTER_PARTY_RANGE.max,
        4,
      ),
    ),
    itemLimitEnabled: normalizeBoolean(
      raw.itemLimitEnabled,
      base.itemLimitEnabled === true,
    ),
    count: clampInt(
      raw.count,
      ENCOUNTER_COUNT_RANGE.min,
      ENCOUNTER_COUNT_RANGE.max,
      clampInt(
        base.count,
        ENCOUNTER_COUNT_RANGE.min,
        ENCOUNTER_COUNT_RANGE.max,
        6,
      ),
    ),
    budgetOverride: clampInt(
      raw.budgetOverride,
      0,
      MAX_GP_INPUT,
      clampInt(base.budgetOverride, 0, MAX_GP_INPUT, 0),
    ),
    artVariants: normalizeBoolean(raw.artVariants, base.artVariants !== false),
    magicBias: clampFloat(
      raw.magicBias,
      MAGIC_BIAS_RANGE.min,
      MAGIC_BIAS_RANGE.max,
      clampFloat(base.magicBias, MAGIC_BIAS_RANGE.min, MAGIC_BIAS_RANGE.max, 0),
    ),
    rarities: normalizeChoiceList(raw.rarities, RARITIES, base.rarities),
    lootTypes: normalizeChoiceList(raw.lootTypes, LOOT_TYPES, base.lootTypes),
    minItemGp: normalizeGp(raw.minItemGp, base.minItemGp),
    maxItemGp: normalizeGp(raw.maxItemGp, base.maxItemGp),
  };
}

export function normalizeHoardLootForm(rawForm, defaults = {}) {
  const raw = asRecord(rawForm);
  const base = asRecord(defaults);
  const tier = normalizeEnum(raw.tier, TIERS, base.tier, "t2");
  const scale = normalizeEnum(
    raw.scale,
    HOARD_SCALE_ORDER,
    base.scale,
    "standard",
  );
  const rarityBalance = normalizeRarityBalanceKey(
    raw.rarityBalance ??
      (isRecord(raw.rarityWeights)
        ? RARITY_BALANCE_CUSTOM_KEY
        : (base.rarityBalance ?? RARITY_BALANCE_DEFAULT_KEY)),
  );
  const defaultRarities = getDefaultRarities(tier, scale);
  const defaultMaxItems =
    HOARD_DEFAULT_ITEM_CEILING[scale] ??
    finiteFallback(base.maxItems, HOARD_DEFAULT_ITEM_CEILING.standard ?? 8);

  return {
    tier,
    scale,
    pileBias: clampFloat(
      raw.pileBias,
      PILE_BIAS_RANGE.min,
      PILE_BIAS_RANGE.max,
      clampFloat(base.pileBias, PILE_BIAS_RANGE.min, PILE_BIAS_RANGE.max, 0),
    ),
    magicBias: clampFloat(
      raw.magicBias,
      MAGIC_BIAS_RANGE.min,
      MAGIC_BIAS_RANGE.max,
      clampFloat(base.magicBias, MAGIC_BIAS_RANGE.min, MAGIC_BIAS_RANGE.max, 0),
    ),
    maxItems: clampInt(
      raw.maxItems,
      HOARD_MAX_ITEMS_RANGE.min,
      HOARD_MAX_ITEMS_RANGE.max,
      defaultMaxItems,
    ),
    artVariants: normalizeBoolean(raw.artVariants, base.artVariants !== false),
    rarityBalance,
    rarityWeights: resolveRarityWeights(rarityBalance, raw.rarityWeights),
    rarities: normalizeChoiceList(raw.rarities, RARITIES, defaultRarities),
    lootTypes: normalizeChoiceList(raw.lootTypes, LOOT_TYPES, base.lootTypes),
    minItemGp: normalizeGp(raw.minItemGp, base.minItemGp),
    maxItemGp: normalizeGp(raw.maxItemGp, base.maxItemGp),
  };
}

export function normalizePerCreatureLootForm(rawForm, defaults = {}) {
  const raw = asRecord(rawForm);
  const base = asRecord(defaults);
  const defaultTier = normalizeEnum(
    raw.defaultTier,
    TIERS,
    base.defaultTier,
    "t2",
  );
  return {
    defaultTier,
    itemsPerCreature: clampInt(
      raw.itemsPerCreature,
      PER_CREATURE_ITEM_RANGE.min,
      PER_CREATURE_ITEM_RANGE.max,
      clampInt(
        base.itemsPerCreature,
        PER_CREATURE_ITEM_RANGE.min,
        PER_CREATURE_ITEM_RANGE.max,
        2,
      ),
    ),
    magicBias: clampFloat(
      raw.magicBias,
      MAGIC_BIAS_RANGE.min,
      MAGIC_BIAS_RANGE.max,
      clampFloat(base.magicBias, MAGIC_BIAS_RANGE.min, MAGIC_BIAS_RANGE.max, 0),
    ),
    rarities: normalizeChoiceList(raw.rarities, RARITIES, base.rarities),
    lootTypes: normalizeChoiceList(raw.lootTypes, LOOT_TYPES, base.lootTypes),
    minItemGp: normalizeGp(raw.minItemGp, base.minItemGp),
    maxItemGp: normalizeGp(raw.maxItemGp, base.maxItemGp),
    roster: normalizeCreatureRoster(raw.roster, {
      fallback: base.roster,
      defaultTier,
    }),
  };
}

export function normalizeChoiceList(raw, allowedValues, fallback = []) {
  const allowed = new Set(
    (Array.isArray(allowedValues) ? allowedValues : []).map((value) =>
      String(value).toLowerCase(),
    ),
  );
  if (!Array.isArray(raw)) {
    return normalizeChoiceFallback(fallback, allowed);
  }

  const normalized = [
    ...new Set(
      raw
        .filter((value) => typeof value === "string")
        .map((value) => value.trim().toLowerCase())
        .filter((value) => allowed.has(value)),
    ),
  ];
  if (raw.length > 0 && normalized.length === 0) {
    return normalizeChoiceFallback(fallback, allowed);
  }
  return normalized;
}

export function normalizeCreatureRoster(
  rawRoster,
  { fallback = [], defaultTier = "t2" } = {},
) {
  const source = Array.isArray(rawRoster)
    ? rawRoster
    : Array.isArray(fallback)
      ? fallback
      : [];
  const seenIds = new Set();
  const out = [];

  for (const [index, entry] of source
    .slice(0, PER_CREATURE_ROSTER_LIMIT)
    .entries()) {
    if (!isRecord(entry)) continue;
    const name =
      typeof entry.name === "string"
        ? entry.name.trim().slice(0, CREATURE_NAME_LIMIT)
        : "";
    const tier = normalizeEnum(entry.tier, TIERS, defaultTier);
    let id = typeof entry.id === "string" ? entry.id.trim().slice(0, 128) : "";
    if (!id || seenIds.has(id)) id = mintCreatureId(seenIds);
    seenIds.add(id);
    out.push({
      id,
      name: name || `Creature ${index + 1}`,
      tier,
    });
  }
  return out;
}

function normalizeChoiceFallback(fallback, allowed) {
  if (!Array.isArray(fallback)) return [];
  return [
    ...new Set(
      fallback
        .filter((value) => typeof value === "string")
        .map((value) => value.trim().toLowerCase())
        .filter((value) => allowed.has(value)),
    ),
  ];
}

function normalizeEnum(raw, allowedValues, fallback, safeDefault) {
  const allowed = new Set(allowedValues);
  const value =
    typeof raw === "string" ? raw.trim().toLowerCase() : String(raw ?? "");
  const fallbackValue =
    typeof fallback === "string"
      ? fallback.trim().toLowerCase()
      : String(fallback ?? "");
  const defaultValue =
    typeof safeDefault === "string"
      ? safeDefault.trim().toLowerCase()
      : String(safeDefault ?? "");
  return allowed.has(value)
    ? value
    : allowed.has(fallbackValue)
      ? fallbackValue
      : allowed.has(defaultValue)
        ? defaultValue
        : (allowedValues[0] ?? "");
}

function normalizeBoolean(raw, fallback) {
  return typeof raw === "boolean" ? raw : fallback;
}

function normalizeGp(raw, fallback) {
  return clampInt(raw, 0, MAX_GP_INPUT, clampInt(fallback, 0, MAX_GP_INPUT, 0));
}

function finiteFallback(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function asRecord(value) {
  return isRecord(value) ? value : {};
}

function isRecord(value) {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function mintCreatureId(seenIds) {
  let id = "";
  do {
    id =
      globalThis.crypto?.randomUUID?.() ??
      `c-${Math.random().toString(36).slice(2, 10)}`;
  } while (seenIds.has(id));
  return id;
}
