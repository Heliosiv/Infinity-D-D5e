/**
 * Infinity D&D5e - durable Quartermaster operation domain (pure)
 *
 * One record describes one manual upkeep, calendar upkeep, or forage run from
 * its first durable claim through its final receipt. This module deliberately
 * performs no Foundry reads or writes. Callers must persist every returned
 * record before acting on the decision it represents.
 */

export const RESOURCE_OPERATION_VERSION = 1;

export const RESOURCE_OPERATION_PHASES = Object.freeze([
  "prepared",
  "prompting",
  "planned",
  "applying",
  "needs-review",
  "terminal",
]);

export const RESOURCE_OPERATION_TRANSITIONS = Object.freeze({
  prepared: Object.freeze(["prompting", "planned", "needs-review"]),
  prompting: Object.freeze(["planned", "needs-review"]),
  planned: Object.freeze(["applying", "terminal", "needs-review"]),
  applying: Object.freeze(["terminal", "needs-review"]),
  "needs-review": Object.freeze([]),
  terminal: Object.freeze([]),
});

const PHASE_SET = new Set(RESOURCE_OPERATION_PHASES);
const ADOPTABLE_PHASES = new Set([
  "prepared",
  "prompting",
  "planned",
  "applying",
  "terminal",
]);
const KINDS = new Set(["upkeep", "forage"]);
const TRIGGERS = new Set(["manual", "calendar", "forage"]);
const FORAGE_TARGETS = new Set(["food-water", "food", "water"]);
const ACTOR_ROLES = new Set([
  "participant",
  "inventory",
  "participant-inventory",
]);
const INVENTORY_ACTIONS = new Set(["update", "create", "delete"]);

const RECORD_KEYS = Object.freeze([
  "version",
  "operationId",
  "runId",
  "kind",
  "trigger",
  "phase",
  "guard",
  "authorityAdoptions",
  "context",
  "day",
  "days",
  "environment",
  "initiator",
  "actors",
  "prompts",
  "yields",
  "plan",
  "appliedOperationIds",
  "report",
  "receipt",
  "outbox",
  "timestamps",
  "review",
]);
const GUARD_KEYS = Object.freeze([
  "authorityId",
  "authorityEpoch",
  "leadershipGeneration",
]);
const AUTHORITY_ADOPTION_KEYS = Object.freeze([
  "fromGuard",
  "toGuard",
  "at",
  "phase",
  "advancedOperationId",
  "appliedCount",
  "observations",
]);
const OUTBOX_KEYS = Object.freeze(["entries"]);
const CONTEXT_KEYS = Object.freeze(["fingerprint", "snapshot"]);
const DELIVERY_KEYS = Object.freeze([
  "deliveryId",
  "kind",
  "recipient",
  "promptId",
  "state",
  "payload",
  "deliveredAt",
]);
const DELIVERY_RECIPIENT_KEYS = Object.freeze(["type", "id"]);
const ENVIRONMENT_KEYS = Object.freeze([
  "id",
  "label",
  "dc",
  "foodDc",
  "waterDc",
]);
const INITIATOR_KEYS = Object.freeze(["userId", "name"]);
const ACTOR_KEYS = Object.freeze(["actorId", "name", "role", "forageTarget"]);
const PROMPTS_KEYS = Object.freeze(["assignments", "responses", "timeouts"]);
const ASSIGNMENT_KEYS = Object.freeze([
  "promptId",
  "actorId",
  "userId",
  "forageTarget",
  "dc",
  "foodDc",
  "waterDc",
  "assignedAt",
  "deadlineAt",
]);
const RESPONSE_KEYS = Object.freeze([
  "promptId",
  "actorId",
  "userId",
  "rollTotal",
  "wisMod",
  "skipped",
  "receivedAt",
]);
const TIMEOUT_KEYS = Object.freeze(["promptId", "timedOutAt"]);
const YIELD_KEYS = Object.freeze([
  "actorId",
  "forageTarget",
  "rollTotal",
  "wisMod",
  "food",
  "water",
  "foodSuccess",
  "waterSuccess",
  "suppressedFood",
  "suppressedWater",
]);
const INVENTORY_OPERATION_KEYS = Object.freeze([
  "opId",
  "sequence",
  "action",
  "actorId",
  "itemId",
  "resourceId",
  "beforeQuantity",
  "afterQuantity",
  "itemSnapshot",
]);
const TIMESTAMP_KEYS = Object.freeze([
  "createdAt",
  "updatedAt",
  "preparedAt",
  "promptingAt",
  "plannedAt",
  "applyingAt",
  "needsReviewAt",
  "terminalAt",
]);
const REVIEW_KEYS = Object.freeze([
  "code",
  "reason",
  "at",
  "operationId",
  "evidence",
]);
const OBSERVATION_KEYS = Object.freeze([
  "exists",
  "quantity",
  "matchesResource",
]);
const AUTHORITY_OBSERVATION_KEYS = Object.freeze([
  "actorId",
  "itemId",
  ...OBSERVATION_KEYS,
]);
const DELIVERY_KINDS = new Set(["report", "prompt-ack"]);
const DELIVERY_STATES = new Set(["pending", "delivered"]);
const DELIVERY_RECIPIENT_TYPES = new Set(["chat", "user"]);

const MAX_ID_LENGTH = 256;
const MAX_OPERATION_ID_LENGTH = 2048;
const MAX_LABEL_LENGTH = 512;
const MAX_REASON_LENGTH = 2000;
const MAX_ACTORS = 100;
const MAX_PROMPTS = 100;
const MAX_YIELDS = 100;
const MAX_INVENTORY_OPERATIONS = 1000;
const MAX_AUTHORITY_ADOPTIONS = 100;
const MAX_DELIVERIES = MAX_PROMPTS + 1;
const MAX_QUANTITY = 1_000_000_000;
const MAX_JSON_DEPTH = 20;
const MAX_JSON_NODES = 50_000;
const MAX_JSON_STRING_CHARS = 1_000_000;
const MAX_JSON_KEY_LENGTH = 1024;
const MAX_JSON_KEY_CHARS = 250_000;
const MAX_JSON_COLLECTION_SIZE = 5000;
const MAX_JSON_STRING_LENGTH = 65_536;

export class ResourceOperationLedgerError extends Error {
  constructor(code, message, path = "") {
    super(message);
    this.name = "ResourceOperationLedgerError";
    this.code = code;
    this.path = path;
  }
}

/** Build the initial durable record. The caller supplies the observed clock. */
export function createResourceOperation(input = {}) {
  assertPlainObject(input, "input");
  const operationId = strictString(
    input.operationId ?? input.runId,
    "input.operationId",
    { max: MAX_OPERATION_ID_LENGTH },
  );
  const runId = strictId(input.runId ?? operationId, "input.runId");
  const trigger = strictEnum(input.trigger, TRIGGERS, "input.trigger");
  const kind = strictEnum(
    input.kind ?? (trigger === "forage" ? "forage" : "upkeep"),
    KINDS,
    "input.kind",
  );
  const createdAt = safeTimestamp(input.createdAt, "input.createdAt");
  return normalizeResourceOperation({
    version: RESOURCE_OPERATION_VERSION,
    operationId,
    runId,
    kind,
    trigger,
    phase: "prepared",
    guard: input.guard,
    authorityAdoptions: [],
    context: input.context,
    day: input.day ?? null,
    days: input.days ?? 1,
    environment: input.environment ?? null,
    initiator: input.initiator ?? null,
    actors: input.actors ?? [],
    prompts: { assignments: [], responses: [], timeouts: [] },
    yields: [],
    plan: [],
    appliedOperationIds: [],
    report: null,
    receipt: null,
    outbox: { entries: [] },
    timestamps: {
      createdAt,
      updatedAt: createdAt,
      preparedAt: createdAt,
      promptingAt: null,
      plannedAt: null,
      applyingAt: null,
      needsReviewAt: null,
      terminalAt: null,
    },
    review: null,
  });
}

/** Capture the complete immutable rules/roster context used by one run. */
export function createResourceOperationContext(snapshot) {
  const cloned = cloneJson(snapshot, "context.snapshot", createJsonBudget());
  assertPlainObject(cloned, "context.snapshot");
  return deepFreeze({
    fingerprint: contextFingerprint(cloned),
    snapshot: cloned,
  });
}

/** Compare current candidate rules with the persisted pre-prompt context. */
export function resourceOperationContextMatches(record, candidateSnapshot) {
  const current = normalizeResourceOperation(record);
  try {
    const candidate = cloneJson(
      candidateSnapshot,
      "candidateContext",
      createJsonBudget(),
    );
    assertPlainObject(candidate, "candidateContext");
    return sameJson(candidate, current.context.snapshot);
  } catch {
    return false;
  }
}

/** Strict parser for the complete persisted v1 record. */
export function normalizeResourceOperation(raw) {
  assertPlainObject(raw, "operation");
  assertExactKeys(raw, RECORD_KEYS, "operation");
  assertSupportedVersion(raw.version, "operation");

  const budget = createJsonBudget();
  const operationId = strictString(raw.operationId, "operation.operationId", {
    max: MAX_OPERATION_ID_LENGTH,
  });
  const runId = strictId(raw.runId, "operation.runId");
  const kind = strictEnum(raw.kind, KINDS, "operation.kind");
  const trigger = strictEnum(raw.trigger, TRIGGERS, "operation.trigger");
  assertKindTrigger(kind, trigger);
  const phase = strictEnum(raw.phase, PHASE_SET, "operation.phase");
  const guard = normalizeGuard(raw.guard, "operation.guard");
  const authorityAdoptions = normalizeAuthorityAdoptions(
    raw.authorityAdoptions,
    "operation.authorityAdoptions",
  );
  const context = normalizeContext(raw.context, budget, "operation.context");
  const day = nullableSafeInteger(raw.day, "operation.day", {
    min: -1_000_000_000,
    max: 1_000_000_000,
  });
  const days = safeInteger(raw.days, "operation.days", { min: 1, max: 365 });
  const environment = normalizeEnvironment(
    raw.environment,
    "operation.environment",
  );
  const initiator = normalizeInitiator(raw.initiator, "operation.initiator");
  const actors = normalizeActors(raw.actors, "operation.actors");
  const prompts = normalizePrompts(raw.prompts, "operation.prompts");
  const yields = normalizeYields(raw.yields, "operation.yields");
  const plan = normalizeInventoryPlan(
    raw.plan,
    runId,
    budget,
    "operation.plan",
  );
  const appliedOperationIds = normalizeAppliedOperationIds(
    raw.appliedOperationIds,
    "operation.appliedOperationIds",
  );
  const report = nullableJsonObject(raw.report, "operation.report", budget);
  const receipt = nullableJsonObject(raw.receipt, "operation.receipt", budget);
  const outbox = normalizeOutbox(raw.outbox, runId, budget, "operation.outbox");
  const timestamps = normalizeTimestamps(
    raw.timestamps,
    "operation.timestamps",
  );
  const review = normalizeReview(raw.review, "operation.review", budget);

  const normalized = {
    version: RESOURCE_OPERATION_VERSION,
    operationId,
    runId,
    kind,
    trigger,
    phase,
    guard,
    authorityAdoptions,
    context,
    day,
    days,
    environment,
    initiator,
    actors,
    prompts,
    yields,
    plan,
    appliedOperationIds,
    report,
    receipt,
    outbox,
    timestamps,
    review,
  };
  assertRecordInvariants(normalized);
  return deepFreeze(normalized);
}

export function canTransitionResourceOperation(fromPhase, toPhase) {
  const from = String(fromPhase ?? "");
  const to = String(toPhase ?? "");
  if (!PHASE_SET.has(from) || !PHASE_SET.has(to)) return false;
  if (from === to) return true;
  return RESOURCE_OPERATION_TRANSITIONS[from].includes(to);
}

