#!/usr/bin/env node
/**
 * Infinity D&D5e — Compendium compiler.
 *
 * Foundry VTT v11+ reads compendium packs from LevelDB *directories*,
 * not the legacy NeDB single-file `.db` format. Shipping a `.db` relies
 * on Foundry's migrate-on-load path, which regressed on v12 (empty
 * databases — foundryvtt/foundryvtt#10681) and is fragile on Forge.
 * Every other module on a working install ships LevelDB directories;
 * this script makes ours match.
 *
 * The NeDB `.db` stays the editable source of truth (the dev/test
 * tooling reads it line-by-line). This script compiles it into the
 * shipped LevelDB directory module.json points at.
 *
 * Why we hand-roll the LevelDB write instead of using
 * @foundryvtt/foundryvtt-cli's `extractPack`/`compilePack`: the cli's
 * nedb extractor unconditionally also opens the source as a LevelDB
 * directory, which throws on a `.db` file under current classic-level /
 * Node, leaving an empty pack. Since a `.db` is just JSON-lines, we
 * parse it ourselves and write the on-disk format Foundry expects:
 *
 *   !items!<id>                      → the Item, with embedded `effects`
 *                                      replaced by an array of effect ids
 *   !items.effects!<id>.<effectId>   → each embedded ActiveEffect
 *
 * (Verified against the live dnd5e system pack.) The write path uses
 * only batch.put/batch.write — no streaming iterators — so it sidesteps
 * the classic-level deferred-iterator race seen on Node 24.
 *
 * Run: `npm run compile:packs`
 */

import { mkdir, readFile, rm, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { ClassicLevel } from "classic-level";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..");

/**
 * One entry per compendium. `nedb` is the editable source file, `out`
 * is the LevelDB directory module.json points at, `collection` is the
 * pack's primary key segment (`items` for an Item pack).
 */
const PACKS = [
  {
    name: "infinity-dnd5e-items",
    nedb: path.join(repoRoot, "packs", "infinity-dnd5e-items.db"),
    out: path.join(repoRoot, "packs", "infinity-dnd5e-items"),
    collection: "items",
  },
];

/** Foundry embedded-document collections, keyed by parent collection. */
const EMBEDDED = {
  items: ["effects"],
};

async function pathExists(target) {
  try {
    await stat(target);
    return true;
  } catch {
    return false;
  }
}

/** Parse a NeDB `.db` file: one JSON document per non-empty line. */
async function readNedbDocuments(dbPath) {
  const text = await readFile(dbPath, "utf8");
  const docs = [];
  let lineNo = 0;
  for (const line of text.split(/\r?\n/)) {
    lineNo += 1;
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      docs.push(JSON.parse(trimmed));
    } catch (error) {
      throw new Error(`Unparseable JSON on line ${lineNo}: ${error.message}`);
    }
  }
  return docs;
}

const ID_ALPHABET =
  "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";

/**
 * Deterministic 16-char Foundry-style id, derived from a seed so builds
 * are reproducible. Only used as a fallback when an embedded document is
 * missing its `_id` (curated pack documents normally carry one).
 */
function deterministicId(seed) {
  let hash = 2166136261;
  for (let i = 0; i < seed.length; i += 1) {
    hash ^= seed.charCodeAt(i);
    hash = Math.imul(hash, 16777619) >>> 0;
  }
  let id = "";
  for (let i = 0; i < 16; i += 1) {
    hash = Math.imul(hash ^ (hash >>> 13), 16777619) >>> 0;
    id += ID_ALPHABET[hash % ID_ALPHABET.length];
  }
  return id;
}

/**
 * Stage one primary document into the batch in Foundry pack format:
 * embedded collections are written as their own keys and replaced by an
 * id list on the parent. Returns the number of embedded docs written.
 */
function stageDocument(batch, collection, doc) {
  const id = doc._id;
  if (!id) throw new Error(`Document missing _id: ${doc.name ?? "(unnamed)"}`);

  let embeddedWritten = 0;
  const stored = { ...doc };

  for (const field of EMBEDDED[collection] ?? []) {
    const children = doc[field];
    if (!Array.isArray(children) || children.length === 0) continue;

    const ids = [];
    for (const [index, child] of children.entries()) {
      const childId =
        child._id || deterministicId(`${collection}.${field}.${id}.${index}`);
      const childWithId = child._id ? child : { ...child, _id: childId };
      batch.put(`!${collection}.${field}!${id}.${childId}`, childWithId);
      ids.push(childId);
      embeddedWritten += 1;
    }
    stored[field] = ids;
  }

  batch.put(`!${collection}!${id}`, stored);
  return embeddedWritten;
}

/** Read back the compiled pack and confirm the primary-document count. */
async function verifyPack(dir, collection, expectedPrimary) {
  const db = new ClassicLevel(dir, {
    keyEncoding: "utf8",
    valueEncoding: "json",
    createIfMissing: false,
  });
  try {
    await db.open();
    const keys = await db.keys().all();
    const prefix = `!${collection}!`;
    const primary = keys.filter((k) => k.startsWith(prefix)).length;
    if (primary !== expectedPrimary) {
      throw new Error(
        `verification failed — expected ${expectedPrimary} ` +
          `${collection}, found ${primary}`,
      );
    }
    return { total: keys.length, primary };
  } finally {
    await db.close();
  }
}

async function compileOne(pack) {
  if (!(await pathExists(pack.nedb))) {
    throw new Error(`Source pack not found: ${pack.nedb}`);
  }

  const docs = await readNedbDocuments(pack.nedb);

  await rm(pack.out, { recursive: true, force: true });
  await mkdir(pack.out, { recursive: true });

  const db = new ClassicLevel(pack.out, {
    keyEncoding: "utf8",
    valueEncoding: "json",
  });
  let embeddedTotal = 0;
  try {
    await db.open();
    const batch = db.batch();
    for (const doc of docs) {
      embeddedTotal += stageDocument(batch, pack.collection, doc);
    }
    await batch.write();
  } finally {
    await db.close();
  }

  const { total, primary } = await verifyPack(
    pack.out,
    pack.collection,
    docs.length,
  );

  console.log(
    `${pack.name}: ${primary} documents + ${embeddedTotal} embedded ` +
      `(${total} keys) → ${path.relative(repoRoot, pack.out)}`,
  );
  return { name: pack.name, primary, embedded: embeddedTotal };
}

async function main() {
  for (const pack of PACKS) {
    await compileOne(pack);
  }
  console.log("Pack compile complete.");
}

main().catch((error) => {
  console.error(error?.stack ?? error?.message ?? String(error));
  process.exitCode = 1;
});
