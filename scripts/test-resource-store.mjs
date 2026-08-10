import assert from "node:assert/strict";

import {
  RESOURCE_CONFIG_VERSION,
  RESOURCE_RUN_STATE_VERSION,
  DRAW_FROM_SELF,
  normalizeResource,
  normalizeResourceConfig,
  normalizeRoster,
  normalizeRosterEntry,
  resolveDrawSourceId,
  normalizeRunState,
  assertUpkeepClaimCurrent,
  claimUpkeepRun,
  clearUpkeepClaim,
  completeUpkeepRun,
  createResourceOperationStoreV5Adapter,
  observeResourceAuthorityTransition,
  createDefaultResourceConfig,
  isCanonicalPerCharacterResource,
  isResourceAutomationReady,
  loadResourceConfig,
  loadRunState,
  migrateResourceConfig,
  saveResourceConfig,
  saveRunState,
  serializeResourceConfig,
  setCurrentEnvironment,
  setLastSeenDay,
  setLastUpkeepResult,
  setResourceRule,
  resetResourceRules,
  resetResourceStoreForTests,
} from "./resource/store.js";
import {
  buildForageRunReceipt,
  buildUpkeepRunReceipt,
} from "./resource/history.js";
import {
  initializePrivateState,
  resetPrivateStateForTests,
  setPrivateState,
} from "./private-state.js";
import {
  createEmptyResourceRunStateV5,
  normalizeResourceRunStateV5,
} from "./resource/run-state-v5.js";
import {
  createResourceInventoryOperation,
  createResourceOperationContext,
  createResourceTerminalDeliveries,
  markResourceDeliveryDelivered,
  transitionResourceOperation,
} from "./resource/operation-ledger.js";

/* ------------------------------------------------------------------ *
 * normalizeResource — defaults + drop malformed
 * ------------------------------------------------------------------ */
{
  assert.equal(normalizeResource(null), null);
  assert.equal(normalizeResource({}), null, "no id → dropped");

  const r = normalizeResource({ id: "food", scope: "bogus", perDay: -3 });
  assert.equal(r.id, "food");
  assert.equal(r.scope, "per-character", "bad scope → per-character");
  assert.equal(r.perDay, 0, "negative perDay clamps to 0");
  assert.deepEqual(r.matching, {
    nameKeywords: [],
    excludeNameKeywords: [],
    flagTag: "food",
    itemUuids: [],
  });
  assert.equal(r.forageYields, null);
  assert.equal(
    normalizeResource({ id: "medicine", matching: { flagTag: "" } }).matching
      .flagTag,
    "medicine",
    "a blank tag falls back to the resource id for created-stack identity",
  );

  const party = normalizeResource({
    id: "light",
    scope: "party",
    perDay: 2,
    matching: {
      nameKeywords: ["torch"],
      flagTag: "light",
      itemUuids: ["x", "x"],
    },
  });
  assert.equal(party.scope, "party");
  assert.equal(party.forageYields, null);
  assert.deepEqual(party.matching.itemUuids, ["x"], "dedupes uuids");

  const canonicalFood = normalizeResource({
    id: "provisions",
    scope: "party",
    forageYields: "food",
  });
  assert.equal(
    canonicalFood.scope,
    "per-character",
    "food channels stay per-character for shortage attribution",
  );
  assert.equal(isCanonicalPerCharacterResource(canonicalFood), true);
}

/* ------------------------------------------------------------------ *
 * normalizeResourceConfig — fills defaults, idempotent
 * ------------------------------------------------------------------ */
{
  const cfg = normalizeResourceConfig({});
  assert.equal(cfg.version, RESOURCE_CONFIG_VERSION);
  assert.equal(
    normalizeResourceConfig({ version: RESOURCE_CONFIG_VERSION + 1 }).version,
    RESOURCE_CONFIG_VERSION,
    "the pure config normalizer remains permissive for legacy callers",
  );
  assert.equal(RESOURCE_CONFIG_VERSION, 5, "current structural schema is v5");
  assert.equal(cfg.forageMode, "each");
  assert.equal(cfg.halfRations, false);
  assert.equal(cfg.waterEnabled, true);
  assert.equal(cfg.maxCatchUpDays, 7);
  assert.ok(cfg.resources.length >= 3, "seeds food/water/light");
  assert.ok(cfg.environments.length >= 3, "seeds environments");
  assert.deepEqual(
    cfg.resources.find((resource) => resource.id === "food")?.matching
      ?.nameKeywords,
    [
      "rations",
      "trail ration",
      "iron ration",
      "emergency ration",
      "field ration",
      "food ration",
    ],
    "fresh food defaults cover day-unit ration names without a broad food keyword",
  );
  const defaultFood = cfg.resources.find((resource) => resource.id === "food");
  assert.deepEqual(defaultFood.matching.excludeNameKeywords, ["water ration"]);
  assert.deepEqual(defaultFood.matching.itemUuids, [
    "Compendium.dnd5e.items.Item.f4w4GxBi0nYXmhX4",
  ]);
  const defaultWater = cfg.resources.find(
    (resource) => resource.id === "water",
  );
  assert.deepEqual(
    defaultWater.matching.nameKeywords,
    ["water ration", "water (1 day)"],
    "a reusable Waterskin is not treated as disposable water",
  );

  const upgradedV2 = normalizeResourceConfig({
    version: 2,
    resources: [
      {
        id: "food",
        forageYields: "food",
        matching: {
          nameKeywords: ["ration", "rations", "trail ration", "food"],
          flagTag: "food",
          itemUuids: [],
        },
      },
    ],
  });
  assert.deepEqual(
    upgradedV2.resources[0].matching.nameKeywords,
    [
      "rations",
      "trail ration",
      "iron ration",
      "emergency ration",
      "field ration",
      "food ration",
    ],
    "the exact v2 food default is repaired during normalization",
  );

  const upgradedV3 = normalizeResourceConfig({
    version: 3,
    resources: [
      {
        id: "food",
        forageYields: "food",
        matching: {
          nameKeywords: ["rations", "trail ration", "food"],
          flagTag: "food",
          itemUuids: [],
        },
      },
      {
        id: "water",
        forageYields: "water",
        matching: {
          nameKeywords: ["waterskin", "water ration", "water (1 day)"],
          flagTag: "water",
          itemUuids: [],
        },
      },
    ],
  });
  assert.ok(
    !upgradedV3.resources[0].matching.nameKeywords.includes("food"),
    "the v3 broad food keyword is removed",
  );
  assert.deepEqual(
    upgradedV3.resources[1].matching.nameKeywords,
    ["water ration", "water (1 day)"],
    "the exact v3 water default no longer consumes Waterskins",
  );

  const customizedV2 = normalizeResourceConfig({
    version: 2,
    resources: [
      {
        id: "food",
        forageYields: "food",
        matching: {
          nameKeywords: ["ration", "rations", "trail ration", "food", "jerky"],
        },
      },
    ],
  });
  assert.ok(
    customizedV2.resources[0].matching.nameKeywords.includes("ration"),
    "customized legacy matcher lists are preserved",
  );

  const upgradedV4Environments = normalizeResourceConfig({
    version: 4,
    environments: [
      {
        id: "limited",
        label: "Wind-scoured Limited Lands",
        dc: 17,
        forageable: true,
        yieldFood: "2d4",
        yieldWater: "1d4",
      },
      {
        id: "biome-forest",
        label: "Campaign Forest",
        dc: 18,
        forageable: true,
        yieldFood: "1d4",
        yieldWater: "1d4",
      },
      { id: "moon-marsh", label: "Moon Marsh", dc: 16 },
    ],
  }).environments;
  assert.deepEqual(
    upgradedV4Environments.slice(0, 3).map((environment) => environment.id),
    ["limited", "biome-forest", "moon-marsh"],
    "v5 migration preserves the saved catalog order",
  );
  const editedLimited = upgradedV4Environments[0];
  assert.equal(editedLimited.builtIn, true);
  assert.equal(editedLimited.label, "Wind-scoured Limited Lands");
  assert.equal(editedLimited.dc, 17);
  assert.equal(editedLimited.yieldFood, "2d4");
  const customForest = upgradedV4Environments[1];
  assert.equal(customForest.builtIn, false);
  assert.equal(customForest.label, "Campaign Forest");
  assert.equal(
    upgradedV4Environments.filter(
      (environment) => environment.id.toLowerCase() === "biome-forest",
    ).length,
    1,
    "a custom biome collision wins instead of being overwritten",
  );
  assert.equal(
    upgradedV4Environments.find(
      (environment) => environment.id === "biome-desert",
    )?.builtIn,
    true,
    "missing shipped biomes append during v5 normalization",
  );

  // Idempotent.
  const again = normalizeResourceConfig(cfg);
  assert.deepEqual(again, cfg);

  // Bad values corrected.
  const fixed = normalizeResourceConfig({
    forageMode: "nonsense",
    maxCatchUpDays: 0,
    resources: [{ junk: true }], // all malformed → fall back to defaults
  });
  assert.equal(fixed.forageMode, "each");
  assert.equal(fixed.maxCatchUpDays, 1, "min clamp 1");
  assert.ok(fixed.resources.length >= 3, "all-malformed list → defaults");

  // waterEnabled:false respected.
  assert.equal(
    normalizeResourceConfig({ waterEnabled: false }).waterEnabled,
    false,
  );

  // partyStashId defaults to "" and round-trips a set value.
  assert.equal(normalizeResourceConfig({}).partyStashId, "");
  assert.equal(
    normalizeResourceConfig({ partyStashId: "actor-7" }).partyStashId,
    "actor-7",
  );

  const deduped = normalizeResourceConfig({
    resources: [
      {
        id: "food",
        label: "First definition wins",
        matching: { flagTag: "food" },
      },
      {
        id: "food",
        label: "Duplicate definition",
        matching: { flagTag: "other-food" },
      },
      {
        id: "medicine",
        label: "Medicine",
        matching: { flagTag: "medicine" },
      },
    ],
  });
  assert.deepEqual(
    deduped.resources.map((resource) => resource.id),
    ["food", "medicine"],
    "resource ids are unique after normalization",
  );
  assert.equal(deduped.resources[0].label, "First definition wins");
}

/* ------------------------------------------------------------------ *
 * serializeResourceConfig - current schema stores structure, not duplicate rules
 * ------------------------------------------------------------------ */
{
  const serialized = serializeResourceConfig({
    forageMode: "best",
    waterEnabled: false,
    halfRations: true,
    maxCatchUpDays: 22,
    forageTimeoutSeconds: 45,
    partyStashId: "stash-a",
    roster: [
      { actorId: "stash-a", isStash: true, consumes: false },
      { actorId: "hero-a", drawFrom: "stash-a", consumes: true },
      { actorId: "legacy-a" },
    ],
    resources: [
      {
        id: "medicine",
        label: "Medicine",
        scope: "party",
        perDay: 1,
        matching: { flagTag: "medicine" },
      },
    ],
  });
  assert.equal(serialized.version, RESOURCE_CONFIG_VERSION);
  assert.equal(serialized.forageTimeoutSeconds, 45);
  assert.equal(serialized.partyStashId, "stash-a");
  assert.equal(serialized.resources[0].id, "medicine");
  assert.deepEqual(
    serialized.roster.map(({ actorId, consumes }) => ({
      actorId,
      consumes,
    })),
    [
      { actorId: "stash-a", consumes: false },
      { actorId: "hero-a", consumes: true },
      { actorId: "legacy-a", consumes: null },
    ],
    "serialization preserves explicit and legacy consumes states",
  );
  for (const duplicateRule of [
    "forageMode",
    "waterEnabled",
    "halfRations",
    "maxCatchUpDays",
  ]) {
    assert.equal(
      Object.hasOwn(serialized, duplicateRule),
      false,
      `${duplicateRule} remains canonical in Module Settings`,
    );
  }
}

