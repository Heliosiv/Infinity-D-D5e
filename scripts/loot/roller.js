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
  getItemLootWeight,
  getItemMagicNature,
  getItemMaxQty,
  getItemRarity,
  getItemTier,
  getItemValueBand,
  isAmmunitionItem,
  isBareSpellLootItem,
  isGenericSpellScrollItem,
  isLootEligible,
  normalizeRarity,
} from "./tag-vocabulary.js";
import {
  createArtVariant,
  createArtVariantItemData,
  isVariableArtItem,
} from "./art-variants.js";
import { normalizeInfinityItemUuid } from "../item-uuid-compat.js";
import {
  getItemLootCategories,
  getItemRollCategory,
  isVariableGemItem,
} from "./item-categories.js";
import {
  normalizeRarityWeights,
  rarityWeightForRarity,
} from "./rarity-balance.js";

const VARIABLE_TREASURE_RARITY_BY_VALUE_BAND = Object.freeze({
  v1: "common",
  v2: "common",
  v3: "uncommon",
  v4: "rare",
  v5: "very-rare",
});

/** Magic Bias slider bounds — exported so the UI and tests share one source. */
export const MAGIC_BIAS_RANGE = Object.freeze({
  min: -1,
  max: 1,
  step: 0.05,
});

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
    if (isBareSpellLootItem(item) || isGenericSpellScrollItem(item)) continue;
    if (requireEligible && !isLootEligible(item)) continue;

    if (lootTypes.size > 0 && !matchesLootTypes(item, lootTypes)) continue;
    if (tiers.size > 0 && !tiers.has(getItemTier(item))) continue;
    if (rarities.size > 0 && !matchesRarities(item, rarities)) continue;
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
 * - auto (`count = 0`): keep drawing items until total gp lands in the budget
 *   window, capped by `maxCap` and `maxAttempts`.
 * - bounded (`count > 0`): cap at that many distinct items, then trim to budget.
 *
 * @param {Array<object>} candidates - output of filterCandidates
 * @param {object} opts
 * @param {number} [opts.count=0] - 0 = fill budget, N>0 = hard distinct-item cap
 * @param {number} [opts.budgetGp] - if > 0, enables budget targeting/enforcement
 * @param {number} [opts.maxCap=40] - safety ceiling on distinct items in auto mode
 * @param {number} [opts.budgetLowFrac=0.85] - lower edge of the budget window
 * @param {number} [opts.budgetHighFrac=1.10] - upper edge of the budget window
 * @param {number} [opts.magicBias] - in [-1, 1]. >0 favors magic items, <0 favors mundane.
 *                                    Applied as a per-item weight multiplier; ±1 zeroes
 *                                    out the opposite side entirely.
 * @param {Record<string, number>} [opts.rarityWeights] - per-rarity probability multipliers.
 * @param {Record<string, number>} [opts.categoryWeights] - enables category-first selection.
 * @param {Record<string, number>} [opts.categoryCaps] - maximum distinct results by category.
 * @param {number} [opts.categoryRepeatPenalty=1] - multiplier for each prior category hit.
 * @param {Record<string, number>} [opts.initialCategoryCounts] - categories already in the bundle.
 * @param {number} [opts.maxAttempts] - safety cap to prevent infinite loops; default 600
 * @param {boolean} [opts.artVariants] - generate specific art-object names and appraisal notes
 * @param {() => number} [opts.rng] - injectable RNG (returns [0, 1)). Default Math.random.
 * @returns {{ items: Array<{ item: object, quantity: number, gpValue: number, gpTotal: number, displayName?: string, valueLabel?: string, variant?: object|null, itemData?: object|null }>,
 *             totalGp: number,
 *             budgetGp: number,
 *             droppedForBudget: number,
 *             warnings: string[] }}
 */
