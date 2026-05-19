/**
 * Infinity D&D5e — Loot Roller
 *
 * Stateless functions that turn a (compendium-of-items, filter-spec,
 * budget) tuple into a deterministic roll result.
 *
 * Design choices:
 * - **Pure functions, injected RNG.** Pass `rng: Math.random` for
 *   production; tests pass a seeded sequence so output is repeatable.
 * - **No Foundry imports.** The roller works on plain item documents
 *   (POJOs with `flags`, `system`, `name`, `img`, etc.). The app layer
 *   converts compendium index entries / documents to this shape.
 * - **Two-pass selection.** Pass 1 picks N items by weighted random
 *   draw (no replacement at the item-id level, but stack-aware via
 *   maxRecommendedQty). Pass 2 enforces the gp budget by trimming
 *   the lowest-value picks until total <= budget.
 * - **No magic-string filters.** All filter inputs are normalized
 *   through tag-vocabulary helpers before comparison.
 */

import {
  ELEVATED_RARITIES,
  RARITIES,
  getItemGpValue,
  getItemKeywords,
  getItemLootType,
  getItemLootWeight,
  getItemMaxQty,
  getItemRarity,
  getItemTier,
  getItemValueBand,
  isLootEligible,
  normalizeRarity,
} from "./tag-vocabulary.js";

/**
 * Filter a candidate item pool down to the rollable set.
 *
 * @param {Array<object>} items - raw compendium entries
 * @param {object} [filter]
 * @param {string[]} [filter.lootTypes]   - if non-empty, item.lootType must match one
 * @param {string[]} [filter.tiers]       - if non-empty, item.tier must match one
 * @param {string[]} [filter.rarities]    - if non-empty, item.rarity must match one
 * @param {string[]} [filter.valueBands]  - if non-empty, item.valueBand must match one
 * @param {string[]} [filter.keywordsAny] - if non-empty, item must have at least one of these keywords
 * @param {string[]} [filter.keywordsAll] - if non-empty, item must have ALL of these keywords
 * @param {number}   [filter.minGp]       - exclude items below this gp value (default 0)
 * @param {number}   [filter.maxGp]       - exclude items above this gp value (default Infinity)
 * @param {boolean}  [filter.requireEligible] - default true; honor lootEligible flag
 * @returns {Array<object>} filtered subset (same item references, not cloned)
 */
export function filterCandidates(items, filter = {}) {
  if (!Array.isArray(items)) return [];
  const lootTypes = toSet(filter.lootTypes);
  const tiers = toSet(filter.tiers);
  const rarities = toSet(
    (filter.rarities ?? []).map(normalizeRarity).filter(Boolean),
  );
  const valueBands = toSet(filter.valueBands);
  const keywordsAny = toSet(filter.keywordsAny);
  const keywordsAll =
    filter.keywordsAll && filter.keywordsAll.length
      ? [...filter.keywordsAll]
      : null;
  const minGp = Number.isFinite(Number(filter.minGp))
    ? Number(filter.minGp)
    : 0;
  const maxGp = Number.isFinite(Number(filter.maxGp))
    ? Number(filter.maxGp)
    : Infinity;
  const requireEligible = filter.requireEligible !== false;

  const out = [];
  for (const item of items) {
    if (!item) continue;
    if (requireEligible && !isLootEligible(item)) continue;

    if (lootTypes.size > 0 && !lootTypes.has(getItemLootType(item))) continue;
    if (tiers.size > 0 && !tiers.has(getItemTier(item))) continue;
    if (rarities.size > 0 && !rarities.has(getItemRarity(item))) continue;
    if (valueBands.size > 0 && !valueBands.has(getItemValueBand(item)))
      continue;

    const gp = getItemGpValue(item);
    if (gp < minGp || gp > maxGp) continue;

    if (keywordsAny.size > 0 || keywordsAll) {
      const itemKeywords = new Set(getItemKeywords(item));
      if (keywordsAny.size > 0) {
        let anyHit = false;
        for (const tag of keywordsAny) {
          if (itemKeywords.has(tag)) {
            anyHit = true;
            break;
          }
        }
        if (!anyHit) continue;
      }
      if (keywordsAll) {
        let allHit = true;
        for (const tag of keywordsAll) {
          if (!itemKeywords.has(tag)) {
            allHit = false;
            break;
          }
        }
        if (!allHit) continue;
      }
    }
    out.push(item);
  }
  return out;
}

