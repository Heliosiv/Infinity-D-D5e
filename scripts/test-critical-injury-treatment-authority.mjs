import assert from "node:assert/strict";

const saved = Object.fromEntries(
  [
    "game",
    "foundry",
    "CONST",
    "Hooks",
    "ChatMessage",
    "JournalEntry",
    "SimpleCalendar",
    "ui",
  ].map((key) => [key, globalThis[key]]),
);

const MODULE_ID = "infinity-dnd5e";
const gmA = { id: "gm-a", isGM: true, role: 4, active: true };
const gmB = { id: "gm-b", isGM: true, role: 4, active: true };
const player = {
  id: "player-1",
  isGM: false,
  role: 1,
  active: true,
  character: "actor-1",
};
const newOwner = {
  id: "player-new-owner",
  isGM: false,
  role: 1,
  active: true,
  character: null,
};
const outsider = {
  id: "player-outsider",
  isGM: false,
  role: 1,
  active: true,
  character: null,
};
const users = [gmA, gmB, player, newOwner, outsider];
users.contents = users;
users.activeGM = gmA;
users.get = (id) => users.find((user) => user.id === id) ?? null;

const actors = [];
actors.contents = actors;
actors.get = (id) => actors.find((actor) => actor.id === id) ?? null;

const settingValues = new Map([
  ["criticalInjuriesEnabled", true],
  ["criticalInjuryWorkflow", { version: 1, records: [] }],
  ["criticalInjuryWorkflowCheckpoint", {}],
]);
const emittedFrames = [];
const calendarNotes = [];
let randomCounter = 0;
let chatCount = 0;
let calendarAddCount = 0;
let calendarRemoveCount = 0;
let promptCount = 0;
let skillRollCount = 0;
let handoffArmed = false;
let handoffTriggered = false;
let signalHandoff;
const handoffObserved = new Promise((resolve) => (signalHandoff = resolve));
let blockedPrompt = null;
const originalConsoleError = console.error;
const originalConsoleWarn = console.warn;
let expectedTreatmentFailures = 0;

