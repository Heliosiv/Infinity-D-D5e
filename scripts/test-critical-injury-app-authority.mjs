import assert from "node:assert/strict";

const saved = Object.fromEntries(
  ["game", "foundry", "CONST", "Roll", "setTimeout", "clearTimeout"].map(
    (key) => [key, globalThis[key]],
  ),
);

const gm = { id: "gm-1", isGM: true, role: 4, active: true };
const player = { id: "player-1", isGM: false, role: 1, active: true };
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
  ownership: { [player.id]: 3 },
  flags: { "infinity-dnd5e": { criticalInjuryPending: [pending] } },
  effects: { contents: [] },
  getFlag(moduleId, key) {
    return this.flags?.[moduleId]?.[key];
  },
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
    actors: { get: (id) => (id === actor.id ? actor : null) },
    settings: { get: () => injuriesEnabled },
    socket: {
      emit(name, payload, options) {
        emitted.push({ name, payload: structuredClone(payload), options });
      },
    },
  };

  const { CriticalInjuryApp } = await import("./injury/injury-app.js");
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
