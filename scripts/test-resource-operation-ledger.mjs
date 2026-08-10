#!/usr/bin/env node

import assert from "node:assert/strict";
import {
  RESOURCE_OPERATION_VERSION,
  ResourceOperationLedgerError,
  adoptResourceOperationAuthority,
  buildResourceInventoryOperationId,
  createResourceDelivery,
  canTransitionResourceOperation,
  classifyResourceInventoryOperation,
  createResourceInventoryOperation,
  createResourceOperation,
  createResourceOperationContext,
  createResourceTerminalDeliveries,
  decideResourceOperation,
  legacyActiveUpkeepToResourceOperation,
  markResourceDeliveryDelivered,
  markResourceInventoryOperationApplied,
  normalizeResourceOperation,
  recordResourcePromptResponse,
  recordResourcePromptTimeout,
  resourceOperationContextMatches,
  resourceOperationGuardMatches,
  transitionResourceOperation,
} from "./resource/operation-ledger.js";

const guard = Object.freeze({
  authorityId: "gm-1",
  authorityEpoch: "gm-1:resource-epoch-7",
  leadershipGeneration: 4,
});
const nextGuard = Object.freeze({
  ...guard,
  leadershipGeneration: 5,
});
const environment = Object.freeze({
  id: "forest",
  label: "Temperate Forest",
  dc: 12,
  foodDc: 12,
  waterDc: 10,
});
const initiator = Object.freeze({ userId: "gm-1", name: "Game Master" });
const contextSnapshot = Object.freeze({
  rules: {
    forageMode: "each",
    waterEnabled: true,
    halfRations: false,
    forageTimeoutSeconds: 120,
  },
  resources: [
    { id: "food", scope: "per-character", matcher: ["ration"] },
    { id: "water", scope: "per-character", matcher: ["waterskin"] },
  ],
  roster: [{ actorId: "actor-1", consumes: true, drawFromId: "stash-1" }],
  partyStashId: "stash-1",
});
const context = createResourceOperationContext(contextSnapshot);

function actor(
  actorId,
  forageTarget = null,
  role = "participant",
  name = actorId,
) {
  return { actorId, name, role, forageTarget };
}

function prepared({
  operationId = "quartermaster-run-1",
  runId = operationId,
  trigger = "manual",
  actors = [actor("actor-1")],
  day = trigger === "calendar" ? 42 : null,
  createdAt = 1000,
} = {}) {
  return createResourceOperation({
    operationId,
    runId,
    trigger,
    guard,
    context,
    day,
    days: 1,
    environment,
    initiator,
    actors,
    createdAt,
  });
}

function terminalDeliveries(record, report) {
  return createResourceTerminalDeliveries(record, {
    report,
    reportRecipient: { type: "chat", id: "public" },
  });
}

function assignment(
  promptId,
  actorId,
  userId,
  forageTarget,
  assignedAt,
  deadlineAt,
) {
  return {
    promptId,
    actorId,
    userId,
    forageTarget,
    dc: forageTarget === "water" ? 10 : 12,
    foodDc: 12,
    waterDc: 10,
    assignedAt,
    deadlineAt,
  };
}

function resolvedYield(
  actorId,
  forageTarget,
  {
    rollTotal = 15,
    wisMod = 2,
    food = 2,
    water = 1,
    foodSuccess = true,
    waterSuccess = true,
    suppressedFood = false,
    suppressedWater = false,
  } = {},
) {
  return {
    actorId,
    forageTarget,
    rollTotal,
    wisMod,
    food,
    water,
    foodSuccess,
    waterSuccess,
    suppressedFood,
    suppressedWater,
  };
}

function inventoryOperation(runId, sequence, overrides = {}) {
  return createResourceInventoryOperation({
    runId,
    sequence,
    action: "update",
    actorId: "stash-1",
    itemId: `item-${sequence}`,
    resourceId: sequence === 0 ? "food" : "water",
    beforeQuantity: 5,
    afterQuantity: 8,
    ...overrides,
  });
}

function expectCode(code, operation) {
  assert.throws(operation, (error) => {
    assert.ok(error instanceof ResourceOperationLedgerError);
    assert.equal(error.code, code);
    return true;
  });
}

