/**
 * Pure resource run-state v5 envelope.
 *
 * This module deliberately performs no Foundry reads or writes. It is an
 * additive codec/checkpoint layer for the durable operation ledger; callers
 * remain responsible for compare-and-swap persistence around every returned
 * state.
 */

import {
  RESOURCE_RUN_HISTORY_LIMIT,
  appendRecentRunReceipt,
  buildInterruptedRunReceipt,
  normalizeForageAssignments,
  normalizeForageDestination,
  normalizeRecentRuns,
  normalizeRunActorSnapshots,
  normalizeRunEnvironmentSnapshot,
  normalizeRunInitiatorSnapshot,
  normalizeRunReceipt,
} from "./history.js";
import {
  ResourceOperationLedgerError,
  adoptResourceOperationAuthority,
  canTransitionResourceOperation,
  legacyActiveUpkeepToResourceOperation,
  markResourceDeliveryDelivered,
  normalizeResourceOperation,
  resourceOperationGuardMatches,
} from "./operation-ledger.js";
import { persistedValuesEqual } from "../utils/persisted-data.js";

export const RESOURCE_RUN_STATE_V5_VERSION = 5;
export const RESOURCE_OPERATION_OUTBOX_LIMIT_V5 = 20;

const STATE_KEYS = Object.freeze([
  "version",
  "revision",
  "authorityId",
  "authorityEpoch",
  "lastSeenDay",
  "currentEnvironmentId",
  "lastUpkeepResult",
  "activeOperation",
  "operationOutbox",
  "recentRuns",
]);
const V4_STATE_KEYS = Object.freeze([
  "version",
  "revision",
  "authorityId",
  "authorityEpoch",
  "lastSeenDay",
  "currentEnvironmentId",
  "lastUpkeepResult",
  "activeUpkeep",
  "recentRuns",
]);
const V4_ACTIVE_KEYS = Object.freeze([
  "runId",
  "trigger",
  "day",
  "days",
  "startedAt",
  "claimedAt",
  "authorityId",
  "authorityEpoch",
  "leadershipGeneration",
  "environment",
  "initiator",
  "actors",
  "forageTarget",
  "forageAssignments",
  "forageDestination",
]);
const OPERATION_IDENTITY_FIELDS = Object.freeze([
  "version",
  "operationId",
  "runId",
  "kind",
  "trigger",
  "context",
  "day",
  "days",
  "environment",
  "initiator",
  "actors",
]);
const FORAGE_TARGETS = new Set(["food-water", "food", "water"]);
const TRIGGERS = new Set(["manual", "calendar", "forage"]);
const REPORT_DELIVERY_FIELD = "chatDelivery";
const MAX_ID_LENGTH = 256;
const MAX_JSON_DEPTH = 20;
const MAX_JSON_NODES = 50_000;
const MAX_JSON_STRING_CHARS = 1_000_000;
const MAX_JSON_KEY_LENGTH = 1024;
const MAX_JSON_KEY_CHARS = 250_000;
const MAX_JSON_COLLECTION_SIZE = 5000;
const MAX_JSON_STRING_LENGTH = 65_536;

export class ResourceRunStateV5Error extends Error {
  constructor(code, message, path = "", { status = null, cause } = {}) {
    super(message, cause ? { cause } : undefined);
    this.name = "ResourceRunStateV5Error";
    this.code = code;
    this.path = path;
    this.retryable = false;
    this.zeroWrite = true;
    if (status) this.persistedVersionStatus = deepFreeze(mutableClone(status));
  }
}

/** Build a canonical empty v5 envelope without activating production use. */
export function createEmptyResourceRunStateV5({
  revision = 0,
  authorityId,
  authorityEpoch,
  lastSeenDay = null,
  currentEnvironmentId = null,
  lastUpkeepResult = null,
  recentRuns = [],
} = {}) {
  return normalizeResourceRunStateV5({
    version: RESOURCE_RUN_STATE_V5_VERSION,
    revision,
    authorityId,
    authorityEpoch,
    lastSeenDay,
    currentEnvironmentId,
    lastUpkeepResult,
    activeOperation: null,
    operationOutbox: [],
    recentRuns,
  });
}

/** Strict parser for the complete physical v5 state. */
export function normalizeResourceRunStateV5(raw) {
  assertPlainObject(raw, "state");
  assertExactKeys(raw, STATE_KEYS, "state");
  assertV5Version(raw.version, "state.version");

  const revision = safeInteger(raw.revision, "state.revision", { min: 0 });
  const authorityId = strictId(raw.authorityId, "state.authorityId");
  const authorityEpoch = strictId(raw.authorityEpoch, "state.authorityEpoch");
  const lastSeenDay = nullableSafeInteger(
    raw.lastSeenDay,
    "state.lastSeenDay",
    { min: -1_000_000_000, max: 1_000_000_000 },
  );
  const currentEnvironmentId = nullableId(
    raw.currentEnvironmentId,
    "state.currentEnvironmentId",
  );
  const lastUpkeepResult = nullableJsonObject(
    raw.lastUpkeepResult,
    "state.lastUpkeepResult",
  );
  const activeOperation =
    raw.activeOperation === null
      ? null
      : normalizeNestedOperation(raw.activeOperation, "state.activeOperation");
  if (activeOperation?.phase === "terminal") {
    fail(
      "RESOURCE_RUN_STATE_V5_MALFORMED",
      "activeOperation must be nonterminal",
      "state.activeOperation.phase",
    );
  }

  assertDenseArray(
    raw.operationOutbox,
    "state.operationOutbox",
    RESOURCE_OPERATION_OUTBOX_LIMIT_V5,
  );
  const operationOutbox = raw.operationOutbox.map((entry, index) => {
    const path = `state.operationOutbox[${index}]`;
    const operation = normalizeNestedOperation(entry, path);
    if (operation.phase !== "terminal") {
      fail(
        "RESOURCE_RUN_STATE_V5_MALFORMED",
        "operationOutbox accepts terminal operations only",
        `${path}.phase`,
      );
    }
    if (
      !operation.outbox.entries.some((delivery) => delivery.state === "pending")
    ) {
      fail(
        "RESOURCE_RUN_STATE_V5_MALFORMED",
        "Fully delivered operations must be compacted from operationOutbox",
        `${path}.outbox`,
      );
    }
    const receipt = assertTerminalOperationReceipt(
      operation,
      `${path}.receipt`,
    );
    const report = assertTerminalOperationReport(operation, `${path}.report`);
    assertTerminalOutcomeStatus(report, receipt, path);
    return operation;
  });

  assertDenseArray(
    raw.recentRuns,
    "state.recentRuns",
    RESOURCE_RUN_HISTORY_LIMIT,
  );
  const clonedRecentRuns = cloneJson(
    raw.recentRuns,
    "state.recentRuns",
    createJsonBudget(),
  );
  const recentRuns = normalizeRecentRuns(clonedRecentRuns);
  if (!persistedValuesEqual(raw.recentRuns, recentRuns)) {
    fail(
      "RESOURCE_RUN_STATE_V5_MALFORMED",
      "recentRuns is not an exact canonical history",
      "state.recentRuns",
    );
  }
  if (activeOperation && activeOperation.receipt !== null) {
    assertReviewOperationReceipt(
      activeOperation,
      activeOperation.receipt,
      "state.activeOperation.receipt",
    );
  }

  const operationIds = new Set();
  const runIds = new Set();
  const deliveryIds = new Set();
  const registerOperation = (operation, path) => {
    if (
      operationIds.has(operation.operationId) ||
      runIds.has(operation.runId)
    ) {
      fail(
        "RESOURCE_RUN_STATE_V5_MALFORMED",
        "Operation and run identities must be unique",
        path,
      );
    }
    operationIds.add(operation.operationId);
    runIds.add(operation.runId);
    for (const delivery of operation.outbox.entries) {
      if (deliveryIds.has(delivery.deliveryId)) {
        fail(
          "RESOURCE_RUN_STATE_V5_MALFORMED",
          "Delivery identities must be unique across operationOutbox",
          `${path}.outbox`,
        );
      }
      deliveryIds.add(delivery.deliveryId);
    }
  };
  if (activeOperation)
    registerOperation(activeOperation, "state.activeOperation");
  operationOutbox.forEach((operation, index) =>
    registerOperation(operation, `state.operationOutbox[${index}]`),
  );

  const receiptByRunId = new Map(
    recentRuns.map((receipt) => [receipt.runId, receipt]),
  );
  if (activeOperation && receiptByRunId.has(activeOperation.runId)) {
    fail(
      "RESOURCE_RUN_STATE_V5_MALFORMED",
      "An active operation cannot already be archived",
      "state.activeOperation.runId",
    );
  }
  operationOutbox.forEach((operation, index) => {
    if (
      !persistedValuesEqual(
        receiptByRunId.get(operation.runId),
        operation.receipt,
      )
    ) {
      fail(
        "RESOURCE_RUN_STATE_V5_MALFORMED",
        "Every terminal backlog record requires its exact archived receipt",
        `state.operationOutbox[${index}].receipt`,
      );
    }
  });
  const backlogRunIds = new Set(
    operationOutbox.map((operation) => operation.runId),
  );
  const expectedBacklogOrder = recentRuns
    .filter((receipt) => backlogRunIds.has(receipt.runId))
    .map((receipt) => receipt.runId)
    .reverse();
  if (
    !persistedValuesEqual(
      operationOutbox.map((operation) => operation.runId),
      expectedBacklogOrder,
    )
  ) {
    fail(
      "RESOURCE_RUN_STATE_V5_MALFORMED",
      "operationOutbox order must match FIFO completion order in recentRuns",
      "state.operationOutbox",
    );
  }
  if (
    activeOperation &&
    activeOperation.phase !== "needs-review" &&
    operationOutbox.length >= RESOURCE_OPERATION_OUTBOX_LIMIT_V5
  ) {
    fail(
      "RESOURCE_RUN_STATE_V5_MALFORMED",
      "An active resumable operation requires a reserved outbox slot",
      "state.operationOutbox",
    );
  }

  return deepFreeze({
    version: RESOURCE_RUN_STATE_V5_VERSION,
    revision,
    authorityId,
    authorityEpoch,
    lastSeenDay,
    currentEnvironmentId,
    lastUpkeepResult,
    activeOperation,
    operationOutbox,
    recentRuns,
  });
}

