/**
 * Tests for the GM-side merchant session registry: session lifecycle,
 * viewer cleanup (logout GC), bargain-seal one-shot semantics, and the
 * per-merchant mutex that serializes stock writes.
 */

import assert from "node:assert/strict";

import {
  clearAllSessions,
  closeSession,
  closeViewerSessions,
  consumeSeal,
  findSessionFor,
  getBargain,
  getSession,
  listSessions,
  openSession,
  recordBargain,
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

process.stdout.write("merchant-session-state validation passed\n");