/* Initial records cover all three run types and own their immutable inputs. */
{
  const actorInput = actor("actor-1");
  const envInput = { ...environment };
  const manual = createResourceOperation({
    operationId: "manual-operation",
    runId: "manual-run",
    trigger: "manual",
    guard,
    context,
    day: null,
    days: 2,
    environment: envInput,
    initiator,
    actors: [actorInput],
    createdAt: 100,
  });
  actorInput.name = "Mutated later";
  envInput.label = "Mutated later";
  assert.equal(manual.version, RESOURCE_OPERATION_VERSION);
  assert.equal(manual.kind, "upkeep");
  assert.equal(manual.phase, "prepared");
  assert.equal(manual.actors[0].name, "actor-1");
  assert.equal(manual.environment.label, "Temperate Forest");
  assert.ok(Object.isFrozen(manual));
  assert.ok(Object.isFrozen(manual.guard));
  assert.ok(Object.isFrozen(manual.actors));
  assert.throws(() => {
    manual.guard.authorityId = "other";
  }, TypeError);

  const calendar = prepared({
    operationId: "calendar-operation",
    trigger: "calendar",
    day: 43,
  });
  assert.equal(calendar.kind, "upkeep");
  assert.equal(calendar.day, 43);

  const forage = prepared({
    operationId: "forage-operation",
    trigger: "forage",
    actors: [actor("actor-1", "food-water")],
  });
  assert.equal(forage.kind, "forage");
  assert.equal(forage.trigger, "forage");
  expectCode("RESOURCE_OPERATION_MALFORMED", () =>
    createResourceOperation({
      operationId: "bad-pair",
      runId: "bad-pair",
      kind: "forage",
      trigger: "manual",
      guard,
      context,
      environment,
      initiator,
      actors: [actor("actor-1")],
      createdAt: 1,
    }),
  );
  expectCode("RESOURCE_OPERATION_MALFORMED", () =>
    prepared({
      operationId: "calendar-without-day",
      trigger: "calendar",
      day: null,
    }),
  );
}

/* Persisted shape is exact, finite, bounded, and never invokes accessors. */
{
  const record = prepared();
  expectCode("RESOURCE_OPERATION_FUTURE_VERSION", () =>
    normalizeResourceOperation({ ...record, version: 2 }),
  );
  expectCode("RESOURCE_OPERATION_MALFORMED", () =>
    normalizeResourceOperation({ ...record, version: "1" }),
  );
  expectCode("RESOURCE_OPERATION_MALFORMED", () =>
    normalizeResourceOperation({ ...record, surprise: true }),
  );
  expectCode("RESOURCE_OPERATION_MALFORMED", () =>
    normalizeResourceOperation({
      ...record,
      environment: { ...record.environment, dc: Number.NaN },
    }),
  );
  const accessor = structuredClone(record);
  Object.defineProperty(accessor, "report", {
    enumerable: true,
    get() {
      throw new Error("must not run");
    },
  });
  expectCode("RESOURCE_OPERATION_MALFORMED", () =>
    normalizeResourceOperation(accessor),
  );
  const sparseActors = structuredClone(record);
  sparseActors.actors = new Array(1);
  expectCode("RESOURCE_OPERATION_MALFORMED", () =>
    normalizeResourceOperation(sparseActors),
  );
  expectCode("RESOURCE_OPERATION_BOUNDS", () =>
    createResourceOperationContext({ ["k".repeat(1025)]: true }),
  );
  const aggregateKeys = Object.fromEntries(
    Array.from({ length: 300 }, (_, index) => [
      `${String(index).padStart(3, "0")}${"k".repeat(997)}`,
      true,
    ]),
  );
  expectCode("RESOURCE_OPERATION_BOUNDS", () =>
    createResourceOperationContext(aggregateKeys),
  );

  assert.equal(resourceOperationContextMatches(record, contextSnapshot), true);
  const driftedContext = structuredClone(contextSnapshot);
  driftedContext.rules.forageMode = "best";
  assert.equal(resourceOperationContextMatches(record, driftedContext), false);
  const forgedContext = structuredClone(record);
  forgedContext.context.snapshot.rules.forageMode = "best";
  assert.equal(
    forgedContext.context.fingerprint,
    record.context.fingerprint,
    "the regression keeps the same caller-echoed fingerprint",
  );
  expectCode("RESOURCE_OPERATION_MALFORMED", () =>
    normalizeResourceOperation(forgedContext),
  );
}

