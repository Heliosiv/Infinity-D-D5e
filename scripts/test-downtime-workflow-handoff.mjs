import assert from "node:assert/strict";

const saved = Object.fromEntries(
  [
    "game",
    "foundry",
    "CONST",
    "Hooks",
    "JournalEntry",
    "setTimeout",
    "clearTimeout",
  ].map((key) => [key, globalThis[key]]),
);

const MODULE_ID = "infinity-dnd5e";
const CHECKPOINT_PATH = `flags.${MODULE_ID}.downtimeWorkflowCheckpoint`;
const CONFIG_PATH = `flags.${MODULE_ID}.downtimeConfig`;
const WORKFLOW_PATH = `flags.${MODULE_ID}.downtimeWorkflow`;

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
      randomID: () => `handoff-token-${++randomId}`,
    },
  };

  const flags = {
    privateStateStore: true,
    schemaVersion: 5,
    merchants: [],
    factions: [],
    resourceConfig: {},
    resourceRunState: {},
    criticalInjuryWorkflow: {},
    criticalInjuryWorkflowCheckpoint: {},
    downtimeConfig: {},
    downtimeWorkflow: {},
    downtimeWorkflowCheckpoint: {},
  };
  let blockedUpdate = null;
  let failedUpdatePath = null;
  const document = {
    id: "private-downtime-store",
    ownership: { default: 0 },
    getFlag(scope, key) {
      return scope === MODULE_ID ? flags[key] : undefined;
    },
    async update(changes) {
      for (const [path, value] of Object.entries(changes)) {
        if (failedUpdatePath === path) {
          failedUpdatePath = null;
          throw new Error("simulated workflow primary interruption");
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
      const releasePromise = new Promise((resolve) => {
        releaseResolve = resolve;
      });
      const started = new Promise((resolve) => {
        startedResolve = resolve;
      });
      blockedUpdate = { path, releasePromise, startedResolve };
      return { started, release: releaseResolve };
    },
    failNext(path) {
      failedUpdatePath = path;
    },
  };

  const gmA = { id: "gm-a", isGM: true, role: 4, active: true };
  const gmB = { id: "gm-b", isGM: true, role: 4, active: true };
  const users = new Map([
    [gmA.id, gmA],
    [gmB.id, gmB],
  ]);
  users.activeGM = gmA;
  const settings = new Map([["privateStateStoreId", document.id]]);
  globalThis.game = {
    ready: true,
    user: gmA,
    users,
    journal: {
      find(predicate) {
        return predicate(document) ? document : null;
      },
      forEach(callback) {
        callback(document);
      },
    },
    time: { serverTime: 10_000 },
    settings: {
      get(_moduleId, key) {
        if (settings.has(key)) return settings.get(key);
        if (["merchants", "factions"].includes(key)) return [];
        return {};
      },
      async set(_moduleId, key, value) {
        settings.set(key, structuredClone(value));
        return value;
      },
    },
  };
  globalThis.JournalEntry = {
    async create() {
      throw new Error("the existing private store should be reused");
    },
  };

  const privateState = await import("./private-state.js");
  const workflow = await import("./downtime/store.js");
  const downtimeService = await import("./downtime/service.js");
  const downtimeItems = await import("./downtime/items.js");
  privateState.resetPrivateStateForTests();
  workflow.resetDowntimeWorkflowStoreForTests();
  assert.equal(await privateState.initializePrivateState(), true);

  await workflow.createDowntimeBlock({
    id: "handoff-block",
    settlementId: "greyhaven",
    budgetHours: 8,
  });
  await workflow.lockDowntimeBlock("handoff-block");
  await workflow.persistDowntimePlan("handoff-block", {
    operations: [
      {
        operationId: "handoff-operation",
        actorId: "actor-1",
        order: 0,
      },
    ],
  });
  await workflow.beginDowntimeApplication("handoff-block");
  await workflow.claimDowntimeOperation("handoff-block", "handoff-operation", {
    attemptId: "gm-a-attempt",
  });

  users.activeGM = gmB;
  globalThis.game.user = gmB;
  await workflow.ensureDowntimeWorkflowAuthority();
  let active = workflow.getActiveDowntimeBlock();
  assert.equal(active.state, "needs-review");
  assert.equal(
    active.operationLedger["handoff-operation"].state,
    "needs-review",
  );
  assert.equal(
    active.operationLedger["handoff-operation"].reason,
    "authority-handoff-during-operation",
  );
  assert.equal(flags.downtimeWorkflow.authorityId, gmB.id);
  assert.deepEqual(
    flags.downtimeWorkflow,
    flags.downtimeWorkflowCheckpoint.workflow,
  );

  await workflow.cancelDowntimeBlock("handoff-block", {
    reason: "handoff fixture complete",
  });
  await workflow.createDowntimeBlock({
    id: "stale-write-block",
    settlementId: "greyhaven",
    budgetHours: 8,
  });

  users.activeGM = gmA;
  globalThis.game.user = gmA;
  await workflow.ensureDowntimeWorkflowAuthority();
  const acceptedBeforeLateWrite = structuredClone(flags.downtimeWorkflow);
  const blocked = document.blockNext(CHECKPOINT_PATH);
  const lateWrite = workflow.updateCollectingDowntimeBlock(
    "stale-write-block",
    { budgetHours: 99 },
    { expectedRevision: acceptedBeforeLateWrite.revision },
  );
  await blocked.started;

  users.activeGM = gmB;
  globalThis.game.user = gmB;
  blocked.release();
  await assert.rejects(lateWrite, /Authority|Postcondition/);
  assert.equal(
    flags.downtimeWorkflowCheckpoint.workflow.activeBlock.budgetHours,
    99,
    "the retired checkpoint physically landed before its postcondition failed",
  );
  const freshWorkflowAfterLateCheckpoint = await import(
    `./downtime/store.js?fresh-workflow-handoff=${Date.now()}`
  );
  await freshWorkflowAfterLateCheckpoint.ensureDowntimeWorkflowAuthority();

  active = freshWorkflowAfterLateCheckpoint.getActiveDowntimeBlock();
  assert.equal(
    active.budgetHours,
    8,
    "a cache-cold GM discards a divergent checkpoint from the retired writer",
  );
  assert.equal(flags.downtimeWorkflow.authorityId, gmB.id);
  assert.deepEqual(
    flags.downtimeWorkflow,
    flags.downtimeWorkflowCheckpoint.workflow,
  );

  await workflow.saveDowntimeConfig({
    settlements: [{ id: "greyhaven", name: "Greyhaven" }],
    heat: { greyhaven: { "actor-1": 1 } },
  });
  users.activeGM = gmA;
  globalThis.game.user = gmA;
  await workflow.ensureDowntimeWorkflowAuthority();
  const acceptedConfig = structuredClone(flags.downtimeConfig);
  const blockedConfig = document.blockNext(CONFIG_PATH);
  const lateConfigWrite = workflow.saveDowntimeConfig({
    settlements: [{ id: "greyhaven", name: "Greyhaven" }],
    heat: { greyhaven: { "actor-1": 5 } },
  });
  await blockedConfig.started;

  users.activeGM = gmB;
  globalThis.game.user = gmB;
  blockedConfig.release();
  await assert.rejects(lateConfigWrite, /Authority|Postcondition/);
  assert.equal(
    flags.downtimeConfig.heat.greyhaven["actor-1"],
    5,
    "the retired write reached the primary before its lost-authority postcondition",
  );
  const freshWorkflow = await import(
    `./downtime/store.js?fresh-gm-handoff=${Date.now()}`
  );
  await freshWorkflow.ensureDowntimeWorkflowAuthority();
  assert.deepEqual(
    flags.downtimeConfig,
    acceptedConfig,
    "a fresh authoritative client restores config from the durable checkpoint",
  );
  assert.equal(flags.downtimeWorkflow.authorityId, gmB.id);
  assert.equal(flags.downtimeWorkflowCheckpoint.config.authorityId, gmB.id);
  assert.deepEqual(
    flags.downtimeWorkflow,
    flags.downtimeWorkflowCheckpoint.workflow,
  );

  users.activeGM = gmA;
  globalThis.game.user = gmA;
  await freshWorkflow.ensureDowntimeWorkflowAuthority();
  const acceptedBeforeLateConfigCheckpoint = structuredClone(
    flags.downtimeConfig,
  );
  const blockedConfigCheckpoint = document.blockNext(CHECKPOINT_PATH);
  const lateConfigCheckpointWrite = freshWorkflow.saveDowntimeConfig({
    settlements: [{ id: "greyhaven", name: "Greyhaven" }],
    heat: { greyhaven: { "actor-1": 5 } },
  });
  await blockedConfigCheckpoint.started;

  users.activeGM = gmB;
  globalThis.game.user = gmB;
  blockedConfigCheckpoint.release();
  await assert.rejects(lateConfigCheckpointWrite, /Authority|Postcondition/);
  assert.equal(
    flags.downtimeWorkflowCheckpoint.config.value.heat.greyhaven["actor-1"],
    5,
    "the retired config checkpoint physically landed before rejection",
  );
  const freshAfterLateConfigCheckpoint = await import(
    `./downtime/store.js?fresh-config-checkpoint-handoff=${Date.now()}`
  );
  await freshAfterLateConfigCheckpoint.ensureDowntimeWorkflowAuthority();
  assert.deepEqual(
    flags.downtimeConfig,
    acceptedBeforeLateConfigCheckpoint,
    "a cache-cold GM restores config bound to the last fully mirrored workflow",
  );
  assert.deepEqual(
    flags.downtimeWorkflow.configCheckpoint,
    flags.downtimeWorkflowCheckpoint.config,
  );

  // A -> B -> A can happen quickly when two GM clients reconnect. The
  // returning A must not reuse its earlier authority epoch and silently resume
  // an operation claimed before B became authoritative. Exercise the narrow
  // interruption where B's review checkpoint lands but its primary mirror is
  // fenced out when A returns.
  users.activeGM = gmA;
  globalThis.game.user = gmA;
  await freshAfterLateConfigCheckpoint.ensureDowntimeWorkflowAuthority();
  await freshAfterLateConfigCheckpoint.cancelDowntimeBlock(
    "stale-write-block",
    { reason: "prepare repeated-authority handoff fixture" },
  );
  await freshAfterLateConfigCheckpoint.createDowntimeBlock({
    id: "repeated-authority-block",
    settlementId: "greyhaven",
    budgetHours: 4,
  });
  await freshAfterLateConfigCheckpoint.lockDowntimeBlock(
    "repeated-authority-block",
  );
  await freshAfterLateConfigCheckpoint.persistDowntimePlan(
    "repeated-authority-block",
    {
      operations: [
        {
          operationId: "repeated-authority-operation",
          actorId: "actor-1",
          summary: "Repeated authority handoff operation",
        },
      ],
    },
  );
  await freshAfterLateConfigCheckpoint.beginDowntimeApplication(
    "repeated-authority-block",
  );
  const repeatedAuthorityClaim =
    await freshAfterLateConfigCheckpoint.claimDowntimeOperation(
      "repeated-authority-block",
      "repeated-authority-operation",
      { attemptId: "gm-a-old-epoch-attempt" },
    );
  const retiredAttemptToken = {
    blockId: "repeated-authority-block",
    operationId: "repeated-authority-operation",
    attemptId: "gm-a-old-epoch-attempt",
    authorityEpoch: repeatedAuthorityClaim.record.authorityEpoch,
    userId: repeatedAuthorityClaim.record.claimedBy,
  };
  const retiredAttemptWriteAuthority = () =>
    downtimeService.hasCurrentDowntimeWriteAuthority(retiredAttemptToken);
  assert.equal(retiredAttemptWriteAuthority(), true);
  const firstGmAEpoch = flags.downtimeWorkflow.authorityEpoch;

  document.failNext(WORKFLOW_PATH);
  users.activeGM = gmB;
  globalThis.game.user = gmB;
  await assert.rejects(
    freshAfterLateConfigCheckpoint.ensureDowntimeWorkflowAuthority(),
    /simulated workflow primary interruption/,
  );
  assert.equal(
    flags.downtimeWorkflowCheckpoint.workflow.activeBlock.state,
    "needs-review",
    "the handoff checkpoint fences the in-flight operation",
  );
  assert.equal(
    flags.downtimeWorkflow.activeBlock.state,
    "applying",
    "the interrupted primary still contains A's stale in-flight claim",
  );
  users.activeGM = gmA;
  globalThis.game.user = gmA;

  const returningGmA = await import(
    `./downtime/store.js?returning-gm-a=${Date.now()}`
  );
  await returningGmA.ensureDowntimeWorkflowAuthority();
  active = returningGmA.getActiveDowntimeBlock();
  assert.equal(active.state, "needs-review");
  assert.equal(
    active.operationLedger["repeated-authority-operation"].state,
    "needs-review",
    "a repeated GM id cannot revive an operation claimed under its retired epoch",
  );
  assert.notEqual(
    flags.downtimeWorkflow.authorityEpoch,
    firstGmAEpoch,
    "each authority tenure has a unique fencing epoch",
  );
  assert.equal(
    retiredAttemptWriteAuthority(),
    false,
    "returning to the same GM id does not revive the old operation epoch",
  );
  let deferredExternalWrites = 0;
  const deferredActor = {
    id: "deferred-write-actor",
    items: new Map(),
    async createEmbeddedDocuments() {
      deferredExternalWrites += 1;
      return [];
    },
  };
  const deniedDeferredWrite = await downtimeItems.applyStolenItemDelivery(
    deferredActor,
    { _id: "deferred-stolen-item", system: { quantity: 1 }, flags: {} },
    { authorizeWrite: retiredAttemptWriteAuthority },
  );
  assert.equal(deniedDeferredWrite.reason, "authority-lost");
  assert.equal(
    deferredExternalWrites,
    0,
    "a deferred A -> B -> A Actor write is fenced before mutation",
  );

  await returningGmA.cancelDowntimeBlock("repeated-authority-block", {
    reason: "prepare hidden-roll handoff fixture",
  });
  await returningGmA.createDowntimeBlock({
    id: "hidden-roll-handoff-block",
    settlementId: "greyhaven",
    budgetHours: 2,
  });
  await returningGmA.lockDowntimeBlock("hidden-roll-handoff-block");
  await returningGmA.initializeDowntimePlanningDraft(
    "hidden-roll-handoff-block",
    {
      version: 1,
      blockId: "hidden-roll-handoff-block",
      settlementId: "greyhaven",
      budgetHours: 2,
      participants: [
        {
          actorId: "actor-1",
          queue: [
            {
              id: "handoff-trade",
              activityId: "market-trading",
              hours: 2,
            },
          ],
        },
      ],
      checkedRows: [
        {
          rowId: "handoff-hidden-roll",
          actorId: "actor-1",
          actionId: "handoff-trade",
          activityId: "market-trading",
          order: 0,
        },
      ],
    },
  );
  await returningGmA.claimDowntimePlanningRoll(
    "hidden-roll-handoff-block",
    "handoff-hidden-roll",
  );
  users.activeGM = gmB;
  globalThis.game.user = gmB;
  await returningGmA.ensureDowntimeWorkflowAuthority();
  active = returningGmA.getActiveDowntimeBlock();
  assert.equal(
    active.state,
    "locked",
    "the public workflow remains locked until a complete plan exists",
  );
  assert.equal(active.planningDraft.state, "needs-review");
  assert.equal(
    active.planningDraft.reviewReason,
    "authority-handoff-during-hidden-roll",
    "an active-GM handoff fails an orphaned hidden roll closed",
  );
  assert.equal(
    active.planningDraft.rows["handoff-hidden-roll"].state,
    "in-flight",
    "the uncertain roll reservation is retained as private recovery evidence",
  );

  const lifecycleTimers = [];
  globalThis.setTimeout = (callback, delay = 0) => {
    const timer = {
      callback,
      delay,
      cancelled: false,
      unref() {},
    };
    lifecycleTimers.push(timer);
    return timer;
  };
  globalThis.clearTimeout = (timer) => {
    if (timer) timer.cancelled = true;
  };
  const flushAsyncTurns = async (turns = 12) => {
    for (let index = 0; index < turns; index += 1) {
      await new Promise((resolve) => setImmediate(resolve));
    }
  };
  const runLifecycleTimers = async () => {
    for (const timer of lifecycleTimers.splice(0)) {
      if (!timer.cancelled) timer.callback();
    }
    await flushAsyncTurns();
  };

  downtimeService.registerDowntimeService();
  await flushAsyncTurns();
  await runLifecycleTimers();
  await workflow.ensureDowntimeWorkflowAuthority();
  await workflow.updateDowntimeConfig((current) => ({
    ...current,
    sharpeningLifecycle: {
      pending: [
        {
          eventId: "lifecycle-handoff-ordering",
          kind: "damage",
          actorId: "missing-actor",
          itemId: "missing-item",
          effectId: "missing-effect",
          operationId: "missing-operation",
          rollId: "missing-roll",
          originUserId: "missing-player",
          acceptedAt: 20_000,
          attempts: 0,
          lastAttemptAt: 0,
          lastError: null,
        },
      ],
      completed: [],
    },
  }));
  lifecycleTimers.length = 0;

  users.activeGM = gmA;
  globalThis.game.user = gmA;
  globalThis.Hooks.call("userConnected", gmA);
  assert.equal(
    lifecycleTimers.length,
    0,
    "lifecycle reconciliation is not scheduled under the retired epoch",
  );
  assert.equal(
    workflow.loadDowntimeConfig().sharpeningLifecycle.pending.length,
    1,
    "the pending lifecycle event remains durable during authority installation",
  );
  await flushAsyncTurns(20);
  assert.equal(flags.downtimeWorkflow.authorityId, gmA.id);
  assert.equal(
    workflow.loadDowntimeConfig().sharpeningLifecycle.pending.length,
    1,
    "installing the new epoch does not discard the pending lifecycle event",
  );
  assert.equal(
    lifecycleTimers.some((timer) => timer.delay === 0 && !timer.cancelled),
    true,
    "the lifecycle pass is scheduled only after the new authority epoch is durable",
  );
  await runLifecycleTimers();
  const lifecycleAfterHandoff =
    workflow.loadDowntimeConfig().sharpeningLifecycle;
  assert.equal(lifecycleAfterHandoff.pending.length, 0);
  assert.equal(
    lifecycleAfterHandoff.completed.some(
      (entry) => entry.eventId === "lifecycle-handoff-ordering",
    ),
    true,
    "the new authority reconciles the event preserved across hook ordering",
  );
} finally {
  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) delete globalThis[key];
    else globalThis[key] = value;
  }
}

process.stdout.write("downtime workflow authority handoff passed\n");
