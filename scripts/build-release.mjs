#!/usr/bin/env node
/**
 * Infinity D&D5e — local release builder.
 *
 * Stages everything Foundry / Forge needs and zips it. The output is
 * `release/module.zip` with module.json at the zip root (NOT wrapped
 * in a parent folder) so Foundry's "Install Module" / Forge upload
 * accepts it as-is.
 *
 * Pure node — compiles the compendium packs (NeDB → LevelDB), stages
 * the runtime files, and zips with adm-zip (forward-slash entries on
 * every platform, unlike PowerShell's Compress-Archive).
 *
 * Run: `npm run release` (or `node scripts/build-release.mjs`).
 */

import { createHash } from "node:crypto";
import {
  cp,
  mkdir,
  readFile,
  readdir,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

import AdmZip from "adm-zip";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..");
const releaseDir = path.join(repoRoot, "release");
const stagingDir = path.join(releaseDir, "staging");
const zipPath = path.join(releaseDir, "module.zip");
const shaPath = `${zipPath}.sha256.txt`;
const manifestStagedPath = path.join(releaseDir, "module.json");
const notesPath = path.join(releaseDir, "RELEASE_NOTES.md");
const readmePath = path.join(releaseDir, "README.md");

/* ------------------------------------------------------------------ *
 * Stage policy
 * ------------------------------------------------------------------ */

/** Top-level files copied verbatim into the zip. */
const TOP_LEVEL_FILES = ["module.json"];

/**
 * Top-level directories copied recursively into the zip.
 * For `scripts/`, the filter below excludes `.mjs` (tests + this
 * build script itself) so only runtime code ships. The same filter
 * also drops test-utils.
 */
const TOP_LEVEL_DIRS = ["assets", "scripts", "styles", "templates", "packs"];

/**
 * Predicate that returns false when a file should NOT be staged.
 * Receives the *absolute* path of the candidate. The `cp` recursive
 * filter calls this for BOTH files and directories — returning false
 * for a directory short-circuits the recursion into it AND prevents
 * an empty directory entry from being staged.
 */
function shouldStage(sourcePath) {
  const ext = path.extname(sourcePath).toLowerCase();
  const normalized = sourcePath.split(path.sep).join("/");
  const base = path.basename(sourcePath).toLowerCase();

  // Skip test-utils entirely (both the directory and anything inside).
  if (base === "test-utils") return false;
  if (normalized.includes("/scripts/test-utils/")) return false;

  // Drop node test scripts and the build script itself.
  if (ext === ".mjs") return false;

  // Drop the NeDB source pack (and its nedb backup temp) — the `.db` is
  // the editable source, compiled into a LevelDB directory that ships in
  // its place. (Guarded to packs/ so we never match an unrelated file.)
  if (
    normalized.includes("/packs/") &&
    (base.endsWith(".db") || base.endsWith(".db~"))
  ) {
    return false;
  }

  // Drop the LevelDB runtime lock if one is lingering — Foundry creates
  // its own on load; shipping a stale LOCK is at best noise.
  if (base === "lock" && normalized.includes("/packs/")) return false;

  // Drop OS junk / editor backups.
  if (base === ".ds_store" || base === "thumbs.db") return false;
  if (base.endsWith(".bak") || base.endsWith(".tmp") || base.endsWith(".log"))
    return false;
  if (ext === ".bak") return false;

  return true;
}

/* ------------------------------------------------------------------ *
 * Helpers
 * ------------------------------------------------------------------ */

async function pathExists(target) {
  try {
    await stat(target);
    return true;
  } catch {
    return false;
  }
}

async function readManifest() {
  const raw = await readFile(path.join(repoRoot, "module.json"), "utf8");
  return JSON.parse(raw);
}

/**
 * Mutates the published manifest's `url` / `manifest` / `download` fields
 * based on env vars. Source `module.json` is never modified; only the
 * staged + side-by-side copy gets the injection.
 *
 * Recognized env vars (all optional):
 *   INFINITY_RELEASE_REPO          - "owner/repo"; when set, derives all
 *                                    three URLs using GitHub Releases
 *                                    conventions (stable `manifest`,
 *                                    versioned `download`).
 *   INFINITY_RELEASE_URL           - overrides `url`.
 *   INFINITY_RELEASE_MANIFEST_URL  - overrides `manifest`.
 *   INFINITY_RELEASE_DOWNLOAD_URL  - overrides `download`. `{version}`
 *                                    placeholder is substituted.
 *
 * Per-field overrides win over the `REPO` shortcut. Returns the list of
 * fields actually touched so we can log them.
 */
function injectReleaseUrls(manifest) {
  const version = String(manifest?.version ?? "0.0.0");
  const repo = (process.env.INFINITY_RELEASE_REPO ?? "").trim();
  const explicit = {
    url: (process.env.INFINITY_RELEASE_URL ?? "").trim(),
    manifest: (process.env.INFINITY_RELEASE_MANIFEST_URL ?? "").trim(),
    download: (process.env.INFINITY_RELEASE_DOWNLOAD_URL ?? "").trim(),
  };

  let derived = { url: "", manifest: "", download: "" };
  if (repo) {
    if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo)) {
      throw new Error(
        `INFINITY_RELEASE_REPO must be "owner/repo" (got: ${repo})`,
      );
    }
    derived = {
      url: `https://github.com/${repo}`,
      manifest: `https://github.com/${repo}/releases/latest/download/module.json`,
      download: `https://github.com/${repo}/releases/download/v${version}/module.zip`,
    };
  }

  const final = {
    url: explicit.url || derived.url,
    manifest: explicit.manifest || derived.manifest,
    download: explicit.download || derived.download,
  };
  // Allow `{version}` substitution in explicit overrides.
  final.download = final.download.replace(/\{version\}/g, version);

  const touched = [];
  for (const key of ["url", "manifest", "download"]) {
    if (final[key] && manifest[key] !== final[key]) {
      manifest[key] = final[key];
      touched.push(key);
    }
  }
  return touched;
}