/* Guards are exact and transitions cannot silently move to a newer leader. */
{
  const record = prepared();
  assert.equal(resourceOperationGuardMatches(record, guard), true);
  assert.equal(resourceOperationGuardMatches(record, nextGuard), false);
  assert.equal(resourceOperationGuardMatches(record, null), false);
  assert.equal(
    decideResourceOperation(record, { guard }).action,
    "prompt-or-plan",
  );
  assert.equal(
    decideResourceOperation(record, { guard: nextGuard }).reason,
    "authority-guard-mismatch",
  );
  assert.equal(
    decideResourceOperation(record, { guard: nextGuard }).action,
    "adopt-authority",
  );
  expectCode("RESOURCE_OPERATION_ADOPTION_CONFLICT", () =>
    adoptResourceOperationAuthority(record, nextGuard, {
      at: 1001,
      contextSnapshot: { ...contextSnapshot, partyStashId: "other" },
    }),
  );
  const adopted = adoptResourceOperationAuthority(record, nextGuard, {
    at: 1001,
    contextSnapshot,
  });
  assert.equal(adopted.guard.leadershipGeneration, 5);
  assert.equal(adopted.authorityAdoptions.length, 1);
  assert.deepEqual(adopted.authorityAdoptions[0].fromGuard, guard);
  assert.equal(
    decideResourceOperation(adopted, { guard }).action,
    "adopt-authority",
  );
  assert.equal(
    decideResourceOperation(adopted, { guard: nextGuard }).action,
    "prompt-or-plan",
  );
  assert.deepEqual(
    adoptResourceOperationAuthority(adopted, nextGuard, {
      at: 9999,
      contextSnapshot: { drifted: true },
    }),
    adopted,
    "adopting the already-current guard is idempotent",
  );
  expectCode("RESOURCE_OPERATION_GUARD_MISMATCH", () =>
    transitionResourceOperation(record, "planned", {
      guard: nextGuard,
      at: 1001,
      operations: [],
      yields: [],
    }),
  );
  expectCode("RESOURCE_OPERATION_INVALID_TRANSITION", () =>
    transitionResourceOperation(record, "applying", { guard, at: 1001 }),
  );
  assert.equal(canTransitionResourceOperation("prepared", "planned"), true);
  assert.equal(canTransitionResourceOperation("applying", "planned"), false);
  assert.equal(canTransitionResourceOperation("bogus", "planned"), false);
}

/* Prompt answers and timeouts are durable, ordered, linked, and idempotent. */
let prompted;
let planned;
{
  const record = prepared({
    operationId: "forage-durable",
    trigger: "forage",
    actors: [
      actor("actor-a", "food-water", "participant", "Aster"),
      actor("actor-b", "water", "participant", "Bryn"),
      actor("stash-1", null, "inventory", "Party Stash"),
    ],
  });
  prompted = transitionResourceOperation(record, "prompting", {
    guard,
    at: 1010,
    assignments: [
      assignment("prompt-a", "actor-a", "player-a", "food-water", 1010, 1030),
      assignment("prompt-b", "actor-b", "player-b", "water", 1010, 1030),
    ],
  });
  assert.equal(prompted.phase, "prompting");
  assert.deepEqual(
    decideResourceOperation(prompted, { guard }).pendingPromptIds,
    ["prompt-a", "prompt-b"],
  );
  expectCode("RESOURCE_OPERATION_MALFORMED", () =>
    transitionResourceOperation(record, "prompting", {
      guard,
      at: 1010,
      assignments: [
        assignment(
          "duplicate-actor-a",
          "actor-a",
          "player-a",
          "food-water",
          1010,
          1030,
        ),
        assignment(
          "duplicate-actor-b",
          "actor-a",
          "player-a",
          "food-water",
          1010,
          1030,
        ),
      ],
    }),
  );
  const adoptedPrompting = adoptResourceOperationAuthority(
    prompted,
    nextGuard,
    { at: 1011, contextSnapshot },
  );
  assert.deepEqual(adoptedPrompting.prompts, prompted.prompts);
  expectCode("RESOURCE_OPERATION_GUARD_MISMATCH", () =>
    recordResourcePromptResponse(
      adoptedPrompting,
      {
        promptId: "prompt-a",
        actorId: "actor-a",
        userId: "player-a",
        rollTotal: 15,
        wisMod: 2,
        skipped: false,
      },
      { guard, at: 1012 },
    ),
  );
  const adoptedAnswer = recordResourcePromptResponse(
    adoptedPrompting,
    {
      promptId: "prompt-a",
      actorId: "actor-a",
      userId: "player-a",
      rollTotal: 15,
      wisMod: 2,
      skipped: false,
    },
    { guard: nextGuard, at: 1012 },
  );
  assert.equal(adoptedAnswer.prompts.responses.length, 1);

  const answered = recordResourcePromptResponse(
    prompted,
    {
      promptId: "prompt-a",
      actorId: "actor-a",
      userId: "player-a",
      rollTotal: 15,
      wisMod: 2,
      skipped: false,
    },
    { guard, at: 1020 },
  );
  const duplicate = recordResourcePromptResponse(
    answered,
    {
      promptId: "prompt-a",
      actorId: "actor-a",
      userId: "player-a",
      rollTotal: 15,
      wisMod: 2,
      skipped: false,
    },
    { guard, at: 9999 },
  );
  assert.deepEqual(duplicate, answered, "exact duplicate response is a no-op");
  expectCode("RESOURCE_OPERATION_PROMPT_CONFLICT", () =>
    recordResourcePromptResponse(
      answered,
      {
        promptId: "prompt-a",
        actorId: "actor-a",
        userId: "player-a",
        rollTotal: 16,
        wisMod: 2,
        skipped: false,
      },
      { guard, at: 1021 },
    ),
  );
  expectCode("RESOURCE_OPERATION_PROMPT_CONFLICT", () =>
    recordResourcePromptResponse(
      answered,
      {
        promptId: "prompt-a",
        actorId: "actor-b",
        userId: "player-a",
        rollTotal: 15,
        wisMod: 2,
        skipped: false,
      },
      { guard, at: 1021 },
    ),
  );

  const timedOut = recordResourcePromptTimeout(answered, "prompt-b", {
    guard,
    at: 1030,
  });
  assert.deepEqual(
    recordResourcePromptTimeout(timedOut, "prompt-b", {
      guard,
      at: 9999,
    }),
    timedOut,
    "duplicate timeout is a no-op",
  );
  expectCode("RESOURCE_OPERATION_PROMPT_CONFLICT", () =>
    recordResourcePromptResponse(
      timedOut,
      {
        promptId: "prompt-b",
        actorId: "actor-b",
        userId: "player-b",
        rollTotal: 12,
        wisMod: 1,
        skipped: false,
      },
      { guard, at: 1031 },
    ),
  );
  assert.equal(decideResourceOperation(timedOut, { guard }).action, "plan");

  const first = inventoryOperation(record.runId, 0);
  const second = inventoryOperation(record.runId, 1, {
    action: "create",
    itemId: "created-water",
    resourceId: "water",
    beforeQuantity: 0,
    afterQuantity: 1,
    itemSnapshot: {
      _id: "created-water",
      name: "Waterskin",
      type: "consumable",
      system: { quantity: 1 },
      flags: { "infinity-dnd5e": { resourceTag: "water" } },
    },
  });
  planned = transitionResourceOperation(timedOut, "planned", {
    guard,
    at: 1040,
    yields: [
      resolvedYield("actor-a", "food-water"),
      resolvedYield("actor-b", "water", {
        rollTotal: null,
        wisMod: null,
        food: 0,
        water: 0,
        foodSuccess: false,
        waterSuccess: false,
      }),
    ],
    operations: [first, second],
  });
  assert.equal(planned.phase, "planned");
  assert.equal(
    decideResourceOperation(planned, { guard }).action,
    "begin-applying",
  );
  const beforePlanObservations = [
    {
      actorId: "stash-1",
      itemId: "item-0",
      exists: true,
      quantity: 5,
      matchesResource: true,
    },
    {
      actorId: "stash-1",
      itemId: "created-water",
      exists: false,
      quantity: null,
      matchesResource: null,
    },
  ];
  const adoptedPlan = adoptResourceOperationAuthority(planned, nextGuard, {
    at: 1041,
    contextSnapshot,
    observations: beforePlanObservations,
  });
  assert.deepEqual(adoptedPlan.appliedOperationIds, []);
  assert.equal(
    decideResourceOperation(adoptedPlan, { guard: nextGuard }).action,
    "begin-applying",
  );
  expectCode("RESOURCE_OPERATION_ADOPTION_CONFLICT", () =>
    adoptResourceOperationAuthority(planned, nextGuard, {
      at: 1041,
      contextSnapshot,
      observations: [
        { ...beforePlanObservations[0], quantity: 7 },
        beforePlanObservations[1],
      ],
    }),
  );

  expectCode("RESOURCE_OPERATION_MALFORMED", () =>
    transitionResourceOperation(answered, "planned", {
      guard,
      at: 1025,
      yields: [resolvedYield("actor-a", "food-water")],
      operations: [],
    }),
  );
  expectCode("RESOURCE_OPERATION_MALFORMED", () =>
    transitionResourceOperation(timedOut, "planned", {
      guard,
      at: 1040,
      yields: [
        resolvedYield("actor-a", "food-water", { rollTotal: 99 }),
        resolvedYield("actor-b", "water", {
          rollTotal: null,
          wisMod: null,
          food: 0,
          water: 0,
          foodSuccess: false,
          waterSuccess: false,
        }),
      ],
      operations: [],
    }),
  );
}

