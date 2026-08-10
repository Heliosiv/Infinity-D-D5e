/**
 * Infinity D&D5e — Merchant Session State (GM-only)
 *
 * Holds the transient state of every open merchant session — who is
 * shopping with whom, which bargains have been struck, and per-merchant
 * mutex chains that serialize stock and actor-wallet writes.
 *
 * State is in-memory only. The GM client is authoritative; sessions
 * end when the GM closes them or the world reloads.
 */

const MODULE_ID = "infinity-dnd5e";

/* ------------------------------------------------------------------ *
 * Session map
 * ------------------------------------------------------------------ */

const sessions = new Map(); // sessionId → SessionRecord

function buildSessionKey(merchantId, viewerUserId) {
  return `${merchantId}::${viewerUserId}`;
}

/** Unguessable token; crypto.randomUUID where available, else a Math fallback. */
function randomToken() {
  const uuid = globalThis.crypto?.randomUUID?.();
  if (uuid) return uuid;
  const a = Math.floor(Math.random() * 0xffffffff).toString(16);
  const b = Math.floor(Math.random() * 0xffffffff).toString(16);
  return `${a}${b}`;
}

function generateSessionId() {
  return `s-${randomToken()}`;
}

/**
 * Open (or recycle) a session for a (merchant, viewer) pair. If one
 * is already open for that pair, returns the existing record — opening
 * the same merchant for the same player twice is idempotent.
 */
export function openSession({ merchantId, viewerUserId }) {
  if (!merchantId || !viewerUserId) {
    throw new Error("openSession requires merchantId + viewerUserId");
  }
  const key = buildSessionKey(merchantId, viewerUserId);
  for (const record of sessions.values()) {
    if (record.key === key) return record;
  }
  const record = {
    sessionId: generateSessionId(),
    key,
    merchantId,
    viewerUserId,
    bargains: new Map(), // bargainKey → { tier, deltaPct, sealId, side, itemUuid }
    openedAt: null,
    commits: new Map(),
    failedCommitIds: [],
  };
  sessions.set(record.sessionId, record);
  return record;
}

/** Close a session by id. Safe to call on an unknown id. */
export function closeSession(sessionId) {
  if (!sessionId) return false;
  return sessions.delete(sessionId);
}

/** Close every session belonging to a viewer. */
export function closeViewerSessions(viewerUserId) {
  let closed = 0;
  for (const [id, record] of sessions) {
    if (record.viewerUserId === viewerUserId) {
      sessions.delete(id);
      closed++;
    }
  }
  return closed;
}

/** Look up a session by id. */
export function getSession(sessionId) {
  return sessions.get(sessionId) ?? null;
}

/** Find an active session for a (merchant, viewer) pair. */
export function findSessionFor(merchantId, viewerUserId) {
  const key = buildSessionKey(merchantId, viewerUserId);
  for (const record of sessions.values()) {
    if (record.key === key) return record;
  }
  return null;
}

/** Read-only list of every active session. */
export function listSessions() {
  return [...sessions.values()];
}

/* ------------------------------------------------------------------ *
 * Bargain seals
 * ------------------------------------------------------------------ */

function buildBargainKey(itemUuid, side) {
  return `${itemUuid}::${side}`;
}

function generateSealId() {
  return `seal-${randomToken()}`;
}

const BARGAIN_EXPIRED_RESULT = Object.freeze({
  ok: false,
  reason: "bargain-expired",
});

function buildSealReservationIdentity({
  originUserId,
  commitId,
  requestFingerprint,
} = {}) {
  if (
    typeof originUserId !== "string" ||
    !originUserId ||
    typeof commitId !== "string" ||
    !commitId ||
    typeof requestFingerprint !== "string" ||
    !requestFingerprint
  ) {
    return null;
  }
  return { originUserId, commitId, requestFingerprint };
}

function reservationMatches(actual, expected) {
  return Boolean(
    actual &&
    expected &&
    actual.originUserId === expected.originUserId &&
    actual.commitId === expected.commitId &&
    actual.requestFingerprint === expected.requestFingerprint,
  );
}

