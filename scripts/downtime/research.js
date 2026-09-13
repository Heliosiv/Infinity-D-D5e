/** Drakmor Research & Rumors rules, validation and player-safe result building. */
import {
  downtimeTimeOfDayLabel,
  normalizeDowntimeTimeOfDay,
  normalizeTimeAvailability,
} from "./time-of-day.js";

export const RESEARCH_ID = "guided-research";

export const RESEARCH_CATEGORIES = Object.freeze([
  Object.freeze({ id: "anything", label: "Anything" }),
  Object.freeze({ id: "creature", label: "Creature" }),
  Object.freeze({ id: "person", label: "Person" }),
  Object.freeze({ id: "place", label: "Place" }),
  Object.freeze({ id: "faction", label: "Faction" }),
  Object.freeze({ id: "event", label: "Event" }),
  Object.freeze({ id: "object", label: "Object" }),
  Object.freeze({ id: "lead", label: "Lead" }),
  Object.freeze({ id: "hideout", label: "Hideout" }),
]);

export const RESEARCH_APPROACHES = Object.freeze([
  Object.freeze({
    id: "arc",
    label: "Arcana",
    source: "Arcane and occult sources",
  }),
  Object.freeze({
    id: "his",
    label: "History",
    source: "Archives and histories",
  }),
  Object.freeze({
    id: "inv",
    label: "Investigation",
    source: "Records and careful inquiry",
  }),
  Object.freeze({
    id: "nat",
    label: "Nature",
    source: "Field notes and natural lore",
  }),
  Object.freeze({
    id: "rel",
    label: "Religion",
    source: "Temples and sacred records",
  }),
  Object.freeze({
    id: "per",
    label: "Persuasion",
    source: "Experts, witnesses and contacts",
  }),
  Object.freeze({
    id: "ins",
    label: "Insight",
    source: "Rumor comparison and motive reading",
  }),
]);

export const RESEARCH_RESULT_TIERS = Object.freeze([
  Object.freeze({
    id: "dead-end",
    label: "Dead End",
    interim:
      "The search exhausted an obvious source but identified where a stronger inquiry could begin.",
  }),
  Object.freeze({
    id: "interesting-thread",
    label: "Interesting Thread",
    interim:
      "The search confirmed a credible thread. The GM is preparing the verified detail behind it.",
  }),
  Object.freeze({
    id: "meaningful-discovery",
    label: "Meaningful Discovery",
    interim:
      "The search uncovered reliable information. The GM is preparing the complete finding.",
  }),
  Object.freeze({
    id: "breakthrough",
    label: "Breakthrough",
    interim:
      "The search found a decisive connection and an actionable lead. The GM is preparing the full discovery.",
  }),
]);

export const RESEARCH_TEMPLATE = Object.freeze({
  id: RESEARCH_ID,
  researchVersion: 1,
  name: "Research & Rumors",
  description:
    "Ask a precise question, explore a broad subject, or browse for a campaign-curated discovery. Research can reveal verified facts, contacts, locations and leads without inventing hidden canon.",
  image: "icons/sundries/books/book-red-exclamation.webp",
  blockHours: 4,
  skills: RESEARCH_APPROACHES.map(({ id }) => id),
  outcomes: RESEARCH_RESULT_TIERS.map(({ label, interim }) => ({
    label,
    report: interim,
    rewardGp: 0,
  })),
});

const CATEGORY_IDS = new Set(RESEARCH_CATEGORIES.map(({ id }) => id));
const APPROACH_IDS = new Set(RESEARCH_APPROACHES.map(({ id }) => id));

const TIME_EFFECTS = Object.freeze({
  day: Object.freeze({
    arc: [0, 0],
    his: [-2, -4],
    inv: [-1, -2],
    nat: [0, 0],
    rel: [-1, -3],
    per: [0, 0],
    ins: [0, 0],
  }),
  night: Object.freeze({
    arc: [-1, 5],
    his: [2, 4],
    inv: [0, 3],
    nat: [1, 3],
    rel: [2, 4],
    per: [-1, 5],
    ins: [-1, 5],
  }),
});

export const RESEARCH_TIME_GUIDANCE = Object.freeze({
  day: "Archives, guilds, temples and officials are easier to reach during the day.",
  night:
    "Street contacts, taverns and occult inquiry are more active at night, while formal sources may be closed.",
});