/* Skipped prompt responses can only resolve to a fully neutral yield. */
{
  const record = prepared({
    operationId: "skipped-yield",
    trigger: "forage",
    actors: [actor("actor-skip", "food")],
  });
  const asking = transitionResourceOperation(record, "prompting", {
    guard,
    at: 1001,
    assignments: [
      assignment(
        "prompt-skip",
        "actor-skip",
        "player-skip",
        "food",
        1001,
        1030,
      ),
    ],
  });
  const skipped = recordResourcePromptResponse(
    asking,
    {
      promptId: "prompt-skip",
      actorId: "actor-skip",
      userId: "player-skip",
      rollTotal: 0,
      wisMod: 0,
      skipped: true,
    },
    { guard, at: 1002 },
  );
  expectCode("RESOURCE_OPERATION_MALFORMED", () =>
    transitionResourceOperation(skipped, "planned", {
      guard,
      at: 1003,
      yields: [
        resolvedYield("actor-skip", "food", {
          rollTotal: 0,
          wisMod: 0,
          food: 1,
          water: 0,
          foodSuccess: true,
          waterSuccess: false,
        }),
      ],
      operations: [],
    }),
  );
  expectCode("RESOURCE_OPERATION_MALFORMED", () =>
    transitionResourceOperation(skipped, "planned", {
      guard,
      at: 1003,
      yields: [
        resolvedYield("actor-skip", "food", {
          rollTotal: 0,
          wisMod: 0,
          food: 0,
          water: 0,
          foodSuccess: false,
          waterSuccess: false,
          suppressedFood: true,
        }),
      ],
      operations: [],
    }),
  );
  const neutral = transitionResourceOperation(skipped, "planned", {
    guard,
    at: 1003,
    yields: [
      resolvedYield("actor-skip", "food", {
        rollTotal: 0,
        wisMod: 0,
        food: 0,
        water: 0,
        foodSuccess: false,
        waterSuccess: false,
      }),
    ],
    operations: [],
  });
  assert.equal(neutral.phase, "planned");
}

