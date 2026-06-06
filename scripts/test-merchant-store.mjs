import assert from "node:assert/strict";

import {
  adjustMerchantGold,
  applyBargainDelta,
  buildMerchantBargainTiers,
  clearInventory,
  computeBuyPriceGp,
  computeSellPriceGp,
  createBlankMerchant,
  createInventoryRow,
  decrementInventory,
  duplicateMerchant,
  merchantCanAfford,
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
      {
        uuid: "Compendium.pack.Item.xyz",
        qty: 1,
        startingQty: 3,
        unlimited: true,
      },
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
 * duplicateMerchant — copy config, fresh id, empty inventory
 * ------------------------------------------------------------------ */
{
  const source = normalizeMerchant({
    id: "m-orig",
    name: "Yannick",
    defaultMarkup: 1.4,
    sellRatio: 0.6,
    bargainDC: 18,
    allowedSkills: ["dec"],
    allowedUserIds: ["u1", "u2"],
    goldOnHand: 750,
    pool: { lootTypes: ["gem"], rarities: ["rare"], count: 5 },
    items: [
      { uuid: "Compendium.x.Item.a", qty: 3, startingQty: 3 },
      { uuid: "Compendium.x.Item.b", qty: 1, startingQty: 1 },
    ],
  });

  const copy = duplicateMerchant(source);
  assert.ok(copy.id, "copy has an id");
  assert.notEqual(copy.id, source.id, "copy gets a fresh id");
  assert.equal(copy.name, "Yannick (Copy)", "name suffixed with (Copy)");
  assert.equal(copy.items.length, 0, "inventory cleared on the copy");
  assert.equal(copy.defaultMarkup, 1.4, "markup config carried over");
  assert.equal(copy.sellRatio, 0.6, "sell ratio carried over");
  assert.equal(copy.bargainDC, 18, "bargain DC carried over");
  assert.equal(copy.goldOnHand, 750, "gold on hand carried over");
  assert.deepEqual(copy.allowedSkills, ["dec"], "allowed skills carried over");
  assert.deepEqual(copy.allowedUserIds, ["u1", "u2"], "players carried over");
  assert.deepEqual(copy.pool.lootTypes, ["gem"], "stock pool carried over");
  assert.equal(copy.pool.count, 5);

  // Source is never mutated.
  assert.equal(source.items.length, 2, "source inventory untouched");
  assert.equal(source.name, "Yannick", "source name untouched");

  // Custom name override wins over the "(Copy)" default.
  assert.equal(
    duplicateMerchant(source, { name: "Yannick II" }).name,
    "Yannick II",
  );
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
  assert.equal(
    decUnl.items.find((r) => r.uuid === "u3").qty,
    1,
    "unlimited qty unchanged",
  );

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
  const item = {
    name: "Potion",
    system: { price: { value: 50, denomination: "gp" } },
  };
  const merchant = normalizeMerchant({
    id: "m",
    defaultMarkup: 1.2,
    sellRatio: 0.5,
  });
  const row = {
    uuid: "u",
    qty: 1,
    startingQty: 1,
    unlimited: false,
    priceOverrideGp: null,
  };

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
  assert.equal(
    resolveItemBasePriceGp({
      system: { price: { value: 10, denomination: "gp" } },
    }),
    10,
  );
  assert.equal(
    resolveItemBasePriceGp({
      system: { price: { value: 1, denomination: "pp" } },
    }),
    10,
  );
  assert.equal(
    resolveItemBasePriceGp({
      system: { price: { value: 100, denomination: "sp" } },
    }),
    10,
  );
  assert.equal(
    resolveItemBasePriceGp({
      system: { price: { value: 1000, denomination: "cp" } },
    }),
    10,
  );
  assert.equal(
    resolveItemBasePriceGp({
      system: { price: { value: 2, denomination: "ep" } },
    }),
    1,
  );
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
    rarityBalance: "even",
    rarityWeights: {
      common: 1,
      uncommon: 1,
      rare: 1,
      "very-rare": 1,
      legendary: 1,
      artifact: 1,
    },
  });
  const pool = normalizeStockPool({
    lootTypes: ["weapon-magic", "weapon-magic", "gem"],
    rarities: ["common"],
    count: 999,
    rarityBalance: "custom",
    rarityWeights: { common: 2, rare: 0.5 },
  });
  assert.deepEqual(
    pool.lootTypes,
    ["weapon-magic", "gem"],
    "loot types deduped",
  );
  assert.deepEqual(pool.rarities, ["common"]);
  assert.equal(pool.count, 50, "count clamped to 50");
  assert.equal(pool.rarityBalance, "custom");
  assert.equal(pool.rarityWeights.common, 2);
  assert.equal(pool.rarityWeights.rare, 0.5);
  assert.equal(normalizeStockPool({ count: 0 }).count, 1, "count floored to 1");

  // normalizeMerchant carries a normalized pool, even when absent
  const m = normalizeMerchant({
    pool: { lootTypes: ["consumable"], count: 3 },
  });
  assert.deepEqual(m.pool.lootTypes, ["consumable"]);
  assert.equal(m.pool.count, 3);
  assert.deepEqual(normalizeMerchant({}).pool, {
    lootTypes: [],
    rarities: [],
    count: 6,
    rarityBalance: "even",
    rarityWeights: {
      common: 1,
      uncommon: 1,
      rare: 1,
      "very-rare": 1,
      legendary: 1,
      artifact: 1,
    },
  });

  // resolveStockQty: ammo → full stack of 20, everything else → requested
  const ammo = { system: { type: { value: "ammo" } } };
  const sword = { system: { type: { value: "" } } };
  assert.equal(AMMO_STACK_SIZE, 20);
  assert.equal(
    resolveStockQty(ammo, 1),
    20,
    "ammo stocks as a full stack of 20",
  );
  assert.equal(resolveStockQty(ammo, 5), 20, "ammo ignores the requested qty");
  assert.equal(resolveStockQty(sword, 1), 1);
  assert.equal(resolveStockQty(sword, 4), 4, "non-ammo honors requested qty");
  assert.equal(resolveStockQty(sword, 0), 1, "invalid qty floors to 1");
}

