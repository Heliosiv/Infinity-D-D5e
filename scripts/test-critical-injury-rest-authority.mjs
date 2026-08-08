import assert from "node:assert/strict";

const GLOBAL_KEYS = [
  "ChatMessage",
  "CONST",
  "Hooks",
  "JournalEntry",
  "SimpleCalendar",
  "foundry",
  "game",
  "ui",
];
const savedGlobals = Object.fromEntries(
  GLOBAL_KEYS.map((key) => [key, globalThis[key]]),
);

const MODULE_ID = "infinity-dnd5e";
const REST_ID = "rest-actor-rest-message-durable-infection-1";
const STARTUP_REST_ID = "rest-actor-startup-message-startup-infection";
const gmA = { id: "gm-rest-a", isGM: true, role: 4, active: true };
const gmB = { id: "gm-rest-b", isGM: true, role: 4, active: true };
const player = {
  id: "player-rest-owner",
  isGM: false,
  role: 1,
  active: true,
  character: "actor-rest",
};
const outsider = {
  id: "player-rest-outsider",
  isGM: false,
  role: 1,
  active: true,
  character: null,
};
const assignedNonOwner = {
  id: "player-rest-assigned-non-owner",
  isGM: false,
  role: 1,
  active: true,
  character: "actor-rest",
};
const users = [gmA, gmB, player, outsider, assignedNonOwner];
users.contents = users;
users.activeGM = gmA;
users.get = (id) => users.find((user) => user.id === id) ?? null;

const actors = [];
actors.contents = actors;
actors.get = (id) => actors.find((actor) => actor.id === id) ?? null;
const messages = [];
messages.contents = messages;
messages.get = (id) => messages.find((message) => message.id === id) ?? null;

const settings = new Map([
  ["criticalInjuriesEnabled", true],
  ["criticalInjuryWorkflow", {}],
  ["criticalInjuryWorkflowCheckpoint", {}],
]);
const emittedFrames = [];
const saveTotals = [7, 9];
let randomCounter = 0;
let saveRollCount = 0;
let chatCount = 0;
let chatCountBeforeMain = 0;
let ambiguousPrivateWriteCount = 0;
let handoffResolve;
const handoffObserved = new Promise((resolve) => (handoffResolve = resolve));
let effectsById = new Map();
const chatExpectations = new Map();
let serverAdvanceTimer = null;
const originalConsoleError = console.error;
const originalConsoleWarn = console.warn;
const unexpectedConsoleErrors = [];
const originalDateNow = Date.now;
let wallClockMs = 1_800_000_000_000;

