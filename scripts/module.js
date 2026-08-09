/**
 * Infinity D&D5e — Foundry entry point.
 *
 * Registers role-aware Home plus its unified scene-control launcher, and
 * seeds the full-GM tool registry with every available destination. Home reads the registry at
 * render time so adding a new tool only requires a registerTool()
 * call — no UI plumbing.
 */

import { openHub } from "./dashboard.js";
import { LootStudioApp } from "./loot-studio.js";
import { InfinitySettingsApp } from "./settings-app.js";
import { MerchantWorkspaceApp } from "./merchant-workspace.js";
import {
  MerchantSessionApp,
  registerMerchantSessionAutoOpen,
} from "./merchant-session.js";
import { ShopPickerApp } from "./shop-picker.js";
import { ResourceManagerApp } from "./resource-manager.js";
import { ResourceOverviewApp } from "./resource-overview.js";
import {
  ForagePromptApp,
  registerForagePromptAutoOpen,
} from "./forage-prompt.js";
import { registerResourceSocket } from "./resource/socket.js";
import { registerResourceOverviewService } from "./resource/overview-service.js";
import {
  CriticalInjuryApp,
  registerCriticalInjuryApp,
} from "./injury/injury-app.js";
import {
  CriticalInjuryHudApp,
  registerCriticalInjuryHud,
} from "./injury/injury-hud.js";
import { registerCriticalInjurySocket } from "./injury/socket.js";
import { registerCriticalInjuryService } from "./injury/service.js";
import {
  CRITICAL_INJURY_TABLE,
  CRITICAL_INJURY_TABLE_VERSION,
} from "./injury/table.js";
import {
  registerResourceCalendarWatcher,
  advanceDayNow,
} from "./resource/calendar-watcher.js";
import {
  isResourceAutomationReady,
  migrateResourceConfig,
  observeResourceAuthorityTransition,
} from "./resource/store.js";
import { registerMerchantSocket } from "./merchant/socket.js";
import { ReputationWorkspaceApp } from "./reputation-workspace.js";
import { ReputationViewApp } from "./reputation-view.js";
import { registerReputationSocket } from "./reputation/socket.js";
import { DowntimeWorkspaceApp } from "./downtime-workspace.js";
import { DowntimeActivitiesApp } from "./downtime-activities.js";
import {
  configureDowntimePlayerAutoOpen,
  getDowntimePlayerAdapter,
} from "./downtime/ui-adapter.js";
import {
  downtimeWorkspaceAdapter,
  registerDowntimeService,
} from "./downtime/service.js";
import {
  notifyLongRest,
  notifySharpenDamage,
  registerDowntimeSocket,
} from "./downtime/socket.js";
import { registerSharpeningHooks } from "./downtime/effects.js";
import {
  SOUND_EVENTS,
  SOUND_REGISTRY,
  playSoundEvent,
  preloadModuleSounds,
  registerSoundSocket,
} from "./audio.js";
import { registerMonksTokenbarCompat } from "./compat/monks-tokenbar.js";
import { registerMonksActiveTilesCompat } from "./compat/monks-active-tiles.js";
import { registerSoundAutomation } from "./compat/sound-automation.js";
import { registerSpellComponentHooks } from "./spell-components/hooks.js";
import {
  getPlayerSurfaceStatus,
  openCalendar,
  registerPlayerSurfaceSocket,
} from "./player-surface.js";
import {
  SETTINGS,
  SETTING_KEYS,
  getSetting,
  migrateEncounterBalanceDefaults,
} from "./settings.js";
import { registerTool } from "./tool-registry.js";
import { computeLootBudget } from "./loot/budget.js";
import {
  distributeItemsToActor,
  promptDistributeItems,
} from "./loot/distribute.js";
import { loadCompendiumItems } from "./loot/pack.js";
import {
  filterCandidates,
  getEffectiveRarity,
  rollLoot,
} from "./loot/roller.js";
import { getLootBundleBalanceOptions } from "./loot/category-balance.js";
import { tierWindow } from "./loot/tag-vocabulary.js";
import {
  initializePrivateState,
  onPrivateStateChanged,
} from "./private-state.js";
import { isFullGM, runAsFullGM } from "./permissions.js";
import { isAuthoritativeGM as isSharedAuthoritativeGM } from "./socket-authority.js";
import {
  applyUiDensity,
  getUiPreferences,
  registerUiPreferencesSetting,
  updateUiPreferences,
} from "./ui-preferences.js";
import { registerUiFoundationHooks } from "./infinity-app.js";
import { registerInfinityItemUuidRedirects } from "./item-uuid-compat.js";

