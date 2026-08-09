/** Player-facing Critical Injury roll, status, and treatment window. */

import { SETTING_KEYS, getSetting } from "../settings.js";
import { isFullGM } from "../permissions.js";
import { authoritativeGMId } from "../socket-authority.js";
import {
  CRITICAL_INJURY_EVENTS,
  buildCriticalInjuryRestId,
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
import { bindFocusRestoration } from "../infinity-app.js";
import {
  getCriticalInjuryTreatmentState,
  handleCriticalInjuryTreatmentResult,
  requestCriticalInjuryTreatment,
  subscribeCriticalInjuryTreatmentState,
} from "./treatment-client.js";

const MODULE_ID = "infinity-dnd5e";
const TEMPLATE_PATH = `modules/${MODULE_ID}/templates/critical-injury.hbs`;
const RESULT_TIMEOUT_MS = 30_000;
const REST_RESULT_TIMEOUT_MS = 3_000;
const MAX_REST_SEND_ATTEMPTS = 5;
const REST_NONCE_OPTION = "infinityDnd5eCriticalInjuryRestNonce";
const REST_NONCE_FLAG = "criticalInjuryRestNonce";

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
    const actor = globalThis.game?.actors?.get?.(id) ?? null;
    if (actor && !canCurrentUserOperateCriticalInjuryActor(actor)) {
      globalThis.ui?.notifications?.warn?.(
        "You no longer control that character. Nothing changed; choose a character you control.",
      );
      return null;
    }
    let app = instances.get(id);
    if (!app) {
      app = new CriticalInjuryApp({
        id: `infinity-dnd5e-critical-injury-${id.replace(/[^a-z0-9_-]/gi, "-")}`,
        actorId: id,
        pendingId,
      });
      bindFocusRestoration(app);
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
    const resolvedPendingId = String(payload?.pendingId ?? "");
    if (resolvedPendingId) app._resolvedPendingIds.add(resolvedPendingId);
    app._clearWaitTimer();
    app._waitingForRoll = false;
    app._requestedAuthorityId = null;
    app._pendingId = null;
    app._pendingSnapshot = null;
    app._statusMessage = payload?.result?.calendarScheduled
      ? "The injury was applied and added to the calendar."
      : "The injury was applied. Calendar scheduling was unavailable.";
    app.render(false);
  }

  static handleRollFailure(payload) {
    const app = CriticalInjuryApp.open({
      actorId: payload?.actorId,
      pendingId: payload?.pendingId,
    });
    if (!app) return;
    const pendingId = String(payload?.pendingId ?? "");
    if (pendingId && payload?.retryable !== true) {
      app._resolvedPendingIds.add(pendingId);
      app._pendingId = null;
      app._pendingSnapshot = null;
    }
    app._clearWaitTimer();
    app._waitingForRoll = false;
    app._requestedAuthorityId = null;
    app._statusMessage = String(
      payload?.message ?? "The Critical Injury roll could not be applied.",
    );
    app.render(false);
  }

  static handleTreatmentResult(payload) {
    return handleCriticalInjuryTreatmentResult(payload);
  }

  constructor(options = {}) {
    super(options);
    this._actorId = String(options.actorId ?? "");
    this._pendingId = options.pendingId ?? null;
    this._pendingSnapshot = null;
    this._latestResult = null;
    this._waitingForRoll = false;
    this._requestedAuthorityId = null;
    this._statusMessage = "";
    this._resolvedPendingIds = new Set();
    this._waitTimer = null;
    this._treatmentStateUnsubscribe = subscribeCriticalInjuryTreatmentState(
      (state) => {
        if (String(state?.actorId ?? "") !== this._actorId) return;
        this._statusMessage = String(state?.message ?? "");
        if (state?.result) this._latestResult = state.result;
        if (this.rendered) this.render(false);
      },
    );
    this._userConnectionHook =
      globalThis.Hooks?.on?.("userConnected", (user) => {
        if (!user?.isGM || !this.rendered) return;
        this.render(false);
      }) ?? null;
  }

  get title() {
    const actor = this._resolveActor();
    return actor ? `Critical Injuries — ${actor.name}` : "Critical Injuries";
  }

  _resolveActor() {
    const actor = globalThis.game?.actors?.get?.(this._actorId) ?? null;
    return canCurrentUserOperateCriticalInjuryActor(actor) ? actor : null;
  }

  _onClose(options) {
    super._onClose?.(options);
    this._clearWaitTimer();
    this._treatmentStateUnsubscribe?.();
    this._treatmentStateUnsubscribe = null;
    if (this._userConnectionHook != null) {
      try {
        globalThis.Hooks?.off?.("userConnected", this._userConnectionHook);
      } catch {}
      this._userConnectionHook = null;
    }
    instances.delete(this._actorId);
  }

  _clearWaitTimer() {
    if (this._waitTimer == null) return;
    globalThis.clearTimeout?.(this._waitTimer);
    this._waitTimer = null;
  }

  async _prepareContext() {
    const actor = this._resolveActor();
    const controlledActors = getControlledCriticalInjuryActors();
    const domId = String(this._actorId || "character").replace(
      /[^a-zA-Z0-9_-]/g,
      "-",
    );
    const currentUserId = String(globalThis.game?.user?.id ?? "");
    const currentUserIsAuthority =
      currentUserId === String(authoritativeGMId() ?? "");
    const actorPending = getActorPendingCriticalInjuries(actor);
    const actorEffects = getActorCriticalInjuryEffects(actor);
    for (const pendingId of this._resolvedPendingIds) {
      if (!actorPending.some((entry) => String(entry.id) === pendingId)) {
        this._resolvedPendingIds.delete(pendingId);
      }
    }
    const pendingList = actorPending.filter(
      (entry) =>
        !this._resolvedPendingIds.has(String(entry.id ?? "")) &&
        (String(entry.targetUserId ?? "") === currentUserId ||
          currentUserIsAuthority),
    );
    if (
      this._pendingSnapshot &&
      !this._resolvedPendingIds.has(String(this._pendingSnapshot.id ?? "")) &&
      !pendingList.some(
        (entry) =>
          String(entry.id ?? "") === String(this._pendingSnapshot.id ?? ""),
      ) &&
      (String(this._pendingSnapshot.targetUserId ?? "") === currentUserId ||
        currentUserIsAuthority)
    ) {
      pendingList.push(this._pendingSnapshot);
    }
    const pending =
      pendingList.find((entry) => entry.id === this._pendingId) ??
      pendingList[0] ??
      null;
    if (pending && !this._pendingId) this._pendingId = pending.id;

    const treatmentStates = actorEffects
      .map((effect) => {
        const injuryId = String(getCriticalInjuryData(effect)?.id ?? "");
        return getCriticalInjuryTreatmentState(this._actorId, injuryId);
      })
      .filter(Boolean)
      .sort((a, b) => b.updatedAt - a.updatedAt);
    const activeInjuries = actorEffects
      .map((effect) => {
        const injuryId = String(getCriticalInjuryData(effect)?.id ?? "");
        const treatmentState = getCriticalInjuryTreatmentState(
          this._actorId,
          injuryId,
        );
        return buildInjuryView(effect, treatmentState);
      })
      .filter(Boolean)
      .sort((a, b) => b.createdAt - a.createdAt);
    const midiActive =
      globalThis.game?.modules?.get?.("midi-qol")?.active === true;
    const daeActive = globalThis.game?.modules?.get?.("dae")?.active === true;
    const calendarActive =
      globalThis.game?.modules?.get?.("foundryvtt-simple-calendar")?.active ===
      true;
    const offline = !Boolean(authoritativeGMId());
    for (const injury of activeInjuries) {
      const treatmentDisabled = Boolean(injury.treating || offline);
      injury.headingId = `ci-injury-${domId}-${injury.domId}`;
      injury.treatmentDisabled = treatmentDisabled;
      injury.treatmentDisabledAttribute = treatmentDisabled ? "disabled" : "";
      injury.treatmentActionTitle = injury.treating
        ? "Treatment confirmation is pending"
        : offline
          ? "A full GM must be online"
          : `Request treatment for ${injury.name}`;
      injury.treatmentActionLabel = injury.treating
        ? `Waiting for treatment of ${injury.name}`
        : `Request treatment for ${injury.name}`;
    }
    const treatmentBusy = treatmentStates.some((state) => state.busy === true);
    const treatmentUncertain = treatmentStates.some(
      (state) =>
        state.busy === true ||
        (state.retryable === true && Boolean(state.treatmentId)),
    );
    const outcomeUncertain =
      offline && (this._waitingForRoll || treatmentUncertain);
    const statusMessage =
      this._statusMessage || String(treatmentStates[0]?.message ?? "");
    const normalizedStatus = statusMessage.toLocaleLowerCase();
    const statusTone = outcomeUncertain
      ? "warning"
      : offline
        ? "offline"
        : this._waitingForRoll || treatmentBusy
          ? "pending"
          : /could not|failed|unavailable|no result|no active gm|still pending|not sent|no longer/.test(
                normalizedStatus,
              )
            ? "warning"
            : statusMessage
              ? "success"
              : "ready";
    const actorSwitchLocked = this._waitingForRoll || treatmentBusy;
    const actorSelectDisabled =
      actorSwitchLocked ||
      (actor ? controlledActors.length <= 1 : controlledActors.length === 0);
    const rollActionDisabled = this._waitingForRoll || offline;

    return {
      domId,
      actorName: actor?.name ?? "Character",
      actorImg: actor?.img ?? "icons/svg/mystery-man.svg",
      noActor: !actor,
      hasActorOptions: controlledActors.length > 0,
      canSwitchActor: actor
        ? controlledActors.length > 1
        : controlledActors.length > 0,
      needsActorChoice:
        !actor && controlledActors.length > 0 && !actorSwitchLocked,
      actorSwitchLocked,
      actorSelectDisabled,
      actorSelectDisabledAttribute: actorSelectDisabled ? "disabled" : "",
      actorOptions: controlledActors.map((candidate) => ({
        id: String(candidate.id ?? ""),
        name: String(candidate.name ?? "Character"),
        selected: String(candidate.id ?? "") === String(actor?.id ?? ""),
        selectedAttribute:
          String(candidate.id ?? "") === String(actor?.id ?? "")
            ? "selected"
            : "",
      })),
      offline,
      outcomeUncertain,
      pending,
      hasPending: Boolean(pending),
      pendingCount: pendingList.length,
      waitingForRoll: this._waitingForRoll,
      rollActionDisabled,
      rollActionDisabledAttribute: rollActionDisabled ? "disabled" : "",
      rollActionTitle: offline
        ? "A full GM must be online"
        : this._waitingForRoll
          ? "Waiting for the full GM to confirm the injury roll"
          : "Roll the approved critical injury",
      latestResult: this._latestResult
        ? buildResultView(this._latestResult)
        : null,
      hasLatestResult: Boolean(this._latestResult),
      activeInjuries,
      hasActiveInjuries: activeInjuries.length > 0,
      statusMessage,
      statusTone,
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
    this._wireActorSelect(this.element);
  }

  /** Keep selection client-local. Opening the selected Actor's keyed window
   * preserves existing per-Actor pending and treatment controllers. */
  _wireActorSelect(root) {
    const select = root?.querySelector?.('[data-role="critical-injury-actor"]');
    if (!select || typeof select.addEventListener !== "function") return;
    select.addEventListener("change", async () => {
      if (this._waitingForRoll) {
        this._statusMessage =
          "Wait for the current injury roll to finish before switching characters.";
        this.render(false);
        return;
      }
      const actor = resolveControlledCriticalInjuryActor(select.value);
      if (!actor) {
        this._statusMessage =
          "That character is no longer available to you. Nothing changed; choose a character you control.";
        this.render(false);
        return;
      }
      if (String(actor.id ?? "") === this._actorId) return;
      const next = CriticalInjuryApp.open({ actorId: actor.id });
      if (!next) {
        this._statusMessage =
          "That character could not be opened. Nothing changed; refresh and choose again.";
        this.render(false);
        return;
      }
      await this.close({ animate: false });
    });
  }

  /** @this {CriticalInjuryApp} */
  static async _onRollInjury() {
    if (this._waitingForRoll) return;
    const actor = this._resolveActor();
    const pendingId = String(this._pendingId ?? "");
    if (!actor) {
      this._statusMessage =
        "You no longer control this character. Nothing changed; choose a character you control.";
      this.render(false);
      return;
    }
    if (!pendingId) return;
    if (getSetting(SETTING_KEYS.CRITICAL_INJURIES_ENABLED) === false) {
      this._statusMessage =
        "Critical Injury automation is disabled. This approved roll will stay pending.";
      this.render(false);
      return;
    }
    const pending =
      getActorPendingCriticalInjuries(actor).find(
        (entry) => entry.id === pendingId,
      ) ??
      (String(this._pendingSnapshot?.id ?? "") === pendingId
        ? this._pendingSnapshot
        : null);
    if (!pending) {
      this._statusMessage = "That injury roll is no longer pending.";
      this.render(false);
      return;
    }
    const gmId = authoritativeGMId();
    if (!gmId) {
      this._statusMessage =
        "No active GM is available. This approved roll will stay pending.";
      this.render(false);
      return;
    }
    if (!isFullGM() && typeof globalThis.game?.socket?.emit !== "function") {
      this._statusMessage =
        "The game connection is unavailable. This approved roll will stay pending.";
      this.render(false);
      return;
    }
    // Disable synchronously before emitting so a double click cannot create
    // duplicate requests. The GM-side workflow is also durably replay-safe.
    this._waitingForRoll = true;
    this._requestedAuthorityId = gmId;
    this._pendingSnapshot = { ...pending };
    this._statusMessage =
      "Roll requested. Waiting for the active GM to roll and apply it…";
    this.render(false);
    const emitted = emitCriticalInjuryEvent(
      CRITICAL_INJURY_EVENTS.ROLL_REQUEST,
      {
        actorId: actor.id,
        pendingId,
        targetUserId: gmId,
      },
    );
    if (!emitted) {
      this._waitingForRoll = false;
      this._requestedAuthorityId = null;
      this._statusMessage =
        "The roll request could not be sent. This approved roll is still pending.";
      this.render(false);
      return;
    }
    this._clearWaitTimer();
    this._waitTimer = globalThis.setTimeout?.(() => {
      if (!this._waitingForRoll) return;
      this._waitingForRoll = false;
      this._requestedAuthorityId = null;
      this._statusMessage =
        "No result arrived yet. The active GM may have changed; if the Roll d100 button remains, retrying is safe.";
      this.render(false);
    }, RESULT_TIMEOUT_MS);
  }

  /** @this {CriticalInjuryApp} */
  static _onRequestTreatment(_event, target) {
    const actor = this._resolveActor();
    const injuryId = String(target?.dataset?.injuryId ?? "");
    if (!actor) {
      this._statusMessage =
        "You no longer control this character. No treatment request was sent; choose a character you control.";
      this.render(false);
      return;
    }
    if (!injuryId) return;
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
    requestCriticalInjuryTreatment({ actorId: actor.id, injuryId });
  }

  /** @this {CriticalInjuryApp} */
  static _onDismiss() {
    this.close();
  }
}

let autoOpenRegistered = false;
const completedRestEvidence = new WeakMap();
const pendingRestMessages = new Map();
const pendingRestNonces = new Map();
const restMessagesByNonce = new Map();
const pendingRestRequests = new Map();

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
  subscribeCriticalInjury(CRITICAL_INJURY_EVENTS.ROLL_FAILURE, (payload) => {
    if (String(payload?.targetUserId) !== String(game.user?.id)) return;
    CriticalInjuryApp.handleRollFailure(payload);
  });
  subscribeCriticalInjury(CRITICAL_INJURY_EVENTS.REST_RESULT, (payload) => {
    handleLongRestResult(payload);
  });
  if (typeof globalThis.Hooks?.on === "function") {
    const refreshEffectActor = (effect) => {
      const actorId = String(effect?.parent?.id ?? "");
      instances.get(actorId)?.render?.(false);
    };
    Hooks.on("createActiveEffect", refreshEffectActor);
    Hooks.on("updateActiveEffect", refreshEffectActor);
    Hooks.on("deleteActiveEffect", refreshEffectActor);
    Hooks.on("updateActor", (actor) => {
      instances.get(String(actor?.id ?? ""))?.render?.(false);
    });
    const releaseStaleAuthorityWaits = () => {
      const currentAuthorityId = String(authoritativeGMId() ?? "");
      for (const app of instances.values()) {
        let changed = false;
        if (
          app._waitingForRoll &&
          app._requestedAuthorityId &&
          String(app._requestedAuthorityId) !== currentAuthorityId
        ) {
          app._clearWaitTimer();
          app._waitingForRoll = false;
          app._requestedAuthorityId = null;
          app._statusMessage = currentAuthorityId
            ? "The active GM changed. Click Roll d100 again to send the request to the new GM."
            : "No active GM is available. This approved roll will stay pending.";
          changed = true;
        }

        if (changed) app.render?.(false);
      }
      retargetPendingLongRestRequests(currentAuthorityId);
    };
    Hooks.on("updateUser", releaseStaleAuthorityWaits);
    Hooks.on("userConnected", releaseStaleAuthorityWaits);
    Hooks.on("dnd5e.preRestCompleted", prepareLongRestNonce);
    Hooks.on("preCreateChatMessage", tagLongRestMessage);
    Hooks.on("createChatMessage", captureLongRestMessage);
    Hooks.on("dnd5e.longRest", (actor, config) => {
      if (!currentUserCanOperateActor(actor)) return;
      const hasInfection = getActorCriticalInjuryEffects(actor).some(
        (effect) => getCriticalInjuryData(effect)?.injuryKey === "infection",
      );
      // A persisted D&D5e rest message is the evidence used by the GM to
      // distinguish a real completed rest from a forged socket request.
      if (hasInfection && config && typeof config === "object") {
        config.chat = true;
      }
    });
    Hooks.on("dnd5e.restCompleted", (actor, result, config) => {
      if (!result?.longRest || !currentUserCanOperateActor(actor)) return;
      const hasInfection = getActorCriticalInjuryEffects(actor).some(
        (effect) => getCriticalInjuryData(effect)?.injuryKey === "infection",
      );
      if (!hasInfection) return;
      const evidence = resolveLongRestEvidence(actor, result, config);
      if (!evidence) {
        ui.notifications?.warn?.(
          "The Infection rest check was not sent because the D&D5e long-rest receipt could not be verified.",
        );
        return;
      }
      const targetUserId = String(authoritativeGMId() ?? "");
      const request = {
        actorId: actor.id,
        restId: evidence.restId,
        restMessageId: evidence.restMessageId,
        longRest: true,
      };
      rememberLongRestRequest(request);
      if (!targetUserId) {
        ui.notifications?.warn?.(
          "The Infection rest check is queued until an active GM connects.",
        );
        return;
      }
      sendPendingLongRestRequest(request.restId, targetUserId);
    });
  }

  const currentUserId = String(game.user?.id ?? "");
  const currentUserIsAuthority =
    currentUserId === String(authoritativeGMId() ?? "");
  for (const actor of game.actors?.contents ?? []) {
    const pending = getActorPendingCriticalInjuries(actor).find(
      (entry) =>
        String(entry.targetUserId) === currentUserId || currentUserIsAuthority,
    );
    if (pending) {
      CriticalInjuryApp.open({ actorId: actor.id, pendingId: pending.id });
    }
  }
  return true;
}

