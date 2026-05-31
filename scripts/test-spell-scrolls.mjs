import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { filterCandidates } from "./loot/roller.js";

const PACK_PATH = "packs/infinity-dnd5e-items.db";
const GENERATED_SCHEMA = "infinity-dnd5e-spell-scroll-v1";

const items = readFileSync(PACK_PATH, "utf8")
  .split(/\r?\n/)
  .filter((line) => line.trim().length > 0)
  .map((line) => JSON.parse(line));

const sourceSpells = items.filter(
  (item) =>
    item.type === "spell" &&
    item.flags?.["party-operations"]?.lootType === "loot.spell" &&
    item.flags?.["party-operations"]?.keywords?.includes("source.dnd5e.spells"),
);
const generatedScrolls = items.filter(
  (item) => item.flags?.["infinity-dnd5e"]?.spellScroll?.schema === GENERATED_SCHEMA,
);
const genericScrolls = items.filter(
  (item) =>
    item.type === "consumable" &&
    item.system?.type?.value === "scroll" &&
    /^Spell Scroll (?:Cantrip|\d+(?:st|nd|rd|th) Level)$/i.test(
      String(item.name ?? ""),
    ),
);

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
  const po = item.flags?.["party-operations"] ?? {};
  assert.equal(item.type, "consumable", `${item.name} must be an inventory item`);
  assert.equal(item.system?.type?.value, "scroll", `${item.name} must be a scroll`);
  assert.equal(po.lootType, "loot.scroll", `${item.name} must roll as Scroll`);
  assert.ok(po.keywords.includes("loot.scroll"), `${item.name} missing loot.scroll keyword`);
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
  assert.ok(item.img && !item.img.includes("item-bag.svg"), `${item.name} missing scroll art`);
  assert.ok(
    Object.keys(item.system?.activities ?? {}).length > 0,
    `${item.name} should carry cast activity data`,
  );
  for (const activity of Object.values(item.system?.activities ?? {})) {
    assert.ok(
      activity?.consumption?.targets?.some((target) => target.type === "itemUses"),
      `${item.name} activity should consume one scroll use`,
    );
  }
}

for (const item of genericScrolls) {
  const po = item.flags?.["party-operations"] ?? {};
  assert.equal(po.lootType, "loot.scroll", `${item.name} should be in Scroll`);
  assert.ok(po.keywords.includes("loot.scroll"), `${item.name} missing loot.scroll keyword`);
  assert.ok(!po.keywords.includes("loot.variable.art"));
  assert.equal(po.variableTreasureKind, undefined);
}

const scrollCandidates = filterCandidates(items, { lootTypes: ["loot.scroll"] });
assert.equal(
  scrollCandidates.length,
  generatedScrolls.length + genericScrolls.length,
  "Scroll filter should return generated and generic scrolls",
);
assert.ok(
  scrollCandidates.some((item) => item.name === "Spell Scroll: Fireball"),
  "Scroll filter should include spell-specific scroll names",
);

process.stdout.write(
  `spell-scroll validation passed (${generatedScrolls.length} generated, ${scrollCandidates.length} scroll candidates)\n`,
);
