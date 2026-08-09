import assert from "node:assert/strict";

import {
  AMMUNITION_RECIPES,
  actorHasAnyTool,
  applyAmmoCraftOperation,
  applyFenceOperation,
  applyStolenItemDelivery,
  ammoCraftCostCp,
  buildAmmoCraftOperation,
  buildStolenCoinPurse,
  cleanAmmoStack,
  isCleanAmmoRecipeStack,
  isStolenItem,
  markStolenSnapshot,
  planWalletDeltaCp,
  removeStolenItemDelivery,
  stolenItemValueCp,
  stolenProvenance,
} from "./downtime/items.js";
import { DOWNTIME_ACTIVITY_IDS } from "./downtime/catalog.js";
import { buildActorDowntimeContext } from "./downtime/targets.js";
import { isSellable } from "./merchant/transaction.js";

assert.equal(ammoCraftCostCp("arrows"), 50);
assert.equal(ammoCraftCostCp("bolts"), 20);
assert.equal(ammoCraftCostCp("needles"), 20);
assert.equal(ammoCraftCostCp("sling-bullets"), 2);
assert.equal(ammoCraftCostCp("unknown"), null);

const toolActor = {
  id: "actor-1",
  system: { currency: { pp: 0, gp: 1, ep: 0, sp: 0, cp: 0 } },
  items: [
    {
      id: "tool-1",
      name: "Woodcarver's Tools",
      type: "tool",
      system: { quantity: 1 },
    },
  ],
};
assert.equal(actorHasAnyTool(toolActor, ["woodcarver"]), true);
assert.equal(actorHasAnyTool(toolActor, ["smith"]), false);

const unaffordableContext = await buildActorDowntimeContext({
  block: {
    id: "block-unaffordable-ammo",
    opportunitySecret: `${"11".repeat(32)}.${"22".repeat(32)}`,
  },
  actor: {
    ...toolActor,
    system: { currency: { pp: 0, gp: 0, ep: 0, sp: 0, cp: 0 } },
  },
  settlement: {
    id: "greyharbor",
    wealthTier: "standard",
    linkedMerchantIds: [],
    enabledActivityIds: [DOWNTIME_ACTIVITY_IDS.CRAFT_AMMUNITION],
  },
  config: { heat: {} },
});
const unaffordableAmmo = unaffordableContext.playerActivities.find(
  (activity) => activity.id === DOWNTIME_ACTIVITY_IDS.CRAFT_AMMUNITION,
);
assert.equal(unaffordableAmmo.available, false);
assert.equal(
  unaffordableAmmo.unavailableReason,
  "You do not have enough coin for ammunition materials.",
  "an equipped crafter who lacks coin gets an affordability explanation, not a missing-tool error",
);

const singularAmmoNames = Object.freeze({
  arrows: "Arrow",
  bolts: "Crossbow Bolt",
  needles: "Blowgun Needle",
  "sling-bullets": "Sling Bullet",
});
for (const [recipeId, name] of Object.entries(singularAmmoNames)) {
  const stolenStack = {
    id: `${recipeId}-stolen`,
    name,
    type: "consumable",
    system: {
      quantity: 1,
      rarity: "common",
      properties: [],
      type: { value: "ammo", subtype: "" },
    },
    flags: {
      "infinity-dnd5e": {
        stolen: { operationId: `${recipeId}-theft` },
      },
    },
  };
  const magicalStack = {
    id: `${recipeId}-magical`,
    name,
    type: "consumable",
    system: {
      quantity: 1,
      rarity: "uncommon",
      properties: ["mgc"],
      type: { value: "ammo", subtype: "" },
    },
    flags: {},
  };
  const cleanStack = {
    id: `${recipeId}-clean`,
    name,
    type: "consumable",
    system: {
      quantity: 3,
      rarity: "common",
      properties: [],
      type: { value: "ammo", subtype: "" },
    },
    flags: {},
  };
  assert.equal(
    cleanAmmoStack(
      { items: [stolenStack, magicalStack, cleanStack] },
      recipeId,
    ),
    cleanStack,
    `${name} should match the clean mundane stack only`,
  );
}

