#!/usr/bin/env node

import assert from "node:assert/strict";

import {
  RESOURCE_OPERATION_OUTBOX_LIMIT_V5,
  RESOURCE_RUN_STATE_V5_VERSION,
  ResourceRunStateV5Error,
  adoptResourceOperationAuthorityV5,
  assertResourceOperationCurrentV5,
  checkpointActiveResourceOperationV5,
  claimResourceOperationV5,
  clearReviewedResourceDeliveryBacklogV5,
  clearReviewedResourceOperationV5,
  completeResourceOperationV5,
  confirmResourceOperationDeliveryV5,
  createEmptyResourceRunStateV5,
  listPendingResourceOperationDeliveriesV5,
  listPendingResourceOperationsV5,
  migrateLegacyResourceRunStateToV5,
  migrateResourceRunStateV4ToV5,
  normalizeResourceRunStateV5,
  preflightResourceOperationClaimV5,
  preflightResourceOperationCompletionV5,
  prepareResourceRunStateV5,
} from "./resource/run-state-v5.js";
import {
  createResourceInventoryOperation,
  createResourceOperation,
  createResourceOperationContext,
  createResourceTerminalDeliveries,
  markResourceDeliveryDelivered,
  markResourceInventoryOperationApplied,
  recordResourcePromptResponse,
  recordResourcePromptTimeout,
  transitionResourceOperation,
} from "./resource/operation-ledger.js";
import {
  buildInterruptedRunReceipt,
  buildUpkeepRunReceipt,
} from "./resource/history.js";

const guard = Object.freeze({
  authorityId: "gm-1",
  authorityEpoch: "gm-1:epoch-1",
  leadershipGeneration: 1,
});
const nextGuard = Object.freeze({
  authorityId: "gm-2",
  authorityEpoch: "gm-2:epoch-2",
  leadershipGeneration: 2,
});
const environment = Object.freeze({
  id: "forest",
  label: "Forest",
  dc: 12,
  foodDc: 12,
  waterDc: 10,
});
const initiator = Object.freeze({ userId: "gm-1", name: "GM" });
const actors = Object.freeze([
  Object.freeze({
    actorId: "actor-1",
    name: "Ranger",
    role: "participant",
    forageTarget: null,
  }),
]);
const legacyActors = Object.freeze([
  Object.freeze({ actorId: "actor-1", name: "Ranger", role: "participant" }),
]);
const contextSnapshot = Object.freeze({
  rules: { forageMode: "each", waterEnabled: true },
  roster: [{ actorId: "actor-1", drawFromId: "actor-1" }],
});
const context = createResourceOperationContext(contextSnapshot);

function prepared({
  operationId = "operation-1",
  runId = operationId,
  trigger = "manual",
  day = trigger === "calendar" ? 42 : null,
  authorityGuard = guard,
  actorSnapshots = actors,
  createdAt = 100,
} = {}) {
  return createResourceOperation({
    operationId,
    runId,
    trigger,
    guard: authorityGuard,
    context,
    day,
    days: 1,
    environment,
    initiator,
    actors: actorSnapshots,
    createdAt,
  });
}

function planned(record, plannedAt = 110) {
  return transitionResourceOperation(record, "planned", {
    guard: record.guard,
    at: plannedAt,
    yields: [],
    operations: [],
  });
}

function terminal(
  record,
  { plannedAt = 110, terminalAt = 120, reportOverrides = {} } = {},
) {
  const plannedRecord = planned(record, plannedAt);
  const report = {
    version: 1,
    runId: record.runId,
    trigger: record.trigger,
    day: record.day,
    days: record.days,
    status: "complete",
    ...reportOverrides,
  };
  const receipt = buildUpkeepRunReceipt({
    result: {
      runId: record.runId,
      trigger: record.trigger,
      day: record.day,
      days: record.days,
      startedAt: record.timestamps.createdAt,
      resourceSnapshot: [],
      perActor: [],
      party: {},
      suggestions: [],
      hasErrors: false,
    },
    environment,
    recordedAt: terminalAt,
  });
  const deliveries = createResourceTerminalDeliveries(plannedRecord, {
    report,
  });
  return transitionResourceOperation(plannedRecord, "terminal", {
    guard: record.guard,
    at: terminalAt,
    report,
    receipt,
    deliveries,
  });
}

