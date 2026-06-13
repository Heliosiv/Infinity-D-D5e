/**
 * Infinity D&D5e — BaseLootApp
 *
 * Shared ApplicationV2 host for the three loot windows (Per-Encounter,
 * Hoard, Per-Creature). It owns the lifecycle the tools have in common —
 * singleton open/close, pack loading, the `_onRender` scaffold, scroll
 * preservation, slider/snap context, candidate counting, the generic
 * action handlers (reset/clear/open/snap/chips/send-to-chat), and the
 * item-level controls (lock / delete / quantity / reroll-one).
 *
 * Subclasses provide their identity (`static DEFAULT_OPTIONS`/`PARTS`,
 * `FORM_NAME`, `SCROLL_TARGETS`, `CHAT_ALIAS`), their `buildDefaultForm`
 * + `_prepareContext` + `_onFormInput` + `_patchLiveReadouts` +
 * `_filterSpec`, and a handful of small hooks (`_primaryGenerate`,
 * `_buildChatHtml`, `_hasChatResult`, `_eachEntryList`, `_onRenderTool`,
 * `_snapLabel`). Shared static handlers are exposed via
 * {@link BaseLootApp.SHARED_ACTIONS} so each subclass can spread them
 * into its own `actions` map.
 *
 * ApplicationV2 merges `static DEFAULT_OPTIONS`/`PARTS` down the
 * prototype chain, and action handlers referenced by name resolve
 * against the subclass — so a base static method works as a handler for
 * every subclass.
 */

import { SOUND_EVENTS, playModuleSound, playResultSound } from "../audio.js";
import {
  depositToActors,
  planEvenSplit,
  promptDistributeItems,
  promptDistributeSplit,
} from "./distribute.js";
import { buildJournalEntry } from "./journal.js";
import { loadCompendiumItems } from "./pack.js";
import { computePackStats } from "./pack-stats.js";
import { filterCandidates, itemIdentity, rerollOne } from "./roller.js";
import {
  getItemMaxQty,
  getItemRarity,
  isAmmunitionItem,
} from "./tag-vocabulary.js";
import { SETTING_KEYS, getSetting } from "../settings.js";
import { formatGp, plainTextLootSummary, titleCase } from "../ui-util.js";
import { nearestPreset } from "./budget.js";
import {
  clampGp,
  formatValueRange,
  marketTierOptions,
  valueFilterSpec,
} from "./value-filter.js";
import {
  clearHistory,
  deletePreset,
  exportPresets,
  getHistoryEntry,
  getPreset,
  importPresets,
  listHistory,
  listPresets,
  pushHistory,
  savePreset,
} from "./loot-store.js";
import {
  MODULE_ID,
  bindRowDoubleClickOpen,
  copyTextToClipboard,
  decorateEntry,
  downloadJson,
  onResultImageError,
  openItemByUuid,
  pickJsonFile,
  renderAfterAction,
  resolveChatRecipients,
  resultImageForEntry,
  selectedTokenActorIds,
  setText,
  toDistributableEntry,
} from "./loot-app-shared.js";

const PACK_ID = `${MODULE_ID}.infinity-dnd5e-items`;

const { ApplicationV2, HandlebarsApplicationMixin } = foundry.applications.api;

function cloneData(value) {
  if (value == null) return value;
  if (typeof structuredClone === "function") return structuredClone(value);
  return JSON.parse(JSON.stringify(value));
}

/** Slim a result for history storage — drop heavy item docs to uuid/name/img. */
function slimResult(result) {
  const copy = cloneData(result);
  const slim = (items) => {
    if (!Array.isArray(items)) return;
    for (const entry of items) {
      if (entry?.item) {
        entry.item = {
          uuid: entry.item.uuid,
          name: entry.item.name,
          img: entry.item.img,
        };
      }
    }
  };
  if (copy && Array.isArray(copy.items)) slim(copy.items);
  if (copy && Array.isArray(copy.creatures)) {
    for (const creature of copy.creatures) slim(creature.items);
  }
  return copy;
}

/** One-line summary of a stored roll for the history list. */
function summarizeResult(result) {
  if (!result) return "—";
  if (Array.isArray(result.creatures)) {
    return `${result.creatures.length} creature(s) · ${result.grandTotalLabel ?? ""}`;
  }
  return `${result.items?.length ?? 0} item(s) · ${result.totalGpLabel ?? ""}`;
}

