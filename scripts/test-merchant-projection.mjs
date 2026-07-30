/**
 * Contract tests for the player-safe merchant projection.
 *
 * Merchant records contain access policy, stock-generation settings, and
 * inventory notes that must remain GM-only. This test locks the complete
 * player payload shape and proves that the projected fields still drive the
 * same player-visible pricing, filtering, passive-haggle, purse, and stock
 * behavior as the canonical merchant.
 */

import assert from "node:assert/strict";

import { computePassiveBargainPct } from "./merchant/bargain.js";
import { itemMatchesBuyFilter } from "./merchant/buy-filter.js";
import {
  MERCHANT_SESSION_PROJECTION_VERSION,
  projectMerchantForSession,
} from "./merchant/projection.js";
import {
  applyPreviewBuy,
  merchantCanAfford,
  normalizeMerchant,
} from "./merchant/store.js";
import {
  resolveUnitBuyPrice,
  resolveUnitSellPrice,
} from "./merchant/transaction.js";

const TOP_LEVEL_KEYS = Object.freeze([
  "allowedSkills",
  "art",
  "bargainDC",
  "bargainFailPct",
  "buyFilter",
  "defaultMarkup",
  "description",
  "goldOnHand",
  "id",
  "items",
  "name",
  "passiveCapPct",
  "passiveHaggle",
  "passivePctPerPoint",
  "schemaVersion",
  "sellRatio",
]);

const BUY_FILTER_KEYS = Object.freeze(["lootTypes", "rarities"]);
const INVENTORY_ROW_KEYS = Object.freeze([
  "priceOverrideGp",
  "qty",
  "unlimited",
  "uuid",
]);

function assertExactKeys(value, expected, label) {
  assert.deepEqual(
    Object.keys(value).sort(),
    [...expected].sort(),
    `${label} must contain only its allowlisted keys`,
  );
}

function rowByUuid(merchant, uuid) {
  const row = merchant.items.find((candidate) => candidate.uuid === uuid);
  assert.ok(row, `expected merchant row ${uuid}`);
  return row;
}

function relevantStock(merchant) {
  return merchant.items
    .map(({ uuid, qty, unlimited, priceOverrideGp }) => ({
      uuid,
      qty,
      unlimited,
      priceOverrideGp,
    }))
    .sort((a, b) => a.uuid.localeCompare(b.uuid));
}