/**
 * Advance one persisted checkpoint. Returning the same phase is an idempotent
 * no-op. A needs-review record is intentionally pinned and cannot be resumed.
 */
export function transitionResourceOperation(record, nextPhase, options = {}) {
  const current = normalizeResourceOperation(record);
  const target = strictEnum(nextPhase, PHASE_SET, "nextPhase");
  if (!canTransitionResourceOperation(current.phase, target)) {
    fail(
      "RESOURCE_OPERATION_INVALID_TRANSITION",
      `Cannot transition ${current.phase} to ${target}`,
      "nextPhase",
    );
  }
  if (current.phase === target) return current;

  if (target !== "needs-review") {
    assertMatchingGuard(current, options.guard, "options.guard");
  }
  const at = safeInteger(
    options.at ?? current.timestamps.updatedAt,
    "options.at",
    {
      min: current.timestamps.updatedAt,
    },
  );
  const next = mutableClone(current);
  next.phase = target;
  next.timestamps.updatedAt = at;

  if (target === "prompting") {
    next.prompts = {
      assignments: options.assignments ?? [],
      responses: [],
      timeouts: [],
    };
    next.timestamps.promptingAt = at;
  } else if (target === "planned") {
    next.yields = options.yields ?? [];
    next.plan = options.operations ?? [];
    next.timestamps.plannedAt = at;
  } else if (target === "applying") {
    next.timestamps.applyingAt = at;
  } else if (target === "needs-review") {
    next.report = options.report ?? next.report;
    next.receipt = options.receipt ?? next.receipt;
    next.review = {
      code: options.code ?? options.review?.code,
      reason: options.reason ?? options.review?.reason,
      at,
      operationId: options.operationId ?? options.review?.operationId ?? null,
      evidence: options.evidence ?? options.review?.evidence ?? null,
    };
    next.timestamps.needsReviewAt = at;
  } else if (target === "terminal") {
    next.report = options.report ?? next.report;
    next.receipt = options.receipt ?? next.receipt;
    next.outbox = { entries: options.deliveries ?? [] };
    next.review = null;
    next.timestamps.terminalAt = at;
  }
  const normalized = normalizeResourceOperation(next);
  if (
    target === "terminal" &&
    normalized.outbox.entries.some((entry) => entry.state !== "pending")
  ) {
    fail(
      "RESOURCE_OPERATION_DELIVERY_CONFLICT",
      "Terminal persistence must precede every outbox delivery",
      "options.deliveries",
    );
  }
  return normalized;
}

/** Record one player answer. Exact duplicates are harmless; conflicts pin. */
export function recordResourcePromptResponse(record, response, options = {}) {
  const current = normalizeResourceOperation(record);
  assertPlainObject(response, "response");
  const promptId = strictId(response.promptId, "response.promptId");
  const assignment = current.prompts.assignments.find(
    (entry) => entry.promptId === promptId,
  );
  if (!assignment) {
    fail(
      "RESOURCE_OPERATION_PROMPT_CONFLICT",
      "Response does not match a prompt assignment",
      "response.promptId",
    );
  }
  const receivedAt = safeInteger(
    options.at ?? response.receivedAt,
    "response.receivedAt",
    { min: assignment.assignedAt },
  );
  const candidate = normalizePromptResponse(
    {
      promptId,
      actorId: response.actorId ?? assignment.actorId,
      userId: response.userId ?? assignment.userId,
      rollTotal: response.rollTotal,
      wisMod: response.wisMod,
      skipped: response.skipped,
      receivedAt,
    },
    "response",
  );
  assertResponseMatchesAssignment(candidate, assignment, "response");

  const existing = current.prompts.responses.find(
    (entry) => entry.promptId === promptId,
  );
  if (existing) {
    if (samePromptAnswer(existing, candidate)) return current;
    fail(
      "RESOURCE_OPERATION_PROMPT_CONFLICT",
      "Prompt already has a different response",
      "response.promptId",
    );
  }
  if (current.prompts.timeouts.some((entry) => entry.promptId === promptId)) {
    fail(
      "RESOURCE_OPERATION_PROMPT_CONFLICT",
      "Prompt already timed out",
      "response.promptId",
    );
  }
  if (current.phase !== "prompting") {
    fail(
      "RESOURCE_OPERATION_INVALID_TRANSITION",
      "New responses are accepted only while prompting",
      "operation.phase",
    );
  }
  assertMatchingGuard(current, options.guard, "options.guard");
  if (receivedAt < current.timestamps.updatedAt) {
    fail(
      "RESOURCE_OPERATION_MALFORMED",
      "Response timestamp precedes the durable record",
      "response.receivedAt",
    );
  }
  const next = mutableClone(current);
  next.prompts.responses.push(candidate);
  next.timestamps.updatedAt = receivedAt;
  return normalizeResourceOperation(next);
}

/** Mark one unanswered assignment timed out. Duplicate timeouts are harmless. */
export function recordResourcePromptTimeout(record, promptId, options = {}) {
  const current = normalizeResourceOperation(record);
  const id = strictId(promptId, "promptId");
  const assignment = current.prompts.assignments.find(
    (entry) => entry.promptId === id,
  );
  if (!assignment) {
    fail(
      "RESOURCE_OPERATION_PROMPT_CONFLICT",
      "Timeout does not match a prompt assignment",
      "promptId",
    );
  }
  if (current.prompts.timeouts.some((entry) => entry.promptId === id)) {
    return current;
  }
  if (current.prompts.responses.some((entry) => entry.promptId === id)) {
    fail(
      "RESOURCE_OPERATION_PROMPT_CONFLICT",
      "Prompt already has a response",
      "promptId",
    );
  }
  if (current.phase !== "prompting") {
    fail(
      "RESOURCE_OPERATION_INVALID_TRANSITION",
      "New timeouts are accepted only while prompting",
      "operation.phase",
    );
  }
  assertMatchingGuard(current, options.guard, "options.guard");
  const timedOutAt = safeInteger(options.at, "options.at", {
    min: Math.max(assignment.deadlineAt, current.timestamps.updatedAt),
  });
  const next = mutableClone(current);
  next.prompts.timeouts.push({ promptId: id, timedOutAt });
  next.timestamps.updatedAt = timedOutAt;
  return normalizeResourceOperation(next);
}

/** Collision-free deterministic tuple for an exact inventory boundary. */
export function buildResourceInventoryOperationId(input = {}) {
  assertPlainObject(input, "inventoryOperation");
  const action = strictEnum(
    input.action,
    INVENTORY_ACTIONS,
    "inventoryOperation.action",
  );
  let snapshotFingerprint = null;
  if (action === "create") {
    const snapshot = cloneJson(
      input.itemSnapshot,
      "inventoryOperation.itemSnapshot",
      createJsonBudget(),
    );
    assertPlainObject(snapshot, "inventoryOperation.itemSnapshot");
    snapshotFingerprint = jsonFingerprint("resource-item-create-v1", snapshot);
  }
  const tuple = [
    "resource-operation-v1",
    strictId(input.runId, "inventoryOperation.runId"),
    safeInteger(input.sequence, "inventoryOperation.sequence", {
      min: 0,
      max: MAX_INVENTORY_OPERATIONS - 1,
    }),
    action,
    strictId(input.actorId, "inventoryOperation.actorId"),
    strictId(input.itemId, "inventoryOperation.itemId"),
    strictId(input.resourceId, "inventoryOperation.resourceId"),
    safeQuantity(input.beforeQuantity, "inventoryOperation.beforeQuantity"),
    safeQuantity(input.afterQuantity, "inventoryOperation.afterQuantity"),
    snapshotFingerprint,
  ];
  return JSON.stringify(tuple);
}

/** Build and validate one immutable planned write. */
export function createResourceInventoryOperation(input = {}) {
  assertPlainObject(input, "inventoryOperation");
  const raw = {
    opId: buildResourceInventoryOperationId(input),
    sequence: input.sequence,
    action: input.action,
    actorId: input.actorId,
    itemId: input.itemId,
    resourceId: input.resourceId,
    beforeQuantity: input.beforeQuantity,
    afterQuantity: input.afterQuantity,
    itemSnapshot: input.itemSnapshot ?? null,
  };
  return deepFreeze(
    normalizeInventoryOperation(
      raw,
      strictId(input.runId, "inventoryOperation.runId"),
      createJsonBudget(),
      "inventoryOperation",
    ),
  );
}

/** Stable tuple used by chat/socket layers for canonical delivery dedupe. */
export function buildResourceDeliveryId(input = {}) {
  assertPlainObject(input, "delivery");
  assertPlainObject(input.recipient, "delivery.recipient");
  const kind = strictEnum(input.kind, DELIVERY_KINDS, "delivery.kind");
  const recipient = {
    type: strictEnum(
      input.recipient.type,
      DELIVERY_RECIPIENT_TYPES,
      "delivery.recipient.type",
    ),
    id: strictId(input.recipient.id, "delivery.recipient.id"),
  };
  const promptId = nullableId(input.promptId ?? null, "delivery.promptId");
  if (
    (kind === "report" && (recipient.type !== "chat" || promptId !== null)) ||
    (kind === "prompt-ack" && (recipient.type !== "user" || promptId === null))
  ) {
    fail(
      "RESOURCE_OPERATION_MALFORMED",
      "Delivery kind, recipient, and prompt identity disagree",
      "delivery",
    );
  }
  const payload = cloneJson(
    input.payload,
    "delivery.payload",
    createJsonBudget(),
  );
  assertPlainObject(payload, "delivery.payload");
  return JSON.stringify([
    "resource-delivery-v1",
    strictId(input.runId, "delivery.runId"),
    kind,
    recipient.type,
    recipient.id,
    promptId,
    jsonFingerprint("resource-delivery-payload-v1", payload),
  ]);
}

/** Build one pending immutable outbox entry before any external delivery. */
export function createResourceDelivery(input = {}) {
  const runId = strictId(input.runId, "delivery.runId");
  const raw = {
    deliveryId: buildResourceDeliveryId(input),
    kind: input.kind,
    recipient: input.recipient,
    promptId: input.promptId ?? null,
    state: "pending",
    payload: input.payload,
    deliveredAt: null,
  };
  return deepFreeze(
    normalizeDelivery(raw, runId, createJsonBudget(), "delivery"),
  );
}

/** Build the only valid terminal outbox: report first, then prompt ACKs. */
export function createResourceTerminalDeliveries(
  record,
  { report, reportRecipient = { type: "chat", id: "public" } } = {},
) {
  const current = normalizeResourceOperation(record);
  const normalizedReport = cloneJson(report, "report", createJsonBudget());
  assertPlainObject(normalizedReport, "report");
  return deepFreeze([
    createResourceDelivery({
      runId: current.runId,
      kind: "report",
      recipient: reportRecipient,
      promptId: null,
      payload: normalizedReport,
    }),
    ...current.prompts.assignments.map((assignment) =>
      createResourceDelivery({
        runId: current.runId,
        kind: "prompt-ack",
        recipient: { type: "user", id: assignment.userId },
        promptId: assignment.promptId,
        payload: expectedPromptAcknowledgement(current, assignment),
      }),
    ),
  ]);
}

/** Compare a live authority fence with the immutable record guard. */
export function resourceOperationGuardMatches(record, guard) {
  const current = normalizeResourceOperation(record);
  try {
    const candidate = normalizeGuard(guard, "guard");
    return sameJson(current.guard, candidate);
  } catch {
    return false;
  }
}

