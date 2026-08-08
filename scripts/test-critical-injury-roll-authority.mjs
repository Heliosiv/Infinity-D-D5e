import assert from "node:assert/strict";

const saved = Object.fromEntries(
  [
    "game",
    "foundry",
    "CONST",
    "Hooks",
    "Roll",
    "ChatMessage",
    "ui",
    "JournalEntry",
    "SimpleCalendar",
  ].map((key) => [key, globalThis[key]]),
);

const gm = { id: "gm-1", isGM: true, role: 4, active: true };
const secondGm = { id: "gm-2", isGM: true, role: 4, active: true };
const player = {
  id: "player-1",
  isGM: false,
  role: 1,
  active: true,
  character: "actor-1",
};
const users = [gm, secondGm, player];
users.contents = users;
users.activeGM = gm;
users.get = (id) => users.find((user) => user.id === id) ?? null;

const actors = [];
actors.get = (id) => actors.find((actor) => actor.id === id) ?? null;
actors.contents = actors;
const settingValues = new Map([
  ["criticalInjuriesEnabled", true],
  ["criticalInjuryWorkflow", { version: 1, records: [] }],
  ["criticalInjuryWorkflowCheckpoint", {}],
]);
let failPendingTwoCompletion = false;
let signalPendingTwoCompletionFailure;
const pendingTwoCompletionFailed = new Promise(
  (resolve) => (signalPendingTwoCompletionFailure = resolve),
);
let rollCount = 0;
const authoritativeRolls = [
  { formula: "1d100", total: 74 },
  { formula: "1d100", total: 7 },
  { formula: "1d4", total: 3 },
  { formula: "1d4", total: 2 },
  { formula: "1d100", total: 74 },
];
let effectCreateCount = 0;
let chatCount = 0;
let randomCounter = 0;
const emittedFrames = [];
const originalConsoleWarn = console.warn;
const originalConsoleError = console.error;
let rejectedSpoofLogs = 0;
let simulatedFailureLogs = 0;
let simulatedProjectionLogs = 0;

