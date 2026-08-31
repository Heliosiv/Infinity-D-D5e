/** Monk's Active Tiles action for permission-scoped Infinity player windows. */

import { isFullGM } from "../permissions.js";
import {
  emitPlayerSurfaceOpen,
  openPlayerSurface,
  PLAYER_SURFACE_LABELS,
  PLAYER_SURFACES,
  setMattSenderGuardStatus,
  SUPPORTED_MATT_VERSION,
} from "../player-surface.js";

const MODULE_ID = "infinity-dnd5e";
const MONKS_ACTIVE_TILES_ID = "monks-active-tiles";
const DRAKEMORE_FLAG_SCOPE = "drakemore-foundry";
const MATT_FLAG_SCOPE = "monks-active-tiles";
const PLAYER_HUB_KIND = "interactive-player-hub";
const PLAYER_HUB_VERSION = 1;
const MAX_ID_LENGTH = 160;
const SENDER_GUARD_MARKER = Symbol.for(
  "infinity-dnd5e.monks-active-tiles.sender-guard",
);
export const PLAYER_SURFACE_ACTION_ID = `${MODULE_ID}.open-player-surface`;

const HUB_CONTROL_KEYS = Object.freeze([
  "continue-adventure",
  "character",
  "party",
  "party-stash",
  "player-guide",
  "party-supplies",
  "shops",
  "factions",
  "downtime",
  "calendar",
  "injuries",
]);
const HOME_ENABLED_HUB_CONTROL_KEYS = Object.freeze([
  ...HUB_CONTROL_KEYS,
  "home",
]);
const HUB_CONTROL_KEY_SET = new Set(HOME_ENABLED_HUB_CONTROL_KEYS);
const HUB_INFINITY_SURFACES = Object.freeze({
  home: PLAYER_SURFACES.HOME,
  "party-supplies": PLAYER_SURFACES.PARTY_SUPPLIES,
  shops: PLAYER_SURFACES.SHOPS,
  factions: PLAYER_SURFACES.REPUTATION,
  downtime: PLAYER_SURFACES.DOWNTIME,
  calendar: PLAYER_SURFACES.CALENDAR,
  injuries: PLAYER_SURFACES.CRITICAL_INJURIES,
});

let hookRegistered = false;

/** Register before Foundry's init phase, when MATT emits setupTileActions. */
export function registerMonksActiveTilesCompat(hooks = globalThis.Hooks) {
  if (hookRegistered || typeof hooks?.on !== "function") {
    return hookRegistered;
  }
  hooks.on("setupTileActions", setupMonksActiveTilesActions);
  hookRegistered = true;
  return true;
}

export function setupMonksActiveTilesActions(
  monksActiveTiles,
  gameRef = globalThis.game,
) {
  const mattModule = gameRef?.modules?.get?.(MONKS_ACTIVE_TILES_ID);
  const mattVersion =
    typeof mattModule?.version === "string" ? mattModule.version : null;
  if (mattModule?.active !== true || mattVersion !== SUPPORTED_MATT_VERSION) {
    setMattSenderGuardStatus({ ready: false, version: mattVersion });
    return false;
  }
  if (
    !monksActiveTiles ||
    !["function", "object"].includes(typeof monksActiveTiles)
  ) {
    setMattSenderGuardStatus({ ready: false, version: mattVersion });
    return false;
  }

  // setupTileActions runs during MATT init. Install this guard before MATT's
  // ready hook captures onMessage, and before action-registration idempotence.
  if (!installMattSenderGuard(monksActiveTiles, gameRef)) return false;
  if (monksActiveTiles.triggerActions?.[PLAYER_SURFACE_ACTION_ID]) return true;

  if (!monksActiveTiles.triggerGroups?.[MODULE_ID]) {
    if (typeof monksActiveTiles.registerTileGroup !== "function") return false;
    monksActiveTiles.registerTileGroup(MODULE_ID, "Infinity D&D5e");
    if (!monksActiveTiles.triggerGroups?.[MODULE_ID]) return false;
  }
  if (typeof monksActiveTiles.registerTileAction !== "function") return false;

  return (
    monksActiveTiles.registerTileAction(
      MODULE_ID,
      "open-player-surface",
      buildPlayerSurfaceAction(),
    ) === true
  );
}

