import assert from "node:assert/strict";

const originalGlobals = {
  foundry: globalThis.foundry,
  game: globalThis.game,
  ui: globalThis.ui,
  Hooks: globalThis.Hooks,
  CONST: globalThis.CONST,
  AudioHelper: globalThis.AudioHelper,
  setTimeout: globalThis.setTimeout,
  clearTimeout: globalThis.clearTimeout,
};

const hookListeners = new Map();
const socketFrames = [];
const timers = [];
let randomIdCounter = 0;

class TestApplicationV2 {
  constructor(options = {}) {
    this.options = options;
    this.id = options.id ?? "test-app";
    this.rendered = false;
    this.renderCalls = [];
    this.bringToFrontCalls = 0;
    this.element = null;
  }

  render(force = false) {
    this.rendered = true;
    this.renderCalls.push(force);
    return this;
  }

  bringToFront() {
    this.bringToFrontCalls += 1;
  }

  close(options) {
    this._onClose?.(options);
    this.rendered = false;
    return this;
  }

  _onClose() {}
}

function userCollection(users, activeGmId = "gm-a") {
  const collection = new Map(users.map((user) => [user.id, user]));
  collection.activeGM = collection.get(activeGmId) ?? null;
  return collection;
}

function framesOf(type) {
  return socketFrames.filter(([, payload]) => payload?.type === type);
}

