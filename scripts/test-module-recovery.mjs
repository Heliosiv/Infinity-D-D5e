import assert from "node:assert/strict";

import { createPrivateStateRecovery } from "./bootstrap/private-state-recovery.js";

function deferred() {
  let resolve;
  const promise = new Promise((done) => (resolve = done));
  return { promise, resolve };
}

{
  const trace = [];
  const hooks = new Map();
  const timers = new Map();
  let nextTimer = 0;
  let privateStateCallback = null;
  const firstInitialization = deferred();
  let initialization = () => firstInitialization.promise;
  const services = [
    "merchant",
    "overview",
    "calendar",
    "reputation",
    "injury",
    "downtime",
  ];
  const service = (name) => () => trace.push(`service:${name}`);
  const controller = createPrivateStateRecovery({
    moduleId: "infinity-dnd5e",
    privateStateRetryMs: 5000,
    logger: { error: () => {} },
    safeInitializeSubsystem: (_label, callback) => callback(),
    registerMerchantSocket: service("merchant"),
    registerResourceOverviewService: service("overview"),
    registerResourceCalendarWatcher: service("calendar"),
    registerReputationSocket: service("reputation"),
    registerCriticalInjuryService: service("injury"),
    registerDowntimeService: service("downtime"),
    initializePrivateState: () => {
      trace.push("initialize");
      return initialization();
    },
    isFullGM: () => true,
    isAuthoritativeGM: () => true,
    migrateResourceConfig: async () => trace.push("migrate"),
    isResourceAutomationReady: () => true,
    observeResourceAuthorityTransition: () => {
      trace.push("observe");
      return { newlyAuthoritative: false };
    },
    onPrivateStateChanged: (callback) => {
      privateStateCallback = callback;
      trace.push("private-hook");
    },
    getHooks: () => ({
      on: (name, callback) => hooks.set(name, callback),
    }),
    setTimeout: (callback, delay) => {
      const id = ++nextTimer;
      timers.set(id, { callback, delay });
      trace.push(`timer:${id}`);
      return id;
    },
    clearTimeout: (id) => {
      timers.delete(id);
      trace.push(`clear:${id}`);
    },
  });

  assert.equal(controller.registerHooks(), true);
  assert.equal(controller.registerHooks(), false);
  assert.deepEqual(trace, ["observe", "private-hook"]);
  assert.equal(typeof hooks.get("updateUser"), "function");
  assert.equal(typeof hooks.get("userConnected"), "function");

  const first = controller.recover();
  const duplicate = controller.recover();
  assert.equal(first, duplicate, "recovery is single-flight");
  firstInitialization.resolve(true);
  assert.equal(await first, true);
  assert.deepEqual(trace.slice(-8), [
    "initialize",
    "migrate",
    ...services.map((name) => `service:${name}`),
  ]);

  assert.equal(controller.schedule(), true);
  assert.equal(controller.schedule(), false);
  assert.equal(timers.size, 1, "only one retry timer is active");
  controller.markReadyComplete();
  privateStateCallback({ reason: "role-demotion" });
  assert.equal(timers.size, 0, "demotion clears the pending retry");

  initialization = async () => true;
  privateStateCallback({ reason: "role-promotion" });
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
  assert.ok(
    trace.filter((entry) => entry === "initialize").length >= 2,
    "promotion requests recovery after the current Foundry hook completes",
  );
}

{
  const timers = [];
  const controller = createPrivateStateRecovery({
    moduleId: "infinity-dnd5e",
    privateStateRetryMs: 5000,
    logger: { error: () => {} },
    safeInitializeSubsystem: () => {},
    initializePrivateState: async () => false,
    isFullGM: () => true,
    isAuthoritativeGM: () => false,
    setTimeout: (callback, delay) => {
      timers.push({ callback, delay });
      return timers.length;
    },
    clearTimeout: () => {},
  });
  assert.equal(await controller.recover(), false);
  assert.equal(await controller.recover(), false);
  assert.equal(
    timers.length,
    1,
    "failed hydration schedules one bounded retry",
  );
  assert.equal(timers[0].delay, 5000);
}

