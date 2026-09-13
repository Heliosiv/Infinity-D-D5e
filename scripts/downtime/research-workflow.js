/** Research & Rumors submission, confidential preparation and safe dossier operations. */
import { isFullGM } from "../permissions.js";
import { deterministicDowntimeRoll } from "./opportunities.js";
import {
  RESEARCH_ID,
  RESEARCH_RESULT_TIERS,
  composeResearchDossier,
  normalizeResearchCategory,
  normalizeResearchFactCard,
  normalizeResearchRequest,
  normalizeResearchUuid,
  researchCategoryLabel,
  researchSeedEligible,
  resolveResearchCase,
} from "./research.js";
import {
  loadResearchBlock,
  loadResearchCase,
  saveResearchCase,
} from "./research-store.js";

export function researchQueueKey(queue) {
  return JSON.stringify(
    (queue ?? []).map(({ researchResult, ...entry }) => entry),
  );
}

export async function prepareResearchAttempt(block, actor, queue) {
  const entry = (queue ?? []).find(
    (candidate) => candidate.activityId === RESEARCH_ID,
  );
  if (!entry) return null;
  const queueKey = researchQueueKey(queue);
  const previous = loadResearchCase(block.id, actor.id);
  if (previous) {
    if (previous.queueKey !== queueKey)
      throw new Error(
        "This Research case has started. Its request, approach, time and roll cannot be changed.",
      );
    return publicResearchAttempt(previous);
  }
  const secretBlock = loadResearchBlock(block.id);
  const request = normalizeResearchRequest(entry.research);
  const seed = selectResearchSeed({
    seeds: secretBlock.seeds,
    request,
    timeOfDay: block.timeOfDay,
    skill: entry.skill,
    secret: secretBlock.secret,
    actorId: actor.id,
  });
  const complicationRoll =
    1 +
    Math.floor(
      deterministicDowntimeRoll(
        secretBlock.secret,
        `${actor.id}:${queueKey}:research-complication`,
      ) * 100,
    );
  const result = resolveResearchCase({
    request,
    seed,
    timeOfDay: block.timeOfDay,
    hours: entry.hours,
    skill: entry.skill,
    roll: entry.guidedRoll,
    complicationRoll,
  });
  const safeSubject =
    result.prepared ||
    seed?.playerKnown ||
    request.subjectId ||
    request.subjectText
      ? result.subject
      : "Unresolved lead";
  const researchCase = {
    id: `research-case-${block.id}-${actor.id}`,
    queueKey,
    actorId: actor.id,
    actorName: String(actor.name ?? "Character").slice(0, 160),
    request,
    skill: entry.skill,
    hours: entry.hours,
    timeOfDay: result.timeOfDay,
    tier: result.tier,
    tierId: result.tierId,
    tierLabel: result.tierLabel,
    difficulty: result.difficulty,
    dc: result.dc,
    risk: result.risk,
    roll: result.roll,
    complication: result.complication,
    seedId: seed?.id ?? "",
    seedSnapshot: seed ? structuredClone(seed) : null,
    subject: result.subject,
    factCards: seed ? structuredClone(seed.factCards) : [],
    actionableDiscovery: seed?.actionableDiscovery ?? "",
    complicationText: seed?.complicationText ?? "",
    canonicalUuid:
      seed?.canonicalUuid ?? normalizeResearchUuid(request.subjectId),
    canonicalLabel: seed?.canonicalLabel ?? request.subjectText ?? "",
    shareCanonicalLink: false,
    needsWorldBuilding: false,
    worldBuildingNotes: "",
    prepared: result.prepared,
    approved: result.prepared,
    playerDossier: result.interim,
    publicAttempt: {
      request,
      subject: safeSubject,
      tier: result.tier,
      tierId: result.tierId,
      tierLabel: result.tierLabel,
      difficulty: result.difficulty,
      risk: result.risk,
      complication: result.complication,
      status: result.status,
      interim: result.interim,
      revealedFactCards: result.prepared
        ? structuredClone(result.revealedFactCards)
        : [],
      actionableDiscovery: result.prepared ? result.actionableDiscovery : "",
      complicationText: result.prepared ? result.complicationText : "",
    },
    createdAt: Date.now(),
    updatedAt: Date.now(),
    ...(result.prepared ? { approvedAt: Date.now() } : {}),
  };
  return publicResearchAttempt(
    await saveResearchCase(block.id, actor.id, researchCase),
  );
}

