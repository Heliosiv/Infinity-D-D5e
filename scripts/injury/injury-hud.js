/** Persistent player-facing body silhouette for active Critical Injuries. */

import { SETTING_KEYS, getSetting } from "../settings.js";
import {
  CRITICAL_INJURY_BODY_REGIONS,
  indexCriticalInjuriesByBodyRegion,
  resolveCriticalInjuryBodyLocation,
} from "./body-regions.js";
import { formatInjuryTimestamp } from "./calendar.js";
import {
  getActorCriticalInjuryEffects,
  getCriticalInjuryData,
} from "./effects.js";
import { CriticalInjuryApp } from "./injury-app.js";
import {
  getCriticalInjuryTreatmentState,
  requestCriticalInjuryTreatment,
  subscribeCriticalInjuryTreatmentState,
} from "./treatment-client.js";
import { treatmentSkillLabel } from "./table.js";

const MODULE_ID = "infinity-dnd5e";
const TEMPLATE_PATH = `modules/${MODULE_ID}/templates/critical-injury-hud.hbs`;

const { ApplicationV2, HandlebarsApplicationMixin } = foundry.applications.api;

let hudInstance = null;
let registered = false;
let reconcileQueued = false;

export class CriticalInjuryHudApp extends HandlebarsApplicationMixin(
  ApplicationV2,
) {
  static DEFAULT_OPTIONS = {
    id: "infinity-dnd5e-critical-injury-hud",
    tag: "aside",
    classes: ["infinity-dnd5e", "infinity-critical-injury-hud"],
    window: {
      frame: false,
      positioned: false,
    },
    position: { width: "auto", height: "auto" },
    actions: {
      pinRegion: CriticalInjuryHudApp._onPinRegion,
      closeRegion: CriticalInjuryHudApp._onCloseRegion,
      openInjuries: CriticalInjuryHudApp._onOpenInjuries,
      requestTreatment: CriticalInjuryHudApp._onRequestTreatment,
    },
  };

  static PARTS = {
    body: { template: TEMPLATE_PATH },
  };

  static get instance() {
    return hudInstance;
  }

  static async reconcile() {
    const actor = resolveCurrentUserHudActor();
    const enabled =
      getSetting(SETTING_KEYS.CRITICAL_INJURIES_ENABLED) !== false &&
      getSetting(SETTING_KEYS.CRITICAL_INJURY_HUD_ENABLED) !== false;
    const hasInjuries =
      enabled && actor && getActorCriticalInjuryEffects(actor).length > 0;

    if (!hasInjuries) {
      if (hudInstance) await hudInstance.close({ animate: false });
      return null;
    }

    if (hudInstance && hudInstance._actorId !== String(actor.id)) {
      await hudInstance.close({ animate: false });
    }
    if (!hudInstance) {
      hudInstance = new CriticalInjuryHudApp({ actorId: actor.id });
    }
    if (hudInstance.rendered) hudInstance.render(false);
    else hudInstance.render(true);
    return hudInstance;
  }

  constructor(options = {}) {
    super(options);
    this._actorId = String(options.actorId ?? "");
    this._pinnedRegion = "";
    this._statusMessage = "";
    this._outsideClickController = null;
    this._focusAfterRender = "";
  }

  _resolveActor() {
    return globalThis.game?.actors?.get?.(this._actorId) ?? null;
  }

  async _prepareContext() {
    const actor = this._resolveActor();
    const injuries = getActorCriticalInjuryEffects(actor)
      .map((effect) => buildHudInjuryView(actor, effect))
      .filter(Boolean)
      .sort((left, right) => right.createdAt - left.createdAt);
    const indexed = indexCriticalInjuriesByBodyRegion(injuries);
    const markers = CRITICAL_INJURY_BODY_REGIONS.map((region) => {
      const regionInjuries = indexed[region.key] ?? [];
      return {
        key: region.key,
        label: region.label,
        count: regionInjuries.length,
        injuries: regionInjuries,
        pinned: this._pinnedRegion === region.key,
        accessibleLabel: buildMarkerAccessibleLabel(region, regionInjuries),
      };
    }).filter((marker) => marker.count > 0);

    if (
      this._pinnedRegion &&
      !markers.some((marker) => marker.key === this._pinnedRegion)
    ) {
      this._pinnedRegion = "";
    }

    return {
      actorName: actor?.name ?? "Character",
      injuryCount: injuries.length,
      markers,
      statusMessage: this._statusMessage,
      animationsEnabled: getSetting(SETTING_KEYS.ANIMATIONS) !== false,
    };
  }

  _onRender(context, options) {
    super._onRender?.(context, options);
    this.element?.classList?.toggle(
      "cih-no-anim",
      getSetting(SETTING_KEYS.ANIMATIONS) === false,
    );
    this._bindDismissInteractions();
    const focusSelector = this._focusAfterRender;
    this._focusAfterRender = "";
    if (focusSelector) {
      const focus = () =>
        this.element?.querySelector?.(focusSelector)?.focus?.();
      if (typeof globalThis.queueMicrotask === "function") {
        globalThis.queueMicrotask(focus);
      } else {
        focus();
      }
    }
  }

  _onClose(options) {
    super._onClose?.(options);
    this._outsideClickController?.abort?.();
    this._outsideClickController = null;
    if (hudInstance === this) hudInstance = null;
  }

  _bindDismissInteractions() {
    this._outsideClickController?.abort?.();
    const controller = new AbortController();
    this._outsideClickController = controller;
    const root = this.element;
    if (!root) return;

    root.addEventListener(
      "keydown",
      (event) => {
        if (event.key !== "Escape" || !this._pinnedRegion) return;
        event.preventDefault();
        const region = this._pinnedRegion;
        this._pinnedRegion = "";
        this._focusAfterRender = markerSelector(region);
        this.render(false);
      },
      { signal: controller.signal },
    );
    globalThis.document?.addEventListener?.(
      "pointerdown",
      (event) => {
        if (!this._pinnedRegion || root.contains?.(event.target)) return;
        this._pinnedRegion = "";
        this.render(false);
      },
      { signal: controller.signal },
    );
  }

  /** @this {CriticalInjuryHudApp} */
  static _onPinRegion(_event, target) {
    const regionKey = String(target?.dataset?.regionKey ?? "");
    if (!regionKey) return;
    const opening = this._pinnedRegion !== regionKey;
    this._pinnedRegion = opening ? regionKey : "";
    this._focusAfterRender = opening
      ? closeSelector(regionKey)
      : markerSelector(regionKey);
    this.render(false);
  }

  /** @this {CriticalInjuryHudApp} */
  static _onCloseRegion(_event, target) {
    const regionKey = String(
      target?.dataset?.regionKey ?? this._pinnedRegion ?? "",
    );
    this._pinnedRegion = "";
    this._focusAfterRender = markerSelector(regionKey);
    this.render(false);
  }

  /** @this {CriticalInjuryHudApp} */
  static _onOpenInjuries() {
    CriticalInjuryApp.open({ actorId: this._actorId });
  }

  /** @this {CriticalInjuryHudApp} */
  static _onRequestTreatment(_event, target) {
    const injuryId = String(target?.dataset?.injuryId ?? "");
    if (!injuryId) return;
    const outcome = requestCriticalInjuryTreatment({
      actorId: this._actorId,
      injuryId,
    });
    this._statusMessage = String(
      outcome?.state?.message ?? outcome?.message ?? "",
    );
    this.render(false);
  }
}

