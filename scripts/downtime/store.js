/**
 * Restricted persistence for downtime configuration and the authoritative
 * workflow. The workflow is mirrored to a checkpoint before its primary slot;
 * the checkpoint is therefore the durable commit point for recovery.
 */

import {
  PRIVATE_STATE_CHANGED_HOOK,
  getPrivateState,
  initializePrivateState,
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
import {
  DOWNTIME_CONFIG_VERSION,
  normalizeDowntimeConfig,
} from "./settlements.js";
import {
  assertDowntimeWorkflowStateInvariant,
  isDowntimeTerminalState,
  isDowntimeWorkflowState,
  transitionDowntimeWorkflowState,
} from "./state-machine.js";

const MODULE_ID = "infinity-dnd5e";
const CONFIG_KEY = "downtimeConfig";
const STORE_KEY = "downtimeWorkflow";
const CHECKPOINT_KEY = "downtimeWorkflowCheckpoint";
const STORE_VERSION = 1;
const CHECKPOINT_VERSION = 1;
const CONFIG_CHECKPOINT_VERSION = 1;
const LEGACY_DOWNTIME_CONFIG_VERSION = 2;
const GUIDED_TEMPLATE_DOWNTIME_CONFIG_VERSION = 3;
const PREVIOUS_DOWNTIME_CONFIG_VERSION = 4;
const BLOCK_SCHEMA = 1;
const PLANNING_DRAFT_VERSION = 1;
const MAX_HISTORY = 100;
const MAX_ID_LENGTH = 160;
const OPERATION_STATES = new Set([
  "pending",
  "applying",
  "applied",
  "verified-unapplied",
  "needs-review",
  "skipped",
  "compensated",
]);
const OPERATION_TERMINAL_STATES = new Set([
  "applied",
  "skipped",
  "compensated",
]);
const RECOVERED_OPERATION_RESOLUTION = Symbol(
  "recovered-downtime-operation-resolution",
);
const PLANNING_DRAFT_STATES = new Set(["active", "complete", "needs-review"]);
const PLANNING_ROLL_STATES = new Set(["pending", "in-flight", "completed"]);

let writeQueue = Promise.resolve();
let authorityObservationStarted = false;
let observedAuthorityId = null;
let observedAuthorityEpoch = null;
let authorityGeneration = 0;
let highestObservedRevision = -1;
let lastAcceptedEnvelope = null;
let observerRegistered = false;
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

function toTimestamp(value, fallback = 0) {
  const timestamp = Number(value);
  return Number.isSafeInteger(timestamp) && timestamp >= 0
    ? timestamp
    : fallback;
}

function nonNegativeInteger(value, fallback = 0) {
  const integer = Math.floor(Number(value));
  return Number.isSafeInteger(integer) && integer >= 0 ? integer : fallback;
}

function isPlainObject(value) {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function sanitizeJson(value, depth = 0) {
  if (depth > 40) throw new Error("DowntimeWorkflowDataTooDeep");
  if (
    value === null ||
    typeof value === "boolean" ||
    typeof value === "string"
  ) {
    return value;
  }
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (Array.isArray(value)) {
    return value.map((entry) => sanitizeJson(entry, depth + 1));
  }
  if (!isPlainObject(value)) return null;
  return Object.fromEntries(
    Object.entries(value)
      .filter(([, entry]) => entry !== undefined && typeof entry !== "function")
      .map(([key, entry]) => [key, sanitizeJson(entry, depth + 1)]),
  );
}

function currentTimestamp() {
  return toTimestamp(globalThis.game?.time?.serverTime, Date.now());
}

function createWriteToken() {
  const foundryId = toId(globalThis.foundry?.utils?.randomID?.(24));
  if (foundryId) return foundryId;
  const uuid = toId(globalThis.crypto?.randomUUID?.());
  if (uuid) return uuid;
  return `${Date.now()}:${Math.random().toString(36).slice(2, 14)}`;
}

function isFoundryEnvironment() {
  return Boolean(globalThis.game && globalThis.JournalEntry?.create);
}

function isLiveFoundrySession() {
  return Boolean(isFoundryEnvironment() && globalThis.game?.ready);
}

function assertExplicitPersistedVersion(
  raw,
  { domain, supportedVersion, codePrefix },
) {
  if (!isPlainObject(raw) || !Object.hasOwn(raw, "version")) return;
  assertSupportedPersistedVersion(
    raw.version === undefined ? Number.NaN : raw.version,
    { domain, supportedVersion, codePrefix },
  );
}

function assertExplicitPersistedSchema(
  raw,
  { domain, supportedVersion, codePrefix },
) {
  if (!isPlainObject(raw) || !Object.hasOwn(raw, "schema")) return;
  assertSupportedPersistedVersion(
    raw.schema === undefined ? Number.NaN : raw.schema,
    { domain, supportedVersion, codePrefix },
  );
}

function assertSupportedDowntimeConfigVersion(raw, domain, codePrefix) {
  if (
    isPlainObject(raw) &&
    [
      LEGACY_DOWNTIME_CONFIG_VERSION,
      GUIDED_TEMPLATE_DOWNTIME_CONFIG_VERSION,
      PREVIOUS_DOWNTIME_CONFIG_VERSION,
      DOWNTIME_CONFIG_VERSION,
    ].includes(Number(raw.version))
  ) {
    return;
  }
  assertExplicitPersistedVersion(raw, {
    domain,
    supportedVersion: DOWNTIME_CONFIG_VERSION,
    codePrefix,
  });
}

function assertSupportedConfigCheckpointVersion(raw, domain, codePrefix) {
  assertExplicitPersistedVersion(raw, {
    domain,
    supportedVersion: CONFIG_CHECKPOINT_VERSION,
    codePrefix,
  });
  if (isPlainObject(raw) && Object.hasOwn(raw, "value")) {
    assertSupportedDowntimeConfigVersion(
      raw.value,
      `${domain}-value`,
      `${codePrefix}_VALUE`,
    );
  }
}

function assertSupportedDowntimeBlockSchemas(raw, domain, codePrefix) {
  if (!isPlainObject(raw)) return;
  assertExplicitPersistedSchema(raw, {
    domain,
    supportedVersion: BLOCK_SCHEMA,
    codePrefix: `${codePrefix}_SCHEMA`,
  });
  if (isPlainObject(raw.planningDraft)) {
    assertExplicitPersistedVersion(raw.planningDraft, {
      domain: `${domain}-planning-draft`,
      supportedVersion: PLANNING_DRAFT_VERSION,
      codePrefix: `${codePrefix}_PLANNING_DRAFT`,
    });
  }
}

function assertSupportedWorkflowEnvelopeVersion(raw, domain, codePrefix) {
  assertExplicitPersistedVersion(raw, {
    domain,
    supportedVersion: STORE_VERSION,
    codePrefix,
  });
  if (isPlainObject(raw) && isPlainObject(raw.configCheckpoint)) {
    assertSupportedConfigCheckpointVersion(
      raw.configCheckpoint,
      `${domain}-config-checkpoint`,
      `${codePrefix}_CONFIG_CHECKPOINT`,
    );
  }
  if (isPlainObject(raw?.activeBlock)) {
    assertSupportedDowntimeBlockSchemas(
      raw.activeBlock,
      `${domain}-active-block`,
      `${codePrefix}_ACTIVE_BLOCK`,
    );
  }
  for (const historyBlock of Array.isArray(raw?.history) ? raw.history : []) {
    assertSupportedDowntimeBlockSchemas(
      historyBlock,
      `${domain}-history-block`,
      `${codePrefix}_HISTORY_BLOCK`,
    );
  }
}

function assertSupportedRawSlotVersion(key, raw) {
  if (key === CONFIG_KEY) {
    assertSupportedDowntimeConfigVersion(
      raw,
      "downtime-config",
      "DOWNTIME_CONFIG",
    );
    return;
  }
  if (key === STORE_KEY) {
    assertSupportedWorkflowEnvelopeVersion(
      raw,
      "downtime-workflow-primary",
      "DOWNTIME_WORKFLOW_PRIMARY",
    );
    return;
  }
  const isComposite = Boolean(
    isPlainObject(raw) &&
    (Object.hasOwn(raw, "workflow") || Object.hasOwn(raw, "config")),
  );
  if (!isComposite) {
    assertSupportedWorkflowEnvelopeVersion(
      raw,
      "downtime-workflow-checkpoint",
      "DOWNTIME_WORKFLOW_CHECKPOINT",
    );
    return;
  }
  assertExplicitPersistedVersion(raw, {
    domain: "downtime-workflow-checkpoint",
    supportedVersion: CHECKPOINT_VERSION,
    codePrefix: "DOWNTIME_WORKFLOW_CHECKPOINT",
  });
  if (Object.hasOwn(raw, "workflow")) {
    assertSupportedWorkflowEnvelopeVersion(
      raw.workflow,
      "downtime-workflow-checkpoint-workflow",
      "DOWNTIME_WORKFLOW_CHECKPOINT_WORKFLOW",
    );
  }
  if (Object.hasOwn(raw, "config")) {
    assertSupportedConfigCheckpointVersion(
      raw.config,
      "downtime-workflow-checkpoint-config",
      "DOWNTIME_WORKFLOW_CHECKPOINT_CONFIG",
    );
  }
}

function readRawSlot(key) {
  const privateValue = getPrivateState(key);
  if (privateValue !== undefined) {
    assertSupportedRawSlotVersion(key, privateValue);
    return privateValue;
  }
  if (isFoundryEnvironment())
    throw new Error("DowntimeWorkflowStoreUnavailable");
  let raw;
  try {
    raw = globalThis.game?.settings?.get?.(MODULE_ID, key) ?? {};
  } catch {
    return {};
  }
  assertSupportedRawSlotVersion(key, raw);
  return raw;
}

function readRawPrimary() {
  return readRawSlot(STORE_KEY);
}

function readRawCheckpoint() {
  return readRawSlot(CHECKPOINT_KEY);
}

function readRawConfig() {
  return readRawSlot(CONFIG_KEY);
}

function readRawReplicas() {
  return {
    primary: readRawPrimary(),
    checkpoint: readRawCheckpoint(),
    config: readRawConfig(),
  };
}

function replicaValueForKey(replicas, key) {
  if (key === STORE_KEY) return replicas.primary;
  if (key === CHECKPOINT_KEY) return replicas.checkpoint;
  return replicas.config;
}

function isEmptyObject(value) {
  return Boolean(isPlainObject(value) && Object.keys(value).length === 0);
}

function normalizeStoredDowntimeConfig(raw) {
  const normalized = normalizeDowntimeConfig(raw);
  normalized.history = Array.isArray(normalized.history)
    ? normalized.history.slice(-MAX_HISTORY)
    : [];
  return normalized;
}

/**
 * Validate a stored downtime config before upgrading it. Version 2 existed
 * both before and after saved settlement rows gained `hasSettlement`, so the
 * exact legacy shape accepts either the pre-change collection (the key omitted
 * everywhere) or the post-change collection (a Boolean present everywhere).
 * Unknown fields, mixed-era collections, and non-Boolean markers remain
 * malformed instead of being normalized away.
 */
function parsePersistedDowntimeConfig(raw) {
  if (!isPlainObject(raw)) return null;
  const current = normalizeStoredDowntimeConfig(raw);
  let persistedShape;
  if (persistedVersionEquals(raw.version, DOWNTIME_CONFIG_VERSION)) {
    persistedShape = current;
  } else if (
    persistedVersionEquals(raw.version, PREVIOUS_DOWNTIME_CONFIG_VERSION)
  ) {
    const { guidedProjects: _guidedProjects, ...previousShape } = current;
    persistedShape = {
      ...previousShape,
      version: PREVIOUS_DOWNTIME_CONFIG_VERSION,
    };
  } else if (
    persistedVersionEquals(raw.version, GUIDED_TEMPLATE_DOWNTIME_CONFIG_VERSION)
  ) {
    const {
      guidedTemplates: _guidedTemplates,
      guidedProjects: _guidedProjects,
      ...previousShape
    } = current;
    persistedShape = {
      ...previousShape,
      version: GUIDED_TEMPLATE_DOWNTIME_CONFIG_VERSION,
    };
  } else if (
    persistedVersionEquals(raw.version, LEGACY_DOWNTIME_CONFIG_VERSION)
  ) {
    const rawSettlements = Array.isArray(raw.settlements)
      ? raw.settlements
      : [];
    const markerPresence = current.settlements.map((_, index) =>
      Object.hasOwn(rawSettlements[index] ?? {}, "hasSettlement"),
    );
    const allMarkersPresent = markerPresence.every(Boolean);
    const allMarkersMissing = markerPresence.every((present) => !present);
    if (!allMarkersPresent && !allMarkersMissing) return null;
    persistedShape = {
      ...current,
      version: LEGACY_DOWNTIME_CONFIG_VERSION,
      settlements: current.settlements.map((settlement) => {
        if (allMarkersPresent) return settlement;
        const { hasSettlement: _hasSettlement, ...legacySettlement } =
          settlement;
        return legacySettlement;
      }),
    };
    delete persistedShape.guidedTemplates;
    delete persistedShape.guidedProjects;
  } else {
    return null;
  }
  if (!persistedValuesEqual(raw, persistedShape)) return null;
  return {
    raw: clone(persistedShape),
    current: clone(current),
    needsMigration: !persistedValuesEqual(persistedShape, current),
  };
}

function normalizeStandaloneDowntimeConfig(raw) {
  if (isEmptyObject(raw)) return normalizeStoredDowntimeConfig(raw);
  const parsed = parsePersistedDowntimeConfig(raw);
  if (!parsed) throw new Error("DowntimeConfigMalformed");
  return parsed.current;
}

function normalizeOperationRecord(raw, operationId, actorId = "") {
  const value = isPlainObject(raw) ? sanitizeJson(raw) : {};
  const state = OPERATION_STATES.has(value.state) ? value.state : "pending";
  const normalized = {
    operationId,
    actorId: toId(value.actorId) || toId(actorId) || null,
    state,
    attemptId: toId(value.attemptId) || null,
    claimedBy: toId(value.claimedBy) || null,
    startedAt: toTimestamp(value.startedAt),
    resolvedAt: toTimestamp(value.resolvedAt),
    receipt: isPlainObject(value.receipt) ? value.receipt : null,
    compensatedAt: toTimestamp(value.compensatedAt),
    compensationReceipt: isPlainObject(value.compensationReceipt)
      ? value.compensationReceipt
      : null,
    reason:
      String(value.reason ?? "")
        .trim()
        .slice(0, 500) || null,
  };
  const authorityEpoch = toId(value.authorityEpoch);
  if (authorityEpoch) normalized.authorityEpoch = authorityEpoch;
  if (state === "pending" || state === "verified-unapplied") {
    normalized.attemptId = null;
    normalized.claimedBy = null;
    normalized.startedAt = 0;
    delete normalized.authorityEpoch;
  }
  return normalized;
}

export function normalizeDowntimeOperationLedger(raw) {
  if (!isPlainObject(raw)) return {};
  const entries = [];
  for (const [rawId, rawRecord] of Object.entries(raw)) {
    const operationId = toId(rawId) || toId(rawRecord?.operationId);
    if (!operationId) continue;
    entries.push([
      operationId,
      normalizeOperationRecord(rawRecord, operationId),
    ]);
  }
  entries.sort(([left], [right]) => left.localeCompare(right));
  return Object.fromEntries(entries);
}

function normalizePlanningRoll(raw, rowId) {
  if (!isPlainObject(raw)) return null;
  const value = sanitizeJson(raw);
  const state = PLANNING_ROLL_STATES.has(value.state) ? value.state : "pending";
  const roll = isPlainObject(value.roll)
    ? {
        total:
          value.roll.total !== null &&
          value.roll.total !== undefined &&
          Number.isSafeInteger(Number(value.roll.total))
            ? Math.trunc(Number(value.roll.total))
            : null,
        dieResult:
          value.roll.dieResult !== null &&
          value.roll.dieResult !== undefined &&
          Number.isFinite(Number(value.roll.dieResult))
            ? Math.trunc(Number(value.roll.dieResult))
            : null,
        skillModifier:
          value.roll.skillModifier !== null &&
          value.roll.skillModifier !== undefined &&
          Number.isFinite(Number(value.roll.skillModifier))
            ? Math.trunc(Number(value.roll.skillModifier))
            : null,
        formula: String(value.roll.formula ?? "").slice(0, 500),
      }
    : null;
  if (state === "completed" && !Number.isSafeInteger(roll?.total)) return null;
  const normalized = {
    rowId,
    actorId: toId(value.actorId),
    actionId: toId(value.actionId),
    activityId: toId(value.activityId),
    order: nonNegativeInteger(value.order),
    state,
    claimedBy: toId(value.claimedBy) || null,
    authorityEpoch: toId(value.authorityEpoch) || null,
    startedAt: toTimestamp(value.startedAt),
    completedAt: toTimestamp(value.completedAt),
    roll: state === "completed" ? roll : null,
  };
  if (!normalized.actorId || !normalized.actionId || !normalized.activityId) {
    return null;
  }
  if (state === "pending") {
    normalized.claimedBy = null;
    normalized.authorityEpoch = null;
    normalized.startedAt = 0;
  }
  return normalized;
}

function normalizeDowntimePlanningDraft(raw) {
  if (!isPlainObject(raw)) return null;
  const value = sanitizeJson(raw);
  const manifest = isPlainObject(value.manifest) ? value.manifest : null;
  if (!manifest) return null;
  const rows = {};
  for (const [rawRowId, rawRow] of Object.entries(value.rows ?? {})) {
    const rowId = toId(rawRowId) || toId(rawRow?.rowId);
    const row = rowId ? normalizePlanningRoll(rawRow, rowId) : null;
    if (!row || Object.hasOwn(rows, rowId)) return null;
    rows[rowId] = row;
  }
  const orderedRows = Object.fromEntries(
    Object.entries(rows).sort(([left], [right]) => left.localeCompare(right)),
  );
  const state = PLANNING_DRAFT_STATES.has(value.state) ? value.state : "active";
  if (
    state === "complete" &&
    Object.values(orderedRows).some((row) => row.state !== "completed")
  ) {
    return null;
  }
  return {
    version: PLANNING_DRAFT_VERSION,
    state,
    manifest,
    rows: orderedRows,
    createdAt: toTimestamp(value.createdAt),
    updatedAt: toTimestamp(value.updatedAt),
    reviewReason:
      String(value.reviewReason ?? "")
        .trim()
        .slice(0, 500) || null,
  };
}

function plannedOperations(plan) {
  const operations = Array.isArray(plan?.operations) ? plan.operations : [];
  const seen = new Set();
  const normalized = [];
  for (const operation of operations) {
    const operationId = toId(operation?.operationId) || toId(operation?.id);
    if (!operationId || seen.has(operationId)) {
      throw new Error("DowntimeWorkflowOperationIdInvalid");
    }
    seen.add(operationId);
    normalized.push({
      operationId,
      actorId: toId(operation?.actorId),
    });
  }
  return normalized;
}

function plannedOperation(plan, operationId) {
  const id = toId(operationId);
  if (!id || !Array.isArray(plan?.operations)) return null;
  return (
    plan.operations.find(
      (operation) =>
        (toId(operation?.operationId) || toId(operation?.id)) === id,
    ) ?? null
  );
}

function isVerifiedRecoveryAppliedResolution({
  active,
  current,
  operationId,
  attemptId,
  receipt,
  recoveryToken,
}) {
  if (
    recoveryToken !== RECOVERED_OPERATION_RESOLUTION ||
    active?.state !== "needs-review" ||
    current?.state !== "needs-review" ||
    toId(attemptId) ||
    !isPlainObject(receipt) ||
    receipt.recovered !== true
  ) {
    return false;
  }
  const receiptKeys = Object.keys(receipt).sort();
  if (!persistedValuesEqual(receiptKeys, ["recovered", "summary"])) {
    return false;
  }
  const operation = plannedOperation(active.plan, operationId);
  return Boolean(
    operation &&
    typeof operation.summary === "string" &&
    typeof receipt.summary === "string" &&
    receipt.summary === operation.summary,
  );
}

function createOperationLedger(plan) {
  return Object.fromEntries(
    plannedOperations(plan).map(({ operationId, actorId }) => [
      operationId,
      normalizeOperationRecord({}, operationId, actorId),
    ]),
  );
}

function validateLedgerAgainstPlan(plan, ledger) {
  const operations = plannedOperations(plan);
  const operationIds = new Set(operations.map((entry) => entry.operationId));
  const ledgerIds = Object.keys(ledger);
  if (
    operationIds.size !== ledgerIds.length ||
    ledgerIds.some((operationId) => !operationIds.has(operationId))
  ) {
    throw new Error("DowntimeWorkflowOperationLedgerMismatch");
  }
  return true;
}

export function normalizeDowntimeBlock(raw) {
  if (!isPlainObject(raw)) return null;
  const value = sanitizeJson(raw);
  const id = toId(value.id);
  const state = isDowntimeWorkflowState(value.state)
    ? value.state
    : "collecting";
  if (!id) return null;
  const block = {
    ...value,
    schema: BLOCK_SCHEMA,
    id,
    state,
    createdAt: toTimestamp(value.createdAt),
    updatedAt: toTimestamp(value.updatedAt),
    createdBy: toId(value.createdBy) || null,
    updatedBy: toId(value.updatedBy) || null,
    plan: isPlainObject(value.plan) ? value.plan : null,
    operationLedger: normalizeDowntimeOperationLedger(value.operationLedger),
  };
  const planningDraft = normalizeDowntimePlanningDraft(value.planningDraft);
  if (planningDraft) block.planningDraft = planningDraft;
  else delete block.planningDraft;
  try {
    assertDowntimeWorkflowStateInvariant(block);
    if (block.plan)
      validateLedgerAgainstPlan(block.plan, block.operationLedger);
  } catch {
    return null;
  }
  return block;
}

function projectContributionsFromBlock(block) {
  const contributions = {};
  if (block?.state !== "completed") return contributions;
  for (const operation of block.plan?.operations ?? []) {
    if (block.operationLedger?.[operation.operationId]?.state !== "applied") {
      continue;
    }
    const projectId = toId(operation?.project?.id);
    const hours = nonNegativeInteger(operation?.project?.contributedHours);
    if (!projectId || hours < 1) continue;
    contributions[projectId] = nonNegativeInteger(
      (contributions[projectId] ?? 0) + hours,
    );
  }
  return contributions;
}

function normalizeProjectProgress(raw, history = []) {
  const progress = {};
  if (isPlainObject(raw)) {
    for (const [rawProjectId, rawHours] of Object.entries(raw)) {
      const projectId = toId(rawProjectId);
      const hours = nonNegativeInteger(rawHours);
      if (projectId && hours > 0) progress[projectId] = hours;
    }
    return progress;
  }
  for (const block of history) {
    for (const [projectId, hours] of Object.entries(
      projectContributionsFromBlock(block),
    )) {
      progress[projectId] = nonNegativeInteger(
        (progress[projectId] ?? 0) + hours,
      );
    }
  }
  return progress;
}

function defaultWorkflowStore() {
  return {
    version: STORE_VERSION,
    revision: 0,
    authorityId: null,
    authorityEpoch: null,
    writeToken: null,
    configCheckpoint: null,
    activeBlock: null,
    projectProgress: {},
    history: [],
  };
}

export function normalizeDowntimeWorkflowStore(raw) {
  if (!isPlainObject(raw)) return defaultWorkflowStore();
  const activeBlock = normalizeDowntimeBlock(raw.activeBlock);
  const seen = new Set(activeBlock ? [activeBlock.id] : []);
  const history = [];
  for (const entry of Array.isArray(raw.history) ? raw.history : []) {
    const block = normalizeDowntimeBlock(entry);
    if (!block || !isDowntimeTerminalState(block.state) || seen.has(block.id)) {
      continue;
    }
    seen.add(block.id);
    history.push(block);
  }
  return {
    version: STORE_VERSION,
    revision: nonNegativeInteger(raw.revision),
    authorityId: toId(raw.authorityId) || null,
    authorityEpoch: toId(raw.authorityEpoch) || null,
    writeToken: toId(raw.writeToken) || null,
    configCheckpoint: normalizeConfigCheckpointRecord(raw.configCheckpoint),
    activeBlock:
      activeBlock && !isDowntimeTerminalState(activeBlock.state)
        ? activeBlock
        : null,
    projectProgress: normalizeProjectProgress(raw.projectProgress, history),
    history: history.slice(-MAX_HISTORY),
  };
}

function isPersistedEnvelope(raw) {
  if (
    !isPlainObject(raw) ||
    !persistedVersionEquals(raw.version, STORE_VERSION)
  )
    return false;
  if (!Number.isSafeInteger(Number(raw.revision)) || Number(raw.revision) < 0) {
    return false;
  }
  if (
    !toId(raw.authorityId) ||
    !toId(raw.authorityEpoch) ||
    !toId(raw.writeToken)
  ) {
    return false;
  }
  const normalized = normalizeDowntimeWorkflowStore(raw);
  if (Object.hasOwn(raw, "configCheckpoint")) {
    const configCheckpoint = parsePersistedConfigCheckpointRecord(
      raw.configCheckpoint,
    );
    if (!configCheckpoint) return false;
    const current = {
      ...normalized,
      configCheckpoint: configCheckpoint.raw,
    };
    if (persistedValuesEqual(raw, current)) return true;
    const { projectProgress: _projectProgress, ...legacy } = current;
    return persistedValuesEqual(raw, legacy);
  }
  const { configCheckpoint: _configCheckpoint, ...withoutCheckpoint } =
    normalized;
  if (persistedValuesEqual(raw, withoutCheckpoint)) return true;
  const { projectProgress: _projectProgress, ...legacy } = withoutCheckpoint;
  return persistedValuesEqual(raw, legacy);
}

function persistedRevision(raw) {
  return isPersistedEnvelope(raw) ? Number(raw.revision) : -1;
}

function buildCurrentConfigCheckpointRecord(raw) {
  if (!isPlainObject(raw)) return null;
  const record = {
    version: CONFIG_CHECKPOINT_VERSION,
    revision: nonNegativeInteger(raw.revision, -1),
    authorityId: toId(raw.authorityId) || null,
    authorityEpoch: toId(raw.authorityEpoch) || null,
    writeToken: toId(raw.writeToken) || null,
    value: normalizeStoredDowntimeConfig(raw.value),
  };
  if (
    record.revision < 0 ||
    !record.authorityId ||
    !record.authorityEpoch ||
    !record.writeToken
  ) {
    return null;
  }
  return record;
}

function parsePersistedConfigCheckpointRecord(raw) {
  if (!isPlainObject(raw)) return null;
  const value = parsePersistedDowntimeConfig(raw.value);
  if (!value) return null;
  const current = buildCurrentConfigCheckpointRecord(raw);
  if (!current) return null;
  const persistedShape = { ...current, value: value.raw };
  if (!persistedValuesEqual(raw, persistedShape)) return null;
  return {
    raw: clone(persistedShape),
    current: { ...current, value: value.current },
    needsMigration: value.needsMigration,
  };
}

function normalizeConfigCheckpointRecord(raw) {
  return (
    parsePersistedConfigCheckpointRecord(raw)?.current ??
    buildCurrentConfigCheckpointRecord(raw)
  );
}

function isSupportedConfigCheckpointRecord(raw) {
  return Boolean(parsePersistedConfigCheckpointRecord(raw));
}

function isCurrentConfigCheckpointRecord(raw) {
  const parsed = parsePersistedConfigCheckpointRecord(raw);
  return Boolean(parsed && !parsed.needsMigration);
}

function persistedConfigRevision(raw) {
  return isSupportedConfigCheckpointRecord(raw) ? Number(raw.revision) : -1;
}

function createConfigCheckpointRecord(value, fence, previous = null) {
  const revision = persistedConfigRevision(previous) + 1;
  if (!Number.isSafeInteger(revision) || revision < 0) {
    throw new Error("DowntimeConfigRevisionInvalid");
  }
  const authorityId = fence.live
    ? fence.userId
    : toId(authoritativeGMId()) ||
      toId(globalThis.game?.user?.id) ||
      "node-test";
  const authorityEpoch = fence.live
    ? fence.authorityEpoch
    : isSupportedConfigCheckpointRecord(previous) &&
        previous.authorityId === authorityId
      ? previous.authorityEpoch
      : `${authorityId}:node-test:0`;
  if (!authorityId || !authorityEpoch) {
    throw new Error("DowntimeConfigIdentityInvalid");
  }
  return {
    version: CONFIG_CHECKPOINT_VERSION,
    revision,
    authorityId,
    authorityEpoch,
    writeToken: createWriteToken(),
    value: normalizeStoredDowntimeConfig(value),
  };
}

function configCheckpointBelongsToFence(record, fence) {
  if (!isSupportedConfigCheckpointRecord(record)) return false;
  if (!fence.live) return true;
  return Boolean(
    record.authorityId === fence.userId &&
    record.authorityEpoch === fence.authorityEpoch,
  );
}

function serializeRecoveryCheckpoint(workflow, config) {
  if (
    !isPersistedEnvelope(workflow) ||
    !isCurrentConfigCheckpointRecord(config) ||
    !persistedValuesEqual(workflow.configCheckpoint, config)
  ) {
    throw new Error("DowntimeWorkflowCheckpointInvalid");
  }
  return {
    version: CHECKPOINT_VERSION,
    workflow: clone(workflow),
    config: clone(config),
  };
}

function parseRecoveryCheckpoint(raw) {
  if (isEmptyObject(raw)) {
    return { kind: "empty", workflow: null, config: null };
  }
  if (isPersistedEnvelope(raw)) {
    return { kind: "legacy", workflow: clone(raw), config: null };
  }
  if (
    !isPlainObject(raw) ||
    !persistedVersionEquals(raw.version, CHECKPOINT_VERSION) ||
    !isPersistedEnvelope(raw.workflow) ||
    !isSupportedConfigCheckpointRecord(raw.config)
  ) {
    throw new Error("DowntimeWorkflowCheckpointMalformed");
  }
  if (
    raw.workflow.configCheckpoint &&
    !persistedValuesEqual(raw.workflow.configCheckpoint, raw.config)
  ) {
    throw new Error("DowntimeWorkflowCheckpointMalformed");
  }
  const normalized = {
    version: CHECKPOINT_VERSION,
    workflow: clone(raw.workflow),
    config: clone(raw.config),
  };
  if (!persistedValuesEqual(raw, normalized)) {
    throw new Error("DowntimeWorkflowCheckpointMalformed");
  }
  return {
    kind: "composite",
    workflow: clone(raw.workflow),
    config: clone(raw.config),
  };
}

function createAuthorityEpoch(authorityId) {
  const id = toId(authorityId);
  return id ? `${id}:${createWriteToken()}` : null;
}

function currentUserOwnsAuthority(authorityId) {
  const currentUserId = toId(globalThis.game?.user?.id);
  return Boolean(
    currentUserId &&
    currentUserId === authorityId &&
    isFullGM(globalThis.game?.user),
  );
}

export function observeDowntimeWorkflowAuthorityTransition() {
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
      authorityEpoch: observedAuthorityEpoch,
      generation: authorityGeneration,
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
  return {
    changed,
    authorityId,
    authorityEpoch: observedAuthorityEpoch,
    generation: authorityGeneration,
    newlyAuthoritative: Boolean(
      changed && currentUserOwnsAuthority(authorityId),
    ),
  };
}

function captureAuthorityFence() {
  if (!isLiveFoundrySession()) {
    return { live: false, userId: toId(globalThis.game?.user?.id) };
  }
  const observation = observeDowntimeWorkflowAuthorityTransition();
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
  const observation = observeDowntimeWorkflowAuthorityTransition();
  return Boolean(
    fence.userId &&
    fence.userId === fence.authorityId &&
    observation.authorityId === fence.authorityId &&
    observation.authorityEpoch === fence.authorityEpoch &&
    observation.generation === fence.generation &&
    isAuthoritativeGM(),
  );
}

function assertAuthorityFence(fence) {
  if (isAuthorityFenceCurrent(fence)) return;
  if (!isAuthoritativeGM()) {
    throw new Error("DowntimeWorkflowWriteRequiresAuthority");
  }
  throw new Error("DowntimeWorkflowAuthorityChanged");
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
      persistedValuesEqual(raw, lastAcceptedEnvelope),
    );
  }
  highestObservedRevision = revision;
  lastAcceptedEnvelope = clone(raw);
  return true;
}

