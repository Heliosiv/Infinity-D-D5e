/**
 * Infinity D&D5e - private Quartermaster run receipts (pure)
 *
 * Receipts are deliberately allowlisted plain data. They live only inside the
 * restricted resourceRunState flag; Actor/Item documents, matching rules, raw
 * configuration, and socket payloads never belong here.
 */

export const RESOURCE_RUN_RECEIPT_VERSION = 1;
export const RESOURCE_RUN_HISTORY_LIMIT = 20;

const MAX_ACTORS = 100;
const MAX_RESOURCES = 50;
const MAX_ERRORS = 20;
const MAX_SUGGESTIONS = 100;
const MAX_REASONS = 10;

const RECEIPT_KINDS = new Set(["upkeep", "forage", "interrupted"]);
const RECEIPT_TRIGGERS = new Set(["calendar", "manual", "forage"]);
const RECEIPT_STATUSES = new Set(["complete", "partial", "interrupted"]);
const FORAGE_TARGETS = new Set(["food-water", "food", "water"]);
const RUN_ACTOR_ROLES = new Set([
  "participant",
  "inventory",
  "participant-inventory",
]);

function text(value, fallback = "", maxLength = 160) {
  const normalized = String(value ?? "").trim();
  return (normalized || fallback).slice(0, maxLength);
}

function nullableInteger(value) {
  if (value == null || !Number.isFinite(Number(value))) return null;
  return Math.floor(Number(value));
}

function timestamp(value) {
  const normalized = Number(value);
  return Number.isSafeInteger(normalized) && normalized >= 0
    ? normalized
    : null;
}

function amount(value) {
  const normalized = Number(value);
  if (!Number.isFinite(normalized)) return 0;
  return Math.max(0, normalized);
}

function strings(values, limit = MAX_ERRORS) {
  if (!Array.isArray(values)) return [];
  return values
    .slice(0, limit)
    .map((value) => text(value, "", 500))
    .filter(Boolean);
}

export function normalizeRunEnvironmentSnapshot(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const id = text(value.id, "", 200);
  const requestedLabel = text(value.label, "", 200);
  if (!id && !requestedLabel) return null;
  const label = requestedLabel || id;
  const dc = Number(value.dc);
  return {
    id: id || null,
    label,
    dc: Number.isFinite(dc) ? dc : null,
  };
}

export function normalizeRunInitiatorSnapshot(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const userId = text(value.userId, "", 200);
  if (!userId) return null;
  return {
    userId,
    name: text(value.name, "GM", 200),
  };
}

export function normalizeRunActorSnapshots(values) {
  const rows = Array.isArray(values) ? values : [];
  const seen = new Set();
  const out = [];
  for (const value of rows) {
    if (!value || typeof value !== "object" || Array.isArray(value)) continue;
    const actorId = text(value.actorId, "", 200);
    if (!actorId || seen.has(actorId)) continue;
    seen.add(actorId);
    out.push({
      actorId,
      name: text(value.name, "Character", 200),
      role: RUN_ACTOR_ROLES.has(value.role) ? value.role : "participant",
    });
    if (out.length >= MAX_ACTORS) break;
  }
  return out;
}

/**
 * Merge run participants with every Actor whose inventory could be written.
 * Interrupted receipts can then identify both who took part and every sheet or
 * stash a GM needs to review, without retaining live Actor documents.
 */
export function buildRunActorSnapshots({
  participants = [],
  writeTargets = [],
} = {}) {
  const byId = new Map();
  const add = (value, role) => {
    if (!value || typeof value !== "object" || Array.isArray(value)) return;
    const actorId = text(value.actorId, "", 200);
    if (!actorId) return;
    const current = byId.get(actorId);
    byId.set(actorId, {
      actorId,
      name: current?.name ?? text(value.name, "Character", 200),
      role: current && current.role !== role ? "participant-inventory" : role,
    });
  };
  for (const actor of Array.isArray(writeTargets) ? writeTargets : []) {
    add(actor, "inventory");
  }
  for (const actor of Array.isArray(participants) ? participants : []) {
    add(actor, "participant");
  }
  return normalizeRunActorSnapshots([...byId.values()]);
}

function normalizeForage(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return {
    attempted: value.attempted === true,
    success: value.success === true,
    suppressed: value.suppressed === true,
    food: amount(value.food),
    water: amount(value.water),
    errors: strings(value.errors),
  };
}