try {
  console.warn = (...args) => {
    if (String(args[0] ?? "").includes("rejected incoming critical injury")) {
      rejectedSpoofLogs += 1;
      return;
    }
    if (
      String(args[0] ?? "").includes(
        "could not reconcile critical injury prompts",
      )
    ) {
      simulatedProjectionLogs += 1;
      return;
    }
    originalConsoleWarn(...args);
  };
  console.error = (...args) => {
    if (String(args[0] ?? "").includes("could not apply critical injury")) {
      simulatedFailureLogs += 1;
      return;
    }
    originalConsoleError(...args);
  };
  globalThis.CONST = {
    USER_ROLES: { GAMEMASTER: 4 },
    DOCUMENT_OWNERSHIP_LEVELS: { OWNER: 3 },
    ACTIVE_EFFECT_MODES: { MULTIPLY: 1, ADD: 2, OVERRIDE: 5 },
  };
  globalThis.foundry = {
    utils: {
      deepClone: (value) => structuredClone(value),
      randomID: () => `roll${String(++randomCounter).padStart(12, "0")}`,
    },
  };
  delete globalThis.JournalEntry;
  delete globalThis.SimpleCalendar;
  globalThis.Hooks = {
    on: () => randomCounter++,
    off: () => {},
  };
  globalThis.ui = {
    notifications: { error: () => {}, warn: () => {}, info: () => {} },
  };
  globalThis.ChatMessage = {
    getSpeaker: ({ actor } = {}) => ({ actor: actor?.id ?? null }),
    async create(data) {
      chatCount += 1;
      return { id: `chat-${chatCount}`, ...data };
    },
  };
  globalThis.Roll = class AuthoritativeRoll {
    constructor(formula) {
      this.formula = formula;
      this.total = null;
    }

    async evaluate() {
      assert.ok(
        settingValues
          .get("criticalInjuryWorkflow")
          ?.records?.some(
            (record) =>
              record.state !== "completed" &&
              record.applicationLease?.claimedBy === gm.id,
          ),
        "the authoritative GM claims the durable lease before evaluating dice",
      );
      const expected = authoritativeRolls[rollCount];
      assert.ok(
        expected,
        `unexpected extra authoritative roll ${this.formula}`,
      );
      assert.equal(this.formula, expected.formula);
      rollCount += 1;
      this.total = expected.total;
      return this;
    }
  };
  globalThis.game = {
    ready: false,
    user: gm,
    users,
    actors,
    modules: new Map(),
    time: { worldTime: 12_345 },
    socket: {
      emit(name, payload, options) {
        emittedFrames.push({
          name,
          payload: structuredClone(payload),
          options,
        });
      },
    },
    settings: {
      get(moduleId, key) {
        assert.equal(moduleId, "infinity-dnd5e");
        return settingValues.get(key);
      },
      async set(moduleId, key, value) {
        assert.equal(moduleId, "infinity-dnd5e");
        if (
          key === "criticalInjuryWorkflowCheckpoint" &&
          failPendingTwoCompletion &&
          value?.records?.some(
            (record) =>
              record.pendingId === "pending-2" && record.state === "completed",
          )
        ) {
          failPendingTwoCompletion = false;
          signalPendingTwoCompletionFailure();
          throw new Error("simulated completion persistence failure");
        }
        settingValues.set(key, structuredClone(value));
        return value;
      },
    },
  };

  const [socket, service, workflow, effects] = await Promise.all([
    import("./injury/socket.js"),
    import("./injury/service.js"),
    import("./injury/workflow-store.js"),
    import("./injury/effects.js"),
  ]);

  const actorOne = createActor("actor-1", player.id);
  actors.push(actorOne);
  await seedApproval(workflow, actorOne, "pending-1", player.id);
  const validProjection = structuredClone(
    actorOne.getFlag("infinity-dnd5e", "criticalInjuryPending")[0],
  );
  actorOne.flags["infinity-dnd5e"].criticalInjuryPending.push(
    pendingProjection(actorOne, "pending-orphan", player.id),
  );
  const failingOrphanActor = createActor("actor-failing-orphan", player.id);
  failingOrphanActor.flags["infinity-dnd5e"].criticalInjuryPending = [
    pendingProjection(failingOrphanActor, "pending-failing-orphan", player.id),
  ];
  failingOrphanActor.failNextUnsetFlag = true;
  actors.push(failingOrphanActor);
  const orphanOnlyActor = createActor("actor-orphan", player.id);
  orphanOnlyActor.flags["infinity-dnd5e"].criticalInjuryPending = [
    pendingProjection(orphanOnlyActor, "pending-orphan-only", player.id),
  ];
  actors.push(orphanOnlyActor);
  const missingProjectionActor = createActor("actor-missing", player.id);
  actors.push(missingProjectionActor);
  await workflow.createCriticalInjuryApproval({
    pendingId: "pending-missing",
    actorId: missingProjectionActor.id,
    targetUserId: player.id,
  });
  service.registerCriticalInjuryService();
  await waitUntil(
    () =>
      actorOne.getFlag("infinity-dnd5e", "criticalInjuryPending")?.length ===
        1 &&
      orphanOnlyActor.getFlag("infinity-dnd5e", "criticalInjuryPending") ===
        undefined &&
      missingProjectionActor.getFlag("infinity-dnd5e", "criticalInjuryPending")
        ?.length === 1,
    "startup pending-projection reconciliation",
  );
  assert.deepEqual(
    actorOne.getFlag("infinity-dnd5e", "criticalInjuryPending"),
    [validProjection],
    "startup removes Actor-only projections and preserves private approvals",
  );
  assert.equal(
    workflow.getCriticalInjuryWorkflowRecord("pending-orphan"),
    null,
  );
  assert.equal(
    missingProjectionActor.getFlag("infinity-dnd5e", "criticalInjuryPending")[0]
      .id,
    "pending-missing",
    "a canonical approval missing its Actor projection is restored",
  );
  assert.ok(
    failingOrphanActor.getFlag("infinity-dnd5e", "criticalInjuryPending"),
    "one Actor write failure does not abort reconciliation for later Actors",
  );
  const lateOrphanActor = createActor("actor-late-orphan", player.id);
  lateOrphanActor.flags["infinity-dnd5e"].criticalInjuryPending = [
    pendingProjection(lateOrphanActor, "pending-late-orphan", player.id),
  ];
  actors.push(lateOrphanActor);
  service.registerCriticalInjuryService();
  await waitUntil(
    () =>
      lateOrphanActor.getFlag("infinity-dnd5e", "criticalInjuryPending") ===
        undefined &&
      failingOrphanActor.getFlag("infinity-dnd5e", "criticalInjuryPending") ===
        undefined,
    "repeat startup maintenance",
  );

  const manyPendingActor = createActor("actor-many-pending", player.id);
  actors.push(manyPendingActor);
  for (let index = 1; index <= 12; index += 1) {
    await workflow.createCriticalInjuryApproval({
      pendingId: `pending-many-${index}`,
      actorId: manyPendingActor.id,
      targetUserId: player.id,
    });
  }
  await service.reconcileCriticalInjuryPendingProjections();
  const manyPending = manyPendingActor.getFlag(
    "infinity-dnd5e",
    "criticalInjuryPending",
  );
  assert.equal(manyPending.length, 12);
  assert.equal(
    new Set(manyPending.map((pending) => pending.id)).size,
    12,
    "every canonical unresolved approval remains projected",
  );
  const projectionWrites = manyPendingActor.setFlagCount;
  await service.reconcileCriticalInjuryPendingProjections();
  assert.equal(
    manyPendingActor.setFlagCount,
    projectionWrites,
    "a second reconciliation does not rewrite an already complete projection",
  );

  const spoofed = {
    type: socket.CRITICAL_INJURY_EVENTS.ROLL_REQUEST,
    actorId: actorOne.id,
    pendingId: "pending-1",
    targetUserId: gm.id,
    originUserId: player.id,
    rollTotal: 1,
  };
  socket.receiveCriticalInjuryPayload(spoofed, player.id);
  await nextTask();
  assert.equal(rollCount, 0, "a client-supplied table result is rejected");
  assert.equal(actorOne.effects.contents.length, 0);

  const firstResult = waitForResult(socket, "pending-1");
  const duplicateFailure = waitForRollFailure(socket, "pending-1", gm.id);
  const validRequest = {
    type: socket.CRITICAL_INJURY_EVENTS.ROLL_REQUEST,
    actorId: actorOne.id,
    pendingId: "pending-1",
    targetUserId: gm.id,
    originUserId: player.id,
  };
  socket.receiveCriticalInjuryPayload(validRequest, player.id);
  socket.emitCriticalInjuryEvent(socket.CRITICAL_INJURY_EVENTS.ROLL_REQUEST, {
    actorId: actorOne.id,
    pendingId: "pending-1",
    targetUserId: gm.id,
  });
  const [firstPayload, duplicateFailurePayload] = await Promise.all([
    firstResult,
    duplicateFailure,
  ]);
  assert.equal(duplicateFailurePayload.retryable, true);
  assert.match(duplicateFailurePayload.message, /already being applied/i);
  assert.equal(rollCount, 1, "concurrent duplicate requests roll once");
  assert.equal(effectCreateCount, 1, "one injury effect is created");
  assert.equal(actorOne.effects.contents.length, 1);
  assert.equal(firstPayload.result.injuryRoll, 74);
  assert.equal(firstPayload.result.injuryKey, "deep-scar");
  assert.equal(
    effects.getCriticalInjuryData(actorOne.effects.contents[0]).createdBy,
    gm.id,
    "the authoritative GM is recorded as the injury creator",
  );
  assert.equal(
    actorOne.getFlag("infinity-dnd5e", "criticalInjuryPending"),
    undefined,
  );
  assert.ok(
    emittedFrames.some(
      (frame) =>
        frame.payload.type === socket.CRITICAL_INJURY_EVENTS.RESULT &&
        frame.payload.pendingId === "pending-1" &&
        frame.payload.targetUserId === gm.id,
    ),
    "the prompted GM receives the result after a player wins the request race",
  );
  await waitUntil(() => chatCount === 1, "first injury chat message");

  const replay = waitForResult(socket, "pending-1");
  socket.receiveCriticalInjuryPayload(validRequest, player.id);
  const replayPayload = await replay;
  assert.deepEqual(
    replayPayload.result,
    firstPayload.result,
    "a completed receipt replays the exact same result",
  );
  assert.equal(rollCount, 1);
  assert.equal(effectCreateCount, 1);
  await nextTask();
  assert.equal(chatCount, 1, "a replayed completion does not duplicate chat");

  settingValues.set("criticalInjuriesEnabled", false);
  const disabledFailure = waitForRollFailure(
    socket,
    "pending-disabled",
    player.id,
  );
  socket.receiveCriticalInjuryPayload(
    { ...validRequest, pendingId: "pending-disabled" },
    player.id,
  );
  const disabledPayload = await disabledFailure;
  assert.equal(disabledPayload.retryable, true);
  assert.match(disabledPayload.message, /currently disabled/i);
  assert.equal(rollCount, 1);
  settingValues.set("criticalInjuriesEnabled", true);

  const actorTwo = createActor("actor-2", player.id);
  actors.push(actorTwo);
  await seedApproval(workflow, actorTwo, "pending-2", player.id);
  failPendingTwoCompletion = true;
  const retryRequest = {
    ...validRequest,
    actorId: actorTwo.id,
    pendingId: "pending-2",
  };
  const firstRetryFailure = waitForRollFailure(socket, "pending-2", player.id);
  socket.receiveCriticalInjuryPayload(retryRequest, player.id);
  await pendingTwoCompletionFailed;
  const firstRetryFailurePayload = await firstRetryFailure;
  assert.equal(firstRetryFailurePayload.retryable, true);
  assert.equal(
    emittedFrames.some(
      (frame) =>
        frame.payload.type === socket.CRITICAL_INJURY_EVENTS.RESULT &&
        frame.payload.pendingId === "pending-2",
    ),
    false,
  );
  assert.ok(
    actorTwo.getFlag("infinity-dnd5e", "criticalInjuryPending")?.length,
    "a retryable persistence failure keeps the approved projection",
  );
  assert.equal(rollCount, 4);
  assert.equal(actorTwo.effects.contents.length, 1);
  const pendingTwoResolution =
    workflow.getCriticalInjuryWorkflowRecord("pending-2");
  assert.equal(
    pendingTwoResolution.state,
    "resolving",
    "a failed checkpoint write leaves the durable resolution retryable",
  );
  assert.equal(pendingTwoResolution.resolution.injuryRoll, 7);
  assert.equal(pendingTwoResolution.resolution.recoveryDays, 3);
  assert.equal(pendingTwoResolution.resolution.detailTotal, 2);

  const retryResult = waitForResult(socket, "pending-2");
  socket.receiveCriticalInjuryPayload(retryRequest, player.id);
  const retryPayload = await retryResult;
  assert.equal(retryPayload.result.injuryRoll, 7);
  assert.equal(retryPayload.result.injuryKey, "crippling-injury");
  assert.equal(retryPayload.result.remainingDays, 3);
  assert.ok(retryPayload.result.detail);
  assert.equal(
    rollCount,
    4,
    "retry reuses the persisted d100, recovery, and detail rolls",
  );
  assert.equal(
    actorTwo.effects.contents.length,
    1,
    "retry updates the canonical effect instead of duplicating it",
  );
  assert.equal(
    workflow.getCriticalInjuryWorkflowRecord("pending-2").state,
    "completed",
  );

  const forgedActor = createActor("actor-forged", player.id);
  actors.push(forgedActor);
  forgedActor.flags["infinity-dnd5e"].criticalInjuryPending = [
    pendingProjection(forgedActor, "pending-forged", player.id),
  ];
  const forgedFailure = waitForRollFailure(socket, "pending-forged", player.id);
  socket.receiveCriticalInjuryPayload(
    {
      ...validRequest,
      actorId: forgedActor.id,
      pendingId: "pending-forged",
    },
    player.id,
  );
  const forgedFailurePayload = await forgedFailure;
  assert.equal(forgedFailurePayload.retryable, false);
  assert.equal(
    forgedActor.effects.contents.length,
    0,
    "an Actor-only forged approval is not an authorization record",
  );
  assert.equal(
    forgedActor.getFlag("infinity-dnd5e", "criticalInjuryPending"),
    undefined,
    "an invalid Actor-only projection is cleared immediately",
  );
  assert.equal(rollCount, 4);

  const actorFour = createActor("actor-4", player.id);
  actors.push(actorFour);
  await seedApproval(workflow, actorFour, "pending-4", player.id);
  actorFour.ownership[player.id] = 0;
  const ownershipFailure = waitForRollFailure(socket, "pending-4", player.id);
  socket.receiveCriticalInjuryPayload(
    {
      ...validRequest,
      actorId: actorFour.id,
      pendingId: "pending-4",
    },
    player.id,
  );
  const ownershipFailurePayload = await ownershipFailure;
  assert.equal(ownershipFailurePayload.retryable, false);
  assert.equal(
    workflow.getCriticalInjuryWorkflowRecord("pending-4").targetUserId,
    gm.id,
  );
  assert.equal(
    actorFour.getFlag("infinity-dnd5e", "criticalInjuryPending")[0]
      .targetUserId,
    gm.id,
    "lost ownership durably moves the approval to the active GM",
  );
  assert.equal(rollCount, 4);

  const actorThree = createActor("actor-3", player.id);
  actors.push(actorThree);
  await seedApproval(workflow, actorThree, "pending-3", player.id);
  const secondaryFailure = waitForRollFailure(socket, "pending-3", secondGm.id);
  socket.receiveCriticalInjuryPayload(
    {
      ...validRequest,
      actorId: actorThree.id,
      pendingId: "pending-3",
      originUserId: secondGm.id,
    },
    secondGm.id,
  );
  const secondaryFailurePayload = await secondaryFailure;
  assert.equal(secondaryFailurePayload.retryable, false);
  assert.equal(
    actorThree.effects.contents.length,
    0,
    "a secondary GM cannot replace the recorded player or active authority",
  );
  assert.equal(
    actorThree.getFlag("infinity-dnd5e", "criticalInjuryPending")[0]
      .targetUserId,
    player.id,
    "a secondary GM rejection preserves the player's valid approval",
  );
  assert.equal(rollCount, 4);

  const gmResult = waitForResult(socket, "pending-3", gm.id);
  const frameStart = emittedFrames.length;
  socket.emitCriticalInjuryEvent(socket.CRITICAL_INJURY_EVENTS.ROLL_REQUEST, {
    actorId: actorThree.id,
    pendingId: "pending-3",
    targetUserId: gm.id,
  });
  const gmPayload = await gmResult;
  const gmDeliveries = emittedFrames
    .slice(frameStart)
    .filter(
      (frame) =>
        frame.payload.type === socket.CRITICAL_INJURY_EVENTS.RESULT &&
        frame.payload.pendingId === "pending-3",
    );
  assert.deepEqual(
    gmDeliveries
      .map((frame) => frame.payload.targetUserId)
      .sort((left, right) => left.localeCompare(right)),
    [gm.id, player.id].sort((left, right) => left.localeCompare(right)),
    "the player and requesting authoritative GM both receive the result",
  );
  assert.equal(gmPayload.targetUserId, gm.id);
  assert.equal(actorThree.effects.contents.length, 1);
  assert.equal(
    workflow.getCriticalInjuryWorkflowRecord("pending-3").state,
    "completed",
  );
  await waitUntil(() => chatCount === 3, "GM-on-behalf injury chat");

  assert.equal(
    emittedFrames.filter(
      (frame) =>
        frame.payload.type === socket.CRITICAL_INJURY_EVENTS.RESULT &&
        frame.payload.pendingId === "pending-1",
    ).length,
    3,
    "the initial player/GM result and requested player replay are targeted",
  );
  assert.equal(chatCount, 3, "each newly completed injury is announced once");
  assert.equal(rollCount, authoritativeRolls.length);
  assert.equal(rejectedSpoofLogs, 1);
  assert.equal(simulatedFailureLogs, 1);
  assert.equal(simulatedProjectionLogs, 1);
} finally {
  console.warn = originalConsoleWarn;
  console.error = originalConsoleError;
  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) delete globalThis[key];
    else globalThis[key] = value;
  }
}

