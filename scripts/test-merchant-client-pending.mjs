import assert from "node:assert/strict";

import { createBrowserLeaseManager } from "./browser-lock.js";

import {
  MERCHANT_PENDING_MAX_RECORDS,
  MERCHANT_PENDING_MAX_REVIEW_RECORDS,
  MERCHANT_PENDING_MAX_TOTAL_RECORDS,
  MERCHANT_PENDING_SCHEMA_VERSION,
  MERCHANT_PENDING_SETTING_KEY,
  clearMerchantPendingCommit,
  clearMerchantPendingReview,
  createEmptyMerchantPendingCommits,
  listMerchantPendingCommits,
  listMerchantPendingReviews,
  listMerchantPendingTerminalOutbox,
  loadMerchantPendingCommits,
  merchantPendingCommitMatchesResult,
  newMerchantCommitId,
  parseMerchantPendingCommits,
  parseMerchantPendingRecord,
  persistAndSendMerchantCommit,
  persistMerchantPendingCommit,
  presentMerchantPendingTerminalOutbox,
  resendMerchantPendingCommits,
  settleMerchantPendingCommitResult,
} from "./merchant/client-pending.js";
import {
  merchantCommitRequestFingerprint,
  parseMerchantCommitId,
} from "./merchant/transaction-ledger.js";
import { SETTINGS, SETTING_KEYS } from "./settings.js";

const MODULE_ID = "infinity-dnd5e";
const PURCHASE = "merchant:commit-purchase";
const SALE = "merchant:commit-sale";

function clone(value) {
  return structuredClone(value);
}

function commitId(index) {
  return `m1.${(10_000 + index).toString(36)}.${index
    .toString(16)
    .padStart(32, "0")}`;
}

function record({
  index = 1,
  worldId = "world-a",
  originUserId = "player-a",
  eventType = PURCHASE,
  seal = null,
} = {}) {
  const side = eventType === SALE ? "sell" : "buy";
  const id = commitId(index);
  const refId = `Item.${index}`;
  const qty = index % 3 || 3;
  const totalGp = index + 0.25;
  return {
    worldId,
    originUserId,
    commitId: id,
    eventType,
    payload: {
      sessionId: `session-${index}`,
      itemUuid: refId,
      qty,
      sealId: seal?.sealId ?? null,
      totalGp,
      commitId: id,
      actorId: `actor-${originUserId}`,
    },
    context: {
      side,
      merchantId: "merchant-1",
      merchantName: "Quartermaster",
      refId,
      itemName: `Exact item ${index}`,
      qty,
      unitGp: totalGp / qty,
      totalGp,
      sealKey: `${refId}::${side}`,
      seal,
    },
  };
}

function storedPending(value) {
  return { state: "pending", ...clone(value) };
}

function storedReview(
  value,
  reason = "transaction-history-expired",
  receivedAt = 200_000,
) {
  return {
    state: "review",
    ...clone(value),
    review: { reason, receivedAt },
  };
}

function terminalResult(pending, overrides = {}) {
  const side = pending.eventType === SALE ? "sell" : "buy";
  return {
    targetUserId: pending.originUserId,
    sessionId: pending.payload.sessionId,
    commitId: pending.commitId,
    side,
    ok: false,
    reason: "declined",
    requestFingerprint: merchantCommitRequestFingerprint({
      type: pending.eventType,
      originUserId: pending.originUserId,
      ...pending.payload,
    }),
    ...overrides,
  };
}

