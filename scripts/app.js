/**
 * Infinity D&D5e — PerEncounterLootApp
 *
 * Single GM-only window:
 * - Slider-driven controls (scale, generosity, party, optional item cap, magic bias)
 * - Segmented tier button row + multi-select chips for rarity / loot type
 * - Live pack-grounded readouts (candidate count, per-rarity item counts)
 * - "Generate" rolls a bundle against the bundled compendium
 *
 * Extends {@link BaseLootApp} for the shared lifecycle (pack loading,
 * render scaffold, scroll preservation, sliders, item-level controls);
 * this file owns only the encounter-specific context + generation.
 */

import {
  GENEROSITY_PRESETS,
  GENEROSITY_RANGE,
  SCALE_PRESETS,
  SCALE_RANGE,
  computeLootBudget,
  nearestPreset,
} from "./loot/budget.js";
import {
  beginDragFromResult,
  promptDistributeItems,
} from "./loot/distribute.js";
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
import { SETTING_KEYS, getSetting, parseRaritiesSetting } from "./settings.js";
import { BaseLootApp } from "./loot/loot-app-base.js";
import {
  livePartySize,
  resultImageForEntry,
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
  titleCase,
} from "./ui-util.js";

const MODULE_ID = "infinity-dnd5e";
const TEMPLATE_PATH = `modules/${MODULE_ID}/templates/loot-forge.hbs`;

const COUNT_RANGE = Object.freeze({ min: 1, max: 20, step: 1 });
const PARTY_RANGE = Object.freeze({ min: 1, max: 10, step: 1 });

/** Display labels for each slider — central so the template stays mute. */
const SLIDER_LABELS = Object.freeze({
  scaleMultiplier: "Encounter Scale",
  generosityMultiplier: "Generosity",
  partySize: "Party Size",
  count: "Item Limit",
  magicBias: "Magic vs. Mundane",
});

/** Single-snap anchor so users can hammer Magic Bias back to center. */
const MAGIC_BIAS_PRESETS = Object.freeze({ neutral: 0 });

/**
 * One-click "shape of a roll" macros. Each preset stamps the budget shape
 * without constraining how many items the roller uses to fill that budget.
 */
const QUICK_PRESETS = Object.freeze({
  easy: {
    label: "Easy",
    icon: "fa-solid fa-leaf",
    values: { scaleMultiplier: 0.4, generosityMultiplier: 0.8 },
  },
  standard: {
    label: "Standard",
    icon: "fa-solid fa-shield",
    values: { scaleMultiplier: 1.0, generosityMultiplier: 1.0 },
  },
  hard: {
    label: "Hard",
    icon: "fa-solid fa-fire",
    values: { scaleMultiplier: 1.5, generosityMultiplier: 1.0 },
  },
  hoard: {
    label: "Hoard",
    icon: "fa-solid fa-treasure-chest",
    values: { scaleMultiplier: 6.0, generosityMultiplier: 1.2 },
  },
});

export class PerEncounterLootApp extends BaseLootApp {
  static _instance = null;
  static _persistedState = null;

  static FORM_NAME = "loot-forge";
  static TOOL_ID = "per-encounter-loot";
  static CHAT_ALIAS = "Loot Forge";
  static SLIDER_LABELS = SLIDER_LABELS;
  static SCROLL_TARGETS = Object.freeze([
    { key: "shell", selector: ".lf-shell" },
    { key: "windowContent", selector: ".window-content" },
  ]);

  static DEFAULT_OPTIONS = {
    id: "infinity-dnd5e-per-encounter-loot",
    tag: "section",
    classes: ["infinity-dnd5e", "loot-forge"],
    window: {
      title: "Infinity D&D5e — Per-Encounter Loot",
      icon: "fa-solid fa-coins",
      resizable: true,
    },
    position: { width: 860, height: 760 },
    actions: {
      ...BaseLootApp.SHARED_ACTIONS,
      generate: PerEncounterLootApp._onGenerate,
      rerollUnlocked: PerEncounterLootApp._onRerollUnlocked,
      distributeBundle: PerEncounterLootApp._onDistributeBundle,
      tierSelect: PerEncounterLootApp._onTierSelect,
      quickPreset: PerEncounterLootApp._onQuickPreset,
      useParty: PerEncounterLootApp._onUseParty,
    },
    form: { handler: undefined, closeOnSubmit: false, submitOnChange: false },
  };

  static PARTS = {
    body: { template: TEMPLATE_PATH },
  };

  /* ------------------- state ------------------- */

