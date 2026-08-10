/**
 * Tests for the GM-side merchant session registry: session lifecycle,
 * viewer cleanup (logout GC), bargain-seal one-shot semantics, commit
 * idempotency retention, and the mutexes that serialize economy writes.
 */

import assert from "node:assert/strict";

import {
  clearAllSessions,
  closeSession,
  closeViewerSessions,
  consumeReservedSeal,
  consumeSeal,
  findSessionFor,
  getBargain,
  getCommitResult,
  getSession,
  listSessions,
  openSession,
  recordBargain,
  recordCommitResult,
  releaseSealReservation,
  reserveSealForCommit,
  runWithActorMutex,
  runWithMerchantMutex,
} from "./merchant/session-state.js";

clearAllSessions();

/* ------------------------------------------------------------------ *
 * Session lifecycle — create, idempotent per (merchant, viewer), close
 * ------------------------------------------------------------------ */
{
  const a = openSession({ merchantId: "m1", viewerUserId: "u1" });
  assert.ok(typeof a.sessionId === "string" && a.sessionId.startsWith("s-"));

  const again = openSession({ merchantId: "m1", viewerUserId: "u1" });
  assert.equal(
    again.sessionId,
    a.sessionId,
    "re-opening the same merchant+viewer is idempotent",
  );

  const b = openSession({ merchantId: "m1", viewerUserId: "u2" });
  assert.notEqual(b.sessionId, a.sessionId, "different viewer → new session");
  assert.throws(
    () => openSession({ merchantId: "", viewerUserId: "u" }),
    "requires both ids",
  );

  assert.equal(getSession(a.sessionId), a);
  assert.equal(findSessionFor("m1", "u1").sessionId, a.sessionId);
  assert.equal(findSessionFor("m1", "nope"), null);
  assert.equal(listSessions().length, 2);

  assert.equal(closeSession(a.sessionId), true);
  assert.equal(closeSession(a.sessionId), false, "closing twice is safe");
  assert.equal(closeSession("unknown"), false);
}

/* ------------------------------------------------------------------ *
 * closeViewerSessions — drops every session for a viewer (logout GC)
 * ------------------------------------------------------------------ */
{
  clearAllSessions();
  openSession({ merchantId: "m1", viewerUserId: "u1" });
  openSession({ merchantId: "m2", viewerUserId: "u1" });
  openSession({ merchantId: "m1", viewerUserId: "u2" });
  assert.equal(listSessions().length, 3);

  assert.equal(closeViewerSessions("u1"), 2, "both of u1's sessions close");
  assert.equal(listSessions().length, 1);
  assert.equal(listSessions()[0].viewerUserId, "u2");
  assert.equal(
    closeViewerSessions("ghost"),
    0,
    "unknown viewer closes nothing",
  );
}

/* ------------------------------------------------------------------ *
 * Bargain seals — one per (item, side); consume validates + burns
 * ------------------------------------------------------------------ */
{
  clearAllSessions();
  const s = openSession({ merchantId: "m", viewerUserId: "u" });

  const seal = recordBargain(s.sessionId, {
    itemUuid: "it",
    side: "buy",
    tier: { id: "success" },
    deltaPct: -10,
  });
  assert.ok(seal.sealId.startsWith("seal-"));
  assert.equal(seal.deltaPct, -10);

  // One bargain per (item, side): re-recording returns the existing seal.
  const again = recordBargain(s.sessionId, {
    itemUuid: "it",
    side: "buy",
    deltaPct: -20,
  });
  assert.equal(again.sealId, seal.sealId, "one bargain per item+side");
  assert.equal(getBargain(s.sessionId, "it", "buy").sealId, seal.sealId);

  // Consuming with the wrong item/side fails and leaves the seal intact.
  assert.equal(
    consumeSeal(s.sessionId, seal.sealId, { itemUuid: "other", side: "buy" }),
    null,
  );
  assert.equal(
    consumeSeal(s.sessionId, seal.sealId, { itemUuid: "it", side: "sell" }),
    null,
  );
  assert.ok(
    getBargain(s.sessionId, "it", "buy"),
    "seal survives a mismatched consume",
  );

  // Correct consume returns the seal and burns it (one-shot).
  const burned = consumeSeal(s.sessionId, seal.sealId, {
    itemUuid: "it",
    side: "buy",
  });
  assert.equal(burned.sealId, seal.sealId);
  assert.equal(getBargain(s.sessionId, "it", "buy"), null, "burned after use");
  assert.equal(
    consumeSeal(s.sessionId, seal.sealId, { itemUuid: "it", side: "buy" }),
    null,
    "a burned seal can't be reused",
  );

  // Unknown session / seal → null, never throws.
  assert.equal(consumeSeal("nope", "x"), null);
  assert.equal(recordBargain("nope", { itemUuid: "i", side: "buy" }), null);
}