/**
 * Explicitly rotate a stale authority guard after canonical reconciliation.
 * The old guard remains in the audit chain, so every callback that captured it
 * immediately fails closed against the returned record.
 */
export function adoptResourceOperationAuthority(
  record,
  nextGuard,
  options = {},
) {
  const current = normalizeResourceOperation(record);
  if (!ADOPTABLE_PHASES.has(current.phase)) {
    fail(
      "RESOURCE_OPERATION_INVALID_TRANSITION",
      "Needs-review operations cannot adopt authority and resume",
      "operation.phase",
    );
  }
  const adoptedGuard = normalizeGuard(nextGuard, "nextGuard");
  if (sameJson(current.guard, adoptedGuard)) return current;
  if (
    current.phase !== "terminal" &&
    !resourceOperationContextMatches(current, options.contextSnapshot)
  ) {
    fail(
      "RESOURCE_OPERATION_ADOPTION_CONFLICT",
      "Authority adoption did not prove the persisted planning context",
      "options.contextSnapshot",
    );
  }
  if (
    current.phase === "terminal" &&
    !current.outbox.entries.some((entry) => entry.state === "pending")
  ) {
    fail(
      "RESOURCE_OPERATION_INVALID_TRANSITION",
      "Delivered terminal operations do not need authority adoption",
      "operation.phase",
    );
  }
  const at = safeInteger(options.at, "options.at", {
    min: current.timestamps.updatedAt,
  });
  const observations = normalizeAuthorityObservations(
    options.observations ?? [],
    "options.observations",
  );
  let advancedOperationId = null;
  if (current.phase === "planned" || current.phase === "applying") {
    advancedOperationId = reconcileAuthorityAdoption(current, observations);
  } else if (observations.length > 0) {
    fail(
      "RESOURCE_OPERATION_ADOPTION_CONFLICT",
      "This operation phase has no inventory boundary to reconcile",
      "options.observations",
    );
  }

  const next = mutableClone(current);
  if (advancedOperationId) {
    next.appliedOperationIds.push(advancedOperationId);
  }
  next.guard = adoptedGuard;
  next.authorityAdoptions.push({
    fromGuard: current.guard,
    toGuard: adoptedGuard,
    at,
    phase: current.phase,
    advancedOperationId,
    appliedCount: next.appliedOperationIds.length,
    observations,
  });
  next.timestamps.updatedAt = at;
  return normalizeResourceOperation(next);
}

/**
 * Return the next safe workflow decision. Applying never returns `apply` by
 * itself: the caller must read the canonical Item and classify that boundary.
 */
export function decideResourceOperation(record, { guard = null } = {}) {
  const current = normalizeResourceOperation(record);
  if (current.phase === "needs-review") {
    return decision("needs-review", {
      reason: current.review.reason,
      operationId: current.review.operationId,
    });
  }
  if (current.phase === "terminal") {
    const pending = current.outbox.entries.find(
      (entry) => entry.state === "pending",
    );
    if (pending) {
      if (!resourceOperationGuardMatches(current, guard)) {
        return decision("adopt-authority", {
          reason: "terminal-delivery-guard-mismatch",
          deliveryId: pending.deliveryId,
        });
      }
      return decision("deliver", {
        reason: "pending-outbox-entry",
        delivery: pending,
      });
    }
    return decision("replay", {
      reason: "terminal-receipt",
      report: current.report,
      receipt: current.receipt,
    });
  }
  if (!resourceOperationGuardMatches(current, guard)) {
    return decision("adopt-authority", {
      reason: "authority-guard-mismatch",
      operationId: null,
      requiresInventoryReconciliation:
        current.phase === "planned" || current.phase === "applying",
    });
  }
  if (current.phase === "prepared") {
    return decision("prompt-or-plan", { reason: "run-prepared" });
  }
  if (current.phase === "prompting") {
    const pendingPromptIds = pendingPromptIdsFor(current);
    return pendingPromptIds.length > 0
      ? decision("wait-for-prompts", { pendingPromptIds })
      : decision("plan", { reason: "prompts-resolved" });
  }
  if (current.phase === "planned") {
    return current.plan.length > 0
      ? decision("begin-applying", { operationId: current.plan[0].opId })
      : decision("finalize", { reason: "no-inventory-writes" });
  }
  if (current.phase === "applying") {
    const next = current.plan[current.appliedOperationIds.length] ?? null;
    return next
      ? decision("reconcile", {
          operationId: next.opId,
          operation: next,
          reason: "canonical-readback-required",
        })
      : decision("finalize", { reason: "all-inventory-writes-confirmed" });
  }
  fail(
    "RESOURCE_OPERATION_MALFORMED",
    "Unsupported resource operation phase",
    "operation.phase",
  );
}

/**
 * Classify a canonical Item readback against the next unapplied boundary.
 * `apply` is returned only for the exact before state; exact after means the
 * write landed before its durable marker, and every third state needs review.
 */
export function classifyResourceInventoryOperation(
  record,
  opId,
  observed,
  { guard = null } = {},
) {
  const current = normalizeResourceOperation(record);
  const id = strictString(opId, "opId", { max: MAX_OPERATION_ID_LENGTH });
  const operation = current.plan.find((entry) => entry.opId === id);
  if (!operation) {
    return decision("needs-review", {
      reason: "unknown-inventory-operation",
      operationId: id,
    });
  }
  if (current.appliedOperationIds.includes(id)) {
    return decision("already-applied", {
      reason: "durable-marker-present",
      operationId: id,
    });
  }
  if (!resourceOperationGuardMatches(current, guard)) {
    return decision("needs-review", {
      reason: "authority-guard-mismatch",
      operationId: id,
    });
  }
  if (current.phase !== "applying") {
    return decision("needs-review", {
      reason: "operation-not-applying",
      operationId: id,
    });
  }
  const next = current.plan[current.appliedOperationIds.length];
  if (next?.opId !== id) {
    return decision("needs-review", {
      reason: "inventory-operation-out-of-order",
      operationId: id,
    });
  }
  const observation = normalizeInventoryObservation(observed, "observed");
  if (observation.exists && observation.matchesResource !== true) {
    return decision("needs-review", {
      reason: "resource-identity-mismatch",
      operationId: id,
      observed: observation,
    });
  }
  if (observationMatchesAfter(operation, observation)) {
    return decision("mark-applied", {
      reason: "canonical-after-state",
      operationId: id,
      observed: observation,
    });
  }
  if (observationMatchesBefore(operation, observation)) {
    return decision("apply", {
      reason: "canonical-before-state",
      operationId: id,
      operation,
      observed: observation,
    });
  }
  return decision("needs-review", {
    reason: "canonical-third-state",
    operationId: id,
    observed: observation,
  });
}

/** Mark only a canonically observed after-state, in exact write order. */
export function markResourceInventoryOperationApplied(
  record,
  opId,
  options = {},
) {
  const current = normalizeResourceOperation(record);
  const id = strictString(opId, "opId", { max: MAX_OPERATION_ID_LENGTH });
  if (current.appliedOperationIds.includes(id)) return current;
  assertMatchingGuard(current, options.guard, "options.guard");
  const classification = classifyResourceInventoryOperation(
    current,
    id,
    options.observed,
    { guard: options.guard },
  );
  if (classification.action !== "mark-applied") {
    fail(
      "RESOURCE_OPERATION_APPLY_CONFLICT",
      `Cannot mark inventory operation from ${classification.reason}`,
      "opId",
    );
  }
  const at = safeInteger(options.at, "options.at", {
    min: current.timestamps.updatedAt,
  });
  const next = mutableClone(current);
  next.appliedOperationIds.push(id);
  next.timestamps.updatedAt = at;
  return normalizeResourceOperation(next);
}

/** Mark a canonically deduplicated chat/socket delivery. Exact repeats are safe. */
export function markResourceDeliveryDelivered(
  record,
  deliveryId,
  options = {},
) {
  const current = normalizeResourceOperation(record);
  const id = strictString(deliveryId, "deliveryId", {
    max: MAX_OPERATION_ID_LENGTH,
  });
  const delivery = current.outbox.entries.find(
    (entry) => entry.deliveryId === id,
  );
  if (!delivery) {
    fail(
      "RESOURCE_OPERATION_DELIVERY_CONFLICT",
      "Delivery does not belong to this operation",
      "deliveryId",
    );
  }
  if (delivery.state === "delivered") return current;
  if (current.phase !== "terminal") {
    fail(
      "RESOURCE_OPERATION_INVALID_TRANSITION",
      "Outbox entries can be marked only after terminal persistence",
      "operation.phase",
    );
  }
  assertMatchingGuard(current, options.guard, "options.guard");
  const firstPending = current.outbox.entries.find(
    (entry) => entry.state === "pending",
  );
  if (firstPending?.deliveryId !== id) {
    fail(
      "RESOURCE_OPERATION_DELIVERY_CONFLICT",
      "Outbox deliveries must be confirmed in persisted order",
      "deliveryId",
    );
  }
  if (options.confirmed !== true) {
    fail(
      "RESOURCE_OPERATION_DELIVERY_CONFLICT",
      "Delivery marking requires canonical dedupe confirmation",
      "options.confirmed",
    );
  }
  const at = safeInteger(options.at, "options.at", {
    min: current.timestamps.updatedAt,
  });
  const next = mutableClone(current);
  const target = next.outbox.entries.find((entry) => entry.deliveryId === id);
  target.state = "delivered";
  target.deliveredAt = at;
  next.timestamps.updatedAt = at;
  return normalizeResourceOperation(next);
}

/**
 * Quarantine the old activeUpkeep lease. Its write outcome is unknowable, so
 * conversion always produces a pinned needs-review record and never a plan
 * that can be resumed automatically.
 */
export function legacyActiveUpkeepToResourceOperation(
  activeUpkeep,
  options = {},
) {
  assertPlainObject(activeUpkeep, "activeUpkeep");
  const evidence = cloneJson(activeUpkeep, "activeUpkeep", createJsonBudget());
  const source = evidence;
  const runId = strictId(source.runId, "activeUpkeep.runId");
  const trigger = TRIGGERS.has(source.trigger) ? source.trigger : "manual";
  const convertedAt = safeTimestamp(
    options.convertedAt ?? source.claimedAt ?? source.startedAt ?? 0,
    "options.convertedAt",
  );
  const observedStart = nullableSafeInteger(
    source.startedAt ?? source.claimedAt ?? null,
    "activeUpkeep.startedAt",
    { min: 0 },
  );
  const createdAt = Math.min(observedStart ?? convertedAt, convertedAt);
  const projectedEnvironment = projectLegacyEnvironment(source.environment);
  const projectedInitiator = projectLegacyInitiator(source.initiator);
  const projectedActors = projectLegacyActors(source.actors);
  return normalizeResourceOperation({
    version: RESOURCE_OPERATION_VERSION,
    operationId: options.operationId ?? `legacy-active-upkeep:${String(runId)}`,
    runId,
    kind: trigger === "forage" ? "forage" : "upkeep",
    trigger,
    phase: "needs-review",
    guard: {
      authorityId:
        cleanLegacyId(source.authorityId) ?? "legacy-unrecorded-authority",
      authorityEpoch:
        cleanLegacyId(source.authorityEpoch) ?? "legacy-unrecorded-epoch",
      leadershipGeneration: Number.isSafeInteger(source.leadershipGeneration)
        ? Math.max(0, source.leadershipGeneration)
        : 0,
    },
    authorityAdoptions: [],
    context: createResourceOperationContext({
      legacyActiveUpkeep: true,
      runId,
    }),
    day: Number.isSafeInteger(source.day) ? source.day : null,
    days:
      Number.isSafeInteger(source.days) && source.days >= 1
        ? Math.min(365, source.days)
        : 1,
    environment: projectedEnvironment,
    initiator: projectedInitiator,
    actors: projectedActors,
    prompts: { assignments: [], responses: [], timeouts: [] },
    yields: [],
    plan: [],
    appliedOperationIds: [],
    report: null,
    receipt: null,
    outbox: { entries: [] },
    timestamps: {
      createdAt,
      updatedAt: convertedAt,
      preparedAt: createdAt,
      promptingAt: null,
      plannedAt: null,
      applyingAt: null,
      needsReviewAt: convertedAt,
      terminalAt: null,
    },
    review: {
      code: "legacy-active-upkeep-outcome-unknown",
      reason:
        "Legacy activeUpkeep may have changed inventory; inspect canonical Actor quantities before resolving it.",
      at: convertedAt,
      operationId: null,
      evidence,
    },
  });
}