assert.equal(
  cleanAmmoStack(
    {
      items: [
        {
          id: "magical-source-ammunition",
          name: "Arrows +1",
          type: "consumable",
          system: {
            quantity: 1,
            rarity: "uncommon",
            properties: ["mgc"],
            type: { value: "ammo", subtype: "" },
          },
          flags: { core: { sourceId: AMMUNITION_RECIPES.arrows.uuid } },
        },
      ],
    },
    "arrows",
  ),
  null,
  "a canonical source UUID must not let magical ammunition join a clean stack",
);

assert.equal(
  cleanAmmoStack(
    {
      items: [
        {
          id: "misnamed-potion",
          name: "Arrow",
          type: "consumable",
          system: {
            quantity: 1,
            rarity: "common",
            properties: [],
            type: { value: "potion", subtype: "" },
          },
          flags: { core: { sourceId: AMMUNITION_RECIPES.arrows.uuid } },
        },
      ],
    },
    "arrows",
  ),
  null,
  "a renamed non-ammunition consumable cannot receive a crafted ammo batch",
);

const canonicalArrowStack = {
  id: "canonical-arrow-stack",
  name: "Arrow",
  type: "consumable",
  system: {
    quantity: 5,
    rarity: "common",
    properties: [],
    type: { value: "ammo", subtype: "" },
  },
  flags: {
    core: {
      sourceId: `Compendium.dnd5e.items.Item.${AMMUNITION_RECIPES.arrows.itemId}`,
    },
  },
};
assert.equal(isCleanAmmoRecipeStack(canonicalArrowStack, "arrows"), true);
for (const [label, mutate] of [
  ["non-ammunition", (item) => (item.system.type.value = "potion")],
  ["magical", (item) => item.system.properties.push("mgc")],
  [
    "stolen",
    (item) => {
      item.flags["infinity-dnd5e"] = {
        stolen: { operationId: "theft-operation" },
      };
    },
  ],
  [
    "wrong canonical recipe",
    (item) => {
      item.name = "Arrow";
      item.flags.core.sourceId = `Compendium.dnd5e.items.Item.${AMMUNITION_RECIPES.bolts.itemId}`;
    },
  ],
]) {
  const changed = structuredClone(canonicalArrowStack);
  mutate(changed);
  assert.equal(
    isCleanAmmoRecipeStack(changed, "arrows"),
    false,
    `${label} inventory cannot satisfy an arrow craft target`,
  );
}

assert.deepEqual(
  planWalletDeltaCp({ pp: 0, gp: 1, ep: 0, sp: 0, cp: 0 }, -50),
  { pp: 0, gp: 0, ep: 0, sp: 5, cp: 0 },
);
assert.deepEqual(planWalletDeltaCp({ pp: 0, gp: 1, ep: 0, sp: 0, cp: 0 }, 25), {
  pp: 0,
  gp: 1,
  ep: 0,
  sp: 2,
  cp: 5,
});

const stolen = markStolenSnapshot(
  {
    _id: "source",
    name: "Silver Ring",
    type: "loot",
    system: {
      quantity: 8,
      price: { value: 30, denomination: "gp" },
    },
  },
  {
    settlementId: "greyharbor",
    targetType: "merchant-stock",
    merchantId: "merchant-1",
    sourceId: "row-1",
    operationId: "operation-1",
    timestamp: 1234,
    appraisedValueCp: 3000,
  },
);
assert.equal(stolen.system.quantity, 1);
assert.equal(isStolenItem(stolen), true);
assert.equal(isSellable(stolen), false);
assert.equal(stolenItemValueCp(stolen), 3000);
assert.deepEqual(stolenProvenance(stolen), {
  settlementId: "greyharbor",
  targetType: "merchant-stock",
  sourceId: "row-1",
  merchantId: "merchant-1",
  operationId: "operation-1",
  timestamp: 1234,
  appraisedValueCp: 3000,
});

