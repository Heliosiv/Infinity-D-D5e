import "./test-utils/private-state-memory-transport.mjs";
import assert from "node:assert/strict";

const saved = Object.fromEntries(
  [
    "game",
    "foundry",
    "CONST",
    "JournalEntry",
    "Hooks",
    "fromUuid",
    "localStorage",
    "Roll",
    "ChatMessage",
  ].map((key) => [key, globalThis[key]]),
);

const MODULE_ID = "infinity-dnd5e";
const settings = new Map();
let settingWrites = 0;
let randomId = 0;

function clone(value) {
  return value == null ? value : structuredClone(value);
}

function ownedItem(actor, source) {
  const item = {
    ...clone(source),
    id: String(source.id ?? source._id),
    parent: actor,
    toObject() {
      return clone({
        ...source,
        _id: this.id,
        id: this.id,
        name: this.name,
        system: this.system,
        flags: this.flags,
      });
    },
    async update(changes) {
      if (Object.hasOwn(changes, "system.quantity")) {
        this.system.quantity = Number(changes["system.quantity"]);
      }
      return this;
    },
  };
  return item;
}

function makeActor({ id = "actor-1", ownerId = "player-1", currency } = {}) {
  const items = new Map();
  const actor = {
    id,
    name: "Mira",
    img: "icons/svg/mystery-man.svg",
    type: "character",
    ownership: { default: 0, [ownerId]: 3 },
    system: {
      currency: clone(currency ?? { pp: 0, gp: 1, ep: 0, sp: 0, cp: 0 }),
    },
    items,
    async update(changes) {
      for (const [path, value] of Object.entries(changes ?? {})) {
        const match = /^system\.currency\.(pp|gp|ep|sp|cp)$/.exec(path);
        if (match) this.system.currency[match[1]] = Number(value) || 0;
      }
      return this;
    },
    async createEmbeddedDocuments(type, sources) {
      assert.equal(type, "Item");
      return sources.map((source) => {
        const item = ownedItem(actor, source);
        items.set(item.id, item);
        return item;
      });
    },
    async deleteEmbeddedDocuments(type, ids) {
      assert.equal(type, "Item");
      return ids.flatMap((itemId) => {
        const item = items.get(itemId);
        if (!item) return [];
        items.delete(itemId);
        return [item];
      });
    },
  };
  actor.addItem = (source) => {
    const item = ownedItem(actor, source);
    items.set(item.id, item);
    return item;
  };
  return actor;
}

