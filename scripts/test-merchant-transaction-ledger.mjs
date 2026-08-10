#!/usr/bin/env node

import assert from "node:assert/strict";
import {
  MERCHANT_TRANSACTION_LEDGER_VERSION,
  MerchantTransactionLedgerError,
  addMerchantTransactionRecord,
  buildMerchantTransactionKey,
  canTransitionMerchantTransaction,
  classifyMerchantTransactionReconciliation,
  classifyMerchantTransactionReviewRecovery,
  compactMerchantTransactionLedger,
  compareMerchantCommitIds,
  createMerchantTransactionLedger,
  findMerchantTransactionRecord,
  formatMerchantCommitId,
  isPinnedMerchantTransaction,
  lookupMerchantTransactionReplay,
  merchantCommitRequestFingerprint,
  normalizeMerchantTransactionLedger,
  normalizeMerchantTransactionRecord,
  parseMerchantCommitId,
  planMerchantBuyTransaction,
  planMerchantSellTransaction,
  projectTerminalMerchantCommitResult,
  recoverMerchantTransactionFromReview,
  replaceMerchantTransactionRecord,
  replaceRecoveredMerchantTransactionRecord,
  transitionMerchantTransaction,
} from "./merchant/transaction-ledger.js";

function commit(index, timestamp = 1000 + index) {
  return formatMerchantCommitId(
    timestamp,
    index.toString(16).padStart(32, "0"),
  );
}

function wallet(gp) {
  return { pp: 0, gp, ep: 0, sp: 0, cp: 0 };
}

function item(id, quantity = 1) {
  return {
    _id: id,
    name: "Iron Ration",
    type: "consumable",
    system: { quantity, price: { value: 1, denomination: "gp" } },
    flags: {},
  };
}

function merchant(id, { gold = 10, qty = 3, unlimited = false } = {}) {
  return {
    id,
    name: "Quartermaster",
    goldOnHand: gold,
    items: [{ uuid: "Compendium.test.ration", qty, unlimited }],
  };
}

function planBuy(index = 1, overrides = {}) {
  const actorId = overrides.actorId ?? "actor-1";
  const merchantId = overrides.merchantId ?? "merchant-1";
  const itemId = overrides.itemId ?? `merchant-item-${index}`;
  const beforeMerchant =
    overrides.merchantBefore ?? merchant(merchantId, { gold: 10, qty: 3 });
  const afterMerchant =
    overrides.merchantAfter ?? merchant(merchantId, { gold: 11, qty: 2 });
  return planMerchantBuyTransaction({
    originUserId: overrides.originUserId ?? "player-1",
    commitId: overrides.commitId ?? commit(index),
    requestFingerprint:
      overrides.requestFingerprint ?? `buy-fingerprint-${index}`,
    createdAt: overrides.createdAt,
    request: {
      sessionId: "session-1",
      actorId,
      merchantId,
      itemUuid: "Compendium.test.ration",
      qty: 1,
      unitGp: 1,
      totalGp: 1,
      sealId: null,
      ...overrides.request,
    },
    actor: {
      actorId,
      itemId,
      before: { wallet: wallet(20), item: null },
      after: { wallet: wallet(19), item: item(itemId) },
      ...overrides.actor,
    },
    merchant: {
      merchantId,
      before: beforeMerchant,
      after: afterMerchant,
      ...overrides.merchant,
    },
    itemName: overrides.itemName ?? "Iron Ration",
  });
}

