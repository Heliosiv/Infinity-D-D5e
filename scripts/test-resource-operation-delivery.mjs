#!/usr/bin/env node

import assert from "node:assert/strict";
import {
  createResourceOperation,
  createResourceOperationContext,
  markResourceDeliveryDelivered,
  recordResourcePromptResponse,
  transitionResourceOperation,
} from "./resource/operation-ledger.js";
import {
  createResourceOperationDeliveryService,
  RESOURCE_CHAT_DELIVERY_FLAG,
  RESOURCE_CHAT_MESSAGE_ID_LENGTH,
  RESOURCE_REPORT_DELIVERY_FIELD,
  ResourceOperationDeliveryError,
} from "./resource/operation-delivery.js";
import { RESOURCE_EVENTS } from "./resource/socket.js";

const guard = Object.freeze({
  authorityId: "gm-1",
  authorityEpoch: "gm-1:resource-epoch-9",
  leadershipGeneration: 7,
});
const context = createResourceOperationContext({
  rules: { forageMode: "each", waterEnabled: true },
  resources: [{ id: "food" }, { id: "water" }],
  roster: [
    { actorId: "actor-1", userId: "player-1" },
    { actorId: "actor-2", userId: "player-2" },
  ],
});
const chat = Object.freeze({
  content: '<article class="quartermaster">Exact report</article>',
  speaker: {
    scene: "scene-1",
    actor: null,
    token: null,
    alias: "Quartermaster",
  },
  whisper: ["gm-1", "player-1"],
});
const publicChat = Object.freeze({
  content: '<article class="quartermaster">Public report</article>',
  speaker: chat.speaker,
  whisper: null,
});
const REPORT_MESSAGE_ID = "ReportMessage001";

function makePlannedForage(runId = "resource-delivery-run") {
  const prepared = createResourceOperation({
    operationId: runId,
    runId,
    trigger: "forage",
    guard,
    context,
    day: 42,
    days: 1,
    environment: {
      id: "forest",
      label: "Forest",
      dc: 12,
      foodDc: 12,
      waterDc: 10,
    },
    initiator: { userId: "gm-1", name: "Game Master" },
    actors: [
      {
        actorId: "actor-1",
        name: "Aric",
        role: "participant",
        forageTarget: "food-water",
      },
      {
        actorId: "actor-2",
        name: "Bryn",
        role: "participant",
        forageTarget: "food",
      },
    ],
    createdAt: 100,
  });
  const prompting = transitionResourceOperation(prepared, "prompting", {
    guard,
    at: 110,
    assignments: [
      {
        promptId: "prompt-1",
        actorId: "actor-1",
        userId: "player-1",
        forageTarget: "food-water",
        dc: 12,
        foodDc: 12,
        waterDc: 10,
        assignedAt: 110,
        deadlineAt: 200,
      },
      {
        promptId: "prompt-2",
        actorId: "actor-2",
        userId: "player-2",
        forageTarget: "food",
        dc: 12,
        foodDc: 12,
        waterDc: 10,
        assignedAt: 110,
        deadlineAt: 200,
      },
    ],
  });
  const first = recordResourcePromptResponse(
    prompting,
    {
      promptId: "prompt-1",
      actorId: "actor-1",
      userId: "player-1",
      rollTotal: 16,
      wisMod: 2,
      skipped: false,
    },
    { guard, at: 120 },
  );
  const resolved = recordResourcePromptResponse(
    first,
    {
      promptId: "prompt-2",
      actorId: "actor-2",
      userId: "player-2",
      rollTotal: 14,
      wisMod: 1,
      skipped: false,
    },
    { guard, at: 121 },
  );
  return transitionResourceOperation(resolved, "planned", {
    guard,
    at: 130,
    yields: [
      {
        actorId: "actor-1",
        forageTarget: "food-water",
        rollTotal: 16,
        wisMod: 2,
        food: 3,
        water: 2,
        foodSuccess: true,
        waterSuccess: true,
        suppressedFood: false,
        suppressedWater: false,
      },
      {
        actorId: "actor-2",
        forageTarget: "food",
        rollTotal: 14,
        wisMod: 1,
        food: 1,
        water: 0,
        foodSuccess: true,
        waterSuccess: false,
        suppressedFood: false,
        suppressedWater: false,
      },
    ],
    operations: [],
  });
}

