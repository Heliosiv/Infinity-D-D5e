import assert from "node:assert/strict";

const originalGlobals = {
  foundry: globalThis.foundry,
  game: globalThis.game,
  ui: globalThis.ui,
  Hooks: globalThis.Hooks,
  CONST: globalThis.CONST,
  ChatMessage: globalThis.ChatMessage,
  AudioHelper: globalThis.AudioHelper,
  fromUuid: globalThis.fromUuid,
  setTimeout: globalThis.setTimeout,
  clearTimeout: globalThis.clearTimeout,
};

const hookListeners = new Map();
const warnings = [];
const infos = [];
const socketFrames = [];
const storageTrace = [];
const receipts = [];
const scheduledTimers = [];
let stored = { version: 2, records: [] };
let rejectSettingWrites = false;
let rejectReceiptCreates = false;
let settingWriteGate = null;

class TestApplicationV2 {
  constructor(options = {}) {
    this.options = options;
    this.id = options.id ?? "test-app";
    this.rendered = false;
    this.element = null;
  }

  render() {
    this.rendered = true;
    return this;
  }

  bringToFront() {}

  close(options) {
    this._onClose?.(options);
    this.rendered = false;
    return this;
  }

  _onClose() {}
}

globalThis.foundry = {
  applications: {
    api: {
      ApplicationV2: TestApplicationV2,
      HandlebarsApplicationMixin: (Base) => class extends Base {},
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
globalThis.ui = {
  notifications: {
    warn: (message) => warnings.push(String(message)),
    info: (message) => infos.push(String(message)),
  },
};
globalThis.CONST = {
  USER_ROLES: { GAMEMASTER: 4 },
  DOCUMENT_OWNERSHIP_LEVELS: { OWNER: 3 },
};
globalThis.AudioHelper = { play: async () => null };
globalThis.setTimeout = (callback, delay) => {
  const timer = { callback, delay, cleared: false, ran: false };
  scheduledTimers.push(timer);
  return timer;
};
globalThis.clearTimeout = (timer) => {
  if (timer) timer.cleared = true;
};

const ownedItem = {
  id: "owned-item",
  name: "Silver Ring",
  type: "loot",
  system: {
    quantity: 2,
    price: { value: 10, denomination: "gp" },
  },
  flags: {},
  toObject() {
    return {
      _id: this.id,
      name: this.name,
      type: this.type,
      system: structuredClone(this.system),
      flags: {},
    };
  },
};
const actorItems = new Map([[ownedItem.id, ownedItem]]);
const actor = {
  id: "actor-player",
  name: "Player Character",
  type: "character",
  ownership: { player: 3 },
  system: {
    currency: { pp: 0, gp: 100, ep: 0, sp: 0, cp: 0 },
    skills: {},
  },
  items: { get: (id) => actorItems.get(id) ?? null },
  testUserPermission(user) {
    return user?.id === "player";
  },
};
const player = {
  id: "player",
  isGM: false,
  active: true,
  role: 1,
  character: actor,
};
const gm = { id: "gm", isGM: true, active: false, role: 4 };
const users = [player, gm];
users.activeGM = null;
users.get = (id) => users.find((user) => user.id === id) ?? null;

globalThis.game = {
  world: { id: "world-current" },
  user: player,
  users,
  actors: {
    contents: [actor],
    get: (id) => (id === actor.id ? actor : null),
  },
  time: { serverTime: 50_000 },
  settings: {
    get(moduleId, key) {
      assert.equal(moduleId, "infinity-dnd5e");
      if (key === "merchantPendingCommits") return structuredClone(stored);
      if (key === "merchantConfirmTransactions") return false;
      if (key === "merchantChatMode") return "public";
      return undefined;
    },
    async set(moduleId, key, value) {
      assert.equal(moduleId, "infinity-dnd5e");
      assert.equal(key, "merchantPendingCommits");
      storageTrace.push("persist");
      if (rejectSettingWrites) throw new Error("expected storage rejection");
      if (settingWriteGate) await settingWriteGate;
      stored = structuredClone(value);
      return structuredClone(stored);
    },
  },
  socket: {
    emit(_channel, payload, options) {
      socketFrames.push({ payload: structuredClone(payload), options });
      if (payload.type?.startsWith("merchant:commit-")) {
        storageTrace.push("emit");
      }
    },
    on() {},
  },
};
globalThis.ChatMessage = {
  getSpeaker: () => ({ alias: "Merchant" }),
  async create(data) {
    if (rejectReceiptCreates) throw new Error("expected receipt rejection");
    receipts.push(data);
    return data;
  },
};
const shopItem = {
  id: "shop-item",
  uuid: "Item.shop-item",
  name: "Trail Rations",
  type: "consumable",
  system: { price: { value: 2, denomination: "gp" } },
  flags: {},
  toObject() {
    return {
      _id: this.id,
      name: this.name,
      type: this.type,
      system: structuredClone(this.system),
      flags: {},
    };
  },
};
globalThis.fromUuid = async (uuid) =>
  uuid === shopItem.uuid ? shopItem : null;

const {
  clearMerchantPendingCommit,
  clearMerchantPendingReview,
  listMerchantPendingReviews,
  listMerchantPendingTerminalOutbox,
  persistMerchantPendingCommit,
  settleMerchantPendingCommitResult,
} = await import("./merchant/client-pending.js");
const { normalizeMerchant } = await import("./merchant/store.js");
const { merchantCommitRequestFingerprint } =
  await import("./merchant/transaction-ledger.js");
const {
  MerchantSessionApp,
  drainPersistedMerchantTerminalOutbox,
  registerMerchantSessionAutoOpen,
} = await import("./merchant-session.js");
const { MERCHANT_EVENTS, emitMerchantEvent } =
  await import("./merchant/socket.js");

function pendingRecord({
  index,
  sessionId,
  worldId = "world-current",
  eventType = MERCHANT_EVENTS.COMMIT_PURCHASE,
} = {}) {
  const side = eventType === MERCHANT_EVENTS.COMMIT_SALE ? "sell" : "buy";
  const itemUuid = side === "sell" ? ownedItem.id : shopItem.uuid;
  const commitId = `m1.${(60_000 + index).toString(36)}.${index
    .toString(16)
    .padStart(32, "0")}`;
  return {
    worldId,
    originUserId: player.id,
    commitId,
    eventType,
    payload: {
      sessionId,
      itemUuid,
      qty: 1,
      sealId: null,
      totalGp: side === "sell" ? 5 : 2,
      commitId,
      actorId: actor.id,
    },
    context: {
      side,
      merchantId: "merchant-1",
      merchantName: "Quartermaster",
      refId: itemUuid,
      itemName: side === "sell" ? ownedItem.name : shopItem.name,
      qty: 1,
      unitGp: side === "sell" ? 5 : 2,
      totalGp: side === "sell" ? 5 : 2,
      sealKey: `${itemUuid}::${side}`,
      seal: null,
    },
  };
}

function terminalResult(record, overrides = {}) {
  const side =
    record.eventType === MERCHANT_EVENTS.COMMIT_SALE ? "sell" : "buy";
  return {
    sessionId: record.payload.sessionId,
    commitId: record.commitId,
    targetUserId: record.originUserId,
    side,
    requestFingerprint: merchantCommitRequestFingerprint({
      type: record.eventType,
      originUserId: record.originUserId,
      ...record.payload,
    }),
    ok: false,
    reason: "declined",
    ...overrides,
  };
}

function merchant() {
  return normalizeMerchant({
    id: "merchant-1",
    name: "Quartermaster",
    markup: 1,
    sellRatio: 0.5,
    goldOnHand: 100,
    passiveHaggle: false,
    items: [
      {
        uuid: shopItem.uuid,
        qty: 10,
        startingQty: 10,
        unlimited: false,
        priceOverrideGp: 2,
      },
    ],
  });
}

function flushAsyncHandlers() {
  return new Promise((resolve) => setImmediate(resolve));
}

async function settleSocketHandlers() {
  await flushAsyncHandlers();
  await flushAsyncHandlers();
  await flushAsyncHandlers();
}

async function runLatestReviewSurfaceTimer() {
  const timer = [...scheduledTimers]
    .reverse()
    .find(
      (candidate) =>
        candidate.delay === 750 && !candidate.cleared && !candidate.ran,
    );
  assert.ok(timer, "a saved-review status window is scheduled");
  timer.ran = true;
  await timer.callback();
  await settleSocketHandlers();
}

function emitLocal(type, data) {
  return emitMerchantEvent(type, data, {
    emitSocket: false,
    dispatchLocal: true,
  });
}

try {
  /* Reload while offline keeps the exact frame, then GM reconnect resends it. */
  const reloaded = pendingRecord({ index: 1, sessionId: "session-reload" });
  stored = { version: 2, records: [reloaded] };
  registerMerchantSessionAutoOpen();
  await settleSocketHandlers();
  assert.equal(
    socketFrames.some(
      ({ payload }) =>
        payload.type === reloaded.eventType &&
        payload.commitId === reloaded.commitId,
    ),
    false,
    "offline registration cannot emit the pending request to a nonexistent authority",
  );
  assert.deepEqual(stored.records, [reloaded]);

  gm.active = true;
  users.activeGM = gm;
  for (const callback of hookListeners.get("userConnected") ?? []) {
    callback(gm, true);
  }
  await settleSocketHandlers();
  const reconnectReplay = socketFrames.find(
    ({ payload }) =>
      payload.type === reloaded.eventType &&
      payload.commitId === reloaded.commitId,
  );
  assert.ok(
    reconnectReplay,
    "the authoritative GM reconnect replays the request",
  );
  for (const [key, value] of Object.entries(reloaded.payload)) {
    assert.deepEqual(
      reconnectReplay.payload[key],
      value,
      `reconnect preserves payload.${key}`,
    );
  }

  /* A resumed session rehydrates memory/actor context and replays once more. */
  emitLocal(MERCHANT_EVENTS.SESSION_OPEN, {
    sessionId: reloaded.payload.sessionId,
    merchant: merchant(),
    targetUserId: player.id,
    resume: true,
  });
  await settleSocketHandlers();
  const restoredApp = MerchantSessionApp.open({
    sessionId: reloaded.payload.sessionId,
    merchant: merchant(),
  });
  const restoredContext = restoredApp._pendingCommits.get(reloaded.commitId);
  assert.ok(restoredContext, "the matching saved request is rehydrated");
  assert.equal(restoredContext.actor, actor, "the saved actor id is resolved");
  assert.deepEqual(restoredContext.payload, reloaded.payload);
  assert.equal(restoredContext.itemName, reloaded.context.itemName);
  assert.ok(
    socketFrames.filter(
      ({ payload }) =>
        payload.type === reloaded.eventType &&
        payload.commitId === reloaded.commitId,
    ).length >= 2,
    "the matching SESSION_OPEN/resume replays the exact request",
  );

  /* A stale/conflicting result cannot clear the saved request. */
  emitLocal(
    MERCHANT_EVENTS.COMMIT_RESULT,
    terminalResult(reloaded, { requestFingerprint: "wrong-request" }),
  );
  await settleSocketHandlers();
  assert.deepEqual(stored.records, [reloaded]);
  assert.ok(restoredApp._pendingCommits.has(reloaded.commitId));
  assert.equal(receipts.length, 0);

  /* Clear happens before one receipt; duplicate terminal results stay inert. */
  const successResult = terminalResult(reloaded, {
    ok: true,
    reason: "",
    itemName: reloaded.context.itemName,
    qty: 1,
    unitGp: 2,
    totalGp: 2,
  });
  emitLocal(MERCHANT_EVENTS.COMMIT_RESULT, successResult);
  emitLocal(MERCHANT_EVENTS.COMMIT_RESULT, successResult);
  await settleSocketHandlers();
  assert.deepEqual(stored.records, []);
  assert.equal(receipts.length, 1);
  assert.equal(restoredApp._pendingCommits.size, 0);
  emitLocal(MERCHANT_EVENTS.COMMIT_RESULT, successResult);
  await settleSocketHandlers();
  assert.equal(receipts.length, 1, "a duplicate result cannot post twice");

  /* The global result subscriber clears even when no app is open. */
  const headless = pendingRecord({ index: 2, sessionId: "session-headless" });
  await persistMerchantPendingCommit(headless);
  emitLocal(
    MERCHANT_EVENTS.COMMIT_RESULT,
    terminalResult(headless, { reason: "session-closed" }),
  );
  await settleSocketHandlers();
  assert.deepEqual(stored.records, []);
  assert.equal(receipts.length, 1, "a headless clear never creates a receipt");

  const headlessSuccess = pendingRecord({
    index: 22,
    sessionId: "session-headless-success",
  });
  await persistMerchantPendingCommit(headlessSuccess);
  emitLocal(
    MERCHANT_EVENTS.COMMIT_RESULT,
    terminalResult(headlessSuccess, {
      ok: true,
      reason: "",
      itemName: headlessSuccess.context.itemName,
      qty: 1,
      unitGp: 2,
      totalGp: 2,
    }),
  );
  await settleSocketHandlers();
  assert.deepEqual(stored.records, []);
  assert.equal(receipts.length, 2, "a completed headless trade posts once");

  const compacted = pendingRecord({
    index: 23,
    sessionId: "session-compacted",
  });
  await persistMerchantPendingCommit(compacted);
  emitLocal(
    MERCHANT_EVENTS.COMMIT_RESULT,
    terminalResult(compacted, {
      reason: "transaction-history-expired",
    }),
  );
  await settleSocketHandlers();
  assert.equal(stored.records.length, 1);
  assert.equal(stored.records[0].state, "review");
  assert.equal(stored.records[0].review.reason, "transaction-history-expired");
  assert.deepEqual(
    listMerchantPendingReviews(),
    [stored.records[0]],
    "the exact actor/item/quantity context remains quarantined",
  );
  assert.equal(
    receipts.length,
    2,
    "an expired replay receipt is not fabricated from zero-value details",
  );
  assert.ok(
    warnings.some(
      (message) =>
        /Trail Rations/i.test(message) &&
        /Quartermaster/i.test(message) &&
        /1x/i.test(message),
    ),
  );
  await clearMerchantPendingReview(compacted.originUserId, compacted.commitId);

  const needsReview = pendingRecord({
    index: 24,
    sessionId: "session-needs-review",
  });
  await persistMerchantPendingCommit(needsReview);
  emitLocal(
    MERCHANT_EVENTS.COMMIT_RESULT,
    terminalResult(needsReview, {
      reason: "transaction-needs-review",
    }),
  );
  await settleSocketHandlers();
  assert.equal(stored.records.length, 1);
  assert.equal(stored.records[0].state, "review");
  assert.equal(stored.records[0].review.reason, "transaction-needs-review");
  assert.equal(receipts.length, 2);
  assert.ok(
    warnings.some(
      (message) =>
        /pinned for GM review/i.test(message) && /Trail Rations/i.test(message),
    ),
  );
  const statusFramesBefore = socketFrames.length;
  for (const callback of hookListeners.get("userConnected") ?? []) {
    callback(gm, true);
  }
  await settleSocketHandlers();
  const reviewStatusFrame = socketFrames
    .slice(statusFramesBefore)
    .find(
      ({ payload }) =>
        payload.type === MERCHANT_EVENTS.COMMIT_STATUS_REQUEST &&
        payload.commitId === needsReview.commitId,
    );
  assert.ok(reviewStatusFrame, "reconnect probes the inert review status");
  assert.equal(
    reviewStatusFrame.payload.requestFingerprint,
    merchantCommitRequestFingerprint({
      type: needsReview.eventType,
      originUserId: needsReview.originUserId,
      ...needsReview.payload,
    }),
  );
  await clearMerchantPendingReview(
    needsReview.originUserId,
    needsReview.commitId,
  );

  /* Probe before warning: an exact terminal answer suppresses stale review UI. */
  const resolvedReview = pendingRecord({
    index: 25,
    sessionId: "session-review-resolved-offline",
  });
  await persistMerchantPendingCommit(resolvedReview);
  const resolvedReviewSettlement = await settleMerchantPendingCommitResult(
    terminalResult(resolvedReview, { reason: "transaction-needs-review" }),
  );
  assert.equal(resolvedReviewSettlement.status, "quarantined");
  const warningsBeforeResolvedProbe = warnings.length;
  const receiptsBeforeResolvedProbe = receipts.length;
  for (const callback of hookListeners.get("userConnected") ?? []) {
    callback(gm, true);
  }
  await settleSocketHandlers();
  assert.ok(
    socketFrames.some(
      ({ payload }) =>
        payload.type === MERCHANT_EVENTS.COMMIT_STATUS_REQUEST &&
        payload.commitId === resolvedReview.commitId,
    ),
    "the review status is probed before its deferred warning",
  );
  emitLocal(
    MERCHANT_EVENTS.COMMIT_RESULT,
    terminalResult(resolvedReview, {
      ok: true,
      reason: "",
      itemName: resolvedReview.context.itemName,
      qty: 1,
      unitGp: 2,
      totalGp: 2,
    }),
  );
  await settleSocketHandlers();
  await runLatestReviewSurfaceTimer();
  assert.equal(
    warnings.length,
    warningsBeforeResolvedProbe,
    "an exact terminal settlement suppresses the stale permanent warning",
  );
  assert.equal(receipts.length, receiptsBeforeResolvedProbe + 1);
  assert.equal(
    listMerchantPendingReviews().some(
      (record) => record.commitId === resolvedReview.commitId,
    ),
    false,
  );

  /* With no status answer, the saved warning appears once after the window. */
  const unansweredReview = pendingRecord({
    index: 26,
    sessionId: "session-review-unanswered",
  });
  await persistMerchantPendingCommit(unansweredReview);
  const unansweredSettlement = await settleMerchantPendingCommitResult(
    terminalResult(unansweredReview, { reason: "transaction-needs-review" }),
  );
  assert.equal(unansweredSettlement.status, "quarantined");
  const warningsBeforeUnansweredProbe = warnings.length;
  for (const callback of hookListeners.get("userConnected") ?? []) {
    callback(gm, true);
  }
  await settleSocketHandlers();
  await runLatestReviewSurfaceTimer();
  assert.equal(warnings.length, warningsBeforeUnansweredProbe + 1);
  assert.match(warnings.at(-1), /session-review-unanswered|Trail Rations/i);
  for (const callback of hookListeners.get("userConnected") ?? []) {
    callback(gm, true);
  }
  await settleSocketHandlers();
  await runLatestReviewSurfaceTimer();
  assert.equal(
    warnings.length,
    warningsBeforeUnansweredProbe + 1,
    "one unresolved saved review is not surfaced repeatedly",
  );
  await clearMerchantPendingReview(
    unansweredReview.originUserId,
    unansweredReview.commitId,
  );

  /* A failed clear leaves the request pending and suppresses the receipt. */
  const blocked = pendingRecord({ index: 3, sessionId: "session-blocked" });
  await persistMerchantPendingCommit(blocked);
  emitLocal(MERCHANT_EVENTS.SESSION_OPEN, {
    sessionId: blocked.payload.sessionId,
    merchant: merchant(),
    targetUserId: player.id,
    resume: true,
  });
  await settleSocketHandlers();
  const blockedApp = MerchantSessionApp.open({
    sessionId: blocked.payload.sessionId,
    merchant: merchant(),
  });
  rejectSettingWrites = true;
  const blockedResult = terminalResult(blocked, {
    ok: true,
    reason: "",
    itemName: blocked.context.itemName,
    qty: 1,
    unitGp: 2,
    totalGp: 2,
  });
  emitLocal(MERCHANT_EVENTS.COMMIT_RESULT, blockedResult);
  await settleSocketHandlers();
  assert.deepEqual(stored.records, [{ state: "pending", ...blocked }]);
  assert.equal(receipts.length, 3, "no receipt is posted before durable clear");
  assert.ok(blockedApp._pendingCommits.has(blocked.commitId));
  assert.ok(
    warnings.some((message) =>
      /could not safely store or present/i.test(message),
    ),
  );

  rejectSettingWrites = false;
  emitLocal(MERCHANT_EVENTS.COMMIT_RESULT, blockedResult);
  await settleSocketHandlers();
  assert.deepEqual(stored.records, []);
  assert.equal(receipts.length, 4);
  emitLocal(MERCHANT_EVENTS.COMMIT_RESULT, blockedResult);
  await settleSocketHandlers();
  assert.equal(receipts.length, 4, "a recovered clear still receipts once");

  /* A same-session tab without the exact commit cannot suppress its receipt. */
  const staleTab = pendingRecord({ index: 30, sessionId: "session-stale-tab" });
  const staleApp = MerchantSessionApp.open({
    sessionId: staleTab.payload.sessionId,
    merchant: merchant(),
  });
  assert.equal(staleApp._pendingCommits.has(staleTab.commitId), false);
  await persistMerchantPendingCommit(staleTab);
  const receiptsBeforeStale = receipts.length;
  emitLocal(
    MERCHANT_EVENTS.COMMIT_RESULT,
    terminalResult(staleTab, {
      ok: true,
      reason: "",
      itemName: staleTab.context.itemName,
      qty: staleTab.context.qty,
      unitGp: staleTab.context.unitGp,
      totalGp: staleTab.context.totalGp,
    }),
  );
  await settleSocketHandlers();
  assert.equal(receipts.length, receiptsBeforeStale + 1);
  assert.deepEqual(stored.records, []);
  assert.equal(
    receipts.at(-1).flags?.["infinity-dnd5e"]?.merchantTransactionReceipt
      ?.originUserId,
    player.id,
  );
  MerchantSessionApp.closeSession(staleTab.payload.sessionId);

  /* Another browser tab can win storage settlement and post the one receipt.
     An exact terminal frame still clears this tab's in-memory watchdog without
     creating a duplicate receipt. */
  const crossTab = pendingRecord({
    index: 33,
    sessionId: "session-cross-tab-terminal",
  });
  await persistMerchantPendingCommit(crossTab);
  const crossTabApp = MerchantSessionApp.open({
    sessionId: crossTab.payload.sessionId,
    merchant: merchant(),
  });
  const crossTabContext = crossTabApp._pendingCommits.get(crossTab.commitId);
  assert.ok(crossTabContext, "the second tab tracks the exact saved request");
  stored = { version: 3, records: [] };
  const receiptsBeforeCrossTab = receipts.length;
  emitLocal(
    MERCHANT_EVENTS.COMMIT_RESULT,
    terminalResult(crossTab, {
      ok: true,
      reason: "",
      itemName: crossTab.context.itemName,
      qty: crossTab.context.qty,
      unitGp: crossTab.context.unitGp,
      totalGp: crossTab.context.totalGp,
    }),
  );
  await settleSocketHandlers();
  assert.equal(crossTabApp._pendingCommits.has(crossTab.commitId), false);
  assert.equal(crossTabContext.timer.cleared, true);
  assert.equal(
    receipts.length,
    receiptsBeforeCrossTab,
    "the losing tab clears locally without posting a second receipt",
  );
  MerchantSessionApp.closeSession(crossTab.payload.sessionId);

  /* Receipt failure leaves a reload-drainable terminal outbox. */
  const failedReceipt = pendingRecord({
    index: 31,
    sessionId: "session-receipt-failure",
  });
  await persistMerchantPendingCommit(failedReceipt);
  const receiptsBeforeFailure = receipts.length;
  rejectReceiptCreates = true;
  emitLocal(
    MERCHANT_EVENTS.COMMIT_RESULT,
    terminalResult(failedReceipt, {
      ok: true,
      reason: "",
      itemName: failedReceipt.context.itemName,
      qty: failedReceipt.context.qty,
      unitGp: failedReceipt.context.unitGp,
      totalGp: failedReceipt.context.totalGp,
    }),
  );
  await settleSocketHandlers();
  assert.equal(receipts.length, receiptsBeforeFailure);
  assert.equal(listMerchantPendingTerminalOutbox().length, 1);
  rejectReceiptCreates = false;
  await drainPersistedMerchantTerminalOutbox();
  assert.equal(receipts.length, receiptsBeforeFailure + 1);
  assert.deepEqual(stored.records, []);

  /* Closing the exact app during settlement still produces one receipt. */
  const closing = pendingRecord({
    index: 32,
    sessionId: "session-close-during-settlement",
  });
  await persistMerchantPendingCommit(closing);
  const closingApp = MerchantSessionApp.open({
    sessionId: closing.payload.sessionId,
    merchant: merchant(),
  });
  assert.equal(closingApp._pendingCommits.has(closing.commitId), true);
  let releaseSettingWrite;
  settingWriteGate = new Promise((resolve) => {
    releaseSettingWrite = resolve;
  });
  const persistCountBeforeClose = storageTrace.filter(
    (entry) => entry === "persist",
  ).length;
  const receiptsBeforeClose = receipts.length;
  emitLocal(
    MERCHANT_EVENTS.COMMIT_RESULT,
    terminalResult(closing, {
      ok: true,
      reason: "",
      itemName: closing.context.itemName,
      qty: closing.context.qty,
      unitGp: closing.context.unitGp,
      totalGp: closing.context.totalGp,
    }),
  );
  while (
    storageTrace.filter((entry) => entry === "persist").length ===
    persistCountBeforeClose
  ) {
    await flushAsyncHandlers();
  }
  closingApp.close();
  releaseSettingWrite();
  settingWriteGate = null;
  await settleSocketHandlers();
  assert.equal(receipts.length, receiptsBeforeClose + 1);
  assert.deepEqual(stored.records, []);

  /* Buy and sell both persist/read back, track, then emit. */
  function actionHarness() {
    const app = Object.create(MerchantSessionApp.prototype);
    app._previewMode = false;
    app._sessionId = "session-action";
    app._merchant = merchant();
    app._pendingCommits = new Map();
    app._seals = new Map();
    app._log = [];
    app._pendingPersistenceBlocked = false;
    app._resolveTradingActor = () => actor;
    app.rendered = false;
    app.render = () => app;
    const track = MerchantSessionApp.prototype._trackCommit;
    app._trackCommit = function (...args) {
      storageTrace.push("track");
      return track.apply(this, args);
    };
    return app;
  }

  stored = { version: 2, records: [] };
  storageTrace.length = 0;
  const buyApp = actionHarness();
  buyApp._seals.set(`${shopItem.uuid}::buy`, {
    sealId: "seal-failed-tier",
    tier: { id: "failure", minMargin: -Infinity, deltaPct: 10 },
    deltaPct: 10,
    rollTotal: 5,
    dc: 15,
  });
  await buyApp._performBuy(shopItem.uuid, 1);
  assert.deepEqual(storageTrace.slice(0, 3), ["persist", "track", "emit"]);
  assert.equal(stored.records.length, 1);
  assert.equal(stored.records[0].worldId, "world-current");
  assert.match(stored.records[0].commitId, /^m1\.[0-9a-z]+\.[0-9a-f]{32}$/);
  assert.deepEqual(stored.records[0].context.seal.tier, { id: "failure" });
  const buyRecord = structuredClone(stored.records[0]);
  await buyApp._presentTerminalCommit(
    buyRecord,
    terminalResult(buyRecord, {
      ok: false,
      reason: "bargain-expired",
    }),
  );
  assert.equal(
    buyApp._seals.has(`${shopItem.uuid}::buy`),
    false,
    "an expired bargain clears only its matching local seal",
  );

  const priceApp = actionHarness();
  const priceRecord = pendingRecord({
    index: 91,
    sessionId: priceApp._sessionId,
  });
  priceApp._seals.set(priceRecord.context.sealKey, {
    sealId: "seal-price-changed",
  });
  priceApp._trackCommit(priceRecord.commitId, {
    ...priceRecord.context,
    eventType: priceRecord.eventType,
    payload: priceRecord.payload,
    actor,
  });
  await priceApp._presentTerminalCommit(
    priceRecord,
    terminalResult(priceRecord, { ok: false, reason: "price-changed" }),
  );
  assert.equal(
    priceApp._seals.has(priceRecord.context.sealKey),
    true,
    "a changed price keeps the local seal available for a deliberate retry",
  );

  storageTrace.length = 0;
  const sellApp = actionHarness();
  await sellApp._performSell(ownedItem.id, 1);
  assert.deepEqual(storageTrace.slice(0, 3), ["persist", "track", "emit"]);
  assert.equal(stored.records.length, 2);

  /* A persistence failure emits/tracks nothing and gives a plain warning. */
  rejectSettingWrites = true;
  storageTrace.length = 0;
  const failedApp = actionHarness();
  const commitFramesBefore = socketFrames.filter(({ payload }) =>
    payload.type?.startsWith("merchant:commit-"),
  ).length;
  await failedApp._performBuy(shopItem.uuid, 1);
  const commitFramesAfter = socketFrames.filter(({ payload }) =>
    payload.type?.startsWith("merchant:commit-"),
  ).length;
  assert.deepEqual(storageTrace, ["persist"]);
  assert.equal(failedApp._pendingCommits.size, 0);
  assert.equal(commitFramesAfter, commitFramesBefore);
  assert.match(warnings.at(-1), /trade was not sent/i);
  assert.deepEqual(
    stored.records.length,
    2,
    "failed persistence does not evict earlier unresolved requests",
  );
  rejectSettingWrites = false;

  /* Closing a restored app drops timers/memory, never its persistent record. */
  const closeRecord = pendingRecord({ index: 4, sessionId: "session-close" });
  await persistMerchantPendingCommit(closeRecord);
  const closeApp = MerchantSessionApp.open({
    sessionId: closeRecord.payload.sessionId,
    merchant: merchant(),
  });
  assert.ok(closeApp._pendingCommits.has(closeRecord.commitId));
  closeApp._onClose();
  assert.equal(closeApp._pendingCommits.size, 0);
  assert.ok(
    stored.records.some(
      (candidate) => candidate.commitId === closeRecord.commitId,
    ),
    "window close preserves the durable pending record",
  );

  // Clean up through the exact key API so no test fixture is silently evicted.
  for (const candidate of structuredClone(stored.records)) {
    await clearMerchantPendingCommit(
      candidate.originUserId,
      candidate.commitId,
    );
  }

  /* Another World's queue is neither rehydrated nor replayed on reconnect. */
  const otherWorld = pendingRecord({
    index: 5,
    sessionId: "session-other-world",
    worldId: "world-other",
  });
  stored = { version: 2, records: [otherWorld] };
  const foreignApp = actionHarness();
  foreignApp._sessionId = otherWorld.payload.sessionId;
  assert.equal(foreignApp._rehydratePendingCommits(), true);
  assert.equal(foreignApp._pendingCommits.size, 0);
  const foreignFramesBefore = socketFrames.filter(
    ({ payload }) => payload.commitId === otherWorld.commitId,
  ).length;
  for (const callback of hookListeners.get("userConnected") ?? []) {
    callback(gm, true);
  }
  await settleSocketHandlers();
  assert.equal(
    socketFrames.filter(
      ({ payload }) => payload.commitId === otherWorld.commitId,
    ).length,
    foreignFramesBefore,
  );
  assert.deepEqual(stored, { version: 2, records: [otherWorld] });

  const legacy = structuredClone(otherWorld);
  delete legacy.worldId;
  stored = { version: 1, records: [legacy] };
  const legacyApp = actionHarness();
  legacyApp._sessionId = legacy.payload.sessionId;
  assert.equal(legacyApp._rehydratePendingCommits(), false);
  assert.equal(legacyApp._pendingCommits.size, 0);
  const legacyFramesBefore = socketFrames.filter(
    ({ payload }) => payload.commitId === legacy.commitId,
  ).length;
  for (const callback of hookListeners.get("userConnected") ?? []) {
    callback(gm, true);
  }
  await settleSocketHandlers();
  assert.equal(
    socketFrames.filter(({ payload }) => payload.commitId === legacy.commitId)
      .length,
    legacyFramesBefore,
  );
  assert.deepEqual(stored, { version: 1, records: [legacy] });

  console.log("Merchant session pending/reload checks passed.");
} finally {
  for (const [key, value] of Object.entries(originalGlobals)) {
    if (value === undefined) delete globalThis[key];
    else globalThis[key] = value;
  }
}
