import assert from "node:assert/strict";

import {
  buildFenceBundleTargetId,
  DOWNTIME_ACTIVITY_IDS,
} from "./downtime/catalog.js";
import {
  buildDowntimeOperationId,
  normalizeDowntimeQueue,
  resolveDowntimeQueue,
  validateDowntimeQueue,
} from "./downtime/planner.js";

const settlement = {
  id: "brass-briar",
  name: "Brass & Briar",
  wealthTier: "modest",
  securityTier: "standard",
  marketDc: 13,
  linkedFactionId: "dock-guild",
  linkedMerchantIds: ["merchant-a"],
};

function action(id, activityId, hours, extra = {}) {
  return { id, activityId, hours, ...extra };
}

function errorCodes(result) {
  return result.errors.map((error) => error.code);
}

/* Normalization strips forged authority fields and canonicalizes skills. */
{
  const [normalized] = normalizeDowntimeQueue([
    {
      id: "trade-1",
      activityId: "MARKET-TRADING",
      hours: "4",
      skill: "per",
      stake: "1000",
      target: "ignored-target",
      dc: 1,
      roll: 20,
      rewardCp: 999_999,
      modifier: 50,
    },
  ]);
  assert.deepEqual(normalized, {
    id: "trade-1",
    activityId: "market-trading",
    hours: 4,
    skill: "persuasion",
    stakeCp: 1_000,
    targetId: "ignored-target",
    targetType: "",
  });
  assert.equal("dc" in normalized, false);
  assert.equal("roll" in normalized, false);
  assert.equal("rewardCp" in normalized, false);

  const [bundle] = normalizeDowntimeQueue([
    {
      id: "fence-1",
      activityId: DOWNTIME_ACTIVITY_IDS.FENCE_STOLEN_GOODS,
      hours: 4,
      skill: "deception",
      targetIds: ["stolen-b", "stolen-a", "stolen-b"],
      targetId: "forged-bundle",
    },
  ]);
  assert.deepEqual(bundle.targetIds, ["stolen-a", "stolen-b"]);
  assert.equal(
    bundle.targetId,
    buildFenceBundleTargetId(["stolen-b", "stolen-a"]),
  );
  assert.notEqual(bundle.targetId, "forged-bundle");
}

/* A character may use several actions and leave personal time unused. */
{
  const result = validateDowntimeQueue(
    [
      action("ammo", DOWNTIME_ACTIVITY_IDS.CRAFT_AMMUNITION, 4, {
        targetId: "arrow",
      }),
      action("sharpen", DOWNTIME_ACTIVITY_IDS.SHARPEN_WEAPON, 1, {
        targetId: "weapon-1",
      }),
      action("trade", DOWNTIME_ACTIVITY_IDS.MARKET_TRADING, 4, {
        skill: "deception",
        stakeCp: 2_500,
      }),
    ],
    { budgetHours: 12, settlement },
  );
  assert.equal(result.ok, true);
  assert.equal(result.usedHours, 9);
  assert.equal(result.remainingHours, 3);
  assert.equal(result.stats.actionCount, 3);
}

/* Exact durations, total budget, and enabled activities are authoritative. */
{
  const wrongDuration = validateDowntimeQueue(
    [
      action("pick", DOWNTIME_ACTIVITY_IDS.PICKPOCKET, 3, {
        targetId: "mark-a",
      }),
    ],
    { budgetHours: 8, settlement },
  );
  assert.ok(errorCodes(wrongDuration).includes("invalid-hours"));

  const overBudget = validateDowntimeQueue(
    [
      action("ammo-a", DOWNTIME_ACTIVITY_IDS.CRAFT_AMMUNITION, 4, {
        targetId: "arrow",
      }),
      action("ammo-b", DOWNTIME_ACTIVITY_IDS.CRAFT_AMMUNITION, 4, {
        targetId: "bolt",
      }),
      action("sharpen", DOWNTIME_ACTIVITY_IDS.SHARPEN_WEAPON, 1, {
        targetId: "weapon-1",
      }),
    ],
    { budgetHours: 8, settlement },
  );
  assert.ok(errorCodes(overBudget).includes("hours-over-budget"));

  const disabled = validateDowntimeQueue(
    [
      action("shop", DOWNTIME_ACTIVITY_IDS.SHOPLIFT, 4, {
        targetId: "merchant-a:row-1",
      }),
    ],
    {
      budgetHours: 8,
      settlement: {
        ...settlement,
        enabledActivityIds: [DOWNTIME_ACTIVITY_IDS.LAY_LOW],
      },
    },
  );
  assert.ok(errorCodes(disabled).includes("activity-disabled"));

  const awayFromSettlement = {
    ...settlement,
    id: "downtime-away-from-settlement",
    name: "Pinewood camp",
    hasSettlement: false,
  };
  const routine = validateDowntimeQueue(
    [
      action("sharpen", DOWNTIME_ACTIVITY_IDS.SHARPEN_WEAPON, 1, {
        targetId: "weapon-1",
      }),
    ],
    { budgetHours: 8, settlement: awayFromSettlement },
  );
  assert.equal(routine.ok, true, "routine work is legal away from settlements");
  const cityAction = validateDowntimeQueue(
    [
      action("trade", DOWNTIME_ACTIVITY_IDS.MARKET_TRADING, 2, {
        skill: "persuasion",
        stakeCp: 100,
      }),
    ],
    { budgetHours: 8, settlement: awayFromSettlement },
  );
  assert.ok(errorCodes(cityAction).includes("settlement-required"));
}

