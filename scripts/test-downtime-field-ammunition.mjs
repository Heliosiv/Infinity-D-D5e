import assert from "node:assert/strict";
import {
  FIELD_RECIPES,
  FIELD_OUTPUT,
  fieldTemplate,
  fieldResolution,
  fieldGatheringResult,
  fieldRiskPercent,
} from "./downtime/field-ammunition.js";
import { normalizeGuidedDowntimeTemplate } from "./downtime/dispatch.js";
import {
  quoteGuidedWork,
  projectGuidedWork,
  buildGuidedWorkPlan,
  applyGuidedWork,
  inspectGuidedWork,
  verifyGuidedWorkBefore,
} from "./downtime/work.js";
import { planWalletDeltaCp } from "./downtime/items.js";
import { normalizeDowntimeWorkflowStore } from "./downtime/store.js";
import {
  sanitizePlayerDowntimeSnapshot,
  createDowntimePlayerAdapter,
} from "./downtime/ui-adapter.js";

const activity = normalizeGuidedDowntimeTemplate(fieldTemplate());
const actor = {
  id: "field-crafter",
  name: "Field Crafter",
  system: { currency: { gp: 10, sp: 0, cp: 0, ep: 0, pp: 0 } },
  items: new Map(),
};
let writes = 0;
actor.update = async (changes) => {
  writes++;
  for (const [key, value] of Object.entries(changes))
    actor.system.currency[key.split(".").at(-1)] = value;
  return actor;
};
const add = (source) => {
  const data = structuredClone(source);
  const item = {
    ...data,
    id: data._id,
    toObject: () => structuredClone(data),
    update: async (changes) => {
      writes++;
      data.system.quantity = changes["system.quantity"];
      return item;
    },
  };
  actor.items.set(item.id, item);
  return item;
};
actor.createEmbeddedDocuments = async (_type, sources) => {
  writes++;
  return sources.map(add);
};
actor.deleteEmbeddedDocuments = async (_type, ids) =>
  ids.map((id) => {
    const item = actor.items.get(id);
    actor.items.delete(id);
    return item;
  });
for (const [i, name] of [
  "Fletcher's Tools",
  "Woodcarver's Tools",
  "Mason's Tools",
  "Tinker's Tools",
].entries())
  add({ _id: `tool${i}`, name, type: "tool", system: { quantity: 1 } });
const base = {
  actor,
  activity,
  hours: 4,
  targetId: "arrows:gp",
  locationPresetId: "wilderness",
  progress: {},
};
const quote = (options = {}) => quoteGuidedWork({ ...base, ...options });
assert.equal(activity.blockHours, 1);
const editedField = normalizeGuidedDowntimeTemplate({
  ...fieldTemplate(),
  outcomes: fieldTemplate().outcomes.map((outcome) => ({
    ...outcome,
    rewardGp: 100,
    label: "Custom tier",
  })),
});
assert.deepEqual(editedField.outcomes, fieldTemplate().outcomes);
for (const [total, factor] of [
  [13, 1],
  [12, 0.5],
  [9, 0.5],
  [8, 0],
])
  assert.equal(fieldResolution(total, "Moderate").factor, factor);
for (const [total, discount] of [
  [15, 0.75],
  [14, 0.5],
  [10, 0.5],
  [9, 0.25],
  [6, 0.25],
  [5, 0],
])
  assert.equal(fieldGatheringResult(total).discount, discount);
