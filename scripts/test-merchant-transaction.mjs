/**
 * Merchant transaction integration tests.
 *
 * The fixture below models the parts of a Foundry Actor that matter to the
 * transaction contract: actor.system.currency is canonical mutable state,
 * actor.items is a canonical embedded-document collection, and each write can
 * independently apply, return no confirmation, alter its result, or throw.
 */

import assert from "node:assert/strict";

import {
  applyDurableMerchantActorPlan,
  executeBuy,
  executeSell,
  planDurableBuyActorTransaction,
  planDurableSellActorTransaction,
  readMerchantActorBoundary,
  rollbackBuyTransaction,
  rollbackSellTransaction,
} from "./merchant/transaction.js";
import { merchantItemId } from "./merchant/write-verification.js";
import { normalizeMerchant } from "./merchant/store.js";

const BASE_WALLET = Object.freeze({
  pp: 0,
  gp: 100,
  ep: 0,
  sp: 0,
  cp: 0,
});

const merchant = normalizeMerchant({
  id: "shop",
  name: "Test Merchant",
  defaultMarkup: 0,
  sellRatio: 0.5,
});

function clone(value) {
  return structuredClone(value);
}

function wallet(overrides = {}) {
  return { ...BASE_WALLET, ...overrides };
}

function catalogItem({
  id = "catalog-item",
  name = "Trinket",
  quantity = 1,
  priceGp = 10,
  type = "loot",
  includeQuantity = true,
  flags = {},
} = {}) {
  const system = {
    price: { value: priceGp, denomination: "gp" },
  };
  if (includeQuantity) system.quantity = quantity;
  const source = {
    _id: id,
    name,
    type,
    system,
    flags,
  };
  return {
    id,
    name,
    type,
    system,
    flags,
    toObject: () => clone(source),
  };
}

function ownedItemSource({
  id = "owned-item-0001",
  name = "Trinket",
  quantity = 1,
  priceGp = 10,
  type = "loot",
  flags = {},
} = {}) {
  return {
    _id: id,
    name,
    type,
    system: {
      quantity,
      price: { value: priceGp, denomination: "gp" },
    },
    flags,
  };
}

function buyRow({
  uuid = "Compendium.infinity-dnd5e.items.Item.catalog",
  qty = 20,
  unlimited = false,
  priceGp = 10,
} = {}) {
  return {
    uuid,
    qty,
    unlimited,
    priceOverrideGp: priceGp,
  };
}

function consume(queue, fallback = {}) {
  return queue.length > 0 ? queue.shift() : fallback;
}

function documentId(document) {
  return String(document?.id ?? document?._id ?? "");
}

function makeActor({
  id = "actor-1",
  currency = wallet(),
  items = [],
  faults = {},
} = {}) {
  const faultQueues = {
    currencyWrites: [...(faults.currencyWrites ?? [])],
    creates: [...(faults.creates ?? [])],
    deletes: [...(faults.deletes ?? [])],
    quantityWrites: [...(faults.quantityWrites ?? [])],
  };
  const calls = {
    currencyWrites: [],
    creates: [],
    deletes: [],
    quantityWrites: [],
  };
  const collection = new Map();

  const actor = {
    id,
    name: "Tester",
    system: { currency: clone(currency) },
    items: collection,
    _calls: calls,
    _faults: faultQueues,

    async update(patch) {
      const directive = consume(faultQueues.currencyWrites);
      calls.currencyWrites.push({ patch: clone(patch), directive });
      if (directive.throwBefore) throw new Error("currency update rejected");

      const expected = clone(actor.system.currency);
      for (const [path, value] of Object.entries(patch)) {
        const match = /^system\.currency\.(pp|gp|ep|sp|cp)$/.exec(path);
        if (match) expected[match[1]] = value;
      }
      if (directive.apply !== "none") {
        actor.system.currency =
          typeof directive.apply === "function"
            ? directive.apply(clone(expected), clone(actor.system.currency))
            : directive.wallet
              ? clone(directive.wallet)
              : expected;
      }
      directive.afterApply?.(actor, patch);
      if (directive.throwAfter) throw new Error("currency update lost reply");
      if (directive.return === "none") return undefined;
      if (directive.return === "wrong") return { id: "different-actor" };
      return actor;
    },

    async createEmbeddedDocuments(type, sources, options = {}) {
      assert.equal(type, "Item");
      const directive = consume(faultQueues.creates);
      calls.creates.push({
        sources: clone(sources),
        options: clone(options),
        directive,
      });
      if (directive.throwBefore) throw new Error("item create rejected");

      const created = [];
      if (directive.apply !== "none") {
        for (const input of sources) {
          const source = clone(input);
          if (directive.alter) directive.alter(source);
          const item = makeEmbeddedItem(actor, source);
          collection.set(item.id, item);
          created.push(item);
        }
      }
      directive.afterApply?.(actor, created);
      if (directive.throwAfter) throw new Error("item create lost reply");
      if (directive.return === "empty") return [];
      if (directive.return === "wrong") {
        return [{ id: "different-item", _id: "different-item" }];
      }
      return created;
    },

    async deleteEmbeddedDocuments(type, ids) {
      assert.equal(type, "Item");
      const directive = consume(faultQueues.deletes);
      const before = ids
        .map((itemId) => collection.get(itemId))
        .filter(Boolean);
      calls.deletes.push({ ids: [...ids], directive });
      if (directive.throwBefore) throw new Error("item delete rejected");
      if (directive.apply !== "none") {
        for (const itemId of ids) collection.delete(itemId);
      }
      directive.afterApply?.(actor, before);
      if (directive.throwAfter) throw new Error("item delete lost reply");
      if (directive.return === "empty") return [];
      if (directive.return === "wrong") {
        return [{ id: "different-item", _id: "different-item" }];
      }
      return before;
    },
  };

  actor.seedItem = (source) => {
    const item = makeEmbeddedItem(actor, clone(source));
    collection.set(item.id, item);
    return item;
  };
  for (const source of items) actor.seedItem(source);
  return actor;
}