/** Strict, deterministic conversion from the current v4 physical envelope. */
export function migrateResourceRunStateV4ToV5(raw) {
  const legacy = normalizeResourceRunStateV4(raw);
  const activeOperation = legacy.activeUpkeep
    ? legacyActiveUpkeepToResourceOperation(legacy.activeUpkeep)
    : null;
  return normalizeResourceRunStateV5({
    version: RESOURCE_RUN_STATE_V5_VERSION,
    revision: legacy.revision,
    authorityId: legacy.authorityId,
    authorityEpoch: legacy.authorityEpoch,
    lastSeenDay: legacy.lastSeenDay,
    currentEnvironmentId: legacy.currentEnvironmentId,
    lastUpkeepResult: legacy.lastUpkeepResult,
    activeOperation,
    operationOutbox: [],
    recentRuns: legacy.recentRuns,
  });
}

/**
 * Sanitize skipped historical envelopes (missing/v0-v3) into v5. These older
 * schemas were permissive, so unknown fields are dropped. Only an exact known
 * activeUpkeep shape is quarantined; ambiguous legacy fields never resume.
 */
export function migrateLegacyResourceRunStateToV5(raw, options = {}) {
  assertPlainObject(raw, "state");
  const version = readPersistedVersion(raw);
  if (version !== null && version > 3) {
    fail(
      "RESOURCE_RUN_STATE_V5_UNSUPPORTED_LEGACY",
      "Historical migration accepts only missing/v0-v3 state",
      "state.version",
    );
  }
  for (const key of ["activeOperation", "operationOutbox"]) {
    if (Object.hasOwn(raw, key)) {
      fail(
        "RESOURCE_RUN_STATE_V5_LEGACY_CORRUPT",
        `Historical state cannot safely interpret reserved field ${key}`,
        `state.${key}`,
      );
    }
  }
  const authorityId =
    cleanHistoricalId(readDataProperty(raw, "authorityId")) ??
    cleanHistoricalId(options.authorityId) ??
    "legacy-unrecorded-authority";
  const authorityEpoch =
    cleanHistoricalId(readDataProperty(raw, "authorityEpoch")) ??
    cleanHistoricalId(options.authorityEpoch) ??
    "legacy-unrecorded-epoch";
  const recentRuns = sanitizeHistoricalHistory(
    readDataProperty(raw, "recentRuns"),
  );
  const activeUpkeep = recognizeHistoricalActiveUpkeep(
    readDataProperty(raw, "activeUpkeep"),
  );
  const activeOperation = activeUpkeep
    ? legacyActiveUpkeepToResourceOperation(activeUpkeep)
    : null;
  const rawLastSeenDay = historicalFiniteNumber(
    readDataProperty(raw, "lastSeenDay"),
  );
  const lastSeenDay =
    rawLastSeenDay === null
      ? null
      : Math.max(
          -1_000_000_000,
          Math.min(1_000_000_000, Math.floor(rawLastSeenDay)),
        );
  const rawRevision = historicalFiniteNumber(readDataProperty(raw, "revision"));
  const revision =
    Number.isSafeInteger(rawRevision) && rawRevision >= 0 ? rawRevision : 0;
  return normalizeResourceRunStateV5({
    version: RESOURCE_RUN_STATE_V5_VERSION,
    revision,
    authorityId,
    authorityEpoch,
    lastSeenDay,
    currentEnvironmentId:
      cleanHistoricalId(readDataProperty(raw, "currentEnvironmentId")) ?? null,
    lastUpkeepResult: sanitizeHistoricalResult(
      readDataProperty(raw, "lastUpkeepResult"),
    ),
    activeOperation,
    operationOutbox: [],
    recentRuns,
  });
}

/**
 * Persistence-boundary decision. A blocked result intentionally contains no
 * candidate state, so same-version corruption and future data are zero-write.
 */
export function prepareResourceRunStateV5(raw, options = {}) {
  try {
    const version = readPersistedVersion(raw);
    if (version === RESOURCE_RUN_STATE_V5_VERSION) {
      return decision("none", {
        writeRequired: false,
        zeroWrite: false,
        state: normalizeResourceRunStateV5(raw),
      });
    }
    if (version === 4) {
      return decision("migrate", {
        writeRequired: true,
        zeroWrite: false,
        state: migrateResourceRunStateV4ToV5(raw),
      });
    }
    if (version === null || version <= 3) {
      return decision("migrate", {
        writeRequired: true,
        zeroWrite: false,
        state: migrateLegacyResourceRunStateToV5(raw, options),
      });
    }
    if (version > RESOURCE_RUN_STATE_V5_VERSION) {
      futureVersion(version, "state.version");
    }
    fail(
      "RESOURCE_RUN_STATE_V5_UNSUPPORTED_LEGACY",
      "Only exact v4 state can be migrated to v5",
      "state.version",
      versionStatus("unsupported-legacy", version),
    );
  } catch (error) {
    const normalized = asStateError(error);
    return decision("blocked", {
      writeRequired: false,
      zeroWrite: true,
      state: null,
      error: {
        code: normalized.code,
        message: normalized.message,
        path: normalized.path,
        retryable: false,
        persistedVersionStatus: normalized.persistedVersionStatus ?? null,
      },
    });
  }
}

/** Validate claim capacity and identity without changing state. */
export function preflightResourceOperationClaimV5(state, operation) {
  const current = normalizeResourceRunStateV5(state);
  const candidate = normalizeNestedOperation(operation, "operation");
  if (candidate.phase !== "prepared") {
    conflict(
      "New claims must begin with a prepared operation",
      "operation.phase",
    );
  }
  if (current.activeOperation) {
    conflict(
      "Another resource operation is already active",
      "state.activeOperation",
    );
  }
  if (current.operationOutbox.length >= RESOURCE_OPERATION_OUTBOX_LIMIT_V5) {
    fail(
      "RESOURCE_RUN_STATE_V5_OUTBOX_FULL",
      "Terminal delivery backlog is full",
      "state.operationOutbox",
    );
  }
  assertHistoryCapacityForNewReceipt(current, "state.recentRuns");
  assertOperationAuthority(
    candidate,
    current.authorityId,
    current.authorityEpoch,
  );
  assertOperationIdentityAvailable(current, candidate);
  if (
    candidate.trigger === "calendar" &&
    current.lastSeenDay !== null &&
    candidate.day <= current.lastSeenDay
  ) {
    conflict(
      "Calendar claims must reserve a day after lastSeenDay",
      "operation.day",
    );
  }
  return decision("claim", {
    operationId: candidate.operationId,
    runId: candidate.runId,
    reservedDay: candidate.trigger === "calendar" ? candidate.day : null,
  });
}

