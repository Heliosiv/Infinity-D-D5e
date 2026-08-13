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

const { CriticalInjuryTriageApp, eligibleOwners } =
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

const savedGame = globalThis.game;
const savedConst = globalThis.CONST;
try {
  const offlineOwner = {
    id: "player-offline-owner",
    name: "Offline owner",
    isGM: false,
    role: 1,
    active: false,
  };
  const assignedPlayer = {
    id: "player-assigned",
    name: "Assigned player",
    isGM: false,
    role: 1,
    active: false,
    character: "actor-assigned",
  };
  const unrelatedPlayer = {
    id: "player-unrelated",
    name: "Unrelated player",
    isGM: false,
    role: 1,
    active: true,
  };
  globalThis.CONST = { DOCUMENT_OWNERSHIP_LEVELS: { OWNER: 3 } };
  globalThis.game = {
    users: { contents: [offlineOwner, assignedPlayer, unrelatedPlayer] },
  };

  assert.deepEqual(
    eligibleOwners({
      id: "actor-owned",
      ownership: { [offlineOwner.id]: 3 },
    }).map((user) => user.id),
    [offlineOwner.id],
    "offline owners remain available for a manual injury review",
  );
  assert.deepEqual(
    eligibleOwners({ id: "actor-assigned", ownership: {} }).map(
      (user) => user.id,
    ),
    [assignedPlayer.id],
    "a player's assigned character remains available without an explicit ownership entry",
  );
} finally {
  if (savedGame === undefined) delete globalThis.game;
  else globalThis.game = savedGame;
  if (savedConst === undefined) delete globalThis.CONST;
  else globalThis.CONST = savedConst;
}

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
