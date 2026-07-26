import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

import {
  actorItemSnapshots,
  buildUpkeepAuditMetadata,
  buildUpkeepReportContent,
  diagnoseProposedResourceDeposits,
  diagnoseResourceWritePreflight,
  recordConsumptionAccounting,
  resourceOperationFingerprint,
} from "./resource/calendar-watcher.js";

/* ------------------------------------------------------------------ *
 * Default resources remain distinct from canonical rule totals.
 * ------------------------------------------------------------------ */
{
  const row = {
    consumed: {},
    shortfalls: {},
    canonicalConsumed: { food: 0, water: 0 },
    canonicalShortfalls: { food: 0, water: 0 },
    errors: [],
  };
  recordConsumptionAccounting(
    row,
    { id: "food", label: "Food", forageYields: "food" },
    { consumed: 1, shortfall: 2, error: "" },
  );
  recordConsumptionAccounting(
    row,
    { id: "water", label: "Water", forageYields: "water" },
    { consumed: 3, shortfall: 4, error: "" },
  );

  assert.deepEqual(row.consumed, { food: 1, water: 3 });
  assert.deepEqual(row.shortfalls, { food: 2, water: 4 });
  assert.deepEqual(
    row.canonicalConsumed,
    { food: 1, water: 3 },
    "default resource consumption is not doubled",
  );
  assert.deepEqual(
    row.canonicalShortfalls,
    { food: 2, water: 4 },
    "default resource shortfalls are not doubled",
  );
}

/* ------------------------------------------------------------------ *
 * Audit metadata distinguishes trigger type and does not coerce null to day 0.
 * ------------------------------------------------------------------ */
{
  assert.deepEqual(
    buildUpkeepAuditMetadata({
      day: null,
      fallbackDay: 42,
      days: 2,
      manual: true,
      runId: "qm-audit",
      ranAt: 123456,
    }),
    {
      runId: "qm-audit",
      day: 42,
      days: 2,
      trigger: "manual",
      ranAt: 123456,
    },
  );
  assert.equal(
    buildUpkeepAuditMetadata({
      day: 0,
      fallbackDay: 42,
      runId: "qm-day-zero",
      ranAt: 1,
    }).day,
    0,
    "world day zero remains a valid audit day",
  );
}

/* ------------------------------------------------------------------ *
 * Write preflight blocks structural/live ambiguity but not advisory overlap.
 * ------------------------------------------------------------------ */
{
  const sharedUuid = "Compendium.dnd5e.items.ration";
  const warningOnly = diagnoseResourceWritePreflight({
    config: {
      waterEnabled: true,
      resources: [
        {
          id: "food",
          label: "Food",
          matching: { itemUuids: [sharedUuid] },
        },
        {
          id: "meals",
          label: "Meals",
          matching: { itemUuids: [sharedUuid] },
        },
      ],
    },
    actors: [],
  });
  assert.equal(warningOnly.blocked, false);
  assert.equal(warningOnly.warningConflicts.length, 1);

  const liveOverlap = diagnoseResourceWritePreflight({
    config: {
      waterEnabled: true,
      resources: [
        {
          id: "food",
          label: "Food",
          matching: { nameKeywords: ["ration"] },
        },
        {
          id: "meals",
          label: "Meals",
          matching: { itemUuids: [sharedUuid] },
        },
      ],
    },
    actors: [
      {
        id: "actor-a",
        name: "Aria",
        items: [
          {
            id: "item-a",
            name: "Trail Rations",
            _stats: { compendiumSource: sharedUuid },
            system: { quantity: 2 },
          },
        ],
      },
    ],
  });
  assert.equal(liveOverlap.blocked, true);
  assert.deepEqual(
    liveOverlap.blockingConflicts.map((conflict) => conflict.code),
    ["overlapping-live-item"],
  );

  const duplicateFoodChannel = diagnoseResourceWritePreflight({
    config: {
      waterEnabled: true,
      resources: [
        { id: "food", label: "Food", forageYields: "food", matching: {} },
        {
          id: "provisions",
          label: "Provisions",
          forageYields: "food",
          matching: {},
        },
      ],
    },
  });
  assert.equal(duplicateFoodChannel.blocked, true);
  assert.equal(
    duplicateFoodChannel.blockingConflicts[0].code,
    "duplicate-forage-channel",
  );

  const inactiveWater = diagnoseResourceWritePreflight({
    config: {
      waterEnabled: false,
      resources: [
        { id: "water", label: "Water", forageYields: "water", matching: {} },
        {
          id: "reserve-water",
          label: "Reserve Water",
          forageYields: "water",
          matching: {},
        },
      ],
    },
  });
  assert.equal(
    inactiveWater.blocked,
    false,
    "disabled water definitions do not block a runtime write",
  );
}

