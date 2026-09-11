/** Exact DCs and hunting ACs never enter Foundry documents or sockets.
 * These versioned, world/user-scoped records belong to the originating GM browser.
 * Missing storage fails closed; switching GM browsers never substitutes defaults.
 */
import { isFullGM } from "../permissions.js";
import { defaultHuntingRegions, normalizeHuntingRegion } from "./hunting.js";
function key() {
  if (!isFullGM()) throw new Error("Only a full GM can access hunting rules.");
  return `infinity-dnd5e.hunting.v1.${globalThis.game?.world?.id ?? "world"}.${globalThis.game?.user?.id}`;
}
function read() {
  const storage = globalThis.localStorage;
  if (!storage)
    throw new Error(
      "Hunting needs browser storage on the originating GM browser.",
    );
  const raw = storage.getItem(key());
  if (!raw) return { version: 1, regions: {}, blocks: {} };
  const data = JSON.parse(raw);
  if (data.version !== 1 || !data.regions || !data.blocks)
    throw new Error("The saved hunting rules need GM recovery.");
  return data;
}
function write(data) {
  const serialized = JSON.stringify(data);
  globalThis.localStorage.setItem(key(), serialized);
  if (globalThis.localStorage.getItem(key()) !== serialized)
    throw new Error("Hunting rules could not be saved. No hunt was started.");
}
export function loadHuntingRegions() {
  if (!globalThis.localStorage) return defaultHuntingRegions();
  const data = read();
  const regions = new Map(defaultHuntingRegions().map((r) => [r.id, r]));
  for (const raw of Object.values(data.regions)) {
    const r = normalizeHuntingRegion(raw);
    regions.set(r.id, r);
  }
  return [...regions.values()];
}
export function saveHuntingRegion(raw) {
  const region = normalizeHuntingRegion(raw),
    data = read();
  data.regions[region.id] = region;
  write(data);
  return region;
}
export function saveHuntingBlock(blockId, region) {
  const data = read();
  const value = {
    region: normalizeHuntingRegion(region),
    seed: globalThis.crypto.randomUUID(),
  };
  if (data.blocks[blockId])
    throw new Error("This hunt already has frozen rules.");
  data.blocks[blockId] = value;
  write(data);
}
export function loadHuntingBlock(blockId) {
  const value = read().blocks[blockId];
  if (!value)
    throw new Error(
      "Finish this hunt on the GM browser that opened it; its hidden rules are stored there.",
    );
  return value;
}
