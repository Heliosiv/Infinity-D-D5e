import assert from "node:assert/strict";

import { createModuleBootstrap } from "./bootstrap/lifecycle.js";

function createHooks(trace) {
  const onceCallbacks = new Map();
  const onCallbacks = new Map();
  return {
    onceCallbacks,
    onCallbacks,
    once(name, callback) {
      trace.push(`hook-once:${name}`);
      onceCallbacks.set(name, callback);
    },
    on(name, callback) {
      trace.push(`hook-on:${name}`);
      const callbacks = onCallbacks.get(name) ?? [];
      callbacks.push(callback);
      onCallbacks.set(name, callbacks);
      return `${name}-${callbacks.length}`;
    },
  };
}

function createFixture({
  privateAvailable = true,
  fullGm = true,
  privateStatus = null,
  resourceReady = true,
  resourceMigrationError = null,
  campaignLeader = true,
} = {}) {
  const trace = [];
  const hooks = createHooks(trace);
  const moduleRecord = { version: "0.3.2", api: { stale: true } };
  const notifications = [];
  const timers = [];
  let privateStateCallback = null;
  let sharpeningOptions = null;
  let downtimeAutoOpen = null;
  const game = {
    modules: new Map([["infinity-dnd5e", moduleRecord]]),
    release: { version: "13.351" },
    system: { id: "dnd5e", version: "4.4.4" },
    settings: {
      register: (_moduleId, key) => trace.push(`setting:${key}`),
      registerMenu: (_moduleId, key) => trace.push(`menu:${key}`),
    },
    keybindings: {
      register: (_moduleId, key) => trace.push(`key:${key}`),
    },
  };
  const record = (name) => () => trace.push(name);
  const app = (name) => ({
    open: record(`${name}:open`),
    configure: record(`${name}:configure`),
  });

  const bindings = {
    moduleId: "infinity-dnd5e",
    packId: "infinity-dnd5e.infinity-dnd5e-items",
    privateStateRetryMs: 5000,
    logger: { log: () => {}, warn: () => {}, error: () => {} },
    getGame: () => game,
    getHooks: () => hooks,
    getUi: () => ({
      notifications: { error: (message) => notifications.push(message) },
    }),
    getDocument: () => ({ querySelectorAll: () => [] }),
    getConfig: () => {
      trace.push("reagent");
      return { DND5E: { consumableTypes: {}, lootTypes: {} } };
    },
    getConst: () => ({ KEYBINDING_PRECEDENCE: { NORMAL: 0 } }),
    getFoundry: () => ({ utils: { foundryVersion: { generation: 13 } } }),
    setTimeout: (callback, delay) => {
      timers.push({ callback, delay });
      trace.push("recovery-timer");
      return timers.length;
    },
    clearTimeout: record("clear-recovery-timer"),

    openHub: record("home"),
    LootStudioApp: app("loot"),
    InfinitySettingsApp: class InfinitySettingsApp {},
    MerchantWorkspaceApp: app("merchant-workspace"),
    MerchantSessionApp: class MerchantSessionApp {},
    ShopPickerApp: app("shops"),
    ResourceManagerApp: app("quartermaster"),
    ResourceOverviewApp: app("supplies"),
    ForagePromptApp: class ForagePromptApp {},
    CriticalInjuryApp: {
      openForCurrentUser: record("injuries:open"),
    },
    CriticalInjuryHudApp: { reconcile: record("injury-hud:reconcile") },
    ReputationWorkspaceApp: app("reputation-workspace"),
    ReputationViewApp: app("reputation-view"),
    DowntimeWorkspaceApp: {
      open: record("downtime-workspace:open"),
      configure: record("downtime-workspace:configure"),
    },
    DowntimeActivitiesApp: {
      open: record("downtime-activities:open"),
      configure: record("downtime-activities:configure"),
    },
    CRITICAL_INJURY_TABLE: [],
    CRITICAL_INJURY_TABLE_VERSION: 2,
    SOUND_EVENTS: {},
    SOUND_REGISTRY: {},
    SETTINGS: [{ key: "one", name: "One", scope: "world", type: Boolean }],
    registerUiPreferencesSetting: () => trace.push("ui-preferences"),
    applyUiDensity: record("density"),
    registerTool: ({ id }) => trace.push(`tool:${id}`),
    isFullGM: () => fullGm,
    runAsFullGM: (callback) => callback(),
    getPlayerSurfaceStatus: () => ({}),
    playSoundEvent: record("play-sound"),
    getUiPreferences: () => ({}),
    updateUiPreferences: record("update-ui-preferences"),
    openCalendar: record("calendar"),
    advanceDayNow: record("advance-day"),
    computeLootBudget: () => 0,
    loadCompendiumItems: async () => [],
    filterCandidates: () => [],
    getLootBundleBalanceOptions: () => ({}),
    rollLoot: () => ({ items: [] }),
    getEffectiveRarity: () => null,
    tierWindow: () => [],
    distributeItemsToActor: record("distribute"),
    promptDistributeItems: record("prompt-distribute"),

    registerMonksActiveTilesCompat: record("matt"),
    registerPlayerSurfaceSocket: record("player-surface-socket"),
    registerUiFoundationHooks: record("ui-foundation"),
    registerInfinityItemUuidRedirects: record("uuid-redirects"),
    getDowntimePlayerAdapter: () => ({}),
    downtimeWorkspaceAdapter: {},
    initializePrivateState: async () => {
      trace.push("private-state:init");
      return privateAvailable;
    },
    getPrivateStateStatus: () =>
      privateStatus ?? {
        state: privateAvailable ? "ready" : "pending",
        code: privateAvailable ? "ready" : "store-unavailable",
        retryable: !privateAvailable,
        supportedSchema: 7,
        observedSchema: privateAvailable ? 7 : null,
      },
    onPrivateStateChanged: (callback) => {
      trace.push("private-state:hook");
      privateStateCallback = callback;
    },
    campaignTabLeadershipHook: "infinity-dnd5e.campaignTabLeadership",
    ensureCampaignTabLeadership: async () => {
      trace.push("campaign-leadership:ensure");
      return campaignLeader;
    },
    hasCampaignTabLeadership: () => campaignLeader,
    observeResourceAuthorityTransition: () => {
      trace.push("authority:observe");
      return { newlyAuthoritative: false };
    },
    isAuthoritativeGM: () => fullGm && campaignLeader,
    isResourceAutomationReady: () => resourceReady,
    migrateEncounterBalanceDefaults: async () =>
      trace.push("migrate:encounter"),
    migrateResourceConfig: async () => {
      trace.push("migrate:resource");
      if (resourceMigrationError) throw resourceMigrationError;
    },
    registerSoundSocket: record("sound-socket"),
    registerSpellComponentHooks: record("spell-components"),
    registerSoundAutomation: record("sound-automation"),
    registerDowntimeSocket: record("downtime-socket"),
    configureDowntimePlayerAutoOpen: (callback) => {
      trace.push("downtime-auto-open");
      downtimeAutoOpen = callback;
    },
    registerSharpeningHooks: (options) => {
      trace.push("sharpening-hooks");
      sharpeningOptions = options;
    },
    notifySharpenDamage: record("sharpen-damage"),
    notifyLongRest: record("long-rest"),
    registerMerchantSocket: record("merchant-socket"),
    registerResourceOverviewService: record("resource-overview-service"),
    registerResourceCalendarWatcher: record("resource-calendar-watcher"),
    registerReputationSocket: record("reputation-socket"),
    registerCriticalInjuryService: record("injury-service"),
    registerDowntimeService: record("downtime-service"),
    registerMerchantSessionAutoOpen: record("merchant-auto-open"),
    registerResourceSocket: record("resource-socket"),
    registerCriticalInjurySocket: record("injury-socket"),
    registerCriticalInjuryApp: record("injury-app"),
    registerCriticalInjuryHud: record("injury-hud"),
    registerForagePromptAutoOpen: record("forage-auto-open"),
    registerMonksTokenbarCompat: () => {
      trace.push("tokenbar");
      return Promise.resolve();
    },
    preloadModuleSounds: record("preload-sounds"),
  };

  return {
    bindings,
    trace,
    hooks,
    moduleRecord,
    notifications,
    timers,
    getPrivateStateCallback: () => privateStateCallback,
    getSharpeningOptions: () => sharpeningOptions,
    getDowntimeAutoOpen: () => downtimeAutoOpen,
  };
}

