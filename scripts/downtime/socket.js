import {
  authenticateSocketPayload,
  authoritativeGMId,
  isActiveSocketUser,
  isAuthoritativeGM,
  isAuthoritativeGMSender,
  withAuthenticatedOrigin,
} from "../socket-authority.js";
import {
  emitModuleSocketPayload,
  registerModuleSocketRoute,
} from "../socket-router.js";
import { normalizeFenceBundleItemIds } from "./catalog.js";

const MODULE_ID = "infinity-dnd5e";
const MAX_ID_LENGTH = 160;
const MAX_QUEUE_LENGTH = 64;
const MAX_PENDING_LIFECYCLE_EVENTS = 200;
const QUEUE_ENTRY_KEYS = new Set([
  "id",
  "activityId",
  "hours",
  "skill",
  "guidedRoll",
  "stakeCp",
  "targetId",
  "targetIds",
]);
const RESTRICTED_PLAYER_PROJECTION_KEYS = new Set([
  "opportunitySecret",
  "opportunitySalt",
  "opportunitySeed",
  "planningDraft",
  "rewardSeed",
  "targetFacts",
]);

export const DOWNTIME_EVENTS = Object.freeze({
  SNAPSHOT_REQUEST: "downtime:snapshot-request",
  SNAPSHOT_REPLY: "downtime:snapshot-reply",
  SUBMIT_QUEUE: "downtime:submit-queue",
  SUBMIT_RESULT: "downtime:submit-result",
  RECALL_SUBMISSION: "downtime:recall-submission",
  STATE_UPDATE: "downtime:state-update",
  AUTO_OPEN: "downtime:auto-open",
  SHARPEN_DAMAGE: "downtime:sharpen-damage",
  LONG_REST: "downtime:long-rest",
  SHARPEN_LIFECYCLE_ACK: "downtime:sharpen-lifecycle-ack",
});

const EVENT_TYPES = new Set(Object.values(DOWNTIME_EVENTS));
const PLAYER_TO_GM_TYPES = new Set([
  DOWNTIME_EVENTS.SNAPSHOT_REQUEST,
  DOWNTIME_EVENTS.SUBMIT_QUEUE,
  DOWNTIME_EVENTS.RECALL_SUBMISSION,
  DOWNTIME_EVENTS.SHARPEN_DAMAGE,
  DOWNTIME_EVENTS.LONG_REST,
]);
const GM_TO_PLAYER_TYPES = new Set([
  DOWNTIME_EVENTS.SNAPSHOT_REPLY,
  DOWNTIME_EVENTS.SUBMIT_RESULT,
  DOWNTIME_EVENTS.STATE_UPDATE,
  DOWNTIME_EVENTS.AUTO_OPEN,
  DOWNTIME_EVENTS.SHARPEN_LIFECYCLE_ACK,
]);
const TARGETED_TYPES = new Set([
  ...PLAYER_TO_GM_TYPES,
  DOWNTIME_EVENTS.SNAPSHOT_REPLY,
  DOWNTIME_EVENTS.SUBMIT_RESULT,
  DOWNTIME_EVENTS.RECALL_SUBMISSION,
  DOWNTIME_EVENTS.STATE_UPDATE,
  DOWNTIME_EVENTS.AUTO_OPEN,
  DOWNTIME_EVENTS.SHARPEN_LIFECYCLE_ACK,
]);
const REQUEST_TYPES = new Set([
  DOWNTIME_EVENTS.SNAPSHOT_REQUEST,
  DOWNTIME_EVENTS.SNAPSHOT_REPLY,
  DOWNTIME_EVENTS.SUBMIT_QUEUE,
  DOWNTIME_EVENTS.SUBMIT_RESULT,
  DOWNTIME_EVENTS.RECALL_SUBMISSION,
]);
const PLAYER_EVENT_KEYS = Object.freeze({
  [DOWNTIME_EVENTS.SNAPSHOT_REQUEST]: new Set([
    "type",
    "originUserId",
    "targetUserId",
    "requestId",
    "actorId",
  ]),
  [DOWNTIME_EVENTS.SUBMIT_QUEUE]: new Set([
    "type",
    "originUserId",
    "targetUserId",
    "requestId",
    "blockId",
    "actorId",
    "queue",
  ]),
  [DOWNTIME_EVENTS.RECALL_SUBMISSION]: new Set([
    "type",
    "originUserId",
    "targetUserId",
    "requestId",
    "blockId",
    "actorId",
  ]),
  [DOWNTIME_EVENTS.SHARPEN_DAMAGE]: new Set([
    "type",
    "originUserId",
    "targetUserId",
    "actorId",
    "itemId",
    "effectId",
    "operationId",
    "rollId",
    "eventId",
  ]),
  [DOWNTIME_EVENTS.LONG_REST]: new Set([
    "type",
    "originUserId",
    "targetUserId",
    "actorId",
    "itemId",
    "effectId",
    "operationId",
    "eventId",
  ]),
});

