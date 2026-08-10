/**
 * Infinity D&D5e — MerchantSessionApp
 *
 * Player-facing buy/sell window. The GM opens a session for a player
 * via the Merchant Workspace; the player's client receives a
 * `session-open` event and pops this window with the merchant snapshot.
 *
 * The window submits idempotent requests to the authoritative GM, which owns
 * both actor and merchant writes. Acknowledgements are tracked before emission
 * and uncertain requests retry with the same transaction id.
 */

import {
  applyPreviewBuy,
  applyPreviewSell,
  buildMerchantBargainTiers,
  normalizeMerchant,
  roundGp,
  merchantCanAfford,
} from "./merchant/store.js";
import {
  resolveUnitBuyPrice,
  resolveUnitSellPrice,
  isSellable,
  postTransactionReceipt,
} from "./merchant/transaction.js";
import {
  MERCHANT_EVENTS,
  emitMerchantEvent,
  subscribe,
  requestMerchantSessionResume,
} from "./merchant/socket.js";
import { merchantCommitRequestFingerprint } from "./merchant/transaction-ledger.js";
import {
  computeBargainOutcome,
  computePassiveBargainPct,
  runBargain,
} from "./merchant/bargain.js";
import { itemMatchesBuyFilter } from "./merchant/buy-filter.js";
import { totalWalletGp, sanitizeWallet } from "./merchant/currency.js";
import {
  listMerchantPendingCommits,
  listMerchantPendingReviews,
  listMerchantPendingTerminalOutbox,
  newMerchantCommitId,
  presentMerchantPendingTerminalOutbox,
  persistMerchantPendingCommit,
  resendMerchantPendingCommits,
  settleMerchantPendingCommitResult,
} from "./merchant/client-pending.js";
import { formatCoinBreakdown } from "./loot/hoard-budget.js";
import { getItemRarity } from "./loot/tag-vocabulary.js";
import {
  bindRowDoubleClickOpen,
  openItemByUuid,
  resolveItemSnapshot,
  wireBackgroundImageFallback,
} from "./loot/loot-app-shared.js";
import {
  escapeHtml,
  prettyRarity,
  prettyBargainTier,
  friendlyTransactionError,
  notify,
} from "./ui-util.js";
import { SOUND_EVENTS, playModuleSound } from "./audio.js";
import { SETTING_KEYS, getSetting } from "./settings.js";
import {
  applyVisualPrefs,
  bindFocusRestoration,
  bindFullGmWindowGuard,
} from "./infinity-app.js";
import {
  captureScroll,
  restoreScroll,
  bindScrollTracking,
} from "./merchant/scroll.js";
import {
  confirmInfinityDialog,
  promptInfinityDialog,
} from "./dialog-contract.js";
import { isFullGM } from "./permissions.js";
import { authoritativeGMId } from "./socket-authority.js";

const MODULE_ID = "infinity-dnd5e";
const TEMPLATE_PATH = `modules/${MODULE_ID}/templates/merchant-session.hbs`;
const FALLBACK_ART = "icons/svg/shop.svg";
const FALLBACK_ITEM_IMAGE = "icons/svg/item-bag.svg";
// How long a live bargain waits for the GM's seal before giving up and
// re-enabling the row, so a never-returning seal (GM offline / session expired)
// can't leave the bargain button disabled forever.
const BARGAIN_SEAL_TIMEOUT_MS = 15000;
// How long to wait for the GM's commit acknowledgement before warning the player
// that a buy/sell may not have been recorded (e.g. the GM reloaded mid-trade).
const COMMIT_ACK_TIMEOUT_MS = 12000;
const terminalHandlingPromises = new Map();
const TERMINAL_SETTLEMENT_MEMORY = 100;
const PERSISTED_REVIEW_STATUS_WINDOW_MS = 750;
const surfacedPersistedReviewKeys = new Set();
let persistedReviewSurfaceTimer = null;

let preferredMerchantActorId = "";

/** Scroll panes whose position survives action re-renders. */
const SCROLL_TARGETS = [
  { key: "rows", selector: ".ms-rows" },
  { key: "log", selector: ".ms-log" },
];

function isStolenForFencing(item) {
  const data = item?.toObject?.() ?? item;
  return Boolean(data?.flags?.[MODULE_ID]?.stolen);
}

/** Keep only receipt-needed, JSON-safe bargain data in the reload queue. */
function pendingSealSnapshot(seal) {
  if (!seal) return null;
  return {
    sealId: seal.sealId,
    tier: seal.tier?.id ? { id: String(seal.tier.id) } : null,
    deltaPct: seal.deltaPct,
    rollTotal: seal.rollTotal,
    dc: seal.dc,
  };
}

const { ApplicationV2, HandlebarsApplicationMixin } = foundry.applications.api;

/** Map<sessionId, MerchantSessionApp> */
const instances = new Map();

