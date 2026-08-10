/**
 * Infinity D&D5e - durable Quartermaster operation coordinator
 *
 * This module owns ordering, never persistence. Every checkpoint is delegated
 * to the injected v5 Resource store, while the pure ledger, one-write inventory
 * executor, and one-delivery service decide what is safe to do next.
 * Injected bindings are a trusted, non-reentrant boundary: they must resolve
 * before calling a public coordinator method. Obvious same-stack violations
 * are rejected; browser code cannot distinguish post-await self-reentry from a
 * legitimate external event arriving while an injected promise is pending.
 */

import {
  decideResourceOperation,
  normalizeResourceOperation,
} from "./operation-ledger.js";
import {
  buildResourceInventoryPlan,
  executeResourceInventoryOperation,
  observeResourceInventoryOperation,
} from "./operation-inventory.js";
import { createResourceOperationDeliveryService } from "./operation-delivery.js";

const DEFAULT_MAX_STEPS = 4096;
const HARD_MAX_STEPS = 4096;
const MAX_DECISION_STEPS = HARD_MAX_STEPS * 4 + 32;

export class ResourceOperationCoordinatorError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "ResourceOperationCoordinatorError";
    this.code = code;
  }
}

/**
 * Create one locally serialized operation driver.
 *
 * Required store bindings match the v5 contract. Domain callbacks are fixed
 * for the lifetime of the coordinator so restart/recovery never depends on a
 * closure captured by the call that originally started a run. No injected
 * binding may call or await a public coordinator method before it resolves.
 */
export function createResourceOperationCoordinator(bindings = {}) {
  const reentryGuard = createSynchronousReentryGuard();
  const runtime = normalizeBindings(bindings, reentryGuard);
  let queueTail = Promise.resolve();

  const enqueue = (work) => {
    if (reentryGuard.isActive()) {
      return Promise.reject(
        new ResourceOperationCoordinatorError(
          "RESOURCE_COORDINATOR_REENTRANT_CALL",
          "An injected Resource callback cannot await a coordinator method",
        ),
      );
    }
    const current = queueTail.then(work, work);
    queueTail = current.then(
      () => undefined,
      () => undefined,
    );
    return current;
  };

  return Object.freeze({
    startOperation(input = {}) {
      return enqueue(async () => {
        const claimed = normalizeResourceOperation(
          await runtime.store.claimResourceOperation(input),
        );
        if (claimed.phase !== "prepared") {
          fail(
            "RESOURCE_COORDINATOR_INVALID_CLAIM",
            "A new Resource claim must persist in the prepared phase",
          );
        }
        return runCoordinator(runtime, {
          reason: "start",
          replayPrompts: false,
        });
      });
    },

    resume(reason = "resume") {
      return enqueue(() =>
        runCoordinator(runtime, {
          reason: boundedReason(reason),
          replayPrompts: true,
        }),
      );
    },

    recover(reason = "authority-recovery") {
      return enqueue(() =>
        runCoordinator(runtime, {
          reason: boundedReason(reason),
          replayPrompts: true,
        }),
      );
    },

    acceptPromptResult(payload = {}) {
      return enqueue(() => acceptPromptResult(runtime, payload));
    },

    recordPromptTimeout(promptId, options = {}) {
      return enqueue(() => recordPromptTimeout(runtime, promptId, options));
    },

    syncPlayerPrompt(payload = {}) {
      return enqueue(() => syncPlayerPrompt(runtime, payload));
    },

    confirmPromptDelivery(payload = {}) {
      return enqueue(() => confirmPromptDelivery(runtime, payload));
    },
  });
}

async function runCoordinator(runtime, { reason, replayPrompts }) {
  const active = await driveActiveOperation(runtime, {
    reason,
    replayPrompts,
  });
  const delivery = await drainDeliveryBacklog(runtime);
  return result(
    active.action === "no-active" ? delivery.action : active.action,
    {
      active,
      delivery,
    },
  );
}

