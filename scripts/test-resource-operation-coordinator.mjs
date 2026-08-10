import assert from "node:assert/strict";

import {
  createResourceOperationCoordinator,
  ResourceOperationCoordinatorError,
} from "./resource/operation-coordinator.js";
import {
  adoptResourceOperationAuthority,
  createResourceOperation,
  createResourceOperationContext,
  markResourceInventoryOperationApplied,
  normalizeResourceOperation,
  recordResourcePromptResponse,
  recordResourcePromptTimeout,
  resourceOperationGuardMatches,
  transitionResourceOperation,
} from "./resource/operation-ledger.js";

const foodResource = Object.freeze({
  id: "food",
  label: "Rations",
  scope: "per-character",
  perDay: 0,
  forageYields: "food",
  matching: Object.freeze({
    flagTag: "food",
    itemUuids: Object.freeze([]),
    nameKeywords: Object.freeze([]),
    excludeNameKeywords: Object.freeze([]),
  }),
});

function guard(generation = 1) {
  return {
    authorityId: "gm-1",
    authorityEpoch: `epoch-${generation}`,
    leadershipGeneration: generation,
  };
}

function taggedItem(id, quantity, resourceId = "food") {
  return {
    _id: id,
    name: "Rations",
    type: "loot",
    system: { quantity },
    flags: { "infinity-dnd5e": { resourceTag: resourceId } },
  };
}

function makeActor(trace, { quantity = 4, behavior = "normal" } = {}) {
  const items = new Map([["food-stack", taggedItem("food-stack", quantity)]]);
  return {
    id: "hero",
    name: "Hero",
    items,
    writes: 0,
    async updateEmbeddedDocuments(_type, updates) {
      this.writes += 1;
      trace.push("effect:inventory:update");
      const expected = updates[0]["system.quantity"];
      if (behavior === "normal" || behavior === "throw-after") {
        items.get("food-stack").system.quantity = expected;
      } else if (behavior === "third-state") {
        items.get("food-stack").system.quantity = expected + 1;
      }
      if (behavior === "throw-after" || behavior === "no-change-throw") {
        throw new Error("Actor update rejected after dispatch");
      }
      return [items.get("food-stack")];
    },
    async createEmbeddedDocuments() {
      throw new Error("unexpected create");
    },
    async deleteEmbeddedDocuments() {
      throw new Error("unexpected delete");
    },
  };
}

function operationInput({
  runId,
  clock,
  scenario = "manual",
  prompts = [],
  consumeAmount = 0,
} = {}) {
  const actors =
    prompts.length > 0
      ? prompts.map((prompt) => ({
          actorId: prompt.actorId,
          name: prompt.actorId,
          role: "participant",
          forageTarget: prompt.forageTarget,
        }))
      : [
          {
            actorId: "hero",
            name: "Hero",
            role: "participant-inventory",
            forageTarget: null,
          },
        ];
  return {
    operationId: `operation:${runId}`,
    runId,
    kind: prompts.length > 0 ? "forage" : "upkeep",
    trigger: prompts.length > 0 ? "forage" : "manual",
    context: createResourceOperationContext({
      scenario,
      prompts,
      consumeAmount,
    }),
    day: null,
    days: 1,
    environment: {
      id: "forest",
      label: "Forest",
      dc: 12,
      foodDc: 12,
      waterDc: 12,
    },
    initiator: { userId: "gm-1", name: "GM" },
    actors,
    createdAt: clock,
  };
}