{
  const fixture = createFixture();
  const bootstrap = createModuleBootstrap(fixture.bindings);
  assert.equal(bootstrap.register(), true);
  assert.equal(bootstrap.register(), false);
  assert.deepEqual(fixture.trace, [
    "matt",
    "hook-once:socketlib.ready",
    "hook-once:init",
    "hook-once:ready",
    "hook-on:getSceneControlButtons",
  ]);
  assert.equal(fixture.moduleRecord.api.stale, undefined);
  const eagerApi = fixture.moduleRecord.api;

  fixture.trace.length = 0;
  fixture.hooks.onceCallbacks.get("socketlib.ready")();
  assert.deepEqual(fixture.trace, ["player-surface-socket"]);

  fixture.trace.length = 0;
  delete fixture.moduleRecord.api;
  fixture.hooks.onceCallbacks.get("init")();
  assert.ok(fixture.moduleRecord.api, "init restores a missing public API");
  assert.notEqual(fixture.moduleRecord.api, eagerApi);
  assert.deepEqual(fixture.trace, [
    "reagent",
    "setting:one",
    "ui-preferences",
    "menu:infinitySettings",
    "ui-foundation",
    "uuid-redirects",
    "key:openDashboard",
    "key:openShops",
    "key:openReputation",
    "key:openPartySupplies",
    "key:openCriticalInjuries",
    "key:openDowntimeActivities",
    "tool:loot-studio",
    "tool:merchant-workspace",
    "tool:resource-manager",
    "tool:downtime-workspace",
    "tool:reputation",
    "downtime-workspace:configure",
    "downtime-activities:configure",
  ]);
  assert.ok(
    fixture.trace.indexOf("uuid-redirects") <
      fixture.trace.indexOf("key:openDashboard"),
    "legacy UUID redirects are registered during init before later launchers",
  );

  fixture.trace.length = 0;
  delete fixture.moduleRecord.api;
  await fixture.hooks.onceCallbacks.get("ready")();
  assert.ok(fixture.moduleRecord.api, "ready restores a missing public API");
  assert.deepEqual(fixture.trace, [
    "authority:observe",
    "private-state:hook",
    "hook-on:updateUser",
    "hook-on:userConnected",
    "hook-on:infinity-dnd5e.campaignTabLeadership",
    "campaign-leadership:ensure",
    "private-state:init",
    "migrate:encounter",
    "migrate:resource",
    "sound-socket",
    "spell-components",
    "sound-automation",
    "player-surface-socket",
    "downtime-socket",
    "downtime-auto-open",
    "sharpening-hooks",
    "merchant-socket",
    "resource-overview-service",
    "resource-calendar-watcher",
    "reputation-socket",
    "injury-service",
    "downtime-service",
    "merchant-auto-open",
    "resource-socket",
    "injury-socket",
    "injury-app",
    "injury-hud",
    "forage-auto-open",
    "tokenbar",
    "preload-sounds",
  ]);
  assert.equal(typeof fixture.getPrivateStateCallback(), "function");
  assert.equal(typeof fixture.getSharpeningOptions().onDamage, "function");
  assert.equal(typeof fixture.getSharpeningOptions().onLongRest, "function");
  assert.equal(typeof fixture.getDowntimeAutoOpen(), "function");
}

