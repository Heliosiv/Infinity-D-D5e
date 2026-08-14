/**
 * Infinity D&D5e — ShopPickerApp
 *
 * Player-facing "Shops" launcher (the storefront door). A player opens it from
 * the non-GM scene control; it asks the GM (via SHOP_LIST_REQUEST) which
 * merchants they may self-open, renders the sanitized reply, and on click sends
 * SHOP_REQUEST so the GM opens (or, for "knock" shops, approves) a live session
 * — which then pops via the existing registerMerchantSessionAutoOpen path.
 *
 * Self-contained on purpose: it never reads the world MERCHANTS setting (that
 * would leak every shop's gold/markups/overrides) and never reuses the GM-only
 * dashboard. All it ever sees is the sanitized {id, name, art, description,
 * selfServiceMode} projection the GM sends back.
 */

import {
  MERCHANT_EVENTS,
  emitMerchantEvent,
  subscribe,
} from "./merchant/socket.js";
import { wireBackgroundImageFallback } from "./loot/loot-app-shared.js";
import { SOUND_EVENTS, playModuleSound } from "./audio.js";
import { openSingleton } from "./infinity-app.js";
import { isFullGM } from "./permissions.js";
import { authoritativeGMId } from "./socket-authority.js";
import {
  clearMerchantPendingReview,
  listMerchantPendingReviews,
} from "./merchant/client-pending.js";
import { confirmInfinityDialog } from "./dialog-contract.js";
import { escapeHtml } from "./ui-util.js";
import {
  getControlledMerchantActors,
  getPreferredMerchantActorId,
  setPreferredMerchantActorId,
} from "./merchant-session.js";

const MODULE_ID = "infinity-dnd5e";
const TEMPLATE_PATH = `modules/${MODULE_ID}/templates/shop-picker.hbs`;
const FALLBACK_ART = "icons/svg/chest.svg";

const { ApplicationV2, HandlebarsApplicationMixin } = foundry.applications.api;

export class ShopPickerApp extends HandlebarsApplicationMixin(ApplicationV2) {
  static _instance = null;

  static DEFAULT_OPTIONS = {
    id: "infinity-dnd5e-shop-picker",
    tag: "section",
    classes: ["infinity-dnd5e", "infinity-shop-picker"],
    window: {
      title: "Shops",
      icon: "fa-solid fa-store",
      resizable: true,
    },
    position: { width: 440, height: 560 },
    actions: {
      openShop: ShopPickerApp._onOpenShop,
      refresh: ShopPickerApp._onRefresh,
      clearReviewedTrade: ShopPickerApp._onClearReviewedTrade,
    },
  };

  static PARTS = {
    body: { template: TEMPLATE_PATH },
  };

  /** Open (or focus) the player's Shops picker. Full GMs use the Merchant
   *  Workspace; Assistant GMs who play a character use this player door. */
  static open() {
    if (isFullGM()) {
      ui.notifications?.info(
        "The Shops picker is for players — GMs use the Merchant Workspace.",
      );
      return null;
    }
    playModuleSound(SOUND_EVENTS.UI_OPEN);
    return openSingleton(ShopPickerApp, () => new ShopPickerApp());
  }

  constructor(options = {}) {
    super(options);
    this._shops = []; // sanitized projections from the GM
    this._globallyClosed = false;
    this._loading = true;
    this._requestFailed = false;
    this._query = "";
    this._loadTimer = null; // watchdog so the loading spinner can't hang forever
    this._pending = new Set(); // merchantIds the player is waiting on (knock/entering)
    this._reviewIdentities = new Map();
    this._unsubs = [
      subscribe(MERCHANT_EVENTS.SHOP_LIST_REPLY, (payload) =>
        this._onShopList(payload),
      ),
      subscribe(MERCHANT_EVENTS.SHOP_RESULT, (payload) =>
        this._onShopResult(payload),
      ),
      // When the GM actually opens our session, clear the waiting state.
      subscribe(MERCHANT_EVENTS.SESSION_OPEN, (payload) => {
        if (!payload || payload.targetUserId !== globalThis.game?.user?.id) {
          return;
        }
        if (this._pending.delete(payload.merchantId) && this.rendered) {
          this.render(false);
        }
      }),
    ];
    // Self-heal the "no GM online" state when a GM connects. Gate to GM
    // connect/disconnect events: a stray *player* login shouldn't blanket-clear
    // this player's live knock state (see _requestList) and flash the spinner.
    this._userConnHook =
      globalThis.Hooks?.on?.("userConnected", (user, _connected) => {
        if (!isFullGM(user)) return;
        if (this.rendered) {
          this._requestList({ clearPending: true });
          this.render(false);
        }
      }) ?? null;
    this._requestList();
  }

