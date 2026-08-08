import assert from "node:assert/strict";

import {
  AMMUNITION_RECIPES,
  actorHasAnyTool,
  applyAmmoCraftOperation,
  applyFenceOperation,
  ammoCraftCostCp,
  buildAmmoCraftOperation,
  buildStolenCoinPurse,
  cleanAmmoStack,
  isStolenItem,
  markStolenSnapshot,
  planWalletDeltaCp,
  stolenItemValueCp,
  stolenProvenance,
} from "./downtime/items.js";
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
    system: { quantity: 1, rarity: "common", properties: [] },
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
    system: { quantity: 1, rarity: "uncommon", properties: ["mgc"] },
    flags: {},
  };
  const cleanStack = {
    id: `${recipeId}-clean`,
    name,
    type: "consumable",
    system: { quantity: 3, rarity: "common", properties: [] },
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
          system: { quantity: 1, rarity: "uncommon", properties: ["mgc"] },
          flags: { core: { sourceId: AMMUNITION_RECIPES.arrows.uuid } },
        },
      ],
    },
    "arrows",
  ),
  null,
  "a canonical source UUID must not let magical ammunition join a clean stack",
);

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
  },
  flags: { core: { sourceId: uuid } },
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

delete globalThis.fromUuid;
console.log("downtime item adapter validation passed");
