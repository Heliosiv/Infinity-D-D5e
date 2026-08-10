import assert from "node:assert/strict";

import {
  PRIVATE_STATE_SCHEMA_VERSION,
  PRIVATE_STATE_CHANGED_HOOK,
  applyEmptyPrivateStateReplacement,
  applyPrivateStateCandidateAdoption,
  applyPrivateStateSnapshotRecovery,
  getPrivateState,
  getPrivateStateRecoveryOverview,
  getPrivateStateStatus,
  initializePrivateState,
  isPrivateStateReady,
  isPrivilegedPrivateStateReady,
  onPrivateStateChanged,
  previewEmptyPrivateStateReplacement,
  previewPrivateStateCandidateAdoption,
  previewPrivateStateSnapshotRecovery,
  resetPrivateStateForTests,
  setPrivateState,
  setPrivateStates,
} from "./private-state.js";
import { saveMerchants } from "./merchant/store.js";
import { saveFactions } from "./reputation/store.js";

const MODULE_ID = "infinity-dnd5e";
const CURRENT_SCHEMA = PRIVATE_STATE_SCHEMA_VERSION;
const FUTURE_SCHEMA = CURRENT_SCHEMA + 1;

function emptyMerchantTransactions() {
  return {
    version: 1,
    revision: 0,
    authorityId: null,
    authorityEpoch: null,
    writeToken: null,
    replayFloors: [],
    records: [],
  };
}
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
    updateCalls: [],
    ignoreNextUpdate(path) {
      ignoredUpdatePaths.add(path);
    },
    setFlagDirect(key, value, { notify = true } = {}) {
      flags[MODULE_ID][key] = structuredClone(value);
      if (notify) {
        globalThis.Hooks.call("updateJournalEntry", this, {
          [`flags.${MODULE_ID}.${key}`]: structuredClone(value),
        });
      }
    },
    async update(changes) {
      this.updateCalls.push(structuredClone(changes));
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
    insert(data, { createdTime = null, id = null } = {}) {
      const document = makeDocument(data);
      if (createdTime !== null) document._stats.createdTime = createdTime;
      if (id !== null) document.id = id;
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
  schemaVersion = CURRENT_SCHEMA,
  merchants = [],
  merchantAccess = {},
  merchantTransactions = emptyMerchantTransactions(),
  factions = [],
  resourceConfig = {},
  resourceRunState = {},
  criticalInjuryWorkflow = {},
  criticalInjuryWorkflowCheckpoint = {},
  downtimeConfig = {},
  downtimeWorkflow = {},
  downtimeWorkflowCheckpoint = {},
  includeCriticalInjuryWorkflow = true,
  includeMerchantAccess = true,
  includeMerchantTransactions = true,
  includeCriticalInjuryWorkflowCheckpoint = true,
  includeDowntimeConfig = true,
  includeDowntimeWorkflow = true,
  includeDowntimeWorkflowCheckpoint = true,
} = {}) {
  return {
    name: "[Infinity D&D5e] Private State",
    ownership: { default: 0 },
    flags: {
      [MODULE_ID]: {
        privateStateStore: true,
        schemaVersion,
        merchants,
        ...(includeMerchantAccess ? { merchantAccess } : {}),
        ...(includeMerchantTransactions ? { merchantTransactions } : {}),
        factions,
        resourceConfig,
        resourceRunState,
        ...(includeCriticalInjuryWorkflow ? { criticalInjuryWorkflow } : {}),
        ...(includeCriticalInjuryWorkflowCheckpoint
          ? { criticalInjuryWorkflowCheckpoint }
          : {}),
        ...(includeDowntimeConfig ? { downtimeConfig } : {}),
        ...(includeDowntimeWorkflow ? { downtimeWorkflow } : {}),
        ...(includeDowntimeWorkflowCheckpoint
          ? { downtimeWorkflowCheckpoint }
          : {}),
      },
    },
  };
}

