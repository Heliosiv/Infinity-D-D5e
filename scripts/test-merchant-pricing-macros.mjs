import assert from "node:assert/strict";

import {
  applyMerchantPricingPatch,
  merchantPricingMacroSignature,
  normalizeMerchantPricingPatch,
  planMerchantPricingMacro,
  resolveMerchantPricingTargets,
} from "./merchant/pricing-macros.js";
import { normalizeMerchant } from "./merchant/store.js";

const merchants = [
  normalizeMerchant({
    id: "smith",
    name: "The Iron Rest",
    defaultMarkup: 1.1,
    sellRatio: 0.4,
    bargainDC: 14,
    shop: { locationId: "haven" },
    items: [
      { uuid: "Item.sword", qty: 2, priceOverrideGp: 75 },
      { uuid: "Item.shield", qty: 1 },
    ],
  }),
  normalizeMerchant({
    id: "curios",
    name: "Yannick's Curios",
    defaultMarkup: 1.3,
    sellRatio: 0.5,
    bargainDC: 16,
    shop: { locationId: "haven" },
  }),
  normalizeMerchant({
    id: "docks",
    name: "Dockside Goods",
    defaultMarkup: 1.4,
    sellRatio: 0.35,
    shop: { locationId: "docks" },
  }),
];

const locations = [
  { id: "haven", name: "Haven" },
  { id: "docks", name: "Docks" },
];

assert.deepEqual(
  resolveMerchantPricingTargets(
    { locationId: "haven" },
    { merchants, locations },
  ),
  ["smith", "curios"],
  "a city selects every shop assigned to that canonical location",
);
assert.deepEqual(
  resolveMerchantPricingTargets(
    { merchantIds: ["curios"] },
    { merchants, locations },
  ),
  ["curios"],
  "an explicit merchant selection supports one-at-a-time overrides",
);
assert.throws(
  () =>
    resolveMerchantPricingTargets(
      { locationId: "missing" },
      { merchants, locations },
    ),
  /LocationNotFound: missing/,
  "an unknown location cannot silently fall back to all merchants",
);

const patch = normalizeMerchantPricingPatch({
  defaultMarkup: 1.25,
  sellRatio: 0.45,
  bargainDC: 15,
  bargainSuccessPct: 12,
  bargainFailPct: 8,
  passiveHaggle: false,
  passivePctPerPoint: 1.5,
  passiveCapPct: 15,
  clearItemPriceOverrides: true,
});
const plan = planMerchantPricingMacro(merchants, {
  merchantIds: ["smith", "curios"],
  patch,
});
assert.equal(plan.targetedCount, 2);
assert.equal(plan.changedCount, 2);
assert.equal(plan.merchants[2].defaultMarkup, 1.4);
assert.equal(
  plan.merchants[0].items[0].priceOverrideGp,
  null,
  "clearing item overrides makes the shared city multiplier effective",
);
assert.equal(merchants[0].items[0].priceOverrideGp, 75, "planning is pure");
assert.match(plan.changes[0].summary, /Buy price 1\.10× → 1\.25×/);
assert.match(plan.changes[0].summary, /1 item price override cleared/);

const individual = applyMerchantPricingPatch(merchants[2], {
  defaultMarkup: 1.05,
});
assert.equal(individual.defaultMarkup, 1.05);
assert.equal(individual.sellRatio, 0.35, "unspecified rules are preserved");

assert.throws(
  () => normalizeMerchantPricingPatch({ defaultMarkup: 0 }),
  /defaultMarkup must be/,
);
assert.throws(
  () => normalizeMerchantPricingPatch({ bargainDC: 12.5 }),
  /whole number/,
);
assert.throws(
  () => normalizeMerchantPricingPatch({}),
  /Choose at least one pricing rule/,
);

assert.equal(
  merchantPricingMacroSignature({
    merchantIds: ["curios", "smith", "curios"],
    patch: { sellRatio: 0.45, defaultMarkup: 1.25 },
  }),
  merchantPricingMacroSignature({
    merchantIds: ["smith", "curios"],
    patch: { defaultMarkup: 1.25, sellRatio: 0.45 },
  }),
  "preview signatures ignore target ordering and duplicate ids",
);

process.stdout.write(
  "merchant city pricing groups, individual overrides, validation, and preview signatures passed\n",
);