const MODULE_ID = "infinity-dnd5e";
const PACK_ID = `${MODULE_ID}.infinity-dnd5e-items`;
const PRIVATE_STATE_RETRY_MS = 5000;

let readyBootComplete = false;
let privateRecoveryInFlight = null;
let privateRecoveryTimer = null;
let privateRecoveryHooksRegistered = false;

function safeInitializeSubsystem(label, fn) {
  try {
    fn();
    return true;
  } catch (error) {
    console.error(`${MODULE_ID} | ${label} init failed`, error);
    return false;
  }
}

/**
 * Register every service that reads the restricted Journal cache. Each
 * registration is idempotent, so this is safe both during normal boot and
 * after a late store arrival or a current-user role change.
 */
function registerPrivateDependentServices() {
  safeInitializeSubsystem("merchant socket", registerMerchantSocket);
  safeInitializeSubsystem(
    "resource overview service",
    registerResourceOverviewService,
  );
  safeInitializeSubsystem(
    "resource calendar watcher",
    registerResourceCalendarWatcher,
  );
  safeInitializeSubsystem("reputation socket", registerReputationSocket);
  safeInitializeSubsystem(
    "critical injury service",
    registerCriticalInjuryService,
  );
  safeInitializeSubsystem("downtime service", registerDowntimeService);
}

function clearPrivateRecoveryTimer() {
  if (privateRecoveryTimer == null) return;
  globalThis.clearTimeout?.(privateRecoveryTimer);
  privateRecoveryTimer = null;
}

function schedulePrivateStateRecovery() {
  if (!isFullGM() || privateRecoveryTimer != null) return;
  privateRecoveryTimer = globalThis.setTimeout?.(() => {
    privateRecoveryTimer = null;
    void recoverPrivateStateAndServices();
  }, PRIVATE_STATE_RETRY_MS);
}

/**
 * Retry private-state hydration without requiring a Foundry reload. A promoted
 * or newly authoritative full GM also completes the resource v1 -> v2
 * migration before resource authority becomes writable.
 */
function recoverPrivateStateAndServices() {
  if (privateRecoveryInFlight) return privateRecoveryInFlight;
  let trackedRecovery;
  trackedRecovery = (async () => {
    let available = false;
    try {
      available = (await initializePrivateState()) === true;
    } catch (error) {
      console.error(`${MODULE_ID} | private state recovery failed`, error);
    }
    if (!available) {
      schedulePrivateStateRecovery();
      return false;
    }

    if (isSharedAuthoritativeGM()) {
      try {
        await migrateResourceConfig();
      } catch (error) {
        console.error(`${MODULE_ID} | resource config migration failed`, error);
      }
      if (!isResourceAutomationReady()) {
        schedulePrivateStateRecovery();
        return false;
      }
    }

    clearPrivateRecoveryTimer();
    registerPrivateDependentServices();
    return true;
  })().finally(() => {
    if (privateRecoveryInFlight === trackedRecovery) {
      privateRecoveryInFlight = null;
    }
  });
  privateRecoveryInFlight = trackedRecovery;
  return trackedRecovery;
}

function registerPrivateStateRecoveryHooks() {
  if (privateRecoveryHooksRegistered) return;
  privateRecoveryHooksRegistered = true;
  observeResourceAuthorityTransition();
  const requestRecoveryAfterHooks = () => {
    void Promise.resolve().then(() => recoverPrivateStateAndServices());
  };
  onPrivateStateChanged((payload) => {
    if (!readyBootComplete) return;
    const reason = String(payload?.reason ?? "");
    if (reason === "role-demotion") {
      clearPrivateRecoveryTimer();
      return;
    }
    if (
      reason === "role-promotion" ||
      reason === "store-ready" ||
      reason === "journal-create" ||
      reason === "journal-replacement" ||
      reason === "authority-change"
    ) {
      requestRecoveryAfterHooks();
      return;
    }
    if (isSharedAuthoritativeGM() && !isResourceAutomationReady()) {
      requestRecoveryAfterHooks();
    }
  });
  const onAuthorityCandidateChanged = () => {
    const transition = observeResourceAuthorityTransition();
    if (!readyBootComplete || !transition.newlyAuthoritative) return;
    requestRecoveryAfterHooks();
  };
  globalThis.Hooks?.on?.("updateUser", onAuthorityCandidateChanged);
  globalThis.Hooks?.on?.("userConnected", onAuthorityCandidateChanged);
}