function empty(overrides = {}) {
  return createEmptyResourceRunStateV5({
    authorityId: guard.authorityId,
    authorityEpoch: guard.authorityEpoch,
    ...overrides,
  });
}

function legacyV4(activeUpkeep = null) {
  return {
    version: 4,
    revision: 7,
    authorityId: guard.authorityId,
    authorityEpoch: guard.authorityEpoch,
    lastSeenDay: 41,
    currentEnvironmentId: environment.id,
    lastUpkeepResult: { runId: "prior-run", status: "complete" },
    activeUpkeep,
    recentRuns: [],
  };
}

function legacyActive() {
  return {
    runId: "legacy-run",
    trigger: "calendar",
    day: 42,
    days: 1,
    startedAt: 90,
    claimedAt: 100,
    authorityId: guard.authorityId,
    authorityEpoch: guard.authorityEpoch,
    leadershipGeneration: guard.leadershipGeneration,
    environment,
    initiator,
    actors: legacyActors,
    forageTarget: null,
    forageAssignments: [],
    forageDestination: null,
  };
}

function expectCode(code, callback) {
  assert.throws(callback, (error) => {
    assert.ok(error instanceof ResourceRunStateV5Error);
    assert.equal(error.code, code);
    assert.equal(error.zeroWrite, true);
    return true;
  });
}

/* Exact envelope parsing owns its data and rejects extras/accessors/future data. */
{
  const state = empty({
    revision: 3,
    lastSeenDay: 8,
    currentEnvironmentId: "forest",
    lastUpkeepResult: { nested: { value: 1 } },
  });
  assert.equal(state.version, RESOURCE_RUN_STATE_V5_VERSION);
  assert.deepEqual(Object.keys(state), [
    "version",
    "revision",
    "authorityId",
    "authorityEpoch",
    "lastSeenDay",
    "currentEnvironmentId",
    "lastUpkeepResult",
    "activeOperation",
    "operationOutbox",
    "recentRuns",
  ]);
  assert.ok(Object.isFrozen(state));
  assert.ok(Object.isFrozen(state.lastUpkeepResult.nested));
  expectCode("RESOURCE_RUN_STATE_V5_MALFORMED", () =>
    normalizeResourceRunStateV5({ ...state, surprise: true }),
  );
  expectCode("RESOURCE_RUN_STATE_V5_FUTURE_VERSION", () =>
    normalizeResourceRunStateV5({ ...state, version: 6 }),
  );
  let invoked = false;
  const accessor = structuredClone(state);
  Object.defineProperty(accessor, "recentRuns", {
    enumerable: true,
    get() {
      invoked = true;
      return [];
    },
  });
  expectCode("RESOURCE_RUN_STATE_V5_MALFORMED", () =>
    normalizeResourceRunStateV5(accessor),
  );
  assert.equal(
    invoked,
    false,
    "strict parsing never invokes persisted accessors",
  );
}

/* v4 conversion is deterministic and quarantines activeUpkeep as needs-review. */
{
  const raw = legacyV4(legacyActive());
  const before = structuredClone(raw);
  const first = migrateResourceRunStateV4ToV5(raw);
  const second = migrateResourceRunStateV4ToV5(raw);
  assert.deepEqual(first, second);
  assert.deepEqual(raw, before, "migration never mutates persisted input");
  assert.equal(first.revision, 7);
  assert.equal(first.activeOperation.phase, "needs-review");
  assert.deepEqual(
    first.activeOperation.review.code,
    "legacy-active-upkeep-outcome-unknown",
  );
  assert.deepEqual(first.activeOperation.review.evidence, raw.activeUpkeep);
  assert.deepEqual(first.operationOutbox, []);

  const decision = prepareResourceRunStateV5(raw);
  assert.equal(decision.action, "migrate");
  assert.equal(decision.writeRequired, true);
  assert.deepEqual(decision.state, first);
  assert.equal(prepareResourceRunStateV5(first).action, "none");
}

