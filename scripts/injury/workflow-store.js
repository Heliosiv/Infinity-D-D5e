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
import { persistedValuesEqual } from "../utils/persisted-data.js";

const MODULE_ID = "infinity-dnd5e";
const STORE_KEY = "criticalInjuryWorkflow";
const CHECKPOINT_KEY = "criticalInjuryWorkflowCheckpoint";
const STORE_VERSION = 2;
const RECORD_SCHEMA = 1;
const MAX_ID_LENGTH = 160;
const MAX_COMPLETED_RECEIPTS = 200;
const DEFAULT_APPLICATION_LEASE_MS = 60_000;
const MIN_APPLICATION_LEASE_MS = 5_000;
const MAX_APPLICATION_LEASE_MS = 300_000;
const VALID_STATES = new Set(["approved", "resolving", "completed"]);

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
  if (state !== "approved" && !resolution) state = "approved";
  if (
    state === "completed" &&
    (!result || !completedBy || completedAt == null)
  ) {
    state = "resolving";
  }

  return {
    schema: RECORD_SCHEMA,
    pendingId,
    actorId,
    targetUserId,
    approvedBy,
    approvedAt,
    state,
    resolution: state === "approved" ? null : resolution,
    applicationLease: state === "completed" ? null : applicationLease,
    result: state === "completed" ? result : null,
    effectId: state === "completed" ? toId(raw.effectId) : "",
    calendarEntryId: state === "completed" ? toId(raw.calendarEntryId) : "",
    completedBy: state === "completed" ? completedBy : "",
    completedAt: state === "completed" ? completedAt : null,
  };
}

function pruneRecords(records) {
  const unresolved = records.filter((record) => record.state !== "completed");
  const completed = records
    .filter((record) => record.state === "completed")
    .sort(
      (left, right) =>
        Number(right.completedAt ?? 0) - Number(left.completedAt ?? 0),
    )
    .slice(0, MAX_COMPLETED_RECEIPTS);
  return [...unresolved, ...completed];
}

export function normalizeCriticalInjuryWorkflowStore(raw) {
  const source =
    raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {};
  const records = [];
  const seen = new Set();
  for (const entry of Array.isArray(source.records) ? source.records : []) {
    const record = normalizeRecord(entry);
    if (!record || seen.has(record.pendingId)) continue;
    seen.add(record.pendingId);
    records.push(record);
  }
  const revision = nonNegativeInteger(source.revision, 0);
  return {
    version: STORE_VERSION,
    revision,
    authorityId: toId(source.authorityId) || null,
    authorityEpoch: toId(source.authorityEpoch) || null,
    writeToken: toId(source.writeToken) || null,
    records: pruneRecords(records),
  };
}

function isFoundryEnvironment() {
  return Boolean(globalThis.game && globalThis.JournalEntry?.create);
}

function isLiveFoundrySession() {
  return Boolean(isFoundryEnvironment() && globalThis.game?.ready);
}

function readRawSlot(key) {
  const privateValue = getPrivateState(key);
  if (privateValue !== undefined) return privateValue;
  if (isFoundryEnvironment() && globalThis.game?.ready) {
    throw new Error("CriticalInjuryWorkflowStoreUnavailable");
  }
  try {
    return globalThis.game?.settings?.get?.(MODULE_ID, key) ?? {};
  } catch {
    return {};
  }
}

function readRawPrimary() {
  return readRawSlot(STORE_KEY);
}

function readRawCheckpoint() {
  return readRawSlot(CHECKPOINT_KEY);
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
    Number(raw.version) === 1 &&
    Array.isArray(raw.records),
  );
}

function isPersistedEnvelope(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return false;
  if (Number(raw.version) !== STORE_VERSION) return false;
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
  return {
    version: STORE_VERSION,
    revision,
    ...identity,
    records: normalized.records,
  };
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
  if (
    !rawEnvelopesEqual(readRawPrimary(), expectedPrimary) ||
    !rawEnvelopesEqual(readRawCheckpoint(), expectedCheckpoint)
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

  await setPrivateState(CHECKPOINT_KEY, next, {
    beforeWrite: () =>
      isAuthorityFenceCurrent(fence) &&
      rawEnvelopesEqual(readRawCheckpoint(), expectedCheckpoint),
    afterWrite: () =>
      isAuthorityFenceCurrent(fence) &&
      rawEnvelopesEqual(readRawCheckpoint(), next),
  });
  assertAuthorityFence(fence);
  try {
    await setPrivateState(STORE_KEY, next, {
      beforeWrite: () =>
        isAuthorityFenceCurrent(fence) &&
        rawEnvelopesEqual(readRawPrimary(), expectedPrimary),
      afterWrite: () =>
        isAuthorityFenceCurrent(fence) &&
        rawEnvelopesEqual(readRawPrimary(), next),
    });
  } catch (error) {
    // The checkpoint is the durable commit point. If it was verified and the
    // same authority still owns the fence, the observer can repair a transient
    // primary-slot failure without rerolling or duplicating Actor mutations.
    const primaryAfterFailure = readRawPrimary();
    const checkpointAfterFailure = readRawCheckpoint();
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

  const storedPrimary = readRawPrimary();
  const storedCheckpoint = readRawCheckpoint();
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
  const primary = readRawPrimary();
  const checkpoint = readRawCheckpoint();
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
    const repairedPrimary = readRawPrimary();
    const repairedCheckpoint = readRawCheckpoint();
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
    await setPrivateState(key, envelope, {
      beforeWrite: () =>
        isAuthorityFenceCurrent(fence) &&
        rawEnvelopesEqual(readRawSlot(key), expectedRaw),
      afterWrite: () =>
        isAuthorityFenceCurrent(fence) &&
        rawEnvelopesEqual(readRawSlot(key), envelope),
    });
  } catch (error) {
    if (
      isAuthorityFenceCurrent(fence) &&
      rawEnvelopesEqual(readRawSlot(key), envelope)
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
  const primary = readRawPrimary();
  const checkpoint = readRawCheckpoint();
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
    const expectedPrimary = readRawPrimary();
    const expectedCheckpoint = readRawCheckpoint();
    if (
      !rawEnvelopesEqual(expectedPrimary, ensured) ||
      !rawEnvelopesEqual(expectedCheckpoint, ensured)
    ) {
      throw new Error("CriticalInjuryWorkflowStaleWrite");
    }
    const current = normalizeCriticalInjuryWorkflowStore(ensured);
    const mutation = mutator(clone(current));
    const next = normalizeCriticalInjuryWorkflowStore(mutation.store);
    const persisted = persistedValuesEqual(current.records, next.records)
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
      ? mutation.mapResult(clonedRecord)
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

/** Whether both restricted replicas agree under the current authority epoch. */
export function isCriticalInjuryWorkflowReady() {
  try {
    const fence = captureAuthorityFence();
    if (!isAuthorityFenceCurrent(fence)) return false;
    const primary = readRawPrimary();
    const checkpoint = readRawCheckpoint();
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
