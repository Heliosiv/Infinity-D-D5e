import assert from "node:assert/strict";

import {
  assertDowntimeWorkflowStateInvariant,
  canTransitionDowntimeWorkflow,
  isDowntimeTerminalState,
  transitionDowntimeWorkflowState,
} from "./downtime/state-machine.js";

const collecting = {
  id: "block-1",
  state: "collecting",
  plan: null,
  operationLedger: {},
};

assert.equal(canTransitionDowntimeWorkflow("collecting", "locked"), true);
assert.equal(canTransitionDowntimeWorkflow("locked", "planned"), true);
assert.equal(canTransitionDowntimeWorkflow("planned", "applying"), true);
assert.equal(canTransitionDowntimeWorkflow("applying", "completed"), true);
assert.equal(canTransitionDowntimeWorkflow("applying", "cancelled"), false);
assert.equal(canTransitionDowntimeWorkflow("completed", "collecting"), false);
assert.equal(isDowntimeTerminalState("completed"), true);
assert.equal(isDowntimeTerminalState("needs-review"), false);

const locked = transitionDowntimeWorkflowState(collecting, "locked", {
  at: 100,
  by: "gm-1",
});
assert.equal(locked.state, "locked");
assert.equal(locked.lockedAt, 100);
assert.equal(locked.updatedBy, "gm-1");
assert.deepEqual(
  transitionDowntimeWorkflowState(locked, "locked", { at: 999 }),
  locked,
  "duplicate state requests are idempotent",
);

assert.throws(
  () => transitionDowntimeWorkflowState(locked, "applying"),
  /TransitionInvalid/,
);
assert.throws(
  () =>
    transitionDowntimeWorkflowState(
      { ...locked, plan: null, operationLedger: {} },
      "planned",
    ),
  /PlanRequired/,
);

const planned = transitionDowntimeWorkflowState(
  {
    ...locked,
    plan: { operations: [] },
    operationLedger: {},
  },
  "planned",
  { at: 200 },
);
assert.equal(planned.state, "planned");
assert.equal(planned.plannedAt, 200);
assert.equal(assertDowntimeWorkflowStateInvariant(planned), true);

const applying = transitionDowntimeWorkflowState(planned, "applying", {
  at: 300,
});
const review = transitionDowntimeWorkflowState(applying, "needs-review", {
  at: 400,
  reason: "merchant stock changed",
});
assert.equal(review.reviewReason, "merchant stock changed");
assert.equal(
  transitionDowntimeWorkflowState(review, "applying", { at: 500 }).state,
  "applying",
);

process.stdout.write("downtime workflow state machine passed\n");