function makeTerminal({
  runId = "resource-delivery-run",
  messageId = REPORT_MESSAGE_ID,
  chatOptions = chat,
  serviceBindings = {},
} = {}) {
  const service = createResourceOperationDeliveryService({
    allocateChatMessageId: () => messageId,
    isAuthorityCurrent: () => true,
    now: () => 140,
    ...serviceBindings,
  });
  const terminal = service.prepareTerminalRecord(makePlannedForage(runId), {
    guard,
    at: 140,
    report: { status: "complete", totals: { food: 4, water: 2 } },
    receipt: { runId, status: "complete" },
    chat: chatOptions,
    reportRecipientId: "configured-audience",
  });
  return { service, terminal };
}

function confirmationFor(delivery, originUserId = delivery.recipient.id) {
  return {
    type: RESOURCE_EVENTS.ACK_DELIVERY_CONFIRM,
    runId: delivery.payload.runId,
    actorId: delivery.payload.actorId,
    promptId: delivery.promptId,
    deliveryId: delivery.deliveryId,
    originUserId,
  };
}

function expectedMessageFromCreate(data) {
  return structuredClone({ ...data, id: data._id });
}

/* Terminal preparation owns an exact pending report followed by prompt ACKs. */
{
  const { terminal } = makeTerminal();
  assert.equal(terminal.phase, "terminal");
  assert.equal(terminal.outbox.entries.length, 3);
  assert.deepEqual(
    terminal.outbox.entries.map((entry) => entry.kind),
    ["report", "prompt-ack", "prompt-ack"],
  );
  assert.ok(
    terminal.outbox.entries.every((entry) => entry.state === "pending"),
  );
  assert.equal(
    terminal.report[RESOURCE_REPORT_DELIVERY_FIELD].messageId.length,
    RESOURCE_CHAT_MESSAGE_ID_LENGTH,
  );
  assert.equal(
    terminal.report[RESOURCE_REPORT_DELIVERY_FIELD].messageId,
    REPORT_MESSAGE_ID,
  );
  assert.deepEqual(
    terminal.report[RESOURCE_REPORT_DELIVERY_FIELD].speaker,
    chat.speaker,
  );
  assert.deepEqual(
    terminal.report[RESOURCE_REPORT_DELIVERY_FIELD].whisper,
    chat.whisper,
  );
  assert.deepEqual(
    terminal.outbox.entries[0].payload,
    terminal.report,
    "the immutable report is the persisted chat delivery payload",
  );
}

/* Public reports persist null and omit whisper; private reports stay exact. */
{
  const messages = new Map();
  const createCalls = [];
  const { service, terminal } = makeTerminal({
    runId: "public-report-run",
    messageId: "PublicMessage001",
    chatOptions: publicChat,
    serviceBindings: {
      findChatMessage: (id) => messages.get(id) ?? null,
      createChatMessage: (data) => {
        createCalls.push(structuredClone(data));
        messages.set(data._id, expectedMessageFromCreate(data));
      },
      now: () => 141,
    },
  });
  assert.equal(terminal.report[RESOURCE_REPORT_DELIVERY_FIELD].whisper, null);
  const outcome = await service.drainNextDelivery(terminal, { guard });
  assert.equal(outcome.action, "delivered");
  assert.equal(createCalls.length, 1);
  assert.equal(Object.hasOwn(createCalls[0], "whisper"), false);

  const collisionTerminal = makeTerminal({
    runId: "public-private-collision-run",
    messageId: "PublicMessage002",
    chatOptions: { ...publicChat, whisper: [] },
  }).terminal;
  assert.equal(
    collisionTerminal.report[RESOURCE_REPORT_DELIVERY_FIELD].whisper,
    null,
    "an empty input array is normalized to the safe public representation",
  );
  const privateCollision = expectedMessageFromCreate({
    _id: "PublicMessage002",
    content: publicChat.content,
    speaker: publicChat.speaker,
    whisper: ["player-1"],
    flags: {
      "infinity-dnd5e": {
        [RESOURCE_CHAT_DELIVERY_FLAG]: {
          version: 1,
          runId: collisionTerminal.runId,
          deliveryId: collisionTerminal.outbox.entries[0].deliveryId,
          messageId: "PublicMessage002",
        },
      },
    },
  });
  const collisionService = createResourceOperationDeliveryService({
    findChatMessage: () => privateCollision,
    isAuthorityCurrent: () => true,
  });
  const collision = await collisionService.drainNextDelivery(
    collisionTerminal,
    { guard },
  );
  assert.equal(collision.action, "needs-review");
  assert.equal(collision.reason, "chat-message-id-collision");
}