/**
 * Roll a loot bundle from the supplied candidate pool.
 *
 * Two modes governed by `opts.count`:
 *  - **auto (count = 0)**: keep drawing items until total gp lands in
 *    the budget window (default 85%–110% of budgetGp), hard-stopped
 *    by `maxCap` so a pathological pool can't spin forever.
 *  - **bounded (count > 0)**: cap at `count` distinct items, then
 *    trim the cheapest if we busted budget.
 *
 * Budget without count is the common case: the GM sets a target gp
 * value and the roller picks an organic mix of items to land near it.
 *
 * @param {Array<object>} candidates - output of filterCandidates
 * @param {object} opts
 * @param {number} [opts.count=0] - 0 = fill the budget, N>0 = hard item cap
 * @param {number} [opts.budgetGp] - target total gp; > 0 enables the fill loop
 * @param {number} [opts.maxCap=40] - safety ceiling on items in auto mode
 * @param {number} [opts.budgetLowFrac=0.85] - lower edge of the budget window
 * @param {number} [opts.budgetHighFrac=1.10] - upper edge (overshoot ok up to here)
 * @param {number} [opts.maxAttempts] - safety cap on draws; default 600
 * @param {() => number} [opts.rng] - injectable RNG. Default Math.random.
 * @returns {{ items, totalGp, budgetGp, droppedForBudget, warnings }}
 */