/* ------------------------------------------------------------------ *
 * Bargain reservations - one exact durable commit owns the seal
 * ------------------------------------------------------------------ */
{
  clearAllSessions();
  const session = openSession({ merchantId: "m", viewerUserId: "u" });
  const seal = recordBargain(session.sessionId, {
    itemUuid: "Item.stock",
    side: "buy",
    tier: { id: "success" },
    deltaPct: -10,
  });
  const claim = {
    itemUuid: "Item.stock",
    side: "buy",
    originUserId: "player-1",
    commitId: "m1-commit-1",
    requestFingerprint: "fingerprint-1",
  };

  assert.deepEqual(
    reserveSealForCommit(session.sessionId, seal.sealId, claim),
    { ok: true, seal, replay: false },
    "the first exact claim reserves the seal",
  );
  assert.deepEqual(seal.reservedFor, {
    originUserId: "player-1",
    commitId: "m1-commit-1",
    requestFingerprint: "fingerprint-1",
  });
  assert.deepEqual(
    reserveSealForCommit(session.sessionId, seal.sealId, claim),
    { ok: true, seal, replay: true },
    "an exact retry replays the existing reservation",
  );

  for (const conflictingClaim of [
    { ...claim, originUserId: "player-2" },
    { ...claim, commitId: "m1-commit-2" },
    { ...claim, requestFingerprint: "fingerprint-2" },
  ]) {
    assert.deepEqual(
      reserveSealForCommit(session.sessionId, seal.sealId, conflictingClaim),
      { ok: false, reason: "bargain-expired" },
      "a competing commit cannot claim the reserved seal",
    );
  }

  for (const invalidScope of [
    { sessionId: "missing-session", sealId: seal.sealId, claim },
    { sessionId: session.sessionId, sealId: "missing-seal", claim },
    {
      sessionId: session.sessionId,
      sealId: seal.sealId,
      claim: { ...claim, itemUuid: "Item.other" },
    },
    {
      sessionId: session.sessionId,
      sealId: seal.sealId,
      claim: { ...claim, side: "sell" },
    },
    {
      sessionId: session.sessionId,
      sealId: seal.sealId,
      claim: { ...claim, requestFingerprint: "" },
    },
  ]) {
    assert.deepEqual(
      reserveSealForCommit(
        invalidScope.sessionId,
        invalidScope.sealId,
        invalidScope.claim,
      ),
      { ok: false, reason: "bargain-expired" },
      "missing or mismatched reservation scope fails closed",
    );
  }

  assert.equal(
    consumeReservedSeal(session.sessionId, seal.sealId, {
      ...claim,
      commitId: "m1-commit-2",
    }),
    null,
    "a competing commit cannot consume the reservation",
  );
  assert.equal(
    getBargain(session.sessionId, claim.itemUuid, claim.side),
    seal,
    "a failed consume leaves the reservation intact",
  );
  assert.equal(
    consumeReservedSeal(session.sessionId, seal.sealId, claim),
    seal,
    "the exact owner can consume the reservation",
  );
  assert.equal(
    getBargain(session.sessionId, claim.itemUuid, claim.side),
    null,
    "consuming the reservation burns the bargain seal",
  );
  assert.equal(
    consumeReservedSeal(session.sessionId, seal.sealId, claim),
    null,
    "a consumed reservation cannot be replayed from transient state",
  );
}

{
  clearAllSessions();
  const session = openSession({ merchantId: "m", viewerUserId: "u" });
  const seal = recordBargain(session.sessionId, {
    itemUuid: "Item.stock",
    side: "sell",
    tier: { id: "success" },
    deltaPct: 10,
  });
  const claim = {
    itemUuid: "Item.stock",
    side: "sell",
    originUserId: "player-1",
    commitId: "m1-commit-3",
    requestFingerprint: "fingerprint-3",
  };
  reserveSealForCommit(session.sessionId, seal.sealId, claim);

  assert.equal(
    releaseSealReservation(session.sessionId, seal.sealId, {
      ...claim,
      originUserId: "player-2",
    }),
    false,
    "a competing identity cannot release the reservation",
  );
  assert.equal(
    releaseSealReservation(session.sessionId, seal.sealId, claim),
    true,
    "the exact owner can release the reservation",
  );
  assert.equal(
    getBargain(session.sessionId, claim.itemUuid, claim.side),
    seal,
    "releasing the reservation keeps the bargain seal",
  );
  assert.equal(seal.reservedFor, undefined);
  assert.equal(
    releaseSealReservation(session.sessionId, seal.sealId, claim),
    false,
    "an unreserved seal has no exact claim to release",
  );

  const nextClaim = {
    ...claim,
    commitId: "m1-commit-4",
    requestFingerprint: "fingerprint-4",
  };
  assert.deepEqual(
    reserveSealForCommit(session.sessionId, seal.sealId, nextClaim),
    { ok: true, seal, replay: false },
    "a released seal can be reserved by a new commit",
  );

  const legacyConsume = consumeSeal(session.sessionId, seal.sealId, {
    itemUuid: claim.itemUuid,
    side: claim.side,
  });
  assert.equal(
    legacyConsume,
    seal,
    "the existing consumeSeal API retains its one-shot behavior",
  );
}