export function rollLoot(candidates, opts = {}) {
  const pool = Array.isArray(candidates) ? candidates.slice() : [];
  const requestedCount = Math.max(0, Math.floor(Number(opts.count ?? 0)));
  const budgetGp = Number(opts.budgetGp ?? 0);
  const budgetEnforced = Number.isFinite(budgetGp) && budgetGp > 0;
  const magicBias = clampBias(opts.magicBias);
  const rarityWeights = normalizeRarityWeights(opts.rarityWeights);
  const categoryWeights = normalizeWeightRecord(opts.categoryWeights);
  const categoryCaps = normalizeCountRecord(opts.categoryCaps);
  const categoryRepeatPenalty = clampRepeatPenalty(opts.categoryRepeatPenalty);
  const categoryCounts = new Map(
    Object.entries(normalizeCountRecord(opts.initialCategoryCounts)),
  );
  const categoryFirst = Object.keys(categoryWeights).length > 0;
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
  const artVariants = opts.artVariants === true;

  const warnings = [];
  if (pool.length === 0) {
    warnings.push(
      "Candidate pool is empty - no items match the current filter.",
    );
    return emptyResult(budgetEnforced ? budgetGp : 0, warnings);
  }
  if (requestedCount === 0 && !budgetEnforced) {
    return emptyResult(0, warnings);
  }

  const hardCap = requestedCount > 0 ? requestedCount : maxCap;
  const fillBudget = requestedCount === 0 && budgetEnforced;
  const budgetTargetLow = fillBudget ? budgetGp * budgetLowFrac : 0;
  // Per-pick budget ceiling. Applies in BOTH bounded-count and fill modes
  // whenever a budget is set: never add an item that pushes the running total
  // past the budget window. The very first pick is always allowed, so even a
  // tiny budget yields one item rather than an empty bundle.
  // (Regression guard: a bounded `count` used to ignore the budget here, and
  // Pass 2 then trimmed the cheapest picks down to near-empty.)
  const budgetCeil = budgetEnforced ? budgetGp * budgetHighFrac : Infinity;

  // Restrict picks to items that individually fit within the budget ceiling.
  // Without this, the first pick is always accepted (so it doesn't return
  // empty) but a 160 gp Per-Creature budget against a pool dominated by
  // 1,000+ gp uncommons reliably picks one massive item and rejects every
  // follow-up — producing single-item bundles 10× over budget. Pre-filtering
  // here keeps picks honest in the common case; the fallback below preserves
  // the one-item-over-budget safety when nothing affordable exists.
  const affordablePool = budgetEnforced
    ? pool.filter((item) => getItemGpValue(item) <= budgetCeil)
    : pool;
  const drawPool = affordablePool.length > 0 ? affordablePool : pool;
  const identityByItem = new Map(
    drawPool.map((item, index) => [
      item,
      itemIdentity(item) || `anonymous-candidate-${index}`,
    ]),
  );

  // Pass 1: weighted random draw without replacement at the item level.
  // Rebuild the active picker after each accepted item so maxed-out source
  // documents and items that no longer fit the remaining budget cannot keep
  // consuming attempts or distort the next accepted-item odds.
  const picked = new Map(); // _id → { item, quantity }
  let resultLineCount = 0;
  let runningTotal = 0;
  let attempts = 0;
  let skippedForBudget = 0;
  let stoppedForBudget = false;
  while (resultLineCount < hardCap && attempts < maxAttempts) {
    attempts += 1;
    const activePool = drawPool.filter((item) =>
      canDrawItem(item, {
        budgetCeil,
        identityByItem,
        picked,
        runningTotal,
      }),
    );
    if (activePool.length === 0) {
      stoppedForBudget =
        budgetEnforced &&
        drawPool.some((item) =>
          canDrawItem(item, {
            budgetCeil: Infinity,
            identityByItem,
            picked,
            runningTotal,
          }),
        );
      break;
    }
    const picker = categoryFirst
      ? buildCategoryWeightedPicker(
          activePool,
          categoryWeights,
          magicBias,
          rarityWeights,
        )
      : buildWeightedPicker(activePool, magicBias, rarityWeights);
    const item = categoryFirst
      ? categoryWeightedPick(picker, {
          categoryCaps,
          categoryCounts,
          repeatPenalty: categoryRepeatPenalty,
          rng,
        })
      : weightedPick(picker, rng);
    if (!item) break;
    const id = identityByItem.get(item);
    const gpValue = getItemGpValue(item);

    if (!picked.has(id)) {
      const initialQuantity = rollInitialQuantity(item, {
        budgetCeil,
        gpValue,
        rng,
        runningTotal,
      });
      const initialGpTotal = gpValue * initialQuantity;
      if (picked.size > 0 && runningTotal + initialGpTotal > budgetCeil) {
        skippedForBudget += 1;
        continue;
      }
      picked.set(id, { item, quantity: initialQuantity });
      resultLineCount += isVariableArtItem(item) ? initialQuantity : 1;
      const category = getItemRollCategory(item);
      if (category) {
        categoryCounts.set(category, (categoryCounts.get(category) ?? 0) + 1);
      }
      runningTotal += initialGpTotal;
      if (fillBudget && runningTotal >= budgetTargetLow) break;
      continue;
    }
    const existing = picked.get(id);
    const maxQty = isRepeatableRollItem(item) ? getItemMaxQty(item) : 1;
    if (existing.quantity < maxQty && runningTotal + gpValue <= budgetCeil) {
      existing.quantity += 1;
      runningTotal += gpValue;
      if (isVariableArtItem(item)) {
        resultLineCount += 1;
        const category = getItemRollCategory(item);
        if (category) {
          categoryCounts.set(category, (categoryCounts.get(category) ?? 0) + 1);
        }
      }
    }

    if (fillBudget && runningTotal >= budgetTargetLow) break;
  }

  if (picked.size === 0) {
    warnings.push(
      `No items picked after ${attempts} attempts - pool size ${pool.length}, budget ${budgetEnforced ? budgetGp : "unbounded"}.`,
    );
  } else if (requestedCount > 0 && resultLineCount < requestedCount) {
    const reason =
      skippedForBudget > 0 || stoppedForBudget
        ? `the ${budgetGp} gp budget had room for only ${resultLineCount}`
        : `the pool only produced ${resultLineCount} after ${attempts} attempts`;
    warnings.push(
      `Requested ${requestedCount} item(s) but ${reason}. Widen the rarity filter, raise the budget, or lower the item count.`,
    );
  } else if (fillBudget && runningTotal < budgetTargetLow) {
    warnings.push(
      `Budget undershot: ${runningTotal} gp / ${budgetGp} gp target after ${attempts} attempts. Try widening the rarity filter or raising the item cap.`,
    );
  }

  // Materialize the picks with gp totals.
  let materialized = [...picked.values()].flatMap(({ item, quantity }) =>
    materializeLootEntry(item, quantity, { artVariants, rng }),
  );

  let totalGp = materialized.reduce((acc, entry) => acc + entry.gpTotal, 0);
  let droppedForBudget = 0;

  // Pass 2: budget enforcement — drop cheapest entries until within budget.
  // (Cheapest first because a $50,000 legendary should not be sacrificed
  // for two $5 daggers; tone-of-bundle matters more than count.)
  if (budgetEnforced && totalGp > budgetGp) {
    materialized.sort((a, b) => a.gpTotal - b.gpTotal);
    // Keep at least one item — an empty haul is useless. If even the single
    // cheapest match exceeds the budget we keep it and warn instead.
    while (totalGp > budgetGp && materialized.length > 1) {
      const dropped = materialized.shift();
      totalGp -= dropped.gpTotal;
      droppedForBudget += 1;
    }
    if (droppedForBudget > 0) {
      warnings.push(
        `Dropped ${droppedForBudget} item(s) to fit gp budget of ${budgetGp}. Final total: ${totalGp} gp.`,
      );
    }
    if (totalGp > budgetGp) {
      warnings.push(
        `Kept one item at ${totalGp} gp over the ${budgetGp} gp budget — no cheaper match was available. Widen the rarity filter or raise the budget.`,
      );
    }
  }

  // Re-sort the final list by gp descending so the marquee items
  // surface first in the UI.
  materialized.sort((a, b) => b.gpTotal - a.gpTotal);

  return {
    items: materialized,
    totalGp,
    budgetGp: budgetEnforced ? budgetGp : 0,
    droppedForBudget,
    warnings,
  };
}