/**
 * Bind MATT's client-claimed trigger user to Foundry's transport sender.
 *
 * MATT 13.06 registers `onMessage` with game.socket only at ready, after its
 * setupTileActions hook. Foundry supplies the authenticated sender as the
 * listener's second argument; MATT otherwise consumes its own mutable
 * `data.senderId`. Only canonical hub click triggers are rewritten. Everything
 * outside the protected hub path is passed to MATT byte-for-byte.
 */
export function installMattSenderGuard(
  monksActiveTiles,
  gameRef = globalThis.game,
  fromUuidSyncRef = globalThis.fromUuidSync,
) {
  const mattModule = gameRef?.modules?.get?.(MONKS_ACTIVE_TILES_ID);
  const mattVersion =
    typeof mattModule?.version === "string" ? mattModule.version : null;
  if (mattModule?.active !== true || mattVersion !== SUPPORTED_MATT_VERSION) {
    setMattSenderGuardStatus({ ready: false, version: mattVersion });
    return false;
  }

  const currentHandler = monksActiveTiles?.onMessage;
  if (currentHandler?.[SENDER_GUARD_MARKER] === true) {
    setMattSenderGuardStatus({ ready: true, version: mattVersion });
    return true;
  }
  if (typeof currentHandler !== "function") {
    setMattSenderGuardStatus({ ready: false, version: mattVersion });
    return false;
  }

  const originalHandler = currentHandler;
  function guardedMattOnMessage(data, transportSenderId) {
    if (data?.action !== "trigger") {
      return Reflect.apply(originalHandler, this, arguments);
    }

    const classification = classifyMattTrigger(data, gameRef, fromUuidSyncRef);
    if (!classification.protected) {
      return Reflect.apply(originalHandler, this, arguments);
    }

    const senderId = boundedId(transportSenderId);
    const sender = senderId ? gameRef?.users?.get?.(senderId) : null;
    if (
      !classification.canonical ||
      !isCanonicalProtectedTriggerPacket(data) ||
      data.method !== "click" ||
      !sender?.active ||
      isFullGM(sender)
    ) {
      return false;
    }

    const sanitized = {
      action: "trigger",
      tileid: classification.tileId,
      method: "click",
      senderId,
      userId: senderId,
      tokens: [],
      pt: null,
      options: {},
    };
    return Reflect.apply(originalHandler, this, [sanitized, senderId]);
  }
  Object.defineProperty(guardedMattOnMessage, SENDER_GUARD_MARKER, {
    configurable: false,
    enumerable: false,
    value: true,
    writable: false,
  });

  try {
    monksActiveTiles.onMessage = guardedMattOnMessage;
  } catch (error) {
    console.warn(`${MODULE_ID} | could not install MATT sender guard`, error);
    setMattSenderGuardStatus({ ready: false, version: mattVersion });
    return false;
  }
  if (monksActiveTiles.onMessage !== guardedMattOnMessage) {
    setMattSenderGuardStatus({ ready: false, version: mattVersion });
    return false;
  }

  setMattSenderGuardStatus({ ready: true, version: mattVersion });
  return true;
}

function isCanonicalProtectedTriggerPacket(data) {
  return Boolean(
    isPlainObject(data) &&
    exactKeys(data, [
      "action",
      "method",
      "options",
      "pt",
      "senderId",
      "tileid",
      "tokens",
      "userId",
    ]) &&
    boundedId(data.tileid) &&
    Array.isArray(data?.tokens) &&
    data.tokens.length === 0 &&
    isPlainObject(data.options) &&
    Object.keys(data.options).length === 0 &&
    isCanonicalTriggerPoint(data.pt),
  );
}

