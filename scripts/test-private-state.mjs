import assert from "node:assert/strict";

import {
  getPrivateState,
  initializePrivateState,
  resetPrivateStateForTests,
  setPrivateState,
} from "./private-state.js";

const saved = {
  game: globalThis.game,
  JournalEntry: globalThis.JournalEntry,
  CONST: globalThis.CONST,
};

try {
  const legacy = {
    merchants: [{ id: "m1", name: "Secret Shop", goldOnHand: 500 }],
    factions: [{ id: "f1", name: "Hidden Faction", gmNotes: "secret" }],
  };
  const cleared = [];
  const journal = [];
  globalThis.CONST = { DOCUMENT_OWNERSHIP_LEVELS: { NONE: 0 } };
  globalThis.game = {
    ready: true,
    user: { id: "gm", isGM: true },
    journal: { find: (predicate) => journal.find(predicate) ?? null },
    settings: {
      get: (_module, key) => legacy[key],
      async set(_module, key, value) {
        legacy[key] = value;
        cleared.push(key);
      },
    },
  };
  globalThis.JournalEntry = {
    async create(data) {
      const flags = structuredClone(data.flags);
      const document = {
        name: data.name,
        ownership: data.ownership,
        getFlag: (scope, key) => flags[scope]?.[key],
        async update(changes) {
          for (const [path, value] of Object.entries(changes)) {
            const match = /^flags\.infinity-dnd5e\.(.+)$/.exec(path);
            if (match) flags["infinity-dnd5e"][match[1]] = structuredClone(value);
          }
          return this;
        },
      };
      journal.push(document);
      return document;
    },
  };

  resetPrivateStateForTests();
  await initializePrivateState();
  assert.equal(journal.length, 1, "creates one restricted private-state journal");
  assert.equal(journal[0].ownership.default, 0, "private store defaults to NONE");
  assert.equal(getPrivateState("merchants")[0].goldOnHand, 500);
  assert.equal(getPrivateState("factions")[0].gmNotes, "secret");
  assert.deepEqual(cleared.sort(), ["factions", "merchants"]);
  assert.deepEqual(legacy.merchants, [], "legacy merchant setting is cleared");
  assert.deepEqual(legacy.factions, [], "legacy faction setting is cleared");

  await setPrivateState("merchants", [{ id: "m2", name: "Updated" }]);
  assert.equal(getPrivateState("merchants")[0].id, "m2");

  resetPrivateStateForTests();
  globalThis.game = {
    ready: true,
    user: { id: "player", isGM: false },
    journal: { find: () => journal[0] },
  };
  await initializePrivateState();
  assert.deepEqual(
    getPrivateState("merchants"),
    [],
    "players receive no private merchant records",
  );
  assert.deepEqual(
    getPrivateState("factions"),
    [],
    "players receive no unrevealed faction records",
  );

  process.stdout.write("private-state validation passed\n");
} finally {
  resetPrivateStateForTests();
  if (saved.game === undefined) delete globalThis.game;
  else globalThis.game = saved.game;
  if (saved.JournalEntry === undefined) delete globalThis.JournalEntry;
  else globalThis.JournalEntry = saved.JournalEntry;
  if (saved.CONST === undefined) delete globalThis.CONST;
  else globalThis.CONST = saved.CONST;
}