  static buildDefaultForm() {
    const defaultLimit = clampInt(
      getSetting(SETTING_KEYS.DEFAULT_COUNT),
      0,
      COUNT_RANGE.max,
      0,
    );
    return {
      tier: getSetting(SETTING_KEYS.DEFAULT_TIER) ?? "t2",
      scaleMultiplier:
        getSetting(SETTING_KEYS.DEFAULT_SCALE) ?? SCALE_PRESETS.standard,
      generosityMultiplier:
        getSetting(SETTING_KEYS.DEFAULT_GENEROSITY) ??
        GENEROSITY_PRESETS.balanced,
      partySize: getSetting(SETTING_KEYS.DEFAULT_PARTY_SIZE) ?? 4,
      itemLimitEnabled: defaultLimit > 0,
      count: defaultLimit > 0 ? defaultLimit : 6,
      budgetOverride: 0,
      artVariants: true,
      magicBias: getSetting(SETTING_KEYS.DEFAULT_MAGIC_BIAS) ?? 0,
      rarities: parseRaritiesSetting(
        getSetting(SETTING_KEYS.DEFAULT_RARITIES),
        RARITIES,
      ),
      lootTypes: [], // empty = all types
      minItemGp: 0, // 0 = no floor
      maxItemGp: 0, // 0 = no ceiling
    };
  }

  constructor(options = {}) {
    super(options);
    const persistEnabled = getSetting(SETTING_KEYS.PERSIST_STATE) !== false;
    const persisted = persistEnabled
      ? PerEncounterLootApp._persistedState
      : null;
    const defaults = PerEncounterLootApp.buildDefaultForm();
    this._form = persisted?.form
      ? { ...defaults, ...persisted.form }
      : defaults;
    this._form.itemLimitEnabled = this._form.itemLimitEnabled === true;
    this._form.count = clampInt(
      this._form.count,
      COUNT_RANGE.min,
      COUNT_RANGE.max,
      6,
    );
    this._lastResult = persisted?.lastResult ?? null;
  }

  /* ------------------- base hooks ------------------- */

  _primaryGenerate() {
    return this._generate();
  }

  _beginDrag(event, entry) {
    beginDragFromResult(event, entry);
  }

  _chipUniverse(group) {
    if (group === "rarity") return RARITIES;
    if (group === "lootType") return LOOT_TYPES;
    return null;
  }

  _buildChatHtml(result) {
    return buildLootChatHtml(result);
  }

  _hasChatResult() {
    return Boolean(this._lastResult && this._lastResult.items.length > 0);
  }

  /* ------------------- context ------------------- */