function findScopedSeal(record, sealId, { itemUuid, side } = {}) {
  if (
    !record ||
    typeof sealId !== "string" ||
    !sealId ||
    typeof itemUuid !== "string" ||
    !itemUuid ||
    typeof side !== "string" ||
    !side
  ) {
    return null;
  }
  const key = buildBargainKey(itemUuid, side);
  const seal = record.bargains.get(key);
  if (
    !seal ||
    seal.sealId !== sealId ||
    seal.itemUuid !== itemUuid ||
    seal.side !== side
  ) {
    return null;
  }
  return { key, seal };
}

/**
 * Record a bargain outcome on a session and issue a seal id. Returns
 * the seal record (includes the new sealId).
 *
 * If a seal is already recorded for this (item, side), the existing
 * record is returned — one-bargain-per-item-per-side is enforced here.
 */
export function recordBargain(sessionId, { itemUuid, side, tier, deltaPct }) {
  const record = sessions.get(sessionId);
  if (!record) return null;
  const key = buildBargainKey(itemUuid, side);
  const existing = record.bargains.get(key);
  if (existing) return existing;
  const seal = {
    sealId: generateSealId(),
    itemUuid,
    side,
    tier: tier ?? null,
    deltaPct: Number(deltaPct) || 0,
  };
  record.bargains.set(key, seal);
  return seal;
}

/** Look up the currently-active seal for a (session, item, side), or null. */
export function getBargain(sessionId, itemUuid, side) {
  const record = sessions.get(sessionId);
  if (!record) return null;
  return record.bargains.get(buildBargainKey(itemUuid, side)) ?? null;
}

/**
 * Reserve one scoped bargain seal for one exact durable commit identity.
 * Repeating the same reservation is idempotent; every competing claim fails
 * closed so a quoted bargain cannot be attached to a different transaction.
 */
export function reserveSealForCommit(
  sessionId,
  sealId,
  { itemUuid, side, originUserId, commitId, requestFingerprint } = {},
) {
  const record = sessions.get(sessionId);
  const scoped = findScopedSeal(record, sealId, { itemUuid, side });
  const identity = buildSealReservationIdentity({
    originUserId,
    commitId,
    requestFingerprint,
  });
  if (!scoped || !identity) return BARGAIN_EXPIRED_RESULT;

  if (scoped.seal.reservedFor) {
    if (!reservationMatches(scoped.seal.reservedFor, identity)) {
      return BARGAIN_EXPIRED_RESULT;
    }
    return { ok: true, seal: scoped.seal, replay: true };
  }

  scoped.seal.reservedFor = Object.freeze(identity);
  return { ok: true, seal: scoped.seal, replay: false };
}

/** Burn a bargain seal only when the caller owns its exact reservation. */
export function consumeReservedSeal(
  sessionId,
  sealId,
  { itemUuid, side, originUserId, commitId, requestFingerprint } = {},
) {
  const record = sessions.get(sessionId);
  const scoped = findScopedSeal(record, sealId, { itemUuid, side });
  const identity = buildSealReservationIdentity({
    originUserId,
    commitId,
    requestFingerprint,
  });
  if (!scoped || !reservationMatches(scoped.seal.reservedFor, identity)) {
    return null;
  }
  record.bargains.delete(scoped.key);
  return scoped.seal;
}

/** Release one exact claim while leaving the bargain seal available. */
export function releaseSealReservation(
  sessionId,
  sealId,
  { itemUuid, side, originUserId, commitId, requestFingerprint } = {},
) {
  const record = sessions.get(sessionId);
  const scoped = findScopedSeal(record, sealId, { itemUuid, side });
  const identity = buildSealReservationIdentity({
    originUserId,
    commitId,
    requestFingerprint,
  });
  if (!scoped || !reservationMatches(scoped.seal.reservedFor, identity)) {
    return false;
  }
  delete scoped.seal.reservedFor;
  return true;
}

/**
 * Verify and burn a seal. Returns the seal data on success, null on
 * mismatch (unknown id, wrong session, wrong side/item).
 */