function normalizeResourceRows(values) {
  const rows = Array.isArray(values) ? values : [];
  const seen = new Set();
  const out = [];
  for (const value of rows.slice(0, MAX_RESOURCES)) {
    if (!value || typeof value !== "object" || Array.isArray(value)) continue;
    const id = text(value.id, "", 200);
    if (!id || seen.has(id)) continue;
    seen.add(id);
    out.push({
      id,
      label: text(value.label, id, 200),
      consumed: amount(value.consumed),
      shortfall: amount(value.shortfall),
    });
  }
  return out;
}

function normalizeActors(values) {
  const rows = Array.isArray(values) ? values : [];
  const seen = new Set();
  const out = [];
  for (const value of rows.slice(0, MAX_ACTORS)) {
    if (!value || typeof value !== "object" || Array.isArray(value)) continue;
    const actorId = text(value.actorId, "", 200);
    if (!actorId || seen.has(actorId)) continue;
    seen.add(actorId);
    out.push({
      actorId,
      name: text(value.name, "Character", 200),
      resources: normalizeResourceRows(value.resources),
      forage: normalizeForage(value.forage),
      errors: strings(value.errors),
    });
  }
  return out;
}

function normalizePartyResources(values) {
  const rows = Array.isArray(values) ? values : [];
  const seen = new Set();
  const out = [];
  for (const value of rows.slice(0, MAX_RESOURCES)) {
    if (!value || typeof value !== "object" || Array.isArray(value)) continue;
    const id = text(value.id, "", 200);
    if (!id || seen.has(id)) continue;
    seen.add(id);
    out.push({
      id,
      label: text(value.label, id, 200),
      consumed: amount(value.consumed),
      shortfall: amount(value.shortfall),
      error: text(value.error, "", 500),
    });
  }
  return out;
}

function normalizeSuggestions(values) {
  const rows = Array.isArray(values) ? values : [];
  const seen = new Set();
  const out = [];
  for (const value of rows.slice(0, MAX_SUGGESTIONS)) {
    if (!value || typeof value !== "object" || Array.isArray(value)) continue;
    const actorId = text(value.actorId, "", 200);
    if (!actorId || seen.has(actorId)) continue;
    seen.add(actorId);
    out.push({
      actorId,
      name: text(value.name, "Character", 200),
      suggestDelta: amount(value.suggestDelta),
      reasons: strings(value.reasons, MAX_REASONS),
    });
  }
  return out;
}

export function normalizeForageDestination(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const mode = value.mode === "party-stash" ? "party-stash" : "draw-sources";
  return {
    mode,
    actorId:
      mode === "party-stash" ? text(value.actorId, "", 200) || null : null,
    name:
      mode === "party-stash"
        ? text(value.name, "Party stash", 200)
        : "Each forager's draw source",
  };
}

function normalizeForageDrive(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const target = FORAGE_TARGETS.has(value.target) ? value.target : null;
  if (!target) return null;
  const dc = Number(value.dc);
  return {
    target,
    mode: value.mode === "best" ? "best" : "each",
    dc: Number.isFinite(dc) ? dc : null,
    destination: normalizeForageDestination(value.destination),
    totalFood: amount(value.totalFood),
    totalWater: amount(value.totalWater),
    errors: strings(value.errors),
  };
}

function normalizeForageContext(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const target = FORAGE_TARGETS.has(value.target) ? value.target : null;
  const destination = normalizeForageDestination(value.destination);
  if (!target && !destination) return null;
  return { target, destination };
}

