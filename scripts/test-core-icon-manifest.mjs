import assert from "node:assert/strict";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

const PACK_PATH = "packs/infinity-dnd5e-items.db";
const MANIFEST_PATH = "scripts/test-utils/foundry-13.351-core-icons.json";
const CORE_IMAGE_PATTERN = /^(?:icons|ui)\/.+\.(?:webp|svg|png|jpg|jpeg)$/i;

function collectCoreImagePaths(value, output = []) {
  if (typeof value === "string") {
    if (CORE_IMAGE_PATTERN.test(value)) output.push(value);
    return output;
  }
  if (!value || typeof value !== "object") return output;
  if (Array.isArray(value)) {
    for (const entry of value) collectCoreImagePaths(entry, output);
    return output;
  }
  for (const entry of Object.values(value)) {
    collectCoreImagePaths(entry, output);
  }
  return output;
}

const items = readFileSync(PACK_PATH, "utf8")
  .split(/\r?\n/)
  .filter(Boolean)
  .map(JSON.parse);
const references = items.flatMap((item) => collectCoreImagePaths(item));
const paths = [...new Set(references)].sort();

if (process.argv.includes("--refresh")) {
  const publicRoot = String(process.env.FOUNDRY_PUBLIC_ROOT ?? "").trim();
  assert.ok(publicRoot, "FOUNDRY_PUBLIC_ROOT is required with --refresh");
  const missing = paths.filter(
    (imagePath) => !existsSync(path.join(publicRoot, ...imagePath.split("/"))),
  );
  assert.deepEqual(
    missing,
    [],
    `Foundry 13.351 is missing referenced core images: ${missing.join(", ")}`,
  );
  writeFileSync(
    MANIFEST_PATH,
    `${JSON.stringify({ foundryVersion: "13.351", paths }, null, 2)}\n`,
    "utf8",
  );
}

const manifest = JSON.parse(readFileSync(MANIFEST_PATH, "utf8"));
assert.equal(manifest.foundryVersion, "13.351");
assert.deepEqual(
  manifest.paths,
  paths,
  "core image references changed; verify them against Foundry 13.351 and refresh the manifest",
);

process.stdout.write(
  `core icon manifest validation passed (${references.length} refs, ${paths.length} unique)\n`,
);
