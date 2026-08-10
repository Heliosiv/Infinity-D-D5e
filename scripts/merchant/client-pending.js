/**
 * Reload-safe client persistence for unresolved Merchant buy/sell requests.
 *
 * Foundry client settings are shared by every World opened in one browser. A
 * request therefore carries its exact World id, is written and read back
 * before it may be emitted, and remains isolated from every other World until
 * a terminal GM result clears the exact (worldId, originUserId, commitId)
 * record. Malformed, unscoped legacy, or newer data fails closed rather than
 * being silently repaired, replayed, or evicted.
 */

import { SETTING_KEYS, SETTINGS_MODULE_ID } from "../settings.js";
import { withBrowserLease } from "../browser-lock.js";
import { persistedValuesEqual } from "../utils/persisted-data.js";
import {
  formatMerchantCommitId,
  merchantCommitRequestFingerprint,
  parseMerchantCommitId,
} from "./transaction-ledger.js";

export { parseMerchantCommitId } from "./transaction-ledger.js";

export const MERCHANT_PENDING_SCHEMA_VERSION = 3;
export const MERCHANT_PENDING_MAX_RECORDS = 50;
export const MERCHANT_PENDING_MAX_TOTAL_RECORDS = 500;
export const MERCHANT_PENDING_MAX_REVIEW_RECORDS = 50;
export const MERCHANT_PENDING_MAX_TOTAL_REVIEW_RECORDS = 500;
export const MERCHANT_PENDING_MAX_OUTBOX_RECORDS = 50;
export const MERCHANT_PENDING_MAX_TOTAL_OUTBOX_RECORDS = 500;
export const MERCHANT_PENDING_SETTING_KEY =
  SETTING_KEYS.MERCHANT_PENDING_COMMITS;

export const MERCHANT_PENDING_STATES = Object.freeze({
  PENDING: "pending",
  REVIEW: "review",
  TERMINAL_OUTBOX: "terminal-outbox",
});

const MERCHANT_COMMIT_EVENTS = Object.freeze([
  "merchant:commit-purchase",
  "merchant:commit-sale",
]);
const MERCHANT_COMMIT_EVENT_SET = new Set(MERCHANT_COMMIT_EVENTS);
const MAX_IDENTIFIER_LENGTH = 200;
const MAX_ITEM_NAME_LENGTH = 200;
const MAX_QUANTITY = 9999;
const MAX_ABSOLUTE_GP = 1_000_000_000_000;
const MAX_FINGERPRINT_LENGTH = 4000;
const REVIEW_REASONS = new Set([
  "transaction-history-expired",
  "transaction-needs-review",
]);
const writeQueues = new WeakMap();
let fallbackWriteQueue = Promise.resolve();
const activeBrowserLeases = new WeakMap();
let fallbackBrowserLease = null;
let browserLeaseRunner = withBrowserLease;

function pendingError(code, message, cause = undefined) {
  const error = new Error(message);
  error.name = "MerchantPendingCommitError";
  error.code = code;
  error.retryable = false;
  if (cause !== undefined) error.cause = cause;
  return error;
}

function isPlainRecord(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function hasExactKeys(value, keys) {
  if (!isPlainRecord(value)) return false;
  const ownKeys = Reflect.ownKeys(value);
  if (ownKeys.length !== keys.length) return false;
  return keys.every(
    (key) =>
      Object.hasOwn(value, key) &&
      Object.getOwnPropertyDescriptor(value, key)?.enumerable === true &&
      "value" in Object.getOwnPropertyDescriptor(value, key),
  );
}

function cloneJsonValue(value) {
  if (typeof structuredClone === "function") return structuredClone(value);
  return JSON.parse(JSON.stringify(value));
}

function requireIdentifier(value, field) {
  if (
    typeof value !== "string" ||
    value.length < 1 ||
    value.length > MAX_IDENTIFIER_LENGTH ||
    value.trim() !== value ||
    /[\u0000-\u001f\u007f]/.test(value)
  ) {
    throw pendingError(
      "MERCHANT_PENDING_INVALID_RECORD",
      `Pending merchant record has an invalid ${field}`,
    );
  }
  return value;
}

function requireText(
  value,
  field,
  { min = 0, max = MAX_IDENTIFIER_LENGTH } = {},
) {
  if (
    typeof value !== "string" ||
    value.length < min ||
    value.length > max ||
    /[\u0000-\u001f\u007f]/.test(value)
  ) {
    throw pendingError(
      "MERCHANT_PENDING_INVALID_RECORD",
      `Pending merchant record has an invalid ${field}`,
    );
  }
  return value;
}

function requireTimestamp(value, field) {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw pendingError(
      "MERCHANT_PENDING_INVALID_RECORD",
      `Pending merchant record has an invalid ${field}`,
    );
  }
  return value;
}

function requireFiniteNumber(
  value,
  field,
  { min = -Infinity, max = Infinity } = {},
) {
  if (
    typeof value !== "number" ||
    !Number.isFinite(value) ||
    Object.is(value, -0) ||
    value < min ||
    value > max
  ) {
    throw pendingError(
      "MERCHANT_PENDING_INVALID_RECORD",
      `Pending merchant record has an invalid ${field}`,
    );
  }
  return value;
}

function parseTier(value) {
  if (value === null) return null;
  if (!hasExactKeys(value, ["id"])) {
    throw pendingError(
      "MERCHANT_PENDING_INVALID_RECORD",
      "Pending merchant record has an invalid bargain tier",
    );
  }
  return {
    id: requireIdentifier(value.id, "bargain tier id"),
  };
}

