/**
 * Infinity D&D5e - Item loot categories
 *
 * Resolves every loot chip an item belongs to. Most items have one canonical
 * lootType, while virtual categories such as Gems, Art Objects, Ammunition,
 * and Reagents overlap a broader source bucket.
 *
 * Keep roller filtering, chip counts, and merchant buy filters on this helper
 * so a category cannot silently behave differently between those workflows.
 */

import {
  LOOT_TYPES,
  getItemKeywords,
  getItemLootType,
  isAmmunitionItem,
  isVariableTreasureBase,
} from "./tag-vocabulary.js";
import { getVariableTreasureKind, isVariableArtItem } from "./art-variants.js";

const VIRTUAL_LOOT_TYPE_TESTS = Object.freeze([
  Object.freeze({ key: "loot.gem", test: isVariableGemItem }),
  Object.freeze({ key: "loot.art", test: isVariableArtItem }),
  Object.freeze({ key: "loot.ammunition", test: isAmmunitionItem }),
  Object.freeze({ key: "loot.reagent", test: isReagentItem }),
]);

export const VIRTUAL_LOOT_TYPES = Object.freeze(
  VIRTUAL_LOOT_TYPE_TESTS.map(({ key }) => key),
);

const LOOT_TYPE_SET = new Set(LOOT_TYPES);
const VIRTUAL_LOOT_TYPE_SET = new Set(VIRTUAL_LOOT_TYPES);
const REAGENT_KEYWORDS = new Set([
  "loot.reagent",
  "merchant.reagent",
  "subtype.reagent",
  "folder.leaf.reagents",
  "folder.section.herbs-reagents",
]);

/**
 * Return every canonical or virtual loot category an item belongs to.
 *
 * The canonical lootType is preserved even when it is not a visible chip
 * (for example, loot.spell). Keyword fallback retains compatibility with
 * older imported items that have keywords but no explicit lootType.
 *
 * @param {object} item
 * @returns {Set<string>}
 */
export function getItemLootCategories(item) {
  const categories = new Set();
  if (!item || typeof item !== "object") return categories;

  const canonical = getItemLootType(item);
  if (canonical) categories.add(canonical);

  for (const keyword of getItemKeywords(item)) {
    const value = String(keyword ?? "").trim();
    if (LOOT_TYPE_SET.has(value) && !VIRTUAL_LOOT_TYPE_SET.has(value)) {
      categories.add(value);
    }
  }

  for (const { key, test } of VIRTUAL_LOOT_TYPE_TESTS) {
    if (test(item)) categories.add(key);
  }

  return categories;
}

/**
 * True for a genuine mundane gem base, never a magic item that merely has a
 * gem-themed name or inherited treasure tags.
 */
export function isVariableGemItem(item) {
  if (!isVariableTreasureBase(item)) return false;

  const kind = getVariableTreasureKind(item);
  if (kind === "gem") return true;
  if (kind && kind !== "gem") return false;

  const keywords = new Set(getItemKeywords(item));
  return (
    keywords.has("loot.gem") ||
    keywords.has("treasure.gem") ||
    keywords.has("loot.variable.gem") ||
    keywords.has("merchant.gem")
  );
}

/**
 * True for raw alchemical or crafting ingredients.
 *
 * Some shipped trade goods pre-date the loot.reagent tag but live in the
 * curated Herbs & Reagents folder. Folder matching is limited to loot and
 * consumable documents so a spell or magic item with reagent-flavored text
 * cannot leak into the chip.
 */
export function isReagentItem(item) {
  if (!item || typeof item !== "object") return false;
  if (getItemLootType(item) === "loot.reagent") return true;

  const subtype = String(item?.system?.type?.value ?? "")
    .trim()
    .toLowerCase();
  if (subtype === "reagent") return true;

  const type = String(item?.type ?? "")
    .trim()
    .toLowerCase();
  if (type !== "loot" && type !== "consumable") return false;

  return getItemKeywords(item).some((keyword) => {
    const value = String(keyword ?? "")
      .trim()
      .toLowerCase();
    return (
      REAGENT_KEYWORDS.has(value) ||
      value === "folder.path.sundries.herbs-reagents" ||
      value.startsWith("folder.path.sundries.herbs-reagents.")
    );
  });
}
