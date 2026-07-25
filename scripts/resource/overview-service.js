/**
 * Infinity D&D5e - Resource overview Foundry service
 *
 * Adapts live Actor/settings state into the pure overview model and answers
 * player snapshot requests on the authoritative GM. It also emits lightweight
 * invalidations after relevant document changes so open Supplies windows
 * refresh without exposing raw inventory over a broadcast.
 */

import { SETTING_KEYS, getSetting } from "../settings.js";
import { PRIVATE_STATE_CHANGED_HOOK } from "../private-state.js";
import { actorItemSnapshots, getPartyRoster } from "./calendar-watcher.js";
import { findEnvironment } from "./environment.js";
import { buildResourceOverview, sanitizeResourceOverview } from "./overview.js";
import {
  RESOURCE_EVENTS,
  emitResourceEvent,
  isAuthoritativeGM,
  subscribe,
} from "./socket.js";
import { loadResourceConfig, loadRunState } from "./store.js";

const MODULE_ID = "infinity-dnd5e";
const INVALIDATION_DELAY_MS = 120;
const SNAPSHOT_CACHE_MS = 500;
const MIN_REPLY_INTERVAL_MS = 200;

let registered = false;
let invalidationTimer = null;
let socketUnsubscribe = null;
const playerSnapshotCache = new Map();
let canonicalOverviewCache = null;
const hookIds = [];
const replyStateByUser = new Map();

/** Build the complete GM projection from canonical live documents. */
export function buildLiveResourceOverview({ generatedAt = Date.now() } = {}) {
  const config = loadResourceConfig();
  const state = loadRunState();
  const environmentId =
    state.currentEnvironmentId ||
    getSetting(SETTING_KEYS.RESOURCE_DEFAULT_ENVIRONMENT) ||
    "limited";
  const environment =
    findEnvironment(config.environments, environmentId) ??
    config.environments?.[0] ??
    null;
  const roster = getPartyRoster(config).map(
    ({ actor, isStash, consumes, drawFromId }) => ({
      actorId: actor.id,
      name: actor.name,
      isStash,
      consumes,
      drawFromId,
      exhaustion: Number(actor.system?.attributes?.exhaustion) || 0,
      items: actorItemSnapshots(actor),
    }),
  );
  return buildResourceOverview({
    config,
    state,
    environment,
    roster,
    autoTrigger: getSetting(SETTING_KEYS.RESOURCE_AUTO_TRIGGER) !== false,
    generatedAt,
  });
}

/** Build the deliberately sanitized projection a player may receive. */
export function buildPlayerResourceOverview({
  viewerUserId = null,
  ...options
} = {}) {
  const overview = buildLiveResourceOverview(options);
  return sanitizeLiveOverviewForViewer(overview, viewerUserId);
}

function sanitizeLiveOverviewForViewer(overview, viewerUserId) {
  const viewer = viewerUserId
    ? globalThis.game?.users?.get?.(viewerUserId)
    : null;
  const visibleActorIds = viewer
    ? new Set(
        overview.members
          .filter((member) => {
            const actor = globalThis.game?.actors?.get?.(member.actorId);
            return actor?.testUserPermission?.(viewer, "LIMITED") === true;
          })
          .map((member) => member.actorId),
      )
    : null;
  return sanitizeResourceOverview(overview, { visibleActorIds });
}

/**
 * Register request handling and live invalidation hooks. Safe to call once on
 * every client; only the authoritative GM answers or broadcasts.
 */
