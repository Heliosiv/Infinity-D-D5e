/**
 * Infinity D&D5e — Merchant Socket
 *
 * GM ↔ player communication for the Merchant Workspace. The compatibility
 * router owns the one raw module listener and dispatches these event types.
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
  planDurableBuyActorTransaction,
  planDurableSellActorTransaction,
  resolveUnitBuyPrice,
  resolveUnitSellPrice,
  rollbackBuyTransaction,
  rollbackSellTransaction,
} from "./transaction.js";
import {
  merchantCommitRequestFingerprint,
  parseMerchantCommitId,
  planMerchantBuyTransaction,
  planMerchantSellTransaction,
} from "./transaction-ledger.js";
import { merchantTransactionCoordinator } from "./transaction-coordinator.js";
import { hasMerchantTabLeadership } from "./tab-leadership.js";
import { isSafeGpAmount } from "./currency.js";
import {
  computeBargainOutcome,
  computePassiveBargainPct,
  runBargain,
} from "./bargain.js";
import {
  closeSession,
  consumeReservedSeal,
  consumeSeal,
  findSessionFor,
  getBargain,
  getCommitResult,
  getSession,
  listSessions,
  openSession,
  recordBargain,
  recordCommitResult,
  releaseSealReservation,
  reserveSealForCommit,
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
  confirmInfinityDialog,
  isInfinityDialogAvailable,
} from "../dialog-contract.js";
import {
  authoritativeGMId,
  authenticateSocketPayload,
  isActiveSocketUser,
  isAuthoritativeGM,
  isAuthoritativeGMSender,
  withAuthenticatedOrigin,
} from "../socket-authority.js";
import {
  emitModuleSocketPayload,
  registerModuleSocketRoute,
} from "../socket-router.js";
import { isFullGM } from "../permissions.js";
import { isPrivilegedPrivateStateReady } from "../private-state.js";
import { loadDowntimeConfig } from "../downtime/store.js";
import { hasStolenGoodsIssuance } from "../downtime/stolen-ledger.js";

const MODULE_ID = "infinity-dnd5e";

function isPrivateStateAuthorityReady() {
  const liveFoundry = Boolean(
    globalThis.game?.ready && globalThis.JournalEntry?.create,
  );
  return Boolean(
    isAuthoritativeGM() &&
    (!liveFoundry ||
      (isPrivilegedPrivateStateReady() && hasMerchantTabLeadership())),
  );
}

function assertMerchantSessionWriteAuthority() {
  const liveFoundry = Boolean(
    globalThis.game && globalThis.JournalEntry?.create,
  );
  if (liveFoundry && (!isAuthoritativeGM() || !hasMerchantTabLeadership())) {
    const error = new Error(
      "Merchant sessions can only be changed by the active Merchant tab.",
    );
    error.code = "MERCHANT_SESSION_AUTHORITY_UNAVAILABLE";
    throw error;
  }
  return true;
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
  COMMIT_STATUS_REQUEST: "merchant:commit-status-request",
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
  MERCHANT_EVENTS.COMMIT_STATUS_REQUEST,
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
    optString: ["actorId", "sealId"],
  },
  [MERCHANT_EVENTS.COMMIT_SALE]: {
    req: ["sessionId", "itemUuid", "commitId"],
    num: ["qty", "totalGp"],
    optString: ["actorId", "sealId"],
  },
  [MERCHANT_EVENTS.COMMIT_STATUS_REQUEST]: {
    req: ["commitId"],
    longString: ["requestFingerprint"],
  },
  [MERCHANT_EVENTS.BARGAIN_RESULT]: {
    req: ["sessionId", "itemUuid", "side", "skillId"],
    optString: ["actorId"],
    enums: { side: ["buy", "sell"] },
    num: ["rollTotal"],
  },
  [MERCHANT_EVENTS.SESSION_CLOSE]: { req: ["sessionId"], num: [] },
  [MERCHANT_EVENTS.SHOP_REQUEST]: { req: ["merchantId"], num: [] },
});

const MAX_FIELD_LEN = 200;
const MAX_FINGERPRINT_LEN = 8192;

// Durable commits survive reloads, so an authenticated player must not be able
// to fill the private ledger simply by minting an unbounded stream of IDs. The
// limiter is deliberately per authenticated origin: one noisy player cannot
// prevent another player's trade from being prepared or replayed.
const DURABLE_COMMIT_BURST_LIMIT = 10;
const DURABLE_COMMIT_BURST_WINDOW_MS = 10_000;
const DURABLE_COMMIT_SUSTAINED_LIMIT = 30;
const DURABLE_COMMIT_SUSTAINED_WINDOW_MS = 60_000;
const DURABLE_COMMIT_INGRESS_BURST_LIMIT = 40;
const DURABLE_COMMIT_INGRESS_BURST_WINDOW_MS = 10_000;
const DURABLE_COMMIT_INGRESS_SUSTAINED_LIMIT = 120;
const DURABLE_COMMIT_INGRESS_SUSTAINED_WINDOW_MS = 60_000;
const BARGAIN_BURST_LIMIT = 5;
const BARGAIN_BURST_WINDOW_MS = 10_000;
const BARGAIN_SUSTAINED_LIMIT = 20;
const BARGAIN_SUSTAINED_WINDOW_MS = 60_000;
const CONTROL_PLANE_BURST_LIMIT = 20;
const CONTROL_PLANE_BURST_WINDOW_MS = 10_000;
const CONTROL_PLANE_SUSTAINED_LIMIT = 60;
const CONTROL_PLANE_SUSTAINED_WINDOW_MS = 60_000;
const CONTROL_PLANE_TYPES = new Set([
  MERCHANT_EVENTS.BARGAIN_RESULT,
  MERCHANT_EVENTS.SESSION_RESUME_REQUEST,
  MERCHANT_EVENTS.SHOP_LIST_REQUEST,
  MERCHANT_EVENTS.SHOP_REQUEST,
]);
const DURABLE_COMMIT_BLOCK_REASONS = new Set([
  "ledger-capacity",
  "unresolved-origin-cap",
  "unresolved-transaction-collision",
]);
const durableCommitAttempts = new Map();
const durableCommitIngress = new Map();
const bargainAttempts = new Map();
const controlPlaneIngress = new Map();
const malformedCloseAudit = new Map();
let merchantAccessOperationTail = Promise.resolve();

function consumeSlidingWindowLimit(
  store,
  originUserId,
  now,
  { burstLimit, burstWindowMs, sustainedLimit, sustainedWindowMs },
) {
  const userId = String(originUserId ?? "").trim();
  if (!userId) return false;
  const cutoff = now - sustainedWindowMs;
  const recent = (store.get(userId) ?? []).filter(
    (timestamp) => timestamp > cutoff,
  );
  const burstCutoff = now - burstWindowMs;
  const burstCount = recent.filter(
    (timestamp) => timestamp > burstCutoff,
  ).length;
  if (recent.length >= sustainedLimit || burstCount >= burstLimit) {
    store.set(userId, recent);
    return false;
  }
  recent.push(now);
  store.set(userId, recent);
  return true;
}

function consumeDurableCommitIngressLimit(originUserId, now = Date.now()) {
  return consumeSlidingWindowLimit(durableCommitIngress, originUserId, now, {
    burstLimit: DURABLE_COMMIT_INGRESS_BURST_LIMIT,
    burstWindowMs: DURABLE_COMMIT_INGRESS_BURST_WINDOW_MS,
    sustainedLimit: DURABLE_COMMIT_INGRESS_SUSTAINED_LIMIT,
    sustainedWindowMs: DURABLE_COMMIT_INGRESS_SUSTAINED_WINDOW_MS,
  });
}

function consumeBargainRateLimit(originUserId, now = Date.now()) {
  return consumeSlidingWindowLimit(bargainAttempts, originUserId, now, {
    burstLimit: BARGAIN_BURST_LIMIT,
    burstWindowMs: BARGAIN_BURST_WINDOW_MS,
    sustainedLimit: BARGAIN_SUSTAINED_LIMIT,
    sustainedWindowMs: BARGAIN_SUSTAINED_WINDOW_MS,
  });
}

function consumeControlPlaneIngressLimit(originUserId, now = Date.now()) {
  return consumeSlidingWindowLimit(controlPlaneIngress, originUserId, now, {
    burstLimit: CONTROL_PLANE_BURST_LIMIT,
    burstWindowMs: CONTROL_PLANE_BURST_WINDOW_MS,
    sustainedLimit: CONTROL_PLANE_SUSTAINED_LIMIT,
    sustainedWindowMs: CONTROL_PLANE_SUSTAINED_WINDOW_MS,
  });
}

function consumeMalformedCloseAuditLimit(originUserId, now = Date.now()) {
  return consumeSlidingWindowLimit(malformedCloseAudit, originUserId, now, {
    burstLimit: CONTROL_PLANE_BURST_LIMIT,
    burstWindowMs: CONTROL_PLANE_BURST_WINDOW_MS,
    sustainedLimit: CONTROL_PLANE_SUSTAINED_LIMIT,
    sustainedWindowMs: CONTROL_PLANE_SUSTAINED_WINDOW_MS,
  });
}

function runMerchantAccessOperation(operation) {
  const next = merchantAccessOperationTail
    .catch(() => undefined)
    .then(operation);
  merchantAccessOperationTail = next.catch(() => undefined);
  return next;
}

function consumeDurableCommitRateLimit(originUserId, now = Date.now()) {
  return consumeSlidingWindowLimit(durableCommitAttempts, originUserId, now, {
    burstLimit: DURABLE_COMMIT_BURST_LIMIT,
    burstWindowMs: DURABLE_COMMIT_BURST_WINDOW_MS,
    sustainedLimit: DURABLE_COMMIT_SUSTAINED_LIMIT,
    sustainedWindowMs: DURABLE_COMMIT_SUSTAINED_WINDOW_MS,
  });
}

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
  for (const key of rule.optString ?? []) {
    const value = payload[key];
    if (value == null) continue;
    if (
      typeof value !== "string" ||
      value.length === 0 ||
      value.length > MAX_FIELD_LEN
    ) {
      return false;
    }
  }
  for (const key of rule.longString ?? []) {
    const value = payload[key];
    if (
      typeof value !== "string" ||
      value.length === 0 ||
      value.length > MAX_FINGERPRINT_LEN
    ) {
      return false;
    }
  }
  for (const [key, allowed] of Object.entries(rule.enums ?? {})) {
    if (!allowed.includes(payload[key])) return false;
  }
  for (const key of rule.num ?? []) {
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
  if (registered) return true;
  if (
    !registerModuleSocketRoute({
      id: "merchant",
      eventTypes: MERCHANT_TYPES,
      receive: receiveMerchantPayload,
    })
  ) {
    return false;
  }
  registered = true;
  Promise.resolve(merchantTransactionCoordinator.register())
    .then(notifyDurableRecoveryReviews)
    .catch((error) =>
      console.error(
        `${MODULE_ID} | Merchant transaction recovery failed`,
        error,
      ),
    );
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
  if (
    emitSocket &&
    recipients.length > 0 &&
    typeof globalThis.game?.socket?.emit === "function"
  ) {
    emitModuleSocketPayload(payload, { recipients });
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
    const commitFrame =
      payload.type === MERCHANT_EVENTS.COMMIT_PURCHASE ||
      payload.type === MERCHANT_EVENTS.COMMIT_SALE;
    const controlFrame = CONTROL_PLANE_TYPES.has(payload.type);
    const statusFrame = payload.type === MERCHANT_EVENTS.COMMIT_STATUS_REQUEST;
    const closeFrame = payload.type === MERCHANT_EVENTS.SESSION_CLOSE;
    const senderId =
      typeof authenticatedSenderId === "string"
        ? authenticatedSenderId.trim()
        : "";
    const shouldWarn =
      statusFrame && senderId
        ? consumeDurableCommitIngressLimit(senderId)
        : closeFrame && senderId
          ? consumeMalformedCloseAuditLimit(senderId)
          : controlFrame && senderId
            ? consumeControlPlaneIngressLimit(senderId)
            : !commitFrame ||
              !senderId ||
              consumeDurableCommitRateLimit(senderId);
    if (shouldWarn) {
      console.warn(`${MODULE_ID} | dropped malformed ${payload.type} frame`);
    }
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

  // Bound authenticated control-plane work before local dispatch or any
  // response-producing handler. Durable commits/status have their own replay-
  // aware ingress bucket, and SESSION_CLOSE must always remain deliverable.
  if (
    CONTROL_PLANE_TYPES.has(payload.type) &&
    !consumeControlPlaneIngressLimit(senderId)
  ) {
    return;
  }

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
    case MERCHANT_EVENTS.COMMIT_STATUS_REQUEST:
      if (isPrivateStateAuthorityReady()) {
        handleDurableCommitStatusRequest(payload);
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
  const merchant = authorizedSessionMerchant(session);
  if (!merchant) {
    closeUnauthorizedSession(session);
    emitBargainFailure(payload, session, "no-session");
    return;
  }
  if (!merchant.allowedSkills?.includes?.(skillId)) return;
  const actor = resolveSessionActor(session, payload.actorId);
  if (!actor) {
    emitBargainFailure(payload, session, "no-actor");
    return;
  }
  const existingSeal = getBargain(sessionId, itemUuid, side);
  if (existingSeal) {
    emitMerchantEvent(MERCHANT_EVENTS.BARGAIN_SEAL, {
      ok: true,
      sessionId,
      itemUuid,
      side,
      sealId: existingSeal.sealId,
      tier: existingSeal.tier?.id ? { id: existingSeal.tier.id } : null,
      deltaPct: existingSeal.deltaPct,
      skillId,
      rollTotal: null,
      dc: merchant.bargainDC,
      targetUserId: session.viewerUserId,
    });
    return;
  }
  if (!consumeBargainRateLimit(payload.originUserId)) {
    emitBargainFailure(payload, session, "rate-limited");
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
  if (!isPrivateStateAuthorityReady()) return;
  const currentSession = getSession(payload.sessionId);
  const currentMerchant = currentSession
    ? authorizedSessionMerchant(currentSession)
    : null;
  const currentActor = currentSession
    ? resolveSessionActor(currentSession, payload.actorId)
    : null;
  if (
    !currentSession ||
    currentSession.viewerUserId !== payload.originUserId ||
    currentSession.merchantId !== merchant.id ||
    !currentMerchant ||
    !currentMerchant.allowedSkills?.includes?.(skillId) ||
    !currentActor ||
    currentActor.id !== actor.id ||
    isMerchantAccessClosed()
  ) {
    return;
  }
  if (!rolled.ok) {
    emitBargainFailure(
      payload,
      currentSession,
      rolled.reason ?? "skill-roll-failed",
    );
    return;
  }
  const currentTiers = buildMerchantBargainTiers(currentMerchant);
  const outcome = computeBargainOutcome(
    rolled.rollTotal,
    Number(currentMerchant.bargainDC) || 0,
    currentTiers,
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
    tier: seal.tier?.id ? { id: seal.tier.id } : null,
    deltaPct: seal.deltaPct,
    skillId,
    rollTotal: rolled.rollTotal,
    dc: currentMerchant.bargainDC,
    targetUserId: currentSession.viewerUserId,
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

function durableCommitIdentity(payload) {
  return {
    originUserId: payload.originUserId,
    commitId: payload.commitId,
    requestFingerprint: merchantCommitRequestFingerprint(payload),
  };
}

function durableSealClaim(
  payload,
  side,
  identity = durableCommitIdentity(payload),
) {
  if (!payload.sealId) return null;
  return {
    itemUuid: payload.itemUuid,
    side,
    originUserId: identity.originUserId,
    commitId: identity.commitId,
    requestFingerprint: identity.requestFingerprint,
  };
}

function outcomeContainsExactSeal(outcome, payload, identity) {
  const record = outcome?.record;
  if (
    !record ||
    record.originUserId !== identity.originUserId ||
    record.commitId !== identity.commitId ||
    record.requestFingerprint !== identity.requestFingerprint
  ) {
    return false;
  }
  const recordedSealId =
    record.request?.sealId ?? record.result?.sealId ?? null;
  return Boolean(payload.sealId && recordedSealId === payload.sealId);
}

function consumeDurableSealClaim(payload, side, identity, outcome) {
  const claim = durableSealClaim(payload, side, identity);
  if (!claim || !outcomeContainsExactSeal(outcome, payload, identity)) {
    return false;
  }
  return Boolean(consumeReservedSeal(payload.sessionId, payload.sealId, claim));
}

function releaseDefiniteUnusedSealClaim(payload, side, identity, outcome) {
  const claim = durableSealClaim(payload, side, identity);
  if (!claim) return false;
  if (
    outcome?.status === "error" ||
    outcome?.status === "authority-lost" ||
    outcome?.status === "unavailable" ||
    outcomeContainsExactSeal(outcome, payload, identity)
  ) {
    return false;
  }
  const canonical = merchantTransactionCoordinator.lookup(identity);
  if (outcomeContainsExactSeal(canonical, payload, identity)) return false;
  if (!["missing", "conflict"].includes(canonical.status)) {
    return false;
  }
  return releaseSealReservation(payload.sessionId, payload.sealId, claim);
}

function handleDurableCommitStatusRequest(payload) {
  if (!consumeDurableCommitIngressLimit(payload.originUserId)) return false;
  try {
    parseMerchantCommitId(payload.commitId);
  } catch {
    return false;
  }
  const outcome = merchantTransactionCoordinator.lookup({
    originUserId: payload.originUserId,
    commitId: payload.commitId,
    requestFingerprint: payload.requestFingerprint,
  });
  if (outcome.status !== "terminal") return false;
  void deliverDurableMerchantTerminalResult(outcome);
  return true;
}

const durableReviewNotices = new Set();

function notifyDurableRecoveryReviews(outcome) {
  if (!outcome || typeof outcome !== "object") return;
  if (outcome.status === "needs-review") {
    notifyDurableMerchantReview(outcome);
  }
  for (const result of outcome.results ?? []) {
    notifyDurableRecoveryReviews(result);
  }
}

function notifyDurableMerchantReview(outcome) {
  const record = outcome?.record;
  if (!outcome?.pinned || record?.stage !== "needs-review") return;
  if (durableReviewNotices.has(record.key)) return;
  durableReviewNotices.add(record.key);
  const merchantId = record.merchant?.merchantId ?? "unknown merchant";
  const actorId = record.actor?.actorId ?? "unknown actor";
  const itemId = record.request?.itemUuid ?? "unknown item";
  globalThis.ui?.notifications?.error?.(
    `Merchant transaction needs review (${merchantId}, ${actorId}, ${itemId}). Do not retry or edit these records until the transaction is reviewed.`,
    { permanent: true },
  );
}

async function resolveDurableCommitOutcome(
  payload,
  outcome,
  { drivePending = true } = {},
) {
  if (!outcome || outcome.status === "missing") return false;
  if (outcome.status === "terminal") {
    return deliverDurableMerchantTerminalResult(outcome);
  }
  if (outcome.status === "conflict") {
    emitMerchantEvent(
      MERCHANT_EVENTS.COMMIT_RESULT,
      buildCommitResult(payload, false, "commit-id-conflict"),
    );
    return true;
  }
  if (outcome.status === "compacted") {
    emitMerchantEvent(
      MERCHANT_EVENTS.COMMIT_RESULT,
      buildCommitResult(payload, false, "transaction-history-expired"),
    );
    return true;
  }
  if (outcome.status === "needs-review") {
    notifyDurableMerchantReview(outcome);
    if (outcome.pinned && outcome.record?.stage === "needs-review") {
      emitMerchantEvent(
        MERCHANT_EVENTS.COMMIT_RESULT,
        buildCommitResult(payload, false, "transaction-needs-review"),
      );
    }
    return true;
  }
  if (outcome.status === "blocked") {
    if (outcome.record) return true;
    const safeReason = DURABLE_COMMIT_BLOCK_REASONS.has(outcome.reason)
      ? outcome.reason
      : "transaction-busy";
    emitMerchantEvent(
      MERCHANT_EVENTS.COMMIT_RESULT,
      buildCommitResult(payload, false, safeReason),
    );
    return true;
  }
  if (outcome.status === "prepared" || outcome.status === "pending") {
    if (!drivePending) return true;
    const driven = await merchantTransactionCoordinator.drive(
      durableCommitIdentity(payload),
    );
    return resolveDurableCommitOutcome(payload, driven, {
      drivePending: false,
    });
  }
  // Unavailable private state, a lost authority fence, or a transient write
  // error is intentionally left unacknowledged. The player's exact persisted
  // request remains pending and can be reconciled safely.
  if (outcome.status === "error") {
    console.error(`${MODULE_ID} | durable Merchant transaction`, outcome.error);
  }
  return true;
}

/** Deliver an already-durable terminal result without driving or rewriting it. */
export async function deliverDurableMerchantTerminalResult(outcome) {
  if (outcome?.status !== "terminal" || !outcome.result) return false;
  if (outcome.merchant) {
    await broadcastStateBestEffort(outcome.merchant, "durable transaction");
  }
  emitMerchantEvent(MERCHANT_EVENTS.COMMIT_RESULT, outcome.result);
  return true;
}

