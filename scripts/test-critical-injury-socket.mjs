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
    rollTotal: 100,
  }),
  { ok: true, reason: null },
);
assert.equal(
  validateCriticalInjuryPayload({
    ...base,
    type: CRITICAL_INJURY_EVENTS.ROLL_REQUEST,
    pendingId: "pending-1",
    rollTotal: 101,
  }).reason,
  "invalid-injury-roll",
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
    type: CRITICAL_INJURY_EVENTS.TREATMENT_REQUEST,
    injuryId: "injury-1",
  }),
  { ok: true, reason: null },
);
assert.equal(
  validateCriticalInjuryPayload({
    ...base,
    type: CRITICAL_INJURY_EVENTS.REST_COMPLETED,
    longRest: false,
  }).reason,
  "invalid-rest-kind",
);

process.stdout.write("critical injury socket payload validation passed\n");
