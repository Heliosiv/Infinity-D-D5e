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
import { SETTING_KEYS } from "./settings.js";
import { authoritativeGMId, isAuthoritativeGM } from "./socket-authority.js";
import { persistedValuesEqual } from "./utils/persisted-data.js";

const MODULE_ID = "infinity-dnd5e";
const STORE_MARKER = "privateStateStore";
const STORE_SCHEMA = 5;
const STORE_NAME = "[Infinity D&D5e] Private State";
const STORE_WAIT_MS = 5000;
const PRIVATE_STATE_FIELDS = Object.freeze({
  merchants: Object.freeze({ legacyKey: "merchants", type: "array" }),
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
let syncHooksRegistered = false;
let roleHookId = null;
let connectionHookId = null;
let lastKnownFullGM = null;
let lastKnownAuthorityId = null;
let lifecycleGeneration = 0;
let lastVerifiedStoreSnapshot = null;
let replacementRequired = false;
const retiredStoreIds = new Set();

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
  const definition = PRIVATE_STATE_FIELDS[key];
  if (!definition) throw new Error(`UnknownPrivateStateKey:${key}`);
  return definition;
}

function defaultValue(key) {
  return fieldDefinition(key).type === "array" ? [] : {};
}

function isValidValue(key, value) {
  if (fieldDefinition(key).type === "array") return Array.isArray(value);
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
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
  return documents
    .filter((document) => !retiredStoreIds.has(String(document?.id ?? "")))
    .sort(compareStoreDocuments);
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
  if (
    storeDocument?.id &&
    documents.some((document) => document?.id === storeDocument.id)
  ) {
    return storeDocument;
  }
  return null;
}

function electStoreDocument() {
  return findStoreDocuments()[0] ?? null;
}

function isCanonicalStoreDocument(document) {
  const persistedId = canonicalStoreIdSetting();
  return Boolean(
    document?.id &&
    persistedId &&
    String(document.id) === persistedId &&
    !retiredStoreIds.has(String(document.id)),
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
  const schemaVersion = Number(document?.getFlag?.(MODULE_ID, "schemaVersion"));
  return Boolean(
    isStoreDocument(document) &&
    Number.isSafeInteger(schemaVersion) &&
    schemaVersion >= STORE_SCHEMA &&
    PRIVATE_STATE_KEYS.every((key) => readDocumentValue(document, key).present),
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

function invalidatePrivilegedStore(reason, { retainDocument = true } = {}) {
  const shouldRetry = !initializing;
  lifecycleGeneration += 1;
  cache.clear();
  if (!retainDocument) storeDocument = null;
  initialized = false;
  initialization = null;
  initializing = false;
  callPrivateStateChanged(PRIVATE_STATE_KEYS, reason);
  if (shouldRetry) requestPrivateStateRetry();
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
      if (retiredStoreIds.has(String(document?.id ?? ""))) return;
      const canonical = findStoreDocument();
      if (!canonical || canonical?.id !== document?.id) {
        console.warn(
          `${MODULE_ID} | ignored a duplicate private state journal (${document.id})`,
        );
        return;
      }
      if (storeDocument?.id && document?.id !== storeDocument.id) return;
      const changedKeys = hydrateCache(document);
      if (changedKeys && !initializing) initialized = true;
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
          String(document.id) === canonicalStoreIdSetting());
      if (!tracksCurrentStore) return;
      if (!isVerifiedCanonicalStore(document)) {
        if (initializing) return;
        invalidatePrivilegedStore("journal-invalid", {
          retainDocument: isStoreDocument(document),
        });
        return;
      }
      const changedKeys = hydrateCache(document);
      if (changedKeys) callPrivateStateChanged(changedKeys, "journal-update");
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
          deletedId === canonicalStoreIdSetting());
      if (!wasCanonical) return;
      retiredStoreIds.add(deletedId);
      for (const candidate of findStoreDocuments()) {
        retiredStoreIds.add(String(candidate?.id ?? ""));
      }
      replacementRequired = true;
      invalidatePrivilegedStore("journal-delete", { retainDocument: false });
    }),
  ]);
  syncHookIds.push([
    "updateSetting",
    globalThis.Hooks.on("updateSetting", (setting) => {
      if (!isFullGM() || !isCanonicalSettingUpdate(setting)) return;
      const canonical = findStoreDocument();
      if (canonical && isVerifiedCanonicalStore(canonical)) {
        const changedKeys = hydrateCache(canonical);
        if (!initializing) {
          initialized = true;
          initialization = null;
        }
        replacementRequired = false;
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
  initialized = false;
  initialization = null;
  initializing = false;
  if (safeDefaults) {
    lastVerifiedStoreSnapshot = null;
    replacementRequired = false;
    installSafeDefaults();
    initialized = true;
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
    resetForRoleTransition({ safeDefaults: false });
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

async function createStoreDocument(initial) {
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
        },
      },
    },
    { renderSheet: false },
  );
}

async function persistCanonicalStoreIdentity(document, isCurrent) {
  const documentId = String(document?.id ?? "").trim();
  if (!documentId || !isCurrent()) return false;
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

async function verifyAndClearLegacy(key, legacy, isCurrent) {
  if (!legacyNeedsClearing(key, legacy)) return;
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
  const schemaVersion = Math.floor(
    Number(document?.getFlag?.(MODULE_ID, "schemaVersion")) || 0,
  );
  if (schemaVersion < STORE_SCHEMA) {
    updates[`flags.${MODULE_ID}.schemaVersion`] = STORE_SCHEMA;
  }
  if (Object.keys(updates).length > 0) await document.update(updates);
  if (!isCurrent()) return false;

  for (const key of PRIVATE_STATE_KEYS) {
    const stored = readDocumentValue(document, key);
    if (!stored.present || !valuesEqual(stored.value, expected[key])) {
      throw new Error(`PrivateStateMigrationVerificationFailed:${key}`);
    }
  }
  const verifiedSchema = Math.floor(
    Number(document?.getFlag?.(MODULE_ID, "schemaVersion")) || 0,
  );
  if (verifiedSchema < STORE_SCHEMA) {
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
    return Promise.resolve(false);
  }
  if (!isFoundryEnvironment()) {
    return Promise.resolve(false);
  }
  if (isLiveFoundry()) registerRoleHook();
  if (initialization) return initialization;
  const generation = lifecycleGeneration;
  initializing = true;
  let trackedInitialization;
  trackedInitialization = (async () => {
    if (!isFullGM()) {
      unregisterSyncHooks();
      storeDocument = null;
      installSafeDefaults();
      initialized = true;
      return true;
    }

    registerSyncHooks();
    const startingAuthorityId = authoritativeGMId();
    const currentUserId =
      String(globalThis.game?.user?.id ?? "").trim() || null;
    const isCurrent = () =>
      generation === lifecycleGeneration &&
      isFullGM() &&
      authoritativeGMId() === startingAuthorityId;
    if (!isCurrent()) return false;
    const authoritative =
      isAuthoritativeGM() &&
      currentUserId !== null &&
      startingAuthorityId === currentUserId;
    const legacyState = authoritative ? readLegacyState() : null;
    let document = findStoreDocument();
    const persistedStoreId = canonicalStoreIdSetting();
    if (
      !document &&
      persistedStoreId &&
      authoritative &&
      !replacementRequired
    ) {
      if (!lastVerifiedStoreSnapshot) {
        console.warn(
          `${MODULE_ID} | persisted private state store (${persistedStoreId}) is unresolved; refusing automatic replacement without a verified snapshot`,
        );
        return false;
      }
      for (const candidate of findStoreDocuments()) {
        retiredStoreIds.add(String(candidate?.id ?? ""));
      }
      replacementRequired = true;
    }
    if (!document && authoritative && !replacementRequired) {
      document = electStoreDocument();
      if (document) {
        const persisted = await persistCanonicalStoreIdentity(
          document,
          isCurrent,
        );
        if (!persisted) return false;
      }
    }
    if (!document && authoritative) {
      const recoveryInitial =
        replacementRequired && lastVerifiedStoreSnapshot
          ? lastVerifiedStoreSnapshot
          : Object.fromEntries(
              PRIVATE_STATE_KEYS.map((key) => [key, legacyState[key].value]),
            );
      const created = await createStoreDocument(recoveryInitial);
      if (!isCurrent()) return false;
      if (!created?.id) {
        console.warn(
          `${MODULE_ID} | private state store is not available yet; initialization will retry`,
        );
        return false;
      }
      const persisted = await persistCanonicalStoreIdentity(created, isCurrent);
      if (!persisted) return false;
      document = findStoreDocument() ?? created;
      replacementRequired = false;
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
    storeDocument = document;
    const isCurrentStore = () =>
      isCurrent() && isCanonicalStoreDocument(document);

    let changedKeys;
    if (authoritative) {
      const migration = await migrateStoreDocument(
        document,
        legacyState,
        isCurrentStore,
      );
      if (!migration) return false;
      changedKeys = migration.changedKeys;
    } else {
      if (!isCurrentStore() || !isVerifiedCanonicalStore(document)) {
        return false;
      }
      changedKeys = hydrateCache(document);
    }
    if (!changedKeys || !isCurrentStore()) return false;
    initialized = true;
    callPrivateStateChanged(changedKeys, "store-ready");
    return true;
  })()
    .then((result) => {
      if (initialization === trackedInitialization) {
        initializing = false;
        if (!result) initialization = null;
      }
      return result;
    })
    .catch((error) => {
      if (initialization === trackedInitialization) {
        initializing = false;
        initialization = null;
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

/**
 * Persist private state, falling back to legacy settings in node tests.
 *
 * Optional guards let a caller implement a read/write/read-back fence around
 * moving state without weakening the default full-GM permission boundary.
 */
export async function setPrivateState(
  key,
  value,
  { beforeWrite = null, afterWrite = null } = {},
) {
  const definition = fieldDefinition(key);
  const cleaned = cleanValue(key, value);
  if (isFoundryEnvironment() && !globalThis.game?.ready) {
    throw new Error("PrivateStateUnavailable: Foundry is not ready");
  }
  if (!isFoundryEnvironment()) {
    if (!globalThis.game?.settings?.set) {
      throw new Error("NotInFoundry: private state requires game.settings");
    }
    if (typeof beforeWrite === "function" && beforeWrite() !== true) {
      throw new Error(`PrivateStateWritePreconditionFailed:${key}`);
    }
    await globalThis.game.settings.set(
      MODULE_ID,
      definition.legacyKey ?? key,
      cleaned,
    );
    if (typeof afterWrite === "function" && afterWrite() !== true) {
      throw new Error(`PrivateStateWritePostconditionFailed:${key}`);
    }
    return cleaned;
  }
  if (!isFullGM()) {
    throw new Error("PermissionDenied: only a full GM may write private state");
  }
  const ready = await initializePrivateState();
  if (!ready) throw new Error("PrivateStateUnavailable");
  if (!isPrivilegedPrivateStateReady()) {
    throw new Error("PrivateStateUnavailable");
  }
  const document = storeDocument;
  if (typeof beforeWrite === "function" && beforeWrite() !== true) {
    throw new Error(`PrivateStateWritePreconditionFailed:${key}`);
  }
  await document.update({ [`flags.${MODULE_ID}.${key}`]: cleaned });
  if (
    !isFullGM() ||
    storeDocument !== document ||
    !isVerifiedCanonicalStore(document)
  ) {
    throw new Error("PermissionDenied: only a full GM may write private state");
  }
  const stored = readDocumentValue(document, key);
  if (!stored.present || !valuesEqual(stored.value, cleaned)) {
    throw new Error(`PrivateStateWriteVerificationFailed:${key}`);
  }
  if (typeof afterWrite === "function" && afterWrite() !== true) {
    throw new Error(`PrivateStateWritePostconditionFailed:${key}`);
  }
  const changedKeys = hydrateCache(document);
  callPrivateStateChanged(changedKeys, "local-write");
  return clone(cleaned);
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
  syncHooksRegistered = false;
  roleHookId = null;
  connectionHookId = null;
  lastKnownFullGM = null;
  lastKnownAuthorityId = null;
  lastVerifiedStoreSnapshot = null;
  replacementRequired = false;
  retiredStoreIds.clear();
}
