import assert from "node:assert/strict";

const {
  completeSharpeningLifecycleEvent,
  enqueueSharpeningLifecycleEvent,
  failSharpeningLifecycleEvent,
  normalizeSharpeningLifecycle,
} = await import("./downtime/sharpening-lifecycle.js");

const damage = {
  eventId: "damage-event-1",
  kind: "damage",
  actorId: "actor-1",
  itemId: "weapon-1",
  effectId: "effect-1",
  operationId: "operation-1",
  rollId: "roll-1",
  originUserId: "player-1",
  acceptedAt: 100,
};

const queued = enqueueSharpeningLifecycleEvent({}, damage);
assert.equal(queued.status, "queued");
assert.equal(queued.state.pending.length, 1);

const duplicate = enqueueSharpeningLifecycleEvent(queued.state, damage);
assert.equal(duplicate.status, "pending");
assert.equal(duplicate.state.pending.length, 1);

const failed = failSharpeningLifecycleEvent(duplicate.state, damage.eventId, {
  at: 200,
  reason: "effect-update-failed",
});
assert.equal(failed.pending[0].attempts, 1);
assert.equal(failed.pending[0].lastAttemptAt, 200);
assert.equal(failed.pending[0].lastError, "effect-update-failed");

const completed = completeSharpeningLifecycleEvent(failed, damage.eventId, {
  at: 300,
  outcome: "consumed",
});
assert.equal(completed.pending.length, 0);
assert.deepEqual(completed.completed[0], {
  eventId: damage.eventId,
  completedAt: 300,
  outcome: "consumed",
});

const replay = enqueueSharpeningLifecycleEvent(completed, damage);
assert.equal(replay.status, "completed");
assert.equal(replay.state.pending.length, 0);

const rest = enqueueSharpeningLifecycleEvent(completed, {
  eventId: "rest-event-1",
  kind: "long-rest",
  actorId: "actor-1",
  itemId: "weapon-1",
  effectId: "effect-1",
  operationId: "operation-1",
  originUserId: "player-1",
  acceptedAt: 400,
});
assert.equal(rest.status, "queued");
assert.equal(rest.state.pending[0].itemId, "weapon-1");
assert.equal(rest.state.pending[0].effectId, "effect-1");
assert.equal(rest.state.pending[0].operationId, "operation-1");
assert.equal(rest.state.pending[0].rollId, null);

const bounded = normalizeSharpeningLifecycle({
  pending: Array.from({ length: 205 }, (_, index) => ({
    ...damage,
    eventId: `pending-${index}`,
    rollId: `roll-${index}`,
    acceptedAt: index,
  })),
  completed: Array.from({ length: 505 }, (_, index) => ({
    eventId: `completed-${index}`,
    completedAt: index,
    outcome: "consumed",
  })),
});
assert.equal(bounded.pending.length, 200);
assert.equal(bounded.pending[0].eventId, "pending-5");
assert.equal(bounded.completed.length, 500);
assert.equal(bounded.completed[0].eventId, "completed-5");

assert.throws(
  () =>
    enqueueSharpeningLifecycleEvent(
      {},
      {
        ...damage,
        originUserId: "",
      },
    ),
  /DowntimeSharpeningLifecycleEventInvalid/,
);

console.log("downtime sharpening lifecycle ledger passed");