// Very first thing we do — log that the ESM was evaluated at all. If
// this line never appears in the console, the import chain failed
// before our code ran (usually a top-level evaluation error in one of
// the imported files).
console.log(`${MODULE_ID} | module.js evaluating…`);
safeInitializeSubsystem(
  "Monk's Active Tiles action hook",
  registerMonksActiveTilesCompat,
);
globalThis.Hooks?.once?.("socketlib.ready", () => {
  safeInitializeSubsystem(
    "player-surface SocketLib",
    registerPlayerSurfaceSocket,
  );
});

/* ------------------------------------------------------------------ *
 * Eager API assignment
 *
 * Foundry exposes a per-module API object via game.modules.get(id).api.
 * The traditional pattern is to set it inside `ready`, but if anything
 * else in `ready` throws first, the API never gets set — and macros,
 * Shift+I, and console probing all silently fail.
 *
 * Assigning here, at top-level evaluation, gives us a stable API as
 * long as the ESM loads at all, independent of any hook outcome.
 * ------------------------------------------------------------------ */

function buildApi() {
  return {
    openHub: () => openHub(),
    openDashboard: () => runAsFullGM(() => openHub()),
    openLootStudio: (options = {}) =>
      runAsFullGM(() => LootStudioApp.open(options)),
    openPerEncounterLoot: () =>
      runAsFullGM(() => LootStudioApp.open({ mode: "encounter" })),
    openHoardLoot: () =>
      runAsFullGM(() => LootStudioApp.open({ mode: "hoard" })),
    openPerCreatureLoot: () =>
      runAsFullGM(() => LootStudioApp.open({ mode: "creature" })),
    openMerchantWorkspace: () => runAsFullGM(() => MerchantWorkspaceApp.open()),
    openShops: () => ShopPickerApp.open(),
    openResourceManager: () => runAsFullGM(() => ResourceManagerApp.open()),
    openPartySupplies: () => ResourceOverviewApp.open(),
    openCriticalInjuries: () => CriticalInjuryApp.openForCurrentUser(),
    openCriticalInjuryHud: () => CriticalInjuryHudApp.reconcile(),
    openReputation: () => runAsFullGM(() => ReputationWorkspaceApp.open()),
    openReputationView: () => ReputationViewApp.open(),
    openDowntimeWorkspace: () => runAsFullGM(() => DowntimeWorkspaceApp.open()),
    openDowntimeActivities: (options = {}) =>
      DowntimeActivitiesApp.open(options),
    openCalendar: () => openCalendar(),
    openSettings: () => InfinitySettingsApp.open(),
    getUiPreferences: () => getUiPreferences(),
    updateUiPreferences: (patch) => updateUiPreferences(patch),
    getPlayerSurfaceStatus,
    advanceDay: () => runAsFullGM(() => advanceDayNow()),
    MerchantSessionApp,
    ForagePromptApp,
    CriticalInjuryApp,
    CriticalInjuryHudApp,
    criticalInjuries: {
      tableVersion: CRITICAL_INJURY_TABLE_VERSION,
      table: CRITICAL_INJURY_TABLE,
    },
    SOUND_EVENTS,
    SOUND_REGISTRY,
    playSoundEvent: (eventKey, options = {}) =>
      playSoundEvent(eventKey, {
        ...options,
        audience: isFullGM() ? options.audience : "local",
      }),

    rollLootBundle: async (opts = {}) => {
      if (!isFullGM()) throw new Error("PermissionDenied: GM-only loot API");
      const tier = opts.tier ?? "t2";
      const lootTypes = opts.lootTypes ?? [];
      const budget = computeLootBudget({
        tier,
        scale: opts.scale ?? "standard",
        generosity: opts.generosity ?? "balanced",
        partySize: opts.partySize ?? 4,
        override: opts.budgetOverride ?? 0,
      });
      const items = await loadCompendiumItems({
        packId: opts.packId ?? PACK_ID,
      });
      const candidates = filterCandidates(items, {
        tiers: tierWindow(tier),
        rarities: opts.rarities ?? [],
        lootTypes,
        requireEligible: true,
      });
      const balanceOptions = getLootBundleBalanceOptions({ tier, lootTypes });
      const raw = rollLoot(candidates, {
        count: opts.count ?? 0,
        budgetGp: budget,
        magicBias: opts.magicBias ?? 0,
        artVariants: opts.artVariants === true,
        ...balanceOptions,
        rarityWeights: opts.rarityWeights ?? balanceOptions.rarityWeights,
      });
      return {
        ...raw,
        items: raw.items.map((entry) => ({
          ...entry,
          uuid: entry.item?.uuid ?? null,
          rarity: getEffectiveRarity(entry.item),
        })),
      };
    },

    distributeBundle: (actorId, uuids) =>
      runAsFullGM(() => distributeItemsToActor(actorId, uuids)),

    promptDistribute: (uuids, options) =>
      runAsFullGM(() => promptDistributeItems(uuids, options)),
  };
}

