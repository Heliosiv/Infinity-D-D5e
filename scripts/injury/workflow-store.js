/**
 * GM-only persistence for approved and resolved Critical Injury rolls.
 *
 * Actor flags are a player-visible projection of pending work, not an
 * authorization boundary: an Actor owner can edit their own flags. The
 * canonical approval, rolled values, and completed receipt therefore live in
 * the restricted private-state Journal and are written only by the current
 * authoritative full GM.
 */

import {
  PRIVATE_STATE_CHANGED_HOOK,
  getPrivateState,
  onPrivateStateChanged,
  setPrivateState,
} from "../private-state.js";
import { isFullGM } from "../permissions.js";
import { authoritativeGMId, isAuthoritativeGM } from "../socket-authority.js";
import {
  assertSupportedPersistedVersion,
  persistedValuesEqual,
  persistedVersionEquals,
} from "../utils/persisted-data.js";

const MODULE_ID = "infinity-dnd5e";
const STORE_KEY = "criticalInjuryWorkflow";
const CHECKPOINT_KEY = "criticalInjuryWorkflowCheckpoint";
const STORE_VERSION = 2;
const RECORD_SCHEMA = 1;
const TREATMENT_SCHEMA = 1;
const REST_EVENT_SCHEMA = 1;
const MAX_ID_LENGTH = 160;
const MAX_COMPLETED_RECEIPTS = 200;
const MAX_COMPLETED_TREATMENTS_PER_INJURY = 100;
const MAX_DETAILED_COMPLETED_RESTS = 200;
const DEFAULT_APPLICATION_LEASE_MS = 60_000;
const MIN_APPLICATION_LEASE_MS = 5_000;
const MAX_APPLICATION_LEASE_MS = 300_000;
// "review" is intentionally kept in the same durable record as the existing
// approval receipt.  It is GM-only and has no Actor-flag projection until the
// GM explicitly sends the player roll prompt.
const VALID_STATES = new Set(["review", "approved", "resolving", "completed"]);
const VALID_TREATMENT_STATES = new Set(["requested", "resolving", "completed"]);
const VALID_REST_STATES = new Set(["requested", "resolving", "completed"]);

let writeQueue = Promise.resolve();
let observerRegistered = false;
let authorityObservationStarted = false;
let observedAuthorityId = null;
let authorityGeneration = 0;
let observedAuthorityEpoch = null;
let highestObservedRevision = -1;
let lastAcceptedEnvelope = null;
let reconciliationInFlight = null;
let reconciliationRequested = false;
const observerHookIds = [];
const retiredAuthorityEpochs = new Set();

function clone(value) {
  if (value == null) return value;
  return (
    globalThis.foundry?.utils?.deepClone?.(value) ?? structuredClone(value)
  );
}

function toId(value) {
  const id = String(value ?? "").trim();
  return id && id.length <= MAX_ID_LENGTH ? id : "";
}

function finiteTimestamp(value, fallback = null) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function nonNegativeInteger(value, fallback = null) {
  const number = Number(value);
  return Number.isSafeInteger(number) && number >= 0 ? number : fallback;
}

function finiteInteger(value, fallback = null) {
  const number = Number(value);
  return Number.isSafeInteger(number) ? number : fallback;
}

function normalizePersistedObject(raw, { exact = false } = {}) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  try {
    const normalized = JSON.parse(JSON.stringify(raw));
    const valid =
      normalized &&
      typeof normalized === "object" &&
      !Array.isArray(normalized) &&
      (!exact || persistedValuesEqual(raw, normalized));
    return valid ? normalized : null;
  } catch {
    return null;
  }
}

function normalizeResolution(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const injuryId = toId(raw.injuryId);
  const effectDocumentId = toId(raw.effectDocumentId);
  const injuryKey = toId(raw.injuryKey);
  const requestedBy = toId(raw.requestedBy);
  const resolvedBy = toId(raw.resolvedBy);
  const injuryRoll = nonNegativeInteger(raw.injuryRoll);
  const recoveryDays = nonNegativeInteger(raw.recoveryDays);
  const recoveryStartTs = finiteTimestamp(raw.recoveryStartTs);
  const recoveryDueWasProvided = raw.recoveryDueTs != null;
  const recoveryDueTs =
    raw.recoveryDueTs == null ? null : finiteTimestamp(raw.recoveryDueTs);
  const resolvedAt = finiteTimestamp(raw.resolvedAt);
  const detailWasProvided = raw.detailTotal != null;
  const detailTotal =
    raw.detailTotal == null ? null : nonNegativeInteger(raw.detailTotal);
  const recoveryFormula = String(raw.recoveryFormula ?? "").trim();
  const tableVersion = nonNegativeInteger(raw.tableVersion);
  if (
    !injuryId ||
    !injuryKey ||
    !effectDocumentId ||
    !requestedBy ||
    !resolvedBy ||
    injuryRoll == null ||
    injuryRoll < 1 ||
    injuryRoll > 100 ||
    recoveryDays == null ||
    recoveryStartTs == null ||
    resolvedAt == null ||
    (detailWasProvided && detailTotal == null) ||
    (recoveryDueWasProvided && recoveryDueTs == null) ||
    (recoveryDays > 0 && recoveryDueTs == null) ||
    !recoveryFormula ||
    recoveryFormula.length > 100 ||
    tableVersion == null ||
    tableVersion < 1
  ) {
    return null;
  }
  return {
    injuryId,
    effectDocumentId,
    injuryKey,
    injuryRoll,
    tableVersion,
    recoveryFormula,
    recoveryDays,
    detailTotal,
    recoveryStartTs,
    recoveryDueTs,
    requestedBy,
    resolvedBy,
    resolvedAt,
  };
}

function normalizeApplicationLease(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const id = toId(raw.id);
  const claimedBy = toId(raw.claimedBy);
  const claimedAt = finiteTimestamp(raw.claimedAt);
  const expiresAt = finiteTimestamp(raw.expiresAt);
  if (
    !id ||
    !claimedBy ||
    claimedAt == null ||
    expiresAt == null ||
    expiresAt <= claimedAt
  ) {
    return null;
  }
  return { id, claimedBy, claimedAt, expiresAt };
}

function normalizeApplicationLeaseDuration(value) {
  const duration = Number(value);
  if (!Number.isFinite(duration)) return DEFAULT_APPLICATION_LEASE_MS;
  return Math.min(
    MAX_APPLICATION_LEASE_MS,
    Math.max(MIN_APPLICATION_LEASE_MS, Math.floor(duration)),
  );
}

function normalizeRestOutcome(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const effectId = toId(raw.effectId);
  const injuryId = toId(raw.injuryId);
  const pendingId = toId(raw.pendingId);
  const receiptToken = toId(raw.receiptToken);
  const saveTotal = finiteInteger(raw.saveTotal);
  const infectionHpLossBefore = nonNegativeInteger(raw.infectionHpLossBefore);
  const infectionHpLossAfter = nonNegativeInteger(raw.infectionHpLossAfter);
  if (
    !effectId ||
    !injuryId ||
    !pendingId ||
    !receiptToken ||
    saveTotal == null ||
    typeof raw.passed !== "boolean" ||
    infectionHpLossBefore == null ||
    infectionHpLossAfter == null ||
    (raw.passed && infectionHpLossAfter !== infectionHpLossBefore) ||
    (!raw.passed && infectionHpLossAfter !== infectionHpLossBefore + 1)
  ) {
    return null;
  }
  return {
    effectId,
    injuryId,
    pendingId,
    saveTotal,
    passed: raw.passed,
    infectionHpLossBefore,
    infectionHpLossAfter,
    receiptToken,
  };
}

function normalizeRestResolution(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const resolvedBy = toId(raw.resolvedBy);
  const resolvedAt = finiteTimestamp(raw.resolvedAt);
  if (!resolvedBy || resolvedAt == null || !Array.isArray(raw.outcomes)) {
    return null;
  }
  const outcomes = [];
  const effectIds = new Set();
  const injuryIds = new Set();
  const pendingIds = new Set();
  const receiptTokens = new Set();
  for (const entry of raw.outcomes) {
    const outcome = normalizeRestOutcome(entry);
    if (
      !outcome ||
      effectIds.has(outcome.effectId) ||
      injuryIds.has(outcome.injuryId) ||
      pendingIds.has(outcome.pendingId) ||
      receiptTokens.has(outcome.receiptToken)
    ) {
      return null;
    }
    effectIds.add(outcome.effectId);
    injuryIds.add(outcome.injuryId);
    pendingIds.add(outcome.pendingId);
    receiptTokens.add(outcome.receiptToken);
    outcomes.push(outcome);
  }
  outcomes.sort((left, right) => left.effectId.localeCompare(right.effectId));
  return {
    schema: REST_EVENT_SCHEMA,
    resolvedBy,
    resolvedAt,
    outcomes,
  };
}

function normalizeRestResult(raw, expectedRestId = "", expectedActorId = "") {
  const normalized = normalizePersistedObject(raw);
  if (!normalized) return null;
  const restId = toId(raw.restId);
  const actorId = toId(raw.actorId);
  if (
    !restId ||
    !actorId ||
    (expectedRestId && restId !== expectedRestId) ||
    (expectedActorId && actorId !== expectedActorId)
  ) {
    return null;
  }
  return { ...normalized, restId, actorId };
}

function normalizeRestRecord(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const restId = toId(raw.restId);
  const actorId = toId(raw.actorId);
  const requestedBy = toId(raw.requestedBy);
  const requestedAt = finiteTimestamp(raw.requestedAt);
  if (!restId || !actorId || !requestedBy || requestedAt == null) return null;

  let state = VALID_REST_STATES.has(raw.state) ? raw.state : "requested";
  const resolution = normalizeRestResolution(raw.resolution);
  const applicationLease = normalizeApplicationLease(raw.applicationLease);
  const result = normalizeRestResult(raw.result, restId, actorId);
  const completedBy = toId(raw.completedBy);
  const completedAt =
    raw.completedAt == null ? null : finiteTimestamp(raw.completedAt);
  if (state === "resolving" && !resolution) state = "requested";
  if (
    state === "completed" &&
    (!result || !completedBy || completedAt == null)
  ) {
    state = resolution ? "resolving" : "requested";
  }

  return {
    schema: REST_EVENT_SCHEMA,
    restId,
    actorId,
    requestedBy,
    requestedAt,
    state,
    resolution: state === "requested" ? null : resolution,
    applicationLease: state === "completed" ? null : applicationLease,
    result: state === "completed" ? result : null,
    completedBy: state === "completed" ? completedBy : "",
    completedAt: state === "completed" ? completedAt : null,
  };
}

function compactCompletedRestRecord(record) {
  return {
    ...record,
    resolution: null,
  };
}

function pruneRestRecords(records) {
  const unresolved = records.filter((record) => record.state !== "completed");
  const completed = records
    .filter((record) => record.state === "completed")
    .sort(
      (left, right) =>
        Number(right.completedAt ?? 0) - Number(left.completedAt ?? 0),
    );
  const detailed = completed.slice(0, MAX_DETAILED_COMPLETED_RESTS);
  const tombstones = completed
    .slice(MAX_DETAILED_COMPLETED_RESTS)
    .map(compactCompletedRestRecord);
  return [...unresolved, ...detailed, ...tombstones];
}

