/** Read-only, GM-private view of the existing saved injury receipts. */
import { isFullGM } from "../permissions.js";
import { loadCriticalInjuryWorkflowStore } from "./workflow-store.js";
import { isAssignedPlayerCharacter } from "./actors.js";
import {
  getActorCriticalInjuryEffects,
  getCriticalInjuryData,
} from "./effects.js";
import { formatInjuryTimestamp } from "./calendar.js";
import { getStandaloneRecordedInjuryRows } from "./recorded-injuries.js";

export function getCriticalInjuryLogRows() {
  if (!isFullGM()) return [];
  const rolls = loadCriticalInjuryWorkflowStore()
    .records.filter((record) => record.state === "completed" && record.result)
    .map((record) => {
      const actor = globalThis.game?.actors?.get?.(record.actorId);
      if (!isAssignedPlayerCharacter(actor)) return null;
      const active = getActorCriticalInjuryEffects(actor).some(
        (effect) => getCriticalInjuryData(effect)?.id === record.result.id,
      );
      return {
        actorId: actor.id,
        actorName: actor.name,
        name: record.result.injuryName,
        roll: record.result.injuryRoll,
        effect: record.result.effect,
        date: formatInjuryTimestamp(record.resolution?.recoveryStartTs),
        status: active ? "Active" : "No longer active",
        active,
        order: record.completedAt,
        treatments: (record.treatments ?? []).filter(
          (entry) => entry.state === "completed",
        ).length,
      };
    })
    .filter(Boolean);
  const records = (globalThis.game?.actors?.contents ?? [])
    .filter((actor) => isAssignedPlayerCharacter(actor))
    .flatMap((actor) =>
      getStandaloneRecordedInjuryRows(actor).map((record) => ({
        actorId: actor.id,
        actorName: actor.name,
        name: record.name,
        effect: record.notes,
        date: record.recovery,
        status:
          record.status === "review"
            ? "Needs review"
            : record.status === "recovered"
              ? "Recovered"
              : record.status === "permanent"
                ? "Permanent"
                : "Active",
        active: record.status === "active" || record.status === "permanent",
        order: 0,
      })),
    );
  return [...rolls, ...records].sort((a, b) => b.order - a.order);
}
