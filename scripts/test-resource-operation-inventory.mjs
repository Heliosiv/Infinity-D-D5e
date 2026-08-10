import assert from "node:assert/strict";

import {
  buildDeterministicResourceItemId,
  buildResourceInventoryPlan,
  executeResourceInventoryOperation,
  observeResourceInventoryOperation,
  summarizeResourceInventoryPlan,
} from "./resource/operation-inventory.js";
import {
  createResourceInventoryOperation,
  createResourceOperation,
  createResourceOperationContext,
  markResourceInventoryOperationApplied,
  transitionResourceOperation,
} from "./resource/operation-ledger.js";

const guard = {
  authorityId: "gm-1",
  authorityEpoch: "epoch-1",
  leadershipGeneration: 4,
};

function taggedItem(id, resourceId, quantity, name = resourceId) {
  return {
    _id: id,
    name,
    type: "loot",
    system: { quantity },
    flags: { "infinity-dnd5e": { resourceTag: resourceId } },
  };
}

const resources = [
  {
    id: "water",
    label: "Water",
    scope: "per-character",
    perDay: 1,
    forageYields: "water",
    matching: { flagTag: "water", nameKeywords: [] },
  },
  {
    id: "light",
    label: "Torches",
    scope: "party",
    perDay: 3,
    forageYields: null,
    matching: { flagTag: "light", nameKeywords: [] },
  },
  {
    id: "food",
    label: "Rations",
    scope: "per-character",
    perDay: 1,
    forageYields: "food",
    matching: { flagTag: "food", nameKeywords: [] },
  },
];

function durablePlanRecord({
  runId,
  operations,
  roster,
  yields = [],
  partyStashId = "",
  days = 1,
} = {}) {
  const targetByActor = new Map(
    yields.map((entry) => [entry.actorId, entry.forageTarget]),
  );
  const createdAt = 2000;
  return transitionResourceOperation(
    createResourceOperation({
      operationId: `operation:${runId}`,
      runId,
      kind: "upkeep",
      trigger: "calendar",
      guard,
      context: createResourceOperationContext({
        rules: { partyStashId },
      }),
      day: 1,
      days,
      environment: {
        id: "limited",
        label: "Limited",
        dc: 12,
        foodDc: 12,
        waterDc: 12,
      },
      initiator: { userId: "gm-1", name: "GM" },
      actors: roster.map((entry) => ({
        actorId: entry.actorId,
        name: entry.name ?? entry.actorId,
        role: targetByActor.has(entry.actorId)
          ? "participant-inventory"
          : "inventory",
        forageTarget: targetByActor.get(entry.actorId) ?? null,
      })),
      createdAt,
    }),
    "planned",
    {
      guard,
      at: createdAt + 1,
      yields,
      operations,
    },
  );
}

function resolvedYield({
  actorId,
  forageTarget = "food-water",
  food = 0,
  water = 0,
  foodSuccess = food > 0,
  waterSuccess = water > 0,
} = {}) {
  return {
    actorId,
    forageTarget,
    rollTotal: 15,
    wisMod: 2,
    food,
    water,
    foodSuccess,
    waterSuccess,
    suppressedFood: false,
    suppressedWater: false,
  };
}