function normalizeRestRecords(raw) {
  const records = [];
  const seen = new Set();
  for (const entry of Array.isArray(raw) ? raw : []) {
    const record = normalizeRestRecord(entry);
    if (!record || seen.has(record.restId)) continue;
    seen.add(record.restId);
    records.push(record);
  }
  return pruneRestRecords(records);
}

/** Use Foundry's synchronized server clock when available for lease fencing. */
export function getCriticalInjuryWorkflowLeaseTimestamp() {
  const serverTime = Number(globalThis.game?.time?.serverTime);
  return Number.isFinite(serverTime) ? serverTime : Date.now();
}

function normalizeResult(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const id = toId(raw.id);
  const injuryRoll = nonNegativeInteger(raw.injuryRoll);
  if (!id || injuryRoll == null || injuryRoll < 1 || injuryRoll > 100) {
    return null;
  }
  return clone(raw);
}

function normalizeTreatmentConsumptionStep(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const actorId = toId(raw.actorId);
  const itemId = toId(raw.itemId);
  const before = nonNegativeInteger(raw.before);
  const spend = nonNegativeInteger(raw.spend);
  const after = nonNegativeInteger(raw.after);
  if (
    !actorId ||
    !itemId ||
    before == null ||
    spend == null ||
    after == null ||
    spend > before ||
    after !== before - spend
  ) {
    return null;
  }
  return { actorId, itemId, before, spend, after };
}

function normalizeTreatmentResolution(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const effectId = toId(raw.effectId);
  const healerActorId = toId(raw.healerActorId);
  const injuryKey = toId(raw.injuryKey);
  const tableVersion = nonNegativeInteger(raw.tableVersion);
  const treatmentStartTs =
    raw.treatmentStartTs == null ? null : finiteTimestamp(raw.treatmentStartTs);
  const treatmentDc = nonNegativeInteger(raw.treatmentDc);
  const treatmentSkill = String(raw.treatmentSkill ?? "").trim();
  const checkWasProvided = raw.checkTotal != null;
  const checkTotal = checkWasProvided ? finiteInteger(raw.checkTotal) : null;
  const kitRequired = nonNegativeInteger(raw.kitRequired);
  const receiptToken = toId(raw.receiptToken);
  const injuryBefore = normalizePersistedObject(raw.injuryBefore, {
    exact: true,
  });
  const injuryAfter = normalizePersistedObject(raw.injuryAfter, {
    exact: true,
  });
  const previousCalendarEntryId = toId(raw.previousCalendarEntryId);
  const resolvedBy = toId(raw.resolvedBy);
  const resolvedAt =
    raw.resolvedAt == null ? null : finiteTimestamp(raw.resolvedAt);
  const consumptionSteps = [];
  const consumptionSources = new Set();
  for (const entry of Array.isArray(raw.consumptionSteps)
    ? raw.consumptionSteps
    : []) {
    const step = normalizeTreatmentConsumptionStep(entry);
    const source = step ? `${step.actorId}:${step.itemId}` : "";
    if (!step || consumptionSources.has(source)) return null;
    consumptionSources.add(source);
    consumptionSteps.push(step);
  }
  const consumed = consumptionSteps.reduce(
    (total, step) => total + step.spend,
    0,
  );
  if (
    !effectId ||
    !healerActorId ||
    !injuryKey ||
    tableVersion == null ||
    tableVersion < 1 ||
    treatmentStartTs == null ||
    treatmentDc == null ||
    treatmentSkill.length > 100 ||
    (checkWasProvided && checkTotal == null) ||
    typeof raw.passed !== "boolean" ||
    kitRequired == null ||
    consumed !== kitRequired ||
    !receiptToken ||
    !injuryBefore ||
    !injuryAfter ||
    !resolvedBy ||
    resolvedAt == null
  ) {
    return null;
  }
  return {
    schema: TREATMENT_SCHEMA,
    effectId,
    healerActorId,
    injuryKey,
    tableVersion,
    treatmentStartTs,
    treatmentDc,
    treatmentSkill,
    checkTotal,
    passed: raw.passed,
    kitRequired,
    receiptToken,
    consumptionSteps,
    injuryBefore,
    injuryAfter,
    previousCalendarEntryId,
    resolvedBy,
    resolvedAt,
  };
}

function normalizeTreatmentResult(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const treatmentId = toId(raw.treatmentId);
  const injuryId = toId(raw.injuryId);
  if (!treatmentId || !injuryId || typeof raw.success !== "boolean") {
    return null;
  }
  const normalized = normalizePersistedObject(raw);
  return normalized
    ? { ...normalized, treatmentId, injuryId, success: raw.success }
    : null;
}

function normalizeTreatmentRecord(raw, expectedInjuryId = "") {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const treatmentId = toId(raw.treatmentId);
  const injuryId = toId(raw.injuryId);
  const requestedBy = toId(raw.requestedBy);
  const requestedAt =
    raw.requestedAt == null ? null : finiteTimestamp(raw.requestedAt);
  if (
    !treatmentId ||
    !injuryId ||
    (expectedInjuryId && injuryId !== expectedInjuryId) ||
    !requestedBy ||
    requestedAt == null
  ) {
    return null;
  }

  let state = VALID_TREATMENT_STATES.has(raw.state) ? raw.state : "requested";
  const resolution = normalizeTreatmentResolution(raw.resolution);
  const applicationLease = normalizeApplicationLease(raw.applicationLease);
  const result = normalizeTreatmentResult(raw.result);
  const completedBy = toId(raw.completedBy);
  const completedAt =
    raw.completedAt == null ? null : finiteTimestamp(raw.completedAt);
  if (state === "resolving" && !resolution) state = "requested";
  if (
    state === "completed" &&
    (!result ||
      result.treatmentId !== treatmentId ||
      result.injuryId !== injuryId ||
      !completedBy ||
      completedAt == null)
  ) {
    state = "resolving";
  }

  return {
    schema: TREATMENT_SCHEMA,
    treatmentId,
    injuryId,
    requestedBy,
    requestedAt,
    state,
    resolution: state === "requested" ? null : resolution,
    applicationLease: state === "completed" ? null : applicationLease,
    result: state === "completed" ? result : null,
    completedBy: state === "completed" ? completedBy : "",
    completedAt: state === "completed" ? completedAt : null,
  };
}

function pruneTreatmentRecords(records) {
  const unresolved = records.filter((record) => record.state !== "completed");
  const completed = records
    .filter((record) => record.state === "completed")
    .sort(
      (left, right) =>
        Number(right.completedAt ?? 0) - Number(left.completedAt ?? 0),
    )
    .slice(0, MAX_COMPLETED_TREATMENTS_PER_INJURY);
  return [...unresolved, ...completed];
}

function normalizeTreatmentRecords(raw, expectedInjuryId) {
  const records = [];
  const seen = new Set();
  for (const entry of Array.isArray(raw) ? raw : []) {
    const record = normalizeTreatmentRecord(entry, expectedInjuryId);
    if (!record || seen.has(record.treatmentId)) continue;
    seen.add(record.treatmentId);
    records.push(record);
  }
  return pruneTreatmentRecords(records);
}

function normalizeRecord(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const pendingId = toId(raw.pendingId);
  const actorId = toId(raw.actorId);
  const targetUserId = toId(raw.targetUserId);
  const approvedBy = toId(raw.approvedBy);
  const approvedAt = finiteTimestamp(raw.approvedAt);
  if (
    !pendingId ||
    !actorId ||
    !targetUserId ||
    !approvedBy ||
    approvedAt == null
  ) {
    return null;
  }

  let state = VALID_STATES.has(raw.state) ? raw.state : "approved";
  const resolution = normalizeResolution(raw.resolution);
  const applicationLease = normalizeApplicationLease(raw.applicationLease);
  const result = normalizeResult(raw.result);
  const completedBy = toId(raw.completedBy);
  const completedAt = finiteTimestamp(raw.completedAt);
  if (state === "resolving" && !resolution) state = "approved";
  if (
    state === "completed" &&
    (!result || !completedBy || completedAt == null)
  ) {
    state = "resolving";
  }

  const normalized = {
    schema: RECORD_SCHEMA,
    pendingId,
    actorId,
    targetUserId,
    approvedBy,
    approvedAt,
    state,
    resolution: ["review", "approved"].includes(state) ? null : resolution,
    applicationLease: state === "completed" ? null : applicationLease,
    result: state === "completed" ? result : null,
    effectId: state === "completed" ? toId(raw.effectId) : "",
    calendarEntryId: state === "completed" ? toId(raw.calendarEntryId) : "",
    completedBy: state === "completed" ? completedBy : "",
    completedAt: state === "completed" ? completedAt : null,
  };
  if (state === "completed") {
    const injuryId = toId(resolution?.injuryId) || toId(result?.id);
    const treatments = normalizeTreatmentRecords(raw.treatments, injuryId);
    // Existing version-2 envelopes predate treatment attempts. Omitting an
    // empty collection preserves their exact normalized shape and therefore
    // their validity under raw-versus-normalized replica verification.
    if (treatments.length > 0) normalized.treatments = treatments;
  }
  return normalized;
}

function pruneRecords(
  records,
  { pinnedPendingIds = new Set(), pinnedActorIds = new Set() } = {},
) {
  const pinnedByRest = (record) =>
    pinnedPendingIds.has(record.pendingId) ||
    pinnedActorIds.has(record.actorId);
  const unresolved = records.filter(
    (record) =>
      record.state !== "completed" ||
      pinnedByRest(record) ||
      (record.treatments ?? []).some(
        (treatment) => treatment.state !== "completed",
      ),
  );
  const completed = records
    .filter(
      (record) =>
        record.state === "completed" &&
        !pinnedByRest(record) &&
        !(record.treatments ?? []).some(
          (treatment) => treatment.state !== "completed",
        ),
    )
    .sort(
      (left, right) =>
        latestRecordTimestamp(right) - latestRecordTimestamp(left),
    )
    .slice(0, MAX_COMPLETED_RECEIPTS);
  return [...unresolved, ...completed];
}

function latestRecordTimestamp(record) {
  return Math.max(
    Number(record?.completedAt ?? 0),
    ...(record?.treatments ?? []).map((treatment) =>
      Number(treatment?.completedAt ?? 0),
    ),
  );
}