export function registerResourceOverviewService() {
  if (registered) return;
  registered = true;

  socketUnsubscribe = subscribe(RESOURCE_EVENTS.OVERVIEW_REQUEST, (payload) => {
    if (!isAuthoritativeGM()) {
      clearAuthorityOwnedState();
      return;
    }
    queueOverviewRequest(payload);
  });

  const Hooks = globalThis.Hooks;
  if (typeof Hooks?.on !== "function") return;
  hookIds.push(
    ["createItem", Hooks.on("createItem", onItemChanged)],
    ["updateItem", Hooks.on("updateItem", onItemChanged)],
    ["deleteItem", Hooks.on("deleteItem", onItemChanged)],
    ["createActor", Hooks.on("createActor", onActorCollectionChanged)],
    ["updateActor", Hooks.on("updateActor", onActorChanged)],
    ["deleteActor", Hooks.on("deleteActor", onActorCollectionChanged)],
    ["updateUser", Hooks.on("updateUser", onUserChanged)],
    ["userConnected", Hooks.on("userConnected", onUserChanged)],
    ["updateSetting", Hooks.on("updateSetting", onSettingChanged)],
    [
      PRIVATE_STATE_CHANGED_HOOK,
      Hooks.on(PRIVATE_STATE_CHANGED_HOOK, onPrivateStateChanged),
    ],
  );
}

function queueOverviewRequest(payload) {
  if (!isAuthoritativeGM()) {
    clearAuthorityOwnedState();
    return;
  }
  const userId = text(payload?.originUserId);
  if (!userId) return;
  const now = Date.now();
  const state = replyStateByUser.get(userId) ?? {
    lastReplyAt: 0,
    latestPayload: null,
    timer: null,
  };
  state.latestPayload = payload;
  replyStateByUser.set(userId, state);
  if (state.timer != null) return;

  const delay = Math.max(0, state.lastReplyAt + MIN_REPLY_INTERVAL_MS - now);
  if (delay === 0) {
    const latest = state.latestPayload;
    state.latestPayload = null;
    state.lastReplyAt = now;
    void answerOverviewRequest(latest);
    return;
  }
  state.timer = globalThis.setTimeout?.(() => {
    state.timer = null;
    if (!isAuthoritativeGM()) {
      clearAuthorityOwnedState();
      return;
    }
    const latest = state.latestPayload;
    state.latestPayload = null;
    state.lastReplyAt = Date.now();
    void answerOverviewRequest(latest);
  }, delay);
}

async function answerOverviewRequest(payload) {
  if (!isAuthoritativeGM()) {
    clearAuthorityOwnedState();
    return null;
  }
  const targetUserId = text(payload?.originUserId);
  if (!targetUserId) return null;
  const requestId = text(payload?.requestId).slice(0, 160) || null;
  const enabled = getSetting(SETTING_KEYS.RESOURCE_PLAYER_VIEW) !== false;
  let overview = null;
  try {
    if (enabled) {
      if (!isAuthoritativeGM()) {
        clearAuthorityOwnedState();
        return null;
      }
      overview = cachedPlayerResourceOverview(targetUserId);
    }
  } catch (error) {
    console.error(
      `${MODULE_ID} | failed to build player supplies overview`,
      error,
    );
  }
  if (!isAuthoritativeGM()) {
    clearAuthorityOwnedState();
    return null;
  }
  return emitResourceEvent(RESOURCE_EVENTS.OVERVIEW_REPLY, {
    targetUserId,
    requestId,
    enabled,
    overview,
  });
}

function cachedPlayerResourceOverview(viewerUserId) {
  const now = Date.now();
  const cached = playerSnapshotCache.get(viewerUserId);
  if (cached && now - cached.createdAt < SNAPSHOT_CACHE_MS) {
    return cached.overview;
  }
  if (
    !canonicalOverviewCache ||
    now - canonicalOverviewCache.createdAt >= SNAPSHOT_CACHE_MS
  ) {
    canonicalOverviewCache = {
      createdAt: now,
      overview: buildLiveResourceOverview({ generatedAt: now }),
    };
  }
  const overview = sanitizeLiveOverviewForViewer(
    canonicalOverviewCache.overview,
    viewerUserId,
  );
  playerSnapshotCache.set(viewerUserId, { createdAt: now, overview });
  return overview;
}

function onItemChanged(item) {
  const parent = item?.parent;
  if (!parent || parent.documentName !== "Actor") return;
  scheduleInvalidation("inventory");
}

