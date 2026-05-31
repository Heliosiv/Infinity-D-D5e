/**
 * Validate the generated item-art production plan covers the full pack.
 */

import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";

import {
  existingCompendiumArtPath,
  isArtworkAbsent,
  toFoundryItemArtPath,
} from "./art-pipeline.mjs";

const PACK_PATH = "packs/infinity-dnd5e-items.db";
const PLAN_PATH = "assets/item-art-plan.json";

const packItems = readFileSync(PACK_PATH, "utf8")
  .split(/\r?\n/)
  .filter((line) => line.trim().length > 0)
  .map((line) => JSON.parse(line));

const plan = JSON.parse(readFileSync(PLAN_PATH, "utf8"));
const assignments = plan.assignments ?? [];
const sharedAssets = plan.sharedAssets ?? [];
const uniqueAssets = plan.uniqueAssets ?? [];
const assets = [...sharedAssets, ...uniqueAssets];
const assetIds = new Set(assets.map((asset) => asset.id));
const assetPaths = new Set(assets.map((asset) => asset.path));
const assetById = new Map(assets.map((asset) => [asset.id, asset]));
const assignmentByItem = new Map(
  assignments.map((assignment) => [assignment.itemId, assignment]),
);
const absentItems = packItems.filter(isArtworkAbsent);
const absentItemIds = new Set(absentItems.map((item) => item._id));

assert.equal(
  plan.schema,
  "infinity-dnd5e-item-art-plan-v2",
  "unexpected image-plan schema",
);
assert.equal(
  assignments.length,
  absentItems.length,
  "one assignment per item missing source artwork",
);
assert.equal(
  new Set(assignments.map((entry) => entry.itemId)).size,
  absentItems.length,
  "item assignments must be unique",
);
assert.equal(assetIds.size, assets.length, "asset ids must be unique");
assert.equal(assetPaths.size, assets.length, "asset paths must be unique");

for (const assignment of assignments) {
  assert.ok(
    absentItemIds.has(assignment.itemId),
    `assignment should only target absent-art item ${assignment.itemId}`,
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
  assert.ok(asset.prompt.includes("Foundry VTT item icon"), asset.id);
}

for (const item of packItems) {
  if (isArtworkAbsent(item)) {
    const assignment = assignmentByItem.get(item._id);
    assert.ok(assignment, `absent-art item missing assignment ${item._id}`);
    const asset = assetById.get(assignment.assetId);
    assert.ok(asset, `absent-art item references missing asset ${item._id}`);
    const assetExists = existsSync(asset.path);
    const sourceArt = existingCompendiumArtPath(item);

    if (item.img === toFoundryItemArtPath(assignment.path)) {
      assert.ok(assetExists, `${item.name} points at missing generated asset`);
      for (const scope of ["infinity-dnd5e", "party-operations"]) {
        const art = item.flags?.[scope]?.art;
        assert.equal(
          art?.generated,
          true,
          `${item.name} ${scope} art should be marked generated when applied`,
        );
      }
      continue;
    }

    assert.equal(
      item.img,
      sourceArt,
      `${item.name} should stay on source placeholder until its generated asset is applied`,
    );
    for (const scope of ["infinity-dnd5e", "party-operations"]) {
      const art = item.flags?.[scope]?.art;
      assert.equal(
        art?.generated,
        false,
        `${item.name} ${scope} art should not be marked generated before apply`,
      );
    }
    continue;
  }

  assert.equal(
    item.img,
    existingCompendiumArtPath(item),
    `${item.name} should preserve existing compendium artwork`,
  );

  for (const scope of ["infinity-dnd5e", "party-operations"]) {
    const art = item.flags?.[scope]?.art;
    assert.equal(
      art?.generated,
      false,
      `${item.name} ${scope} art should not be marked generated when source art exists`,
    );
  }
}

assert.equal(
  plan.counts.items,
  absentItems.length,
  "plan item count should match absent-art items",
);
assert.equal(
  plan.counts.packItems,
  packItems.length,
  "plan scanned item count should match pack",
);
assert.equal(
  plan.counts.existingArtworkItems,
  packItems.length - absentItems.length,
  "existing artwork count should match pack",
);
assert.equal(
  plan.counts.absentArtworkItems,
  absentItems.length,
  "absent artwork count should match pack",
);
assert.equal(
  plan.counts.reusableAssignments + plan.counts.bespokeAssignments,
  absentItems.length,
  "assignment counts should match absent-art items",
);
assert.equal(
  plan.counts.sharedAssets + plan.counts.uniqueAssets,
  assets.length,
  "asset counts should match asset lists",
);

const presentAssets = assets.filter((asset) => existsSync(asset.path)).length;
process.stdout.write(
  `image plan validation passed (${presentAssets}/${assets.length} assets generated for ${absentItems.length} absent-art item(s); ${packItems.length - absentItems.length} existing art item(s) preserved)\n`,
);
