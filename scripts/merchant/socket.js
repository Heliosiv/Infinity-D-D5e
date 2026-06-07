/**
 * Infinity D&D5e — Merchant Socket
 *
 * GM ↔ player communication for the Merchant Workspace. Every payload
 * carries a `type` field — handlers filter by type and ignore the rest
 * (the audio module shares this socket name with its own type).
 *
 * Authority model:
 * - GM client owns the merchant store and the in-memory session map.
 * - Player client owns its actor mutations (item create/delete, coin).
 * - Bargain *tier resolution* is GM-side so the merchant's DC + tier
 *   schedule are the source of truth (player can't fake a discount).
 * - Stock decrements run inside a per-merchant async mutex on the GM.
 *
 * Listeners receive every broadcast; non-target roles ignore them.
 * Only the active GM (when one exists) handles player→GM messages, so
 * a multi-GM table doesn't trigger double writes.
 */

import {
  adjustMerchantGold,
  buildMerchantBargainTiers,
  decrementInventory,
  findMerchant,
  isUserAllowed,
  normalizeMerchant,
  roundGp,
  upsertMerchant,
} from "./store.js";
import { resolveUnitBuyPrice } from "./transaction.js";
import { computeBargainOutcome } from "./bargain.js";
import {
  closeSession,
  consumeSeal,
  findSessionFor,
  getSession,
  listSessions,
  openSession,
  recordBargain,
  runWithMerchantMutex,
} from "./session-state.js";

const MODULE_ID = "infinity-dnd5e";
const SOCKET_NAME = `module.${MODULE_ID}`;

export const MERCHANT_EVENTS = Object.freeze({
  SESSION_OPEN: "merchant:session-open",
  SESSION_CLOSE: "merchant:session-close",
  BARGAIN_RESULT: "merchant:bargain-result",
  BARGAIN_SEAL: "merchant:bargain-seal",
  COMMIT_PURCHASE: "merchant:commit-purchase",
  COMMIT_SALE: "merchant:commit-sale",
  STATE_UPDATE: "merchant:state-update",
});

const MERCHANT_TYPES = new Set(Object.values(MERCHANT_EVENTS));

let registered = false;

/**
 * In-memory listeners (player-side and GM-monitoring) that want to be
 * notified when specific events arrive. Keyed by event type → set of
 * callback functions.
 */
const listeners = new Map();

/** Subscribe to a merchant event type. Returns an unsubscribe function. */
export function subscribe(eventType, handler) {
  if (!MERCHANT_TYPES.has(eventType) || typeof handler !== "function") {
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
      console.warn(`${MODULE_ID} | merchant listener for ${eventType}`, error);
    }
  }
}

/* ------------------------------------------------------------------ *
 * Registration
 * ------------------------------------------------------------------ */

/** Register the merchant socket handler. Idempotent. */
export function registerMerchantSocket() {
  const socket = globalThis.game?.socket;
  if (!socket || registered) return registered;
  if (typeof socket.on !== "function") return false;
  socket.on(SOCKET_NAME, receiveMerchantPayload);
  registered = true;
  return true;
}

/**
 * Whether the current client should act as the GM handler for
 * authoritative writes. Only the active GM (the one Foundry deems
 * "primary") handles player→GM messages.
 */
function isAuthoritativeGM() {
  const game = globalThis.game;
  if (!game?.user?.isGM) return false;
  const active = game.users?.activeGM;
  if (!active) return true;
  return active.id === game.user.id;
}

/* ------------------------------------------------------------------ *
 * Send
 * ------------------------------------------------------------------ */

/** Emit a merchant event over the socket. Returns the payload sent. */
export function emitMerchantEvent(type, data = {}) {
  if (!MERCHANT_TYPES.has(type)) {
    console.warn(`${MODULE_ID} | refused unknown merchant event "${type}"`);
    return null;
  }
  const payload = {
    type,
    originUserId: globalThis.game?.user?.id ?? null,
    sentAt: null,
    ...data,
  };
  const socket = globalThis.game?.socket;
  if (typeof socket?.emit === "function") {
    socket.emit(SOCKET_NAME, payload);
  }
  // Always dispatch to local listeners so the originator sees its own
  // payload — UIs can render optimistically without round-trip.
  dispatchToListeners(type, payload);
  return payload;
}

