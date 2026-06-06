import assert from "node:assert/strict";

import { rollMerchantStock } from "./merchant/pool.js";

/* Deterministic PRNG so the weighted draw is repeatable in tests. */
function mulberry32(seed) {
  return function () {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function mkItem(id, lootType, rarity, extra = {}) {
  return {
    _id: id,
    uuid: `Compendium.test.Item.${id}`,
    name: id,
    img: "icons/svg/item-bag.svg",
    system: { rarity, price: { value: 10, denomination: "gp" } },
    flags: { "infinity-dnd5e": { lootType, rarityNormalized: rarity } },
    ...extra,
  };
}

const ITEMS = [
  mkItem("wand1", "weapon-magic", "rare"),
  mkItem("wand2", "weapon-magic", "rare"),
  mkItem("wand3", "weapon-magic", "very-rare"),
  mkItem("gem1", "gem", "common"),
  mkItem("gem2", "gem", "common"),
];

/* ------------------------------------------------------------------ *
 * Filter is respected, count is bounded
 * ------------------------------------------------------------------ */
{
  const { rows, warnings } = rollMerchantStock(
    { lootTypes: ["weapon-magic"], rarities: [], count: 2 },
    ITEMS,
    { rng: mulberry32(42) },
  );
  assert.equal(warnings.length, 0, "no warnings on a good roll");
  assert.ok(rows.length >= 1 && rows.length <= 2, "respects the count cap");
  const allowed = new Set(
    ["wand1", "wand2", "wand3"].map((id) => `Compendium.test.Item.${id}`),
  );
  for (const row of rows) {
    assert.ok(allowed.has(row.uuid), `${row.uuid} is a weapon-magic item`);
    assert.equal(row.qty, 1, "non-ammo stocks one per distinct item");
  }
  // No duplicate uuids in the generated rows.
  assert.equal(
    new Set(rows.map((r) => r.uuid)).size,
    rows.length,
    "distinct items",
  );
}

/* ------------------------------------------------------------------ *
 * Rarity filter
 * ------------------------------------------------------------------ */
{
  const { rows } = rollMerchantStock(
    { lootTypes: [], rarities: ["common"], count: 5 },
    ITEMS,
    { rng: mulberry32(7) },
  );
  const commonUuids = new Set(
    ["gem1", "gem2"].map((id) => `Compendium.test.Item.${id}`),
  );
  assert.ok(rows.length >= 1, "rolled at least one common item");
  for (const row of rows) {
    assert.ok(commonUuids.has(row.uuid), `${row.uuid} is a common item`);
  }
}

/* ------------------------------------------------------------------ *
 * Rarity balance biases the pool without widening the rarity filter
 * ------------------------------------------------------------------ */
{
  const { rows } = rollMerchantStock(
    {
      lootTypes: [],
      rarities: ["common", "rare"],
      count: 1,
      rarityWeights: { common: 0, rare: 10 },
    },
    ITEMS,
    { rng: () => 0.99 },
  );
  assert.equal(rows.length, 1, "rolled one weighted item");
  assert.ok(
    rows[0].uuid.includes("wand"),
    "rare-weighted stock favors rare rows over common rows",
  );
}

/* ------------------------------------------------------------------ *
 * Ammunition always stocks in full stacks of 20
 * ------------------------------------------------------------------ */
{
  const ammo = [
    mkItem("arrows", "consumable", "common", {
      system: {
        type: { value: "ammo" },
        price: { value: 1, denomination: "gp" },
      },
    }),
    mkItem("bolts", "consumable", "common", {
      system: {
        type: { value: "ammo" },
        price: { value: 1, denomination: "gp" },
      },
    }),
  ];
  const { rows } = rollMerchantStock(
    { lootTypes: ["consumable"], rarities: [], count: 2 },
    ammo,
    { rng: mulberry32(99) },
  );
  assert.ok(rows.length >= 1, "rolled ammo");
  for (const row of rows) {
    assert.equal(row.qty, 20, "ammo qty is a full stack of 20");
    assert.equal(row.startingQty, 20, "ammo startingQty is a full stack of 20");
  }
}

/* ------------------------------------------------------------------ *
 * Empty pool config → warning, no rows
 * ------------------------------------------------------------------ */
{
  const { rows, warnings } = rollMerchantStock(
    { lootTypes: [], rarities: [], count: 3 },
    ITEMS,
    { rng: mulberry32(1) },
  );
  assert.equal(rows.length, 0, "nothing generated with an empty pool");
  assert.ok(warnings.length > 0, "warns when no types/rarities are selected");
}

/* ------------------------------------------------------------------ *
 * Exclude already-stocked uuids
 * ------------------------------------------------------------------ */
{
  const exclude = new Set(
    ["wand1", "wand2"].map((id) => `Compendium.test.Item.${id}`),
  );
  const { rows } = rollMerchantStock(
    { lootTypes: ["weapon-magic"], rarities: [], count: 5 },
    ITEMS,
    { rng: mulberry32(5), exclude },
  );
  for (const row of rows) {
    assert.ok(!exclude.has(row.uuid), `${row.uuid} was excluded`);
  }
  assert.ok(
    rows.every((r) => r.uuid === "Compendium.test.Item.wand3"),
    "only the non-excluded weapon-magic item can be drawn",
  );
}

/* ------------------------------------------------------------------ *
 * Value band (minGp / maxGp) restricts the pool by item gp value
 * ------------------------------------------------------------------ */
{
  const priced = (id, gp) => ({
    _id: id,
    uuid: `Compendium.test.Item.${id}`,
    name: id,
    img: "icons/svg/item-bag.svg",
    system: { rarity: "common", price: { value: gp, denomination: "gp" } },
    flags: {
      "infinity-dnd5e": {
        lootType: "gem",
        rarityNormalized: "common",
        gpValue: gp,
      },
    },
  });
  const items = [priced("cheap", 50), priced("mid", 500), priced("dear", 5000)];

  // A max ceiling excludes the expensive item (market-tier behavior).
  const { rows } = rollMerchantStock(
    { lootTypes: ["gem"], rarities: [], count: 10, maxGp: 600 },
    items,
    { rng: mulberry32(3) },
  );
  const ids = new Set(rows.map((r) => r.uuid));
  assert.ok(rows.length >= 1, "cheaper gems still stock under a cap");
  assert.ok(
    !ids.has("Compendium.test.Item.dear"),
    "the 5,000 gp gem is excluded by maxGp 600",
  );

  // A floor excludes the cheapest item.
  const { rows: rows2 } = rollMerchantStock(
    { lootTypes: ["gem"], rarities: [], count: 10, minGp: 100 },
    items,
    { rng: mulberry32(4) },
  );
  for (const row of rows2) {
    assert.notEqual(
      row.uuid,
      "Compendium.test.Item.cheap",
      "the 50 gp gem is excluded by minGp 100",
    );
  }
}

process.stdout.write("merchant-pool validation passed\n");