/** Atomically install a prepared operation and reserve its calendar day. */
export function claimResourceOperationV5(state, operation, options = {}) {
  const current = normalizeResourceRunStateV5(state);
  const candidate = normalizeNestedOperation(operation, "operation");
  preflightResourceOperationClaimV5(current, candidate);
  return replaceState(current, {
    revision: nextRevision(current, options.revision),
    lastSeenDay:
      candidate.trigger === "calendar" ? candidate.day : current.lastSeenDay,
    activeOperation: candidate,
  });
}

/**
 * Immediate pre-Actor-write fence. Production callers must load canonical
 * state immediately before each write and pass the captured run guard here.
 */
export function assertResourceOperationCurrentV5(state, runId, guard) {
  const current = normalizeResourceRunStateV5(state);
  const expectedRunId = strictId(runId, "runId");
  const operation = current.activeOperation;
  if (
    !operation ||
    operation.runId !== expectedRunId ||
    operation.phase !== "applying" ||
    operation.guard.authorityId !== current.authorityId ||
    operation.guard.authorityEpoch !== current.authorityEpoch ||
    !resourceOperationGuardMatches(operation, guard)
  ) {
    fail(
      "RESOURCE_RUN_STATE_V5_FENCE_LOST",
      "The applying operation is no longer current for this authority guard",
      "state.activeOperation",
    );
  }
  return operation;
}

/** Persist a nonterminal domain checkpoint, including active authority adoption. */
export function checkpointActiveResourceOperationV5(
  state,
  operation,
  options = {},
) {
  const current = normalizeResourceRunStateV5(state);
  const previous = current.activeOperation;
  if (!previous)
    conflict("No active operation exists", "state.activeOperation");
  const candidate = normalizeNestedOperation(operation, "operation");
  if (candidate.phase === "terminal") {
    conflict("Terminal operations must use completion", "operation.phase");
  }
  assertSameOperation(previous, candidate);
  const checkpoint = assertActiveCheckpoint(previous, candidate);
  const authorityId = strictId(
    options.authorityId ?? current.authorityId,
    "options.authorityId",
  );
  const authorityEpoch = strictId(
    options.authorityEpoch ?? current.authorityEpoch,
    "options.authorityEpoch",
  );
  if (
    checkpoint !== "authority" &&
    (authorityId !== current.authorityId ||
      authorityEpoch !== current.authorityEpoch)
  ) {
    fail(
      "RESOURCE_RUN_STATE_V5_FENCE_LOST",
      "Only a validated authority adoption may change the state authority",
      "options.authorityId",
    );
  }
  assertOperationAuthority(candidate, authorityId, authorityEpoch);
  if (
    checkpoint === "noop" &&
    authorityId === current.authorityId &&
    authorityEpoch === current.authorityEpoch
  ) {
    return current;
  }
  return replaceState(current, {
    revision: nextRevision(current, options.revision),
    authorityId,
    authorityEpoch,
    activeOperation: candidate,
  });
}

/** Persist a terminal backlog checkpoint, including terminal authority adoption. */
export function checkpointOutboxResourceOperationV5(
  state,
  operation,
  options = {},
) {
  const current = normalizeResourceRunStateV5(state);
  const candidate = normalizeNestedOperation(operation, "operation");
  if (candidate.phase !== "terminal") {
    conflict("Outbox checkpoints must remain terminal", "operation.phase");
  }
  const index = current.operationOutbox.findIndex(
    (entry) => entry.operationId === candidate.operationId,
  );
  if (index < 0)
    conflict(
      "Terminal operation is not in the backlog",
      "operation.operationId",
    );
  const previous = current.operationOutbox[index];
  assertSameOperation(previous, candidate);
  if (persistedValuesEqual(previous, candidate)) return current;
  assertTerminalAuthorityCheckpoint(previous, candidate);
  const authorityId = strictId(
    options.authorityId ?? current.authorityId,
    "options.authorityId",
  );
  const authorityEpoch = strictId(
    options.authorityEpoch ?? current.authorityEpoch,
    "options.authorityEpoch",
  );
  assertOperationAuthority(candidate, authorityId, authorityEpoch);
  const operationOutbox = [...current.operationOutbox];
  operationOutbox[index] = candidate;
  return replaceState(current, {
    revision: nextRevision(current, options.revision),
    authorityId,
    authorityEpoch,
    operationOutbox,
  });
}

/** Rebind either an active record or a pending terminal record through the domain API. */
export function adoptResourceOperationAuthorityV5(
  state,
  {
    location,
    operationId,
    runId,
    nextGuard,
    contextSnapshot,
    observations,
    at,
    revision,
  } = {},
) {
  const current = normalizeResourceRunStateV5(state);
  const target = findExactOperation(current, location, operationId, runId);
  const adopted = adoptResourceOperationAuthority(target, nextGuard, {
    contextSnapshot,
    observations,
    at,
  });
  if (persistedValuesEqual(target, adopted)) return current;
  const options = {
    revision,
    authorityId: adopted.guard.authorityId,
    authorityEpoch: adopted.guard.authorityEpoch,
  };
  return location === "active"
    ? checkpointActiveResourceOperationV5(current, adopted, options)
    : checkpointOutboxResourceOperationV5(current, adopted, options);
}

/** Validate the exact atomic terminal move without changing state. */
export function preflightResourceOperationCompletionV5(
  state,
  terminalOperation,
) {
  const current = normalizeResourceRunStateV5(state);
  const previous = current.activeOperation;
  if (!previous)
    conflict("No active operation exists", "state.activeOperation");
  const terminal = normalizeNestedOperation(
    terminalOperation,
    "terminalOperation",
  );
  if (terminal.phase !== "terminal") {
    conflict(
      "Completion requires a terminal ledger record",
      "terminalOperation.phase",
    );
  }
  assertSameOperation(previous, terminal);
  if (!canTransitionResourceOperation(previous.phase, "terminal")) {
    conflict("Active phase cannot complete", "state.activeOperation.phase");
  }
  assertTerminalTransition(previous, terminal);
  assertOperationAuthority(
    terminal,
    current.authorityId,
    current.authorityEpoch,
  );
  if (current.operationOutbox.length >= RESOURCE_OPERATION_OUTBOX_LIMIT_V5) {
    fail(
      "RESOURCE_RUN_STATE_V5_OUTBOX_FULL",
      "Terminal delivery backlog is full",
      "state.operationOutbox",
    );
  }
  assertHistoryCapacityForNewReceipt(current, "state.recentRuns");
  const receipt = assertTerminalOperationReceipt(
    terminal,
    "terminalOperation.receipt",
  );
  const report = assertTerminalOperationReport(
    terminal,
    "terminalOperation.report",
  );
  assertTerminalOutcomeStatus(report, receipt, "terminalOperation");
  if (!terminal.outbox.entries.some((entry) => entry.state === "pending")) {
    conflict(
      "Completion requires pending terminal deliveries",
      "terminalOperation.outbox",
    );
  }
  return decision("complete", {
    operationId: terminal.operationId,
    runId: terminal.runId,
    pendingDeliveryIds: terminal.outbox.entries
      .filter((entry) => entry.state === "pending")
      .map((entry) => entry.deliveryId),
  });
}

