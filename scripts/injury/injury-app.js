/** Player-facing Critical Injury roll, status, and treatment window. */

import { SETTING_KEYS, getSetting } from "../settings.js";
import { isFullGM } from "../permissions.js";
import {
  CRITICAL_INJURY_EVENTS,
  emitCriticalInjuryEvent,
  subscribeCriticalInjury,
} from "./socket.js";
import {
  findActorCriticalInjuryEffect,
  getActorCriticalInjuryEffects,
  getCriticalInjuryData,
} from "./effects.js";
import { getActorPendingCriticalInjuries } from "./service.js";
import { formatInjuryTimestamp } from "./calendar.js";
import { treatmentSkillLabel } from "./table.js";

const MODULE_ID = "infinity-dnd5e";
const TEMPLATE_PATH = `modules/${MODULE_ID}/templates/critical-injury.hbs`;
const RESULT_TIMEOUT_MS = 30_000;

const { ApplicationV2, HandlebarsApplicationMixin } = foundry.applications.api;
const instances = new Map();

export class CriticalInjuryApp extends HandlebarsApplicationMixin(
  ApplicationV2,
) {
  static DEFAULT_OPTIONS = {
    id: "infinity-dnd5e-critical-injury",
    tag: "section",
    classes: ["infinity-dnd5e", "infinity-critical-injury"],
    window: {
      title: "Critical Injuries",
      icon: "fa-solid fa-heart-crack",
      resizable: true,
    },
    position: { width: 520, height: "auto" },
    actions: {
      rollInjury: CriticalInjuryApp._onRollInjury,
      requestTreatment: CriticalInjuryApp._onRequestTreatment,
      dismiss: CriticalInjuryApp._onDismiss,
    },
  };

  static PARTS = {
    body: { template: TEMPLATE_PATH },
  };

  static open({ actorId, pendingId = null, result = null } = {}) {
    const id = String(actorId ?? "").trim();
    if (!id) return null;
    let app = instances.get(id);
    if (!app) {
      app = new CriticalInjuryApp({
        id: `infinity-dnd5e-critical-injury-${id.replace(/[^a-z0-9_-]/gi, "-")}`,
        actorId: id,
        pendingId,
      });
      instances.set(id, app);
    }
    if (pendingId) app._pendingId = pendingId;
    if (result) app._latestResult = result;
    if (app.rendered) {
      app.render(false);
      app.bringToFront();
    } else {
      app.render(true);
    }
    return app;
  }

  static openForCurrentUser() {
    if (getSetting(SETTING_KEYS.CRITICAL_INJURIES_ENABLED) === false) {
      ui.notifications?.warn?.(
        "Critical Injuries are disabled in module settings.",
      );
      return null;
    }
    const actor = resolveCurrentUserActor();
    if (!actor) {
      ui.notifications?.warn?.(
        "No player character is assigned to you and no owned character was found.",
      );
      return null;
    }
    return CriticalInjuryApp.open({ actorId: actor.id });
  }

  static handleResult(payload) {
    const app = CriticalInjuryApp.open({
      actorId: payload?.actorId,
      pendingId: payload?.pendingId,
      result: payload?.result,
    });
    if (!app) return;
    app._clearWaitTimer();
    app._waitingForRoll = false;
    app._pendingId = null;
    app._statusMessage = payload?.result?.calendarScheduled
      ? "The injury was applied and added to the calendar."
      : "The injury was applied. Calendar scheduling was unavailable.";
    app.render(false);
  }

  static handleTreatmentResult(payload) {
    const app = CriticalInjuryApp.open({ actorId: payload?.actorId });
    if (!app) return;
    app._treating.delete(String(payload?.injuryId ?? ""));
    app._statusMessage = String(payload?.message ?? "Treatment resolved.");
    if (payload?.result) app._latestResult = payload.result;
    app.render(false);
  }

  constructor(options = {}) {
    super(options);
    this._actorId = String(options.actorId ?? "");
    this._pendingId = options.pendingId ?? null;
    this._latestResult = null;
    this._waitingForRoll = false;
    this._statusMessage = "";
    this._treating = new Set();
    this._waitTimer = null;
  }

  get title() {
    const actor = this._resolveActor();
    return actor ? `Critical Injuries — ${actor.name}` : "Critical Injuries";
  }

  _resolveActor() {
    return globalThis.game?.actors?.get?.(this._actorId) ?? null;
  }

  _onClose(options) {
    super._onClose?.(options);
    this._clearWaitTimer();
    instances.delete(this._actorId);
  }

  _clearWaitTimer() {
    if (this._waitTimer == null) return;
    globalThis.clearTimeout?.(this._waitTimer);
    this._waitTimer = null;
  }

  async _prepareContext() {
    const actor = this._resolveActor();
    const currentUserId = String(globalThis.game?.user?.id ?? "");
    const pendingList = getActorPendingCriticalInjuries(actor).filter(
      (entry) =>
        String(entry.targetUserId ?? "") === currentUserId || isFullGM(),
    );
    const pending =
      pendingList.find((entry) => entry.id === this._pendingId) ??
      pendingList[0] ??
      null;
    if (pending && !this._pendingId) this._pendingId = pending.id;

    const activeInjuries = getActorCriticalInjuryEffects(actor)
      .map((effect) => buildInjuryView(effect, this._treating))
      .filter(Boolean)
      .sort((a, b) => b.createdAt - a.createdAt);
    const midiActive =
      globalThis.game?.modules?.get?.("midi-qol")?.active === true;
    const daeActive = globalThis.game?.modules?.get?.("dae")?.active === true;
    const calendarActive =
      globalThis.game?.modules?.get?.("foundryvtt-simple-calendar")?.active ===
      true;

    return {
      actorName: actor?.name ?? "Character",
      actorImg: actor?.img ?? "icons/svg/mystery-man.svg",
      noActor: !actor,
      pending,
      hasPending: Boolean(pending),
      pendingCount: pendingList.length,
      waitingForRoll: this._waitingForRoll,
      latestResult: this._latestResult
        ? buildResultView(this._latestResult)
        : null,
      hasLatestResult: Boolean(this._latestResult),
      activeInjuries,
      hasActiveInjuries: activeInjuries.length > 0,
      statusMessage: this._statusMessage,
      integrations: {
        midiActive,
        daeActive,
        calendarActive,
        automationReady: midiActive && daeActive,
      },
    };
  }

  _onRender(context, options) {
    super._onRender?.(context, options);
    this.element?.classList?.toggle(
      "ci-no-anim",
      getSetting(SETTING_KEYS.ANIMATIONS) === false,
    );
  }

  /** @this {CriticalInjuryApp} */
  static async _onRollInjury() {
    if (this._waitingForRoll) return;
    const actor = this._resolveActor();
    const pendingId = String(this._pendingId ?? "");
    if (!actor || !pendingId) return;
    const pending = getActorPendingCriticalInjuries(actor).find(
      (entry) => entry.id === pendingId,
    );
    if (!pending) {
      this._statusMessage = "That injury roll is no longer pending.";
      this.render(false);
      return;
    }
    const RollClass = globalThis.Roll;
    if (typeof RollClass !== "function") {
      ui.notifications?.error?.("Foundry's dice roller is unavailable.");
      return;
    }
    const roll = await new RollClass("1d100").evaluate();
    await roll.toMessage?.({
      speaker: globalThis.ChatMessage?.getSpeaker?.({ actor }),
      flavor: `${actor.name}: Critical Injury Table V2`,
    });
    const emitted = emitCriticalInjuryEvent(
      CRITICAL_INJURY_EVENTS.ROLL_REQUEST,
      {
        actorId: actor.id,
        pendingId,
        rollTotal: Math.max(1, Math.min(100, Math.floor(Number(roll.total)))),
      },
    );
    if (!emitted) return;
    this._waitingForRoll = true;
    this._statusMessage = "Roll sent to the GM for application…";
    this.render(false);
    this._clearWaitTimer();
    this._waitTimer = globalThis.setTimeout?.(() => {
      if (!this._waitingForRoll) return;
      this._waitingForRoll = false;
      this._statusMessage =
        "The GM did not finish applying the roll. You can try the pending roll again.";
      this.render(false);
    }, RESULT_TIMEOUT_MS);
  }

  /** @this {CriticalInjuryApp} */
  static _onRequestTreatment(_event, target) {
    const actor = this._resolveActor();
    const injuryId = String(target?.dataset?.injuryId ?? "");
    if (!actor || !injuryId || this._treating.has(injuryId)) return;
    const effect = findActorCriticalInjuryEffect(actor, injuryId);
    const injury = getCriticalInjuryData(effect);
    if (
      !injury ||
      injury.permanent ||
      injury.stabilized ||
      Number(injury.kitCharges) <= 0
    ) {
      return;
    }
    const emitted = emitCriticalInjuryEvent(
      CRITICAL_INJURY_EVENTS.TREATMENT_REQUEST,
      { actorId: actor.id, injuryId },
    );
    if (!emitted) return;
    this._treating.add(injuryId);
    this._statusMessage = "Treatment request sent to the GM…";
    this.render(false);
  }

  /** @this {CriticalInjuryApp} */
  static _onDismiss() {
    this.close();
  }
}