function settingGame(
  initial = createEmptyMerchantPendingCommits(),
  options = {},
) {
  let stored = clone(initial);
  let setCalls = 0;
  const events = [];
  const gameInstance = {
    world: { id: options.worldId ?? "world-a" },
    user: { id: options.userId ?? "player-a" },
    time: { serverTime: options.serverTime ?? 123_456 },
    settings: {
      get(moduleId, key) {
        assert.equal(moduleId, MODULE_ID);
        assert.equal(key, MERCHANT_PENDING_SETTING_KEY);
        const raw = options.onGet
          ? options.onGet(clone(stored), setCalls)
          : stored;
        return clone(raw);
      },
      async set(moduleId, key, value) {
        assert.equal(moduleId, MODULE_ID);
        assert.equal(key, MERCHANT_PENDING_SETTING_KEY);
        setCalls += 1;
        events.push("set");
        if (options.setError) throw options.setError;
        stored = clone(value);
        if (options.onSet) stored = options.onSet(clone(stored), setCalls);
        return clone(stored);
      },
    },
  };
  return {
    gameInstance,
    events,
    get setCalls() {
      return setCalls;
    },
    stored: () => clone(stored),
  };
}

/* Hidden client setting registration -------------------------------- */

{
  assert.equal(SETTING_KEYS.MERCHANT_PENDING_COMMITS, "merchantPendingCommits");
  const definition = SETTINGS.find(
    (entry) => entry.key === SETTING_KEYS.MERCHANT_PENDING_COMMITS,
  );
  assert.ok(definition, "the pending queue is in the central setting catalog");
  assert.equal(definition.scope, "client");
  assert.equal(definition.config, false);
  assert.equal(definition.type, Object);
  assert.deepEqual(definition.default, { version: 3, records: [] });
  assert.equal(MERCHANT_PENDING_SCHEMA_VERSION, 3);
  assert.equal(MERCHANT_PENDING_MAX_RECORDS, 50);
  assert.equal(MERCHANT_PENDING_MAX_REVIEW_RECORDS, 50);
  assert.equal(MERCHANT_PENDING_MAX_TOTAL_RECORDS, 500);
}

/* Secure, canonical commit ids -------------------------------------- */

{
  let requestedLength = 0;
  const cryptoApi = {
    getRandomValues(bytes) {
      requestedLength = bytes.length;
      for (let index = 0; index < bytes.length; index += 1) {
        bytes[index] = index;
      }
      return bytes;
    },
  };
  const generated = newMerchantCommitId({
    gameInstance: { time: { serverTime: 123_456 } },
    cryptoApi,
  });
  assert.equal(generated, "m1.2n9c.000102030405060708090a0b0c0d0e0f");
  assert.equal(requestedLength, 16, "the id contains 128 random bits");
  assert.deepEqual(parseMerchantCommitId(generated), {
    commitId: generated,
    timestamp: 123_456,
    randomHex: "000102030405060708090a0b0c0d0e0f",
  });

  const injected = newMerchantCommitId({
    now: () => 99,
    gameInstance: { time: { serverTime: 1 } },
    cryptoApi: {
      getRandomValues(bytes) {
        bytes.fill(0xab);
      },
    },
  });
  assert.equal(injected, `m1.2r.${"ab".repeat(16)}`);

  const originalDateNow = Date.now;
  Date.now = () => 777;
  try {
    const fallback = newMerchantCommitId({
      gameInstance: { time: { serverTime: Number.NaN } },
      cryptoApi: {
        getRandomValues(bytes) {
          bytes.fill(1);
        },
      },
    });
    assert.equal(fallback, `m1.ll.${"01".repeat(16)}`);
  } finally {
    Date.now = originalDateNow;
  }

  assert.throws(
    () => newMerchantCommitId({ now: 1, cryptoApi: null }),
    (error) => error.code === "MERCHANT_PENDING_CRYPTO_UNAVAILABLE",
  );
  assert.throws(
    () =>
      newMerchantCommitId({
        now: 1,
        cryptoApi: {
          getRandomValues() {
            throw new Error("entropy source failed");
          },
        },
      }),
    (error) => error.code === "MERCHANT_PENDING_CRYPTO_UNAVAILABLE",
  );
  assert.throws(
    () => newMerchantCommitId({ now: 0, cryptoApi }),
    (error) => error.code === "MERCHANT_PENDING_INVALID_TIME",
    "the shared formatter keeps timestamps positive",
  );
}

