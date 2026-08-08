/** Simple Calendar adapter for Critical Injury recovery notes. */

const MODULE_ID = "infinity-dnd5e";
const SIMPLE_CALENDAR_ID = "foundryvtt-simple-calendar";
const FALLBACK_SECONDS_PER_DAY = 86_400;
const INJURY_NOTE_MARKER_PREFIX = `${MODULE_ID}:critical-injury:v1`;

export function isSimpleCalendarAvailable() {
  const module = globalThis.game?.modules?.get?.(SIMPLE_CALENDAR_ID);
  return module?.active === true && Boolean(globalThis.SimpleCalendar?.api);
}

export function getCurrentInjuryTimestamp() {
  const api = globalThis.SimpleCalendar?.api;
  if (typeof api?.timestamp === "function") {
    try {
      const timestamp = Number(api.timestamp());
      if (Number.isFinite(timestamp)) return timestamp;
    } catch {
      // Fall through to Foundry world time.
    }
  }
  const worldTime = Number(globalThis.game?.time?.worldTime);
  return Number.isFinite(worldTime) ? worldTime : 0;
}

export function addInjuryCalendarDays(timestamp, days) {
  const start = Number(timestamp);
  const amount = Math.max(0, Math.ceil(Number(days) || 0));
  const api = globalThis.SimpleCalendar?.api;
  if (typeof api?.timestampPlusInterval === "function") {
    try {
      const result = Number(api.timestampPlusInterval(start, { day: amount }));
      if (Number.isFinite(result)) return result;
    } catch {
      // Use the core-time fallback below.
    }
  }
  return start + amount * FALLBACK_SECONDS_PER_DAY;
}

export function getRemainingInjuryCalendarDays(
  dueTimestamp,
  nowTimestamp = getCurrentInjuryTimestamp(),
) {
  const due = Number(dueTimestamp);
  const now = Number(nowTimestamp);
  if (!Number.isFinite(due) || !Number.isFinite(now)) return null;
  if (due <= now) return 0;
  const nextDay = addInjuryCalendarDays(now, 1);
  const dayLength = nextDay - now;
  if (!Number.isFinite(dayLength) || dayLength <= 0) return null;
  return Math.max(1, Math.ceil((due - now) / dayLength));
}

export function formatInjuryTimestamp(timestamp) {
  const value = Number(timestamp);
  const api = globalThis.SimpleCalendar?.api;
  if (typeof api?.formatTimestamp === "function") {
    try {
      const formatted = api.formatTimestamp(value);
      if (formatted) return String(formatted);
    } catch {
      // Fall through.
    }
  }
  return `world time ${Math.floor(value)}`;
}

export async function scheduleCriticalInjuryNote({
  actor,
  injury,
  existingEntryId = "",
  verifiedReplacement = false,
} = {}) {
  if (!isSimpleCalendarAvailable()) {
    return calendarNoteResult({ reason: "calendar-inactive" });
  }
  const api = globalThis.SimpleCalendar?.api;
  if (typeof api?.addNote !== "function") {
    return calendarNoteResult({ reason: "add-note-unavailable" });
  }

  const oldId = String(existingEntryId ?? "").trim();
  const marker = buildCriticalInjuryNoteMarker(actor, injury);
  if (!oldId && marker) {
    if (typeof api?.getNotes !== "function") {
      return calendarNoteResult({ reason: "get-notes-unavailable" });
    }
    try {
      const existingNote = findCriticalInjuryNote(await api.getNotes(), marker);
      if (existingNote) {
        const entryId = extractDocumentId(existingNote);
        return calendarNoteResult({
          scheduled: Boolean(entryId),
          entryId,
          reused: true,
          reason: entryId ? "" : "existing-note-id-unavailable",
        });
      }
    } catch (error) {
      console.warn(
        `${MODULE_ID} | could not search for an existing critical injury note`,
        error,
      );
      return calendarNoteResult({
        reason: `note-discovery-failed: ${String(
          error?.message ?? error ?? "unknown",
        )}`,
      });
    }
  }

  const now = getCurrentInjuryTimestamp();
  const due = Number(injury?.recoveryDueTs);
  const safeDue = Number.isFinite(due)
    ? Math.max(now, due)
    : addInjuryCalendarDays(now, injury?.permanent ? 1 : 0);
  const startDate = toCalendarDate(api, now);
  const endDate = toCalendarDate(api, safeDue);
  if (!startDate || !endDate) {
    return calendarNoteResult({ reason: "date-conversion-failed" });
  }

  const injuryName = String(injury?.injuryName ?? "Critical Injury");
  const actorName = String(actor?.name ?? "Unknown Character");
  const recovery = injury?.permanent
    ? "Permanent"
    : `${Math.max(0, Number(injury?.remainingDays) || 0)} recovery day(s)`;
  const title = `${actorName} — ${injuryName}${injury?.permanent ? " (Permanent)" : ""}`;
  const content = [
    `<p><strong>${escapeHtml(actorName)}</strong>: ${escapeHtml(injuryName)}</p>`,
    `<p>${escapeHtml(String(injury?.effect ?? ""))}</p>`,
    `<p><strong>Recovery:</strong> ${escapeHtml(recovery)}</p>`,
    `<p><strong>Rule:</strong> ${escapeHtml(String(injury?.recoveryRule ?? ""))}</p>`,
    marker
      ? `<p><small>Infinity D&amp;D5e recovery tracking: <code>${escapeHtml(marker)}</code></small></p>`
      : "",
  ].join("");

  try {
    const repeatNever = globalThis.SimpleCalendar?.api?.NoteRepeat?.Never;
    const note = await api.addNote(
      title,
      content,
      startDate,
      endDate,
      true,
      repeatNever,
      [],
      "active",
      null,
      ["default"],
    );
    const entryId = extractDocumentId(note);
    return calendarNoteResult({
      scheduled: Boolean(note && entryId),
      entryId,
      created: Boolean(note),
      previousEntryId:
        verifiedReplacement && entryId && oldId && oldId !== entryId
          ? oldId
          : "",
      reason: entryId
        ? ""
        : note
          ? "note-id-unavailable"
          : "add-note-returned-empty",
    });
  } catch (error) {
    if (marker && typeof api?.getNotes === "function") {
      try {
        const recoveredNote = findCriticalInjuryNote(
          await api.getNotes(),
          marker,
          { excludeEntryId: oldId },
        );
        const recoveredEntryId = extractDocumentId(recoveredNote);
        if (recoveredEntryId) {
          return calendarNoteResult({
            scheduled: true,
            entryId: recoveredEntryId,
            reused: true,
            previousEntryId:
              verifiedReplacement && oldId && oldId !== recoveredEntryId
                ? oldId
                : "",
          });
        }
      } catch (discoveryError) {
        console.warn(
          `${MODULE_ID} | could not recover a committed critical injury note`,
          discoveryError,
        );
      }
    }
    console.warn(`${MODULE_ID} | could not schedule critical injury`, error);
    return calendarNoteResult({
      reason: String(error?.message ?? error ?? "unknown"),
    });
  }
}

