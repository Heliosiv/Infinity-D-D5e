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
});

const RESOURCE_TYPES = new Set(Object.values(RESOURCE_EVENTS));

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
  socket.on(SOCKET_NAME, receiveResourcePayload);
  registered = true;
  return true;
}

/**
 * Whether this client should act as the authoritative GM. Only the active GM
 * (Foundry's "primary") handles player→GM messages and owns world writes, so a
 * multi-GM table doesn't double-process.
 */
export function isAuthoritativeGM() {
  const game = globalThis.game;
  if (!game?.user?.isGM) return false;
  const active = game.users?.activeGM;
  if (!active) return true;
  return active.id === game.user.id;
}

/** Emit a resource event over the socket. Dispatches locally too so the
 *  originator's own UI can react without a round-trip. */
export function emitResourceEvent(type, data = {}) {
  if (!RESOURCE_TYPES.has(type)) {
    console.warn(`${MODULE_ID} | refused unknown resource event "${type}"`);
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
  dispatchToListeners(type, payload);
  return payload;
}

export function receiveResourcePayload(payload) {
  if (!payload || typeof payload !== "object") return;
  if (!RESOURCE_TYPES.has(payload.type)) return;
  // Suppress echo to self — we already dispatched locally on emit.
  if (
    payload.originUserId &&
    payload.originUserId === globalThis.game?.user?.id
  ) {
    return;
  }
  dispatchToListeners(payload.type, payload);
}