/* Nested persisted accessors are rejected without invoking receipt/legacy getters. */
{
  const receipt = terminal(prepared({ operationId: "getter-receipt" })).receipt;
  const raw = structuredClone(empty());
  raw.recentRuns = [structuredClone(receipt)];
  let receiptGetterInvoked = false;
  Object.defineProperty(raw.recentRuns[0], "status", {
    enumerable: true,
    get() {
      receiptGetterInvoked = true;
      return "complete";
    },
  });
  expectCode("RESOURCE_RUN_STATE_V5_MALFORMED", () =>
    normalizeResourceRunStateV5(raw),
  );
  assert.equal(receiptGetterInvoked, false);

  const active = structuredClone(legacyActive());
  let environmentGetterInvoked = false;
  Object.defineProperty(active.environment, "label", {
    enumerable: true,
    get() {
      environmentGetterInvoked = true;
      return "Unsafe";
    },
  });
  const blocked = prepareResourceRunStateV5(legacyV4(active));
  assert.equal(blocked.action, "blocked");
  assert.equal(environmentGetterInvoked, false);
}

/* Same-version corruption, corrupt v4, invalid versions, and future data block zero-write. */
{
  const corruptV5 = { ...empty(), recentRuns: [{ nope: true }] };
  const corruptV4 = { ...legacyV4(), activeUpkeep: { nope: true } };
  const future = { version: 6, opaque: { keep: true } };
  for (const raw of [corruptV5, corruptV4, future, { version: "wat" }]) {
    const before = structuredClone(raw);
    const result = prepareResourceRunStateV5(raw);
    assert.equal(result.action, "blocked");
    assert.equal(result.writeRequired, false);
    assert.equal(result.zeroWrite, true);
    assert.equal(result.state, null);
    assert.deepEqual(raw, before);
  }
  assert.equal(
    prepareResourceRunStateV5(future).error.code,
    "RESOURCE_RUN_STATE_V5_FUTURE_VERSION",
  );
}

/* Missing/v0-v3 worlds migrate deterministically without replaying unknown work. */
{
  for (const version of [undefined, 0, 1, 2, 3]) {
    const raw = {
      ...(version === undefined ? {} : { version }),
      revision: "not-a-revision",
      lastSeenDay: "12.9",
      currentEnvironmentId: " forest ",
      lastUpkeepResult: { status: "legacy" },
      activeUpkeep: null,
      recentRuns: [{ malformed: true }],
      ignoredLegacyField: true,
    };
    const first = migrateLegacyResourceRunStateToV5(raw, {
      authorityId: "gm-current",
      authorityEpoch: "gm-current:epoch",
    });
    const second = prepareResourceRunStateV5(raw, {
      authorityId: "gm-current",
      authorityEpoch: "gm-current:epoch",
    });
    assert.equal(second.action, "migrate");
    assert.deepEqual(second.state, first);
    assert.equal(first.revision, 0);
    assert.equal(first.lastSeenDay, 12);
    assert.equal(first.currentEnvironmentId, "forest");
    assert.equal(first.activeOperation, null);
    assert.deepEqual(first.operationOutbox, []);
    assert.deepEqual(first.recentRuns, []);
  }

  const recognized = prepareResourceRunStateV5({
    ...legacyV4(legacyActive()),
    version: 3,
  });
  assert.equal(recognized.action, "migrate");
  assert.equal(recognized.state.activeOperation.phase, "needs-review");
  assert.equal(
    recognized.state.activeOperation.review.code,
    "legacy-active-upkeep-outcome-unknown",
  );

  const unknownActive = {
    version: 2,
    activeUpkeep: { runId: "ambiguous", unknownEvidence: true },
  };
  const before = structuredClone(unknownActive);
  const blocked = prepareResourceRunStateV5(unknownActive);
  assert.equal(blocked.action, "blocked");
  assert.equal(blocked.state, null);
  assert.equal(blocked.zeroWrite, true);
  assert.deepEqual(unknownActive, before);

  const v5Active = structuredClone(
    claimResourceOperationV5(
      empty(),
      prepared({ operationId: "versionless-active" }),
    ),
  );
  delete v5Active.version;
  const blockedActive = prepareResourceRunStateV5(v5Active);
  assert.equal(blockedActive.action, "blocked");
  assert.equal(blockedActive.state, null);
  const outboxOperation = prepared({ operationId: "versionless-outbox" });
  const outboxClaimed = claimResourceOperationV5(empty(), outboxOperation);
  const v5Outbox = structuredClone(
    completeResourceOperationV5(
      checkpointActiveResourceOperationV5(
        outboxClaimed,
        planned(outboxOperation),
      ),
      terminal(outboxOperation),
    ),
  );
  delete v5Outbox.version;
  const blockedOutbox = prepareResourceRunStateV5(v5Outbox);
  assert.equal(blockedOutbox.action, "blocked");
  assert.equal(blockedOutbox.state, null);

  let coercionHooks = 0;
  const coercive = {
    version: 1,
    revision: {
      valueOf() {
        coercionHooks += 1;
        return 9;
      },
    },
    lastSeenDay: {
      [Symbol.toPrimitive]() {
        coercionHooks += 1;
        return 44;
      },
    },
    activeUpkeep: null,
  };
  const sanitized = prepareResourceRunStateV5(coercive);
  assert.equal(sanitized.action, "migrate");
  assert.equal(sanitized.state.revision, 0);
  assert.equal(sanitized.state.lastSeenDay, null);
  assert.equal(coercionHooks, 0);
}