export async function removeCriticalInjuryNote(
  entryId,
  { actor, injury } = {},
) {
  const id = String(entryId ?? "").trim();
  if (!id || !isSimpleCalendarAvailable()) return false;
  const api = globalThis.SimpleCalendar?.api;
  const marker = buildCriticalInjuryNoteMarker(actor, injury);
  if (
    !marker ||
    typeof api?.getNotes !== "function" ||
    typeof api?.removeNote !== "function"
  ) {
    return false;
  }
  try {
    const verified = findCriticalInjuryNote(await api.getNotes(), marker, {
      entryId: id,
    });
    if (!verified) return false;
    return (await api.removeNote(id)) !== false;
  } catch (error) {
    console.warn(`${MODULE_ID} | could not remove critical injury note`, error);
    return false;
  }
}

function toCalendarDate(api, timestamp) {
  if (typeof api?.timestampToDate === "function") {
    try {
      const date = api.timestampToDate(timestamp);
      if (date && Number.isFinite(Number(date.year))) return date;
    } catch {
      // Return null below.
    }
  }
  return null;
}

function extractDocumentId(value) {
  if (typeof value === "string") return value;
  return String(value?.id ?? value?._id ?? value?.document?.id ?? "");
}

function buildCriticalInjuryNoteMarker(actor, injury) {
  const actorId = String(actor?.id ?? "").trim();
  const injuryId = String(injury?.id ?? "").trim();
  const workflowId = String(injury?.pendingId ?? "").trim();
  if (!actorId || (!injuryId && !workflowId)) return "";
  return [INJURY_NOTE_MARKER_PREFIX, actorId, injuryId, workflowId]
    .map((part) => encodeURIComponent(part))
    .join(":");
}

function findCriticalInjuryNote(
  notes,
  marker,
  { entryId = "", excludeEntryId = "" } = {},
) {
  if (!marker) return null;
  return (
    Array.from(notes ?? []).find(
      (note) =>
        (!entryId || extractDocumentId(note) === String(entryId)) &&
        extractDocumentId(note) !== String(excludeEntryId ?? "") &&
        getCalendarNoteContent(note).some((content) =>
          content.includes(marker),
        ),
    ) ?? null
  );
}

function getCalendarNoteContent(note) {
  const content = [note?.content, note?.text?.content];
  const pages =
    note?.pages?.contents ?? note?.pages ?? note?._source?.pages ?? [];
  for (const page of Array.from(pages ?? [])) {
    content.push(
      page?.text?.content,
      page?._source?.text?.content,
      page?.content,
    );
  }
  return content.filter((value) => typeof value === "string");
}

function calendarNoteResult({
  scheduled = false,
  entryId = "",
  created = false,
  reused = false,
  previousEntryId = "",
  reason = "",
} = {}) {
  return {
    scheduled: Boolean(scheduled),
    entryId: String(entryId ?? ""),
    created: Boolean(created),
    reused: Boolean(reused),
    previousEntryId: String(previousEntryId ?? ""),
    reason: String(reason ?? ""),
  };
}

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}
