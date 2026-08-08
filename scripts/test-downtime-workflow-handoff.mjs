import assert from "node:assert/strict";

const saved = Object.fromEntries(
  ["game", "foundry", "CONST", "Hooks", "JournalEntry"].map((key) => [
    key,
    globalThis[key],
  ]),
);

const MODULE_ID = "infinity-dnd5e";
const CHECKPOINT_PATH = `flags.${MODULE_ID}.downtimeWorkflowCheckpoint`;
const CONFIG_PATH = `flags.${MODULE_ID}.downtimeConfig`;

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
  const document = {
    id: "private-downtime-store",
    ownership: { default: 0 },
    getFlag(scope, key) {
      return scope === MODULE_ID ? flags[key] : undefined;
    },
    async update(changes) {
      for (const [path, value] of Object.entries(changes)) {
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
} finally {
  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) delete globalThis[key];
    else globalThis[key] = value;
  }
}

process.stdout.write("downtime workflow authority handoff passed\n");
