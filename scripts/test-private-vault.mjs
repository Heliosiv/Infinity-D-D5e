import assert from "node:assert/strict";
import { applyFlagMerge } from "./test-utils/foundry-flags.mjs";
import {
  VAULT_FLAG,
  createPrivateVaultDocument,
  isPrivateVaultUnlocked,
  lockPrivateVault,
  preparePrivateVaultDocument,
  readPrivateFlag,
  unlockPrivateVault,
  writePrivateVaultDocument,
} from "./private-vault.js";
import {
  getPrivateState,
  getPrivateStateStatus,
  getPrivateStateRecoveryOverview,
  initializePrivateState,
  resetPrivateStateForTests,
  setPrivateState,
} from "./private-state.js";

const MODULE = "infinity-dnd5e";
const phrase = "synthetic test only amber linen compass";
const secret = "PRIVATE-VAULT-CANARY-bd5fd059";
const wire = [];
const handlers = new Map();
globalThis.Hooks = {
  on(event, fn) {
    const list = handlers.get(event) ?? new Map();
    const id = Symbol();
    list.set(id, fn);
    handlers.set(event, list);
    return id;
  },
  off(event, id) {
    handlers.get(event)?.delete(id);
  },
  callAll(event, ...args) {
    for (const fn of handlers.get(event)?.values() ?? []) fn(...args);
  },
};
const gm = { id: "gm", isGM: true, role: 4, active: true };
const player = { id: "player", isGM: false, role: 1, active: false };
const users = [gm, player];
users.get = (id) => users.find((user) => user.id === id);
const journal = [];
journal.get = (id) => journal.find((doc) => doc.id === id);
const settings = new Map();
globalThis.CONST = { USER_ROLES: { GAMEMASTER: 4 } };
globalThis.game = {
  ready: true,
  world: { id: "vault-test" },
  user: gm,
  users,
  journal,
  settings: {
    get: (_scope, key) => settings.get(key),
    async set(_scope, key, value) {
      settings.set(key, structuredClone(value));
    },
  },
};
let nextId = 0;
globalThis.foundry = { utils: { randomID: () => `generated-${++nextId}` } };
function document(data) {
  return {
    id: data._id,
    flags: structuredClone(data.flags),
    ownership: data.ownership,
    getFlag(scope, key) {
      return this.flags[scope]?.[key];
    },
    async update(changes) {
      wire.push(structuredClone(changes));
      for (const [path, value] of Object.entries(changes)) {
        if (path === "ownership") this.ownership = structuredClone(value);
        const prefix = `flags.${MODULE}.`;
        if (!path.startsWith(prefix)) continue;
        const nested = path
          .slice(prefix.length)
          .split(".")
          .reduceRight((result, key) => ({ [key]: result }), value);
        this.flags[MODULE] = applyFlagMerge(this.flags[MODULE], nested);
      }
      Hooks.callAll("updateJournalEntry", this);
      return this;
    },
  };
}
globalThis.JournalEntry = {
  async create(data) {
    wire.push(structuredClone(data));
    const doc = document(data);
    journal.push(doc);
    Hooks.callAll("createJournalEntry", doc);
    return doc;
  },
};

await assert.rejects(() => unlockPrivateVault("short"), /passphrase-too-short/);
await unlockPrivateVault(phrase);
const payload = {
  downtimeConfig: { hidden: secret },
  downtimeWorkflow: { history: [secret] },
};
const keys = Object.keys(payload);
const doc = await createPrivateVaultDocument(
  {
    flags: { [MODULE]: { privateStateStore: true, schemaVersion: 8 } },
    ownership: { default: 0 },
  },
  payload,
  keys,
);
assert.equal(
  JSON.stringify(wire).includes(secret),
  false,
  "no plaintext create request",
);
assert.equal(doc.getFlag(MODULE, "downtimeConfig"), undefined);
assert.deepEqual(
  readPrivateFlag(doc, "downtimeConfig"),
  payload.downtimeConfig,
);
const first = doc.getFlag(MODULE, VAULT_FLAG);
await writePrivateVaultDocument(
  doc,
  { ...payload, downtimeConfig: { hidden: secret, changed: true } },
  keys,
);
assert.notEqual(
  doc.getFlag(MODULE, VAULT_FLAG),
  first,
  "fresh nonce on each encryption",
);
assert.equal(
  JSON.stringify(wire).includes(secret),
  false,
  "no plaintext update request",
);