function normalizeGuard(value, path) {
  assertPlainObject(value, path);
  assertExactKeys(value, GUARD_KEYS, path);
  return {
    authorityId: strictId(value.authorityId, `${path}.authorityId`),
    authorityEpoch: strictId(value.authorityEpoch, `${path}.authorityEpoch`),
    leadershipGeneration: safeInteger(
      value.leadershipGeneration,
      `${path}.leadershipGeneration`,
      { min: 0 },
    ),
  };
}

function normalizeAuthorityAdoptions(values, path) {
  assertDenseArray(values, path, MAX_AUTHORITY_ADOPTIONS);
  const adoptions = [];
  let prior = null;
  for (let index = 0; index < values.length; index += 1) {
    const adoptionPath = `${path}[${index}]`;
    const value = values[index];
    assertPlainObject(value, adoptionPath);
    assertExactKeys(value, AUTHORITY_ADOPTION_KEYS, adoptionPath);
    const adoption = {
      fromGuard: normalizeGuard(value.fromGuard, `${adoptionPath}.fromGuard`),
      toGuard: normalizeGuard(value.toGuard, `${adoptionPath}.toGuard`),
      at: safeTimestamp(value.at, `${adoptionPath}.at`),
      phase: strictEnum(value.phase, ADOPTABLE_PHASES, `${adoptionPath}.phase`),
      advancedOperationId:
        value.advancedOperationId === null
          ? null
          : strictString(
              value.advancedOperationId,
              `${adoptionPath}.advancedOperationId`,
              { max: MAX_OPERATION_ID_LENGTH },
            ),
      appliedCount: safeInteger(
        value.appliedCount,
        `${adoptionPath}.appliedCount`,
        { min: 0, max: MAX_INVENTORY_OPERATIONS },
      ),
      observations: normalizeAuthorityObservations(
        value.observations,
        `${adoptionPath}.observations`,
      ),
    };
    if (sameJson(adoption.fromGuard, adoption.toGuard)) {
      fail(
        "RESOURCE_OPERATION_MALFORMED",
        "Authority adoption must rotate the durable guard",
        adoptionPath,
      );
    }
    if (
      prior &&
      (!sameJson(prior.toGuard, adoption.fromGuard) || adoption.at < prior.at)
    ) {
      fail(
        "RESOURCE_OPERATION_MALFORMED",
        "Authority adoption history is not contiguous",
        adoptionPath,
      );
    }
    adoptions.push(adoption);
    prior = adoption;
  }
  return adoptions;
}

function normalizeContext(value, budget, path) {
  assertPlainObject(value, path);
  assertExactKeys(value, CONTEXT_KEYS, path);
  const snapshot = cloneJson(value.snapshot, `${path}.snapshot`, budget);
  assertPlainObject(snapshot, `${path}.snapshot`);
  const fingerprint = strictString(value.fingerprint, `${path}.fingerprint`, {
    max: 160,
  });
  if (fingerprint !== contextFingerprint(snapshot)) {
    fail(
      "RESOURCE_OPERATION_MALFORMED",
      "Context fingerprint does not match its immutable snapshot",
      `${path}.fingerprint`,
    );
  }
  return { fingerprint, snapshot };
}

function normalizeEnvironment(value, path) {
  if (value === null) return null;
  assertPlainObject(value, path);
  assertExactKeys(value, ENVIRONMENT_KEYS, path);
  return {
    id: nullableId(value.id, `${path}.id`),
    label: strictString(value.label, `${path}.label`, {
      max: MAX_LABEL_LENGTH,
    }),
    dc: nullableFiniteNumber(value.dc, `${path}.dc`, { min: -1000, max: 1000 }),
    foodDc: nullableFiniteNumber(value.foodDc, `${path}.foodDc`, {
      min: -1000,
      max: 1000,
    }),
    waterDc: nullableFiniteNumber(value.waterDc, `${path}.waterDc`, {
      min: -1000,
      max: 1000,
    }),
  };
}

function normalizeInitiator(value, path) {
  if (value === null) return null;
  assertPlainObject(value, path);
  assertExactKeys(value, INITIATOR_KEYS, path);
  return {
    userId: strictId(value.userId, `${path}.userId`),
    name: strictString(value.name, `${path}.name`, { max: MAX_LABEL_LENGTH }),
  };
}

function normalizeActors(values, path) {
  assertDenseArray(values, path, MAX_ACTORS);
  const actors = [];
  const seen = new Set();
  for (let index = 0; index < values.length; index += 1) {
    const actorPath = `${path}[${index}]`;
    const value = values[index];
    assertPlainObject(value, actorPath);
    assertExactKeys(value, ACTOR_KEYS, actorPath);
    const actor = {
      actorId: strictId(value.actorId, `${actorPath}.actorId`),
      name: strictString(value.name, `${actorPath}.name`, {
        max: MAX_LABEL_LENGTH,
      }),
      role: strictEnum(value.role, ACTOR_ROLES, `${actorPath}.role`),
      forageTarget: nullableEnum(
        value.forageTarget,
        FORAGE_TARGETS,
        `${actorPath}.forageTarget`,
      ),
    };
    if (seen.has(actor.actorId)) {
      fail(
        "RESOURCE_OPERATION_MALFORMED",
        "Duplicate Actor snapshot",
        `${actorPath}.actorId`,
      );
    }
    seen.add(actor.actorId);
    actors.push(actor);
  }
  return actors;
}

function normalizePrompts(value, path) {
  assertPlainObject(value, path);
  assertExactKeys(value, PROMPTS_KEYS, path);
  assertDenseArray(value.assignments, `${path}.assignments`, MAX_PROMPTS);
  assertDenseArray(value.responses, `${path}.responses`, MAX_PROMPTS);
  assertDenseArray(value.timeouts, `${path}.timeouts`, MAX_PROMPTS);
  const assignments = value.assignments.map((entry, index) =>
    normalizePromptAssignment(entry, `${path}.assignments[${index}]`),
  );
  const responses = value.responses.map((entry, index) =>
    normalizePromptResponse(entry, `${path}.responses[${index}]`),
  );
  const timeouts = value.timeouts.map((entry, index) =>
    normalizePromptTimeout(entry, `${path}.timeouts[${index}]`),
  );
  assertUnique(assignments, "promptId", `${path}.assignments`);
  assertUnique(assignments, "actorId", `${path}.assignments`);
  assertUnique(responses, "promptId", `${path}.responses`);
  assertUnique(timeouts, "promptId", `${path}.timeouts`);
  const order = new Map(
    assignments.map((assignment, index) => [assignment.promptId, index]),
  );
  responses.sort(
    (left, right) => orderIndex(order, left) - orderIndex(order, right),
  );
  timeouts.sort(
    (left, right) => orderIndex(order, left) - orderIndex(order, right),
  );
  return { assignments, responses, timeouts };
}

function normalizePromptAssignment(value, path) {
  assertPlainObject(value, path);
  assertExactKeys(value, ASSIGNMENT_KEYS, path);
  const assignedAt = safeTimestamp(value.assignedAt, `${path}.assignedAt`);
  return {
    promptId: strictId(value.promptId, `${path}.promptId`),
    actorId: strictId(value.actorId, `${path}.actorId`),
    userId: strictId(value.userId, `${path}.userId`),
    forageTarget: strictEnum(
      value.forageTarget,
      FORAGE_TARGETS,
      `${path}.forageTarget`,
    ),
    dc: safeFiniteNumber(value.dc, `${path}.dc`, { min: -1000, max: 1000 }),
    foodDc: safeFiniteNumber(value.foodDc, `${path}.foodDc`, {
      min: -1000,
      max: 1000,
    }),
    waterDc: safeFiniteNumber(value.waterDc, `${path}.waterDc`, {
      min: -1000,
      max: 1000,
    }),
    assignedAt,
    deadlineAt: safeInteger(value.deadlineAt, `${path}.deadlineAt`, {
      min: assignedAt,
    }),
  };
}

function normalizePromptResponse(value, path) {
  assertPlainObject(value, path);
  assertExactKeys(value, RESPONSE_KEYS, path);
  const skipped = strictBoolean(value.skipped, `${path}.skipped`);
  const response = {
    promptId: strictId(value.promptId, `${path}.promptId`),
    actorId: strictId(value.actorId, `${path}.actorId`),
    userId: strictId(value.userId, `${path}.userId`),
    rollTotal: safeInteger(value.rollTotal, `${path}.rollTotal`, {
      min: -1000,
      max: 1000,
    }),
    wisMod: safeInteger(value.wisMod, `${path}.wisMod`, {
      min: -100,
      max: 100,
    }),
    skipped,
    receivedAt: safeTimestamp(value.receivedAt, `${path}.receivedAt`),
  };
  if (skipped && response.rollTotal !== 0) {
    fail(
      "RESOURCE_OPERATION_MALFORMED",
      "Skipped prompt responses must record a zero total",
      `${path}.rollTotal`,
    );
  }
  return response;
}

function normalizePromptTimeout(value, path) {
  assertPlainObject(value, path);
  assertExactKeys(value, TIMEOUT_KEYS, path);
  return {
    promptId: strictId(value.promptId, `${path}.promptId`),
    timedOutAt: safeTimestamp(value.timedOutAt, `${path}.timedOutAt`),
  };
}

function normalizeYields(values, path) {
  assertDenseArray(values, path, MAX_YIELDS);
  const yields = [];
  const seen = new Set();
  for (let index = 0; index < values.length; index += 1) {
    const yieldPath = `${path}[${index}]`;
    const value = values[index];
    assertPlainObject(value, yieldPath);
    assertExactKeys(value, YIELD_KEYS, yieldPath);
    const rollTotal = nullableSafeInteger(
      value.rollTotal,
      `${yieldPath}.rollTotal`,
      {
        min: -1000,
        max: 1000,
      },
    );
    const wisMod = nullableSafeInteger(value.wisMod, `${yieldPath}.wisMod`, {
      min: -100,
      max: 100,
    });
    if ((rollTotal === null) !== (wisMod === null)) {
      fail(
        "RESOURCE_OPERATION_MALFORMED",
        "Resolved roll total and modifier must both be present or absent",
        yieldPath,
      );
    }
    const result = {
      actorId: strictId(value.actorId, `${yieldPath}.actorId`),
      forageTarget: strictEnum(
        value.forageTarget,
        FORAGE_TARGETS,
        `${yieldPath}.forageTarget`,
      ),
      rollTotal,
      wisMod,
      food: safeQuantity(value.food, `${yieldPath}.food`),
      water: safeQuantity(value.water, `${yieldPath}.water`),
      foodSuccess: strictBoolean(value.foodSuccess, `${yieldPath}.foodSuccess`),
      waterSuccess: strictBoolean(
        value.waterSuccess,
        `${yieldPath}.waterSuccess`,
      ),
      suppressedFood: strictBoolean(
        value.suppressedFood,
        `${yieldPath}.suppressedFood`,
      ),
      suppressedWater: strictBoolean(
        value.suppressedWater,
        `${yieldPath}.suppressedWater`,
      ),
    };
    if (seen.has(result.actorId)) {
      fail(
        "RESOURCE_OPERATION_MALFORMED",
        "Duplicate resolved yield",
        `${yieldPath}.actorId`,
      );
    }
    seen.add(result.actorId);
    yields.push(result);
  }
  return yields;
}

