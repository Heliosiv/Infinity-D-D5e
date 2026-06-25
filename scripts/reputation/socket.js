/**
 * Infinity D&D5e — Reputation Socket
 *
 * GM → player projection of revealed factions. Shares the module socket
 * name (`module.infinity-dnd5e`) with the merchant + audio handlers; every
 * payload carries a `type`, and each handler ignores types it doesn't own,
 * so the three registrations coexist on one socket.
 *
 * Authority model (mirrors merchant/socket.js):
 * - The GM owns the faction store. A player's view requests the revealed
 *   list (LIST_REQUEST); only the authoritative GM answers (LIST_REPLY).
 * - When the GM edits a faction, the workspace broadcasts STATE_UPDATE so
 *   any open player view refreshes live.
 * - Players never write — the view is read-only.
 */

import { listRevealedForPlayers } from "./store.js";

const MODULE_ID = "infinity-dnd5e";
const SOCKET_NAME = `module.${MODULE_ID}`;

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
  const socket = globalThis.game?.socket;
  if (!socket || registered) return registered;
  if (typeof socket.on !== "function") return false;
  socket.on(SOCKET_NAME, receiveReputationPayload);
  registered = true;
  return true;
}

/** Only the active (primary) GM answers player→GM messages, so a multi-GM
 *  table doesn't reply twice. */
function isAuthoritativeGM() {
  const game = globalThis.game;
  if (!game?.user?.isGM) return false;
  const active = game.users?.activeGM;
  if (!active) return true;
  return active.id === game.user.id;
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
  const socket = globalThis.game?.socket;
  if (typeof socket?.emit === "function") {
    socket.emit(SOCKET_NAME, payload);
  }
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

export function receiveReputationPayload(payload) {
  if (!payload || typeof payload !== "object") return;
  if (!REPUTATION_TYPES.has(payload.type)) return;

  // Suppress echo to self — we already dispatched locally on emit.
  if (
    payload.originUserId &&
    payload.originUserId === globalThis.game?.user?.id
  ) {
    return;
  }

  dispatchToListeners(payload.type, payload);

  // GM-authority route: answer a player's list request.
  if (payload.type === REPUTATION_EVENTS.LIST_REQUEST && isAuthoritativeGM()) {
    try {
      handleListRequest(payload);
    } catch (error) {
      console.error(`${MODULE_ID} | reputation list-request handler`, error);
    }
  }
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
