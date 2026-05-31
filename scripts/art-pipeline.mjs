#!/usr/bin/env node
/**
 * Build, validate, restore, and apply the Infinity D&D5e generated item-art plan.
 *
 * This script intentionally does not call the Image API. It prepares
 * deterministic batch inputs, validates generated WebP assets, protects
 * existing compendium icons, and only rewrites pack item.img paths for items
 * whose original artwork is absent.
 */

import { existsSync } from "node:fs";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..");

const PLAN_PATH = path.join(repoRoot, "assets", "item-art-plan.json");
const PACK_PATH = path.join(repoRoot, "packs", "infinity-dnd5e-items.db");
const TMP_IMAGEGEN_DIR = path.join(repoRoot, "tmp", "imagegen");
const PLAN_SCHEMA = "infinity-dnd5e-item-art-plan-v2";
const MODULE_ID = "infinity-dnd5e";

const ABSENT_ART_PATHS = new Set([
  "icons/svg/item-bag.svg",
  "icons/commodities/gems/gem-faceted-round-red.webp",
  "icons/equipment/head/mask-ornate-silver.webp",
  "icons/commodities/treasure/statue-carved-faceless.webp",
]);

const ABSENT_ART_PATTERNS = Object.freeze([
  /^$/,
  /^icons\/svg\/item-bag\.svg$/i,
  /^icons\/commodities\/treasure\/token-/i,
]);

export const ART_CONFIG = Object.freeze({
  model: "gpt-image-2",
  quality: "high",
  size: "1024x1024",
  outputFormat: "webp",
  background: "opaque",
  expectedWidth: 1024,
  expectedHeight: 1024,
  minBytes: 4096,
});

export const JOB_FILES = Object.freeze({
  shared: path.join(TMP_IMAGEGEN_DIR, "infinity-item-art-shared.jsonl"),
  unique: path.join(TMP_IMAGEGEN_DIR, "infinity-item-art-unique.jsonl"),
});

const ASSET_ROOTS = Object.freeze({
  shared: path.join(repoRoot, "assets", "item-art", "shared"),
  unique: path.join(repoRoot, "assets", "item-art", "unique"),
});

function toRepoRelative(absolutePath) {
  return path.relative(repoRoot, absolutePath).split(path.sep).join("/");
}

function fromRepoRelative(relativePath) {
  const cleaned = String(relativePath ?? "").replaceAll("\\", "/");
  const resolved = path.resolve(repoRoot, cleaned);
  const relative = path.relative(repoRoot, resolved);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error(`Path escapes repo root: ${relativePath}`);
  }
  return resolved;
}

function normalizeArtPath(value) {
  return String(value ?? "").trim().replaceAll("\\", "/");
}

export function isGeneratedItemArtPath(value) {
  const normalized = normalizeArtPath(value);
  return (
    normalized.startsWith("assets/item-art/") ||
    normalized.startsWith(`modules/${MODULE_ID}/assets/item-art/`)
  );
}

export function toFoundryItemArtPath(value) {
  const normalized = normalizeArtPath(value);
  if (!normalized.startsWith("assets/item-art/")) return normalized;
  return `modules/${MODULE_ID}/${normalized}`;
}

export function toRepoItemArtPath(value) {
  const normalized = normalizeArtPath(value);
  const modulePrefix = `modules/${MODULE_ID}/`;
  return normalized.startsWith(modulePrefix)
    ? normalized.slice(modulePrefix.length)
    : normalized;
}

export function existingCompendiumArtPath(item) {
  const nativeFallback = normalizeArtPath(
    item?.flags?.["infinity-dnd5e"]?.art?.fallbackIcon,
  );
  if (nativeFallback) return nativeFallback;

  const legacyFallback = normalizeArtPath(
    item?.flags?.["party-operations"]?.art?.fallbackIcon,
  );
  if (legacyFallback) return legacyFallback;

  const current = normalizeArtPath(item?.img);
  return isGeneratedItemArtPath(current) ? "" : current;
}

export function artworkAbsenceReason(item) {
  const source = existingCompendiumArtPath(item);
  if (!source) return "missing source image path";
  if (ABSENT_ART_PATHS.has(source)) return `default placeholder: ${source}`;
  if (/^icons\/commodities\/treasure\/token-/i.test(source)) {
    return `generic treasure token placeholder: ${source}`;
  }
  if (ABSENT_ART_PATTERNS.some((pattern) => pattern.test(source))) {
    return `default placeholder: ${source}`;
  }
  return "";
}

