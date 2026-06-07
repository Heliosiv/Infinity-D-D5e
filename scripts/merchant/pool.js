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
import { valueFilterSpec } from "../loot/value-filter.js";
import { createInventoryRow, resolveStockQty } from "./store.js";

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
 * @param {{lootTypes?: string[], rarities?: string[], count?: number, budgetGp?: number, rarityWeights?: Record<string, number>}} pool
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

  const rolled = rollLoot(candidates, {
    count, // 0 = fill toward budgetGp; > 0 = unique-line cap
    budgetGp, // 0 = no budget
    rarityWeights: pool?.rarityWeights,
    rng: opts.rng,
  });
  const seen = new Set();
  const seenNames = new Set();
  const rows = [];
  for (const entry of rolled.items ?? []) {
    const item = entry?.item;
    const uuid = item?.uuid;
    if (!uuid || seen.has(uuid)) continue;
    const key = nameKey(item.name);
    if (key && seenNames.has(key)) continue;
    seen.add(uuid);
    if (key) seenNames.add(key);
    // Ammo always stocks as a full stack of 20; the roller's random
    // ammo quantity is right for loot drops, not a shop shelf.
    const qty = resolveStockQty(item, entry.quantity ?? 1);
    rows.push(createInventoryRow(uuid, { qty, startingQty: qty }));
  }
  for (const w of rolled.warnings ?? []) warnings.push(w);
  return { rows, warnings };
}