function isCanonicalTriggerPoint(value) {
  if (value === null) return true;
  return Boolean(
    isPlainObject(value) &&
    exactKeys(value, ["x", "y"]) &&
    typeof value.x === "number" &&
    Number.isFinite(value.x) &&
    typeof value.y === "number" &&
    Number.isFinite(value.y),
  );
}

function classifyMattTrigger(data, gameRef, fromUuidSyncRef) {
  const tileId = boundedId(data?.tileid);
  const parsed = parseWorldTileUuid(tileId);
  const parsedScene = parsed ? gameRef?.scenes?.get?.(parsed.sceneId) : null;
  let tile = null;
  if (tileId && typeof fromUuidSyncRef === "function") {
    try {
      tile = fromUuidSyncRef(tileId);
    } catch {
      tile = null;
    }
  }
  if (!tile && parsedScene) {
    tile = parsedScene.tiles?.get?.(parsed.tileId) ?? null;
  }

  const scene = tile?.parent ?? parsedScene;
  const sceneIsHub = isPlayerHubScene(scene);
  const control = tile?.flags?.[DRAKEMORE_FLAG_SCOPE]?.playerHubControl;
  const mattFlags = tile?.flags?.[MATT_FLAG_SCOPE];
  const actions = Array.isArray(mattFlags?.actions) ? mattFlags.actions : [];
  const hasInfinityAction = actions.some(
    (action) => action?.action === PLAYER_SURFACE_ACTION_ID,
  );
  const protectedTrigger = Boolean(sceneIsHub || control || hasInfinityAction);

  return {
    protected: protectedTrigger,
    tileId,
    canonical:
      protectedTrigger &&
      Boolean(tile) &&
      isCanonicalHubTile({ actions, control, mattFlags, scene }),
  };
}

function isPlayerHubScene(scene) {
  const hub = scene?.flags?.[DRAKEMORE_FLAG_SCOPE]?.playerHub;
  return Boolean(
    hub &&
    hub.version === PLAYER_HUB_VERSION &&
    hub.kind === PLAYER_HUB_KIND &&
    hub.width === 3840 &&
    hub.height === 2160 &&
    isCanonicalHubControlKeys(hub.controlKeys),
  );
}

function isCanonicalHubControlKeys(controlKeys) {
  if (!Array.isArray(controlKeys)) return false;
  return [HUB_CONTROL_KEYS, HOME_ENABLED_HUB_CONTROL_KEYS].some(
    (expected) =>
      controlKeys.length === expected.length &&
      controlKeys.every((key, index) => key === expected[index]),
  );
}

function isCanonicalHubTile({ actions, control, mattFlags, scene }) {
  if (!isPlayerHubScene(scene)) return false;
  if (
    !isPlainObject(control) ||
    !exactKeys(control, ["interaction", "key", "label", "version"])
  ) {
    return false;
  }
  if (
    control.version !== PLAYER_HUB_VERSION ||
    !HUB_CONTROL_KEY_SET.has(control.key) ||
    !boundedLabel(control.label) ||
    !isPlainObject(control.interaction)
  ) {
    return false;
  }
  if (
    mattFlags?.active !== true ||
    mattFlags?.controlled !== "all" ||
    mattFlags?.allowpaused !== true ||
    !Array.isArray(mattFlags?.trigger) ||
    mattFlags.trigger.length !== 1 ||
    mattFlags.trigger[0] !== "click" ||
    actions.length !== 1
  ) {
    return false;
  }
  return isCanonicalHubAction(control.key, actions[0]);
}

