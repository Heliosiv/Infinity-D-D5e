import assert from "node:assert/strict";

import {
  PRIVATE_STATE_CHANGED_HOOK,
  getPrivateState,
  initializePrivateState,
  isPrivateStateReady,
  isPrivilegedPrivateStateReady,
  onPrivateStateChanged,
  resetPrivateStateForTests,
  setPrivateState,
} from "./private-state.js";
import { saveMerchants } from "./merchant/store.js";
import { saveFactions } from "./reputation/store.js";

const MODULE_ID = "infinity-dnd5e";
const saved = {
  game: globalThis.game,
  Hooks: globalThis.Hooks,
  JournalEntry: globalThis.JournalEntry,
  CONST: globalThis.CONST,
};

function makeHooks() {
  let nextId = 0;
  const listeners = new Map();
  return {
    on(event, handler) {
      const id = ++nextId;
      if (!listeners.has(event)) listeners.set(event, new Map());
      listeners.get(event).set(id, handler);
      return id;
    },
    off(event, id) {
      listeners.get(event)?.delete(id);
    },
    listenerCount(event) {
      return listeners.get(event)?.size ?? 0;
    },
    call(event, ...args) {
      for (const handler of listeners.get(event)?.values() ?? []) {
        handler(...args);
      }
    },
  };
}

let documentSeed = 0;
function makeDocument(data) {
  const createdTime = ++documentSeed;
  const flags = structuredClone(data.flags ?? {});
  const ignoredUpdatePaths = new Set();
  const document = {
    id: `journal-${createdTime}`,
    _stats: { createdTime },
    name: data.name,
    ownership: structuredClone(data.ownership),
    getFlag: (scope, key) => flags[scope]?.[key],
    ignoreNextUpdate(path) {
      ignoredUpdatePaths.add(path);
    },
    async update(changes) {
      for (const [path, value] of Object.entries(changes)) {
        if (ignoredUpdatePaths.delete(path)) continue;
        if (path === "ownership") {
          this.ownership = structuredClone(value);
          continue;
        }
        const match = /^flags\.infinity-dnd5e\.(.+)$/.exec(path);
        if (match) flags[MODULE_ID][match[1]] = structuredClone(value);
      }
      globalThis.Hooks.call("updateJournalEntry", this, changes);
      return this;
    },
  };
  return document;
}

function makeJournal() {
  const entries = [];
  return {
    entries,
    collection: {
      find: (predicate) => entries.find(predicate) ?? null,
      forEach: (callback) => entries.forEach(callback),
    },
    insert(data, { createdTime = null } = {}) {
      const document = makeDocument(data);
      if (createdTime !== null) document._stats.createdTime = createdTime;
      entries.push(document);
      globalThis.Hooks.call("createJournalEntry", document);
      return document;
    },
    remove(document) {
      const index = entries.indexOf(document);
      if (index >= 0) entries.splice(index, 1);
      globalThis.Hooks.call("deleteJournalEntry", document);
    },
  };
}

function makeUsers(activeGmId, definitions) {
  const users = new Map(definitions.map((user) => [user.id, user]));
  return {
    activeGM: users.get(activeGmId) ?? null,
    get: (id) => users.get(id) ?? null,
    forEach: (callback) => users.forEach(callback),
  };
}

async function captureConsole(method, operation) {
  const original = console[method];
  const messages = [];
  console[method] = (...args) => messages.push(args);
  try {
    return { result: await operation(), messages };
  } finally {
    console[method] = original;
  }
}

async function waitFor(predicate, message) {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (predicate()) return;
    await new Promise((resolve) => globalThis.setTimeout(resolve, 0));
  }
  assert.fail(message);
}

function makeStoreData({
  schemaVersion = 2,
  merchants = [],
  factions = [],
  resourceConfig = {},
  resourceRunState = {},
} = {}) {
  return {
    name: "[Infinity D&D5e] Private State",
    ownership: { default: 0 },
    flags: {
      [MODULE_ID]: {
        privateStateStore: true,
        schemaVersion,
        merchants,
        factions,
        resourceConfig,
        resourceRunState,
      },
    },
  };
}

