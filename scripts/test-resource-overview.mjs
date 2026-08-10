import assert from "node:assert/strict";

import {
  buildResourceOverview,
  formatCoverage,
  sanitizeResourceOverview,
} from "./resource/overview.js";

const FOOD = {
  id: "food",
  label: "Food",
  scope: "per-character",
  perDay: 1,
  forageYields: "food",
  matching: {
    nameKeywords: ["ration"],
    flagTag: "food",
    itemUuids: [],
  },
};

const WATER = {
  id: "water",
  label: "Water",
  scope: "per-character",
  perDay: 1,
  forageYields: "water",
  matching: {
    nameKeywords: ["waterskin"],
    flagTag: "water",
    itemUuids: [],
  },
};

const LIGHT = {
  id: "light",
  label: "Light",
  scope: "party",
  perDay: 2,
  forageYields: null,
  matching: {
    nameKeywords: ["torch"],
    flagTag: "light",
    itemUuids: [],
  },
};

const MEDICINE = {
  id: "medicine",
  label: "Field Medicine",
  scope: "per-character",
  perDay: 0,
  forageYields: null,
  matching: {
    nameKeywords: [],
    flagTag: "medicine",
    itemUuids: [],
  },
};

function item(id, name, quantity, tag = "") {
  return {
    id,
    name,
    type: "loot",
    system: { quantity },
    flags: tag ? { "infinity-dnd5e": { resourceTag: tag } } : {},
  };
}

function roster({ shared = false } = {}) {
  return [
    {
      actorId: "actor-a",
      name: "Aria",
      isStash: shared,
      drawFromId: "actor-a",
      items: [
        item("ration-a", "Rations", 6, "food"),
        item("water-a", "Waterskin", 4, "water"),
        item("torch-a", "Torches", 3, "light"),
        item("medicine-a", "Herbal Poultice", 2, "medicine"),
      ],
    },
    {
      actorId: "actor-b",
      name: "Borin",
      isStash: false,
      drawFromId: shared ? "actor-a" : "actor-b",
      items: [
        item("torch-b", "Torch", 1, "light"),
        item("water-b", "Waterskin", 4, "water"),
      ],
    },
  ];
}

/* Individual packs remain source-aware instead of masking an empty pack. */
{
  const overview = buildResourceOverview({
    config: {
      resources: [FOOD, WATER, LIGHT],
      waterEnabled: true,
      halfRations: false,
    },
    roster: roster(),
    generatedAt: 1234,
  });

  assert.equal(overview.partySize, 2);
  assert.equal(overview.generatedAt, 1234);

  const food = overview.resources.find((resource) => resource.id === "food");
  assert.equal(food.available, 6, "totals each independent pack once");
  assert.equal(food.dailyUse, 2, "one ration per party member");
  assert.equal(
    food.coverageDays,
    0,
    "the emptiest independent pack controls aggregate coverage",
  );
  assert.equal(food.status, "critical");
  assert.equal(food.sources.length, 2);
  assert.deepEqual(
    food.sources.map((source) => ({
      name: source.name,
      available: source.available,
      dailyUse: source.dailyUse,
      coverageDays: source.coverageDays,
    })),
    [
      { name: "Aria", available: 6, dailyUse: 1, coverageDays: 6 },
      { name: "Borin", available: 0, dailyUse: 1, coverageDays: 0 },
    ],
  );

  const ariaFood = overview.members[0].resources.find(
    (resource) => resource.id === "food",
  );
  const borinFood = overview.members[1].resources.find(
    (resource) => resource.id === "food",
  );
  assert.equal(ariaFood.total, 6);
  assert.equal(ariaFood.shared, false);
  assert.equal(borinFood.total, 0);
  assert.equal(borinFood.sourceName, "Borin");

  const light = overview.resources.find((resource) => resource.id === "light");
  assert.equal(light.available, 4, "party pools combine tracked inventories");
  assert.equal(light.dailyUse, 2);
  assert.equal(light.coverageDays, 2);
  assert.equal(light.status, "low");
  assert.equal(light.scope, "party");
  assert.ok(
    overview.members.every(
      (member) =>
        member.resources.find((resource) => resource.id === "light")?.total ===
        4,
    ),
    "every member sees the same party-pool total",
  );
}

/* Split forage DCs survive both the GM model and sanitized player payload. */
{
  const overview = buildResourceOverview({
    config: { resources: [FOOD, WATER], waterEnabled: true },
    environment: {
      id: "rainforest",
      label: "Rainforest",
      forageable: true,
      dc: 15,
      foodDc: 10,
      waterDc: 15,
      yieldFood: "private-die",
    },
    roster: roster(),
  });
  assert.deepEqual(overview.environment, {
    id: "rainforest",
    label: "Rainforest",
    forageable: true,
    dc: 15,
    foodDc: 10,
    waterDc: 15,
  });
  assert.deepEqual(sanitizeResourceOverview(overview).environment, {
    id: "rainforest",
    label: "Rainforest",
    forageable: true,
    dc: 15,
    foodDc: 10,
    waterDc: 15,
  });

  const legacy = buildResourceOverview({
    environment: {
      id: "legacy",
      label: "Legacy",
      forageable: true,
      dc: 12,
    },
  });
  assert.equal(legacy.environment.foodDc, 12);
  assert.equal(legacy.environment.waterDc, 12);
}