function rememberLongRestRequest(request) {
  const restId = String(request?.restId ?? "");
  if (!restId) return;
  const existing = pendingRestRequests.get(restId);
  if (existing) {
    Object.assign(existing, request);
    return;
  }
  pendingRestRequests.set(restId, {
    ...request,
    lastAuthorityId: "",
    attemptAuthorityId: "",
    attempts: 0,
    retryTimer: null,
  });
  while (pendingRestRequests.size > 20) {
    const oldestId = pendingRestRequests.keys().next().value;
    clearPendingLongRestTimer(pendingRestRequests.get(oldestId));
    pendingRestRequests.delete(oldestId);
  }
}

function sendPendingLongRestRequest(
  restId,
  targetUserId,
  { force = false } = {},
) {
  const request = pendingRestRequests.get(String(restId ?? ""));
  const target = String(targetUserId ?? "");
  if (!request || !target || (!force && request.lastAuthorityId === target)) {
    return null;
  }
  if (request.attemptAuthorityId !== target) {
    request.attemptAuthorityId = target;
    request.attempts = 0;
  }
  if (request.attempts >= MAX_REST_SEND_ATTEMPTS) return null;
  clearPendingLongRestTimer(request);
  request.lastAuthorityId = target;
  request.attempts += 1;
  const emitted = emitCriticalInjuryEvent(
    CRITICAL_INJURY_EVENTS.REST_COMPLETED,
    {
      actorId: request.actorId,
      restId: request.restId,
      restMessageId: request.restMessageId,
      longRest: true,
      targetUserId: target,
    },
  );
  if (!emitted) {
    request.lastAuthorityId = "";
    return null;
  }
  if (pendingRestRequests.get(request.restId) === request) {
    schedulePendingLongRestRetry(request, target, REST_RESULT_TIMEOUT_MS);
  }
  return emitted;
}

