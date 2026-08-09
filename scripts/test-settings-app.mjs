import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

globalThis.foundry = {
  applications: {
    api: {
      ApplicationV2: class {},
      HandlebarsApplicationMixin: (Base) => class extends Base {},
    },
  },
};

const {
  buildSettingsGroups,
  coerceSettingValue,
  InfinitySettingsApp,
  SETTINGS_GROUPS,
} = await import("./settings-app.js");
const { SETTINGS, SETTING_KEYS } = await import("./settings.js");

const clientGroups = buildSettingsGroups({ fullGm: false });
assert.ok(clientGroups.length > 0, "players receive client-scoped settings");
assert.ok(
  clientGroups
    .flatMap((group) => group.fields)
    .every((field) => field.scope === "client"),
  "players never receive world-scoped settings",
);

const gmGroups = buildSettingsGroups({ fullGm: true });
const gmKeys = new Set(
  gmGroups.flatMap((group) => group.fields.map((field) => field.key)),
);
for (const entry of SETTINGS.filter((candidate) => candidate.config === true)) {
  assert.ok(gmKeys.has(entry.key), `GM settings include ${entry.key}`);
}

const partyEntry = SETTINGS.find(
  (entry) => entry.key === SETTING_KEYS.DEFAULT_PARTY_SIZE,
);
assert.equal(
  coerceSettingValue(partyEntry, { value: "999" }),
  10,
  "numeric values clamp to catalog maximum",
);

const soundEntry = SETTINGS.find(
  (entry) => entry.key === SETTING_KEYS.SOUNDS_ENABLED,
);
assert.equal(coerceSettingValue(soundEntry, { checked: false }), false);
assert.equal(coerceSettingValue(soundEntry, { checked: true }), true);

assert.equal(
  new Set(SETTINGS_GROUPS.map((group) => group.id)).size,
  SETTINGS_GROUPS.length,
  "settings group ids are unique",
);

const moduleSource = readFileSync("scripts/module.js", "utf8");
assert.match(
  moduleSource,
  /game\.settings\.registerMenu\(MODULE_ID, "infinitySettings"/,
  "Foundry Module Settings exposes one Infinity Settings application",
);
assert.match(
  moduleSource,
  /const opts = \{[\s\S]*?config: false,/,
  "raw catalog controls stay hidden after the parity assertion above",
);

{
  const previousGame = globalThis.game;
  const previousWarn = console.warn;
  const warnings = [];
  const form = {
    querySelectorAll: () => [],
    querySelector: (selector) =>
      selector === '[name="uiDensity"]' ? { value: "compact" } : null,
  };
  const app = {
    element: {
      querySelector: (selector) =>
        selector === "[data-infinity-settings-form]" ? form : null,
    },
    _dirty: false,
    _status: "",
    _statusTone: "neutral",
    render: async () => {},
  };
  globalThis.game = {
    settings: {
      get: () => undefined,
      set: async () => {
        throw new Error("preference persistence unavailable");
      },
    },
  };
  console.warn = (...args) => warnings.push(args);
  try {
    await InfinitySettingsApp._onSave.call(app);
    assert.equal(app._dirty, true);
    assert.equal(app._statusTone, "danger");
    assert.match(app._status, /Interface density/);
    assert.equal(warnings.length, 1);
  } finally {
    console.warn = previousWarn;
    if (previousGame === undefined) delete globalThis.game;
    else globalThis.game = previousGame;
  }
}

process.stdout.write("role-aware settings app validation passed\n");
