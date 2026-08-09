import assert from "node:assert/strict";

import {
  RESOURCE_RUN_HISTORY_LIMIT,
  RESOURCE_RUN_RECEIPT_VERSION,
  appendRecentRunReceipt,
  buildForageRunReceipt,
  buildInterruptedRunReceipt,
  buildRunActorSnapshots,
  buildUpkeepRunReceipt,
  normalizeRecentRuns,
  normalizeRunReceipt,
  presentRecentRuns,
} from "./resource/history.js";

/* Interrupted context distinguishes participants from possible write targets. */
{
  assert.deepEqual(
    buildRunActorSnapshots({
      participants: [
        { actorId: "actor-a", name: "Aria", document: { forbidden: true } },
      ],
      writeTargets: [
        { actorId: "actor-a", name: "Aria" },
        { actorId: "stash-a", name: "Party Mule" },
        { actorId: "stash-a", name: "duplicate ignored" },
      ],
    }),
    [
      {
        actorId: "actor-a",
        name: "Aria",
        role: "participant-inventory",
      },
      { actorId: "stash-a", name: "Party Mule", role: "inventory" },
    ],
  );
}

const upkeepResult = {
  runId: " upkeep-42 ",
  trigger: "manual",
  day: 42,
  days: 1,
  ranAt: 1_700_000_000_000,
  environmentId: "limited",
  status: "partial",
  hasErrors: true,
  resourceSnapshot: [
    { id: "food", label: "Food", scope: "per-character" },
    { id: "water", label: "Water", scope: "per-character" },
    { id: "medicine", label: "Medicine", scope: "per-character" },
    { id: "light", label: "Light", scope: "party" },
    { id: "signal", label: "Signal fire", scope: "party" },
  ],
  perActor: [
    {
      actorId: "actor-a",
      name: "Aria",
      consumed: { food: 1, water: 0.5 },
      shortfalls: { food: 0, water: 0.5, medicine: 0 },
      foraged: {
        attempted: false,
        success: false,
        food: 0,
        water: 0,
      },
      errors: ["water write needs review"],
      rawActor: { forbidden: true },
    },
  ],
  party: {
    light: { consumed: 2, shortfall: 1, error: "" },
    signal: { consumed: 0, shortfall: 0, error: "" },
  },
  suggestions: [
    {
      actorId: "actor-a",
      name: "Aria",
      suggestDelta: 1,
      reasons: ["Water shortfall"],
    },
  ],
  matching: { nameKeywords: ["secret"] },
};

/* Detailed upkeep receipts retain accounting labels, not source documents. */
{
  const receipt = buildUpkeepRunReceipt({
    result: upkeepResult,
    environment: { id: "limited", label: "Limited", dc: 15 },
    recordedAt: 1_700_000_001_000,
  });
  assert.equal(receipt.version, RESOURCE_RUN_RECEIPT_VERSION);
  assert.equal(receipt.runId, "upkeep-42");
  assert.equal(receipt.kind, "upkeep");
  assert.equal(receipt.trigger, "manual");
  assert.equal(receipt.status, "partial");
  assert.equal(receipt.outcomeUnknown, false);
  assert.deepEqual(receipt.environment, {
    id: "limited",
    label: "Limited",
    dc: 15,
  });
  assert.deepEqual(receipt.actors[0].resources, [
    { id: "food", label: "Food", consumed: 1, shortfall: 0 },
    { id: "water", label: "Water", consumed: 0.5, shortfall: 0.5 },
  ]);
  assert.deepEqual(receipt.partyResources, [
    { id: "light", label: "Light", consumed: 2, shortfall: 1, error: "" },
  ]);
  assert.equal(JSON.stringify(receipt).includes("rawActor"), false);
  assert.equal(JSON.stringify(receipt).includes("nameKeywords"), false);
}

/* Forage receipts cover all target modes and store only a plain destination. */
{
  for (const target of ["food-water", "food", "water"]) {
    const receipt = buildForageRunReceipt({
      runId: `forage-${target}`,
      day: 43,
      environment: { id: "woods", label: "Deep Woods", dc: 17 },
      perForager: [
        {
          actorId: "actor-a",
          name: "Aria",
          attempted: true,
          success: true,
          suppressed: target === "water",
          food: target === "water" ? 0 : 4,
          water: target === "food" ? 0 : 3,
          roll: { forbidden: true },
        },
      ],
      forageTarget: target,
      forageMode: target === "water" ? "best" : "each",
      destination: {
        mode: "party-stash",
        actorId: "stash-a",
        name: "Party Mule",
        actor: { forbidden: true },
      },
      totalFood: target === "water" ? 0 : 4,
      totalWater: target === "food" ? 0 : 3,
      depositErrors: target === "water" ? ["water deposit failed"] : [],
      recordedAt: 1_700_000_002_000,
    });
    assert.equal(receipt.kind, "forage");
    assert.equal(receipt.forageDrive.target, target);
    assert.equal(receipt.status, target === "water" ? "partial" : "complete");
    assert.deepEqual(receipt.forageDrive.destination, {
      mode: "party-stash",
      actorId: "stash-a",
      name: "Party Mule",
    });
    assert.equal(JSON.stringify(receipt).includes("forbidden"), false);
  }
}