function retargetPendingLongRestRequests(targetUserId) {
  const target = String(targetUserId ?? "");
  if (!target) {
    for (const request of pendingRestRequests.values()) {
      clearPendingLongRestTimer(request);
      request.lastAuthorityId = "";
    }
    return;
  }
  for (const restId of pendingRestRequests.keys()) {
    sendPendingLongRestRequest(restId, target);
  }
}

function handleLongRestResult(payload) {
  if (String(payload?.targetUserId ?? "") !== String(game.user?.id ?? "")) {
    return;
  }
  const restId = String(payload?.restId ?? "");
  const request = pendingRestRequests.get(restId);
  if (!request || request.actorId !== String(payload?.actorId ?? "")) return;
  clearPendingLongRestTimer(request);
  if (payload.success || !payload.retryable) {
    pendingRestRequests.delete(restId);
    if (!payload.success) ui.notifications?.warn?.(String(payload.message));
    return;
  }
  request.lastAuthorityId = "";
  const target = String(authoritativeGMId() ?? "");
  if (target) schedulePendingLongRestRetry(request, target, 750);
}

function schedulePendingLongRestRetry(request, targetUserId, delay) {
  clearPendingLongRestTimer(request);
  request.retryTimer = globalThis.setTimeout?.(() => {
    request.retryTimer = null;
    if (pendingRestRequests.get(request.restId) !== request) return;
    request.lastAuthorityId = "";
    sendPendingLongRestRequest(request.restId, targetUserId, { force: true });
  }, delay);
  request.retryTimer?.unref?.();
}

