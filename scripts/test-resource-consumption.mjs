import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  diagnoseResourceConfiguration,
  diagnoseResourceItemOverlaps,
  matchResourceItems,
  planConsumption,
  planDeposit,
} from "./resource/consumption.js";
import { createDefaultResourceConfig } from "./resource/store.js";

const FOOD_DEF = {
  matching: {
    nameKeywords: ["ration", "rations", "food"],
    flagTag: "food",
    itemUuids: ["Compendium.dnd5e.items.Item.rations123"],
  },
};

function item(id, name, qty, extra = {}) {
  return {
    id,
    name,
    type: "consumable",
    system: { quantity: qty },
    flags: {},
    ...extra,
  };
}

/* ------------------------------------------------------------------ *
 * matchResourceItems — priority: uuid > flag > keyword
 * ------------------------------------------------------------------ */
{
  const items = [
    item("k", "Trail Rations"), // keyword
    item("f", "Mystery Pack", 2, {
      flags: { "infinity-dnd5e": { resourceTag: "food" } },
    }), // flag
    item("u", "Iron Rations", 1, {
      _stats: { compendiumSource: "Compendium.dnd5e.items.Item.rations123" },
    }), // uuid (also keyword, but uuid wins)
    item("n", "Longsword"), // no match
  ];
  const matches = matchResourceItems(items, FOOD_DEF);
  const ids = matches.map((m) => m.id);
  assert.deepEqual(ids, ["u", "f", "k"], "uuid → flag → keyword order");
  assert.equal(matches.find((m) => m.id === "u").priority, 3);
  assert.equal(matches.find((m) => m.id === "f").priority, 2);
  assert.equal(matches.find((m) => m.id === "k").priority, 1);
  assert.ok(!ids.includes("n"));
}

/* ------------------------------------------------------------------ *
 * Keyword matching can be disabled per resource (empty nameKeywords)
 * ------------------------------------------------------------------ */
{
  const tagOnly = {
    matching: { nameKeywords: [], flagTag: "food", itemUuids: [] },
  };
  const items = [
    item("k", "Trail Rations"),
    item("f", "Mystery Pack", 1, {
      flags: { "infinity-dnd5e": { resourceTag: "food" } },
    }),
  ];
  const matches = matchResourceItems(items, tagOnly);
  assert.deepEqual(
    matches.map((m) => m.id),
    ["f"],
    "only the tagged item matches",
  );
}

/* ------------------------------------------------------------------ *
 * False-positive guard — "Holy Water" must not match FOOD
 * ------------------------------------------------------------------ */
{
  const items = [item("hw", "Holy Water", 1)];
  assert.equal(matchResourceItems(items, FOOD_DEF).length, 0);
}

/* ------------------------------------------------------------------ *
 * Configuration diagnostics — forage and matcher ambiguity
 * ------------------------------------------------------------------ */
{
  const config = createDefaultResourceConfig();
  const diagnostics = diagnoseResourceConfiguration(config.resources);
  assert.equal(
    diagnostics.ok,
    true,
    "the default food and water matchers must not overlap",
  );

  const food = config.resources.find((resource) => resource.id === "food");
  const water = config.resources.find((resource) => resource.id === "water");
  const waterRation = item("water-ration", "Water Ration", 4);
  assert.equal(
    matchResourceItems([waterRation], food).length,
    0,
    "a Water Ration is not counted as food",
  );
  assert.equal(
    matchResourceItems([waterRation], water).length,
    1,
    "a Water Ration is counted as water",
  );
  for (const name of [
    "Water Rations",
    "Water Rations (1 day)",
    "Fresh Water Rations",
  ]) {
    const stack = item(`water-${name}`, name, 4);
    assert.equal(
      matchResourceItems([stack], food).length,
      0,
      `${name} is explicitly excluded from food`,
    );
    assert.equal(
      matchResourceItems([stack], water).length,
      1,
      `${name} is counted as water`,
    );
  }
  assert.deepEqual(
    matchResourceItems(
      [
        item("standard-rations", "Rations (1 day)", 5),
        item("trail-ration", "Trail Ration", 2),
        item("iron-rations", "Iron Rations", 2),
        item("emergency-ration", "Emergency Ration", 2),
      ],
      food,
    ).map((match) => match.id),
    ["standard-rations", "trail-ration", "iron-rations", "emergency-ration"],
    "the collision fix keeps common food ration names matched",
  );
  for (const name of [
    "Create Food and Water",
    "Purify Food and Drink",
    "Spell Scroll: Purify Food and Drink",
    "Preparations",
    "Decorations",
    "Greater Restoration",
    "Ring of Regeneration",
  ]) {
    assert.equal(
      matchResourceItems([item(`unrelated-${name}`, name, 1)], food).length,
      0,
      `${name} is not consumable food`,
    );
  }
  assert.equal(
    matchResourceItems([item("waterskin", "Waterskin", 1)], water).length,
    0,
    "a reusable Waterskin is not a disposable day-unit",
  );
}

