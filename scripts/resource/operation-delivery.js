/**
 * Infinity D&D5e - durable Quartermaster terminal delivery service
 *
 * Terminal records own an ordered outbox. This adapter performs at most one
 * external delivery per drain, and it never advances the durable record until
 * the external result has been canonically confirmed. All Foundry bindings are
 * injectable so crash gaps and authority handoffs can be exercised in Node.
 */

import {
  createResourceTerminalDeliveries,
  markResourceDeliveryDelivered,
  normalizeResourceOperation,
  resourceOperationGuardMatches,
  transitionResourceOperation,
} from "./operation-ledger.js";
import {
  emitResourceEvent,
  isResourceAuthorityReady,
  RESOURCE_EVENTS,
} from "./socket.js";

const MODULE_ID = "infinity-dnd5e";

export const RESOURCE_CHAT_MESSAGE_ID_LENGTH = 16;
export const RESOURCE_REPORT_DELIVERY_FIELD = "chatDelivery";
export const RESOURCE_REPORT_DELIVERY_VERSION = 1;
export const RESOURCE_CHAT_DELIVERY_FLAG = "resourceOperationDelivery";

const CHAT_MESSAGE_ID_PATTERN = /^[A-Za-z0-9]{16}$/u;

export class ResourceOperationDeliveryError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "ResourceOperationDeliveryError";
    this.code = code;
  }
}

/**
 * Create a delivery service with replaceable Foundry bindings.
 *
 * The returned methods are intentionally small integration seams:
 * - prepareTerminalRecord returns a terminal record that must be persisted
 *   before drainNextDelivery is called.
 * - drainNextDelivery handles only the first pending outbox entry.
 * - confirmPromptAcknowledgement consumes the authenticated player receipt.
 */
export function createResourceOperationDeliveryService(bindings = {}) {
  const runtime = normalizeBindings(bindings);
  return Object.freeze({
    prepareTerminalRecord(record, options = {}) {
      return prepareTerminalRecord(record, options, runtime);
    },
    async drainNextDelivery(record, options = {}) {
      return drainNextDelivery(record, options, runtime);
    },
    confirmPromptAcknowledgement(record, confirmation, options = {}) {
      return confirmPromptAcknowledgement(
        record,
        confirmation,
        options,
        runtime,
      );
    },
  });
}

/**
 * Pure projection of one pending acknowledgement onto the Resource socket.
 * The complete persisted result is carried alongside compatibility fields used
 * by the current player prompt.
 */
export function buildResourcePromptAcknowledgementPayload(record, delivery) {
  const current = normalizeResourceOperation(record);
  const pending = current.outbox.entries.find(
    (entry) => entry.deliveryId === delivery?.deliveryId,
  );
  if (!pending || pending.kind !== "prompt-ack") {
    fail(
      "RESOURCE_DELIVERY_INVALID_ACK",
      "Prompt acknowledgement does not belong to this operation",
    );
  }
  const persisted = pending.payload;
  const resolved = persisted.yield;
  if (
    persisted.runId !== current.runId ||
    persisted.promptId !== pending.promptId ||
    !resolved ||
    typeof resolved !== "object"
  ) {
    fail(
      "RESOURCE_DELIVERY_INVALID_ACK",
      "Prompt acknowledgement payload is not bound to its durable identity",
    );
  }
  return deepFreeze({
    targetUserId: pending.recipient.id,
    runId: current.runId,
    actorId: persisted.actorId,
    promptId: pending.promptId,
    deliveryId: pending.deliveryId,
    result: cloneJson(persisted),
    forageTarget: resolved.forageTarget,
    food: resolved.food,
    water: resolved.water,
    success: resolved.foodSuccess === true || resolved.waterSuccess === true,
    foodSuccess: resolved.foodSuccess === true,
    waterSuccess: resolved.waterSuccess === true,
    foodSuppressed: resolved.suppressedFood === true,
    waterSuppressed: resolved.suppressedWater === true,
    suppressed:
      resolved.suppressedFood === true || resolved.suppressedWater === true,
    noResponse: persisted.outcome === "timeout",
  });
}