async function driveActiveOperation(runtime, { reason, replayPrompts }) {
  let shouldReplayPrompts = replayPrompts;
  let inventorySteps = 0;
  for (
    let decisionStep = 0;
    decisionStep < MAX_DECISION_STEPS;
    decisionStep += 1
  ) {
    let record = await loadActive(runtime);
    if (!record) return result("no-active", { reason });

    const guard = await currentGuard(runtime);
    let decision = decideResourceOperation(record, { guard });
    if (decision.action === "adopt-authority") {
      const adopted = await adoptOperationAuthority(runtime, record, {
        location: "active",
        guard,
      });
      if (!isOperationRecord(adopted)) return adopted;
      record = adopted;
      decision = decideResourceOperation(record, { guard });
      shouldReplayPrompts = true;
    }

    if (decision.action === "needs-review") {
      return result("needs-review", {
        reason: decision.reason,
        runId: record.runId,
        operationId: decision.operationId,
      });
    }

    if (decision.action === "prompt-or-plan") {
      const assignments = stampPromptAssignments(
        await runtime.domain.buildPromptAssignments(record),
        checkpointTime(runtime, record),
      );
      if (assignments.length > 0) {
        const prompting = await checkpointTransition(
          runtime,
          record,
          "prompting",
          {
            assignments,
          },
        );
        const emitted = await emitAssignments(runtime, prompting, assignments, {
          responseAccepted: false,
        });
        if (emitted.action !== "emitted") return emitted;
        return result("wait-for-prompts", {
          reason: "prompting-checkpoint-persisted",
          runId: prompting.runId,
          pendingPromptIds: assignments.map((entry) => entry.promptId),
        });
      }
      await checkpointPlan(runtime, record, guard);
      continue;
    }

    if (decision.action === "wait-for-prompts") {
      record = await checkpointExpiredPrompts(runtime, record, guard);
      decision = decideResourceOperation(record, { guard });
      if (decision.action === "plan") {
        await checkpointPlan(runtime, record, guard);
        continue;
      }
      if (shouldReplayPrompts) {
        const replayed = await replayActivePrompts(runtime, record);
        if (replayed.action !== "emitted") return replayed;
        shouldReplayPrompts = false;
      }
      return result("wait-for-prompts", {
        reason: "persisted-prompts-pending",
        runId: record.runId,
        pendingPromptIds: decideResourceOperation(record, { guard })
          .pendingPromptIds,
      });
    }

    if (decision.action === "plan") {
      await checkpointPlan(runtime, record, guard);
      continue;
    }

    if (decision.action === "begin-applying") {
      await checkpointTransition(runtime, record, "applying");
      continue;
    }

    if (decision.action === "reconcile") {
      if (inventorySteps >= runtime.maxSteps) {
        stepLimit("Resource inventory");
      }
      inventorySteps += 1;
      const inventory = await executeNextInventoryOperation(
        runtime,
        record,
        decision.operationId,
        guard,
      );
      if (inventory.action === "continue") continue;
      return inventory;
    }

    if (decision.action === "finalize") {
      const artifacts = await runtime.domain.buildTerminalArtifacts(record);
      assertPlainObject(artifacts, "terminal artifacts");
      const at = checkpointTime(runtime, record);
      const terminalRecord = runtime.delivery.prepareTerminalRecord(record, {
        guard,
        at,
        report: artifacts.report,
        receipt: artifacts.receipt,
        chat: artifacts.chat,
        reportRecipientId: artifacts.reportRecipientId,
      });
      await runtime.store.completeResourceOperation({
        operationId: record.operationId,
        runId: record.runId,
        guard,
        at,
        terminalRecord,
        result: artifacts.result ?? artifacts.report,
        receipt: artifacts.receipt,
      });
      return result("completed", {
        reason: "terminal-record-persisted-before-delivery",
        runId: record.runId,
      });
    }

    if (decision.action === "replay") {
      return result("replay", {
        reason: decision.reason,
        runId: record.runId,
        receipt: decision.receipt,
      });
    }

    fail(
      "RESOURCE_COORDINATOR_UNSUPPORTED_DECISION",
      `Unsupported active operation decision ${decision.action}`,
    );
  }
  stepLimit("Resource operation decision loop");
}

