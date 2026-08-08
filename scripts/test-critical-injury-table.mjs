import assert from "node:assert/strict";

import {
  CRITICAL_INJURY_ROLL_FORMULA,
  CRITICAL_INJURY_TABLE,
  CRITICAL_INJURY_TABLE_VERSION,
  buildCriticalInjuryChanges,
  findCriticalInjuryByRoll,
  getCriticalInjuryRecoveryFormula,
  resolveCriticalInjuryDetail,
} from "./injury/table.js";
import {
  buildCriticalInjuryEffectData,
  effectiveRecoveryCalendarDays,
} from "./injury/effects.js";

assert.equal(CRITICAL_INJURY_TABLE_VERSION, 2);
assert.equal(CRITICAL_INJURY_ROLL_FORMULA, "1d100");
assert.equal(CRITICAL_INJURY_TABLE.length, 18);

const coverage = new Map();
for (let roll = 1; roll <= 100; roll += 1) {
  const injury = findCriticalInjuryByRoll(roll);
  assert.ok(injury, `d100 ${roll} resolves`);
  assert.ok(
    roll >= injury.min && roll <= injury.max,
    `d100 ${roll} is in range`,
  );
  coverage.set(roll, injury.key);
}
assert.equal(coverage.size, 100, "every d100 face is covered exactly once");
assert.equal(coverage.get(1), "lost-limb");
assert.equal(coverage.get(35), "deep-cut");
assert.equal(coverage.get(100), "soul-shaken");

assert.equal(
  getCriticalInjuryRecoveryFormula(findCriticalInjuryByRoll(6)),
  "1d4",
);
assert.equal(
  getCriticalInjuryRecoveryFormula(findCriticalInjuryByRoll(16)),
  "2d4",
);
assert.equal(
  getCriticalInjuryRecoveryFormula(findCriticalInjuryByRoll(46)),
  "7",
);
assert.equal(
  getCriticalInjuryRecoveryFormula(findCriticalInjuryByRoll(1)),
  "Permanent",
);

const leftLeg = resolveCriticalInjuryDetail(findCriticalInjuryByRoll(1), 3);
assert.deepEqual(leftLeg, {
  type: "body-part",
  roll: 3,
  key: "left-leg",
  label: "Left leg",
  kind: "leg",
});
const lostLegChanges = buildCriticalInjuryChanges(
  findCriticalInjuryByRoll(1),
  { detail: leftLeg },
  { MULTIPLY: 1 },
);
assert.deepEqual(lostLegChanges, [
  {
    key: "system.attributes.movement.walk",
    mode: 1,
    value: "0.5",
    priority: 20,
  },
]);

const concussionChanges = buildCriticalInjuryChanges(
  findCriticalInjuryByRoll(11),
);
assert.ok(
  concussionChanges.some(
    (change) =>
      change.key === "flags.midi-qol.disadvantage.ability.save.wis" &&
      change.value === "1",
  ),
  "concussion emits the Midi-QOL Wisdom-save penalty",
);
assert.ok(
  concussionChanges.some(
    (change) => change.key === "system.skills.prc.bonuses.passive",
  ),
  "concussion emits the passive Perception penalty",
);

const knee = findCriticalInjuryByRoll(46);
const untreatedEffect = buildCriticalInjuryEffectData(
  {
    id: "injury-knee",
    injuryKey: knee.key,
    injuryName: knee.label,
    canBecomePermanent: true,
    remainingDays: 7,
    recoveryDueTs: 604800,
  },
  { startTime: 0, dueTimestamp: 604800 },
);
assert.equal(
  untreatedEffect.duration.seconds,
  undefined,
  "Times Up cannot erase an injury before its permanent-state transition",
);
assert.equal(effectiveRecoveryCalendarDays({ remainingDays: 7 }), 7);
assert.equal(
  effectiveRecoveryCalendarDays({ remainingDays: 7, stabilized: true }),
  4,
);

process.stdout.write("critical injury table validation passed\n");