/* ------------------------------------------------------------------ *
 * normalizeRoster — dedupe, drop malformed, validate drawFrom
 * ------------------------------------------------------------------ */
{
  assert.deepEqual(normalizeRoster(undefined), [], "no roster → empty");
  assert.deepEqual(
    normalizeRoster([null, {}, { actorId: "" }]),
    [],
    "malformed dropped",
  );
  assert.deepEqual(normalizeRosterEntry({ actorId: "legacy" }), {
    actorId: "legacy",
    isStash: false,
    consumes: null,
    drawFrom: DRAW_FROM_SELF,
  });
  assert.equal(
    normalizeRosterEntry({ actorId: "consumer", consumes: true }).consumes,
    true,
  );
  assert.equal(
    normalizeRosterEntry({ actorId: "storage", consumes: false }).consumes,
    false,
  );
  assert.equal(
    normalizeRosterEntry({ actorId: "invalid", consumes: "false" }).consumes,
    null,
    "non-boolean legacy values stay unspecified",
  );

  const roster = normalizeRoster([
    { actorId: "a", isStash: true, consumes: false },
    { actorId: "a", isStash: false, consumes: true }, // duplicate id → dropped
    { actorId: "b", drawFrom: "a", consumes: true }, // draws from stash a → kept
    { actorId: "c", drawFrom: "ghost" }, // unknown target → self
    { actorId: "d", drawFrom: "d" }, // self-reference → self
  ]);
  assert.deepEqual(
    roster.map((e) => e.actorId),
    ["a", "b", "c", "d"],
    "deduped, order preserved",
  );
  assert.equal(roster[0].isStash, true);
  assert.equal(
    roster[0].consumes,
    false,
    "dedupe preserves the first explicit consumes value",
  );
  assert.equal(roster[1].consumes, true);
  assert.equal(roster[2].consumes, null, "legacy entries normalize to null");
  assert.equal(
    roster[0].drawFrom,
    DRAW_FROM_SELF,
    "a stash always draws from self",
  );
  assert.equal(roster[1].drawFrom, "a", "member draws from a real stash");
  assert.equal(
    roster[2].drawFrom,
    DRAW_FROM_SELF,
    "unknown target falls back to self",
  );
  assert.equal(
    roster[3].drawFrom,
    DRAW_FROM_SELF,
    "self-reference falls back to self",
  );

  // A member can't draw from a non-stash member.
  const nonStash = normalizeRoster([
    { actorId: "x", isStash: false },
    { actorId: "y", drawFrom: "x" },
  ]);
  assert.equal(
    nonStash[1].drawFrom,
    DRAW_FROM_SELF,
    "can't draw from a non-stash",
  );

  // resolveDrawSourceId
  assert.equal(resolveDrawSourceId({ actorId: "b", drawFrom: "a" }), "a");
  assert.equal(
    resolveDrawSourceId({ actorId: "b", drawFrom: DRAW_FROM_SELF }),
    "b",
  );
  assert.equal(
    resolveDrawSourceId({ actorId: "b" }),
    "b",
    "missing drawFrom → self",
  );
  assert.equal(resolveDrawSourceId(null), null);

  // Config carries a normalized roster and stays idempotent with it.
  const cfg = normalizeResourceConfig({
    roster: [
      { actorId: "a", isStash: true },
      { actorId: "b", drawFrom: "a" },
    ],
  });
  assert.equal(cfg.roster.length, 2);
  assert.deepEqual(
    normalizeResourceConfig(cfg).roster,
    cfg.roster,
    "roster idempotent",
  );
  assert.deepEqual(
    normalizeResourceConfig({}).roster,
    [],
    "default roster empty",
  );
}

/* ------------------------------------------------------------------ *
 * createDefaultResourceConfig
 * ------------------------------------------------------------------ */
{
  const cfg = createDefaultResourceConfig();
  const ids = cfg.resources.map((r) => r.id);
  assert.ok(ids.includes("food"));
  assert.ok(ids.includes("water"));
  assert.ok(ids.includes("light"));
  // Water keyword guard: no bare "water" that would snag Holy Water.
  const water = cfg.resources.find((r) => r.id === "water");
  assert.ok(!water.matching.nameKeywords.includes("water"));
}

/* ------------------------------------------------------------------ *
 * normalizeRunState
 * ------------------------------------------------------------------ */
{
  const fresh = normalizeRunState({});
  assert.equal(fresh.lastSeenDay, null);
  assert.equal(fresh.currentEnvironmentId, null);
  assert.equal(fresh.lastUpkeepResult, null);
  assert.equal(fresh.activeUpkeep, null);
  assert.deepEqual(fresh.recentRuns, []);
  assert.equal(RESOURCE_RUN_STATE_VERSION, 4, "current run-state schema is v4");
  assert.equal(
    normalizeRunState({
      version: RESOURCE_RUN_STATE_VERSION + 1,
      lastSeenDay: 8,
    }).lastSeenDay,
    8,
    "the pure run-state normalizer remains independent of persistence guards",
  );

  const live = normalizeRunState({
    lastSeenDay: 12.9,
    currentEnvironmentId: " limited ",
    lastUpkeepResult: { day: 12 },
    recentRuns: [{ runId: "malformed legacy entry" }],
  });
  assert.equal(live.lastSeenDay, 12, "floored");
  assert.equal(live.currentEnvironmentId, "limited", "trimmed");
  assert.deepEqual(live.lastUpkeepResult, { day: 12 });
  assert.deepEqual(
    live.recentRuns,
    [],
    "malformed receipt entries are dropped",
  );

  assert.equal(normalizeRunState({ lastSeenDay: "x" }).lastSeenDay, null);
}

/* ------------------------------------------------------------------ *
 * load* — degrade gracefully when game.settings is absent
 * ------------------------------------------------------------------ */
{
  const originalGame = globalThis.game;
  try {
    delete globalThis.game;
    assert.equal(
      isResourceAutomationReady(),
      true,
      "non-live harnesses do not require a private Journal",
    );
    const cfg = loadResourceConfig();
    assert.ok(cfg.resources.length >= 3, "no game → normalized defaults");
    const state = loadRunState();
    assert.equal(state.lastSeenDay, null);
  } finally {
    resetResourceStoreForTests();
    if (originalGame === undefined) delete globalThis.game;
    else globalThis.game = originalGame;
  }
}

/* ------------------------------------------------------------------ *
 * loadResourceConfig — honors a mocked game.settings.get
 * ------------------------------------------------------------------ */
{
  const originalGame = globalThis.game;
  try {
    globalThis.game = {
      settings: {
        get(moduleId, key) {
          if (moduleId !== "infinity-dnd5e") return undefined;
          if (key === "resourceConfig")
            return {
              version: 4,
              forageMode: "best",
              waterEnabled: false,
              environments: [
                {
                  id: "biome-desert",
                  label: "Campaign Salt Desert",
                  dc: 23,
                },
              ],
            };
          return undefined;
        },
      },
    };
    const cfg = loadResourceConfig();
    assert.equal(cfg.forageMode, "best");
    assert.equal(cfg.waterEnabled, false);
    assert.ok(cfg.resources.length >= 3, "still seeds resources");
    assert.equal(cfg.environments[0].label, "Campaign Salt Desert");
    assert.equal(
      cfg.environments[0].builtIn,
      false,
      "load preserves an old custom collision until migration persists it",
    );
    assert.equal(
      cfg.environments.filter(
        (environment) => environment.id === "biome-desert",
      ).length,
      1,
    );
    assert.ok(
      cfg.environments.some((environment) => environment.id === "biome-forest"),
      "load exposes missing shipped presets before the v5 write",
    );
  } finally {
    if (originalGame === undefined) delete globalThis.game;
    else globalThis.game = originalGame;
  }
}

/* ------------------------------------------------------------------ *
 * loadResourceConfig - v3 overlays the four canonical visible settings
 * ------------------------------------------------------------------ */
{
  const originalGame = globalThis.game;
  try {
    const values = new Map([
      [
        "resourceConfig",
        {
          version: RESOURCE_CONFIG_VERSION,
          forageMode: "each",
          waterEnabled: true,
          halfRations: false,
          maxCatchUpDays: 7,
          resources: [
            {
              id: "medicine",
              label: "Medicine",
              perDay: 1,
              matching: { flagTag: "medicine" },
            },
          ],
        },
      ],
      ["resourceForageMode", "best"],
      ["resourceWaterEnabled", false],
      ["resourceHalfRations", true],
      ["resourceMaxCatchUpDays", 19],
    ]);
    globalThis.game = {
      settings: {
        get(moduleId, key) {
          assert.equal(moduleId, "infinity-dnd5e");
          return values.get(key);
        },
      },
    };
    const cfg = loadResourceConfig();
    assert.equal(cfg.forageMode, "best");
    assert.equal(cfg.waterEnabled, false);
    assert.equal(cfg.halfRations, true);
    assert.equal(cfg.maxCatchUpDays, 19);
    assert.equal(cfg.resources[0].id, "medicine");
  } finally {
    if (originalGame === undefined) delete globalThis.game;
    else globalThis.game = originalGame;
  }
}

/* ------------------------------------------------------------------ *
 * migrateResourceConfig - old rules and defaults migrate to the current schema
 * ------------------------------------------------------------------ */
{
  const originalGame = globalThis.game;
  try {
    const raw = {
      version: 1,
      forageMode: "best",
      waterEnabled: false,
      halfRations: true,
      maxCatchUpDays: 11,
      forageTimeoutSeconds: 30,
      resources: [
        {
          id: "medicine",
          label: "Medicine",
          scope: "party",
          perDay: 1,
          matching: { flagTag: "medicine" },
        },
      ],
      environments: [
        {
          id: "limited",
          label: "Legacy Edited Limited",
          dc: 17,
          forageable: true,
          yieldFood: "2d4",
          yieldWater: "1d4",
        },
        {
          id: "biome-forest",
          label: "Legacy Custom Forest",
          dc: 18,
          forageable: true,
          yieldFood: "1d4",
          yieldWater: "1d4",
        },
      ],
    };
    const writes = [];
    let stored = raw;
    let storedRunState = {
      version: 2,
      revision: 4,
      authorityId: "gm-a",
      authorityEpoch: "node-test:0",
      lastSeenDay: 9,
      currentEnvironmentId: "limited",
      lastUpkeepResult: { runId: "legacy-report", status: "complete" },
      activeUpkeep: {
        runId: "legacy-active",
        trigger: "calendar",
        day: 10,
        days: 1,
        claimedAt: 1234,
      },
    };
    globalThis.game = {
      user: { id: "gm-a", isGM: true, active: true },
      users: {
        activeGM: { id: "gm-a", isGM: true, active: true },
      },
      settings: {
        get(moduleId, key) {
          assert.equal(moduleId, "infinity-dnd5e");
          if (key === "resourceConfig") return stored;
          if (key === "resourceRunState") return storedRunState;
          return undefined;
        },
        async set(moduleId, key, value) {
          assert.equal(moduleId, "infinity-dnd5e");
          writes.push({ key, value });
          if (key === "resourceConfig") stored = value;
          if (key === "resourceRunState") storedRunState = value;
          return value;
        },
      },
    };

    assert.equal(await migrateResourceConfig(), true);
    assert.deepEqual(
      writes.slice(0, 4),
      [
        { key: "resourceForageMode", value: "best" },
        { key: "resourceWaterEnabled", value: false },
        { key: "resourceHalfRations", value: true },
        { key: "resourceMaxCatchUpDays", value: 11 },
      ],
      "legacy runtime behavior moves into the visible settings",
    );
    assert.equal(writes[4].key, "resourceConfig");
    assert.equal(writes[4].value.version, RESOURCE_CONFIG_VERSION);
    assert.equal(writes[4].value.forageTimeoutSeconds, 30);
    assert.equal(writes[4].value.resources[0].id, "medicine");
    assert.deepEqual(
      writes[4].value.environments.slice(0, 2).map((environment) => ({
        id: environment.id,
        label: environment.label,
        builtIn: environment.builtIn,
      })),
      [
        {
          id: "limited",
          label: "Legacy Edited Limited",
          builtIn: true,
        },
        {
          id: "biome-forest",
          label: "Legacy Custom Forest",
          builtIn: false,
        },
      ],
      "v5 migration preserves edited legacy entries and custom collisions",
    );
    assert.equal(writes[4].value.environments[0].yieldFood, "2d4");
    assert.equal(
      writes[4].value.environments.filter(
        (environment) => environment.id === "biome-forest",
      ).length,
      1,
    );
    assert.equal(
      writes[4].value.environments.find(
        (environment) => environment.id === "biome-desert",
      )?.builtIn,
      true,
      "v5 migration appends missing biome presets",
    );
    assert.equal(writes[5].key, "resourceRunState");
    assert.equal(
      writes[5].value.version,
      RESOURCE_RUN_STATE_VERSION,
      "migration versions the persisted run state",
    );
    assert.equal(writes[5].value.authorityId, "gm-a");
    assert.match(writes[5].value.authorityEpoch, /^node-test:/);
    assert.equal(writes[5].value.lastSeenDay, 9);
    assert.deepEqual(writes[5].value.lastUpkeepResult, {
      runId: "legacy-report",
      status: "complete",
    });
    assert.deepEqual(writes[5].value.activeUpkeep, {
      runId: "legacy-active",
      trigger: "calendar",
      day: 10,
      days: 1,
      startedAt: 1234,
      claimedAt: 1234,
      authorityId: null,
      authorityEpoch: null,
      leadershipGeneration: null,
      environment: null,
      initiator: null,
      actors: [],
      forageTarget: null,
      forageAssignments: [],
      forageDestination: null,
    });
    assert.throws(
      () => assertUpkeepClaimCurrent("legacy-active"),
      /ResourceUpkeepClaimLost/,
      "a migrated claim without an original authority guard is non-resumable",
    );
    assert.deepEqual(
      writes[5].value.recentRuns,
      [],
      "v2 worlds migrate with an empty receipt history",
    );
    for (const duplicateRule of [
      "forageMode",
      "waterEnabled",
      "halfRations",
      "maxCatchUpDays",
    ]) {
      assert.equal(Object.hasOwn(writes[4].value, duplicateRule), false);
    }

    writes.length = 0;
    assert.equal(await migrateResourceConfig(), false);
    assert.deepEqual(writes, [], "an already-current world is not rewritten");

    stored = {
      version: 2,
      resources: [
        {
          id: "food",
          label: "Food (Rations)",
          scope: "per-character",
          perDay: 1,
          forageYields: "food",
          matching: {
            nameKeywords: ["ration", "rations", "trail ration", "food"],
            flagTag: "food",
            itemUuids: [],
          },
        },
      ],
    };
    writes.length = 0;
    assert.equal(await migrateResourceConfig(), true);
    const matcherUpgrade = writes.find(
      (write) => write.key === "resourceConfig",
    );
    assert.equal(matcherUpgrade.value.version, RESOURCE_CONFIG_VERSION);
    assert.deepEqual(
      matcherUpgrade.value.resources[0].matching.nameKeywords,
      [
        "rations",
        "trail ration",
        "iron ration",
        "emergency ration",
        "field ration",
        "food ration",
      ],
      "v2 worlds persist the boundary-safe food matcher",
    );

    stored = { ...raw };
    writes.length = 0;
    globalThis.game.user = {
      id: "player-a",
      isGM: false,
      active: true,
    };
    assert.equal(await migrateResourceConfig(), false);
    assert.deepEqual(
      writes,
      [],
      "a player client cannot run a world-setting migration",
    );
  } finally {
    resetResourceStoreForTests();
    if (originalGame === undefined) delete globalThis.game;
    else globalThis.game = originalGame;
  }
}