async function acceptPromptResult(runtime, payload) {
  const record = await loadActive(runtime);
  if (!record) return result("ignored", { reason: "no-active-operation" });
  if (String(payload?.runId ?? "") !== record.runId) {
    return result("ignored", { reason: "prompt-run-mismatch" });
  }
  const guard = await currentGuard(runtime);
  const adopted = await ensureActiveAuthority(runtime, record, guard);
  if (!isOperationRecord(adopted)) return adopted;
  const response = await runtime.domain.normalizePromptResponse(
    adopted,
    payload,
  );
  assertPlainObject(response, "normalized prompt response");
  const checkpoint = normalizeResourceOperation(
    await runtime.store.recordResourcePromptResponse(adopted.runId, response, {
      guard,
      at: checkpointTime(runtime, adopted),
    }),
  );
  if (
    !checkpoint.prompts.responses.some(
      (entry) => entry.promptId === response.promptId,
    )
  ) {
    checkpointRejected("prompt response");
  }
  return runCoordinator(runtime, {
    reason: "prompt-response",
    replayPrompts: false,
  });
}

async function recordPromptTimeout(runtime, promptId, options) {
  const record = await loadActive(runtime);
  if (!record) return result("ignored", { reason: "no-active-operation" });
  if (options.runId != null && String(options.runId ?? "") !== record.runId) {
    return result("ignored", { reason: "prompt-run-mismatch" });
  }
  const guard = await currentGuard(runtime);
  const adopted = await ensureActiveAuthority(runtime, record, guard);
  if (!isOperationRecord(adopted)) return adopted;
  const timeoutId = String(promptId ?? "");
  const checkpoint = normalizeResourceOperation(
    await runtime.store.recordResourcePromptTimeout(adopted.runId, timeoutId, {
      guard,
      at: explicitOrCheckpointTime(options.at, runtime, adopted),
    }),
  );
  if (
    !checkpoint.prompts.timeouts.some((entry) => entry.promptId === timeoutId)
  ) {
    checkpointRejected("prompt timeout");
  }
  return runCoordinator(runtime, {
    reason: "prompt-timeout",
    replayPrompts: false,
  });
}

async function syncPlayerPrompt(runtime, payload) {
  const requestedUserId = String(
    payload?.originUserId ?? payload?.userId ?? "",
  ).trim();
  if (!requestedUserId) {
    return result("ignored", { reason: "prompt-sync-user-missing" });
  }
  let count = 0;
  let record = await loadActive(runtime);
  if (record) {
    const guard = await currentGuard(runtime);
    const adopted = await ensureActiveAuthority(runtime, record, guard);
    if (!isOperationRecord(adopted)) return adopted;
    record = adopted;
    if (record.phase === "prompting") {
      const resolved = new Set([
        ...record.prompts.responses.map((entry) => entry.promptId),
        ...record.prompts.timeouts.map((entry) => entry.promptId),
      ]);
      for (const assignment of record.prompts.assignments) {
        if (
          assignment.userId !== requestedUserId ||
          record.prompts.timeouts.some(
            (entry) => entry.promptId === assignment.promptId,
          )
        ) {
          continue;
        }
        await emitAssignment(runtime, record, assignment, {
          responseAccepted: resolved.has(assignment.promptId),
        });
        count += 1;
      }
    }
  }
  const delivery = await drainDeliveryBacklog(runtime);
  return result(count > 0 ? "emitted" : delivery.action, {
    reason: count > 0 ? "persisted-prompt-state-replayed" : delivery.reason,
    promptCount: count,
    delivery,
  });
}

async function confirmPromptDelivery(runtime, payload) {
  let records = await pendingDeliveryRecords(runtime);
  if (records.length === 0) {
    return result("ignored", { reason: "delivery-backlog-empty" });
  }
  let record = records[0];
  if (String(payload?.runId ?? "") !== record.runId) {
    return result("ignored", { reason: "delivery-confirmation-out-of-order" });
  }
  const guard = await currentGuard(runtime);
  const adopted = await ensureOutboxAuthority(runtime, record, guard);
  if (!isOperationRecord(adopted)) return adopted;
  record = adopted;
  const confirmation = runtime.delivery.confirmPromptAcknowledgement(
    record,
    payload,
    {
      guard,
      at: checkpointTime(runtime, record),
    },
  );
  if (confirmation.action === "delivered") {
    await runtime.store.markResourceOperationDeliveryDelivered({
      operationId: record.operationId,
      runId: record.runId,
      deliveryId: confirmation.deliveryId,
      guard,
      updatedRecord: confirmation.updatedRecord,
    });
    const delivery = await drainDeliveryBacklog(runtime);
    return result("delivered", { confirmation, delivery });
  }
  if (confirmation.action === "already-confirmed") {
    const delivery = await drainDeliveryBacklog(runtime);
    return result("already-confirmed", { confirmation, delivery });
  }
  return confirmation;
}