/* One immutable global plan: forage first, then configured Resource order. */
{
  const template = {
    name: "Water Supply",
    type: "consumable",
    system: { quantity: 99, uses: { value: 1 } },
  };
  let templateReads = 0;
  const input = {
    runId: "global-order",
    roster: [
      {
        actorId: "A",
        name: "Aster",
        consumes: true,
        drawFromId: "S",
        items: [taggedItem("a-light", "light", 2, "Torch")],
      },
      {
        actorId: "B",
        name: "Bram",
        consumes: true,
        drawFromId: "S",
        items: [],
      },
      {
        actorId: "S",
        name: "Party Stash",
        consumes: false,
        isStash: true,
        items: [
          taggedItem("s-food", "food", 1, "Rations"),
          taggedItem("s-light", "light", 2, "Torches"),
        ],
      },
    ],
    resources,
    partyStashId: "S",
    forage: {
      selectedIds: ["A", "B"],
      foraged: [
        {
          actorId: "A",
          success: true,
          foodSuccess: true,
          waterSuccess: true,
          food: 1,
          water: 2,
          forageTarget: "food-water",
        },
        {
          actorId: "B",
          success: true,
          foodSuccess: true,
          waterSuccess: true,
          food: 1,
          water: 2,
          forageTarget: "food-water",
        },
      ],
      forageTargets: { A: "food-water", B: "food-water" },
    },
    resolveTemplate: async (resource) => {
      templateReads += 1;
      await Promise.resolve();
      return resource.id === "water" ? template : null;
    },
  };

  const planned = await buildResourceInventoryPlan(input);
  assert.deepEqual(
    planned.operations.map((operation) => [
      operation.action,
      operation.actorId,
      operation.itemId,
      operation.resourceId,
      operation.beforeQuantity,
      operation.afterQuantity,
    ]),
    [
      ["create", "S", planned.operations[0].itemId, "water", 0, 4],
      ["update", "S", "s-food", "food", 1, 3],
      ["update", "S", planned.operations[0].itemId, "water", 4, 3],
      ["update", "S", planned.operations[0].itemId, "water", 3, 2],
      ["delete", "S", "s-light", "light", 2, 0],
      ["update", "A", "a-light", "light", 2, 1],
      ["update", "S", "s-food", "food", 3, 2],
      ["update", "S", "s-food", "food", 2, 1],
    ],
  );
  assert.deepEqual(
    planned.operations.map((operation) => operation.sequence),
    [0, 1, 2, 3, 4, 5, 6, 7],
  );
  assert.equal(templateReads, 1, "create template resolved once before return");
  assert.match(planned.operations[0].itemId, /^[A-Za-z0-9]{16}$/);
  assert.equal(
    planned.operations[0].itemSnapshot._id,
    planned.operations[0].itemId,
  );
  assert.equal(planned.operations[0].itemSnapshot.system.quantity, 4);
  assert.equal(
    planned.operations[0].itemSnapshot.flags["infinity-dnd5e"].resourceTag,
    "water",
  );
  assert.equal(planned.accounting.party.light.consumed, 3);
  assert.deepEqual(
    planned.accounting.perActor.map((row) => row.consumed),
    [
      { water: 1, food: 1 },
      { water: 1, food: 1 },
    ],
  );

  template.system.quantity = 777;
  assert.equal(
    planned.operations[0].itemSnapshot.system.quantity,
    4,
    "persistable snapshot does not retain the async template by reference",
  );

  const replay = await buildResourceInventoryPlan({
    ...input,
    resolveTemplate: async () => ({
      name: "Water Supply",
      type: "consumable",
      system: { quantity: 99, uses: { value: 1 } },
    }),
  });
  assert.deepEqual(
    replay.operations,
    planned.operations,
    "same snapshots reserve the same ids and exact ledger boundaries",
  );

  const durable = durablePlanRecord({
    runId: "global-order",
    operations: planned.operations,
    roster: input.roster,
    partyStashId: "S",
    yields: [
      resolvedYield({ actorId: "A", food: 1, water: 2 }),
      resolvedYield({ actorId: "B", food: 1, water: 2 }),
    ],
  });
  assert.equal(
    durable.plan.length,
    8,
    "the whole repeated-Item boundary chain is accepted by the ledger",
  );
  const summary = summarizeResourceInventoryPlan({
    record: durable,
    roster: input.roster.map(({ items: _items, ...entry }) => entry),
    resources,
    halfRations: false,
    waterEnabled: true,
  });
  assert.equal(summary.depositOperationCount, 2);
  assert.deepEqual(summary.forage, { food: 2, water: 4 });
  assert.deepEqual(summary.accounting, planned.accounting);
}

