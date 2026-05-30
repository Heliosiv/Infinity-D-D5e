/**
 * Validate the generated item-art production plan covers the full pack.
 */

import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";

const PACK_PATH = "packs/infinity-dnd5e-items.db";
const PLAN_PATH = "assets/item-art-plan.json";

const packItems = readFileSync(PACK_PATH, "utf8")
  .split(/\r?\n/)
  .filter((line) => line.trim().length > 0)
  .map((line) => JSON.parse(line));

const plan = JSON.parse(readFileSync(PLAN_PATH, "utf8"));
const itemIds = new Set(packItems.map((item) => item._id));
const assignments = plan.assignments ?? [];
const sharedAssets = plan.sharedAssets ?? [];
const uniqueAssets = plan.uniqueAssets ?? [];
const assets = [...sharedAssets, ...uniqueAssets];
const assetIds = new Set(assets.map((asset) => asset.id));
const assetPaths = new Set(assets.map((asset) => asset.path));
const assignmentByItem = new Map(
  assignments.map((assignment) => [assignment.itemId, assignment]),
);

assert.equal(
  plan.schema,
  "infinity-dnd5e-item-art-plan-v1",
  "unexpected image-plan schema",
);
assert.equal(assignments.length, packItems.length, "one assignment per item");
assert.equal(
  new Set(assignments.map((entry) => entry.itemId)).size,
  packItems.length,
  "item assignments must be unique",
);
assert.equal(assetIds.size, assets.length, "asset ids must be unique");
assert.equal(assetPaths.size, assets.length, "asset paths must be unique");

for (const assignment of assignments) {
  assert.ok(
    itemIds.has(assignment.itemId),
    `unknown item ${assignment.itemId}`,
  );
  assert.ok(
    assignment.mode === "reusable" || assignment.mode === "bespoke",
    `invalid assignment mode for ${assignment.itemId}`,
  );
  assert.ok(
    assetIds.has(assignment.assetId),
    `missing asset ${assignment.assetId}`,
  );
  assert.ok(
    assignment.path.startsWith("assets/item-art/"),
    `invalid asset path ${assignment.path}`,
  );
}

for (const asset of assets) {
  assert.ok(asset.id, "asset missing id");
  assert.ok(asset.path.startsWith("assets/item-art/"), asset.path);
  assert.ok(existsSync(asset.path), `missing generated asset ${asset.path}`);
  assert.ok(asset.prompt.includes("Foundry VTT item icon"), asset.id);
}

for (const item of packItems) {
  const assignment = assignmentByItem.get(item._id);
  assert.ok(assignment, `pack item missing art assignment ${item._id}`);
  assert.equal(
    item.img,
    assignment.path,
    `${item.name} should point at generated item art`,
  );

  for (const scope of ["infinity-dnd5e", "party-operations"]) {
    const art = item.flags?.[scope]?.art;
    assert.equal(
      art?.generated,
      true,
      `${item.name} ${scope} art should be marked generated`,
    );
    assert.equal(
      art?.plannedPath,
      assignment.path,
      `${item.name} ${scope} planned path should match assignment`,
    );
  }
}

assert.equal(
  plan.counts.items,
  packItems.length,
  "plan item count should match pack",
);
assert.equal(
  plan.counts.reusableAssignments + plan.counts.bespokeAssignments,
  packItems.length,
  "assignment counts should match pack",
);
assert.equal(
  plan.counts.sharedAssets + plan.counts.uniqueAssets,
  assets.length,
  "asset counts should match asset lists",
);

process.stdout.write(
  `image plan validation passed (${assets.length} assets for ${packItems.length} items)\n`,
);
