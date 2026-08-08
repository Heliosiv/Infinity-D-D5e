import assert from "node:assert/strict";

const saved = Object.fromEntries(
  ["game", "foundry", "CONST", "Hooks", "JournalEntry"].map((key) => [
    key,
    globalThis[key],
  ]),
);

const gmA = { id: "gm-a", isGM: true, role: 4, active: true };
const gmB = { id: "gm-b", isGM: true, role: 4, active: true };
const player = { id: "player-1", isGM: false, role: 1, active: true };
const users = [gmA, gmB, player];
users.activeGM = gmA;
users.get = (id) => users.find((user) => user.id === id) ?? null;
const settings = new Map([
  ["criticalInjuryWorkflow", { version: 1, records: [] }],
  ["criticalInjuryWorkflowCheckpoint", {}],
]);
let randomCounter = 0;

try {
  globalThis.CONST = {
    USER_ROLES: { GAMEMASTER: 4 },
    DOCUMENT_OWNERSHIP_LEVELS: { OWNER: 3 },
  };
  globalThis.Hooks = { on: () => ++randomCounter, off: () => {} };
  globalThis.foundry = {
    utils: {
      deepClone: (value) => structuredClone(value),
      randomID: () => `s${String(++randomCounter).padStart(23, "0")}`,
    },
  };
  delete globalThis.JournalEntry;
  globalThis.game = {
    ready: false,
    user: gmA,
    users,
    time: { serverTime: 10_000 },
    settings: {
      get(_moduleId, key) {
        return settings.get(key);
      },
      async set(_moduleId, key, value) {
        settings.set(key, structuredClone(value));
        return value;
      },
    },
  };

  const workflow = await import("./injury/workflow-store.js");
  workflow.resetCriticalInjuryWorkflowStoreForTests();
  await seedCompletedInjury(workflow, {
    pendingId: "pending-1",
    actorId: "actor-1",
    injuryId: "injury-1",
    effectId: "effect-1",
    injuryRoll: 7,
  });
  await seedCompletedInjury(workflow, {
    pendingId: "pending-2",
    actorId: "actor-2",
    injuryId: "injury-2",
    effectId: "effect-2",
    injuryRoll: 8,
  });

  const created = await workflow.createCriticalInjuryTreatmentRequest({
    actorId: "actor-1",
    injuryId: "injury-1",
    treatmentId: "treatment-1",
    requestedBy: player.id,
    requestedAt: 10_000,
  });
  assert.equal(created.createdNow, true);
  assert.equal(created.record.state, "requested");
  assert.equal(created.parent.pendingId, "pending-1");

  const duplicate = await workflow.createCriticalInjuryTreatmentRequest({
    actorId: "actor-1",
    injuryId: "injury-1",
    treatmentId: "treatment-1",
    requestedBy: player.id,
    requestedAt: 99_999,
  });
  assert.equal(duplicate.createdNow, false);
  assert.deepEqual(duplicate.record, created.record);
  await assert.rejects(
    workflow.createCriticalInjuryTreatmentRequest({
      actorId: "actor-1",
      injuryId: "injury-1",
      treatmentId: "treatment-1",
      requestedBy: "different-player",
    }),
    /TreatmentRequestCollision/,
  );
  const requesterHandoff = await workflow.createCriticalInjuryTreatmentRequest({
    actorId: "actor-1",
    injuryId: "injury-1",
    treatmentId: "treatment-1",
    requestedBy: "different-player",
    allowRequesterHandoff: true,
  });
  assert.equal(requesterHandoff.createdNow, false);
  assert.equal(requesterHandoff.requesterHandedOff, true);
  assert.equal(
    requesterHandoff.record.requestedBy,
    player.id,
    "ownership handoff preserves the original requester as audit data",
  );
  await assert.rejects(
    workflow.createCriticalInjuryTreatmentRequest({
      actorId: "actor-2",
      injuryId: "injury-2",
      treatmentId: "treatment-1",
      requestedBy: player.id,
      allowRequesterHandoff: true,
    }),
    /TreatmentRequestCollision/,
    "requester handoff cannot cross an Actor or injury boundary",
  );

  const siblingLoser = await workflow.createCriticalInjuryTreatmentRequest({
    actorId: "actor-1",
    injuryId: "injury-1",
    treatmentId: "treatment-2",
    requestedBy: player.id,
  });
  assert.equal(siblingLoser.createdNow, false);
  assert.equal(siblingLoser.resumeTreatmentId, "treatment-1");
  assert.equal(siblingLoser.record.treatmentId, "treatment-1");
  assert.equal(
    workflow.getCriticalInjuryTreatmentRecord("pending-1", "treatment-2"),
    null,
    "an unresolved sibling request is returned atomically without inserting a loser",
  );

  const globalAttempt = await workflow.createCriticalInjuryTreatmentRequest({
    actorId: "actor-2",
    injuryId: "injury-2",
    treatmentId: "treatment-global",
    requestedBy: player.id,
  });
  assert.equal(globalAttempt.createdNow, true);

  const firstClaim = await workflow.claimCriticalInjuryTreatmentApplication(
    "pending-1",
    "treatment-1",
    { id: "lease-a", claimedBy: gmA.id },
  );
  assert.equal(firstClaim.claimedNow, true);
  assert.equal(firstClaim.record.applicationLease.claimedBy, gmA.id);
  assert.equal(
    firstClaim.record.treatmentId,
    "treatment-1",
    "a requested treatment on another injury without a lease does not block",
  );
  const sameGmCompetition =
    await workflow.claimCriticalInjuryTreatmentApplication(
      "pending-1",
      "treatment-1",
      { id: "lease-other-tab", claimedBy: gmA.id },
    );
  assert.equal(sameGmCompetition.claimedNow, false);
  assert.equal(sameGmCompetition.record.applicationLease.id, "lease-a");
  const globalLiveBlock =
    await workflow.claimCriticalInjuryTreatmentApplication(
      "pending-2",
      "treatment-global",
      { id: "lease-global-blocked", claimedBy: gmA.id },
    );
  assert.equal(
    globalLiveBlock.claimedNow,
    false,
    "a live treatment lease blocks applications for every injury",
  );

  users.activeGM = gmB;
  globalThis.game.user = gmB;
  const handoffClaim = await workflow.claimCriticalInjuryTreatmentApplication(
    "pending-1",
    "treatment-1",
    { id: "lease-b", claimedBy: gmB.id },
  );
  assert.equal(handoffClaim.claimedNow, true);
  assert.equal(handoffClaim.record.applicationLease.id, "lease-b");
  assert.equal(handoffClaim.record.applicationLease.claimedBy, gmB.id);

  const resolution = buildTreatmentResolution(gmB.id);
  const persisted = await workflow.persistCriticalInjuryTreatmentResolution(
    "pending-1",
    "treatment-1",
    resolution,
    { applicationLeaseId: "lease-b" },
  );
  assert.equal(persisted.persistedNow, true);
  assert.deepEqual(persisted.record.resolution, {
    schema: 1,
    ...resolution,
  });
  const duplicatePersist =
    await workflow.persistCriticalInjuryTreatmentResolution(
      "pending-1",
      "treatment-1",
      structuredClone(resolution),
      { applicationLeaseId: "ignored-after-persist" },
    );
  assert.equal(duplicatePersist.persistedNow, false);

  const releasedResolution =
    await workflow.releaseCriticalInjuryTreatmentApplication(
      "pending-1",
      "treatment-1",
      "lease-b",
    );
  assert.equal(releasedResolution.releasedNow, true);
  const globalPlanningClaim =
    await workflow.claimCriticalInjuryTreatmentApplication(
      "pending-2",
      "treatment-global",
      { id: "lease-global-planning", claimedBy: gmB.id },
    );
  assert.equal(
    globalPlanningClaim.claimedNow,
    true,
    "an expired or released resolving lease does not block unrelated recovery",
  );
  const overlappingResolution = buildTreatmentResolution(gmB.id, {
    effectId: "effect-2",
    healerActorId: "actor-2",
    injuryId: "injury-2",
    kitActorId: "actor-1",
    itemId: "kit-1",
    receiptToken: "receipt-overlap",
  });
  await assert.rejects(
    workflow.persistCriticalInjuryTreatmentResolution(
      "pending-2",
      "treatment-global",
      overlappingResolution,
      { applicationLeaseId: "lease-global-planning" },
    ),
    /TreatmentItemReservationConflict/,
    "two unresolved treatments cannot reserve the same Actor Item",
  );
  assert.equal(
    workflow.getCriticalInjuryTreatmentRecord("pending-2", "treatment-global")
      .state,
    "requested",
  );
  const independentResolution = buildTreatmentResolution(gmB.id, {
    effectId: "effect-2",
    healerActorId: "actor-2",
    injuryId: "injury-2",
    kitActorId: "actor-2",
    itemId: "kit-2",
    receiptToken: "receipt-independent",
  });
  const independentPersist =
    await workflow.persistCriticalInjuryTreatmentResolution(
      "pending-2",
      "treatment-global",
      independentResolution,
      { applicationLeaseId: "lease-global-planning" },
    );
  assert.equal(
    independentPersist.persistedNow,
    true,
    "non-overlapping persisted kit plans may recover independently",
  );
  await workflow.releaseCriticalInjuryTreatmentApplication(
    "pending-2",
    "treatment-global",
    "lease-global-planning",
  );
  const resumedResolution =
    await workflow.claimCriticalInjuryTreatmentApplication(
      "pending-1",
      "treatment-1",
      { id: "lease-b-resumed", claimedBy: gmB.id },
    );
  assert.equal(resumedResolution.claimedNow, true);

  const result = {
    treatmentId: "treatment-1",
    injuryId: "injury-1",
    success: true,
    retryable: false,
    message: "Treatment succeeded.",
    consumed: 2,
    rollTotal: 18,
    dc: 12,
    effectId: "effect-1",
    calendarEntryId: "calendar-1",
    result: structuredClone(resolution.injuryAfter),
  };
  const completed = await workflow.completeCriticalInjuryTreatmentWorkflow(
    "pending-1",
    "treatment-1",
    {
      result,
      completedAt: 11_000,
      applicationLeaseId: "lease-b-resumed",
    },
  );
  assert.equal(completed.completedNow, true);
  assert.equal(completed.record.state, "completed");
  assert.deepEqual(completed.record.result, result);

  users.activeGM = gmA;
  globalThis.game.user = gmA;
  const replay = await workflow.completeCriticalInjuryTreatmentWorkflow(
    "pending-1",
    "treatment-1",
    {
      result: structuredClone(result),
      completedAt: 88_888,
      applicationLeaseId: "not-required-for-completed-replay",
    },
  );
  assert.equal(replay.completedNow, false);
  assert.deepEqual(replay.record, completed.record);

  const globalAfterCompletion =
    await workflow.claimCriticalInjuryTreatmentApplication(
      "pending-2",
      "treatment-global",
      { id: "lease-global-after", claimedBy: gmA.id },
    );
  assert.equal(
    globalAfterCompletion.claimedNow,
    true,
    "a stored non-overlapping plan remains independently resumable",
  );
  await workflow.releaseCriticalInjuryTreatmentApplication(
    "pending-2",
    "treatment-global",
    "lease-global-after",
  );

  const sibling = await workflow.createCriticalInjuryTreatmentRequest({
    actorId: "actor-1",
    injuryId: "injury-1",
    treatmentId: "treatment-2",
    requestedBy: player.id,
  });
  assert.equal(sibling.createdNow, true);

  const nextClaim = await workflow.claimCriticalInjuryTreatmentApplication(
    "pending-1",
    "treatment-2",
    { id: "lease-next", claimedBy: gmA.id },
  );
  assert.equal(
    nextClaim.claimedNow,
    true,
    "a fresh deliberate attempt is allowed after the prior receipt completes",
  );
  assert.equal(
    workflow.getCriticalInjuryTreatmentRecord("pending-1", "treatment-1").state,
    "completed",
  );
} finally {
  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) delete globalThis[key];
    else globalThis[key] = value;
  }
}

