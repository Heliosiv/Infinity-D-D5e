#!/usr/bin/env node
/**
 * Infinity D&D5e — pack flag-namespace migration.
 *
 * The curated pack was inherited from the predecessor module
 * "party-operations" and its loot-engine metadata (tier, rarity,
 * lootType, gpValue, lootWeight, keywords, …) still lived under
 * `flags["party-operations"]`. This moves that subtree to the module's
 * own `flags["infinity-dnd5e"]` namespace and drops the legacy block,
 * so the shipped pack is tagged under our own id.
 *
 * Scope is deliberately narrow: ONLY `flags["party-operations"]` is
 * touched. `flags.core`, `flags["midi-qol"]`, `flags.dae`,
 * `flags.midiProperties` etc. belong to other modules and are left
 * exactly as-is. Item `_id`s are preserved, so every UUID reference
 * (art plans, spell-scroll source links, distributed items) stays valid.
 *
 * Idempotent: re-running on an already-migrated pack is a no-op.
 *
 * Operates on the editable NeDB source `packs/infinity-dnd5e-items.db`
 * in place (run `npm run compile:packs` afterward to rebuild LevelDB).
 *
 * Run: `node scripts/migrate-pack-namespace.mjs`
 */

import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..");

const LEGACY_NS = "party-operations";
const NATIVE_NS = "infinity-dnd5e";
const PACK_PATH = path.join(repoRoot, "packs", "infinity-dnd5e-items.db");

async function main() {
  const text = await readFile(PACK_PATH, "utf8");
  const lines = text.split(/\r?\n/);

  let migrated = 0;
  let alreadyClean = 0;
  const out = [];

  for (const line of lines) {
    if (!line.trim()) continue;
    const doc = JSON.parse(line);
    const flags = doc.flags;

    if (flags && Object.prototype.hasOwnProperty.call(flags, LEGACY_NS)) {
      const legacy = flags[LEGACY_NS] ?? {};
      const native = flags[NATIVE_NS] ?? {};
      // Native values win on the (identical) `art` collision and keep
      // canonical authority; every loot key only exists on the legacy
      // side, so it carries over cleanly.
      flags[NATIVE_NS] = { ...legacy, ...native };
      delete flags[LEGACY_NS];
      migrated += 1;
    } else {
      alreadyClean += 1;
    }

    // Compact JSON, one document per line — matches the NeDB format.
    out.push(JSON.stringify(doc));
  }

  // LF line endings + trailing newline, matching the source file.
  await writeFile(PACK_PATH, `${out.join("\n")}\n`, "utf8");

  console.log(
    `Namespace migration: ${migrated} item(s) moved ${LEGACY_NS} → ` +
      `${NATIVE_NS}, ${alreadyClean} already clean (${out.length} total).`,
  );
}

main().catch((error) => {
  console.error(error?.stack ?? error?.message ?? String(error));
  process.exitCode = 1;
});
