import assert from "node:assert/strict";

const saved = Object.fromEntries(
  ["game", "foundry"].map((key) => [key, globalThis[key]]),
);

function makeBus() {
  const handlers = new Map();
  return {
    subscribe(event, handler) {
      if (!handlers.has(event)) handlers.set(event, new Set());
      handlers.get(event).add(handler);
      return () => handlers.get(event)?.delete(handler);
    },
    emit(event, payload) {
      for (const handler of handlers.get(event) ?? []) handler(payload);
    },
  };
}

function projection(overrides = {}) {
  return {
    status: "collecting",
    hasActiveBlock: true,
    noGm: false,
    blockId: "block-1",
    settlementName: "Greyhaven",
    actors: [{ id: "actor-1", name: "Ada", eligible: true }],
    heat: 2,
    budgetHours: 8,
    usedHours: 0,
    remainingHours: 8,
    activities: [
      {
        id: "market-trading",
        label: "Market Trading",
        category: "commerce",
        icon: "fa-solid fa-scale-balanced",
        available: true,
        hourOptions: [2, 4, 6, 8],
        skills: [
          { id: "persuasion", label: "Persuasion" },
          { id: "deception", label: "Deception" },
        ],
        targets: [
          {
            id: "market-square",
            label: "Guildhall exchange",
          },
        ],
        stakeAllowed: true,
        maxStakeGp: 25,
        stakeStepGp: 0.01,
        stakeValueGp: 0,
        hiddenDc: 17,
        hiddenRoll: 20,
      },
      {
        id: "lay-low",
        label: "Lay Low",
        category: "crime",
        icon: "fa-solid fa-user-secret",
        available: true,
        fixedHours: 4,
      },
      {
        id: "fence-stolen-goods",
        label: "Fence Stolen Goods",
        category: "crime",
        icon: "fa-solid fa-sack-dollar",
        available: true,
        hourOptions: [2, 4, 6, 8],
        skills: [
          { id: "persuasion", label: "Persuasion" },
          { id: "deception", label: "Deception" },
        ],
        targets: [
          { id: "stolen-a", label: "Silver brooch" },
          { id: "stolen-b", label: "Ivory comb" },
        ],
        multiTarget: true,
      },
    ],
    queue: [],
    rawQueue: [],
    submitted: false,
    canSubmit: true,
    canRecall: false,
    hiddenDc: 99,
    rolls: [{ total: 20 }],
    reward: "secret purse",
    ...overrides,
  };
}

