import assert from "node:assert/strict";

globalThis.CONST = { ACTIVE_EFFECT_MODES: { ADD: 2 } };

const {
  applySharpeningEffect,
  buildSharpeningEffect,
  clearSharpeningOnLongRest,
  consumeSharpeningCharge,
  hasActiveSharpening,
  hasSharpening,
  injectSharpeningDamageBonus,
  isSharpenableWeapon,
  registerSharpeningHooks,
  sharpenDamageType,
  supportsNativeDamagePartEnchantments,
} = await import("./downtime/effects.js");

function weapon(overrides = {}) {
  return {
    id: "weapon-1",
    name: "Longsword",
    type: "weapon",
    system: {
      rarity: "",
      properties: new Set(),
      activities: new Map([
        [
          "attack-1",
          {
            type: "attack",
            attack: { type: { value: "melee" } },
            damage: { parts: [{ types: new Set(["slashing"]) }] },
          },
        ],
      ]),
    },
    effects: [],
    ...overrides,
  };
}

// D&D5e 4.0.4 weapon sources keep the inherited weapon die under
// system.damage.base while an attack activity that includes that base damage
// can have no activity-local parts at all.
function dnd5e404WeaponSource({
  id,
  name,
  attackType,
  damageType,
  properties,
  rarity = "common",
}) {
  return {
    id,
    name,
    type: "weapon",
    system: {
      rarity,
      properties,
      damage: {
        base: {
          number: 1,
          denomination: name === "Dagger" ? 4 : 8,
          bonus: "",
          types: [damageType],
        },
      },
      activities: {
        dnd5eactivity000: {
          _id: "dnd5eactivity000",
          type: "attack",
          attack: {
            type: { value: attackType, classification: "weapon" },
          },
          damage: { includeBase: true, parts: [] },
        },
      },
    },
    effects: [],
  };
}

const dnd5e404Longsword = dnd5e404WeaponSource({
  id: "dnd5e-404-longsword",
  name: "Longsword",
  attackType: "melee",
  damageType: "slashing",
  properties: ["ver"],
});
assert.equal(sharpenDamageType(dnd5e404Longsword), "slashing");
assert.equal(isSharpenableWeapon(dnd5e404Longsword), true);

const dnd5e404Dagger = dnd5e404WeaponSource({
  id: "dnd5e-404-dagger",
  name: "Dagger",
  attackType: "melee",
  damageType: "piercing",
  properties: ["fin", "lgt", "thr"],
});
assert.equal(sharpenDamageType(dnd5e404Dagger), "piercing");
assert.equal(isSharpenableWeapon(dnd5e404Dagger), true);

const dnd5e404Longbow = dnd5e404WeaponSource({
  id: "dnd5e-404-longbow",
  name: "Longbow",
  attackType: "ranged",
  damageType: "piercing",
  properties: ["amm", "hvy", "two"],
});
assert.equal(sharpenDamageType(dnd5e404Longbow), "piercing");
assert.equal(isSharpenableWeapon(dnd5e404Longbow), false);

assert.equal(
  isSharpenableWeapon(
    dnd5e404WeaponSource({
      id: "dnd5e-404-magic-property",
      name: "Magic Dagger",
      attackType: "melee",
      damageType: "piercing",
      properties: ["magic"],
    }),
  ),
  false,
);
assert.equal(
  isSharpenableWeapon(
    dnd5e404WeaponSource({
      id: "dnd5e-404-uncommon",
      name: "Uncommon Longsword",
      attackType: "melee",
      damageType: "slashing",
      properties: ["ver"],
      rarity: "uncommon",
    }),
  ),
  false,
);