function parseSeal(value) {
  if (value === null) return null;
  if (!hasExactKeys(value, ["sealId", "tier", "deltaPct", "rollTotal", "dc"])) {
    throw pendingError(
      "MERCHANT_PENDING_INVALID_RECORD",
      "Pending merchant record has invalid bargain data",
    );
  }
  return {
    sealId: requireIdentifier(value.sealId, "bargain seal id"),
    tier: parseTier(value.tier),
    deltaPct: requireFiniteNumber(value.deltaPct, "bargain delta", {
      min: -1000,
      max: 1000,
    }),
    rollTotal: requireFiniteNumber(value.rollTotal, "bargain roll total", {
      min: -1_000_000,
      max: 1_000_000,
    }),
    dc: requireFiniteNumber(value.dc, "bargain DC", {
      min: -1_000_000,
      max: 1_000_000,
    }),
  };
}

function parsePayload(value, commitId) {
  if (
    !hasExactKeys(value, [
      "sessionId",
      "itemUuid",
      "qty",
      "sealId",
      "totalGp",
      "commitId",
      "actorId",
    ])
  ) {
    throw pendingError(
      "MERCHANT_PENDING_INVALID_RECORD",
      "Pending merchant record has an invalid request payload",
    );
  }
  const qty = value.qty;
  if (!Number.isSafeInteger(qty) || qty < 1 || qty > MAX_QUANTITY) {
    throw pendingError(
      "MERCHANT_PENDING_INVALID_RECORD",
      "Pending merchant record has an invalid quantity",
    );
  }
  const parsed = {
    sessionId: requireIdentifier(value.sessionId, "session id"),
    itemUuid: requireIdentifier(value.itemUuid, "item id"),
    qty,
    sealId:
      value.sealId === null ? null : requireIdentifier(value.sealId, "seal id"),
    totalGp: requireFiniteNumber(value.totalGp, "total gp", {
      min: 0,
      max: MAX_ABSOLUTE_GP,
    }),
    commitId: requireMerchantCommitId(value.commitId),
    actorId: requireIdentifier(value.actorId, "actor id"),
  };
  if (parsed.commitId !== commitId) {
    throw pendingError(
      "MERCHANT_PENDING_INVALID_RECORD",
      "Pending merchant record commit ids do not match",
    );
  }
  return parsed;
}

function parseContext(value, eventType, payload) {
  if (
    !hasExactKeys(value, [
      "side",
      "merchantId",
      "merchantName",
      "refId",
      "itemName",
      "qty",
      "unitGp",
      "totalGp",
      "sealKey",
      "seal",
    ])
  ) {
    throw pendingError(
      "MERCHANT_PENDING_INVALID_RECORD",
      "Pending merchant record has an invalid display context",
    );
  }
  const expectedSide = eventType === "merchant:commit-sale" ? "sell" : "buy";
  if (value.side !== expectedSide) {
    throw pendingError(
      "MERCHANT_PENDING_INVALID_RECORD",
      "Pending merchant record side does not match its event",
    );
  }
  if (
    typeof value.itemName !== "string" ||
    value.itemName.length < 1 ||
    value.itemName.length > MAX_ITEM_NAME_LENGTH ||
    /[\u0000-\u001f\u007f]/.test(value.itemName)
  ) {
    throw pendingError(
      "MERCHANT_PENDING_INVALID_RECORD",
      "Pending merchant record has an invalid item name",
    );
  }
  if (value.qty !== payload.qty || value.totalGp !== payload.totalGp) {
    throw pendingError(
      "MERCHANT_PENDING_INVALID_RECORD",
      "Pending merchant record request and display values do not match",
    );
  }
  const refId = requireIdentifier(value.refId, "reference id");
  if (refId !== payload.itemUuid) {
    throw pendingError(
      "MERCHANT_PENDING_INVALID_RECORD",
      "Pending merchant record item references do not match",
    );
  }
  const context = {
    side: expectedSide,
    merchantId: requireIdentifier(value.merchantId, "merchant id"),
    merchantName: requireDisplayName(value.merchantName, "merchant name"),
    refId,
    itemName: value.itemName,
    qty: value.qty,
    unitGp: requireFiniteNumber(value.unitGp, "unit gp", {
      min: 0,
      max: MAX_ABSOLUTE_GP,
    }),
    totalGp: value.totalGp,
    sealKey: requireIdentifier(value.sealKey, "seal key"),
    seal: parseSeal(value.seal),
  };
  if (context.sealKey !== `${refId}::${expectedSide}`) {
    throw pendingError(
      "MERCHANT_PENDING_INVALID_RECORD",
      "Pending merchant record has an invalid bargain key",
    );
  }
  if ((context.seal?.sealId ?? null) !== payload.sealId) {
    throw pendingError(
      "MERCHANT_PENDING_INVALID_RECORD",
      "Pending merchant record bargain data does not match its request",
    );
  }
  return context;
}

function requireDisplayName(value, field) {
  if (
    typeof value !== "string" ||
    value.length < 1 ||
    value.length > MAX_ITEM_NAME_LENGTH ||
    /[\u0000-\u001f\u007f]/.test(value)
  ) {
    throw pendingError(
      "MERCHANT_PENDING_INVALID_RECORD",
      `Pending merchant record has an invalid ${field}`,
    );
  }
  return value;
}

/** Return a fresh empty v2 persistence envelope. */
export function createEmptyMerchantPendingCommits() {
  return { version: MERCHANT_PENDING_SCHEMA_VERSION, records: [] };
}

function requireMerchantCommitId(value) {
  try {
    const parsed = parseMerchantCommitId(value);
    if (formatMerchantCommitId(parsed.timestamp, parsed.randomHex) === value) {
      return value;
    }
  } catch {
    // Convert the domain parser's error into this persistence boundary's
    // stable, payload-free error contract below.
  }
  throw pendingError(
    "MERCHANT_PENDING_INVALID_COMMIT_ID",
    "Merchant commit id is invalid",
  );
}

/**
 * Generate a cryptographically random commit id. `now` and `cryptoApi` are
 * injectable for Node tests; production randomness never falls back to
 * Math.random or a timestamp-derived value.
 */
