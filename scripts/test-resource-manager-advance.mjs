import assert from "node:assert/strict";

const savedConst = globalThis.CONST;
const savedFoundry = globalThis.foundry;
const savedGame = globalThis.game;
const savedUi = globalThis.ui;

let resolveConfirmation;
const confirmation = new Promise((resolve) => {
  resolveConfirmation = resolve;
});
let resolveForagePrompt;
const foragePrompt = new Promise((resolve) => {
  resolveForagePrompt = resolve;
});
let confirmationCount = 0;
let promptCount = 0;
let renderCount = 0;
let confirmationOptions = null;
let foragePromptOptions = null;

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
          confirm(options) {
            confirmationCount += 1;
            confirmationOptions = options;
            return confirmation;
          },
          prompt(options) {
            promptCount += 1;
            foragePromptOptions = options;
            return foragePrompt;
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

  const lifecycleApp = new ResourceManagerApp();
  assert.equal(
    lifecycleApp._setupExpanded,
    false,
    "a newly opened Quartermaster starts with setup collapsed",
  );
  lifecycleApp._setupExpanded = true;
  ResourceManagerApp.prototype._onClose.call(lifecycleApp);
  assert.equal(
    lifecycleApp._setupExpanded,
    false,
    "closing Quartermaster resets the session-local setup state",
  );

  let setupToggleHandler = null;
  const setupDisclosure = {
    addEventListener(type, handler) {
      if (type === "toggle") setupToggleHandler = handler;
    },
  };
  const renderApp = {
    constructor: ResourceManagerApp,
    _setupExpanded: false,
    element: {
      classList: { toggle() {} },
      dataset: { idxKeydownBound: "true" },
      querySelector(selector) {
        if (selector === "[data-role='setup-disclosure']") {
          return setupDisclosure;
        }
        return null;
      },
      querySelectorAll() {
        return [];
      },
    },
  };
  ResourceManagerApp.prototype._onRender.call(renderApp, {}, {});
  assert.equal(
    typeof setupToggleHandler,
    "function",
    "Quartermaster observes the native setup disclosure",
  );
  setupToggleHandler({ currentTarget: { open: true } });
  assert.equal(
    renderApp._setupExpanded,
    true,
    "expanding setup is retained for the next render",
  );
  setupToggleHandler({ currentTarget: { open: false } });
  assert.equal(
    renderApp._setupExpanded,
    false,
    "collapsing setup is retained for the next render",
  );

  const advanceDay = ResourceManagerApp.DEFAULT_OPTIONS.actions.advanceDay;
  const forageDrive = ResourceManagerApp.DEFAULT_OPTIONS.actions.forageDrive;
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

  const requests = Array.from({ length: 250 }, () =>
    advanceDay.call(app, null, button),
  );
  await Promise.resolve();

  assert.equal(
    confirmationCount,
    1,
    "only one Advance Day request may await confirmation at a time",
  );
  assert.match(confirmationOptions.content, /Consume one day of supplies/);
  assert.match(confirmationOptions.content, /without foraging/);
  assert.doesNotMatch(confirmationOptions.content, /prompt online players/);
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
  await Promise.all(requests);

  assert.equal(renderCount, 1, "the accepted request completes only once");
  assert.equal(
    button.disabled,
    false,
    "the action is restored after completion",
  );
  assert.equal(button.attributes.has("aria-busy"), false);

  users.activeGM = gm;
  const forageButton = {
    disabled: false,
    attributes: new Map(),
    setAttribute(name, value) {
      this.attributes.set(name, String(value));
    },
    removeAttribute(name) {
      this.attributes.delete(name);
    },
  };
  const forageRequests = Array.from({ length: 250 }, () =>
    forageDrive.call(app, null, forageButton),
  );
  await Promise.resolve();
  assert.equal(
    promptCount,
    1,
    "only one Forage Drive request may await its prompt at a time",
  );
  assert.match(foragePromptOptions.content, /Food &amp; water/);
  assert.match(foragePromptOptions.content, /Food only/);
  assert.match(foragePromptOptions.content, /Water only/);
  assert.match(foragePromptOptions.content, /offline — GM rolls/);
  assert.match(foragePromptOptions.content, /value="hero" checked \/>/);
  assert.match(
    foragePromptOptions.content,
    /GM will roll every selected check/,
  );
  assert.equal(forageButton.disabled, true);
  assert.equal(forageButton.attributes.get("aria-busy"), "true");
  resolveForagePrompt(null);
  await Promise.all(forageRequests);
  assert.equal(forageButton.disabled, false);
  assert.equal(forageButton.attributes.has("aria-busy"), false);
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