/**
 * Roll a single replacement item — the engine behind "re-roll just this
 * one". Excludes every item already on the table (so the swap can't
 * duplicate an existing pick) and rolls one item against the budget
 * freed by the slot being replaced. Returns the decorated entry or
 * `null` when nothing affordable/available remains (caller keeps the
 * old item).
 *
 * @param {Array<object>} candidates - same pool filterCandidates returns
 * @param {object} [opts]
 * @param {Set<string>|string[]} [opts.excludeIds] - item ids already on the table
 * @param {number} [opts.budgetGp] - gp freed by the replaced slot
 * @param {number} [opts.magicBias]
 * @param {Record<string, number>} [opts.rarityWeights]
 * @param {Record<string, number>} [opts.categoryWeights]
 * @param {Record<string, number>} [opts.categoryCaps]
 * @param {number} [opts.categoryRepeatPenalty]
 * @param {Record<string, number>} [opts.initialCategoryCounts]
 * @param {boolean} [opts.artVariants]
 * @param {() => number} [opts.rng]
 * @returns {object|null}
 */
export function rerollOne(candidates, opts = {}) {
  const exclude =
    opts.excludeIds instanceof Set
      ? opts.excludeIds
      : new Set(opts.excludeIds ?? []);
  const pool = (Array.isArray(candidates) ? candidates : []).filter(
    (item) => !exclude.has(itemIdentity(item)),
  );
  if (pool.length === 0) return null;
  const budgetGp = Number(opts.budgetGp ?? 0);
  const raw = rollLoot(pool, {
    count: 1,
    budgetGp: budgetGp > 0 ? budgetGp : 0,
    magicBias: opts.magicBias,
    rarityWeights: opts.rarityWeights,
    categoryWeights: opts.categoryWeights,
    categoryCaps: opts.categoryCaps,
    categoryRepeatPenalty: opts.categoryRepeatPenalty,
    initialCategoryCounts: opts.initialCategoryCounts,
    artVariants: opts.artVariants === true,
    rng: opts.rng,
  });
  return raw.items[0] ?? null;
}

