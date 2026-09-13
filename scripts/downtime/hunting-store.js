/** Hunting rules and frozen rolls live in the encrypted GM vault. */
import { defaultHuntingRegions, normalizeHuntingRegion } from "./hunting.js";
import {
  readPrivateDowntimeFamily,
  updatePrivateDowntimeFamily,
} from "./private-records.js";
const read = () => readPrivateDowntimeFamily("hunting");
export function loadHuntingRegions() {
  const data = read();
  const regions = new Map(defaultHuntingRegions().map((r) => [r.id, r]));
  for (const raw of Object.values(data.regions)) {
    const r = normalizeHuntingRegion(raw);
    regions.set(r.id, r);
  }
  return [...regions.values()];
}
export function saveHuntingRegion(raw) {
  return updatePrivateDowntimeFamily("hunting", (data) => {
    const region = normalizeHuntingRegion(raw);
    data.regions[region.id] = region;
    return region;
  });
}
export function saveHuntingBlock(blockId, region) {
  return updatePrivateDowntimeFamily("hunting", (data) => {
    const value = {
      region: normalizeHuntingRegion(region),
      seed: globalThis.crypto.randomUUID(),
    };
    if (data.blocks[blockId])
      throw new Error("This hunt already has frozen rules.");
    data.blocks[blockId] = value;
    return value;
  });
}
export function loadHuntingBlock(blockId) {
  const value = read().blocks[blockId];
  if (!value)
    throw new Error(
      "This hunt has no vault record. Import saved browser records from the GM browser that opened it.",
    );
  return value;
}