{
  const fixture = createFixture({
    campaignLeader: false,
    privateAvailable: false,
  });
  createModuleBootstrap(fixture.bindings).register();
  fixture.trace.length = 0;
  await fixture.hooks.onceCallbacks.get("ready")();
  assert.ok(fixture.trace.includes("campaign-leadership:ensure"));
  assert.ok(
    fixture.trace.includes("private-state:init"),
    "a follower tab still attempts the private store's read-only hydration",
  );
  assert.equal(
    fixture.trace.includes("migrate:resource"),
    false,
    "a follower tab does not migrate Resource state",
  );
  assert.equal(
    fixture.trace.includes("resource-calendar-watcher"),
    false,
    "a follower tab does not install calendar authority",
  );
  assert.ok(
    fixture.trace.includes("resource-socket") &&
      fixture.trace.includes("forage-auto-open"),
    "a follower tab keeps safe player-facing Resource listeners",
  );
  assert.equal(fixture.timers.length, 0);
  assert.equal(fixture.notifications.length, 0);
}

{
  const fixture = createFixture({ campaignLeader: false });
  createModuleBootstrap(fixture.bindings).register();
  fixture.trace.length = 0;
  await fixture.hooks.onceCallbacks.get("ready")();
  assert.ok(fixture.trace.includes("private-state:init"));
  assert.equal(
    fixture.trace.includes("merchant-socket") ||
      fixture.trace.includes("resource-overview-service"),
    false,
    "a hydrated follower does not start private write services",
  );
  assert.equal(fixture.trace.includes("resource-calendar-watcher"), false);
  assert.ok(fixture.trace.includes("resource-socket"));
  assert.ok(fixture.trace.includes("forage-auto-open"));
}

{
  const fixture = createFixture({ fullGm: false, campaignLeader: false });
  createModuleBootstrap(fixture.bindings).register();
  fixture.trace.length = 0;
  await fixture.hooks.onceCallbacks.get("ready")();
  assert.equal(
    fixture.trace.includes("campaign-leadership:ensure"),
    false,
    "players do not wait for GM tab leadership",
  );
  assert.ok(fixture.trace.includes("resource-calendar-watcher"));
  assert.ok(fixture.trace.includes("resource-socket"));
  assert.ok(fixture.trace.includes("forage-auto-open"));
}