/**
 * Exact probability breakdown for the next accepted item at the start of a
 * roll. Bundle-level odds vary as the budget fills and diversity penalties
 * change, so callers should label this as a next-item chance.
 *
 * @param {Array<object>} candidates
 * @param {object} [opts] - the same probability and budget options as rollLoot
 * @returns {{ candidateCount: number, affordableCandidateCount: number,
 *             selectableCandidateCount: number, usedOverBudgetFallback: boolean,
 *             available: boolean,
 *             categories: Array<{key: string, probability: number}>,
 *             rarities: Array<{key: string, probability: number}>,
 *             magicNatures: Array<{key: string, probability: number}> }}
 */
export function estimateLootChances(candidates, opts = {}) {
  const pool = Array.isArray(candidates) ? candidates.slice() : [];
  const budgetGp = Number(opts.budgetGp ?? 0);
  const budgetEnforced = Number.isFinite(budgetGp) && budgetGp > 0;
  const budgetLowFrac = clampFraction(opts.budgetLowFrac, 0.85);
  const budgetHighFrac = Math.max(
    budgetLowFrac,
    clampFraction(opts.budgetHighFrac, 1.1),
  );
  const budgetCeil = budgetEnforced ? budgetGp * budgetHighFrac : Infinity;
  const affordablePool = budgetEnforced
    ? pool.filter((item) => getItemGpValue(item) <= budgetCeil)
    : pool;
  const drawPool = affordablePool.length > 0 ? affordablePool : pool;
  const usedOverBudgetFallback =
    budgetEnforced && pool.length > 0 && affordablePool.length === 0;
  const magicBias = clampBias(opts.magicBias);
  const rarityWeights = normalizeRarityWeights(opts.rarityWeights);
  const categoryWeights = normalizeWeightRecord(opts.categoryWeights);
  const categoryCaps = normalizeCountRecord(opts.categoryCaps);
  const categoryCounts = new Map(
    Object.entries(normalizeCountRecord(opts.initialCategoryCounts)),
  );
  const repeatPenalty = clampRepeatPenalty(opts.categoryRepeatPenalty);
  const itemProbabilities = [];

  if (Object.keys(categoryWeights).length > 0) {
    const picker = buildCategoryWeightedPicker(
      drawPool,
      categoryWeights,
      magicBias,
      rarityWeights,
    );
    const categoryEntries = selectableCategoryEntries(picker, {
      categoryCaps,
      categoryCounts,
      repeatPenalty,
    });
    const totalCategoryWeight = categoryEntries.reduce(
      (sum, entry) => sum + entry.weight,
      0,
    );
    if (totalCategoryWeight > 0) {
      for (const { group, weight } of categoryEntries) {
        const categoryProbability = weight / totalCategoryWeight;
        for (let index = 0; index < group.itemPicker.pool.length; index += 1) {
          const itemWeight = group.itemPicker.weights[index];
          if (itemWeight <= 0 || group.itemPicker.totalWeight <= 0) continue;
          itemProbabilities.push({
            item: group.itemPicker.pool[index],
            probability:
              categoryProbability * (itemWeight / group.itemPicker.totalWeight),
          });
        }
      }
    }
  } else {
    const picker = buildWeightedPicker(drawPool, magicBias, rarityWeights);
    if (picker.totalWeight > 0) {
      for (let index = 0; index < picker.pool.length; index += 1) {
        const weight = picker.weights[index];
        if (weight <= 0) continue;
        itemProbabilities.push({
          item: picker.pool[index],
          probability: weight / picker.totalWeight,
        });
      }
    }
  }

  const selectableCandidateCount = itemProbabilities.length;
  return {
    candidateCount: selectableCandidateCount,
    affordableCandidateCount: affordablePool.length,
    selectableCandidateCount,
    usedOverBudgetFallback,
    available: itemProbabilities.length > 0,
    categories: aggregateChances(itemProbabilities, getItemRollCategory),
    rarities: aggregateChances(itemProbabilities, getEffectiveRarity),
    magicNatures: aggregateChances(itemProbabilities, getItemMagicNature),
  };
}

