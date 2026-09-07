import assert from "node:assert/strict";

const saved = Object.fromEntries(
  ["game", "foundry", "CONST", "Roll", "setTimeout", "clearTimeout"].map(
    (key) => [key, globalThis[key]],
  ),
);

const gm = { id: "gm-1", isGM: true, role: 4, active: true };
const player = {
  id: "player-1",
  isGM: false,
  role: 1,
  active: true,
  character: "actor-1",
};
const users = [gm, player];
users.activeGM = gm;
users.get = (id) => users.find((user) => user.id === id) ?? null;
const pending = {
  id: "pending-1",
  actorId: "actor-1",
  targetUserId: player.id,
};
const actor = {
  id: "actor-1",
  name: "Aria",
  type: "character",
  ownership: { [player.id]: 3 },
  flags: { "infinity-dnd5e": { criticalInjuryPending: [pending] } },
  effects: { contents: [] },
  getFlag(moduleId, key) {
    return this.flags?.[moduleId]?.[key];
  },
};
const unownedCharacter = {
  id: "actor-unowned",
  name: "Aldus (Copy)",
  type: "character",
  ownership: {},
};
const ownedNpc = {
  id: "actor-npc",
  name: "Friendly NPC",
  type: "npc",
  ownership: { [player.id]: 3 },
};
const emitted = [];
let renderCount = 0;
let injuriesEnabled = true;