export function registerCriticalInjuryHud() {
  if (registered) return true;
  registered = true;

  subscribeCriticalInjuryTreatmentState((snapshot) => {
    if (!hudInstance || String(snapshot?.actorId) !== hudInstance._actorId) {
      return;
    }
    hudInstance._statusMessage = String(snapshot?.message ?? "");
    hudInstance.render?.(false);
  });

  if (typeof globalThis.Hooks?.on === "function") {
    const refreshFromEffect = (effect) => {
      const actorId = String(effect?.parent?.id ?? "");
      const currentActorId = String(resolveCurrentUserHudActor()?.id ?? "");
      const displayedActorId = String(hudInstance?._actorId ?? "");
      if (
        actorId &&
        (actorId === currentActorId || actorId === displayedActorId)
      ) {
        scheduleCriticalInjuryHudReconcile();
      }
    };
    Hooks.on("createActiveEffect", refreshFromEffect);
    Hooks.on("updateActiveEffect", refreshFromEffect);
    Hooks.on("deleteActiveEffect", refreshFromEffect);
    Hooks.on("updateActor", (actor) => {
      const actorId = String(actor?.id ?? "");
      const currentActorId = String(resolveCurrentUserHudActor()?.id ?? "");
      const displayedActorId = String(hudInstance?._actorId ?? "");
      if (
        actorId &&
        (actorId === currentActorId || actorId === displayedActorId)
      ) {
        scheduleCriticalInjuryHudReconcile();
      }
    });
    Hooks.on("deleteActor", (actor) => {
      if (String(actor?.id ?? "") === String(hudInstance?._actorId ?? "")) {
        scheduleCriticalInjuryHudReconcile();
      }
    });
    Hooks.on("updateUser", (user) => {
      if (String(user?.id ?? "") === String(game.user?.id ?? "")) {
        scheduleCriticalInjuryHudReconcile();
      } else if (hudInstance) {
        hudInstance.render?.(false);
      }
    });
    Hooks.on("userConnected", () => hudInstance?.render?.(false));
    Hooks.on("updateSetting", (setting) => {
      const key = String(setting?.key ?? setting?._key ?? "");
      if (
        key === `${MODULE_ID}.${SETTING_KEYS.CRITICAL_INJURIES_ENABLED}` ||
        key === `${MODULE_ID}.${SETTING_KEYS.CRITICAL_INJURY_HUD_ENABLED}`
      ) {
        scheduleCriticalInjuryHudReconcile();
      }
    });
    Hooks.on("clientSettingChanged", (key) => {
      if (
        String(key ?? "") ===
        `${MODULE_ID}.${SETTING_KEYS.CRITICAL_INJURY_HUD_ENABLED}`
      ) {
        scheduleCriticalInjuryHudReconcile();
      }
    });
  }

  scheduleCriticalInjuryHudReconcile();
  return true;
}