function makeEmbeddedItem(actor, input) {
  const source = clone(input);
  source._id = String(source._id ?? source.id ?? "");
  delete source.id;

  const item = {
    get id() {
      return source._id;
    },
    get _id() {
      return source._id;
    },
    get name() {
      return source.name;
    },
    get type() {
      return source.type;
    },
    get system() {
      return source.system;
    },
    get flags() {
      return source.flags;
    },
    toObject: () => clone(source),

    async update(patch) {
      const directive = consume(actor._faults.quantityWrites);
      actor._calls.quantityWrites.push({
        itemId: source._id,
        patch: clone(patch),
        directive,
      });
      if (directive.throwBefore) throw new Error("quantity update rejected");
      if (directive.apply !== "none") {
        const expected = Number(patch["system.quantity"]);
        source.system ??= {};
        source.system.quantity =
          directive.quantity === undefined ? expected : directive.quantity;
      }
      directive.afterApply?.(actor, item);
      if (directive.throwAfter) throw new Error("quantity update lost reply");
      if (directive.return === "none") return undefined;
      if (directive.return === "wrong") {
        return { id: "different-item", _id: "different-item" };
      }
      return item;
    },
  };
  return item;
}

function assertWallet(actor, expected, message) {
  assert.deepEqual(actor.system.currency, expected, message);
}

function assertItem(actor, itemId, expected, message) {
  const item = actor.items.get(itemId);
  assert.ok(item, message ?? `${itemId} should exist`);
  assert.deepEqual(item.toObject(), expected);
  return item;
}

function actorState(actor) {
  return {
    currency: clone(actor.system.currency),
    items: [...actor.items.values()]
      .map((item) => item.toObject())
      .sort((left, right) => documentId(left).localeCompare(documentId(right))),
  };
}

function makeDurableBuyPlan(actor, overrides = {}) {
  return planDurableBuyActorTransaction({
    actor,
    merchant,
    row: buyRow(),
    item: catalogItem(),
    qty: 2,
    operationId: "durable-buy",
    ...overrides,
  });
}

function makeDurableSellPlan(actor, ownedItem, overrides = {}) {
  return planDurableSellActorTransaction({
    actor,
    merchant,
    ownedItem,
    qty: 1,
    ...overrides,
  });
}

function setDurableBoundary(actor, boundary) {
  actor.system.currency = clone(boundary.wallet);
  actor.items.clear();
  if (boundary.item) actor.seedItem(boundary.item);
}

/* Normal buys confirm both writes and preserve the post-create wallet boundary. */
{
  const actor = makeActor();
  const result = await executeBuy({
    actor,
    merchant,
    row: buyRow(),
    item: catalogItem(),
    qty: 2,
    operationId: "normal-buy",
    notify: false,
  });

  assert.equal(result.ok, true, "a confirmed buy succeeds");
  assert.equal(result.totalGp, 20);
  assert.equal(result.createdItemIds.length, 1);
  assert.equal(result.createdItemIds[0], merchantItemId("normal-buy"));
  assert.equal(actor.items.get(result.createdItemIds[0]).system.quantity, 2);
  assertWallet(actor, wallet({ gp: 80 }), "the exact price is deducted");
  assert.deepEqual(result.currencyBefore, wallet());
  assert.deepEqual(result.currencyAfter, wallet({ gp: 80 }));
  assert.equal(actor._calls.creates.length, 1);
  assert.equal(actor._calls.currencyWrites.length, 1);
}

