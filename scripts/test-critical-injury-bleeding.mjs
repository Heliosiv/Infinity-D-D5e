import assert from "node:assert/strict";
import {
  processCombatBleeding,
  bleedingDamageAfter,
  skipPendingCombatBleeding,
} from "./injury/bleeding.js";
import {
  readCriticalInjuryBleeding,
  writeCriticalInjuryBleeding,
} from "./injury/workflow-store.js";
const MODULE = "infinity-dnd5e";
const gm = { id: "gm", active: true, isGM: true, role: 4 };
const nextGM = { id: "next", active: true, isGM: true, role: 4 };
const users = [gm, nextGM];
users.activeGM = gm;
let serial = 0;
const settings = new Map();
globalThis.game = {
  settings: {
    get: (_module, key) => settings.get(key),
    set: async (_module, key, value) => {
      settings.set(key, structuredClone(value));
      return value;
    },
  },
  user: gm,
  users,
  time: { serverTime: 1000 },
  messages: new Map(),
};
globalThis.CONST = { USER_ROLES: { GAMEMASTER: 4 } };
globalThis.foundry = {
  utils: { randomID: () => `id${String(++serial).padStart(14, "0")}` },
};
globalThis.ChatMessage = {
  async create(data) {
    game.messages.set(data._id, data);
    return data;
  },
};
function patch(target, changes) {
  for (const [key, value] of Object.entries(changes)) {
    const parts = key.split(".");
    let node = target;
    for (const part of parts.slice(0, -1)) node = node[part] ??= {};
    node[parts.at(-1)] = structuredClone(value);
  }
}
function fixture({ temp = 3, disabled = false, suppressed = false } = {}) {
  const effect = {
    id: "effect",
    disabled,
    isSuppressed: suppressed,
    flags: {
      [MODULE]: {
        criticalInjury: { id: "injury", injuryKey: "internal-bleeding" },
      },
    },
  };
  const actor = {
    id: "actor",
    uuid: "Scene.scene.Token.token.Actor.actor",
    name: "Synthetic hero",
    system: { attributes: { hp: { value: 10, temp } } },
    flags: {},
    effects: [effect],
    writes: 0,
    async update(changes) {
      this.writes++;
      patch(this, changes);
    },
  };
  const combat = {
    id: `combat${++serial}`,
    flags: {},
    combatants: [
      { id: "one", actor },
      { id: "duplicate", actor },
    ],
    async update(changes) {
      patch(this, changes);
    },
  };
  let rolls = 0;
  const roll = async (formula) => {
    rolls++;
    return { total: formula === "1d6" ? 1 : 4 };
  };
  const run = (start = true) => processCombatBleeding(combat, { start, roll });
  return { actor, effect, combat, roll, run, rolls: () => rolls };
}
assert.deepEqual(bleedingDamageAfter({ value: 2, temp: 1 }, 4), {
  value: 0,
  temp: 0,
});
assert.deepEqual(bleedingDamageAfter({ value: 10, temp: 8 }, 4), {
  value: 10,
  temp: 4,
});
const normal = fixture();
await Promise.all([normal.run(), normal.run()]);
assert.deepEqual(normal.actor.system.attributes.hp, { value: 9, temp: 0 });
assert.equal(
  normal.actor.writes,
  1,
  "duplicate combatants/hooks apply once to the synthetic token Actor",
);
assert.equal(normal.rolls(), 2);
const chatCount = game.messages.size;
await normal.run(false);
assert.equal(normal.actor.writes, 1);
assert.equal(normal.rolls(), 2);
assert.equal(game.messages.size, chatCount);
for (const options of [{ disabled: true }, { suppressed: true }]) {
  const skipped = fixture(options);
  await skipped.run();
  assert.equal(skipped.rolls(), 0);
  assert.equal(skipped.actor.writes, 0);
  skipped.effect.disabled = skipped.effect.isSuppressed = false;
  await skipped.run();
  assert.equal(
    skipped.rolls(),
    0,
    "enabling later does not create a second combat start",
  );
}
const miss = fixture();
await processCombatBleeding(miss.combat, {
  start: true,
  roll: async () => ({ total: 6 }),
});
assert.equal(miss.actor.writes, 0);
const lost = fixture();
const apply = lost.actor.update.bind(lost.actor);
lost.actor.update = async (changes) => {
  await apply(changes);
  throw Error("lost reply");
};
await lost.run();
await lost.run(false);
assert.equal(lost.actor.writes, 1);
const handoff = fixture();
const applyHandoff = handoff.actor.update.bind(handoff.actor);
handoff.actor.update = async (changes) => {
  await applyHandoff(changes);
  users.activeGM = nextGM;
};
await assert.rejects(handoff.run(), /AuthorityChanged/);
handoff.actor.system.attributes.hp.value = 10; // Later healing must not replay prior damage.
game.user = nextGM;
await handoff.run(false);
assert.equal(handoff.actor.writes, 1);
assert.equal(handoff.actor.system.attributes.hp.value, 10);
assert.equal(handoff.rolls(), 2);
game.user = gm;
users.activeGM = gm;
const conflict = fixture();
const originalSet = game.settings.set;
let interfere = true;
game.settings.set = async (module, key, value) => {
  const result = await originalSet(module, key, value);
  if (
    interfere &&
    value?.bleedingCombats?.[conflict.combat.id]?.events[0]?.after
  ) {
    interfere = false;
    conflict.actor.system.attributes.hp.value = 7;
  }
  return result;
};
await assert.rejects(conflict.run(), /HitPointConflict/);
assert.equal(conflict.actor.writes, 0);
await assert.rejects(conflict.run(false), /HitPointConflict/);
assert.equal(conflict.rolls(), 2, "conflict retries retain the original dice");
await skipPendingCombatBleeding(conflict.combat, "b0");
await conflict.run(false);
assert.equal(conflict.actor.system.attributes.hp.value, 7);
assert.equal(
  readCriticalInjuryBleeding(conflict.combat.id).events[0].state,
  "skipped",
);
const removed = fixture();
await processCombatBleeding(removed.combat, {
  start: true,
  roll: async (formula) => {
    if (formula === "1d4") removed.actor.effects = [];
    return { total: formula === "1d6" ? 1 : 4 };
  },
});
assert.equal(removed.actor.writes, 0, "cure during a roll prevents damage");
const unavailable = fixture();
game.user = { id: "player", isGM: false, role: 1 };
await unavailable.run();
assert.equal(unavailable.rolls(), 0);
game.user = gm;
const leased = fixture();
await writeCriticalInjuryBleeding(
  leased.combat.id,
  {
    version: 1,
    lease: { id: "old-lease", owner: gm.id, expires: 61000 },
    events: [
      {
        id: "b0",
        actorUuid: leased.actor.uuid,
        actorName: leased.actor.name,
        combatantId: "one",
        injuryId: "injury",
        effectId: "effect",
        state: "pending",
      },
    ],
  },
  null,
);
await leased.run(false);
assert.equal(leased.rolls(), 0, "another tab cannot take a live same-GM lease");
game.time.serverTime = 62000;
await leased.run(false);
assert.equal(
  leased.actor.writes,
  1,
  "expired leases can resume after reconnect",
);
await assert.rejects(
  writeCriticalInjuryBleeding(
    leased.combat.id,
    { version: 1, events: [] },
    null,
  ),
  /StaleWrite/,
);
const old = fixture();
await old.run(false);
assert.equal(
  old.rolls(),
  0,
  "startup does not backfill historical combats without receipts",
);
console.log(
  "Bleeding: temporary HP, disabled/suppressed effects, token actors, duplicate delivery, saved dice, lost replies, GM handoff, HP conflict, cure during roll and chat replay passed",
);