/* ------------------------------------------------------------------ *
 * Live player clients use safe private defaults and never fall back to the
 * synchronized legacy world settings, even if an old world still has secrets.
 * ------------------------------------------------------------------ */
{
  const originalGame = globalThis.game;
  const originalJournalEntry = globalThis.JournalEntry;
  try {
    resetPrivateStateForTests();
    globalThis.JournalEntry = { create() {} };
    const legacySecrets = {
      resourceConfig: {
        version: 2,
        resources: [
          {
            id: "secret-stock",
            label: "Hidden Stockpile",
            matching: {
              nameKeywords: ["secret phrase"],
              itemUuids: ["Actor.hidden.Item.hidden"],
            },
          },
        ],
      },
      resourceRunState: {
        lastSeenDay: 99,
        lastUpkeepResult: { error: "private actor details" },
      },
    };
    globalThis.game = {
      ready: false,
      user: { id: "player-a", isGM: false, active: true },
      users: {
        activeGM: { id: "gm-a", isGM: true, active: true },
      },
      settings: {
        get(_moduleId, key) {
          return legacySecrets[key];
        },
      },
    };

    assert.throws(
      () => loadResourceConfig(),
      (error) => error?.code === "PRIVATE_STATE_UNAVAILABLE",
      "pre-ready Foundry never reads legacy Quartermaster data",
    );
    globalThis.game.ready = true;
    assert.throws(
      () => loadResourceConfig(),
      (error) =>
        error?.code === "PRIVATE_STATE_UNAVAILABLE" &&
        error?.retryable === true,
      "a live client fails closed until private-state initialization completes",
    );
    await initializePrivateState();
    assert.equal(
      isResourceAutomationReady(),
      false,
      "safe player defaults never satisfy the live automation gate",
    );
    const config = loadResourceConfig();
    assert.equal(
      config.resources.some((resource) => resource.id === "secret-stock"),
      false,
      "player config never falls back to a legacy private payload",
    );
    assert.equal(loadRunState().lastSeenDay, null);
    await assert.rejects(
      saveResourceConfig(config),
      /PermissionDenied/,
      "players cannot write private resource configuration",
    );
    await assert.rejects(
      saveRunState({ lastSeenDay: 100 }),
      /PermissionDenied/,
      "players cannot write private resource run state",
    );
    await assert.rejects(
      setLastSeenDay(100),
      /PermissionDenied/,
      "queued run-state patches preserve the authoritative-GM gate",
    );
  } finally {
    resetResourceStoreForTests();
    resetPrivateStateForTests();
    if (originalGame === undefined) delete globalThis.game;
    else globalThis.game = originalGame;
    if (originalJournalEntry === undefined) delete globalThis.JournalEntry;
    else globalThis.JournalEntry = originalJournalEntry;
  }
}