/* Claims reserve calendar day before work, preserve old frames, and reject reused IDs. */
{
  const state = empty({ lastSeenDay: 41 });
  const operation = prepared({
    operationId: "calendar-operation",
    trigger: "calendar",
    day: 42,
  });
  const preflight = preflightResourceOperationClaimV5(state, operation);
  assert.equal(preflight.action, "claim");
  assert.equal(preflight.reservedDay, 42);
  const claimed = claimResourceOperationV5(state, operation);
  assert.equal(state.activeOperation, null, "claim is immutable");
  assert.equal(claimed.revision, 1);
  assert.equal(claimed.lastSeenDay, 42);
  assert.equal(claimed.activeOperation.operationId, "calendar-operation");
  expectCode("RESOURCE_RUN_STATE_V5_CONFLICT", () =>
    claimResourceOperationV5(claimed, prepared({ operationId: "other" })),
  );
}

/* Active checkpoints and the immediate applying fence require exact identity/guard. */
{
  const operation = prepared({ operationId: "write-operation" });
  const claimed = claimResourceOperationV5(empty(), operation);
  const inventoryOperation = createResourceInventoryOperation({
    runId: operation.runId,
    sequence: 0,
    action: "update",
    actorId: "actor-1",
    itemId: "ration-stack",
    resourceId: "food",
    beforeQuantity: 5,
    afterQuantity: 4,
  });
  const planned = transitionResourceOperation(operation, "planned", {
    guard,
    at: 110,
    yields: [],
    operations: [inventoryOperation],
  });
  const applying = transitionResourceOperation(planned, "applying", {
    guard,
    at: 120,
  });
  const plannedState = checkpointActiveResourceOperationV5(claimed, planned);
  const checkpointed = checkpointActiveResourceOperationV5(
    plannedState,
    applying,
  );
  assert.equal(checkpointed.revision, 3);
  assert.deepEqual(
    assertResourceOperationCurrentV5(checkpointed, applying.runId, guard),
    checkpointed.activeOperation,
  );
  expectCode("RESOURCE_RUN_STATE_V5_FENCE_LOST", () =>
    assertResourceOperationCurrentV5(checkpointed, applying.runId, nextGuard),
  );
  const rotatedEnvelope = normalizeResourceRunStateV5({
    ...checkpointed,
    authorityId: nextGuard.authorityId,
    authorityEpoch: nextGuard.authorityEpoch,
  });
  expectCode("RESOURCE_RUN_STATE_V5_FENCE_LOST", () =>
    checkpointActiveResourceOperationV5(
      rotatedEnvelope,
      rotatedEnvelope.activeOperation,
      {
        authorityId: guard.authorityId,
        authorityEpoch: guard.authorityEpoch,
      },
    ),
  );
}

