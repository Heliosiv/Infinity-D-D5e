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
const gmReplacement = {
  id: "gm-hud-replacement",
  isGM: true,
  role: 4,
  active: false,
  character: null,
};
const users = [gm, gmReplacement, player];
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
const messages = [];
messages.get = (id) => messages.find((message) => message.id === id) ?? null;
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
    messages,
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

  const [hudModule, injuryAppModule, treatmentModule, socketModule] =
    await Promise.all([
      import("./injury/injury-hud.js"),
      import("./injury/injury-app.js"),
      import("./injury/treatment-client.js"),
      import("./injury/socket.js"),
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
  const infectionForRest = injuryEffect(defaultOnlyCharacter, {
    id: "injury-infection-rest-proof",
    injuryKey: "infection",
    injuryName: "Infection",
    effect: "DC 15 Constitution save after each long rest.",
    remainingDays: 3,
    recoveryDueTs: 400_000,
    kitCharges: 2,
    createdAt: 100,
  });
  defaultOnlyCharacter.effects.contents.push(infectionForRest);
  const longRestConfig = { chat: false };
  Hooks.call("dnd5e.longRest", defaultOnlyCharacter, longRestConfig);
  assert.equal(
    longRestConfig.chat,
    true,
    "an infected character's long rest keeps D&D5e's server receipt enabled",
  );
  const overlappingInfection = injuryEffect(assignedActor, {
    id: "injury-infection-overlap",
    injuryKey: "infection",
    injuryName: "Overlapping Infection",
    effect: "DC 15 Constitution save after each long rest.",
    remainingDays: 3,
    recoveryDueTs: 400_000,
    kitCharges: 2,
    createdAt: 100,
  });
  assignedActor.effects.contents.push(overlappingInfection);
  const restFrameCount = socketFrames.length;
  const completedRest = { longRest: true };
  const overlappingRest = { longRest: true };
  const completedRestConfig = { chat: true };
  const overlappingRestConfig = { chat: true };
  Hooks.call(
    "dnd5e.preRestCompleted",
    defaultOnlyCharacter,
    completedRest,
    completedRestConfig,
  );
  Hooks.call(
    "dnd5e.preRestCompleted",
    assignedActor,
    overlappingRest,
    overlappingRestConfig,
  );

  // The same player can have overlapping rests for different Actors. Create
  // their server messages in reverse order to prove nonce binding chooses the
  // exact receipt, rather than whichever long-rest message happened last.
  const overlappingMessage = restMessageFixture({
    id: "rest-message-assigned-owner",
    actor: assignedActor,
    user: player,
  });
  const overlappingMessageData = restMessageData(assignedActor, player);
  Hooks.call(
    "preCreateChatMessage",
    overlappingMessage,
    overlappingMessageData,
    {},
    player.id,
  );
  messages.push(overlappingMessage);
  Hooks.call("createChatMessage", overlappingMessage, {}, player.id);

  const restMessage = restMessageFixture({
    id: "rest-message-default-owner",
    actor: defaultOnlyCharacter,
    user: player,
  });
  const restMessageSource = restMessageData(defaultOnlyCharacter, player);
  Hooks.call(
    "preCreateChatMessage",
    restMessage,
    restMessageSource,
    {},
    player.id,
  );
  messages.push(restMessage);
  Hooks.call("createChatMessage", restMessage, {}, player.id);
  assert.notEqual(
    restMessage.getFlag("infinity-dnd5e", "criticalInjuryRestNonce"),
    overlappingMessage.getFlag("infinity-dnd5e", "criticalInjuryRestNonce"),
    "overlapping rests receive distinct opaque message bindings",
  );

  Hooks.call(
    "dnd5e.restCompleted",
    defaultOnlyCharacter,
    completedRest,
    completedRestConfig,
  );
  Hooks.call(
    "dnd5e.restCompleted",
    assignedActor,
    overlappingRest,
    overlappingRestConfig,
  );
  assert.equal(
    socketFrames.length,
    restFrameCount + 2,
    "both overlapping owned-character rests produce one request",
  );
  const defaultRestFrame = socketFrames
    .slice(restFrameCount)
    .find((frame) => frame.payload.actorId === defaultOnlyCharacter.id);
  const overlappingRestFrame = socketFrames
    .slice(restFrameCount)
    .find((frame) => frame.payload.actorId === assignedActor.id);
  assert.equal(defaultRestFrame.payload.type, "critical-injury:rest-completed");
  assert.equal(defaultRestFrame.payload.actorId, defaultOnlyCharacter.id);
  assert.match(
    defaultRestFrame.payload.restId,
    /^rest-/,
    "the client assigns the completed rest a durable correlation id",
  );
  assert.equal(
    defaultRestFrame.payload.restMessageId,
    restMessage.id,
    "the request carries the server-created dnd5e rest message id",
  );
  assert.equal(
    defaultRestFrame.payload.restId,
    `rest-${defaultOnlyCharacter.id}-${restMessage.id}`,
    "the correlation id is deterministic across clients",
  );
  assert.equal(
    overlappingRestFrame.payload.restMessageId,
    overlappingMessage.id,
    "the overlapping Actor selects its nonce-bound message exactly",
  );
  assert.equal(
    defaultRestFrame.payload.targetUserId,
    gm.id,
    "the client targets the current authoritative GM",
  );
  assert.deepEqual(
    defaultRestFrame.options?.recipients,
    [gm.id],
    "the rest request is not broadcast to unrelated clients",
  );
  const firstRestId = defaultRestFrame.payload.restId;
  const beforeRepeatedRest = socketFrames.length;
  Hooks.call(
    "dnd5e.restCompleted",
    defaultOnlyCharacter,
    completedRest,
    completedRestConfig,
  );
  assert.ok(
    socketFrames
      .slice(beforeRepeatedRest)
      .every((frame) => frame.payload.restId === firstRestId),
    "a repeated delivery is suppressed or reuses the same correlation id",
  );
  const beforeChatlessRest = socketFrames.length;
  Hooks.call(
    "dnd5e.restCompleted",
    defaultOnlyCharacter,
    { longRest: true },
    { chat: false },
  );
  assert.equal(
    socketFrames.length,
    beforeChatlessRest,
    "a chatless rest fails closed instead of reusing stale evidence",
  );

  const queuedResult = { longRest: true };
  const queuedConfig = { chat: true };
  Hooks.call(
    "dnd5e.preRestCompleted",
    defaultOnlyCharacter,
    queuedResult,
    queuedConfig,
  );
  const queuedMessage = restMessageFixture({
    id: "rest-message-queued-no-gm",
    actor: defaultOnlyCharacter,
    user: player,
  });
  const queuedMessageSource = restMessageData(defaultOnlyCharacter, player);
  Hooks.call(
    "preCreateChatMessage",
    queuedMessage,
    queuedMessageSource,
    {},
    player.id,
  );
  messages.push(queuedMessage);
  Hooks.call("createChatMessage", queuedMessage, {}, player.id);
  gm.active = false;
  users.activeGM = null;
  const beforeQueuedRest = socketFrames.length;
  Hooks.call(
    "dnd5e.restCompleted",
    defaultOnlyCharacter,
    queuedResult,
    queuedConfig,
  );
  assert.equal(
    socketFrames.length,
    beforeQueuedRest,
    "a verified rest stays queued while no GM is active",
  );

  gmReplacement.active = true;
  users.activeGM = gmReplacement;
  Hooks.call("updateUser", gmReplacement, { active: true });
  const queuedRestId = `rest-${defaultOnlyCharacter.id}-${queuedMessage.id}`;
  const queuedFrames = socketFrames.filter(
    (frame) => frame.payload.restId === queuedRestId,
  );
  assert.equal(queuedFrames.length, 1);
  assert.equal(queuedFrames[0].payload.restMessageId, queuedMessage.id);
  assert.equal(queuedFrames[0].payload.targetUserId, gmReplacement.id);
  assert.deepEqual(queuedFrames[0].options?.recipients, [gmReplacement.id]);
  const beforeRepeatedAuthorityHook = socketFrames.length;
  Hooks.call("updateUser", gmReplacement, { active: true });
  assert.equal(
    socketFrames.length,
    beforeRepeatedAuthorityHook,
    "the same active-GM update does not resend an already targeted rest",
  );
  const queuedRetryTimerId = nextTimerId;
  assert.equal(pendingTimers.has(queuedRetryTimerId), true);
  socketModule.receiveCriticalInjuryPayload(
    {
      type: socketModule.CRITICAL_INJURY_EVENTS.REST_RESULT,
      actorId: defaultOnlyCharacter.id,
      restId: queuedRestId,
      targetUserId: player.id,
      originUserId: gmReplacement.id,
      success: true,
      retryable: false,
      message: "The Infection rest check is complete.",
    },
    gmReplacement.id,
  );
  assert.equal(
    pendingTimers.has(queuedRetryTimerId),
    false,
    "an authenticated GM acknowledgement clears the rest retry timer",
  );
  gm.active = true;
  gmReplacement.active = false;
  users.activeGM = gm;

  defaultOnlyCharacter.effects.contents.splice(
    defaultOnlyCharacter.effects.contents.indexOf(infectionForRest),
    1,
  );
  assignedActor.effects.contents.splice(
    assignedActor.effects.contents.indexOf(overlappingInfection),
    1,
  );

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

function restMessageFixture({ id, actor, user }) {
  return {
    id,
    user: user.id,
    author: user,
    speaker: { actor: actor.id, alias: actor.name },
    flags: { dnd5e: { rest: { type: "long" } } },
    getFlag(moduleId, key) {
      return this.flags?.[moduleId]?.[key];
    },
    updateSource(changes) {
      for (const [path, value] of Object.entries(changes ?? {})) {
        setPath(this, path, value);
      }
    },
  };
}

function restMessageData(actor, user) {
  return {
    user: user.id,
    speaker: { actor: actor.id, alias: actor.name },
    "flags.dnd5e.rest": { type: "long" },
  };
}

function setPath(target, path, value) {
  const keys = String(path).split(".");
  let cursor = target;
  for (const key of keys.slice(0, -1)) {
    cursor[key] ??= {};
    cursor = cursor[key];
  }
  cursor[keys.at(-1)] = structuredClone(value);
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
