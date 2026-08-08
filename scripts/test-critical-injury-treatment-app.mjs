import assert from "node:assert/strict";

const saved = Object.fromEntries(
  ["game", "foundry", "CONST", "Hooks", "ui", "setTimeout", "clearTimeout"].map(
    (key) => [key, globalThis[key]],
  ),
);

const gmA = { id: "gm-a", isGM: true, role: 4, active: true };
const gmB = { id: "gm-b", isGM: true, role: 4, active: true };
const player = {
  id: "player-1",
  isGM: false,
  role: 1,
  active: true,
  character: "actor-1",
};
const users = [gmA, gmB, player];
users.activeGM = gmA;
users.get = (id) => users.find((user) => user.id === id) ?? null;
const injury = {
  id: "injury-1",
  pendingId: "pending-1",
  injuryKey: "concussion",
  injuryName: "Concussion",
  injuryRoll: 12,
  effect: "Concussion penalties",
  recoveryRule: "One Healer's Kit charge",
  remainingDays: 3,
  permanent: false,
  stabilized: false,
  kitCharges: 1,
  treatmentDc: 0,
  treatmentSkill: "",
  recoveryDueTs: 200_000,
  calendarEntryId: "",
  createdAt: 100,
};
const effect = {
  id: "effect-1",
  changes: [],
  flags: { "infinity-dnd5e": { criticalInjury: injury } },
  getFlag(moduleId, key) {
    return this.flags?.[moduleId]?.[key];
  },
};
const actor = {
  id: "actor-1",
  name: "Aria",
  type: "character",
  ownership: { default: 0, [player.id]: 3 },
  flags: { "infinity-dnd5e": {} },
  effects: { contents: [effect] },
  getFlag(moduleId, key) {
    return this.flags?.[moduleId]?.[key];
  },
};
effect.parent = actor;

let injuriesEnabled = true;
let randomCounter = 0;
let renderCount = 0;
let nextTimerId = 0;
const timers = new Map();
const emitted = [];
const hookHandlers = new Map();

