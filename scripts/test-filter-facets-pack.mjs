import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { computeFilterFacetStats } from "./loot/pack-stats.js";
import { filterCandidates } from "./loot/roller.js";
import { LOOT_TYPES, RARITIES, tierWindow } from "./loot/tag-vocabulary.js";

const items = readFileSync("packs/infinity-dnd5e-items.db", "utf8")
  .split(/\r?\n/)
  .filter(Boolean)
  .map((line) => JSON.parse(line));

const t5Filter = {
  tiers: tierWindow("t5"),
  rarities: [],
  lootTypes: [],
  requireEligible: true,
  minGp: 0,
  maxGp: Infinity,
};
const t5Facets = computeFilterFacetStats(
  items,
  [{ label: "T5", filter: t5Filter }],
  { rarities: RARITIES, lootTypes: LOOT_TYPES },
);

assert.equal(t5Facets.byRarity.common.count, 0);
assert.equal(t5Facets.byRarity.common.available, false);
assert.equal(t5Facets.byRarity.rare.available, false);
assert.equal(t5Facets.byRarity["very-rare"].available, true);
assert.ok(t5Facets.byRarity["very-rare"].count > 0);
assert.equal(t5Facets.byRarity.artifact.count, 0);

for (const rarity of RARITIES) {
  assert.equal(
    t5Facets.byRarity[rarity].count,
    filterCandidates(items, { ...t5Filter, rarities: [rarity] }).length,
    `T5 ${rarity} facet count matches the roller`,
  );
}

const commonT5Facets = computeFilterFacetStats(
  items,
  [
    {
      label: "T5",
      filter: { ...t5Filter, rarities: ["common"] },
    },
  ],
  { rarities: RARITIES, lootTypes: LOOT_TYPES },
);
for (const lootType of LOOT_TYPES) {
  const expected = filterCandidates(items, {
    ...t5Filter,
    rarities: ["common"],
    lootTypes: [lootType],
  }).length;
  assert.equal(
    commonT5Facets.byLootType[lootType].count,
    expected,
    `T5 common ${lootType} facet count matches the roller`,
  );
  assert.equal(expected, 0, `T5 common ${lootType} is unavailable`);
  assert.equal(commonT5Facets.byLootType[lootType].available, false);
}

const rosterFacets = computeFilterFacetStats(
  items,
  [
    {
      label: "T1",
      filter: { ...t5Filter, tiers: tierWindow("t1") },
    },
    {
      label: "T5",
      filter: { ...t5Filter, tiers: tierWindow("t5") },
    },
  ],
  { rarities: RARITIES, lootTypes: LOOT_TYPES },
);
assert.deepEqual(rosterFacets.byRarity.common.unavailableScopes, ["T5"]);
assert.equal(
  rosterFacets.byRarity.rare.available,
  true,
  "rare remains selectable because it serves the T1 roster scope",
);
assert.equal(
  rosterFacets.byRarity.rare.complete,
  false,
  "rare is explicitly partial because it does not serve T5",
);
assert.ok(rosterFacets.byRarity.rare.count > 0);
assert.deepEqual(rosterFacets.byRarity.legendary.unavailableScopes, ["T1"]);

process.stdout.write(
  `filter facet pack validation passed (${items.length} items)\n`,
);