const purse = buildStolenCoinPurse({
  settlementId: "greyharbor",
  sourceId: "mark-1",
  operationId: "operation-2",
  timestamp: 5678,
  valueCp: 73,
});
assert.equal(purse.name, "Stolen Coin Purse");
assert.equal(stolenItemValueCp(purse), 73);
assert.notEqual(purse._id, stolen._id);

globalThis.fromUuid = async (uuid) => ({
  id: AMMUNITION_RECIPES.arrows.itemId,
  name: "Arrows",
  type: "consumable",
  system: {
    quantity: 1,
    price: { value: 5, denomination: "cp" },
    type: { value: "ammo", subtype: "" },
  },
  flags: {
    core: {
      sourceId: `Compendium.dnd5e.items.Item.${AMMUNITION_RECIPES.arrows.itemId}`,
    },
  },
  toObject() {
    return {
      _id: this.id,
      name: this.name,
      type: this.type,
      system: structuredClone(this.system),
      flags: structuredClone(this.flags),
    };
  },
});

function liveItem(source) {
  const data = structuredClone(source);
  data._id = String(data._id ?? data.id);
  delete data.id;
  return {
    id: data._id,
    get name() {
      return data.name;
    },
    get type() {
      return data.type;
    },
    get system() {
      return data.system;
    },
    get flags() {
      return data.flags;
    },
    toObject: () => structuredClone(data),
    async update(changes) {
      if (`system.quantity` in changes) {
        data.system.quantity = changes[`system.quantity`];
      }
      return this;
    },
  };
}

function liveActor({ id, currency, items = [] }) {
  const actor = {
    id,
    system: { currency: structuredClone(currency) },
    items: new Map(),
    async update(changes) {
      for (const denomination of ["pp", "gp", "ep", "sp", "cp"]) {
        const key = `system.currency.${denomination}`;
        if (key in changes) this.system.currency[denomination] = changes[key];
      }
      return this;
    },
    async createEmbeddedDocuments(_type, sources) {
      return sources.map((source) => {
        const document = liveItem(source);
        this.items.set(document.id, document);
        return document;
      });
    },
    async deleteEmbeddedDocuments(_type, ids) {
      return ids.flatMap((itemId) => {
        const document = this.items.get(itemId);
        if (!document) return [];
        this.items.delete(itemId);
        return [document];
      });
    },
  };
  for (const source of items) {
    const document = liveItem(source);
    actor.items.set(document.id, document);
  }
  return actor;
}

const craftActor = liveActor({
  id: "actor-craft",
  currency: { pp: 0, gp: 1, ep: 0, sp: 0, cp: 0 },
  items: [
    {
      _id: "tool-craft",
      name: "Woodcarver's Tools",
      type: "tool",
      system: { quantity: 1 },
      flags: {},
    },
  ],
});

const planned = await buildAmmoCraftOperation({
  actor: craftActor,
  recipeId: "arrows",
  operationId: "craft-1",
});
assert.equal(planned.ok, true);
assert.equal(planned.operation.costCp, 50);
assert.equal(planned.operation.delivery.quantityBefore, 0);
assert.equal(planned.operation.delivery.quantityAfter, 20);
assert.deepEqual(planned.operation.walletAfter, {
  pp: 0,
  gp: 0,
  ep: 0,
  sp: 5,
  cp: 0,
});
const crafted = await applyAmmoCraftOperation(craftActor, planned.operation);
assert.equal(crafted.ok, true);
assert.deepEqual(craftActor.system.currency, planned.operation.walletAfter);
assert.equal(
  craftActor.items.get(planned.operation.delivery.itemId)?.system.quantity,
  20,
);
const craftReplay = await applyAmmoCraftOperation(
  craftActor,
  planned.operation,
);
assert.equal(craftReplay.ok, true);
assert.equal(craftReplay.alreadyApplied, true);