function makeHarness({
  initialGuard = guard(1),
  actorOptions = {},
  deliveryAuthority = true,
  delayLoads = false,
  onEmitPrompt = null,
  onLoadActive = null,
  now = null,
  maxSteps = undefined,
} = {}) {
  const trace = [];
  const actor = makeActor(trace, actorOptions);
  const actors = new Map([[actor.id, actor]]);
  const chatMessages = new Map();
  const state = {
    clock: 1000,
    guard: structuredClone(initialGuard),
    active: null,
    outbox: [],
    recentRuns: [],
    deliveryAuthority,
    messageCounter: 0,
    loadDepth: 0,
    maxLoadDepth: 0,
    promptEmissionFailure: null,
    promptAssignmentTimes: [],
    completionRequests: [],
    terminalPersistResult: undefined,
  };

  const store = {
    async claimResourceOperation(input) {
      if (state.active) throw new Error("ResourceOperationAlreadyActive");
      state.active = createResourceOperation({
        ...input,
        guard: state.guard,
      });
      trace.push(`store:claim:${state.active.runId}`);
      return state.active;
    },

    async loadActiveResourceOperation() {
      state.loadDepth += 1;
      state.maxLoadDepth = Math.max(state.maxLoadDepth, state.loadDepth);
      try {
        if (typeof onLoadActive === "function") await onLoadActive();
        if (delayLoads) await new Promise((resolve) => setTimeout(resolve, 0));
        return state.active;
      } finally {
        state.loadDepth -= 1;
      }
    },

    async transitionResourceOperation(runId, phase, options) {
      assert.equal(state.active?.runId, runId);
      state.active = transitionResourceOperation(state.active, phase, options);
      trace.push(`store:transition:${phase}:${runId}`);
      return state.active;
    },

    async recordResourcePromptResponse(runId, response, options) {
      assert.equal(state.active?.runId, runId);
      state.active = recordResourcePromptResponse(
        state.active,
        response,
        options,
      );
      trace.push(`store:response:${response.promptId}`);
      return state.active;
    },

    async recordResourcePromptTimeout(runId, promptId, options) {
      assert.equal(state.active?.runId, runId);
      state.active = recordResourcePromptTimeout(
        state.active,
        promptId,
        options,
      );
      trace.push(`store:timeout:${promptId}`);
      return state.active;
    },

    async markResourceInventoryOperationApplied(runId, opId, options) {
      assert.equal(state.active?.runId, runId);
      state.active = markResourceInventoryOperationApplied(
        state.active,
        opId,
        options,
      );
      trace.push(`store:inventory-marker:${opId}`);
      return state.active;
    },

    async adoptResourceOperationAuthority({
      location,
      operationId,
      runId,
      nextGuard,
      contextSnapshot,
      observations,
      at,
    }) {
      const options = {
        at,
        ...(location === "active" ? { contextSnapshot, observations } : {}),
      };
      if (location === "active") {
        assert.equal(state.active?.runId, runId);
        assert.equal(state.active?.operationId, operationId);
        state.active = adoptResourceOperationAuthority(
          state.active,
          nextGuard,
          options,
        );
        trace.push(`store:adopt:active:${runId}`);
        return state.active;
      }
      const index = state.outbox.findIndex((record) => record.runId === runId);
      assert.ok(index >= 0);
      assert.equal(state.outbox[index].operationId, operationId);
      state.outbox[index] = adoptResourceOperationAuthority(
        state.outbox[index],
        nextGuard,
        { at },
      );
      trace.push(`store:adopt:outbox:${runId}`);
      return state.outbox[index];
    },

    assertResourceOperationCurrent(runId, candidateGuard) {
      trace.push(`store:assert-current:${runId}`);
      if (
        state.active?.runId !== runId ||
        !resourceOperationGuardMatches(state.active, candidateGuard) ||
        JSON.stringify(candidateGuard) !== JSON.stringify(state.guard)
      ) {
        throw new Error("ResourceOperationClaimLost");
      }
      return true;
    },

    async completeResourceOperation({
      operationId,
      runId,
      terminalRecord,
      receipt,
      persistResult,
    }) {
      assert.equal(state.active?.runId, runId);
      assert.equal(state.active?.operationId, operationId);
      const terminal = normalizeResourceOperation(terminalRecord);
      assert.equal(terminal.phase, "terminal");
      assert.deepEqual(terminal.receipt, receipt);
      assert.ok(
        terminal.outbox.entries.some((entry) => entry.state === "pending"),
      );
      state.recentRuns.push(structuredClone(receipt));
      state.outbox.push(terminal);
      state.active = null;
      state.completionRequests.push({
        operationId,
        runId,
        persistResult,
      });
      trace.push(`store:complete:${runId}`);
      return terminal;
    },

    async listPendingResourceDeliveries() {
      return [...state.outbox];
    },

    async markResourceOperationDeliveryDelivered({
      operationId,
      runId,
      deliveryId,
      updatedRecord,
    }) {
      assert.equal(state.outbox[0]?.runId, runId, "global FIFO head only");
      assert.equal(state.outbox[0]?.operationId, operationId);
      const updated = normalizeResourceOperation(updatedRecord);
      assert.equal(updated.runId, runId);
      const delivery = updated.outbox.entries.find(
        (entry) => entry.deliveryId === deliveryId,
      );
      assert.equal(delivery?.state, "delivered");
      state.outbox[0] = updated;
      trace.push(`store:delivery-marker:${runId}:${delivery.kind}`);
      if (!updated.outbox.entries.some((entry) => entry.state === "pending")) {
        state.outbox.shift();
        trace.push(`store:compact-outbox:${runId}`);
      }
      return updated;
    },
  };

  const domain = {
    async captureCurrentContext(record) {
      trace.push(`domain:context:${record.runId}`);
      return structuredClone(record.context.snapshot);
    },

    async buildPromptAssignments(record, { assignedAt } = {}) {
      state.promptAssignmentTimes.push(assignedAt);
      return record.context.snapshot.prompts.map((prompt) => ({
        promptId: prompt.promptId,
        actorId: prompt.actorId,
        userId: prompt.userId,
        forageTarget: prompt.forageTarget,
        dc: 12,
        foodDc: 12,
        waterDc: 12,
        assignedAt: 0,
        deadlineAt:
          prompt.timeoutMs == null
            ? prompt.deadlineAt
            : assignedAt + prompt.timeoutMs,
      }));
    },

    async buildPromptPayload(record, assignment) {
      return {
        day: record.day,
        actorName: assignment.actorId,
        environment: { ...record.environment, forageable: true },
      };
    },

    async normalizePromptResponse(record, payload) {
      const assignment = record.prompts.assignments.find(
        (entry) => entry.promptId === payload.promptId,
      );
      assert.ok(assignment);
      return {
        promptId: assignment.promptId,
        actorId: assignment.actorId,
        userId: payload.originUserId,
        rollTotal: payload.rollTotal,
        wisMod: 2,
        skipped: payload.skipped === true,
      };
    },

    async preparePlan(record) {
      trace.push(`domain:plan:${record.runId}`);
      const yields = record.prompts.assignments.map((assignment) => {
        const response = record.prompts.responses.find(
          (entry) => entry.promptId === assignment.promptId,
        );
        return {
          actorId: assignment.actorId,
          forageTarget: assignment.forageTarget,
          rollTotal: response?.rollTotal ?? null,
          wisMod: response?.wisMod ?? null,
          food: 0,
          water: 0,
          foodSuccess: false,
          waterSuccess: false,
          suppressedFood: false,
          suppressedWater: false,
        };
      });
      const consumeAmount = Number(record.context.snapshot.consumeAmount) || 0;
      const snapshots = [...actor.items.values()].map((item) =>
        structuredClone(item),
      );
      return {
        yields,
        inventory: {
          roster: [
            {
              actorId: actor.id,
              name: actor.name,
              consumes: true,
              drawFromId: actor.id,
              items: snapshots,
            },
          ],
          resources: [
            {
              ...foodResource,
              perDay: consumeAmount,
            },
          ],
          includeConsumption: consumeAmount > 0,
        },
      };
    },

    async buildTerminalArtifacts(record) {
      trace.push(`domain:terminal-artifacts:${record.runId}`);
      const receipt = {
        runId: record.runId,
        kind: record.kind,
        status: "complete",
      };
      const report = {
        runId: record.runId,
        status: "complete",
      };
      const artifacts = {
        report,
        result: report,
        receipt,
        chat: {
          content: `Report ${record.runId}`,
          speaker: { alias: "Quartermaster" },
          whisper: null,
        },
      };
      if (state.terminalPersistResult !== undefined) {
        artifacts.persistResult = state.terminalPersistResult;
      }
      return artifacts;
    },

    async resolveActors() {
      return actors;
    },

    async resolveResources() {
      return [foodResource];
    },
  };

  const promptFrames = [];
  let coordinator = null;
  coordinator = createResourceOperationCoordinator({
    store,
    domain,
    currentGuard: () => structuredClone(state.guard),
    now: () => (typeof now === "function" ? now(state) : state.clock),
    maxSteps,
    emitPrompt: async (payload) => {
      promptFrames.push(structuredClone(payload));
      trace.push(
        `effect:prompt:${payload.promptId}:${payload.responseAccepted}`,
      );
      if (typeof onEmitPrompt === "function") {
        await onEmitPrompt(payload, () => coordinator);
      }
      if (state.promptEmissionFailure === "throw") {
        throw new Error("prompt transport rejected");
      }
      if (state.promptEmissionFailure === "null") return null;
      if (state.promptEmissionFailure === "mismatch") {
        return { ...payload, promptId: `${payload.promptId}-changed` };
      }
      return payload;
    },
    deliveryBindings: {
      allocateChatMessageId() {
        state.messageCounter += 1;
        return `M${String(state.messageCounter).padStart(15, "0")}`;
      },
      findChatMessage(messageId) {
        return chatMessages.get(messageId) ?? null;
      },
      async createChatMessage(data) {
        const runId =
          data.flags["infinity-dnd5e"].resourceOperationDelivery.runId;
        trace.push(`effect:report:${runId}`);
        chatMessages.set(data._id, structuredClone(data));
        return chatMessages.get(data._id);
      },
      async emitResourceEvent(type, payload) {
        trace.push(`effect:ack:${payload.runId}:${payload.promptId}`);
        return {
          ...structuredClone(payload),
          type,
          originUserId: "gm-1",
        };
      },
      isAuthorityCurrent: () => state.deliveryAuthority,
      now: () => state.clock,
    },
  });

  return {
    actor,
    actors,
    chatMessages,
    coordinator,
    domain,
    promptFrames,
    state,
    store,
    trace,
  };
}

