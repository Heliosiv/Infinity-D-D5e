/**
 * Shared socket identity and GM-authority helpers.
 *
 * Foundry supplies the authenticated sending user id as the second argument to
 * module socket callbacks. Payload fields are client-controlled and must never
 * be used as the authority boundary when that authenticated id is available.
 */

import { isFullGM } from "./permissions.js";

function toId(value) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function activeUsers(game = globalThis.game) {
  const users = [];
  game?.users?.forEach?.((user) => {
    if (user?.active) users.push(user);
  });
  return users;
}

/** Return the deterministic authoritative GM id for the current world. */
export function authoritativeGMId(game = globalThis.game) {
  const active = game?.users?.activeGM;
  if (active?.id && isFullGM(active)) return active.id;

  const ids = activeUsers(game)
    .filter((user) => isFullGM(user))
    .map((user) => toId(user.id))
    .filter(Boolean)
    .sort();
  if (ids.length > 0) return ids[0];

  return isFullGM(game?.user) ? toId(game.user.id) : null;
}

/** Whether the current client is the one authoritative GM. */
export function isAuthoritativeGM(game = globalThis.game) {
  const currentId = toId(game?.user?.id);
  return Boolean(
    isFullGM(game?.user) && currentId && authoritativeGMId(game) === currentId,
  );
}

/** Whether `userId` identifies the authoritative GM visible to this client. */
export function isAuthoritativeGMSender(userId, game = globalThis.game) {
  const senderId = toId(userId);
  return Boolean(senderId && authoritativeGMId(game) === senderId);
}

/** Whether a socket sender is a currently active world user. */
export function isActiveSocketUser(userId, game = globalThis.game) {
  const senderId = toId(userId);
  if (!senderId) return false;
  if (senderId === game?.user?.id) return game?.user?.active !== false;
  if (typeof game?.users?.get !== "function") return true;
  const user = game?.users?.get?.(senderId);
  return Boolean(user?.active !== false && user?.id);
}

/** Resolve and verify the transport-authenticated socket sender. */
export function authenticateSocketPayload(payload, authenticatedSenderId) {
  const transportId = toId(authenticatedSenderId);
  const claimedId = toId(payload?.originUserId);
  if (transportId && claimedId && transportId !== claimedId) return null;
  return transportId ?? claimedId;
}

/** Clone a payload with the authenticated identity as its canonical origin. */
export function withAuthenticatedOrigin(payload, senderId) {
  return { ...payload, originUserId: toId(senderId) };
}