/* ------------------------------------------------------------------ *
 * Exact allowlists, secret omission, and meaningful edge values
 * ------------------------------------------------------------------ */
{
  const canonical = normalizeMerchant({
    id: "edge-values-shop",
    version: 99,
    name: "The Empty Till",
    art: "",
    description: "",
    defaultMarkup: 0,
    sellRatio: 0,
    bargainDC: 0,
    bargainAdvantage: true,
    bargainSuccessPct: 17,
    bargainFailPct: 0,
    passiveHaggle: false,
    passivePctPerPoint: 0,
    passiveCapPct: 0,
    goldOnHand: 0,
    allowedSkills: ["itm"],
    allowedUserIds: ["secret-player-id"],
    selfServiceMode: "open",
    chatHidden: true,
    pool: {
      count: 12,
      lootTypes: ["loot.weapon.magic"],
      rarities: ["legendary"],
    },
    buyFilter: {
      lootTypes: [],
      rarities: [],
    },
    items: [
      {
        uuid: "Compendium.infinity-dnd5e.items.Item.zero",
        qty: 0,
        startingQty: 9,
        unlimited: false,
        priceOverrideGp: 0,
        notes: "secret finite-stock note",
      },
      {
        uuid: "Compendium.infinity-dnd5e.items.Item.unlimited",
        qty: 0,
        startingQty: 0,
        unlimited: true,
        priceOverrideGp: null,
        notes: "secret unlimited-stock note",
      },
    ],
  });

  const projected = projectMerchantForSession(canonical);

  assertExactKeys(projected, TOP_LEVEL_KEYS, "merchant projection");
  assertExactKeys(projected.buyFilter, BUY_FILTER_KEYS, "buy filter");
  for (const row of projected.items) {
    assertExactKeys(row, INVENTORY_ROW_KEYS, `inventory row ${row.uuid}`);
  }

  assert.equal(
    projected.schemaVersion,
    MERCHANT_SESSION_PROJECTION_VERSION,
    "the projection declares its transport schema version",
  );

  for (const secretKey of [
    "version",
    "allowedUserIds",
    "selfServiceMode",
    "chatHidden",
    "pool",
    "bargainAdvantage",
    "bargainSuccessPct",
  ]) {
    assert.equal(
      Object.hasOwn(projected, secretKey),
      false,
      `${secretKey} must not leave the GM`,
    );
  }
  for (const row of projected.items) {
    assert.equal(
      Object.hasOwn(row, "startingQty"),
      false,
      "startingQty must remain GM-only",
    );
    assert.equal(
      Object.hasOwn(row, "notes"),
      false,
      "inventory notes must remain GM-only",
    );
  }

  const serialized = JSON.stringify(projected);
  for (const secretValue of [
    "secret-player-id",
    "secret finite-stock note",
    "secret unlimited-stock note",
  ]) {
    assert.equal(
      serialized.includes(secretValue),
      false,
      `secret value ${secretValue} must not appear anywhere in the payload`,
    );
  }

  assert.equal(projected.art, "", "an empty art path remains empty");
  assert.equal(projected.description, "", "an empty description remains empty");
  assert.equal(projected.defaultMarkup, 0, "zero markup remains zero");
  assert.equal(projected.sellRatio, 0, "zero sell ratio remains zero");
  assert.equal(projected.bargainDC, 0, "zero bargain DC remains zero");
  assert.equal(
    projected.bargainFailPct,
    0,
    "zero bargain failure percent remains zero",
  );
  assert.equal(
    projected.passiveHaggle,
    false,
    "disabled passive haggle remains false",
  );
  assert.equal(
    projected.passivePctPerPoint,
    0,
    "zero passive percent remains zero",
  );
  assert.equal(projected.passiveCapPct, 0, "zero passive cap remains zero");
  assert.equal(projected.goldOnHand, 0, "an empty finite purse remains zero");
  assert.deepEqual(
    projected.buyFilter,
    { lootTypes: [], rarities: [] },
    "empty filter arrays remain empty",
  );

  const zeroRow = rowByUuid(
    projected,
    "Compendium.infinity-dnd5e.items.Item.zero",
  );
  assert.equal(zeroRow.qty, 0, "zero finite stock remains zero");
  assert.equal(zeroRow.unlimited, false, "finite stock remains finite");
  assert.equal(
    zeroRow.priceOverrideGp,
    0,
    "a free-price override remains zero",
  );

  const unlimitedRow = rowByUuid(
    projected,
    "Compendium.infinity-dnd5e.items.Item.unlimited",
  );
  assert.equal(unlimitedRow.qty, 0, "zero display stock remains zero");
  assert.equal(
    unlimitedRow.unlimited,
    true,
    "unlimited stock remains unlimited",
  );
  assert.equal(
    unlimitedRow.priceOverrideGp,
    null,
    "an absent price override remains null",
  );

  const unlimitedPurse = projectMerchantForSession(
    normalizeMerchant({
      id: "unlimited-purse-shop",
      goldOnHand: null,
      buyFilter: { lootTypes: [], rarities: [] },
      items: [],
    }),
  );
  assert.equal(
    unlimitedPurse.goldOnHand,
    null,
    "an unlimited merchant purse remains null",
  );
  assert.deepEqual(
    unlimitedPurse.items,
    [],
    "an empty inventory remains empty",
  );
}