export function newMerchantCommitId({
  now,
  cryptoApi = globalThis.crypto,
  gameInstance = globalThis.game,
} = {}) {
  const liveServerTime = Number(gameInstance?.time?.serverTime);
  const requestedTime =
    typeof now === "function"
      ? now()
      : now !== undefined
        ? now
        : Number.isSafeInteger(liveServerTime) && liveServerTime > 0
          ? liveServerTime
          : Date.now();
  const serverTime = Number(requestedTime);
  if (!Number.isSafeInteger(serverTime) || serverTime < 1) {
    throw pendingError(
      "MERCHANT_PENDING_INVALID_TIME",
      "Merchant commit time is unavailable",
    );
  }
  if (typeof cryptoApi?.getRandomValues !== "function") {
    throw pendingError(
      "MERCHANT_PENDING_CRYPTO_UNAVAILABLE",
      "Secure randomness is unavailable for merchant commits",
    );
  }
  const bytes = new Uint8Array(16);
  try {
    cryptoApi.getRandomValues(bytes);
  } catch (error) {
    throw pendingError(
      "MERCHANT_PENDING_CRYPTO_UNAVAILABLE",
      "Secure randomness is unavailable for merchant commits",
      error,
    );
  }
  const randomHex = [...bytes]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
  return formatMerchantCommitId(serverTime, randomHex);
}

/** Validate and clone one complete pending commit record. */
export function parseMerchantPendingRecord(value) {
  if (
    !hasExactKeys(value, [
      "worldId",
      "originUserId",
      "commitId",
      "eventType",
      "payload",
      "context",
    ])
  ) {
    throw pendingError(
      "MERCHANT_PENDING_INVALID_RECORD",
      "Pending merchant record has an invalid shape",
    );
  }
  const worldId = requireIdentifier(value.worldId, "world id");
  const originUserId = requireIdentifier(value.originUserId, "origin user id");
  const commitId = requireMerchantCommitId(value.commitId);
  if (!MERCHANT_COMMIT_EVENT_SET.has(value.eventType)) {
    throw pendingError(
      "MERCHANT_PENDING_INVALID_RECORD",
      "Pending merchant record has an invalid event type",
    );
  }
  const payload = parsePayload(value.payload, commitId);
  return {
    worldId,
    originUserId,
    commitId,
    eventType: value.eventType,
    payload,
    context: parseContext(value.context, value.eventType, payload),
  };
}

function storedPendingRecord(record) {
  return {
    state: MERCHANT_PENDING_STATES.PENDING,
    ...parseMerchantPendingRecord(record),
  };
}

function pendingBaseRecord(record) {
  return {
    worldId: record.worldId,
    originUserId: record.originUserId,
    commitId: record.commitId,
    eventType: record.eventType,
    payload: record.payload,
    context: record.context,
  };
}

function parseReviewMetadata(value) {
  if (!hasExactKeys(value, ["reason", "receivedAt"])) {
    throw pendingError(
      "MERCHANT_PENDING_INVALID_RECORD",
      "Pending merchant review has an invalid shape",
    );
  }
  if (!REVIEW_REASONS.has(value.reason)) {
    throw pendingError(
      "MERCHANT_PENDING_INVALID_RECORD",
      "Pending merchant review has an invalid reason",
    );
  }
  return {
    reason: value.reason,
    receivedAt: requireTimestamp(value.receivedAt, "review time"),
  };
}

function parseTerminalResult(value, record) {
  if (
    !hasExactKeys(value, [
      "targetUserId",
      "sessionId",
      "commitId",
      "side",
      "ok",
      "reason",
      "requestFingerprint",
      "itemName",
      "qty",
      "unitGp",
      "totalGp",
      "sealId",
    ])
  ) {
    throw pendingError(
      "MERCHANT_PENDING_INVALID_RECORD",
      "Pending merchant terminal result has an invalid shape",
    );
  }
  const parsed = {
    targetUserId: requireIdentifier(
      value.targetUserId,
      "result target user id",
    ),
    sessionId: requireIdentifier(value.sessionId, "result session id"),
    commitId: requireMerchantCommitId(value.commitId),
    side: value.side,
    ok: value.ok,
    reason: requireText(value.reason, "result reason", {
      max: MAX_IDENTIFIER_LENGTH,
    }),
    requestFingerprint: requireText(
      value.requestFingerprint,
      "result request fingerprint",
      { min: 1, max: MAX_FINGERPRINT_LENGTH },
    ),
    itemName:
      value.itemName === null
        ? null
        : requireDisplayName(value.itemName, "result item name"),
    qty:
      value.qty === null
        ? null
        : Number.isSafeInteger(value.qty) &&
            value.qty >= 1 &&
            value.qty <= MAX_QUANTITY
          ? value.qty
          : null,
    unitGp:
      value.unitGp === null
        ? null
        : requireFiniteNumber(value.unitGp, "result unit gp", {
            min: 0,
            max: MAX_ABSOLUTE_GP,
          }),
    totalGp:
      value.totalGp === null
        ? null
        : requireFiniteNumber(value.totalGp, "result total gp", {
            min: 0,
            max: MAX_ABSOLUTE_GP,
          }),
    sealId:
      value.sealId === null
        ? null
        : requireIdentifier(value.sealId, "result seal id"),
  };
  if (
    typeof parsed.ok !== "boolean" ||
    !["buy", "sell"].includes(parsed.side) ||
    parsed.qty !== value.qty ||
    !merchantPendingCommitMatchesResult(record, parsed)
  ) {
    throw pendingError(
      "MERCHANT_PENDING_INVALID_RECORD",
      "Pending merchant terminal result does not match its request",
    );
  }
  return parsed;
}