const sword = weapon();
assert.equal(sharpenDamageType(sword), "slashing");
assert.equal(isSharpenableWeapon(sword), true);
assert.equal(
  isSharpenableWeapon(
    weapon({
      system: {
        ...sword.system,
        properties: new Set(["mgc"]),
      },
    }),
  ),
  false,
);
assert.equal(
  isSharpenableWeapon(
    weapon({
      system: {
        ...sword.system,
        activities: new Map([
          [
            "attack-1",
            {
              type: "attack",
              attack: { type: { value: "ranged" } },
              damage: { parts: [{ types: new Set(["piercing"]) }] },
            },
          ],
        ]),
      },
    }),
  ),
  false,
);
assert.equal(
  isSharpenableWeapon(
    weapon({
      system: {
        ...sword.system,
        activities: new Map([
          [
            "attack-1",
            {
              type: "attack",
              attack: { type: { value: "melee" } },
              damage: { parts: [{ types: new Set(["bludgeoning"]) }] },
            },
          ],
        ]),
      },
    }),
  ),
  false,
);

const effect = buildSharpeningEffect({
  operationId: "op-1",
  actorId: "actor-1",
  itemId: "weapon-1",
  damageType: "slashing",
  timestamp: 100,
});
assert.equal(effect.type, "enchantment");
assert.equal(effect.changes.length, 1);
assert.equal(effect.changes[0].key, "system.damage.parts");
assert.equal(effect.changes[0].mode, 2);
assert.deepEqual(JSON.parse(effect.changes[0].value), {
  bonus: "1",
  types: ["slashing"],
});
assert.equal(effect.flags["infinity-dnd5e"].downtimeSharpen.charges, 3);
assert.equal(
  effect.changes.some((change) => change.key.includes("attack")),
  false,
);
assert.equal(
  effect.flags["infinity-dnd5e"].downtimeSharpen.compatibilityFallback,
  false,
);
assert.equal(
  effect.flags["infinity-dnd5e"].downtimeSharpen.damageType,
  "slashing",
);
assert.equal(effect.flags["infinity-dnd5e"].downtimeSharpen.locked, true);
assert.equal(effect.flags["infinity-dnd5e"].downtimeSharpen.enchantment, true);

assert.equal(supportsNativeDamagePartEnchantments("4.0.4"), false);
assert.equal(supportsNativeDamagePartEnchantments("4.4.2"), false);
assert.equal(supportsNativeDamagePartEnchantments("4.4.3-beta.1"), false);
assert.equal(supportsNativeDamagePartEnchantments("4.4.3"), true);
assert.equal(supportsNativeDamagePartEnchantments("4.4.4"), true);
assert.equal(supportsNativeDamagePartEnchantments("5.0.0"), true);
assert.equal(supportsNativeDamagePartEnchantments("unknown"), false);

const fallbackEffect = buildSharpeningEffect({
  operationId: "op-fallback",
  actorId: "actor-1",
  itemId: "weapon-1",
  damageType: "piercing",
  timestamp: 101,
  nativeDamagePart: false,
});
const fallbackFlag = fallbackEffect.flags["infinity-dnd5e"].downtimeSharpen;
assert.equal(fallbackEffect.type, "enchantment");
assert.deepEqual(fallbackEffect.changes, []);
assert.deepEqual(
  {
    bonus: fallbackFlag.bonus,
    types: fallbackFlag.types,
    locked: fallbackFlag.locked,
    enchantment: fallbackFlag.enchantment,
    compatibilityFallback: fallbackFlag.compatibilityFallback,
  },
  {
    bonus: "1",
    types: ["piercing"],
    locked: true,
    enchantment: true,
    compatibilityFallback: true,
  },
);

const disabledFallbackSword = weapon({
  effects: [{ ...structuredClone(fallbackEffect), disabled: true }],
});
const suppressedFallbackSword = weapon({
  effects: [{ ...structuredClone(fallbackEffect), isSuppressed: true }],
});
assert.equal(
  hasSharpening(disabledFallbackSword),
  true,
  "an inactive module effect still blocks stacking",
);
assert.equal(hasActiveSharpening(disabledFallbackSword), false);
assert.equal(hasActiveSharpening(suppressedFallbackSword), false);
assert.equal(
  injectSharpeningDamageBonus({
    subject: { item: disabledFallbackSword },
    rolls: [],
  }),
  false,
  "a disabled fallback effect grants no damage",
);
assert.equal(
  injectSharpeningDamageBonus({
    subject: { item: suppressedFallbackSword },
    rolls: [],
  }),
  false,
  "a suppressed fallback effect grants no damage",
);
for (const inactiveSword of [disabledFallbackSword, suppressedFallbackSword]) {
  const inactiveConsumption = await consumeSharpeningCharge(
    inactiveSword,
    "inactive-roll",
    {
      effectId: fallbackEffect._id,
      operationId: "op-fallback",
    },
  );
  assert.equal(inactiveConsumption.ok, true);
  assert.equal(
    inactiveConsumption.consumed,
    false,
    "disabled and suppressed effects never spend a charge",
  );
}

