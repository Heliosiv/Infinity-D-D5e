import assert from "node:assert/strict";

import {
  applyBargainDelta,
  computeBuyPriceGp,
  computeSellPriceGp,
  createBlankMerchant,
  createInventoryRow,
  decrementInventory,
  getDefaultBargainTiers,
  isUserAllowed,
  normalizeInventoryRow,
  normalizeMerchant,
  normalizeStockPool,
  removeInventoryRow,
  resolveItemBasePriceGp,
  resolveStockQty,
  restockAll,
  roundGp,
  upsertInventoryRow,
  AMMO_STACK_SIZE,
} from "./merchant/store.js";

/* ------------------------------------------------------------------ *
 * normalizeMerchant
 * ------------------------------------------------------------------ */
{
  const blank = normalizeMerchant({});
  assert.ok(blank.id, "id assigned");
  assert.equal(blank.name, "Unnamed Merchant");
  assert.equal(blank.defaultMarkup, 1.0);
  assert.equal(blank.sellRatio, 0.5);
  assert.equal(blank.bargainDC, 15);
  assert.deepEqual(blank.allowedSkills, ["prf", "dec"]);
  assert.deepEqual(blank.items, []);
}

{
  const merchant = normalizeMerchant({
    id: "m-1",
    name: "Yannick",
    defaultMarkup: 1.5,
    sellRatio: 0.4,
    bargainDC: 18,
    bargainAdvantage: true,
    allowedSkills: ["dec", "bogus"],
    allowedUserIds: ["u1", "u2", "u1"], // dedupe
    items: [
      { uuid: "Compendium.pack.Item.abc", qty: 5, startingQty: 5 },
      { uuid: "Compendium.pack.Item.xyz", qty: 1, startingQty: 3, unlimited: true },
      { uuid: "", qty: 1 }, // dropped
      null, // dropped
    ],
  });
  assert.equal(merchant.id, "m-1");
  assert.equal(merchant.defaultMarkup, 1.5);
  assert.equal(merchant.bargainAdvantage, true);
  assert.deepEqual(merchant.allowedSkills, ["dec"], "bogus skills dropped");
  assert.deepEqual(merchant.allowedUserIds, ["u1", "u2"], "user ids deduped");
  assert.equal(merchant.items.length, 2, "malformed rows dropped");
  assert.equal(merchant.items[1].unlimited, true);
  assert.equal(
    merchant.items[1].qty,
    merchant.items[1].startingQty,
    "unlimited row carries startingQty as qty",
  );
}

/* ------------------------------------------------------------------ *
 * createBlankMerchant + createInventoryRow
 * ------------------------------------------------------------------ */
{
  const m = createBlankMerchant({ name: "Test" });
  assert.equal(m.name, "Test");
  assert.equal(m.items.length, 0);

  const row = createInventoryRow("Compendium.pack.Item.abc", {
    startingQty: 3,
    priceOverrideGp: 12.5,
  });
  assert.equal(row.uuid, "Compendium.pack.Item.abc");
  assert.equal(row.qty, 3);
  assert.equal(row.startingQty, 3);
  assert.equal(row.priceOverrideGp, 12.5);
}

/* ------------------------------------------------------------------ *
 * Inventory mutation
 * ------------------------------------------------------------------ */
{
  const m = normalizeMerchant({
    id: "m",
    items: [
      { uuid: "u1", qty: 5, startingQty: 5 },
      { uuid: "u2", qty: 0, startingQty: 2 },
      { uuid: "u3", qty: 1, startingQty: 1, unlimited: true },
    ],
  });

  // Decrement
  const dec = decrementInventory(m, "u1", 2);
  assert.equal(dec.items.find((r) => r.uuid === "u1").qty, 3);
  assert.notEqual(dec, m, "returns new object");

  // Decrement unlimited is a no-op on qty
  const decUnl = decrementInventory(m, "u3", 99);
  assert.equal(decUnl.items.find((r) => r.uuid === "u3").qty, 1, "unlimited qty unchanged");

  // Out-of-stock throws
  assert.throws(() => decrementInventory(m, "u2", 1));
  // Unknown uuid throws
  assert.throws(() => decrementInventory(m, "nope", 1));

  // Restock
  const restocked = restockAll(m);
  assert.equal(restocked.items.find((r) => r.uuid === "u2").qty, 2);

  // Upsert (add)
  const added = upsertInventoryRow(m, {
    uuid: "u4",
    qty: 7,
    startingQty: 7,
  });
  assert.equal(added.items.length, 4);

  // Upsert (replace)
  const replaced = upsertInventoryRow(m, {
    uuid: "u1",
    qty: 99,
    startingQty: 99,
  });
  assert.equal(replaced.items.find((r) => r.uuid === "u1").qty, 99);

  // Remove
  const removed = removeInventoryRow(m, "u2");
  assert.equal(removed.items.length, 2);
}

