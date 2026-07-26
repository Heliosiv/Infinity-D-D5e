/**
 * Active Effect change keys must use the current D&D5e data schema. Old sense
 * paths still work through a temporary 5.3 compatibility shim, but will stop
 * working in D&D5e 6.1.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const PACK_PATH = "packs/infinity-dnd5e-items.db";
const DEPRECATED_SENSE_PATH =
  /^system\.attributes\.senses\.(darkvision|blindsight|tremorsense|truesight)$/;

const items = readFileSync(PACK_PATH, "utf8")
  .split(/\r?\n/)
  .filter((line) => line.trim().length > 0)
  .map((line) => JSON.parse(line));

const offenders = [];
for (const item of items) {
  for (const effect of item.effects ?? []) {
    for (const change of effect.changes ?? []) {
      if (!DEPRECATED_SENSE_PATH.test(change.key ?? "")) continue;
      offenders.push(
        `${item.name} (${item._id}) / ${effect.name} (${effect._id}): ${change.key}`,
      );
    }
  }
}

assert.equal(
  offenders.length,
  0,
  `pack effects must use system.attributes.senses.ranges.<sense>:\n  ${offenders.join("\n  ")}`,
);

process.stdout.write("pack effect path check passed\n");
