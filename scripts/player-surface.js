/**
 * Authenticated, player-targeted launchers used by the campaign hub.
 *
 * The socket envelope carries only the destination player and a fixed surface
 * key. Campaign projections stay behind their existing permission-scoped apps.
 */

import {
  authenticateSocketPayload,
  isActiveSocketUser,
  isAuthoritativeGM,
  isAuthoritativeGMSender,
} from "./socket-authority.js";
import { isFullGM } from "./permissions.js";
import { getSettingDefault, SETTING_KEYS } from "./settings.js";

const MODULE_ID = "infinity-dnd5e";
const CALENDAR_MODULE_IDS = Object.freeze([
  "foundryvtt-simple-calendar-reborn",
  "foundryvtt-simple-calendar",
]);
const SOCKETLIB_MODULE_ID = "socketlib";
const MONKS_ACTIVE_TILES_ID = "monks-active-tiles";
const MAX_ID_LENGTH = 160;
const MATT_SENDER_GUARD_MARKER = Symbol.for(
  "infinity-dnd5e.monks-active-tiles.sender-guard",
);

export const PLAYER_SURFACE_EVENT = "player-surface:open";
export const SUPPORTED_MATT_VERSION = "13.06";
export const PLAYER_SURFACES = Object.freeze({
  HOME: "home",
  PARTY_SUPPLIES: "party-supplies",
  SHOPS: "shops",
  REPUTATION: "reputation",
  DOWNTIME: "downtime",
  CALENDAR: "calendar",
  CRITICAL_INJURIES: "critical-injuries",
});

/** Plain-language labels shared by Home and optional launcher integrations. */
export const PLAYER_SURFACE_LABELS = Object.freeze({
  [PLAYER_SURFACES.HOME]: "Infinity Home",
  [PLAYER_SURFACES.PARTY_SUPPLIES]: "Party Supplies",
  [PLAYER_SURFACES.SHOPS]: "Shops",
  [PLAYER_SURFACES.REPUTATION]: "Factions",
  [PLAYER_SURFACES.DOWNTIME]: "Downtime",
  [PLAYER_SURFACES.CALENDAR]: "Calendar",
  [PLAYER_SURFACES.CRITICAL_INJURIES]: "Critical Injuries",
});

const SURFACE_SET = new Set(Object.values(PLAYER_SURFACES));
const PAYLOAD_KEYS = new Set([
  "type",
  "originUserId",
  "targetUserId",
  "surface",
]);
const API_OPENERS = Object.freeze({
  [PLAYER_SURFACES.HOME]: "openHub",
  [PLAYER_SURFACES.PARTY_SUPPLIES]: "openPartySupplies",
  [PLAYER_SURFACES.SHOPS]: "openShops",
  [PLAYER_SURFACES.REPUTATION]: "openReputationView",
  [PLAYER_SURFACES.DOWNTIME]: "openDowntimeActivities",
  [PLAYER_SURFACES.CRITICAL_INJURIES]: "openCriticalInjuries",
});

const PLAYER_SURFACE_SETTING_GATES = Object.freeze({
  [PLAYER_SURFACES.PARTY_SUPPLIES]: Object.freeze({
    key: SETTING_KEYS.RESOURCE_PLAYER_VIEW,
    playerOnly: true,
    reason: "Party Supplies is not available in this world.",
  }),
  [PLAYER_SURFACES.CRITICAL_INJURIES]: Object.freeze({
    key: SETTING_KEYS.CRITICAL_INJURIES_ENABLED,
    playerOnly: false,
    reason: "Critical Injuries are not enabled in this world.",
  }),
});

let registered = false;
let playerSurfaceSocket = null;
let mattSenderGuardInstalled = false;
let guardedMattVersion = null;

/** Record the bounded MATT sender-guard state established during setupTileActions. */
export function setMattSenderGuardStatus({
  ready = false,
  version = null,
} = {}) {
  guardedMattVersion = typeof version === "string" ? version : null;
  mattSenderGuardInstalled =
    ready === true && guardedMattVersion === SUPPORTED_MATT_VERSION;
}

/** Read-only readiness metadata for bridge and installed-world verification. */
export function getPlayerSurfaceStatus(gameRef = globalThis.game) {
  const handlerRegistered = Boolean(registered && playerSurfaceSocket);
  const transportActive =
    gameRef?.modules?.get?.(SOCKETLIB_MODULE_ID)?.active === true;
  const mattModule = gameRef?.modules?.get?.(MONKS_ACTIVE_TILES_ID);
  const mattVersion =
    typeof mattModule?.version === "string" ? mattModule.version : null;
  const mattHandlerGuarded =
    gameRef?.MonksActiveTiles?.onMessage?.[MATT_SENDER_GUARD_MARKER] === true;
  const mattSenderGuardReady = Boolean(
    mattModule?.active === true &&
    mattVersion === SUPPORTED_MATT_VERSION &&
    mattSenderGuardInstalled &&
    guardedMattVersion === mattVersion &&
    mattHandlerGuarded,
  );
  return {
    ready: transportActive && handlerRegistered && mattSenderGuardReady,
    transport: SOCKETLIB_MODULE_ID,
    handlerRegistered,
    mattSenderGuardReady,
    mattVersion,
  };
}