export class MerchantSessionApp extends HandlebarsApplicationMixin(
  ApplicationV2,
) {
  static DEFAULT_OPTIONS = {
    id: "infinity-dnd5e-merchant-session",
    tag: "section",
    classes: ["infinity-dnd5e", "infinity-merchant-session"],
    window: {
      title: "Merchant",
      icon: "fa-solid fa-store",
      resizable: true,
    },
    position: { width: 720, height: 600 },
    actions: {
      // NB: not "tab" — that's a reserved ApplicationV2 action in Foundry v13
      // (routes to the built-in _onClickTab/changeTab, which needs a tab group
      // and throws "must pass both the tab and tab group identifier"). We drive
      // the buy/sell panels with our own re-render, so use a distinct name.
      selectTab: MerchantSessionApp._onTab,
      openItem: MerchantSessionApp._onOpenItem,
      buyN: MerchantSessionApp._onBuyN,
      sellN: MerchantSessionApp._onSellN,
      bargainBuy: MerchantSessionApp._onBargainBuy,
      bargainSell: MerchantSessionApp._onBargainSell,
    },
  };

  static PARTS = {
    body: { template: TEMPLATE_PATH },
  };

  /**
   * Open a session window. If one is already open for this sessionId,
   * focus it.
   */
  static open({
    sessionId,
    merchant,
    previewMode = false,
    previewActor = null,
  }) {
    if (!sessionId) return null;
    let app = instances.get(sessionId);
    if (!app) {
      app = new MerchantSessionApp({
        // Unique DOM id per session so a player can have two different
        // merchants open at once without an element-id collision.
        id: `infinity-dnd5e-merchant-session-${sessionId}`,
        sessionId,
        merchant: normalizeMerchant(merchant),
        previewMode,
        previewActor,
      });
      bindFocusRestoration(app);
      instances.set(sessionId, app);
    } else {
      app._merchant = normalizeMerchant(merchant);
      // Re-opening a GM preview re-runs the character chooser, so refresh the
      // preview actor on the reused instance — otherwise it keeps simulating
      // sell/bargain/passive-haggle against the originally chosen character.
      // Live sessions re-render off socket STATE_UPDATE broadcasts; the preview
      // sandbox has no socket, so force a re-render to reflect the new pick.
      if (previewMode) {
        app._previewActor = previewActor ?? app._previewActor;
      } else {
        app._rehydratePendingCommits();
      }
    }
    if (app.rendered) {
      app.bringToFront();
      if (previewMode) app.render(false);
    } else app.render(true);
    return app;
  }

  /** Close every open session window. Used on logout / merchant delete. */
  static closeSession(sessionId) {
    const app = instances.get(sessionId);
    if (!app) return false;
    app._closingFromExternal = true;
    app.close();
    return true;
  }

  constructor(options = {}) {
    super(options);
    this._sessionId = options.sessionId;
    this._merchant = normalizeMerchant(options.merchant);
    // GM Preview: a self-contained sandbox window. Buy/sell/bargain run
    // locally against this in-memory merchant clone — no socket, no chat, no
    // real merchant/actor writes — so the GM can see exactly how the shop
    // behaves without consequences.
    this._previewMode = options.previewMode === true;
    this._unbindFullGmWindowGuard = this._previewMode
      ? bindFullGmWindowGuard(this)
      : null;
    this._previewActor = options.previewActor ?? null;
    this._selectedActorId = this._previewMode
      ? ""
      : getPreferredMerchantActorId();
    this._activeTab = "buy";
    this._search = { buy: "", sell: "" };
    this._seals = new Map(); // `${itemRefId}::${side}` → seal
    this._buyQty = new Map(); // uuid → qty input value
    this._sellQty = new Map(); // itemId → qty input value
    this._log = []; // session-only transaction log
    this._spentGp = 0; // running total spent this session
    this._earnedGp = 0; // running total earned this session
    this._bargainPending = new Set();
    this._bargainTimers = new Map(); // sealKey → timeout id (seal-wait watchdog)
    this._pendingCommits = new Map(); // commitId → tracked request + watchdog
    this._pendingPersistenceBlocked = false;
    this._closingFromExternal = false;
    this._userConnectionHook =
      globalThis.Hooks?.on?.("userConnected", (user) => {
        if (!user?.isGM || !this.rendered) return;
        this.render(false);
      }) ?? null;

    this._title = `${this._previewMode ? "[Preview] " : ""}${this._merchant?.name ?? "Merchant"} — Shop`;

    this._unsubscribers = [];
    // Preview is self-contained: real session broadcasts must not bleed into
    // (or re-render) the sandbox, so skip every socket subscription.
    if (!this._previewMode) {
      this._unsubscribers.push(
        subscribe(MERCHANT_EVENTS.STATE_UPDATE, (payload) =>
          this._onStateUpdate(payload),
        ),
      );
      this._unsubscribers.push(
        subscribe(MERCHANT_EVENTS.BARGAIN_SEAL, (payload) =>
          this._onBargainSeal(payload),
        ),
      );
      this._unsubscribers.push(
        subscribe(MERCHANT_EVENTS.SESSION_CLOSE, (payload) => {
          if (payload?.sessionId !== this._sessionId) return;
          if (
            !payload.targetUserId ||
            payload.targetUserId !== globalThis.game?.user?.id
          ) {
            return;
          }
          this._closingFromExternal = true;
          this.close();
        }),
      );
    }
    if (!this._previewMode) this._rehydratePendingCommits();
  }

  get title() {
    return this._title ?? "Merchant";
  }

  /** Whether a full GM is online to authorize live shop actions. */
  get _hasAuthoritativeGM() {
    return Boolean(authoritativeGMId());
  }

  _blockOfflineAction() {
    if (this._previewMode || this._hasAuthoritativeGM) return false;
    playModuleSound(SOUND_EVENTS.WARNING_MUTED);
    ui.notifications?.warn(
      "No full GM is online. Nothing changed; retry after the GM reconnects.",
    );
    if (this.rendered) this.render(false);
    return true;
  }

  _onClose(options) {
    super._onClose?.(options);
    this._unbindFullGmWindowGuard?.();
    this._unbindFullGmWindowGuard = null;
    for (const fn of this._unsubscribers) {
      try {
        fn();
      } catch {}
    }
    this._unsubscribers = [];
    // Drop any in-flight bargain watchdogs so they can't fire after close.
    for (const timer of this._bargainTimers.values()) {
      try {
        globalThis.clearTimeout?.(timer);
      } catch {}
    }
    this._bargainTimers.clear();
    // …and any pending commit-ack watchdogs.
    for (const ctx of this._pendingCommits.values()) {
      try {
        globalThis.clearTimeout?.(ctx.timer);
      } catch {}
    }
    this._pendingCommits.clear();
    if (this._userConnectionHook != null) {
      try {
        globalThis.Hooks?.off?.("userConnected", this._userConnectionHook);
      } catch {}
      this._userConnectionHook = null;
    }
    instances.delete(this._sessionId);
    // Voluntary player close (not a sandbox preview, not a GM-pushed close):
    // tell the GM to drop the session record so its Active Sessions list stays
    // current. Unsubscribed above, so this window won't react to its own echo.
    if (!this._previewMode && !this._closingFromExternal && this._sessionId) {
      emitMerchantEvent(MERCHANT_EVENTS.SESSION_CLOSE, {
        sessionId: this._sessionId,
        targetUserId: globalThis.game?.user?.id ?? null,
      });
    }
  }

  _onStateUpdate(payload) {
    if (!payload || payload.merchantId !== this._merchant.id) return;
    this._merchant = normalizeMerchant(payload.merchant);
    this.render(false);
  }

  _onBargainSeal(payload) {
    if (!payload || payload.sessionId !== this._sessionId) return;
    if (
      !payload.targetUserId ||
      payload.targetUserId !== globalThis.game?.user?.id
    ) {
      return;
    }
    const key = `${payload.itemUuid}::${payload.side}`;
    if (payload.ok === false) {
      this._bargainPending.delete(key);
      const watchdog = this._bargainTimers.get(key);
      if (watchdog != null) globalThis.clearTimeout?.(watchdog);
      this._bargainTimers.delete(key);
      const message = friendlyTransactionError(payload.reason);
      this._appendLog("fail", `Bargain failed: ${message}`);
      ui.notifications?.warn(message);
      if (this.rendered) this.render(false);
      return;
    }
    this._seals.set(key, {
      sealId: payload.sealId,
      tier: payload.tier,
      deltaPct: Number(payload.deltaPct) || 0,
      rollTotal: payload.rollTotal,
      dc: payload.dc,
    });
    this._bargainPending.delete(key);
    const watchdog = this._bargainTimers.get(key);
    if (watchdog != null) {
      globalThis.clearTimeout?.(watchdog);
      this._bargainTimers.delete(key);
    }
    // A strictly negative delta is a win; 0 ("no change") is not celebrated.
    if (Number(payload.deltaPct) < 0) {
      playModuleSound(SOUND_EVENTS.MERCHANT_BARGAIN_WIN);
    } else {
      playModuleSound(SOUND_EVENTS.MERCHANT_BARGAIN_FAIL);
    }
    this._appendLog(
      "bargain",
      `Bargain: ${prettyBargainTier(payload.tier?.id)} · ${formatDelta(payload.deltaPct)}`,
    );
    // Flag the row for a one-shot celebration on the next render.
    this._justBargained = {
      refId: payload.itemUuid,
      side: payload.side,
      win: Number(payload.deltaPct) < 0,
    };
    this.render(false);
  }

  /** Restore this session's unresolved requests from the client setting. */
  _rehydratePendingCommits() {
    let records;
    try {
      records = listMerchantPendingCommits();
    } catch {
      this._pendingPersistenceBlocked = true;
      ui.notifications?.warn(
        "Saved merchant requests could not be checked. New trades will not be sent until this browser can read them safely.",
      );
      return false;
    }
    this._pendingPersistenceBlocked = false;
    const controlledActors = getControlledMerchantActors();
    for (const record of records) {
      if (record.payload.sessionId !== this._sessionId) continue;
      if (this._pendingCommits.has(record.commitId)) continue;
      const actor = resolvePlayerActor(
        record.payload.actorId,
        controlledActors,
      );
      this._trackCommit(record.commitId, {
        ...record.context,
        eventType: record.eventType,
        payload: record.payload,
        actor,
      });
    }
    return true;
  }

  /** Present one already-persisted terminal result owned by this exact app. */
  async _presentTerminalCommit(record, payload) {
    if (!record || payload?.sessionId !== this._sessionId) return false;
    const ctx = this._pendingCommits.get(record.commitId);
    if (!ctx) return false;
    globalThis.clearTimeout?.(ctx.timer);
    this._pendingCommits.delete(record.commitId);

    if (payload.ok === true) {
      const totalGp = roundGp(
        Number.isFinite(Number(payload.totalGp))
          ? Number(payload.totalGp)
          : record.context.totalGp,
      );
      const qty = Math.max(
        1,
        Math.floor(Number(payload.qty) || record.context.qty || 1),
      );
      const unitGp = roundGp(
        Number.isFinite(Number(payload.unitGp))
          ? Number(payload.unitGp)
          : totalGp / Math.max(1, qty),
      );
      const itemName = payload.itemName || record.context.itemName || "item";
      const acceptedSeal =
        payload.sealId && payload.sealId === record.payload.sealId
          ? record.context.seal
          : null;
      const receipt = await postTransactionReceipt({
        side: record.context.side,
        actor: ctx.actor,
        merchant: {
          id: record.context.merchantId,
          name: record.context.merchantName,
        },
        itemName,
        qty,
        unitGp,
        totalGp,
        bargainTier: acceptedSeal?.tier ?? null,
        rollTotal: acceptedSeal?.rollTotal ?? null,
        dc: acceptedSeal?.dc ?? null,
        worldId: record.worldId,
        originUserId: record.originUserId,
        commitId: record.commitId,
      });
      if (!receipt) {
        playModuleSound(SOUND_EVENTS.WARNING_MUTED);
        this._appendLog(
          "pending",
          `The ${record.context.side === "sell" ? "sale" : "purchase"} completed, but its receipt is still saved for retry.`,
        );
        ui.notifications?.warn(
          "The trade completed, but its receipt could not be posted. The receipt remains saved and will retry safely.",
        );
        if (this.rendered) this.render(false);
        return false;
      }
      if (record.context.side === "sell") {
        this._earnedGp = roundGp(this._earnedGp + totalGp);
        playModuleSound(SOUND_EVENTS.MERCHANT_SALE);
        this._appendLog(
          "sell",
          `Sold ${qty}x ${itemName} for ${totalGp.toFixed(2)} gp`,
        );
      } else {
        this._spentGp = roundGp(this._spentGp + totalGp);
        playModuleSound(SOUND_EVENTS.MERCHANT_PURCHASE);
        this._appendLog(
          "buy",
          `Bought ${qty}x ${itemName} for ${totalGp.toFixed(2)} gp`,
        );
      }
      if (ctx.sealKey) this._seals.delete(ctx.sealKey);
      if (this.rendered) this.render(false);
      return true;
    }

    playModuleSound(SOUND_EVENTS.WARNING_MUTED);
    if (payload.reason === "bargain-expired" && ctx.sealKey) {
      this._seals.delete(ctx.sealKey);
    }
    const verb = record.context.side === "sell" ? "sale" : "purchase";
    const reason = friendlyTransactionError(payload.reason);
    this._appendLog(
      "fail",
      `The shop declined your ${verb} of ${record.context.itemName}: ${reason}`,
    );
    ui.notifications?.warn(
      `The trade was not completed: ${reason} Review the message, then try again when ready.`,
    );
    if (this.rendered) this.render(false);
    return true;
  }

  /** Move one uncertain request out of live retry UI while retaining it. */
  _presentCommitReview(record, review) {
    if (!record || record.payload.sessionId !== this._sessionId) return false;
    const ctx = this._pendingCommits.get(record.commitId);
    if (!ctx) return false;
    globalThis.clearTimeout?.(ctx.timer);
    this._pendingCommits.delete(record.commitId);
    if (ctx.sealKey) this._seals.delete(ctx.sealKey);
    playModuleSound(SOUND_EVENTS.WARNING_MUTED);
    const detail = merchantReviewDetail(record);
    this._appendLog(
      "fail",
      `${detail} is uncertain and saved for explicit GM review. Do not retry it.`,
    );
    ui.notifications?.warn(merchantReviewWarning(record, review));
    if (this.rendered) this.render(false);
    return true;
  }

  /**
   * Another tab may win the shared client-setting settlement and present the
   * one receipt. An exact authenticated result still clears this tab's local
   * watchdog, but never posts a second receipt or changes campaign data.
   */
  _clearCommitHandledElsewhere(payload) {
    if (payload?.sessionId !== this._sessionId) return false;
    const ctx = this._pendingCommits.get(payload.commitId);
    if (!ctx) return false;
    const expectedFingerprint = merchantCommitRequestFingerprint({
      type: ctx.eventType,
      originUserId: payload.targetUserId,
      ...ctx.payload,
    });
    if (payload.requestFingerprint !== expectedFingerprint) return false;
    globalThis.clearTimeout?.(ctx.timer);
    this._pendingCommits.delete(payload.commitId);
    if (
      (payload.ok === true || payload.reason === "bargain-expired") &&
      ctx.sealKey
    ) {
      this._seals.delete(ctx.sealKey);
    }
    this._appendLog(
      payload.ok === true ? "pending" : "fail",
      "This trade result was already handled in another open tab.",
    );
    if (this.rendered) this.render(false);
    return true;
  }

  /** Save and verify an exact retry record before any commit leaves the client. */
  async _persistCommitRequest(eventType, payload, context) {
    try {
      const commitId = newMerchantCommitId();
      return await persistMerchantPendingCommit({
        worldId: globalThis.game?.world?.id,
        originUserId: globalThis.game?.user?.id,
        commitId,
        eventType,
        payload: { ...payload, commitId },
        context,
      });
    } catch {
      this._pendingPersistenceBlocked = true;
      playModuleSound(SOUND_EVENTS.WARNING_MUTED);
      this._appendLog(
        "fail",
        "Trade not sent — this browser could not save a safe retry record.",
      );
      ui.notifications?.warn(
        "The trade was not sent because this browser could not save it safely. Nothing changed; retry after local storage is available.",
      );
      if (this.rendered) this.render(false);
      return null;
    }
  }

  /** Register before emission so even a synchronous acknowledgement can find
   *  its context. A timeout stays retryable and can still accept a late ack. */
  _trackCommit(commitId, ctx) {
    const record = {
      ...ctx,
      payload: { ...(ctx.payload ?? {}) },
      timer: null,
      timedOut: false,
    };
    this._pendingCommits.set(commitId, record);
    this._armCommitWatchdog(commitId);
  }

  _armCommitWatchdog(commitId) {
    const ctx = this._pendingCommits.get(commitId);
    if (!ctx) return;
    globalThis.clearTimeout?.(ctx.timer);
    ctx.timedOut = false;
    const timer = globalThis.setTimeout?.(() => {
      const current = this._pendingCommits.get(commitId);
      if (!current) return;
      current.timer = null;
      current.timedOut = true;
      playModuleSound(SOUND_EVENTS.WARNING_MUTED);
      const verb = current.side === "sell" ? "sale" : "purchase";
      this._appendLog(
        "fail",
        `No response from the GM on your ${verb} of ${current.itemName} — the result is unconfirmed.`,
      );
      ui.notifications?.warn(
        `No response arrived from the GM on that ${verb}. Your character may have changed; click the same item once to retry the original confirmation safely.`,
      );
      if (this.rendered) this.render(false);
    }, COMMIT_ACK_TIMEOUT_MS);
    ctx.timer = timer;
  }

  /** Block rapid duplicates. An uncertain retry resends the exact request and
   *  commit id rather than creating a second trade. */
  _retryOrBlockPending(side, refId) {
    for (const [commitId, ctx] of this._pendingCommits) {
      if (ctx.side !== side || ctx.refId !== refId) continue;
      if (!ctx.timedOut) {
        ui.notifications?.info(
          "That trade is already waiting for the GM. Do not repeat it.",
        );
        return true;
      }
      this._armCommitWatchdog(commitId);
      this._appendLog(
        "pending",
        `Retrying the original confirmation for ${ctx.itemName}`,
      );
      emitMerchantEvent(ctx.eventType, ctx.payload);
      if (this.rendered) this.render(false);
      return true;
    }
    return false;
  }

  /* -------------------- context -------------------- */

  async _prepareContext() {
    const controlledActors = this._previewMode
      ? []
      : getControlledMerchantActors();
    let actor = this._previewMode
      ? this._previewActor
      : resolvePlayerActor(this._selectedActorId, controlledActors);
    if (
      !this._previewMode &&
      this._selectedActorId &&
      !controlledActors.some(
        (candidate) => String(candidate?.id ?? "") === this._selectedActorId,
      )
    ) {
      this._selectedActorId = "";
      setPreferredMerchantActorId("");
      actor = resolvePlayerActor("", controlledActors);
    }
    if (!this._previewMode && actor) {
      this._selectedActorId = String(actor.id ?? "");
    }
    const offline = !this._previewMode && !this._hasAuthoritativeGM;
    const wallet = sanitizeWallet(actor?.system?.currency);
    const walletLabel = actor
      ? formatCoinBreakdown(wallet) || `${totalWalletGp(wallet).toFixed(2)} gp`
      : "Choose a character";

    // Always-on passive haggle nudge from the shopper's best allowed social
    // skill. The action handlers recompute this from the actor so a buy/sell
    // prices identically to what's displayed here.
    const passivePct = computePassiveBargainPct(this._merchant, actor);

    const itemMap = await this._resolveMerchantItems();

    const buyRows = await Promise.all(
      this._merchant.items.map((row) =>
        this._buildBuyRow(
          row,
          itemMap.get(row.uuid) ?? null,
          wallet,
          passivePct,
        ),
      ),
    );

    for (const row of buyRows) {
      if (!offline) continue;
      row.cannotBuy = true;
      row.cannotBuyReason = "GM offline — nothing will be sent";
      row.bargainLocked = true;
    }
    if (!this._previewMode && !actor) {
      for (const row of buyRows) {
        row.cannotBuy = true;
        row.cannotBuyReason = "Choose a character first";
        row.bargainLocked = true;
      }
    }

    const sellRows = actor
      ? actor.items
          .filter((doc) => isSellable(doc) || isStolenForFencing(doc))
          // "Buys From Players" filter: only show what this merchant will buy.
          // Stolen goods stay visible as disabled rows so the player receives
          // the explicit fencing instruction instead of a silent omission.
          .filter(
            (doc) =>
              isStolenForFencing(doc) ||
              itemMatchesBuyFilter(this._merchant.buyFilter, doc),
          )
          .map((doc) => this._buildSellRow(doc, passivePct))
          .filter(Boolean)
      : [];

    if (offline) {
      for (const row of sellRows) {
        row.cannotSell = true;
        row.cannotSellReason = "GM offline — nothing will be sent";
        row.bargainLocked = true;
      }
    }

    const pending = [...this._pendingCommits.values()];
    const uncertain = pending.filter((entry) => entry.timedOut);
    const waiting = pending.filter((entry) => !entry.timedOut);
    for (const entry of pending) {
      const rows = entry.side === "sell" ? sellRows : buyRows;
      const row = rows.find((candidate) =>
        entry.side === "sell"
          ? candidate.itemId === entry.refId
          : candidate.uuid === entry.refId,
      );
      if (!row) continue;
      row.transactionWaiting = !entry.timedOut;
      row.transactionUncertain = entry.timedOut;
      row.bargainLocked = true;
      if (entry.side === "sell") {
        row.cannotSell = !entry.timedOut || offline;
        row.cannotSellReason = entry.timedOut
          ? offline
            ? "GM offline — confirmation is still uncertain"
            : "Unconfirmed — retry this same sale safely"
          : "Waiting for GM confirmation";
      } else {
        row.cannotBuy = !entry.timedOut || offline;
        row.cannotBuyReason = entry.timedOut
          ? offline
            ? "GM offline — confirmation is still uncertain"
            : "Unconfirmed — retry this same purchase safely"
          : "Waiting for GM confirmation";
      }
    }
    const latestLog = this._log.at(-1) ?? null;
    let transactionTone = "ready";
    let transactionTitle = "Ready to trade";
    let transactionMessage =
      "Choose a quantity, then buy or sell. The GM confirms every completed trade.";
    if (uncertain.length > 0) {
      transactionTone = "uncertain";
      transactionTitle = "A trade is not yet confirmed";
      transactionMessage = offline
        ? "The GM disconnected before confirming this trade. Your character may already have changed. Do not repeat it while offline; after reconnection, click the same item action once to retry the original confirmation safely."
        : "Your character may already have changed. Click the same item action once to retry the original confirmation safely.";
    } else if (waiting.length > 0) {
      transactionTone = offline ? "uncertain" : "pending";
      transactionTitle = offline
        ? "Trade confirmation was interrupted"
        : "Waiting for the GM";
      transactionMessage = offline
        ? `${waiting.length} trade${waiting.length === 1 ? " may" : "s may"} already have completed. Do not repeat the action. Keep this window open; it will show a safe retry if confirmation times out.`
        : `${waiting.length} trade${waiting.length === 1 ? " is" : "s are"} being confirmed. Do not repeat the action.`;
    } else if (offline) {
      transactionTone = "offline";
      transactionTitle = "Trading is offline";
      transactionMessage =
        "No GM is connected. No new trade was sent; keep this window open and try after the GM reconnects.";
    } else if (latestLog?.kind === "buy" || latestLog?.kind === "sell") {
      transactionTone = "success";
      transactionTitle = "Last trade confirmed";
      transactionMessage = latestLog.text;
    } else if (latestLog?.kind === "fail") {
      transactionTone = "error";
      transactionTitle = "Last action was not completed";
      transactionMessage = `${latestLog.text} Review the message, then try again when ready.`;
    }

    return {
      merchant: {
        ...this._merchant,
        art: this._merchant.art || FALLBACK_ART,
      },
      walletLabel,
      actorName: actor?.name ?? "No character selected",
      actorImg: actor?.img ?? "icons/svg/mystery-man.svg",
      merchantGoldLabel: formatMerchantGold(this._merchant.goldOnHand),
      passiveHaggleLabel: formatPassiveHaggle(passivePct),
      previewMode: this._previewMode,
      previewNoActor: this._previewMode && !actor,
      noActor: !actor,
      needsActorChoice:
        !this._previewMode && !actor && controlledActors.length > 1,
      canSwitchActor: !this._previewMode && controlledActors.length > 1,
      actorSwitchLocked: pending.length > 0 || this._bargainPending.size > 0,
      actorOptions: controlledActors.map((candidate) => ({
        id: String(candidate.id ?? ""),
        name: String(candidate.name ?? "Character"),
        selected: String(candidate.id ?? "") === String(actor?.id ?? ""),
      })),
      offline,
      transactionBusy: waiting.length > 0,
      transactionTone,
      transactionTitle,
      transactionMessage,
      searchQuery: this._search[this._activeTab] ?? "",
      domId: String(this._sessionId).replace(/[^a-zA-Z0-9_-]/g, "-"),
      buyActive: this._activeTab === "buy",
      sellActive: this._activeTab === "sell",
      buyRows,
      sellRows,
      log: this._log.slice(-30),
      sessionSpentLabel:
        this._spentGp > 0 ? `${this._spentGp.toFixed(2)} gp` : "",
      sessionEarnedLabel:
        this._earnedGp > 0 ? `${this._earnedGp.toFixed(2)} gp` : "",
      sessionSpentValue: `${this._spentGp.toFixed(2)} gp`,
      sessionEarnedValue: `${this._earnedGp.toFixed(2)} gp`,
    };
  }

  async _resolveMerchantItems() {
    // Cache uuid→snapshot across renders. _prepareContext runs on every
    // render(false) — every buy/sell/tab-switch/bargain and inbound
    // STATE_UPDATE — and previously re-awaited fromUuid() for every shelf row
    // each time (sequentially). The bundled pack is read-only at runtime, so a
    // snapshot can't go stale within a session; stock/qty come from
    // this._merchant.items, not the cached doc. Only newly-seen uuids are
    // fetched, and cold fetches run concurrently.
    if (!this._itemCache) this._itemCache = new Map();
    const cache = this._itemCache;
    const missing = [
      ...new Set(
        this._merchant.items
          .map((row) => row.uuid)
          .filter((uuid) => !cache.has(uuid)),
      ),
    ];
    if (missing.length > 0) {
      await Promise.all(
        missing.map(async (uuid) => {
          cache.set(uuid, await resolveItemSnapshot(uuid));
        }),
      );
    }
    // Project the cache down to the current shelf (it may also hold snapshots
    // for rows the GM has since removed).
    const map = new Map();
    for (const row of this._merchant.items) {
      map.set(row.uuid, cache.get(row.uuid) ?? null);
    }
    return map;
  }

  _buildBuyRow(row, item, wallet, passivePct = 0) {
    const sealKey = `${row.uuid}::buy`;
    const seal = this._seals.get(sealKey) ?? null;
    const rarity = item ? getItemRarity(item) : "";
    // List price (no seal, no passive) vs the price the player actually pays.
    const listGp = roundGp(
      resolveUnitBuyPrice({
        merchant: this._merchant,
        row,
        item,
        seal: null,
        passivePct: 0,
      }),
    );
    const finalGp = roundGp(
      resolveUnitBuyPrice({
        merchant: this._merchant,
        row,
        item,
        seal,
        passivePct,
      }),
    );
    // A seal supersedes the passive nudge; otherwise passive drives the delta.
    const effectiveDeltaPct = seal
      ? Number(seal.deltaPct) || 0
      : Number(passivePct) || 0;
    const outOfStock = !row.unlimited && row.qty <= 0;
    const walletGp = walletGpFromObject(wallet);
    const cannotBuy = outOfStock || finalGp > walletGp || !item;
    // Tell the player WHY a buy is blocked instead of an inert disabled button.
    let cannotBuyReason = "";
    if (!item) cannotBuyReason = "Item unavailable";
    else if (outOfStock) cannotBuyReason = "Out of stock";
    else if (finalGp > walletGp) cannotBuyReason = "Not enough gold";
    const maxQty = row.unlimited ? 99 : Math.max(1, row.qty);
    const stockLabel = row.unlimited ? "Unlimited stock" : `Stock: ${row.qty}`;
    const showDelta = Math.abs(effectiveDeltaPct) > 0 && finalGp !== listGp;
    return {
      uuid: row.uuid,
      name: item?.name ?? "(missing item)",
      img: item?.img ?? FALLBACK_ITEM_IMAGE,
      rarity,
      rarityLabel: prettyRarity(rarity),
      stockLabel,
      baseLabel: `${listGp.toFixed(2)} gp`,
      finalLabel: `${finalGp.toFixed(2)} gp`,
      priceDeltaLabel: showDelta ? formatDelta(effectiveDeltaPct) : "",
      deltaClass: effectiveDeltaPct < 0 ? "down" : "up",
      // Distinguish the always-on passive nudge from a rolled bargain seal.
      passiveActive: !seal && showDelta,
      bargainLocked: Boolean(seal) || this._bargainPending.has(sealKey),
      bargainPending: !seal && this._bargainPending.has(sealKey),
      sealLabel: seal ? sealLabel(seal) : "",
      haggleLabel: effectiveDeltaPct < 0 ? "Charm discount" : "Tough seller",
      cannotBuy,
      cannotBuyReason,
      maxQty,
      outOfStock,
      missing: !item,
    };
  }

  _buildSellRow(doc, passivePct = 0) {
    const data = doc.toObject?.() ?? doc;
    const stolen = isStolenForFencing(data);
    const ownedQty = Math.max(
      0,
      Math.floor(Number(data.system?.quantity ?? 1)),
    );
    const sealKey = `${doc.id}::sell`;
    const seal = this._seals.get(sealKey) ?? null;
    const rarity = getItemRarity(data);
    const listGp = roundGp(
      resolveUnitSellPrice({
        merchant: this._merchant,
        item: data,
        seal: null,
        passivePct: 0,
      }),
    );
    const finalGp = roundGp(
      resolveUnitSellPrice({
        merchant: this._merchant,
        item: data,
        seal,
        passivePct,
      }),
    );
    if (listGp <= 0 && !stolen) return null; // hide ordinary free items
    const effectiveDeltaPct = seal
      ? Number(seal.deltaPct) || 0
      : Number(passivePct) || 0;
    const showDelta = Math.abs(effectiveDeltaPct) > 0 && finalGp !== listGp;
    // Gate selling on the merchant's gold-on-hand (tracked both ways).
    const merchantGold = this._merchant.goldOnHand;
    const unlimitedGold = merchantGold == null;
    const affordableQty = unlimitedGold
      ? ownedQty
      : Math.floor((Number(merchantGold) || 0) / Math.max(0.01, finalGp));
    const sellableQty = Math.max(0, Math.min(ownedQty, affordableQty));
    const cannotSell = stolen || sellableQty < 1;
    // Partly-sellable: the merchant can afford some but not the whole stack.
    const goldLimited = !cannotSell && sellableQty < ownedQty;
    return {
      itemId: doc.id,
      // Full embedded-item uuid so the shared double-click-to-open works
      // on sell rows too (data-item-id stays for buy/sell/bargain dispatch).
      uuid: doc.uuid,
      name: data.name ?? "(item)",
      img: data.img ?? FALLBACK_ITEM_IMAGE,
      rarity,
      rarityLabel: prettyRarity(rarity),
      ownedQty,
      maxSellQty: Math.max(1, sellableQty),
      cannotSell,
      cannotSellReason: stolen
        ? "Stolen goods require fencing during downtime."
        : cannotSell
          ? "Merchant low on gold."
          : "",
      stolen,
      goldLimited,
      affordLabel: goldLimited ? `Shop can afford ${sellableQty}` : "",
      baseLabel: `${listGp.toFixed(2)} gp`,
      finalLabel: `${finalGp.toFixed(2)} gp`,
      // Sell payout: a negative delta is a BONUS, so flip the sign for display.
      priceDeltaLabel: showDelta ? formatDelta(-effectiveDeltaPct) : "",
      deltaClass: effectiveDeltaPct < 0 ? "down" : "up",
      passiveActive: !seal && showDelta,
      bargainLocked:
        stolen || Boolean(seal) || this._bargainPending.has(sealKey),
      bargainPending: !seal && this._bargainPending.has(sealKey),
      sealLabel: seal ? sealLabel(seal) : "",
      haggleLabel: effectiveDeltaPct < 0 ? "Charm bonus" : "Tough seller",
    };
  }

  _onRender(context, options) {
    super._onRender?.(context, options);

    // Honor the shared visual prefs (animations + rarity glow), mirroring
    // the workspace and loot tools.
    const root = this.element;
    applyVisualPrefs(root, "mw-");

    // Play the one-shot bargain celebration if a result just landed.
    this._playBargainCelebration();

    // Snap stored qty inputs back into the inputs after re-render.
    for (const [uuid, qty] of this._buyQty) {
      const input = this.element?.querySelector(
        `[data-role="buyQty"][data-uuid="${cssEscape(uuid)}"]`,
      );
      if (input) input.value = qty;
    }
    for (const [itemId, qty] of this._sellQty) {
      const input = this.element?.querySelector(
        `[data-role="sellQty"][data-item-id="${cssEscape(itemId)}"]`,
      );
      if (input) input.value = qty;
    }

    this._wireQtyInputs();

    if (root) {
      // Recover broken item-row thumbnails (background-image, no native onerror).
      wireBackgroundImageFallback(root, ".ms-row__icon");
      // Repo-wide standard: double-click a row to open its sheet.
      bindRowDoubleClickOpen(root, {
        rowSelector: ".ms-row",
        onOpen: (uuid) =>
          openItemByUuid(uuid, {
            onOpened: () => playModuleSound(SOUND_EVENTS.ITEM_OPEN),
          }),
      });
      this._wireTabKeyboard(root);
      this._wireItemSearch(root);
      this._wireActorSelect(root);
    }

    // Preserve scroll position across action re-renders (buy, bargain, tab…).
    if (root) {
      bindScrollTracking(root, SCROLL_TARGETS, () => {
        this._scroll = captureScroll(root, SCROLL_TARGETS);
      });
      restoreScroll(root, SCROLL_TARGETS, this._scroll);
    }
  }

  /** Switches only among locally allowlisted controlled Actors. Every trade
   * resolves that Actor again before emitting, so a later ownership change
   * fails closed instead of submitting through a stale selection. */
  _wireActorSelect(root) {
    const select = root.querySelector?.('[data-role="merchant-actor"]');
    if (!select) return;
    select.addEventListener("change", () => {
      if (this._pendingCommits.size > 0 || this._bargainPending.size > 0) {
        this.render(false);
        return;
      }
      const actor = setPreferredMerchantActorId(select.value);
      this._selectedActorId = String(actor?.id ?? "");
      this._seals.clear();
      this._buyQty.clear();
      this._sellQty.clear();
      this._justBargained = null;
      this._log = [];
      this._spentGp = 0;
      this._earnedGp = 0;
      this.render(false);
    });
  }

  _resolveTradingActor() {
    const actor = resolvePlayerActor(this._selectedActorId);
    if (actor) this._selectedActorId = String(actor.id ?? "");
    return actor;
  }

  /** Search is local to the active tab and never changes merchant or actor data. */
  _wireItemSearch(root) {
    const input = root.querySelector?.('[data-role="item-search"]');
    if (!input) return;
    input.value = this._search[this._activeTab] ?? "";
    const apply = () => {
      const rawQuery = String(input.value ?? "");
      const query = rawQuery.trim().toLocaleLowerCase();
      this._search[this._activeTab] = rawQuery;
      let visible = 0;
      for (const row of root.querySelectorAll?.(".ms-rows .ms-row") ?? []) {
        const matches =
          !query || row.textContent.toLocaleLowerCase().includes(query);
        row.hidden = !matches;
        if (matches) visible += 1;
      }
      const empty = root.querySelector?.('[data-role="item-search-empty"]');
      if (empty) empty.hidden = visible > 0 || !query;
      const status = root.querySelector?.('[data-role="item-search-status"]');
      if (status) {
        status.textContent = query
          ? `${visible} item${visible === 1 ? "" : "s"} match your search.`
          : "Showing all items.";
      }
    };
    input.addEventListener("input", apply);
    apply();
  }

  _wireTabKeyboard(root) {
    const tablist = root.querySelector?.('[role="tablist"]');
    if (!tablist) return;
    tablist.addEventListener("keydown", (event) => {
      if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key))
        return;
      const tabs = [...tablist.querySelectorAll('[role="tab"]')];
      const current = tabs.indexOf(event.target);
      if (current < 0 || tabs.length === 0) return;
      event.preventDefault();
      let next = current;
      if (event.key === "Home") next = 0;
      else if (event.key === "End") next = tabs.length - 1;
      else if (event.key === "ArrowLeft")
        next = (current - 1 + tabs.length) % tabs.length;
      else next = (current + 1) % tabs.length;
      tabs[next].focus();
      tabs[next].click();
    });
  }

  _wireQtyInputs() {
    const buyInputs =
      this.element?.querySelectorAll?.('[data-role="buyQty"]') ?? [];
    for (const input of buyInputs) {
      input.addEventListener("change", () => {
        const uuid = input.dataset.uuid;
        const qty = clampQtyInput(input);
        this._buyQty.set(uuid, qty);
        input.value = qty;
      });
    }
    const sellInputs =
      this.element?.querySelectorAll?.('[data-role="sellQty"]') ?? [];
    for (const input of sellInputs) {
      input.addEventListener("change", () => {
        const itemId = input.dataset.itemId;
        const qty = clampQtyInput(input);
        this._sellQty.set(itemId, qty);
        input.value = qty;
      });
    }
  }

  /**
   * One-shot bargain celebration: flash the just-bargained row green
   * (favorable) or red (unfavorable). Consumes the transient
   * `_justBargained` marker set in `_onBargainSeal`. Respects mw-no-anim.
   */
  _playBargainCelebration() {
    const mark = this._justBargained;
    this._justBargained = null;
    if (!mark || !mark.refId) return;
    const root = this.element;
    if (!root || root.classList.contains("mw-no-anim")) return;
    const selector =
      mark.side === "sell"
        ? `.ms-row[data-item-id="${cssEscape(mark.refId)}"]`
        : `.ms-row[data-uuid="${cssEscape(mark.refId)}"]`;
    const rowEl = root.querySelector(selector);
    if (!rowEl) return;
    const cls = mark.win ? "ms-row--bargain-win" : "ms-row--bargain-fail";
    rowEl.classList.remove("ms-row--bargain-win", "ms-row--bargain-fail");
    void rowEl.offsetWidth; // reflow so re-adding restarts the animation
    rowEl.classList.add(cls);
    globalThis.setTimeout?.(() => rowEl.classList.remove(cls), 1000);
  }

  _appendLog(kind, text) {
    this._log.push({ kind, text });
    if (this._log.length > 100) this._log.splice(0, this._log.length - 100);
  }

  /* -------------------- actions -------------------- */

  static _onTab(_event, target) {
    const tab = target?.dataset?.tab;
    if (!tab) return;
    this._activeTab = tab;
    this.render(false);
  }

  /** Keyboard/touch-friendly "open item sheet" (double-click still works too). */
  static async _onOpenItem(_event, target) {
    const uuid = target?.dataset?.uuid;
    if (!uuid) return;
    await openItemByUuid(uuid, {
      onOpened: () => playModuleSound(SOUND_EVENTS.ITEM_OPEN),
    });
  }

  static _onBuyN(_event, target) {
    const uuid = target?.dataset?.uuid;
    const qty = Math.max(1, Math.floor(Number(this._buyQty.get(uuid) ?? 1)));
    return this._performBuy(uuid, qty);
  }

  async _performBuy(uuid, qty) {
    if (!uuid) return;
    if (this._previewMode) return this._previewBuy(uuid, qty);
    if (this._blockOfflineAction()) return;
    if (this._retryOrBlockPending("buy", uuid)) return;
    const row = this._merchant.items.find((r) => r.uuid === uuid);
    if (!row) return;
    const item = await fromUuid(uuid).catch(() => null);
    if (!item) {
      playModuleSound(SOUND_EVENTS.WARNING_MUTED);
      ui.notifications?.warn("That item isn't available anymore.");
      return;
    }
    const actor = this._resolveTradingActor();
    if (!actor) {
      playModuleSound(SOUND_EVENTS.WARNING_MUTED);
      ui.notifications?.warn(
        "Choose a character you own first. Ask the GM to assign one or grant Owner permission.",
      );
      return;
    }
    const sealKey = `${uuid}::buy`;
    const seal = this._seals.get(sealKey) ?? null;
    const passivePct = computePassiveBargainPct(this._merchant, actor);
    const itemObj = item.toObject?.() ?? item;
    if (getSetting(SETTING_KEYS.MERCHANT_CONFIRM_TRANSACTIONS) === true) {
      const unitGp = roundGp(
        resolveUnitBuyPrice({
          merchant: this._merchant,
          row,
          item: itemObj,
          seal,
          passivePct,
        }),
      );
      const confirmed = await confirmTransaction({
        side: "buy",
        name: itemObj.name ?? "item",
        qty,
        totalGp: roundGp(unitGp * Math.max(1, qty)),
      });
      if (!confirmed) return;
    }
    const unitGp = roundGp(
      resolveUnitBuyPrice({
        merchant: this._merchant,
        row,
        item: itemObj,
        seal,
        passivePct,
      }),
    );
    const result = {
      ok: unitGp > 0,
      reason: unitGp > 0 ? "" : "no-price",
      itemName: itemObj.name ?? "item",
      qty: Math.max(1, Math.floor(Number(qty) || 1)),
      unitGp,
      totalGp: roundGp(unitGp * Math.max(1, Math.floor(Number(qty) || 1))),
      sealId: seal?.sealId ?? null,
    };
    if (!result.ok) {
      const message = friendlyTransactionError(result.reason);
      ui.notifications?.warn(message);
      playModuleSound(SOUND_EVENTS.WARNING_MUTED);
      this._appendLog("fail", `Couldn't buy — ${message}`);
      this.render(false);
      return;
    }
    // Save the exact retry frame before it can leave this client. A reload can
    // then resend the same id and payload without creating a second trade.
    const pending = await this._persistCommitRequest(
      MERCHANT_EVENTS.COMMIT_PURCHASE,
      {
        sessionId: this._sessionId,
        itemUuid: uuid,
        qty: result.qty,
        sealId: result.sealId,
        totalGp: result.totalGp,
        actorId: actor.id,
      },
      {
        side: "buy",
        merchantId: this._merchant.id,
        merchantName: this._merchant.name,
        refId: uuid,
        itemName: result.itemName,
        qty: result.qty,
        unitGp: result.unitGp,
        totalGp: result.totalGp,
        sealKey,
        seal: pendingSealSnapshot(seal),
      },
    );
    if (!pending) return;
    this._pendingPersistenceBlocked = false;
    this._appendLog(
      "pending",
      `Purchase requested: ${result.qty}x ${result.itemName}`,
    );
    this._trackCommit(pending.commitId, {
      ...pending.context,
      eventType: pending.eventType,
      payload: pending.payload,
      actor,
    });
    emitMerchantEvent(pending.eventType, pending.payload);
    this.render(false);
  }

  static _onSellN(_event, target) {
    const itemId = target?.dataset?.itemId;
    const qty = Math.max(1, Math.floor(Number(this._sellQty.get(itemId) ?? 1)));
    return this._performSell(itemId, qty);
  }

  async _performSell(itemId, qty) {
    if (this._previewMode) return this._previewSell(itemId, qty);
    if (!itemId) return;
    if (this._blockOfflineAction()) return;
    if (this._retryOrBlockPending("sell", itemId)) return;
    const actor = this._resolveTradingActor();
    if (!actor) {
      playModuleSound(SOUND_EVENTS.WARNING_MUTED);
      ui.notifications?.warn(
        "Choose a character you own first. Ask the GM to assign one or grant Owner permission.",
      );
      return;
    }
    const ownedItem = actor.items?.get?.(itemId);
    if (!ownedItem) {
      playModuleSound(SOUND_EVENTS.WARNING_MUTED);
      ui.notifications?.warn("That item isn't on your sheet anymore.");
      return;
    }
    const sealKey = `${itemId}::sell`;
    const seal = this._seals.get(sealKey) ?? null;
    const passivePct = computePassiveBargainPct(this._merchant, actor);
    // Gate on the merchant's gold-on-hand before paying out.
    const unitGp = roundGp(
      resolveUnitSellPrice({
        merchant: this._merchant,
        item: ownedItem.toObject?.() ?? ownedItem,
        seal,
        passivePct,
      }),
    );
    if (!merchantCanAfford(this._merchant, unitGp * Math.max(1, qty))) {
      const gold = Number(this._merchant.goldOnHand) || 0;
      ui.notifications?.warn(
        `The merchant only has ${gold.toFixed(0)} gp on hand.`,
      );
      this._appendLog("fail", "Sell blocked — merchant is low on gold");
      this.render(false);
      return;
    }
    if (getSetting(SETTING_KEYS.MERCHANT_CONFIRM_TRANSACTIONS) === true) {
      const confirmed = await confirmTransaction({
        side: "sell",
        name: ownedItem.name ?? "item",
        qty,
        totalGp: roundGp(unitGp * Math.max(1, qty)),
      });
      if (!confirmed) return;
    }
    const result = {
      ok: unitGp > 0,
      reason: unitGp > 0 ? "" : "no-value",
      itemName: ownedItem.name ?? "item",
      qty: Math.max(1, Math.floor(Number(qty) || 1)),
      unitGp,
      totalGp: roundGp(unitGp * Math.max(1, Math.floor(Number(qty) || 1))),
      sealId: seal?.sealId ?? null,
    };
    if (!result.ok) {
      const message = friendlyTransactionError(result.reason);
      ui.notifications?.warn(message);
      playModuleSound(SOUND_EVENTS.WARNING_MUTED);
      this._appendLog("fail", `Couldn't sell — ${message}`);
      this.render(false);
      return;
    }
    const pending = await this._persistCommitRequest(
      MERCHANT_EVENTS.COMMIT_SALE,
      {
        sessionId: this._sessionId,
        itemUuid: itemId,
        qty: result.qty,
        sealId: result.sealId,
        totalGp: result.totalGp,
        actorId: actor.id,
      },
      {
        side: "sell",
        merchantId: this._merchant.id,
        merchantName: this._merchant.name,
        refId: itemId,
        itemName: result.itemName,
        qty: result.qty,
        unitGp: result.unitGp,
        totalGp: result.totalGp,
        sealKey,
        seal: pendingSealSnapshot(seal),
      },
    );
    if (!pending) return;
    this._pendingPersistenceBlocked = false;
    this._appendLog(
      "pending",
      `Sale requested: ${result.qty}x ${result.itemName}`,
    );
    this._trackCommit(pending.commitId, {
      ...pending.context,
      eventType: pending.eventType,
      payload: pending.payload,
      actor,
    });
    emitMerchantEvent(pending.eventType, pending.payload);
    this.render(false);
  }

  static async _onBargainBuy(_event, target) {
    return this._performBargain(target?.dataset?.uuid, "buy");
  }

  static async _onBargainSell(_event, target) {
    return this._performBargain(target?.dataset?.itemId, "sell");
  }

  async _performBargain(refId, side) {
    if (!refId) return;
    if (this._previewMode) return this._previewBargain(refId, side);
    if (this._blockOfflineAction()) return;
    const sealKey = `${refId}::${side}`;
    if (this._seals.has(sealKey) || this._bargainPending.has(sealKey)) return;
    const actor = this._resolveTradingActor();
    if (!actor) {
      playModuleSound(SOUND_EVENTS.WARNING_MUTED);
      ui.notifications?.warn(
        "Choose a character you own first. Ask the GM to assign one or grant Owner permission.",
      );
      return;
    }
    const skillId = await promptSkillPicker(this._merchant.allowedSkills, {
      dc: this._merchant.bargainDC,
      failPct: this._merchant.bargainFailPct,
    });
    if (!skillId) return;
    this._bargainPending.add(sealKey);
    this.render(false);
    emitMerchantEvent(MERCHANT_EVENTS.BARGAIN_RESULT, {
      sessionId: this._sessionId,
      itemUuid: refId,
      side,
      skillId,
      actorId: actor.id,
    });
    // Seal normally arrives on the bargain-seal event handler. Guard against it
    // never coming back (GM reloaded the world, session expired, no active GM):
    // re-enable the row after a timeout so the player isn't stuck. _onBargainSeal
    // deletes the key first, so a seal that does arrive cancels this watchdog.
    const watchdog = globalThis.setTimeout?.(() => {
      this._bargainTimers.delete(sealKey);
      if (this._bargainPending.delete(sealKey)) {
        this._appendLog(
          "fail",
          "Bargain timed out — no response from the GM. Try again.",
        );
        if (this.rendered) this.render(false);
      }
    }, BARGAIN_SEAL_TIMEOUT_MS);
    if (watchdog != null) this._bargainTimers.set(sealKey, watchdog);
  }

  /* -------------------- GM preview (sandbox) -------------------- *
   * All three mutate the in-memory merchant clone (stock + gold) and log the
   * result. They never touch a real actor, the real merchant store, chat, or
   * the socket — so a GM can drive the shop window risk-free.
   * ------------------------------------------------------------- */

  async _previewBuy(uuid, qty) {
    const row = this._merchant.items.find((r) => r.uuid === uuid);
    if (!row) return;
    const item = await fromUuid(uuid).catch(() => null);
    const count = Math.max(1, Math.floor(Number(qty) || 1));
    const sealKey = `${uuid}::buy`;
    const seal = this._seals.get(sealKey) ?? null;
    const passivePct = computePassiveBargainPct(
      this._merchant,
      this._previewActor,
    );
    const unitGp = roundGp(
      resolveUnitBuyPrice({
        merchant: this._merchant,
        row,
        item: item?.toObject?.() ?? item,
        seal,
        passivePct,
      }),
    );
    const totalGp = roundGp(unitGp * count);
    if (totalGp <= 0) {
      ui.notifications?.info(
        "This item has no preview price. Nothing changed; choose another item.",
      );
      return;
    }
    if (!row.unlimited && row.qty < count) {
      this._appendLog("fail", "Preview: out of stock");
      this.render(false);
      return;
    }
    this._merchant = applyPreviewBuy(this._merchant, uuid, count, totalGp);
    this._seals.delete(sealKey);
    this._spentGp = roundGp(this._spentGp + totalGp);
    playModuleSound(SOUND_EVENTS.MERCHANT_PURCHASE);
    this._appendLog(
      "buy",
      `Preview: bought ${count}× ${item?.name ?? "item"} for ${totalGp.toFixed(2)} gp`,
    );
    this.render(false);
  }

  async _previewSell(itemId, qty) {
    const actor = this._previewActor;
    if (!actor) {
      ui.notifications?.info(
        "Pick a character when opening the preview to try selling. Nothing changed.",
      );
      return;
    }
    const ownedItem = actor.items?.get?.(itemId);
    if (!ownedItem) return;
    const count = Math.max(1, Math.floor(Number(qty) || 1));
    const sealKey = `${itemId}::sell`;
    const seal = this._seals.get(sealKey) ?? null;
    const passivePct = computePassiveBargainPct(this._merchant, actor);
    const unitGp = roundGp(
      resolveUnitSellPrice({
        merchant: this._merchant,
        item: ownedItem.toObject?.() ?? ownedItem,
        seal,
        passivePct,
      }),
    );
    const totalGp = roundGp(unitGp * count);
    if (totalGp <= 0) {
      notify("info", `this item has no resale value.`);
      return;
    }
    if (!merchantCanAfford(this._merchant, totalGp)) {
      this._appendLog("fail", "Preview: merchant is low on gold");
      this.render(false);
      return;
    }
    this._merchant = applyPreviewSell(this._merchant, totalGp);
    this._seals.delete(sealKey);
    this._earnedGp = roundGp(this._earnedGp + totalGp);
    playModuleSound(SOUND_EVENTS.MERCHANT_SALE);
    this._appendLog(
      "sell",
      `Preview: sold ${count}× ${ownedItem.name} for ${totalGp.toFixed(2)} gp (item kept)`,
    );
    this.render(false);
  }

  async _previewBargain(refId, side) {
    const sealKey = `${refId}::${side}`;
    if (this._seals.has(sealKey) || this._bargainPending.has(sealKey)) return;
    const actor = this._previewActor;
    if (!actor) {
      ui.notifications?.info(
        "Pick a character when opening the preview to try bargaining.",
      );
      return;
    }
    const skillId = await promptSkillPicker(this._merchant.allowedSkills, {
      dc: this._merchant.bargainDC,
      failPct: this._merchant.bargainFailPct,
    });
    if (!skillId) return;
    this._bargainPending.add(sealKey);
    this.render(false);
    const outcome = await runBargain({
      actor,
      skillId,
      dc: this._merchant.bargainDC,
      advantage: this._merchant.bargainAdvantage,
      chatMessage: false,
    });
    this._bargainPending.delete(sealKey);
    if (!outcome.ok) {
      ui.notifications?.warn(
        friendlyTransactionError(outcome.reason ?? "cancelled"),
      );
      this.render(false);
      return;
    }
    const result = computeBargainOutcome(
      outcome.rollTotal,
      Number(this._merchant.bargainDC) || 0,
      buildMerchantBargainTiers(this._merchant),
    );
    this._seals.set(sealKey, {
      sealId: `preview-${refId}-${side}`,
      tier: result.tier,
      deltaPct: result.deltaPct,
      rollTotal: outcome.rollTotal,
      dc: this._merchant.bargainDC,
    });
    playModuleSound(
      Number(result.deltaPct) < 0
        ? SOUND_EVENTS.MERCHANT_BARGAIN_WIN
        : SOUND_EVENTS.MERCHANT_BARGAIN_FAIL,
    );
    this._appendLog(
      "bargain",
      `Preview bargain: ${prettyBargainTier(result.tier?.id)} · ${formatDelta(result.deltaPct)}`,
    );
    this._justBargained = { refId, side, win: Number(result.deltaPct) < 0 };
    this.render(false);
  }
}