export class BaseLootApp extends HandlebarsApplicationMixin(ApplicationV2) {
  /* --------------- subclass-provided static config --------------- */

  /** `data-form` attribute the window's <form> carries. */
  static FORM_NAME = "";
  /** Compendium id every tool rolls from. */
  static PACK_ID = PACK_ID;
  /** Scroll containers to preserve across re-renders. */
  static SCROLL_TARGETS = Object.freeze([
    { key: "windowContent", selector: ".window-content" },
  ]);
  /** Chat speaker alias for Send-to-Chat. */
  static CHAT_ALIAS = "Infinity D&D5e";

  /** Store key for presets + history; each subclass sets its own. */
  static TOOL_ID = "";

  /** Shared action handlers, spread into each subclass's `actions`. */
  static get SHARED_ACTIONS() {
    return {
      reset: this._onReset,
      clear: this._onClear,
      openItem: this._onOpenItem,
      snap: this._onSnap,
      marketTier: this._onMarketTier,
      chipAll: this._onChipAll,
      chipNone: this._onChipNone,
      sendToChat: this._onSendToChat,
      copyToClipboard: this._onCopyToClipboard,
      distributeOne: this._onDistributeOne,
      distributeSplit: this._onDistributeSplit,
      distributeToSelected: this._onDistributeToSelected,
      exportJournal: this._onExportJournal,
      toggleLock: this._onToggleLock,
      deleteItem: this._onDeleteItem,
      itemQtyInc: this._onItemQtyInc,
      itemQtyDec: this._onItemQtyDec,
      rerollOne: this._onRerollOne,
      savePreset: this._onSavePreset,
      loadPreset: this._onLoadPreset,
      deletePreset: this._onDeletePreset,
      exportPresets: this._onExportPresets,
      importPresets: this._onImportPresets,
      loadHistory: this._onLoadHistory,
      clearHistory: this._onClearHistory,
      undo: this._onUndo,
    };
  }

  /** SHARED_ACTIONS minus the named keys — used by tools that don't expose a
   *  given control (e.g. Hoard/Per-Creature omit `toggleLock`, which only does
   *  something on Per-Encounter's Re-roll Unlocked). */
  static sharedActionsExcept(...omit) {
    const actions = { ...this.SHARED_ACTIONS };
    for (const key of omit) delete actions[key];
    return actions;
  }

  /* ------------------- singleton ------------------- */

  /** Open (or focus) the per-subclass singleton instance. */
  static open() {
    playModuleSound(SOUND_EVENTS.UI_OPEN);
    if (!this._instance) this._instance = new this();
    if (this._instance.rendered) this._instance.bringToFront();
    else this._instance.render(true);
    return this._instance;
  }

