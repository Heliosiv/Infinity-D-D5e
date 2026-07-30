import assert from "node:assert/strict";

import {
  createActorItemVerified,
  deleteActorItemVerified,
  ensureActorItemQuantity,
  ensureActorItemsAbsent,
  findActorItem,
  merchantItemId,
  updateActorItemQuantityVerified,
} from "./merchant/write-verification.js";

const MODULE_ID = "infinity-dnd5e";

function cloneSource(source) {
  return structuredClone(source);
}

function itemSource({
  id,
  name = "Healing Potion",
  type = "consumable",
  quantity = 1,
  operationId = "",
} = {}) {
  const source = {
    _id: id,
    name,
    type,
    system: { quantity },
    flags: {},
  };
  if (operationId) {
    source.flags[MODULE_ID] = {
      purchasedFromMerchant: { operationId },
    };
  }
  return source;
}

function makeItem(source, { updateMode = "apply-return" } = {}) {
  const item = {
    ...cloneSource(source),
    id: String(source._id ?? source.id),
    updateCalls: [],
    toObject() {
      return {
        _id: this.id,
        name: this.name,
        type: this.type,
        system: cloneSource(this.system),
        flags: cloneSource(this.flags ?? {}),
      };
    },
    async update(update) {
      this.updateCalls.push(cloneSource(update));
      if (updateMode === "throw") throw new Error("quantity update denied");
      if (updateMode !== "noop-return") {
        const target = Number(update["system.quantity"]);
        this.system.quantity =
          updateMode === "apply-wrong-return" ? target + 1 : target;
      }
      if (updateMode === "apply-undefined") return undefined;
      return this;
    },
  };
  return item;
}

function makeActor({
  id = "synthetic-hero",
  createMode = "apply-return",
  deleteMode = "apply-return",
  createdItemUpdateMode = "apply-return",
} = {}) {
  const items = new Map();
  const actor = {
    id,
    items,
    createCalls: [],
    deleteCalls: [],
    seed(source, options) {
      const item = makeItem(source, options);
      items.set(item.id, item);
      return item;
    },
    async createEmbeddedDocuments(type, sources, options) {
      this.createCalls.push({
        type,
        sources: cloneSource(sources),
        options: cloneSource(options),
      });
      if (createMode === "throw") throw new Error("item creation denied");
      if (createMode === "noop-empty") return [];

      const source = cloneSource(sources[0]);
      if (createMode === "apply-wrong-identity") {
        source.name = "Hook Replacement";
      }
      if (createMode === "apply-wrong-quantity") {
        source.system.quantity += 1;
      }
      const item = makeItem(source, {
        updateMode: createdItemUpdateMode,
      });
      items.set(item.id, item);
      if (createMode === "apply-empty") return [];
      if (createMode === "apply-wrong-return") {
        return [{ id: "wrong-return-id" }];
      }
      return [item];
    },
    async deleteEmbeddedDocuments(type, ids) {
      this.deleteCalls.push({ type, ids: [...ids] });
      const deleted = ids.map((itemId) => items.get(itemId)).filter(Boolean);
      if (deleteMode === "throw") throw new Error("item deletion denied");
      if (deleteMode === "noop-empty") return [];
      for (const itemId of ids) items.delete(itemId);
      if (deleteMode === "throw-after-apply") {
        throw new Error("delete hook failed after apply");
      }
      if (deleteMode === "apply-empty") return [];
      if (deleteMode === "apply-wrong-return") {
        return [{ id: "wrong-return-id" }];
      }
      return deleted;
    },
  };
  return actor;
}

function purchaseSource(operationId, quantity = 2) {
  return itemSource({
    id: merchantItemId(operationId),
    operationId,
    quantity,
  });
}

/* ------------------------------------------------------------------ *
 * Stable merchant item ids
 * ------------------------------------------------------------------ */
{
  const first = merchantItemId("session-a:commit-1:hero:buy");
  const repeat = merchantItemId("session-a:commit-1:hero:buy");
  const other = merchantItemId("session-a:commit-2:hero:buy");
  assert.equal(first, repeat);
  assert.notEqual(first, other);
  assert.match(first, /^[a-z0-9]{16}$/i);
}

