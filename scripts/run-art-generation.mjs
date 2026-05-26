#!/usr/bin/env node
/**
 * Invoke the installed image generation CLI with the module's fixed
 * full-art-batch settings.
 */

import { existsSync } from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import { ART_CONFIG, JOB_FILES } from "./art-pipeline.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..");
const imageCli = path.join(
  process.env.CODEX_HOME ?? path.join(process.env.USERPROFILE ?? "", ".codex"),
  "skills",
  ".system",
  "imagegen",
  "scripts",
  "image_gen.py",
);

const ASSET_ROOTS = Object.freeze({
  shared: path.join(repoRoot, "assets", "item-art", "shared"),
  unique: path.join(repoRoot, "assets", "item-art", "unique"),
});

function usage() {
  console.error(
    "Usage: node scripts/run-art-generation.mjs <shared|unique> [--dry-run] [--force]",
  );
}

const [kind, ...rawFlags] = process.argv.slice(2);
const flags = new Set(rawFlags);

if (!["shared", "unique"].includes(kind)) {
  usage();
  process.exit(1);
}

if (!existsSync(imageCli)) {
  console.error(`Image generation CLI not found: ${imageCli}`);
  process.exit(1);
}

if (!existsSync(JOB_FILES[kind])) {
  console.error(
    `Missing ${kind} job file: ${JOB_FILES[kind]}. Run npm run art:jobs first.`,
  );
  process.exit(1);
}

const args = [
  imageCli,
  "generate-batch",
  "--input",
  JOB_FILES[kind],
  "--out-dir",
  ASSET_ROOTS[kind],
  "--model",
  ART_CONFIG.model,
  "--quality",
  ART_CONFIG.quality,
  "--size",
  ART_CONFIG.size,
  "--output-format",
  ART_CONFIG.outputFormat,
  "--background",
  ART_CONFIG.background,
  "--concurrency",
  "5",
  "--max-attempts",
  "3",
  "--no-augment",
];

if (flags.has("--dry-run")) args.push("--dry-run");
if (flags.has("--force")) args.push("--force");

const result = spawnSync("python", args, {
  cwd: repoRoot,
  stdio: "inherit",
  shell: false,
});

if (result.error) {
  console.error(result.error.stack ?? result.error.message);
  process.exit(1);
}

process.exit(result.status ?? 1);