/* Invalid preallocation and reserved report metadata fail before persistence. */
{
  const badAllocator = createResourceOperationDeliveryService({
    allocateChatMessageId: () => "too-short",
  });
  assert.throws(
    () =>
      badAllocator.prepareTerminalRecord(makePlannedForage("bad-id-run"), {
        guard,
        at: 140,
        report: { status: "complete" },
        receipt: { runId: "bad-id-run" },
        chat,
      }),
    (error) => {
      assert.ok(error instanceof ResourceOperationDeliveryError);
      assert.equal(error.code, "RESOURCE_DELIVERY_INVALID_MESSAGE_ID");
      return true;
    },
  );
  const reserved = createResourceOperationDeliveryService({
    allocateChatMessageId: () => REPORT_MESSAGE_ID,
  });
  assert.throws(
    () =>
      reserved.prepareTerminalRecord(makePlannedForage("reserved-field-run"), {
        guard,
        at: 140,
        report: { [RESOURCE_REPORT_DELIVERY_FIELD]: {} },
        receipt: { runId: "reserved-field-run" },
        chat,
      }),
    (error) => {
      assert.ok(error instanceof ResourceOperationDeliveryError);
      assert.equal(error.code, "RESOURCE_DELIVERY_RESERVED_REPORT_FIELD");
      return true;
    },
  );
}

/* A server-side create that commits before throwing is confirmed by readback. */
let canonicalTerminal;
let canonicalMessages;
{
  canonicalMessages = new Map();
  const createCalls = [];
  const { service, terminal } = makeTerminal({
    serviceBindings: {
      findChatMessage: (id) => canonicalMessages.get(id) ?? null,
      createChatMessage: (data, options) => {
        createCalls.push({ data: structuredClone(data), options });
        canonicalMessages.set(data._id, expectedMessageFromCreate(data));
        throw new Error("transport closed after server commit");
      },
      now: () => 141,
    },
  });
  const outcome = await service.drainNextDelivery(terminal, { guard });
  assert.equal(outcome.action, "delivered");
  assert.equal(
    outcome.confirmation,
    "canonical-chat-message-after-create-error",
  );
  assert.equal(outcome.updatedRecord.outbox.entries[0].state, "delivered");
  assert.equal(createCalls.length, 1);
  assert.deepEqual(createCalls[0].options, { keepId: true });
  assert.equal(createCalls[0].data._id, REPORT_MESSAGE_ID);
  assert.equal(createCalls[0].data.content, chat.content);
  assert.deepEqual(createCalls[0].data.speaker, chat.speaker);
  assert.deepEqual(createCalls[0].data.whisper, chat.whisper);
  assert.deepEqual(
    createCalls[0].data.flags["infinity-dnd5e"][RESOURCE_CHAT_DELIVERY_FLAG],
    {
      version: 1,
      runId: terminal.runId,
      deliveryId: terminal.outbox.entries[0].deliveryId,
      messageId: REPORT_MESSAGE_ID,
    },
  );
  canonicalTerminal = terminal;
}

