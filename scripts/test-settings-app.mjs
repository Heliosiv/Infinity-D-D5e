import assert from "node:assert/strict";
import { createModuleRegistrars } from "./bootstrap/registrars.js";

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
{
  const previousGame = globalThis.game;
  globalThis.game = {
    user: { role: 4, isGM: true },
    settings: { get: () => undefined },
  };
  const app = new InfinitySettingsApp();
  app.element = { querySelector: () => null };
  app._markDirty({
    dataset: { settingKey: SETTING_KEYS.DEFAULT_PARTY_SIZE },
    type: "number",
    value: "7",
  });
  const context = await app._prepareContext();
  assert.equal(
    context.groups
      .flatMap((group) => group.fields)
      .find((field) => field.key === SETTING_KEYS.DEFAULT_PARTY_SIZE).value,
    "7",
    "refresh retains unsaved settings",
  );
  globalThis.game = previousGame;
}
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

{
  const registered = [];
  const menus = [];
  const densityChanges = [];
  const hookCalls = [];
  let preferencesChange = null;
  const root = {};
  const game = {
    settings: {
      register: (moduleId, key, options) =>
        registered.push({ moduleId, key, options }),
      registerMenu: (moduleId, key, options) =>
        menus.push({ moduleId, key, options }),
    },
  };
  const registrars = createModuleRegistrars({
    moduleId: "infinity-dnd5e",
    SETTINGS,
    InfinitySettingsApp,
    logger: { warn: () => {} },
    getGame: () => game,
    getDocument: () => ({ querySelectorAll: () => [root] }),
    getHooks: () => ({
      callAll: (...args) => hookCalls.push(args),
    }),
    registerUiPreferencesSetting: (_game, { onChange }) => {
      preferencesChange = onChange;
    },
    applyUiDensity: (...args) => densityChanges.push(args),
  });
  assert.equal(registrars.registerSettings(), true);
  assert.equal(registrars.registerSettings(), false);
  assert.equal(registered.length, SETTINGS.length);
  assert.ok(
    registered.every(({ options }) => options.config === false),
    "raw catalog controls stay hidden after role-aware parity coverage",
  );
  assert.deepEqual(
    registered.map(({ key }) => key),
    SETTINGS.map(({ key }) => key),
  );
  assert.equal(menus.length, 1);
  assert.equal(menus[0].key, "infinitySettings");
  assert.equal(menus[0].options.type, InfinitySettingsApp);

  const preferences = { density: "compact" };
  preferencesChange(preferences);
  assert.deepEqual(densityChanges, [[root, preferences]]);
  assert.deepEqual(hookCalls, [
    ["infinityDnd5eUiPreferencesChanged", preferences],
  ]);
}

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

{
  const previousGame = globalThis.game;
  const previousWarn = console.warn;
  const control = {
    dataset: { settingKey: SETTING_KEYS.DEFAULT_PARTY_SIZE },
    type: "number",
    value: "7",
  };
  const form = {
    querySelectorAll: () => [control],
    querySelector: () => ({ value: "comfortable" }),
  };
  const app = new InfinitySettingsApp();
  app.element = {
    querySelector: (selector) =>
      selector === "[data-infinity-settings-form]" ? form : null,
  };
  app.render = async () => {};
  let fail = true;
  globalThis.game = {
    user: { role: 4, isGM: true },
    settings: {
      get: () => undefined,
      set: async (_module, key) => {
        if (key === SETTING_KEYS.DEFAULT_PARTY_SIZE) {
          if (fail) throw Error("test save failure");
          control.value = "8";
          app._markDirty(control);
        }
      },
    },
  };
  console.warn = () => {};
  try {
    app._markDirty(control);
    await InfinitySettingsApp._onSave.call(app);
    assert.equal(
      app._draft.get(control.dataset.settingKey),
      "7",
      "failed save retains the attempted value",
    );
    assert.equal(app._dirty, true);
    await InfinitySettingsApp._onResetQuickStarts.call(app);
    assert.equal(
      app._draft.get(control.dataset.settingKey),
      "7",
      "Restore guides retains the draft",
    );
    assert.equal(app._dirty, true);
    fail = false;
    await InfinitySettingsApp._onSave.call(app);
    assert.equal(
      app._draft.get(control.dataset.settingKey),
      "8",
      "edits during an in-flight save are retained",
    );
    assert.equal(app._dirty, true);
  } finally {
    globalThis.game = previousGame;
    console.warn = previousWarn;
  }
}

process.stdout.write("role-aware settings app validation passed\n");