assert.equal(fieldRiskPercent(100, 1), 100);
assert.equal(fieldRiskPercent(0, 4), 0);
assert.ok(Math.abs(fieldRiskPercent(5, 3) - 14.2625) < 1e-8);
for (const recipe of FIELD_RECIPES) {
  const plan = quote({
    targetId: `${recipe.id}:gp`,
    hours: recipe.hours,
    checkTotal: 30,
  });
  assert.equal(plan.outputQuantity, recipe.quantity);
  assert.equal(plan.costCp, recipe.costCp);
  assert.equal(plan.ok, true);
}
const near = quote({ hours: 3, checkTotal: 9 });
assert.equal(
  fieldResolution(8.5, "Moderate").factor,
  0.5,
  "any miss smaller than five keeps partial progress",
);
assert.equal(near.contributedHours, 1.5);
assert.equal(near.outputQuantity, 0);
assert.equal(near.field.fundedAfter, 1.5);
const progress = {
  [near.key]: near.progressAfterHours,
  [near.field.materialKey]: near.field.fundedAfter,
  [near.field.roundingKey]: near.field.roundingAfter,
};
assert.deepEqual(
  normalizeDowntimeWorkflowStore({ workProgress: progress }).workProgress,
  progress,
  "half-hour work and material credits survive reload",
);
assert.deepEqual(
  normalizeDowntimeWorkflowStore({
    workProgress: {
      ...progress,
      aaaaaaaaaaaaaaaa: "1.5",
      bbbbbbbbbbbbbbbb: 0.25,
    },
  }).workProgress,
  progress,
  "progress requires numeric half-hour units",
);
const resumed = quote({ hours: 1, checkTotal: 13, progress });
assert.equal(resumed.costCp, 0, "retained materials are not charged again");
assert.equal(resumed.outputQuantity, 5);
assert.equal(resumed.field.fundedAfter, 0.5);
const failed = quote({ hours: 1, checkTotal: 8, progress });
assert.equal(
  failed.progressAfterHours,
  1.5,
  "failure preserves prior progress",
);
assert.equal(
  failed.field.fundedAfter,
  0.5,
  "failure destroys only this attempt's committed materials",
);
const freshFailed = quote({ hours: 3, checkTotal: 8 });
assert.equal(freshFailed.contributedHours, 0);
assert.equal(freshFailed.field.fundedAfter, 0);
assert.equal(freshFailed.costCp, near.costCp);
assert.throws(() => quote({ targetId: "firearm:gp" }), /recipe/);
assert.throws(
  () => quote({ targetId: "arrows:gather", hours: 1 }),
  /crafting hour/,
);
assert.equal(
  quote({ targetId: "arrows:gather", locationPresetId: "town" }).ok,
  false,
);
assert.throws(
  () => quote({ targetId: "arrows:gather", checkTotal: 13 }),
  /missing/,
);
const gathered = quote({
  targetId: "arrows:gather",
  checkTotal: 13,
  gatheringTotal: 15,
  complicationRoll: 1,
});
const fractionalGather = quote({
  hours: 2,
  targetId: "arrows:gather",
  checkTotal: 13,
  gatheringTotal: 15,
  complicationRoll: 10000,
  progress: { [near.field.materialKey]: 0.5 },
});
assert.equal(fractionalGather.costCp, 1);
assert.equal(
  fractionalGather.field.roundingAfter,
  1,
  "0.9375 cp rounds up to one cp with an exact sixteenth-copper credit",
);
assert.equal(gathered.contributedHours, 3);
assert.equal(gathered.costCp, 6);
assert.equal(gathered.field.gathering.discount, 0.75);
assert.equal(gathered.field.complication.triggered, true);
assert.equal(
  quote({
    targetId: "arrows:gather",
    checkTotal: 8,
    gatheringTotal: 15,
    complicationRoll: 10000,
  }).field.complication.triggered,
  false,
  "complications are independent from crafting failures",
);

const bundle = add({
  _id: "bundle",
  name: "Arrow Materials",
  type: "loot",
  system: { quantity: 1 },
});
assert.equal(quote({ hours: 3, targetId: "arrows:materials" }).ok, false);
const mixed = quote({ hours: 3, targetId: "arrows:mixed", checkTotal: 9 });
assert.equal(mixed.materials[0].after, 0);
assert.equal(mixed.costCp, 8);
assert.equal(mixed.field.fundedAfter, 1.5);
const supplied = quote({
  hours: 1,
  targetId: "arrows:materials",
  checkTotal: 13,
});
assert.equal(
  supplied.field.fundedAfter,
  1,
  "unused portion of a consumed bundle remains funded",
);
assert.equal(supplied.costCp, 0);
const tiny1 = quote({ targetId: "sling-bullets:gp", hours: 1, checkTotal: 30 });
assert.equal(tiny1.costCp, 1);
assert.equal(writes, 0, "quotes spend nothing");

