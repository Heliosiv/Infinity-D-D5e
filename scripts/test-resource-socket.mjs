import assert from "node:assert/strict";

import {
  RESOURCE_EVENTS,
  emitResourceEvent,
  isResourceAuthorityReady,
  receiveResourcePayload,
  subscribe,
  validateResourcePayloadShape,
} from "./resource/socket.js";

function userCollection(users, activeGmId = "gm-a") {
  const collection = new Map(users.map((user) => [user.id, user]));
  collection.activeGM = collection.get(activeGmId) ?? null;
  return collection;
}

const originalGame = globalThis.game;
const originalConst = globalThis.CONST;
const originalWarn = console.warn;
const warnings = [];
console.warn = (...args) => warnings.push(args);
const requests = [];
const replies = [];
const promptSyncRequests = [];
const ackDeliveryConfirms = [];
const stopRequests = subscribe(RESOURCE_EVENTS.OVERVIEW_REQUEST, (payload) => {
  requests.push(payload);
});
const stopReplies = subscribe(RESOURCE_EVENTS.OVERVIEW_REPLY, (payload) => {
  replies.push(payload);
});
const stopPromptSyncRequests = subscribe(
  RESOURCE_EVENTS.PROMPT_SYNC_REQUEST,
  (payload) => {
    promptSyncRequests.push(payload);
  },
);
const stopAckDeliveryConfirms = subscribe(
  RESOURCE_EVENTS.ACK_DELIVERY_CONFIRM,
  (payload) => {
    ackDeliveryConfirms.push(payload);
  },
);