{
  let status = {
    state: "pending",
    code: "store-unavailable",
    retryable: true,
  };
  let initializeResult = false;
  let initializeCalls = 0;
  let privateStateCallback = null;
  let nextTimer = 0;
  const timers = new Map();
  const services = [];
  const service = (name) => () => services.push(name);
  const controller = createPrivateStateRecovery({
    moduleId: "infinity-dnd5e",
    privateStateRetryMs: 5000,
    logger: { error: () => {} },
    safeInitializeSubsystem: (_label, callback) => callback(),
    getPrivateStateStatus: () => status,
    initializePrivateState: async () => {
      initializeCalls += 1;
      return initializeResult;
    },
    isFullGM: () => true,
    isAuthoritativeGM: () => false,
    isResourceAutomationReady: () => false,
    registerMerchantSocket: service("merchant"),
    registerResourceOverviewService: service("overview"),
    registerResourceCalendarWatcher: service("calendar"),
    registerReputationSocket: service("reputation"),
    registerCriticalInjuryService: service("injury"),
    registerDowntimeService: service("downtime"),
    observeResourceAuthorityTransition: () => ({
      newlyAuthoritative: false,
    }),
    onPrivateStateChanged: (callback) => {
      privateStateCallback = callback;
    },
    getHooks: () => ({ on: () => null }),
    setTimeout: (callback, delay) => {
      const id = ++nextTimer;
      timers.set(id, { callback, delay });
      return id;
    },
    clearTimeout: (id) => timers.delete(id),
  });

  controller.registerHooks();
  controller.markReadyComplete();
  assert.equal(controller.schedule(), true);
  assert.equal(timers.size, 1);

  status = {
    state: "blocked",
    code: "future-schema",
    retryable: false,
  };
  privateStateCallback({ reason: "schema-blocked", status });
  assert.equal(timers.size, 0, "a schema block clears the pending timer");
  assert.equal(await controller.recover(), false);
  assert.equal(
    initializeCalls,
    0,
    "blocked recovery does not touch private state",
  );

  status = {
    state: "pending",
    code: "store-unavailable",
    retryable: true,
  };
  initializeResult = true;
  privateStateCallback({ reason: "schema-retry", status });
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(initializeCalls, 1);
  assert.deepEqual(services, [
    "merchant",
    "overview",
    "reputation",
    "injury",
    "downtime",
  ]);
}

// A store-ready hook can land after the ready hook's initial false result but
// before ready gating opens. markReadyComplete reconciles the current status so
// that event is not lost.
{
  let status = {
    state: "pending",
    code: "store-unavailable",
    retryable: true,
  };
  let privateStateCallback = null;
  let initializeCalls = 0;
  const services = [];
  const service = (name) => () => services.push(name);
  const controller = createPrivateStateRecovery({
    moduleId: "infinity-dnd5e",
    privateStateRetryMs: 5000,
    logger: { error: () => {} },
    safeInitializeSubsystem: (_label, callback) => callback(),
    getPrivateStateStatus: () => status,
    initializePrivateState: async () => {
      initializeCalls += 1;
      return true;
    },
    isFullGM: () => true,
    isAuthoritativeGM: () => false,
    isResourceAutomationReady: () => false,
    registerMerchantSocket: service("merchant"),
    registerResourceOverviewService: service("overview"),
    registerResourceCalendarWatcher: service("calendar"),
    registerReputationSocket: service("reputation"),
    registerCriticalInjuryService: service("injury"),
    registerDowntimeService: service("downtime"),
    observeResourceAuthorityTransition: () => ({ newlyAuthoritative: false }),
    onPrivateStateChanged: (callback) => {
      privateStateCallback = callback;
    },
    getHooks: () => ({ on: () => null }),
    setTimeout: () => 1,
    clearTimeout: () => {},
  });
  controller.registerHooks();
  status = { state: "ready", code: "ready", retryable: false };
  privateStateCallback({ reason: "store-ready", status });
  assert.equal(
    initializeCalls,
    0,
    "the pre-gate hook is intentionally deferred",
  );

  controller.markReadyComplete({ privateStateAvailable: false });
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(initializeCalls, 1);
  assert.deepEqual(services, [
    "merchant",
    "overview",
    "reputation",
    "injury",
    "downtime",
  ]);
}

