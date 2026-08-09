/**
 * Infinity D&D5e — Merchant Socket
 *
 * GM ↔ player communication for the Merchant Workspace. Every payload
 * carries a `type` field — handlers filter by type and ignore the rest
 * (the audio module shares this socket name with its own type).
 *
 * Authority model:
 * - GM client owns the merchant store and the in-memory session map.
 * - The authoritative GM validates and applies actor mutations.
 * - Bargain *tier resolution* is GM-side so the merchant's DC + tier
 *   schedule are the source of truth (player can't fake a discount).
 * - Shop writes use a per-merchant mutex; wallet/inventory writes also use a
 *   per-actor mutex so transactions across different shops cannot race.
 *
 * Sensitive frames are recipient-scoped at the Foundry transport layer:
 * player requests go only to the authoritative GM, and replies/session state
 * go only to named viewers or peer-GM invalidation recipients. Receiver-side
 * target checks remain as defense in depth. Only the authoritative GM handles
 * player→GM messages, so a
 * multi-GM table doesn't trigger double writes.
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
import {
  executeBuy,
  executeSell,
  resolveUnitBuyPrice,
  resolveUnitSellPrice,
  rollbackBuyTransaction,
  rollbackSellTransaction,
} from "./transaction.js";
import { isSafeGpAmount } from "./currency.js";
import {
  computeBargainOutcome,
  computePassiveBargainPct,
  runBargain,
} from "./bargain.js";
import {
  closeSession,
  consumeSeal,
  findSessionFor,
  getBargain,
  getCommitResult,
  getSession,
  listSessions,
  openSession,
  recordBargain,
  recordCommitResult,
  runWithMerchantActorMutex,
  runWithMerchantMutex,
} from "./session-state.js";
import { projectMerchantForSession } from "./projection.js";
import {
  isMerchantAccessClosed,
  loadMerchantAccessState,
  saveMerchantAccessState,
} from "./global-access.js";
import { escapeHtml } from "../ui-util.js";
import {
  authoritativeGMId,
  authenticateSocketPayload,
  isActiveSocketUser,
  isAuthoritativeGM,
  isAuthoritativeGMSender,
  withAuthenticatedOrigin,
} from "../socket-authority.js";
import { isFullGM } from "../permissions.js";
import { isPrivilegedPrivateStateReady } from "../private-state.js";
import { loadDowntimeConfig } from "../downtime/store.js";
import { hasStolenGoodsIssuance } from "../downtime/stolen-ledger.js";

const MODULE_ID = "infinity-dnd5e";
const SOCKET_NAME = `module.${MODULE_ID}`;

function isPrivateStateAuthorityReady() {
  const liveFoundry = Boolean(
    globalThis.game?.ready && globalThis.JournalEntry?.create,
  );
  return Boolean(
    isAuthoritativeGM() && (!liveFoundry || isPrivilegedPrivateStateReady()),
  );
}

export const MERCHANT_EVENTS = Object.freeze({
  SESSION_OPEN: "merchant:session-open",
  SESSION_CLOSE: "merchant:session-close",
  // Player→GM on (re)connect: "re-send any sessions still open for me".
  // SESSION_OPEN is a one-shot delivery with no replay, so without this a
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
const PLAYER_TO_GM_TYPES = new Set([
  MERCHANT_EVENTS.SESSION_RESUME_REQUEST,
  MERCHANT_EVENTS.BARGAIN_RESULT,
  MERCHANT_EVENTS.COMMIT_PURCHASE,
  MERCHANT_EVENTS.COMMIT_SALE,
  MERCHANT_EVENTS.SHOP_LIST_REQUEST,
  MERCHANT_EVENTS.SHOP_REQUEST,
]);
const GM_TO_CLIENT_TYPES = new Set([
  MERCHANT_EVENTS.SESSION_OPEN,
  MERCHANT_EVENTS.BARGAIN_SEAL,
  MERCHANT_EVENTS.COMMIT_RESULT,
  MERCHANT_EVENTS.STATE_UPDATE,
  MERCHANT_EVENTS.SHOP_LIST_REPLY,
  MERCHANT_EVENTS.SHOP_RESULT,
]);

/**
 * Required-field rules per inbound type. `req` fields must be non-empty
 * strings; `num` fields, when present, must be finite numbers. Foundry's
 * transport-authenticated sender is checked separately; these rules harden the
 * protocol shape against malformed frames. Unlisted types are not
 * field-validated beyond their route and target contract.
 */
