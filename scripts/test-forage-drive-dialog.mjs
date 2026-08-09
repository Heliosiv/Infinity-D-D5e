import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import Handlebars from "handlebars";

import {
  buildForageDriveDialogContext,
  readForageDriveDialogSubmission,
} from "./forage-drive-dialog.js";

const context = buildForageDriveDialogContext({
  environmentLabel: "Desert",
  defaultFoodDc: 20,
  defaultWaterDc: 25,
  stashName: "Quartermaster Cart",
  canForageFood: true,
  canForageWater: true,
  candidates: [
    { actorId: "actor-a", name: "Aria", online: true },
    { actorId: "actor-b", name: "Brom", online: false },
  ],
});

assert.equal(context.foodDc, 20);
assert.equal(context.waterDc, 25);
assert.equal(context.dcsDiffer, true);
assert.equal(context.candidates[0].statusLabel, "Player rolls");
assert.equal(context.candidates[1].statusLabel, "GM rolls");
assert.ok(
  context.candidates.every(
    (candidate) =>
      candidate.targetOptions.find((option) => option.value === "food-water")
        ?.selected === true,
  ),
  "each forager starts with an independent combined target",
);

const html = Handlebars.compile(
  readFileSync("templates/forage-drive-dialog.hbs", "utf8"),
  { strict: true },
)(context);
assert.match(html, /Food DC/);
assert.match(html, /Water DC/);
assert.match(html, /value="20"/);
assert.match(html, /value="25"/);
assert.match(html, /What Aria gathers/);
assert.match(html, /What Brom gathers/);
assert.match(html, /Player rolls/);
assert.match(html, /GM rolls/);
assert.match(html, /same roll misses the other DC/);

function checkedForager(actorId, forageTarget) {
  return {
    value: actorId,
    closest() {
      return {
        querySelector() {
          return { value: forageTarget };
        },
      };
    },
  };
}

const submission = readForageDriveDialogSubmission({
  elements: {
    foodDc: { value: "18" },
    waterDc: { value: "23" },
  },
  querySelectorAll() {
    return [
      checkedForager(" actor-a ", "food"),
      checkedForager("actor-b", "water"),
      checkedForager("actor-c", "food-water"),
      checkedForager("actor-b", "food"),
    ];
  },
});
assert.deepEqual(submission, {
  foodDc: 18,
  waterDc: 23,
  foragers: [
    { actorId: "actor-a", forageTarget: "food" },
    { actorId: "actor-b", forageTarget: "water" },
    { actorId: "actor-c", forageTarget: "food-water" },
  ],
});

const foodOnly = buildForageDriveDialogContext({
  canForageFood: true,
  canForageWater: false,
  candidates: [{ actorId: "actor-a", name: "Aria" }],
});
assert.equal(
  foodOnly.candidates[0].targetOptions.find((option) => option.value === "food")
    .selected,
  true,
);
assert.equal(
  foodOnly.candidates[0].targetOptions.find(
    (option) => option.value === "water",
  ).disabled,
  true,
);

process.stdout.write("Forage Drive dialog validation passed\n");
