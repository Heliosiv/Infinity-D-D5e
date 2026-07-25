/**
 * Shared random-loot bundle balance profiles.
 *
 * Category percentages answer "what kind of item is the next draw?" before
 * the roller chooses a specific document inside that category. This prevents
 * large compendium folders from becoming more likely merely because they
 * contain more entries.
 *
 * Rarity multipliers operate inside the chosen category. They shape the
 * common-to-legendary progression without turning a rarity into an implicit
 * category weight.
 */

import { getItemRollCategory } from "./item-categories.js";
import { LOOT_TYPES, RARITIES, TIERS } from "./tag-vocabulary.js";

export const LOOT_BUNDLE_CATEGORY_REPEAT_PENALTY = 0.45;
export const LOOT_BUNDLE_SCROLL_CAP = 1;
export const LOOT_BALANCE_PROFILE_IDS = Object.freeze({
  ENCOUNTER: "encounter",
  HOARD: "hoard-cache",
  CREATURE: "creature-drops",
  MERCHANT: "merchant-stock",
});

// Backward-compatible names retained for macros/tests that imported the first
// Per-Encounter implementation directly.
export const ENCOUNTER_CATEGORY_REPEAT_PENALTY =
  LOOT_BUNDLE_CATEGORY_REPEAT_PENALTY;
export const ENCOUNTER_SCROLL_CAP = LOOT_BUNDLE_SCROLL_CAP;

const ENCOUNTER_CATEGORY_PROFILES = freezeProfiles({
  t1: {
    "loot.weapon.magic": 0.5,
    "loot.weapon.mundane": 12,
    "loot.armor.magic": 0.5,
    "loot.armor.mundane": 5,
    "loot.equipment.magic": 1,
    "loot.equipment": 10,
    "loot.consumable": 14,
    "loot.potion": 4,
    "loot.reagent": 8,
    "loot.scroll": 1,
    "loot.ammunition": 6,
    "loot.tool": 10,
    "loot.gem": 8,
    "loot.art": 5,
    "loot.trade-good": 11,
    "loot.container": 4,
  },
  t2: {
    "loot.weapon.magic": 4,
    "loot.weapon.mundane": 7,
    "loot.armor.magic": 2,
    "loot.armor.mundane": 3,
    "loot.equipment.magic": 6,
    "loot.equipment": 7,
    "loot.consumable": 14,
    "loot.potion": 8,
    "loot.reagent": 6,
    "loot.scroll": 1,
    "loot.ammunition": 5,
    "loot.tool": 6,
    "loot.gem": 10,
    "loot.art": 8,
    "loot.trade-good": 10,
    "loot.container": 3,
  },
  t3: {
    "loot.weapon.magic": 12,
    "loot.weapon.mundane": 3,
    "loot.armor.magic": 8,
    "loot.armor.mundane": 1,
    "loot.equipment.magic": 15,
    "loot.equipment": 4,
    "loot.consumable": 13,
    "loot.potion": 8,
    "loot.reagent": 3,
    "loot.scroll": 1,
    "loot.ammunition": 3,
    "loot.tool": 3,
    "loot.gem": 9,
    "loot.art": 8,
    "loot.trade-good": 7,
    "loot.container": 2,
  },
  t4: {
    "loot.weapon.magic": 18,
    "loot.weapon.mundane": 1,
    "loot.armor.magic": 13,
    "loot.armor.mundane": 0.5,
    "loot.equipment.magic": 22,
    "loot.equipment": 1.5,
    "loot.consumable": 12,
    "loot.potion": 7,
    "loot.reagent": 1,
    "loot.scroll": 1,
    "loot.ammunition": 2,
    "loot.tool": 1,
    "loot.gem": 7,
    "loot.art": 9,
    "loot.trade-good": 3,
    "loot.container": 1,
  },
  t5: {
    "loot.weapon.magic": 20,
    "loot.weapon.mundane": 0.25,
    "loot.armor.magic": 15,
    "loot.armor.mundane": 0.25,
    "loot.equipment.magic": 28,
    "loot.equipment": 0.5,
    "loot.consumable": 11,
    "loot.potion": 6,
    "loot.reagent": 0.5,
    "loot.scroll": 1,
    "loot.ammunition": 1.5,
    "loot.tool": 0.5,
    "loot.gem": 6,
    "loot.art": 7,
    "loot.trade-good": 2,
    "loot.container": 0.5,
  },
});

