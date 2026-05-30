import assert from "node:assert/strict";

import { currencyAddFromBreakdown } from "./loot/hoard-budget.js";
import { normalizeDistributableItems } from "./loot/distribute.js";

/* ------------------------------------------------------------------ *
 * currencyAddFromBreakdown — always five denominations, clamped ints
 * ------------------------------------------------------------------ */
{
  // A hoard breakdown ({pp,gp,sp,cp}) gains ep:0 and otherwise passes through.
  assert.deepEqual(
    currencyAddFromBreakdown({ pp: 1, gp: 1240, sp: 900, cp: 0 }),
    { pp: 1, gp: 1240, ep: 0, sp: 900, cp: 0 },
  );

  // Every key is always present, even from empty / missing input.
  const zero = { pp: 0, gp: 0, ep: 0, sp: 0, cp: 0 };
  assert.deepEqual(currencyAddFromBreakdown(), zero);
  assert.deepEqual(currencyAddFromBreakdown({}), zero);

  // Electrum is honored if a caller ever supplies it.
  assert.equal(currencyAddFromBreakdown({ ep: 7 }).ep, 7);

  // Negatives, NaN, and non-numeric values clamp to 0.
  assert.deepEqual(
    currencyAddFromBreakdown({ pp: -5, gp: NaN, sp: "x", cp: undefined }),
    zero,
  );

  // Fractions floor toward zero.
  assert.equal(currencyAddFromBreakdown({ gp: 12.9 }).gp, 12);
  assert.equal(currencyAddFromBreakdown({ sp: 3.2 }).sp, 3);
}

/* ------------------------------------------------------------------ *
 * normalizeDistributableItems — one uniform shape, quantity preserved
 * ------------------------------------------------------------------ */
{
  // Bare UUID string → quantity defaults to 1.
  assert.deepEqual(normalizeDistributableItems(["Compendium.x.Item.abc"]), [
    { uuid: "Compendium.x.Item.abc", quantity: 1 },
  ]);

  // Whitespace-only / empty strings are dropped.
  assert.deepEqual(normalizeDistributableItems(["", "   "]), []);

  // {uuid, quantity} preserves the rolled stack size — the headline bug fix.
  assert.deepEqual(
    normalizeDistributableItems([{ uuid: "U1", name: "Potion", quantity: 3 }]),
    [{ uuid: "U1", name: "Potion", quantity: 3 }],
  );

  // {item:{uuid}} wrapper resolves the nested uuid; string quantity coerces.
  assert.deepEqual(
    normalizeDistributableItems([
      { item: { uuid: "U2", name: "Rope" }, quantity: "4" },
    ]),
    [{ uuid: "U2", name: "Rope", quantity: 4 }],
  );

  // Inline itemData carries through with its quantity, cloned (not shared).
  const source = { itemData: { name: "Gem", system: { quantity: 1 } }, quantity: 2 };
  const withData = normalizeDistributableItems([source]);
  assert.equal(withData.length, 1);
  assert.equal(withData[0].quantity, 2);
  assert.equal(withData[0].name, "Gem");
  assert.ok(withData[0].itemData, "itemData is preserved");
  assert.notEqual(
    withData[0].itemData,
    source.itemData,
    "itemData is cloned, not the same reference",
  );

  // Invalid quantities default to 1.
  for (const bad of [0, -2, "abc", null]) {
    assert.equal(
      normalizeDistributableItems([{ uuid: "U", quantity: bad }])[0].quantity,
      1,
      `quantity ${JSON.stringify(bad)} defaults to 1`,
    );
  }

  // Junk entries are filtered out entirely.
  assert.deepEqual(
    normalizeDistributableItems([null, undefined, 0, {}, { foo: "bar" }]),
    [],
  );

  // Non-array input is tolerated.
  assert.deepEqual(normalizeDistributableItems(null), []);
  assert.deepEqual(normalizeDistributableItems(undefined), []);
}

process.stdout.write("distribute validation passed\n");