let autoOpenRegistered = false;

export function registerCriticalInjuryApp() {
  if (autoOpenRegistered) return true;
  autoOpenRegistered = true;

  subscribeCriticalInjury(CRITICAL_INJURY_EVENTS.PROMPT, (payload) => {
    if (String(payload?.targetUserId) !== String(game.user?.id)) return;
    CriticalInjuryApp.open({
      actorId: payload.actorId,
      pendingId: payload.pendingId,
    });
  });
  subscribeCriticalInjury(CRITICAL_INJURY_EVENTS.RESULT, (payload) => {
    if (String(payload?.targetUserId) !== String(game.user?.id)) return;
    CriticalInjuryApp.handleResult(payload);
  });
  subscribeCriticalInjury(
    CRITICAL_INJURY_EVENTS.TREATMENT_RESULT,
    (payload) => {
      if (String(payload?.targetUserId) !== String(game.user?.id)) return;
      CriticalInjuryApp.handleTreatmentResult(payload);
    },
  );

  if (typeof globalThis.Hooks?.on === "function") {
    const refreshEffectActor = (effect) => {
      const actorId = String(effect?.parent?.id ?? "");
      instances.get(actorId)?.render?.(false);
    };
    Hooks.on("createActiveEffect", refreshEffectActor);
    Hooks.on("updateActiveEffect", refreshEffectActor);
    Hooks.on("deleteActiveEffect", refreshEffectActor);
    Hooks.on("dnd5e.restCompleted", (actor, result) => {
      if (!result?.longRest || !currentUserCanOperateActor(actor)) return;
      emitCriticalInjuryEvent(CRITICAL_INJURY_EVENTS.REST_COMPLETED, {
        actorId: actor.id,
        longRest: true,
      });
    });
  }

  for (const actor of game.actors?.contents ?? []) {
    const pending = getActorPendingCriticalInjuries(actor).find(
      (entry) => String(entry.targetUserId) === String(game.user?.id),
    );
    if (pending) {
      CriticalInjuryApp.open({ actorId: actor.id, pendingId: pending.id });
    }
  }
  return true;
}

