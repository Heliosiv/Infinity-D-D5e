import assert from "node:assert/strict";

import { suggestExhaustion } from "./resource/consumption.js";

/* ------------------------------------------------------------------ *
 * Food OR water shortfall → +1 suggestion
 * ------------------------------------------------------------------ */
{
  const out = suggestExhaustion({
    shortfalls: [{ actorId: "a", name: "Aric", food: 1, water: 0, light: 0 }],
  });
  assert.equal(out.length, 1);
  assert.equal(out[0].actorId, "a");
  assert.equal(out[0].suggestDelta, 1);
  assert.match(out[0].reasons[0], /food/);
}

/* ------------------------------------------------------------------ *
 * Both food + water short → stacks (capped by days)
 * ------------------------------------------------------------------ */
{
  const out = suggestExhaustion({
    shortfalls: [{ actorId: "b", name: "Brm", food: 2, water: 2 }],
    days: 2,
  });
  assert.equal(out[0].suggestDelta, 4); // min(2,2) + min(2,2)
  assert.equal(out[0].reasons.length, 2);
}

/* ------------------------------------------------------------------ *
 * Per-resource amount capped by the days covered
 * ------------------------------------------------------------------ */
{
  // 5 food short but only 1 day of catch-up → cap the suggestion at 1.
  const out = suggestExhaustion({
    shortfalls: [{ actorId: "c", food: 5, water: 0 }],
    days: 1,
  });
  assert.equal(out[0].suggestDelta, 1);
}

/* ------------------------------------------------------------------ *
 * Light-only shortfall → no exhaustion suggested
 * ------------------------------------------------------------------ */
{
  const out = suggestExhaustion({
    shortfalls: [{ actorId: "d", food: 0, water: 0, light: 4 }],
  });
  assert.equal(out.length, 0);
}

/* ------------------------------------------------------------------ *
 * Suggestion clamps at the 5e maximum of 6
 * ------------------------------------------------------------------ */
{
  const out = suggestExhaustion({
    shortfalls: [{ actorId: "e", food: 10, water: 10 }],
    days: 10,
  });
  assert.equal(out[0].suggestDelta, 6);
}

/* ------------------------------------------------------------------ *
 * No shortfalls / malformed input → empty
 * ------------------------------------------------------------------ */
{
  assert.deepEqual(suggestExhaustion({ shortfalls: [] }), []);
  assert.deepEqual(suggestExhaustion({}), []);
  assert.deepEqual(
    suggestExhaustion({ shortfalls: [{ food: 1 }] }),
    [],
    "entry without actorId is skipped",
  );
}

process.stdout.write("resource-exhaustion validation passed\n");