export function isArtworkAbsent(item) {
  return artworkAbsenceReason(item).length > 0;
}

export async function loadArtPlan() {
  return JSON.parse(await readFile(PLAN_PATH, "utf8"));
}

async function loadPackItems() {
  const text = await readFile(PACK_PATH, "utf8");
  return text
    .split(/\r?\n/)
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line));
}

export function validatePlanShape(plan) {
  const errors = [];
  if (plan?.schema !== PLAN_SCHEMA) {
    errors.push(`Unexpected art-plan schema: ${plan?.schema ?? "(missing)"}`);
  }

  const sharedAssets = Array.isArray(plan?.sharedAssets)
    ? plan.sharedAssets
    : [];
  const uniqueAssets = Array.isArray(plan?.uniqueAssets)
    ? plan.uniqueAssets
    : [];
  const assignments = Array.isArray(plan?.assignments) ? plan.assignments : [];
  const assets = getPlannedAssets(plan);
  const assetIds = new Set();
  const assetPaths = new Set();
  const assignmentIds = new Set();

  for (const asset of assets) {
    if (!asset.id) errors.push("Asset missing id");
    if (!asset.path)
      errors.push(`Asset ${asset.id ?? "(missing)"} missing path`);
    if (assetIds.has(asset.id)) errors.push(`Duplicate asset id: ${asset.id}`);
    if (assetPaths.has(asset.path)) {
      errors.push(`Duplicate asset path: ${asset.path}`);
    }
    assetIds.add(asset.id);
    assetPaths.add(asset.path);
  }

  for (const assignment of assignments) {
    if (!assignment.itemId) errors.push("Assignment missing itemId");
    if (!assetIds.has(assignment.assetId)) {
      errors.push(
        `Assignment ${assignment.itemId ?? "(missing)"} references missing asset ${assignment.assetId}`,
      );
    }
    if (assignment.path && !assetPaths.has(assignment.path)) {
      errors.push(
        `Assignment ${assignment.itemId ?? "(missing)"} references missing path ${assignment.path}`,
      );
    }
    if (assignmentIds.has(assignment.itemId)) {
      errors.push(`Duplicate assignment item id: ${assignment.itemId}`);
    }
    assignmentIds.add(assignment.itemId);
  }

  if (plan?.counts?.sharedAssets !== sharedAssets.length) {
    errors.push(
      `Shared asset count mismatch: ${plan?.counts?.sharedAssets} != ${sharedAssets.length}`,
    );
  }
  if (plan?.counts?.uniqueAssets !== uniqueAssets.length) {
    errors.push(
      `Unique asset count mismatch: ${plan?.counts?.uniqueAssets} != ${uniqueAssets.length}`,
    );
  }
  if (plan?.counts?.totalAssetsToGenerate !== assets.length) {
    errors.push(
      `Total asset count mismatch: ${plan?.counts?.totalAssetsToGenerate} != ${assets.length}`,
    );
  }
  if (plan?.counts?.items !== assignments.length) {
    errors.push(
      `Assignment item count mismatch: ${plan?.counts?.items} != ${assignments.length}`,
    );
  }

  if (errors.length > 0) {
    throw new Error(`Invalid item-art plan:\n${errors.join("\n")}`);
  }
}

export function getPlannedAssets(plan) {
  return [
    ...(plan?.sharedAssets ?? []).map((asset) => ({
      ...asset,
      kind: "shared",
    })),
    ...(plan?.uniqueAssets ?? []).map((asset) => ({
      ...asset,
      kind: "unique",
    })),
  ];
}

export function buildArtJobs(plan, { kind, missingOnly = false } = {}) {
  validatePlanShape(plan);
  const kinds = kind ? [kind] : ["shared", "unique"];
  const allowedKinds = new Set(kinds);
  return getPlannedAssets(plan)
    .filter((asset) => allowedKinds.has(asset.kind))
    .filter((asset) => {
      if (!missingOnly) return true;
      return !existsSync(fromRepoRelative(asset.path));
    })
    .map((asset) => ({
      asset,
      job: {
        prompt: String(asset.prompt ?? "").trim(),
        out: path.basename(asset.path),
        model: ART_CONFIG.model,
        n: 1,
        size: ART_CONFIG.size,
        quality: ART_CONFIG.quality,
        background: ART_CONFIG.background,
        output_format: ART_CONFIG.outputFormat,
      },
    }));
}

