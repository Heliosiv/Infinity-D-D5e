import assert from "node:assert/strict";

const GLOBAL_KEYS = [
  "CONST",
  "CSS",
  "Hooks",
  "SimpleCalendar",
  "document",
  "foundry",
  "game",
  "queueMicrotask",
  "setTimeout",
  "clearTimeout",
  "ui",
];
const savedGlobals = Object.fromEntries(
  GLOBAL_KEYS.map((key) => [key, globalThis[key]]),
);

const player = {
  id: "player-hud",
  isGM: false,
  role: 1,
  active: true,
  character: null,
};
const gm = {
  id: "gm-hud",
  isGM: true,
  role: 4,
  active: true,
  character: null,
};
const users = [gm, player];
users.activeGM = gm;
users.get = (id) => users.find((user) => user.id === id) ?? null;

const settings = new Map([
  ["criticalInjuriesEnabled", true],
  ["criticalInjuryHudEnabled", true],
  ["animations", true],
]);
const hookHandlers = new Map();
const applicationEvents = [];
const socketFrames = [];
const pendingTimers = new Map();
let nextTimerId = 0;
let randomId = 0;

const unrelatedOwnedNpc = actorFixture({
  id: "npc-owned",
  name: "Owned NPC",
  type: "npc",
  ownerId: player.id,
});
const unownedCharacter = actorFixture({
  id: "character-unowned",
  name: "Unowned Character",
  type: "character",
  ownerId: gm.id,
});
const defaultOnlyCharacter = actorFixture({
  id: "character-default-owner",
  name: "Default-Only Character",
  type: "character",
  ownerId: gm.id,
});
defaultOnlyCharacter.ownership = { default: 3 };
const fallbackActor = actorFixture({
  id: "actor-fallback",
  name: "Fallback Hero",
  type: "character",
  ownerId: player.id,
});
const assignedActor = actorFixture({
  id: "actor-assigned",
  name: "Assigned Hero",
  type: "character",
  ownerId: player.id,
});
const actors = [
  unrelatedOwnedNpc,
  unownedCharacter,
  defaultOnlyCharacter,
  fallbackActor,
  assignedActor,
];
actors.get = (id) => actors.find((actor) => actor.id === id) ?? null;
actors.contents = actors;