try {
  const gm = {
    id: "gm-1",
    name: "Game Master",
    isGM: true,
    role: 4,
    active: true,
  };
  const player = {
    id: "player-1",
    name: "Player One",
    isGM: false,
    role: 1,
    active: true,
    character: null,
  };
  const assistant = {
    id: "assistant-1",
    name: "Assistant One",
    isGM: true,
    role: 3,
    active: true,
    character: null,
  };
  const users = new Map([
    [gm.id, gm],
    [player.id, player],
    [assistant.id, assistant],
  ]);
  users.activeGM = gm;
  const actor = makeActor();
  const actors = new Map([[actor.id, actor]]);
  const socketEmissions = [];

  globalThis.CONST = {
    ACTIVE_EFFECT_MODES: { ADD: 2 },
    DOCUMENT_OWNERSHIP_LEVELS: { NONE: 0, OWNER: 3 },
    USER_ROLES: { GAMEMASTER: 4 },
  };
  globalThis.foundry = {
    utils: {
      deepClone: clone,
      randomID: () => `service-${++randomId}`,
    },
  };
  delete globalThis.JournalEntry;
  globalThis.game = {
    ready: false,
    user: gm,
    users,
    actors,
    time: { serverTime: 1_000 },
    socket: {
      emit(...args) {
        socketEmissions.push(args);
      },
    },
    settings: {
      get(moduleId, key) {
        assert.equal(moduleId, MODULE_ID);
        return clone(settings.get(key));
      },
      async set(moduleId, key, value) {
        assert.equal(moduleId, MODULE_ID);
        settingWrites += 1;
        settings.set(key, clone(value));
        return value;
      },
    },
  };

  const local = new Map();
  globalThis.localStorage = {
    getItem: (k) => local.get(k) ?? null,
    setItem: (k, v) => local.set(k, v),
  };
  game.world = { id: "hunting-test" };
  const workflow = await import("./downtime/store.js");
  const privateState = await import("./private-state.js");
  privateState.resetPrivateStateForTests();
  workflow.resetDowntimeWorkflowStoreForTests();
  const service = await import("./downtime/service.js");
  const rules = await import("./downtime/hunting.js");
  const equipment = await import("./downtime/hunting-equipment.js");
  const secrets = await import("./downtime/hunting-store.js");
  const inventory = await import("./downtime/work.js");
  const regions = rules.defaultHuntingRegions();
  const forest = regions.find((r) => r.id === "biome-forest");
  assert.equal(rules.huntingDc(10, 4), 10);
  assert.equal(rules.huntingDc(10, 8), 6);
  assert.throws(() => rules.huntingDc(10, 12), /four-hour/);
  assert.equal(rules.findHuntingGame(forest, 4, 11, 100, 100).band, "success");
  assert.equal(
    rules.findHuntingGame(forest, 8, 11, 100, 100).band,
    "exceptional",
  );
  assert.equal(rules.findHuntingGame(forest, 8, 11, 100, 1).complication, true);
  assert.equal(rules.findHuntingGame(forest, 8, 11, 100, 100).gameIndex, 2);
  assert.equal(rules.findHuntingGame(forest, 4, 9, 100, 100).gameIndex, -1);
  assert.throws(
    () => rules.normalizeHuntingRegion({ ...forest, game: [forest.game[0]] }),
    /100%/,
  );
  const publicRegion = rules.publicHuntingRegion(forest);
  assert.ok(!JSON.stringify(publicRegion).includes('"dc"'));
  assert.ok(!JSON.stringify(publicRegion).includes('"ac"'));
  assert.equal(rules.huntingHit(99, 1, 12), false);
  assert.equal(rules.huntingHit(0, 20, 12), true);
  const weapon = actor.addItem({
    _id: "bow1",
    name: "Longbow",
    type: "weapon",
    system: {
      quantity: 1,
      properties: ["amm"],
      ammunition: { type: "arrow" },
      activities: [
        {
          id: "attack1",
          type: "attack",
          attack: { type: { value: "ranged", classification: "weapon" } },
        },
      ],
    },
  });
  Object.defineProperty(weapon.system.activities[0], "getAttackData", {
    value: () => ({ parts: ["@bonus"], data: { bonus: 5 } }),
  });
  const ammo = actor.addItem({
    _id: "arrows1",
    name: "Arrows",
    type: "consumable",
    system: { quantity: 10, type: { value: "ammo", subtype: "arrow" } },
  });
  actor.addItem({
    _id: "bolts1",
    name: "Bolts",
    type: "consumable",
    system: { quantity: 10, type: { value: "ammo", subtype: "bolt" } },
  });
  assert.equal(equipment.huntingEquipmentOptions(actor).length, 1);
  const targetId = equipment.huntingEquipmentOptions(actor)[0].id;
  assert.throws(
    () => equipment.requireHuntingEquipment(actor, "bow1:attack1:bolts1"),
    /compatible/,
  );
  globalThis.fromUuid = async () => ({
    toObject: () => ({
      _id: "ration-source",
      name: "Rations",
      type: "consumable",
      system: { quantity: 1, type: { value: "food" } },
      flags: {
        core: { sourceId: "Compendium.dnd5e.items.Item.f4w4GxBi0nYXmhX4" },
      },
    }),
  });
  const custom = secrets.saveHuntingRegion({
    ...forest,
    id: "custom-marsh",
    name: "Old Marsh",
    activityIds: [rules.HUNTING_ID, "guided-scouting"],
  });
  assert.equal(
    secrets.loadHuntingRegions().find((r) => r.id === custom.id).name,
    "Old Marsh",
  );
  const open = () =>
    service.openDowntimeBlock({
      mode: "guided",
      locationPresetId: custom.id,
      hours: 8,
      actorIds: [actor.id],
      templateIds: [rules.HUNTING_ID],
    });
  const queue = (total, hours = 8) => [
    {
      id: "hunt",
      activityId: rules.HUNTING_ID,
      hours,
      skill: "sur",
      targetId,
      guidedRoll: { total, formula: "1d20+5" },
    },
  ];
  let block = await open();
  assert.ok(!JSON.stringify(block).includes('"dc"'));
  assert.ok(!JSON.stringify(block).includes('"ac"'));
  await assert.rejects(
    service.submitQueueAuthoritatively({
      userId: player.id,
      requestId: "bad-hours",
      blockId: block.id,
      actorId: actor.id,
      queue: queue(11, 12),
    }),
    /four or eight/,
  );
  block = await service.submitQueueAuthoritatively({
    userId: player.id,
    requestId: "track",
    blockId: block.id,
    actorId: actor.id,
    queue: queue(11),
  });
  let hunt = block.participants[0].hunt;
  assert.equal(hunt.stage, "attack");
  assert.equal(hunt.band, "exceptional");
  assert.equal(ammo.system.quantity, 10);
  const projection = await service.getPlayerProjectionForUser({
    userId: player.id,
    actorId: actor.id,
  });
  assert.equal(projection.huntingPending, true);
  assert.equal(projection.canRecall, false);
  assert.ok(!JSON.stringify(projection).includes('"ac"'));
  assert.ok(!JSON.stringify(projection).includes('"dc"'));
  await assert.rejects(
    service.submitQueueAuthoritatively({
      userId: player.id,
      requestId: "reroll",
      blockId: block.id,
      actorId: actor.id,
      queue: queue(20),
    }),
    /cannot be edited/,
  );
  await assert.rejects(
    service.recallSubmissionAuthoritatively({
      userId: player.id,
      requestId: "recall",
      blockId: block.id,
      actorId: actor.id,
    }),
    /cannot be recalled/,
  );
  const shot = { total: 25, formula: "1d20+5", natural: 20 };
  block = await service.submitQueueAuthoritatively({
    userId: player.id,
    requestId: "shot",
    blockId: block.id,
    actorId: actor.id,
    queue: queue(11).map((e) => ({ ...e, guidedAttack: shot })),
  });
  assert.equal(block.participants[0].hunt.hit, true);
  const food = block.participants[0].hunt.game.food;
  block = await service.submitQueueAuthoritatively({
    userId: player.id,
    requestId: "shot",
    blockId: block.id,
    actorId: actor.id,
    queue: queue(11).map((e) => ({ ...e, guidedAttack: shot })),
  });
  assert.equal(block.participants[0].hunt.hit, true);
  await service.prepareGuidedDowntimeParticipant({
    blockId: block.id,
    actorId: actor.id,
  });
  const planned = workflow.getActiveDowntimeBlock();
  assert.equal(planned.plan.operations[0].hunting, true);
  const operation = planned.plan.operations[0];
  assert.equal(inventory.verifyGuidedWorkBefore(actor, operation), true);
  ammo.system.quantity = 12;
  assert.equal(inventory.verifyGuidedWorkBefore(actor, operation), false);
  ammo.system.quantity = 10;
  const weaponName = weapon.name;
  weapon.name = "Different bow";
  assert.equal(inventory.verifyGuidedWorkBefore(actor, operation), false);
  weapon.name = weaponName;
  await service.applyActiveDowntimeBlock(block.id);
  assert.equal(inventory.inspectGuidedWork(actor, operation), "applied");
  assert.equal(ammo.system.quantity, 9);
  const delivery = [...actor.items.values()].find(
    (i) => i.flags?.[MODULE_ID]?.downtimeCraft,
  );
  assert.ok(delivery);
  assert.equal(delivery.system.quantity, food);
  assert.equal(delivery.flags[MODULE_ID].resourceTag, "food");
  assert.equal(
    delivery.flags.core.sourceId,
    "Compendium.dnd5e.items.Item.f4w4GxBi0nYXmhX4",
  );
  assert.equal(weapon.system.quantity, 1);
  assert.equal(
    Object.keys(workflow.loadDowntimeWorkflowStore().workProgress ?? {}).length,
    0,
  );
  if (workflow.getActiveDowntimeBlock()?.state === "collecting")
    await service.finishGuidedDowntimeBlock(block.id);
  const journal = await service.getPlayerProjectionForUser({
    userId: player.id,
    actorId: actor.id,
  });
  assert.match(JSON.stringify(journal), /secured/);
  block = await open();
  block = await service.submitQueueAuthoritatively({
    userId: player.id,
    requestId: "miss-track",
    blockId: block.id,
    actorId: actor.id,
    queue: queue(11),
  });
  block = await service.submitQueueAuthoritatively({
    userId: player.id,
    requestId: "miss-shot",
    blockId: block.id,
    actorId: actor.id,
    queue: queue(11).map((e) => ({
      ...e,
      guidedAttack: { total: 1, formula: "1d20", natural: 1 },
    })),
  });
  assert.equal(block.participants[0].hunt.hit, false);
  await assert.rejects(
    service.submitQueueAuthoritatively({
      userId: player.id,
      requestId: "second-shot",
      blockId: block.id,
      actorId: actor.id,
      queue: queue(11).map((e) => ({ ...e, guidedAttack: shot })),
    }),
    /already|Recall/,
  );
  await service.prepareGuidedDowntimeParticipant({
    blockId: block.id,
    actorId: actor.id,
  });
  await service.applyActiveDowntimeBlock(block.id);
  assert.equal(ammo.system.quantity, 8);
  assert.equal(
    [...actor.items.values()].filter((i) => i.flags?.[MODULE_ID]?.downtimeCraft)
      .length,
    1,
  );
  if (workflow.getActiveDowntimeBlock()?.state === "collecting")
    await service.finishGuidedDowntimeBlock(block.id);
  block = await open();
  block = await service.submitQueueAuthoritatively({
    userId: player.id,
    requestId: "failed-track",
    blockId: block.id,
    actorId: actor.id,
    queue: queue(0),
  });
  assert.equal(block.participants[0].submitted, true);
  assert.equal(block.participants[0].hunt.stage, "done");
  await service.prepareGuidedDowntimeParticipant({
    blockId: block.id,
    actorId: actor.id,
  });
  await service.applyActiveDowntimeBlock(block.id);
  assert.equal(ammo.system.quantity, 8);
  if (workflow.getActiveDowntimeBlock()?.state === "collecting")
    await service.finishGuidedDowntimeBlock(block.id);
  // The one shot survives player reloads and lost submission replies.
  let dice = 0;
  globalThis.Roll = class {
    constructor() {
      this.total = 17;
      this.formula = "1d20+5";
      this.dice = [{ faces: 20, results: [{ result: 12, active: true }] }];
    }
    async evaluate() {
      dice++;
      return this;
    }
    async toMessage() {}
  };
  const firstShot = await equipment.rollHuntingAttack(
    actor,
    targetId,
    "cached-shot",
  );
  assert.deepEqual(
    await equipment.rollHuntingAttack(actor, targetId, "cached-shot"),
    firstShot,
  );
  assert.equal(dice, 1);
  assert.equal(ammo.system.quantity, 8);
  const beforeStore = local;
  globalThis.localStorage = { getItem: () => null, setItem: () => {} };
  await assert.rejects(
    equipment.rollHuntingAttack(actor, targetId, "blocked-storage"),
    /cannot be saved/,
  );
  assert.equal(dice, 1);
  assert.throws(() => secrets.loadHuntingBlock(block.id), /GM browser/);
  game.user = player;
  globalThis.localStorage = {
    getItem: (k) => beforeStore.get(k) ?? null,
    setItem: (k, v) => beforeStore.set(k, v),
  };
  assert.throws(() => secrets.loadHuntingRegions(), /full GM/);
  console.log(
    "Hunting: duration, game bands, private rules, custom areas, two-stage submission, hit/miss, food/ammunition, no rerolls and reports passed.",
  );
} finally {
  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) delete globalThis[key];
    else globalThis[key] = value;
  }
}