function planSell(index = 2, overrides = {}) {
  const actorId = overrides.actorId ?? "actor-1";
  const merchantId = overrides.merchantId ?? "merchant-1";
  const itemId = overrides.itemId ?? "owned-rations";
  return planMerchantSellTransaction({
    originUserId: overrides.originUserId ?? "player-1",
    commitId: overrides.commitId ?? commit(index),
    requestFingerprint:
      overrides.requestFingerprint ?? `sell-fingerprint-${index}`,
    request: {
      sessionId: "session-1",
      actorId,
      merchantId,
      itemUuid: itemId,
      qty: 1,
      unitGp: 1,
      totalGp: 1,
      sealId: "seal-1",
      ...overrides.request,
    },
    actor: {
      actorId,
      itemId,
      before: { wallet: wallet(20), item: item(itemId, 2) },
      after: { wallet: wallet(21), item: item(itemId, 1) },
      ...overrides.actor,
    },
    merchant: {
      merchantId,
      before: merchant(merchantId, { gold: 10 }),
      after: merchant(merchantId, { gold: 9 }),
      ...overrides.merchant,
    },
    itemName: "Iron Ration",
  });
}

function terminal(record, start = record.updatedAt + 1) {
  const actor = transitionMerchantTransaction(record, "actor-applied", {
    updatedAt: start,
  });
  const shop = transitionMerchantTransaction(actor, "merchant-applied", {
    updatedAt: start + 1,
  });
  return transitionMerchantTransaction(shop, "terminal", {
    updatedAt: start + 2,
  });
}

function expectCode(code, operation) {
  assert.throws(operation, (error) => {
    assert.ok(error instanceof MerchantTransactionLedgerError);
    assert.equal(error.code, code);
    return true;
  });
}

/* Commit ids carry a sortable server timestamp plus 128 bits of entropy. */
{
  const id = formatMerchantCommitId(
    1700000000000,
    "abcdef0123456789abcdef0123456789",
  );
  assert.equal(id, "m1.loyw3v28.abcdef0123456789abcdef0123456789");
  assert.deepEqual(parseMerchantCommitId(id), {
    commitId: id,
    timestamp: 1700000000000,
    randomHex: "abcdef0123456789abcdef0123456789",
  });
  assert.ok(compareMerchantCommitIds(commit(1), commit(2)) < 0);
  assert.ok(compareMerchantCommitIds(commit(1, 9999), commit(2, 9999)) < 0);
  expectCode("MERCHANT_LEDGER_MALFORMED", () =>
    formatMerchantCommitId(1, "too-short"),
  );
  expectCode("MERCHANT_COMMIT_ID_INVALID", () =>
    parseMerchantCommitId("legacy-1"),
  );
  expectCode("MERCHANT_COMMIT_ID_INVALID", () =>
    parseMerchantCommitId(`m1.01.${"0".repeat(31)}1`),
  );
}

/* Stable tuple encoding has no delimiter collisions. */
{
  assert.notEqual(
    buildMerchantTransactionKey("a", commit(1)),
    buildMerchantTransactionKey(`a\",\"${commit(1)}`, commit(2)),
  );
  assert.equal(
    buildMerchantTransactionKey("player-1", commit(1)),
    JSON.stringify(["player-1", commit(1)]),
  );
}

/* Player and GM bind the exact normalized wire request to one fingerprint. */
{
  const request = {
    type: "merchant:commit-purchase",
    sessionId: "session-1",
    originUserId: "player-1",
    actorId: "actor-1",
    itemUuid: "Compendium.test.ration",
    qty: 2,
    totalGp: 2,
    sealId: null,
  };
  const fingerprint = merchantCommitRequestFingerprint(request);
  assert.equal(
    fingerprint,
    merchantCommitRequestFingerprint({ ...request, qty: "2" }),
    "the existing wire contract normalizes an integer-like quantity",
  );
  assert.notEqual(
    fingerprint,
    merchantCommitRequestFingerprint({ ...request, itemUuid: "other" }),
  );
  assert.notEqual(
    fingerprint,
    merchantCommitRequestFingerprint({ ...request, qty: 2.5 }),
  );
}

/* The empty envelope is exact, deterministic, and independently mutable. */
{
  const ledger = createMerchantTransactionLedger();
  assert.deepEqual(ledger, {
    version: MERCHANT_TRANSACTION_LEDGER_VERSION,
    revision: 0,
    authorityId: null,
    authorityEpoch: null,
    writeToken: null,
    replayFloors: [],
    records: [],
  });
  const fenced = createMerchantTransactionLedger({
    revision: 4,
    authorityId: "gm-1",
    authorityEpoch: "gm-1:epoch-1",
    writeToken: "token-1",
  });
  assert.equal(fenced.revision, 4);
  assert.equal(fenced.authorityEpoch, "gm-1:epoch-1");
}