export function normalizeCriticalInjuryWorkflowStore(raw) {
  const source =
    raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {};
  const restEvents = normalizeRestRecords(source.restEvents);
  const pinnedPendingIds = new Set();
  const pinnedActorIds = new Set();
  for (const event of restEvents) {
    if (event.state === "completed") continue;
    if (event.state === "requested") pinnedActorIds.add(event.actorId);
    for (const outcome of event.resolution?.outcomes ?? []) {
      pinnedPendingIds.add(outcome.pendingId);
    }
  }
  const records = [];
  const seen = new Set();
  for (const entry of Array.isArray(source.records) ? source.records : []) {
    const record = normalizeRecord(entry);
    if (!record || seen.has(record.pendingId)) continue;
    seen.add(record.pendingId);
    records.push(record);
  }
  const revision = nonNegativeInteger(source.revision, 0);
  const normalized = {
    version: STORE_VERSION,
    revision,
    authorityId: toId(source.authorityId) || null,
    authorityEpoch: toId(source.authorityEpoch) || null,
    writeToken: toId(source.writeToken) || null,
    records: pruneRecords(records, { pinnedPendingIds, pinnedActorIds }),
  };
  // Version-2 envelopes predate Infection rest receipts. Omitting an empty
  // collection preserves their exact normalized shape for replica validation.
  if (restEvents.length > 0) normalized.restEvents = restEvents;
  return normalized;
}

function isFoundryEnvironment() {
  return Boolean(globalThis.game && globalThis.JournalEntry?.create);
}

function isLiveFoundrySession() {
  return Boolean(isFoundryEnvironment() && globalThis.game?.ready);
}

function assertExplicitPersistedSchema(
  raw,
  { domain, supportedVersion, codePrefix },
) {
  if (
    !raw ||
    typeof raw !== "object" ||
    Array.isArray(raw) ||
    !Object.hasOwn(raw, "schema")
  ) {
    return;
  }
  assertSupportedPersistedVersion(
    raw.schema === undefined ? Number.NaN : raw.schema,
    { domain, supportedVersion, codePrefix },
  );
}

function assertSupportedInjuryRecordSchemas(raw, domain, codePrefix) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return;
  assertExplicitPersistedSchema(raw, {
    domain,
    supportedVersion: RECORD_SCHEMA,
    codePrefix: `${codePrefix}_SCHEMA`,
  });
  for (const treatment of Array.isArray(raw.treatments) ? raw.treatments : []) {
    assertExplicitPersistedSchema(treatment, {
      domain: `${domain}-treatment`,
      supportedVersion: TREATMENT_SCHEMA,
      codePrefix: `${codePrefix}_TREATMENT_SCHEMA`,
    });
    if (
      treatment?.resolution &&
      typeof treatment.resolution === "object" &&
      !Array.isArray(treatment.resolution)
    ) {
      assertExplicitPersistedSchema(treatment.resolution, {
        domain: `${domain}-treatment-resolution`,
        supportedVersion: TREATMENT_SCHEMA,
        codePrefix: `${codePrefix}_TREATMENT_RESOLUTION_SCHEMA`,
      });
    }
  }
}

function assertSupportedWorkflowReplicaVersion(key, raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return;
  }
  const isPrimary = key === STORE_KEY;
  const domain = isPrimary
    ? "critical-injury-workflow-primary"
    : "critical-injury-workflow-checkpoint";
  const codePrefix = isPrimary
    ? "CRITICAL_INJURY_WORKFLOW_PRIMARY"
    : "CRITICAL_INJURY_WORKFLOW_CHECKPOINT";
  if (Object.hasOwn(raw, "version")) {
    assertSupportedPersistedVersion(
      raw.version === undefined ? Number.NaN : raw.version,
      {
        domain,
        supportedVersion: STORE_VERSION,
        codePrefix,
      },
    );
  }
  for (const record of Array.isArray(raw.records) ? raw.records : []) {
    assertSupportedInjuryRecordSchemas(
      record,
      `${domain}-record`,
      `${codePrefix}_RECORD`,
    );
  }
  for (const restEvent of Array.isArray(raw.restEvents) ? raw.restEvents : []) {
    assertExplicitPersistedSchema(restEvent, {
      domain: `${domain}-rest-event`,
      supportedVersion: REST_EVENT_SCHEMA,
      codePrefix: `${codePrefix}_REST_EVENT_SCHEMA`,
    });
    if (
      restEvent?.resolution &&
      typeof restEvent.resolution === "object" &&
      !Array.isArray(restEvent.resolution)
    ) {
      assertExplicitPersistedSchema(restEvent.resolution, {
        domain: `${domain}-rest-event-resolution`,
        supportedVersion: REST_EVENT_SCHEMA,
        codePrefix: `${codePrefix}_REST_EVENT_RESOLUTION_SCHEMA`,
      });
    }
  }
}

function readRawSlot(key) {
  const privateValue = getPrivateState(key);
  if (privateValue !== undefined) {
    assertSupportedWorkflowReplicaVersion(key, privateValue);
    return privateValue;
  }
  if (isFoundryEnvironment()) {
    throw new Error("CriticalInjuryWorkflowStoreUnavailable");
  }
  let raw;
  try {
    raw = globalThis.game?.settings?.get?.(MODULE_ID, key) ?? {};
  } catch {
    return {};
  }
  assertSupportedWorkflowReplicaVersion(key, raw);
  return raw;
}

function readRawPrimary() {
  return readRawSlot(STORE_KEY);
}

function readRawCheckpoint() {
  return readRawSlot(CHECKPOINT_KEY);
}

function readRawReplicas() {
  return {
    primary: readRawPrimary(),
    checkpoint: readRawCheckpoint(),
  };
}

function replicaValueForKey(replicas, key) {
  return key === STORE_KEY ? replicas.primary : replicas.checkpoint;
}

function isEmptyObject(value) {
  return Boolean(
    value &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    Object.keys(value).length === 0,
  );
}

function isLegacyEnvelope(raw) {
  return Boolean(
    raw &&
    typeof raw === "object" &&
    !Array.isArray(raw) &&
    persistedVersionEquals(raw.version, 1) &&
    Array.isArray(raw.records),
  );
}

function isPersistedEnvelope(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return false;
  if (!persistedVersionEquals(raw.version, STORE_VERSION)) return false;
  if (nonNegativeInteger(raw.revision) == null) return false;
  if (!toId(raw.authorityId) || !toId(raw.authorityEpoch)) return false;
  if (!toId(raw.writeToken)) return false;
  if (!Array.isArray(raw.records)) return false;
  const normalized = normalizeCriticalInjuryWorkflowStore(raw);
  return persistedValuesEqual(raw, normalized);
}

function rawEnvelopesEqual(left, right) {
  return persistedValuesEqual(left, right);
}

function cloneEnvelope(raw) {
  return clone(raw);
}

function persistedRevision(raw) {
  return isPersistedEnvelope(raw) ? Number(raw.revision) : -1;
}

function createAuthorityEpoch(authorityId) {
  const id = toId(authorityId);
  if (!id) return null;
  // Browser tabs logged in as the same GM must share one persisted authority
  // epoch or their observers continuously rewrite each other's replicas. The
  // in-memory generation still fences queued work when authority leaves and
  // later returns within this browser session.
  return `${id}:active-authority`;
}

function createWriteToken() {
  const randomId = globalThis.foundry?.utils?.randomID?.(24);
  if (toId(randomId)) return toId(randomId);
  const uuid = globalThis.crypto?.randomUUID?.();
  if (toId(uuid)) return toId(uuid);
  return `${Date.now()}:${Math.random().toString(36).slice(2, 14)}`;
}

function currentUserOwnsAuthority(authorityId) {
  const currentUserId = toId(globalThis.game?.user?.id);
  return Boolean(
    currentUserId &&
    authorityId === currentUserId &&
    isFullGM(globalThis.game?.user),
  );
}

/** Track authority generations so queued work cannot survive a GM handoff. */
export function observeCriticalInjuryWorkflowAuthorityTransition() {
  const authorityId = toId(authoritativeGMId());
  if (!authorityObservationStarted) {
    authorityObservationStarted = true;
    observedAuthorityId = authorityId;
    observedAuthorityEpoch = currentUserOwnsAuthority(authorityId)
      ? createAuthorityEpoch(authorityId)
      : null;
    return {
      changed: false,
      authorityId,
      generation: authorityGeneration,
      authorityEpoch: observedAuthorityEpoch,
      newlyAuthoritative: false,
    };
  }

  const changed = authorityId !== observedAuthorityId;
  if (changed) {
    if (observedAuthorityEpoch) {
      retiredAuthorityEpochs.add(observedAuthorityEpoch);
    }
    observedAuthorityId = authorityId;
    authorityGeneration += 1;
    observedAuthorityEpoch = currentUserOwnsAuthority(authorityId)
      ? createAuthorityEpoch(authorityId)
      : null;
  }
  const currentUserId = toId(globalThis.game?.user?.id);
  return {
    changed,
    authorityId,
    generation: authorityGeneration,
    authorityEpoch: observedAuthorityEpoch,
    newlyAuthoritative: Boolean(
      changed &&
      currentUserId &&
      authorityId === currentUserId &&
      isFullGM(globalThis.game?.user),
    ),
  };
}

function captureAuthorityFence() {
  if (!isLiveFoundrySession()) {
    return {
      live: false,
      userId: toId(globalThis.game?.user?.id),
    };
  }
  const observation = observeCriticalInjuryWorkflowAuthorityTransition();
  return {
    live: true,
    userId: toId(globalThis.game?.user?.id),
    authorityId: observation.authorityId,
    authorityEpoch: observation.authorityEpoch,
    generation: observation.generation,
  };
}

function isAuthorityFenceCurrent(fence) {
  if (!fence?.live) return isAuthoritativeGM();
  const observation = observeCriticalInjuryWorkflowAuthorityTransition();
  return Boolean(
    fence.userId &&
    fence.authorityId === fence.userId &&
    observation.authorityId === fence.authorityId &&
    observation.authorityEpoch === fence.authorityEpoch &&
    observation.generation === fence.generation &&
    isAuthoritativeGM(),
  );
}

function assertAuthorityFence(fence) {
  if (isAuthorityFenceCurrent(fence)) return;
  if (!isAuthoritativeGM()) {
    throw new Error("CriticalInjuryWorkflowWriteRequiresAuthority");
  }
  throw new Error("CriticalInjuryWorkflowAuthorityChanged");
}

function acceptEnvelope(raw, fence = null) {
  if (!isPersistedEnvelope(raw)) return false;
  if (
    fence?.live &&
    (raw.authorityId !== fence.userId ||
      raw.authorityEpoch !== fence.authorityEpoch)
  ) {
    return false;
  }
  const revision = Number(raw.revision);
  if (revision < highestObservedRevision) return false;
  if (revision === highestObservedRevision) {
    return Boolean(
      isPersistedEnvelope(lastAcceptedEnvelope) &&
      rawEnvelopesEqual(raw, lastAcceptedEnvelope),
    );
  }
  highestObservedRevision = revision;
  lastAcceptedEnvelope = cloneEnvelope(raw);
  return true;
}

