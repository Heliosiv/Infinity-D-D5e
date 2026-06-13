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

const MODULE_ID = "infinity-dnd5e";
const TEMPLATE_PATH = `modules/${MODULE_ID}/templates/shop-picker.hbs`;
const FALLBACK_ART = "icons/svg/shop.svg";
const SHOP_LIST_TIMEOUT_MS = 5000;

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
        `${MODULE_ID}: the Shops picker is for players — GMs use the Merchant Workspace.`,
      );
      return null;
    }
    if (!ShopPickerApp._instance) {
      ShopPickerApp._instance = new ShopPickerApp();
    }
    const app = ShopPickerApp._instance;
    playModuleSound(SOUND_EVENTS.UI_OPEN);
    if (app.rendered) app.bringToFront();
    else app.render(true);
    return app;
  }

  constructor(options = {}) {
    super(options);
    this._shops = []; // sanitized projections from the GM
    this._loading = true;
    this._requestFailed = false;
    this._requestId = null;
    this._requestTimer = null;
    this._unsubs = [
      subscribe(MERCHANT_EVENTS.SHOP_LIST_REPLY, (payload) =>
        this._onShopList(payload),
      ),
      subscribe(MERCHANT_EVENTS.SHOP_RESULT, (payload) =>
        this._onShopResult(payload),
      ),
    ];
    // Self-heal the "no GM online" state when a GM connects (and re-check on
    // disconnect). Mirrors module.js's existing userConnected hook.
    this._userConnHook =
      globalThis.Hooks?.on?.("userConnected", () => {
        if (this.rendered) {
          this._requestList();
          this.render(false);
        }
      }) ?? null;
    this._requestList();
  }

  _onClose(options) {
    super._onClose?.(options);
    this._clearRequestTimer();
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

  /** Ask the GM for the player's allowed self-service shops. */
  _requestList() {
    this._clearRequestTimer();
    this._requestFailed = false;
    if (!this._hasActiveGM) {
      this._loading = false;
      return;
    }
    this._loading = true;
    const userId = globalThis.game?.user?.id ?? "local";
    this._requestId = `${userId}:${Date.now()}:${Math.random()
      .toString(36)
      .slice(2, 10)}`;
    emitMerchantEvent(MERCHANT_EVENTS.SHOP_LIST_REQUEST, {
      requestId: this._requestId,
    });
    this._requestTimer = globalThis.setTimeout?.(() => {
      this._requestTimer = null;
      this._loading = false;
      this._requestFailed = true;
      this._shops = [];
      if (this.rendered) this.render(false);
    }, SHOP_LIST_TIMEOUT_MS);
  }

  _onShopList(payload) {
    if (!payload) return;
    if (
      payload.targetUserId &&
      payload.targetUserId !== globalThis.game?.user?.id
    ) {
      return;
    }
    if (
      payload.requestId &&
      this._requestId &&
      payload.requestId !== this._requestId
    ) {
      return;
    }
    this._clearRequestTimer();
    this._shops = Array.isArray(payload.shops) ? payload.shops : [];
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
    ui.notifications?.info(
      payload.outcome === "denied"
        ? `${MODULE_ID}: the GM turned you away from ${name}.`
        : `${MODULE_ID}: ${name} isn't available right now.`,
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
    }));
    return {
      noGm,
      loading: this._loading && !noGm,
      requestFailed: this._requestFailed && !noGm,
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
    if (!globalThis.game?.users?.activeGM) {
      ui.notifications?.warn(
        `${MODULE_ID}: shops are closed — no GM is online.`,
      );
      this.render(false);
      return;
    }
    emitMerchantEvent(MERCHANT_EVENTS.SHOP_REQUEST, { merchantId });
    // Interim feedback on every click so the request never feels like a dead
    // click. The session-open chime plays when the window actually opens (see
    // registerMerchantSessionAutoOpen); a rejection arrives via SHOP_RESULT.
    const shop = this._shops?.find((s) => s.id === merchantId);
    const name = shop?.name ?? "the shop";
    ui.notifications?.info(
      shop?.selfServiceMode === "knock"
        ? `${MODULE_ID}: knocking at ${name}…`
        : `${MODULE_ID}: entering ${name}…`,
    );
  }

  static _onRefresh() {
    this._requestList();
    this.render(false);
  }

  _clearRequestTimer() {
    if (this._requestTimer != null) {
      globalThis.clearTimeout?.(this._requestTimer);
      this._requestTimer = null;
    }
  }
}