try {
  console.error = (...args) => {
    if (String(args[0] ?? "").includes("critical injury treatment failed")) {
      expectedTreatmentFailures += 1;
      return;
    }
    originalConsoleError(...args);
  };
  console.warn = (...args) => {
    const message = String(args[0] ?? "");
    if (
      message.includes("could not schedule critical injury") ||
      message.includes("critical injury workflow")
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
      randomID: () => `t${String(++randomCounter).padStart(23, "0")}`,
    },
    applications: {
      api: {
        DialogV2: {
          async prompt() {
            promptCount += 1;
            if (blockedPrompt) {
              const pending = blockedPrompt;
              blockedPrompt = null;
              pending.startedResolve();
              return await pending.result;
            }
            return "actor-1";
          },
        },
      },
    },
  };
  delete globalThis.JournalEntry;
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
  globalThis.SimpleCalendar = {
    api: {
      NoteRepeat: { Never: "never" },
      timestamp: () => 1_000_000,
      timestampPlusInterval: (timestamp, interval) =>
        Number(timestamp) + Number(interval?.day ?? 0) * 86_400,
      timestampToDate: (timestamp) => ({
        year: 1500,
        month: 1,
        day: Math.floor(Number(timestamp) / 86_400) + 1,
        hour: 0,
        minute: 0,
        seconds: 0,
      }),
      formatTimestamp: (timestamp) => `SC ${timestamp}`,
      async getNotes() {
        return calendarNotes;
      },
      async addNote(_title, content) {
        calendarAddCount += 1;
        const note = {
          id: `note-${calendarAddCount}`,
          content,
        };
        calendarNotes.push(note);
        if (calendarAddCount === 1) {
          throw new Error("simulated apply-then-throw calendar write");
        }
        return note;
      },
      async removeNote(id) {
        calendarRemoveCount += 1;
        const index = calendarNotes.findIndex((note) => note.id === id);
        if (index >= 0) calendarNotes.splice(index, 1);
        return true;
      },
    },
  };

  globalThis.game = {
    ready: false,
    user: gmA,
    users,
    actors,
    modules: new Map([
      ["foundryvtt-simple-calendar", { active: true }],
      ["midi-qol", { active: true }],
    ]),
    time: { worldTime: 1_000_000, serverTime: 10_000 },
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
        return settingValues.get(key);
      },
      async set(moduleId, key, value) {
        assert.equal(moduleId, MODULE_ID);
        settingValues.set(key, structuredClone(value));
        const treatment = findTreatment(value, "treatment-handoff");
        if (
          handoffArmed &&
          !handoffTriggered &&
          treatment?.state === "resolving" &&
          treatment?.resolution
        ) {
          handoffTriggered = true;
          users.activeGM = gmB;
          signalHandoff();
          throw new Error("simulated authority handoff after resolution write");
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
  let treatmentRequestDispatchCount = 0;
  socket.subscribeCriticalInjury(
    socket.CRITICAL_INJURY_EVENTS.TREATMENT_REQUEST,
    () => (treatmentRequestDispatchCount += 1),
  );

  const kit = createKit("kit-1", 5, { applyThenThrow: true });
  const actor = createActor("actor-1", player.id, [kit]);
  actor.rollSkill = async (skillId, options) => {
    assert.equal(skillId, "med");
    assert.equal(options?.fastForward, true);
    assert.equal(
      options?.chatMessage,
      false,
      "the persisted treatment check does not create a pre-receipt chat roll",
    );
    skillRollCount += 1;
    return { total: 18 };
  };
  actors.push(actor);

  const primaryInjury = createInjury({
    id: "injury-primary",
    pendingId: "pending-primary",
    injuryKey: "crippling-injury",
    injuryName: "Crippling Injury",
    injuryRoll: 7,
    kitCharges: 2,
    treatmentDc: 12,
    treatmentSkill: "med",
  });
  const primaryEffect = createEffect(
    "effect-primary",
    actor,
    effects.buildCriticalInjuryEffectData(primaryInjury, {
      startTime: 1_000_000,
      dueTimestamp: primaryInjury.recoveryDueTs,
    }),
    { applyThenThrowCount: 2 },
  );
  actor.effects.contents.push(primaryEffect);
  await seedCompletedInjuryWorkflow(workflow, primaryInjury, primaryEffect.id);

  const duplicateInjury = createInjury({
    id: "injury-duplicate",
    pendingId: "pending-duplicate",
    injuryKey: "concussion",
    injuryName: "Concussion",
    injuryRoll: 12,
    kitCharges: 1,
  });
  const duplicateEffect = createEffect(
    "effect-duplicate",
    actor,
    effects.buildCriticalInjuryEffectData(duplicateInjury, {
      startTime: 1_000_000,
      dueTimestamp: duplicateInjury.recoveryDueTs,
    }),
  );
  actor.effects.contents.push(duplicateEffect);
  await seedCompletedInjuryWorkflow(
    workflow,
    duplicateInjury,
    duplicateEffect.id,
  );

  const ownerHandoffInjury = createInjury({
    id: "injury-owner-handoff",
    pendingId: "pending-owner-handoff",
    injuryKey: "concussion",
    injuryName: "Concussion",
    injuryRoll: 12,
    kitCharges: 1,
  });
  const ownerHandoffEffect = createEffect(
    "effect-owner-handoff",
    actor,
    effects.buildCriticalInjuryEffectData(ownerHandoffInjury, {
      startTime: 1_000_000,
      dueTimestamp: ownerHandoffInjury.recoveryDueTs,
    }),
  );
  actor.effects.contents.push(ownerHandoffEffect);
  await seedCompletedInjuryWorkflow(
    workflow,
    ownerHandoffInjury,
    ownerHandoffEffect.id,
  );

  const atomicRaceInjury = createInjury({
    id: "injury-atomic-race",
    pendingId: "pending-atomic-race",
    injuryKey: "concussion",
    injuryName: "Concussion",
    injuryRoll: 12,
    kitCharges: 1,
  });
  const atomicRaceEffect = createEffect(
    "effect-atomic-race",
    actor,
    effects.buildCriticalInjuryEffectData(atomicRaceInjury, {
      startTime: 1_000_000,
      dueTimestamp: atomicRaceInjury.recoveryDueTs,
    }),
  );
  actor.effects.contents.push(atomicRaceEffect);
  await seedCompletedInjuryWorkflow(
    workflow,
    atomicRaceInjury,
    atomicRaceEffect.id,
  );

  service.registerCriticalInjuryService();
  await nextTasks(5);

  // A second delivery while the first GM prompt is unresolved gets an exact,
  // targeted busy response. It cannot open another prompt or spend inventory.
  const promptGate = deferred();
  blockedPrompt = promptGate;
  const duplicateRequest = treatmentRequest(socket, {
    actorId: actor.id,
    injuryId: duplicateInjury.id,
    treatmentId: "treatment-duplicate",
    targetUserId: gmA.id,
    sender: player,
  });
  assert.deepEqual(socket.validateCriticalInjuryPayload(duplicateRequest), {
    ok: true,
    reason: null,
  });
  socket.receiveCriticalInjuryPayload(duplicateRequest, player.id);
  await nextTasks(1);
  assert.equal(treatmentRequestDispatchCount, 1);
  await withTimeout(promptGate.started, "first treatment prompt");
  const duplicateBusy = waitForTreatmentResult(
    socket,
    "treatment-duplicate",
    player.id,
  );
  socket.receiveCriticalInjuryPayload(duplicateRequest, player.id);
  const busyPayload = await duplicateBusy;
  assert.equal(busyPayload.success, false);
  assert.equal(busyPayload.retryable, true);
  assert.match(busyPayload.message, /already|progress|being handled/i);
  assert.equal(busyPayload.targetUserId, player.id);
  assert.equal(
    promptCount,
    1,
    "a duplicate request cannot open a second prompt",
  );
  assert.equal(kit.updateCount, 0);
  promptGate.resolve(null);
  await nextTasks(5);

  const promptsBeforeMain = promptCount;
  const rollsBeforeMain = skillRollCount;
  handoffArmed = true;
  socket.receiveCriticalInjuryPayload(
    treatmentRequest(socket, {
      actorId: actor.id,
      injuryId: primaryInjury.id,
      treatmentId: "treatment-handoff",
      targetUserId: gmA.id,
      sender: player,
    }),
    player.id,
  );
  await withTimeout(handoffObserved, "durable treatment resolution handoff");
  await nextTasks(5);
  assert.equal(
    promptCount - promptsBeforeMain,
    1,
    "the first authority selects the healer once",
  );
  assert.equal(
    skillRollCount - rollsBeforeMain,
    1,
    "the treatment check is rolled once before handoff",
  );

  // The replacement active GM resumes the same durable treatment. External
  // writes deliberately apply and then throw; bounded retries must adopt the
  // canonical item, effect, and calendar state instead of repeating them.
  globalThis.game.user = gmB;
  let completedPayload = null;
  for (let attempt = 0; attempt < 5 && !completedPayload; attempt += 1) {
    const resultPromise = waitForTreatmentResult(
      socket,
      "treatment-handoff",
      player.id,
    );
    socket.receiveCriticalInjuryPayload(
      treatmentRequest(socket, {
        actorId: actor.id,
        injuryId: primaryInjury.id,
        treatmentId: "treatment-handoff",
        targetUserId: gmB.id,
        sender: player,
      }),
      player.id,
    );
    const payload = await resultPromise;
    if (payload.success) completedPayload = payload;
    else assert.equal(payload.retryable, true);
    await nextTasks(3);
  }
  assert.ok(completedPayload, "the replacement GM completes the stored plan");
  assert.equal(completedPayload.targetUserId, player.id);
  assert.equal(completedPayload.treatmentId, "treatment-handoff");
  assert.equal(completedPayload.consumed, 2);
  assert.equal(completedPayload.rollTotal, 18);
  assert.equal(completedPayload.dc, 12);
  assert.equal(promptCount - promptsBeforeMain, 1);
  assert.equal(skillRollCount - rollsBeforeMain, 1);
  assert.equal(kit.system.uses.value, 3);
  assert.equal(
    kit.updateCount,
    1,
    "an ambiguous Item success is adopted without double consumption",
  );
  assert.equal(calendarAddCount, 1);
  assert.equal(calendarNotes.length, 1);
  assert.equal(calendarRemoveCount, 0);
  const appliedInjury = effects.getCriticalInjuryData(primaryEffect);
  assert.equal(appliedInjury.stabilized, true);
  assert.equal(appliedInjury.calendarEntryId, calendarNotes[0].id);
  await waitUntil(() => chatCount === 1, "single treatment chat receipt");

  const beforeReplay = mutationSnapshot({
    kit,
    primaryEffect,
    promptCount,
    skillRollCount,
    calendarAddCount,
    calendarRemoveCount,
    chatCount,
  });
  const replayPromise = waitForTreatmentResult(
    socket,
    "treatment-handoff",
    player.id,
  );
  socket.receiveCriticalInjuryPayload(
    treatmentRequest(socket, {
      actorId: actor.id,
      injuryId: primaryInjury.id,
      treatmentId: "treatment-handoff",
      targetUserId: gmB.id,
      sender: player,
    }),
    player.id,
  );
  const replayPayload = await replayPromise;
  assert.equal(replayPayload.success, true);
  assert.deepEqual(
    treatmentResultProjection(replayPayload),
    treatmentResultProjection(completedPayload),
    "completed replay returns the exact durable treatment receipt",
  );
  await nextTasks(4);
  assert.deepEqual(
    mutationSnapshot({
      kit,
      primaryEffect,
      promptCount,
      skillRollCount,
      calendarAddCount,
      calendarRemoveCount,
      chatCount,
    }),
    beforeReplay,
    "completed replay does not mutate inventory, effect, calendar, or chat",
  );

  // Ownership can legitimately change while a treatment attempt remains
  // unresolved. The newly authorized owner receives the exact durable ID,
  // then resumes that attempt even though its original requestedBy differs.
  actor.ownership[newOwner.id] = 3;
  const originalOwnerTreatmentId = "treatment-original-owner";
  await workflow.createCriticalInjuryTreatmentRequest({
    actorId: actor.id,
    injuryId: ownerHandoffInjury.id,
    treatmentId: originalOwnerTreatmentId,
    requestedBy: player.id,
  });
  const ownerResumeBaseline = {
    promptCount,
    skillRollCount,
    kitUpdates: kit.updateCount,
    effectUpdates: ownerHandoffEffect.updateCount,
    calendarAddCount,
    chatCount,
  };
  const ownerRedirectPromise = waitForTreatmentResult(
    socket,
    "treatment-new-owner-client-id",
    newOwner.id,
  );
  socket.receiveCriticalInjuryPayload(
    treatmentRequest(socket, {
      actorId: actor.id,
      injuryId: ownerHandoffInjury.id,
      treatmentId: "treatment-new-owner-client-id",
      targetUserId: gmB.id,
      sender: newOwner,
    }),
    newOwner.id,
  );
  const ownerRedirect = await ownerRedirectPromise;
  assert.equal(ownerRedirect.success, false);
  assert.equal(ownerRedirect.retryable, true);
  assert.equal(ownerRedirect.resumeTreatmentId, originalOwnerTreatmentId);
  assert.equal(ownerRedirect.targetUserId, newOwner.id);
  assert.deepEqual(
    {
      promptCount,
      skillRollCount,
      kitUpdates: kit.updateCount,
      effectUpdates: ownerHandoffEffect.updateCount,
      calendarAddCount,
      chatCount,
    },
    ownerResumeBaseline,
    "redirecting an authorized owner to the existing receipt has no side effects",
  );

  const ownerResumeFrameStart = emittedFrames.length;
  const ownerCompletionPromise = waitForTreatmentResult(
    socket,
    originalOwnerTreatmentId,
    newOwner.id,
  );
  socket.receiveCriticalInjuryPayload(
    treatmentRequest(socket, {
      actorId: actor.id,
      injuryId: ownerHandoffInjury.id,
      treatmentId: originalOwnerTreatmentId,
      targetUserId: gmB.id,
      sender: newOwner,
    }),
    newOwner.id,
  );
  const ownerCompletion = await ownerCompletionPromise;
  assert.equal(ownerCompletion.success, true);
  assert.equal(ownerCompletion.treatmentId, originalOwnerTreatmentId);
  assert.equal(ownerCompletion.targetUserId, newOwner.id);
  assert.equal(
    workflow.getCriticalInjuryTreatmentRecord(
      ownerHandoffInjury.pendingId,
      originalOwnerTreatmentId,
    ).requestedBy,
    player.id,
    "requester handoff preserves the original durable audit identity",
  );
  const ownerResultFrames = emittedFrames
    .slice(ownerResumeFrameStart)
    .filter(
      (frame) =>
        frame.payload.type === socket.CRITICAL_INJURY_EVENTS.TREATMENT_RESULT &&
        frame.payload.treatmentId === originalOwnerTreatmentId,
    );
  assert.deepEqual(
    ownerResultFrames.map((frame) => frame.payload.targetUserId),
    [newOwner.id],
    "the resumed result is sent only to the current authenticated requester",
  );

  // Inject a sibling treatment after the service reads its stale parent but
  // before its atomic create reaches the store. Create must return that sibling
  // as the resume target without progressing into lease, prompt, or mutation.
  const racedSiblingId = "treatment-raced-sibling";
  const racedClientId = "treatment-raced-client";
  let racedSiblingCreation = null;
  const originalAtomicGetFlag = atomicRaceEffect.getFlag.bind(atomicRaceEffect);
  let injectRacedSibling = true;
  atomicRaceEffect.getFlag = function getFlag(moduleId, key) {
    if (injectRacedSibling) {
      injectRacedSibling = false;
      racedSiblingCreation = workflow.createCriticalInjuryTreatmentRequest({
        actorId: actor.id,
        injuryId: atomicRaceInjury.id,
        treatmentId: racedSiblingId,
        requestedBy: player.id,
      });
    }
    return originalAtomicGetFlag(moduleId, key);
  };
  const atomicBaseline = {
    promptCount,
    skillRollCount,
    kitUpdates: kit.updateCount,
    effectUpdates: atomicRaceEffect.updateCount,
    calendarAddCount,
    calendarRemoveCount,
    chatCount,
  };
  const racedResultPromise = waitForTreatmentResult(
    socket,
    racedClientId,
    player.id,
  );
  socket.receiveCriticalInjuryPayload(
    treatmentRequest(socket, {
      actorId: actor.id,
      injuryId: atomicRaceInjury.id,
      treatmentId: racedClientId,
      targetUserId: gmB.id,
      sender: player,
    }),
    player.id,
  );
  const racedResult = await racedResultPromise;
  await racedSiblingCreation;
  assert.equal(racedResult.success, false);
  assert.equal(racedResult.retryable, true);
  assert.equal(racedResult.resumeTreatmentId, racedSiblingId);
  assert.equal(racedResult.targetUserId, player.id);
  assert.deepEqual(
    {
      promptCount,
      skillRollCount,
      kitUpdates: kit.updateCount,
      effectUpdates: atomicRaceEffect.updateCount,
      calendarAddCount,
      calendarRemoveCount,
      chatCount,
    },
    atomicBaseline,
    "an atomically discovered sibling stops before any treatment side effect",
  );
  assert.equal(
    workflow.getCriticalInjuryTreatmentRecord(
      atomicRaceInjury.pendingId,
      racedClientId,
    ),
    null,
    "atomic create does not persist a competing client attempt",
  );
  assert.equal(
    workflow.getCriticalInjuryTreatmentRecord(
      atomicRaceInjury.pendingId,
      racedSiblingId,
    )?.state,
    "requested",
  );

  // Rejections are correlated and routed only to the authenticated requester.
  const rejectionFrameStart = emittedFrames.length;
  const rejectedPromise = waitForTreatmentResult(
    socket,
    "treatment-unauthorized",
    outsider.id,
  );
  socket.receiveCriticalInjuryPayload(
    treatmentRequest(socket, {
      actorId: actor.id,
      injuryId: duplicateInjury.id,
      treatmentId: "treatment-unauthorized",
      targetUserId: gmB.id,
      sender: outsider,
    }),
    outsider.id,
  );
  const rejectedPayload = await rejectedPromise;
  assert.equal(rejectedPayload.success, false);
  assert.equal(rejectedPayload.targetUserId, outsider.id);
  assert.equal(rejectedPayload.treatmentId, "treatment-unauthorized");
  const rejectionFrames = emittedFrames
    .slice(rejectionFrameStart)
    .filter(
      (frame) =>
        frame.payload.type === socket.CRITICAL_INJURY_EVENTS.TREATMENT_RESULT &&
        frame.payload.treatmentId === "treatment-unauthorized",
    );
  assert.equal(rejectionFrames.length, 1);
  assert.deepEqual(rejectionFrames[0].options?.recipients, [outsider.id]);

  const missingPromise = waitForTreatmentResult(
    socket,
    "treatment-missing-injury",
    player.id,
  );
  socket.receiveCriticalInjuryPayload(
    treatmentRequest(socket, {
      actorId: actor.id,
      injuryId: "injury-does-not-exist",
      treatmentId: "treatment-missing-injury",
      targetUserId: gmB.id,
      sender: player,
    }),
    player.id,
  );
  const missingPayload = await missingPromise;
  assert.equal(missingPayload.success, false);
  assert.equal(missingPayload.targetUserId, player.id);
  assert.equal(missingPayload.treatmentId, "treatment-missing-injury");

  assert.ok(
    expectedTreatmentFailures >= 1,
    "the simulated handoff or ambiguous effect writes exercise recovery",
  );
} finally {
  console.error = originalConsoleError;
  console.warn = originalConsoleWarn;
  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) delete globalThis[key];
    else globalThis[key] = value;
  }
}