async function within(promise, milliseconds = 1000) {
  let timeout = null;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timeout = setTimeout(
          () => reject(new Error("coordinator call timed out")),
          milliseconds,
        );
      }),
    ]);
  } finally {
    clearTimeout(timeout);
  }
}

function indexOfPrefix(trace, prefix, from = 0) {
  const index = trace.findIndex(
    (entry, position) => position >= from && entry.startsWith(prefix),
  );
  assert.ok(index >= 0, `missing trace entry ${prefix}\n${trace.join("\n")}`);
  return index;
}

function ackConfirmation(record, userId) {
  const delivery = record.outbox.entries.find(
    (entry) => entry.state === "pending" && entry.kind === "prompt-ack",
  );
  assert.ok(delivery);
  return {
    type: "resource:ack-delivery-confirm",
    runId: record.runId,
    actorId: delivery.payload.actorId,
    promptId: delivery.promptId,
    deliveryId: delivery.deliveryId,
    originUserId: userId,
  };
}

/* Claim and prompting checkpoints always precede replayable prompt effects. */
{
  const harness = makeHarness();
  harness.state.clock = 1000;
  const prompts = [
    {
      promptId: "prompt-a",
      actorId: "forager-a",
      userId: "player-a",
      forageTarget: "food",
      deadlineAt: 1010,
    },
    {
      promptId: "prompt-b",
      actorId: "forager-b",
      userId: "player-b",
      forageTarget: "food",
      deadlineAt: 1010,
    },
  ];
  const started = await harness.coordinator.startOperation(
    operationInput({
      runId: "prompt-run",
      clock: 1000,
      scenario: "prompt",
      prompts,
    }),
  );
  assert.equal(started.active.action, "wait-for-prompts");
  const claim = indexOfPrefix(harness.trace, "store:claim:prompt-run");
  const prompting = indexOfPrefix(
    harness.trace,
    "store:transition:prompting:prompt-run",
  );
  const firstPrompt = indexOfPrefix(harness.trace, "effect:prompt:prompt-a");
  assert.ok(claim < prompting && prompting < firstPrompt);

  harness.state.clock = 1001;
  await harness.coordinator.recover("same-authority-reload");
  assert.equal(
    harness.promptFrames.filter((frame) => frame.promptId === "prompt-a")
      .length,
    2,
    "recovery replays the persisted prompt identity",
  );

  harness.state.clock = 1002;
  await harness.coordinator.acceptPromptResult({
    runId: "prompt-run",
    promptId: "prompt-a",
    actorId: "forager-a",
    originUserId: "player-a",
    rollTotal: 8,
    skipped: false,
  });
  assert.equal(harness.state.active.prompts.responses.length, 1);
  assert.equal(harness.state.active.phase, "prompting");

  harness.state.clock = 1003;
  const synced = await harness.coordinator.syncPlayerPrompt({
    originUserId: "player-a",
  });
  assert.equal(synced.promptCount, 1);
  assert.equal(harness.promptFrames.at(-1).promptId, "prompt-a");
  assert.equal(harness.promptFrames.at(-1).responseAccepted, true);

  harness.state.clock = 1010;
  await harness.coordinator.recordPromptTimeout("prompt-b", {
    runId: "prompt-run",
    at: 1010,
  });
  const responseIndex = indexOfPrefix(harness.trace, "store:response:prompt-a");
  const timeoutIndex = indexOfPrefix(harness.trace, "store:timeout:prompt-b");
  const plannedIndex = indexOfPrefix(
    harness.trace,
    "store:transition:planned:prompt-run",
  );
  const completedIndex = indexOfPrefix(
    harness.trace,
    "store:complete:prompt-run",
  );
  const reportIndex = indexOfPrefix(harness.trace, "effect:report:prompt-run");
  assert.ok(responseIndex < plannedIndex);
  assert.ok(timeoutIndex < plannedIndex);
  assert.ok(plannedIndex < completedIndex && completedIndex < reportIndex);
  assert.equal(harness.state.active, null);
  assert.equal(harness.state.recentRuns.length, 1);

  let terminal = harness.state.outbox[0];
  assert.equal(
    terminal.outbox.entries.find((entry) => entry.kind === "report").state,
    "delivered",
  );
  assert.equal(
    terminal.outbox.entries.filter(
      (entry) => entry.kind === "prompt-ack" && entry.state === "pending",
    ).length,
    2,
  );

  harness.state.clock = 1011;
  await harness.coordinator.confirmPromptDelivery(
    ackConfirmation(terminal, "player-a"),
  );
  terminal = harness.state.outbox[0];
  assert.equal(
    terminal.outbox.entries.filter(
      (entry) => entry.kind === "prompt-ack" && entry.state === "delivered",
    ).length,
    1,
  );

  harness.state.clock = 1012;
  await harness.coordinator.confirmPromptDelivery(
    ackConfirmation(terminal, "player-b"),
  );
  assert.equal(harness.state.outbox.length, 0);
  assert.ok(
    indexOfPrefix(harness.trace, "effect:ack:prompt-run:prompt-a") <
      indexOfPrefix(harness.trace, "effect:ack:prompt-run:prompt-b"),
  );
}

