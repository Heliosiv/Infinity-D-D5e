import assert from "node:assert/strict";

globalThis.foundry = {
  applications: {
    api: {
      ApplicationV2: class {},
      HandlebarsApplicationMixin: (Base) => class extends Base {},
    },
  },
};
const registeredHooks = [];
const removedHooks = [];
globalThis.Hooks = {
  on(event, callback) {
    registeredHooks.push({ event, callback });
    return registeredHooks.length;
  },
  off(event, id) {
    removedHooks.push({ event, id });
  },
};

const { CriticalInjuryTriageApp } =
  await import("./injury/injury-triage-app.js");

const app = new CriticalInjuryTriageApp();
assert.ok(
  registeredHooks.some(
    (entry) => entry.event === "infinity-dnd5e.privateStateChanged",
  ),
  "triage refreshes after private workflow state changes",
);
assert.equal(
  registeredHooks.some(
    (entry) => entry.event === "infinityDnd5ePrivateStateChanged",
  ),
  false,
  "triage does not subscribe to the obsolete private-state hook name",
);
app._onClose();
assert.ok(
  removedHooks.some(
    (entry) => entry.event === "infinity-dnd5e.privateStateChanged",
  ),
  "triage removes its private workflow refresh listener on close",
);

const actorSelect = createSelect("actor-a", []);
const recipientSelect = createSelect("player-b", [
  createOption("player-a"),
  createOption("player-b", true),
]);
const root = {
  querySelector(selector) {
    if (selector !== ".ci-triage-start") return null;
    return {
      elements: { actorId: actorSelect, targetUserId: recipientSelect },
    };
  },
};
const triage = {
  _manualOwnersByActor: new Map([
    ["actor-a", new Set(["player-a"])],
    ["actor-b", new Set(["player-b"])],
  ]),
};

CriticalInjuryTriageApp.prototype._wireManualRecipient.call(triage, root);
assert.equal(recipientSelect.value, "player-a");
assert.equal(recipientSelect.options[0].disabled, false);
assert.equal(recipientSelect.options[1].disabled, true);

actorSelect.value = "actor-b";
actorSelect.changeHandler();
assert.equal(recipientSelect.value, "player-b");
assert.equal(recipientSelect.options[0].disabled, true);
assert.equal(recipientSelect.options[1].disabled, false);

delete globalThis.foundry;
delete globalThis.Hooks;
process.stdout.write("critical injury triage recipient validation passed\n");

function createSelect(value, options) {
  return {
    value,
    options,
    addEventListener(type, handler) {
      if (type === "change") this.changeHandler = handler;
    },
  };
}

function createOption(value, selected = false) {
  return { value, selected, disabled: false, hidden: false };
}