const listeners = new Map();
let registered = false;
let retryHooksRegistered = false;
let pendingLifecycleStorageKey = null;
let pendingLifecycleRetryTimer = null;
const pendingLifecycleEvents = new Map();

export function subscribeDowntime(eventType, handler) {
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

function dispatch(eventType, payload) {
  if (eventType === DOWNTIME_EVENTS.SHARPEN_LIFECYCLE_ACK) {
    acknowledgePendingSharpeningLifecycle(payload.eventId);
  }
  for (const handler of listeners.get(eventType) ?? []) {
    try {
      const result = handler(payload);
      if (typeof result?.catch === "function") {
        result.catch((error) =>
          console.warn(`${MODULE_ID} | downtime ${eventType} handler`, error),
        );
      }
    } catch (error) {
      console.warn(`${MODULE_ID} | downtime ${eventType} handler`, error);
    }
  }
}

export function registerDowntimeSocket() {
  if (registered) return true;
  if (
    !registerModuleSocketRoute({
      id: "downtime",
      eventTypes: EVENT_TYPES,
      receive: receiveDowntimePayload,
    })
  ) {
    return false;
  }
  registerSharpeningLifecycleRetryHooks();
  ensurePendingSharpeningLifecycleLoaded();
  flushPendingSharpeningLifecycle();
  registered = true;
  return true;
}

export function emitDowntimeEvent(type, data = {}) {
  if (!EVENT_TYPES.has(type)) return null;
  const currentUserId = boundedId(globalThis.game?.user?.id);
  if (!currentUserId) return null;
  const payload = {
    ...data,
    type,
    originUserId: currentUserId,
  };
  const validation = validateDowntimePayload(payload);
  if (!validation.ok) {
    console.warn(`${MODULE_ID} | rejected outgoing downtime event`, {
      type,
      reason: validation.reason,
    });
    return null;
  }
  const targetUserId = boundedId(payload.targetUserId);
  if (GM_TO_PLAYER_TYPES.has(type) && !isAuthoritativeGM()) {
    console.warn(`${MODULE_ID} | rejected privileged downtime event`, { type });
    return null;
  }
  if (
    PLAYER_TO_GM_TYPES.has(type) &&
    targetUserId !== boundedId(authoritativeGMId())
  ) {
    console.warn(`${MODULE_ID} | rejected misdirected downtime request`, {
      type,
    });
    return null;
  }
  emitModuleSocketPayload(payload, {
    recipients: targetUserId ? [targetUserId] : [],
  });
  if (!targetUserId || targetUserId === currentUserId) {
    dispatch(type, payload);
  }
  return payload;
}

export function receiveDowntimePayload(payload, authenticatedSenderId) {
  if (
    !payload ||
    typeof payload !== "object" ||
    Array.isArray(payload) ||
    !String(payload.type ?? "").startsWith("downtime:")
  ) {
    return;
  }
  const validation = validateDowntimePayload(payload);
  if (!validation.ok) return;
  if (!boundedId(authenticatedSenderId)) return;
  const senderId = authenticateSocketPayload(payload, authenticatedSenderId);
  if (!senderId || senderId === globalThis.game?.user?.id) return;
  if (
    payload.targetUserId &&
    payload.targetUserId !== globalThis.game?.user?.id
  ) {
    return;
  }
  if (PLAYER_TO_GM_TYPES.has(payload.type)) {
    if (!isAuthoritativeGM() || !isActiveSocketUser(senderId)) return;
  } else if (!isAuthoritativeGMSender(senderId)) {
    return;
  }
  dispatch(payload.type, withAuthenticatedOrigin(payload, senderId));
}

export function validateDowntimePayload(payload) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return { ok: false, reason: "payload-not-object" };
  }
  if (!EVENT_TYPES.has(payload.type)) {
    return { ok: false, reason: "unknown-event-type" };
  }
  if (TARGETED_TYPES.has(payload.type) && !boundedId(payload.targetUserId)) {
    return { ok: false, reason: "invalid-target-user-id" };
  }
  if (REQUEST_TYPES.has(payload.type) && !boundedId(payload.requestId)) {
    return { ok: false, reason: "invalid-request-id" };
  }
  const allowedPlayerKeys = PLAYER_EVENT_KEYS[payload.type];
  if (
    allowedPlayerKeys &&
    Object.keys(payload).some((key) => !allowedPlayerKeys.has(key))
  ) {
    return { ok: false, reason: "client-derived-data-not-allowed" };
  }
  if (payload.type === DOWNTIME_EVENTS.SUBMIT_QUEUE) {
    if (!boundedId(payload.blockId) || !boundedId(payload.actorId)) {
      return { ok: false, reason: "invalid-submission-target" };
    }
    if (
      !Array.isArray(payload.queue) ||
      payload.queue.length > MAX_QUEUE_LENGTH
    ) {
      return { ok: false, reason: "invalid-queue" };
    }
    for (const entry of payload.queue) {
      if (!validateQueueEntry(entry)) {
        return { ok: false, reason: "invalid-queue-entry" };
      }
    }
  }
  if (
    payload.type === DOWNTIME_EVENTS.SNAPSHOT_REQUEST &&
    payload.actorId != null &&
    !boundedId(payload.actorId)
  ) {
    return { ok: false, reason: "invalid-actor-id" };
  }
  if (payload.type === DOWNTIME_EVENTS.RECALL_SUBMISSION) {
    if (!boundedId(payload.blockId) || !boundedId(payload.actorId)) {
      return { ok: false, reason: "invalid-submission-target" };
    }
  }
  if (payload.type === DOWNTIME_EVENTS.SHARPEN_DAMAGE) {
    if (
      !boundedId(payload.actorId) ||
      !boundedId(payload.itemId) ||
      !boundedId(payload.effectId) ||
      !boundedId(payload.operationId)
    ) {
      return { ok: false, reason: "invalid-effect-target" };
    }
    if (!boundedId(payload.rollId)) {
      return { ok: false, reason: "invalid-roll-id" };
    }
    if (!boundedId(payload.eventId)) {
      return { ok: false, reason: "invalid-lifecycle-event-id" };
    }
  }
  if (
    payload.type === DOWNTIME_EVENTS.LONG_REST &&
    (!boundedId(payload.actorId) ||
      !boundedId(payload.itemId) ||
      !boundedId(payload.effectId) ||
      !boundedId(payload.operationId))
  ) {
    return { ok: false, reason: "invalid-effect-target" };
  }
  if (
    [DOWNTIME_EVENTS.LONG_REST, DOWNTIME_EVENTS.SHARPEN_LIFECYCLE_ACK].includes(
      payload.type,
    ) &&
    !boundedId(payload.eventId)
  ) {
    return { ok: false, reason: "invalid-lifecycle-event-id" };
  }
  if (
    [DOWNTIME_EVENTS.SNAPSHOT_REPLY, DOWNTIME_EVENTS.STATE_UPDATE].includes(
      payload.type,
    ) &&
    (!payload.projection ||
      typeof payload.projection !== "object" ||
      Array.isArray(payload.projection))
  ) {
    return { ok: false, reason: "invalid-projection" };
  }
  if (payload.type === DOWNTIME_EVENTS.SUBMIT_RESULT) {
    if (typeof payload.ok !== "boolean") {
      return { ok: false, reason: "invalid-result" };
    }
    if (
      payload.projection != null &&
      (typeof payload.projection !== "object" ||
        Array.isArray(payload.projection))
    ) {
      return { ok: false, reason: "invalid-projection" };
    }
  }
  if (
    payload.projection &&
    projectionContainsRestrictedData(payload.projection)
  ) {
    return { ok: false, reason: "restricted-projection-data" };
  }
  if (
    payload.type === DOWNTIME_EVENTS.AUTO_OPEN &&
    (!boundedId(payload.actorId) || !boundedId(payload.blockId))
  ) {
    return { ok: false, reason: "invalid-auto-open-target" };
  }
  return { ok: true, reason: null };
}