/* One prompting timestamp survives an incrementing clock; timeout zero is exact. */
{
  let observedClock = 6999;
  const harness = makeHarness({
    now: () => ++observedClock,
  });
  harness.state.clock = 7000;
  harness.state.terminalPersistResult = false;
  const started = await harness.coordinator.startOperation(
    operationInput({
      runId: "zero-timeout-forage",
      clock: 7000,
      scenario: "zero-timeout",
      prompts: [
        {
          promptId: "prompt-zero-timeout",
          actorId: "forager-a",
          userId: "player-a",
          forageTarget: "food",
          timeoutMs: 0,
        },
      ],
    }),
  );
  assert.equal(started.active.action, "wait-for-prompts");
  assert.deepEqual(harness.state.promptAssignmentTimes, [7000]);
  assert.equal(harness.state.active.timestamps.promptingAt, 7000);
  assert.equal(harness.state.active.prompts.assignments[0].assignedAt, 7000);
  assert.equal(harness.state.active.prompts.assignments[0].deadlineAt, 7000);

  const resumed = await harness.coordinator.resume("timeout-zero");
  assert.equal(resumed.active.action, "completed");
  assert.equal(harness.state.active, null);
  assert.equal(harness.state.completionRequests.length, 1);
  assert.equal(
    harness.state.completionRequests[0].persistResult,
    false,
    "forage terminal artifacts preserve the latest upkeep result",
  );
}

