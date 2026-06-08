/**
 * Merchant buy-filter classification + matching.
 *
 * Guards the two-path design of itemBuyCategories:
 *   - TAGGED compendium items are classified by their curated lootType alone.
 *   - UNtagged character-sheet items fall back to a dnd5e item-type classifier.
 *
 * The regression this locks down: the curated pack stamps mundane base gear
 * with system.rarity "common", so the old `Boolean(rarity)` magic heuristic
 * mis-classified a plain Longsword as a magic weapon on the sell side.
 */

import assert from "node:assert/strict";

import {
  itemBuyCategories,
  itemMatchesBuyFilter,
} from "./merchant/buy-filter.js";

const tagged = (lootType, extra = {}) => ({
  flags: { "infinity-dnd5e": { lootType } },
  ...extra,
});

/* ---- tagged items: classified by lootType, dnd5e fallback skipped ---- */
{
  // A mundane Longsword the pack stamps rarity "common" must NOT read as magic.
  const longsword = tagged("loot.weapon.mundane", {
    type: "weapon",
    system: { type: { value: "martial" }, rarity: "common" },
  });
  const cats = itemBuyCategories(longsword);
  assert.ok(
    cats.has("loot.weapon.mundane"),
    "tagged mundane weapon -> mundane",
  );
  assert.ok(
    !cats.has("loot.weapon.magic"),
    'rarity "common" on tagged mundane gear must not classify it as magic',
  );

  // A tagged magic item routes to its magic bucket.
  const ring = tagged("loot.equipment.magic", {
    type: "equipment",
    system: { type: { value: "trinket" }, rarity: "rare" },
  });
  assert.ok(
    itemBuyCategories(ring).has("loot.equipment.magic"),
    "tagged magic equipment -> magic",
  );

  // Tagged potion/reagent route only to their own chip (consistent with the
  // roller, which keeps Potions and Potions&Consumables as distinct chips).
  const potion = tagged("loot.potion", {
    type: "consumable",
    system: { type: { value: "potion" }, rarity: "common" },
  });
  assert.ok(
    itemBuyCategories(potion).has("loot.potion"),
    "tagged potion -> potion",
  );
  assert.ok(
    !itemBuyCategories(potion).has("loot.consumable"),
    "tagged potion is not double-classified as loot.consumable",
  );

  const reagent = tagged("loot.reagent", {
    type: "consumable",
    system: { type: { value: "reagent" } },
  });
  assert.ok(
    itemBuyCategories(reagent).has("loot.reagent"),
    "tagged reagent -> reagent",
  );
}

/* ---- untagged sheet items: dnd5e-type fallback, corrected magic heuristic ---- */
{
  // Untagged base gear with rarity "common" must classify as mundane.
  const commonGear = {
    type: "weapon",
    system: { type: { value: "simple" }, rarity: "common" },
  };
  const c = itemBuyCategories(commonGear);
  assert.ok(
    c.has("loot.weapon.mundane"),
    'untagged "common" weapon -> mundane',
  );
  assert.ok(
    !c.has("loot.weapon.magic"),
    'untagged "common" weapon is not magic',
  );

  // Untagged with no rarity -> mundane.
  const noRarity = { type: "weapon", system: { type: { value: "martial" } } };
  assert.ok(
    itemBuyCategories(noRarity).has("loot.weapon.mundane"),
    "untagged no-rarity weapon -> mundane",
  );

  // Untagged uncommon+ -> magic.
  const uncommon = {
    type: "equipment",
    system: { type: { value: "trinket" }, rarity: "uncommon" },
  };
  assert.ok(
    itemBuyCategories(uncommon).has("loot.equipment.magic"),
    "untagged uncommon equipment -> magic",
  );

  // Untagged potion -> consumable AND potion (sheet fallback breadth).
  const potion = { type: "consumable", system: { type: { value: "potion" } } };
  const p = itemBuyCategories(potion);
  assert.ok(
    p.has("loot.potion") && p.has("loot.consumable"),
    "untagged potion -> both",
  );

  // Synthetic ammunition chip.
  const arrow = { type: "consumable", system: { type: { value: "ammo" } } };
  assert.ok(
    itemBuyCategories(arrow).has("loot.ammunition"),
    "ammo -> ammunition chip",
  );
}

/* ---- itemMatchesBuyFilter end-to-end ---- */
{
  const longsword = tagged("loot.weapon.mundane", {
    type: "weapon",
    system: { type: { value: "martial" }, rarity: "common" },
  });
  // Empty filter buys anything.
  assert.equal(itemMatchesBuyFilter({}, longsword), true);
  // A mundane-weapons merchant buys it; a magic-only merchant does NOT.
  assert.equal(
    itemMatchesBuyFilter({ lootTypes: ["loot.weapon.mundane"] }, longsword),
    true,
    "mundane Longsword sells to a mundane-weapons merchant",
  );
  assert.equal(
    itemMatchesBuyFilter({ lootTypes: ["loot.weapon.magic"] }, longsword),
    false,
    "mundane Longsword is NOT bought by a magic-only weapons merchant (the bug fix)",
  );
}

process.stdout.write("merchant buy-filter validation passed\n");