/* ------------------------------------------------------------------ *
 * Player-side auto-open wiring
 * ------------------------------------------------------------------ */

let autoOpenRegistered = false;

function merchantReviewDetail(record) {
  const side = record.context.side === "sell" ? "sale" : "purchase";
  const qty = Math.max(1, Math.floor(Number(record.context.qty) || 1));
  return `${side} of ${qty}x ${record.context.itemName} at ${record.context.merchantName} for ${Number(record.context.totalGp).toFixed(2)} gp (actor ${record.payload.actorId})`;
}

function merchantReviewWarning(record, review) {
  const prefix =
    review?.reason === "transaction-history-expired"
      ? "The GM's detailed history no longer proves whether this old trade completed"
      : "This trade may have partially completed and is pinned for GM review";
  return `${prefix}: ${merchantReviewDetail(record)}. The exact request is saved for review and will not be retried. Do not repeat it.`;
}

function exactCommitApp(record) {
  const app = instances.get(record?.payload?.sessionId);
  return app?._pendingCommits?.has?.(record?.commitId) ? app : null;
}

function presentPersistedReview(record, review) {
  const key = persistedReviewKey(record);
  if (surfacedPersistedReviewKeys.has(key)) return true;
  surfacedPersistedReviewKeys.add(key);
  while (surfacedPersistedReviewKeys.size > TERMINAL_SETTLEMENT_MEMORY) {
    surfacedPersistedReviewKeys.delete(
      surfacedPersistedReviewKeys.values().next().value,
    );
  }
  const app = exactCommitApp(record);
  if (app?._presentCommitReview(record, review)) return true;
  playModuleSound(SOUND_EVENTS.WARNING_MUTED);
  ui.notifications?.warn(merchantReviewWarning(record, review));
  return true;
}