/* Rejected prompt sends remain durably replayable on an ordinary resume. */
for (const [index, failure] of ["null", "throw", "mismatch"].entries()) {
  const harness = makeHarness();
  const clock = 1500 + index * 20;
  const promptId = `prompt-rejected-${failure}`;
  const runId = `prompt-rejected-${failure}-run`;
  harness.state.clock = clock;
  harness.state.promptEmissionFailure = failure;
  const rejected = await harness.coordinator.startOperation(
    operationInput({
      runId,
      clock,
      scenario: `prompt-rejected-${failure}`,
      prompts: [
        {
          promptId,
          actorId: "forager-a",
          userId: "player-a",
          forageTarget: "food",
          deadlineAt: clock + 10,
        },
      ],
    }),
  );
  assert.equal(rejected.active.action, "retry");
  assert.equal(rejected.active.reason, "persisted-prompt-emission-failed");
  assert.equal(harness.state.active.phase, "prompting");

  harness.state.promptEmissionFailure = null;
  harness.state.clock = clock + 1;
  const replayed = await harness.coordinator.resume("retry-rejected-prompt");
  assert.equal(replayed.active.action, "wait-for-prompts");
  assert.equal(
    harness.promptFrames.filter((frame) => frame.promptId === promptId).length,
    2,
  );
}