/** Normalize one durable private receipt, dropping every unapproved field. */
export function normalizeRunReceipt(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) return null;
  const runId = text(input.runId, "", 200);
  const kind = RECEIPT_KINDS.has(input.kind) ? input.kind : null;
  const trigger = RECEIPT_TRIGGERS.has(input.trigger) ? input.trigger : null;
  const status = RECEIPT_STATUSES.has(input.status) ? input.status : null;
  const recordedAt = timestamp(input.recordedAt);
  if (!runId || !kind || !trigger || !status || recordedAt === null)
    return null;

  const isInterrupted = kind === "interrupted";
  const isForage = kind === "forage";
  const validPair =
    (isInterrupted && status === "interrupted") ||
    (isForage && trigger === "forage" && status !== "interrupted") ||
    (kind === "upkeep" &&
      (trigger === "calendar" || trigger === "manual") &&
      status !== "interrupted");
  if (!validPair) return null;

  const forageDrive = isForage ? normalizeForageDrive(input.forageDrive) : null;
  if (isForage && !forageDrive) return null;

  return {
    version: RESOURCE_RUN_RECEIPT_VERSION,
    runId,
    kind,
    trigger,
    status,
    outcomeUnknown: isInterrupted,
    day: nullableInteger(input.day),
    days: Math.max(1, Math.min(365, Math.floor(amount(input.days)) || 1)),
    startedAt: timestamp(input.startedAt) ?? timestamp(input.claimedAt),
    claimedAt: timestamp(input.claimedAt),
    recordedAt,
    environment: normalizeRunEnvironmentSnapshot(input.environment),
    initiator: normalizeRunInitiatorSnapshot(input.initiator),
    actors: isInterrupted
      ? normalizeRunActorSnapshots(input.actors).map((actor) => ({
          ...actor,
          resources: [],
          forage: null,
          errors: [],
        }))
      : normalizeActors(input.actors),
    partyResources: isInterrupted
      ? []
      : normalizePartyResources(input.partyResources),
    exhaustionSuggestions:
      isInterrupted || isForage
        ? []
        : normalizeSuggestions(input.exhaustionSuggestions),
    forageContext:
      trigger === "forage" ? normalizeForageContext(input.forageContext) : null,
    forageDrive,
  };
}

/**
 * Newest-first, run-id deduplicated, fixed-size history. The array order is the
 * canonical completion order; wall clocks can move backward and must not evict
 * a just-committed receipt.
 */
export function normalizeRecentRuns(input) {
  const rows = (Array.isArray(input) ? input : [])
    .map(normalizeRunReceipt)
    .filter(Boolean);
  const seen = new Set();
  const out = [];
  for (const receipt of rows) {
    if (seen.has(receipt.runId)) continue;
    seen.add(receipt.runId);
    out.push(receipt);
    if (out.length >= RESOURCE_RUN_HISTORY_LIMIT) break;
  }
  return out;
}

export function appendRecentRunReceipt(history, receipt) {
  const normalized = normalizeRunReceipt(receipt);
  if (!normalized) throw new Error("ResourceRunReceiptInvalid");
  const withoutSameRun = (Array.isArray(history) ? history : []).filter(
    (entry) => text(entry?.runId, "", 200) !== normalized.runId,
  );
  return normalizeRecentRuns([normalized, ...withoutSameRun]);
}

function resourceSnapshot(result) {
  return (
    Array.isArray(result?.resourceSnapshot) ? result.resourceSnapshot : []
  )
    .filter((resource) => resource && typeof resource === "object")
    .map((resource) => ({
      id: text(resource.id, "", 200),
      label: text(resource.label, resource.id, 200),
      scope: resource.scope === "party" ? "party" : "per-character",
    }))
    .filter((resource) => resource.id)
    .slice(0, MAX_RESOURCES);
}

/** Build the allowlisted detailed receipt for calendar/manual upkeep. */
export function buildUpkeepRunReceipt({
  result,
  environment = null,
  recordedAt = Date.now(),
} = {}) {
  if (!result || typeof result !== "object") return null;
  const resources = resourceSnapshot(result);
  const perCharacter = resources.filter(
    (resource) => resource.scope !== "party",
  );
  const party = resources.filter((resource) => resource.scope === "party");
  return normalizeRunReceipt({
    runId: result.runId,
    kind: "upkeep",
    trigger: result.trigger === "calendar" ? "calendar" : "manual",
    status:
      result.status === "partial" || result.hasErrors === true
        ? "partial"
        : "complete",
    day: result.day,
    days: result.days,
    startedAt: result.startedAt,
    claimedAt: null,
    recordedAt,
    environment:
      environment ??
      (result.environmentId
        ? {
            id: result.environmentId,
            label: result.environmentId,
            dc: null,
          }
        : null),
    actors: (Array.isArray(result.perActor) ? result.perActor : []).map(
      (row) => ({
        actorId: row?.actorId,
        name: row?.name,
        resources: perCharacter
          .map((resource) => ({
            id: resource.id,
            label: resource.label,
            consumed: row?.consumed?.[resource.id],
            shortfall: row?.shortfalls?.[resource.id],
          }))
          .filter(
            (resource) =>
              amount(resource.consumed) > 0 || amount(resource.shortfall) > 0,
          ),
        forage:
          result.trigger === "manual" && row?.foraged?.attempted !== true
            ? null
            : row?.foraged,
        errors: row?.errors,
      }),
    ),
    partyResources: party
      .map((resource) => ({
        id: resource.id,
        label: resource.label,
        consumed: result.party?.[resource.id]?.consumed,
        shortfall: result.party?.[resource.id]?.shortfall,
        error: result.party?.[resource.id]?.error,
      }))
      .filter(
        (resource) =>
          amount(resource.consumed) > 0 ||
          amount(resource.shortfall) > 0 ||
          text(resource.error, "", 500),
      ),
    exhaustionSuggestions: result.suggestions,
    forageDrive: null,
  });
}