/* A nominated stash is counted once and its demand includes every consumer. */
{
  const overview = buildResourceOverview({
    config: { resources: [FOOD], waterEnabled: true },
    roster: roster({ shared: true }),
  });
  const food = overview.resources[0];
  assert.equal(food.available, 6, "does not duplicate the shared stack");
  assert.equal(food.dailyUse, 2);
  assert.equal(food.coverageDays, 3);
  assert.equal(food.status, "ready");
  assert.equal(food.sources.length, 1);
  assert.equal(food.sources[0].memberCount, 2);
  assert.equal(food.sourceSummary, "Shared via Aria");
  assert.ok(
    overview.members.every(
      (member) =>
        member.resources[0].shared === true &&
        member.resources[0].sourceName === "Aria",
    ),
  );
}

/* A dedicated stash is an inventory source, not an extra mouth to feed. */
{
  const overview = buildResourceOverview({
    config: { resources: [FOOD, LIGHT], waterEnabled: true },
    roster: [
      {
        actorId: "actor-a",
        name: "Aria",
        consumes: true,
        isStash: false,
        drawFromId: "stash",
        items: [],
      },
      {
        actorId: "stash",
        name: "Pack Mule",
        consumes: false,
        isStash: true,
        drawFromId: "stash",
        items: [
          item("ration-stash", "Rations", 5, "food"),
          item("torch-stash", "Torches", 3, "light"),
        ],
      },
    ],
  });

  assert.equal(overview.partySize, 1, "only consuming actors count as party");
  assert.equal(overview.resources[0].available, 5);
  assert.equal(
    overview.resources[0].dailyUse,
    1,
    "the inventory-only stash is not charged a ration",
  );
  assert.equal(overview.resources[0].coverageDays, 5);
  assert.equal(
    overview.members.find((member) => member.actorId === "stash")?.consumes,
    false,
  );
  assert.equal(
    overview.resources.find((resource) => resource.id === "light")?.available,
    3,
    "party-pool items held by a dedicated stash remain available",
  );
}

/* Every roster row keeps one ordered inventory cell per configured resource.
   An inventory-only actor that is not currently a draw source still needs its
   own stocks represented without contributing to operational coverage. */
{
  const overview = buildResourceOverview({
    config: { resources: [FOOD, WATER, LIGHT], waterEnabled: true },
    roster: [
      {
        actorId: "actor-a",
        name: "Aria",
        consumes: true,
        isStash: false,
        drawFromId: "actor-a",
        items: [item("ration-a", "Rations", 1, "food")],
      },
      {
        actorId: "cart",
        name: "Supply Cart",
        consumes: false,
        isStash: false,
        drawFromId: "cart",
        items: [
          item("ration-cart", "Rations", 9, "food"),
          item("water-cart", "Waterskin", 7, "water"),
          item("torch-cart", "Torches", 5, "light"),
        ],
      },
    ],
  });

  const cart = overview.members.find((member) => member.actorId === "cart");
  assert.deepEqual(
    cart.resources.map((resource) => resource.id),
    ["food", "water", "light"],
    "fixed resource columns cannot collapse on an unused inventory-only row",
  );
  assert.deepEqual(
    cart.resources.map((resource) => resource.total),
    [9, 7, 5],
    "Quartermaster still shows the inventory-only actor's own stock",
  );
  assert.equal(
    overview.resources.find((resource) => resource.id === "food")?.available,
    1,
    "unassigned inventory does not inflate supplies available to consumers",
  );
}

/* Water can be disabled without hiding unrelated custom resources. */
{
  const overview = buildResourceOverview({
    config: {
      resources: [FOOD, WATER, LIGHT, MEDICINE],
      waterEnabled: false,
    },
    roster: roster(),
  });
  assert.deepEqual(
    overview.resources.map((resource) => resource.id),
    ["food", "light", "medicine"],
  );
  assert.ok(
    overview.members.every(
      (member) =>
        member.resources.some((resource) => resource.id === "medicine") &&
        !member.resources.some((resource) => resource.id === "water"),
    ),
  );
  const medicine = overview.resources.find(
    (resource) => resource.id === "medicine",
  );
  assert.equal(medicine.dailyUse, 0);
  assert.equal(medicine.coverageDays, null);
  assert.equal(medicine.status, "stable");
  assert.equal(medicine.coverageLabel, "No daily use");
}