function chooseHighestEnvelope(candidates, fence = null) {
  const persisted = candidates.filter(isPersistedEnvelope);
  if (persisted.length === 0) return null;
  const highestRevision = Math.max(...persisted.map(persistedRevision));
  const highest = persisted.filter(
    (candidate) => persistedRevision(candidate) === highestRevision,
  );
  const first = highest[0];
  if (highest.every((candidate) => rawEnvelopesEqual(candidate, first))) {
    return first;
  }
  if (
    isPersistedEnvelope(lastAcceptedEnvelope) &&
    persistedRevision(lastAcceptedEnvelope) === highestRevision
  ) {
    const accepted = highest.find((candidate) =>
      rawEnvelopesEqual(candidate, lastAcceptedEnvelope),
    );
    if (accepted) return accepted;
  }
  if (fence?.live) {
    const currentUser = highest.filter(
      (candidate) => candidate.authorityId === fence.userId,
    );
    const hasForeignAuthority = highest.some(
      (candidate) => candidate.authorityId !== fence.userId,
    );
    if (
      hasForeignAuthority &&
      currentUser.length > 0 &&
      currentUser.every((candidate) =>
        rawEnvelopesEqual(candidate, currentUser[0]),
      )
    ) {
      return currentUser[0];
    }
  }
  throw new Error("CriticalInjuryWorkflowRevisionConflict");
}

function legacyRecoveryEnvelope(primary, checkpoint) {
  const candidates = [primary, checkpoint].filter(isLegacyEnvelope);
  if (candidates.length === 0) {
    const invalid = [primary, checkpoint].filter(
      (value) => !isEmptyObject(value),
    );
    if (invalid.length > 0) {
      throw new Error("CriticalInjuryWorkflowStoreMalformed");
    }
    return normalizeCriticalInjuryWorkflowStore({});
  }
  const first = normalizeCriticalInjuryWorkflowStore(candidates[0]);
  if (
    candidates.some(
      (candidate) =>
        !persistedValuesEqual(
          normalizeCriticalInjuryWorkflowStore(candidate).records,
          first.records,
        ),
    )
  ) {
    throw new Error("CriticalInjuryWorkflowLegacyConflict");
  }
  return first;
}

function selectRecoveryBase(primary, checkpoint, fence = null) {
  const chosen = chooseHighestEnvelope(
    [primary, checkpoint, lastAcceptedEnvelope],
    fence,
  );
  if (chosen) return chosen;
  return legacyRecoveryEnvelope(primary, checkpoint);
}

function serializeEnvelope(store, { revision, authorityId, authorityEpoch }) {
  const normalized = normalizeCriticalInjuryWorkflowStore(store);
  if (!Number.isSafeInteger(revision) || revision < 0) {
    throw new Error("CriticalInjuryWorkflowRevisionInvalid");
  }
  const identity = {
    authorityId: toId(authorityId),
    authorityEpoch: toId(authorityEpoch),
    writeToken: createWriteToken(),
  };
  if (
    !identity.authorityId ||
    !identity.authorityEpoch ||
    !identity.writeToken
  ) {
    throw new Error("CriticalInjuryWorkflowIdentityInvalid");
  }
  const envelope = {
    version: STORE_VERSION,
    revision,
    ...identity,
    records: normalized.records,
  };
  if (normalized.restEvents?.length > 0) {
    envelope.restEvents = normalized.restEvents;
  }
  return envelope;
}

function nextWriteIdentity(fence, ...snapshots) {
  const maximumRevision = Math.max(
    highestObservedRevision,
    ...snapshots.map(persistedRevision),
  );
  const authorityId = fence.live
    ? fence.userId
    : toId(authoritativeGMId()) ||
      toId(globalThis.game?.user?.id) ||
      "node-test";
  let authorityEpoch = fence.live
    ? fence.authorityEpoch
    : (snapshots.find(
        (snapshot) =>
          isPersistedEnvelope(snapshot) && snapshot.authorityId === authorityId,
      )?.authorityEpoch ?? `${authorityId}:node-test:0`);
  let revision = maximumRevision + 1;
  if (maximumRevision >= Number.MAX_SAFE_INTEGER) {
    if (fence.live) {
      if (observedAuthorityEpoch) {
        retiredAuthorityEpochs.add(observedAuthorityEpoch);
      }
      authorityGeneration += 1;
      observedAuthorityEpoch = createAuthorityEpoch(authorityId);
      fence.authorityEpoch = observedAuthorityEpoch;
      fence.generation = authorityGeneration;
      authorityEpoch = observedAuthorityEpoch;
    } else {
      authorityEpoch = `${authorityId}:overflow:${Date.now()}`;
    }
    highestObservedRevision = -1;
    revision = 0;
  }
  return { revision, authorityId, authorityEpoch };
}

function enqueueWrite(operation) {
  // Known boundary: this queue serializes one browser client. Two tabs logged
  // in as the same GM do not have a server-side compare-and-swap primitive;
  // replica read-back detects conflicts but cannot make simultaneous tab
  // claims atomic. Treatment invariants below still fail closed once either
  // write becomes canonical.
  const fence = captureAuthorityFence();
  const queued = writeQueue.then(
    () => operation(fence),
    () => operation(fence),
  );
  writeQueue = queued.then(
    () => undefined,
    () => undefined,
  );
  return queued;
}

async function commitEnvelope(
  store,
  { fence, expectedPrimary, expectedCheckpoint },
) {
  assertAuthorityFence(fence);
  const replicas = readRawReplicas();
  if (
    !rawEnvelopesEqual(replicas.primary, expectedPrimary) ||
    !rawEnvelopesEqual(replicas.checkpoint, expectedCheckpoint)
  ) {
    throw new Error("CriticalInjuryWorkflowStaleWrite");
  }
  const identity = nextWriteIdentity(
    fence,
    expectedPrimary,
    expectedCheckpoint,
    lastAcceptedEnvelope,
  );
  const next = serializeEnvelope(store, identity);

  readRawReplicas();
  await setPrivateState(CHECKPOINT_KEY, next, {
    beforeWrite: () => {
      const current = readRawReplicas();
      return (
        isAuthorityFenceCurrent(fence) &&
        rawEnvelopesEqual(current.checkpoint, expectedCheckpoint)
      );
    },
    afterWrite: () => {
      const current = readRawReplicas();
      return (
        isAuthorityFenceCurrent(fence) &&
        rawEnvelopesEqual(current.checkpoint, next)
      );
    },
  });
  assertAuthorityFence(fence);
  try {
    readRawReplicas();
    await setPrivateState(STORE_KEY, next, {
      beforeWrite: () => {
        const current = readRawReplicas();
        return (
          isAuthorityFenceCurrent(fence) &&
          rawEnvelopesEqual(current.primary, expectedPrimary)
        );
      },
      afterWrite: () => {
        const current = readRawReplicas();
        return (
          isAuthorityFenceCurrent(fence) &&
          rawEnvelopesEqual(current.primary, next)
        );
      },
    });
  } catch (error) {
    // The checkpoint is the durable commit point. If it was verified and the
    // same authority still owns the fence, the observer can repair a transient
    // primary-slot failure without rerolling or duplicating Actor mutations.
    const afterFailure = readRawReplicas();
    const primaryAfterFailure = afterFailure.primary;
    const checkpointAfterFailure = afterFailure.checkpoint;
    let canonical = null;
    if (isAuthorityFenceCurrent(fence)) {
      canonical = selectRecoveryBase(
        primaryAfterFailure,
        checkpointAfterFailure,
        fence,
      );
    }
    if (rawEnvelopesEqual(canonical, next) && acceptEnvelope(next, fence)) {
      console.warn(
        `${MODULE_ID} | critical injury primary workflow replica will be reconciled`,
        error,
      );
      return cloneEnvelope(next);
    }
    throw error;
  }
  assertAuthorityFence(fence);

  const stored = readRawReplicas();
  const storedPrimary = stored.primary;
  const storedCheckpoint = stored.checkpoint;
  if (
    !rawEnvelopesEqual(storedPrimary, next) ||
    !rawEnvelopesEqual(storedCheckpoint, next) ||
    !acceptEnvelope(next, fence)
  ) {
    throw new Error("CriticalInjuryWorkflowWriteVerificationFailed");
  }
  return cloneEnvelope(next);
}

async function ensureEnvelopeForFence(fence) {
  assertAuthorityFence(fence);
  const replicas = readRawReplicas();
  const primary = replicas.primary;
  const checkpoint = replicas.checkpoint;
  if (
    isPersistedEnvelope(primary) &&
    rawEnvelopesEqual(primary, checkpoint) &&
    (!fence.live ||
      (primary.authorityId === fence.userId &&
        primary.authorityEpoch === fence.authorityEpoch)) &&
    acceptEnvelope(primary, fence)
  ) {
    return cloneEnvelope(primary);
  }

  const base = selectRecoveryBase(primary, checkpoint, fence);
  const baseBelongsToFence = Boolean(
    isPersistedEnvelope(base) &&
    (!fence.live ||
      (base.authorityId === fence.userId &&
        base.authorityEpoch === fence.authorityEpoch)),
  );
  if (baseBelongsToFence) {
    if (!rawEnvelopesEqual(checkpoint, base)) {
      await repairEnvelopeReplica(CHECKPOINT_KEY, base, checkpoint, fence);
    }
    if (!rawEnvelopesEqual(primary, base)) {
      await repairEnvelopeReplica(STORE_KEY, base, primary, fence);
    }
    const repaired = readRawReplicas();
    const repairedPrimary = repaired.primary;
    const repairedCheckpoint = repaired.checkpoint;
    if (
      !rawEnvelopesEqual(repairedPrimary, base) ||
      !rawEnvelopesEqual(repairedCheckpoint, base) ||
      !acceptEnvelope(base, fence)
    ) {
      throw new Error("CriticalInjuryWorkflowRepairVerificationFailed");
    }
    return cloneEnvelope(base);
  }
  return commitEnvelope(base, {
    fence,
    expectedPrimary: primary,
    expectedCheckpoint: checkpoint,
  });
}

async function repairEnvelopeReplica(key, envelope, expectedRaw, fence) {
  try {
    readRawReplicas();
    await setPrivateState(key, envelope, {
      beforeWrite: () => {
        const current = readRawReplicas();
        return (
          isAuthorityFenceCurrent(fence) &&
          rawEnvelopesEqual(replicaValueForKey(current, key), expectedRaw)
        );
      },
      afterWrite: () => {
        const current = readRawReplicas();
        return (
          isAuthorityFenceCurrent(fence) &&
          rawEnvelopesEqual(replicaValueForKey(current, key), envelope)
        );
      },
    });
  } catch (error) {
    const current = readRawReplicas();
    if (
      isAuthorityFenceCurrent(fence) &&
      rawEnvelopesEqual(replicaValueForKey(current, key), envelope)
    ) {
      return true;
    }
    throw error;
  }
  return true;
}

/** Claim or reconcile both restricted workflow slots for the current GM. */
export function ensureCriticalInjuryWorkflowAuthority() {
  return enqueueWrite((fence) => ensureEnvelopeForFence(fence));
}

export function loadCriticalInjuryWorkflowStore() {
  const replicas = readRawReplicas();
  const primary = replicas.primary;
  const checkpoint = replicas.checkpoint;
  const selected = selectRecoveryBase(primary, checkpoint);
  return normalizeCriticalInjuryWorkflowStore(selected);
}

export function getCriticalInjuryWorkflowRecord(pendingId) {
  const id = toId(pendingId);
  if (!id) return null;
  const record = loadCriticalInjuryWorkflowStore().records.find(
    (entry) => entry.pendingId === id,
  );
  return record ? clone(record) : null;
}