try {
  const eagerMod = globalThis.game?.modules?.get?.(MODULE_ID);
  if (eagerMod) {
    eagerMod.api = buildApi();
    console.log(`${MODULE_ID} | api set eagerly at module-load time`);
  } else {
    console.log(
      `${MODULE_ID} | game.modules not ready at load — will retry at init/ready`,
    );
  }
} catch (error) {
  console.warn(`${MODULE_ID} | eager api assignment failed`, error);
}

/* ------------------------------------------------------------------ *
 * Settings registration
 * ------------------------------------------------------------------ */

function registerSettings() {
  if (!game?.settings?.register) return;
  for (const entry of SETTINGS) {
    const opts = {
      name: entry.name,
      hint: entry.hint,
      scope: entry.scope,
      // The role-aware Infinity Settings menu has source-tested parity with
      // every catalog entry; keep the duplicate raw controls out of Foundry's
      // flat module list while preserving every existing key and value.
      config: false,
      type: entry.type,
      default: entry.default,
    };
    if (entry.choices) opts.choices = entry.choices;
    if (entry.range) opts.range = entry.range;
    if (entry.onChange) opts.onChange = entry.onChange;
    try {
      game.settings.register(MODULE_ID, entry.key, opts);
    } catch (error) {
      console.warn(
        `${MODULE_ID} | failed to register setting "${entry.key}"`,
        error,
      );
    }
  }
  registerUiPreferencesSetting(game, {
    onChange: (preferences) => {
      for (const root of globalThis.document?.querySelectorAll?.(
        ".application.infinity-dnd5e",
      ) ?? []) {
        applyUiDensity(root, preferences);
      }
      globalThis.Hooks?.callAll?.(
        "infinityDnd5eUiPreferencesChanged",
        preferences,
      );
    },
  });
  if (typeof game.settings.registerMenu === "function") {
    try {
      game.settings.registerMenu(MODULE_ID, "infinitySettings", {
        name: "Infinity Settings",
        label: "Open Infinity Settings",
        hint: "Role-aware settings, accessibility preferences, quick starts, and campaign defaults.",
        icon: "fa-solid fa-sliders",
        type: InfinitySettingsApp,
        restricted: false,
      });
    } catch (error) {
      console.warn(
        `${MODULE_ID} | failed to register settings workspace`,
        error,
      );
    }
  }
}

/* ------------------------------------------------------------------ *
 * dnd5e item-type registration
 *
 * The curated pack reclassifies raw alchemical ingredients (herbs, fungi,
 * reagents) out of the "potion" bucket and onto a dedicated "reagent"
 * subtype. dnd5e ships no such subtype, so we register it on CONFIG before
 * any sheet renders — for both `consumable` items (e.g. dried herbs that
 * keep a use activity) and `loot` items (inert spell components / ritual
 * herbs). Without this the dnd5e Details tab would show a blank subtype for
 * `system.type.value === "reagent"`; with it, the native sheet reads
 * "Reagent" and the module's "Alchemical Supplies" chip lines up.
 * ------------------------------------------------------------------ */