const HOARD_CATEGORY_PROFILES = freezeProfiles({
  t1: {
    "loot.weapon.magic": 1,
    "loot.weapon.mundane": 5,
    "loot.armor.magic": 1,
    "loot.armor.mundane": 3,
    "loot.equipment.magic": 3,
    "loot.equipment": 5,
    "loot.consumable": 8,
    "loot.potion": 4,
    "loot.reagent": 5,
    "loot.scroll": 1,
    "loot.ammunition": 3,
    "loot.tool": 3,
    "loot.gem": 15,
    "loot.art": 16,
    "loot.trade-good": 20,
    "loot.container": 7,
  },
  t2: {
    "loot.weapon.magic": 5,
    "loot.weapon.mundane": 3,
    "loot.armor.magic": 3,
    "loot.armor.mundane": 2,
    "loot.equipment.magic": 7,
    "loot.equipment": 4,
    "loot.consumable": 8,
    "loot.potion": 6,
    "loot.reagent": 4,
    "loot.scroll": 1,
    "loot.ammunition": 3,
    "loot.tool": 3,
    "loot.gem": 14,
    "loot.art": 17,
    "loot.trade-good": 15,
    "loot.container": 5,
  },
  t3: {
    "loot.weapon.magic": 10,
    "loot.weapon.mundane": 2,
    "loot.armor.magic": 7,
    "loot.armor.mundane": 1,
    "loot.equipment.magic": 14,
    "loot.equipment": 3,
    "loot.consumable": 8,
    "loot.potion": 6,
    "loot.reagent": 3,
    "loot.scroll": 1,
    "loot.ammunition": 2,
    "loot.tool": 2,
    "loot.gem": 11,
    "loot.art": 16,
    "loot.trade-good": 10,
    "loot.container": 4,
  },
  t4: {
    "loot.weapon.magic": 16,
    "loot.weapon.mundane": 1,
    "loot.armor.magic": 12,
    "loot.armor.mundane": 0.5,
    "loot.equipment.magic": 20,
    "loot.equipment": 1.5,
    "loot.consumable": 8,
    "loot.potion": 6,
    "loot.reagent": 1,
    "loot.scroll": 1,
    "loot.ammunition": 1,
    "loot.tool": 1,
    "loot.gem": 9,
    "loot.art": 15,
    "loot.trade-good": 5,
    "loot.container": 2,
  },
  t5: {
    "loot.weapon.magic": 19,
    "loot.weapon.mundane": 0.25,
    "loot.armor.magic": 14,
    "loot.armor.mundane": 0.25,
    "loot.equipment.magic": 27,
    "loot.equipment": 0.5,
    "loot.consumable": 7,
    "loot.potion": 5,
    "loot.reagent": 0.5,
    "loot.scroll": 1,
    "loot.ammunition": 1,
    "loot.tool": 0.5,
    "loot.gem": 7,
    "loot.art": 12,
    "loot.trade-good": 3,
    "loot.container": 2,
  },
});

const CREATURE_CATEGORY_PROFILES = freezeProfiles({
  t1: {
    "loot.weapon.magic": 0.2,
    "loot.weapon.mundane": 14,
    "loot.armor.magic": 0.2,
    "loot.armor.mundane": 7,
    "loot.equipment.magic": 0.6,
    "loot.equipment": 12,
    "loot.consumable": 17,
    "loot.potion": 4,
    "loot.reagent": 10,
    "loot.scroll": 0.5,
    "loot.ammunition": 8,
    "loot.tool": 9,
    "loot.gem": 4,
    "loot.art": 2,
    "loot.trade-good": 9,
    "loot.container": 2.5,
  },
  t2: {
    "loot.weapon.magic": 2,
    "loot.weapon.mundane": 11,
    "loot.armor.magic": 1,
    "loot.armor.mundane": 5,
    "loot.equipment.magic": 3,
    "loot.equipment": 10,
    "loot.consumable": 18,
    "loot.potion": 7,
    "loot.reagent": 8,
    "loot.scroll": 0.75,
    "loot.ammunition": 7,
    "loot.tool": 7,
    "loot.gem": 5,
    "loot.art": 3,
    "loot.trade-good": 9,
    "loot.container": 3.25,
  },
  t3: {
    "loot.weapon.magic": 7,
    "loot.weapon.mundane": 8,
    "loot.armor.magic": 4,
    "loot.armor.mundane": 3,
    "loot.equipment.magic": 9,
    "loot.equipment": 8,
    "loot.consumable": 18,
    "loot.potion": 8,
    "loot.reagent": 6,
    "loot.scroll": 1,
    "loot.ammunition": 6,
    "loot.tool": 6,
    "loot.gem": 5,
    "loot.art": 4,
    "loot.trade-good": 5,
    "loot.container": 2,
  },
  t4: {
    "loot.weapon.magic": 9,
    "loot.weapon.mundane": 6,
    "loot.armor.magic": 5,
    "loot.armor.mundane": 2,
    "loot.equipment.magic": 12,
    "loot.equipment": 8,
    "loot.consumable": 14,
    "loot.potion": 7,
    "loot.reagent": 3,
    "loot.scroll": 1,
    "loot.ammunition": 7,
    "loot.tool": 6,
    "loot.gem": 8,
    "loot.art": 7,
    "loot.trade-good": 2,
    "loot.container": 3,
  },
  t5: {
    "loot.weapon.magic": 10.5,
    "loot.weapon.mundane": 4,
    "loot.armor.magic": 8,
    "loot.armor.mundane": 2,
    "loot.equipment.magic": 15,
    "loot.equipment": 6,
    "loot.consumable": 16,
    "loot.potion": 7,
    "loot.reagent": 3,
    "loot.scroll": 1.5,
    "loot.ammunition": 5,
    "loot.tool": 4,
    "loot.gem": 6.5,
    "loot.art": 5.5,
    "loot.trade-good": 2,
    "loot.container": 4,
  },
});

