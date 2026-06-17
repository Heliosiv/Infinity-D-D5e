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

const MODULE_ID = "infinity-dnd5e";
const TEMPLATE_PATH = `modules/${MODULE_ID}/templates/shop-picker.hbs`;
const FALLBACK_ART = "icons/svg/shop.svg";

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
    },
  };

  static PARTS = {
    body: { template: TEMPLATE_PATH },
  };

  /** Open (or focus) the player's Shops picker. GM-guarded: GMs use the
   *  Merchant Workspace, not this door. */
  static open() {
    if (globalThis.game?.user?.isGM) {
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
    this._loading = true;
    this._loadTimer = null; // watchdog so the loading spinner can't hang forever
    this._pending = new Set(); // merchantIds the player is waiting on (knock/entering)
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
        if (!user?.isGM) return;
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
    return Boolean(globalThis.game?.users?.activeGM);
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
      return;
    }
    this._loading = true;
    emitMerchantEvent(MERCHANT_EVENTS.SHOP_LIST_REQUEST, {});
    // Don't spin forever if no reply lands (GM disconnects mid-request, the GM
    // handler throws, or the GM's socket isn't ready yet): fall back to the
    // resolved empty/list state after a short wait.
    this._loadTimer = globalThis.setTimeout?.(() => {
      this._loadTimer = null;
      if (this._loading) {
        this._loading = false;
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
    this._loading = false;
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
    const shops = this._shops.map((s) => ({
      id: s.id,
      name: s.name,
      art: s.art || FALLBACK_ART,
      description: s.description || "",
      knock: s.selfServiceMode === "knock",
      pending: this._pending.has(s.id),
    }));
    return {
      noGm,
      loading: this._loading && !noGm,
      shops,
      hasShops: shops.length > 0,
    };
  }

  _onRender(context, options) {
    super._onRender?.(context, options);
    if (this.element) {
      // Recover broken shop thumbnails — fall back to the shop glyph (the same
      // one empty art uses), not the loot default item-bag.
      wireBackgroundImageFallback(this.element, ".sp-row__art", FALLBACK_ART);
    }
  }

  static _onOpenShop(_event, target) {
    const merchantId = target?.dataset?.merchantId;
    if (!merchantId) return;
    // Already waiting on this shop — don't re-fire (the row shows a waiting
    // state); a second request would just spam the GM.
    if (this._pending.has(merchantId)) return;
    if (!globalThis.game?.users?.activeGM) {
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
}