async function clean() {
  if (await pathExists(releaseDir)) {
    await rm(releaseDir, { recursive: true, force: true });
  }
  await mkdir(stagingDir, { recursive: true });
}

async function stageFiles() {
  for (const name of TOP_LEVEL_FILES) {
    const src = path.join(repoRoot, name);
    if (!(await pathExists(src))) continue;
    await cp(src, path.join(stagingDir, name));
  }

  for (const dir of TOP_LEVEL_DIRS) {
    const src = path.join(repoRoot, dir);
    if (!(await pathExists(src))) continue;
    await cp(src, path.join(stagingDir, dir), {
      recursive: true,
      filter(sourcePath) {
        // Always allow directories so we recurse into them; per-file
        // checks happen below.
        return shouldStage(sourcePath);
      },
    });
  }
}

/** Sanity check the staged tree before zipping. */
async function verifyStage(manifest) {
  const expectStyles = Array.isArray(manifest?.styles) ? manifest.styles : [];
  const expectTemplates = Array.isArray(manifest?.templates)
    ? manifest.templates
    : [];
  const expectModules = Array.isArray(manifest?.esmodules)
    ? manifest.esmodules
    : [];

  for (const relativePath of [
    ...expectStyles,
    ...expectTemplates,
    ...expectModules,
  ]) {
    const staged = path.join(stagingDir, relativePath);
    if (!(await pathExists(staged))) {
      throw new Error(
        `Manifest references missing path in staging: ${relativePath}`,
      );
    }
  }

  // Packs referenced in module.json must exist too. Foundry v11+ reads
  // LevelDB *directories*; a valid one always contains a CURRENT file,
  // so checking for it catches an empty or failed compile here rather
  // than as a silent empty compendium inside Foundry.
  for (const pack of manifest?.packs ?? []) {
    const relativePath = String(pack?.path ?? "").trim();
    if (!relativePath) continue;
    const staged = path.join(stagingDir, relativePath);
    if (!(await pathExists(staged))) {
      throw new Error(`Manifest pack missing in staging: ${relativePath}`);
    }
    const stagedStat = await stat(staged);
    if (stagedStat.isDirectory()) {
      if (!(await pathExists(path.join(staged, "CURRENT")))) {
        throw new Error(
          `Pack "${relativePath}" is not a valid LevelDB directory ` +
            `(no CURRENT file). Did the compile step run?`,
        );
      }
    }
  }
}

async function writeManifestCopy(manifest) {
  await writeFile(
    manifestStagedPath,
    `${JSON.stringify(manifest, null, 2)}\n`,
    "utf8",
  );
}