function registerReagentItemType() {
  const dnd5e = globalThis.CONFIG?.DND5E;
  if (!dnd5e) return;
  const entry = { label: "Reagent" };
  if (dnd5e.consumableTypes && !dnd5e.consumableTypes.reagent) {
    dnd5e.consumableTypes.reagent = entry;
  }
  if (dnd5e.lootTypes && !dnd5e.lootTypes.reagent) {
    dnd5e.lootTypes.reagent = { ...entry };
  }
}

/* ------------------------------------------------------------------ *
 * Tool registration
 * ------------------------------------------------------------------ */

function registerBuiltinTools() {
  registerTool({
    id: "loot-studio",
    title: "Loot Studio",
    description:
      "Generate encounter rewards, treasure hoards, or creature drops in one workspace.",
    icon: "fa-solid fa-coins",
    category: "loot",
    status: "available",
    open: () => LootStudioApp.open(),
  });

  registerTool({
    id: "merchant-workspace",
    title: "Merchant Workspace",
    description:
      "Curate merchants — inventory, markup, bargain DC, allowed players — then open shopping sessions yourself, or mark shops self-service so players browse them from their own Shops door (Shift+O).",
    icon: "fa-solid fa-store",
    category: "merchants",
    status: "available",
    open: () => MerchantWorkspaceApp.open(),
  });

  registerTool({
    id: "resource-manager",
    title: "Quartermaster",
    description:
      "Track food, water, and light. As days pass, players forage (Survival) and the party's supplies are spent automatically.",
    icon: "fa-solid fa-campground",
    category: "party",
    status: "available",
    open: () => ResourceManagerApp.open(),
  });

  registerTool({
    id: "downtime-workspace",
    title: "Downtime Workspace",
    description:
      "Give every eligible character an hour budget, collect queued city activities, preview hidden outcomes, and apply exact receipts.",
    icon: "fa-solid fa-hourglass-half",
    category: "party",
    status: "available",
    open: () => DowntimeWorkspaceApp.open(),
  });

  registerTool({
    id: "reputation",
    title: "Reputation & Factions",
    description:
      "Track how each faction leans toward the party. Raise or lower standings with a logged reason, and reveal factions to players (Shift+R).",
    icon: "fa-solid fa-handshake",
    category: "party",
    status: "available",
    open: () => ReputationWorkspaceApp.open(),
  });
}

/* ------------------------------------------------------------------ *
 * Foundry lifecycle hooks
 * ------------------------------------------------------------------ */

Hooks.once("init", () => {
  console.log(`${MODULE_ID} | init hook firing`);
  // Re-set the api here too in case eager assignment ran before
  // game.modules existed.
  try {
    const mod = game.modules?.get?.(MODULE_ID);
    if (mod && !mod.api) {
      mod.api = buildApi();
      console.log(`${MODULE_ID} | api set during init`);
    }
  } catch (error) {
    console.warn(`${MODULE_ID} | init api assignment failed`, error);
  }
  try {
    registerReagentItemType();
  } catch (error) {
    console.error(`${MODULE_ID} | registerReagentItemType failed`, error);
  }
  try {
    registerSettings();
  } catch (error) {
    console.error(`${MODULE_ID} | registerSettings failed`, error);
  }
  try {
    registerUiFoundationHooks();
  } catch (error) {
    console.error(`${MODULE_ID} | UI foundation registration failed`, error);
  }
  try {
    registerInfinityItemUuidRedirects();
  } catch (error) {
    console.error(`${MODULE_ID} | legacy item UUID redirects failed`, error);
  }
  try {
    registerKeybindings();
  } catch (error) {
    console.error(`${MODULE_ID} | registerKeybindings failed`, error);
  }
  try {
    registerBuiltinTools();
  } catch (error) {
    console.error(`${MODULE_ID} | registerBuiltinTools failed`, error);
  }
  try {
    DowntimeWorkspaceApp.configure({
      adapterFactory: () => downtimeWorkspaceAdapter,
    });
    DowntimeActivitiesApp.configure({
      adapterFactory: () => getDowntimePlayerAdapter(),
    });
  } catch (error) {
    console.error(`${MODULE_ID} | downtime UI configuration failed`, error);
  }
  console.log(`${MODULE_ID} | init hook complete`);
});