/* Player projection is generic and strips GM-only inventory/write evidence. */
{
  const overview = buildResourceOverview({
    config: {
      resources: [FOOD, LIGHT, MEDICINE],
      waterEnabled: false,
    },
    roster: roster(),
    generatedAt: null,
    state: {
      lastUpkeepResult: {
        runId: "private-run-id",
        day: 42,
        days: 1,
        ranAt: null,
        status: "partial",
        hasErrors: true,
        perActor: [
          {
            actorId: "A",
            name: "Aria",
            shortfalls: { medicine: 2 },
            errors: ["private inventory write failed"],
            foraged: {
              attempted: true,
              success: true,
              suppressed: true,
              food: 3,
              water: 0,
            },
          },
        ],
        party: {
          light: {
            shortfall: 1,
            error: "private party write failed",
          },
        },
      },
    },
  });
  const player = sanitizeResourceOverview(overview);

  assert.equal(player.generatedAt, null);
  assert.equal("members" in player, false);
  assert.equal("recentRuns" in player, false);
  assert.equal("history" in player, false);
  assert.equal("runId" in player.lastUpkeep, false);
  assert.equal("errors" in player.lastUpkeep.rows[0], false);
  assert.equal("error" in player.lastUpkeep.partyShortages[0], false);
  assert.equal(player.lastUpkeep.rows[0].hasErrors, true);
  assert.equal(player.lastUpkeep.rows[0].outcome, "needs-review");
  assert.equal(player.lastUpkeep.rows[0].needsReview, true);
  assert.equal(player.lastUpkeep.rows[0].supplied, false);
  assert.deepEqual(player.lastUpkeep.rows[0].shortages, [
    { id: "medicine", label: "Field Medicine", amount: 2 },
  ]);
  assert.deepEqual(player.lastUpkeep.partyShortages, [
    {
      id: "light",
      label: "Light",
      amount: 1,
      outcome: "needs-review",
      needsReview: true,
      hasError: true,
    },
  ]);
  assert.equal(player.lastUpkeep.rows[0].forage.suppressed, true);
  assert.equal(
    player.resources.some((resource) => "sources" in resource),
    false,
  );
  assert.equal(
    player.resources.some((resource) =>
      resource.sourceSummary.includes("Aria"),
    ),
    false,
    "player source summaries never expose stash or actor names",
  );
  assert.equal(
    JSON.stringify(player).includes("private inventory write failed"),
    false,
  );
  assert.equal(
    JSON.stringify(player).includes("private party write failed"),
    false,
  );

  const medicine = player.resources.find(
    (resource) => resource.id === "medicine",
  );
  assert.equal(
    medicine.coverageDays,
    null,
    "a stable resource must not be serialized as zero days",
  );

  const hidden = sanitizeResourceOverview(overview, {
    visibleActorIds: new Set(),
  });
  assert.equal(hidden.lastUpkeep.rows[0].name, "Hidden party member");
  assert.equal(
    JSON.stringify(hidden).includes("Aria"),
    false,
    "an actor the viewer cannot observe stays unnamed",
  );

  const errorOnly = buildResourceOverview({
    config: { resources: [FOOD], waterEnabled: false },
    roster: roster(),
    state: {
      lastUpkeepResult: {
        status: "complete",
        hasErrors: false,
        perActor: [
          {
            actorId: "actor-a",
            name: "Aria",
            shortfalls: { food: 0 },
            errors: ["private exact inventory failure"],
          },
        ],
        party: {},
      },
    },
  });
  assert.equal(errorOnly.lastUpkeep.status, "partial");
  assert.equal(errorOnly.lastUpkeep.outcome, "needs-review");
  assert.equal(errorOnly.lastUpkeep.rows[0].supplied, false);
  assert.equal(errorOnly.lastUpkeep.rows[0].needsReview, true);
  const sanitizedErrorOnly = sanitizeResourceOverview(errorOnly);
  assert.equal(sanitizedErrorOnly.lastUpkeep.rows[0].supplied, false);
  assert.equal(sanitizedErrorOnly.lastUpkeep.rows[0].needsReview, true);
  assert.equal(
    JSON.stringify(sanitizedErrorOnly).includes(
      "private exact inventory failure",
    ),
    false,
    "the player learns the outcome without receiving private write details",
  );
}

/* Historical reports keep the labels and scope that existed when upkeep ran. */
{
  const overview = buildResourceOverview({
    config: { resources: [FOOD], waterEnabled: false },
    roster: roster(),
    state: {
      lastUpkeepResult: {
        status: "complete",
        resourceSnapshot: [
          {
            id: "old-medicine",
            label: "Old Field Medicine",
            scope: "per-character",
          },
        ],
        perActor: [
          {
            actorId: "actor-a",
            name: "Aria",
            shortfalls: { "old-medicine": 2 },
          },
        ],
        party: {},
      },
    },
  });

  assert.deepEqual(overview.lastUpkeep.rows[0].shortages, [
    {
      id: "old-medicine",
      label: "Old Field Medicine",
      amount: 2,
    },
  ]);
}

/* Small label edge cases remain deterministic. */
{
  assert.equal(formatCoverage(0, 1, 2), "Empty");
  assert.equal(formatCoverage(0.5, 1, 2), "<1 day");
  assert.equal(formatCoverage(1, 1, 2), "1 day");
  assert.equal(formatCoverage(null, 0, 2), "No daily use");
  assert.equal(formatCoverage(3, 1, 0), "No party");
}

process.stdout.write("resource overview validation passed\n");