/* ------------------------------------------------------------------ *
 * Receive
 * ------------------------------------------------------------------ */

export async function receiveMerchantPayload(payload) {
  if (!payload || typeof payload !== "object") return;
  if (!MERCHANT_TYPES.has(payload.type)) return;

  // Suppress echo to self — we already dispatched locally on emit.
  if (
    payload.originUserId &&
    payload.originUserId === globalThis.game?.user?.id
  ) {
    return;
  }

  dispatchToListeners(payload.type, payload);

  // GM-authority routes:
  switch (payload.type) {
    case MERCHANT_EVENTS.BARGAIN_RESULT:
      if (isAuthoritativeGM()) {
        try {
          await handleBargainResult(payload);
        } catch (error) {
          console.error(`${MODULE_ID} | bargain-result handler`, error);
        }
      }
      break;
    case MERCHANT_EVENTS.COMMIT_PURCHASE:
      if (isAuthoritativeGM()) {
        try {
          await handleCommitPurchase(payload);
        } catch (error) {
          console.error(`${MODULE_ID} | commit-purchase handler`, error);
        }
      }
      break;
    case MERCHANT_EVENTS.COMMIT_SALE:
      if (isAuthoritativeGM()) {
        try {
          await handleCommitSale(payload);
        } catch (error) {
          console.error(`${MODULE_ID} | commit-sale handler`, error);
        }
      }
      break;
  }
}

/* ------------------------------------------------------------------ *
 * GM-side handlers
 * ------------------------------------------------------------------ */

async function handleBargainResult(payload) {
  const { sessionId, itemUuid, side, rollTotal, skillId } = payload;
  const session = getSession(sessionId);
  if (!session) return;
  if (session.viewerUserId !== payload.originUserId) return;
  const merchant = findMerchant(session.merchantId);
  if (!merchant) return;
  // Per-merchant success/fail swing (no crit distinction).
  const tiers = buildMerchantBargainTiers(merchant);
  const outcome = computeBargainOutcome(
    Number(rollTotal) || 0,
    Number(merchant.bargainDC) || 0,
    tiers,
  );
  const seal = recordBargain(sessionId, {
    itemUuid,
    side,
    tier: outcome.tier,
    deltaPct: outcome.deltaPct,
  });
  if (!seal) return;
  emitMerchantEvent(MERCHANT_EVENTS.BARGAIN_SEAL, {
    sessionId,
    itemUuid,
    side,
    sealId: seal.sealId,
    tier: seal.tier,
    deltaPct: seal.deltaPct,
    skillId,
    rollTotal,
    dc: merchant.bargainDC,
    targetUserId: session.viewerUserId,
  });
}

async function handleCommitPurchase(payload) {
  const { sessionId, itemUuid, qty, sealId } = payload;
  const session = getSession(sessionId);
  if (!session) return;
  if (session.viewerUserId !== payload.originUserId) return;
  const requested = Math.max(1, Math.floor(Number(qty) || 1));
  const clientTotalGp = Math.max(0, Number(payload.totalGp) || 0);

  await runWithMerchantMutex(session.merchantId, async () => {
    const merchant = findMerchant(session.merchantId);
    if (!merchant) {
      console.warn(
        `${MODULE_ID} | commit-purchase: merchant ${session.merchantId} is gone`,
      );
      return;
    }
    const row = merchant.items.find((r) => r.uuid === itemUuid);
    if (!row) return;
    // Verify + burn the bargain seal here (inside the mutex) and keep its
    // delta for the GM-side reprice.
    const seal = sealId
      ? consumeSeal(sessionId, sealId, { itemUuid, side: "buy" })
      : null;

    // Recompute the price from the merchant's OWN data — never trust the
    // client's claimed total. The merchant's gold gain uses this server
    // figure, so a buggy/forged client can't shortchange (or overpay) it.
    let trueTotal = clientTotalGp;
    try {
      const itemDoc = await fromUuid(itemUuid);
      const item = itemDoc?.toObject?.() ?? itemDoc ?? null;
      const unitGp = resolveUnitBuyPrice({ merchant, row, item, seal });
      if (unitGp > 0) trueTotal = roundGp(unitGp * requested);
    } catch (error) {
      console.warn(`${MODULE_ID} | commit-purchase reprice failed`, error);
    }
    if (Math.abs(trueTotal - clientTotalGp) > 0.01) {
      console.warn(
        `${MODULE_ID} | commit-purchase price mismatch (client ${clientTotalGp}, server ${trueTotal}) — using server price`,
      );
    }

    let updated = merchant;
    // Decrement stock when the row is finite and the player's view was
    // current; otherwise the buy already executed client-side against stale
    // state, so leave stock alone but surface it rather than silently swallow.
    if (!row.unlimited && row.qty >= requested) {
      try {
        updated = decrementInventory(updated, itemUuid, requested);
      } catch (error) {
        console.warn(`${MODULE_ID} | decrement failed`, error);
      }
    } else if (!row.unlimited) {
      console.warn(
        `${MODULE_ID} | commit-purchase: "${itemUuid}" stock ${row.qty} < ${requested} (concurrent/stale buy) — charged but not decremented`,
      );
    }
    // The merchant gains the gold the player paid (no-op if unlimited purse).
    updated = adjustMerchantGold(updated, trueTotal);
    await upsertMerchant(updated);
    await broadcastState(updated);
  });
}