function chooseHighestEnvelope(candidates, fence = null) {
  let persisted = candidates.filter(isPersistedEnvelope);
  if (fence?.live && isPersistedEnvelope(lastAcceptedEnvelope)) {
    const acceptedRevision = persistedRevision(lastAcceptedEnvelope);
    persisted = persisted.filter(
      (candidate) =>
        !retiredAuthorityEpochs.has(candidate.authorityEpoch) ||
        candidate.authorityEpoch !== lastAcceptedEnvelope.authorityEpoch ||
        persistedRevision(candidate) <= acceptedRevision,
    );
  }
  if (persisted.length === 0) return null;
  const highestRevision = Math.max(...persisted.map(persistedRevision));
  const highest = persisted.filter(
    (candidate) => persistedRevision(candidate) === highestRevision,
  );
  const first = highest[0];
  if (highest.every((candidate) => persistedValuesEqual(candidate, first))) {
    return first;
  }
  if (
    isPersistedEnvelope(lastAcceptedEnvelope) &&
    persistedRevision(lastAcceptedEnvelope) === highestRevision
  ) {
    const accepted = highest.find((candidate) =>
      persistedValuesEqual(candidate, lastAcceptedEnvelope),
    );
    if (accepted) return accepted;
  }
  throw new Error("DowntimeWorkflowRevisionConflict");
}