  _onClose(options) {
    super._onClose?.(options);
    if (this._loadTimer != null) {
      globalThis.clearTimeout?.(this._loadTimer);
      this._loadTimer = null;
    }
    for (const fn of this._unsubs ?? []) {
      try {
        fn();
      } catch {}
    }
    this._unsubs = [];
    if (this._userConnHook != null) {
      try {
        globalThis.Hooks?.off?.("userConnected", this._userConnHook);
      } catch {}
      this._userConnHook = null;
    }
    ShopPickerApp._instance = null;
  }

  /** Whether a GM is connected to actually host a session. */
  get _hasActiveGM() {
    return Boolean(authoritativeGMId());
  }

  /** Ask the GM for the player's allowed self-service shops. `clearPending` wipes
   *  any "waiting for the GM" knock rows — only do that on a genuine recovery
   *  point (user Refresh, or a GM (re)connecting), NOT on every routine resync
   *  (e.g. one shop's denial self-heal), which would prematurely re-enable other
   *  shops the player is still legitimately waiting on. */
  _requestList({ clearPending = false } = {}) {
    if (this._loadTimer != null) {
      globalThis.clearTimeout?.(this._loadTimer);
      this._loadTimer = null;
    }
    // A knock whose GM disconnected/reloaded before answering would otherwise
    // stay disabled forever (no SESSION_OPEN/SHOP_RESULT ever arrives); the
    // recovery callers clear it so those rows become clickable again.
    if (clearPending) this._pending.clear();
    if (!this._hasActiveGM) {
      this._loading = false;
      this._requestFailed = false;
      return;
    }
    this._loading = true;
    this._requestFailed = false;
    emitMerchantEvent(MERCHANT_EVENTS.SHOP_LIST_REQUEST, {});
    // Don't spin forever if no reply lands (GM disconnects mid-request, the GM
    // handler throws, or the GM's socket isn't ready yet): fall back to the
    // resolved empty/list state after a short wait.
    this._loadTimer = globalThis.setTimeout?.(() => {
      this._loadTimer = null;
      if (this._loading) {
        this._loading = false;
        this._requestFailed = true;
        if (this.rendered) this.render(false);
      }
    }, 5000);
  }

  _onShopList(payload) {
    if (!payload) return;
    if (
      payload.targetUserId &&
      payload.targetUserId !== globalThis.game?.user?.id
    ) {
      return;
    }
    if (this._loadTimer != null) {
      globalThis.clearTimeout?.(this._loadTimer);
      this._loadTimer = null;
    }
    this._shops = Array.isArray(payload.shops) ? payload.shops : [];
    this._globallyClosed = payload.globallyClosed === true;
    if (this._globallyClosed) this._pending.clear();
    this._loading = false;
    this._requestFailed = false;
    if (this.rendered) this.render(false);
  }

  /** A shop-open request was rejected/declined — surface it and refresh the
   *  list so a stale (now-closed) row self-heals. */
  _onShopResult(payload) {
    if (!payload || payload.targetUserId !== globalThis.game?.user?.id) return;
    const name =
      this._shops.find((s) => s.id === payload.merchantId)?.name ?? "that shop";
    this._pending.delete(payload.merchantId);
    ui.notifications?.info(
      payload.outcome === "denied"
        ? `The GM turned you away from ${name}.`
        : `${name} isn't available right now.`,
    );
    this._requestList(); // self-heal: drop a row the GM just closed
    if (this.rendered) this.render(false);
  }