async function presentHeadlessTerminalCommit(record, payload) {
  if (payload.ok !== true) {
    ui.notifications?.warn(
      `A saved ${record.context.side === "sell" ? "sale" : "purchase"} was declined: ${friendlyTransactionError(payload.reason)}`,
    );
    return true;
  }
  const qty = Math.max(
    1,
    Math.floor(Number(payload.qty) || record.context.qty),
  );
  const totalGp = roundGp(
    Number.isFinite(Number(payload.totalGp))
      ? Number(payload.totalGp)
      : record.context.totalGp,
  );
  const unitGp = roundGp(
    Number.isFinite(Number(payload.unitGp))
      ? Number(payload.unitGp)
      : totalGp / Math.max(1, qty),
  );
  const acceptedSeal =
    payload.sealId && payload.sealId === record.payload.sealId
      ? record.context.seal
      : null;
  const actor = globalThis.game?.actors?.get?.(record.payload.actorId) ?? null;
  const receipt = await postTransactionReceipt({
    side: record.context.side,
    actor,
    merchant: {
      id: record.context.merchantId,
      name: record.context.merchantName,
    },
    itemName: payload.itemName || record.context.itemName,
    qty,
    unitGp,
    totalGp,
    bargainTier: acceptedSeal?.tier ?? null,
    rollTotal: acceptedSeal?.rollTotal ?? null,
    dc: acceptedSeal?.dc ?? null,
    worldId: record.worldId,
    originUserId: record.originUserId,
    commitId: record.commitId,
  });
  if (!receipt) {
    ui.notifications?.warn(
      "A completed trade receipt could not be posted. It remains saved and will retry safely.",
    );
    return false;
  }
  ui.notifications?.info(
    `${record.context.merchantName} completed the saved ${record.context.side === "sell" ? "sale" : "purchase"}.`,
  );
  return true;
}