/* Strict envelope and record parsing -------------------------------- */

{
  const valid = record({
    index: 2,
    eventType: SALE,
    seal: {
      sealId: "seal-2",
      tier: { id: "success" },
      deltaPct: -10,
      rollTotal: 19,
      dc: 15,
    },
  });
  assert.deepEqual(parseMerchantPendingRecord(valid), valid);
  assert.deepEqual(parseMerchantPendingCommits(undefined), {
    version: 3,
    records: [],
  });
  assert.deepEqual(
    parseMerchantPendingCommits({ version: 2, records: [valid] }),
    { version: 3, records: [storedPending(valid)] },
    "world-scoped v2 records migrate only to pending v3 state",
  );
  assert.deepEqual(
    parseMerchantPendingCommits({
      version: 3,
      records: [storedPending(valid)],
    }),
    { version: 3, records: [storedPending(valid)] },
  );
  assert.deepEqual(
    parseMerchantPendingCommits({ version: 1, records: [] }),
    { version: 3, records: [] },
    "an empty legacy queue is the only safe automatic migration",
  );
  const unscopedLegacy = clone(valid);
  delete unscopedLegacy.worldId;
  assert.throws(
    () =>
      parseMerchantPendingCommits({ version: 1, records: [unscopedLegacy] }),
    (error) => error.code === "MERCHANT_PENDING_LEGACY_UNSCOPED",
    "populated legacy data is quarantined rather than replayed",
  );

  for (const malformed of [
    null,
    [],
    { version: 2 },
    { version: 3, records: [], extra: true },
    { version: "2", records: [] },
    { version: 0, records: [] },
  ]) {
    assert.throws(() => parseMerchantPendingCommits(malformed));
  }
  assert.throws(
    () => parseMerchantPendingCommits({ version: 4, records: [] }),
    (error) => error.code === "MERCHANT_PENDING_FUTURE_VERSION",
  );

  const extraPayload = clone(valid);
  extraPayload.payload.forged = true;
  assert.throws(() => parseMerchantPendingRecord(extraPayload));
  const excessiveQuantity = clone(valid);
  excessiveQuantity.payload.qty = 10_000;
  excessiveQuantity.context.qty = 10_000;
  assert.throws(() => parseMerchantPendingRecord(excessiveQuantity));
  const mismatchedCommit = clone(valid);
  mismatchedCommit.payload.commitId = commitId(3);
  assert.throws(() => parseMerchantPendingRecord(mismatchedCommit));
  const noncanonicalCommit = clone(valid);
  noncanonicalCommit.commitId = noncanonicalCommit.commitId.replace(
    "m1.",
    "m1.0",
  );
  noncanonicalCommit.payload.commitId = noncanonicalCommit.commitId;
  assert.throws(() => parseMerchantPendingRecord(noncanonicalCommit));
  const unscoped = clone(valid);
  delete unscoped.worldId;
  assert.throws(() => parseMerchantPendingRecord(unscoped));
}

/* Persist-before-send, reload/list, and exact resend ---------------- */

{
  const harness = settingGame();
  const pending = record({ index: 4 });
  let sent = null;
  const saved = await persistAndSendMerchantCommit(pending, {
    gameInstance: harness.gameInstance,
    async send(eventType, payload) {
      harness.events.push("send");
      sent = { eventType, payload };
    },
  });
  assert.deepEqual(harness.events, ["set", "send"]);
  assert.deepEqual(saved, pending);
  assert.deepEqual(sent, {
    eventType: pending.eventType,
    payload: pending.payload,
  });

  // A fresh load uses only the setting; there is no process-local queue.
  assert.deepEqual(loadMerchantPendingCommits(harness.gameInstance), {
    version: 3,
    records: [storedPending(pending)],
  });
  assert.deepEqual(
    listMerchantPendingCommits({ gameInstance: harness.gameInstance }),
    [pending],
  );

  const resent = [];
  const listed = await resendMerchantPendingCommits({
    gameInstance: harness.gameInstance,
    async send(eventType, payload) {
      resent.push({ eventType, payload });
    },
  });
  assert.deepEqual(listed, [pending]);
  assert.deepEqual(resent, [
    { eventType: pending.eventType, payload: pending.payload },
  ]);

  const returnedOnly = await resendMerchantPendingCommits({
    gameInstance: harness.gameInstance,
  });
  assert.deepEqual(returnedOnly, [pending]);
}

