import assert from "node:assert/strict";

import {
  computeForageYield,
  combineYields,
  planForageDriveDeposits,
} from "./resource/forage.js";

const ABUNDANT = {
  id: "abundant",
  dc: 10,
  forageable: true,
  yieldFood: "1d6",
  yieldWater: "1d6",
};
const TOWN = {
  id: "town",
  dc: 0,
  forageable: false,
  yieldFood: "0",
  yieldWater: "0",
};

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
    computeForageYield({ rollTotal: 10, dc: 10, foodDie: 1, env: ABUNDANT })
      .success,
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

/* ------------------------------------------------------------------ *
 * planForageDriveDeposits — GM forage drive deposit targeting
 * ------------------------------------------------------------------ */
{
  const roster = [
    { actorId: "A", name: "Aria", isStash: false, drawFromId: "A" },
    { actorId: "B", name: "Brom", isStash: false, drawFromId: "A" },
    { actorId: "S", name: "Mule", isStash: true, drawFromId: "S" },
  ];
  const foraged = [
    { actorId: "A", food: 4, water: 3, success: true },
    { actorId: "B", food: 2, water: 1, success: true },
  ];

  /* Configured party stash → whole haul lands on that one actor. */
  {
    const plan = planForageDriveDeposits({
      roster,
      selectedIds: ["A", "B"],
      foraged,
      partyStashId: "S",
    });
    assert.equal(plan.stashActorId, "S");
    assert.equal(plan.totalFood, 6, "4 + 2 food pooled");
    assert.equal(plan.totalWater, 4, "3 + 1 water pooled");
    assert.deepEqual(plan.deposits, [{ actorId: "S", food: 6, water: 4 }]);
    assert.equal(plan.perForager.length, 2);
    assert.ok(plan.perForager.every((f) => f.attempted && f.success));
  }

  /* No configured stash → falls back to the first roster entry flagged isStash. */
  {
    const plan = planForageDriveDeposits({
      roster,
      selectedIds: ["A", "B"],
      foraged,
      partyStashId: "",
    });
    assert.equal(plan.stashActorId, "S", "first isStash member is the sink");
    assert.deepEqual(plan.deposits, [{ actorId: "S", food: 6, water: 4 }]);
  }

  /* No stash anywhere → each forager's haul goes to their own draw source. */
  {
    const noStash = [
      { actorId: "A", name: "Aria", isStash: false, drawFromId: "A" },
      { actorId: "B", name: "Brom", isStash: false, drawFromId: "A" }, // B draws from A
    ];
    const plan = planForageDriveDeposits({
      roster: noStash,
      selectedIds: ["A", "B"],
      foraged,
    });
    assert.equal(plan.stashActorId, null);
    // A's own haul (4/3) + B's haul routed to its draw source A (2/1) = A gets 6/4.
    assert.deepEqual(plan.deposits, [{ actorId: "A", food: 6, water: 4 }]);
  }

  /* Failed + offline foragers contribute nothing; rows still report them. */
  {
    const plan = planForageDriveDeposits({
      roster,
      selectedIds: ["A", "B"],
      foraged: [
        { actorId: "A", food: 5, water: 2, success: false }, // failed the check
        // B never reported (offline) → not in `foraged`
      ],
      partyStashId: "S",
    });
    assert.equal(plan.totalFood, 0);
    assert.equal(plan.totalWater, 0);
    assert.deepEqual(plan.deposits, [], "nothing to deposit");
    const byId = Object.fromEntries(plan.perForager.map((f) => [f.actorId, f]));
    assert.equal(byId.A.attempted, true);
    assert.equal(byId.A.success, false);
    assert.equal(byId.B.attempted, false, "offline forager wasn't prompted");
  }

  /* Water toggle off → water zeroed, food still deposited. */
  {
    const plan = planForageDriveDeposits({
      roster,
      selectedIds: ["A", "B"],
      foraged,
      partyStashId: "S",
      waterEnabled: false,
    });
    assert.equal(plan.totalWater, 0, "water suppressed");
    assert.equal(plan.totalFood, 6, "food unaffected");
    assert.deepEqual(plan.deposits, [{ actorId: "S", food: 6, water: 0 }]);
  }

  /* A selection not in the roster is ignored (no phantom deposit). */
  {
    const plan = planForageDriveDeposits({
      roster,
      selectedIds: ["A", "ghost"],
      foraged: [{ actorId: "ghost", food: 9, water: 9, success: true }],
      partyStashId: "S",
    });
    assert.equal(plan.totalFood, 0, "untracked selection contributes nothing");
    assert.equal(plan.perForager.length, 1, "only the tracked selection rows");
    assert.equal(plan.perForager[0].actorId, "A");
  }
}

process.stdout.write("resource-forage validation passed\n");