/* ------------------------------------------------------------------ *
 * Gold-on-hand, bargain percentages, clear inventory
 * ------------------------------------------------------------------ */
{
  // Normalized defaults
  const def = normalizeMerchant({});
  assert.equal(def.goldOnHand, null, "blank gold → unlimited (null)");
  assert.equal(def.bargainSuccessPct, 10);
  assert.equal(def.bargainFailPct, 10);

  // Gold normalization
  assert.equal(normalizeMerchant({ goldOnHand: 500 }).goldOnHand, 500);
  assert.equal(
    normalizeMerchant({ goldOnHand: 0 }).goldOnHand,
    0,
    "explicit 0 = broke, not unlimited",
  );
  assert.equal(normalizeMerchant({ goldOnHand: "" }).goldOnHand, null);
  assert.equal(
    normalizeMerchant({ goldOnHand: -50 }).goldOnHand,
    0,
    "negative clamps to 0",
  );

  // adjustMerchantGold
  const g500 = normalizeMerchant({ id: "g", goldOnHand: 500 });
  assert.equal(adjustMerchantGold(g500, 100).goldOnHand, 600, "gains gold");
  assert.equal(
    adjustMerchantGold(g500, -700).goldOnHand,
    0,
    "spending clamps at 0",
  );
  const unlimited = normalizeMerchant({ id: "u" });
  assert.equal(
    adjustMerchantGold(unlimited, -999).goldOnHand,
    null,
    "unlimited purse unchanged",
  );

  // merchantCanAfford
  assert.equal(merchantCanAfford(g500, 400), true);
  assert.equal(merchantCanAfford(g500, 600), false);
  assert.equal(merchantCanAfford(unlimited, 1e9), true);

  // clearInventory
  const stocked = normalizeMerchant({
    id: "s",
    items: [
      { uuid: "u1", qty: 3 },
      { uuid: "u2", qty: 1 },
    ],
  });
  assert.equal(clearInventory(stocked).items.length, 0, "inventory cleared");

  // buildMerchantBargainTiers — 2 tiers, no crit distinction
  const tiers = buildMerchantBargainTiers({
    bargainSuccessPct: 15,
    bargainFailPct: 25,
  });
  assert.equal(tiers.length, 2);
  const success = tiers.find((t) => t.id === "success");
  const failure = tiers.find((t) => t.id === "failure");
  assert.equal(success.deltaPct, -15, "success lowers price");
  assert.equal(success.minMargin, 0);
  assert.equal(failure.deltaPct, 25, "failure raises price");
  assert.equal(failure.minMargin, -Infinity);
}

process.stdout.write("merchant-store validation passed\n");