/* Operation ids encode tuple boundaries without delimiter collisions. */
{
  const base = {
    runId: "run|one",
    sequence: 0,
    action: "update",
    actorId: "actor|item",
    itemId: "target",
    resourceId: "food",
    beforeQuantity: 2,
    afterQuantity: 1,
  };
  assert.equal(
    buildResourceInventoryOperationId(base),
    buildResourceInventoryOperationId({ ...base }),
  );
  assert.notEqual(
    buildResourceInventoryOperationId(base),
    buildResourceInventoryOperationId({
      ...base,
      actorId: "actor",
      itemId: "item|target",
    }),
  );
  assert.notEqual(
    buildResourceInventoryOperationId(base),
    buildResourceInventoryOperationId({ ...base, afterQuantity: 3 }),
  );
  const createBase = {
    runId: "snapshot-sensitive",
    sequence: 0,
    action: "create",
    actorId: "actor-1",
    itemId: "new-item",
    resourceId: "food",
    beforeQuantity: 0,
    afterQuantity: 2,
  };
  const foodCreate = createResourceInventoryOperation({
    ...createBase,
    itemSnapshot: {
      _id: "new-item",
      name: "Food",
      type: "consumable",
      system: { quantity: 2 },
    },
  });
  const poisonCreate = createResourceInventoryOperation({
    ...createBase,
    itemSnapshot: {
      _id: "new-item",
      name: "Poison",
      type: "consumable",
      system: { quantity: 2 },
    },
  });
  assert.notEqual(foodCreate.opId, poisonCreate.opId);
  expectCode("RESOURCE_OPERATION_MALFORMED", () =>
    createResourceInventoryOperation({
      runId: "bad-create",
      sequence: 0,
      action: "create",
      actorId: "actor-1",
      itemId: "new-item",
      resourceId: "food",
      beforeQuantity: 0,
      afterQuantity: 2,
      itemSnapshot: {
        _id: "different-item",
        system: { quantity: 2 },
      },
    }),
  );
}

