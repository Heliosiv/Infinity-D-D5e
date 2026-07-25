/**
 * Infinity D&D5e — preset + roll-history store.
 *
 * Persists named tool presets and recent rolls in two hidden world
 * settings (one keyed-by-tool blob each). Wraps game.settings via the
 * node-safe getSetting/setSetting helpers, so every function degrades to
 * an in-memory no-op when `game` isn't available (unit tests).
 *
 * Data shapes:
 *   Preset       { id, name, form, savedAt }
 *   HistoryEntry { id, at, form, result }   // result is slimmed for size
 */

import { SETTING_KEYS, getSetting, setSetting } from "../settings.js";

const HISTORY_LIMIT = 20;
export const PRESET_LIMIT = 200;
const PRESET_NAME_LIMIT = 40;
const RESULT_ITEM_LIMIT = 200;
const RESULT_CREATURE_LIMIT = 30;

function readStore(key) {
  const raw = getSetting(key);
  return raw && typeof raw === "object" ? raw : {};
}

function mintId(prefix) {
  const rand =
    globalThis.crypto?.randomUUID?.() ??
    Math.random().toString(36).slice(2, 10);
  return `${prefix}-${rand}`;
}

function clone(value) {
  if (value == null) return value;
  if (typeof structuredClone === "function") return structuredClone(value);
  return JSON.parse(JSON.stringify(value));
}