async function presentTerminalOutboxEntry({ record, terminal }) {
  const payload = terminal.result;
  const app = exactCommitApp(record);
  if (app) return app._presentTerminalCommit(record, payload);
  return presentHeadlessTerminalCommit(record, payload);
}

async function presentExactTerminalOutbox(record) {
  return presentMerchantPendingTerminalOutbox(
    record.originUserId,
    record.commitId,
    { present: presentTerminalOutboxEntry },
  );
}

async function handlePersistedCommitResult(payload) {
  if (
    !payload?.commitId ||
    payload.targetUserId !== globalThis.game?.user?.id
  ) {
    return false;
  }
  const key = `${String(globalThis.game?.world?.id ?? "")}:${payload.targetUserId}:${payload.commitId}`;
  const existing = terminalHandlingPromises.get(key);
  if (existing) return existing;

  let operation;
  operation = (async () => {
    try {
      const settlement = await settleMerchantPendingCommitResult(payload);
      if (settlement.status === "mismatch") {
        ui.notifications?.warn(
          "A merchant result did not match its saved trade. The request remains stored for a safe retry.",
        );
        return false;
      }
      if (
        settlement.status === "quarantined" ||
        settlement.status === "review"
      ) {
        return presentPersistedReview(settlement.record, settlement.review);
      }
      if (
        settlement.status !== "terminal-outbox" &&
        settlement.status !== "missing"
      ) {
        return false;
      }
      if (settlement.status === "missing") {
        return (
          instances
            .get(payload.sessionId)
            ?._clearCommitHandledElsewhere(payload) ?? false
        );
      }
      const candidate = settlement.record ?? {
        originUserId: payload.targetUserId,
        commitId: payload.commitId,
      };
      const presented = await presentExactTerminalOutbox(candidate);
      return presented.status === "presented";
    } catch {
      ui.notifications?.warn(
        "The GM answered, but this browser could not safely store or present the result. The exact trade remains saved for recovery.",
      );
      return false;
    }
  })().finally(() => {
    if (terminalHandlingPromises.get(key) === operation) {
      terminalHandlingPromises.delete(key);
    }
  });
  terminalHandlingPromises.set(key, operation);
  while (terminalHandlingPromises.size > TERMINAL_SETTLEMENT_MEMORY) {
    terminalHandlingPromises.delete(
      terminalHandlingPromises.keys().next().value,
    );
  }
  return operation;
}

