/**
 * Infinity D&D5e — HoardLootApp
 *
 * GM-only window for rolling a treasure cache. A "hoard" is a single
 * pile (a chest, a dragon's stash, a defeated boss's stockpile), so the
 * gp budget is driven by *tier × scale*, not by a creature count. The
 * pile-bias slider splits the budget between a raw coin pile and the
 * item bundle.
 *
 * Extends {@link BaseLootApp} for the shared lifecycle; this file owns
 * the hoard-specific context, coin-pile split, and generation.
 */

import {
  HOARD_DEFAULT_ITEM_CEILING,
  HOARD_SCALE_PRESETS,
  PILE_BIAS_PRESETS,
  PILE_BIAS_RANGE,
  coinDenominationBreakdown,
  computeHoardBudget,
  formatCoinBreakdown,
  getDefaultRarities,
  getScaleFlavor,
  splitCoinPile,
} from "./loot/hoard-budget.js";
import { promptDistributeItems } from "./loot/distribute.js";
import { SOUND_EVENTS, playModuleSound, playResultSound } from "./audio.js";
import {
  computePackStats,
  computeTierFilteredStats,
} from "./loot/pack-stats.js";
import { MAGIC_BIAS_RANGE, filterCandidates, rollLoot } from "./loot/roller.js";
import {
  LOOT_TYPES,
  RARITIES,
  TIERS,
  isAmmunitionItem,
  tierWindow,
} from "./loot/tag-vocabulary.js";
import {
  RARITY_BALANCE_CUSTOM_KEY,
  RARITY_BALANCE_DEFAULT_KEY,
  clampRarityWeight,
  getRarityBalancePresetWeights,
  normalizeRarityBalanceKey,
  rarityBalanceOptions,
  rarityWeightRows,
  resolveRarityWeights,
} from "./loot/rarity-balance.js";
import { SETTING_KEYS, getSetting } from "./settings.js";
import { BaseLootApp } from "./loot/loot-app-base.js";
import {
  humanizeKey,
  resultImageForEntry,
  sameSet,
  setText,
  tierLabel,
  toDistributableEntry,
} from "./loot/loot-app-shared.js";
import {
  clampFloat,
  clampInt,
  escapeHtml,
  formatGp,
  formatMagicBias,
  formatMultiplier,
  prettyLootType,
  prettyRarity,
} from "./ui-util.js";

const MODULE_ID = "infinity-dnd5e";
const TEMPLATE_PATH = `modules/${MODULE_ID}/templates/hoard-loot.hbs`;

const MAX_ITEMS_RANGE = Object.freeze({ min: 0, max: 30 });

const SLIDER_LABELS = Object.freeze({
  pileBias: "Coin vs. Items",
  magicBias: "Magic vs. Mundane",
});

const SCALE_ORDER = Object.freeze(["small", "standard", "large", "massive"]);

export class HoardLootApp extends BaseLootApp {
  static _instance = null;
  static _persistedState = null;

  static FORM_NAME = "hoard-loot";
  static TOOL_ID = "hoard-loot";
  static CHAT_ALIAS = "Hoard Loot";
  static SLIDER_LABELS = SLIDER_LABELS;
  static SCROLL_TARGETS = Object.freeze([
    { key: "shell", selector: ".hl-shell" },
    { key: "windowContent", selector: ".window-content" },
  ]);

  static DEFAULT_OPTIONS = {
    id: "infinity-dnd5e-hoard-loot",
    tag: "section",
    classes: ["infinity-dnd5e", "hoard-loot"],
    window: {
      title: "Infinity D&D5e — Hoard Loot",
      icon: "fa-solid fa-sack-dollar",
      resizable: true,
    },
    position: { width: 760, height: 720 },
    actions: {
      ...BaseLootApp.sharedActionsExcept("toggleLock"),
      generate: HoardLootApp._onGenerate,
      depositHaul: HoardLootApp._onDepositHaul,
      tierSelect: HoardLootApp._onTierSelect,
      scaleSelect: HoardLootApp._onScaleSelect,
    },
    form: { handler: undefined, closeOnSubmit: false, submitOnChange: false },
  };

  static PARTS = {
    body: { template: TEMPLATE_PATH },
  };

  /* ------------------- state ------------------- */

