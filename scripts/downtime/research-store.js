/** GM-only seeds and cases live in the shared campaign record store. */
import { normalizeResearchSeed } from "./research.js";
import {
  readPrivateDowntimeFamily,
  updatePrivateDowntimeFamily,
} from "./private-records.js";
const read = () => readPrivateDowntimeFamily("research");
export function loadResearchSeeds() {
  return structuredClone(read().seeds);
}

export function saveResearchSeed(raw) {
  return updatePrivateDowntimeFamily("research", (data) => {
    const seed = normalizeResearchSeed(raw, data.seeds.length);
    const index = data.seeds.findIndex((entry) => entry.id === seed.id);
    if (index >= 0) data.seeds[index] = seed;
    else if (data.seeds.length < 200) data.seeds.push(seed);
    else throw new Error("The Research Seed library is full (200 entries).");
    return structuredClone(seed);
  });
}

export function deleteResearchSeed(seedId) {
  return updatePrivateDowntimeFamily("research", (data) => {
    const id = cleanId(seedId);
    const before = data.seeds.length;
    data.seeds = data.seeds.filter((seed) => seed.id !== id);
    if (data.seeds.length === before)
      throw new Error("That Research Seed no longer exists.");
    return true;
  });
}

export function createResearchSecret() {
  return String(
    globalThis.crypto?.randomUUID?.() ??
      `${Date.now()}-${Math.random().toString(36).slice(2)}`,
  );
}

export function saveResearchBlock(
  blockId,
  { timeOfDay = "day", locationName = "Downtime" } = {},
) {
  return updatePrivateDowntimeFamily("research", (data) => {
    const id = cleanId(blockId);
    if (!id) throw new Error("Research block id is required.");
    if (data.blocks[id])
      throw new Error(
        "This Research block already has frozen confidential rules.",
      );
    data.blocks[id] = {
      id,
      secret: createResearchSecret(),
      timeOfDay: String(timeOfDay),
      locationName: String(locationName).slice(0, 160),
      seeds: structuredClone(data.seeds),
      cases: {},
      createdAt: Date.now(),
    };
    return structuredClone(data.blocks[id]);
  });
}

export function loadResearchBlock(blockId) {
  const block = read().blocks[cleanId(blockId)];
  if (!block)
    throw new Error(
      "This Research block has no campaign record. Import saved browser records from the GM browser that opened it.",
    );
  return structuredClone(block);
}

export function loadResearchCase(blockId, actorId) {
  return loadResearchBlock(blockId).cases?.[cleanId(actorId)] ?? null;
}

/** A GM correction may invalidate one un-applied case without touching others. */
export function voidResearchCase(blockId, actorId) {
  return updatePrivateDowntimeFamily("research", (data) => {
    const block = data.blocks[cleanId(blockId)];
    const key = cleanId(actorId);
    if (!block || !key) throw new Error("Research case is unavailable.");
    if (!block.cases?.[key]) return false;
    block.voidedCases = [
      ...(Array.isArray(block.voidedCases) ? block.voidedCases : []),
      { actorId: key, case: block.cases[key], voidedAt: Date.now() },
    ].slice(-100);
    delete block.cases[key];
    return true;
  });
}

export function deleteResearchBlock(blockId) {
  return updatePrivateDowntimeFamily("research", (data) => {
    const blockKey = cleanId(blockId);
    if (!blockKey) return false;
    if (!data.blocks[blockKey]) return false;
    delete data.blocks[blockKey];
    return true;
  });
}

export function saveResearchCase(blockId, actorId, researchCase) {
  return updatePrivateDowntimeFamily("research", (data) => {
    const blockKey = cleanId(blockId);
    const actorKey = cleanId(actorId);
    if (!blockKey || !actorKey || !researchCase)
      throw new Error("A Research case needs a block, character and result.");
    const block = data.blocks[blockKey];
    if (!block)
      throw new Error(
        "This Research block has no campaign record. Import saved browser records from the GM browser that opened it.",
      );
    const previous = block.cases?.[actorKey];
    if (previous && previous.queueKey !== researchCase.queueKey)
      throw new Error(
        "This Research case has started. Its request, approach, time and roll cannot be changed.",
      );
    block.cases ??= {};
    block.cases[actorKey] = structuredClone(
      previous ? { ...previous, ...researchCase } : researchCase,
    );
    return structuredClone(block.cases[actorKey]);
  });
}

export function listResearchCases() {
  const data = read();
  return Object.values(data.blocks)
    .flatMap((block) =>
      Object.entries(block.cases ?? {}).map(([actorId, researchCase]) => ({
        blockId: block.id,
        actorId,
        locationName: block.locationName,
        timeOfDay: block.timeOfDay,
        ...structuredClone(researchCase),
      })),
    )
    .sort(
      (left, right) =>
        Number(right.updatedAt ?? 0) - Number(left.updatedAt ?? 0),
    );
}

export function completeResearchFollowUp(blockId, actorId) {
  return updatePrivateDowntimeFamily("research", (data) => {
    const blockKey = cleanId(blockId);
    const actorKey = cleanId(actorId);
    const researchCase = data.blocks[blockKey]?.cases?.[actorKey];
    if (!researchCase)
      throw new Error("That Research follow-up no longer exists.");
    if (
      researchCase.approved !== true ||
      researchCase.needsWorldBuilding !== true
    )
      throw new Error("That Research case is not waiting for world building.");
    researchCase.needsWorldBuilding = false;
    researchCase.worldBuildingCompletedAt = Date.now();
    researchCase.updatedAt = researchCase.worldBuildingCompletedAt;
    return structuredClone(researchCase);
  });
}

function cleanId(value) {
  return String(value ?? "")
    .trim()
    .replace(/[^A-Za-z0-9_.:-]/g, "")
    .slice(0, 180);
}
