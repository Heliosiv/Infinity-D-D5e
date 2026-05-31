/**
 * Infinity D&D5e — PerEncounterLootApp
 *
 * Single GM-only window:
 * - Slider-driven controls (scale, generosity, party, optional item cap, magic bias)
 * - Segmented tier button row + multi-select chips for rarity / loot type
 * - Live pack-grounded readouts (candidate count, per-rarity item counts)
 * - "Generate" rolls a bundle against the bundled compendium
 *
 * Built on Foundry's ApplicationV2 + HandlebarsApplicationMixin. The
 * roller, budget, and pack-stats modules are pure functions so the
 * window itself owns no domain logic — just form state and rendering.
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
import { loadCompendiumItems } from "./loot/pack.js";
import {
  computePackStats,
  computeTierFilteredStats,
} from "./loot/pack-stats.js";
import { MAGIC_BIAS_RANGE, filterCandidates, rollLoot } from "./loot/roller.js";
import {
  LOOT_TYPES,
  RARITIES,
  TIERS,
  getItemRarity,
  isAmmunitionItem,
  tierWindow,
} from "./loot/tag-vocabulary.js";
import { SETTING_KEYS, getSetting, parseRaritiesSetting } from "./settings.js";
import {
  clampFloat,
  clampInt,
  escapeHtml,
  formatGp,
  formatMagicBias,
  formatMultiplier,
  prettyLootType,
  titleCase,
} from "./ui-util.js";

const MODULE_ID = "infinity-dnd5e";
const PACK_ID = `${MODULE_ID}.infinity-dnd5e-items`;
const TEMPLATE_PATH = `modules/${MODULE_ID}/templates/loot-forge.hbs`;
const FALLBACK_ITEM_IMAGE = "icons/svg/item-bag.svg";
const SCROLL_TARGETS = Object.freeze([
  { key: "shell", selector: ".lf-shell" },
  { key: "windowContent", selector: ".window-content" },
]);

const COUNT_RANGE = Object.freeze({ min: 1, max: 20, step: 1 });
const PARTY_RANGE = Object.freeze({ min: 1, max: 10, step: 1 });

/** Display labels for each slider — central so the template stays mute. */
const SLIDER_LABELS = Object.freeze({
  scaleMultiplier: "Encounter Scale",
  generosityMultiplier: "Generosity",
  partySize: "Party Size",
  count: "Item Limit",
  magicBias: "Magic Bias",
});

/** Single-snap anchor so users can hammer Magic Bias back to center. */
const MAGIC_BIAS_PRESETS = Object.freeze({ neutral: 0 });

/**
 * One-click "shape of a roll" macros. Each preset stamps the budget shape
 * without constraining how many items the roller uses to fill that budget.
 * Tier, chips, and optional item limits stay the user's deliberate choice.
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

/* ------------------------------------------------------------------ *
 * Application V2 host
 * ------------------------------------------------------------------ */

const { ApplicationV2, HandlebarsApplicationMixin } = foundry.applications.api;

