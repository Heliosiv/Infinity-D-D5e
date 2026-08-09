/**
 * Infinity D&D5e - Party Supplies (player read-only view)
 *
 * Players request a sanitized overview from the authoritative GM. A GM opening
 * the same app previews exactly what players receive, while the Quartermaster
 * remains the separate editing and automation surface.
 */

import { SOUND_EVENTS, playModuleSound } from "./audio.js";
import { openSingleton } from "./infinity-app.js";
import { buildPlayerResourceOverview } from "./resource/overview-service.js";
import { sanitizeResourceOverview } from "./resource/overview.js";
import {
  RESOURCE_EVENTS,
  emitResourceEvent,
  subscribe,
} from "./resource/socket.js";
import { isFullGM } from "./permissions.js";
import { authoritativeGMId } from "./socket-authority.js";
import { SETTING_KEYS, getSetting } from "./settings.js";

const MODULE_ID = "infinity-dnd5e";
const TEMPLATE_PATH = `modules/${MODULE_ID}/templates/resource-overview.hbs`;
const REQUEST_TIMEOUT_MS = 5000;

const { ApplicationV2, HandlebarsApplicationMixin } = foundry.applications.api;

export class ResourceOverviewApp extends HandlebarsApplicationMixin(
  ApplicationV2,
) {
  static _instance = null;

  static DEFAULT_OPTIONS = {
    id: "infinity-dnd5e-resource-overview",
    tag: "section",
    classes: ["infinity-dnd5e", "infinity-resource-overview"],
    window: {
      title: "Party Supplies",
      icon: "fa-solid fa-boxes-stacked",
      resizable: true,
    },
    position: { width: 540, height: 620 },
    actions: {
      refresh: ResourceOverviewApp._onRefresh,
    },
  };

  static PARTS = {
    body: { template: TEMPLATE_PATH },
  };

  static open() {
    playModuleSound(SOUND_EVENTS.UI_OPEN);
    return openSingleton(ResourceOverviewApp, () => new ResourceOverviewApp());
  }

  constructor(options = {}) {
    super(options);
    this._overview = null;
    this._loading = true;
    this._requestFailed = false;
    this._sharingEnabled =
      getSetting(SETTING_KEYS.RESOURCE_PLAYER_VIEW) !== false;
    this._requestId = null;
    this._requestTimer = null;
    this._lastFullGM = this._isFullGM;
    this._unsubs = [
      subscribe(RESOURCE_EVENTS.OVERVIEW_REPLY, (payload) =>
        this._onOverviewReply(payload),
      ),
      subscribe(RESOURCE_EVENTS.STATE_UPDATE, () => this._onStateUpdate()),
    ];
    this._userConnectionHook =
      globalThis.Hooks?.on?.("userConnected", () => {
        this._syncCurrentRole();
        this._loadOverview();
        if (this.rendered) this.render(false);
      }) ?? null;
    this._userUpdateHook =
      globalThis.Hooks?.on?.("updateUser", (user) => {
        if (user?.id !== globalThis.game?.user?.id) return;
        const transitioned = this._syncCurrentRole();
        if (!transitioned) return;
        // A demoted GM must not retain a privileged local preview while their
        // player request is in flight. Promotion similarly invalidates any
        // outstanding player request so a late reply cannot replace GM data.
        this._overview = null;
        this._requestFailed = false;
        this._loadOverview();
        if (this.rendered) this.render(false);
      }) ?? null;
    this._loadOverview();
  }

  _onClose(options) {
    super._onClose?.(options);
    this._clearRequestTimer();
    for (const unsubscribe of this._unsubs ?? []) {
      try {
        unsubscribe();
      } catch {
        // Best effort during Foundry shutdown.
      }
    }
    this._unsubs = [];
    if (this._userConnectionHook != null) {
      try {
        globalThis.Hooks?.off?.("userConnected", this._userConnectionHook);
      } catch {
        // Best effort during Foundry shutdown.
      }
      this._userConnectionHook = null;
    }
    if (this._userUpdateHook != null) {
      try {
        globalThis.Hooks?.off?.("updateUser", this._userUpdateHook);
      } catch {
        // Best effort during Foundry shutdown.
      }
      this._userUpdateHook = null;
    }
    ResourceOverviewApp._instance = null;
  }

  get _isFullGM() {
    return isFullGM();
  }

  get _hasActiveGM() {
    return Boolean(authoritativeGMId());
  }

  _loadOverview() {
    this._sharingEnabled =
      getSetting(SETTING_KEYS.RESOURCE_PLAYER_VIEW) !== false;
    if (this._isFullGM) {
      this._clearRequestTimer();
      this._requestId = null;
      try {
        this._overview = buildPlayerResourceOverview();
        this._requestFailed = false;
      } catch (error) {
        console.error(`${MODULE_ID} | failed to preview party supplies`, error);
        this._overview = null;
        this._requestFailed = true;
      }
      this._loading = false;
      return;
    }
    if (!this._sharingEnabled || !this._hasActiveGM) {
      this._clearRequestTimer();
      this._requestId = null;
      this._overview = null;
      this._loading = false;
      this._requestFailed = false;
      return;
    }
    this._requestOverview();
  }

  _requestOverview() {
    this._clearRequestTimer();
    this._overview = null;
    this._loading = true;
    this._requestFailed = false;
    const userId = globalThis.game?.user?.id ?? "local";
    this._requestId = `${userId}:${Date.now()}:${Math.random()
      .toString(36)
      .slice(2, 10)}`;
    emitResourceEvent(RESOURCE_EVENTS.OVERVIEW_REQUEST, {
      requestId: this._requestId,
    });
    this._requestTimer = globalThis.setTimeout?.(() => {
      this._requestTimer = null;
      this._requestId = null;
      this._loading = false;
      this._requestFailed = true;
      this._overview = null;
      if (this.rendered) this.render(false);
    }, REQUEST_TIMEOUT_MS);
  }

  _onOverviewReply(payload) {
    if (this._isFullGM) return;
    const currentUserId = globalThis.game?.user?.id;
    const requestId = String(payload?.requestId ?? "").trim();
    if (!currentUserId || payload?.targetUserId !== currentUserId) return;
    if (!requestId || !this._requestId || requestId !== this._requestId) return;
    this._clearRequestTimer();
    this._requestId = null;
    this._sharingEnabled = payload.enabled !== false;
    this._overview = payload.overview
      ? sanitizeResourceOverview(payload.overview)
      : null;
    this._loading = false;
    this._requestFailed = this._sharingEnabled && !this._overview;
    if (this.rendered) this.render(false);
  }

  _onStateUpdate() {
    if (!this.rendered) return;
    this._loadOverview();
    this.render(false);
  }

  async _prepareContext() {
    const overview = this._overview;
    const noGm = !this._isFullGM && !this._hasActiveGM;
    const disabled = !this._isFullGM && !this._sharingEnabled;
    const resources = (overview?.resources ?? []).map((resource) => ({
      ...resource,
      icon: resourceIcon(resource.id),
      isReady: resource.status === "ready",
      isLow: resource.status === "low",
      isCritical: resource.status === "critical",
      isStable: resource.status === "stable",
    }));
    const lastUpkeep = overview?.lastUpkeep
      ? {
          ...overview.lastUpkeep,
          outcomeLabel: overview.lastUpkeep.needsReview
            ? "Needs review"
            : overview.lastUpkeep.hasShortages
              ? "Shortages"
              : "Complete",
          rows: overview.lastUpkeep.rows.map((row) => ({
            ...row,
            forageNote: forageNote(row.forage),
            ok: row.outcome === "supplied",
            stateClass:
              row.outcome === "needs-review"
                ? "is-review"
                : row.supplied
                  ? "is-supplied"
                  : "is-short",
          })),
        }
      : null;
    return {
      isGmPreview: this._isFullGM,
      sharingDisabled: this._isFullGM && !this._sharingEnabled,
      disabled,
      noGm,
      loading: this._loading && !noGm && !disabled,
      requestFailed: this._requestFailed && !noGm && !disabled,
      hasOverview: Boolean(overview),
      hasParty: (overview?.partySize ?? 0) > 0,
      partySize: overview?.partySize ?? 0,
      autoTrigger: overview?.autoTrigger !== false,
      halfRations: overview?.halfRations === true,
      environment: overview?.environment ?? null,
      updatedLabel: formatUpdatedLabel(overview?.generatedAt),
      resources,
      hasResources: resources.length > 0,
      lastUpkeep,
    };
  }

  static _onRefresh() {
    this._loadOverview();
    this.render(false);
  }

  _clearRequestTimer() {
    if (this._requestTimer != null) {
      globalThis.clearTimeout?.(this._requestTimer);
      this._requestTimer = null;
    }
  }

  _syncCurrentRole() {
    const current = this._isFullGM;
    const transitioned = current !== this._lastFullGM;
    if (transitioned) {
      this._clearRequestTimer();
      this._requestId = null;
    }
    this._lastFullGM = current;
    return transitioned;
  }
}

function resourceIcon(id) {
  if (id === "food") return "fa-solid fa-bread-slice";
  if (id === "water") return "fa-solid fa-droplet";
  if (id === "light") return "fa-solid fa-fire-flame-simple";
  return "fa-solid fa-box";
}

function forageNote(forage) {
  if (!forage?.attempted) return "";
  if (forage.suppressed) return "Gathered; the best party haul was kept.";
  if (!forage.success) return "Foraged nothing.";
  const parts = [];
  if (forage.food > 0) parts.push(`+${forage.food} food`);
  if (forage.water > 0) parts.push(`+${forage.water} water`);
  return parts.length > 0 ? `Foraged ${parts.join(" / ")}.` : "Foraged.";
}

function formatUpdatedLabel(value) {
  if (value === null || value === undefined || value === "") return "";
  const numeric = Number(value);
  const date = new Date(Number.isFinite(numeric) ? numeric : value);
  if (!Number.isFinite(date.getTime())) return "";
  try {
    return new Intl.DateTimeFormat(undefined, {
      dateStyle: "medium",
      timeStyle: "short",
    }).format(date);
  } catch {
    return date.toLocaleString();
  }
}