function configureGame({
  user,
  users,
  journal,
  legacy = {
    merchants: [],
    factions: [],
    resourceConfig: {},
    resourceRunState: {},
    privateStateStoreId: "",
  },
}) {
  if (!Object.hasOwn(legacy, "merchants")) legacy.merchants = [];
  if (!Object.hasOwn(legacy, "factions")) legacy.factions = [];
  if (!Object.hasOwn(legacy, "resourceConfig")) legacy.resourceConfig = {};
  if (!Object.hasOwn(legacy, "resourceRunState")) legacy.resourceRunState = {};
  if (!Object.hasOwn(legacy, "privateStateStoreId")) {
    legacy.privateStateStoreId = "";
  }
  const cleared = [];
  globalThis.game = {
    ready: true,
    user,
    users,
    journal: journal.collection,
    settings: {
      get: (_module, key) => legacy[key],
      async set(_module, key, value) {
        legacy[key] = value;
        cleared.push(key);
      },
    },
  };
  return { cleared, legacy };
}

try {
  globalThis.CONST = {
    DOCUMENT_OWNERSHIP_LEVELS: { NONE: 0 },
    USER_ROLES: { GAMEMASTER: 4 },
  };
  globalThis.Hooks = makeHooks();
  let activeJournal = makeJournal();
  let createCalls = 0;
  let failCreate = false;
  globalThis.JournalEntry = {
    async create(data) {
      createCalls += 1;
      return failCreate ? null : activeJournal.insert(data);
    },
  };

  // An authoritative GM migrates once, and duplicate local initialization calls
  // share the same promise instead of creating two journals.
  {
    resetPrivateStateForTests();
    activeJournal = makeJournal();
    createCalls = 0;
    const legacy = {
      merchants: [{ id: "m1", name: "Secret Shop", goldOnHand: 500 }],
      factions: [{ id: "f1", name: "Hidden Faction", gmNotes: "secret" }],
      resourceConfig: {
        version: 1,
        roster: [{ actorId: "secret-stash", isStash: true }],
      },
      resourceRunState: {
        lastSeenDay: 42,
        currentEnvironmentId: "underdark",
      },
    };
    const gm = { id: "gm-a", isGM: true, active: true };
    const state = configureGame({
      user: gm,
      users: makeUsers("gm-a", [gm]),
      journal: activeJournal,
      legacy,
    });

    const results = await Promise.all([
      initializePrivateState(),
      initializePrivateState(),
    ]);
    assert.deepEqual(results, [true, true]);
    assert.equal(createCalls, 1, "one client creates only one private journal");
    assert.equal(activeJournal.entries.length, 1);
    assert.equal(activeJournal.entries[0].ownership.default, 0);
    assert.equal(getPrivateState("merchants")[0].goldOnHand, 500);
    assert.equal(getPrivateState("factions")[0].gmNotes, "secret");
    assert.equal(
      getPrivateState("resourceConfig").roster[0].actorId,
      "secret-stash",
    );
    assert.equal(getPrivateState("resourceRunState").lastSeenDay, 42);
    assert.equal(
      activeJournal.entries[0].getFlag(MODULE_ID, "schemaVersion"),
      2,
    );
    assert.deepEqual(state.cleared.sort(), [
      "factions",
      "merchants",
      "privateStateStoreId",
      "resourceConfig",
      "resourceRunState",
    ]);
    assert.deepEqual(legacy.merchants, []);
    assert.deepEqual(legacy.factions, []);
    assert.deepEqual(legacy.resourceConfig, {});
    assert.deepEqual(legacy.resourceRunState, {});

    await setPrivateState("merchants", [{ id: "m2", name: "Updated" }]);
    assert.equal(getPrivateState("merchants")[0].id, "m2");

    const changes = [];
    const changeHookId = onPrivateStateChanged((payload) =>
      changes.push(payload),
    );
    await setPrivateState("resourceRunState", { lastSeenDay: 43 });
    assert.equal(getPrivateState("resourceRunState").lastSeenDay, 43);
    assert.ok(
      changes.some((payload) => payload.keys.includes("resourceRunState")),
      "private resource writes emit a value-free invalidation hook",
    );
    globalThis.Hooks.off(PRIVATE_STATE_CHANGED_HOOK, changeHookId);
  }

  // A field already present in the private journal is canonical, including an
  // intentionally empty array/object. Stale legacy settings are cleared without
  // replacing the stored values.
  {
    resetPrivateStateForTests();
    activeJournal = makeJournal();
    const store = activeJournal.insert(
      makeStoreData({
        merchants: [],
        factions: [{ id: "stored-faction" }],
        resourceConfig: { version: 2, roster: [] },
        resourceRunState: {},
      }),
    );
    const legacy = {
      merchants: [{ id: "stale-merchant" }],
      factions: [{ id: "stale-faction" }],
      resourceConfig: {
        version: 1,
        roster: [{ actorId: "stale-secret-actor" }],
      },
      resourceRunState: { lastSeenDay: 99 },
    };
    const gm = { id: "gm-a", isGM: true, active: true };
    const state = configureGame({
      user: gm,
      users: makeUsers("gm-a", [gm]),
      journal: activeJournal,
      legacy,
    });

    assert.equal(await initializePrivateState(), true);
    assert.deepEqual(getPrivateState("merchants"), []);
    assert.equal(getPrivateState("factions")[0].id, "stored-faction");
    assert.deepEqual(getPrivateState("resourceConfig"), {
      version: 2,
      roster: [],
    });
    assert.deepEqual(getPrivateState("resourceRunState"), {});
    assert.deepEqual(
      store.getFlag(MODULE_ID, "resourceRunState"),
      {},
      "an explicitly empty private object takes precedence over stale legacy data",
    );
    assert.deepEqual(state.cleared.sort(), [
      "factions",
      "merchants",
      "privateStateStoreId",
      "resourceConfig",
      "resourceRunState",
    ]);
  }

  // A second GM never creates a competing store. It waits for the active GM's
  // document and then follows remote updates through Journal hooks.
  {
    resetPrivateStateForTests();
    activeJournal = makeJournal();
    createCalls = 0;
    const gmA = { id: "gm-a", isGM: true, active: true };
    const gmB = { id: "gm-b", isGM: true, active: true };
    const legacy = {
      merchants: [],
      factions: [],
      resourceConfig: { roster: [{ actorId: "legacy-secret" }] },
      resourceRunState: { lastSeenDay: 12 },
    };
    const state = configureGame({
      user: gmB,
      users: makeUsers("gm-a", [gmA, gmB]),
      journal: activeJournal,
      legacy,
    });

    const waiting = initializePrivateState();
    assert.equal(
      createCalls,
      0,
      "non-authoritative GM does not create a competing private journal",
    );
    const shared = activeJournal.insert(
      makeStoreData({ merchants: [{ id: "shared" }] }),
    );
    state.legacy.privateStateStoreId = shared.id;
    globalThis.Hooks.call("updateSetting", {
      namespace: MODULE_ID,
      key: "privateStateStoreId",
    });
    assert.equal(await waiting, true);
    assert.equal(getPrivateState("merchants")[0].id, "shared");
    assert.deepEqual(
      state.cleared,
      [],
      "a secondary GM never migrates or clears legacy settings",
    );
    assert.equal(legacy.resourceRunState.lastSeenDay, 12);
    await setPrivateState("resourceConfig", {
      version: 2,
      roster: [{ actorId: "secondary-gm-edit" }],
    });
    assert.equal(
      getPrivateState("resourceConfig").roster[0].actorId,
      "secondary-gm-edit",
      "a full secondary GM may edit an established private store",
    );
    assert.deepEqual(
      state.cleared,
      [],
      "a secondary GM write still never touches legacy settings",
    );

    await shared.update({
      [`flags.${MODULE_ID}.merchants`]: [{ id: "remote-update" }],
    });
    assert.equal(
      getPrivateState("merchants")[0].id,
      "remote-update",
      "another GM's journal update refreshes the local cache",
    );

    activeJournal.remove(shared);
    assert.equal(isPrivateStateReady(), false);
    assert.equal(getPrivateState("merchants"), undefined);

    activeJournal.insert(makeStoreData({ merchants: [{ id: "replacement" }] }));
    assert.equal(
      isPrivateStateReady(),
      false,
      "a secondary GM never trusts an unbound replacement Journal",
    );
    assert.equal(getPrivateState("merchants"), undefined);
  }

  // The persisted canonical identity is sticky. A duplicate cannot displace it,
  // and canonical deletion recreates the last verified snapshot instead of
  // silently promoting possibly stale duplicate data.
  {
    resetPrivateStateForTests();
    activeJournal = makeJournal();
    const canonical = activeJournal.insert(
      makeStoreData({ merchants: [{ id: "canonical" }] }),
    );
    const duplicate = activeJournal.insert(
      makeStoreData({ merchants: [{ id: "duplicate" }] }),
    );
    const gm = { id: "gm-a", isGM: true, role: 4, active: true };
    const state = configureGame({
      user: gm,
      users: makeUsers("gm-a", [gm]),
      journal: activeJournal,
    });

    assert.equal(await initializePrivateState(), true);
    assert.equal(getPrivateState("merchants")[0].id, "canonical");
    const lateOlderDuplicate = activeJournal.insert(
      makeStoreData({ merchants: [{ id: "late-older-duplicate" }] }),
      { createdTime: -100 },
    );
    assert.equal(
      getPrivateState("merchants")[0].id,
      "canonical",
      "a duplicate arriving later cannot win by claiming an older timestamp",
    );
    await duplicate.update({
      [`flags.${MODULE_ID}.merchants`]: [{ id: "ignored-duplicate" }],
    });
    assert.equal(
      getPrivateState("merchants")[0].id,
      "canonical",
      "a duplicate Journal cannot replace the canonical cache",
    );

    activeJournal.remove(canonical);
    assert.equal(isPrivateStateReady(), false);
    await waitFor(
      () => isPrivilegedPrivateStateReady(),
      "authoritative GM did not recreate a deleted canonical store",
    );
    assert.equal(
      getPrivateState("merchants")[0].id,
      "canonical",
      "canonical deletion restores the last verified data",
    );
    assert.equal(
      getPrivateState("merchants")[0].id === "ignored-duplicate",
      false,
    );
    assert.equal(activeJournal.entries.includes(duplicate), true);
    assert.equal(activeJournal.entries.includes(lateOlderDuplicate), true);
    assert.equal(
      activeJournal.entries.length,
      3,
      "stale duplicates remain quarantined beside one fresh canonical store",
    );
  }

  // Authority is fenced across the asynchronous create/migrate boundary. If a
  // different GM becomes designated while creation is pending, the old
  // authority may finish the document request but cannot clear legacy state.
  {
    resetPrivateStateForTests();
    activeJournal = makeJournal();
    createCalls = 0;
    const gmA = { id: "gm-a", isGM: true, role: 4, active: true };
    const gmB = { id: "gm-b", isGM: true, role: 4, active: true };
    const users = makeUsers("gm-a", [gmA, gmB]);
    const legacy = {
      merchants: [{ id: "handoff-merchant" }],
      factions: [{ id: "handoff-faction" }],
      resourceConfig: { version: 1 },
      resourceRunState: { lastSeenDay: 8 },
    };
    const state = configureGame({
      user: gmA,
      users,
      journal: activeJournal,
      legacy,
    });
    let releaseCreate;
    let markCreateStarted;
    const createGate = new Promise((resolve) => {
      releaseCreate = resolve;
    });
    const createStarted = new Promise((resolve) => {
      markCreateStarted = resolve;
    });
    globalThis.JournalEntry.create = async (data) => {
      createCalls += 1;
      markCreateStarted();
      await createGate;
      return activeJournal.insert(data);
    };

    const originalInitialization = initializePrivateState();
    await createStarted;
    users.activeGM = gmB;
    globalThis.Hooks.call("userConnected", gmB, true);
    releaseCreate();
    assert.equal(await originalInitialization, false);
    await new Promise((resolve) => globalThis.setTimeout(resolve, 0));
    assert.equal(createCalls, 1);
    assert.deepEqual(
      state.cleared,
      [],
      "an ex-authoritative GM never clears legacy settings after handoff",
    );
    assert.equal(legacy.resourceRunState.lastSeenDay, 8);

    globalThis.JournalEntry.create = async (data) => {
      createCalls += 1;
      return failCreate ? null : activeJournal.insert(data);
    };
  }

  // If document creation fails, legacy secrets stay put and initialization can
  // retry later instead of reporting a ready store backed by null.
  {
    resetPrivateStateForTests();
    activeJournal = makeJournal();
    createCalls = 0;
    failCreate = true;
    const legacy = {
      merchants: [{ id: "keep-me" }],
      factions: [{ id: "keep-me-too" }],
    };
    const gm = { id: "gm-a", isGM: true, active: true };
    configureGame({
      user: gm,
      users: makeUsers("gm-a", [gm]),
      journal: activeJournal,
      legacy,
    });
    const failedCreate = await captureConsole("warn", () =>
      initializePrivateState(),
    );
    assert.equal(failedCreate.result, false);
    assert.match(
      String(failedCreate.messages[0]?.[0] ?? ""),
      /private state store is not available yet/,
    );
    assert.equal(isPrivateStateReady(), false);
    assert.equal(createCalls, 1);
    assert.equal(legacy.merchants[0].id, "keep-me");
    assert.equal(legacy.factions[0].id, "keep-me-too");

    failCreate = false;
    assert.equal(await initializePrivateState(), true);
    assert.equal(createCalls, 2, "a failed creation attempt remains retryable");
  }

  // Legacy object settings are not cleared until every copied flag can be read
  // back from the journal. A failed verification remains retryable and keeps
  // the original setting intact.
  {
    resetPrivateStateForTests();
    activeJournal = makeJournal();
    const store = activeJournal.insert(
      makeStoreData({
        schemaVersion: 1,
        resourceConfig: null,
        resourceRunState: null,
      }),
    );
    store.ignoreNextUpdate(`flags.${MODULE_ID}.resourceConfig`);
    const legacy = {
      merchants: [],
      factions: [],
      resourceConfig: {
        version: 1,
        roster: [{ actorId: "must-survive-failed-copy" }],
      },
      resourceRunState: { lastSeenDay: 7 },
    };
    const gm = { id: "gm-a", isGM: true, active: true };
    const state = configureGame({
      user: gm,
      users: makeUsers("gm-a", [gm]),
      journal: activeJournal,
      legacy,
    });

    const failedMigration = await captureConsole("error", () =>
      assert.rejects(
        initializePrivateState(),
        /PrivateStateMigrationVerificationFailed:resourceConfig/,
      ),
    );
    assert.match(
      String(failedMigration.messages[0]?.[0] ?? ""),
      /private state initialization failed/,
    );
    assert.equal(isPrivateStateReady(), false);
    assert.deepEqual(state.cleared, ["privateStateStoreId"]);
    assert.equal(
      legacy.resourceConfig.roster[0].actorId,
      "must-survive-failed-copy",
      "a failed journal copy never clears the legacy object",
    );

    assert.equal(await initializePrivateState(), true);
    assert.equal(
      getPrivateState("resourceConfig").roster[0].actorId,
      "must-survive-failed-copy",
    );
    assert.equal(getPrivateState("resourceRunState").lastSeenDay, 7);
    assert.deepEqual(state.cleared.sort(), [
      "privateStateStoreId",
      "resourceConfig",
      "resourceRunState",
    ]);
    assert.deepEqual(legacy.resourceConfig, {});
    assert.deepEqual(legacy.resourceRunState, {});
  }

  // Store writes made before an explicit initialization still await the private
  // journal. They must not fall back to the player-readable legacy settings.
  {
    resetPrivateStateForTests();
    activeJournal = makeJournal();
    const store = activeJournal.insert(makeStoreData());
    const gm = { id: "gm-a", isGM: true, active: true };
    const state = configureGame({
      user: gm,
      users: makeUsers("gm-a", [gm]),
      journal: activeJournal,
    });

    await saveMerchants([{ id: "private-merchant", name: "Private Shop" }]);
    await saveFactions([
      { id: "private-faction", name: "Private Faction", revealed: false },
    ]);
    assert.equal(
      store.getFlag(MODULE_ID, "merchants")[0].id,
      "private-merchant",
    );
    assert.equal(store.getFlag(MODULE_ID, "factions")[0].id, "private-faction");
    assert.deepEqual(
      state.cleared,
      ["privateStateStoreId"],
      "live writes never touch legacy world settings",
    );
  }

  // Players never hydrate the restricted document, even if a test fixture makes
  // it visible, and cannot write private state.
  {
    resetPrivateStateForTests();
    const player = { id: "player", isGM: false, active: true };
    configureGame({
      user: player,
      users: makeUsers("gm-a", [
        { id: "gm-a", isGM: true, active: true },
        player,
      ]),
      journal: activeJournal,
    });
    await initializePrivateState();
    assert.deepEqual(getPrivateState("merchants"), []);
    assert.deepEqual(getPrivateState("factions"), []);
    assert.deepEqual(getPrivateState("resourceConfig"), {});
    assert.deepEqual(getPrivateState("resourceRunState"), {});
    await assert.rejects(
      setPrivateState("merchants", [{ id: "forged" }]),
      /PermissionDenied/,
    );
    await assert.rejects(
      setPrivateState("resourceConfig", {
        roster: [{ actorId: "forged-secret" }],
      }),
      /PermissionDenied/,
    );
  }

  // Foundry reports Assistant GMs as isGM=true. They still use the sanitized
  // player path and cannot hydrate or edit the full-GM private store.
  {
    resetPrivateStateForTests();
    const assistant = {
      id: "assistant",
      isGM: true,
      role: 3,
      active: true,
    };
    configureGame({
      user: assistant,
      users: makeUsers("gm-a", [
        { id: "gm-a", isGM: true, role: 4, active: true },
        assistant,
      ]),
      journal: activeJournal,
      legacy: {
        merchants: [{ id: "hidden-shop" }],
        factions: [{ id: "hidden-faction" }],
        resourceConfig: {
          roster: [{ actorId: "hidden-roster-member" }],
        },
        resourceRunState: { lastSeenDay: 88 },
      },
    });
    await initializePrivateState();
    assert.deepEqual(getPrivateState("resourceConfig"), {});
    assert.deepEqual(getPrivateState("resourceRunState"), {});
    await assert.rejects(
      setPrivateState("resourceConfig", {
        roster: [{ actorId: "assistant-write" }],
      }),
      /PermissionDenied/,
    );
  }

  // Promoting the current user clears the sanitized cache until the restricted
  // store has been hydrated. Demotion is synchronous and unregisters the
  // journal listeners before any later document update can refresh secrets.
  {
    resetPrivateStateForTests();
    activeJournal = makeJournal();
    const store = activeJournal.insert(
      makeStoreData({
        resourceConfig: {
          version: 2,
          roster: [{ actorId: "promotion-secret" }],
        },
      }),
    );
    const gm = { id: "gm-a", isGM: true, role: 4, active: true };
    const assistant = {
      id: "assistant",
      isGM: true,
      role: 3,
      active: true,
    };
    configureGame({
      user: assistant,
      users: makeUsers("gm-a", [gm, assistant]),
      journal: activeJournal,
      legacy: { privateStateStoreId: store.id },
    });
    const changes = [];
    const changeHookId = onPrivateStateChanged((payload) =>
      changes.push(payload),
    );

    assert.equal(await initializePrivateState(), true);
    assert.equal(isPrivilegedPrivateStateReady(), false);
    assert.deepEqual(getPrivateState("resourceConfig"), {});
    assert.equal(globalThis.Hooks.listenerCount("updateUser"), 1);

    assistant.role = 4;
    globalThis.Hooks.call("updateUser", assistant, { role: 4 });
    assert.equal(
      isPrivateStateReady(),
      false,
      "promotion clears safe defaults until hydration completes",
    );
    await waitFor(
      () => isPrivilegedPrivateStateReady(),
      "promoted full GM did not hydrate the private store",
    );
    assert.equal(
      getPrivateState("resourceConfig").roster[0].actorId,
      "promotion-secret",
    );
    assert.equal(globalThis.Hooks.listenerCount("updateJournalEntry"), 1);
    assert.ok(
      changes.some((payload) => payload.reason === "store-ready"),
      "promotion emits a value-free ready invalidation",
    );
    assert.equal(
      JSON.stringify(changes).includes("promotion-secret"),
      false,
      "role-transition hooks never include stored values",
    );

    assistant.role = 3;
    globalThis.Hooks.call("updateUser", assistant, { role: 3 });
    assert.equal(isPrivateStateReady(), true);
    assert.equal(isPrivilegedPrivateStateReady(), false);
    assert.equal(
      globalThis.Hooks.listenerCount("updateJournalEntry"),
      0,
      "demotion removes privileged journal hooks synchronously",
    );
    assert.equal(
      globalThis.Hooks.listenerCount("updateUser"),
      1,
      "the role hook remains available for a later promotion",
    );
    assert.deepEqual(
      getPrivateState("resourceConfig"),
      {},
      "demotion installs safe defaults synchronously",
    );

    await store.update({
      [`flags.${MODULE_ID}.resourceConfig`]: {
        version: 2,
        roster: [{ actorId: "post-demotion-secret" }],
      },
    });
    assert.deepEqual(
      getPrivateState("resourceConfig"),
      {},
      "demoted clients no longer follow restricted journal updates",
    );

    assistant.role = 4;
    globalThis.Hooks.call("updateUser", assistant, { role: 4 });
    await waitFor(
      () =>
        isPrivilegedPrivateStateReady() &&
        getPrivateState("resourceConfig")?.roster?.[0]?.actorId ===
          "post-demotion-secret",
      "re-promoted full GM did not rehydrate the current store",
    );
    globalThis.Hooks.off(PRIVATE_STATE_CHANGED_HOOK, changeHookId);
  }

  // A failed automatic hydration after promotion remains retryable. The role
  // hook consumes the expected failure so it cannot become an unhandled promise.
  {
    resetPrivateStateForTests();
    activeJournal = makeJournal();
    createCalls = 0;
    failCreate = true;
    const candidate = {
      id: "gm-candidate",
      isGM: false,
      role: 1,
      active: true,
    };
    configureGame({
      user: candidate,
      users: makeUsers("gm-candidate", [candidate]),
      journal: activeJournal,
    });
    assert.equal(await initializePrivateState(), true);

    const failedPromotion = await captureConsole("warn", async () => {
      candidate.isGM = true;
      candidate.role = 4;
      globalThis.Hooks.call("updateUser", candidate, { role: 4 });
      await waitFor(
        () => createCalls === 1,
        "promotion did not attempt to create the private store",
      );
      await new Promise((resolve) => globalThis.setTimeout(resolve, 0));
    });
    assert.match(
      String(failedPromotion.messages[0]?.[0] ?? ""),
      /private state store is not available yet/,
    );
    assert.equal(isPrivateStateReady(), false);
    assert.equal(isPrivilegedPrivateStateReady(), false);

    failCreate = false;
    assert.equal(await initializePrivateState(), true);
    assert.equal(createCalls, 2);
    assert.equal(isPrivilegedPrivateStateReady(), true);
  }

  // If a full-GM hydration is waiting during a rapid role handoff, demotion
  // cancels that generation. A store appearing afterward cannot refill the
  // cache until the same user is promoted again.
  {
    resetPrivateStateForTests();
    activeJournal = makeJournal();
    const gm = { id: "gm-a", isGM: true, role: 4, active: true };
    const assistant = {
      id: "assistant",
      isGM: true,
      role: 3,
      active: true,
    };
    const state = configureGame({
      user: assistant,
      users: makeUsers("gm-a", [gm, assistant]),
      journal: activeJournal,
    });
    assert.equal(await initializePrivateState(), true);

    assistant.role = 4;
    globalThis.Hooks.call("updateUser", assistant, { role: 4 });
    await Promise.resolve();
    assistant.role = 3;
    globalThis.Hooks.call("updateUser", assistant, { role: 3 });
    const remoteStore = activeJournal.insert(
      makeStoreData({
        resourceRunState: { lastSeenDay: 144 },
      }),
    );
    state.legacy.privateStateStoreId = remoteStore.id;
    globalThis.Hooks.call("updateSetting", {
      namespace: MODULE_ID,
      key: "privateStateStoreId",
    });
    await new Promise((resolve) => globalThis.setTimeout(resolve, 0));
    assert.equal(isPrivilegedPrivateStateReady(), false);
    assert.deepEqual(getPrivateState("resourceRunState"), {});

    assistant.role = 4;
    globalThis.Hooks.call("updateUser", assistant, { role: 4 });
    await waitFor(
      () =>
        isPrivilegedPrivateStateReady() &&
        getPrivateState("resourceRunState")?.lastSeenDay === 144,
      "new full-GM generation did not hydrate after role handoff",
    );
    assert.equal(globalThis.Hooks.listenerCount("updateUser"), 1);
    resetPrivateStateForTests();
    assert.equal(
      globalThis.Hooks.listenerCount("updateUser"),
      0,
      "test reset cleans the role-transition hook",
    );
    assert.equal(globalThis.Hooks.listenerCount("updateJournalEntry"), 0);
  }

  // A fresh process cannot prove that a different marked Journal is a safe
  // replacement for an unresolved persisted id. It leaves both the opaque id
  // and populated candidate untouched, pending explicit reconciliation.
  {
    resetPrivateStateForTests();
    activeJournal = makeJournal();
    const candidate = activeJournal.insert(
      makeStoreData({
        merchants: [{ id: "populated-candidate" }],
        resourceConfig: {
          version: 2,
          roster: [{ actorId: "private-roster-member" }],
        },
      }),
    );
    const gm = { id: "gm-a", isGM: true, role: 4, active: true };
    const legacy = {
      privateStateStoreId: "missing-id",
      merchants: [],
      factions: [],
      resourceConfig: {},
      resourceRunState: {},
    };
    const state = configureGame({
      user: gm,
      users: makeUsers("gm-a", [gm]),
      journal: activeJournal,
      legacy,
    });
    const createCallsBefore = createCalls;

    const unavailable = await captureConsole("warn", () =>
      initializePrivateState(),
    );
    assert.equal(unavailable.result, false);
    assert.match(
      String(unavailable.messages[0]?.[0] ?? ""),
      /persisted private state store .* is unresolved/,
    );
    assert.equal(isPrivateStateReady(), false);
    assert.equal(isPrivilegedPrivateStateReady(), false);
    assert.equal(createCalls, createCallsBefore);
    assert.equal(legacy.privateStateStoreId, "missing-id");
    assert.deepEqual(state.cleared, []);
    assert.equal(
      candidate.getFlag(MODULE_ID, "merchants")[0].id,
      "populated-candidate",
    );
    assert.equal(
      candidate.getFlag(MODULE_ID, "resourceConfig").roster[0].actorId,
      "private-roster-member",
    );
    assert.equal(activeJournal.entries.length, 1);
  }

  // A resolved initialization is invalidated when the canonical payload becomes
  // corrupt. The authoritative GM repairs it from the last verified snapshot
  // instead of exposing typed defaults or leaving a permanently resolved cache.
  {
    resetPrivateStateForTests();
    activeJournal = makeJournal();
    const canonical = activeJournal.insert(
      makeStoreData({ merchants: [{ id: "verified-before-corruption" }] }),
    );
    const gm = { id: "gm-a", isGM: true, role: 4, active: true };
    configureGame({
      user: gm,
      users: makeUsers("gm-a", [gm]),
      journal: activeJournal,
    });
    assert.equal(await initializePrivateState(), true);

    await canonical.update({
      [`flags.${MODULE_ID}.merchants`]: null,
    });
    assert.equal(
      isPrivateStateReady(),
      false,
      "invalid canonical data synchronously closes the privileged cache",
    );
    assert.equal(getPrivateState("merchants"), undefined);
    await waitFor(
      () =>
        isPrivilegedPrivateStateReady() &&
        getPrivateState("merchants")?.[0]?.id === "verified-before-corruption",
      "corrupt canonical data was not repaired from the verified snapshot",
    );
  }

  // Unsafe Journal ownership is normalized before any legacy secret is cleared.
  // If that privacy update cannot be verified, initialization fails closed and
  // leaves the migration source intact for a later retry.
  {
    resetPrivateStateForTests();
    activeJournal = makeJournal();
    const unsafeData = makeStoreData();
    unsafeData.ownership = { default: 2, player: 3 };
    const unsafeStore = activeJournal.insert(unsafeData);
    unsafeStore.ignoreNextUpdate("ownership");
    const gm = { id: "gm-a", isGM: true, role: 4, active: true };
    const player = { id: "player", isGM: false, role: 1, active: true };
    const legacy = {
      merchants: [{ id: "must-remain-private" }],
      factions: [],
      resourceConfig: {},
      resourceRunState: {},
    };
    configureGame({
      user: gm,
      users: makeUsers("gm-a", [gm, player]),
      journal: activeJournal,
      legacy,
    });

    const failedPrivacyRepair = await captureConsole("error", () =>
      assert.rejects(
        initializePrivateState(),
        /PrivateStateOwnershipVerificationFailed/,
      ),
    );
    assert.match(
      String(failedPrivacyRepair.messages[0]?.[0] ?? ""),
      /private state initialization failed/,
    );
    assert.equal(isPrivilegedPrivateStateReady(), false);
    assert.equal(legacy.merchants[0].id, "must-remain-private");

    assert.equal(await initializePrivateState(), true);
    assert.deepEqual(unsafeStore.ownership, { default: 0 });
    assert.deepEqual(legacy.merchants, []);
  }

  // Foundry's pre-ready phase is not the pure Node fallback. Early calls remain
  // retryable and can neither write the synchronized legacy setting nor memoize
  // a non-live initialization result.
  {
    resetPrivateStateForTests();
    activeJournal = makeJournal();
    const gm = { id: "gm-a", isGM: true, role: 4, active: true };
    const state = configureGame({
      user: gm,
      users: makeUsers("gm-a", [gm]),
      journal: activeJournal,
    });
    globalThis.game.ready = false;

    assert.equal(await initializePrivateState(), false);
    await assert.rejects(
      setPrivateState("merchants", [{ id: "too-early" }]),
      /Foundry is not ready/,
    );
    assert.deepEqual(state.cleared, []);
    assert.equal(isPrivateStateReady(), false);

    globalThis.game.ready = true;
    assert.equal(
      await initializePrivateState(),
      true,
      "the ready transition retries instead of reusing a pre-ready result",
    );
    assert.equal(isPrivilegedPrivateStateReady(), true);
  }

  process.stdout.write("private-state validation passed\n");
} finally {
  resetPrivateStateForTests();
  if (saved.game === undefined) delete globalThis.game;
  else globalThis.game = saved.game;
  if (saved.Hooks === undefined) delete globalThis.Hooks;
  else globalThis.Hooks = saved.Hooks;
  if (saved.JournalEntry === undefined) delete globalThis.JournalEntry;
  else globalThis.JournalEntry = saved.JournalEntry;
  if (saved.CONST === undefined) delete globalThis.CONST;
  else globalThis.CONST = saved.CONST;
}