/* Shared per-character draws deplete in roster order. */
{
  const planned = await buildResourceInventoryPlan({
    runId: "shared-shortfall",
    roster: [
      {
        actorId: "A",
        name: "First",
        consumes: true,
        drawFromId: "S",
        items: [],
      },
      {
        actorId: "B",
        name: "Second",
        consumes: true,
        drawFromId: "S",
        items: [],
      },
      {
        actorId: "S",
        name: "Shared",
        consumes: false,
        isStash: true,
        items: [taggedItem("one-ration", "food", 1)],
      },
    ],
    resources: [resources[2]],
  });
  assert.equal(planned.operations.length, 1);
  assert.equal(planned.operations[0].action, "delete");
  assert.deepEqual(
    planned.accounting.perActor.map((row) => row.shortfalls.food),
    [0, 1],
  );
  const summary = summarizeResourceInventoryPlan({
    record: durablePlanRecord({
      runId: "shared-shortfall",
      operations: planned.operations,
      roster: [
        {
          actorId: "A",
          name: "First",
          consumes: true,
          drawFromId: "S",
        },
        {
          actorId: "B",
          name: "Second",
          consumes: true,
          drawFromId: "S",
        },
        {
          actorId: "S",
          name: "Shared",
          consumes: false,
          isStash: true,
        },
      ],
    }),
    roster: [
      {
        actorId: "A",
        name: "First",
        consumes: true,
        drawFromId: "S",
      },
      {
        actorId: "B",
        name: "Second",
        consumes: true,
        drawFromId: "S",
      },
      {
        actorId: "S",
        name: "Shared",
        consumes: false,
        isStash: true,
      },
    ],
    resources: [resources[2]],
  });
  assert.deepEqual(summary.accounting, planned.accounting);
}

/* A forage deposit can be consumed in the same plan and still report shortage. */
{
  const roster = [
    {
      actorId: "A",
      name: "Solo",
      consumes: true,
      drawFromId: "A",
      items: [],
    },
  ];
  const yields = [
    resolvedYield({
      actorId: "A",
      forageTarget: "food",
      food: 1,
      water: 0,
      foodSuccess: true,
      waterSuccess: false,
    }),
  ];
  const foodAtTwoPerDay = { ...resources[2], perDay: 2 };
  const planned = await buildResourceInventoryPlan({
    runId: "self-deposit-consume",
    roster,
    resources: [foodAtTwoPerDay],
    forage: {
      selectedIds: ["A"],
      foraged: [
        {
          actorId: "A",
          forageTarget: "food",
          success: true,
          foodSuccess: true,
          waterSuccess: false,
          food: 1,
          water: 0,
        },
      ],
      forageTargets: { A: "food" },
    },
  });
  assert.deepEqual(
    planned.operations.map((entry) => entry.action),
    ["create", "delete"],
  );
  const summary = summarizeResourceInventoryPlan({
    record: durablePlanRecord({
      runId: "self-deposit-consume",
      operations: planned.operations,
      roster,
      yields,
    }),
    roster: roster.map(({ items: _items, ...entry }) => entry),
    resources: [foodAtTwoPerDay],
  });
  assert.equal(summary.depositOperationCount, 1);
  assert.deepEqual(summary.forage, { food: 1, water: 0 });
  assert.deepEqual(summary.accounting, planned.accounting);
  assert.equal(summary.accounting.perActor[0].consumed.food, 1);
  assert.equal(summary.accounting.perActor[0].shortfalls.food, 1);
}