async function checkpointPlan(runtime, record, guard) {
  const prepared = await runtime.domain.preparePlan(record);
  assertPlainObject(prepared, "prepared operation plan");
  assertPlainObject(prepared.inventory, "prepared inventory input");
  const plan = await runtime.invoke(() =>
    buildResourceInventoryPlan({
      ...prepared.inventory,
      runId: record.runId,
    }),
  );
  return checkpointTransition(runtime, record, "planned", {
    guard,
    yields: prepared.yields ?? [],
    operations: plan.operations,
  });
}

async function checkpointExpiredPrompts(runtime, initial, guard) {
  let record = initial;
  const observedNow = observedTime(runtime);
  const resolved = new Set([
    ...record.prompts.responses.map((entry) => entry.promptId),
    ...record.prompts.timeouts.map((entry) => entry.promptId),
  ]);
  for (const assignment of record.prompts.assignments) {
    if (resolved.has(assignment.promptId)) continue;
    if (assignment.deadlineAt > observedNow) continue;
    record = normalizeResourceOperation(
      await runtime.store.recordResourcePromptTimeout(
        record.runId,
        assignment.promptId,
        {
          guard,
          at: Math.max(observedNow, assignment.deadlineAt),
        },
      ),
    );
    if (
      !record.prompts.timeouts.some(
        (entry) => entry.promptId === assignment.promptId,
      )
    ) {
      checkpointRejected("prompt timeout");
    }
    resolved.add(assignment.promptId);
  }
  return record;
}

async function executeNextInventoryOperation(
  runtime,
  record,
  operationId,
  guard,
) {
  const actors = await runtime.domain.resolveActors(record);
  const resources = await runtime.domain.resolveResources(record);
  const executed = await runtime.invoke(() =>
    executeResourceInventoryOperation({
      record,
      operationId,
      guard,
      actors,
      resources,
      assertWriteAllowed: () =>
        runtime.store.assertResourceOperationCurrent(record.runId, guard),
    }),
  );

  if (executed.action === "mark-applied") {
    const checkpoint = normalizeResourceOperation(
      await runtime.store.markResourceInventoryOperationApplied(
        record.runId,
        operationId,
        {
          guard,
          at: checkpointTime(runtime, record),
          observed: executed.after,
        },
      ),
    );
    if (!checkpoint.appliedOperationIds.includes(operationId)) {
      checkpointRejected("inventory marker");
    }
    return result("continue", {
      reason: "inventory-marker-persisted",
      operationId,
    });
  }
  if (executed.action === "already-applied") {
    return result("continue", {
      reason: "inventory-marker-already-present",
      operationId,
    });
  }
  if (executed.action === "apply") {
    return result("retry", {
      reason: "inventory-remains-at-canonical-before-state",
      runId: record.runId,
      operationId,
      writeError: errorMessage(executed.writeError),
    });
  }
  if (executed.action === "needs-review") {
    const reason = String(executed.reason ?? "inventory-needs-review");
    await checkpointTransition(runtime, record, "needs-review", {
      guard,
      code: reason,
      reason,
      operationId,
      evidence: {
        before: executed.before,
        after: executed.after,
        writeError: errorMessage(executed.writeError),
      },
    });
    return result("needs-review", {
      reason,
      runId: record.runId,
      operationId,
    });
  }
  fail(
    "RESOURCE_COORDINATOR_UNSUPPORTED_INVENTORY_RESULT",
    `Unsupported inventory result ${executed.action}`,
  );
}

