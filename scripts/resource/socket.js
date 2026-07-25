/**
 * Infinity D&D5e — Resource Socket
 *
 * GM ↔ player communication for the Quartermaster. Shares the module socket
 * name with the merchant + audio layers; every payload carries a `type` and
 * handlers filter by it, so the three coexist on one `game.socket.on`.
 *
 * Authority model (mirrors merchant/socket.js):
 * - The authoritative GM owns day detection, the world settings, and all actor
 *   writes (consumption + foraged deposits — a GM has owner perms on every PC).
 * - The Survival ROLL runs on each player's client; only the total is sent back.
 * - Listeners receive every broadcast; non-target roles self-filter.
 */

import {
  authenticateSocketPayload,
  isActiveSocketUser,
  isAuthoritativeGM as sharedIsAuthoritativeGM,
  isAuthoritativeGMSender,
  withAuthenticatedOrigin,
} from "../socket-authority.js";
import { isResourceAutomationReady } from "./store.js";

const MODULE_ID = "infinity-dnd5e";
const SOCKET_NAME = `module.${MODULE_ID}`;

export const RESOURCE_EVENTS = Object.freeze({
  // GM → player: a new day; here is the environment + whether foraging is open.
  DAY_PROMPT: "resource:day-prompt",
  // player → GM: the player's Survival total (or a skip). GM-authoritative.
  FORAGE_RESULT: "resource:forage-result",
  // GM → player: the resolved yield for that forager (so their prompt updates).
  FORAGE_ACK: "resource:forage-ack",
  // GM → all: the daily upkeep report (drives the manager refresh + toasts).
  UPKEEP_REPORT: "resource:upkeep-report",
  // GM → all: run-state changed (manager re-render).
  STATE_UPDATE: "resource:state-update",
  // player -> GM: request the sanitized, read-only Supplies projection.
  OVERVIEW_REQUEST: "resource:overview-request",
  // GM -> requesting player: targeted Supplies projection.
  OVERVIEW_REPLY: "resource:overview-reply",
});

const RESOURCE_TYPES = new Set(Object.values(RESOURCE_EVENTS));
const PLAYER_TO_GM_TYPES = new Set([
  RESOURCE_EVENTS.FORAGE_RESULT,
  RESOURCE_EVENTS.OVERVIEW_REQUEST,
]);
const TARGETED_TYPES = new Set([
  RESOURCE_EVENTS.DAY_PROMPT,
  RESOURCE_EVENTS.FORAGE_ACK,
  RESOURCE_EVENTS.OVERVIEW_REPLY,
]);
const REQUEST_ID_TYPES = new Set([
  RESOURCE_EVENTS.OVERVIEW_REQUEST,
  RESOURCE_EVENTS.OVERVIEW_REPLY,
]);
const FORAGE_ACTOR_TYPES = new Set([
  RESOURCE_EVENTS.DAY_PROMPT,
  RESOURCE_EVENTS.FORAGE_RESULT,
  RESOURCE_EVENTS.FORAGE_ACK,
]);
const MAX_PROTOCOL_ID_LENGTH = 160;
const MIN_FORAGE_ROLL_TOTAL = -50;
const MAX_FORAGE_ROLL_TOTAL = 100;

let registered = false;
const listeners = new Map();

/** Subscribe to a resource event type. Returns an unsubscribe function. */
export function subscribe(eventType, handler) {
  if (!RESOURCE_TYPES.has(eventType) || typeof handler !== "function") {
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

function dispatchToListeners(eventType, payload) {
  const bucket = listeners.get(eventType);
  if (!bucket) return;
  for (const handler of bucket) {
    try {
      handler(payload);
    } catch (error) {
      console.warn(`${MODULE_ID} | resource listener for ${eventType}`, error);
    }
  }
}

/** Register the resource socket handler. Idempotent. */
export function registerResourceSocket() {
  const socket = globalThis.game?.socket;
  if (!socket || registered) return registered;
  if (typeof socket.on !== "function") return false;
  socket.on(SOCKET_NAME, (payload, senderUserId) =>
    receiveResourcePayload(payload, senderUserId),
  );
  registered = true;
  return true;
}

/**
 * Whether this client should act as the authoritative GM. Only the active GM
 * (Foundry's "primary") handles player→GM messages and owns world writes, so a
 * multi-GM table doesn't double-process.
 */
export function isAuthoritativeGM() {
  return sharedIsAuthoritativeGM() && isResourceAutomationReady();
}

/**
 * Validate the small, security-sensitive portion of the resource protocol.
 *
 * Overview snapshots and forage prompts/acknowledgements are private targeted
 * messages, while forage results are client-originated claims. Keeping these
 * fields strict and bounded prevents a malformed event from becoming a
 * broadcast or reaching the GM's run-state logic.
 */
export function validateResourcePayloadShape(payload) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return { ok: false, reason: "payload-not-object" };
  }
  if (!RESOURCE_TYPES.has(payload.type)) {
    return { ok: false, reason: "unknown-event-type" };
  }
  if (
    TARGETED_TYPES.has(payload.type) &&
    !isBoundedProtocolId(payload.targetUserId)
  ) {
    return { ok: false, reason: "missing-or-invalid-target-user-id" };
  }
  if (
    REQUEST_ID_TYPES.has(payload.type) &&
    !isBoundedProtocolId(payload.requestId)
  ) {
    return { ok: false, reason: "missing-or-invalid-request-id" };
  }
  if (FORAGE_ACTOR_TYPES.has(payload.type)) {
    if (!isBoundedProtocolId(payload.runId)) {
      return { ok: false, reason: "missing-or-invalid-run-id" };
    }
    if (!isBoundedProtocolId(payload.actorId)) {
      return { ok: false, reason: "missing-or-invalid-actor-id" };
    }
  }
  if (payload.type === RESOURCE_EVENTS.FORAGE_RESULT) {
    if (typeof payload.skipped !== "boolean") {
      return { ok: false, reason: "invalid-skipped-flag" };
    }
    if (
      typeof payload.rollTotal !== "number" ||
      !Number.isFinite(payload.rollTotal) ||
      !Number.isInteger(payload.rollTotal)
    ) {
      return { ok: false, reason: "invalid-roll-total" };
    }
    if (payload.skipped && payload.rollTotal !== 0) {
      return { ok: false, reason: "skipped-roll-must-be-zero" };
    }
    if (
      !payload.skipped &&
      (payload.rollTotal < MIN_FORAGE_ROLL_TOTAL ||
        payload.rollTotal > MAX_FORAGE_ROLL_TOTAL)
    ) {
      return { ok: false, reason: "roll-total-out-of-range" };
    }
  }
  return { ok: true, reason: null };
}