/* ------------------------------------------------------------------ *
 * Nested values are cloned, not shared with the canonical merchant
 * ------------------------------------------------------------------ */
{
  const canonical = normalizeMerchant({
    id: "clone-shop",
    allowedSkills: ["itm"],
    buyFilter: {
      lootTypes: ["loot.weapon.mundane"],
      rarities: ["common"],
    },
    items: [
      {
        uuid: "Compendium.infinity-dnd5e.items.Item.clone",
        qty: 3,
        startingQty: 7,
        unlimited: false,
        priceOverrideGp: 4.5,
        notes: "canonical note",
      },
    ],
  });
  const projected = projectMerchantForSession(canonical);

  assert.notStrictEqual(projected, canonical, "the merchant object is cloned");
  assert.notStrictEqual(
    projected.allowedSkills,
    canonical.allowedSkills,
    "allowedSkills is cloned",
  );
  assert.notStrictEqual(
    projected.buyFilter,
    canonical.buyFilter,
    "buyFilter is cloned",
  );
  assert.notStrictEqual(
    projected.buyFilter.lootTypes,
    canonical.buyFilter.lootTypes,
    "buy-filter loot types are cloned",
  );
  assert.notStrictEqual(
    projected.buyFilter.rarities,
    canonical.buyFilter.rarities,
    "buy-filter rarities are cloned",
  );
  assert.notStrictEqual(
    projected.items,
    canonical.items,
    "the inventory array is cloned",
  );
  assert.notStrictEqual(
    projected.items[0],
    canonical.items[0],
    "each projected inventory row is cloned",
  );

  projected.allowedSkills.push("per");
  projected.buyFilter.lootTypes.push("loot.potion");
  projected.buyFilter.rarities.push("rare");
  projected.items[0].qty = 99;
  projected.items.push({
    uuid: "Compendium.infinity-dnd5e.items.Item.injected",
    qty: 1,
    unlimited: false,
    priceOverrideGp: null,
  });

  assert.deepEqual(
    canonical.allowedSkills,
    ["itm"],
    "projected skill mutations do not reach canonical state",
  );
  assert.deepEqual(
    canonical.buyFilter,
    {
      lootTypes: ["loot.weapon.mundane"],
      rarities: ["common"],
    },
    "projected filter mutations do not reach canonical state",
  );
  assert.equal(
    canonical.items[0].qty,
    3,
    "projected row mutations do not reach canonical state",
  );
  assert.equal(
    canonical.items.length,
    1,
    "projected inventory mutations do not reach canonical state",
  );
}

