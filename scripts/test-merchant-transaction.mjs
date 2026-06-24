/**
 * Tests for the merchant sell path's data-safety guards:
 *  - a zero-quantity item can't sell (T3),
 *  - a failed payout rolls the item removal back so the player never loses
 *    an item for nothing (T2).
 *
 * executeSell touches a Foundry actor; we pass small stubs and `notify:false`
 * so the helper never reaches the `ui.notifications` calls (undefined in node).
 */

import assert from "node:assert/strict";

import { executeSell } from "./merchant/transaction.js";
import { normalizeMerchant } from "./merchant/store.js";

function makeItem({
  id = "it-1",
  quantity = 1,
  priceGp = 10,
  type = "loot",
} = {}) {
  const data = {
    _id: id,
    name: "Trinket",
    type,
    system: { quantity, price: { value: priceGp, denomination: "gp" } },
    flags: {},
  };
  return {
    id,
    type: data.type,
    system: data.system,
    flags: data.flags,
    toObject: () => structuredClone(data),
    async update(patch) {
      if (patch["system.quantity"] !== undefined) {
        data.system.quantity = patch["system.quantity"];
      }
      return true;
    },
  };
}

function makeActor({ updateRejects = false } = {}) {
  const calls = { created: [], deleted: [], updates: 0 };
  return {
    name: "Tester",
    system: { currency: { pp: 0, gp: 100, ep: 0, sp: 0, cp: 0 } },
    async update() {
      calls.updates += 1;
      if (updateRejects) throw new Error("currency update boom");
      return true;
    },
    async createEmbeddedDocuments(_type, arr) {
      calls.created.push(...arr);
      return arr.map((_d, i) => ({ id: `restored-${i}` }));
    },
    async deleteEmbeddedDocuments(_type, ids) {
      calls.deleted.push(...ids);
      return ids;
    },
    _calls: calls,
  };
}

const merchant = normalizeMerchant({ id: "shop", sellRatio: 0.5 });

/* T3 — a zero-quantity item must not sell (no phantom payout) */
{
  const actor = makeActor();
  const item = makeItem({ quantity: 0 });
  const result = await executeSell({
    actor,
    merchant,
    ownedItem: item,
    qty: 1,
    notify: false,
  });
  assert.equal(result.ok, false, "a zero-qty item cannot be sold");
  assert.equal(result.reason, "not-enough");
  assert.equal(actor._calls.deleted.length, 0, "nothing removed");
  assert.equal(actor._calls.updates, 0, "no coin credited");
}

/* Sanity: a normal sell succeeds and credits coin once */
{
  const actor = makeActor();
  const item = makeItem({ quantity: 1, priceGp: 10 });
  const result = await executeSell({
    actor,
    merchant,
    ownedItem: item,
    qty: 1,
    notify: false,
  });
  assert.equal(result.ok, true, "a normal sell succeeds");
  assert.equal(result.totalGp, 5, "10 gp base × 0.5 sell ratio");
  assert.equal(actor._calls.deleted.length, 1, "the whole stack is removed");
  assert.equal(actor._calls.updates, 1, "coin credited once");
  assert.equal(actor._calls.created.length, 0, "no rollback on success");
}

/* T4 — a fractional gp payout never leaks an out-of-range coin (cp/sp must be
 * 0-9) and conserves total value. 4.8 gp × 0.5 = 2.4 gp; the old floor+round
 * split produced sp:3/cp:10. */
{
  const actor = makeActor();
  const item = makeItem({ quantity: 1, priceGp: 4.8 });
  const result = await executeSell({
    actor,
    merchant,
    ownedItem: item,
    qty: 1,
    notify: false,
  });
  assert.equal(result.ok, true, "a fractional-gp sell succeeds");
  assert.equal(result.totalGp, 2.4, "4.8 gp base × 0.5 sell ratio");
  const b = result.coinBreakdown;
  assert.ok(b.cp < 10, `cp must stay 0-9 (got ${b.cp})`);
  assert.ok(b.sp < 10, `sp must stay 0-9 (got ${b.sp})`);
  const valueCp =
    (b.pp ?? 0) * 1000 +
    (b.gp ?? 0) * 100 +
    (b.ep ?? 0) * 50 +
    (b.sp ?? 0) * 10 +
    (b.cp ?? 0);
  assert.equal(valueCp, 240, "coin value equals 2.4 gp (240 cp) exactly");
}

/* T2 — a payout failure rolls the removal back (no item loss) */
{
  const actor = makeActor({ updateRejects: true });
  const item = makeItem({ quantity: 1, priceGp: 10 });
  const result = await executeSell({
    actor,
    merchant,
    ownedItem: item,
    qty: 1,
    notify: false,
  });
  assert.equal(result.ok, false, "the sale fails when the payout rejects");
  assert.equal(result.reason, "payout-failed");
  assert.equal(actor._calls.deleted.length, 1, "the item was removed first");
  assert.equal(
    actor._calls.created.length,
    1,
    "…then restored when the payout failed",
  );
}

process.stdout.write("merchant-transaction validation passed\n");