export function scheduleCriticalInjuryHudReconcile() {
  if (reconcileQueued) return;
  reconcileQueued = true;
  Promise.resolve().then(async () => {
    reconcileQueued = false;
    try {
      await CriticalInjuryHudApp.reconcile();
    } catch (error) {
      console.warn(`${MODULE_ID} | critical injury HUD refresh failed`, error);
    }
  });
}

export function resolveCurrentUserHudActor() {
  const assigned = globalThis.game?.user?.character;
  if (assigned && typeof assigned !== "string") return assigned;
  if (typeof assigned === "string") {
    const actor = globalThis.game?.actors?.get?.(assigned);
    if (actor) return actor;
  }
  const userId = String(globalThis.game?.user?.id ?? "");
  return (
    (globalThis.game?.actors?.contents ?? []).find(
      (actor) =>
        actor?.type === "character" && hasDirectOwnerPermission(actor, userId),
    ) ?? null
  );
}

function buildHudInjuryView(actor, effect) {
  const injury = getCriticalInjuryData(effect);
  if (!injury) return null;
  const location = resolveCriticalInjuryBodyLocation(injury);
  const treatment = getCriticalInjuryTreatmentState(actor?.id, injury.id);
  const kitCharges = Math.max(0, Number(injury.kitCharges ?? 0));
  const permanent = Boolean(injury.permanent);
  const stabilized = Boolean(injury.stabilized);
  return {
    id: String(injury.id ?? ""),
    injuryKey: String(injury.injuryKey ?? ""),
    detail: injury.detail ?? null,
    name: String(injury.injuryName ?? "Critical Injury"),
    effect: String(injury.effect ?? ""),
    recoveryLabel: permanent
      ? "Permanent"
      : `${Math.max(0, Number(injury.remainingDays) || 0)} recovery day(s)${stabilized ? " — stabilized" : ""}`,
    dueLabel:
      !permanent && Number.isFinite(Number(injury.recoveryDueTs))
        ? formatInjuryTimestamp(injury.recoveryDueTs)
        : "",
    locationLabel: location.locationLabel,
    permanent,
    stabilized,
    kitCharges,
    treatmentCheck: injury.treatmentDc
      ? `DC ${injury.treatmentDc} ${treatmentSkillLabel(injury.treatmentSkill)}`
      : "No check",
    canTreat: !permanent && !stabilized && kitCharges > 0,
    treating: Boolean(treatment?.busy),
    treatmentMessage: String(treatment?.message ?? ""),
    createdAt: Number(injury.createdAt ?? 0),
  };
}

function buildMarkerAccessibleLabel(region, injuries) {
  const names = injuries.map((injury) => injury.name).join(", ");
  const count = injuries.length;
  return `${region.label}: ${count} active ${count === 1 ? "injury" : "injuries"}${names ? ` — ${names}` : ""}`;
}

function hasDirectOwnerPermission(actor, userId) {
  const id = String(userId ?? "");
  if (!id) return false;
  const ownership = actor?.ownership ?? {};
  if (!Object.hasOwn(ownership, id)) return false;
  const level = ownership[id];
  const OWNER = globalThis.CONST?.DOCUMENT_OWNERSHIP_LEVELS?.OWNER ?? 3;
  return Number(level) >= Number(OWNER);
}

function cssEscape(value) {
  const escape = globalThis.CSS?.escape;
  if (typeof escape === "function") return escape(String(value ?? ""));
  return String(value ?? "").replace(/[^a-z0-9_-]/gi, "");
}

function markerSelector(regionKey) {
  return `[data-action="pinRegion"][data-region-key="${cssEscape(regionKey)}"]`;
}

function closeSelector(regionKey) {
  return `[data-action="closeRegion"][data-region-key="${cssEscape(regionKey)}"]`;
}