/* Failed writes and altered readback never claim persistence -------- */

/* Browser Web Locks serialize two independent tab/module realms. */
{
  const originalNavigator = Object.getOwnPropertyDescriptor(
    globalThis,
    "navigator",
  );
  let lockTail = Promise.resolve();
  const lockNames = [];
  Object.defineProperty(globalThis, "navigator", {
    configurable: true,
    value: {
      locks: {
        request(name, options, operation) {
          lockNames.push({ name, options });
          const result = lockTail.then(operation, operation);
          lockTail = result.catch(() => {});
          return result;
        },
      },
    },
  });
  let stored = createEmptyMerchantPendingCommits();
  let activeWrites = 0;
  let maxActiveWrites = 0;
  const sharedSettings = {
    get: () => clone(stored),
    async set(_moduleId, _key, value) {
      activeWrites += 1;
      maxActiveWrites = Math.max(maxActiveWrites, activeWrites);
      await new Promise((resolve) => setImmediate(resolve));
      stored = clone(value);
      activeWrites -= 1;
      return clone(stored);
    },
  };
  const gameA = {
    world: { id: "world-a" },
    user: { id: "player-a" },
    settings: sharedSettings,
  };
  const gameB = {
    world: { id: "world-b" },
    user: { id: "player-a" },
    settings: sharedSettings,
  };
  try {
    const tabA = await import(
      `./merchant/client-pending.js?tab-lock-a=${Date.now()}`
    );
    const tabB = await import(
      `./merchant/client-pending.js?tab-lock-b=${Date.now()}`
    );
    await Promise.all([
      tabA.persistMerchantPendingCommit(
        record({ index: 200, worldId: "world-a" }),
        {
          gameInstance: gameA,
        },
      ),
      tabB.persistMerchantPendingCommit(
        record({ index: 201, worldId: "world-b" }),
        {
          gameInstance: gameB,
        },
      ),
    ]);
    assert.equal(maxActiveWrites, 1);
    assert.equal(stored.records.length, 2);
    assert.equal(lockNames.length, 2);
    assert.ok(
      lockNames.every(
        ({ name, options }) =>
          name === "infinity-dnd5e:merchant-pending-setting" &&
          options.mode === "exclusive",
      ),
    );
  } finally {
    if (originalNavigator) {
      Object.defineProperty(globalThis, "navigator", originalNavigator);
    } else {
      delete globalThis.navigator;
    }
  }
}