/* ------------------------------------------------------------------ *
 * Live automation waits for a privileged store and raw config migration.
 * ------------------------------------------------------------------ */
{
  const originalGame = globalThis.game;
  const originalJournalEntry = globalThis.JournalEntry;
  const originalHooks = globalThis.Hooks;
  const originalConst = globalThis.CONST;
  try {
    resetPrivateStateForTests();
    let nextHookId = 0;
    const listeners = new Map();
    globalThis.Hooks = {
      on(event, handler) {
        const id = ++nextHookId;
        if (!listeners.has(event)) listeners.set(event, new Map());
        listeners.get(event).set(id, handler);
        return id;
      },
      off(event, id) {
        listeners.get(event)?.delete(id);
      },
      call(event, ...args) {
        for (const handler of listeners.get(event)?.values() ?? []) {
          handler(...args);
        }
      },
    };
    globalThis.CONST = {
      DOCUMENT_OWNERSHIP_LEVELS: { NONE: 0 },
      USER_ROLES: { GAMEMASTER: 4 },
    };
    const flags = {
      privateStateStore: true,
      schemaVersion: 2,
      merchants: [],
      factions: [],
      resourceConfig: { version: 1 },
      // Foundry deep-merges flag objects and can retain this legacy key order.
      // Migration verification must compare values, not JSON insertion order.
      resourceRunState: {
        lastSeenDay: null,
        currentEnvironmentId: null,
        lastUpkeepResult: null,
      },
    };
    let blockedRunStateUpdate = null;
    const store = {
      id: "private-resource-store",
      ownership: { default: 0 },
      updateCalls: [],
      getFlag(scope, key) {
        return scope === "infinity-dnd5e" ? flags[key] : undefined;
      },
      async update(changes) {
        this.updateCalls.push(structuredClone(changes));
        if (
          blockedRunStateUpdate &&
          Object.hasOwn(changes, "flags.infinity-dnd5e.resourceRunState")
        ) {
          const blocked = blockedRunStateUpdate;
          blockedRunStateUpdate = null;
          blocked.markStarted();
          await blocked.wait;
        }
        for (const [path, value] of Object.entries(changes)) {
          const match = /^flags\.infinity-dnd5e\.(.+)$/.exec(path);
          if (match) {
            const key = match[1];
            const snapshot = structuredClone(value);
            flags[key] =
              key === "resourceRunState" &&
              flags[key] &&
              typeof flags[key] === "object" &&
              !Array.isArray(flags[key])
                ? { ...flags[key], ...snapshot }
                : snapshot;
          }
        }
        globalThis.Hooks.call("updateJournalEntry", this, changes);
        return this;
      },
      blockNextRunStateUpdate() {
        let release;
        let markStarted;
        const wait = new Promise((resolve) => {
          release = resolve;
        });
        const started = new Promise((resolve) => {
          markStarted = resolve;
        });
        blockedRunStateUpdate = { wait, markStarted };
        return { release, started };
      },
    };
    const gm = { id: "gm-a", isGM: true, role: 4, active: true };
    globalThis.game = {
      ready: true,
      user: gm,
      users: { activeGM: gm },
      journal: {
        find(predicate) {
          return predicate(store) ? store : null;
        },
      },
      settings: {
        get(_moduleId, key) {
          if (key === "privateStateStoreId") return store.id;
          if (key === "merchants" || key === "factions") return [];
          return {};
        },
        async set() {
          throw new Error("default legacy settings should not be rewritten");
        },
      },
    };
    globalThis.JournalEntry = {
      async create() {
        throw new Error("existing private store should be reused");
      },
    };

    await initializePrivateState();
    assert.equal(flags.schemaVersion, 7);
    assert.deepEqual(flags.merchantTransactions, {
      version: 1,
      revision: 0,
      authorityId: null,
      authorityEpoch: null,
      writeToken: null,
      replayFloors: [],
      records: [],
    });
    assert.deepEqual(flags.criticalInjuryWorkflow, {});
    assert.deepEqual(flags.criticalInjuryWorkflowCheckpoint, {});
    assert.equal(
      isResourceAutomationReady(),
      false,
      "a hydrated store with raw v1 config remains automation-blocked",
    );
    assert.equal(await saveResourceConfig({}), true);
    assert.equal(flags.resourceConfig.version, RESOURCE_CONFIG_VERSION);
    assert.equal(
      isResourceAutomationReady(),
      false,
      "current config alone cannot enable automation without versioned run state",
    );
    assert.equal(await migrateResourceConfig(), true);
    assert.equal(flags.resourceRunState.version, RESOURCE_RUN_STATE_VERSION);
    assert.equal(flags.resourceRunState.authorityId, "gm-a");
    assert.ok(flags.resourceRunState.authorityEpoch);
    assert.equal(
      isResourceAutomationReady(),
      true,
      "validated config and run state enable automation",
    );

    const currentConfig = structuredClone(flags.resourceConfig);
    await setPrivateState("resourceConfig", {
      ...currentConfig,
      version: RESOURCE_CONFIG_VERSION + 1,
      futureOnly: { preserve: true },
    });
    const configWritesBeforeGuard = store.updateCalls.length;
    assert.throws(
      () => loadResourceConfig(),
      (error) => {
        assert.equal(error?.code, "RESOURCE_CONFIG_FUTURE_VERSION");
        assert.equal(error?.retryable, false);
        assert.deepEqual(error?.persistedVersionStatus, {
          state: "blocked",
          code: "future-version",
          retryable: false,
          domain: "resource-config",
          supportedVersion: RESOURCE_CONFIG_VERSION,
          observedVersion: RESOURCE_CONFIG_VERSION + 1,
        });
        return true;
      },
    );
    assert.equal(isResourceAutomationReady(), false);
    await assert.rejects(
      saveResourceConfig(currentConfig),
      (error) => error?.code === "RESOURCE_CONFIG_FUTURE_VERSION",
    );
    await assert.rejects(
      setResourceRule("waterEnabled", false),
      (error) => error?.code === "RESOURCE_CONFIG_FUTURE_VERSION",
    );
    await assert.rejects(
      migrateResourceConfig(),
      (error) => error?.code === "RESOURCE_CONFIG_FUTURE_VERSION",
    );
    assert.equal(store.updateCalls.length, configWritesBeforeGuard);
    assert.equal(flags.resourceConfig.version, RESOURCE_CONFIG_VERSION + 1);
    assert.deepEqual(flags.resourceConfig.futureOnly, { preserve: true });
    await setPrivateState("resourceConfig", currentConfig);

    for (const malformedVersion of [[RESOURCE_CONFIG_VERSION], null, ""]) {
      await setPrivateState("resourceConfig", {
        ...currentConfig,
        version: malformedVersion,
        malformedOnly: { preserve: true },
      });
      const malformedWritesBeforeGuard = store.updateCalls.length;
      assert.equal(isResourceAutomationReady(), false);
      assert.throws(
        () => loadResourceConfig(),
        (error) => error?.code === "RESOURCE_CONFIG_INVALID_VERSION",
      );
      await assert.rejects(
        saveResourceConfig(currentConfig),
        (error) => error?.code === "RESOURCE_CONFIG_INVALID_VERSION",
      );
      assert.equal(store.updateCalls.length, malformedWritesBeforeGuard);
      assert.deepEqual(flags.resourceConfig.malformedOnly, { preserve: true });
    }
    await setPrivateState("resourceConfig", currentConfig);

    const currentRunState = structuredClone(flags.resourceRunState);
    await setPrivateState("resourceRunState", {
      ...currentRunState,
      version: RESOURCE_RUN_STATE_VERSION + 1,
      futureOnly: { preserve: true },
    });
    const runStateWritesBeforeGuard = store.updateCalls.length;
    assert.throws(
      () => loadRunState(),
      (error) => {
        assert.equal(error?.code, "RESOURCE_RUN_STATE_FUTURE_VERSION");
        assert.deepEqual(error?.persistedVersionStatus, {
          state: "blocked",
          code: "future-version",
          retryable: false,
          domain: "resource-run-state",
          supportedVersion: RESOURCE_RUN_STATE_VERSION,
          observedVersion: RESOURCE_RUN_STATE_VERSION + 1,
        });
        return true;
      },
    );
    assert.equal(isResourceAutomationReady(), false);
    await assert.rejects(
      saveRunState({ lastSeenDay: 500 }),
      (error) => error?.code === "RESOURCE_RUN_STATE_FUTURE_VERSION",
    );
    await assert.rejects(
      saveResourceConfig(currentConfig),
      (error) => error?.code === "RESOURCE_RUN_STATE_FUTURE_VERSION",
    );
    await assert.rejects(
      setResourceRule("waterEnabled", false),
      (error) => error?.code === "RESOURCE_RUN_STATE_FUTURE_VERSION",
    );
    await assert.rejects(
      resetResourceRules(),
      (error) => error?.code === "RESOURCE_RUN_STATE_FUTURE_VERSION",
    );
    await assert.rejects(
      migrateResourceConfig(),
      (error) => error?.code === "RESOURCE_RUN_STATE_FUTURE_VERSION",
    );
    assert.equal(store.updateCalls.length, runStateWritesBeforeGuard);
    assert.equal(
      flags.resourceRunState.version,
      RESOURCE_RUN_STATE_VERSION + 1,
    );
    assert.deepEqual(flags.resourceRunState.futureOnly, { preserve: true });

    await setPrivateState("resourceConfig", {
      ...currentConfig,
      version: 1,
      waterEnabled: false,
      legacyOnly: { preserve: true },
    });
    const migrationWritesBeforePreflight = store.updateCalls.length;
    await assert.rejects(
      migrateResourceConfig(),
      (error) => error?.code === "RESOURCE_RUN_STATE_FUTURE_VERSION",
    );
    assert.equal(store.updateCalls.length, migrationWritesBeforePreflight);
    assert.equal(flags.resourceConfig.version, 1);
    assert.deepEqual(flags.resourceConfig.legacyOnly, { preserve: true });
    await setPrivateState("resourceConfig", currentConfig);

    delete flags.resourceRunState.futureOnly;
    await setPrivateState("resourceRunState", currentRunState);
    assert.equal(isResourceAutomationReady(), true);

    for (const malformedVersion of [null, ""]) {
      await setPrivateState("resourceRunState", {
        ...currentRunState,
        version: malformedVersion,
        malformedOnly: { preserve: true },
      });
      const malformedRunStateWritesBeforeGuard = store.updateCalls.length;
      assert.throws(
        () => loadRunState(),
        (error) => error?.code === "RESOURCE_RUN_STATE_INVALID_VERSION",
      );
      await assert.rejects(
        setResourceRule("waterEnabled", false),
        (error) => error?.code === "RESOURCE_RUN_STATE_INVALID_VERSION",
      );
      await assert.rejects(
        resetResourceRules(),
        (error) => error?.code === "RESOURCE_RUN_STATE_INVALID_VERSION",
      );
      assert.equal(
        store.updateCalls.length,
        malformedRunStateWritesBeforeGuard,
      );
      assert.deepEqual(flags.resourceRunState.malformedOnly, {
        preserve: true,
      });
    }
    delete flags.resourceRunState.malformedOnly;
    await setPrivateState("resourceRunState", currentRunState);
    assert.equal(isResourceAutomationReady(), true);

    flags.schemaVersion = 1;
    assert.equal(
      isResourceAutomationReady(),
      false,
      "an old private-store schema cannot satisfy automation readiness",
    );
    flags.schemaVersion = 7;
    assert.equal(isResourceAutomationReady(), true);

    const acceptedBeforeWrite = structuredClone(flags.resourceRunState);
    await setCurrentEnvironment("new-authority-camp");
    await setLastSeenDay(77);
    const acceptedAfterWrite = structuredClone(flags.resourceRunState);
    assert.equal(acceptedAfterWrite.currentEnvironmentId, "new-authority-camp");
    assert.equal(acceptedAfterWrite.lastSeenDay, 77);
    assert.ok(
      acceptedAfterWrite.revision > acceptedBeforeWrite.revision,
      "accepted writes advance the persisted revision",
    );

    // A same-epoch payload may be replayed only when its full persisted value is
    // identical. Equal revision with divergent run-state data is rejected and
    // reasserted from the last accepted snapshot at a higher revision.
    const acceptedBeforeDivergence = structuredClone(flags.resourceRunState);
    flags.resourceRunState = {
      ...acceptedBeforeDivergence,
      lastSeenDay: 909,
    };
    globalThis.Hooks.call("updateJournalEntry", store, {
      [`flags.infinity-dnd5e.resourceRunState`]: flags.resourceRunState,
    });
    assert.equal(
      isResourceAutomationReady(),
      false,
      "equal revision with divergent data locks automation",
    );
    assert.equal(await migrateResourceConfig(), true);
    assert.equal(
      flags.resourceRunState.lastSeenDay,
      acceptedBeforeDivergence.lastSeenDay,
    );
    assert.ok(
      flags.resourceRunState.revision > acceptedBeforeDivergence.revision,
    );

    // Simulate an old in-flight whole-object update landing late. Readiness must
    // lock immediately, and recovery must reassert the last accepted values
    // rather than reserializing the stale payload.
    flags.resourceRunState = {
      ...acceptedBeforeWrite,
      authorityEpoch: "gm-a:stale-authority-epoch",
      currentEnvironmentId: "stale-road",
      lastSeenDay: 12,
    };
    globalThis.Hooks.call("updateJournalEntry", store, {
      [`flags.infinity-dnd5e.resourceRunState`]: flags.resourceRunState,
    });
    assert.equal(
      isResourceAutomationReady(),
      false,
      "a stale authority epoch locks automation",
    );
    assert.equal(await migrateResourceConfig(), true);
    assert.equal(
      flags.resourceRunState.currentEnvironmentId,
      "new-authority-camp",
    );
    assert.equal(flags.resourceRunState.lastSeenDay, 77);
    assert.ok(
      flags.resourceRunState.revision > acceptedAfterWrite.revision,
      "recovery reasserts accepted values at a higher revision",
    );
    assert.equal(isResourceAutomationReady(), true);

    const acceptedAfterRecovery = structuredClone(flags.resourceRunState);
    flags.resourceRunState = {
      ...acceptedAfterRecovery,
      revision: acceptedAfterRecovery.revision - 1,
      currentEnvironmentId: "regressed-camp",
    };
    globalThis.Hooks.call("updateJournalEntry", store, {
      [`flags.infinity-dnd5e.resourceRunState`]: flags.resourceRunState,
    });
    assert.equal(
      isResourceAutomationReady(),
      false,
      "a lower persisted revision locks automation",
    );
    assert.equal(await migrateResourceConfig(), true);
    assert.equal(
      flags.resourceRunState.currentEnvironmentId,
      "new-authority-camp",
    );
    assert.ok(flags.resourceRunState.revision > acceptedAfterRecovery.revision);

    const acceptedBeforeHandoff = structuredClone(flags.resourceRunState);
    const blocked = store.blockNextRunStateUpdate();
    const lateOldAuthorityWrite = setLastSeenDay(999);
    await blocked.started;
    const gmB = { id: "gm-b", isGM: true, role: 4, active: true };
    globalThis.game.users.activeGM = gmB;
    observeResourceAuthorityTransition();
    globalThis.game.users.activeGM = gm;
    observeResourceAuthorityTransition();
    blocked.release();
    await assert.rejects(
      lateOldAuthorityWrite,
      /AuthorityChanged|PostconditionFailed/,
      "queued work from a retired authority epoch is rejected",
    );
    assert.equal(
      isResourceAutomationReady(),
      false,
      "the late retired-epoch Journal write locks automation",
    );
    assert.equal(await migrateResourceConfig(), true);
    assert.equal(
      flags.resourceRunState.lastSeenDay,
      acceptedBeforeHandoff.lastSeenDay,
      "handoff recovery preserves the last accepted new-authority value",
    );
    assert.equal(
      flags.resourceRunState.currentEnvironmentId,
      acceptedBeforeHandoff.currentEnvironmentId,
    );
    assert.ok(flags.resourceRunState.revision > acceptedBeforeHandoff.revision);
    assert.equal(isResourceAutomationReady(), true);

    // The highest legal revision rotates to a new authority epoch rather than
    // overflowing JavaScript's safe-integer range.
    flags.resourceRunState = {
      ...flags.resourceRunState,
      revision: Number.MAX_SAFE_INTEGER,
    };
    globalThis.Hooks.call("updateJournalEntry", store, {
      [`flags.infinity-dnd5e.resourceRunState`]: flags.resourceRunState,
    });
    assert.equal(isResourceAutomationReady(), true);
    const epochBeforeOverflow = flags.resourceRunState.authorityEpoch;
    assert.equal(await setLastSeenDay(88), true);
    assert.equal(flags.resourceRunState.revision, 0);
    assert.notEqual(flags.resourceRunState.authorityEpoch, epochBeforeOverflow);
    assert.equal(flags.resourceRunState.lastSeenDay, 88);
    assert.equal(Number.isSafeInteger(flags.resourceRunState.revision), true);

    // Unsafe integer revisions are never accepted as persisted state.
    flags.resourceRunState = {
      ...flags.resourceRunState,
      revision: Number.MAX_SAFE_INTEGER + 1,
      lastSeenDay: 777,
    };
    globalThis.Hooks.call("updateJournalEntry", store, {
      [`flags.infinity-dnd5e.resourceRunState`]: flags.resourceRunState,
    });
    assert.equal(isResourceAutomationReady(), false);
    assert.equal(await migrateResourceConfig(), true);
    assert.equal(flags.resourceRunState.lastSeenDay, 88);
    assert.equal(Number.isSafeInteger(flags.resourceRunState.revision), true);
    assert.equal(isResourceAutomationReady(), true);

    // A direct config save that begins before cache hydration must still fence
    // against the canonical version after private-state initialization.
    flags.resourceConfig = {
      ...currentConfig,
      version: RESOURCE_CONFIG_VERSION + 1,
      futureOnly: { preserve: true },
    };
    resetPrivateStateForTests();
    const writesBeforePreInitGuard = store.updateCalls.length;
    await assert.rejects(
      saveResourceConfig(currentConfig),
      (error) => error?.code === "RESOURCE_CONFIG_FUTURE_VERSION",
    );
    assert.equal(store.updateCalls.length, writesBeforePreInitGuard);
    assert.equal(flags.resourceConfig.version, RESOURCE_CONFIG_VERSION + 1);
    assert.deepEqual(flags.resourceConfig.futureOnly, { preserve: true });
  } finally {
    resetResourceStoreForTests();
    resetPrivateStateForTests();
    if (originalGame === undefined) delete globalThis.game;
    else globalThis.game = originalGame;
    if (originalJournalEntry === undefined) delete globalThis.JournalEntry;
    else globalThis.JournalEntry = originalJournalEntry;
    if (originalHooks === undefined) delete globalThis.Hooks;
    else globalThis.Hooks = originalHooks;
    if (originalConst === undefined) delete globalThis.CONST;
    else globalThis.CONST = originalConst;
  }
}

