import assert from "node:assert/strict";

import { computeForageYield, combineYields } from "./resource/forage.js";

const ABUNDANT = { id: "abundant", dc: 10, forageable: true, yieldFood: "1d6", yieldWater: "1d6" };
const TOWN = { id: "town", dc: 0, forageable: false, yieldFood: "0", yieldWater: "0" };

/* ------------------------------------------------------------------ *
 * computeForageYield — success / failure by margin
 * ------------------------------------------------------------------ */
{
  // Success: roll 15 vs DC 10, +2 Wis, food die 4, water die 3.
  const ok = computeForageYield({
    rollTotal: 15,
    dc: 10,
    wisMod: 2,
    foodDie: 4,
    waterDie: 3,
    env: ABUNDANT,
  });
  assert.equal(ok.success, true);
  assert.equal(ok.food, 6); // 4 + 2
  assert.equal(ok.water, 5); // 3 + 2
  assert.equal(ok.margin, 5);

  // Exactly meeting the DC succeeds.
  assert.equal(
    computeForageYield({ rollTotal: 10, dc: 10, foodDie: 1, env: ABUNDANT }).success,
    true,
  );

  // Failure: below DC → no yield.
  const fail = computeForageYield({
    rollTotal: 8,
    dc: 10,
    wisMod: 3,
    foodDie: 6,
    waterDie: 6,
    env: ABUNDANT,
  });
  assert.equal(fail.success, false);
  assert.equal(fail.food, 0);
  assert.equal(fail.water, 0);
}

/* ------------------------------------------------------------------ *
 * Negative net yield clamps to 0 (low die, negative Wis)
 * ------------------------------------------------------------------ */
{
  const y = computeForageYield({
    rollTotal: 20,
    dc: 10,
    wisMod: -3,
    foodDie: 1,
    waterDie: 1,
    env: ABUNDANT,
  });
  assert.equal(y.success, true);
  assert.equal(y.food, 0, "1 + (-3) clamps to 0, not negative");
  assert.equal(y.water, 0);
}

/* ------------------------------------------------------------------ *
 * Water suppressed by waterEnabled / env yieldWater 0
 * ------------------------------------------------------------------ */
{
  const noWater = computeForageYield({
    rollTotal: 20,
    dc: 10,
    wisMod: 2,
    foodDie: 4,
    waterDie: 4,
    env: ABUNDANT,
    waterEnabled: false,
  });
  assert.equal(noWater.food, 6);
  assert.equal(noWater.water, 0, "global water toggle off");

  const dryEnv = computeForageYield({
    rollTotal: 20,
    dc: 10,
    wisMod: 2,
    foodDie: 4,
    waterDie: 4,
    env: { ...ABUNDANT, yieldWater: "0" },
  });
  assert.equal(dryEnv.water, 0, "env yields no water");
}

/* ------------------------------------------------------------------ *
 * Non-forageable environment never succeeds
 * ------------------------------------------------------------------ */
{
  const inTown = computeForageYield({
    rollTotal: 99,
    dc: 0,
    wisMod: 5,
    foodDie: 6,
    env: TOWN,
  });
  assert.equal(inTown.success, false);
  assert.equal(inTown.food, 0);
}

/* ------------------------------------------------------------------ *
 * combineYields — each vs best
 * ------------------------------------------------------------------ */
{
  const perForager = [
    { actorId: "a", name: "A", food: 3, water: 2, success: true },
    { actorId: "b", name: "B", food: 6, water: 5, success: true },
    { actorId: "c", name: "C", food: 0, water: 0, success: false },
  ];

  // each: unchanged.
  const each = combineYields(perForager, "each");
  assert.equal(each.length, 3);
  assert.equal(each[0].food, 3);
  assert.equal(each[1].food, 6);

  // best: only the largest haul (B) keeps its yield.
  const best = combineYields(perForager, "best");
  assert.equal(best.find((e) => e.actorId === "b").food, 6);
  assert.equal(best.find((e) => e.actorId === "a").food, 0);
  assert.equal(best.find((e) => e.actorId === "a").suppressed, true);
  assert.equal(best.find((e) => e.actorId === "c").food, 0);

  // best with zero successes → everyone unchanged (all zero anyway).
  const noneSucceed = combineYields(
    [{ actorId: "a", food: 0, water: 0, success: false }],
    "best",
  );
  assert.equal(noneSucceed[0].food, 0);
}

process.stdout.write("resource-forage validation passed\n");