function createActor(id, ownerId) {
  const actor = {
    id,
    uuid: `Actor.${id}`,
    name: `Hero ${id}`,
    type: "character",
    ownership: { default: 0, [ownerId]: 3 },
    system: { attributes: { hp: { value: 1 }, exhaustion: 0 } },
    flags: { "infinity-dnd5e": {} },
    effects: { contents: [] },
    getFlag(moduleId, key) {
      return this.flags?.[moduleId]?.[key];
    },
    async setFlag(moduleId, key, value) {
      this.setFlagCount = Number(this.setFlagCount ?? 0) + 1;
      this.flags[moduleId] ??= {};
      this.flags[moduleId][key] = structuredClone(value);
      return value;
    },
    async unsetFlag(moduleId, key) {
      if (this.failNextUnsetFlag) {
        this.failNextUnsetFlag = false;
        throw new Error("simulated Actor flag write failure");
      }
      delete this.flags?.[moduleId]?.[key];
      return true;
    },
    async createEmbeddedDocuments(type, rows, options = {}) {
      assert.equal(type, "ActiveEffect");
      assert.equal(String(rows[0]?._id ?? "").length, 16);
      assert.deepEqual(options, { keepId: true });
      effectCreateCount += rows.length;
      const created = rows.map((row, index) => {
        const effect = {
          id: row._id ?? `effect-${id}-${effectCreateCount + index}`,
          parent: actor,
          ...structuredClone(row),
          getFlag(moduleId, key) {
            return this.flags?.[moduleId]?.[key];
          },
          async update(update) {
            Object.assign(this, structuredClone(update));
            return this;
          },
          async delete() {
            actor.effects.contents = actor.effects.contents.filter(
              (candidate) => candidate !== this,
            );
          },
        };
        actor.effects.contents.push(effect);
        return effect;
      });
      return created;
    },
  };
  return actor;
}