try {
  Date.now = () => wallClockMs;
  console.error = (...args) => {
    if (String(args[0] ?? "").includes("infection rest")) {
      return;
    }
    unexpectedConsoleErrors.push(args);
  };
  console.warn = (...args) => {
    const message = String(args[0] ?? "");
    if (
      message.includes("critical injury workflow") ||
      message.includes("rejected incoming critical injury event")
    ) {
      return;
    }
    originalConsoleWarn(...args);
  };

  globalThis.CONST = {
    USER_ROLES: { GAMEMASTER: 4 },
    DOCUMENT_OWNERSHIP_LEVELS: { OWNER: 3 },
    ACTIVE_EFFECT_MODES: { MULTIPLY: 1, ADD: 2, OVERRIDE: 5 },
  };
  globalThis.Hooks = { on: () => ++randomCounter, off: () => {} };
  globalThis.foundry = {
    utils: {
      deepClone: (value) => structuredClone(value),
      randomID: () => `r${String(++randomCounter).padStart(23, "0")}`,
    },
  };
  delete globalThis.JournalEntry;
  delete globalThis.SimpleCalendar;
  globalThis.ui = {
    notifications: { error() {}, warn() {}, info() {} },
  };
  globalThis.ChatMessage = {
    getSpeaker: ({ actor } = {}) => ({ actor: actor?.id ?? null }),
    async create(data) {
      const expected = chatExpectation(data?.content);
      const event = storedRestEvent(expected?.restId);
      assert.ok(event, "the rest event is durable before chat is created");
      assert.ok(
        eventOutcomeFor(event, expected?.injuryId),
        "the matching authoritative save outcome is durable before chat",
      );
      chatCount += 1;
      return { id: `chat-rest-${chatCount}`, ...data };
    },
  };
  globalThis.game = {
    ready: false,
    user: gmA,
    users,
    actors,
    messages,
    modules: new Map([
      ["midi-qol", { active: true }],
      ["foundryvtt-simple-calendar", { active: false }],
    ]),
    time: { worldTime: 1_000_000, serverTime: 20_000 },
    socket: {
      emit(name, payload, options) {
        emittedFrames.push({
          name,
          payload: structuredClone(payload),
          options: structuredClone(options),
        });
      },
    },
    settings: {
      get(moduleId, key) {
        assert.equal(moduleId, MODULE_ID);
        return settings.get(key);
      },
      async set(moduleId, key, value) {
        assert.equal(moduleId, MODULE_ID);
        settings.set(key, structuredClone(value));

        // The checkpoint is the private workflow's durable commit point. Its
        // write applies, the authority changes, and the promise then rejects.
        // A replacement GM must adopt this outcome instead of rolling again.
        const event = findRestEvent(value, REST_ID);
        if (
          key === "criticalInjuryWorkflowCheckpoint" &&
          ambiguousPrivateWriteCount === 0 &&
          event?.resolution?.outcomes?.length > 0
        ) {
          ambiguousPrivateWriteCount += 1;
          assert.equal(
            totalEffectUpdates(),
            0,
            "the authoritative save is persisted before any ActiveEffect write",
          );
          assert.equal(
            chatCount,
            chatCountBeforeMain,
            "the authoritative save is persisted before any result chat",
          );
          users.activeGM = gmB;
          handoffResolve();
          throw new Error(
            "simulated private workflow apply-then-throw during GM handoff",
          );
        }
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

  const actor = createActor();
  const infectionA = createInjury({
    id: "infection-rest-a",
    pendingId: "pending-rest-a",
  });
  const infectionB = createInjury({
    id: "infection-rest-b",
    pendingId: "pending-rest-b",
  });
  const effectA = createEffect(
    "effect-rest-a",
    actor,
    effects.buildCriticalInjuryEffectData(infectionA, {
      startTime: 900_000,
      dueTimestamp: infectionA.recoveryDueTs,
    }),
    { applyThenThrow: true },
  );
  const effectB = createEffect(
    "effect-rest-b",
    actor,
    effects.buildCriticalInjuryEffectData(infectionB, {
      startTime: 900_000,
      dueTimestamp: infectionB.recoveryDueTs,
    }),
  );
  actor.effects.contents.push(effectA, effectB);
  effectsById = new Map([
    [effectA.id, effectA],
    [effectB.id, effectB],
  ]);
  chatExpectations.set(infectionA.injuryName, {
    restId: REST_ID,
    injuryId: infectionA.id,
  });
  chatExpectations.set(infectionB.injuryName, {
    restId: REST_ID,
    injuryId: infectionB.id,
  });

  const startupActor = createActor({
    id: "actor-startup",
    name: "Bryn",
    rollAbilitySave: async () => {
      throw new Error("a persisted startup outcome must not be rerolled");
    },
  });
  const startupInfection = createInjury({
    id: "infection-startup",
    pendingId: "pending-startup",
    actorId: startupActor.id,
    injuryName: "Startup Infection",
  });
  const startupEffect = createEffect(
    "effect-startup",
    startupActor,
    effects.buildCriticalInjuryEffectData(startupInfection, {
      startTime: 900_000,
      dueTimestamp: startupInfection.recoveryDueTs,
    }),
    { restId: STARTUP_REST_ID },
  );
  startupActor.effects.contents.push(startupEffect);
  chatExpectations.set(startupInfection.injuryName, {
    restId: STARTUP_REST_ID,
    injuryId: startupInfection.id,
  });
  actors.push(actor, startupActor);

  await seedCompletedInjuryWorkflow(
    workflow,
    infectionA,
    effectA.id,
    "lease-rest-a",
  );
  await seedCompletedInjuryWorkflow(
    workflow,
    infectionB,
    effectB.id,
    "lease-rest-b",
  );
  await seedCompletedInjuryWorkflow(
    workflow,
    startupInfection,
    startupEffect.id,
    "lease-startup-injury",
  );
  await workflow.createCriticalInjuryRestRequest({
    restId: STARTUP_REST_ID,
    actorId: startupActor.id,
    requestedBy: player.id,
    requestedAt: wallClockMs - 1000,
  });
  await workflow.claimCriticalInjuryRestApplication(STARTUP_REST_ID, {
    id: "lease-startup-rest",
    claimedBy: gmA.id,
    leaseDurationMs: 5_000,
  });
  await workflow.persistCriticalInjuryRestResolution(
    STARTUP_REST_ID,
    {
      resolvedBy: gmA.id,
      resolvedAt: wallClockMs - 500,
      outcomes: [
        {
          effectId: startupEffect.id,
          injuryId: startupInfection.id,
          pendingId: startupInfection.pendingId,
          saveTotal: 6,
          passed: false,
          infectionHpLossBefore: 0,
          infectionHpLossAfter: 1,
          receiptToken: "receipt-startup-rest",
        },
      ],
    },
    { applicationLeaseId: "lease-startup-rest" },
  );
  // Leave the old live lease in place so startup must schedule a retry. Move
  // Foundry's synchronized clock past expiry before that retry fires.
  globalThis.game.time.serverTime = 24_800;
  serverAdvanceTimer = setTimeout(() => {
    globalThis.game.time.serverTime = 25_100;
  }, 100);
  service.registerCriticalInjuryService();
  await waitUntil(
    () =>
      Number(
        effects.getCriticalInjuryData(startupEffect)?.infectionHpLoss ?? 0,
      ) === 1 && storedRestEvent(STARTUP_REST_ID)?.state === "completed",
    "scheduled startup restoration of a persisted Infection rest",
  );
  clearTimeout(serverAdvanceTimer);
  serverAdvanceTimer = null;
  assert.equal(
    startupEffect.updateCount,
    1,
    "startup resumes the stored absolute outcome exactly once",
  );
  assert.equal(
    saveRollCount,
    0,
    "startup recovery never rerolls a persisted Infection save",
  );
  chatCountBeforeMain = chatCount;

  const restMessage = createRestMessage({
    id: "message-durable-infection-1",
    actorId: actor.id,
    author: player,
  });
  messages.push(restMessage);
  assert.equal(
    REST_ID,
    `rest-${actor.id}-${restMessage.id}`,
    "the test rest id follows the deterministic wire identity",
  );

  const firstRequest = restRequest(socket, {
    actorId: actor.id,
    restId: REST_ID,
    restMessageId: restMessage.id,
    targetUserId: gmA.id,
    sender: player,
  });
  assert.deepEqual(socket.validateCriticalInjuryPayload(firstRequest), {
    ok: true,
    reason: null,
  });
  socket.receiveCriticalInjuryPayload(firstRequest, player.id);
  await withTimeout(handoffObserved, "persisted Infection save handoff");
  await nextTasks(5);
  assert.equal(ambiguousPrivateWriteCount, 1);
  assert.ok(
    saveRollCount >= 1 && saveRollCount <= 2,
    "the original GM persisted at least one save before authority changed",
  );

  globalThis.game.user = gmB;
  for (let attempt = 0; attempt < 5 && !infectionsApplied(); attempt += 1) {
    socket.receiveCriticalInjuryPayload(
      restRequest(socket, {
        actorId: actor.id,
        restId: REST_ID,
        restMessageId: restMessage.id,
        targetUserId: gmB.id,
        sender: player,
      }),
      player.id,
    );
    await nextTasks(8);
  }

  assert.equal(
    saveRollCount,
    2,
    "each Infection save is rolled once across retry and GM handoff",
  );
  assert.equal(
    effects.getCriticalInjuryData(effectA).infectionHpLoss,
    1,
    "the ambiguous first effect write is adopted at one maximum-HP loss",
  );
  assert.equal(
    effects.getCriticalInjuryData(effectB).infectionHpLoss,
    1,
    "the second Infection receives its one failed-save penalty",
  );
  assert.equal(
    effectA.updateCount,
    1,
    "an apply-then-throw effect update is verified instead of repeated",
  );
  assert.equal(
    effectB.updateCount,
    1,
    "each additional Infection effect is applied exactly once",
  );
  assert.deepEqual(effectPenaltyValues(effectA), ["-1"]);
  assert.deepEqual(effectPenaltyValues(effectB), ["-1"]);
  assert.equal(
    chatCount - chatCountBeforeMain,
    2,
    "each failed Infection produces one result chat",
  );

  const completedEvent = storedRestEvent(REST_ID);
  assert.equal(completedEvent?.state, "completed");
  assert.equal(completedEvent?.resolution?.outcomes?.length, 2);
  for (const [effect, injury] of [
    [effectA, infectionA],
    [effectB, infectionB],
  ]) {
    assert.deepEqual(
      eventOutcomeFor(completedEvent, injury.id),
      {
        effectId: effect.id,
        injuryId: injury.id,
        pendingId: injury.pendingId,
        saveTotal: infectionA.id === injury.id ? 7 : 9,
        passed: false,
        infectionHpLossBefore: 0,
        infectionHpLossAfter: 1,
      },
      "the completed receipt preserves the authoritative save and exact penalty transition",
    );
  }

  const completedSnapshot = mutationSnapshot(effectA, effectB);
  wallClockMs += 10_000;
  globalThis.game.time.serverTime += 120_000;
  socket.receiveCriticalInjuryPayload(
    restRequest(socket, {
      actorId: actor.id,
      restId: REST_ID,
      restMessageId: restMessage.id,
      targetUserId: gmB.id,
      sender: player,
    }),
    player.id,
  );
  await nextTasks(8);
  assert.deepEqual(
    mutationSnapshot(effectA, effectB),
    completedSnapshot,
    "a completed rest replay does not reroll, stack HP loss, rewrite effects, or duplicate chat",
  );

  const unauthorizedBaseline = mutationSnapshot(effectA, effectB);
  const unauthorizedMessage = createRestMessage({
    id: "message-unauthorized",
    actorId: actor.id,
    author: outsider,
  });
  messages.push(unauthorizedMessage);
  socket.receiveCriticalInjuryPayload(
    restRequest(socket, {
      actorId: actor.id,
      restId: `rest-${actor.id}-${unauthorizedMessage.id}`,
      restMessageId: unauthorizedMessage.id,
      targetUserId: gmB.id,
      sender: outsider,
    }),
    outsider.id,
  );
  await nextTasks(5);
  assert.deepEqual(
    mutationSnapshot(effectA, effectB),
    unauthorizedBaseline,
    "an active user without Actor control cannot create or process a rest event",
  );
  assert.equal(
    storedRestEvent(`rest-${actor.id}-${unauthorizedMessage.id}`),
    null,
  );

  const assignedNonOwnerMessage = createRestMessage({
    id: "message-assigned-non-owner",
    actorId: actor.id,
    author: assignedNonOwner,
  });
  messages.push(assignedNonOwnerMessage);
  const assignedNonOwnerRestId = `rest-${actor.id}-${assignedNonOwnerMessage.id}`;
  socket.receiveCriticalInjuryPayload(
    restRequest(socket, {
      actorId: actor.id,
      restId: assignedNonOwnerRestId,
      restMessageId: assignedNonOwnerMessage.id,
      targetUserId: gmB.id,
      sender: assignedNonOwner,
    }),
    assignedNonOwner.id,
  );
  await nextTasks(5);
  assert.equal(
    storedRestEvent(assignedNonOwnerRestId),
    null,
    "character assignment without effective ownership cannot forge a rest",
  );
  assert.deepEqual(
    mutationSnapshot(effectA, effectB),
    unauthorizedBaseline,
    "an assigned non-owner cannot roll or mutate Infection effects",
  );

  const invalidEvidence = [
    {
      message: {
        ...createRestMessage({
          id: "message-short-rest",
          actorId: actor.id,
          author: player,
        }),
        flags: { dnd5e: { rest: { type: "short" } } },
      },
      label: "short-rest evidence",
    },
    {
      message: createRestMessage({
        id: "message-wrong-actor",
        actorId: "actor-someone-else",
        author: player,
      }),
      label: "another Actor's rest evidence",
    },
    {
      message: createRestMessage({
        id: "message-wrong-author",
        actorId: actor.id,
        author: gmB,
      }),
      label: "another user's rest evidence",
    },
  ];
  for (const { message, label } of invalidEvidence) {
    messages.push(message);
    const invalidRestId = `rest-${actor.id}-${message.id}`;
    socket.receiveCriticalInjuryPayload(
      restRequest(socket, {
        actorId: actor.id,
        restId: invalidRestId,
        restMessageId: message.id,
        targetUserId: gmB.id,
        sender: player,
      }),
      player.id,
    );
    await nextTasks(3);
    assert.equal(
      storedRestEvent(invalidRestId),
      null,
      `${label} is rejected before durable workflow creation`,
    );
  }
  assert.deepEqual(
    mutationSnapshot(effectA, effectB),
    unauthorizedBaseline,
    "unverifiable rest messages cannot roll or mutate Infection effects",
  );

  const forgedMessage = createRestMessage({
    id: "message-forged-total",
    actorId: actor.id,
    author: player,
  });
  messages.push(forgedMessage);
  const forgedRestId = `rest-${actor.id}-${forgedMessage.id}`;
  const malformed = {
    ...restRequest(socket, {
      actorId: actor.id,
      restId: forgedRestId,
      restMessageId: forgedMessage.id,
      targetUserId: gmB.id,
      sender: player,
    }),
    saveTotals: [20, 20],
  };
  assert.equal(socket.validateCriticalInjuryPayload(malformed).ok, false);
  socket.receiveCriticalInjuryPayload(malformed, player.id);
  socket.receiveCriticalInjuryPayload(
    {
      type: socket.CRITICAL_INJURY_EVENTS.REST_COMPLETED,
      actorId: actor.id,
      restMessageId: forgedMessage.id,
      targetUserId: gmB.id,
      originUserId: player.id,
      longRest: true,
    },
    player.id,
  );
  await nextTasks(5);
  assert.deepEqual(
    mutationSnapshot(effectA, effectB),
    unauthorizedBaseline,
    "malformed or client-authored save data fails closed",
  );
  assert.equal(storedRestEvent(forgedRestId), null);
  assert.deepEqual(
    unexpectedConsoleErrors,
    [],
    "startup and replay maintenance complete without hidden service errors",
  );
} finally {
  if (serverAdvanceTimer != null) clearTimeout(serverAdvanceTimer);
  Date.now = originalDateNow;
  console.error = originalConsoleError;
  console.warn = originalConsoleWarn;
  for (const [key, value] of Object.entries(savedGlobals)) {
    if (value === undefined) delete globalThis[key];
    else globalThis[key] = value;
  }
}

function createActor({
  id = "actor-rest",
  name = "Aric",
  rollAbilitySave,
} = {}) {
  const effects = [];
  effects.contents = effects;
  effects.get = (id) => effects.find((effect) => effect.id === id) ?? null;
  const actor = {
    id,
    uuid: `Actor.${id}`,
    name,
    type: "character",
    ownership: { default: 0, [player.id]: 3 },
    system: { attributes: { hp: { value: 8, max: 12 } } },
    items: { contents: [] },
    effects,
    flags: { [MODULE_ID]: {} },
    rollAbilitySave:
      rollAbilitySave ??
      (async (abilityId, options) => {
        assert.equal(abilityId, "con");
        assert.equal(options?.fastForward, true);
        assert.equal(
          options?.chatMessage,
          false,
          "the save roll cannot publish chat before its outcome is durable",
        );
        const total = saveTotals[saveRollCount];
        saveRollCount += 1;
        if (!Number.isFinite(total)) {
          throw new Error("an Infection save was rerolled unexpectedly");
        }
        return { total };
      }),
    getFlag(moduleId, key) {
      return this.flags?.[moduleId]?.[key];
    },
    async setFlag(moduleId, key, value) {
      this.flags[moduleId] ??= {};
      this.flags[moduleId][key] = structuredClone(value);
      return value;
    },
    async unsetFlag(moduleId, key) {
      delete this.flags?.[moduleId]?.[key];
      return true;
    },
  };
  return actor;
}

function createEffect(
  id,
  actor,
  data,
  { applyThenThrow = false, restId = REST_ID } = {},
) {
  return {
    id,
    _id: id,
    parent: actor,
    ...structuredClone(data),
    updateCount: 0,
    getFlag(moduleId, key) {
      return this.flags?.[moduleId]?.[key];
    },
    async update(changes) {
      const injuryId = this.getFlag(MODULE_ID, "criticalInjury")?.id;
      const event = storedRestEvent(restId);
      assert.ok(event, "the rest event is durable before effect mutation");
      assert.ok(
        eventOutcomeFor(event, injuryId),
        "the matching save outcome is durable before effect mutation",
      );
      this.updateCount += 1;
      applyChanges(this, changes);
      if (applyThenThrow && this.updateCount === 1) {
        throw new Error("simulated apply-then-throw ActiveEffect update");
      }
      return this;
    },
  };
}

function createInjury({
  id,
  pendingId,
  actorId = "actor-rest",
  injuryName = null,
}) {
  const suffix = id.endsWith("-a") ? "A" : "B";
  return {
    id,
    pendingId,
    actorId,
    injuryKey: "infection",
    injuryName: injuryName ?? `Infection ${suffix}`,
    injuryRoll: 58,
    tableVersion: 2,
    effect:
      "After each long rest, make a DC 15 Constitution save. On a failure, lose 1 maximum HP until the infection heals.",
    recoveryRule: "2 Healer's Kit charges or 1d6 days of rest.",
    recoveryFormula: "1d6",
    remainingDays: 4,
    permanent: false,
    stabilized: false,
    kitCharges: 2,
    treatmentDc: 0,
    treatmentSkill: "",
    canBecomePermanent: false,
    downgradeTo: "",
    downgradeHalfDays: false,
    detail: null,
    infectionHpLoss: 0,
    createdAt: 900_000,
    createdBy: gmA.id,
    requestedBy: player.id,
    recoveryDueTs: 1_345_600,
    calendarEntryId: "",
  };
}

async function seedCompletedInjuryWorkflow(
  workflow,
  injury,
  effectId,
  leaseId,
) {
  await workflow.createCriticalInjuryApproval({
    pendingId: injury.pendingId,
    actorId: injury.actorId,
    targetUserId: player.id,
    approvedAt: injury.createdAt,
  });
  await workflow.claimCriticalInjuryApplication(injury.pendingId, {
    id: leaseId,
    claimedBy: gmA.id,
  });
  await workflow.persistCriticalInjuryResolution(
    injury.pendingId,
    {
      injuryId: injury.id,
      effectDocumentId: effectId,
      injuryKey: injury.injuryKey,
      injuryRoll: injury.injuryRoll,
      tableVersion: injury.tableVersion,
      recoveryFormula: injury.recoveryFormula,
      recoveryDays: injury.remainingDays,
      detailTotal: null,
      recoveryStartTs: injury.createdAt,
      recoveryDueTs: injury.recoveryDueTs,
      requestedBy: player.id,
      resolvedBy: gmA.id,
      resolvedAt: injury.createdAt,
    },
    { applicationLeaseId: leaseId },
  );
  await workflow.completeCriticalInjuryWorkflow(injury.pendingId, {
    result: structuredClone(injury),
    effectId,
    completedAt: injury.createdAt,
    applicationLeaseId: leaseId,
  });
}

function restRequest(
  socket,
  { actorId, restId, restMessageId, targetUserId, sender },
) {
  return {
    type: socket.CRITICAL_INJURY_EVENTS.REST_COMPLETED,
    actorId,
    restId,
    restMessageId,
    targetUserId,
    originUserId: sender.id,
    longRest: true,
  };
}

function createRestMessage({ id, actorId, author }) {
  return {
    id,
    user: author.id,
    author,
    speaker: { actor: actorId, alias: "Aric" },
    flags: { dnd5e: { rest: { type: "long" } } },
    getFlag(moduleId, key) {
      return this.flags?.[moduleId]?.[key];
    },
  };
}

function storedRestEvent(restId) {
  return (
    findRestEvent(settings.get("criticalInjuryWorkflow"), restId) ??
    findRestEvent(settings.get("criticalInjuryWorkflowCheckpoint"), restId)
  );
}

function findRestEvent(value, restId, seen = new Set()) {
  if (!value || typeof value !== "object" || seen.has(value)) return null;
  seen.add(value);
  if (String(value.restId ?? "") === restId) return value;
  for (const child of Array.isArray(value) ? value : Object.values(value)) {
    const found = findRestEvent(child, restId, seen);
    if (found) return found;
  }
  return null;
}

function eventOutcomeFor(event, injuryId) {
  const outcome = event?.resolution?.outcomes?.find(
    (entry) => String(entry?.injuryId ?? "") === String(injuryId ?? ""),
  );
  if (!outcome) return null;
  return {
    effectId: outcome.effectId,
    injuryId: outcome.injuryId,
    pendingId: outcome.pendingId,
    saveTotal: outcome.saveTotal,
    passed: outcome.passed,
    infectionHpLossBefore: outcome.infectionHpLossBefore,
    infectionHpLossAfter: outcome.infectionHpLossAfter,
  };
}

function chatExpectation(content) {
  const text = String(content ?? "");
  for (const [injuryName, expected] of chatExpectations) {
    if (text.includes(injuryName)) return expected;
  }
  return null;
}

function applyChanges(target, changes) {
  for (const [path, value] of Object.entries(changes ?? {})) {
    const keys = path.split(".");
    let cursor = target;
    for (const key of keys.slice(0, -1)) {
      cursor[key] ??= {};
      cursor = cursor[key];
    }
    cursor[keys.at(-1)] = structuredClone(value);
  }
}

function totalEffectUpdates() {
  return [...effectsById.values()].reduce(
    (total, effect) => total + effect.updateCount,
    0,
  );
}

function effectPenaltyValues(effect) {
  return (effect.changes ?? [])
    .filter((change) => change.key === "system.attributes.hp.bonuses.overall")
    .map((change) => change.value);
}

function infectionsApplied() {
  return [...effectsById.values()].every(
    (effect) =>
      Number(
        effect.getFlag(MODULE_ID, "criticalInjury")?.infectionHpLoss ?? 0,
      ) === 1,
  );
}

function mutationSnapshot(effectA, effectB) {
  return {
    saveRollCount,
    chatCount,
    effectAUpdates: effectA.updateCount,
    effectBUpdates: effectB.updateCount,
    effectAInjury: structuredClone(
      effectA.getFlag(MODULE_ID, "criticalInjury"),
    ),
    effectBInjury: structuredClone(
      effectB.getFlag(MODULE_ID, "criticalInjury"),
    ),
  };
}

async function withTimeout(promise, label) {
  return await Promise.race([
    promise,
    new Promise((_, reject) =>
      setTimeout(
        () => reject(new Error(`timed out waiting for ${label}`)),
        3000,
      ),
    ),
  ]);
}

async function waitUntil(predicate, label) {
  const deadline = originalDateNow() + 3000;
  while (!predicate()) {
    if (originalDateNow() >= deadline) {
      throw new Error(`timed out waiting for ${label}`);
    }
    await nextTasks(1);
  }
}

async function nextTasks(count) {
  for (let index = 0; index < count; index += 1) {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}

process.stdout.write("critical injury durable Infection rest passed\n");
