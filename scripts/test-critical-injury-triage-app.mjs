import assert from "node:assert/strict";

globalThis.foundry = {
  applications: {
    api: {
      ApplicationV2: class {},
      HandlebarsApplicationMixin: (Base) => class extends Base {},
    },
  },
};

const { CriticalInjuryTriageApp } =
  await import("./injury/injury-triage-app.js");

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