  async _prepareContext() {
    const noGm = !this._hasActiveGM;
    const controlledActors = getControlledMerchantActors();
    const actor = resolveShopperActor(controlledActors);
    const shops = this._shops.map((s) => ({
      id: s.id,
      name: s.name,
      art: s.art || FALLBACK_ART,
      description: s.description || "",
      knock: s.selfServiceMode === "knock",
      pending: this._pending.has(s.id),
      actorRequired: !actor,
    }));
    this._reviewIdentities.clear();
    let reviewRecords = [];
    try {
      reviewRecords = listMerchantPendingReviews();
    } catch {
      // A malformed/unavailable client setting stays untouched and invisible;
      // its storage layer already fails closed rather than guessing.
    }
    const savedTradeReviews = reviewRecords.map((record, index) => {
      const actionId = `saved-review-${index}`;
      const summary = `${record.context.side === "sell" ? "Sale" : "Purchase"} of ${record.context.qty}x ${record.context.itemName} at ${record.context.merchantName} for quoted ${Number(record.context.totalGp).toFixed(2)} gp`;
      this._reviewIdentities.set(actionId, {
        originUserId: record.originUserId,
        commitId: record.commitId,
        summary,
      });
      return {
        actionId,
        summary,
        receivedAt: formatSavedReviewTime(record.review.receivedAt),
        reason: savedReviewReason(record.review.reason),
      };
    });
    return {
      noGm,
      loading: this._loading && !noGm,
      requestFailed: this._requestFailed && !noGm,
      globallyClosed: this._globallyClosed && !noGm,
      shops,
      hasShops: shops.length > 0,
      hasPending: shops.some((shop) => shop.pending),
      actorName: actor?.name ?? "No character selected",
      hasActor: Boolean(actor),
      needsActorChoice: !actor && controlledActors.length > 1,
      canSwitchActor: controlledActors.length > 1,
      actorOptions: controlledActors.map((candidate) => ({
        id: String(candidate.id ?? ""),
        name: String(candidate.name ?? "Character"),
        selected: String(candidate.id ?? "") === String(actor?.id ?? ""),
      })),
      query: this._query,
      savedTradeReviews,
      hasSavedTradeReviews: savedTradeReviews.length > 0,
    };
  }

  _onRender(context, options) {
    super._onRender?.(context, options);
    if (this.element) {
      // Recover broken shop thumbnails — fall back to the shop glyph (the same
      // one empty art uses), not the loot default item-bag.
      wireBackgroundImageFallback(this.element, ".sp-row__art", FALLBACK_ART);
      this._wireSearch(this.element);
      this._wireActorSelect(this.element);
    }
  }

  _wireActorSelect(root) {
    const select = root.querySelector?.('[data-role="shopper-actor"]');
    if (!select) return;
    select.addEventListener("change", () => {
      setPreferredMerchantActorId(select.value);
      this.render(false);
    });
  }

  /** Filter only the already-sanitized rows on this client. No search text is
   * sent to the GM and no hidden merchant fields enter the DOM. */
  _wireSearch(root) {
    const input = root.querySelector?.('[data-role="shop-search"]');
    if (!input) return;
    input.value = this._query;
    const apply = () => {
      const rawQuery = String(input.value ?? "");
      const query = rawQuery.trim().toLocaleLowerCase();
      this._query = rawQuery;
      let visible = 0;
      for (const row of root.querySelectorAll?.(".sp-row") ?? []) {
        const matches =
          !query || row.textContent.toLocaleLowerCase().includes(query);
        row.hidden = !matches;
        if (matches) visible += 1;
      }
      const empty = root.querySelector?.('[data-role="shop-search-empty"]');
      if (empty) empty.hidden = visible > 0 || !query;
      const status = root.querySelector?.('[data-role="shop-search-status"]');
      if (status) {
        status.textContent = query
          ? `${visible} shop${visible === 1 ? "" : "s"} match your search.`
          : `${this._shops.length} shop${this._shops.length === 1 ? "" : "s"} available.`;
      }
    };
    input.addEventListener("input", apply);
    apply();
  }