function normalizeInventoryPlan(values, runId, budget, path) {
  assertDenseArray(values, path, MAX_INVENTORY_OPERATIONS);
  const plan = values.map((value, index) =>
    normalizeInventoryOperation(value, runId, budget, `${path}[${index}]`),
  );
  const ids = new Set();
  const boundaries = new Map();
  for (let index = 0; index < plan.length; index += 1) {
    const operation = plan[index];
    if (operation.sequence !== index) {
      fail(
        "RESOURCE_OPERATION_MALFORMED",
        "Inventory operation sequence must match durable write order",
        `${path}[${index}].sequence`,
      );
    }
    if (ids.has(operation.opId)) {
      fail(
        "RESOURCE_OPERATION_MALFORMED",
        "Duplicate inventory operation id",
        `${path}[${index}].opId`,
      );
    }
    ids.add(operation.opId);
    const target = JSON.stringify([operation.actorId, operation.itemId]);
    const prior = boundaries.get(target);
    if (prior) {
      const priorExists = prior.action !== "delete";
      const nextExists = operation.action !== "create";
      if (
        prior.resourceId !== operation.resourceId ||
        priorExists !== nextExists ||
        (priorExists && prior.afterQuantity !== operation.beforeQuantity)
      ) {
        fail(
          "RESOURCE_OPERATION_MALFORMED",
          "Repeated Item operations do not form one exact boundary chain",
          `${path}[${index}]`,
        );
      }
    }
    boundaries.set(target, operation);
  }
  return plan;
}

function normalizeInventoryOperation(value, runId, budget, path) {
  assertPlainObject(value, path);
  assertExactKeys(value, INVENTORY_OPERATION_KEYS, path);
  const operation = {
    opId: strictString(value.opId, `${path}.opId`, {
      max: MAX_OPERATION_ID_LENGTH,
    }),
    sequence: safeInteger(value.sequence, `${path}.sequence`, {
      min: 0,
      max: MAX_INVENTORY_OPERATIONS - 1,
    }),
    action: strictEnum(value.action, INVENTORY_ACTIONS, `${path}.action`),
    actorId: strictId(value.actorId, `${path}.actorId`),
    itemId: strictId(value.itemId, `${path}.itemId`),
    resourceId: strictId(value.resourceId, `${path}.resourceId`),
    beforeQuantity: safeQuantity(
      value.beforeQuantity,
      `${path}.beforeQuantity`,
    ),
    afterQuantity: safeQuantity(value.afterQuantity, `${path}.afterQuantity`),
    itemSnapshot:
      value.itemSnapshot === null
        ? null
        : cloneJson(value.itemSnapshot, `${path}.itemSnapshot`, budget),
  };
  if (
    operation.opId !==
    buildResourceInventoryOperationId({ runId, ...operation })
  ) {
    fail(
      "RESOURCE_OPERATION_MALFORMED",
      "Inventory operation id does not match its exact boundary",
      `${path}.opId`,
    );
  }
  assertInventoryActionInvariant(operation, path);
  return operation;
}

function normalizeAppliedOperationIds(values, path) {
  assertDenseArray(values, path, MAX_INVENTORY_OPERATIONS);
  const ids = values.map((value, index) =>
    strictString(value, `${path}[${index}]`, {
      max: MAX_OPERATION_ID_LENGTH,
    }),
  );
  if (new Set(ids).size !== ids.length) {
    fail(
      "RESOURCE_OPERATION_MALFORMED",
      "Applied inventory operation ids must be unique",
      path,
    );
  }
  return ids;
}

function normalizeTimestamps(value, path) {
  assertPlainObject(value, path);
  assertExactKeys(value, TIMESTAMP_KEYS, path);
  const timestamps = {
    createdAt: safeTimestamp(value.createdAt, `${path}.createdAt`),
    updatedAt: safeTimestamp(value.updatedAt, `${path}.updatedAt`),
    preparedAt: safeTimestamp(value.preparedAt, `${path}.preparedAt`),
    promptingAt: nullableTimestamp(value.promptingAt, `${path}.promptingAt`),
    plannedAt: nullableTimestamp(value.plannedAt, `${path}.plannedAt`),
    applyingAt: nullableTimestamp(value.applyingAt, `${path}.applyingAt`),
    needsReviewAt: nullableTimestamp(
      value.needsReviewAt,
      `${path}.needsReviewAt`,
    ),
    terminalAt: nullableTimestamp(value.terminalAt, `${path}.terminalAt`),
  };
  if (
    timestamps.preparedAt !== timestamps.createdAt ||
    timestamps.updatedAt < timestamps.createdAt
  ) {
    fail(
      "RESOURCE_OPERATION_MALFORMED",
      "Operation timestamps are not monotonic",
      path,
    );
  }
  for (const [field, timestamp] of Object.entries(timestamps)) {
    if (
      field !== "updatedAt" &&
      timestamp !== null &&
      timestamp > timestamps.updatedAt
    ) {
      fail(
        "RESOURCE_OPERATION_MALFORMED",
        "Phase timestamp follows updatedAt",
        `${path}.${field}`,
      );
    }
  }
  const ordered = [
    timestamps.preparedAt,
    timestamps.promptingAt,
    timestamps.plannedAt,
    timestamps.applyingAt,
  ].filter((entry) => entry !== null);
  for (let index = 1; index < ordered.length; index += 1) {
    if (ordered[index] < ordered[index - 1]) {
      fail(
        "RESOURCE_OPERATION_MALFORMED",
        "Phase timestamps move backward",
        path,
      );
    }
  }
  return timestamps;
}

function normalizeReview(value, path, budget) {
  if (value === null) return null;
  assertPlainObject(value, path);
  assertExactKeys(value, REVIEW_KEYS, path);
  return {
    code: strictId(value.code, `${path}.code`),
    reason: strictString(value.reason, `${path}.reason`, {
      max: MAX_REASON_LENGTH,
    }),
    at: safeTimestamp(value.at, `${path}.at`),
    operationId:
      value.operationId === null
        ? null
        : strictString(value.operationId, `${path}.operationId`, {
            max: MAX_OPERATION_ID_LENGTH,
          }),
    evidence:
      value.evidence === null
        ? null
        : cloneJson(value.evidence, `${path}.evidence`, budget),
  };
}

function normalizeOutbox(value, runId, budget, path) {
  assertPlainObject(value, path);
  assertExactKeys(value, OUTBOX_KEYS, path);
  assertDenseArray(value.entries, `${path}.entries`, MAX_DELIVERIES);
  const entries = value.entries.map((entry, index) =>
    normalizeDelivery(entry, runId, budget, `${path}.entries[${index}]`),
  );
  assertUnique(entries, "deliveryId", `${path}.entries`);
  return { entries };
}

function normalizeDelivery(value, runId, budget, path) {
  assertPlainObject(value, path);
  assertExactKeys(value, DELIVERY_KEYS, path);
  assertPlainObject(value.recipient, `${path}.recipient`);
  assertExactKeys(
    value.recipient,
    DELIVERY_RECIPIENT_KEYS,
    `${path}.recipient`,
  );
  const delivery = {
    deliveryId: strictString(value.deliveryId, `${path}.deliveryId`, {
      max: MAX_OPERATION_ID_LENGTH,
    }),
    kind: strictEnum(value.kind, DELIVERY_KINDS, `${path}.kind`),
    recipient: {
      type: strictEnum(
        value.recipient.type,
        DELIVERY_RECIPIENT_TYPES,
        `${path}.recipient.type`,
      ),
      id: strictId(value.recipient.id, `${path}.recipient.id`),
    },
    promptId: nullableId(value.promptId, `${path}.promptId`),
    state: strictEnum(value.state, DELIVERY_STATES, `${path}.state`),
    payload: cloneJson(value.payload, `${path}.payload`, budget),
    deliveredAt: nullableTimestamp(value.deliveredAt, `${path}.deliveredAt`),
  };
  assertPlainObject(delivery.payload, `${path}.payload`);
  if (
    delivery.deliveryId !==
    buildResourceDeliveryId({
      runId,
      kind: delivery.kind,
      recipient: delivery.recipient,
      promptId: delivery.promptId,
      payload: delivery.payload,
    })
  ) {
    fail(
      "RESOURCE_OPERATION_MALFORMED",
      "Delivery id does not match its exact recipient tuple",
      `${path}.deliveryId`,
    );
  }
  if (
    (delivery.state === "pending" && delivery.deliveredAt !== null) ||
    (delivery.state === "delivered" && delivery.deliveredAt === null)
  ) {
    fail(
      "RESOURCE_OPERATION_MALFORMED",
      "Delivery state and timestamp disagree",
      path,
    );
  }
  if (
    (delivery.kind === "report" &&
      (delivery.recipient.type !== "chat" || delivery.promptId !== null)) ||
    (delivery.kind === "prompt-ack" &&
      (delivery.recipient.type !== "user" || delivery.promptId === null))
  ) {
    fail(
      "RESOURCE_OPERATION_MALFORMED",
      "Delivery kind, recipient, and prompt identity disagree",
      path,
    );
  }
  return delivery;
}