export async function drainPersistedMerchantTerminalOutbox() {
  let records;
  try {
    records = listMerchantPendingTerminalOutbox();
  } catch {
    return false;
  }
  for (const record of records) {
    try {
      await presentExactTerminalOutbox(record);
    } catch {
      // The exact outbox entry remains durable for the next reload/reconnect.
    }
  }
  return true;
}

function persistedReviewKey(record) {
  return `${record.worldId}:${record.originUserId}:${record.commitId}:${merchantCommitRequestFingerprint(
    {
      type: record.eventType,
      originUserId: record.originUserId,
      ...record.payload,
    },
  )}`;
}

async function surfacePersistedMerchantReviews() {
  let reviews;
  try {
    reviews = listMerchantPendingReviews();
  } catch {
    return false;
  }

  // A status result can be durably settling while this short window expires.
  // Wait for that exact settlement, then re-read instead of flashing an old
  // permanent warning immediately before its success receipt.
  const settlements = reviews
    .map((record) =>
      terminalHandlingPromises.get(
        `${record.worldId}:${record.originUserId}:${record.commitId}`,
      ),
    )
    .filter(Boolean);
  if (settlements.length > 0) {
    await Promise.allSettled(settlements);
    try {
      reviews = listMerchantPendingReviews();
    } catch {
      return false;
    }
  }

  for (const record of reviews) {
    presentPersistedReview(record, record.review);
  }
  return true;
}