/* Buy/sell planners retain exact actor/shop boundaries without input aliases. */
{
  const buy = planBuy();
  assert.equal(buy.stage, "prepared");
  assert.equal(buy.side, "buy");
  assert.equal(buy.actor.before.item, null);
  assert.equal(buy.actor.after.item._id, buy.actor.itemId);
  assert.equal(buy.merchant.before.goldOnHand, 10);
  assert.deepEqual(projectTerminalMerchantCommitResult(buy), {
    targetUserId: "player-1",
    sessionId: "session-1",
    commitId: buy.commitId,
    side: "buy",
    ok: true,
    reason: "",
    requestFingerprint: "buy-fingerprint-1",
    totalGp: 1,
    unitGp: 1,
    qty: 1,
    itemName: "Iron Ration",
    sealId: null,
  });

  const source = merchant("merchant-1");
  const planned = planSell(2, { merchantBefore: source });
  source.goldOnHand = 999;
  assert.equal(planned.side, "sell");
  assert.equal(planned.merchant.before.goldOnHand, 10);
  assert.equal(planned.actor.before.item.system.quantity, 2);
  assert.equal(planned.actor.after.item.system.quantity, 1);
  assert.equal(projectTerminalMerchantCommitResult(planned).sealId, "seal-1");
}

/* Strict schemas fail closed on future/malformed/unsafe persisted data. */
{
  const ledger = createMerchantTransactionLedger();
  expectCode("MERCHANT_LEDGER_FUTURE_VERSION", () =>
    normalizeMerchantTransactionLedger({ ...ledger, version: 2 }),
  );
  expectCode("MERCHANT_LEDGER_MALFORMED", () =>
    normalizeMerchantTransactionLedger({ ...ledger, version: "1" }),
  );
  expectCode("MERCHANT_LEDGER_MALFORMED", () =>
    normalizeMerchantTransactionLedger({ ...ledger, surprise: true }),
  );
  const futureRecord = { ...planBuy(), version: 2 };
  expectCode("MERCHANT_LEDGER_FUTURE_VERSION", () =>
    normalizeMerchantTransactionRecord(futureRecord),
  );
  const badNumber = planBuy();
  badNumber.merchant.before.goldOnHand = Number.NaN;
  expectCode("MERCHANT_LEDGER_MALFORMED", () =>
    normalizeMerchantTransactionRecord(badNumber),
  );
  const exotic = planBuy();
  exotic.merchant.before.when = new Date();
  expectCode("MERCHANT_LEDGER_MALFORMED", () =>
    normalizeMerchantTransactionRecord(exotic),
  );
  const extraArrayField = planBuy();
  extraArrayField.merchant.before.items.note = "hidden-shape";
  expectCode("MERCHANT_LEDGER_MALFORMED", () =>
    normalizeMerchantTransactionRecord(extraArrayField),
  );
  const accessor = planBuy();
  Object.defineProperty(accessor.merchant.before, "trap", {
    enumerable: true,
    get() {
      throw new Error("must not run");
    },
  });
  expectCode("MERCHANT_LEDGER_MALFORMED", () =>
    normalizeMerchantTransactionRecord(accessor),
  );
  const cyclic = planBuy();
  cyclic.merchant.before.loop = cyclic.merchant.before;
  expectCode("MERCHANT_LEDGER_BOUNDS", () =>
    normalizeMerchantTransactionRecord(cyclic),
  );
  const badWallet = planBuy();
  badWallet.actor.before.wallet.gp = "20";
  expectCode("MERCHANT_LEDGER_MALFORMED", () =>
    normalizeMerchantTransactionRecord(badWallet),
  );
  expectCode("MERCHANT_TRANSACTION_MALFORMED", () =>
    planBuy(3, { request: { unitGp: 1.234, totalGp: 1.234 } }),
  );
}

