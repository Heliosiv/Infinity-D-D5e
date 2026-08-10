/**
 * Own late private-state recovery, promoted-GM handoff, and private-dependent
 * service registration. State lives inside the controller instead of the ESM
 * entry point so it can be characterized without a Foundry world.
 */
export function createPrivateStateRecovery(bindings) {
  let readyBootComplete = false;
  let recoveryInFlight = null;
  let recoveryTimer = null;
  let recoveryHooksRegistered = false;

  function registerPrivateDependentServices() {
    bindings.safeInitializeSubsystem(
      "merchant socket",
      bindings.registerMerchantSocket,
    );
    bindings.safeInitializeSubsystem(
      "resource overview service",
      bindings.registerResourceOverviewService,
    );
    bindings.safeInitializeSubsystem(
      "resource calendar watcher",
      bindings.registerResourceCalendarWatcher,
    );
    bindings.safeInitializeSubsystem(
      "reputation socket",
      bindings.registerReputationSocket,
    );
    bindings.safeInitializeSubsystem(
      "critical injury service",
      bindings.registerCriticalInjuryService,
    );
    bindings.safeInitializeSubsystem(
      "downtime service",
      bindings.registerDowntimeService,
    );
  }

  function clearTimer() {
    if (recoveryTimer == null) return;
    bindings.clearTimeout(recoveryTimer);
    recoveryTimer = null;
  }

  function schedule() {
    if (!bindings.isFullGM() || recoveryTimer != null) return false;
    recoveryTimer = bindings.setTimeout(() => {
      recoveryTimer = null;
      void recover();
    }, bindings.privateStateRetryMs);
    return true;
  }

  function recover() {
    if (recoveryInFlight) return recoveryInFlight;
    let trackedRecovery;
    trackedRecovery = (async () => {
      let available = false;
      try {
        available = (await bindings.initializePrivateState()) === true;
      } catch (error) {
        bindings.logger.error(
          `${bindings.moduleId} | private state recovery failed`,
          error,
        );
      }
      if (!available) {
        schedule();
        return false;
      }

      if (bindings.isAuthoritativeGM()) {
        try {
          await bindings.migrateResourceConfig();
        } catch (error) {
          bindings.logger.error(
            `${bindings.moduleId} | resource config migration failed`,
            error,
          );
        }
        if (!bindings.isResourceAutomationReady()) {
          schedule();
          return false;
        }
      }

      clearTimer();
      registerPrivateDependentServices();
      return true;
    })().finally(() => {
      if (recoveryInFlight === trackedRecovery) recoveryInFlight = null;
    });
    recoveryInFlight = trackedRecovery;
    return trackedRecovery;
  }

  function registerHooks() {
    if (recoveryHooksRegistered) return false;
    recoveryHooksRegistered = true;
    bindings.observeResourceAuthorityTransition();

    const requestRecoveryAfterHooks = () => {
      void Promise.resolve().then(() => recover());
    };
    bindings.onPrivateStateChanged((payload) => {
      if (!readyBootComplete) return;
      const reason = String(payload?.reason ?? "");
      if (reason === "role-demotion") {
        clearTimer();
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
      if (
        bindings.isAuthoritativeGM() &&
        !bindings.isResourceAutomationReady()
      ) {
        requestRecoveryAfterHooks();
      }
    });

    const onAuthorityCandidateChanged = () => {
      const transition = bindings.observeResourceAuthorityTransition();
      if (!readyBootComplete || !transition.newlyAuthoritative) return;
      requestRecoveryAfterHooks();
    };
    const hooks = bindings.getHooks?.();
    hooks?.on?.("updateUser", onAuthorityCandidateChanged);
    hooks?.on?.("userConnected", onAuthorityCandidateChanged);
    return true;
  }

  function markReadyComplete() {
    readyBootComplete = true;
  }

  return {
    registerHooks,
    registerPrivateDependentServices,
    recover,
    schedule,
    clearTimer,
    markReadyComplete,
  };
}