export async function buildResearchOperation({
  block,
  actor,
  operationId,
  createdAt,
  report = "",
  review = null,
}) {
  let researchCase = loadResearchCase(block.id, actor.id);
  if (!researchCase)
    throw new Error(
      "The confidential Research case is missing. Import saved browser records from the GM browser that opened the block.",
    );
  if (review) {
    researchCase = await reviewResearchCase({
      block,
      actor,
      researchCase,
      review,
      report,
    });
  }
  const publicAttempt = publicResearchAttempt(researchCase);
  const playerDossier = cleanText(
    researchCase.approved
      ? (review ? researchCase.playerDossier : report) ||
          researchCase.playerDossier ||
          publicAttempt.interim
      : publicAttempt.interim,
    3000,
  );
  const deliveredSubject = researchCase.approved
    ? cleanText(researchCase.subject, 160)
    : publicAttempt.subject;
  const deliveredFacts = researchCase.approved
    ? revealedFacts(researchCase)
    : publicAttempt.revealedFactCards;
  const researchResult = {
    request: structuredClone(researchCase.request),
    subject: deliveredSubject,
    category: normalizeResearchCategory(researchCase.request?.category),
    categoryLabel: researchCategoryLabel(researchCase.request?.category),
    tier: researchCase.tier,
    tierId: researchCase.tierId,
    tierLabel: researchCase.tierLabel,
    difficulty: researchCase.difficulty,
    risk: researchCase.risk,
    complication: researchCase.complication === true,
    status: researchCase.approved
      ? researchCase.needsWorldBuilding
        ? "needs-world-building"
        : "approved"
      : "needs-preparation",
    dossier: playerDossier,
    factCards: deliveredFacts,
    actionableDiscovery:
      researchCase.approved && researchCase.tier >= 3
        ? cleanText(researchCase.actionableDiscovery, 800)
        : "",
    complicationText:
      researchCase.approved && researchCase.complication
        ? cleanText(researchCase.complicationText, 800)
        : "",
    needsWorldBuilding:
      researchCase.approved && researchCase.needsWorldBuilding === true,
    ...(researchCase.approved &&
    researchCase.shareCanonicalLink &&
    researchCase.canonicalUuid
      ? {
          canonicalUuid: researchCase.canonicalUuid,
          canonicalLabel:
            cleanText(researchCase.canonicalLabel, 160) || researchCase.subject,
        }
      : {}),
  };
  return {
    operationId,
    kind: "noop",
    mode: "guided",
    actorId: actor.id,
    settlementId: block.settlementId || "guided-downtime",
    activityId: RESEARCH_ID,
    activityLabel: "Research & Rumors",
    activityImage: "icons/sundries/books/book-red-exclamation.webp",
    hours: researchCase.hours,
    createdAt,
    selectedOutcomeIndex: researchCase.tier,
    outcomeLabel: researchCase.tierLabel,
    report: playerDossier,
    summary: `${researchCase.tierLabel}: ${playerDossier}`,
    research: true,
    researchApproved: researchCase.approved === true,
    researchResult,
    check: {
      skill: researchCase.skill,
      total: researchCase.roll.total,
      formula: String(researchCase.roll.formula ?? ""),
      outcomeTier: researchCase.tierId,
    },
  };
}