function assertRecordInvariants(record) {
  const actorById = new Map(
    record.actors.map((actor) => [actor.actorId, actor]),
  );
  const latestAdoption = record.authorityAdoptions.at(-1) ?? null;
  if (latestAdoption && !sameJson(latestAdoption.toGuard, record.guard)) {
    fail(
      "RESOURCE_OPERATION_MALFORMED",
      "Current guard does not match authority adoption history",
      "operation.guard",
    );
  }
  for (const adoption of record.authorityAdoptions) {
    const reconciledPhase =
      adoption.phase === "planned" || adoption.phase === "applying";
    if (
      adoption.at < record.timestamps.createdAt ||
      adoption.at > record.timestamps.updatedAt ||
      adoption.appliedCount > record.appliedOperationIds.length ||
      adoption.appliedCount > record.plan.length ||
      (reconciledPhase &&
        record.plan.length > 0 &&
        adoption.observations.length === 0) ||
      (reconciledPhase &&
        !observationsMatchPrefix(
          record.plan,
          adoption.appliedCount,
          adoption.observations,
        )) ||
      (!reconciledPhase && adoption.observations.length > 0) ||
      (adoption.advancedOperationId !== null &&
        (adoption.phase !== "applying" ||
          adoption.appliedCount < 1 ||
          record.plan[adoption.appliedCount - 1]?.opId !==
            adoption.advancedOperationId))
    ) {
      fail(
        "RESOURCE_OPERATION_MALFORMED",
        "Authority adoption audit does not match the durable operation",
        "operation.authorityAdoptions",
      );
    }
  }
  const assignmentById = new Map(
    record.prompts.assignments.map((assignment) => [
      assignment.promptId,
      assignment,
    ]),
  );
  const resolvedPromptIds = new Set();
  for (const response of record.prompts.responses) {
    const assignment = assignmentById.get(response.promptId);
    if (!assignment) {
      fail(
        "RESOURCE_OPERATION_MALFORMED",
        "Response references an unknown assignment",
        "operation.prompts.responses",
      );
    }
    assertResponseMatchesAssignment(
      response,
      assignment,
      "operation.prompts.responses",
    );
    if (response.receivedAt < assignment.assignedAt) {
      fail(
        "RESOURCE_OPERATION_MALFORMED",
        "Response predates its assignment",
        "operation.prompts.responses",
      );
    }
    if (response.receivedAt > record.timestamps.updatedAt) {
      fail(
        "RESOURCE_OPERATION_MALFORMED",
        "Response follows the durable updatedAt checkpoint",
        "operation.prompts.responses",
      );
    }
    resolvedPromptIds.add(response.promptId);
  }
  for (const timeout of record.prompts.timeouts) {
    const assignment = assignmentById.get(timeout.promptId);
    if (!assignment || timeout.timedOutAt < assignment.deadlineAt) {
      fail(
        "RESOURCE_OPERATION_MALFORMED",
        "Timeout does not match an expired assignment",
        "operation.prompts.timeouts",
      );
    }
    if (timeout.timedOutAt > record.timestamps.updatedAt) {
      fail(
        "RESOURCE_OPERATION_MALFORMED",
        "Timeout follows the durable updatedAt checkpoint",
        "operation.prompts.timeouts",
      );
    }
    if (resolvedPromptIds.has(timeout.promptId)) {
      fail(
        "RESOURCE_OPERATION_MALFORMED",
        "A prompt cannot have both a response and a timeout",
        "operation.prompts",
      );
    }
    resolvedPromptIds.add(timeout.promptId);
  }
  for (const assignment of record.prompts.assignments) {
    const actor = actorById.get(assignment.actorId);
    if (!actor || actor.forageTarget !== assignment.forageTarget) {
      fail(
        "RESOURCE_OPERATION_MALFORMED",
        "Prompt assignment does not match an Actor snapshot",
        "operation.prompts.assignments",
      );
    }
    if (assignment.assignedAt !== record.timestamps.promptingAt) {
      fail(
        "RESOURCE_OPERATION_MALFORMED",
        "Prompt assignments must share the persisted prompting checkpoint",
        "operation.prompts.assignments",
      );
    }
  }

  const yieldByActor = new Map();
  for (const result of record.yields) {
    const actor = actorById.get(result.actorId);
    if (!actor || actor.forageTarget !== result.forageTarget) {
      fail(
        "RESOURCE_OPERATION_MALFORMED",
        "Resolved yield does not match an Actor snapshot",
        "operation.yields",
      );
    }
    const assignment = record.prompts.assignments.find(
      (entry) => entry.actorId === result.actorId,
    );
    if (assignment) {
      const response = record.prompts.responses.find(
        (entry) => entry.promptId === assignment.promptId,
      );
      const timeout = record.prompts.timeouts.find(
        (entry) => entry.promptId === assignment.promptId,
      );
      if (
        response &&
        (result.rollTotal !== response.rollTotal ||
          result.wisMod !== response.wisMod)
      ) {
        fail(
          "RESOURCE_OPERATION_MALFORMED",
          "Resolved yield does not match the persisted response",
          "operation.yields",
        );
      }
      if (
        timeout &&
        (result.rollTotal !== null ||
          result.wisMod !== null ||
          !isNeutralResolvedYield(result))
      ) {
        fail(
          "RESOURCE_OPERATION_MALFORMED",
          "Timed-out prompts must resolve to a neutral yield",
          "operation.yields",
        );
      }
      if (response?.skipped && !isNeutralResolvedYield(result)) {
        fail(
          "RESOURCE_OPERATION_MALFORMED",
          "Skipped prompts must resolve to a neutral yield",
          "operation.yields",
        );
      }
    }
    yieldByActor.set(result.actorId, result);
  }

  for (const operation of record.plan) {
    if (!actorById.has(operation.actorId)) {
      fail(
        "RESOURCE_OPERATION_MALFORMED",
        "Inventory operation references an unknown Actor snapshot",
        "operation.plan",
      );
    }
  }
  if (
    record.appliedOperationIds.some(
      (id, index) => record.plan[index]?.opId !== id,
    )
  ) {
    fail(
      "RESOURCE_OPERATION_MALFORMED",
      "Applied inventory markers must be a prefix of the exact plan",
      "operation.appliedOperationIds",
    );
  }

  const promptsResolved =
    resolvedPromptIds.size === record.prompts.assignments.length;
  const forageActors = record.actors.filter((actor) => actor.forageTarget);
  const legacyReview =
    record.phase === "needs-review" &&
    record.review?.code === "legacy-active-upkeep-outcome-unknown";
  if (
    !legacyReview &&
    (!record.environment || !record.initiator || record.actors.length < 1)
  ) {
    fail(
      "RESOURCE_OPERATION_MALFORMED",
      "Active runs require environment, initiator, and Actor snapshots",
      "operation",
    );
  }
  if (!legacyReview && record.kind === "forage" && forageActors.length < 1) {
    fail(
      "RESOURCE_OPERATION_MALFORMED",
      "Forage runs require at least one forager snapshot",
      "operation.actors",
    );
  }
  if (record.trigger === "calendar" && record.day === null && !legacyReview) {
    fail(
      "RESOURCE_OPERATION_MALFORMED",
      "Calendar operations require their reserved day",
      "operation.day",
    );
  }

  if (record.phase === "prepared") {
    assertEmptyCollections(record, ["prompts", "yields", "plan", "applied"]);
  } else if (record.phase === "prompting") {
    if (record.prompts.assignments.length < 1) {
      fail(
        "RESOURCE_OPERATION_MALFORMED",
        "Prompting phase requires persisted assignments",
        "operation.prompts.assignments",
      );
    }
    if (
      record.yields.length ||
      record.plan.length ||
      record.appliedOperationIds.length
    ) {
      fail(
        "RESOURCE_OPERATION_MALFORMED",
        "Prompting cannot contain a write plan",
        "operation.phase",
      );
    }
  } else if (["planned", "applying", "terminal"].includes(record.phase)) {
    if (!promptsResolved) {
      fail(
        "RESOURCE_OPERATION_MALFORMED",
        "Planning requires every persisted prompt to resolve",
        "operation.prompts",
      );
    }
    for (const actor of forageActors) {
      if (!yieldByActor.has(actor.actorId)) {
        fail(
          "RESOURCE_OPERATION_MALFORMED",
          "Planning requires a resolved yield for every forager",
          "operation.yields",
        );
      }
    }
  }

  if (record.phase === "planned" && record.appliedOperationIds.length) {
    fail(
      "RESOURCE_OPERATION_MALFORMED",
      "Planned operations cannot already be marked applied",
      "operation.appliedOperationIds",
    );
  }
  if (record.phase === "applying" && record.plan.length < 1) {
    fail(
      "RESOURCE_OPERATION_MALFORMED",
      "Applying phase requires an inventory plan",
      "operation.plan",
    );
  }
  if (
    record.phase === "terminal" &&
    record.appliedOperationIds.length !== record.plan.length
  ) {
    fail(
      "RESOURCE_OPERATION_MALFORMED",
      "Terminal operation has unconfirmed inventory writes",
      "operation.appliedOperationIds",
    );
  }

  assertPhaseTimestamps(record);
  if (record.phase === "needs-review") {
    if (
      !record.review ||
      record.review.at !== record.timestamps.needsReviewAt ||
      record.review.at !== record.timestamps.updatedAt
    ) {
      fail(
        "RESOURCE_OPERATION_MALFORMED",
        "Needs-review phase requires a matching review checkpoint",
        "operation.review",
      );
    }
    if (
      record.review.operationId !== null &&
      !record.plan.some(
        (operation) => operation.opId === record.review.operationId,
      )
    ) {
      fail(
        "RESOURCE_OPERATION_MALFORMED",
        "Review operation id does not belong to the exact plan",
        "operation.review.operationId",
      );
    }
  } else if (record.review !== null) {
    fail(
      "RESOURCE_OPERATION_MALFORMED",
      "Review details belong only to needs-review",
      "operation.review",
    );
  }
  if (record.phase === "terminal") {
    if (record.report === null || record.receipt === null) {
      fail(
        "RESOURCE_OPERATION_MALFORMED",
        "Terminal operation requires a durable report and receipt",
        "operation.receipt",
      );
    }
    if (record.receipt.runId !== record.runId) {
      fail(
        "RESOURCE_OPERATION_MALFORMED",
        "Terminal receipt belongs to a different run",
        "operation.receipt.runId",
      );
    }
    const reportDeliveries = record.outbox.entries.filter(
      (entry) => entry.kind === "report",
    );
    const acknowledgementDeliveries = record.outbox.entries.filter(
      (entry) => entry.kind === "prompt-ack",
    );
    if (
      reportDeliveries.length !== 1 ||
      record.outbox.entries[0]?.deliveryId !==
        reportDeliveries[0]?.deliveryId ||
      acknowledgementDeliveries.length !== record.prompts.assignments.length
    ) {
      fail(
        "RESOURCE_OPERATION_MALFORMED",
        "Terminal outbox requires one report then one acknowledgement per prompt",
        "operation.outbox",
      );
    }
    if (!sameJson(reportDeliveries[0].payload, record.report)) {
      fail(
        "RESOURCE_OPERATION_MALFORMED",
        "Report delivery payload must match the durable report exactly",
        "operation.outbox.entries[0].payload",
      );
    }
    for (let index = 0; index < record.prompts.assignments.length; index += 1) {
      const assignment = record.prompts.assignments[index];
      const delivery = record.outbox.entries[index + 1];
      if (
        delivery?.kind !== "prompt-ack" ||
        delivery.promptId !== assignment.promptId ||
        delivery.recipient.type !== "user" ||
        delivery.recipient.id !== assignment.userId
      ) {
        fail(
          "RESOURCE_OPERATION_MALFORMED",
          "Prompt acknowledgement outbox order/recipient is not exact",
          `operation.outbox.entries[${index + 1}]`,
        );
      }
      if (
        !sameJson(
          delivery.payload,
          expectedPromptAcknowledgement(record, assignment),
        )
      ) {
        fail(
          "RESOURCE_OPERATION_MALFORMED",
          "Prompt acknowledgement payload must match its durable outcome exactly",
          `operation.outbox.entries[${index + 1}].payload`,
        );
      }
    }
    let pendingSeen = false;
    let priorDeliveredAt = null;
    for (const delivery of record.outbox.entries) {
      if (delivery.state === "pending") {
        pendingSeen = true;
      } else if (pendingSeen) {
        fail(
          "RESOURCE_OPERATION_MALFORMED",
          "Delivered outbox entries must form an ordered prefix",
          "operation.outbox",
        );
      }
      if (
        delivery.deliveredAt !== null &&
        (delivery.deliveredAt < record.timestamps.terminalAt ||
          delivery.deliveredAt > record.timestamps.updatedAt)
      ) {
        fail(
          "RESOURCE_OPERATION_MALFORMED",
          "Delivery timestamp is outside the terminal window",
          "operation.outbox",
        );
      }
      if (
        delivery.deliveredAt !== null &&
        priorDeliveredAt !== null &&
        delivery.deliveredAt < priorDeliveredAt
      ) {
        fail(
          "RESOURCE_OPERATION_MALFORMED",
          "Delivery timestamps must follow outbox order",
          "operation.outbox",
        );
      }
      if (delivery.deliveredAt !== null) {
        priorDeliveredAt = delivery.deliveredAt;
      }
    }
  } else if (
    record.phase !== "needs-review" &&
    (record.report !== null || record.receipt !== null)
  ) {
    fail(
      "RESOURCE_OPERATION_MALFORMED",
      "Reports and receipts are not durable before terminal/review",
      "operation.report",
    );
  }
  if (record.phase !== "terminal" && record.outbox.entries.length > 0) {
    fail(
      "RESOURCE_OPERATION_MALFORMED",
      "Delivery outbox belongs only to terminal operations",
      "operation.outbox",
    );
  }
}

