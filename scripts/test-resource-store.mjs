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
  resetResourceStoreForTests,
} from "./resource/store.js";
import {
  initializePrivateState,
  resetPrivateStateForTests,
} from "./private-state.js";

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
    flagTag: "",
    itemUuids: [],
  });
  assert.equal(r.forageYields, null);

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
  assert.equal(RESOURCE_CONFIG_VERSION, 3, "current structural schema is v3");
  assert.equal(cfg.forageMode, "each");
  assert.equal(cfg.halfRations, false);
  assert.equal(cfg.waterEnabled, true);
  assert.equal(cfg.maxCatchUpDays, 7);
  assert.ok(cfg.resources.length >= 3, "seeds food/water/light");
  assert.ok(cfg.environments.length >= 3, "seeds environments");
  assert.deepEqual(
    cfg.resources.find((resource) => resource.id === "food")?.matching
      ?.nameKeywords,
    ["rations", "trail ration", "food"],
    "fresh food defaults do not claim the water phrase 'water ration'",
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
    ["rations", "trail ration", "food"],
    "the exact v2 food default is repaired during normalization",
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

  const live = normalizeRunState({
    lastSeenDay: 12.9,
    currentEnvironmentId: " limited ",
    lastUpkeepResult: { day: 12 },
  });
  assert.equal(live.lastSeenDay, 12, "floored");
  assert.equal(live.currentEnvironmentId, "limited", "trimmed");
  assert.deepEqual(live.lastUpkeepResult, { day: 12 });

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
            return { forageMode: "best", waterEnabled: false };
          return undefined;
        },
      },
    };
    const cfg = loadResourceConfig();
    assert.equal(cfg.forageMode, "best");
    assert.equal(cfg.waterEnabled, false);
    assert.ok(cfg.resources.length >= 3, "still seeds resources");
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
    };
    const writes = [];
    let stored = raw;
    let storedRunState;
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
    assert.equal(writes[5].key, "resourceRunState");
    assert.equal(
      writes[5].value.version,
      RESOURCE_RUN_STATE_VERSION,
      "migration versions the persisted run state",
    );
    assert.equal(writes[5].value.authorityId, "gm-a");
    assert.match(writes[5].value.authorityEpoch, /^node-test:/);
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
      ["rations", "trail ration", "food"],
      "v2 worlds persist the collision-free food matcher",
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
      ready: true,
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
      /PrivateStateUnavailable/,
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
      getFlag(scope, key) {
        return scope === "infinity-dnd5e" ? flags[key] : undefined;
      },
      async update(changes) {
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
    flags.schemaVersion = 1;
    assert.equal(
      isResourceAutomationReady(),
      false,
      "an old private-store schema cannot satisfy automation readiness",
    );
    flags.schemaVersion = 2;
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
      },
      {
        version: RESOURCE_RUN_STATE_VERSION,
        revision: 2,
        authorityId: "node-test",
        authorityEpoch: "node-test:0",
        lastSeenDay: 18,
        currentEnvironmentId: "underdark",
        lastUpkeepResult: null,
      },
      {
        version: RESOURCE_RUN_STATE_VERSION,
        revision: 3,
        authorityId: "node-test",
        authorityEpoch: "node-test:0",
        lastSeenDay: 18,
        currentEnvironmentId: "underdark",
        lastUpkeepResult: { day: 18, shortages: 2 },
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
    });
  } finally {
    if (originalGame === undefined) delete globalThis.game;
    else globalThis.game = originalGame;
  }
}

process.stdout.write("resource-store validation passed\n");
