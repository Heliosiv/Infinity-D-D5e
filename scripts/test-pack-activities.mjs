/**
 * Inert item types (loot, container) must carry no activities. The pack used to
 * stamp every such item with a phantom "Use X" utility activity that rendered a
 * meaningless clickable button on the sheet; this keeps them inert.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const PACK_PATH = "packs/infinity-dnd5e-items.db";
const INERT = new Set(["loot", "container"]);

const items = readFileSync(PACK_PATH, "utf8")
  .split(/\r?\n/)
  .filter((line) => line.trim().length > 0)
  .map((line) => JSON.parse(line));

const offenders = [];
for (const item of items) {
  if (!INERT.has(item.type)) continue;
  const n = Object.keys(item.system?.activities || {}).length;
  if (n > 0)
    offenders.push(
      `${item.name} (${item._id}): ${item.type} carries ${n} activit${n > 1 ? "ies" : "y"}`,
    );
}

assert.equal(
  offenders.length,
  0,
  `inert loot/container items must have no activities:\n  ${offenders.slice(0, 40).join("\n  ")}`,
);

process.stdout.write(
  `pack activities check passed (loot/container items inert)\n`,
);