  constructor(options = {}) {
    super(options);
    this._loadingItems = false;
    this._cachedItems = null;
    this._cachedItemsAt = 0;
    this._packStats = null;
    this._pendingScrollState = null;
    this._lastScrollState = null;
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

    // Wire the form so input/change events update `_form` without a
    // full re-render — readouts are patched in place.
    const formName = this.constructor.FORM_NAME;
    const form = formName
      ? root.querySelector(`[data-form='${formName}']`)
      : null;
    if (form) {
      form.addEventListener("input", (event) => this._onFormInput(event));
      form.addEventListener("change", (event) => this._onFormInput(event));
    }

    // Result search box (client-side filter, no re-render).
    const search = root.querySelector("[data-result-search]");
    if (search) {
      search.addEventListener("input", (event) =>
        this._applyResultSearch(String(event.target.value ?? "")),
      );
    }

    // Keyboard shortcuts — bound once (this.element is stable across
    // ApplicationV2 re-renders, so re-binding would stack listeners).
    if (root.dataset.infinityDnd5eKeydownBound !== "true") {
      root.dataset.infinityDnd5eKeydownBound = "true";
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

    // Drag result tiles onto sheets, preserving generated art data.
    for (const tile of root.querySelectorAll("[data-draggable-result-id]")) {
      tile.addEventListener("dragstart", (event) => {
        const entry = this._findEntry(
          tile.dataset.resultId ?? tile.dataset.entryId,
        );
        this._beginDrag(event, entry);
      });
    }

    for (const image of root.querySelectorAll("[data-result-image]")) {
      image.addEventListener("error", onResultImageError, { once: true });
      if (image.complete && image.naturalWidth === 0) {
        onResultImageError({ currentTarget: image });
      }
    }

    // Repo-wide standard: double-click an item row to open its sheet.
    bindRowDoubleClickOpen(root, {
      rowSelector: "li[data-uuid]",
      onOpen: (uuid) =>
        openItemByUuid(uuid, {
          onOpened: () => playModuleSound(SOUND_EVENTS.ITEM_OPEN),
        }),
    });

    this._bindScrollTracking(root);

    if (!this._packStats && !this._loadingItems) {
      this._primePackStats();
    }

    this._onRenderTool?.(context, options);
    this._restoreScrollState();
  }

  /** Tool-specific drag payload; overridden by Per-Encounter. */
  _beginDrag() {}

  _onClose(options) {
    super._onClose?.(options);
    const Cls = this.constructor;
    if (getSetting(SETTING_KEYS.PERSIST_STATE) !== false) {
      Cls._persistedState = this._snapshotState();
    } else {
      Cls._persistedState = null;
    }
    Cls._instance = null;
  }

  /** Default persisted snapshot; Per-Creature widens it for the roster. */
  _snapshotState() {
    return { form: { ...this._form }, lastResult: this._lastResult };
  }

  /* ------------------- scroll preservation ------------------- */

  _scrollTargets() {
    return this.constructor.SCROLL_TARGETS ?? [];
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
    return this._scrollTargets()
      .map(({ key, selector }) => ({
        key,
        element: root.querySelector(selector),
      }))
      .filter(({ element }) => Boolean(element));
  }

  _scrollElement(key) {
    const target = this._scrollTargets().find((entry) => entry.key === key);
    if (!target) return null;
    return this.element?.querySelector(target.selector) ?? null;
  }

  /* ------------------- keyboard ------------------- */

  _onKeyDown(event) {
    if (getSetting(SETTING_KEYS.KEYBOARD_SHORTCUTS) === false) return;
    if (event.defaultPrevented) return;
    const tag = event.target?.tagName?.toLowerCase();
    const isEditable =
      tag === "input" || tag === "select" || tag === "textarea";
    if (event.key === "Enter" && (!isEditable || tag === "input")) {
      event.preventDefault();
      this._primaryGenerate();
      return;
    }
    if (
      (event.key === "r" || event.key === "R") &&
      !isEditable &&
      !event.ctrlKey &&
      !event.metaKey
    ) {
      event.preventDefault();
      this._primaryGenerate();
    }
  }

  /** Subclass hook: what Enter/R triggers. Defaults to `_generate`. */
  _primaryGenerate() {
    return this._generate?.();
  }

  /* ------------------- pack loading ------------------- */

  _isItemCacheFresh() {
    const minutes = Number(getSetting(SETTING_KEYS.PACK_TTL_MINUTES) ?? 5);
    const ttlMs =
      Math.max(1, Number.isFinite(minutes) ? minutes : 5) * 60 * 1000;
    return Boolean(
      this._cachedItems && Date.now() - this._cachedItemsAt < ttlMs,
    );
  }

  async _loadItems() {
    if (this._isItemCacheFresh()) return this._cachedItems;
    this._cachedItems = await loadCompendiumItems({
      packId: this.constructor.PACK_ID,
    });
    this._cachedItemsAt = Date.now();
    this._packStats = computePackStats(this._cachedItems);
    return this._cachedItems;
  }

  async _primePackStats() {
    this._loadingItems = true;
    playModuleSound(SOUND_EVENTS.LOADING_SHIMMER);
    try {
      await this._loadItems();
    } catch (error) {
      this._packStats = computePackStats([]);
      console.error(`${MODULE_ID} | failed to preload loot pack stats`, error);
      ui.notifications?.warn(
        "Infinity D&D5e could not preload loot pack stats. Rolls can be retried once the compendium is available.",
      );
    } finally {
      this._loadingItems = false;
      if (this.rendered) await this._renderPreservingScroll();
    }
  }

  /* ------------------- candidates + sliders ------------------- */

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

  /** Label for a snap preset key. Hoard overrides to humanizeKey. */
  _snapLabel(key) {
    return titleCase(key);
  }

  _sliderContext({ name, value, range, presets, valueLabel }) {
    const presetLabel = presets
      ? this._snapLabel(nearestPreset(value, presets))
      : "";
    return {
      name,
      label: this.constructor.SLIDER_LABELS?.[name] ?? name,
      value,
      min: range.min,
      max: range.max,
      step: range.step,
      valueLabel,
      presetLabel: presetLabel === valueLabel ? "" : presetLabel,
      snaps: presets
        ? Object.entries(presets).map(([key, target]) => ({
            key,
            label: this._snapLabel(key),
            value: target,
            active: Math.abs(value - target) < 0.01,
          }))
        : null,
    };
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

  /* ------------------- result-entry access ------------------- */

  /**
   * Every list of decorated entries this tool holds. Flat tools return
   * `[items]`; Per-Creature returns one array per creature. Used by the
   * shared item-level handlers so they work on any tool shape.
   */
  _eachEntryList() {
    return this._lastResult?.items ? [this._lastResult.items] : [];
  }

  _findEntry(entryId) {
    if (!entryId) return null;
    const id = String(entryId);
    for (const list of this._eachEntryList()) {
      const entry = list.find((e) => String(e.entryId ?? e.resultId) === id);
      if (entry) return entry;
    }
    return null;
  }

  _findEntryList(entryId) {
    if (!entryId) return null;
    const id = String(entryId);
    for (const list of this._eachEntryList()) {
      if (list.some((e) => String(e.entryId ?? e.resultId) === id)) return list;
    }
    return null;
  }

  /** Recompute per-list and grand totals after a mutation. Subclass hook. */
  _recomputeTotals() {
    if (!this._lastResult?.items) return;
    const totalGp = this._lastResult.items.reduce(
      (sum, e) => sum + (e.gpTotal ?? 0),
      0,
    );
    this._lastResult.totalGp = totalGp;
    this._lastResult.totalGpLabel = formatGp(totalGp);
  }

  /* ------------------- generic actions ------------------- */

  /** @this {BaseLootApp} */
  static _onReset(_event, _target) {
    this._form = this.constructor.buildDefaultForm();
    playModuleSound(SOUND_EVENTS.CLEAR_RESET);
    renderAfterAction(() => this._renderPreservingScroll(), "reset");
  }

  /** @this {BaseLootApp} */
  static async _onClear(_event, _target) {
    if (this._lastResult) this._pushUndo();
    this._lastResult = null;
    playModuleSound(SOUND_EVENTS.CLEAR_RESET);
    await this._renderPreservingScroll();
  }

  /** @this {BaseLootApp} */
  static async _onOpenItem(_event, target) {
    await openItemByUuid(target?.dataset?.uuid, {
      onOpened: () => playModuleSound(SOUND_EVENTS.ITEM_OPEN),
    });
  }

  /** @this {BaseLootApp} */
  static async _onSnap(_event, target) {
    const name = target?.dataset?.target;
    const raw = Number(target?.dataset?.value);
    if (!name || !Number.isFinite(raw)) return;
    this._form = { ...this._form, [name]: raw };
    await this._renderPreservingScroll();
  }

  /** @this {BaseLootApp} — apply a one-click market-tier value band. */
  static async _onMarketTier(_event, target) {
    const min = clampGp(target?.dataset?.min, 0);
    const max = clampGp(target?.dataset?.max, 0);
    this._form = { ...this._form, minItemGp: min, maxItemGp: max };
    playModuleSound(SOUND_EVENTS.PRESET_APPLY);
    await this._renderPreservingScroll();
  }

  /** The { minGp, maxGp } value slice each tool spreads into its filter spec. */
  _valueFilter() {
    return valueFilterSpec(this._form);
  }

  /** Market-tier buttons + value-range label; spread into _prepareContext. */
  _marketContext() {
    const min = this._form?.minItemGp ?? 0;
    const max = this._form?.maxItemGp ?? 0;
    return {
      minItemGp: min,
      maxItemGp: max,
      valueRangeLabel: formatValueRange(min, max),
      marketTiers: marketTierOptions(min, max),
    };
  }

  /** Live value-range label for in-place readout patching (no re-render). */
  _valueRangeLabel() {
    return formatValueRange(
      this._form?.minItemGp ?? 0,
      this._form?.maxItemGp ?? 0,
    );
  }

  /** @this {BaseLootApp} */
  static async _onChipAll(_event, target) {
    if (this._setChipGroup(target?.dataset?.group, true)) {
      await this._renderPreservingScroll();
    }
  }

  /** @this {BaseLootApp} */
  static async _onChipNone(_event, target) {
    if (this._setChipGroup(target?.dataset?.group, false)) {
      await this._renderPreservingScroll();
    }
  }

  /**
   * Select/deselect every option in a chip group. Subclass provides the
   * option universe via `_chipUniverse(group)`. Returns true if applied.
   */
  _setChipGroup(group, selectAll) {
    const all = this._chipUniverse(group);
    if (!all) return false;
    const key = group === "rarity" ? "rarities" : "lootTypes";
    this._form = { ...this._form, [key]: selectAll ? [...all] : [] };
    return true;
  }

  /** @this {BaseLootApp} */
  static async _onSendToChat(_event, _target) {
    if (!this._hasChatResult()) {
      playModuleSound(SOUND_EVENTS.WARNING_MUTED);
      ui.notifications?.info("Nothing to send — generate a roll first.");
      return;
    }
    const messageData = {
      content: this._buildChatHtml(this._lastResult),
      speaker: ChatMessage.getSpeaker({ alias: this.constructor.CHAT_ALIAS }),
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

  _hasChatResult() {
    return Boolean(this._lastResult);
  }

  /** Plain-text summary of the current result for clipboard / paste. */
  _buildPlainText(result) {
    return plainTextLootSummary(result, { title: this.constructor.CHAT_ALIAS });
  }

  /** @this {BaseLootApp} */
  static async _onCopyToClipboard(_event, _target) {
    if (!this._hasChatResult()) {
      playModuleSound(SOUND_EVENTS.WARNING_MUTED);
      ui.notifications?.info("Nothing to copy — generate a roll first.");
      return;
    }
    const copied = await copyTextToClipboard(
      this._buildPlainText(this._lastResult),
    );
    if (copied) {
      playModuleSound(SOUND_EVENTS.CHAT_SEND);
      ui.notifications?.info("Loot summary copied to clipboard.");
    } else {
      playModuleSound(SOUND_EVENTS.WARNING_MUTED);
      ui.notifications?.warn(
        "Could not copy to clipboard — your browser blocked clipboard access.",
      );
    }
  }

  /** @this {BaseLootApp} */
  static async _onDistributeOne(_event, target) {
    const entry = this._findEntry(
      target?.dataset?.entryId ?? target?.dataset?.resultId,
    );
    if (!entry) {
      playModuleSound(SOUND_EVENTS.WARNING_MUTED);
      return;
    }
    const result = await promptDistributeItems([toDistributableEntry(entry)]);
    if (result) playModuleSound(SOUND_EVENTS.DEPOSIT);
  }

  /**
   * The full haul to distribute — items (+ optional coin currency).
   * Default flattens every entry list; Hoard overrides to add its coins.
   */
  _distributableHaul() {
    const items = this._eachEntryList()
      .flat()
      .map(toDistributableEntry)
      .filter(Boolean);
    return { items, currency: null };
  }

  /** @this {BaseLootApp} */
  static async _onDistributeSplit(_event, _target) {
    if (!this._hasChatResult()) {
      playModuleSound(SOUND_EVENTS.WARNING_MUTED);
      ui.notifications?.info("Nothing to distribute — generate a roll first.");
      return;
    }
    const { items, currency } = this._distributableHaul();
    if (items.length === 0 && !currency) {
      playModuleSound(SOUND_EVENTS.WARNING_MUTED);
      return;
    }
    const result = await promptDistributeSplit(items, {
      currency,
      title: "Split Across Party",
    });
    if (result?.created) playModuleSound(SOUND_EVENTS.DEPOSIT);
  }

  /**
   * Split the haul across the characters of the currently selected canvas
   * tokens — the no-dialog counterpart to Split. Skips the picker entirely,
   * using `canvas.tokens.controlled` as the recipient set.
   * @this {BaseLootApp}
   */
  static async _onDistributeToSelected(_event, _target) {
    if (!this._hasChatResult()) {
      playModuleSound(SOUND_EVENTS.WARNING_MUTED);
      ui.notifications?.info("Nothing to distribute — generate a roll first.");
      return;
    }
    const actorIds = selectedTokenActorIds();
    if (actorIds.length === 0) {
      playModuleSound(SOUND_EVENTS.WARNING_MUTED);
      ui.notifications?.info(
        "Select one or more linked character tokens on the canvas first.",
      );
      return;
    }
    const { items, currency } = this._distributableHaul();
    if (items.length === 0 && !currency) {
      playModuleSound(SOUND_EVENTS.WARNING_MUTED);
      return;
    }
    const assignments = planEvenSplit(items, currency, actorIds);
    const result = await depositToActors(assignments, { notify: true });
    if (result?.created || result?.recipients?.length) {
      playModuleSound(SOUND_EVENTS.DEPOSIT);
    }
  }

  /** @this {BaseLootApp} */
  static async _onExportJournal(_event, _target) {
    if (!this._hasChatResult()) {
      playModuleSound(SOUND_EVENTS.WARNING_MUTED);
      ui.notifications?.info("Nothing to export — generate a roll first.");
      return;
    }
    await buildJournalEntry({
      title: `${this.constructor.CHAT_ALIAS} — ${summarizeResult(this._lastResult)}`,
      html: this._buildChatHtml(this._lastResult),
    });
    playModuleSound(SOUND_EVENTS.CHAT_SEND);
  }

  /* ------------------- item-level controls ------------------- */

  /** @this {BaseLootApp} */
  static async _onToggleLock(_event, target) {
    const entry = this._findEntry(
      target?.dataset?.entryId ?? target?.dataset?.itemId,
    );
    if (!entry) return;
    entry.locked = !entry.locked;
    playModuleSound(SOUND_EVENTS.LOCK_TOGGLE);
    // Patch DOM in place so scroll/focus survive.
    const li = target.closest("li");
    li?.classList.toggle("is-locked", entry.locked);
    const icon = target.querySelector("i");
    if (icon) {
      icon.classList.toggle("fa-lock-open", !entry.locked);
      icon.classList.toggle("fa-lock", entry.locked);
    }
    target.setAttribute("aria-pressed", entry.locked ? "true" : "false");
    target.setAttribute(
      "title",
      entry.locked ? "Locked — won't be re-rolled" : "Lock this item",
    );
  }

  /** @this {BaseLootApp} */
  static async _onDeleteItem(_event, target) {
    const entryId = target?.dataset?.entryId;
    const list = this._findEntryList(entryId);
    if (!list) return;
    const idx = list.findIndex(
      (e) => String(e.entryId ?? e.resultId) === String(entryId),
    );
    if (idx < 0) return;
    this._pushUndo();
    list.splice(idx, 1);
    playModuleSound(SOUND_EVENTS.CLEAR_RESET);
    this._recomputeTotals();
    await this._renderPreservingScroll();
  }

  /** @this {BaseLootApp} */
  static async _onItemQtyInc(_event, target) {
    await this.constructor._adjustQty.call(this, target, +1);
  }

  /** @this {BaseLootApp} */
  static async _onItemQtyDec(_event, target) {
    await this.constructor._adjustQty.call(this, target, -1);
  }

  /** @this {BaseLootApp} */
  static async _adjustQty(target, delta) {
    const entry = this._findEntry(target?.dataset?.entryId);
    if (!entry) return;
    // Unique art variants are one-of-a-kind — quantity is fixed at 1.
    if (entry.variant) {
      playModuleSound(SOUND_EVENTS.WARNING_MUTED);
      return;
    }
    const max = Math.max(1, getItemMaxQty(entry.item));
    const current = Math.max(1, Math.floor(Number(entry.quantity) || 1));
    const next = Math.min(max, Math.max(1, current + delta));
    if (next === current) {
      // At a limit — acknowledge instead of a silent dead click.
      playModuleSound(SOUND_EVENTS.WARNING_MUTED);
      if (delta > 0 && current >= max) {
        ui.notifications?.info(
          `${entry.displayName ?? entry.item?.name ?? "This item"} is at its max quantity (${max}).`,
        );
      }
      return;
    }
    this._pushUndo();
    const unit = entry.gpUnit ?? (current > 0 ? entry.gpTotal / current : 0);
    entry.gpUnit = unit;
    entry.quantity = next;
    entry.gpTotal = Math.round(unit * next);
    entry.gpTotalLabel = formatGp(entry.gpTotal);
    entry.quantityLabel =
      entry.quantity > 1 || isAmmunitionItem(entry.item)
        ? `×${entry.quantity} · `
        : "";
    playModuleSound(SOUND_EVENTS.LOCK_TOGGLE);
    this._recomputeTotals();
    await this._renderPreservingScroll();
  }

  /** @this {BaseLootApp} */
  static async _onRerollOne(_event, target) {
    if (this._loadingItems) return;
    const entryId = target?.dataset?.entryId;
    const list = this._findEntryList(entryId);
    if (!list) return;
    const idx = list.findIndex(
      (e) => String(e.entryId ?? e.resultId) === String(entryId),
    );
    if (idx < 0) return;
    const old = list[idx];

    playModuleSound(SOUND_EVENTS.ROLL_START);
    const items = await this._loadItems();
    const candidates = filterCandidates(items, this._rerollFilterSpec(old));

    // Scope the freed budget and the dedup set to the SAME entry-list the slot
    // lives in. For flat tools (Hoard / Per-Encounter) that list is the whole
    // table, so this is unchanged; for Per-Creature it is just the owning
    // creature's drops, so a goblin's reroll can't be charged against — or
    // deduped against — another creature's loot.
    const otherGp = list
      .filter((e) => e !== old)
      .reduce((sum, e) => sum + (e.gpTotal ?? 0), 0);
    // Budget freed by this slot = the list's budget minus everything else in it.
    const budgetGp = Math.max(0, this._rerollBudgetForList(list) - otherGp);
    // Exclude the other items in this list so the swap doesn't duplicate them.
    // Use the shared uuid-first identity so dedup still works after a history
    // entry is restored (slimResult keeps uuid but drops _id/id).
    const excludeIds = new Set(
      list.filter((e) => e !== old).map((e) => itemIdentity(e.item)),
    );

    const replacement = rerollOne(candidates, {
      excludeIds,
      budgetGp,
      magicBias: this._form.magicBias ?? 0,
      rarityWeights: this._form.rarityWeights,
      artVariants: Boolean(old.variant) || Boolean(this._form.artVariants),
    });

    if (!replacement) {
      playModuleSound(SOUND_EVENTS.WARNING_MUTED);
      ui.notifications?.info(
        "No affordable replacement found — keeping the current item.",
      );
      return;
    }
    this._pushUndo();
    list[idx] = this._decorateEntry(replacement);
    this._recomputeTotals();
    await this._renderPreservingScroll();
    playResultSound({ items: [list[idx]] });
  }

  /** Filter spec for a single-slot reroll; defaults to the form spec. */
  _rerollFilterSpec(_oldEntry) {
    return this._filterSpec();
  }

  /**
   * The gp budget a single-slot reroll should fit within for the given
   * entry-list. Flat tools store one budget on `_lastResult`; Per-Creature
   * overrides this to return the owning creature's per-creature budget. A 0
   * (or absent) budget leaves the reroll unbounded, matching the roll that
   * produced the slot.
   */
  _rerollBudgetForList(_list) {
    return this._lastResult?.budgetGp ?? 0;
  }

  /** Decorate a raw rolled entry for display + item controls. */
  _decorateEntry(entry) {
    return decorateEntry(entry, {
      imageSrc: resultImageForEntry(entry),
      rarity: getItemRarity(entry.item) || "common",
      isAmmo: isAmmunitionItem(entry.item),
    });
  }

  /* ------------------- result search ------------------- */

  _applyResultSearch(query) {
    const root = this.element;
    if (!root) return;
    const needle = query.trim().toLowerCase();
    let shown = 0;
    for (const li of root.querySelectorAll("[data-result-item]")) {
      const hay = (li.dataset.searchText ?? li.textContent ?? "").toLowerCase();
      const match = !needle || hay.includes(needle);
      li.toggleAttribute("hidden", !match);
      if (match) shown += 1;
    }
    setText(root, "[data-search-count]", needle ? `${shown} shown` : "");
  }

  /* ------------------- presets + history + undo ------------------- */

  /** Context the preset/history menu needs — spread into _prepareContext. */
  _basePresetContext() {
    const toolId = this.constructor.TOOL_ID;
    const presets = listPresets(toolId).map((preset) => ({
      id: preset.id,
      name: preset.name,
    }));
    const history = listHistory(toolId).map((entry) => ({
      id: entry.id,
      label: summarizeResult(entry.result),
    }));
    return {
      presets,
      hasPresets: presets.length > 0,
      history,
      hasHistory: history.length > 0,
      canUndo: (this._undoStack?.length ?? 0) > 0,
    };
  }

  /** Snapshot the current result before a destructive item mutation. */
  _pushUndo() {
    this._undoStack = this._undoStack ?? [];
    this._undoStack.push(cloneData(this._lastResult));
    if (this._undoStack.length > 10) this._undoStack.shift();
  }

  /** Record a completed roll into persistent history. Fire-and-forget. */
  _recordRoll(result) {
    if (!result) return;
    void pushHistory(this.constructor.TOOL_ID, {
      form: cloneData(this._form),
      result: slimResult(result),
    });
  }

  /** @this {BaseLootApp} */
  static async _onSavePreset(_event, _target) {
    const input = this.element?.querySelector("[data-preset-name]");
    await savePreset(this.constructor.TOOL_ID, {
      name: input?.value ?? "",
      form: this._form,
    });
    playModuleSound(SOUND_EVENTS.PRESET_APPLY);
    await this._renderPreservingScroll();
  }

  /** @this {BaseLootApp} */
  static async _onLoadPreset(_event, target) {
    const preset = getPreset(
      this.constructor.TOOL_ID,
      target?.dataset?.presetId,
    );
    if (!preset) return;
    this._form = {
      ...this.constructor.buildDefaultForm(),
      ...cloneData(preset.form),
    };
    playModuleSound(SOUND_EVENTS.PRESET_APPLY);
    await this._renderPreservingScroll();
  }

  /** @this {BaseLootApp} */
  static async _onDeletePreset(_event, target) {
    await deletePreset(this.constructor.TOOL_ID, target?.dataset?.presetId);
    await this._renderPreservingScroll();
  }

  /** @this {BaseLootApp} */
  static async _onExportPresets(_event, _target) {
    const toolId = this.constructor.TOOL_ID;
    const data = exportPresets(toolId);
    if (!data.presets.length) {
      playModuleSound(SOUND_EVENTS.WARNING_MUTED);
      ui.notifications?.info("No presets to export yet — save one first.");
      return;
    }
    const ok = downloadJson(`${toolId}-presets.json`, data);
    if (ok) {
      playModuleSound(SOUND_EVENTS.PRESET_APPLY);
      ui.notifications?.info(
        `Exported ${data.presets.length} preset(s) to ${toolId}-presets.json.`,
      );
    } else {
      playModuleSound(SOUND_EVENTS.WARNING_MUTED);
      ui.notifications?.warn("Could not start the preset download.");
    }
  }

  /** @this {BaseLootApp} */
  static async _onImportPresets(_event, _target) {
    const data = await pickJsonFile();
    if (!data) return;
    const imported = await importPresets(this.constructor.TOOL_ID, data);
    if (imported > 0) {
      playModuleSound(SOUND_EVENTS.PRESET_APPLY);
      ui.notifications?.info(`Imported ${imported} preset(s).`);
      await this._renderPreservingScroll();
    } else {
      playModuleSound(SOUND_EVENTS.WARNING_MUTED);
      ui.notifications?.warn(
        "No presets found in that file — it may be for a different tool or not an Infinity preset export.",
      );
    }
  }

  /** @this {BaseLootApp} */
  static async _onClearHistory(_event, _target) {
    await clearHistory(this.constructor.TOOL_ID);
    playModuleSound(SOUND_EVENTS.CLEAR_RESET);
    await this._renderPreservingScroll();
  }

  /** @this {BaseLootApp} */
  static async _onLoadHistory(_event, target) {
    const entry = getHistoryEntry(
      this.constructor.TOOL_ID,
      target?.dataset?.historyId,
    );
    if (!entry) return;
    if (entry.form) {
      this._form = {
        ...this.constructor.buildDefaultForm(),
        ...cloneData(entry.form),
      };
    }
    if (entry.result) this._lastResult = cloneData(entry.result);
    playModuleSound(SOUND_EVENTS.PRESET_APPLY);
    await this._renderPreservingScroll();
  }

  /** @this {BaseLootApp} */
  static async _onUndo(_event, _target) {
    if (!this._undoStack?.length) return;
    this._lastResult = this._undoStack.pop();
    playModuleSound(SOUND_EVENTS.CLEAR_RESET);
    await this._renderPreservingScroll();
  }
}