function onActorChanged(actor) {
  if (!actor || actor.documentName !== "Actor") return;
  scheduleInvalidation("actor");
}

function onActorCollectionChanged(actor) {
  if (!actor || actor.documentName !== "Actor") return;
  scheduleInvalidation("actors");
}

function onUserChanged() {
  scheduleInvalidation("users");
}

function onSettingChanged(setting) {
  const key = settingKey(setting);
  if (!key) return;
  const relevant = new Set([
    SETTING_KEYS.RESOURCE_AUTO_TRIGGER,
    SETTING_KEYS.RESOURCE_DEFAULT_ENVIRONMENT,
    SETTING_KEYS.RESOURCE_FORAGE_MODE,
    SETTING_KEYS.RESOURCE_WATER_ENABLED,
    SETTING_KEYS.RESOURCE_HALF_RATIONS,
    SETTING_KEYS.RESOURCE_MAX_CATCHUP_DAYS,
    SETTING_KEYS.RESOURCE_PLAYER_VIEW,
  ]);
  if (relevant.has(key)) scheduleInvalidation("settings");
}

function onPrivateStateChanged(payload) {
  const keys = Array.isArray(payload?.keys) ? payload.keys : [];
  if (
    keys.includes(SETTING_KEYS.RESOURCE_CONFIG) ||
    keys.includes(SETTING_KEYS.RESOURCE_RUNSTATE)
  ) {
    scheduleInvalidation("private-state");
  }
}

function scheduleInvalidation(reason) {
  playerSnapshotCache.clear();
  canonicalOverviewCache = null;
  if (!isAuthoritativeGM()) {
    clearAuthorityOwnedState();
    return;
  }
  if (invalidationTimer != null) globalThis.clearTimeout?.(invalidationTimer);
  invalidationTimer = globalThis.setTimeout?.(() => {
    invalidationTimer = null;
    if (!isAuthoritativeGM()) {
      clearAuthorityOwnedState();
      return;
    }
    emitResourceEvent(RESOURCE_EVENTS.STATE_UPDATE, { reason });
  }, INVALIDATION_DELAY_MS);
}

function clearAuthorityOwnedState() {
  playerSnapshotCache.clear();
  canonicalOverviewCache = null;
  if (invalidationTimer != null) {
    globalThis.clearTimeout?.(invalidationTimer);
    invalidationTimer = null;
  }
  for (const state of replyStateByUser.values()) {
    if (state.timer != null) globalThis.clearTimeout?.(state.timer);
    state.timer = null;
    state.latestPayload = null;
  }
  replyStateByUser.clear();
}

function settingKey(setting) {
  const raw = text(setting?.key);
  const prefix = `${MODULE_ID}.`;
  if (raw.startsWith(prefix)) return raw.slice(prefix.length);
  if (text(setting?.namespace) === MODULE_ID) return raw;
  return "";
}

function text(value) {
  return String(value ?? "").trim();
}

/** Test-only cleanup for hook/listener isolation in a live hot-reload session. */
export function _resetResourceOverviewServiceForTests() {
  clearAuthorityOwnedState();
  for (const [event, id] of hookIds.splice(0)) {
    try {
      globalThis.Hooks?.off?.(event, id);
    } catch {
      // Best effort only.
    }
  }
  try {
    socketUnsubscribe?.();
  } catch {
    // Best effort only.
  }
  socketUnsubscribe = null;
  registered = false;
}

/** Test-only visibility into authority-owned transient state. */
export function _getResourceOverviewServiceStateForTests() {
  const replyStates = Array.from(replyStateByUser.values());
  return {
    hasInvalidationTimer: invalidationTimer != null,
    replyUserCount: replyStateByUser.size,
    replyTimerCount: replyStates.filter((state) => state.timer != null).length,
    queuedReplyCount: replyStates.filter((state) => state.latestPayload != null)
      .length,
    playerSnapshotCount: playerSnapshotCache.size,
    hasCanonicalOverview: canonicalOverviewCache != null,
  };
}
