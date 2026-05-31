/**
 * Infinity D&D5e — Merchant Session State (GM-only)
 *
 * Holds the transient state of every open merchant session — who is
 * shopping with whom, which bargains have been struck, and per-merchant
 * mutex chains that serialize stock writes.
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

function generateSessionId() {
  const stamp = Math.floor(Math.random() * 0xffffff).toString(16).padStart(6, "0");
  const tail = Math.floor(Math.random() * 0xffffff).toString(16).padStart(6, "0");
  return `s-${stamp}${tail}`;
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
  return `seal-${Math.floor(Math.random() * 0xffffffff).toString(16).padStart(8, "0")}-${Date.now() & 0xffffff}`;
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
 * Per-merchant mutex
 *
 * Serializes stock decrements across concurrent purchases so two
 * players can't both buy the last potion.
 * ------------------------------------------------------------------ */

const mutexChains = new Map(); // merchantId → trailing Promise

/**
 * Run `fn` while holding the mutex for `merchantId`. Returns whatever
 * `fn` returns (or rejects with its rejection). A failed fn doesn't
 * poison the chain — subsequent callers still acquire the lock.
 */
export function runWithMerchantMutex(merchantId, fn) {
  const prev = mutexChains.get(merchantId) ?? Promise.resolve();
  const result = prev.then(() => fn(), () => fn());
  const sink = result.catch(() => {});
  mutexChains.set(merchantId, sink);
  sink.then(() => {
    if (mutexChains.get(merchantId) === sink) mutexChains.delete(merchantId);
  });
  return result;
}

/** Reset every session — test/dev convenience. */
export function clearAllSessions() {
  sessions.clear();
  mutexChains.clear();
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
