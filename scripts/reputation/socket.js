/**
 * Infinity D&D5e — Reputation Socket
 *
 * GM → player projection of revealed factions. The compatibility router owns
 * the one raw module listener and dispatches these exact event types here.
 *
 * Authority model (mirrors merchant/socket.js):
 * - The GM owns the faction store. A player's view requests the revealed
 *   list (LIST_REQUEST); only the authoritative GM answers (LIST_REPLY).
 * - When the GM edits a faction, the workspace broadcasts STATE_UPDATE so
 *   any open player view refreshes live.
 * - Players never write — the view is read-only.
 */

import { listRevealedForPlayers } from "./store.js";
import {
  authoritativeGMId,
  authenticateSocketPayload,
  isActiveSocketUser,
  isAuthoritativeGM,
  isAuthoritativeGMSender,
  withAuthenticatedOrigin,
} from "../socket-authority.js";
import { isPrivilegedPrivateStateReady } from "../private-state.js";
import {
  emitModuleSocketPayload,
  registerModuleSocketRoute,
} from "../socket-router.js";

const MODULE_ID = "infinity-dnd5e";

function isPrivateStateAuthorityReady() {
  const liveFoundry = Boolean(
    globalThis.game?.ready && globalThis.JournalEntry?.create,
  );
  return Boolean(
    isAuthoritativeGM() && (!liveFoundry || isPrivilegedPrivateStateReady()),
  );
}

export const REPUTATION_EVENTS = Object.freeze({
  // player → GM: "send me the factions I'm allowed to see"
  LIST_REQUEST: "reputation:list-request",
  // GM → player: the sanitized revealed list (targeted at the requester)
  LIST_REPLY: "reputation:list-reply",
  // GM → all: a revealed faction changed; open views refresh
  STATE_UPDATE: "reputation:state-update",
});

const REPUTATION_TYPES = new Set(Object.values(REPUTATION_EVENTS));

let registered = false;

/** In-memory listeners keyed by event type → set of callbacks. */
const listeners = new Map();

/** Subscribe to a reputation event type. Returns an unsubscribe function. */
export function subscribe(eventType, handler) {
  if (!REPUTATION_TYPES.has(eventType) || typeof handler !== "function") {
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
      console.warn(
        `${MODULE_ID} | reputation listener for ${eventType}`,
        error,
      );
    }
  }
}

/** Register the reputation socket handler. Idempotent. */
export function registerReputationSocket() {
  if (registered) return true;
  if (
    !registerModuleSocketRoute({
      id: "reputation",
      eventTypes: REPUTATION_TYPES,
      receive: receiveReputationPayload,
    })
  ) {
    return false;
  }
  registered = true;
  return true;
}

/* ------------------------------------------------------------------ *
 * Send
 * ------------------------------------------------------------------ */

/** Emit a reputation event over the socket. Returns the payload sent. */
export function emitReputationEvent(type, data = {}) {
  if (!REPUTATION_TYPES.has(type)) {
    console.warn(`${MODULE_ID} | refused unknown reputation event "${type}"`);
    return null;
  }
  const payload = {
    type,
    originUserId: globalThis.game?.user?.id ?? null,
    ...data,
  };
  emitModuleSocketPayload(payload, {
    recipients: resolveOutgoingRecipients(type, payload),
  });
  // Always dispatch to local listeners so the originator sees its own
  // payload (the GM's own workspace can react without a round-trip).
  dispatchToListeners(type, payload);
  return payload;
}

/**
 * Broadcast the current revealed-faction projection to every client.
 * Called by the GM workspace after any edit so open player views refresh.
 */
export function broadcastReputationState() {
  return emitReputationEvent(REPUTATION_EVENTS.STATE_UPDATE, {
    factions: listRevealedForPlayers(),
  });
}

/* ------------------------------------------------------------------ *
 * Receive
 * ------------------------------------------------------------------ */

export function receiveReputationPayload(payload, authenticatedSenderId) {
  if (!payload || typeof payload !== "object") return;
  if (!REPUTATION_TYPES.has(payload.type)) return;

  // Suppress echo to self — we already dispatched locally on emit.
  const senderId = authenticateSocketPayload(payload, authenticatedSenderId);
  if (!senderId || senderId === globalThis.game?.user?.id) return;
  const targetUserId = normalizeUserId(payload.targetUserId);
  if (
    (payload.type === REPUTATION_EVENTS.LIST_REPLY && !targetUserId) ||
    (targetUserId && targetUserId !== globalThis.game?.user?.id)
  ) {
    return;
  }
  if (payload.type === REPUTATION_EVENTS.LIST_REQUEST) {
    if (!isPrivateStateAuthorityReady() || !isActiveSocketUser(senderId))
      return;
  } else if (!isAuthoritativeGMSender(senderId)) {
    return;
  }
  payload = withAuthenticatedOrigin(payload, senderId);

  dispatchToListeners(payload.type, payload);

  // GM-authority route: answer a player's list request.
  if (
    payload.type === REPUTATION_EVENTS.LIST_REQUEST &&
    isPrivateStateAuthorityReady()
  ) {
    try {
      handleListRequest(payload);
    } catch (error) {
      console.error(`${MODULE_ID} | reputation list-request handler`, error);
    }
  }
}

function resolveOutgoingRecipients(type, payload) {
  if (type === REPUTATION_EVENTS.LIST_REQUEST) {
    const gmId = normalizeUserId(authoritativeGMId());
    return gmId ? [gmId] : [];
  }
  if (type === REPUTATION_EVENTS.LIST_REPLY) {
    const targetUserId = normalizeUserId(payload.targetUserId);
    return targetUserId ? [targetUserId] : [];
  }
  return undefined;
}

function normalizeUserId(value) {
  return typeof value === "string" && value.trim() ? value.trim() : "";
}

/** Reply to a player with the sanitized revealed-faction list, targeted at
 *  the requester so other clients ignore it. */
function handleListRequest(payload) {
  emitReputationEvent(REPUTATION_EVENTS.LIST_REPLY, {
    targetUserId: payload.originUserId ?? null,
    requestId: payload.requestId ?? null,
    factions: listRevealedForPlayers(),
  });
}
