/**
 * Tests for the merchant pricing pure helpers:
 *  - isSellable gates what a player may sell (blocks non-physical types,
 *    quest items, and the module's explicit `unsellable` flag),
 *  - resolveUnitBuyPrice / resolveUnitSellPrice compose the base price with
 *    a bargain seal deltaPct or the passive-haggle nudge. The sell path flips
 *    the sign, so a "price down" delta becomes a higher payout to the seller.
 *
 * A wrong sign or a missed clamp here means players silently pay (or receive)
 * the wrong amount with no other test signal — hence the standalone coverage.
 */

import assert from "node:assert/strict";

import {
  isSellable,
  resolveUnitBuyPrice,
  resolveUnitSellPrice,
} from "./merchant/transaction.js";
import {
  applyBargainDelta,
  computeBuyPriceGp,
  computeSellPriceGp,
  normalizeMerchant,
  roundGp,
} from "./merchant/store.js";

/* ------------------------------------------------------------------ *
 * isSellable
 * ------------------------------------------------------------------ */
{
  const make = (overrides = {}) => ({
    type: "weapon",
    flags: {},
    ...overrides,
  });

  for (const type of ["spell", "feat", "class"]) {
    assert.equal(
      isSellable(make({ type })),
      false,
      `${type} is a non-physical type and must not be sellable`,
    );
  }

  assert.equal(
    isSellable(make({ flags: { "infinity-dnd5e": { unsellable: true } } })),
    false,
    "an item flagged unsellable must not be sellable",
  );
  assert.equal(
    isSellable(make({ flags: { dnd5e: { questItem: true } } })),
    false,
    "a quest item must not be sellable",
  );

  assert.equal(isSellable(make({ type: "weapon" })), true, "a weapon sells");
  assert.equal(isSellable(null), false, "a missing item is not sellable");
}

/* ------------------------------------------------------------------ *
 * resolveUnitBuyPrice
 * ------------------------------------------------------------------ */
{
  // markup 1.0 → base buy price equals the item gp value.
  const merchant = normalizeMerchant({ id: "shop", defaultMarkup: 1.0 });
  const row = { uuid: "u-1", qty: 1, unlimited: false, priceOverrideGp: null };
  const item = { system: { price: { value: 100, denomination: "gp" } } };

  const base = computeBuyPriceGp(merchant, row, item);
  assert.equal(base, 100, "markup 1.0 → base equals item price");

  assert.equal(
    resolveUnitBuyPrice({ merchant, row, item }),
    roundGp(base),
    "no seal / no passive → base markup price",
  );

  const seal = { deltaPct: -20 };
  assert.equal(
    resolveUnitBuyPrice({ merchant, row, item, seal }),
    roundGp(applyBargainDelta(base, -20)),
    "a -20% seal discounts the buy price",
  );
  assert.equal(
    resolveUnitBuyPrice({ merchant, row, item, seal }),
    80,
    "100 gp - 20% = 80 gp",
  );

  assert.equal(
    resolveUnitBuyPrice({ merchant, row, item, passivePct: -20 }),
    80,
    "passive nudge alone also discounts the buy price",
  );

  // A present seal supersedes the passive nudge.
  assert.equal(
    resolveUnitBuyPrice({ merchant, row, item, seal, passivePct: -50 }),
    80,
    "an active seal wins over the passive nudge",
  );
}

/* ------------------------------------------------------------------ *
 * resolveUnitSellPrice — the sign flips so the seller benefits
 * ------------------------------------------------------------------ */
{
  const merchant = normalizeMerchant({ id: "shop", sellRatio: 0.5 });
  const item = { system: { price: { value: 100, denomination: "gp" } } };

  const base = computeSellPriceGp(merchant, item);
  assert.equal(base, 50, "sellRatio 0.5 → base sell price is half value");

  assert.equal(
    resolveUnitSellPrice({ merchant, item }),
    roundGp(base),
    "no seal / no passive → base sell ratio price",
  );

  const seal = { deltaPct: -20 };
  // The sell path inverts the delta: a "-20% (price down)" seal RAISES the
  // payout because the seller is on the opposite side of the deal.
  assert.equal(
    resolveUnitSellPrice({ merchant, item, seal }),
    roundGp(applyBargainDelta(base, 20)),
    "the seal sign is flipped for the sell payout",
  );
  assert.equal(
    resolveUnitSellPrice({ merchant, item, seal }),
    60,
    "50 gp + 20% = 60 gp — the seller comes out ahead",
  );
  assert.ok(
    resolveUnitSellPrice({ merchant, item, seal }) > base,
    "the -20% seal raises the sell payout above baseline",
  );
}

process.stdout.write("transaction-pricing validation passed\n");