/* ------------------------------------------------------------------ *
 * Verified creates
 * ------------------------------------------------------------------ */
{
  const actor = makeActor({ id: "shared-actor-id" });
  const worldActor = makeActor({ id: "shared-actor-id" });
  const operationId = "session-a:create-success";
  const snapshot = purchaseSource(operationId);
  const previousGame = globalThis.game;
  globalThis.game = { actors: { get: () => worldActor } };
  try {
    const result = await createActorItemVerified(actor, snapshot);
    assert.equal(result.ok, true);
    assert.equal(result.itemId, snapshot._id);
    assert.equal(result.actualQuantity, 2);
    assert.equal(findActorItem(actor, snapshot._id), result.item);
    assert.equal(worldActor.items.size, 0);
    assert.equal(worldActor.createCalls.length, 0);
    assert.deepEqual(actor.createCalls[0].options, {
      keepId: true,
      keepEmbeddedIds: true,
    });
  } finally {
    if (previousGame === undefined) delete globalThis.game;
    else globalThis.game = previousGame;
  }
}

{
  const actor = makeActor({ createMode: "noop-empty" });
  const snapshot = purchaseSource("session-a:create-noop");
  const result = await createActorItemVerified(actor, snapshot);
  assert.equal(result.ok, false);
  assert.equal(result.reason, "create-unconfirmed");
  assert.equal(result.returnConfirmed, false);
  assert.equal(result.canonicalConfirmed, false);
  assert.deepEqual(result.itemIds, []);
}

{
  const actor = makeActor({
    createMode: "apply-empty",
    deleteMode: "apply-empty",
  });
  const snapshot = purchaseSource("session-a:create-apply-empty");
  const result = await createActorItemVerified(actor, snapshot);
  assert.equal(result.ok, false);
  assert.equal(result.reason, "create-unconfirmed");
  assert.equal(result.returnConfirmed, false);
  assert.equal(result.canonicalConfirmed, true);
  assert.deepEqual(result.itemIds, [snapshot._id]);

  const compensated = await ensureActorItemsAbsent(actor, result.itemIds);
  assert.equal(compensated.ok, true);
  assert.equal(findActorItem(actor, snapshot._id), null);
}

{
  const actor = makeActor({ createMode: "apply-wrong-return" });
  const snapshot = purchaseSource("session-a:create-wrong-return");
  const result = await createActorItemVerified(actor, snapshot);
  assert.equal(result.ok, false);
  assert.equal(result.reason, "create-unconfirmed");
  assert.equal(result.returnConfirmed, false);
  assert.equal(result.canonicalConfirmed, true);
}

{
  const actor = makeActor({ createMode: "apply-wrong-identity" });
  const snapshot = purchaseSource("session-a:create-wrong-identity");
  const result = await createActorItemVerified(actor, snapshot);
  assert.equal(result.ok, false);
  assert.equal(result.reason, "create-unconfirmed");
  assert.equal(result.returnConfirmed, true);
  assert.equal(result.canonicalConfirmed, false);
}

{
  const actor = makeActor({ createMode: "apply-wrong-quantity" });
  const snapshot = purchaseSource("session-a:create-wrong-quantity");
  const result = await createActorItemVerified(actor, snapshot);
  assert.equal(result.ok, false);
  assert.equal(result.reason, "create-unconfirmed");
  assert.equal(result.actualQuantity, 3);
  assert.equal(result.canonicalConfirmed, false);
}

{
  const actor = makeActor();
  const snapshot = purchaseSource("session-a:create-conflict");
  actor.seed(
    itemSource({
      id: snapshot._id,
      name: "Unrelated Existing Item",
      quantity: 9,
    }),
  );
  const result = await createActorItemVerified(actor, snapshot);
  assert.equal(result.ok, false);
  assert.equal(result.reason, "create-conflict");
  assert.equal(result.preexisting, true);
  assert.equal(actor.createCalls.length, 0);
  assert.equal(
    findActorItem(actor, snapshot._id).name,
    "Unrelated Existing Item",
  );
}