/* Side-specific planning invariants reject phantom buys and empty sales. */
{
  expectCode("MERCHANT_TRANSACTION_MALFORMED", () =>
    planBuy(3, {
      actor: {
        actorId: "actor-1",
        itemId: "merchant-item-3",
        before: { wallet: wallet(20), item: item("merchant-item-3") },
        after: { wallet: wallet(19), item: item("merchant-item-3") },
      },
    }),
  );
  expectCode("MERCHANT_TRANSACTION_MALFORMED", () =>
    planMerchantSellTransaction({
      ...planInputFrom(planSell(4)),
      actor: {
        actorId: "actor-1",
        itemId: "owned-rations",
        before: { wallet: wallet(20), item: null },
        after: { wallet: wallet(21), item: null },
      },
    }),
  );
}

/* Replay floors reject every retained unresolved stage, not only receipts. */
{
  const prepared = planBuy(53);
  const actorApplied = transitionMerchantTransaction(prepared, "actor-applied");
  const merchantApplied = transitionMerchantTransaction(
    actorApplied,
    "merchant-applied",
  );
  const review = transitionMerchantTransaction(prepared, "needs-review", {
    reason: "canonical-state-mismatch",
    actorState: "third-state",
    merchantState: "before",
  });
  for (const record of [prepared, actorApplied, merchantApplied, review]) {
    expectCode("MERCHANT_LEDGER_MALFORMED", () =>
      normalizeMerchantTransactionLedger({
        version: MERCHANT_TRANSACTION_LEDGER_VERSION,
        revision: 1,
        authorityId: null,
        authorityEpoch: null,
        writeToken: null,
        replayFloors: [
          {
            originUserId: record.originUserId,
            throughCommitId: record.commitId,
          },
        ],
        records: [record],
      }),
    );
  }
}

/* Only the linear durable path is allowed; terminal records are compact. */
{
  const prepared = planBuy(5);
  assert.equal(
    canTransitionMerchantTransaction("prepared", "actor-applied"),
    true,
  );
  assert.equal(canTransitionMerchantTransaction("prepared", "terminal"), false);
  expectCode("MERCHANT_TRANSACTION_INVALID_TRANSITION", () =>
    transitionMerchantTransaction(prepared, "merchant-applied"),
  );
  const actorApplied = transitionMerchantTransaction(
    prepared,
    "actor-applied",
    {
      updatedAt: 2000,
    },
  );
  const merchantApplied = transitionMerchantTransaction(
    actorApplied,
    "merchant-applied",
    { updatedAt: 2001 },
  );
  const done = transitionMerchantTransaction(merchantApplied, "terminal", {
    updatedAt: 2002,
  });
  assert.deepEqual(Object.keys(done).sort(), [
    "commitId",
    "createdAt",
    "key",
    "originUserId",
    "requestFingerprint",
    "result",
    "side",
    "stage",
    "updatedAt",
    "version",
  ]);
  assert.equal(
    done.actor,
    undefined,
    "terminal compaction drops Actor snapshots",
  );
  assert.deepEqual(projectTerminalMerchantCommitResult(done), done.result);
  assert.equal(isPinnedMerchantTransaction(done), false);

  const review = transitionMerchantTransaction(prepared, "needs-review", {
    updatedAt: 2000,
    reason: "wallet-diverged",
    actorState: "third-state",
    merchantState: "before",
  });
  assert.equal(review.review.reason, "wallet-diverged");
  assert.equal(isPinnedMerchantTransaction(review), true);
  expectCode("MERCHANT_TRANSACTION_INVALID_TRANSITION", () =>
    transitionMerchantTransaction(review, "terminal"),
  );
}