function selectRecoveryBase(primary, checkpoint, fence = null) {
  const checkpointParts = parseRecoveryCheckpoint(checkpoint);
  const checkpointWorkflow = checkpointParts.workflow;
  if (
    fence?.live &&
    isPersistedEnvelope(primary) &&
    isPersistedEnvelope(checkpointWorkflow) &&
    !persistedValuesEqual(primary, checkpointWorkflow)
  ) {
    const primaryIsCurrent =
      primary.authorityId === fence.userId &&
      primary.authorityEpoch === fence.authorityEpoch;
    const checkpointIsCurrent =
      checkpointWorkflow.authorityId === fence.userId &&
      checkpointWorkflow.authorityEpoch === fence.authorityEpoch;
    if (primaryIsCurrent !== checkpointIsCurrent) {
      return primaryIsCurrent ? primary : checkpointWorkflow;
    }
    if (!primaryIsCurrent && !checkpointIsCurrent) {
      const primaryRevision = persistedRevision(primary);
      const checkpointRevision = persistedRevision(checkpointWorkflow);
      if (primaryRevision !== checkpointRevision) {
        return primaryRevision < checkpointRevision
          ? primary
          : checkpointWorkflow;
      }
    }
  }
  const selected = chooseHighestEnvelope(
    [primary, checkpointWorkflow, lastAcceptedEnvelope],
    fence,
  );
  if (selected) return selected;
  if (!isEmptyObject(primary) || checkpointParts.kind !== "empty") {
    throw new Error("DowntimeWorkflowStoreMalformed");
  }
  return defaultWorkflowStore();
}