const MERCHANT_CATEGORY_PROFILE = Object.freeze({
  "loot.weapon.magic": 7,
  "loot.weapon.mundane": 8,
  "loot.armor.magic": 4,
  "loot.armor.mundane": 4,
  "loot.equipment.magic": 9,
  "loot.equipment": 10,
  "loot.consumable": 14,
  "loot.potion": 10,
  "loot.reagent": 7,
  "loot.scroll": 5,
  "loot.ammunition": 6,
  "loot.tool": 7,
  "loot.gem": 3,
  "loot.art": 1,
  "loot.trade-good": 3,
  "loot.container": 2,
});

const EVEN_RARITY_PROFILE = Object.freeze(
  Object.fromEntries(RARITIES.map((rarity) => [rarity, 1])),
);

const ENCOUNTER_RARITY_PROFILES = freezeProfiles({
  t1: {
    common: 1,
    uncommon: 0.15,
    rare: 0.02,
    "very-rare": 0.005,
    legendary: 0.001,
    artifact: 0.001,
  },
  t2: {
    common: 1,
    uncommon: 1.6,
    rare: 1,
    "very-rare": 0.1,
    legendary: 0.02,
    artifact: 0.01,
  },
  t3: {
    common: 0.15,
    uncommon: 1,
    rare: 2.2,
    "very-rare": 10,
    legendary: 0.05,
    artifact: 0.01,
  },
  t4: {
    common: 0.05,
    uncommon: 0.1,
    rare: 1,
    "very-rare": 2.2,
    legendary: 5,
    artifact: 0.05,
  },
  t5: {
    common: 0.02,
    uncommon: 0.05,
    rare: 0.15,
    "very-rare": 1,
    legendary: 2,
    artifact: 0.2,
  },
});

const CREATURE_RARITY_PROFILES = freezeProfiles({
  t1: {
    common: 1,
    uncommon: 0.08,
    rare: 0.01,
    "very-rare": 0.001,
    legendary: 0.001,
    artifact: 0.001,
  },
  t2: {
    common: 1,
    uncommon: 0.5,
    rare: 0.05,
    "very-rare": 0.01,
    legendary: 0.001,
    artifact: 0.001,
  },
  t3: {
    common: 0.1,
    uncommon: 1,
    rare: 0.8,
    "very-rare": 0.05,
    legendary: 0.005,
    artifact: 0.001,
  },
  t4: {
    common: 0.02,
    uncommon: 0.1,
    rare: 1,
    "very-rare": 0.7,
    legendary: 0.02,
    artifact: 0.001,
  },
  t5: {
    common: 0.01,
    uncommon: 0.02,
    rare: 0.1,
    "very-rare": 1,
    legendary: 0.6,
    artifact: 0.02,
  },
});

const PROFILE_REPEAT_PENALTIES = Object.freeze({
  [LOOT_BALANCE_PROFILE_IDS.ENCOUNTER]: LOOT_BUNDLE_CATEGORY_REPEAT_PENALTY,
  [LOOT_BALANCE_PROFILE_IDS.HOARD]: 0.75,
  [LOOT_BALANCE_PROFILE_IDS.CREATURE]: 0.55,
  [LOOT_BALANCE_PROFILE_IDS.MERCHANT]: 0.7,
});

const HOARD_SCROLL_CAPS = Object.freeze({
  small: 1,
  standard: 1,
  large: 2,
  massive: 2,
});

/**
 * Return a fresh category-weight record for a loot-generator profile.
 */
export function getLootBundleCategoryWeights(tier, profileId = "encounter") {
  const profile = normalizeProfileId(profileId);
  if (profile === LOOT_BALANCE_PROFILE_IDS.MERCHANT) {
    return { ...MERCHANT_CATEGORY_PROFILE };
  }
  const profiles =
    profile === LOOT_BALANCE_PROFILE_IDS.HOARD
      ? HOARD_CATEGORY_PROFILES
      : profile === LOOT_BALANCE_PROFILE_IDS.CREATURE
        ? CREATURE_CATEGORY_PROFILES
        : ENCOUNTER_CATEGORY_PROFILES;
  return { ...profiles[normalizeTier(tier)] };
}