/* A party Resource with no Item writes remains a durable full shortfall. */
{
  const roster = [
    {
      actorId: "A",
      name: "Scout",
      consumes: true,
      drawFromId: "A",
      items: [],
    },
    {
      actorId: "S",
      name: "Empty Stash",
      consumes: false,
      isStash: true,
      items: [],
    },
  ];
  const planned = await buildResourceInventoryPlan({
    runId: "party-no-write-shortfall",
    roster,
    resources: [resources[1]],
  });
  assert.equal(planned.operations.length, 0);
  const summary = summarizeResourceInventoryPlan({
    record: durablePlanRecord({
      runId: "party-no-write-shortfall",
      operations: planned.operations,
      roster,
    }),
    roster: roster.map(({ items: _items, ...entry }) => entry),
    resources: [resources[1]],
  });
  assert.deepEqual(summary.accounting, planned.accounting);
  assert.deepEqual(summary.accounting.party.light, {
    consumed: 0,
    shortfall: 3,
    error: "",
  });
}

/* Stable ids include tuple boundaries and avoid a deterministic collision. */
{
  const base = {
    runId: "id-run",
    actorId: "actor",
    resourceId: "food",
    sequence: 3,
  };
  assert.equal(
    buildDeterministicResourceItemId(base),
    buildDeterministicResourceItemId({ ...base }),
  );
  assert.notEqual(
    buildDeterministicResourceItemId(base),
    buildDeterministicResourceItemId({ ...base, attempt: 1 }),
  );
  assert.notEqual(
    buildDeterministicResourceItemId(base),
    buildDeterministicResourceItemId({ ...base, resourceId: "water" }),
  );

  const collision = buildDeterministicResourceItemId({
    runId: "collision-run",
    actorId: "A",
    resourceId: "food",
    sequence: 0,
  });
  const planned = await buildResourceInventoryPlan({
    runId: "collision-run",
    roster: [
      {
        actorId: "A",
        name: "Aster",
        items: [taggedItem(collision, "poison", 1)],
      },
    ],
    resources: [resources[2]],
    includeConsumption: false,
    forage: {
      selectedIds: ["A"],
      foraged: [
        {
          actorId: "A",
          success: true,
          foodSuccess: true,
          waterSuccess: false,
          food: 2,
          water: 0,
          forageTarget: "food",
        },
      ],
    },
  });
  assert.equal(planned.operations[0].action, "create");
  assert.equal(
    planned.operations[0].itemId,
    buildDeterministicResourceItemId({
      runId: "collision-run",
      actorId: "A",
      resourceId: "food",
      sequence: 0,
      attempt: 1,
    }),
  );
}

function operation(action, overrides = {}) {
  const common = {
    runId: overrides.runId ?? `run-${action}`,
    sequence: 0,
    action,
    actorId: overrides.actorId ?? "actor-1",
    itemId: overrides.itemId ?? "item-1",
    resourceId: overrides.resourceId ?? "food",
    beforeQuantity: overrides.beforeQuantity ?? (action === "create" ? 0 : 4),
    afterQuantity:
      overrides.afterQuantity ??
      (action === "delete" ? 0 : action === "create" ? 3 : 2),
    itemSnapshot: null,
  };
  if (action === "create") {
    common.itemSnapshot =
      overrides.itemSnapshot ??
      taggedItem(common.itemId, common.resourceId, common.afterQuantity);
  }
  return createResourceInventoryOperation({ ...common, ...overrides });
}

/* Semantically reordered but ledger-canonical plans cannot forge a summary. */
{
  const runId = "late-forage-deposit";
  const roster = [
    {
      actorId: "A",
      name: "Consumer",
      consumes: true,
      drawFromId: "A",
    },
    {
      actorId: "B",
      name: "Forager",
      consumes: false,
      drawFromId: "B",
    },
  ];
  const yields = [
    resolvedYield({
      actorId: "B",
      forageTarget: "food",
      food: 1,
      water: 0,
      foodSuccess: true,
      waterSuccess: false,
    }),
  ];
  const reordered = [
    operation("update", {
      runId,
      sequence: 0,
      actorId: "A",
      itemId: "a-food",
      resourceId: "food",
      beforeQuantity: 2,
      afterQuantity: 1,
    }),
    operation("create", {
      runId,
      sequence: 1,
      actorId: "B",
      itemId: "b-food",
      resourceId: "food",
      beforeQuantity: 0,
      afterQuantity: 1,
      itemSnapshot: taggedItem("b-food", "food", 1),
    }),
  ];
  const record = durablePlanRecord({
    runId,
    operations: reordered,
    roster,
    yields,
  });
  assert.throws(
    () =>
      summarizeResourceInventoryPlan({
        record,
        roster,
        resources: [resources[2]],
      }),
    (error) => error?.code === "RESOURCE_INVENTORY_PLAN_SUMMARY_CONFLICT",
  );
}