/** Append receipt + terminal backlog and clear active in one immutable state. */
export function completeResourceOperationV5(
  state,
  terminalOperation,
  options = {},
) {
  const current = normalizeResourceRunStateV5(state);
  const terminal = normalizeNestedOperation(
    terminalOperation,
    "terminalOperation",
  );
  preflightResourceOperationCompletionV5(current, terminal);
  if (
    options.operationId !== undefined &&
    strictString(
      options.operationId,
      "options.operationId",
      MAX_JSON_STRING_LENGTH,
    ) !== terminal.operationId
  ) {
    conflict(
      "Completion operationId does not match the terminal record",
      "options.operationId",
    );
  }
  if (
    options.runId !== undefined &&
    strictId(options.runId, "options.runId") !== terminal.runId
  ) {
    conflict(
      "Completion runId does not match the terminal record",
      "options.runId",
    );
  }
  if (
    options.guard !== undefined &&
    !resourceOperationGuardMatches(terminal, options.guard)
  ) {
    fail(
      "RESOURCE_RUN_STATE_V5_FENCE_LOST",
      "Completion guard does not match the terminal record",
      "options.guard",
    );
  }
  if (
    options.at !== undefined &&
    safeTimestamp(options.at, "options.at") !== terminal.timestamps.terminalAt
  ) {
    conflict(
      "Completion time does not match the terminal checkpoint",
      "options.at",
    );
  }
  if (
    options.receipt !== undefined &&
    !persistedValuesEqual(
      assertCanonicalReceipt(
        options.receipt,
        terminal.runId,
        "options.receipt",
      ),
      terminal.receipt,
    )
  ) {
    conflict(
      "Completion receipt does not match the terminal record",
      "options.receipt",
    );
  }
  const persistResult = options.persistResult !== false;
  const expectedResult = terminalResultFromReport(terminal.report);
  if (
    options.result !== undefined &&
    !persistedValuesEqual(
      nullableJsonObject(options.result, "options.result"),
      expectedResult,
    )
  ) {
    conflict(
      "Completion result does not match the terminal report",
      "options.result",
    );
  }
  return replaceState(current, {
    revision: nextRevision(current, options.revision),
    lastUpkeepResult: persistResult ? expectedResult : current.lastUpkeepResult,
    activeOperation: null,
    operationOutbox: [...current.operationOutbox, terminal],
    recentRuns: appendRecentRunReceipt(current.recentRuns, terminal.receipt),
  });
}

/** Full pending terminal records in authoritative FIFO completion order. */
export function listPendingResourceOperationsV5(state) {
  return normalizeResourceRunStateV5(state).operationOutbox;
}

/** Ordered pending deliveries with immutable operation identity and guard. */
export function listPendingResourceOperationDeliveriesV5(state) {
  const current = normalizeResourceRunStateV5(state);
  return deepFreeze(
    current.operationOutbox.flatMap((operation, operationIndex) =>
      operation.outbox.entries
        .map((delivery, deliveryIndex) =>
          delivery.state === "pending"
            ? {
                operationIndex,
                deliveryIndex,
                operationId: operation.operationId,
                runId: operation.runId,
                guard: operation.guard,
                delivery,
              }
            : null,
        )
        .filter(Boolean),
    ),
  );
}

/** Confirm the FIFO head delivery and compact its record after the final ACK. */
export function confirmResourceOperationDeliveryV5(
  state,
  {
    operationId,
    runId,
    deliveryId,
    guard,
    at,
    confirmed,
    updatedRecord,
    revision,
  } = {},
) {
  const current = normalizeResourceRunStateV5(state);
  const head = current.operationOutbox[0];
  assertExactOperationIdentity(
    head,
    operationId,
    runId,
    "state.operationOutbox[0]",
  );
  assertOperationAuthority(head, current.authorityId, current.authorityEpoch);
  const expectedDeliveryId = strictString(
    deliveryId,
    "deliveryId",
    MAX_JSON_STRING_LENGTH,
  );
  const delivery = head.outbox.entries.find(
    (entry) => entry.deliveryId === expectedDeliveryId,
  );
  if (!delivery)
    conflict("Delivery does not belong to the FIFO head", "deliveryId");
  if (delivery.state === "delivered") return current;
  const firstPending = head.outbox.entries.find(
    (entry) => entry.state === "pending",
  );
  if (firstPending?.deliveryId !== expectedDeliveryId) {
    conflict("Deliveries must be confirmed in FIFO order", "deliveryId");
  }
  const suppliedUpdate =
    updatedRecord === undefined
      ? null
      : normalizeNestedOperation(updatedRecord, "updatedRecord");
  const suppliedDelivery = suppliedUpdate?.outbox.entries.find(
    (entry) => entry.deliveryId === expectedDeliveryId,
  );
  if (
    suppliedUpdate &&
    (!suppliedDelivery ||
      suppliedDelivery.state !== "delivered" ||
      suppliedDelivery.deliveredAt === null)
  ) {
    conflict(
      "Updated terminal record does not contain the delivered checkpoint",
      "updatedRecord",
    );
  }
  const effectiveAt =
    at === undefined ? suppliedDelivery?.deliveredAt : safeTimestamp(at, "at");
  const expectedUpdate = markResourceDeliveryDelivered(
    head,
    expectedDeliveryId,
    {
      guard,
      at: effectiveAt,
      confirmed: confirmed === true || suppliedUpdate !== null,
    },
  );
  const updated = suppliedUpdate ?? expectedUpdate;
  if (!persistedValuesEqual(updated, expectedUpdate)) {
    conflict(
      "Updated terminal record does not match the canonical delivery checkpoint",
      "updatedRecord",
    );
  }
  const operationOutbox = [...current.operationOutbox];
  if (updated.outbox.entries.some((entry) => entry.state === "pending")) {
    operationOutbox[0] = updated;
  } else {
    operationOutbox.shift();
  }
  return replaceState(current, {
    revision: nextRevision(current, revision),
    operationOutbox,
  });
}

/** Explicitly archive and clear a GM-reviewed needs-review operation. */
export function clearReviewedResourceOperationV5(
  state,
  { operationId, runId, receipt = null, recordedAt, confirmed, revision } = {},
) {
  const current = normalizeResourceRunStateV5(state);
  const operation = current.activeOperation;
  assertExactOperationIdentity(
    operation,
    operationId,
    runId,
    "state.activeOperation",
  );
  if (operation.phase !== "needs-review" || confirmed !== true) {
    fail(
      "RESOURCE_RUN_STATE_V5_REVIEW_REQUIRED",
      "Clearing needs-review requires exact identity and explicit GM confirmation",
      "state.activeOperation",
    );
  }
  assertHistoryCapacityForNewReceipt(current, "state.recentRuns");
  const reviewedReceipt =
    operation.receipt ??
    buildInterruptedRunReceipt(
      reviewReceiptSource(operation),
      safeTimestamp(recordedAt, "recordedAt"),
    );
  assertReviewOperationReceipt(operation, reviewedReceipt, "receipt");
  if (receipt !== null) {
    const requestedReceipt = assertCanonicalReceipt(
      receipt,
      operation.runId,
      "receipt",
    );
    if (!persistedValuesEqual(requestedReceipt, reviewedReceipt)) {
      conflict(
        "Caller-supplied review receipt does not match the derived receipt",
        "receipt",
      );
    }
  }
  return replaceState(current, {
    revision: nextRevision(current, revision),
    activeOperation: null,
    recentRuns: appendRecentRunReceipt(current.recentRuns, reviewedReceipt),
  });
}

/** Explicit GM-reviewed escape hatch for an undeliverable FIFO terminal record. */
export function clearReviewedResourceDeliveryBacklogV5(
  state,
  { operationId, runId, pendingDeliveryIds, confirmed, revision } = {},
) {
  const current = normalizeResourceRunStateV5(state);
  const head = current.operationOutbox[0];
  assertExactOperationIdentity(
    head,
    operationId,
    runId,
    "state.operationOutbox[0]",
  );
  if (confirmed !== true) {
    fail(
      "RESOURCE_RUN_STATE_V5_REVIEW_REQUIRED",
      "Delivery backlog clear requires explicit GM confirmation",
      "confirmed",
    );
  }
  assertDenseArray(pendingDeliveryIds, "pendingDeliveryIds", 101);
  const requested = pendingDeliveryIds.map((id, index) =>
    strictString(id, `pendingDeliveryIds[${index}]`, MAX_JSON_STRING_LENGTH),
  );
  const currentPending = head.outbox.entries
    .filter((entry) => entry.state === "pending")
    .map((entry) => entry.deliveryId);
  if (!persistedValuesEqual(requested, currentPending)) {
    conflict("Delivery backlog changed since GM review", "pendingDeliveryIds");
  }
  return replaceState(current, {
    revision: nextRevision(current, revision),
    operationOutbox: current.operationOutbox.slice(1),
  });
}