/* Plain-HTTP/LAN browser contexts serialize through the shared lease fallback. */
{
  const originalNavigator = Object.getOwnPropertyDescriptor(
    globalThis,
    "navigator",
  );
  const originalWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
  Object.defineProperty(globalThis, "navigator", {
    configurable: true,
    value: {},
  });
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: { document: {} },
  });

  let leaseState = null;
  let leaseTail = Promise.resolve();
  const atomicUpdate = (name, transform) => {
    const result = leaseTail.then(() => {
      const decision = transform(clone(leaseState));
      if (Object.hasOwn(decision, "next")) {
        leaseState = decision.next === null ? null : clone(decision.next);
      }
      return clone(decision.value);
    });
    leaseTail = result.catch(() => {});
    return result;
  };
  const leaseManager = createBrowserLeaseManager({ atomicUpdate });
  let stored = createEmptyMerchantPendingCommits();
  let activeWrites = 0;
  let maxActiveWrites = 0;
  const sharedSettings = {
    get: () => clone(stored),
    async set(_moduleId, _key, value) {
      activeWrites += 1;
      maxActiveWrites = Math.max(maxActiveWrites, activeWrites);
      await new Promise((resolve) => setImmediate(resolve));
      stored = clone(value);
      activeWrites -= 1;
      return clone(stored);
    },
  };
  const gameA = {
    world: { id: "world-a" },
    user: { id: "player-a" },
    settings: sharedSettings,
  };
  const gameB = {
    world: { id: "world-b" },
    user: { id: "player-a" },
    settings: sharedSettings,
  };
  try {
    const tabA = await import(
      `./merchant/client-pending.js?tab-lease-a=${Date.now()}`
    );
    const tabB = await import(
      `./merchant/client-pending.js?tab-lease-b=${Date.now()}`
    );
    const runner = (name, operation, options) =>
      leaseManager.withLease(name, operation, options);
    tabA.configureMerchantPendingBrowserLeaseForTests(runner);
    tabB.configureMerchantPendingBrowserLeaseForTests(runner);
    await Promise.all([
      tabA.persistMerchantPendingCommit(
        record({ index: 210, worldId: "world-a" }),
        { gameInstance: gameA },
      ),
      tabB.persistMerchantPendingCommit(
        record({ index: 211, worldId: "world-b" }),
        { gameInstance: gameB },
      ),
    ]);
    assert.equal(maxActiveWrites, 1);
    assert.equal(stored.records.length, 2);
    assert.equal(leaseState, null, "the exact lease owner releases after use");
  } finally {
    if (originalNavigator) {
      Object.defineProperty(globalThis, "navigator", originalNavigator);
    } else {
      delete globalThis.navigator;
    }
    if (originalWindow) {
      Object.defineProperty(globalThis, "window", originalWindow);
    } else {
      delete globalThis.window;
    }
  }
}

{
  const expectedFailure = new Error("client setting rejected");
  const harness = settingGame(undefined, { setError: expectedFailure });
  await assert.rejects(
    persistMerchantPendingCommit(record({ index: 5 }), {
      gameInstance: harness.gameInstance,
    }),
    (error) =>
      error.code === "MERCHANT_PENDING_WRITE_FAILED" &&
      error.cause === expectedFailure,
  );
}

{
  const harness = settingGame(undefined, {
    onGet(stored, setCalls) {
      if (setCalls === 0 || stored.records.length === 0) return stored;
      stored.records[0].context.itemName = "altered but valid";
      return stored;
    },
  });
  await assert.rejects(
    persistMerchantPendingCommit(record({ index: 6 }), {
      gameInstance: harness.gameInstance,
    }),
    (error) => error.code === "MERCHANT_PENDING_READBACK_MISMATCH",
  );
}

/* Clear is exact and failures remain unresolved --------------------- */

{
  const pending = record({ index: 70 });
  const result = terminalResult(pending, {
    ok: true,
    reason: "",
    itemName: pending.context.itemName,
    qty: pending.context.qty,
    unitGp: pending.context.unitGp,
    totalGp: pending.context.totalGp,
    sealId: null,
  });
  assert.equal(merchantPendingCommitMatchesResult(pending, result), true);
  const harness = settingGame({ version: 2, records: [pending] });
  assert.deepEqual(
    await settleMerchantPendingCommitResult(
      { ...result, requestFingerprint: "wrong" },
      { gameInstance: harness.gameInstance },
    ),
    { status: "mismatch", record: pending },
  );
  assert.equal(harness.setCalls, 0);
  const settlement = await settleMerchantPendingCommitResult(result, {
    gameInstance: harness.gameInstance,
    now: 200_000,
  });
  assert.equal(settlement.status, "terminal-outbox");
  assert.deepEqual(settlement.record, pending);
  assert.deepEqual(
    listMerchantPendingCommits({ gameInstance: harness.gameInstance }),
    [],
  );
  assert.equal(
    listMerchantPendingTerminalOutbox({ gameInstance: harness.gameInstance })
      .length,
    1,
  );
  assert.equal(
    (
      await settleMerchantPendingCommitResult(result, {
        gameInstance: harness.gameInstance,
      })
    ).status,
    "terminal-outbox",
  );
  let presented = 0;
  assert.equal(
    (
      await presentMerchantPendingTerminalOutbox(
        pending.originUserId,
        pending.commitId,
        {
          gameInstance: harness.gameInstance,
          async present(entry) {
            presented += 1;
            assert.deepEqual(entry.record, pending);
            assert.deepEqual(entry.terminal.result, result);
            return true;
          },
        },
      )
    ).status,
    "presented",
  );
  assert.equal(presented, 1);
  assert.deepEqual(harness.stored().records, []);
}