/** Build the allowlisted detailed receipt for a forage-only drive. */
export function buildForageRunReceipt({
  runId,
  day = null,
  environment = null,
  perForager = [],
  forageTarget = "food-water",
  forageMode = "each",
  destination = null,
  totalFood = 0,
  totalWater = 0,
  depositErrors = [],
  recordedAt = Date.now(),
} = {}) {
  const errors = strings(depositErrors);
  return normalizeRunReceipt({
    runId,
    kind: "forage",
    trigger: "forage",
    status: errors.length > 0 ? "partial" : "complete",
    day,
    days: 1,
    startedAt: null,
    claimedAt: null,
    recordedAt,
    environment,
    actors: (Array.isArray(perForager) ? perForager : []).map((row) => ({
      actorId: row?.actorId,
      name: row?.name,
      resources: [],
      forage: row,
      errors: [],
    })),
    partyResources: [],
    exhaustionSuggestions: [],
    forageContext: { target: forageTarget, destination },
    forageDrive: {
      target: forageTarget,
      mode: forageMode,
      dc: environment?.dc,
      destination,
      totalFood,
      totalWater,
      errors,
    },
  });
}

/** Build an acknowledgement-only receipt from the canonical active lease. */
export function buildInterruptedRunReceipt(
  activeUpkeep,
  recordedAt = Date.now(),
) {
  if (!activeUpkeep || typeof activeUpkeep !== "object") return null;
  return normalizeRunReceipt({
    runId: activeUpkeep.runId,
    kind: "interrupted",
    trigger: activeUpkeep.trigger,
    status: "interrupted",
    outcomeUnknown: true,
    day: activeUpkeep.day,
    days: activeUpkeep.days,
    startedAt: activeUpkeep.startedAt,
    claimedAt: activeUpkeep.claimedAt,
    recordedAt,
    environment: activeUpkeep.environment,
    initiator: activeUpkeep.initiator,
    actors: activeUpkeep.actors,
    forageContext:
      activeUpkeep.trigger === "forage"
        ? {
            target: activeUpkeep.forageTarget,
            destination: activeUpkeep.forageDestination,
          }
        : null,
  });
}

function formatDateTime(value, { locale, timeZone } = {}) {
  const normalized = timestamp(value);
  if (normalized === null) return "Time not recorded";
  try {
    return new Intl.DateTimeFormat(locale, {
      dateStyle: "medium",
      timeStyle: "short",
      ...(timeZone ? { timeZone } : {}),
    }).format(new Date(normalized));
  } catch {
    return new Date(normalized).toLocaleString();
  }
}

function forageNote(forage) {
  if (!forage?.attempted) return "No roll recorded";
  if (!forage.success) return "No supplies gathered";
  if (forage.suppressed) return "Gathered; best party haul kept";
  const totals = [];
  if (forage.food > 0) totals.push(`+${forage.food} food`);
  if (forage.water > 0) totals.push(`+${forage.water} water`);
  return totals.length > 0
    ? `Gathered ${totals.join(" / ")}`
    : "No supplies gathered";
}

function targetLabel(target) {
  if (target === "food") return "Food only";
  if (target === "water") return "Water only";
  return "Food and water";
}

function runActorRoleLabel(role) {
  if (role === "inventory") return "Inventory to review";
  if (role === "participant-inventory") return "Participant and inventory";
  return "Participant";
}

