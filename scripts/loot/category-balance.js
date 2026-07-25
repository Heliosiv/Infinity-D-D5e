/**
 * Per-encounter loot balance profiles.
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
import { LOOT_TYPES, TIERS } from "./tag-vocabulary.js";

export const ENCOUNTER_CATEGORY_REPEAT_PENALTY = 0.45;
export const ENCOUNTER_SCROLL_CAP = 1;

const CATEGORY_PROFILES = freezeProfiles({
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

const RARITY_PROFILES = freezeProfiles({
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

/**
 * Return a fresh category-weight record for an encounter tier.
 */
export function getEncounterCategoryWeights(tier) {
  return { ...CATEGORY_PROFILES[normalizeTier(tier)] };
}

/**
 * Return a fresh rarity-weight record for an encounter tier.
 */
export function getEncounterRarityWeights(tier) {
  return { ...RARITY_PROFILES[normalizeTier(tier)] };
}

/**
 * Count primary roll categories already present in a bundle.
 *
 * Accepts raw items or materialized/decorated entries.
 */
export function countEncounterCategories(entries = []) {
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
 * Complete options for a balanced per-encounter roll or reroll.
 *
 * A mixed bundle can contain at most one spell scroll. An explicit Scroll-only
 * filter remains 100% scrolls because the GM has deliberately narrowed the
 * roll to that category.
 */
export function getEncounterBalanceOptions({
  tier = "t2",
  lootTypes = [],
  existingItems = [],
} = {}) {
  const selectedTypes = normalizeLootTypes(lootTypes);
  const scrollOnly =
    selectedTypes.length === 1 && selectedTypes[0] === "loot.scroll";

  return {
    categoryWeights: getEncounterCategoryWeights(tier),
    rarityWeights: getEncounterRarityWeights(tier),
    categoryRepeatPenalty: ENCOUNTER_CATEGORY_REPEAT_PENALTY,
    categoryCaps: scrollOnly ? {} : { "loot.scroll": ENCOUNTER_SCROLL_CAP },
    initialCategoryCounts: countEncounterCategories(existingItems),
  };
}

function normalizeTier(value) {
  const tier = String(value ?? "")
    .trim()
    .toLowerCase();
  return TIERS.includes(tier) ? tier : "t2";
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