function revalidateDurableCommitContext(
  payload,
  expectedMerchantId,
  expectedActorId,
) {
  if (!isPrivateStateAuthorityReady()) {
    return { ok: false, reason: "authority-lost" };
  }
  const session = getSession(payload.sessionId);
  if (
    isMerchantAccessClosed() ||
    !session ||
    session.merchantId !== expectedMerchantId ||
    session.viewerUserId !== payload.originUserId
  ) {
    return { ok: false, reason: "no-session" };
  }
  const merchant = authorizedSessionMerchant(session);
  if (!merchant || merchant.id !== expectedMerchantId) {
    closeUnauthorizedSession(session);
    return { ok: false, reason: "no-session" };
  }
  const actor = resolveSessionActor(session, payload.actorId);
  if (!actor || actor.id !== expectedActorId) {
    return { ok: false, reason: "no-actor" };
  }
  return { ok: true, session, actor, merchant };
}

async function buildDurableBuyRecord(
  payload,
  expectedMerchantId,
  expectedActorId,
  requestFingerprint,
) {
  const context = revalidateDurableCommitContext(
    payload,
    expectedMerchantId,
    expectedActorId,
  );
  if (!context.ok) return context;
  let { session, actor } = context;
  const merchant = findMerchant(expectedMerchantId);
  if (!merchant) return { ok: false, reason: "merchant-gone" };
  const row = merchant.items.find((entry) => entry.uuid === payload.itemUuid);
  if (!row) return { ok: false, reason: "item-unavailable" };
  const candidateSeal = payload.sealId
    ? getBargain(payload.sessionId, payload.itemUuid, "buy")
    : null;
  const seal = candidateSeal?.sealId === payload.sealId ? candidateSeal : null;
  if (payload.sealId && !seal) {
    return { ok: false, reason: "bargain-expired" };
  }
  let item;
  let actorPlan;
  try {
    const itemDocument = await globalThis.fromUuid?.(payload.itemUuid);
    item = itemDocument?.toObject?.() ?? itemDocument ?? null;
    const refreshed = revalidateDurableCommitContext(
      payload,
      expectedMerchantId,
      expectedActorId,
    );
    if (!refreshed.ok) return refreshed;
    ({ session, actor } = refreshed);
    actorPlan = planDurableBuyActorTransaction({
      actor,
      merchant,
      row,
      item,
      qty: Number(payload.qty),
      seal,
      passivePct: computePassiveBargainPct(merchant, actor),
      operationId: `${session.sessionId}:${payload.commitId}:${actor.uuid ?? actor.id}:buy`,
    });
  } catch (error) {
    console.warn(`${MODULE_ID} | durable purchase planning failed`, error);
    return { ok: false, reason: "no-price" };
  }
  if (!actorPlan.ok) return actorPlan;
  const clientTotalGp = Math.max(0, Number(payload.totalGp) || 0);
  if (Math.abs(actorPlan.totalGp - clientTotalGp) > 0.01) {
    return { ok: false, reason: "price-changed" };
  }
  let merchantAfter = merchant;
  if (!row.unlimited) {
    merchantAfter = decrementInventory(
      merchantAfter,
      payload.itemUuid,
      actorPlan.qty,
    );
  }
  merchantAfter = adjustMerchantGold(merchantAfter, actorPlan.totalGp);
  const record = planMerchantBuyTransaction({
    originUserId: payload.originUserId,
    commitId: payload.commitId,
    requestFingerprint,
    request: {
      sessionId: payload.sessionId,
      actorId: actor.id,
      merchantId: merchant.id,
      itemUuid: payload.itemUuid,
      qty: actorPlan.qty,
      unitGp: actorPlan.unitGp,
      totalGp: actorPlan.totalGp,
      sealId: seal?.sealId ?? null,
    },
    actor: actorPlan.actor,
    merchant: {
      merchantId: merchant.id,
      before: merchant,
      after: merchantAfter,
    },
    itemName: actorPlan.itemName,
  });
  return { ok: true, record, seal };
}

