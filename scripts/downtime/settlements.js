import {
  DOWNTIME_ACTIVITY_ID_LIST,
  normalizeDowntimeActivityId,
} from "./catalog.js";
import { normalizeSharpeningLifecycle } from "./sharpening-lifecycle.js";
import { normalizeStolenGoodsLedger } from "./stolen-ledger.js";

export const DOWNTIME_CONFIG_VERSION = 2;
export const NON_SETTLEMENT_DOWNTIME_CONTEXT_ID =
  "downtime-away-from-settlement";
export const DEFAULT_NON_SETTLEMENT_LOCATION_NAME = "Camp or wilderness";

export const SETTLEMENT_SECURITY_TIERS = Object.freeze({
  LOW: "low",
  STANDARD: "standard",
  HIGH: "high",
  EXTREME: "extreme",
});

export const SETTLEMENT_SECURITY_DCS = Object.freeze({
  [SETTLEMENT_SECURITY_TIERS.LOW]: 10,
  [SETTLEMENT_SECURITY_TIERS.STANDARD]: 13,
  [SETTLEMENT_SECURITY_TIERS.HIGH]: 16,
  [SETTLEMENT_SECURITY_TIERS.EXTREME]: 19,
});

export const SETTLEMENT_WEALTH_TIERS = Object.freeze({
  POOR: "poor",
  MODEST: "modest",
  PROSPEROUS: "prosperous",
  WEALTHY: "wealthy",
});

export const SETTLEMENT_WEALTH_TIER_LIST = Object.freeze(
  Object.values(SETTLEMENT_WEALTH_TIERS),
);

export const SETTLEMENT_SECURITY_TIER_LIST = Object.freeze(
  Object.values(SETTLEMENT_SECURITY_TIERS),
);

const SECURITY_ALIASES = Object.freeze({
  1: SETTLEMENT_SECURITY_TIERS.LOW,
  2: SETTLEMENT_SECURITY_TIERS.STANDARD,
  3: SETTLEMENT_SECURITY_TIERS.HIGH,
  4: SETTLEMENT_SECURITY_TIERS.EXTREME,
  light: SETTLEMENT_SECURITY_TIERS.LOW,
  average: SETTLEMENT_SECURITY_TIERS.STANDARD,
  moderate: SETTLEMENT_SECURITY_TIERS.STANDARD,
  guarded: SETTLEMENT_SECURITY_TIERS.HIGH,
  severe: SETTLEMENT_SECURITY_TIERS.EXTREME,
});

const WEALTH_ALIASES = Object.freeze({
  1: SETTLEMENT_WEALTH_TIERS.POOR,
  2: SETTLEMENT_WEALTH_TIERS.MODEST,
  3: SETTLEMENT_WEALTH_TIERS.PROSPEROUS,
  4: SETTLEMENT_WEALTH_TIERS.WEALTHY,
  destitute: SETTLEMENT_WEALTH_TIERS.POOR,
  struggling: SETTLEMENT_WEALTH_TIERS.POOR,
  comfortable: SETTLEMENT_WEALTH_TIERS.PROSPEROUS,
  rich: SETTLEMENT_WEALTH_TIERS.WEALTHY,
  opulent: SETTLEMENT_WEALTH_TIERS.WEALTHY,
});

/**
 * Normalize one saved settlement into the authoritative profile shape.
 * Unknown fields are intentionally discarded; clients must not smuggle rule
 * overrides through profile-shaped payloads.
 */
export function normalizeSettlementProfile(raw = {}, { fallbackId = "" } = {}) {
  const source = isPlainObject(raw) ? raw : {};
  const name = cleanText(source.name, 120) || "Unnamed Settlement";
  const id =
    cleanId(source.id || fallbackId) || createSettlementIdFromName(name);
  const wealthTier = normalizeWealthTier(source.wealthTier ?? source.wealth);
  const securityTier = normalizeSecurityTier(
    source.securityTier ?? source.security,
  );
  const defaultMarketDc = getSettlementSecurityDc(securityTier);

  return {
    id,
    name,
    hasSettlement: source.hasSettlement !== false,
    wealthTier,
    securityTier,
    marketDc: boundedInteger(source.marketDc, 1, 40, defaultMarketDc),
    linkedFactionId: cleanId(source.linkedFactionId ?? source.factionId ?? ""),
    linkedMerchantIds: normalizeIdList(
      source.linkedMerchantIds ?? source.merchantIds ?? [],
    ),
    enabledActivityIds: normalizeEnabledActivities(
      source.enabledActivityIds ?? source.enabledActivities,
    ),
  };
}

/**
 * Build the compatibility profile used when downtime happens away from a
 * settlement. The non-empty internal id keeps immutable operation receipts
 * and write recovery stable; `hasSettlement` remains the authority for which
 * activities are legal.
 */
export function createNonSettlementDowntimeContext(name = "") {
  return normalizeSettlementProfile({
    id: NON_SETTLEMENT_DOWNTIME_CONTEXT_ID,
    name: cleanText(name, 120) || DEFAULT_NON_SETTLEMENT_LOCATION_NAME,
    hasSettlement: false,
    linkedFactionId: "",
    linkedMerchantIds: [],
    enabledActivityIds: DOWNTIME_ACTIVITY_ID_LIST,
  });
}