function isCanonicalHubAction(key, action) {
  if (!isPlainObject(action) || action.id !== `hub-${key}`) return false;
  const data = action.data;
  if (!isPlainObject(data)) return false;

  const infinitySurface = HUB_INFINITY_SURFACES[key];
  if (infinitySurface) {
    return (
      action.action === PLAYER_SURFACE_ACTION_ID &&
      exactKeys(data, ["surface"]) &&
      data.surface === infinitySurface
    );
  }

  if (key === "continue-adventure") {
    return (
      action.action === "scene" &&
      exactKeys(data, ["activate", "for", "sceneid"]) &&
      data.activate === false &&
      data.for === "trigger" &&
      isPlainObject(data.sceneid) &&
      exactKeys(data.sceneid, ["id"]) &&
      boundedDocumentUuid(data.sceneid.id, "Scene")
    );
  }
  if (key === "character") {
    return (
      action.action === "openactor" &&
      exactKeys(data, ["entity", "showto"]) &&
      data.showto === "trigger" &&
      isPlainObject(data.entity) &&
      exactKeys(data.entity, ["id"]) &&
      data.entity.id === "players"
    );
  }
  if (key === "party" || key === "party-stash") {
    return (
      action.action === "openactor" &&
      exactKeys(data, ["entity", "showto"]) &&
      data.showto === "trigger" &&
      isPlainObject(data.entity) &&
      exactKeys(data.entity, ["id"]) &&
      boundedDocumentUuid(data.entity.id, "Actor")
    );
  }
  if (key === "player-guide") {
    return (
      action.action === "openjournal" &&
      exactKeys(data, ["entity", "permission", "showto"]) &&
      data.showto === "trigger" &&
      data.permission === "true" &&
      isPlainObject(data.entity) &&
      exactKeys(data.entity, ["id"]) &&
      boundedDocumentUuid(data.entity.id, "JournalEntry")
    );
  }
  return false;
}

function parseWorldTileUuid(value) {
  if (!value) return null;
  const match =
    /^Scene\.([A-Za-z0-9_-]{1,160})\.Tile\.([A-Za-z0-9_-]{1,160})$/.exec(value);
  return match ? { sceneId: match[1], tileId: match[2] } : null;
}

function boundedDocumentUuid(value, documentName) {
  const id = boundedId(value);
  return Boolean(id && id.startsWith(`${documentName}.`) && id.length > 6);
}

function boundedId(value) {
  if (typeof value !== "string") return null;
  const id = value.trim();
  return id && id.length <= MAX_ID_LENGTH ? id : null;
}

function boundedLabel(value) {
  return typeof value === "string" && value.length > 0 && value.length <= 80;
}

function exactKeys(value, expected) {
  if (!isPlainObject(value)) return false;
  const keys = Object.keys(value).sort();
  const wanted = [...expected].sort();
  return (
    keys.length === wanted.length &&
    keys.every((key, index) => key === wanted[index])
  );
}

function isPlainObject(value) {
  return Boolean(
    value &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    (Object.getPrototypeOf(value) === Object.prototype ||
      Object.getPrototypeOf(value) === null),
  );
}

export function buildPlayerSurfaceAction() {
  return {
    name: "Open Infinity window",
    group: MODULE_ID,
    requiresGM: true,
    ctrls: [
      {
        id: "surface",
        name: "Player window",
        type: "list",
        list: "surfaces",
        defvalue: PLAYER_SURFACES.PARTY_SUPPLIES,
        required: true,
      },
    ],
    values: { surfaces: PLAYER_SURFACE_LABELS },
    fn: async ({ action, userId } = {}) => {
      const surface = action?.data?.surface;
      const triggeringUserId = boundedId(userId);
      const currentUser = globalThis.game?.user;
      if (
        isFullGM(currentUser) &&
        triggeringUserId === boundedId(currentUser?.id)
      ) {
        const opened = await openPlayerSurface(surface);
        return { continue: opened === true };
      }
      const payload = await emitPlayerSurfaceOpen({
        targetUserId: triggeringUserId,
        surface,
      });
      return { continue: Boolean(payload) };
    },
    content: async (_trigger, action) => {
      const label =
        PLAYER_SURFACE_LABELS[action?.data?.surface] ?? "Invalid window";
      return `<span class="action-style">Open Infinity window</span> <span class="details-style">${label}</span> for the triggering user`;
    },
  };
}
