/**
 * Direct tests for the art-treasure pure functions in loot/art-variants.js.
 *
 * The roller tests exercise this machinery indirectly (rolling with
 * artVariants:true), but the four exported functions each have edge cases
 * that deserve isolated coverage:
 *  - getVariableTreasureKind reads three flag namespaces,
 *  - isVariableArtItem gates on isVariableTreasureBase so magic consumables
 *    that carry a stray `variableTreasureKind:art` are NOT renamed,
 *  - createArtVariant / createArtVariantItemData own the field mapping and
 *    the sellValueGp halving that a silent drift could corrupt,
 *  - inferArtCategory has four regex branches; a keyword typo would quietly
 *    pick the wrong appraisal detail table.
 */

import assert from "node:assert/strict";

import {
  createArtVariant,
  createArtVariantItemData,
  getVariableTreasureKind,
  isVariableArtItem,
} from "./loot/art-variants.js";
import { seqRng } from "./test-utils/rng.mjs";

/* A seeded rng that always returns the first entry of every pick() table, so
 * the chosen condition / provenance / detail / market are deterministic. */
const firstRng = seqRng([0]);

/* ------------------------------------------------------------------ *
 * getVariableTreasureKind — three namespaces + empty fallback
 * ------------------------------------------------------------------ */
{
  assert.equal(
    getVariableTreasureKind({
      flags: { "infinity-dnd5e": { variableTreasureKind: "Art" } },
    }),
    "art",
    "reads the native namespace (and lowercases)",
  );
  assert.equal(
    getVariableTreasureKind({
      flags: { "party-operations": { variableTreasureKind: "gem" } },
    }),
    "gem",
    "reads the legacy party-operations namespace",
  );
  assert.equal(
    getVariableTreasureKind({ variableTreasureKind: "art" }),
    "art",
    "reads a direct top-level property",
  );
  assert.equal(getVariableTreasureKind({}), "", "missing → empty string");
}

/* ------------------------------------------------------------------ *
 * isVariableArtItem — the isVariableTreasureBase gate
 * ------------------------------------------------------------------ */
{
  // A magic consumable (type != "loot") carrying a stray art flag must be
  // rejected by the isVariableTreasureBase gate before the art keyword check.
  assert.equal(
    isVariableArtItem({
      type: "consumable",
      flags: { "infinity-dnd5e": { variableTreasureKind: "art" } },
    }),
    false,
    "a magic consumable is not a variable art base",
  );

  // A loot item with the treasure.art keyword passes.
  assert.equal(
    isVariableArtItem({
      type: "loot",
      flags: { "infinity-dnd5e": { keywords: ["treasure.art"] } },
    }),
    true,
    "a loot item tagged treasure.art is a variable art base",
  );

  // A loot item whose folder path resolves to art-objects also passes.
  assert.equal(
    isVariableArtItem({
      type: "loot",
      flags: {
        "infinity-dnd5e": {
          keywords: ["treasure.art", "folder.path.art-objects"],
        },
      },
    }),
    true,
    "a loot item under art-objects is a variable art base",
  );
}

/* ------------------------------------------------------------------ *
 * createArtVariant — shape of a generated variant
 * ------------------------------------------------------------------ */
{
  const item = {
    name: "Silver Goblet",
    type: "loot",
    flags: { "infinity-dnd5e": { gpValue: 250 } },
  };
  const variant = createArtVariant(item, { rng: firstRng });

  assert.equal(variant.kind, "art", "kind is 'art'");
  assert.ok(
    variant.displayName.includes("Silver Goblet"),
    "displayName carries the base name",
  );
  assert.equal(variant.gpValue, 250, "gpValue equals the base item gp value");
  assert.ok(
    typeof variant.summary === "string" && variant.summary.length > 0,
    "summary is a non-empty string",
  );
  assert.ok(
    variant.summary.includes(";"),
    "summary is the semicolon-joined appraisal facets",
  );
  assert.ok(
    typeof variant.id === "string" && variant.id.startsWith("art-"),
    "id is an 'art-' prefixed slug",
  );
}

/* ------------------------------------------------------------------ *
 * createArtVariantItemData — Foundry item-data field mapping
 * ------------------------------------------------------------------ */
{
  const item = {
    name: "Silver Goblet",
    type: "loot",
    img: "icons/svg/chest.svg",
    system: { price: { value: 250, denomination: "gp" }, description: {} },
    flags: { "infinity-dnd5e": { gpValue: 250 } },
  };
  const variant = createArtVariant(item, { rng: seqRng([0]) });
  const data = createArtVariantItemData(item, variant, { quantity: 3 });

  assert.equal(data.name, variant.displayName, "name = variant displayName");
  assert.equal(
    data.system.price.value,
    variant.gpValue,
    "price.value = variant gpValue",
  );
  assert.equal(data.system.quantity, 3, "quantity comes from the arg");

  const native = data.flags["infinity-dnd5e"];
  assert.equal(
    native.generatedTreasure.variantId,
    variant.id,
    "generatedTreasure.variantId = variant id",
  );
  assert.equal(
    native.sellValueGp,
    Math.floor(variant.gpValue / 2),
    "sellValueGp is half the gp value, floored",
  );
  assert.ok(
    data.system.description.value.includes("Generated appraisal"),
    "the description gains the generated appraisal block",
  );
}

/* ------------------------------------------------------------------ *
 * inferArtCategory — exercised via the picked detail table
 *
 * With a first-entry rng the detail.id is the first row of the inferred
 * category's table, so the detail id uniquely identifies which branch fired.
 * ------------------------------------------------------------------ */
{
  const variantFor = (item) => createArtVariant(item, { rng: seqRng([0]) });

  // wall-art → first detail "gilt-frame"
  assert.equal(
    variantFor({ name: "Court Tapestry", type: "loot", flags: {} }).detail.id,
    "gilt-frame",
    "'Tapestry' infers the wall-art category",
  );
  // sculpture → first detail "fine-carving"
  assert.equal(
    variantFor({ name: "Jade Statue", type: "loot", flags: {} }).detail.id,
    "fine-carving",
    "'Statue' infers the sculpture category",
  );
  // jewelry → first detail "matched-stones"
  assert.equal(
    variantFor({
      name: "Trinket",
      type: "loot",
      flags: {
        "infinity-dnd5e": { keywords: ["folder.path.sundries.jewelry"] },
      },
    }).detail.id,
    "matched-stones",
    "a jewelry folder keyword infers the jewelry category",
  );
  // fallback → decorative, first detail "delicate-metalwork"
  assert.equal(
    variantFor({ name: "Odd Curio", type: "loot", flags: {} }).detail.id,
    "delicate-metalwork",
    "an unmatched name falls back to the decorative category",
  );
}

process.stdout.write("art-variants validation passed\n");
