import assert from "node:assert/strict";

const savedGame = globalThis.game;
const savedConst = globalThis.CONST;
const savedFoundry = globalThis.foundry;
const savedJournalEntry = globalThis.JournalEntry;

const gm = { id: "gm-1", isGM: true, role: 4, active: true };
const secondGm = { id: "gm-2", isGM: true, role: 4, active: true };
const player = {
  id: "player-1",
  isGM: false,
  role: 1,
  active: true,
  character: "actor-1",
};
const users = [gm, secondGm, player];
users.activeGM = gm;
users.get = (id) => users.find((user) => user.id === id) ?? null;
const settings = new Map();
let settingWrites = 0;

try {
  globalThis.CONST = { USER_ROLES: { GAMEMASTER: 4 } };
  globalThis.foundry = {
    utils: { deepClone: (value) => structuredClone(value) },
  };
  delete globalThis.JournalEntry;
  globalThis.game = {
    ready: false,
    user: gm,
    users,
    time: { serverTime: 3100 },
    settings: {
      get(moduleId, key) {
        assert.equal(moduleId, "infinity-dnd5e");
        return settings.get(key);
      },
      async set(moduleId, key, value) {
        assert.equal(moduleId, "infinity-dnd5e");
        settings.set(key, structuredClone(value));
        settingWrites += 1;
        return value;
      },
    },
  };

  const {
    authorizeCriticalInjuryWorkflowRequest,
    claimCriticalInjuryApplication,
    completeCriticalInjuryWorkflow,
    createCriticalInjuryApproval,
    discardCriticalInjuryApproval,
    ensureCriticalInjuryWorkflowAuthority,
    getCriticalInjuryWorkflowLeaseTimestamp,
    getCriticalInjuryWorkflowRecord,
    loadCriticalInjuryWorkflowStore,
    normalizeCriticalInjuryWorkflowStore,
    persistCriticalInjuryResolution,
    renewCriticalInjuryApplication,
    resetCriticalInjuryWorkflowStoreForTests,
    retargetCriticalInjuryWorkflow,
  } = await import("./injury/workflow-store.js");

  assert.equal(
    getCriticalInjuryWorkflowLeaseTimestamp(),
    3100,
    "application leases use Foundry's synchronized server time",
  );

  assert.deepEqual(normalizeCriticalInjuryWorkflowStore(null), {
    version: 2,
    revision: 0,
    authorityId: null,
    authorityEpoch: null,
    writeToken: null,
    records: [],
  });
  assert.equal(
    normalizeCriticalInjuryWorkflowStore({
      records: [{ pendingId: "forged-player-record" }],
    }).records.length,
    0,
    "malformed or player-fabricated data is not accepted as an approval",
  );

  const approval = await createCriticalInjuryApproval({
    pendingId: "pending-1",
    actorId: "actor-1",
    targetUserId: player.id,
    approvedAt: 1000,
  });
  assert.equal(approval.state, "approved");
  assert.equal(approval.approvedBy, gm.id);
  assert.deepEqual(getCriticalInjuryWorkflowRecord("pending-1"), approval);

  assert.deepEqual(
    authorizeCriticalInjuryWorkflowRequest(approval, {
      actorId: "actor-1",
      requestUserId: player.id,
      authoritativeUserId: gm.id,
    }),
    { ok: true, reason: null },
  );
  assert.equal(
    authorizeCriticalInjuryWorkflowRequest(approval, {
      actorId: "actor-1",
      requestUserId: secondGm.id,
      authoritativeUserId: gm.id,
    }).reason,
    "requester-not-approved",
    "a secondary GM cannot stand in for the recorded player or authority",
  );
  assert.equal(
    authorizeCriticalInjuryWorkflowRequest(approval, {
      actorId: "actor-2",
      requestUserId: player.id,
      authoritativeUserId: gm.id,
    }).reason,
    "approval-actor-mismatch",
  );

  const resolution = {
    injuryId: "injury-1",
    effectDocumentId: "effectdoc00000001",
    injuryKey: "deep-scar",
    injuryRoll: 74,
    tableVersion: 2,
    recoveryFormula: "0",
    recoveryDays: 0,
    detailTotal: null,
    recoveryStartTs: 2000,
    recoveryDueTs: null,
    requestedBy: player.id,
    resolvedBy: gm.id,
    resolvedAt: 3000,
  };
  const firstLease = await claimCriticalInjuryApplication(approval.pendingId, {
    id: "lease-1",
    claimedBy: gm.id,
    leaseDurationMs: 5000,
  });
  assert.equal(firstLease.applicationLease.id, "lease-1");
  assert.equal(firstLease.state, "approved");
  const blockedBeforeRoll = await claimCriticalInjuryApplication(
    approval.pendingId,
    {
      id: "lease-before-roll-competitor",
      claimedBy: gm.id,
      leaseDurationMs: 5000,
    },
  );
  assert.equal(
    blockedBeforeRoll.applicationLease.id,
    "lease-1",
    "only one GM session can own the approval before any dice are rolled",
  );
  await assert.rejects(
    persistCriticalInjuryResolution(approval.pendingId, resolution, {
      applicationLeaseId: "lease-before-roll-competitor",
    }),
    /leaselost/i,
  );
  assert.equal(
    getCriticalInjuryWorkflowRecord(approval.pendingId).state,
    "approved",
  );
  const resolving = await persistCriticalInjuryResolution(
    approval.pendingId,
    resolution,
    { applicationLeaseId: "lease-1" },
  );
  assert.equal(resolving.state, "resolving");
  assert.deepEqual(resolving.resolution, resolution);
  assert.equal(
    resolving.applicationLease.id,
    "lease-1",
    "the pre-roll lease remains active while the result is applied",
  );
  const blockedLease = await claimCriticalInjuryApplication(
    approval.pendingId,
    {
      id: "lease-2",
      claimedBy: gm.id,
      leaseDurationMs: 5000,
    },
  );
  assert.equal(
    blockedLease.applicationLease.id,
    "lease-1",
    "a live application lease blocks a competing GM session",
  );

  users.activeGM = secondGm;
  globalThis.game.user = secondGm;
  const replacementLease = await claimCriticalInjuryApplication(
    approval.pendingId,
    {
      id: "lease-2",
      claimedBy: secondGm.id,
      leaseDurationMs: 5000,
    },
  );
  assert.deepEqual(
    {
      id: replacementLease.applicationLease.id,
      claimedBy: replacementLease.applicationLease.claimedBy,
    },
    { id: "lease-2", claimedBy: secondGm.id },
    "a new authoritative GM can immediately replace the previous GM's lease",
  );
  globalThis.game.time.serverTime = 6000;
  const renewedLease = await renewCriticalInjuryApplication(
    approval.pendingId,
    "lease-2",
    { leaseDurationMs: 5000 },
  );
  assert.equal(renewedLease.applicationLease.expiresAt, 11000);

  globalThis.game.time.serverTime = 11000;
  await assert.rejects(
    renewCriticalInjuryApplication(approval.pendingId, "lease-2", {
      leaseDurationMs: 5000,
    }),
    /leaselost/i,
    "an expired lease cannot be renewed",
  );
  const finalLease = await claimCriticalInjuryApplication(approval.pendingId, {
    id: "lease-3",
    claimedBy: secondGm.id,
    leaseDurationMs: 5000,
  });
  assert.equal(finalLease.applicationLease.id, "lease-3");

  const duplicateResolution = await persistCriticalInjuryResolution(
    approval.pendingId,
    {
      ...resolution,
      injuryId: "injury-forged",
      injuryRoll: 1,
      resolvedBy: secondGm.id,
    },
  );
  assert.deepEqual(
    duplicateResolution.resolution,
    resolution,
    "the first authoritative resolution is immutable across retries",
  );

  const result = {
    id: resolution.injuryId,
    injuryKey: resolution.injuryKey,
    injuryName: "Deep Scar",
    injuryRoll: resolution.injuryRoll,
    permanent: true,
    calendarScheduled: false,
  };
  await assert.rejects(
    completeCriticalInjuryWorkflow(approval.pendingId, {
      result,
      effectId: "effect-stale",
      applicationLeaseId: "lease-2",
    }),
    /leaselost/i,
    "a stale lease cannot complete the workflow",
  );
  assert.equal(
    getCriticalInjuryWorkflowRecord(approval.pendingId).state,
    "resolving",
  );
  const completion = await completeCriticalInjuryWorkflow(approval.pendingId, {
    result,
    effectId: "effect-1",
    applicationLeaseId: "lease-3",
  });
  assert.equal(completion.completedNow, true);
  const completed = completion.record;
  assert.equal(completed.state, "completed");
  assert.equal(completed.completedBy, secondGm.id);
  assert.equal(completed.completedAt, 11000);
  assert.equal(completed.applicationLease, null);
  assert.deepEqual(completed.result, result);

  const replayCompletion = await completeCriticalInjuryWorkflow(
    approval.pendingId,
    {
      result: { ...result, injuryName: "Changed on retry" },
      effectId: "effect-2",
      completedAt: 5000,
    },
  );
  assert.equal(replayCompletion.completedNow, false);
  const replayReceipt = replayCompletion.record;

  users.activeGM = gm;
  globalThis.game.user = gm;
  assert.deepEqual(
    replayReceipt,
    completed,
    "a completed receipt is replayed without changing its result",
  );

  await createCriticalInjuryApproval({
    pendingId: "pending-discard",
    actorId: "actor-1",
    targetUserId: player.id,
  });
  const retargeted = await retargetCriticalInjuryWorkflow(
    "pending-discard",
    gm.id,
  );
  assert.equal(retargeted.targetUserId, gm.id);
  await discardCriticalInjuryApproval("pending-discard");
  assert.equal(getCriticalInjuryWorkflowRecord("pending-discard"), null);

  globalThis.game.user = secondGm;
  await assert.rejects(
    createCriticalInjuryApproval({
      pendingId: "pending-secondary-gm",
      actorId: "actor-1",
      targetUserId: player.id,
    }),
    /requiresauthority/i,
  );
  globalThis.game.user = gm;

  assert.equal(loadCriticalInjuryWorkflowStore().records.length, 1);
  const storedPrimary = settings.get("criticalInjuryWorkflow");
  const storedCheckpoint = settings.get("criticalInjuryWorkflowCheckpoint");
  assert.deepEqual(
    storedPrimary,
    storedCheckpoint,
    "every accepted workflow write is mirrored to the restricted checkpoint",
  );
  assert.equal(storedPrimary.version, 2);
  assert.ok(storedPrimary.revision > 0);
  assert.equal(storedPrimary.authorityId, gm.id);
  assert.ok(storedPrimary.writeToken);

  const canonicalPrimary = structuredClone(storedPrimary);
  const canonicalCheckpoint = structuredClone(storedCheckpoint);
  const assertVersionBlockedWithoutWrites = async ({
    primary = canonicalPrimary,
    checkpoint = canonicalCheckpoint,
    code,
    domain,
    supportedVersion = 2,
    statusCode,
    observedVersion,
    label,
  }) => {
    settings.set("criticalInjuryWorkflow", structuredClone(primary));
    settings.set(
      "criticalInjuryWorkflowCheckpoint",
      structuredClone(checkpoint),
    );
    resetCriticalInjuryWorkflowStoreForTests();
    const before = structuredClone(Object.fromEntries(settings));
    const writesBefore = settingWrites;
    await assert.rejects(
      ensureCriticalInjuryWorkflowAuthority(),
      (error) => {
        assert.equal(error.name, "PersistedDomainVersionError");
        assert.equal(error.code, code);
        assert.deepEqual(error.persistedVersionStatus, {
          state: "blocked",
          code: statusCode,
          retryable: false,
          domain,
          supportedVersion,
          observedVersion,
        });
        return true;
      },
      label,
    );
    assert.equal(
      settingWrites,
      writesBefore,
      `${label}: no replica is written`,
    );
    assert.deepEqual(
      Object.fromEntries(settings),
      before,
      `${label}: the blocked replica and its current peer remain exact`,
    );
  };

  await assertVersionBlockedWithoutWrites({
    primary: { ...canonicalPrimary, version: 3 },
    code: "CRITICAL_INJURY_WORKFLOW_PRIMARY_FUTURE_VERSION",
    domain: "critical-injury-workflow-primary",
    statusCode: "future-version",
    observedVersion: 3,
    label:
      "a future injury primary blocks before repairing its current checkpoint",
  });
  await assertVersionBlockedWithoutWrites({
    checkpoint: { ...canonicalCheckpoint, version: 3 },
    code: "CRITICAL_INJURY_WORKFLOW_CHECKPOINT_FUTURE_VERSION",
    domain: "critical-injury-workflow-checkpoint",
    statusCode: "future-version",
    observedVersion: 3,
    label:
      "a future injury checkpoint blocks before repairing its current primary",
  });
  for (const [label, version] of [
    ["Boolean", true],
    ["array", []],
    ["blank string", ""],
    ["whitespace string", " "],
    ["null", null],
  ]) {
    await assertVersionBlockedWithoutWrites({
      primary: { ...canonicalPrimary, version },
      code: "CRITICAL_INJURY_WORKFLOW_PRIMARY_INVALID_VERSION",
      domain: "critical-injury-workflow-primary",
      statusCode: "invalid-version",
      observedVersion: null,
      label: `an explicit ${label} injury version fails closed`,
    });
  }

  const futureRecordPrimary = structuredClone(canonicalPrimary);
  futureRecordPrimary.records[0].schema = 2;
  await assertVersionBlockedWithoutWrites({
    primary: futureRecordPrimary,
    code: "CRITICAL_INJURY_WORKFLOW_PRIMARY_RECORD_SCHEMA_FUTURE_VERSION",
    domain: "critical-injury-workflow-primary-record",
    supportedVersion: 1,
    statusCode: "future-version",
    observedVersion: 2,
    label:
      "a future injury record schema blocks before repairing its current checkpoint",
  });

  const futureTreatmentCheckpoint = structuredClone(canonicalCheckpoint);
  futureTreatmentCheckpoint.records[0].treatments = [{ schema: 2 }];
  await assertVersionBlockedWithoutWrites({
    checkpoint: futureTreatmentCheckpoint,
    code: "CRITICAL_INJURY_WORKFLOW_CHECKPOINT_RECORD_TREATMENT_SCHEMA_FUTURE_VERSION",
    domain: "critical-injury-workflow-checkpoint-record-treatment",
    supportedVersion: 1,
    statusCode: "future-version",
    observedVersion: 2,
    label:
      "a future treatment schema blocks before repairing its current primary",
  });

  const futureTreatmentResolutionCheckpoint =
    structuredClone(canonicalCheckpoint);
  futureTreatmentResolutionCheckpoint.records[0].treatments = [
    { schema: 1, resolution: { schema: 2 } },
  ];
  await assertVersionBlockedWithoutWrites({
    checkpoint: futureTreatmentResolutionCheckpoint,
    code: "CRITICAL_INJURY_WORKFLOW_CHECKPOINT_RECORD_TREATMENT_RESOLUTION_SCHEMA_FUTURE_VERSION",
    domain: "critical-injury-workflow-checkpoint-record-treatment-resolution",
    supportedVersion: 1,
    statusCode: "future-version",
    observedVersion: 2,
    label:
      "a future treatment-resolution schema blocks before repairing its current primary",
  });

  const malformedRestPrimary = structuredClone(canonicalPrimary);
  malformedRestPrimary.restEvents = [{ schema: true }];
  await assertVersionBlockedWithoutWrites({
    primary: malformedRestPrimary,
    code: "CRITICAL_INJURY_WORKFLOW_PRIMARY_REST_EVENT_SCHEMA_INVALID_VERSION",
    domain: "critical-injury-workflow-primary-rest-event",
    supportedVersion: 1,
    statusCode: "invalid-version",
    observedVersion: null,
    label:
      "a malformed rest-event schema blocks without changing its current checkpoint",
  });

  const futureRestResolutionPrimary = structuredClone(canonicalPrimary);
  futureRestResolutionPrimary.restEvents = [
    { schema: 1, resolution: { schema: 2 } },
  ];
  await assertVersionBlockedWithoutWrites({
    primary: futureRestResolutionPrimary,
    code: "CRITICAL_INJURY_WORKFLOW_PRIMARY_REST_EVENT_RESOLUTION_SCHEMA_FUTURE_VERSION",
    domain: "critical-injury-workflow-primary-rest-event-resolution",
    supportedVersion: 1,
    statusCode: "future-version",
    observedVersion: 2,
    label:
      "a future rest-resolution schema blocks without changing its current checkpoint",
  });
  settings.set("criticalInjuryWorkflow", structuredClone(canonicalPrimary));
  settings.set(
    "criticalInjuryWorkflowCheckpoint",
    structuredClone(canonicalCheckpoint),
  );
  resetCriticalInjuryWorkflowStoreForTests();

  // Foundry's pre-ready phase must not expose the legacy workflow settings.
  let preReadyLegacyReads = 0;
  const legacySettingsGet = globalThis.game.settings.get;
  globalThis.game.settings.get = (...args) => {
    preReadyLegacyReads += 1;
    return legacySettingsGet(...args);
  };
  globalThis.JournalEntry = { create() {} };
  globalThis.game.ready = false;
  assert.throws(
    () => loadCriticalInjuryWorkflowStore(),
    /CriticalInjuryWorkflowStoreUnavailable/,
    "pre-ready injury reads fail closed at the private-store boundary",
  );
  assert.equal(preReadyLegacyReads, 0);
} finally {
  if (savedGame === undefined) delete globalThis.game;
  else globalThis.game = savedGame;
  if (savedConst === undefined) delete globalThis.CONST;
  else globalThis.CONST = savedConst;
  if (savedFoundry === undefined) delete globalThis.foundry;
  else globalThis.foundry = savedFoundry;
  if (savedJournalEntry === undefined) delete globalThis.JournalEntry;
  else globalThis.JournalEntry = savedJournalEntry;
}

process.stdout.write("critical injury private workflow store passed\n");