  static _onOpenShop(_event, target) {
    const merchantId = target?.dataset?.merchantId;
    if (!merchantId) return;
    if (!resolveShopperActor()) {
      ui.notifications?.warn(
        "Choose a controlled character before entering a shop.",
      );
      this.render(false);
      return;
    }
    // Already waiting on this shop — don't re-fire (the row shows a waiting
    // state); a second request would just spam the GM.
    if (this._pending.has(merchantId)) return;
    if (this._globallyClosed) {
      ui.notifications?.warn("Shops are temporarily closed by the GM.");
      this.render(false);
      return;
    }
    if (!this._hasActiveGM) {
      ui.notifications?.warn("Shops are closed — no GM is online right now.");
      this.render(false);
      return;
    }
    emitMerchantEvent(MERCHANT_EVENTS.SHOP_REQUEST, { merchantId });
    // Show a persistent waiting state on the row (cleared on SESSION_OPEN or
    // SHOP_RESULT) so the request never feels like a dead click. The session
    // chime plays when the window actually opens (registerMerchantSessionAutoOpen).
    const shop = this._shops?.find((s) => s.id === merchantId);
    const name = shop?.name ?? "the shop";
    this._pending.add(merchantId);
    ui.notifications?.info(
      shop?.knock || shop?.selfServiceMode === "knock"
        ? `Knocking at ${name} — waiting for the GM…`
        : `Entering ${name}…`,
    );
    this.render(false);
  }

  static _onRefresh() {
    this._requestList({ clearPending: true });
    this.render(false);
  }

  static async _onClearReviewedTrade(_event, target) {
    const identity = this._reviewIdentities.get(
      String(target?.dataset?.reviewActionId ?? ""),
    );
    if (!identity) {
      ui.notifications?.warn("That saved trade warning is no longer current.");
      this.render(false);
      return;
    }
    const confirmed = await confirmInfinityDialog({
      window: {
        title: "Reviewed with the GM?",
        icon: "fa-solid fa-clipboard-check",
      },
      content: `<p><strong>${escapeHtml(identity.summary)}</strong></p><p>This only removes this device's saved warning. It changes no Actor, inventory, wallet, or shop data, and this trade will not be retried.</p><p>Clear it only after you and the GM have reviewed the campaign state.</p>`,
      rejectClose: false,
    });
    if (!confirmed) return;
    try {
      const cleared = await clearMerchantPendingReview(
        identity.originUserId,
        identity.commitId,
      );
      const stillStored = listMerchantPendingReviews().some(
        (record) =>
          record.originUserId === identity.originUserId &&
          record.commitId === identity.commitId,
      );
      if (cleared !== true || stillStored) {
        throw new Error("MerchantReviewClearNotConfirmed");
      }
      ui.notifications?.info(
        "The reviewed warning was removed from this device. Campaign data was not changed.",
      );
    } catch {
      ui.notifications?.warn(
        "The saved warning could not be removed safely. It remains on this device.",
      );
    }
    this.render(false);
  }
}

function formatSavedReviewTime(timestamp) {
  const value = Number(timestamp);
  if (!Number.isFinite(value) || value < 1) return "time unavailable";
  return new Date(value).toLocaleString();
}

function savedReviewReason(reason) {
  return reason === "transaction-history-expired"
    ? "The GM's retained history can no longer prove whether this old trade completed."
    : "The GM pinned this trade because it may have partially completed.";
}

/** Resolve only a character this user may legitimately act through. Foundry's
 * Assistant-GM document visibility must never become implicit character choice. */
function resolveShopperActor(controlledActors = getControlledMerchantActors()) {
  const preferredId = getPreferredMerchantActorId();
  if (preferredId) {
    return (
      controlledActors.find(
        (candidate) => String(candidate?.id ?? "") === preferredId,
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
