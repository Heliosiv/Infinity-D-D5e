/**
 * GM-only persistent state backed by a restricted JournalEntry.
 *
 * Foundry world settings are readable by every connected client even when
 * `config:false`. Merchant economy and unrevealed faction records therefore
 * live on a JournalEntry with default NONE ownership and are cached only on GM
 * clients. Legacy settings are migrated once and then cleared.
 */

const MODULE_ID = "infinity-dnd5e";
const STORE_MARKER = "privateStateStore";
const STORE_SCHEMA = 1;
const STORE_NAME = "[Infinity D&D5e] Private State";
const LEGACY_KEYS = Object.freeze({
  merchants: "merchants",
  factions: "factions",
});

const cache = new Map();
let storeDocument = null;
let initialized = false;
let initialization = null;

function clone(value) {
  if (value == null) return value;
  return globalThis.foundry?.utils?.deepClone?.(value) ?? structuredClone(value);
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

function findStoreDocument() {
  return (
    globalThis.game?.journal?.find?.(
      (entry) => entry?.getFlag?.(MODULE_ID, STORE_MARKER) === true,
    ) ?? null
  );
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

    const legacy = {
      merchants: legacyValue("merchants"),
      factions: legacyValue("factions"),
    };
    storeDocument = findStoreDocument();
    if (!storeDocument) storeDocument = await createStoreDocument(legacy);

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
  })().catch((error) => {
    initialization = null;
    console.error(`${MODULE_ID} | private state initialization failed`, error);
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
  cache.clear();
  storeDocument = null;
  initialized = false;
  initialization = null;
}
