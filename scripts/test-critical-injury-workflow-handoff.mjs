import assert from "node:assert/strict";

const saved = Object.fromEntries(
  ["game", "foundry", "CONST", "Hooks", "JournalEntry"].map((key) => [
    key,
    globalThis[key],
  ]),
);

const MODULE_ID = "infinity-dnd5e";
const PRIMARY_PATH = `flags.${MODULE_ID}.criticalInjuryWorkflow`;
const CHECKPOINT_PATH = `flags.${MODULE_ID}.criticalInjuryWorkflowCheckpoint`;
const savedConsoleWarn = console.warn;
const savedConsoleError = console.error;

try {
  let nextHookId = 0;
  const listeners = new Map();
  globalThis.Hooks = {
    on(event, handler) {
      const id = ++nextHookId;
      if (!listeners.has(event)) listeners.set(event, new Map());
      listeners.get(event).set(id, handler);
      return id;
    },
    off(event, id) {
      listeners.get(event)?.delete(id);
    },
    call(event, ...args) {
      for (const handler of listeners.get(event)?.values() ?? []) {
        handler(...args);
      }
    },
    callAll(event, ...args) {
      this.call(event, ...args);
    },
  };
  globalThis.CONST = {
    DOCUMENT_OWNERSHIP_LEVELS: { NONE: 0 },
    USER_ROLES: { GAMEMASTER: 4 },
  };
  let randomId = 0;
  globalThis.foundry = {
    utils: {
      deepClone: (value) => structuredClone(value),
      randomID: () => `token${String(++randomId).padStart(19, "0")}`,
    },
  };

  const flags = {
    privateStateStore: true,
    schemaVersion: 4,
    merchants: [],
    factions: [],
    resourceConfig: {},
    resourceRunState: {},
    criticalInjuryWorkflow: {},
    criticalInjuryWorkflowCheckpoint: {},
  };
  let blockedUpdate = null;
  let primaryFailuresRemaining = 0;
  let primaryUpdateAttempts = 0;
  const store = {
    id: "private-injury-store",
    ownership: { default: 0 },
    getFlag(scope, key) {
      return scope === MODULE_ID ? flags[key] : undefined;
    },
    async update(changes) {
      for (const [path, value] of Object.entries(changes)) {
        if (path === PRIMARY_PATH) {
          primaryUpdateAttempts += 1;
          if (primaryFailuresRemaining > 0) {
            primaryFailuresRemaining -= 1;
            throw new Error("simulated persistent primary failure");
          }
        }
        if (blockedUpdate?.path === path) {
          const blocked = blockedUpdate;
          blockedUpdate = null;
          blocked.startedResolve();
          await blocked.releasePromise;
        }
        const match = /^flags\.infinity-dnd5e\.(.+)$/.exec(path);
        if (match) flags[match[1]] = structuredClone(value);
      }
      globalThis.Hooks.call("updateJournalEntry", this, changes);
      return this;
    },
    blockNext(path) {
      let releaseResolve;
      let startedResolve;
      const releasePromise = new Promise(
        (resolve) => (releaseResolve = resolve),
      );
      const started = new Promise((resolve) => (startedResolve = resolve));
      blockedUpdate = {
        path,
        releasePromise,
        releaseResolve,
        startedResolve,
      };
      return { started, release: releaseResolve };
    },
  };

  const gmA = { id: "gm-a", isGM: true, role: 4, active: true };
  const gmB = { id: "gm-b", isGM: true, role: 4, active: true };
  const users = new Map([
    [gmA.id, gmA],
    [gmB.id, gmB],
  ]);
  const userCollection = {
    activeGM: gmA,
    get: (id) => users.get(id) ?? null,
    forEach: (callback) => users.forEach(callback),
  };
  globalThis.game = {
    ready: true,
    user: gmA,
    users: userCollection,
    journal: {
      find(predicate) {
        return predicate(store) ? store : null;
      },
      forEach(callback) {
        callback(store);
      },
    },
    settings: {
      get(_moduleId, key) {
        if (key === "privateStateStoreId") return store.id;
        if (key === "merchants" || key === "factions") return [];
        return {};
      },
      async set() {
        throw new Error("the existing private store should be reused");
      },
    },
  };
  globalThis.JournalEntry = {
    async create() {
      throw new Error("the existing private store should be reused");
    },
  };

  const privateState = await import("./private-state.js");
  const workflow = await import("./injury/workflow-store.js");
  privateState.resetPrivateStateForTests();
  workflow.resetCriticalInjuryWorkflowStoreForTests();
  assert.equal(await privateState.initializePrivateState(), true);
  const firstTabEpoch =
    workflow.observeCriticalInjuryWorkflowAuthorityTransition().authorityEpoch;
  workflow.resetCriticalInjuryWorkflowStoreForTests();
  const secondTabEpoch =
    workflow.observeCriticalInjuryWorkflowAuthorityTransition().authorityEpoch;
  assert.equal(
    secondTabEpoch,
    firstTabEpoch,
    "two tabs for the same active GM share one persisted authority epoch",
  );

  await workflow.createCriticalInjuryApproval({
    pendingId: "pending-base",
    actorId: "actor-1",
    targetUserId: "player-1",
    approvedAt: 1,
  });
  const acceptedBeforePrimaryRace = structuredClone(
    flags.criticalInjuryWorkflow,
  );
  assert.deepEqual(
    acceptedBeforePrimaryRace,
    flags.criticalInjuryWorkflowCheckpoint,
  );

  // The former GM has already committed the checkpoint, but its primary write
  // is still in flight when authority changes away and back.
  const blockedPrimary = store.blockNext(PRIMARY_PATH);
  const latePrimaryOperation = workflow.createCriticalInjuryApproval({
    pendingId: "pending-old-primary",
    actorId: "actor-1",
    targetUserId: "player-1",
    approvedAt: 2,
  });
  await blockedPrimary.started;
  const oldCheckpoint = structuredClone(flags.criticalInjuryWorkflowCheckpoint);
  userCollection.activeGM = gmB;
  workflow.observeCriticalInjuryWorkflowAuthorityTransition();
  userCollection.activeGM = gmA;
  const newPrimaryAuthority =
    workflow.observeCriticalInjuryWorkflowAuthorityTransition();
  const newerPrimaryEnvelope = addApproval(
    oldCheckpoint,
    "pending-new-primary",
    newPrimaryAuthority,
  );
  flags.criticalInjuryWorkflow = structuredClone(newerPrimaryEnvelope);
  flags.criticalInjuryWorkflowCheckpoint =
    structuredClone(newerPrimaryEnvelope);
  globalThis.Hooks.call("updateJournalEntry", store, {
    [PRIMARY_PATH]: newerPrimaryEnvelope,
    [CHECKPOINT_PATH]: newerPrimaryEnvelope,
  });
  blockedPrimary.release();
  await assert.rejects(
    latePrimaryOperation,
    /AuthorityChanged|PostconditionFailed/,
  );
  assert.ok(
    flags.criticalInjuryWorkflow.revision <
      flags.criticalInjuryWorkflowCheckpoint.revision,
    "the former authority can land only a stale primary replica",
  );
  await workflow.ensureCriticalInjuryWorkflowAuthority();
  assertReplicasMatch(flags, [
    "pending-base",
    "pending-old-primary",
    "pending-new-primary",
  ]);

  // Simulate a reload after another late primary regression. The independent
  // checkpoint remains sufficient even after the in-memory snapshot is gone.
  const durableCheckpoint = structuredClone(
    flags.criticalInjuryWorkflowCheckpoint,
  );
  flags.criticalInjuryWorkflow = structuredClone(acceptedBeforePrimaryRace);
  globalThis.Hooks.call("updateJournalEntry", store, {
    [PRIMARY_PATH]: flags.criticalInjuryWorkflow,
  });
  workflow.resetCriticalInjuryWorkflowStoreForTests();
  await workflow.ensureCriticalInjuryWorkflowAuthority();
  assert.equal(
    flags.criticalInjuryWorkflow.revision,
    durableCheckpoint.revision,
    "same-GM reload repairs the stale replica without churning a new revision",
  );
  assertReplicasMatch(flags, [
    "pending-base",
    "pending-old-primary",
    "pending-new-primary",
  ]);

  // If the old checkpoint itself lands late, the newer primary survives and
  // repairs it; the old operation never advances to its primary write.
  const blockedCheckpoint = store.blockNext(CHECKPOINT_PATH);
  const lateCheckpointOperation = workflow.createCriticalInjuryApproval({
    pendingId: "pending-old-checkpoint",
    actorId: "actor-1",
    targetUserId: "player-1",
    approvedAt: 3,
  });
  await blockedCheckpoint.started;
  const beforeCheckpointRace = structuredClone(flags.criticalInjuryWorkflow);
  userCollection.activeGM = gmB;
  workflow.observeCriticalInjuryWorkflowAuthorityTransition();
  userCollection.activeGM = gmA;
  const newCheckpointAuthority =
    workflow.observeCriticalInjuryWorkflowAuthorityTransition();
  const newerCheckpointEnvelope = addApproval(
    beforeCheckpointRace,
    "pending-new-checkpoint",
    newCheckpointAuthority,
  );
  flags.criticalInjuryWorkflow = structuredClone(newerCheckpointEnvelope);
  flags.criticalInjuryWorkflowCheckpoint = structuredClone(
    newerCheckpointEnvelope,
  );
  globalThis.Hooks.call("updateJournalEntry", store, {
    [PRIMARY_PATH]: newerCheckpointEnvelope,
    [CHECKPOINT_PATH]: newerCheckpointEnvelope,
  });
  blockedCheckpoint.release();
  await assert.rejects(
    lateCheckpointOperation,
    /AuthorityChanged|PostconditionFailed/,
  );
  assert.notDeepEqual(
    flags.criticalInjuryWorkflowCheckpoint,
    flags.criticalInjuryWorkflow,
    "the stale checkpoint lands but cannot advance to the primary",
  );
  assert.ok(
    flags.criticalInjuryWorkflowCheckpoint.records.some(
      (record) => record.pendingId === "pending-old-checkpoint",
    ),
  );
  assert.deepEqual(
    flags.criticalInjuryWorkflow,
    newerCheckpointEnvelope,
    "a late checkpoint cannot overwrite the newer primary",
  );
  await workflow.ensureCriticalInjuryWorkflowAuthority();
  assertReplicasMatch(flags, [
    "pending-base",
    "pending-old-primary",
    "pending-new-primary",
    "pending-new-checkpoint",
  ]);

  // After a reload, an equal-revision conflict authored by two different GMs
  // is resolved in favor of the user who is authoritative now.
  const equalBase = structuredClone(flags.criticalInjuryWorkflow);
  const equalGmA = {
    ...structuredClone(equalBase),
    authorityId: gmA.id,
    authorityEpoch: "gm-a:equal-conflict",
    writeToken: "equal-gm-a",
  };
  const equalGmB = addApproval(
    equalBase,
    "pending-equal-gm-b",
    {
      authorityId: gmB.id,
      authorityEpoch: "gm-b:equal-conflict",
    },
    0,
  );
  flags.criticalInjuryWorkflow = equalGmA;
  flags.criticalInjuryWorkflowCheckpoint = equalGmB;
  globalThis.Hooks.call("updateJournalEntry", store, {
    [PRIMARY_PATH]: equalGmA,
    [CHECKPOINT_PATH]: equalGmB,
  });
  globalThis.game.user = gmB;
  userCollection.activeGM = gmB;
  workflow.resetCriticalInjuryWorkflowStoreForTests();
  await workflow.ensureCriticalInjuryWorkflowAuthority();
  assertReplicasMatch(flags, [
    "pending-base",
    "pending-old-primary",
    "pending-new-primary",
    "pending-new-checkpoint",
    "pending-equal-gm-b",
  ]);
  assert.equal(flags.criticalInjuryWorkflow.authorityId, gmB.id);

  // Two tabs for the same GM can write different values at the same revision.
  // With no previously accepted receipt, recovery must fail closed instead of
  // guessing which tab won.
  const sameUserBase = structuredClone(flags.criticalInjuryWorkflow);
  const sameUserPrimary = {
    ...structuredClone(sameUserBase),
    authorityEpoch: "gm-b:same-user-primary",
    writeToken: "same-user-primary",
  };
  const sameUserCheckpoint = addApproval(
    sameUserBase,
    "pending-same-user-conflict",
    {
      authorityId: gmB.id,
      authorityEpoch: "gm-b:same-user-checkpoint",
    },
    0,
  );
  flags.criticalInjuryWorkflow = sameUserPrimary;
  flags.criticalInjuryWorkflowCheckpoint = sameUserCheckpoint;
  globalThis.Hooks.call("updateJournalEntry", store, {
    [PRIMARY_PATH]: sameUserPrimary,
    [CHECKPOINT_PATH]: sameUserCheckpoint,
  });
  workflow.resetCriticalInjuryWorkflowStoreForTests();
  assert.deepEqual(
    workflow.normalizeCriticalInjuryWorkflowStore(sameUserPrimary),
    sameUserPrimary,
    "same-user primary fixture remains a valid persisted envelope",
  );
  assert.deepEqual(
    workflow.normalizeCriticalInjuryWorkflowStore(sameUserCheckpoint),
    sameUserCheckpoint,
    "same-user checkpoint fixture remains a valid persisted envelope",
  );
  assert.equal(sameUserPrimary.revision, sameUserCheckpoint.revision);
  assert.throws(
    () => workflow.loadCriticalInjuryWorkflowStore(),
    /RevisionConflict/,
  );
  await assert.rejects(
    workflow.ensureCriticalInjuryWorkflowAuthority(),
    /RevisionConflict/,
    "equal-revision writes from two sessions of the same GM fail closed",
  );
  flags.criticalInjuryWorkflow = structuredClone(sameUserBase);
  flags.criticalInjuryWorkflowCheckpoint = structuredClone(sameUserBase);
  globalThis.Hooks.call("updateJournalEntry", store, {
    [PRIMARY_PATH]: sameUserBase,
    [CHECKPOINT_PATH]: sameUserBase,
  });
  workflow.resetCriticalInjuryWorkflowStoreForTests();
  await workflow.ensureCriticalInjuryWorkflowAuthority();

  workflow.registerCriticalInjuryWorkflowObserver();
  await nextTasks(2);
  const checkpointBeforeFailures = structuredClone(
    flags.criticalInjuryWorkflowCheckpoint,
  );
  const attemptsBeforeFailures = primaryUpdateAttempts;
  primaryFailuresRemaining = 3;
  console.warn = () => {};
  console.error = () => {};
  await workflow.createCriticalInjuryApproval({
    pendingId: "pending-primary-failures",
    actorId: "actor-1",
    targetUserId: "player-1",
    approvedAt: 4,
  });
  await nextTasks(12);
  const failedAttemptCount = primaryUpdateAttempts - attemptsBeforeFailures;
  assert.ok(
    failedAttemptCount <= 3,
    `primary reconciliation should be bounded, observed ${failedAttemptCount} attempts`,
  );
  assert.equal(
    flags.criticalInjuryWorkflowCheckpoint.revision,
    checkpointBeforeFailures.revision + 1,
    "repair retries do not churn the good checkpoint revision",
  );
  primaryFailuresRemaining = 0;
  await workflow.ensureCriticalInjuryWorkflowAuthority();
  assertReplicasMatch(flags, [
    "pending-base",
    "pending-old-primary",
    "pending-new-primary",
    "pending-new-checkpoint",
    "pending-equal-gm-b",
    "pending-primary-failures",
  ]);
  await nextTasks(6);
  workflow.resetCriticalInjuryWorkflowStoreForTests();
} finally {
  console.warn = savedConsoleWarn;
  console.error = savedConsoleError;
  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) delete globalThis[key];
    else globalThis[key] = value;
  }
}

