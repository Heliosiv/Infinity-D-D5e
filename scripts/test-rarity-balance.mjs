import assert from "node:assert/strict";

import {
  RARITY_BALANCE_CUSTOM_KEY,
  RARITY_BALANCE_DEFAULT_KEY,
  getRarityBalancePresetWeights,
  normalizeRarityBalanceKey,
  normalizeRarityWeights,
  rarityBalanceOptions,
  rarityWeightForRarity,
  rarityWeightRows,
  resolveRarityWeights,
} from "./loot/rarity-balance.js";

{
  assert.equal(normalizeRarityBalanceKey(""), RARITY_BALANCE_DEFAULT_KEY);
  assert.equal(normalizeRarityBalanceKey("high-magic"), "highMagic");
  assert.equal(normalizeRarityBalanceKey("highMagic"), "highMagic");
  assert.equal(normalizeRarityBalanceKey("custom"), RARITY_BALANCE_CUSTOM_KEY);
}

{
  const weights = normalizeRarityWeights({
    common: 2,
    veryRare: 3,
    legendary: -1,
    artifact: 999,
  });
  assert.equal(weights.common, 2);
  assert.equal(weights["very-rare"], 3);
  assert.equal(weights.legendary, 0, "weights may suppress a rarity");
  assert.equal(weights.artifact, 10, "weights clamp to the configured max");
  assert.equal(weights.uncommon, 1, "missing rarity falls back to even");
}

{
  const shop = resolveRarityWeights("shop", {
    common: 0,
    artifact: 10,
  });
  assert.deepEqual(
    shop,
    getRarityBalancePresetWeights("shop"),
    "preset balances ignore stale custom values",
  );

  const custom = resolveRarityWeights("custom", {
    common: 0.5,
    rare: 4,
  });
  assert.equal(custom.common, 0.5);
  assert.equal(custom.rare, 4);
}

{
  assert.equal(rarityWeightForRarity("rare", { rare: 2.5 }), 2.5);
  assert.equal(rarityWeightForRarity("veryRare", { "very-rare": 1.5 }), 1.5);
  assert.equal(rarityWeightForRarity("unknown", { rare: 2.5 }), 1);
}

{
  const options = rarityBalanceOptions("shop");
  assert.ok(options.some((option) => option.value === "custom"));
  assert.equal(
    options.find((option) => option.value === "shop").selected,
    true,
  );

  const rows = rarityWeightRows({ rare: 2 });
  assert.equal(rows.find((row) => row.rarity === "rare").weight, "2.00");
  assert.equal(rows.length, 6);
}

process.stdout.write("rarity-balance validation passed\n");
