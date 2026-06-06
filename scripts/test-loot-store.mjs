/**
 * Tests for the preset + roll-history store. Backs game.settings with an
 * in-memory map so save/list/delete/trim are exercised, then drops the
 * game global to confirm the node-safe fallback (no throw, no persist).
 */

import assert from "node:assert/strict";

const backing = new Map();
globalThis.game = {
  settings: {
    get: (mod, key) => backing.get(`${mod}.${key}`),
    set: async (mod, key, value) => {
      backing.set(`${mod}.${key}`, value);
    },
  },
};

const {
  listPresets,
  getPreset,
  savePreset,
  deletePreset,
  listHistory,
  pushHistory,
  clearHistory,
  HISTORY_LIMIT,
} = await import("./loot/loot-store.js");

/* ----------------------------- presets ----------------------------- */

assert.deepEqual(listPresets("toolA"), [], "starts empty");

const a = await savePreset("toolA", {
  name: "Boss Vault",
  form: { tier: "t4" },
});
assert.equal(listPresets("toolA").length, 1);
assert.equal(getPreset("toolA", a.id).form.tier, "t4");

// Same name (case-insensitive) replaces in place, keeping the id.
const a2 = await savePreset("toolA", {
  name: "boss vault",
  form: { tier: "t5" },
});
assert.equal(a2.id, a.id, "same-name preset reuses id");
assert.equal(listPresets("toolA").length, 1, "same-name does not duplicate");
assert.equal(getPreset("toolA", a.id).form.tier, "t5", "form updated");

await savePreset("toolA", { name: "Mooks", form: {} });
assert.equal(listPresets("toolA").length, 2);

// Tools are isolated.
assert.deepEqual(listPresets("toolB"), []);

await deletePreset("toolA", a.id);
assert.equal(listPresets("toolA").length, 1);
assert.equal(listPresets("toolA")[0].name, "Mooks");

/* ----------------------------- history ----------------------------- */

for (let i = 0; i < HISTORY_LIMIT + 5; i += 1) {
  await pushHistory("toolA", { form: { n: i }, result: { items: [] } });
}
const history = listHistory("toolA");
assert.equal(history.length, HISTORY_LIMIT, "history trimmed to the limit");
assert.equal(history[0].form.n, HISTORY_LIMIT + 4, "newest first");
assert.ok(
  history[0].id && history[0].at,
  "history entries carry id + timestamp",
);

await clearHistory("toolA");
assert.deepEqual(listHistory("toolA"), []);

/* --------------------- node fallback (no game) --------------------- */

delete globalThis.game;
assert.deepEqual(listPresets("toolA"), [], "no game → empty list, no throw");
const orphan = await savePreset("toolA", { name: "X", form: {} });
assert.ok(orphan.id, "savePreset still returns a preset object");
assert.deepEqual(listPresets("toolA"), [], "but nothing persists without game");
await clearHistory("toolA"); // must not throw

process.stdout.write("loot-store validation passed\n");