async function seedCompletedInjury(
  workflow,
  { pendingId, actorId, injuryId, effectId, injuryRoll },
) {
  const leaseId = `injury-lease-${pendingId}`;
  await workflow.createCriticalInjuryApproval({
    pendingId,
    actorId,
    targetUserId: player.id,
    approvedAt: 1_000,
  });
  await workflow.claimCriticalInjuryApplication(pendingId, {
    id: leaseId,
    claimedBy: gmA.id,
  });
  await workflow.persistCriticalInjuryResolution(
    pendingId,
    {
      injuryId,
      effectDocumentId: effectId,
      injuryKey: "crippling-injury",
      injuryRoll,
      tableVersion: 2,
      recoveryFormula: "1d4",
      recoveryDays: 4,
      detailTotal: null,
      recoveryStartTs: 1_000,
      recoveryDueTs: 346_600,
      requestedBy: player.id,
      resolvedBy: gmA.id,
      resolvedAt: 1_000,
    },
    { applicationLeaseId: leaseId },
  );
  await workflow.completeCriticalInjuryWorkflow(pendingId, {
    result: { id: injuryId, injuryRoll },
    effectId,
    completedAt: 1_000,
    applicationLeaseId: leaseId,
  });
}

function buildTreatmentResolution(
  resolvedBy,
  {
    effectId = "effect-1",
    healerActorId = "actor-1",
    injuryId = "injury-1",
    kitActorId = "actor-1",
    itemId = "kit-1",
    receiptToken = "receipt-1",
  } = {},
) {
  return {
    effectId,
    healerActorId,
    injuryKey: "crippling-injury",
    tableVersion: 2,
    treatmentStartTs: 10_500,
    treatmentDc: 12,
    treatmentSkill: "med",
    checkTotal: 18,
    passed: true,
    kitRequired: 2,
    receiptToken,
    consumptionSteps: [
      { actorId: kitActorId, itemId, before: 5, spend: 2, after: 3 },
    ],
    injuryBefore: {
      id: injuryId,
      injuryKey: "crippling-injury",
      stabilized: false,
    },
    injuryAfter: {
      id: injuryId,
      injuryKey: "crippling-injury",
      stabilized: true,
    },
    previousCalendarEntryId: "",
    resolvedBy,
    resolvedAt: 10_500,
  };
}

process.stdout.write("critical injury durable treatment store passed\n");