/* ------------------------------------------------------------------ *
 * Pricing
 * ------------------------------------------------------------------ */
{
  const item = { name: "Potion", system: { price: { value: 50, denomination: "gp" } } };
  const merchant = normalizeMerchant({
    id: "m",
    defaultMarkup: 1.2,
    sellRatio: 0.5,
  });
  const row = { uuid: "u", qty: 1, startingQty: 1, unlimited: false, priceOverrideGp: null };

  assert.equal(computeBuyPriceGp(merchant, row, item), 60, "50 × 1.2 = 60");
  assert.equal(computeSellPriceGp(merchant, item), 25, "50 × 0.5 = 25");

  const overrideRow = { ...row, priceOverrideGp: 42 };
  assert.equal(
    computeBuyPriceGp(merchant, overrideRow, item),
    42,
    "override wins over markup math",
  );
}

{
  // Denomination conversion
  assert.equal(resolveItemBasePriceGp({ system: { price: { value: 10, denomination: "gp" } } }), 10);
  assert.equal(resolveItemBasePriceGp({ system: { price: { value: 1, denomination: "pp" } } }), 10);
  assert.equal(resolveItemBasePriceGp({ system: { price: { value: 100, denomination: "sp" } } }), 10);
  assert.equal(resolveItemBasePriceGp({ system: { price: { value: 1000, denomination: "cp" } } }), 10);
  assert.equal(resolveItemBasePriceGp({ system: { price: { value: 2, denomination: "ep" } } }), 1);
  assert.equal(resolveItemBasePriceGp({}), 0);
  assert.equal(resolveItemBasePriceGp(null), 0);
}

{
  // applyBargainDelta + roundGp
  assert.equal(applyBargainDelta(100, -20), 80);
  assert.equal(applyBargainDelta(100, 20), 120);
  assert.equal(applyBargainDelta(100, 0), 100);
  assert.equal(applyBargainDelta(-5, 0), 0, "negative price clamps to 0");
  assert.equal(roundGp(1.234), 1.23);
  assert.equal(roundGp(1.236), 1.24);
}

/* ------------------------------------------------------------------ *
 * Default bargain tiers + isUserAllowed
 * ------------------------------------------------------------------ */
{
  const tiers = getDefaultBargainTiers();
  assert.equal(tiers.length, 4);
  assert.ok(tiers[0].minMargin > tiers[1].minMargin, "tiers descend in margin");

  const merchant = normalizeMerchant({ allowedUserIds: ["alice", "bob"] });
  assert.equal(isUserAllowed(merchant, "alice"), true);
  assert.equal(isUserAllowed(merchant, "carol"), false);
  assert.equal(isUserAllowed(null, "alice"), false);
}

/* ------------------------------------------------------------------ *
 * Stock pool + ammunition stacking
 * ------------------------------------------------------------------ */
{
  // normalizeStockPool: defaults, dedupe, count clamp
  assert.deepEqual(normalizeStockPool(undefined), {
    lootTypes: [],
    rarities: [],
    count: 6,
  });
  const pool = normalizeStockPool({
    lootTypes: ["weapon-magic", "weapon-magic", "gem"],
    rarities: ["common"],
    count: 999,
  });
  assert.deepEqual(pool.lootTypes, ["weapon-magic", "gem"], "loot types deduped");
  assert.deepEqual(pool.rarities, ["common"]);
  assert.equal(pool.count, 50, "count clamped to 50");
  assert.equal(normalizeStockPool({ count: 0 }).count, 1, "count floored to 1");

  // normalizeMerchant carries a normalized pool, even when absent
  const m = normalizeMerchant({ pool: { lootTypes: ["consumable"], count: 3 } });
  assert.deepEqual(m.pool.lootTypes, ["consumable"]);
  assert.equal(m.pool.count, 3);
  assert.deepEqual(normalizeMerchant({}).pool, {
    lootTypes: [],
    rarities: [],
    count: 6,
  });

  // resolveStockQty: ammo → full stack of 20, everything else → requested
  const ammo = { system: { type: { value: "ammo" } } };
  const sword = { system: { type: { value: "" } } };
  assert.equal(AMMO_STACK_SIZE, 20);
  assert.equal(resolveStockQty(ammo, 1), 20, "ammo stocks as a full stack of 20");
  assert.equal(resolveStockQty(ammo, 5), 20, "ammo ignores the requested qty");
  assert.equal(resolveStockQty(sword, 1), 1);
  assert.equal(resolveStockQty(sword, 4), 4, "non-ammo honors requested qty");
  assert.equal(resolveStockQty(sword, 0), 1, "invalid qty floors to 1");
}

process.stdout.write("merchant-store validation passed\n");