{
  const runId = "resource-order-conflict";
  const roster = [
    {
      actorId: "A",
      name: "Consumer",
      consumes: true,
      drawFromId: "A",
    },
  ];
  const reordered = [
    operation("update", {
      runId,
      sequence: 0,
      actorId: "A",
      itemId: "food-stack",
      resourceId: "food",
      beforeQuantity: 2,
      afterQuantity: 1,
    }),
    operation("update", {
      runId,
      sequence: 1,
      actorId: "A",
      itemId: "water-stack",
      resourceId: "water",
      beforeQuantity: 2,
      afterQuantity: 1,
    }),
  ];
  const record = durablePlanRecord({
    runId,
    operations: reordered,
    roster,
  });
  assert.throws(
    () =>
      summarizeResourceInventoryPlan({
        record,
        roster,
        resources: [resources[0], resources[2]],
      }),
    (error) => error?.code === "RESOURCE_INVENTORY_PLAN_SUMMARY_CONFLICT",
  );
}

function applyingRecord(inventoryOperation) {
  const createdAt = 1000;
  const prepared = createResourceOperation({
    operationId: inventoryOperation.opId,
    runId: JSON.parse(inventoryOperation.opId)[1],
    kind: "upkeep",
    trigger: "manual",
    guard,
    context: createResourceOperationContext({ rules: "test" }),
    day: 1,
    days: 1,
    environment: {
      id: "limited",
      label: "Limited",
      dc: 12,
      foodDc: 12,
      waterDc: 12,
    },
    initiator: { userId: "gm-1", name: "GM" },
    actors: [
      {
        actorId: inventoryOperation.actorId,
        name: "Test Actor",
        role: "inventory",
        forageTarget: null,
      },
    ],
    createdAt,
  });
  const planned = transitionResourceOperation(prepared, "planned", {
    guard,
    at: createdAt + 1,
    yields: [],
    operations: [inventoryOperation],
  });
  return transitionResourceOperation(planned, "applying", {
    guard,
    at: createdAt + 2,
  });
}

function fakeActor(actorId, items = [], behavior = {}) {
  const itemMap = new Map(
    items.map((item) => [item._id, structuredClone(item)]),
  );
  const calls = [];
  return {
    id: actorId,
    items: itemMap,
    calls,
    async updateEmbeddedDocuments(_type, updates) {
      calls.push(["update", structuredClone(updates)]);
      const update = updates[0];
      behavior.beforeUpdate?.(this, update);
      if (behavior.update !== false) {
        const item = itemMap.get(update._id);
        item.system.quantity = update["system.quantity"];
      }
      behavior.afterUpdate?.(this, update);
      if (behavior.throwAfterUpdate) throw new Error("update crashed");
      return [itemMap.get(update._id)];
    },
    async createEmbeddedDocuments(_type, documents, options) {
      calls.push(["create", structuredClone(documents), { ...options }]);
      behavior.beforeCreate?.(this, documents[0]);
      if (behavior.create !== false) {
        itemMap.set(documents[0]._id, structuredClone(documents[0]));
      }
      behavior.afterCreate?.(this, documents[0]);
      if (behavior.throwAfterCreate) throw new Error("create crashed");
      return [itemMap.get(documents[0]._id)];
    },
    async deleteEmbeddedDocuments(_type, ids) {
      calls.push(["delete", [...ids]]);
      behavior.beforeDelete?.(this, ids[0]);
      if (behavior.delete !== false) itemMap.delete(ids[0]);
      behavior.afterDelete?.(this, ids[0]);
      if (behavior.throwAfterDelete) throw new Error("delete crashed");
      return ids;
    },
  };
}

