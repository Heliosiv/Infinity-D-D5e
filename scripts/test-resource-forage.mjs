import assert from "node:assert/strict";

import {
  buildForageAcknowledgement,
  computeForageYield,
  combineYields,
  forageTargetChannels,
  FORAGE_TARGETS,
  normalizeForageTarget,
  planForageDriveDeposits,
} from "./resource/forage.js";
import {
  owningOnlineUserId,
  resolveForageRollTargets,
  resolveForageTimeoutMs,
  resolveExpectedForageActorId,
  validateForageResultPayload,
} from "./resource/calendar-watcher.js";
import { RESOURCE_EVENTS } from "./resource/socket.js";

const ABUNDANT = {
  id: "abundant",
  dc: 10,
  forageable: true,
  yieldFood: "1d6",
  yieldWater: "1d6",
};

/* ------------------------------------------------------------------ *
 * Offline Forage Drive routing.
 * ------------------------------------------------------------------ */
{
  const party = [
    { id: "online", onlineUserId: "player-a" },
    { id: "offline", onlineUserId: null },
  ];
  const resolveOnlineUserId = (actor) => actor.onlineUserId;
  assert.deepEqual(
    resolveForageRollTargets(party, { resolveOnlineUserId }).map((target) => ({
      actorId: target.actor.id,
      userId: target.userId,
      gmRoll: target.gmRoll,
    })),
    [{ actorId: "online", userId: "player-a", gmRoll: false }],
    "automatic upkeep keeps its online-player-only behavior",
  );
  assert.deepEqual(
    resolveForageRollTargets(party, {
      allowGmRolls: true,
      resolveOnlineUserId,
    }).map((target) => ({
      actorId: target.actor.id,
      userId: target.userId,
      gmRoll: target.gmRoll,
    })),
    [
      { actorId: "online", userId: "player-a", gmRoll: false },
      { actorId: "offline", userId: null, gmRoll: true },
    ],
    "Forage Drive routes offline characters to the active GM",
  );
}
const TOWN = {
  id: "town",
  dc: 0,
  forageable: false,
  yieldFood: "0",
  yieldWater: "0",
};

/* ------------------------------------------------------------------ *
 * Forage drive resource targeting.
 * ------------------------------------------------------------------ */
{
  assert.deepEqual(forageTargetChannels(FORAGE_TARGETS.BOTH), {
    target: "food-water",
    food: true,
    water: true,
  });
  assert.deepEqual(forageTargetChannels(FORAGE_TARGETS.FOOD), {
    target: "food",
    food: true,
    water: false,
  });
  assert.deepEqual(forageTargetChannels(FORAGE_TARGETS.WATER), {
    target: "water",
    food: false,
    water: true,
  });
  assert.equal(
    normalizeForageTarget("unexpected"),
    FORAGE_TARGETS.BOTH,
    "unknown API input keeps the backward-compatible combined target",
  );
}

