/**
 * Infinity D&D5e — unified Loot Studio compatibility facade.
 *
 * The established mode classes remain the owners of loot math, forms,
 * results, undo, presets, history, chat, journals, and distribution. This
 * facade only selects which one is the single visible ApplicationV2 instance.
 */

import { PerEncounterLootApp } from "./app.js";
import { HoardLootApp } from "./hoard-loot.js";
import { PerCreatureLootApp } from "./per-creature-loot.js";
import {
  LOOT_STUDIO_MODES,
  getActiveLootStudioInstance,
  getLastLootStudioMode,
  normalizeLootStudioMode,
  openLootStudioMode,
  registerLootStudioMode,
} from "./loot/loot-app-base.js";

export const LOOT_STUDIO_MODE_CLASSES = Object.freeze({
  encounter: PerEncounterLootApp,
  hoard: HoardLootApp,
  creature: PerCreatureLootApp,
});

for (const [mode, AppClass] of Object.entries(LOOT_STUDIO_MODE_CLASSES)) {
  registerLootStudioMode(mode, AppClass);
}

export class LootStudioApp {
  static MODES = LOOT_STUDIO_MODES;

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
    return getActiveLootStudioInstance()?.constructor?.LOOT_STUDIO_MODE ?? null;
  }
}

export function openLootStudio(options = {}) {
  return LootStudioApp.open(options);
}