function normalizeResourceRunStateV4(raw) {
  assertPlainObject(raw, "state");
  assertExactKeys(raw, V4_STATE_KEYS, "state");
  if (raw.version !== 4) {
    fail(
      "RESOURCE_RUN_STATE_V5_LEGACY_CORRUPT",
      "Expected exact resource run-state v4",
      "state.version",
    );
  }
  const clonedRecentRuns = cloneJson(
    raw.recentRuns,
    "state.recentRuns",
    createJsonBudget(),
  );
  const recentRuns = normalizeRecentRuns(clonedRecentRuns);
  if (
    !Array.isArray(raw.recentRuns) ||
    !persistedValuesEqual(raw.recentRuns, recentRuns)
  ) {
    legacyCorrupt("Legacy recentRuns is not canonical", "state.recentRuns");
  }
  return deepFreeze({
    version: 4,
    revision: legacyInteger(raw.revision, "state.revision", { min: 0 }),
    authorityId: legacyId(raw.authorityId, "state.authorityId"),
    authorityEpoch: legacyId(raw.authorityEpoch, "state.authorityEpoch"),
    lastSeenDay: legacyNullableInteger(raw.lastSeenDay, "state.lastSeenDay", {
      min: -1_000_000_000,
      max: 1_000_000_000,
    }),
    currentEnvironmentId:
      raw.currentEnvironmentId === null
        ? null
        : legacyId(raw.currentEnvironmentId, "state.currentEnvironmentId"),
    lastUpkeepResult: nullableJsonObject(
      raw.lastUpkeepResult,
      "state.lastUpkeepResult",
    ),
    activeUpkeep:
      raw.activeUpkeep === null
        ? null
        : normalizeLegacyActiveUpkeep(raw.activeUpkeep),
    recentRuns,
  });
}

function normalizeLegacyActiveUpkeep(raw) {
  assertPlainObject(raw, "state.activeUpkeep");
  assertExactKeys(raw, V4_ACTIVE_KEYS, "state.activeUpkeep");
  raw = cloneJson(raw, "state.activeUpkeep", createJsonBudget());
  const trigger = TRIGGERS.has(raw.trigger) ? raw.trigger : null;
  if (!trigger)
    legacyCorrupt("Legacy trigger is invalid", "state.activeUpkeep.trigger");
  const environment = normalizeRunEnvironmentSnapshot(raw.environment);
  const initiator = normalizeRunInitiatorSnapshot(raw.initiator);
  const actors = normalizeRunActorSnapshots(raw.actors);
  const forageAssignments =
    trigger === "forage"
      ? normalizeForageAssignments(raw.forageAssignments)
      : [];
  const forageDestination =
    trigger === "forage"
      ? normalizeForageDestination(raw.forageDestination)
      : null;
  const forageTarget =
    trigger === "forage" && FORAGE_TARGETS.has(raw.forageTarget)
      ? raw.forageTarget
      : null;
  const normalized = {
    runId: legacyId(raw.runId, "state.activeUpkeep.runId"),
    trigger,
    day: legacyNullableInteger(raw.day, "state.activeUpkeep.day", {
      min: -1_000_000_000,
      max: 1_000_000_000,
    }),
    days: legacyInteger(raw.days, "state.activeUpkeep.days", {
      min: 1,
      max: 365,
    }),
    startedAt: legacyInteger(raw.startedAt, "state.activeUpkeep.startedAt", {
      min: 0,
    }),
    claimedAt: legacyInteger(raw.claimedAt, "state.activeUpkeep.claimedAt", {
      min: 0,
    }),
    authorityId:
      raw.authorityId === null
        ? null
        : legacyId(raw.authorityId, "state.activeUpkeep.authorityId"),
    authorityEpoch:
      raw.authorityEpoch === null
        ? null
        : legacyId(raw.authorityEpoch, "state.activeUpkeep.authorityEpoch"),
    leadershipGeneration:
      raw.leadershipGeneration === null
        ? null
        : legacyInteger(
            raw.leadershipGeneration,
            "state.activeUpkeep.leadershipGeneration",
            { min: 0 },
          ),
    environment,
    initiator,
    actors,
    forageTarget,
    forageAssignments,
    forageDestination,
  };
  if (!persistedValuesEqual(raw, normalized)) {
    legacyCorrupt(
      "Legacy activeUpkeep is not its exact canonical v4 shape",
      "state.activeUpkeep",
    );
  }
  return deepFreeze(normalized);
}

function recognizeHistoricalActiveUpkeep(value) {
  if (value === null || value === undefined) return null;
  try {
    return normalizeLegacyActiveUpkeep(value);
  } catch (error) {
    legacyCorrupt(
      `Historical activeUpkeep cannot be safely quarantined: ${error.message}`,
      "state.activeUpkeep",
    );
  }
}

function sanitizeHistoricalHistory(value) {
  try {
    const cloned = cloneJson(
      value ?? [],
      "state.recentRuns",
      createJsonBudget(),
    );
    return normalizeRecentRuns(cloned);
  } catch {
    return [];
  }
}

function sanitizeHistoricalResult(value) {
  if (value === null || value === undefined) return null;
  try {
    return nullableJsonObject(value, "state.lastUpkeepResult");
  } catch {
    return null;
  }
}

function cleanHistoricalId(value) {
  const id = typeof value === "string" ? value.trim() : "";
  return id && id.length <= MAX_ID_LENGTH ? id : null;
}

