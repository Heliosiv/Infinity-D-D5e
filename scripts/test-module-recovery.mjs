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

process.stdout.write("module recovery validation passed\n");