/* Commerce and crime repeat limits reject abusive queues. */
{
  const duplicateCommerce = validateDowntimeQueue(
    [
      action("trade-a", DOWNTIME_ACTIVITY_IDS.MARKET_TRADING, 2, {
        skill: "persuasion",
        stakeCp: 100,
      }),
      action("trade-b", DOWNTIME_ACTIVITY_IDS.MARKET_TRADING, 2, {
        skill: "deception",
        stakeCp: 100,
      }),
    ],
    { budgetHours: 8, settlement },
  );
  assert.ok(errorCodes(duplicateCommerce).includes("activity-repeat-limit"));

  const repeatedTarget = validateDowntimeQueue(
    [
      action("pick-a", DOWNTIME_ACTIVITY_IDS.PICKPOCKET, 2, {
        targetId: "mark-a",
      }),
      action("pick-b", DOWNTIME_ACTIVITY_IDS.PICKPOCKET, 2, {
        targetId: "mark-a",
      }),
    ],
    { budgetHours: 8, settlement },
  );
  assert.ok(errorCodes(repeatedTarget).includes("duplicate-crime-target"));

  const fourCrimes = validateDowntimeQueue(
    [
      action("pick-a", DOWNTIME_ACTIVITY_IDS.PICKPOCKET, 2, {
        targetId: "mark-a",
      }),
      action("pick-b", DOWNTIME_ACTIVITY_IDS.PICKPOCKET, 2, {
        targetId: "mark-b",
      }),
      action("shop", DOWNTIME_ACTIVITY_IDS.SHOPLIFT, 4, {
        targetId: "merchant-a:row-1",
      }),
      action("fence", DOWNTIME_ACTIVITY_IDS.FENCE_STOLEN_GOODS, 2, {
        skill: "deception",
        targetId: "bundle-a",
      }),
    ],
    {
      budgetHours: 12,
      settlement,
      targetFacts: { "bundle-a": { valueCp: 500 } },
    },
  );
  assert.ok(errorCodes(fourCrimes).includes("crime-attempt-limit"));
}

/* Heat 5 blocks crime until a queued Lay Low is resolved first. */
{
  const blocked = validateDowntimeQueue(
    [
      action("pick", DOWNTIME_ACTIVITY_IDS.PICKPOCKET, 2, {
        targetId: "mark-a",
      }),
    ],
    { budgetHours: 8, settlement, startingHeat: 5 },
  );
  assert.ok(errorCodes(blocked).includes("heat-max"));

  const unblocked = validateDowntimeQueue(
    [
      action("lay-low", DOWNTIME_ACTIVITY_IDS.LAY_LOW, 4),
      action("pick", DOWNTIME_ACTIVITY_IDS.PICKPOCKET, 2, {
        targetId: "mark-a",
      }),
    ],
    { budgetHours: 8, settlement, startingHeat: 5 },
  );
  assert.equal(unblocked.ok, true);
  assert.equal(unblocked.minimumProjectedHeat, 4);
}