function assertPhaseTimestamps(record) {
  const timestamps = record.timestamps;
  const requireTimestamp = (field) => {
    if (timestamps[field] === null) {
      fail(
        "RESOURCE_OPERATION_MALFORMED",
        `Missing ${field} checkpoint`,
        `operation.timestamps.${field}`,
      );
    }
  };
  if (record.phase === "prepared") {
    assertNullTimestamps(timestamps, [
      "promptingAt",
      "plannedAt",
      "applyingAt",
      "needsReviewAt",
      "terminalAt",
    ]);
    return;
  }
  if (record.phase === "prompting") {
    requireTimestamp("promptingAt");
    assertNullTimestamps(timestamps, [
      "plannedAt",
      "applyingAt",
      "needsReviewAt",
      "terminalAt",
    ]);
    return;
  }
  if (record.phase === "planned") {
    requireTimestamp("plannedAt");
    assertNullTimestamps(timestamps, [
      "applyingAt",
      "needsReviewAt",
      "terminalAt",
    ]);
    return;
  }
  if (record.phase === "applying") {
    requireTimestamp("plannedAt");
    requireTimestamp("applyingAt");
    assertNullTimestamps(timestamps, ["needsReviewAt", "terminalAt"]);
    return;
  }
  if (record.phase === "terminal") {
    requireTimestamp("plannedAt");
    if (record.plan.length > 0) requireTimestamp("applyingAt");
    requireTimestamp("terminalAt");
    assertNullTimestamps(timestamps, ["needsReviewAt"]);
    return;
  }
  requireTimestamp("needsReviewAt");
  if (timestamps.terminalAt !== null) {
    fail(
      "RESOURCE_OPERATION_MALFORMED",
      "Needs-review cannot also be terminal",
      "operation.timestamps.terminalAt",
    );
  }
}

function assertEmptyCollections(record) {
  if (
    record.prompts.assignments.length ||
    record.prompts.responses.length ||
    record.prompts.timeouts.length ||
    record.yields.length ||
    record.plan.length ||
    record.appliedOperationIds.length
  ) {
    fail(
      "RESOURCE_OPERATION_MALFORMED",
      "Prepared phase must precede prompts and write planning",
      "operation.phase",
    );
  }
}

function assertNullTimestamps(timestamps, fields) {
  for (const field of fields) {
    if (timestamps[field] !== null) {
      fail(
        "RESOURCE_OPERATION_MALFORMED",
        `Unexpected ${field} checkpoint`,
        `operation.timestamps.${field}`,
      );
    }
  }
}

function assertInventoryActionInvariant(operation, path) {
  const { action, beforeQuantity, afterQuantity, itemSnapshot } = operation;
  if (action === "create") {
    if (beforeQuantity !== 0 || afterQuantity < 1 || !itemSnapshot) {
      fail(
        "RESOURCE_OPERATION_MALFORMED",
        "Create requires a missing before state and exact Item snapshot",
        path,
      );
    }
    assertPlainObject(itemSnapshot, `${path}.itemSnapshot`);
    if (
      itemSnapshot._id !== operation.itemId ||
      itemSnapshot.system === null ||
      typeof itemSnapshot.system !== "object" ||
      Array.isArray(itemSnapshot.system) ||
      itemSnapshot.system.quantity !== afterQuantity
    ) {
      fail(
        "RESOURCE_OPERATION_MALFORMED",
        "Create snapshot identity/quantity differs from its boundary",
        `${path}.itemSnapshot`,
      );
    }
    return;
  }
  if (itemSnapshot !== null) {
    fail(
      "RESOURCE_OPERATION_MALFORMED",
      "Only create operations retain an Item creation snapshot",
      `${path}.itemSnapshot`,
    );
  }
  if (action === "delete") {
    if (beforeQuantity < 1 || afterQuantity !== 0) {
      fail(
        "RESOURCE_OPERATION_MALFORMED",
        "Delete requires an existing before state and zero after state",
        path,
      );
    }
    return;
  }
  if (
    beforeQuantity < 1 ||
    afterQuantity < 1 ||
    beforeQuantity === afterQuantity
  ) {
    fail(
      "RESOURCE_OPERATION_MALFORMED",
      "Update requires two distinct positive quantities",
      path,
    );
  }
}

function normalizeInventoryObservation(value, path) {
  assertPlainObject(value, path);
  assertExactKeys(value, OBSERVATION_KEYS, path);
  const exists = strictBoolean(value.exists, `${path}.exists`);
  if (!exists) {
    if (value.quantity !== null || value.matchesResource !== null) {
      fail(
        "RESOURCE_OPERATION_MALFORMED",
        "Missing Item observations use null quantity and identity",
        path,
      );
    }
    return { exists: false, quantity: null, matchesResource: null };
  }
  return {
    exists: true,
    quantity: safeQuantity(value.quantity, `${path}.quantity`),
    matchesResource: strictBoolean(
      value.matchesResource,
      `${path}.matchesResource`,
    ),
  };
}

function normalizeAuthorityObservations(values, path) {
  assertDenseArray(values, path, MAX_INVENTORY_OPERATIONS);
  const observations = values.map((value, index) => {
    const observationPath = `${path}[${index}]`;
    assertPlainObject(value, observationPath);
    assertExactKeys(value, AUTHORITY_OBSERVATION_KEYS, observationPath);
    return {
      actorId: strictId(value.actorId, `${observationPath}.actorId`),
      itemId: strictId(value.itemId, `${observationPath}.itemId`),
      ...normalizeInventoryObservation(
        {
          exists: value.exists,
          quantity: value.quantity,
          matchesResource: value.matchesResource,
        },
        observationPath,
      ),
    };
  });
  const targets = new Set();
  for (let index = 0; index < observations.length; index += 1) {
    const key = inventoryTargetKey(observations[index]);
    if (targets.has(key)) {
      fail(
        "RESOURCE_OPERATION_ADOPTION_CONFLICT",
        "Authority observations contain a duplicate Item target",
        `${path}[${index}]`,
      );
    }
    targets.add(key);
  }
  return observations;
}

function reconcileAuthorityAdoption(record, observations) {
  const prefix =
    record.phase === "planned" ? 0 : record.appliedOperationIds.length;
  if (observationsMatchPrefix(record.plan, prefix, observations)) return null;
  const next = record.plan[prefix] ?? null;
  if (
    record.phase === "applying" &&
    next &&
    observationsMatchPrefix(record.plan, prefix + 1, observations)
  ) {
    return next.opId;
  }
  fail(
    "RESOURCE_OPERATION_ADOPTION_CONFLICT",
    "Canonical inventory does not match a safe authority checkpoint",
    "options.observations",
  );
}

function observationsMatchPrefix(plan, prefix, observations) {
  const expected = expectedTargetObservations(plan, prefix);
  if (expected.size !== observations.length) return false;
  for (const observation of observations) {
    const target = expected.get(inventoryTargetKey(observation));
    if (!target || !sameJson(target, observation)) return false;
  }
  return true;
}

function expectedTargetObservations(plan, prefix) {
  const expected = new Map();
  for (let index = 0; index < plan.length; index += 1) {
    const operation = plan[index];
    const key = inventoryTargetKey(operation);
    if (!expected.has(key)) {
      expected.set(key, {
        actorId: operation.actorId,
        itemId: operation.itemId,
        ...(operation.action === "create"
          ? { exists: false, quantity: null, matchesResource: null }
          : {
              exists: true,
              quantity: operation.beforeQuantity,
              matchesResource: true,
            }),
      });
    }
    if (index >= prefix) continue;
    expected.set(key, {
      actorId: operation.actorId,
      itemId: operation.itemId,
      ...(operation.action === "delete"
        ? { exists: false, quantity: null, matchesResource: null }
        : {
            exists: true,
            quantity: operation.afterQuantity,
            matchesResource: true,
          }),
    });
  }
  return expected;
}

function inventoryTargetKey(value) {
  return JSON.stringify([value.actorId, value.itemId]);
}

function observationMatchesBefore(operation, observed) {
  if (operation.action === "create") return observed.exists === false;
  return (
    observed.exists === true &&
    observed.matchesResource === true &&
    observed.quantity === operation.beforeQuantity
  );
}

function observationMatchesAfter(operation, observed) {
  if (operation.action === "delete") return observed.exists === false;
  return (
    observed.exists === true &&
    observed.matchesResource === true &&
    observed.quantity === operation.afterQuantity
  );
}

function pendingPromptIdsFor(record) {
  const resolved = new Set([
    ...record.prompts.responses.map((entry) => entry.promptId),
    ...record.prompts.timeouts.map((entry) => entry.promptId),
  ]);
  return record.prompts.assignments
    .map((entry) => entry.promptId)
    .filter((id) => !resolved.has(id));
}

function expectedPromptAcknowledgement(record, assignment) {
  const response =
    record.prompts.responses.find(
      (entry) => entry.promptId === assignment.promptId,
    ) ?? null;
  const timeout =
    record.prompts.timeouts.find(
      (entry) => entry.promptId === assignment.promptId,
    ) ?? null;
  const resolvedYield =
    record.yields.find((entry) => entry.actorId === assignment.actorId) ?? null;
  if ((!response && !timeout) || !resolvedYield) {
    fail(
      "RESOURCE_OPERATION_MALFORMED",
      "Prompt acknowledgement requires a persisted outcome and yield",
      "operation.prompts",
    );
  }
  return {
    version: 1,
    runId: record.runId,
    promptId: assignment.promptId,
    actorId: assignment.actorId,
    outcome: response ? "response" : "timeout",
    response,
    timeout,
    yield: resolvedYield,
  };
}

function isNeutralResolvedYield(result) {
  return (
    result.food === 0 &&
    result.water === 0 &&
    result.foodSuccess === false &&
    result.waterSuccess === false &&
    result.suppressedFood === false &&
    result.suppressedWater === false
  );
}

function assertResponseMatchesAssignment(response, assignment, path) {
  if (
    response.actorId !== assignment.actorId ||
    response.userId !== assignment.userId
  ) {
    fail(
      "RESOURCE_OPERATION_PROMPT_CONFLICT",
      "Response identity differs from its prompt assignment",
      path,
    );
  }
}

function samePromptAnswer(left, right) {
  return (
    left.promptId === right.promptId &&
    left.actorId === right.actorId &&
    left.userId === right.userId &&
    left.rollTotal === right.rollTotal &&
    left.wisMod === right.wisMod &&
    left.skipped === right.skipped
  );
}

function assertMatchingGuard(record, guard, path) {
  let candidate;
  try {
    candidate = normalizeGuard(guard, path);
  } catch (error) {
    if (error instanceof ResourceOperationLedgerError) {
      fail(
        "RESOURCE_OPERATION_GUARD_MISMATCH",
        "A complete current authority guard is required",
        path,
      );
    }
    throw error;
  }
  if (!sameJson(record.guard, candidate)) {
    fail(
      "RESOURCE_OPERATION_GUARD_MISMATCH",
      "Current authority guard differs from the durable run guard",
      path,
    );
  }
}

function assertKindTrigger(kind, trigger) {
  const valid =
    (kind === "forage" && trigger === "forage") ||
    (kind === "upkeep" && (trigger === "manual" || trigger === "calendar"));
  if (!valid) {
    fail(
      "RESOURCE_OPERATION_MALFORMED",
      "Operation kind and trigger are incompatible",
      "operation.trigger",
    );
  }
}

