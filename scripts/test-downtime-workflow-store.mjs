import assert from "node:assert/strict";

const saved = Object.fromEntries(
  ["game", "foundry", "CONST", "JournalEntry", "Hooks"].map((key) => [
    key,
    globalThis[key],
  ]),
);

const settings = new Map();
const gm = { id: "gm-1", isGM: true, role: 4, active: true };
const users = {
  activeGM: gm,
  get(id) {
    return id === gm.id ? gm : null;
  },
  forEach(callback) {
    callback(gm);
  },
};
let randomId = 0;
let primaryFailuresRemaining = 0;
let checkpointFailuresRemaining = 0;
let settingWrites = 0;

try {
  globalThis.CONST = { USER_ROLES: { GAMEMASTER: 4 } };
  globalThis.foundry = {
    utils: {
      deepClone: (value) => structuredClone(value),
      randomID: () => `downtime-token-${++randomId}`,
    },
  };
  delete globalThis.JournalEntry;
  globalThis.game = {
    ready: false,
    user: gm,
    users,
    time: { serverTime: 1_000 },
    settings: {
      get(moduleId, key) {
        assert.equal(moduleId, "infinity-dnd5e");
        return settings.get(key);
      },
      async set(moduleId, key, value) {
        assert.equal(moduleId, "infinity-dnd5e");
        if (
          key === "downtimeWorkflowCheckpoint" &&
          checkpointFailuresRemaining > 0
        ) {
          checkpointFailuresRemaining -= 1;
          throw new Error("simulated checkpoint failure");
        }
        if (key === "downtimeWorkflow" && primaryFailuresRemaining > 0) {
          primaryFailuresRemaining -= 1;
          throw new Error("simulated primary replica failure");
        }
        settings.set(key, structuredClone(value));
        settingWrites += 1;
        return value;
      },
    },
  };

  const workflow = await import("./downtime/store.js");
  const { DOWNTIME_CONFIG_VERSION } = await import("./downtime/settlements.js");
  workflow.resetDowntimeWorkflowStoreForTests();

  assert.deepEqual(workflow.normalizeDowntimeWorkflowStore(null), {
    version: 1,
    revision: 0,
    authorityId: null,
    authorityEpoch: null,
    writeToken: null,
    configCheckpoint: null,
    activeBlock: null,
    history: [],
  });

  settings.set("downtimeConfig", {
    version: 2,
    settlements: [],
    heat: {},
    stolenGoods: {},
    sharpeningLifecycle: { pending: [], completed: [] },
    history: [],
    unexpected: true,
  });
  assert.throws(
    () => workflow.loadDowntimeConfig(),
    /DowntimeConfigMalformed/,
    "a standalone malformed config is not normalized during bootstrap",
  );
  await assert.rejects(
    workflow.ensureDowntimeWorkflowAuthority(),
    /DowntimeConfigMalformed/,
  );
  settings.delete("downtimeConfig");
  workflow.resetDowntimeWorkflowStoreForTests();
  assert.equal(
    workflow.loadDowntimeConfig().version,
    DOWNTIME_CONFIG_VERSION,
    "a fully empty store still exposes the canonical bootstrap config",
  );

  const config = await workflow.saveDowntimeConfig({
    settlements: [
      {
        id: "greyhaven",
        name: "Greyhaven",
        wealthTier: "prosperous",
        securityTier: "high",
        marketDc: 16,
      },
    ],
    heat: { greyhaven: { "actor-1": 3 } },
  });
  assert.equal(config.settlements[0].name, "Greyhaven");
  assert.equal(workflow.loadDowntimeConfig().heat.greyhaven["actor-1"], 3);

  checkpointFailuresRemaining = 1;
  await assert.rejects(
    workflow.saveDowntimeConfig({
      ...config,
      heat: { greyhaven: { "actor-1": 4 } },
    }),
    /simulated checkpoint failure/,
  );
  assert.equal(
    settings.get("downtimeConfig").heat.greyhaven["actor-1"],
    4,
    "an interrupted config transaction may have reached its primary",
  );
  assert.equal(
    workflow.loadDowntimeConfig().heat.greyhaven["actor-1"],
    3,
    "an uncheckpointed config primary is never exposed as canonical",
  );
  await workflow.ensureDowntimeWorkflowAuthority();
  assert.equal(
    settings.get("downtimeConfig").heat.greyhaven["actor-1"],
    3,
    "recovery restores the last checkpointed config value",
  );

  const issuedRecord = {
    itemId: "issued-item-1",
    actorId: "actor-1",
    operationId: "theft-operation-1",
    provenance: {
      settlementId: "greyhaven",
      targetType: "generated-mark",
      sourceId: "mark-1",
      merchantId: null,
      operationId: "theft-operation-1",
      timestamp: 1_000,
      appraisedValueCp: 250,
    },
    state: "issued",
    issuedAt: 1_000,
    consumedByOperationId: null,
    consumedAt: 0,
  };
  await Promise.all([
    workflow.updateDowntimeConfig((current) => ({
      ...current,
      heat: {
        ...current.heat,
        greyhaven: { ...current.heat.greyhaven, "actor-2": 2 },
      },
    })),
    workflow.updateDowntimeConfig((current) => ({
      ...current,
      stolenGoods: {
        ...current.stolenGoods,
        [issuedRecord.itemId]: issuedRecord,
      },
    })),
  ]);
  assert.equal(
    workflow.loadDowntimeConfig().heat.greyhaven["actor-2"],
    2,
    "queued config mutations preserve an earlier independent write",
  );
  assert.equal(
    workflow.loadDowntimeConfig().stolenGoods[issuedRecord.itemId].actorId,
    "actor-1",
    "queued config mutations retain the private issuance ledger",
  );

  let block = await workflow.createDowntimeBlock({
    id: "block-1",
    settlementId: "greyhaven",
    budgetHours: 8,
    eligibleActorIds: ["actor-1"],
    submissions: { "actor-1": [] },
  });
  assert.equal(block.state, "collecting");
  assert.equal(block.plan, null);
  assert.equal(workflow.getActiveDowntimeBlock().id, "block-1");

  const activeBeforeConfigMigration = structuredClone(
    workflow.getActiveDowntimeBlock(),
  );
  const historicalV2Config = {
    version: 2,
    settlements: [
      {
        id: "greyhaven",
        name: "Greyhaven",
        wealthTier: "prosperous",
        securityTier: "high",
        marketDc: 16,
        linkedFactionId: "",
        linkedMerchantIds: [],
        enabledActivityIds: [
          "craft-ammunition",
          "sharpen-weapon",
          "market-trading",
          "pickpocket",
          "shoplift",
          "fence-stolen-goods",
          "lay-low",
        ],
      },
    ],
    heat: { greyhaven: { "actor-1": 3, "actor-2": 2 } },
    stolenGoods: {
      [issuedRecord.itemId]: structuredClone(issuedRecord),
    },
    sharpeningLifecycle: { pending: [], completed: [] },
    history: [],
  };
  for (const { marker, interruptedReplica } of [
    { marker: null, interruptedReplica: "checkpoint" },
    { marker: false, interruptedReplica: null },
    { marker: true, interruptedReplica: "primary" },
  ]) {
    const currentPrimary = structuredClone(settings.get("downtimeWorkflow"));
    const currentCheckpoint = structuredClone(
      settings.get("downtimeWorkflowCheckpoint"),
    );
    const legacyConfig = structuredClone(historicalV2Config);
    if (marker !== null) {
      legacyConfig.settlements[0].hasSettlement = marker;
    }
    const legacyConfigCheckpoint = {
      ...currentCheckpoint.config,
      value: legacyConfig,
    };
    const legacyPrimary = {
      ...currentPrimary,
      configCheckpoint: legacyConfigCheckpoint,
    };
    const legacyCheckpoint = {
      ...currentCheckpoint,
      workflow: {
        ...currentCheckpoint.workflow,
        configCheckpoint: legacyConfigCheckpoint,
      },
      config: legacyConfigCheckpoint,
    };
    settings.set("downtimeConfig", structuredClone(legacyConfig));
    settings.set("downtimeWorkflow", structuredClone(legacyPrimary));
    settings.set(
      "downtimeWorkflowCheckpoint",
      structuredClone(legacyCheckpoint),
    );
    workflow.resetDowntimeWorkflowStoreForTests();

    assert.equal(
      workflow.isDowntimeWorkflowReady(),
      false,
      "a supported legacy config stays read-only until its replicas are migrated",
    );
    const compatibleConfig = workflow.loadDowntimeConfig();
    assert.equal(compatibleConfig.version, DOWNTIME_CONFIG_VERSION);
    assert.equal(
      compatibleConfig.settlements[0].hasSettlement,
      marker ?? true,
      "migration preserves an explicit marker and defaults the pre-change shape to true",
    );
    assert.deepEqual(
      workflow.getActiveDowntimeBlock(),
      activeBeforeConfigMigration,
      "reading a legacy config does not alter the active block",
    );

    const legacyConfigRevision = legacyConfigCheckpoint.revision;
    if (interruptedReplica === "checkpoint") {
      checkpointFailuresRemaining = 1;
      await assert.rejects(
        workflow.ensureDowntimeWorkflowAuthority(),
        /simulated checkpoint failure/,
        "an interrupted legacy migration never reports success",
      );
      assert.equal(
        settings.get("downtimeConfig").version,
        DOWNTIME_CONFIG_VERSION,
        "an interrupted migration may have upgraded only the direct config",
      );
    } else if (interruptedReplica === "primary") {
      primaryFailuresRemaining = 1;
      await assert.rejects(
        workflow.ensureDowntimeWorkflowAuthority(),
        /simulated primary replica failure/,
        "a checkpointed migration still reports an interrupted primary write",
      );
      assert.notDeepEqual(
        settings.get("downtimeWorkflow"),
        settings.get("downtimeWorkflowCheckpoint").workflow,
        "the advanced checkpoint remains available to repair the legacy primary",
      );
    }
    await workflow.ensureDowntimeWorkflowAuthority();
    const migratedConfig = settings.get("downtimeConfig");
    const migratedPrimary = settings.get("downtimeWorkflow");
    const migratedCheckpoint = settings.get("downtimeWorkflowCheckpoint");
    assert.equal(migratedConfig.version, DOWNTIME_CONFIG_VERSION);
    assert.equal(migratedConfig.settlements[0].hasSettlement, marker ?? true);
    assert.equal(
      migratedCheckpoint.config.revision,
      legacyConfigRevision + 1,
      "the schema migration receives a new guarded config revision",
    );
    assert.deepEqual(migratedPrimary, migratedCheckpoint.workflow);
    assert.deepEqual(
      migratedPrimary.configCheckpoint,
      migratedCheckpoint.config,
    );
    assert.deepEqual(migratedConfig, migratedCheckpoint.config.value);
    assert.deepEqual(
      migratedPrimary.activeBlock,
      activeBeforeConfigMigration,
      "the schema migration preserves the active workflow exactly",
    );
    assert.equal(workflow.isDowntimeWorkflowReady(), true);

    const writesBeforeIdempotentEnsure = settingWrites;
    await workflow.ensureDowntimeWorkflowAuthority();
    assert.equal(
      settingWrites,
      writesBeforeIdempotentEnsure,
      "an already-current v3 checkpoint does not write again",
    );
  }

  const canonicalPrimary = structuredClone(settings.get("downtimeWorkflow"));
  const canonicalCheckpoint = structuredClone(
    settings.get("downtimeWorkflowCheckpoint"),
  );
  const seedCompositeConfig = (value) => {
    const configCheckpoint = {
      ...canonicalCheckpoint.config,
      value: structuredClone(value),
    };
    settings.set("downtimeConfig", structuredClone(value));
    settings.set("downtimeWorkflow", {
      ...canonicalPrimary,
      configCheckpoint,
    });
    settings.set("downtimeWorkflowCheckpoint", {
      ...canonicalCheckpoint,
      workflow: {
        ...canonicalCheckpoint.workflow,
        configCheckpoint,
      },
      config: configCheckpoint,
    });
    workflow.resetDowntimeWorkflowStoreForTests();
  };
  const malformedConfig = {
    ...structuredClone(settings.get("downtimeConfig")),
    unexpected: true,
  };
  seedCompositeConfig(malformedConfig);
  assert.throws(
    () => workflow.loadDowntimeConfig(),
    /DowntimeWorkflowCheckpointMalformed/,
    "unknown legacy fields remain fail-closed instead of being normalized away",
  );

  const nonBooleanLegacyConfig = structuredClone(historicalV2Config);
  nonBooleanLegacyConfig.settlements[0].hasSettlement = "true";
  seedCompositeConfig(nonBooleanLegacyConfig);
  assert.throws(
    () => workflow.loadDowntimeConfig(),
    /DowntimeWorkflowCheckpointMalformed/,
    "legacy settlement markers must be stored as Booleans",
  );

  const mixedLegacyConfig = structuredClone(historicalV2Config);
  mixedLegacyConfig.settlements[0].hasSettlement = true;
  mixedLegacyConfig.settlements.push({
    ...structuredClone(historicalV2Config.settlements[0]),
    id: "saltmarsh",
    name: "Saltmarsh",
  });
  seedCompositeConfig(mixedLegacyConfig);
  assert.throws(
    () => workflow.loadDowntimeConfig(),
    /DowntimeWorkflowCheckpointMalformed/,
    "a mixed pre-change and post-change v2 settlement collection is noncanonical",
  );

  settings.set(
    "downtimeConfig",
    structuredClone(canonicalCheckpoint.config.value),
  );
  settings.set("downtimeWorkflow", structuredClone(canonicalPrimary));
  settings.set(
    "downtimeWorkflowCheckpoint",
    structuredClone(canonicalCheckpoint),
  );
  workflow.resetDowntimeWorkflowStoreForTests();
  await workflow.ensureDowntimeWorkflowAuthority();

  const collectingRevision = workflow.getDowntimeWorkflowRevision();
  block = await workflow.updateCollectingDowntimeBlock(
    "block-1",
    {
      submissions: {
        "actor-1": [{ id: "action-1", activityId: "lay-low", hours: 4 }],
      },
    },
    { expectedRevision: collectingRevision },
  );
  assert.equal(block.submissions["actor-1"].length, 1);
  await assert.rejects(
    workflow.updateCollectingDowntimeBlock(
      "block-1",
      { budgetHours: 12 },
      { expectedRevision: collectingRevision },
    ),
    /RevisionMismatch/,
    "a stale player submission cannot overwrite a newer queue",
  );

  block = await workflow.lockDowntimeBlock("block-1", { at: 1_100 });
  assert.equal(block.state, "locked");
  await assert.rejects(
    workflow.updateCollectingDowntimeBlock("block-1", { budgetHours: 4 }),
    /SubmissionsClosed/,
  );

  const planningManifest = {
    version: 1,
    blockId: "block-1",
    settlementId: "greyhaven",
    budgetHours: 8,
    participants: [
      {
        actorId: "actor-1",
        queue: [
          {
            id: "hidden-trade",
            activityId: "market-trading",
            hours: 2,
            skill: "persuasion",
            stakeCp: 100,
          },
        ],
      },
    ],
    checkedRows: [
      {
        rowId: "planning-roll-1",
        actorId: "actor-1",
        actionId: "hidden-trade",
        activityId: "market-trading",
        order: 0,
      },
    ],
  };
  let planningDraft = await workflow.initializeDowntimePlanningDraft(
    "block-1",
    planningManifest,
    { at: 1_110 },
  );
  assert.equal(planningDraft.state, "active");
  assert.equal(planningDraft.rows["planning-roll-1"].state, "pending");
  await assert.rejects(
    workflow.initializeDowntimePlanningDraft("block-1", {
      ...planningManifest,
      budgetHours: 4,
    }),
    /PlanningManifestMismatch/,
    "a locked draft is bound to the exact queue manifest",
  );
  const planningClaim = await workflow.claimDowntimePlanningRoll(
    "block-1",
    "planning-roll-1",
    { at: 1_120 },
  );
  assert.equal(planningClaim.claimedNow, true);
  await assert.rejects(
    workflow.claimDowntimePlanningRoll("block-1", "planning-roll-1"),
    /PlanningRollOrphaned/,
    "an in-flight hidden check can never be invoked a second time",
  );
  const completedPlanningRoll = await workflow.resolveDowntimePlanningRoll(
    "block-1",
    "planning-roll-1",
    {
      total: 17,
      dieResult: 12,
      skillModifier: 5,
      formula: "1d20 + 5",
    },
    { at: 1_130 },
  );
  assert.equal(completedPlanningRoll.state, "completed");
  planningDraft = workflow.getActiveDowntimeBlock().planningDraft;
  assert.equal(planningDraft.state, "complete");
  assert.deepEqual(
    (
      await workflow.initializeDowntimePlanningDraft(
        "block-1",
        planningManifest,
      )
    ).rows["planning-roll-1"].roll,
    completedPlanningRoll.roll,
    "a retry reuses the exact completed hidden roll",
  );
  const normalizedNullMetadataBlock = workflow.normalizeDowntimeBlock({
    id: "null-roll-metadata",
    state: "locked",
    plan: null,
    operationLedger: {},
    planningDraft: {
      version: 1,
      state: "complete",
      manifest: { checkedRows: [] },
      rows: {
        "null-metadata-row": {
          rowId: "null-metadata-row",
          actorId: "actor-1",
          actionId: "check-1",
          activityId: "market-trading",
          order: 0,
          state: "completed",
          claimedBy: "gm-1",
          authorityEpoch: "epoch-1",
          startedAt: 1,
          completedAt: 2,
          roll: {
            total: 14,
            dieResult: null,
            skillModifier: null,
            formula: "",
          },
        },
      },
    },
  });
  assert.equal(
    normalizedNullMetadataBlock.planningDraft.rows["null-metadata-row"].roll
      .dieResult,
    null,
    "unavailable cross-version die metadata is not rewritten as a real zero",
  );
  assert.equal(
    normalizedNullMetadataBlock.planningDraft.rows["null-metadata-row"].roll
      .skillModifier,
    null,
    "unavailable cross-version modifier metadata is not rewritten as a real zero",
  );
  const missingTotalBlock = workflow.normalizeDowntimeBlock({
    ...normalizedNullMetadataBlock,
    planningDraft: {
      ...normalizedNullMetadataBlock.planningDraft,
      rows: {
        ...normalizedNullMetadataBlock.planningDraft.rows,
        "null-metadata-row": {
          ...normalizedNullMetadataBlock.planningDraft.rows[
            "null-metadata-row"
          ],
          roll: {
            ...normalizedNullMetadataBlock.planningDraft.rows[
              "null-metadata-row"
            ].roll,
            total: null,
          },
        },
      },
    },
  });
  assert.equal(
    "planningDraft" in missingTotalBlock,
    false,
    "a completed hidden roll without the required total is rejected",
  );

  const plan = {
    generatedAt: 1_200,
    rolls: [{ actionId: "action-1", dieResult: 12, total: 17 }],
    projectedState: { heat: { greyhaven: { "actor-1": 2 } } },
    operations: [
      {
        operationId: "operation-1",
        actorId: "actor-1",
        activityId: "lay-low",
        order: 0,
      },
      {
        operationId: "operation-2",
        actorId: "actor-1",
        activityId: "craft-ammunition",
        order: 1,
      },
      {
        operationId: "operation-3",
        actorId: "actor-2",
        activityId: "market-trading",
        order: 2,
        summary: "Recovered trade earned 2 gp.",
      },
    ],
  };
  block = await workflow.persistDowntimePlan("block-1", plan, { at: 1_200 });
  assert.equal(block.state, "planned");
  assert.deepEqual(block.plan, plan);
  assert.deepEqual(Object.keys(block.operationLedger), [
    "operation-1",
    "operation-2",
    "operation-3",
  ]);
  await assert.rejects(
    workflow.claimDowntimePlanningRoll("block-1", "planning-roll-1"),
    /PlanningDraftClosed/,
    "planning-roll state cannot mutate after immutable plan persistence",
  );

  const replayedPlan = await workflow.persistDowntimePlan("block-1", plan);
  assert.deepEqual(replayedPlan.plan, plan);
  await assert.rejects(
    workflow.persistDowntimePlan("block-1", {
      ...plan,
      generatedAt: 9_999,
    }),
    /PlanImmutable/,
    "a planned workflow cannot reroll or replace its write plan",
  );

  const checkpointAfterPlan = structuredClone(
    settings.get("downtimeWorkflowCheckpoint"),
  );
  settings.set("downtimeWorkflow", {
    ...checkpointAfterPlan.workflow,
    revision: checkpointAfterPlan.workflow.revision - 1,
    writeToken: "stale-primary",
  });
  await workflow.ensureDowntimeWorkflowAuthority();
  assert.deepEqual(
    settings.get("downtimeWorkflow"),
    checkpointAfterPlan.workflow,
    "the newer durable checkpoint repairs a stale primary replica",
  );

  block = await workflow.beginDowntimeApplication("block-1", { at: 1_300 });
  assert.equal(block.state, "applying");
  await assert.rejects(
    workflow.resolveDowntimeOperation("block-1", "operation-2", {
      state: "applied",
      receipt: { forged: true },
    }),
    /ClaimRequired/,
    "an operation must be checkpointed as applying before it can be receipted",
  );
  let claim = await workflow.claimDowntimeOperation("block-1", "operation-1", {
    attemptId: "attempt-1",
    at: 1_310,
  });
  assert.equal(claim.claimedNow, true);
  assert.equal(
    claim.record.authorityEpoch,
    workflow.loadDowntimeWorkflowStore().authorityEpoch,
    "operation claims are fenced to the exact GM authority tenure",
  );
  claim = await workflow.claimDowntimeOperation("block-1", "operation-1", {
    attemptId: "attempt-1",
  });
  assert.equal(claim.claimedNow, false, "duplicate claims replay safely");
  await assert.rejects(
    workflow.claimDowntimeOperation("block-1", "operation-1", {
      attemptId: "competing-attempt",
    }),
    /AlreadyClaimed/,
  );

  const firstReceipt = { heatBefore: 3, heatAfter: 2 };
  let operation = await workflow.resolveDowntimeOperation(
    "block-1",
    "operation-1",
    {
      state: "applied",
      attemptId: "attempt-1",
      receipt: firstReceipt,
      at: 1_320,
    },
  );
  assert.equal(operation.state, "applied");
  operation = await workflow.resolveDowntimeOperation(
    "block-1",
    "operation-1",
    {
      state: "applied",
      attemptId: "attempt-1",
      receipt: firstReceipt,
      at: 9_999,
    },
  );
  assert.equal(operation.resolvedAt, 1_320, "the first receipt is immutable");
  operation = await workflow.compensateDowntimeOperation(
    "block-1",
    "operation-1",
    {
      receipt: { heatRestoredTo: 3 },
      reason: "dependent write failed",
      at: 1_325,
    },
  );
  assert.equal(operation.state, "compensated");
  assert.deepEqual(operation.receipt, firstReceipt);
  assert.deepEqual(operation.compensationReceipt, { heatRestoredTo: 3 });
  assert.deepEqual(
    await workflow.compensateDowntimeOperation("block-1", "operation-1", {
      receipt: { heatRestoredTo: 3 },
    }),
    operation,
    "a duplicate compensation returns its first durable receipt",
  );

  await workflow.claimDowntimeOperation("block-1", "operation-2", {
    attemptId: "attempt-2",
    at: 1_330,
  });
  block = workflow.getActiveDowntimeBlock();
  assert.equal(
    workflow.downtimeOperationDisposition(block, "operation-1"),
    "applied",
  );
  assert.equal(
    workflow.downtimeOperationDisposition(block, "operation-2"),
    "uncertain",
  );

  await workflow.resolveDowntimeOperation("block-1", "operation-2", {
    state: "needs-review",
    attemptId: "attempt-2",
    reason: "interrupted after actor write",
    at: 1_340,
  });
  assert.equal(
    workflow.getActiveDowntimeBlock().state,
    "applying",
    "one uncertain character operation does not block independent work",
  );
  await workflow.markDowntimeNeedsReview(
    "block-1",
    "one operation needs canonical read-back",
    { at: 1_345 },
  );
  assert.equal(workflow.getActiveDowntimeBlock().state, "needs-review");
  await assert.rejects(
    workflow.beginDowntimeApplication("block-1"),
    /RecoveryRequired/,
  );

  await workflow.resolveDowntimeOperation("block-1", "operation-2", {
    state: "verified-unapplied",
    receipt: { actorReadback: "unchanged" },
    at: 1_350,
  });
  assert.deepEqual(
    workflow
      .listRetryableDowntimeOperations(workflow.getActiveDowntimeBlock())
      .map((entry) => entry.operationId),
    ["operation-2", "operation-3"],
  );
  await workflow.beginDowntimeApplication("block-1", { at: 1_360 });
  await workflow.claimDowntimeOperation("block-1", "operation-2", {
    attemptId: "attempt-3",
    at: 1_370,
  });
  await workflow.resolveDowntimeOperation("block-1", "operation-2", {
    state: "applied",
    attemptId: "attempt-3",
    receipt: { quantityCreated: 20 },
    at: 1_380,
  });

  await workflow.claimDowntimeOperation("block-1", "operation-3", {
    attemptId: "attempt-4",
    at: 1_385,
  });
  await workflow.resolveDowntimeOperation("block-1", "operation-3", {
    state: "needs-review",
    attemptId: "attempt-4",
    reason: "merchant write acknowledgement was interrupted",
    at: 1_390,
  });
  await workflow.markDowntimeNeedsReview(
    "block-1",
    "canonical recovery must verify the completed trade",
    { at: 1_395 },
  );
  await assert.rejects(
    workflow.resolveDowntimeOperation("block-1", "operation-3", {
      state: "applied",
      receipt: { summary: "Recovered trade earned 2 gp." },
    }),
    /ClaimRequired/,
    "ordinary review records still require an operation claim",
  );
  await assert.rejects(
    workflow.resolveDowntimeOperation("block-1", "operation-3", {
      state: "applied",
      receipt: { summary: "Forged recovery summary", recovered: true },
    }),
    /RecoveryReceiptInvalid/,
    "a recovered receipt must match the immutable operation summary",
  );
  const recoveredReceipt = {
    summary: "Recovered trade earned 2 gp.",
    recovered: true,
  };
  await assert.rejects(
    workflow.resolveDowntimeOperation("block-1", "operation-3", {
      state: "applied",
      receipt: recoveredReceipt,
      at: 1_398,
    }),
    /RecoveryReceiptInvalid/,
    "ordinary resolution cannot forge the recovery-only transition",
  );
  operation = await workflow.resolveRecoveredDowntimeOperation(
    "block-1",
    "operation-3",
    {
      summary: "Recovered trade earned 2 gp.",
      at: 1_398,
    },
  );
  assert.equal(operation.state, "applied");
  assert.deepEqual(operation.receipt, recoveredReceipt);
  assert.deepEqual(
    await workflow.resolveRecoveredDowntimeOperation("block-1", "operation-3", {
      summary: "Recovered trade earned 2 gp.",
      at: 9_999,
    }),
    operation,
    "the explicit recovery API replays the first verified receipt",
  );
  await workflow.beginDowntimeApplication("block-1", { at: 1_399 });

  const completed = await workflow.completeDowntimeBlock("block-1", {
    result: { actorReceipts: 1 },
    at: 1_400,
  });
  assert.equal(completed.state, "completed");
  assert.equal(workflow.getActiveDowntimeBlock(), null);
  assert.deepEqual(completed.plan, plan, "history retains the immutable plan");
  assert.deepEqual(
    await workflow.completeDowntimeBlock("block-1", {
      result: { forged: true },
    }),
    completed,
    "duplicate completion returns the original durable receipt",
  );

  primaryFailuresRemaining = 1;
  await assert.rejects(
    workflow.createDowntimeBlock({
      id: "block-2",
      settlementId: "greyhaven",
      budgetHours: 4,
    }),
    /simulated primary replica failure/,
    "a checkpoint-only workflow mutation never reports success",
  );
  assert.notDeepEqual(
    settings.get("downtimeWorkflow"),
    settings.get("downtimeWorkflowCheckpoint").workflow,
    "an interrupted same-authority mirror retains its recovery checkpoint",
  );
  assert.equal(workflow.getActiveDowntimeBlock().id, "block-2");
  await workflow.ensureDowntimeWorkflowAuthority();
  assert.deepEqual(
    settings.get("downtimeWorkflow"),
    settings.get("downtimeWorkflowCheckpoint").workflow,
    "recovery repairs the interrupted primary replica without replaying the request",
  );
  const recoveredCreate = await workflow.createDowntimeBlock({
    id: "block-2",
    settlementId: "greyhaven",
    budgetHours: 4,
  });
  assert.equal(recoveredCreate.id, "block-2");
  const cancelled = await workflow.cancelDowntimeBlock("block-2", {
    reason: "campaign moved on",
    at: 1_500,
  });
  assert.equal(cancelled.state, "cancelled");
  assert.equal(cancelled.cancelReason, "campaign moved on");
  assert.equal(workflow.loadDowntimeWorkflowStore().history.length, 2);
  assert.deepEqual(
    settings.get("downtimeWorkflow"),
    settings.get("downtimeWorkflowCheckpoint").workflow,
    "every accepted workflow write is mirrored to the checkpoint",
  );

  const { configCheckpoint: _configCheckpoint, ...legacyWorkflowCheckpoint } =
    structuredClone(settings.get("downtimeWorkflowCheckpoint").workflow);
  const configBeforeCheckpointMigration = structuredClone(
    settings.get("downtimeConfig"),
  );
  settings.set("downtimeConfig", {
    ...structuredClone(historicalV2Config),
    unexpected: true,
  });
  settings.set("downtimeWorkflow", legacyWorkflowCheckpoint);
  settings.set("downtimeWorkflowCheckpoint", legacyWorkflowCheckpoint);
  workflow.resetDowntimeWorkflowStoreForTests();
  assert.throws(
    () => workflow.loadDowntimeConfig(),
    /DowntimeConfigMalformed/,
    "a raw legacy workflow checkpoint does not bypass config validation",
  );
  const writesBeforeMalformedLegacyEnsure = settingWrites;
  await assert.rejects(
    workflow.ensureDowntimeWorkflowAuthority(),
    /DowntimeConfigMalformed/,
  );
  assert.equal(
    settingWrites,
    writesBeforeMalformedLegacyEnsure,
    "malformed standalone config is rejected before any repair write",
  );

  settings.set("downtimeConfig", structuredClone(historicalV2Config));
  settings.set("downtimeWorkflow", legacyWorkflowCheckpoint);
  settings.set("downtimeWorkflowCheckpoint", legacyWorkflowCheckpoint);
  workflow.resetDowntimeWorkflowStoreForTests();
  await workflow.ensureDowntimeWorkflowAuthority();
  assert.deepEqual(
    settings.get("downtimeWorkflowCheckpoint").workflow.activeBlock,
    legacyWorkflowCheckpoint.activeBlock,
    "a legacy raw workflow checkpoint migrates without changing the active block",
  );
  assert.deepEqual(
    settings.get("downtimeWorkflowCheckpoint").config.value,
    configBeforeCheckpointMigration,
    "a raw legacy checkpoint migrates the exact historical v2 config losslessly",
  );
  for (let index = 0; index < 101; index += 1) {
    const historyBlock = await workflow.createDowntimeBlock({
      id: `history-trim-${index}`,
      settlementId: "greyhaven",
      budgetHours: 1,
      participants: [],
    });
    await workflow.cancelDowntimeBlock(historyBlock.id, {
      reason: "history retention fixture",
      at: 2_000 + index,
    });
  }
  assert.equal(
    workflow.loadDowntimeWorkflowStore().history.length,
    100,
    "workflow receipts remain bounded",
  );
  assert.equal(
    workflow.loadDowntimeConfig().stolenGoods[issuedRecord.itemId].operationId,
    issuedRecord.operationId,
    "active issuance proof survives beyond the bounded workflow history window",
  );
} finally {
  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) delete globalThis[key];
    else globalThis[key] = value;
  }
}

process.stdout.write("downtime private workflow store passed\n");