/* Interrupted acknowledgement never pretends to know the write outcome. */
{
  const receipt = buildInterruptedRunReceipt(
    {
      runId: "interrupted-1",
      trigger: "calendar",
      day: 44,
      days: 2,
      claimedAt: 1_700_000_003_000,
      startedAt: 1_700_000_002_000,
      environment: { id: "woods", label: "Deep Woods", dc: 17 },
      initiator: { userId: "gm-a", name: "Morgan" },
      actors: [{ actorId: "actor-a", name: "Aria" }],
    },
    1_700_000_004_000,
  );
  assert.deepEqual(receipt, {
    version: 1,
    runId: "interrupted-1",
    kind: "interrupted",
    trigger: "calendar",
    status: "interrupted",
    outcomeUnknown: true,
    day: 44,
    days: 2,
    startedAt: 1_700_000_002_000,
    claimedAt: 1_700_000_003_000,
    recordedAt: 1_700_000_004_000,
    environment: { id: "woods", label: "Deep Woods", dc: 17 },
    initiator: { userId: "gm-a", name: "Morgan" },
    actors: [
      {
        actorId: "actor-a",
        name: "Aria",
        role: "participant",
        resources: [],
        forage: null,
        errors: [],
      },
    ],
    partyResources: [],
    exhaustionSuggestions: [],
    forageContext: null,
    forageDrive: null,
  });

  const forageInterruption = buildInterruptedRunReceipt(
    {
      runId: "interrupted-forage",
      trigger: "forage",
      day: 44,
      days: 1,
      startedAt: 1_700_000_005_000,
      claimedAt: 1_700_000_006_000,
      forageTarget: "water",
      forageDestination: {
        mode: "party-stash",
        actorId: "stash-a",
        name: "Party Mule",
      },
    },
    1_700_000_007_000,
  );
  assert.deepEqual(forageInterruption.forageContext, {
    target: "water",
    destination: {
      mode: "party-stash",
      actorId: "stash-a",
      name: "Party Mule",
    },
  });
}

/* Normalization is allowlisted, newest-first, deduplicated, and exactly 20. */
{
  const seed = buildUpkeepRunReceipt({
    result: upkeepResult,
    recordedAt: 1_700_000_001_000,
  });
  const hostile = normalizeRunReceipt({
    ...seed,
    secretConfig: { matching: ["never persist"] },
    actors: [...seed.actors, { ...seed.actors[0], name: "duplicate actor" }],
  });
  assert.equal("secretConfig" in hostile, false);
  assert.equal(hostile.actors.length, 1);

  const rows = Array.from({ length: RESOURCE_RUN_HISTORY_LIMIT + 5 }, (_, i) =>
    normalizeRunReceipt({
      ...seed,
      runId: `run-${i}`,
      recordedAt: 2_000 - i,
    }),
  );
  rows.push({ ...rows[0], recordedAt: 9_000 });
  const history = normalizeRecentRuns(rows);
  assert.equal(history.length, RESOURCE_RUN_HISTORY_LIMIT);
  assert.equal(history[0].runId, "run-0", "first canonical duplicate wins");
  assert.equal(history[1].runId, "run-1");
  assert.equal(new Set(history.map((row) => row.runId)).size, history.length);

  const newest = normalizeRunReceipt({
    ...seed,
    runId: "newest",
    recordedAt: 10_000,
  });
  const appended = appendRecentRunReceipt(history, newest);
  assert.equal(appended.length, RESOURCE_RUN_HISTORY_LIMIT);
  assert.equal(appended[0].runId, "newest");

  const backwardClock = normalizeRunReceipt({
    ...seed,
    runId: "backward-clock",
    recordedAt: 1,
  });
  const appendedBackward = appendRecentRunReceipt(history, backwardClock);
  assert.equal(
    appendedBackward[0].runId,
    "backward-clock",
    "completion order survives a backward wall-clock adjustment",
  );

  const replacement = normalizeRunReceipt({
    ...seed,
    runId: "same-run",
    status: "complete",
    recordedAt: 5_000,
  });
  const staleFuture = normalizeRunReceipt({
    ...seed,
    runId: "same-run",
    status: "partial",
    recordedAt: 50_000,
  });
  const replaced = appendRecentRunReceipt([staleFuture], replacement);
  assert.equal(replaced.length, 1);
  assert.equal(
    replaced[0].status,
    "complete",
    "the canonical completion replaces any stale same-run receipt",
  );
  assert.equal(replaced[0].recordedAt, 5_000);
}

/* Malformed receipt types cannot be persisted. */
{
  assert.equal(normalizeRunReceipt(null), null);
  assert.equal(normalizeRunReceipt({ runId: "missing-shape" }), null);
  assert.equal(
    normalizeRunReceipt({
      runId: "bad-pair",
      kind: "forage",
      trigger: "manual",
      status: "complete",
      recordedAt: 1,
    }),
    null,
  );
  assert.throws(
    () => appendRecentRunReceipt([], { runId: "bad" }),
    /ResourceRunReceiptInvalid/,
  );
}

/* Presentation uses snapshotted labels and explicit unknown-outcome language. */
{
  const receipts = [
    buildInterruptedRunReceipt(
      {
        runId: "interrupted-ui",
        trigger: "forage",
        day: null,
        days: 1,
        claimedAt: 1_700_000_000_000,
      },
      1_700_000_005_000,
    ),
    buildUpkeepRunReceipt({
      result: upkeepResult,
      environment: { id: "old", label: "Historical Label", dc: 13 },
      recordedAt: 1_700_000_001_000,
    }),
  ];
  const view = presentRecentRuns(receipts, {
    locale: "en-CA",
    timeZone: "UTC",
  });
  assert.equal(view[0].summaryLabel, "Inventory outcome unknown");
  assert.equal(view[0].actorCountLabel, "0 affected actors");
  assert.equal(view[0].triggerLabel, "Interrupted forage drive");
  assert.equal(view[1].environmentLabel, "Historical Label");
  assert.match(view[1].recordedAtLabel, /2023/);
  assert.equal(view[1].actors[0].displayErrors.length, 1);
}

process.stdout.write("resource run-history validation passed\n");
