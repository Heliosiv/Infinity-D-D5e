import assert from "node:assert/strict";

const savedGame = globalThis.game;
const savedConst = globalThis.CONST;

try {
  const gm = { id: "gm-1", isGM: true, role: 4, active: true };
  const player = { id: "player-1", isGM: false, role: 1, active: true };
  const users = [gm, player];
  users.activeGM = gm;
  users.get = (id) => users.find((user) => user.id === id) ?? null;
  users.forEach = (callback) => Array.prototype.forEach.call(users, callback);
  globalThis.CONST = { USER_ROLES: { GAMEMASTER: 4 } };
  globalThis.game = { user: player, users };

  const socket = await import("./injury/socket.js");
  const delivered = [];
  socket.subscribeCriticalInjury(
    socket.CRITICAL_INJURY_EVENTS.ROLL_FAILURE,
    (payload) => delivered.push(payload),
  );
  const failure = {
    type: socket.CRITICAL_INJURY_EVENTS.ROLL_FAILURE,
    actorId: "actor-1",
    pendingId: "pending-1",
    targetUserId: player.id,
    originUserId: gm.id,
    retryable: true,
    message: "Retrying is safe.",
  };

  socket.receiveCriticalInjuryPayload(
    { ...failure, originUserId: player.id },
    player.id,
  );
  socket.receiveCriticalInjuryPayload(
    { ...failure, targetUserId: gm.id },
    gm.id,
  );
  socket.receiveCriticalInjuryPayload(failure, null);
  assert.equal(
    delivered.length,
    0,
    "forged, wrong-target, and unauthenticated failures are ignored",
  );

  socket.receiveCriticalInjuryPayload(failure, gm.id);
  assert.equal(delivered.length, 1);
  assert.equal(delivered[0].originUserId, gm.id);
  assert.equal(delivered[0].targetUserId, player.id);

  const restResults = [];
  socket.subscribeCriticalInjury(
    socket.CRITICAL_INJURY_EVENTS.REST_RESULT,
    (payload) => restResults.push(payload),
  );
  const restResult = {
    type: socket.CRITICAL_INJURY_EVENTS.REST_RESULT,
    actorId: "actor-1",
    restId: "rest-actor-1-message-1",
    targetUserId: player.id,
    originUserId: gm.id,
    success: true,
    retryable: false,
    message: "The Infection rest check is complete.",
  };
  socket.receiveCriticalInjuryPayload(
    { ...restResult, originUserId: player.id },
    player.id,
  );
  assert.equal(
    restResults.length,
    0,
    "a player cannot forge a completed Infection rest acknowledgement",
  );
  socket.receiveCriticalInjuryPayload(restResult, gm.id);
  assert.equal(restResults.length, 1);
  assert.equal(restResults[0].restId, restResult.restId);
} finally {
  if (savedGame === undefined) delete globalThis.game;
  else globalThis.game = savedGame;
  if (savedConst === undefined) delete globalThis.CONST;
  else globalThis.CONST = savedConst;
}

process.stdout.write("critical injury socket routing passed\n");
