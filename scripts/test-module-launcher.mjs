import assert from "node:assert/strict";

import { createModuleApi, installModuleApi } from "./bootstrap/api.js";
import { createModuleRegistrars } from "./bootstrap/registrars.js";
import { applyInfinitySceneControls } from "./bootstrap/scene-controls.js";

function appStub(name, calls, method = "open") {
  return {
    [method]: (...args) => {
      calls.push([name, ...args]);
      return name;
    },
  };
}

function apiFixture() {
  const calls = [];
  let fullGm = true;
  const moduleRecord = { api: { stale: true } };
  const bindings = {
    moduleId: "infinity-dnd5e",
    packId: "infinity-dnd5e.infinity-dnd5e-items",
    getGame: () => ({ modules: new Map([["infinity-dnd5e", moduleRecord]]) }),
    openHub: () => calls.push(["home"]),
    LootStudioApp: appStub("loot", calls),
    InfinitySettingsApp: appStub("settings", calls),
    MerchantWorkspaceApp: appStub("merchants", calls),
    MerchantSessionApp: class MerchantSessionApp {},
    ShopPickerApp: appStub("shops", calls),
    ResourceManagerApp: appStub("quartermaster", calls),
    ResourceOverviewApp: appStub("supplies", calls),
    ForagePromptApp: class ForagePromptApp {},
    CriticalInjuryApp: appStub("injuries", calls, "openForCurrentUser"),
    CriticalInjuryHudApp: appStub("injury-hud", calls, "reconcile"),
    CriticalInjuryTriageApp: appStub("injury-triage", calls),
    ReputationWorkspaceApp: appStub("factions", calls),
    ReputationViewApp: appStub("faction-view", calls),
    DowntimeWorkspaceApp: appStub("downtime-gm", calls),
    DowntimeActivitiesApp: appStub("downtime-player", calls),
    CRITICAL_INJURY_TABLE: Object.freeze([{ min: 1, max: 100 }]),
    CRITICAL_INJURY_TABLE_VERSION: 2,
    SOUND_EVENTS: Object.freeze({ CLICK: "click" }),
    SOUND_REGISTRY: Object.freeze({ click: "sound.ogg" }),
    playSoundEvent: (event, options) => calls.push(["sound", event, options]),
    getPlayerSurfaceStatus: () => ({ ready: true }),
    getPrivateStateStatus: () =>
      Object.freeze({ state: "ready", code: "ready", retryable: false }),
    openCalendar: () => calls.push(["calendar"]),
    getUiPreferences: () => ({ density: "comfortable" }),
    updateUiPreferences: (patch) => calls.push(["preferences", patch]),
    advanceDayNow: () => calls.push(["advance-day"]),
    computeLootBudget: (options) => {
      calls.push(["budget", options]);
      return 50;
    },
    loadCompendiumItems: async (options) => {
      calls.push(["pack", options]);
      return [{ id: "item-1" }];
    },
    filterCandidates: (items, options) => {
      calls.push(["filter", items, options]);
      return items;
    },
    getLootBundleBalanceOptions: (options) => {
      calls.push(["balance", options]);
      return { rarityWeights: { common: 1 } };
    },
    rollLoot: (_items, options) => {
      calls.push(["roll", options]);
      return { items: [{ item: { uuid: "Item.one" }, qty: 1 }] };
    },
    getEffectiveRarity: () => "common",
    tierWindow: (tier) => [tier],
    distributeItemsToActor: (actorId, uuids) =>
      calls.push(["distribute", actorId, uuids]),
    promptDistributeItems: (uuids, options) =>
      calls.push(["prompt-distribute", uuids, options]),
    isFullGM: () => fullGm,
    runAsFullGM: (callback) => {
      calls.push(["gm-gate"]);
      return callback();
    },
  };
  return {
    bindings,
    calls,
    moduleRecord,
    setFullGm: (value) => (fullGm = value),
  };
}

{
  const fixture = apiFixture();
  const api = createModuleApi(fixture.bindings);
  assert.deepEqual(Object.keys(api), [
    "openHub",
    "openDashboard",
    "openLootStudio",
    "openPerEncounterLoot",
    "openHoardLoot",
    "openPerCreatureLoot",
    "openMerchantWorkspace",
    "openShops",
    "openResourceManager",
    "openPartySupplies",
    "openCriticalInjuries",
    "openCriticalInjuryHud",
    "openCriticalInjuryTriage",
    "openReputation",
    "openReputationView",
    "openDowntimeWorkspace",
    "openDowntimeActivities",
    "openCalendar",
    "openSettings",
    "getUiPreferences",
    "updateUiPreferences",
    "getPlayerSurfaceStatus",
    "getPrivateStateStatus",
    "advanceDay",
    "MerchantSessionApp",
    "ForagePromptApp",
    "CriticalInjuryApp",
    "CriticalInjuryHudApp",
    "CriticalInjuryTriageApp",
    "criticalInjuries",
    "SOUND_EVENTS",
    "SOUND_REGISTRY",
    "playSoundEvent",
    "rollLootBundle",
    "distributeBundle",
    "promptDistribute",
  ]);
  assert.equal(
    Object.keys(api).some((key) =>
      /^(?:create|lock|plan|apply|cancel|recover)Downtime/i.test(key),
    ),
    false,
    "the public API exposes downtime launchers, not mutation methods",
  );
  assert.deepEqual(api.getPrivateStateStatus(), {
    state: "ready",
    code: "ready",
    retryable: false,
  });

  api.openHub();
  api.openDashboard();
  api.openLootStudio({ mode: "hoard" });
  api.openPerEncounterLoot();
  api.openHoardLoot();
  api.openPerCreatureLoot();
  api.openDowntimeWorkspace();
  api.openDowntimeActivities({ actorId: "actor-1" });
  assert.deepEqual(
    fixture.calls.filter(([name]) => name === "loot"),
    [
      ["loot", { mode: "hoard" }],
      ["loot", { mode: "encounter" }],
      ["loot", { mode: "hoard" }],
      ["loot", { mode: "creature" }],
    ],
  );
  assert.deepEqual(fixture.calls.at(-1), [
    "downtime-player",
    { actorId: "actor-1" },
  ]);

  fixture.setFullGm(false);
  api.playSoundEvent("click", { audience: "all" });
  assert.deepEqual(fixture.calls.at(-1), [
    "sound",
    "click",
    { audience: "local" },
  ]);
  await assert.rejects(() => api.rollLootBundle(), /PermissionDenied/);
  fixture.setFullGm(true);
  const bundle = await api.rollLootBundle({ tier: "t3" });
  assert.deepEqual(bundle.items, [
    {
      item: { uuid: "Item.one" },
      qty: 1,
      uuid: "Item.one",
      rarity: "common",
    },
  ]);

  const staleApi = fixture.moduleRecord.api;
  assert.equal(installModuleApi(fixture.bindings, { replace: true }), true);
  const eagerApi = fixture.moduleRecord.api;
  assert.notEqual(eagerApi, staleApi);
  assert.equal(installModuleApi(fixture.bindings), false);
  assert.equal(fixture.moduleRecord.api, eagerApi);
}

