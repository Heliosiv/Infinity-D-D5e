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
import { normalizeInfinityItemUuid } from "../item-uuid-compat.js";
import {
  depositToActors,
  planEvenSplit,
  promptDistributeItems,
  promptDistributeSplit,
} from "./distribute.js";
import { buildJournalEntry } from "./journal.js";
import {
  getItemRollCategory,
  restoreStoredRollCategories,
} from "./item-categories.js";
import { loadCompendiumItems } from "./pack.js";
import { computeFilterFacetStats, computePackStats } from "./pack-stats.js";
import {
  filterCandidates,
  getEffectiveRarity,
  itemIdentity,
  rerollOne,
} from "./roller.js";
import {
  bindScrollTracking,
  captureScroll,
  restoreScroll,
} from "../merchant/scroll.js";
import { getItemMaxQty, isAmmunitionItem } from "./tag-vocabulary.js";
import { SETTING_KEYS, getSetting } from "../settings.js";
import { runAsFullGM } from "../permissions.js";
import {
  bindFocusRestoration,
  bindFullGmWindowGuard,
} from "../infinity-app.js";
import {
  applyUiDensity,
  getUiPreferences,
  setAdvancedDisclosure as persistAdvancedDisclosure,
  updateUiPreferences,
} from "../ui-preferences.js";
import { confirmDestructive, isInteractiveKeyboardTarget } from "../ui-util.js";
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
const NO_MATCHING_ITEMS_REASON =
  "No items match the current tier, rarity, item type, and value filters. Adjust a filter and try again.";
const ITEMS_LOADING_REASON = "Loot items are still loading.";

export const LOOT_STUDIO_MODES = Object.freeze([
  Object.freeze({
    id: "encounter",
    label: "Encounter",
    icon: "fa-solid fa-shield-halved",
  }),
  Object.freeze({
    id: "hoard",
    label: "Hoard",
    icon: "fa-solid fa-sack-dollar",
  }),
  Object.freeze({
    id: "creature",
    label: "Creature",
    icon: "fa-solid fa-skull",
  }),
]);

const LOOT_STUDIO_DEFAULT_MODE = "encounter";
const lootStudioClasses = new Map();
let lootStudioHostClass = null;
let activeLootStudioInstance = null;
let lastLootStudioModeInMemory = null;

