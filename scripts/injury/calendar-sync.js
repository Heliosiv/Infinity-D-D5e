/** Repair missing calendar projections without reapplying an injury or a roll. */
import { isAuthoritativeGM } from "../socket-authority.js";
import { SETTING_KEYS, getSetting } from "../settings.js";
import { persistedValuesEqual } from "../utils/persisted-data.js";
import { isPlayerOwnedCriticalInjuryActor } from "./actors.js";
import {
  getActorCriticalInjuryEffects,
  getCriticalInjuryData,
} from "./effects.js";
import {
  ensureCriticalInjuryWorkflowAuthority,
  getCriticalInjuryWorkflowRecord,
} from "./workflow-store.js";
import {
  findInjuryCalendarNote,
  getCurrentInjuryTimestamp,
  readInjuryCalendarNotes,
  removeCriticalInjuryNoteVerified,
  scheduleCriticalInjuryNote,
  synchronizeCriticalInjuryNoteRange,
} from "./calendar.js";

let syncInFlight = null;
let syncRequested = false;

export function syncCriticalInjuryCalendar() {
  if (syncInFlight) {
    syncRequested = true;
    return syncInFlight;
  }
  syncInFlight = (async () => {
    const total = { linked: 0, skipped: 0, failed: 0 };
    do {
      syncRequested = false;
      const result = await synchronize();
      total.linked += result.linked;
      total.skipped = Math.max(total.skipped, result.skipped);
      total.failed = Math.max(total.failed, result.failed);
    } while (syncRequested);
    return total;
  })().finally(() => {
    syncInFlight = null;
  });
  return syncInFlight;
}

async function synchronize() {
  assertAuthority();
  if (getSetting(SETTING_KEYS.CRITICAL_INJURIES_ENABLED) === false) {
    throw new Error("Critical Injuries are disabled.");
  }
  await ensureCriticalInjuryWorkflowAuthority();
  const notes = await readInjuryCalendarNotes();
  if (!notes)
    throw new Error(
      "Calendar notes could not be read. Check Simple Calendar Reborn and retry.",
    );
  const result = { linked: 0, skipped: 0, failed: 0 };
  for (const actor of globalThis.game?.actors?.contents ?? []) {
    if (!isPlayerOwnedCriticalInjuryActor(actor)) continue;
    for (const effect of getActorCriticalInjuryEffects(actor)) {
      assertAuthority();
      const injury = structuredClone(getCriticalInjuryData(effect));
      const receipt = getCriticalInjuryWorkflowRecord(injury.pendingId);
      if (
        receipt?.state !== "completed" ||
        receipt.actorId !== actor.id ||
        receipt.resolution?.injuryId !== injury.id ||
        receipt.treatments?.some((entry) => entry.state !== "completed") ||
        (!injury.permanent &&
          injury.recoveryDueTs != null &&
          Number(injury.recoveryDueTs) <= getCurrentInjuryTimestamp())
      ) {
        result.skipped++;
        continue;
      }
      const existing = findInjuryCalendarNote(notes, actor, injury);
      if (
        existing &&
        String(existing.id ?? existing._id) === injury.calendarEntryId
      ) {
        try {
          const synchronized = await synchronizeCriticalInjuryNoteRange({
            actor,
            injury,
            startTimestamp: receipt.resolution.recoveryStartTs,
            authorizeWrite: () =>
              isAuthoritativeGM() &&
              persistedValuesEqual(getCriticalInjuryData(effect), injury) &&
              !getCriticalInjuryWorkflowRecord(
                injury.pendingId,
              )?.treatments?.some((entry) => entry.state !== "completed"),
          });
          if (!synchronized) result.failed++;
        } catch (error) {
          assertAuthority();
          result.failed++;
          console.warn(
            "infinity-dnd5e | injury calendar range sync failed",
            error,
          );
        }
        continue;
      }
      try {
        const calendar = await scheduleCriticalInjuryNote({
          actor,
          injury,
          startTimestamp: receipt.resolution.recoveryStartTs,
        });
        assertAuthority();
        const current = getActorCriticalInjuryEffects(actor).find(
          (entry) => entry.id === effect.id,
        );
        const freshReceipt = getCriticalInjuryWorkflowRecord(injury.pendingId);
        if (
          !current ||
          !persistedValuesEqual(getCriticalInjuryData(current), injury) ||
          freshReceipt?.treatments?.some((entry) => entry.state !== "completed")
        ) {
          if (
            calendar.created &&
            !(await removeCriticalInjuryNoteVerified(calendar.entryId, {
              actor,
              injury,
            }))
          )
            result.failed++;
          result.skipped++;
          continue;
        }
        if (!calendar.scheduled || !calendar.entryId) {
          result.failed++;
          continue;
        }
        // Only the link changes: leave penalties, duration and treatment untouched.
        await current.update({
          "flags.infinity-dnd5e.criticalInjury.calendarEntryId":
            calendar.entryId,
        });
        assertAuthority();
        if (
          getCriticalInjuryData(current)?.calendarEntryId !== calendar.entryId
        ) {
          throw new Error("Calendar link did not save.");
        }
        if (calendar.reused) {
          const linkedInjury = { ...injury, calendarEntryId: calendar.entryId };
          if (
            !(await synchronizeCriticalInjuryNoteRange({
              actor,
              injury: linkedInjury,
              startTimestamp: receipt.resolution.recoveryStartTs,
              authorizeWrite: () =>
                isAuthoritativeGM() &&
                persistedValuesEqual(
                  getCriticalInjuryData(current),
                  linkedInjury,
                ) &&
                !getCriticalInjuryWorkflowRecord(
                  injury.pendingId,
                )?.treatments?.some((entry) => entry.state !== "completed"),
            }))
          )
            result.failed++;
        }
        result.linked++;
      } catch (error) {
        assertAuthority();
        result.failed++;
        console.warn("infinity-dnd5e | injury calendar repair failed", error);
      }
    }
  }
  return result;
}

function assertAuthority() {
  if (!isAuthoritativeGM())
    throw new Error("Only the active GM can sync injury calendar entries.");
}