const forgedCraftActor = liveActor({
  id: "actor-craft",
  currency: { pp: 0, gp: 1, ep: 0, sp: 0, cp: 0 },
  items: [
    {
      _id: "tool-craft",
      name: "Woodcarver's Tools",
      type: "tool",
      system: { quantity: 1 },
      flags: {},
    },
  ],
});
const forgedCraft = await applyAmmoCraftOperation(forgedCraftActor, {
  ...planned.operation,
  walletAfter: { pp: 0, gp: 999, ep: 0, sp: 0, cp: 0 },
});
assert.equal(forgedCraft.ok, false);
assert.equal(forgedCraft.reason, "invalid-craft-plan");
assert.deepEqual(
  forgedCraftActor.system.currency,
  planned.operation.walletBefore,
  "a malformed craft plan cannot mint currency before delivery",
);
assert.equal(
  forgedCraftActor.items.has(planned.operation.delivery.itemId),
  false,
);

const authorityRaceActor = liveActor({
  id: planned.operation.actorId,
  currency: planned.operation.walletBefore,
  items: [
    {
      _id: "authority-race-tool",
      name: "Woodcarver's Tools",
      type: "tool",
      system: { quantity: 1 },
      flags: {},
    },
  ],
});
let authorityCurrent = true;
const authorityRaceUpdate = authorityRaceActor.update.bind(authorityRaceActor);
authorityRaceActor.update = async (...args) => {
  const returned = await authorityRaceUpdate(...args);
  authorityCurrent = false;
  return returned;
};
const authorityRaceCraft = await applyAmmoCraftOperation(
  authorityRaceActor,
  planned.operation,
  { authorizeWrite: () => authorityCurrent },
);
assert.equal(authorityRaceCraft.ok, false);
assert.equal(authorityRaceCraft.reason, "authority-lost");
assert.equal(
  authorityRaceCraft.provenUnapplied,
  false,
  "an epoch change during the wallet await is reported as ambiguous",
);
assert.deepEqual(
  authorityRaceActor.system.currency,
  planned.operation.walletAfter,
);
assert.equal(
  authorityRaceActor.items.has(planned.operation.delivery.itemId),
  false,
  "delivery does not continue after authority changes during payment",
);

const stackRaceActor = liveActor({
  id: "actor-stack-race",
  currency: { pp: 0, gp: 1, ep: 0, sp: 0, cp: 0 },
  items: [
    {
      _id: "tool-stack-race",
      name: "Woodcarver's Tools",
      type: "tool",
      system: { quantity: 1 },
      flags: {},
    },
    { ...canonicalArrowStack, _id: "existing-arrow-stack" },
  ],
});
const plannedStack = await buildAmmoCraftOperation({
  actor: stackRaceActor,
  recipeId: "arrows",
  operationId: "craft-stack-race",
});
assert.equal(plannedStack.ok, true);
assert.equal(plannedStack.operation.delivery.mode, "stack");
const changedStack = stackRaceActor.items.get("existing-arrow-stack");
changedStack.system.type.value = "potion";
const rejectedStackDrift = await applyAmmoCraftOperation(
  stackRaceActor,
  plannedStack.operation,
);
assert.equal(rejectedStackDrift.ok, false);
assert.equal(rejectedStackDrift.reason, "state-drift");
assert.equal(changedStack.system.quantity, 5);
assert.deepEqual(
  stackRaceActor.system.currency,
  plannedStack.operation.walletBefore,
  "identity drift is rejected before either the wallet or stack changes",
);

