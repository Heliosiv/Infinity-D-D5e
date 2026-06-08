/**
 * Assert every item's curated lootType is compatible with its underlying dnd5e
 * item type + subtype. lootType drives the UI chips, roller, and merchant
 * filters, so a mismatch (e.g. a Wondrous Item tagged as light armor, a deck
 * tagged as a potion) silently routes the item to the wrong place.
 *
 * Reuses getItemLootType for alias canonicalization. Spell source documents
 * (loot.spell) are exempt — they are not loot themselves.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { getItemLootType } from "./loot/tag-vocabulary.js";

const PACK_PATH = "packs/infinity-dnd5e-items.db";
const ARMOR_SUBTYPES = new Set([
  "light",
  "medium",
  "heavy",
  "shield",
  "natural",
]);

const items = readFileSync(PACK_PATH, "utf8")
  .split(/\r?\n/)
  .filter((line) => line.trim().length > 0)
  .map((line) => JSON.parse(line));

function allowed(item) {
  const sub = String(item.system?.type?.value ?? "")
    .trim()
    .toLowerCase();
  switch (item.type) {
    case "weapon":
      return new Set(["loot.weapon.mundane", "loot.weapon.magic"]);
    case "equipment":
      return ARMOR_SUBTYPES.has(sub)
        ? new Set(["loot.armor.mundane", "loot.armor.magic"])
        : new Set(["loot.equipment", "loot.equipment.magic"]);
    case "consumable":
      if (sub === "potion") return new Set(["loot.potion"]);
      if (sub === "scroll") return new Set(["loot.scroll"]);
      if (sub === "reagent") return new Set(["loot.reagent"]);
      if (sub === "ammo" || sub === "ammunition")
        return new Set(["loot.consumable", "loot.ammunition"]);
      return new Set(["loot.consumable"]);
    case "tool":
      return new Set(["loot.tool"]);
    case "loot":
      if (sub === "gem") return new Set(["loot.gem"]);
      if (sub === "art") return new Set(["loot.art"]);
      if (sub === "reagent") return new Set(["loot.reagent"]);
      return new Set([
        "loot.trade-good",
        "loot.gem",
        "loot.art",
        "loot.reagent",
      ]);
    case "container":
    case "backpack":
      return new Set(["loot.container"]);
    case "spell":
      return new Set(["loot.spell"]);
    default:
      return null;
  }
}

const offenders = [];
for (const item of items) {
  const lootType = getItemLootType(item);
  if (!lootType) continue;
  const ok = allowed(item);
  if (ok && !ok.has(lootType)) {
    offenders.push(
      `${item.name} (${item._id}): ${item.type}/${item.system?.type?.value || "-"} tagged ${lootType}, expected {${[...ok].join(", ")}}`,
    );
  }
}

assert.equal(
  offenders.length,
  0,
  `lootType/dnd5e-type mismatches:\n  ${offenders.slice(0, 40).join("\n  ")}${
    offenders.length > 40 ? `\n  ...and ${offenders.length - 40} more` : ""
  }`,
);

process.stdout.write(
  `pack lootType check passed (${items.length} items; lootType matches dnd5e type)\n`,
);
