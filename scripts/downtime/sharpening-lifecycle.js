const MAX_ID_LENGTH = 160;
const MAX_ERROR_LENGTH = 300;
const MAX_PENDING_EVENTS = 200;
const MAX_COMPLETED_EVENTS = 500;
const EVENT_KINDS = new Set(["damage", "long-rest"]);

function cleanId(value) {
  return String(value ?? "")
    .trim()
    .replace(/[^A-Za-z0-9_.:-]/g, "")
    .slice(0, MAX_ID_LENGTH);
}

function timestamp(value, fallback = 0) {
  const number = Number(value);
  return Number.isSafeInteger(number) && number >= 0 ? number : fallback;
}

function attempts(value) {
  const number = Math.floor(Number(value));
  return Number.isSafeInteger(number) && number >= 0
    ? Math.min(number, 10_000)
    : 0;
}

function normalizePendingRecord(raw = {}) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const eventId = cleanId(raw.eventId ?? raw.id);
  const kind = String(raw.kind ?? "").trim();
  const actorId = cleanId(raw.actorId);
  const itemId = cleanId(raw.itemId);
  const effectId = cleanId(raw.effectId);
  const operationId = cleanId(raw.operationId);
  const rollId = cleanId(raw.rollId);
  const originUserId = cleanId(raw.originUserId);
  if (
    !eventId ||
    !EVENT_KINDS.has(kind) ||
    !actorId ||
    !itemId ||
    !effectId ||
    !operationId ||
    !originUserId
  ) {
    return null;
  }
  if (kind === "damage" && !rollId) return null;
  return {
    eventId,
    kind,
    actorId,
    itemId,
    effectId,
    operationId,
    rollId: kind === "damage" ? rollId : null,
    originUserId,
    acceptedAt: timestamp(raw.acceptedAt),
    attempts: attempts(raw.attempts),
    lastAttemptAt: timestamp(raw.lastAttemptAt),
    lastError:
      String(raw.lastError ?? "")
        .replace(/[\u0000-\u001f\u007f]/g, " ")
        .trim()
        .slice(0, MAX_ERROR_LENGTH) || null,
  };
}

function normalizeCompletedRecord(raw, fallbackId = "") {
  if (Number.isFinite(Number(raw))) {
    const eventId = cleanId(fallbackId);
    return eventId
      ? { eventId, completedAt: timestamp(raw), outcome: "applied" }
      : null;
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const eventId = cleanId(raw.eventId ?? raw.id ?? fallbackId);
  if (!eventId) return null;
  return {
    eventId,
    completedAt: timestamp(raw.completedAt),
    outcome:
      String(raw.outcome ?? "applied")
        .trim()
        .slice(0, 80) || "applied",
  };
}

function sourceRecords(value) {
  if (Array.isArray(value)) return value.map((entry) => ["", entry]);
  if (!value || typeof value !== "object") return [];
  return Object.entries(value);
}

function byTimeThenId(left, right, field) {
  return (
    Number(left[field] ?? 0) - Number(right[field] ?? 0) ||
    left.eventId.localeCompare(right.eventId)
  );
}

/** Normalize the private, GM-owned queue used by sharpening roll/rest hooks. */
export function normalizeSharpeningLifecycle(raw = {}) {
  const source =
    raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {};
  const completed = new Map();
  for (const [fallbackId, value] of sourceRecords(source.completed)) {
    const record = normalizeCompletedRecord(value, fallbackId);
    if (record) completed.set(record.eventId, record);
  }
  const completedRecords = [...completed.values()]
    .sort((left, right) => byTimeThenId(left, right, "completedAt"))
    .slice(-MAX_COMPLETED_EVENTS);
  const completedIds = new Set(completedRecords.map((entry) => entry.eventId));

  const pending = new Map();
  for (const [, value] of sourceRecords(source.pending)) {
    const record = normalizePendingRecord(value);
    if (record && !completedIds.has(record.eventId)) {
      pending.set(record.eventId, record);
    }
  }
  return {
    pending: [...pending.values()]
      .sort((left, right) => byTimeThenId(left, right, "acceptedAt"))
      .slice(-MAX_PENDING_EVENTS),
    completed: completedRecords,
  };
}

export function enqueueSharpeningLifecycleEvent(rawState, rawEvent) {
  const state = normalizeSharpeningLifecycle(rawState);
  const event = normalizePendingRecord(rawEvent);
  if (!event) throw new Error("DowntimeSharpeningLifecycleEventInvalid");
  if (state.completed.some((entry) => entry.eventId === event.eventId)) {
    return { state, status: "completed", event };
  }
  if (state.pending.some((entry) => entry.eventId === event.eventId)) {
    return { state, status: "pending", event };
  }
  return {
    state: normalizeSharpeningLifecycle({
      ...state,
      pending: [...state.pending, event],
    }),
    status: "queued",
    event,
  };
}

export function failSharpeningLifecycleEvent(
  rawState,
  eventId,
  { at = Date.now(), reason = "write-failed" } = {},
) {
  const state = normalizeSharpeningLifecycle(rawState);
  const id = cleanId(eventId);
  return normalizeSharpeningLifecycle({
    ...state,
    pending: state.pending.map((entry) =>
      entry.eventId === id
        ? {
            ...entry,
            attempts: entry.attempts + 1,
            lastAttemptAt: timestamp(at),
            lastError: reason,
          }
        : entry,
    ),
  });
}

export function completeSharpeningLifecycleEvent(
  rawState,
  eventId,
  { at = Date.now(), outcome = "applied" } = {},
) {
  const state = normalizeSharpeningLifecycle(rawState);
  const id = cleanId(eventId);
  if (!id) return state;
  return normalizeSharpeningLifecycle({
    pending: state.pending.filter((entry) => entry.eventId !== id),
    completed: [
      ...state.completed.filter((entry) => entry.eventId !== id),
      { eventId: id, completedAt: timestamp(at), outcome },
    ],
  });
}
