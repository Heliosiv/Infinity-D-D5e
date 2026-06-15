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
  canSelfOpen,
  decrementInventory,
  findMerchant,
  getSelfServiceMode,
  loadMerchants,
  merchantCanAfford,
  normalizeMerchant,
  roundGp,
  sanitizeMerchantForList,
  upsertMerchant,
} from "./store.js";
import { resolveUnitBuyPrice, resolveUnitSellPrice } from "./transaction.js";
import { computeBargainOutcome, computePassiveBargainPct } from "./bargain.js";
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
import { escapeHtml } from "../ui-util.js";

const MODULE_ID = "infinity-dnd5e";
const SOCKET_NAME = `module.${MODULE_ID}`;

export const MERCHANT_EVENTS = Object.freeze({
  SESSION_OPEN: "merchant:session-open",
  SESSION_CLOSE: "merchant:session-close",
  // Player→GM on (re)connect: "re-send any sessions still open for me".
  // SESSION_OPEN is a one-shot broadcast with no replay, so without this a
  // reload/relog would silently lose the pushed buy/sell window even though the
  // GM still holds the session. The GM answers by re-emitting SESSION_OPEN.
  SESSION_RESUME_REQUEST: "merchant:session-resume-request",
  BARGAIN_RESULT: "merchant:bargain-result",
  BARGAIN_SEAL: "merchant:bargain-seal",
  COMMIT_PURCHASE: "merchant:commit-purchase",
  COMMIT_SALE: "merchant:commit-sale",
  // GM→player acknowledgement of a commit. Lets the buyer/seller know the trade
  // was actually recorded (or wasn't, e.g. the session was gone after a GM
  // reload) instead of the actor mutating while the shop silently never updates.
  COMMIT_RESULT: "merchant:commit-result",
  STATE_UPDATE: "merchant:state-update",
  // Player-initiated shop access (the "storefront door"). REQUEST events go
  // player→GM and are handled only on the authoritative GM; REPLY goes back
  // to the requesting player.
  SHOP_LIST_REQUEST: "merchant:shop-list-request",
  SHOP_LIST_REPLY: "merchant:shop-list-reply",
  SHOP_REQUEST: "merchant:shop-request",
  // GM→player outcome for a shop-open request (denied / unavailable) so a
  // rejected click resolves visibly instead of dying silently.
  SHOP_RESULT: "merchant:shop-result",
});

const MERCHANT_TYPES = new Set(Object.values(MERCHANT_EVENTS));

/**
 * Required-field rules per inbound type. `req` fields must be non-empty
 * strings; `num` fields, when present, must be finite numbers. The socket
 * can't authenticate the sender (originUserId is client-asserted — all
 * real authority decisions stay GM-side), so this is shape-hardening
 * against malformed/forged frames, not authentication. Unlisted types are
 * not field-validated (broadcasts the receiver already scopes by target).
 */
const PAYLOAD_RULES = Object.freeze({
  [MERCHANT_EVENTS.COMMIT_PURCHASE]: { req: ["sessionId", "itemUuid"], num: ["qty", "totalGp"] },
  [MERCHANT_EVENTS.COMMIT_SALE]: { req: ["sessionId", "itemUuid"], num: ["qty", "totalGp"] },
  [MERCHANT_EVENTS.BARGAIN_RESULT]: { req: ["sessionId", "itemUuid", "side"], num: ["rollTotal"] },
  [MERCHANT_EVENTS.SESSION_CLOSE]: { req: ["sessionId"], num: [] },
  [MERCHANT_EVENTS.SHOP_REQUEST]: { req: ["merchantId"], num: [] },
});

const MAX_FIELD_LEN = 200;

