/**
 * Assert the three views of an item's price stay in sync: system.price
 * (value + denomination) converted to gp must equal the curated
 * flags.infinity-dnd5e.gpValue. Catches silent drift under hand-edits or a
 * pipeline change.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const PACK_PATH = "packs/infinity-dnd5e-items.db";
const DENOM = { pp: 10, gp: 1, ep: 0.5, sp: 0.1, cp: 0.01 };

const items = readFileSync(PACK_PATH, "utf8")
  .split(/\r?\n/)
  .filter((line) => line.trim().length > 0)
  .map((line) => JSON.parse(line));

const offenders = [];
let checked = 0;
for (const item of items) {
  const flag = item.flags?.["infinity-dnd5e"];
  const price = item.system?.price;
  if (!flag || !price || price.value == null || flag.gpValue == null) continue;
  checked += 1;
  const gp =
    Math.round(price.value * (DENOM[price.denomination] ?? 1) * 100) / 100;
  const eps = Math.max(0.011, gp * 0.001);
  if (Math.abs(gp - flag.gpValue) > eps) {
    offenders.push(
      `${item.name} (${item._id}): price ${price.value} ${price.denomination} = ${gp} gp vs gpValue ${flag.gpValue}`,
    );
  }
}

assert.equal(
  offenders.length,
  0,
  `price/gpValue mismatches:\n  ${offenders.slice(0, 40).join("\n  ")}`,
);

process.stdout.write(
  `pack pricing check passed (${checked} priced items consistent)\n`,
);
