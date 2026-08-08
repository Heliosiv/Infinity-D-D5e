/**
 * Shared player-side state for Critical Injury Healer's Kit requests.
 *
 * This module owns only request correlation and presentation state. The
 * authoritative GM remains responsible for choosing the healer, rolling any
 * check, spending kit charges, and applying Actor/calendar changes.
 */

import { isFullGM } from "../permissions.js";
import { SETTING_KEYS, getSetting } from "../settings.js";
import { authoritativeGMId } from "../socket-authority.js";
import {
  findActorCriticalInjuryEffect,
  generateCriticalInjuryId,
  getCriticalInjuryData,
} from "./effects.js";
import {
  CRITICAL_INJURY_EVENTS,
  emitCriticalInjuryEvent,
  subscribeCriticalInjury,
} from "./socket.js";

const RESULT_TIMEOUT_MS = 30_000;

const treatmentStates = new Map();
const stateListeners = new Set();

let transportRegistered = false;

/**
 * Return the current immutable presentation snapshot for one injury.
 */
export function getCriticalInjuryTreatmentState(actorId, injuryId) {
  const state = treatmentStates.get(treatmentStateKey(actorId, injuryId));
  return state ? treatmentStateSnapshot(state) : null;
}

/**
 * Subscribe to state changes across all actors and injuries.
 */
export function subscribeCriticalInjuryTreatmentState(handler) {
  if (typeof handler !== "function") return () => {};
  ensureTreatmentClientRegistered();
  stateListeners.add(handler);
  return () => stateListeners.delete(handler);
}

/**
 * Request treatment for one verified Actor injury.
 *
 * The stable treatmentId is retained across timeouts and active-GM handoffs.
 * It is cleared after a terminal response so a later deliberate click starts
 * a new attempt.
 */
export function requestCriticalInjuryTreatment({ actorId, injuryId } = {}) {
  ensureTreatmentClientRegistered();
  const normalizedActorId = boundedText(actorId);
  const normalizedInjuryId = boundedText(injuryId);
  const actor = globalThis.game?.actors?.get?.(normalizedActorId) ?? null;
  const effect = findActorCriticalInjuryEffect(actor, normalizedInjuryId);
  const injury = getCriticalInjuryData(effect);
  if (
    !actor ||
    !normalizedInjuryId ||
    !injury ||
    injury.permanent ||
    injury.stabilized ||
    Number(injury.kitCharges) <= 0
  ) {
    return { ok: false, reason: "injury-not-treatable", state: null };
  }

  const key = treatmentStateKey(normalizedActorId, normalizedInjuryId);
  let state =
    treatmentStates.get(key) ??
    createTreatmentState(normalizedActorId, normalizedInjuryId);
  treatmentStates.set(key, state);
  if (state.busy) {
    return {
      ok: false,
      reason: "request-in-progress",
      state: treatmentStateSnapshot(state),
    };
  }

  if (getSetting(SETTING_KEYS.CRITICAL_INJURIES_ENABLED) === false) {
    updateIdleState(state, {
      message:
        "Critical Injury automation is disabled. No treatment was requested.",
    });
    publishTreatmentState(state);
    return {
      ok: false,
      reason: "automation-disabled",
      state: treatmentStateSnapshot(state),
    };
  }

  const gmId = boundedText(authoritativeGMId());
  if (!gmId) {
    updateIdleState(state, {
      message:
        "No active GM is available. Your Healer's Kit has not been used.",
    });
    publishTreatmentState(state);
    return {
      ok: false,
      reason: "no-active-gm",
      state: treatmentStateSnapshot(state),
    };
  }

  if (!isFullGM() && typeof globalThis.game?.socket?.emit !== "function") {
    updateIdleState(state, {
      message:
        "The game connection is unavailable. Your Healer's Kit has not been used.",
    });
    publishTreatmentState(state);
    return {
      ok: false,
      reason: "socket-unavailable",
      state: treatmentStateSnapshot(state),
    };
  }

  const treatmentId =
    boundedText(state.treatmentId) ||
    `treatment-${generateCriticalInjuryId().replace(/^injury-/, "")}`;
  clearTreatmentTimer(state);
  state.treatmentId = treatmentId;
  state.authorityId = gmId;
  state.busy = true;
  state.retryable = false;
  state.message = "Treatment request sent to the active GM…";
  state.result = null;
  touchTreatmentState(state);
  publishTreatmentState(state);

  const emitted = emitCriticalInjuryEvent(
    CRITICAL_INJURY_EVENTS.TREATMENT_REQUEST,
    {
      actorId: normalizedActorId,
      injuryId: normalizedInjuryId,
      treatmentId,
      targetUserId: gmId,
    },
  );
  if (!emitted) {
    state.busy = false;
    state.retryable = true;
    state.authorityId = null;
    state.message =
      "The treatment request could not be sent. No kit charges were used.";
    touchTreatmentState(state);
    publishTreatmentState(state);
    return {
      ok: false,
      reason: "emit-failed",
      state: treatmentStateSnapshot(state),
    };
  }

  // A local authoritative-GM dispatch can synchronously resolve the request.
  // Do not install a timeout after that terminal result has already arrived.
  const current = treatmentStates.get(key);
  if (
    !current ||
    current.treatmentId !== treatmentId ||
    current.busy !== true
  ) {
    return {
      ok: true,
      treatmentId,
      state: current ? treatmentStateSnapshot(current) : null,
    };
  }

  current.timer = globalThis.setTimeout?.(() => {
    const latest = treatmentStates.get(key);
    if (!latest || latest.treatmentId !== treatmentId || latest.busy !== true) {
      return;
    }
    latest.timer = null;
    latest.busy = false;
    latest.retryable = true;
    latest.authorityId = null;
    latest.message =
      "No treatment result arrived yet. Retrying this request is safe; it will not spend the kit twice.";
    touchTreatmentState(latest);
    publishTreatmentState(latest);
  }, RESULT_TIMEOUT_MS);

  return {
    ok: true,
    treatmentId,
    state: treatmentStateSnapshot(current),
  };
}

