import assert from "node:assert/strict";
import {
  CRITICAL_INJURY_TABLE,
  buildCriticalInjuryChanges,
  resolveCriticalInjuryDetail,
} from "./injury/table.js";
import {
  buildCriticalInjuryTableReference,
  INJURY_AUTOMATION_AUDIT,
} from "./injury/table-reference.js";
import { normalizeGmWorkbenchTarget } from "./gm-workbench-routes.js";

const rows = buildCriticalInjuryTableReference();
assert.equal(rows.length, 30);
assert.deepEqual(
  Object.keys(INJURY_AUTOMATION_AUDIT).sort(),
  CRITICAL_INJURY_TABLE.map((r) => r.key).sort(),
  "every outcome needs an explicit audit before expansion",
);
for (let roll = 1; roll <= 100; roll++)
  assert.equal(
    rows.filter((r) => roll >= r.min && roll <= r.max).length,
    1,
    `d100 ${roll} has exactly one band`,
  );
for (const [index, definition] of CRITICAL_INJURY_TABLE.entries()) {
  assert.equal(rows[index].effect, definition.effect);
  assert.equal(rows[index].recovery, definition.recovery);
  assert.ok(rows[index].automatic && rows[index].manual);
  const details = definition.detailRoll
    ? Array.from(
        { length: definition.detailRoll.formula === "1d4" ? 4 : 6 },
        (_, i) => resolveCriticalInjuryDetail(definition, i + 1),
      )
    : [null];
  for (const detail of details) {
    const changes = buildCriticalInjuryChanges(definition, {
      detail,
      infectionHpLoss: 2,
    });
    assert.ok(
      changes.every((c) => c.key && c.value && Number.isFinite(c.mode)),
    );
    if (rows[index].requiresMidi)
      assert.ok(
        changes.some((c) => c.key.startsWith("flags.midi-qol.")) ||
          (definition.key === "crippling-injury" && detail?.kind === "leg"),
      );
    if (
      [
        "broken-arm",
        "loss-of-hearing",
        "psychic-trauma",
        "nightmares",
        "minor-injury",
        "internal-bleeding",
      ].includes(definition.key)
    )
      assert.deepEqual(
        changes,
        [],
        `${definition.key} does not have a blanket numeric effect`,
      );
  }
}
assert.equal(rows.find((r) => r.key === "nightmares").status, "manual");
assert.equal(rows.find((r) => r.key === "minor-injury").status, "narrative");
for (const key of [
  "internal-bleeding",
  "deep-cut",
  "infection",
  "nightmares",
  "broken-arm",
  "nerve-damage",
])
  assert.ok(
    rows.find((r) => r.key === key).recoveryNote,
    `${key} exposes its recovery mismatch`,
  );
assert.equal(
  normalizeGmWorkbenchTarget({ route: "injuries", subview: "table" }).subview,
  "table",
);
console.log(
  "Injury table reference: all 30 outcomes, 100 roll bands, detail variants, audit coverage and route passed.",
);
