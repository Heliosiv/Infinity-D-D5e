/**
 * Infinity D&D5e — Merchant Stock Pool
 *
 * Turns a merchant's stock-pool config (allowed loot types, rarities,
 * rarity-balance weights, and a count) into randomized inventory rows, drawn from the same
 * curated compendium the loot tools use. Reuses the loot roller so the
 * weighting, eligibility, and rarity logic stay in one place.
 *
 * Pure except for the injectable rng — unit-testable without Foundry.
 */

import { filterCandidates, rollLoot } from "../loot/roller.js";
import {
  LOOT_BALANCE_PROFILE_IDS,
  getLootBundleBalanceOptions,
} from "../loot/category-balance.js";
import { valueFilterSpec } from "../loot/value-filter.js";
import { createInventoryRow, resolveStockQty } from "./store.js";
import { allocateStockUnits, normalizeStockTypeShares } from "./stock-split.js";
import {
  getItemLootCategories,
  getItemRollCategory,
} from "../loot/item-categories.js";
import { getItemGpValue } from "../loot/tag-vocabulary.js";

/** Default line count when neither a line cap nor a stock budget is set. */
const DEFAULT_FALLBACK_COUNT = 6;

/** Normalize an item name for duplicate detection (case/space-insensitive). */
function nameKey(name) {
  return String(name ?? "")
    .trim()
    .toLowerCase();
}

/**
 * Roll randomized inventory rows from a merchant's stock pool.
 *
 * Two fill modes (driven by `pool.count` / `pool.budgetGp`):
 * - `count > 0`  → cap at that many unique line items (budget, if set, still trims).
 * - `count = 0`  → fill toward `budgetGp` (let the line count float).
 * Neither set falls back to a default spread of {@link DEFAULT_FALLBACK_COUNT}.
 *
 * De-duplication: candidates already on the shelf (by uuid OR by name) are
 * dropped, and the candidate pool is collapsed to one entry per name, so two
 * different library items sharing a name can never land as separate rows.
 *
 * @param {{lootTypes?: string[], typeShares?: Record<string, number>, rarities?: string[], count?: number, budgetGp?: number, rarityWeights?: Record<string, number>}} pool
 * @param {Array<object>} items - candidate item snapshots (loadCompendiumItems output)
 * @param {object} [opts]
 * @param {Set<string>|string[]} [opts.exclude] - uuids already stocked; skipped
 * @param {Set<string>|string[]} [opts.excludeNames] - item names already stocked; skipped
 * @param {() => number} [opts.rng] - injectable RNG for deterministic tests
 * @returns {{rows: Array<object>, warnings: string[]}}
 */