{
  const first = record({ index: 7, originUserId: "player-a" });
  const sameIdOtherUser = clone(first);
  sameIdOtherUser.originUserId = "player-b";
  sameIdOtherUser.payload.actorId = "actor-player-b";
  const harness = settingGame({
    version: 2,
    records: [first, sameIdOtherUser],
  });

  assert.equal(
    await clearMerchantPendingCommit("player-a", first.commitId, {
      gameInstance: harness.gameInstance,
    }),
    true,
  );
  assert.deepEqual(harness.stored().records, [storedPending(sameIdOtherUser)]);
  assert.equal(
    await clearMerchantPendingCommit("player-a", first.commitId, {
      gameInstance: harness.gameInstance,
    }),
    false,
  );
  assert.deepEqual(
    listMerchantPendingCommits({
      originUserId: "player-b",
      gameInstance: harness.gameInstance,
    }),
    [sameIdOtherUser],
  );
}

{
  const pending = record({ index: 8 });
  const harness = settingGame(
    { version: 2, records: [pending] },
    { setError: new Error("clear write rejected") },
  );
  await assert.rejects(
    clearMerchantPendingCommit(pending.originUserId, pending.commitId, {
      gameInstance: harness.gameInstance,
    }),
    (error) => error.code === "MERCHANT_PENDING_WRITE_FAILED",
  );
  assert.deepEqual(harness.stored().records, [pending]);
}

/* Uncertain outcomes become bounded, non-replaying review evidence. */
{
  const pending = record({ index: 80 });
  const harness = settingGame({ version: 2, records: [pending] });
  const result = terminalResult(pending, {
    reason: "transaction-history-expired",
  });
  assert.deepEqual(
    await settleMerchantPendingCommitResult(result, {
      gameInstance: harness.gameInstance,
      now: 200_000,
    }),
    {
      status: "quarantined",
      record: pending,
      review: {
        reason: "transaction-history-expired",
        receivedAt: 200_000,
      },
    },
  );
  assert.deepEqual(
    listMerchantPendingCommits({ gameInstance: harness.gameInstance }),
    [],
  );
  assert.deepEqual(
    listMerchantPendingReviews({ gameInstance: harness.gameInstance }),
    [storedReview(pending)],
  );
  let resent = 0;
  await resendMerchantPendingCommits({
    gameInstance: harness.gameInstance,
    send() {
      resent += 1;
    },
  });
  assert.equal(resent, 0, "review evidence is never replayed");
  assert.equal(
    await clearMerchantPendingReview("player-b", pending.commitId, {
      gameInstance: harness.gameInstance,
    }),
    false,
  );
  assert.equal(
    await clearMerchantPendingReview(pending.originUserId, pending.commitId, {
      gameInstance: harness.gameInstance,
    }),
    true,
  );
  assert.deepEqual(harness.stored().records, []);
}