function normalizeTerminalResult(result, record) {
  const normalized = {
    targetUserId: result.targetUserId,
    sessionId: result.sessionId,
    commitId: result.commitId,
    side: result.side,
    ok: result.ok,
    reason: typeof result.reason === "string" ? result.reason : "",
    requestFingerprint: result.requestFingerprint,
    itemName:
      typeof result.itemName === "string" && result.itemName.length > 0
        ? result.itemName
        : null,
    qty:
      Number.isSafeInteger(Number(result.qty)) &&
      Number(result.qty) >= 1 &&
      Number(result.qty) <= MAX_QUANTITY
        ? Number(result.qty)
        : null,
    unitGp:
      Number.isFinite(Number(result.unitGp)) && Number(result.unitGp) >= 0
        ? Number(result.unitGp)
        : null,
    totalGp:
      Number.isFinite(Number(result.totalGp)) && Number(result.totalGp) >= 0
        ? Number(result.totalGp)
        : null,
    sealId:
      typeof result.sealId === "string" && result.sealId.length > 0
        ? result.sealId
        : null,
  };
  return parseTerminalResult(normalized, record);
}

function parseTerminalMetadata(value, record) {
  if (!hasExactKeys(value, ["receivedAt", "result"])) {
    throw pendingError(
      "MERCHANT_PENDING_INVALID_RECORD",
      "Pending merchant terminal outbox has an invalid shape",
    );
  }
  return {
    receivedAt: requireTimestamp(value.receivedAt, "terminal result time"),
    result: parseTerminalResult(value.result, record),
  };
}

function parseStoredMerchantPendingRecord(value) {
  if (!isPlainRecord(value)) {
    throw pendingError(
      "MERCHANT_PENDING_INVALID_RECORD",
      "Pending merchant stored record has an invalid shape",
    );
  }
  const state = value.state;
  const extraKey =
    state === MERCHANT_PENDING_STATES.REVIEW
      ? "review"
      : state === MERCHANT_PENDING_STATES.TERMINAL_OUTBOX
        ? "terminal"
        : null;
  const keys = [
    "state",
    "worldId",
    "originUserId",
    "commitId",
    "eventType",
    "payload",
    "context",
    ...(extraKey ? [extraKey] : []),
  ];
  if (
    !Object.values(MERCHANT_PENDING_STATES).includes(state) ||
    !hasExactKeys(value, keys)
  ) {
    throw pendingError(
      "MERCHANT_PENDING_INVALID_RECORD",
      "Pending merchant stored record has an invalid state",
    );
  }
  const base = parseMerchantPendingRecord(pendingBaseRecord(value));
  if (state === MERCHANT_PENDING_STATES.PENDING) {
    return { state, ...base };
  }
  if (state === MERCHANT_PENDING_STATES.REVIEW) {
    return { state, ...base, review: parseReviewMetadata(value.review) };
  }
  return {
    state,
    ...base,
    terminal: parseTerminalMetadata(value.terminal, base),
  };
}

/**
 * Strictly parse the stateful v3 setting. World-scoped v2 pending records are
 * upgraded in memory without replaying anything; a write stores the v3 shape.
 * Populated unscoped v1 data still fails closed for explicit review.
 */
export function parseMerchantPendingCommits(value) {
  if (value === undefined) return createEmptyMerchantPendingCommits();
  if (!hasExactKeys(value, ["version", "records"])) {
    throw pendingError(
      "MERCHANT_PENDING_INVALID_SETTING",
      "Pending merchant setting has an invalid shape",
    );
  }
  if (value.version === 1) {
    if (Array.isArray(value.records) && value.records.length === 0) {
      return createEmptyMerchantPendingCommits();
    }
    throw pendingError(
      "MERCHANT_PENDING_LEGACY_UNSCOPED",
      "Pending merchant requests predate World scoping and require explicit review",
    );
  }
  const isWorldScopedV2 = value.version === 2;
  if (!isWorldScopedV2 && value.version !== MERCHANT_PENDING_SCHEMA_VERSION) {
    const isFutureVersion =
      Number.isSafeInteger(value.version) &&
      value.version > MERCHANT_PENDING_SCHEMA_VERSION;
    throw pendingError(
      isFutureVersion
        ? "MERCHANT_PENDING_FUTURE_VERSION"
        : "MERCHANT_PENDING_INVALID_VERSION",
      "Pending merchant setting version is unsupported",
    );
  }
  if (
    !Array.isArray(value.records) ||
    value.records.length >
      MERCHANT_PENDING_MAX_TOTAL_RECORDS +
        MERCHANT_PENDING_MAX_TOTAL_REVIEW_RECORDS +
        MERCHANT_PENDING_MAX_TOTAL_OUTBOX_RECORDS
  ) {
    throw pendingError(
      "MERCHANT_PENDING_INVALID_SETTING",
      "Pending merchant setting has an invalid record list",
    );
  }
  const seen = new Set();
  const worldCounts = new Map();
  const totalCounts = new Map();
  const records = value.records.map((record) => {
    const parsed = isWorldScopedV2
      ? storedPendingRecord(record)
      : parseStoredMerchantPendingRecord(record);
    const key = pendingRecordKey(
      parsed.worldId,
      parsed.originUserId,
      parsed.commitId,
    );
    if (seen.has(key)) {
      throw pendingError(
        "MERCHANT_PENDING_INVALID_SETTING",
        "Pending merchant setting contains a duplicate record",
      );
    }
    seen.add(key);
    const stateCounts = worldCounts.get(parsed.worldId) ?? new Map();
    const worldCount = (stateCounts.get(parsed.state) ?? 0) + 1;
    const stateLimit = stateRecordLimit(parsed.state);
    if (worldCount > stateLimit) {
      throw pendingError(
        "MERCHANT_PENDING_INVALID_SETTING",
        "Pending merchant setting exceeds one World's state limit",
      );
    }
    stateCounts.set(parsed.state, worldCount);
    worldCounts.set(parsed.worldId, stateCounts);
    const total = (totalCounts.get(parsed.state) ?? 0) + 1;
    if (total > totalStateRecordLimit(parsed.state)) {
      throw pendingError(
        "MERCHANT_PENDING_INVALID_SETTING",
        "Pending merchant setting exceeds its state limit",
      );
    }
    totalCounts.set(parsed.state, total);
    return parsed;
  });
  return { version: MERCHANT_PENDING_SCHEMA_VERSION, records };
}