/* Stakes, fencing capacity, targets, skills, and sharpening are bounded. */
{
  const maximumStakeAtMinimumDuration = validateDowntimeQueue(
    [
      action("trade-cap", DOWNTIME_ACTIVITY_IDS.MARKET_TRADING, 2, {
        skill: "persuasion",
        stakeCp: 5_000,
      }),
    ],
    { budgetHours: 2, settlement },
  );
  assert.equal(maximumStakeAtMinimumDuration.ok, true);

  const invalid = validateDowntimeQueue(
    [
      action("trade", DOWNTIME_ACTIVITY_IDS.MARKET_TRADING, 2, {
        skill: "arcana",
        stakeCp: 5_001,
      }),
      action("pick", DOWNTIME_ACTIVITY_IDS.PICKPOCKET, 2, {
        skill: "deception",
        targetId: "forged-mark",
      }),
      action("fence", DOWNTIME_ACTIVITY_IDS.FENCE_STOLEN_GOODS, 2, {
        skill: "persuasion",
        targetId: "bundle-too-large",
      }),
      action("sharpen-a", DOWNTIME_ACTIVITY_IDS.SHARPEN_WEAPON, 1, {
        targetId: "weapon-1",
      }),
      action("sharpen-b", DOWNTIME_ACTIVITY_IDS.SHARPEN_WEAPON, 1, {
        targetId: "weapon-1",
      }),
    ],
    {
      budgetHours: 12,
      settlement,
      pickpocketOpportunityIds: ["mark-real"],
      existingSharpenedWeaponIds: ["weapon-1"],
      targetFacts: { "bundle-too-large": { valueCp: 2_501 } },
    },
  );
  const codes = errorCodes(invalid);
  assert.ok(codes.includes("invalid-skill"));
  assert.ok(codes.includes("invalid-stake"));
  assert.ok(codes.includes("target-ineligible"));
  assert.ok(codes.includes("target-over-capacity"));
  assert.ok(codes.includes("weapon-already-sharpened"));
  assert.ok(codes.includes("weapon-sharpen-repeat"));
}

/* Resolution applies queue-order Heat and produces stable flat operations. */
{
  const queue = [
    action("lay-low", DOWNTIME_ACTIVITY_IDS.LAY_LOW, 4),
    action("trade", DOWNTIME_ACTIVITY_IDS.MARKET_TRADING, 8, {
      skill: "persuasion",
      stakeCp: 1_000,
    }),
    action("pick", DOWNTIME_ACTIVITY_IDS.PICKPOCKET, 4, {
      targetId: "mark-a",
    }),
    action("shop", DOWNTIME_ACTIVITY_IDS.SHOPLIFT, 4, {
      targetId: "merchant-a:row-1",
    }),
  ];
  const result = resolveDowntimeQueue({
    blockId: "block-1",
    actorId: "actor-a",
    queue,
    budgetHours: 20,
    settlement,
    startingHeat: 5,
    rolls: {
      trade: { dieResult: 18, skillModifier: 2, total: 20 },
      pick: { dieResult: 8, skillModifier: 5, total: 13 },
      shop: { dieResult: 20, skillModifier: 5, total: 25 },
    },
    targetFacts: {
      "merchant-a:row-1": { valueCp: 500 },
    },
  });

  assert.equal(result.ok, true);
  assert.equal(result.startingHeat, 5);
  assert.equal(result.finalHeat, 5);
  assert.equal(result.actions[0].heatAfter, 4);
  assert.equal(
    result.actions[1].check.outcomeTier,
    "exceptional-success",
    "8-hour trade adds +3 to raw total 20 versus DC 13",
  );
  assert.equal(result.actions[1].resolution.deltaCp, 250);
  assert.equal(result.actions[2].check.dc, 21, "DC 13 + 8 from Heat 4");
  assert.equal(result.actions[2].check.outcomeTier, "failure");
  assert.equal(result.actions[2].resolution.rewardEligible, false);
  assert.equal(result.actions[2].heatAfter, 5);
  assert.equal(result.actions[3].status, "blocked");
  assert.equal(result.actions[3].reason, "heat-max");
  assert.equal(result.crimeAttempts, 1, "blocked crime is not an attempt");
  assert.equal(result.operations.length, queue.length);
  assert.equal(
    new Set(result.operations.map((operation) => operation.operationId)).size,
    queue.length,
  );
  for (const operation of result.operations) {
    assert.equal(operation.actorId, "actor-a");
  }

  const replay = resolveDowntimeQueue({
    blockId: "block-1",
    actorId: "actor-a",
    queue,
    budgetHours: 20,
    settlement,
    startingHeat: 5,
    rolls: {
      trade: { dieResult: 18, skillModifier: 2, total: 20 },
      pick: { dieResult: 8, skillModifier: 5, total: 13 },
      shop: { dieResult: 20, skillModifier: 5, total: 25 },
    },
    targetFacts: { "merchant-a:row-1": { valueCp: 500 } },
  });
  assert.deepEqual(replay.operations, result.operations);
}