async function writeJobsFile(kind, jobs) {
  await mkdir(TMP_IMAGEGEN_DIR, { recursive: true });
  await mkdir(ASSET_ROOTS[kind], { recursive: true });
  const body = jobs.map(({ job }) => JSON.stringify(job)).join("\n");
  await writeFile(JOB_FILES[kind], body ? `${body}\n` : "", "utf8");
}

async function commandJobs({ missingOnly = false } = {}) {
  const plan = await loadArtPlan();
  validatePlanShape(plan);
  const sharedJobs = buildArtJobs(plan, { kind: "shared", missingOnly });
  const uniqueJobs = buildArtJobs(plan, { kind: "unique", missingOnly });
  await writeJobsFile("shared", sharedJobs);
  await writeJobsFile("unique", uniqueJobs);
  console.log(
    `Wrote ${toRepoRelative(JOB_FILES.shared)} (${sharedJobs.length} shared jobs)`,
  );
  console.log(
    `Wrote ${toRepoRelative(JOB_FILES.unique)} (${uniqueJobs.length} unique jobs)`,
  );
  if (!missingOnly) {
    assertJobCount("shared", sharedJobs.length, plan.counts.sharedAssets);
    assertJobCount("unique", uniqueJobs.length, plan.counts.uniqueAssets);
  }
}

function assertJobCount(kind, actual, expected) {
  if (actual !== expected) {
    throw new Error(`${kind} job count mismatch: ${actual} != ${expected}`);
  }
}

export async function validateGeneratedAssets(plan, { presentOnly = false } = {}) {
  validatePlanShape(plan);
  const errors = [];
  const records = new Map();

  for (const asset of getPlannedAssets(plan)) {
    const absolutePath = fromRepoRelative(asset.path);
    const prefix = asset.id ?? asset.path;
    try {
      if (!asset.path.startsWith(`assets/item-art/${asset.kind}/`)) {
        errors.push(`${prefix}: invalid asset path ${asset.path}`);
        continue;
      }
      if (path.extname(asset.path).toLowerCase() !== ".webp") {
        errors.push(`${prefix}: expected .webp extension`);
        continue;
      }
      if (!existsSync(absolutePath)) {
        if (presentOnly) continue;
        errors.push(`${prefix}: missing generated asset ${asset.path}`);
        continue;
      }
      const info = await stat(absolutePath);
      if (!info.isFile()) {
        errors.push(`${prefix}: path is not a file`);
        continue;
      }
      if (info.size < ART_CONFIG.minBytes) {
        errors.push(
          `${prefix}: file is unexpectedly tiny (${info.size} bytes)`,
        );
      }
      const buffer = await readFile(absolutePath);
      const dimensions = readWebpDimensions(buffer);
      if (
        dimensions.width !== ART_CONFIG.expectedWidth ||
        dimensions.height !== ART_CONFIG.expectedHeight
      ) {
        errors.push(
          `${prefix}: expected ${ART_CONFIG.expectedWidth}x${ART_CONFIG.expectedHeight}, got ${dimensions.width}x${dimensions.height}`,
        );
      }
      if (dimensions.width !== dimensions.height) {
        errors.push(
          `${prefix}: expected square image, got ${dimensions.width}x${dimensions.height}`,
        );
      }
      records.set(asset.path, {
        asset,
        size: info.size,
        dimensions,
      });
    } catch (error) {
      errors.push(`${prefix}: ${error.message}`);
    }
  }

  return { errors, records };
}