/* Awaited callback reentry fails fast instead of deadlocking the queue tail. */
{
  let reentryError = null;
  const harness = makeHarness({
    async onEmitPrompt(_payload, getCoordinator) {
      try {
        await getCoordinator().resume("reentered-from-prompt-binding");
      } catch (error) {
        reentryError = error;
      }
    },
  });
  harness.state.clock = 1600;
  const started = await within(
    harness.coordinator.startOperation(
      operationInput({
        runId: "callback-reentry",
        clock: 1600,
        scenario: "callback-reentry",
        prompts: [
          {
            promptId: "prompt-reentry",
            actorId: "forager-a",
            userId: "player-a",
            forageTarget: "food",
            deadlineAt: 1610,
          },
        ],
      }),
    ),
  );
  assert.equal(started.active.action, "wait-for-prompts");
  assert.ok(reentryError instanceof ResourceOperationCoordinatorError);
  assert.equal(reentryError.code, "RESOURCE_COORDINATOR_REENTRANT_CALL");
}

/* Plan/applying checkpoints and each durable marker precede later effects. */
{
  const harness = makeHarness();
  harness.state.clock = 2000;
  await harness.coordinator.startOperation(
    operationInput({
      runId: "inventory-run",
      clock: 2000,
      consumeAmount: 2,
    }),
  );
  assert.equal(harness.actor.items.get("food-stack").system.quantity, 2);
  assert.equal(harness.actor.writes, 1);
  const planned = indexOfPrefix(
    harness.trace,
    "store:transition:planned:inventory-run",
  );
  const applying = indexOfPrefix(
    harness.trace,
    "store:transition:applying:inventory-run",
  );
  const assertion = indexOfPrefix(
    harness.trace,
    "store:assert-current:inventory-run",
  );
  const write = indexOfPrefix(harness.trace, "effect:inventory:update");
  const marker = indexOfPrefix(harness.trace, "store:inventory-marker:");
  const terminal = indexOfPrefix(
    harness.trace,
    "domain:terminal-artifacts:inventory-run",
  );
  const completed = indexOfPrefix(
    harness.trace,
    "store:complete:inventory-run",
  );
  const report = indexOfPrefix(harness.trace, "effect:report:inventory-run");
  assert.ok(planned < applying);
  assert.ok(applying < assertion && assertion < write);
  assert.ok(write < marker && marker < terminal);
  assert.ok(terminal < completed && completed < report);
  assert.equal(harness.state.outbox.length, 0);
}

