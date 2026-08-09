import assert from "node:assert/strict";
import {
  SPELL_COMPONENT_SOURCE,
  applySpellComponentConsumption,
  availableSpellComponentUnits,
  spellComponentCost,
  spellComponentSourceKind,
} from "./spell-components/service.js";

function sourceItem({
  id,
  name,
  identifier,
  quantity = 1,
  maximum,
  spent = 0,
  autoDestroy = true,
  flag,
}) {
  return {
    id,
    name,
    type: maximum == null ? "loot" : "equipment",
    flags: flag ? { "infinity-dnd5e": { spellComponentSource: flag } } : {},
    system: {
      identifier,
      quantity,
      uses:
        maximum == null
          ? undefined
          : { max: String(maximum), spent, autoDestroy },
    },
  };
}

function spellActivity({ level = 3, items = [], pactLevel = 0 } = {}) {
  const actor = {
    id: "actor-a",
    name: "Aria",
    items,
    system: { spells: { pact: { level: pactLevel } } },
  };
  const item = {
    id: "spell-a",
    name: "Fireball",
    type: "spell",
    actor,
    system: { level },
  };
  return { id: "activity-a", item, actor };
}

function blankUpdates() {
  return { activity: {}, actor: {}, delete: [], item: [], rolls: [] };
}

const pouch = sourceItem({
  id: "pouch-a",
  name: "Component Pouch",
  identifier: "component-pouch",
  maximum: 25,
  spent: 20,
});
const loose = sourceItem({
  id: "loose-a",
  name: "Spell Components",
  identifier: "spell-components",
  quantity: 4,
});

assert.equal(spellComponentSourceKind(pouch), SPELL_COMPONENT_SOURCE.POUCH);
assert.equal(spellComponentSourceKind(loose), SPELL_COMPONENT_SOURCE.LOOSE);
assert.equal(availableSpellComponentUnits(pouch, "pouch"), 5);
assert.equal(availableSpellComponentUnits(loose, "loose"), 4);
assert.equal(
  spellComponentSourceKind(
    sourceItem({
      id: "custom",
      name: "Sorcerer's Satchel",
      maximum: 10,
      flag: SPELL_COMPONENT_SOURCE.POUCH,
    }),
  ),
  SPELL_COMPONENT_SOURCE.POUCH,
  "an explicit module flag supports renamed custom sources",
);

const thirdLevel = spellActivity({ level: 3 });
assert.equal(spellComponentCost(thirdLevel), 3);
assert.equal(spellComponentCost(thirdLevel, { scaling: 2 }), 5);
assert.equal(spellComponentCost(thirdLevel, { spell: { slot: "spell6" } }), 6);
assert.equal(
  spellComponentCost(spellActivity({ level: 1, pactLevel: 4 }), {
    spell: { slot: "pact" },
  }),
  4,
);
assert.equal(spellComponentCost(spellActivity({ level: 0 })), 0);
assert.equal(
  spellComponentCost({ item: { type: "consumable", system: { level: 5 } } }),
  0,
  "spell-scroll and other consumable activities are outside this rule",
);

{
  const updates = blankUpdates();
  const activity = spellActivity({ level: 7, items: [loose, pouch] });
  const result = applySpellComponentConsumption({ activity, updates });
  assert.equal(result.ok, true);
  assert.equal(result.cost, 7);
  assert.equal(result.remaining, 2);
  assert.deepEqual(
    updates.item,
    [{ _id: "loose-a", "system.quantity": 2 }],
    "pouch charges are spent before loose units",
  );
  assert.deepEqual(
    updates.delete,
    ["pouch-a"],
    "an empty auto-destroy pouch is removed",
  );
}

{
  const stackedPouch = sourceItem({
    id: "pouch-stack",
    name: "Component Pouch",
    identifier: "component-pouch",
    maximum: 25,
    quantity: 2,
    spent: 20,
  });
  const updates = blankUpdates();
  const activity = spellActivity({ level: 9, items: [stackedPouch] });
  const result = applySpellComponentConsumption({ activity, updates });
  assert.equal(result.ok, true);
  assert.deepEqual(updates.item, [
    {
      _id: "pouch-stack",
      "system.quantity": 1,
      "system.uses.spent": 4,
    },
  ]);
}

{
  const finalPouch = sourceItem({
    id: "last-pouch",
    name: "Component Pouch",
    identifier: "component-pouch",
    maximum: 3,
  });
  const updates = blankUpdates();
  const activity = spellActivity({ level: 3, items: [finalPouch] });
  const result = applySpellComponentConsumption({ activity, updates });
  assert.equal(result.ok, true);
  assert.deepEqual(updates.delete, ["last-pouch"]);
  assert.deepEqual(updates.item, []);
}

{
  const updates = blankUpdates();
  const activity = spellActivity({ level: 9, items: [loose, pouch] });
  const snapshot = structuredClone(updates);
  const result = applySpellComponentConsumption({ activity, updates });
  assert.equal(result.ok, true, "all nine combined units cover a level 9 cast");
  assert.equal(result.remaining, 0);
  assert.notDeepEqual(updates, snapshot);
}

{
  const updates = blankUpdates();
  const activity = spellActivity({ level: 9, items: [loose] });
  const snapshot = structuredClone(updates);
  const result = applySpellComponentConsumption({ activity, updates });
  assert.equal(result.ok, false);
  assert.equal(result.available, 4);
  assert.equal(result.missing, 5);
  assert.deepEqual(
    updates,
    snapshot,
    "an unaffordable cast does not partially consume inventory",
  );
}

{
  const nativeTarget = sourceItem({
    id: "native-target",
    name: "Spell Components",
    identifier: "spell-components",
    quantity: 5,
  });
  const updates = blankUpdates();
  updates.item.push({
    _id: nativeTarget.id,
    "system.quantity": 4,
    "flags.other.preserved": true,
  });
  const activity = spellActivity({ level: 3, items: [nativeTarget] });
  const result = applySpellComponentConsumption({ activity, updates });
  assert.equal(result.alreadyConsumed, 1);
  assert.deepEqual(updates.item, [
    {
      _id: nativeTarget.id,
      "system.quantity": 2,
      "flags.other.preserved": true,
    },
  ]);
}

process.stdout.write("spell component consumption validation passed\n");
