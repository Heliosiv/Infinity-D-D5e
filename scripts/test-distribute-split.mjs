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

// 100 gp, 10 sp, 3 cp across 3 actors:
//   gp: 100/3 = 33 each + 1 remainder → 34,33,33
//   sp: 10/3  = 3 each + 1 remainder  → 4,3,3
//   cp: 3/3   = 1 each                → 1,1,1
const split = planEvenSplit(items, { gp: 100, sp: 10, cp: 3 }, ["a", "b", "c"]);
assert.equal(split.length, 3);
assert.deepEqual(
  split.map((s) => s.currency.gp),
  [34, 33, 33],
);
assert.deepEqual(
  split.map((s) => s.currency.sp),
  [4, 3, 3],
);
assert.deepEqual(
  split.map((s) => s.currency.cp),
  [1, 1, 1],
);

// Coins reconcile exactly: every coin is handed out, none invented.
const sumDenom = (denom) =>
  split.reduce((total, s) => total + s.currency[denom], 0);
assert.equal(sumDenom("gp"), 100);
assert.equal(sumDenom("sp"), 10);
assert.equal(sumDenom("cp"), 3);

// Items are still round-robin dealt alongside the coin split.
assert.deepEqual(
  split.map((s) => s.items.length),
  [2, 2, 1],
);

// No currency → zeroed currency buckets, still valid.
const noCoin = planEvenSplit(items, null, ["a", "b"]);
assert.deepEqual(noCoin[0].currency, { pp: 0, gp: 0, ep: 0, sp: 0, cp: 0 });

process.stdout.write("distribute-split validation passed\n");