export function rollLoot(candidates, opts = {}) {
  const pool = Array.isArray(candidates) ? candidates.slice() : [];
  const requestedCount = Math.max(0, Math.floor(Number(opts.count ?? 0)));
  const budgetGp = Number(opts.budgetGp ?? 0);
  const budgetEnforced = Number.isFinite(budgetGp) && budgetGp > 0;
  const maxCap = Math.max(1, Math.floor(Number(opts.maxCap ?? 40)));
  const budgetLowFrac = clampFraction(opts.budgetLowFrac, 0.85);
  const budgetHighFrac = Math.max(
    budgetLowFrac,
    clampFraction(opts.budgetHighFrac, 1.1),
  );
  const maxAttempts = Math.max(
    200,
    Math.floor(Number(opts.maxAttempts ?? 600)),
  );
  const rng = typeof opts.rng === "function" ? opts.rng : Math.random;

  const warnings = [];
  if (pool.length === 0) {
    warnings.push("Candidate pool is empty — no items match the current filter.");
    return emptyResult(budgetEnforced ? budgetGp : 0, warnings);
  }

  // count=0 + no budget is the legacy "no-op" case — return empty.
  // We need either a count or a budget to know when to stop.
  if (requestedCount === 0 && !budgetEnforced) {
    return emptyResult(0, warnings);
  }

  // Effective cap on distinct items. Auto mode uses maxCap; bounded
  // mode uses the user's requested count.
  const hardCap = requestedCount > 0 ? requestedCount : maxCap;
  const fillBudget = requestedCount === 0 && budgetEnforced;
  const budgetTargetLow = fillBudget ? budgetGp * budgetLowFrac : 0;
  const budgetTargetHigh = fillBudget ? budgetGp * budgetHighFrac : Infinity;

  // Pass 1: weighted random draw, capped by hardCap. In fill mode we
  // also stop early as soon as the running total enters the budget
  // window — that's the "good enough" exit.
  const picked = new Map(); // _id → { item, quantity, gpValue }
  let runningTotal = 0;
  let attempts = 0;
  while (picked.size < hardCap && attempts < maxAttempts) {
    attempts += 1;
    const item = weightedPick(pool, rng);
    if (!item) break;
    const id = String(item._id ?? item.id ?? `anon-${attempts}`);
    const gpValue = getItemGpValue(item);
    const existing = picked.get(id);

    // In fill mode, skip picks that would blow past the high edge —
    // but only if we already have at least one item. (Otherwise a
    // huge budget on an expensive-only pool produces nothing.)
    if (
      fillBudget &&
      picked.size > 0 &&
      runningTotal + gpValue > budgetTargetHigh
    ) {
      continue;
    }

    if (!existing) {
      picked.set(id, { item, quantity: 1, gpValue });
      runningTotal += gpValue;
    } else {
      const maxQty = getItemMaxQty(item);
      if (existing.quantity < maxQty) {
        existing.quantity += 1;
        runningTotal += gpValue;
      }
    }

    if (fillBudget && runningTotal >= budgetTargetLow) break;
  }

  if (picked.size === 0) {
    warnings.push(
      `No items picked after ${attempts} attempts — pool size ${pool.length}, budget ${budgetEnforced ? budgetGp : "unbounded"}.`,
    );
  } else if (requestedCount > 0 && picked.size < requestedCount) {
    warnings.push(
      `Requested ${requestedCount} item(s) but the pool only produced ${picked.size} after ${attempts} attempts.`,
    );
  }

  let materialized = [...picked.values()].map(({ item, quantity, gpValue }) => ({
    item,
    quantity,
    gpValue,
    gpTotal: gpValue * quantity,
  }));

  let totalGp = materialized.reduce((acc, entry) => acc + entry.gpTotal, 0);
  let droppedForBudget = 0;

  // Pass 2: when count is bound (user set a number), trim if we busted
  // the budget. In auto mode the fill loop already kept us under the
  // high edge, so this rarely fires.
  if (budgetEnforced && totalGp > budgetGp && requestedCount > 0) {
    materialized.sort((a, b) => a.gpTotal - b.gpTotal);
    while (totalGp > budgetGp && materialized.length > 0) {
      const dropped = materialized.shift();
      totalGp -= dropped.gpTotal;
      droppedForBudget += 1;
    }
    if (droppedForBudget > 0) {
      warnings.push(
        `Dropped ${droppedForBudget} item(s) to fit gp budget of ${budgetGp}. Final total: ${totalGp} gp.`,
      );
    }
  }

  if (
    fillBudget &&
    totalGp > 0 &&
    totalGp < budgetTargetLow &&
    attempts >= maxAttempts
  ) {
    warnings.push(
      `Budget undershot: ${totalGp} gp / ${budgetGp} gp target after ${attempts} attempts. Try widening the rarity filter or raising the item cap.`,
    );
  }

  materialized.sort((a, b) => b.gpTotal - a.gpTotal);

  return {
    items: materialized,
    totalGp,
    budgetGp: budgetEnforced ? budgetGp : 0,
    droppedForBudget,
    warnings,
  };
}

function clampFraction(value, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return n;
}

/* ------------------------------------------------------------------ *
 * Helpers
 * ------------------------------------------------------------------ */

function emptyResult(budgetGp, warnings) {
  return { items: [], totalGp: 0, budgetGp, droppedForBudget: 0, warnings };
}

function toSet(values) {
  if (!Array.isArray(values) || values.length === 0) return new Set();
  const out = new Set();
  for (const value of values) {
    const trimmed = String(value ?? "").trim();
    if (trimmed) out.add(trimmed);
  }
  return out;
}

/**
 * Pick one item from `pool` weighted by its lootWeight tag.
 * Uses the standard inverse-CDF method.
 */
function weightedPick(pool, rng) {
  if (pool.length === 0) return null;
  let totalWeight = 0;
  for (const item of pool) {
    totalWeight += getItemLootWeight(item);
  }
  if (totalWeight <= 0) {
    // Fallback to uniform if every weight is zero/negative.
    const index = Math.floor(rng() * pool.length);
    return pool[Math.min(pool.length - 1, Math.max(0, index))];
  }
  const target = rng() * totalWeight;
  let cursor = 0;
  for (const item of pool) {
    cursor += getItemLootWeight(item);
    if (cursor >= target) return item;
  }
  return pool[pool.length - 1];
}

/** Re-export for convenience so the UI layer doesn't have to import two files. */
export { ELEVATED_RARITIES, RARITIES };
