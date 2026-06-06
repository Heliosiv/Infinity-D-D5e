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
  exportPresets,
  importPresets,
  parsePresetExport,
  PRESET_EXPORT_SCHEMA,
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

/* --------------------- preset export / import --------------------- */

// Export the surviving toolA preset ("Mooks").
const blob = exportPresets("toolA");
assert.equal(blob.schema, PRESET_EXPORT_SCHEMA);
assert.equal(blob.toolId, "toolA");
assert.equal(blob.presets.length, 1);
assert.equal(blob.presets[0].name, "Mooks");

// parsePresetExport rejects junk, wrong schema, and mismatched tool ids.
assert.deepEqual(parsePresetExport(null, "toolA"), []);
assert.deepEqual(
  parsePresetExport({ schema: "nope", presets: [] }, "toolA"),
  [],
);
assert.deepEqual(
  parsePresetExport(
    {
      schema: PRESET_EXPORT_SCHEMA,
      toolId: "other",
      presets: [{ name: "X", form: {} }],
    },
    "toolA",
  ),
  [],
  "mismatched toolId rejected",
);
assert.equal(
  parsePresetExport(
    {
      schema: PRESET_EXPORT_SCHEMA,
      toolId: "toolA",
      presets: [
        { name: "Good", form: { tier: "t2" } },
        { name: "", form: {} }, // no name → dropped
        { name: "NoForm" }, // no form → dropped
        null, // junk → dropped
      ],
    },
    "toolA",
  ).length,
  1,
  "only well-formed presets survive",
);

// Import into a fresh tool, then re-import to confirm in-place update.
const imported = await importPresets("toolC", {
  schema: PRESET_EXPORT_SCHEMA,
  toolId: "toolC",
  presets: [
    { name: "Alpha", form: { tier: "t1" } },
    { name: "Beta", form: { tier: "t3" } },
  ],
});
assert.equal(imported, 2, "import returns the count");
assert.equal(listPresets("toolC").length, 2);

const reimported = await importPresets("toolC", {
  schema: PRESET_EXPORT_SCHEMA,
  toolId: "toolC",
  presets: [{ name: "alpha", form: { tier: "t4" } }],
});
assert.equal(reimported, 1);
assert.equal(
  listPresets("toolC").length,
  2,
  "same-name import does not duplicate",
);
assert.equal(
  listPresets("toolC").find((p) => p.name.toLowerCase() === "alpha").form.tier,
  "t4",
  "same-name import updates the form in place",
);

assert.equal(
  await importPresets("toolC", { bogus: true }),
  0,
  "junk imports 0",
);

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