  async _prepareContext() {
    const projectedBudget = computeLootBudget(this._formForBudget());
    const stats = this._packStats ?? computePackStats([]);
    const candidates = this._countCandidates();
    const result = prepareResultForDisplay(this._lastResult);
    const tierStats = this._cachedItems
      ? computeTierFilteredStats(this._cachedItems, tierWindow(this._form.tier))
      : null;
    return {
      ...this._basePresetContext(),
      ...this._marketContext(),
      form: this._form,
      moduleId: MODULE_ID,
      projectedBudgetLabel: formatGp(projectedBudget),
      candidateCount: candidates,
      candidateLabel: this._candidateLabel(candidates, stats.totalItems),
      noCandidates: candidates === 0 && !this._loadingItems,
      loadingItems: this._loadingItems,
      partyAutofillSize: livePartySize(),

      quickPresets: Object.entries(QUICK_PRESETS).map(([key, preset]) => ({
        key,
        label: preset.label,
        icon: preset.icon,
        active:
          Math.abs(this._form.scaleMultiplier - preset.values.scaleMultiplier) <
            0.01 &&
          Math.abs(
            this._form.generosityMultiplier -
              preset.values.generosityMultiplier,
          ) < 0.01,
      })),

      tierOptions: TIERS.map((tier) => ({
        value: tier,
        label: tierLabel(tier),
        shortLabel: tier.toUpperCase(),
        selected: tier === this._form.tier,
        count: stats.byTier?.[tier] ?? 0,
      })),

      scale: this._sliderContext({
        name: "scaleMultiplier",
        value: this._form.scaleMultiplier,
        range: SCALE_RANGE,
        presets: SCALE_PRESETS,
        valueLabel: `×${formatMultiplier(this._form.scaleMultiplier)}`,
      }),
      generosity: this._sliderContext({
        name: "generosityMultiplier",
        value: this._form.generosityMultiplier,
        range: GENEROSITY_RANGE,
        presets: GENEROSITY_PRESETS,
        valueLabel: `×${formatMultiplier(this._form.generosityMultiplier)}`,
      }),
      partySize: {
        ...this._sliderContext({
          name: "partySize",
          value: this._form.partySize,
          range: PARTY_RANGE,
          presets: null,
          valueLabel: `${this._form.partySize} PC${this._form.partySize === 1 ? "" : "s"}`,
        }),
        extra: {
          action: "useParty",
          label: "Use Party",
          title: livePartySize()
            ? `Set to ${livePartySize()} (live player count)`
            : "No active player characters detected",
          icon: "fa-solid fa-users",
        },
      },
      itemLimit: this._sliderContext({
        name: "count",
        value: this._form.count,
        range: COUNT_RANGE,
        presets: null,
        valueLabel: itemLimitValueLabel(this._form.count),
      }),
      itemLimitLabel: this._form.itemLimitEnabled
        ? itemLimitValueLabel(this._form.count)
        : "Auto",
      magicBias: this._sliderContext({
        name: "magicBias",
        value: this._form.magicBias,
        range: MAGIC_BIAS_RANGE,
        presets: MAGIC_BIAS_PRESETS,
        valueLabel: formatMagicBias(this._form.magicBias),
      }),

      rarityOptions: RARITIES.map((rarity) => ({
        value: rarity,
        label: prettyRarity(rarity),
        count: tierStats?.byRarity?.[rarity] ?? stats.byRarity?.[rarity] ?? 0,
        selected: this._form.rarities.includes(rarity),
      })),
      lootTypeOptions: LOOT_TYPES.map((lootType) => ({
        value: lootType,
        label: prettyLootType(lootType),
        count:
          tierStats?.byLootType?.[lootType] ??
          stats.byLootType?.[lootType] ??
          0,
        selected: this._form.lootTypes.includes(lootType),
      })),

      packStatsLoaded: Boolean(this._packStats),
      hasResult: Boolean(result && result.items.length > 0),
      result,
    };
  }

  /* ------------------- actions ------------------- */

  /** @this {PerEncounterLootApp} */
  static async _onGenerate(_event, _target) {
    if (this._loadingItems) return;
    playModuleSound(SOUND_EVENTS.ROLL_START);
    await this._generate({ preserveLocked: false });
  }

  /** @this {PerEncounterLootApp} */
  static async _onRerollUnlocked(_event, _target) {
    if (this._loadingItems) return;
    playModuleSound(SOUND_EVENTS.ROLL_START);
    await this._generate({ preserveLocked: true });
  }

  /** @this {PerEncounterLootApp} */
  static async _onQuickPreset(_event, target) {
    const key = target?.dataset?.preset;
    const preset = QUICK_PRESETS[key];
    if (!preset) return;
    this._form = { ...this._form, ...preset.values };
    playModuleSound(SOUND_EVENTS.PRESET_APPLY);
    await this._renderPreservingScroll();
  }

  /** @this {PerEncounterLootApp} */
  static async _onUseParty(_event, _target) {
    const live = livePartySize();
    if (live <= 0) {
      playModuleSound(SOUND_EVENTS.WARNING_MUTED);
      ui.notifications?.info(
        "No active player characters detected. Set the party size manually.",
      );
      return;
    }
    this._form = { ...this._form, partySize: live };
    playModuleSound(SOUND_EVENTS.PRESET_APPLY);
    await this._renderPreservingScroll();
  }

  /** @this {PerEncounterLootApp} */
  static async _onTierSelect(_event, target) {
    const tier = target?.dataset?.value;
    if (!tier) return;
    this._form = { ...this._form, tier };
    await this._renderPreservingScroll();
  }

  /** @this {PerEncounterLootApp} */
  static async _onDistributeBundle(_event, _target) {
    const items = (this._lastResult?.items ?? [])
      .map(toDistributableEntry)
      .filter(Boolean);
    if (items.length === 0) {
      playModuleSound(SOUND_EVENTS.WARNING_MUTED);
      return;
    }
    const result = await promptDistributeItems(items, {
      title: `Distribute Bundle (${items.length} items)`,
      hint: "Choose one character to receive the entire bundle.",
    });
    if (result) playModuleSound(SOUND_EVENTS.DEPOSIT);
  }

  /* ------------------- form handling ------------------- */