// A full GM that starts as a secondary authority must not spend the calendar
// watcher's one-time ready sync while it cannot act. The authority handoff
// recovery registers the watcher once, after migration makes automation ready.
{
  let authoritative = false;
  let resourceReady = false;
  let newlyAuthoritative = false;
  const services = [];
  const hooks = new Map();
  const service = (name) => () => services.push(name);
  const controller = createPrivateStateRecovery({
    moduleId: "infinity-dnd5e",
    privateStateRetryMs: 5000,
    logger: { error: () => {} },
    safeInitializeSubsystem: (_label, callback) => callback(),
    getPrivateStateStatus: () => ({
      state: "ready",
      code: "ready",
      retryable: false,
    }),
    initializePrivateState: async () => true,
    isFullGM: () => true,
    isAuthoritativeGM: () => authoritative,
    migrateResourceConfig: async () => {
      resourceReady = true;
    },
    isResourceAutomationReady: () => resourceReady,
    registerMerchantSocket: service("merchant"),
    registerResourceOverviewService: service("overview"),
    registerResourceCalendarWatcher: service("calendar"),
    registerReputationSocket: service("reputation"),
    registerCriticalInjuryService: service("injury"),
    registerDowntimeService: service("downtime"),
    observeResourceAuthorityTransition: () => {
      const transition = { newlyAuthoritative };
      newlyAuthoritative = false;
      return transition;
    },
    onPrivateStateChanged: () => null,
    getHooks: () => ({
      on: (name, callback) => hooks.set(name, callback),
    }),
    setTimeout: () => 1,
    clearTimeout: () => {},
  });

  controller.registerHooks();
  controller.registerPrivateDependentServices();
  controller.markReadyComplete({ privateStateAvailable: true });
  assert.deepEqual(services, [
    "merchant",
    "overview",
    "reputation",
    "injury",
    "downtime",
  ]);

  authoritative = true;
  newlyAuthoritative = true;
  hooks.get("updateUser")();
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();

  assert.deepEqual(services, [
    "merchant",
    "overview",
    "reputation",
    "injury",
    "downtime",
    "calendar",
  ]);
  assert.equal(
    services.filter((name) => name === "calendar").length,
    1,
    "authority recovery spends the calendar ready-sync exactly once",
  );
}

// A player installs the calendar listener for forage/socket participation. If
// that same client is later promoted into the authoritative GM, recovery must
// explicitly reconcile the missed day because the listener is already
// registered and its original ready-sync ran without authority.
{
  let fullGM = false;
  let authoritative = false;
  let resourceReady = false;
  let newlyAuthoritative = false;
  const services = [];
  const reconciliations = [];
  const hooks = new Map();
  const service = (name) => () => services.push(name);
  const controller = createPrivateStateRecovery({
    moduleId: "infinity-dnd5e",
    privateStateRetryMs: 5000,
    logger: { error: () => {} },
    safeInitializeSubsystem: (_label, callback) => callback(),
    getPrivateStateStatus: () => ({
      state: "ready",
      code: "ready",
      retryable: false,
    }),
    initializePrivateState: async () => true,
    isFullGM: () => fullGM,
    isAuthoritativeGM: () => authoritative,
    migrateResourceConfig: async () => {
      resourceReady = true;
    },
    isResourceAutomationReady: () => resourceReady,
    registerMerchantSocket: service("merchant"),
    registerResourceOverviewService: service("overview"),
    registerResourceCalendarWatcher: service("calendar"),
    reconcileResourceCalendarWatcher: () =>
      reconciliations.push("authority-recovery"),
    registerReputationSocket: service("reputation"),
    registerCriticalInjuryService: service("injury"),
    registerDowntimeService: service("downtime"),
    observeResourceAuthorityTransition: () => {
      const transition = { newlyAuthoritative };
      newlyAuthoritative = false;
      return transition;
    },
    onPrivateStateChanged: () => null,
    getHooks: () => ({
      on: (name, callback) => hooks.set(name, callback),
    }),
    setTimeout: () => 1,
    clearTimeout: () => {},
  });

  controller.registerHooks();
  controller.registerPrivateDependentServices();
  controller.markReadyComplete({ privateStateAvailable: true });
  assert.equal(
    services.filter((name) => name === "calendar").length,
    1,
    "the player installs the calendar listener once",
  );

  fullGM = true;
  authoritative = true;
  newlyAuthoritative = true;
  hooks.get("updateUser")();
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();

  assert.equal(
    services.filter((name) => name === "calendar").length,
    1,
    "promotion does not duplicate calendar listeners",
  );
  assert.deepEqual(
    reconciliations,
    ["authority-recovery"],
    "promotion explicitly reconciles the missed calendar day",
  );
}

