import assert from "node:assert/strict";

import {
  applyPersistedHealersKitPlan,
  buildHealersKitConsumptionPlan,
  consumeHealersKitPlan,
  getHealersKitAvailable,
  isHealersKitItem,
} from "./injury/healers-kit.js";

function item(id, name, system) {
  return {
    id,
    name,
    system,
    async update(changes) {
      for (const [path, value] of Object.entries(changes)) {
        const keys = path.split(".");
        let cursor = this;
        for (const key of keys.slice(0, -1)) cursor = cursor[key];
        cursor[keys.at(-1)] = value;
      }
    },
  };
}

function actor(id, name, items) {
  return { id, name, items: { contents: items } };
}

const aricKit = item("kit-a", "Healer’s Kit", {
  identifier: "healers-kit",
  uses: { max: 10, spent: 8 },
  quantity: 1,
});
const bethKit = item("kit-b", "Healer Kit", {
  uses: { value: 3, max: 10 },
  quantity: 1,
});
const ration = item("food", "Trail Rations", { quantity: 5 });
const aric = actor("aric", "Aric", [aricKit, ration]);
const beth = actor("beth", "Beth", [bethKit]);

assert.equal(isHealersKitItem(aricKit), true);
assert.equal(isHealersKitItem(ration), false);
assert.equal(getHealersKitAvailable(aricKit), 2);
assert.equal(getHealersKitAvailable(bethKit), 3);

const plan = buildHealersKitConsumptionPlan({
  actors: [aric, beth],
  preferredActorIds: ["beth"],
  requiredCharges: 4,
});
assert.equal(plan.ok, true);
assert.equal(plan.available, 5);
assert.deepEqual(
  plan.steps.map((step) => [step.actorId, step.spend]),
  [
    ["beth", 3],
    ["aric", 1],
  ],
);

const result = await consumeHealersKitPlan(plan);
assert.equal(result.ok, true);
assert.equal(result.consumed, 4);
assert.equal(getHealersKitAvailable(bethKit), 0);
assert.equal(getHealersKitAvailable(aricKit), 1);

const insufficient = buildHealersKitConsumptionPlan({
  actors: [aric, beth],
  requiredCharges: 3,
});
assert.equal(insufficient.ok, false);
assert.equal(insufficient.missing, 2);

const ambiguousKit = item("kit-ambiguous", "Healer's Kit", {
  uses: { value: 4, max: 10 },
  quantity: 1,
});
let ambiguousUpdates = 0;
ambiguousKit.update = async function update(changes) {
  ambiguousUpdates += 1;
  for (const [path, value] of Object.entries(changes)) {
    const keys = path.split(".");
    let cursor = this;
    for (const key of keys.slice(0, -1)) cursor = cursor[key];
    cursor[keys.at(-1)] = value;
  }
  throw new Error("simulated apply-then-throw Item update");
};
const ambiguousActor = actor("ambiguous", "Ambiguous", [ambiguousKit]);
const ambiguousPlan = buildHealersKitConsumptionPlan({
  actors: [ambiguousActor],
  requiredCharges: 3,
});
const ambiguousResult = await consumeHealersKitPlan(ambiguousPlan);
assert.equal(
  ambiguousResult.ok,
  true,
  "canonical read-back adopts a charge update that applied before rejecting",
);
assert.equal(ambiguousResult.consumed, 3);
assert.equal(getHealersKitAvailable(ambiguousKit), 1);
assert.equal(
  ambiguousUpdates,
  1,
  "ambiguous success is not retried and cannot double-consume charges",
);

const rejectedKit = item("kit-rejected", "Healer's Kit", {
  uses: { value: 2, max: 10 },
  quantity: 1,
});
rejectedKit.update = async function update() {
  throw new Error("simulated rejected Item update");
};
const rejectedActor = actor("rejected", "Rejected", [rejectedKit]);
const rejectedPlan = buildHealersKitConsumptionPlan({
  actors: [rejectedActor],
  requiredCharges: 2,
});
await assert.rejects(
  consumeHealersKitPlan(rejectedPlan),
  /simulated rejected Item update/,
  "an Item rejection without the requested canonical change remains a failure",
);
assert.equal(getHealersKitAvailable(rejectedKit), 2);

const durableKit = item("kit-durable", "Healer's Kit", {
  uses: { value: 4, max: 10 },
  quantity: 1,
});
durableKit.flags = {};
durableKit.updateCount = 0;
durableKit.getFlag = function getFlag(moduleId, key) {
  return this.flags?.[moduleId]?.[key];
};
durableKit.update = async function update(changes) {
  this.updateCount += 1;
  for (const [path, value] of Object.entries(changes)) {
    const keys = path.split(".");
    let cursor = this;
    for (const key of keys.slice(0, -1)) {
      cursor[key] ??= {};
      cursor = cursor[key];
    }
    cursor[keys.at(-1)] = structuredClone(value);
  }
  throw new Error("simulated durable apply-then-throw Item update");
};
const durablePlan = {
  ok: true,
  required: 2,
  steps: [
    {
      actorId: "durable-actor",
      actorName: "Durable",
      itemId: durableKit.id,
      itemName: durableKit.name,
      item: durableKit,
      before: 4,
      spend: 2,
      after: 2,
    },
  ],
};
const durableOptions = {
  treatmentId: "treatment-durable",
  receiptToken: "receipt-durable",
};
const durableResult = await applyPersistedHealersKitPlan(
  durablePlan,
  durableOptions,
);
assert.equal(durableResult.ok, true);
assert.equal(durableResult.consumed, 2);
assert.equal(durableResult.details[0].adopted, true);
assert.equal(getHealersKitAvailable(durableKit), 2);
assert.equal(durableKit.updateCount, 1);
assert.equal(
  durableKit.flags["infinity-dnd5e"].criticalInjuryTreatmentReceipt.treatmentId,
  durableOptions.treatmentId,
);

const durableReplay = await applyPersistedHealersKitPlan(
  durablePlan,
  durableOptions,
);
assert.equal(durableReplay.ok, true);
assert.equal(durableReplay.consumed, 2);
assert.equal(durableReplay.details[0].adopted, true);
assert.equal(
  durableKit.updateCount,
  1,
  "an exact durable receipt replays without another Item write",
);

const unreceiptedKit = item("kit-unreceipted", "Healer's Kit", {
  uses: { value: 2, max: 10 },
  quantity: 1,
});
const unreceiptedResult = await applyPersistedHealersKitPlan(
  {
    ...durablePlan,
    steps: [
      {
        ...durablePlan.steps[0],
        itemId: unreceiptedKit.id,
        item: unreceiptedKit,
      },
    ],
  },
  durableOptions,
);
assert.equal(unreceiptedResult.ok, false);
assert.equal(unreceiptedResult.reason, "charges-changed");
assert.equal(
  getHealersKitAvailable(unreceiptedKit),
  2,
  "the expected quantity without the exact private receipt is not adopted",
);

process.stdout.write("critical injury Healer's Kit validation passed\n");