/* ------------------------------------------------------------------ *
 * Campaign-tab leadership fences every live resource persistence boundary.
 * ------------------------------------------------------------------ */
{
  const originalGame = globalThis.game;
  const originalJournalEntry = globalThis.JournalEntry;
  const originalHooks = globalThis.Hooks;
  const originalConst = globalThis.CONST;
  const leadershipState = { active: true, generation: 1 };
  const leadership = {
    async ensureLeadership() {
      return leadershipState.active;
    },
    hasLeadership() {
      return leadershipState.active;
    },
    getStatus() {
      return {
        required: true,
        state: leadershipState.active ? "leader" : "waiting",
        leader: leadershipState.active,
        generation: leadershipState.generation,
      };
    },
  };
  try {
    resetPrivateStateForTests();
    resetResourceStoreForTests({ leadership });

    let nextHookId = 0;
    const listeners = new Map();
    globalThis.Hooks = {
      on(event, handler) {
        const id = ++nextHookId;
        if (!listeners.has(event)) listeners.set(event, new Map());
        listeners.get(event).set(id, handler);
        return id;
      },
      off(event, id) {
        listeners.get(event)?.delete(id);
      },
      call(event, ...args) {
        for (const handler of listeners.get(event)?.values() ?? []) {
          handler(...args);
        }
      },
    };
    globalThis.CONST = {
      DOCUMENT_OWNERSHIP_LEVELS: { NONE: 0 },
      USER_ROLES: { GAMEMASTER: 4 },
    };

    const flags = {
      privateStateStore: true,
      schemaVersion: 2,
      merchants: [],
      factions: [],
      resourceConfig: serializeResourceConfig(createDefaultResourceConfig()),
      resourceRunState: {
        lastSeenDay: 8,
        currentEnvironmentId: "road",
        lastUpkeepResult: null,
        activeUpkeep: null,
        recentRuns: [],
      },
    };
    const settingValues = new Map();
    const settingWrites = [];
    let loseOnPrivateKey = null;
    let loseOnSettingKey = null;
    let blockedPrivateWrite = null;
    const store = {
      id: "leadership-resource-store",
      ownership: { default: 0 },
      updateCalls: [],
      getFlag(scope, key) {
        return scope === "infinity-dnd5e" ? flags[key] : undefined;
      },
      async update(changes) {
        this.updateCalls.push(structuredClone(changes));
        const changedKeys = Object.keys(changes).map(
          (path) => /^flags\.infinity-dnd5e\.(.+)$/.exec(path)?.[1] ?? "",
        );
        if (
          blockedPrivateWrite &&
          changedKeys.includes(blockedPrivateWrite.key)
        ) {
          const blocked = blockedPrivateWrite;
          blockedPrivateWrite = null;
          blocked.markStarted();
          await blocked.wait;
        }
        for (const [path, value] of Object.entries(changes)) {
          const match = /^flags\.infinity-dnd5e\.(.+)$/.exec(path);
          if (!match) continue;
          const key = match[1];
          const snapshot = structuredClone(value);
          flags[key] =
            key === "resourceRunState" &&
            flags[key] &&
            typeof flags[key] === "object" &&
            !Array.isArray(flags[key])
              ? { ...flags[key], ...snapshot }
              : snapshot;
        }
        if (loseOnPrivateKey && changedKeys.includes(loseOnPrivateKey)) {
          loseOnPrivateKey = null;
          leadershipState.active = false;
        }
        globalThis.Hooks.call("updateJournalEntry", this, changes);
        return this;
      },
      blockNext(key) {
        let release;
        let markStarted;
        const wait = new Promise((resolve) => {
          release = resolve;
        });
        const started = new Promise((resolve) => {
          markStarted = resolve;
        });
        blockedPrivateWrite = {
          key,
          wait,
          markStarted,
        };
        return { release, started };
      },
    };
    const gm = { id: "gm-leader", isGM: true, role: 4, active: true };
    globalThis.game = {
      ready: true,
      user: gm,
      users: { activeGM: gm },
      journal: {
        find(predicate) {
          return predicate(store) ? store : null;
        },
      },
      settings: {
        get(_moduleId, key) {
          if (key === "privateStateStoreId") return store.id;
          if (key === "merchants" || key === "factions") return [];
          return settingValues.get(key);
        },
        async set(_moduleId, key, value) {
          settingWrites.push({ key, value });
          settingValues.set(key, value);
          if (loseOnSettingKey === key) {
            loseOnSettingKey = null;
            leadershipState.active = false;
          }
          return value;
        },
      },
    };
    globalThis.JournalEntry = {
      async create() {
        throw new Error("existing private store should be reused");
      },
    };

    await initializePrivateState();
    store.updateCalls.length = 0;
    settingWrites.length = 0;
    assert.equal(await migrateResourceConfig(), true);
    const firstEpoch = flags.resourceRunState.authorityEpoch;
    assert.ok(firstEpoch);
    assert.equal(isResourceAutomationReady(), true);

    // A second tab signed in as the same GM is still a follower. Every public
    // persistence entry point stops before either Journal or settings writes.
    leadershipState.active = false;
    const loss = observeResourceAuthorityTransition();
    assert.equal(loss.changed, true);
    assert.equal(loss.leadershipActive, false);
    assert.equal(loss.authorityEpoch, null);
    const followerPrivateWrites = store.updateCalls.length;
    const followerSettingWrites = settingWrites.length;
    await assert.rejects(
      saveResourceConfig(loadResourceConfig()),
      (error) => error?.code === "RESOURCE_CAMPAIGN_AUTHORITY_UNAVAILABLE",
    );
    await assert.rejects(
      setResourceRule("waterEnabled", false),
      (error) => error?.code === "RESOURCE_CAMPAIGN_AUTHORITY_UNAVAILABLE",
    );
    await assert.rejects(
      resetResourceRules(),
      (error) => error?.code === "RESOURCE_CAMPAIGN_AUTHORITY_UNAVAILABLE",
    );
    await assert.rejects(
      setLastSeenDay(9),
      (error) => error?.code === "RESOURCE_CAMPAIGN_AUTHORITY_UNAVAILABLE",
    );
    assert.throws(
      () => assertUpkeepClaimCurrent("not-active"),
      /ResourceRunStateAuthorityChanged/,
    );
    assert.equal(await migrateResourceConfig(), false);
    assert.equal(store.updateCalls.length, followerPrivateWrites);
    assert.equal(settingWrites.length, followerSettingWrites);

    leadershipState.active = true;
    leadershipState.generation += 1;
    const handoff = observeResourceAuthorityTransition();
    assert.equal(handoff.changed, true);
    assert.equal(handoff.newlyAuthoritative, true);
    assert.equal(handoff.leadershipGeneration, 2);
    assert.notEqual(handoff.authorityEpoch, firstEpoch);
    assert.equal(await migrateResourceConfig(), true);
    assert.equal(flags.resourceRunState.authorityEpoch, handoff.authorityEpoch);
    assert.equal(isResourceAutomationReady(), true);

    // Config and runtime-rule writes both validate the same generation after
    // their awaited persistence call, not just before it starts.
    loseOnPrivateKey = "resourceConfig";
    await assert.rejects(
      saveResourceConfig({
        ...loadResourceConfig(),
        forageTimeoutSeconds: 321,
      }),
      /PostconditionFailed|AuthorityChanged/,
    );
    assert.equal(flags.resourceConfig.forageTimeoutSeconds, 321);
    assert.equal(isResourceAutomationReady(), false);

    leadershipState.active = true;
    leadershipState.generation += 1;
    observeResourceAuthorityTransition();
    assert.equal(await migrateResourceConfig(), true);
    loseOnSettingKey = "resourceWaterEnabled";
    await assert.rejects(
      setResourceRule("waterEnabled", false),
      /ResourceRunStateAuthorityChanged/,
    );
    assert.equal(settingValues.get("resourceWaterEnabled"), false);

    // Migration keeps one generation fence across rule, config, and run-state
    // stages. Losing the tab after a legacy-rule write stops later stages.
    leadershipState.active = true;
    leadershipState.generation += 1;
    observeResourceAuthorityTransition();
    flags.resourceConfig = {
      ...flags.resourceConfig,
      version: 1,
      waterEnabled: true,
    };
    globalThis.Hooks.call("updateJournalEntry", store, {
      "flags.infinity-dnd5e.resourceConfig": flags.resourceConfig,
    });
    const migrationPrivateWrites = store.updateCalls.length;
    loseOnSettingKey = "resourceWaterEnabled";
    await assert.rejects(
      migrateResourceConfig(),
      /ResourceRunStateAuthorityChanged/,
    );
    assert.equal(flags.resourceConfig.version, 1);
    assert.equal(store.updateCalls.length, migrationPrivateWrites);

    leadershipState.active = true;
    leadershipState.generation += 1;
    observeResourceAuthorityTransition();
    assert.equal(await migrateResourceConfig(), true);
    const queuedEpoch = flags.resourceRunState.authorityEpoch;
    const writesBeforeLoss = store.updateCalls.length;
    const blocked = store.blockNext("resourceRunState");
    const inFlight = setLastSeenDay(31);
    await blocked.started;
    const queuedOldTab = setCurrentEnvironment("queued-old-tab");
    await Promise.resolve();
    leadershipState.active = false;
    observeResourceAuthorityTransition();
    blocked.release();
    await assert.rejects(inFlight, /PostconditionFailed|AuthorityChanged/);
    await assert.rejects(queuedOldTab, /ResourceRunStateAuthorityChanged/);
    assert.equal(
      store.updateCalls.length,
      writesBeforeLoss + 1,
      "the queued old-generation patch performs no Journal write",
    );
    assert.equal(isResourceAutomationReady(), false);

    leadershipState.active = true;
    leadershipState.generation += 1;
    const recoveredLeader = observeResourceAuthorityTransition();
    assert.equal(recoveredLeader.newlyAuthoritative, true);
    assert.notEqual(recoveredLeader.authorityEpoch, queuedEpoch);
    assert.equal(await migrateResourceConfig(), true);
    assert.equal(
      flags.resourceRunState.currentEnvironmentId,
      "road",
      "handoff recovery reasserts the last accepted run-state snapshot",
    );
    assert.equal(flags.resourceRunState.lastSeenDay, 8);
    assert.equal(isResourceAutomationReady(), true);

    // A blocked Actor continuation keeps the immutable generation that made
    // its claim. Losing and later regaining leadership re-epochs the outer
    // state but cannot make that old async closure current again.
    await claimUpkeepRun({
      runId: "generation-a-run",
      trigger: "manual",
      day: 8,
      claimedAt: 4_000,
    });
    const originalRunGuard = {
      authorityId: flags.resourceRunState.activeUpkeep.authorityId,
      authorityEpoch: flags.resourceRunState.activeUpkeep.authorityEpoch,
      leadershipGeneration:
        flags.resourceRunState.activeUpkeep.leadershipGeneration,
    };
    assert.deepEqual(originalRunGuard, {
      authorityId: flags.resourceRunState.authorityId,
      authorityEpoch: flags.resourceRunState.authorityEpoch,
      leadershipGeneration: leadershipState.generation,
    });
    let releaseActorContinuation;
    const actorContinuationGate = new Promise((resolve) => {
      releaseActorContinuation = resolve;
    });
    const staleActorContinuation = (async () => {
      await actorContinuationGate;
      return assertUpkeepClaimCurrent("generation-a-run");
    })();

    leadershipState.active = false;
    observeResourceAuthorityTransition();
    leadershipState.active = true;
    leadershipState.generation += 1;
    const generationC = observeResourceAuthorityTransition();
    assert.equal(generationC.newlyAuthoritative, true);
    assert.equal(await migrateResourceConfig(), true);
    assert.notEqual(
      flags.resourceRunState.authorityEpoch,
      originalRunGuard.authorityEpoch,
    );
    assert.deepEqual(
      {
        authorityId: flags.resourceRunState.activeUpkeep.authorityId,
        authorityEpoch: flags.resourceRunState.activeUpkeep.authorityEpoch,
        leadershipGeneration:
          flags.resourceRunState.activeUpkeep.leadershipGeneration,
      },
      originalRunGuard,
      "authority recovery preserves the claim's original generation guard",
    );
    releaseActorContinuation();
    await assert.rejects(staleActorContinuation, /ResourceUpkeepClaimLost/);

    const staleResult = {
      runId: "generation-a-run",
      trigger: "manual",
      day: 8,
      days: 1,
      status: "complete",
      resourceSnapshot: [],
      perActor: [],
      party: {},
      suggestions: [],
    };
    const staleReceipt = buildUpkeepRunReceipt({
      result: staleResult,
      recordedAt: 4_100,
    });
    const writesBeforeStaleFinalization = store.updateCalls.length;
    await assert.rejects(
      completeUpkeepRun({
        runId: "generation-a-run",
        result: staleResult,
        receipt: staleReceipt,
      }),
      /ResourceUpkeepClaimLost/,
    );
    assert.equal(store.updateCalls.length, writesBeforeStaleFinalization);
    assert.equal(
      await clearUpkeepClaim("generation-a-run", { recordedAt: 4_200 }),
      true,
    );
    assert.equal(store.updateCalls.length, writesBeforeStaleFinalization + 1);
    assert.equal(flags.resourceRunState.activeUpkeep, null);
    assert.equal(
      flags.resourceRunState.recentRuns[0].runId,
      "generation-a-run",
    );
    assert.equal(flags.resourceRunState.recentRuns[0].status, "interrupted");
    assert.equal(flags.resourceRunState.recentRuns[0].outcomeUnknown, true);
    await assert.rejects(
      clearUpkeepClaim("generation-a-run", { recordedAt: 4_300 }),
      /ResourceUpkeepClaimLost/,
    );
    assert.equal(store.updateCalls.length, writesBeforeStaleFinalization + 1);
  } finally {
    resetResourceStoreForTests();
    resetPrivateStateForTests();
    if (originalGame === undefined) delete globalThis.game;
    else globalThis.game = originalGame;
    if (originalJournalEntry === undefined) delete globalThis.JournalEntry;
    else globalThis.JournalEntry = originalJournalEntry;
    if (originalHooks === undefined) delete globalThis.Hooks;
    else globalThis.Hooks = originalHooks;
    if (originalConst === undefined) delete globalThis.CONST;
    else globalThis.CONST = originalConst;
  }
}

/* ------------------------------------------------------------------ *
 * Run-state patch helpers serialize overlapping same-client writes.
 * ------------------------------------------------------------------ */
{
  const originalGame = globalThis.game;
  try {
    let stored = {
      lastSeenDay: null,
      currentEnvironmentId: null,
      lastUpkeepResult: null,
    };
    const writes = [];
    let releaseFirstWrite;
    let markFirstWriteStarted;
    const firstWriteGate = new Promise((resolve) => {
      releaseFirstWrite = resolve;
    });
    const firstWriteStarted = new Promise((resolve) => {
      markFirstWriteStarted = resolve;
    });
    globalThis.game = {
      settings: {
        get(moduleId, key) {
          assert.equal(moduleId, "infinity-dnd5e");
          return key === "resourceRunState" ? stored : undefined;
        },
        async set(moduleId, key, value) {
          assert.equal(moduleId, "infinity-dnd5e");
          assert.equal(key, "resourceRunState");
          const snapshot = structuredClone(value);
          writes.push(snapshot);
          if (writes.length === 1) {
            markFirstWriteStarted();
            await firstWriteGate;
          }
          stored = snapshot;
          return value;
        },
      },
    };

    const dayWrite = setLastSeenDay(18);
    const environmentWrite = setCurrentEnvironment("  underdark  ");
    const report = { day: 18, shortages: 2 };
    const resultWrite = setLastUpkeepResult(report);
    report.day = 999;

    await firstWriteStarted;
    assert.equal(
      writes.length,
      1,
      "later patches do not read while the first write is unresolved",
    );
    releaseFirstWrite();
    assert.deepEqual(
      await Promise.all([dayWrite, environmentWrite, resultWrite]),
      [true, true, true],
    );
    assert.deepEqual(writes, [
      {
        version: RESOURCE_RUN_STATE_VERSION,
        revision: 1,
        authorityId: "node-test",
        authorityEpoch: "node-test:0",
        lastSeenDay: 18,
        currentEnvironmentId: null,
        lastUpkeepResult: null,
        activeUpkeep: null,
        recentRuns: [],
      },
      {
        version: RESOURCE_RUN_STATE_VERSION,
        revision: 2,
        authorityId: "node-test",
        authorityEpoch: "node-test:0",
        lastSeenDay: 18,
        currentEnvironmentId: "underdark",
        lastUpkeepResult: null,
        activeUpkeep: null,
        recentRuns: [],
      },
      {
        version: RESOURCE_RUN_STATE_VERSION,
        revision: 3,
        authorityId: "node-test",
        authorityEpoch: "node-test:0",
        lastSeenDay: 18,
        currentEnvironmentId: "underdark",
        lastUpkeepResult: { day: 18, shortages: 2 },
        activeUpkeep: null,
        recentRuns: [],
      },
    ]);
    assert.deepEqual(loadRunState(), normalizeRunState(writes[2]));
  } finally {
    resetResourceStoreForTests();
    if (originalGame === undefined) delete globalThis.game;
    else globalThis.game = originalGame;
  }
}

