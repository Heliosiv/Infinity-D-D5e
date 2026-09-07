import assert from "node:assert/strict";
import { prepareLearnedSpell } from "./downtime/spell-learning.js";
const moduleId = "infinity-dnd5e";
const settings = new Map();
const gm = { id: "gm", isGM: true, role: 4, active: true };
globalThis.CONST = { USER_ROLES: { GAMEMASTER: 4 } };
let seq = 0;
globalThis.foundry = {
  utils: { deepClone: structuredClone, randomID: () => `token-${++seq}` },
};
globalThis.game = {
  ready: false,
  user: gm,
  users: { activeGM: gm, get: () => gm, forEach: (fn) => fn(gm) },
  actors: new Map(),
  time: { serverTime: 1000 },
  settings: {
    get: (_m, key) => settings.get(key),
    set: async (_m, key, value) => {
      settings.set(key, structuredClone(value));
      return value;
    },
  },
};
const store = await import("./downtime/store.js");
const ledger = await import("./downtime/spellbook.js");
await store.ensureDowntimeWorkflowAuthority();
function actor(id) {
  const a = {
    id,
    flags: { ddbimporter: { dndbeyond: { characterId: "123" } } },
    items: new Map(),
    writes: 0,
    async createEmbeddedDocuments(_type, docs) {
      this.writes++;
      return docs.map((doc) => this.add(doc));
    },
    async deleteEmbeddedDocuments(_type, ids) {
      this.writes++;
      return ids.map((id) => {
        const item = this.items.get(id);
        this.items.delete(id);
        return item;
      });
    },
    add(source) {
      const item = {
        ...structuredClone(source),
        id: source._id,
        toObject() {
          const { id, toObject, ...data } = this;
          return structuredClone(data);
        },
      };
      this.items.set(item.id, item);
      return item;
    },
  };
  game.actors.set(id, a);
  return a;
}
const a = actor("wizard");
const snapshot = prepareLearnedSpell(
  {
    name: "Web",
    type: "spell",
    system: {
      level: 2,
      source: { rules: "2024" },
      activities: { cast: { type: "save" } },
    },
    effects: [],
  },
  {
    actor: a,
    operationId: "learn-web",
    learning: {
      uuid: "Item.web",
      edition: "2024",
      bookName: "Spellbook",
      sourceName: "Notes",
    },
  },
);
snapshot._id = "learnedWeb123456";
function seed(records) {
  const primary = structuredClone(settings.get("downtimeWorkflow"));
  primary.spellbooks = records;
  const checkpoint = structuredClone(
    settings.get("downtimeWorkflowCheckpoint"),
  );
  checkpoint.workflow = primary;
  settings.set("downtimeWorkflow", primary);
  settings.set("downtimeWorkflowCheckpoint", checkpoint);
  store.resetDowntimeWorkflowStoreForTests();
}
seed({
  "learn-web": {
    actorId: a.id,
    operationId: "learn-web",
    snapshot,
    forgotten: false,
  },
});
assert.equal((await ledger.reconcileSpellbook())[0].status, "restored");
assert.equal((await ledger.reconcileSpellbook())[0].status, "retained");
assert.equal(a.writes, 1, "repeated completion events cannot duplicate spells");
a.items.clear();
await Promise.all([ledger.reconcileSpellbook(), ledger.reconcileSpellbook()]);
assert.equal(a.items.size, 1, "concurrent imports serialize by Actor");
assert.equal(a.writes, 2);
a.items.clear();
a.add({
  ...snapshot,
  _id: "ddbReplacement",
  flags: { ddbimporter: { definitionId: 44 } },
});
assert.equal(
  (await ledger.reconcileSpellbook())[0].status,
  "retained",
  "DDB-owned matching spells are not duplicated",
);
a.add({ ...snapshot, _id: "duplicate" });
assert.equal(
  (await ledger.reconcileSpellbook())[0].status,
  "duplicate-needs-review",
);
assert.equal(a.writes, 2);
a.items.clear();
a.flags.ddbimporter.dndbeyond.characterId = "999";
assert.equal(
  (await ledger.reconcileSpellbook())[0].status,
  "character-link-needs-review",
);
a.flags.ddbimporter.dndbeyond.characterId = "123";
const replacement = actor("replacement");
await ledger.relinkSpellbook("learn-web", replacement.id);
assert.equal(replacement.items.size, 1);
assert.equal(a.items.size, 0);
await assert.rejects(
  ledger.relinkSpellbook("learn-web", "missing"),
  /same DDB/,
);
const oldDelete = replacement.deleteEmbeddedDocuments;
replacement.deleteEmbeddedDocuments = async () => [];
await assert.rejects(
  ledger.forgetLearnedSpell(replacement.id, "learn-web"),
  /could not be deleted/,
);
assert.equal(
  ledger.spellbookRecords()[0].forgotten,
  true,
  "tombstone survives a failed delete",
);
replacement.deleteEmbeddedDocuments = oldDelete;
await ledger.forgetLearnedSpell(replacement.id, "learn-web");
assert.equal(replacement.items.size, 0);
await ledger.reconcileSpellbook();
assert.equal(
  replacement.items.size,
  0,
  "intentional forgetting never resurrects",
);
const persisted = store.normalizeDowntimeWorkflowStore({
  ...store.loadDowntimeWorkflowStore(),
  history: [],
});
assert.equal(
  persisted.spellbooks["learn-web"].forgotten,
  true,
  "spellbooks and tombstones survive history pruning",
);
gm.role = 1;
gm.isGM = false;
assert.deepEqual(await ledger.reconcileSpellbook(), []);
await assert.rejects(
  ledger.forgetLearnedSpell(replacement.id, "learn-web"),
  /full GM/,
);
console.log(
  "Wizard spellbook ledger: reimports, concurrent events, duplicates, identity, replacement, forget recovery, retention and GM authority passed",
);