function clampFraction(raw, fallback) {
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) return fallback;
  return Math.max(0.01, value);
}

/**
 * Stable identity for an item used by reroll de-duplication. Prefers `uuid`
 * because history storage (`slimResult`) drops `_id`/`id` down to `{uuid, name,
 * img}` — keying on `_id` alone collapses every history-restored entry to "",
 * silently disabling dedup so a reroll could re-draw an item already on the
 * table. Falls back to `_id`/`id` for raw fixtures / items without a uuid.
 */
export function itemIdentity(item) {
  return normalizeInfinityItemUuid(item?.uuid ?? item?._id ?? item?.id ?? "");
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

function normalizeWeightRecord(raw) {
  const out = Object.create(null);
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return out;
  for (const [rawKey, rawValue] of Object.entries(raw)) {
    const key = String(rawKey ?? "").trim();
    const value = Number(rawValue);
    if (!key || !Number.isFinite(value) || value < 0) continue;
    out[key] = value;
  }
  return out;
}

function normalizeCountRecord(raw) {
  const out = Object.create(null);
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return out;
  for (const [rawKey, rawValue] of Object.entries(raw)) {
    const key = String(rawKey ?? "").trim();
    const value = Number(rawValue);
    if (!key || !Number.isFinite(value) || value < 0) continue;
    out[key] = Math.min(Number.MAX_SAFE_INTEGER, Math.floor(value));
  }
  return out;
}

function clampRepeatPenalty(raw) {
  if (raw === undefined || raw === null || raw === "") return 1;
  const value = Number(raw);
  if (!Number.isFinite(value)) return 1;
  return Math.max(0, Math.min(1, value));
}

function aggregateChances(itemProbabilities, keyForItem) {
  const totals = new Map();
  for (const { item, probability } of itemProbabilities) {
    const key = String(keyForItem(item) ?? "").trim();
    if (!key || !Number.isFinite(probability) || probability <= 0) continue;
    totals.set(key, (totals.get(key) ?? 0) + probability);
  }
  return [...totals.entries()]
    .map(([key, probability]) => ({ key, probability }))
    .sort(
      (a, b) => b.probability - a.probability || a.key.localeCompare(b.key),
    );
}

function matchesLootTypes(item, lootTypes) {
  const categories = getItemLootCategories(item);
  for (const lootType of lootTypes) {
    if (categories.has(lootType)) return true;
  }
  return false;
}

/**
 * Effective rarity used for both filtering and chip counts:
 *   - an explicit normalized rarity when the item carries one;
 *   - for variable art/gem treasure, the rarity implied by its gp value band;
 *   - otherwise "common" — untagged mundane gear and sundries floor to common
 *     so a Common→Artifact selection always surfaces them.
 *
 * NB: a handful of genuinely-magic items the source left un-rarited (e.g. a
 * Wand of Magic Missiles tagged loot.consumable) also floor to common here.
 * That keeps them reachable; assigning their true rarity is a separate
 * per-item data-tagging task.
 */
export function getEffectiveRarity(item) {
  const direct = getItemRarity(item);
  if (direct) return direct;
  if (isVariableArtItem(item) || isVariableGemItem(item)) {
    return (
      VARIABLE_TREASURE_RARITY_BY_VALUE_BAND[getItemValueBand(item)] ?? "common"
    );
  }
  return "common";
}

function matchesRarities(item, rarities) {
  return rarities.has(getEffectiveRarity(item));
}

function materializeLootEntry(item, quantity, { artVariants, rng }) {
  const safeQuantity = Math.max(1, Math.floor(Number(quantity) || 1));
  if (artVariants && isVariableArtItem(item)) {
    const entries = [];
    for (let index = 0; index < safeQuantity; index += 1) {
      const variant = createArtVariant(item, { rng });
      entries.push({
        item,
        quantity: 1,
        gpValue: variant.gpValue,
        gpTotal: variant.gpValue,
        displayName: variant.displayName,
        valueLabel: variant.valueLabel,
        variant,
        itemData: createArtVariantItemData(item, variant, { quantity: 1 }),
      });
    }
    return entries;
  }

  const gpValue = getItemGpValue(item);
  return [
    {
      item,
      quantity: safeQuantity,
      gpValue,
      gpTotal: gpValue * safeQuantity,
      displayName: item?.name ?? "",
      valueLabel: "",
      variant: null,
      itemData: null,
    },
  ];
}

/**
 * Precompute the constant weighted-draw state for a pool: each item's
 * effective weight, the running cumulative-sum (CDF), and the total
 * weight. `magicBias` / `rarityWeights` are fixed for a whole roll, so
 * this runs once and every {@link weightedPick} draw binary-searches the
 * CDF in O(log n) rather than rebuilding + summing the pool each attempt.
 *
 * The CDF is accumulated left-to-right in the same order the old linear
 * scan summed `cursor`, so `cdf[i]` is bit-identical to that scan's
 * running total at index `i` — the binary search returns the same index
 * for any given target, keeping seeded-RNG draws byte-identical.
 *
 * @param {Array<object>} pool
 * @param {number} magicBias - clamped to [-1, 1]
 * @param {Record<string, number>} rarityWeights
 * @returns {{ pool: Array<object>, weights: number[], cdf: number[], totalWeight: number }}
 */
function buildWeightedPicker(pool, magicBias = 0, rarityWeights = null) {
  const weights = new Array(pool.length);
  const cdf = new Array(pool.length);
  let totalWeight = 0;
  for (let i = 0; i < pool.length; i += 1) {
    const weight = effectiveWeight(pool[i], magicBias, rarityWeights);
    weights[i] = weight;
    totalWeight += weight;
    cdf[i] = totalWeight;
  }
  return { pool, weights, cdf, totalWeight };
}

/**
 * Build one item picker per primary category. The configured category weight
 * remains independent of pool cardinality; the category's average magic
 * multiplier lets Magic Bias shift the top-level category draw exactly once.
 */
function buildCategoryWeightedPicker(
  pool,
  categoryWeights,
  magicBias,
  rarityWeights,
) {
  const itemsByCategory = new Map();
  for (const item of pool) {
    const category = getItemRollCategory(item);
    if (!category) continue;
    if (!itemsByCategory.has(category)) itemsByCategory.set(category, []);
    itemsByCategory.get(category).push(item);
  }

  const groups = [];
  for (const [category, items] of itemsByCategory) {
    const configuredWeight = Number(categoryWeights[category] ?? 0);
    if (!Number.isFinite(configuredWeight) || configuredWeight <= 0) continue;
    const itemPicker = buildWeightedPicker(items, magicBias, rarityWeights);
    const neutralPicker = buildWeightedPicker(items, 0, rarityWeights);
    if (itemPicker.totalWeight <= 0 || neutralPicker.totalWeight <= 0) continue;
    groups.push({
      category,
      configuredWeight,
      magicFactor: itemPicker.totalWeight / neutralPicker.totalWeight,
      itemPicker,
    });
  }
  return { groups };
}

function selectableCategoryEntries(
  picker,
  { categoryCaps, categoryCounts, repeatPenalty },
) {
  const entries = [];
  for (const group of picker.groups) {
    const count = Number(categoryCounts.get(group.category) ?? 0);
    const cap = categoryCaps[group.category];
    if (Number.isFinite(cap) && count >= cap) continue;
    const diversityMultiplier = count > 0 ? Math.pow(repeatPenalty, count) : 1;
    const weight =
      group.configuredWeight * group.magicFactor * diversityMultiplier;
    if (Number.isFinite(weight) && weight > 0) entries.push({ group, weight });
  }
  return entries;
}

function categoryWeightedPick(
  picker,
  { categoryCaps, categoryCounts, repeatPenalty, rng },
) {
  const entries = selectableCategoryEntries(picker, {
    categoryCaps,
    categoryCounts,
    repeatPenalty,
  });
  const totalWeight = entries.reduce((sum, entry) => sum + entry.weight, 0);
  if (totalWeight <= 0) return null;

  const target = rng() * totalWeight;
  let cursor = 0;
  let selected = entries.at(-1);
  for (const entry of entries) {
    cursor += entry.weight;
    if (cursor >= target) {
      selected = entry;
      break;
    }
  }
  return selected ? weightedPick(selected.group.itemPicker, rng) : null;
}

/**
 * Pick one item from a precomputed picker via the standard inverse-CDF
 * method. Consumes exactly one `rng()` value per successful call.
 *
 * @param {{ pool: Array<object>, cdf: number[], totalWeight: number }} picker
 * @param {() => number} rng
 */
function weightedPick(picker, rng) {
  const { pool, cdf, totalWeight } = picker;
  if (pool.length === 0) return null;
  if (totalWeight <= 0) {
    // Legacy (non-category-first) callers retain their historical fallback.
    // Category-first groups with no positive mass are removed before this
    // point, so hard Magic Bias endpoints remain strict for encounter rolls.
    const index = Math.floor(rng() * pool.length);
    return pool[Math.min(pool.length - 1, Math.max(0, index))];
  }
  const target = rng() * totalWeight;
  // First index whose cumulative weight reaches `target` — the same item
  // the old linear scan returned (`cursor >= target`), found by binary
  // search. Floating-point overshoot falls through to the last item.
  let lo = 0;
  let hi = pool.length - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (cdf[mid] >= target) hi = mid;
    else lo = mid + 1;
  }
  // When rng() returns exactly 0 (a legal Math.random() value) target is 0, so
  // the search lands on index 0 even if it carries no mass (cdf[0] === 0 for a
  // zero-weight leading item — rarity weight 0, or the losing side of a ±1 magic
  // bias). Skip forward to the first item with positive cumulative weight so a
  // suppressed item is never drawn. totalWeight > 0 here, so this terminates.
  while (cdf[lo] <= 0 && lo < pool.length - 1) lo += 1;
  return pool[lo];
}