/* ------------------------------------------------------------------ *
 * Verified deletes
 * ------------------------------------------------------------------ */
{
  const actor = makeActor();
  const source = itemSource({ id: "delete-success", quantity: 4 });
  actor.seed(source);
  const result = await deleteActorItemVerified(actor, source._id, {
    expectedBeforeQuantity: 4,
  });
  assert.equal(result.ok, true);
  assert.equal(result.returnConfirmed, true);
  assert.equal(result.canonicalConfirmed, true);
  assert.equal(findActorItem(actor, source._id), null);
}

{
  const actor = makeActor({ deleteMode: "noop-empty" });
  const source = itemSource({ id: "delete-noop", quantity: 4 });
  actor.seed(source);
  const result = await deleteActorItemVerified(actor, source._id, {
    expectedBeforeQuantity: 4,
  });
  assert.equal(result.ok, false);
  assert.equal(result.reason, "delete-unconfirmed");
  assert.equal(result.returnConfirmed, false);
  assert.equal(result.canonicalConfirmed, false);
  assert.ok(findActorItem(actor, source._id));
}

{
  const actor = makeActor({ deleteMode: "apply-empty" });
  const source = itemSource({ id: "delete-apply-empty", quantity: 4 });
  actor.seed(source);
  const result = await deleteActorItemVerified(actor, source._id, {
    expectedBeforeQuantity: 4,
  });
  assert.equal(result.ok, false);
  assert.equal(result.reason, "delete-unconfirmed");
  assert.equal(result.returnConfirmed, false);
  assert.equal(result.canonicalConfirmed, true);
  assert.equal(findActorItem(actor, source._id), null);
}

{
  const actor = makeActor({ deleteMode: "apply-wrong-return" });
  const source = itemSource({ id: "delete-wrong-return", quantity: 4 });
  actor.seed(source);
  const result = await deleteActorItemVerified(actor, source._id, {
    expectedBeforeQuantity: 4,
  });
  assert.equal(result.ok, false);
  assert.equal(result.reason, "delete-unconfirmed");
  assert.equal(result.returnConfirmed, false);
  assert.equal(result.canonicalConfirmed, true);
}

{
  const actor = makeActor();
  const source = itemSource({ id: "delete-stale", quantity: 3 });
  actor.seed(source);
  const result = await deleteActorItemVerified(actor, source._id, {
    expectedBeforeQuantity: 4,
  });
  assert.equal(result.ok, false);
  assert.equal(result.reason, "delete-precondition-failed");
  assert.equal(actor.deleteCalls.length, 0);
  assert.ok(findActorItem(actor, source._id));
}

/* ------------------------------------------------------------------ *
 * Verified quantity updates
 * ------------------------------------------------------------------ */
{
  const actor = makeActor();
  const item = actor.seed(itemSource({ id: "quantity-success", quantity: 5 }));
  const result = await updateActorItemQuantityVerified(actor, item, 3, {
    expectedBeforeQuantity: 5,
  });
  assert.equal(result.ok, true);
  assert.equal(result.returnConfirmed, true);
  assert.equal(result.canonicalConfirmed, true);
  assert.equal(item.system.quantity, 3);
}

{
  const actor = makeActor();
  const item = actor.seed(itemSource({ id: "quantity-noop", quantity: 5 }), {
    updateMode: "noop-return",
  });
  const result = await updateActorItemQuantityVerified(actor, item, 3, {
    expectedBeforeQuantity: 5,
  });
  assert.equal(result.ok, false);
  assert.equal(result.reason, "quantity-unconfirmed");
  assert.equal(result.returnConfirmed, true);
  assert.equal(result.canonicalConfirmed, false);
  assert.equal(item.system.quantity, 5);
}

{
  const actor = makeActor();
  const item = actor.seed(
    itemSource({ id: "quantity-apply-undefined", quantity: 5 }),
    { updateMode: "apply-undefined" },
  );
  const result = await updateActorItemQuantityVerified(actor, item, 3, {
    expectedBeforeQuantity: 5,
  });
  assert.equal(result.ok, false);
  assert.equal(result.reason, "quantity-unconfirmed");
  assert.equal(result.returnConfirmed, false);
  assert.equal(result.canonicalConfirmed, true);
  assert.equal(item.system.quantity, 3);
}