/* Retry sees the exact pre-existing document and never creates a duplicate. */
{
  let creates = 0;
  const service = createResourceOperationDeliveryService({
    findChatMessage: (id) => canonicalMessages.get(id) ?? null,
    createChatMessage: () => {
      creates += 1;
    },
    isAuthorityCurrent: () => true,
    now: () => 142,
  });
  const outcome = await service.drainNextDelivery(canonicalTerminal, { guard });
  assert.equal(outcome.action, "delivered");
  assert.equal(outcome.confirmation, "existing-canonical-chat-message");
  assert.equal(creates, 0);
}

/* The reserved id can never adopt a third-party or differently shaped message. */
{
  const { terminal } = makeTerminal({ runId: "collision-run" });
  const collision = {
    id: REPORT_MESSAGE_ID,
    content: "Someone else's message",
    speaker: chat.speaker,
    whisper: chat.whisper,
    flags: {},
  };
  let creates = 0;
  const service = createResourceOperationDeliveryService({
    findChatMessage: () => collision,
    createChatMessage: () => {
      creates += 1;
    },
    isAuthorityCurrent: () => true,
    now: () => 141,
  });
  const outcome = await service.drainNextDelivery(terminal, { guard });
  assert.equal(outcome.action, "needs-review");
  assert.equal(outcome.code, "resource-report-message-collision");
  assert.equal(outcome.updatedRecord, undefined);
  assert.equal(creates, 0);
  assert.equal(terminal.outbox.entries[0].state, "pending");
}

/* Authority loss after creation leaves the persisted outbox pending for dedupe. */
{
  const messages = new Map();
  const authority = [true, true, false];
  let creates = 0;
  const { service, terminal } = makeTerminal({
    runId: "authority-loss-run",
    serviceBindings: {
      findChatMessage: (id) => messages.get(id) ?? null,
      createChatMessage: (data) => {
        creates += 1;
        messages.set(data._id, expectedMessageFromCreate(data));
        return messages.get(data._id);
      },
      isAuthorityCurrent: () => authority.shift() ?? false,
      now: () => 141,
    },
  });
  const outcome = await service.drainNextDelivery(terminal, { guard });
  assert.equal(outcome.action, "authority-lost");
  assert.equal(
    outcome.reason,
    "authority-changed-after-canonical-chat-readback",
  );
  assert.equal(outcome.updatedRecord, undefined);
  assert.equal(creates, 1);
  assert.equal(terminal.outbox.entries[0].state, "pending");
  assert.ok(messages.has(REPORT_MESSAGE_ID));
}

/* Rejected or altered socket results never become durable ACK markers. */
{
  const reportDelivered = markResourceDeliveryDelivered(
    canonicalTerminal,
    canonicalTerminal.outbox.entries[0].deliveryId,
    { guard, at: 141, confirmed: true },
  );
  const firstAck = reportDelivered.outbox.entries[1];
  const rejected = createResourceOperationDeliveryService({
    emitResourceEvent: () => null,
    isAuthorityCurrent: () => true,
  });
  const rejectedOutcome = await rejected.drainNextDelivery(reportDelivered, {
    guard,
  });
  assert.equal(rejectedOutcome.action, "retry");
  assert.equal(rejectedOutcome.reason, "prompt-ack-emit-rejected");
  assert.equal(rejectedOutcome.updatedRecord, undefined);
  assert.equal(firstAck.state, "pending");

  const altered = createResourceOperationDeliveryService({
    emitResourceEvent: (type, payload) => ({
      ...payload,
      deliveryId: "wrong-delivery",
      type,
      originUserId: "gm-1",
    }),
    isAuthorityCurrent: () => true,
  });
  const alteredOutcome = await altered.drainNextDelivery(reportDelivered, {
    guard,
  });
  assert.equal(alteredOutcome.action, "retry");
  assert.equal(alteredOutcome.reason, "prompt-ack-emit-rejected");
}