try {
  globalThis.CONST = {
    ...(originalConst ?? {}),
    USER_ROLES: { ...(originalConst?.USER_ROLES ?? {}), GAMEMASTER: 4 },
  };
  const gmA = { id: "gm-a", isGM: true, role: 4, active: true };
  const gmB = { id: "gm-b", isGM: true, role: 4, active: true };
  const assistant = {
    id: "assistant-a",
    isGM: true,
    role: 3,
    active: true,
  };
  const playerA = { id: "player-a", isGM: false, role: 1, active: true };
  const inactivePlayer = {
    id: "player-offline",
    isGM: false,
    active: false,
  };
  const users = userCollection([gmA, gmB, assistant, playerA, inactivePlayer]);

  assert.equal(
    isResourceAuthorityReady({
      isPrimaryGM: () => true,
      hasTabLeadership: () => false,
      isAutomationReady: () => true,
    }),
    false,
    "a same-user follower tab is not Resource socket authority",
  );
  assert.equal(
    isResourceAuthorityReady({
      isPrimaryGM: () => true,
      hasTabLeadership: () => true,
      isAutomationReady: () => true,
    }),
    true,
    "the primary GM must also hold tab leadership and have migrated data",
  );

  /* Security-sensitive event contracts fail closed before routing. */
  assert.deepEqual(
    validateResourcePayloadShape({
      type: RESOURCE_EVENTS.OVERVIEW_REQUEST,
      requestId: "request-valid",
    }),
    { ok: true, reason: null },
  );
  assert.equal(
    validateResourcePayloadShape({
      type: RESOURCE_EVENTS.OVERVIEW_REPLY,
      requestId: "request-valid",
    }).ok,
    false,
    "targeted replies require an explicit recipient",
  );
  assert.equal(
    validateResourcePayloadShape({
      type: RESOURCE_EVENTS.OVERVIEW_REQUEST,
      requestId: "",
    }).ok,
    false,
    "overview requests require a correlation id",
  );
  assert.equal(
    validateResourcePayloadShape({
      type: RESOURCE_EVENTS.DAY_PROMPT,
      targetUserId: "player-a",
      runId: "run-1",
    }).ok,
    false,
    "forage prompts require their exact actor binding",
  );
  for (const type of [RESOURCE_EVENTS.DAY_PROMPT, RESOURCE_EVENTS.FORAGE_ACK]) {
    assert.equal(
      validateResourcePayloadShape({
        type,
        runId: "run-1",
        actorId: "actor-a",
      }).ok,
      false,
      `${type} requires an explicit recipient`,
    );
  }
  assert.equal(
    validateResourcePayloadShape({
      type: RESOURCE_EVENTS.OVERVIEW_REQUEST,
      requestId: "x".repeat(161),
    }).ok,
    false,
    "correlation ids are bounded",
  );
  for (const rollTotal of [Number.NaN, 101, 12.5]) {
    assert.equal(
      validateResourcePayloadShape({
        type: RESOURCE_EVENTS.FORAGE_RESULT,
        runId: "run-1",
        actorId: "actor-a",
        skipped: false,
        rollTotal,
      }).ok,
      false,
      `invalid forage total ${String(rollTotal)} is rejected`,
    );
  }
  assert.equal(
    validateResourcePayloadShape({
      type: RESOURCE_EVENTS.FORAGE_RESULT,
      runId: "run-1",
      actorId: "actor-a",
      skipped: true,
      rollTotal: 1,
    }).ok,
    false,
    "a skipped forage result cannot carry a roll",
  );
  assert.equal(
    validateResourcePayloadShape({
      type: RESOURCE_EVENTS.FORAGE_RESULT,
      runId: "run-1",
      actorId: "actor-a",
      skipped: false,
      rollTotal: 23,
    }).ok,
    true,
    "a bounded integer forage result is accepted",
  );
  assert.equal(
    validateResourcePayloadShape({
      type: RESOURCE_EVENTS.FORAGE_RESULT,
      runId: "run-1",
      actorId: "actor-a",
      promptId: "prompt-1",
      skipped: false,
      rollTotal: 23,
    }).ok,
    true,
    "forage results may carry a bounded prompt correlation id",
  );
  assert.equal(
    validateResourcePayloadShape({
      type: RESOURCE_EVENTS.DAY_PROMPT,
      targetUserId: "player-a",
      runId: "run-1",
      actorId: "actor-a",
      promptId: "prompt-1",
      responseAccepted: true,
    }).ok,
    true,
    "synced prompts may report that a response was already accepted",
  );
  assert.equal(
    validateResourcePayloadShape({
      type: RESOURCE_EVENTS.DAY_PROMPT,
      targetUserId: "player-a",
      runId: "run-1",
      actorId: "actor-a",
      responseAccepted: "yes",
    }).ok,
    false,
    "the accepted-response marker is strictly boolean",
  );
  for (const promptId of ["", "x".repeat(161)]) {
    assert.equal(
      validateResourcePayloadShape({
        type: RESOURCE_EVENTS.FORAGE_RESULT,
        runId: "run-1",
        actorId: "actor-a",
        promptId,
        skipped: false,
        rollTotal: 23,
      }).ok,
      false,
      "present prompt ids must be non-empty and bounded",
    );
  }
  assert.equal(
    validateResourcePayloadShape({
      type: RESOURCE_EVENTS.FORAGE_ACK,
      targetUserId: "player-a",
      runId: "run-1",
      actorId: "actor-a",
    }).ok,
    true,
    "legacy forage acknowledgements remain valid without durable ids",
  );
  assert.equal(
    validateResourcePayloadShape({
      type: RESOURCE_EVENTS.FORAGE_ACK,
      targetUserId: "player-a",
      runId: "run-1",
      actorId: "actor-a",
      promptId: "prompt-1",
      deliveryId: "delivery-1",
    }).ok,
    true,
    "durable forage acknowledgements carry bounded prompt and delivery ids",
  );
  const ledgerSizedDeliveryId = JSON.stringify([
    "resource-delivery-v1",
    "run-1234567890abcdef",
    "prompt-ack",
    "user",
    "player-1234567890abcdef",
    "prompt-1234567890abcdef",
    "resource-delivery-payload-v1-0123456789abcdef0123456789abcdef",
  ]);
  assert.ok(
    ledgerSizedDeliveryId.length > 160,
    "the regression delivery id exceeds the generic protocol-id bound",
  );
  assert.equal(
    validateResourcePayloadShape({
      type: RESOURCE_EVENTS.FORAGE_ACK,
      targetUserId: "player-a",
      runId: "run-1",
      actorId: "actor-a",
      promptId: "prompt-1",
      deliveryId: ledgerSizedDeliveryId,
    }).ok,
    true,
    "ledger-derived delivery ids use their own bounded wire limit",
  );
  assert.equal(
    validateResourcePayloadShape({
      type: RESOURCE_EVENTS.ACK_DELIVERY_CONFIRM,
      runId: "run-1",
      actorId: "actor-a",
      promptId: "prompt-1",
      deliveryId: "x".repeat(2049),
    }).ok,
    false,
    "delivery ids remain bounded against oversized frames",
  );
  assert.equal(
    validateResourcePayloadShape({
      type: RESOURCE_EVENTS.FORAGE_ACK,
      targetUserId: "player-a",
      runId: "run-1",
      actorId: "actor-a",
      deliveryId: "delivery-1",
    }).ok,
    false,
    "a durable acknowledgement cannot omit its prompt correlation id",
  );
  assert.equal(
    validateResourcePayloadShape({
      type: RESOURCE_EVENTS.PROMPT_SYNC_REQUEST,
      requestId: "sync-1",
    }).ok,
    true,
    "prompt sync requests require only a bounded request id",
  );
  assert.equal(
    validateResourcePayloadShape({
      type: RESOURCE_EVENTS.PROMPT_SYNC_REQUEST,
    }).ok,
    false,
    "prompt sync requests fail closed without a request id",
  );
  assert.equal(
    validateResourcePayloadShape({
      type: RESOURCE_EVENTS.ACK_DELIVERY_CONFIRM,
      runId: "run-1",
      actorId: "actor-a",
      promptId: "prompt-1",
      deliveryId: "delivery-1",
    }).ok,
    true,
    "delivery confirmations bind the run, actor, prompt, and delivery",
  );
  assert.equal(
    validateResourcePayloadShape({
      type: RESOURCE_EVENTS.ACK_DELIVERY_CONFIRM,
      runId: "run-1",
      actorId: "actor-a",
      promptId: "prompt-1",
    }).ok,
    false,
    "delivery confirmations fail closed without a delivery id",
  );

  /* Only the authoritative GM accepts active-player overview requests. */
  globalThis.game = {
    user: gmA,
    users,
  };
  receiveResourcePayload(
    {
      type: RESOURCE_EVENTS.OVERVIEW_REQUEST,
      originUserId: "player-a",
      requestId: "request-1",
    },
    "player-a",
  );
  assert.equal(requests.length, 1);
  assert.equal(requests[0].originUserId, "player-a");
  assert.equal(requests[0].requestId, "request-1");

  receiveResourcePayload(
    {
      type: RESOURCE_EVENTS.PROMPT_SYNC_REQUEST,
      originUserId: "player-a",
      requestId: "sync-1",
    },
    "player-a",
  );
  assert.equal(promptSyncRequests.length, 1);
  assert.equal(promptSyncRequests[0].originUserId, "player-a");

  receiveResourcePayload(
    {
      type: RESOURCE_EVENTS.ACK_DELIVERY_CONFIRM,
      originUserId: "player-a",
      runId: "run-1",
      actorId: "actor-a",
      promptId: "prompt-1",
      deliveryId: "delivery-1",
    },
    "player-a",
  );
  assert.equal(ackDeliveryConfirms.length, 1);
  assert.equal(ackDeliveryConfirms[0].originUserId, "player-a");

  receiveResourcePayload({
    type: RESOURCE_EVENTS.PROMPT_SYNC_REQUEST,
    originUserId: "player-a",
    requestId: "sync-without-transport-id",
  });
  assert.equal(
    promptSyncRequests.length,
    1,
    "prompt sync still requires the authenticated transport sender",
  );

  receiveResourcePayload({
    type: RESOURCE_EVENTS.OVERVIEW_REQUEST,
    originUserId: "player-a",
    requestId: "missing-transport-identity",
  });
  assert.equal(
    requests.length,
    1,
    "a payload-claimed origin is insufficient without transport identity",
  );

  receiveResourcePayload(
    {
      type: RESOURCE_EVENTS.OVERVIEW_REQUEST,
      originUserId: "player-offline",
      requestId: "offline-request",
    },
    "player-offline",
  );
  assert.equal(requests.length, 1, "inactive users cannot request a snapshot");

  receiveResourcePayload(
    {
      type: RESOURCE_EVENTS.OVERVIEW_REQUEST,
      originUserId: "gm-a",
      requestId: "forged-origin",
    },
    "player-a",
  );
  assert.equal(
    requests.length,
    1,
    "a claimed identity that differs from transport identity is rejected",
  );

  globalThis.game = {
    user: gmB,
    users,
  };
  receiveResourcePayload(
    {
      type: RESOURCE_EVENTS.OVERVIEW_REQUEST,
      originUserId: "player-a",
      requestId: "secondary-gm",
    },
    "player-a",
  );
  assert.equal(
    requests.length,
    1,
    "a secondary GM does not process the same player request",
  );
  receiveResourcePayload(
    {
      type: RESOURCE_EVENTS.PROMPT_SYNC_REQUEST,
      originUserId: "player-a",
      requestId: "secondary-gm-sync",
    },
    "player-a",
  );
  assert.equal(
    promptSyncRequests.length,
    1,
    "a secondary GM does not process prompt synchronization",
  );

  const assistantFirstUsers = userCollection(
    [gmA, assistant, playerA],
    "assistant-a",
  );
  globalThis.game = {
    user: assistant,
    users: assistantFirstUsers,
  };
  receiveResourcePayload(
    {
      type: RESOURCE_EVENTS.OVERVIEW_REQUEST,
      originUserId: "player-a",
      requestId: "assistant-authority-attempt",
    },
    "player-a",
  );
  assert.equal(
    requests.length,
    1,
    "an Assistant GM cannot become the resource authority",
  );

  /* Players only accept overview replies authenticated as the active GM. */
  globalThis.game = {
    user: playerA,
    users,
  };
  receiveResourcePayload(
    {
      type: RESOURCE_EVENTS.OVERVIEW_REPLY,
      originUserId: "gm-a",
      targetUserId: "player-a",
      requestId: "request-1",
      overview: { partySize: 4 },
    },
    "gm-a",
  );
  assert.equal(replies.length, 1);
  assert.equal(replies[0].originUserId, "gm-a");
  assert.equal(replies[0].overview.partySize, 4);

  receiveResourcePayload(
    {
      type: RESOURCE_EVENTS.OVERVIEW_REPLY,
      originUserId: "gm-a",
      requestId: "missing-target",
      overview: { partySize: 89 },
    },
    "gm-a",
  );
  assert.equal(
    replies.length,
    1,
    "an incoming private reply without a target is rejected",
  );

  receiveResourcePayload(
    {
      type: RESOURCE_EVENTS.OVERVIEW_REPLY,
      originUserId: "gm-a",
      targetUserId: "another-player",
      requestId: "wrong-target",
      overview: { partySize: 88 },
    },
    "gm-a",
  );
  assert.equal(
    replies.length,
    1,
    "a correctly signed reply for another player remains private",
  );

  receiveResourcePayload(
    {
      type: RESOURCE_EVENTS.OVERVIEW_REPLY,
      originUserId: "gm-b",
      targetUserId: "player-a",
      requestId: "untrusted-reply",
      overview: { partySize: 99 },
    },
    "gm-b",
  );
  assert.equal(
    replies.length,
    1,
    "a secondary GM cannot spoof the authoritative overview reply",
  );

  globalThis.game = {
    user: playerA,
    users: assistantFirstUsers,
  };
  receiveResourcePayload(
    {
      type: RESOURCE_EVENTS.OVERVIEW_REPLY,
      originUserId: "assistant-a",
      targetUserId: "player-a",
      requestId: "assistant-reply",
      overview: { partySize: 77 },
    },
    "assistant-a",
  );
  assert.equal(
    replies.length,
    1,
    "players reject snapshots sent by an Assistant GM",
  );

  receiveResourcePayload(
    {
      type: "resource:unknown-event",
      originUserId: "gm-a",
    },
    "gm-a",
  );
  assert.equal(replies.length, 1, "unknown protocol events are ignored");

  const emissions = [];
  globalThis.game = {
    user: gmA,
    users,
    socket: {
      emit(...args) {
        emissions.push(args);
      },
    },
  };
  emitResourceEvent(RESOURCE_EVENTS.OVERVIEW_REPLY, {
    targetUserId: "player-a",
    requestId: "targeted-outbound",
    overview: { partySize: 2 },
  });
  assert.equal(emissions.length, 1);
  assert.equal(emissions[0][0], "module.infinity-dnd5e");
  assert.deepEqual(
    emissions[0][2],
    { recipients: ["player-a"] },
    "Foundry receives a targeted recipient option for private snapshots",
  );
  emitResourceEvent(RESOURCE_EVENTS.OVERVIEW_REPLY, {
    requestId: "missing-target",
    overview: { partySize: 99 },
  });
  emitResourceEvent(RESOURCE_EVENTS.OVERVIEW_REQUEST, {
    requestId: "",
  });
  assert.equal(
    emissions.length,
    1,
    "malformed outgoing private events are neither broadcast nor dispatched",
  );
  const rejectionReasons = warnings
    .map((args) => args.find((value) => value?.reason)?.reason)
    .filter(Boolean);
  assert.ok(
    rejectionReasons.includes("missing-or-invalid-target-user-id"),
    "malformed targeted events leave a bounded audit record",
  );
  assert.ok(
    rejectionReasons.includes("missing-or-invalid-request-id"),
    "malformed request ids leave a bounded audit record",
  );

  globalThis.game.user = playerA;
  assert.equal(
    emitResourceEvent(RESOURCE_EVENTS.STATE_UPDATE, {}),
    null,
    "non-authoritative clients cannot emit GM Resource broadcasts",
  );
  assert.equal(emissions.length, 1);
  emitResourceEvent(RESOURCE_EVENTS.OVERVIEW_REQUEST, {
    requestId: "player-overview-request",
  });
  emitResourceEvent(RESOURCE_EVENTS.FORAGE_RESULT, {
    runId: "run-player-1",
    actorId: "actor-player-1",
    skipped: false,
    rollTotal: 17,
  });
  emitResourceEvent(RESOURCE_EVENTS.PROMPT_SYNC_REQUEST, {
    requestId: "player-prompt-sync",
  });
  emitResourceEvent(RESOURCE_EVENTS.ACK_DELIVERY_CONFIRM, {
    runId: "run-player-1",
    actorId: "actor-player-1",
    promptId: "prompt-player-1",
    deliveryId: "delivery-player-1",
  });
  assert.deepEqual(
    emissions[1][2],
    { recipients: [gmA.id] },
    "overview requests go only to the authoritative GM",
  );
  assert.deepEqual(
    emissions[2][2],
    { recipients: [gmA.id] },
    "forage rolls go only to the authoritative GM",
  );
  assert.deepEqual(
    emissions[3][2],
    { recipients: [gmA.id] },
    "prompt sync requests go only to the authoritative GM",
  );
  assert.deepEqual(
    emissions[4][2],
    { recipients: [gmA.id] },
    "delivery confirmations go only to the authoritative GM",
  );

  globalThis.game.user = gmA;
  emitResourceEvent(RESOURCE_EVENTS.STATE_UPDATE, {});
  assert.equal(
    emissions[5].length,
    2,
    "public resource state invalidation remains an intentional broadcast",
  );
  emitResourceEvent(RESOURCE_EVENTS.FORAGE_ACK, {
    targetUserId: "player-a",
    runId: "run-player-1",
    actorId: "actor-player-1",
    promptId: "prompt-player-1",
    deliveryId: "delivery-player-1",
  });
  assert.deepEqual(
    emissions[6][2],
    { recipients: [playerA.id] },
    "forage acknowledgements remain private to their exact recipient",
  );

  process.stdout.write("resource socket validation passed\n");
} finally {
  stopRequests();
  stopReplies();
  stopPromptSyncRequests();
  stopAckDeliveryConfirms();
  if (originalGame === undefined) delete globalThis.game;
  else globalThis.game = originalGame;
  if (originalConst === undefined) delete globalThis.CONST;
  else globalThis.CONST = originalConst;
  console.warn = originalWarn;
}
