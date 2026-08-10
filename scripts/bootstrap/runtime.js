import { openHub } from "../dashboard.js";
import { LootStudioApp } from "../loot-studio.js";
import { InfinitySettingsApp } from "../settings-app.js";
import { MerchantWorkspaceApp } from "../merchant-workspace.js";
import {
  MerchantSessionApp,
  registerMerchantSessionAutoOpen,
} from "../merchant-session.js";
import { ShopPickerApp } from "../shop-picker.js";
import { ResourceManagerApp } from "../resource-manager.js";
import { ResourceOverviewApp } from "../resource-overview.js";
import {
  ForagePromptApp,
  registerForagePromptAutoOpen,
} from "../forage-prompt.js";
import { registerResourceSocket } from "../resource/socket.js";
import { registerResourceOverviewService } from "../resource/overview-service.js";
import {
  CriticalInjuryApp,
  registerCriticalInjuryApp,
} from "../injury/injury-app.js";
import {
  CriticalInjuryHudApp,
  registerCriticalInjuryHud,
} from "../injury/injury-hud.js";
import { registerCriticalInjurySocket } from "../injury/socket.js";
import { registerCriticalInjuryService } from "../injury/service.js";
import {
  CRITICAL_INJURY_TABLE,
  CRITICAL_INJURY_TABLE_VERSION,
} from "../injury/table.js";
import {
  registerResourceCalendarWatcher,
  advanceDayNow,
} from "../resource/calendar-watcher.js";
import {
  isResourceAutomationReady,
  migrateResourceConfig,
  observeResourceAuthorityTransition,
} from "../resource/store.js";
import { registerMerchantSocket } from "../merchant/socket.js";
import { ReputationWorkspaceApp } from "../reputation-workspace.js";
import { ReputationViewApp } from "../reputation-view.js";
import { registerReputationSocket } from "../reputation/socket.js";
import { DowntimeWorkspaceApp } from "../downtime-workspace.js";
import { DowntimeActivitiesApp } from "../downtime-activities.js";
import {
  configureDowntimePlayerAutoOpen,
  getDowntimePlayerAdapter,
} from "../downtime/ui-adapter.js";
import {
  downtimeWorkspaceAdapter,
  registerDowntimeService,
} from "../downtime/service.js";
import {
  notifyLongRest,
  notifySharpenDamage,
  registerDowntimeSocket,
} from "../downtime/socket.js";
import { registerSharpeningHooks } from "../downtime/effects.js";
import {
  SOUND_EVENTS,
  SOUND_REGISTRY,
  playSoundEvent,
  preloadModuleSounds,
  registerSoundSocket,
} from "../audio.js";
import { registerMonksTokenbarCompat } from "../compat/monks-tokenbar.js";
import { registerMonksActiveTilesCompat } from "../compat/monks-active-tiles.js";
import { registerSoundAutomation } from "../compat/sound-automation.js";
import { registerSpellComponentHooks } from "../spell-components/hooks.js";
import {
  getPlayerSurfaceStatus,
  openCalendar,
  registerPlayerSurfaceSocket,
} from "../player-surface.js";
import { SETTINGS, migrateEncounterBalanceDefaults } from "../settings.js";
import { registerTool } from "../tool-registry.js";
import { computeLootBudget } from "../loot/budget.js";
import {
  distributeItemsToActor,
  promptDistributeItems,
} from "../loot/distribute.js";
import { loadCompendiumItems } from "../loot/pack.js";
import {
  filterCandidates,
  getEffectiveRarity,
  rollLoot,
} from "../loot/roller.js";
import { getLootBundleBalanceOptions } from "../loot/category-balance.js";
import { tierWindow } from "../loot/tag-vocabulary.js";
import {
  initializePrivateState,
  onPrivateStateChanged,
} from "../private-state.js";
import { isFullGM, runAsFullGM } from "../permissions.js";
import { isAuthoritativeGM } from "../socket-authority.js";
import {
  applyUiDensity,
  getUiPreferences,
  registerUiPreferencesSetting,
  updateUiPreferences,
} from "../ui-preferences.js";
import { registerUiFoundationHooks } from "../infinity-app.js";
import { registerInfinityItemUuidRedirects } from "../item-uuid-compat.js";
import { MODULE_ID, PACK_ID, PRIVATE_STATE_RETRY_MS } from "./constants.js";

/**
 * The sole production composition root. The lifecycle modules consume these
 * explicit bindings; no feature implementation needs to know about bootstrap.
 */
export const runtimeBindings = Object.freeze({
  moduleId: MODULE_ID,
  packId: PACK_ID,
  privateStateRetryMs: PRIVATE_STATE_RETRY_MS,
  logger: console,
  getGame: () => globalThis.game,
  getHooks: () => globalThis.Hooks,
  getUi: () => globalThis.ui,
  getDocument: () => globalThis.document,
  getConfig: () => globalThis.CONFIG,
  getConst: () => globalThis.CONST,
  getFoundry: () => globalThis.foundry,
  setTimeout: (callback, delay) => globalThis.setTimeout?.(callback, delay),
  clearTimeout: (timer) => globalThis.clearTimeout?.(timer),

  openHub,
  LootStudioApp,
  InfinitySettingsApp,
  MerchantWorkspaceApp,
  MerchantSessionApp,
  registerMerchantSessionAutoOpen,
  ShopPickerApp,
  ResourceManagerApp,
  ResourceOverviewApp,
  ForagePromptApp,
  registerForagePromptAutoOpen,
  registerResourceSocket,
  registerResourceOverviewService,
  CriticalInjuryApp,
  registerCriticalInjuryApp,
  CriticalInjuryHudApp,
  registerCriticalInjuryHud,
  registerCriticalInjurySocket,
  registerCriticalInjuryService,
  CRITICAL_INJURY_TABLE,
  CRITICAL_INJURY_TABLE_VERSION,
  registerResourceCalendarWatcher,
  advanceDayNow,
  isResourceAutomationReady,
  migrateResourceConfig,
  observeResourceAuthorityTransition,
  registerMerchantSocket,
  ReputationWorkspaceApp,
  ReputationViewApp,
  registerReputationSocket,
  DowntimeWorkspaceApp,
  DowntimeActivitiesApp,
  configureDowntimePlayerAutoOpen,
  getDowntimePlayerAdapter,
  downtimeWorkspaceAdapter,
  registerDowntimeService,
  notifyLongRest,
  notifySharpenDamage,
  registerDowntimeSocket,
  registerSharpeningHooks,
  SOUND_EVENTS,
  SOUND_REGISTRY,
  playSoundEvent,
  preloadModuleSounds,
  registerSoundSocket,
  registerMonksTokenbarCompat,
  registerMonksActiveTilesCompat,
  registerSoundAutomation,
  registerSpellComponentHooks,
  getPlayerSurfaceStatus,
  openCalendar,
  registerPlayerSurfaceSocket,
  SETTINGS,
  migrateEncounterBalanceDefaults,
  registerTool,
  computeLootBudget,
  distributeItemsToActor,
  promptDistributeItems,
  loadCompendiumItems,
  filterCandidates,
  getEffectiveRarity,
  rollLoot,
  getLootBundleBalanceOptions,
  tierWindow,
  initializePrivateState,
  onPrivateStateChanged,
  isFullGM,
  runAsFullGM,
  isAuthoritativeGM,
  applyUiDensity,
  getUiPreferences,
  registerUiPreferencesSetting,
  updateUiPreferences,
  registerUiFoundationHooks,
  registerInfinityItemUuidRedirects,
});
