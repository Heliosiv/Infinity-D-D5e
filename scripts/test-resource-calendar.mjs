import assert from "node:assert/strict";

import {
  SECONDS_PER_DAY_FALLBACK,
  resolveSecondsPerDay,
  computeAbsoluteDay,
  diffDays,
  clampElapsedForUpkeep,
} from "./resource/calendar.js";

/* ------------------------------------------------------------------ *
 * resolveSecondsPerDay
 * ------------------------------------------------------------------ */
{
  assert.equal(resolveSecondsPerDay(), SECONDS_PER_DAY_FALLBACK);
  assert.equal(resolveSecondsPerDay({}), SECONDS_PER_DAY_FALLBACK);
  assert.equal(resolveSecondsPerDay({ secondsPerDay: 7200 }), 7200);
  assert.equal(resolveSecondsPerDay({ earth: { secondsPerDay: 90000 } }), 90000);
  // Non-positive / NaN ignored → fallback.
  assert.equal(resolveSecondsPerDay({ secondsPerDay: 0 }), SECONDS_PER_DAY_FALLBACK);
  assert.equal(
    resolveSecondsPerDay({ secondsPerDay: "nope" }),
    SECONDS_PER_DAY_FALLBACK,
  );
}

/* ------------------------------------------------------------------ *
 * computeAbsoluteDay — SC path preferred, core fallback, null when absent
 * ------------------------------------------------------------------ */
{
  // Core fallback.
  assert.equal(
    computeAbsoluteDay({ worldTime: 86400 * 5, secondsPerDay: 86400 }),
    5,
  );
  // Partial day floors down.
  assert.equal(
    computeAbsoluteDay({ worldTime: 86400 * 3 + 100, secondsPerDay: 86400 }),
    3,
  );
  // SC path wins when scTimestamp present, honoring its day length.
  assert.equal(
    computeAbsoluteDay({
      scTimestamp: 7200 * 10,
      scSecondsPerDay: 7200,
      worldTime: 0,
      secondsPerDay: 86400,
    }),
    10,
  );
  // No usable source → null.
  assert.equal(computeAbsoluteDay({}), null);
  assert.equal(computeAbsoluteDay({ worldTime: "x" }), null);
  // worldTime 0 is a valid day 0 (not null).
  assert.equal(computeAbsoluteDay({ worldTime: 0 }), 0);
}

/* ------------------------------------------------------------------ *
 * diffDays — seed / forward / same / backward
 * ------------------------------------------------------------------ */
{
  assert.deepEqual(diffDays(null, 5), { elapsed: 0, direction: "seed" });
  assert.deepEqual(diffDays(undefined, 5), { elapsed: 0, direction: "seed" });
  assert.deepEqual(diffDays(5, 6), { elapsed: 1, direction: "forward" });
  assert.deepEqual(diffDays(5, 12), { elapsed: 7, direction: "forward" });
  assert.deepEqual(diffDays(5, 5), { elapsed: 0, direction: "same" });
  assert.deepEqual(diffDays(5, 2), { elapsed: 0, direction: "backward" });
}

/* ------------------------------------------------------------------ *
 * clampElapsedForUpkeep
 * ------------------------------------------------------------------ */
{
  assert.equal(clampElapsedForUpkeep(1, 7), 1);
  assert.equal(clampElapsedForUpkeep(7, 7), 7);
  assert.equal(clampElapsedForUpkeep(400, 7), 7);
  assert.equal(clampElapsedForUpkeep(0, 7), 0);
  assert.equal(clampElapsedForUpkeep(-3, 7), 0);
  // max floored to ≥ 1.
  assert.equal(clampElapsedForUpkeep(5, 0), 1);
}

process.stdout.write("resource-calendar validation passed\n");