/* ------------------------------------------------------------------ *
 * Pack-grounded default matcher audit — only intended supply Items match
 * ------------------------------------------------------------------ */
{
  const config = createDefaultResourceConfig();
  const food = config.resources.find((resource) => resource.id === "food");
  const water = config.resources.find((resource) => resource.id === "water");
  const packItems = readFileSync(
    new URL("../packs/infinity-dnd5e-items.db", import.meta.url),
    "utf8",
  )
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => JSON.parse(line));
  assert.deepEqual(
    matchResourceItems(packItems, food).map((match) => match.name),
    ["Rations"],
    "food defaults do not claim spells, scrolls, or unrelated pack names",
  );
  assert.deepEqual(
    matchResourceItems(packItems, water).map((match) => match.name),
    [],
    "water defaults do not consume the reusable Waterskin",
  );
}

{
  const diagnostics = diagnoseResourceConfiguration([
    {
      id: "food",
      label: "Food",
      forageYields: "food",
      matching: {
        itemUuids: ["Compendium.test.Item.shared"],
        flagTag: "provisions",
        nameKeywords: ["ration", "trail ration"],
      },
    },
    {
      id: "meals",
      label: "Meals",
      forageYields: "food",
      matching: {
        itemUuids: ["Compendium.test.Item.shared"],
        flagTag: "provisions",
        nameKeywords: ["RATIONS"],
      },
    },
    {
      id: "light",
      label: "Light",
      matching: {
        itemUuids: ["Compendium.test.Item.torch"],
        flagTag: "light",
        nameKeywords: ["torch"],
      },
    },
  ]);

  assert.equal(diagnostics.ok, false);
  assert.deepEqual(
    diagnostics.conflicts.map((entry) => entry.code),
    [
      "duplicate-forage-channel",
      "overlapping-item-uuid",
      "overlapping-flag-tag",
      "overlapping-name-keyword",
    ],
  );
  assert.equal(diagnostics.blockingConflicts.length, 1);
  assert.equal(
    diagnostics.blockingConflicts[0].code,
    "duplicate-forage-channel",
  );
  assert.equal(diagnostics.warningConflicts.length, 3);
  assert.deepEqual(
    diagnostics.conflicts[3].resourceIds,
    ["food", "meals"],
    "keyword comparison is case-insensitive and catches substring overlap",
  );
}

{
  const diagnostics = diagnoseResourceConfiguration([
    {
      id: "food",
      matching: {
        itemUuids: ["same", "same"],
        flagTag: "food",
        nameKeywords: ["ration", "rations", "ration"],
      },
    },
    {
      id: "light",
      matching: {
        itemUuids: ["torch"],
        flagTag: "light",
        nameKeywords: ["torch"],
      },
    },
  ]);
  assert.equal(
    diagnostics.ok,
    true,
    "duplicates inside one resource and unrelated matchers are not conflicts",
  );
}

{
  const diagnostics = diagnoseResourceConfiguration([
    {
      id: "upper",
      matching: {
        itemUuids: ["Compendium.test.Item.Shared"],
        flagTag: "Provisions",
      },
    },
    {
      id: "lower",
      matching: {
        itemUuids: ["Compendium.test.Item.shared"],
        flagTag: "provisions",
      },
    },
  ]);
  assert.equal(
    diagnostics.ok,
    true,
    "UUID and flag matchers preserve runtime case sensitivity",
  );
}