function addApproval(envelope, pendingId, authority, revisionDelta = 2) {
  return {
    ...structuredClone(envelope),
    revision: Number(envelope.revision) + revisionDelta,
    authorityId: authority.authorityId,
    authorityEpoch: authority.authorityEpoch,
    writeToken: `external-${pendingId}`,
    records: [
      ...structuredClone(envelope.records),
      {
        schema: 1,
        pendingId,
        actorId: "actor-1",
        targetUserId: "player-1",
        approvedBy: authority.authorityId,
        approvedAt: Date.now(),
        state: "approved",
        resolution: null,
        applicationLease: null,
        result: null,
        effectId: "",
        calendarEntryId: "",
        completedBy: "",
        completedAt: null,
      },
    ],
  };
}

function assertReplicasMatch(flags, pendingIds) {
  assert.deepEqual(
    flags.criticalInjuryWorkflow,
    flags.criticalInjuryWorkflowCheckpoint,
    "the primary and checkpoint replicas converge",
  );
  const storedIds = flags.criticalInjuryWorkflow.records
    .map((record) => record.pendingId)
    .sort((left, right) => left.localeCompare(right));
  assert.deepEqual(
    storedIds,
    [...pendingIds].sort((left, right) => left.localeCompare(right)),
  );
}

async function nextTasks(count) {
  for (let index = 0; index < count; index += 1) {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}

process.stdout.write("critical injury authority handoff recovery passed\n");
