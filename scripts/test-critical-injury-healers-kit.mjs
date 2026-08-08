import assert from "node:assert/strict";

import {
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

process.stdout.write("critical injury Healer's Kit validation passed\n");