const enchanted = weapon({ effects: [effect] });
assert.equal(hasSharpening(enchanted), true);

function liveWeapon() {
  const item = weapon({ effects: new Map() });
  item.createEmbeddedDocuments = async (_type, sources) =>
    sources.map((source) => {
      const data = structuredClone(source);
      const document = {
        id: data._id,
        toObject: () => structuredClone(data),
        async update(changes) {
          if (`flags.infinity-dnd5e.downtimeSharpen.charges` in changes) {
            data.flags["infinity-dnd5e"].downtimeSharpen.charges =
              changes[`flags.infinity-dnd5e.downtimeSharpen.charges`];
          }
          if (`flags.infinity-dnd5e.downtimeSharpen.rollIds` in changes) {
            data.flags["infinity-dnd5e"].downtimeSharpen.rollIds =
              changes[`flags.infinity-dnd5e.downtimeSharpen.rollIds`];
          }
          return document;
        },
      };
      item.effects.set(document.id, document);
      return document;
    });
  item.deleteEmbeddedDocuments = async (_type, ids) =>
    ids.flatMap((id) => {
      const document = item.effects.get(id);
      if (!document) return [];
      item.effects.delete(id);
      return [document];
    });
  return item;
}

// The effect is the only mutation: the weapon's permanent system source stays
// unchanged while three distinct damage rolls consume the three charges.
const liveSword = liveWeapon();
const permanentSystemBefore = structuredClone(liveSword.system);
globalThis.game = { system: { version: "4.0.4" } };
const applied = await applySharpeningEffect(liveSword, {
  operationId: "op-live",
  actorId: "actor-1",
  timestamp: 200,
});
assert.equal(applied.ok, true);
assert.equal(applied.compatibilityFallback, true);
assert.equal(hasSharpening(liveSword), true);
const appliedFallbackSource = [...liveSword.effects.values()][0].toObject();
assert.equal(appliedFallbackSource.type, "enchantment");
assert.deepEqual(appliedFallbackSource.changes, []);
assert.equal(
  appliedFallbackSource.flags["infinity-dnd5e"].downtimeSharpen
    .compatibilityFallback,
  true,
);
assert.deepEqual(liveSword.system, permanentSystemBefore);
const stacked = await applySharpeningEffect(liveSword, {
  operationId: "op-stacked",
  actorId: "actor-1",
});
assert.equal(stacked.ok, false);
assert.equal(stacked.reason, "already-sharpened");

globalThis.game.system.version = "4.4.3";
const nativeLiveSword = liveWeapon();
const nativeApplied = await applySharpeningEffect(nativeLiveSword, {
  operationId: "op-live-native",
  actorId: "actor-1",
  timestamp: 201,
});
assert.equal(nativeApplied.ok, true);
assert.equal(nativeApplied.compatibilityFallback, false);
const appliedNativeSource = [...nativeLiveSword.effects.values()][0].toObject();
assert.equal(appliedNativeSource.changes.length, 1);
assert.equal(appliedNativeSource.changes[0].key, "system.damage.parts");
assert.equal(
  appliedNativeSource.flags["infinity-dnd5e"].downtimeSharpen
    .compatibilityFallback,
  false,
);
globalThis.game.system.version = "4.0.4";