function clearPendingLongRestTimer(request) {
  if (request?.retryTimer != null) {
    globalThis.clearTimeout?.(request.retryTimer);
    request.retryTimer = null;
  }
}

function prepareLongRestNonce(actor, result, config) {
  if (!result?.longRest || !currentUserCanOperateActor(actor)) return;
  const hasInfection = getActorCriticalInjuryEffects(actor).some(
    (effect) => getCriticalInjuryData(effect)?.injuryKey === "infection",
  );
  if (!hasInfection) return;
  const actorId = documentId(actor);
  const userId = String(globalThis.game?.user?.id ?? "");
  if (!actorId || !userId || !config || typeof config !== "object") return;
  const nonce = `rest-nonce-${createOpaqueRestToken()}`;
  config[REST_NONCE_OPTION] = nonce;
  const key = restMessageKey(actorId, userId);
  const queue = pendingRestNonces.get(key) ?? [];
  queue.push({ nonce, createdAt: Date.now() });
  pendingRestNonces.set(key, queue.slice(-10));
}

function tagLongRestMessage(message, data) {
  const rest =
    data?.["flags.dnd5e.rest"] ??
    data?.flags?.dnd5e?.rest ??
    message?.getFlag?.("dnd5e", "rest") ??
    message?.flags?.dnd5e?.rest;
  if (String(rest?.type ?? "") !== "long") return;
  const actorId = documentId(data?.speaker?.actor ?? message?.speaker?.actor);
  const userId = documentId(data?.user ?? message?.user ?? message?.author);
  if (userId !== String(globalThis.game?.user?.id ?? "")) return;
  const key = restMessageKey(actorId, userId);
  const queue = (pendingRestNonces.get(key) ?? []).filter(
    (entry) => Date.now() - Number(entry?.createdAt ?? 0) <= 120_000,
  );
  // The newest rest owns the next locally-created rest message. This prevents
  // an Actor-update failure from leaving an abandoned nonce at the head of the
  // queue and poisoning every later completed rest.
  const nonce = String(queue.pop()?.nonce ?? "");
  if (queue.length > 0) pendingRestNonces.set(key, queue);
  else pendingRestNonces.delete(key);
  if (!nonce) return;
  message?.updateSource?.({
    [`flags.${MODULE_ID}.${REST_NONCE_FLAG}`]: nonce,
  });
  if (data && typeof data === "object") {
    data.flags ??= {};
    data.flags[MODULE_ID] ??= {};
    data.flags[MODULE_ID][REST_NONCE_FLAG] = nonce;
  }
}

