import assert from "node:assert/strict";

import {
  adjustMerchantGold,
  applyBargainDelta,
  applyPreviewBuy,
  applyPreviewSell,
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
  getSelfServiceMode,
  isSelfServiceReachable,
  isUserAllowed,
  mergeStockRows,
  sanitizeMerchantForList,
  SELF_SERVICE_MODES,
  normalizeBuyFilter,
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
import { computePassiveBargainPct } from "./merchant/bargain.js";
import {
  itemBuyCategories,
  itemMatchesBuyFilter,
} from "./merchant/buy-filter.js";

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
  assert.deepEqual(blank.allowedSkills, ["per", "dec"]);
  assert.equal(blank.passiveHaggle, true, "passive haggle on by default");
  assert.equal(blank.passivePctPerPoint, 2);
  assert.equal(blank.passiveCapPct, 20);
  assert.deepEqual(blank.buyFilter, { lootTypes: [], rarities: [] });
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
    budgetGp: 0,
    rarityBalance: "even",
    rarityWeights: {
      common: 1,
      uncommon: 1,
      rare: 1,
      "very-rare": 1,
      legendary: 1,
      artifact: 1,
    },
    minGp: 0,
    maxGp: 0,
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
  assert.equal(
    normalizeStockPool({ count: 0 }).count,
    0,
    "count 0 = no line cap (fill toward budget)",
  );
  assert.equal(
    normalizeStockPool({ count: "" }).count,
    0,
    "blank count = no line cap",
  );
  assert.equal(
    normalizeStockPool({ budgetGp: 2500 }).budgetGp,
    2500,
    "stock budget retained",
  );
  assert.equal(
    normalizeStockPool({ budgetGp: -5 }).budgetGp,
    0,
    "negative budget floors to 0",
  );

  // Value band: non-negative integers, 0 = no limit.
  const banded = normalizeStockPool({ minGp: 250, maxGp: 5000 });
  assert.equal(banded.minGp, 250);
  assert.equal(banded.maxGp, 5000);
  assert.equal(
    normalizeStockPool({ minGp: -10, maxGp: -1 }).minGp,
    0,
    "negative min floors to 0 (no limit)",
  );
  assert.equal(normalizeStockPool({ minGp: -10, maxGp: -1 }).maxGp, 0);
  assert.equal(normalizeStockPool({ maxGp: 12.9 }).maxGp, 12, "floors max");

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
    budgetGp: 0,
    rarityBalance: "even",
    rarityWeights: {
      common: 1,
      uncommon: 1,
      rare: 1,
      "very-rare": 1,
      legendary: 1,
      artifact: 1,
    },
    minGp: 0,
    maxGp: 0,
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

/* ------------------------------------------------------------------ *
 * isUserAllowed — GMs are never "allowed" players
 * ------------------------------------------------------------------ */
{
  const merchant = normalizeMerchant({ allowedUserIds: ["alice", "gm-1"] });
  // No game stubbed → can't resolve GM, falls back to list membership.
  assert.equal(isUserAllowed(merchant, "alice"), true);

  const savedGame = globalThis.game;
  globalThis.game = {
    users: {
      get: (id) => (id === "gm-1" ? { isGM: true } : { isGM: false }),
    },
  };
  try {
    assert.equal(
      isUserAllowed(merchant, "gm-1"),
      false,
      "a GM id is rejected even when listed in allowedUserIds",
    );
    assert.equal(
      isUserAllowed(merchant, "alice"),
      true,
      "a non-GM listed player is still allowed",
    );
  } finally {
    if (savedGame === undefined) delete globalThis.game;
    else globalThis.game = savedGame;
  }
}

/* ------------------------------------------------------------------ *
 * GM preview math — sandbox buy/sell against a merchant clone
 * ------------------------------------------------------------------ */
{
  const m = normalizeMerchant({
    id: "shop",
    goldOnHand: 100,
    items: [
      { uuid: "u-pot", qty: 5, startingQty: 5 },
      { uuid: "u-rope", qty: 1, startingQty: 1, unlimited: true },
    ],
  });

  // Finite stock decrements; merchant gains the paid gold; source untouched.
  const afterBuy = applyPreviewBuy(m, "u-pot", 2, 30);
  assert.equal(afterBuy.items.find((r) => r.uuid === "u-pot").qty, 3);
  assert.equal(afterBuy.goldOnHand, 130);
  assert.equal(
    m.items.find((r) => r.uuid === "u-pot").qty,
    5,
    "preview buy does not mutate the source merchant",
  );

  // Unlimited row: stock unchanged, gold still gained.
  const afterUnl = applyPreviewBuy(m, "u-rope", 3, 36);
  assert.equal(afterUnl.items.find((r) => r.uuid === "u-rope").qty, 1);
  assert.equal(afterUnl.goldOnHand, 136);

  // Buying past finite stock leaves stock alone but still credits gold.
  const afterOver = applyPreviewBuy(m, "u-pot", 99, 50);
  assert.equal(afterOver.items.find((r) => r.uuid === "u-pot").qty, 5);
  assert.equal(afterOver.goldOnHand, 150);

  // Unlimited purse stays unlimited.
  const unlPurse = normalizeMerchant({
    id: "x",
    items: [{ uuid: "u", qty: 3, startingQty: 3 }],
  });
  assert.equal(applyPreviewBuy(unlPurse, "u", 1, 20).goldOnHand, null);

  // Preview sell: merchant pays out, clamped at 0; unlimited purse unchanged.
  const seller = normalizeMerchant({ id: "s", goldOnHand: 100 });
  assert.equal(applyPreviewSell(seller, 30).goldOnHand, 70);
  assert.equal(applyPreviewSell(seller, 999).goldOnHand, 0);
  assert.equal(
    applyPreviewSell(normalizeMerchant({ id: "u2" }), 50).goldOnHand,
    null,
  );
}

/* ------------------------------------------------------------------ *
 * Legacy skill migration (prf → per) + invalid fallback
 * ------------------------------------------------------------------ */
{
  assert.deepEqual(
    normalizeMerchant({ allowedSkills: ["prf", "dec"] }).allowedSkills,
    ["per", "dec"],
    "legacy prf (Performance) migrates to per (Persuasion)",
  );
  assert.deepEqual(
    normalizeMerchant({ allowedSkills: ["prf", "per"] }).allowedSkills,
    ["per"],
    "migration de-dupes when both prf and per are present",
  );
  assert.deepEqual(
    normalizeMerchant({ allowedSkills: ["bogus"] }).allowedSkills,
    ["per", "dec"],
    "all-invalid skill list falls back to defaults",
  );
  assert.equal(
    normalizeMerchant({ passiveHaggle: false }).passiveHaggle,
    false,
    "passive haggle can be disabled",
  );
}

/* ------------------------------------------------------------------ *
 * mergeStockRows — collapse duplicate uuids into one summed row
 * ------------------------------------------------------------------ */
{
  const merged = mergeStockRows([
    { uuid: "a", qty: 2, startingQty: 2 },
    { uuid: "b", qty: 1, startingQty: 1, priceOverrideGp: null },
    { uuid: "a", qty: 3, startingQty: 3, priceOverrideGp: 9 },
  ]);
  assert.equal(merged.length, 2, "two distinct rows after merge");
  const a = merged.find((r) => r.uuid === "a");
  assert.equal(a.qty, 5, "quantities summed");
  assert.equal(a.startingQty, 5, "starting quantities summed");
  assert.equal(a.priceOverrideGp, 9, "first non-null override kept");

  // Unlimited stays unlimited; normalizeMerchant applies merge automatically.
  const m = normalizeMerchant({
    items: [
      { uuid: "x", qty: 1, startingQty: 1 },
      { uuid: "x", qty: 4, startingQty: 4 },
    ],
  });
  assert.equal(m.items.length, 1, "normalizeMerchant collapses duplicate rows");
  assert.equal(m.items[0].qty, 5);
}

/* ------------------------------------------------------------------ *
 * Buy filter — normalize + matching (tagged + dnd5e fallback)
 * ------------------------------------------------------------------ */
{
  assert.deepEqual(normalizeBuyFilter(undefined), {
    lootTypes: [],
    rarities: [],
  });
  assert.deepEqual(
    normalizeBuyFilter({
      lootTypes: ["loot.weapon.magic", "loot.weapon.magic"],
    }),
    { lootTypes: ["loot.weapon.magic"], rarities: [] },
    "buy filter dedupes loot types",
  );

  const longsword = { type: "weapon", system: { type: { value: "martial" } } };
  const magicSword = {
    type: "weapon",
    system: { type: { value: "martial" }, rarity: "rare" },
  };
  const potion = {
    type: "consumable",
    system: { type: { value: "potion" } },
  };

  // dnd5e fallback classification
  assert.ok(
    itemBuyCategories(longsword).has("loot.weapon.mundane"),
    "mundane weapon classified",
  );
  assert.ok(
    itemBuyCategories(magicSword).has("loot.weapon.magic"),
    "rarity marks a magic weapon",
  );
  assert.ok(itemBuyCategories(potion).has("loot.potion"), "potion classified");
  assert.ok(
    itemBuyCategories(potion).has("loot.consumable"),
    "potion is also a consumable",
  );

  // Empty filter buys anything.
  assert.equal(itemMatchesBuyFilter({}, longsword), true);
  assert.equal(
    itemMatchesBuyFilter({ lootTypes: [], rarities: [] }, potion),
    true,
  );

  // A weapons-only smith buys swords, not potions.
  const smith = { lootTypes: ["loot.weapon.mundane", "loot.weapon.magic"] };
  assert.equal(itemMatchesBuyFilter(smith, longsword), true);
  assert.equal(itemMatchesBuyFilter(smith, potion), false);

  // AND semantics: type AND rarity must both match.
  const rareSmith = {
    lootTypes: ["loot.weapon.magic", "loot.weapon.mundane"],
    rarities: ["rare"],
  };
  assert.equal(
    itemMatchesBuyFilter(rareSmith, magicSword),
    true,
    "rare magic weapon matches a rare weapons filter",
  );
  assert.equal(
    itemMatchesBuyFilter(rareSmith, longsword),
    false,
    "common longsword fails the rare filter",
  );

  // A PACK-TAGGED mundane weapon (system.rarity "common" is dnd5e's magic
  // marker, but the curated tag says mundane) must NOT gain the magic chip,
  // so a magic-only buyer rejects it. Regression: the dnd5e fallback used to
  // run unconditionally and add loot.weapon.magic on top of the tag.
  const taggedMundaneSword = {
    type: "weapon",
    system: { type: { value: "martial" }, rarity: "common" },
    flags: { "infinity-dnd5e": { lootType: "loot.weapon" } },
  };
  const cats = itemBuyCategories(taggedMundaneSword);
  assert.ok(
    cats.has("loot.weapon.mundane"),
    "tagged mundane weapon stays mundane",
  );
  assert.ok(
    !cats.has("loot.weapon.magic"),
    "tagged mundane weapon does not also classify as magic",
  );
  assert.equal(
    itemMatchesBuyFilter(
      { lootTypes: ["loot.weapon.magic"] },
      taggedMundaneSword,
    ),
    false,
    "magic-only buyer refuses a tagged mundane weapon",
  );
  // An untagged sheet weapon with a real rarity still classifies as magic.
  assert.ok(
    itemBuyCategories({ type: "weapon", system: { rarity: "rare" } }).has(
      "loot.weapon.magic",
    ),
    "untagged magic weapon still uses the dnd5e fallback",
  );
}

/* ------------------------------------------------------------------ *
 * Passive haggle — vs-10 baseline, capped, supersedable
 * ------------------------------------------------------------------ */
{
  const merchant = normalizeMerchant({
    allowedSkills: ["per", "dec"],
    passivePctPerPoint: 2,
    passiveCapPct: 20,
  });
  const actor = (per, dec) => ({
    system: { skills: { per: { passive: per }, dec: { passive: dec } } },
  });

  assert.equal(
    computePassiveBargainPct(merchant, actor(10, 8)),
    0,
    "passive 10 (baseline) → no nudge",
  );
  assert.equal(
    computePassiveBargainPct(merchant, actor(15, 12)),
    -10,
    "best passive 15 → −10% (2% × 5 points)",
  );
  assert.equal(
    computePassiveBargainPct(merchant, actor(8, 7)),
    4,
    "below baseline → positive (worse) delta",
  );
  assert.equal(
    computePassiveBargainPct(merchant, actor(40, 40)),
    -20,
    "capped at −20%",
  );
  assert.equal(
    computePassiveBargainPct(
      { ...merchant, passiveHaggle: false },
      actor(20, 20),
    ),
    0,
    "disabled passive haggle → 0",
  );
  assert.equal(computePassiveBargainPct(merchant, null), 0, "no actor → 0");
}

/* ------------------------------------------------------------------ *
 * Self-service access mode + sanitized list projection
 * ------------------------------------------------------------------ */
{
  // Default: a shop with no allowed players is GM-pull only ("off").
  assert.equal(
    normalizeMerchant({}).selfServiceMode,
    "off",
    "no allowed players → off by default",
  );
  assert.equal(createBlankMerchant({ name: "X" }).selfServiceMode, "off");

  // Cold-start: a legacy record with allowed players but no explicit mode
  // upgrades to "open" so it isn't invisible after the feature ships.
  assert.equal(
    normalizeMerchant({ allowedUserIds: ["u1"] }).selfServiceMode,
    "open",
    "allowed players + absent mode → open (cold-start upgrade)",
  );

  // An explicit value always wins over the cold-start rule.
  assert.equal(
    normalizeMerchant({ allowedUserIds: ["u1"], selfServiceMode: "off" })
      .selfServiceMode,
    "off",
    "explicit off wins over cold-start",
  );
  assert.equal(
    normalizeMerchant({ allowedUserIds: ["u1"], selfServiceMode: "knock" })
      .selfServiceMode,
    "knock",
  );
  // A present-but-unrecognized value FAILS CLOSED to "off" (it is not treated
  // as "absent", so the cold-start upgrade does not apply even with players).
  assert.equal(
    normalizeMerchant({ allowedUserIds: ["u1"], selfServiceMode: "bogus" })
      .selfServiceMode,
    "off",
    "garbage mode fails closed even with allowed players",
  );
  assert.equal(
    normalizeMerchant({ selfServiceMode: "bogus" }).selfServiceMode,
    "off",
  );
  // A genuinely blank/absent field still cold-starts (blank is indistinguishable
  // from missing and carries no intent).
  assert.equal(
    normalizeMerchant({ allowedUserIds: ["u1"], selfServiceMode: "" })
      .selfServiceMode,
    "open",
    "blank mode is treated as absent → cold-start upgrade",
  );

  // Idempotent: re-normalizing a saved "open" record keeps it open.
  const once = normalizeMerchant({ allowedUserIds: ["u1"] });
  assert.equal(normalizeMerchant(once).selfServiceMode, "open");

  // getSelfServiceMode + isSelfServiceReachable
  assert.deepEqual([...SELF_SERVICE_MODES], ["off", "open", "knock"]);
  assert.equal(getSelfServiceMode({ selfServiceMode: "knock" }), "knock");
  assert.equal(getSelfServiceMode({ selfServiceMode: "nope" }), "off");
  assert.equal(getSelfServiceMode(null), "off");
  assert.equal(isSelfServiceReachable({ selfServiceMode: "off" }), false);
  assert.equal(isSelfServiceReachable({ selfServiceMode: "open" }), true);
  assert.equal(isSelfServiceReachable({ selfServiceMode: "knock" }), true);

  // sanitizeMerchantForList strips every economy + permission internal.
  const rich = normalizeMerchant({
    id: "m-brundle",
    name: "Brundle's Wares",
    art: "shop.webp",
    description: "Dusty oddments.",
    goldOnHand: 999,
    defaultMarkup: 2,
    sellRatio: 0.7,
    bargainDC: 18,
    allowedUserIds: ["u1", "u2"],
    buyFilter: { lootTypes: ["loot.gem"], rarities: ["rare"] },
    items: [{ uuid: "Compendium.p.Item.a", qty: 3, priceOverrideGp: 5 }],
  });
  const safe = sanitizeMerchantForList(rich);
  assert.deepEqual(
    Object.keys(safe).sort(),
    ["art", "description", "id", "name", "selfServiceMode"],
    "list projection exposes only id/name/art/description/selfServiceMode",
  );
  assert.equal(safe.id, "m-brundle");
  assert.equal(safe.selfServiceMode, "open");
  for (const leaked of [
    "goldOnHand",
    "defaultMarkup",
    "sellRatio",
    "bargainDC",
    "allowedUserIds",
    "buyFilter",
    "items",
    "pool",
  ]) {
    assert.equal(safe[leaked], undefined, `${leaked} must not leak to players`);
  }
}

process.stdout.write("merchant-store validation passed\n");