const first = await consumeSharpeningCharge(liveSword, "damage-roll-1");
assert.equal(first.ok, true);
assert.equal(first.charges, 2);
const duplicate = await consumeSharpeningCharge(liveSword, "damage-roll-1");
assert.equal(duplicate.reason, "duplicate");
assert.equal(duplicate.consumed, false);
const second = await consumeSharpeningCharge(liveSword, "damage-roll-2");
assert.equal(second.charges, 1);
const third = await consumeSharpeningCharge(liveSword, "damage-roll-3");
assert.equal(third.charges, 0);
assert.equal(hasSharpening(liveSword), false);
assert.deepEqual(liveSword.system, permanentSystemBefore);

await applySharpeningEffect(liveSword, {
  operationId: "op-rest",
  actorId: "actor-1",
  timestamp: 300,
});
const rest = await clearSharpeningOnLongRest({ items: [liveSword] });
assert.equal(rest.ok, true);
assert.equal(rest.removed, 1);
assert.equal(hasSharpening(liveSword), false);

// D&D5e Roll instances do not guarantee a document-style id. Distinct rolls
// with the same formula must still spend distinct charges, while a repeated
// delivery of the exact same Roll object remains idempotent.
const hookHandlers = new Map();
globalThis.Hooks = {
  on(event, handler) {
    hookHandlers.set(event, handler);
    return hookHandlers.size;
  },
};
const observedDamage = [];
const observedRests = [];
registerSharpeningHooks({
  onDamage: (payload) => observedDamage.push(payload),
  onLongRest: (payload) => observedRests.push(payload),
});
const hookSword = liveWeapon();
await applySharpeningEffect(hookSword, {
  operationId: "op-hook",
  actorId: "actor-1",
  timestamp: 400,
});
const preDamageHook = hookHandlers.get("dnd5e.preRollDamageV2");
const fallbackRollConfig = {
  subject: { item: hookSword },
  rolls: [
    {
      data: { actorId: "actor-1" },
      parts: ["1d8 + 3"],
      options: {
        type: "slashing",
        types: ["slashing"],
        properties: [],
      },
    },
  ],
};
preDamageHook(fallbackRollConfig);
assert.equal(fallbackRollConfig.rolls.length, 2);
assert.deepEqual(fallbackRollConfig.rolls[1], {
  data: {},
  parts: ["1"],
  options: {
    type: "slashing",
    types: ["slashing"],
    properties: [],
  },
});
preDamageHook(fallbackRollConfig);
assert.equal(fallbackRollConfig.rolls.length, 2);

const nativeHookSword = weapon({
  effects: [
    buildSharpeningEffect({
      operationId: "op-native-hook",
      actorId: "actor-1",
      itemId: "weapon-native",
      damageType: "slashing",
      nativeDamagePart: true,
    }),
  ],
});
const nativeRollConfig = { subject: { item: nativeHookSword }, rolls: [] };
assert.equal(injectSharpeningDamageBonus(nativeRollConfig), false);
assert.deepEqual(nativeRollConfig.rolls, []);

const firstRollObject = { _formula: "1d8 + 3" };
const secondRollObject = { _formula: "1d8 + 3" };
const damageHook = hookHandlers.get("dnd5e.rollDamageV2");
damageHook([firstRollObject], { subject: { item: hookSword } });
damageHook([secondRollObject], { subject: { item: hookSword } });
damageHook([firstRollObject], { subject: { item: hookSword } });
assert.equal(observedDamage.length, 3);
assert.notEqual(observedDamage[0].rollId, observedDamage[1].rollId);
assert.equal(observedDamage[0].rollId, observedDamage[2].rollId);
damageHook([{ _formula: "1" }], {
  subject: { item: disabledFallbackSword },
});
damageHook([{ _formula: "1" }], {
  subject: { item: suppressedFallbackSword },
});
assert.equal(
  observedDamage.length,
  3,
  "inactive sharpening effects do not spend charges",
);
const restHook = hookHandlers.get("dnd5e.restCompleted");
restHook({ items: [hookSword] }, { longRest: false }, {});
restHook({ items: [hookSword] }, { longRest: true }, {});
assert.equal(observedRests.length, 1);

delete globalThis.CONST;
delete globalThis.Hooks;
delete globalThis.game;
console.log("downtime sharpening validation passed");
