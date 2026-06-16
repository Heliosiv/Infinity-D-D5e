/**
 * Smoke-test that the bundled compendium still parses, that every
 * line is a valid item document, and that the loot tag schema is
 * present on enough items for the roller to function.
 *
 * Cheap to run, catches a corrupt copy / line-ending mangle / merge
 * conflict markers in the pack file before they land in Foundry.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  getItemGpValue,
  getItemKeywords,
  getItemLootType,
  getItemRarity,
  getItemTier,
} from "./loot/tag-vocabulary.js";

const PACK_PATH = "packs/infinity-dnd5e-items.db";
const DEFAULT_IMAGE_PATHS = new Set([
  "icons/svg/item-bag.svg",
  "icons/svg/mystery-man.svg",
]);
const GENERATED_LOCAL_IMAGE_PATTERN = /DALL|^ddb-images\//i;
const LEAKED_SOURCE_ID = /^(Compendium\.party-operations|Compendium\.world|Actor\.|Item\.)/;

/** Recursively collect every `sourceId` value in a document. */
function collectSourceIds(value) {
  if (!value || typeof value !== "object") return [];
  const ids = [];
  if (typeof value.sourceId === "string") ids.push(value.sourceId);
  if (Array.isArray(value)) {
    for (const entry of value) ids.push(...collectSourceIds(entry));
    return ids;
  }
  for (const entry of Object.values(value)) ids.push(...collectSourceIds(entry));
  return ids;
}

function collectImageFields(value, path = "$") {
  if (!value || typeof value !== "object") return [];

  const images = [];
  if (Object.hasOwn(value, "img")) {
    images.push({
      path: `${path}.img`,
      imagePath: String(value.img ?? "").trim(),
    });
  }

  if (Array.isArray(value)) {
    for (const [index, entry] of value.entries()) {
      images.push(...collectImageFields(entry, `${path}[${index}]`));
    }
    return images;
  }

  for (const [key, entry] of Object.entries(value)) {
    images.push(...collectImageFields(entry, `${path}.${key}`));
  }
  return images;
}

const text = readFileSync(PACK_PATH, "utf8");
const lines = text.split(/\r?\n/).filter((line) => line.trim().length > 0);

assert.ok(
  lines.length > 1000,
  `expected 1000+ items in pack, got ${lines.length}`,
);

let withKeywords = 0;
let withLootType = 0;
let withTier = 0;
let withRarity = 0;
let withGpValue = 0;
let withImage = 0;
let totalGp = 0;
let badJson = 0;
const defaultImageItems = [];
const forgeImageItems = [];
const generatedLocalImageItems = [];
const invalidDnd5eFormulaItems = [];
const leakedSourceIdItems = [];

for (const [index, line] of lines.entries()) {
  let item;
  try {
    item = JSON.parse(line);
  } catch {
    badJson += 1;
    continue;
  }

  assert.ok(item._id, `line ${index} missing _id`);
  assert.ok(item.name, `line ${index} missing name`);
  assert.ok(item.type, `line ${index} missing type`);

  const imagePath = String(item.img ?? "").trim();
  if (imagePath) withImage += 1;

  for (const imageField of collectImageFields(item)) {
    if (
      !imageField.imagePath ||
      DEFAULT_IMAGE_PATHS.has(imageField.imagePath)
    ) {
      defaultImageItems.push(`${index + 1}:${item.name}:${imageField.path}`);
    }
    if (/^https:\/\/assets\.forge-vtt\.com\//i.test(imageField.imagePath)) {
      forgeImageItems.push(`${index + 1}:${item.name}:${imageField.path}`);
    }
    if (GENERATED_LOCAL_IMAGE_PATTERN.test(imageField.imagePath)) {
      generatedLocalImageItems.push(
        `${index + 1}:${item.name}:${imageField.path}`,
      );
    }
  }

  for (const sourceId of collectSourceIds(item)) {
    if (LEAKED_SOURCE_ID.test(sourceId)) {
      leakedSourceIdItems.push(`${index + 1}:${item.name}:${sourceId}`);
    }
  }

  const durationValue = String(item.system?.duration?.value ?? "");
  if (/[<>?]/.test(durationValue)) {
    invalidDnd5eFormulaItems.push(
      `${index + 1}:${item.name}:system.duration.value=${durationValue}`,
    );
  }

  for (const [activityId, activity] of Object.entries(
    item.system?.activities ?? {},
  )) {
    const activityDuration = String(activity?.duration?.value ?? "");
    if (/[<>?]/.test(activityDuration)) {
      invalidDnd5eFormulaItems.push(
        `${index + 1}:${item.name}:${activityId}.duration.value=${activityDuration}`,
      );
    }

    for (const [partIndex, part] of (activity?.damage?.parts ?? []).entries()) {
      const formula = String(part?.custom?.formula ?? "");
      if (/\)\s*d\d+/i.test(formula)) {
        invalidDnd5eFormulaItems.push(
          `${index + 1}:${item.name}:${activityId}.damage.parts.${partIndex}.custom.formula=${formula}`,
        );
      }
    }
  }

  if (getItemKeywords(item).length > 0) withKeywords += 1;
  if (getItemLootType(item)) withLootType += 1;
  if (getItemTier(item)) withTier += 1;
  if (getItemRarity(item)) withRarity += 1;
  const gp = getItemGpValue(item);
  if (gp > 0) {
    withGpValue += 1;
    totalGp += gp;
  }
}

assert.equal(badJson, 0, `${badJson} unparseable lines in pack`);
assert.equal(
  withImage,
  lines.length,
  "every pack item must define an img path",
);
assert.equal(
  defaultImageItems.length,
  0,
  `default placeholder image paths remain: ${defaultImageItems.join(", ")}`,
);
assert.equal(
  forgeImageItems.length,
  0,
  `direct Forge asset image paths remain: ${forgeImageItems.join(", ")}`,
);
assert.equal(
  generatedLocalImageItems.length,
  0,
  `unshipped generated local image paths remain: ${generatedLocalImageItems.join(", ")}`,
);
assert.equal(
  invalidDnd5eFormulaItems.length,
  0,
  `dnd5e-invalid formula fields remain: ${invalidDnd5eFormulaItems.join(", ")}`,
);
assert.equal(
  leakedSourceIdItems.length,
  0,
  `leaked/private sourceId references remain (party-operations/world/Actor/Item): ${leakedSourceIdItems.join(", ")}`,
);
const coverage = (count) => (count / lines.length) * 100;

// At minimum, 80% of the pack must carry the loot tag schema. The
// current pack hits ~100% but we leave headroom for partial-schema
// experimentation without breaking CI.
assert.ok(
  coverage(withKeywords) >= 80,
  `only ${coverage(withKeywords).toFixed(1)}% of items have keyword tags`,
);
assert.ok(
  coverage(withLootType) >= 80,
  `only ${coverage(withLootType).toFixed(1)}% of items have lootType`,
);
assert.ok(
  coverage(withTier) >= 80,
  `only ${coverage(withTier).toFixed(1)}% of items have tier`,
);
assert.ok(
  coverage(withRarity) >= 80,
  `only ${coverage(withRarity).toFixed(1)}% of items have rarity`,
);
assert.ok(
  coverage(withGpValue) >= 80,
  `only ${coverage(withGpValue).toFixed(1)}% of items have gpValue`,
);

process.stdout.write(
  `pack shape validation passed (${lines.length} items, ${Math.round(totalGp).toLocaleString()} gp total)\n`,
);