  _onFormInput(event) {
    const target = event.target;
    if (!target?.name) return;
    const name = target.name;
    if (name === "itemLimitEnabled" && event.type === "input") return;
    const next = { ...this._form };

    switch (name) {
      case "tier":
        next.tier = String(target.value);
        break;
      case "scaleMultiplier":
        next.scaleMultiplier = clampFloat(
          target.value,
          SCALE_RANGE.min,
          SCALE_RANGE.max,
          SCALE_PRESETS.standard,
        );
        break;
      case "generosityMultiplier":
        next.generosityMultiplier = clampFloat(
          target.value,
          GENEROSITY_RANGE.min,
          GENEROSITY_RANGE.max,
          GENEROSITY_PRESETS.balanced,
        );
        break;
      case "partySize":
        next.partySize = clampInt(
          target.value,
          PARTY_RANGE.min,
          PARTY_RANGE.max,
          4,
        );
        break;
      case "count":
        next.count = clampInt(
          target.value,
          COUNT_RANGE.min,
          COUNT_RANGE.max,
          6,
        );
        break;
      case "itemLimitEnabled":
        next.itemLimitEnabled = Boolean(target.checked);
        next.count = clampInt(next.count, COUNT_RANGE.min, COUNT_RANGE.max, 6);
        this._form = next;
        void this._renderPreservingScroll();
        return;
      case "budgetOverride":
        next.budgetOverride = clampInt(
          target.value,
          0,
          Number.MAX_SAFE_INTEGER,
          0,
        );
        break;
      case "minItemGp":
        next.minItemGp = clampInt(target.value, 0, Number.MAX_SAFE_INTEGER, 0);
        break;
      case "maxItemGp":
        next.maxItemGp = clampInt(target.value, 0, Number.MAX_SAFE_INTEGER, 0);
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
    this._patchLiveReadouts();
  }

  _patchLiveReadouts() {
    if (!this.element) return;
    const root = this.element;
    setText(
      root,
      "[data-projected-budget]",
      formatGp(computeLootBudget(this._formForBudget())),
    );
    setText(
      root,
      "[data-readout='scaleMultiplier']",
      `×${formatMultiplier(this._form.scaleMultiplier)}`,
    );
    setText(
      root,
      "[data-readout='generosityMultiplier']",
      `×${formatMultiplier(this._form.generosityMultiplier)}`,
    );
    setText(
      root,
      "[data-readout='partySize']",
      `${this._form.partySize} PC${this._form.partySize === 1 ? "" : "s"}`,
    );
    setText(
      root,
      "[data-readout='count']",
      itemLimitValueLabel(this._form.count),
    );
    setText(
      root,
      "[data-item-limit-label]",
      this._form.itemLimitEnabled
        ? itemLimitValueLabel(this._form.count)
        : "Auto",
    );
    setText(
      root,
      "[data-readout='magicBias']",
      formatMagicBias(this._form.magicBias),
    );

    // Full-pack candidate scan + value-range readout: debounce so a slider
    // drag recomputes once when it settles instead of on every input frame.
    // The cheap readouts above stay synchronous for instant feedback.
    this._debounce("candidates", () => {
      const el = this.element;
      if (!el) return;
      const candidates = this._countCandidates();
      setText(
        el,
        "[data-candidates]",
        this._candidateLabel(candidates, this._packStats?.totalItems ?? 0),
      );
      setText(el, "[data-value-range]", this._valueRangeLabel());
    });

    setText(
      root,
      "[data-preset='scaleMultiplier']",
      titleCase(nearestPreset(this._form.scaleMultiplier, SCALE_PRESETS)),
    );
    setText(
      root,
      "[data-preset='generosityMultiplier']",
      titleCase(
        nearestPreset(this._form.generosityMultiplier, GENEROSITY_PRESETS),
      ),
    );

    this._syncSnapStates(root, "scaleMultiplier", this._form.scaleMultiplier);
    this._syncSnapStates(
      root,
      "generosityMultiplier",
      this._form.generosityMultiplier,
    );
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
    return {
      tier: this._form.tier,
      scaleMultiplier: this._form.scaleMultiplier,
      generosityMultiplier: this._form.generosityMultiplier,
      partySize: this._form.partySize,
      override: this._form.budgetOverride,
    };
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

  async _generate({ preserveLocked = false } = {}) {
    if (this._loadingItems) return; // re-entrant click guard
    // Snapshot the current haul so a fresh roll (incl. a stray Enter/R) is
    // undoable — Undo already appears in the menu when canUndo.
    if (this._lastResult) this._pushUndo();
    let generatedResult = null;

    const lockedEntries =
      preserveLocked && this._lastResult
        ? this._lastResult.items.filter((entry) => entry.locked)
        : [];

    try {
      if (!this._isItemCacheFresh()) {
        this._loadingItems = true;
        playModuleSound(SOUND_EVENTS.LOADING_SHIMMER);
        await this._renderPreservingScroll();
      }

      const totalBudget = computeLootBudget(this._formForBudget());
      const lockedGp = lockedEntries.reduce(
        (sum, entry) => sum + (entry.gpTotal ?? 0),
        0,
      );
      const lockedIds = new Set(
        lockedEntries.map((entry) =>
          String(entry.item._id ?? entry.item.id ?? ""),
        ),
      );

      const items = await this._loadItems();
      let candidates = filterCandidates(items, this._filterSpec());
      if (lockedIds.size > 0) {
        candidates = candidates.filter(
          (item) => !lockedIds.has(String(item._id ?? item.id ?? "")),
        );
      }

      const itemLimit = this._form.itemLimitEnabled
        ? clampInt(this._form.count, COUNT_RANGE.min, COUNT_RANGE.max, 6)
        : 0;
      const remainingCount =
        itemLimit > 0 ? Math.max(0, itemLimit - lockedEntries.length) : 0;
      const shouldRollMore = itemLimit > 0 ? remainingCount > 0 : true;
      const remainingBudget = Math.max(0, totalBudget - lockedGp);

      const locksFilledBudget =
        lockedEntries.length > 0 &&
        totalBudget > 0 &&
        remainingBudget <= 0 &&
        shouldRollMore;

      let raw;
      if (locksFilledBudget) {
        raw = {
          items: [],
          totalGp: 0,
          droppedForBudget: 0,
          warnings: [
            `Locked items (${formatGp(lockedGp)}) already fill the ${formatGp(totalBudget)} budget. Unlock an item or raise the budget to add more.`,
          ],
        };
      } else if (shouldRollMore) {
        raw = rollLoot(candidates, {
          count: itemLimit > 0 ? remainingCount : 0,
          budgetGp: remainingBudget > 0 ? remainingBudget : 0,
          magicBias: this._form.magicBias,
          artVariants: this._form.artVariants,
        });
      } else {
        raw = { items: [], totalGp: 0, droppedForBudget: 0, warnings: [] };
      }

      const mergedItems = [
        ...lockedEntries,
        ...raw.items.map((entry) => this._decorateEntry(entry)),
      ].sort((a, b) => b.gpTotal - a.gpTotal);
      const totalGp = mergedItems.reduce(
        (sum, entry) => sum + entry.gpTotal,
        0,
      );

      this._lastResult = {
        items: mergedItems,
        totalGp,
        totalGpLabel: formatGp(totalGp),
        budgetGp: totalBudget,
        budgetGpLabel: formatGp(totalBudget),
        droppedForBudget: raw.droppedForBudget ?? 0,
        warnings: raw.warnings ?? [],
        lockedCount: lockedEntries.length,
      };
      generatedResult = this._lastResult;
    } finally {
      this._loadingItems = false;
      await this._renderPreservingScroll();
      if (generatedResult) {
        playResultSound(generatedResult);
        this._recordRoll(generatedResult);
      }
    }
  }
}

/* ------------------------------------------------------------------ *
 * Helpers
 * ------------------------------------------------------------------ */

function itemLimitValueLabel(count) {
  const value = clampInt(count, COUNT_RANGE.min, COUNT_RANGE.max, 6);
  return `Max ${value} item${value === 1 ? "" : "s"}`;
}

function prepareResultForDisplay(result) {
  if (!result) return null;
  return {
    ...result,
    items: (result.items ?? []).map((entry) => ({
      ...entry,
      imageSrc: resultImageForEntry(entry),
    })),
  };
}

/**
 * Build the chat-card HTML for a roll result. Items are rendered as
 * Foundry UUID links so clicking from chat opens the compendium item
 * sheet. Plain string concatenation — chat runs outside the window's
 * part-rendering pipeline.
 */
function buildLootChatHtml(result) {
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
  const budgetLine = result.budgetGp
    ? ` / ${formatGp(result.budgetGp)} budget`
    : "";
  return `
<div class="infinity-loot-chat">
  <h3 style="margin: 0 0 4px;">Per-Encounter Loot</h3>
  <p style="margin: 0 0 6px; opacity: 0.85;">
    ${result.items.length} item(s) — ${formatGp(result.totalGp)}${budgetLine}
  </p>
  <ul style="margin: 0; padding-left: 18px;">${lines}</ul>
</div>`;
}