/** Emit a resource event over the socket. Dispatches locally too so the
 *  originator's own UI can react without a round-trip. */
export function emitResourceEvent(type, data = {}) {
  if (!RESOURCE_TYPES.has(type)) {
    console.warn(`${MODULE_ID} | refused unknown resource event "${type}"`);
    return null;
  }
  const payload = {
    ...data,
    type,
    originUserId: globalThis.game?.user?.id ?? null,
  };
  const validation = validateResourcePayloadShape(payload);
  if (!validation.ok) {
    auditInvalidResourcePayload("outgoing", payload, validation.reason);
    return null;
  }
  const socket = globalThis.game?.socket;
  if (typeof socket?.emit === "function") {
    const targetUserId =
      typeof payload.targetUserId === "string"
        ? payload.targetUserId.trim()
        : "";
    if (targetUserId) {
      socket.emit(SOCKET_NAME, payload, { recipients: [targetUserId] });
    } else {
      socket.emit(SOCKET_NAME, payload);
    }
  }
  dispatchToListeners(type, payload);
  return payload;
}

export function receiveResourcePayload(payload, authenticatedSenderId) {
  // The module socket is shared with merchant, reputation, and audio events.
  // Ignore their envelopes before applying the resource protocol validator.
  if (
    !payload ||
    typeof payload !== "object" ||
    typeof payload.type !== "string" ||
    !payload.type.startsWith("resource:")
  ) {
    return;
  }
  const validation = validateResourcePayloadShape(payload);
  if (!validation.ok) {
    auditInvalidResourcePayload(
      "incoming",
      payload,
      validation.reason,
      authenticatedSenderId,
    );
    return;
  }
  // Foundry 13.351's server-side custom socket relay supplies the authenticated
  // user id as the second callback argument. Resource writes and snapshots fail
  // closed if a future transport omits it; a payload-claimed origin is never
  // sufficient authority here.
  if (
    typeof authenticatedSenderId !== "string" ||
    !authenticatedSenderId.trim()
  ) {
    return;
  }
  // Suppress echo to self — we already dispatched locally on emit.
  const senderId = authenticateSocketPayload(payload, authenticatedSenderId);
  if (!senderId || senderId === globalThis.game?.user?.id) return;
  if (
    typeof payload.targetUserId === "string" &&
    payload.targetUserId.trim() &&
    payload.targetUserId.trim() !== globalThis.game?.user?.id
  ) {
    return;
  }
  if (PLAYER_TO_GM_TYPES.has(payload.type)) {
    if (!isAuthoritativeGM() || !isActiveSocketUser(senderId)) return;
  } else if (!isAuthoritativeGMSender(senderId)) {
    return;
  }
  payload = withAuthenticatedOrigin(payload, senderId);
  dispatchToListeners(payload.type, payload);
}

function isBoundedProtocolId(value) {
  if (typeof value !== "string") return false;
  const normalized = value.trim();
  return normalized.length > 0 && normalized.length <= MAX_PROTOCOL_ID_LENGTH;
}

function auditInvalidResourcePayload(
  direction,
  payload,
  reason,
  authenticatedSenderId = null,
) {
  console.warn(`${MODULE_ID} | rejected ${direction} resource event`, {
    type: typeof payload?.type === "string" ? payload.type : null,
    reason,
    originUserId:
      typeof payload?.originUserId === "string"
        ? payload.originUserId.slice(0, MAX_PROTOCOL_ID_LENGTH)
        : null,
    authenticatedSenderId:
      typeof authenticatedSenderId === "string"
        ? authenticatedSenderId.slice(0, MAX_PROTOCOL_ID_LENGTH)
        : null,
  });
}
