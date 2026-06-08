/**
 * Infinity D&D5e — Resource store
 *
 * Persistence + normalization for the Quartermaster's configuration and its
 * moving run-state. Two world settings back this:
 *   - `resourceConfig`   — the GM-tunable structure (resources, environments,
 *                          modes). Rewritten only when the GM edits it.
 *   - `resourceRunState` — the small moving parts (lastSeenDay, current
 *                          environment, last upkeep report). Written each day.
 *
 * Pure shaping (normalize/create) is exported for node tests; the Foundry-
 * touching load/save go through settings.js getSetting/setSetting, which
 * already degrade gracefully when `game.settings` is absent.
 */

import { SETTING_KEYS, getSetting, setSetting } from "../settings.js";
import {
  getDefaultEnvironments,
  normalizeEnvironmentCatalog,
} from "./environment.js";

export const RESOURCE_CONFIG_VERSION = 1;

/** Resource consumption scope. Food/water are per-character; light is party-wide. */
export const RESOURCE_SCOPES = Object.freeze(["per-character", "party"]);

const FORAGE_MODES = Object.freeze(["each", "best"]);

function toStr(value, fallback = "") {
  const s = String(value ?? "").trim();
  return s || fallback;
}

function toInt(value, fallback) {
  const n = Math.floor(Number(value));
  return Number.isFinite(n) ? n : fallback;
}

function toNum(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function toStrArray(value) {
  if (!Array.isArray(value)) return [];
  const seen = new Set();
  const out = [];
  for (const entry of value) {
    const s = String(entry ?? "").trim();
    if (!s || seen.has(s)) continue;
    seen.add(s);
    out.push(s);
  }
  return out;
}

/** Default per-resource matching + rates. Keys stay stable; labels are friendly. */
function defaultResources() {
  return [
    {
      id: "food",
      label: "Food (Rations)",
      scope: "per-character",
      perDay: 1,
      forageYields: "food",
      matching: {
        nameKeywords: ["ration", "rations", "trail ration", "food"],
        flagTag: "food",
        itemUuids: [],
      },
    },
    {
      id: "water",
      label: "Water",
      scope: "per-character",
      perDay: 1,
      forageYields: "water",
      // Deliberately NOT a bare "water" keyword — that would snag "Holy Water",
      // "Water Elemental" figurines, etc. The GM can tag a specific item or add
      // keywords in the Resource Manager.
      matching: {
        nameKeywords: ["waterskin", "water ration", "water (1 day)"],
        flagTag: "water",
        itemUuids: [],
      },
    },
    {
      id: "light",
      label: "Light (Torches)",
      scope: "party",
      perDay: 2,
      forageYields: null,
      matching: {
        nameKeywords: ["torch", "torches"],
        flagTag: "light",
        itemUuids: [],
      },
    },
  ];
}

/** Normalize one resource definition; drops malformed entries (null). */
export function normalizeResource(raw) {
  if (!raw || typeof raw !== "object") return null;
  const id = toStr(raw.id);
  if (!id) return null;
  const scope = RESOURCE_SCOPES.includes(raw.scope) ? raw.scope : "per-character";
  const matching = raw.matching && typeof raw.matching === "object" ? raw.matching : {};
  const forageYields =
    raw.forageYields === "food" || raw.forageYields === "water"
      ? raw.forageYields
      : null;
  return {
    id,
    label: toStr(raw.label, id),
    scope,
    perDay: Math.max(0, toNum(raw.perDay, 1)),
    forageYields,
    matching: {
      nameKeywords: toStrArray(matching.nameKeywords),
      flagTag: toStr(matching.flagTag),
      itemUuids: toStrArray(matching.itemUuids),
    },
  };
}

/**
 * Normalize the whole config. Idempotent; fills missing fields, drops malformed
 * resources, and guarantees a non-empty environment catalog + resource list.
 */
export function normalizeResourceConfig(input) {
  const raw = input && typeof input === "object" ? input : {};
  const resourcesRaw = Array.isArray(raw.resources) ? raw.resources : [];
  const resources = resourcesRaw.map(normalizeResource).filter(Boolean);
  return {
    version: RESOURCE_CONFIG_VERSION,
    forageMode: FORAGE_MODES.includes(raw.forageMode) ? raw.forageMode : "each",
    halfRations: raw.halfRations === true,
    waterEnabled: raw.waterEnabled !== false,
    maxCatchUpDays: Math.max(1, toInt(raw.maxCatchUpDays, 7)),
    forageTimeoutSeconds: Math.max(0, toInt(raw.forageTimeoutSeconds, 120)),
    resources: resources.length > 0 ? resources : defaultResources(),
    environments: normalizeEnvironmentCatalog(raw.environments),
  };
}

/** Build a fresh config with all defaults (used on first run). */
export function createDefaultResourceConfig() {
  return normalizeResourceConfig({
    resources: defaultResources(),
    environments: getDefaultEnvironments(),
  });
}

/** Normalize the run-state. lastSeenDay null means "never processed". */
export function normalizeRunState(input) {
  const raw = input && typeof input === "object" ? input : {};
  const lastSeenRaw = raw.lastSeenDay;
  const lastSeenDay =
    lastSeenRaw == null || !Number.isFinite(Number(lastSeenRaw))
      ? null
      : Math.floor(Number(lastSeenRaw));
  const result =
    raw.lastUpkeepResult && typeof raw.lastUpkeepResult === "object"
      ? raw.lastUpkeepResult
      : null;
  return {
    lastSeenDay,
    currentEnvironmentId: toStr(raw.currentEnvironmentId) || null,
    lastUpkeepResult: result,
  };
}

/* ------------------------------------------------------------------ *
 * Foundry-touching CRUD (graceful via settings.js)
 * ------------------------------------------------------------------ */

export function loadResourceConfig() {
  return normalizeResourceConfig(getSetting(SETTING_KEYS.RESOURCE_CONFIG));
}

export async function saveResourceConfig(config) {
  return setSetting(
    SETTING_KEYS.RESOURCE_CONFIG,
    normalizeResourceConfig(config),
  );
}

export function loadRunState() {
  return normalizeRunState(getSetting(SETTING_KEYS.RESOURCE_RUNSTATE));
}

export async function saveRunState(state) {
  return setSetting(SETTING_KEYS.RESOURCE_RUNSTATE, normalizeRunState(state));
}

/** Patch-style helpers so a frequent write doesn't rewrite the whole config. */
export async function setLastSeenDay(day) {
  const state = loadRunState();
  state.lastSeenDay =
    day == null || !Number.isFinite(Number(day)) ? null : Math.floor(Number(day));
  return saveRunState(state);
}

export async function setCurrentEnvironment(environmentId) {
  const state = loadRunState();
  state.currentEnvironmentId = toStr(environmentId) || null;
  return saveRunState(state);
}

export async function setLastUpkeepResult(result) {
  const state = loadRunState();
  state.lastUpkeepResult =
    result && typeof result === "object" ? result : null;
  return saveRunState(state);
}