/* Every write requires canonical before/after classification; no blind retry. */
let applying;
let fullyApplied;
{
  applying = transitionResourceOperation(planned, "applying", {
    guard,
    at: 1050,
  });
  const decision = decideResourceOperation(applying, { guard });
  assert.equal(decision.action, "reconcile");
  assert.equal(decision.reason, "canonical-readback-required");
  const firstId = applying.plan[0].opId;
  const secondId = applying.plan[1].opId;

  const adoptedAfterCrashGap = adoptResourceOperationAuthority(
    applying,
    nextGuard,
    {
      at: 1051,
      contextSnapshot,
      observations: [
        {
          actorId: "stash-1",
          itemId: "item-0",
          exists: true,
          quantity: 8,
          matchesResource: true,
        },
        {
          actorId: "stash-1",
          itemId: "created-water",
          exists: false,
          quantity: null,
          matchesResource: null,
        },
      ],
    },
  );
  assert.deepEqual(adoptedAfterCrashGap.appliedOperationIds, [firstId]);
  assert.equal(
    adoptedAfterCrashGap.authorityAdoptions[0].advancedOperationId,
    firstId,
  );
  assert.equal(
    decideResourceOperation(adoptedAfterCrashGap, {
      guard: nextGuard,
    }).operationId,
    secondId,
  );
  assert.equal(
    classifyResourceInventoryOperation(
      adoptedAfterCrashGap,
      secondId,
      { exists: false, quantity: null, matchesResource: null },
      { guard },
    ).reason,
    "authority-guard-mismatch",
  );
  expectCode("RESOURCE_OPERATION_ADOPTION_CONFLICT", () =>
    adoptResourceOperationAuthority(applying, nextGuard, {
      at: 1051,
      contextSnapshot,
      observations: [
        {
          actorId: "stash-1",
          itemId: "item-0",
          exists: true,
          quantity: 7,
          matchesResource: true,
        },
        {
          actorId: "stash-1",
          itemId: "created-water",
          exists: false,
          quantity: null,
          matchesResource: null,
        },
      ],
    }),
  );

  assert.equal(
    classifyResourceInventoryOperation(
      applying,
      firstId,
      { exists: true, quantity: 5, matchesResource: true },
      { guard },
    ).action,
    "apply",
  );
  assert.equal(
    classifyResourceInventoryOperation(
      applying,
      firstId,
      { exists: true, quantity: 8, matchesResource: true },
      { guard },
    ).action,
    "mark-applied",
  );
  assert.equal(
    classifyResourceInventoryOperation(
      applying,
      firstId,
      { exists: true, quantity: 7, matchesResource: true },
      { guard },
    ).reason,
    "canonical-third-state",
  );
  assert.equal(
    classifyResourceInventoryOperation(
      applying,
      firstId,
      { exists: true, quantity: 5, matchesResource: false },
      { guard },
    ).reason,
    "resource-identity-mismatch",
  );
  assert.equal(
    classifyResourceInventoryOperation(
      applying,
      firstId,
      { exists: true, quantity: 5, matchesResource: true },
      { guard: nextGuard },
    ).reason,
    "authority-guard-mismatch",
  );
  assert.equal(
    classifyResourceInventoryOperation(
      applying,
      secondId,
      { exists: false, quantity: null, matchesResource: null },
      { guard },
    ).reason,
    "inventory-operation-out-of-order",
  );

  expectCode("RESOURCE_OPERATION_APPLY_CONFLICT", () =>
    markResourceInventoryOperationApplied(applying, firstId, {
      guard,
      at: 1060,
      observed: { exists: true, quantity: 5, matchesResource: true },
    }),
  );
  const firstApplied = markResourceInventoryOperationApplied(
    applying,
    firstId,
    {
      guard,
      at: 1060,
      observed: { exists: true, quantity: 8, matchesResource: true },
    },
  );
  assert.deepEqual(firstApplied.appliedOperationIds, [firstId]);
  assert.deepEqual(
    markResourceInventoryOperationApplied(firstApplied, firstId, {
      guard: nextGuard,
      at: 9999,
      observed: null,
    }),
    firstApplied,
    "duplicate durable operation marker is a no-op",
  );
  assert.equal(
    classifyResourceInventoryOperation(
      firstApplied,
      firstId,
      { exists: true, quantity: 999, matchesResource: false },
      { guard: nextGuard },
    ).action,
    "already-applied",
  );

  assert.equal(
    classifyResourceInventoryOperation(
      firstApplied,
      secondId,
      { exists: false, quantity: null, matchesResource: null },
      { guard },
    ).action,
    "apply",
  );
  assert.equal(
    classifyResourceInventoryOperation(
      firstApplied,
      secondId,
      { exists: true, quantity: 1, matchesResource: true },
      { guard },
    ).action,
    "mark-applied",
  );
  fullyApplied = markResourceInventoryOperationApplied(firstApplied, secondId, {
    guard,
    at: 1070,
    observed: { exists: true, quantity: 1, matchesResource: true },
  });
  assert.equal(
    decideResourceOperation(fullyApplied, { guard }).action,
    "finalize",
  );
}