// Quartermaster migration failure delays only the one-time calendar watcher.
// Core private services stay available, and successful recovery starts the
// watcher exactly once so its ready catch-up can run.
{
  let resourceReady = false;
  let migrationFails = true;
  const services = [];
  const timers = new Map();
  let nextTimer = 0;
  const service = (name) => () => services.push(name);
  const controller = createPrivateStateRecovery({
    moduleId: "infinity-dnd5e",
    privateStateRetryMs: 5000,
    logger: { error: () => {} },
    safeInitializeSubsystem: (_label, callback) => callback(),
    getPrivateStateStatus: () => ({
      state: "ready",
      code: "ready",
      retryable: false,
    }),
    initializePrivateState: async () => true,
    isFullGM: () => true,
    isAuthoritativeGM: () => true,
    migrateResourceConfig: async () => {
      if (migrationFails) throw new Error("injected migration failure");
    },
    isResourceAutomationReady: () => resourceReady,
    registerMerchantSocket: service("merchant"),
    registerResourceOverviewService: service("overview"),
    registerResourceCalendarWatcher: service("calendar"),
    registerReputationSocket: service("reputation"),
    registerCriticalInjuryService: service("injury"),
    registerDowntimeService: service("downtime"),
    setTimeout: (callback, delay) => {
      const id = ++nextTimer;
      timers.set(id, { callback, delay });
      return id;
    },
    clearTimeout: (id) => timers.delete(id),
  });

  assert.equal(await controller.recover(), false);
  assert.deepEqual(services, [
    "merchant",
    "overview",
    "reputation",
    "injury",
    "downtime",
  ]);
  assert.equal(timers.size, 1);
  assert.equal(services.includes("calendar"), false);

  migrationFails = false;
  resourceReady = true;
  assert.equal(await controller.recover(), true);
  assert.equal(
    services.filter((name) => name === "calendar").length,
    1,
    "resource recovery starts the one-time catch-up watcher once",
  );
  assert.equal(services.filter((name) => name === "merchant").length, 1);
  assert.equal(timers.size, 0);
}

// Same-user follower tabs only hydrate read-only campaign state, then acquire
// authority through the shared campaign-leadership hook without duplicating
// the calendar listener. A later regain reconciles the already-installed
// watcher instead of registering it again.
{
  let leader = false;
  let resourceReady = false;
  let observeCalls = 0;
  let initializeCalls = 0;
  const trace = [];
  const services = [];
  const reconciliations = [];
  const resourceEvents = [];
  const hooks = new Map();
  const timers = new Map();
  let nextTimer = 0;
  const service = (name) => () => services.push(name);
  const controller = createPrivateStateRecovery({
    moduleId: "infinity-dnd5e",
    privateStateRetryMs: 5000,
    logger: { error: () => {} },
    safeInitializeSubsystem: (_label, callback) => callback(),
    getPrivateStateStatus: () => ({
      state: "ready",
      code: "ready",
      retryable: false,
    }),
    ensureCampaignTabLeadership: async () => {
      trace.push("ensure-leadership");
      return leader;
    },
    hasCampaignTabLeadership: () => leader,
    initializePrivateState: async () => {
      trace.push("initialize");
      initializeCalls += 1;
      return true;
    },
    isFullGM: () => true,
    isAuthoritativeGM: () => leader,
    migrateResourceConfig: async () => {
      trace.push("migrate");
      resourceReady = true;
    },
    isResourceAutomationReady: () => resourceReady,
    registerMerchantSocket: service("merchant"),
    registerResourceOverviewService: service("overview"),
    registerResourceCalendarWatcher: service("calendar"),
    reconcileResourceCalendarWatcher: (reason) => reconciliations.push(reason),
    resourceStateUpdateEvent: "resource:state-update",
    emitResourceEvent: (type, data) => resourceEvents.push({ type, data }),
    registerReputationSocket: service("reputation"),
    registerCriticalInjuryService: service("injury"),
    registerDowntimeService: service("downtime"),
    observeResourceAuthorityTransition: () => {
      observeCalls += 1;
      return {
        changed: true,
        newlyAuthoritative: leader,
      };
    },
    onPrivateStateChanged: () => null,
    campaignTabLeadershipHook: "infinity-dnd5e.campaignTabLeadership",
    getHooks: () => ({
      on: (name, callback) => hooks.set(name, callback),
    }),
    setTimeout: (callback, delay) => {
      const id = ++nextTimer;
      timers.set(id, { callback, delay });
      return id;
    },
    clearTimeout: (id) => timers.delete(id),
  });

  controller.registerHooks();
  assert.equal(await controller.recover(), false);
  assert.equal(
    initializeCalls,
    1,
    "follower recovery performs one read-only private-state hydration",
  );
  assert.equal(trace.includes("migrate"), false);
  trace.length = 0;
  controller.markReadyComplete({ privateStateAvailable: true });
  assert.deepEqual(services, []);

  leader = true;
  hooks.get("infinity-dnd5e.campaignTabLeadership")({ leader: true });
  await new Promise((resolve) => setImmediate(resolve));
  assert.ok(trace.indexOf("ensure-leadership") < trace.indexOf("initialize"));
  assert.ok(trace.indexOf("initialize") < trace.indexOf("migrate"));
  assert.equal(initializeCalls, 2);
  assert.equal(
    services.filter((name) => name === "calendar").length,
    1,
    "first leadership gain registers the calendar watcher once",
  );
  assert.deepEqual(reconciliations, []);
  assert.deepEqual(resourceEvents, [
    {
      type: "resource:state-update",
      data: { reason: "authority-recovery" },
    },
  ]);

  assert.equal(controller.schedule({ resource: true }), true);
  leader = false;
  const observationsBeforeLoss = observeCalls;
  hooks.get("infinity-dnd5e.campaignTabLeadership")({ leader: false });
  assert.equal(observeCalls, observationsBeforeLoss + 1);
  assert.equal(timers.size, 0, "leadership loss clears Resource retries");
  assert.equal(initializeCalls, 2, "leadership loss starts no new writes");

  leader = true;
  hooks.get("infinity-dnd5e.campaignTabLeadership")({ leader: true });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(
    services.filter((name) => name === "calendar").length,
    1,
    "leadership regain does not duplicate calendar registration",
  );
  assert.deepEqual(reconciliations, ["authority-recovery"]);
  assert.equal(resourceEvents.length, 2);
}