export function publicResearchAttempt(researchCase) {
  const result = researchCase?.publicAttempt ?? {};
  const tier = Math.max(
    0,
    Math.min(3, Number(result.tier ?? researchCase?.tier) || 0),
  );
  const prepared = result.status === "prepared";
  const complication = result.complication === true;
  return {
    queueKey: String(researchCase?.queueKey ?? ""),
    request: structuredClone(result.request ?? researchCase?.request ?? {}),
    subject: cleanText(result.subject, 160) || "Unresolved lead",
    tier,
    tierId: String(result.tierId ?? researchCase?.tierId ?? "dead-end"),
    tierLabel: cleanText(result.tierLabel ?? researchCase?.tierLabel, 80),
    difficulty: cleanText(result.difficulty ?? researchCase?.difficulty, 80),
    risk: Math.max(
      0,
      Math.min(100, Number(result.risk ?? researchCase?.risk) || 0),
    ),
    complication,
    status: prepared ? "prepared" : "needs-preparation",
    interim:
      cleanText(result.interim, 3000) || RESEARCH_RESULT_TIERS[tier].interim,
    revealedFactCards: prepared
      ? (result.revealedFactCards ?? [])
          .slice(0, 8)
          .map((card) => ({
            tier: Math.max(1, Math.min(3, Number(card.tier) || 1)),
            text: cleanText(card.text, 800),
          }))
          .filter((card) => card.text && card.tier <= tier)
      : [],
    actionableDiscovery:
      prepared && tier >= 3 ? cleanText(result.actionableDiscovery, 800) : "",
    complicationText:
      prepared && complication ? cleanText(result.complicationText, 800) : "",
  };
}

export function researchSummary(attempt) {
  if (!attempt) return "Research request submitted.";
  const subject =
    attempt.subject && attempt.subject !== "Unresolved lead"
      ? ` Subject: ${attempt.subject}.`
      : "";
  const challenge = [
    attempt.difficulty ? `Difficulty: ${attempt.difficulty}.` : "",
    Number.isFinite(Number(attempt.risk))
      ? `Complication chance: ${Number(attempt.risk)}%.`
      : "",
  ]
    .filter(Boolean)
    .join(" ");
  return `${attempt.tierLabel}.${subject} ${challenge} ${attempt.interim}`.trim();
}

export function researchCaseForWorkspace(blockId, actorId) {
  const researchCase = loadResearchCase(blockId, actorId);
  if (!researchCase) return null;
  return {
    id: researchCase.id,
    actorId: researchCase.actorId,
    actorName: researchCase.actorName,
    request: structuredClone(researchCase.request),
    skill: researchCase.skill,
    hours: researchCase.hours,
    timeOfDay: researchCase.timeOfDay,
    tier: researchCase.tier,
    tierId: researchCase.tierId,
    tierLabel: researchCase.tierLabel,
    difficulty: researchCase.difficulty,
    dc: researchCase.dc,
    risk: researchCase.risk,
    roll: structuredClone(researchCase.roll),
    complication: researchCase.complication === true,
    seedId: researchCase.seedId ?? "",
    subject: researchCase.subject ?? "",
    factCards: structuredClone(researchCase.factCards ?? []),
    actionableDiscovery: researchCase.actionableDiscovery ?? "",
    complicationText: researchCase.complicationText ?? "",
    canonicalUuid: researchCase.canonicalUuid ?? "",
    canonicalLabel: researchCase.canonicalLabel ?? "",
    shareCanonicalLink: researchCase.shareCanonicalLink === true,
    needsWorldBuilding: researchCase.needsWorldBuilding === true,
    worldBuildingNotes: researchCase.worldBuildingNotes ?? "",
    prepared: researchCase.prepared === true,
    approved: researchCase.approved === true,
    playerDossier: researchCase.playerDossier ?? "",
    updatedAt: researchCase.updatedAt,
  };
}