function stateRecordLimit(state) {
  if (state === MERCHANT_PENDING_STATES.REVIEW) {
    return MERCHANT_PENDING_MAX_REVIEW_RECORDS;
  }
  if (state === MERCHANT_PENDING_STATES.TERMINAL_OUTBOX) {
    return MERCHANT_PENDING_MAX_OUTBOX_RECORDS;
  }
  return MERCHANT_PENDING_MAX_RECORDS;
}

function totalStateRecordLimit(state) {
  if (state === MERCHANT_PENDING_STATES.REVIEW) {
    return MERCHANT_PENDING_MAX_TOTAL_REVIEW_RECORDS;
  }
  if (state === MERCHANT_PENDING_STATES.TERMINAL_OUTBOX) {
    return MERCHANT_PENDING_MAX_TOTAL_OUTBOX_RECORDS;
  }
  return MERCHANT_PENDING_MAX_TOTAL_RECORDS;
}

function pendingRecordKey(worldId, originUserId, commitId) {
  return JSON.stringify([worldId, originUserId, commitId]);
}

function resolveOriginUserId(gameInstance, requested) {
  return requireIdentifier(
    requested ?? gameInstance?.user?.id,
    "origin user id",
  );
}

function resolveWorldId(gameInstance, requested) {
  return requireIdentifier(requested ?? gameInstance?.world?.id, "world id");
}

function readRawPendingCommits(gameInstance) {
  if (typeof gameInstance?.settings?.get !== "function") {
    throw pendingError(
      "MERCHANT_PENDING_STORAGE_UNAVAILABLE",
      "Merchant pending storage is unavailable",
    );
  }
  try {
    return gameInstance.settings.get(
      SETTINGS_MODULE_ID,
      MERCHANT_PENDING_SETTING_KEY,
    );
  } catch (error) {
    throw pendingError(
      "MERCHANT_PENDING_READ_FAILED",
      "Merchant pending storage could not be read",
      error,
    );
  }
}

/** Read and strictly validate the current client setting. */
export function loadMerchantPendingCommits(gameInstance = globalThis.game) {
  return parseMerchantPendingCommits(readRawPendingCommits(gameInstance));
}

/** List cloned unresolved records for one user in exactly the current World. */
export function listMerchantPendingCommits({
  worldId,
  originUserId,
  gameInstance = globalThis.game,
} = {}) {
  const world = resolveWorldId(gameInstance, worldId);
  const origin = resolveOriginUserId(gameInstance, originUserId);
  return loadMerchantPendingCommits(gameInstance)
    .records.filter(
      (record) =>
        record.state === MERCHANT_PENDING_STATES.PENDING &&
        record.worldId === world &&
        record.originUserId === origin,
    )
    .map((record) => cloneJsonValue(pendingBaseRecord(record)));
}

function listMerchantPendingState(
  state,
  { worldId, originUserId, gameInstance = globalThis.game } = {},
) {
  const world = resolveWorldId(gameInstance, worldId);
  const origin = resolveOriginUserId(gameInstance, originUserId);
  return loadMerchantPendingCommits(gameInstance)
    .records.filter(
      (record) =>
        record.state === state &&
        record.worldId === world &&
        record.originUserId === origin,
    )
    .map(cloneJsonValue);
}

/** List exact requests quarantined for explicit player/GM review. */
export function listMerchantPendingReviews(options = {}) {
  return listMerchantPendingState(MERCHANT_PENDING_STATES.REVIEW, options);
}

/** List terminal replies still awaiting confirmed local presentation. */
export function listMerchantPendingTerminalOutbox(options = {}) {
  return listMerchantPendingState(
    MERCHANT_PENDING_STATES.TERMINAL_OUTBOX,
    options,
  );
}

/** Require a terminal reply to name the exact saved request before clearing. */
export function merchantPendingCommitMatchesResult(record, result) {
  let parsed;
  try {
    parsed = parseMerchantPendingRecord(
      record?.state ? pendingBaseRecord(record) : record,
    );
  } catch {
    return false;
  }
  if (!result || typeof result !== "object" || Array.isArray(result)) {
    return false;
  }
  const expectedSide =
    parsed.eventType === "merchant:commit-sale" ? "sell" : "buy";
  const expectedFingerprint = merchantCommitRequestFingerprint({
    type: parsed.eventType,
    originUserId: parsed.originUserId,
    ...parsed.payload,
  });
  return Boolean(
    result.targetUserId === parsed.originUserId &&
    result.commitId === parsed.commitId &&
    result.sessionId === parsed.payload.sessionId &&
    result.side === expectedSide &&
    result.requestFingerprint === expectedFingerprint &&
    typeof result.ok === "boolean",
  );
}

function enqueueWrite(gameInstance, operation) {
  const queueable =
    gameInstance !== null &&
    (typeof gameInstance === "object" || typeof gameInstance === "function");
  const prior = queueable
    ? (writeQueues.get(gameInstance) ?? Promise.resolve())
    : fallbackWriteQueue;
  const run = () => withCrossContextWriteLock(gameInstance, operation);
  const result = prior.then(run, run);
  const settled = result.catch(() => {});
  if (queueable) writeQueues.set(gameInstance, settled);
  else fallbackWriteQueue = settled;
  return result;
}

/** Test seam for exercising the IndexedDB lease path in browser-like harnesses. */
export function configureMerchantPendingBrowserLeaseForTests(runner = null) {
  browserLeaseRunner = runner ?? withBrowserLease;
}

function setActiveBrowserLease(gameInstance, lease) {
  const queueable =
    gameInstance !== null &&
    (typeof gameInstance === "object" || typeof gameInstance === "function");
  if (queueable) activeBrowserLeases.set(gameInstance, lease);
  else fallbackBrowserLease = lease;
}