function nextWriteIdentity(fence, ...snapshots) {
  const revision =
    Math.max(highestObservedRevision, ...snapshots.map(persistedRevision)) + 1;
  if (!Number.isSafeInteger(revision) || revision < 0) {
    throw new Error("DowntimeWorkflowRevisionInvalid");
  }
  const authorityId = fence.live
    ? fence.userId
    : toId(authoritativeGMId()) ||
      toId(globalThis.game?.user?.id) ||
      "node-test";
  const authorityEpoch = fence.live
    ? fence.authorityEpoch
    : (snapshots.find(
        (snapshot) =>
          isPersistedEnvelope(snapshot) && snapshot.authorityId === authorityId,
      )?.authorityEpoch ?? `${authorityId}:node-test:0`);
  if (!authorityId || !authorityEpoch) {
    throw new Error("DowntimeWorkflowIdentityInvalid");
  }
  return { revision, authorityId, authorityEpoch };
}

function serializeEnvelope(store, identity, configCheckpoint) {
  const normalized = normalizeDowntimeWorkflowStore(store);
  if (!isCurrentConfigCheckpointRecord(configCheckpoint)) {
    throw new Error("DowntimeConfigCheckpointInvalid");
  }
  return {
    ...normalized,
    version: STORE_VERSION,
    revision: identity.revision,
    authorityId: identity.authorityId,
    authorityEpoch: identity.authorityEpoch,
    writeToken: createWriteToken(),
    configCheckpoint: clone(configCheckpoint),
  };
}