function captureLongRestMessage(message) {
  const rest =
    message?.getFlag?.("dnd5e", "rest") ?? message?.flags?.dnd5e?.rest;
  if (String(rest?.type ?? "") !== "long") return;
  const actorId = documentId(message?.speaker?.actor);
  const userId = documentId(message?.user ?? message?.author);
  const messageId = documentId(message);
  const currentUserId = String(globalThis.game?.user?.id ?? "");
  if (!actorId || !messageId || !userId || userId !== currentUserId) return;
  const key = restMessageKey(actorId, userId);
  const queue = pendingRestMessages.get(key) ?? [];
  queue.push({ messageId, message });
  pendingRestMessages.set(key, queue.slice(-10));
  const nonce = String(
    message?.getFlag?.(MODULE_ID, REST_NONCE_FLAG) ??
      message?.flags?.[MODULE_ID]?.[REST_NONCE_FLAG] ??
      "",
  );
  if (nonce) {
    restMessagesByNonce.set(nonce, { messageId, message });
    while (restMessagesByNonce.size > 20) {
      restMessagesByNonce.delete(restMessagesByNonce.keys().next().value);
    }
  }
}

function resolveLongRestEvidence(actor, result, config) {
  if (result && typeof result === "object") {
    const existing = completedRestEvidence.get(result);
    if (existing) return existing;
  }
  const actorId = documentId(actor);
  const userId = String(globalThis.game?.user?.id ?? "");
  const key = restMessageKey(actorId, userId);
  const nonce = String(config?.[REST_NONCE_OPTION] ?? "");
  let candidate = nonce ? (restMessagesByNonce.get(nonce) ?? null) : null;
  if (nonce) restMessagesByNonce.delete(nonce);
  if (nonce && !candidate) return null;
  if (!nonce) {
    const queue = pendingRestMessages.get(key) ?? [];
    candidate = queue.pop() ?? null;
    if (queue.length > 0) pendingRestMessages.set(key, queue);
    else pendingRestMessages.delete(key);
  } else {
    const queue = pendingRestMessages.get(key) ?? [];
    const remaining = queue.filter(
      (entry) => entry.messageId !== candidate.messageId,
    );
    if (remaining.length > 0) pendingRestMessages.set(key, remaining);
    else pendingRestMessages.delete(key);
  }
  if (!candidate) return null;
  const restMessageId = String(candidate.messageId ?? "");
  const restId = buildCriticalInjuryRestId(actorId, restMessageId);
  if (!restId) return null;
  const evidence = Object.freeze({ restId, restMessageId });
  if (result && typeof result === "object") {
    completedRestEvidence.set(result, evidence);
  }
  return evidence;
}