export function normalizeResearchCategory(value) {
  const id = safeId(value).toLowerCase();
  return CATEGORY_IDS.has(id) ? id : "anything";
}

export function researchCategoryLabel(value) {
  const id = normalizeResearchCategory(value);
  return RESEARCH_CATEGORIES.find((entry) => entry.id === id).label;
}

export function normalizeResearchRequest(raw = {}) {
  const source = isRecord(raw) ? raw : {};
  const category = normalizeResearchCategory(source.category);
  const discoverNew = source.discoverNew === true;
  const subjectId = discoverNew ? "" : safeId(source.subjectId, 220);
  const subjectText = discoverNew ? "" : cleanText(source.subjectText, 200);
  const request =
    cleanText(source.request, 500) ||
    (subjectId || subjectText
      ? `Learn something useful about ${subjectText || "this subject"}.`
      : discoverNew || category !== "anything"
        ? `Discover something useful about ${researchCategoryLabel(category).toLowerCase()}.`
        : "Surprise me with something useful.");
  const mode =
    subjectId || subjectText
      ? "directed"
      : discoverNew || category !== "anything"
        ? "explore"
        : "browse";
  return { request, category, subjectId, subjectText, discoverNew, mode };
}

export function normalizeResearchSeed(raw = {}, index = 0) {
  if (!isRecord(raw)) throw new Error("A Research Seed must be a record.");
  const title = cleanText(raw.title, 160);
  const id = safeId(raw.id) || slugId(title) || `research-seed-${index + 1}`;
  if (!title) throw new Error("Name the Research Seed's subject.");
  const factCards = (Array.isArray(raw.factCards) ? raw.factCards : [])
    .slice(0, 8)
    .map((card, cardIndex) => normalizeResearchFactCard(card, cardIndex))
    .filter(Boolean);
  const skills = [
    ...new Set(
      (Array.isArray(raw.skills)
        ? raw.skills
        : RESEARCH_APPROACHES.map(({ id: skill }) => skill)
      )
        .map((skill) => safeId(skill).toLowerCase())
        .filter((skill) => APPROACH_IDS.has(skill)),
    ),
  ];
  if (!skills.length)
    throw new Error("Choose at least one approach for this Research Seed.");
  const times = normalizeTimeAvailability(raw.times);
  if (!times.length)
    throw new Error("Choose Day, Night, or both for this Research Seed.");
  const dc = integer(raw.dc ?? 14, 5, 40, "Research DC");
  return {
    id,
    title,
    category: normalizeResearchCategory(raw.category),
    gmSummary: cleanText(raw.gmSummary, 800),
    playerKnown: raw.playerKnown === true,
    discoverable: raw.discoverable !== false,
    difficulty: cleanText(raw.difficulty, 60) || researchDifficultyLabel(dc),
    dc,
    risk: integer(raw.risk ?? 10, 0, 100, "Complication chance"),
    times,
    skills,
    factCards,
    actionableDiscovery: cleanText(raw.actionableDiscovery, 800),
    complicationText: cleanText(raw.complicationText, 800),
    canonicalUuid: normalizeResearchUuid(raw.canonicalUuid),
    canonicalLabel: cleanText(raw.canonicalLabel, 160),
  };
}

export function normalizeResearchSeeds(raw) {
  const source = Array.isArray(raw) ? raw : [];
  const result = [];
  const ids = new Set();
  for (let index = 0; index < Math.min(200, source.length); index += 1) {
    const seed = normalizeResearchSeed(source[index], index);
    if (ids.has(seed.id))
      throw new Error("Each Research Seed needs a unique id.");
    ids.add(seed.id);
    result.push(seed);
  }
  return result;
}

export function normalizeResearchFactCard(raw = {}, index = 0) {
  if (!isRecord(raw)) return null;
  const text = cleanText(raw.text, 800);
  if (!text) return null;
  return {
    id: safeId(raw.id) || `fact-${index + 1}`,
    tier: integer(raw.tier ?? 1, 1, 3, "Fact-card tier"),
    text,
  };
}