function enqueueWrite(operation) {
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

async function repairReplica(key, envelope, expected, fence) {
  readRawReplicas();
  await setPrivateState(key, envelope, {
    beforeWrite: () => {
      const current = readRawReplicas();
      return (
        isAuthorityFenceCurrent(fence) &&
        persistedValuesEqual(replicaValueForKey(current, key), expected)
      );
    },
    afterWrite: () => {
      const current = readRawReplicas();
      return (
        isAuthorityFenceCurrent(fence) &&
        persistedValuesEqual(replicaValueForKey(current, key), envelope)
      );
    },
  });
}

async function commitEnvelope(
  store,
  {
    fence,
    expectedPrimary,
    expectedCheckpoint,
    expectedConfig,
    configCheckpoint,
  },
) {
  assertAuthorityFence(fence);
  const replicas = readRawReplicas();
  if (
    !persistedValuesEqual(replicas.primary, expectedPrimary) ||
    !persistedValuesEqual(replicas.checkpoint, expectedCheckpoint) ||
    !persistedValuesEqual(replicas.config, expectedConfig)
  ) {
    throw new Error("DowntimeWorkflowStaleWrite");
  }
  if (!isCurrentConfigCheckpointRecord(configCheckpoint)) {
    throw new Error("DowntimeConfigCheckpointInvalid");
  }
  const expectedCheckpointWorkflow =
    parseRecoveryCheckpoint(expectedCheckpoint).workflow;
  const next = serializeEnvelope(
    store,
    nextWriteIdentity(
      fence,
      expectedPrimary,
      expectedCheckpointWorkflow,
      lastAcceptedEnvelope,
    ),
    configCheckpoint,
  );
  const nextCheckpoint = serializeRecoveryCheckpoint(next, configCheckpoint);

  await repairReplica(
    CHECKPOINT_KEY,
    nextCheckpoint,
    expectedCheckpoint,
    fence,
  );
  assertAuthorityFence(fence);
  await repairReplica(STORE_KEY, next, expectedPrimary, fence);
  assertAuthorityFence(fence);
  const stored = readRawReplicas();
  if (
    !persistedValuesEqual(stored.primary, next) ||
    !persistedValuesEqual(stored.checkpoint, nextCheckpoint) ||
    !persistedValuesEqual(stored.config, configCheckpoint.value) ||
    !acceptEnvelope(next, fence)
  ) {
    throw new Error("DowntimeWorkflowWriteVerificationFailed");
  }
  return clone(next);
}

function markInterruptedOperationsForReview(store, fence) {
  const block = store.activeBlock;
  if (!block) return store;
  const authorityEpochChanged = Boolean(
    toId(store.authorityEpoch) &&
    toId(fence.authorityEpoch) &&
    store.authorityEpoch !== fence.authorityEpoch,
  );
  if (
    block.state === "locked" &&
    block.planningDraft &&
    Object.values(block.planningDraft.rows ?? {}).some(
      (row) => row.state === "in-flight",
    )
  ) {
    const next = clone(store);
    next.activeBlock.planningDraft.state = "needs-review";
    next.activeBlock.planningDraft.reviewReason =
      "authority-handoff-during-hidden-roll";
    next.activeBlock.planningDraft.updatedAt = currentTimestamp();
    return next;
  }
  if (block.state !== "applying") return store;
  const hasForeignInFlight = Object.values(block.operationLedger).some(
    (record) =>
      record.state === "applying" &&
      (record.claimedBy !== fence.userId || authorityEpochChanged),
  );
  const hasOperationUnderReview = Object.values(block.operationLedger).some(
    (record) => record.state === "needs-review",
  );
  if (!hasForeignInFlight && !hasOperationUnderReview) return store;
  const next = clone(store);
  for (const record of Object.values(next.activeBlock.operationLedger)) {
    if (record.state !== "applying") continue;
    record.state = "needs-review";
    record.resolvedAt = currentTimestamp();
    record.reason = "authority-handoff-during-operation";
  }
  const reason = hasForeignInFlight
    ? "authority-handoff-during-operation"
    : "operation-review-transition-interrupted";
  next.activeBlock = transitionDowntimeWorkflowState(
    next.activeBlock,
    "needs-review",
    {
      at: currentTimestamp(),
      by: fence.userId,
      reason,
    },
  );
  return next;
}

async function ensureEnvelopeForFence(fence) {
  assertAuthorityFence(fence);
  const replicas = readRawReplicas();
  let primary = replicas.primary;
  let checkpoint = replicas.checkpoint;
  let primaryConfig = replicas.config;
  let checkpointParts = parseRecoveryCheckpoint(checkpoint);
  const base = selectRecoveryBase(primary, checkpoint, fence);
  const embeddedConfigCheckpoint = parsePersistedConfigCheckpointRecord(
    base?.configCheckpoint,
  );
  const mirroredConfigCheckpoint = persistedValuesEqual(
    base,
    checkpointParts.workflow,
  )
    ? parsePersistedConfigCheckpointRecord(checkpointParts.config)
    : null;
  let configCheckpoint =
    embeddedConfigCheckpoint?.current ??
    mirroredConfigCheckpoint?.current ??
    null;
  if (!configCheckpoint) {
    configCheckpoint = createConfigCheckpointRecord(
      normalizeStandaloneDowntimeConfig(primaryConfig),
      fence,
    );
  }
  if (!persistedValuesEqual(primaryConfig, configCheckpoint.value)) {
    await repairReplica(
      CONFIG_KEY,
      configCheckpoint.value,
      primaryConfig,
      fence,
    );
    primaryConfig = readRawReplicas().config;
  }

  const belongsToFence = Boolean(
    isPersistedEnvelope(base) &&
    (!fence.live ||
      (base.authorityId === fence.userId &&
        base.authorityEpoch === fence.authorityEpoch)),
  );
  if (
    !belongsToFence ||
    !configCheckpointBelongsToFence(configCheckpoint, fence) ||
    !persistedValuesEqual(base.configCheckpoint, configCheckpoint)
  ) {
    const reauthorizedConfig = createConfigCheckpointRecord(
      configCheckpoint.value,
      fence,
      configCheckpoint,
    );
    return commitEnvelope(markInterruptedOperationsForReview(base, fence), {
      fence,
      expectedPrimary: primary,
      expectedCheckpoint: checkpoint,
      expectedConfig: primaryConfig,
      configCheckpoint: reauthorizedConfig,
    });
  }

  const desiredCheckpoint = serializeRecoveryCheckpoint(base, configCheckpoint);
  if (!persistedValuesEqual(checkpoint, desiredCheckpoint)) {
    await repairReplica(CHECKPOINT_KEY, desiredCheckpoint, checkpoint, fence);
    checkpoint = readRawReplicas().checkpoint;
    checkpointParts = parseRecoveryCheckpoint(checkpoint);
  }
  if (!persistedValuesEqual(primary, base)) {
    await repairReplica(STORE_KEY, base, primary, fence);
    primary = readRawReplicas().primary;
  }
  const repaired = readRawReplicas();
  if (
    !persistedValuesEqual(primary, base) ||
    !persistedValuesEqual(checkpointParts.workflow, base) ||
    !persistedValuesEqual(checkpointParts.config, configCheckpoint) ||
    !persistedValuesEqual(repaired.config, configCheckpoint.value) ||
    !acceptEnvelope(base, fence)
  ) {
    throw new Error("DowntimeWorkflowRepairVerificationFailed");
  }
  return clone(base);
}

export function ensureDowntimeWorkflowAuthority() {
  return enqueueWrite((fence) => ensureEnvelopeForFence(fence));
}

export function loadDowntimeWorkflowStore() {
  const fence = captureAuthorityFence();
  const replicas = readRawReplicas();
  return clone(
    normalizeDowntimeWorkflowStore(
      selectRecoveryBase(replicas.primary, replicas.checkpoint, fence),
    ),
  );
}

export function getActiveDowntimeBlock() {
  return clone(loadDowntimeWorkflowStore().activeBlock);
}

export function getDowntimeWorkflowRevision() {
  return loadDowntimeWorkflowStore().revision;
}

export function getDowntimeBlock(blockId) {
  const id = toId(blockId);
  if (!id) return null;
  const store = loadDowntimeWorkflowStore();
  if (store.activeBlock?.id === id) return clone(store.activeBlock);
  return clone(store.history.find((entry) => entry.id === id) ?? null);
}

function assertImmutablePlan(before, nextStore) {
  if (!before?.plan) return;
  const after =
    nextStore?.activeBlock?.id === before.id
      ? nextStore.activeBlock
      : nextStore?.history?.find((entry) => entry.id === before.id);
  if (!after || !persistedValuesEqual(before.plan, after.plan)) {
    throw new Error("DowntimeWorkflowPlanImmutable");
  }
}

async function mutateWorkflow(mutator) {
  return enqueueWrite(async (fence) => {
    const ensured = await ensureEnvelopeForFence(fence);
    assertAuthorityFence(fence);
    const replicas = readRawReplicas();
    const expectedPrimary = replicas.primary;
    const expectedCheckpoint = replicas.checkpoint;
    const expectedConfig = replicas.config;
    const checkpointParts = parseRecoveryCheckpoint(expectedCheckpoint);
    if (
      !persistedValuesEqual(expectedPrimary, ensured) ||
      !persistedValuesEqual(checkpointParts.workflow, ensured) ||
      !isCurrentConfigCheckpointRecord(checkpointParts.config) ||
      !persistedValuesEqual(expectedConfig, checkpointParts.config.value)
    ) {
      throw new Error("DowntimeWorkflowStaleWrite");
    }
    const working = normalizeDowntimeWorkflowStore(ensured);
    const beforeStore = clone(working);
    const beforeBlock = clone(working.activeBlock);
    const outcome = await mutator(working, fence);
    const nextStore = normalizeDowntimeWorkflowStore(outcome?.store ?? working);
    assertImmutablePlan(beforeBlock, nextStore);
    if (persistedValuesEqual(beforeStore, nextStore)) {
      return clone(outcome?.result ?? nextStore);
    }
    const committed = await commitEnvelope(nextStore, {
      fence,
      expectedPrimary,
      expectedCheckpoint,
      expectedConfig,
      configCheckpoint: checkpointParts.config,
    });
    return clone(
      outcome?.mapResult?.(committed) ?? outcome?.result ?? committed,
    );
  });
}

export async function createDowntimeBlock(block) {
  const candidate = normalizeDowntimeBlock({
    ...sanitizeJson(block ?? {}),
    schema: BLOCK_SCHEMA,
    state: "collecting",
    plan: null,
    operationLedger: {},
    createdAt: toTimestamp(block?.createdAt, currentTimestamp()),
    updatedAt: toTimestamp(block?.updatedAt, currentTimestamp()),
    createdBy: toId(block?.createdBy) || toId(globalThis.game?.user?.id),
  });
  if (!candidate) throw new Error("DowntimeWorkflowBlockInvalid");
  return mutateWorkflow((store) => {
    const existing =
      store.activeBlock?.id === candidate.id
        ? store.activeBlock
        : store.history.find((entry) => entry.id === candidate.id);
    if (existing) return { store, result: existing };
    if (store.activeBlock)
      throw new Error("DowntimeWorkflowBlockAlreadyActive");
    store.activeBlock = candidate;
    return {
      store,
      mapResult: (committed) => committed.activeBlock,
    };
  });
}

export async function updateCollectingDowntimeBlock(
  blockId,
  patch,
  { expectedRevision = null } = {},
) {
  const id = toId(blockId);
  if (!id || !isPlainObject(patch)) {
    throw new Error("DowntimeWorkflowCollectingUpdateInvalid");
  }
  return mutateWorkflow((store, fence) => {
    if (
      expectedRevision !== null &&
      nonNegativeInteger(expectedRevision, -1) !== store.revision
    ) {
      throw new Error("DowntimeWorkflowRevisionMismatch");
    }
    const current = store.activeBlock;
    if (!current || current.id !== id)
      throw new Error("DowntimeWorkflowBlockNotFound");
    if (current.state !== "collecting") {
      throw new Error("DowntimeWorkflowSubmissionsClosed");
    }
    const next = normalizeDowntimeBlock({
      ...current,
      ...sanitizeJson(patch),
      id: current.id,
      state: current.state,
      plan: null,
      operationLedger: {},
      createdAt: current.createdAt,
      createdBy: current.createdBy,
      updatedAt: currentTimestamp(),
      updatedBy: fence.userId,
    });
    if (!next) throw new Error("DowntimeWorkflowCollectingUpdateInvalid");
    store.activeBlock = next;
    return { store, mapResult: (committed) => committed.activeBlock };
  });
}

async function transitionActiveBlock(blockId, state, options = {}) {
  const id = toId(blockId);
  if (!id) throw new Error("DowntimeWorkflowBlockIdInvalid");
  return mutateWorkflow((store, fence) => {
    const current = store.activeBlock;
    if (!current || current.id !== id)
      throw new Error("DowntimeWorkflowBlockNotFound");
    store.activeBlock = transitionDowntimeWorkflowState(current, state, {
      at: options.at ?? currentTimestamp(),
      by: options.by ?? fence.userId,
      reason: options.reason,
    });
    return { store, mapResult: (committed) => committed.activeBlock };
  });
}

export function lockDowntimeBlock(blockId, options = {}) {
  return transitionActiveBlock(blockId, "locked", options);
}

export async function persistDowntimePlan(blockId, plan, options = {}) {
  const id = toId(blockId);
  if (!id || !isPlainObject(plan))
    throw new Error("DowntimeWorkflowPlanInvalid");
  const normalizedPlan = sanitizeJson(plan);
  const operationLedger = createOperationLedger(normalizedPlan);
  return mutateWorkflow((store, fence) => {
    const current = store.activeBlock;
    if (!current || current.id !== id)
      throw new Error("DowntimeWorkflowBlockNotFound");
    if (current.plan) {
      if (!persistedValuesEqual(current.plan, normalizedPlan)) {
        throw new Error("DowntimeWorkflowPlanImmutable");
      }
      return { store, result: current };
    }
    if (current.state !== "locked")
      throw new Error("DowntimeWorkflowPlanNotLocked");
    if (
      current.planningDraft &&
      (current.planningDraft.state === "needs-review" ||
        Object.values(current.planningDraft.rows ?? {}).some(
          (row) => row.state !== "completed",
        ))
    ) {
      throw new Error("DowntimeWorkflowPlanningDraftIncomplete");
    }
    const withPlan = {
      ...current,
      plan: normalizedPlan,
      operationLedger,
      ...(current.planningDraft
        ? {
            planningDraft: {
              ...current.planningDraft,
              state: "complete",
              updatedAt: options.at ?? currentTimestamp(),
            },
          }
        : {}),
    };
    store.activeBlock = transitionDowntimeWorkflowState(withPlan, "planned", {
      at: options.at ?? currentTimestamp(),
      by: options.by ?? fence.userId,
    });
    return { store, mapResult: (committed) => committed.activeBlock };
  });
}

/**
 * Guided downtime deliberately leaves outcome selection with the GM after a
 * roll. Before application begins, replace the saved plan only when it has
 * the identical operation ledger shape; this preserves recovery identity
 * while allowing the selected report/reward to change.
 */
export async function updateGuidedDowntimePlan(blockId, plan) {
  const id = toId(blockId);
  if (!id || !isPlainObject(plan)) {
    throw new Error("DowntimeGuidedPlanInvalid");
  }
  const normalizedPlan = sanitizeJson(plan);
  return mutateWorkflow((store, fence) => {
    const current = store.activeBlock;
    if (
      !current ||
      current.id !== id ||
      current.state !== "planned" ||
      current.mode !== "guided" ||
      !current.plan
    ) {
      throw new Error("DowntimeGuidedPlanNotEditable");
    }
    const currentIds = plannedOperations(current.plan)
      .map((operation) => operation.operationId)
      .sort();
    const nextIds = plannedOperations(normalizedPlan)
      .map((operation) => operation.operationId)
      .sort();
    if (!persistedValuesEqual(currentIds, nextIds)) {
      throw new Error("DowntimeGuidedPlanOperationMismatch");
    }
    if (
      Object.values(current.operationLedger ?? {}).some(
        (record) => record.state !== "pending",
      )
    ) {
      throw new Error("DowntimeGuidedPlanAlreadyApplying");
    }
    const next = normalizeDowntimeBlock({
      ...current,
      plan: normalizedPlan,
      updatedAt: currentTimestamp(),
      updatedBy: fence.userId,
    });
    if (!next) throw new Error("DowntimeGuidedPlanInvalid");
    store.activeBlock = next;
    return { store, mapResult: (committed) => committed.activeBlock };
  });
}

function assertLockedPlanningBlock(store, blockId) {
  const active = store.activeBlock;
  if (!active || active.id !== blockId) {
    throw new Error("DowntimeWorkflowBlockNotFound");
  }
  if (active.state !== "locked" || active.plan) {
    throw new Error("DowntimeWorkflowPlanningDraftClosed");
  }
  return active;
}

export async function initializeDowntimePlanningDraft(
  blockId,
  manifest,
  { at = null } = {},
) {
  const id = toId(blockId);
  const normalizedManifest = isPlainObject(manifest)
    ? sanitizeJson(manifest)
    : null;
  const checkedRows = Array.isArray(normalizedManifest?.checkedRows)
    ? normalizedManifest.checkedRows
    : null;
  if (!id || !normalizedManifest || !checkedRows) {
    throw new Error("DowntimeWorkflowPlanningManifestInvalid");
  }
  const rows = {};
  for (const raw of checkedRows) {
    const rowId = toId(raw?.rowId);
    const row = rowId
      ? normalizePlanningRoll({ ...raw, state: "pending" }, rowId)
      : null;
    if (!row || Object.hasOwn(rows, rowId)) {
      throw new Error("DowntimeWorkflowPlanningManifestInvalid");
    }
    rows[rowId] = row;
  }
  const createdAt = toTimestamp(at, currentTimestamp());
  const candidate = normalizeDowntimePlanningDraft({
    version: PLANNING_DRAFT_VERSION,
    state: checkedRows.length === 0 ? "complete" : "active",
    manifest: normalizedManifest,
    rows,
    createdAt,
    updatedAt: createdAt,
    reviewReason: null,
  });
  if (!candidate) throw new Error("DowntimeWorkflowPlanningManifestInvalid");

  return mutateWorkflow((store) => {
    const active = assertLockedPlanningBlock(store, id);
    if (active.planningDraft) {
      if (
        !persistedValuesEqual(active.planningDraft.manifest, candidate.manifest)
      ) {
        throw new Error("DowntimeWorkflowPlanningManifestMismatch");
      }
      return { store, result: active.planningDraft };
    }
    active.planningDraft = candidate;
    return {
      store,
      mapResult: (committed) => committed.activeBlock.planningDraft,
    };
  });
}

export async function claimDowntimePlanningRoll(
  blockId,
  rowId,
  { at = null } = {},
) {
  const id = toId(blockId);
  const row = toId(rowId);
  if (!id || !row) throw new Error("DowntimeWorkflowPlanningRollInvalid");
  return mutateWorkflow((store, fence) => {
    const active = assertLockedPlanningBlock(store, id);
    const draft = active.planningDraft;
    if (!draft || draft.state === "needs-review") {
      throw new Error("DowntimeWorkflowPlanningDraftNeedsReview");
    }
    const current = draft.rows[row];
    if (!current) throw new Error("DowntimeWorkflowPlanningRollNotFound");
    if (current.state === "completed") {
      return { store, result: { claimedNow: false, row: current } };
    }
    if (current.state === "in-flight") {
      throw new Error("DowntimeWorkflowPlanningRollOrphaned");
    }
    draft.rows[row] = {
      ...current,
      state: "in-flight",
      claimedBy: fence.userId,
      authorityEpoch: fence.authorityEpoch ?? null,
      startedAt: toTimestamp(at, currentTimestamp()),
      completedAt: 0,
      roll: null,
    };
    draft.updatedAt = toTimestamp(at, currentTimestamp());
    return {
      store,
      mapResult: (committed) => ({
        claimedNow: true,
        row: committed.activeBlock.planningDraft.rows[row],
      }),
    };
  });
}

export async function resolveDowntimePlanningRoll(
  blockId,
  rowId,
  roll,
  { at = null } = {},
) {
  const id = toId(blockId);
  const row = toId(rowId);
  const normalizedRoll = normalizePlanningRoll(
    {
      actorId: "placeholder",
      actionId: "placeholder",
      activityId: "placeholder",
      state: "completed",
      roll,
    },
    row || "placeholder",
  )?.roll;
  if (!id || !row || !normalizedRoll) {
    throw new Error("DowntimeWorkflowPlanningRollInvalid");
  }
  return mutateWorkflow((store, fence) => {
    const active = assertLockedPlanningBlock(store, id);
    const draft = active.planningDraft;
    if (!draft || draft.state === "needs-review") {
      throw new Error("DowntimeWorkflowPlanningDraftNeedsReview");
    }
    const current = draft.rows[row];
    if (!current) throw new Error("DowntimeWorkflowPlanningRollNotFound");
    if (current.state === "completed") {
      if (!persistedValuesEqual(current.roll, normalizedRoll)) {
        throw new Error("DowntimeWorkflowPlanningRollCollision");
      }
      return { store, result: current };
    }
    if (
      current.state !== "in-flight" ||
      current.claimedBy !== fence.userId ||
      (fence.live && current.authorityEpoch !== fence.authorityEpoch)
    ) {
      throw new Error("DowntimeWorkflowPlanningRollClaimLost");
    }
    const completedAt = toTimestamp(at, currentTimestamp());
    draft.rows[row] = {
      ...current,
      state: "completed",
      completedAt,
      roll: normalizedRoll,
    };
    draft.updatedAt = completedAt;
    if (
      Object.values(draft.rows).every((entry) => entry.state === "completed")
    ) {
      draft.state = "complete";
    }
    return {
      store,
      mapResult: (committed) => committed.activeBlock.planningDraft.rows[row],
    };
  });
}

export async function markDowntimePlanningDraftNeedsReview(
  blockId,
  reason,
  { at = null } = {},
) {
  const id = toId(blockId);
  if (!id) throw new Error("DowntimeWorkflowBlockIdInvalid");
  return mutateWorkflow((store) => {
    const active = assertLockedPlanningBlock(store, id);
    if (!active.planningDraft) {
      throw new Error("DowntimeWorkflowPlanningDraftMissing");
    }
    active.planningDraft.state = "needs-review";
    active.planningDraft.reviewReason =
      String(reason ?? "")
        .trim()
        .slice(0, 500) || "hidden-roll-interrupted";
    active.planningDraft.updatedAt = toTimestamp(at, currentTimestamp());
    return {
      store,
      mapResult: (committed) => committed.activeBlock.planningDraft,
    };
  });
}

export async function beginDowntimeApplication(blockId, options = {}) {
  const current = getActiveDowntimeBlock();
  if (current?.state === "needs-review") {
    const unresolved = Object.values(current.operationLedger).some((record) =>
      ["applying", "needs-review"].includes(record.state),
    );
    if (unresolved) throw new Error("DowntimeWorkflowRecoveryRequired");
  }
  return transitionActiveBlock(blockId, "applying", options);
}

export async function claimDowntimeOperation(
  blockId,
  operationId,
  { attemptId, at = null } = {},
) {
  const block = toId(blockId);
  const operation = toId(operationId);
  const attempt = toId(attemptId);
  if (!block || !operation || !attempt) {
    throw new Error("DowntimeWorkflowOperationClaimInvalid");
  }
  return mutateWorkflow((store, fence) => {
    const active = store.activeBlock;
    if (!active || active.id !== block)
      throw new Error("DowntimeWorkflowBlockNotFound");
    if (active.state !== "applying")
      throw new Error("DowntimeWorkflowNotApplying");
    const record = active.operationLedger[operation];
    if (!record) throw new Error("DowntimeWorkflowOperationNotFound");
    if (record.state === "applying") {
      if (record.attemptId !== attempt) {
        throw new Error("DowntimeWorkflowOperationAlreadyClaimed");
      }
      return { store, result: { claimedNow: false, record } };
    }
    if (OPERATION_TERMINAL_STATES.has(record.state)) {
      return { store, result: { claimedNow: false, record } };
    }
    if (!["pending", "verified-unapplied"].includes(record.state)) {
      throw new Error("DowntimeWorkflowOperationRecoveryRequired");
    }
    active.operationLedger[operation] = {
      ...record,
      state: "applying",
      attemptId: attempt,
      claimedBy: fence.userId,
      authorityEpoch: fence.authorityEpoch ?? store.authorityEpoch,
      startedAt: toTimestamp(at, currentTimestamp()),
      resolvedAt: 0,
      receipt: null,
      reason: null,
    };
    return {
      store,
      mapResult: (committed) => ({
        claimedNow: true,
        record: committed.activeBlock.operationLedger[operation],
      }),
    };
  });
}

export async function resolveDowntimeOperation(
  blockId,
  operationId,
  {
    state,
    attemptId = "",
    receipt = null,
    reason = "",
    at = null,
    recoveryToken = null,
  } = {},
) {
  const block = toId(blockId);
  const operation = toId(operationId);
  const nextState = String(state ?? "");
  if (!block || !operation || !OPERATION_STATES.has(nextState)) {
    throw new Error("DowntimeWorkflowOperationResolutionInvalid");
  }
  if (["pending", "applying"].includes(nextState)) {
    throw new Error("DowntimeWorkflowOperationResolutionInvalid");
  }
  if (nextState === "compensated") {
    throw new Error("DowntimeWorkflowOperationUseCompensationMethod");
  }
  const normalizedReceipt = isPlainObject(receipt)
    ? sanitizeJson(receipt)
    : null;
  return mutateWorkflow((store, fence) => {
    const active = store.activeBlock;
    if (!active || active.id !== block)
      throw new Error("DowntimeWorkflowBlockNotFound");
    if (!["applying", "needs-review"].includes(active.state)) {
      throw new Error("DowntimeWorkflowNotApplying");
    }
    const current = active.operationLedger[operation];
    if (!current) throw new Error("DowntimeWorkflowOperationNotFound");
    const expectedAttempt = toId(attemptId);
    if (
      current.state === "applying" &&
      (!expectedAttempt || current.attemptId !== expectedAttempt)
    ) {
      throw new Error("DowntimeWorkflowOperationClaimLost");
    }
    if (OPERATION_TERMINAL_STATES.has(current.state)) {
      const replay = {
        ...current,
        state: nextState,
        receipt: normalizedReceipt,
        reason:
          String(reason ?? "")
            .trim()
            .slice(0, 500) || null,
      };
      if (!persistedValuesEqual(current, replay)) {
        throw new Error("DowntimeWorkflowOperationReceiptCollision");
      }
      return { store, result: current };
    }
    if (nextState === "applied" && current.state !== "applying") {
      const recoveryRequested = normalizedReceipt?.recovered === true;
      const recoveryVerified = isVerifiedRecoveryAppliedResolution({
        active,
        current,
        operationId: operation,
        attemptId,
        receipt: normalizedReceipt,
        recoveryToken,
      });
      if (!recoveryVerified) {
        throw new Error(
          recoveryRequested
            ? "DowntimeWorkflowOperationRecoveryReceiptInvalid"
            : "DowntimeWorkflowOperationClaimRequired",
        );
      }
    }
    if (
      nextState === "verified-unapplied" &&
      !["applying", "needs-review"].includes(current.state)
    ) {
      throw new Error("DowntimeWorkflowOperationVerificationInvalid");
    }
    active.operationLedger[operation] = {
      ...current,
      state: nextState,
      claimedBy: current.claimedBy || fence.userId,
      resolvedAt: toTimestamp(at, currentTimestamp()),
      receipt: normalizedReceipt,
      reason:
        String(reason ?? "")
          .trim()
          .slice(0, 500) || null,
    };
    if (nextState === "verified-unapplied") {
      active.operationLedger[operation] = normalizeOperationRecord(
        active.operationLedger[operation],
        operation,
        current.actorId,
      );
    }
    return {
      store,
      mapResult: (committed) =>
        committed.activeBlock.operationLedger[operation],
    };
  });
}

/**
 * Reconcile an operation whose canonical read-back proves the immutable plan
 * was applied. The regular resolver validates this recovery-only receipt
 * against both review states and the planned operation summary.
 */
export function resolveRecoveredDowntimeOperation(
  blockId,
  operationId,
  { summary, at = null } = {},
) {
  return resolveDowntimeOperation(blockId, operationId, {
    state: "applied",
    receipt: { summary, recovered: true },
    at,
    recoveryToken: RECOVERED_OPERATION_RESOLUTION,
  });
}

/** Record a verified compensation without erasing the original write receipt. */
export async function compensateDowntimeOperation(
  blockId,
  operationId,
  { receipt, reason = "", at = null } = {},
) {
  const block = toId(blockId);
  const operation = toId(operationId);
  const compensationReceipt = isPlainObject(receipt)
    ? sanitizeJson(receipt)
    : null;
  if (!block || !operation || !compensationReceipt) {
    throw new Error("DowntimeWorkflowCompensationInvalid");
  }
  return mutateWorkflow((store) => {
    const active = store.activeBlock;
    if (!active || active.id !== block) {
      throw new Error("DowntimeWorkflowBlockNotFound");
    }
    if (!["applying", "needs-review"].includes(active.state)) {
      throw new Error("DowntimeWorkflowNotApplying");
    }
    const current = active.operationLedger[operation];
    if (!current) throw new Error("DowntimeWorkflowOperationNotFound");
    if (current.state === "compensated") {
      if (
        !persistedValuesEqual(current.compensationReceipt, compensationReceipt)
      ) {
        throw new Error("DowntimeWorkflowCompensationReceiptCollision");
      }
      return { store, result: current };
    }
    if (current.state !== "applied") {
      throw new Error("DowntimeWorkflowCompensationNotApplied");
    }
    active.operationLedger[operation] = {
      ...current,
      state: "compensated",
      compensatedAt: toTimestamp(at, currentTimestamp()),
      compensationReceipt,
      reason:
        String(reason ?? "")
          .trim()
          .slice(0, 500) || null,
    };
    return {
      store,
      mapResult: (committed) =>
        committed.activeBlock.operationLedger[operation],
    };
  });
}

export function downtimeOperationDisposition(block, operationId) {
  const operation =
    normalizeDowntimeBlock(block)?.operationLedger?.[toId(operationId)];
  if (!operation) return "unknown";
  if (OPERATION_TERMINAL_STATES.has(operation.state)) return "applied";
  if (["pending", "verified-unapplied"].includes(operation.state)) {
    return "unapplied";
  }
  return "uncertain";
}

export function listRetryableDowntimeOperations(block) {
  const normalized = normalizeDowntimeBlock(block);
  if (!normalized) return [];
  return plannedOperations(normalized.plan)
    .map(({ operationId }) => normalized.operationLedger[operationId])
    .filter((record) =>
      ["pending", "verified-unapplied"].includes(record?.state),
    )
    .map(clone);
}

export function markDowntimeNeedsReview(blockId, reason, options = {}) {
  return transitionActiveBlock(blockId, "needs-review", {
    ...options,
    reason,
  });
}

export async function completeDowntimeBlock(
  blockId,
  { result = null, at = null } = {},
) {
  const id = toId(blockId);
  if (!id) throw new Error("DowntimeWorkflowBlockIdInvalid");
  return mutateWorkflow((store, fence) => {
    const prior = store.history.find((entry) => entry.id === id);
    if (prior?.state === "completed") return { store, result: prior };
    const active = store.activeBlock;
    if (!active || active.id !== id)
      throw new Error("DowntimeWorkflowBlockNotFound");
    if (active.state !== "applying")
      throw new Error("DowntimeWorkflowNotApplying");
    const unfinished = Object.values(active.operationLedger).some(
      (record) => !OPERATION_TERMINAL_STATES.has(record.state),
    );
    if (unfinished) throw new Error("DowntimeWorkflowOperationsIncomplete");
    const withResult = {
      ...active,
      result: isPlainObject(result) ? sanitizeJson(result) : null,
    };
    const completed = transitionDowntimeWorkflowState(withResult, "completed", {
      at: toTimestamp(at, currentTimestamp()),
      by: fence.userId,
    });
    for (const [projectId, hours] of Object.entries(
      projectContributionsFromBlock(completed),
    )) {
      store.projectProgress[projectId] = nonNegativeInteger(
        (store.projectProgress[projectId] ?? 0) + hours,
      );
    }
    store.activeBlock = null;
    store.history = [...store.history, completed].slice(-MAX_HISTORY);
    return {
      store,
      mapResult: (committed) =>
        committed.history.find((entry) => entry.id === id),
    };
  });
}

export async function cancelDowntimeBlock(
  blockId,
  { reason = "", at = null } = {},
) {
  const id = toId(blockId);
  if (!id) throw new Error("DowntimeWorkflowBlockIdInvalid");
  return mutateWorkflow((store, fence) => {
    const prior = store.history.find((entry) => entry.id === id);
    if (prior?.state === "cancelled") return { store, result: prior };
    const active = store.activeBlock;
    if (!active || active.id !== id)
      throw new Error("DowntimeWorkflowBlockNotFound");
    const cancelled = transitionDowntimeWorkflowState(active, "cancelled", {
      at: toTimestamp(at, currentTimestamp()),
      by: fence.userId,
      reason,
    });
    store.activeBlock = null;
    store.history = [...store.history, cancelled].slice(-MAX_HISTORY);
    return {
      store,
      mapResult: (committed) =>
        committed.history.find((entry) => entry.id === id),
    };
  });
}

export function loadDowntimeConfig() {
  const replicas = readRawReplicas();
  const primary = replicas.primary;
  const rawCheckpoint = replicas.checkpoint;
  const checkpoint = parseRecoveryCheckpoint(rawCheckpoint);
  const base = selectRecoveryBase(
    primary,
    rawCheckpoint,
    captureAuthorityFence(),
  );
  const embedded = parsePersistedConfigCheckpointRecord(base?.configCheckpoint);
  const mirrored = persistedValuesEqual(base, checkpoint.workflow)
    ? parsePersistedConfigCheckpointRecord(checkpoint.config)
    : null;
  const accepted = embedded ?? mirrored;
  return clone(
    accepted?.current.value ??
      normalizeStandaloneDowntimeConfig(replicas.config),
  );
}

export async function saveDowntimeConfig(config) {
  const normalized = normalizeStoredDowntimeConfig(config);
  return enqueueWrite(async (fence) => {
    const ensured = await ensureEnvelopeForFence(fence);
    assertAuthorityFence(fence);
    const replicas = readRawReplicas();
    const expectedPrimary = replicas.primary;
    const expectedCheckpoint = replicas.checkpoint;
    const expectedConfig = replicas.config;
    const checkpointParts = parseRecoveryCheckpoint(expectedCheckpoint);
    if (
      !persistedValuesEqual(expectedPrimary, ensured) ||
      !persistedValuesEqual(checkpointParts.workflow, ensured) ||
      !isCurrentConfigCheckpointRecord(checkpointParts.config) ||
      !persistedValuesEqual(expectedConfig, checkpointParts.config.value)
    ) {
      throw new Error("DowntimeConfigStaleWrite");
    }
    if (persistedValuesEqual(expectedConfig, normalized)) {
      return clone(normalized);
    }

    const nextConfigCheckpoint = createConfigCheckpointRecord(
      normalized,
      fence,
      checkpointParts.config,
    );
    readRawReplicas();
    await setPrivateState(CONFIG_KEY, normalized, {
      beforeWrite: () => {
        const current = readRawReplicas();
        return (
          isAuthorityFenceCurrent(fence) &&
          persistedValuesEqual(current.primary, expectedPrimary) &&
          persistedValuesEqual(current.checkpoint, expectedCheckpoint) &&
          persistedValuesEqual(current.config, expectedConfig)
        );
      },
      afterWrite: () => {
        const current = readRawReplicas();
        return (
          isAuthorityFenceCurrent(fence) &&
          persistedValuesEqual(current.primary, expectedPrimary) &&
          persistedValuesEqual(current.checkpoint, expectedCheckpoint) &&
          persistedValuesEqual(current.config, normalized)
        );
      },
    });
    await commitEnvelope(ensured, {
      fence,
      expectedPrimary,
      expectedCheckpoint,
      expectedConfig: normalized,
      configCheckpoint: nextConfigCheckpoint,
    });
    const stored = loadDowntimeConfig();
    if (!persistedValuesEqual(stored, normalized)) {
      throw new Error("DowntimeConfigWriteVerificationFailed");
    }
    return stored;
  });
}

/**
 * Mutate the private downtime configuration from the freshest checkpoint while
 * holding the workflow write queue. This prevents independent Heat, stolen
 * goods, and sharpening-lifecycle writes from replacing one another with a
 * stale full-config snapshot.
 */
export async function updateDowntimeConfig(mutation) {
  if (typeof mutation !== "function") {
    throw new Error("DowntimeConfigMutationInvalid");
  }
  return enqueueWrite(async (fence) => {
    const ensured = await ensureEnvelopeForFence(fence);
    assertAuthorityFence(fence);
    const replicas = readRawReplicas();
    const expectedPrimary = replicas.primary;
    const expectedCheckpoint = replicas.checkpoint;
    const expectedConfig = replicas.config;
    const checkpointParts = parseRecoveryCheckpoint(expectedCheckpoint);
    if (
      !persistedValuesEqual(expectedPrimary, ensured) ||
      !persistedValuesEqual(checkpointParts.workflow, ensured) ||
      !isCurrentConfigCheckpointRecord(checkpointParts.config) ||
      !persistedValuesEqual(expectedConfig, checkpointParts.config.value)
    ) {
      throw new Error("DowntimeConfigStaleWrite");
    }
    const current = normalizeStoredDowntimeConfig(checkpointParts.config.value);
    const candidate = await mutation(clone(current));
    const normalized = normalizeStoredDowntimeConfig(candidate ?? current);
    if (persistedValuesEqual(expectedConfig, normalized)) {
      return clone(normalized);
    }

    const nextConfigCheckpoint = createConfigCheckpointRecord(
      normalized,
      fence,
      checkpointParts.config,
    );
    readRawReplicas();
    await setPrivateState(CONFIG_KEY, normalized, {
      beforeWrite: () => {
        const current = readRawReplicas();
        return (
          isAuthorityFenceCurrent(fence) &&
          persistedValuesEqual(current.primary, expectedPrimary) &&
          persistedValuesEqual(current.checkpoint, expectedCheckpoint) &&
          persistedValuesEqual(current.config, expectedConfig)
        );
      },
      afterWrite: () => {
        const current = readRawReplicas();
        return (
          isAuthorityFenceCurrent(fence) &&
          persistedValuesEqual(current.primary, expectedPrimary) &&
          persistedValuesEqual(current.checkpoint, expectedCheckpoint) &&
          persistedValuesEqual(current.config, normalized)
        );
      },
    });
    await commitEnvelope(ensured, {
      fence,
      expectedPrimary,
      expectedCheckpoint,
      expectedConfig: normalized,
      configCheckpoint: nextConfigCheckpoint,
    });
    const stored = loadDowntimeConfig();
    if (!persistedValuesEqual(stored, normalized)) {
      throw new Error("DowntimeConfigWriteVerificationFailed");
    }
    return stored;
  });
}

export function isDowntimeWorkflowReady() {
  try {
    const fence = captureAuthorityFence();
    if (!isAuthorityFenceCurrent(fence)) return false;
    const replicas = readRawReplicas();
    const primary = replicas.primary;
    const checkpoint = parseRecoveryCheckpoint(replicas.checkpoint);
    return Boolean(
      isPersistedEnvelope(primary) &&
      persistedValuesEqual(primary, checkpoint.workflow) &&
      isCurrentConfigCheckpointRecord(checkpoint.config) &&
      persistedValuesEqual(primary.configCheckpoint, checkpoint.config) &&
      persistedValuesEqual(replicas.config, checkpoint.config.value) &&
      (!fence.live ||
        (primary.authorityId === fence.userId &&
          primary.authorityEpoch === fence.authorityEpoch &&
          checkpoint.config.authorityId === fence.userId &&
          checkpoint.config.authorityEpoch === fence.authorityEpoch)),
    );
  } catch {
    return false;
  }
}

export function registerDowntimeWorkflowObserver() {
  if (observerRegistered || typeof globalThis.Hooks?.on !== "function") return;
  observerRegistered = true;
  const reconcile = () => {
    observeDowntimeWorkflowAuthorityTransition();
    if (!isAuthoritativeGM()) return;
    void (async () => {
      if ((await initializePrivateState()) !== true) return;
      if (!isAuthoritativeGM()) return;
      await ensureDowntimeWorkflowAuthority();
    })().catch((error) => {
      const message = String(error?.message ?? "");
      if (
        message.includes("StoreUnavailable") ||
        message.includes("PrivateStateUnavailable") ||
        message.includes("AuthorityChanged")
      ) {
        return;
      }
      console.error(
        `${MODULE_ID} | downtime workflow reconciliation failed`,
        error,
      );
    });
  };
  const privateHookId = onPrivateStateChanged((payload) => {
    if (
      payload?.keys?.some((key) =>
        [CONFIG_KEY, STORE_KEY, CHECKPOINT_KEY].includes(key),
      )
    ) {
      reconcile();
    }
  });
  if (privateHookId !== null) {
    observerHookIds.push([PRIVATE_STATE_CHANGED_HOOK, privateHookId]);
  }
  for (const event of ["updateUser", "userConnected"]) {
    const hookId = globalThis.Hooks.on(event, reconcile);
    if (hookId !== null) observerHookIds.push([event, hookId]);
  }
}

export function resetDowntimeWorkflowStoreForTests() {
  for (const [event, hookId] of observerHookIds.splice(0)) {
    globalThis.Hooks?.off?.(event, hookId);
  }
  writeQueue = Promise.resolve();
  authorityObservationStarted = false;
  observedAuthorityId = null;
  observedAuthorityEpoch = null;
  authorityGeneration = 0;
  highestObservedRevision = -1;
  lastAcceptedEnvelope = null;
  observerRegistered = false;
  retiredAuthorityEpochs.clear();
}
