import assert from "node:assert/strict";

import {
  getPrivateState,
  initializePrivateState,
  isPrivateStateReady,
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
    call(event, ...args) {
      for (const handler of listeners.get(event)?.values() ?? []) {
        handler(...args);
      }
    },
  };
}

let documentSeed = 0;
function makeDocument(data) {
  const flags = structuredClone(data.flags ?? {});
  return {
    id: `journal-${++documentSeed}`,
    name: data.name,
    ownership: data.ownership,
    getFlag: (scope, key) => flags[scope]?.[key],
    async update(changes) {
      for (const [path, value] of Object.entries(changes)) {
        const match = /^flags\.infinity-dnd5e\.(.+)$/.exec(path);
        if (match) flags[MODULE_ID][match[1]] = structuredClone(value);
      }
      globalThis.Hooks.call("updateJournalEntry", this, changes);
      return this;
    },
  };
}

function makeJournal() {
  const entries = [];
  return {
    entries,
    collection: {
      find: (predicate) => entries.find(predicate) ?? null,
    },
    insert(data) {
      const document = makeDocument(data);
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

function makeStoreData({ merchants = [], factions = [] } = {}) {
  return {
    name: "[Infinity D&D5e] Private State",
    ownership: { default: 0 },
    flags: {
      [MODULE_ID]: {
        privateStateStore: true,
        schemaVersion: 1,
        merchants,
        factions,
      },
    },
  };
}

function configureGame({
  user,
  users,
  journal,
  legacy = { merchants: [], factions: [] },
}) {
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
  globalThis.CONST = { DOCUMENT_OWNERSHIP_LEVELS: { NONE: 0 } };
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
    assert.deepEqual(state.cleared.sort(), ["factions", "merchants"]);
    assert.deepEqual(legacy.merchants, []);
    assert.deepEqual(legacy.factions, []);

    await setPrivateState("merchants", [{ id: "m2", name: "Updated" }]);
    assert.equal(getPrivateState("merchants")[0].id, "m2");
  }

  // A second GM never creates a competing store. It waits for the active GM's
  // document and then follows remote updates through Journal hooks.
  {
    resetPrivateStateForTests();
    activeJournal = makeJournal();
    createCalls = 0;
    const gmA = { id: "gm-a", isGM: true, active: true };
    const gmB = { id: "gm-b", isGM: true, active: true };
    configureGame({
      user: gmB,
      users: makeUsers("gm-a", [gmA, gmB]),
      journal: activeJournal,
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
    assert.equal(await waiting, true);
    assert.equal(getPrivateState("merchants")[0].id, "shared");

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
    assert.equal(isPrivateStateReady(), true);
    assert.equal(getPrivateState("merchants")[0].id, "replacement");
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
    assert.equal(await initializePrivateState(), false);
    assert.equal(isPrivateStateReady(), false);
    assert.equal(createCalls, 1);
    assert.equal(legacy.merchants[0].id, "keep-me");
    assert.equal(legacy.factions[0].id, "keep-me-too");

    failCreate = false;
    assert.equal(await initializePrivateState(), true);
    assert.equal(createCalls, 2, "a failed creation attempt remains retryable");
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
    await assert.rejects(
      setPrivateState("merchants", [{ id: "forged" }]),
      /PermissionDenied/,
    );
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
