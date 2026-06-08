/**
 * Infinity D&D5e — Merchant Buy Filter
 *
 * The "Buys From Players" filter is the mirror of a merchant's Random Stock
 * pool (item types + rarities), but applied to the SELL side: it gates which
 * items the merchant is willing to purchase. An empty filter (the default)
 * means "buys anything sellable", preserving the original behavior.
 *
 * Matching is harder than the stock pool because player-owned items usually
 * lack the curated pack's `lootType` flag. So we match on the tagged lootType
 * when present, and otherwise fall back to a dnd5e item-type classifier so the
 * same chip vocabulary works on a raw character sheet.
 *
 * Pure: no Foundry imports beyond the shared tag-vocabulary readers, which
 * tolerate both live Documents and plain snapshots.
 */

import { getEffectiveRarity } from "../loot/roller.js";
import { getItemLootType, isAmmunitionItem } from "../loot/tag-vocabulary.js";

/** dnd5e `equipment` subtypes that are armor (vs. clothing / trinkets / gear). */
const ARMOR_SUBTYPES = new Set([
  "light",
  "medium",
  "heavy",
  "shield",
  "natural",
]);

/**
 * The set of loot-type chips a given item belongs to, for buy-filter matching.
 * Combines the tagged canonical lootType (when present) with a dnd5e-type
 * fallback so untagged player gear still classifies.
 *
 * @param {object} item - a dnd5e item Document or snapshot
 * @returns {Set<string>} loot.* category keys (subset of LOOT_TYPES)
 */
export function itemBuyCategories(item) {
  const out = new Set();

  // Synthetic ammunition chip — arrows/bolts ship as loot.consumable, so this
  // virtual-chip predicate applies whether or not the item is tagged.
  if (isAmmunitionItem(item)) out.add("loot.ammunition");

  // 1. Tagged compendium items (incl. ones the player bought from a merchant,
  //    which keep their source flags) carry a canonical lootType. Trust it and
  //    STOP — the dnd5e-type fallback below exists only to classify untagged
  //    character-sheet gear. Running it on tagged items both double-classifies
  //    (every consumable also picked up loot.consumable) and, worse, mis-flags
  //    mundane base gear as magic, because this pack tags base weapons/armor as
  //    rarity "common" (see the heuristic note in the fallback).
  const tagged = getItemLootType(item);
  if (tagged) {
    out.add(tagged);
    return out;
  }

  // 2. dnd5e-type fallback for untagged sheet items.
  const type = String(item?.type ?? "").toLowerCase();
  const subtype = String(item?.system?.type?.value ?? "")
    .trim()
    .toLowerCase();
  // dnd5e uses system.rarity to mark magic items, but the curated pack also
  // stamps mundane base gear with rarity "common". So only a rarity ABOVE
  // common counts as magic here; "common" or blank is treated as mundane.
  const rarity = String(item?.system?.rarity ?? "")
    .trim()
    .toLowerCase();
  const isMagic = rarity !== "" && rarity !== "common";

  switch (type) {
    case "weapon":
      out.add(isMagic ? "loot.weapon.magic" : "loot.weapon.mundane");
      break;
    case "equipment":
      if (ARMOR_SUBTYPES.has(subtype)) {
        out.add(isMagic ? "loot.armor.magic" : "loot.armor.mundane");
      } else {
        out.add(isMagic ? "loot.equipment.magic" : "loot.equipment");
      }
      break;
    case "consumable":
      out.add("loot.consumable");
      if (subtype === "potion") out.add("loot.potion");
      if (subtype === "scroll") out.add("loot.scroll");
      if (subtype === "reagent") out.add("loot.reagent");
      break;
    case "tool":
      out.add("loot.tool");
      break;
    case "loot":
      if (subtype === "gem") out.add("loot.gem");
      else if (subtype === "art") out.add("loot.art");
      else if (subtype === "reagent") out.add("loot.reagent");
      else out.add("loot.trade-good");
      break;
    case "container":
    case "backpack":
      out.add("loot.container");
      break;
    default:
      break;
  }
  return out;
}

/**
 * Whether a merchant will buy this item, given its buy filter.
 *
 * AND semantics when both lists are set (must match a selected type AND a
 * selected rarity), mirroring the stock pool's `filterCandidates`. An empty
 * filter buys anything.
 *
 * @param {{lootTypes?: string[], rarities?: string[]}} buyFilter
 * @param {object} item - a dnd5e item Document or snapshot
 * @returns {boolean}
 */
export function itemMatchesBuyFilter(buyFilter, item) {
  const lootTypes = Array.isArray(buyFilter?.lootTypes)
    ? buyFilter.lootTypes
    : [];
  const rarities = Array.isArray(buyFilter?.rarities) ? buyFilter.rarities : [];
  if (lootTypes.length === 0 && rarities.length === 0) return true;

  if (rarities.length > 0 && !rarities.includes(getEffectiveRarity(item))) {
    return false;
  }
  if (lootTypes.length > 0) {
    const cats = itemBuyCategories(item);
    if (!lootTypes.some((t) => cats.has(t))) return false;
  }
  return true;
}