function projectionContainsRestrictedData(projection) {
  const pending = [projection];
  const seen = new WeakSet();
  let visited = 0;
  while (pending.length > 0) {
    const value = pending.pop();
    if (!value || typeof value !== "object" || seen.has(value)) continue;
    seen.add(value);
    visited += 1;
    if (visited > 10_000) return true;
    for (const [key, child] of Object.entries(value)) {
      if (RESTRICTED_PLAYER_PROJECTION_KEYS.has(key)) return true;
      if (child && typeof child === "object") pending.push(child);
    }
  }
  return false;
}

function validateQueueEntry(entry) {
  if (!entry || typeof entry !== "object" || Array.isArray(entry)) return false;
  if (Object.keys(entry).some((key) => !QUEUE_ENTRY_KEYS.has(key)))
    return false;
  if (!boundedId(entry.id) || !boundedId(entry.activityId)) return false;
  const hours = Number(entry.hours);
  if (!Number.isInteger(hours) || hours < 1 || hours > 80) return false;
  for (const key of ["skill", "targetId"]) {
    if (entry[key] != null && !boundedId(entry[key])) return false;
  }
  if (entry.targetIds != null) {
    if (
      !Array.isArray(entry.targetIds) ||
      entry.targetIds.length < 1 ||
      entry.targetIds.length > 64 ||
      entry.targetIds.some((itemId) => !boundedId(itemId)) ||
      normalizeFenceBundleItemIds(entry.targetIds).length !==
        entry.targetIds.length
    ) {
      return false;
    }
  }
  if (entry.stakeCp != null) {
    const stake = Number(entry.stakeCp);
    if (!Number.isSafeInteger(stake) || stake < 0) return false;
  }
  if (entry.guidedRoll != null && !validateGuidedRoll(entry.guidedRoll)) {
    return false;
  }
  return true;
}

