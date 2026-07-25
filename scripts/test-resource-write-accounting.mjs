import assert from "node:assert/strict";

import {
  applyConsumption,
  applyConsumptionOps,
  depositResource,
} from "./resource/calendar-watcher.js";

const savedFromUuid = globalThis.fromUuid;
const savedConsoleError = console.error;

try {
  {
    const rationStack = {
      id: "stash-rations",
      name: "Rations",
      system: { quantity: 3 },
      flags: { "infinity-dnd5e": { resourceTag: "food" } },
    };
    const hero = {
      id: "hero",
      name: "Aria",
      items: { contents: [] },
    };
    const stash = {
      id: "stash",
      name: "Pack Mule",
      items: { contents: [rationStack] },
      async updateEmbeddedDocuments(_type, updates) {
        rationStack.system.quantity = updates[0]["system.quantity"];
        return [
          {
            id: rationStack.id,
            system: { quantity: rationStack.system.quantity },
          },
        ];
      },
      async deleteEmbeddedDocuments() {
        return [];
      },
    };
    const heroEntry = {
      actor: hero,
      consumes: true,
      isStash: false,
      drawFromId: stash.id,
    };
    const stashEntry = {
      actor: stash,
      consumes: false,
      isStash: true,
      drawFromId: stash.id,
    };
    const report = await applyConsumption({
      roster: [heroEntry, stashEntry],
      sourceForMember: new Map([[hero.id, stash]]),
      cfg: {
        waterEnabled: false,
        halfRations: false,
        resources: [
          {
            id: "food",
            label: "Food",
            scope: "per-character",
            perDay: 1,
            forageYields: "food",
            matching: {
              itemUuids: [],
              nameKeywords: ["ration"],
              flagTag: "food",
            },
          },
        ],
      },
      days: 1,
    });
    assert.equal(
      rationStack.system.quantity,
      2,
      "the stash supplies the hero without consuming its own extra ration",
    );
    assert.deepEqual(
      report.perActor.map((row) => row.actorId),
      ["hero"],
      "inventory-only actors do not receive consumption/report rows",
    );
  }

  const actor = {
    name: "Failure Fixture",
    async updateEmbeddedDocuments() {
      throw new Error("update denied");
    },
    async deleteEmbeddedDocuments() {
      return [];
    },
  };
  let result;
  try {
    console.error = () => {};
    result = await applyConsumptionOps(
      actor,
      [
        { id: "stack-a", op: "decrement", to: 3 },
        { id: "stack-b", op: "delete" },
      ],
      [
        { id: "stack-a", quantity: 5 },
        { id: "stack-b", quantity: 4 },
      ],
    );
  } finally {
    console.error = savedConsoleError;
  }
  assert.equal(
    result.consumed,
    0,
    "an empty delete result is not treated as a committed write",
  );
  assert.match(result.error, /2 inventory write/);

  const confirmed = await applyConsumptionOps(
    {
      name: "Confirmed Fixture",
      async updateEmbeddedDocuments() {
        return [
          { id: "stack-a", system: { quantity: 3 } },
          // stack-c was cancelled by a pre-update hook and is absent.
        ];
      },
      async deleteEmbeddedDocuments() {
        return [{ id: "stack-b" }];
      },
    },
    [
      { id: "stack-a", op: "decrement", to: 3 },
      { id: "stack-c", op: "decrement", to: 1 },
      { id: "stack-b", op: "delete" },
    ],
    [
      { id: "stack-a", quantity: 5 },
      { id: "stack-b", quantity: 4 },
      { id: "stack-c", quantity: 2 },
    ],
  );
  assert.equal(
    confirmed.consumed,
    6,
    "counts only the update and delete documents Foundry confirms",
  );
  assert.match(confirmed.error, /1 inventory write/);

  const concurrentMutation = await applyConsumptionOps(
    {
      name: "Concurrent Mutation Fixture",
      async updateEmbeddedDocuments() {
        return [
          // A hook removed the whole stack even though upkeep planned to leave 3.
          { id: "stack-a", system: { quantity: 0 } },
        ];
      },
      async deleteEmbeddedDocuments() {
        return [];
      },
    },
    [{ id: "stack-a", op: "decrement", to: 3 }],
    [{ id: "stack-a", quantity: 5 }],
  );
  assert.equal(
    concurrentMutation.consumed,
    2,
    "a concurrent hook cannot make accounting exceed the planned decrement",
  );
  assert.match(
    concurrentMutation.error,
    /1 inventory write/,
    "a returned quantity that differs from the plan is surfaced as a failure",
  );

  let created = null;
  const sink = {
    name: "Empty Pack",
    items: { contents: [], get: () => null },
    async createEmbeddedDocuments(_type, docs) {
      created = docs[0];
      return docs;
    },
  };
  globalThis.fromUuid = async () => null;
  const deposited = await depositResource(
    sink,
    {
      id: "food",
      label: "Food (Rations)",
      matching: { itemUuids: [], nameKeywords: ["ration"], flagTag: "food" },
    },
    3,
  );
  assert.equal(deposited, 3, "default resource template creates a new stack");
  assert.equal(created.system.quantity, 3);
  assert.equal(created.flags["infinity-dnd5e"].resourceTag, "food");

  let unexpectedCreates = 0;
  const disappearingTarget = {
    name: "Disappearing Stack",
    items: {
      contents: [
        {
          id: "ration-stack",
          name: "Rations",
          system: { quantity: 2 },
          flags: { "infinity-dnd5e": { resourceTag: "food" } },
        },
      ],
      get: () => null,
    },
    async createEmbeddedDocuments() {
      unexpectedCreates += 1;
      return [{}];
    },
  };
  const disappearedDeposit = await depositResource(
    disappearingTarget,
    {
      id: "food",
      label: "Food (Rations)",
      matching: { itemUuids: [], nameKeywords: ["ration"], flagTag: "food" },
    },
    2,
  );
  assert.equal(
    disappearedDeposit,
    0,
    "does not report a deposit when the planned target disappeared",
  );
  assert.equal(
    unexpectedCreates,
    0,
    "a stale bump plan is not silently changed into a create",
  );

  const emptyCreateResult = {
    name: "Rejected Create",
    items: { contents: [], get: () => null },
    async createEmbeddedDocuments() {
      return [];
    },
  };
  const rejectedDeposit = await depositResource(
    emptyCreateResult,
    {
      id: "food",
      label: "Food (Rations)",
      matching: { itemUuids: [], nameKeywords: ["ration"], flagTag: "food" },
    },
    4,
  );
  assert.equal(
    rejectedDeposit,
    0,
    "an empty embedded-document result is not counted as a landed deposit",
  );

  const partiallyUpdatedStack = {
    id: "partial-stack",
    name: "Trail Rations",
    system: { quantity: 2 },
    flags: { "infinity-dnd5e": { resourceTag: "food" } },
    async update() {
      this.system.quantity = 4;
      return this;
    },
  };
  const partialUpdateResult = await depositResource(
    {
      name: "Partial Update",
      items: {
        contents: [partiallyUpdatedStack],
        get: () => partiallyUpdatedStack,
      },
    },
    {
      id: "food",
      label: "Food (Rations)",
      matching: { itemUuids: [], nameKeywords: ["ration"], flagTag: "food" },
    },
    3,
  );
  assert.equal(
    partialUpdateResult,
    2,
    "reports the quantity actually committed by an update",
  );

  process.stdout.write("resource write-accounting validation passed\n");
} finally {
  console.error = savedConsoleError;
  if (savedFromUuid === undefined) delete globalThis.fromUuid;
  else globalThis.fromUuid = savedFromUuid;
}
