#!/usr/bin/env node
/**
 * Inspect the built Foundry release artifact independently of its staging tree.
 *
 * This verifier is intentionally usable both from build-release.mjs and as a
 * standalone CI/release gate. It validates the source/package versions, the
 * actual ZIP layout and manifest references, and the published SHA-256 file.
 * A tag build may additionally require an exact `v<version>` tag at HEAD.
 */

import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

import AdmZip from "adm-zip";

const scriptPath = fileURLToPath(import.meta.url);
const defaultRepoRoot = path.resolve(path.dirname(scriptPath), "..");
const SHA256_PATTERN = /^[a-f0-9]{64}$/;

async function readJson(filePath, label) {
  let text;
  try {
    text = await readFile(filePath, "utf8");
  } catch (error) {
    throw new Error(`${label} is unavailable: ${filePath}`, { cause: error });
  }
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new Error(`${label} is not valid JSON: ${filePath}`, {
      cause: error,
    });
  }
}

function cleanVersion(value, label) {
  const version = String(value ?? "").trim();
  if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version)) {
    throw new Error(`${label} is not a supported semantic version: ${version}`);
  }
  return version;
}

function cleanTag(value) {
  const tag = String(value ?? "").trim();
  if (!tag) return "";
  if (!/^v\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(tag)) {
    throw new Error(`Release tag is not an exact v-prefixed version: ${tag}`);
  }
  return tag;
}

function cleanRepository(value) {
  const repository = String(value ?? "").trim();
  if (!repository) return "";
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository)) {
    throw new Error(`Repository must be owner/name: ${repository}`);
  }
  return repository;
}

function verifyTagAtHead(repoRoot, tag) {
  if (!tag) return;
  const tagCommit = spawnSync(
    "git",
    ["rev-parse", "--verify", `${tag}^{commit}`],
    { cwd: repoRoot, encoding: "utf8" },
  );
  if (tagCommit.status !== 0) {
    throw new Error(`Release tag does not resolve to a commit: ${tag}`);
  }
  const head = spawnSync("git", ["rev-parse", "HEAD"], {
    cwd: repoRoot,
    encoding: "utf8",
  });
  if (head.status !== 0 || head.stdout.trim() !== tagCommit.stdout.trim()) {
    throw new Error(
      `Release tag ${tag} does not point at the checked-out HEAD`,
    );
  }
}

function validateArchivePath(entryName) {
  const name = String(entryName ?? "");
  if (!name || name.startsWith("/") || name.includes("\\")) {
    throw new Error(`ZIP contains a non-portable path: ${name || "<empty>"}`);
  }
  const segments = name.split("/").filter(Boolean);
  if (segments.some((segment) => segment === "." || segment === "..")) {
    throw new Error(`ZIP contains an unsafe relative path: ${name}`);
  }
}

function validateManifestReference(relativePath, label) {
  const value = String(relativePath ?? "").trim();
  if (!value) throw new Error(`${label} contains a blank path`);
  validateArchivePath(value);
  if (value.endsWith("/")) {
    throw new Error(`${label} must reference a file or pack path: ${value}`);
  }
  return value;
}

function parseChecksum(text) {
  const value = String(text ?? "").trim();
  const match = /^([a-f0-9]{64})(?:\s+\*?module\.zip)?$/.exec(value);
  if (!match || !SHA256_PATTERN.test(match[1])) {
    throw new Error(
      "release/module.zip.sha256.txt must contain the module.zip SHA-256",
    );
  }
  return match[1];
}

function archiveManifest(zip, entryNames) {
  if (!entryNames.has("module.json")) {
    throw new Error("module.zip is missing module.json at the ZIP root");
  }
  const wrappedManifest = [...entryNames].find(
    (name) => name !== "module.json" && name.endsWith("/module.json"),
  );
  if (wrappedManifest) {
    throw new Error(
      `module.zip contains a wrapped duplicate manifest: ${wrappedManifest}`,
    );
  }
  let manifest;
  try {
    manifest = JSON.parse(zip.readAsText("module.json"));
  } catch (error) {
    throw new Error("ZIP-root module.json is not valid JSON", { cause: error });
  }
  return manifest;
}