export function validatePlayerSurfacePayload(payload) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return { ok: false, reason: "payload-not-object" };
  }
  if (payload.type !== PLAYER_SURFACE_EVENT) {
    return { ok: false, reason: "unknown-event-type" };
  }
  if (Object.keys(payload).some((key) => !PAYLOAD_KEYS.has(key))) {
    return { ok: false, reason: "unexpected-payload-data" };
  }
  if (!boundedId(payload.originUserId)) {
    return { ok: false, reason: "invalid-origin-user-id" };
  }
  if (!boundedId(payload.targetUserId)) {
    return { ok: false, reason: "invalid-target-user-id" };
  }
  if (!SURFACE_SET.has(payload.surface)) {
    return { ok: false, reason: "invalid-surface" };
  }
  return { ok: true, reason: null };
}

/** Register the authenticated SocketLib handler on every client. Idempotent. */
export function registerPlayerSurfaceSocket(
  socketlibApi = globalThis.socketlib,
  gameRef = globalThis.game,
) {
  if (registered) return true;
  if (
    gameRef?.modules?.get?.(SOCKETLIB_MODULE_ID)?.active !== true ||
    typeof socketlibApi?.registerModule !== "function"
  ) {
    return false;
  }

  try {
    const socket = socketlibApi.registerModule(MODULE_ID);
    if (
      typeof socket?.register !== "function" ||
      typeof socket?.executeAsUser !== "function"
    ) {
      return false;
    }
    socket.register(PLAYER_SURFACE_EVENT, receivePlayerSurfaceSocketlib);
    playerSurfaceSocket = socket;
    registered = true;
    return true;
  } catch (error) {
    console.warn(
      `${MODULE_ID} | player-surface SocketLib registration failed`,
      error,
    );
    return false;
  }
}

/**
 * Ask one active non-GM client to open an allowlisted local window.
 * Only the deterministic authoritative GM may originate this event.
 */
export async function emitPlayerSurfaceOpen({ targetUserId, surface } = {}) {
  const targetId = boundedId(targetUserId);
  const originUserId = boundedId(globalThis.game?.user?.id);
  if (!isAuthoritativeGM() || !originUserId || !targetId) return null;

  const target = globalThis.game?.users?.get?.(targetId);
  if (!target?.active || isFullGM(target)) return null;

  const payload = {
    type: PLAYER_SURFACE_EVENT,
    originUserId,
    targetUserId: targetId,
    surface,
  };
  const validation = validatePlayerSurfacePayload(payload);
  if (!validation.ok) {
    auditRejected("outgoing", payload, validation.reason);
    return null;
  }

  if (!registered && !registerPlayerSurfaceSocket()) return null;
  if (typeof playerSurfaceSocket?.executeAsUser !== "function") return null;

  try {
    const opened = await playerSurfaceSocket.executeAsUser(
      PLAYER_SURFACE_EVENT,
      targetId,
      payload,
    );
    return opened === true ? payload : null;
  } catch (error) {
    console.warn(`${MODULE_ID} | player-surface SocketLib dispatch failed`, {
      surface,
      targetUserId: targetId,
      error,
    });
    return null;
  }
}

/** SocketLib supplies the authenticated caller on this normal function's context. */
async function receivePlayerSurfaceSocketlib(payload) {
  return receivePlayerSurfacePayload(payload, this?.socketdata?.userId);
}

/** Receive a surface request using SocketLib's transport-authenticated sender. */
export async function receivePlayerSurfacePayload(
  payload,
  authenticatedSenderId,
) {
  if (!String(payload?.type ?? "").startsWith("player-surface:")) return false;
  const validation = validatePlayerSurfacePayload(payload);
  if (!validation.ok) {
    auditRejected(
      "incoming",
      payload,
      validation.reason,
      authenticatedSenderId,
    );
    return false;
  }

  // A client-claimed origin never authorizes a launcher. The registered
  // SocketLib handler passes its transport sender from this.socketdata.userId.
  if (!boundedId(authenticatedSenderId)) return false;
  const senderId = authenticateSocketPayload(payload, authenticatedSenderId);
  const currentUserId = boundedId(globalThis.game?.user?.id);
  if (
    !senderId ||
    !currentUserId ||
    payload.targetUserId !== currentUserId ||
    !isAuthoritativeGMSender(senderId) ||
    !isActiveSocketUser(currentUserId) ||
    isFullGM(globalThis.game?.user)
  ) {
    return false;
  }

  return openPlayerSurface(payload.surface);
}

