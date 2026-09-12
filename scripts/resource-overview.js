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

import {
  publicForageEnvironment,
  forageDifficultyLabel,
} from "./resource/public-environment.js";

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
    body: { template: TEMPLATE_PATH, scrollable: [""] },
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
    this._refreshQueued = false;
    this._lastFullGM = this._isFullGM;
    this._unsubs = [
      subscribe(RESOURCE_EVENTS.OVERVIEW_REPLY, (payload) =>
        this._onOverviewReply(payload),
      ),
      subscribe(RESOURCE_EVENTS.STATE_UPDATE, (payload) =>
        this._onStateUpdate(payload),
      ),
    ];
    this._userConnectionHook =
      globalThis.Hooks?.on?.("userConnected", () => {
        this._invalidateSnapshot();
        this._syncCurrentRole();
        this._loadOverview();
        if (this.rendered) this.render(false);
      }) ?? null;
    this._userUpdateHook =
      globalThis.Hooks?.on?.("updateUser", (user) => {
        if (user?.id !== globalThis.game?.user?.id) return;
        this._syncCurrentRole();
        this._invalidateSnapshot();
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
    this._invalidateSnapshot();
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

  _loadOverview({ background = false } = {}) {
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
    this._requestOverview({ preserve: background });
  }

  _requestOverview({ preserve = false } = {}) {
    if (preserve && this._requestId) {
      this._refreshQueued = true;
      return;
    }
    this._clearRequestTimer();
    if (!preserve) this._overview = null;
    this._refreshQueued = false;
    this._loading = true;
    this._requestFailed = false;
    const userId = globalThis.game?.user?.id ?? "local";
    this._requestId = `${userId}:${Date.now()}:${Math.random()
      .toString(36)
      .slice(2, 10)}`;
    const requestId = this._requestId;
    this._requestTimer = globalThis.setTimeout?.(() => {
      if (this._requestId !== requestId) return;
      this._requestTimer = null;
      this._requestId = null;
      this._loading = false;
      this._requestFailed = true;
      this._overview = null;
      if (this.rendered) this.render(false);
    }, REQUEST_TIMEOUT_MS);
    try {
      emitResourceEvent(RESOURCE_EVENTS.OVERVIEW_REQUEST, { requestId });
    } catch (error) {
      console.warn(
        `${MODULE_ID} | party supplies request could not be sent`,
        error,
      );
      if (this._requestId !== requestId) return;
      this._clearRequestTimer();
      this._requestId = null;
      this._loading = false;
      this._requestFailed = true;
      if (this.rendered) this.render(false);
    }
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
    this._overview =
      this._sharingEnabled && payload.overview
        ? sanitizeResourceOverview(payload.overview)
        : null;
    this._loading = false;
    this._requestFailed = this._sharingEnabled && !this._overview;
    const refreshQueued = this._refreshQueued;
    this._refreshQueued = false;
    if (refreshQueued && this._sharingEnabled)
      this._loadOverview({ background: true });
    if (this.rendered) this.render(false);
  }

  _onStateUpdate(payload) {
    if (!this.rendered) return;
    // Only inventory changes retain an explicitly stale, already-safe view.
    // Permission, sharing, roster and authority changes discard it immediately.
    const background = payload?.reason === "inventory";
    if (!background) this._invalidateSnapshot();
    this._loadOverview({ background });
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
      distributionHint:
        resource.coverageBasis === "lowest-source" &&
        resource.sourceCount > 1 &&
        resource.available > 0 &&
        resource.coverageDays !== null &&
        resource.coverageDays < 1
          ? "At least one assigned supply source cannot cover a full day. Ask the GM to review distribution."
          : "",
    }));
    const environment = presentEnvironment(overview?.environment, {
      waterEnabled: overview?.waterEnabled !== false,
    });
    const lastUpkeep = overview?.lastUpkeep
      ? {
          ...overview.lastUpkeep,
          ranAtLabel: formatUpdatedLabel(overview.lastUpkeep.ranAt),
          selectedLabel:
            overview.lastUpkeep.selectedResources
              ?.map((resource) => resource.label)
              .join(", ") ?? "",
          hasDay:
            overview.lastUpkeep.day !== null &&
            overview.lastUpkeep.day !== undefined,
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
      refreshing: this._loading && Boolean(overview) && !noGm && !disabled,
      initialLoading: this._loading && !overview && !noGm && !disabled,
      requestFailed: this._requestFailed && !noGm && !disabled,
      hasOverview: Boolean(overview),
      hasParty: (overview?.partySize ?? 0) > 0,
      partySize: overview?.partySize ?? 0,
      autoTrigger: overview?.autoTrigger !== false,
      halfRations: overview?.halfRations === true,
      environment,
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

  _invalidateSnapshot() {
    this._clearRequestTimer();
    this._requestId = null;
    this._refreshQueued = false;
    this._overview = null;
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

export function presentEnvironment(environment, { waterEnabled = true } = {}) {
  const safe = publicForageEnvironment(environment, { waterEnabled });
  if (!safe) return null;
  const dcLabel = forageDifficultyLabel(safe, {
    food: true,
    water: waterEnabled,
  });
  return { ...safe, hasDc: Boolean(dcLabel), dcLabel };
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
