import assert from "node:assert/strict";
import { settleLiving, livingRoster, livingPolicy } from "./resource/living.js";
import { buildResourceInventoryPlan } from "./resource/operation-inventory.js";
import { applyConsumption } from "./resource/calendar-watcher.js";
import { buildDailySupplyPreview } from "./resource/daily-preview.js";
import {
  normalizeResourceConfig,
  serializeResourceConfig,
} from "./resource/store.js";
import {
  buildUpkeepRunReceipt,
  presentRecentRuns,
} from "./resource/history.js";

const food = {
  id: "food",
  label: "Food",
  scope: "per-character",
  perDay: 1,
  forageYields: "food",
  matching: { nameKeywords: ["rations"] },
};
const water = {
  ...food,
  id: "water",
  label: "Water",
  forageYields: "water",
  matching: { nameKeywords: ["water"] },
};
const light = {
  ...food,
  id: "light",
  label: "Light",
  scope: "party",
  forageYields: null,
  matching: { nameKeywords: ["torch"] },
};
const resources = [food, water, light];
const config = {
  dailyLiving: true,
  resources,
  roster: [
    { actorId: "payer", living: "modest" },
    {
      actorId: "guest",
      living: "covered",
      livingReason: "Hosted by the guild",
    },
  ],
};
assert.equal(
  serializeResourceConfig(normalizeResourceConfig(config)).dailyLiving,
  true,
);
assert.equal(livingPolicy(config, "payer").mode, "modest");
assert.equal(
  livingPolicy({ ...config, dailyLiving: false }, "payer").mode,
  "supplies",
);
let writes = 0;
function actor(id, gp = 10) {
  return {
    id,
    name: id,
    flags: {},
    system: { currency: { gp } },
    items: [],
    async update(patch) {
      writes++;
      if (patch["system.currency"])
        this.system.currency = structuredClone(patch["system.currency"]);
      this.flags["infinity-dnd5e"] = {
        livingReceipt: structuredClone(
          patch["flags.infinity-dnd5e.livingReceipt"],
        ),
      };
      return this;
    },
    async updateEmbeddedDocuments(_type, patches) {
      for (const patch of patches)
        this.items.find((i) => i._id === patch._id).system.quantity =
          patch["system.quantity"];
    },
  };
}
const payer = actor("payer"),
  camper = actor("camper"),
  guest = actor("guest"),
  stash = actor("stash");
stash.items = ["Rations", "Water", "Torch"].map((name, i) => ({
  _id: String(i),
  name,
  system: { quantity: 10 },
}));
const actors = new Map([payer, camper, guest, stash].map((a) => [a.id, a]));
const roster = livingRoster(
  [payer, camper, guest, stash].map((a) => ({
    actorId: a.id,
    name: a.name,
    actor: a,
    items: a.items,
    consumes: a !== stash,
    isStash: a === stash,
    drawFromId: "stash",
  })),
  config,
);
const plan = await buildResourceInventoryPlan({
  runId: "plan",
  roster,
  resources,
  days: 2,
});
assert.deepEqual(
  plan.accounting.perActor.find((r) => r.actorId === "payer").consumed,
  {},
);
assert.equal(
  plan.accounting.perActor.find((r) => r.actorId === "camper").consumed.food,
  2,
);
assert.equal(plan.accounting.party.light.consumed, 2);
const preview = await buildDailySupplyPreview({ config, roster, days: 2 });
assert.equal(preview.resources.find((r) => r.id === "food").required, 2);
const report = await applyConsumption({
  roster,
  cfg: config,
  days: 2,
  sourceForMember: new Map([
    ["payer", stash],
    ["camper", stash],
    ["guest", stash],
  ]),
});
assert.deepEqual(
  stash.items.map((i) => i.system.quantity),
  [8, 8, 8],
);
await settleLiving({
  config,
  rows: report.perActor,
  runId: "mixed",
  days: 2,
  actors,
});
assert.equal(payer.system.currency.gp, 8);
assert.equal(guest.system.currency.gp, 10);
assert.equal(
  report.perActor.find((r) => r.actorId === "guest").living.covered,
  true,
);
const count = writes;
await settleLiving({
  config,
  rows: report.perActor,
  runId: "mixed",
  days: 2,
  actors,
});
assert.equal(writes, count, "recovery cannot charge the same receipt again");
const receipt = buildUpkeepRunReceipt({
  result: {
    ...report,
    runId: "mixed",
    day: 2,
    days: 2,
    trigger: "manual",
    resourceSnapshot: resources,
  },
});
assert.match(
  presentRecentRuns([receipt])[0].actors.find((r) => r.actorId === "payer")
    .livingSummary,
  /paid 2 gp/,
);
payer.system.currency = { gp: 0 };
let rows = [{ actorId: "payer", errors: [] }];
await settleLiving({ config, rows, runId: "poor", days: 1, actors });
assert.equal(rows[0].living.covered, false);
assert.match(rows[0].errors[0], /could not pay/);
assert.equal(payer.system.currency.gp, 0);
const noReason = {
  ...config,
  roster: [{ actorId: "guest", living: "covered" }],
};
rows = [{ actorId: "guest", errors: [] }];
await settleLiving({
  config: noReason,
  rows,
  runId: "no-reason",
  days: 1,
  actors,
});
assert.equal(rows[0].living.covered, false);
assert.match(rows[0].errors[0], /reason is required/);
payer.system.currency = { pp: 1 };
await settleLiving({
  config,
  rows: [{ actorId: "payer" }],
  runId: "change",
  days: 1,
  actors,
});
assert.equal(payer.system.currency.gp, 9);
const before = writes;
await assert.rejects(
  settleLiving({
    config,
    rows: [{ actorId: "payer" }],
    runId: "lost-authority",
    days: 1,
    actors,
    assertWriteAllowed: () => {
      throw new Error("authority lost");
    },
  }),
  /authority lost/,
);
assert.equal(writes, before);
const update = payer.update;
payer.update = async function (patch) {
  await update.call(this, patch);
  throw new Error("response lost");
};
await settleLiving({
  config,
  rows: [{ actorId: "payer" }],
  runId: "lost-response",
  days: 1,
  actors,
});
assert.equal(payer.system.currency.gp, 8);
payer.update = async () => {
  throw new Error("write rejected");
};
await assert.rejects(
  settleLiving({
    config,
    rows: [{ actorId: "payer" }],
    runId: "failed",
    days: 1,
    actors,
  }),
  /write rejected/,
);
assert.equal(payer.system.currency.gp, 8);
payer.update = async (patch) => {
  payer.flags["infinity-dnd5e"] = {
    livingReceipt: structuredClone(patch["flags.infinity-dnd5e.livingReceipt"]),
  };
};
await assert.rejects(
  settleLiving({
    config,
    rows: [{ actorId: "payer" }],
    runId: "wallet-hook",
    days: 1,
    actors,
  }),
  /wallet write needs review/,
);
await assert.rejects(
  settleLiving({
    config,
    rows: [{ actorId: "payer" }],
    runId: "wallet-hook",
    days: 1,
    actors,
  }),
  /Wallet changed since/,
);
console.log(
  "Daily living: mixed stash, planner/legacy parity, preview, money, exceptions, receipt recovery and authority guards passed",
);
