import assert from "node:assert/strict";
import {
  getCriticalInjuryTable,
  getCriticalInjuryDefinition,
  findCriticalInjuryByRoll,
  getCriticalInjuryRecoveryFormula,
} from "./injury/table.js";
import { buildInjuryFromResolution } from "./injury/service.js";
import { buildCriticalInjuryEffectData } from "./injury/effects.js";
import { resolveCriticalInjuryBodyLocation } from "./injury/body-regions.js";

const expected = {
  "sprained-ankle": [9, 10, "system.skills.acr.bonuses.check", "-2", "1d3", 1],
  "lingering-headache": [
    14,
    15,
    "system.abilities.int.bonuses.check",
    "-1",
    "1d3",
    1,
  ],
  "sprained-wrist": [19, 20, "system.skills.slt.bonuses.check", "-2", "1d3", 1],
  "bruised-ribs": [24, 25, "system.abilities.con.bonuses.save", "-1", "1d3", 1],
  winded: [29, 30, "system.skills.ath.bonuses.check", "-2", "1d3", 1],
  "pulled-back": [34, 35, "system.abilities.str.bonuses.check", "-1", "1d4", 2],
  "strained-shoulder": [54, 55, "system.bonuses.mwak.attack", "-1", "1d4", 2],
  feverish: [59, 60, "system.abilities.int.bonuses.save", "-1", "1d3", 1],
  "rattled-nerves": [64, 65, "system.attributes.init.bonus", "-1", "1d3", 1],
  "blurred-vision": [66, 67, "system.skills.prc.bonuses.check", "-2", "1d3", 1],
  "drained-vitality": [
    68,
    70,
    "system.abilities.con.bonuses.check",
    "-1",
    "1d3",
    1,
  ],
  "shaken-confidence": [
    86,
    90,
    "system.abilities.wis.bonuses.check",
    "-1",
    "1d3",
    1,
  ],
};

function resolve(tableVersion, injuryRoll) {
  const definition = findCriticalInjuryByRoll(injuryRoll, tableVersion);
  return buildInjuryFromResolution(
    "pending-test",
    { id: "actor-test" },
    {
      tableVersion,
      injuryRoll,
      injuryKey: definition.key,
      injuryId: "injury-test",
      detailTotal: definition.detailRoll ? 1 : null,
      recoveryFormula: getCriticalInjuryRecoveryFormula(definition),
      recoveryDays: definition.permanent ? 0 : definition.dayMax,
      recoveryStartTs: 1000,
      recoveryDueTs: 1000 + definition.dayMax * 86400,
      resolvedAt: 1000,
      resolvedBy: "gm",
      requestedBy: "player",
    },
  );
}

for (const version of [2, 3]) {
  const table = getCriticalInjuryTable(version);
  assert.equal(table.length, version === 2 ? 18 : 30);
  assert.equal(new Set(table.map((r) => r.key)).size, table.length);
  for (let roll = 1; roll <= 100; roll++) {
    assert.equal(table.filter((r) => r.min <= roll && r.max >= roll).length, 1);
    const injury = resolve(version, roll);
    const effect = buildCriticalInjuryEffectData(injury, { startTime: 1000 });
    assert.equal(
      effect.flags["infinity-dnd5e"].criticalInjury.tableVersion,
      version,
    );
    assert.equal(injury.injuryKey, findCriticalInjuryByRoll(roll, version).key);
  }
}
for (const legacy of getCriticalInjuryTable(2)) {
  const current = getCriticalInjuryDefinition(legacy.key);
  const { min, max, ...rules } = current;
  const { min: legacyMin, max: legacyMax, ...legacyRules } = legacy;
  assert.deepEqual(
    rules,
    legacyRules,
    "existing outcomes retain their original rules",
  );
  if (legacy.permanent || legacy.canBecomePermanent) {
    assert.deepEqual(
      [min, max],
      [legacyMin, legacyMax],
      "permanent injury odds stay unchanged",
    );
  }
}
assert.equal(
  resolve(2, 35).injuryKey,
  "deep-cut",
  "old receipts replay the original band",
);
assert.equal(resolve(3, 35).injuryKey, "pulled-back");
assert.equal(resolve(2, 70).injuryKey, "minor-injury");
assert.equal(resolve(3, 70).injuryKey, "drained-vitality");

for (const [key, [min, max, path, value, formula, charges]] of Object.entries(
  expected,
)) {
  const definition = getCriticalInjuryDefinition(key);
  assert.deepEqual([definition.min, definition.max], [min, max]);
  assert.equal(getCriticalInjuryDefinition(key, 2), null);
  assert.equal(getCriticalInjuryRecoveryFormula(definition), formula);
  const injury = resolve(3, min);
  assert.equal(injury.kitCharges, charges);
  assert.equal(injury.permanent, false);
  assert.equal(injury.canBecomePermanent, false);
  const effect = buildCriticalInjuryEffectData(injury, { startTime: 1000 });
  assert.deepEqual(effect.changes, [
    { key: path, value, mode: 2, priority: 20 },
  ]);
  assert.equal(effect.duration.seconds, definition.dayMax * 86400);
  assert.equal(effect.flags.dae.stackable, "multi");
  assert.equal(
    resolveCriticalInjuryBodyLocation(injury).source,
    "injury-default",
  );
  assert.ok(resolveCriticalInjuryBodyLocation(injury).regionKeys.length);
  const rebuilt = buildCriticalInjuryEffectData({
    ...injury,
    stabilized: true,
    remainingDays: 1,
  });
  assert.equal(rebuilt.flags["infinity-dnd5e"].criticalInjury.tableVersion, 3);
  assert.deepEqual(
    rebuilt.changes,
    effect.changes,
    "treatment retains the penalty until recovery",
  );
}
assert.equal(
  buildCriticalInjuryEffectData({ injuryKey: "concussion" }).flags[
    "infinity-dnd5e"
  ].criticalInjury.tableVersion,
  2,
);
assert.throws(
  () => buildInjuryFromResolution("p", { id: "a" }, { tableVersion: 99 }),
  /TableVersionMismatch/,
);
assert.throws(
  () => buildInjuryFromResolution("p", { id: "a" }, {}),
  /TableVersionMismatch/,
);
assert.throws(
  () =>
    buildInjuryFromResolution(
      "p",
      { id: "a" },
      { tableVersion: 3, injuryRoll: 35, injuryKey: "deep-cut" },
    ),
  /DefinitionMismatch/,
);
assert.throws(
  () => buildCriticalInjuryEffectData({ tableVersion: 99 }),
  /TableVersionUnsupported/,
);
console.log(
  "Injury expansion: all 200 versioned rolls, legacy rules, permanent odds, 12 modifiers, durations, body locations and version guards passed.",
);