/** Convert normalized receipts to a Handlebars-ready, read-only view model. */
export function presentRecentRuns(history, dateOptions = {}) {
  return normalizeRecentRuns(history).map((receipt) => {
    const isInterrupted = receipt.kind === "interrupted";
    const isForage = receipt.kind === "forage";
    const actorRows = receipt.actors.map((actor) => {
      const displayErrors = [
        ...new Set([
          ...actor.errors,
          ...(Array.isArray(actor.forage?.errors) ? actor.forage.errors : []),
        ]),
      ];
      return {
        ...actor,
        roleLabel: isInterrupted ? runActorRoleLabel(actor.role) : "",
        hasRole: isInterrupted,
        forageNote: actor.forage ? forageNote(actor.forage) : "",
        hasForage: Boolean(actor.forage),
        hasResources: actor.resources.length > 0,
        displayErrors,
        hasErrors: displayErrors.length > 0,
      };
    });
    const forageDrive = receipt.forageDrive
      ? {
          ...receipt.forageDrive,
          hasDc: receipt.forageDrive.dc !== null,
          targetLabel: targetLabel(receipt.forageDrive.target),
          modeLabel:
            receipt.forageDrive.mode === "best"
              ? "Best haul feeds the party"
              : "Each forager keeps their own haul",
          destinationLabel:
            receipt.forageDrive.destination?.name ?? "Destination not recorded",
          hasErrors: receipt.forageDrive.errors.length > 0,
        }
      : null;
    const forageContext = receipt.forageContext
      ? {
          ...receipt.forageContext,
          targetLabel: receipt.forageContext.target
            ? targetLabel(receipt.forageContext.target)
            : "Target not recorded",
          destinationLabel:
            receipt.forageContext.destination?.name ??
            "Destination not recorded",
        }
      : null;
    const triggerLabel = isInterrupted
      ? receipt.trigger === "forage"
        ? "Interrupted forage drive"
        : receipt.trigger === "calendar"
          ? "Interrupted automatic upkeep"
          : "Interrupted Advance Day"
      : receipt.trigger === "forage"
        ? "Forage Drive"
        : receipt.trigger === "calendar"
          ? "Automatic upkeep"
          : "Advance Day";
    const statusLabel = isInterrupted
      ? "Interrupted"
      : receipt.status === "partial"
        ? "Partial"
        : "Complete";
    const dayLabel =
      receipt.day === null
        ? `${receipt.days} ${receipt.days === 1 ? "day" : "days"}; calendar day not recorded`
        : `Day ${receipt.day}; ${receipt.days} ${receipt.days === 1 ? "day" : "days"}`;
    const accountedResources = [
      ...actorRows.flatMap((actor) => actor.resources),
      ...receipt.partyResources,
    ];
    const totalConsumed = accountedResources.reduce(
      (sum, resource) => sum + resource.consumed,
      0,
    );
    const totalShortfall = accountedResources.reduce(
      (sum, resource) => sum + resource.shortfall,
      0,
    );
    const actorCountLabel = isInterrupted
      ? `${actorRows.length} affected ${actorRows.length === 1 ? "actor" : "actors"}`
      : `${actorRows.length} ${actorRows.length === 1 ? "character" : "characters"}`;
    const summaryLabel = isInterrupted
      ? "Inventory outcome unknown"
      : isForage
        ? `+${forageDrive.totalFood} food / +${forageDrive.totalWater} water`
        : `${totalConsumed} used / ${totalShortfall} short`;
    return {
      ...receipt,
      isInterrupted,
      isForage,
      isUpkeep: receipt.kind === "upkeep",
      triggerLabel,
      statusLabel,
      statusTone: isInterrupted
        ? "unknown"
        : receipt.status === "partial"
          ? "partial"
          : "complete",
      recordedAtLabel: formatDateTime(receipt.recordedAt, dateOptions),
      startedAtLabel:
        receipt.startedAt === null
          ? "Start time not recorded"
          : formatDateTime(receipt.startedAt, dateOptions),
      environmentLabel:
        receipt.environment?.label ?? "Environment not recorded",
      initiatorLabel: receipt.initiator?.name ?? "Initiating GM not recorded",
      dayLabel,
      actorCountLabel,
      summaryLabel,
      actors: actorRows,
      hasActors: actorRows.length > 0,
      partyResources: receipt.partyResources.map((resource) => ({
        ...resource,
        hasShortfall: resource.shortfall > 0,
        hasError: Boolean(resource.error),
      })),
      hasPartyResources: receipt.partyResources.length > 0,
      exhaustionSuggestions: receipt.exhaustionSuggestions,
      hasExhaustionSuggestions: receipt.exhaustionSuggestions.length > 0,
      forageContext,
      forageDrive,
    };
  });
}