{
  const actor = makeActor();
  const item = actor.seed(itemSource({ id: "quantity-altered", quantity: 5 }), {
    updateMode: "apply-wrong-return",
  });
  const result = await updateActorItemQuantityVerified(actor, item, 3, {
    expectedBeforeQuantity: 5,
  });
  assert.equal(result.ok, false);
  assert.equal(result.reason, "quantity-unconfirmed");
  assert.equal(result.actualQuantity, 4);
}

{
  const actor = makeActor();
  const item = actor.seed(itemSource({ id: "quantity-stale", quantity: 4 }));
  const result = await updateActorItemQuantityVerified(actor, item, 3, {
    expectedBeforeQuantity: 5,
  });
  assert.equal(result.ok, false);
  assert.equal(result.reason, "quantity-precondition-failed");
  assert.equal(item.updateCalls.length, 0);
  assert.equal(item.system.quantity, 4);
}

/* ------------------------------------------------------------------ *
 * Compensation helpers use canonical final state
 * ------------------------------------------------------------------ */
{
  const actor = makeActor({ deleteMode: "apply-empty" });
  actor.seed(itemSource({ id: "compensate-delete", quantity: 1 }));
  const result = await ensureActorItemsAbsent(actor, [
    "compensate-delete",
    "already-absent",
  ]);
  assert.equal(result.ok, true);
  assert.deepEqual(result.remainingIds, []);
}

{
  const actor = makeActor({ deleteMode: "noop-empty" });
  actor.seed(itemSource({ id: "compensate-delete-noop", quantity: 1 }));
  const result = await ensureActorItemsAbsent(actor, [
    "compensate-delete-noop",
  ]);
  assert.equal(result.ok, false);
  assert.equal(result.reason, "delete-unconfirmed");
  assert.deepEqual(result.remainingIds, ["compensate-delete-noop"]);
}

{
  const actor = makeActor({ deleteMode: "throw-after-apply" });
  actor.seed(itemSource({ id: "compensate-delete-throw", quantity: 1 }));
  const result = await ensureActorItemsAbsent(actor, [
    "compensate-delete-throw",
  ]);
  assert.equal(
    result.ok,
    true,
    "canonical absence is sufficient for compensation after an API error",
  );
  assert.match(result.error.message, /after apply/);
}

{
  const actor = makeActor();
  const item = actor.seed(
    itemSource({ id: "compensate-quantity", quantity: 2 }),
    { updateMode: "apply-undefined" },
  );
  const result = await ensureActorItemQuantity(actor, item.id, 5, {
    expectedIdentity: item.toObject(),
  });
  assert.equal(result.ok, true);
  assert.equal(item.system.quantity, 5);
}

{
  const actor = makeActor();
  const item = actor.seed(
    itemSource({ id: "compensate-quantity-noop", quantity: 2 }),
    { updateMode: "noop-return" },
  );
  const result = await ensureActorItemQuantity(actor, item.id, 5, {
    expectedIdentity: item.toObject(),
  });
  assert.equal(result.ok, false);
  assert.equal(result.reason, "quantity-unconfirmed");
  assert.equal(item.system.quantity, 2);
}

{
  const actor = makeActor();
  const unrelated = actor.seed(
    itemSource({
      id: "compensate-identity-conflict",
      name: "Different Item",
      quantity: 2,
    }),
  );
  const expected = itemSource({
    id: unrelated.id,
    name: "Original Item",
    quantity: 5,
  });
  const result = await ensureActorItemQuantity(actor, unrelated.id, 5, {
    expectedIdentity: expected,
  });
  assert.equal(result.ok, false);
  assert.equal(result.reason, "quantity-unconfirmed");
  assert.equal(unrelated.system.quantity, 2);
  assert.equal(unrelated.updateCalls.length, 0);
}

process.stdout.write("merchant write-verification validation passed\n");
