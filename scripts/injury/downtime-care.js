/** A reviewed day of care changes the existing injury and its calendar note. */
import {
  getActorCriticalInjuryEffects,
  getCriticalInjuryData,
  findActorCriticalInjuryEffect,
  updateCriticalInjuryEffect,
} from "./effects.js";
import {
  addInjuryCalendarDays,
  getCurrentInjuryTimestamp,
  isSimpleCalendarAvailable,
  scheduleCriticalInjuryNote,
  removeCriticalInjuryNoteVerified,
} from "./calendar.js";
import { persistedValuesEqual } from "../utils/persisted-data.js";
import { isPlayerOwnedCriticalInjuryActor } from "./actors.js";

const clone = (value) => structuredClone(value);
const source = (effect) => effect?.toObject?.() ?? effect;
const actorById = (id) => globalThis.game?.actors?.get?.(id);

function eligible(injury, now) {
  return Boolean(
    injury?.id &&
    !injury.permanent &&
    !(injury.canBecomePermanent && !injury.stabilized) &&
    Number.isFinite(injury.recoveryDueTs) &&
    injury.recoveryDueTs > now,
  );
}

export function downtimeCareTargets() {
  const now = getCurrentInjuryTimestamp();
  return Array.from(
    globalThis.game?.actors?.values?.() ?? globalThis.game?.actors ?? [],
  ).flatMap((actor) =>
    isPlayerOwnedCriticalInjuryActor(actor)
      ? getActorCriticalInjuryEffects(actor)
          .filter((effect) => eligible(getCriticalInjuryData(effect), now))
          .map((effect) => ({
            id: `${actor.id}|${getCriticalInjuryData(effect).id}`,
            label: `${actor.name} — ${getCriticalInjuryData(effect).injuryName}`,
          }))
      : [],
  );
}

export function planDowntimeCare(target, operationId) {
  const [actorId, injuryId, extra] = String(target ?? "").split("|");
  const actor = actorById(actorId);
  const effect = findActorCriticalInjuryEffect(actor, injuryId);
  const injury = getCriticalInjuryData(effect);
  const now = getCurrentInjuryTimestamp();
  if (
    extra ||
    !isPlayerOwnedCriticalInjuryActor(actor) ||
    !eligible(injury, now)
  )
    throw new Error(
      "Choose an available timed injury. Permanent injuries and unstabilized injury deadlines are not shortened by care.",
    );
  const day = addInjuryCalendarDays(now, 1) - now;
  if (!Number.isFinite(day) || day <= 0)
    throw new Error("The calendar day length could not be verified.");
  const after = clone(injury);
  after.recoveryDueTs = Math.max(now, injury.recoveryDueTs - day);
  const calendarDays = Math.ceil((after.recoveryDueTs - now) / day);
  after.remainingDays = calendarDays * (injury.stabilized ? 2 : 1);
  after.downtimeCareOperationId = operationId;
  return {
    actorId,
    injuryId,
    effectId: effect.id ?? effect._id,
    before: clone(injury),
    after,
    effectBefore: clone(source(effect)),
    startTime: Number(effect.duration?.startTime ?? now),
    healed: after.recoveryDueTs <= now,
    detail: `${actor.name}: ${injury.injuryName} — ${calendarDays ? "recovery shortened by one calendar day" : "recovery completed"}.`,
  };
}

function sameInjuryExceptCalendar(a, b) {
  if (!a || !b) return false;
  const left = { ...a },
    right = { ...b };
  delete left.calendarEntryId;
  delete right.calendarEntryId;
  return persistedValuesEqual(left, right);
}

export function inspectDowntimeCare(plan) {
  const actor = actorById(plan.actorId);
  if (!isPlayerOwnedCriticalInjuryActor(actor)) return "uncertain";
  const effect = findActorCriticalInjuryEffect(actor, plan.injuryId);
  if (!effect) return plan.healed ? "applied" : "uncertain";
  if ((effect.id ?? effect._id) !== plan.effectId) return "uncertain";
  const injury = getCriticalInjuryData(effect);
  if (sameInjuryExceptCalendar(injury, plan.after)) return "applied";
  if (!eligible(injury, getCurrentInjuryTimestamp())) return "uncertain";
  return persistedValuesEqual(source(effect), plan.effectBefore)
    ? "unapplied"
    : "uncertain";
}

/** Resume only an exact before/after effect; the caller owns the durable receipt. */
export async function applyDowntimeCare(plan, operationId, authorizeWrite) {
  const actor = actorById(plan.actorId);
  let state = inspectDowntimeCare(plan);
  if (state === "uncertain")
    throw new Error(
      "The reviewed injury changed. Review the saved downtime operation before retrying.",
    );
  let effect = findActorCriticalInjuryEffect(actor, plan.injuryId);
  if (state === "unapplied") {
    if (!authorizeWrite()) throw new Error("Downtime authority changed.");
    try {
      if (plan.healed)
        await actor.deleteEmbeddedDocuments("ActiveEffect", [plan.effectId]);
      else
        await updateCriticalInjuryEffect(effect, plan.after, {
          startTime: plan.startTime,
          dueTimestamp: plan.after.recoveryDueTs,
        });
    } catch (error) {
      if (inspectDowntimeCare(plan) !== "applied") throw error;
    }
    state = inspectDowntimeCare(plan);
    if (state !== "applied")
      throw new Error("Injury care did not save. Use downtime recovery.");
  }
  if (!isSimpleCalendarAvailable()) return;
  if (!authorizeWrite()) throw new Error("Downtime authority changed.");
  if (plan.healed) {
    if (
      !(await removeCriticalInjuryNoteVerified(plan.before.calendarEntryId, {
        actor,
        injury: plan.before,
      }))
    )
      throw new Error(
        "Recovery completed, but the old calendar note still needs cleanup.",
      );
    return;
  }
  const calendar = await scheduleCriticalInjuryNote({
    actor,
    injury: plan.after,
    existingEntryId: plan.before.calendarEntryId,
    verifiedReplacement: true,
    operationId,
  });
  if (!calendar.scheduled || !calendar.entryId)
    throw new Error("Injury care saved, but its calendar note needs recovery.");
  effect = findActorCriticalInjuryEffect(actor, plan.injuryId);
  if (!sameInjuryExceptCalendar(getCriticalInjuryData(effect), plan.after))
    throw new Error("The injury changed during calendar synchronization.");
  if (!authorizeWrite()) throw new Error("Downtime authority changed.");
  await updateCriticalInjuryEffect(
    effect,
    { ...plan.after, calendarEntryId: calendar.entryId },
    {
      startTime: plan.startTime,
      dueTimestamp: plan.after.recoveryDueTs,
    },
  );
  if (
    getCriticalInjuryData(findActorCriticalInjuryEffect(actor, plan.injuryId))
      ?.calendarEntryId !== calendar.entryId
  )
    throw new Error("The injury calendar link did not save.");
  if (calendar.previousEntryId) {
    if (!authorizeWrite()) throw new Error("Downtime authority changed.");
    if (
      !(await removeCriticalInjuryNoteVerified(calendar.previousEntryId, {
        actor,
        injury: plan.before,
      }))
    )
      throw new Error(
        "Injury care saved, but the old calendar note still needs cleanup.",
      );
  }
}