function recordInjuryId(record) {
  return toId(record?.resolution?.injuryId) || toId(record?.result?.id);
}

function recordMatchesInjury(record, actorId, injuryId) {
  return Boolean(
    record?.state === "completed" &&
    record.actorId === actorId &&
    recordInjuryId(record) === injuryId,
  );
}

/** Find the completed private injury receipt that authorizes treatment. */
export function getCriticalInjuryWorkflowForInjury(actorId, injuryId) {
  const actor = toId(actorId);
  const injury = toId(injuryId);
  if (!actor || !injury) return null;
  const matches = loadCriticalInjuryWorkflowStore().records.filter((record) =>
    recordMatchesInjury(record, actor, injury),
  );
  return matches.length === 1 ? clone(matches[0]) : null;
}

export function getCriticalInjuryTreatmentRecord(pendingId, treatmentId) {
  const pending = toId(pendingId);
  const treatment = toId(treatmentId);
  if (!pending || !treatment) return null;
  const parent = getCriticalInjuryWorkflowRecord(pending);
  const record = parent?.treatments?.find(
    (entry) => entry.treatmentId === treatment,
  );
  return record ? clone(record) : null;
}

function restEventFromStore(store, restId) {
  const id = toId(restId);
  if (!id) return null;
  return store?.restEvents?.find((event) => event.restId === id) ?? null;
}

function compareRestEvents(left, right) {
  const timestamp =
    Number(left?.requestedAt ?? 0) - Number(right?.requestedAt ?? 0);
  return (
    timestamp ||
    String(left?.restId ?? "").localeCompare(String(right?.restId ?? ""))
  );
}

function restMutationResult(restId, extra = {}) {
  return (_record, persistedStore) => ({
    record: clone(restEventFromStore(persistedStore, restId)),
    ...extra,
  });
}

/** Read one durable Infection long-rest receipt. */
export function getCriticalInjuryRestRecord(restId) {
  const record = restEventFromStore(loadCriticalInjuryWorkflowStore(), restId);
  return record ? clone(record) : null;
}

/** List unfinished rest receipts in stable actor/request order for resumption. */
export function listUnresolvedCriticalInjuryRestRecords() {
  return clone(
    (loadCriticalInjuryWorkflowStore().restEvents ?? [])
      .filter((record) => record.state !== "completed")
      .sort(
        (left, right) =>
          left.actorId.localeCompare(right.actorId) ||
          compareRestEvents(left, right),
      ),
  );
}

/** Persist or recover a client-stable long-rest event before any save is rolled. */
export async function createCriticalInjuryRestRequest({
  restId,
  actorId,
  requestedBy,
  requestedAt = getCriticalInjuryWorkflowLeaseTimestamp(),
} = {}) {
  const rest = toId(restId);
  const actor = toId(actorId);
  const requester = toId(requestedBy);
  const draft = normalizeRestRecord({
    restId: rest,
    actorId: actor,
    requestedBy: requester,
    requestedAt,
    state: "requested",
  });
  if (!rest || !actor || !requester || !draft) {
    throw new Error("CriticalInjuryRestRequestInvalid");
  }

  return mutateStore((store) => {
    const existing = restEventFromStore(store, rest);
    if (existing) {
      if (existing.actorId !== actor || existing.requestedBy !== requester) {
        throw new Error("CriticalInjuryRestRequestCollision");
      }
      return {
        store,
        pendingId: "",
        mapResult: restMutationResult(rest, { createdNow: false }),
      };
    }
    store.restEvents ??= [];
    store.restEvents.push(draft);
    return {
      store,
      pendingId: "",
      mapResult: restMutationResult(rest, { createdNow: true }),
    };
  });
}

function liveTreatmentLeaseExists(store, now, authorityId) {
  return store.records
    .flatMap((parent) => parent.treatments ?? [])
    .some((treatment) => {
      if (treatment.state === "completed") return false;
      const lease = normalizeApplicationLease(treatment.applicationLease);
      return Boolean(
        lease && lease.claimedBy === authorityId && lease.expiresAt > now,
      );
    });
}

function liveRestLeaseExists(store, now, authorityId, excludedRestId = "") {
  return (store.restEvents ?? []).some((event) => {
    if (event.state === "completed" || event.restId === excludedRestId) {
      return false;
    }
    const lease = normalizeApplicationLease(event.applicationLease);
    return Boolean(
      lease && lease.claimedBy === authorityId && lease.expiresAt > now,
    );
  });
}

function earlierUnresolvedActorRest(store, target) {
  return (
    (store.restEvents ?? [])
      .filter(
        (event) =>
          event.state !== "completed" &&
          event.actorId === target.actorId &&
          event.restId !== target.restId &&
          compareRestEvents(event, target) < 0,
      )
      .sort(compareRestEvents)[0] ?? null
  );
}

/**
 * Claim the single live rest/treatment mutation lease. Rests for one Actor are
 * additionally serialized by their first authoritative receipt timestamp.
 */
export async function claimCriticalInjuryRestApplication(
  restId,
  { id: leaseId, claimedBy = "", leaseDurationMs } = {},
) {
  const rest = toId(restId);
  const claimedId = toId(leaseId);
  const requestedClaimant = toId(claimedBy);
  const authority = toId(authoritativeGMId());
  const duration = normalizeApplicationLeaseDuration(leaseDurationMs);
  if (
    !rest ||
    !claimedId ||
    !authority ||
    (requestedClaimant && requestedClaimant !== authority)
  ) {
    throw new Error("CriticalInjuryRestLeaseInvalid");
  }

  return mutateStore((store) => {
    const record = restEventFromStore(store, rest);
    if (!record) throw new Error("CriticalInjuryRestNotFound");
    if (record.state === "completed") {
      return {
        store,
        pendingId: "",
        mapResult: restMutationResult(rest, { claimedNow: false }),
      };
    }
    const earlier = earlierUnresolvedActorRest(store, record);
    if (earlier) {
      return {
        store,
        pendingId: "",
        mapResult: restMutationResult(rest, {
          claimedNow: false,
          blockedByRestId: earlier.restId,
        }),
      };
    }

    const now = getCriticalInjuryWorkflowLeaseTimestamp();
    if (
      liveTreatmentLeaseExists(store, now, authority) ||
      liveRestLeaseExists(store, now, authority, rest)
    ) {
      return {
        store,
        pendingId: "",
        mapResult: restMutationResult(rest, { claimedNow: false }),
      };
    }

    const existing = normalizeApplicationLease(record.applicationLease);
    if (existing?.expiresAt > now) {
      if (existing.id === claimedId && existing.claimedBy === authority) {
        return {
          store,
          pendingId: "",
          mapResult: restMutationResult(rest, { claimedNow: true }),
        };
      }
      if (existing.claimedBy === authority) {
        return {
          store,
          pendingId: "",
          mapResult: restMutationResult(rest, { claimedNow: false }),
        };
      }
    }

    record.applicationLease = {
      id: claimedId,
      claimedBy: authority,
      claimedAt: now,
      expiresAt: now + duration,
    };
    return {
      store,
      pendingId: "",
      mapResult: restMutationResult(rest, { claimedNow: true }),
    };
  });
}

export async function renewCriticalInjuryRestApplication(
  restId,
  leaseId,
  { leaseDurationMs } = {},
) {
  const rest = toId(restId);
  const claimedId = toId(leaseId);
  const authority = toId(authoritativeGMId());
  const duration = normalizeApplicationLeaseDuration(leaseDurationMs);
  if (!rest || !claimedId || !authority) {
    throw new Error("CriticalInjuryRestLeaseInvalid");
  }

  return mutateStore((store) => {
    const record = restEventFromStore(store, rest);
    if (!record) throw new Error("CriticalInjuryRestNotFound");
    if (record.state === "completed") {
      return {
        store,
        pendingId: "",
        mapResult: restMutationResult(rest, { renewedNow: false }),
      };
    }
    const now = getCriticalInjuryWorkflowLeaseTimestamp();
    const existing = normalizeApplicationLease(record.applicationLease);
    if (
      !existing ||
      existing.id !== claimedId ||
      existing.claimedBy !== authority ||
      existing.expiresAt <= now
    ) {
      throw new Error("CriticalInjuryRestLeaseLost");
    }
    let renewedNow = false;
    if (existing.expiresAt - now <= duration / 2) {
      record.applicationLease = {
        ...existing,
        expiresAt: now + duration,
      };
      renewedNow = true;
    }
    return {
      store,
      pendingId: "",
      mapResult: restMutationResult(rest, { renewedNow }),
    };
  });
}

export async function releaseCriticalInjuryRestApplication(restId, leaseId) {
  const rest = toId(restId);
  const claimedId = toId(leaseId);
  if (!rest || !claimedId) return null;
  return mutateStore((store) => {
    const record = restEventFromStore(store, rest);
    let releasedNow = false;
    if (record?.applicationLease?.id === claimedId) {
      record.applicationLease = null;
      releasedNow = true;
    }
    return {
      store,
      pendingId: "",
      mapResult: restMutationResult(rest, { releasedNow }),
    };
  });
}

function restResolutionMatchesPrivateParents(store, record, resolution) {
  return resolution.outcomes.every((outcome) => {
    const parents = store.records.filter((parent) => {
      const expectedEffectId =
        parent.effectId || parent.resolution?.effectDocumentId || "";
      return Boolean(
        parent.pendingId === outcome.pendingId &&
        recordMatchesInjury(parent, record.actorId, outcome.injuryId) &&
        expectedEffectId === outcome.effectId,
      );
    });
    return parents.length === 1;
  });
}

export async function persistCriticalInjuryRestResolution(
  restId,
  resolution,
  { applicationLeaseId = "" } = {},
) {
  const rest = toId(restId);
  const normalized = normalizeRestResolution(resolution);
  const claimedId = toId(applicationLeaseId);
  const authority = toId(authoritativeGMId());
  if (
    !rest ||
    !normalized ||
    !authority ||
    normalized.resolvedBy !== authority
  ) {
    throw new Error("CriticalInjuryRestResolutionInvalid");
  }

  return mutateStore((store) => {
    const record = restEventFromStore(store, rest);
    if (!record) throw new Error("CriticalInjuryRestNotFound");
    if (record.state === "completed") {
      return {
        store,
        pendingId: "",
        mapResult: restMutationResult(rest, { persistedNow: false }),
      };
    }
    if (!restResolutionMatchesPrivateParents(store, record, normalized)) {
      throw new Error("CriticalInjuryRestResolutionParentMismatch");
    }
    const tokenCollision = (store.restEvents ?? []).some(
      (event) =>
        event.restId !== rest &&
        (event.resolution?.outcomes ?? []).some((candidate) =>
          normalized.outcomes.some(
            (outcome) => outcome.receiptToken === candidate.receiptToken,
          ),
        ),
    );
    if (tokenCollision) {
      throw new Error("CriticalInjuryRestReceiptCollision");
    }
    if (record.state === "resolving") {
      if (!persistedValuesEqual(record.resolution, normalized)) {
        throw new Error("CriticalInjuryRestResolutionCollision");
      }
      return {
        store,
        pendingId: "",
        mapResult: restMutationResult(rest, { persistedNow: false }),
      };
    }

    const now = getCriticalInjuryWorkflowLeaseTimestamp();
    const lease = normalizeApplicationLease(record.applicationLease);
    if (
      !claimedId ||
      !lease ||
      lease.id !== claimedId ||
      lease.claimedBy !== authority ||
      lease.expiresAt <= now
    ) {
      throw new Error("CriticalInjuryRestLeaseLost");
    }
    record.state = "resolving";
    record.resolution = normalized;
    return {
      store,
      pendingId: "",
      mapResult: restMutationResult(rest, { persistedNow: true }),
    };
  });
}