const ambiguousReplaySnapshot = structuredClone(
  planned.operation.delivery.snapshot,
);
ambiguousReplaySnapshot.system.type.value = "potion";
const ambiguousReplayActor = liveActor({
  id: planned.operation.actorId,
  currency: planned.operation.walletAfter,
  items: [
    {
      _id: "ambiguous-replay-tool",
      name: "Woodcarver's Tools",
      type: "tool",
      system: { quantity: 1 },
      flags: {},
    },
    ambiguousReplaySnapshot,
  ],
});
const ambiguousReplay = await applyAmmoCraftOperation(
  ambiguousReplayActor,
  planned.operation,
);
assert.equal(ambiguousReplay.ok, false);
assert.equal(ambiguousReplay.reason, "state-drift");
assert.equal(
  ambiguousReplay.alreadyApplied,
  undefined,
  "a matching quantity and wallet cannot prove replay when item identity drifted",
);

const fenceActor = liveActor({
  id: "actor-fence",
  currency: { pp: 0, gp: 0, ep: 0, sp: 0, cp: 0 },
  items: [stolen],
});
const fenceOperation = {
  itemSnapshots: [stolen],
  payoutCp: 120,
  goodsTransferred: true,
  walletBefore: { pp: 0, gp: 0, ep: 0, sp: 0, cp: 0 },
  walletAfter: { pp: 0, gp: 1, ep: 0, sp: 2, cp: 0 },
};
const fenced = await applyFenceOperation(fenceActor, fenceOperation);
assert.equal(fenced.ok, true);
assert.equal(fenceActor.items.has(stolen._id), false);
assert.deepEqual(fenceActor.system.currency, fenceOperation.walletAfter);
const fenceReplay = await applyFenceOperation(fenceActor, fenceOperation);
assert.equal(fenceReplay.ok, true);
assert.equal(fenceReplay.alreadyApplied, true);

const duplicateFenceActor = liveActor({
  id: "actor-duplicate-fence",
  currency: { pp: 0, gp: 0, ep: 0, sp: 0, cp: 0 },
  items: [stolen],
});
const duplicateFence = await applyFenceOperation(duplicateFenceActor, {
  ...fenceOperation,
  itemSnapshots: [stolen, stolen],
});
assert.equal(duplicateFence.ok, false);
assert.equal(duplicateFence.reason, "invalid-fencing-bundle");
assert.ok(duplicateFenceActor.items.has(stolen._id));

const forgedFenceWallet = await applyFenceOperation(duplicateFenceActor, {
  ...fenceOperation,
  walletAfter: { pp: 0, gp: 999, ep: 0, sp: 0, cp: 0 },
});
assert.equal(forgedFenceWallet.ok, false);
assert.equal(forgedFenceWallet.reason, "invalid-fencing-wallet-plan");
assert.ok(duplicateFenceActor.items.has(stolen._id));
assert.deepEqual(
  duplicateFenceActor.system.currency,
  fenceOperation.walletBefore,
);

const tamperedStolen = structuredClone(stolen);
tamperedStolen.flags["infinity-dnd5e"].stolen.appraisedValueCp = 99_999;
const tamperedActor = liveActor({
  id: "actor-tampered-stolen",
  currency: { pp: 0, gp: 0, ep: 0, sp: 0, cp: 0 },
  items: [tamperedStolen],
});
assert.equal(
  (await applyStolenItemDelivery(tamperedActor, stolen)).reason,
  "item-create-conflict",
  "a same-operation item with altered provenance is not accepted as an applied theft",
);
assert.equal(
  (await removeStolenItemDelivery(tamperedActor, stolen)).reason,
  "stolen-item-conflict",
  "compensation never removes an item whose provenance no longer matches the plan",
);
const tamperedFence = await applyFenceOperation(tamperedActor, {
  ...fenceOperation,
  itemSnapshots: [stolen],
});
assert.equal(tamperedFence.ok, false);
assert.equal(tamperedFence.reason, "stolen-bundle-drift");
assert.ok(tamperedActor.items.has(stolen._id));
assert.deepEqual(
  tamperedActor.system.currency,
  fenceOperation.walletBefore,
  "a tampered bundle is rejected before either inventory or currency changes",
);

delete globalThis.fromUuid;
console.log("downtime item adapter validation passed");
