import assert from "node:assert/strict";

import { rollMerchantStock } from "./merchant/pool.js";
import {
  allocateStockUnits,
  editStockTypeShare,
  normalizeStockTypeShares,
} from "./merchant/stock-split.js";

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

/* The editor keeps selected types at 100%, including uneven edits and additions. */
{
  const types = ["loot.equipment.magic", "loot.scroll"];
  assert.deepEqual(normalizeStockTypeShares(types), {
    "loot.equipment.magic": 50,
    "loot.scroll": 50,
  });
  assert.deepEqual(
    editStockTypeShare(types, normalizeStockTypeShares(types), types[0], 10),
    {
      "loot.equipment.magic": 10,
      "loot.scroll": 90,
    },
  );
  assert.deepEqual(
    allocateStockUnits(600000, types, {
      "loot.equipment.magic": 10,
      "loot.scroll": 90,
    }),
    {
      "loot.equipment.magic": 60000,
      "loot.scroll": 540000,
    },
  );
  const all = [...types, "loot.ammunition", "loot.potion", "loot.art"];
  assert.equal(
    Object.values(normalizeStockTypeShares(all)).reduce((a, b) => a + b),
    100,
  );
  const adjusted = editStockTypeShare(
    all,
    normalizeStockTypeShares(all),
    "loot.scroll",
    65,
  );
  assert.equal(adjusted["loot.scroll"], 65);
  assert.equal(
    Object.values(adjusted).reduce((a, b) => a + b),
    100,
  );
}

/* Budget quotas are per type, and overlapping consumable/ammunition belongs to ammo. */
{
  const magic = ["helm", "ring", "stone", "cloak", "boots", "hat"].map((id) =>
    mkItem(id, "loot.equipment.magic", "uncommon", {
      flags: {
        "infinity-dnd5e": {
          lootType: "loot.equipment.magic",
          maxRecommendedQty: 2,
          gpValue: 300,
        },
      },
    }),
  );
  const scrolls = Array.from({ length: 20 }, (_, i) =>
    mkItem(`scroll-${i}`, "loot.scroll", "common", {
      flags: {
        "infinity-dnd5e": {
          lootType: "loot.scroll",
          maxRecommendedQty: 2,
          gpValue: 300,
        },
      },
    }),
  );
  const rowsFor = (seed) =>
    rollMerchantStock(
      {
        lootTypes: ["loot.equipment.magic", "loot.scroll"],
        typeShares: { "loot.equipment.magic": 10, "loot.scroll": 90 },
        count: 0,
        budgetGp: 6000,
      },
      [...magic, ...scrolls],
      { rng: mulberry32(seed) },
    ).rows;
  for (let seed = 1; seed <= 20; seed++) {
    const rows = rowsFor(seed);
    const equipment = rows.filter((row) =>
      magic.some((item) => item.uuid === row.uuid),
    );
    const selectedScrolls = rows.filter((row) =>
      scrolls.some((item) => item.uuid === row.uuid),
    );
    assert.ok(equipment.reduce((sum, row) => sum + row.qty * 300, 0) <= 600);
    assert.ok(
      selectedScrolls.reduce((sum, row) => sum + row.qty * 300, 0) <= 5400,
    );
    assert.equal(
      equipment.length,
      2,
      "unique magic items fill the 600 gp allowance",
    );
    assert.ok(
      selectedScrolls.length >= 16 && selectedScrolls.length <= 18,
      "scrolls approach their allowance",
    );
    assert.ok(
      rows.every((row) => row.qty === 1),
      "distinct candidates precede repeats",
    );
  }
  assert.notDeepEqual(
    rowsFor(1).map((row) => row.uuid),
    rowsFor(2).map((row) => row.uuid),
    "regeneration varies the selected items",
  );
  const cramped = rollMerchantStock(
    {
      lootTypes: ["loot.equipment.magic", "loot.scroll"],
      typeShares: { "loot.equipment.magic": 10, "loot.scroll": 90 },
      count: 0,
      budgetGp: 6000,
    },
    [
      magic[0],
      {
        ...magic[1],
        flags: {
          "infinity-dnd5e": { lootType: "loot.equipment.magic", gpValue: 1000 },
        },
      },
      ...scrolls,
    ],
    { rng: mulberry32(3) },
  );
  assert.match(cramped.warnings.join(" "), /can only fit helm.*600 gp share/i);
}