/** Validate an inbound payload's shape against PAYLOAD_RULES. */
function isValidPayload(payload) {
  const rule = PAYLOAD_RULES[payload.type];
  if (!rule) return true; // not a field-validated type
  for (const key of rule.req) {
    const value = payload[key];
    if (typeof value !== "string" || value.length === 0 || value.length > MAX_FIELD_LEN) {
      return false;
    }
  }
  for (const key of rule.num) {
    if (key in payload && !Number.isFinite(Number(payload[key]))) return false;
  }
  return true;
}

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
  if (active) return active.id === game.user.id;
  // No designated active GM — e.g. the brief window during GM connect/
  // disconnect churn. "Every GM acts" here double-writes stock/gold, so fall
  // back to a deterministic tiebreaker: only the lowest-id currently-connected
  // GM handles the frame. Solo GM (no other GMs online, or headless/tests)
  // still acts.
  const gms = [];
  game.users?.forEach?.((u) => {
    if (u?.isGM && u?.active) gms.push(u.id);
  });
  if (gms.length === 0) return true;
  gms.sort();
  return gms[0] === game.user.id;
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
  if (!isValidPayload(payload)) {
    console.warn(`${MODULE_ID} | dropped malformed ${payload.type} frame`);
    return;
  }

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
    case MERCHANT_EVENTS.SESSION_CLOSE:
      // A player closing their own shop window tells the authoritative GM to
      // drop the session record so the workspace's Active Sessions list stays
      // accurate. (GM-originated closes already call closeSession directly and
      // are echo-suppressed here.)
      if (isAuthoritativeGM() && payload.sessionId) {
        try {
          closeSession(payload.sessionId);
        } catch (error) {
          console.warn(`${MODULE_ID} | session-close cleanup`, error);
        }
      }
      break;
    case MERCHANT_EVENTS.SESSION_RESUME_REQUEST:
      if (isAuthoritativeGM()) {
        try {
          handleSessionResumeRequest(payload);
        } catch (error) {
          console.error(`${MODULE_ID} | session-resume handler`, error);
        }
      }
      break;
    case MERCHANT_EVENTS.SHOP_LIST_REQUEST:
      if (isAuthoritativeGM()) {
        try {
          handleShopListRequest(payload);
        } catch (error) {
          console.error(`${MODULE_ID} | shop-list-request handler`, error);
        }
      }
      break;
    case MERCHANT_EVENTS.SHOP_REQUEST:
      if (isAuthoritativeGM()) {
        try {
          await handleShopRequest(payload);
        } catch (error) {
          console.error(`${MODULE_ID} | shop-request handler`, error);
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
  if (!session) {
    // Most common after a GM world reload (the in-memory session map is wiped):
    // tell the buyer so they don't sit on a silently-unrecorded purchase.
    emitCommitResult(payload, false, "no-session");
    return;
  }
  if (session.viewerUserId !== payload.originUserId) return;
  const requested = Math.max(1, Math.floor(Number(qty) || 1));
  const clientTotalGp = Math.max(0, Number(payload.totalGp) || 0);

  await runWithMerchantMutex(session.merchantId, async () => {
    const merchant = findMerchant(session.merchantId);
    if (!merchant) {
      console.warn(
        `${MODULE_ID} | commit-purchase: merchant ${session.merchantId} is gone`,
      );
      emitCommitResult(payload, false, "merchant-gone");
      return;
    }
    const row = merchant.items.find((r) => r.uuid === itemUuid);
    if (!row) {
      emitCommitResult(payload, false, "item-unavailable");
      return;
    }
    // Reject an oversell BEFORE burning the seal or charging. If finite stock
    // can't cover the request — a concurrent buyer took the last unit while
    // this commit waited on the mutex — the sale didn't happen on the
    // merchant's side. Tell the buyer (their sheet already changed) instead of
    // silently charging the merchant for stock it never had and double-selling
    // one unit. The buyer's _onCommitResult then prompts them to reconcile.
    if (!row.unlimited && row.qty < requested) {
      console.warn(
        `${MODULE_ID} | commit-purchase: "${itemUuid}" stock ${row.qty} < ${requested} (out of stock) — rejecting`,
      );
      emitCommitResult(payload, false, "out-of-stock");
      return;
    }
    // Verify + burn the bargain seal here (inside the mutex) and keep its
    // delta for the GM-side reprice. A missing/expired seal simply prices at
    // base (resolveUnitBuyPrice ignores a null seal) — but say so.
    const seal = sealId
      ? consumeSeal(sessionId, sealId, { itemUuid, side: "buy" })
      : null;
    if (sealId && !seal) {
      console.warn(
        `${MODULE_ID} | commit-purchase: seal "${sealId}" not found/expired — pricing at base`,
      );
    }

    // Recompute the price from the merchant's OWN data — never trust the
    // client's claimed total. The merchant's gold gain uses this server
    // figure, so a buggy/forged client can't shortchange (or overpay) it.
    let trueTotal = clientTotalGp;
    try {
      const itemDoc = await fromUuid(itemUuid);
      const item = itemDoc?.toObject?.() ?? itemDoc ?? null;
      // Re-derive the passive haggle nudge from the buyer's own actor so the
      // GM price matches what the player paid (a seal supersedes it inside
      // resolveUnitBuyPrice, so this is a no-op when an active bargain sealed).
      const passivePct = computePassiveBargainPct(
        merchant,
        resolveSessionActor(session),
      );
      const unitGp = resolveUnitBuyPrice({
        merchant,
        row,
        item,
        seal,
        passivePct,
      });
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
    // Finite stock is guaranteed sufficient here (oversell rejected above),
    // so the decrement always applies; unlimited rows never decrement.
    if (!row.unlimited) {
      try {
        updated = decrementInventory(updated, itemUuid, requested);
      } catch (error) {
        console.warn(`${MODULE_ID} | decrement failed`, error);
      }
    }
    // The merchant gains the gold the player paid (no-op if unlimited purse).
    updated = adjustMerchantGold(updated, trueTotal);
    await upsertMerchant(updated);
    await broadcastState(updated);
    emitCommitResult(payload, true);
  });
}

async function handleCommitSale(payload) {
  const { sessionId, sealId, itemUuid } = payload;
  const session = getSession(sessionId);
  if (!session) {
    emitCommitResult(payload, false, "no-session");
    return;
  }
  if (session.viewerUserId !== payload.originUserId) return;
  const clientTotalGp = Math.max(0, Number(payload.totalGp) || 0);
  const requested = Math.max(1, Math.floor(Number(payload.qty) || 1));
  // Sales don't change stock, but the merchant pays out — spend its gold
  // (clamped at 0; no-op if the purse is unlimited). Seal consumption runs
  // inside the mutex too, matching the buy path.
  await runWithMerchantMutex(session.merchantId, async () => {
    const merchant = findMerchant(session.merchantId);
    if (!merchant) {
      console.warn(
        `${MODULE_ID} | commit-sale: merchant ${session.merchantId} is gone`,
      );
      emitCommitResult(payload, false, "merchant-gone");
      return;
    }
    const seal = sealId
      ? consumeSeal(sessionId, sealId, { itemUuid, side: "sell" })
      : null;
    if (sealId && !seal) {
      console.warn(
        `${MODULE_ID} | commit-sale: seal "${sealId}" not found/expired`,
      );
    }
    // Recompute the payout from the item snapshot the player sent (the item is
    // already removed from their sheet, so we can't fromUuid it). The sold item
    // is inherently player-side data, but recomputing catches display drift /
    // honest client bugs, and adjustMerchantGold floors the purse at 0 so a
    // stale/forged total can't drive the coffer to a wrong value. Falls back to
    // the client total only when no usable snapshot was sent.
    let trueTotal = clientTotalGp;
    const snap = payload.itemSnapshot;
    if (snap && typeof snap === "object") {
      try {
        const passivePct = computePassiveBargainPct(
          merchant,
          resolveSessionActor(session),
        );
        const unitGp = resolveUnitSellPrice({
          merchant,
          item: snap,
          seal,
          passivePct,
        });
        if (unitGp > 0) trueTotal = roundGp(unitGp * requested);
      } catch (error) {
        console.warn(`${MODULE_ID} | commit-sale reprice failed`, error);
      }
    }
    if (Math.abs(trueTotal - clientTotalGp) > 0.01) {
      console.warn(
        `${MODULE_ID} | commit-sale price mismatch (client ${clientTotalGp}, server ${trueTotal}) — using server price`,
      );
    }
    if (!merchantCanAfford(merchant, trueTotal)) {
      console.warn(
        `${MODULE_ID} | commit-sale: payout ${trueTotal} exceeds merchant gold ${merchant.goldOnHand} (concurrent/stale sell) — floored at 0`,
      );
    }
    const updated = adjustMerchantGold(merchant, -trueTotal);
    await upsertMerchant(updated);
    await broadcastState(updated);
    emitCommitResult(payload, true);
  });
}

/**
 * Resolve the actor a session's viewer is shopping as — mirrors the player
 * client's `resolvePlayerActor` (assigned character, else first owned
 * character) so the GM can re-derive the same passive haggle nudge.
 */
function resolveSessionActor(session) {
  const userId = session?.viewerUserId;
  if (!userId) return null;
  const users = globalThis.game?.users;
  const user = users?.get?.(userId);
  if (!user) return null;
  if (user.character) return user.character;
  const actors = globalThis.game?.actors;
  return (
    actors?.find?.(
      (a) => a?.type === "character" && a?.testUserPermission?.(user, "OWNER"),
    ) ?? null
  );
}

async function broadcastState(merchant) {
  if (!merchant) return;
  emitMerchantEvent(MERCHANT_EVENTS.STATE_UPDATE, {
    merchantId: merchant.id,
    merchant: normalizeMerchant(merchant),
  });
}

/**
 * Atomically read-modify-write an existing merchant under its per-merchant
 * mutex, then optionally broadcast the new state to open player windows.
 *
 * GM-facing edits (the Merchant Workspace) must go through this so they
 * serialize against the player commit handlers, which already hold the same
 * lock. Mutating outside the lock is a lost-update race: a GM restock/edit and
 * a concurrent player purchase both read the same snapshot and the last writer
 * silently clobbers the other (e.g. a stock decrement reverted to full).
 *
 * The mutator receives the FRESH record loaded inside the lock — not a stale
 * one captured earlier — and returns the next record (or a falsy value to
 * abort with no write). Returns the saved record, or null if aborted/missing.
 */
export async function commitMerchantWrite(
  merchantId,
  mutator,
  { broadcast = false } = {},
) {
  return runWithMerchantMutex(merchantId, async () => {
    const current = findMerchant(merchantId);
    if (!current) return null;
    const next = await mutator(current);
    if (!next) return null;
    await upsertMerchant(next);
    if (broadcast) await broadcastState(next);
    return next;
  });
}

/** Acknowledge a commit back to the buyer/seller so a trade can't silently
 *  half-complete (actor mutated, shop never updated) without the player knowing.
 *  Scoped to the originating user; correlated by the player's commitId. */
function emitCommitResult(commitPayload, ok, reason = "") {
  emitMerchantEvent(MERCHANT_EVENTS.COMMIT_RESULT, {
    targetUserId: commitPayload.originUserId,
    sessionId: commitPayload.sessionId,
    commitId: commitPayload.commitId ?? null,
    side: commitPayload.type === MERCHANT_EVENTS.COMMIT_SALE ? "sell" : "buy",
    ok: ok === true,
    reason,
  });
}

/* ------------------------------------------------------------------ *
 * Player-initiated shop access (GM-authoritative)
 * ------------------------------------------------------------------ */

/**
 * A player asked for their shop list. Reply with a SANITIZED projection of only
 * the merchants they may self-open — never the raw world records (gold, markups,
 * overrides, allow-lists). canSelfOpen is the single gate (allowed + reachable).
 *
 * NB: like SESSION_OPEN / STATE_UPDATE, the reply is world-broadcast and scoped
 * client-side by targetUserId; the projection is the actual privacy guard. The
 * underlying MERCHANTS setting is world-scoped (every client can already read
 * the full raw records), so this is strictly the least-leaky path in the file.
 */
function handleShopListRequest(payload) {
  const userId = payload.originUserId;
  if (!isActiveNonGm(userId)) return;
  const shops = loadMerchants()
    .filter((merchant) => canSelfOpen(merchant, userId))
    .map(sanitizeMerchantForList);
  emitMerchantEvent(MERCHANT_EVENTS.SHOP_LIST_REPLY, {
    targetUserId: userId,
    shops,
  });
}

/**
 * A player asked to open a shop on their own initiative. Re-validate GM-side
 * (never trust the client), then "open" walks in immediately while "knock"
 * routes to GM approval. A disallowed user, a GM requester, an off/missing
 * shop, or an offline claimed origin is rejected — canSelfOpen is the gate.
 * Rejections send the player a SHOP_RESULT so the click never dies silently.
 */
async function handleShopRequest(payload) {
  const userId = payload.originUserId;
  const merchantId = payload.merchantId;
  if (!isActiveNonGm(userId) || !merchantId) return;
  const merchant = findMerchant(merchantId);
  if (!merchant || !canSelfOpen(merchant, userId)) {
    console.warn(
      `${MODULE_ID} | shop-request rejected (user ${userId}, merchant ${merchantId})`,
    );
    emitShopResult(userId, merchantId, "unavailable");
    return;
  }
  // Already shopping here → just re-pop their window; don't re-prompt/re-toast.
  if (findSessionFor(merchant.id, userId)) {
    pushOpenSession({ merchant, targetUserIds: [userId] });
    return;
  }
  if (getSelfServiceMode(merchant) === "knock") {
    await requestKnockApproval(merchant, userId);
    return;
  }
  openSelfServiceSession(merchant, userId);
}

/** Open a self-service session for `userId`. Toasts the GM only when the
 *  session is genuinely new, so a re-click doesn't spam the GM. */
function openSelfServiceSession(merchant, userId) {
  const isNew = !findSessionFor(merchant.id, userId);
  const opened = pushOpenSession({ merchant, targetUserIds: [userId] });
  if (opened.length > 0 && isNew) notifyGmShopOpened(merchant, userId);
}

/** Non-blocking GM toast when a player self-opens a shop. Framed from the GM's
 *  side ("opened X for Y") rather than as a confident audit claim, since the
 *  requesting identity is client-asserted (Foundry's socket can't authenticate
 *  the sender). */
function notifyGmShopOpened(merchant, userId) {
  globalThis.ui?.notifications?.info?.(
    `${MODULE_ID}: opened ${merchant.name} for ${lookupUserName(userId)}.`,
  );
}

/** Player→GM requests assert their own origin id; trust it only when it maps to
 *  a currently-connected non-GM user. This blocks opening a session "as" an
 *  offline/forged id (it can't fully stop impersonating another *online* allowed
 *  player — that needs server-verified sockets — but caps the blast radius to
 *  shops that player is already allowed at). */
function isActiveNonGm(userId) {
  const user = userId ? globalThis.game?.users?.get?.(userId) : null;
  return Boolean(user && user.active && !user.isGM);
}

/** Player-targeted negative outcome so a rejected/declined click resolves
 *  visibly instead of dying silently. */
function emitShopResult(userId, merchantId, outcome) {
  emitMerchantEvent(MERCHANT_EVENTS.SHOP_RESULT, {
    targetUserId: userId,
    merchantId,
    outcome, // "denied" | "unavailable"
  });
}

/** Outstanding knock prompts, keyed `${userId}::${merchantId}`, so a spam-
 *  clicking (or scripted) player can't stack modal Approve/Deny dialogs. */
const knockPending = new Set();

/**
 * "knock" mode: a player requested entry; ask the GM to approve before opening.
 * Runs on the authoritative GM, so exactly one Approve/Deny prompt appears.
 * Fails safe — no dialog (headless), a decline, or revoked access never opens a
 * session — coalesces duplicate in-flight knocks, re-validates at approval time,
 * and tells the waiting player the outcome.
 */
async function requestKnockApproval(merchant, userId) {
  const who = lookupUserName(userId);
  const DialogV2 = globalThis.foundry?.applications?.api?.DialogV2;
  if (typeof DialogV2?.confirm !== "function") {
    globalThis.ui?.notifications?.info?.(
      `${MODULE_ID}: ${who} is knocking at ${merchant.name} (no approval dialog available).`,
    );
    emitShopResult(userId, merchant.id, "unavailable");
    return;
  }
  const pendingKey = `${userId}::${merchant.id}`;
  if (knockPending.has(pendingKey)) return; // a prompt is already open for this pair
  knockPending.add(pendingKey);
  let approved = false;
  try {
    approved = await DialogV2.confirm({
      window: {
        title: `${merchant.name} — Entry Request`,
        icon: "fa-solid fa-hand",
      },
      content: `<p><strong>${escapeHtml(who)}</strong> is knocking at <strong>${escapeHtml(merchant.name)}</strong>. Open a shopping session for them?</p>`,
      rejectClose: false,
    });
  } catch {
    approved = false;
  } finally {
    knockPending.delete(pendingKey);
  }
  if (!approved) {
    globalThis.ui?.notifications?.info?.(
      `${MODULE_ID}: turned ${who} away from ${merchant.name}.`,
    );
    emitShopResult(userId, merchant.id, "denied");
    return;
  }
  // Re-validate — access may have changed while the prompt was open.
  const fresh = findMerchant(merchant.id);
  if (!fresh || !canSelfOpen(fresh, userId)) {
    globalThis.ui?.notifications?.warn(
      `${MODULE_ID}: ${who} can no longer enter ${merchant.name}.`,
    );
    emitShopResult(userId, merchant.id, "unavailable");
    return;
  }
  openSelfServiceSession(fresh, userId);
}

function lookupUserName(userId) {
  return globalThis.game?.users?.get?.(userId)?.name ?? "A player";
}

/**
 * A (re)connecting player asked us to re-send whatever sessions are still open
 * for them. SESSION_OPEN is a one-shot broadcast with no replay, so a reload or
 * relog would otherwise lose the pushed buy/sell window even though the GM still
 * holds the session. Re-emit SESSION_OPEN for each of the requester's live
 * sessions — race-free, because the player only asks AFTER its own auto-open
 * subscriber is bound. A session whose merchant has since been deleted is
 * dropped instead of resurrecting a window for a shop that no longer exists.
 */
function handleSessionResumeRequest(payload) {
  const userId = payload.originUserId;
  if (!isActiveNonGm(userId)) return;
  let resumed = 0;
  for (const session of listSessions()) {
    if (session.viewerUserId !== userId) continue;
    const merchant = findMerchant(session.merchantId);
    if (!merchant) {
      closeSession(session.sessionId);
      continue;
    }
    emitMerchantEvent(MERCHANT_EVENTS.SESSION_OPEN, {
      sessionId: session.sessionId,
      merchantId: merchant.id,
      merchant: normalizeMerchant(merchant),
      targetUserId: userId,
      // A resume re-pop, not a fresh GM push — the player UI uses this to skip
      // replaying the shop-open chime on every reload/relog.
      resume: true,
    });
    resumed++;
  }
  if (resumed > 0) {
    console.log(
      `${MODULE_ID} | resumed ${resumed} session(s) for ${lookupUserName(userId)} on reconnect`,
    );
  }
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
  const allowed = Array.isArray(merchant.allowedUserIds)
    ? merchant.allowedUserIds
    : [];
  const sessionDescriptors = [];
  const skipped = [];
  for (const userId of ids) {
    // Push to any user on the merchant's allow-list — INCLUDING one holding an
    // Assistant-GM / elevated role. We deliberately do NOT reuse isUserAllowed
    // here (it rejects every Foundry GM-role user as a non-shopper): this is an
    // explicit GM-initiated push to a player the GM picked, and the receiving
    // client only opens the window for the user it's actually targeted at.
    if (!allowed.includes(userId)) {
      skipped.push(userId);
      continue;
    }
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
  console.log(
    `${MODULE_ID} | pushOpenSession "${merchant.name}": opened ${sessionDescriptors.length}/${ids.length}` +
      (skipped.length > 0
        ? ` (skipped not-allowed: ${skipped.join(", ")})`
        : ""),
  );
  return sessionDescriptors;
}

/**
 * Player→GM: ask the authoritative GM to re-send any sessions still open for
 * this user, so a reload/relog re-pops the buy/sell window. A no-op for a GM
 * (they don't auto-open live sessions) or when no GM is online to answer. Call
 * this only after the SESSION_OPEN subscriber is bound so the reply can't race
 * the listener.
 */
export function requestMerchantSessionResume() {
  const game = globalThis.game;
  if (!game?.user || game.user.isGM) return;
  if (!game.users?.activeGM) return;
  emitMerchantEvent(MERCHANT_EVENTS.SESSION_RESUME_REQUEST, {});
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
