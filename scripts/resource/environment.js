/**
 * Infinity D&D5e — Environment / region catalog (pure)
 *
 * The party's current surroundings drive whether foraging is possible and at
 * what Wisdom (Survival) DC. Defaults follow the DMG's foraging guidance
 * (abundant DC 10, limited DC 15, sparse DC 20; settlements & dungeons aren't
 * forageable). Everything is data + pure shaping so it's node-testable and the
 * GM can edit the catalog in the Resource Manager.
 */

/** Internal keys are stable; display labels are duplicated here for the UI but
 *  the canonical plain-language map lives in ui-util.js (mirrors loot types). */
const DEFAULT_ENVIRONMENTS = Object.freeze([
  Object.freeze({
    id: "abundant",
    label: "Abundant (forest, coast, grassland)",
    dc: 10,
    forageable: true,
    yieldFood: "1d6",
    yieldWater: "1d6",
  }),
  Object.freeze({
    id: "limited",
    label: "Limited (hills, farmland, woods)",
    dc: 15,
    forageable: true,
    yieldFood: "1d6",
    yieldWater: "1d6",
  }),
  Object.freeze({
    id: "sparse",
    label: "Sparse (desert, tundra, badlands)",
    dc: 20,
    forageable: true,
    yieldFood: "1d6",
    yieldWater: "1d6",
  }),
  Object.freeze({
    id: "settlement",
    label: "Settlement (buy supplies — no foraging)",
    dc: 0,
    forageable: false,
    yieldFood: "0",
    yieldWater: "0",
  }),
  Object.freeze({
    id: "underground",
    label: "Underground (dungeon — no foraging)",
    dc: 0,
    forageable: false,
    yieldFood: "0",
    yieldWater: "0",
  }),
]);

export { DEFAULT_ENVIRONMENTS };

/** Fresh, mutable copy of the defaults (mirrors getDefaultBargainTiers). */
export function getDefaultEnvironments() {
  return DEFAULT_ENVIRONMENTS.map((env) => ({ ...env }));
}

function toStr(value, fallback = "") {
  const s = String(value ?? "").trim();
  return s || fallback;
}

function toInt(value, fallback) {
  const n = Math.floor(Number(value));
  return Number.isFinite(n) ? n : fallback;
}

/** Coerce a die/amount string to a safe formula string ("1d6", "0", "2"). */
function toDieString(value, fallback) {
  const s = String(value ?? "").trim();
  if (!s) return fallback;
  // Permit only digits, 'd', '+', '-', and spaces — anything else → fallback.
  return /^[0-9dD+\-\s]+$/.test(s) ? s : fallback;
}

/**
 * Normalize one environment entry. Drops malformed entries by returning null;
 * callers filter the result. Idempotent.
 */
export function normalizeEnvironment(raw) {
  if (!raw || typeof raw !== "object") return null;
  const id = toStr(raw.id);
  if (!id) return null;
  const forageable = raw.forageable !== false;
  return {
    id,
    label: toStr(raw.label, id),
    dc: Math.max(0, toInt(raw.dc, forageable ? 15 : 0)),
    forageable,
    yieldFood: toDieString(raw.yieldFood, forageable ? "1d6" : "0"),
    yieldWater: toDieString(raw.yieldWater, forageable ? "1d6" : "0"),
  };
}

/**
 * Normalize a catalog (array). Falls back to the defaults when the input is
 * empty or every entry was malformed, so the feature is never left with zero
 * environments to choose from.
 */
export function normalizeEnvironmentCatalog(raw) {
  const list = Array.isArray(raw) ? raw : [];
  const cleaned = [];
  const seen = new Set();
  for (const entry of list) {
    const norm = normalizeEnvironment(entry);
    if (!norm || seen.has(norm.id)) continue;
    seen.add(norm.id);
    cleaned.push(norm);
  }
  return cleaned.length > 0 ? cleaned : getDefaultEnvironments();
}

/** Find an environment by id within a catalog, or null. */
export function findEnvironment(catalog, id) {
  const key = toStr(id);
  if (!key) return null;
  const list = Array.isArray(catalog) ? catalog : [];
  return list.find((env) => env?.id === key) ?? null;
}

/** Whether foraging is possible in this environment. */
export function isForageable(env) {
  return Boolean(env && env.forageable !== false);
}
