/**
 * Infinity D&D5e — Reputation standing scale
 *
 * Pure data shaping for the faction reputation feature: the −5…+5
 * standing scale, its named tiers and color bands, and record
 * normalization. No Foundry imports, no DOM — so every function here is
 * reachable from Node tests (test-reputation-store.mjs) and can't drift
 * from the UI that renders it.
 */

/** Inclusive bounds of the party-wide standing scale. */
export const STANDING_MIN = -5;
export const STANDING_MAX = 5;

/** Newest-first history is capped so a long campaign can't bloat the
 *  world setting; per-character notes are capped to keep a card readable. */
export const HISTORY_CAP = 50;
export const PER_CHARACTER_CAP = 12;

/**
 * Named tiers keyed by score — plain-language and beginner-friendly
 * (no jargon). Every integer in [−5, +5] has an entry; `standingTier`
 * clamps first so out-of-range input still resolves.
 */
const STANDING_TIERS = Object.freeze({
  "-5": "Nemesis",
  "-4": "Hated",
  "-3": "Hostile",
  "-2": "Distrusted",
  "-1": "Wary",
  0: "Neutral",
  1: "Noticed",
  2: "Friendly",
  3: "Trusted",
  4: "Allied",
  5: "Exalted",
});

/**
 * Color/CSS bands — five buckets spanning the scale. The workspace and
 * the player view both key their meter color off the band so a faction
 * reads at a glance: red (hostile) → amber (cold) → grey (neutral) →
 * green (warm) → bright green (allied).
 */
function bandForScore(score) {
  if (score <= -3) return "hostile";
  if (score < 0) return "cold";
  if (score === 0) return "neutral";
  if (score <= 2) return "warm";
  return "allied";
}

/** Coerce any input to an integer standing clamped to [−5, +5]. Non-numeric
 *  input falls back to 0 (Neutral). */
export function clampStanding(value) {
  const n = Math.round(Number(value));
  if (!Number.isFinite(n)) return 0;
  return Math.max(STANDING_MIN, Math.min(STANDING_MAX, n));
}

/** The named tier for a score, e.g. +2 → "Friendly". Clamps first. */
export function standingTier(score) {
  return STANDING_TIERS[String(clampStanding(score))] ?? "Neutral";
}

/** The color band id for a score: hostile | cold | neutral | warm | allied. */
export function standingBand(score) {
  return bandForScore(clampStanding(score));
}

/** The CSS modifier token used in templates (`is-{{band}}` / `rep-meter--…`).
 *  Currently the band id; kept as its own function so the styling contract
 *  has a single named seam if the buckets ever change. */
export function standingCssClass(score) {
  return standingBand(score);
}

/* ------------------------------------------------------------------ *
 * Local coercion helpers (kept here so standing.js has no deps)
 * ------------------------------------------------------------------ */

function toStr(value, fallback = "") {
  const s = String(value ?? "").trim();
  return s || fallback;
}

function toInt(value, fallback = 0) {
  const n = Math.floor(Number(value));
  return Number.isFinite(n) ? n : fallback;
}

/** A stable id without leaning on Foundry's randomID() (which is absent in
 *  Node tests). */
export function generateId(prefix = "f") {
  const chunk = () =>
    Math.floor(Math.random() * 0x100000)
      .toString(16)
      .padStart(5, "0");
  return `${prefix}-${chunk()}${chunk()}`;
}

/* ------------------------------------------------------------------ *
 * Normalization
 * ------------------------------------------------------------------ */

/**
 * Normalize a single change-log entry. Returns a clean record for any
 * object input; drops non-objects (callers filter null). `delta` is the
 * actual standing change (can be 0 for a plain note); `fromStanding` /
 * `toStanding` snapshot the swing so the log reads "Neutral → Friendly".
 */
export function normalizeHistoryEntry(entry) {
  if (!entry || typeof entry !== "object") return null;
  const from = clampStanding(entry.fromStanding);
  const to = clampStanding(entry.toStanding);
  return {
    id: toStr(entry.id) || generateId("h"),
    at: Number.isFinite(Number(entry.at)) ? Number(entry.at) : 0,
    by: toStr(entry.by),
    delta: toInt(entry.delta, to - from),
    fromStanding: from,
    toStanding: to,
    reason: toStr(entry.reason),
  };
}

/**
 * Normalize a per-character note. Keeps any object row (so a freshly-added
 * blank row survives a save and stays editable / removable); drops only
 * non-objects. `delta` is a display-only modifier and does NOT move the
 * party-wide standing.
 */
export function normalizePerCharacter(entry) {
  if (!entry || typeof entry !== "object") return null;
  const delta = clampStanding(entry.delta);
  return {
    id: toStr(entry.id) || generateId("pc"),
    actorId: toStr(entry.actorId),
    delta,
    note: toStr(entry.note),
  };
}

/**
 * Normalize a faction record — fills missing fields, clamps the standing,
 * shapes the history + per-character lists, and caps both. Idempotent;
 * safe to run on already-normalized records.
 */
export function normalizeFaction(input) {
  const raw = input && typeof input === "object" ? input : {};
  const history = Array.isArray(raw.history) ? raw.history : [];
  const perCharacter = Array.isArray(raw.perCharacter) ? raw.perCharacter : [];
  return {
    id: toStr(raw.id) || generateId(),
    name: toStr(raw.name, "New Faction"),
    category: toStr(raw.category),
    description: toStr(raw.description),
    img: toStr(raw.img),
    standing: clampStanding(raw.standing),
    gmNotes: toStr(raw.gmNotes),
    revealed: raw.revealed === true,
    playerNote: toStr(raw.playerNote),
    history: history
      .map(normalizeHistoryEntry)
      .filter(Boolean)
      .slice(0, HISTORY_CAP),
    perCharacter: perCharacter
      .map(normalizePerCharacter)
      .filter(Boolean)
      .slice(0, PER_CHARACTER_CAP),
  };
}

/** Default faction list — empty. The GM adds factions as the party
 *  encounters them ("start from scratch"). */
export function getDefaultFactions() {
  return [];
}