function clearActiveBrowserLease(gameInstance, lease) {
  const queueable =
    gameInstance !== null &&
    (typeof gameInstance === "object" || typeof gameInstance === "function");
  if (queueable) {
    if (activeBrowserLeases.get(gameInstance) === lease) {
      activeBrowserLeases.delete(gameInstance);
    }
  } else if (fallbackBrowserLease === lease) {
    fallbackBrowserLease = null;
  }
}

function activeBrowserLease(gameInstance) {
  const queueable =
    gameInstance !== null &&
    (typeof gameInstance === "object" || typeof gameInstance === "function");
  return queueable
    ? (activeBrowserLeases.get(gameInstance) ?? null)
    : fallbackBrowserLease;
}

async function verifyActiveBrowserLease(gameInstance) {
  const lease = activeBrowserLease(gameInstance);
  if (!lease) return true;
  const renewed = await lease.renew?.();
  if (renewed === true && lease.isHeld?.() === true) return true;
  throw pendingError(
    "MERCHANT_PENDING_LOCK_LOST",
    "Merchant pending storage lost its browser lease",
  );
}

async function withCrossContextWriteLock(gameInstance, operation) {
  const locks = globalThis.navigator?.locks;
  if (typeof locks?.request === "function") {
    try {
      return await locks.request(
        `${SETTINGS_MODULE_ID}:merchant-pending-setting`,
        { mode: "exclusive" },
        operation,
      );
    } catch (error) {
      if (error?.name === "MerchantPendingCommitError") throw error;
      throw pendingError(
        "MERCHANT_PENDING_LOCK_FAILED",
        "Merchant pending storage could not acquire its browser lock",
        error,
      );
    }
  }
  if (globalThis.window?.document) {
    try {
      const leased = await browserLeaseRunner(
        `${SETTINGS_MODULE_ID}:merchant-pending-setting`,
        async (lease) => {
          if (lease?.isHeld?.() !== true) {
            throw pendingError(
              "MERCHANT_PENDING_LOCK_LOST",
              "Merchant pending storage could not verify its browser lease",
            );
          }
          setActiveBrowserLease(gameInstance, lease);
          try {
            const value = await operation();
            await verifyActiveBrowserLease(gameInstance);
            return value;
          } finally {
            clearActiveBrowserLease(gameInstance, lease);
          }
        },
        { ttlMs: 30_000, retryMs: 50 },
      );
      if (leased?.acquired === true) return leased.value;
    } catch (error) {
      if (error?.name === "MerchantPendingCommitError") throw error;
      throw pendingError(
        "MERCHANT_PENDING_LOCK_FAILED",
        "Merchant pending storage could not acquire its browser lease",
        error,
      );
    }
    throw pendingError(
      "MERCHANT_PENDING_LOCK_UNAVAILABLE",
      "This browser cannot safely coordinate merchant retries across tabs",
    );
  }
  // Node harnesses have no browsing context and remain protected by the
  // process queue above.
  return operation();
}

async function writeAndVerify(envelope, gameInstance) {
  if (typeof gameInstance?.settings?.set !== "function") {
    throw pendingError(
      "MERCHANT_PENDING_STORAGE_UNAVAILABLE",
      "Merchant pending storage is unavailable",
    );
  }
  await verifyActiveBrowserLease(gameInstance);
  try {
    await gameInstance.settings.set(
      SETTINGS_MODULE_ID,
      MERCHANT_PENDING_SETTING_KEY,
      cloneJsonValue(envelope),
    );
  } catch (error) {
    throw pendingError(
      "MERCHANT_PENDING_WRITE_FAILED",
      "Merchant pending storage could not be written",
      error,
    );
  }
  await verifyActiveBrowserLease(gameInstance);
  const readback = loadMerchantPendingCommits(gameInstance);
  if (!persistedValuesEqual(readback, envelope)) {
    throw pendingError(
      "MERCHANT_PENDING_READBACK_MISMATCH",
      "Merchant pending storage readback did not match",
    );
  }
  await verifyActiveBrowserLease(gameInstance);
  return readback;
}

/** Persist one request and verify exact setting readback before returning. */
export function persistMerchantPendingCommit(
  record,
  { gameInstance = globalThis.game } = {},
) {
  const parsed = parseMerchantPendingRecord(record);
  const world = resolveWorldId(gameInstance);
  if (parsed.worldId !== world) {
    throw pendingError(
      "MERCHANT_PENDING_WORLD_MISMATCH",
      "Merchant request belongs to a different World",
    );
  }
  return enqueueWrite(gameInstance, async () => {
    const current = loadMerchantPendingCommits(gameInstance);
    const key = pendingRecordKey(
      parsed.worldId,
      parsed.originUserId,
      parsed.commitId,
    );
    const existing = current.records.find(
      (candidate) =>
        pendingRecordKey(
          candidate.worldId,
          candidate.originUserId,
          candidate.commitId,
        ) === key,
    );
    if (existing) {
      if (!persistedValuesEqual(pendingBaseRecord(existing), parsed)) {
        throw pendingError(
          "MERCHANT_PENDING_COMMIT_CONFLICT",
          "Merchant commit id is already pending with different data",
        );
      }
      if (existing.state !== MERCHANT_PENDING_STATES.PENDING) {
        throw pendingError(
          "MERCHANT_PENDING_COMMIT_SETTLED",
          "Merchant commit id already has a terminal client state",
        );
      }
      return cloneJsonValue(parsed);
    }
    const worldRecordCount = current.records.filter(
      (candidate) =>
        candidate.state === MERCHANT_PENDING_STATES.PENDING &&
        candidate.worldId === world,
    ).length;
    const totalPendingCount = current.records.filter(
      (candidate) => candidate.state === MERCHANT_PENDING_STATES.PENDING,
    ).length;
    if (
      worldRecordCount >= MERCHANT_PENDING_MAX_RECORDS ||
      totalPendingCount >= MERCHANT_PENDING_MAX_TOTAL_RECORDS
    ) {
      throw pendingError(
        "MERCHANT_PENDING_CAP_REACHED",
        "Too many merchant requests are still unresolved",
      );
    }
    const next = {
      version: MERCHANT_PENDING_SCHEMA_VERSION,
      records: [...current.records, storedPendingRecord(parsed)],
    };
    await writeAndVerify(next, gameInstance);
    return cloneJsonValue(parsed);
  });
}