export function readWebpDimensions(buffer) {
  if (!Buffer.isBuffer(buffer)) {
    throw new TypeError("readWebpDimensions expects a Buffer");
  }
  if (
    buffer.length < 20 ||
    buffer.toString("ascii", 0, 4) !== "RIFF" ||
    buffer.toString("ascii", 8, 12) !== "WEBP"
  ) {
    throw new Error("not a RIFF WebP file");
  }

  let offset = 12;
  while (offset + 8 <= buffer.length) {
    const chunkId = buffer.toString("ascii", offset, offset + 4);
    const chunkSize = buffer.readUInt32LE(offset + 4);
    const dataOffset = offset + 8;
    const nextOffset = dataOffset + chunkSize + (chunkSize % 2);

    if (dataOffset + chunkSize > buffer.length) {
      throw new Error(`truncated WebP chunk ${chunkId}`);
    }

    if (chunkId === "VP8X") {
      if (chunkSize < 10) throw new Error("invalid VP8X chunk");
      return {
        width: 1 + readUInt24LE(buffer, dataOffset + 4),
        height: 1 + readUInt24LE(buffer, dataOffset + 7),
        chunk: chunkId,
      };
    }

    if (chunkId === "VP8L") {
      if (chunkSize < 5 || buffer[dataOffset] !== 0x2f) {
        throw new Error("invalid VP8L chunk");
      }
      const b0 = buffer[dataOffset + 1];
      const b1 = buffer[dataOffset + 2];
      const b2 = buffer[dataOffset + 3];
      const b3 = buffer[dataOffset + 4];
      return {
        width: 1 + (((b1 & 0x3f) << 8) | b0),
        height: 1 + (((b3 & 0x0f) << 10) | (b2 << 2) | ((b1 & 0xc0) >> 6)),
        chunk: chunkId,
      };
    }

    if (chunkId === "VP8 ") {
      if (
        chunkSize < 10 ||
        buffer[dataOffset + 3] !== 0x9d ||
        buffer[dataOffset + 4] !== 0x01 ||
        buffer[dataOffset + 5] !== 0x2a
      ) {
        throw new Error("invalid VP8 chunk");
      }
      return {
        width: buffer.readUInt16LE(dataOffset + 6) & 0x3fff,
        height: buffer.readUInt16LE(dataOffset + 8) & 0x3fff,
        chunk: chunkId,
      };
    }

    offset = nextOffset;
  }

  throw new Error("no WebP dimension chunk found");
}

function readUInt24LE(buffer, offset) {
  return (
    buffer[offset] | (buffer[offset + 1] << 8) | (buffer[offset + 2] << 16)
  );
}

async function commandValidate() {
  const plan = await loadArtPlan();
  const result = await validateGeneratedAssets(plan, {
    presentOnly: new Set(process.argv.slice(2)).has("--present-only"),
  });
  if (result.errors.length > 0) {
    throw new Error(
      `Item-art validation failed (${result.errors.length} issue(s)):\n${result.errors.join("\n")}`,
    );
  }
  console.log(
    `item-art validation passed (${result.records.size} ${ART_CONFIG.expectedWidth}x${ART_CONFIG.expectedHeight} WebP assets)`,
  );
}

async function commandApply({ presentOnly = false } = {}) {
  const plan = await loadArtPlan();
  const validation = await validateGeneratedAssets(plan, { presentOnly });
  if (validation.errors.length > 0) {
    throw new Error(
      `Refusing to apply item art until validation passes:\n${validation.errors.join("\n")}`,
    );
  }

  const packItems = await loadPackItems();
  const assignmentByItem = new Map(
    (plan.assignments ?? []).map((assignment) => [
      assignment.itemId,
      assignment,
    ]),
  );
  const validPaths = new Set(validation.records.keys());
  const errors = [];
  let imageUpdates = 0;
  let metadataUpdates = 0;
  let restoredExisting = 0;
  let appliedMissing = 0;

  for (const item of packItems) {
    const existingArt = existingCompendiumArtPath(item);
    const absenceReason = artworkAbsenceReason(item);
    const assignment = assignmentByItem.get(item._id);

    if (!absenceReason) {
      if (assignment) {
        errors.push(
          `${item._id} ${item.name ?? ""}: plan tries to replace existing artwork ${existingArt}`,
        );
        continue;
      }
      if (markArtRestored(item)) metadataUpdates += 1;
      if (existingArt && item.img !== existingArt) {
        item.img = existingArt;
        imageUpdates += 1;
        restoredExisting += 1;
      }
      continue;
    }

    if (!assignment) {
      errors.push(
        `${item._id ?? "(missing)"} ${item.name ?? ""}: no art assignment for absent artwork (${absenceReason})`,
      );
      continue;
    }
    const appliedPath = toFoundryItemArtPath(assignment.path);
    if (!validPaths.has(assignment.path)) {
      if (presentOnly) {
        if (existingArt && item.img !== existingArt) {
          item.img = existingArt;
          imageUpdates += 1;
          restoredExisting += 1;
        }
        if (markArtAssignment(item, assignment, false)) metadataUpdates += 1;
        continue;
      }
      errors.push(
        `${item._id} ${item.name ?? ""}: planned asset did not validate (${assignment.path})`,
      );
      continue;
    }
    if (markArtGenerated(item, assignment)) metadataUpdates += 1;
    if (item.img !== appliedPath) {
      item.img = appliedPath;
      imageUpdates += 1;
      appliedMissing += 1;
    }
  }

  if (errors.length > 0) {
    throw new Error(`Cannot apply item art:\n${errors.join("\n")}`);
  }

  if (imageUpdates === 0 && metadataUpdates === 0) {
    console.log("item-art apply: pack already matches the absent-art policy");
    return;
  }

  const body = packItems.map((item) => JSON.stringify(item)).join("\n");
  await writeFile(PACK_PATH, `${body}\n`, "utf8");
  console.log(
    `item-art apply: updated ${imageUpdates} image path(s), ${metadataUpdates} art metadata record(s), restored ${restoredExisting} existing icon(s), applied ${appliedMissing} absent-art icon(s)`,
  );
}