async function drainDeliveryBacklog(runtime) {
  let deliverySteps = 0;
  for (
    let decisionStep = 0;
    decisionStep < MAX_DECISION_STEPS;
    decisionStep += 1
  ) {
    const records = await pendingDeliveryRecords(runtime);
    if (records.length === 0) {
      return result("idle", { reason: "delivery-backlog-empty" });
    }
    let record = records[0];
    const guard = await currentGuard(runtime);
    const adopted = await ensureOutboxAuthority(runtime, record, guard);
    if (!isOperationRecord(adopted)) return adopted;
    record = adopted;

    if (deliverySteps >= runtime.maxSteps) {
      stepLimit("Resource delivery");
    }
    deliverySteps += 1;
    const delivery = await runtime.delivery.drainNextDelivery(record, {
      guard,
      at: checkpointTime(runtime, record),
    });
    if (delivery.action === "delivered") {
      await runtime.store.markResourceOperationDeliveryDelivered({
        operationId: record.operationId,
        runId: record.runId,
        deliveryId: delivery.deliveryId,
        guard,
        updatedRecord: delivery.updatedRecord,
      });
      continue;
    }
    if (delivery.action === "idle") {
      fail(
        "RESOURCE_COORDINATOR_INVALID_BACKLOG",
        "A persisted terminal backlog entry has no pending delivery",
      );
    }
    return delivery;
  }
  stepLimit("Resource delivery decision loop");
}

async function ensureActiveAuthority(runtime, record, guard) {
  const decision = decideResourceOperation(record, { guard });
  return decision.action === "adopt-authority"
    ? adoptOperationAuthority(runtime, record, { location: "active", guard })
    : record;
}

async function ensureOutboxAuthority(runtime, record, guard) {
  const decision = decideResourceOperation(record, { guard });
  return decision.action === "adopt-authority"
    ? adoptOperationAuthority(runtime, record, { location: "outbox", guard })
    : record;
}

async function adoptOperationAuthority(runtime, record, { location, guard }) {
  const observations = [];
  let contextSnapshot = null;
  if (location === "active") {
    contextSnapshot = await runtime.domain.captureCurrentContext(record);
    assertPlainObject(contextSnapshot, "current operation context");
    if (record.phase === "planned" || record.phase === "applying") {
      const actors = await runtime.domain.resolveActors(record);
      const resources = await runtime.domain.resolveResources(record);
      const seen = new Set();
      for (const operation of record.plan) {
        const key = JSON.stringify([operation.actorId, operation.itemId]);
        if (seen.has(key)) continue;
        seen.add(key);
        observations.push({
          actorId: operation.actorId,
          itemId: operation.itemId,
          ...observeResourceInventoryOperation(operation, {
            actors,
            resources,
          }),
        });
      }
    }
  }
  const adopted = await runtime.store.adoptResourceOperationAuthority({
    location,
    operationId: record.operationId,
    runId: record.runId,
    nextGuard: guard,
    contextSnapshot,
    observations,
    at: checkpointTime(runtime, record),
  });
  if (isOperationRecord(adopted)) {
    return normalizeResourceOperation(adopted);
  }
  if (adopted?.action === "needs-review") return adopted;
  fail(
    "RESOURCE_COORDINATOR_INVALID_ADOPTION",
    "Authority adoption did not return a persisted operation record",
  );
}

async function replayActivePrompts(runtime, record) {
  const timedOut = new Set(
    record.prompts.timeouts.map((entry) => entry.promptId),
  );
  const answered = new Set(
    record.prompts.responses.map((entry) => entry.promptId),
  );
  const assignments = record.prompts.assignments.filter(
    (entry) => !timedOut.has(entry.promptId),
  );
  return emitAssignments(runtime, record, assignments, {
    responseAccepted: (assignment) => answered.has(assignment.promptId),
  });
}

async function emitAssignments(runtime, record, assignments, options = {}) {
  try {
    for (const assignment of assignments) {
      await emitAssignment(runtime, record, assignment, {
        responseAccepted:
          typeof options.responseAccepted === "function"
            ? options.responseAccepted(assignment)
            : options.responseAccepted === true,
      });
    }
  } catch (error) {
    return result("retry", {
      reason: "persisted-prompt-emission-failed",
      runId: record.runId,
      error: errorMessage(error),
    });
  }
  return result("emitted", {
    reason: "persisted-prompts-emitted",
    runId: record.runId,
    count: assignments.length,
  });
}

async function emitAssignment(
  runtime,
  record,
  assignment,
  { responseAccepted },
) {
  const projected = await runtime.domain.buildPromptPayload(record, assignment);
  assertPlainObject(projected, "prompt payload");
  const payload = {
    ...projected,
    runId: record.runId,
    promptId: assignment.promptId,
    actorId: assignment.actorId,
    targetUserId: assignment.userId,
    forageTarget: assignment.forageTarget,
    responseAccepted: responseAccepted === true,
  };
  const emitted = await runtime.emitPrompt(payload);
  assertAcceptedPromptEmission(emitted, payload);
  return emitted;
}

