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
  const registeredServices = new Set();

  function registerService(key, label, registrar) {
    if (registeredServices.has(key)) return false;
    const registered = bindings.safeInitializeSubsystem(label, registrar);
    if (registered !== false) registeredServices.add(key);
    return registered !== false;
  }

  function registerPrivateDependentServices() {
    registerService(
      "merchant",
      "merchant socket",
      bindings.registerMerchantSocket,
    );
    registerService(
      "resource-overview",
      "resource overview service",
      bindings.registerResourceOverviewService,
    );
    if (
      !bindings.isFullGM() ||
      (bindings.isAuthoritativeGM() && bindings.isResourceAutomationReady())
    ) {
      registerService(
        "resource-calendar",
        "resource calendar watcher",
        bindings.registerResourceCalendarWatcher,
      );
    }
    registerService(
      "reputation",
      "reputation socket",
      bindings.registerReputationSocket,
    );
    registerService(
      "critical-injury",
      "critical injury service",
      bindings.registerCriticalInjuryService,
    );
    registerService(
      "downtime",
      "downtime service",
      bindings.registerDowntimeService,
    );
  }

  function clearTimer() {
    if (recoveryTimer == null) return;
    bindings.clearTimeout(recoveryTimer);
    recoveryTimer = null;
  }

  function currentStatus() {
    return (
      bindings.getPrivateStateStatus?.() ?? {
        state: "pending",
        code: "unknown",
        retryable: true,
      }
    );
  }

  function requestRecoveryAfterHooks() {
    void Promise.resolve().then(() => recover());
  }

  function schedule({ resource = false } = {}) {
    if (!bindings.isFullGM()) return false;
    const status = currentStatus();
    if (status.state === "blocked") {
      clearTimer();
      return false;
    }
    if (recoveryTimer != null) return false;
    if (!resource && status.retryable !== true) return false;
    recoveryTimer = bindings.setTimeout(() => {
      recoveryTimer = null;
      void recover();
    }, bindings.privateStateRetryMs);
    return true;
  }

  function recover() {
    if (recoveryInFlight) return recoveryInFlight;
    if (currentStatus().state === "blocked") {
      clearTimer();
      return Promise.resolve(false);
    }
    const calendarWasRegistered = registeredServices.has("resource-calendar");
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
        if (currentStatus().retryable === true) schedule();
        else clearTimer();
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
          registerPrivateDependentServices();
          if (error?.persistedVersionStatus?.state === "blocked") {
            clearTimer();
            return false;
          }
        }
        registerPrivateDependentServices();
        if (!bindings.isResourceAutomationReady()) {
          schedule({ resource: true });
          return false;
        }
      }

      clearTimer();
      registerPrivateDependentServices();
      if (
        calendarWasRegistered &&
        bindings.isFullGM() &&
        bindings.isAuthoritativeGM() &&
        bindings.isResourceAutomationReady() &&
        typeof bindings.reconcileResourceCalendarWatcher === "function"
      ) {
        bindings.safeInitializeSubsystem(
          "resource calendar authority reconciliation",
          () => bindings.reconcileResourceCalendarWatcher(),
        );
      }
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

    bindings.onPrivateStateChanged((payload) => {
      if (!readyBootComplete) return;
      const reason = String(payload?.reason ?? "");
      if (
        reason === "role-demotion" ||
        reason === "schema-blocked" ||
        payload?.status?.state === "blocked"
      ) {
        clearTimer();
        return;
      }
      if (
        reason === "role-promotion" ||
        reason === "store-ready" ||
        reason === "journal-create" ||
        reason === "journal-replacement" ||
        reason === "schema-retry" ||
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

  function markReadyComplete({ privateStateAvailable = false } = {}) {
    const wasComplete = readyBootComplete;
    readyBootComplete = true;
    if (
      !wasComplete &&
      !privateStateAvailable &&
      bindings.isFullGM() &&
      currentStatus().state === "ready"
    ) {
      requestRecoveryAfterHooks();
    }
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