export async function completeCriticalInjuryRestWorkflow(
  restId,
  { result, completedAt = null, applicationLeaseId = "" } = {},
) {
  const rest = toId(restId);
  const claimedId = toId(applicationLeaseId);
  const authority = toId(authoritativeGMId());
  if (!rest || !authority) {
    throw new Error("CriticalInjuryRestCompletionInvalid");
  }

  return mutateStore((store) => {
    const record = restEventFromStore(store, rest);
    if (!record) throw new Error("CriticalInjuryRestNotFound");
    const normalizedResult = normalizeRestResult(
      result,
      record.restId,
      record.actorId,
    );
    if (!normalizedResult) {
      throw new Error("CriticalInjuryRestCompletionInvalid");
    }
    if (record.state === "completed") {
      return {
        store,
        pendingId: "",
        mapResult: restMutationResult(rest, { completedNow: false }),
      };
    }
    if (!record.resolution) {
      throw new Error("CriticalInjuryRestResolutionNotFound");
    }
    const now = getCriticalInjuryWorkflowLeaseTimestamp();
    const lease = normalizeApplicationLease(record.applicationLease);
    if (
      !claimedId ||
      !lease ||
      lease.id !== claimedId ||
      lease.claimedBy !== authority ||
      lease.expiresAt <= now
    ) {
      throw new Error("CriticalInjuryRestLeaseLost");
    }
    record.state = "completed";
    record.result = normalizedResult;
    record.applicationLease = null;
    record.completedBy = authority;
    record.completedAt = finiteTimestamp(completedAt ?? now, now);
    return {
      store,
      pendingId: "",
      mapResult: restMutationResult(rest, { completedNow: true }),
    };
  });
}

/** Pure request gate shared by the authoritative service and focused tests. */
export function authorizeCriticalInjuryWorkflowRequest(
  record,
  { actorId, requestUserId, authoritativeUserId } = {},
) {
  if (!record) return { ok: false, reason: "approval-not-found" };
  if (record.actorId !== toId(actorId)) {
    return { ok: false, reason: "approval-actor-mismatch" };
  }
  const requester = toId(requestUserId);
  const authority = toId(authoritativeUserId);
  if (!requester) return { ok: false, reason: "requester-not-found" };
  if (requester !== record.targetUserId && requester !== authority) {
    return { ok: false, reason: "requester-not-approved" };
  }
  return { ok: true, reason: null };
}

async function mutateStore(mutator) {
  return enqueueWrite(async (fence) => {
    const ensured = await ensureEnvelopeForFence(fence);
    const replicas = readRawReplicas();
    const expectedPrimary = replicas.primary;
    const expectedCheckpoint = replicas.checkpoint;
    if (
      !rawEnvelopesEqual(expectedPrimary, ensured) ||
      !rawEnvelopesEqual(expectedCheckpoint, ensured)
    ) {
      throw new Error("CriticalInjuryWorkflowStaleWrite");
    }
    const current = normalizeCriticalInjuryWorkflowStore(ensured);
    const mutation = mutator(clone(current));
    const next = normalizeCriticalInjuryWorkflowStore(mutation.store);
    const currentPayload = {
      records: current.records,
      restEvents: current.restEvents ?? [],
    };
    const nextPayload = {
      records: next.records,
      restEvents: next.restEvents ?? [],
    };
    const persisted = persistedValuesEqual(currentPayload, nextPayload)
      ? ensured
      : await commitEnvelope(next, {
          fence,
          expectedPrimary,
          expectedCheckpoint,
        });
    const record = mutation.pendingId
      ? (persisted.records.find(
          (entry) => entry.pendingId === mutation.pendingId,
        ) ?? null)
      : null;
    const clonedRecord = record ? clone(record) : null;
    return typeof mutation.mapResult === "function"
      ? mutation.mapResult(clonedRecord, clone(persisted))
      : clonedRecord;
  });
}

function requestWorkflowReconciliation() {
  if (!isAuthoritativeGM()) return;
  if (reconciliationInFlight) {
    reconciliationRequested = true;
    return;
  }
  let tracked;
  tracked = ensureCriticalInjuryWorkflowAuthority()
    .catch((error) => {
      if (
        !String(error?.message ?? "").includes("StoreUnavailable") &&
        !String(error?.message ?? "").includes("PrivateStateUnavailable")
      ) {
        console.error(
          `${MODULE_ID} | critical injury workflow reconciliation failed`,
          error,
        );
      }
    })
    .finally(() => {
      if (reconciliationInFlight === tracked) {
        reconciliationInFlight = null;
      }
      if (reconciliationRequested) {
        reconciliationRequested = false;
        requestWorkflowReconciliation();
      }
    });
  reconciliationInFlight = tracked;
}

/** Observe private-state and GM changes so a surviving slot repairs its peer. */
export function registerCriticalInjuryWorkflowObserver() {
  if (observerRegistered || !isLiveFoundrySession()) return false;
  observerRegistered = true;
  observeCriticalInjuryWorkflowAuthorityTransition();
  const privateStateHookId = onPrivateStateChanged((payload) => {
    const keys = Array.isArray(payload?.keys) ? payload.keys : [];
    if (
      keys.includes(STORE_KEY) ||
      keys.includes(CHECKPOINT_KEY) ||
      String(payload?.reason ?? "") === "authority-change"
    ) {
      requestWorkflowReconciliation();
    }
  });
  if (privateStateHookId != null) {
    observerHookIds.push([PRIVATE_STATE_CHANGED_HOOK, privateStateHookId]);
  }
  const onAuthorityChange = () => {
    const transition = observeCriticalInjuryWorkflowAuthorityTransition();
    if (transition.newlyAuthoritative) requestWorkflowReconciliation();
  };
  for (const event of ["updateUser", "userConnected"]) {
    const hookId = globalThis.Hooks?.on?.(event, onAuthorityChange);
    if (hookId != null) observerHookIds.push([event, hookId]);
  }
  requestWorkflowReconciliation();
  return true;
}

export async function createCriticalInjuryApproval({
  pendingId,
  actorId,
  targetUserId,
  approvedAt = Date.now(),
} = {}) {
  const authority = toId(authoritativeGMId());
  const draft = normalizeRecord({
    pendingId,
    actorId,
    targetUserId,
    approvedBy: authority,
    approvedAt,
    state: "approved",
  });
  if (!authority || !draft) {
    throw new Error("CriticalInjuryApprovalInvalid");
  }
  return mutateStore((store) => {
    const existing = store.records.find(
      (record) => record.pendingId === draft.pendingId,
    );
    if (existing) {
      if (
        existing.actorId !== draft.actorId ||
        existing.targetUserId !== draft.targetUserId
      ) {
        throw new Error("CriticalInjuryApprovalCollision");
      }
      return { store, pendingId: existing.pendingId };
    }
    store.records.push(draft);
    return { store, pendingId: draft.pendingId };
  });
}

/**
 * Persist a GM-only review item. Unlike an approval, this does not authorize a
 * player roll and therefore must not be projected to owner-writable Actor
 * flags until `approveCriticalInjuryReview` succeeds.
 */
export async function createCriticalInjuryReview({
  pendingId,
  actorId,
  targetUserId,
  approvedAt = Date.now(),
} = {}) {
  const authority = toId(authoritativeGMId());
  const draft = normalizeRecord({
    pendingId,
    actorId,
    targetUserId,
    approvedBy: authority,
    approvedAt,
    state: "review",
  });
  if (!authority || !draft) throw new Error("CriticalInjuryReviewInvalid");
  return mutateStore((store) => {
    const existing = store.records.find(
      (record) => record.pendingId === draft.pendingId,
    );
    if (existing) {
      if (
        existing.actorId !== draft.actorId ||
        existing.targetUserId !== draft.targetUserId
      ) {
        throw new Error("CriticalInjuryReviewCollision");
      }
      return { store, pendingId: existing.pendingId };
    }
    store.records.push(draft);
    return { store, pendingId: draft.pendingId };
  });
}

/** Promote a reviewed item into the existing durable approval workflow. */
export async function approveCriticalInjuryReview(pendingId) {
  const id = toId(pendingId);
  const authority = toId(authoritativeGMId());
  if (!id || !authority) throw new Error("CriticalInjuryReviewApprovalInvalid");
  return mutateStore((store) => {
    const record = store.records.find((entry) => entry.pendingId === id);
    if (!record) throw new Error("CriticalInjuryReviewNotFound");
    if (record.state === "review") {
      record.state = "approved";
      record.approvedBy = authority;
      record.approvedAt = getCriticalInjuryWorkflowLeaseTimestamp();
    }
    return { store, pendingId: id };
  });
}

/** Discard only a not-yet-sent GM review item. */
export async function discardCriticalInjuryReview(pendingId) {
  const id = toId(pendingId);
  if (!id) return null;
  return mutateStore((store) => {
    store.records = store.records.filter(
      (record) => record.pendingId !== id || record.state !== "review",
    );
    return { store, pendingId: "" };
  });
}

export async function discardCriticalInjuryApproval(pendingId) {
  const id = toId(pendingId);
  if (!id) return null;
  return mutateStore((store) => {
    store.records = store.records.filter(
      (record) => record.pendingId !== id || record.state !== "approved",
    );
    return { store, pendingId: "" };
  });
}

export async function retargetCriticalInjuryWorkflow(pendingId, targetUserId) {
  const id = toId(pendingId);
  const target = toId(targetUserId);
  if (!id || !target || !isAuthoritativeGM()) {
    throw new Error("CriticalInjuryRetargetInvalid");
  }
  return mutateStore((store) => {
    const record = store.records.find((entry) => entry.pendingId === id);
    if (!record) throw new Error("CriticalInjuryApprovalNotFound");
    if (record.state !== "completed") record.targetUserId = target;
    return { store, pendingId: id };
  });
}

export async function persistCriticalInjuryResolution(
  pendingId,
  resolution,
  { applicationLeaseId = "" } = {},
) {
  const id = toId(pendingId);
  const normalized = normalizeResolution(resolution);
  const claimedId = toId(applicationLeaseId);
  const authority = toId(authoritativeGMId());
  if (!id || !normalized || normalized.resolvedBy !== authority) {
    throw new Error("CriticalInjuryResolutionInvalid");
  }
  return mutateStore((store) => {
    const record = store.records.find((entry) => entry.pendingId === id);
    if (!record) throw new Error("CriticalInjuryApprovalNotFound");
    if (record.state !== "approved") return { store, pendingId: id };
    const now = getCriticalInjuryWorkflowLeaseTimestamp();
    const lease = normalizeApplicationLease(record.applicationLease);
    if (
      !claimedId ||
      !lease ||
      lease.id !== claimedId ||
      lease.claimedBy !== authority ||
      lease.expiresAt <= now
    ) {
      throw new Error("CriticalInjuryApplicationLeaseLost");
    }
    record.state = "resolving";
    record.resolution = normalized;
    return { store, pendingId: id };
  });
}