  static buildDefaultForm() {
    const tier = getSetting(SETTING_KEYS.DEFAULT_TIER) ?? "t2";
    const scale = "standard";
    return {
      tier,
      scale,
      pileBias: 0,
      magicBias: getSetting(SETTING_KEYS.DEFAULT_MAGIC_BIAS) ?? 0,
      maxItems: HOARD_DEFAULT_ITEM_CEILING[scale] ?? 8,
      artVariants: true,
      rarityBalance: RARITY_BALANCE_DEFAULT_KEY,
      rarityWeights: getRarityBalancePresetWeights(RARITY_BALANCE_DEFAULT_KEY),
      rarities: getDefaultRarities(tier, scale),
      lootTypes: [...LOOT_TYPES],
      minItemGp: 0,
      maxItemGp: 0,
    };
  }

  constructor(options = {}) {
    super(options);
    const persistEnabled = getSetting(SETTING_KEYS.PERSIST_STATE) !== false;
    const persisted = persistEnabled ? HoardLootApp._persistedState : null;
    const defaults = HoardLootApp.buildDefaultForm();
    this._form = persisted?.form
      ? normalizeHoardForm({ ...defaults, ...persisted.form })
      : normalizeHoardForm(defaults);
    this._lastResult = persisted?.lastResult ?? null;
  }

  /* ------------------- base hooks ------------------- */

  _primaryGenerate() {
    return this._generate();
  }

  _snapLabel(key) {
    return humanizeKey(key);
  }

  _chipUniverse(group) {
    if (group === "rarity") return RARITIES;
    if (group === "lootType") return LOOT_TYPES;
    return null;
  }

  _buildChatHtml(result) {
    return buildHoardChatHtml(result);
  }

  /** The hoard haul includes the coin pile alongside its items. */
  _distributableHaul() {
    const items = (this._lastResult?.items ?? [])
      .map(toDistributableEntry)
      .filter(Boolean);
    const currency = this._lastResult?.coinPileGp
      ? this._lastResult.coinBreakdown
      : null;
    return { items, currency };
  }

  /** Recompute item + grand totals (coin pile included) after a mutation. */
  _recomputeTotals() {
    if (!this._lastResult) return;
    const itemsTotal = (this._lastResult.items ?? []).reduce(
      (sum, entry) => sum + (entry.gpTotal ?? 0),
      0,
    );
    const coin = this._lastResult.coinPileGp ?? 0;
    this._lastResult.itemsTotalGp = itemsTotal;
    this._lastResult.itemsTotalGpLabel = formatGp(itemsTotal);
    this._lastResult.totalGp = itemsTotal + coin;
    this._lastResult.totalGpLabel = formatGp(itemsTotal + coin);
  }

  /* ------------------- context ------------------- */

  async _prepareContext() {
    const totalBudget = computeHoardBudget(this._formForBudget());
    const { coinPileGp, itemBudget } = splitCoinPile(
      totalBudget,
      this._form.pileBias,
    );
    const stats = this._packStats ?? computePackStats([]);
    const candidates = this._countCandidates();
    const tierStats = this._cachedItems
      ? computeTierFilteredStats(this._cachedItems, tierWindow(this._form.tier))
      : null;
    return {
      ...this._basePresetContext(),
      ...this._marketContext(),
      form: this._form,
      moduleId: MODULE_ID,
      totalBudgetLabel: formatGp(totalBudget),
      coinPileLabel: formatGp(coinPileGp),
      itemBudgetLabel: formatGp(itemBudget),
      candidateLabel: this._candidateLabel(candidates, stats.totalItems),
      loadingItems: this._loadingItems,

      tierOptions: TIERS.map((tier) => ({
        value: tier,
        label: tierLabel(tier),
        shortLabel: tier.toUpperCase(),
        selected: tier === this._form.tier,
        count: stats.byTier?.[tier] ?? 0,
      })),

      scaleOptions: SCALE_ORDER.map((key) => ({
        value: key,
        label: humanizeKey(key),
        multiplier: HOARD_SCALE_PRESETS[key],
        flavor: getScaleFlavor(key),
        selected: key === this._form.scale,
      })),

      maxItems: this._form.maxItems,
      maxItemsMin: MAX_ITEMS_RANGE.min,
      maxItemsMax: MAX_ITEMS_RANGE.max,

      pileBias: this._sliderContext({
        name: "pileBias",
        value: this._form.pileBias,
        range: PILE_BIAS_RANGE,
        presets: PILE_BIAS_PRESETS,
        valueLabel: formatPileBias(this._form.pileBias),
      }),
      magicBias: this._sliderContext({
        name: "magicBias",
        value: this._form.magicBias,
        range: MAGIC_BIAS_RANGE,
        presets: { neutral: 0 },
        valueLabel: formatMagicBias(this._form.magicBias),
      }),

      rarityOptions: RARITIES.map((rarity) => ({
        value: rarity,
        label: prettyRarity(rarity),
        count: tierStats?.byRarity?.[rarity] ?? stats.byRarity?.[rarity] ?? 0,
        selected: this._form.rarities.includes(rarity),
      })),
      rarityBalanceOptions: rarityBalanceOptions(this._form.rarityBalance),
      rarityWeightRows: rarityWeightRows(this._form.rarityWeights),
      lootTypeOptions: LOOT_TYPES.map((lootType) => ({
        value: lootType,
        label: prettyLootType(lootType),
        count:
          tierStats?.byLootType?.[lootType] ??
          stats.byLootType?.[lootType] ??
          0,
        selected: this._form.lootTypes.includes(lootType),
      })),

      hasResult: Boolean(this._lastResult && this._lastResult.items?.length),
      hasCoinPile: Boolean(this._lastResult?.coinPileGp),
      result: resultContext(this._lastResult),
    };
  }