/* ------------------------------------------------------------------ *
 * Keybindings
 *
 * Registers Shift+I (default — user-rebindable from Configure Controls)
 * to open role-aware Home from anywhere in the game.
 * ------------------------------------------------------------------ */

function registerKeybindings() {
  if (!game?.keybindings?.register) return;
  try {
    game.keybindings.register(MODULE_ID, "openDashboard", {
      name: "Open Infinity D&D5e Home",
      hint: "Open the role-aware Infinity Home from anywhere in the game.",
      editable: [{ key: "KeyI", modifiers: ["Shift"] }],
      onDown: () => {
        openHub();
        return true; // consume the event
      },
      restricted: false,
      precedence: globalThis.CONST?.KEYBINDING_PRECEDENCE?.NORMAL,
    });
    // Player-facing Shops launcher — NOT restricted, so players can bind it.
    // GMs are no-op'd here (they use the Merchant Workspace).
    game.keybindings.register(MODULE_ID, "openShops", {
      name: "Open Infinity D&D5e Shops",
      hint: "Open the merchant shops you have access to (players).",
      editable: [{ key: "KeyO", modifiers: ["Shift"] }],
      onDown: () => {
        if (isFullGM()) return false;
        ShopPickerApp.open();
        return true;
      },
      precedence: globalThis.CONST?.KEYBINDING_PRECEDENCE?.NORMAL,
    });
    // Reputation view — players see where they stand; a GM gets a preview of
    // the same read-only view. Not restricted, so players can rebind it.
    game.keybindings.register(MODULE_ID, "openReputation", {
      name: "Open Infinity D&D5e Reputation",
      hint: "See the party's standing with revealed factions.",
      editable: [{ key: "KeyR", modifiers: ["Shift"] }],
      onDown: () => {
        ReputationViewApp.open();
        return true;
      },
      precedence: globalThis.CONST?.KEYBINDING_PRECEDENCE?.NORMAL,
    });
    // Party Supplies is the persistent read-only resource view. Players receive
    // only the authoritative GM's sanitized snapshot; GMs see the same preview.
    game.keybindings.register(MODULE_ID, "openPartySupplies", {
      name: "Open Infinity D&D5e Party Supplies",
      hint: "See the party's food, water, light, and supply outlook.",
      editable: [{ key: "KeyQ", modifiers: ["Shift"] }],
      onDown: () => {
        ResourceOverviewApp.open();
        return true;
      },
      precedence: globalThis.CONST?.KEYBINDING_PRECEDENCE?.NORMAL,
    });
    game.keybindings.register(MODULE_ID, "openCriticalInjuries", {
      name: "Open Infinity D&D5e Critical Injuries",
      hint: "Roll an approved injury and review your character's active injuries.",
      editable: [{ key: "KeyJ", modifiers: ["Shift"] }],
      onDown: () => {
        CriticalInjuryApp.openForCurrentUser();
        return true;
      },
      precedence: globalThis.CONST?.KEYBINDING_PRECEDENCE?.NORMAL,
    });
    game.keybindings.register(MODULE_ID, "openDowntimeActivities", {
      name: "Open Infinity D&D5e Downtime Activities",
      hint: "Plan activities for your eligible character during an active downtime block.",
      editable: [{ key: "KeyD", modifiers: ["Shift"] }],
      onDown: () => {
        DowntimeActivitiesApp.open();
        return true;
      },
      precedence: globalThis.CONST?.KEYBINDING_PRECEDENCE?.NORMAL,
    });
  } catch (error) {
    console.warn(`${MODULE_ID} | failed to register keybindings`, error);
  }
}

/**
 * Foundry ready — log the boot line and expose the module API.
 * Combined into a single handler so external code never has to guess
 * which ready pass owns which side effect.
 */