function deferPersistedMerchantReviewSurface() {
  if (persistedReviewSurfaceTimer != null) {
    globalThis.clearTimeout?.(persistedReviewSurfaceTimer);
  }
  persistedReviewSurfaceTimer = globalThis.setTimeout?.(() => {
    persistedReviewSurfaceTimer = null;
    void surfacePersistedMerchantReviews();
  }, PERSISTED_REVIEW_STATUS_WINDOW_MS);
}

/** Ask only for the exact durable status of inert review records. */
function probePersistedMerchantReviews() {
  let reviews;
  try {
    reviews = listMerchantPendingReviews();
  } catch {
    return false;
  }
  for (const record of reviews) {
    emitMerchantEvent(MERCHANT_EVENTS.COMMIT_STATUS_REQUEST, {
      commitId: record.commitId,
      requestFingerprint: merchantCommitRequestFingerprint({
        type: record.eventType,
        originUserId: record.originUserId,
        ...record.payload,
      }),
    });
  }
  return true;
}

/** Replay exact saved requests, optionally narrowed to one restored session. */
async function resendPersistedMerchantCommits(sessionId = null) {
  try {
    await resendMerchantPendingCommits({
      send(eventType, payload) {
        if (sessionId && payload.sessionId !== sessionId) return;
        emitMerchantEvent(eventType, payload);
      },
    });
    return true;
  } catch {
    ui.notifications?.warn(
      "Saved merchant requests could not be retried yet. They remain safely stored in this browser.",
    );
    return false;
  }
}

/**
 * Subscribe to SESSION_OPEN events for this client. When the GM opens
 * a session targeted at this user, open the session window
 * automatically.
 */
