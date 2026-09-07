import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import Handlebars from "handlebars";

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

  const gm = {
    id: "gm",
    isGM: true,
    role: 4,
    active: true,
    character: "gm-character",
  };
  const assistant = {
    id: "assistant",
    isGM: true,
    role: 3,
    character: "assistant-character",
  };
  const actor = (id, type = "character") => ({
    id,
    type,
    name: id,
    ownership: { default: 3 },
    effects: { contents: [] },
    testUserPermission: () => true,
  });
  const characters = [
    actor("actor-assigned"),
    actor("actor-owned"),
    actor("actor-copy"),
    actor("gm-character"),
    actor("assistant-character"),
    actor("assigned-npc", "npc"),
  ];
  globalThis.game.user = gm;
  globalThis.game.settings = { get: () => undefined };
  globalThis.game.actors = {
    contents: characters,
    get: (id) => characters.find((entry) => entry.id === id),
  };
  game.users.contents.push(gm, assistant);
  unrelatedPlayer.character = "assigned-npc";
  const contextApp = {
    prepareWorkbenchContext: () => null,
    _actionInFlight: false,
    _message: "",
    _tone: "ready",
  };
  const prepare = () =>
    CriticalInjuryTriageApp.prototype._prepareContext.call(contextApp);
  let context = await prepare();
  assert.deepEqual(
    context.partyRows.map((entry) => entry.id),
    ["actor-assigned"],
    "only the offline player's main character appears, even when every actor grants Owner access",
  );
  assert.deepEqual(
    context.playerCharacters.map((entry) => entry.id),
    ["actor-assigned"],
    "manual review uses the same main-character roster",
  );
  const render = Handlebars.compile(
    readFileSync("templates/critical-injury-triage.hbs", "utf8"),
  );
  const html = render(context);
  assert.match(html, />New injury roll<\/button>/);
  assert.match(html, /does not add an injury/);
  assert.match(html, /completed roll applies and logs the injury/);
  assert.match(html, /<h4>actor-assigned<\/h4>/);
  assert.doesNotMatch(
    html,
    /actor-copy|actor-owned|gm-character|assistant-character|assigned-npc/,
  );
  // The table is available without party mutations, including secondary GMs.
  contextApp._view = "table";
  const tableContext = await prepare();
  assert.equal(tableContext.tableRows.length, 30);
  assert.equal(tableContext.showTable, true);
  const tableHtml = render(tableContext);
  assert.match(tableHtml, /Critical Injury Table V3/);
  assert.match(tableHtml, /Soul-Shaken/);
  assert.match(
    tableHtml,
    /Fear\/charm-only save disadvantage is not implemented/,
  );
  assert.match(tableHtml, /Midi-QOL is inactive/);
  assert.doesNotMatch(tableHtml, /class="ci-triage-start"/);
  assert.doesNotMatch(tableHtml, /class="ci-triage-party-card/);
  const secondaryGm = { id: "secondary-gm", role: 4, isGM: true, active: true };
  game.users.contents.push(secondaryGm);
  game.users.activeGM = gm;
  game.user = secondaryGm;
  const secondaryContext = await prepare();
  assert.equal(secondaryContext.canMutate, false);
  assert.equal(secondaryContext.tableRows.length, 30);
  game.user = assignedPlayer;
  const deniedContext = await prepare();
  assert.equal(deniedContext.accessDenied, true);
  assert.equal(deniedContext.tableRows, undefined);
  game.user = gm;
  const viewApp = { _search: "old query", render: () => true };
  CriticalInjuryTriageApp._onShowView.call(viewApp, null, {
    dataset: { view: "table" },
  });
  assert.equal(viewApp._view, "table");
  assert.equal(viewApp._search, "");
  CriticalInjuryTriageApp.prototype._applyWorkbenchTarget.call(viewApp, {
    subview: "table",
  });
  assert.equal(
    CriticalInjuryTriageApp.prototype._captureWorkbenchTarget.call(viewApp)
      .subview,
    "table",
  );
  contextApp._view = "triage";
  offlineOwner.character = characters[0];
  assert.equal(
    (await prepare()).partyRows.length,
    1,
    "shared assignment does not duplicate a character",
  );
  offlineOwner.character = null;
  assignedPlayer.character = characters[1];
  context = await prepare();
  assert.deepEqual(
    context.partyRows.map((entry) => entry.id),
    ["actor-owned"],
    "changing a player's assigned Actor document changes the table",
  );
  assert.ok(
    registeredHooks.some((entry) => entry.event === "updateUser"),
    "assignment changes trigger a refresh",
  );
  assignedPlayer.character = null;
  context = await prepare();
  assert.equal(context.hasPlayerCharacters, false);
  assert.match(
    render(context),
    /Select each player's character in User Configuration/,
  );
  assert.equal(
    characters.length,
    6,
    "filtering does not delete extra characters",
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
