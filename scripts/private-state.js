/**
 * GM-only persistent state backed by a restricted JournalEntry.
 *
 * Foundry world settings are readable by every connected client even when
 * `config:false`. Merchant economy and unrevealed faction records therefore
 * live on a JournalEntry with default NONE ownership and are cached only on GM
 * clients. Legacy settings are migrated once and then cleared.
 */

import { isAuthoritativeGM } from "./socket-authority.js";

const MODULE_ID = "infinity-dnd5e";
const STORE_MARKER = "privateStateStore";
const STORE_SCHEMA = 1;
const STORE_NAME = "[Infinity D&D5e] Private State";
const STORE_WAIT_MS = 5000;
const LEGACY_KEYS = Object.freeze({
  merchants: "merchants",
  factions: "factions",
});

const cache = new Map();
const storeWaiters = new Set();
const syncHookIds = [];
let storeDocument = null;
let initialized = false;
let initialization = null;
let initializing = false;
let syncHooksRegistered = false;

function clone(value) {
  if (value == null) return value;
  return (
    globalThis.foundry?.utils?.deepClone?.(value) ?? structuredClone(value)
  );
}

function isLiveFoundry() {
  return Boolean(globalThis.game?.ready && globalThis.JournalEntry?.create);
}

function legacyValue(key) {
  try {
    const value = globalThis.game?.settings?.get?.(MODULE_ID, LEGACY_KEYS[key]);
    return Array.isArray(value) ? clone(value) : [];
  } catch {
    return [];
  }
}

function documentValue(document, key) {
  const value = document?.getFlag?.(MODULE_ID, key);
  return Array.isArray(value) ? clone(value) : [];
}

function isStoreDocument(document) {
  return document?.getFlag?.(MODULE_ID, STORE_MARKER) === true;
}

function findStoreDocument() {
  return (
    globalThis.game?.journal?.find?.((entry) => isStoreDocument(entry)) ?? null
  );
}

function hydrateCache(document) {
  if (!document) return;
  storeDocument = document;
  for (const key of Object.keys(LEGACY_KEYS)) {
    cache.set(key, documentValue(document, key));
  }
}

function resolveStoreWaiters(document) {
  for (const resolve of storeWaiters) resolve(document);
  storeWaiters.clear();
}

function registerSyncHooks() {
  if (
    syncHooksRegistered ||
    !globalThis.game?.user?.isGM ||
    typeof globalThis.Hooks?.on !== "function"
  ) {
    return;
  }
  syncHooksRegistered = true;

  syncHookIds.push([
    "createJournalEntry",
    globalThis.Hooks.on("createJournalEntry", (document) => {
      if (!isStoreDocument(document)) return;
      if (storeDocument?.id && document?.id !== storeDocument.id) {
        console.warn(
          `${MODULE_ID} | ignored a duplicate private state journal (${document.id})`,
        );
        return;
      }
      hydrateCache(document);
      if (!initializing) initialized = true;
      resolveStoreWaiters(document);
    }),
  ]);
  syncHookIds.push([
    "updateJournalEntry",
    globalThis.Hooks.on("updateJournalEntry", (document) => {
      if (!isStoreDocument(document)) return;
      if (storeDocument?.id && document?.id !== storeDocument.id) return;
      hydrateCache(document);
    }),
  ]);
  syncHookIds.push([
    "deleteJournalEntry",
    globalThis.Hooks.on("deleteJournalEntry", (document) => {
      if (!isStoreDocument(document)) return;
      if (storeDocument?.id && document?.id !== storeDocument.id) return;
      cache.clear();
      storeDocument = null;
      initialized = false;
      initialization = null;
    }),
  ]);
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
  const none = globalThis.CONST?.DOCUMENT_OWNERSHIP_LEVELS?.NONE ?? 0;
  return globalThis.JournalEntry.create(
    {
      name: STORE_NAME,
      ownership: { default: none },
      flags: {
        [MODULE_ID]: {
          [STORE_MARKER]: true,
          schemaVersion: STORE_SCHEMA,
          merchants: initial.merchants,
          factions: initial.factions,
        },
      },
    },
    { renderSheet: false },
  );
}

/** Initialize and migrate the private store before any subsystem reads it. */
export function initializePrivateState() {
  if (initialization) return initialization;
  initializing = true;
  initialization = (async () => {
    if (!isLiveFoundry()) {
      initialized = true;
      return false;
    }
    if (!globalThis.game?.user?.isGM) {
      cache.set("merchants", []);
      cache.set("factions", []);
      initialized = true;
      return true;
    }

    registerSyncHooks();
    const legacy = {
      merchants: legacyValue("merchants"),
      factions: legacyValue("factions"),
    };
    storeDocument = findStoreDocument();
    if (!storeDocument && isAuthoritativeGM()) {
      storeDocument = await createStoreDocument(legacy);
    } else if (!storeDocument) {
      storeDocument = await waitForStoreDocument();
    }
    if (!storeDocument) {
      console.warn(
        `${MODULE_ID} | private state store is not available yet; initialization will retry`,
      );
      return false;
    }

    for (const key of Object.keys(LEGACY_KEYS)) {
      const stored = documentValue(storeDocument, key);
      const value = stored.length > 0 ? stored : legacy[key];
      cache.set(key, value);
      if (stored.length === 0 && value.length > 0) {
        await storeDocument.update({ [`flags.${MODULE_ID}.${key}`]: value });
      }
      if (legacy[key].length > 0) {
        await globalThis.game.settings.set(MODULE_ID, LEGACY_KEYS[key], []);
      }
    }
    initialized = true;
    return true;
  })()
    .then((result) => {
      initializing = false;
      if (!result && !initialized) initialization = null;
      return result;
    })
    .catch((error) => {
      initializing = false;
      initialization = null;
      console.error(
        `${MODULE_ID} | private state initialization failed`,
        error,
      );
      throw error;
    });
  return initialization;
}

/** Read cached private state. `undefined` means the live store is not ready. */
export function getPrivateState(key) {
  if (!initialized) return undefined;
  return cache.has(key) ? clone(cache.get(key)) : undefined;
}

/** Persist private state, falling back to legacy settings in node tests. */
export async function setPrivateState(key, value) {
  const cleaned = Array.isArray(value) ? clone(value) : [];
  if (!isLiveFoundry()) {
    if (!globalThis.game?.settings?.set) {
      throw new Error("NotInFoundry: private state requires game.settings");
    }
    await globalThis.game.settings.set(MODULE_ID, LEGACY_KEYS[key], cleaned);
    return cleaned;
  }
  if (!globalThis.game?.user?.isGM) {
    throw new Error("PermissionDenied: only a GM may write private state");
  }
  await initializePrivateState();
  if (!storeDocument) throw new Error("PrivateStateUnavailable");
  await storeDocument.update({ [`flags.${MODULE_ID}.${key}`]: cleaned });
  cache.set(key, cleaned);
  return clone(cleaned);
}

export function isPrivateStateReady() {
  return initialized;
}

/** Test-only reset; harmless when imported by the Foundry runtime. */
export function resetPrivateStateForTests() {
  for (const [event, id] of syncHookIds.splice(0)) {
    globalThis.Hooks?.off?.(event, id);
  }
  resolveStoreWaiters(null);
  cache.clear();
  storeDocument = null;
  initialized = false;
  initialization = null;
  initializing = false;
  syncHooksRegistered = false;
}