try {
  globalThis.CONST = {
    USER_ROLES: { GAMEMASTER: 4 },
    DOCUMENT_OWNERSHIP_LEVELS: { OWNER: 3 },
  };
  globalThis.foundry = {
    applications: {
      api: {
        ApplicationV2: class {
          render() {
            renderCount += 1;
          }

          bringToFront() {}
        },
        HandlebarsApplicationMixin: (Base) => class extends Base {},
      },
    },
  };
  globalThis.Roll = class ClientRollMustNotRun {
    constructor() {
      throw new Error("the player client must not evaluate the injury die");
    }
  };
  globalThis.setTimeout = () => 123;
  globalThis.clearTimeout = () => {};
  globalThis.game = {
    user: player,
    users,
    actors: {
      contents: [actor, unownedCharacter, ownedNpc],
      get: (id) =>
        [actor, unownedCharacter, ownedNpc].find(
          (candidate) => candidate.id === id,
        ) ?? null,
    },
    modules: new Map([
      ["foundryvtt-simple-calendar-reborn", { active: true, api: {} }],
    ]),
    settings: { get: () => injuriesEnabled },
    socket: {
      emit(name, payload, options) {
        emitted.push({ name, payload: structuredClone(payload), options });
      },
    },
  };

  const {
    CriticalInjuryApp,
    getControlledCriticalInjuryActors,
    resolveCurrentUserActor,
    resolveControlledCriticalInjuryActor,
    isPlayerOwnedCriticalInjuryActor,
  } = await import("./injury/injury-app.js");
  assert.equal(isPlayerOwnedCriticalInjuryActor(actor), true);
  assert.equal(isPlayerOwnedCriticalInjuryActor(unownedCharacter), false);
  assert.equal(isPlayerOwnedCriticalInjuryActor(ownedNpc), false);
  globalThis.game.user = gm;
  assert.deepEqual(
    getControlledCriticalInjuryActors().map((candidate) => candidate.id),
    [actor.id],
    "full-GM access does not add unowned characters or player-owned NPCs to the injury roster",
  );
  globalThis.game.user = player;
  const extraOwned = {
    id: "extra-owned",
    name: "Old PC",
    type: "character",
    ownership: { [player.id]: 3 },
  };
  const sharedCopy = {
    id: "shared-copy",
    name: "Copy",
    type: "character",
    ownership: { default: 3 },
  };
  game.actors.contents.push(extraOwned, sharedCopy);
  player.active = false;
  for (const viewer of [gm, player]) {
    game.user = viewer;
    assert.deepEqual(
      getControlledCriticalInjuryActors().map((entry) => entry.id),
      [actor.id],
      "only current assigned PCs appear, including offline players",
    );
    assert.equal(resolveControlledCriticalInjuryActor(extraOwned.id), null);
    assert.equal(resolveControlledCriticalInjuryActor(sharedCopy.id), null);
  }
  assert.equal(resolveCurrentUserActor(), actor);
  player.character = extraOwned;
  assert.deepEqual(
    getControlledCriticalInjuryActors().map((entry) => entry.id),
    [extraOwned.id],
    "assignment changes replace the current roster",
  );
  assert.equal(resolveCurrentUserActor(), extraOwned);
  player.character = null;
  assert.deepEqual(getControlledCriticalInjuryActors(), []);
  assert.equal(
    resolveCurrentUserActor(),
    null,
    "ownership alone cannot select an old PC at launch",
  );
  player.character = actor.id;
  player.active = true;
  const secondPlayer = {
    id: "player-2",
    role: 1,
    isGM: false,
    character: sharedCopy.id,
  };
  users.push(secondPlayer);
  game.user = gm;
  assert.equal(
    resolveCurrentUserActor(),
    actor,
    "a GM without an assigned PC can open the current-party selector",
  );
  assert.deepEqual(
    getControlledCriticalInjuryActors().map((entry) => entry.id),
    [actor.id, sharedCopy.id],
  );
  users.pop();
  game.user = player;
  const action = CriticalInjuryApp.DEFAULT_OPTIONS.actions.rollInjury;
  const fakeApp = {
    _pendingId: pending.id,
    _waitingForRoll: false,
    _statusMessage: "",
    _waitTimer: null,
    _resolveActor: () => actor,
    _clearWaitTimer() {
      this._waitTimer = null;
    },
    render() {
      renderCount += 1;
    },
  };

  await action.call(fakeApp);
  assert.equal(fakeApp._waitingForRoll, true);
  assert.match(fakeApp._statusMessage, /waiting for the active GM/i);
  assert.equal(emitted.length, 1);
  assert.equal(emitted[0].payload.type, "critical-injury:roll-request");
  assert.equal(emitted[0].payload.targetUserId, gm.id);
  assert.equal(Object.hasOwn(emitted[0].payload, "rollTotal"), false);
  assert.ok(renderCount > 0, "the disabled waiting state renders immediately");

  await action.call(fakeApp);
  assert.equal(emitted.length, 1, "a second click is ignored while waiting");

  delete actor.flags["infinity-dnd5e"].criticalInjuryPending;
  actor.effects.contents.push({
    changes: [{ key: "system.attributes.movement.walk" }],
    flags: {
      "infinity-dnd5e": {
        criticalInjury: {
          id: "injury-1",
          pendingId: pending.id,
          injuryKey: "deep-scar",
          injuryName: "Deep Scar",
          injuryRoll: 74,
          permanent: true,
          remainingDays: 0,
          calendarEntryId: "",
          createdAt: 100,
        },
      },
    },
  });
  const completedApp = new CriticalInjuryApp({ actorId: actor.id });
  completedApp._pendingId = pending.id;
  completedApp._pendingSnapshot = pending;
  completedApp._waitingForRoll = true;
  completedApp._requestedAuthorityId = gm.id;
  const completedContext = await completedApp._prepareContext();
  assert.equal(
    completedContext.integrations.calendarActive,
    true,
    "the active Simple Calendar Reborn integration is shown as available",
  );
  assert.equal(
    completedApp._waitingForRoll,
    true,
    "an owner-writable effect is not treated as a private completion receipt",
  );
  assert.equal(completedContext.hasLatestResult, false);
  assert.equal(
    completedContext.hasPending,
    true,
    "the request snapshot keeps a safe receipt-retry action available",
  );

  actor.flags["infinity-dnd5e"].criticalInjuryPending = [pending];
  actor.effects.contents = [];

  const failedApp = CriticalInjuryApp.open({
    actorId: actor.id,
    pendingId: pending.id,
  });
  failedApp._waitingForRoll = true;
  CriticalInjuryApp.handleRollFailure({
    actorId: actor.id,
    pendingId: pending.id,
    retryable: false,
    message: "This approval is no longer valid.",
  });
  assert.equal(failedApp._waitingForRoll, false);
  assert.equal(failedApp._pendingId, null);
  assert.match(failedApp._statusMessage, /no longer valid/i);

  const retryPending = { ...pending, id: "pending-retry" };
  actor.flags["infinity-dnd5e"].criticalInjuryPending = [retryPending];
  failedApp._pendingId = retryPending.id;
  failedApp._pendingSnapshot = retryPending;
  failedApp._waitingForRoll = true;
  failedApp._requestedAuthorityId = gm.id;
  CriticalInjuryApp.handleRollFailure({
    actorId: actor.id,
    pendingId: retryPending.id,
    retryable: true,
    message: "Retrying is safe.",
  });
  assert.equal(failedApp._waitingForRoll, false);
  assert.equal(failedApp._pendingId, retryPending.id);
  assert.equal(failedApp._pendingSnapshot.id, retryPending.id);
  assert.match(failedApp._statusMessage, /retrying is safe/i);

  actor.flags["infinity-dnd5e"].criticalInjuryPending = [pending];
  fakeApp._waitingForRoll = false;
  injuriesEnabled = false;
  await action.call(fakeApp);
  assert.equal(emitted.length, 1);
  assert.match(fakeApp._statusMessage, /automation is disabled/i);

  injuriesEnabled = true;
  users.activeGM = null;
  gm.active = false;
  await action.call(fakeApp);
  assert.equal(emitted.length, 1);
  assert.match(fakeApp._statusMessage, /no active GM/i);
} finally {
  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) delete globalThis[key];
    else globalThis[key] = value;
  }
}

process.stdout.write(
  "critical injury player-triggered authority flow passed\n",
);