/* ------------------------------------------------------------------ *
 * Persisted upkeep claims reserve one writer across clients and atomically
 * close with the report. Calendar claims reserve the day before Actor writes.
 * ------------------------------------------------------------------ */
{
  const originalGame = globalThis.game;
  try {
    let stored = {
      lastSeenDay: 21,
      currentEnvironmentId: "road",
      lastUpkeepResult: null,
      activeUpkeep: null,
    };
    globalThis.game = {
      settings: {
        get(_moduleId, key) {
          return key === "resourceRunState" ? stored : undefined;
        },
        async set(_moduleId, key, value) {
          stored = structuredClone(value);
          return value;
        },
      },
    };

    await claimUpkeepRun({
      runId: "calendar-run",
      trigger: "calendar",
      day: 22,
      days: 1,
      claimedAt: 1234,
    });
    assert.equal(stored.lastSeenDay, 22, "the day is reserved with the claim");
    assert.deepEqual(stored.activeUpkeep, {
      runId: "calendar-run",
      trigger: "calendar",
      day: 22,
      days: 1,
      startedAt: 1234,
      claimedAt: 1234,
      authorityId: "node-test",
      authorityEpoch: "node-test:0",
      leadershipGeneration: 0,
      environment: null,
      initiator: null,
      actors: [],
      forageTarget: null,
      forageAssignments: [],
      forageDestination: null,
    });
    assert.equal(assertUpkeepClaimCurrent("calendar-run"), true);
    await assert.rejects(
      claimUpkeepRun({
        runId: "competing-run",
        trigger: "calendar",
        day: 22,
        claimedAt: 1235,
      }),
      /ResourceUpkeepAlreadyActive/,
      "a second run cannot replace the canonical lease",
    );
    const beforeInvalidReceipt = structuredClone(stored);
    await assert.rejects(
      completeUpkeepRun({ runId: "calendar-run", receipt: { runId: "bad" } }),
      /ResourceRunReceiptInvalid/,
    );
    assert.deepEqual(
      stored,
      beforeInvalidReceipt,
      "an invalid receipt cannot append history or release the lease",
    );

    const report = {
      runId: "calendar-run",
      trigger: "calendar",
      day: 22,
      days: 1,
      status: "complete",
      resourceSnapshot: [],
      perActor: [],
      party: {},
      suggestions: [],
    };
    const receipt = buildUpkeepRunReceipt({ result: report, recordedAt: 2500 });
    await completeUpkeepRun({ runId: "calendar-run", result: report, receipt });
    assert.equal(stored.activeUpkeep, null);
    assert.deepEqual(stored.lastUpkeepResult, report);
    assert.equal(stored.lastSeenDay, 22);
    assert.equal(stored.recentRuns.length, 1);
    assert.equal(stored.recentRuns[0].runId, "calendar-run");
    assert.equal(stored.recentRuns[0].claimedAt, 1234);

    await assert.rejects(
      claimUpkeepRun({
        runId: "delayed-calendar-run",
        trigger: "calendar",
        day: 22,
        claimedAt: 1900,
      }),
      /ResourceUpkeepCalendarDayReserved/,
      "a delayed second client cannot claim a day after the first run closes",
    );
    await assert.rejects(
      claimUpkeepRun({
        runId: "stale-calendar-run",
        trigger: "calendar",
        day: 21,
        claimedAt: 1950,
      }),
      /ResourceUpkeepCalendarDayReserved/,
      "an older calendar day cannot overwrite the reserved baseline",
    );
    assert.equal(stored.activeUpkeep, null);
    assert.equal(stored.lastSeenDay, 22);

    await claimUpkeepRun({
      runId: "manual-run",
      trigger: "manual",
      day: 99,
      claimedAt: 2000,
    });
    assert.equal(
      stored.lastSeenDay,
      22,
      "manual work never moves the calendar baseline",
    );
    await clearUpkeepClaim("manual-run", { recordedAt: 2800 });
    assert.equal(stored.activeUpkeep, null);
    assert.equal(stored.lastSeenDay, 22);
    assert.equal(stored.recentRuns.length, 2);
    assert.equal(stored.recentRuns[0].runId, "manual-run");
    assert.equal(stored.recentRuns[0].status, "interrupted");
    assert.equal(stored.recentRuns[0].outcomeUnknown, true);

    const latestReport = structuredClone(stored.lastUpkeepResult);
    await claimUpkeepRun({
      runId: "forage-run",
      trigger: "forage",
      day: 22,
      startedAt: 2900,
      claimedAt: 3000,
      environment: {
        id: "road",
        label: "Road",
        dc: 14,
        rawConfig: { forbidden: true },
      },
      initiator: { userId: "gm-a", name: "Morgan", role: 4 },
      actors: [
        { actorId: "actor-a", name: "Aria", document: { forbidden: true } },
      ],
      forageTarget: "food",
      forageDestination: {
        mode: "party-stash",
        actorId: "stash-a",
        name: "Party Mule",
        actor: { forbidden: true },
      },
    });
    const forageReceipt = buildForageRunReceipt({
      runId: "forage-run",
      day: 999,
      environment: { id: "road", label: "Road", dc: 14 },
      forageTarget: "food",
      totalFood: 3,
      recordedAt: 3100,
    });
    await completeUpkeepRun({
      runId: "forage-run",
      receipt: forageReceipt,
      persistResult: false,
    });
    assert.deepEqual(
      stored.lastUpkeepResult,
      latestReport,
      "forage history does not replace the latest upkeep report",
    );
    assert.equal(stored.recentRuns[0].runId, "forage-run");
    assert.equal(
      stored.recentRuns[0].day,
      22,
      "the canonical lease owns the day",
    );
    assert.deepEqual(stored.recentRuns[0].initiator, {
      userId: "gm-a",
      name: "Morgan",
    });
    assert.deepEqual(stored.recentRuns[0].forageContext, {
      target: "food",
      assignments: [],
      destination: {
        mode: "party-stash",
        actorId: "stash-a",
        name: "Party Mule",
      },
    });
    assert.equal(
      JSON.stringify(stored.recentRuns[0]).includes("forbidden"),
      false,
      "lease provenance stores only allowlisted plain data",
    );

    await claimUpkeepRun({
      runId: "manual-no-clock",
      trigger: "manual",
      day: null,
      claimedAt: 3200,
    });
    const manualFallbackResult = {
      runId: "manual-no-clock",
      trigger: "manual",
      day: 22,
      days: 1,
      status: "complete",
      resourceSnapshot: [],
      perActor: [],
      party: {},
      suggestions: [],
    };
    await completeUpkeepRun({
      runId: "manual-no-clock",
      result: manualFallbackResult,
      receipt: buildUpkeepRunReceipt({
        result: manualFallbackResult,
        recordedAt: 3300,
      }),
    });
    assert.equal(
      stored.recentRuns[0].day,
      22,
      "a no-clock manual lease retains the report's last-seen-day fallback",
    );
  } finally {
    resetResourceStoreForTests();
    if (originalGame === undefined) delete globalThis.game;
    else globalThis.game = originalGame;
  }
}

/* ------------------------------------------------------------------ *
 * A rejected patch does not poison the queue or leak its unsaved mutation.
 * ------------------------------------------------------------------ */
{
  const originalGame = globalThis.game;
  try {
    let stored = {
      lastSeenDay: 4,
      currentEnvironmentId: "road",
      lastUpkeepResult: { day: 4 },
    };
    let writeAttempts = 0;
    globalThis.game = {
      settings: {
        get(moduleId, key) {
          assert.equal(moduleId, "infinity-dnd5e");
          return key === "resourceRunState" ? stored : undefined;
        },
        async set(moduleId, key, value) {
          assert.equal(moduleId, "infinity-dnd5e");
          assert.equal(key, "resourceRunState");
          writeAttempts += 1;
          if (writeAttempts === 1) {
            throw new Error("synthetic run-state write failure");
          }
          stored = structuredClone(value);
          return value;
        },
      },
    };

    const failed = setLastSeenDay(20);
    const recoveredEnvironment = setCurrentEnvironment("forest");
    const recoveredResult = setLastUpkeepResult({ day: 5, shortages: 0 });
    await assert.rejects(failed, /synthetic run-state write failure/);
    assert.deepEqual(
      await Promise.all([recoveredEnvironment, recoveredResult]),
      [true, true],
    );
    assert.equal(writeAttempts, 3);
    assert.deepEqual(loadRunState(), {
      lastSeenDay: 4,
      currentEnvironmentId: "forest",
      lastUpkeepResult: { day: 5, shortages: 0 },
      activeUpkeep: null,
      recentRuns: [],
    });
  } finally {
    if (originalGame === undefined) delete globalThis.game;
    else globalThis.game = originalGame;
  }
}