async function reviewResearchCase({
  block,
  actor,
  researchCase,
  review,
  report,
}) {
  const secretBlock = loadResearchBlock(block.id);
  const requestedSeedId = Object.hasOwn(review, "seedId")
    ? String(review.seedId ?? "")
    : null;
  const chosenSeed =
    requestedSeedId === null
      ? researchCase.seedSnapshot
      : requestedSeedId
        ? secretBlock.seeds.find((seed) => seed.id === requestedSeedId)
        : null;
  if (requestedSeedId && !chosenSeed)
    throw new Error("Choose a valid frozen Research Seed for this block.");
  const priorSeedId = String(
    researchCase.seedSnapshot?.id ?? researchCase.seedId ?? "",
  );
  const seedChanged =
    requestedSeedId !== null && requestedSeedId !== priorSeedId;
  const hasReviewCards = Array.isArray(review.factCards);
  const reviewCards = hasReviewCards
    ? review.factCards
        .map((card, index) => normalizeResearchFactCard(card, index))
        .filter(Boolean)
    : [];
  const cardsChanged =
    hasReviewCards &&
    !researchFactCardsEqual(reviewCards, researchCase.factCards ?? []);
  const factCards =
    seedChanged && chosenSeed && !cardsChanged
      ? structuredClone(chosenSeed.factCards)
      : hasReviewCards
        ? reviewCards
        : structuredClone(researchCase.factCards ?? []);
  const subject = chooseSeedReviewText({
    review,
    key: "subject",
    maximum: 160,
    prior: researchCase.subject,
    seedValue: chosenSeed?.title,
    seedChanged: seedChanged && Boolean(chosenSeed),
  });
  if (!subject || subject === "Unresolved lead")
    throw new Error(
      "Name the canonical subject before approving this dossier.",
    );
  const applicableFacts = factCards.filter(
    (card) => card.tier <= researchCase.tier,
  );
  if (
    researchCase.tier > 0 &&
    !applicableFacts.some((card) => card.tier === researchCase.tier)
  ) {
    throw new Error(
      `Add at least one ${researchCase.tierLabel} fact card before approving this dossier.`,
    );
  }
  const complicationText = chooseSeedReviewText({
    review,
    key: "complicationText",
    maximum: 800,
    prior: researchCase.complicationText,
    seedValue: chosenSeed?.complicationText,
    seedChanged: seedChanged && Boolean(chosenSeed),
  });
  if (researchCase.complication && !complicationText)
    throw new Error("Describe the triggered complication before approval.");
  const actionableDiscovery = chooseSeedReviewText({
    review,
    key: "actionableDiscovery",
    maximum: 800,
    prior: researchCase.actionableDiscovery,
    seedValue: chosenSeed?.actionableDiscovery,
    seedChanged: seedChanged && Boolean(chosenSeed),
  });
  if (researchCase.tier >= 3 && !actionableDiscovery)
    throw new Error(
      "Describe the actionable discovery earned by this Breakthrough before approval.",
    );
  const needsWorldBuilding = Object.hasOwn(review, "needsWorldBuilding")
    ? review.needsWorldBuilding === true
    : researchCase.needsWorldBuilding === true;
  const submittedCanonicalUuid = Object.hasOwn(review, "canonicalUuid")
    ? String(review.canonicalUuid ?? "").trim()
    : "";
  if (submittedCanonicalUuid && !normalizeResearchUuid(submittedCanonicalUuid))
    throw new Error("Enter a valid Actor or Journal UUID, or leave it blank.");
  const canonicalUuid = chooseSeedReviewUuid({
    review,
    prior: researchCase.canonicalUuid,
    seedValue: chosenSeed?.canonicalUuid,
    seedChanged: seedChanged && Boolean(chosenSeed),
  });
  const shareCanonicalLink = Object.hasOwn(review, "shareCanonicalLink")
    ? review.shareCanonicalLink === true
    : !seedChanged && researchCase.shareCanonicalLink === true;
  const canonicalLabel =
    chooseSeedReviewText({
      review,
      key: "canonicalLabel",
      maximum: 160,
      prior: researchCase.canonicalLabel,
      seedValue: chosenSeed?.canonicalLabel,
      seedChanged: seedChanged && Boolean(chosenSeed),
    }) || subject;
  if (shareCanonicalLink) {
    if (!canonicalUuid)
      throw new Error(
        "Choose an exact Actor or Journal UUID before sharing its link.",
      );
    await assertResearchDocumentVisibleToOwners(canonicalUuid, actor);
  }
  const generatedDossier = composeResearchDossier({
    tierLabel: researchCase.tierLabel,
    subject,
    factCards: applicableFacts,
    actionableDiscovery: researchCase.tier >= 3 ? actionableDiscovery : "",
    complication: researchCase.complication,
    complicationText,
    needsWorldBuilding,
  });
  let authoredDossier = cleanText(report || review.playerDossier, 3000);
  if (
    !authoredDossier &&
    !Object.hasOwn(review, "playerDossier") &&
    !seedChanged &&
    researchCase.approved &&
    ![
      "subject",
      "factCards",
      "actionableDiscovery",
      "complicationText",
      "needsWorldBuilding",
    ].some((key) => Object.hasOwn(review, key))
  ) {
    authoredDossier = cleanText(researchCase.playerDossier, 3000);
  }
  if (
    seedChanged &&
    authoredDossier === cleanText(researchCase.playerDossier, 3000)
  ) {
    authoredDossier = "";
  }
  const playerDossier =
    authoredDossier || (researchCase.tier > 0 ? generatedDossier : "");
  if (!playerDossier)
    throw new Error(
      "Write a useful player-facing dead-end dossier with the next source or revised direction.",
    );
  const next = {
    ...researchCase,
    seedId:
      requestedSeedId === null
        ? (chosenSeed?.id ?? researchCase.seedId ?? "")
        : (chosenSeed?.id ?? ""),
    seedSnapshot:
      requestedSeedId === null
        ? researchCase.seedSnapshot
        : chosenSeed
          ? structuredClone(chosenSeed)
          : null,
    subject,
    factCards,
    actionableDiscovery,
    complicationText,
    canonicalUuid,
    canonicalLabel,
    shareCanonicalLink,
    needsWorldBuilding,
    worldBuildingNotes: cleanText(
      Object.hasOwn(review, "worldBuildingNotes")
        ? review.worldBuildingNotes
        : researchCase.worldBuildingNotes,
      1000,
    ),
    prepared: true,
    approved: true,
    playerDossier,
    approvedAt: Date.now(),
    updatedAt: Date.now(),
  };
  next.publicAttempt = {
    ...next.publicAttempt,
    subject,
    status: "prepared",
    interim: playerDossier,
    revealedFactCards: structuredClone(applicableFacts),
    actionableDiscovery: researchCase.tier >= 3 ? actionableDiscovery : "",
    complicationText: researchCase.complication ? complicationText : "",
  };
  return saveResearchCase(block.id, actor.id, next);
}