/* Active and terminal-backlog authority adoption are atomic state checkpoints. */
{
  const active = claimResourceOperationV5(
    empty(),
    prepared({ operationId: "adopt-active" }),
  );
  const adoptedActive = adoptResourceOperationAuthorityV5(active, {
    location: "active",
    operationId: "adopt-active",
    runId: "adopt-active",
    nextGuard,
    contextSnapshot,
    observations: [],
    at: 101,
  });
  assert.equal(adoptedActive.authorityId, nextGuard.authorityId);
  assert.deepEqual(adoptedActive.activeOperation.guard, nextGuard);
  const mislabeledAdoption = structuredClone(adoptedActive.activeOperation);
  mislabeledAdoption.authorityAdoptions[0].phase = "terminal";
  expectCode("RESOURCE_RUN_STATE_V5_CONFLICT", () =>
    checkpointActiveResourceOperationV5(active, mislabeledAdoption, {
      authorityId: nextGuard.authorityId,
      authorityEpoch: nextGuard.authorityEpoch,
    }),
  );

  const original = prepared({ operationId: "adopt-terminal" });
  const claimed = claimResourceOperationV5(empty(), original);
  const plannedState = checkpointActiveResourceOperationV5(
    claimed,
    planned(original),
  );
  const completed = completeResourceOperationV5(
    plannedState,
    terminal(original),
  );
  const rotatedEnvelope = normalizeResourceRunStateV5({
    ...completed,
    authorityId: nextGuard.authorityId,
    authorityEpoch: nextGuard.authorityEpoch,
  });
  const pendingDeliveryId =
    rotatedEnvelope.operationOutbox[0].outbox.entries[0].deliveryId;
  expectCode("RESOURCE_RUN_STATE_V5_FENCE_LOST", () =>
    confirmResourceOperationDeliveryV5(rotatedEnvelope, {
      operationId: original.operationId,
      runId: original.runId,
      deliveryId: pendingDeliveryId,
      guard,
      at: 130,
      confirmed: true,
    }),
  );
  const adoptedTerminal = adoptResourceOperationAuthorityV5(rotatedEnvelope, {
    location: "outbox",
    runId: "adopt-terminal",
    nextGuard,
    at: 130,
  });
  assert.equal(adoptedTerminal.authorityId, nextGuard.authorityId);
  assert.deepEqual(adoptedTerminal.operationOutbox[0].guard, nextGuard);
  assert.equal(adoptedTerminal.operationOutbox[0].phase, "terminal");
  const deliveredTerminal = markResourceDeliveryDelivered(
    adoptedTerminal.operationOutbox[0],
    pendingDeliveryId,
    { guard: nextGuard, at: 140, confirmed: true },
  );
  const drained = confirmResourceOperationDeliveryV5(adoptedTerminal, {
    operationId: original.operationId,
    runId: original.runId,
    deliveryId: pendingDeliveryId,
    guard: nextGuard,
    updatedRecord: deliveredTerminal,
  });
  assert.deepEqual(drained.operationOutbox, []);
}