/* Item-creation hooks define the payment/rollback boundary. */
{
  const actor = makeActor({
    faults: {
      creates: [
        {
          afterApply(currentActor) {
            currentActor.system.currency.gp += 5;
          },
        },
      ],
    },
  });
  const result = await executeBuy({
    actor,
    merchant,
    row: buyRow(),
    item: catalogItem(),
    operationId: "post-create-wallet",
    notify: false,
  });

  assert.equal(result.ok, true);
  assert.deepEqual(
    result.currencyBefore,
    wallet({ gp: 105 }),
    "payment snapshots the wallet after item-creation hooks",
  );
  assertWallet(actor, wallet({ gp: 95 }));
  assert.equal(await rollbackBuyTransaction(actor, result), true);
  assertWallet(
    actor,
    wallet({ gp: 105 }),
    "rollback preserves unrelated hook currency changes",
  );
  assert.equal(actor.items.size, 0);
}

/* Quantity is strict, and an item without a quantity field cannot be bulk-bought. */
{
  const actor = makeActor();
  const fractional = await executeBuy({
    actor,
    merchant,
    row: buyRow(),
    item: catalogItem(),
    qty: 1.5,
    operationId: "fractional-buy",
    notify: false,
  });
  assert.equal(fractional.reason, "invalid-quantity");

  const nonStackable = await executeBuy({
    actor,
    merchant,
    row: buyRow(),
    item: catalogItem({
      type: "feat",
      includeQuantity: false,
    }),
    qty: 2,
    operationId: "non-stackable-buy",
    notify: false,
  });
  assert.equal(nonStackable.reason, "not-stackable");
  assert.equal(actor._calls.creates.length, 0);
  assert.equal(actor._calls.currencyWrites.length, 0);
  assert.equal(actor.items.size, 0);
}

/* Unsafe prices and payout overflow reject before any Actor mutation. */
{
  const buyActor = makeActor();
  const buyResult = await executeBuy({
    actor: buyActor,
    merchant,
    row: buyRow({ priceGp: Number.MAX_VALUE }),
    item: catalogItem(),
    operationId: "overflow-buy",
    notify: false,
  });
  assert.equal(buyResult.ok, false);
  assert.equal(buyResult.reason, "invalid-price");
  assert.equal(buyActor._calls.creates.length, 0);
  assert.equal(buyActor._calls.currencyWrites.length, 0);

  const saleSource = ownedItemSource({ priceGp: Number.MAX_VALUE });
  const saleActor = makeActor({ items: [saleSource] });
  const saleResult = await executeSell({
    actor: saleActor,
    merchant,
    ownedItem: saleActor.items.get(saleSource._id),
    qty: 1,
    notify: false,
  });
  assert.equal(saleResult.ok, false);
  assert.equal(saleResult.reason, "invalid-price");
  assert.equal(saleActor._calls.deletes.length, 0);
  assert.equal(saleActor._calls.currencyWrites.length, 0);
  assertItem(saleActor, saleSource._id, saleSource);

  const nearLimitGp = Math.floor(Number.MAX_SAFE_INTEGER / 100);
  const payoutSource = ownedItemSource({ priceGp: 2 });
  const payoutActor = makeActor({
    currency: wallet({ gp: nearLimitGp }),
    items: [payoutSource],
  });
  const payoutResult = await executeSell({
    actor: payoutActor,
    merchant,
    ownedItem: payoutActor.items.get(payoutSource._id),
    qty: 1,
    notify: false,
  });
  assert.equal(payoutResult.ok, false);
  assert.equal(payoutResult.reason, "invalid-wallet");
  assert.equal(payoutActor._calls.deletes.length, 0);
  assert.equal(payoutActor._calls.currencyWrites.length, 0);
  assertItem(payoutActor, payoutSource._id, payoutSource);
}

/* A create that applies but returns no document is cleaned up without a charge. */
{
  const actor = makeActor({
    faults: {
      creates: [{ return: "empty" }],
    },
  });
  const result = await executeBuy({
    actor,
    merchant,
    row: buyRow(),
    item: catalogItem(),
    operationId: "lost-create-return",
    notify: false,
  });

  assert.equal(result.ok, false);
  assert.equal(result.reason, "create-unconfirmed");
  assert.equal(actor._calls.creates.length, 1);
  assert.equal(
    actor._calls.deletes.length,
    1,
    "the unconfirmed item is removed",
  );
  assert.equal(actor.items.size, 0);
  assert.equal(
    actor._calls.currencyWrites.length,
    0,
    "no payment is attempted",
  );
  assertWallet(actor, wallet());
}