try {
  globalThis.foundry = {
    applications: {
      api: {
        ApplicationV2: TestApplicationV2,
        HandlebarsApplicationMixin: (Base) => class extends Base {},
      },
    },
    audio: { AudioHelper: { play: async () => null } },
    utils: {
      randomID() {
        randomIdCounter += 1;
        return `random-${randomIdCounter}`;
      },
    },
  };
  globalThis.Hooks = {
    on(event, callback) {
      const bucket = hookListeners.get(event) ?? new Set();
      bucket.add(callback);
      hookListeners.set(event, bucket);
      return callback;
    },
    off(event, callback) {
      hookListeners.get(event)?.delete(callback);
    },
  };
  globalThis.ui = { notifications: { warn() {} } };
  globalThis.CONST = {
    USER_ROLES: { GAMEMASTER: 4 },
    DOCUMENT_OWNERSHIP_LEVELS: { OWNER: 3 },
    AUDIO_CHANNELS: { INTERFACE: "interface" },
  };
  globalThis.setTimeout = (callback, delay) => {
    const timer = { callback, delay, cleared: false };
    timers.push(timer);
    return timer;
  };
  globalThis.clearTimeout = (timer) => {
    if (timer) timer.cleared = true;
  };

  let rollCalls = 0;
  const actor = {
    id: "actor-a",
    name: "Ranger",
    type: "character",
    ownership: { "player-a": 3 },
    system: {
      abilities: { wis: { mod: 3 } },
      skills: { sur: { passive: 15 } },
    },
    async rollSkill() {
      rollCalls += 1;
      return { total: 19 };
    },
  };
  const actors = new Map([[actor.id, actor]]);
  const gm = { id: "gm-a", isGM: true, role: 4, active: true };
  const secondaryGm = {
    id: "gm-b",
    isGM: true,
    role: 4,
    active: true,
    character: actor,
  };
  const assistant = {
    id: "assistant-a",
    isGM: true,
    role: 3,
    active: true,
    character: actor,
  };
  const player = {
    id: "player-a",
    isGM: false,
    role: 1,
    active: true,
    character: actor,
  };
  const users = userCollection([gm, secondaryGm, assistant, player]);
  globalThis.game = {
    user: player,
    users,
    actors,
    system: { version: "4.0.4" },
    settings: { get: () => undefined },
    socket: {
      emit(...args) {
        socketFrames.push(args);
      },
    },
  };

  const {
    ForagePromptApp,
    registerForagePromptAutoOpen,
    requestForagePromptSync,
  } = await import("./forage-prompt.js");
  const { RESOURCE_EVENTS, receiveResourcePayload } =
    await import("./resource/socket.js");

  registerForagePromptAutoOpen();
  assert.equal(
    framesOf(RESOURCE_EVENTS.PROMPT_SYNC_REQUEST).length,
    1,
    "ready registration probes the authoritative GM after listeners are bound",
  );
  assert.deepEqual(
    framesOf(RESOURCE_EVENTS.PROMPT_SYNC_REQUEST)[0][2],
    { recipients: [gm.id] },
    "prompt synchronization is private to the authoritative GM",
  );

  receiveResourcePayload(
    {
      type: RESOURCE_EVENTS.DAY_PROMPT,
      originUserId: gm.id,
      targetUserId: player.id,
      runId: "run-replayed",
      actorId: actor.id,
      promptId: "prompt-replayed",
      environment: { id: "forest", forageable: true, dc: 10 },
    },
    gm.id,
  );
  const replayed = ForagePromptApp.open({
    runId: "run-replayed",
    actorId: actor.id,
  });
  assert.equal(replayed._promptId, "prompt-replayed");
  assert.equal(replayed._state, "prompt");

  receiveResourcePayload(
    {
      type: RESOURCE_EVENTS.DAY_PROMPT,
      originUserId: gm.id,
      targetUserId: player.id,
      runId: "run-replayed",
      actorId: actor.id,
      promptId: "prompt-replayed",
      responseAccepted: true,
      environment: { id: "forest", forageable: true, dc: 10 },
    },
    gm.id,
  );
  assert.equal(
    replayed._state,
    "waiting",
    "a replayed accepted prompt resumes waiting instead of offering another roll",
  );
  const resultFramesBeforeSuppressedRoll = framesOf(
    RESOURCE_EVENTS.FORAGE_RESULT,
  ).length;
  await ForagePromptApp._onRoll.call(replayed);
  assert.equal(rollCalls, 0, "an accepted prompt cannot roll again");
  assert.equal(
    framesOf(RESOURCE_EVENTS.FORAGE_RESULT).length,
    resultFramesBeforeSuppressedRoll,
    "an accepted prompt cannot emit a duplicate result",
  );

  const rollable = ForagePromptApp.open({
    runId: "run-rollable",
    actorId: actor.id,
    promptId: "prompt-rollable",
    environment: { id: "forest", forageable: true, dc: 10 },
  });
  await ForagePromptApp._onRoll.call(rollable);
  const rolledFrame = framesOf(RESOURCE_EVENTS.FORAGE_RESULT).at(-1);
  assert.equal(rollCalls, 1);
  assert.equal(rolledFrame[1].promptId, "prompt-rollable");
  assert.deepEqual(rolledFrame[2], { recipients: [gm.id] });
  assert.equal(rollable._state, "waiting");

  const reloadedAck = {
    type: RESOURCE_EVENTS.FORAGE_ACK,
    originUserId: gm.id,
    targetUserId: player.id,
    runId: "run-after-reload",
    actorId: actor.id,
    promptId: "prompt-after-reload",
    deliveryId: "delivery-after-reload",
    success: true,
    food: 4,
    water: 2,
  };
  receiveResourcePayload(reloadedAck, gm.id);
  const restoredResult = ForagePromptApp.open({
    runId: reloadedAck.runId,
    actorId: reloadedAck.actorId,
  });
  assert.equal(
    restoredResult._state,
    "done",
    "an acknowledgement opens its terminal result even without a live prompt window",
  );
  assert.equal(restoredResult._result.food, 4);
  assert.equal(restoredResult._result.water, 2);
  const renderCountAfterFirstAck = restoredResult.renderCalls.length;
  assert.equal(
    framesOf(RESOURCE_EVENTS.ACK_DELIVERY_CONFIRM).length,
    1,
    "the restored result confirms durable delivery",
  );
  const firstConfirmation = framesOf(RESOURCE_EVENTS.ACK_DELIVERY_CONFIRM)[0];
  assert.deepEqual(
    firstConfirmation[2],
    { recipients: [gm.id] },
    "delivery confirmation is routed only to the authoritative GM",
  );
  assert.deepEqual(
    {
      runId: firstConfirmation[1].runId,
      actorId: firstConfirmation[1].actorId,
      promptId: firstConfirmation[1].promptId,
      deliveryId: firstConfirmation[1].deliveryId,
    },
    {
      runId: reloadedAck.runId,
      actorId: reloadedAck.actorId,
      promptId: reloadedAck.promptId,
      deliveryId: reloadedAck.deliveryId,
    },
  );

  receiveResourcePayload(reloadedAck, gm.id);
  assert.equal(
    restoredResult.renderCalls.length,
    renderCountAfterFirstAck,
    "a repeated delivery id does not replay the result UI",
  );
  assert.equal(
    framesOf(RESOURCE_EVENTS.ACK_DELIVERY_CONFIRM).length,
    2,
    "a duplicate acknowledgement is confirmed again in case the first receipt was lost",
  );

  const flaky = ForagePromptApp.open({
    runId: "run-render-retry",
    actorId: actor.id,
    promptId: "prompt-render-retry",
  });
  const flakyAck = {
    ...reloadedAck,
    runId: "run-render-retry",
    promptId: "prompt-render-retry",
    deliveryId: "delivery-render-retry",
  };
  const confirmationsBeforeRenderFailure = framesOf(
    RESOURCE_EVENTS.ACK_DELIVERY_CONFIRM,
  ).length;
  const originalOnAck = flaky._onAck;
  flaky._onAck = () => {
    throw new Error("render failed");
  };
  assert.throws(() => ForagePromptApp.handleAck(flakyAck), /render failed/);
  assert.equal(
    framesOf(RESOURCE_EVENTS.ACK_DELIVERY_CONFIRM).length,
    confirmationsBeforeRenderFailure,
    "a result that failed to render is not durably confirmed",
  );
  flaky._onAck = originalOnAck;
  ForagePromptApp.handleAck(flakyAck);
  assert.equal(flaky._state, "done");
  assert.equal(
    framesOf(RESOURCE_EVENTS.ACK_DELIVERY_CONFIRM).length,
    confirmationsBeforeRenderFailure + 1,
    "the same delivery is replayed and confirmed after a successful render",
  );

  const mismatched = ForagePromptApp.open({
    runId: "run-mismatch",
    actorId: actor.id,
    promptId: "prompt-current",
  });
  const confirmationsBeforeMismatch = framesOf(
    RESOURCE_EVENTS.ACK_DELIVERY_CONFIRM,
  ).length;
  receiveResourcePayload(
    {
      type: RESOURCE_EVENTS.FORAGE_ACK,
      originUserId: gm.id,
      targetUserId: player.id,
      runId: "run-mismatch",
      actorId: actor.id,
      promptId: "prompt-stale",
      deliveryId: "delivery-stale",
      success: true,
      food: 99,
    },
    gm.id,
  );
  assert.equal(mismatched._state, "prompt");
  assert.equal(
    framesOf(RESOURCE_EVENTS.ACK_DELIVERY_CONFIRM).length,
    confirmationsBeforeMismatch,
    "a stale acknowledgement is neither displayed nor confirmed for another prompt",
  );

  const syncCountBeforeReconnect = framesOf(
    RESOURCE_EVENTS.PROMPT_SYNC_REQUEST,
  ).length;
  for (const callback of hookListeners.get("userConnected") ?? []) {
    callback(gm, true);
  }
  assert.equal(
    framesOf(RESOURCE_EVENTS.PROMPT_SYNC_REQUEST).length,
    syncCountBeforeReconnect + 1,
    "the player asks for prompt synchronization when the authoritative GM reconnects",
  );

  const syncCountBeforeRetry = framesOf(
    RESOURCE_EVENTS.PROMPT_SYNC_REQUEST,
  ).length;
  ForagePromptApp._onRetryConnection.call(replayed);
  assert.equal(
    framesOf(RESOURCE_EVENTS.PROMPT_SYNC_REQUEST).length,
    syncCountBeforeRetry + 1,
    "the retry action also performs a synchronization probe",
  );

  globalThis.game.user = assistant;
  assert.ok(
    requestForagePromptSync(),
    "an Assistant GM with an assigned character remains a player-side sync client",
  );
  globalThis.game.user = secondaryGm;
  assert.ok(
    requestForagePromptSync(),
    "a non-authoritative full GM may synchronize an assigned character prompt",
  );
  const secondaryAck = {
    ...reloadedAck,
    targetUserId: secondaryGm.id,
    runId: "run-secondary-gm",
    promptId: "prompt-secondary-gm",
    deliveryId: "delivery-secondary-gm",
  };
  const confirmationsBeforeSecondaryAck = framesOf(
    RESOURCE_EVENTS.ACK_DELIVERY_CONFIRM,
  ).length;
  ForagePromptApp.handleAck(secondaryAck);
  assert.equal(
    framesOf(RESOURCE_EVENTS.ACK_DELIVERY_CONFIRM).length,
    confirmationsBeforeSecondaryAck + 1,
    "a targeted secondary full GM confirms the durable acknowledgement",
  );
  globalThis.game.user = gm;
  assert.equal(
    requestForagePromptSync(),
    null,
    "the authoritative full GM does not send a player sync request to itself",
  );
  globalThis.game.user = player;

  const legacy = ForagePromptApp.open({
    runId: "run-legacy",
    actorId: actor.id,
  });
  ForagePromptApp._onSkip.call(legacy);
  const legacyResult = framesOf(RESOURCE_EVENTS.FORAGE_RESULT).at(-1)[1];
  assert.equal(
    Object.hasOwn(legacyResult, "promptId"),
    false,
    "legacy prompts continue to emit a valid result without inventing an id",
  );

  process.stdout.write("forage prompt protocol validation passed\n");
} finally {
  for (const [key, value] of Object.entries(originalGlobals)) {
    if (value === undefined) delete globalThis[key];
    else globalThis[key] = value;
  }
}