assert.equal(
  doc.getFlag(MODULE, VAULT_FLAG).fields.downtimeWorkflow,
  first.fields.downtimeWorkflow,
  "unmodified history ciphertext is retained",
);
assert.equal(
  JSON.stringify(wire.at(-1)).includes(first.fields.downtimeWorkflow),
  false,
  "a configuration edit does not resend history",
);
const configCipher = doc.getFlag(MODULE, VAULT_FLAG).fields.downtimeConfig;
doc.flags[MODULE][VAULT_FLAG].fields.downtimeConfig =
  first.fields.downtimeWorkflow;
await assert.rejects(
  () => preparePrivateVaultDocument(doc),
  /authentication-failed/,
  "ciphertext cannot be moved between fields",
);
doc.flags[MODULE][VAULT_FLAG].fields.downtimeConfig = configCipher;
const beforeLockRace = wire.length;
const interrupted = writePrivateVaultDocument(
  doc,
  { ...payload, downtimeConfig: { hidden: "interrupted" } },
  keys,
);
lockPrivateVault();
await assert.rejects(() => interrupted, /session-changed|locked/);
assert.equal(
  wire.length,
  beforeLockRace,
  "locking during encryption prevents the write",
);
await unlockPrivateVault(phrase, [doc]);

const acceptedConfig = readPrivateFlag(doc, "downtimeConfig");
for (let attempt = 0; attempt < 4; attempt++) {
  await assert.rejects(
    () =>
      writePrivateVaultDocument(
        doc,
        { ...payload, downtimeConfig: { attempt } },
        keys,
        { beforeCommit: () => false },
      ),
    /write-fence-changed/,
  );
  assert.deepEqual(
    readPrivateFlag(doc, "downtimeConfig"),
    acceptedConfig,
    "rejected encryption attempts cannot evict the accepted plaintext cache",
  );
}

// A new GM session must authenticate. A wrong phrase never mutates data.
lockPrivateVault();
assert.equal(readPrivateFlag(doc, "downtimeConfig"), undefined);
const beforeWrong = JSON.stringify(doc.flags);
await assert.rejects(
  () => unlockPrivateVault("a completely different passphrase", [doc]),
  /authentication-failed/,
);
assert.equal(isPrivateVaultUnlocked(), false);
assert.equal(JSON.stringify(doc.flags), beforeWrong);
await unlockPrivateVault(phrase, [doc]);
assert.deepEqual(
  readPrivateFlag(doc, "downtimeWorkflow"),
  payload.downtimeWorkflow,
);

// Neither another document nor another world can reuse a copied envelope.
const copied = document({ _id: "another-document", flags: doc.flags });
await assert.rejects(
  () => preparePrivateVaultDocument(copied),
  /authentication-failed/,
);
game.world.id = "another-world";
await assert.rejects(
  () => unlockPrivateVault(phrase, [doc]),
  /authentication-failed/,
);
game.world.id = "vault-test";
await unlockPrivateVault(phrase, [doc]);
const envelope = JSON.parse(
  doc.flags[MODULE][VAULT_FLAG].fields.downtimeConfig,
);
const original = doc.flags[MODULE][VAULT_FLAG];
envelope.data = (envelope.data[0] === "A" ? "B" : "A") + envelope.data.slice(1);
doc.flags[MODULE][VAULT_FLAG] = structuredClone(original);
doc.flags[MODULE][VAULT_FLAG].fields.downtimeConfig = JSON.stringify(envelope);
await assert.rejects(
  () => preparePrivateVaultDocument(doc),
  /authentication-failed/,
);
assert.equal(
  readPrivateFlag(doc, "downtimeConfig"),
  undefined,
  "tampered envelope cannot reuse cached plaintext",
);
doc.flags[MODULE][VAULT_FLAG] = original;

// Key and authority fences prevent writes after demotion or a stale decision.
let count = wire.length;
await assert.rejects(
  () =>
    writePrivateVaultDocument(doc, payload, keys, { isCurrent: () => false }),
  /write-fence-changed/,
);
assert.equal(wire.length, count);
game.user = player;
assert.equal(readPrivateFlag(doc, "downtimeConfig"), undefined);
await assert.rejects(
  () => writePrivateVaultDocument(doc, payload, keys),
  /gm-required/,
);
await assert.rejects(() => unlockPrivateVault(phrase, [doc]), /gm-required/);
assert.equal(wire.length, count);
game.user = gm;