/* ------------------------------------------------------------------ *
 * Forage response timeout normalization.
 * ------------------------------------------------------------------ */
{
  assert.equal(resolveForageTimeoutMs(undefined), 120_000);
  assert.equal(resolveForageTimeoutMs("30"), 30_000);
  assert.equal(
    resolveForageTimeoutMs(0),
    0,
    "an explicit zero-second timeout is not replaced by the default",
  );
  assert.equal(resolveForageTimeoutMs(-5), 0);
  assert.equal(resolveForageTimeoutMs("invalid"), 120_000);
}

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

  const waterOnly = computeForageYield({
    rollTotal: 20,
    dc: 10,
    wisMod: 2,
    foodDie: 4,
    waterDie: 4,
    env: ABUNDANT,
    foodEnabled: false,
  });
  assert.equal(waterOnly.food, 0, "water-only math suppresses food");
  assert.equal(waterOnly.water, 6);

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
 * buildForageAcknowledgement — player result preserves "best" suppression
 * ------------------------------------------------------------------ */
{
  const acknowledgement = buildForageAcknowledgement({
    runId: "qm-test",
    actorId: "A",
    targetUserId: "player-1",
    noResponse: true,
    entry: {
      food: 0,
      water: 0,
      success: true,
      suppressed: true,
    },
  });
  assert.deepEqual(acknowledgement, {
    runId: "qm-test",
    actorId: "A",
    food: 0,
    water: 0,
    success: true,
    suppressed: true,
    noResponse: true,
    targetUserId: "player-1",
  });
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

  /* No configured party stash → keep each forager's resolved draw source.
     Merely flagging an inventory actor as a per-member stash must not turn it
     into the forage drive's global destination. */
  {
    const plan = planForageDriveDeposits({
      roster,
      selectedIds: ["A", "B"],
      foraged,
      partyStashId: "",
    });
    assert.equal(plan.stashActorId, null);
    assert.deepEqual(
      plan.deposits,
      [{ actorId: "A", food: 6, water: 4 }],
      "A keeps its haul and B deposits into its nominated source A",
    );
  }

  /* Distinct per-member stashes remain distinct during a forage-only drive. */
  {
    const perMemberStashes = [
      {
        actorId: "A",
        name: "Aria",
        consumes: true,
        isStash: false,
        drawFromId: "S1",
      },
      {
        actorId: "B",
        name: "Brom",
        consumes: true,
        isStash: false,
        drawFromId: "S2",
      },
      {
        actorId: "S1",
        name: "Cart",
        consumes: false,
        isStash: true,
        drawFromId: "S1",
      },
      {
        actorId: "S2",
        name: "Mule",
        consumes: false,
        isStash: true,
        drawFromId: "S2",
      },
    ];
    const plan = planForageDriveDeposits({
      roster: perMemberStashes,
      selectedIds: ["A", "B"],
      foraged,
      partyStashId: "",
    });
    assert.equal(
      plan.stashActorId,
      null,
      "only an explicit party stash creates one global sink",
    );
    assert.deepEqual(plan.deposits, [
      { actorId: "S1", food: 4, water: 3 },
      { actorId: "S2", food: 2, water: 1 },
    ]);
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

  /* "best" mode: a suppressed (losing) forager is flagged so the report can show
     them neutrally rather than as a green "+0" success, and contributes nothing. */
  {
    const plan = planForageDriveDeposits({
      roster,
      selectedIds: ["A", "B"],
      foraged: [
        { actorId: "A", food: 6, water: 4, success: true },
        { actorId: "B", food: 0, water: 0, success: true, suppressed: true },
      ],
      partyStashId: "S",
    });
    const byId = Object.fromEntries(plan.perForager.map((f) => [f.actorId, f]));
    assert.equal(byId.B.suppressed, true, "losing forager flagged suppressed");
    assert.equal(byId.A.suppressed, false, "winner is not suppressed");
    assert.equal(plan.totalFood, 6, "only the winner's haul counts");
    assert.deepEqual(plan.deposits, [{ actorId: "S", food: 6, water: 4 }]);
  }

  /* Water-only drive → food zeroed, water still deposited. */
  {
    const plan = planForageDriveDeposits({
      roster,
      selectedIds: ["A", "B"],
      foraged,
      partyStashId: "S",
      foodEnabled: false,
    });
    assert.equal(plan.totalFood, 0, "food suppressed");
    assert.equal(plan.totalWater, 4, "water unaffected");
    assert.deepEqual(plan.deposits, [{ actorId: "S", food: 0, water: 4 }]);
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

/* ------------------------------------------------------------------ *
 * Socket responses stay bound to the user/actor pair originally prompted.
 * ------------------------------------------------------------------ */
{
  const run = {
    expected: new Set(["actor-a", "actor-b", "actor-c"]),
    expectedByUser: new Map([
      ["player-a", ["actor-a"]],
      ["player-b", ["actor-b", "actor-c"]],
    ]),
    results: new Map([["actor-c", { rollTotal: 12 }]]),
  };
  assert.equal(
    resolveExpectedForageActorId(run, {
      originUserId: "player-a",
      actorId: "actor-b",
    }),
    null,
    "a mismatched actor claim is rejected even with one pending prompt",
  );
  assert.equal(
    resolveExpectedForageActorId(run, {
      originUserId: "player-b",
      actorId: "actor-b",
    }),
    "actor-b",
  );
  assert.equal(
    resolveExpectedForageActorId(run, {
      originUserId: "player-b",
      actorId: "actor-c",
    }),
    null,
    "a duplicate result cannot overwrite an already accepted actor",
  );
  assert.equal(
    resolveExpectedForageActorId(run, {
      originUserId: "unprompted-owner",
      actorId: "actor-a",
    }),
    null,
    "shared ownership is insufficient without an issued prompt",
  );
}

/* ------------------------------------------------------------------ *
 * Forage prompts use assigned characters or direct player ownership only.
 * ------------------------------------------------------------------ */
{
  const savedGame = globalThis.game;
  const savedConst = globalThis.CONST;
  try {
    globalThis.CONST = {
      ...(savedConst ?? {}),
      DOCUMENT_OWNERSHIP_LEVELS: {
        ...(savedConst?.DOCUMENT_OWNERSHIP_LEVELS ?? {}),
        OWNER: 3,
      },
    };
    const drivingGm = {
      id: "gm-driving",
      isGM: true,
      active: true,
      character: { id: "actor-driving" },
    };
    const assistant = {
      id: "assistant-a",
      isGM: true,
      active: true,
      character: { id: "actor-assigned" },
    };
    const player = {
      id: "player-a",
      isGM: false,
      active: true,
      character: null,
    };
    globalThis.game = {
      user: drivingGm,
      users: [drivingGm, assistant, player],
    };

    assert.equal(
      owningOnlineUserId({
        id: "actor-assigned",
        ownership: {},
        testUserPermission: () => true,
      }),
      "assistant-a",
      "an Assistant GM may forage as their explicitly assigned character",
    );
    assert.equal(
      owningOnlineUserId({
        id: "actor-player-owned",
        ownership: { "player-a": 3 },
        testUserPermission: () => true,
      }),
      "player-a",
      "a regular user's direct OWNER grant is eligible",
    );
    assert.equal(
      owningOnlineUserId({
        id: "actor-default-owned",
        ownership: { default: 3 },
      }),
      "player-a",
      "a regular user may inherit a direct default OWNER grant",
    );
    assert.equal(
      owningOnlineUserId({
        id: "actor-unassigned",
        ownership: {},
        testUserPermission: () => true,
      }),
      null,
      "an unassigned Assistant GM is not selected through role bypass",
    );
    assert.equal(
      owningOnlineUserId({
        id: "actor-driving",
        ownership: { "gm-driving": 3 },
      }),
      null,
      "the local GM driving the upkeep never receives a forage prompt",
    );
  } finally {
    if (savedGame === undefined) delete globalThis.game;
    else globalThis.game = savedGame;
    if (savedConst === undefined) delete globalThis.CONST;
    else globalThis.CONST = savedConst;
  }
}

/* A direct handler invocation still receives strict socket-shape validation. */
{
  const valid = {
    type: RESOURCE_EVENTS.FORAGE_RESULT,
    originUserId: "player-a",
    runId: "run-a",
    actorId: "actor-a",
    skipped: false,
    rollTotal: 18,
  };
  assert.equal(validateForageResultPayload(valid).ok, true);
  assert.equal(
    validateForageResultPayload({ ...valid, rollTotal: Number.NaN }).ok,
    false,
  );
  assert.equal(
    validateForageResultPayload({ ...valid, rollTotal: 1000 }).ok,
    false,
  );
}

/* The player prompt mirrors the same direct-ownership rule for legacy prompts. */
{
  const savedFoundry = globalThis.foundry;
  const savedGame = globalThis.game;
  const savedConst = globalThis.CONST;
  try {
    globalThis.foundry = {
      applications: {
        api: {
          ApplicationV2: class {},
          HandlebarsApplicationMixin: (Base) => class extends Base {},
        },
      },
    };
    globalThis.CONST = {
      ...(savedConst ?? {}),
      DOCUMENT_OWNERSHIP_LEVELS: {
        ...(savedConst?.DOCUMENT_OWNERSHIP_LEVELS ?? {}),
        OWNER: 3,
      },
    };
    const owned = {
      id: "actor-owned",
      type: "character",
      ownership: { "player-a": 3 },
      testUserPermission: () => true,
    };
    const actors = [owned];
    actors.get = (id) => actors.find((actor) => actor.id === id) ?? null;
    const { resolvePlayerActor } = await import("./forage-prompt.js");

    globalThis.game = {
      user: {
        id: "assistant-a",
        isGM: true,
        character: null,
      },
      actors,
    };
    assert.equal(
      resolvePlayerActor(),
      null,
      "an unassigned Assistant cannot inherit a character through GM access",
    );

    globalThis.game.user = {
      id: "assistant-a",
      isGM: true,
      character: owned,
    };
    assert.equal(
      resolvePlayerActor(),
      owned,
      "an Assistant's explicitly assigned character remains valid",
    );

    globalThis.game.user = {
      id: "player-a",
      isGM: false,
      character: null,
    };
    assert.equal(
      resolvePlayerActor(),
      owned,
      "a regular player resolves an actor through direct OWNER state",
    );
  } finally {
    if (savedFoundry === undefined) delete globalThis.foundry;
    else globalThis.foundry = savedFoundry;
    if (savedGame === undefined) delete globalThis.game;
    else globalThis.game = savedGame;
    if (savedConst === undefined) delete globalThis.CONST;
    else globalThis.CONST = savedConst;
  }
}

process.stdout.write("resource-forage validation passed\n");
