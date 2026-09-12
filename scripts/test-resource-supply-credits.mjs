import assert from "node:assert/strict";
import { applyConsumption } from "./resource/calendar-watcher.js";
import { buildResourceInventoryPlan } from "./resource/operation-inventory.js";
import { buildResourceOverview } from "./resource/overview.js";
import { buildDailySupplyPreview } from "./resource/daily-preview.js";

const food = {
  id: "food",
  label: "Rations",
  scope: "per-character",
  perDay: 1,
  forageYields: "food",
  matching: { nameKeywords: ["ration"] },
};
function makeActor() {
  const item = {
    id: "r",
    _id: "r",
    name: "Ration",
    type: "loot",
    system: { quantity: 100 },
  };
  const items = [item];
  items.get = (id) => items.find((entry) => entry.id === id);
  return {
    id: "a",
    name: "A",
    items,
    async updateEmbeddedDocuments(_type, updates) {
      for (const update of updates)
        items.get(update._id).system.quantity = update["system.quantity"];
    },
    async deleteEmbeddedDocuments(_type, ids) {
      for (const id of ids)
        items.splice(
          items.findIndex((entry) => entry.id === id),
          1,
        );
    },
  };
}

for (const rate of [0.25, 1, 2, 3])
  for (const halfRations of [false, true]) {
    const resource = { ...food, perDay: rate };
    const actor = makeActor();
    let credits;
    for (let day = 0; day < 4; day++) {
      const config = {
        resources: [resource],
        halfRations,
        supplyCredits: credits,
      };
      const roster = [
        {
          actorId: actor.id,
          name: actor.name,
          items: structuredClone([...actor.items]),
        },
      ];
      const preview = await buildDailySupplyPreview({ config, roster });
      const planned = await buildResourceInventoryPlan({
        runId: `run-${day}`,
        roster,
        resources: [resource],
        halfRations,
        supplyCredits: credits,
      });
      const actual = await applyConsumption({
        roster: [{ actor, consumes: true }],
        cfg: config,
        days: 1,
      });
      assert.equal(
        preview.resources[0].required,
        actual.perActor[0].consumed.food,
      );
      assert.equal(
        planned.accounting.perActor[0].consumed.food,
        actual.perActor[0].consumed.food,
      );
      assert.deepEqual(planned.supplyCredits, actual.supplyCredits);
      // Simulate persistence/reload: only serialized receipt credit crosses runs.
      credits = JSON.parse(JSON.stringify(actual.supplyCredits));
    }
    const batchActor = makeActor();
    const batch = await applyConsumption({
      roster: [{ actor: batchActor, consumes: true }],
      cfg: { resources: [resource], halfRations },
      days: 4,
    });
    assert.equal(
      actor.items[0].system.quantity,
      batchActor.items[0].system.quantity,
      `${rate}/day half=${halfRations}: daily vs catch-up`,
    );
    assert.deepEqual(credits, batch.supplyCredits);
  }

const actor = makeActor();
const first = await applyConsumption({
  roster: [{ actor, consumes: true }],
  cfg: { resources: [food], halfRations: true },
  days: 1,
});
assert.equal(first.perActor[0].consumed.food, 1);
const overview = buildResourceOverview({
  config: { resources: [food], halfRations: true },
  state: { lastUpkeepResult: first },
  roster: [{ actorId: "a", items: [] }],
});
assert.equal(
  overview.resources[0].available,
  0.5,
  "remaining prepaid half is available even if the inventory stack is gone",
);
assert.equal(overview.resources[0].coverageDays, 1);
const second = await applyConsumption({
  roster: [{ actor, consumes: true }],
  cfg: {
    resources: [food],
    halfRations: true,
    supplyCredits: first.supplyCredits,
  },
  days: 1,
});
assert.equal(
  second.perActor[0].consumed.food,
  0,
  "the second half-day charge uses the prepaid ration",
);
assert.deepEqual(second.supplyCredits.balances, {});
console.log(
  "Supply credits: daily/catch-up equivalence, reload, preview, planner and prepaid coverage passed",
);

const shared = buildResourceOverview({
  config: { resources: [food], halfRations: true },
  roster: [
    { actorId: "a", name: "A", consumes: true, drawFromId: "stash", items: [] },
    { actorId: "b", name: "B", consumes: true, drawFromId: "stash", items: [] },
    {
      actorId: "stash",
      name: "Stash",
      consumes: false,
      items: [{ id: "ration", name: "Ration", quantity: 1 }],
    },
  ],
});
assert.equal(shared.resources[0].available, 1);
assert.equal(
  shared.resources[0].coverageDays,
  0,
  "one whole unit cannot prepay separate halves for two consumers",
);

const skipped = await applyConsumption({
  roster: [{ actor, consumes: true }],
  cfg: { resources: [], supplyCredits: first.supplyCredits },
  days: 1,
});
assert.deepEqual(
  skipped.supplyCredits,
  first.supplyCredits,
  "unselected resources keep their prepaid balances",
);