/* ------------------------------------------------------------------ *
 * Dormant v5 operation adapter: exact-version gating, queued CAS, canonical
 * readback, full-record FIFO backlog, and idempotent guard fencing.
 * ------------------------------------------------------------------ */
{
  const originalGame = globalThis.game;
  try {
    resetResourceStoreForTests();
    const environment = {
      id: "forest",
      label: "Forest",
      dc: 12,
      foodDc: 12,
      waterDc: 10,
    };
    const context = createResourceOperationContext({
      rules: { forageMode: "each", waterEnabled: true },
      roster: [{ actorId: "actor-1", drawFromId: "actor-1" }],
    });
    let stored = {
      version: RESOURCE_RUN_STATE_VERSION,
      revision: 0,
      authorityId: "node-test",
      authorityEpoch: "node-test:0",
      lastSeenDay: null,
      currentEnvironmentId: null,
      lastUpkeepResult: null,
      activeUpkeep: null,
      recentRuns: [],
    };
    let readCount = 0;
    let driftAtRead = null;
    let throwAfterApply = false;
    const writes = [];
    globalThis.game = {
      settings: {
        get(moduleId, key) {
          assert.equal(moduleId, "infinity-dnd5e");
          if (key !== "resourceRunState") return undefined;
          readCount += 1;
          if (readCount === driftAtRead) {
            driftAtRead = null;
            stored = {
              ...stored,
              revision: stored.revision + 1,
              currentEnvironmentId: "concurrent-drift",
            };
          }
          return stored;
        },
        async set(moduleId, key, value) {
          assert.equal(moduleId, "infinity-dnd5e");
          assert.equal(key, "resourceRunState");
          const next = structuredClone(value);
          writes.push(next);
          stored = next;
          if (throwAfterApply) {
            throwAfterApply = false;
            throw new Error("synthetic apply-then-throw");
          }
          return value;
        },
      },
    };

    const adapter = createResourceOperationStoreV5Adapter();
    assert.deepEqual(Object.keys(adapter), [
      "currentGuard",
      "claimResourceOperation",
      "loadActiveResourceOperation",
      "transitionResourceOperation",
      "recordResourcePromptResponse",
      "recordResourcePromptTimeout",
      "markResourceInventoryOperationApplied",
      "adoptResourceOperationAuthority",
      "assertResourceOperationCurrent",
      "completeResourceOperation",
      "listPendingResourceDeliveries",
      "markResourceOperationDeliveryDelivered",
      "ensureResourceOperationAuthority",
    ]);

    await assert.rejects(
      adapter.loadActiveResourceOperation(),
      (error) =>
        error?.code === "RESOURCE_RUN_STATE_V5_ADAPTER_INACTIVE" &&
        error.zeroWrite === true,
    );
    assert.equal(writes.length, 0, "current v4 is never migrated implicitly");

    stored = {
      ...createEmptyResourceRunStateV5({
        authorityId: "node-test",
        authorityEpoch: "node-test:0",
      }),
      version: 6,
    };
    await assert.rejects(
      adapter.listPendingResourceDeliveries(),
      (error) => error?.zeroWrite === true,
    );
    stored = {
      ...createEmptyResourceRunStateV5({
        authorityId: "node-test",
        authorityEpoch: "node-test:0",
      }),
      unexpected: true,
    };
    await assert.rejects(
      adapter.loadActiveResourceOperation(),
      (error) => error?.zeroWrite === true,
    );
    assert.equal(
      writes.length,
      0,
      "future and corrupt v5 states are zero-write",
    );

    stored = createEmptyResourceRunStateV5({
      authorityId: "node-test",
      authorityEpoch: "node-test:0",
    });
    assert.equal(
      (await adapter.ensureResourceOperationAuthority()).revision,
      0,
    );
    assert.equal(writes.length, 0, "current authority ensure is a no-op");

    const operationInput = (id, createdAt) => ({
      operationId: id,
      runId: id,
      trigger: "manual",
      context,
      day: 50,
      days: 1,
      environment,
      initiator: { userId: "gm-1", name: "GM" },
      actors: [
        {
          actorId: "actor-1",
          name: "Ranger",
          role: "participant",
          forageTarget: null,
        },
      ],
      createdAt,
    });
    const terminalRecord = (record, at) => {
      const report = {
        version: 1,
        runId: record.runId,
        trigger: record.trigger,
        day: record.day,
        days: record.days,
        status: "complete",
      };
      const receipt = buildUpkeepRunReceipt({
        result: {
          runId: record.runId,
          trigger: record.trigger,
          day: record.day,
          days: record.days,
          startedAt: record.timestamps.createdAt,
          resourceSnapshot: [],
          perActor: [],
          party: {},
          suggestions: [],
          hasErrors: false,
        },
        environment,
        recordedAt: at,
      });
      return {
        report,
        receipt,
        terminal: transitionResourceOperation(record, "terminal", {
          guard: record.guard,
          at,
          report,
          receipt,
          deliveries: createResourceTerminalDeliveries(record, { report }),
        }),
      };
    };

    const claimed = await adapter.claimResourceOperation(
      operationInput("adapter-run-1", 100),
    );
    assert.equal(claimed.phase, "prepared");
    assert.equal(stored.revision, 1);
    assert.deepEqual(claimed.guard, {
      authorityId: "node-test",
      authorityEpoch: "node-test:0",
      leadershipGeneration: 0,
    });
    const inventory = createResourceInventoryOperation({
      runId: claimed.runId,
      sequence: 0,
      action: "update",
      actorId: "actor-1",
      itemId: "item-1",
      resourceId: "food",
      beforeQuantity: 2,
      afterQuantity: 1,
    });
    const planned = await adapter.transitionResourceOperation(
      claimed.runId,
      "planned",
      {
        guard: claimed.guard,
        at: 110,
        yields: [],
        operations: [inventory],
      },
    );
    const applying = await adapter.transitionResourceOperation(
      claimed.runId,
      "applying",
      { guard: claimed.guard, at: 111 },
    );
    const marked = await adapter.markResourceInventoryOperationApplied(
      claimed.runId,
      inventory.opId,
      {
        guard: claimed.guard,
        at: 112,
        observed: { exists: true, quantity: 1, matchesResource: true },
      },
    );
    assert.deepEqual(marked.appliedOperationIds, [inventory.opId]);
    const writesBeforeIdempotent = writes.length;
    const markedAgain = await adapter.markResourceInventoryOperationApplied(
      claimed.runId,
      inventory.opId,
      {
        guard: claimed.guard,
        at: 113,
        observed: { exists: true, quantity: 1, matchesResource: true },
      },
    );
    assert.deepEqual(markedAgain, marked);
    assert.equal(writes.length, writesBeforeIdempotent);
    await assert.rejects(
      adapter.transitionResourceOperation(claimed.runId, "applying", {
        guard: { ...claimed.guard, leadershipGeneration: 1 },
        at: 114,
      }),
      (error) => error?.code === "RESOURCE_RUN_STATE_V5_FENCE_LOST",
    );
    assert.equal(
      writes.length,
      writesBeforeIdempotent,
      "a stale guard cannot pass through a same-phase no-op",
    );

    const firstArtifacts = terminalRecord(marked, 120);
    const firstTerminal = await adapter.completeResourceOperation({
      operationId: claimed.operationId,
      runId: claimed.runId,
      guard: claimed.guard,
      at: 120,
      terminalRecord: firstArtifacts.terminal,
      result: firstArtifacts.report,
      receipt: firstArtifacts.receipt,
    });
    assert.equal(firstTerminal.phase, "terminal");
    assert.equal(stored.activeOperation, null);

    const second = await adapter.claimResourceOperation({
      ...operationInput("adapter-run-2", 200),
      actors: [
        {
          actorId: "actor-1",
          name: "Ranger",
          role: "participant",
          forageTarget: "food",
        },
      ],
    });
    await adapter.transitionResourceOperation(second.runId, "prompting", {
      guard: second.guard,
      at: 205,
      assignments: [
        {
          promptId: "adapter-prompt-2",
          actorId: "actor-1",
          userId: "player-1",
          forageTarget: "food",
          dc: 12,
          foodDc: 12,
          waterDc: 10,
          assignedAt: 205,
          deadlineAt: 209,
        },
      ],
    });
    const secondTimedOut = await adapter.recordResourcePromptTimeout(
      second.runId,
      "adapter-prompt-2",
      { guard: second.guard, at: 209 },
    );
    const writesBeforeDuplicateTimeout = writes.length;
    await assert.rejects(
      adapter.recordResourcePromptTimeout(second.runId, "adapter-prompt-2", {
        guard: { ...second.guard, leadershipGeneration: 1 },
        at: 999,
      }),
      (error) => error?.code === "RESOURCE_RUN_STATE_V5_FENCE_LOST",
    );
    assert.equal(writes.length, writesBeforeDuplicateTimeout);
    assert.equal(secondTimedOut.prompts.timeouts.length, 1);
    const secondPlanned = await adapter.transitionResourceOperation(
      second.runId,
      "planned",
      {
        guard: second.guard,
        at: 210,
        yields: [
          {
            actorId: "actor-1",
            forageTarget: "food",
            rollTotal: null,
            wisMod: null,
            food: 0,
            water: 0,
            foodSuccess: false,
            waterSuccess: false,
            suppressedFood: false,
            suppressedWater: false,
          },
        ],
        operations: [],
      },
    );
    const secondArtifacts = terminalRecord(secondPlanned, 220);
    await adapter.completeResourceOperation({
      operationId: second.operationId,
      runId: second.runId,
      guard: second.guard,
      at: 220,
      terminalRecord: secondArtifacts.terminal,
      result: secondArtifacts.report,
      receipt: secondArtifacts.receipt,
    });
    const backlog = await adapter.listPendingResourceDeliveries();
    assert.deepEqual(
      backlog.map((record) => record.runId),
      [claimed.runId, second.runId],
      "the adapter returns full terminal records in completion FIFO order",
    );
    assert.equal(backlog[0].phase, "terminal");
    assert.ok(backlog[0].outbox.entries.length > 0);
    const writesBeforeLaterHead = writes.length;
    await assert.rejects(
      adapter.adoptResourceOperationAuthority({
        location: "outbox",
        operationId: second.operationId,
        runId: second.runId,
        nextGuard: second.guard,
        at: 221,
      }),
      (error) => error?.code === "RESOURCE_RUN_STATE_V5_FIFO_CONFLICT",
    );
    const laterDelivery = backlog[1].outbox.entries[0];
    const laterUpdated = markResourceDeliveryDelivered(
      backlog[1],
      laterDelivery.deliveryId,
      { guard: second.guard, at: 222, confirmed: true },
    );
    await assert.rejects(
      adapter.markResourceOperationDeliveryDelivered({
        operationId: second.operationId,
        runId: second.runId,
        deliveryId: laterDelivery.deliveryId,
        guard: second.guard,
        updatedRecord: laterUpdated,
      }),
      (error) => error?.code === "RESOURCE_RUN_STATE_V5_FIFO_CONFLICT",
    );
    assert.equal(writes.length, writesBeforeLaterHead);

    const firstDelivery = backlog[0].outbox.entries[0];
    const firstUpdated = markResourceDeliveryDelivered(
      backlog[0],
      firstDelivery.deliveryId,
      { guard: claimed.guard, at: 223, confirmed: true },
    );
    await adapter.markResourceOperationDeliveryDelivered({
      operationId: claimed.operationId,
      runId: claimed.runId,
      deliveryId: firstDelivery.deliveryId,
      guard: claimed.guard,
      updatedRecord: firstUpdated,
    });
    assert.deepEqual(
      (await adapter.listPendingResourceDeliveries()).map(
        (record) => record.runId,
      ),
      [second.runId],
    );

    const head = (await adapter.listPendingResourceDeliveries())[0];
    const headDelivery = head.outbox.entries.find(
      (entry) => entry.state === "pending",
    );
    const headUpdated = markResourceDeliveryDelivered(
      head,
      headDelivery.deliveryId,
      { guard: second.guard, at: 224, confirmed: true },
    );
    throwAfterApply = true;
    const acceptedAfterThrow =
      await adapter.markResourceOperationDeliveryDelivered({
        operationId: second.operationId,
        runId: second.runId,
        deliveryId: headDelivery.deliveryId,
        guard: second.guard,
        updatedRecord: headUpdated,
      });
    assert.deepEqual(acceptedAfterThrow, headUpdated);
    const retainedAfterReport = (
      await adapter.listPendingResourceDeliveries()
    )[0];
    assert.deepEqual(retainedAfterReport, headUpdated);
    const acknowledgement = retainedAfterReport.outbox.entries.find(
      (entry) => entry.state === "pending",
    );
    assert.equal(acknowledgement.kind, "prompt-ack");
    const allDelivered = markResourceDeliveryDelivered(
      retainedAfterReport,
      acknowledgement.deliveryId,
      { guard: second.guard, at: 225, confirmed: true },
    );
    const writesBeforeDeliveredReplay = writes.length;
    const replayedReport = await adapter.markResourceOperationDeliveryDelivered(
      {
        operationId: second.operationId,
        runId: second.runId,
        deliveryId: headDelivery.deliveryId,
        guard: second.guard,
        updatedRecord: allDelivered,
      },
    );
    assert.deepEqual(
      replayedReport,
      retainedAfterReport,
      "a delivered replay returns the authoritative retained head",
    );
    assert.equal(writes.length, writesBeforeDeliveredReplay);
    assert.equal(
      (await adapter.listPendingResourceDeliveries())[0].outbox.entries[1]
        .state,
      "pending",
      "a replay cannot falsely report a later delivery as persisted",
    );
    const finalDelivery = await adapter.markResourceOperationDeliveryDelivered({
      operationId: second.operationId,
      runId: second.runId,
      deliveryId: acknowledgement.deliveryId,
      guard: second.guard,
      updatedRecord: allDelivered,
    });
    assert.deepEqual(finalDelivery, allDelivered);
    assert.deepEqual(await adapter.listPendingResourceDeliveries(), []);

    const writesBeforeCas = writes.length;
    driftAtRead = readCount + 3;
    await assert.rejects(
      adapter.claimResourceOperation(operationInput("cas-loser", 300)),
      (error) =>
        error?.code === "RESOURCE_RUN_STATE_V5_WRITE_REJECTED" &&
        error.zeroWrite === true,
    );
    assert.equal(
      writes.length,
      writesBeforeCas,
      "a failed exact CAS performs no adapter write",
    );
    assert.equal(stored.currentEnvironmentId, "concurrent-drift");
    const recovered = await adapter.claimResourceOperation(
      operationInput("cas-recovered", 301),
    );
    assert.equal(recovered.runId, "cas-recovered");
    assert.equal(stored.revision, normalizeResourceRunStateV5(stored).revision);
    assert.equal(planned.phase, "planned");
    assert.equal(applying.phase, "applying");
  } finally {
    resetResourceStoreForTests();
    if (originalGame === undefined) delete globalThis.game;
    else globalThis.game = originalGame;
  }
}