export function registerMerchantSessionAutoOpen() {
  if (autoOpenRegistered) return;
  autoOpenRegistered = true;
  subscribe(MERCHANT_EVENTS.COMMIT_RESULT, (payload) => {
    void handlePersistedCommitResult(payload);
  });
  subscribe(MERCHANT_EVENTS.SESSION_OPEN, (payload) => {
    if (!payload) return;
    // Open only on the client the GM explicitly targeted. Keying purely on the
    // target id (NOT on "is this user a GM") is deliberate: Foundry's
    // user.isGM is true for Assistant GMs, so the old `isGM` skip silently
    // blocked any allowed player who held an assistant/elevated role from ever
    // receiving their pushed shop. The GM who pushed to a player has
    // target !== self, so this never pops the player's window on the GM screen;
    // only the targeted user opens it. A missing/blank target matches no real
    // user id, so it's ignored.
    if (payload.targetUserId !== globalThis.game?.user?.id) return;
    console.log(
      `${MODULE_ID} | received pushed merchant session "${payload.sessionId}" — opening`,
    );
    // Chime only when the window is genuinely new (not a re-pop from a repeat
    // request), and here — when the session truly opens — rather than
    // optimistically on the player's click.
    const wasOpen = instances.has(payload.sessionId);
    MerchantSessionApp.open({
      sessionId: payload.sessionId,
      merchant: payload.merchant,
    });
    void resendPersistedMerchantCommits(payload.sessionId);
    // Chime only for a genuinely new GM push — not a resume re-pop on reload/relog.
    if (!wasOpen && !payload.resume) {
      playModuleSound(SOUND_EVENTS.MERCHANT_SESSION_OPEN);
    }
  });
  // A pushed session is a one-shot broadcast, so a player who reloads/relogs
  // after the GM opened it would lose the window. Now that the SESSION_OPEN
  // subscriber above is bound, ask the GM to re-send anything still open for us
  // (race-free). If no GM was online to answer (player loaded first), re-ask
  // when a GM connects — requestMerchantSessionResume self-guards on activeGM.
  probePersistedMerchantReviews();
  deferPersistedMerchantReviewSurface();
  void drainPersistedMerchantTerminalOutbox();
  void resendPersistedMerchantCommits();
  requestMerchantSessionResume();
  globalThis.Hooks?.on?.("userConnected", (user, connected) => {
    if (!connected || !user?.isGM) return;
    requestMerchantSessionResume();
    if (user.id === authoritativeGMId()) {
      void drainPersistedMerchantTerminalOutbox();
      void resendPersistedMerchantCommits();
      probePersistedMerchantReviews();
      deferPersistedMerchantReviewSurface();
    }
  });
}

/* ------------------------------------------------------------------ *
 * Helpers
 * ------------------------------------------------------------------ */

export function getControlledMerchantActors() {
  const user = globalThis.game?.user;
  if (!user) return [];
  const userId = String(user.id ?? "").trim();
  if (!userId) return [];
  const OWNER = globalThis.CONST?.DOCUMENT_OWNERSHIP_LEVELS?.OWNER ?? 3;
  const actors = globalThis.game?.actors;
  const documents = Array.isArray(actors?.contents)
    ? actors.contents
    : Array.isArray(actors)
      ? actors
      : actors?.values
        ? [...actors.values()]
        : [];
  const controlled = documents.filter((actor) => {
    if (actor?.type !== "character") return false;
    if (isFullGM(user)) return true;
    const ownership = actor.ownership ?? {};
    if (Object.hasOwn(ownership, userId)) {
      return Number(ownership[userId]) >= Number(OWNER);
    }
    if (user.isGM === true) return false;
    return Number(ownership.default) >= Number(OWNER);
  });
  return controlled.sort((left, right) =>
    String(left?.name ?? "").localeCompare(String(right?.name ?? "")),
  );
}

export function getPreferredMerchantActorId() {
  return preferredMerchantActorId;
}

export function setPreferredMerchantActorId(actorId) {
  const requested = String(actorId ?? "").trim();
  if (!requested) {
    preferredMerchantActorId = "";
    return null;
  }
  const actor = getControlledMerchantActors().find(
    (candidate) => String(candidate?.id ?? "") === requested,
  );
  preferredMerchantActorId = actor ? requested : "";
  return actor ?? null;
}

export function resolvePlayerActor(
  requestedActorId = preferredMerchantActorId,
  controlledActors = getControlledMerchantActors(),
) {
  const requested = String(requestedActorId ?? "").trim();
  if (requested) {
    return (
      controlledActors.find(
        (candidate) => String(candidate?.id ?? "") === requested,
      ) ?? null
    );
  }
  const assignedId = String(globalThis.game?.user?.character?.id ?? "").trim();
  if (assignedId) {
    const assigned = controlledActors.find(
      (candidate) => String(candidate?.id ?? "") === assignedId,
    );
    if (assigned) return assigned;
  }
  return controlledActors.length === 1 ? controlledActors[0] : null;
}

/** Clamp a qty input to [1, its max attribute], floored to an integer. */
function clampQtyInput(input) {
  const max = Number(input?.max);
  const value = Math.max(1, Math.floor(Number(input?.value) || 1));
  return Number.isFinite(max) && max >= 1 ? Math.min(max, value) : value;
}

function walletGpFromObject(wallet) {
  return (
    (wallet.pp ?? 0) * 10 +
    (wallet.gp ?? 0) +
    (wallet.ep ?? 0) * 0.5 +
    (wallet.sp ?? 0) * 0.1 +
    (wallet.cp ?? 0) * 0.01
  );
}

function formatDelta(deltaPct) {
  const n = Number(deltaPct) || 0;
  if (n === 0) return "no change";
  return `${n > 0 ? "+" : ""}${n.toFixed(0)}%`;
}

/**
 * Plain-language header chip for the always-on passive haggle. Negative pct =
 * the shopper's charm earns better prices; positive = the merchant is a tough
 * negotiator. Empty string hides the chip.
 */
function formatPassiveHaggle(pct) {
  const n = Number(pct) || 0;
  if (n === 0) return "";
  if (n < 0) return `Your haggling: better prices (${n.toFixed(0)}%)`;
  return `Tough seller: worse prices (+${n.toFixed(0)}%)`;
}

/** Merchant coffer label. Unlimited (null) reads "Unlimited" so players know
 *  the shop can always pay out. */
function formatMerchantGold(gold) {
  if (gold == null) return "Unlimited";
  const n = Math.max(0, Number(gold) || 0);
  return `${Number.isInteger(n) ? n : n.toFixed(2)} gp`;
}

function sealLabel(seal) {
  if (!seal) return "";
  return `${prettyBargainTier(seal.tier?.id)} ${formatDelta(seal.deltaPct)}`;
}

function cssEscape(value) {
  if (typeof CSS !== "undefined" && typeof CSS.escape === "function") {
    return CSS.escape(String(value ?? ""));
  }
  return String(value ?? "").replace(/[^a-zA-Z0-9_-]/g, "\\$&");
}

/**
 * Ask the player to confirm a buy/sell before it commits. Gated by the
 * MERCHANT_CONFIRM_TRANSACTIONS setting at the call site. Resolves true when
 * confirmed, false when declined, dismissed, unavailable, or interrupted.
 */
async function confirmTransaction({ side, name, qty, totalGp }) {
  const verb = side === "sell" ? "Sell" : "Buy";
  const qtyLabel = Number(qty) > 1 ? `${qty}× ` : "";
  const price = Number(totalGp) || 0;
  return confirmInfinityDialog(
    {
      window: {
        title: `${verb} ${name}?`,
        icon:
          side === "sell" ? "fa-solid fa-coins" : "fa-solid fa-cart-shopping",
      },
      content: `<p>${verb} <strong>${escapeHtml(qtyLabel)}${escapeHtml(name)}</strong> for <strong>${price.toFixed(2)} gp</strong>?</p>`,
      rejectClose: false,
    },
    { cancelValue: false },
  );
}

async function promptSkillPicker(allowedSkills, { dc, failPct } = {}) {
  const labels = {
    per: "Persuasion",
    dec: "Deception",
    itm: "Intimidation",
  };
  const allowed =
    Array.isArray(allowedSkills) && allowedSkills.length > 0
      ? allowedSkills
      : ["per", "dec"];
  const options = allowed
    .map((id) => `<option value="${id}">${labels[id] ?? id}</option>`)
    .join("");
  // Set expectations: haggling is a gamble — failing raises the price, and
  // it's one attempt per item. dc/failPct come from the merchant.
  const dcNum = Number(dc);
  const failNum = Number(failPct);
  const riskLine =
    Number.isFinite(dcNum) && Number.isFinite(failNum)
      ? `<p>Beat <strong>DC ${dcNum}</strong> to lower the price. Fail and it rises about <strong>${failNum}%</strong> — one attempt per item.</p>`
      : `<p>Haggling is a gamble: succeed to lower the price, fail and it rises — one attempt per item.</p>`;
  if (allowed.length === 1) {
    const skillLabel = labels[allowed[0]] ?? allowed[0];
    const confirmed = await confirmInfinityDialog(
      {
        window: {
          title: `Bargain with ${skillLabel}?`,
          icon: "fa-solid fa-comments-dollar",
        },
        content: `<p>Use <strong>${escapeHtml(skillLabel)}</strong> to haggle?</p>${riskLine}`,
        rejectClose: false,
      },
      { cancelValue: false },
    );
    return confirmed ? allowed[0] : null;
  }
  return promptInfinityDialog(
    {
      window: {
        title: "Bargain — pick skill",
        icon: "fa-solid fa-comments-dollar",
      },
      content: `
        <p>Choose how you want to haggle:</p>
        ${riskLine}
        <label style="display:grid;gap:4px;">
          <span>Skill</span>
          <select name="skillId">${options}</select>
        </label>
      `,
      ok: {
        label: "Roll",
        callback: (_event, button) =>
          button?.form?.elements?.skillId?.value ?? null,
      },
      rejectClose: false,
    },
    { cancelValue: null },
  );
}
