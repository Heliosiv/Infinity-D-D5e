/**
 * Guard against the recurring "shipped pack references art that isn't
 * bundled" regression (item art was silently dropped in v0.2.17 and again
 * lurks whenever the pack is edited without the assets in sync).
 *
 * Walks every img field in the NeDB source pack, and for any path pointing
 * at this module's own bundled assets (`modules/infinity-dnd5e/assets/...`)
 * asserts the corresponding file exists on disk. A missing file would show
 * as a broken icon in Foundry/Forge for that item.
 *
 * Cheap, source-only (no LevelDB compile needed). The release build does a
 * second pass over the *staged* tree (build-release.mjs verifyStage).
 */

import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";

const PACK_PATH = "packs/infinity-dnd5e-items.db";
const MODULE_ID = "infinity-dnd5e";
const SELF_ASSET_PREFIX = `modules/${MODULE_ID}/`;

function collectImageFields(value, jsonPath = "$") {
  if (!value || typeof value !== "object") return [];

  const images = [];
  if (Object.hasOwn(value, "img")) {
    images.push({
      path: `${jsonPath}.img`,
      imagePath: String(value.img ?? "").trim(),
    });
  }

  if (Array.isArray(value)) {
    for (const [index, entry] of value.entries()) {
      images.push(...collectImageFields(entry, `${jsonPath}[${index}]`));
    }
    return images;
  }

  for (const [key, entry] of Object.entries(value)) {
    images.push(...collectImageFields(entry, `${jsonPath}.${key}`));
  }
  return images;
}

const text = readFileSync(PACK_PATH, "utf8");
const lines = text.split(/\r?\n/).filter((line) => line.trim().length > 0);

const missing = [];
const referenced = new Set();

for (const [index, line] of lines.entries()) {
  let item;
  try {
    item = JSON.parse(line);
  } catch {
    // test-pack-shape.mjs already fails loudly on bad JSON; skip here.
    continue;
  }

  for (const field of collectImageFields(item)) {
    const ref = field.imagePath;
    if (!ref.startsWith(SELF_ASSET_PREFIX)) continue; // core/system icons: not ours to bundle
    // Map the runtime module path to the on-disk repo path.
    const diskPath = ref.slice(SELF_ASSET_PREFIX.length);
    referenced.add(diskPath);
    if (!existsSync(diskPath)) {
      missing.push(`line ${index + 1} (${item.name}) ${field.path} -> ${ref}`);
    }
  }
}

assert.equal(
  missing.length,
  0,
  `pack references ${missing.length} bundled art file(s) that are NOT on disk ` +
    `(would 404 in Foundry):\n  ${missing.join("\n  ")}`,
);

process.stdout.write(
  `art reference validation passed (${referenced.size} bundled art files referenced, all present)\n`,
);
