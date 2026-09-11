import assert from "node:assert/strict";
import {
  applyGuidedWork,
  buildGuidedWorkPlan,
  guidedWorkPreset,
  inspectGuidedWork,
  normalizeGuidedWork,
  projectGuidedWork,
  quoteGuidedWork,
  recoverGuidedWork,
  SCROLL_WORK,
  scrollSourceLevel,
  verifyGuidedWorkBefore,
} from "./downtime/work.js";
import { planWalletDeltaCp } from "./downtime/items.js";
import { defaultGuidedDowntimeTemplates } from "./downtime/dispatch.js";

const moduleId = "infinity-dnd5e";
const saved = { fromUuid: globalThis.fromUuid, CONFIG: globalThis.CONFIG };
const clone = (value) => structuredClone(value);
const snapshot = {
  _id: "source",
  name: "Arrows",
  type: "consumable",
  system: {
    quantity: 20,
    type: { value: "ammo" },
    price: { value: 1, denomination: "gp" },
  },
};
globalThis.fromUuid = async () => clone(snapshot);
function actor(gp = 100) {
  const result = {
    id: "crafter",
    name: "Crafter",
    system: { currency: { pp: 0, gp, ep: 0, sp: 0, cp: 0 } },
    items: new Map(),
    writes: 0,
    async update(changes) {
      this.writes++;
      for (const [key, value] of Object.entries(changes))
        this.system.currency[key.split(".").at(-1)] = value;
      return this;
    },
    async createEmbeddedDocuments(_type, sources) {
      this.writes++;
      return sources.map((source) => this.add(source));
    },
    async deleteEmbeddedDocuments(_type, ids) {
      this.writes++;
      return ids.map((id) => {
        const item = this.items.get(id);
        this.items.delete(id);
        return item;
      });
    },
    add(source) {
      const item = {
        ...clone(source),
        id: source._id,
        toObject() {
          const { id, toObject, update, ...data } = this;
          return clone(data);
        },
        async update(changes) {
          result.writes++;
          if (Object.hasOwn(changes, "system.quantity"))
            this.system.quantity = changes["system.quantity"];
          return this;
        },
      };
      this.items.set(item.id, item);
      return item;
    },
  };
  result.add({
    _id: "fletcher",
    name: "Fletcher's Tools",
    type: "tool",
    system: { quantity: 1 },
  });
  return result;
}
function material(a, id, count) {
  return a.add({
    _id: id,
    name: "Iron",
    type: "loot",
    system: { quantity: count },
  });
}
function spell(a, level = 1) {
  return a.add({
    _id: `spell${level}`,
    name: `Spell ${level}`,
    type: "spell",
    system: { level, activities: { cast: { type: "save" } } },
  });
}
const args = (a, activity, extra = {}) => ({
  actor: a,
  activity: { ...activity, id: "work" },
  hours: 8,
  operationId: "work-operation",
  ...extra,
});
async function operation(options) {
  const work = await buildGuidedWorkPlan(options);
  return {
    operationId: options.operationId,
    actorId: options.actor.id,
    settlementId: "guided",
    kind: "guided-work",
    work,
    walletBefore: clone(options.actor.system.currency),
    walletAfter: planWalletDeltaCp(options.actor.system.currency, -work.costCp),
  };
}
const authorized = { authorizeWrite: () => true };
try {
  assert.equal(normalizeGuidedWork(undefined), null);
  assert.equal(normalizeGuidedWork({}), null);
  const library = defaultGuidedDowntimeTemplates();
  for (const [id, dailyCp] of [
    ["guided-training", 100],
    ["guided-contacts", 100],
    ["guided-care", 50],
  ]) {
    const activity = library.find((entry) => entry.id === id);
    for (const hours of [4, 8, 24]) {
      const quote = quoteGuidedWork(args(actor(), activity, { hours }));
      assert.equal(quote.costCp, (dailyCp * hours) / 8);
      assert.equal(
        quote.outputQuantity,
        0,
        "narrative activities do not create items",
      );
    }
  }
  for (const bad of [-1, NaN, Infinity, "oops", 0.001, 100001])
    assert.throws(() => normalizeGuidedWork({ gpPerDay: bad }), /GP per day/);
  for (const bad of [0, -1, 0.5, 10001])
    assert.throws(
      () => normalizeGuidedWork({ batchHours: bad }),
      /Hours per batch/,
    );
  assert.throws(
    () =>
      normalizeGuidedWork({
        output: "item",
        itemUuid: "Actor.secret.Item.secret",
      }),
    /UUID/,
  );
  assert.throws(
    () =>
      normalizeGuidedWork({
        materials: [{ name: "Ink", quantity: 1, per: "batch" }],
      }),
    /without crafted items/,
  );
  assert.throws(
    () =>
      normalizeGuidedWork({
        output: "arrows",
        materials: [
          { name: "Iron", quantity: 1 },
          { name: "iron", quantity: 2 },
        ],
      }),
    /duplicate/,
  );
  const arrow = guidedWorkPreset("arrows");
  assert.equal(arrow.work.batchGp, 0.5, "arrows use GP for ordinary materials");
  assert.deepEqual(
    arrow.work.materials,
    [],
    "ordinary arrow supplies need no separate inventory item",
  );
  assert.deepEqual(arrow.work.requiredTools, ["Fletcher's Tools"]);
  const missingTools = actor();
  missingTools.items.clear();
  missingTools.add({
    _id: "smith",
    name: "Smith's Tools",
    type: "tool",
    system: { quantity: 1 },
  });
  assert.equal(
    projectGuidedWork(missingTools, arrow, 8).available,
    false,
    "Smith's Tools alone cannot unlock the Fletcher recipe",
  );
  assert.match(
    projectGuidedWork(missingTools, arrow, 8).unavailableReason,
    /Fletcher's Tools/,
  );
  const carriedKit = missingTools.add({
    _id: "fletcher",
    name: "Fletcher’s Tools",
    type: "tool",
    system: { quantity: 0 },
  });
  assert.equal(
    projectGuidedWork(missingTools, arrow, 8).available,
    false,
    "empty stacks do not count",
  );
  carriedKit.system.quantity = 1;
  assert.equal(
    projectGuidedWork(missingTools, arrow, 8).available,
    true,
    "a carried kit unlocks arrows, including typographic apostrophes",
  );
  const multipleTools = {
    ...arrow,
    work: {
      ...arrow.work,
      requiredTools: ["Fletcher's Tools", "Smith's Tools"],
    },
  };
  assert.equal(
    projectGuidedWork(actor(), multipleTools, 8).available,
    false,
    "every selected tool is required",
  );
  const multiPlan = await operation(args(missingTools, multipleTools));
  assert.equal(multiPlan.work.tools.length, 2);
  carriedKit.system.quantity = 0;
  assert.equal(verifyGuidedWorkBefore(missingTools, multiPlan), false);
  assert.equal(
    (await applyGuidedWork(missingTools, multiPlan, authorized)).ok,
    false,
  );
  assert.equal(
    missingTools.writes,
    0,
    "losing tools after review stops all costs and output",
  );
  carriedKit.system.quantity = 0.5;
  assert.equal(
    verifyGuidedWorkBefore(missingTools, multiPlan),
    false,
    "a fraction of a kit cannot satisfy the requirement after review",
  );
  carriedKit.system.quantity = 1;
  assert.equal(
    (await applyGuidedWork(missingTools, multiPlan, authorized)).ok,
    true,
  );
  assert.equal(carriedKit.system.quantity, 1, "required kits are reusable");
  assert.throws(
    () => normalizeGuidedWork({ requiredTools: ["Not a catalog tool"] }),
    /tool list/,
  );
  assert.throws(
    () => normalizeGuidedWork({ requiredTools: "Fletcher's Tools" }),
    /eight/,
  );
  assert.throws(
    () =>
      normalizeGuidedWork({
        output: "arrows",
        requiredTools: ["Fletcher's Tools"],
        materials: [{ name: "Fletcher's Tools", quantity: 1 }],
      }),
    /cannot also be consumed/,
  );
  const legacyRecipe = { ...arrow, work: { ...arrow.work } };
  delete legacyRecipe.work.requiredTools;
  const legacyCrafter = actor();
  legacyCrafter.items.clear();
  legacyCrafter.add({
    _id: "smith",
    name: "Smith's Tools",
    type: "tool",
    system: { quantity: 1 },
  });
  assert.equal(
    projectGuidedWork(legacyCrafter, legacyRecipe, 8).available,
    true,
    "existing block snapshots retain their legacy tool rules",
  );
  globalThis.fromUuid = async () => null;
  await assert.rejects(
    buildGuidedWorkPlan(args(actor(), arrow, { hours: 4 })),
    /could not be loaded/,
    "an unavailable output blocks even a partial first payment",
  );
  globalThis.fromUuid = async () => clone(snapshot);
  const crafter = actor();
  const half = quoteGuidedWork(args(crafter, arrow, { hours: 4 }));
  assert.equal(half.costCp, 25);
  assert.equal(half.batches, 0);
  assert.equal(half.remainingHours, 4);
  const finish = quoteGuidedWork(
    args(crafter, arrow, { hours: 4, progress: { [half.key]: 4 } }),
  );
  assert.equal(finish.costCp, 25);
  assert.equal(finish.outputQuantity, 20);
  assert.equal(finish.remainingHours, 0);
  const other = actor();
  other.id = "other";
  assert.equal(
    quoteGuidedWork(
      args(other, arrow, { hours: 4, progress: { [half.key]: 4 } }),
    ).batches,
    0,
    "hours belong to one character",
  );
  assert.equal(
    quoteGuidedWork(args(crafter, arrow, { hours: 16 })).outputQuantity,
    40,
  );
  assert.equal(quoteGuidedWork(args(actor(0), arrow)).ok, false);
  const noTools = actor();
  noTools.items.clear();
  assert.match(
    quoteGuidedWork(args(noTools, arrow)).problems.join(" "),
    /Required tools/,
  );
  const charged = {
    ...arrow,
    work: {
      ...arrow.work,
      gpPerBlock: 1,
      gpPerDay: 2,
      materials: [{ name: "Iron", quantity: 3, per: "batch" }],
    },
  };
  const partialMaterialActor = actor();
  assert.equal(
    projectGuidedWork(partialMaterialActor, charged, 4).available,
    false,
    "an explicit physical-material requirement also gates unfinished work",
  );
  const partOne = material(partialMaterialActor, "one", 1);
  const partTwo = material(partialMaterialActor, "two", 2);
  assert.equal(
    projectGuidedWork(partialMaterialActor, charged, 4).available,
    true,
    "carried stacks combine to meet the requirement",
  );
  const partialMaterialPlan = await operation(
    args(partialMaterialActor, charged, { hours: 4 }),
  );
  partTwo.system.quantity = 1;
  assert.equal(
    verifyGuidedWorkBefore(partialMaterialActor, partialMaterialPlan),
    false,
  );
  assert.equal(
    (
      await applyGuidedWork(
        partialMaterialActor,
        partialMaterialPlan,
        authorized,
      )
    ).ok,
    false,
  );
  assert.equal(
    partialMaterialActor.writes,
    0,
    "removing materials after review blocks costs and output",
  );
  partTwo.system.quantity = 2;
  assert.equal(
    (
      await applyGuidedWork(
        partialMaterialActor,
        partialMaterialPlan,
        authorized,
      )
    ).ok,
    true,
  );
  assert.equal(
    partOne.system.quantity + partTwo.system.quantity,
    3,
    "unfinished batch materials are held, not prematurely consumed",
  );
  assert.equal(
    quoteGuidedWork(args(partialMaterialActor, charged, { hours: 12 })).ok,
    false,
    "a finished batch plus another started batch needs both sets of materials",
  );
  material(crafter, "iron1", 1);
  material(crafter, "iron2", 4);
  const plan = await operation(args(crafter, charged));
  assert.equal(plan.work.costCp, 350);
  assert.deepEqual(
    plan.work.materials.map(({ before, after }) => [before, after]),
    [
      [1, 0],
      [4, 2],
    ],
  );
  assert.equal(crafter.writes, 0, "previews never spend or create");
  assert.equal(verifyGuidedWorkBefore(crafter, plan), true);
  assert.equal((await applyGuidedWork(crafter, plan, authorized)).ok, true);
  assert.equal(inspectGuidedWork(crafter, plan), "applied");
  assert.equal(crafter.items.get("iron1").system.quantity, 0);
  assert.equal(crafter.items.get("iron2").system.quantity, 2);
  assert.equal(crafter.items.get("fletcher").system.quantity, 1);
  assert.equal(
    crafter.items.get(plan.work.delivery.itemId).system.quantity,
    20,
  );
  const writes = crafter.writes;
  assert.equal((await applyGuidedWork(crafter, plan, authorized)).ok, false);
  assert.equal(crafter.writes, writes, "fresh retry cannot double-spend");
  const daily = quoteGuidedWork(
    args(actor(), { work: { gpPerDay: 0.01 } }, { hours: 1 }),
  );
  assert.equal(daily.costCp, 1, "sub-copper daily costs round up");
  const dailyAgain = quoteGuidedWork(
    args(
      actor(),
      { work: { gpPerDay: 0.01 } },
      { hours: 7, progress: { [daily.key]: 1 } },
    ),
  );
  assert.equal(
    dailyAgain.costCp,
    0,
    "prior rounded daily charges are not taken twice",
  );
  const dailyMaterialsActor = actor();
  material(dailyMaterialsActor, "iron", 3);
  const dailyMaterials = quoteGuidedWork(
    args(
      dailyMaterialsActor,
      { work: { materials: [{ name: "Iron", quantity: 1, per: "day" }] } },
      { hours: 9 },
    ),
  );
  assert.equal(
    dailyMaterials.materials[0].after,
    1,
    "whole supplies prorate then round up",
  );

  const scroll = guidedWorkPreset("scroll");
  globalThis.CONFIG = {
    Item: {
      documentClass: {
        async createScrollFromSpell(item, _options, config) {
          assert.equal(config.dialog, false);
          return {
            toObject: () => ({
              name: `Spell Scroll: ${item.name}`,
              type: "consumable",
              system: {
                quantity: 1,
                type: { value: "scroll" },
                uses: { spent: 0, max: "1" },
                activities: clone(item.system.activities),
              },
              flags: { dnd5e: { spellLevel: { value: item.system.level } } },
            }),
          };
        },
      },
    },
  };
  for (let level = 0; level <= 9; level++) {
    const scribe = actor(100000);
    const owned = spell(scribe, level);
    const options = args(scribe, scroll, { targetId: owned.id });
    const quote = quoteGuidedWork(options);
    assert.equal(quote.requiredHours, SCROLL_WORK[level][0] * 8);
    let total = 0;
    for (let hour = 0; hour < quote.requiredHours; hour++) {
      total += quoteGuidedWork({
        ...options,
        hours: 1,
        progress: { [quote.key]: hour },
      }).costCp;
    }
    assert.equal(
      total,
      SCROLL_WORK[level][1] * 100,
      `level ${level} never overcharges across one-hour sessions`,
    );
    const final = await operation({
      ...options,
      hours: 1,
      progress: { [quote.key]: quote.requiredHours - 1 },
    });
    assert.equal(final.work.delivery.quantity, 1);
    assert.equal((await applyGuidedWork(scribe, final, authorized)).ok, true);
    assert.equal(
      scribe.items.get(owned.id),
      owned,
      "scribing keeps the known spell",
    );
    assert.equal(
      scribe.items.get(final.work.delivery.itemId).type,
      "consumable",
    );
  }
  const copier = actor();
  const original = copier.add({
    _id: "original",
    name: "Scroll of Light",
    type: "consumable",
    system: {
      quantity: 1,
      type: { value: "scroll" },
      uses: { spent: 1, max: "1" },
    },
    flags: { [moduleId]: { spellScroll: { spellLevel: 0 } } },
  });
  assert.equal(
    scrollSourceLevel(original),
    0,
    "curated scroll metadata is recognized",
  );
  const copied = await operation(
    args(copier, scroll, { targetId: original.id }),
  );
  assert.equal((await applyGuidedWork(copier, copied, authorized)).ok, true);
  assert.equal(original.system.quantity, 1);
  assert.equal(
    original.system.uses.spent,
    1,
    "copy never changes source charges",
  );
  assert.equal(
    copier.items.get(copied.work.delivery.itemId).system.uses.spent,
    0,
  );
  const poor = actor(0);
  const previewActor = actor(1000);
  const previewSpell = spell(previewActor, 2);
  const previews = projectGuidedWork(
    previewActor,
    { ...scroll, blockHours: 8 },
    8,
    {},
    "custom",
    24,
  ).allocationQuotes;
  assert.deepEqual(
    previews.map((row) => row.hours),
    [8, 16, 24],
  );
  const sixteen = previews
    .find((row) => row.hours === 16)
    .targets.find((row) => row.id === previewSpell.id);
  assert.equal(
    sixteen.detail.trim(),
    quoteGuidedWork(
      args(previewActor, scroll, { hours: 16, targetId: previewSpell.id }),
    ).detail,
  );
  assert.notEqual(
    sixteen.detail,
    previews[0].targets.find((row) => row.id === previewSpell.id).detail,
    "different allocations receive different authoritative quotes",
  );
  spell(poor);
  assert.equal(projectGuidedWork(poor, scroll, 8).available, false);
  assert.equal(projectGuidedWork(poor, scroll, 8).targets[0].disabled, true);
  await assert.rejects(
    buildGuidedWorkPlan(args(poor, scroll, { targetId: "spell1" })),
    /available/,
  );

  // Hook cancellation, lost replies, interruption, and unrelated drift.
  for (const failure of [
    "material-cancel",
    "create-cancel",
    "wallet-lost-reply",
    "create-lost-reply",
  ]) {
    const a = actor();
    const iron = material(a, "iron", 5);
    const op = await operation(args(a, charged));
    if (failure === "material-cancel") iron.update = async () => undefined;
    if (failure === "create-cancel") a.createEmbeddedDocuments = async () => [];
    if (failure === "wallet-lost-reply") {
      const update = a.update;
      let first = true;
      a.update = async function (changes) {
        const result = await update.call(this, changes);
        if (first) {
          first = false;
          throw new Error("lost reply");
        }
        return result;
      };
    }
    if (failure === "create-lost-reply") {
      const create = a.createEmbeddedDocuments;
      a.createEmbeddedDocuments = async function (...params) {
        await create.apply(this, params);
        throw new Error("lost reply");
      };
    }
    const result = await applyGuidedWork(a, op, authorized);
    if (failure === "create-lost-reply") {
      assert.equal(result.ok, true);
      assert.equal(inspectGuidedWork(a, op), "applied");
    } else {
      assert.equal(result.ok, false, failure);
      assert.equal(result.provenUnapplied, true, failure);
      assert.deepEqual(a.system.currency, op.walletBefore);
      assert.equal(iron.system.quantity, 5);
      assert.equal(a.items.has(op.work.delivery.itemId), false);
    }
  }
  const interrupted = actor();
  material(interrupted, "iron", 5);
  const interruptedPlan = await operation(args(interrupted, charged));
  let authority = true;
  const update = interrupted.update;
  interrupted.update = async function (changes) {
    const result = await update.call(this, changes);
    authority = false;
    return result;
  };
  const interruptedResult = await applyGuidedWork(
    interrupted,
    interruptedPlan,
    { authorizeWrite: () => authority },
  );
  assert.equal(interruptedResult.reason, "authority-lost");
  assert.equal(
    interrupted.writes,
    1,
    "authority loss fences all subsequent writes and rollback",
  );
  interrupted.update = update;
  authority = true;
  assert.equal(
    await recoverGuidedWork(interrupted, interruptedPlan, authorized),
    true,
  );
  assert.deepEqual(interrupted.system.currency, interruptedPlan.walletBefore);
  assert.equal(
    (await applyGuidedWork(interrupted, interruptedPlan, authorized)).ok,
    true,
  );
  const drifted = actor();
  material(drifted, "iron", 5);
  const driftPlan = await operation(args(drifted, charged));
  drifted.system.currency = clone(driftPlan.walletAfter);
  drifted.items.get("iron").name = "Unrelated relic";
  assert.equal(await recoverGuidedWork(drifted, driftPlan, authorized), false);
  assert.equal(
    drifted.writes,
    0,
    "recovery never overwrites changed inventory",
  );
  const altered = actor();
  const htmlActor = actor();
  globalThis.fromUuid = async () => ({
    ...clone(snapshot),
    system: {
      ...clone(snapshot.system),
      description: { value: "<p>&Reference[Spell Scroll]</p>" },
    },
  });
  const htmlPlan = await operation(args(htmlActor, arrow));
  const createHtml = htmlActor.createEmbeddedDocuments;
  htmlActor.createEmbeddedDocuments = async function (type, sources) {
    const created = await createHtml.call(this, type, sources);
    created[0].system.description.value =
      created[0].system.description.value.replace(/&/g, "&amp;");
    return created;
  };
  assert.equal(
    (await applyGuidedWork(htmlActor, htmlPlan, authorized)).ok,
    true,
    "Foundry HTML escaping does not masquerade as an altered item",
  );
  globalThis.fromUuid = async () => clone(snapshot);
  material(altered, "iron", 5);
  const alteredPlan = await operation(args(altered, charged));
  const create = altered.createEmbeddedDocuments;
  altered.createEmbeddedDocuments = async function (type, sources) {
    const items = await create.call(this, type, sources);
    items[0].system.type.value = "poison";
    return items;
  };
  assert.equal(
    (await applyGuidedWork(altered, alteredPlan, authorized)).ok,
    false,
  );
  assert.equal(
    inspectGuidedWork(altered, alteredPlan),
    "uncertain",
    "a changed crafted item requires review",
  );
} finally {
  for (const [key, value] of Object.entries(saved))
    value === undefined ? delete globalThis[key] : (globalThis[key] = value);
}
console.log(
  "guided crafting costs, supplies, scrolls, and interrupted writes passed",
);