function buildDurableSaleRecord(
  payload,
  expectedMerchantId,
  expectedActorId,
  requestFingerprint,
) {
  const context = revalidateDurableCommitContext(
    payload,
    expectedMerchantId,
    expectedActorId,
  );
  if (!context.ok) return context;
  const { actor } = context;
  const merchant = findMerchant(expectedMerchantId);
  if (!merchant) return { ok: false, reason: "merchant-gone" };
  const ownedItem = actor.items?.get?.(payload.itemUuid) ?? null;
  if (!ownedItem) return { ok: false, reason: "no-target" };
  const candidateSeal = payload.sealId
    ? getBargain(payload.sessionId, payload.itemUuid, "sell")
    : null;
  const seal = candidateSeal?.sealId === payload.sealId ? candidateSeal : null;
  if (payload.sealId && !seal) {
    return { ok: false, reason: "bargain-expired" };
  }
  let actorPlan;
  try {
    actorPlan = planDurableSellActorTransaction({
      actor,
      merchant,
      ownedItem,
      qty: Number(payload.qty),
      seal,
      passivePct: computePassiveBargainPct(merchant, actor),
      requiresFencing: hasStolenGoodsIssuance(
        loadDowntimeConfig(),
        actor.id,
        ownedItem.id,
      ),
    });
  } catch (error) {
    console.warn(`${MODULE_ID} | durable sale planning failed`, error);
    return { ok: false, reason: "no-price" };
  }
  if (!actorPlan.ok) return actorPlan;
  if (!merchantCanAfford(merchant, actorPlan.totalGp)) {
    return { ok: false, reason: "merchant-cannot-afford" };
  }
  const clientTotalGp = Math.max(0, Number(payload.totalGp) || 0);
  if (Math.abs(actorPlan.totalGp - clientTotalGp) > 0.01) {
    return { ok: false, reason: "price-changed" };
  }
  const merchantAfter = adjustMerchantGold(merchant, -actorPlan.totalGp);
  const record = planMerchantSellTransaction({
    originUserId: payload.originUserId,
    commitId: payload.commitId,
    requestFingerprint,
    request: {
      sessionId: payload.sessionId,
      actorId: actor.id,
      merchantId: merchant.id,
      itemUuid: payload.itemUuid,
      qty: actorPlan.qty,
      unitGp: actorPlan.unitGp,
      totalGp: actorPlan.totalGp,
      sealId: seal?.sealId ?? null,
    },
    actor: actorPlan.actor,
    merchant: {
      merchantId: merchant.id,
      before: merchant,
      after: merchantAfter,
    },
    itemName: actorPlan.itemName,
  });
  return { ok: true, record, seal };
}