{
  const fixture = createFixture();
  fixture.bindings.registerSoundSocket = () => {
    fixture.trace.push("sound-socket:failed");
    throw new Error("sound unavailable");
  };
  createModuleBootstrap(fixture.bindings).register();
  fixture.trace.length = 0;
  await fixture.hooks.onceCallbacks.get("ready")();
  assert.ok(fixture.trace.includes("sound-socket:failed"));
  assert.ok(
    fixture.trace.indexOf("spell-components") >
      fixture.trace.indexOf("sound-socket:failed"),
    "a failed ready subsystem does not suppress later registrations",
  );
}

{
  const fixture = createFixture({
    resourceReady: false,
    resourceMigrationError: new Error(
      "injected Quartermaster migration failure",
    ),
  });
  createModuleBootstrap(fixture.bindings).register();
  fixture.trace.length = 0;
  await fixture.hooks.onceCallbacks.get("ready")();
  assert.ok(fixture.trace.includes("merchant-socket"));
  assert.ok(fixture.trace.includes("resource-overview-service"));
  assert.ok(fixture.trace.includes("reputation-socket"));
  assert.ok(fixture.trace.includes("injury-service"));
  assert.ok(fixture.trace.includes("downtime-service"));
  assert.equal(
    fixture.trace.includes("resource-calendar-watcher"),
    false,
    "a failed Quartermaster migration delays its one-time ready catch-up",
  );
  assert.equal(fixture.timers.length, 1);
  assert.match(
    fixture.notifications[0],
    /Quartermaster setup is still loading/,
  );
}

{
  const incompatible = Object.assign(new Error("future resource config"), {
    code: "RESOURCE_CONFIG_FUTURE_VERSION",
    retryable: false,
    persistedVersionStatus: {
      state: "blocked",
      code: "future-version",
      retryable: false,
    },
  });
  const fixture = createFixture({
    resourceReady: false,
    resourceMigrationError: incompatible,
  });
  createModuleBootstrap(fixture.bindings).register();
  fixture.trace.length = 0;
  await fixture.hooks.onceCallbacks.get("ready")();
  assert.ok(fixture.trace.includes("merchant-socket"));
  assert.equal(fixture.trace.includes("resource-calendar-watcher"), false);
  assert.equal(fixture.timers.length, 0);
  assert.match(fixture.notifications[0], /written by a newer or incompatible/);
}

{
  const fixture = createFixture({ privateAvailable: false, fullGm: true });
  createModuleBootstrap(fixture.bindings).register();
  fixture.trace.length = 0;
  await fixture.hooks.onceCallbacks.get("ready")();
  assert.equal(fixture.trace.includes("merchant-socket"), false);
  assert.equal(fixture.trace.includes("resource-overview-service"), false);
  assert.equal(fixture.trace.includes("migrate:resource"), false);
  assert.ok(fixture.trace.includes("resource-socket"));
  assert.ok(fixture.trace.includes("recovery-timer"));
  assert.equal(fixture.timers.length, 1);
  assert.match(fixture.notifications[0], /retry automatically/);
}

{
  const fixture = createFixture({
    privateAvailable: false,
    fullGm: true,
    privateStatus: {
      state: "blocked",
      code: "future-schema",
      retryable: false,
      supportedSchema: 7,
      observedSchema: 8,
    },
  });
  createModuleBootstrap(fixture.bindings).register();
  fixture.trace.length = 0;
  await fixture.hooks.onceCallbacks.get("ready")();
  assert.equal(fixture.trace.includes("merchant-socket"), false);
  assert.equal(fixture.trace.includes("resource-overview-service"), false);
  assert.equal(fixture.trace.includes("reputation-socket"), false);
  assert.equal(fixture.trace.includes("migrate:resource"), false);
  assert.ok(fixture.trace.includes("downtime-socket"));
  assert.ok(fixture.trace.includes("resource-socket"));
  assert.ok(fixture.trace.includes("injury-socket"));
  assert.equal(fixture.trace.includes("recovery-timer"), false);
  assert.equal(fixture.timers.length, 0);
  assert.match(fixture.notifications[0], /schema \(8\)/);
  assert.match(fixture.notifications[0], /automatic retries are stopped/);
  assert.match(fixture.notifications[0], /Home > Campaign data/);
}

{
  const fixture = createFixture({
    privateAvailable: false,
    fullGm: true,
    privateStatus: {
      state: "blocked",
      code: "missing-store",
      retryable: false,
      supportedSchema: 7,
      observedSchema: null,
    },
  });
  createModuleBootstrap(fixture.bindings).register();
  fixture.trace.length = 0;
  await fixture.hooks.onceCallbacks.get("ready")();
  assert.equal(fixture.trace.includes("recovery-timer"), false);
  assert.equal(fixture.timers.length, 0);
  assert.match(fixture.notifications[0], /automatic replacement is disabled/);
  assert.match(fixture.notifications[0], /Home > Campaign data/);
}

process.stdout.write("module lifecycle validation passed\n");