function chooseSeedReviewText({
  review,
  key,
  maximum,
  prior,
  seedValue,
  seedChanged,
}) {
  const priorText = cleanText(prior, maximum);
  if (!Object.hasOwn(review, key))
    return seedChanged ? cleanText(seedValue, maximum) : priorText;
  const reviewText = cleanText(review[key], maximum);
  if (seedChanged && reviewText === priorText)
    return cleanText(seedValue, maximum);
  return reviewText;
}

function chooseSeedReviewUuid({ review, prior, seedValue, seedChanged }) {
  const priorUuid = normalizeResearchUuid(prior);
  if (!Object.hasOwn(review, "canonicalUuid"))
    return seedChanged ? normalizeResearchUuid(seedValue) : priorUuid;
  const reviewUuid = normalizeResearchUuid(review.canonicalUuid);
  if (seedChanged && reviewUuid === priorUuid)
    return normalizeResearchUuid(seedValue);
  return reviewUuid;
}

function researchFactCardsEqual(left, right) {
  const comparable = (cards) =>
    (cards ?? []).map((card) => ({
      id: String(card?.id ?? ""),
      tier: Number(card?.tier) || 1,
      text: cleanText(card?.text, 800),
    }));
  return JSON.stringify(comparable(left)) === JSON.stringify(comparable(right));
}