function projectLegacyEnvironment(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const id = cleanLegacyId(value.id);
  const label = cleanLegacyText(value.label, MAX_LABEL_LENGTH);
  if (!id && !label) return null;
  const dc = cleanLegacyNumber(value.dc);
  return {
    id,
    label: label ?? id ?? "Environment not recorded",
    dc,
    foodDc: cleanLegacyNumber(value.foodDc) ?? dc,
    waterDc: cleanLegacyNumber(value.waterDc) ?? dc,
  };
}

function projectLegacyInitiator(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const userId = cleanLegacyId(value.userId);
  if (!userId) return null;
  return {
    userId,
    name: cleanLegacyText(value.name, MAX_LABEL_LENGTH) ?? "GM",
  };
}

function projectLegacyActors(values) {
  if (!Array.isArray(values)) return [];
  const actors = [];
  const seen = new Set();
  for (const value of values) {
    if (!value || typeof value !== "object" || Array.isArray(value)) continue;
    const actorId = cleanLegacyId(value.actorId);
    if (!actorId || seen.has(actorId)) continue;
    seen.add(actorId);
    actors.push({
      actorId,
      name: cleanLegacyText(value.name, MAX_LABEL_LENGTH) ?? "Character",
      role: ACTOR_ROLES.has(value.role) ? value.role : "participant",
      forageTarget: FORAGE_TARGETS.has(value.forageTarget)
        ? value.forageTarget
        : null,
    });
    if (actors.length >= MAX_ACTORS) break;
  }
  return actors;
}

function cleanLegacyId(value) {
  const id = typeof value === "string" ? value.trim() : "";
  return id && id.length <= MAX_ID_LENGTH ? id : null;
}

function cleanLegacyText(value, max) {
  const text = typeof value === "string" ? value.trim() : "";
  return text ? text.slice(0, max) : null;
}

function cleanLegacyNumber(value) {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function nullableJsonObject(value, path, budget) {
  if (value === null) return null;
  assertPlainObject(value, path);
  return cloneJson(value, path, budget);
}

function assertSupportedVersion(value, path) {
  if (Number.isSafeInteger(value) && value > RESOURCE_OPERATION_VERSION) {
    fail(
      "RESOURCE_OPERATION_FUTURE_VERSION",
      `Unsupported resource operation version ${value}`,
      `${path}.version`,
    );
  }
  if (value !== RESOURCE_OPERATION_VERSION) {
    fail(
      "RESOURCE_OPERATION_MALFORMED",
      `Expected resource operation version ${RESOURCE_OPERATION_VERSION}`,
      `${path}.version`,
    );
  }
}

function assertPlainObject(value, path) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    fail("RESOURCE_OPERATION_MALFORMED", "Expected a plain object", path);
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    fail("RESOURCE_OPERATION_MALFORMED", "Non-JSON object prototype", path);
  }
}

function assertExactKeys(value, expected, path) {
  const actual = Reflect.ownKeys(value);
  const wanted = new Set(expected);
  if (
    actual.some((key) => typeof key !== "string") ||
    actual.length !== wanted.size ||
    actual.some((key) => !wanted.has(key))
  ) {
    fail(
      "RESOURCE_OPERATION_MALFORMED",
      "Object fields do not match the v1 schema",
      path,
    );
  }
  for (const key of actual) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (
      !descriptor ||
      !("value" in descriptor) ||
      descriptor.enumerable !== true
    ) {
      fail(
        "RESOURCE_OPERATION_MALFORMED",
        "Accessor or hidden fields are not JSON data",
        `${path}.${key}`,
      );
    }
  }
}

function assertDenseArray(value, path, max) {
  if (!Array.isArray(value) || value.length > max) {
    fail("RESOURCE_OPERATION_BOUNDS", "Invalid bounded array", path);
  }
  const keys = Reflect.ownKeys(value);
  const expected = new Set([
    ...Array.from({ length: value.length }, (_, index) => String(index)),
    "length",
  ]);
  if (
    keys.length !== expected.size ||
    keys.some((key) => typeof key !== "string" || !expected.has(key))
  ) {
    fail(
      "RESOURCE_OPERATION_MALFORMED",
      "Arrays may contain only dense indexed JSON values",
      path,
    );
  }
  for (let index = 0; index < value.length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(value, index);
    if (
      !descriptor ||
      !("value" in descriptor) ||
      descriptor.enumerable !== true
    ) {
      fail(
        "RESOURCE_OPERATION_MALFORMED",
        "Sparse or accessor arrays are not JSON data",
        `${path}[${index}]`,
      );
    }
  }
}

function assertUnique(values, key, path) {
  const seen = new Set();
  for (const value of values) {
    if (seen.has(value[key])) {
      fail("RESOURCE_OPERATION_MALFORMED", `Duplicate ${key}`, path);
    }
    seen.add(value[key]);
  }
}

function orderIndex(order, value) {
  return order.has(value.promptId)
    ? order.get(value.promptId)
    : Number.MAX_SAFE_INTEGER;
}

function strictId(value, path) {
  return strictString(value, path, { max: MAX_ID_LENGTH });
}

function nullableId(value, path) {
  return value === null ? null : strictId(value, path);
}

function strictString(value, path, { max = MAX_JSON_STRING_LENGTH } = {}) {
  if (
    typeof value !== "string" ||
    value.length < 1 ||
    value.length > max ||
    value !== value.trim()
  ) {
    fail("RESOURCE_OPERATION_MALFORMED", "Invalid bounded string", path);
  }
  return value;
}

function strictEnum(value, values, path) {
  const allowed = values instanceof Set ? values : new Set(values);
  if (!allowed.has(value)) {
    fail("RESOURCE_OPERATION_MALFORMED", "Unsupported enum value", path);
  }
  return value;
}

function nullableEnum(value, values, path) {
  return value === null ? null : strictEnum(value, values, path);
}

function strictBoolean(value, path) {
  if (typeof value !== "boolean") {
    fail("RESOURCE_OPERATION_MALFORMED", "Expected a boolean", path);
  }
  return value;
}

function safeTimestamp(value, path) {
  return safeInteger(value, path, { min: 0 });
}

function nullableTimestamp(value, path) {
  return value === null ? null : safeTimestamp(value, path);
}

function safeQuantity(value, path) {
  return safeInteger(value, path, { min: 0, max: MAX_QUANTITY });
}

function safeInteger(
  value,
  path,
  { min = Number.MIN_SAFE_INTEGER, max = Number.MAX_SAFE_INTEGER } = {},
) {
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    fail(
      "RESOURCE_OPERATION_MALFORMED",
      "Expected a bounded safe integer",
      path,
    );
  }
  return value;
}

function nullableSafeInteger(value, path, bounds = {}) {
  return value === null ? null : safeInteger(value, path, bounds);
}

function safeFiniteNumber(
  value,
  path,
  { min = -Number.MAX_VALUE, max = Number.MAX_VALUE } = {},
) {
  if (
    typeof value !== "number" ||
    !Number.isFinite(value) ||
    value < min ||
    value > max
  ) {
    fail(
      "RESOURCE_OPERATION_MALFORMED",
      "Expected a bounded finite number",
      path,
    );
  }
  return Object.is(value, -0) ? 0 : value;
}

function nullableFiniteNumber(value, path, bounds = {}) {
  return value === null ? null : safeFiniteNumber(value, path, bounds);
}

function createJsonBudget() {
  return { nodes: 0, stringChars: 0, keyChars: 0 };
}

/** Strict JSON clone with aggregate limits and without invoking accessors. */
function cloneJson(value, path, budget, depth = 0) {
  budget.nodes += 1;
  if (depth > MAX_JSON_DEPTH || budget.nodes > MAX_JSON_NODES) {
    fail(
      "RESOURCE_OPERATION_BOUNDS",
      "JSON value exceeds structural bounds",
      path,
    );
  }
  if (value === null || typeof value === "boolean") return value;
  if (typeof value === "string") {
    if (value.length > MAX_JSON_STRING_LENGTH) {
      fail("RESOURCE_OPERATION_BOUNDS", "JSON string is too long", path);
    }
    budget.stringChars += value.length;
    if (budget.stringChars > MAX_JSON_STRING_CHARS) {
      fail(
        "RESOURCE_OPERATION_BOUNDS",
        "JSON strings exceed aggregate bounds",
        path,
      );
    }
    return value;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      fail("RESOURCE_OPERATION_MALFORMED", "JSON numbers must be finite", path);
    }
    return Object.is(value, -0) ? 0 : value;
  }
  if (Array.isArray(value)) {
    assertDenseArray(value, path, MAX_JSON_COLLECTION_SIZE);
    return value.map((entry, index) =>
      cloneJson(entry, `${path}[${index}]`, budget, depth + 1),
    );
  }
  assertPlainObject(value, path);
  const keys = Reflect.ownKeys(value);
  if (
    keys.length > MAX_JSON_COLLECTION_SIZE ||
    keys.some((key) => typeof key !== "string")
  ) {
    fail("RESOURCE_OPERATION_BOUNDS", "JSON object is too large", path);
  }
  const copy = {};
  for (const key of keys) {
    if (key.length > MAX_JSON_KEY_LENGTH) {
      fail("RESOURCE_OPERATION_BOUNDS", "JSON object key is too long", path);
    }
    budget.keyChars += key.length;
    if (budget.keyChars > MAX_JSON_KEY_CHARS) {
      fail(
        "RESOURCE_OPERATION_BOUNDS",
        "JSON object keys exceed aggregate bounds",
        path,
      );
    }
    if (key === "__proto__" || key === "prototype" || key === "constructor") {
      fail(
        "RESOURCE_OPERATION_MALFORMED",
        "Unsafe JSON object key",
        `${path}.${key}`,
      );
    }
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (
      !descriptor ||
      !("value" in descriptor) ||
      descriptor.enumerable !== true
    ) {
      fail(
        "RESOURCE_OPERATION_MALFORMED",
        "Accessor or hidden fields are not JSON data",
        `${path}.${key}`,
      );
    }
    copy[key] = cloneJson(
      descriptor.value,
      `${path}.${key}`,
      budget,
      depth + 1,
    );
  }
  return copy;
}

function mutableClone(value) {
  if (value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map(mutableClone);
  return Object.fromEntries(
    Object.entries(value).map(([key, entry]) => [key, mutableClone(entry)]),
  );
}

function deepFreeze(value) {
  if (value === null || typeof value !== "object" || Object.isFrozen(value)) {
    return value;
  }
  for (const entry of Object.values(value)) deepFreeze(entry);
  return Object.freeze(value);
}

function sameJson(left, right) {
  return stableJson(left) === stableJson(right);
}

function stableJson(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  const keys = Object.keys(value).sort();
  return `{${keys
    .map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`)
    .join(",")}}`;
}

function jsonFingerprint(namespace, value) {
  const canonical = stableJson(value);
  return `${namespace}-${[0x811c9dc5, 0x9e3779b9, 0x85ebca6b, 0xc2b2ae35]
    .map((seed) => stableHashChunk(canonical, seed))
    .join("")}`;
}

function contextFingerprint(snapshot) {
  return jsonFingerprint("resource-context-v1", snapshot);
}

function stableHashChunk(value, seed) {
  let hash = seed >>> 0;
  for (const character of String(value ?? "")) {
    hash ^= character.codePointAt(0);
    hash = Math.imul(hash, 0x01000193);
  }
  hash ^= hash >>> 16;
  hash = Math.imul(hash, 0x7feb352d);
  hash ^= hash >>> 15;
  return (hash >>> 0).toString(16).padStart(8, "0");
}

function decision(action, details = {}) {
  return deepFreeze({ action, ...mutableClone(details) });
}

function fail(code, message, path) {
  throw new ResourceOperationLedgerError(code, message, path);
}
