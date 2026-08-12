import assert from "node:assert/strict";

const saved = Object.fromEntries(
  ["game", "CONST", "localStorage"].map((key) => [key, globalThis[key]]),
);

try {
  const gm = { id: "gm-1", isGM: true, role: 4, active: true };
  const player = { id: "player-1", isGM: false, role: 1, active: true };
  const other = { id: "player-2", isGM: false, role: 1, active: true };
  const users = new Map([
    [gm.id, gm],
    [player.id, player],
    [other.id, other],
  ]);
  users.activeGM = gm;
  const emitted = [];
  const localValues = new Map();
  globalThis.localStorage = {
    getItem: (key) => localValues.get(key) ?? null,
    setItem: (key, value) => localValues.set(key, value),
    removeItem: (key) => localValues.delete(key),
  };
  globalThis.CONST = { USER_ROLES: { GAMEMASTER: 4 } };
  globalThis.game = {
    user: player,
    users,
    socket: {
      emit(...args) {
        emitted.push(args);
      },
    },
  };

  const socket = await import("./downtime/socket.js");
  const effects = await import("./downtime/effects.js");
  const validQueue = [
    {
      id: "action-1",
      activityId: "pickpocket",
      hours: 4,
      skill: "sleight-of-hand",
      targetId: "mark-1",
    },
  ];

  assert.deepEqual(
    socket.validateDowntimePayload({
      type: socket.DOWNTIME_EVENTS.SUBMIT_QUEUE,
      requestId: "request-1",
      targetUserId: gm.id,
      blockId: "block-1",
      actorId: "actor-1",
      queue: validQueue,
    }),
    { ok: true, reason: null },
  );
  assert.equal(
    socket.validateDowntimePayload({
      type: socket.DOWNTIME_EVENTS.SUBMIT_QUEUE,
      requestId: "guided-player-roll",
      targetUserId: gm.id,
      blockId: "block-1",
      actorId: "actor-1",
      queue: [
        {
          id: "guided-labor",
          activityId: "guided-labor",
          hours: 8,
          skill: "ath",
          guidedRoll: { total: 17, formula: "1d20 + 5" },
        },
      ],
    }).ok,
    true,
    "a player's bounded guided roll total may accompany their owned submission",
  );
  assert.equal(
    socket.validateDowntimePayload({
      type: socket.DOWNTIME_EVENTS.SUBMIT_QUEUE,
      requestId: "invalid-guided-player-roll",
      targetUserId: gm.id,
      blockId: "block-1",
      actorId: "actor-1",
      queue: [
        {
          id: "guided-labor",
          activityId: "guided-labor",
          hours: 8,
          skill: "ath",
          guidedRoll: { formula: "1d20 + 5" },
        },
      ],
    }).reason,
    "invalid-queue-entry",
    "guided rolls remain bounded structured data",
  );
  const fenceQueue = [
    {
      id: "fence-1",
      activityId: "fence-stolen-goods",
      hours: 4,
      skill: "deception",
      targetIds: ["stolen-a", "stolen-b"],
    },
  ];
  assert.equal(
    socket.validateDowntimePayload({
      type: socket.DOWNTIME_EVENTS.SUBMIT_QUEUE,
      requestId: "fence-bundle",
      targetUserId: gm.id,
      blockId: "block-1",
      actorId: "actor-1",
      queue: fenceQueue,
    }).ok,
    true,
    "a bounded bundle of owned item IDs may cross the player socket",
  );
  assert.equal(
    socket.validateDowntimePayload({
      type: socket.DOWNTIME_EVENTS.SUBMIT_QUEUE,
      requestId: "duplicate-fence-bundle",
      targetUserId: gm.id,
      blockId: "block-1",
      actorId: "actor-1",
      queue: [{ ...fenceQueue[0], targetIds: ["stolen-a", "stolen-a"] }],
    }).reason,
    "invalid-queue-entry",
    "duplicate item IDs cannot inflate or confuse a fencing bundle",
  );
  assert.equal(
    socket.validateDowntimePayload({
      type: socket.DOWNTIME_EVENTS.SUBMIT_QUEUE,
      requestId: "malformed-fence-bundle",
      targetUserId: gm.id,
      blockId: "block-1",
      actorId: "actor-1",
      queue: [{ ...fenceQueue[0], targetIds: ["stolen item"] }],
    }).reason,
    "invalid-queue-entry",
  );
  assert.equal(
    socket.validateDowntimePayload({
      type: socket.DOWNTIME_EVENTS.SUBMIT_QUEUE,
      requestId: "request-2",
      targetUserId: gm.id,
      blockId: "block-1",
      actorId: "actor-1",
      queue: [{ ...validQueue[0], dc: 1, reward: 999_999 }],
    }).reason,
    "invalid-queue-entry",
    "derived DCs and rewards have no socket path",
  );
  assert.equal(
    socket.validateDowntimePayload({
      type: socket.DOWNTIME_EVENTS.SUBMIT_QUEUE,
      requestId: "forged-envelope",
      targetUserId: gm.id,
      blockId: "block-1",
      actorId: "actor-1",
      queue: validQueue,
      rolls: [{ total: 20 }],
      projectedReward: 99_999,
    }).reason,
    "client-derived-data-not-allowed",
    "derived data is rejected at both the envelope and queue-entry boundary",
  );
  for (const type of Object.values(socket.DOWNTIME_EVENTS)) {
    assert.equal(
      socket.validateDowntimePayload({ type }).reason,
      "invalid-target-user-id",
      `${type} requires an explicit recipient`,
    );
  }
  assert.equal(
    socket.validateDowntimePayload({
      type: socket.DOWNTIME_EVENTS.SUBMIT_QUEUE,
      requestId: "empty-queue",
      targetUserId: gm.id,
      blockId: "block-1",
      actorId: "actor-1",
      queue: [],
    }).ok,
    true,
    "a player may submit an explicitly empty queue",
  );
  assert.equal(
    socket.validateDowntimePayload({
      type: socket.DOWNTIME_EVENTS.SUBMIT_QUEUE,
      requestId: "queue-64",
      targetUserId: gm.id,
      blockId: "block-1",
      actorId: "actor-1",
      queue: Array.from({ length: 64 }, (_, index) => ({
        id: `action-${index}`,
        activityId: "lay-low",
        hours: 4,
      })),
    }).ok,
    true,
    "the transport accepts the domain's full 64-action queue limit",
  );
  assert.equal(
    socket.validateDowntimePayload({
      type: socket.DOWNTIME_EVENTS.SUBMIT_QUEUE,
      requestId: "queue-65",
      targetUserId: gm.id,
      blockId: "block-1",
      actorId: "actor-1",
      queue: Array.from({ length: 65 }, (_, index) => ({
        id: `action-${index}`,
        activityId: "lay-low",
        hours: 4,
      })),
    }).reason,
    "invalid-queue",
    "the transport rejects a queue beyond the shared 64-action limit",
  );

  let localSubmissions = 0;
  const unsubscribeSubmit = socket.subscribeDowntime(
    socket.DOWNTIME_EVENTS.SUBMIT_QUEUE,
    () => {
      localSubmissions += 1;
    },
  );
  const sent = socket.submitDowntimeQueue({
    requestId: "player-submit",
    blockId: "block-1",
    actorId: "actor-1",
    queue: validQueue,
  });
  assert.equal(sent.ok, true);
  assert.equal(sent.requestId, "player-submit");
  assert.equal(emitted[0][1].requestId, "player-submit");
  assert.deepEqual(
    emitted[0][2],
    { recipients: [gm.id] },
    "player downtime submissions are transport-scoped to the authority",
  );
  assert.equal(emitted.length, 1);
  assert.equal(localSubmissions, 0, "remote requests are not trusted locally");

  const recalled = socket.recallDowntimeSubmission({
    requestId: "player-recall",
    blockId: "block-1",
    actorId: "actor-1",
  });
  assert.equal(recalled.ok, true);
  assert.equal(recalled.requestId, "player-recall");
  assert.equal(emitted[1][1].requestId, "player-recall");

  const originalWarn = console.warn;
  console.warn = () => {};
  try {
    assert.equal(
      socket.emitDowntimeEvent(socket.DOWNTIME_EVENTS.STATE_UPDATE, {
        targetUserId: player.id,
        projection: { status: "completed" },
      }),
      null,
      "a player cannot originate a privileged state projection",
    );
    assert.equal(
      socket.emitDowntimeEvent(socket.DOWNTIME_EVENTS.SUBMIT_QUEUE, {
        requestId: "misdirected",
        targetUserId: other.id,
        blockId: "block-1",
        actorId: "actor-1",
        queue: validQueue,
      }),
      null,
      "player requests must target the current authoritative GM",
    );
  } finally {
    console.warn = originalWarn;
  }

  globalThis.game.user = gm;
  assert.equal(
    socket.validateDowntimePayload({
      type: socket.DOWNTIME_EVENTS.STATE_UPDATE,
      targetUserId: player.id,
      projection: {
        status: "collecting",
        nested: { opportunitySecret: "gm-only-secret" },
      },
    }).reason,
    "restricted-projection-data",
    "the socket boundary rejects a projection containing the private secret",
  );
  assert.equal(
    socket.validateDowntimePayload({
      type: socket.DOWNTIME_EVENTS.STATE_UPDATE,
      targetUserId: player.id,
      projection: {
        status: "locked",
        nested: {
          planningDraft: {
            rows: { privateRoll: { total: 20, formula: "1d20 + 5" } },
          },
        },
      },
    }).reason,
    "restricted-projection-data",
    "partial hidden-roll journals can never cross the player socket boundary",
  );
  let receivedSubmission = null;
  const unsubscribeReceived = socket.subscribeDowntime(
    socket.DOWNTIME_EVENTS.SUBMIT_QUEUE,
    (payload) => {
      receivedSubmission = payload;
    },
  );
  const incomingSubmission = {
    type: socket.DOWNTIME_EVENTS.SUBMIT_QUEUE,
    originUserId: player.id,
    targetUserId: gm.id,
    requestId: "incoming-submit",
    blockId: "block-1",
    actorId: "actor-1",
    queue: validQueue,
  };
  socket.receiveDowntimePayload(incomingSubmission, player.id);
  assert.equal(receivedSubmission.originUserId, player.id);
  receivedSubmission = null;
  socket.receiveDowntimePayload(incomingSubmission);
  assert.equal(
    receivedSubmission,
    null,
    "claimed origin IDs are never accepted without transport authentication",
  );
  socket.receiveDowntimePayload(
    { ...incomingSubmission, originUserId: other.id },
    player.id,
  );
  assert.equal(receivedSubmission, null, "transport identity defeats spoofing");
  player.active = false;
  socket.receiveDowntimePayload(incomingSubmission, player.id);
  assert.equal(receivedSubmission, null, "inactive senders are rejected");
  player.active = true;

  let leakedGmState = 0;
  let leakedGmAutoOpen = 0;
  const unsubscribeGmState = socket.subscribeDowntime(
    socket.DOWNTIME_EVENTS.STATE_UPDATE,
    () => {
      leakedGmState += 1;
    },
  );
  const unsubscribeGmAutoOpen = socket.subscribeDowntime(
    socket.DOWNTIME_EVENTS.AUTO_OPEN,
    () => {
      leakedGmAutoOpen += 1;
    },
  );
  assert.ok(
    socket.emitDowntimeEvent(socket.DOWNTIME_EVENTS.STATE_UPDATE, {
      targetUserId: player.id,
      projection: { status: "collecting" },
    }),
  );
  assert.ok(
    socket.emitDowntimeEvent(socket.DOWNTIME_EVENTS.AUTO_OPEN, {
      targetUserId: player.id,
      actorId: "actor-1",
      blockId: "block-1",
    }),
  );
  assert.equal(leakedGmState, 0);
  assert.equal(
    leakedGmAutoOpen,
    0,
    "a GM never consumes another player's targeted projection or auto-open",
  );

  globalThis.game.user = player;
  let stateUpdates = 0;
  const unsubscribeState = socket.subscribeDowntime(
    socket.DOWNTIME_EVENTS.STATE_UPDATE,
    () => {
      stateUpdates += 1;
    },
  );
  const statePayload = {
    type: socket.DOWNTIME_EVENTS.STATE_UPDATE,
    originUserId: gm.id,
    targetUserId: player.id,
    projection: { status: "collecting" },
  };
  socket.receiveDowntimePayload(statePayload, gm.id);
  assert.equal(stateUpdates, 1);
  socket.receiveDowntimePayload(statePayload, other.id);
  assert.equal(stateUpdates, 1, "only the authoritative GM may project state");
  socket.receiveDowntimePayload(
    { ...statePayload, targetUserId: other.id },
    gm.id,
  );
  assert.equal(stateUpdates, 1, "targeted state never reaches another user");

  globalThis.game.user = gm;
  let directSnapshots = 0;
  const unsubscribeSnapshot = socket.subscribeDowntime(
    socket.DOWNTIME_EVENTS.SNAPSHOT_REQUEST,
    () => {
      directSnapshots += 1;
    },
  );
  assert.equal(
    socket.requestDowntimeSnapshot("actor-1", {
      requestId: "direct-snapshot",
    }).requestId,
    "direct-snapshot",
  );
  assert.equal(
    directSnapshots,
    1,
    "an authoritative GM can use the same request path without a socket echo",
  );

  globalThis.game.user = player;
  gm.active = false;
  users.activeGM = null;
  const lifecycleActor = { id: "actor-1", items: new Map() };
  const lifecycleEffect = effects.buildSharpeningEffect({
    operationId: "operation-1",
    actorId: lifecycleActor.id,
    itemId: "weapon-1",
    damageType: "slashing",
    nativeDamagePart: false,
  });
  const lifecycleItem = {
    id: "weapon-1",
    parent: lifecycleActor,
    effects: [lifecycleEffect],
  };
  lifecycleActor.items.set(lifecycleItem.id, lifecycleItem);
  globalThis.game.actors = new Map([[lifecycleActor.id, lifecycleActor]]);
  const queuedDamage = socket.notifySharpenDamage(
    lifecycleItem,
    "damage-roll-1",
    {
      eventId: "lifecycle-damage-1",
      effectId: lifecycleEffect._id,
      operationId: "operation-1",
    },
  );
  assert.equal(queuedDamage.ok, true);
  assert.equal(queuedDamage.sent, false);
  assert.equal(
    [...localValues.values()].some((value) =>
      value.includes("lifecycle-damage-1"),
    ),
    true,
    "no-GM damage notifications remain durable in client storage",
  );
  for (const index of [2, 3]) {
    assert.equal(
      socket.notifySharpenDamage(lifecycleItem, `damage-roll-${index}`, {
        eventId: `lifecycle-damage-${index}`,
        effectId: lifecycleEffect._id,
        operationId: "operation-1",
      }).ok,
      true,
    );
  }
  const noGmFourthRoll = { subject: { item: lifecycleItem }, rolls: [] };
  assert.equal(
    effects.injectSharpeningDamageBonus(noGmFourthRoll),
    false,
    "three queued no-GM rolls immediately suppress a fourth +1 bonus",
  );
  socket.resetPendingSharpeningLifecycleForTests({ preserveStorage: true });
  assert.equal(
    effects.injectSharpeningDamageBonus({
      subject: { item: lifecycleItem },
      rolls: [],
    }),
    false,
    "the three-roll suppression survives a client refresh",
  );

  gm.active = true;
  users.activeGM = gm;
  assert.equal(socket.flushPendingSharpeningLifecycle(), 3);
  const lifecyclePayload = emitted.at(-1)[1];
  assert.equal(lifecyclePayload.type, socket.DOWNTIME_EVENTS.SHARPEN_DAMAGE);
  assert.equal(lifecyclePayload.eventId, "lifecycle-damage-3");
  assert.equal(lifecyclePayload.targetUserId, gm.id);

  lifecycleEffect.flags["infinity-dnd5e"].downtimeSharpen.charges = 2;
  lifecycleEffect.flags["infinity-dnd5e"].downtimeSharpen.rollIds = [
    "damage-roll-1",
  ];
  assert.equal(
    socket.flushPendingSharpeningLifecycle(),
    2,
    "canonical roll IDs retire matching client outbox entries",
  );
  for (const index of [2, 3]) {
    socket.receiveDowntimePayload(
      {
        type: socket.DOWNTIME_EVENTS.SHARPEN_LIFECYCLE_ACK,
        originUserId: gm.id,
        targetUserId: player.id,
        eventId: `lifecycle-damage-${index}`,
      },
      gm.id,
    );
  }
  assert.equal(
    socket.flushPendingSharpeningLifecycle(),
    0,
    "authenticated applied acknowledgements retire the remaining records",
  );

  gm.active = false;
  users.activeGM = null;
  socket.notifySharpenDamage(lifecycleItem, "stale-roll", {
    eventId: "stale-lifecycle-damage",
    effectId: lifecycleEffect._id,
    operationId: "operation-1",
  });
  const replacementEffect = effects.buildSharpeningEffect({
    operationId: "operation-2",
    actorId: lifecycleActor.id,
    itemId: lifecycleItem.id,
    damageType: "slashing",
    nativeDamagePart: false,
  });
  lifecycleItem.effects = [replacementEffect];
  assert.equal(
    effects.injectSharpeningDamageBonus({
      subject: { item: lifecycleItem },
      rolls: [],
    }),
    true,
    "a stale queued roll for an old effect cannot suppress re-sharpening",
  );
  assert.equal(socket.flushPendingSharpeningLifecycle(), 0);

  const queuedRest = socket.notifyLongRest(lifecycleActor, {
    eventId: "lifecycle-rest-1",
    references: [
      {
        itemId: lifecycleItem.id,
        effectId: replacementEffect._id,
        operationId: "operation-2",
      },
    ],
  });
  assert.equal(queuedRest.ok, true);
  assert.equal(queuedRest.sent, false);
  assert.equal(
    effects.injectSharpeningDamageBonus({
      subject: { item: lifecycleItem },
      rolls: [],
    }),
    false,
    "a pending long rest suppresses its exact sharpening bonus",
  );
  socket.resetPendingSharpeningLifecycleForTests({ preserveStorage: true });
  assert.equal(
    effects.injectSharpeningDamageBonus({
      subject: { item: lifecycleItem },
      rolls: [],
    }),
    false,
    "pending long-rest suppression survives a client refresh",
  );
  const laterEffect = effects.buildSharpeningEffect({
    operationId: "operation-3",
    actorId: lifecycleActor.id,
    itemId: lifecycleItem.id,
    damageType: "slashing",
    nativeDamagePart: false,
  });
  lifecycleItem.effects = [laterEffect];
  assert.equal(
    effects.injectSharpeningDamageBonus({
      subject: { item: lifecycleItem },
      rolls: [],
    }),
    true,
    "an old pending rest cannot suppress a later sharpening operation",
  );

  gm.active = true;
  users.activeGM = gm;
  socket.receiveDowntimePayload(
    {
      type: socket.DOWNTIME_EVENTS.SHARPEN_LIFECYCLE_ACK,
      originUserId: gm.id,
      targetUserId: player.id,
      eventId: "lifecycle-rest-1",
    },
    gm.id,
  );
  socket.resetPendingSharpeningLifecycleForTests();

  unsubscribeSubmit();
  unsubscribeReceived();
  unsubscribeState();
  unsubscribeSnapshot();
  unsubscribeGmState();
  unsubscribeGmAutoOpen();
} finally {
  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) delete globalThis[key];
    else globalThis[key] = value;
  }
}

process.stdout.write("downtime socket authentication passed\n");