function normalizeBindings(bindings) {
  if (!isPlainObject(bindings)) {
    fail(
      "RESOURCE_DELIVERY_INVALID_BINDINGS",
      "Delivery bindings must be a plain object",
    );
  }
  return Object.freeze({
    allocateChatMessageId:
      bindings.allocateChatMessageId ?? defaultAllocateChatMessageId,
    findChatMessage: bindings.findChatMessage ?? defaultFindChatMessage,
    createChatMessage: bindings.createChatMessage ?? defaultCreateChatMessage,
    emitResourceEvent: bindings.emitResourceEvent ?? emitResourceEvent,
    isAuthorityCurrent:
      bindings.isAuthorityCurrent ?? (() => isResourceAuthorityReady()),
    now: bindings.now ?? (() => Date.now()),
  });
}

function prepareTerminalRecord(record, options, runtime) {
  const current = normalizeResourceOperation(record);
  const report = cloneJsonObject(options.report, "report");
  if (Object.hasOwn(report, RESOURCE_REPORT_DELIVERY_FIELD)) {
    fail(
      "RESOURCE_DELIVERY_RESERVED_REPORT_FIELD",
      `Report already owns reserved field ${RESOURCE_REPORT_DELIVERY_FIELD}`,
    );
  }
  const chat = normalizeChatOptions(options.chat);
  const messageId = String(
    runtime.allocateChatMessageId(RESOURCE_CHAT_MESSAGE_ID_LENGTH) ?? "",
  );
  if (!CHAT_MESSAGE_ID_PATTERN.test(messageId)) {
    fail(
      "RESOURCE_DELIVERY_INVALID_MESSAGE_ID",
      "ChatMessage allocator must reserve exactly 16 alphanumeric characters",
    );
  }

  const reportPayload = {
    ...report,
    [RESOURCE_REPORT_DELIVERY_FIELD]: {
      version: RESOURCE_REPORT_DELIVERY_VERSION,
      messageId,
      content: chat.content,
      speaker: chat.speaker,
      whisper: chat.whisper,
    },
  };
  const deliveries = createResourceTerminalDeliveries(current, {
    report: reportPayload,
    reportRecipient: {
      type: "chat",
      id: String(options.reportRecipientId ?? "public").trim(),
    },
  });
  return transitionResourceOperation(current, "terminal", {
    guard: options.guard,
    at: observedTime(options.at, runtime),
    report: reportPayload,
    receipt: options.receipt,
    deliveries,
  });
}

async function drainNextDelivery(record, options, runtime) {
  const current = normalizeResourceOperation(record);
  const pending = current.outbox.entries.find(
    (entry) => entry.state === "pending",
  );
  if (!pending) return result("idle", { reason: "outbox-complete" });
  if (!hasCurrentAuthority(current, options.guard, runtime)) {
    return result("authority-lost", {
      reason: "operation-guard-or-runtime-authority-changed",
      deliveryId: pending.deliveryId,
    });
  }
  if (pending.kind === "report") {
    return drainReportDelivery(current, pending, options, runtime);
  }
  if (pending.kind === "prompt-ack") {
    return drainPromptAcknowledgement(current, pending, options, runtime);
  }
  return result("needs-review", {
    reason: "unsupported-terminal-delivery-kind",
    deliveryId: pending.deliveryId,
  });
}

