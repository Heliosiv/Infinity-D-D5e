import assert from "node:assert/strict";

import {
  SETTINGS,
  SETTING_KEYS,
  SETTINGS_MODULE_ID,
  getSetting,
  parseRaritiesSetting,
} from "./settings.js";
import { RARITIES } from "./loot/tag-vocabulary.js";

/* ------------------------------------------------------------------ *
 * Catalog shape sanity
 * ------------------------------------------------------------------ */
{
  assert.equal(SETTINGS_MODULE_ID, "infinity-dnd5e");
  assert.ok(Array.isArray(SETTINGS), "SETTINGS is an array");
  assert.ok(SETTINGS.length >= 10, "ships a meaningful number of settings");

  const seen = new Set();
  for (const entry of SETTINGS) {
    // Every entry has the required keys.
    assert.ok(entry.key, "missing key");
    assert.ok(entry.name, `setting "${entry.key}" missing name`);
    assert.ok(typeof entry.hint === "string", `${entry.key} missing hint`);
    assert.ok(
      ["world", "client"].includes(entry.scope),
      `${entry.key} scope must be world or client`,
    );
    assert.ok(
      [Boolean, Number, String].includes(entry.type),
      `${entry.key} type must be one of the supported primitives`,
    );
    assert.notEqual(entry.default, undefined, `${entry.key} missing default`);

    // No duplicate keys.
    assert.ok(!seen.has(entry.key), `duplicate setting key: ${entry.key}`);
    seen.add(entry.key);
  }
}

/* ------------------------------------------------------------------ *
 * SETTING_KEYS index covers every entry in the catalog
 * ------------------------------------------------------------------ */
{
  const keysInCatalog = new Set(SETTINGS.map((entry) => entry.key));
  for (const exposedKey of Object.values(SETTING_KEYS)) {
    assert.ok(
      keysInCatalog.has(exposedKey),
      `SETTING_KEYS exposes "${exposedKey}" but it isn't in SETTINGS`,
    );
  }
  // And vice versa — every catalog entry has a SETTING_KEYS alias so
  // callers can refer to it by constant rather than string literal.
  const exposed = new Set(Object.values(SETTING_KEYS));
  for (const entry of SETTINGS) {
    assert.ok(
      exposed.has(entry.key),
      `SETTINGS has "${entry.key}" but SETTING_KEYS doesn't expose it`,
    );
  }
}

/* ------------------------------------------------------------------ *
 * Choice-typed settings list a default that's actually a valid choice
 * ------------------------------------------------------------------ */
{
  for (const entry of SETTINGS) {
    if (!entry.choices) continue;
    const valid = Object.keys(entry.choices);
    assert.ok(
      valid.includes(String(entry.default)),
      `${entry.key} default "${entry.default}" must be one of [${valid.join(", ")}]`,
    );
  }
}

/* ------------------------------------------------------------------ *
 * getSetting — falls back to the catalog default when game isn't ready
 * ------------------------------------------------------------------ */
{
  // No globalThis.game here, so every read should return the default.
  for (const entry of SETTINGS) {
    assert.deepEqual(
      getSetting(entry.key),
      entry.default,
      `${entry.key} should fall back to its registered default`,
    );
  }
  // Unknown keys return undefined cleanly, not throw.
  assert.equal(getSetting("not-a-real-key"), undefined);
  assert.equal(getSetting(SETTING_KEYS.SOUNDS_ENABLED), true);
  assert.equal(getSetting(SETTING_KEYS.SOUND_VOLUME), 0.35);
}

/* ------------------------------------------------------------------ *
 * getSetting — honors a mocked game.settings.get
 * ------------------------------------------------------------------ */
{
  const original = globalThis.game;
  globalThis.game = {
    settings: {
      get(moduleId, key) {
        if (moduleId !== "infinity-dnd5e") return undefined;
        if (key === SETTING_KEYS.DEFAULT_TIER) return "t4";
        if (key === SETTING_KEYS.ANIMATIONS) return false;
        if (key === SETTING_KEYS.SOUND_VOLUME) return 0.65;
        return undefined;
      },
    },
  };
  try {
    assert.equal(getSetting(SETTING_KEYS.DEFAULT_TIER), "t4");
    assert.equal(getSetting(SETTING_KEYS.ANIMATIONS), false);
    assert.equal(getSetting(SETTING_KEYS.SOUND_VOLUME), 0.65);
    // Keys the mock returns `undefined` for still fall back.
    assert.equal(getSetting(SETTING_KEYS.DEFAULT_COUNT), 0);
  } finally {
    if (original === undefined) delete globalThis.game;
    else globalThis.game = original;
  }
}

/* ------------------------------------------------------------------ *
 * parseRaritiesSetting — tolerant of casing, whitespace, junk
 * ------------------------------------------------------------------ */
{
  assert.deepEqual(parseRaritiesSetting("uncommon,rare", RARITIES), [
    "uncommon",
    "rare",
  ]);
  assert.deepEqual(
    parseRaritiesSetting("  Rare , very-rare ,Garbage,, ", RARITIES),
    ["rare", "very-rare"],
    "casing / whitespace / unknown entries are normalized away",
  );
  assert.deepEqual(parseRaritiesSetting("", RARITIES), [], "empty → empty");
  assert.deepEqual(
    parseRaritiesSetting("rare,rare,rare", RARITIES),
    ["rare"],
    "dedupes repeats",
  );
  assert.deepEqual(parseRaritiesSetting(null, RARITIES), [], "null is safe");
  assert.deepEqual(
    parseRaritiesSetting("anything", []),
    ["anything"],
    "with no validRarities list, accepts any non-empty token",
  );
}

process.stdout.write("settings validation passed\n");
