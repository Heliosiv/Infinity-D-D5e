/** Authenticated GM <-> player protocol for Critical Injuries. */

import {
  authenticateSocketPayload,
  isActiveSocketUser,
  isAuthoritativeGM,
  isAuthoritativeGMSender,
  withAuthenticatedOrigin,
} from "../socket-authority.js";

const MODULE_ID = "infinity-dnd5e";
const SOCKET_NAME = `module.${MODULE_ID}`;
const MAX_ID_LENGTH = 160;

export const CRITICAL_INJURY_EVENTS = Object.freeze({
  PROMPT: "critical-injury:prompt",
  ROLL_REQUEST: "critical-injury:roll-request",
  RESULT: "critical-injury:result",
  ROLL_FAILURE: "critical-injury:roll-failure",
  TREATMENT_REQUEST: "critical-injury:treatment-request",
  TREATMENT_RESULT: "critical-injury:treatment-result",
  REST_COMPLETED: "critical-injury:rest-completed",
});

const EVENT_TYPES = new Set(Object.values(CRITICAL_INJURY_EVENTS));
const PLAYER_TO_GM = new Set([
  CRITICAL_INJURY_EVENTS.ROLL_REQUEST,
  CRITICAL_INJURY_EVENTS.TREATMENT_REQUEST,
  CRITICAL_INJURY_EVENTS.REST_COMPLETED,
]);
const TARGETED = new Set([
  CRITICAL_INJURY_EVENTS.PROMPT,
  CRITICAL_INJURY_EVENTS.ROLL_REQUEST,
  CRITICAL_INJURY_EVENTS.RESULT,
  CRITICAL_INJURY_EVENTS.ROLL_FAILURE,
  CRITICAL_INJURY_EVENTS.TREATMENT_REQUEST,
  CRITICAL_INJURY_EVENTS.TREATMENT_RESULT,
]);

let registered = false;
const listeners = new Map();

export function subscribeCriticalInjury(eventType, handler) {
  if (!EVENT_TYPES.has(eventType) || typeof handler !== "function") {
    return () => {};
  }
  let bucket = listeners.get(eventType);
  if (!bucket) {
    bucket = new Set();
    listeners.set(eventType, bucket);
  }
  bucket.add(handler);
  return () => bucket.delete(handler);
}

function dispatch(payload) {
  const bucket = listeners.get(payload?.type);
  if (!bucket) return;
  for (const handler of bucket) {
    try {
      handler(payload);
    } catch (error) {
      console.warn(`${MODULE_ID} | critical injury socket listener failed`, {
        type: payload?.type,
        error,
      });
    }
  }
}

export function registerCriticalInjurySocket() {
  const socket = globalThis.game?.socket;
  if (!socket || registered || typeof socket.on !== "function") {
    return registered;
  }
  socket.on(SOCKET_NAME, (payload, senderUserId) =>
    receiveCriticalInjuryPayload(payload, senderUserId),
  );
  registered = true;
  return true;
}

