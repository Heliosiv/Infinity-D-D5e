import assert from "node:assert/strict";

import {
  CRITICAL_INJURY_EVENTS,
  validateCriticalInjuryPayload,
} from "./injury/socket.js";

const base = {
  actorId: "actor-1",
  originUserId: "player-1",
};

assert.deepEqual(
  validateCriticalInjuryPayload({
    ...base,
    type: CRITICAL_INJURY_EVENTS.ROLL_REQUEST,
    pendingId: "pending-1",
    targetUserId: "gm-1",
  }),
  { ok: true, reason: null },
);
assert.equal(
  validateCriticalInjuryPayload({
    ...base,
    type: CRITICAL_INJURY_EVENTS.ROLL_REQUEST,
    pendingId: "pending-1",
    targetUserId: "gm-1",
    rollTotal: 61,
  }).reason,
  "client-roll-total-not-allowed",
);
assert.equal(
  validateCriticalInjuryPayload({
    ...base,
    type: CRITICAL_INJURY_EVENTS.ROLL_REQUEST,
    pendingId: "pending-1",
  }).reason,
  "invalid-target-user-id",
);
assert.equal(
  validateCriticalInjuryPayload({
    ...base,
    type: CRITICAL_INJURY_EVENTS.PROMPT,
    pendingId: "pending-1",
  }).reason,
  "invalid-target-user-id",
);
assert.deepEqual(
  validateCriticalInjuryPayload({
    ...base,
    type: CRITICAL_INJURY_EVENTS.ROLL_FAILURE,
    pendingId: "pending-1",
    targetUserId: "player-1",
    retryable: true,
    message: "The roll remains pending.",
  }),
  { ok: true, reason: null },
);
assert.equal(
  validateCriticalInjuryPayload({
    ...base,
    type: CRITICAL_INJURY_EVENTS.ROLL_FAILURE,
    pendingId: "pending-1",
    targetUserId: "player-1",
    retryable: "yes",
    message: "The roll remains pending.",
  }).reason,
  "invalid-failure-retry-state",
);
assert.deepEqual(
  validateCriticalInjuryPayload({
    ...base,
    type: CRITICAL_INJURY_EVENTS.TREATMENT_REQUEST,
    injuryId: "injury-1",
    treatmentId: "treatment-1",
    targetUserId: "gm-1",
  }),
  { ok: true, reason: null },
);
assert.equal(
  validateCriticalInjuryPayload({
    ...base,
    type: CRITICAL_INJURY_EVENTS.TREATMENT_REQUEST,
    injuryId: "injury-1",
    treatmentId: "treatment-1",
    targetUserId: "gm-1",
    healerActorId: "actor-2",
  }).reason,
  "client-treatment-data-not-allowed",
);
assert.deepEqual(
  validateCriticalInjuryPayload({
    ...base,
    type: CRITICAL_INJURY_EVENTS.TREATMENT_RESULT,
    injuryId: "injury-1",
    treatmentId: "treatment-1",
    targetUserId: "player-1",
    success: false,
    retryable: true,
    message: "Retrying this stored treatment is safe.",
    resumeTreatmentId: "treatment-unresolved",
  }),
  { ok: true, reason: null },
);
assert.equal(
  validateCriticalInjuryPayload({
    ...base,
    type: CRITICAL_INJURY_EVENTS.TREATMENT_RESULT,
    injuryId: "injury-1",
    treatmentId: "treatment-1",
    targetUserId: "player-1",
    success: false,
    retryable: true,
    message: "Retrying this stored treatment is safe.",
    resumeTreatmentId: "",
  }).reason,
  "invalid-treatment-resume-id",
);
assert.equal(
  validateCriticalInjuryPayload({
    ...base,
    type: CRITICAL_INJURY_EVENTS.REST_COMPLETED,
    restId: "rest-actor-1-message-1",
    restMessageId: "message-1",
    targetUserId: "gm-1",
    longRest: false,
  }).reason,
  "invalid-rest-kind",
);
assert.deepEqual(
  validateCriticalInjuryPayload({
    ...base,
    type: CRITICAL_INJURY_EVENTS.REST_COMPLETED,
    restId: "rest-actor-1-message-1",
    restMessageId: "message-1",
    targetUserId: "gm-1",
    longRest: true,
  }),
  { ok: true, reason: null },
);
assert.equal(
  validateCriticalInjuryPayload({
    ...base,
    type: CRITICAL_INJURY_EVENTS.REST_COMPLETED,
    restMessageId: "message-1",
    targetUserId: "gm-1",
    longRest: true,
  }).ok,
  false,
  "a rest request without a durable correlation id fails closed",
);
assert.equal(
  validateCriticalInjuryPayload({
    ...base,
    type: CRITICAL_INJURY_EVENTS.REST_COMPLETED,
    restId: "rest-actor-1-message-1",
    restMessageId: "message-1",
    longRest: true,
  }).ok,
  false,
  "a rest request must target the active GM",
);
assert.equal(
  validateCriticalInjuryPayload({
    ...base,
    type: CRITICAL_INJURY_EVENTS.REST_COMPLETED,
    restId: "rest-actor-1-message-1",
    restMessageId: "message-1",
    targetUserId: "gm-1",
    longRest: true,
    saveTotals: [1, 20],
  }).ok,
  false,
  "the client cannot supply Infection save totals or outcomes",
);
assert.equal(
  validateCriticalInjuryPayload({
    ...base,
    type: CRITICAL_INJURY_EVENTS.REST_COMPLETED,
    restId: "rest-actor-1-a-different-message",
    restMessageId: "message-1",
    targetUserId: "gm-1",
    longRest: true,
  }).ok,
  false,
  "the rest id must be derived from the Actor and server message ids",
);
assert.equal(
  validateCriticalInjuryPayload({
    ...base,
    type: CRITICAL_INJURY_EVENTS.REST_COMPLETED,
    restId: "rest-actor-1-message-1",
    restMessageId: "message-1",
    targetUserId: "gm-1",
    longRest: true,
    extra: "not-allowed",
  }).ok,
  false,
  "rest requests use an exact schema",
);
assert.deepEqual(
  validateCriticalInjuryPayload({
    ...base,
    type: CRITICAL_INJURY_EVENTS.REST_RESULT,
    restId: "rest-actor-1-message-1",
    targetUserId: "player-1",
    success: true,
    retryable: false,
    message: "The Infection rest check is complete.",
  }),
  { ok: true, reason: null },
);
assert.equal(
  validateCriticalInjuryPayload({
    ...base,
    type: CRITICAL_INJURY_EVENTS.REST_RESULT,
    restId: "rest-actor-1-message-1",
    targetUserId: "player-1",
    success: true,
    retryable: false,
    message: "The Infection rest check is complete.",
    outcome: { saveTotal: 20 },
  }).ok,
  false,
  "rest acknowledgements cannot leak private save outcomes",
);

process.stdout.write("critical injury socket payload validation passed\n");