function createOpaqueRestToken() {
  const randomId = globalThis.foundry?.utils?.randomID;
  if (typeof randomId === "function") return String(randomId(20));
  if (typeof globalThis.crypto?.randomUUID === "function") {
    return globalThis.crypto.randomUUID().replaceAll("-", "");
  }
  return `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function restMessageKey(actorId, userId) {
  return `${String(actorId ?? "")}:${String(userId ?? "")}`;
}

function documentId(value) {
  if (typeof value === "string") return value.trim();
  return String(value?.id ?? value?._id ?? "").trim();
}

function buildInjuryView(effect, treatmentState) {
  const injury = getCriticalInjuryData(effect);
  if (!injury) return null;
  const treatmentCheck = injury.treatmentDc
    ? `DC ${injury.treatmentDc} ${treatmentSkillLabel(injury.treatmentSkill)}`
    : "No check";
  return {
    id: injury.id,
    domId: String(injury.id ?? "injury").replace(/[^a-zA-Z0-9_-]/g, "-"),
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
    permanentClass: injury.permanent ? "ci-injury--permanent" : "",
    stabilized: Boolean(injury.stabilized),
    kitCharges: Math.max(0, Number(injury.kitCharges ?? 0)),
    treatmentCheck,
    canTreat:
      !injury.permanent && !injury.stabilized && Number(injury.kitCharges) > 0,
    treating: Boolean(treatmentState?.busy),
    treatmentMessage: String(treatmentState?.message ?? ""),
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

export function getControlledCriticalInjuryActors() {
  const user = globalThis.game?.user;
  if (!user) return [];
  const actors = globalThis.game?.actors;
  const documents = Array.isArray(actors?.contents)
    ? actors.contents
    : Array.isArray(actors)
      ? actors
      : actors?.values
        ? [...actors.values()]
        : [];
  return documents
    .filter(
      (actor) =>
        actor?.type === "character" &&
        canCurrentUserOperateCriticalInjuryActor(actor, user),
    )
    .sort((left, right) =>
      String(left?.name ?? "").localeCompare(String(right?.name ?? "")),
    );
}

export function resolveControlledCriticalInjuryActor(actorId) {
  const requested = String(actorId ?? "").trim();
  if (!requested) return null;
  return (
    getControlledCriticalInjuryActors().find(
      (actor) => String(actor?.id ?? "") === requested,
    ) ?? null
  );
}

export function resolveCurrentUserActor() {
  const assigned = globalThis.game?.user?.character;
  if (
    assigned &&
    typeof assigned !== "string" &&
    canCurrentUserOperateCriticalInjuryActor(assigned)
  ) {
    return assigned;
  }
  if (typeof assigned === "string") {
    const actor = globalThis.game?.actors?.get?.(assigned);
    if (canCurrentUserOperateCriticalInjuryActor(actor)) return actor;
  }
  const user = globalThis.game?.user;
  const directlyOwned =
    (globalThis.game?.actors?.contents ?? []).find(
      (actor) =>
        actor?.type === "character" &&
        hasDirectOwnerPermission(actor, user?.id),
    ) ?? null;
  if (directlyOwned) return directlyOwned;
  const controlled = getControlledCriticalInjuryActors();
  return controlled.length === 1 ? controlled[0] : null;
}

function currentUserCanOperateActor(actor) {
  return canCurrentUserOperateCriticalInjuryActor(actor);
}

/** Mirror the authoritative GM service's userCanOperateActor boundary so the
 * selector and every submission fail closed after assignment/ownership drift. */
export function canCurrentUserOperateCriticalInjuryActor(
  actor,
  user = globalThis.game?.user,
) {
  if (!actor || !user) return false;
  if (isFullGM(user)) return true;
  const characterId =
    typeof user.character === "string" ? user.character : user.character?.id;
  if (String(characterId ?? "") === String(actor.id ?? "")) return true;
  return hasEffectiveOwnerPermission(actor, user.id);
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

function hasEffectiveOwnerPermission(actor, userId) {
  const id = String(userId ?? "");
  if (!id) return false;
  const ownership = actor?.ownership ?? {};
  const level = Object.hasOwn(ownership, id)
    ? ownership[id]
    : ownership.default;
  const OWNER = globalThis.CONST?.DOCUMENT_OWNERSHIP_LEVELS?.OWNER ?? 3;
  return Number(level) >= Number(OWNER);
}
