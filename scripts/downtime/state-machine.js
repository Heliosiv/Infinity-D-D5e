/**
 * Pure lifecycle rules for one authoritative downtime block.
 *
 * The workflow store owns persistence. This module deliberately contains no
 * Foundry globals so lifecycle validation can be reused by the GM service and
 * exercised by the Node test harness.
 */

export const DOWNTIME_WORKFLOW_STATES = Object.freeze([
  "collecting",
  "locked",
  "planned",
  "applying",
  "completed",
  "cancelled",
  "needs-review",
]);

export const DOWNTIME_TERMINAL_STATES = Object.freeze([
  "completed",
  "cancelled",
]);

const STATE_SET = new Set(DOWNTIME_WORKFLOW_STATES);
const TERMINAL_STATE_SET = new Set(DOWNTIME_TERMINAL_STATES);

export const DOWNTIME_WORKFLOW_TRANSITIONS = Object.freeze({
  collecting: Object.freeze(["locked", "cancelled"]),
  locked: Object.freeze(["planned", "cancelled"]),
  planned: Object.freeze(["applying", "cancelled", "needs-review"]),
  applying: Object.freeze(["completed", "needs-review"]),
  "needs-review": Object.freeze(["applying", "cancelled"]),
  completed: Object.freeze([]),
  cancelled: Object.freeze([]),
});

const TRANSITION_TIMESTAMP_FIELDS = Object.freeze({
  locked: "lockedAt",
  planned: "plannedAt",
  applying: "applyingAt",
  completed: "completedAt",
  cancelled: "cancelledAt",
  "needs-review": "needsReviewAt",
});

function clone(value) {
  if (value == null) return value;
  return (
    globalThis.foundry?.utils?.deepClone?.(value) ?? structuredClone(value)
  );
}

function toId(value) {
  const id = String(value ?? "").trim();
  return id && id.length <= 160 ? id : "";
}

function toTimestamp(value) {
  const timestamp = Number(value);
  return Number.isSafeInteger(timestamp) && timestamp >= 0
    ? timestamp
    : Date.now();
}

export function isDowntimeWorkflowState(value) {
  return STATE_SET.has(String(value ?? ""));
}

export function isDowntimeTerminalState(value) {
  return TERMINAL_STATE_SET.has(String(value ?? ""));
}

export function canTransitionDowntimeWorkflow(fromState, toState) {
  const from = String(fromState ?? "");
  const to = String(toState ?? "");
  if (!isDowntimeWorkflowState(from) || !isDowntimeWorkflowState(to)) {
    return false;
  }
  if (from === to) return true;
  return DOWNTIME_WORKFLOW_TRANSITIONS[from].includes(to);
}

export function assertDowntimeWorkflowTransition(fromState, toState) {
  if (canTransitionDowntimeWorkflow(fromState, toState)) return true;
  throw new Error(
    `DowntimeWorkflowTransitionInvalid:${String(fromState)}:${String(toState)}`,
  );
}

/**
 * Enforce the durable-data requirements implied by a workflow state.
 * Planned and later records must carry the exact immutable plan, while an
 * applying/completed record also needs an operation ledger.
 */
export function assertDowntimeWorkflowStateInvariant(block) {
  if (!block || typeof block !== "object" || Array.isArray(block)) {
    throw new Error("DowntimeWorkflowBlockInvalid");
  }
  if (!toId(block.id)) throw new Error("DowntimeWorkflowBlockIdInvalid");
  if (!isDowntimeWorkflowState(block.state)) {
    throw new Error("DowntimeWorkflowStateInvalid");
  }
  if (
    ["planned", "applying", "completed", "needs-review"].includes(
      block.state,
    ) &&
    (!block.plan || typeof block.plan !== "object" || Array.isArray(block.plan))
  ) {
    throw new Error("DowntimeWorkflowPlanRequired");
  }
  if (
    ["applying", "completed", "needs-review"].includes(block.state) &&
    (!block.operationLedger ||
      typeof block.operationLedger !== "object" ||
      Array.isArray(block.operationLedger))
  ) {
    throw new Error("DowntimeWorkflowOperationLedgerRequired");
  }
  return true;
}

/**
 * Return a transitioned copy with consistent audit timestamps. Replaying the
 * same transition is a no-op, which makes duplicate socket requests safe.
 */
export function transitionDowntimeWorkflowState(
  block,
  nextState,
  { at = null, by = "", reason = "" } = {},
) {
  assertDowntimeWorkflowStateInvariant(block);
  const next = String(nextState ?? "");
  assertDowntimeWorkflowTransition(block.state, next);
  if (block.state === next) return clone(block);

  const transitioned = {
    ...clone(block),
    state: next,
    updatedAt: toTimestamp(at),
  };
  const actorId = toId(by);
  if (actorId) transitioned.updatedBy = actorId;
  const timestampField = TRANSITION_TIMESTAMP_FIELDS[next];
  if (timestampField) transitioned[timestampField] = transitioned.updatedAt;
  if (next === "needs-review") {
    transitioned.reviewReason = String(reason ?? "")
      .trim()
      .slice(0, 500);
  }
  if (next === "cancelled") {
    transitioned.cancelReason = String(reason ?? "")
      .trim()
      .slice(0, 500);
  }

  assertDowntimeWorkflowStateInvariant(transitioned);
  return transitioned;
}