/* No-op and partial payments both restore the exact pre-payment state. */
for (const [label, firstWrite] of [
  ["no-op", { apply: "none" }],
  ["partial", { wallet: wallet({ gp: 95 }) }],
]) {
  const actor = makeActor({
    faults: {
      currencyWrites: [firstWrite, {}],
    },
  });
  const result = await executeBuy({
    actor,
    merchant,
    row: buyRow(),
    item: catalogItem(),
    operationId: `failed-${label}-payment`,
    notify: false,
  });

  assert.equal(result.ok, false, `${label} payment fails`);
  assert.equal(result.reason, "payment-unconfirmed");
  assert.equal(actor.items.size, 0, `${label} payment removes delivered item`);
  assertWallet(actor, wallet(), `${label} payment restores the wallet`);
}

/* If a refund cannot settle after item removal, compensation restores completion. */
{
  const actor = makeActor({
    faults: {
      currencyWrites: [{ wallet: wallet({ gp: 95 }) }, { apply: "none" }, {}],
      creates: [{}, {}],
      deletes: [{}],
    },
  });
  const result = await executeBuy({
    actor,
    merchant,
    row: buyRow(),
    item: catalogItem(),
    operationId: "buy-refund-reversal",
    notify: false,
  });
  const expectedItemId = merchantItemId("buy-refund-reversal");

  assert.equal(result.ok, false);
  assert.equal(result.reason, "compensation-failed");
  assertWallet(
    actor,
    wallet({ gp: 90 }),
    "the completed payment is re-established",
  );
  assert.equal(
    actor.items.get(expectedItemId)?.system.quantity,
    1,
    "the exact purchased item is re-established",
  );
  assert.equal(
    actor.items.get(expectedItemId)?.flags?.["infinity-dnd5e"]
      ?.purchasedFromMerchant?.operationId,
    "buy-refund-reversal",
  );
}

/* A normal decrement sale confirms quantity first, then credits exact coin. */
{
  const source = ownedItemSource({ quantity: 3, priceGp: 10 });
  const actor = makeActor({ items: [source] });
  const owned = actor.items.get(source._id);
  const result = await executeSell({
    actor,
    merchant,
    ownedItem: owned,
    qty: 1,
    notify: false,
  });

  assert.equal(result.ok, true, "a confirmed sale succeeds");
  assert.equal(result.totalGp, 5);
  assert.equal(actor.items.get(source._id).system.quantity, 2);
  assertWallet(actor, wallet({ gp: 105 }));
  assert.equal(actor._calls.quantityWrites.length, 1);
  assert.equal(actor._calls.currencyWrites.length, 1);
}

/* Fractional request and malformed canonical stack quantities are rejected. */
{
  const source = ownedItemSource({ quantity: 3 });
  const actor = makeActor({ items: [source] });
  const result = await executeSell({
    actor,
    merchant,
    ownedItem: actor.items.get(source._id),
    qty: 1.5,
    notify: false,
  });
  assert.equal(result.reason, "invalid-quantity");
  assert.equal(actor._calls.quantityWrites.length, 0);
  assert.equal(actor._calls.currencyWrites.length, 0);
}
{
  const source = ownedItemSource({ quantity: 1.5 });
  const actor = makeActor({ items: [source] });
  const result = await executeSell({
    actor,
    merchant,
    ownedItem: actor.items.get(source._id),
    qty: 1,
    notify: false,
  });
  assert.equal(result.reason, "invalid-quantity");
  assert.equal(actor._calls.quantityWrites.length, 0);
  assert.equal(actor._calls.currencyWrites.length, 0);
}

/* Empty stacks cannot produce a phantom payout. */
{
  const source = ownedItemSource({ quantity: 0 });
  const actor = makeActor({ items: [source] });
  const result = await executeSell({
    actor,
    merchant,
    ownedItem: actor.items.get(source._id),
    qty: 1,
    notify: false,
  });
  assert.equal(result.reason, "not-enough");
  assert.equal(actor._calls.deletes.length, 0);
  assert.equal(actor._calls.currencyWrites.length, 0);
}

/* A delete no-op and a lost delete return both restore/retain without payout. */
for (const [label, directive] of [
  ["no-op", { apply: "none" }],
  ["lost-return", { return: "empty" }],
]) {
  const source = ownedItemSource({ quantity: 1 });
  const actor = makeActor({
    items: [source],
    faults: { deletes: [directive] },
  });
  const result = await executeSell({
    actor,
    merchant,
    ownedItem: actor.items.get(source._id),
    qty: 1,
    notify: false,
  });

  assert.equal(result.ok, false, `${label} delete fails`);
  assert.equal(result.reason, "remove-unconfirmed");
  assertItem(actor, source._id, source);
  assert.equal(actor._calls.currencyWrites.length, 0, "no payout is attempted");
  assertWallet(actor, wallet());
}