{
  const ammo = mkItem("arrows", "loot.consumable", "common", {
    system: {
      type: { value: "ammo" },
      price: { value: 1, denomination: "gp" },
    },
  });
  const potion = mkItem("healing", "loot.consumable", "common", {
    system: { price: { value: 20, denomination: "gp" } },
  });
  const result = rollMerchantStock(
    {
      lootTypes: ["loot.consumable", "loot.ammunition"],
      typeShares: { "loot.consumable": 50, "loot.ammunition": 50 },
      count: 0,
      budgetGp: 40,
    },
    [ammo, potion],
    { rng: mulberry32(1) },
  );
  assert.equal(
    result.rows.length,
    2,
    "overlapping ammunition is owned by its specific type",
  );
  assert.equal(result.rows.find((row) => row.uuid === ammo.uuid).qty, 20);
}

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
 * Repeated stock quantities use the item's recommended count and stock budget
 * ------------------------------------------------------------------ */
{
  const potion = mkItem("healing-potion-stack", "loot.potion", "common", {
    system: { rarity: "common", price: { value: 50, denomination: "gp" } },
    flags: {
      "infinity-dnd5e": {
        lootType: "loot.potion",
        rarityNormalized: "common",
        maxRecommendedQty: 4,
        gpValue: 50,
      },
    },
  });
  const pool = { lootTypes: ["loot.potion"], rarities: [], count: 1 };
  assert.equal(
    rollMerchantStock(pool, [potion], { rng: () => 0 }).rows[0].qty,
    1,
    "a potion can still stock as a single bottle",
  );
  const multiple = rollMerchantStock(pool, [potion], { rng: () => 0.99 });
  assert.equal(multiple.rows.length, 1, "repeated potions share one shelf row");
  assert.equal(
    multiple.rows[0].qty,
    4,
    "a potion can stock up to its recommended quantity",
  );
  assert.equal(multiple.rows[0].startingQty, 4);

  const budgeted = rollMerchantStock(
    { ...pool, count: 0, budgetGp: 200 },
    [potion],
    { rng: () => 0 },
  );
  assert.equal(
    budgeted.rows[0].qty,
    4,
    "budget fill can draw the same potion repeatedly",
  );
  const capped = rollMerchantStock({ ...pool, budgetGp: 100 }, [potion], {
    rng: () => 0.99,
  });
  assert.equal(capped.rows[0].qty, 2, "the stock budget caps repeated bottles");
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
 * Category-first Merchant balance is independent of source-folder size.
 * One potion document competes with one hundred weapon documents by the
 * configured category weights, not by a 100:1 document-count advantage.
 * ------------------------------------------------------------------ */
{
  const oversizedWeaponFolder = Array.from({ length: 100 }, (_, index) =>
    mkItem(`magic-weapon-${index}`, "loot.weapon.magic", "common"),
  );
  const mixedPool = [
    ...oversizedWeaponFolder,
    mkItem("only-potion", "loot.potion", "common"),
  ];
  let weaponRolls = 0;
  const trials = 400;
  for (let seed = 1; seed <= trials; seed += 1) {
    const { rows } = rollMerchantStock(
      {
        lootTypes: ["loot.weapon.magic", "loot.potion"],
        rarities: ["common"],
        count: 1,
      },
      mixedPool,
      { rng: mulberry32(seed) },
    );
    assert.equal(rows.length, 1);
    if (rows[0].uuid.includes("magic-weapon-")) weaponRolls += 1;
  }
  const weaponRate = weaponRolls / trials;
  assert.ok(
    weaponRate >= 0.3 && weaponRate <= 0.55,
    `merchant category rate ${weaponRate.toFixed(3)} follows category weights, not document cardinality`,
  );
}

/* ------------------------------------------------------------------ *
 * Merchants are shelf generators, not loot bundles: a mixed stock pool has
 * no one-scroll cap. With a deterministic low draw, scrolls remain eligible
 * after the first named scroll is stocked.
 * ------------------------------------------------------------------ */
{
  const scrollStock = [
    mkItem("named-scroll-1", "loot.scroll", "common"),
    mkItem("named-scroll-2", "loot.scroll", "common"),
    mkItem("named-scroll-3", "loot.scroll", "common"),
    mkItem("named-scroll-4", "loot.scroll", "common"),
    mkItem("healing-potion", "loot.potion", "common"),
  ];
  const { rows } = rollMerchantStock(
    {
      lootTypes: ["loot.scroll", "loot.potion"],
      rarities: ["common"],
      count: 3,
    },
    scrollStock,
    { rng: () => 0 },
  );
  assert.equal(rows.length, 3);
  assert.ok(
    rows.every((row) => row.uuid.includes("named-scroll-")),
    "mixed merchant stock can contain multiple distinct named scrolls",
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
      flags: {
        "infinity-dnd5e": {
          lootType: "consumable",
          gpValue: 1,
          maxRecommendedQty: 8,
        },
      },
    }),
    mkItem("bolts", "consumable", "common", {
      system: {
        type: { value: "ammo" },
        price: { value: 1, denomination: "gp" },
      },
      flags: {
        "infinity-dnd5e": { lootType: "consumable", gpValue: 1 },
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
    assert.equal(row.qty % 20, 0, "ammo stocks in full 20-piece stacks");
    assert.equal(row.startingQty, row.qty, "restock retains all drawn stacks");
  }
  const multipleStacks = rollMerchantStock(
    { lootTypes: ["consumable"], rarities: [], count: 1 },
    [ammo[0]],
    { rng: () => 0.99 },
  );
  assert.equal(
    multipleStacks.rows[0].qty,
    160,
    "ammunition can draw eight full stacks",
  );
  const budgeted = rollMerchantStock(
    { lootTypes: ["consumable"], rarities: [], count: 0, budgetGp: 25 },
    ammo,
    { rng: mulberry32(99) },
  );
  assert.equal(budgeted.rows.length, 1, "a 25 gp target fits one 20 gp quiver");
  assert.equal(budgeted.rows[0].qty, 20);
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

/* ------------------------------------------------------------------ *
 * Name de-dup — two different entries sharing a name collapse to one row
 * ------------------------------------------------------------------ */
{
  const items = [
    mkItem("p1", "gem", "common", { name: "Healing Potion" }),
    mkItem("p2", "gem", "common", { name: "Healing Potion" }),
    mkItem("d1", "gem", "common", { name: "Dagger" }),
  ];
  const { rows } = rollMerchantStock(
    { lootTypes: ["gem"], rarities: ["common"], count: 5 },
    items,
    { rng: mulberry32(7) },
  );
  assert.equal(
    new Set(rows.map((r) => r.uuid)).size,
    rows.length,
    "no duplicate uuids",
  );
  // Only the first "Healing Potion" entry can survive; its twin never rolls.
  assert.ok(
    rows.every((r) => r.uuid !== "Compendium.test.Item.p2"),
    "the duplicate-named entry is dropped before rolling",
  );
}

/* ------------------------------------------------------------------ *
 * excludeNames — an item already on the shelf (by name) is not re-rolled
 * ------------------------------------------------------------------ */
{
  const items = [
    mkItem("p1", "gem", "common", { name: "Healing Potion" }),
    mkItem("d1", "gem", "common", { name: "Dagger" }),
  ];
  const { rows } = rollMerchantStock(
    { lootTypes: ["gem"], rarities: ["common"], count: 5 },
    items,
    { excludeNames: ["Healing Potion"], rng: mulberry32(1) },
  );
  assert.ok(
    rows.every((r) => r.uuid !== "Compendium.test.Item.p1"),
    "an excluded name is never rolled",
  );
}

/* ------------------------------------------------------------------ *
 * Fill modes — blank count + budget vs. neither set
 * ------------------------------------------------------------------ */
{
  const priced = (id, gp) => ({
    _id: id,
    uuid: `Compendium.test.Item.${id}`,
    name: `Gizmo ${id}`,
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
  const items = Array.from({ length: 8 }, (_, i) => priced(`g${i}`, 20));

  // Blank count + budget → fill mode (no count/budget fallback warning).
  const filled = rollMerchantStock(
    { lootTypes: ["gem"], rarities: ["common"], count: 0, budgetGp: 100 },
    items,
    { rng: mulberry32(3) },
  );
  assert.ok(filled.rows.length >= 1, "budget fill produces stock");
  assert.ok(
    filled.rows.length <= items.length,
    "budget fill never exceeds the candidate pool",
  );
  assert.ok(
    !filled.warnings.some((w) => w.includes("default of")),
    "no fallback warning when a budget is set",
  );

  // Neither count nor budget → fallback to a default spread, with a warning.
  const fallback = rollMerchantStock(
    { lootTypes: ["gem"], rarities: ["common"], count: 0, budgetGp: 0 },
    items,
    { rng: mulberry32(3) },
  );
  assert.ok(
    fallback.warnings.some((w) => w.includes("default of")),
    "fallback warning when neither count nor budget is set",
  );
  assert.ok(fallback.rows.length >= 1, "fallback still produces stock");

  // Value-based shelves must not inherit the general loot roller's 40-line
  // safety default (nor the old city template's 16-line count).
  const largePool = Array.from({ length: 80 }, (_, i) =>
    priced(`large-${i}`, 1),
  );
  const large = rollMerchantStock(
    { lootTypes: ["gem"], rarities: ["common"], count: 0, budgetGp: 70 },
    largePool,
    { rng: mulberry32(7) },
  );
  assert.ok(
    large.rows.length > 40,
    "value target can stock more than 40 types",
  );
  assert.ok(large.rows.length <= 70, "value target stays within the budget");
}

process.stdout.write("merchant-pool validation passed\n");