function createActor(id, ownerId, items) {
  const effects = [];
  effects.contents = effects;
  effects.get = (effectId) =>
    effects.find((effect) => effect.id === effectId) ?? null;
  return {
    id,
    uuid: `Actor.${id}`,
    name: "Aric",
    type: "character",
    ownership: { default: 0, [ownerId]: 3 },
    system: { attributes: { hp: { value: 8 }, exhaustion: 0 } },
    items: { contents: items },
    effects,
    flags: { [MODULE_ID]: {} },
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
}

function createKit(id, available, { applyThenThrow = false } = {}) {
  return {
    id,
    name: "Healer's Kit",
    system: {
      identifier: "healers-kit",
      uses: { value: available, max: 10 },
      quantity: 1,
    },
    updateCount: 0,
    async update(changes) {
      this.updateCount += 1;
      applyChanges(this, changes);
      if (applyThenThrow && this.updateCount === 1) {
        throw new Error("simulated apply-then-throw Item update");
      }
      return this;
    },
  };
}

function createEffect(id, actor, data, { applyThenThrowCount = 0 } = {}) {
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
      this.updateCount += 1;
      applyChanges(this, changes);
      if (this.updateCount <= applyThenThrowCount) {
        throw new Error("simulated apply-then-throw ActiveEffect update");
      }
      return this;
    },
  };
}