/* A no-op or hook-altered decrement is restored before any payout. */
for (const [label, firstWrite] of [
  ["no-op", { apply: "none" }],
  ["altered", { quantity: 1 }],
]) {
  const source = ownedItemSource({ quantity: 3 });
  const actor = makeActor({
    items: [source],
    faults: {
      quantityWrites: [firstWrite, {}],
    },
  });
  const result = await executeSell({
    actor,
    merchant,
    ownedItem: actor.items.get(source._id),
    qty: 1,
    notify: false,
  });

  assert.equal(result.ok, false, `${label} decrement fails`);
  assert.equal(result.reason, "remove-unconfirmed");
  assert.equal(actor.items.get(source._id).system.quantity, 3);
  assert.equal(actor._calls.currencyWrites.length, 0, "no payout is attempted");
  assertWallet(actor, wallet());
}

/* No-op and partial payouts restore both the wallet and exact item id. */
for (const [label, firstWrite] of [
  ["no-op", { apply: "none" }],
  ["partial", { wallet: wallet({ gp: 102 }) }],
]) {
  const source = ownedItemSource({
    id: `payout-${label}-item`,
    quantity: 1,
  });
  const actor = makeActor({
    items: [source],
    faults: {
      currencyWrites: [firstWrite, {}],
      creates: [{}],
    },
  });
  const result = await executeSell({
    actor,
    merchant,
    ownedItem: actor.items.get(source._id),
    qty: 1,
    notify: false,
  });

  assert.equal(result.ok, false, `${label} payout fails`);
  assert.equal(result.reason, "payout-unconfirmed");
  assertItem(actor, source._id, source, "the original item id is restored");
  assertWallet(actor, wallet(), "the exact original wallet is restored");
}

/* A failed item restore after payout reversal returns to completed sale state. */
{
  const source = ownedItemSource({
    id: "sell-restore-reversal",
    quantity: 1,
  });
  const actor = makeActor({
    items: [source],
    faults: {
      currencyWrites: [{ wallet: wallet({ gp: 102 }) }, {}, {}],
      creates: [{ apply: "none", return: "empty" }],
    },
  });
  const result = await executeSell({
    actor,
    merchant,
    ownedItem: actor.items.get(source._id),
    qty: 1,
    notify: false,
  });

  assert.equal(result.ok, false);
  assert.equal(result.reason, "compensation-failed");
  assertWallet(
    actor,
    wallet({ gp: 105 }),
    "the completed payout is re-established",
  );
  assert.equal(
    actor.items.has(source._id),
    false,
    "the sold item stays absent",
  );
}

/* Fractional-gp payout has normalized lower denominations and exact value. */
{
  const source = ownedItemSource({ quantity: 1, priceGp: 4.8 });
  const actor = makeActor({ items: [source] });
  const result = await executeSell({
    actor,
    merchant,
    ownedItem: actor.items.get(source._id),
    qty: 1,
    notify: false,
  });
  assert.equal(result.ok, true);
  assert.equal(result.totalGp, 2.4);
  assert.ok(result.coinBreakdown.cp < 10);
  assert.ok(result.coinBreakdown.sp < 10);
  assertWallet(actor, wallet({ gp: 102, sp: 4 }));
}

/* Stolen goods never enter an ordinary sale and retain their exact state. */
{
  const source = ownedItemSource({
    id: "stolen-fencing-only",
    quantity: 1,
    flags: {
      "infinity-dnd5e": {
        stolen: {
          settlementId: "rivergate",
          operationId: "theft-1",
        },
      },
    },
  });
  const actor = makeActor({ items: [source] });
  const before = actorState(actor);
  const result = await executeSell({
    actor,
    merchant,
    ownedItem: actor.items.get(source._id),
    qty: 1,
    notify: false,
  });
  assert.equal(result.ok, false);
  assert.equal(result.reason, "stolen-requires-fence");
  assert.deepEqual(actorState(actor), before);
}

/* The authoritative issuance ledger still blocks a sale after flag stripping. */
{
  const source = ownedItemSource({
    id: "ledger-issued-flag-stripped",
    quantity: 1,
    flags: {},
  });
  const actor = makeActor({ items: [source] });
  const before = actorState(actor);
  const result = await executeSell({
    actor,
    merchant,
    ownedItem: actor.items.get(source._id),
    qty: 1,
    notify: false,
    requiresFencing: true,
  });
  assert.equal(result.ok, false);
  assert.equal(result.reason, "stolen-requires-fence");
  assert.deepEqual(actorState(actor), before);
}

/* Successful buy rollback is exact and idempotent. */
{
  const actor = makeActor();
  const result = await executeBuy({
    actor,
    merchant,
    row: buyRow(),
    item: catalogItem(),
    operationId: "repeat-buy-rollback",
    notify: false,
  });
  assert.equal(result.ok, true);
  assert.equal(await rollbackBuyTransaction(actor, result), true);
  const once = actorState(actor);
  assert.equal(await rollbackBuyTransaction(actor, result), true);
  assert.deepEqual(actorState(actor), once);
  assert.deepEqual(once, { currency: wallet(), items: [] });
}