async function drainReportDelivery(record, delivery, options, runtime) {
  let expected;
  try {
    expected = expectedChatMessage(record, delivery);
  } catch (error) {
    return result("needs-review", {
      reason: "malformed-persisted-report-delivery",
      deliveryId: delivery.deliveryId,
      error: errorMessage(error),
    });
  }

  const before = await lookupChatMessage(runtime, expected._id);
  if (before.error) {
    return result("retry", {
      reason: "canonical-chat-lookup-failed",
      deliveryId: delivery.deliveryId,
      error: before.error,
    });
  }
  if (before.message) {
    if (!chatMessageMatches(before.message, expected)) {
      return messageCollision(delivery, expected, before.message);
    }
    if (!hasCurrentAuthority(record, options.guard, runtime)) {
      return result("authority-lost", {
        reason: "authority-changed-after-canonical-chat-lookup",
        deliveryId: delivery.deliveryId,
      });
    }
    return confirmedDelivery(record, delivery, options, runtime, {
      confirmation: "existing-canonical-chat-message",
    });
  }

  if (!hasCurrentAuthority(record, options.guard, runtime)) {
    return result("authority-lost", {
      reason: "authority-changed-before-chat-create",
      deliveryId: delivery.deliveryId,
    });
  }

  let createError = null;
  try {
    await runtime.createChatMessage(cloneJson(expected), { keepId: true });
  } catch (error) {
    createError = errorMessage(error);
  }

  // A Document create can commit server-side and still reject locally. Always
  // read the world collection after the attempt; the thrown result alone is
  // not evidence that delivery failed.
  const after = await lookupChatMessage(runtime, expected._id);
  if (after.error) {
    return result("retry", {
      reason: "canonical-chat-readback-failed",
      deliveryId: delivery.deliveryId,
      error: after.error,
      createError,
    });
  }
  if (!after.message) {
    return result("retry", {
      reason: createError
        ? "chat-create-failed-without-canonical-message"
        : "created-chat-message-not-canonical",
      deliveryId: delivery.deliveryId,
      error: createError,
    });
  }
  if (!chatMessageMatches(after.message, expected)) {
    return messageCollision(delivery, expected, after.message, createError);
  }
  if (!hasCurrentAuthority(record, options.guard, runtime)) {
    return result("authority-lost", {
      reason: "authority-changed-after-canonical-chat-readback",
      deliveryId: delivery.deliveryId,
    });
  }
  return confirmedDelivery(record, delivery, options, runtime, {
    confirmation: createError
      ? "canonical-chat-message-after-create-error"
      : "created-canonical-chat-message",
  });
}

async function drainPromptAcknowledgement(record, delivery, options, runtime) {
  const payload = buildResourcePromptAcknowledgementPayload(record, delivery);
  let emitted;
  try {
    emitted = await runtime.emitResourceEvent(
      RESOURCE_EVENTS.FORAGE_ACK,
      cloneJson(payload),
    );
  } catch (error) {
    return result("retry", {
      reason: "prompt-ack-emit-threw",
      deliveryId: delivery.deliveryId,
      error: errorMessage(error),
    });
  }
  if (!strictSocketEmissionMatches(emitted, payload)) {
    return result("retry", {
      reason: "prompt-ack-emit-rejected",
      deliveryId: delivery.deliveryId,
    });
  }
  return result("awaiting-confirmation", {
    reason: "prompt-ack-emitted",
    deliveryId: delivery.deliveryId,
    promptId: delivery.promptId,
    authorityChanged: !hasCurrentAuthority(record, options.guard, runtime),
  });
}

function confirmPromptAcknowledgement(record, confirmation, options, runtime) {
  const current = normalizeResourceOperation(record);
  if (!isPlainObject(confirmation)) {
    return result("ignored", { reason: "confirmation-not-object" });
  }
  const delivery = current.outbox.entries.find(
    (entry) => entry.deliveryId === confirmation.deliveryId,
  );
  if (!delivery || delivery.kind !== "prompt-ack") {
    return result("ignored", { reason: "unknown-prompt-ack-delivery" });
  }
  const persistedActorId = delivery.payload.actorId;
  if (
    (Object.hasOwn(confirmation, "type") &&
      confirmation.type !== RESOURCE_EVENTS.ACK_DELIVERY_CONFIRM) ||
    confirmation.runId !== current.runId ||
    confirmation.promptId !== delivery.promptId ||
    confirmation.actorId !== persistedActorId ||
    confirmation.originUserId !== delivery.recipient.id
  ) {
    return result("ignored", {
      reason: "prompt-ack-confirmation-identity-mismatch",
      deliveryId: delivery.deliveryId,
    });
  }
  if (delivery.state === "delivered") {
    return result("already-confirmed", {
      reason: "durable-delivery-marker-present",
      deliveryId: delivery.deliveryId,
    });
  }
  const firstPending = current.outbox.entries.find(
    (entry) => entry.state === "pending",
  );
  if (firstPending?.deliveryId !== delivery.deliveryId) {
    return result("ignored", {
      reason: "prompt-ack-confirmation-out-of-order",
      deliveryId: delivery.deliveryId,
    });
  }
  if (!hasCurrentAuthority(current, options.guard, runtime)) {
    return result("authority-lost", {
      reason: "operation-guard-or-runtime-authority-changed",
      deliveryId: delivery.deliveryId,
    });
  }
  return confirmedDelivery(current, delivery, options, runtime, {
    confirmation: "authenticated-player-confirmation",
  });
}