async function checkpointTransition(runtime, record, nextPhase, options = {}) {
  const guard = options.guard ?? (await currentGuard(runtime));
  const checkpoint = normalizeResourceOperation(
    await runtime.store.transitionResourceOperation(record.runId, nextPhase, {
      ...options,
      guard,
      at: options.at ?? checkpointTime(runtime, record),
    }),
  );
  if (checkpoint.phase !== nextPhase) {
    checkpointRejected(`phase ${nextPhase}`);
  }
  return checkpoint;
}

async function loadActive(runtime) {
  const record = await runtime.store.loadActiveResourceOperation();
  return record == null ? null : normalizeResourceOperation(record);
}

async function pendingDeliveryRecords(runtime) {
  const records = await runtime.store.listPendingResourceDeliveries();
  if (!Array.isArray(records)) {
    fail(
      "RESOURCE_COORDINATOR_INVALID_BACKLOG",
      "Pending Resource deliveries must be a FIFO array of terminal records",
    );
  }
  return records.map((record) => normalizeResourceOperation(record));
}

function stampPromptAssignments(assignments, assignedAt) {
  if (!Array.isArray(assignments)) {
    fail(
      "RESOURCE_COORDINATOR_INVALID_PROMPTS",
      "Prompt assignments must be an array",
    );
  }
  return assignments.map((assignment) => ({
    ...assignment,
    assignedAt,
  }));
}

async function currentGuard(runtime) {
  const guard = await runtime.currentGuard();
  assertPlainObject(guard, "current authority guard");
  return guard;
}

function checkpointTime(runtime, record) {
  return Math.max(observedTime(runtime), record.timestamps.updatedAt);
}

function explicitOrCheckpointTime(explicit, runtime, record) {
  if (explicit === undefined || explicit === null) {
    return checkpointTime(runtime, record);
  }
  const value = Number(explicit);
  if (!Number.isSafeInteger(value) || value < record.timestamps.updatedAt) {
    fail(
      "RESOURCE_COORDINATOR_INVALID_TIME",
      "Explicit checkpoint time must be a monotonic safe integer",
    );
  }
  return value;
}

function observedTime(runtime) {
  const value = Number(runtime.now());
  if (!Number.isSafeInteger(value) || value < 0) {
    fail(
      "RESOURCE_COORDINATOR_INVALID_TIME",
      "Coordinator clock must return a non-negative safe integer",
    );
  }
  return value;
}

function normalizeBindings(bindings, reentryGuard) {
  assertPlainObject(bindings, "coordinator bindings");
  const store = wrapMethods(
    bindings.store,
    "store",
    [
      "claimResourceOperation",
      "loadActiveResourceOperation",
      "transitionResourceOperation",
      "recordResourcePromptResponse",
      "recordResourcePromptTimeout",
      "markResourceInventoryOperationApplied",
      "adoptResourceOperationAuthority",
      "assertResourceOperationCurrent",
      "completeResourceOperation",
      "listPendingResourceDeliveries",
      "markResourceOperationDeliveryDelivered",
    ],
    reentryGuard,
  );
  const domain = wrapMethods(
    bindings.domain,
    "domain",
    [
      "captureCurrentContext",
      "buildPromptAssignments",
      "buildPromptPayload",
      "normalizePromptResponse",
      "preparePlan",
      "buildTerminalArtifacts",
      "resolveActors",
      "resolveResources",
    ],
    reentryGuard,
  );
  const currentGuardBinding = bindings.currentGuard;
  const emitPrompt = bindings.emitPrompt;
  if (typeof currentGuardBinding !== "function") {
    fail(
      "RESOURCE_COORDINATOR_INVALID_BINDINGS",
      "currentGuard must be a function",
    );
  }
  if (typeof emitPrompt !== "function") {
    fail(
      "RESOURCE_COORDINATOR_INVALID_BINDINGS",
      "emitPrompt must be a function",
    );
  }
  const now = bindings.now ?? (() => Date.now());
  if (typeof now !== "function") {
    fail("RESOURCE_COORDINATOR_INVALID_BINDINGS", "now must be a function");
  }
  const maxSteps = Number(bindings.maxSteps ?? DEFAULT_MAX_STEPS);
  if (
    !Number.isSafeInteger(maxSteps) ||
    maxSteps < 1 ||
    maxSteps > HARD_MAX_STEPS
  ) {
    fail(
      "RESOURCE_COORDINATOR_INVALID_BINDINGS",
      `maxSteps must be an integer from 1 through ${HARD_MAX_STEPS}`,
    );
  }
  const delivery = wrapMethods(
    bindings.deliveryService ??
      createResourceOperationDeliveryService(bindings.deliveryBindings),
    "delivery service",
    [
      "prepareTerminalRecord",
      "drainNextDelivery",
      "confirmPromptAcknowledgement",
    ],
    reentryGuard,
  );
  return Object.freeze({
    store,
    domain,
    currentGuard: (...args) =>
      reentryGuard.invoke(() => currentGuardBinding(...args)),
    emitPrompt: (...args) => reentryGuard.invoke(() => emitPrompt(...args)),
    now: (...args) => reentryGuard.invoke(() => now(...args)),
    invoke: (callback) => reentryGuard.invoke(callback),
    maxSteps,
    delivery,
  });
}