export async function assertResearchDocumentVisibleToOwners(uuid, actor) {
  const resolver = globalThis.fromUuid;
  if (typeof resolver !== "function")
    throw new Error(
      "The linked Actor or Journal cannot be verified right now.",
    );
  const document = await resolver(uuid);
  if (!document)
    throw new Error("The linked Actor or Journal no longer exists.");
  if (!researchDocumentAllowed(document)) {
    throw new Error("Only an Actor or Journal can be shared as Research.");
  }
  const users = collectionValues(globalThis.game?.users).filter(
    (user) => !isFullGM(user) && actorOwner(user, actor),
  );
  if (users.some((user) => !researchDocumentVisibleToUser(document, user))) {
    throw new Error(
      "That Actor or Journal is not player-safe for every owner. Change its Foundry permissions separately, or leave Share link off.",
    );
  }
}

export function researchDocumentVisibleToUser(document, user) {
  if (!document || !user || !researchDocumentAllowed(document)) return false;
  if (isFullGM(user)) return true;
  if (typeof document.testUserPermission === "function") {
    return document.testUserPermission(user, "OBSERVER") === true;
  }
  return ownershipAllowsObserver(document, user);
}

export async function researchUuidVisibleToUser(uuid, user) {
  if (!normalizeResearchUuid(uuid) || typeof globalThis.fromUuid !== "function")
    return false;
  try {
    return researchDocumentVisibleToUser(await globalThis.fromUuid(uuid), user);
  } catch (_error) {
    return false;
  }
}

function actorOwner(user, actor) {
  const owner = globalThis.CONST?.DOCUMENT_OWNERSHIP_LEVELS?.OWNER ?? 3;
  const ownership = actor?.ownership ?? {};
  if (Object.hasOwn(ownership, user?.id))
    return Number(ownership[user.id]) >= owner;
  const assigned =
    typeof user?.character === "string" ? user.character : user?.character?.id;
  return (
    String(assigned ?? "") === String(actor?.id ?? "") ||
    Number(ownership.default) >= owner
  );
}

function ownershipAllowsObserver(document, user) {
  const observer = globalThis.CONST?.DOCUMENT_OWNERSHIP_LEVELS?.OBSERVER ?? 2;
  const ownership = document?.ownership ?? {};
  const level = Object.hasOwn(ownership, user?.id)
    ? ownership[user.id]
    : ownership.default;
  return Number(level) >= observer;
}

function researchDocumentAllowed(document) {
  return ["Actor", "JournalEntry", "JournalEntryPage"].includes(
    String(document?.documentName ?? ""),
  );
}

function revealedFacts(researchCase) {
  return (researchCase.factCards ?? [])
    .filter((card) => card.tier <= researchCase.tier)
    .map((card) => ({ tier: card.tier, text: cleanText(card.text, 800) }));
}

function selectResearchSeed({
  seeds,
  request,
  timeOfDay,
  skill,
  secret,
  actorId,
}) {
  if (request.subjectId.startsWith("research-seed:")) {
    const id = request.subjectId.slice("research-seed:".length);
    const exact = seeds.find((seed) => seed.id === id && seed.playerKnown);
    if (!exact || !researchSeedEligible(exact, request, timeOfDay, skill))
      throw new Error(
        "That known research subject is not available through this approach now.",
      );
    return exact;
  }
  if (request.subjectId || request.subjectText) return null;
  const eligible = seeds.filter((seed) =>
    researchSeedEligible(seed, request, timeOfDay, skill),
  );
  if (!eligible.length) return null;
  const index = Math.floor(
    deterministicDowntimeRoll(
      secret,
      `${actorId}:${JSON.stringify(request)}:${skill}:research-seed`,
    ) * eligible.length,
  );
  return eligible[Math.min(index, eligible.length - 1)];
}

function collectionValues(collection) {
  if (!collection) return [];
  if (Array.isArray(collection.contents)) return collection.contents;
  if (typeof collection.values === "function") return [...collection.values()];
  return Array.from(collection ?? []);
}

function cleanText(value, maximum) {
  return String(value ?? "")
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, maximum);
}