// A leadership loss and regain while hydration is blocked must queue a fresh
// generation. Coalescing the gain into the stale promise would otherwise miss
// migration and calendar registration after the old generation exits.
{
  let leader = true;
  let leadershipGeneration = 1;
  let initializeCalls = 0;
  let migrationCalls = 0;
  const firstInitialization = deferred();
  const hooks = new Map();
  const services = [];
  const controller = createPrivateStateRecovery({
    moduleId: "infinity-dnd5e",
    privateStateRetryMs: 5000,
    logger: { error: () => {} },
    safeInitializeSubsystem: (_label, callback) => callback(),
    getPrivateStateStatus: () => ({
      state: "ready",
      code: "ready",
      retryable: false,
    }),
    ensureCampaignTabLeadership: async () => leader,
    hasCampaignTabLeadership: () => leader,
    getCampaignTabLeadershipStatus: () => ({
      generation: leadershipGeneration,
    }),
    initializePrivateState: async () => {
      initializeCalls += 1;
      return initializeCalls === 1 ? firstInitialization.promise : true;
    },
    isFullGM: () => true,
    isAuthoritativeGM: () => leader,
    migrateResourceConfig: async () => {
      migrationCalls += 1;
    },
    isResourceAutomationReady: () => true,
    registerMerchantSocket: () => services.push("merchant"),
    registerResourceOverviewService: () => services.push("overview"),
    registerResourceCalendarWatcher: () => services.push("calendar"),
    registerReputationSocket: () => services.push("reputation"),
    registerCriticalInjuryService: () => services.push("injury"),
    registerDowntimeService: () => services.push("downtime"),
    observeResourceAuthorityTransition: () => ({
      changed: true,
      newlyAuthoritative: leader,
    }),
    onPrivateStateChanged: () => null,
    campaignTabLeadershipHook: "infinity-dnd5e.campaignTabLeadership",
    getHooks: () => ({
      on: (name, callback) => hooks.set(name, callback),
    }),
    setTimeout: () => 1,
    clearTimeout: () => {},
  });

  controller.registerHooks();
  controller.markReadyComplete({ privateStateAvailable: true });
  const staleRecovery = controller.recover();
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(initializeCalls, 1);

  leader = false;
  hooks.get("infinity-dnd5e.campaignTabLeadership")({ leader: false });
  leader = true;
  leadershipGeneration = 2;
  hooks.get("infinity-dnd5e.campaignTabLeadership")({ leader: true });
  firstInitialization.resolve(true);

  assert.equal(await staleRecovery, false);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(initializeCalls, 2);
  assert.equal(migrationCalls, 1);
  assert.equal(
    services.filter((name) => name === "calendar").length,
    1,
    "the regained generation performs one fresh calendar registration",
  );
}

process.stdout.write("module recovery validation passed\n");