// This deliberately guards only the synchronous callback stack. Holding it
// across a returned promise would reject unrelated socket/UI work during I/O.
function createSynchronousReentryGuard() {
  let depth = 0;
  return Object.freeze({
    isActive: () => depth > 0,
    invoke(callback) {
      depth += 1;
      try {
        return callback();
      } finally {
        depth -= 1;
      }
    },
  });
}

function wrapMethods(value, label, methods, reentryGuard) {
  const source = requireMethods(value, label, methods);
  return Object.freeze(
    Object.fromEntries(
      methods.map((method) => [
        method,
        (...args) =>
          reentryGuard.invoke(() => source[method].apply(source, args)),
      ]),
    ),
  );
}

function requireMethods(value, label, methods) {
  assertPlainObject(value, `${label} bindings`);
  for (const method of methods) {
    if (typeof value[method] !== "function") {
      fail(
        "RESOURCE_COORDINATOR_INVALID_BINDINGS",
        `${label}.${method} must be a function`,
      );
    }
  }
  return value;
}

function isOperationRecord(value) {
  return Boolean(
    value &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    typeof value.runId === "string" &&
    typeof value.phase === "string",
  );
}

function assertAcceptedPromptEmission(emitted, expected) {
  if (!emitted || typeof emitted !== "object" || Array.isArray(emitted)) {
    fail(
      "RESOURCE_COORDINATOR_PROMPT_EMIT_REJECTED",
      "Prompt emission did not return an accepted payload",
    );
  }
  for (const field of ["runId", "promptId", "actorId", "targetUserId"]) {
    if (emitted[field] !== expected[field]) {
      fail(
        "RESOURCE_COORDINATOR_PROMPT_EMIT_REJECTED",
        `Prompt emission changed its durable ${field} identity`,
      );
    }
  }
}

function assertPlainObject(value, label) {
  const prototype = value && Object.getPrototypeOf(value);
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    (prototype !== Object.prototype && prototype !== null)
  ) {
    fail(
      "RESOURCE_COORDINATOR_INVALID_BINDINGS",
      `${label} must be a plain object`,
    );
  }
}

function boundedReason(value) {
  return (
    String(value ?? "resume")
      .trim()
      .slice(0, 160) || "resume"
  );
}

function errorMessage(error) {
  if (error === null || error === undefined) return null;
  return String(error?.message ?? error).slice(0, 2000);
}

function result(action, details = {}) {
  return Object.freeze({ action, ...details });
}

function fail(code, message) {
  throw new ResourceOperationCoordinatorError(code, message);
}

function stepLimit(label) {
  fail(
    "RESOURCE_COORDINATOR_STEP_LIMIT",
    `${label} exceeded the bounded coordinator step limit`,
  );
}

function checkpointRejected(label) {
  fail(
    "RESOURCE_COORDINATOR_CHECKPOINT_REJECTED",
    `Resource checkpoint did not persist ${label}`,
  );
}