Hooks.once("ready", async () => {
  try {
    registerPrivateStateRecoveryHooks();
    let privateStateAvailable = false;
    try {
      privateStateAvailable = (await initializePrivateState()) === true;
    } catch (error) {
      console.error(`${MODULE_ID} | private state init failed`, error);
    }
    const version = game.modules?.get?.(MODULE_ID)?.version ?? "?";
    const foundryGen = globalThis.foundry?.utils?.foundryVersion?.generation;
    const foundryVersion = globalThis.game?.release?.version ?? "?";
    console.log(
      `%c${MODULE_ID} %cready · module v${version} · Foundry v${foundryVersion} (gen ${foundryGen ?? "?"}) · system ${game.system?.id}@${game.system?.version}`,
      "color: #ffb15d; font-weight: bold",
      "color: inherit",
    );
    console.log(
      `${MODULE_ID} | Home access: left scene-controls toolbar, Shift+I keybind, or game.modules.get("${MODULE_ID}").api.openHub()`,
    );
    console.log(
      `${MODULE_ID} | downtime access: Home for GMs; player Home, Shift+D, or game.modules.get("${MODULE_ID}").api.openDowntimeActivities()`,
    );
    // Final api set — always safe, idempotent.
    const mod = game.modules?.get?.(MODULE_ID);
    if (mod && !mod.api) mod.api = buildApi();
    // Move v1's duplicated resource rules into their canonical Foundry settings
    // before any resource service reads the configuration.
    if (isFullGM()) {
      try {
        await migrateEncounterBalanceDefaults();
      } catch (error) {
        console.error(
          `${MODULE_ID} | encounter balance migration failed`,
          error,
        );
      }
      if (privateStateAvailable) {
        try {
          await migrateResourceConfig();
        } catch (error) {
          console.error(
            `${MODULE_ID} | resource config migration failed`,
            error,
          );
        }
      }
    }
    // Register each subsystem in isolation: a throw in one (e.g. a sound hook)
    // must NOT skip the rest. Previously these ran bare in one try/catch, so a
    // single failing init silently disabled every registration after it —
    // including the merchant socket + session auto-open, which left players
    // unable to receive a pushed shop session.
    safeInitializeSubsystem("sound socket", registerSoundSocket);
    safeInitializeSubsystem(
      "spell component consumption",
      registerSpellComponentHooks,
    );
    safeInitializeSubsystem("sound automation", registerSoundAutomation);
    safeInitializeSubsystem(
      "player-surface SocketLib",
      registerPlayerSurfaceSocket,
    );
    safeInitializeSubsystem("downtime socket", registerDowntimeSocket);
    safeInitializeSubsystem("downtime player auto-open", () =>
      configureDowntimePlayerAutoOpen(({ actorId }) =>
        DowntimeActivitiesApp.open({ actorId }),
      ),
    );
    safeInitializeSubsystem("downtime sharpening hooks", () =>
      registerSharpeningHooks({
        onDamage: ({ item, rollId, effectId, operationId }) =>
          notifySharpenDamage(item, rollId, { effectId, operationId }),
        onLongRest: ({ actor, references }) =>
          notifyLongRest(actor, { references }),
      }),
    );
    if (privateStateAvailable) {
      registerPrivateDependentServices();
    }
    safeInitializeSubsystem(
      "merchant session auto-open",
      registerMerchantSessionAutoOpen,
    );
    // Quartermaster / party-resource feature.
    safeInitializeSubsystem("resource socket", registerResourceSocket);
    safeInitializeSubsystem(
      "critical injury socket",
      registerCriticalInjurySocket,
    );
    safeInitializeSubsystem(
      "critical injury player app",
      registerCriticalInjuryApp,
    );
    safeInitializeSubsystem(
      "critical injury body HUD",
      registerCriticalInjuryHud,
    );
    safeInitializeSubsystem(
      "forage prompt auto-open",
      registerForagePromptAutoOpen,
    );
    if (!privateStateAvailable && isFullGM()) {
      globalThis.ui?.notifications?.error?.(
        "Campaign tools are still loading. Merchant, downtime, Quartermaster, reputation, and critical-injury services will retry automatically; nothing needs to be repeated.",
      );
      schedulePrivateStateRecovery();
    } else if (
      privateStateAvailable &&
      isSharedAuthoritativeGM() &&
      !isResourceAutomationReady()
    ) {
      globalThis.ui?.notifications?.error?.(
        "Quartermaster setup is still loading. Automatic upkeep remains safely locked while this client retries; no supplies were changed.",
      );
      schedulePrivateStateRecovery();
    }
    // NOTE: merchant sessions deliberately SURVIVE a player disconnect now, so a
    // reload/relog can resume the pushed buy/sell window (the player re-requests
    // it on ready — see registerMerchantSessionAutoOpen). Previously we GC'd a
    // viewer's sessions on disconnect, which silently dropped the session a
    // reloading player needed to recover. Sessions now clear on a clean player
    // close, a GM close, merchant delete, or world reload.
    void registerMonksTokenbarCompat().catch((error) => {
      console.warn(`${MODULE_ID} | Monk's TokenBar compat failed`, error);
    });
    void preloadModuleSounds();
    readyBootComplete = true;
  } catch (error) {
    readyBootComplete = true;
    console.error(`${MODULE_ID} | ready hook failed`, error);
  }
});

