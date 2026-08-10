#!/usr/bin/env node

import assert from "node:assert/strict";
import { createMerchantTransactionCoordinator } from "./merchant/transaction-coordinator.js";
import {
  addMerchantTransactionRecord,
  createMerchantTransactionLedger,
  formatMerchantCommitId,
  lookupMerchantTransactionReplay,
  planMerchantBuyTransaction,
  transitionMerchantTransaction,
} from "./merchant/transaction-ledger.js";

function commit(index) {
  return formatMerchantCommitId(
    2000 + index,
    index.toString(16).padStart(32, "0"),
  );
}

function wallet(gp) {
  return { pp: 0, gp, ep: 0, sp: 0, cp: 0 };
}

function actorItem(id) {
  return {
    _id: id,
    name: "Iron Ration",
    type: "consumable",
    system: { quantity: 1 },
    flags: {},
  };
}

function merchant(id, { qty = 2, gold = 5 } = {}) {
  return {
    id,
    name: `Merchant ${id}`,
    goldOnHand: gold,
    items: [{ uuid: `Compendium.test.${id}`, qty, unlimited: false }],
  };
}

function buyPlan(index = 1, overrides = {}) {
  const originUserId = overrides.originUserId ?? "player-1";
  const actorId = overrides.actorId ?? `actor-${index}`;
  const merchantId = overrides.merchantId ?? `merchant-${index}`;
  const itemId = overrides.itemId ?? `purchased-${index}`;
  const beforeMerchant =
    overrides.merchantBefore ?? merchant(merchantId, { qty: 2, gold: 5 });
  const afterMerchant =
    overrides.merchantAfter ?? merchant(merchantId, { qty: 1, gold: 6 });
  return planMerchantBuyTransaction({
    originUserId,
    commitId: overrides.commitId ?? commit(index),
    requestFingerprint: overrides.requestFingerprint ?? `fingerprint-${index}`,
    request: {
      sessionId: `session-${index}`,
      actorId,
      merchantId,
      itemUuid: `Compendium.test.${merchantId}`,
      qty: 1,
      unitGp: 1,
      totalGp: 1,
      sealId: null,
    },
    actor: {
      actorId,
      itemId,
      before: { wallet: wallet(10), item: null },
      after: { wallet: wallet(9), item: actorItem(itemId) },
    },
    merchant: {
      merchantId,
      before: beforeMerchant,
      after: afterMerchant,
    },
    itemName: "Iron Ration",
  });
}

function minimalPlan(index, { originUserId = `origin-${index}` } = {}) {
  const actorId = `minimal-actor-${index}`;
  const merchantId = `minimal-merchant-${index}`;
  const itemId = `minimal-item-${index}`;
  return planMerchantBuyTransaction({
    originUserId,
    commitId: commit(index),
    requestFingerprint: `minimal-fingerprint-${index}`,
    request: {
      sessionId: `minimal-session-${index}`,
      actorId,
      merchantId,
      itemUuid: `minimal-uuid-${index}`,
      qty: 1,
      unitGp: 1,
      totalGp: 1,
      sealId: null,
    },
    actor: {
      actorId,
      itemId,
      before: { wallet: wallet(2), item: null },
      after: { wallet: wallet(1), item: { _id: itemId } },
    },
    merchant: {
      merchantId,
      before: { id: merchantId },
      after: { id: merchantId },
    },
    itemName: "Item",
  });
}

function terminal(record, timestamp = 9000) {
  const actor = transitionMerchantTransaction(record, "actor-applied", {
    updatedAt: timestamp,
  });
  const shop = transitionMerchantTransaction(actor, "merchant-applied", {
    updatedAt: timestamp + 1,
  });
  return transitionMerchantTransaction(shop, "terminal", {
    updatedAt: timestamp + 2,
  });
}

