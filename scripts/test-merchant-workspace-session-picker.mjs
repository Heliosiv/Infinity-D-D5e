import assert from "node:assert/strict";

const savedFoundry = globalThis.foundry;
const savedGame = globalThis.game;
const savedConst = globalThis.CONST;
const savedUi = globalThis.ui;

const gm = { id: "gm", name: "GM", role: 4, isGM: true, active: true };
const secondaryGm = {
  id: "gm-2",
  name: "Second GM",
  role: 4,
  isGM: true,
  active: true,
};
const p1 = { id: "p1", name: "Aria", role: 1, isGM: false, active: true };
const p2 = { id: "p2", name: "Borin", role: 1, isGM: false, active: true };
const p3 = { id: "p3", name: "Cyra", role: 1, isGM: false, active: true };
const users = [gm, secondaryGm, p1, p2, p3];
users.activeGM = gm;
users.get = (id) => users.find((user) => user.id === id) ?? null;

const emitted = [];
const warnings = [];
const settings = new Map([
  ["merchantAccess", { closed: false, suspendedSessions: [] }],
  ["soundsEnabled", false],
]);
let pendingPicker = null;

try {
  globalThis.CONST = { USER_ROLES: { GAMEMASTER: 4 } };
  globalThis.foundry = {
    applications: {
      api: {
        ApplicationV2: class {
          render() {
            if (pendingPicker) {
              pendingPicker.app = this;
              pendingPicker.opened();
            }
            return this;
          }

          async close() {}
        },
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
        settings.set(key, structuredClone(value));
        return value;
      },
    },
    socket: {
      emit(channel, payload, options) {
        emitted.push({ channel, payload, options });
      },
    },
  };

  const [{ MerchantWorkspaceApp }, { normalizeMerchant }, { listSessions }] =
    await Promise.all([
      import("./merchant-workspace.js"),
      import("./merchant/store.js"),
      import("./merchant/session-state.js"),
    ]);

  settings.set("merchants", [
    normalizeMerchant({
      id: "m1",
      name: "Old Merchant",
      allowedUserIds: ["p1", "p2", "p3"],
    }),
  ]);

  let markPickerOpened;
  const pickerOpened = new Promise((resolve) => {
    markPickerOpened = resolve;
  });
  pendingPicker = { app: null, opened: markPickerOpened };
  const fakeApp = { _selectedId: "m1", render() {} };
  const openPromise =
    MerchantWorkspaceApp.DEFAULT_OPTIONS.actions.openSession.call(fakeApp);
  await pickerOpened;

  // While the modal is open, another GM revokes p2, updates merchant data,
  // and p3 disappears from the canonical user collection.
  settings.set("merchants", [
    normalizeMerchant({
      id: "m1",
      name: "Current Merchant",
      allowedUserIds: ["p1", "p3"],
    }),
  ]);
  users.splice(users.indexOf(p3), 1);

  const picker = pendingPicker.app;
  pendingPicker = null;
  picker._settle(["p1", "p2", "p3"]);
  await openPromise;

  const sessions = listSessions();
  assert.deepEqual(
    sessions.map((session) => session.viewerUserId),
    ["p1"],
    "only users still present and allowed when the picker closes receive sessions",
  );
  const opens = emitted.filter(
    ({ payload }) => payload.type === "merchant:session-open",
  );
  assert.equal(opens.length, 1);
  assert.deepEqual(opens[0].options.recipients, ["p1"]);
  assert.equal(
    opens[0].payload.merchant.name,
    "Current Merchant",
    "the emitted projection comes from the merchant re-read after the picker",
  );

  // A second full GM may inspect the workspace, but their SESSION_OPEN frame
  // would be rejected by clients because only the authoritative GM may host it.
  // The action must therefore fail before creating misleading local state.
  settings.set("merchants", [
    ...settings.get("merchants"),
    normalizeMerchant({
      id: "m2",
      name: "Secondary GM Shop",
      allowedUserIds: ["p2"],
    }),
  ]);
  globalThis.game.user = secondaryGm;
  const sessionCount = listSessions().length;
  const emissionCount = emitted.length;
  await MerchantWorkspaceApp.DEFAULT_OPTIONS.actions.openSession.call({
    _selectedId: "m2",
    render() {},
  });
  assert.equal(
    listSessions().length,
    sessionCount,
    "a secondary full GM cannot create a local-only merchant session",
  );
  assert.equal(
    emitted.length,
    emissionCount,
    "a secondary full GM cannot emit a SESSION_OPEN frame clients will reject",
  );
  assert.match(warnings.at(-1) ?? "", /active full GM/i);
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

process.stdout.write("merchant workspace session picker validation passed\n");