function validateGuidedRoll(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  if (Object.keys(value).some((key) => !["total", "formula"].includes(key))) {
    return false;
  }
  const total = Number(value.total);
  if (!Number.isFinite(total) || total < -100 || total > 1_000) return false;
  return (
    value.formula == null ||
    (typeof value.formula === "string" && value.formula.length <= 160)
  );
}

function boundedId(value) {
  if (typeof value !== "string") return null;
  const id = value.trim();
  return id && id.length <= MAX_ID_LENGTH ? id : null;
}

let requestCounter = 0;
export function newDowntimeRequestId(prefix = "dt") {
  requestCounter += 1;
  return `${prefix}-${Date.now().toString(36)}-${requestCounter.toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function stableIdHash(value) {
  let hash = 2166136261;
  for (const character of String(value ?? "")) {
    hash ^= character.codePointAt(0);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(36);
}

function boundedLifecycleValue(value) {
  const text = String(value ?? "").trim();
  if (text.length <= MAX_ID_LENGTH) return text;
  return `${text.slice(0, MAX_ID_LENGTH - 16)}-${stableIdHash(text)}`;
}

function sharpeningLifecycleEventId(kind, ...identifiers) {
  const raw = ["sharpen", kind, ...identifiers]
    .map((value) => String(value ?? "").replace(/[^A-Za-z0-9_.:-]/g, ""))
    .filter(Boolean)
    .join("-");
  if (raw.length <= MAX_ID_LENGTH) return raw;
  return `sharpen-${kind}-${stableIdHash(raw)}`;
}

function lifecycleStorage() {
  const storage = globalThis.localStorage;
  return storage &&
    typeof storage.getItem === "function" &&
    typeof storage.setItem === "function"
    ? storage
    : null;
}

function lifecycleStorageKey() {
  const worldId = boundedId(globalThis.game?.world?.id) ?? "world";
  const userId = boundedId(globalThis.game?.user?.id) ?? "user";
  return `${MODULE_ID}.sharpeningLifecycle.${worldId}.${userId}`;
}

function normalizeLocalLifecycleRecord(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const type = String(raw.type ?? "");
  const eventId = boundedId(raw.eventId);
  const actorId = boundedId(raw.actorId);
  const itemId = boundedId(raw.itemId);
  const effectId = boundedId(raw.effectId);
  const operationId = boundedId(raw.operationId);
  if (
    !eventId ||
    !actorId ||
    !itemId ||
    !effectId ||
    !operationId ||
    ![DOWNTIME_EVENTS.SHARPEN_DAMAGE, DOWNTIME_EVENTS.LONG_REST].includes(type)
  ) {
    return null;
  }
  if (type === DOWNTIME_EVENTS.LONG_REST) {
    return { type, eventId, actorId, itemId, effectId, operationId };
  }
  const rollId = boundedId(raw.rollId);
  return itemId && rollId
    ? {
        type,
        eventId,
        actorId,
        itemId,
        effectId,
        operationId,
        rollId,
      }
    : null;
}

function ensurePendingSharpeningLifecycleLoaded() {
  const key = lifecycleStorageKey();
  if (pendingLifecycleStorageKey === key) return;
  pendingLifecycleStorageKey = key;
  pendingLifecycleEvents.clear();
  try {
    const stored = JSON.parse(lifecycleStorage()?.getItem(key) ?? "[]");
    for (const raw of Array.isArray(stored) ? stored : []) {
      const record = normalizeLocalLifecycleRecord(raw);
      if (record) pendingLifecycleEvents.set(record.eventId, record);
    }
  } catch {
    pendingLifecycleEvents.clear();
  }
}

function persistPendingSharpeningLifecycle() {
  const storage = lifecycleStorage();
  if (!storage || !pendingLifecycleStorageKey) return;
  try {
    storage.setItem(
      pendingLifecycleStorageKey,
      JSON.stringify(
        [...pendingLifecycleEvents.values()].slice(
          -MAX_PENDING_LIFECYCLE_EVENTS,
        ),
      ),
    );
  } catch {
    // Browser storage is a retry aid; the authoritative GM ledger is canonical.
  }
}

function acknowledgePendingSharpeningLifecycle(eventId) {
  ensurePendingSharpeningLifecycleLoaded();
  const id = boundedId(eventId);
  if (!id || !pendingLifecycleEvents.delete(id)) return false;
  persistPendingSharpeningLifecycle();
  if (
    pendingLifecycleEvents.size === 0 &&
    pendingLifecycleRetryTimer !== null
  ) {
    globalThis.clearTimeout?.(pendingLifecycleRetryTimer);
    pendingLifecycleRetryTimer = null;
  }
  return true;
}

function schedulePendingSharpeningLifecycleRetry() {
  if (
    pendingLifecycleEvents.size === 0 ||
    pendingLifecycleRetryTimer !== null ||
    typeof globalThis.setTimeout !== "function"
  ) {
    return;
  }
  pendingLifecycleRetryTimer = globalThis.setTimeout(() => {
    pendingLifecycleRetryTimer = null;
    flushPendingSharpeningLifecycle();
    schedulePendingSharpeningLifecycleRetry();
  }, 5_000);
  pendingLifecycleRetryTimer?.unref?.();
}

function queuePendingSharpeningLifecycle(record) {
  ensurePendingSharpeningLifecycleLoaded();
  const normalized = normalizeLocalLifecycleRecord(record);
  if (!normalized) return { ok: false, reason: "invalid-lifecycle-event" };
  pendingLifecycleEvents.set(normalized.eventId, normalized);
  while (pendingLifecycleEvents.size > MAX_PENDING_LIFECYCLE_EVENTS) {
    pendingLifecycleEvents.delete(pendingLifecycleEvents.keys().next().value);
  }
  persistPendingSharpeningLifecycle();
  const sent = flushPendingSharpeningLifecycle();
  schedulePendingSharpeningLifecycleRetry();
  return {
    ok: true,
    queued: true,
    sent: sent > 0,
    eventId: normalized.eventId,
  };
}

function valuesOf(collection) {
  if (!collection) return [];
  if (Array.isArray(collection)) return collection;
  if (typeof collection.values === "function") return [...collection.values()];
  if (typeof collection === "object") return Object.values(collection);
  return [];
}

function sharpeningMarkerForRecord(item, record) {
  const effect =
    item?.effects?.get?.(record.effectId) ??
    valuesOf(item?.effects).find(
      (candidate) =>
        String(candidate?.id ?? candidate?._id ?? "") === record.effectId,
    );
  const source = effect?.toObject?.() ?? effect ?? {};
  const marker = source.flags?.[MODULE_ID]?.downtimeSharpen;
  return marker?.operationId === record.operationId ? marker : null;
}

function prunePendingSharpeningLifecycleAgainstCanonicalState() {
  const actors = globalThis.game?.actors;
  if (typeof actors?.get !== "function") return 0;
  let removed = 0;
  for (const [eventId, record] of pendingLifecycleEvents) {
    const actor = actors.get(record.actorId);
    if (!actor) continue;
    const item = actor.items?.get?.(record.itemId);
    const marker = item ? sharpeningMarkerForRecord(item, record) : null;
    const canonicallyConsumed =
      record.type === DOWNTIME_EVENTS.SHARPEN_DAMAGE &&
      Array.isArray(marker?.rollIds) &&
      marker.rollIds.map(String).includes(record.rollId);
    if (!item || !marker || canonicallyConsumed) {
      pendingLifecycleEvents.delete(eventId);
      removed += 1;
    }
  }
  if (removed > 0) persistPendingSharpeningLifecycle();
  return removed;
}

/**
 * Project outstanding authenticated requests against one exact sharpening
 * effect so a disconnected client cannot spend more local bonuses than remain.
 */
export function sharpeningLifecycleAvailability({
  actorId,
  itemId,
  effectId,
  operationId,
  charges,
  rollIds = [],
} = {}) {
  ensurePendingSharpeningLifecycleLoaded();
  const reference = {
    actorId: boundedId(String(actorId ?? "")),
    itemId: boundedId(String(itemId ?? "")),
    effectId: boundedId(String(effectId ?? "")),
    operationId: boundedId(String(operationId ?? "")),
  };
  const remaining = Math.max(0, Math.min(3, Math.floor(Number(charges) || 0)));
  if (Object.values(reference).some((value) => !value)) {
    return { available: remaining > 0, pendingDamage: 0, longRest: false };
  }
  const canonicalRollIds = new Set(
    Array.isArray(rollIds) ? rollIds.map(String) : [],
  );
  const pendingDamageRollIds = new Set();
  let pendingLongRest = false;
  let pruned = false;
  for (const [eventId, record] of pendingLifecycleEvents) {
    if (
      record.actorId !== reference.actorId ||
      record.itemId !== reference.itemId ||
      record.effectId !== reference.effectId ||
      record.operationId !== reference.operationId
    ) {
      continue;
    }
    if (
      record.type === DOWNTIME_EVENTS.SHARPEN_DAMAGE &&
      canonicalRollIds.has(record.rollId)
    ) {
      pendingLifecycleEvents.delete(eventId);
      pruned = true;
      continue;
    }
    if (record.type === DOWNTIME_EVENTS.LONG_REST) pendingLongRest = true;
    else pendingDamageRollIds.add(record.rollId);
  }
  if (pruned) persistPendingSharpeningLifecycle();
  return {
    available: !pendingLongRest && remaining > pendingDamageRollIds.size,
    pendingDamage: pendingDamageRollIds.size,
    longRest: pendingLongRest,
  };
}

export function flushPendingSharpeningLifecycle() {
  ensurePendingSharpeningLifecycleLoaded();
  prunePendingSharpeningLifecycleAgainstCanonicalState();
  const gmId = authoritativeGMId();
  if (!gmId) {
    schedulePendingSharpeningLifecycleRetry();
    return 0;
  }
  let sent = 0;
  for (const record of pendingLifecycleEvents.values()) {
    if (
      emitDowntimeEvent(record.type, {
        ...record,
        targetUserId: gmId,
      })
    ) {
      sent += 1;
    }
  }
  schedulePendingSharpeningLifecycleRetry();
  return sent;
}

function registerSharpeningLifecycleRetryHooks() {
  if (retryHooksRegistered || typeof globalThis.Hooks?.on !== "function") {
    return;
  }
  retryHooksRegistered = true;
  for (const event of ["updateUser", "userConnected"]) {
    globalThis.Hooks.on(event, () => flushPendingSharpeningLifecycle());
  }
}

export function emitSharpeningLifecycleAck(targetUserId, eventId) {
  return emitDowntimeEvent(DOWNTIME_EVENTS.SHARPEN_LIFECYCLE_ACK, {
    targetUserId: String(targetUserId ?? ""),
    eventId: String(eventId ?? ""),
  });
}

export function resetPendingSharpeningLifecycleForTests({
  preserveStorage = false,
} = {}) {
  const storage = lifecycleStorage();
  if (!preserveStorage && storage && pendingLifecycleStorageKey) {
    try {
      storage.removeItem?.(pendingLifecycleStorageKey);
    } catch {
      // Ignore test cleanup failures.
    }
  }
  pendingLifecycleEvents.clear();
  pendingLifecycleStorageKey = null;
  if (pendingLifecycleRetryTimer !== null) {
    globalThis.clearTimeout?.(pendingLifecycleRetryTimer);
    pendingLifecycleRetryTimer = null;
  }
}

export function requestDowntimeSnapshot(actorId = null, options = {}) {
  const requestId =
    boundedId(options.requestId) ?? newDowntimeRequestId("snapshot");
  const gmId = authoritativeGMId();
  if (!gmId) return { ok: false, reason: "no-gm", requestId };
  const payload = emitDowntimeEvent(DOWNTIME_EVENTS.SNAPSHOT_REQUEST, {
    requestId,
    targetUserId: gmId,
    actorId: actorId == null ? null : String(actorId),
  });
  return payload
    ? { ok: true, requestId }
    : { ok: false, reason: "request-rejected", requestId };
}

export function submitDowntimeQueue({
  blockId,
  actorId,
  queue,
  requestId: id,
}) {
  const requestId = boundedId(id) ?? newDowntimeRequestId("submit");
  const gmId = authoritativeGMId();
  if (!gmId) return { ok: false, reason: "no-gm", requestId };
  const payload = emitDowntimeEvent(DOWNTIME_EVENTS.SUBMIT_QUEUE, {
    requestId,
    targetUserId: gmId,
    blockId: String(blockId ?? ""),
    actorId: String(actorId ?? ""),
    queue: Array.isArray(queue) ? queue : [],
  });
  return payload
    ? { ok: true, requestId }
    : { ok: false, reason: "request-rejected", requestId };
}

export function recallDowntimeSubmission({ blockId, actorId, requestId: id }) {
  const requestId = boundedId(id) ?? newDowntimeRequestId("recall");
  const gmId = authoritativeGMId();
  if (!gmId) return { ok: false, reason: "no-gm", requestId };
  const payload = emitDowntimeEvent(DOWNTIME_EVENTS.RECALL_SUBMISSION, {
    requestId,
    targetUserId: gmId,
    blockId: String(blockId ?? ""),
    actorId: String(actorId ?? ""),
  });
  return payload
    ? { ok: true, requestId }
    : { ok: false, reason: "request-rejected", requestId };
}

export function notifySharpenDamage(item, rollId, options = {}) {
  const actor = item?.parent ?? item?.actor ?? null;
  const normalizedRollId = boundedLifecycleValue(rollId);
  const effectId = boundedId(String(options.effectId ?? ""));
  const operationId = boundedId(String(options.operationId ?? ""));
  if (
    !actor?.id ||
    !item?.id ||
    !effectId ||
    !operationId ||
    !boundedId(normalizedRollId)
  ) {
    return null;
  }
  const eventId =
    boundedId(options.eventId) ??
    sharpeningLifecycleEventId(
      "damage",
      actor.id,
      item.id,
      effectId,
      operationId,
      normalizedRollId,
    );
  return queuePendingSharpeningLifecycle({
    type: DOWNTIME_EVENTS.SHARPEN_DAMAGE,
    eventId,
    actorId: String(actor.id),
    itemId: String(item.id),
    effectId,
    operationId,
    rollId: normalizedRollId,
  });
}

export function notifyLongRest(actor, options = {}) {
  if (!actor?.id) return null;
  const references = [];
  const seen = new Set();
  for (const raw of Array.isArray(options.references)
    ? options.references
    : []) {
    const itemId = boundedId(String(raw?.itemId ?? ""));
    const effectId = boundedId(String(raw?.effectId ?? ""));
    const operationId = boundedId(String(raw?.operationId ?? ""));
    const key = `${itemId}:${effectId}:${operationId}`;
    if (!itemId || !effectId || !operationId || seen.has(key)) continue;
    seen.add(key);
    references.push({ itemId, effectId, operationId });
  }
  const results = references.map((reference, index) => {
    const eventId =
      (references.length === 1 ? boundedId(options.eventId) : null) ??
      sharpeningLifecycleEventId(
        "rest",
        actor.id,
        reference.itemId,
        reference.effectId,
        reference.operationId,
      );
    return queuePendingSharpeningLifecycle({
      type: DOWNTIME_EVENTS.LONG_REST,
      eventId,
      actorId: String(actor.id),
      ...reference,
    });
  });
  return {
    ok: results.every((result) => result?.ok === true),
    queued: results.some((result) => result?.queued === true),
    sent: results.some((result) => result?.sent === true),
    eventIds: results.map((result) => result?.eventId).filter(Boolean),
    results,
  };
}