function historicalFiniteNumber(value) {
  if (typeof value === "number") {
    return Number.isFinite(value) ? value : null;
  }
  if (
    typeof value !== "string" ||
    value.length < 1 ||
    value.length > 64 ||
    !/^-?(?:0|[1-9]\d*)(?:\.\d+)?$/.test(value)
  ) {
    return null;
  }
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function readDataProperty(value, key) {
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  if (!descriptor) return undefined;
  if (!("value" in descriptor) || descriptor.enumerable !== true) {
    fail(
      "RESOURCE_RUN_STATE_V5_MALFORMED",
      "Historical state fields must be enumerable JSON data",
      `state.${key}`,
    );
  }
  return descriptor.value;
}

function terminalResultFromReport(report) {
  const result = mutableClone(report);
  delete result[REPORT_DELIVERY_FIELD];
  return nullableJsonObject(result, "terminalOperation.report");
}

function reviewReceiptSource(operation) {
  if (operation.review?.code === "legacy-active-upkeep-outcome-unknown") {
    return operation.review.evidence;
  }
  return {
    runId: operation.runId,
    trigger: operation.trigger,
    day: operation.day,
    days: operation.days,
    startedAt: operation.timestamps.createdAt,
    claimedAt: operation.timestamps.preparedAt,
    environment: operation.environment,
    initiator: operation.initiator,
    actors: operation.actors,
    forageTarget:
      operation.actors.find((actor) => actor.forageTarget)?.forageTarget ??
      null,
    forageAssignments: operation.prompts.assignments.map((assignment) => ({
      actorId: assignment.actorId,
      forageTarget: assignment.forageTarget,
    })),
    forageDestination: null,
  };
}

function replaceState(current, patch) {
  return normalizeResourceRunStateV5({
    version: RESOURCE_RUN_STATE_V5_VERSION,
    revision: patch.revision ?? current.revision,
    authorityId: patch.authorityId ?? current.authorityId,
    authorityEpoch: patch.authorityEpoch ?? current.authorityEpoch,
    lastSeenDay:
      patch.lastSeenDay === undefined ? current.lastSeenDay : patch.lastSeenDay,
    currentEnvironmentId:
      patch.currentEnvironmentId === undefined
        ? current.currentEnvironmentId
        : patch.currentEnvironmentId,
    lastUpkeepResult:
      patch.lastUpkeepResult === undefined
        ? current.lastUpkeepResult
        : patch.lastUpkeepResult,
    activeOperation:
      patch.activeOperation === undefined
        ? current.activeOperation
        : patch.activeOperation,
    operationOutbox: patch.operationOutbox ?? current.operationOutbox,
    recentRuns: patch.recentRuns ?? current.recentRuns,
  });
}

function nextRevision(state, requested) {
  if (state.revision >= Number.MAX_SAFE_INTEGER) {
    fail(
      "RESOURCE_RUN_STATE_V5_BOUNDS",
      "Run-state revision is exhausted",
      "state.revision",
    );
  }
  const expected = state.revision + 1;
  const next = requested ?? expected;
  if (next !== expected) {
    conflict("Revision must advance by exactly one", "revision");
  }
  return next;
}

function findExactOperation(state, location, operationId, runId) {
  if (location !== "active" && location !== "outbox") {
    conflict("Operation location must be active or outbox", "location");
  }
  const expectedRunId = strictId(runId, "runId");
  const expectedOperationId =
    operationId === undefined || operationId === null
      ? null
      : strictString(operationId, "operationId", MAX_JSON_STRING_LENGTH);
  const operation =
    location === "active"
      ? state.activeOperation
      : state.operationOutbox.find(
          (entry) =>
            entry.runId === expectedRunId &&
            (expectedOperationId === null ||
              entry.operationId === expectedOperationId),
        );
  assertExactOperationIdentity(
    operation,
    expectedOperationId ?? operation?.operationId,
    expectedRunId,
    `state.${location}`,
  );
  return operation;
}

function assertTerminalAuthorityCheckpoint(previous, candidate) {
  assertAuthorityCheckpoint(previous, candidate, { allowCrashMarker: false });
}

function assertActiveCheckpoint(previous, candidate) {
  if (persistedValuesEqual(previous, candidate)) return "noop";
  const authorityChanged =
    !persistedValuesEqual(previous.guard, candidate.guard) ||
    !persistedValuesEqual(
      previous.authorityAdoptions,
      candidate.authorityAdoptions,
    );
  if (authorityChanged) {
    assertAuthorityCheckpoint(previous, candidate, {
      allowCrashMarker: previous.phase === "applying",
    });
    return "authority";
  }
  if (previous.phase !== candidate.phase) {
    if (!canTransitionResourceOperation(previous.phase, candidate.phase)) {
      conflict(
        "Operation checkpoint is not a valid phase transition",
        "operation.phase",
      );
    }
    assertForwardOperationTransition(previous, candidate);
    return "transition";
  }
  if (previous.phase === "prompting") {
    assertUnchangedOperationFields(previous, candidate, [
      "prompts",
      "timestamps",
    ]);
    if (
      !persistedValuesEqual(
        previous.prompts.assignments,
        candidate.prompts.assignments,
      )
    ) {
      conflict(
        "Prompt assignments cannot change after persistence",
        "operation.prompts.assignments",
      );
    }
    assertEntriesRetained(
      previous.prompts.responses,
      candidate.prompts.responses,
      "promptId",
      "operation.prompts.responses",
    );
    assertEntriesRetained(
      previous.prompts.timeouts,
      candidate.prompts.timeouts,
      "promptId",
      "operation.prompts.timeouts",
    );
    const previousCount =
      previous.prompts.responses.length + previous.prompts.timeouts.length;
    const candidateCount =
      candidate.prompts.responses.length + candidate.prompts.timeouts.length;
    if (candidateCount !== previousCount + 1) {
      conflict(
        "Prompt checkpoints may append exactly one response or timeout",
        "operation.prompts",
      );
    }
    assertCheckpointTimestamps(previous, candidate);
    return "progress";
  }
  if (previous.phase === "applying") {
    assertUnchangedOperationFields(previous, candidate, [
      "appliedOperationIds",
      "timestamps",
    ]);
    assertOneAppliedMarker(previous, candidate);
    assertCheckpointTimestamps(previous, candidate);
    return "progress";
  }
  conflict(
    `Same-phase ${previous.phase} checkpoints cannot replace durable data`,
    "operation.phase",
  );
}

function assertForwardOperationTransition(previous, candidate) {
  const allowedByTarget = {
    prompting: ["phase", "prompts", "timestamps"],
    planned: ["phase", "yields", "plan", "timestamps"],
    applying: ["phase", "timestamps"],
    "needs-review": ["phase", "report", "receipt", "review", "timestamps"],
  };
  const allowed = allowedByTarget[candidate.phase];
  if (!allowed) {
    conflict("Unsupported active checkpoint transition", "operation.phase");
  }
  assertUnchangedOperationFields(previous, candidate, allowed);
  assertCheckpointTimestamps(
    previous,
    candidate,
    {
      prompting: "promptingAt",
      planned: "plannedAt",
      applying: "applyingAt",
      "needs-review": "needsReviewAt",
    }[candidate.phase],
  );
}

function assertTerminalTransition(previous, candidate) {
  assertUnchangedOperationFields(previous, candidate, [
    "phase",
    "report",
    "receipt",
    "outbox",
    "timestamps",
  ]);
  assertCheckpointTimestamps(previous, candidate, "terminalAt");
}

function assertAuthorityCheckpoint(previous, candidate, { allowCrashMarker }) {
  if (previous.phase !== candidate.phase) {
    conflict(
      "Authority adoption cannot also change operation phase",
      "operation.phase",
    );
  }
  if (
    candidate.authorityAdoptions.length !==
      previous.authorityAdoptions.length + 1 ||
    !persistedValuesEqual(
      candidate.authorityAdoptions.slice(0, -1),
      previous.authorityAdoptions,
    )
  ) {
    conflict(
      "Authority checkpoints may append exactly one adoption",
      "operation.authorityAdoptions",
    );
  }
  const adoption = candidate.authorityAdoptions.at(-1);
  if (
    persistedValuesEqual(previous.guard, candidate.guard) ||
    !persistedValuesEqual(adoption.fromGuard, previous.guard) ||
    !persistedValuesEqual(adoption.toGuard, candidate.guard) ||
    adoption.phase !== previous.phase ||
    adoption.at !== candidate.timestamps.updatedAt
  ) {
    conflict(
      "Authority adoption does not bind the old/new guards and checkpoint",
      "operation.authorityAdoptions",
    );
  }
  for (const key of Object.keys(previous)) {
    if (
      key === "guard" ||
      key === "authorityAdoptions" ||
      key === "timestamps" ||
      (allowCrashMarker && key === "appliedOperationIds")
    ) {
      continue;
    }
    if (!persistedValuesEqual(previous[key], candidate[key])) {
      conflict(
        `Authority adoption changed durable field: ${key}`,
        `operation.${key}`,
      );
    }
  }
  if (allowCrashMarker) {
    const advanced = adoption.advancedOperationId;
    if (advanced === null) {
      if (
        !persistedValuesEqual(
          previous.appliedOperationIds,
          candidate.appliedOperationIds,
        )
      ) {
        conflict(
          "Authority adoption changed inventory markers without reconciliation",
          "operation.appliedOperationIds",
        );
      }
    } else {
      assertOneAppliedMarker(previous, candidate);
      if (candidate.appliedOperationIds.at(-1) !== advanced) {
        conflict(
          "Authority adoption advanced a different inventory marker",
          "operation.appliedOperationIds",
        );
      }
    }
  }
  assertCheckpointTimestamps(previous, candidate);
}

function assertUnchangedOperationFields(previous, candidate, allowedFields) {
  const allowed = new Set(allowedFields);
  for (const key of Object.keys(previous)) {
    if (allowed.has(key)) continue;
    if (!persistedValuesEqual(previous[key], candidate[key])) {
      conflict(
        `Durable operation field changed outside its checkpoint: ${key}`,
        `operation.${key}`,
      );
    }
  }
}

function assertCheckpointTimestamps(previous, candidate, phaseField = null) {
  if (candidate.timestamps.updatedAt < previous.timestamps.updatedAt) {
    conflict(
      "Operation checkpoint time moved backward",
      "operation.timestamps",
    );
  }
  for (const key of Object.keys(previous.timestamps)) {
    if (key === "updatedAt" || key === phaseField) continue;
    if (previous.timestamps[key] !== candidate.timestamps[key]) {
      conflict(
        `Operation rewrote prior checkpoint timestamp: ${key}`,
        `operation.timestamps.${key}`,
      );
    }
  }
  if (
    phaseField &&
    candidate.timestamps[phaseField] !== candidate.timestamps.updatedAt
  ) {
    conflict(
      "Phase timestamp must equal the durable updatedAt checkpoint",
      `operation.timestamps.${phaseField}`,
    );
  }
}

function assertEntriesRetained(previous, candidate, key, path) {
  for (const entry of previous) {
    const retained = candidate.find((value) => value[key] === entry[key]);
    if (!retained || !persistedValuesEqual(entry, retained)) {
      conflict("Persisted prompt outcome was removed or replaced", path);
    }
  }
}

function assertOneAppliedMarker(previous, candidate) {
  const expected = [
    ...previous.appliedOperationIds,
    previous.plan[previous.appliedOperationIds.length]?.opId,
  ];
  if (
    expected.at(-1) === undefined ||
    !persistedValuesEqual(candidate.appliedOperationIds, expected)
  ) {
    conflict(
      "Applying checkpoints may append only the exact next inventory marker",
      "operation.appliedOperationIds",
    );
  }
}

function assertExactOperationIdentity(operation, operationId, runId, path) {
  const expectedOperationId = strictString(
    operationId,
    "operationId",
    MAX_JSON_STRING_LENGTH,
  );
  const expectedRunId = strictId(runId, "runId");
  if (
    !operation ||
    operation.operationId !== expectedOperationId ||
    operation.runId !== expectedRunId
  ) {
    conflict("Operation identity is no longer current", path);
  }
}

function assertSameOperation(previous, candidate) {
  for (const field of OPERATION_IDENTITY_FIELDS) {
    if (!persistedValuesEqual(previous[field], candidate[field])) {
      conflict(
        `Immutable operation field changed: ${field}`,
        `operation.${field}`,
      );
    }
  }
  if (
    previous.timestamps.createdAt !== candidate.timestamps.createdAt ||
    previous.timestamps.preparedAt !== candidate.timestamps.preparedAt
  ) {
    conflict("Immutable operation timestamps changed", "operation.timestamps");
  }
}

function assertOperationAuthority(operation, authorityId, authorityEpoch) {
  if (
    operation.guard.authorityId !== authorityId ||
    operation.guard.authorityEpoch !== authorityEpoch
  ) {
    fail(
      "RESOURCE_RUN_STATE_V5_FENCE_LOST",
      "Operation guard does not match the state authority",
      "operation.guard",
    );
  }
}

function assertOperationIdentityAvailable(state, operation) {
  const operations = [
    ...(state.activeOperation ? [state.activeOperation] : []),
    ...state.operationOutbox,
  ];
  if (
    operations.some(
      (entry) =>
        entry.operationId === operation.operationId ||
        entry.runId === operation.runId,
    ) ||
    state.recentRuns.some((receipt) => receipt.runId === operation.runId)
  ) {
    conflict(
      "Operation or run identity has already been used",
      "operation.runId",
    );
  }
}

function normalizeNestedOperation(raw, path) {
  try {
    const operation = normalizeResourceOperation(raw);
    if (!persistedValuesEqual(raw, operation)) {
      fail(
        "RESOURCE_RUN_STATE_V5_MALFORMED",
        "Nested operation is not exact canonical ledger data",
        path,
      );
    }
    return operation;
  } catch (error) {
    if (error instanceof ResourceRunStateV5Error) throw error;
    if (error instanceof ResourceOperationLedgerError) {
      fail(
        "RESOURCE_RUN_STATE_V5_MALFORMED",
        `Invalid nested operation: ${error.message}`,
        `${path}${error.path ? `.${error.path}` : ""}`,
        null,
        error,
      );
    }
    throw error;
  }
}

function assertTerminalOperationReport(operation, path) {
  const report = terminalResultFromReport(operation.report);
  if (
    report.runId !== operation.runId ||
    report.trigger !== operation.trigger ||
    report.day !== operation.day ||
    report.days !== operation.days
  ) {
    fail(
      "RESOURCE_RUN_STATE_V5_MALFORMED",
      "Terminal report identity does not match its operation",
      path,
    );
  }
  return report;
}

function assertTerminalOutcomeStatus(report, receipt, path) {
  if (
    (report.status !== "complete" && report.status !== "partial") ||
    report.status !== receipt.status
  ) {
    fail(
      "RESOURCE_RUN_STATE_V5_MALFORMED",
      "Terminal report and receipt statuses must match",
      path,
    );
  }
}

function assertTerminalOperationReceipt(operation, path) {
  const receipt = assertCanonicalReceipt(
    operation.receipt,
    operation.runId,
    path,
  );
  assertReceiptOperationIdentity(operation, receipt, path);
  if (receipt.kind !== operation.kind) {
    fail(
      "RESOURCE_RUN_STATE_V5_MALFORMED",
      "Terminal receipt identity does not match its operation",
      path,
    );
  }
  if (operation.kind === "forage") {
    assertForageReceiptContext(operation, receipt, path);
  }
  return receipt;
}

function assertReviewOperationReceipt(operation, value, path) {
  const receipt = assertCanonicalReceipt(value, operation.runId, path);
  assertReceiptOperationIdentity(operation, receipt, path);
  if (receipt.kind !== "interrupted" && receipt.kind !== operation.kind) {
    fail(
      "RESOURCE_RUN_STATE_V5_MALFORMED",
      "Review receipt kind does not match its operation",
      path,
    );
  }
  if (receipt.kind === operation.kind && operation.kind === "forage") {
    assertForageReceiptContext(operation, receipt, path);
  }
  return receipt;
}

function assertReceiptOperationIdentity(operation, receipt, path) {
  if (
    receipt.trigger !== operation.trigger ||
    receipt.day !== operation.day ||
    receipt.days !== operation.days ||
    (receipt.environment !== null &&
      !persistedValuesEqual(receipt.environment, operation.environment))
  ) {
    fail(
      "RESOURCE_RUN_STATE_V5_MALFORMED",
      "Receipt identity does not match its operation",
      path,
    );
  }
}

function assertForageReceiptContext(operation, receipt, path) {
  const expectedAssignments = operation.actors
    .filter((actor) => actor.forageTarget)
    .map((actor) => ({
      actorId: actor.actorId,
      forageTarget: actor.forageTarget,
    }));
  if (
    !receipt.forageContext ||
    !receipt.forageDrive ||
    !persistedValuesEqual(
      receipt.forageContext.assignments,
      expectedAssignments,
    ) ||
    !persistedValuesEqual(
      receipt.forageDrive.assignments,
      expectedAssignments,
    ) ||
    receipt.forageContext.target !== receipt.forageDrive.target ||
    !persistedValuesEqual(
      receipt.forageContext.destination,
      receipt.forageDrive.destination,
    )
  ) {
    fail(
      "RESOURCE_RUN_STATE_V5_MALFORMED",
      "Forage receipt context does not match the durable participants",
      path,
    );
  }
}

function assertHistoryCapacityForNewReceipt(state, path) {
  if (state.recentRuns.length < RESOURCE_RUN_HISTORY_LIMIT) return;
  const evictedRunId = state.recentRuns.at(-1)?.runId ?? null;
  if (
    state.operationOutbox.some((operation) => operation.runId === evictedRunId)
  ) {
    fail(
      "RESOURCE_RUN_STATE_V5_HISTORY_FULL",
      "Receipt history cannot evict a pending terminal backlog receipt",
      path,
    );
  }
}

function assertCanonicalReceipt(receipt, runId, path) {
  const cloned = cloneJson(receipt, path, createJsonBudget());
  const normalized = normalizeRunReceipt(cloned);
  if (
    !normalized ||
    normalized.runId !== runId ||
    !persistedValuesEqual(receipt, normalized)
  ) {
    fail(
      "RESOURCE_RUN_STATE_V5_MALFORMED",
      "Receipt is not exact canonical history data for this run",
      path,
    );
  }
  return normalized;
}

function readPersistedVersion(raw) {
  assertPlainObject(raw, "state");
  const descriptor = Object.getOwnPropertyDescriptor(raw, "version");
  if (!descriptor) return null;
  if (!("value" in descriptor) || descriptor.enumerable !== true) {
    fail(
      "RESOURCE_RUN_STATE_V5_INVALID_VERSION",
      "Persisted state requires a data version field",
      "state.version",
      versionStatus("invalid-version", null),
    );
  }
  const value = descriptor.value;
  const canonicalString =
    typeof value === "string" && /^(0|[1-9]\d*)$/.test(value);
  const parsed =
    typeof value === "number" ? value : canonicalString ? Number(value) : NaN;
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    fail(
      "RESOURCE_RUN_STATE_V5_INVALID_VERSION",
      "Persisted state version is invalid",
      "state.version",
      versionStatus("invalid-version", null),
    );
  }
  return parsed;
}

