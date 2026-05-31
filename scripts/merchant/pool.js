/**
 * Infinity D&D5e — Merchant Stock Pool
 *
 * Turns a merchant's stock-pool config (allowed loot types + rarities +
 * a count) into a randomized set of inventory rows, drawn from the same
 * curated compendium the loot tools use. Reuses the loot roller so the
 * weighting, eligibility, and rarity logic stay in one place.
 *
 * Pure except for the injectable rng — unit-testable without Foundry.
 */

import { filterCandidates, rollLoot } from "../loot/roller.js";
import { createInventoryRow, resolveStockQty } from "./store.js";

/**
 * Roll randomized inventory rows from a merchant's stock pool.
 *
 * @param {{lootTypes?: string[], rarities?: string[], count?: number}} pool
 * @param {Array<object>} items - candidate item snapshots (loadCompendiumItems output)
 * @param {object} [opts]
 * @param {Set<string>|string[]} [opts.exclude] - uuids already stocked; skipped
 * @param {() => number} [opts.rng] - injectable RNG for deterministic tests
 * @returns {{rows: Array<object>, warnings: string[]}}
 */
export function rollMerchantStock(pool, items, opts = {}) {
  const lootTypes = Array.isArray(pool?.lootTypes) ? pool.lootTypes : [];
  const rarities = Array.isArray(pool?.rarities) ? pool.rarities : [];
  const count = Math.max(1, Math.floor(Number(pool?.count ?? 6)));
  const exclude =
    opts.exclude instanceof Set
      ? opts.exclude
      : new Set(Array.isArray(opts.exclude) ? opts.exclude : []);

  const warnings = [];
  if (lootTypes.length === 0 && rarities.length === 0) {
    warnings.push("Select at least one item type or rarity for the pool.");
    return { rows: [], warnings };
  }

  const candidates = filterCandidates(items, { lootTypes, rarities }).filter(
    (item) => !exclude.has(item?.uuid),
  );
  if (candidates.length === 0) {
    warnings.push("No compendium items match the pool's types/rarities.");
    return { rows: [], warnings };
  }

  const rolled = rollLoot(candidates, { count, rng: opts.rng });
  const seen = new Set();
  const rows = [];
  for (const entry of rolled.items ?? []) {
    const item = entry?.item;
    const uuid = item?.uuid;
    if (!uuid || seen.has(uuid)) continue;
    seen.add(uuid);
    // Ammo always stocks as a full stack of 20; the roller's random
    // ammo quantity is right for loot drops, not a shop shelf.
    const qty = resolveStockQty(item, entry.quantity ?? 1);
    rows.push(createInventoryRow(uuid, { qty, startingQty: qty }));
  }
  for (const w of rolled.warnings ?? []) warnings.push(w);
  return { rows, warnings };
}