const PAYLOAD_RULES = Object.freeze({
  [MERCHANT_EVENTS.COMMIT_PURCHASE]: {
    req: ["sessionId", "itemUuid", "commitId"],
    num: ["qty", "totalGp"],
  },
  [MERCHANT_EVENTS.COMMIT_SALE]: {
    req: ["sessionId", "itemUuid", "commitId"],
    num: ["qty", "totalGp"],
  },
  [MERCHANT_EVENTS.BARGAIN_RESULT]: {
    req: ["sessionId", "itemUuid", "side"],
    num: ["rollTotal"],
  },
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
    if (
      typeof value !== "string" ||
      value.length === 0 ||
      value.length > MAX_FIELD_LEN
    ) {
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
  socket.on(SOCKET_NAME, (payload, senderUserId) =>
    receiveMerchantPayload(payload, senderUserId),
  );
  registered = true;
  return true;
}

/* ------------------------------------------------------------------ *
 * Send
 * ------------------------------------------------------------------ */

function normalizeRecipientIds(values) {
  const raw = Array.isArray(values) ? values : [values];
  return [
    ...new Set(
      raw
        .map((value) => (typeof value === "string" ? value.trim() : ""))
        .filter(Boolean),
    ),
  ];
}

function resolveOutgoingRecipients(type, payload, explicitRecipients) {
  if (explicitRecipients !== undefined) {
    return normalizeRecipientIds(explicitRecipients);
  }
  if (type === MERCHANT_EVENTS.SESSION_CLOSE) {
    return isAuthoritativeGM()
      ? normalizeRecipientIds(payload.targetUserId)
      : normalizeRecipientIds(authoritativeGMId());
  }
  if (PLAYER_TO_GM_TYPES.has(type)) {
    return normalizeRecipientIds(authoritativeGMId());
  }
  if (GM_TO_CLIENT_TYPES.has(type)) {
    return normalizeRecipientIds(payload.targetUserId);
  }
  return [];
}

/**
 * Emit a merchant event over Foundry's recipient-scoped socket transport.
 *
 * Player requests are routed to the authoritative GM; GM replies are routed to
 * `targetUserId`. The optional controls are internal/test conveniences used to
 * prevent duplicate local renders while sending one state projection per
 * viewer.
 */
export function emitMerchantEvent(
  type,
  data = {},
  {
    dispatchLocal = true,
    emitSocket = true,
    recipients: explicitRecipients,
  } = {},
) {
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
  const recipients = resolveOutgoingRecipients(
    type,
    payload,
    explicitRecipients,
  );
  const socket = globalThis.game?.socket;
  if (
    emitSocket &&
    recipients.length > 0 &&
    typeof socket?.emit === "function"
  ) {
    socket.emit(SOCKET_NAME, payload, { recipients });
  }
  if (dispatchLocal) {
    // Preserve optimistic/local UI behavior without relying on a server echo.
    dispatchToListeners(type, payload);
  }
  return payload;
}

/* ------------------------------------------------------------------ *
 * Receive
 * ------------------------------------------------------------------ */

export async function receiveMerchantPayload(payload, authenticatedSenderId) {
  if (!payload || typeof payload !== "object") return;
  if (!MERCHANT_TYPES.has(payload.type)) return;
  if (!isValidPayload(payload)) {
    console.warn(`${MODULE_ID} | dropped malformed ${payload.type} frame`);
    return;
  }

  // Foundry 13 supplies the authenticated sender as the second socket callback
  // argument. Payload-claimed identity is never sufficient for merchant
  // authority or access control.
  if (
    typeof authenticatedSenderId !== "string" ||
    !authenticatedSenderId.trim()
  ) {
    console.warn(
      `${MODULE_ID} | dropped unauthenticated ${payload.type} frame`,
    );
    return;
  }
  const senderId = authenticateSocketPayload(payload, authenticatedSenderId);
  if (!senderId) {
    console.warn(
      `${MODULE_ID} | dropped unauthenticated ${payload.type} frame`,
    );
    return;
  }
  // Suppress echo to self — we already dispatched locally on emit.
  if (senderId === globalThis.game?.user?.id) return;
  const fromAuthoritativeGM = isAuthoritativeGMSender(senderId);
  const clientDirected =
    GM_TO_CLIENT_TYPES.has(payload.type) ||
    (payload.type === MERCHANT_EVENTS.SESSION_CLOSE && fromAuthoritativeGM);
  const authorityDirected =
    PLAYER_TO_GM_TYPES.has(payload.type) ||
    (payload.type === MERCHANT_EVENTS.SESSION_CLOSE && !fromAuthoritativeGM);

  if (clientDirected) {
    const targetUserId =
      typeof payload.targetUserId === "string"
        ? payload.targetUserId.trim()
        : "";
    if (
      !fromAuthoritativeGM ||
      !targetUserId ||
      targetUserId !== globalThis.game?.user?.id
    ) {
      return;
    }
  } else if (authorityDirected) {
    if (!isPrivateStateAuthorityReady() || !isActiveSocketUser(senderId))
      return;
    if (
      payload.type === MERCHANT_EVENTS.SESSION_CLOSE &&
      payload.targetUserId !== senderId
    ) {
      return;
    }
  } else {
    return;
  }
  payload = withAuthenticatedOrigin(payload, senderId);

  dispatchToListeners(payload.type, payload);

  // GM-authority routes:
  switch (payload.type) {
    case MERCHANT_EVENTS.BARGAIN_RESULT:
      if (isPrivateStateAuthorityReady()) {
        try {
          await handleBargainResult(payload);
        } catch (error) {
          console.error(`${MODULE_ID} | bargain-result handler`, error);
        }
      }
      break;
    case MERCHANT_EVENTS.COMMIT_PURCHASE:
      if (isPrivateStateAuthorityReady()) {
        try {
          await handleCommitPurchase(payload);
        } catch (error) {
          console.error(`${MODULE_ID} | commit-purchase handler`, error);
        }
      }
      break;
    case MERCHANT_EVENTS.COMMIT_SALE:
      if (isPrivateStateAuthorityReady()) {
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
      if (isPrivateStateAuthorityReady() && payload.sessionId) {
        try {
          const session = getSession(payload.sessionId);
          if (session?.viewerUserId === senderId)
            closeSession(payload.sessionId);
        } catch (error) {
          console.warn(`${MODULE_ID} | session-close cleanup`, error);
        }
      }
      break;
    case MERCHANT_EVENTS.SESSION_RESUME_REQUEST:
      if (isPrivateStateAuthorityReady()) {
        try {
          handleSessionResumeRequest(payload);
        } catch (error) {
          console.error(`${MODULE_ID} | session-resume handler`, error);
        }
      }
      break;
    case MERCHANT_EVENTS.SHOP_LIST_REQUEST:
      if (isPrivateStateAuthorityReady()) {
        try {
          handleShopListRequest(payload);
        } catch (error) {
          console.error(`${MODULE_ID} | shop-list-request handler`, error);
        }
      }
      break;
    case MERCHANT_EVENTS.SHOP_REQUEST:
      if (isPrivateStateAuthorityReady()) {
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
  const { sessionId, itemUuid, side, skillId } = payload;
  const session = getSession(sessionId);
  if (!session) return;
  if (isMerchantAccessClosed()) {
    emitBargainFailure(payload, session, "no-session");
    return;
  }
  if (session.viewerUserId !== payload.originUserId) return;
  const merchant = findMerchant(session.merchantId);
  if (!merchant) return;
  if (!merchant.allowedSkills?.includes?.(skillId)) return;
  const actor = resolveSessionActor(session, payload.actorId);
  if (!actor) {
    emitBargainFailure(payload, session, "no-actor");
    return;
  }
  const tiers = buildMerchantBargainTiers(merchant);
  const rolled = await runBargain({
    actor,
    skillId,
    dc: merchant.bargainDC,
    tiers,
    advantage: merchant.bargainAdvantage,
    chatMessage: true,
  });
  if (!rolled.ok) {
    emitBargainFailure(payload, session, rolled.reason ?? "skill-roll-failed");
    return;
  }
  const outcome = computeBargainOutcome(
    rolled.rollTotal,
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
    ok: true,
    sessionId,
    itemUuid,
    side,
    sealId: seal.sealId,
    tier: seal.tier,
    deltaPct: seal.deltaPct,
    skillId,
    rollTotal: rolled.rollTotal,
    dc: merchant.bargainDC,
    targetUserId: session.viewerUserId,
  });
}

function emitBargainFailure(payload, session, reason) {
  emitMerchantEvent(MERCHANT_EVENTS.BARGAIN_SEAL, {
    ok: false,
    reason,
    sessionId: payload.sessionId,
    itemUuid: payload.itemUuid,
    side: payload.side,
    targetUserId: session.viewerUserId,
  });
}

async function handleCommitPurchase(payload) {
  const { sessionId, itemUuid, qty, sealId } = payload;
  let session = getSession(sessionId);
  if (!session || isMerchantAccessClosed()) {
    // Most common after a GM world reload (the in-memory session map is wiped):
    // tell the buyer so they don't sit on a silently-unrecorded purchase.
    emitCommitResult(payload, false, "no-session");
    return;
  }
  if (session.viewerUserId !== payload.originUserId) return;
  if (emitCachedCommitResult(payload)) return;
  const requested = Number(qty);
  if (!Number.isInteger(requested) || requested < 1 || requested > 9999) {
    emitCommitResult(payload, false, "invalid-quantity");
    return;
  }
  const clientTotalGp = Math.max(0, Number(payload.totalGp) || 0);
  let actor = resolveSessionActor(session, payload.actorId);
  if (!actor) {
    emitCommitResult(payload, false, "no-actor");
    return;
  }

  await runWithMerchantActorMutex(session.merchantId, actor.id, async () => {
    // The request can wait behind another transaction. Re-check the transient
    // session and GM authority after acquiring both locks so a GM handoff or a
    // closed/replaced session cannot mutate actor or merchant state.
    if (!isPrivateStateAuthorityReady()) {
      console.warn(
        `${MODULE_ID} | commit-purchase authority changed while waiting for the transaction lock`,
      );
      return;
    }
    const liveSession = getSession(sessionId);
    if (
      isMerchantAccessClosed() ||
      !liveSession ||
      liveSession.merchantId !== session.merchantId ||
      liveSession.viewerUserId !== payload.originUserId
    ) {
      emitCommitResult(payload, false, "no-session");
      return;
    }
    session = liveSession;
    const liveActor = resolveSessionActor(session, payload.actorId);
    if (!liveActor || liveActor.id !== actor.id) {
      emitCommitResult(payload, false, "no-actor");
      return;
    }
    actor = liveActor;

    if (emitCachedCommitResult(payload)) {
      return;
    }
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
    // merchant's side. Tell the buyer instead of mutating their actor or
    // double-selling one unit.
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
    const candidateSeal = sealId
      ? getBargain(sessionId, itemUuid, "buy")
      : null;
    const seal = candidateSeal?.sealId === sealId ? candidateSeal : null;
    if (sealId && !seal) {
      console.warn(
        `${MODULE_ID} | commit-purchase: seal "${sealId}" not found/expired — pricing at base`,
      );
    }

    // Recompute the price from the merchant's OWN data — never trust the
    // client's claimed total. The merchant's gold gain uses this server
    // figure, so a buggy/forged client can't shortchange (or overpay) it.
    // Default to 0 (NOT the client total): a free/unpriced/deleted row credits
    // nothing, and a reprice throw can't fall back to crediting an attacker's
    // arbitrary figure into the GM-owned coffer.
    let trueTotal = 0;
    let unitGp = 0;
    let invalidPrice = false;
    let item = null;
    let passivePct = 0;
    try {
      const itemDoc = await fromUuid(itemUuid);
      item = itemDoc?.toObject?.() ?? itemDoc ?? null;
      // Re-derive the passive haggle nudge from the buyer's own actor so the
      // GM price matches what the player paid (a seal supersedes it inside
      // resolveUnitBuyPrice, so this is a no-op when an active bargain sealed).
      passivePct = computePassiveBargainPct(merchant, actor);
      unitGp = resolveUnitBuyPrice({
        merchant,
        row,
        item,
        seal,
        passivePct,
      });
      const rawTotal = unitGp * requested;
      if (unitGp === 0) {
        trueTotal = 0;
      } else if (isSafeGpAmount(unitGp) && isSafeGpAmount(rawTotal)) {
        const rounded = roundGp(rawTotal);
        if (isSafeGpAmount(rounded)) trueTotal = rounded;
        else invalidPrice = true;
      } else {
        invalidPrice = true;
      }
    } catch (error) {
      console.warn(`${MODULE_ID} | commit-purchase reprice failed`, error);
    }
    if (Math.abs(trueTotal - clientTotalGp) > 0.01) {
      console.warn(
        `${MODULE_ID} | commit-purchase price mismatch (client ${clientTotalGp}, server ${trueTotal}) — using server price`,
      );
    }
    if (invalidPrice || !(trueTotal > 0)) {
      emitCommitResult(
        payload,
        false,
        invalidPrice ? "invalid-price" : "no-price",
      );
      return;
    }

    const actorResult = await executeBuy({
      actor,
      merchant,
      row,
      item,
      qty: requested,
      seal,
      passivePct,
      notify: false,
      operationId: `${sessionId}:${payload.commitId}:${actor.uuid ?? actor.id}:buy`,
    });
    if (!actorResult.ok) {
      emitCommitResult(
        payload,
        false,
        actorResult.reason ?? "actor-write-failed",
      );
      return;
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
    const persisted = await persistMerchantVerified(updated, "purchase");
    if (!persisted.ok) {
      console.error(
        `${MODULE_ID} | purchase merchant persistence was not confirmed`,
        persisted.error,
      );
      const rolledBack = await rollbackBuyTransaction(actor, actorResult);
      const merchantRolledBack = await restoreMerchantVerified(
        merchant,
        "purchase",
      );
      emitCommitResult(
        payload,
        false,
        rolledBack && merchantRolledBack
          ? "merchant-write-failed"
          : "compensation-failed",
      );
      return;
    }
    updated = persisted.merchant;
    if (seal) consumeSeal(sessionId, sealId, { itemUuid, side: "buy" });
    const recorded = recordCommitOutcome(payload, true, "", {
      totalGp: actorResult.totalGp,
      unitGp: actorResult.unitGp,
      qty: actorResult.qty,
      itemName: actorResult.itemName,
    });
    await broadcastStateBestEffort(updated, "purchase");
    emitMerchantEvent(MERCHANT_EVENTS.COMMIT_RESULT, recorded);
  });
}

async function handleCommitSale(payload) {
  const { sessionId, sealId, itemUuid } = payload;
  let session = getSession(sessionId);
  if (!session || isMerchantAccessClosed()) {
    emitCommitResult(payload, false, "no-session");
    return;
  }
  if (session.viewerUserId !== payload.originUserId) return;
  if (emitCachedCommitResult(payload)) return;
  const clientTotalGp = Math.max(0, Number(payload.totalGp) || 0);
  const requested = Number(payload.qty);
  if (!Number.isInteger(requested) || requested < 1 || requested > 9999) {
    emitCommitResult(payload, false, "invalid-quantity");
    return;
  }
  let actor = resolveSessionActor(session, payload.actorId);
  if (!actor) {
    emitCommitResult(payload, false, "no-actor");
    return;
  }
  // Sales don't change stock, but the merchant pays out. Finite purses are
  // checked before mutation; unlimited purses are a no-op. Seal consumption
  // runs inside the mutex too, matching the buy path.
  await runWithMerchantActorMutex(session.merchantId, actor.id, async () => {
    if (!isPrivateStateAuthorityReady()) {
      console.warn(
        `${MODULE_ID} | commit-sale authority changed while waiting for the transaction lock`,
      );
      return;
    }
    const liveSession = getSession(sessionId);
    if (
      isMerchantAccessClosed() ||
      !liveSession ||
      liveSession.merchantId !== session.merchantId ||
      liveSession.viewerUserId !== payload.originUserId
    ) {
      emitCommitResult(payload, false, "no-session");
      return;
    }
    session = liveSession;
    const liveActor = resolveSessionActor(session, payload.actorId);
    if (!liveActor || liveActor.id !== actor.id) {
      emitCommitResult(payload, false, "no-actor");
      return;
    }
    actor = liveActor;

    if (emitCachedCommitResult(payload)) {
      return;
    }
    const ownedItem = actor.items?.get?.(itemUuid) ?? null;
    if (!ownedItem) {
      emitCommitResult(payload, false, "no-target");
      return;
    }
    const merchant = findMerchant(session.merchantId);
    if (!merchant) {
      console.warn(
        `${MODULE_ID} | commit-sale: merchant ${session.merchantId} is gone`,
      );
      emitCommitResult(payload, false, "merchant-gone");
      return;
    }
    const candidateSeal = sealId
      ? getBargain(sessionId, itemUuid, "sell")
      : null;
    const seal = candidateSeal?.sealId === sealId ? candidateSeal : null;
    if (sealId && !seal) {
      console.warn(
        `${MODULE_ID} | commit-sale: seal "${sealId}" not found/expired`,
      );
    }
    // Recompute the payout from the actor's current embedded item. The client
    // total is advisory only; the authoritative GM owns pricing and mutation.
    let trueTotal = 0;
    let priced = false;
    let invalidPrice = false;
    const snap = ownedItem.toObject?.() ?? ownedItem;
    if (snap && typeof snap === "object") {
      try {
        const passivePct = computePassiveBargainPct(merchant, actor);
        const unitGp = resolveUnitSellPrice({
          merchant,
          item: snap,
          seal,
          passivePct,
        });
        const rawTotal = unitGp * requested;
        if (unitGp === 0) {
          trueTotal = 0;
        } else if (isSafeGpAmount(unitGp) && isSafeGpAmount(rawTotal)) {
          const rounded = roundGp(rawTotal);
          if (isSafeGpAmount(rounded)) {
            trueTotal = rounded;
            priced = true;
          } else {
            invalidPrice = true;
          }
        } else {
          invalidPrice = true;
        }
      } catch (error) {
        console.warn(`${MODULE_ID} | commit-sale reprice failed`, error);
      }
    }
    // Never debit the GM-owned coffer by a client-controlled figure: if the GM
    // couldn't derive a payout (missing/zero-price snapshot, forged frame),
    // reject rather than spending the client's claimed total.
    if (!priced) {
      emitCommitResult(
        payload,
        false,
        invalidPrice ? "invalid-price" : "no-price",
      );
      return;
    }
    if (Math.abs(trueTotal - clientTotalGp) > 0.01) {
      console.warn(
        `${MODULE_ID} | commit-sale price mismatch (client ${clientTotalGp}, server ${trueTotal}) — using server price`,
      );
    }
    // Clamp to what the merchant can actually pay (a concurrent/stale sell may
    // exceed the current purse); adjustMerchantGold also floors at 0.
    if (!merchantCanAfford(merchant, trueTotal)) {
      emitCommitResult(payload, false, "merchant-cannot-afford");
      return;
    }
    const payout = trueTotal;
    const passivePct = computePassiveBargainPct(merchant, actor);
    const actorResult = await executeSell({
      actor,
      merchant,
      ownedItem,
      qty: requested,
      seal,
      passivePct,
      notify: false,
      requiresFencing: hasStolenGoodsIssuance(
        loadDowntimeConfig(),
        actor.id,
        ownedItem.id,
      ),
    });
    if (!actorResult.ok) {
      emitCommitResult(
        payload,
        false,
        actorResult.reason ?? "actor-write-failed",
      );
      return;
    }
    let updated = adjustMerchantGold(merchant, -payout);
    const persisted = await persistMerchantVerified(updated, "sale");
    if (!persisted.ok) {
      console.error(
        `${MODULE_ID} | sale merchant persistence was not confirmed`,
        persisted.error,
      );
      const rolledBack = await rollbackSellTransaction(actor, actorResult);
      const merchantRolledBack = await restoreMerchantVerified(
        merchant,
        "sale",
      );
      emitCommitResult(
        payload,
        false,
        rolledBack && merchantRolledBack
          ? "merchant-write-failed"
          : "compensation-failed",
      );
      return;
    }
    updated = persisted.merchant;
    if (seal) consumeSeal(sessionId, sealId, { itemUuid, side: "sell" });
    const recorded = recordCommitOutcome(payload, true, "", {
      totalGp: actorResult.totalGp,
      unitGp: actorResult.unitGp,
      qty: actorResult.qty,
      itemName: actorResult.itemName,
    });
    await broadcastStateBestEffort(updated, "sale");
    emitMerchantEvent(MERCHANT_EVENTS.COMMIT_RESULT, recorded);
  });
}

/**
 * Resolve the actor a session's viewer is shopping as — mirrors the player
 * client's `resolvePlayerActor` (assigned character, else first owned
 * character) so the GM can re-derive the same passive haggle nudge.
 */
function resolveSessionActor(session, requestedActorId = null) {
  const userId = session?.viewerUserId;
  if (!userId) return null;
  const users = globalThis.game?.users;
  const user = users?.get?.(userId);
  if (!user) return null;
  if (requestedActorId) {
    const requested = globalThis.game?.actors?.get?.(requestedActorId);
    return userOwnsSessionActor(user, requested) ? requested : null;
  }
  const assignedId =
    typeof user.character === "string" ? user.character : user.character?.id;
  const assigned = assignedId
    ? (globalThis.game?.actors?.get?.(assignedId) ??
      (typeof user.character === "object" ? user.character : null))
    : null;
  if (userOwnsSessionActor(user, assigned)) return assigned;
  const actors = globalThis.game?.actors;
  return actors?.find?.((actor) => userOwnsSessionActor(user, actor)) ?? null;
}

/**
 * Resolve effective player ownership without letting an Assistant GM's role
 * grant access to every Actor or a stale User.character pointer override an
 * explicit permission downgrade.
 */
function userOwnsSessionActor(user, actor) {
  if (!user || actor?.type !== "character") return false;
  if (isFullGM(user)) return true;
  const ownerLevel = globalThis.CONST?.DOCUMENT_OWNERSHIP_LEVELS?.OWNER ?? 3;
  const ownership = actor.ownership ?? {};
  if (Object.hasOwn(ownership, user.id)) {
    return Number(ownership[user.id]) >= Number(ownerLevel);
  }
  const assignedId =
    typeof user.character === "string" ? user.character : user.character?.id;
  if (assignedId && String(assignedId) === String(actor.id)) return true;
  if (user.isGM === true) return false;
  if (Object.hasOwn(ownership, "default")) {
    return Number(ownership.default) >= Number(ownerLevel);
  }
  return actor.testUserPermission?.(user, "OWNER") === true;
}

async function broadcastState(merchant) {
  if (!merchant) return;
  const projected = projectMerchantForSession(merchant);
  const basePayload = {
    merchantId: merchant.id,
    merchant: projected,
  };

  // The GM workspace needs one local invalidation regardless of viewer count.
  emitMerchantEvent(MERCHANT_EVENTS.STATE_UPDATE, basePayload, {
    emitSocket: false,
  });

  // Send one recipient-scoped projection to each unique active viewer and one
  // invalidation to each peer full GM. A per-recipient payload keeps the
  // defense-in-depth target contract explicit without revealing who else has a
  // shop open. Peer GMs reload the canonical private-state record; they do not
  // treat this projection as their source of truth.
  const recipientIds = [
    ...new Set(
      [
        ...listSessions()
          .filter((session) => session.merchantId === merchant.id)
          .map((session) => session.viewerUserId),
        ...(
          globalThis.game?.users?.filter?.(
            (user) =>
              user?.active &&
              isFullGM(user) &&
              user.id !== globalThis.game?.user?.id,
          ) ?? []
        ).map((user) => user.id),
      ]
        .map((userId) => String(userId ?? "").trim())
        .filter(Boolean),
    ),
  ];
  for (const targetUserId of recipientIds) {
    emitMerchantEvent(
      MERCHANT_EVENTS.STATE_UPDATE,
      {
        ...basePayload,
        targetUserId,
      },
      { dispatchLocal: false },
    );
  }
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

/**
 * Bind an idempotency key to the complete mutation request. Fixed property
 * order plus normalized numbers makes this stable across transport retries
 * without relying on payload insertion order.
 */
function commitRequestFingerprint(commitPayload) {
  const rawQuantity = commitPayload.qty;
  const numericQuantity = Number(rawQuantity);
  const validQuantity =
    Number.isInteger(numericQuantity) &&
    numericQuantity >= 1 &&
    numericQuantity <= 9999;
  return JSON.stringify({
    version: 1,
    type: commitPayload.type ?? "",
    sessionId: commitPayload.sessionId ?? "",
    originUserId: commitPayload.originUserId ?? "",
    actorId: commitPayload.actorId ?? "",
    itemUuid: commitPayload.itemUuid ?? "",
    qty: validQuantity
      ? { valid: true, value: numericQuantity }
      : {
          valid: false,
          type: typeof rawQuantity,
          value: String(rawQuantity),
        },
    totalGp: Number(commitPayload.totalGp),
    sealId: commitPayload.sealId ?? "",
  });
}

function buildCommitResult(commitPayload, ok, reason = "", details = {}) {
  return {
    targetUserId: commitPayload.originUserId,
    sessionId: commitPayload.sessionId,
    commitId: commitPayload.commitId ?? null,
    side: commitPayload.type === MERCHANT_EVENTS.COMMIT_SALE ? "sell" : "buy",
    ok: ok === true,
    reason,
    requestFingerprint: commitRequestFingerprint(commitPayload),
    ...details,
  };
}

function recordCommitOutcome(commitPayload, ok, reason = "", details = {}) {
  const result = buildCommitResult(commitPayload, ok, reason, details);
  const recorded = recordCommitResult(
    commitPayload.sessionId,
    commitPayload.commitId,
    result,
  );
  return recorded ?? result;
}

/**
 * Return a cached result only when the commitId still names the exact same
 * request. A reused ID with different fields is rejected without replacing the
 * original cache entry or touching actor/shop state.
 */
function emitCachedCommitResult(commitPayload) {
  const prior = getCommitResult(
    commitPayload.sessionId,
    commitPayload.commitId,
  );
  if (!prior) return false;
  if (prior.requestFingerprint !== commitRequestFingerprint(commitPayload)) {
    emitMerchantEvent(
      MERCHANT_EVENTS.COMMIT_RESULT,
      buildCommitResult(commitPayload, false, "commit-id-conflict"),
    );
    return true;
  }
  emitMerchantEvent(MERCHANT_EVENTS.COMMIT_RESULT, prior);
  return true;
}

function merchantRecordsMatch(actual, expected) {
  if (!actual || !expected) return false;
  try {
    return (
      JSON.stringify(normalizeMerchant(actual)) ===
      JSON.stringify(normalizeMerchant(expected))
    );
  } catch {
    return false;
  }
}

/**
 * A store write can apply and still reject (for example, an after-write hook or
 * transport acknowledgement can fail). Canonical read-back is the authority:
 * roll the actor back only when the expected merchant record is not present.
 */
async function persistMerchantVerified(expected, operation) {
  let error = null;
  try {
    await upsertMerchant(expected);
  } catch (caught) {
    error = caught;
  }
  const merchant = findMerchant(expected?.id);
  const ok = merchantRecordsMatch(merchant, expected);
  if (ok && error) {
    console.warn(
      `${MODULE_ID} | ${operation} merchant write threw after canonical state was applied`,
      error,
    );
  }
  return { ok, merchant: ok ? normalizeMerchant(merchant) : null, error };
}

/** Restore the exact pre-transaction merchant after an unconfirmed write. */
async function restoreMerchantVerified(original, operation) {
  const restored = await persistMerchantVerified(
    original,
    `${operation} compensation`,
  );
  if (!restored.ok) {
    console.error(
      `${MODULE_ID} | ${operation} merchant compensation was not confirmed`,
      restored.error,
    );
  }
  return restored.ok;
}

async function broadcastStateBestEffort(merchant, operation) {
  try {
    await broadcastState(merchant);
  } catch (error) {
    console.error(
      `${MODULE_ID} | ${operation} state broadcast failed after commit`,
      error,
    );
  }
}

/** Acknowledge a commit back to the buyer/seller so a trade can't silently
 *  half-complete (actor mutated, shop never updated) without the player knowing.
 *  Scoped to the originating user; correlated by the player's commitId. */
function emitCommitResult(commitPayload, ok, reason = "", details = {}) {
  const result = recordCommitOutcome(commitPayload, ok, reason, details);
  emitMerchantEvent(MERCHANT_EVENTS.COMMIT_RESULT, result);
  return result;
}

/* ------------------------------------------------------------------ *
 * Player-initiated shop access (GM-authoritative)
 * ------------------------------------------------------------------ */

/**
 * A player asked for their shop list. Reply with a SANITIZED projection of only
 * the merchants they may self-open — never the raw world records (gold, markups,
 * overrides, allow-lists). canSelfOpen is the single gate (allowed + reachable).
 *
 * The reply is recipient-scoped to the authenticated requester and still
 * checked against targetUserId on receipt. The projection is an additional
 * least-privilege boundary if transport routing is ever bypassed.
 */
function handleShopListRequest(payload) {
  const userId = payload.originUserId;
  if (!isActiveNonGm(userId)) return;
  emitShopListForUser(userId);
}

function emitShopListForUser(userId) {
  const globallyClosed = isMerchantAccessClosed();
  const shops = globallyClosed
    ? []
    : loadMerchants()
        .filter((merchant) => canSelfOpen(merchant, userId))
        .map(sanitizeMerchantForList);
  emitMerchantEvent(MERCHANT_EVENTS.SHOP_LIST_REPLY, {
    targetUserId: userId,
    shops,
    globallyClosed,
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
  if (isMerchantAccessClosed()) {
    emitShopResult(userId, merchantId, "unavailable");
    return;
  }
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

/** Non-blocking GM toast when a player self-opens a shop. */
function notifyGmShopOpened(merchant, userId) {
  globalThis.ui?.notifications?.info?.(
    `${MODULE_ID}: opened ${merchant.name} for ${lookupUserName(userId)}.`,
  );
}

/** Player→GM requests carry a transport-authenticated origin id. Keep the
 *  active non-GM check as a second gate before opening any session. */
function isActiveNonGm(userId) {
  const user = userId ? globalThis.game?.users?.get?.(userId) : null;
  return Boolean(user && user.active && !isFullGM(user));
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
 * for them. SESSION_OPEN is a one-shot delivery with no replay, so a reload or
 * relog would otherwise lose the pushed buy/sell window even though the GM still
 * holds the session. Re-emit SESSION_OPEN for each of the requester's live
 * sessions — race-free, because the player only asks AFTER its own auto-open
 * subscriber is bound. A session whose merchant has since been deleted is
 * dropped instead of resurrecting a window for a shop that no longer exists.
 */
function handleSessionResumeRequest(payload) {
  const userId = payload.originUserId;
  if (!isActiveNonGm(userId)) return;
  if (isMerchantAccessClosed()) return;
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
      merchant: projectMerchantForSession(merchant),
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
 * entries and sends a session-open event to each target client so their
 * buy/sell window opens.
 */
export function pushOpenSession({ merchant, targetUserIds }) {
  if (!merchant) throw new Error("pushOpenSession needs merchant");
  if (isMerchantAccessClosed()) return [];
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
      merchant: projectMerchantForSession(merchant),
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

function activePlayerUsers() {
  const users = globalThis.game?.users;
  const values = Array.isArray(users)
    ? users
    : Array.isArray(users?.contents)
      ? users.contents
      : typeof users?.values === "function"
        ? [...users.values()]
        : [];
  return values.filter((user) => isActiveNonGm(user?.id));
}

/** Refresh every connected player's sanitized Shops list after a global gate
 * change. The boolean is the only global-state detail exposed to players. */
export function pushMerchantAccessRefresh() {
  const players = activePlayerUsers();
  for (const user of players) emitShopListForUser(user.id);
  return players.length;
}

/**
 * Persist the global lock before closing windows, then remember each currently
 * live merchant/viewer pair for a later restore. Repeating the operation while
 * already closed never overwrites the original snapshot with an empty list.
 */
export async function pushCloseAllMerchantSessions() {
  const current = loadMerchantAccessState();
  if (current.closed) {
    let closedCount = 0;
    for (const session of [...listSessions()]) {
      if (pushCloseSession(session.sessionId)) closedCount++;
    }
    pushMerchantAccessRefresh();
    return {
      alreadyClosed: true,
      closedCount,
      suspendedCount: current.suspendedSessions.length,
    };
  }

  const sessionPairs = listSessions().map(({ merchantId, viewerUserId }) => ({
    merchantId,
    viewerUserId,
  }));
  let saved = await saveMerchantAccessState({
    closed: true,
    suspendedSessions: sessionPairs,
  });

  // A session could have opened while the first private-state write awaited.
  // Once that write lands, the gate blocks new opens; merge any such session
  // into the saved restore snapshot before closing all live windows.
  const mergedPairs = [...saved.suspendedSessions];
  const pairKeys = new Set(
    mergedPairs.map((row) => `${row.merchantId}::${row.viewerUserId}`),
  );
  for (const { merchantId, viewerUserId } of listSessions()) {
    const key = `${merchantId}::${viewerUserId}`;
    if (pairKeys.has(key)) continue;
    pairKeys.add(key);
    mergedPairs.push({ merchantId, viewerUserId });
  }
  if (mergedPairs.length !== saved.suspendedSessions.length) {
    saved = await saveMerchantAccessState({
      closed: true,
      suspendedSessions: mergedPairs,
    });
  }

  let closedCount = 0;
  for (const session of [...listSessions()]) {
    if (pushCloseSession(session.sessionId)) closedCount++;
  }
  pushMerchantAccessRefresh();
  return {
    alreadyClosed: false,
    closedCount,
    suspendedCount: saved.suspendedSessions.length,
  };
}

/** Lift the global gate and recreate only the merchant/viewer pairs captured by
 * the matching close. Per-shop Open/Knock/Off modes were never changed. */
export async function pushReopenMerchantSessions() {
  const current = loadMerchantAccessState();
  if (!current.closed) {
    return { alreadyOpen: true, openedCount: 0, skippedCount: 0 };
  }

  const restoredSessionIds = [];
  let openedCount = 0;
  let skippedCount = 0;
  try {
    // Keep the snapshot until every restore attempt finishes. If the GM client
    // fails mid-restore, the private record still explains what was suspended.
    await saveMerchantAccessState({
      closed: false,
      suspendedSessions: current.suspendedSessions,
    });

    for (const pair of current.suspendedSessions) {
      const merchant = findMerchant(pair.merchantId);
      if (!merchant) {
        skippedCount++;
        continue;
      }
      const opened = pushOpenSession({
        merchant,
        targetUserIds: [pair.viewerUserId],
      });
      if (opened.length > 0) {
        openedCount++;
        restoredSessionIds.push(opened[0].sessionId);
      } else {
        skippedCount++;
      }
    }

    await saveMerchantAccessState({ closed: false, suspendedSessions: [] });
  } catch (error) {
    // Do not leave a partially restored set of windows after a failed durable
    // state write. Best-effort rollback returns to the same closed snapshot.
    for (const sessionId of restoredSessionIds) pushCloseSession(sessionId);
    try {
      await saveMerchantAccessState({
        closed: true,
        suspendedSessions: current.suspendedSessions,
      });
    } catch {}
    pushMerchantAccessRefresh();
    throw error;
  }

  pushMerchantAccessRefresh();
  return { alreadyOpen: false, openedCount, skippedCount };
}

function findAllSessionsFor(merchantId) {
  return listSessions().filter((session) => session.merchantId === merchantId);
}
