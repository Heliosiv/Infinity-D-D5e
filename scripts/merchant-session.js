/**
 * Infinity D&D5e — MerchantSessionApp
 *
 * Player-facing buy/sell window. The GM opens a session for a player
 * via the Merchant Workspace; the player's client receives a
 * `session-open` event and pops this window with the merchant snapshot.
 *
 * Mutations to the player's own actor (item create/delete + currency
 * adjust) run here on the player client — the player owns their actor.
 * Stock decrements + bargain seal issuance route to the GM via the
 * socket layer.
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
  executeBuy,
  executeSell,
  postTransactionReceipt,
} from "./merchant/transaction.js";
import {
  MERCHANT_EVENTS,
  emitMerchantEvent,
  subscribe,
  requestMerchantSessionResume,
} from "./merchant/socket.js";
import {
  computeBargainOutcome,
  computePassiveBargainPct,
  runBargain,
} from "./merchant/bargain.js";
import { itemMatchesBuyFilter } from "./merchant/buy-filter.js";
import { totalWalletGp, sanitizeWallet } from "./merchant/currency.js";
import { formatCoinBreakdown } from "./loot/hoard-budget.js";
import { getItemRarity } from "./loot/tag-vocabulary.js";
import {
  bindRowDoubleClickOpen,
  openItemByUuid,
  wireBackgroundImageFallback,
} from "./loot/loot-app-shared.js";
import {
  escapeHtml,
  prettyRarity,
  prettyBargainTier,
  friendlyTransactionError,
} from "./ui-util.js";
import { SOUND_EVENTS, playModuleSound } from "./audio.js";
import { SETTING_KEYS, getSetting } from "./settings.js";
import {
  captureScroll,
  restoreScroll,
  bindScrollTracking,
} from "./merchant/scroll.js";

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

let commitCounterSeed = 0;
/** A short, unique id correlating a commit emit with its GM acknowledgement. */
function newCommitId() {
  commitCounterSeed += 1;
  return `c${commitCounterSeed}-${Math.random().toString(36).slice(2, 8)}`;
}