try {
  globalThis.CONST = {
    USER_ROLES: { GAMEMASTER: 4 },
    DOCUMENT_OWNERSHIP_LEVELS: { OWNER: 3 },
  };
  globalThis.foundry = {
    utils: {
      randomID: () => `ui${String(++randomCounter).padStart(14, "0")}`,
    },
    applications: {
      api: {
        ApplicationV2: class {
          constructor(options = {}) {
            this.options = options;
            this.rendered = false;
          }

          render() {
            this.rendered = true;
            renderCount += 1;
          }

          bringToFront() {}
        },
        HandlebarsApplicationMixin: (Base) => class extends Base {},
      },
    },
  };
  globalThis.Hooks = {
    on(event, handler) {
      if (!hookHandlers.has(event)) hookHandlers.set(event, []);
      hookHandlers.get(event).push(handler);
      return hookHandlers.get(event).length;
    },
    call(event, ...args) {
      for (const handler of hookHandlers.get(event) ?? []) handler(...args);
    },
  };
  globalThis.ui = {
    notifications: { warn: () => {}, error: () => {}, info: () => {} },
  };
  globalThis.setTimeout = (callback) => {
    const id = ++nextTimerId;
    timers.set(id, () => {
      timers.delete(id);
      callback();
    });
    return id;
  };
  globalThis.clearTimeout = (id) => timers.delete(id);
  globalThis.game = {
    user: gmA,
    users,
    actors: {
      contents: [actor],
      get: (id) => (id === actor.id ? actor : null),
    },
    modules: new Map(),
    settings: { get: () => injuriesEnabled },
    socket: {
      emit(name, payload, options) {
        emitted.push({ name, payload: structuredClone(payload), options });
      },
    },
  };

  const [socket, appModule, treatmentClient] = await Promise.all([
    import("./injury/socket.js"),
    import("./injury/injury-app.js"),
    import("./injury/treatment-client.js"),
  ]);
  const { CriticalInjuryApp, registerCriticalInjuryApp } = appModule;
  const {
    getCriticalInjuryTreatmentState,
    handleCriticalInjuryTreatmentResult,
    releaseStaleCriticalInjuryTreatmentAuthority,
    requestCriticalInjuryTreatment,
    subscribeCriticalInjuryTreatmentState,
  } = treatmentClient;
  const action = CriticalInjuryApp.DEFAULT_OPTIONS.actions.requestTreatment;
  const app = CriticalInjuryApp.open({ actorId: actor.id });
  const target = { dataset: { injuryId: injury.id } };

  // A local full-GM request can synchronously receive a failure. Busy state
  // and correlation must exist before the socket's local dispatch runs.
  let synchronousBusyObserved = false;
  let synchronousRequest = null;
  const unsubscribe = socket.subscribeCriticalInjury(
    socket.CRITICAL_INJURY_EVENTS.TREATMENT_REQUEST,
    (payload) => {
      synchronousRequest = structuredClone(payload);
      const state = getCriticalInjuryTreatmentState(actor.id, injury.id);
      synchronousBusyObserved =
        state?.busy === true && state?.treatmentId === payload.treatmentId;
      CriticalInjuryApp.handleTreatmentResult({
        type: socket.CRITICAL_INJURY_EVENTS.TREATMENT_RESULT,
        actorId: actor.id,
        injuryId: injury.id,
        treatmentId: payload.treatmentId,
        targetUserId: gmA.id,
        success: false,
        retryable: false,
        message: "Treatment declined immediately.",
      });
    },
  );
  action.call(app, null, target);
  assert.equal(synchronousBusyObserved, true);
  assert.ok(synchronousRequest.treatmentId.startsWith("treatment-"));
  assert.equal(synchronousRequest.targetUserId, gmA.id);
  assert.equal(
    getCriticalInjuryTreatmentState(actor.id, injury.id).busy,
    false,
  );
  assert.equal(
    getCriticalInjuryTreatmentState(actor.id, injury.id).treatmentId,
    null,
  );
  assert.match(app._statusMessage, /declined immediately/i);
  assert.equal(timers.size, 0, "a synchronous result leaves no timeout behind");
  unsubscribe();

  const preflightFrameCount = emitted.length;
  globalThis.game.user = player;
  injuriesEnabled = false;
  action.call(app, null, target);
  assert.equal(emitted.length, preflightFrameCount);
  assert.equal(
    getCriticalInjuryTreatmentState(actor.id, injury.id).busy,
    false,
  );
  assert.match(app._statusMessage, /automation is disabled/i);

  injuriesEnabled = true;
  users.activeGM = null;
  gmA.active = false;
  gmB.active = false;
  action.call(app, null, target);
  assert.equal(emitted.length, preflightFrameCount);
  assert.equal(
    getCriticalInjuryTreatmentState(actor.id, injury.id).busy,
    false,
  );
  assert.match(app._statusMessage, /no active GM/i);

  users.activeGM = gmA;
  gmA.active = true;
  const socketEmit = globalThis.game.socket.emit;
  delete globalThis.game.socket.emit;
  action.call(app, null, target);
  assert.equal(emitted.length, preflightFrameCount);
  assert.equal(
    getCriticalInjuryTreatmentState(actor.id, injury.id).busy,
    false,
  );
  assert.match(app._statusMessage, /connection is unavailable/i);
  globalThis.game.socket.emit = socketEmit;

  // A timeout releases the button but retains the exact treatment ID so the
  // next click is a receipt retry, not a second deliberate treatment.
  action.call(app, null, target);
  const timeoutRequest = emitted.at(-1).payload;
  assert.equal(timeoutRequest.targetUserId, gmA.id);
  const timeoutState = getCriticalInjuryTreatmentState(actor.id, injury.id);
  assert.equal(timeoutState.busy, true);
  assert.equal(timeoutState.treatmentId, timeoutRequest.treatmentId);
  assert.equal(timers.size, 1);
  const inFlightFrameCount = emitted.length;
  action.call(app, null, target);
  assert.equal(
    emitted.length,
    inFlightFrameCount,
    "a second click cannot emit while this injury request is busy",
  );
  assert.equal(timers.size, 1);
  [...timers.values()][0]();
  assert.equal(
    getCriticalInjuryTreatmentState(actor.id, injury.id).busy,
    false,
  );
  assert.equal(
    getCriticalInjuryTreatmentState(actor.id, injury.id).treatmentId,
    timeoutRequest.treatmentId,
  );
  assert.equal(
    getCriticalInjuryTreatmentState(actor.id, injury.id).authorityId,
    null,
  );
  assert.match(app._statusMessage, /retrying this request is safe/i);

  action.call(app, null, target);
  const timeoutRetry = emitted.at(-1).payload;
  assert.equal(timeoutRetry.treatmentId, timeoutRequest.treatmentId);
  assert.equal(getCriticalInjuryTreatmentState(actor.id, injury.id).busy, true);

  // A different unresolved attempt may already own the injury-level lease.
  // The server tells this client which durable ID to resume on its next click.
  const serverResumeId = "treatment-server-unresolved";
  handleCriticalInjuryTreatmentResult({
    actorId: actor.id,
    injuryId: injury.id,
    treatmentId: timeoutRetry.treatmentId,
    resumeTreatmentId: serverResumeId,
    targetUserId: player.id,
    success: false,
    retryable: true,
    message: "Resume the earlier stored treatment.",
  });
  assert.equal(
    getCriticalInjuryTreatmentState(actor.id, injury.id).busy,
    false,
  );
  assert.equal(
    getCriticalInjuryTreatmentState(actor.id, injury.id).treatmentId,
    serverResumeId,
  );
  assert.equal(
    getCriticalInjuryTreatmentState(actor.id, injury.id).authorityId,
    null,
  );
  assert.match(app._statusMessage, /resume the earlier/i);

  action.call(app, null, target);
  const serverResumeRetry = emitted.at(-1).payload;
  assert.equal(serverResumeRetry.treatmentId, serverResumeId);
  assert.equal(serverResumeRetry.targetUserId, gmA.id);
  assert.equal(getCriticalInjuryTreatmentState(actor.id, injury.id).busy, true);

  // Hook-driven active-GM changes release only this attempt's busy state and
  // keep its treatment ID for the replacement authority to resume.
  registerCriticalInjuryApp();
  users.activeGM = gmB;
  globalThis.Hooks.call("updateUser", gmA);
  assert.equal(
    getCriticalInjuryTreatmentState(actor.id, injury.id).busy,
    false,
  );
  assert.equal(
    getCriticalInjuryTreatmentState(actor.id, injury.id).treatmentId,
    serverResumeId,
  );
  assert.equal(
    getCriticalInjuryTreatmentState(actor.id, injury.id).authorityId,
    null,
  );
  assert.equal(releaseStaleCriticalInjuryTreatmentAuthority(), 0);
  assert.match(app._statusMessage, /active GM changed/i);

  action.call(app, null, target);
  const handoffRetry = emitted.at(-1).payload;
  assert.equal(handoffRetry.targetUserId, gmB.id);
  assert.equal(handoffRetry.treatmentId, serverResumeId);
  assert.equal(getCriticalInjuryTreatmentState(actor.id, injury.id).busy, true);

  CriticalInjuryApp.handleTreatmentResult({
    actorId: actor.id,
    injuryId: injury.id,
    treatmentId: serverResumeId,
    targetUserId: player.id,
    success: false,
    retryable: false,
    message: "The first attempt ended.",
  });
  assert.equal(
    getCriticalInjuryTreatmentState(actor.id, injury.id).treatmentId,
    null,
  );
  assert.equal(
    getCriticalInjuryTreatmentState(actor.id, injury.id).busy,
    false,
  );

  action.call(app, null, target);
  const newerRequest = emitted.at(-1).payload;
  assert.notEqual(newerRequest.treatmentId, serverResumeId);
  assert.equal(getCriticalInjuryTreatmentState(actor.id, injury.id).busy, true);
  const statusBeforeStaleResult = app._statusMessage;
  CriticalInjuryApp.handleTreatmentResult({
    actorId: actor.id,
    injuryId: injury.id,
    treatmentId: serverResumeId,
    targetUserId: player.id,
    success: true,
    retryable: false,
    message: "Stale success that must be ignored.",
  });
  assert.equal(getCriticalInjuryTreatmentState(actor.id, injury.id).busy, true);
  assert.equal(
    getCriticalInjuryTreatmentState(actor.id, injury.id).treatmentId,
    newerRequest.treatmentId,
  );
  assert.equal(app._statusMessage, statusBeforeStaleResult);

  CriticalInjuryApp.handleTreatmentResult({
    actorId: actor.id,
    injuryId: injury.id,
    treatmentId: newerRequest.treatmentId,
    targetUserId: player.id,
    success: true,
    retryable: false,
    message: "Current request completed.",
    result: { ...injury, stabilized: true },
  });
  assert.equal(
    getCriticalInjuryTreatmentState(actor.id, injury.id).busy,
    false,
  );
  assert.equal(
    getCriticalInjuryTreatmentState(actor.id, injury.id).treatmentId,
    null,
  );
  assert.match(app._statusMessage, /current request completed/i);

  // Closing the large window does not discard the shared treatment state, and
  // a controller-only request/result never reopens that window. This is the
  // path the persistent injury HUD uses.
  app._onClose({});
  const renderCountAfterClose = renderCount;
  const observedStates = [];
  const unsubscribeState = subscribeCriticalInjuryTreatmentState((state) =>
    observedStates.push(state),
  );
  const controllerRequest = requestCriticalInjuryTreatment({
    actorId: actor.id,
    injuryId: injury.id,
  });
  assert.equal(controllerRequest.ok, true);
  assert.equal(getCriticalInjuryTreatmentState(actor.id, injury.id).busy, true);
  assert.equal(renderCount, renderCountAfterClose);
  const controllerTreatmentId = controllerRequest.treatmentId;
  assert.equal(
    CriticalInjuryApp.handleTreatmentResult({
      actorId: actor.id,
      injuryId: injury.id,
      treatmentId: controllerTreatmentId,
      targetUserId: player.id,
      success: false,
      retryable: false,
      message: "Controller-only treatment ended.",
    }),
    true,
  );
  assert.equal(renderCount, renderCountAfterClose);
  assert.equal(
    getCriticalInjuryTreatmentState(actor.id, injury.id).treatmentId,
    null,
  );
  assert.match(
    getCriticalInjuryTreatmentState(actor.id, injury.id).message,
    /controller-only treatment ended/i,
  );
  assert.ok(observedStates.length >= 2);
  unsubscribeState();

  const reopened = CriticalInjuryApp.open({ actorId: actor.id });
  assert.equal(renderCount, renderCountAfterClose + 1);
  const reopenedContext = await reopened._prepareContext();
  assert.match(
    reopenedContext.statusMessage,
    /controller-only treatment ended/i,
  );
  assert.ok(renderCount > 0);
} finally {
  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) delete globalThis[key];
    else globalThis[key] = value;
  }
}

process.stdout.write("critical injury treatment app state passed\n");