function createInjury({
  id,
  pendingId,
  injuryKey,
  injuryName,
  injuryRoll,
  kitCharges,
  treatmentDc = 0,
  treatmentSkill = "",
}) {
  return {
    id,
    pendingId,
    actorId: "actor-1",
    injuryKey,
    injuryName,
    injuryRoll,
    tableVersion: 2,
    effect: `${injuryName} penalties`,
    recoveryRule: "Rules-based recovery",
    recoveryFormula: "1d4",
    remainingDays: 4,
    permanent: false,
    stabilized: false,
    kitCharges,
    treatmentDc,
    treatmentSkill,
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

async function seedCompletedInjuryWorkflow(workflow, injury, effectId) {
  await workflow.createCriticalInjuryApproval({
    pendingId: injury.pendingId,
    actorId: injury.actorId,
    targetUserId: player.id,
    approvedAt: injury.createdAt,
  });
  const leaseId = `lease-${injury.pendingId}`;
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

function treatmentRequest(
  socket,
  { actorId, injuryId, treatmentId, targetUserId, sender },
) {
  return {
    type: socket.CRITICAL_INJURY_EVENTS.TREATMENT_REQUEST,
    actorId,
    injuryId,
    treatmentId,
    targetUserId,
    originUserId: sender.id,
  };
}

function waitForTreatmentResult(socket, treatmentId, targetUserId) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`timed out waiting for ${treatmentId}`)),
      3000,
    );
    const unsubscribe = socket.subscribeCriticalInjury(
      socket.CRITICAL_INJURY_EVENTS.TREATMENT_RESULT,
      (payload) => {
        if (payload.treatmentId !== treatmentId) return;
        if (payload.targetUserId !== targetUserId) return;
        clearTimeout(timer);
        unsubscribe();
        resolve(payload);
      },
    );
  });
}

