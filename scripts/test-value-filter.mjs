import assert from "node:assert/strict";

import {
  MARKET_TIERS,
  activeMarketTier,
  clampGp,
  formatValueRange,
  marketTierOptions,
  valueFilterSpec,
} from "./loot/value-filter.js";

/* MARKET_TIERS — ordered low→high, frozen, Vault = no ceiling */
assert.ok(Array.isArray(MARKET_TIERS) && MARKET_TIERS.length >= 4);
assert.equal(MARKET_TIERS[0].key, "general");
assert.equal(MARKET_TIERS.at(-1).key, "vault");
assert.equal(MARKET_TIERS.at(-1).max, 0, "Vault = no ceiling (max 0)");
assert.throws(() => MARKET_TIERS.push({}), "tier list is frozen");

/* clampGp — non-negative integer with fallback */
assert.equal(clampGp(500), 500);
assert.equal(clampGp("250"), 250);
assert.equal(clampGp(12.9), 12, "floors");
assert.equal(clampGp(-5), 0, "negative → fallback");
assert.equal(clampGp("", 7), 0, "blank string coerces to 0 (empty = no limit)");
assert.equal(clampGp(undefined, 3), 3, "undefined → fallback");
assert.equal(clampGp("nope"), 0, "non-numeric → fallback");

/* valueFilterSpec — 0 (or blank) max means no ceiling (Infinity) */
assert.deepEqual(valueFilterSpec({ minItemGp: 0, maxItemGp: 0 }), {
  minGp: 0,
  maxGp: Infinity,
});
assert.deepEqual(valueFilterSpec({ minItemGp: 100, maxItemGp: 500 }), {
  minGp: 100,
  maxGp: 500,
});
assert.deepEqual(valueFilterSpec({ maxItemGp: 200 }), {
  minGp: 0,
  maxGp: 200,
});
assert.deepEqual(valueFilterSpec({}), { minGp: 0, maxGp: Infinity });
assert.deepEqual(valueFilterSpec(), { minGp: 0, maxGp: Infinity });
assert.deepEqual(valueFilterSpec({ minItemGp: -10, maxItemGp: -1 }), {
  minGp: 0,
  maxGp: Infinity,
});

/* activeMarketTier — exact band match, else "" */
assert.equal(activeMarketTier(0, 200), "general");
assert.equal(activeMarketTier(0, 1000), "bazaar");
assert.equal(activeMarketTier(0, 5000), "emporium");
assert.equal(activeMarketTier(0, 0), "vault");
assert.equal(activeMarketTier(0, 333), "", "custom max → no active tier");
assert.equal(activeMarketTier(100, 500), "", "custom min → no preset");

/* formatValueRange */
assert.equal(formatValueRange(0, 0), "Any value");
assert.equal(formatValueRange(0, 500), "≤ 500 gp");
assert.equal(formatValueRange(100, 0), "≥ 100 gp");
assert.equal(formatValueRange(100, 500), "100–500 gp");
assert.equal(
  formatValueRange(5000, 0),
  `≥ ${(5000).toLocaleString()} gp`,
  "thousands separator",
);
assert.equal(
  formatValueRange(800, 200),
  "No items in range",
  "min greater than max is flagged",
);

/* marketTierOptions — flags exactly the matching tier */
{
  const opts = marketTierOptions(0, 1000);
  assert.equal(opts.length, MARKET_TIERS.length);
  assert.equal(opts.find((o) => o.key === "bazaar").active, true);
  assert.equal(opts.filter((o) => o.active).length, 1);

  const custom = marketTierOptions(0, 333);
  assert.equal(
    custom.filter((o) => o.active).length,
    0,
    "a custom range highlights no preset",
  );
}

process.stdout.write("value-filter validation passed\n");