const food = resources[2];

/* Canonical observation is exact and treats identity independently of quantity. */
{
  const op = operation("update");
  const actor = fakeActor("actor-1", [taggedItem("item-1", "food", 4)]);
  assert.deepEqual(
    observeResourceInventoryOperation(op, {
      actors: new Map([[actor.id, actor]]),
      resources: [food],
    }),
    { exists: true, quantity: 4, matchesResource: true },
  );
  actor.items.get("item-1").flags["infinity-dnd5e"].resourceTag = "poison";
  assert.deepEqual(
    observeResourceInventoryOperation(op, {
      actors: new Map([[actor.id, actor]]),
      resources: [food],
    }),
    { exists: true, quantity: 4, matchesResource: false },
  );
  actor.items.delete("item-1");
  assert.deepEqual(
    observeResourceInventoryOperation(op, {
      actors: new Map([[actor.id, actor]]),
      resources: [food],
    }),
    { exists: false, quantity: null, matchesResource: null },
  );
}

async function execute(op, actor, options = {}) {
  let authorityCalls = 0;
  const result = await executeResourceInventoryOperation({
    record: options.record ?? applyingRecord(op),
    operationId: op.opId,
    guard,
    actors: new Map([[actor.id, actor]]),
    resources: [food],
    assertWriteAllowed: async ({ operation: approved }) => {
      authorityCalls += 1;
      assert.equal(approved.opId, op.opId);
      options.onAuthority?.();
    },
  });
  return { result, authorityCalls };
}

/* Exact before applies one update; exact after and durable markers never write. */
{
  let authorityPassed = false;
  const op = operation("update");
  const record = applyingRecord(op);
  const actor = fakeActor("actor-1", [taggedItem("item-1", "food", 4)], {
    beforeUpdate() {
      assert.equal(
        authorityPassed,
        true,
        "authority runs immediately before write",
      );
    },
  });
  const first = await execute(op, actor, {
    record,
    onAuthority: () => {
      authorityPassed = true;
    },
  });
  assert.equal(first.result.action, "mark-applied");
  assert.deepEqual(first.result.before, {
    exists: true,
    quantity: 4,
    matchesResource: true,
  });
  assert.deepEqual(first.result.after, {
    exists: true,
    quantity: 2,
    matchesResource: true,
  });
  assert.equal(first.authorityCalls, 1);
  assert.equal(actor.calls.length, 1);

  const crashReplay = await execute(op, actor, { record });
  assert.equal(crashReplay.result.action, "mark-applied");
  assert.equal(crashReplay.result.writeAttempted, false);
  assert.equal(crashReplay.authorityCalls, 0);
  assert.equal(actor.calls.length, 1, "exact after-state is not written twice");

  const applied = markResourceInventoryOperationApplied(record, op.opId, {
    guard,
    at: 1003,
    observed: crashReplay.result.after,
  });
  const durableReplay = await execute(op, actor, { record: applied });
  assert.equal(durableReplay.result.action, "already-applied");
  assert.equal(durableReplay.result.writeAttempted, false);
  assert.equal(actor.calls.length, 1, "durable marker is also write-free");
}

/* Applied-then-threw is recovered canonically for update, create, and delete. */
for (const action of ["update", "create", "delete"]) {
  const op = operation(action, {
    runId: `throw-${action}`,
    itemId: `item-${action}`,
  });
  const initial =
    action === "create"
      ? []
      : [taggedItem(op.itemId, "food", op.beforeQuantity)];
  const actor = fakeActor("actor-1", initial, {
    throwAfterUpdate: action === "update",
    throwAfterCreate: action === "create",
    throwAfterDelete: action === "delete",
  });
  const { result, authorityCalls } = await execute(op, actor);
  assert.equal(
    result.action,
    "mark-applied",
    `${action} canonical after-state`,
  );
  assert.equal(result.writeAttempted, true);
  assert.match(result.writeError.message, /crashed/);
  assert.equal(authorityCalls, 1);
  assert.equal(actor.calls.length, 1);

  const replay = await execute(op, actor);
  assert.equal(replay.result.action, "mark-applied");
  assert.equal(replay.result.writeAttempted, false);
  assert.equal(
    actor.calls.length,
    1,
    `${action} is not duplicated after crash`,
  );
}

