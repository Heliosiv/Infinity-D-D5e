import assert from "node:assert/strict";

const savedFoundry = globalThis.foundry;
const savedGame = globalThis.game;
const savedConst = globalThis.CONST;
const savedUi = globalThis.ui;

const gm = { id: "gm", name: "GM", role: 4, isGM: true, active: true };
const users = [gm];
users.activeGM = gm;
users.get = (id) => users.find((user) => user.id === id) ?? null;
const warnings = [];
const settings = new Map([["soundsEnabled", false]]);
let writeCount = 0;

try {
  globalThis.CONST = { USER_ROLES: { GAMEMASTER: 4 } };
  globalThis.foundry = {
    applications: {
      api: {
        ApplicationV2: class {},
        HandlebarsApplicationMixin: (Base) => class extends Base {},
        DialogV2: {},
      },
    },
    utils: {
      deepClone(value) {
        return structuredClone(value);
      },
    },
  };
  globalThis.ui = {
    notifications: {
      info() {},
      warn(message) {
        warnings.push(message);
      },
      error() {},
    },
  };
  globalThis.game = {
    ready: false,
    user: gm,
    users,
    actors: [],
    settings: {
      get(moduleId, key) {
        return moduleId === "infinity-dnd5e" ? settings.get(key) : undefined;
      },
      async set(moduleId, key, value) {
        assert.equal(moduleId, "infinity-dnd5e");
        writeCount += 1;
        settings.set(key, structuredClone(value));
        return value;
      },
    },
    socket: { emit() {} },
  };

  const [{ ReputationWorkspaceApp }, { normalizeFaction }] = await Promise.all([
    import("./reputation-workspace.js"),
    import("./reputation/standing.js"),
  ]);
  settings.set("factions", [
    normalizeFaction({ id: "f1", name: "The Watch", standing: 3 }),
  ]);

  function actionFixture(rawValue) {
    const attributes = new Map();
    let focused = false;
    const valueControl = {
      value: rawValue,
      setAttribute(name, value) {
        attributes.set(name, value);
      },
      removeAttribute(name) {
        attributes.delete(name);
      },
      focus() {
        focused = true;
      },
    };
    const reasonControl = {
      value: "Completed a patrol",
      setAttribute() {},
      removeAttribute() {},
      focus() {},
    };
    const host = {
      querySelector(selector) {
        if (selector === '[data-role="standing-change-value"]') {
          return valueControl;
        }
        if (selector === '[data-role="standing-change-reason"]') {
          return reasonControl;
        }
        return null;
      },
    };
    return {
      target: { closest: () => host },
      valueControl,
      attributes,
      wasFocused: () => focused,
    };
  }

  const fakeApp = { _selectedId: "f1", render() {} };
  for (const rawValue of ["", "1.5"]) {
    const fixture = actionFixture(rawValue);
    const writesBefore = writeCount;
    await ReputationWorkspaceApp.DEFAULT_OPTIONS.actions.changeStanding.call(
      fakeApp,
      null,
      fixture.target,
    );
    assert.equal(
      writeCount,
      writesBefore,
      `standing ${JSON.stringify(rawValue)} is rejected before persistence`,
    );
    assert.equal(fixture.attributes.get("aria-invalid"), "true");
    assert.equal(fixture.wasFocused(), true);
  }
  assert.match(warnings.at(-1) ?? "", /valid standing value/i);
  assert.equal(
    settings.get("factions")[0].standing,
    3,
    "invalid inline values leave the canonical standing unchanged",
  );
} finally {
  if (savedFoundry === undefined) delete globalThis.foundry;
  else globalThis.foundry = savedFoundry;
  if (savedGame === undefined) delete globalThis.game;
  else globalThis.game = savedGame;
  if (savedConst === undefined) delete globalThis.CONST;
  else globalThis.CONST = savedConst;
  if (savedUi === undefined) delete globalThis.ui;
  else globalThis.ui = savedUi;
}

process.stdout.write("reputation workspace action validation passed\n");