/* A server-applied write that throws is marked from canonical readback once. */
{
  const harness = makeHarness({
    actorOptions: { behavior: "throw-after" },
  });
  harness.state.clock = 3000;
  await harness.coordinator.startOperation(
    operationInput({
      runId: "applied-then-threw",
      clock: 3000,
      consumeAmount: 2,
    }),
  );
  assert.equal(harness.actor.writes, 1);
  assert.equal(harness.actor.items.get("food-stack").system.quantity, 2);
  assert.equal(
    harness.trace.filter((entry) => entry.startsWith("store:inventory-marker:"))
      .length,
    1,
  );
  assert.equal(harness.state.active, null);
}

/* An unexpected canonical third state is durably quarantined. */
{
  const harness = makeHarness({
    actorOptions: { behavior: "third-state" },
  });
  harness.state.clock = 4000;
  const outcome = await harness.coordinator.startOperation(
    operationInput({
      runId: "third-state",
      clock: 4000,
      consumeAmount: 2,
    }),
  );
  assert.equal(outcome.active.action, "needs-review");
  assert.equal(harness.state.active.phase, "needs-review");
  assert.equal(harness.state.active.review.code, "canonical-third-state");
  assert.equal(harness.state.recentRuns.length, 0);
  assert.equal(
    harness.trace.some((entry) => entry.startsWith("effect:report:")),
    false,
  );
}

/* Missing canonical Actor/Resource bindings pin review before any Actor write. */
for (const missing of ["actor", "resource"]) {
  const harness = makeHarness();
  harness.state.clock = missing === "actor" ? 4200 : 4300;
  if (missing === "actor") {
    harness.domain.resolveActors = async () => new Map();
  } else {
    harness.domain.resolveResources = async () => [];
  }
  const outcome = await harness.coordinator.startOperation(
    operationInput({
      runId: `missing-${missing}`,
      clock: harness.state.clock,
      consumeAmount: 2,
    }),
  );
  assert.equal(outcome.active.action, "needs-review");
  assert.equal(harness.state.active.phase, "needs-review");
  assert.equal(
    harness.state.active.review.code,
    "resource-inventory-observe-before-write-failed",
  );
  assert.equal(
    harness.state.active.review.evidence.error.code,
    missing === "actor"
      ? "RESOURCE_INVENTORY_ACTOR_MISSING"
      : "RESOURCE_INVENTORY_RESOURCE_MISSING",
  );
  assert.ok(harness.state.active.review.reason.length <= 1600);
  assert.ok(harness.state.active.review.evidence.error.message.length <= 1000);
  assert.equal(harness.actor.writes, 0);
  assert.equal(
    harness.trace.some((entry) => entry.startsWith("effect:inventory:")),
    false,
  );
  assert.equal(
    harness.trace.some((entry) => entry.startsWith("effect:report:")),
    false,
  );
}

/* Active applying handoff reconciles a crash-gap after-state without rewriting. */
{
  const harness = makeHarness({
    actorOptions: { behavior: "no-change-throw" },
  });
  harness.state.clock = 5000;
  const first = await harness.coordinator.startOperation(
    operationInput({
      runId: "active-adoption",
      clock: 5000,
      consumeAmount: 2,
    }),
  );
  assert.equal(first.active.action, "retry");
  assert.equal(harness.state.active.phase, "applying");
  assert.equal(harness.actor.writes, 1);

  // Model a process death after the server commit but before local readback.
  harness.actor.items.get("food-stack").system.quantity = 2;
  harness.state.guard = guard(2);
  harness.state.clock = 5001;
  await harness.coordinator.recover("new-tab-leader");
  assert.equal(
    harness.actor.writes,
    1,
    "adoption advanced the landed operation",
  );
  assert.equal(harness.state.active, null);
  assert.ok(
    indexOfPrefix(harness.trace, "store:adopt:active:active-adoption") <
      indexOfPrefix(harness.trace, "store:complete:active-adoption"),
  );
}

