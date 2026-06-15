/**
 * Infinity D&D5e — ReputationViewApp
 *
 * Player-facing, read-only window listing the factions the GM has revealed,
 * with the party's standing and a player-facing note. Players open it from
 * the non-GM scene control (or Shift+R). It asks the GM for the revealed
 * list (LIST_REQUEST → LIST_REPLY) and refreshes live on STATE_UPDATE when
 * the GM edits a faction.
 *
 * Self-contained: it only ever sees the sanitized projection the GM sends
 * (id, name, category, img, standing, tier, band, playerNote) — never the
 * raw world records (GM notes, history, per-character data). A GM who opens
 * it previews exactly what players see, sourced locally.
 */

import {
  REPUTATION_EVENTS,
  emitReputationEvent,
  subscribe,
} from "./reputation/socket.js";
import { listRevealedForPlayers } from "./reputation/store.js";
import { wireBackgroundImageFallback } from "./loot/loot-app-shared.js";
import { prettyStanding } from "./ui-util.js";
import { SOUND_EVENTS, playModuleSound } from "./audio.js";

const MODULE_ID = "infinity-dnd5e";
const TEMPLATE_PATH = `modules/${MODULE_ID}/templates/reputation-view.hbs`;
const FALLBACK_IMG = "icons/svg/mystery-man.svg";
const LIST_TIMEOUT_MS = 5000;

const { ApplicationV2, HandlebarsApplicationMixin } = foundry.applications.api;

export class ReputationViewApp extends HandlebarsApplicationMixin(
  ApplicationV2,
) {
  static _instance = null;

  static DEFAULT_OPTIONS = {
    id: "infinity-dnd5e-reputation-view",
    tag: "section",
    classes: ["infinity-dnd5e", "infinity-reputation-view"],
    window: {
      title: "Reputation",
      icon: "fa-solid fa-handshake",
      resizable: true,
    },
    position: { width: 420, height: 560 },
    actions: {
      refresh: ReputationViewApp._onRefresh,
    },
  };

  static PARTS = {
    body: { template: TEMPLATE_PATH },
  };

  /** Open (or focus) the player's Reputation view. */
  static open() {
    if (!ReputationViewApp._instance) {
      ReputationViewApp._instance = new ReputationViewApp();
    }
    const app = ReputationViewApp._instance;
    playModuleSound(SOUND_EVENTS.UI_OPEN);
    if (app.rendered) app.bringToFront();
    else app.render(true);
    return app;
  }

  constructor(options = {}) {
    super(options);
    this._factions = []; // sanitized projections
    this._loading = true;
    this._requestFailed = false;
    this._requestId = null;
    this._requestTimer = null;
    this._unsubs = [
      subscribe(REPUTATION_EVENTS.LIST_REPLY, (payload) =>
        this._onListReply(payload),
      ),
      subscribe(REPUTATION_EVENTS.STATE_UPDATE, (payload) =>
        this._onStateUpdate(payload),
      ),
    ];
    // Self-heal "no GM online" when a GM connects (and re-check on disconnect).
    this._userConnHook =
      globalThis.Hooks?.on?.("userConnected", () => {
        if (this.rendered) {
          this._loadList();
          this.render(false);
        }
      }) ?? null;
    this._loadList();
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
    ReputationViewApp._instance = null;
  }

  get _isGM() {
    return Boolean(globalThis.game?.user?.isGM);
  }

  /** Whether a GM is connected to answer a player's request. */
  get _hasActiveGM() {
    return Boolean(globalThis.game?.users?.activeGM);
  }

  /** Load the revealed list — locally for a GM preview, else ask the GM. */
  _loadList() {
    if (this._isGM) {
      this._clearRequestTimer();
      this._factions = listRevealedForPlayers();
      this._loading = false;
      this._requestFailed = false;
      return;
    }
    this._requestList();
  }

  /** Ask the GM for the revealed-faction list. */
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
    emitReputationEvent(REPUTATION_EVENTS.LIST_REQUEST, {
      requestId: this._requestId,
    });
    this._requestTimer = globalThis.setTimeout?.(() => {
      this._requestTimer = null;
      this._loading = false;
      this._requestFailed = true;
      this._factions = [];
      if (this.rendered) this.render(false);
    }, LIST_TIMEOUT_MS);
  }

  _onListReply(payload) {
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
    this._factions = Array.isArray(payload.factions) ? payload.factions : [];
    this._loading = false;
    this._requestFailed = false;
    if (this.rendered) this.render(false);
  }

  /** A revealed faction changed — refresh from the broadcast projection. */
  _onStateUpdate(payload) {
    if (!payload) return;
    this._clearRequestTimer();
    this._factions = Array.isArray(payload.factions) ? payload.factions : [];
    this._loading = false;
    this._requestFailed = false;
    if (this.rendered) this.render(false);
  }

  async _prepareContext() {
    const noGm = !this._isGM && !this._hasActiveGM;
    const factions = this._factions.map((f) => ({
      id: f.id,
      name: f.name,
      category: f.category || "",
      img: f.img || FALLBACK_IMG,
      tier: f.tier,
      band: f.band,
      standingLabel: prettyStanding(f.standing),
      playerNote: f.playerNote || "",
    }));
    return {
      isGmPreview: this._isGM,
      noGm,
      loading: this._loading && !noGm,
      requestFailed: this._requestFailed && !noGm,
      factions,
      hasFactions: factions.length > 0,
    };
  }

  _onRender(context, options) {
    super._onRender?.(context, options);
    if (this.element) {
      wireBackgroundImageFallback(this.element, ".rv-row__art", FALLBACK_IMG);
    }
  }

  static _onRefresh() {
    this._loadList();
    this.render(false);
  }

  _clearRequestTimer() {
    if (this._requestTimer != null) {
      globalThis.clearTimeout?.(this._requestTimer);
      this._requestTimer = null;
    }
  }
}