/* Active checkpoints are append-only and cannot roll back prompts/plans/writes. */
{
  const promptActors = [
    {
      actorId: "actor-1",
      name: "Ranger",
      role: "participant",
      forageTarget: "food",
    },
    {
      actorId: "actor-2",
      name: "Druid",
      role: "participant",
      forageTarget: "water",
    },
  ];
  const promptOperation = prepared({
    operationId: "monotonic-prompts",
    actorSnapshots: promptActors,
  });
  const assignments = [
    {
      promptId: "prompt-1",
      actorId: "actor-1",
      userId: "player-1",
      forageTarget: "food",
      dc: 12,
      foodDc: 12,
      waterDc: 10,
      assignedAt: 105,
      deadlineAt: 150,
    },
    {
      promptId: "prompt-2",
      actorId: "actor-2",
      userId: "player-2",
      forageTarget: "water",
      dc: 10,
      foodDc: 12,
      waterDc: 10,
      assignedAt: 105,
      deadlineAt: 150,
    },
  ];
  const prompting = transitionResourceOperation(promptOperation, "prompting", {
    guard,
    at: 105,
    assignments,
  });
  const promptingState = checkpointActiveResourceOperationV5(
    claimResourceOperationV5(empty(), promptOperation),
    prompting,
  );
  const responded = recordResourcePromptResponse(
    prompting,
    {
      promptId: "prompt-1",
      rollTotal: 15,
      wisMod: 2,
      skipped: false,
    },
    { guard, at: 110 },
  );
  const respondedState = checkpointActiveResourceOperationV5(
    promptingState,
    responded,
  );
  const timedOut = recordResourcePromptTimeout(responded, "prompt-2", {
    guard,
    at: 150,
  });
  const timedOutState = checkpointActiveResourceOperationV5(
    respondedState,
    timedOut,
  );
  expectCode("RESOURCE_RUN_STATE_V5_CONFLICT", () =>
    checkpointActiveResourceOperationV5(timedOutState, responded),
  );
  const replacement = recordResourcePromptResponse(
    prompting,
    {
      promptId: "prompt-1",
      rollTotal: 16,
      wisMod: 3,
      skipped: false,
    },
    { guard, at: 111 },
  );
  expectCode("RESOURCE_RUN_STATE_V5_CONFLICT", () =>
    checkpointActiveResourceOperationV5(respondedState, replacement),
  );

  const writeOperation = prepared({ operationId: "monotonic-writes" });
  const write = createResourceInventoryOperation({
    runId: writeOperation.runId,
    sequence: 0,
    action: "update",
    actorId: "actor-1",
    itemId: "ration-stack",
    resourceId: "food",
    beforeQuantity: 5,
    afterQuantity: 4,
  });
  const alternateWrite = createResourceInventoryOperation({
    runId: writeOperation.runId,
    sequence: 0,
    action: "update",
    actorId: "actor-1",
    itemId: "ration-stack",
    resourceId: "food",
    beforeQuantity: 5,
    afterQuantity: 3,
  });
  const plannedWrite = transitionResourceOperation(writeOperation, "planned", {
    guard,
    at: 110,
    yields: [],
    operations: [write],
  });
  const alternatePlan = transitionResourceOperation(writeOperation, "planned", {
    guard,
    at: 110,
    yields: [],
    operations: [alternateWrite],
  });
  const plannedState = checkpointActiveResourceOperationV5(
    claimResourceOperationV5(empty(), writeOperation),
    plannedWrite,
  );
  expectCode("RESOURCE_RUN_STATE_V5_CONFLICT", () =>
    checkpointActiveResourceOperationV5(plannedState, alternatePlan),
  );
  const applying = transitionResourceOperation(plannedWrite, "applying", {
    guard,
    at: 120,
  });
  const applyingState = checkpointActiveResourceOperationV5(
    plannedState,
    applying,
  );
  const reconciledHandoff = adoptResourceOperationAuthorityV5(applyingState, {
    location: "active",
    runId: writeOperation.runId,
    nextGuard,
    contextSnapshot,
    observations: [
      {
        actorId: "actor-1",
        itemId: "ration-stack",
        exists: true,
        quantity: 4,
        matchesResource: true,
      },
    ],
    at: 130,
  });
  assert.deepEqual(reconciledHandoff.activeOperation.appliedOperationIds, [
    write.opId,
  ]);
  assert.deepEqual(reconciledHandoff.activeOperation.guard, nextGuard);
  expectCode("RESOURCE_RUN_STATE_V5_CONFLICT", () =>
    preflightResourceOperationCompletionV5(
      applyingState,
      terminal(writeOperation),
    ),
  );
  const marked = markResourceInventoryOperationApplied(applying, write.opId, {
    guard,
    at: 130,
    observed: { exists: true, quantity: 4, matchesResource: true },
  });
  const markedState = checkpointActiveResourceOperationV5(
    applyingState,
    marked,
  );
  expectCode("RESOURCE_RUN_STATE_V5_CONFLICT", () =>
    checkpointActiveResourceOperationV5(markedState, applying),
  );
}