function verifyManifestReferences(manifest, entryNames) {
  for (const [label, references] of [
    ["esmodules", manifest.esmodules],
    ["styles", manifest.styles],
    ["templates", manifest.templates],
  ]) {
    if (!Array.isArray(references)) {
      throw new Error(`Packaged manifest ${label} must be an array`);
    }
    for (const rawPath of references) {
      const relativePath = validateManifestReference(rawPath, label);
      if (!entryNames.has(relativePath)) {
        throw new Error(
          `Packaged manifest ${label} reference is missing: ${relativePath}`,
        );
      }
    }
  }

  for (const pack of manifest.packs ?? []) {
    const relativePath = validateManifestReference(pack?.path, "packs");
    const prefix = `${relativePath}/`;
    const hasPackContent = [...entryNames].some((name) =>
      name.startsWith(prefix),
    );
    if (!hasPackContent) {
      throw new Error(`Packaged manifest pack is missing: ${relativePath}`);
    }
    if (!entryNames.has(`${prefix}CURRENT`)) {
      throw new Error(
        `Packaged LevelDB pack has no CURRENT file: ${relativePath}`,
      );
    }
  }
}

function validateSafeReleaseUrl(value, label) {
  const raw = String(value ?? "").trim();
  if (!raw) throw new Error(`Packaged manifest ${label} URL is blank`);
  if (/\{version\}|%7bversion%7d/i.test(raw)) {
    throw new Error(
      `Packaged manifest ${label} URL contains an unresolved {version} placeholder`,
    );
  }

  let parsed;
  try {
    parsed = new URL(raw);
  } catch (error) {
    throw new Error(
      `Packaged manifest ${label} URL must be an absolute http(s) URL: ${raw}`,
      { cause: error },
    );
  }
  if (!["http:", "https:"].includes(parsed.protocol)) {
    throw new Error(
      `Packaged manifest ${label} URL must use http or https: ${raw}`,
    );
  }
  if (parsed.username || parsed.password) {
    throw new Error(
      `Packaged manifest ${label} URL must not contain credentials: ${raw}`,
    );
  }
  return raw;
}

export function verifyReleaseUrls(manifest, { repository, version }) {
  const expectedTag = `v${version}`;
  const url = validateSafeReleaseUrl(manifest.url, "homepage");
  const manifestUrl = validateSafeReleaseUrl(
    manifest.manifest,
    "updater manifest",
  );
  const download = validateSafeReleaseUrl(manifest.download, "download");
  if (repository) {
    const expectedBase = `https://github.com/${repository}`;
    if (url !== expectedBase) {
      throw new Error(`Packaged homepage URL must be ${expectedBase}`);
    }
    if (
      manifestUrl !== `${expectedBase}/releases/latest/download/module.json`
    ) {
      throw new Error(
        "Packaged updater manifest URL targets another repository",
      );
    }
    if (
      download !== `${expectedBase}/releases/download/${expectedTag}/module.zip`
    ) {
      throw new Error(
        "Packaged download URL targets another repository or tag",
      );
    }
  }
}

function verifyManifestMatchesSource(sourceManifest, packagedManifest) {
  const expectedManifest = {
    ...sourceManifest,
    url: packagedManifest.url,
    manifest: packagedManifest.manifest,
    download: packagedManifest.download,
  };
  if (JSON.stringify(packagedManifest) !== JSON.stringify(expectedManifest)) {
    throw new Error(
      "Packaged module.json differs from source beyond release URL injection",
    );
  }
}

/**
 * Verify release/module.zip and its sidecars.
 *
 * @param {object} options
 * @param {string} [options.repoRoot]
 * @param {string} [options.tag] Exact `v<version>` tag required at HEAD.
 * @param {string} [options.repository] Expected GitHub owner/name.
 */