  /* ------------------- actions ------------------- */

  /** @this {HoardLootApp} */
  static async _onGenerate(_event, _target) {
    if (this._loadingItems) return;
    playModuleSound(SOUND_EVENTS.ROLL_START);
    await this._generate();
  }

  /** @this {HoardLootApp} */
  static async _onDepositHaul(_event, _target) {
    if (!this._lastResult) {
      playModuleSound(SOUND_EVENTS.WARNING_MUTED);
      ui.notifications?.info("Nothing to deposit — roll a hoard first.");
      return;
    }
    const items = (this._lastResult.items ?? [])
      .map(toDistributableEntry)
      .filter(Boolean);
    const currency = this._lastResult.coinPileGp
      ? this._lastResult.coinBreakdown
      : null;
    if (items.length === 0 && !currency) {
      playModuleSound(SOUND_EVENTS.WARNING_MUTED);
      ui.notifications?.info("This hoard has no items or coins to deposit.");
      return;
    }
    const result = await promptDistributeItems(items, {
      title: "Deposit Hoard to Actor",
      hint: `Choose a character to receive the hoard's ${items.length} item(s).`,
      currency,
      coinLabel: this._lastResult.coinBreakdownLabel,
    });
    if (result) playModuleSound(SOUND_EVENTS.DEPOSIT);
  }

  /** @this {HoardLootApp} */
  static async _onTierSelect(_event, target) {
    const newTier = target?.dataset?.value;
    if (!newTier || newTier === this._form.tier) return;
    const prevDefaults = getDefaultRarities(this._form.tier, this._form.scale);
    const customizedRarities = !sameSet(this._form.rarities, prevDefaults);
    const nextRarities = customizedRarities
      ? this._form.rarities
      : getDefaultRarities(newTier, this._form.scale);
    this._form = { ...this._form, tier: newTier, rarities: nextRarities };
    await this._renderPreservingScroll();
  }

  /** @this {HoardLootApp} */
  static async _onScaleSelect(_event, target) {
    const newScale = target?.dataset?.value;
    if (!newScale || newScale === this._form.scale) return;
    const prevScale = this._form.scale;

    const prevCeilingDefault = HOARD_DEFAULT_ITEM_CEILING[prevScale];
    const customizedMaxItems = this._form.maxItems !== prevCeilingDefault;
    const nextMaxItems = customizedMaxItems
      ? this._form.maxItems
      : (HOARD_DEFAULT_ITEM_CEILING[newScale] ?? this._form.maxItems);

    const prevRarityDefaults = getDefaultRarities(this._form.tier, prevScale);
    const customizedRarities = !sameSet(
      this._form.rarities,
      prevRarityDefaults,
    );
    const nextRarities = customizedRarities
      ? this._form.rarities
      : getDefaultRarities(this._form.tier, newScale);

    this._form = {
      ...this._form,
      scale: newScale,
      maxItems: nextMaxItems,
      rarities: nextRarities,
    };
    await this._renderPreservingScroll();
  }

  /* ------------------- form handling ------------------- */

