/**
 * GM-only persistent state backed by a restricted JournalEntry.
 *
 * Foundry world settings are readable by every connected client even when
 * `config:false`. Merchant economy and unrevealed faction records therefore
 * live on a JournalEntry with default NONE ownership and are cached only on
 * full-GM clients. Critical Injury approvals and replay receipts use the same
 * boundary because player-owned Actor flags are not authorization records.
 * Other roles receive typed empty defaults. Legacy settings are migrated once
 * and then cleared.
 */

import { isFullGM } from "./permissions.js";
import {
  configurePrivateStateRecoveryService,
  resetPrivateStateRecoveryServiceForTests,
} from "./private-state-recovery-service.js";
import { SETTING_KEYS } from "./settings.js";
import { authoritativeGMId, isAuthoritativeGM } from "./socket-authority.js";
import { normalizeMerchantTransactionLedger } from "./merchant/transaction-ledger.js";
import { persistedValuesEqual } from "./utils/persisted-data.js";
import {
  ensureCampaignTabLeadership,
  getCampaignTabLeadershipStatus,
  hasCampaignTabLeadership,
} from "./campaign-tab-leadership.js";

const MODULE_ID = "infinity-dnd5e";
const STORE_MARKER = "privateStateStore";
const RECOVERY_SOURCE_FLAG = "privateStateRecoverySource";
export const PRIVATE_STATE_SCHEMA_VERSION = 7;
const STORE_SCHEMA = PRIVATE_STATE_SCHEMA_VERSION;
const STORE_NAME = "[Infinity D&D5e] Private State";
const STORE_WAIT_MS = 5000;
const EMPTY_MERCHANT_TRANSACTIONS = Object.freeze({
  version: 1,
  revision: 0,
  authorityId: null,
  authorityEpoch: null,
  writeToken: null,
  replayFloors: Object.freeze([]),
  records: Object.freeze([]),
});
const PRIVATE_STATE_FIELDS = Object.freeze({
  merchants: Object.freeze({ legacyKey: "merchants", type: "array" }),
  merchantAccess: Object.freeze({ legacyKey: null, type: "object" }),
  merchantTransactions: Object.freeze({
    legacyKey: null,
    type: "merchant-transactions",
    defaultValue: EMPTY_MERCHANT_TRANSACTIONS,
  }),
  factions: Object.freeze({ legacyKey: "factions", type: "array" }),
  resourceConfig: Object.freeze({
    legacyKey: "resourceConfig",
    type: "object",
  }),
  resourceRunState: Object.freeze({
    legacyKey: "resourceRunState",
    type: "object",
  }),
  criticalInjuryWorkflow: Object.freeze({
    legacyKey: null,
    type: "object",
  }),
  criticalInjuryWorkflowCheckpoint: Object.freeze({
    legacyKey: null,
    type: "object",
  }),
  downtimeConfig: Object.freeze({
    legacyKey: null,
    type: "object",
  }),
  downtimeWorkflow: Object.freeze({
    legacyKey: null,
    type: "object",
  }),
  downtimeWorkflowCheckpoint: Object.freeze({
    legacyKey: null,
    type: "object",
  }),
});
const PRIVATE_STATE_KEYS = Object.freeze(Object.keys(PRIVATE_STATE_FIELDS));

/** Hook emitted after one or more cached private-state fields change. */
export const PRIVATE_STATE_CHANGED_HOOK = "infinity-dnd5e.privateStateChanged";

const cache = new Map();
const storeWaiters = new Set();
const syncHookIds = [];
let storeDocument = null;
let initialized = false;
let initialization = null;
let initializing = false;
let lastWriterLeadershipGeneration = null;
let syncHooksRegistered = false;
let roleHookId = null;
let connectionHookId = null;
let lastKnownFullGM = null;
let lastKnownAuthorityId = null;
let lifecycleGeneration = 0;
let lastVerifiedStoreSnapshot = null;
let lastVerifiedStoreId = null;
let recoveryEvidenceObserved = false;
let blockedStoreId = null;
let storeQuarantineStatus = null;
let manualRecoveryTargetId = null;
let privateStateStatus = createPrivateStateStatus();

export {
  applyEmptyPrivateStateReplacement,
  applyPrivateStateCandidateAdoption,
  applyPrivateStateSnapshotRecovery,
  getPrivateStateRecoveryOverview,
  previewEmptyPrivateStateReplacement,
  previewPrivateStateCandidateAdoption,
  previewPrivateStateSnapshotRecovery,
} from "./private-state-recovery-service.js";

function createPrivateStateStatus({
  state = "pending",
  code = "not-started",
  retryable = true,
  observedSchema = null,
} = {}) {
  return Object.freeze({
    state,
    code,
    retryable: retryable === true,
    supportedSchema: STORE_SCHEMA,
    observedSchema: Number.isSafeInteger(observedSchema)
      ? observedSchema
      : null,
  });
}

function setPrivateStateStatus(options) {
  privateStateStatus = createPrivateStateStatus(options);
  return privateStateStatus;
}

/** Read-only initialization/recovery status; contains no private values. */
export function getPrivateStateStatus() {
  return privateStateStatus;
}

/** Build a status-bearing error without exposing any restricted values. */
export function createPrivateStateUnavailableError(context = "") {
  const status = getPrivateStateStatus();
  const suffix = String(context ?? "").trim();
  const error = new Error(
    `PrivateStateUnavailable:${status.code}${suffix ? `:${suffix}` : ""}`,
  );
  error.code =
    status.code === "future-schema"
      ? "PRIVATE_STATE_FUTURE_SCHEMA"
      : status.code === "invalid-schema"
        ? "PRIVATE_STATE_INVALID_SCHEMA"
        : status.code === "corrupt"
          ? "PRIVATE_STATE_CORRUPT"
          : status.code === "missing-store"
            ? "PRIVATE_STATE_MISSING_STORE"
            : status.code === "candidate-review-required"
              ? "PRIVATE_STATE_CANDIDATE_REVIEW_REQUIRED"
              : "PRIVATE_STATE_UNAVAILABLE";
  error.retryable = status.retryable;
  error.privateStateStatus = status;
  return error;
}

function clone(value) {
  if (value == null) return value;
  return (
    globalThis.foundry?.utils?.deepClone?.(value) ?? structuredClone(value)
  );
}

function isLiveFoundry() {
  return Boolean(isFoundryEnvironment() && globalThis.game?.ready);
}

function isFoundryEnvironment() {
  return Boolean(globalThis.game && globalThis.JournalEntry?.create);
}

function fieldDefinition(key) {
  if (typeof key !== "string" || !Object.hasOwn(PRIVATE_STATE_FIELDS, key)) {
    throw new Error(`UnknownPrivateStateKey:${String(key)}`);
  }
  const definition = PRIVATE_STATE_FIELDS[key];
  return definition;
}

function defaultValue(key) {
  const definition = fieldDefinition(key);
  if (definition.defaultValue !== undefined) {
    return clone(definition.defaultValue);
  }
  return definition.type === "array" ? [] : {};
}