/* ------------------------------------------------------------------ *
 * Live-item diagnostics — one concrete stack cannot back two resources
 * ------------------------------------------------------------------ */
{
  const inventories = [
    {
      actorId: "actor-a",
      actorName: "Aria",
      items: [
        item("shared", "Trail Rations", 0, {
          _stats: { compendiumSource: "Compendium.test.Item.rations" },
        }),
        item("safe", "Torch", 2),
      ],
    },
  ];
  const diagnostics = diagnoseResourceItemOverlaps({
    inventories,
    resources: [
      {
        id: "food",
        label: "Food",
        matching: {
          itemUuids: ["Compendium.test.Item.rations"],
          flagTag: "food",
          nameKeywords: [],
        },
      },
      {
        id: "meals",
        label: "Meals",
        matching: {
          itemUuids: [],
          flagTag: "meals",
          nameKeywords: ["ration"],
        },
      },
      {
        id: "light",
        label: "Light",
        matching: {
          itemUuids: [],
          flagTag: "light",
          nameKeywords: ["torch"],
        },
      },
    ],
  });

  assert.equal(diagnostics.ok, false);
  assert.equal(diagnostics.blockingConflicts.length, 1);
  assert.deepEqual(diagnostics.conflicts[0].resourceIds, ["food", "meals"]);
  assert.equal(diagnostics.conflicts[0].actorId, "actor-a");
  assert.equal(diagnostics.conflicts[0].itemId, "shared");
  assert.match(diagnostics.conflicts[0].message, /Aria's Trail Rations/);
  assert.equal(
    diagnostics.conflicts[0].resources.length,
    2,
    "a zero-quantity stack remains ambiguous because deposits can refill it",
  );
}

{
  const diagnostics = diagnoseResourceItemOverlaps({
    inventories: [
      {
        actorId: "actor-a",
        actorName: "Aria",
        items: [item("same-id", "Rations", 1)],
      },
      {
        actorId: "actor-b",
        actorName: "Borin",
        items: [item("same-id", "Rations", 1)],
      },
    ],
    resources: [
      {
        id: "food",
        matching: { nameKeywords: ["ration"] },
      },
    ],
  });
  assert.equal(
    diagnostics.ok,
    true,
    "the same embedded id on different actors is not an overlap",
  );
}

/* ------------------------------------------------------------------ *
 * planConsumption — drain, cascade, delete-at-zero, shortfall
 * ------------------------------------------------------------------ */
{
  // Single stack, partial decrement.
  const a = planConsumption({ matches: [{ id: "x", quantity: 5 }], amount: 2 });
  assert.deepEqual(a.ops, [{ id: "x", op: "decrement", to: 3 }]);
  assert.equal(a.consumed, 2);
  assert.equal(a.shortfall, 0);

  // Exact stack → delete.
  const b = planConsumption({ matches: [{ id: "x", quantity: 3 }], amount: 3 });
  assert.deepEqual(b.ops, [{ id: "x", op: "delete" }]);
  assert.equal(b.shortfall, 0);

  // Cascade across stacks: delete first, decrement second.
  const c = planConsumption({
    matches: [
      { id: "x", quantity: 2 },
      { id: "y", quantity: 5 },
    ],
    amount: 4,
  });
  assert.deepEqual(c.ops, [
    { id: "x", op: "delete" },
    { id: "y", op: "decrement", to: 3 },
  ]);
  assert.equal(c.consumed, 4);
  assert.equal(c.shortfall, 0);

  // Shortfall when not enough on hand.
  const d = planConsumption({
    matches: [{ id: "x", quantity: 1 }],
    amount: 3,
  });
  assert.deepEqual(d.ops, [{ id: "x", op: "delete" }]);
  assert.equal(d.consumed, 1);
  assert.equal(d.shortfall, 2);

  // Nothing matched → all shortfall, no ops.
  const e = planConsumption({ matches: [], amount: 2 });
  assert.deepEqual(e.ops, []);
  assert.equal(e.shortfall, 2);

  // Zero amount → no-op.
  const f = planConsumption({ matches: [{ id: "x", quantity: 5 }], amount: 0 });
  assert.deepEqual(f.ops, []);
  assert.equal(f.shortfall, 0);
}

/* ------------------------------------------------------------------ *
 * planDeposit — bump vs create vs none
 * ------------------------------------------------------------------ */
{
  const bump = planDeposit({ matches: [{ id: "x", quantity: 4 }], amount: 3 });
  assert.deepEqual(bump, { op: "bump", id: "x", to: 7 });

  const tmpl = { name: "Rations", type: "consumable", system: { quantity: 1 } };
  const create = planDeposit({ matches: [], amount: 5, templateItem: tmpl });
  assert.equal(create.op, "create");
  assert.equal(create.quantity, 5);
  assert.equal(create.from.name, "Rations");

  // No stack and no template → none.
  assert.deepEqual(planDeposit({ matches: [], amount: 5 }), { op: "none" });
  // Zero amount → none.
  assert.deepEqual(
    planDeposit({ matches: [{ id: "x", quantity: 1 }], amount: 0 }),
    { op: "none" },
  );
}

process.stdout.write("resource-consumption validation passed\n");