/* A one-step budget permits no-op planning through one FIFO report delivery. */
{
  const harness = makeHarness({ maxSteps: 1 });
  harness.state.clock = 5450;
  const completed = await harness.coordinator.startOperation(
    operationInput({ runId: "one-step-no-op", clock: 5450 }),
  );
  assert.equal(completed.active.action, "completed");
  assert.equal(completed.delivery.action, "idle");
  assert.equal(harness.actor.writes, 0);
  assert.equal(harness.state.active, null);
  assert.equal(harness.state.outbox.length, 0);
  assert.equal(
    harness.trace.filter((entry) =>
      entry.startsWith("effect:report:one-step-no-op"),
    ).length,
    1,
  );
}

/* The same boundary permits one inventory write and its terminal delivery. */
{
  const harness = makeHarness({ maxSteps: 1 });
  harness.state.clock = 5500;
  const completed = await harness.coordinator.startOperation(
    operationInput({
      runId: "one-step-boundary",
      clock: 5500,
      consumeAmount: 2,
    }),
  );
  assert.equal(completed.active.action, "completed");
  assert.equal(completed.delivery.action, "idle");
  assert.equal(harness.actor.writes, 1);
  assert.equal(harness.state.active, null);
  assert.equal(harness.state.outbox.length, 0);
  assert.equal(
    harness.trace.filter((entry) =>
      entry.startsWith("effect:report:one-step-boundary"),
    ).length,
    1,
  );
}

/* Configurable work budgets cannot bypass the coordinator hard ceiling. */
{
  assert.throws(
    () => makeHarness({ maxSteps: 4097 }),
    (error) =>
      error instanceof ResourceOperationCoordinatorError &&
      error.code === "RESOURCE_COORDINATOR_INVALID_BINDINGS",
  );
}

/* Terminal records adopt at the FIFO head and drain strictly in completion order. */
{
  const harness = makeHarness({ deliveryAuthority: false });
  harness.state.clock = 6000;
  await harness.coordinator.startOperation(
    operationInput({ runId: "fifo-one", clock: 6000 }),
  );
  harness.state.clock = 6001;
  await harness.coordinator.startOperation(
    operationInput({ runId: "fifo-two", clock: 6001 }),
  );
  assert.deepEqual(
    harness.state.outbox.map((record) => record.runId),
    ["fifo-one", "fifo-two"],
  );
  assert.equal(
    harness.trace.some((entry) => entry.startsWith("effect:report:fifo")),
    false,
  );

  harness.state.guard = guard(2);
  harness.state.deliveryAuthority = true;
  harness.state.clock = 6002;
  await harness.coordinator.recover("delivery-handoff");
  assert.equal(harness.state.outbox.length, 0);
  const adoptOne = indexOfPrefix(harness.trace, "store:adopt:outbox:fifo-one");
  const reportOne = indexOfPrefix(harness.trace, "effect:report:fifo-one");
  const adoptTwo = indexOfPrefix(harness.trace, "store:adopt:outbox:fifo-two");
  const reportTwo = indexOfPrefix(harness.trace, "effect:report:fifo-two");
  assert.ok(
    adoptOne < reportOne && reportOne < adoptTwo && adoptTwo < reportTwo,
  );
}

/* An external call arriving during delayed I/O queues without false reentry. */
{
  let firstLoad = true;
  let signalEntered = null;
  let releaseLoad = null;
  const entered = new Promise((resolve) => {
    signalEntered = resolve;
  });
  const blocked = new Promise((resolve) => {
    releaseLoad = resolve;
  });
  const harness = makeHarness({
    async onLoadActive() {
      if (!firstLoad) return;
      firstLoad = false;
      signalEntered();
      await blocked;
    },
  });
  const first = harness.coordinator.resume("delayed-load-a");
  await entered;
  const second = harness.coordinator.recover("delayed-load-b");
  releaseLoad();
  const outcomes = await Promise.all([first, second]);
  assert.deepEqual(
    outcomes.map((entry) => entry.action),
    ["idle", "idle"],
  );
  assert.equal(harness.state.maxLoadDepth, 1);
}

process.stdout.write("resource-operation-coordinator validation passed\n");