  _onFormInput(event) {
    const target = event.target;
    if (!target?.name) return;
    const next = { ...this._form };
    if (target.name.startsWith("rarityWeight.")) {
      const rarity = target.name.slice("rarityWeight.".length);
      const currentWeights = resolveRarityWeights(
        this._form.rarityBalance,
        this._form.rarityWeights,
      );
      next.rarityBalance = RARITY_BALANCE_CUSTOM_KEY;
      next.rarityWeights = {
        ...currentWeights,
        [rarity]: clampRarityWeight(target.value, currentWeights[rarity] ?? 1),
      };
    } else
      switch (target.name) {
        case "pileBias":
          next.pileBias = clampFloat(
            target.value,
            PILE_BIAS_RANGE.min,
            PILE_BIAS_RANGE.max,
            0,
          );
          break;
        case "magicBias":
          next.magicBias = clampFloat(
            target.value,
            MAGIC_BIAS_RANGE.min,
            MAGIC_BIAS_RANGE.max,
            0,
          );
          break;
        case "artVariants":
          next.artVariants = Boolean(target.checked);
          break;
        case "maxItems":
          next.maxItems = clampInt(
            target.value,
            MAX_ITEMS_RANGE.min,
            MAX_ITEMS_RANGE.max,
            0,
          );
          break;
        case "minItemGp":
          next.minItemGp = clampInt(
            target.value,
            0,
            Number.MAX_SAFE_INTEGER,
            0,
          );
          break;
        case "maxItemGp":
          next.maxItemGp = clampInt(
            target.value,
            0,
            Number.MAX_SAFE_INTEGER,
            0,
          );
          break;
        case "rarityBalance":
          next.rarityBalance = normalizeRarityBalanceKey(target.value);
          next.rarityWeights = resolveRarityWeights(
            next.rarityBalance,
            next.rarityWeights,
          );
          break;
        case "rarity":
          next.rarities = this._readChipGroup("rarity");
          break;
        case "lootType":
          next.lootTypes = this._readChipGroup("lootType");
          break;
        default:
          return;
      }
    this._form = next;
    if (target.type === "checkbox") {
      target
        .closest(".lf-chip")
        ?.classList.toggle("is-checked", target.checked);
    }
    this._syncRarityBalanceControls(target.name === "rarityBalance");
    this._patchLiveReadouts();
  }

  _syncRarityBalanceControls(writeWeights = false) {
    if (!this.element) return;
    const select = this.element.querySelector('[name="rarityBalance"]');
    if (select) select.value = this._form.rarityBalance;
    if (!writeWeights) return;
    const weights = resolveRarityWeights(
      this._form.rarityBalance,
      this._form.rarityWeights,
    );
    for (const [rarity, weight] of Object.entries(weights)) {
      const input = this.element.querySelector(
        `input[name="rarityWeight.${rarity}"]`,
      );
      if (input) input.value = formatMultiplier(weight);
    }
  }

  _patchLiveReadouts() {
    if (!this.element) return;
    const root = this.element;
    const totalBudget = computeHoardBudget(this._formForBudget());
    const { coinPileGp, itemBudget } = splitCoinPile(
      totalBudget,
      this._form.pileBias,
    );

    setText(root, "[data-total-budget]", formatGp(totalBudget));
    setText(root, "[data-coin-pile-projected]", formatGp(coinPileGp));
    setText(root, "[data-item-budget]", formatGp(itemBudget));
    setText(
      root,
      "[data-readout='pileBias']",
      formatPileBias(this._form.pileBias),
    );
    setText(
      root,
      "[data-readout='magicBias']",
      formatMagicBias(this._form.magicBias),
    );

    const candidates = this._countCandidates();
    setText(
      root,
      "[data-candidates]",
      this._candidateLabel(candidates, this._packStats?.totalItems ?? 0),
    );
    setText(root, "[data-value-range]", this._valueRangeLabel());

    this._syncSnapStates(root, "pileBias", this._form.pileBias);
    this._syncSnapStates(root, "magicBias", this._form.magicBias);
  }

  /** Read a chip group's checked values off the live form. */
  _readChipGroup(group) {
    if (!this.element) return [];
    return [
      ...this.element.querySelectorAll(
        `input[type='checkbox'][name='${group}']:checked`,
      ),
    ].map((el) => el.value);
  }

  _formForBudget() {
    return { tier: this._form.tier, scale: this._form.scale };
  }

  _filterSpec() {
    return {
      tiers: tierWindow(this._form.tier),
      rarities: this._form.rarities,
      lootTypes: this._form.lootTypes,
      requireEligible: true,
      ...this._valueFilter(),
    };
  }

  /* ------------------- generation pipeline ------------------- */

