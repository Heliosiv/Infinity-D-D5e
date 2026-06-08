import assert from "node:assert/strict";

import {
  matchResourceItems,
  planConsumption,
  planDeposit,
} from "./resource/consumption.js";

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
  const tagOnly = { matching: { nameKeywords: [], flagTag: "food", itemUuids: [] } };
  const items = [
    item("k", "Trail Rations"),
    item("f", "Mystery Pack", 1, {
      flags: { "infinity-dnd5e": { resourceTag: "food" } },
    }),
  ];
  const matches = matchResourceItems(items, tagOnly);
  assert.deepEqual(matches.map((m) => m.id), ["f"], "only the tagged item matches");
}

/* ------------------------------------------------------------------ *
 * False-positive guard — "Holy Water" must not match FOOD
 * ------------------------------------------------------------------ */
{
  const items = [item("hw", "Holy Water", 1)];
  assert.equal(matchResourceItems(items, FOOD_DEF).length, 0);
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