async function commandRestore() {
  const packItems = await loadPackItems();
  let imageUpdates = 0;
  let metadataUpdates = 0;
  const unresolved = [];

  for (const item of packItems) {
    const existingArt = existingCompendiumArtPath(item);
    if (!existingArt) {
      unresolved.push(`${item._id ?? "(missing)"} ${item.name ?? ""}`);
      continue;
    }
    if (item.img !== existingArt) {
      item.img = existingArt;
      imageUpdates += 1;
    }
    if (markArtRestored(item)) metadataUpdates += 1;
  }

  if (unresolved.length > 0) {
    throw new Error(
      `Cannot restore ${unresolved.length} item(s) without a source icon:\n${unresolved.join("\n")}`,
    );
  }

  if (imageUpdates > 0 || metadataUpdates > 0) {
    const body = packItems.map((item) => JSON.stringify(item)).join("\n");
    await writeFile(PACK_PATH, `${body}\n`, "utf8");
  }

  console.log(
    `item-art restore: restored ${imageUpdates} image path(s), ${metadataUpdates} art metadata record(s)`,
  );
}

async function commandAbsent() {
  const packItems = await loadPackItems();
  const absent = packItems
    .map((item) => ({
      id: item._id,
      name: item.name,
      type: item.type,
      img: existingCompendiumArtPath(item),
      reason: artworkAbsenceReason(item),
    }))
    .filter((entry) => entry.reason);

  if (absent.length === 0) {
    console.log("No compendium items are missing source artwork.");
    return;
  }

  for (const item of absent) {
    console.log(
      `${item.id}\t${item.name}\t${item.type ?? ""}\t${item.reason}`,
    );
  }
}

function markArtGenerated(item, assignment) {
  return markArtAssignment(item, assignment, true);
}

function markArtAssignment(item, assignment, generated) {
  let updated = false;
  for (const scope of ["infinity-dnd5e", "party-operations"]) {
    const flags = item.flags?.[scope];
    if (!flags?.art) continue;
    if (flags.art.generated !== generated) {
      flags.art.generated = generated;
      updated = true;
    }
    if (flags.art.assetId !== assignment.assetId) {
      flags.art.assetId = assignment.assetId;
      updated = true;
    }
    if (flags.art.plannedPath !== assignment.path) {
      flags.art.plannedPath = assignment.path;
      updated = true;
    }
  }
  return updated;
}

function markArtRestored(item) {
  let updated = false;
  for (const scope of ["infinity-dnd5e", "party-operations"]) {
    const flags = item.flags?.[scope];
    if (!flags?.art) continue;
    if (flags.art.generated !== false) {
      flags.art.generated = false;
      updated = true;
    }
  }
  return updated;
}

async function main() {
  const [command, ...args] = process.argv.slice(2);
  const flags = new Set(args);
  if (command === "jobs") {
    await commandJobs({ missingOnly: flags.has("--missing-only") });
    return;
  }
  if (command === "validate") {
    await commandValidate();
    return;
  }
  if (command === "apply") {
    await commandApply({ presentOnly: flags.has("--present-only") });
    return;
  }
  if (command === "restore") {
    await commandRestore();
    return;
  }
  if (command === "absent") {
    await commandAbsent();
    return;
  }
  if (command === "check") {
    await commandJobs();
    await commandValidate();
    return;
  }

  console.error(
    "Usage: node scripts/art-pipeline.mjs <jobs|validate|apply|restore|absent|check> [--missing-only] [--present-only]",
  );
  process.exitCode = 1;
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error?.stack ?? error?.message ?? String(error));
    process.exitCode = 1;
  });
}