{
  const calls = [];
  let fullGm = false;
  const keybindings = [];
  const tools = [];
  const bindings = {
    moduleId: "infinity-dnd5e",
    logger: { warn: () => {} },
    getGame: () => ({
      keybindings: {
        register: (_moduleId, id, options) => keybindings.push({ id, options }),
      },
    }),
    getConst: () => ({ KEYBINDING_PRECEDENCE: { NORMAL: 0 } }),
    openHub: () => calls.push("home"),
    isFullGM: () => fullGm,
    ShopPickerApp: appStub("shops", calls),
    ReputationViewApp: appStub("factions", calls),
    ResourceOverviewApp: appStub("supplies", calls),
    CriticalInjuryApp: appStub("injuries", calls, "openForCurrentUser"),
    CriticalInjuryTriageApp: appStub("injury-triage", calls),
    DowntimeActivitiesApp: appStub("downtime", calls),
    registerTool: (tool) => tools.push(tool),
    LootStudioApp: appStub("loot", calls),
    MerchantWorkspaceApp: appStub("merchants", calls),
    ResourceManagerApp: appStub("quartermaster", calls),
    DowntimeWorkspaceApp: appStub("downtime-gm", calls),
    ReputationWorkspaceApp: appStub("reputation-gm", calls),
  };
  const registrars = createModuleRegistrars(bindings);
  assert.equal(registrars.registerKeybindings(), true);
  assert.equal(registrars.registerKeybindings(), false);
  assert.deepEqual(
    keybindings.map(({ id }) => id),
    [
      "openDashboard",
      "openShops",
      "openReputation",
      "openPartySupplies",
      "openCriticalInjuries",
      "openDowntimeActivities",
    ],
  );
  assert.deepEqual(
    keybindings.map(({ options }) => options.editable?.[0]),
    [
      { key: "KeyI", modifiers: ["Shift"] },
      { key: "KeyO", modifiers: ["Shift"] },
      { key: "KeyR", modifiers: ["Shift"] },
      { key: "KeyQ", modifiers: ["Shift"] },
      { key: "KeyJ", modifiers: ["Shift"] },
      { key: "KeyD", modifiers: ["Shift"] },
    ],
  );
  assert.equal(keybindings[0].options.restricted, false);
  assert.equal(keybindings[0].options.onDown(), true);
  assert.equal(keybindings[1].options.onDown(), true);
  fullGm = true;
  assert.equal(keybindings[1].options.onDown(), false);

  assert.equal(registrars.registerBuiltinTools(), true);
  assert.equal(registrars.registerBuiltinTools(), false);
  assert.deepEqual(
    tools.map(({ id }) => id),
    [
      "loot-studio",
      "merchant-workspace",
      "resource-manager",
      "downtime-workspace",
      "reputation",
      "critical-injury-triage",
    ],
  );
  tools.forEach((tool) => tool.open());
  assert.ok(calls.some((entry) => entry?.[0] === "quartermaster"));
}

{
  const opened = [];
  const bindings = {
    moduleId: "infinity-dnd5e",
    logger: { log: () => {}, warn: () => {}, error: () => {} },
    openHub: () => opened.push("home"),
  };

  const v12 = [];
  assert.equal(applyInfinitySceneControls(v12, bindings), true);
  assert.equal(applyInfinitySceneControls(v12, bindings), true);
  assert.equal(v12.length, 1, "the V12 category is not duplicated");
  assert.equal("onClick" in v12[0], false);
  assert.equal("onClick" in v12[0].tools[0], false);
  v12[0].onChange(null, false);
  v12[0].onChange(null, true);
  v12[0].tools[0].onChange();
  assert.deepEqual(opened, ["home", "home"]);

  const v13 = {};
  assert.equal(applyInfinitySceneControls(v13, bindings), true);
  const category = v13["infinity-dnd5e"];
  assert.equal(category.activeTool, "infinity-dnd5e-launcher");
  assert.deepEqual(Object.keys(category.tools), ["infinity-dnd5e-launcher"]);
  assert.equal("onClick" in category, false);
  assert.equal("onClick" in category.tools[category.activeTool], false);
  assert.equal(applyInfinitySceneControls(null, bindings), false);
}

process.stdout.write("module launcher validation passed\n");