/* ------------------------------------------------------------------ *
 * Live v5 adapter authority generations: explicit empty rebind, known-applied
 * stale write recovery, queued zero-write rejection, and active/outbox adoption.
 * ------------------------------------------------------------------ */
{
  const originalGame = globalThis.game;
  const originalJournalEntry = globalThis.JournalEntry;
  const originalHooks = globalThis.Hooks;
  const originalConst = globalThis.CONST;
  const leadershipState = { active: true, generation: 1 };
  let ensureLeadershipCalls = 0;
  const leadership = {
    ensureLeadership() {
      ensureLeadershipCalls += 1;
      return leadershipState.active;
    },
    hasLeadership() {
      return leadershipState.active;
    },
    getStatus() {
      return {
        state: leadershipState.active ? "leader" : "waiting",
        leader: leadershipState.active,
        generation: leadershipState.generation,
      };
    },
  };
  try {
    resetPrivateStateForTests();
    resetResourceStoreForTests({ leadership });
    let nextHookId = 0;
    const listeners = new Map();
    globalThis.Hooks = {
      on(event, handler) {
        const id = ++nextHookId;
        if (!listeners.has(event)) listeners.set(event, new Map());
        listeners.get(event).set(id, handler);
        return id;
      },
      off(event, id) {
        listeners.get(event)?.delete(id);
      },
      call(event, ...args) {
        for (const handler of listeners.get(event)?.values() ?? []) {
          handler(...args);
        }
      },
    };
    globalThis.CONST = {
      DOCUMENT_OWNERSHIP_LEVELS: { NONE: 0 },
      USER_ROLES: { GAMEMASTER: 4 },
    };

    const environment = {
      id: "forest",
      label: "Forest",
      dc: 12,
      foodDc: 12,
      waterDc: 10,
    };
    const contextSnapshot = {
      rules: { forageMode: "each", waterEnabled: true },
      roster: [{ actorId: "actor-live", drawFromId: "actor-live" }],
    };
    const context = createResourceOperationContext(contextSnapshot);
    const flags = {
      privateStateStore: true,
      schemaVersion: 2,
      merchants: [],
      factions: [],
      resourceConfig: serializeResourceConfig(createDefaultResourceConfig()),
      resourceRunState: createEmptyResourceRunStateV5({
        authorityId: "bootstrap-gm",
        authorityEpoch: "bootstrap-epoch",
      }),
      criticalInjuryWorkflow: {},
      criticalInjuryWorkflowCheckpoint: {},
    };
    let blockedRunStateWrite = null;
    let throwAfterRunStateApply = false;
    const store = {
      id: "resource-v5-live-store",
      ownership: { default: 0 },
      updateCalls: [],
      getFlag(scope, key) {
        return scope === "infinity-dnd5e" ? flags[key] : undefined;
      },
      async update(changes) {
        this.updateCalls.push(structuredClone(changes));
        if (
          blockedRunStateWrite &&
          Object.hasOwn(changes, "flags.infinity-dnd5e.resourceRunState")
        ) {
          const blocked = blockedRunStateWrite;
          blockedRunStateWrite = null;
          blocked.markStarted();
          await blocked.wait;
        }
        for (const [path, value] of Object.entries(changes)) {
          const match = /^flags\.infinity-dnd5e\.(.+)$/.exec(path);
          if (match) flags[match[1]] = structuredClone(value);
        }
        globalThis.Hooks.call("updateJournalEntry", this, changes);
        if (
          throwAfterRunStateApply &&
          Object.hasOwn(changes, "flags.infinity-dnd5e.resourceRunState")
        ) {
          throwAfterRunStateApply = false;
          throw new Error("synthetic live apply-then-throw");
        }
        return this;
      },
      blockNextRunStateWrite() {
        let release;
        let markStarted;
        const wait = new Promise((resolve) => {
          release = resolve;
        });
        const started = new Promise((resolve) => {
          markStarted = resolve;
        });
        blockedRunStateWrite = { wait, markStarted };
        return { release, started };
      },
    };
    const settingValues = new Map();
    const gm = { id: "gm-live", isGM: true, role: 4, active: true };
    globalThis.game = {
      ready: true,
      user: gm,
      users: { activeGM: gm },
      journal: {
        find(predicate) {
          return predicate(store) ? store : null;
        },
      },
      settings: {
        get(_moduleId, key) {
          if (key === "privateStateStoreId") return store.id;
          if (key === "merchants" || key === "factions") return [];
          return settingValues.get(key) ?? {};
        },
        async set(_moduleId, key, value) {
          settingValues.set(key, structuredClone(value));
          return value;
        },
      },
    };
    globalThis.JournalEntry = {
      async create() {
        throw new Error("existing v5 private store should be reused");
      },
    };

    await initializePrivateState();
    const initialAuthority = observeResourceAuthorityTransition();
    const initialGuard = {
      authorityId: gm.id,
      authorityEpoch: initialAuthority.authorityEpoch,
      leadershipGeneration: leadershipState.generation,
    };
    await setPrivateState(
      "resourceRunState",
      createEmptyResourceRunStateV5({
        authorityId: initialGuard.authorityId,
        authorityEpoch: initialGuard.authorityEpoch,
      }),
    );
    store.updateCalls.length = 0;

    const adapter = createResourceOperationStoreV5Adapter();
    assert.deepEqual(await adapter.currentGuard(), initialGuard);
    assert.equal(
      (await adapter.ensureResourceOperationAuthority()).revision,
      0,
    );
    assert.equal(store.updateCalls.length, 0);

    leadershipState.active = false;
    observeResourceAuthorityTransition();
    leadershipState.active = true;
    leadershipState.generation = 2;
    const secondAuthority = observeResourceAuthorityTransition();
    const secondGuard = {
      authorityId: gm.id,
      authorityEpoch: secondAuthority.authorityEpoch,
      leadershipGeneration: 2,
    };
    assert.deepEqual(await adapter.currentGuard(), secondGuard);
    throwAfterRunStateApply = true;
    const rebound = await adapter.ensureResourceOperationAuthority();
    assert.equal(rebound.revision, 1);
    assert.equal(
      flags.resourceRunState.authorityEpoch,
      secondGuard.authorityEpoch,
    );
    assert.equal(
      store.updateCalls.length,
      1,
      "an exact apply-then-throw rebind is accepted once",
    );

    const operationInput = (id, createdAt) => ({
      operationId: id,
      runId: id,
      trigger: "manual",
      context,
      day: 60,
      days: 1,
      environment,
      initiator: { userId: gm.id, name: "Live GM" },
      actors: [
        {
          actorId: "actor-live",
          name: "Ranger",
          role: "participant",
          forageTarget: null,
        },
      ],
      createdAt,
    });
    const writesBeforeBlocked = store.updateCalls.length;
    const blocked = store.blockNextRunStateWrite();
    const firstClaim = adapter.claimResourceOperation(
      operationInput("live-run", 1000),
    );
    await blocked.started;
    const ensureCallsBeforeQueued = ensureLeadershipCalls;
    const queuedClaim = adapter.claimResourceOperation(
      operationInput("queued-old-generation", 1001),
    );
    while (ensureLeadershipCalls === ensureCallsBeforeQueued) {
      await Promise.resolve();
    }
    await Promise.resolve();
    leadershipState.active = false;
    observeResourceAuthorityTransition();
    blocked.release();
    await assert.rejects(
      firstClaim,
      (error) =>
        error?.code === "RESOURCE_RUN_STATE_V5_AUTHORITY_LOST_AFTER_WRITE" &&
        error.zeroWrite === false &&
        error.writeApplied === true &&
        error.outcomeUnknown !== true,
    );
    await assert.rejects(
      queuedClaim,
      (error) =>
        error?.code === "RESOURCE_RUN_STATE_V5_AUTHORITY_CHANGED" &&
        error.zeroWrite === true,
    );
    assert.equal(
      store.updateCalls.length,
      writesBeforeBlocked + 1,
      "queued work from the retired generation performs no Journal write",
    );
    assert.equal(flags.resourceRunState.activeOperation.runId, "live-run");

    leadershipState.active = true;
    leadershipState.generation = 3;
    const thirdAuthority = observeResourceAuthorityTransition();
    const thirdGuard = {
      authorityId: gm.id,
      authorityEpoch: thirdAuthority.authorityEpoch,
      leadershipGeneration: 3,
    };
    assert.deepEqual(await adapter.currentGuard(), thirdGuard);
    const adoptedActive = await adapter.adoptResourceOperationAuthority({
      location: "active",
      operationId: "live-run",
      runId: "live-run",
      nextGuard: thirdGuard,
      contextSnapshot,
      observations: [],
      at: 1010,
    });
    assert.deepEqual(adoptedActive.guard, thirdGuard);
    assert.equal(
      flags.resourceRunState.authorityEpoch,
      thirdGuard.authorityEpoch,
    );

    const planned = await adapter.transitionResourceOperation(
      "live-run",
      "planned",
      { guard: thirdGuard, at: 1020, yields: [], operations: [] },
    );
    const report = {
      version: 1,
      runId: planned.runId,
      trigger: planned.trigger,
      day: planned.day,
      days: planned.days,
      status: "complete",
    };
    const receipt = buildUpkeepRunReceipt({
      result: {
        runId: planned.runId,
        trigger: planned.trigger,
        day: planned.day,
        days: planned.days,
        startedAt: planned.timestamps.createdAt,
        resourceSnapshot: [],
        perActor: [],
        party: {},
        suggestions: [],
        hasErrors: false,
      },
      environment,
      recordedAt: 1030,
    });
    const terminal = transitionResourceOperation(planned, "terminal", {
      guard: thirdGuard,
      at: 1030,
      report,
      receipt,
      deliveries: createResourceTerminalDeliveries(planned, { report }),
    });
    await adapter.completeResourceOperation({
      operationId: planned.operationId,
      runId: planned.runId,
      guard: thirdGuard,
      at: 1030,
      terminalRecord: terminal,
      result: report,
      receipt,
    });

    leadershipState.active = false;
    observeResourceAuthorityTransition();
    leadershipState.active = true;
    leadershipState.generation = 4;
    const fourthAuthority = observeResourceAuthorityTransition();
    const fourthGuard = {
      authorityId: gm.id,
      authorityEpoch: fourthAuthority.authorityEpoch,
      leadershipGeneration: 4,
    };
    const adoptedOutbox = await adapter.adoptResourceOperationAuthority({
      location: "outbox",
      operationId: terminal.operationId,
      runId: terminal.runId,
      nextGuard: fourthGuard,
      at: 1040,
    });
    assert.deepEqual(adoptedOutbox.guard, fourthGuard);
    assert.equal(
      (await adapter.listPendingResourceDeliveries())[0].runId,
      "live-run",
    );

    const conflict = await adapter.claimResourceOperation(
      operationInput("adoption-conflict", 1100),
    );
    const conflictInventory = createResourceInventoryOperation({
      runId: conflict.runId,
      sequence: 0,
      action: "update",
      actorId: "actor-live",
      itemId: "item-live",
      resourceId: "food",
      beforeQuantity: 2,
      afterQuantity: 1,
    });
    await adapter.transitionResourceOperation(conflict.runId, "planned", {
      guard: fourthGuard,
      at: 1110,
      yields: [],
      operations: [conflictInventory],
    });
    await adapter.transitionResourceOperation(conflict.runId, "applying", {
      guard: fourthGuard,
      at: 1120,
    });
    assert.equal(
      adapter.assertResourceOperationCurrent(conflict.runId, fourthGuard),
      true,
    );

    leadershipState.active = false;
    observeResourceAuthorityTransition();
    leadershipState.active = true;
    leadershipState.generation = 5;
    const fifthAuthority = observeResourceAuthorityTransition();
    const fifthGuard = {
      authorityId: gm.id,
      authorityEpoch: fifthAuthority.authorityEpoch,
      leadershipGeneration: 5,
    };
    const needsReview = await adapter.adoptResourceOperationAuthority({
      location: "active",
      operationId: conflict.operationId,
      runId: conflict.runId,
      nextGuard: fifthGuard,
      contextSnapshot,
      observations: [
        {
          actorId: "actor-live",
          itemId: "item-live",
          exists: true,
          quantity: 999,
          matchesResource: true,
        },
      ],
      at: 1130,
    });
    assert.deepEqual(needsReview, {
      action: "needs-review",
      reason: "Canonical inventory does not match a safe authority checkpoint",
      operationId: conflictInventory.opId,
      runId: conflict.runId,
    });
    assert.equal(flags.resourceRunState.activeOperation.phase, "needs-review");
    assert.equal(
      flags.resourceRunState.activeOperation.review.code,
      "RESOURCE_OPERATION_ADOPTION_CONFLICT",
    );
    assert.deepEqual(await adapter.currentGuard(), fifthGuard);

    leadershipState.active = false;
    observeResourceAuthorityTransition();
    const writesBeforeFollower = store.updateCalls.length;
    await assert.rejects(
      adapter.currentGuard(),
      (error) => error?.code === "RESOURCE_CAMPAIGN_AUTHORITY_UNAVAILABLE",
    );
    await assert.rejects(
      adapter.ensureResourceOperationAuthority(),
      (error) => error?.code === "RESOURCE_CAMPAIGN_AUTHORITY_UNAVAILABLE",
    );
    assert.equal(store.updateCalls.length, writesBeforeFollower);
  } finally {
    resetResourceStoreForTests();
    resetPrivateStateForTests();
    if (originalGame === undefined) delete globalThis.game;
    else globalThis.game = originalGame;
    if (originalJournalEntry === undefined) delete globalThis.JournalEntry;
    else globalThis.JournalEntry = originalJournalEntry;
    if (originalHooks === undefined) delete globalThis.Hooks;
    else globalThis.Hooks = originalHooks;
    if (originalConst === undefined) delete globalThis.CONST;
    else globalThis.CONST = originalConst;
  }
}

process.stdout.write("resource-store validation passed\n");