/* Whole-stack sale rollback restores the exact original id and is idempotent. */
{
  const source = ownedItemSource({
    id: "exact-original-id",
    name: "Named Relic",
    quantity: 1,
    priceGp: 12,
  });
  const actor = makeActor({ items: [source] });
  const result = await executeSell({
    actor,
    merchant,
    ownedItem: actor.items.get(source._id),
    qty: 1,
    notify: false,
  });
  assert.equal(result.ok, true);
  assert.equal(actor.items.has(source._id), false);
  assert.equal(await rollbackSellTransaction(actor, result), true);
  assertItem(actor, source._id, source);
  assertWallet(actor, wallet());

  const once = actorState(actor);
  assert.equal(await rollbackSellTransaction(actor, result), true);
  assert.deepEqual(actorState(actor), once);
}

/* A different item occupying the original id is never mutated or deleted. */
{
  const original = ownedItemSource({
    id: "collision-item-id",
    name: "Same-Looking Item",
    quantity: 1,
    priceGp: 10,
    flags: { provenance: "original" },
  });
  original.system.description = { value: "original source" };
  const collision = ownedItemSource({
    id: original._id,
    name: original.name,
    quantity: 7,
    priceGp: 10,
    flags: { provenance: "replacement" },
  });
  collision.system.description = { value: "different source" };
  const actor = makeActor({ items: [original] });
  const result = await executeSell({
    actor,
    merchant,
    ownedItem: actor.items.get(original._id),
    qty: 1,
    notify: false,
  });
  assert.equal(result.ok, true);
  actor.seedItem(collision);

  assert.equal(
    await rollbackSellTransaction(actor, result),
    false,
    "identity collision blocks rollback",
  );
  assertItem(
    actor,
    collision._id,
    collision,
    "the unrelated colliding item remains untouched",
  );
  assertWallet(
    actor,
    wallet({ gp: 105 }),
    "failed rollback returns to completed payout state",
  );
}

/* ------------------------------------------------------------------ *
 * Durable Actor plans and forward-only recovery
 * ------------------------------------------------------------------ */

{
  const actor = makeActor();
  const plan = makeDurableBuyPlan(actor);
  assert.equal(plan.ok, true);
  assert.equal(Object.isFrozen(plan), true);
  assert.equal(Object.isFrozen(plan.actor.before), true);
  assert.equal(plan.actor.itemId, merchantItemId("durable-buy"));
  assert.equal(plan.actor.before.item, null);
  assert.equal(plan.actor.after.item._id, plan.actor.itemId);
  assert.equal(plan.actor.after.item.system.quantity, 2);
  assert.deepEqual(plan.actor.before.wallet, wallet());
  assert.deepEqual(plan.actor.after.wallet, wallet({ gp: 80 }));
  const observed = readMerchantActorBoundary(actor, plan.actor.itemId);
  assert.equal(observed.ok, true);
  assert.deepEqual(observed.boundary, plan.actor.before);
}

/* Durable buy snapshots keep failure-tier Infinity bounds out of JSON state. */
{
  const actor = makeActor();
  const plan = makeDurableBuyPlan(actor, {
    seal: {
      sealId: "failure-seal",
      tier: { id: "failure", minMargin: -Infinity, deltaPct: 10 },
      deltaPct: 10,
    },
  });
  assert.equal(plan.ok, true);
  assert.deepEqual(
    plan.actor.after.item.flags["infinity-dnd5e"].purchasedFromMerchant
      .bargainTier,
    { id: "failure" },
  );
}

{
  const actor = makeActor();
  assert.equal(
    makeDurableBuyPlan(actor, { row: buyRow({ qty: 1 }) }).reason,
    "out-of-stock",
  );
  const stolen = ownedItemSource({
    id: "durable-stolen",
    flags: { ["infinity-dnd5e"]: { stolen: { operationId: "theft" } } },
  });
  const seller = makeActor({ items: [stolen] });
  assert.equal(
    makeDurableSellPlan(seller, seller.items.get(stolen._id)).reason,
    "stolen-requires-fence",
  );
}

/* Buy: both components before are applied item-first, then wallet. */
{
  const actor = makeActor();
  const plan = makeDurableBuyPlan(actor, {
    operationId: "durable-buy-all-before",
  });
  const result = await applyDurableMerchantActorPlan(actor, plan);
  assert.equal(result.ok, true);
  assert.equal(result.action, "applied");
  assert.deepEqual(result.writes, ["item", "wallet"]);
  assert.equal(actor._calls.creates.length, 1);
  assert.equal(actor._calls.currencyWrites.length, 1);
  assert.deepEqual(
    readMerchantActorBoundary(actor, plan.actor.itemId).boundary,
    plan.actor.after,
  );
}