export class PerEncounterLootApp extends HandlebarsApplicationMixin(
  ApplicationV2,
) {
  /** Single shared instance — `open()` reuses an existing window. */
  static _instance = null;

  /**
   * Form + last-result snapshot persisted across window closes.
   * Lives in module memory (cleared on page reload), so a GM who
   * closes the window mid-encounter and re-opens it lands back
   * where they were — without writing to user flags.
   */
  static _persistedState = null;

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
      generate: PerEncounterLootApp._onGenerate,
      rerollUnlocked: PerEncounterLootApp._onRerollUnlocked,
      reset: PerEncounterLootApp._onReset,
      clear: PerEncounterLootApp._onClear,
      openItem: PerEncounterLootApp._onOpenItem,
      distributeOne: PerEncounterLootApp._onDistributeOne,
      distributeBundle: PerEncounterLootApp._onDistributeBundle,
      toggleLock: PerEncounterLootApp._onToggleLock,
      sendToChat: PerEncounterLootApp._onSendToChat,
      snap: PerEncounterLootApp._onSnap,
      tierSelect: PerEncounterLootApp._onTierSelect,
      quickPreset: PerEncounterLootApp._onQuickPreset,
      useParty: PerEncounterLootApp._onUseParty,
      chipAll: PerEncounterLootApp._onChipAll,
      chipNone: PerEncounterLootApp._onChipNone,
    },
    form: {
      handler: undefined,
      closeOnSubmit: false,
      submitOnChange: false,
    },
  };

  static PARTS = {
    body: { template: TEMPLATE_PATH },
  };

  /** Opens (or focuses) the singleton instance. */
  static open() {
    playModuleSound(SOUND_EVENTS.UI_OPEN);
    if (!PerEncounterLootApp._instance)
      PerEncounterLootApp._instance = new PerEncounterLootApp();
    if (PerEncounterLootApp._instance.rendered)
      PerEncounterLootApp._instance.bringToFront();
    else PerEncounterLootApp._instance.render(true);
    return PerEncounterLootApp._instance;
  }

  /* ------------------- state ------------------- */

  /**
   * Form defaults — read freshly from module settings each time so a
   * change in *Configure Settings* takes effect on the next open / reset
   * without a page reload. Hardcoded fallbacks let the defaults work
   * in tests where `game.settings` isn't available.
   */
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
    this._loadingItems = false;
    this._cachedItems = null;
    this._cachedItemsAt = 0;
    this._packStats = null;
    this._pendingScrollState = null;
    this._lastScrollState = null;
  }

  /* ------------------- context ------------------- */

  async _prepareContext() {
    const projectedBudget = computeLootBudget(this._formForBudget());
    const stats = this._packStats ?? computePackStats([]);
    const candidates = this._countCandidates();
    const result = prepareResultForDisplay(this._lastResult);
    // Tier-aware chip counts: when items are loaded, count rarities and
    // loot types ONLY within the current tier window — so the chip the
    // user sees reflects what they'll actually roll, not the pack-wide
    // total. Falls back to pack-wide stats before the compendium loads.
    const tierStats = this._cachedItems
      ? computeTierFilteredStats(this._cachedItems, tierWindow(this._form.tier))
      : null;
    return {
      form: this._form,
      moduleId: MODULE_ID,
      projectedBudgetLabel: formatGp(projectedBudget),
      candidateCount: candidates,
      candidateLabel: this._candidateLabel(candidates, stats.totalItems),
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
        label: titleCase(rarity),
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

  /* ------------------- lifecycle ------------------- */

  async _onRender(context, options) {
    super._onRender?.(context, options);
    const root = this.element;
    if (!root) return;

    // Reflect visual prefs as classes on the root so CSS can opt out.
    root.classList.toggle(
      "lf-no-anim",
      getSetting(SETTING_KEYS.ANIMATIONS) === false,
    );
    root.classList.toggle(
      "lf-no-glow",
      getSetting(SETTING_KEYS.RARITY_GLOW) === false,
    );
    root.classList.toggle(
      "lf-no-skel",
      getSetting(SETTING_KEYS.LOADING_SKELETON) === false,
    );

    // Wire the form so input/change events update `_form` without
    // triggering a re-render — the projected-budget and candidate
    // labels are patched in place.
    const form = root.querySelector("[data-form='loot-forge']");
    if (form) {
      form.addEventListener("input", (event) => this._onFormInput(event));
      form.addEventListener("change", (event) => this._onFormInput(event));
    }

    // Keyboard shortcuts. Scoped to the form so we don't shadow
    // global Foundry hotkeys; `R` is guarded so it doesn't fire
    // while the user is typing in an input/select.
    if (getSetting(SETTING_KEYS.KEYBOARD_SHORTCUTS) !== false) {
      root.addEventListener("keydown", (event) => this._onKeyDown(event));
    }
    if (root.dataset.infinityDnd5eScrollPointerTracked !== "true") {
      root.dataset.infinityDnd5eScrollPointerTracked = "true";
      root.addEventListener(
        "pointerdown",
        () => {
          this._lastScrollState = this._captureScrollState();
        },
        { capture: true, passive: true },
      );
    }

    // Wire drag-and-drop on result tiles so they can be dropped onto
    // character sheets while preserving generated art item data.
    for (const tile of root.querySelectorAll("[data-draggable-result-id]")) {
      tile.addEventListener("dragstart", (event) => {
        const entry = this._findResultEntry(tile.dataset.resultId);
        beginDragFromResult(event, entry);
      });
    }

    for (const image of root.querySelectorAll("[data-result-image]")) {
      image.addEventListener("error", onResultImageError, { once: true });
      if (image.complete && image.naturalWidth === 0) {
        onResultImageError({ currentTarget: image });
      }
    }
    this._bindScrollTracking(root);

    // Background-load the pack on first render so the candidate
    // count and per-rarity numbers are populated before the user
    // touches anything.
    if (!this._packStats && !this._loadingItems) {
      this._primePackStats();
    }
    this._restoreScrollState();
  }

  _captureScrollState() {
    const entries = this._scrollEntries(this.element).map(
      ({ key, element }) => ({
        key,
        left: element.scrollLeft,
        top: element.scrollTop,
      }),
    );
    if (entries.length === 0) return this._lastScrollState;
    return { entries };
  }

  _restoreScrollState() {
    const state = this._pendingScrollState ?? this._lastScrollState;
    this._pendingScrollState = null;
    if (!state) return;

    const restore = () => {
      for (const entry of state.entries ?? []) {
        const element = this._scrollElement(entry.key);
        if (!element) continue;
        const maxTop = Math.max(0, element.scrollHeight - element.clientHeight);
        const maxLeft = Math.max(0, element.scrollWidth - element.clientWidth);
        element.scrollTop = Math.min(entry.top, maxTop);
        element.scrollLeft = Math.min(entry.left, maxLeft);
      }
    };
    restore();
    if (typeof globalThis.requestAnimationFrame === "function") {
      globalThis.requestAnimationFrame(restore);
      globalThis.requestAnimationFrame(() =>
        globalThis.requestAnimationFrame(restore),
      );
    } else {
      restore();
    }
    globalThis.setTimeout?.(restore, 50);
  }

  async _renderPreservingScroll(options) {
    this._pendingScrollState = this._captureScrollState();
    await this.render(options);
  }

  _bindScrollTracking(root) {
    for (const { element } of this._scrollEntries(root)) {
      if (element.dataset.infinityDnd5eScrollTracked === "true") continue;
      element.dataset.infinityDnd5eScrollTracked = "true";
      element.addEventListener(
        "scroll",
        () => {
          this._lastScrollState = this._captureScrollState();
        },
        { passive: true },
      );
    }
  }

  _scrollEntries(root) {
    if (!root) return [];
    return SCROLL_TARGETS.map(({ key, selector }) => ({
      key,
      element: root.querySelector(selector),
    })).filter(({ element }) => Boolean(element));
  }

  _scrollElement(key) {
    const target = SCROLL_TARGETS.find((entry) => entry.key === key);
    if (!target) return null;
    return this.element?.querySelector(target.selector) ?? null;
  }

  _onKeyDown(event) {
    if (event.defaultPrevented) return;
    const target = event.target;
    const tag = target?.tagName?.toLowerCase();
    const isEditable =
      tag === "input" || tag === "select" || tag === "textarea";

    if (event.key === "Enter" && !isEditable) {
      event.preventDefault();
      this._generate();
      return;
    }
    // Submit via Enter even from inside an input (except multi-line
    // textareas, which we don't use). Form submit would bubble to
    // Foundry's frame; preventing it and dispatching Generate keeps
    // behaviour predictable.
    if (event.key === "Enter" && tag === "input") {
      event.preventDefault();
      this._generate();
      return;
    }
    if (
      (event.key === "r" || event.key === "R") &&
      !isEditable &&
      !event.ctrlKey &&
      !event.metaKey
    ) {
      event.preventDefault();
      this._generate();
    }
  }

  _onClose(options) {
    super._onClose?.(options);
    // Snapshot to module memory so the next open restores the form
    // and last result. Cleared on page reload — intentionally not
    // written to a user flag in v0.2.
    if (getSetting(SETTING_KEYS.PERSIST_STATE) !== false) {
      PerEncounterLootApp._persistedState = {
        form: { ...this._form },
        lastResult: this._lastResult,
      };
    } else {
      PerEncounterLootApp._persistedState = null;
    }
    PerEncounterLootApp._instance = null;
  }

  /* ------------------- actions ------------------- */

  /** @this {PerEncounterLootApp} */
  static async _onGenerate(_event, _target) {
    // Fresh generate clears any prior locks — it's a new bundle.
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
  static async _onToggleLock(_event, target) {
    const id = target?.dataset?.itemId;
    if (!id || !this._lastResult) return;
    const entry = this._lastResult.items.find(
      (e) => String(e.resultId ?? e.item._id ?? e.item.id) === id,
    );
    if (!entry) return;
    entry.locked = !entry.locked;
    playModuleSound(SOUND_EVENTS.LOCK_TOGGLE);
    // Patch the DOM directly so we don't lose scroll / focus.
    const li = target.closest("li");
    li?.classList.toggle("is-locked", entry.locked);
    const icon = target.querySelector("i");
    if (icon) {
      icon.classList.toggle("fa-lock-open", !entry.locked);
      icon.classList.toggle("fa-lock", entry.locked);
    }
    target.setAttribute(
      "title",
      entry.locked ? "Locked — won't be re-rolled" : "Lock this item",
    );
  }

  /** @this {PerEncounterLootApp} */
  static async _onSendToChat(_event, _target) {
    if (!this._lastResult || this._lastResult.items.length === 0) {
      playModuleSound(SOUND_EVENTS.WARNING_MUTED);
      ui.notifications?.info("Nothing to send — generate a roll first.");
      return;
    }
    const html = buildLootChatHtml(this._lastResult);
    const messageData = {
      content: html,
      speaker: ChatMessage.getSpeaker({ alias: "Loot Forge" }),
    };
    const whispers = resolveChatRecipients(
      getSetting(SETTING_KEYS.CHAT_MODE) ?? "public",
    );
    if (whispers !== null) messageData.whisper = whispers;
    try {
      await ChatMessage.create(messageData);
      playModuleSound(SOUND_EVENTS.CHAT_SEND);
    } catch (error) {
      playModuleSound(SOUND_EVENTS.WARNING_MUTED);
      console.error(`${MODULE_ID} | failed to send loot to chat`, error);
      ui.notifications?.error("Failed to send loot to chat. See console.");
    }
  }

  /** @this {PerEncounterLootApp} */
  static _onReset(_event, _target) {
    this._form = PerEncounterLootApp.buildDefaultForm();
    playModuleSound(SOUND_EVENTS.CLEAR_RESET);
    renderAfterAction(() => this._renderPreservingScroll(), "reset");
  }

  /** @this {PerEncounterLootApp} */
  static async _onClear(_event, _target) {
    this._lastResult = null;
    playModuleSound(SOUND_EVENTS.CLEAR_RESET);
    await this._renderPreservingScroll();
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
  static async _onChipAll(_event, target) {
    const group = target?.dataset?.group;
    if (group === "rarity") {
      this._form = { ...this._form, rarities: [...RARITIES] };
    } else if (group === "lootType") {
      this._form = { ...this._form, lootTypes: [...LOOT_TYPES] };
    } else {
      return;
    }
    await this._renderPreservingScroll();
  }

  /** @this {PerEncounterLootApp} */
  static async _onChipNone(_event, target) {
    const group = target?.dataset?.group;
    if (group === "rarity") {
      this._form = { ...this._form, rarities: [] };
    } else if (group === "lootType") {
      this._form = { ...this._form, lootTypes: [] };
    } else {
      return;
    }
    await this._renderPreservingScroll();
  }

  /** @this {PerEncounterLootApp} */
  static async _onOpenItem(event, target) {
    const uuid = target?.dataset?.uuid;
    if (!uuid) return;
    try {
      const doc = await fromUuid(uuid);
      if (doc?.sheet) {
        doc.sheet.render(true);
        playModuleSound(SOUND_EVENTS.ITEM_OPEN);
      }
    } catch (error) {
      console.warn(`${MODULE_ID} | failed to open item`, { uuid, error });
    }
  }

  /** @this {PerEncounterLootApp} */
  _findResultEntry(resultId) {
    if (!resultId || !this._lastResult) return null;
    return this._lastResult.items.find(
      (entry) =>
        String(
          entry.resultId ??
            entry.item?._id ??
            entry.item?.id ??
            entry.item?.uuid ??
            "",
        ) === String(resultId),
    );
  }

  /** @this {PerEncounterLootApp} */
  static async _onDistributeOne(_event, target) {
    const entry = this._findResultEntry(target?.dataset?.resultId);
    if (!entry) {
      playModuleSound(SOUND_EVENTS.WARNING_MUTED);
      return;
    }
    const result = await promptDistributeItems([toDistributableItem(entry)]);
    if (result) playModuleSound(SOUND_EVENTS.DEPOSIT);
  }

  /** @this {PerEncounterLootApp} */
  static async _onDistributeBundle(_event, _target) {
    const items = (this._lastResult?.items ?? [])
      .map(toDistributableItem)
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

  /** @this {PerEncounterLootApp} */
  static async _onSnap(_event, target) {
    const name = target?.dataset?.target;
    const raw = Number(target?.dataset?.value);
    if (!name || !Number.isFinite(raw)) return;
    this._form = { ...this._form, [name]: raw };
    await this._renderPreservingScroll();
  }

  /** @this {PerEncounterLootApp} */
  static async _onTierSelect(_event, target) {
    const tier = target?.dataset?.value;
    if (!tier) return;
    this._form = { ...this._form, tier };
    await this._renderPreservingScroll();
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
        next.rarities = readMultiCheckGroup(this.element, "rarity");
        break;
      case "lootType":
        next.lootTypes = readMultiCheckGroup(this.element, "lootType");
        break;
      default:
        return;
    }
    this._form = next;
    // Keep a chip's visual state in sync with its checkbox. We deliberately
    // don't re-render on input (sliders fire continuously), so the
    // server-rendered `is-checked` class would otherwise go stale: a chip
    // could stay highlighted after being unchecked — making the user think a
    // rarity is still selected when the filter (which reads the real checkbox
    // state) has already dropped it.
    if (target.type === "checkbox") {
      target
        .closest(".lf-chip")
        ?.classList.toggle("is-checked", target.checked);
    }
    this._patchLiveReadouts();
  }

  /**
   * Patch every live-reading element without rebuilding the DOM —
   * sliders fire 'input' on every drag step so a full re-render
   * would feel laggy.
   */
  _patchLiveReadouts() {
    if (!this.element) return;
    const budget = formatGp(computeLootBudget(this._formForBudget()));
    setText(this.element, "[data-projected-budget]", budget);

    const root = this.element;
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

    // Filter-affecting changes update the candidate count too.
    const candidates = this._countCandidates();
    const candidateLabel = this._candidateLabel(
      candidates,
      this._packStats?.totalItems ?? 0,
    );
    setText(root, "[data-candidates]", candidateLabel);

    // Sub-label that shows the nearest preset next to the slider value.
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

    // Light up the snap button whose value matches the current slider
    // position. Without this, dragging the slider straight to a preset
    // value wouldn't highlight that preset until the next full render.
    this._syncSnapStates(root, "scaleMultiplier", this._form.scaleMultiplier);
    this._syncSnapStates(
      root,
      "generosityMultiplier",
      this._form.generosityMultiplier,
    );
    this._syncSnapStates(root, "magicBias", this._form.magicBias);
  }

  _syncSnapStates(root, target, value) {
    const snaps = root.querySelectorAll(
      `.lf-slider__snap[data-target="${target}"]`,
    );
    for (const snap of snaps) {
      const snapValue = Number(snap.dataset.value);
      snap.classList.toggle(
        "is-active",
        Number.isFinite(snapValue) && Math.abs(snapValue - value) < 0.01,
      );
    }
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
    // Tier window — chosen tier plus one tier below, so the rarity chips
    // the user checks actually have items behind them. The curated pack
    // tags all real common gear at T1, so without this a T2 encounter
    // with "common" checked would silently produce zero commons. Matches
    // Hoard and Per-Creature behavior.
    return {
      tiers: tierWindow(this._form.tier),
      rarities: this._form.rarities,
      lootTypes: this._form.lootTypes,
      requireEligible: true,
    };
  }

  _countCandidates() {
    if (!this._cachedItems) return 0;
    return filterCandidates(this._cachedItems, this._filterSpec()).length;
  }

  _candidateLabel(count, totalItems) {
    if (!this._packStats) return "—";
    if (count === 0) {
      return `0 items match · pack has ${totalItems.toLocaleString()}`;
    }
    return `${count.toLocaleString()} item${count === 1 ? "" : "s"} match current filters`;
  }

  _sliderContext({ name, value, range, presets, valueLabel }) {
    const presetLabel = presets ? titleCase(nearestPreset(value, presets)) : "";
    return {
      name,
      label: SLIDER_LABELS[name] ?? name,
      value,
      min: range.min,
      max: range.max,
      step: range.step,
      valueLabel,
      // Suppress the secondary preset chip when it would just echo the
      // primary value label (e.g. Magic Bias at 0 → both say "Neutral").
      presetLabel: presetLabel === valueLabel ? "" : presetLabel,
      snaps: presets
        ? Object.entries(presets).map(([key, target]) => ({
            key,
            label: titleCase(key),
            value: target,
            active: Math.abs(value - target) < 0.01,
          }))
        : null,
    };
  }

  /* ------------------- generation pipeline ------------------- */

  async _generate({ preserveLocked = false } = {}) {
    if (this._loadingItems) return; // re-entrant click guard
    let generatedResult = null;

    const lockedEntries =
      preserveLocked && this._lastResult
        ? this._lastResult.items.filter((entry) => entry.locked)
        : [];

    const needsLoad = !this._isItemCacheFresh();
    if (needsLoad) {
      this._loadingItems = true;
      playModuleSound(SOUND_EVENTS.LOADING_SHIMMER);
      await this._renderPreservingScroll(); // surfaces the "Loading compendium…" placeholder
    }

    try {
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

      // When locks have already met or exceeded the total budget, do NOT
      // call rollLoot with budgetGp:0 — that disables budget enforcement
      // entirely and the additional picks come out unbounded. Skip the
      // roll and surface a warning so the GM understands why no items
      // were added. (totalBudget=0 is the "no budget set" case and isn't
      // a problem; only locks-exceed-budget is.)
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

      const decorate = (entry) => ({
        ...entry,
        resultId:
          entry.variant?.id ?? String(entry.item._id ?? entry.item.id ?? ""),
        displayName: entry.displayName || entry.item.name,
        imageSrc: resultImageForEntry(entry),
        variantSummary: entry.variant?.summary ?? "",
        sourceLabel: entry.variant ? `Base: ${entry.variant.baseName}` : "",
        valueLabel: entry.valueLabel ?? "",
        locked: false,
        rarity: getItemRarity(entry.item) || "common",
        quantityLabel:
          entry.quantity > 1 || isAmmunitionItem(entry.item)
            ? `×${entry.quantity} · `
            : "",
        gpTotalLabel: formatGp(entry.gpTotal),
      });

      const mergedItems = [...lockedEntries, ...raw.items.map(decorate)].sort(
        (a, b) => b.gpTotal - a.gpTotal,
      );
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
      if (generatedResult) playResultSound(generatedResult);
    }
  }

  /** Background-load the pack the first time the window renders. */
  async _primePackStats() {
    this._loadingItems = true;
    playModuleSound(SOUND_EVENTS.LOADING_SHIMMER);
    try {
      await this._loadItems();
    } catch (error) {
      this._packStats = computePackStats([]);
      console.error(`${MODULE_ID} | failed to preload loot pack stats`, error);
      ui.notifications?.warn(
        "Infinity D&D5e could not preload loot pack stats. Rolls can be retried after the compendium is available.",
      );
    } finally {
      this._loadingItems = false;
      if (this.rendered) await this._renderPreservingScroll();
    }
  }

  _isItemCacheFresh() {
    const minutes = Number(getSetting(SETTING_KEYS.PACK_TTL_MINUTES) ?? 5);
    const ttlMs =
      Math.max(1, Number.isFinite(minutes) ? minutes : 5) * 60 * 1000;
    return Boolean(
      this._cachedItems && Date.now() - this._cachedItemsAt < ttlMs,
    );
  }

  /**
   * Load the bundled compendium and cache it per session.
   *
   * Uses {@link loadCompendiumItems} which calls `getDocuments()` —
   * the older `getIndex({fields:["flags.party-operations"]})` path
   * silently strips the namespaced flag subtree on some Foundry
   * versions, leaving items without tier/lootType/gpValue and
   * collapsing the candidate pool to empty.
   */
  async _loadItems() {
    if (this._isItemCacheFresh()) return this._cachedItems;
    this._cachedItems = await loadCompendiumItems({ packId: PACK_ID });
    this._cachedItemsAt = Date.now();
    this._packStats = computePackStats(this._cachedItems);
    return this._cachedItems;
  }
}

/* ------------------------------------------------------------------ *
 * Helpers
 * ------------------------------------------------------------------ */

function tierLabel(tier) {
  const map = {
    t1: "T1 — Lvl 1–4",
    t2: "T2 — Lvl 5–10",
    t3: "T3 — Lvl 11–16",
    t4: "T4 — Lvl 17–20",
    t5: "T5 — Epic",
  };
  return map[tier] ?? tier;
}

function itemLimitValueLabel(count) {
  const value = clampInt(count, COUNT_RANGE.min, COUNT_RANGE.max, 6);
  return `Max ${value} item${value === 1 ? "" : "s"}`;
}

function toDistributableItem(entry) {
  if (!entry) return null;
  const quantity = Math.max(1, Math.floor(Number(entry.quantity) || 1));
  if (entry.itemData) {
    return {
      itemData: entry.itemData,
      name: entry.displayName ?? entry.itemData.name ?? entry.item?.name ?? "",
      quantity,
    };
  }
  const uuid = entry.item?.uuid;
  return uuid
    ? { uuid, name: entry.displayName ?? entry.item?.name ?? "", quantity }
    : null;
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

function resultImageForEntry(entry) {
  const image = String(
    entry?.imageSrc ?? entry?.itemData?.img ?? entry?.item?.img ?? "",
  ).trim();
  if (!image) return FALLBACK_ITEM_IMAGE;
  if (image.startsWith("assets/item-art/")) {
    return `modules/${MODULE_ID}/${image}`;
  }
  return image;
}

function onResultImageError(event) {
  const image = event.currentTarget;
  if (!image || image.dataset.fallbackApplied === "true") return;
  const fallbackSrc = image.dataset.fallbackSrc || FALLBACK_ITEM_IMAGE;
  image.dataset.fallbackApplied = "true";
  image.classList.add("is-fallback");
  if (image.getAttribute("src") !== fallbackSrc) image.src = fallbackSrc;
}

function renderAfterAction(callback, action) {
  try {
    const result = callback();
    if (typeof result?.catch === "function") {
      result.catch((error) =>
        console.warn(`${MODULE_ID} | ${action} render failed`, error),
      );
    }
  } catch (error) {
    console.warn(`${MODULE_ID} | ${action} render failed`, error);
  }
}

/**
 * Build the chat-card HTML for a roll result. Items are rendered as
 * Foundry UUID links so clicking from chat opens the compendium
 * item sheet. Kept here as a plain function so it stays templatable
 * via simple string concatenation — chat messages run outside the
 * window's part-rendering pipeline.
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

/**
 * Resolve a Send-to-Chat mode string to a whisper recipient list.
 * Returns `null` for public mode (caller skips setting `whisper`).
 *
 * - "public"           → null (no whisper, message goes to everyone)
 * - "whisper-gm"       → user ids of all currently-active GMs
 * - "whisper-players"  → user ids of all currently-active non-GM users
 */
function resolveChatRecipients(mode) {
  if (mode === "public") return null;
  const users = globalThis.game?.users;
  if (!users) return null;
  const list = users.values?.() ?? users;
  const out = [];
  for (const user of list) {
    if (!user?.active) continue;
    const isGM = user.isGM === true || user.role >= 4; // ROLE.GAMEMASTER === 4
    if (mode === "whisper-gm" && isGM) out.push(user.id);
    if (mode === "whisper-players" && !isGM) out.push(user.id);
  }
  return out;
}

/**
 * Read the live player-character count from Foundry. Returns 0 when
 * the game isn't initialized (e.g. in tests) so the caller can fall
 * back gracefully.
 */
function livePartySize() {
  const users = globalThis.game?.users;
  if (!users) return 0;
  let count = 0;
  for (const user of users.values?.() ?? users) {
    if (user?.character && user?.active !== false) count += 1;
  }
  return count;
}

/** Set element.textContent if the element exists; no-op otherwise. */
function setText(root, selector, text) {
  const el = root.querySelector(selector);
  if (el) el.textContent = String(text ?? "");
}

/** Collect every checked input[name="<group>"] inside a form. */
function readMultiCheckGroup(root, group) {
  if (!root) return [];
  return [
    ...root.querySelectorAll(`input[type='checkbox'][name='${group}']:checked`),
  ].map((el) => el.value);
}