async function handleDurableMerchantCommit(payload, side) {
  // Bound even lookup/replay work. Over-limit frames are intentionally left
  // unacknowledged so an exact saved replay is never falsely declined; the
  // client retains it and can retry after the short ingress window.
  if (!consumeDurableCommitIngressLimit(payload.originUserId)) return;
  const identity = durableCommitIdentity(payload);
  const existing = merchantTransactionCoordinator.lookup(identity);
  if (existing.status === "compacted") {
    const claim = durableSealClaim(payload, side, identity);
    if (claim) consumeReservedSeal(payload.sessionId, payload.sealId, claim);
  }
  consumeDurableSealClaim(payload, side, identity, existing);
  if (await resolveDurableCommitOutcome(payload, existing)) return;

  // Only a genuinely new tuple consumes rate-limit budget. Replays and crash
  // recovery always remain available, even during a noisy-client burst.
  if (!consumeDurableCommitRateLimit(payload.originUserId)) {
    emitMerchantEvent(
      MERCHANT_EVENTS.COMMIT_RESULT,
      buildCommitResult(payload, false, "rate-limited"),
    );
    return;
  }

  const session = getSession(payload.sessionId);
  if (!session || isMerchantAccessClosed()) {
    emitMerchantEvent(
      MERCHANT_EVENTS.COMMIT_RESULT,
      buildCommitResult(payload, false, "no-session"),
    );
    return;
  }
  if (session.viewerUserId !== payload.originUserId) return;
  if (!authorizedSessionMerchant(session)) {
    closeUnauthorizedSession(session);
    emitMerchantEvent(
      MERCHANT_EVENTS.COMMIT_RESULT,
      buildCommitResult(payload, false, "no-session"),
    );
    return;
  }
  const requested = Number(payload.qty);
  if (!Number.isInteger(requested) || requested < 1 || requested > 9999) {
    emitMerchantEvent(
      MERCHANT_EVENTS.COMMIT_RESULT,
      buildCommitResult(payload, false, "invalid-quantity"),
    );
    return;
  }
  const actor = resolveSessionActor(session, payload.actorId);
  if (!actor) {
    emitMerchantEvent(
      MERCHANT_EVENTS.COMMIT_RESULT,
      buildCommitResult(payload, false, "no-actor"),
    );
    return;
  }

  let replayWhileLocked = null;
  const prepared = await runWithMerchantActorMutex(
    session.merchantId,
    actor.id,
    async () => {
      // A duplicate can arrive while waiting for the lock. Look it up again
      // before touching the transient session, and let the durable record win.
      const replay = merchantTransactionCoordinator.lookup(identity);
      if (replay.status !== "missing") {
        consumeDurableSealClaim(payload, side, identity, replay);
        replayWhileLocked =
          replay.status === "pending"
            ? await merchantTransactionCoordinator.drivePendingLocked(identity)
            : replay;
        return replayWhileLocked;
      }
      const planned =
        side === "buy"
          ? await buildDurableBuyRecord(
              payload,
              session.merchantId,
              actor.id,
              identity.requestFingerprint,
            )
          : buildDurableSaleRecord(
              payload,
              session.merchantId,
              actor.id,
              identity.requestFingerprint,
            );
      if (!planned?.ok) {
        return {
          status: "rejected",
          reason: planned?.reason ?? "transaction-plan-rejected",
          planningResult: planned,
        };
      }
      if (planned.seal) {
        const reserved = reserveSealForCommit(
          payload.sessionId,
          planned.seal.sealId,
          durableSealClaim(payload, side, identity),
        );
        if (!reserved.ok) {
          return {
            status: "rejected",
            reason: reserved.reason ?? "bargain-expired",
          };
        }
      }
      const persisted =
        await merchantTransactionCoordinator.persistPreparedAndDriveLocked(
          planned.record,
        );
      if (planned.seal) {
        const canonical = merchantTransactionCoordinator.lookup(identity);
        if (
          !consumeDurableSealClaim(payload, side, identity, persisted) &&
          !consumeDurableSealClaim(payload, side, identity, canonical)
        ) {
          releaseDefiniteUnusedSealClaim(payload, side, identity, persisted);
        }
      }
      return persisted;
    },
  );
  if (replayWhileLocked) {
    await resolveDurableCommitOutcome(payload, replayWhileLocked, {
      drivePending: false,
    });
    return;
  }
  if (prepared.status === "rejected") {
    if (prepared.reason !== "authority-lost") {
      emitMerchantEvent(
        MERCHANT_EVENTS.COMMIT_RESULT,
        buildCommitResult(
          payload,
          false,
          prepared.reason ?? "transaction-plan-rejected",
        ),
      );
    }
    return;
  }
  // Fresh plans already performed their first bounded drive while the existing
  // merchant+actor lock was held. Do not release and immediately reacquire the
  // same lock, which would let a queued GM edit interleave with that drive.
  await resolveDurableCommitOutcome(payload, prepared, { drivePending: false });
}