function confirmedDelivery(record, delivery, options, runtime, extra = {}) {
  const updatedRecord = markResourceDeliveryDelivered(
    record,
    delivery.deliveryId,
    {
      guard: options.guard,
      at: observedTime(options.at, runtime),
      confirmed: true,
    },
  );
  return result("delivered", {
    ...extra,
    deliveryId: delivery.deliveryId,
    updatedRecord,
  });
}

function expectedChatMessage(record, delivery) {
  const spec = delivery.payload?.[RESOURCE_REPORT_DELIVERY_FIELD];
  if (
    delivery.kind !== "report" ||
    !isPlainObject(spec) ||
    spec.version !== RESOURCE_REPORT_DELIVERY_VERSION ||
    !CHAT_MESSAGE_ID_PATTERN.test(spec.messageId) ||
    typeof spec.content !== "string" ||
    !isPlainObject(spec.speaker) ||
    (spec.whisper !== null &&
      (!Array.isArray(spec.whisper) ||
        spec.whisper.length === 0 ||
        spec.whisper.some(
          (id) => typeof id !== "string" || !id.trim() || id !== id.trim(),
        )))
  ) {
    fail(
      "RESOURCE_DELIVERY_INVALID_REPORT",
      "Persisted report does not contain an exact ChatMessage delivery",
    );
  }
  const messageData = {
    _id: spec.messageId,
    content: spec.content,
    speaker: cloneJson(spec.speaker),
    flags: {
      [MODULE_ID]: {
        [RESOURCE_CHAT_DELIVERY_FLAG]: {
          version: RESOURCE_REPORT_DELIVERY_VERSION,
          runId: record.runId,
          deliveryId: delivery.deliveryId,
          messageId: spec.messageId,
        },
      },
    },
  };
  // Foundry treats an explicitly empty whisper array as visible to nobody.
  // Public reports therefore persist `null` and omit the create field.
  if (spec.whisper !== null) messageData.whisper = [...spec.whisper];
  return messageData;
}

function normalizeChatOptions(chat) {
  if (!isPlainObject(chat)) {
    fail(
      "RESOURCE_DELIVERY_INVALID_REPORT",
      "Terminal report requires ChatMessage delivery data",
    );
  }
  if (typeof chat.content !== "string") {
    fail(
      "RESOURCE_DELIVERY_INVALID_REPORT",
      "ChatMessage content must be a string",
    );
  }
  if (!isPlainObject(chat.speaker)) {
    fail(
      "RESOURCE_DELIVERY_INVALID_REPORT",
      "ChatMessage speaker must be a plain object",
    );
  }
  const requestedWhisper = chat.whisper ?? null;
  const whisper =
    Array.isArray(requestedWhisper) && requestedWhisper.length === 0
      ? null
      : requestedWhisper;
  if (
    whisper !== null &&
    (!Array.isArray(whisper) ||
      whisper.some(
        (id) => typeof id !== "string" || !id.trim() || id !== id.trim(),
      ))
  ) {
    fail(
      "RESOURCE_DELIVERY_INVALID_REPORT",
      "ChatMessage whisper must be null or exact user ids",
    );
  }
  if (whisper !== null && new Set(whisper).size !== whisper.length) {
    fail(
      "RESOURCE_DELIVERY_INVALID_REPORT",
      "ChatMessage whisper recipients must be unique",
    );
  }
  return {
    content: chat.content,
    speaker: cloneJson(chat.speaker),
    whisper: whisper === null ? null : [...whisper],
  };
}

async function lookupChatMessage(runtime, messageId) {
  try {
    return { message: (await runtime.findChatMessage(messageId)) ?? null };
  } catch (error) {
    return { message: null, error: errorMessage(error) };
  }
}