/* Buy: item-after hybrid skips create and drives only the wallet. */
{
  const actor = makeActor();
  const plan = makeDurableBuyPlan(actor, {
    operationId: "durable-buy-item-after",
  });
  setDurableBoundary(actor, {
    wallet: plan.actor.before.wallet,
    item: plan.actor.after.item,
  });
  const result = await applyDurableMerchantActorPlan(actor, plan.actor);
  assert.equal(result.ok, true);
  assert.deepEqual(result.writes, ["wallet"]);
  assert.equal(actor._calls.creates.length, 0);
  assert.equal(actor._calls.currencyWrites.length, 1);
}

/* Buy: wallet-after hybrid creates only the deterministic item. */
{
  const actor = makeActor();
  const plan = makeDurableBuyPlan(actor, {
    operationId: "durable-buy-wallet-after",
  });
  setDurableBoundary(actor, {
    wallet: plan.actor.after.wallet,
    item: plan.actor.before.item,
  });
  const result = await applyDurableMerchantActorPlan(actor, plan);
  assert.equal(result.ok, true);
  assert.deepEqual(result.writes, ["item"]);
  assert.equal(actor._calls.creates.length, 1);
  assert.equal(actor._calls.currencyWrites.length, 0);
}

/* Buy: all-after is an idempotent no-write success. */
{
  const actor = makeActor();
  const plan = makeDurableBuyPlan(actor, {
    operationId: "durable-buy-all-after",
  });
  setDurableBoundary(actor, plan.actor.after);
  const result = await applyDurableMerchantActorPlan(actor, plan);
  assert.equal(result.ok, true);
  assert.deepEqual(result.writes, []);
  assert.equal(actor._calls.creates.length, 0);
  assert.equal(actor._calls.currencyWrites.length, 0);
}

/* Buy: a true wallet third-state is quarantined before either write. */
{
  const actor = makeActor();
  const plan = makeDurableBuyPlan(actor, {
    operationId: "durable-buy-third-state",
  });
  actor.system.currency.gp = 99;
  const result = await applyDurableMerchantActorPlan(actor, plan);
  assert.equal(result.ok, false);
  assert.equal(result.action, "needs-review");
  assert.equal(result.reason, "third-state");
  assert.equal(result.walletState, "third-state");
  assert.equal(actor._calls.creates.length, 0);
  assert.equal(actor._calls.currencyWrites.length, 0);
}

/* Buy: pre-write authority loss is proven unapplied and writes nothing. */
{
  const actor = makeActor();
  const plan = makeDurableBuyPlan(actor, {
    operationId: "durable-buy-authority-pre",
  });
  const result = await applyDurableMerchantActorPlan(actor, plan, {
    authorizeWrite: () => false,
  });
  assert.equal(result.action, "reconcile");
  assert.equal(result.reason, "authority-lost");
  assert.equal(result.provenUnapplied, true);
  assert.deepEqual(result.writes, []);
  assert.equal(actor._calls.creates.length, 0);
  assert.equal(actor._calls.currencyWrites.length, 0);
}

/* Buy: apply-then-authority-loss stops before wallet and never compensates. */
{
  let authorized = true;
  const actor = makeActor({
    faults: {
      creates: [
        {
          afterApply() {
            authorized = false;
          },
        },
      ],
    },
  });
  const plan = makeDurableBuyPlan(actor, {
    operationId: "durable-buy-authority-post",
  });
  const result = await applyDurableMerchantActorPlan(actor, plan, {
    authorizeWrite: () => authorized,
  });
  assert.equal(result.action, "reconcile");
  assert.equal(result.reason, "authority-lost");
  assert.equal(result.provenUnapplied, false);
  assert.deepEqual(result.writes, ["item"]);
  assert.equal(actor._calls.creates.length, 1);
  assert.equal(actor._calls.deletes.length, 0);
  assert.equal(actor._calls.currencyWrites.length, 0);
  assert.ok(actor.items.has(plan.actor.itemId));
}

/* A sell planner freezes a reduced item, or null for the whole stack. */
{
  const source = ownedItemSource({ id: "durable-sell-plan", quantity: 3 });
  const actor = makeActor({ items: [source] });
  const partial = makeDurableSellPlan(actor, actor.items.get(source._id));
  assert.equal(partial.ok, true);
  assert.equal(partial.actor.before.item.system.quantity, 3);
  assert.equal(partial.actor.after.item.system.quantity, 2);
  assert.deepEqual(partial.actor.after.wallet, wallet({ gp: 105 }));

  const whole = makeDurableSellPlan(actor, actor.items.get(source._id), {
    qty: 3,
  });
  assert.equal(whole.ok, true);
  assert.equal(whole.actor.after.item, null);
}