/* Completion atomically archives receipt, moves terminal to FIFO, and clears active. */
{
  const operation = prepared({ operationId: "complete-operation" });
  const claimed = claimResourceOperationV5(empty(), operation);
  const plannedState = checkpointActiveResourceOperationV5(
    claimed,
    planned(operation),
  );
  const finished = terminal(operation);
  const interruptedReceipt = buildInterruptedRunReceipt(
    {
      runId: finished.runId,
      trigger: finished.trigger,
      day: finished.day,
      days: finished.days,
      startedAt: finished.timestamps.createdAt,
      claimedAt: finished.timestamps.preparedAt,
      environment: finished.environment,
      initiator: finished.initiator,
      actors: finished.actors,
    },
    finished.timestamps.terminalAt,
  );
  const invalidReceipts = [
    interruptedReceipt,
    { ...finished.receipt, trigger: "calendar" },
    { ...finished.receipt, day: 99 },
    { ...finished.receipt, days: 2 },
    { ...finished.receipt, status: "partial" },
    {
      ...finished.receipt,
      environment: { ...finished.receipt.environment, id: "desert" },
    },
  ];
  for (const receipt of invalidReceipts) {
    expectCode("RESOURCE_RUN_STATE_V5_MALFORMED", () =>
      preflightResourceOperationCompletionV5(plannedState, {
        ...finished,
        receipt,
      }),
    );
  }
  const mismatchedReport = terminal(operation, {
    reportOverrides: { runId: "different-report-run" },
  });
  expectCode("RESOURCE_RUN_STATE_V5_MALFORMED", () =>
    preflightResourceOperationCompletionV5(plannedState, mismatchedReport),
  );
  const invalidReportStatus = terminal(operation, {
    reportOverrides: { status: "unknown" },
  });
  expectCode("RESOURCE_RUN_STATE_V5_MALFORMED", () =>
    preflightResourceOperationCompletionV5(plannedState, invalidReportStatus),
  );
  const preflight = preflightResourceOperationCompletionV5(
    plannedState,
    finished,
  );
  assert.equal(preflight.action, "complete");
  expectCode("RESOURCE_RUN_STATE_V5_CONFLICT", () =>
    completeResourceOperationV5(plannedState, finished, {
      result: { runId: finished.runId, status: "different" },
    }),
  );
  const completed = completeResourceOperationV5(plannedState, finished, {
    runId: finished.runId,
    guard,
    at: finished.timestamps.terminalAt,
    receipt: finished.receipt,
  });
  assert.equal(completed.activeOperation, null);
  assert.equal(completed.operationOutbox.length, 1);
  assert.deepEqual(completed.recentRuns[0], finished.receipt);
  assert.deepEqual(completed.lastUpkeepResult, finished.report);
  assert.equal(plannedState.activeOperation.operationId, operation.operationId);

  const pending = listPendingResourceOperationDeliveriesV5(completed);
  assert.equal(pending.length, 1);
  assert.equal(pending[0].operationId, operation.operationId);
  assert.equal(
    pending[0].delivery.deliveryId,
    finished.outbox.entries[0].deliveryId,
  );
  assert.deepEqual(listPendingResourceOperationsV5(completed), [finished]);

  const updatedRecord = markResourceDeliveryDelivered(
    finished,
    finished.outbox.entries[0].deliveryId,
    { guard, at: 130, confirmed: true },
  );
  const delivered = confirmResourceOperationDeliveryV5(completed, {
    operationId: operation.operationId,
    runId: operation.runId,
    deliveryId: finished.outbox.entries[0].deliveryId,
    guard,
    updatedRecord,
  });
  assert.deepEqual(delivered.operationOutbox, []);
  assert.deepEqual(delivered.recentRuns[0], finished.receipt);
}

/* Outbox capacity is preflighted before claiming so completion always has a slot. */
{
  const terminals = Array.from(
    { length: RESOURCE_OPERATION_OUTBOX_LIMIT_V5 },
    (_, index) => {
      const operation = prepared({
        operationId: `backlog-${index}`,
        runId: `backlog-${index}`,
        createdAt: 100 + index * 10,
      });
      return terminal(operation, {
        plannedAt: 101 + index * 10,
        terminalAt: 102 + index * 10,
      });
    },
  );
  const full = normalizeResourceRunStateV5({
    ...empty(),
    operationOutbox: terminals,
    recentRuns: terminals.map((operation) => operation.receipt).reverse(),
  });
  expectCode("RESOURCE_RUN_STATE_V5_OUTBOX_FULL", () =>
    preflightResourceOperationClaimV5(
      full,
      prepared({ operationId: "blocked-by-backlog" }),
    ),
  );

  const reviewState = migrateResourceRunStateV4ToV5(legacyV4(legacyActive()));
  const withReviewAndNineteen = normalizeResourceRunStateV5({
    ...reviewState,
    operationOutbox: terminals.slice(0, 19),
    recentRuns: terminals
      .slice(0, 19)
      .map((operation) => operation.receipt)
      .reverse(),
  });
  const reviewCleared = clearReviewedResourceOperationV5(
    withReviewAndNineteen,
    {
      operationId: withReviewAndNineteen.activeOperation.operationId,
      runId: withReviewAndNineteen.activeOperation.runId,
      recordedAt: 400,
      confirmed: true,
    },
  );
  assert.equal(reviewCleared.recentRuns.length, 20);
  expectCode("RESOURCE_RUN_STATE_V5_HISTORY_FULL", () =>
    preflightResourceOperationClaimV5(
      reviewCleared,
      prepared({ operationId: "blocked-by-history" }),
    ),
  );
}