/* Pinned review recovery accepts only exact, order-safe canonical checkpoints. */
{
  const prepared = planBuy(51);
  const review = transitionMerchantTransaction(prepared, "needs-review", {
    updatedAt: 3000,
    reason: "canonical-state-mismatch",
    actorState: "third-state",
    merchantState: "before",
  });
  const partialActor = {
    wallet: prepared.actor.before.wallet,
    item: prepared.actor.after.item,
  };
  const cases = [
    [prepared.actor.before, prepared.merchant.before, "prepared"],
    [partialActor, prepared.merchant.before, "prepared"],
    [prepared.actor.after, prepared.merchant.before, "actor-applied"],
    [prepared.actor.after, prepared.merchant.after, "merchant-applied"],
  ];
  for (const [actor, merchantState, nextStage] of cases) {
    const assessment = classifyMerchantTransactionReviewRecovery(review, {
      actor,
      merchant: merchantState,
    });
    assert.equal(assessment.action, "recover");
    assert.equal(assessment.nextStage, nextStage);
    assert.equal(assessment.manualCorrectionRequired, false);
  }

  const unchangedMerchant = merchant("merchant-both", { gold: 10, qty: 3 });
  const bothPlan = planBuy(52, {
    merchantId: "merchant-both",
    merchantBefore: unchangedMerchant,
    merchantAfter: unchangedMerchant,
  });
  const bothReview = transitionMerchantTransaction(bothPlan, "needs-review", {
    updatedAt: 3100,
    reason: "canonical-state-mismatch",
    actorState: "third-state",
    merchantState: "both",
  });
  assert.equal(
    classifyMerchantTransactionReviewRecovery(bothReview, {
      actor: bothPlan.actor.before,
      merchant: unchangedMerchant,
    }).nextStage,
    "prepared",
  );
  assert.equal(
    classifyMerchantTransactionReviewRecovery(bothReview, {
      actor: bothPlan.actor.after,
      merchant: unchangedMerchant,
    }).nextStage,
    "merchant-applied",
  );

  const unsafe = classifyMerchantTransactionReviewRecovery(review, {
    actor: prepared.actor.before,
    merchant: prepared.merchant.after,
  });
  assert.equal(unsafe.action, "stay-review");
  assert.equal(unsafe.reason, "unsafe-checkpoint-combination");
  assert.equal(unsafe.manualCorrectionRequired, true);
  const third = classifyMerchantTransactionReviewRecovery(review, {
    actor: { wallet: wallet(77), item: null },
    merchant: prepared.merchant.before,
  });
  assert.equal(third.action, "stay-review");
  assert.equal(third.actorState, "third-state");
  assert.equal(third.reason, "canonical-state-mismatch");

  const assessment = classifyMerchantTransactionReviewRecovery(review, {
    actor: prepared.actor.after,
    merchant: prepared.merchant.before,
  });
  const recovered = recoverMerchantTransactionFromReview(review, assessment, {
    updatedAt: 3200,
  });
  assert.equal(recovered.stage, "actor-applied");
  assert.equal(recovered.review, undefined);
  assert.deepEqual(recovered.actor, review.actor);
  assert.equal(
    canTransitionMerchantTransaction("needs-review", "actor-applied"),
    false,
  );
  expectCode("MERCHANT_TRANSACTION_INVALID_TRANSITION", () =>
    transitionMerchantTransaction(review, "actor-applied"),
  );

  const ledger = addMerchantTransactionRecord(
    createMerchantTransactionLedger(),
    review,
  );
  expectCode("MERCHANT_TRANSACTION_INVALID_TRANSITION", () =>
    replaceMerchantTransactionRecord(ledger, recovered),
  );
  const replaced = replaceRecoveredMerchantTransactionRecord(ledger, recovered);
  assert.equal(
    findMerchantTransactionRecord(
      replaced,
      recovered.originUserId,
      recovered.commitId,
    ).stage,
    "actor-applied",
  );
  expectCode("MERCHANT_TRANSACTION_INVALID_RECOVERY", () =>
    recoverMerchantTransactionFromReview(review, unsafe, { updatedAt: 3201 }),
  );
}

