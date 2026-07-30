/**
 * Validate the generated item-art production plan covers the full pack.
 */

import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";

import {
  existingCompendiumArtPath,
  isGeneratedItemArtPath,
  isArtworkAbsent,
  toFoundryItemArtPath,
  toRepoItemArtPath,
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
const packItemById = new Map(packItems.map((item) => [item._id, item]));
const absentItems = packItems.filter(isArtworkAbsent);
const absentItemIds = new Set(absentItems.map((item) => item._id));
const replacementAssignments = assignments.filter(
  (assignment) => assignment.replaceExisting === true,
);
let curatedGeneratedReplacements = 0;

assert.equal(
  plan.schema,
  "infinity-dnd5e-item-art-plan-v3",
  "unexpected image-plan schema",
);
assert.equal(
  assignments.length,
  absentItems.length + replacementAssignments.length,
  "plan should contain absent-art and explicitly opted-in shared assignments",
);
assert.equal(
  new Set(assignments.map((entry) => entry.itemId)).size,
  assignments.length,
  "item assignments must be unique",
);
assert.equal(assetIds.size, assets.length, "asset ids must be unique");
assert.equal(assetPaths.size, assets.length, "asset paths must be unique");

for (const assignment of assignments) {
  const item = packItemById.get(assignment.itemId);
  assert.ok(item, `assignment references missing item ${assignment.itemId}`);
  if (absentItemIds.has(assignment.itemId)) {
    assert.notEqual(
      assignment.replaceExisting,
      true,
      `absent-art item should not be marked as an existing-art replacement ${assignment.itemId}`,
    );
  } else {
    assert.equal(
      assignment.replaceExisting,
      true,
      `existing-art assignment must explicitly opt in ${assignment.itemId}`,
    );
    assert.equal(
      assignment.mode,
      "reusable",
      `existing-art replacement must use a shared asset ${assignment.itemId}`,
    );
    assert.equal(
      assignment.batchId,
      plan.sharedBatch.id,
      `existing-art replacement must belong to the active shared batch ${assignment.itemId}`,
    );
  }
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
      for (const scope of ["infinity-dnd5e"]) {
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
    for (const scope of ["infinity-dnd5e"]) {
      const art = item.flags?.[scope]?.art;
      assert.equal(
        art?.generated,
        false,
        `${item.name} ${scope} art should not be marked generated before apply`,
      );
    }
    continue;
  }

  const assignment = assignmentByItem.get(item._id);
  if (assignment?.replaceExisting === true) {
    const asset = assetById.get(assignment.assetId);
    assert.ok(asset, `shared replacement references missing asset ${item._id}`);
    assert.ok(
      asset.assignedItemIds?.includes(item._id),
      `shared asset should list its assigned item ${item._id}`,
    );
    assert.ok(
      existsSync(asset.path),
      `${item.name} shared replacement points at missing asset`,
    );
    const sourceArt = existingCompendiumArtPath(item);

    if (item.img === toFoundryItemArtPath(assignment.path)) {
      const art = item.flags?.["infinity-dnd5e"]?.art;
      assert.equal(
        art?.generated,
        true,
        `${item.name} shared replacement should be marked generated`,
      );
      assert.equal(
        art?.plannedPath,
        assignment.path,
        `${item.name} shared replacement should match plannedPath`,
      );
      assert.ok(
        sourceArt && sourceArt !== item.img,
        `${item.name} shared replacement should preserve source art as fallbackIcon`,
      );
      curatedGeneratedReplacements += 1;
      continue;
    }

    assert.equal(
      item.img,
      sourceArt,
      `${item.name} should stay on source art until its shared replacement is applied`,
    );
    assert.equal(
      item.flags?.["infinity-dnd5e"]?.art?.generated,
      false,
      `${item.name} should not be marked generated before shared apply`,
    );
    continue;
  }

  const art = item.flags?.["infinity-dnd5e"]?.art;
  if (art?.generated === true) {
    const sourceArt = existingCompendiumArtPath(item);
    const expectedImg = toFoundryItemArtPath(art.plannedPath);
    assert.ok(
      isGeneratedItemArtPath(item.img),
      `${item.name} generated replacement should use module item-art`,
    );
    assert.equal(
      item.img,
      expectedImg,
      `${item.name} generated replacement should match plannedPath`,
    );
    assert.ok(
      existsSync(toRepoItemArtPath(art.plannedPath)),
      `${item.name} generated replacement points at missing asset`,
    );
    assert.ok(
      sourceArt && sourceArt !== item.img,
      `${item.name} generated replacement should preserve source art as fallbackIcon`,
    );
    curatedGeneratedReplacements += 1;
    continue;
  }

  assert.equal(
    item.img,
    existingCompendiumArtPath(item),
    `${item.name} should preserve existing compendium artwork`,
  );

  for (const scope of ["infinity-dnd5e"]) {
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
  assignments.length,
  "plan item count should match all assignments",
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
  assignments.length,
  "assignment counts should match all planned items",
);
assert.equal(
  plan.counts.reusableAssignments,
  replacementAssignments.length,
  "reusable assignment count should match shared replacement assignments",
);
assert.equal(
  plan.counts.bespokeAssignments,
  absentItems.length,
  "bespoke assignment count should match absent-art assignments",
);
assert.equal(
  plan.sharedBatch.assignedItems,
  replacementAssignments.length,
  "shared batch item count should match opted-in replacements",
);
assert.equal(
  plan.counts.sharedAssets + plan.counts.uniqueAssets,
  assets.length,
  "asset counts should match asset lists",
);

const presentAssets = assets.filter((asset) => existsSync(asset.path)).length;
process.stdout.write(
  `image plan validation passed (${presentAssets}/${assets.length} planned assets present; ${absentItems.length} absent-art item(s); ${curatedGeneratedReplacements}/${replacementAssignments.length} shared replacement(s) applied; ${packItems.length - absentItems.length - curatedGeneratedReplacements} existing art item(s) preserved)\n`,
);
