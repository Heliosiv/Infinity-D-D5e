import assert from "node:assert/strict";

import { detectHitPointRecovery } from "./injury/service.js";

const actor = {
  system: { attributes: { hp: { value: 0 } } },
  statuses: new Set(),
  effects: { contents: [] },
};

assert.deepEqual(
  detectHitPointRecovery(actor, {
    system: { attributes: { hp: { value: 1 } } },
  }),
  {
    previousHp: 0,
    nextHp: 1,
    wasDead: false,
    cause: "zero-hit-points",
  },
);
assert.deepEqual(
  detectHitPointRecovery(
    { ...actor, statuses: new Set(["dead"]) },
    { "system.attributes.hp.value": 7 },
  ),
  {
    previousHp: 0,
    nextHp: 7,
    wasDead: true,
    cause: "dead-state",
  },
);
assert.equal(
  detectHitPointRecovery(
    { ...actor, system: { attributes: { hp: { value: 3 } } } },
    { "system.attributes.hp.value": 4 },
  ),
  null,
  "positive-to-positive healing does not trigger",
);
assert.equal(
  detectHitPointRecovery(actor, { "system.attributes.hp.value": 0 }),
  null,
  "remaining at zero does not trigger",
);
assert.equal(
  detectHitPointRecovery(actor, { name: "Unrelated change" }),
  null,
  "unrelated actor changes do not trigger",
);

process.stdout.write("critical injury recovery transition validation passed\n");