export function validateCriticalInjuryPayload(payload) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return { ok: false, reason: "payload-not-object" };
  }
  if (!EVENT_TYPES.has(payload.type)) {
    return { ok: false, reason: "unknown-event-type" };
  }
  if (!boundedId(payload.actorId)) {
    return { ok: false, reason: "invalid-actor-id" };
  }
  if (TARGETED.has(payload.type) && !boundedId(payload.targetUserId)) {
    return { ok: false, reason: "invalid-target-user-id" };
  }
  if (
    [
      CRITICAL_INJURY_EVENTS.PROMPT,
      CRITICAL_INJURY_EVENTS.ROLL_REQUEST,
      CRITICAL_INJURY_EVENTS.RESULT,
      CRITICAL_INJURY_EVENTS.ROLL_FAILURE,
    ].includes(payload.type) &&
    !boundedId(payload.pendingId)
  ) {
    return { ok: false, reason: "invalid-pending-id" };
  }
  if (
    [
      CRITICAL_INJURY_EVENTS.TREATMENT_REQUEST,
      CRITICAL_INJURY_EVENTS.TREATMENT_RESULT,
    ].includes(payload.type) &&
    (!boundedId(payload.injuryId) || !boundedId(payload.treatmentId))
  ) {
    return { ok: false, reason: "invalid-treatment-id" };
  }
  if (payload.type === CRITICAL_INJURY_EVENTS.ROLL_REQUEST) {
    // The button is player-triggered, but every die is evaluated by the
    // authoritative GM. Reject even an in-range client total so an old or
    // modified client cannot choose its table entry.
    if (Object.hasOwn(payload, "rollTotal")) {
      return { ok: false, reason: "client-roll-total-not-allowed" };
    }
  }
  if (payload.type === CRITICAL_INJURY_EVENTS.ROLL_FAILURE) {
    const message = String(payload.message ?? "").trim();
    if (!message || message.length > 500) {
      return { ok: false, reason: "invalid-failure-message" };
    }
    if (typeof payload.retryable !== "boolean") {
      return { ok: false, reason: "invalid-failure-retry-state" };
    }
  }
  if (payload.type === CRITICAL_INJURY_EVENTS.TREATMENT_REQUEST) {
    const allowed = new Set([
      "type",
      "actorId",
      "injuryId",
      "treatmentId",
      "targetUserId",
      "originUserId",
    ]);
    if (Object.keys(payload).some((key) => !allowed.has(key))) {
      return { ok: false, reason: "client-treatment-data-not-allowed" };
    }
  }
  if (payload.type === CRITICAL_INJURY_EVENTS.TREATMENT_RESULT) {
    const message = String(payload.message ?? "").trim();
    if (!message || message.length > 500) {
      return { ok: false, reason: "invalid-treatment-message" };
    }
    if (
      typeof payload.success !== "boolean" ||
      typeof payload.retryable !== "boolean"
    ) {
      return { ok: false, reason: "invalid-treatment-result-state" };
    }
    if (
      Object.hasOwn(payload, "resumeTreatmentId") &&
      !boundedId(payload.resumeTreatmentId)
    ) {
      return { ok: false, reason: "invalid-treatment-resume-id" };
    }
  }
  if (
    payload.type === CRITICAL_INJURY_EVENTS.REST_COMPLETED &&
    payload.longRest !== true
  ) {
    return { ok: false, reason: "invalid-rest-kind" };
  }
  return { ok: true, reason: null };
}

export function emitCriticalInjuryEvent(type, data = {}) {
  if (!EVENT_TYPES.has(type)) return null;
  const payload = {
    ...data,
    type,
    originUserId: globalThis.game?.user?.id ?? null,
  };
  const validation = validateCriticalInjuryPayload(payload);
  if (!validation.ok) {
    auditRejected("outgoing", payload, validation.reason);
    return null;
  }

  const socket = globalThis.game?.socket;
  const target = String(payload.targetUserId ?? "").trim();
  if (typeof socket?.emit === "function") {
    if (target) socket.emit(SOCKET_NAME, payload, { recipients: [target] });
    else socket.emit(SOCKET_NAME, payload);
  }
  // The socket relay does not echo to its origin. Local dispatch also lets the
  // authoritative GM roll for an offline/unowned character without a detour.
  dispatch(payload);
  return payload;
}

export function receiveCriticalInjuryPayload(payload, authenticatedSenderId) {
  if (
    !payload ||
    typeof payload?.type !== "string" ||
    !payload.type.startsWith("critical-injury:")
  ) {
    return;
  }
  const validation = validateCriticalInjuryPayload(payload);
  if (!validation.ok) {
    auditRejected(
      "incoming",
      payload,
      validation.reason,
      authenticatedSenderId,
    );
    return;
  }
  // Privileged actor writes fail closed when the transport does not identify
  // the sender. A client-claimed origin is never sufficient.
  if (!boundedId(authenticatedSenderId)) return;
  const senderId = authenticateSocketPayload(payload, authenticatedSenderId);
  if (!senderId || senderId === globalThis.game?.user?.id) return;
  if (
    TARGETED.has(payload.type) &&
    String(payload.targetUserId) !== String(globalThis.game?.user?.id)
  ) {
    return;
  }
  if (PLAYER_TO_GM.has(payload.type)) {
    if (!isAuthoritativeGM() || !isActiveSocketUser(senderId)) return;
  } else if (!isAuthoritativeGMSender(senderId)) {
    return;
  }
  dispatch(withAuthenticatedOrigin(payload, senderId));
}

function boundedId(value) {
  if (typeof value !== "string") return false;
  const id = value.trim();
  return id.length > 0 && id.length <= MAX_ID_LENGTH;
}

function auditRejected(
  direction,
  payload,
  reason,
  authenticatedSenderId = null,
) {
  console.warn(`${MODULE_ID} | rejected ${direction} critical injury event`, {
    type: typeof payload?.type === "string" ? payload.type : null,
    reason,
    originUserId:
      typeof payload?.originUserId === "string"
        ? payload.originUserId.slice(0, MAX_ID_LENGTH)
        : null,
    authenticatedSenderId:
      typeof authenticatedSenderId === "string"
        ? authenticatedSenderId.slice(0, MAX_ID_LENGTH)
        : null,
  });
}