async function handleCommitSale(payload) {
  const { sessionId, sealId, itemUuid } = payload;
  const session = getSession(sessionId);
  if (!session) return;
  if (session.viewerUserId !== payload.originUserId) return;
  const totalGp = Math.max(0, Number(payload.totalGp) || 0);
  // Sales don't change stock, but the merchant pays out — spend its gold
  // (clamped at 0; no-op if the purse is unlimited). Seal consumption runs
  // inside the mutex too, matching the buy path.
  await runWithMerchantMutex(session.merchantId, async () => {
    if (sealId) consumeSeal(sessionId, sealId, { itemUuid, side: "sell" });
    const merchant = findMerchant(session.merchantId);
    if (!merchant) return;
    const updated = adjustMerchantGold(merchant, -totalGp);
    await upsertMerchant(updated);
    await broadcastState(updated);
  });
}

async function broadcastState(merchant) {
  if (!merchant) return;
  emitMerchantEvent(MERCHANT_EVENTS.STATE_UPDATE, {
    merchantId: merchant.id,
    merchant: normalizeMerchant(merchant),
  });
}

/* ------------------------------------------------------------------ *
 * GM-initiated session pushes
 * ------------------------------------------------------------------ */

/**
 * Open a merchant session for one or more target users. Creates state
 * entries and broadcasts the session-open event so target clients pop
 * the buy/sell window.
 */
export function pushOpenSession({ merchant, targetUserIds }) {
  if (!merchant) throw new Error("pushOpenSession needs merchant");
  const ids = Array.isArray(targetUserIds) ? targetUserIds : [];
  if (ids.length === 0) return [];
  const sessionDescriptors = [];
  for (const userId of ids) {
    if (!isUserAllowed(merchant, userId)) continue;
    const record = openSession({
      merchantId: merchant.id,
      viewerUserId: userId,
    });
    sessionDescriptors.push({
      sessionId: record.sessionId,
      viewerUserId: userId,
    });
  }
  for (const descriptor of sessionDescriptors) {
    emitMerchantEvent(MERCHANT_EVENTS.SESSION_OPEN, {
      sessionId: descriptor.sessionId,
      merchantId: merchant.id,
      merchant: normalizeMerchant(merchant),
      targetUserId: descriptor.viewerUserId,
    });
  }
  return sessionDescriptors;
}

/** Close a session and notify the player. */
export function pushCloseSession(sessionId) {
  const session = getSession(sessionId);
  if (!session) return false;
  emitMerchantEvent(MERCHANT_EVENTS.SESSION_CLOSE, {
    sessionId,
    targetUserId: session.viewerUserId,
  });
  closeSession(sessionId);
  return true;
}

/** Close every session for a given merchant (GM "End all sessions"). */
export function pushCloseAllSessionsFor(merchantId) {
  let closed = 0;
  for (const session of [...findAllSessionsFor(merchantId)]) {
    if (pushCloseSession(session.sessionId)) closed++;
  }
  return closed;
}

function findAllSessionsFor(merchantId) {
  return listSessions().filter((session) => session.merchantId === merchantId);
}