/**
 * Add one role-aware entry point to the scene-controls toolbar.
 *
 * The single d20 category opens Home for every role. Home filters its own
 * destinations, so this launcher needs no role-specific campaign data.
 *
 * Foundry V13 hands us a Record<name, { tools: Record }>. The legacy Array
 * branch remains defensive, but tool activation uses V13's onChange API.
 */
Hooks.on("getSceneControlButtons", (controls) => {
  try {
    registerInfinitySceneControls(controls);
  } catch (error) {
    console.error(`${MODULE_ID} | scene-controls registration failed`, error);
  }
});

/**
 * Unified Home launcher for full GMs, Assistant GMs, and players.
 */
function registerInfinitySceneControls(controls) {
  const launcherToolName = "infinity-dnd5e-launcher";

  const baseTool = {
    title: "Open Infinity D&D5e Home",
    icon: "fa-solid fa-dice-d20",
    button: true,
    visible: true,
    toggle: false,
    onChange: () => openHub(),
  };

  const onCategoryChange = (_event, active) => {
    if (active) openHub();
  };

  const buildTool = (name, title, order) => ({
    ...baseTool,
    name,
    title,
    order,
  });

  // Diagnostic: log what shape we got so a missing launcher can be
  // traced from the console rather than guessed at.
  const shape = Array.isArray(controls)
    ? `Array(${controls.length})`
    : controls && typeof controls === "object"
      ? `Record(${Object.keys(controls).length})`
      : typeof controls;
  console.log(`${MODULE_ID} | scene-controls hook fired, shape=${shape}`);

  try {
    if (Array.isArray(controls)) {
      /* ---------- V12 shape: controls is an Array ---------- */
      // Guard against a re-fired hook against the same array (key assignment in
      // the V13 branch is naturally idempotent; an Array push is not).
      if (!controls.some((c) => c?.name === "infinity-dnd5e")) {
        controls.push({
          name: "infinity-dnd5e",
          title: "Infinity D&D5e",
          icon: "fa-solid fa-dice-d20",
          visible: true,
          activeTool: launcherToolName,
          order: 99,
          onChange: onCategoryChange,
          tools: [buildTool(launcherToolName, baseTool.title, 0)],
        });
      }
      console.log(`${MODULE_ID} | registered V12 role-aware Home control`);
    } else if (controls && typeof controls === "object") {
      /* ---------- V13+ shape: controls is a Record ---------- */
      controls["infinity-dnd5e"] = {
        name: "infinity-dnd5e",
        title: "Infinity D&D5e",
        icon: "fa-solid fa-dice-d20",
        visible: true,
        activeTool: launcherToolName,
        order: 99,
        onChange: onCategoryChange,
        tools: {
          [launcherToolName]: buildTool(launcherToolName, baseTool.title, 0),
        },
      };
      console.log(`${MODULE_ID} | registered V13 role-aware Home control`);
    } else {
      console.warn(
        `${MODULE_ID} | scene-controls payload was neither Array nor Object (got ${typeof controls}); skipping launcher registration`,
      );
    }
  } catch (error) {
    console.error(`${MODULE_ID} | scene-controls registration failed`, error);
  }
}