/* ------------------------------------------------------------------ *
 * Commit results — successes stay replay-safe; only failures are bounded
 * ------------------------------------------------------------------ */
{
  clearAllSessions();
  const session = openSession({
    merchantId: "merchant-1",
    viewerUserId: "player-1",
  });
  const successful = recordCommitResult(session.sessionId, "success-early", {
    ok: true,
    requestFingerprint: "request-a",
  });

  for (let index = 0; index < 300; index += 1) {
    recordCommitResult(session.sessionId, `failure-${index}`, {
      ok: false,
      reason: "expected-test-failure",
      requestFingerprint: `failure-request-${index}`,
    });
  }

  assert.equal(
    getCommitResult(session.sessionId, "success-early"),
    successful,
    "successful commits remain cached after the failure bound is exceeded",
  );
  assert.equal(
    getCommitResult(session.sessionId, "failure-0"),
    null,
    "the oldest failed commit is evicted",
  );
  assert.ok(
    getCommitResult(session.sessionId, "failure-299"),
    "the newest failed commit remains cached",
  );

  for (let index = 0; index < 300; index += 1) {
    recordCommitResult(session.sessionId, `success-${index}`, {
      ok: true,
      requestFingerprint: `success-request-${index}`,
    });
  }
  assert.ok(
    getCommitResult(session.sessionId, "success-0"),
    "successful commit results are retained for the session lifetime",
  );
  assert.ok(
    getCommitResult(session.sessionId, "success-299"),
    "new successful commit results are retained",
  );

  const duplicate = recordCommitResult(session.sessionId, "success-early", {
    ok: false,
    reason: "must-not-replace",
    requestFingerprint: "request-b",
  });
  assert.equal(
    duplicate,
    successful,
    "recording an existing commitId never replaces its original result",
  );
}

/* ------------------------------------------------------------------ *
 * Mutex — serializes calls; a failed fn doesn't poison the chain
 * ------------------------------------------------------------------ */
{
  clearAllSessions();
  const order = [];
  const p1 = runWithMerchantMutex("m", async () => {
    order.push("a-start");
    await Promise.resolve();
    order.push("a-end");
    return 1;
  });
  const p2 = runWithMerchantMutex("m", async () => {
    order.push("b");
    return 2;
  });
  const [r1, r2] = await Promise.all([p1, p2]);
  assert.equal(r1, 1);
  assert.equal(r2, 2);
  assert.deepEqual(
    order,
    ["a-start", "a-end", "b"],
    "the second call waits for the first",
  );

  const fail = runWithMerchantMutex("m", async () => {
    throw new Error("boom");
  });
  await assert.rejects(fail, /boom/);
  const after = await runWithMerchantMutex("m", async () => "ok");
  assert.equal(after, "ok", "the chain survives a failed fn");
}

/* ------------------------------------------------------------------ *
 * Actor mutex — serializes one wallet across otherwise independent shops
 * ------------------------------------------------------------------ */
{
  clearAllSessions();
  const order = [];
  const first = runWithActorMutex("actor-1", async () => {
    order.push("first-start");
    await Promise.resolve();
    order.push("first-end");
  });
  const second = runWithActorMutex("actor-1", async () => {
    order.push("second");
  });
  const independent = runWithActorMutex("actor-2", async () => {
    order.push("independent");
  });
  await Promise.all([first, second, independent]);
  assert.ok(
    order.indexOf("second") > order.indexOf("first-end"),
    "same-actor work waits for the prior transaction",
  );
  assert.ok(
    order.indexOf("independent") < order.indexOf("second"),
    "a different actor is not blocked by the first actor's queue",
  );
}

process.stdout.write("merchant-session-state validation passed\n");