try {
  globalThis.foundry = {
    utils: { deepClone: (value) => structuredClone(value) },
  };
  globalThis.game = { user: { id: "player-1" } };
  const { DOWNTIME_EVENTS } = await import("./downtime/socket.js");
  const {
    createDowntimePlayerAdapter,
    sanitizeDowntimeSubmissionQueue,
    sanitizePlayerDowntimeSnapshot,
  } = await import("./downtime/ui-adapter.js");

  const sanitized = sanitizePlayerDowntimeSnapshot(projection());
  assert.equal(JSON.stringify(sanitized).includes("hiddenDc"), false);
  assert.equal(JSON.stringify(sanitized).includes("hiddenRoll"), false);
  assert.equal(JSON.stringify(sanitized).includes("secret purse"), false);
  assert.equal(
    sanitized.activities.find((activity) => activity.id === "market-trading")
      .stakeValueGp,
    0.01,
    "an available market trade always starts with a valid positive stake",
  );
  assert.equal(
    sanitized.activities.find(
      (activity) => activity.id === "fence-stolen-goods",
    ).multiTarget,
    true,
  );
  assert.deepEqual(
    sanitizeDowntimeSubmissionQueue([
      {
        id: "a1",
        activityId: "market-trading",
        hours: 4,
        skill: "persuasion",
        stakeCp: 500,
        targetId: "market",
        dc: 1,
        roll: 20,
        reward: 99_999,
      },
    ]),
    [
      {
        id: "a1",
        activityId: "market-trading",
        hours: 4,
        skill: "persuasion",
        targetId: "market",
        stakeCp: 500,
      },
    ],
  );
  assert.equal(
    sanitizeDowntimeSubmissionQueue(
      Array.from({ length: 65 }, (_, index) => ({
        id: `action-${index}`,
        activityId: "lay-low",
        hours: 4,
      })),
    ).length,
    64,
    "the local draft uses the same 64-action maximum as the domain and socket",
  );
  assert.deepEqual(
    sanitizeDowntimeSubmissionQueue([
      {
        id: "fence-1",
        activityId: "fence-stolen-goods",
        hours: 4,
        skill: "deception",
        targetIds: ["stolen-b", "stolen-a", "stolen-b"],
      },
    ])[0].targetIds,
    ["stolen-a", "stolen-b"],
    "a local fencing draft keeps a canonical arbitrary item bundle",
  );

  const strictTimerBus = makeBus();
  let strictTimerThis = null;
  let strictClearTimerThis = null;
  let strictTimerRequest = null;
  const strictTimerAdapter = createDowntimePlayerAdapter({
    subscribeSocket: strictTimerBus.subscribe,
    registerSocket: () => true,
    requestIdFactory: () => "strict-timer-request",
    requestSnapshot: (actorId, { requestId }) => {
      strictTimerRequest = { actorId, requestId };
      return { ok: true, requestId };
    },
    isAuthority: () => false,
    getCurrentUserId: () => "player-1",
    setTimeout: function () {
      strictTimerThis = this;
      return 41;
    },
    clearTimeout: function (timer) {
      strictClearTimerThis = this;
      assert.equal(timer, 41);
    },
  });
  const strictTimerProjection = strictTimerAdapter.getPlayerProjection({
    actorId: "actor-1",
  });
  strictTimerBus.emit(DOWNTIME_EVENTS.SNAPSHOT_REPLY, {
    requestId: strictTimerRequest.requestId,
    projection: projection(),
  });
  await strictTimerProjection;
  assert.equal(
    strictTimerThis,
    globalThis,
    "browser timers are invoked with the global receiver",
  );
  assert.equal(strictClearTimerThis, globalThis);
  strictTimerAdapter.destroy();

  const bus = makeBus();
  let requestCounter = 0;
  let snapshotRequest = null;
  let submittedPayload = null;
  let recalledPayload = null;
  let autoOpened = null;
  let adapterNotifications = 0;
  const adapter = createDowntimePlayerAdapter({
    subscribeSocket: bus.subscribe,
    registerSocket: () => true,
    requestIdFactory: (prefix) => `${prefix}-${++requestCounter}`,
    requestSnapshot: (actorId, { requestId }) => {
      snapshotRequest = { actorId, requestId };
      return { ok: true, requestId };
    },
    submitTransport: (payload) => {
      submittedPayload = structuredClone(payload);
      return { ok: true, requestId: payload.requestId };
    },
    recallTransport: (payload) => {
      recalledPayload = structuredClone(payload);
      return { ok: true, requestId: payload.requestId };
    },
    isAuthority: () => false,
    getCurrentUserId: () => "player-1",
    cacheMaxAgeMs: 60_000,
    requestTimeoutMs: 500,
    onAutoOpen: (payload) => {
      autoOpened = payload;
    },
  });
  adapter.subscribe(() => {
    adapterNotifications += 1;
  });

  const initialPromise = adapter.getPlayerProjection({ actorId: "actor-1" });
  assert.deepEqual(snapshotRequest, {
    actorId: "actor-1",
    requestId: "snapshot-1",
  });
  bus.emit(DOWNTIME_EVENTS.SNAPSHOT_REPLY, {
    requestId: snapshotRequest.requestId,
    projection: projection(),
  });
  const initial = await initialPromise;
  assert.equal(initial.blockId, "block-1");
  assert.equal(initial.queue.length, 0);
  assert.equal(
    initial.canSubmit,
    true,
    "a player may explicitly submit with every assigned hour unused",
  );

  const market = await adapter.queueActivity({
    actorId: "actor-1",
    activityId: "market-trading",
    hours: 4,
    skill: "persuasion",
    stakeGp: 12.34,
    targetId: "market-square",
    dc: 1,
    reward: 999_999,
  });
  const layLow = await adapter.queueActivity({
    actorId: "actor-1",
    activityId: "lay-low",
    hours: 4,
  });
  let local = await adapter.getPlayerProjection({ actorId: "actor-1" });
  assert.deepEqual(
    local.rawQueue.map((entry) => entry.activityId),
    ["market-trading", "lay-low"],
  );
  assert.equal(local.usedHours, 8);
  assert.equal(local.remainingHours, 0);
  assert.equal(local.canSubmit, true);
  assert.equal(
    local.queue[0].detail,
    "Persuasion · 12.34 gp stake · Guildhall exchange",
  );
  assert.doesNotMatch(
    local.queue[0].detail,
    /market-square/,
    "queue summaries should show player-safe labels instead of opaque target IDs",
  );

  await adapter.reorderActivity({
    actorId: "actor-1",
    queueEntryId: layLow.id,
    direction: "up",
  });
  local = await adapter.getPlayerProjection({ actorId: "actor-1" });
  assert.deepEqual(
    local.rawQueue.map((entry) => entry.id),
    [layLow.id, market.id],
  );

  const submitPromise = adapter.submitQueue({ actorId: "actor-1" });
  await Promise.resolve();
  assert.equal(submittedPayload.blockId, "block-1");
  assert.deepEqual(
    submittedPayload.queue.map((entry) => entry.activityId),
    ["lay-low", "market-trading"],
  );
  assert.deepEqual(submittedPayload.queue[1], {
    id: market.id,
    activityId: "market-trading",
    hours: 4,
    skill: "persuasion",
    targetId: "market-square",
    stakeCp: 1_234,
  });
  assert.equal(JSON.stringify(submittedPayload).includes("reward"), false);
  bus.emit(DOWNTIME_EVENTS.SUBMIT_RESULT, {
    requestId: submittedPayload.requestId,
    ok: true,
    projection: projection({
      rawQueue: submittedPayload.queue,
      queue: submittedPayload.queue,
      submitted: true,
      canSubmit: false,
      canRecall: true,
      usedHours: 8,
      remainingHours: 0,
    }),
  });
  const submitted = await submitPromise;
  assert.equal(submitted.submitted, true);

  const recallPromise = adapter.recallSubmission({ actorId: "actor-1" });
  await Promise.resolve();
  assert.equal(recalledPayload.blockId, "block-1");
  bus.emit(DOWNTIME_EVENTS.SUBMIT_RESULT, {
    requestId: recalledPayload.requestId,
    ok: true,
    projection: projection({
      rawQueue: submittedPayload.queue,
      queue: submittedPayload.queue,
      submitted: false,
    }),
  });
  const recalled = await recallPromise;
  assert.equal(recalled.submitted, false);

  await adapter.queueActivity({
    actorId: "actor-1",
    activityId: "lay-low",
    hours: 4,
  });
  bus.emit(DOWNTIME_EVENTS.STATE_UPDATE, {
    projection: projection({
      rawQueue: submittedPayload.queue,
      queue: submittedPayload.queue,
      hiddenTable: [{ result: "secret" }],
    }),
  });
  local = await adapter.getPlayerProjection({ actorId: "actor-1" });
  assert.equal(
    local.rawQueue.length,
    3,
    "a routine state update does not overwrite an unsent local draft",
  );
  assert.equal(JSON.stringify(local).includes("hiddenTable"), false);

  bus.emit(DOWNTIME_EVENTS.STATE_UPDATE, {
    projection: projection({
      status: "locked",
      rawQueue: submittedPayload.queue,
      queue: submittedPayload.queue,
      submitted: false,
      canSubmit: false,
      canRecall: false,
    }),
  });
  local = await adapter.getPlayerProjection({ actorId: "actor-1" });
  assert.deepEqual(
    local.rawQueue.map((entry) => entry.id),
    submittedPayload.queue.map((entry) => entry.id),
    "locking submissions replaces an unsent local draft with the authoritative saved queue",
  );
  assert.equal(local.status, "locked");

  bus.emit(DOWNTIME_EVENTS.AUTO_OPEN, {
    actorId: "actor-1",
    blockId: "block-1",
  });
  assert.equal(autoOpened.actorId, "actor-1");
  assert.equal(autoOpened.blockId, "block-1");
  assert.equal(autoOpened.adapter, adapter);
  assert.ok(adapterNotifications > 0);
  adapter.destroy();

  const guidedBus = makeBus();
  let guidedSubmission = null;
  let guidedRollCalls = 0;
  const guidedProjection = (overrides = {}) =>
    projection({
      mode: "guided",
      hasSettlement: false,
      locationName: "The Lantern District",
      activities: [
        {
          id: "guided-labor",
          label: "Paid Work",
          category: "guided",
          icon: "fa-solid fa-compass",
          available: true,
          fixedHours: 8,
          skills: [{ id: "ath", label: "Athletics" }],
        },
      ],
      ...overrides,
    });
  const guidedAdapter = createDowntimePlayerAdapter({
    subscribeSocket: guidedBus.subscribe,
    registerSocket: () => true,
    requestIdFactory: (prefix) => `guided-${prefix}`,
    requestSnapshot: () => ({ ok: true }),
    submitTransport: (payload) => {
      guidedSubmission = structuredClone(payload);
      return { ok: true, requestId: payload.requestId };
    },
    getActor: () => ({ id: "actor-1" }),
    rollSkill: async (_actor, skill, options) => {
      guidedRollCalls += 1;
      assert.equal(skill, "ath");
      assert.deepEqual(options, { chatMessage: true, fastForward: false });
      return { ok: true, total: 17, roll: { formula: "1d20 + 5" } };
    },
  });
  guidedAdapter._cacheProjection(guidedProjection(), "actor-1");
  await guidedAdapter.queueActivity({
    actorId: "actor-1",
    activityId: "guided-labor",
    hours: 8,
    skill: "ath",
  });
  assert.equal(guidedRollCalls, 0, "choosing an activity does not roll it");
  const guidedSubmitPromise = guidedAdapter.submitQueue({ actorId: "actor-1" });
  for (let tick = 0; tick < 4; tick += 1) await Promise.resolve();
  assert.equal(guidedRollCalls, 1, "the player click creates the check");
  assert.deepEqual(guidedSubmission.queue[0].guidedRoll, {
    total: 17,
    formula: "1d20 + 5",
  });
  guidedBus.emit(DOWNTIME_EVENTS.SUBMIT_RESULT, {
    requestId: guidedSubmission.requestId,
    ok: true,
    projection: guidedProjection({
      rawQueue: guidedSubmission.queue,
      queue: guidedSubmission.queue,
      submitted: true,
      canSubmit: false,
    }),
  });
  assert.equal((await guidedSubmitPromise).submitted, true);
  guidedAdapter.destroy();

  const noGmAdapter = createDowntimePlayerAdapter({
    subscribeSocket: makeBus().subscribe,
    registerSocket: () => true,
    requestIdFactory: () => "no-gm-request",
    requestSnapshot: () => ({ ok: false, reason: "no-gm" }),
    isAuthority: () => false,
  });
  const noGm = await noGmAdapter.getPlayerProjection({ actorId: "actor-1" });
  assert.equal(noGm.noGm, true);
  noGmAdapter.destroy();

  let receiptAuthority = true;
  const receiptAdapter = createDowntimePlayerAdapter({
    subscribeSocket: makeBus().subscribe,
    registerSocket: () => true,
    requestIdFactory: (prefix) => `receipt-${prefix}`,
    requestSnapshot: () => ({ ok: false, reason: "no-gm" }),
    isAuthority: () => receiptAuthority,
    getCurrentUserId: () => "gm-1",
    getDirectProjection: async () => ({
      status: "completed",
      hasActiveBlock: false,
      noGm: false,
      blockId: "",
      actors: [],
      activities: [],
      queue: [],
      rawQueue: [],
      budgetHours: 0,
      usedHours: 0,
      remainingHours: 0,
      receipt: {
        settlementName: "Greyhaven",
        completedAt: 1_000,
        summary: "Ada completed downtime.",
        activities: [
          {
            id: "receipt-trade",
            label: "Market Trading",
            summary: "Returned 11 gp from a 10 gp stake.",
            tone: "success",
          },
        ],
      },
      completionMessage: "Ada completed downtime.",
    }),
  });
  await receiptAdapter.getPlayerProjection({ actorId: "actor-1" });
  receiptAuthority = false;
  const offlineReceipt = await receiptAdapter.getPlayerProjection({
    actorId: "actor-1",
    force: true,
  });
  assert.equal(offlineReceipt.noGm, true);
  assert.equal(offlineReceipt.hasActiveBlock, false);
  assert.equal(offlineReceipt.blockId, "");
  assert.deepEqual(offlineReceipt.activities, []);
  assert.deepEqual(offlineReceipt.rawQueue, []);
  assert.deepEqual(offlineReceipt.queue, []);
  assert.equal(offlineReceipt.canSubmit, false);
  assert.equal(offlineReceipt.receipt.summary, "Ada completed downtime.");
  assert.equal(offlineReceipt.completionMessage, "Ada completed downtime.");
  const otherActorOffline = await receiptAdapter.getPlayerProjection({
    actorId: "actor-2",
    force: true,
  });
  assert.equal(
    otherActorOffline.receipt,
    null,
    "a no-GM projection never borrows another actor's cached receipt",
  );
  receiptAdapter.destroy();

  let emptySubmission = null;
  const emptyQueueAdapter = createDowntimePlayerAdapter({
    subscribeSocket: makeBus().subscribe,
    registerSocket: () => true,
    requestIdFactory: (prefix) => `empty-${prefix}`,
    isAuthority: () => true,
    getCurrentUserId: () => "gm-1",
    getDirectProjection: async () =>
      projection({
        submitted: Boolean(emptySubmission),
        rawQueue: [],
        queue: [],
      }),
    submitDirect: async (payload) => {
      emptySubmission = structuredClone(payload);
    },
  });
  await emptyQueueAdapter.getPlayerProjection({ actorId: "actor-1" });
  const emptyResult = await emptyQueueAdapter.submitQueue({
    actorId: "actor-1",
  });
  assert.deepEqual(emptySubmission.queue, []);
  assert.equal(emptyResult.submitted, true);
  emptyQueueAdapter.destroy();

  const bundleAdapter = createDowntimePlayerAdapter({
    subscribeSocket: makeBus().subscribe,
    registerSocket: () => true,
    requestIdFactory: (prefix) => `bundle-${prefix}`,
    isAuthority: () => true,
    getCurrentUserId: () => "gm-1",
    getDirectProjection: async () =>
      projection({
        activities: projection().activities.filter(
          (activity) => activity.id === "fence-stolen-goods",
        ),
      }),
  });
  await bundleAdapter.getPlayerProjection({ actorId: "actor-1" });
  await assert.rejects(
    bundleAdapter.queueActivity({
      actorId: "actor-1",
      activityId: "fence-stolen-goods",
      hours: 4,
      skill: "deception",
      targetIds: [],
    }),
    /at least one item/i,
  );
  const bundleEntry = await bundleAdapter.queueActivity({
    actorId: "actor-1",
    activityId: "fence-stolen-goods",
    hours: 4,
    skill: "deception",
    targetIds: ["stolen-b", "stolen-a"],
  });
  assert.deepEqual(bundleEntry.targetIds, ["stolen-a", "stolen-b"]);
  const bundleView = await bundleAdapter.getPlayerProjection({
    actorId: "actor-1",
  });
  assert.match(
    bundleView.queue[0].detail,
    /Bundle: Silver brooch \+ Ivory comb/,
  );
  bundleAdapter.destroy();

  let directSubmitted = null;
  let directRecalled = false;
  let directSubmittedState = false;
  const directAdapter = createDowntimePlayerAdapter({
    subscribeSocket: makeBus().subscribe,
    registerSocket: () => true,
    requestIdFactory: (prefix) => `direct-${prefix}`,
    isAuthority: () => true,
    getCurrentUserId: () => "gm-1",
    getDirectProjection: async () =>
      projection({
        rawQueue: directSubmitted?.queue ?? [],
        queue: directSubmitted?.queue ?? [],
        submitted: directSubmittedState,
        canRecall: directSubmittedState,
      }),
    submitDirect: async (payload) => {
      directSubmitted = structuredClone(payload);
      directSubmittedState = true;
    },
    recallDirect: async () => {
      directRecalled = true;
      directSubmittedState = false;
    },
  });
  await directAdapter.getPlayerProjection({ actorId: "actor-1" });
  await directAdapter.queueActivity({
    actorId: "actor-1",
    activityId: "lay-low",
    hours: 4,
  });
  const directResult = await directAdapter.submitQueue({ actorId: "actor-1" });
  assert.equal(directSubmitted.userId, "gm-1");
  assert.equal(directSubmitted.queue[0].activityId, "lay-low");
  assert.equal(directResult.submitted, true);
  await directAdapter.recallSubmission({ actorId: "actor-1" });
  assert.equal(directRecalled, true);
  directAdapter.destroy();

  const heatFiveProjection = projection({
    heat: 5,
    activities: [
      {
        id: "pickpocket",
        label: "Pickpocket",
        category: "crime",
        icon: "fa-solid fa-hand",
        available: false,
        unavailableReason: "Heat is 5. Lay Low before attempting more crime.",
        hourOptions: [2, 4],
        targets: [{ id: "mark-1", label: "Distracted pilgrim" }],
      },
      {
        id: "shoplift",
        label: "Shoplift",
        category: "crime",
        icon: "fa-solid fa-mask-face",
        available: false,
        unavailableReason: "Heat is 5. Lay Low before attempting more crime.",
        hourOptions: [4, 8],
        targets: [],
      },
      {
        id: "lay-low",
        label: "Lay Low",
        category: "recovery",
        icon: "fa-solid fa-user-secret",
        available: true,
        fixedHours: 4,
      },
    ],
  });
  const heatAdapter = createDowntimePlayerAdapter({
    subscribeSocket: makeBus().subscribe,
    registerSocket: () => true,
    requestIdFactory: (prefix) => `heat-${prefix}`,
    isAuthority: () => true,
    getCurrentUserId: () => "gm-1",
    getDirectProjection: async () => heatFiveProjection,
  });
  let heatView = await heatAdapter.getPlayerProjection({ actorId: "actor-1" });
  assert.equal(
    heatView.activities.find((activity) => activity.id === "pickpocket")
      .available,
    false,
  );
  await heatAdapter.queueActivity({
    actorId: "actor-1",
    activityId: "lay-low",
    hours: 4,
  });
  heatView = await heatAdapter.getPlayerProjection({ actorId: "actor-1" });
  assert.equal(heatView.heatBlocked, false);
  assert.equal(
    heatView.activities.find((activity) => activity.id === "pickpocket")
      .available,
    true,
    "queuing Lay Low should open a safe path to a later crime action",
  );
  assert.equal(
    heatView.activities.find((activity) => activity.id === "shoplift")
      .available,
    false,
    "Lay Low must not bypass a separate missing-target prerequisite",
  );
  await heatAdapter.queueActivity({
    actorId: "actor-1",
    activityId: "pickpocket",
    hours: 4,
    targetId: "mark-1",
  });
  heatView = await heatAdapter.getPlayerProjection({ actorId: "actor-1" });
  assert.deepEqual(
    heatView.rawQueue.map((entry) => entry.activityId),
    ["lay-low", "pickpocket"],
  );
  heatAdapter.destroy();
} finally {
  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) delete globalThis[key];
    else globalThis[key] = value;
  }
}

process.stdout.write("downtime player UI adapter passed\n");