export function consumeSeal(sessionId, sealId, { itemUuid, side } = {}) {
  const record = sessions.get(sessionId);
  if (!record || !sealId) return null;
  for (const [key, seal] of record.bargains) {
    if (seal.sealId !== sealId) continue;
    if (itemUuid && seal.itemUuid !== itemUuid) return null;
    if (side && seal.side !== side) return null;
    record.bargains.delete(key);
    return seal;
  }
  return null;
}

/* ------------------------------------------------------------------ *
 * Commit idempotency
 * ------------------------------------------------------------------ */

const MAX_FAILED_COMMIT_RESULTS_PER_SESSION = 250;

export function getCommitResult(sessionId, commitId) {
  if (!sessionId || !commitId) return null;
  return sessions.get(sessionId)?.commits?.get(commitId) ?? null;
}

export function recordCommitResult(sessionId, commitId, result) {
  const session = sessions.get(sessionId);
  if (!session || !commitId || !result) return null;
  const existing = session.commits.get(commitId);
  if (existing) return existing;
  const recorded = Object.freeze({ ...result });
  session.commits.set(commitId, recorded);

  // A successful actor/shop mutation must remain replay-safe for the complete
  // lifetime of its in-memory session. Evicting an old success would allow the
  // same commitId to mutate a second time. Failures are safe to retry with a new
  // commitId, so only that subset is bounded.
  if (recorded.ok !== true) {
    session.failedCommitIds ??= [];
    session.failedCommitIds.push(commitId);
  }
  while (
    (session.failedCommitIds?.length ?? 0) >
    MAX_FAILED_COMMIT_RESULTS_PER_SESSION
  ) {
    const oldestFailureId = session.failedCommitIds.shift();
    if (oldestFailureId) session.commits.delete(oldestFailureId);
  }
  return recorded;
}

/* ------------------------------------------------------------------ *
 * Transaction mutexes
 *
 * Merchant locks protect shop stock and gold. Actor locks protect one wallet
 * and inventory across simultaneous transactions at different shops.
 * ------------------------------------------------------------------ */

const merchantMutexChains = new Map(); // merchantId → trailing Promise
const actorMutexChains = new Map(); // actorId → trailing Promise

function runWithMutex(chains, key, fn) {
  const prev = chains.get(key) ?? Promise.resolve();
  const result = prev.then(
    () => fn(),
    () => fn(),
  );
  const sink = result.catch(() => {});
  chains.set(key, sink);
  sink.then(() => {
    if (chains.get(key) === sink) chains.delete(key);
  });
  return result;
}

/**
 * Run `fn` while holding the mutex for `merchantId`. Returns whatever
 * `fn` returns (or rejects with its rejection). A failed fn doesn't
 * poison the chain — subsequent callers still acquire the lock.
 */
export function runWithMerchantMutex(merchantId, fn) {
  return runWithMutex(merchantMutexChains, merchantId, fn);
}

/**
 * Serialize money and inventory mutations for one actor across every merchant.
 * Per-merchant locking alone cannot protect a wallet shared by two shops.
 */
export function runWithActorMutex(actorId, fn) {
  return runWithMutex(actorMutexChains, actorId, fn);
}

/** Hold the shop lock, then the actor lock, for one complete transaction. */
export function runWithMerchantActorMutex(merchantId, actorId, fn) {
  return runWithMerchantMutex(merchantId, () => runWithActorMutex(actorId, fn));
}

/** Reset every session — test/dev convenience. */
export function clearAllSessions() {
  sessions.clear();
  merchantMutexChains.clear();
  actorMutexChains.clear();
}

/** Print a summary of active sessions to the console. Debug-only. */
export function debugDumpSessions() {
  const summary = [...sessions.values()].map((s) => ({
    sessionId: s.sessionId,
    merchantId: s.merchantId,
    viewerUserId: s.viewerUserId,
    bargains: s.bargains.size,
  }));
  console.log(`${MODULE_ID} | active merchant sessions:`, summary);
  return summary;
}