/* Reconciliation covers every crash boundary and rejects hybrid third states. */
{
  const prepared = planBuy(6);
  const before = {
    actor: prepared.actor.before,
    merchant: prepared.merchant.before,
  };
  assert.deepEqual(
    classifyMerchantTransactionReconciliation(prepared, before),
    {
      action: "apply",
      target: "actor",
      nextStage: "actor-applied",
      reason: "actor-not-applied",
      actorState: "before",
      merchantState: "before",
      actorWalletState: "before",
      actorItemState: "before",
      actorApply: ["item", "wallet"],
      result: null,
    },
  );
  const actorLanded = classifyMerchantTransactionReconciliation(prepared, {
    actor: prepared.actor.after,
    merchant: prepared.merchant.before,
  });
  assert.equal(actorLanded.action, "advance");
  assert.equal(actorLanded.nextStage, "actor-applied");
  const bothLanded = classifyMerchantTransactionReconciliation(prepared, {
    actor: prepared.actor.after,
    merchant: prepared.merchant.after,
  });
  assert.equal(bothLanded.action, "advance");
  assert.equal(bothLanded.nextStage, "actor-applied");

  const actorStage = transitionMerchantTransaction(prepared, "actor-applied");
  const shopNeeded = classifyMerchantTransactionReconciliation(actorStage, {
    actor: prepared.actor.after,
    merchant: prepared.merchant.before,
  });
  assert.equal(shopNeeded.action, "apply");
  assert.equal(shopNeeded.target, "merchant");
  const shopLanded = classifyMerchantTransactionReconciliation(actorStage, {
    actor: prepared.actor.after,
    merchant: prepared.merchant.after,
  });
  assert.equal(shopLanded.action, "advance");
  assert.equal(shopLanded.nextStage, "merchant-applied");

  const shopStage = transitionMerchantTransaction(
    actorStage,
    "merchant-applied",
  );
  const finalize = classifyMerchantTransactionReconciliation(shopStage, {
    actor: prepared.actor.after,
    merchant: prepared.merchant.after,
  });
  assert.equal(finalize.action, "finalize");
  assert.equal(finalize.nextStage, "terminal");

  const earlyShop = classifyMerchantTransactionReconciliation(prepared, {
    actor: prepared.actor.before,
    merchant: prepared.merchant.after,
  });
  assert.equal(earlyShop.action, "needs-review");
  assert.equal(earlyShop.reason, "impossible-write-order");
  assert.deepEqual(earlyShop.actorApply, []);

  const partialWithEarlyShop = classifyMerchantTransactionReconciliation(
    prepared,
    {
      actor: {
        wallet: prepared.actor.before.wallet,
        item: prepared.actor.after.item,
      },
      merchant: prepared.merchant.after,
    },
  );
  assert.equal(partialWithEarlyShop.action, "needs-review");
  assert.equal(partialWithEarlyShop.actorState, "partial");
  assert.equal(partialWithEarlyShop.reason, "impossible-write-order");
  assert.deepEqual(partialWithEarlyShop.actorApply, []);
  const third = classifyMerchantTransactionReconciliation(prepared, {
    actor: { wallet: wallet(17), item: null },
    merchant: prepared.merchant.before,
  });
  assert.equal(third.action, "needs-review");
  assert.equal(third.actorState, "third-state");
  assert.equal(third.actorWalletState, "third-state");
  assert.equal(third.actorItemState, "before");
  assert.deepEqual(third.actorApply, []);
}

