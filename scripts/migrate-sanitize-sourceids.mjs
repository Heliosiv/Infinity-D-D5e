#!/usr/bin/env node
/**
 * One-off pack migration: sanitize leaked/broken `flags.core.sourceId`.
 *
 * The curated pack shipped item sourceIds pointing at compendia/worlds that
 * are NOT part of the public module:
 *   - Compendium.party-operations.*  (the legacy module's pack — absent here)
 *   - Compendium.world.*             (the author's PRIVATE world — an ID leak)
 *   - Actor.* / bare Item.*          (private actor/item references)
 * These render as broken "update from source" links in Foundry and leak the
 * author's private world/actor identifiers into a public release.
 *
 * We REWRITE (not delete) each offending sourceId to a stable self-reference
 * (Compendium.infinity-dnd5e.infinity-dnd5e-items.Item.<_id>). Rewriting keeps
 * the art-variants `flags.core.sourceId` fallback (art-variants.js) working,
 * fixes the broken links, and removes the private-ID leak. Public/valid
 * sources (e.g. Compendium.dnd5e.*) are left untouched.
 *
 * Run once: `node scripts/migrate-sanitize-sourceids.mjs`
 * (Re-running is a no-op — guarded by the same predicate.)
 */

import { readFileSync, writeFileSync } from "node:fs";

const PACK_PATH = "packs/infinity-dnd5e-items.db";
const SELF_PACK = "Compendium.infinity-dnd5e.infinity-dnd5e-items.Item";

/** A sourceId that leaks a private/absent source we must not ship. */
function isLeakedSourceId(sourceId) {
  if (typeof sourceId !== "string" || !sourceId) return false;
  return (
    sourceId.startsWith("Compendium.party-operations.") ||
    sourceId.startsWith("Compendium.world.") ||
    sourceId.startsWith("Actor.") ||
    sourceId.startsWith("Item.")
  );
}

const text = readFileSync(PACK_PATH, "utf8");
const lines = text.split(/\r?\n/);

let rewritten = 0;
const out = lines.map((line) => {
  const trimmed = line.trim();
  if (!trimmed) return line;
  let item;
  try {
    item = JSON.parse(trimmed);
  } catch {
    return line; // leave unparseable lines to test-pack-shape
  }
  // Recurse the whole document: a leaked sourceId may sit at the item's
  // flags.core.sourceId OR nested inside an embedded effect/activity.
  const selfRef = `${SELF_PACK}.${item._id}`;
  let changed = false;
  const visit = (node) => {
    if (!node || typeof node !== "object") return;
    if (Array.isArray(node)) {
      for (const entry of node) visit(entry);
      return;
    }
    if (isLeakedSourceId(node.sourceId)) {
      node.sourceId = selfRef;
      changed = true;
    }
    for (const value of Object.values(node)) visit(value);
  };
  visit(item);
  if (changed) {
    rewritten += 1;
    return JSON.stringify(item);
  }
  return line;
});

writeFileSync(PACK_PATH, out.join("\n"), "utf8");
console.log(
  `sourceId sanitize: rewrote ${rewritten} leaked sourceId(s) to self-references.`,
);
