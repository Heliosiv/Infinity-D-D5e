/**
 * Confidential Research Seeds and unrevealed case material stay in the
 * originating full-GM browser. The shared downtime workflow receives only the
 * player's request, frozen tier and facts that have already been revealed.
 */
import { isFullGM } from "../permissions.js";
import { normalizeResearchSeed, normalizeResearchSeeds } from "./research.js";

const STORE_VERSION = 1;

function key() {
  if (!isFullGM())
    throw new Error(
      "Only a full GM can access confidential Research material.",
    );
  return `infinity-dnd5e.research.v1.${globalThis.game?.world?.id ?? "world"}.${globalThis.game?.user?.id}`;
}

function emptyStore() {
  return { version: STORE_VERSION, seeds: [], blocks: {} };
}

function read() {
  const storage = globalThis.localStorage;
  if (!storage)
    throw new Error(
      "Research & Rumors needs browser storage on the originating GM browser.",
    );
  const raw = storage.getItem(key());
  if (!raw) return emptyStore();
  let data;
  try {
    data = JSON.parse(raw);
  } catch {
    throw new Error(
      "The saved confidential Research material needs GM recovery.",
    );
  }
  if (
    data?.version !== STORE_VERSION ||
    !Array.isArray(data.seeds) ||
    !data.blocks
  )
    throw new Error(
      "The saved confidential Research material needs GM recovery.",
    );
  return {
    version: STORE_VERSION,
    seeds: normalizeResearchSeeds(data.seeds),
    blocks: structuredClone(data.blocks),
  };
}

function write(data) {
  const storage = globalThis.localStorage;
  if (!storage)
    throw new Error(
      "Research & Rumors needs browser storage on the originating GM browser.",
    );
  const serialized = JSON.stringify(data);
  storage.setItem(key(), serialized);
  if (storage.getItem(key()) !== serialized)
    throw new Error(
      "Research material could not be saved. No case was changed.",
    );
}

export function loadResearchSeeds() {
  if (!globalThis.localStorage) return [];
  return structuredClone(read().seeds);
}

export function saveResearchSeed(raw) {
  const data = read();
  const seed = normalizeResearchSeed(raw, data.seeds.length);
  const index = data.seeds.findIndex((entry) => entry.id === seed.id);
  if (index >= 0) data.seeds[index] = seed;
  else if (data.seeds.length < 200) data.seeds.push(seed);
  else throw new Error("The Research Seed library is full (200 entries).");
  write(data);
  return structuredClone(seed);
}

export function deleteResearchSeed(seedId) {
  const id = cleanId(seedId);
  const data = read();
  const before = data.seeds.length;
  data.seeds = data.seeds.filter((seed) => seed.id !== id);
  if (data.seeds.length === before)
    throw new Error("That Research Seed no longer exists.");
  write(data);
  return true;
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
  const id = cleanId(blockId);
  if (!id) throw new Error("Research block id is required.");
  const data = read();
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
  write(data);
  return structuredClone(data.blocks[id]);
}

export function loadResearchBlock(blockId) {
  const block = read().blocks[cleanId(blockId)];
  if (!block)
    throw new Error(
      "Finish this Research block on the GM browser that opened it; its hidden cases are stored there.",
    );
  return structuredClone(block);
}

export function loadResearchCase(blockId, actorId) {
  return loadResearchBlock(blockId).cases?.[cleanId(actorId)] ?? null;
}

export function deleteResearchBlock(blockId) {
  const blockKey = cleanId(blockId);
  if (!blockKey) return false;
  const data = read();
  if (!data.blocks[blockKey]) return false;
  delete data.blocks[blockKey];
  write(data);
  return true;
}

export function saveResearchCase(blockId, actorId, researchCase) {
  const blockKey = cleanId(blockId);
  const actorKey = cleanId(actorId);
  if (!blockKey || !actorKey || !researchCase)
    throw new Error("A Research case needs a block, character and result.");
  const data = read();
  const block = data.blocks[blockKey];
  if (!block)
    throw new Error(
      "Finish this Research block on the GM browser that opened it; its hidden cases are stored there.",
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
  write(data);
  return structuredClone(block.cases[actorKey]);
}

export function listResearchCases() {
  if (!globalThis.localStorage) return [];
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
  const blockKey = cleanId(blockId);
  const actorKey = cleanId(actorId);
  const data = read();
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
  write(data);
  return structuredClone(researchCase);
}

function cleanId(value) {
  return String(value ?? "")
    .trim()
    .replace(/[^A-Za-z0-9_.:-]/g, "")
    .slice(0, 180);
}
