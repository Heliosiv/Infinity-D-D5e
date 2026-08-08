/**
 * Deterministic, player-safe city targets for downtime pickpocketing.
 *
 * The output intentionally contains no roll, DC, value, faction, inventory, or
 * hidden settlement data. The GM workflow persists the seed and selected ids,
 * then derives the authoritative result separately.
 */

const PICKPOCKET_MARK_ARCHETYPES = Object.freeze([
  Object.freeze({
    key: "distracted-shopper",
    label: "Distracted Shopper",
    description: "A shopper juggling parcels while comparing street stalls.",
  }),
  Object.freeze({
    key: "off-duty-sailor",
    label: "Off-Duty Sailor",
    description: "A sailor celebrating shore leave with an inattentive crowd.",
  }),
  Object.freeze({
    key: "hurried-clerk",
    label: "Hurried Clerk",
    description: "A clerk rushing between offices with papers tucked underarm.",
  }),
  Object.freeze({
    key: "market-tourist",
    label: "Wide-Eyed Visitor",
    description: "A visitor absorbed by unfamiliar signs and performers.",
  }),
  Object.freeze({
    key: "tired-courier",
    label: "Tired Courier",
    description: "A footsore courier pausing to check a bundle of directions.",
  }),
  Object.freeze({
    key: "boastful-gambler",
    label: "Boastful Gambler",
    description:
      "A gambler loudly retelling the evening's most fortunate hand.",
  }),
  Object.freeze({
    key: "festival-reveler",
    label: "Festival Reveler",
    description: "A reveler swept along by music, food, and a cheerful crowd.",
  }),
  Object.freeze({
    key: "sleepy-porter",
    label: "Sleepy Porter",
    description: "A porter nodding off beside a stack of waiting luggage.",
  }),
  Object.freeze({
    key: "street-spectator",
    label: "Street Spectator",
    description:
      "A spectator craning for a better view of a public performance.",
  }),
  Object.freeze({
    key: "chatty-peddler",
    label: "Chatty Peddler",
    description: "A peddler focused more on a story than the passing crowd.",
  }),
  Object.freeze({
    key: "lost-pilgrim",
    label: "Lost Pilgrim",
    description: "A pilgrim studying landmarks and repeatedly checking a map.",
  }),
  Object.freeze({
    key: "busy-teamster",
    label: "Busy Teamster",
    description:
      "A teamster preoccupied with harnesses, traffic, and a stubborn mule.",
  }),
]);

export const PICKPOCKET_OPPORTUNITY_COUNT = 3;

/**
 * Create a private per-block secret using the host's cryptographic RNG.
 * Downtime creation fails closed when no secure random source is available.
 */
export function createDowntimeOpportunitySecret(cryptoApi = globalThis.crypto) {
  if (typeof cryptoApi?.getRandomValues === "function") {
    const bytes = new Uint8Array(32);
    cryptoApi.getRandomValues(bytes);
    return Array.from(bytes, (value) =>
      value.toString(16).padStart(2, "0"),
    ).join("");
  }
  if (typeof cryptoApi?.randomUUID === "function") {
    return cryptoApi
      .randomUUID()
      .replace(/[^A-Fa-f0-9]/g, "")
      .toLowerCase();
  }
  throw new Error("DowntimeSecureRandomUnavailable");
}

/** Build the canonical per-character opportunity seed for a downtime block. */
export function buildPickpocketOpportunitySeed({
  blockId,
  settlementId,
  actorId,
  secret,
} = {}) {
  return ["pickpocket-v2", secret, blockId, settlementId, actorId]
    .map((part) => String(part ?? "").trim())
    .join("|");
}

/**
 * Generate exactly three unique player-safe mark choices from a stable seed.
 * Calling this with the same seed and settlement id always returns the same
 * objects in the same order.
 */
export function generatePickpocketOpportunities({
  seed,
  settlementId = "",
  count = PICKPOCKET_OPPORTUNITY_COUNT,
} = {}) {
  const requestedCount = Math.max(
    0,
    Math.min(
      PICKPOCKET_OPPORTUNITY_COUNT,
      Number.isFinite(Number(count)) ? Math.trunc(Number(count)) : 0,
    ),
  );
  const canonicalSeed = `${String(seed ?? "")}|${String(settlementId ?? "")}`;
  const random = createSeededRandom(canonicalSeed);
  const candidates = PICKPOCKET_MARK_ARCHETYPES.map((entry) => ({
    entry,
    sort: random(),
  })).sort((left, right) => left.sort - right.sort);

  return candidates.slice(0, requestedCount).map(({ entry }, index) => ({
    id: `mark-${stableHashHex(`${canonicalSeed}|${entry.key}|${index}`)}`,
    targetType: "generated-mark",
    label: entry.label,
    description: entry.description,
  }));
}

export function isGeneratedPickpocketOpportunityId(value) {
  return /^mark-[0-9a-f]{8}$/.test(String(value ?? ""));
}

/** A deterministic number in [0, 1), useful for server-side reward tables. */
export function deterministicDowntimeRoll(seed, salt = "") {
  return createSeededRandom(`${String(seed ?? "")}|${String(salt ?? "")}`)();
}

function createSeededRandom(seed) {
  let state = stableHash32(seed) || 0x6d2b79f5;
  return () => {
    state += 0x6d2b79f5;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4_294_967_296;
  };
}

function stableHashHex(value) {
  return stableHash32(value).toString(16).padStart(8, "0");
}

function stableHash32(value) {
  let hash = 0x811c9dc5;
  for (const character of String(value ?? "")) {
    hash ^= character.codePointAt(0);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}