function pendingProjection(actor, pendingId, targetUserId) {
  return {
    id: pendingId,
    actorId: actor.id,
    actorName: actor.name,
    targetUserId,
    approvedBy: gm.id,
    createdAt: Date.now(),
  };
}

async function seedApproval(workflow, actor, pendingId, targetUserId) {
  await workflow.createCriticalInjuryApproval({
    pendingId,
    actorId: actor.id,
    targetUserId,
  });
  actor.flags["infinity-dnd5e"].criticalInjuryPending = [
    pendingProjection(actor, pendingId, targetUserId),
  ];
}

function waitForResult(socket, pendingId, targetUserId = null) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`timed out waiting for ${pendingId}`)),
      2000,
    );
    const unsubscribe = socket.subscribeCriticalInjury(
      socket.CRITICAL_INJURY_EVENTS.RESULT,
      (payload) => {
        if (payload.pendingId !== pendingId) return;
        if (
          targetUserId &&
          String(payload.targetUserId) !== String(targetUserId)
        ) {
          return;
        }
        clearTimeout(timer);
        unsubscribe();
        resolve(payload);
      },
    );
  });
}

function waitForRollFailure(socket, pendingId, targetUserId) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`timed out waiting for ${pendingId} failure`)),
      2000,
    );
    const unsubscribe = socket.subscribeCriticalInjury(
      socket.CRITICAL_INJURY_EVENTS.ROLL_FAILURE,
      (payload) => {
        if (payload.pendingId !== pendingId) return;
        if (String(payload.targetUserId) !== String(targetUserId)) return;
        clearTimeout(timer);
        unsubscribe();
        resolve(payload);
      },
    );
  });
}

async function waitUntil(predicate, label) {
  const deadline = Date.now() + 2000;
  while (!predicate()) {
    if (Date.now() >= deadline) {
      throw new Error(`timed out waiting for ${label}`);
    }
    await nextTask();
  }
}

function nextTask() {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

process.stdout.write("critical injury GM-authoritative replay flow passed\n");