/* A thrown-before-apply stays at exact before; a third state needs review. */
{
  const op = operation("update", { runId: "before-state" });
  const actor = fakeActor("actor-1", [taggedItem("item-1", "food", 4)], {
    update: false,
    throwAfterUpdate: true,
  });
  const { result } = await execute(op, actor);
  assert.equal(result.action, "apply");
  assert.equal(result.reason, "canonical-before-state");
  assert.equal(result.writeAttempted, true);
}

/* Fractional canonical quantities are never rounded into before/after proof. */
for (const [label, quantity] of [
  ["fractional-before", 4.7],
  ["fractional-after", 2.7],
]) {
  const op = operation("update", { runId: label });
  const actor = fakeActor("actor-1", [taggedItem("item-1", "food", quantity)]);
  await assert.rejects(
    executeResourceInventoryOperation({
      record: applyingRecord(op),
      operationId: op.opId,
      guard,
      actors: new Map([[actor.id, actor]]),
      resources: [food],
      assertWriteAllowed: () => true,
    }),
    (error) => error?.code === "RESOURCE_INVENTORY_QUANTITY_INVALID",
  );
  assert.equal(actor.calls.length, 0, `${label} performs no write`);
}

/* Authority loss immediately before the write leaves inventory untouched. */
{
  const op = operation("update", { runId: "authority-loss" });
  const actor = fakeActor("actor-1", [taggedItem("item-1", "food", 4)]);
  await assert.rejects(
    executeResourceInventoryOperation({
      record: applyingRecord(op),
      operationId: op.opId,
      guard,
      actors: new Map([[actor.id, actor]]),
      resources: [food],
      assertWriteAllowed: () => {
        throw new Error("leadership lost");
      },
    }),
    /leadership lost/,
  );
  assert.equal(actor.calls.length, 0);
  assert.equal(actor.items.get("item-1").system.quantity, 4);
}

{
  const op = operation("update", { runId: "third-state" });
  const actor = fakeActor("actor-1", [taggedItem("item-1", "food", 4)], {
    afterUpdate(target) {
      target.items.get("item-1").system.quantity = 3;
    },
    throwAfterUpdate: true,
  });
  const { result } = await execute(op, actor);
  assert.equal(result.action, "needs-review");
  assert.equal(result.reason, "canonical-third-state");
  assert.equal(result.after.quantity, 3);
}

/* Identity mismatch before or after a write is quarantined, never retried. */
{
  const op = operation("update", { runId: "wrong-before" });
  const actor = fakeActor("actor-1", [taggedItem("item-1", "poison", 4)]);
  const { result, authorityCalls } = await execute(op, actor);
  assert.equal(result.action, "needs-review");
  assert.equal(result.reason, "resource-identity-mismatch");
  assert.equal(result.writeAttempted, false);
  assert.equal(authorityCalls, 0);
  assert.equal(actor.calls.length, 0);
}

{
  const op = operation("update", { runId: "wrong-after" });
  const actor = fakeActor("actor-1", [taggedItem("item-1", "food", 4)], {
    afterUpdate(target) {
      target.items.get("item-1").flags["infinity-dnd5e"].resourceTag = "poison";
    },
  });
  const { result } = await execute(op, actor);
  assert.equal(result.action, "needs-review");
  assert.equal(result.reason, "resource-identity-mismatch");
}

process.stdout.write("resource-operation-inventory validation passed\n");
