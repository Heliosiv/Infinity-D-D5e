/**
 * Guard against accidental duplicate item documents in the pack.
 *
 * Two documents are the SAME logical item when they share name + dnd5e type +
 * curated lootType + subtype + price + flavor-body text. Derived metadata, ids,
 * rarity drift, and art differences are ignored. Genuine variants (different
 * price/type/lootType/flavor — e.g. Amethyst 10gp vs 20gp, Incense potion vs
 * loot) are distinct signatures and therefore allowed.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const PACK_PATH = "packs/infinity-dnd5e-items.db";
const items = readFileSync(PACK_PATH, "utf8")
  .split(/\r?\n/)
  .filter((line) => line.trim().length > 0)
  .map((line) => JSON.parse(line));

const flavorBody = (item) => {
  const value = String(item.system?.description?.value || "");
  const match = value.match(/infinity-item-body[^>]*>([\s\S]*?)<\/div>/);
  return (match ? match[1] : value)
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
};

const signature = (item) =>
  JSON.stringify([
    item.name,
    item.type,
    String(item.flags?.["infinity-dnd5e"]?.lootType || ""),
    String(item.system?.type?.value || ""),
    Number(item.system?.price?.value || 0),
    String(item.system?.price?.denomination || ""),
    flavorBody(item),
  ]);

const seen = new Map();
const dups = [];
for (const item of items) {
  const sig = signature(item);
  if (seen.has(sig))
    dups.push(`${item.name} (${item._id}) duplicates ${seen.get(sig)}`);
  else seen.set(sig, item._id);
}

assert.equal(
  dups.length,
  0,
  `duplicate item documents found:\n  ${dups.join("\n  ")}`,
);

process.stdout.write(
  `pack duplicate check passed (${items.length} items, 0 duplicates)\n`,
);