// Run the actual private-state lifecycle with real encryption and raw Journal
// documents, including old settings and a duplicate recovery copy.
resetPrivateStateForTests();
lockPrivateVault();
journal.length = 0;
wire.length = 0;
const legacy = document({
  _id: "legacy",
  ownership: { default: 0 },
  flags: {
    [MODULE]: {
      privateStateStore: true,
      schemaVersion: 6,
      privateStateRecoverySource: { sourceFingerprint: secret },
      merchants: [{ id: secret }],
      factions: [],
      downtimeConfig: { hidden: secret },
      downtimeWorkflow: { history: [secret] },
    },
  },
});
const duplicate = document({
  _id: "recovery-copy",
  ownership: { default: 0 },
  flags: structuredClone(legacy.flags),
});
journal.push(legacy, duplicate);
settings.set("privateStateStoreId", legacy.id);
settings.set("merchants", [{ id: "obsolete legacy setting" }]);
settings.set("factions", []);
settings.set("resourceConfig", { saved: secret });
settings.set("resourceRunState", {});
assert.equal(await initializePrivateState(), false);
assert.equal(getPrivateStateStatus().code, "vault-locked");
assert.equal((await getPrivateStateRecoveryOverview()).canCreateEmpty, false);
assert.equal(
  wire.length,
  0,
  "locked initialization never migrates or replaces data",
);
await unlockPrivateVault(phrase, journal);
player.active = true;
assert.equal(await initializePrivateState(), false);
assert.equal(getPrivateStateStatus().code, "vault-migration-players-connected");
assert.equal(wire.length, 0);
player.active = false;
assert.equal(await initializePrivateState(), true);
assert.deepEqual(getPrivateState("downtimeWorkflow"), { history: [secret] });
assert.deepEqual(getPrivateState("resourceConfig"), { saved: secret });
assert.deepEqual(settings.get("resourceConfig"), {});
assert.deepEqual(settings.get("merchants"), []);
assert.equal(
  JSON.stringify(journal.map((entry) => entry.flags)).includes(secret),
  false,
  "all migrated copies are ciphertext",
);
assert.equal(
  JSON.stringify(wire).includes(secret),
  false,
  "migration never transmits plaintext",
);
assert.deepEqual(readPrivateFlag(duplicate, "downtimeConfig"), {
  hidden: secret,
});
assert.equal(legacy.getFlag(MODULE, "schemaVersion"), 8);
assert.equal(legacy.getFlag(MODULE, "privateStateRecoverySource"), undefined);
assert.deepEqual(readPrivateFlag(duplicate, "privateStateRecoverySource"), {
  sourceFingerprint: secret,
});
await setPrivateState("downtimeConfig", { replaced: secret });
assert.deepEqual(getPrivateState("downtimeConfig"), { replaced: secret });
assert.deepEqual(
  getPrivateState("downtimeWorkflow"),
  { history: [secret] },
  "atomic replacement preserves other fields",
);
assert.equal(JSON.stringify(wire).includes(secret), false);

await Promise.all([
  setPrivateState("downtimeConfig", { replaced: secret }),
  setPrivateState("resourceConfig", { simultaneous: secret }),
]);
assert.deepEqual(getPrivateState("resourceConfig"), { simultaneous: secret });
assert.deepEqual(getPrivateState("downtimeConfig"), { replaced: secret });

const guardedPrevious = JSON.stringify(getPrivateState("resourceConfig"));
await setPrivateState(
  "resourceConfig",
  { guarded: secret },
  {
    beforeWrite: () =>
      JSON.stringify(getPrivateState("resourceConfig")) === guardedPrevious,
    afterWrite: () => getPrivateState("resourceConfig").guarded === secret,
  },
);
assert.deepEqual(
  getPrivateState("resourceConfig"),
  { guarded: secret },
  "old-state preconditions are not incorrectly rerun after the accepted write",
);

// A reload with no key is closed. Unlock restores durable data, not defaults.
resetPrivateStateForTests();
lockPrivateVault();
count = wire.length;
assert.equal(await initializePrivateState(), false);
assert.equal(wire.length, count);
await unlockPrivateVault(phrase, journal);
assert.equal(await initializePrivateState(), true);
assert.deepEqual(getPrivateState("downtimeConfig"), { replaced: secret });
assert.equal(
  wire.length,
  count,
  "unlocking an intact migrated world is read-only",
);
game.user = player;
assert.deepEqual(
  getPrivateState("downtimeConfig"),
  {},
  "role changes cannot expose a previously hydrated GM cache even before a role hook runs",
);
game.user = gm;

console.log(
  "Private vault: wire secrecy, authenticated reload, wrong key, tampering, world/document binding, role/write fences, legacy preservation, duplicate sealing and locked recovery passed.",
);
resetPrivateStateForTests();
lockPrivateVault();