try {
  globalThis.CONST = {
    USER_ROLES: { GAMEMASTER: 4 },
    DOCUMENT_OWNERSHIP_LEVELS: { OWNER: 3 },
  };
  globalThis.CSS = { escape: (value) => String(value) };
  globalThis.foundry = {
    utils: {
      randomID: () => `hud${String(++randomId).padStart(13, "0")}`,
    },
    applications: {
      api: {
        ApplicationV2: class {
          constructor(options = {}) {
            this.options = options;
            this.rendered = false;
            this.element = elementFixture();
            applicationEvents.push({ type: "construct", app: this });
          }

          render(force = false) {
            this.rendered = true;
            applicationEvents.push({ type: "render", force, app: this });
            return this;
          }

          async close(options = {}) {
            this.rendered = false;
            applicationEvents.push({ type: "close", options, app: this });
            this._onClose?.(options);
            return this;
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
  globalThis.document = {
    addEventListener() {},
  };
  globalThis.ui = {
    notifications: { warn() {}, error() {}, info() {} },
  };
  globalThis.setTimeout = (handler) => {
    const timerId = ++nextTimerId;
    pendingTimers.set(timerId, handler);
    return timerId;
  };
  globalThis.clearTimeout = (timerId) => pendingTimers.delete(timerId);
  globalThis.game = {
    user: player,
    users,
    actors,
    modules: new Map(),
    settings: {
      get(_moduleId, key) {
        return settings.get(key);
      },
    },
    socket: {
      emit(name, payload, options) {
        socketFrames.push({
          name,
          payload: structuredClone(payload),
          options: structuredClone(options),
        });
      },
    },
    time: { worldTime: 10_000 },
  };

  const [hudModule, injuryAppModule, treatmentModule] = await Promise.all([
    import("./injury/injury-hud.js"),
    import("./injury/injury-app.js"),
    import("./injury/treatment-client.js"),
  ]);
  const {
    CriticalInjuryHudApp,
    registerCriticalInjuryHud,
    resolveCurrentUserHudActor,
  } = hudModule;
  const { CriticalInjuryApp, registerCriticalInjuryApp } = injuryAppModule;
  const {
    getCriticalInjuryTreatmentState,
    handleCriticalInjuryTreatmentResult,
  } = treatmentModule;

  // Assigned Actors take precedence, whether Foundry exposes the document or
  // only its id. Without an assignment, the first directly owned character is
  // selected; owned NPCs and default-only permissions do not qualify.
  player.character = assignedActor;
  assert.equal(resolveCurrentUserHudActor(), assignedActor);
  player.character = assignedActor.id;
  assert.equal(resolveCurrentUserHudActor(), assignedActor);
  player.character = null;
  assert.equal(resolveCurrentUserHudActor(), fallbackActor);
  const fullAppSelection = CriticalInjuryApp.openForCurrentUser();
  assert.equal(
    fullAppSelection?._actorId,
    fallbackActor.id,
    "the full injury log and compact HUD choose the same directly owned fallback",
  );
  await fullAppSelection.close({ animate: false });

  registerCriticalInjuryApp();
  const restFrameCount = socketFrames.length;
  Hooks.call("dnd5e.restCompleted", defaultOnlyCharacter, { longRest: true });
  assert.equal(
    socketFrames.length,
    restFrameCount + 1,
    "effective default ownership still permits long-rest injury processing",
  );
  assert.equal(
    socketFrames.at(-1).payload.type,
    "critical-injury:rest-completed",
  );
  assert.equal(socketFrames.at(-1).payload.actorId, defaultOnlyCharacter.id);

  player.character = assignedActor;
  assert.equal(
    await CriticalInjuryHudApp.reconcile(),
    null,
    "the body HUD remains hidden when the character has no active injuries",
  );
  assert.equal(CriticalInjuryHudApp.instance, null);

  const injuryWindowOpens = [];
  const realOpen = CriticalInjuryApp.open;
  CriticalInjuryApp.open = (options) => {
    injuryWindowOpens.push(structuredClone(options));
    return { options };
  };

  registerCriticalInjuryHud();
  await flushReconcile();
  assert.equal(CriticalInjuryHudApp.instance, null);
  assert.equal(
    injuryWindowOpens.length,
    0,
    "registration does not automatically open the large injury log",
  );

  const concussion = injuryEffect(assignedActor, {
    id: "injury-concussion",
    injuryKey: "concussion",
    injuryName: "Concussion",
    effect: "Disadvantage on Intelligence checks.",
    remainingDays: 4,
    recoveryDueTs: 400_000,
    kitCharges: 1,
    treatmentDc: 12,
    treatmentSkill: "med",
    createdAt: 100,
  });
  assignedActor.effects.contents.push(concussion);
  Hooks.call("createActiveEffect", concussion);
  await flushReconcile();

  let hud = CriticalInjuryHudApp.instance;
  assert.ok(hud?.rendered, "creating the first injury opens the compact HUD");
  assert.equal(hud._actorId, assignedActor.id);
  assert.equal(
    injuryWindowOpens.length,
    0,
    "an injury effect opens only the compact HUD, not the large injury log",
  );

  const lostEye = injuryEffect(assignedActor, {
    id: "injury-eye",
    injuryKey: "loss-of-eye",
    injuryName: "Loss of an Eye",
    effect: "Disadvantage on sight-based Perception checks.",
    permanent: true,
    kitCharges: 0,
    createdAt: 300,
  });
  const knee = injuryEffect(assignedActor, {
    id: "injury-knee",
    injuryKey: "shattered-knee",
    injuryName: "Shattered Knee",
    effect: "Speed is halved and the character cannot Dash.",
    detail: { type: "body-part", key: "left-leg", kind: "leg" },
    remainingDays: 7,
    recoveryDueTs: 700_000,
    kitCharges: 3,
    treatmentDc: 0,
    treatmentSkill: "",
    createdAt: 200,
  });
  assignedActor.effects.contents.push(lostEye, knee);
  Hooks.call("createActiveEffect", lostEye);
  Hooks.call("createActiveEffect", knee);
  await flushReconcile();

  let context = await hud._prepareContext();
  assert.equal(context.injuryCount, 3);
  const headMarker = context.markers.find((marker) => marker.key === "head");
  const leftLegMarker = context.markers.find(
    (marker) => marker.key === "left-leg",
  );
  assert.equal(
    headMarker.count,
    2,
    "same-region wounds share one marker count",
  );
  assert.deepEqual(
    headMarker.injuries.map((injury) => injury.id),
    ["injury-eye", "injury-concussion"],
    "the marker exposes all same-region wounds, newest first",
  );
  assert.match(headMarker.accessibleLabel, /2 active injuries/i);
  assert.equal(leftLegMarker.count, 1);
  assert.equal(leftLegMarker.injuries[0].locationLabel, "Left leg");

  const actions = CriticalInjuryHudApp.DEFAULT_OPTIONS.actions;
  const renderCountBeforePin = renderCountFor(hud);
  actions.pinRegion.call(hud, null, {
    dataset: { regionKey: "head" },
  });
  assert.equal(hud._pinnedRegion, "head");
  assert.ok(renderCountFor(hud) > renderCountBeforePin);
  hud._onRender({}, {});
  await Promise.resolve();
  assert.equal(
    hud.element.focusedSelectors.at(-1),
    '[data-action="closeRegion"][data-region-key="head"]',
    "opening a wound card moves focus to its close control after render",
  );
  context = await hud._prepareContext();
  assert.equal(
    context.markers.find((marker) => marker.key === "head").pinned,
    true,
  );
  actions.closeRegion.call(hud, null, {
    dataset: { regionKey: "head" },
  });
  assert.equal(hud._pinnedRegion, "");
  hud._onRender({}, {});
  await Promise.resolve();
  assert.equal(
    hud.element.focusedSelectors.at(-1),
    '[data-action="pinRegion"][data-region-key="head"]',
    "closing a wound card restores focus to the same body marker",
  );

  actions.pinRegion.call(hud, null, {
    dataset: { regionKey: "head" },
  });
  hud._onRender({}, {});
  await Promise.resolve();
  let escapePrevented = false;
  hud.element.listeners.get("keydown").at(-1)({
    key: "Escape",
    preventDefault() {
      escapePrevented = true;
    },
  });
  assert.equal(escapePrevented, true);
  assert.equal(hud._pinnedRegion, "");
  hud._onRender({}, {});
  await Promise.resolve();
  assert.equal(
    hud.element.focusedSelectors.at(-1),
    '[data-action="pinRegion"][data-region-key="head"]',
    "Escape restores focus to the marker after the rerender",
  );

  actions.openInjuries.call(hud);
  assert.deepEqual(injuryWindowOpens, [{ actorId: assignedActor.id }]);

  // The compact HUD and the full log share one treatment controller. A HUD
  // click immediately exposes the request's busy state without opening or
  // depending on the larger window.
  actions.requestTreatment.call(hud, null, {
    dataset: { injuryId: "injury-knee" },
  });
  const treatmentFrame = socketFrames.at(-1);
  assert.equal(
    treatmentFrame.payload.type,
    "critical-injury:treatment-request",
  );
  assert.equal(treatmentFrame.payload.actorId, assignedActor.id);
  assert.equal(treatmentFrame.payload.injuryId, "injury-knee");
  assert.equal(treatmentFrame.payload.targetUserId, gm.id);
  const treatmentState = getCriticalInjuryTreatmentState(
    assignedActor.id,
    "injury-knee",
  );
  assert.equal(treatmentState.busy, true);
  assert.match(treatmentState.message, /sent to the active GM/i);
  context = await hud._prepareContext();
  const treatingKnee = context.markers
    .find((marker) => marker.key === "left-leg")
    .injuries.find((injury) => injury.id === "injury-knee");
  assert.equal(treatingKnee.treating, true);
  assert.match(treatingKnee.treatmentMessage, /sent to the active GM/i);
  assert.match(hud._statusMessage, /sent to the active GM/i);
  assert.equal(
    injuryWindowOpens.length,
    1,
    "requesting treatment from the HUD does not reopen the injury log",
  );

  assert.equal(
    handleCriticalInjuryTreatmentResult({
      actorId: assignedActor.id,
      injuryId: "injury-knee",
      treatmentId: treatmentState.treatmentId,
      success: false,
      retryable: true,
      message: "Treatment was postponed; trying again is safe.",
    }),
    true,
  );
  context = await hud._prepareContext();
  const retryableKnee = context.markers
    .find((marker) => marker.key === "left-leg")
    .injuries.find((injury) => injury.id === "injury-knee");
  assert.equal(retryableKnee.treating, false);
  assert.match(retryableKnee.treatmentMessage, /postponed/i);
  assert.match(hud._statusMessage, /postponed/i);

  const rendersBeforeUpdate = renderCountFor(hud);
  Hooks.call("updateActiveEffect", knee);
  await flushReconcile();
  assert.ok(
    renderCountFor(hud) > rendersBeforeUpdate,
    "effect updates refresh the existing compact HUD",
  );
  assert.equal(injuryWindowOpens.length, 1);

  // Losing direct ownership can make a different Actor become the current HUD
  // target. The update for the Actor still displayed by the HUD must reconcile
  // against the newly resolved Actor instead of leaving the stale overlay.
  player.character = null;
  delete assignedActor.ownership[player.id];
  Hooks.call("updateActor", assignedActor);
  await flushReconcile();
  assert.equal(
    CriticalInjuryHudApp.instance,
    null,
    "losing ownership of the displayed Actor closes its stale HUD",
  );
  assert.equal(injuryWindowOpens.length, 1);

  assignedActor.ownership[player.id] = 3;
  player.character = assignedActor;
  Hooks.call("updateActor", assignedActor);
  await flushReconcile();
  hud = CriticalInjuryHudApp.instance;
  assert.ok(
    hud?.rendered,
    "the assigned injured Actor can be reconciled again",
  );

  // The inverse side of the hook filter matters too: an update for the newly
  // resolved Actor must reconcile even when the existing HUD has another id.
  player.character = null;
  Hooks.call("updateActor", fallbackActor);
  await flushReconcile();
  assert.equal(
    CriticalInjuryHudApp.instance,
    null,
    "an update for the newly resolved Actor closes a stale HUD",
  );
  player.character = assignedActor;
  Hooks.call("updateActor", assignedActor);
  await flushReconcile();
  hud = CriticalInjuryHudApp.instance;
  assert.ok(hud?.rendered);

  const assignedActorIndex = actors.indexOf(assignedActor);
  player.character = null;
  actors.splice(assignedActorIndex, 1);
  Hooks.call("deleteActor", assignedActor);
  await flushReconcile();
  assert.equal(
    CriticalInjuryHudApp.instance,
    null,
    "deleting the displayed Actor closes its stale HUD",
  );
  actors.push(assignedActor);
  player.character = assignedActor;
  Hooks.call("updateActor", assignedActor);
  await flushReconcile();
  hud = CriticalInjuryHudApp.instance;
  assert.ok(
    hud?.rendered,
    "the HUD can reconcile after Actor deletion cleanup",
  );

  assignedActor.effects.contents.length = 0;
  Hooks.call("deleteActiveEffect", knee);
  await flushReconcile();
  assert.equal(
    CriticalInjuryHudApp.instance,
    null,
    "removing the last injury closes the compact HUD",
  );
  assert.equal(injuryWindowOpens.length, 1);

  assignedActor.effects.contents.push(concussion);
  Hooks.call("createActiveEffect", concussion);
  await flushReconcile();
  assert.ok(CriticalInjuryHudApp.instance?.rendered);
  settings.set("criticalInjuryHudEnabled", false);
  Hooks.call(
    "clientSettingChanged",
    "infinity-dnd5e.criticalInjuryHudEnabled",
    false,
  );
  await flushReconcile();
  assert.equal(
    CriticalInjuryHudApp.instance,
    null,
    "disabling the client HUD setting closes an already rendered HUD",
  );
  settings.set("criticalInjuryHudEnabled", true);
  Hooks.call(
    "clientSettingChanged",
    "infinity-dnd5e.criticalInjuryHudEnabled",
    true,
  );
  await flushReconcile();
  assert.ok(
    CriticalInjuryHudApp.instance?.rendered,
    "re-enabling the client HUD setting restores an injured character's HUD",
  );
  assert.equal(
    injuryWindowOpens.length,
    1,
    "effect and setting lifecycle hooks never auto-open the large window",
  );

  CriticalInjuryApp.open = realOpen;
} finally {
  for (const [key, value] of Object.entries(savedGlobals)) {
    if (value === undefined) delete globalThis[key];
    else globalThis[key] = value;
  }
}

process.stdout.write("critical injury body HUD validation passed\n");

function actorFixture({ id, name, type, ownerId }) {
  return {
    id,
    name,
    type,
    ownership: { default: 0, [ownerId]: 3 },
    flags: { "infinity-dnd5e": {} },
    effects: { contents: [] },
    getFlag(moduleId, key) {
      return this.flags?.[moduleId]?.[key];
    },
  };
}

function injuryEffect(actor, injury) {
  const normalized = {
    pendingId: `pending-${injury.id}`,
    permanent: false,
    stabilized: false,
    remainingDays: 0,
    recoveryDueTs: null,
    kitCharges: 0,
    treatmentDc: 0,
    treatmentSkill: "",
    createdAt: 0,
    ...injury,
  };
  return {
    id: `effect-${normalized.id}`,
    parent: actor,
    flags: { "infinity-dnd5e": { criticalInjury: normalized } },
    getFlag(moduleId, key) {
      return this.flags?.[moduleId]?.[key];
    },
  };
}

function elementFixture() {
  const listeners = new Map();
  const focusedSelectors = [];
  return {
    listeners,
    focusedSelectors,
    classList: { toggle() {} },
    addEventListener(event, handler) {
      if (!listeners.has(event)) listeners.set(event, []);
      listeners.get(event).push(handler);
    },
    contains() {
      return false;
    },
    querySelector(selector) {
      return {
        focus() {
          focusedSelectors.push(selector);
        },
      };
    },
  };
}

function renderCountFor(app) {
  return applicationEvents.filter(
    (event) => event.type === "render" && event.app === app,
  ).length;
}

async function flushReconcile() {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}
