import { authenticateSocketPayload } from "./socket-authority.js";

export const MODULE_ID = "infinity-dnd5e";
export const MODULE_SOCKET_NAME = `module.${MODULE_ID}`;

const MAX_ROUTE_ID_LENGTH = 80;
const MAX_EVENT_TYPE_LENGTH = 200;
const MAX_RECIPIENT_ID_LENGTH = 160;
const routesById = new Map();
const routesByType = new Map();

let listeningSocket = null;

/**
 * Register one feature protocol on the module's shared raw socket.
 *
 * Routes own exact, existing `payload.type` values. The router deliberately
 * leaves payload validation, role authority, recipient semantics, and local
 * dispatch with the feature protocol that already owns those decisions.
 */
export function registerModuleSocketRoute({ id, eventTypes, receive } = {}) {
  const routeId = normalizeRouteId(id);
  const types = normalizeEventTypes(eventTypes);
  if (!routeId || types.length === 0 || typeof receive !== "function") {
    return false;
  }

  const existing = routesById.get(routeId);
  if (existing) {
    if (
      existing.receive !== receive ||
      !sameEventTypes(existing.eventTypes, types)
    ) {
      console.warn(`${MODULE_ID} | refused conflicting socket route`, {
        routeId,
      });
      return false;
    }
    return ensureModuleSocketListener();
  }

  for (const type of types) {
    const owner = routesByType.get(type);
    if (owner && owner.id !== routeId) {
      console.warn(`${MODULE_ID} | refused duplicate socket event owner`, {
        routeId,
        type,
        owner: owner.id,
      });
      return false;
    }
  }

  // Match the old registrars: when Foundry's socket is not available yet,
  // retain no partial registration and let the feature retry later.
  if (!ensureModuleSocketListener()) return false;

  const route = Object.freeze({
    id: routeId,
    eventTypes: Object.freeze(types),
    receive,
  });
  routesById.set(routeId, route);
  for (const type of types) routesByType.set(type, route);
  return true;
}

/**
 * Emit an unchanged, flat feature payload over the shared module socket.
 *
 * `recipients === undefined` intentionally broadcasts. An explicit empty or
 * invalid recipient list fails closed instead of accidentally broadcasting.
 */
export function emitModuleSocketPayload(payload, { recipients } = {}) {
  if (!isPlainPayload(payload)) return false;
  const socket = globalThis.game?.socket;
  if (typeof socket?.emit !== "function") return false;

  if (recipients === undefined) {
    socket.emit(MODULE_SOCKET_NAME, payload);
    return true;
  }

  const normalizedRecipients = normalizeRecipientIds(recipients);
  if (normalizedRecipients.length === 0) return false;
  socket.emit(MODULE_SOCKET_NAME, payload, {
    recipients: normalizedRecipients,
  });
  return true;
}

function ensureModuleSocketListener() {
  const socket = globalThis.game?.socket;
  if (typeof socket?.on !== "function") return false;
  if (listeningSocket === socket) return true;

  if (listeningSocket && typeof listeningSocket.off === "function") {
    try {
      listeningSocket.off(MODULE_SOCKET_NAME, receiveModuleSocketPayload);
    } catch {
      // A replaced Foundry socket is already obsolete; continue on the live one.
    }
  }

  socket.on(MODULE_SOCKET_NAME, receiveModuleSocketPayload);
  listeningSocket = socket;
  return true;
}

function receiveModuleSocketPayload(payload, authenticatedSenderId) {
  if (!isPlainPayload(payload)) return false;
  const type = normalizeEventType(payload.type);
  if (!type) return false;

  const route = routesByType.get(type);
  if (!route) return false;

  // Every remote raw-socket frame must carry Foundry's transport identity.
  // A client-controlled originUserId is only a consistency claim.
  const senderId = authenticateSocketPayload(payload, authenticatedSenderId);
  if (!senderId) return false;

  try {
    const result = route.receive(payload, senderId);
    if (typeof result?.catch === "function") {
      result.catch((error) => auditRouteFailure(route.id, type, error));
    }
  } catch (error) {
    auditRouteFailure(route.id, type, error);
  }
  return true;
}

function auditRouteFailure(routeId, type, error) {
  console.warn(`${MODULE_ID} | socket route failed`, {
    routeId,
    type,
    error,
  });
}

function isPlainPayload(value) {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function normalizeRouteId(value) {
  if (typeof value !== "string") return "";
  const normalized = value.trim();
  return normalized && normalized.length <= MAX_ROUTE_ID_LENGTH
    ? normalized
    : "";
}

function normalizeEventType(value) {
  if (typeof value !== "string") return "";
  const normalized = value.trim();
  return normalized && normalized.length <= MAX_EVENT_TYPE_LENGTH
    ? normalized
    : "";
}

function normalizeEventTypes(values) {
  if (
    !values ||
    typeof values === "string" ||
    typeof values[Symbol.iterator] !== "function"
  ) {
    return [];
  }
  const types = [];
  const seen = new Set();
  for (const value of values) {
    const type = normalizeEventType(value);
    if (!type || seen.has(type)) continue;
    seen.add(type);
    types.push(type);
  }
  return types.sort();
}

function sameEventTypes(left, right) {
  return (
    left.length === right.length &&
    left.every((type, index) => type === right[index])
  );
}

function normalizeRecipientIds(values) {
  const raw = Array.isArray(values) ? values : [values];
  return [
    ...new Set(
      raw
        .map((value) => (typeof value === "string" ? value.trim() : ""))
        .filter(
          (value) =>
            value.length > 0 && value.length <= MAX_RECIPIENT_ID_LENGTH,
        ),
    ),
  ];
}