/* An exact later success moves review evidence to the terminal outbox. */
{
  const pending = record({ index: 85 });
  const review = storedReview(pending, "transaction-needs-review", 200_010);
  const harness = settingGame({ version: 3, records: [review] });
  const terminal = terminalResult(pending, {
    ok: true,
    reason: "",
    itemName: pending.context.itemName,
    qty: pending.context.qty,
    unitGp: pending.context.unitGp,
    totalGp: pending.context.totalGp,
    sealId: null,
  });
  const mismatch = await settleMerchantPendingCommitResult(
    { ...terminal, requestFingerprint: "wrong" },
    { gameInstance: harness.gameInstance, now: 200_011 },
  );
  assert.equal(mismatch.status, "mismatch");
  assert.deepEqual(harness.stored().records, [review]);

  const settled = await settleMerchantPendingCommitResult(terminal, {
    gameInstance: harness.gameInstance,
    now: 200_012,
  });
  assert.equal(settled.status, "terminal-outbox");
  assert.deepEqual(
    listMerchantPendingReviews({ gameInstance: harness.gameInstance }),
    [],
  );
  assert.equal(
    listMerchantPendingTerminalOutbox({ gameInstance: harness.gameInstance })
      .length,
    1,
  );
}

/* A failed presenter retains the exact outbox; a confirmed retry removes it. */
{
  const pending = record({ index: 81 });
  const harness = settingGame({ version: 2, records: [pending] });
  const result = terminalResult(pending, {
    ok: true,
    reason: "",
    itemName: pending.context.itemName,
    qty: pending.context.qty,
    unitGp: pending.context.unitGp,
    totalGp: pending.context.totalGp,
    sealId: null,
  });
  await settleMerchantPendingCommitResult(result, {
    gameInstance: harness.gameInstance,
    now: 200_001,
  });
  assert.equal(
    (
      await presentMerchantPendingTerminalOutbox(
        pending.originUserId,
        pending.commitId,
        {
          gameInstance: harness.gameInstance,
          present: async () => false,
        },
      )
    ).status,
    "presentation-failed",
  );
  assert.equal(
    listMerchantPendingTerminalOutbox({ gameInstance: harness.gameInstance })
      .length,
    1,
  );
  await presentMerchantPendingTerminalOutbox(
    pending.originUserId,
    pending.commitId,
    {
      gameInstance: harness.gameInstance,
      present: async () => true,
    },
  );
  assert.deepEqual(harness.stored().records, []);
}

/* World partitions never replay, settle, or overwrite one another. */
{
  const worldA = record({ index: 9, worldId: "world-a" });
  const worldB = { ...clone(worldA), worldId: "world-b" };
  const harness = settingGame(
    { version: 2, records: [worldA, worldB] },
    { worldId: "world-a" },
  );
  const result = {
    targetUserId: worldA.originUserId,
    sessionId: worldA.payload.sessionId,
    commitId: worldA.commitId,
    side: "buy",
    ok: true,
    requestFingerprint: merchantCommitRequestFingerprint({
      type: worldA.eventType,
      originUserId: worldA.originUserId,
      ...worldA.payload,
    }),
  };

  assert.deepEqual(
    listMerchantPendingCommits({ gameInstance: harness.gameInstance }),
    [worldA],
  );
  const resent = [];
  await resendMerchantPendingCommits({
    gameInstance: harness.gameInstance,
    send(eventType, payload) {
      resent.push({ eventType, payload });
    },
  });
  assert.deepEqual(resent, [
    { eventType: worldA.eventType, payload: worldA.payload },
  ]);
  assert.deepEqual(
    await settleMerchantPendingCommitResult(result, {
      gameInstance: harness.gameInstance,
    }),
    {
      status: "terminal-outbox",
      record: worldA,
      terminal: {
        receivedAt: harness.gameInstance.time.serverTime,
        result: {
          ...result,
          reason: "",
          itemName: null,
          qty: null,
          unitGp: null,
          totalGp: null,
          sealId: null,
        },
      },
    },
  );
  await presentMerchantPendingTerminalOutbox(
    worldA.originUserId,
    worldA.commitId,
    {
      gameInstance: harness.gameInstance,
      present: async () => true,
    },
  );
  assert.deepEqual(harness.stored().records, [storedPending(worldB)]);

  harness.gameInstance.world.id = "world-b";
  assert.deepEqual(
    listMerchantPendingCommits({ gameInstance: harness.gameInstance }),
    [worldB],
  );
  assert.deepEqual(
    await settleMerchantPendingCommitResult(result, {
      gameInstance: harness.gameInstance,
    }),
    {
      status: "terminal-outbox",
      record: worldB,
      terminal: {
        receivedAt: harness.gameInstance.time.serverTime,
        result: {
          ...result,
          reason: "",
          itemName: null,
          qty: null,
          unitGp: null,
          totalGp: null,
          sealId: null,
        },
      },
    },
  );
  await presentMerchantPendingTerminalOutbox(
    worldB.originUserId,
    worldB.commitId,
    {
      gameInstance: harness.gameInstance,
      present: async () => true,
    },
  );
  assert.deepEqual(harness.stored().records, []);
}