/**
 * Return a fresh tier rarity curve for a loot-generator profile.
 */
export function getLootBundleRarityWeights(tier, profileId = "encounter") {
  const profile = normalizeProfileId(profileId);
  if (profile === LOOT_BALANCE_PROFILE_IDS.MERCHANT) {
    return { ...EVEN_RARITY_PROFILE };
  }
  const profiles =
    profile === LOOT_BALANCE_PROFILE_IDS.CREATURE
      ? CREATURE_RARITY_PROFILES
      : ENCOUNTER_RARITY_PROFILES;
  return { ...profiles[normalizeTier(tier)] };
}

/**
 * Count primary roll categories already present in a bundle.
 *
 * Accepts raw items or materialized/decorated entries.
 */
export function countLootBundleCategories(entries = []) {
  const counts = {};
  for (const entry of Array.isArray(entries) ? entries : []) {
    const category =
      String(entry?.rollCategory ?? "").trim() ||
      getItemRollCategory(entry?.item ?? entry);
    if (!category) continue;
    counts[category] = (counts[category] ?? 0) + 1;
  }
  return counts;
}

/**
 * Complete options for any balanced loot-bundle roll or reroll.
 *
 * Scroll caps follow the owning workflow: one for encounters and individual
 * creatures, scale-shaped for hoards, and unrestricted for merchant shelves.
 * An explicit Scroll-only filter always removes a loot-bundle cap because the
 * GM has deliberately narrowed the roll to that category.
 */
export function getLootBundleBalanceOptions({
  profileId = "encounter",
  tier = "t2",
  scale = "standard",
  lootTypes = [],
  existingItems = [],
  rarityWeights = null,
} = {}) {
  const profile = normalizeProfileId(profileId);
  const selectedTypes = normalizeLootTypes(lootTypes);
  const scrollOnly =
    selectedTypes.length === 1 && selectedTypes[0] === "loot.scroll";
  const scrollCap = getScrollCap(profile, scale);

  return {
    categoryWeights: getLootBundleCategoryWeights(tier, profile),
    rarityWeights: rarityWeights ?? getLootBundleRarityWeights(tier, profile),
    categoryRepeatPenalty:
      PROFILE_REPEAT_PENALTIES[profile] ?? LOOT_BUNDLE_CATEGORY_REPEAT_PENALTY,
    categoryCaps:
      scrollOnly || scrollCap == null ? {} : { "loot.scroll": scrollCap },
    initialCategoryCounts: countLootBundleCategories(existingItems),
  };
}

/** @deprecated Use the shared loot-bundle names above. */
export const getEncounterCategoryWeights = getLootBundleCategoryWeights;
/** @deprecated Use the shared loot-bundle names above. */
export const getEncounterRarityWeights = getLootBundleRarityWeights;
/** @deprecated Use the shared loot-bundle names above. */
export const countEncounterCategories = countLootBundleCategories;
/** @deprecated Use the shared loot-bundle names above. */
export const getEncounterBalanceOptions = getLootBundleBalanceOptions;

function normalizeTier(value) {
  const tier = String(value ?? "")
    .trim()
    .toLowerCase();
  return TIERS.includes(tier) ? tier : "t2";
}

function normalizeProfileId(value) {
  const profile = String(value ?? "")
    .trim()
    .toLowerCase();
  return Object.values(LOOT_BALANCE_PROFILE_IDS).includes(profile)
    ? profile
    : LOOT_BALANCE_PROFILE_IDS.ENCOUNTER;
}

function getScrollCap(profileId, scale) {
  if (profileId === LOOT_BALANCE_PROFILE_IDS.MERCHANT) return null;
  if (profileId === LOOT_BALANCE_PROFILE_IDS.HOARD) {
    const key = String(scale ?? "")
      .trim()
      .toLowerCase();
    return HOARD_SCROLL_CAPS[key] ?? HOARD_SCROLL_CAPS.standard;
  }
  return LOOT_BUNDLE_SCROLL_CAP;
}

function normalizeLootTypes(values) {
  if (!Array.isArray(values)) return [];
  return [
    ...new Set(
      values
        .map((value) => String(value ?? "").trim())
        .filter((value) => LOOT_TYPES.includes(value)),
    ),
  ];
}

function freezeProfiles(profiles) {
  return Object.freeze(
    Object.fromEntries(
      Object.entries(profiles).map(([key, weights]) => [
        key,
        Object.freeze({ ...weights }),
      ]),
    ),
  );
}