/**
 * Persist and verify a request before handing its exact event/payload to the
 * supplied sender. A sender failure deliberately leaves the request pending.
 */
export async function persistAndSendMerchantCommit(
  record,
  { gameInstance = globalThis.game, send } = {},
) {
  if (typeof send !== "function") {
    throw pendingError(
      "MERCHANT_PENDING_SEND_UNAVAILABLE",
      "Merchant request sender is unavailable",
    );
  }
  const persisted = await persistMerchantPendingCommit(record, {
    gameInstance,
  });
  await send(persisted.eventType, cloneJsonValue(persisted.payload));
  return persisted;
}

/** Clear only an unresolved current-World request. Review/outbox states are inert. */
export function clearMerchantPendingCommit(
  originUserId,
  commitId,
  { gameInstance = globalThis.game } = {},
) {
  const world = resolveWorldId(gameInstance);
  const origin = requireIdentifier(originUserId, "origin user id");
  const id = requireMerchantCommitId(commitId);
  return enqueueWrite(gameInstance, async () => {
    const current = loadMerchantPendingCommits(gameInstance);
    const key = pendingRecordKey(world, origin, id);
    const index = current.records.findIndex(
      (candidate) =>
        candidate.state === MERCHANT_PENDING_STATES.PENDING &&
        pendingRecordKey(
          candidate.worldId,
          candidate.originUserId,
          candidate.commitId,
        ) === key,
    );
    if (index < 0) return false;
    const next = {
      version: MERCHANT_PENDING_SCHEMA_VERSION,
      records: current.records.filter(
        (_, candidateIndex) => candidateIndex !== index,
      ),
    };
    await writeAndVerify(next, gameInstance);
    return true;
  });
}

function clearMerchantPendingState(
  state,
  originUserId,
  commitId,
  { gameInstance = globalThis.game } = {},
) {
  const world = resolveWorldId(gameInstance);
  const origin = requireIdentifier(originUserId, "origin user id");
  const id = requireMerchantCommitId(commitId);
  return enqueueWrite(gameInstance, async () => {
    const current = loadMerchantPendingCommits(gameInstance);
    const key = pendingRecordKey(world, origin, id);
    const index = current.records.findIndex(
      (candidate) =>
        candidate.state === state &&
        pendingRecordKey(
          candidate.worldId,
          candidate.originUserId,
          candidate.commitId,
        ) === key,
    );
    if (index < 0) return false;
    const next = {
      version: MERCHANT_PENDING_SCHEMA_VERSION,
      records: current.records.filter(
        (_, candidateIndex) => candidateIndex !== index,
      ),
    };
    await writeAndVerify(next, gameInstance);
    return true;
  });
}

/** Explicitly remove one reviewed/quarantined request after human recovery. */
export function clearMerchantPendingReview(
  originUserId,
  commitId,
  options = {},
) {
  return clearMerchantPendingState(
    MERCHANT_PENDING_STATES.REVIEW,
    originUserId,
    commitId,
    options,
  );
}

function persistenceTimestamp(gameInstance, now) {
  const raw =
    typeof now === "function"
      ? now()
      : now !== undefined
        ? now
        : Number.isSafeInteger(Number(gameInstance?.time?.serverTime)) &&
            Number(gameInstance?.time?.serverTime) > 0
          ? Number(gameInstance.time.serverTime)
          : Date.now();
  const timestamp = Number(raw);
  if (!Number.isSafeInteger(timestamp) || timestamp < 1) {
    throw pendingError(
      "MERCHANT_PENDING_INVALID_TIME",
      "Merchant terminal result time is unavailable",
    );
  }
  return timestamp;
}

function stateCount(records, state, worldId = null) {
  return records.filter(
    (record) =>
      record.state === state &&
      (worldId === null || record.worldId === worldId),
  ).length;
}

/**
 * Atomically validate one terminal reply and transition the exact request to a
 * non-replaying review quarantine or terminal presentation outbox. Nothing is
 * deleted here: human review uses an explicit clear, while terminal outbox
 * removal requires a separately confirmed presentation.
 */