/* Actor crash hybrids are resumable component-by-component for buys and sales. */
for (const [label, prepared] of [
  ["buy", planBuy(61)],
  ["sell", planSell(62)],
]) {
  const itemLanded = classifyMerchantTransactionReconciliation(prepared, {
    actor: {
      wallet: prepared.actor.before.wallet,
      item: prepared.actor.after.item,
    },
    merchant: prepared.merchant.before,
  });
  assert.equal(itemLanded.action, "apply", `${label}: finish Actor write`);
  assert.equal(itemLanded.target, "actor");
  assert.equal(itemLanded.actorState, "partial");
  assert.equal(itemLanded.actorWalletState, "before");
  assert.equal(itemLanded.actorItemState, "after");
  assert.deepEqual(itemLanded.actorApply, ["wallet"]);

  const walletLanded = classifyMerchantTransactionReconciliation(prepared, {
    actor: {
      wallet: prepared.actor.after.wallet,
      item: prepared.actor.before.item,
    },
    merchant: prepared.merchant.before,
  });
  assert.equal(walletLanded.action, "apply", `${label}: finish Actor write`);
  assert.equal(walletLanded.actorState, "partial");
  assert.equal(walletLanded.actorWalletState, "after");
  assert.equal(walletLanded.actorItemState, "before");
  assert.deepEqual(walletLanded.actorApply, ["item"]);

  const alteredItem = structuredClone(prepared.actor.after.item);
  alteredItem.system.quantity = 99;
  const thirdItem = classifyMerchantTransactionReconciliation(prepared, {
    actor: {
      wallet: prepared.actor.before.wallet,
      item: alteredItem,
    },
    merchant: prepared.merchant.before,
  });
  assert.equal(thirdItem.action, "needs-review");
  assert.equal(thirdItem.actorItemState, "third-state");
  assert.deepEqual(thirdItem.actorApply, []);
}

/* A no-op merchant boundary advances safely once the Actor side is exact. */
{
  const same = merchant("merchant-1", { gold: 10, qty: 3, unlimited: true });
  const prepared = planBuy(7, { merchantBefore: same, merchantAfter: same });
  const preparedHybrid = classifyMerchantTransactionReconciliation(prepared, {
    actor: {
      wallet: prepared.actor.before.wallet,
      item: prepared.actor.after.item,
    },
    merchant: same,
  });
  assert.equal(preparedHybrid.merchantState, "both");
  assert.equal(preparedHybrid.action, "apply");
  assert.deepEqual(preparedHybrid.actorApply, ["wallet"]);
  const actorStage = transitionMerchantTransaction(prepared, "actor-applied");
  const assessment = classifyMerchantTransactionReconciliation(actorStage, {
    actor: prepared.actor.after,
    merchant: same,
  });
  assert.equal(assessment.merchantState, "both");
  assert.equal(assessment.action, "advance");
  assert.equal(assessment.nextStage, "merchant-applied");
}

/* Tuple lookup precedes sessions: pending, terminal, conflict, missing, floor. */
{
  let ledger = createMerchantTransactionLedger();
  const pending = planBuy(8);
  ledger = addMerchantTransactionRecord(ledger, pending);
  assert.equal(ledger.revision, 1);
  assert.equal(
    findMerchantTransactionRecord(
      ledger,
      pending.originUserId,
      pending.commitId,
    )?.key,
    pending.key,
  );
  assert.equal(
    lookupMerchantTransactionReplay(ledger, pending).status,
    "pending",
  );
  assert.equal(
    lookupMerchantTransactionReplay(ledger, {
      ...pending,
      requestFingerprint: "different-request",
    }).status,
    "conflict",
  );
  const actorApplied = transitionMerchantTransaction(pending, "actor-applied");
  ledger = replaceMerchantTransactionRecord(ledger, actorApplied);
  const changedPlan = structuredClone(actorApplied);
  changedPlan.actor.after.wallet.gp = 18;
  expectCode("MERCHANT_TRANSACTION_KEY_CONFLICT", () =>
    replaceMerchantTransactionRecord(ledger, changedPlan),
  );
  const merchantApplied = transitionMerchantTransaction(
    actorApplied,
    "merchant-applied",
  );
  ledger = replaceMerchantTransactionRecord(ledger, merchantApplied);
  const done = transitionMerchantTransaction(merchantApplied, "terminal");
  ledger = replaceMerchantTransactionRecord(ledger, done);
  const replay = lookupMerchantTransactionReplay(ledger, done);
  assert.equal(replay.status, "terminal");
  assert.deepEqual(replay.result, done.result);
  assert.equal(
    lookupMerchantTransactionReplay(ledger, {
      originUserId: "player-1",
      commitId: commit(99),
    }).status,
    "missing",
  );
}

