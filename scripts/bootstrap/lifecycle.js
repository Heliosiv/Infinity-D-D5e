import { installModuleApi } from "./api.js";
import { createPrivateStateRecovery } from "./private-state-recovery.js";
import { createModuleRegistrars } from "./registrars.js";
import { applyInfinitySceneControls } from "./scene-controls.js";

/**
 * Build one idempotent Foundry lifecycle registrar around explicit bindings.
 */
export function createModuleBootstrap(bindings) {
  let registered = false;

  function safeInitializeSubsystem(label, fn) {
    try {
      fn();
      return true;
    } catch (error) {
      bindings.logger.error(
        `${bindings.moduleId} | ${label} init failed`,
        error,
      );
      return false;
    }
  }

  const registrars = createModuleRegistrars(bindings);
  const recovery = createPrivateStateRecovery({
    ...bindings,
    safeInitializeSubsystem,
  });

  function runInit() {
    bindings.logger.log(`${bindings.moduleId} | init hook firing`);
    try {
      if (installModuleApi(bindings)) {
        bindings.logger.log(`${bindings.moduleId} | api set during init`);
      }
    } catch (error) {
      bindings.logger.warn(
        `${bindings.moduleId} | init api assignment failed`,
        error,
      );
    }
    try {
      registrars.registerReagentItemType();
    } catch (error) {
      bindings.logger.error(
        `${bindings.moduleId} | registerReagentItemType failed`,
        error,
      );
    }
    try {
      registrars.registerSettings();
    } catch (error) {
      bindings.logger.error(
        `${bindings.moduleId} | registerSettings failed`,
        error,
      );
    }
    try {
      bindings.registerUiFoundationHooks();
    } catch (error) {
      bindings.logger.error(
        `${bindings.moduleId} | UI foundation registration failed`,
        error,
      );
    }
    try {
      bindings.registerInfinityItemUuidRedirects();
    } catch (error) {
      bindings.logger.error(
        `${bindings.moduleId} | legacy item UUID redirects failed`,
        error,
      );
    }
    try {
      registrars.registerKeybindings();
    } catch (error) {
      bindings.logger.error(
        `${bindings.moduleId} | registerKeybindings failed`,
        error,
      );
    }
    try {
      registrars.registerBuiltinTools();
    } catch (error) {
      bindings.logger.error(
        `${bindings.moduleId} | registerBuiltinTools failed`,
        error,
      );
    }
    try {
      registrars.configureDowntimeApps();
    } catch (error) {
      bindings.logger.error(
        `${bindings.moduleId} | downtime UI configuration failed`,
        error,
      );
    }
    bindings.logger.log(`${bindings.moduleId} | init hook complete`);
  }

  async function runReady() {
    try {
      recovery.registerHooks();
      let campaignLeadershipAvailable = true;
      if (bindings.isFullGM()) {
        try {
          campaignLeadershipAvailable =
            (await bindings.ensureCampaignTabLeadership()) === true;
        } catch (error) {
          campaignLeadershipAvailable = false;
          bindings.logger.error(
            `${bindings.moduleId} | campaign tab leadership failed`,
            error,
          );
        }
      }
      let privateStateAvailable = false;
      try {
        privateStateAvailable =
          (await bindings.initializePrivateState()) === true;
      } catch (error) {
        bindings.logger.error(
          `${bindings.moduleId} | private state init failed`,
          error,
        );
      }
      const privateStateStatus = bindings.getPrivateStateStatus?.() ?? {
        state: privateStateAvailable ? "ready" : "pending",
        code: privateStateAvailable ? "ready" : "store-unavailable",
        retryable: !privateStateAvailable,
        supportedSchema: null,
        observedSchema: null,
      };
      const hasCurrentCampaignLeadership = () =>
        !bindings.isFullGM() ||
        (campaignLeadershipAvailable &&
          bindings.hasCampaignTabLeadership() === true);

      const game = bindings.getGame?.();
      const version = game?.modules?.get?.(bindings.moduleId)?.version ?? "?";
      const foundryGeneration =
        bindings.getFoundry?.()?.utils?.foundryVersion?.generation;
      const foundryVersion = game?.release?.version ?? "?";
      bindings.logger.log(
        `%c${bindings.moduleId} %cready · module v${version} · Foundry v${foundryVersion} (gen ${foundryGeneration ?? "?"}) · system ${game?.system?.id}@${game?.system?.version}`,
        "color: #ffb15d; font-weight: bold",
        "color: inherit",
      );
      bindings.logger.log(
        `${bindings.moduleId} | Home access: left scene-controls toolbar, Shift+I keybind, or game.modules.get("${bindings.moduleId}").api.openHub()`,
      );
      bindings.logger.log(
        `${bindings.moduleId} | downtime access: Home for GMs; player Home, Shift+D, or game.modules.get("${bindings.moduleId}").api.openDowntimeActivities()`,
      );
      installModuleApi(bindings);

      let resourceMigrationBlocked = false;
      if (bindings.isFullGM()) {
        try {
          await bindings.migrateEncounterBalanceDefaults();
        } catch (error) {
          bindings.logger.error(
            `${bindings.moduleId} | encounter balance migration failed`,
            error,
          );
        }
        if (privateStateAvailable && bindings.isAuthoritativeGM()) {
          try {
            await bindings.migrateResourceConfig();
          } catch (error) {
            bindings.logger.error(
              `${bindings.moduleId} | resource config migration failed`,
              error,
            );
            resourceMigrationBlocked =
              error?.persistedVersionStatus?.state === "blocked";
          }
        }
      }

      safeInitializeSubsystem("sound socket", bindings.registerSoundSocket);
      safeInitializeSubsystem(
        "spell component consumption",
        bindings.registerSpellComponentHooks,
      );
      safeInitializeSubsystem(
        "sound automation",
        bindings.registerSoundAutomation,
      );
      safeInitializeSubsystem(
        "player-surface SocketLib",
        bindings.registerPlayerSurfaceSocket,
      );
      safeInitializeSubsystem(
        "downtime socket",
        bindings.registerDowntimeSocket,
      );
      safeInitializeSubsystem("downtime player auto-open", () =>
        bindings.configureDowntimePlayerAutoOpen(({ actorId }) =>
          bindings.DowntimeActivitiesApp.open({ actorId }),
        ),
      );
      safeInitializeSubsystem("downtime sharpening hooks", () =>
        bindings.registerSharpeningHooks({
          onDamage: ({ item, rollId, effectId, operationId }) =>
            bindings.notifySharpenDamage(item, rollId, {
              effectId,
              operationId,
            }),
          onLongRest: ({ actor, references }) =>
            bindings.notifyLongRest(actor, { references }),
        }),
      );
      if (privateStateAvailable && hasCurrentCampaignLeadership()) {
        recovery.registerPrivateDependentServices();
      }
      safeInitializeSubsystem(
        "merchant session auto-open",
        bindings.registerMerchantSessionAutoOpen,
      );
      safeInitializeSubsystem(
        "resource socket",
        bindings.registerResourceSocket,
      );
      safeInitializeSubsystem(
        "critical injury socket",
        bindings.registerCriticalInjurySocket,
      );
      safeInitializeSubsystem(
        "critical injury player app",
        bindings.registerCriticalInjuryApp,
      );
      safeInitializeSubsystem(
        "critical injury body HUD",
        bindings.registerCriticalInjuryHud,
      );
      safeInitializeSubsystem(
        "forage prompt auto-open",
        bindings.registerForagePromptAutoOpen,
      );

      if (
        !privateStateAvailable &&
        bindings.isFullGM() &&
        hasCurrentCampaignLeadership()
      ) {
        if (privateStateStatus.state === "blocked") {
          const corrupt = privateStateStatus.code === "corrupt";
          const missing = [
            "candidate-review-required",
            "missing-store",
            "store-missing",
          ].includes(privateStateStatus.code);
          const observed = privateStateStatus.observedSchema;
          const message = missing
            ? "Campaign tools are locked because the selected private-state Journal is missing or needs review. No campaign data was changed and automatic replacement is disabled. Open Home > Campaign data to inspect the available recovery choices."
            : corrupt
              ? "Campaign tools are locked because the current private-state store is incomplete or corrupt. No campaign data was changed and automatic retries are stopped. Open Home > Campaign data to inspect the available recovery choices."
              : `Campaign tools are locked because the private-state schema (${observed == null ? "invalid" : String(observed)}) is newer than or incompatible with this module (supports ${privateStateStatus.supportedSchema}). No campaign data was changed and automatic retries are stopped. Install a compatible module version, or open Home > Campaign data to inspect non-destructive recovery choices.`;
          bindings.getUi?.()?.notifications?.error?.(message);
        } else {
          bindings
            .getUi?.()
            ?.notifications?.error?.(
              "Campaign tools are still loading. Merchant, downtime, Quartermaster, reputation, and critical-injury services will retry automatically; nothing needs to be repeated.",
            );
          if (privateStateStatus.retryable === true) recovery.schedule();
        }
      } else if (
        privateStateAvailable &&
        bindings.isAuthoritativeGM() &&
        !bindings.isResourceAutomationReady()
      ) {
        bindings
          .getUi?.()
          ?.notifications?.error?.(
            resourceMigrationBlocked
              ? "Quartermaster is locked because its saved data was written by a newer or incompatible module version. No supplies were changed and automatic retries are stopped."
              : "Quartermaster setup is still loading. Automatic upkeep remains safely locked while this client retries; no supplies were changed.",
          );
        if (!resourceMigrationBlocked) recovery.schedule({ resource: true });
      }

      void bindings.registerMonksTokenbarCompat().catch((error) => {
        bindings.logger.warn(
          `${bindings.moduleId} | Monk's TokenBar compat failed`,
          error,
        );
      });
      void bindings.preloadModuleSounds();
      recovery.markReadyComplete({
        privateStateAvailable,
        campaignLeadershipAvailable: hasCurrentCampaignLeadership(),
      });
    } catch (error) {
      recovery.markReadyComplete();
      bindings.logger.error(`${bindings.moduleId} | ready hook failed`, error);
    }
  }

  function register() {
    if (registered) return false;
    registered = true;

    bindings.logger.log(`${bindings.moduleId} | module.js evaluating…`);
    safeInitializeSubsystem(
      "Monk's Active Tiles action hook",
      bindings.registerMonksActiveTilesCompat,
    );

    const hooks = bindings.getHooks?.();
    hooks?.once?.("socketlib.ready", () => {
      safeInitializeSubsystem(
        "player-surface SocketLib",
        bindings.registerPlayerSurfaceSocket,
      );
    });

    try {
      if (installModuleApi(bindings, { replace: true })) {
        bindings.logger.log(
          `${bindings.moduleId} | api set eagerly at module-load time`,
        );
      } else {
        bindings.logger.log(
          `${bindings.moduleId} | game.modules not ready at load — will retry at init/ready`,
        );
      }
    } catch (error) {
      bindings.logger.warn(
        `${bindings.moduleId} | eager api assignment failed`,
        error,
      );
    }

    hooks?.once?.("init", runInit);
    hooks?.once?.("ready", runReady);
    hooks?.on?.("getSceneControlButtons", (controls) => {
      try {
        applyInfinitySceneControls(controls, bindings);
      } catch (error) {
        bindings.logger.error(
          `${bindings.moduleId} | scene-controls registration failed`,
          error,
        );
      }
    });
    return true;
  }

  return { register };
}