export function normalizeResearchUuid(value) {
  const uuid = String(value ?? "")
    .trim()
    .slice(0, 300);
  if (!uuid) return "";
  return /^(?:Actor|JournalEntry|Compendium)\.[A-Za-z0-9_.-]+(?:\.JournalEntryPage\.[A-Za-z0-9_-]+)?$/.test(
    uuid,
  )
    ? uuid
    : "";
}

export function researchSeedEligible(seed, request, timeOfDay, skill) {
  const time = normalizeDowntimeTimeOfDay(timeOfDay);
  const approach = safeId(skill).toLowerCase();
  const query = normalizeResearchRequest(request);
  if (!seed || !seed.times.includes(time)) return false;
  if (!seed.skills.includes(approach)) return false;
  if (query.category !== "anything" && seed.category !== query.category)
    return false;
  if (query.subjectId.startsWith("research-seed:")) {
    return (
      seed.playerKnown === true &&
      seed.id === query.subjectId.slice("research-seed:".length)
    );
  }
  return seed.discoverable === true;
}

export function researchChallenge({
  seed = null,
  timeOfDay,
  skill,
  hours = 4,
}) {
  const duration = Number(hours);
  if (![4, 8].includes(duration))
    throw new Error("Choose four or eight hours for Research & Rumors.");
  const approach = safeId(skill).toLowerCase();
  if (!APPROACH_IDS.has(approach))
    throw new Error("Choose a valid research approach.");
  const time = normalizeDowntimeTimeOfDay(timeOfDay);
  const [dcDelta, riskDelta] = TIME_EFFECTS[time][approach];
  const baseDc = seed?.dc ?? 14;
  const baseRisk = seed?.risk ?? 10;
  const durationBonus = duration === 8 ? 2 : 0;
  const riskReduction = duration === 8 ? 2 : 0;
  const dc = Math.max(5, Math.min(40, baseDc + dcDelta - durationBonus));
  const risk = Math.max(0, Math.min(100, baseRisk + riskDelta - riskReduction));
  return {
    dc,
    difficulty: researchDifficultyLabel(dc),
    risk,
    timeOfDay: time,
    timeLabel: downtimeTimeOfDayLabel(time),
    timeDetail: RESEARCH_TIME_GUIDANCE[time],
  };
}

export function resolveResearchCase({
  request,
  seed = null,
  timeOfDay,
  hours,
  skill,
  roll,
  complicationRoll,
}) {
  const normalizedRequest = normalizeResearchRequest(request);
  const challenge = researchChallenge({ seed, timeOfDay, skill, hours });
  const total = finiteTotal(roll, "research");
  const margin = total - challenge.dc;
  const tier = margin >= 5 ? 3 : margin >= 0 ? 2 : margin >= -4 ? 1 : 0;
  const complication = percentile(complicationRoll) <= challenge.risk;
  const knownSubject = Boolean(
    normalizedRequest.subjectId || normalizedRequest.subjectText,
  );
  const subject =
    seed && (knownSubject || tier >= 1)
      ? seed.title
      : normalizedRequest.subjectText ||
        (knownSubject ? "Known subject" : "Unresolved lead");
  const revealedFactCards = seed
    ? seed.factCards.filter((card) => card.tier <= tier)
    : [];
  const actionableDiscovery = seed && tier >= 3 ? seed.actionableDiscovery : "";
  const complicationText = complication && seed ? seed.complicationText : "";
  const tierDefinition = RESEARCH_RESULT_TIERS[tier];
  const prepared =
    tier > 0 &&
    revealedFactCards.some((card) => card.tier === tier) &&
    (tier < 3 || Boolean(actionableDiscovery)) &&
    (!complication || Boolean(complicationText));
  const interim = prepared
    ? composeResearchDossier({
        tierLabel: tierDefinition.label,
        subject,
        factCards: revealedFactCards,
        actionableDiscovery,
        complication,
        complicationText,
      })
    : `${tierDefinition.interim}${complication ? " A complication was triggered and will be included in the GM's final report." : ""}`;
  return {
    request: normalizedRequest,
    seedId: seed?.id ?? "",
    subject,
    tier,
    tierId: tierDefinition.id,
    tierLabel: tierDefinition.label,
    skill,
    hours: Number(hours),
    timeOfDay: challenge.timeOfDay,
    difficulty: challenge.difficulty,
    dc: challenge.dc,
    risk: challenge.risk,
    roll: {
      total,
      formula: cleanText(roll?.formula, 160),
    },
    complication,
    prepared,
    status: prepared ? "prepared" : "needs-preparation",
    interim,
    revealedFactCards,
    actionableDiscovery,
    complicationText,
  };
}