/* Terminal records replay immutable receipts and reject unconfirmed writes. */
{
  expectCode("RESOURCE_OPERATION_MALFORMED", () =>
    transitionResourceOperation(applying, "terminal", {
      guard,
      at: 1080,
      report: { status: "complete" },
      receipt: { runId: applying.runId, status: "complete" },
      deliveries: terminalDeliveries(applying, { status: "complete" }),
    }),
  );
  expectCode("RESOURCE_OPERATION_MALFORMED", () =>
    transitionResourceOperation(fullyApplied, "terminal", {
      guard,
      at: 1080,
      report: { status: "complete" },
      receipt: null,
      deliveries: terminalDeliveries(fullyApplied, { status: "complete" }),
    }),
  );
  const report = { status: "complete", totals: { food: 3, water: 1 } };
  const receipt = { runId: fullyApplied.runId, status: "complete" };
  const terminal = transitionResourceOperation(fullyApplied, "terminal", {
    guard,
    at: 1080,
    report,
    receipt,
    deliveries: terminalDeliveries(fullyApplied, report),
  });
  const payloadBoundA = createResourceDelivery({
    runId: fullyApplied.runId,
    kind: "report",
    recipient: { type: "chat", id: "public" },
    promptId: null,
    payload: { food: 3 },
  });
  const payloadBoundB = createResourceDelivery({
    runId: fullyApplied.runId,
    kind: "report",
    recipient: { type: "chat", id: "public" },
    promptId: null,
    payload: { food: 999 },
  });
  assert.notEqual(payloadBoundA.deliveryId, payloadBoundB.deliveryId);

  const wrongReportDeliveries = [...terminalDeliveries(fullyApplied, report)];
  wrongReportDeliveries[0] = createResourceDelivery({
    runId: fullyApplied.runId,
    kind: "report",
    recipient: { type: "chat", id: "public" },
    promptId: null,
    payload: { status: "complete", totals: { food: 999, water: 1 } },
  });
  expectCode("RESOURCE_OPERATION_MALFORMED", () =>
    transitionResourceOperation(fullyApplied, "terminal", {
      guard,
      at: 1080,
      report,
      receipt,
      deliveries: wrongReportDeliveries,
    }),
  );

  const wrongAckDeliveries = [...terminalDeliveries(fullyApplied, report)];
  const wrongAckPayload = structuredClone(wrongAckDeliveries[1].payload);
  wrongAckPayload.yield.food = 999;
  wrongAckDeliveries[1] = createResourceDelivery({
    runId: fullyApplied.runId,
    kind: "prompt-ack",
    recipient: wrongAckDeliveries[1].recipient,
    promptId: wrongAckDeliveries[1].promptId,
    payload: wrongAckPayload,
  });
  expectCode("RESOURCE_OPERATION_MALFORMED", () =>
    transitionResourceOperation(fullyApplied, "terminal", {
      guard,
      at: 1080,
      report,
      receipt,
      deliveries: wrongAckDeliveries,
    }),
  );

  const nonPrefix = structuredClone(terminal);
  nonPrefix.outbox.entries[1].state = "delivered";
  nonPrefix.outbox.entries[1].deliveredAt = 1081;
  nonPrefix.timestamps.updatedAt = 1081;
  expectCode("RESOURCE_OPERATION_MALFORMED", () =>
    normalizeResourceOperation(nonPrefix),
  );
  const reversedDeliveryTimes = structuredClone(terminal);
  reversedDeliveryTimes.outbox.entries[0].state = "delivered";
  reversedDeliveryTimes.outbox.entries[0].deliveredAt = 1082;
  reversedDeliveryTimes.outbox.entries[1].state = "delivered";
  reversedDeliveryTimes.outbox.entries[1].deliveredAt = 1081;
  reversedDeliveryTimes.timestamps.updatedAt = 1082;
  expectCode("RESOURCE_OPERATION_MALFORMED", () =>
    normalizeResourceOperation(reversedDeliveryTimes),
  );

  const preDelivered = terminalDeliveries(fullyApplied, {
    status: "complete",
  }).map((entry) => structuredClone(entry));
  preDelivered[0].state = "delivered";
  preDelivered[0].deliveredAt = 1080;
  expectCode("RESOURCE_OPERATION_DELIVERY_CONFLICT", () =>
    transitionResourceOperation(fullyApplied, "terminal", {
      guard,
      at: 1080,
      report: { status: "complete" },
      receipt: { runId: fullyApplied.runId, status: "complete" },
      deliveries: preDelivered,
    }),
  );
  report.totals.food = 999;
  receipt.status = "mutated";
  assert.equal(terminal.report.totals.food, 3);
  assert.equal(terminal.receipt.status, "complete");
  assert.equal(decideResourceOperation(terminal).action, "adopt-authority");
  assert.equal(decideResourceOperation(terminal, { guard }).action, "deliver");
  assert.equal(terminal.outbox.entries[0].kind, "report");
  assert.deepEqual(
    terminal.outbox.entries.slice(1).map((entry) => entry.promptId),
    ["prompt-a", "prompt-b"],
  );
  expectCode("RESOURCE_OPERATION_DELIVERY_CONFLICT", () =>
    markResourceDeliveryDelivered(
      terminal,
      terminal.outbox.entries[0].deliveryId,
      { guard, at: 1081, confirmed: false },
    ),
  );
  expectCode("RESOURCE_OPERATION_DELIVERY_CONFLICT", () =>
    markResourceDeliveryDelivered(
      terminal,
      terminal.outbox.entries[1].deliveryId,
      { guard, at: 1081, confirmed: true },
    ),
  );

  const adoptedTerminal = adoptResourceOperationAuthority(terminal, nextGuard, {
    at: 1081,
  });
  assert.equal(adoptedTerminal.guard.leadershipGeneration, 5);
  assert.equal(
    decideResourceOperation(adoptedTerminal, { guard: nextGuard }).action,
    "deliver",
  );
  expectCode("RESOURCE_OPERATION_GUARD_MISMATCH", () =>
    markResourceDeliveryDelivered(
      adoptedTerminal,
      adoptedTerminal.outbox.entries[0].deliveryId,
      { guard, at: 1082, confirmed: true },
    ),
  );

  let delivered = terminal;
  let deliveredAt = 1081;
  for (const entry of terminal.outbox.entries) {
    delivered = markResourceDeliveryDelivered(delivered, entry.deliveryId, {
      guard,
      at: deliveredAt,
      confirmed: true,
    });
    const duplicate = markResourceDeliveryDelivered(
      delivered,
      entry.deliveryId,
      { guard: nextGuard, at: 9999, confirmed: false },
    );
    assert.deepEqual(duplicate, delivered);
    deliveredAt += 1;
  }
  assert.equal(decideResourceOperation(delivered).action, "replay");
  assert.equal(
    decideResourceOperation(delivered).receipt.runId,
    delivered.runId,
  );
  expectCode("RESOURCE_OPERATION_INVALID_TRANSITION", () =>
    transitionResourceOperation(terminal, "needs-review", {
      at: 1081,
      code: "late-review",
      reason: "should be impossible",
    }),
  );

  const malformed = structuredClone(delivered);
  malformed.report.bad = Number.POSITIVE_INFINITY;
  expectCode("RESOURCE_OPERATION_MALFORMED", () =>
    normalizeResourceOperation(malformed),
  );
  const exotic = structuredClone(delivered);
  exotic.report.when = new Date();
  expectCode("RESOURCE_OPERATION_MALFORMED", () =>
    normalizeResourceOperation(exotic),
  );
}