function isValidValue(key, value) {
  const definition = fieldDefinition(key);
  if (definition.type === "merchant-transactions") {
    return isValidMerchantTransactions(value);
  }
  if (definition.type === "array") return Array.isArray(value);
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function isValidMerchantTransactions(value) {
  try {
    normalizeMerchantTransactionLedger(value);
    return true;
  } catch {
    return false;
  }
}

function cleanValue(key, value) {
  return isValidValue(key, value) ? clone(value) : defaultValue(key);
}

function valuesEqual(left, right) {
  return persistedValuesEqual(left, right);
}

function readLegacyValue(key) {
  const definition = fieldDefinition(key);
  if (!definition.legacyKey) {
    return {
      available: false,
      raw: undefined,
      value: defaultValue(key),
    };
  }
  try {
    const raw = globalThis.game?.settings?.get?.(
      MODULE_ID,
      definition.legacyKey,
    );
    return {
      available: true,
      raw: clone(raw),
      value: cleanValue(key, raw),
    };
  } catch {
    return {
      available: false,
      raw: undefined,
      value: defaultValue(key),
    };
  }
}

function readDocumentValue(document, key) {
  const raw = document?.getFlag?.(MODULE_ID, key);
  return {
    present: isValidValue(key, raw),
    value: cleanValue(key, raw),
  };
}

function documentValue(document, key) {
  return readDocumentValue(document, key).value;
}

function callPrivateStateChanged(keys, reason) {
  const changedKeys = [...new Set(keys)].filter((key) =>
    PRIVATE_STATE_KEYS.includes(key),
  );
  if (changedKeys.length === 0) return;
  const payload = Object.freeze({
    keys: Object.freeze(changedKeys),
    reason,
    status: getPrivateStateStatus(),
  });
  if (typeof globalThis.Hooks?.callAll === "function") {
    globalThis.Hooks.callAll(PRIVATE_STATE_CHANGED_HOOK, payload);
  } else {
    globalThis.Hooks?.call?.(PRIVATE_STATE_CHANGED_HOOK, payload);
  }
}

function installSafeDefaults() {
  cache.clear();
  for (const key of PRIVATE_STATE_KEYS) cache.set(key, defaultValue(key));
}

function isStoreDocument(document) {
  return document?.getFlag?.(MODULE_ID, STORE_MARKER) === true;
}

function classifyStoreSchema(document) {
  const raw = document?.getFlag?.(MODULE_ID, "schemaVersion");
  if (raw === undefined) {
    return { state: "legacy", observedSchema: 0 };
  }
  const isCanonicalIntegerString =
    typeof raw === "string" && /^(0|[1-9]\d*)$/.test(raw);
  const observedSchema =
    typeof raw === "number"
      ? raw
      : isCanonicalIntegerString
        ? Number(raw)
        : Number.NaN;
  if (!Number.isSafeInteger(observedSchema) || observedSchema < 0) {
    return { state: "invalid", observedSchema: null };
  }
  if (observedSchema > STORE_SCHEMA) {
    return { state: "future", observedSchema };
  }
  if (observedSchema === STORE_SCHEMA) {
    return { state: "current", observedSchema };
  }
  return { state: "legacy", observedSchema };
}

function schemaBlockStatus(classification) {
  return {
    state: "blocked",
    code:
      classification.state === "future" ? "future-schema" : "invalid-schema",
    retryable: false,
    observedSchema: classification.observedSchema,
  };
}

function isSchemaBlocked(classification) {
  return ["future", "invalid"].includes(classification?.state);
}

function corruptStoreStatus() {
  return {
    state: "blocked",
    code: "corrupt",
    retryable: false,
    observedSchema: STORE_SCHEMA,
  };
}

function recoveryRequiredStatus(code) {
  return {
    state: "blocked",
    code,
    retryable: false,
    observedSchema: null,
  };
}

function blockRecoveryRequired(code, reason = code) {
  recoveryEvidenceObserved = true;
  storeQuarantineStatus = createPrivateStateStatus(
    recoveryRequiredStatus(code),
  );
  blockedStoreId = null;
  if (!initializing) {
    invalidatePrivilegedStore(reason, {
      retainDocument: false,
      retry: false,
      status: storeQuarantineStatus,
    });
  } else {
    lifecycleGeneration += 1;
    cache.clear();
    storeDocument = null;
    initialized = false;
    setPrivateStateStatus(storeQuarantineStatus);
    callPrivateStateChanged(PRIVATE_STATE_KEYS, reason);
  }
  return false;
}

function blockPrivateStore(
  document,
  status,
  { invalidate = false, reason = "schema-blocked" } = {},
) {
  storeQuarantineStatus = createPrivateStateStatus(status);
  blockedStoreId = String(document?.id ?? "").trim() || null;
  if (isCanonicalStoreDocument(document)) storeDocument = document;
  if (invalidate) {
    invalidatePrivilegedStore(reason, {
      retainDocument: true,
      retry: false,
      status: storeQuarantineStatus,
    });
  } else {
    lifecycleGeneration += 1;
    cache.clear();
    storeDocument = isCanonicalStoreDocument(document) ? document : null;
    initialized = false;
    setPrivateStateStatus(storeQuarantineStatus);
    callPrivateStateChanged(PRIVATE_STATE_KEYS, reason);
  }
  return false;
}

function blockUnsupportedStoreSchema(
  document,
  classification,
  { invalidate = false } = {},
) {
  return blockPrivateStore(document, schemaBlockStatus(classification), {
    invalidate,
    reason: "schema-blocked",
  });
}

function canonicalStoreIdSetting() {
  try {
    return String(
      globalThis.game?.settings?.get?.(
        MODULE_ID,
        SETTING_KEYS.PRIVATE_STATE_STORE_ID,
      ) ?? "",
    ).trim();
  } catch {
    return "";
  }
}

function storeCreatedTime(document) {
  const value = Number(
    document?._stats?.createdTime ?? document?._source?._stats?.createdTime,
  );
  return Number.isFinite(value) ? value : Number.MAX_SAFE_INTEGER;
}

function compareStoreDocuments(left, right) {
  const timeDelta = storeCreatedTime(left) - storeCreatedTime(right);
  if (timeDelta !== 0) return timeDelta;
  return String(left?.id ?? "").localeCompare(String(right?.id ?? ""));
}

function findStoreDocuments() {
  const collection = globalThis.game?.journal;
  const documents = [];
  if (typeof collection?.forEach === "function") {
    collection.forEach((entry) => {
      if (isStoreDocument(entry)) documents.push(entry);
    });
  } else {
    const entry = collection?.find?.((candidate) => isStoreDocument(candidate));
    if (entry) documents.push(entry);
  }
  return documents.sort(compareStoreDocuments);
}

function findStoreDocument() {
  const documents = findStoreDocuments();
  const persistedId = canonicalStoreIdSetting();
  if (persistedId) {
    return (
      documents.find(
        (document) => String(document?.id ?? "") === persistedId,
      ) ?? null
    );
  }
  return null;
}

function isCanonicalStoreDocument(document) {
  const persistedId = canonicalStoreIdSetting();
  return Boolean(
    document?.id && persistedId && String(document.id) === persistedId,
  );
}

function noneOwnershipLevel() {
  return globalThis.CONST?.DOCUMENT_OWNERSHIP_LEVELS?.NONE ?? 0;
}

function userById(userId) {
  return globalThis.game?.users?.get?.(userId) ?? null;
}

function hasPrivateOwnership(document) {
  const none = noneOwnershipLevel();
  const ownership = document?.ownership;
  if (!ownership || typeof ownership !== "object") return false;
  if (Number(ownership.default ?? none) !== none) return false;
  for (const [userId, rawLevel] of Object.entries(ownership)) {
    if (userId === "default") continue;
    const level = Number(rawLevel);
    if (!Number.isFinite(level) || level <= none) continue;
    if (!isFullGM(userById(userId))) return false;
  }
  return true;
}

function hasCompleteStorePayload(document) {
  return Boolean(
    isStoreDocument(document) &&
    classifyStoreSchema(document).state === "current" &&
    PRIVATE_STATE_KEYS.every((key) => readDocumentValue(document, key).present),
  );
}

function hasCompleteVerifiedSnapshot() {
  return Boolean(
    lastVerifiedStoreSnapshot &&
    PRIVATE_STATE_KEYS.every((key) =>
      isValidValue(key, lastVerifiedStoreSnapshot[key]),
    ),
  );
}

function canRepairCurrentStoreFromSnapshot(document) {
  return Boolean(
    document?.id &&
    isCanonicalStoreDocument(document) &&
    String(document.id) === lastVerifiedStoreId &&
    hasCompleteVerifiedSnapshot(),
  );
}

function hasCurrentStoreCorruption(document) {
  return Boolean(
    classifyStoreSchema(document).state === "current" &&
    !hasCompleteStorePayload(document),
  );
}

function blockCorruptStore(document, { invalidate = false } = {}) {
  return blockPrivateStore(document, corruptStoreStatus(), {
    invalidate,
    reason: "store-corrupt",
  });
}

function ensureStoreCanBeWritten(
  document,
  { allowSnapshotRepair = false, invalidate = false } = {},
) {
  const classification = classifyStoreSchema(document);
  if (isSchemaBlocked(classification)) {
    return blockUnsupportedStoreSchema(document, classification, {
      invalidate,
    });
  }
  if (
    hasCurrentStoreCorruption(document) &&
    !(allowSnapshotRepair && canRepairCurrentStoreFromSnapshot(document))
  ) {
    return blockCorruptStore(document, { invalidate });
  }
  return true;
}

function clearStoreQuarantine() {
  storeQuarantineStatus = null;
  blockedStoreId = null;
}

function canExplicitlyResumeStore(document) {
  const documentId = String(document?.id ?? "");
  if (!documentId) {
    return false;
  }
  const persistedId = canonicalStoreIdSetting();
  const canResumeIdentity =
    isCanonicalStoreDocument(document) ||
    (!persistedId && documentId === blockedStoreId);
  if (!canResumeIdentity) {
    return false;
  }
  const classification = classifyStoreSchema(document);
  if (isSchemaBlocked(classification)) return false;
  if (!hasCurrentStoreCorruption(document)) return true;
  return Boolean(
    isAuthoritativeGM() &&
    hasCampaignTabLeadership() &&
    canRepairCurrentStoreFromSnapshot(document),
  );
}

function isVerifiedCanonicalStore(document) {
  return Boolean(
    document &&
    isCanonicalStoreDocument(document) &&
    hasPrivateOwnership(document) &&
    hasCompleteStorePayload(document),
  );
}

function snapshotStoreValues(document) {
  if (!isVerifiedCanonicalStore(document)) return null;
  return Object.fromEntries(
    PRIVATE_STATE_KEYS.map((key) => [key, documentValue(document, key)]),
  );
}

function hydrateCache(document) {
  if (!isVerifiedCanonicalStore(document)) return null;
  storeDocument = document;
  const changedKeys = [];
  for (const key of PRIVATE_STATE_KEYS) {
    const value = documentValue(document, key);
    if (!cache.has(key) || !valuesEqual(cache.get(key), value)) {
      changedKeys.push(key);
    }
    cache.set(key, value);
  }
  lastVerifiedStoreSnapshot = snapshotStoreValues(document);
  lastVerifiedStoreId = String(document?.id ?? "") || null;
  recoveryEvidenceObserved = true;
  return changedKeys;
}

function requestPrivateStateRetry() {
  if (!isFullGM()) return;
  const generation = lifecycleGeneration;
  void Promise.resolve()
    .then(() => {
      if (generation !== lifecycleGeneration || !isFullGM()) return false;
      return initializePrivateState();
    })
    .catch(() => {});
}

function invalidatePrivilegedStore(
  reason,
  {
    retainDocument = true,
    retry = true,
    status = {
      state: "pending",
      code: "store-unavailable",
      retryable: true,
    },
  } = {},
) {
  if (storeQuarantineStatus && status.state !== "blocked") {
    status = storeQuarantineStatus;
    retry = false;
  }
  const shouldRetry = !initializing;
  lifecycleGeneration += 1;
  cache.clear();
  if (!retainDocument) storeDocument = null;
  initialized = false;
  initialization = null;
  initializing = false;
  if (status.state !== "blocked" && !storeQuarantineStatus) {
    blockedStoreId = null;
  }
  setPrivateStateStatus(status);
  callPrivateStateChanged(PRIVATE_STATE_KEYS, reason);
  if (shouldRetry && retry) requestPrivateStateRetry();
}

function isCanonicalSettingUpdate(setting) {
  const rawKey = String(setting?.key ?? "");
  return Boolean(
    rawKey === `${MODULE_ID}.${SETTING_KEYS.PRIVATE_STATE_STORE_ID}` ||
    (String(setting?.namespace ?? "") === MODULE_ID &&
      rawKey === SETTING_KEYS.PRIVATE_STATE_STORE_ID),
  );
}

function resolveStoreWaiters(document) {
  for (const resolve of storeWaiters) resolve(document);
  storeWaiters.clear();
}

function unregisterSyncHooks() {
  for (const [event, id] of syncHookIds.splice(0)) {
    globalThis.Hooks?.off?.(event, id);
  }
  resolveStoreWaiters(null);
  syncHooksRegistered = false;
}

function registerSyncHooks() {
  if (
    syncHooksRegistered ||
    !isFullGM() ||
    typeof globalThis.Hooks?.on !== "function"
  ) {
    return;
  }
  syncHooksRegistered = true;

  syncHookIds.push([
    "createJournalEntry",
    globalThis.Hooks.on("createJournalEntry", (document) => {
      if (!isFullGM()) return;
      if (!isStoreDocument(document)) return;
      const canonical = findStoreDocument();
      if (!canonical || canonical?.id !== document?.id) {
        console.warn(
          `${MODULE_ID} | ignored a duplicate private state journal (${document.id})`,
        );
        return;
      }
      if (storeDocument?.id && document?.id !== storeDocument.id) return;
      const classification = classifyStoreSchema(document);
      if (isSchemaBlocked(classification)) {
        blockUnsupportedStoreSchema(document, classification, {
          invalidate: !initializing,
        });
        resolveStoreWaiters(document);
        return;
      }
      if (hasCurrentStoreCorruption(document)) {
        blockCorruptStore(document, { invalidate: !initializing });
        resolveStoreWaiters(document);
        return;
      }
      if (storeQuarantineStatus) {
        if (!canExplicitlyResumeStore(document)) return;
        if (!isVerifiedCanonicalStore(document)) {
          if (!isAuthoritativeGM()) {
            setPrivateStateStatus(storeQuarantineStatus);
            resolveStoreWaiters(document);
            return;
          }
          clearStoreQuarantine();
          resolveStoreWaiters(document);
          invalidatePrivilegedStore("canonical-replica-ready", {
            retainDocument: true,
            retry: false,
          });
          requestPrivateStateRetry();
          return;
        }
        clearStoreQuarantine();
      }
      const changedKeys = hydrateCache(document);
      if (changedKeys && !initializing) {
        initialized = true;
        setPrivateStateStatus({
          state: "ready",
          code: "ready",
          retryable: false,
          observedSchema: STORE_SCHEMA,
        });
      }
      resolveStoreWaiters(document);
      if (changedKeys) callPrivateStateChanged(changedKeys, "journal-create");
    }),
  ]);
  syncHookIds.push([
    "updateJournalEntry",
    globalThis.Hooks.on("updateJournalEntry", (document) => {
      if (!isFullGM()) return;
      const tracksCurrentStore =
        document?.id &&
        (document.id === storeDocument?.id ||
          String(document.id) === blockedStoreId ||
          String(document.id) === canonicalStoreIdSetting());
      if (!tracksCurrentStore) return;
      const classification = classifyStoreSchema(document);
      if (isSchemaBlocked(classification)) {
        blockUnsupportedStoreSchema(document, classification, {
          invalidate: !initializing,
        });
        return;
      }
      if (
        hasCurrentStoreCorruption(document) &&
        !(isAuthoritativeGM() && canRepairCurrentStoreFromSnapshot(document))
      ) {
        blockCorruptStore(document, { invalidate: !initializing });
        return;
      }
      if (storeQuarantineStatus) {
        if (!canExplicitlyResumeStore(document)) {
          setPrivateStateStatus(storeQuarantineStatus);
          return;
        }
        clearStoreQuarantine();
      }
      if (!initializing && privateStateStatus.state === "blocked") {
        invalidatePrivilegedStore("schema-retry", {
          retainDocument: true,
        });
        return;
      }
      if (!isVerifiedCanonicalStore(document)) {
        if (initializing) return;
        invalidatePrivilegedStore("journal-invalid", {
          retainDocument: isStoreDocument(document),
        });
        return;
      }
      const changedKeys = hydrateCache(document);
      if (changedKeys) {
        if (!initializing) {
          setPrivateStateStatus({
            state: "ready",
            code: "ready",
            retryable: false,
            observedSchema: STORE_SCHEMA,
          });
        }
        callPrivateStateChanged(changedKeys, "journal-update");
      }
    }),
  ]);
  syncHookIds.push([
    "deleteJournalEntry",
    globalThis.Hooks.on("deleteJournalEntry", (document) => {
      if (!isFullGM()) return;
      const deletedId = String(document?.id ?? "");
      const wasCanonical =
        deletedId &&
        (deletedId === String(storeDocument?.id ?? "") ||
          deletedId === blockedStoreId ||
          deletedId === canonicalStoreIdSetting());
      if (!wasCanonical) return;
      blockRecoveryRequired("missing-store", "journal-delete");
    }),
  ]);
  syncHookIds.push([
    "updateSetting",
    globalThis.Hooks.on("updateSetting", (setting) => {
      if (!isFullGM() || !isCanonicalSettingUpdate(setting)) return;
      const canonical = findStoreDocument();
      const classification = canonical ? classifyStoreSchema(canonical) : null;
      if (canonical && isSchemaBlocked(classification)) {
        blockUnsupportedStoreSchema(canonical, classification, {
          invalidate: !initializing,
        });
        return;
      }
      if (
        canonical &&
        hasCurrentStoreCorruption(canonical) &&
        !(isAuthoritativeGM() && canRepairCurrentStoreFromSnapshot(canonical))
      ) {
        blockCorruptStore(canonical, { invalidate: !initializing });
        return;
      }
      if (storeQuarantineStatus) {
        const canonicalId = String(canonical?.id ?? "");
        const requiresManualSelection = [
          "missing-store",
          "candidate-review-required",
        ].includes(storeQuarantineStatus.code);
        const selectsDifferentBlockedStore = Boolean(
          blockedStoreId && canonicalId && canonicalId !== blockedStoreId,
        );
        if (
          (requiresManualSelection || selectsDifferentBlockedStore) &&
          manualRecoveryTargetId !== canonicalId
        ) {
          setPrivateStateStatus(storeQuarantineStatus);
          resolveStoreWaiters(null);
          return;
        }
        if (!canonical || !canExplicitlyResumeStore(canonical)) {
          setPrivateStateStatus(storeQuarantineStatus);
          resolveStoreWaiters(null);
          return;
        }
        clearStoreQuarantine();
      }
      if (
        canonical &&
        !initializing &&
        privateStateStatus.state === "blocked"
      ) {
        invalidatePrivilegedStore("schema-retry", {
          retainDocument: true,
        });
        return;
      }
      if (canonical && isVerifiedCanonicalStore(canonical)) {
        const changedKeys = hydrateCache(canonical);
        if (!initializing) {
          initialized = true;
          initialization = null;
          setPrivateStateStatus({
            state: "ready",
            code: "ready",
            retryable: false,
            observedSchema: STORE_SCHEMA,
          });
        }
        resolveStoreWaiters(canonical);
        if (changedKeys) {
          callPrivateStateChanged(changedKeys, "canonical-identity");
        }
        return;
      }
      resolveStoreWaiters(null);
      if (!initializing) invalidatePrivilegedStore("canonical-identity");
    }),
  ]);
}

function resetForRoleTransition({ safeDefaults }) {
  lifecycleGeneration += 1;
  unregisterSyncHooks();
  cache.clear();
  storeDocument = null;
  if (!storeQuarantineStatus) blockedStoreId = null;
  initialized = false;
  initialization = null;
  initializing = false;
  lastWriterLeadershipGeneration = null;
  if (safeDefaults) {
    lastVerifiedStoreSnapshot = null;
    lastVerifiedStoreId = null;
    recoveryEvidenceObserved = false;
    storeQuarantineStatus = null;
    manualRecoveryTargetId = null;
    resetPrivateStateRecoveryServiceForTests();
    installSafeDefaults();
    initialized = true;
    setPrivateStateStatus({
      state: "ready",
      code: "safe-defaults",
      retryable: false,
    });
  } else {
    setPrivateStateStatus(
      storeQuarantineStatus ?? {
        state: "pending",
        code: "role-promotion",
        retryable: true,
      },
    );
  }
}

function onCurrentUserRoleChanged(user) {
  if (!user?.id || user.id !== globalThis.game?.user?.id) return;
  const nowFullGM = isFullGM(user);
  const wasFullGM = lastKnownFullGM;
  lastKnownFullGM = nowFullGM;
  if (wasFullGM === null || wasFullGM === nowFullGM) return;

  if (!nowFullGM) {
    resetForRoleTransition({ safeDefaults: true });
    callPrivateStateChanged(PRIVATE_STATE_KEYS, "role-demotion");
    return;
  }

  resetForRoleTransition({ safeDefaults: false });
  registerSyncHooks();
  callPrivateStateChanged(PRIVATE_STATE_KEYS, "role-promotion");
  const generation = lifecycleGeneration;
  void Promise.resolve()
    .then(() => {
      if (generation !== lifecycleGeneration || !isFullGM()) return false;
      return initializePrivateState();
    })
    .catch(() => {});
}

function onAuthorityPossiblyChanged() {
  const authorityId = authoritativeGMId();
  if (authorityId === lastKnownAuthorityId) return;
  lastKnownAuthorityId = authorityId;

  if (isFullGM()) {
    // Every full GM is allowed to hold the same restricted Journal cache. If
    // this client already verified that canonical store, changing which full
    // GM is authoritative must not create a transient empty-cache window.
    // Workflow stores apply their own authority epochs after this invalidation.
    // Retaining the verified cache also lets open GM applications rerender
    // cleanly during a live handoff instead of throwing StoreUnavailable.
    if (!isPrivilegedPrivateStateReady()) {
      resetForRoleTransition({ safeDefaults: false });
    }
    registerSyncHooks();
  } else {
    lifecycleGeneration += 1;
  }
  callPrivateStateChanged(PRIVATE_STATE_KEYS, "authority-change");

  if (!isFullGM()) return;
  const generation = lifecycleGeneration;
  void Promise.resolve()
    .then(() => {
      if (generation !== lifecycleGeneration || !isFullGM()) return false;
      return initializePrivateState();
    })
    .catch(() => {});
}

function onUserDocumentChanged(user) {
  onCurrentUserRoleChanged(user);
  onAuthorityPossiblyChanged();
}

function registerRoleHook() {
  if (
    roleHookId !== null ||
    typeof globalThis.Hooks?.on !== "function" ||
    !globalThis.game?.user
  ) {
    return;
  }
  lastKnownFullGM = isFullGM();
  lastKnownAuthorityId = authoritativeGMId();
  roleHookId = globalThis.Hooks.on("updateUser", onUserDocumentChanged);
  connectionHookId =
    globalThis.Hooks.on("userConnected", onAuthorityPossiblyChanged) ?? null;
}

function waitForStoreDocument() {
  const existing = findStoreDocument();
  if (existing) return Promise.resolve(existing);
  if (!syncHooksRegistered) return Promise.resolve(null);

  return new Promise((resolve) => {
    let timer = null;
    const finish = (document) => {
      if (!storeWaiters.delete(finish)) return;
      if (timer !== null) globalThis.clearTimeout(timer);
      resolve(document);
    };
    storeWaiters.add(finish);

    const afterSubscribe = findStoreDocument();
    if (afterSubscribe) {
      finish(afterSubscribe);
      return;
    }
    timer = globalThis.setTimeout(
      () => finish(findStoreDocument()),
      STORE_WAIT_MS,
    );
  });
}

async function createStoreDocument(initial, { recoverySource = null } = {}) {
  const none = noneOwnershipLevel();
  const values = Object.fromEntries(
    PRIVATE_STATE_KEYS.map((key) => [key, cleanValue(key, initial[key])]),
  );
  return globalThis.JournalEntry.create(
    {
      name: STORE_NAME,
      ownership: { default: none },
      flags: {
        [MODULE_ID]: {
          [STORE_MARKER]: true,
          schemaVersion: STORE_SCHEMA,
          ...values,
          ...(recoverySource
            ? { [RECOVERY_SOURCE_FLAG]: clone(recoverySource) }
            : {}),
        },
      },
    },
    { renderSheet: false },
  );
}

async function persistCanonicalStoreIdentity(document, isCurrent) {
  const documentId = String(document?.id ?? "").trim();
  if (!documentId || !isCurrent()) return false;
  if (!ensureStoreCanBeWritten(document)) return false;
  if (!isCurrent()) return false;
  await globalThis.game.settings.set(
    MODULE_ID,
    SETTING_KEYS.PRIVATE_STATE_STORE_ID,
    documentId,
  );
  if (!isCurrent()) return false;
  if (canonicalStoreIdSetting() !== documentId) {
    throw new Error("PrivateStateCanonicalIdentityVerificationFailed");
  }
  return true;
}

async function ensurePrivateStoreOwnership(document, isCurrent) {
  if (hasPrivateOwnership(document)) return true;
  if (!isCurrent()) return false;
  if (
    !ensureStoreCanBeWritten(document, {
      allowSnapshotRepair: true,
    })
  ) {
    return false;
  }
  if (!isCurrent()) return false;
  await document.update({ ownership: { default: noneOwnershipLevel() } });
  if (!isCurrent()) return false;
  if (!hasPrivateOwnership(document)) {
    throw new Error("PrivateStateOwnershipVerificationFailed");
  }
  return true;
}

function readLegacyState() {
  return Object.fromEntries(
    PRIVATE_STATE_KEYS.map((key) => [key, readLegacyValue(key)]),
  );
}

function legacyNeedsClearing(key, legacy) {
  if (!legacy.available) return false;
  return !valuesEqual(legacy.raw, defaultValue(key));
}

async function verifyAndClearLegacy(document, key, legacy, isCurrent) {
  if (!legacyNeedsClearing(key, legacy)) return;
  if (!isCurrent()) return false;
  if (!ensureStoreCanBeWritten(document)) return false;
  if (!isCurrent()) return false;
  await globalThis.game.settings.set(
    MODULE_ID,
    fieldDefinition(key).legacyKey,
    defaultValue(key),
  );
  if (!isCurrent()) return false;
  const cleared = readLegacyValue(key);
  if (
    !cleared.available ||
    !valuesEqual(cleared.value, defaultValue(key)) ||
    !isValidValue(key, cleared.raw)
  ) {
    throw new Error(`PrivateStateLegacyClearFailed:${key}`);
  }
  return true;
}

async function migrateStoreDocument(document, legacyState, isCurrent) {
  const expected = {};
  const updates = {};

  if (!isCurrent()) return false;
  if (
    !ensureStoreCanBeWritten(document, {
      allowSnapshotRepair: true,
    })
  )
    return false;
  if (!(await ensurePrivateStoreOwnership(document, isCurrent))) return false;
  for (const key of PRIVATE_STATE_KEYS) {
    const stored = readDocumentValue(document, key);
    expected[key] = stored.present
      ? stored.value
      : isValidValue(key, lastVerifiedStoreSnapshot?.[key])
        ? cleanValue(key, lastVerifiedStoreSnapshot[key])
        : legacyState[key].value;
    if (!stored.present) {
      updates[`flags.${MODULE_ID}.${key}`] = expected[key];
    }
  }
  const schemaVersion = classifyStoreSchema(document).observedSchema ?? 0;
  if (Object.keys(updates).length > 0) {
    if (
      !ensureStoreCanBeWritten(document, {
        allowSnapshotRepair: true,
      })
    )
      return false;
    if (!isCurrent()) return false;
    await document.update(updates);
  }
  if (!isCurrent()) return false;

  for (const key of PRIVATE_STATE_KEYS) {
    const stored = readDocumentValue(document, key);
    if (!stored.present || !valuesEqual(stored.value, expected[key])) {
      throw new Error(`PrivateStateMigrationVerificationFailed:${key}`);
    }
  }
  if (schemaVersion < STORE_SCHEMA) {
    if (!ensureStoreCanBeWritten(document)) return false;
    if (!isCurrent()) return false;
    await document.update({
      [`flags.${MODULE_ID}.schemaVersion`]: STORE_SCHEMA,
    });
    if (!isCurrent()) return false;
  }
  if (classifyStoreSchema(document).state !== "current") {
    throw new Error("PrivateStateMigrationVerificationFailed:schemaVersion");
  }
  if (!hasPrivateOwnership(document)) {
    throw new Error("PrivateStateMigrationVerificationFailed:ownership");
  }

  const changedKeys = hydrateCache(document);
  if (!changedKeys) {
    throw new Error("PrivateStateMigrationVerificationFailed:canonical");
  }
  for (const key of PRIVATE_STATE_KEYS) {
    const cleared = await verifyAndClearLegacy(
      document,
      key,
      legacyState[key],
      isCurrent,
    );
    if (cleared === false) return false;
  }
  return isCurrent() ? { changedKeys } : false;
}

/** Initialize and migrate the private store before any subsystem reads it. */
export function initializePrivateState() {
  if (isFoundryEnvironment() && !globalThis.game?.ready) {
    setPrivateStateStatus({
      state: "pending",
      code: "foundry-not-ready",
      retryable: true,
    });
    return Promise.resolve(false);
  }
  if (!isFoundryEnvironment()) {
    setPrivateStateStatus({
      state: "blocked",
      code: "not-in-foundry",
      retryable: false,
    });
    return Promise.resolve(false);
  }
  if (isLiveFoundry()) registerRoleHook();
  if (initialization) {
    const leadership = getCampaignTabLeadershipStatus();
    const needsWriterFinalization = Boolean(
      initialized &&
      isFullGM() &&
      isAuthoritativeGM() &&
      hasCampaignTabLeadership() &&
      leadership.generation !== lastWriterLeadershipGeneration,
    );
    if (!needsWriterFinalization) return initialization;
    initialization = null;
  }
  const generation = lifecycleGeneration;
  initializing = true;
  if (storeQuarantineStatus) {
    setPrivateStateStatus(storeQuarantineStatus);
  } else {
    setPrivateStateStatus({
      state: "pending",
      code: "initializing",
      retryable: false,
    });
  }
  let trackedInitialization;
  trackedInitialization = (async () => {
    if (!isFullGM()) {
      unregisterSyncHooks();
      storeDocument = null;
      installSafeDefaults();
      initialized = true;
      setPrivateStateStatus({
        state: "ready",
        code: "safe-defaults",
        retryable: false,
      });
      return true;
    }

    registerSyncHooks();
    const campaignLeader = await ensureCampaignTabLeadership();
    const leadershipGeneration = getCampaignTabLeadershipStatus().generation;
    const startingAuthorityId = authoritativeGMId();
    const currentUserId =
      String(globalThis.game?.user?.id ?? "").trim() || null;
    const isCurrent = () =>
      generation === lifecycleGeneration &&
      isFullGM() &&
      authoritativeGMId() === startingAuthorityId;
    const isCurrentWriter = () =>
      isCurrent() &&
      campaignLeader === true &&
      hasCampaignTabLeadership() &&
      getCampaignTabLeadershipStatus().generation === leadershipGeneration;
    if (!isCurrent()) return false;
    const authoritative =
      isAuthoritativeGM() &&
      currentUserId !== null &&
      startingAuthorityId === currentUserId &&
      isCurrentWriter();
    const legacyState = authoritative ? readLegacyState() : null;
    let document = findStoreDocument();
    if (storeQuarantineStatus) {
      if (!document) {
        setPrivateStateStatus(storeQuarantineStatus);
        return false;
      }
      const quarantinedClassification = classifyStoreSchema(document);
      if (isSchemaBlocked(quarantinedClassification)) {
        return blockUnsupportedStoreSchema(document, quarantinedClassification);
      }
      const manualRecovery =
        manualRecoveryTargetId === String(document?.id ?? "");
      const requiresManualSelection = [
        "missing-store",
        "candidate-review-required",
      ].includes(storeQuarantineStatus.code);
      if (
        (requiresManualSelection && !manualRecovery) ||
        (!manualRecovery && !canExplicitlyResumeStore(document))
      ) {
        if (hasCurrentStoreCorruption(document)) {
          return blockCorruptStore(document);
        }
        setPrivateStateStatus(storeQuarantineStatus);
        return false;
      }
      if (!authoritative && !isVerifiedCanonicalStore(document)) {
        setPrivateStateStatus(storeQuarantineStatus);
        return false;
      }
      clearStoreQuarantine();
    }
    const persistedStoreId = canonicalStoreIdSetting();
    const candidates = findStoreDocuments();
    if (!document && persistedStoreId) {
      return blockRecoveryRequired("missing-store", "canonical-unresolved");
    }
    if (!document && !persistedStoreId && candidates.length > 0) {
      return blockRecoveryRequired(
        "candidate-review-required",
        "candidate-review-required",
      );
    }
    if (!document && authoritative) {
      if (recoveryEvidenceObserved || lastVerifiedStoreSnapshot) {
        return blockRecoveryRequired("missing-store", "recovery-required");
      }
      const initial = Object.fromEntries(
        PRIVATE_STATE_KEYS.map((key) => [key, legacyState[key].value]),
      );
      if (!isCurrentWriter()) return false;
      const created = await createStoreDocument(initial);
      if (!isCurrentWriter()) return false;
      if (!created?.id) {
        console.warn(
          `${MODULE_ID} | private state store is not available yet; initialization will retry`,
        );
        return false;
      }
      const persisted = await persistCanonicalStoreIdentity(
        created,
        isCurrentWriter,
      );
      if (!persisted) return false;
      document = findStoreDocument() ?? created;
    } else if (!document && !campaignLeader) {
      setPrivateStateStatus({
        state: "pending",
        code: "campaign-leader-unavailable",
        retryable: false,
      });
      return false;
    } else if (!document) {
      document = await waitForStoreDocument();
    }
    if (!isCurrent()) return false;
    document = findStoreDocument() ?? document;
    if (!document) {
      console.warn(
        `${MODULE_ID} | private state store is not available yet; initialization will retry`,
      );
      return false;
    }
    if (!isCanonicalStoreDocument(document)) return false;
    if (
      !ensureStoreCanBeWritten(document, {
        allowSnapshotRepair: authoritative,
      })
    )
      return false;
    storeDocument = document;
    const isCurrentStore = () =>
      isCurrent() && isCanonicalStoreDocument(document);
    const isCurrentWritableStore = () =>
      isCurrentWriter() && isCanonicalStoreDocument(document);

    let changedKeys;
    if (authoritative) {
      const migration = await migrateStoreDocument(
        document,
        legacyState,
        isCurrentWritableStore,
      );
      if (!migration) return false;
      changedKeys = migration.changedKeys;
    } else {
      if (!isCurrentStore() || !isVerifiedCanonicalStore(document)) {
        if (!campaignLeader) {
          setPrivateStateStatus({
            state: "pending",
            code: "campaign-leader-unavailable",
            retryable: false,
          });
        }
        return false;
      }
      changedKeys = hydrateCache(document);
    }
    if (!changedKeys || !isCurrentStore()) return false;
    initialized = true;
    if (authoritative) {
      lastWriterLeadershipGeneration = leadershipGeneration;
    }
    clearStoreQuarantine();
    setPrivateStateStatus({
      state: "ready",
      code: "ready",
      retryable: false,
      observedSchema: STORE_SCHEMA,
    });
    callPrivateStateChanged(changedKeys, "store-ready");
    return true;
  })()
    .then((result) => {
      if (initialization === trackedInitialization) {
        initializing = false;
        if (!result) {
          initialization = null;
          if (
            privateStateStatus.state !== "blocked" &&
            privateStateStatus.code !== "campaign-leader-unavailable"
          ) {
            setPrivateStateStatus({
              state: "pending",
              code: "store-unavailable",
              retryable: true,
            });
          }
        }
      }
      return result;
    })
    .catch((error) => {
      if (initialization === trackedInitialization) {
        initializing = false;
        initialization = null;
        if (storeQuarantineStatus) {
          setPrivateStateStatus(storeQuarantineStatus);
        } else {
          setPrivateStateStatus({
            state: "pending",
            code: "initialization-error",
            retryable: true,
          });
        }
      }
      if (generation === lifecycleGeneration) {
        console.error(
          `${MODULE_ID} | private state initialization failed`,
          error,
        );
      }
      throw error;
    });
  initialization = trackedInitialization;
  return trackedInitialization;
}

/** Read cached private state. `undefined` means the live store is not ready. */
export function getPrivateState(key) {
  fieldDefinition(key);
  if (!initialized) return undefined;
  return cache.has(key) ? clone(cache.get(key)) : undefined;
}

function cleanPrivateStateUpdates(updates) {
  if (!updates || typeof updates !== "object" || Array.isArray(updates)) {
    throw new TypeError("Private-state updates must be a key/value object");
  }
  const entries = Object.entries(updates);
  if (entries.length === 0) {
    throw new TypeError("Private-state updates must not be empty");
  }
  return Object.fromEntries(
    entries.map(([key, value]) => {
      const definition = fieldDefinition(key);
      if (
        definition.type === "merchant-transactions" &&
        !isValidValue(key, value)
      ) {
        throw new TypeError(`InvalidPrivateStateValue:${key}`);
      }
      return [key, cleanValue(key, value)];
    }),
  );
}

function privateStateWriteContext(keys) {
  return keys.join(",");
}

function liveWriteFence(document) {
  const leadership = getCampaignTabLeadershipStatus();
  return Object.freeze({
    document,
    generation: lifecycleGeneration,
    userId: String(globalThis.game?.user?.id ?? ""),
    authorityId: authoritativeGMId(),
    leadershipGeneration: leadership.generation,
  });
}

function isLiveWriteFenceCurrent(fence) {
  return Boolean(
    fence?.document &&
    lifecycleGeneration === fence.generation &&
    isFullGM() &&
    isAuthoritativeGM() &&
    hasCampaignTabLeadership() &&
    String(globalThis.game?.user?.id ?? "") === fence.userId &&
    authoritativeGMId() === fence.authorityId &&
    getCampaignTabLeadershipStatus().generation ===
      fence.leadershipGeneration &&
    initialized &&
    storeDocument === fence.document &&
    isVerifiedCanonicalStore(fence.document),
  );
}

function privateStateWriteFenceError(context) {
  const error = new Error(`PrivateStateWriteAuthorityFenceFailed:${context}`);
  error.code = "PRIVATE_STATE_WRITE_AUTHORITY_FENCE_FAILED";
  return error;
}

function verifyPrivateStateWrite(document, cleaned) {
  for (const [key, expected] of Object.entries(cleaned)) {
    const stored = readDocumentValue(document, key);
    if (!stored.present || !valuesEqual(stored.value, expected)) {
      throw new Error(`PrivateStateWriteVerificationFailed:${key}`);
    }
  }
}

/**
 * Persist one or more private-state fields in one canonical Journal update.
 *
 * Optional guards let a caller implement a read/write/read-back fence around
 * moving state without weakening the default full-GM permission boundary.
 */
export async function setPrivateStates(
  updates,
  { beforeWrite = null, afterWrite = null } = {},
) {
  const cleaned = cleanPrivateStateUpdates(updates);
  const keys = Object.keys(cleaned);
  const context = privateStateWriteContext(keys);
  if (isFoundryEnvironment() && !globalThis.game?.ready) {
    setPrivateStateStatus({
      state: "pending",
      code: "foundry-not-ready",
      retryable: true,
    });
    throw createPrivateStateUnavailableError(context);
  }
  if (!isFoundryEnvironment()) {
    if (!globalThis.game?.settings?.set) {
      throw new Error("NotInFoundry: private state requires game.settings");
    }
    if (typeof beforeWrite === "function" && beforeWrite() !== true) {
      throw new Error(`PrivateStateWritePreconditionFailed:${context}`);
    }
    // This branch exists only for isolated node tests. Live Foundry writes use
    // the single Journal update below so related fields cannot be split across
    // separate persistence calls.
    for (const [key, value] of Object.entries(cleaned)) {
      const definition = fieldDefinition(key);
      await globalThis.game.settings.set(
        MODULE_ID,
        definition.legacyKey ?? key,
        value,
      );
    }
    if (typeof afterWrite === "function" && afterWrite() !== true) {
      throw new Error(`PrivateStateWritePostconditionFailed:${context}`);
    }
    return clone(cleaned);
  }
  if (!isFullGM()) {
    throw new Error("PermissionDenied: only a full GM may write private state");
  }
  const ready = await initializePrivateState();
  if (!ready) throw createPrivateStateUnavailableError(context);
  if (!isPrivilegedPrivateStateReady()) {
    throw createPrivateStateUnavailableError(context);
  }
  const document = storeDocument;
  const fence = liveWriteFence(document);
  if (typeof beforeWrite === "function" && beforeWrite() !== true) {
    throw new Error(`PrivateStateWritePreconditionFailed:${context}`);
  }
  if (
    !ensureStoreCanBeWritten(document, {
      invalidate: true,
    })
  ) {
    throw createPrivateStateUnavailableError(context);
  }
  if (!isLiveWriteFenceCurrent(fence)) {
    if (privateStateStatus.state === "blocked") {
      throw createPrivateStateUnavailableError(context);
    }
    throw privateStateWriteFenceError(context);
  }
  await document.update(
    Object.fromEntries(
      Object.entries(cleaned).map(([key, value]) => [
        `flags.${MODULE_ID}.${key}`,
        value,
      ]),
    ),
  );
  if (privateStateStatus.state === "blocked") {
    throw createPrivateStateUnavailableError(context);
  }
  if (!isLiveWriteFenceCurrent(fence)) {
    throw privateStateWriteFenceError(context);
  }
  verifyPrivateStateWrite(document, cleaned);
  if (typeof afterWrite === "function" && afterWrite() !== true) {
    throw new Error(`PrivateStateWritePostconditionFailed:${context}`);
  }
  if (
    !ensureStoreCanBeWritten(document, {
      invalidate: true,
    })
  ) {
    throw createPrivateStateUnavailableError(context);
  }
  if (!isLiveWriteFenceCurrent(fence)) {
    if (privateStateStatus.state === "blocked") {
      throw createPrivateStateUnavailableError(context);
    }
    throw privateStateWriteFenceError(context);
  }
  verifyPrivateStateWrite(document, cleaned);
  const changedKeys = hydrateCache(document);
  callPrivateStateChanged(changedKeys, "local-write");
  return clone(cleaned);
}

/** Persist one private-state field while retaining the historical return type. */
export async function setPrivateState(key, value, guards = {}) {
  const written = await setPrivateStates({ [key]: value }, guards);
  return clone(written[key]);
}

/**
 * Subscribe to private-state changes without exposing the stored values.
 * Returns the Foundry hook id, or null when Hooks are unavailable.
 */
export function onPrivateStateChanged(callback) {
  if (typeof callback !== "function") {
    throw new TypeError("Private-state change callback must be a function");
  }
  return globalThis.Hooks?.on?.(PRIVATE_STATE_CHANGED_HOOK, callback) ?? null;
}

export function isPrivateStateReady() {
  return initialized;
}

/** Whether this client currently holds a hydrated full-GM private store. */
export function isPrivilegedPrivateStateReady() {
  return Boolean(
    isFullGM() &&
    initialized &&
    storeDocument &&
    isVerifiedCanonicalStore(storeDocument),
  );
}

function recoveryPayload(document) {
  return Object.fromEntries(
    PRIVATE_STATE_KEYS.map((key) => [
      key,
      clone(document?.getFlag?.(MODULE_ID, key)),
    ]),
  );
}

function recoveryPayloadState(document) {
  let incomplete = false;
  let invalid = false;
  for (const key of PRIVATE_STATE_KEYS) {
    const raw = document?.getFlag?.(MODULE_ID, key);
    if (raw === undefined) incomplete = true;
    else if (!isValidValue(key, raw)) invalid = true;
  }
  if (invalid) return "invalid";
  return incomplete ? "incomplete" : "complete";
}

function recoveryOwnershipState(document) {
  const ownership = document?.ownership;
  if (!ownership || typeof ownership !== "object") return "unknown";
  if (!hasPrivateOwnership(document)) return "unsafe";
  const none = noneOwnershipLevel();
  const hasExplicitFullGmGrant = Object.entries(ownership).some(
    ([userId, rawLevel]) =>
      userId !== "default" &&
      Number(rawLevel) > none &&
      isFullGM(userById(userId)),
  );
  return hasExplicitFullGmGrant ? "restricted" : "private";
}

function recoveryCandidateDescriptor(document) {
  const id = String(document?.id ?? "").trim();
  const rawSchema = document?.getFlag?.(MODULE_ID, "schemaVersion");
  const classification = classifyStoreSchema(document);
  const rawRecoverySource = document?.getFlag?.(
    MODULE_ID,
    RECOVERY_SOURCE_FLAG,
  );
  const payload = recoveryPayload(document);
  return {
    id,
    createdTime: storeCreatedTime(document),
    modifiedTime: Number.isFinite(Number(document?._stats?.modifiedTime))
      ? Number(document._stats.modifiedTime)
      : null,
    marker: isStoreDocument(document),
    schemaState: rawSchema === undefined ? "missing" : classification.state,
    observedSchema: classification.observedSchema,
    payloadState: recoveryPayloadState(document),
    ownershipState: recoveryOwnershipState(document),
    payload,
    fingerprintInput: {
      id,
      marker: {
        present: document?.getFlag?.(MODULE_ID, STORE_MARKER) !== undefined,
        value: clone(document?.getFlag?.(MODULE_ID, STORE_MARKER)),
      },
      schemaVersion: {
        present: rawSchema !== undefined,
        value: clone(rawSchema),
      },
      ownership: clone(document?.ownership),
      fields: Object.fromEntries(
        PRIVATE_STATE_KEYS.map((key) => {
          const raw = document?.getFlag?.(MODULE_ID, key);
          return [key, { present: raw !== undefined, value: clone(raw) }];
        }),
      ),
      recoverySource: {
        present: rawRecoverySource !== undefined,
        value: clone(rawRecoverySource),
      },
    },
  };
}

function isRecoveryCandidateEligible(
  document,
  { requireCurrent = false } = {},
) {
  const candidate = recoveryCandidateDescriptor(document);
  const supportedSchema = requireCurrent
    ? candidate.schemaState === "current"
    : ["current", "legacy", "missing"].includes(candidate.schemaState);
  return Boolean(
    candidate.id &&
    candidate.marker &&
    supportedSchema &&
    candidate.payloadState === "complete" &&
    ["private", "restricted"].includes(candidate.ownershipState),
  );
}

function capturePrivateStateRecoveryState() {
  const fullGm = isFullGM();
  const leadership = getCampaignTabLeadershipStatus();
  const authoritative =
    fullGm && isAuthoritativeGM() && hasCampaignTabLeadership();
  const candidates = fullGm
    ? findStoreDocuments().map(recoveryCandidateDescriptor)
    : [];
  const snapshotAvailable = Boolean(fullGm && hasCompleteVerifiedSnapshot());
  return {
    authority: {
      fullGm,
      authoritative,
      userId:
        fullGm && globalThis.game?.user?.id
          ? String(globalThis.game.user.id)
          : null,
      leadershipGeneration: leadership.generation,
    },
    status: getPrivateStateStatus(),
    canonicalId: fullGm ? canonicalStoreIdSetting() : "",
    candidates,
    snapshot: snapshotAvailable
      ? {
          complete: true,
          sourceId: lastVerifiedStoreId,
          payload: clone(lastVerifiedStoreSnapshot),
        }
      : null,
  };
}

function assertRecoveryAuthority() {
  if (!isFullGM() || !isAuthoritativeGM() || !hasCampaignTabLeadership()) {
    throw new Error("PrivateStateRecoveryAuthorityRequired");
  }
}

async function setRecoveryCanonicalId(candidateId) {
  assertRecoveryAuthority();
  const id = String(candidateId ?? "").trim();
  const candidate = findStoreDocuments().find(
    (document) => String(document?.id ?? "") === id,
  );
  if (!candidate || !isRecoveryCandidateEligible(candidate)) {
    throw new Error("PrivateStateRecoveryCandidateIneligible");
  }
  await globalThis.game.settings.set(
    MODULE_ID,
    SETTING_KEYS.PRIVATE_STATE_STORE_ID,
    id,
  );
  if (canonicalStoreIdSetting() !== id) {
    throw new Error("PrivateStateRecoveryCanonicalReadbackFailed");
  }
  return true;
}

async function createRecoveryStoreDocument({ payload, recoverySource }) {
  assertRecoveryAuthority();
  const created = await createStoreDocument(payload, { recoverySource });
  if (
    !created?.id ||
    !isRecoveryCandidateEligible(created, { requireCurrent: true })
  ) {
    throw new Error("PrivateStateRecoveryCreateVerificationFailed");
  }
  return String(created.id);
}

async function hydrateRecoveryCanonical(candidateId) {
  assertRecoveryAuthority();
  const id = String(candidateId ?? "").trim();
  const candidate = findStoreDocument();
  if (
    !id ||
    canonicalStoreIdSetting() !== id ||
    String(candidate?.id ?? "") !== id ||
    manualRecoveryTargetId !== id ||
    !isRecoveryCandidateEligible(candidate)
  ) {
    throw new Error("PrivateStateRecoveryCandidateChanged");
  }
  lifecycleGeneration += 1;
  cache.clear();
  storeDocument = null;
  initialized = false;
  initialization = null;
  initializing = false;
  lastWriterLeadershipGeneration = null;
  clearStoreQuarantine();
  setPrivateStateStatus({
    state: "pending",
    code: "manual-recovery",
    retryable: false,
  });
  const ready = await initializePrivateState();
  if (!ready || !isPrivilegedPrivateStateReady()) {
    throw createPrivateStateUnavailableError("manual-recovery");
  }
  if (
    canonicalStoreIdSetting() !== id ||
    String(storeDocument?.id ?? "") !== id ||
    !isVerifiedCanonicalStore(storeDocument)
  ) {
    throw new Error("PrivateStateRecoveryReadbackFailed");
  }
  return true;
}

configurePrivateStateRecoveryService({
  captureState: capturePrivateStateRecoveryState,
  typedDefaults: () =>
    Object.fromEntries(
      PRIVATE_STATE_KEYS.map((key) => [key, defaultValue(key)]),
    ),
  setManualRecoveryTarget(candidateId) {
    manualRecoveryTargetId = String(candidateId ?? "").trim() || null;
  },
  clearManualRecoveryTarget(candidateId) {
    if (manualRecoveryTargetId === String(candidateId ?? "")) {
      manualRecoveryTargetId = null;
    }
  },
  setCanonicalId: setRecoveryCanonicalId,
  createRecoveryDocument: createRecoveryStoreDocument,
  hydrateCanonical: hydrateRecoveryCanonical,
});

/** Test-only reset; harmless when imported by the Foundry runtime. */
export function resetPrivateStateForTests() {
  lifecycleGeneration += 1;
  unregisterSyncHooks();
  if (roleHookId !== null) {
    globalThis.Hooks?.off?.("updateUser", roleHookId);
  }
  if (connectionHookId !== null) {
    globalThis.Hooks?.off?.("userConnected", connectionHookId);
  }
  cache.clear();
  storeDocument = null;
  initialized = false;
  initialization = null;
  initializing = false;
  lastWriterLeadershipGeneration = null;
  syncHooksRegistered = false;
  roleHookId = null;
  connectionHookId = null;
  lastKnownFullGM = null;
  lastKnownAuthorityId = null;
  lastVerifiedStoreSnapshot = null;
  lastVerifiedStoreId = null;
  recoveryEvidenceObserved = false;
  blockedStoreId = null;
  storeQuarantineStatus = null;
  manualRecoveryTargetId = null;
  resetPrivateStateRecoveryServiceForTests();
  privateStateStatus = createPrivateStateStatus();
}