function assertV5Version(value, path) {
  if (Number.isSafeInteger(value) && value > RESOURCE_RUN_STATE_V5_VERSION) {
    futureVersion(value, path);
  }
  if (value !== RESOURCE_RUN_STATE_V5_VERSION) {
    fail(
      "RESOURCE_RUN_STATE_V5_MALFORMED",
      "Expected exact resource run-state v5",
      path,
      versionStatus("same-version-corrupt", RESOURCE_RUN_STATE_V5_VERSION),
    );
  }
}

function futureVersion(value, path) {
  fail(
    "RESOURCE_RUN_STATE_V5_FUTURE_VERSION",
    `Unsupported resource run-state version ${value}`,
    path,
    versionStatus("future-version", value),
  );
}

function versionStatus(code, observedVersion) {
  return {
    state: "blocked",
    code,
    retryable: false,
    domain: "resourceRunState",
    supportedVersion: RESOURCE_RUN_STATE_V5_VERSION,
    observedVersion,
  };
}

function asStateError(error) {
  if (error instanceof ResourceRunStateV5Error) return error;
  return new ResourceRunStateV5Error(
    "RESOURCE_RUN_STATE_V5_MALFORMED",
    error instanceof Error ? error.message : "Malformed resource run-state",
    "state",
    { cause: error },
  );
}