/* Zero-write upkeep finalizes directly from a persisted empty plan. */
{
  const record = prepared({ operationId: "no-write-upkeep" });
  const noWrites = transitionResourceOperation(record, "planned", {
    guard,
    at: 1001,
    yields: [],
    operations: [],
  });
  assert.equal(decideResourceOperation(noWrites, { guard }).action, "finalize");
  const done = transitionResourceOperation(noWrites, "terminal", {
    guard,
    at: 1002,
    report: { status: "complete" },
    receipt: { runId: noWrites.runId, status: "complete" },
    deliveries: terminalDeliveries(noWrites, { status: "complete" }),
  });
  assert.equal(done.timestamps.applyingAt, null);
  assert.equal(done.phase, "terminal");
}

/* Review is a one-way quarantine, including accessor/cycle-safe evidence. */
{
  const review = transitionResourceOperation(applying, "needs-review", {
    at: 1051,
    code: "canonical-third-state",
    reason: "The first Item ended at an unexpected quantity.",
    operationId: applying.plan[0].opId,
    evidence: { observedQuantity: 7 },
  });
  assert.equal(review.phase, "needs-review");
  assert.equal(decideResourceOperation(review).action, "needs-review");
  assert.equal(
    decideResourceOperation(review).operationId,
    applying.plan[0].opId,
  );
  expectCode("RESOURCE_OPERATION_INVALID_TRANSITION", () =>
    transitionResourceOperation(review, "applying", {
      guard,
      at: 1052,
    }),
  );
  expectCode("RESOURCE_OPERATION_INVALID_TRANSITION", () =>
    transitionResourceOperation(review, "terminal", {
      guard,
      at: 1052,
      receipt: { status: "dismissed" },
    }),
  );

  const cyclic = {};
  cyclic.self = cyclic;
  expectCode("RESOURCE_OPERATION_BOUNDS", () =>
    transitionResourceOperation(prepared(), "needs-review", {
      at: 1001,
      code: "cyclic-evidence",
      reason: "Bad evidence",
      evidence: cyclic,
    }),
  );
}

/* Legacy activeUpkeep is preserved for inspection but is never resumable. */
{
  const legacy = {
    runId: "legacy-calendar-42",
    trigger: "calendar",
    day: null,
    days: 1,
    startedAt: 400,
    claimedAt: 410,
    authorityId: null,
    authorityEpoch: null,
    environment: {
      id: "forest",
      label: "Forest",
      dc: 12,
      builtIn: true,
    },
    initiator: { userId: "gm-1", name: "GM", unexpected: true },
    actors: [
      {
        actorId: "actor-1",
        name: "Aster",
        role: "participant",
        forageTarget: null,
        ignored: "legacy detail",
      },
    ],
    unknownLegacyField: { retainedAsEvidence: true },
  };
  const quarantined = legacyActiveUpkeepToResourceOperation(legacy, {
    convertedAt: 500,
  });
  assert.equal(quarantined.phase, "needs-review");
  assert.equal(
    quarantined.operationId,
    "legacy-active-upkeep:legacy-calendar-42",
  );
  assert.equal(quarantined.guard.authorityId, "legacy-unrecorded-authority");
  assert.equal(quarantined.review.code, "legacy-active-upkeep-outcome-unknown");
  assert.equal(
    quarantined.review.evidence.unknownLegacyField.retainedAsEvidence,
    true,
  );
  assert.equal(decideResourceOperation(quarantined).action, "needs-review");
  expectCode("RESOURCE_OPERATION_INVALID_TRANSITION", () =>
    transitionResourceOperation(quarantined, "applying", {
      guard: quarantined.guard,
      at: 501,
    }),
  );

  const accessorLegacy = { ...legacy };
  Object.defineProperty(accessorLegacy, "runId", {
    enumerable: true,
    get() {
      throw new Error("must not run");
    },
  });
  expectCode("RESOURCE_OPERATION_MALFORMED", () =>
    legacyActiveUpkeepToResourceOperation(accessorLegacy, {
      convertedAt: 500,
    }),
  );
}

process.stdout.write("resource-operation-ledger validation passed\n");
