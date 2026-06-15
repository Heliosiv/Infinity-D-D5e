/**
 * Infinity D&D5e — Reputation Store
 *
 * Persistence layer for faction reputation. Factions live as plain
 * objects in a single world-scoped Foundry setting (FACTIONS), so the GM
 * curates them in the Reputation Workspace and they survive world reloads
 * without any actor/journal baggage — mirroring the merchant store.
 *
 * Pure record shaping (in standing.js) plus the pure mutation helpers here
 * (`applyStandingChange`, per-character add/update/remove,
 * `sanitizeFactionForPlayers`) are exported for unit testing. The
 * Foundry-touching CRUD degrades gracefully when `game.settings` is absent
 * so the tests can exercise the pure logic without a live game.
 */

import {
  HISTORY_CAP,
  clampStanding,
  generateId,
  normalizeFaction,
  normalizeHistoryEntry,
  normalizePerCharacter,
  standingBand,
  standingTier,
} from "./standing.js";

const MODULE_ID = "infinity-dnd5e";
/** Setting key — mirrors SETTING_KEYS.FACTIONS in settings.js. */
export const FACTION_SETTING_KEY = "factions";

/* ------------------------------------------------------------------ *
 * Construction
 * ------------------------------------------------------------------ */

/** Build a fresh faction with sane defaults — used by "New Faction". */
export function createBlankFaction(overrides = {}) {
  return normalizeFaction({
    id: generateId(),
    name: "New Faction",
    standing: 0,
    revealed: false,
    ...overrides,
  });
}

/* ------------------------------------------------------------------ *
 * Pure mutations (no game access — fully node-testable)
 * ------------------------------------------------------------------ */

/**
 * Apply a standing change to a faction and prepend a change-log entry.
 * Returns a NEW faction (never mutates input).
 *
 * Provide either `delta` (relative, e.g. ±1 from the Raise/Lower buttons)
 * or `toStanding` (absolute, from "Set standing…"). The logged `delta` is
 * the ACTUAL swing after clamping, so a raise at +5 records delta 0. A
 * change with delta 0 and no reason is dropped as a no-op; a delta-0 change
 * WITH a reason is kept as a plain note.
 */
export function applyStandingChange(
  faction,
  { delta, toStanding, reason, by } = {},
) {
  const f = normalizeFaction(faction);
  const from = f.standing;
  const to =
    toStanding != null
      ? clampStanding(toStanding)
      : clampStanding(from + (Number(delta) || 0));
  const actual = to - from;
  const reasonStr = String(reason ?? "").trim();
  if (actual === 0 && !reasonStr) return f; // genuine no-op

  const entry = normalizeHistoryEntry({
    id: generateId("h"),
    at: nowMs(),
    by,
    delta: actual,
    fromStanding: from,
    toStanding: to,
    reason: reasonStr,
  });
  return {
    ...f,
    standing: to,
    history: [entry, ...f.history].slice(0, HISTORY_CAP),
  };
}

/** Append a per-character note row (capped). Returns a new faction. */
export function addPerCharacter(faction, row = {}) {
  const f = normalizeFaction(faction);
  const next = normalizePerCharacter({ id: generateId("pc"), ...row });
  if (!next) return f;
  return normalizeFaction({ ...f, perCharacter: [...f.perCharacter, next] });
}

/** Patch a per-character note row by id. Returns a new faction. */
export function updatePerCharacter(faction, rowId, patch = {}) {
  const f = normalizeFaction(faction);
  const id = String(rowId ?? "");
  return normalizeFaction({
    ...f,
    perCharacter: f.perCharacter.map((row) =>
      row.id === id ? { ...row, ...patch, id: row.id } : row,
    ),
  });
}

/** Remove a per-character note row by id. Returns a new faction. */
export function removePerCharacter(faction, rowId) {
  const f = normalizeFaction(faction);
  const id = String(rowId ?? "");
  return normalizeFaction({
    ...f,
    perCharacter: f.perCharacter.filter((row) => row.id !== id),
  });
}

/* ------------------------------------------------------------------ *
 * Player projection (privacy guard)
 * ------------------------------------------------------------------ */

/**
 * Project a faction to the minimal, safe shape a player may see. The
 * FACTIONS setting is world-scoped (every client can read the raw
 * records), so the GM-side reply MUST strip GM-only fields — gmNotes,
 * description, history, and per-character notes — leaving only what the
 * player view renders. Never include unrevealed factions in a reply.
 */
export function sanitizeFactionForPlayers(faction) {
  const f = normalizeFaction(faction);
  return {
    id: f.id,
    name: f.name,
    category: f.category,
    img: f.img,
    standing: f.standing,
    tier: standingTier(f.standing),
    band: standingBand(f.standing),
    playerNote: f.playerNote,
  };
}

/** The sanitized list of every revealed faction, for a player reply /
 *  broadcast. */
export function listRevealedForPlayers() {
  return loadFactions()
    .filter((f) => f.revealed)
    .map(sanitizeFactionForPlayers);
}

/* ------------------------------------------------------------------ *
 * Foundry-backed CRUD
 *
 * Reads degrade gracefully (return []). Writes throw if game isn't
 * available so callers learn about misuse early.
 * ------------------------------------------------------------------ */

/** Load every faction record from the world setting. */
export function loadFactions() {
  try {
    const raw = globalThis.game?.settings?.get?.(
      MODULE_ID,
      FACTION_SETTING_KEY,
    );
    if (!Array.isArray(raw)) return [];
    return raw.map(normalizeFaction);
  } catch {
    return [];
  }
}

/** Look up a faction by id. */
export function findFaction(id) {
  const want = String(id ?? "").trim();
  if (!want) return null;
  return loadFactions().find((f) => f.id === want) ?? null;
}

/** Persist the full faction list. */
export async function saveFactions(factions) {
  if (!globalThis.game?.settings?.set) {
    throw new Error("NotInFoundry: saveFactions requires game.settings");
  }
  const cleaned = (Array.isArray(factions) ? factions : []).map(
    normalizeFaction,
  );
  await globalThis.game.settings.set(MODULE_ID, FACTION_SETTING_KEY, cleaned);
  return cleaned;
}

/** Insert-or-replace a single faction; returns the saved list. */
export async function upsertFaction(faction) {
  const normalized = normalizeFaction(faction);
  const list = loadFactions();
  const idx = list.findIndex((f) => f.id === normalized.id);
  if (idx < 0) list.push(normalized);
  else list[idx] = normalized;
  return saveFactions(list);
}

/** Delete a faction by id; returns the saved list. */
export async function removeFaction(id) {
  const want = String(id ?? "").trim();
  if (!want) return loadFactions();
  const list = loadFactions().filter((f) => f.id !== want);
  return saveFactions(list);
}

/**
 * Apply a standing change to a stored faction and persist it. Convenience
 * wrapper over `applyStandingChange` + `upsertFaction`. Returns the updated
 * faction, or null if the id isn't found.
 */
export async function adjustStanding(id, delta, opts = {}) {
  const faction = findFaction(id);
  if (!faction) return null;
  const next = applyStandingChange(faction, { delta, ...opts });
  await upsertFaction(next);
  return next;
}

/** Set a stored faction's standing to an absolute value + persist + log. */
export async function setStanding(id, value, opts = {}) {
  const faction = findFaction(id);
  if (!faction) return null;
  const next = applyStandingChange(faction, { toStanding: value, ...opts });
  await upsertFaction(next);
  return next;
}

/** Clock read isolated so the pure helpers stay easy to reason about. */
function nowMs() {
  try {
    return Date.now();
  } catch {
    return 0;
  }
}
