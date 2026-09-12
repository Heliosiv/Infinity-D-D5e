import assert from "node:assert/strict";
import {
  buildResourceOverview,
  sanitizeResourceOverview,
} from "./resource/overview.js";

for (const [stock, status, label] of [
  [199, "critical", "<1 day"],
  [200, "low", "1 day"],
  [201, "low", "1 day"],
  [599, "low", "2.9 days"],
  [600, "ready", "3 days"],
  [601, "ready", "3 days"],
]) {
  const row = buildResourceOverview({
    config: {
      resources: [
        {
          id: "food",
          label: "Rations",
          scope: "party",
          perDay: 200,
          matching: { nameKeywords: ["ration"] },
        },
      ],
    },
    roster: [
      {
        actorId: "a",
        items: [{ id: "r", name: "Ration", system: { quantity: stock } }],
      },
    ],
  }).resources[0];
  assert.equal(row.status, status, `${stock}/200 readiness`);
  assert.equal(row.coverageLabel, label, `${stock}/200 display`);
}

const history = sanitizeResourceOverview(
  buildResourceOverview({
    config: { resources: [{ id: "food", label: "Renamed food" }] },
    state: {
      lastUpkeepResult: {
        day: 0,
        days: 3,
        ranAt: 12345,
        resourceSnapshot: [
          { id: "food", label: "Travel rations", scope: "per-character" },
        ],
        perActor: [{ actorId: "a", name: "A", shortfalls: {}, errors: [] }],
      },
    },
  }),
);
assert.equal(history.lastUpkeep.day, 0);
assert.equal(history.lastUpkeep.days, 3);
assert.deepEqual(history.lastUpkeep.selectedResources, [
  { id: "food", label: "Travel rations" },
]);
assert.deepEqual(sanitizeResourceOverview(history), history);
console.log(
  "Party Supplies threshold, snapshot round-trip and historical selection boundaries passed",
);