export function settleMerchantPendingCommitResult(
  result,
  { gameInstance = globalThis.game, now } = {},
) {
  const world = resolveWorldId(gameInstance);
  const origin = resolveOriginUserId(gameInstance);
  const commitId = requireMerchantCommitId(result?.commitId);
  return enqueueWrite(gameInstance, async () => {
    const current = loadMerchantPendingCommits(gameInstance);
    const key = pendingRecordKey(world, origin, commitId);
    const index = current.records.findIndex(
      (candidate) =>
        pendingRecordKey(
          candidate.worldId,
          candidate.originUserId,
          candidate.commitId,
        ) === key,
    );
    if (index < 0) return { status: "missing", record: null };
    const stored = current.records[index];
    const record = pendingBaseRecord(stored);
    if (!merchantPendingCommitMatchesResult(record, result)) {
      return { status: "mismatch", record: cloneJsonValue(record) };
    }
    if (stored.state === MERCHANT_PENDING_STATES.REVIEW) {
      if (stored.review.reason === result.reason) {
        return {
          status: "review",
          record: cloneJsonValue(record),
          review: cloneJsonValue(stored.review),
        };
      }
      // A later status-only probe may prove that this exact durable request is
      // now terminal after a GM recheck. Only an exact successful terminal
      // identity may leave review; unrelated failures never rewrite it.
      if (result.ok !== true || result.reason !== "") {
        return { status: "mismatch", record: cloneJsonValue(record) };
      }
    }
    if (stored.state === MERCHANT_PENDING_STATES.TERMINAL_OUTBOX) {
      const normalizedResult = normalizeTerminalResult(result, record);
      if (!persistedValuesEqual(stored.terminal.result, normalizedResult)) {
        return { status: "mismatch", record: cloneJsonValue(record) };
      }
      return {
        status: "terminal-outbox",
        record: cloneJsonValue(record),
        terminal: cloneJsonValue(stored.terminal),
      };
    }

    const receivedAt = persistenceTimestamp(gameInstance, now);
    let replacement;
    let response;
    if (REVIEW_REASONS.has(result.reason)) {
      if (
        stateCount(current.records, MERCHANT_PENDING_STATES.REVIEW, world) >=
          MERCHANT_PENDING_MAX_REVIEW_RECORDS ||
        stateCount(current.records, MERCHANT_PENDING_STATES.REVIEW) >=
          MERCHANT_PENDING_MAX_TOTAL_REVIEW_RECORDS
      ) {
        throw pendingError(
          "MERCHANT_PENDING_REVIEW_CAP_REACHED",
          "Too many merchant requests are awaiting explicit review",
        );
      }
      replacement = {
        state: MERCHANT_PENDING_STATES.REVIEW,
        ...record,
        review: { reason: result.reason, receivedAt },
      };
      response = {
        status: "quarantined",
        record: cloneJsonValue(record),
        review: cloneJsonValue(replacement.review),
      };
    } else {
      if (
        stateCount(
          current.records,
          MERCHANT_PENDING_STATES.TERMINAL_OUTBOX,
          world,
        ) >= MERCHANT_PENDING_MAX_OUTBOX_RECORDS ||
        stateCount(current.records, MERCHANT_PENDING_STATES.TERMINAL_OUTBOX) >=
          MERCHANT_PENDING_MAX_TOTAL_OUTBOX_RECORDS
      ) {
        throw pendingError(
          "MERCHANT_PENDING_OUTBOX_CAP_REACHED",
          "Too many merchant results are awaiting confirmed presentation",
        );
      }
      replacement = {
        state: MERCHANT_PENDING_STATES.TERMINAL_OUTBOX,
        ...record,
        terminal: {
          receivedAt,
          result: normalizeTerminalResult(result, record),
        },
      };
      response = {
        status: "terminal-outbox",
        record: cloneJsonValue(record),
        terminal: cloneJsonValue(replacement.terminal),
      };
    }
    const records = [...current.records];
    records[index] = replacement;
    const next = {
      version: MERCHANT_PENDING_SCHEMA_VERSION,
      records,
    };
    await writeAndVerify(next, gameInstance);
    return response;
  });
}

/**
 * Hold the cross-tab lock while exactly one browser context presents a stored
 * terminal result. The outbox record is removed only when `present` returns
 * exactly true and the exact stored value still matches on readback.
 */
export function presentMerchantPendingTerminalOutbox(
  originUserId,
  commitId,
  { gameInstance = globalThis.game, present } = {},
) {
  if (typeof present !== "function") {
    throw pendingError(
      "MERCHANT_PENDING_PRESENTER_UNAVAILABLE",
      "Merchant terminal presenter is unavailable",
    );
  }
  const world = resolveWorldId(gameInstance);
  const origin = requireIdentifier(originUserId, "origin user id");
  const id = requireMerchantCommitId(commitId);
  return enqueueWrite(gameInstance, async () => {
    const current = loadMerchantPendingCommits(gameInstance);
    const key = pendingRecordKey(world, origin, id);
    const index = current.records.findIndex(
      (candidate) =>
        candidate.state === MERCHANT_PENDING_STATES.TERMINAL_OUTBOX &&
        pendingRecordKey(
          candidate.worldId,
          candidate.originUserId,
          candidate.commitId,
        ) === key,
    );
    if (index < 0) return { status: "missing", record: null };
    const stored = current.records[index];
    const record = cloneJsonValue(pendingBaseRecord(stored));
    const terminal = cloneJsonValue(stored.terminal);
    await verifyActiveBrowserLease(gameInstance);
    const presented = await present({ record, terminal });
    await verifyActiveBrowserLease(gameInstance);
    if (presented !== true) {
      return { status: "presentation-failed", record, terminal };
    }

    const latest = loadMerchantPendingCommits(gameInstance);
    const latestIndex = latest.records.findIndex(
      (candidate) =>
        candidate.state === MERCHANT_PENDING_STATES.TERMINAL_OUTBOX &&
        pendingRecordKey(
          candidate.worldId,
          candidate.originUserId,
          candidate.commitId,
        ) === key,
    );
    if (
      latestIndex < 0 ||
      !persistedValuesEqual(latest.records[latestIndex], stored)
    ) {
      throw pendingError(
        "MERCHANT_PENDING_PRESENTATION_CONFLICT",
        "Merchant terminal outbox changed during presentation",
      );
    }
    const next = {
      version: MERCHANT_PENDING_SCHEMA_VERSION,
      records: latest.records.filter(
        (_, candidateIndex) => candidateIndex !== latestIndex,
      ),
    };
    await writeAndVerify(next, gameInstance);
    return { status: "presented", record, terminal };
  });
}

/** Re-send each unresolved request for one user without changing its payload. */
export async function resendMerchantPendingCommits({
  originUserId,
  gameInstance = globalThis.game,
  send,
} = {}) {
  const records = listMerchantPendingCommits({
    originUserId,
    gameInstance,
  });
  if (send !== undefined && typeof send !== "function") {
    throw pendingError(
      "MERCHANT_PENDING_SEND_UNAVAILABLE",
      "Merchant request sender is unavailable",
    );
  }
  if (typeof send === "function") {
    for (const record of records) {
      await send(record.eventType, cloneJsonValue(record.payload));
    }
  }
  return records;
}
