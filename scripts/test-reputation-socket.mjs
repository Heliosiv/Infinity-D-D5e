import assert from "node:assert/strict";

import {
  REPUTATION_EVENTS,
  emitReputationEvent,
  receiveReputationPayload,
  subscribe,
} from "./reputation/socket.js";

const savedGame = globalThis.game;
const savedConst = globalThis.CONST;

try {
  const gm = { id: "gm-1", isGM: true, role: 4, active: true };
  const secondGm = { id: "gm-2", isGM: true, role: 4, active: true };
  const player = { id: "player-1", isGM: false, role: 1, active: true };
  const other = { id: "player-2", isGM: false, role: 1, active: true };
  const users = new Map(
    [gm, secondGm, player, other].map((user) => [user.id, user]),
  );
  users.activeGM = gm;
  const emissions = [];

  globalThis.CONST = { USER_ROLES: { GAMEMASTER: 4 } };
  globalThis.game = {
    user: player,
    users,
    socket: {
      emit(...args) {
        emissions.push(args);
      },
    },
  };

  emitReputationEvent(REPUTATION_EVENTS.LIST_REQUEST, {
    requestId: "request-1",
  });
  assert.equal(emissions.length, 1);
  assert.equal(emissions[0][0], "module.infinity-dnd5e");
  assert.equal(emissions[0][1].type, REPUTATION_EVENTS.LIST_REQUEST);
  assert.deepEqual(
    emissions[0][2],
    { recipients: [gm.id] },
    "a player list request goes only to the authoritative GM",
  );

  globalThis.game.user = gm;
  emitReputationEvent(REPUTATION_EVENTS.LIST_REPLY, {
    targetUserId: player.id,
    requestId: "request-1",
    factions: [],
  });
  assert.deepEqual(
    emissions[1][2],
    { recipients: [player.id] },
    "a private faction reply goes only to its requester",
  );
  emitReputationEvent(REPUTATION_EVENTS.STATE_UPDATE, { factions: [] });
  assert.equal(
    emissions[2].length,
    2,
    "the sanitized state update remains an intentional broadcast",
  );

  globalThis.game.user = player;
  const replies = [];
  const stop = subscribe(REPUTATION_EVENTS.LIST_REPLY, (payload) =>
    replies.push(payload),
  );
  const reply = {
    type: REPUTATION_EVENTS.LIST_REPLY,
    originUserId: gm.id,
    targetUserId: player.id,
    requestId: "request-1",
    factions: [{ id: "faction-1", name: "Known faction" }],
  };

  receiveReputationPayload(reply, gm.id);
  assert.equal(replies.length, 1);
  assert.equal(replies[0].originUserId, gm.id);

  receiveReputationPayload({ ...reply, targetUserId: other.id }, gm.id);
  receiveReputationPayload({ ...reply, targetUserId: null }, gm.id);
  receiveReputationPayload(reply);
  receiveReputationPayload(
    { ...reply, originUserId: secondGm.id },
    secondGm.id,
  );
  receiveReputationPayload({ ...reply, originUserId: secondGm.id }, gm.id);
  assert.equal(
    replies.length,
    1,
    "wrong-target, unauthenticated, secondary-GM, and forged replies fail closed",
  );
  stop();

  process.stdout.write("reputation socket routing passed\n");
} finally {
  if (savedGame === undefined) delete globalThis.game;
  else globalThis.game = savedGame;
  if (savedConst === undefined) delete globalThis.CONST;
  else globalThis.CONST = savedConst;
}