/* Terminal caps advance per-user replay floors; unresolved work stays pinned. */
{
  let ledger = createMerchantTransactionLedger();
  const first = terminal(planBuy(10));
  const second = terminal(planBuy(11));
  const third = terminal(planBuy(12));
  const unresolved = planSell(13);
  for (const record of [first, second, third, unresolved]) {
    ledger = addMerchantTransactionRecord(ledger, record);
  }
  const compacted = compactMerchantTransactionLedger(ledger, {
    terminalCap: 1,
  });
  assert.deepEqual(
    compacted.records.map((record) => record.commitId),
    [third.commitId, unresolved.commitId],
  );
  assert.equal(compacted.replayFloors[0].throughCommitId, second.commitId);
  assert.equal(
    lookupMerchantTransactionReplay(compacted, first).status,
    "compacted",
  );
  assert.equal(
    lookupMerchantTransactionReplay(compacted, unresolved).status,
    "pending",
  );
  expectCode("MERCHANT_TRANSACTION_REPLAY_FLOOR", () =>
    addMerchantTransactionRecord(compacted, planBuy(10)),
  );
  expectCode("MERCHANT_LEDGER_CAPACITY", () =>
    compactMerchantTransactionLedger(
      addMerchantTransactionRecord(
        createMerchantTransactionLedger(),
        planBuy(20),
      ),
      { terminalCap: 0, maxRecords: 0 },
    ),
  );
}

/* A scalar replay floor never advances past older unresolved work. */
{
  let ledger = createMerchantTransactionLedger();
  let unresolved = planBuy(14);
  const newerFirst = terminal(
    planBuy(15, { actorId: "actor-15", merchantId: "merchant-15" }),
  );
  const newerSecond = terminal(
    planBuy(16, { actorId: "actor-16", merchantId: "merchant-16" }),
  );
  for (const record of [unresolved, newerFirst, newerSecond]) {
    ledger = addMerchantTransactionRecord(ledger, record);
  }

  ledger = compactMerchantTransactionLedger(ledger, { terminalCap: 0 });
  assert.deepEqual(
    ledger.records.map((record) => record.commitId),
    [unresolved.commitId, newerFirst.commitId, newerSecond.commitId],
    "newer receipts stay retained while evicting them would strand older work",
  );
  assert.deepEqual(ledger.replayFloors, []);

  for (const stage of ["actor-applied", "merchant-applied", "terminal"]) {
    unresolved = transitionMerchantTransaction(unresolved, stage, {
      updatedAt: unresolved.updatedAt + 1,
    });
    ledger = replaceMerchantTransactionRecord(ledger, unresolved);
  }
  assert.equal(
    lookupMerchantTransactionReplay(ledger, unresolved).status,
    "terminal",
  );

  ledger = compactMerchantTransactionLedger(ledger, { terminalCap: 0 });
  assert.deepEqual(ledger.records, []);
  assert.equal(
    ledger.replayFloors[0].throughCommitId,
    newerSecond.commitId,
    "the floor can advance after the older transaction reaches terminal",
  );
}

/* Duplicate keys and floor/record corruption fail closed during normalization. */
{
  const record = planBuy(30);
  expectCode("MERCHANT_LEDGER_MALFORMED", () =>
    createMerchantTransactionLedger({ records: [record, record] }),
  );
}

function planInputFrom(record) {
  return {
    originUserId: record.originUserId,
    commitId: record.commitId,
    requestFingerprint: record.requestFingerprint,
    createdAt: record.createdAt,
    request: record.request,
    actor: record.actor,
    merchant: record.merchant,
    itemName: record.receipt.itemName,
  };
}

process.stdout.write("merchant-transaction-ledger validation passed\n");