export async function verifyReleaseArtifact({
  repoRoot = defaultRepoRoot,
  tag = "",
  repository = "",
} = {}) {
  const resolvedRoot = path.resolve(repoRoot);
  const expectedTag = cleanTag(tag);
  const expectedRepository = cleanRepository(repository);
  const releaseDir = path.join(resolvedRoot, "release");
  const zipPath = path.join(releaseDir, "module.zip");
  const checksumPath = `${zipPath}.sha256.txt`;

  const [sourceManifest, packageJson, packageLock, sidecarManifest, zipBytes] =
    await Promise.all([
      readJson(path.join(resolvedRoot, "module.json"), "source module.json"),
      readJson(path.join(resolvedRoot, "package.json"), "package.json"),
      readJson(
        path.join(resolvedRoot, "package-lock.json"),
        "package-lock.json",
      ),
      readJson(path.join(releaseDir, "module.json"), "release module.json"),
      readFile(zipPath),
    ]);

  const version = cleanVersion(sourceManifest.version, "module.json version");
  if (cleanVersion(packageJson.version, "package.json version") !== version) {
    throw new Error("package.json and module.json versions do not match");
  }
  if (
    cleanVersion(packageLock.version, "package-lock.json version") !== version
  ) {
    throw new Error("package-lock.json and module.json versions do not match");
  }
  if (
    cleanVersion(
      packageLock.packages?.[""]?.version,
      "package-lock root version",
    ) !== version
  ) {
    throw new Error("package-lock root and module.json versions do not match");
  }
  if (expectedTag && expectedTag !== `v${version}`) {
    throw new Error(
      `Release tag ${expectedTag} does not match source version v${version}`,
    );
  }
  verifyTagAtHead(resolvedRoot, expectedTag);

  const expectedSha = parseChecksum(await readFile(checksumPath, "utf8"));
  const actualSha = createHash("sha256").update(zipBytes).digest("hex");
  if (actualSha !== expectedSha) {
    throw new Error(
      `module.zip SHA-256 mismatch: expected ${expectedSha}, got ${actualSha}`,
    );
  }

  const zip = new AdmZip(zipBytes);
  const entries = zip.getEntries();
  const entryNames = new Set();
  for (const entry of entries) {
    validateArchivePath(entry.entryName);
    if (entryNames.has(entry.entryName)) {
      throw new Error(`ZIP contains a duplicate entry: ${entry.entryName}`);
    }
    entryNames.add(entry.entryName);
    const lowerName = entry.entryName.toLowerCase();
    if (
      lowerName.endsWith(".mjs") ||
      lowerName.includes("/test-utils/") ||
      (lowerName.startsWith("packs/") && lowerName.endsWith(".db")) ||
      (lowerName.startsWith("packs/") && lowerName.endsWith("/lock"))
    ) {
      throw new Error(
        `ZIP contains a source-only or transient file: ${entry.entryName}`,
      );
    }
  }

  const packagedManifest = archiveManifest(zip, entryNames);
  if (packagedManifest.id !== sourceManifest.id) {
    throw new Error(
      "Packaged manifest module id differs from source module.json",
    );
  }
  if (cleanVersion(packagedManifest.version, "packaged version") !== version) {
    throw new Error(
      "Packaged manifest version differs from source module.json",
    );
  }
  verifyManifestMatchesSource(sourceManifest, packagedManifest);
  if (JSON.stringify(packagedManifest) !== JSON.stringify(sidecarManifest)) {
    throw new Error(
      "release/module.json does not exactly match module.json inside module.zip",
    );
  }
  verifyManifestReferences(packagedManifest, entryNames);
  verifyReleaseUrls(packagedManifest, {
    repository: expectedRepository,
    version,
  });

  const summary = {
    version,
    tag: expectedTag || null,
    sha256: actualSha,
    entries: entries.length,
  };
  console.log(
    `Verified release artifact v${version}: ${entries.length} ZIP entries, SHA-256 ${actualSha}`,
  );
  return summary;
}

function parseArguments(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    const [rawKey, inlineValue] = argument.split("=", 2);
    const key = rawKey.replace(/^--/, "");
    if (!["tag", "repository", "repo-root"].includes(key)) {
      throw new Error(`Unknown argument: ${argument}`);
    }
    const value = inlineValue ?? argv[++index];
    if (!value) throw new Error(`Missing value for --${key}`);
    if (key === "repo-root") options.repoRoot = value;
    else options[key] = value;
  }
  return options;
}

if (path.resolve(process.argv[1] ?? "") === scriptPath) {
  verifyReleaseArtifact(parseArguments(process.argv.slice(2))).catch(
    (error) => {
      console.error(error?.stack ?? error?.message ?? String(error));
      process.exitCode = 1;
    },
  );
}