/* ACKs emit and confirm one at a time in persisted assignment order. */
{
  let record = markResourceDeliveryDelivered(
    canonicalTerminal,
    canonicalTerminal.outbox.entries[0].deliveryId,
    { guard, at: 141, confirmed: true },
  );
  const emissions = [];
  let now = 142;
  const service = createResourceOperationDeliveryService({
    emitResourceEvent: (type, payload) => {
      emissions.push({ type, payload: structuredClone(payload) });
      return { ...payload, type, originUserId: "gm-1" };
    },
    isAuthorityCurrent: () => true,
    now: () => now,
  });

  const firstPending = record.outbox.entries[1];
  const firstEmit = await service.drainNextDelivery(record, { guard });
  assert.equal(firstEmit.action, "awaiting-confirmation");
  assert.equal(firstEmit.deliveryId, firstPending.deliveryId);
  assert.equal(firstEmit.updatedRecord, undefined);
  assert.equal(emissions.length, 1);
  assert.equal(emissions[0].type, RESOURCE_EVENTS.FORAGE_ACK);
  assert.equal(emissions[0].payload.runId, record.runId);
  assert.equal(emissions[0].payload.promptId, firstPending.promptId);
  assert.equal(emissions[0].payload.deliveryId, firstPending.deliveryId);
  assert.equal(emissions[0].payload.targetUserId, "player-1");
  assert.deepEqual(emissions[0].payload.result, firstPending.payload);
  assert.equal(emissions[0].payload.food, 3);
  assert.equal(emissions[0].payload.water, 2);

  const repeated = await service.drainNextDelivery(record, { guard });
  assert.equal(repeated.deliveryId, firstPending.deliveryId);
  assert.equal(emissions.length, 2);
  assert.equal(
    emissions.some(
      ({ payload }) =>
        payload.deliveryId === record.outbox.entries[2].deliveryId,
    ),
    false,
    "the second acknowledgement cannot overtake an unconfirmed first one",
  );

  const earlySecond = service.confirmPromptAcknowledgement(
    record,
    confirmationFor(record.outbox.entries[2]),
    { guard },
  );
  assert.equal(earlySecond.action, "ignored");
  assert.equal(earlySecond.reason, "prompt-ack-confirmation-out-of-order");

  const firstConfirmed = service.confirmPromptAcknowledgement(
    record,
    confirmationFor(firstPending),
    { guard },
  );
  assert.equal(firstConfirmed.action, "delivered");
  assert.equal(
    firstConfirmed.confirmation,
    "authenticated-player-confirmation",
  );
  record = firstConfirmed.updatedRecord;
  assert.equal(record.outbox.entries[1].state, "delivered");
  assert.equal(record.outbox.entries[2].state, "pending");

  const secondPending = record.outbox.entries[2];
  const secondEmit = await service.drainNextDelivery(record, { guard });
  assert.equal(secondEmit.action, "awaiting-confirmation");
  assert.equal(secondEmit.deliveryId, secondPending.deliveryId);
  assert.equal(emissions.at(-1).payload.targetUserId, "player-2");

  const forged = service.confirmPromptAcknowledgement(
    record,
    confirmationFor(secondPending, "player-1"),
    { guard },
  );
  assert.equal(forged.action, "ignored");
  assert.equal(forged.reason, "prompt-ack-confirmation-identity-mismatch");

  now = 143;
  const secondConfirmed = service.confirmPromptAcknowledgement(
    record,
    confirmationFor(secondPending),
    { guard },
  );
  assert.equal(secondConfirmed.action, "delivered");
  record = secondConfirmed.updatedRecord;
  assert.ok(
    record.outbox.entries.every((entry) => entry.state === "delivered"),
  );
  const idle = await service.drainNextDelivery(record, { guard });
  assert.equal(idle.action, "idle");
  assert.equal(idle.updatedRecord, undefined);

  const duplicate = service.confirmPromptAcknowledgement(
    record,
    confirmationFor(secondPending),
    { guard },
  );
  assert.equal(duplicate.action, "already-confirmed");
  assert.equal(duplicate.updatedRecord, undefined);
}

process.stdout.write("resource operation delivery validation passed\n");