function isDurableMerchantCommitId(commitId) {
  try {
    parseMerchantCommitId(commitId);
    return true;
  } catch {
    return false;
  }
}

async function handleCommitPurchase(payload) {
  if (!isDurableMerchantCommitId(payload.commitId)) {
    if (!globalThis.JournalEntry?.create) {
      await handleLegacyCommitPurchase(payload);
      return;
    }
    emitCommitResult(payload, false, "invalid-commit-id");
    return;
  }
  await handleDurableMerchantCommit(payload, "buy");
}

async function handleLegacyCommitPurchase(payload) {
  const { sessionId, itemUuid, qty, sealId } = payload;
  let session = getSession(sessionId);
  if (!session || isMerchantAccessClosed()) {
    // Most common after a GM world reload (the in-memory session map is wiped):
    // tell the buyer so they don't sit on a silently-unrecorded purchase.
    emitCommitResult(payload, false, "no-session");
    return;
  }
  if (session.viewerUserId !== payload.originUserId) return;
  if (!authorizedSessionMerchant(session)) {
    closeUnauthorizedSession(session);
    emitCommitResult(payload, false, "no-session");
    return;
  }
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
    const merchant = authorizedSessionMerchant(session);
    if (!merchant) {
      closeUnauthorizedSession(session);
      emitCommitResult(payload, false, "no-session");
      return;
    }
    const liveActor = resolveSessionActor(session, payload.actorId);
    if (!liveActor || liveActor.id !== actor.id) {
      emitCommitResult(payload, false, "no-actor");
      return;
    }
    actor = liveActor;

    if (emitCachedCommitResult(payload)) {
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
  if (!isDurableMerchantCommitId(payload.commitId)) {
    if (!globalThis.JournalEntry?.create) {
      await handleLegacyCommitSale(payload);
      return;
    }
    emitCommitResult(payload, false, "invalid-commit-id");
    return;
  }
  await handleDurableMerchantCommit(payload, "sell");
}

async function handleLegacyCommitSale(payload) {
  const { sessionId, sealId, itemUuid } = payload;
  let session = getSession(sessionId);
  if (!session || isMerchantAccessClosed()) {
    emitCommitResult(payload, false, "no-session");
    return;
  }
  if (session.viewerUserId !== payload.originUserId) return;
  if (!authorizedSessionMerchant(session)) {
    closeUnauthorizedSession(session);
    emitCommitResult(payload, false, "no-session");
    return;
  }
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
    const merchant = authorizedSessionMerchant(session);
    if (!merchant) {
      closeUnauthorizedSession(session);
      emitCommitResult(payload, false, "no-session");
      return;
    }
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
/**
 * Resolve the canonical merchant only while the recorded viewer remains on its
 * current allow-list. Assistant GMs may shop when explicitly allowed; full GMs
 * use Preview and never inherit a player session.
 */
function authorizedSessionMerchant(session) {
  if (!session?.merchantId || !session?.viewerUserId) return null;
  const merchant = findMerchant(session.merchantId);
  const user = globalThis.game?.users?.get?.(session.viewerUserId);
  const allowed = Array.isArray(merchant?.allowedUserIds)
    ? merchant.allowedUserIds
    : [];
  if (!merchant || !user || isFullGM(user)) return null;
  return allowed.includes(session.viewerUserId) ? merchant : null;
}

function closeUnauthorizedSession(session) {
  if (!session?.sessionId) return false;
  try {
    return pushCloseSession(session.sessionId);
  } catch {
    return Boolean(closeSession(session.sessionId));
  }
}

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
  if (user.isGM === true) return false;
  if (Object.hasOwn(ownership, "default")) {
    return Number(ownership.default) >= Number(ownerLevel);
  }
  return actor.testUserPermission?.(user, "OWNER") === true;
}

async function broadcastState(merchant) {
  if (!merchant) return;

  // Saving access changes revokes stale live sessions immediately. Every
  // transaction boundary repeats this check, so a missed notification can
  // never preserve authorization.
  for (const session of [...listSessions()]) {
    if (session.merchantId !== merchant.id) continue;
    if (!authorizedSessionMerchant(session)) closeUnauthorizedSession(session);
  }

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

function buildCommitResult(commitPayload, ok, reason = "", details = {}) {
  return {
    targetUserId: commitPayload.originUserId,
    sessionId: commitPayload.sessionId,
    commitId: commitPayload.commitId ?? null,
    side: commitPayload.type === MERCHANT_EVENTS.COMMIT_SALE ? "sell" : "buy",
    ok: ok === true,
    reason,
    requestFingerprint: merchantCommitRequestFingerprint(commitPayload),
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
  if (
    prior.requestFingerprint !== merchantCommitRequestFingerprint(commitPayload)
  ) {
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
    `Opened ${merchant.name} for ${lookupUserName(userId)}.`,
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
  if (!isInfinityDialogAvailable("confirm")) {
    globalThis.ui?.notifications?.info?.(
      `${who} is knocking at ${merchant.name}. The approval dialog could not open; use Merchant Workspace to approve or decline the request.`,
    );
    emitShopResult(userId, merchant.id, "unavailable");
    return;
  }
  const pendingKey = `${userId}::${merchant.id}`;
  if (knockPending.has(pendingKey)) return; // a prompt is already open for this pair
  knockPending.add(pendingKey);
  let approved = false;
  try {
    approved = await confirmInfinityDialog({
      window: {
        title: `${merchant.name} — Entry Request`,
        icon: "fa-solid fa-hand",
      },
      content: `<p><strong>${escapeHtml(who)}</strong> is knocking at <strong>${escapeHtml(merchant.name)}</strong>. Open a shopping session for them?</p>`,
    });
  } finally {
    knockPending.delete(pendingKey);
  }
  // A prompt may outlive this tab's authority. The former leader must not
  // approve, deny, or create a session after another tab/GM takes over.
  if (!isPrivateStateAuthorityReady()) return;
  if (!approved) {
    globalThis.ui?.notifications?.info?.(
      `Turned ${who} away from ${merchant.name}. No shop session opened.`,
    );
    emitShopResult(userId, merchant.id, "denied");
    return;
  }
  // Re-validate — access may have changed while the prompt was open.
  const fresh = findMerchant(merchant.id);
  if (!fresh || !canSelfOpen(fresh, userId)) {
    globalThis.ui?.notifications?.warn(
      `${who} can no longer enter ${merchant.name}. Their shop session was closed.`,
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
    const merchant = authorizedSessionMerchant(session);
    if (!merchant) {
      closeUnauthorizedSession(session);
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
  assertMerchantSessionWriteAuthority();
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
  assertMerchantSessionWriteAuthority();
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
  assertMerchantSessionWriteAuthority();
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
export function pushCloseAllMerchantSessions() {
  return runMerchantAccessOperation(closeAllMerchantSessionsLocked);
}

async function closeAllMerchantSessionsLocked() {
  assertMerchantSessionWriteAuthority();
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

  const sessionPairs = [
    ...current.suspendedSessions,
    ...listSessions().map(({ merchantId, viewerUserId }) => ({
      merchantId,
      viewerUserId,
    })),
  ].filter(
    (row, index, rows) =>
      rows.findIndex(
        (candidate) =>
          candidate.merchantId === row.merchantId &&
          candidate.viewerUserId === row.viewerUserId,
      ) === index,
  );
  let saved = await saveMerchantAccessState({
    closed: true,
    suspendedSessions: sessionPairs,
  });
  assertMerchantSessionWriteAuthority();

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
    assertMerchantSessionWriteAuthority();
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
export function pushReopenMerchantSessions() {
  return runMerchantAccessOperation(reopenMerchantSessionsLocked);
}

async function reopenMerchantSessionsLocked() {
  assertMerchantSessionWriteAuthority();
  const current = loadMerchantAccessState();
  const interruptedReopen =
    current.closed === false && current.suspendedSessions.length > 0;
  if (!current.closed && !interruptedReopen) {
    return { alreadyOpen: true, openedCount: 0, skippedCount: 0 };
  }

  const restoredSessionIds = [];
  let openedCount = 0;
  let skippedCount = 0;
  try {
    // Keep the snapshot until every restore attempt finishes. If the GM client
    // fails mid-restore, the private record still explains what was suspended.
    if (current.closed) {
      await saveMerchantAccessState({
        closed: false,
        suspendedSessions: current.suspendedSessions,
      });
      assertMerchantSessionWriteAuthority();
    }

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
    assertMerchantSessionWriteAuthority();
  } catch (error) {
    // Do not leave a partially restored set of windows after a failed durable
    // state write. Best-effort rollback returns to the same closed snapshot.
    if (isAuthoritativeGM() && hasMerchantTabLeadership()) {
      for (const sessionId of restoredSessionIds) {
        try {
          pushCloseSession(sessionId);
        } catch {}
      }
      try {
        await saveMerchantAccessState({
          closed: true,
          suspendedSessions: current.suspendedSessions,
        });
      } catch {}
    }
    pushMerchantAccessRefresh();
    throw error;
  }

  pushMerchantAccessRefresh();
  return { alreadyOpen: false, openedCount, skippedCount };
}

function findAllSessionsFor(merchantId) {
  return listSessions().filter((session) => session.merchantId === merchantId);
}