function canDrawItem(
  item,
  { budgetCeil, identityByItem, picked, runningTotal },
) {
  const id = identityByItem.get(item);
  const existing = picked.get(id);
  const gpValue = getItemGpValue(item);
  const remainingBudget = budgetCeil - runningTotal;

  if (!existing) {
    // The first result retains the documented one-item-over-budget fallback
    // when the complete pool contains nothing affordable.
    return picked.size === 0 || gpValue <= remainingBudget;
  }
  if (!isRepeatableRollItem(item)) return false;
  if (existing.quantity >= getItemMaxQty(item)) return false;
  return gpValue <= remainingBudget;
}

function isRepeatableRollItem(item) {
  return isAmmunitionItem(item) || isVariableArtItem(item);
}

function rollInitialQuantity(item, { budgetCeil, gpValue, rng, runningTotal }) {
  const maxQty = getItemMaxQty(item);
  if (maxQty <= 1 || !isAmmunitionItem(item)) return 1;

  let cappedMax = maxQty;
  if (Number.isFinite(budgetCeil) && gpValue > 0) {
    const remainingBudget = Math.max(0, budgetCeil - runningTotal);
    const affordableQty = Math.floor(remainingBudget / gpValue);
    cappedMax = Math.min(cappedMax, Math.max(1, affordableQty));
  }

  if (cappedMax <= 1) return 1;
  const roll = Math.floor(rng() * cappedMax) + 1;
  return Math.max(1, Math.min(cappedMax, roll));
}

/**
 * Apply the Magic Bias multiplier to an item's base loot weight.
 * - bias > 0: magic items scaled by (1 + bias), mundane by (1 - bias)
 * - bias < 0: mirror — mundane up, magic down
 * - neutral items always unchanged
 * - clamped at 0 so we never produce negative weights
 */
function effectiveWeight(item, magicBias, rarityWeights) {
  const rarityMultiplier = rarityWeightForRarity(
    getEffectiveRarity(item),
    rarityWeights,
  );
  const base = getItemLootWeight(item) * rarityMultiplier;
  if (!magicBias) return Math.max(0, base);
  const nature = getItemMagicNature(item);
  if (nature === "magic") return Math.max(0, base * (1 + magicBias));
  if (nature === "mundane") return Math.max(0, base * (1 - magicBias));
  return Math.max(0, base);
}

function clampBias(raw) {
  const value = Number(raw);
  if (!Number.isFinite(value)) return 0;
  return Math.max(-1, Math.min(1, value));
}

/** Re-export for convenience so the UI layer doesn't have to import two files. */
export { ELEVATED_RARITIES, RARITIES, isVariableGemItem };
