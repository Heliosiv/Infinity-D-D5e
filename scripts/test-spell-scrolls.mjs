import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { filterCandidates, rollLoot } from "./loot/roller.js";
import { getEncounterBalanceOptions } from "./loot/category-balance.js";
import {
  getItemLootType,
  getItemLootWeight,
  isGenericSpellScrollItem,
  tierWindow,
} from "./loot/tag-vocabulary.js";
import { mulberry32 } from "./test-utils/rng.mjs";

const PACK_PATH = "packs/infinity-dnd5e-items.db";
const GENERATED_SCHEMA = "infinity-dnd5e-spell-scroll-v1";

const items = readFileSync(PACK_PATH, "utf8")
  .split(/\r?\n/)
  .filter((line) => line.trim().length > 0)
  .map((line) => JSON.parse(line));

const sourceSpells = items.filter(
  (item) =>
    item.type === "spell" &&
    item.flags?.["infinity-dnd5e"]?.lootType === "loot.spell" &&
    item.flags?.["infinity-dnd5e"]?.keywords?.includes("source.dnd5e.spells"),
);
const generatedScrolls = items.filter(
  (item) =>
    item.flags?.["infinity-dnd5e"]?.spellScroll?.schema === GENERATED_SCHEMA,
);
const genericScrolls = items.filter(isGenericSpellScrollItem);

assert.equal(
  generatedScrolls.length,
  sourceSpells.length,
  "every bundled spell should have one generated spell scroll",
);
assert.ok(generatedScrolls.length > 300, "expected the full dnd5e spell set");
assert.equal(genericScrolls.length, 10, "expected the generic level scrolls");

const generatedBySourceId = new Map(
  generatedScrolls.map((item) => [
    item.flags["infinity-dnd5e"].spellScroll.sourceSpellId,
    item,
  ]),
);
for (const spell of sourceSpells) {
  assert.ok(
    generatedBySourceId.has(spell._id),
    `missing spell scroll for ${spell.name}`,
  );
}

for (const item of generatedScrolls) {
  const po = item.flags?.["infinity-dnd5e"] ?? {};
  assert.equal(
    item.type,
    "consumable",
    `${item.name} must be an inventory item`,
  );
  assert.equal(
    item.system?.type?.value,
    "scroll",
    `${item.name} must be a scroll`,
  );
  assert.equal(po.lootType, "loot.scroll", `${item.name} must roll as Scroll`);
  assert.ok(
    po.keywords.includes("loot.scroll"),
    `${item.name} missing loot.scroll keyword`,
  );
  assert.ok(
    !po.keywords.includes("loot.spell"),
    `${item.name} should not roll as a bare spell`,
  );
  assert.ok(
    !po.keywords.includes("loot.variable.art"),
    `${item.name} should not receive art-object appraisal variants`,
  );
  assert.equal(po.variableTreasureKind, undefined);
  assert.ok(po.gpValue > 0, `${item.name} missing gp value`);
  assert.ok(
    item.img && !item.img.includes("item-bag.svg"),
    `${item.name} missing scroll art`,
  );
  assert.ok(
    Object.keys(item.system?.activities ?? {}).length > 0,
    `${item.name} should carry cast activity data`,
  );
  for (const activity of Object.values(item.system?.activities ?? {})) {
    assert.ok(
      activity?.consumption?.targets?.some(
        (target) => target.type === "itemUses",
      ),
      `${item.name} activity should consume one scroll use`,
    );
  }
}

for (const item of genericScrolls) {
  const po = item.flags?.["infinity-dnd5e"] ?? {};
  assert.equal(po.lootType, "loot.scroll", `${item.name} should be in Scroll`);
  assert.ok(
    po.keywords.includes("loot.scroll"),
    `${item.name} missing loot.scroll keyword`,
  );
  assert.ok(!po.keywords.includes("loot.variable.art"));
  assert.equal(po.variableTreasureKind, undefined);
  assert.equal(
    po.lootEligible,
    false,
    `${item.name} must remain a non-rollable generation template`,
  );
}

const generatedByLevel = Map.groupBy(
  generatedScrolls,
  (item) => item.flags["infinity-dnd5e"].spellScroll.spellLevel,
);
for (const template of genericScrolls) {
  const level = /Cantrip/i.test(template.name)
    ? 0
    : Number(template.name.match(/Spell Scroll (\d+)/i)?.[1]);
  const specificScrolls = generatedByLevel.get(level) ?? [];
  const distributedWeight = specificScrolls.reduce(
    (sum, item) => sum + getItemLootWeight(item),
    0,
  );
  const templateWeight = getItemLootWeight(template);
  assert.ok(
    Math.abs(distributedWeight - templateWeight) < 1e-9,
    `${template.name} weight must be distributed across its named spells`,
  );
}

const scrollCandidates = filterCandidates(items, {
  lootTypes: ["loot.scroll"],
});
assert.equal(
  scrollCandidates.length,
  generatedScrolls.length,
  "Scroll filter should return only spell-specific scrolls",
);
assert.ok(
  scrollCandidates.some((item) => item.name === "Spell Scroll: Fireball"),
  "Scroll filter should include spell-specific scroll names",
);
assert.equal(
  scrollCandidates.some(isGenericSpellScrollItem),
  false,
  "generic level scroll templates must never enter the loot pool",
);
assert.equal(
  filterCandidates(genericScrolls, {
    lootTypes: ["loot.scroll"],
    requireEligible: false,
  }).length,
  0,
  "generic templates must stay excluded even when eligibility flags are ignored",
);
for (const item of scrollCandidates) {
  const spellScroll = item.flags?.["infinity-dnd5e"]?.spellScroll;
  assert.equal(
    spellScroll?.schema,
    GENERATED_SCHEMA,
    `${item.name} must identify a predetermined spell`,
  );
  assert.ok(spellScroll.sourceSpellId, `${item.name} missing source spell id`);
  assert.ok(
    spellScroll.sourceSpellName,
    `${item.name} missing source spell name`,
  );
}

const defaultEncounterCandidates = filterCandidates(items, {
  tiers: tierWindow("t2"),
  rarities: [],
  requireEligible: true,
});
let scrollBearingEncounters = 0;
let rolledScrolls = 0;
for (let seed = 1; seed <= 1000; seed += 1) {
  const result = rollLoot(defaultEncounterCandidates, {
    count: 0,
    budgetGp: 400,
    magicBias: 0,
    ...getEncounterBalanceOptions({ tier: "t2" }),
    rng: mulberry32(seed),
  });
  const scrollCount = result.items.filter(
    (entry) => getItemLootType(entry.item) === "loot.scroll",
  ).length;
  if (scrollCount > 0) scrollBearingEncounters += 1;
  assert.ok(
    scrollCount <= 1,
    `seed ${seed}: mixed encounter caps scrolls at one`,
  );
  rolledScrolls += scrollCount;
}
assert.ok(
  scrollBearingEncounters > 0,
  "standard encounters should still occasionally produce a spell scroll",
);
assert.ok(
  scrollBearingEncounters <= 150,
  `spell scrolls appeared in ${scrollBearingEncounters}/1000 standard encounters`,
);
assert.ok(
  rolledScrolls <= 150,
  `standard encounters produced ${rolledScrolls} scrolls across 1000 rolls`,
);

process.stdout.write(
  `spell-scroll validation passed (${generatedScrolls.length} generated, ${scrollCandidates.length} candidates, ${scrollBearingEncounters}/1000 standard encounters)\n`,
);