export async function claimCriticalInjuryApplication(
  pendingId,
  { id: leaseId, claimedBy = "", leaseDurationMs } = {},
) {
  const id = toId(pendingId);
  const claimedId = toId(leaseId);
  const requestedClaimant = toId(claimedBy);
  const authority = toId(authoritativeGMId());
  const duration = normalizeApplicationLeaseDuration(leaseDurationMs);
  if (
    !id ||
    !claimedId ||
    !authority ||
    (requestedClaimant && requestedClaimant !== authority)
  ) {
    throw new Error("CriticalInjuryApplicationLeaseInvalid");
  }
  return mutateStore((store) => {
    const record = store.records.find((entry) => entry.pendingId === id);
    if (!record) throw new Error("CriticalInjuryApprovalNotFound");
    if (record.state === "completed") return { store, pendingId: id };
    const now = getCriticalInjuryWorkflowLeaseTimestamp();
    const lease = {
      id: claimedId,
      claimedBy: authority,
      claimedAt: now,
      expiresAt: now + duration,
    };
    const existing = normalizeApplicationLease(record.applicationLease);
    if (
      existing &&
      existing.id !== lease.id &&
      existing.claimedBy === authority &&
      existing.expiresAt > now
    ) {
      return { store, pendingId: id };
    }
    record.applicationLease = lease;
    return { store, pendingId: id };
  });
}

export async function renewCriticalInjuryApplication(
  pendingId,
  leaseId,
  { leaseDurationMs } = {},
) {
  const id = toId(pendingId);
  const claimedId = toId(leaseId);
  const authority = toId(authoritativeGMId());
  const duration = normalizeApplicationLeaseDuration(leaseDurationMs);
  if (!id || !claimedId || !authority) {
    throw new Error("CriticalInjuryApplicationLeaseInvalid");
  }
  return mutateStore((store) => {
    const record = store.records.find((entry) => entry.pendingId === id);
    if (!record) throw new Error("CriticalInjuryApprovalNotFound");
    if (record.state === "completed") return { store, pendingId: id };
    const now = getCriticalInjuryWorkflowLeaseTimestamp();
    const existing = normalizeApplicationLease(record.applicationLease);
    if (
      !existing ||
      existing.id !== claimedId ||
      existing.claimedBy !== authority ||
      existing.expiresAt <= now
    ) {
      throw new Error("CriticalInjuryApplicationLeaseLost");
    }
    if (existing.expiresAt - now <= duration / 2) {
      record.applicationLease = {
        ...existing,
        expiresAt: now + duration,
      };
    }
    return { store, pendingId: id };
  });
}

export async function releaseCriticalInjuryApplication(pendingId, leaseId) {
  const id = toId(pendingId);
  const claimedId = toId(leaseId);
  if (!id || !claimedId) return null;
  return mutateStore((store) => {
    const record = store.records.find((entry) => entry.pendingId === id);
    if (!record) return { store, pendingId: "" };
    if (record.applicationLease?.id === claimedId) {
      record.applicationLease = null;
    }
    return { store, pendingId: id };
  });
}

export async function completeCriticalInjuryWorkflow(
  pendingId,
  {
    result,
    effectId = "",
    calendarEntryId = "",
    completedAt = null,
    applicationLeaseId = "",
  } = {},
) {
  const id = toId(pendingId);
  const normalizedResult = normalizeResult(result);
  const claimedId = toId(applicationLeaseId);
  const authority = toId(authoritativeGMId());
  if (!id || !normalizedResult || !authority) {
    throw new Error("CriticalInjuryCompletionInvalid");
  }
  return mutateStore((store) => {
    const record = store.records.find((entry) => entry.pendingId === id);
    if (!record) throw new Error("CriticalInjuryApprovalNotFound");
    if (record.state === "completed") {
      return {
        store,
        pendingId: id,
        mapResult: (completedRecord) => ({
          record: completedRecord,
          completedNow: false,
        }),
      };
    }
    if (!record.resolution) {
      throw new Error("CriticalInjuryResolutionNotFound");
    }
    const now = getCriticalInjuryWorkflowLeaseTimestamp();
    const lease = normalizeApplicationLease(record.applicationLease);
    if (
      !claimedId ||
      !lease ||
      lease.id !== claimedId ||
      lease.claimedBy !== authority ||
      lease.expiresAt <= now
    ) {
      throw new Error("CriticalInjuryApplicationLeaseLost");
    }
    if (
      normalizedResult.id !== record.resolution.injuryId ||
      Number(normalizedResult.injuryRoll) !== record.resolution.injuryRoll
    ) {
      throw new Error("CriticalInjuryCompletionMismatch");
    }
    record.state = "completed";
    record.result = normalizedResult;
    record.effectId = toId(effectId);
    record.calendarEntryId = toId(calendarEntryId);
    record.applicationLease = null;
    record.completedBy = authority;
    record.completedAt = finiteTimestamp(completedAt ?? now, now);
    return {
      store,
      pendingId: id,
      mapResult: (completedRecord) => ({
        record: completedRecord,
        completedNow: true,
      }),
    };
  });
}

function treatmentFromParent(parent, treatmentId) {
  const id = toId(treatmentId);
  if (!parent || !id) return null;
  return (
    parent.treatments?.find((treatment) => treatment.treatmentId === id) ?? null
  );
}

function treatmentMutationResult(treatmentId, extra = {}) {
  return (parent) => ({
    record: clone(treatmentFromParent(parent, treatmentId)),
    parent: clone(parent),
    ...extra,
  });
}

function matchingTreatmentParents(store, actorId, injuryId) {
  return store.records.filter((record) =>
    recordMatchesInjury(record, actorId, injuryId),
  );
}

/** Create or recover a client-stable treatment attempt under its injury. */
export async function createCriticalInjuryTreatmentRequest({
  actorId,
  injuryId,
  treatmentId,
  requestedBy,
  requestedAt = getCriticalInjuryWorkflowLeaseTimestamp(),
  allowRequesterHandoff = false,
} = {}) {
  const actor = toId(actorId);
  const injury = toId(injuryId);
  const treatment = toId(treatmentId);
  const requester = toId(requestedBy);
  const draft = normalizeTreatmentRecord(
    {
      treatmentId: treatment,
      injuryId: injury,
      requestedBy: requester,
      requestedAt,
      state: "requested",
    },
    injury,
  );
  if (!actor || !injury || !treatment || !requester || !draft) {
    throw new Error("CriticalInjuryTreatmentRequestInvalid");
  }

  return mutateStore((store) => {
    const collisions = store.records
      .flatMap((record) =>
        (record.treatments ?? []).map((entry) => ({ record, entry })),
      )
      .filter(({ entry }) => entry.treatmentId === treatment);
    if (collisions.length > 0) {
      if (collisions.length !== 1) {
        throw new Error("CriticalInjuryTreatmentRequestCollision");
      }
      const [collision] = collisions;
      const requesterChanged = collision.entry.requestedBy !== requester;
      if (
        !recordMatchesInjury(collision.record, actor, injury) ||
        collision.entry.injuryId !== injury ||
        (requesterChanged && allowRequesterHandoff !== true)
      ) {
        throw new Error("CriticalInjuryTreatmentRequestCollision");
      }
      return {
        store,
        pendingId: collision.record.pendingId,
        mapResult: treatmentMutationResult(treatment, {
          createdNow: false,
          requesterHandedOff: requesterChanged,
        }),
      };
    }

    const parents = matchingTreatmentParents(store, actor, injury);
    if (parents.length === 0) {
      throw new Error("CriticalInjuryTreatmentParentNotFound");
    }
    if (parents.length !== 1) {
      throw new Error("CriticalInjuryTreatmentParentCollision");
    }
    const parent = parents[0];
    const unresolvedSibling = (parent.treatments ?? []).find(
      (entry) => entry.state !== "completed",
    );
    if (unresolvedSibling) {
      return {
        store,
        pendingId: parent.pendingId,
        mapResult: treatmentMutationResult(unresolvedSibling.treatmentId, {
          createdNow: false,
          resumeTreatmentId: unresolvedSibling.treatmentId,
        }),
      };
    }
    parent.treatments ??= [];
    parent.treatments.push(draft);
    return {
      store,
      pendingId: parent.pendingId,
      mapResult: treatmentMutationResult(treatment, { createdNow: true }),
    };
  });
}

/**
 * Claim the one live treatment lease available across the workflow store. A
 * different active GM can resume the same attempt immediately; another tab
 * for the same GM, or any other live treatment attempt, receives
 * claimedNow=false without mutating the store.
 */
export async function claimCriticalInjuryTreatmentApplication(
  pendingId,
  treatmentId,
  { id: leaseId, claimedBy = "", leaseDurationMs } = {},
) {
  const pending = toId(pendingId);
  const treatment = toId(treatmentId);
  const claimedId = toId(leaseId);
  const requestedClaimant = toId(claimedBy);
  const authority = toId(authoritativeGMId());
  const duration = normalizeApplicationLeaseDuration(leaseDurationMs);
  if (
    !pending ||
    !treatment ||
    !claimedId ||
    !authority ||
    (requestedClaimant && requestedClaimant !== authority)
  ) {
    throw new Error("CriticalInjuryTreatmentLeaseInvalid");
  }

  return mutateStore((store) => {
    const parent = store.records.find((record) => record.pendingId === pending);
    if (!parent || parent.state !== "completed") {
      throw new Error("CriticalInjuryTreatmentParentNotFound");
    }
    const record = treatmentFromParent(parent, treatment);
    if (!record) throw new Error("CriticalInjuryTreatmentNotFound");
    if (record.state === "completed") {
      return {
        store,
        pendingId: pending,
        mapResult: treatmentMutationResult(treatment, { claimedNow: false }),
      };
    }

    const now = getCriticalInjuryWorkflowLeaseTimestamp();
    const globalBlocker = store.records
      .flatMap((candidateParent) =>
        (candidateParent.treatments ?? []).map((entry) => ({
          parent: candidateParent,
          entry,
        })),
      )
      .find(({ parent: candidateParent, entry }) => {
        const isTarget =
          candidateParent.pendingId === pending &&
          entry.treatmentId === treatment;
        if (isTarget || entry.state === "completed") return false;
        const lease = normalizeApplicationLease(entry.applicationLease);
        return Boolean(lease && lease.expiresAt > now);
      });
    if (globalBlocker || liveRestLeaseExists(store, now, authority)) {
      return {
        store,
        pendingId: pending,
        mapResult: treatmentMutationResult(treatment, { claimedNow: false }),
      };
    }

    const existing = normalizeApplicationLease(record.applicationLease);
    if (existing?.expiresAt > now) {
      if (existing.id === claimedId && existing.claimedBy === authority) {
        return {
          store,
          pendingId: pending,
          mapResult: treatmentMutationResult(treatment, { claimedNow: true }),
        };
      }
      if (existing.claimedBy === authority) {
        return {
          store,
          pendingId: pending,
          mapResult: treatmentMutationResult(treatment, {
            claimedNow: false,
          }),
        };
      }
    }

    record.applicationLease = {
      id: claimedId,
      claimedBy: authority,
      claimedAt: now,
      expiresAt: now + duration,
    };
    return {
      store,
      pendingId: pending,
      mapResult: treatmentMutationResult(treatment, { claimedNow: true }),
    };
  });
}