export function rollMerchantStock(pool, items, opts = {}) {
  const lootTypes = Array.isArray(pool?.lootTypes) ? pool.lootTypes : [];
  const rarities = Array.isArray(pool?.rarities) ? pool.rarities : [];
  const requestedCount = Math.max(0, Math.floor(Number(pool?.count ?? 0)));
  const budgetGp = Math.max(0, Number(pool?.budgetGp ?? 0));
  const exclude =
    opts.exclude instanceof Set
      ? opts.exclude
      : new Set(Array.isArray(opts.exclude) ? opts.exclude : []);
  const excludeNames = new Set(
    [
      ...(opts.excludeNames instanceof Set
        ? opts.excludeNames
        : Array.isArray(opts.excludeNames)
          ? opts.excludeNames
          : []),
    ].map(nameKey),
  );

  const warnings = [];
  if (lootTypes.length === 0 && rarities.length === 0) {
    warnings.push("Select at least one item type or rarity for the pool.");
    return { rows: [], warnings };
  }

  // Neither a line cap nor a budget → a sensible default spread.
  let count = requestedCount;
  if (count === 0 && budgetGp === 0) {
    count = DEFAULT_FALLBACK_COUNT;
    warnings.push(
      `No line count or stock budget set — generated a default of ${DEFAULT_FALLBACK_COUNT} items.`,
    );
  }

  // Filter to eligible candidates, then drop any already on the shelf (uuid or
  // name) and collapse to one candidate per name so the roll can't surface two
  // different entries that share a display name.
  const eligible = filterCandidates(items, {
    lootTypes,
    rarities,
    ...valueFilterSpec({ minItemGp: pool?.minGp, maxItemGp: pool?.maxGp }),
  });
  const candidates = [];
  const candidateNames = new Set();
  for (const item of eligible) {
    if (!item || exclude.has(item.uuid)) continue;
    const key = nameKey(item.name);
    if (key && (excludeNames.has(key) || candidateNames.has(key))) continue;
    if (key) candidateNames.add(key);
    candidates.push(item);
  }
  if (candidates.length === 0) {
    warnings.push("No compendium items match the pool's types/rarities.");
    return { rows: [], warnings };
  }

  const splitTypes = [...new Set(lootTypes)];
  const split = budgetGp > 0 && splitTypes.length > 1;
  const shares = normalizeStockTypeShares(splitTypes, pool?.typeShares);
  const budgetUnits = split
    ? allocateStockUnits(Math.round(budgetGp * 100), splitTypes, shares)
    : {};
  const lineCaps =
    split && count ? allocateStockUnits(count, splitTypes, shares) : {};
  const groups = new Map(splitTypes.map((type) => [type, []]));
  if (split)
    for (const item of candidates) {
      const categories = getItemLootCategories(item);
      const owner = groups.has(getItemRollCategory(item))
        ? getItemRollCategory(item)
        : splitTypes.find((type) => categories.has(type));
      if (owner) groups.get(owner).push(item);
    }
  const rollGroup = (group, groupCount, groupBudget) =>
    rollLoot(group, {
      count: groupCount, // 0 = fill toward budget; > 0 = unique-line cap
      budgetGp: groupBudget,
      // A merchant shelf can legitimately need more than the loot roller's
      // 40-line auto default. The distinct eligible pool is the natural limit.
      ...(groupCount === 0 && groupBudget > 0
        ? {
            maxCap: group.length,
            maxAttempts: Math.max(600, group.length + 1),
            preferDistinctItems: true,
            budgetHighFrac: 1,
          }
        : {}),
      ...(split ? { budgetHighFrac: 1 } : {}),
      fixedQuantityForItem: (item) => resolveStockQty(item, 1),
      repeatableItems: true,
      ...getLootBundleBalanceOptions({
        profileId: LOOT_BALANCE_PROFILE_IDS.MERCHANT,
        lootTypes,
        rarityWeights: pool?.rarityWeights,
      }),
      rng: opts.rng,
    });
  const rolledGroups = split
    ? splitTypes
        .filter(
          (type) => budgetUnits[type] > 0 && (!count || lineCaps[type] > 0),
        )
        .map((type) => {
          const quota = budgetUnits[type] / 100;
          const affordable = groups
            .get(type)
            .filter(
              (item) =>
                getItemGpValue(item) * resolveStockQty(item, 1) <= quota,
            );
          if (!affordable.length) {
            warnings.push(
              `${type} has no item affordable within its ${quota} gp share. Adjust the split or item value range.`,
            );
            return { items: [], warnings: [] };
          }
          if (affordable.length === 1 && groups.get(type).length > 1) {
            warnings.push(
              `${type} can only fit ${affordable[0].name} within its ${quota} gp share. Increase this type's percentage for more variety.`,
            );
          }
          return rollGroup(affordable, count ? lineCaps[type] : 0, quota);
        })
    : [rollGroup(candidates, count, budgetGp)];
  const seen = new Set();
  const seenNames = new Set();
  const rows = [];
  for (const entry of rolledGroups.flatMap((result) => result.items ?? [])) {
    const item = entry?.item;
    const uuid = item?.uuid;
    if (!uuid || seen.has(uuid)) continue;
    const key = nameKey(item.name);
    if (key && seenNames.has(key)) continue;
    seen.add(uuid);
    if (key) seenNames.add(key);
    // Each ammunition draw is a full 20-piece stack. Keep the sum when the
    // same item is drawn more than once, while retaining one shelf row.
    const qty = Math.max(
      resolveStockQty(item, 1),
      Math.floor(Number(entry.quantity) || 1),
    );
    rows.push(createInventoryRow(uuid, { qty, startingQty: qty }));
  }
  for (const result of rolledGroups)
    for (const w of result.warnings ?? []) warnings.push(w);
  return { rows, warnings };
}
