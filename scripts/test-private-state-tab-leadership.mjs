import assert from "node:assert/strict";

const MODULE_ID = "infinity-dnd5e";

function deferred() {
  let resolve;
  const promise = new Promise((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

function makeWebLocks() {
  let grants = false;
  const requests = [];
  const waiting = new Set();

  function grant(waiter) {
    if (!waiting.delete(waiter)) return;
    Promise.resolve(
      waiter.callback({ name: waiter.name, mode: "exclusive" }),
    ).then(waiter.resolve, waiter.reject);
  }

  return {
    requests,
    setGrants(value) {
      grants = value === true;
      if (grants) {
        for (const waiter of [...waiting]) grant(waiter);
      }
    },
    async request(name, options, callback) {
      requests.push({ name, mode: options?.mode ?? null });
      if (grants) return callback({ name, mode: "exclusive" });
      return new Promise((resolve, reject) => {
        const waiter = { callback, name, reject, resolve };
        waiting.add(waiter);
        options?.signal?.addEventListener?.(
          "abort",
          () => {
            waiting.delete(waiter);
            resolve(false);
          },
          { once: true },
        );
      });
    },
  };
}

function makeHooks() {
  return {
    call() {},
    callAll() {},
  };
}

function makeUsers(user) {
  return {
    activeGM: user,
    get: (id) => (id === user.id ? user : null),
    forEach: (callback) => callback(user),
  };
}

let documentSeed = 0;
function makeDocument(data, { updateGate = null } = {}) {
  const flags = structuredClone(data.flags ?? {});
  const document = {
    id: `journal-${++documentSeed}`,
    _stats: { createdTime: documentSeed },
    name: data.name,
    ownership: structuredClone(data.ownership),
    updateCalls: [],
    getFlag(scope, key) {
      return flags[scope]?.[key];
    },
    async update(changes) {
      this.updateCalls.push(structuredClone(changes));
      if (updateGate && this.updateCalls.length === 1) {
        updateGate.started.resolve();
        await updateGate.release.promise;
      }
      for (const [path, value] of Object.entries(changes)) {
        if (path === "ownership") {
          this.ownership = structuredClone(value);
          continue;
        }
        const match = /^flags\.infinity-dnd5e\.(.+)$/u.exec(path);
        if (match) flags[MODULE_ID][match[1]] = structuredClone(value);
      }
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
    insert(data, options) {
      const document = makeDocument(data, options);
      entries.push(document);
      return document;
    },
  };
}

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

function makeStoreData({
  schemaVersion,
  resourceConfig = {},
  includeMerchantTransactions = true,
} = {}) {
  return {
    name: "[Infinity D&D5e] Private State",
    ownership: { default: 0 },
    flags: {
      [MODULE_ID]: {
        privateStateStore: true,
        schemaVersion,
        merchants: [],
        merchantAccess: {},
        ...(includeMerchantTransactions
          ? { merchantTransactions: emptyMerchantTransactions() }
          : {}),
        factions: [],
        resourceConfig,
        resourceRunState: {},
        criticalInjuryWorkflow: {},
        criticalInjuryWorkflowCheckpoint: {},
        downtimeConfig: {},
        downtimeWorkflow: {},
        downtimeWorkflowCheckpoint: {},
      },
    },
  };
}

function configureGame({ journal, storeId = "", legacy = {} }) {
  const user = { id: "gm-a", name: "GM A", isGM: true, role: 4, active: true };
  const values = {
    privateStateStoreId: storeId,
    merchants: [],
    factions: [],
    resourceConfig: {},
    resourceRunState: {},
    ...legacy,
  };
  const settingWrites = [];
  globalThis.game = {
    ready: true,
    world: { id: "leadership-regression-world" },
    user,
    users: makeUsers(user),
    journal: journal.collection,
    settings: {
      get: (_moduleId, key) => values[key],
      async set(_moduleId, key, value) {
        settingWrites.push({ key, value: structuredClone(value) });
        values[key] = structuredClone(value);
        return value;
      },
    },
  };
  return { settingWrites, values };
}

async function waitFor(predicate, message) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (predicate()) return;
    await new Promise((resolve) => globalThis.setTimeout(resolve, 0));
  }
  assert.fail(message);
}

const saved = {
  navigator: Object.getOwnPropertyDescriptor(globalThis, "navigator"),
  window: Object.getOwnPropertyDescriptor(globalThis, "window"),
  game: Object.getOwnPropertyDescriptor(globalThis, "game"),
  Hooks: Object.getOwnPropertyDescriptor(globalThis, "Hooks"),
  JournalEntry: Object.getOwnPropertyDescriptor(globalThis, "JournalEntry"),
  CONST: Object.getOwnPropertyDescriptor(globalThis, "CONST"),
};

function restoreGlobal(name, descriptor) {
  if (descriptor) Object.defineProperty(globalThis, name, descriptor);
  else delete globalThis[name];
}

const webLocks = makeWebLocks();
Object.defineProperty(globalThis, "navigator", {
  configurable: true,
  writable: true,
  value: { locks: webLocks },
});
globalThis.window = { document: {} };
globalThis.Hooks = makeHooks();
globalThis.CONST = {
  DOCUMENT_OWNERSHIP_LEVELS: { NONE: 0 },
  USER_ROLES: { GAMEMASTER: 4 },
};

let activeJournal = makeJournal();
let createCalls = 0;
let createGate = null;
globalThis.JournalEntry = {
  async create(data) {
    createCalls += 1;
    if (createGate) {
      createGate.started.resolve();
      const document = await createGate.release.promise;
      activeJournal.entries.push(document);
      return document;
    }
    return activeJournal.insert(data);
  },
};

const privateState = await import("./private-state.js");
const leadership = await import("./campaign-tab-leadership.js");
const CURRENT_SCHEMA = privateState.PRIVATE_STATE_SCHEMA_VERSION;

try {
  // A same-user follower can inspect a verified canonical store, but hydration
  // must not update the Journal, settings, or any legacy source.
  {
    privateState.resetPrivateStateForTests();
    leadership.releaseCampaignTabLeadership();
    webLocks.setGrants(false);
    activeJournal = makeJournal();
    createCalls = 0;
    createGate = null;
    const store = activeJournal.insert(
      makeStoreData({
        schemaVersion: CURRENT_SCHEMA,
        resourceConfig: { version: 5, marker: "follower-read-only" },
      }),
    );
    const state = configureGame({
      journal: activeJournal,
      storeId: store.id,
      legacy: {
        merchants: [{ id: "legacy-follower-merchant" }],
        factions: [{ id: "legacy-follower-faction" }],
        resourceConfig: { marker: "legacy-follower-resource" },
        resourceRunState: { lastSeenDay: 99 },
      },
    });

    assert.equal(await privateState.initializePrivateState(), true);
    assert.equal(
      privateState.getPrivateState("resourceConfig").marker,
      "follower-read-only",
    );
    assert.equal(createCalls, 0);
    assert.deepEqual(store.updateCalls, []);
    assert.deepEqual(state.settingWrites, []);

    webLocks.setGrants(true);
    await waitFor(
      () => leadership.hasCampaignTabLeadership(),
      "the waiting follower did not acquire campaign leadership",
    );
    assert.equal(await privateState.initializePrivateState(), true);
    assert.equal(
      createCalls,
      0,
      "writer finalization reuses the canonical store",
    );
    assert.deepEqual(
      store.updateCalls,
      [],
      "writer finalization does not rewrite the current canonical store",
    );
    assert.equal(
      store.getFlag(MODULE_ID, "resourceConfig").marker,
      "follower-read-only",
    );
    assert.deepEqual(state.values.merchants, []);
    assert.deepEqual(state.values.factions, []);
    assert.deepEqual(state.values.resourceConfig, {});
    assert.deepEqual(state.values.resourceRunState, {});
    assert.deepEqual(state.settingWrites.map(({ key }) => key).sort(), [
      "factions",
      "merchants",
      "resourceConfig",
      "resourceRunState",
    ]);
  }

  // A follower in a fresh world returns unavailable without creating or
  // binding an empty private-state Journal.
  {
    privateState.resetPrivateStateForTests();
    leadership.releaseCampaignTabLeadership();
    webLocks.setGrants(false);
    activeJournal = makeJournal();
    createCalls = 0;
    createGate = null;
    const state = configureGame({ journal: activeJournal });

    assert.equal(await privateState.initializePrivateState(), false);
    assert.equal(createCalls, 0);
    assert.equal(activeJournal.entries.length, 0);
    assert.deepEqual(state.settingWrites, []);
    assert.equal(privateState.getPrivateState("resourceConfig"), undefined);
  }

  // If leadership is lost while Journal creation is awaiting Foundry, the
  // already-started create may resolve, but this tab must not bind it, migrate
  // it, clear legacy settings, or expose it as ready.
  {
    privateState.resetPrivateStateForTests();
    leadership.releaseCampaignTabLeadership();
    webLocks.setGrants(true);
    activeJournal = makeJournal();
    createCalls = 0;
    createGate = { started: deferred(), release: deferred() };
    const state = configureGame({
      journal: activeJournal,
      legacy: {
        merchants: [{ id: "legacy-secret" }],
        resourceConfig: { marker: "legacy-resource" },
      },
    });

    const initialization = privateState.initializePrivateState();
    await createGate.started.promise;
    leadership.releaseCampaignTabLeadership();
    const created = makeDocument(
      makeStoreData({ schemaVersion: CURRENT_SCHEMA }),
    );
    createGate.release.resolve(created);

    assert.equal(await initialization, false);
    assert.equal(createCalls, 1);
    assert.equal(activeJournal.entries.length, 1);
    assert.deepEqual(created.updateCalls, []);
    assert.deepEqual(state.settingWrites, []);
    assert.equal(state.values.privateStateStoreId, "");
    assert.equal(state.values.merchants[0].id, "legacy-secret");
    assert.equal(privateState.getPrivateState("merchants"), undefined);
  }

  // If leadership is lost while a schema migration write is in flight, its
  // completion cannot authorize the next schema write, bind the cache, or
  // clear the legacy source.
  {
    privateState.resetPrivateStateForTests();
    leadership.releaseCampaignTabLeadership();
    webLocks.setGrants(true);
    activeJournal = makeJournal();
    createCalls = 0;
    createGate = null;
    const updateGate = { started: deferred(), release: deferred() };
    const store = activeJournal.insert(
      makeStoreData({
        schemaVersion: CURRENT_SCHEMA - 1,
        includeMerchantTransactions: false,
      }),
      { updateGate },
    );
    const state = configureGame({
      journal: activeJournal,
      storeId: store.id,
      legacy: { merchants: [{ id: "migration-source" }] },
    });

    const initialization = privateState.initializePrivateState();
    await updateGate.started.promise;
    leadership.releaseCampaignTabLeadership();
    updateGate.release.resolve();

    assert.equal(await initialization, false);
    assert.equal(createCalls, 0);
    assert.equal(store.updateCalls.length, 1);
    assert.deepEqual(Object.keys(store.updateCalls[0]), [
      `flags.${MODULE_ID}.merchantTransactions`,
    ]);
    assert.equal(store.getFlag(MODULE_ID, "schemaVersion"), CURRENT_SCHEMA - 1);
    assert.deepEqual(state.settingWrites, []);
    assert.equal(state.values.merchants[0].id, "migration-source");
    assert.equal(privateState.getPrivateState("merchants"), undefined);
  }

  assert.ok(
    webLocks.requests.every(
      ({ name, mode }) =>
        name ===
          `${MODULE_ID}:merchant-authority:leadership-regression-world:gm-a` &&
        mode === "exclusive",
    ),
    "the isolated suite exercised the shared campaign Web Lock",
  );
  process.stdout.write("private-state tab leadership validation passed\n");
} finally {
  privateState.resetPrivateStateForTests();
  leadership.releaseCampaignTabLeadership();
  restoreGlobal("navigator", saved.navigator);
  restoreGlobal("window", saved.window);
  restoreGlobal("game", saved.game);
  restoreGlobal("Hooks", saved.Hooks);
  restoreGlobal("JournalEntry", saved.JournalEntry);
  restoreGlobal("CONST", saved.CONST);
}
