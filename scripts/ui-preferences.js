/**
 * Infinity D&D5e - client UI preference schema and storage helpers.
 *
 * This module is deliberately independent from every application. It can be
 * imported in Node tests before Foundry creates `game`, and it only writes the
 * small allowlisted preference shape documented below.
 */

import { SETTINGS_MODULE_ID } from "./settings.js";

export const UI_PREFERENCES_SCHEMA_VERSION = 1;
export const UI_PREFERENCES_SETTING_KEY = "uiPreferences";
export const UI_DENSITY_ATTRIBUTE = "data-infinity-density";
export const UI_DENSITIES = Object.freeze(["comfortable", "compact"]);
export const LOOT_STUDIO_MODES = Object.freeze([
  "encounter",
  "hoard",
  "creature",
]);

const IDENTIFIER_PATTERN = /^[a-z0-9][a-z0-9._:-]{0,79}$/i;
const MAX_DISMISSED_QUICK_STARTS = 64;
const MAX_ADVANCED_DISCLOSURES = 128;
const preferenceWriteQueues = new WeakMap();
let fallbackPreferenceWriteQueue = Promise.resolve();

export const UI_PREFERENCES_DEFAULTS = Object.freeze({
  version: UI_PREFERENCES_SCHEMA_VERSION,
  density: "comfortable",
  lastLootStudioMode: "encounter",
  dismissedQuickStarts: Object.freeze([]),
  advancedDisclosures: Object.freeze({}),
});

/** Return a mutable fresh copy so no caller can modify shared defaults. */
export function createDefaultUiPreferences() {
  return {
    version: UI_PREFERENCES_SCHEMA_VERSION,
    density: UI_PREFERENCES_DEFAULTS.density,
    lastLootStudioMode: UI_PREFERENCES_DEFAULTS.lastLootStudioMode,
    dismissedQuickStarts: [],
    advancedDisclosures: {},
  };
}

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function sanitizeIdentifier(value) {
  if (typeof value !== "string") return "";
  const identifier = value.trim();
  return IDENTIFIER_PATTERN.test(identifier) ? identifier : "";
}

function sanitizeIdentifierList(value) {
  if (!Array.isArray(value)) return [];
  const seen = new Set();
  const identifiers = [];
  for (const candidate of value) {
    const identifier = sanitizeIdentifier(candidate);
    if (!identifier || seen.has(identifier)) continue;
    seen.add(identifier);
    identifiers.push(identifier);
    if (identifiers.length >= MAX_DISMISSED_QUICK_STARTS) break;
  }
  return identifiers;
}

function sanitizeDisclosureMap(value) {
  if (!isRecord(value)) return {};
  const entries = [];
  for (const [candidate, expanded] of Object.entries(value)) {
    const identifier = sanitizeIdentifier(candidate);
    if (!identifier || typeof expanded !== "boolean") continue;
    entries.push([identifier, expanded]);
    if (entries.length >= MAX_ADVANCED_DISCLOSURES) break;
  }
  return Object.fromEntries(entries);
}

function firstDefined(record, keys, fallback) {
  for (const key of keys) {
    if (record[key] !== undefined) return record[key];
  }
  return fallback;
}

/**
 * Reduce any persisted or caller-provided value to the complete v1 schema.
 * Unknown properties are dropped. The former `lastLootMode` spelling and
 * early quick-start field spellings are accepted as read-only aliases.
 */
export function normalizeUiPreferences(value) {
  const record = isRecord(value) ? value : {};
  const density = UI_DENSITIES.includes(record.density)
    ? record.density
    : UI_PREFERENCES_DEFAULTS.density;
  const requestedLootMode = firstDefined(
    record,
    ["lastLootStudioMode", "lastLootMode"],
    UI_PREFERENCES_DEFAULTS.lastLootStudioMode,
  );
  const lastLootStudioMode = LOOT_STUDIO_MODES.includes(requestedLootMode)
    ? requestedLootMode
    : UI_PREFERENCES_DEFAULTS.lastLootStudioMode;
  const dismissedQuickStarts = sanitizeIdentifierList(
    firstDefined(
      record,
      [
        "dismissedQuickStarts",
        "dismissedQuickStartIdentifiers",
        "dismissedQuickStartVersions",
      ],
      [],
    ),
  );

  return {
    version: UI_PREFERENCES_SCHEMA_VERSION,
    density,
    lastLootStudioMode,
    dismissedQuickStarts,
    advancedDisclosures: sanitizeDisclosureMap(record.advancedDisclosures),
  };
}

/**
 * Foundry registration options for the hidden, client-scoped Object setting.
 * A fresh default object is returned each time to avoid shared mutation.
 */
export function createUiPreferencesSettingDefinition({ onChange } = {}) {
  const definition = {
    name: "Infinity UI Preferences",
    hint: "Stores this browser's Infinity layout and onboarding preferences.",
    scope: "client",
    config: false,
    type: Object,
    default: createDefaultUiPreferences(),
  };
  if (typeof onChange === "function") definition.onChange = onChange;
  return definition;
}

/**
 * Register the preference setting during Foundry's init hook. Returns false
 * without throwing when called in Node or before game.settings is available.
 */
export function registerUiPreferencesSetting(
  gameInstance = globalThis.game,
  options = {},
) {
  if (typeof gameInstance?.settings?.register !== "function") return false;
  try {
    gameInstance.settings.register(
      SETTINGS_MODULE_ID,
      UI_PREFERENCES_SETTING_KEY,
      createUiPreferencesSettingDefinition(options),
    );
    return true;
  } catch (error) {
    globalThis.console?.warn?.(
      `${SETTINGS_MODULE_ID} | failed to register UI preferences`,
      error,
    );
    return false;
  }
}