function buildInjuryView(effect, treating) {
  const injury = getCriticalInjuryData(effect);
  if (!injury) return null;
  const treatmentCheck = injury.treatmentDc
    ? `DC ${injury.treatmentDc} ${treatmentSkillLabel(injury.treatmentSkill)}`
    : "No check";
  return {
    id: injury.id,
    name: injury.injuryName,
    effect: injury.effect,
    recoveryRule: injury.recoveryRule,
    recoveryLabel: injury.permanent
      ? "Permanent"
      : `${injury.remainingDays} recovery day(s)${injury.stabilized ? " — stabilized" : ""}`,
    dueLabel:
      !injury.permanent && Number.isFinite(Number(injury.recoveryDueTs))
        ? formatInjuryTimestamp(injury.recoveryDueTs)
        : "",
    detailLabel: injury.detail?.label ?? "",
    createdAt: Number(injury.createdAt ?? 0),
    roll: injury.injuryRoll,
    permanent: Boolean(injury.permanent),
    stabilized: Boolean(injury.stabilized),
    kitCharges: Math.max(0, Number(injury.kitCharges ?? 0)),
    treatmentCheck,
    canTreat:
      !injury.permanent && !injury.stabilized && Number(injury.kitCharges) > 0,
    treating: treating.has(String(injury.id)),
    automatedChanges: Array.isArray(effect?.changes)
      ? effect.changes.length
      : 0,
  };
}

function buildResultView(result) {
  return {
    ...result,
    recoveryLabel: result.permanent
      ? "Permanent"
      : `${result.remainingDays} recovery day(s)`,
    dueLabel:
      !result.permanent && Number.isFinite(Number(result.recoveryDueTs))
        ? formatInjuryTimestamp(result.recoveryDueTs)
        : "",
    detailLabel: result.detail?.label ?? "",
  };
}

function resolveCurrentUserActor() {
  const assigned = globalThis.game?.user?.character;
  if (assigned && typeof assigned !== "string") return assigned;
  if (typeof assigned === "string") {
    const actor = globalThis.game?.actors?.get?.(assigned);
    if (actor) return actor;
  }
  const user = globalThis.game?.user;
  return (
    (globalThis.game?.actors?.contents ?? []).find(
      (actor) =>
        actor?.type === "character" &&
        hasDirectOwnerPermission(actor, user?.id),
    ) ?? null
  );
}

function currentUserCanOperateActor(actor) {
  const user = globalThis.game?.user;
  if (isFullGM(user)) return true;
  const characterId =
    typeof user?.character === "string" ? user.character : user?.character?.id;
  return characterId === actor?.id || hasDirectOwnerPermission(actor, user?.id);
}

function hasDirectOwnerPermission(actor, userId) {
  const id = String(userId ?? "");
  if (!id) return false;
  const ownership = actor?.ownership ?? {};
  const level = Object.hasOwn(ownership, id)
    ? ownership[id]
    : ownership.default;
  const OWNER = globalThis.CONST?.DOCUMENT_OWNERSHIP_LEVELS?.OWNER ?? 3;
  return Number(level) >= Number(OWNER);
}