function deferred() {
  let resolve;
  let startedResolve;
  const result = new Promise((done) => (resolve = done));
  const started = new Promise((done) => (startedResolve = done));
  return { result, resolve, started, startedResolve };
}

function findTreatment(value, treatmentId, seen = new Set()) {
  if (!value || typeof value !== "object" || seen.has(value)) return null;
  seen.add(value);
  if (
    String(value.treatmentId ?? value.requestId ?? "") === treatmentId &&
    typeof value.state === "string"
  ) {
    return value;
  }
  for (const child of Array.isArray(value) ? value : Object.values(value)) {
    const found = findTreatment(child, treatmentId, seen);
    if (found) return found;
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

function mutationSnapshot({
  kit,
  primaryEffect,
  promptCount,
  skillRollCount,
  calendarAddCount,
  calendarRemoveCount,
  chatCount,
}) {
  return {
    available: kit.system.uses.value,
    kitUpdates: kit.updateCount,
    effectUpdates: primaryEffect.updateCount,
    promptCount,
    skillRollCount,
    calendarAddCount,
    calendarRemoveCount,
    calendarNotes: structuredClone(calendarNotes),
    chatCount,
  };
}

function treatmentResultProjection(payload) {
  return {
    actorId: payload.actorId,
    injuryId: payload.injuryId,
    treatmentId: payload.treatmentId,
    success: payload.success,
    message: payload.message,
    retryable: payload.retryable,
    rollTotal: payload.rollTotal,
    dc: payload.dc,
    consumed: payload.consumed,
    result: payload.result,
  };
}

async function waitUntil(predicate, label) {
  const deadline = Date.now() + 3000;
  while (!predicate()) {
    if (Date.now() >= deadline)
      throw new Error(`timed out waiting for ${label}`);
    await nextTasks(1);
  }
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

async function nextTasks(count) {
  for (let index = 0; index < count; index += 1) {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}

process.stdout.write("critical injury durable treatment authority passed\n");
