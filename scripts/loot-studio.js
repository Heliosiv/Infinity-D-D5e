/**
 * Infinity D&D5e - one rendered Loot Studio ApplicationV2 host.
 *
 * Encounter, Hoard, and Creature retain their established prototypes as
 * non-rendering mode controllers. Those controllers continue to own every
 * form, engine call, result, undo stack, preset/history tool id, chat/journal
 * action, and distribution service. This class alone owns the Foundry window
 * lifecycle, so changing tabs never closes or recreates an application.
 */

import { PerEncounterLootApp } from "./app.js";
import { HoardLootApp } from "./hoard-loot.js";
import { PerCreatureLootApp } from "./per-creature-loot.js";
import {
  BaseLootApp,
  LOOT_STUDIO_MODES,
  createLootModeController,
  getActiveLootStudioInstance,
  getLastLootStudioMode,
  normalizeLootStudioMode,
  openLootStudioMode,
  registerLootStudioHost,
  registerLootStudioMode,
} from "./loot/loot-app-base.js";

const STUDIO_TEMPLATE_PATH = "modules/infinity-dnd5e/templates/loot-studio.hbs";
const BODY_TEMPLATE_PATH =
  "modules/infinity-dnd5e/templates/loot-studio-body.hbs";
const BODY_PARTIAL_PATHS = Object.freeze([
  "modules/infinity-dnd5e/templates/loot-forge.hbs",
  "modules/infinity-dnd5e/templates/hoard-loot.hbs",
  "modules/infinity-dnd5e/templates/per-creature-loot.hbs",
  "modules/infinity-dnd5e/templates/loot-result-item.hbs",
]);

export const LOOT_STUDIO_MODE_CLASSES = Object.freeze({
  encounter: PerEncounterLootApp,
  hoard: HoardLootApp,
  creature: PerCreatureLootApp,
});

for (const [mode, AppClass] of Object.entries(LOOT_STUDIO_MODE_CLASSES)) {
  registerLootStudioMode(mode, AppClass);
}

function collectHostActions() {
  const names = new Set();
  for (const AppClass of Object.values(LOOT_STUDIO_MODE_CLASSES)) {
    for (const name of Object.keys(AppClass.DEFAULT_OPTIONS?.actions ?? {})) {
      names.add(name);
    }
  }
  return Object.fromEntries(
    [...names].map((name) => [
      name,
      function dispatchLootStudioAction(event, target) {
        return this._dispatchLootAction(name, event, target);
      },
    ]),
  );
}

const HOST_ACTIONS = Object.freeze(collectHostActions());

export class LootStudioApp extends BaseLootApp {
  static _instance = null;
  static MODES = LOOT_STUDIO_MODES;

  static DEFAULT_OPTIONS = {
    id: "infinity-dnd5e-loot-studio",
    tag: "section",
    classes: ["infinity-dnd5e", "loot-studio"],
    window: {
      title: "Infinity D&D5e - Loot Studio",
      icon: "fa-solid fa-coins",
      resizable: true,
    },
    position: { width: 900, height: 800 },
    actions: HOST_ACTIONS,
    form: { handler: undefined, closeOnSubmit: false, submitOnChange: false },
  };

  static PARTS = {
    studio: { template: STUDIO_TEMPLATE_PATH },
    body: {
      template: BODY_TEMPLATE_PATH,
      // ApplicationV2 only preloads a part's explicitly declared template
      // dependencies. The body chooses one mode partial at render time, and
      // every mode uses the shared result-row partial.
      templates: BODY_PARTIAL_PATHS,
    },
  };

  /**
   * Open the shared window. An omitted mode restores the client's last mode;
   * malformed or unavailable preferences safely fall back to Encounter.
   */
  static open(options = {}) {
    const requested = typeof options === "string" ? options : options?.mode;
    const mode = requested
      ? normalizeLootStudioMode(requested)
      : getLastLootStudioMode();
    return openLootStudioMode(mode, LOOT_STUDIO_MODE_CLASSES[mode]);
  }

  static get instance() {
    return getActiveLootStudioInstance();
  }

  static get mode() {
    return getActiveLootStudioInstance()?.mode ?? null;
  }

  constructor(options = {}) {
    const initialMode = normalizeLootStudioMode(options?.initialMode);
    super(options);
    this._lootStudioControllers = new Map();
    for (const [mode, AppClass] of Object.entries(LOOT_STUDIO_MODE_CLASSES)) {
      this._lootStudioControllers.set(
        mode,
        createLootModeController(AppClass, this),
      );
    }
    this._activeLootController = null;
    this._lootStudioMode = null;
    this._activateLootMode(initialMode, LOOT_STUDIO_MODE_CLASSES[initialMode]);
  }

  get mode() {
    return this._lootStudioMode;
  }

  get controller() {
    return this._activeLootController;
  }

  /** Compatibility proxies for callers that previously inspected the mode
   *  app returned by an open API. Writes remain scoped to the active mode. */
  get _form() {
    return this._activeLootController?._form;
  }

  set _form(value) {
    if (this._activeLootController) this._activeLootController._form = value;
  }

  get _lastResult() {
    return this._activeLootController?._lastResult ?? null;
  }

  set _lastResult(value) {
    if (this._activeLootController) {
      this._activeLootController._lastResult = value;
    }
  }

  get _undoStack() {
    return this._activeLootController?._undoStack ?? [];
  }

  set _undoStack(value) {
    if (this._activeLootController)
      this._activeLootController._undoStack = value;
  }

  /** Select a controller without touching the ApplicationV2 lifecycle. */
  _activateLootMode(mode, AppClass = null) {
    const normalized = normalizeLootStudioMode(mode);
    const requestedClass = AppClass ?? LOOT_STUDIO_MODE_CLASSES[normalized];
    let controller = this._lootStudioControllers.get(normalized);
    if (!controller && requestedClass) {
      controller = createLootModeController(requestedClass, this);
      this._lootStudioControllers.set(normalized, controller);
    }
    if (!controller) return false;
    if (controller === this._activeLootController) return false;

    const previous = this._activeLootController;
    if (previous?.element) {
      previous._lastScrollState = previous._captureScrollState();
    }
    this._activeLootController = controller;
    this._lootStudioMode = normalized;
    controller._pendingScrollState = controller._lastScrollState;
    return true;
  }

  async _prepareContext(options) {
    const controller = this._activeLootController;
    if (!controller) return {};
    const context = await controller._prepareContext(options);
    const mode = this._lootStudioMode;
    context.lootStudio = {
      ...context.lootStudio,
      isEncounter: mode === "encounter",
      isHoard: mode === "hoard",
      isCreature: mode === "creature",
    };
    return context;
  }

  _dispatchLootAction(action, event, target) {
    const controller = this._activeLootController;
    const handler = controller?.constructor?.DEFAULT_OPTIONS?.actions?.[action];
    if (typeof handler !== "function") return undefined;
    return handler.call(controller, event, target);
  }

  _primaryGenerate() {
    return this._activeLootController?._primaryGenerate?.();
  }
}

registerLootStudioHost(LootStudioApp);

export function openLootStudio(options = {}) {
  return LootStudioApp.open(options);
}