/** Open one local, permission-scoped player application. */
export async function openPlayerSurface(
  surface,
  {
    moduleApi = globalThis.game?.modules?.get?.(MODULE_ID)?.api,
    calendarApi = resolveCalendarApi(),
  } = {},
) {
  if (!SURFACE_SET.has(surface)) return false;

  if (surface === PLAYER_SURFACES.CALENDAR) {
    return openCalendar({ calendarApi });
  }

  const method = API_OPENERS[surface];
  const opener = moduleApi?.[method];
  if (typeof opener !== "function") {
    notifyUnavailable(surface);
    return false;
  }

  try {
    await opener.call(moduleApi);
    return true;
  } catch (error) {
    console.warn(`${MODULE_ID} | failed to open player surface`, {
      surface,
      error,
    });
    globalThis.ui?.notifications?.error?.(
      "Infinity D&D5e could not open that player window.",
    );
    return false;
  }
}

/**
 * Report whether a fixed local surface has the opener it needs. This reads
 * module/integration metadata only; it never requests or returns campaign data.
 */
export function getPlayerSurfaceAvailability(
  surface,
  { moduleApi, calendarApi, gameRef = globalThis.game } = {},
) {
  if (!SURFACE_SET.has(surface)) {
    return { available: false, reason: "This destination is not supported." };
  }

  const settingGate = PLAYER_SURFACE_SETTING_GATES[surface];
  const gateApplies =
    settingGate && (!settingGate.playerOnly || !isFullGM(gameRef?.user));
  if (gateApplies && readWorldSetting(gameRef, settingGate.key) === false) {
    return { available: false, reason: settingGate.reason };
  }

  if (surface === PLAYER_SURFACES.CALENDAR) {
    const activeCalendar = resolveActiveCalendarModule(gameRef);
    const resolvedApi = calendarApi ?? resolveCalendarApi(gameRef);
    if (!activeCalendar) {
      return {
        available: false,
        reason:
          "Calendar is unavailable because Simple Calendar is not active.",
      };
    }
    if (typeof resolvedApi?.showCalendar !== "function") {
      return {
        available: false,
        reason:
          "Calendar is active but is not ready yet. Try again in a moment.",
      };
    }
    return { available: true, reason: "" };
  }

  const method = API_OPENERS[surface];
  const resolvedModuleApi =
    moduleApi ?? gameRef?.modules?.get?.(MODULE_ID)?.api;
  if (typeof resolvedModuleApi?.[method] !== "function") {
    return {
      available: false,
      reason: "This window is still starting. Try again in a moment.",
    };
  }
  return { available: true, reason: "" };
}

function readWorldSetting(gameRef, key) {
  const fallback = getSettingDefault(key);
  try {
    const value = gameRef?.settings?.get?.(MODULE_ID, key);
    return value === undefined ? fallback : value;
  } catch {
    return fallback;
  }
}

/** Guard the optional Simple Calendar integration behind its public API. */
export async function openCalendar({
  calendarApi = resolveCalendarApi(),
} = {}) {
  const calendarModule = resolveActiveCalendarModule();
  if (!calendarModule) {
    notifyUnavailable(PLAYER_SURFACES.CALENDAR);
    return false;
  }
  if (typeof calendarApi?.showCalendar !== "function") {
    notifyUnavailable(PLAYER_SURFACES.CALENDAR);
    return false;
  }

  try {
    await calendarApi.showCalendar();
    return true;
  } catch (error) {
    console.warn(`${MODULE_ID} | Simple Calendar opener failed`, error);
    globalThis.ui?.notifications?.error?.(
      "Infinity D&D5e could not open Simple Calendar.",
    );
    return false;
  }
}

function resolveCalendarApi(gameRef = globalThis.game) {
  const calendarModule = resolveActiveCalendarModule(gameRef);
  if (!calendarModule) return null;
  return globalThis.SimpleCalendar?.api ?? calendarModule.api ?? null;
}

function resolveActiveCalendarModule(gameRef = globalThis.game) {
  for (const moduleId of CALENDAR_MODULE_IDS) {
    const calendarModule = gameRef?.modules?.get?.(moduleId);
    if (calendarModule?.active === true) return calendarModule;
  }
  return null;
}

function notifyUnavailable(surface) {
  const label = surface === PLAYER_SURFACES.CALENDAR ? "Calendar" : "window";
  globalThis.ui?.notifications?.warn?.(
    `Infinity D&D5e ${label} is not available on this client.`,
  );
}

function boundedId(value) {
  if (typeof value !== "string") return null;
  const id = value.trim();
  return id && id.length <= MAX_ID_LENGTH ? id : null;
}

function auditRejected(
  direction,
  payload,
  reason,
  authenticatedSenderId = null,
) {
  console.warn(`${MODULE_ID} | rejected ${direction} player-surface event`, {
    type: typeof payload?.type === "string" ? payload.type : null,
    surface: SURFACE_SET.has(payload?.surface) ? payload.surface : null,
    reason,
    authenticatedSenderId: boundedId(authenticatedSenderId),
  });
}
