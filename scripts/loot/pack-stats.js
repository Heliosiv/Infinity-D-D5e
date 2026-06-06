/**
 * Infinity D&D5e — Pack Stats
 *
 * Derive distribution stats from a loaded compendium so the UI can
 * surface real numbers ("Rare: 318 items") instead of opaque enum
 * labels. Computed once per cache fill and re-used across renders.
 *
 * Pure function — operates on whatever array of item POJOs the app
 * provides. No Foundry imports.
 */

import {
  getItemGpValue,
  getItemLootType,
  getItemMagicNature,
  getItemRarity,
  getItemTier,
  isBareSpellLootItem,
  isLootEligible,
} from "./tag-vocabulary.js";
import { getEffectiveRarity } from "./roller.js";

/**
 * Build a stats snapshot for a candidate pool.
 *
 * @param {Array<object>} items
 * @returns {{
 *   totalItems: number,
 *   eligibleItems: number,
 *   byTier: Record<string, number>,
 *   byRarity: Record<string, number>,
 *   byLootType: Record<string, number>,
 *   byMagicNature: { magic: number, mundane: number, neutral: number },
 *   gp: { min: number, max: number, total: number, median: number, p95: number }
 * }}
 */
export function computePackStats(items) {
  const pool = Array.isArray(items) ? items : [];
  const stats = {
    totalItems: pool.length,
    eligibleItems: 0,
    byTier: {},
    byRarity: {},
    byLootType: {},
    byMagicNature: { magic: 0, mundane: 0, neutral: 0 },
    gp: { min: 0, max: 0, total: 0, median: 0, p95: 0 },
  };
  if (pool.length === 0) return stats;

  const gpValues = [];
  for (const item of pool) {
    if (!item) continue;
    if (isLootEligible(item)) stats.eligibleItems += 1;

    const tier = getItemTier(item);
    if (tier) stats.byTier[tier] = (stats.byTier[tier] ?? 0) + 1;

    const rarity = getItemRarity(item);
    if (rarity) stats.byRarity[rarity] = (stats.byRarity[rarity] ?? 0) + 1;

    const lootType = getItemLootType(item);
    if (lootType)
      stats.byLootType[lootType] = (stats.byLootType[lootType] ?? 0) + 1;

    const nature = getItemMagicNature(item);
    stats.byMagicNature[nature] += 1;

    const gp = getItemGpValue(item);
    if (gp > 0) gpValues.push(gp);
  }

  if (gpValues.length > 0) {
    gpValues.sort((a, b) => a - b);
    stats.gp.min = gpValues[0];
    stats.gp.max = gpValues[gpValues.length - 1];
    stats.gp.total = gpValues.reduce((sum, value) => sum + value, 0);
    stats.gp.median = gpValues[Math.floor(gpValues.length / 2)];
    stats.gp.p95 =
      gpValues[
        Math.min(gpValues.length - 1, Math.floor(gpValues.length * 0.95))
      ];
  }
  return stats;
}

/**
 * Count items by rarity and loot type, scoped to a tier window.
 *
 * Used by the loot UIs to populate rarity / loot-type chip counts that
 * reflect the current tier choice instead of the pack as a whole — so
 * checking "common" at T2 shows the actual count of commons available
 * (T1 commons reach T2 via the tier window in `_filterSpec`), not the
 * misleading pack-wide total. A null / empty `tiers` window returns
 * the same counts as a pack-wide scan.
 *
 * Only honors eligibility (loot-eligible flag); rarity normalization
 * matches `filterCandidates`. Output is in the same shape as the
 * `byRarity` / `byLootType` properties of `computePackStats`.
 *
 * @param {Array<object>} items
 * @param {string[]} [tiers] - inclusive tier window; empty/missing = all tiers
 * @returns {{ byRarity: Record<string, number>, byLootType: Record<string, number>, total: number }}
 */
export function computeTierFilteredStats(items, tiers = null) {
  const pool = Array.isArray(items) ? items : [];
  const tierSet =
    Array.isArray(tiers) && tiers.length > 0
      ? new Set(tiers.map((t) => String(t)))
      : null;
  const byRarity = {};
  const byLootType = {};
  let total = 0;
  for (const item of pool) {
    if (!item) continue;
    if (tierSet && !tierSet.has(getItemTier(item))) continue;
    if (!isLootEligible(item)) continue;
    if (isBareSpellLootItem(item)) continue;
    total += 1;
    // Effective rarity (floors untagged → common, treasure → value band) so
    // the chip count matches exactly what selecting that rarity will return.
    const rarity = getEffectiveRarity(item);
    byRarity[rarity] = (byRarity[rarity] ?? 0) + 1;
    const lootType = getItemLootType(item);
    if (lootType) byLootType[lootType] = (byLootType[lootType] ?? 0) + 1;
  }
  return { byRarity, byLootType, total };
}

/**
 * Count items in a pool by a single axis. Convenience over reading
 * `stats.byTier[tier]` when you have the live pool but no snapshot
 * yet — used for tests where computing the full stats is overkill.
 */
export function countBy(items, key) {
  if (!Array.isArray(items)) return 0;
  if (typeof key !== "function") {
    throw new TypeError("countBy: key must be a function (item) => string");
  }
  const out = {};
  for (const item of items) {
    const bucket = String(key(item) ?? "");
    if (!bucket) continue;
    out[bucket] = (out[bucket] ?? 0) + 1;
  }
  return out;
}