/* Needs-review checkpoints cannot carry history for a different trigger/day. */
{
  const operation = prepared({ operationId: "review-receipt-binding" });
  const claimed = claimResourceOperationV5(empty(), operation);
  const receiptSource = {
    runId: operation.runId,
    trigger: operation.trigger,
    day: operation.day,
    days: operation.days,
    startedAt: operation.timestamps.createdAt,
    claimedAt: operation.timestamps.preparedAt,
    environment: operation.environment,
    initiator: operation.initiator,
    actors: operation.actors,
  };
  const wrongReceipts = [
    buildInterruptedRunReceipt({ ...receiptSource, trigger: "calendar" }, 110),
    buildInterruptedRunReceipt({ ...receiptSource, day: 99 }, 110),
  ];
  for (const receipt of wrongReceipts) {
    const review = transitionResourceOperation(operation, "needs-review", {
      at: 110,
      code: "injected-review",
      reason: "Injected review receipt mismatch",
      evidence: { test: true },
      receipt,
    });
    expectCode("RESOURCE_RUN_STATE_V5_MALFORMED", () =>
      checkpointActiveResourceOperationV5(claimed, review),
    );
  }
}

/* GM-reviewed clears require exact identities and a full current pending-ID snapshot. */
{
  const migrated = migrateResourceRunStateV4ToV5(legacyV4(legacyActive()));
  expectCode("RESOURCE_RUN_STATE_V5_REVIEW_REQUIRED", () =>
    clearReviewedResourceOperationV5(migrated, {
      operationId: migrated.activeOperation.operationId,
      runId: migrated.activeOperation.runId,
      recordedAt: 200,
      confirmed: false,
    }),
  );
  const unrelatedReceipt = terminal(
    prepared({
      operationId: "legacy-run",
      runId: "legacy-run",
      trigger: "manual",
    }),
  ).receipt;
  expectCode("RESOURCE_RUN_STATE_V5_CONFLICT", () =>
    clearReviewedResourceOperationV5(migrated, {
      operationId: migrated.activeOperation.operationId,
      runId: migrated.activeOperation.runId,
      receipt: unrelatedReceipt,
      recordedAt: 200,
      confirmed: true,
    }),
  );
  const cleared = clearReviewedResourceOperationV5(migrated, {
    operationId: migrated.activeOperation.operationId,
    runId: migrated.activeOperation.runId,
    recordedAt: 200,
    confirmed: true,
  });
  assert.equal(cleared.activeOperation, null);
  assert.equal(cleared.recentRuns[0].kind, "interrupted");
  assert.equal(cleared.recentRuns[0].runId, "legacy-run");

  const operation = prepared({ operationId: "review-delivery" });
  const claimed = claimResourceOperationV5(empty(), operation);
  const completed = completeResourceOperationV5(
    checkpointActiveResourceOperationV5(claimed, planned(operation)),
    terminal(operation),
  );
  const pendingDeliveryIds = completed.operationOutbox[0].outbox.entries
    .filter((entry) => entry.state === "pending")
    .map((entry) => entry.deliveryId);
  expectCode("RESOURCE_RUN_STATE_V5_CONFLICT", () =>
    clearReviewedResourceDeliveryBacklogV5(completed, {
      operationId: operation.operationId,
      runId: operation.runId,
      pendingDeliveryIds: [],
      confirmed: true,
    }),
  );
  const deliveryCleared = clearReviewedResourceDeliveryBacklogV5(completed, {
    operationId: operation.operationId,
    runId: operation.runId,
    pendingDeliveryIds,
    confirmed: true,
  });
  assert.deepEqual(deliveryCleared.operationOutbox, []);
  assert.equal(deliveryCleared.recentRuns[0].runId, operation.runId);
}

/* Physical backlog order is bound to newest-first receipt history. */
{
  const first = terminal(
    prepared({ operationId: "fifo-first", createdAt: 100 }),
    { plannedAt: 110, terminalAt: 120 },
  );
  const second = terminal(
    prepared({ operationId: "fifo-second", createdAt: 130 }),
    { plannedAt: 140, terminalAt: 150 },
  );
  const canonical = normalizeResourceRunStateV5({
    ...empty(),
    operationOutbox: [first, second],
    recentRuns: [second.receipt, first.receipt],
  });
  assert.deepEqual(
    canonical.operationOutbox.map((operation) => operation.runId),
    ["fifo-first", "fifo-second"],
  );
  expectCode("RESOURCE_RUN_STATE_V5_MALFORMED", () =>
    normalizeResourceRunStateV5({
      ...canonical,
      operationOutbox: [second, first],
    }),
  );
}

console.log("resource run-state v5 checks passed");