const publicWork = projectGuidedWork(actor, activity, 1, {}, "wilderness", 4);
const snapshot = sanitizePlayerDowntimeSnapshot({
  mode: "guided",
  status: "collecting",
  hasActiveBlock: true,
  blockId: "block",
  selectedActorId: actor.id,
  actors: [{ id: actor.id, name: actor.name }],
  budgetHours: 4,
  canSubmit: true,
  activities: [
    {
      ...publicWork,
      id: activity.id,
      label: activity.name,
      hourOptions: [1, 2, 3, 4],
      skills: [{ id: "slt", label: "Sleight of Hand" }],
    },
  ],
});
assert.match(JSON.stringify(snapshot), /Complication chance: 5%/);
assert.doesNotMatch(
  JSON.stringify(snapshot),
  /"dc"|"margin"|"fieldSeed"|walletBefore|"identity"/,
);
assert.equal(
  snapshot.activities[0].targets.find((target) => target.id === "arrows:gather")
    .quotes[0].hours,
  2,
);

// Cancelling the crafting roll preserves the already completed gathering roll.
let calls = [],
  cancelled = false,
  accepted;
const adapter = createDowntimePlayerAdapter({
  isAuthority: () => true,
  registerSocket: () => {},
  subscribeSocket: () => () => {},
  getCurrentUserId: () => "player",
  getActor: () => actor,
  getDirectProjection: async () => snapshot,
  requestIdFactory: (prefix) => `${prefix}-field`,
  submitDirect: async (payload) => {
    accepted = payload;
  },
  rollSkill: async (_actor, skill) => {
    calls.push(skill);
    if (skill === "slt" && !cancelled) {
      cancelled = true;
      return { ok: false };
    }
    return { ok: true, total: 15, roll: { formula: "1d20 + 3" } };
  },
});
await adapter.getPlayerProjection({ actorId: actor.id });
await adapter.queueActivity({
  actorId: actor.id,
  activityId: activity.id,
  hours: 4,
  targetId: "arrows:gather",
  skill: "slt",
});
await assert.rejects(adapter.submitQueue({ actorId: actor.id }), /cancelled/);
await adapter.submitQueue({ actorId: actor.id });
assert.deepEqual(calls, ["sur", "slt", "slt"]);
assert.equal(accepted.queue[0].gatheringRoll.total, 15);
adapter.destroy();

const originalResolver = globalThis.fromUuid;
globalThis.fromUuid = async () => ({
  _id: "source",
  name: "Arrow",
  type: "consumable",
  system: { quantity: 1, type: { value: "ammo" } },
});
try {
  const work = await buildGuidedWorkPlan({
    ...base,
    hours: 3,
    targetId: "arrows:mixed",
    checkTotal: 13,
    operationId: "field-op",
  });
  const operation = {
    operationId: "field-op",
    actorId: actor.id,
    work,
    walletBefore: structuredClone(actor.system.currency),
    walletAfter: planWalletDeltaCp(actor.system.currency, -work.costCp),
  };
  assert.equal(work.delivery.quantity, 5);
  bundle.system.quantity = 0;
  assert.equal(verifyGuidedWorkBefore(actor, operation), false);
  bundle.system.quantity = 1;
  assert.equal(
    (await applyGuidedWork(actor, operation, { authorizeWrite: () => true }))
      .ok,
    true,
  );
  assert.equal(inspectGuidedWork(actor, operation), "applied");
  assert.equal(actor.items.get(work.delivery.itemId).system.quantity, 5);
  assert.equal(bundle.system.quantity, 0);
} finally {
  if (originalResolver === undefined) delete globalThis.fromUuid;
  else globalThis.fromUuid = originalResolver;
}
console.log(
  "Field ammunition rules, gathering, retained materials, quotes, roll cancellation, and inventory delivery passed.",
);
