/**
 * Tests for the pure multi-actor distribution planners — round-robin
 * item dealing and even coin splitting (remainder reconciles to the
 * first actors). These run without a Foundry runtime.
 */

import assert from "node:assert/strict";

import { planEvenSplit, planRoundRobin } from "./loot/distribute.js";

const items = [
  { uuid: "a", quantity: 1 },
  { uuid: "b", quantity: 1 },
  { uuid: "c", quantity: 1 },
  { uuid: "d", quantity: 1 },
  { uuid: "e", quantity: 1 },
];

/* --------------------------- round-robin --------------------------- */

const rr = planRoundRobin(items, ["p1", "p2"]);
assert.equal(rr.length, 2);
assert.deepEqual(
  rr.map((a) => a.actorId),
  ["p1", "p2"],
);
// 5 items over 2 actors → 3 / 2, dealt alternately.
assert.deepEqual(
  rr[0].items.map((i) => i.uuid),
  ["a", "c", "e"],
);
assert.deepEqual(
  rr[1].items.map((i) => i.uuid),
  ["b", "d"],
);

// No actors → no assignments.
assert.deepEqual(planRoundRobin(items, []), []);
// No items → empty buckets per actor.
assert.deepEqual(planRoundRobin([], ["p1"]), [{ actorId: "p1", items: [] }]);

/* ---------------------------- even split --------------------------- */

// 100 gp, 10 sp, 3 cp = 10,103 cp across 3 actors:
// 3,368 / 3,368 / 3,367 cp (at most one copper apart).
const split = planEvenSplit(items, { gp: 100, sp: 10, cp: 3 }, ["a", "b", "c"]);
assert.equal(split.length, 3);
assert.deepEqual(
  split.map((s) => s.currency.gp),
  [33, 33, 33],
);
assert.deepEqual(
  split.map((s) => s.currency.sp),
  [6, 6, 6],
);
assert.deepEqual(
  split.map((s) => s.currency.cp),
  [8, 8, 7],
);

const valueCp = (currency) =>
  (currency.pp ?? 0) * 1000 +
  (currency.gp ?? 0) * 100 +
  (currency.ep ?? 0) * 50 +
  (currency.sp ?? 0) * 10 +
  (currency.cp ?? 0);
assert.equal(split.reduce((sum, entry) => sum + valueCp(entry.currency), 0), 10103);
assert.deepEqual(split.map((entry) => valueCp(entry.currency)), [3368, 3368, 3367]);

// Mixed high denominations must split by value, not by each denomination.
const mixed = planEvenSplit([], { pp: 1, gp: 10 }, ["a", "b"]);
assert.deepEqual(mixed.map((entry) => valueCp(entry.currency)), [1000, 1000]);

// Items are still round-robin dealt alongside the coin split.
assert.deepEqual(
  split.map((s) => s.items.length),
  [2, 2, 1],
);

// No currency → zeroed currency buckets, still valid.
const noCoin = planEvenSplit(items, null, ["a", "b"]);
assert.deepEqual(noCoin[0].currency, { pp: 0, gp: 0, ep: 0, sp: 0, cp: 0 });

process.stdout.write("distribute-split validation passed\n");