function isPlainObject(value) {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

/** Bound the public mode value before it reaches a class or a setting. */
export function normalizeLootStudioMode(
  mode,
  fallback = LOOT_STUDIO_DEFAULT_MODE,
) {
  const value = String(mode ?? "")
    .trim()
    .toLowerCase();
  if (LOOT_STUDIO_MODES.some((entry) => entry.id === value)) return value;
  return LOOT_STUDIO_MODES.some((entry) => entry.id === fallback)
    ? fallback
    : LOOT_STUDIO_DEFAULT_MODE;
}

/** Read the optional client preference without requiring the v1 setting. */
export function readLootStudioUiPreferences() {
  return getUiPreferences();
}

/** Merge a small Loot Studio patch into the optional client preference. */
export async function writeLootStudioUiPreferences(patch) {
  if (!isPlainObject(patch)) return false;
  try {
    await updateUiPreferences(patch);
    return true;
  } catch (error) {
    console.warn(
      `${MODULE_ID} | could not save Loot Studio preferences`,
      error,
    );
    return false;
  }
}

export function getLastLootStudioMode() {
  return normalizeLootStudioMode(
    lastLootStudioModeInMemory ??
      readLootStudioUiPreferences().lastLootStudioMode,
  );
}

function advancedDisclosureKey(mode) {
  return `loot-studio:${normalizeLootStudioMode(mode)}`;
}

function getAdvancedDisclosure(mode) {
  const disclosures = readLootStudioUiPreferences().advancedDisclosures;
  if (!isPlainObject(disclosures)) return false;
  return disclosures[advancedDisclosureKey(mode)] === true;
}

async function setAdvancedDisclosure(mode, open) {
  try {
    await persistAdvancedDisclosure(advancedDisclosureKey(mode), open === true);
    return true;
  } catch (error) {
    console.warn(
      `${MODULE_ID} | could not save the Loot Studio disclosure state`,
      error,
    );
    return false;
  }
}

export function registerLootStudioMode(mode, AppClass) {
  const normalized = normalizeLootStudioMode(mode);
  if (typeof AppClass === "function")
    lootStudioClasses.set(normalized, AppClass);
  return AppClass;
}

/** Register the one rendered ApplicationV2 host without creating a circular
 *  import from the mode classes back into Loot Studio. */
export function registerLootStudioHost(HostClass) {
  if (typeof HostClass === "function") lootStudioHostClass = HostClass;
  return HostClass;
}

async function loadLootStudioModeClass(mode) {
  const normalized = normalizeLootStudioMode(mode);
  if (lootStudioClasses.has(normalized))
    return lootStudioClasses.get(normalized);
  if (normalized === "hoard") await import("../hoard-loot.js");
  else if (normalized === "creature") await import("../per-creature-loot.js");
  else await import("../app.js");
  return lootStudioClasses.get(normalized) ?? null;
}

function activateLootStudioMode(mode, AppClass) {
  const normalized = normalizeLootStudioMode(mode);
  registerLootStudioMode(normalized, AppClass);
  const HostClass = lootStudioHostClass;
  if (typeof HostClass !== "function") {
    throw new Error("LootStudioHostUnavailable");
  }

  let created = false;
  if (!HostClass._instance) {
    HostClass._instance = new HostClass({ initialMode: normalized });
    bindFocusRestoration(HostClass._instance);
    created = true;
  }

  const host = HostClass._instance;
  const changed = host._activateLootMode(normalized, AppClass);
  activeLootStudioInstance = host;
  lastLootStudioModeInMemory = normalized;
  void writeLootStudioUiPreferences({ lastLootStudioMode: normalized });

  playModuleSound(SOUND_EVENTS.UI_OPEN);
  if (host.rendered) {
    if (changed) {
      const rendered = host.render(false);
      host._lootStudioRenderPromise =
        rendered && typeof rendered.then === "function" ? rendered : null;
    } else {
      host.bringToFront();
      host._lootStudioRenderPromise = null;
    }
  } else {
    const rendered = host.render(true);
    host._lootStudioRenderPromise =
      rendered && typeof rendered.then === "function" ? rendered : null;
  }
  if (created) host._lootStudioOpenedAt = Date.now();
  return host;
}

function openRegisteredLootStudioMode(mode, AppClass) {
  const normalized = normalizeLootStudioMode(mode);
  if (typeof lootStudioHostClass === "function") {
    return activateLootStudioMode(normalized, AppClass);
  }
  return import("../loot-studio.js").then(() =>
    activateLootStudioMode(normalized, AppClass),
  );
}

/**
 * Open a mode through the one visible Loot Studio singleton. Supplying the
 * class keeps the legacy class-level `open()` path synchronous on first open;
 * tab navigation can lazy-load another mode when a caller imported only one.
 */
export function openLootStudioMode(mode, AppClass = null) {
  const normalized = normalizeLootStudioMode(mode);
  return runAsFullGM(() => {
    if (typeof AppClass === "function") {
      registerLootStudioMode(normalized, AppClass);
      return openRegisteredLootStudioMode(normalized, AppClass);
    }
    const registered = lootStudioClasses.get(normalized);
    if (registered) return openRegisteredLootStudioMode(normalized, registered);
    return loadLootStudioModeClass(normalized).then((LoadedClass) =>
      LoadedClass
        ? openRegisteredLootStudioMode(normalized, LoadedClass)
        : null,
    );
  });
}

export function getActiveLootStudioInstance() {
  return activeLootStudioInstance;
}

function releaseLootStudioInstance(instance) {
  if (activeLootStudioInstance === instance) activeLootStudioInstance = null;
}

const { ApplicationV2, HandlebarsApplicationMixin } = foundry.applications.api;

function cloneData(value) {
  if (value == null) return value;
  if (typeof structuredClone === "function") return structuredClone(value);
  return JSON.parse(JSON.stringify(value));
}

function normalizeResultItemUuids(result) {
  const normalizeEntries = (entries) => {
    for (const entry of Array.isArray(entries) ? entries : []) {
      if (entry?.item?.uuid) {
        entry.item.uuid = normalizeInfinityItemUuid(entry.item.uuid);
      }
    }
  };
  normalizeEntries(result?.items);
  for (const creature of Array.isArray(result?.creatures)
    ? result.creatures
    : []) {
    normalizeEntries(creature?.items);
  }
  return result;
}

/** Slim a result for history storage — drop heavy item docs to uuid/name/img. */
function slimResult(result) {
  const copy = cloneData(result);
  const slim = (items) => {
    if (!Array.isArray(items)) return;
    for (const entry of items) {
      if (entry?.item) {
        entry.rollCategory =
          String(entry.rollCategory ?? "").trim() ||
          getItemRollCategory(entry.item);
        entry.item = {
          uuid: normalizeInfinityItemUuid(entry.item.uuid),
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

/** Restore category metadata that histories saved before v0.2.60 lack. */
function restoreResultRollCategories(result, candidates) {
  if (Array.isArray(result?.items)) {
    restoreStoredRollCategories(result.items, candidates);
  }
  if (Array.isArray(result?.creatures)) {
    for (const creature of result.creatures) {
      restoreStoredRollCategories(creature?.items, candidates);
    }
  }
  return result;
}

/** One-line summary of a stored roll for the history list. */
function summarizeResult(result) {
  if (!result) return "—";
  if (Array.isArray(result.creatures)) {
    return `${result.creatures.length} creature(s) · ${result.grandTotalLabel ?? ""}`;
  }
  return `${result.items?.length ?? 0} item(s) · ${result.totalGpLabel ?? ""}`;
}

/**
 * Create a non-rendering mode controller backed by the established mode
 * prototype. The controller owns form/result/undo/cache state and every
 * existing generation method, while all ApplicationV2 lifecycle and DOM
 * access are delegated to the one LootStudioApp host.
 */
export function createLootModeController(AppClass, host) {
  if (typeof AppClass !== "function" || !host) return null;
  const controller = Object.create(AppClass.prototype);
  Object.defineProperties(controller, {
    _lootStudioHost: {
      configurable: true,
      value: host,
    },
    element: {
      configurable: true,
      get: () => host.element,
    },
    rendered: {
      configurable: true,
      get: () => host.rendered,
    },
    render: {
      configurable: true,
      value: (...args) => host.render(...args),
    },
    bringToFront: {
      configurable: true,
      value: (...args) => host.bringToFront(...args),
    },
    close: {
      configurable: true,
      value: (...args) => host.close(...args),
    },
  });

  controller._loadingItems = false;
  controller._cachedItems = null;
  controller._cachedItemsAt = 0;
  controller._packStats = null;
  controller._pendingScrollState = null;
  controller._lastScrollState = null;
  controller._lootStudioAdvancedOpen = getAdvancedDisclosure(
    AppClass.LOOT_STUDIO_MODE,
  );
  controller._initializeModeState?.({ restoreForStudio: true });
  return controller;
}

export class BaseLootApp extends HandlebarsApplicationMixin(ApplicationV2) {
  /* --------------- subclass-provided static config --------------- */

  /** Public Loot Studio mode represented by this compatibility class. */
  static LOOT_STUDIO_MODE = LOOT_STUDIO_DEFAULT_MODE;
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
      switchLootMode: this._onSwitchLootMode,
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

  /** Open this legacy class through the shared Loot Studio singleton. */
  static open() {
    return openLootStudioMode(this.LOOT_STUDIO_MODE, this);
  }

  constructor(options = {}) {
    super(options);
    this._unbindFullGmWindowGuard = bindFullGmWindowGuard(this);
    this._loadingItems = false;
    this._cachedItems = null;
    this._cachedItemsAt = 0;
    this._packStats = null;
    this._pendingScrollState = null;
    this._lastScrollState = null;
    this._lootStudioAdvancedOpen = getAdvancedDisclosure(
      this.constructor.LOOT_STUDIO_MODE,
    );
  }

  /* ------------------- lifecycle ------------------- */

  async _onRender(context, options) {
    super._onRender?.(context, options);
    const modeOwner = this._activeLootController ?? this;
    return modeOwner._onRenderLootMode(context, options, this.element);
  }

  /** Bind the currently active mode to the host's rendered DOM. */
  async _onRenderLootMode(context, options, root = this.element) {
    if (!root) return;

    const mode = normalizeLootStudioMode(this.constructor.LOOT_STUDIO_MODE);
    root.classList.toggle("loot-forge", mode === "encounter");
    root.classList.toggle("hoard-loot", mode === "hoard");
    root.classList.toggle("per-creature-loot", mode === "creature");
    const eventHost = this._lootStudioHost ?? this;

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
    applyUiDensity(root, readLootStudioUiPreferences());

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
      root.addEventListener("keydown", (event) => {
        const owner = eventHost._activeLootController ?? this;
        owner._onKeyDown(event);
      });
    }
    if (root.dataset.infinityDnd5eScrollPointerTracked !== "true") {
      root.dataset.infinityDnd5eScrollPointerTracked = "true";
      root.addEventListener(
        "pointerdown",
        () => {
          const owner = eventHost._activeLootController ?? this;
          owner._lastScrollState = owner._captureScrollState();
        },
        { capture: true, passive: true },
      );
    }

    for (const tab of root.querySelectorAll("[data-loot-studio-tab]")) {
      tab.addEventListener("keydown", (event) =>
        this._onLootStudioTabKeyDown(event),
      );
    }

    const advanced = root.querySelector("[data-loot-advanced]");
    if (advanced) {
      advanced.addEventListener("toggle", () => {
        this._lootStudioAdvancedOpen = advanced.open === true;
        void setAdvancedDisclosure(
          this.constructor.LOOT_STUDIO_MODE,
          this._lootStudioAdvancedOpen,
        );
      });
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
    this._unbindFullGmWindowGuard?.();
    this._unbindFullGmWindowGuard = null;
    const modeOwners = this._lootStudioControllers
      ? [...this._lootStudioControllers.values()]
      : [this];

    // Clear pending work for every mode so no timer can fire into a closed host.
    for (const owner of modeOwners) {
      if (owner._debounceTimers) {
        for (const id of owner._debounceTimers.values()) {
          globalThis.clearTimeout?.(id);
        }
        owner._debounceTimers.clear();
      }
    }

    const persistAcrossCloses =
      getSetting(SETTING_KEYS.PERSIST_STATE) !== false;
    if (persistAcrossCloses) {
      for (const owner of modeOwners) {
        owner.constructor._persistedState = owner._snapshotState();
      }
    } else {
      // A genuine Studio close ends the whole in-memory tab session. Clear
      // every visited mode so reopening and switching cannot revive stale
      // forms/results when cross-close persistence is disabled.
      for (const ModeClass of new Set(lootStudioClasses.values())) {
        ModeClass._persistedState = null;
      }
    }

    for (const owner of modeOwners) {
      owner._lootStudioSwitching = false;
      owner.constructor._instance = null;
    }
    this.constructor._instance = null;
    releaseLootStudioInstance(this);
  }

  /**
   * Trailing-edge debounce keyed by name. Coalesces rapid input — a slider
   * drag fires `input` dozens of times a second — so an expensive recompute
   * (e.g. a full-pack candidate recount) runs once when the control settles
   * instead of on every frame. Cheap readouts stay synchronous; only the
   * costly scan is deferred.
   */
  _debounce(key, fn, delay = 120) {
    if (!this._debounceTimers) this._debounceTimers = new Map();
    const timers = this._debounceTimers;
    if (timers.has(key)) globalThis.clearTimeout?.(timers.get(key));
    const id = globalThis.setTimeout?.(() => {
      timers.delete(key);
      // A controller can remain alive while another Studio tab owns the DOM.
      // Do not let delayed readout work from the previous mode patch the
      // newly active panel; its context is recomputed when that mode returns.
      if (
        this._lootStudioHost &&
        this._lootStudioHost._activeLootController !== this
      ) {
        return;
      }
      fn();
    }, delay);
    timers.set(key, id);
  }

  /** Persist the current bounded form and result for this app session. */
  _snapshotState() {
    return {
      form: this._normalizeStoredForm(this._form),
      lastResult: this._lastResult,
      undoStack: Array.isArray(this._undoStack)
        ? this._undoStack.slice(-10).map((entry) => cloneData(entry))
        : [],
    };
  }

  /**
   * Normalize every form that crosses a persistence boundary. Subclasses own
   * their schemas so the shared preset/history actions cannot bypass bounds.
   */
  _normalizeStoredForm(form) {
    const normalize = this.constructor.normalizeForm;
    if (typeof normalize === "function") {
      return normalize.call(this.constructor, cloneData(form));
    }
    const defaults = this.constructor.buildDefaultForm?.() ?? {};
    const raw =
      form && typeof form === "object" && !Array.isArray(form)
        ? cloneData(form)
        : {};
    return { ...defaults, ...raw };
  }

  /* ------------------- scroll preservation ------------------- */

  _scrollTargets() {
    return this.constructor.SCROLL_TARGETS ?? [];
  }

  _captureScrollState() {
    // Delegate the DOM read to the shared scroll engine, but keep the loot
    // app's "remember the last known position when the pane is momentarily
    // absent" fallback — captureScroll returns null in that case.
    return (
      captureScroll(this.element, this._scrollTargets()) ??
      this._lastScrollState
    );
  }

  _restoreScrollState() {
    const state = this._pendingScrollState ?? this._lastScrollState;
    this._pendingScrollState = null;
    // settleMs adds the loot windows' extra delayed retry on top of the
    // shared engine's immediate + triple-rAF passes.
    restoreScroll(this.element, this._scrollTargets(), state, { settleMs: 50 });
  }

  async _renderPreservingScroll(options) {
    this._pendingScrollState = this._captureScrollState();
    await this.render(options);
  }

  _bindScrollTracking(root) {
    const eventHost = this._lootStudioHost ?? this;
    bindScrollTracking(
      root,
      this._scrollTargets(),
      () => {
        const owner = eventHost._activeLootController ?? this;
        owner._lastScrollState = owner._captureScrollState();
      },
      { flag: "infinityDnd5eScrollTracked" },
    );
  }

  /* ------------------- keyboard ------------------- */

  _onKeyDown(event) {
    if (getSetting(SETTING_KEYS.KEYBOARD_SHORTCUTS) === false) return;
    if (event.defaultPrevented) return;
    if (isInteractiveKeyboardTarget(event.target)) return;
    const tag = event.target?.tagName?.toLowerCase();
    const isEditable =
      tag === "input" || tag === "select" || tag === "textarea";
    // Enter triggers Generate from anywhere EXCEPT a text-entry field, where
    // Enter means "confirm this value". A GM typing a budget/quantity/min-gp
    // and pressing Enter should not silently re-roll the whole bundle and
    // discard unlocked results. Checkbox/radio/range inputs still generate.
    const type = (event.target?.type ?? "").toLowerCase();
    const isTextEntry =
      tag === "textarea" ||
      (tag === "input" &&
        [
          "text",
          "number",
          "search",
          "email",
          "tel",
          "url",
          "password",
        ].includes(type));
    if (event.key === "Enter" && !isTextEntry && tag !== "select") {
      event.preventDefault();
      this._startPrimaryGeneration();
      return;
    }
    if (
      (event.key === "r" || event.key === "R") &&
      !isEditable &&
      !event.ctrlKey &&
      !event.metaKey
    ) {
      event.preventDefault();
      this._startPrimaryGeneration();
    }
  }

  _onLootStudioTabKeyDown(event) {
    if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) {
      return;
    }
    const tabList = event.currentTarget?.closest?.("[role='tablist']");
    const tabs = [...(tabList?.querySelectorAll?.("[role='tab']") ?? [])];
    if (tabs.length === 0) return;
    const currentIndex = Math.max(0, tabs.indexOf(event.currentTarget));
    let nextIndex = currentIndex;
    if (event.key === "Home") nextIndex = 0;
    else if (event.key === "End") nextIndex = tabs.length - 1;
    else if (event.key === "ArrowRight") {
      nextIndex = (currentIndex + 1) % tabs.length;
    } else {
      nextIndex = (currentIndex - 1 + tabs.length) % tabs.length;
    }
    event.preventDefault();
    const nextTab = tabs[nextIndex];
    nextTab?.focus?.();
    nextTab?.click?.();
  }

  _startPrimaryGeneration() {
    if (!this._canStartPrimaryGeneration({ notify: true })) return undefined;
    return this._primaryGenerate();
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
    const minutes = Number(getSetting(SETTING_KEYS.PACK_TTL_MINUTES) ?? 5);
    const ttlMs =
      Math.max(1, Number.isFinite(minutes) ? minutes : 5) * 60 * 1000;
    this._cachedItems = await loadCompendiumItems({
      packId: this.constructor.PACK_ID,
      ttlMs,
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

  /**
   * Candidate availability for the primary roll. Subclasses may preserve an
   * empty pool as a valid outcome (Hoard) or evaluate several tier windows
   * (Per-Creature), but all tools expose the same state to their templates.
   */
  _candidateAvailability() {
    const known = Array.isArray(this._cachedItems);
    const count = known ? this._countCandidates() : 0;
    const candidateEmpty = known && count === 0;
    return {
      count,
      label: this._candidateLabel(
        count,
        this._packStats?.totalItems ?? this._cachedItems?.length ?? 0,
      ),
      candidateEmpty,
      blocksGeneration: candidateEmpty,
      reason: candidateEmpty ? NO_MATCHING_ITEMS_REASON : "",
      notificationLevel: "warn",
    };
  }

  _primaryGenerationState() {
    const candidate = this._candidateAvailability();
    // Keep the first render inert until the automatic preload begins. If that
    // preload fails, `_primePackStats` installs empty stats, which deliberately
    // clears this pending state so Generate can be used to retry the pack load.
    const awaitingInitialLoad =
      !Array.isArray(this._cachedItems) && !this._packStats;
    const loading = this._loadingItems === true || awaitingInitialLoad;
    return {
      ...candidate,
      loading,
      disabled: loading || candidate.blocksGeneration,
      reason: loading ? ITEMS_LOADING_REASON : candidate.reason,
    };
  }

  _candidateContext() {
    const state = this._primaryGenerationState();
    return {
      candidateCount: state.count,
      candidateLabel: state.label,
      noCandidates: state.candidateEmpty,
      candidateUnavailableReason: state.candidateEmpty ? state.reason : "",
      generateDisabled: state.disabled,
      generateDisabledReason: state.disabled ? state.reason : "",
    };
  }

  /** Required filter scopes for chip availability. Per-Creature widens this. */
  _chipFacetScopes() {
    const tier = String(this._form?.tier ?? "")
      .trim()
      .toUpperCase();
    return [{ filter: this._filterSpec(), label: tier }];
  }

  _chipFacetStats() {
    if (!Array.isArray(this._cachedItems)) return null;
    return computeFilterFacetStats(this._cachedItems, this._chipFacetScopes(), {
      rarities: this._chipUniverse("rarity") ?? [],
      lootTypes: this._chipUniverse("lootType") ?? [],
    });
  }

  _chipOptionAvailability(group, value, selected, facetStats) {
    const countKnown = Boolean(facetStats);
    const entries =
      group === "rarity" ? facetStats?.byRarity : facetStats?.byLootType;
    const entry = entries?.[value] ?? {
      count: 0,
      available: false,
      complete: false,
      unavailableScopes: [],
      unavailableScopeCount: 0,
    };
    const unavailable = countKnown && !entry.available;
    const partial = countKnown && entry.available && !entry.complete;
    const disabled = unavailable && !selected;
    const optionLabel = group === "rarity" ? "rarity" : "item type";
    const scopes = entry.unavailableScopes ?? [];
    const scopeLabel =
      scopes.length > 0
        ? ` for ${scopes.join(", ")}`
        : entry.unavailableScopeCount > 0 && facetStats?.scopeCount > 1
          ? " for at least one roster tier"
          : "";

    let availabilityTitle = "Availability loads with the compendium.";
    if (unavailable && selected) {
      availabilityTitle = `This selected ${optionLabel} has no matches${scopeLabel} with the other current filters. Deselect it or adjust another filter.`;
    } else if (unavailable) {
      availabilityTitle = `No matches${scopeLabel} with the other current filters. Adjust another filter to make this ${optionLabel} available.`;
    } else if (partial) {
      availabilityTitle = `${entry.count.toLocaleString()} matching item opportunities across the roster, but none${scopeLabel}. Combine it with another ${optionLabel} or adjust the filters.`;
    } else if (countKnown && facetStats.scopeCount > 1) {
      availabilityTitle = `${entry.count.toLocaleString()} matching item opportunities across the roster tiers.`;
    } else if (countKnown) {
      availabilityTitle = `${entry.count.toLocaleString()} matching item${entry.count === 1 ? "" : "s"} with the other current filters.`;
    }

    return {
      count: entry.count,
      countKnown,
      unavailable,
      partial,
      selectedUnavailable: unavailable && selected,
      disabled,
      availabilityTitle,
    };
  }

  _patchChipAvailability(root = this.element) {
    if (!root) return;
    const facetStats = this._chipFacetStats();
    if (!facetStats) return;

    for (const chip of root.querySelectorAll?.(
      "[data-chip-group][data-chip-value]",
    ) ?? []) {
      const group = chip.dataset?.chipGroup;
      const value = chip.dataset?.chipValue;
      const input = chip.querySelector?.("input[type='checkbox']");
      if (!group || !value || !input) continue;
      const option = this._chipOptionAvailability(
        group,
        value,
        input.checked === true,
        facetStats,
      );
      chip.classList?.toggle("is-unavailable", option.unavailable);
      chip.classList?.toggle("is-partial", option.partial);
      chip.classList?.toggle(
        "is-selected-unavailable",
        option.selectedUnavailable,
      );
      chip.setAttribute?.("aria-disabled", String(option.disabled));
      chip.setAttribute?.("title", option.availabilityTitle);
      input.disabled = option.disabled;
      const count = chip.querySelector?.("[data-chip-count]");
      if (count) count.textContent = String(option.count);
    }
  }

  /**
   * Keep the live candidate readout and primary button synchronized without a
   * full ApplicationV2 render. Action and keyboard handlers still re-check the
   * state synchronously, closing the debounce window after rapid form edits.
   */
  _patchCandidateAvailability() {
    const root = this.element;
    const state = this._primaryGenerationState();
    if (!root) return state;

    const readout = root.querySelector?.("[data-candidates]");
    if (readout) {
      readout.textContent = state.label;
      readout.classList?.toggle("is-empty", state.candidateEmpty);
      if (state.candidateEmpty && state.reason) {
        readout.setAttribute?.("title", state.reason);
      } else {
        readout.removeAttribute?.("title");
      }
    }

    for (const button of root.querySelectorAll?.("[data-action='generate']") ??
      []) {
      const readyTitle =
        button.dataset?.readyTitle ??
        button.getAttribute?.("data-ready-title") ??
        button.getAttribute?.("title") ??
        "";
      if (button.dataset && !button.dataset.readyTitle) {
        button.dataset.readyTitle = readyTitle;
      }
      button.disabled = state.disabled;
      button.setAttribute?.("aria-disabled", String(state.disabled));
      button.setAttribute?.(
        "title",
        state.disabled && state.reason ? state.reason : readyTitle,
      );
      if (state.loading) button.setAttribute?.("aria-busy", "true");
      else button.removeAttribute?.("aria-busy");
    }

    this._patchChipAvailability(root);
    return state;
  }

  _notifyGenerationBlocked(state) {
    if (!state?.reason) return;
    playModuleSound(SOUND_EVENTS.WARNING_MUTED);
    const notifications = globalThis.ui?.notifications;
    if (state.notificationLevel === "info") {
      notifications?.info?.(state.reason);
    } else {
      notifications?.warn?.(state.reason);
    }
  }

  _canStartPrimaryGeneration({ notify = false } = {}) {
    const state = this._primaryGenerationState();
    if (!state.disabled) return true;
    if (notify && !state.loading) this._notifyGenerationBlocked(state);
    return false;
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
      const active =
        Number.isFinite(snapValue) && Math.abs(snapValue - value) < 0.01;
      snap.classList.toggle("is-active", active);
      snap.setAttribute("aria-pressed", String(active));
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
  static async _onSwitchLootMode(event, target) {
    return this._switchLootStudioMode(event, target);
  }

  async _switchLootStudioMode(event, target) {
    event?.preventDefault?.();
    const requested = normalizeLootStudioMode(target?.dataset?.lootMode);
    if (requested === this.constructor.LOOT_STUDIO_MODE) return;
    const opened = await openLootStudioMode(requested);
    await opened?._lootStudioRenderPromise;
    const focusActiveTab = () =>
      opened?.element
        ?.querySelector?.(`[data-loot-mode='${requested}']`)
        ?.focus?.();
    if (typeof globalThis.requestAnimationFrame === "function") {
      globalThis.requestAnimationFrame(focusActiveTab);
    } else {
      focusActiveTab();
    }
  }

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
      ui.notifications?.error(
        "Loot was not sent to chat. Nothing else changed; try again, then share this exact message with the GM if it continues.",
      );
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
    restoreStoredRollCategories(list, items);
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
    const listBudget = Number(this._rerollBudgetForList(list) ?? 0);
    const budgetGp = Math.max(0, listBudget - otherGp);
    // `rerollOne` treats a zero budget as intentionally unbounded. Keep those
    // semantics for genuinely unbudgeted lists, but never let a fully consumed
    // positive bundle budget turn into an unlimited replacement roll.
    if (Number.isFinite(listBudget) && listBudget > 0 && budgetGp <= 0) {
      playModuleSound(SOUND_EVENTS.WARNING_MUTED);
      ui.notifications?.info(
        "No budget remains for a replacement — keeping the current item.",
      );
      return;
    }
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
      ...this._rerollRollOptions(old, list),
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

  /** Additional probability controls for a single-slot reroll. */
  _rerollRollOptions(_oldEntry, _list) {
    return {};
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
    return decorateEntry(
      {
        ...entry,
        rollCategory:
          String(entry?.rollCategory ?? "").trim() ||
          getItemRollCategory(entry?.item),
      },
      {
        imageSrc: resultImageForEntry(entry),
        rarity: getEffectiveRarity(entry.item),
        isAmmo: isAmmunitionItem(entry.item),
      },
    );
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
    const mode = normalizeLootStudioMode(
      this.constructor.LOOT_STUDIO_MODE,
      LOOT_STUDIO_DEFAULT_MODE,
    );
    const generation = this._primaryGenerationState();
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
      lootStudio: {
        mode,
        activeLabel:
          LOOT_STUDIO_MODES.find((entry) => entry.id === mode)?.label ??
          "Encounter",
        panelId: `loot-studio-panel-${mode}`,
        tabId: `loot-studio-tab-${mode}`,
        advancedOpen: this._lootStudioAdvancedOpen === true,
        loadingItems: generation.loading,
        generationBlocked: generation.disabled && !generation.loading,
        generationBlockReason: generation.disabled ? generation.reason : "",
        tabs: LOOT_STUDIO_MODES.map((entry) => ({
          ...entry,
          active: entry.id === mode,
          tabId: `loot-studio-tab-${entry.id}`,
          panelId: `loot-studio-panel-${entry.id}`,
        })),
      },
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
      form: this._normalizeStoredForm(this._form),
      result: slimResult(result),
    });
  }

  /** @this {BaseLootApp} */
  static async _onSavePreset(_event, _target) {
    const input = this.element?.querySelector("[data-preset-name]");
    await savePreset(this.constructor.TOOL_ID, {
      name: input?.value ?? "",
      form: this._normalizeStoredForm(this._form),
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
    this._form = this._normalizeStoredForm(preset.form);
    playModuleSound(SOUND_EVENTS.PRESET_APPLY);
    await this._renderPreservingScroll();
  }

  /** @this {BaseLootApp} */
  static async _onDeletePreset(_event, target) {
    const confirmed = await confirmDestructive({
      title: "Delete preset?",
      content: "<p>Delete this saved preset? This cannot be undone.</p>",
      icon: "fa-solid fa-trash",
    });
    if (!confirmed) return;
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
    const confirmed = await confirmDestructive({
      title: "Clear roll history?",
      content:
        "<p>Clear every saved roll in this tool's history? This cannot be undone.</p>",
      icon: "fa-solid fa-trash-clock",
    });
    if (!confirmed) return;
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
      this._form = this._normalizeStoredForm(entry.form);
    }
    this._lastResult = entry.result
      ? normalizeResultItemUuids(cloneData(entry.result))
      : null;
    if (this._lastResult) {
      try {
        const items = await this._loadItems();
        restoreResultRollCategories(this._lastResult, items);
      } catch (error) {
        console.warn(
          `${MODULE_ID} | could not restore legacy roll categories`,
          error,
        );
      }
    }
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