/** Normalize a list and reject duplicate settlement ids deterministically. */
export function normalizeSettlementProfiles(rawProfiles = []) {
  if (!Array.isArray(rawProfiles)) return [];
  const result = [];
  const seen = new Set();
  for (const raw of rawProfiles) {
    if (!isPlainObject(raw)) continue;
    if (!cleanId(raw.id) && !cleanText(raw.name, 120)) continue;
    const profile = normalizeSettlementProfile(raw);
    if (!profile.id || seen.has(profile.id)) continue;
    seen.add(profile.id);
    result.push(profile);
  }
  return result;
}

/**
 * Normalize the private downtime configuration envelope. History entries are
 * copied without interpreting their receipt schema; workflow code owns them.
 */
export function normalizeDowntimeConfig(raw = {}) {
  const source = isPlainObject(raw) ? raw : {};
  return {
    version: DOWNTIME_CONFIG_VERSION,
    settlements: normalizeSettlementProfiles(source.settlements),
    heat: normalizeDowntimeHeat(source.heat),
    stolenGoods: normalizeStolenGoodsLedger(source.stolenGoods),
    sharpeningLifecycle: normalizeSharpeningLifecycle(
      source.sharpeningLifecycle,
    ),
    history: Array.isArray(source.history)
      ? source.history.filter(isPlainObject).map(clonePlainRecord)
      : [],
  };
}

/** Normalize settlement -> actor -> Heat, clamped to the persistent 0–5 range. */
export function normalizeDowntimeHeat(raw = {}) {
  if (!isPlainObject(raw)) return {};
  const heat = {};
  for (const [rawSettlementId, rawActors] of Object.entries(raw)) {
    const settlementId = cleanId(rawSettlementId);
    if (!settlementId || !isPlainObject(rawActors)) continue;
    const actors = {};
    for (const [rawActorId, rawHeat] of Object.entries(rawActors)) {
      const actorId = cleanId(rawActorId);
      if (!actorId) continue;
      actors[actorId] = boundedInteger(rawHeat, 0, 5, 0);
    }
    if (Object.keys(actors).length > 0) heat[settlementId] = actors;
  }
  return heat;
}

export function getDowntimeHeat(
  configOrHeat,
  settlementId,
  actorId,
  fallback = 0,
) {
  const root = isPlainObject(configOrHeat?.heat)
    ? configOrHeat.heat
    : configOrHeat;
  const value = root?.[cleanId(settlementId)]?.[cleanId(actorId)];
  return boundedInteger(value, 0, 5, boundedInteger(fallback, 0, 5, 0));
}

/** Return a new Heat map with one actor's local Heat updated. */
export function setDowntimeHeat(rawHeat, settlementId, actorId, value) {
  const heat = normalizeDowntimeHeat(rawHeat);
  const normalizedSettlementId = cleanId(settlementId);
  const normalizedActorId = cleanId(actorId);
  if (!normalizedSettlementId || !normalizedActorId) return heat;
  heat[normalizedSettlementId] = {
    ...(heat[normalizedSettlementId] ?? {}),
    [normalizedActorId]: boundedInteger(value, 0, 5, 0),
  };
  return heat;
}

export function normalizeSecurityTier(value) {
  const key = String(value ?? "")
    .trim()
    .toLowerCase();
  if (SETTLEMENT_SECURITY_TIER_LIST.includes(key)) return key;
  return SECURITY_ALIASES[key] ?? SETTLEMENT_SECURITY_TIERS.STANDARD;
}

export function normalizeWealthTier(value) {
  const key = String(value ?? "")
    .trim()
    .toLowerCase();
  if (SETTLEMENT_WEALTH_TIER_LIST.includes(key)) return key;
  return WEALTH_ALIASES[key] ?? SETTLEMENT_WEALTH_TIERS.MODEST;
}

export function getSettlementSecurityDc(securityTier) {
  return SETTLEMENT_SECURITY_DCS[normalizeSecurityTier(securityTier)];
}

export function createSettlementIdFromName(name) {
  const slug = String(name ?? "")
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
  return `settlement-${slug || "unnamed"}`;
}

function normalizeEnabledActivities(value) {
  if (value === undefined || value === null) {
    return [...DOWNTIME_ACTIVITY_ID_LIST];
  }
  if (!Array.isArray(value)) return [...DOWNTIME_ACTIVITY_ID_LIST];
  const allowed = new Set(DOWNTIME_ACTIVITY_ID_LIST);
  return [
    ...new Set(
      value
        .map((id) => normalizeDowntimeActivityId(id))
        .filter((id) => allowed.has(id)),
    ),
  ];
}

function normalizeIdList(value) {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.map(cleanId).filter(Boolean))];
}

function cleanId(value) {
  return String(value ?? "")
    .trim()
    .replace(/[^A-Za-z0-9_.:-]/g, "")
    .slice(0, 160);
}

function cleanText(value, maxLength) {
  return String(value ?? "")
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, maxLength);
}

function boundedInteger(value, minimum, maximum, fallback) {
  if (value === null || value === undefined || value === "") return fallback;
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return fallback;
  return Math.max(minimum, Math.min(maximum, Math.trunc(numeric)));
}

function isPlainObject(value) {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function clonePlainRecord(value) {
  if (typeof globalThis.structuredClone === "function") {
    try {
      return globalThis.structuredClone(value);
    } catch {
      // Fall through to the JSON-safe clone used by the private state store.
    }
  }
  try {
    return JSON.parse(JSON.stringify(value));
  } catch {
    return {};
  }
}