/** Scroll panes whose position survives action re-renders. */
const SCROLL_TARGETS = [
  { key: "rows", selector: ".ms-rows" },
  { key: "log", selector: ".ms-log" },
];

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
    this._previewActor = options.previewActor ?? null;
    this._activeTab = "buy";
    this._seals = new Map(); // `${itemRefId}::${side}` → seal
    this._buyQty = new Map(); // uuid → qty input value
    this._sellQty = new Map(); // itemId → qty input value
    this._log = []; // session-only transaction log
    this._spentGp = 0; // running total spent this session
    this._earnedGp = 0; // running total earned this session
    this._bargainPending = new Set();
    this._bargainTimers = new Map(); // sealKey → timeout id (seal-wait watchdog)
    this._pendingCommits = new Map(); // commitId → { side, itemName, timer }
    this._closingFromExternal = false;

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
        subscribe(MERCHANT_EVENTS.COMMIT_RESULT, (payload) =>
          this._onCommitResult(payload),
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
  }

  get title() {
    return this._title ?? "Merchant";
  }

  _onClose(options) {
    super._onClose?.(options);
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

  /**
   * GM acknowledged (or couldn't record) a buy/sell. On an explicit failure or a
   * timeout the player is told plainly, so a trade can't half-complete silently
   * (their sheet changed, the shop didn't). We deliberately do NOT auto-undo the
   * actor mutation: a merely-slow ack would otherwise double-revert. The GM and
   * player reconcile manually — rare (mostly a GM reload mid-trade).
   */
  _onCommitResult(payload) {
    if (!payload || payload.sessionId !== this._sessionId) return;
    if (
      payload.targetUserId &&
      payload.targetUserId !== globalThis.game?.user?.id
    ) {
      return;
    }
    const ctx = this._pendingCommits.get(payload.commitId);
    if (!ctx) return;
    globalThis.clearTimeout?.(ctx.timer);
    this._pendingCommits.delete(payload.commitId);
    if (payload.ok) return; // recorded cleanly — nothing to surface
    playModuleSound(SOUND_EVENTS.WARNING_MUTED);
    const verb = ctx.side === "sell" ? "sale" : "purchase";
    this._appendLog(
      "fail",
      `The shop didn't record your ${verb} of ${ctx.itemName} — your sheet changed, so check with your GM.`,
    );
    ui.notifications?.warn(
      `${MODULE_ID}: the shop couldn't record that ${verb}${payload.reason ? ` (${payload.reason})` : ""}. Your character sheet was already updated — ask your GM to reconcile.`,
    );
    if (this.rendered) this.render(false);
  }

  /** Arm a watchdog for a just-emitted commit; if no GM ack lands, warn the
   *  player rather than leave a silently-unrecorded trade. */
  _trackCommit(commitId, ctx) {
    const timer = globalThis.setTimeout?.(() => {
      if (!this._pendingCommits.delete(commitId)) return;
      playModuleSound(SOUND_EVENTS.WARNING_MUTED);
      const verb = ctx.side === "sell" ? "sale" : "purchase";
      this._appendLog(
        "fail",
        `No response from the GM on your ${verb} of ${ctx.itemName} — it may not have reached the shop.`,
      );
      ui.notifications?.warn(
        `${MODULE_ID}: no response from the GM on that ${verb}. Your sheet changed; confirm with your GM that the shop updated.`,
      );
      if (this.rendered) this.render(false);
    }, COMMIT_ACK_TIMEOUT_MS);
    this._pendingCommits.set(commitId, { ...ctx, timer });
  }

  /* -------------------- context -------------------- */

  async _prepareContext() {
    const actor = this._previewMode ? this._previewActor : resolvePlayerActor();
    const wallet = sanitizeWallet(actor?.system?.currency);
    const walletLabel =
      formatCoinBreakdown(wallet) || `${totalWalletGp(wallet).toFixed(2)} gp`;

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

    const sellRows = actor
      ? actor.items
          .filter(isSellable)
          // "Buys From Players" filter: only show what this merchant will buy.
          .filter((doc) => itemMatchesBuyFilter(this._merchant.buyFilter, doc))
          .map((doc) => this._buildSellRow(doc, passivePct))
          .filter(Boolean)
      : [];

    return {
      merchant: {
        ...this._merchant,
        art: this._merchant.art || FALLBACK_ART,
      },
      walletLabel,
      merchantGoldLabel: formatMerchantGold(this._merchant.goldOnHand),
      passiveHaggleLabel: formatPassiveHaggle(passivePct),
      previewMode: this._previewMode,
      previewNoActor: this._previewMode && !actor,
      noActor: !actor,
      buyActive: this._activeTab === "buy",
      sellActive: this._activeTab === "sell",
      buyRows,
      sellRows,
      log: this._log.slice(-30),
      sessionSpentLabel:
        this._spentGp > 0 ? `${this._spentGp.toFixed(2)} gp` : "",
      sessionEarnedLabel:
        this._earnedGp > 0 ? `${this._earnedGp.toFixed(2)} gp` : "",
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
          try {
            const doc = await fromUuid(uuid);
            if (!doc) {
              cache.set(uuid, null);
              return;
            }
            const snapshot =
              typeof doc.toObject === "function" ? doc.toObject() : { ...doc };
            if (!snapshot.uuid) snapshot.uuid = doc.uuid ?? uuid;
            cache.set(uuid, snapshot);
          } catch (error) {
            console.warn(`${MODULE_ID} | failed to resolve ${uuid}`, error);
            cache.set(uuid, null);
          }
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
    const ownedQty = Math.max(
      1,
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
    if (listGp <= 0) return null; // hide free items
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
    const cannotSell = sellableQty < 1;
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
      goldLimited,
      affordLabel: goldLimited ? `Shop can afford ${sellableQty}` : "",
      baseLabel: `${listGp.toFixed(2)} gp`,
      finalLabel: `${finalGp.toFixed(2)} gp`,
      // Sell payout: a negative delta is a BONUS, so flip the sign for display.
      priceDeltaLabel: showDelta ? formatDelta(-effectiveDeltaPct) : "",
      deltaClass: effectiveDeltaPct < 0 ? "down" : "up",
      passiveActive: !seal && showDelta,
      bargainLocked: Boolean(seal) || this._bargainPending.has(sealKey),
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
    if (root) {
      root.classList.toggle(
        "mw-no-anim",
        getSetting(SETTING_KEYS.ANIMATIONS) === false,
      );
      root.classList.toggle(
        "mw-no-glow",
        getSetting(SETTING_KEYS.RARITY_GLOW) === false,
      );
    }

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
    }

    // Preserve scroll position across action re-renders (buy, bargain, tab…).
    if (root) {
      bindScrollTracking(root, SCROLL_TARGETS, () => {
        this._scroll = captureScroll(root, SCROLL_TARGETS);
      });
      restoreScroll(root, SCROLL_TARGETS, this._scroll);
    }
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
    const row = this._merchant.items.find((r) => r.uuid === uuid);
    if (!row) return;
    const item = await fromUuid(uuid).catch(() => null);
    if (!item) {
      playModuleSound(SOUND_EVENTS.WARNING_MUTED);
      ui.notifications?.warn("That item isn't available anymore.");
      return;
    }
    const actor = resolvePlayerActor();
    if (!actor) {
      playModuleSound(SOUND_EVENTS.WARNING_MUTED);
      ui.notifications?.warn(
        "Pick a character first — ask your GM to assign you one.",
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
    const result = await executeBuy({
      actor,
      merchant: this._merchant,
      row,
      item: itemObj,
      qty,
      seal,
      passivePct,
      notify: false,
    });
    if (!result.ok) {
      const message = friendlyTransactionError(result.reason);
      ui.notifications?.warn(message);
      playModuleSound(SOUND_EVENTS.WARNING_MUTED);
      this._appendLog("fail", `Couldn't buy — ${message}`);
      this.render(false);
      return;
    }
    // Tell the GM to update stock + burn seal, and watch for the acknowledgement
    // so a trade can't silently half-complete if the GM didn't record it.
    const commitId = newCommitId();
    emitMerchantEvent(MERCHANT_EVENTS.COMMIT_PURCHASE, {
      sessionId: this._sessionId,
      itemUuid: uuid,
      qty,
      sealId: result.sealId,
      totalGp: result.totalGp,
      commitId,
    });
    this._trackCommit(commitId, { side: "buy", itemName: result.itemName });
    this._seals.delete(sealKey);
    this._spentGp = roundGp(this._spentGp + result.totalGp);
    playModuleSound(SOUND_EVENTS.MERCHANT_PURCHASE);
    this._appendLog(
      "buy",
      `Bought ${result.qty}× ${result.itemName} for ${result.totalGp.toFixed(2)} gp`,
    );
    await postTransactionReceipt({
      side: "buy",
      actor,
      merchant: this._merchant,
      itemName: result.itemName,
      qty: result.qty,
      unitGp: result.unitGp,
      totalGp: result.totalGp,
      bargainTier: seal?.tier ?? null,
      rollTotal: seal?.rollTotal ?? null,
      dc: seal?.dc ?? null,
    });
    this.render(false);
  }

  static _onSellN(_event, target) {
    const itemId = target?.dataset?.itemId;
    const qty = Math.max(1, Math.floor(Number(this._sellQty.get(itemId) ?? 1)));
    return this._performSell(itemId, qty);
  }

  async _performSell(itemId, qty) {
    if (this._previewMode) return this._previewSell(itemId, qty);
    const actor = resolvePlayerActor();
    if (!actor) {
      playModuleSound(SOUND_EVENTS.WARNING_MUTED);
      ui.notifications?.warn(
        "Pick a character first — ask your GM to assign you one.",
      );
      return;
    }
    if (!itemId) return;
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
    const result = await executeSell({
      actor,
      merchant: this._merchant,
      ownedItem,
      qty,
      seal,
      passivePct,
      notify: false,
    });
    if (!result.ok) {
      const message = friendlyTransactionError(result.reason);
      ui.notifications?.warn(message);
      playModuleSound(SOUND_EVENTS.WARNING_MUTED);
      this._appendLog("fail", `Couldn't sell — ${message}`);
      this.render(false);
      return;
    }
    const commitId = newCommitId();
    emitMerchantEvent(MERCHANT_EVENTS.COMMIT_SALE, {
      sessionId: this._sessionId,
      itemUuid: itemId,
      qty,
      sealId: result.sealId,
      totalGp: result.totalGp,
      commitId,
      // Lets the GM recompute the payout server-side (the item is gone now).
      itemSnapshot: result.itemSnapshot,
    });
    this._trackCommit(commitId, { side: "sell", itemName: result.itemName });
    this._seals.delete(sealKey);
    this._earnedGp = roundGp(this._earnedGp + result.totalGp);
    playModuleSound(SOUND_EVENTS.MERCHANT_SALE);
    this._appendLog(
      "sell",
      `Sold ${result.qty}× ${result.itemName} for ${result.totalGp.toFixed(2)} gp`,
    );
    await postTransactionReceipt({
      side: "sell",
      actor,
      merchant: this._merchant,
      itemName: result.itemName,
      qty: result.qty,
      unitGp: result.unitGp,
      totalGp: result.totalGp,
      bargainTier: seal?.tier ?? null,
      rollTotal: seal?.rollTotal ?? null,
      dc: seal?.dc ?? null,
    });
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
    const sealKey = `${refId}::${side}`;
    if (this._seals.has(sealKey) || this._bargainPending.has(sealKey)) return;
    const actor = resolvePlayerActor();
    if (!actor) {
      playModuleSound(SOUND_EVENTS.WARNING_MUTED);
      ui.notifications?.warn(
        "Pick a character first — ask your GM to assign you one.",
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
    if (!outcome.ok) {
      this._bargainPending.delete(sealKey);
      ui.notifications?.warn(
        friendlyTransactionError(outcome.reason ?? "cancelled"),
      );
      this.render(false);
      return;
    }
    emitMerchantEvent(MERCHANT_EVENTS.BARGAIN_RESULT, {
      sessionId: this._sessionId,
      itemUuid: refId,
      side,
      skillId,
      rollTotal: outcome.rollTotal,
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
        `${MODULE_ID}: this item has no price to preview.`,
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
        `${MODULE_ID}: pick a character when opening the preview to try selling.`,
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
      ui.notifications?.info(`${MODULE_ID}: this item has no resale value.`);
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

/**
 * Subscribe to SESSION_OPEN events for this client. When the GM opens
 * a session targeted at this user, open the session window
 * automatically.
 */
export function registerMerchantSessionAutoOpen() {
  if (autoOpenRegistered) return;
  autoOpenRegistered = true;
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
  requestMerchantSessionResume();
  globalThis.Hooks?.on?.("userConnected", (user, connected) => {
    if (connected && user?.isGM) requestMerchantSessionResume();
  });
}

/* ------------------------------------------------------------------ *
 * Helpers
 * ------------------------------------------------------------------ */

function resolvePlayerActor() {
  const assigned = globalThis.game?.user?.character;
  if (assigned) return assigned;
  // Fall back: first character actor the user owns.
  const actors = globalThis.game?.actors;
  if (!actors) return null;
  return (
    actors.find?.(
      (a) =>
        a?.type === "character" &&
        a?.testUserPermission?.(globalThis.game?.user, "OWNER"),
    ) ?? null
  );
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
 * confirmed (or when no dialog implementation exists, so it never blocks a
 * headless flow), false when declined or dismissed.
 */
async function confirmTransaction({ side, name, qty, totalGp }) {
  const DialogV2 = foundry?.applications?.api?.DialogV2;
  if (typeof DialogV2?.confirm !== "function") return true;
  const verb = side === "sell" ? "Sell" : "Buy";
  const qtyLabel = Number(qty) > 1 ? `${qty}× ` : "";
  const price = Number(totalGp) || 0;
  try {
    return await DialogV2.confirm({
      window: {
        title: `${verb} ${name}?`,
        icon:
          side === "sell" ? "fa-solid fa-coins" : "fa-solid fa-cart-shopping",
      },
      content: `<p>${verb} <strong>${escapeHtml(qtyLabel)}${escapeHtml(name)}</strong> for <strong>${price.toFixed(2)} gp</strong>?</p>`,
      rejectClose: false,
    });
  } catch {
    return false;
  }
}

async function promptSkillPicker(allowedSkills, { dc, failPct } = {}) {
  const DialogV2 = foundry?.applications?.api?.DialogV2;
  const labels = {
    per: "Persuasion",
    dec: "Deception",
    itm: "Intimidation",
  };
  const allowed =
    Array.isArray(allowedSkills) && allowedSkills.length > 0
      ? allowedSkills
      : ["per", "dec"];
  if (allowed.length === 1) return allowed[0];
  if (!DialogV2) return allowed[0];
  const options = allowed
    .map((id) => `<option value="${id}">${labels[id] ?? id}</option>`)
    .join("");
  // Set expectations: haggling is a gamble — failing raises the price, and
  // it's one attempt per item. dc/failPct come from the merchant.
  const dcNum = Number(dc);
  const failNum = Number(failPct);
  const riskLine =
    Number.isFinite(dcNum) && Number.isFinite(failNum)
      ? `<p style="opacity:0.85;">Beat <strong>DC ${dcNum}</strong> to lower the price. Fail and it rises about <strong>${failNum}%</strong> — one attempt per item.</p>`
      : `<p style="opacity:0.85;">Haggling is a gamble: succeed to lower the price, fail and it rises — one attempt per item.</p>`;
  let picked = null;
  try {
    picked = await DialogV2.prompt({
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
    });
  } catch {
    picked = null;
  }
  return picked;
}