  async _generate() {
    if (this._loadingItems) return;
    // Make a fresh roll undoable (protects a hand-edited haul from a stray Enter/R).
    if (this._lastResult) this._pushUndo();
    let generatedResult = null;
    const needsLoad = !this._isItemCacheFresh();
    if (needsLoad) {
      this._loadingItems = true;
      playModuleSound(SOUND_EVENTS.LOADING_SHIMMER);
      await this._renderPreservingScroll();
    }
    try {
      const totalBudget = computeHoardBudget(this._formForBudget());
      const { coinPileGp, itemBudget } = splitCoinPile(
        totalBudget,
        this._form.pileBias,
      );
      const items = await this._loadItems();
      const candidates = filterCandidates(items, this._filterSpec());
      const raw =
        itemBudget > 0
          ? rollLoot(candidates, {
              count: clampInt(
                this._form.maxItems,
                MAX_ITEMS_RANGE.min,
                MAX_ITEMS_RANGE.max,
                0,
              ),
              budgetGp: itemBudget,
              magicBias: this._form.magicBias,
              rarityWeights: resolveRarityWeights(
                this._form.rarityBalance,
                this._form.rarityWeights,
              ),
              artVariants: this._form.artVariants,
            })
          : { items: [], totalGp: 0, droppedForBudget: 0, warnings: [] };

      const decoratedItems = raw.items.map((entry) =>
        this._decorateEntry(entry),
      );

      this._lastResult = {
        items: decoratedItems,
        itemsTotalGp: raw.totalGp,
        itemsTotalGpLabel: formatGp(raw.totalGp),
        itemBudget,
        itemBudgetLabel: formatGp(itemBudget),
        // Surfaced for the shared single-slot reroll (base reads budgetGp).
        budgetGp: itemBudget,
        coinPileGp,
        coinPileLabel: formatGp(coinPileGp),
        coinBreakdown: coinDenominationBreakdown(coinPileGp),
        coinBreakdownLabel: formatCoinBreakdown(
          coinDenominationBreakdown(coinPileGp),
        ),
        totalGp: raw.totalGp + coinPileGp,
        totalGpLabel: formatGp(raw.totalGp + coinPileGp),
        droppedForBudget: raw.droppedForBudget ?? 0,
        warnings: raw.warnings ?? [],
      };
      generatedResult = this._lastResult;
    } finally {
      this._loadingItems = false;
      await this._renderPreservingScroll();
      if (generatedResult) {
        playResultSound(generatedResult, { kind: "hoard" });
        this._recordRoll(generatedResult);
      }
    }
  }
}

/* ------------------------------------------------------------------ *
 * Helpers
 * ------------------------------------------------------------------ */

function normalizeHoardForm(form) {
  const raw = form && typeof form === "object" ? form : {};
  const rarityBalance = normalizeRarityBalanceKey(
    raw.rarityBalance ??
      (raw.rarityWeights
        ? RARITY_BALANCE_CUSTOM_KEY
        : RARITY_BALANCE_DEFAULT_KEY),
  );
  return {
    ...raw,
    rarityBalance,
    rarityWeights: resolveRarityWeights(rarityBalance, raw.rarityWeights),
  };
}

function resultContext(result) {
  if (!result) return null;
  return {
    ...result,
    items: (result.items ?? []).map((entry) => ({
      ...entry,
      imageSrc: resultImageForEntry(entry),
    })),
  };
}

function formatPileBias(value) {
  const num = Number(value);
  if (!Number.isFinite(num) || Math.abs(num) < 0.025) return "Mixed";
  const pct = Math.round(Math.abs(num) * 100);
  return num > 0 ? `+${pct}% Items` : `+${pct}% Coins`;
}

function buildHoardChatHtml(result) {
  const lines = result.items
    .map((entry) => {
      const displayName = entry.displayName ?? entry.item?.name ?? "?";
      const link = entry.item?.uuid
        ? `@UUID[${entry.item.uuid}]{${escapeHtml(displayName)}}`
        : escapeHtml(displayName);
      const qty =
        entry.quantity > 1 || isAmmunitionItem(entry.item)
          ? `${entry.quantity}× `
          : "";
      const rarity = escapeHtml(entry.rarity ?? "");
      const valueLabel = entry.valueLabel
        ? ` · ${escapeHtml(entry.valueLabel)}`
        : "";
      return `<li><strong>${qty}${link}</strong> <span style="opacity:0.7">— ${rarity} · ${formatGp(entry.gpTotal)}${valueLabel}</span></li>`;
    })
    .join("");
  const coinLine = result.coinPileGp
    ? `<p style="margin: 0 0 6px;"><strong>Coin pile:</strong> ${formatGp(result.coinPileGp)}${result.coinBreakdownLabel ? ` <span style="opacity:0.7">(${escapeHtml(result.coinBreakdownLabel)})</span>` : ""}</p>`
    : "";
  return `
<div class="infinity-loot-chat">
  <h3 style="margin: 0 0 4px;">Hoard Loot</h3>
  <p style="margin: 0 0 6px; opacity: 0.85;">
    Total: ${formatGp(result.totalGp)}
  </p>
  ${coinLine}
  ${result.items.length ? `<ul style="margin: 0; padding-left: 18px;">${lines}</ul>` : ""}
</div>`;
}