function configureGame({ user, users, journal, legacy = null }) {
  legacy ??= {
    merchants: [],
    factions: [],
    resourceConfig: {},
    resourceRunState: {},
  };
  if (!Object.hasOwn(legacy, "merchants")) legacy.merchants = [];
  if (!Object.hasOwn(legacy, "factions")) legacy.factions = [];
  if (!Object.hasOwn(legacy, "resourceConfig")) legacy.resourceConfig = {};
  if (!Object.hasOwn(legacy, "resourceRunState")) legacy.resourceRunState = {};
  if (!Object.hasOwn(legacy, "privateStateStoreId")) {
    legacy.privateStateStoreId =
      journal.entries.length === 1 ? journal.entries[0].id : "";
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
    assert.deepEqual(getPrivateState("merchantAccess"), {});
    assert.deepEqual(
      getPrivateState("merchantTransactions"),
      emptyMerchantTransactions(),
    );
    assert.deepEqual(getPrivateState("criticalInjuryWorkflow"), {});
    assert.deepEqual(getPrivateState("criticalInjuryWorkflowCheckpoint"), {});
    assert.deepEqual(getPrivateState("downtimeConfig"), {});
    assert.deepEqual(getPrivateState("downtimeWorkflow"), {});
    assert.deepEqual(getPrivateState("downtimeWorkflowCheckpoint"), {});
    assert.equal(
      activeJournal.entries[0].getFlag(MODULE_ID, "schemaVersion"),
      CURRENT_SCHEMA,
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

  // Schema 6 did not define a Merchant transaction ledger. Its migration adds
  // one deterministic empty v1 envelope without changing any existing field.
  for (const migrationCase of ["missing", "invalid"]) {
    resetPrivateStateForTests();
    activeJournal = makeJournal();
    const source = makeStoreData({
      schemaVersion: 6,
      merchants: [{ id: `schema-6-${migrationCase}` }],
      merchantAccess: { closed: true },
      merchantTransactions:
        migrationCase === "invalid" ? { version: 99 } : undefined,
      factions: [{ id: "preserved-faction" }],
      resourceConfig: { roster: [{ actorId: "preserved-actor" }] },
      resourceRunState: { lastSeenDay: 18 },
      criticalInjuryWorkflow: { requests: [] },
      criticalInjuryWorkflowCheckpoint: { requests: [] },
      downtimeConfig: { locations: [] },
      downtimeWorkflow: { requests: [] },
      downtimeWorkflowCheckpoint: { requests: [] },
      includeMerchantTransactions: migrationCase !== "missing",
    });
    const preserved = structuredClone(source.flags[MODULE_ID]);
    delete preserved.schemaVersion;
    delete preserved.merchantTransactions;
    const store = activeJournal.insert(source);
    const gm = { id: "gm-a", isGM: true, role: 4, active: true };
    configureGame({
      user: gm,
      users: makeUsers("gm-a", [gm]),
      journal: activeJournal,
      legacy: { privateStateStoreId: store.id },
    });

    assert.equal(await initializePrivateState(), true);
    assert.equal(store.getFlag(MODULE_ID, "schemaVersion"), CURRENT_SCHEMA);
    assert.deepEqual(
      store.getFlag(MODULE_ID, "merchantTransactions"),
      emptyMerchantTransactions(),
    );
    assert.deepEqual(
      Object.fromEntries(
        Object.keys(preserved).map((key) => [
          key,
          store.getFlag(MODULE_ID, key),
        ]),
      ),
      preserved,
      `schema 6 ${migrationCase} migration changed an existing field`,
    );
    assert.deepEqual(store.updateCalls, [
      {
        [`flags.${MODULE_ID}.merchantTransactions`]:
          emptyMerchantTransactions(),
      },
      { [`flags.${MODULE_ID}.schemaVersion`]: CURRENT_SCHEMA },
    ]);
  }

  // Related private fields share one Journal update and are accepted only
  // after exact canonical read-back of every requested value.
  {
    resetPrivateStateForTests();
    activeJournal = makeJournal();
    const store = activeJournal.insert(makeStoreData());
    const gm = { id: "gm-a", isGM: true, role: 4, active: true };
    configureGame({
      user: gm,
      users: makeUsers("gm-a", [gm]),
      journal: activeJournal,
      legacy: { privateStateStoreId: store.id },
    });
    assert.equal(await initializePrivateState(), true);
    const updateCount = store.updateCalls.length;
    const transactions = {
      ...emptyMerchantTransactions(),
      revision: 1,
      authorityId: "gm-a",
      authorityEpoch: "gm-a:epoch-1",
      writeToken: "write-1",
      records: [{ commitId: "commit-1", stage: "prepared" }],
    };
    const written = await setPrivateStates({
      merchants: [{ id: "atomic-shop", goldOnHand: 75 }],
      merchantTransactions: transactions,
    });

    assert.deepEqual(written, {
      merchants: [{ id: "atomic-shop", goldOnHand: 75 }],
      merchantTransactions: transactions,
    });
    assert.equal(store.updateCalls.length, updateCount + 1);
    assert.deepEqual(store.updateCalls.at(-1), {
      [`flags.${MODULE_ID}.merchants`]: [{ id: "atomic-shop", goldOnHand: 75 }],
      [`flags.${MODULE_ID}.merchantTransactions`]: transactions,
    });
    assert.deepEqual(getPrivateState("merchants"), written.merchants);
    assert.deepEqual(
      getPrivateState("merchantTransactions"),
      written.merchantTransactions,
    );
  }

  // A failed guard writes neither field. A storage layer that silently drops
  // one path is also detected by exact read-back and never reports success.
  {
    resetPrivateStateForTests();
    activeJournal = makeJournal();
    const store = activeJournal.insert(
      makeStoreData({ merchants: [{ id: "before-atomic-failure" }] }),
    );
    const gm = { id: "gm-a", isGM: true, role: 4, active: true };
    configureGame({
      user: gm,
      users: makeUsers("gm-a", [gm]),
      journal: activeJournal,
      legacy: { privateStateStoreId: store.id },
    });
    assert.equal(await initializePrivateState(), true);
    const updateCount = store.updateCalls.length;
    const nextTransactions = {
      ...emptyMerchantTransactions(),
      revision: 1,
      records: [{ commitId: "must-not-succeed" }],
    };

    await assert.rejects(
      setPrivateStates(Object.fromEntries([["__proto__", {}]])),
      /UnknownPrivateStateKey:__proto__/,
    );
    assert.equal(store.updateCalls.length, updateCount);

    await assert.rejects(
      setPrivateStates({
        merchants: [{ id: "invalid-ledger-shop" }],
        merchantTransactions: { version: 1, records: [] },
      }),
      /InvalidPrivateStateValue:merchantTransactions/,
    );
    assert.equal(store.updateCalls.length, updateCount);

    await assert.rejects(
      setPrivateStates(
        {
          merchants: [{ id: "guarded-shop" }],
          merchantTransactions: nextTransactions,
        },
        { beforeWrite: () => false },
      ),
      /PrivateStateWritePreconditionFailed:merchants,merchantTransactions/,
    );
    assert.equal(store.updateCalls.length, updateCount);
    assert.equal(
      store.getFlag(MODULE_ID, "merchants")[0].id,
      "before-atomic-failure",
    );
    assert.deepEqual(
      store.getFlag(MODULE_ID, "merchantTransactions"),
      emptyMerchantTransactions(),
    );

    store.ignoreNextUpdate(`flags.${MODULE_ID}.merchantTransactions`);
    await assert.rejects(
      setPrivateStates({
        merchants: [{ id: "partial-readback-shop" }],
        merchantTransactions: nextTransactions,
      }),
      /PrivateStateWriteVerificationFailed:merchantTransactions/,
    );
    assert.equal(store.updateCalls.length, updateCount + 1);
    assert.deepEqual(Object.keys(store.updateCalls.at(-1)), [
      `flags.${MODULE_ID}.merchants`,
      `flags.${MODULE_ID}.merchantTransactions`,
    ]);
    assert.deepEqual(
      store.getFlag(MODULE_ID, "merchantTransactions"),
      emptyMerchantTransactions(),
    );
  }

  // A blank canonical id with an existing marked Journal requires explicit
  // candidate review. Adoption retains the document and its values exactly,
  // while the safe overview and preview never project those values.
  {
    resetPrivateStateForTests();
    activeJournal = makeJournal();
    createCalls = 0;
    const candidateStore = activeJournal.insert(
      makeStoreData({
        merchants: [{ id: "candidate-private-id" }],
        resourceConfig: {
          roster: [{ actorId: "candidate-private-actor" }],
        },
      }),
    );
    const gm = { id: "gm-a", isGM: true, role: 4, active: true };
    const state = configureGame({
      user: gm,
      users: makeUsers("gm-a", [gm]),
      journal: activeJournal,
      legacy: { privateStateStoreId: "" },
    });

    assert.equal(await initializePrivateState(), false);
    assert.equal(getPrivateStateStatus().code, "candidate-review-required");
    assert.equal(createCalls, 0);
    assert.deepEqual(state.cleared, []);
    assert.deepEqual(candidateStore.updateCalls, []);

    const overview = await getPrivateStateRecoveryOverview();
    assert.equal(overview.canMutate, true);
    assert.equal(overview.candidates.length, 1);
    assert.equal(overview.candidates[0].id, candidateStore.id);
    assert.equal(overview.candidates[0].eligible, true);
    assert.doesNotMatch(JSON.stringify(overview), /candidate-private/u);

    const preview = await previewPrivateStateCandidateAdoption(
      candidateStore.id,
    );
    assert.doesNotMatch(JSON.stringify(preview), /candidate-private/u);
    const adopted = await applyPrivateStateCandidateAdoption({
      token: preview.token,
    });
    assert.equal(adopted.ok, true);
    assert.equal(adopted.kind, "candidate-adoption");
    assert.equal(adopted.canonicalId, candidateStore.id);
    assert.equal(isPrivilegedPrivateStateReady(), true);
    assert.equal(getPrivateState("merchants")[0].id, "candidate-private-id");
    assert.equal(
      getPrivateState("resourceConfig").roster[0].actorId,
      "candidate-private-actor",
    );
    assert.equal(activeJournal.entries.length, 1);
    assert.deepEqual(candidateStore.updateCalls, []);
    assert.deepEqual(state.cleared, ["privateStateStoreId"]);
  }

  // An unresolved id with no local document blocks without creating an empty
  // campaign. Explicit empty replacement is separately previewed, confirmed,
  // created with typed defaults, and read back as the new canonical store.
  {
    resetPrivateStateForTests();
    activeJournal = makeJournal();
    createCalls = 0;
    const gm = { id: "gm-a", isGM: true, role: 4, active: true };
    const state = configureGame({
      user: gm,
      users: makeUsers("gm-a", [gm]),
      journal: activeJournal,
      legacy: { privateStateStoreId: "unresolved-store" },
    });

    assert.equal(await initializePrivateState(), false);
    assert.equal(getPrivateStateStatus().code, "missing-store");
    assert.equal(createCalls, 0);
    assert.equal(activeJournal.entries.length, 0);
    assert.deepEqual(state.cleared, []);

    const overview = await getPrivateStateRecoveryOverview();
    assert.equal(overview.snapshotAvailable, false);
    assert.equal(overview.canRecoverSnapshot, false);
    assert.equal(overview.canCreateEmpty, true);
    const preview = await previewEmptyPrivateStateReplacement();
    const replacement = await applyEmptyPrivateStateReplacement({
      token: preview.token,
      confirmationToken: preview.confirmationToken,
    });
    assert.equal(replacement.ok, true);
    assert.equal(replacement.kind, "empty-replacement");
    assert.equal(isPrivilegedPrivateStateReady(), true);
    assert.equal(activeJournal.entries.length, 1);
    assert.deepEqual(getPrivateState("merchants"), []);
    assert.deepEqual(getPrivateState("merchantAccess"), {});
    assert.equal(
      activeJournal.entries[0].getFlag(MODULE_ID, "privateStateRecoverySource")
        .kind,
      "empty-replacement",
    );
    assert.deepEqual(state.cleared, ["privateStateStoreId"]);
  }

  // A supported legacy or schema-less document that replicates after its exact
  // canonical id was reported missing must run the authoritative migration.
  // Create and update hooks both schedule initialization; neither hydrates a
  // legacy document directly or creates a replacement.
  for (const replica of [
    { label: "create-missing", event: "create", schemaVersion: undefined },
    { label: "create-legacy", event: "create", schemaVersion: 1 },
    { label: "update-legacy", event: "update", schemaVersion: 1 },
  ]) {
    resetPrivateStateForTests();
    activeJournal = makeJournal();
    createCalls = 0;
    const canonicalId = `late-${replica.label}-canonical`;
    const lateCanonicalData = makeStoreData({
      schemaVersion: replica.schemaVersion ?? CURRENT_SCHEMA,
      merchants: [{ id: `late-${replica.label}-merchant` }],
    });
    if (replica.schemaVersion === undefined) {
      delete lateCanonicalData.flags[MODULE_ID].schemaVersion;
    }
    const lateCanonical = makeDocument(lateCanonicalData);
    lateCanonical.id = canonicalId;
    const gm = { id: "gm-a", isGM: true, role: 4, active: true };
    const state = configureGame({
      user: gm,
      users: makeUsers("gm-a", [gm]),
      journal: activeJournal,
      legacy: { privateStateStoreId: canonicalId },
    });

    assert.equal(await initializePrivateState(), false);
    assert.equal(getPrivateStateStatus().code, "missing-store");
    assert.equal(getPrivateState("merchants"), undefined);
    assert.equal(createCalls, 0);
    assert.deepEqual(state.cleared, []);

    activeJournal.entries.push(lateCanonical);
    globalThis.Hooks.call(
      replica.event === "create" ? "createJournalEntry" : "updateJournalEntry",
      lateCanonical,
      {
        [`flags.${MODULE_ID}.schemaVersion`]: replica.schemaVersion,
      },
    );
    await waitFor(
      () =>
        isPrivilegedPrivateStateReady() &&
        getPrivateState("merchants")?.[0]?.id ===
          `late-${replica.label}-merchant`,
      `late ${replica.label} replica did not run its schema migration`,
    );

    assert.equal(getPrivateStateStatus().code, "ready");
    assert.equal(
      lateCanonical.getFlag(MODULE_ID, "schemaVersion"),
      CURRENT_SCHEMA,
    );
    assert.equal(state.legacy.privateStateStoreId, canonicalId);
    assert.equal(createCalls, 0);
    assert.deepEqual(state.cleared, []);
    assert.equal(activeJournal.entries.length, 1);
    assert.deepEqual(lateCanonical.updateCalls, [
      { [`flags.${MODULE_ID}.schemaVersion`]: CURRENT_SCHEMA },
    ]);
  }

  // A store written by a newer module version is never hydrated, migrated,
  // repaired, replaced, or selected as canonical by this older schema.
  {
    resetPrivateStateForTests();
    activeJournal = makeJournal();
    createCalls = 0;
    const store = activeJournal.insert(
      makeStoreData({
        schemaVersion: FUTURE_SCHEMA,
        merchants: [{ id: "future-shop", name: "Must remain untouched" }],
      }),
    );
    const gm = { id: "gm-a", isGM: true, role: 4, active: true };
    const state = configureGame({
      user: gm,
      users: makeUsers("gm-a", [gm]),
      journal: activeJournal,
    });

    assert.equal(await initializePrivateState(), false);
    assert.deepEqual(getPrivateStateStatus(), {
      state: "blocked",
      code: "future-schema",
      retryable: false,
      supportedSchema: CURRENT_SCHEMA,
      observedSchema: FUTURE_SCHEMA,
    });
    assert.equal(getPrivateState("merchants"), undefined);
    assert.equal(createCalls, 0);
    assert.deepEqual(store.updateCalls, []);
    assert.deepEqual(state.cleared, []);

    assert.equal(await initializePrivateState(), false);
    assert.equal(createCalls, 0, "a repeated probe never replaces the store");
    assert.deepEqual(store.updateCalls, []);
    assert.deepEqual(state.cleared, []);
    await assert.rejects(
      setPrivateState("merchants", [{ id: "forbidden-write" }]),
      (error) =>
        error?.code === "PRIVATE_STATE_FUTURE_SCHEMA" &&
        error?.retryable === false,
    );
    assert.deepEqual(store.updateCalls, []);

    // Simulate an external repair or compatible module restoring the canonical
    // schema. The existing hook requests one normal initialization pass.
    await store.update({
      [`flags.${MODULE_ID}.schemaVersion`]: CURRENT_SCHEMA,
    });
    await waitFor(
      () => getPrivateStateStatus().state === "ready",
      "a supported schema did not resume private-state initialization",
    );
    assert.equal(getPrivateState("merchants")[0].id, "future-shop");
    assert.deepEqual(
      state.cleared,
      [],
      "repairing the selected store does not rewrite its canonical identity",
    );
  }

  // A present malformed schema is unsupported rather than being rounded down
  // into a legacy migration that could overwrite unknown data.
  {
    resetPrivateStateForTests();
    activeJournal = makeJournal();
    createCalls = 0;
    const store = activeJournal.insert(
      makeStoreData({ schemaVersion: CURRENT_SCHEMA + 0.5 }),
    );
    const gm = { id: "gm-a", isGM: true, role: 4, active: true };
    const state = configureGame({
      user: gm,
      users: makeUsers("gm-a", [gm]),
      journal: activeJournal,
    });

    assert.equal(await initializePrivateState(), false);
    assert.equal(getPrivateStateStatus().code, "invalid-schema");
    assert.equal(getPrivateStateStatus().retryable, false);
    assert.equal(createCalls, 0);
    assert.deepEqual(store.updateCalls, []);
    assert.deepEqual(state.cleared, []);
  }

  // Present values that merely coerce to integers are malformed. A canonical
  // integer string remains compatible with older persisted flags.
  for (const malformedSchema of [
    null,
    "",
    true,
    false,
    [5],
    [],
    {},
    ` ${CURRENT_SCHEMA} `,
  ]) {
    resetPrivateStateForTests();
    activeJournal = makeJournal();
    createCalls = 0;
    const store = activeJournal.insert(
      makeStoreData({ schemaVersion: malformedSchema }),
    );
    const gm = { id: "gm-a", isGM: true, role: 4, active: true };
    const state = configureGame({
      user: gm,
      users: makeUsers("gm-a", [gm]),
      journal: activeJournal,
    });

    assert.equal(await initializePrivateState(), false);
    assert.equal(getPrivateStateStatus().code, "invalid-schema");
    assert.deepEqual(store.updateCalls, []);
    assert.deepEqual(state.cleared, []);
  }
  {
    resetPrivateStateForTests();
    activeJournal = makeJournal();
    const store = activeJournal.insert(
      makeStoreData({ schemaVersion: String(CURRENT_SCHEMA) }),
    );
    const gm = { id: "gm-a", isGM: true, role: 4, active: true };
    configureGame({
      user: gm,
      users: makeUsers("gm-a", [gm]),
      journal: activeJournal,
      legacy: { privateStateStoreId: store.id },
    });
    assert.equal(await initializePrivateState(), true);
  }

  // A current-schema store with a missing or invalid required field is
  // corruption, not a legacy migration source. It is never default-filled or
  // replaced when no verified snapshot exists.
  for (const corruption of [
    "merchants-missing",
    "merchants-invalid",
    "transactions-missing",
    "transactions-invalid",
  ]) {
    resetPrivateStateForTests();
    activeJournal = makeJournal();
    createCalls = 0;
    const data = makeStoreData({
      merchants: [{ id: "must-not-be-emptied" }],
      factions: [{ id: "must-remain-private" }],
      resourceConfig: { roster: [{ actorId: "secret-roster" }] },
    });
    if (corruption === "merchants-missing") {
      delete data.flags[MODULE_ID].merchants;
    } else if (corruption === "merchants-invalid") {
      data.flags[MODULE_ID].merchants = null;
    } else if (corruption === "transactions-missing") {
      delete data.flags[MODULE_ID].merchantTransactions;
    } else {
      data.flags[MODULE_ID].merchantTransactions = {
        ...emptyMerchantTransactions(),
        revision: -1,
      };
    }
    const store = activeJournal.insert(data);
    const gm = { id: "gm-a", isGM: true, role: 4, active: true };
    const state = configureGame({
      user: gm,
      users: makeUsers("gm-a", [gm]),
      journal: activeJournal,
    });

    assert.equal(await initializePrivateState(), false);
    assert.deepEqual(getPrivateStateStatus(), {
      state: "blocked",
      code: "corrupt",
      retryable: false,
      supportedSchema: CURRENT_SCHEMA,
      observedSchema: CURRENT_SCHEMA,
    });
    assert.equal(getPrivateState("factions"), undefined);
    assert.equal(createCalls, 0);
    assert.deepEqual(store.updateCalls, []);
    assert.deepEqual(state.cleared, []);
    assert.equal(
      store.getFlag(MODULE_ID, "factions")[0].id,
      "must-remain-private",
    );
    await assert.rejects(
      setPrivateState("merchants", [{ id: "empty-replacement" }]),
      (error) =>
        error?.code === "PRIVATE_STATE_CORRUPT" && error?.retryable === false,
    );
    assert.deepEqual(store.updateCalls, []);
  }

  // Journal creation is untrusted too. A create result that reports a newer
  // schema is quarantined before its id can become canonical.
  {
    resetPrivateStateForTests();
    activeJournal = makeJournal();
    createCalls = 0;
    const gm = { id: "gm-a", isGM: true, role: 4, active: true };
    const state = configureGame({
      user: gm,
      users: makeUsers("gm-a", [gm]),
      journal: activeJournal,
    });
    const defaultCreate = globalThis.JournalEntry.create;
    globalThis.JournalEntry.create = async (data) => {
      createCalls += 1;
      const future = structuredClone(data);
      future.flags[MODULE_ID].schemaVersion = FUTURE_SCHEMA;
      return activeJournal.insert(future);
    };
    try {
      assert.equal(await initializePrivateState(), false);
      assert.equal(getPrivateStateStatus().code, "future-schema");
      assert.equal(createCalls, 1);
      assert.deepEqual(state.cleared, []);
    } finally {
      globalThis.JournalEntry.create = defaultCreate;
    }
  }

  // Once a verified canonical store is seen at a future schema, canonical-id
  // replication gaps and deletion cannot turn its old snapshot into an
  // automatic current-schema replacement.
  {
    resetPrivateStateForTests();
    activeJournal = makeJournal();
    createCalls = 0;
    const store = activeJournal.insert(
      makeStoreData({ merchants: [{ id: "verified-before-upgrade" }] }),
    );
    const gm = { id: "gm-a", isGM: true, role: 4, active: true };
    const legacy = { privateStateStoreId: store.id };
    const state = configureGame({
      user: gm,
      users: makeUsers("gm-a", [gm]),
      journal: activeJournal,
      legacy,
    });
    assert.equal(await initializePrivateState(), true);
    assert.equal(getPrivateState("merchants")[0].id, "verified-before-upgrade");

    await store.update({
      [`flags.${MODULE_ID}.schemaVersion`]: FUTURE_SCHEMA,
    });
    assert.equal(getPrivateStateStatus().code, "future-schema");
    const createCallsAtBlock = createCalls;
    const settingWritesAtBlock = state.cleared.length;

    legacy.privateStateStoreId = "not-yet-replicated";
    globalThis.Hooks.call("updateSetting", {
      key: `${MODULE_ID}.privateStateStoreId`,
    });
    assert.equal(await initializePrivateState(), false);
    assert.equal(createCalls, createCallsAtBlock);
    assert.equal(state.cleared.length, settingWritesAtBlock);
    assert.equal(getPrivateStateStatus().code, "future-schema");

    activeJournal.remove(store);
    legacy.privateStateStoreId = "";
    globalThis.Hooks.call("updateSetting", {
      key: `${MODULE_ID}.privateStateStoreId`,
    });
    assert.equal(await initializePrivateState(), false);
    assert.equal(createCalls, createCallsAtBlock);
    assert.equal(state.cleared.length, settingWritesAtBlock);
    assert.equal(activeJournal.entries.length, 0);
    assert.equal(
      getPrivateStateStatus().code,
      "missing-store",
      "deleting the blocked canonical store requires explicit recovery",
    );
  }

  // A previously blocked document cannot clear quarantine after the canonical
  // setting moves to a different unresolved id. Downgrading that old document
  // must not retire it and create a stale replacement while the new canonical
  // Journal may still be replicating.
  {
    resetPrivateStateForTests();
    activeJournal = makeJournal();
    createCalls = 0;
    const oldStore = activeJournal.insert(
      makeStoreData({ merchants: [{ id: "verified-old-snapshot" }] }),
    );
    const gm = { id: "gm-a", isGM: true, role: 4, active: true };
    const legacy = { privateStateStoreId: oldStore.id };
    const state = configureGame({
      user: gm,
      users: makeUsers("gm-a", [gm]),
      journal: activeJournal,
      legacy,
    });
    assert.equal(await initializePrivateState(), true);

    await oldStore.update({
      [`flags.${MODULE_ID}.schemaVersion`]: FUTURE_SCHEMA,
      [`flags.${MODULE_ID}.merchants`]: [{ id: "newer-data-on-old-doc" }],
    });
    assert.equal(getPrivateStateStatus().code, "future-schema");

    legacy.privateStateStoreId = "newer-canonical-still-replicating";
    globalThis.Hooks.call("updateSetting", {
      key: `${MODULE_ID}.privateStateStoreId`,
    });
    const createCallsAtBlock = createCalls;
    const settingWritesAtBlock = state.cleared.length;
    const oldStoreWritesAtBlock = oldStore.updateCalls.length;

    await oldStore.update({
      [`flags.${MODULE_ID}.schemaVersion`]: CURRENT_SCHEMA,
    });
    assert.equal(await initializePrivateState(), false);
    assert.equal(getPrivateStateStatus().code, "future-schema");
    assert.equal(createCalls, createCallsAtBlock);
    assert.equal(state.cleared.length, settingWritesAtBlock);
    assert.equal(
      legacy.privateStateStoreId,
      "newer-canonical-still-replicating",
    );
    assert.equal(oldStore.updateCalls.length, oldStoreWritesAtBlock + 1);
    assert.equal(
      oldStore.getFlag(MODULE_ID, "merchants")[0].id,
      "newer-data-on-old-doc",
    );
    assert.deepEqual(
      activeJournal.entries.map((entry) => entry.id),
      [oldStore.id],
    );
  }

  // Clearing the canonical setting is not an implicit recovery approval. Even
  // after the old document reports a supported schema again, it remains
  // quarantined for explicit candidate review and is never re-elected or
  // rewritten automatically.
  {
    resetPrivateStateForTests();
    activeJournal = makeJournal();
    createCalls = 0;
    const store = activeJournal.insert(
      makeStoreData({ merchants: [{ id: "before-compatible-repair" }] }),
    );
    const gm = { id: "gm-a", isGM: true, role: 4, active: true };
    const legacy = { privateStateStoreId: store.id };
    configureGame({
      user: gm,
      users: makeUsers("gm-a", [gm]),
      journal: activeJournal,
      legacy,
    });
    assert.equal(await initializePrivateState(), true);

    await store.update({
      [`flags.${MODULE_ID}.schemaVersion`]: FUTURE_SCHEMA,
      [`flags.${MODULE_ID}.merchants`]: [{ id: "after-compatible-repair" }],
    });
    assert.equal(getPrivateStateStatus().code, "future-schema");

    legacy.privateStateStoreId = "";
    globalThis.Hooks.call("updateSetting", {
      key: `${MODULE_ID}.privateStateStoreId`,
    });
    const createCallsAtBlock = createCalls;
    const settingWritesAtBlock = legacy.privateStateStoreId;
    await store.update({
      [`flags.${MODULE_ID}.schemaVersion`]: CURRENT_SCHEMA,
    });
    assert.equal(await initializePrivateState(), false);

    assert.equal(getPrivateStateStatus().code, "candidate-review-required");
    assert.equal(legacy.privateStateStoreId, settingWritesAtBlock);
    assert.equal(createCalls, createCallsAtBlock);
    assert.equal(getPrivateState("merchants"), undefined);
    assert.equal(
      store.getFlag(MODULE_ID, "merchants")[0].id,
      "after-compatible-repair",
    );
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

  // The persisted canonical identity is sticky. A duplicate cannot displace
  // it, and canonical deletion blocks until the authoritative GM explicitly
  // restores the last verified snapshot. Old candidates remain untouched.
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
      legacy: { privateStateStoreId: canonical.id },
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
    assert.equal(getPrivateStateStatus().code, "missing-store");
    assert.equal(activeJournal.entries.length, 2);

    const preview = await previewPrivateStateSnapshotRecovery();
    assert.equal(preview.sourceId, canonical.id);
    const recovery = await applyPrivateStateSnapshotRecovery({
      token: preview.token,
      confirmationToken: preview.confirmationToken,
    });
    assert.equal(recovery.ok, true);
    assert.equal(recovery.kind, "snapshot-recovery");
    assert.equal(isPrivilegedPrivateStateReady(), true);
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
      "stale candidates remain beside one explicit recovery store",
    );
    assert.equal(state.legacy.privateStateStoreId, recovery.canonicalId);
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

  // A full GM that already hydrated the canonical private Journal keeps that
  // verified cache across a live authority handoff. Open GM applications and
  // workflow observers may rerender synchronously from userConnected, so an
  // empty-cache transition here would surface StoreUnavailable errors even
  // though both GMs are legitimately allowed to read the same private store.
  {
    resetPrivateStateForTests();
    activeJournal = makeJournal();
    const gmA = { id: "gm-a", isGM: true, role: 4, active: true };
    const gmB = { id: "gm-b", isGM: true, role: 4, active: true };
    const store = activeJournal.insert(
      makeStoreData({
        resourceConfig: {
          version: 2,
          roster: [{ actorId: "handoff-secret" }],
        },
      }),
    );
    const users = makeUsers("gm-a", [gmA, gmB]);
    configureGame({
      user: gmB,
      users,
      journal: activeJournal,
      legacy: { privateStateStoreId: store.id },
    });
    const changes = [];
    const changeHookId = onPrivateStateChanged((payload) =>
      changes.push(payload),
    );

    assert.equal(await initializePrivateState(), true);
    assert.equal(isPrivilegedPrivateStateReady(), true);
    users.activeGM = gmB;
    globalThis.Hooks.call("userConnected", gmA, false);

    assert.equal(
      isPrivilegedPrivateStateReady(),
      true,
      "a ready full-GM cache stays available throughout authority handoff",
    );
    assert.equal(
      getPrivateState("resourceConfig").roster[0].actorId,
      "handoff-secret",
    );
    assert.ok(
      changes.some((payload) => payload.reason === "authority-change"),
      "workflow observers are still told to adopt the new authority epoch",
    );
    globalThis.Hooks.off(PRIVATE_STATE_CHANGED_HOOK, changeHookId);
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
        includeMerchantAccess: false,
        resourceConfig: null,
        resourceRunState: null,
        includeCriticalInjuryWorkflow: false,
        includeCriticalInjuryWorkflowCheckpoint: false,
        includeDowntimeConfig: false,
        includeDowntimeWorkflow: false,
        includeDowntimeWorkflowCheckpoint: false,
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
    assert.deepEqual(state.cleared, []);
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
    assert.deepEqual(
      getPrivateState("merchantAccess"),
      {},
      "the schema migration installs the global merchant-access field",
    );
    assert.deepEqual(
      getPrivateState("criticalInjuryWorkflow"),
      {},
      "the schema migration installs the restricted injury workflow field",
    );
    assert.deepEqual(
      getPrivateState("criticalInjuryWorkflowCheckpoint"),
      {},
      "the schema migration installs the redundant injury workflow checkpoint",
    );
    assert.deepEqual(
      getPrivateState("downtimeConfig"),
      {},
      "the schema migration installs the restricted downtime configuration",
    );
    assert.deepEqual(
      getPrivateState("downtimeWorkflow"),
      {},
      "the schema migration installs the authoritative downtime workflow",
    );
    assert.deepEqual(
      getPrivateState("downtimeWorkflowCheckpoint"),
      {},
      "the schema migration installs the redundant downtime checkpoint",
    );
    assert.deepEqual(state.cleared.sort(), [
      "resourceConfig",
      "resourceRunState",
    ]);
    assert.deepEqual(legacy.resourceConfig, {});
    assert.deepEqual(legacy.resourceRunState, {});
  }

  // A schema flip after an awaited ownership repair fences the remainder of a
  // legacy migration before any private flags or legacy settings are written.
  {
    resetPrivateStateForTests();
    activeJournal = makeJournal();
    createCalls = 0;
    const data = makeStoreData({
      schemaVersion: 1,
      merchants: null,
      resourceConfig: null,
    });
    data.ownership = { default: 2 };
    const store = activeJournal.insert(data);
    const baseUpdate = store.update.bind(store);
    let flipped = false;
    store.update = async (changes) => {
      const result = await baseUpdate(changes);
      if (!flipped && Object.hasOwn(changes, "ownership")) {
        flipped = true;
        store.setFlagDirect("schemaVersion", FUTURE_SCHEMA);
        throw new Error("injected failure after schema quarantine");
      }
      return result;
    };
    const legacy = {
      merchants: [{ id: "must-survive-mid-migration-flip" }],
      resourceConfig: { roster: [{ actorId: "secret-roster" }] },
    };
    const gm = { id: "gm-a", isGM: true, role: 4, active: true };
    const state = configureGame({
      user: gm,
      users: makeUsers("gm-a", [gm]),
      journal: activeJournal,
      legacy,
    });

    const failedAfterBlock = await captureConsole("error", () =>
      assert.rejects(
        initializePrivateState(),
        /injected failure after schema quarantine/,
      ),
    );
    assert.equal(
      failedAfterBlock.messages.length,
      0,
      "a cancelled generation does not report a stale initialization failure",
    );
    assert.equal(getPrivateStateStatus().code, "future-schema");
    assert.equal(store.updateCalls.length, 1);
    assert.deepEqual(Object.keys(store.updateCalls[0]), ["ownership"]);
    assert.equal(legacy.merchants[0].id, "must-survive-mid-migration-flip");
    assert.equal(legacy.resourceConfig.roster[0].actorId, "secret-roster");
    assert.deepEqual(state.cleared, []);
  }

  // Reclassify after a caller's write precondition. A synchronous schema flip
  // there cannot slip a stale current-schema write into an upgraded store.
  {
    resetPrivateStateForTests();
    activeJournal = makeJournal();
    const store = activeJournal.insert(
      makeStoreData({ merchants: [{ id: "before-write-original" }] }),
    );
    const gm = { id: "gm-a", isGM: true, role: 4, active: true };
    configureGame({
      user: gm,
      users: makeUsers("gm-a", [gm]),
      journal: activeJournal,
      legacy: { privateStateStoreId: store.id },
    });
    assert.equal(await initializePrivateState(), true);
    const updateCount = store.updateCalls.length;

    await assert.rejects(
      setPrivateState("merchants", [{ id: "must-not-be-written" }], {
        beforeWrite: () => {
          store.setFlagDirect("schemaVersion", FUTURE_SCHEMA);
          return true;
        },
      }),
      (error) => error?.code === "PRIVATE_STATE_FUTURE_SCHEMA",
    );
    assert.equal(store.updateCalls.length, updateCount);
    assert.equal(
      store.getFlag(MODULE_ID, "merchants")[0].id,
      "before-write-original",
    );
    assert.equal(getPrivateStateStatus().code, "future-schema");
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
      [],
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
    assert.deepEqual(unavailable.messages, []);
    assert.equal(getPrivateStateStatus().code, "missing-store");
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
      (error) =>
        error?.code === "PRIVATE_STATE_UNAVAILABLE" &&
        error?.privateStateStatus?.code === "foundry-not-ready",
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
