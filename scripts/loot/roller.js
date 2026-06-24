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
  getItemMagicNature,
  getItemMaxQty,
  getItemRarity,
  getItemTier,
  getItemValueBand,
  isAmmunitionItem,
  isBareSpellLootItem,
  isLootEligible,
  isVariableTreasureBase,
  normalizeRarity,
} from "./tag-vocabulary.js";
import {
  createArtVariant,
  createArtVariantItemData,
  getVariableTreasureKind,
  isVariableArtItem,
} from "./art-variants.js";
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
    if (isBareSpellLootItem(item)) continue;
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

  // Pass 1: weighted random draw without replacement at the item level.
  const picked = new Map(); // _id → { item, quantity }
  let runningTotal = 0;
  let attempts = 0;
  let skippedForBudget = 0;
  while (picked.size < hardCap && attempts < maxAttempts) {
    attempts += 1;
    const item = weightedPick(drawPool, rng, magicBias, rarityWeights);
    if (!item) break;
    const id = String(item._id ?? item.id ?? `anon-${attempts}`);
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
      runningTotal += initialGpTotal;
      if (fillBudget && runningTotal >= budgetTargetLow) break;
      continue;
    }
    const existing = picked.get(id);
    const maxQty = getItemMaxQty(item);
    if (existing.quantity < maxQty && runningTotal + gpValue <= budgetCeil) {
      existing.quantity += 1;
      runningTotal += gpValue;
    }

    if (fillBudget && runningTotal >= budgetTargetLow) break;
  }

  if (picked.size === 0) {
    warnings.push(
      `No items picked after ${attempts} attempts - pool size ${pool.length}, budget ${budgetEnforced ? budgetGp : "unbounded"}.`,
    );
  } else if (requestedCount > 0 && picked.size < requestedCount) {
    const reason =
      skippedForBudget > 0
        ? `the ${budgetGp} gp budget had room for only ${picked.size}`
        : `the pool only produced ${picked.size} after ${attempts} attempts`;
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
    artVariants: opts.artVariants === true,
    rng: opts.rng,
  });
  return raw.items[0] ?? null;
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
  return String(item?.uuid ?? item?._id ?? item?.id ?? "");
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

function matchesLootTypes(item, lootTypes) {
  const directType = getItemLootType(item);
  if (directType && lootTypes.has(directType)) return true;

  const keywords = new Set(getItemKeywords(item));
  for (const lootType of lootTypes) {
    if (keywords.has(lootType)) return true;
  }

  if (lootTypes.has("loot.art") && isVariableArtItem(item)) return true;
  if (lootTypes.has("loot.gem") && isVariableGemItem(item)) return true;
  // Synthetic "Ammunition" chip: arrows/bolts/bullets ship as loot.consumable,
  // so match them through the dedicated ammo predicate instead of a lootType.
  if (lootTypes.has("loot.ammunition") && isAmmunitionItem(item)) return true;
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

export function isVariableGemItem(item) {
  // Gate on a real mundane-treasure base first: magic items such as "Pearl of
  // Power" and "Gem of Seeing" carry `treasure.gem` / `variableTreasureKind:
  // gem` tags copied from their flavor, but they are consumables — not gems —
  // and must not surface on the Gem chip. (isVariableArtItem applies the same
  // gate; see tag-vocabulary.isVariableTreasureBase.)
  if (!isVariableTreasureBase(item)) return false;

  const kind = getVariableTreasureKind(item);
  if (kind === "gem") return true;
  if (kind && kind !== "gem") return false;

  const keywords = new Set(getItemKeywords(item));
  return (
    keywords.has("treasure.gem") ||
    keywords.has("loot.variable.gem") ||
    keywords.has("merchant.gem")
  );
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
 * Pick one item from `pool` weighted by its lootWeight tag, optionally
 * skewed by the Magic Bias dial. Uses the standard inverse-CDF method.
 *
 * @param {Array<object>} pool
 * @param {() => number} rng
 * @param {number} magicBias - clamped to [-1, 1]
 * @param {Record<string, number>} rarityWeights
 */
function weightedPick(pool, rng, magicBias = 0, rarityWeights = null) {
  if (pool.length === 0) return null;
  const weights = pool.map((item) =>
    effectiveWeight(item, magicBias, rarityWeights),
  );
  let totalWeight = 0;
  for (const weight of weights) totalWeight += weight;
  if (totalWeight <= 0) {
    // Bias zeroed out everything (e.g. bias=+1 against an all-mundane pool).
    // Fall back to uniform so the roller still produces something.
    const index = Math.floor(rng() * pool.length);
    return pool[Math.min(pool.length - 1, Math.max(0, index))];
  }
  const target = rng() * totalWeight;
  let cursor = 0;
  for (let i = 0; i < pool.length; i += 1) {
    cursor += weights[i];
    // Require a positive weight: when rng() returns exactly 0 (a legal
    // Math.random() value) target is 0, and a zero-weight item at index 0 would
    // otherwise satisfy `cursor >= target` and be drawn despite being suppressed
    // (rarity weight 0, or the losing side of a ±1 magic bias).
    if (weights[i] > 0 && cursor >= target) return pool[i];
  }
  return pool[pool.length - 1];
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
export { ELEVATED_RARITIES, RARITIES };