export async function renewCriticalInjuryTreatmentApplication(
  pendingId,
  treatmentId,
  leaseId,
  { leaseDurationMs } = {},
) {
  const pending = toId(pendingId);
  const treatment = toId(treatmentId);
  const claimedId = toId(leaseId);
  const authority = toId(authoritativeGMId());
  const duration = normalizeApplicationLeaseDuration(leaseDurationMs);
  if (!pending || !treatment || !claimedId || !authority) {
    throw new Error("CriticalInjuryTreatmentLeaseInvalid");
  }

  return mutateStore((store) => {
    const parent = store.records.find((record) => record.pendingId === pending);
    if (!parent || parent.state !== "completed") {
      throw new Error("CriticalInjuryTreatmentParentNotFound");
    }
    const record = treatmentFromParent(parent, treatment);
    if (!record) throw new Error("CriticalInjuryTreatmentNotFound");
    if (record.state === "completed") {
      return {
        store,
        pendingId: pending,
        mapResult: treatmentMutationResult(treatment, { renewedNow: false }),
      };
    }
    const now = getCriticalInjuryWorkflowLeaseTimestamp();
    const existing = normalizeApplicationLease(record.applicationLease);
    if (
      !existing ||
      existing.id !== claimedId ||
      existing.claimedBy !== authority ||
      existing.expiresAt <= now
    ) {
      throw new Error("CriticalInjuryTreatmentLeaseLost");
    }
    let renewedNow = false;
    if (existing.expiresAt - now <= duration / 2) {
      record.applicationLease = {
        ...existing,
        expiresAt: now + duration,
      };
      renewedNow = true;
    }
    return {
      store,
      pendingId: pending,
      mapResult: treatmentMutationResult(treatment, { renewedNow }),
    };
  });
}

export async function releaseCriticalInjuryTreatmentApplication(
  pendingId,
  treatmentId,
  leaseId,
) {
  const pending = toId(pendingId);
  const treatment = toId(treatmentId);
  const claimedId = toId(leaseId);
  if (!pending || !treatment || !claimedId) return null;
  return mutateStore((store) => {
    const parent = store.records.find((record) => record.pendingId === pending);
    if (!parent) return { store, pendingId: "" };
    const record = treatmentFromParent(parent, treatment);
    let releasedNow = false;
    if (record?.applicationLease?.id === claimedId) {
      record.applicationLease = null;
      releasedNow = true;
    }
    return {
      store,
      pendingId: pending,
      mapResult: treatmentMutationResult(treatment, { releasedNow }),
    };
  });
}

export async function persistCriticalInjuryTreatmentResolution(
  pendingId,
  treatmentId,
  resolution,
  { applicationLeaseId = "" } = {},
) {
  const pending = toId(pendingId);
  const treatment = toId(treatmentId);
  const normalized = normalizeTreatmentResolution(resolution);
  const claimedId = toId(applicationLeaseId);
  const authority = toId(authoritativeGMId());
  if (
    !pending ||
    !treatment ||
    !normalized ||
    normalized.resolvedBy !== authority
  ) {
    throw new Error("CriticalInjuryTreatmentResolutionInvalid");
  }

  return mutateStore((store) => {
    const parent = store.records.find((record) => record.pendingId === pending);
    if (!parent || parent.state !== "completed") {
      throw new Error("CriticalInjuryTreatmentParentNotFound");
    }
    const record = treatmentFromParent(parent, treatment);
    if (!record) throw new Error("CriticalInjuryTreatmentNotFound");
    if (
      toId(normalized.injuryBefore?.id) !== record.injuryId ||
      toId(normalized.injuryAfter?.id) !== record.injuryId ||
      (parent.effectId && normalized.effectId !== parent.effectId) ||
      (parent.resolution?.injuryKey &&
        normalized.injuryKey !== parent.resolution.injuryKey) ||
      (parent.resolution?.tableVersion &&
        normalized.tableVersion !== parent.resolution.tableVersion) ||
      (toId(normalized.injuryBefore?.injuryKey) &&
        toId(normalized.injuryBefore?.injuryKey) !== normalized.injuryKey) ||
      (toId(normalized.injuryBefore?.pendingId) &&
        toId(normalized.injuryBefore?.pendingId) !== parent.pendingId) ||
      (toId(normalized.injuryAfter?.pendingId) &&
        toId(normalized.injuryAfter?.pendingId) !== parent.pendingId)
    ) {
      throw new Error("CriticalInjuryTreatmentResolutionMismatch");
    }
    const tokenCollision = (parent.treatments ?? []).some(
      (entry) =>
        entry.treatmentId !== treatment &&
        entry.resolution?.receiptToken === normalized.receiptToken,
    );
    if (tokenCollision) {
      throw new Error("CriticalInjuryTreatmentReceiptCollision");
    }
    if (record.state === "completed") {
      return {
        store,
        pendingId: pending,
        mapResult: treatmentMutationResult(treatment, {
          persistedNow: false,
        }),
      };
    }
    const consumptionSources = new Set(
      normalized.consumptionSteps.map(
        (step) => `${step.actorId}:${step.itemId}`,
      ),
    );
    const reservationConflict = store.records
      .flatMap((candidateParent) =>
        (candidateParent.treatments ?? []).map((entry) => ({
          parent: candidateParent,
          entry,
        })),
      )
      .some(({ parent: candidateParent, entry }) => {
        const isTarget =
          candidateParent.pendingId === pending &&
          entry.treatmentId === treatment;
        if (isTarget || entry.state === "completed" || !entry.resolution) {
          return false;
        }
        return entry.resolution.consumptionSteps.some((step) =>
          consumptionSources.has(`${step.actorId}:${step.itemId}`),
        );
      });
    if (reservationConflict) {
      throw new Error("CriticalInjuryTreatmentItemReservationConflict");
    }
    if (record.state === "resolving") {
      if (!persistedValuesEqual(record.resolution, normalized)) {
        throw new Error("CriticalInjuryTreatmentResolutionCollision");
      }
      return {
        store,
        pendingId: pending,
        mapResult: treatmentMutationResult(treatment, {
          persistedNow: false,
        }),
      };
    }
    const now = getCriticalInjuryWorkflowLeaseTimestamp();
    const lease = normalizeApplicationLease(record.applicationLease);
    if (
      !claimedId ||
      !lease ||
      lease.id !== claimedId ||
      lease.claimedBy !== authority ||
      lease.expiresAt <= now
    ) {
      throw new Error("CriticalInjuryTreatmentLeaseLost");
    }
    record.state = "resolving";
    record.resolution = normalized;
    return {
      store,
      pendingId: pending,
      mapResult: treatmentMutationResult(treatment, { persistedNow: true }),
    };
  });
}

export async function completeCriticalInjuryTreatmentWorkflow(
  pendingId,
  treatmentId,
  { result, completedAt = null, applicationLeaseId = "" } = {},
) {
  const pending = toId(pendingId);
  const treatment = toId(treatmentId);
  const normalizedResult = normalizeTreatmentResult(result);
  const claimedId = toId(applicationLeaseId);
  const authority = toId(authoritativeGMId());
  if (!pending || !treatment || !normalizedResult || !authority) {
    throw new Error("CriticalInjuryTreatmentCompletionInvalid");
  }

  return mutateStore((store) => {
    const parent = store.records.find((record) => record.pendingId === pending);
    if (!parent || parent.state !== "completed") {
      throw new Error("CriticalInjuryTreatmentParentNotFound");
    }
    const record = treatmentFromParent(parent, treatment);
    if (!record) throw new Error("CriticalInjuryTreatmentNotFound");
    if (record.state === "completed") {
      return {
        store,
        pendingId: pending,
        mapResult: treatmentMutationResult(treatment, {
          completedNow: false,
        }),
      };
    }
    if (
      normalizedResult.treatmentId !== treatment ||
      normalizedResult.injuryId !== record.injuryId ||
      (toId(normalizedResult.actorId) &&
        toId(normalizedResult.actorId) !== parent.actorId) ||
      (toId(normalizedResult.effectId) &&
        (!record.resolution ||
          toId(normalizedResult.effectId) !== record.resolution.effectId)) ||
      (!record.resolution &&
        (normalizedResult.success ||
          nonNegativeInteger(normalizedResult.consumed, 0) > 0))
    ) {
      throw new Error("CriticalInjuryTreatmentCompletionMismatch");
    }
    const now = getCriticalInjuryWorkflowLeaseTimestamp();
    const lease = normalizeApplicationLease(record.applicationLease);
    if (
      !claimedId ||
      !lease ||
      lease.id !== claimedId ||
      lease.claimedBy !== authority ||
      lease.expiresAt <= now
    ) {
      throw new Error("CriticalInjuryTreatmentLeaseLost");
    }
    record.state = "completed";
    record.result = normalizedResult;
    record.applicationLease = null;
    record.completedBy = authority;
    record.completedAt = finiteTimestamp(completedAt ?? now, now);
    return {
      store,
      pendingId: pending,
      mapResult: treatmentMutationResult(treatment, { completedNow: true }),
    };
  });
}

/** Whether both restricted replicas agree under the current authority epoch. */
export function isCriticalInjuryWorkflowReady() {
  try {
    const fence = captureAuthorityFence();
    if (!isAuthorityFenceCurrent(fence)) return false;
    const replicas = readRawReplicas();
    const primary = replicas.primary;
    const checkpoint = replicas.checkpoint;
    return Boolean(
      isPersistedEnvelope(primary) &&
      rawEnvelopesEqual(primary, checkpoint) &&
      (!fence.live ||
        (primary.authorityId === fence.userId &&
          primary.authorityEpoch === fence.authorityEpoch)),
    );
  } catch {
    return false;
  }
}

/** Test-only reset for the detached queue and authority coordinator. */
export function resetCriticalInjuryWorkflowStoreForTests() {
  for (const [event, hookId] of observerHookIds.splice(0)) {
    globalThis.Hooks?.off?.(event, hookId);
  }
  writeQueue = Promise.resolve();
  observerRegistered = false;
  authorityObservationStarted = false;
  observedAuthorityId = null;
  authorityGeneration = 0;
  observedAuthorityEpoch = null;
  highestObservedRevision = -1;
  lastAcceptedEnvelope = null;
  reconciliationInFlight = null;
  reconciliationRequested = false;
  retiredAuthorityEpochs.clear();
}
