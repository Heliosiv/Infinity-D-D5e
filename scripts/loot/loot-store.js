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

/* ------------------------------------------------------------------ *
 * Presets
 * ------------------------------------------------------------------ */

export function listPresets(toolId) {
  const list = readStore(SETTING_KEYS.SAVED_PRESETS)[toolId];
  return Array.isArray(list) ? list : [];
}

export function getPreset(toolId, presetId) {
  return listPresets(toolId).find((preset) => preset.id === presetId) ?? null;
}

/** Save (or replace same-name) a preset. Returns the stored preset. */
export async function savePreset(toolId, { name, form } = {}) {
  const store = { ...readStore(SETTING_KEYS.SAVED_PRESETS) };
  const list = Array.isArray(store[toolId]) ? [...store[toolId]] : [];
  const cleanName = String(name ?? "").trim() || "Preset";
  const existingIndex = list.findIndex(
    (preset) => preset.name.toLowerCase() === cleanName.toLowerCase(),
  );
  const preset = {
    id: existingIndex >= 0 ? list[existingIndex].id : mintId("p"),
    name: cleanName,
    form: clone(form) ?? {},
    savedAt: Date.now(),
  };
  if (existingIndex >= 0) list[existingIndex] = preset;
  else list.push(preset);
  store[toolId] = list;
  await setSetting(SETTING_KEYS.SAVED_PRESETS, store);
  return preset;
}

export async function deletePreset(toolId, presetId) {
  const store = { ...readStore(SETTING_KEYS.SAVED_PRESETS) };
  store[toolId] = (store[toolId] ?? []).filter(
    (preset) => preset.id !== presetId,
  );
  await setSetting(SETTING_KEYS.SAVED_PRESETS, store);
  return store[toolId];
}

/* ------------------------------------------------------------------ *
 * History
 * ------------------------------------------------------------------ */

export function listHistory(toolId) {
  const list = readStore(SETTING_KEYS.ROLL_HISTORY)[toolId];
  return Array.isArray(list) ? list : [];
}

export function getHistoryEntry(toolId, historyId) {
  return listHistory(toolId).find((entry) => entry.id === historyId) ?? null;
}

/** Prepend a roll to history, trimming to HISTORY_LIMIT. */
export async function pushHistory(toolId, { form, result } = {}) {
  const store = { ...readStore(SETTING_KEYS.ROLL_HISTORY) };
  const list = Array.isArray(store[toolId]) ? [...store[toolId]] : [];
  const record = {
    id: mintId("h"),
    at: Date.now(),
    form: clone(form) ?? {},
    result: clone(result) ?? null,
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