function stable(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  return `{${Object.keys(value)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stable(value[key])}`)
    .join(",")}}`;
}

function equal(left, right) {
  return stable(left) === stable(right);
}

function makeHarness({
  terminalCap = 250,
  maxRecords = 5000,
  maxUnresolvedPerOrigin = 25,
} = {}) {
  const state = {
    merchants: [],
    merchantTransactions: createMerchantTransactionLedger(),
  };
  const actors = new Map();
  const privateWrites = [];
  const actorWrites = [];
  const mutexEntries = [];
  const heldMutexes = new Set();
  const mutexChains = new Map();
  const privateSubscribers = new Set();
  const authoritySubscribers = new Set();
  const faults = {
    crashAfterItem: false,
    crashAfterWallet: false,
    loseAuthorityAfterItem: false,
    merchantEditAfterItem: false,
    beforeNextPrivateMutation: null,
    throwAfterNextPrivateWrite: false,
  };
  let ready = true;
  let authoritative = true;
  let tabLeader = true;
  let tokenCounter = 0;
  let epochCounter = 0;
  let clock = 10000;

  function clone(value) {
    return structuredClone(value);
  }

  function getPrivateState(key) {
    return clone(state[key]);
  }

  async function updatePrivate(mutation, { authorizeWrite } = {}) {
    const before = clone(state);
    const beforeMutation = faults.beforeNextPrivateMutation;
    faults.beforeNextPrivateMutation = null;
    await beforeMutation?.();
    const proposal = await mutation({
      merchants: clone(state.merchants),
      merchantTransactions: clone(state.merchantTransactions),
    });
    if (proposal == null) return null;
    if (authorizeWrite?.() !== true)
      throw new Error("MerchantWriteAuthorityLost");
    state.merchants = clone(proposal.merchants);
    state.merchantTransactions = clone(proposal.merchantTransactions);
    const after = clone(state);
    privateWrites.push({ before, after });
    for (const callback of privateSubscribers) {
      callback({
        keys: ["merchants", "merchantTransactions"],
        reason: "local-write",
      });
    }
    if (faults.throwAfterNextPrivateWrite) {
      faults.throwAfterNextPrivateWrite = false;
      throw new Error("SimulatedPrivateWriteAcknowledgementFailure");
    }
    if (authorizeWrite?.() !== true)
      throw new Error("MerchantWriteAuthorityLost");
    return {
      merchants: clone(state.merchants),
      merchantTransactions: clone(state.merchantTransactions),
      result: proposal.result,
    };
  }

  function readActorBoundary(actor, itemId) {
    if (!actor || actor.id == null) {
      return { ok: false, reason: "no-actor", boundary: null };
    }
    if (actor.itemId !== itemId) {
      return { ok: false, reason: "actor-read-unconfirmed", boundary: null };
    }
    return {
      ok: true,
      reason: "",
      actorId: actor.id,
      itemId,
      boundary: clone(actor.boundary),
    };
  }

  async function applyActorPlan(actor, plan, { authorizeWrite } = {}) {
    const writes = [];
    const itemState = equal(actor.boundary.item, plan.before.item)
      ? "before"
      : equal(actor.boundary.item, plan.after.item)
        ? "after"
        : "third-state";
    const walletState = equal(actor.boundary.wallet, plan.before.wallet)
      ? "before"
      : equal(actor.boundary.wallet, plan.after.wallet)
        ? "after"
        : "third-state";
    if (itemState === "third-state" || walletState === "third-state") {
      return {
        ok: false,
        action: "needs-review",
        reason: "third-state",
        itemState,
        walletState,
        writes,
      };
    }
    if (itemState === "before") {
      if (authorizeWrite?.() !== true) {
        return { action: "reconcile", reason: "authority-lost", writes };
      }
      actor.boundary.item = clone(plan.after.item);
      writes.push("item");
      actorWrites.push({ actorId: actor.id, component: "item" });
      if (faults.crashAfterItem) {
        faults.crashAfterItem = false;
        throw new Error("SimulatedActorCrashAfterItem");
      }
      if (faults.loseAuthorityAfterItem) {
        faults.loseAuthorityAfterItem = false;
        authoritative = false;
        for (const callback of authoritySubscribers) callback();
      }
      if (faults.merchantEditAfterItem) {
        faults.merchantEditAfterItem = false;
        state.merchants[0].goldOnHand += 50;
        for (const callback of privateSubscribers) {
          callback({ keys: ["merchants"], reason: "journal-update" });
        }
      }
    }
    if (equal(actor.boundary.wallet, plan.before.wallet)) {
      if (authorizeWrite?.() !== true) {
        return {
          action: "reconcile",
          reason: "authority-lost",
          writes,
          itemState: "after",
          walletState: "before",
        };
      }
      actor.boundary.wallet = clone(plan.after.wallet);
      writes.push("wallet");
      actorWrites.push({ actorId: actor.id, component: "wallet" });
      if (faults.crashAfterWallet) {
        faults.crashAfterWallet = false;
        throw new Error("SimulatedActorCrashAfterWallet");
      }
    }
    return {
      ok: true,
      action: "applied",
      reason: "",
      itemState: "after",
      walletState: "after",
      boundary: clone(actor.boundary),
      writes,
    };
  }

  async function runMutex(merchantId, actorId, operation) {
    const key = `${merchantId}:${actorId}`;
    const previous = mutexChains.get(key) ?? Promise.resolve();
    let release;
    const gate = new Promise((resolve) => {
      release = resolve;
    });
    const tail = previous.then(() => gate);
    mutexChains.set(key, tail);
    await previous;
    assert.equal(heldMutexes.has(key), false, `nested mutex for ${key}`);
    heldMutexes.add(key);
    mutexEntries.push(key);
    try {
      return await operation();
    } finally {
      heldMutexes.delete(key);
      release();
      if (mutexChains.get(key) === tail) mutexChains.delete(key);
    }
  }

  const bindings = {
    getPrivateState,
    isPrivateReady: () => ready,
    updateMerchantPrivateState: updatePrivate,
    authoritativeGMId: () => (authoritative ? "gm-1" : null),
    isAuthoritativeGM: () => authoritative,
    ensureTabLeadership: async () => tabLeader,
    hasTabLeadership: () => tabLeader,
    currentUserId: () => "gm-1",
    createAuthorityEpoch: () => `epoch-${++epochCounter}`,
    createWriteToken: () => `token-${++tokenCounter}`,
    resolveActor: (actorId) => actors.get(actorId) ?? null,
    readActorBoundary,
    applyActorPlan,
    runWithMerchantActorMutex: runMutex,
    subscribePrivateState(callback) {
      privateSubscribers.add(callback);
      return () => privateSubscribers.delete(callback);
    },
    subscribeAuthority(callback) {
      authoritySubscribers.add(callback);
      return () => authoritySubscribers.delete(callback);
    },
    now: () => ++clock,
    terminalCap,
    maxRecords,
    maxUnresolvedPerOrigin,
    logError: () => {},
  };
  const coordinator = createMerchantTransactionCoordinator(bindings);

  return {
    coordinator,
    bindings,
    state,
    actors,
    privateWrites,
    actorWrites,
    mutexEntries,
    faults,
    setReady(value) {
      ready = value;
    },
    setAuthoritative(value) {
      authoritative = value;
    },
    setTabLeader(value) {
      tabLeader = value;
    },
    addPlanState(plan) {
      if (
        !state.merchants.some((entry) => entry.id === plan.merchant.merchantId)
      ) {
        state.merchants.push(clone(plan.merchant.before));
      }
      if (!actors.has(plan.actor.actorId)) {
        actors.set(plan.actor.actorId, {
          id: plan.actor.actorId,
          itemId: plan.actor.itemId,
          boundary: clone(plan.actor.before),
        });
      }
    },
    seedRecord(record) {
      state.merchantTransactions = addMerchantTransactionRecord(
        state.merchantTransactions,
        record,
      );
    },
    triggerPrivate(reason = "journal-update") {
      for (const callback of privateSubscribers) {
        callback({ keys: ["merchantTransactions"], reason });
      }
    },
    runMutex,
  };
}

/* Feature teardown must not release shared campaign leadership. */
{
  const harness = makeHarness();
  await harness.coordinator.register();
  assert.equal(harness.coordinator.unregister(), true);
  assert.equal(
    (await harness.coordinator.register()).status,
    "reconciled",
    "Merchant teardown left the shared campaign leader intact",
  );
}

/* A same-user follower tab cannot claim or write; leadership can hand off. */
{
  const harness = makeHarness();
  const plan = buyPlan(25);
  harness.addPlanState(plan);
  harness.setTabLeader(false);
  assert.equal((await harness.coordinator.register()).status, "authority-lost");
  assert.equal(
    (await harness.coordinator.submit(plan)).status,
    "authority-lost",
  );
  assert.equal(harness.privateWrites.length, 0);
  assert.equal(harness.actorWrites.length, 0);

  harness.setTabLeader(true);
  assert.equal((await harness.coordinator.register()).status, "reconciled");
  assert.equal((await harness.coordinator.submit(plan)).status, "terminal");
}

/* A merchant-only edit invalidates the Actor fence before the next component. */
{
  const harness = makeHarness();
  const plan = buyPlan(24);
  harness.addPlanState(plan);
  await harness.coordinator.register();
  harness.faults.merchantEditAfterItem = true;
  const result = await harness.coordinator.submit(plan);
  assert.equal(result.status, "authority-lost");
  assert.deepEqual(
    harness.actorWrites.map((write) => write.component),
    ["item"],
  );
  assert.equal(
    harness.state.merchants[0].goldOnHand,
    plan.merchant.before.goldOnHand + 50,
    "coordinator did not overwrite the competing merchant edit",
  );
}

/* Full drive: Actor first, atomic Merchant+marker, terminal replay. */
{
  const harness = makeHarness();
  const plan = buyPlan(1);
  harness.addPlanState(plan);
  assert.equal((await harness.coordinator.register()).status, "reconciled");
  assert.equal(harness.state.merchantTransactions.authorityId, "gm-1");
  assert.match(
    harness.state.merchantTransactions.authorityEpoch,
    /^epoch-\d+$/,
  );
  assert.match(harness.state.merchantTransactions.writeToken, /^token-\d+$/);
  const baselineWrites = harness.privateWrites.length;
  const result = await harness.coordinator.submit(plan);
  assert.equal(result.status, "terminal");
  assert.deepEqual(result.result, terminal(plan).result);
  assert.deepEqual(
    harness.actorWrites.map((write) => write.component),
    ["item", "wallet"],
  );
  assert.deepEqual(
    harness.actors.get(plan.actor.actorId).boundary,
    plan.actor.after,
  );
  assert.deepEqual(harness.state.merchants[0], plan.merchant.after);
  const transactionWrites = harness.privateWrites.slice(baselineWrites);
  assert.equal(transactionWrites.length, 4);
  const atomic = transactionWrites.find((write) => {
    const replay = lookupMerchantTransactionReplay(
      write.after.merchantTransactions,
      plan,
    );
    return replay.record?.stage === "merchant-applied";
  });
  assert.ok(atomic, "merchant-applied checkpoint was persisted");
  assert.deepEqual(atomic.after.merchants[0], plan.merchant.after);

  const beforeReplay = harness.privateWrites.length;
  const replay = await harness.coordinator.submit(plan);
  assert.equal(replay.status, "terminal");
  assert.deepEqual(replay.result, result.result);
  assert.equal(
    harness.privateWrites.length,
    beforeReplay,
    "replay performs no write",
  );
}

/* Canonical readback wins when both Actor writes apply before an exception. */
{
  const harness = makeHarness();
  const plan = buyPlan(23);
  harness.addPlanState(plan);
  await harness.coordinator.register();
  harness.faults.crashAfterWallet = true;
  const recovered = await harness.coordinator.submit(plan);
  assert.equal(recovered.status, "terminal");
  assert.deepEqual(
    harness.actors.get(plan.actor.actorId).boundary,
    plan.actor.after,
  );
  assert.deepEqual(
    harness.actorWrites.map((write) => write.component),
    ["item", "wallet"],
    "recovery trusted exact canonical after state and did not rewrite Actor",
  );
}

/* Crash after item application resumes only the missing wallet component. */
{
  const harness = makeHarness();
  const plan = buyPlan(2);
  harness.addPlanState(plan);
  await harness.coordinator.register();
  harness.faults.crashAfterItem = true;
  const interrupted = await harness.coordinator.submit(plan);
  assert.equal(interrupted.status, "pending");
  assert.equal(
    lookupMerchantTransactionReplay(harness.state.merchantTransactions, plan)
      .record.stage,
    "prepared",
  );
  assert.deepEqual(
    harness.actorWrites.map((write) => write.component),
    ["item"],
  );
  const recovered = await harness.coordinator.drive(plan);
  assert.equal(recovered.status, "terminal");
  assert.deepEqual(
    harness.actorWrites.map((write) => write.component),
    ["item", "wallet"],
  );
}

/* Stored work recovers without a session and across every durable marker lag. */
{
  const harness = makeHarness();
  const plan = buyPlan(3);
  harness.addPlanState(plan);
  await harness.coordinator.register();
  harness.seedRecord(plan);
  harness.actors.get(plan.actor.actorId).boundary = structuredClone(
    plan.actor.after,
  );
  harness.state.merchants[0] = structuredClone(plan.merchant.after);
  const recovered = await harness.coordinator.reconcilePending();
  assert.equal(recovered.status, "reconciled");
  assert.equal(recovered.results[0].status, "terminal");
  assert.equal(
    harness.actorWrites.length,
    0,
    "no session or Actor rewrite needed",
  );
}

/* Authority loss between Actor components stops wallet and private progression. */
{
  const harness = makeHarness();
  const plan = buyPlan(4);
  harness.addPlanState(plan);
  await harness.coordinator.register();
  harness.faults.loseAuthorityAfterItem = true;
  const before = harness.privateWrites.length;
  const result = await harness.coordinator.submit(plan);
  assert.equal(result.status, "authority-lost");
  assert.deepEqual(
    harness.actorWrites.map((write) => write.component),
    ["item"],
  );
  assert.equal(
    harness.privateWrites.length,
    before + 1,
    "only prepared persisted",
  );
  assert.deepEqual(harness.state.merchants[0], plan.merchant.before);
  assert.equal(
    lookupMerchantTransactionReplay(harness.state.merchantTransactions, plan)
      .record.stage,
    "prepared",
  );
}

/* A third Actor state remains pinned and zero-write until an exact recheck. */
{
  const harness = makeHarness();
  const plan = buyPlan(5);
  harness.addPlanState(plan);
  await harness.coordinator.register();
  harness.seedRecord(plan);
  harness.actors.get(plan.actor.actorId).boundary.wallet = wallet(77);
  const quarantined = await harness.coordinator.drive(plan);
  assert.equal(quarantined.status, "needs-review");
  assert.equal(quarantined.record.stage, "needs-review");
  assert.equal(quarantined.pinned, true);
  const writesAfterQuarantine = harness.privateWrites.length;
  const reviewWhileThird = await harness.coordinator.recheck(plan);
  assert.equal(reviewWhileThird.status, "needs-review");
  assert.equal(reviewWhileThird.manualCorrectionRequired, true);
  assert.match(
    reviewWhileThird.guidance,
    /Do not reset, delete, or force-complete/,
  );
  assert.equal(harness.privateWrites.length, writesAfterQuarantine);
  assert.equal(harness.actorWrites.length, 0);

  harness.actors.get(plan.actor.actorId).boundary = structuredClone(
    plan.actor.before,
  );
  const stillPinned = await harness.coordinator.drive(plan);
  assert.equal(stillPinned.status, "needs-review");
  assert.equal(stillPinned.record.stage, "needs-review");
  assert.equal(harness.privateWrites.length, writesAfterQuarantine);
  assert.equal(harness.actorWrites.length, 0);

  const recovered = await harness.coordinator.recheck(plan);
  assert.equal(recovered.status, "terminal");
  assert.deepEqual(
    harness.actors.get(plan.actor.actorId).boundary,
    plan.actor.after,
  );
  assert.deepEqual(harness.state.merchants[0], plan.merchant.after);
}

/* Rechecks fail closed on stale canonical data or lost authority. */
{
  const stale = makeHarness();
  const plan = buyPlan(26);
  stale.addPlanState(plan);
  await stale.coordinator.register();
  const review = transitionMerchantTransaction(plan, "needs-review", {
    updatedAt: 12000,
    reason: "canonical-state-mismatch",
    actorState: "third-state",
    merchantState: "before",
  });
  stale.seedRecord(review);
  const beforeStale = stale.privateWrites.length;
  stale.faults.beforeNextPrivateMutation = () => {
    stale.actors.get(plan.actor.actorId).boundary.wallet = wallet(77);
  };
  const changed = await stale.coordinator.recheck(review);
  assert.equal(changed.status, "needs-review");
  assert.equal(changed.record.stage, "needs-review");
  assert.equal(stale.privateWrites.length, beforeStale);
  assert.equal(stale.actorWrites.length, 0);
  assert.deepEqual(stale.state.merchants[0], plan.merchant.before);

  stale.actors.get(plan.actor.actorId).boundary = structuredClone(
    plan.actor.before,
  );
  stale.setAuthoritative(false);
  const beforeAuthority = stale.privateWrites.length;
  const lost = await stale.coordinator.recheck(review);
  assert.equal(lost.status, "authority-lost");
  assert.equal(stale.privateWrites.length, beforeAuthority);
  assert.equal(stale.actorWrites.length, 0);
}

/* Authority reconciliation also attempts an exact safe pinned recovery. */
{
  const harness = makeHarness();
  const plan = buyPlan(27);
  harness.addPlanState(plan);
  harness.seedRecord(
    transitionMerchantTransaction(plan, "needs-review", {
      updatedAt: 12000,
      reason: "canonical-state-mismatch",
      actorState: "third-state",
      merchantState: "before",
    }),
  );
  const reconciled = await harness.coordinator.register();
  assert.equal(reconciled.status, "reconciled");
  assert.equal(reconciled.results[0].status, "terminal");
  assert.deepEqual(
    harness.actors.get(plan.actor.actorId).boundary,
    plan.actor.after,
  );
  assert.deepEqual(harness.state.merchants[0], plan.merchant.after);
}

/* Fresh mismatch, unresolved collision, and per-origin cap are zero-write blocks. */
{
  const mismatch = makeHarness();
  const plan = buyPlan(6);
  mismatch.addPlanState(plan);
  mismatch.state.merchants[0].goldOnHand = 99;
  await mismatch.coordinator.register();
  const before = mismatch.privateWrites.length;
  const result = await mismatch.coordinator.persistPrepared(plan);
  assert.equal(result.status, "needs-review");
  assert.equal(result.reason, "merchant-before-mismatch");
  assert.equal(mismatch.privateWrites.length, before);

  const collision = makeHarness();
  const first = buyPlan(7, { actorId: "shared-actor" });
  const second = buyPlan(8, { actorId: "shared-actor" });
  collision.addPlanState(first);
  collision.addPlanState(second);
  await collision.coordinator.register();
  collision.seedRecord(first);
  const collisionWrites = collision.privateWrites.length;
  const blocked = await collision.coordinator.persistPrepared(second);
  assert.equal(blocked.status, "blocked");
  assert.equal(blocked.reason, "unresolved-transaction-collision");
  assert.equal(collision.privateWrites.length, collisionWrites);

  const capped = makeHarness({ maxUnresolvedPerOrigin: 1 });
  const capFirst = buyPlan(9, {
    originUserId: "capped-player",
    actorId: "cap-actor-1",
    merchantId: "cap-merchant-1",
  });
  const capSecond = buyPlan(10, {
    originUserId: "capped-player",
    actorId: "cap-actor-2",
    merchantId: "cap-merchant-2",
  });
  capped.addPlanState(capFirst);
  capped.addPlanState(capSecond);
  await capped.coordinator.register();
  capped.seedRecord(capFirst);
  const capWrites = capped.privateWrites.length;
  const atCap = await capped.coordinator.persistPrepared(capSecond);
  assert.equal(atCap.status, "blocked");
  assert.equal(atCap.reason, "unresolved-origin-cap");
  assert.equal(capped.privateWrites.length, capWrites);
}

/* Concurrent duplicate preparation persists exactly one prepared record. */
{
  const harness = makeHarness();
  const plan = buyPlan(11);
  harness.addPlanState(plan);
  await harness.coordinator.register();
  const before = harness.privateWrites.length;
  const results = await Promise.all([
    harness.coordinator.persistPrepared(plan),
    harness.coordinator.persistPrepared(plan),
  ]);
  assert.ok(
    results.every((result) => ["prepared", "pending"].includes(result.status)),
  );
  assert.equal(harness.privateWrites.length, before + 1);
  assert.equal(harness.state.merchantTransactions.records.length, 1);
}

/* Lock-aware APIs do not recursively acquire the merchant/actor mutex. */
{
  const harness = makeHarness();
  const plan = buyPlan(12);
  harness.addPlanState(plan);
  await harness.coordinator.register();
  const result = await harness.runMutex(
    plan.merchant.merchantId,
    plan.actor.actorId,
    () => harness.coordinator.persistPreparedLocked(plan),
  );
  assert.equal(result.status, "prepared");

  const builderHarness = makeHarness();
  const built = buyPlan(13);
  builderHarness.addPlanState(built);
  await builderHarness.coordinator.register();
  const builtResult = await builderHarness.coordinator.persistPreparedWithLock({
    merchantId: built.merchant.merchantId,
    actorId: built.actor.actorId,
    buildRecord: async () => built,
  });
  assert.equal(builtResult.status, "prepared");

  const replayHarness = makeHarness();
  const replay = buyPlan(14);
  replayHarness.addPlanState(replay);
  await replayHarness.coordinator.register();
  replayHarness.seedRecord(replay);
  const replayResult = await replayHarness.runMutex(
    replay.merchant.merchantId,
    replay.actor.actorId,
    () => replayHarness.coordinator.drivePendingLocked(replay),
  );
  assert.equal(replayResult.status, "terminal");
  assert.deepEqual(
    replayHarness.actors.get(replay.actor.actorId).boundary,
    replay.actor.after,
  );
}

/* Prepared persistence and its first drive retain one caller-owned lock. */
{
  const harness = makeHarness();
  const plan = buyPlan(28);
  harness.addPlanState(plan);
  await harness.coordinator.register();

  let releasePreparedWrite;
  const preparedWriteGate = new Promise((resolve) => {
    releasePreparedWrite = resolve;
  });
  let preparedWriteStarted;
  const preparedWriteSignal = new Promise((resolve) => {
    preparedWriteStarted = resolve;
  });
  harness.faults.beforeNextPrivateMutation = async () => {
    preparedWriteStarted();
    await preparedWriteGate;
  };

  const transaction = harness.runMutex(
    plan.merchant.merchantId,
    plan.actor.actorId,
    () => harness.coordinator.persistPreparedAndDriveLocked(plan),
  );
  await preparedWriteSignal;

  let externalObservedActor = null;
  const externalMutation = harness.runMutex(
    plan.merchant.merchantId,
    plan.actor.actorId,
    () => {
      externalObservedActor = structuredClone(
        harness.actors.get(plan.actor.actorId).boundary,
      );
      harness.state.merchants[0].goldOnHand += 50;
    },
  );
  releasePreparedWrite();

  const result = await transaction;
  await externalMutation;
  assert.equal(result.status, "terminal");
  assert.deepEqual(externalObservedActor, plan.actor.after);
  assert.deepEqual(
    harness.actorWrites.map((write) => write.component),
    ["item", "wallet"],
  );
  assert.equal(
    harness.mutexEntries.filter(
      (entry) => entry === `${plan.merchant.merchantId}:${plan.actor.actorId}`,
    ).length,
    2,
    "transaction and queued external edit each acquired the mutex once",
  );
}

/* The atomic locked API drives canonical pending work and replays terminals. */
{
  const harness = makeHarness();
  const plan = buyPlan(29);
  harness.addPlanState(plan);
  await harness.coordinator.register();
  harness.seedRecord(plan);

  const recovered = await harness.runMutex(
    plan.merchant.merchantId,
    plan.actor.actorId,
    () => harness.coordinator.persistPreparedAndDriveLocked(plan),
  );
  assert.equal(recovered.status, "terminal");
  assert.deepEqual(harness.state.merchants[0], plan.merchant.after);
  const writesAfterRecovery = harness.privateWrites.length;
  const actorWritesAfterRecovery = harness.actorWrites.length;

  const replay = await harness.runMutex(
    plan.merchant.merchantId,
    plan.actor.actorId,
    () => harness.coordinator.persistPreparedAndDriveLocked(plan),
  );
  assert.equal(replay.status, "terminal");
  assert.deepEqual(replay.result, recovered.result);
  assert.equal(harness.privateWrites.length, writesAfterRecovery);
  assert.equal(harness.actorWrites.length, actorWritesAfterRecovery);
}

/* An ambiguous prepared write waits for an exact retry before Actor writes. */
{
  const harness = makeHarness();
  const plan = buyPlan(30);
  harness.addPlanState(plan);
  await harness.coordinator.register();
  harness.faults.throwAfterNextPrivateWrite = true;

  const interrupted = await harness.runMutex(
    plan.merchant.merchantId,
    plan.actor.actorId,
    () => harness.coordinator.persistPreparedAndDriveLocked(plan),
  );
  assert.equal(interrupted.status, "error");
  assert.equal(harness.actorWrites.length, 0);
  assert.equal(
    lookupMerchantTransactionReplay(harness.state.merchantTransactions, plan)
      .status,
    "pending",
  );

  const recovered = await harness.runMutex(
    plan.merchant.merchantId,
    plan.actor.actorId,
    () => harness.coordinator.persistPreparedAndDriveLocked(plan),
  );
  assert.equal(recovered.status, "terminal");
  assert.deepEqual(
    harness.actorWrites.map((write) => write.component),
    ["item", "wallet"],
  );
}

/* Reconciliation compacts terminal receipts while local hooks do not recurse. */
{
  const harness = makeHarness({ terminalCap: 1 });
  await harness.coordinator.register();
  const baseline = harness.privateWrites.length;
  const records = [buyPlan(20), buyPlan(21), buyPlan(22)].map((record) =>
    terminal(record, 12000 + Number(record.commitId.length)),
  );
  for (const record of records) harness.seedRecord(record);
  const reconciled = await harness.coordinator.reconcilePending();
  assert.equal(reconciled.status, "reconciled");
  assert.equal(harness.state.merchantTransactions.records.length, 1);
  assert.equal(harness.state.merchantTransactions.replayFloors.length, 1);
  assert.equal(harness.privateWrites.length, baseline + 1);

  const beforeHooks = harness.privateWrites.length;
  harness.triggerPrivate();
  harness.triggerPrivate();
  await harness.coordinator.schedule();
  assert.equal(harness.privateWrites.length, beforeHooks);
}

/* Exact global capacity reserves a slot from terminals or blocks on pinned work. */
{
  const removable = makeHarness({
    terminalCap: 5000,
    maxRecords: 5000,
  });
  await removable.coordinator.register();
  const terminalRecords = [];
  for (let index = 1000; index < 6000; index += 1) {
    terminalRecords.push(
      terminal(
        minimalPlan(index, { originUserId: "receipt-owner" }),
        20000 + index,
      ),
    );
  }
  removable.state.merchantTransactions = createMerchantTransactionLedger({
    ...removable.state.merchantTransactions,
    records: terminalRecords,
  });
  const fresh = minimalPlan(6000, { originUserId: "receipt-owner" });
  removable.state.merchants.push(structuredClone(fresh.merchant.before));
  removable.actors.set(fresh.actor.actorId, {
    id: fresh.actor.actorId,
    itemId: fresh.actor.itemId,
    boundary: structuredClone(fresh.actor.before),
  });
  const admitted = await removable.coordinator.persistPrepared(fresh);
  assert.equal(admitted.status, "prepared");
  assert.equal(removable.state.merchantTransactions.records.length, 5000);
  assert.equal(
    lookupMerchantTransactionReplay(removable.state.merchantTransactions, fresh)
      .status,
    "pending",
  );
  assert.equal(removable.state.merchantTransactions.replayFloors.length, 1);

  const pinned = makeHarness({
    terminalCap: 5000,
    maxRecords: 5000,
    maxUnresolvedPerOrigin: 6000,
  });
  await pinned.coordinator.register();
  const unresolved = [];
  for (let index = 7000; index < 12000; index += 1) {
    unresolved.push(minimalPlan(index));
  }
  pinned.state.merchantTransactions = createMerchantTransactionLedger({
    ...pinned.state.merchantTransactions,
    records: unresolved,
  });
  const blockedPlan = minimalPlan(12000);
  pinned.state.merchants.push(structuredClone(blockedPlan.merchant.before));
  pinned.actors.set(blockedPlan.actor.actorId, {
    id: blockedPlan.actor.actorId,
    itemId: blockedPlan.actor.itemId,
    boundary: structuredClone(blockedPlan.actor.before),
  });
  const beforeBlocked = structuredClone(pinned.state.merchantTransactions);
  const blocked = await pinned.coordinator.persistPrepared(blockedPlan);
  assert.equal(blocked.status, "blocked");
  assert.equal(blocked.reason, "ledger-capacity");
  assert.deepEqual(pinned.state.merchantTransactions, beforeBlocked);
}

process.stdout.write("merchant-transaction-coordinator validation passed\n");
