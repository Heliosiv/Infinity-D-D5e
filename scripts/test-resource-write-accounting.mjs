import assert from "node:assert/strict";

import {
  applyConsumption,
  applyConsumptionOps,
  depositResource,
} from "./resource/calendar-watcher.js";

const savedFromUuid = globalThis.fromUuid;
const savedConsoleError = console.error;

function itemCollection(contents = []) {
  return {
    contents,
    get(id) {
      return this.contents.find(
        (item) => String(item.id ?? item._id) === String(id),
      );
    },
  };
}

async function withoutConsoleError(action) {
  const previous = console.error;
  console.error = () => {};
  try {
    return await action();
  } finally {
    console.error = previous;
  }
}

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

  let blockedDeleteCalls = 0;
  const actor = {
    name: "Failure Fixture",
    async updateEmbeddedDocuments() {
      throw new Error("update denied");
    },
    async deleteEmbeddedDocuments() {
      blockedDeleteCalls += 1;
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
  assert.match(result.error, /1 inventory write/);
  assert.equal(
    blockedDeleteCalls,
    0,
    "a failed decrement stops before destructive stack deletes",
  );

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
    2,
    "counts only the confirmed update and stops before later deletes",
  );
  assert.match(confirmed.error, /1 inventory write/);

  const concurrentMutation = await applyConsumptionOps(
    (() => {
      const canonical = {
        id: "stack-a",
        name: "Rations",
        system: { quantity: 5 },
      };
      return {
        name: "Concurrent Mutation Fixture",
        items: itemCollection([canonical]),
        async updateEmbeddedDocuments() {
          canonical.system.quantity = 0;
          return [
            // The return looks correct, but canonical inventory lost the stack.
            { id: "stack-a", system: { quantity: 3 } },
          ];
        },
        async deleteEmbeddedDocuments() {
          return [];
        },
      };
    })(),
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
  assert.match(concurrentMutation.error, /ended at 0, expected 3/);

  let unsafeDeleteCalls = 0;
  const fullStack = {
    id: "stack-delete",
    name: "Rations A",
    system: { quantity: 5 },
  };
  const decrementStack = {
    id: "stack-update",
    name: "Rations B",
    system: { quantity: 5 },
  };
  const stoppedMixedWrite = await applyConsumptionOps(
    {
      name: "Mixed Write Guard Fixture",
      items: itemCollection([fullStack, decrementStack]),
      async updateEmbeddedDocuments() {
        decrementStack.system.quantity = 0;
        return [{ id: decrementStack.id, system: { quantity: 4 } }];
      },
      async deleteEmbeddedDocuments() {
        unsafeDeleteCalls += 1;
        return [fullStack];
      },
    },
    [
      { id: fullStack.id, op: "delete" },
      { id: decrementStack.id, op: "decrement", to: 4 },
    ],
    [
      { id: fullStack.id, name: fullStack.name, quantity: 5 },
      { id: decrementStack.id, name: decrementStack.name, quantity: 5 },
    ],
  );
  assert.equal(stoppedMixedWrite.consumed, 1);
  assert.equal(unsafeDeleteCalls, 0);
  assert.equal(
    fullStack.system.quantity,
    5,
    "a divergent decrement stops before another stack can be deleted",
  );

  const nestedSourceConfirmation = await applyConsumptionOps(
    {
      name: "Nested Source Confirmation Fixture",
      async updateEmbeddedDocuments() {
        return [
          {
            _source: {
              _id: "stack-a",
              system: { quantity: 3 },
            },
          },
        ];
      },
    },
    [{ id: "stack-a", op: "decrement", to: 3 }],
    [{ id: "stack-a", quantity: 5 }],
  );
  assert.equal(nestedSourceConfirmation.consumed, 2);
  assert.equal(nestedSourceConfirmation.error, "");

  const stringDeleteConfirmation = await applyConsumptionOps(
    {
      name: "String Delete Confirmation Fixture",
      async deleteEmbeddedDocuments() {
        return ["stack-b"];
      },
    },
    [{ id: "stack-b", op: "delete" }],
    [{ id: "stack-b", quantity: 4 }],
  );
  assert.equal(stringDeleteConfirmation.consumed, 4);
  assert.equal(stringDeleteConfirmation.error, "");

  const canonicalReadback = await applyConsumptionOps(
    (() => {
      const canonical = {
        id: "stack-a",
        name: "Rations",
        system: { quantity: 5 },
      };
      return {
        name: "Canonical Readback Fixture",
        items: itemCollection([canonical]),
        async updateEmbeddedDocuments() {
          canonical.system.quantity = 3;
          return [{ id: "stack-a", system: { quantity: 0 } }];
        },
      };
    })(),
    [{ id: "stack-a", op: "decrement", to: 3 }],
    [{ id: "stack-a", name: "Rations", quantity: 5 }],
  );
  assert.equal(canonicalReadback.consumed, 2);
  assert.equal(
    canonicalReadback.error,
    "",
    "canonical actor inventory outranks a stale embedded-document return",
  );

  const foundryNormalizedPayload = await applyConsumptionOps(
    (() => {
      const canonical = {
        id: "stack-a",
        name: "Rations",
        system: { quantity: 5 },
      };
      return {
        name: "Foundry Payload Normalization Fixture",
        items: itemCollection([canonical]),
        async updateEmbeddedDocuments(_type, updates) {
          const expected = updates[0]["system.quantity"];
          canonical.system.quantity = expected;
          delete updates[0]["system.quantity"];
          updates[0].system = { quantity: expected };
          return updates;
        },
      };
    })(),
    [{ id: "stack-a", op: "decrement", to: 3 }],
    [{ id: "stack-a", name: "Rations", quantity: 5 }],
  );
  assert.equal(foundryNormalizedPayload.consumed, 2);
  assert.equal(
    foundryNormalizedPayload.error,
    "",
    "Foundry may normalize the write payload in place without changing the immutable plan",
  );

  const appliedThenThrew = await withoutConsoleError(() =>
    applyConsumptionOps(
      (() => {
        const canonical = {
          id: "stack-a",
          name: "Rations",
          system: { quantity: 5 },
        };
        return {
          name: "Applied Then Threw Fixture",
          items: itemCollection([canonical]),
          async updateEmbeddedDocuments() {
            canonical.system.quantity = 3;
            throw new Error("hook failed after commit");
          },
        };
      })(),
      [{ id: "stack-a", op: "decrement", to: 3 }],
      [{ id: "stack-a", name: "Rations", quantity: 5 }],
    ),
  );
  assert.equal(appliedThenThrew.consumed, 2);
  assert.equal(
    appliedThenThrew.error,
    "",
    "a thrown API call is still confirmed when canonical inventory reached the plan",
  );

  const deletedThenThrew = await withoutConsoleError(() =>
    applyConsumptionOps(
      (() => {
        const contents = [
          {
            id: "stack-b",
            name: "Rations",
            system: { quantity: 4 },
          },
        ];
        return {
          name: "Deleted Then Threw Fixture",
          items: itemCollection(contents),
          async deleteEmbeddedDocuments() {
            contents.splice(0, contents.length);
            throw new Error("hook failed after delete");
          },
        };
      })(),
      [{ id: "stack-b", op: "delete" }],
      [{ id: "stack-b", name: "Rations", quantity: 4 }],
    ),
  );
  assert.equal(deletedThenThrew.consumed, 4);
  assert.equal(deletedThenThrew.error, "");

  const rejectedCanonicalUpdate = await withoutConsoleError(() =>
    applyConsumptionOps(
      (() => {
        const canonical = {
          id: "stack-a",
          name: "Rations",
          system: { quantity: 5 },
        };
        return {
          name: "Rejected Canonical Update Fixture",
          items: itemCollection([canonical]),
          async updateEmbeddedDocuments() {
            throw new Error("update rejected before commit");
          },
        };
      })(),
      [{ id: "stack-a", op: "decrement", to: 3 }],
      [{ id: "stack-a", name: "Rations", quantity: 5 }],
    ),
  );
  assert.equal(rejectedCanonicalUpdate.consumed, 0);
  assert.match(rejectedCanonicalUpdate.error, /ended at 5, expected 3/);

  const rejectedCanonicalDelete = await withoutConsoleError(() =>
    applyConsumptionOps(
      (() => {
        const canonical = {
          id: "stack-b",
          name: "Rations",
          system: { quantity: 4 },
        };
        return {
          name: "Rejected Canonical Delete Fixture",
          items: itemCollection([canonical]),
          async deleteEmbeddedDocuments() {
            throw new Error("delete rejected before commit");
          },
        };
      })(),
      [{ id: "stack-b", op: "delete" }],
      [{ id: "stack-b", name: "Rations", quantity: 4 }],
    ),
  );
  assert.equal(rejectedCanonicalDelete.consumed, 0);
  assert.match(rejectedCanonicalDelete.error, /remained at 4/);

  const foodResource = {
    id: "food",
    label: "Food (Rations)",
    scope: "per-character",
    perDay: 1,
    forageYields: "food",
    matching: { itemUuids: [], nameKeywords: ["ration"], flagTag: "food" },
  };
  const availableButRejectedStack = {
    id: "available-food",
    name: "Rations",
    system: { quantity: 2 },
    flags: { "infinity-dnd5e": { resourceTag: "food" } },
  };
  const availableButRejected = await applyConsumption({
    roster: [
      {
        actor: {
          id: "failed-food-actor",
          name: "Failed Food Actor",
          items: itemCollection([availableButRejectedStack]),
          async updateEmbeddedDocuments() {
            return [];
          },
        },
        consumes: true,
        isStash: false,
        drawFromId: "failed-food-actor",
      },
    ],
    cfg: {
      resources: [foodResource],
      waterEnabled: false,
      halfRations: false,
    },
    days: 1,
  });
  assert.equal(availableButRejected.perActor[0].shortfalls.food, 0);
  assert.equal(availableButRejected.perActor[0].canonicalShortfalls.food, 0);
  assert.equal(availableButRejected.perActor[0].errors.length, 1);

  let sharedStashWriteCalls = 0;
  const sharedRations = {
    id: "shared-food",
    name: "Rations",
    system: { quantity: 1 },
    flags: { "infinity-dnd5e": { resourceTag: "food" } },
  };
  const sharedStash = {
    id: "shared-stash",
    name: "Shared Stash",
    items: itemCollection([sharedRations]),
    async updateEmbeddedDocuments() {
      sharedStashWriteCalls += 1;
      return [];
    },
    async deleteEmbeddedDocuments() {
      sharedStashWriteCalls += 1;
      return [];
    },
  };
  const sharedHeroes = [
    {
      actor: { id: "shared-hero-a", name: "Shared Hero A", items: [] },
      consumes: true,
      isStash: false,
      drawFromId: sharedStash.id,
    },
    {
      actor: { id: "shared-hero-b", name: "Shared Hero B", items: [] },
      consumes: true,
      isStash: false,
      drawFromId: sharedStash.id,
    },
  ];
  const sharedFailure = await applyConsumption({
    roster: sharedHeroes,
    sourceForMember: new Map(
      sharedHeroes.map((member) => [member.actor.id, sharedStash]),
    ),
    cfg: {
      resources: [foodResource],
      waterEnabled: false,
      halfRations: false,
    },
    days: 1,
  });
  assert.equal(
    sharedStashWriteCalls,
    1,
    "an uncertain shared-stash write blocks later draws from that source",
  );
  assert.equal(sharedFailure.perActor[0].shortfalls.food, 0);
  assert.equal(
    sharedFailure.perActor[1].shortfalls.food,
    1,
    "the circuit breaker keeps the shortage known before the failed write",
  );
  assert.equal(sharedFailure.perActor[0].errors.length, 1);
  assert.match(sharedFailure.perActor[1].errors[0], /draw was skipped/);

  let secondPartyWriteCalls = 0;
  const partyResource = {
    id: "light",
    label: "Light",
    scope: "party",
    perDay: 1,
    forageYields: null,
    matching: { itemUuids: [], nameKeywords: ["torch"], flagTag: "light" },
  };
  const firstTorch = {
    id: "first-torch",
    name: "Torches",
    system: { quantity: 2 },
    flags: { "infinity-dnd5e": { resourceTag: "light" } },
  };
  const secondTorch = {
    id: "second-torch",
    name: "Torches",
    system: { quantity: 2 },
    flags: { "infinity-dnd5e": { resourceTag: "light" } },
  };
  const partyWriteFailure = await applyConsumption({
    roster: [
      {
        actor: {
          id: "party-a",
          name: "Party A",
          items: itemCollection([firstTorch]),
          async updateEmbeddedDocuments() {
            return [];
          },
        },
        consumes: true,
        isStash: false,
        drawFromId: "party-a",
      },
      {
        actor: {
          id: "party-b",
          name: "Party B",
          items: itemCollection([secondTorch]),
          async updateEmbeddedDocuments() {
            secondPartyWriteCalls += 1;
            return [];
          },
        },
        consumes: true,
        isStash: false,
        drawFromId: "party-b",
      },
    ],
    cfg: {
      resources: [partyResource],
      waterEnabled: false,
      halfRations: false,
    },
    days: 1,
  });
  assert.equal(partyWriteFailure.party.light.shortfall, 0);
  assert.match(partyWriteFailure.party.light.error, /need review/);
  assert.equal(
    secondPartyWriteCalls,
    0,
    "an uncertain party write never charges a second Actor for the same use",
  );

  const firstPartyContents = [
    {
      id: "vanishing-a",
      name: "Torch",
      system: { quantity: 1 },
      flags: { "infinity-dnd5e": { resourceTag: "light" } },
    },
  ];
  const laterPartyContents = [
    {
      id: "vanishing-b",
      name: "Torch",
      system: { quantity: 1 },
      flags: { "infinity-dnd5e": { resourceTag: "light" } },
    },
  ];
  const vanishedLater = await applyConsumption({
    roster: [
      {
        actor: {
          id: "vanishing-party-a",
          name: "Vanishing Party A",
          items: itemCollection(firstPartyContents),
          async deleteEmbeddedDocuments() {
            firstPartyContents.splice(0, firstPartyContents.length);
            laterPartyContents.splice(0, laterPartyContents.length);
            return [];
          },
        },
        consumes: true,
        isStash: false,
        drawFromId: "vanishing-party-a",
      },
      {
        actor: {
          id: "vanishing-party-b",
          name: "Vanishing Party B",
          items: itemCollection(laterPartyContents),
        },
        consumes: true,
        isStash: false,
        drawFromId: "vanishing-party-b",
      },
    ],
    cfg: {
      resources: [{ ...partyResource, perDay: 2 }],
      waterEnabled: false,
      halfRations: false,
    },
    days: 1,
  });
  assert.equal(vanishedLater.party.light.consumed, 1);
  assert.equal(
    vanishedLater.party.light.shortfall,
    1,
    "a later inventory disappearance becomes a real shortage when no write is uncertain",
  );
  assert.equal(vanishedLater.party.light.error, "");

  let created = null;
  const sink = {
    name: "Empty Pack",
    items: itemCollection([]),
    async createEmbeddedDocuments(_type, docs, options) {
      assert.deepEqual(options, { keepId: true, keepEmbeddedIds: true });
      created = { ...docs[0], id: docs[0]._id };
      this.items.contents.push(created);
      return [created];
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
      return undefined;
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

  const thrownDepositStack = {
    id: "thrown-stack",
    name: "Trail Rations",
    system: { quantity: 2 },
    flags: { "infinity-dnd5e": { resourceTag: "food" } },
    async update() {
      this.system.quantity = 5;
      throw new Error("hook failed after deposit");
    },
  };
  const thrownDeposit = await withoutConsoleError(() =>
    depositResource(
      {
        name: "Applied Deposit",
        items: itemCollection([thrownDepositStack]),
      },
      {
        id: "food",
        label: "Food (Rations)",
        matching: { itemUuids: [], nameKeywords: ["ration"], flagTag: "food" },
      },
      3,
    ),
  );
  assert.equal(
    thrownDeposit,
    3,
    "a deposit that commits before an exception is confirmed by canonical readback",
  );

  const thrownCreateContents = [];
  const thrownCreate = await withoutConsoleError(() =>
    depositResource(
      {
        name: "Applied Create",
        items: itemCollection(thrownCreateContents),
        async createEmbeddedDocuments(_type, docs, options) {
          assert.deepEqual(options, { keepId: true, keepEmbeddedIds: true });
          thrownCreateContents.push({ ...docs[0], id: docs[0]._id });
          throw new Error("hook failed after create");
        },
      },
      {
        id: "food",
        label: "Food (Rations)",
        matching: { itemUuids: [], nameKeywords: ["ration"], flagTag: "food" },
      },
      2,
    ),
  );
  assert.equal(
    thrownCreate,
    2,
    "a created stack is found canonically even when the API call throws",
  );

  const rejectedCreate = await withoutConsoleError(() =>
    depositResource(
      {
        name: "Rejected Canonical Create",
        items: itemCollection([]),
        async createEmbeddedDocuments() {
          throw new Error("create rejected before commit");
        },
      },
      foodResource,
      2,
    ),
  );
  assert.equal(
    rejectedCreate,
    0,
    "a thrown create with no canonical item is never counted as deposited",
  );

  const wrongCreateTagContents = [];
  const wrongCreateTag = await depositResource(
    {
      name: "Wrong Create Tag",
      items: itemCollection(wrongCreateTagContents),
      async createEmbeddedDocuments(_type, docs) {
        const document = {
          ...docs[0],
          id: docs[0]._id,
          flags: {
            ...docs[0].flags,
            "infinity-dnd5e": {
              ...docs[0].flags["infinity-dnd5e"],
              resourceTag: "water",
            },
          },
        };
        wrongCreateTagContents.push(document);
        return [document];
      },
    },
    foodResource,
    3,
  );
  assert.equal(
    wrongCreateTag,
    0,
    "a created stack with altered resource identity is not credited as food",
  );

  const keywordOnlyStack = {
    id: "keyword-only-stack",
    name: "Rations",
    system: { quantity: 2 },
    flags: {},
    async update(change) {
      this.system.quantity = change["system.quantity"];
      return this;
    },
  };
  assert.equal(
    await depositResource(
      {
        name: "Keyword Bump",
        items: itemCollection([keywordOnlyStack]),
      },
      foodResource,
      3,
    ),
    3,
    "an untagged stack remains valid when its configured keyword still matches",
  );

  const uuidOnlyStack = {
    id: "uuid-only-stack",
    uuid: "Actor.actor-a.Item.uuid-only-stack",
    name: "Travel Meal",
    system: { quantity: 2 },
    flags: {},
    async update(change) {
      this.system.quantity = change["system.quantity"];
      return this;
    },
  };
  assert.equal(
    await depositResource(
      {
        name: "UUID Bump",
        items: itemCollection([uuidOnlyStack]),
      },
      {
        ...foodResource,
        matching: {
          itemUuids: [uuidOnlyStack.uuid],
          nameKeywords: [],
          flagTag: "food",
        },
      },
      3,
    ),
    3,
    "an exact UUID match does not require a module tag after the bump",
  );

  const wrongBumpTagStack = {
    id: "wrong-bump-tag",
    name: "Rations",
    system: { quantity: 2 },
    flags: { "infinity-dnd5e": { resourceTag: "food" } },
    async update(change) {
      this.system.quantity = change["system.quantity"];
      this.flags["infinity-dnd5e"].resourceTag = "water";
      this.name = "Waterskin";
      return this;
    },
  };
  assert.equal(
    await depositResource(
      {
        name: "Wrong Bump Tag",
        items: itemCollection([wrongBumpTagStack]),
      },
      foodResource,
      3,
    ),
    0,
    "a bumped stack that no longer matches any food rule is not credited as food",
  );

  const customContents = [];
  const customSink = {
    name: "Custom Resource Sink",
    items: itemCollection(customContents),
    async createEmbeddedDocuments(_type, docs) {
      const document = {
        ...docs[0],
        id: docs[0]._id,
        async update(change) {
          this.system.quantity = change["system.quantity"];
          return this;
        },
      };
      customContents.push(document);
      return [document];
    },
  };
  const blankTagResource = {
    id: "medicine",
    label: "Field Medicine",
    matching: {
      itemUuids: [],
      nameKeywords: [],
      excludeNameKeywords: [],
      flagTag: "",
    },
  };
  assert.equal(await depositResource(customSink, blankTagResource, 2), 2);
  assert.equal(await depositResource(customSink, blankTagResource, 3), 3);
  assert.equal(
    customContents.length,
    1,
    "a blank custom flag falls back to the resource id instead of duplicating stacks",
  );
  assert.equal(customContents[0].system.quantity, 5);
  assert.equal(
    customContents[0].flags["infinity-dnd5e"].resourceTag,
    "medicine",
  );

  process.stdout.write("resource write-accounting validation passed\n");
} finally {
  console.error = savedConsoleError;
  if (savedFromUuid === undefined) delete globalThis.fromUuid;
  else globalThis.fromUuid = savedFromUuid;
}