/* Same-block crime attempts add +2 DC each; serious failure changes faction once. */
{
  const result = resolveDowntimeQueue({
    blockId: "block-2",
    actorId: "actor-b",
    budgetHours: 10,
    settlement,
    queue: [
      action("pick", DOWNTIME_ACTIVITY_IDS.PICKPOCKET, 2, {
        targetId: "mark-a",
      }),
      action("shop", DOWNTIME_ACTIVITY_IDS.SHOPLIFT, 8, {
        targetId: "merchant-a:row-1",
      }),
    ],
    rolls: {
      pick: 15,
      shop: 3,
    },
    targetFacts: {
      "merchant-a:row-1": { valueCp: 250, dcModifier: 20 },
    },
  });
  assert.equal(result.ok, true);
  assert.equal(result.actions[0].check.dc, 13);
  assert.equal(result.actions[0].check.outcomeTier, "success");
  assert.equal(
    result.actions[1].check.dc,
    15,
    "shoplift DC uses security plus the earlier-attempt modifier, not item value",
  );
  assert.equal(result.actions[1].check.total, 5, "8 hours adds +2 to roll");
  assert.equal(result.actions[1].check.margin, -10);
  assert.equal(result.actions[1].check.outcomeTier, "serious-failure");
  assert.equal(result.actions[1].resolution.transferStock, false);
  assert.equal(result.actions[1].resolution.stockQuantity, 0);
  assert.equal(result.finalHeat, 3);
  assert.equal(result.actions[1].linkedFactionId, "dock-guild");
  assert.equal(result.actions[1].factionDelta, -1);
  assert.equal(result.factionConsequenceApplied, true);
}

/* Fencing uses value capacity and exact payout percentages. */
{
  const result = resolveDowntimeQueue({
    blockId: "block-3",
    actorId: "actor-c",
    budgetHours: 8,
    settlement,
    queue: [
      action("fence", DOWNTIME_ACTIVITY_IDS.FENCE_STOLEN_GOODS, 8, {
        targetId: "bundle-a",
        skill: "deception",
      }),
    ],
    rolls: { fence: 10 },
    targetFacts: { "bundle-a": { valueCp: 2_000 } },
  });
  assert.equal(result.ok, true);
  assert.equal(result.actions[0].check.total, 13);
  assert.equal(result.actions[0].check.outcomeTier, "success");
  assert.equal(result.actions[0].resolution.payoutCp, 800);
  assert.equal(result.actions[0].resolution.goodsTransferred, true);
}

/* Plans never exist without every required authoritative roll and target fact. */
{
  const missingRoll = resolveDowntimeQueue({
    blockId: "block-4",
    actorId: "actor-d",
    budgetHours: 2,
    settlement,
    queue: [
      action("trade", DOWNTIME_ACTIVITY_IDS.MARKET_TRADING, 2, {
        skill: "persuasion",
        stakeCp: 100,
      }),
    ],
  });
  assert.equal(missingRoll.ok, false);
  assert.ok(errorCodes(missingRoll).includes("missing-authoritative-roll"));
  assert.deepEqual(missingRoll.operations, []);

  const missingValue = resolveDowntimeQueue({
    blockId: "block-5",
    actorId: "actor-e",
    budgetHours: 2,
    settlement,
    queue: [
      action("fence", DOWNTIME_ACTIVITY_IDS.FENCE_STOLEN_GOODS, 2, {
        skill: "persuasion",
        targetId: "bundle-a",
      }),
    ],
    rolls: { fence: 20 },
  });
  assert.equal(missingValue.ok, false);
  assert.ok(errorCodes(missingValue).includes("missing-target-value"));
  assert.deepEqual(missingValue.operations, []);
}

/* Operation ids change with their replay identity and not with runtime state. */
{
  const first = buildDowntimeOperationId({
    blockId: "block",
    actorId: "actor",
    actionId: "action",
    index: 0,
  });
  assert.equal(
    first,
    buildDowntimeOperationId({
      blockId: "block",
      actorId: "actor",
      actionId: "action",
      index: 0,
    }),
  );
  assert.notEqual(
    first,
    buildDowntimeOperationId({
      blockId: "block",
      actorId: "actor",
      actionId: "action",
      index: 1,
    }),
  );
}

process.stdout.write("downtime-planner validation passed\n");