/* ------------------------------------------------------------------ *
 * Player-visible behavior matches the canonical merchant
 * ------------------------------------------------------------------ */
{
  const markupUuid = "Compendium.infinity-dnd5e.items.Item.markup";
  const freeUuid = "Compendium.infinity-dnd5e.items.Item.free";
  const unlimitedUuid = "Compendium.infinity-dnd5e.items.Item.passive-stock";

  const canonical = normalizeMerchant({
    id: "behavior-shop",
    name: "Projection Parity",
    defaultMarkup: 1.35,
    sellRatio: 0.42,
    bargainDC: 19,
    bargainAdvantage: true,
    bargainSuccessPct: 17,
    bargainFailPct: 23,
    passiveHaggle: true,
    passivePctPerPoint: 3,
    passiveCapPct: 12,
    goldOnHand: 37.5,
    allowedSkills: ["itm"],
    allowedUserIds: ["secret-behavior-player"],
    buyFilter: {
      lootTypes: ["loot.weapon.mundane"],
      rarities: ["common"],
    },
    items: [
      {
        uuid: markupUuid,
        qty: 5,
        startingQty: 9,
        unlimited: false,
        priceOverrideGp: null,
        notes: "secret markup note",
      },
      {
        uuid: freeUuid,
        qty: 1,
        startingQty: 1,
        unlimited: false,
        priceOverrideGp: 0,
        notes: "secret free note",
      },
      {
        uuid: unlimitedUuid,
        qty: 0,
        startingQty: 0,
        unlimited: true,
        priceOverrideGp: 12.5,
        notes: "secret unlimited note",
      },
    ],
  });

  // MerchantSessionApp normalizes the received transport payload before use.
  const playerMerchant = normalizeMerchant(
    projectMerchantForSession(canonical),
  );
  const actor = {
    system: {
      skills: {
        itm: { passive: 15 },
        per: { passive: 40 },
      },
    },
  };
  const acceptedItem = {
    type: "weapon",
    system: {
      type: { value: "martial" },
      rarity: "common",
      price: { value: 100, denomination: "gp" },
    },
    flags: {},
  };
  const rejectedItem = {
    type: "consumable",
    system: {
      type: { value: "potion" },
      rarity: "common",
      price: { value: 100, denomination: "gp" },
    },
    flags: {},
  };

  const canonicalPassive = computePassiveBargainPct(canonical, actor);
  const playerPassive = computePassiveBargainPct(playerMerchant, actor);
  assert.equal(canonicalPassive, -12, "canonical passive haggle is capped");
  assert.equal(
    playerPassive,
    canonicalPassive,
    "projected skills and passive settings produce the same haggle",
  );

  for (const uuid of [markupUuid, freeUuid, unlimitedUuid]) {
    const canonicalPrice = resolveUnitBuyPrice({
      merchant: canonical,
      row: rowByUuid(canonical, uuid),
      item: acceptedItem,
      passivePct: canonicalPassive,
    });
    const playerPrice = resolveUnitBuyPrice({
      merchant: playerMerchant,
      row: rowByUuid(playerMerchant, uuid),
      item: acceptedItem,
      passivePct: playerPassive,
    });
    assert.equal(
      playerPrice,
      canonicalPrice,
      `projected buy pricing matches for ${uuid}`,
    );
  }
  assert.equal(
    resolveUnitBuyPrice({
      merchant: playerMerchant,
      row: rowByUuid(playerMerchant, markupUuid),
      item: acceptedItem,
      passivePct: playerPassive,
    }),
    118.8,
    "markup and passive haggle compose after projection",
  );
  assert.equal(
    resolveUnitBuyPrice({
      merchant: playerMerchant,
      row: rowByUuid(playerMerchant, freeUuid),
      item: acceptedItem,
      passivePct: playerPassive,
    }),
    0,
    "a zero override stays free after projection",
  );
  assert.equal(
    resolveUnitBuyPrice({
      merchant: playerMerchant,
      row: rowByUuid(playerMerchant, unlimitedUuid),
      item: acceptedItem,
      passivePct: playerPassive,
    }),
    11,
    "an explicit override and passive haggle compose after projection",
  );

  const canonicalSellPrice = resolveUnitSellPrice({
    merchant: canonical,
    item: acceptedItem,
    passivePct: canonicalPassive,
  });
  const playerSellPrice = resolveUnitSellPrice({
    merchant: playerMerchant,
    item: acceptedItem,
    passivePct: playerPassive,
  });
  assert.equal(
    playerSellPrice,
    canonicalSellPrice,
    "projected sell ratio produces the same payout",
  );
  assert.equal(
    playerSellPrice,
    47.04,
    "sell pricing keeps the passive-haggle sign after projection",
  );

  for (const [item, expected] of [
    [acceptedItem, true],
    [rejectedItem, false],
  ]) {
    assert.equal(
      itemMatchesBuyFilter(playerMerchant.buyFilter, item),
      itemMatchesBuyFilter(canonical.buyFilter, item),
      "projected buy-filter behavior matches canonical behavior",
    );
    assert.equal(
      itemMatchesBuyFilter(playerMerchant.buyFilter, item),
      expected,
      "the projected buy filter keeps its allow/deny result",
    );
  }

  for (const amount of [0, 37.5, 37.51]) {
    assert.equal(
      merchantCanAfford(playerMerchant, amount),
      merchantCanAfford(canonical, amount),
      `projected purse behavior matches at ${amount} gp`,
    );
  }

  const canonicalFiniteBuy = applyPreviewBuy(canonical, markupUuid, 2, 20);
  const playerFiniteBuy = applyPreviewBuy(playerMerchant, markupUuid, 2, 20);
  assert.deepEqual(
    relevantStock(playerFiniteBuy),
    relevantStock(canonicalFiniteBuy),
    "finite stock decrements identically after projection",
  );
  assert.equal(
    playerFiniteBuy.goldOnHand,
    canonicalFiniteBuy.goldOnHand,
    "finite-stock purchases update the projected purse identically",
  );
  assert.equal(
    rowByUuid(playerFiniteBuy, markupUuid).qty,
    3,
    "a two-item purchase decrements finite projected stock",
  );

  const canonicalUnlimitedBuy = applyPreviewBuy(
    canonical,
    unlimitedUuid,
    3,
    15,
  );
  const playerUnlimitedBuy = applyPreviewBuy(
    playerMerchant,
    unlimitedUuid,
    3,
    15,
  );
  assert.deepEqual(
    relevantStock(playerUnlimitedBuy),
    relevantStock(canonicalUnlimitedBuy),
    "unlimited stock behaves identically after projection",
  );
  assert.equal(
    rowByUuid(playerUnlimitedBuy, unlimitedUuid).qty,
    0,
    "unlimited projected stock does not decrement",
  );
}

process.stdout.write("merchant player projection validation passed\n");