async function writeNotes(manifest) {
  const version = String(manifest?.version ?? "0.0.0");
  await writeFile(
    notesPath,
    [
      `# Infinity D&D5e — v${version}`,
      "",
      "Local build. See README.md for install instructions.",
      "",
    ].join("\n"),
    "utf8",
  );
  await writeFile(
    readmePath,
    [
      `# Infinity D&D5e — Release Artifact (v${manifest?.version ?? "0.0.0"})`,
      "",
      "## Install",
      "",
      "**Foundry VTT** — Setup → Add-on Modules → Install Module → click the manifest URL field,",
      "but instead use the file picker to upload `module.zip`. Foundry extracts it into",
      "`Data/modules/infinity-dnd5e/`.",
      "",
      "**Forge VTT** — Forge Configuration → My Foundry → Bazaar → upload `module.zip`. Forge",
      "unpacks it into your Foundry user data.",
      "",
      "**Manual** — extract `module.zip` directly into your Foundry `Data/modules/` directory",
      "so the resulting path is `Data/modules/infinity-dnd5e/module.json`.",
      "",
      "## Verify",
      "",
      "After installing, enable the module in your world. The dashboard has three entry points:",
      "",
      "- **d20 icon** in the left scene-controls column (next to Tokens / Walls / Lighting)",
      "- **d20 icon** in the Token Controls toolbar (fallback)",
      "- **Shift+I** from anywhere in the game",
      "",
      "All are GM-only. Click any of them and the dashboard opens.",
      "",
    ].join("\n"),
    "utf8",
  );
}

/**
 * Compile the NeDB source packs into their shipped LevelDB directories.
 * Runs the standalone compiler in its own process so the native
 * classic-level handle is fully torn down before we stage files.
 */
function compilePacks() {
  const script = path.join(here, "compile-packs.mjs");
  const result = spawnSync(process.execPath, [script], {
    cwd: repoRoot,
    stdio: "inherit",
  });
  if (result.status !== 0) {
    throw new Error(`Pack compile failed with exit code ${result.status ?? 1}`);
  }
}

function runZip() {
  // Use adm-zip rather than PowerShell's Compress-Archive: on Windows
  // PowerShell 5.1 writes zip entries with BACKSLASH separators, which
  // violate the ZIP spec. Linux-based extractors (Foundry's server,
  // Forge) then create literal files named "packs\infinity-dnd5e-items"
  // instead of a packs/ directory — so the module installs with broken
  // paths. adm-zip writes forward-slash entries on every platform, with
  // module.json at the zip root (no wrapping folder).
  const zip = new AdmZip();
  zip.addLocalFolder(stagingDir);
  zip.writeZip(zipPath);
}

async function writeSha() {
  const data = await readFile(zipPath);
  const sha = createHash("sha256").update(data).digest("hex");
  await writeFile(shaPath, `${sha}\n`, "utf8");
  return sha;
}

async function countStaged() {
  let files = 0;
  let totalBytes = 0;
  async function walk(dir) {
    const entries = await readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(full);
      } else if (entry.isFile()) {
        files += 1;
        const fileStat = await stat(full);
        totalBytes += fileStat.size;
      }
    }
  }
  await walk(stagingDir);
  return { files, totalBytes };
}

/* ------------------------------------------------------------------ *
 * Main
 * ------------------------------------------------------------------ */

async function main() {
  const manifest = await readManifest();
  if (!manifest?.version) throw new Error("module.json is missing a version");

  console.log(`Building release v${manifest.version}…`);

  console.log("Compiling compendium packs (NeDB → LevelDB)…");
  compilePacks();

  await clean();
  await stageFiles();
  await verifyStage(manifest);

  const injected = injectReleaseUrls(manifest);
  if (injected.length > 0) {
    console.log(`Injected release URLs: ${injected.join(", ")}`);
    // Re-stage the manifest so the zip carries the injected URLs.
    await writeFile(
      path.join(stagingDir, "module.json"),
      `${JSON.stringify(manifest, null, 2)}\n`,
      "utf8",
    );
  } else {
    console.log(
      "No release URL env vars set — module.json shipped without manifest/download URLs.",
    );
  }

  await writeManifestCopy(manifest);
  await writeNotes(manifest);
  const { files, totalBytes } = await countStaged();
  console.log(
    `Staged ${files} files (${(totalBytes / 1024 / 1024).toFixed(2)} MB)`,
  );

  runZip();
  const sha = await writeSha();
  const zipStat = await stat(zipPath);

  console.log("");
  console.log("Done.");
  console.log(`  zip      : ${path.relative(repoRoot, zipPath)}`);
  console.log(`  size     : ${(zipStat.size / 1024 / 1024).toFixed(2)} MB`);
  console.log(`  sha256   : ${sha}`);
  console.log(`  manifest : ${path.relative(repoRoot, manifestStagedPath)}`);
  console.log(`  notes    : ${path.relative(repoRoot, notesPath)}`);
  console.log("");
  console.log(
    "Upload module.zip to Foundry Setup → Install Module, or to Forge Bazaar.",
  );
}

main().catch((error) => {
  console.error(error?.stack ?? error?.message ?? String(error));
  process.exitCode = 1;
});