/* Sell: both components before are driven to the exact reduced state. */
{
  const source = ownedItemSource({
    id: "durable-sell-all-before",
    quantity: 3,
  });
  const actor = makeActor({ items: [source] });
  const plan = makeDurableSellPlan(actor, actor.items.get(source._id));
  const result = await applyDurableMerchantActorPlan(actor, plan);
  assert.equal(result.ok, true);
  assert.deepEqual(result.writes, ["item", "wallet"]);
  assert.equal(actor._calls.quantityWrites.length, 1);
  assert.equal(actor._calls.currencyWrites.length, 1);
  assert.deepEqual(
    readMerchantActorBoundary(actor, plan.actor.itemId).boundary,
    plan.actor.after,
  );
}

/* Sell: item-after hybrid skips removal and applies only payout. */
{
  const source = ownedItemSource({
    id: "durable-sell-item-after",
    quantity: 3,
  });
  const actor = makeActor({ items: [source] });
  const plan = makeDurableSellPlan(actor, actor.items.get(source._id));
  setDurableBoundary(actor, {
    wallet: plan.actor.before.wallet,
    item: plan.actor.after.item,
  });
  const result = await applyDurableMerchantActorPlan(actor, plan);
  assert.equal(result.ok, true);
  assert.deepEqual(result.writes, ["wallet"]);
  assert.equal(actor._calls.quantityWrites.length, 0);
  assert.equal(actor._calls.currencyWrites.length, 1);
}

/* Sell: wallet-after hybrid reduces only the item. */
{
  const source = ownedItemSource({
    id: "durable-sell-wallet-after",
    quantity: 3,
  });
  const actor = makeActor({ items: [source] });
  const plan = makeDurableSellPlan(actor, actor.items.get(source._id));
  setDurableBoundary(actor, {
    wallet: plan.actor.after.wallet,
    item: plan.actor.before.item,
  });
  const result = await applyDurableMerchantActorPlan(actor, plan);
  assert.equal(result.ok, true);
  assert.deepEqual(result.writes, ["item"]);
  assert.equal(actor._calls.quantityWrites.length, 1);
  assert.equal(actor._calls.currencyWrites.length, 0);
}

/* Sell: all-after is an idempotent no-write success. */
{
  const source = ownedItemSource({ id: "durable-sell-all-after", quantity: 3 });
  const actor = makeActor({ items: [source] });
  const plan = makeDurableSellPlan(actor, actor.items.get(source._id));
  setDurableBoundary(actor, plan.actor.after);
  const result = await applyDurableMerchantActorPlan(actor, plan);
  assert.equal(result.ok, true);
  assert.deepEqual(result.writes, []);
  assert.equal(actor._calls.quantityWrites.length, 0);
  assert.equal(actor._calls.currencyWrites.length, 0);
}

/* Sell: a true item third-state is quarantined with zero writes. */
{
  const source = ownedItemSource({
    id: "durable-sell-third-state",
    quantity: 3,
  });
  const actor = makeActor({ items: [source] });
  const plan = makeDurableSellPlan(actor, actor.items.get(source._id));
  actor.items.get(source._id).system.quantity = 99;
  const result = await applyDurableMerchantActorPlan(actor, plan);
  assert.equal(result.action, "needs-review");
  assert.equal(result.reason, "third-state");
  assert.equal(result.itemState, "third-state");
  assert.equal(actor._calls.quantityWrites.length, 0);
  assert.equal(actor._calls.currencyWrites.length, 0);
}

/* Sell: payout apply-then-authority-loss is returned for reconciliation. */
{
  let authorized = true;
  const source = ownedItemSource({
    id: "durable-sell-authority-post",
    quantity: 3,
  });
  const actor = makeActor({
    items: [source],
    faults: {
      currencyWrites: [
        {
          afterApply() {
            authorized = false;
          },
        },
      ],
    },
  });
  const plan = makeDurableSellPlan(actor, actor.items.get(source._id));
  setDurableBoundary(actor, {
    wallet: plan.actor.before.wallet,
    item: plan.actor.after.item,
  });
  const result = await applyDurableMerchantActorPlan(actor, plan, {
    authorizeWrite: () => authorized,
  });
  assert.equal(result.action, "reconcile");
  assert.equal(result.reason, "authority-lost");
  assert.equal(result.component, "wallet");
  assert.equal(result.provenUnapplied, false);
  assert.equal(actor._calls.quantityWrites.length, 0);
  assert.equal(actor._calls.currencyWrites.length, 1);
}

process.stdout.write("merchant-transaction validation passed\n");