function chatMessageMatches(message, expected) {
  const source = message?._source ?? message;
  const messageId = String(
    message?.id ?? message?._id ?? source?._id ?? "",
  ).trim();
  const content = message?.content ?? source?.content;
  const speaker = message?.speaker ?? source?.speaker;
  const whisper = message?.whisper ?? source?.whisper;
  const deliveryFlag =
    message?.getFlag?.(MODULE_ID, RESOURCE_CHAT_DELIVERY_FLAG) ??
    message?.flags?.[MODULE_ID]?.[RESOURCE_CHAT_DELIVERY_FLAG] ??
    source?.flags?.[MODULE_ID]?.[RESOURCE_CHAT_DELIVERY_FLAG] ??
    null;
  const expectedFlag = expected.flags[MODULE_ID][RESOURCE_CHAT_DELIVERY_FLAG];
  return (
    messageId === expected._id &&
    content === expected.content &&
    sameJson(speaker, expected.speaker) &&
    whisperMatchesExpected(whisper, expected) &&
    sameJson(deliveryFlag, expectedFlag)
  );
}

function whisperMatchesExpected(observed, expected) {
  if (Object.hasOwn(expected, "whisper")) {
    return sameJson(observed, expected.whisper);
  }
  return observed === undefined || sameJson(observed, []);
}

function messageCollision(delivery, expected, observed, createError = null) {
  return result("needs-review", {
    reason: "chat-message-id-collision",
    code: "resource-report-message-collision",
    deliveryId: delivery.deliveryId,
    messageId: expected._id,
    observedMessageId: String(
      observed?.id ?? observed?._id ?? observed?._source?._id ?? "",
    ).trim(),
    createError,
  });
}

function strictSocketEmissionMatches(emitted, payload) {
  if (!isPlainObject(emitted)) return false;
  const expected = {
    ...payload,
    type: RESOURCE_EVENTS.FORAGE_ACK,
    originUserId: emitted.originUserId,
  };
  return (
    typeof emitted.originUserId === "string" &&
    emitted.originUserId.trim().length > 0 &&
    sameJson(emitted, expected)
  );
}

function hasCurrentAuthority(record, guard, runtime) {
  if (!resourceOperationGuardMatches(record, guard)) return false;
  try {
    return runtime.isAuthorityCurrent({ record, guard }) === true;
  } catch {
    return false;
  }
}

function observedTime(explicit, runtime) {
  const value = explicit ?? runtime.now();
  if (!Number.isSafeInteger(value) || value < 0) {
    fail(
      "RESOURCE_DELIVERY_INVALID_TIME",
      "Delivery timestamp must be a non-negative safe integer",
    );
  }
  return value;
}

function defaultAllocateChatMessageId(length) {
  const allocate = globalThis.foundry?.utils?.randomID;
  if (typeof allocate !== "function") {
    fail(
      "RESOURCE_DELIVERY_RUNTIME_UNAVAILABLE",
      "Foundry randomID is unavailable",
    );
  }
  return allocate(length);
}

function defaultFindChatMessage(messageId) {
  return globalThis.game?.messages?.get?.(messageId) ?? null;
}

function defaultCreateChatMessage(data, options) {
  if (typeof globalThis.ChatMessage?.create !== "function") {
    fail(
      "RESOURCE_DELIVERY_RUNTIME_UNAVAILABLE",
      "ChatMessage.create is unavailable",
    );
  }
  return globalThis.ChatMessage.create(data, options);
}

function cloneJson(value) {
  return structuredClone(value);
}

function cloneJsonObject(value, label) {
  if (!isPlainObject(value)) {
    fail("RESOURCE_DELIVERY_INVALID_REPORT", `${label} must be a plain object`);
  }
  return cloneJson(value);
}

function sameJson(left, right) {
  if (Object.is(left, right)) return true;
  if (Array.isArray(left) || Array.isArray(right)) {
    if (!Array.isArray(left) || !Array.isArray(right)) return false;
    if (left.length !== right.length) return false;
    return left.every((entry, index) => sameJson(entry, right[index]));
  }
  if (isPlainObject(left) && isPlainObject(right)) {
    const leftKeys = Object.keys(left).sort();
    const rightKeys = Object.keys(right).sort();
    if (!sameJson(leftKeys, rightKeys)) return false;
    return leftKeys.every((key) => sameJson(left[key], right[key]));
  }
  return false;
}

function isPlainObject(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function result(action, details = {}) {
  return Object.freeze({ action, ...details });
}

function errorMessage(error) {
  return String(error?.message ?? error ?? "unknown delivery error");
}

function deepFreeze(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) {
    return value;
  }
  Object.freeze(value);
  for (const child of Object.values(value)) deepFreeze(child);
  return value;
}

function fail(code, message) {
  throw new ResourceOperationDeliveryError(code, message);
}