/* ------------------------------------------------------------------ *
 * Late-write context snapshots detect rule, route, and environment changes.
 * ------------------------------------------------------------------ */
{
  const config = {
    forageMode: "each",
    halfRations: false,
    waterEnabled: true,
    maxCatchUpDays: 7,
    forageTimeoutSeconds: 120,
    resources: [
      {
        id: "food",
        matching: { nameKeywords: ["ration"], flagTag: "food", itemUuids: [] },
      },
    ],
    roster: [
      {
        actorId: "actor-a",
        isStash: false,
        consumes: true,
        drawFrom: "self",
      },
    ],
    partyStashId: "",
    environments: [{ id: "road", dc: 15 }],
  };
  const roster = [
    {
      actor: { id: "actor-a" },
      isStash: false,
      consumes: true,
      drawFromId: "actor-a",
    },
  ];
  const initial = resourceOperationFingerprint({
    config,
    state: { currentEnvironmentId: "road", lastSeenDay: 98 },
    roster,
    environmentId: "road",
  });
  assert.notEqual(
    resourceOperationFingerprint({
      config: structuredClone(config),
      state: { currentEnvironmentId: "road", lastSeenDay: 99 },
      roster: structuredClone(roster),
      environmentId: "road",
    }),
    initial,
    "a newly reserved calendar day invalidates a delayed client operation",
  );
  assert.equal(
    resourceOperationFingerprint({
      config: structuredClone(config),
      state: {
        currentEnvironmentId: "road",
        lastSeenDay: 98,
        lastUpkeepResult: { day: 98 },
      },
      roster: structuredClone(roster),
      environmentId: "road",
    }),
    initial,
    "completed-report details do not invalidate an otherwise current operation",
  );

  const changedRules = structuredClone(config);
  changedRules.resources[0].matching.nameKeywords = ["provision"];
  assert.notEqual(
    resourceOperationFingerprint({
      config: changedRules,
      state: { currentEnvironmentId: "road" },
      roster,
      environmentId: "road",
    }),
    initial,
  );
  assert.notEqual(
    resourceOperationFingerprint({
      config,
      state: { currentEnvironmentId: "road" },
      roster: [{ ...roster[0], consumes: false }],
      environmentId: "road",
    }),
    initial,
  );
  assert.notEqual(
    resourceOperationFingerprint({
      config,
      state: { currentEnvironmentId: "road" },
      roster,
      environmentId: "forest",
    }),
    initial,
  );
}

/* ------------------------------------------------------------------ *
 * Proposed creates are checked before a deposit can introduce ambiguity.
 * ------------------------------------------------------------------ */
{
  const actor = { id: "actor-a", name: "Aria", items: [] };
  const food = {
    id: "food",
    label: "Trail Rations",
    matching: {
      nameKeywords: ["ration"],
      flagTag: "food",
      itemUuids: [],
    },
  };
  const medicine = {
    id: "medicine",
    label: "Field Medicine",
    matching: {
      nameKeywords: ["trail ration"],
      flagTag: "medicine",
      itemUuids: [],
    },
  };
  const ambiguous = await diagnoseProposedResourceDeposits({
    resources: [food, medicine],
    deposits: [{ actor, resource: food, amount: 3 }],
  });
  assert.equal(ambiguous.blocked, true);
  assert.equal(ambiguous.blockingConflicts[0].code, "overlapping-live-item");
  assert.match(ambiguous.blockingConflicts[0].itemId, /^proposed-resource-/);

  const safe = await diagnoseProposedResourceDeposits({
    resources: [
      food,
      {
        ...medicine,
        matching: { ...medicine.matching, nameKeywords: ["bandage"] },
      },
    ],
    deposits: [{ actor, resource: food, amount: 3 }],
  });
  assert.equal(safe.blocked, false);
  assert.equal(safe.templatesByResourceId.has("food"), true);

  const bumpWithUnsafeFallback = await diagnoseProposedResourceDeposits({
    resources: [food, medicine],
    deposits: [
      {
        actor: {
          id: "actor-b",
          name: "Borin",
          items: [
            {
              id: "existing-food",
              name: "Food Crate",
              system: { quantity: 2 },
              flags: {
                "infinity-dnd5e": { resourceTag: "food" },
              },
            },
          ],
        },
        resource: food,
        amount: 1,
      },
    ],
  });
  assert.equal(
    bumpWithUnsafeFallback.blocked,
    true,
    "a predicted bump still approves and diagnoses its create fallback",
  );
  assert.match(
    bumpWithUnsafeFallback.blockingConflicts[0].itemId,
    /^proposed-resource-fallback-/,
  );
}

/* Exact embedded UUID matching survives Foundry's plain-object conversion. */
{
  const snapshots = actorItemSnapshots({
    items: [
      {
        uuid: "Actor.actor-a.Item.item-a",
        toObject: () => ({
          id: "item-a",
          name: "Trail Rations",
          system: { quantity: 1 },
        }),
      },
    ],
  });
  assert.equal(snapshots[0].uuid, "Actor.actor-a.Item.item-a");
}

/* ------------------------------------------------------------------ *
 * Receipts use configured individual and party resource labels.
 * ------------------------------------------------------------------ */
{
  const content = buildUpkeepReportContent({
    env: { id: "sparse", label: "Sparse" },
    resources: [
      {
        id: "provisions",
        label: "Travel Provisions",
        scope: "per-character",
      },
      { id: "lamp-oil", label: "Lamp Oil", scope: "party" },
    ],
    result: {
      days: 2,
      perActor: [
        {
          name: "<Aria>",
          shortfalls: { provisions: 2 },
          errors: [],
          foraged: {
            attempted: true,
            success: true,
            suppressed: true,
            food: 0,
            water: 0,
          },
        },
      ],
      party: { "lamp-oil": { consumed: 0, shortfall: 1, error: "" } },
    },
  });
  assert.match(content, /Travel Provisions/);
  assert.match(content, /Lamp Oil: 1 short/);
  assert.match(content, /gathered; best haul kept/);
  assert.match(content, /&lt;Aria&gt;/, "actor names are escaped");
  assert.match(content, /\(2 days\)/);
}

/* ------------------------------------------------------------------ *
 * Waiting and completion states are announced and expose busy state.
 * ------------------------------------------------------------------ */
{
  const template = await readFile(
    new URL("../templates/forage-prompt.hbs", import.meta.url),
    "utf8",
  );
  assert.match(template, /aria-busy=/);
  assert.match(template, /role="status"[\s\S]*?aria-live="polite"/);
  assert.match(template, /role="alert"/);
}

process.stdout.write("resource-accounting validation passed\n");