export function composeResearchDossier({
  tierLabel,
  subject,
  factCards = [],
  actionableDiscovery = "",
  complication = false,
  complicationText = "",
  needsWorldBuilding = false,
} = {}) {
  const parts = [];
  const heading = [cleanText(tierLabel, 80), cleanText(subject, 160)]
    .filter(Boolean)
    .join(" — ");
  if (heading) parts.push(`${heading}.`);
  for (const card of factCards) {
    const text = cleanText(card?.text, 800);
    if (text) parts.push(text.endsWith(".") ? text : `${text}.`);
  }
  const action = cleanText(actionableDiscovery, 800);
  if (action) parts.push(`Actionable discovery: ${action}`);
  if (complication) {
    const text = cleanText(complicationText, 800);
    parts.push(
      text
        ? `Complication: ${text}`
        : "Complication: the GM will resolve the consequence in play.",
    );
  }
  if (needsWorldBuilding) {
    parts.push("Follow-up: the GM is preparing the discovered world detail.");
  }
  return cleanText(parts.join(" "), 3000);
}

export function researchDifficultyLabel(dc) {
  const value = Number(dc);
  if (value <= 9) return "Easy";
  if (value <= 12) return "Favorable";
  if (value <= 15) return "Challenging";
  if (value <= 18) return "Hard";
  if (value <= 22) return "Severe";
  return "Extreme";
}

export function publicResearchSubject(seed, timeOfDay) {
  const time = normalizeDowntimeTimeOfDay(timeOfDay);
  if (!seed?.playerKnown || !seed.times.includes(time)) return null;
  return {
    id: `research-seed:${seed.id}`,
    label: seed.title,
    category: seed.category,
    skills: [...seed.skills],
    profiles: researchPlayerProfiles({ seed, timeOfDay: time }),
    detail: `${seed.difficulty} · ${seed.risk}% base complication · ${seed.skills
      .map(
        (skill) =>
          RESEARCH_APPROACHES.find((entry) => entry.id === skill)?.label,
      )
      .filter(Boolean)
      .join(", ")}`,
  };
}

export function researchPlayerProfiles({ seed = null, timeOfDay } = {}) {
  const allowedSkills = new Set(
    seed?.skills ?? RESEARCH_APPROACHES.map(({ id }) => id),
  );
  return [4, 8].flatMap((hours) =>
    RESEARCH_APPROACHES.filter(({ id }) => allowedSkills.has(id)).map(
      ({ id: skill }) => {
        const challenge = researchChallenge({
          seed,
          timeOfDay,
          skill,
          hours,
        });
        return {
          skill,
          hours,
          difficulty: challenge.difficulty,
          risk: challenge.risk,
        };
      },
    ),
  );
}

function finiteTotal(roll, label) {
  const total = Number(roll?.total);
  if (!Number.isFinite(total) || total < -100 || total > 1_000)
    throw new Error(`Submit a valid ${label} check.`);
  return Math.round(total * 100) / 100;
}

function percentile(value) {
  return integer(value, 1, 100, "Research percentile roll");
}

function integer(value, minimum, maximum, label) {
  const numeric = Number(value);
  if (!Number.isSafeInteger(numeric) || numeric < minimum || numeric > maximum)
    throw new Error(
      `${label}: enter a whole number from ${minimum} to ${maximum}.`,
    );
  return numeric;
}

function safeId(value, maximum = 100) {
  return String(value ?? "")
    .trim()
    .replace(/[^A-Za-z0-9_.:-]/g, "")
    .slice(0, maximum);
}

function slugId(value) {
  const slug = String(value ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 70);
  return slug ? `research-${slug}` : "";
}

function cleanText(value, maximum) {
  return String(value ?? "")
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, maximum);
}

function isRecord(value) {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

export function isResearchTemplate(template) {
  return template?.id === RESEARCH_ID && template.researchVersion === 1;
}
