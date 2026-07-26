import assert from "node:assert/strict";

const savedConst = globalThis.CONST;
const savedFoundry = globalThis.foundry;
const savedGame = globalThis.game;
const savedUi = globalThis.ui;

let resolveConfirmation;
const confirmation = new Promise((resolve) => {
  resolveConfirmation = resolve;
});
let confirmationCount = 0;
let renderCount = 0;

const gm = {
  id: "gm-a",
  isGM: true,
  role: 4,
  active: true,
};
const otherGm = {
  id: "gm-b",
  isGM: true,
  role: 4,
  active: true,
};
const users = [gm, otherGm];
users.activeGM = gm;
users.get = (id) => users.find((user) => user.id === id) ?? null;

const hero = {
  id: "hero",
  name: "Aria",
  type: "character",
  hasPlayerOwner: true,
  ownership: { "player-a": 3 },
  system: { attributes: { exhaustion: 0 } },
  items: { contents: [] },
};
const actors = [hero];
actors.get = (id) => actors.find((actor) => actor.id === id) ?? null;

try {
  globalThis.CONST = {
    USER_ROLES: { GAMEMASTER: 4 },
    DOCUMENT_OWNERSHIP_LEVELS: { OWNER: 3 },
    AUDIO_CHANNELS: { INTERFACE: "interface" },
  };
  globalThis.foundry = {
    applications: {
      api: {
        ApplicationV2: class {},
        HandlebarsApplicationMixin: (Base) => class extends Base {},
        DialogV2: {
          confirm() {
            confirmationCount += 1;
            return confirmation;
          },
        },
      },
    },
    utils: {
      deepClone(value) {
        return structuredClone(value);
      },
    },
  };
  globalThis.game = {
    ready: false,
    user: gm,
    users,
    actors,
    settings: {
      get() {
        return false;
      },
    },
  };
  globalThis.ui = {
    notifications: {
      info() {},
      warn() {},
      error() {},
    },
  };

  const { ResourceManagerApp } = await import("./resource-manager.js");
  const advanceDay = ResourceManagerApp.DEFAULT_OPTIONS.actions.advanceDay;
  const app = {
    render() {
      renderCount += 1;
    },
  };
  const button = {
    disabled: false,
    attributes: new Map(),
    setAttribute(name, value) {
      this.attributes.set(name, String(value));
    },
    removeAttribute(name) {
      this.attributes.delete(name);
    },
  };

  const first = advanceDay.call(app, null, button);
  const second = advanceDay.call(app, null, button);
  await Promise.resolve();

  assert.equal(
    confirmationCount,
    1,
    "only one Advance Day request may await confirmation at a time",
  );
  assert.equal(button.disabled, true, "the action is disabled while pending");
  assert.equal(
    button.attributes.get("aria-busy"),
    "true",
    "the pending action exposes its busy state",
  );

  // Make the service-level authority check fail after the dialog so this
  // focused UI test never reaches real inventory writes.
  users.activeGM = otherGm;
  resolveConfirmation(true);
  await Promise.all([first, second]);

  assert.equal(renderCount, 1, "the accepted request completes only once");
  assert.equal(
    button.disabled,
    false,
    "the action is restored after completion",
  );
  assert.equal(button.attributes.has("aria-busy"), false);
} finally {
  if (savedConst === undefined) delete globalThis.CONST;
  else globalThis.CONST = savedConst;
  if (savedFoundry === undefined) delete globalThis.foundry;
  else globalThis.foundry = savedFoundry;
  if (savedGame === undefined) delete globalThis.game;
  else globalThis.game = savedGame;
  if (savedUi === undefined) delete globalThis.ui;
  else globalThis.ui = savedUi;
}

process.stdout.write("resource manager Advance Day validation passed\n");