{
  const harness = settingGame(undefined, { worldId: "world-a" });
  await assert.rejects(
    Promise.resolve().then(() =>
      persistMerchantPendingCommit(record({ index: 10, worldId: "world-b" }), {
        gameInstance: harness.gameInstance,
      }),
    ),
    (error) => error.code === "MERCHANT_PENDING_WORLD_MISMATCH",
  );
  assert.equal(harness.setCalls, 0);
  assert.deepEqual(harness.stored(), createEmptyMerchantPendingCommits());
}

{
  const legacy = record({ index: 11 });
  delete legacy.worldId;
  const harness = settingGame({ version: 1, records: [legacy] });
  let sent = false;
  await assert.rejects(
    resendMerchantPendingCommits({
      gameInstance: harness.gameInstance,
      send() {
        sent = true;
      },
    }),
    (error) => error.code === "MERCHANT_PENDING_LEGACY_UNSCOPED",
  );
  assert.equal(sent, false);
  assert.equal(harness.setCalls, 0);
  assert.deepEqual(harness.stored(), { version: 1, records: [legacy] });
}

/* The unresolved cap blocks new work; it never evicts old records --- */

{
  const full = Array.from(
    { length: MERCHANT_PENDING_MAX_RECORDS },
    (_, index) => record({ index: 100 + index }),
  );
  const harness = settingGame({ version: 2, records: full });
  await assert.rejects(
    persistMerchantPendingCommit(record({ index: 999 }), {
      gameInstance: harness.gameInstance,
    }),
    (error) => error.code === "MERCHANT_PENDING_CAP_REACHED",
  );
  assert.equal(harness.setCalls, 0);
  assert.deepEqual(harness.stored().records, full);

  await assert.rejects(
    Promise.resolve().then(() =>
      parseMerchantPendingCommits({
        version: 2,
        records: [...full, record({ index: 1000 })],
      }),
    ),
    (error) => error.code === "MERCHANT_PENDING_INVALID_SETTING",
  );
}

/* Review capacity is separate, bounded, and never silently evicted. */
{
  const reviews = Array.from(
    { length: MERCHANT_PENDING_MAX_REVIEW_RECORDS },
    (_, index) =>
      storedReview(record({ index: 300 + index }), undefined, 300_000 + index),
  );
  const pending = record({ index: 899 });
  const harness = settingGame({
    version: 3,
    records: [...reviews, storedPending(pending)],
  });
  await assert.rejects(
    settleMerchantPendingCommitResult(
      terminalResult(pending, { reason: "transaction-history-expired" }),
      { gameInstance: harness.gameInstance, now: 400_000 },
    ),
    (error) => error.code === "MERCHANT_PENDING_REVIEW_CAP_REACHED",
  );
  assert.deepEqual(harness.stored().records, [
    ...reviews,
    storedPending(pending),
  ]);
  assert.deepEqual(
    listMerchantPendingCommits({ gameInstance: harness.gameInstance }),
    [pending],
    "a full review store leaves the unresolved request intact",
  );
}

console.log("Merchant client pending persistence checks passed.");