/**
 * Read and normalize preferences. Missing Foundry globals, unregistered
 * settings, and corrupt persisted values all resolve to safe defaults.
 */
export function getUiPreferences(gameInstance = globalThis.game) {
  try {
    const stored = gameInstance?.settings?.get?.(
      SETTINGS_MODULE_ID,
      UI_PREFERENCES_SETTING_KEY,
    );
    return normalizeUiPreferences(stored);
  } catch {
    return createDefaultUiPreferences();
  }
}

/**
 * Persist a complete sanitized preference value. In Node or before Foundry is
 * ready this is a safe no-op and still returns the normalized value. A live
 * Foundry write failure rejects so the calling application cannot claim the
 * preference was saved.
 */
export async function setUiPreferences(value, gameInstance = globalThis.game) {
  const normalized = normalizeUiPreferences(value);
  return enqueuePreferenceWrite(gameInstance, () =>
    persistUiPreferences(normalized, gameInstance),
  );
}

/**
 * Merge a partial update into the current client preferences and persist it.
 * Writes are serialized per Foundry game instance, and disclosure keys merge,
 * so overlapping windows cannot erase one another's preference fields.
 */
export async function updateUiPreferences(
  patch,
  gameInstance = globalThis.game,
) {
  if (!isRecord(patch)) return getUiPreferences(gameInstance);
  return enqueuePreferenceWrite(gameInstance, () => {
    const current = getUiPreferences(gameInstance);
    return persistUiPreferences(
      mergeUiPreferencePatch(current, patch),
      gameInstance,
    );
  });
}

/** Add one safe quick-start identifier to the dismissed set. */
export async function dismissQuickStart(
  identifier,
  gameInstance = globalThis.game,
) {
  const safeIdentifier = sanitizeIdentifier(identifier);
  if (!safeIdentifier) return getUiPreferences(gameInstance);
  return enqueuePreferenceWrite(gameInstance, () => {
    const current = getUiPreferences(gameInstance);
    return persistUiPreferences(
      {
        ...current,
        dismissedQuickStarts: [...current.dismissedQuickStarts, safeIdentifier],
      },
      gameInstance,
    );
  });
}

/** Restore every dismissed quick-start guide. */
export function restoreQuickStarts(gameInstance = globalThis.game) {
  return updateUiPreferences({ dismissedQuickStarts: [] }, gameInstance);
}

/** Remember whether a named Advanced disclosure is expanded. */
export async function setAdvancedDisclosure(
  identifier,
  expanded,
  gameInstance = globalThis.game,
) {
  const safeIdentifier = sanitizeIdentifier(identifier);
  if (!safeIdentifier) return getUiPreferences(gameInstance);
  return updateUiPreferences(
    { advancedDisclosures: { [safeIdentifier]: Boolean(expanded) } },
    gameInstance,
  );
}

/** Resolve a density from either a preference object or a density string. */
export function resolveUiDensity(preferencesOrDensity) {
  if (UI_DENSITIES.includes(preferencesOrDensity)) {
    return preferencesOrDensity;
  }
  return normalizeUiPreferences(preferencesOrDensity).density;
}

/**
 * Reflect density onto an ApplicationV2 root. The data attribute is the CSS
 * contract; matching classes support existing class-oriented application code.
 * Documents are accepted for convenience, and missing DOM APIs are harmless.
 */
export function applyUiDensity(root, preferencesOrDensity) {
  const element = root?.documentElement ?? root;
  const density = resolveUiDensity(preferencesOrDensity);
  if (!element) return density;

  if (element.dataset) element.dataset.infinityDensity = density;
  else element.setAttribute?.(UI_DENSITY_ATTRIBUTE, density);

  element.classList?.toggle?.(
    "infinity-density--comfortable",
    density === "comfortable",
  );
  element.classList?.toggle?.(
    "infinity-density--compact",
    density === "compact",
  );
  return density;
}

function mergeUiPreferencePatch(current, patch) {
  const next = { ...current, ...patch };
  if (
    patch.lastLootStudioMode === undefined &&
    patch.lastLootMode !== undefined
  ) {
    next.lastLootStudioMode = patch.lastLootMode;
  }
  if (isRecord(patch.advancedDisclosures)) {
    next.advancedDisclosures = {
      ...current.advancedDisclosures,
      ...patch.advancedDisclosures,
    };
  }
  return next;
}

async function persistUiPreferences(value, gameInstance) {
  const normalized = normalizeUiPreferences(value);
  if (typeof gameInstance?.settings?.set !== "function") return normalized;
  await gameInstance.settings.set(
    SETTINGS_MODULE_ID,
    UI_PREFERENCES_SETTING_KEY,
    normalized,
  );
  return normalized;
}

function enqueuePreferenceWrite(gameInstance, operation) {
  const queueOwner =
    gameInstance !== null &&
    (typeof gameInstance === "object" || typeof gameInstance === "function")
      ? gameInstance
      : null;
  const previous = queueOwner
    ? (preferenceWriteQueues.get(queueOwner) ?? Promise.resolve())
    : fallbackPreferenceWriteQueue;
  const result = previous.catch(() => undefined).then(operation);
  const settled = result.catch(() => undefined);
  if (queueOwner) preferenceWriteQueues.set(queueOwner, settled);
  else fallbackPreferenceWriteQueue = settled;
  return result;
}
