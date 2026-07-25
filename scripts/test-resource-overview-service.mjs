import assert from "node:assert/strict";

import { PRIVATE_STATE_CHANGED_HOOK } from "./private-state.js";
import {
  _getResourceOverviewServiceStateForTests,
  _resetResourceOverviewServiceForTests,
  registerResourceOverviewService,
} from "./resource/overview-service.js";
import { RESOURCE_EVENTS, receiveResourcePayload } from "./resource/socket.js";

const saved = {
  game: globalThis.game,
  Hooks: globalThis.Hooks,
};

function makeHooks() {
  let nextId = 0;
  const listeners = new Map();
  return {
    on(event, handler) {
      const id = ++nextId;
      if (!listeners.has(event)) listeners.set(event, new Map());
      listeners.get(event).set(id, handler);
      return id;
    },
    off(event, id) {
      listeners.get(event)?.delete(id);
    },
    call(event, ...args) {
      for (const handler of listeners.get(event)?.values() ?? []) {
        handler(...args);
      }
    },
  };
}

try {
  const emitted = [];
  const gm = { id: "gm-a", isGM: true, active: true };
  const player = { id: "player-a", isGM: false, active: true };
  const users = new Map([
    [gm.id, gm],
    [player.id, player],
  ]);
  users.activeGM = gm;
  globalThis.Hooks = makeHooks();
  globalThis.game = {
    user: gm,
    users,
    socket: {
      emit(_channel, payload) {
        emitted.push(payload);
      },
    },
  };

  registerResourceOverviewService();
  globalThis.Hooks.call(PRIVATE_STATE_CHANGED_HOOK, {
    keys: ["merchants"],
    reason: "journal-update",
  });
  await new Promise((resolve) => setTimeout(resolve, 160));
  assert.equal(
    emitted.length,
    0,
    "unrelated private data does not refresh player supplies",
  );

  globalThis.Hooks.call(PRIVATE_STATE_CHANGED_HOOK, {
    keys: ["resourceConfig"],
    reason: "journal-update",
  });
  await new Promise((resolve) => setTimeout(resolve, 160));
  assert.equal(emitted.length, 1);
  assert.equal(emitted[0].type, "resource:state-update");
  assert.equal(emitted[0].reason, "private-state");
  assert.equal(
    Object.hasOwn(emitted[0], "keys"),
    false,
    "the broadcast carries no private-state key or value",
  );

  /* Cached snapshots and queued replies are authority-owned transient state. */
  emitted.length = 0;
  receiveResourcePayload(
    {
      type: RESOURCE_EVENTS.OVERVIEW_REQUEST,
      originUserId: player.id,
      requestId: "overview-1",
    },
    player.id,
  );
  await new Promise((resolve) => setTimeout(resolve, 0));
  let serviceState = _getResourceOverviewServiceStateForTests();
  assert.equal(serviceState.hasCanonicalOverview, true);
  assert.equal(serviceState.playerSnapshotCount, 1);

  receiveResourcePayload(
    {
      type: RESOURCE_EVENTS.OVERVIEW_REQUEST,
      originUserId: player.id,
      requestId: "overview-2",
    },
    player.id,
  );
  serviceState = _getResourceOverviewServiceStateForTests();
  assert.equal(serviceState.replyTimerCount, 1);
  assert.equal(serviceState.queuedReplyCount, 1);

  globalThis.Hooks.call(PRIVATE_STATE_CHANGED_HOOK, {
    keys: ["resourceRunState"],
    reason: "journal-update",
  });
  assert.equal(
    _getResourceOverviewServiceStateForTests().hasInvalidationTimer,
    true,
  );

  gm.isGM = false;
  globalThis.Hooks.call("updateUser", gm);
  serviceState = _getResourceOverviewServiceStateForTests();
  assert.deepEqual(serviceState, {
    hasInvalidationTimer: false,
    replyUserCount: 0,
    replyTimerCount: 0,
    queuedReplyCount: 0,
    playerSnapshotCount: 0,
    hasCanonicalOverview: false,
  });
  const emissionsAfterDemotion = emitted.length;
  await new Promise((resolve) => setTimeout(resolve, 240));
  assert.equal(
    emitted.length,
    emissionsAfterDemotion,
    "pending replies and invalidations do not fire after authority loss",
  );

  process.stdout.write("resource overview service validation passed\n");
} finally {
  _resetResourceOverviewServiceForTests();
  if (saved.game === undefined) delete globalThis.game;
  else globalThis.game = saved.game;
  if (saved.Hooks === undefined) delete globalThis.Hooks;
  else globalThis.Hooks = saved.Hooks;
}