function isRecord(value) {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function cleanPresetName(value) {
  return typeof value === "string"
    ? value.trim().slice(0, PRESET_NAME_LIMIT)
    : "";
}

function sanitizePresetList(value) {
  if (!Array.isArray(value)) return [];
  const out = [];
  const seenIds = new Set();
  const seenNames = new Set();
  for (const entry of value) {
    if (!isRecord(entry)) continue;
    const id = typeof entry.id === "string" ? entry.id.trim() : "";
    const name = cleanPresetName(entry.name);
    const nameKey = name.toLowerCase();
    if (!id || !name || seenIds.has(id) || seenNames.has(nameKey)) continue;
    seenIds.add(id);
    seenNames.add(nameKey);
    out.push({
      id,
      name,
      form: isRecord(entry.form) ? clone(entry.form) : {},
      savedAt: Number.isFinite(Number(entry.savedAt))
        ? Number(entry.savedAt)
        : 0,
    });
    if (out.length >= PRESET_LIMIT) break;
  }
  return out;
}

function sanitizeHistoryList(value) {
  if (!Array.isArray(value)) return [];
  const out = [];
  const seenIds = new Set();
  for (const entry of value) {
    if (!isRecord(entry)) continue;
    const id = typeof entry.id === "string" ? entry.id.trim() : "";
    if (!id || seenIds.has(id)) continue;
    seenIds.add(id);
    out.push({
      id,
      at: Number.isFinite(Number(entry.at)) ? Number(entry.at) : 0,
      form: isRecord(entry.form) ? clone(entry.form) : {},
      result: sanitizeStoredResult(entry.result),
    });
    if (out.length >= HISTORY_LIMIT) break;
  }
  return out;
}

function sanitizeStoredResult(value) {
  if (!isRecord(value)) return null;
  const result = clone(value);
  if (Object.hasOwn(result, "creatures")) {
    if (!Array.isArray(result.creatures)) return null;
    result.creatures = result.creatures
      .filter(isRecord)
      .slice(0, RESULT_CREATURE_LIMIT)
      .map((creature) => ({
        ...creature,
        items: Array.isArray(creature.items)
          ? creature.items.filter(isRecord).slice(0, RESULT_ITEM_LIMIT)
          : [],
      }));
    return result;
  }
  if (!Array.isArray(result.items)) return null;
  result.items = result.items.filter(isRecord).slice(0, RESULT_ITEM_LIMIT);
  return result;
}

/* ------------------------------------------------------------------ *
 * Presets
 * ------------------------------------------------------------------ */

export function listPresets(toolId) {
  const list = readStore(SETTING_KEYS.SAVED_PRESETS)[toolId];
  return sanitizePresetList(list);
}

export function getPreset(toolId, presetId) {
  return listPresets(toolId).find((preset) => preset.id === presetId) ?? null;
}

/** Save (or replace same-name) a preset. Returns the stored preset. */
export async function savePreset(toolId, { name, form } = {}) {
  const store = { ...readStore(SETTING_KEYS.SAVED_PRESETS) };
  const list = sanitizePresetList(store[toolId]);
  const cleanName = cleanPresetName(String(name ?? "")) || "Preset";
  const existingIndex = list.findIndex(
    (preset) => preset.name.toLowerCase() === cleanName.toLowerCase(),
  );
  const preset = {
    id: existingIndex >= 0 ? list[existingIndex].id : mintId("p"),
    name: cleanName,
    form: isRecord(form) ? clone(form) : {},
    savedAt: Date.now(),
  };
  if (existingIndex >= 0) list[existingIndex] = preset;
  else {
    if (list.length >= PRESET_LIMIT) list.shift();
    list.push(preset);
  }
  store[toolId] = list;
  await setSetting(SETTING_KEYS.SAVED_PRESETS, store);
  return preset;
}

export async function deletePreset(toolId, presetId) {
  const store = { ...readStore(SETTING_KEYS.SAVED_PRESETS) };
  store[toolId] = sanitizePresetList(store[toolId]).filter(
    (preset) => preset.id !== presetId,
  );
  await setSetting(SETTING_KEYS.SAVED_PRESETS, store);
  return store[toolId];
}

/* ------------------------------------------------------------------ *
 * Preset export / import
 * ------------------------------------------------------------------ */

export const PRESET_EXPORT_SCHEMA = "infinity-dnd5e-presets-v1";

/** Build a serializable export blob for a tool's presets (name + form only). */
export function exportPresets(toolId) {
  return {
    schema: PRESET_EXPORT_SCHEMA,
    toolId,
    presets: listPresets(toolId).map((preset) => ({
      name: preset.name,
      form: clone(preset.form) ?? {},
    })),
  };
}

/**
 * Validate an export blob and return its importable presets as a clean
 * `[{ name, form }]` list. Rejects the wrong schema or a mismatched tool id
 * (presets are tool-specific), and drops malformed entries. Pure — exported
 * for unit testing.
 */
export function parsePresetExport(data, toolId) {
  if (!data || typeof data !== "object") return [];
  if (data.schema !== PRESET_EXPORT_SCHEMA) return [];
  if (toolId && data.toolId && data.toolId !== toolId) return [];
  const list = Array.isArray(data.presets) ? data.presets : [];
  const out = [];
  for (const entry of list) {
    if (!isRecord(entry)) continue;
    const name = cleanPresetName(entry.name);
    if (!name) continue;
    if (!isRecord(entry.form)) continue;
    out.push({ name, form: clone(entry.form) });
    if (out.length >= PRESET_LIMIT) break;
  }
  return out;
}

/**
 * Merge an export blob into a tool's saved presets. Same-name presets are
 * overwritten (case-insensitive) so re-importing updates in place. Returns
 * the number of presets imported.
 */
export async function importPresets(toolId, data) {
  const incoming = parsePresetExport(data, toolId);
  if (incoming.length === 0) return 0;
  const store = { ...readStore(SETTING_KEYS.SAVED_PRESETS) };
  const list = sanitizePresetList(store[toolId]);
  let imported = 0;
  for (const { name, form } of incoming) {
    const idx = list.findIndex(
      (preset) => preset.name.toLowerCase() === name.toLowerCase(),
    );
    const preset = {
      id: idx >= 0 ? list[idx].id : mintId("p"),
      name,
      form: clone(form) ?? {},
      savedAt: Date.now(),
    };
    if (idx >= 0) list[idx] = preset;
    else if (list.length < PRESET_LIMIT) list.push(preset);
    else continue;
    imported += 1;
  }
  store[toolId] = list;
  await setSetting(SETTING_KEYS.SAVED_PRESETS, store);
  return imported;
}

/* ------------------------------------------------------------------ *
 * History
 * ------------------------------------------------------------------ */

export function listHistory(toolId) {
  const list = readStore(SETTING_KEYS.ROLL_HISTORY)[toolId];
  return sanitizeHistoryList(list);
}

export function getHistoryEntry(toolId, historyId) {
  return listHistory(toolId).find((entry) => entry.id === historyId) ?? null;
}

/** Prepend a roll to history, trimming to HISTORY_LIMIT. */
export async function pushHistory(toolId, { form, result } = {}) {
  const store = { ...readStore(SETTING_KEYS.ROLL_HISTORY) };
  const list = sanitizeHistoryList(store[toolId]);
  const record = {
    id: mintId("h"),
    at: Date.now(),
    form: isRecord(form) ? clone(form) : {},
    result: sanitizeStoredResult(result),
  };
  list.unshift(record);
  store[toolId] = list.slice(0, HISTORY_LIMIT);
  await setSetting(SETTING_KEYS.ROLL_HISTORY, store);
  return record;
}

export async function clearHistory(toolId) {
  const store = { ...readStore(SETTING_KEYS.ROLL_HISTORY) };
  delete store[toolId];
  await setSetting(SETTING_KEYS.ROLL_HISTORY, store);
}

export { HISTORY_LIMIT };