function legacyCorrupt(message, path) {
  fail(
    "RESOURCE_RUN_STATE_V5_LEGACY_CORRUPT",
    message,
    path,
    versionStatus("legacy-corrupt", 4),
  );
}

function conflict(message, path) {
  fail("RESOURCE_RUN_STATE_V5_CONFLICT", message, path);
}

function fail(code, message, path, status = null, cause = undefined) {
  throw new ResourceRunStateV5Error(code, message, path, { status, cause });
}

function assertPlainObject(value, path) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    fail("RESOURCE_RUN_STATE_V5_MALFORMED", "Expected a plain object", path);
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    fail("RESOURCE_RUN_STATE_V5_MALFORMED", "Non-JSON object prototype", path);
  }
}

function assertExactKeys(value, expected, path) {
  const actual = Reflect.ownKeys(value);
  const wanted = new Set(expected);
  if (
    actual.some((key) => typeof key !== "string") ||
    actual.length !== wanted.size ||
    actual.some((key) => !wanted.has(key))
  ) {
    fail(
      "RESOURCE_RUN_STATE_V5_MALFORMED",
      "Object fields do not match the exact schema",
      path,
    );
  }
  for (const key of actual) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (
      !descriptor ||
      !("value" in descriptor) ||
      descriptor.enumerable !== true
    ) {
      fail(
        "RESOURCE_RUN_STATE_V5_MALFORMED",
        "Accessor or hidden fields are not JSON data",
        `${path}.${key}`,
      );
    }
  }
}

function assertDenseArray(value, path, max) {
  if (!Array.isArray(value) || value.length > max) {
    fail("RESOURCE_RUN_STATE_V5_BOUNDS", "Invalid bounded array", path);
  }
  const keys = Reflect.ownKeys(value);
  const expected = new Set([
    ...Array.from({ length: value.length }, (_, index) => String(index)),
    "length",
  ]);
  if (
    keys.length !== expected.size ||
    keys.some((key) => typeof key !== "string" || !expected.has(key))
  ) {
    fail(
      "RESOURCE_RUN_STATE_V5_MALFORMED",
      "Arrays must contain only dense indexed JSON data",
      path,
    );
  }
  for (let index = 0; index < value.length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(value, index);
    if (
      !descriptor ||
      !("value" in descriptor) ||
      descriptor.enumerable !== true
    ) {
      fail(
        "RESOURCE_RUN_STATE_V5_MALFORMED",
        "Sparse or accessor arrays are not JSON data",
        `${path}[${index}]`,
      );
    }
  }
}

function safeInteger(
  value,
  path,
  { min = Number.MIN_SAFE_INTEGER, max = Number.MAX_SAFE_INTEGER } = {},
) {
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    fail(
      "RESOURCE_RUN_STATE_V5_MALFORMED",
      "Expected a bounded safe integer",
      path,
    );
  }
  return value;
}

function safeTimestamp(value, path) {
  return safeInteger(value, path, { min: 0 });
}

function nullableSafeInteger(value, path, bounds = {}) {
  return value === null ? null : safeInteger(value, path, bounds);
}

function strictString(value, path, max = MAX_JSON_STRING_LENGTH) {
  if (
    typeof value !== "string" ||
    value.length < 1 ||
    value.length > max ||
    value !== value.trim()
  ) {
    fail("RESOURCE_RUN_STATE_V5_MALFORMED", "Invalid bounded string", path);
  }
  return value;
}

function strictId(value, path) {
  return strictString(value, path, MAX_ID_LENGTH);
}

function nullableId(value, path) {
  return value === null ? null : strictId(value, path);
}

function legacyInteger(value, path, bounds = {}) {
  try {
    return safeInteger(value, path, bounds);
  } catch (error) {
    legacyCorrupt(error.message, path);
  }
}

function legacyNullableInteger(value, path, bounds = {}) {
  return value === null ? null : legacyInteger(value, path, bounds);
}

function legacyId(value, path) {
  try {
    return strictId(value, path);
  } catch (error) {
    legacyCorrupt(error.message, path);
  }
}

function nullableJsonObject(value, path) {
  if (value === null) return null;
  assertPlainObject(value, path);
  const cloned = cloneJson(value, path, createJsonBudget());
  if (!persistedValuesEqual(value, cloned)) {
    fail(
      "RESOURCE_RUN_STATE_V5_MALFORMED",
      "JSON object is not exact canonical persisted data",
      path,
    );
  }
  return cloned;
}

function createJsonBudget() {
  return { nodes: 0, stringChars: 0, keyChars: 0 };
}

function cloneJson(value, path, budget, depth = 0) {
  budget.nodes += 1;
  if (depth > MAX_JSON_DEPTH || budget.nodes > MAX_JSON_NODES) {
    fail(
      "RESOURCE_RUN_STATE_V5_BOUNDS",
      "JSON value exceeds structural bounds",
      path,
    );
  }
  if (value === null || typeof value === "boolean") return value;
  if (typeof value === "string") {
    if (value.length > MAX_JSON_STRING_LENGTH) {
      fail("RESOURCE_RUN_STATE_V5_BOUNDS", "JSON string is too long", path);
    }
    budget.stringChars += value.length;
    if (budget.stringChars > MAX_JSON_STRING_CHARS) {
      fail(
        "RESOURCE_RUN_STATE_V5_BOUNDS",
        "JSON strings exceed aggregate bounds",
        path,
      );
    }
    return value;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      fail(
        "RESOURCE_RUN_STATE_V5_MALFORMED",
        "JSON numbers must be finite",
        path,
      );
    }
    return Object.is(value, -0) ? 0 : value;
  }
  if (Array.isArray(value)) {
    assertDenseArray(value, path, MAX_JSON_COLLECTION_SIZE);
    return value.map((entry, index) =>
      cloneJson(entry, `${path}[${index}]`, budget, depth + 1),
    );
  }
  assertPlainObject(value, path);
  const keys = Reflect.ownKeys(value);
  if (
    keys.length > MAX_JSON_COLLECTION_SIZE ||
    keys.some((key) => typeof key !== "string")
  ) {
    fail("RESOURCE_RUN_STATE_V5_BOUNDS", "JSON object is too large", path);
  }
  const copy = {};
  for (const key of keys) {
    if (key.length > MAX_JSON_KEY_LENGTH) {
      fail("RESOURCE_RUN_STATE_V5_BOUNDS", "JSON object key is too long", path);
    }
    budget.keyChars += key.length;
    if (budget.keyChars > MAX_JSON_KEY_CHARS) {
      fail(
        "RESOURCE_RUN_STATE_V5_BOUNDS",
        "JSON object keys exceed aggregate bounds",
        path,
      );
    }
    if (key === "__proto__" || key === "prototype" || key === "constructor") {
      fail(
        "RESOURCE_RUN_STATE_V5_MALFORMED",
        "Unsafe JSON object key",
        `${path}.${key}`,
      );
    }
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (
      !descriptor ||
      !("value" in descriptor) ||
      descriptor.enumerable !== true
    ) {
      fail(
        "RESOURCE_RUN_STATE_V5_MALFORMED",
        "Accessor or hidden fields are not JSON data",
        `${path}.${key}`,
      );
    }
    copy[key] = cloneJson(
      descriptor.value,
      `${path}.${key}`,
      budget,
      depth + 1,
    );
  }
  return copy;
}

function mutableClone(value) {
  if (value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map(mutableClone);
  return Object.fromEntries(
    Object.entries(value).map(([key, entry]) => [key, mutableClone(entry)]),
  );
}

function deepFreeze(value) {
  if (value === null || typeof value !== "object" || Object.isFrozen(value))
    return value;
  for (const entry of Object.values(value)) deepFreeze(entry);
  return Object.freeze(value);
}

function decision(action, details = {}) {
  return deepFreeze({ action, ...mutableClone(details) });
}