/**
 * Adopt an authenticated treatment response. Delayed responses for an older
 * deliberate attempt cannot release or overwrite a newer request.
 */
export function handleCriticalInjuryTreatmentResult(payload) {
  const actorId = boundedText(payload?.actorId);
  const injuryId = boundedText(payload?.injuryId);
  const treatmentId = boundedText(payload?.treatmentId);
  if (!actorId || !injuryId || !treatmentId) return false;

  const state = treatmentStates.get(treatmentStateKey(actorId, injuryId));
  if (!state || state.treatmentId !== treatmentId) return false;

  clearTreatmentTimer(state);
  state.busy = false;
  state.authorityId = null;
  state.message = String(payload?.message ?? "Treatment resolved.");
  state.result = payload?.result ?? null;
  state.retryable = payload?.retryable === true;
  if (state.retryable) {
    state.treatmentId = boundedText(payload?.resumeTreatmentId) || treatmentId;
  } else {
    // Retain the terminal message/result, but not its request identity. The
    // next deliberate click must create a fresh treatmentId.
    state.treatmentId = null;
  }
  touchTreatmentState(state);
  publishTreatmentState(state);
  return true;
}

/**
 * Release busy waits that targeted a GM who is no longer authoritative.
 */
export function releaseStaleCriticalInjuryTreatmentAuthority() {
  const currentAuthorityId = boundedText(authoritativeGMId());
  let released = 0;
  for (const state of treatmentStates.values()) {
    if (
      state.busy !== true ||
      !state.authorityId ||
      state.authorityId === currentAuthorityId
    ) {
      continue;
    }
    clearTreatmentTimer(state);
    state.busy = false;
    state.retryable = true;
    state.authorityId = null;
    state.message = currentAuthorityId
      ? "The active GM changed. Request treatment again to resume the same safe attempt."
      : "No active GM is available. Your Healer's Kit has not been used again.";
    touchTreatmentState(state);
    publishTreatmentState(state);
    released += 1;
  }
  return released;
}

function ensureTreatmentClientRegistered() {
  if (transportRegistered) return;
  transportRegistered = true;
  subscribeCriticalInjury(
    CRITICAL_INJURY_EVENTS.TREATMENT_RESULT,
    (payload) => {
      if (
        String(payload?.targetUserId ?? "") !==
        String(globalThis.game?.user?.id ?? "")
      ) {
        return;
      }
      handleCriticalInjuryTreatmentResult(payload);
    },
  );
  if (typeof globalThis.Hooks?.on === "function") {
    Hooks.on("updateUser", releaseStaleCriticalInjuryTreatmentAuthority);
    Hooks.on("userConnected", releaseStaleCriticalInjuryTreatmentAuthority);
  }
}

function createTreatmentState(actorId, injuryId) {
  return {
    actorId,
    injuryId,
    busy: false,
    retryable: false,
    treatmentId: null,
    authorityId: null,
    message: "",
    result: null,
    timer: null,
    updatedAt: 0,
  };
}

function updateIdleState(state, { message }) {
  clearTreatmentTimer(state);
  state.busy = false;
  state.authorityId = null;
  state.message = String(message ?? "");
  touchTreatmentState(state);
}

function touchTreatmentState(state) {
  state.updatedAt = Date.now();
}

function clearTreatmentTimer(state) {
  if (state?.timer != null) globalThis.clearTimeout?.(state.timer);
  if (state) state.timer = null;
}

function publishTreatmentState(state) {
  const snapshot = treatmentStateSnapshot(state);
  for (const handler of stateListeners) {
    try {
      handler(snapshot);
    } catch (error) {
      console.warn(
        "infinity-dnd5e | critical injury treatment state listener failed",
        error,
      );
    }
  }
}

function treatmentStateSnapshot(state) {
  return Object.freeze({
    actorId: state.actorId,
    injuryId: state.injuryId,
    busy: state.busy === true,
    retryable: state.retryable === true,
    treatmentId: boundedText(state.treatmentId) || null,
    authorityId: boundedText(state.authorityId) || null,
    message: String(state.message ?? ""),
    result: state.result ?? null,
    updatedAt: Number(state.updatedAt ?? 0),
  });
}

function treatmentStateKey(actorId, injuryId) {
  return `${boundedText(actorId)}:${boundedText(injuryId)}`;
}

function boundedText(value) {
  return String(value ?? "").trim();
}
