#!/usr/bin/env node
/**
 * Build a deterministic production plan for generated item art.
 *
 * The pack stays usable with Foundry core icons while this plan is the
 * generation queue: reusable assets for commodity/basic variants, bespoke
 * assets for named or high-value items.
 */

import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import {
  artworkAbsenceReason,
  existingCompendiumArtPath,
  isArtworkAbsent,
} from "./art-pipeline.mjs";

const PACK_PATH = "packs/infinity-dnd5e-items.db";
const PLAN_PATH = "assets/item-art-plan.json";
const SUMMARY_PATH = "assets/item-art-plan.md";
const SHARED_ROOT = "assets/item-art/shared";
const UNIQUE_ROOT = "assets/item-art/unique";
const SHARED_BATCH = Object.freeze({
  id: "shared-impact-1",
  sequence: 1,
  maxAssets: 5,
  fileSuffix: "batch-1",
  selection: "highest-assignment-count",
});

const SHARED_ICON_SPECS = Object.freeze({
  "consumable/spells-spell-scrolls": {
    primaryRequest:
      "one tightly rolled aged parchment scroll secured with a dark blue wax seal and a narrow silver cord, with a restrained violet-blue arcane glow leaking softly from the rolled edges",
    constraints:
      "exactly one primary scroll; blank visible parchment with no writing; no readable glyphs",
    avoid:
      "open book, stack of scrolls, photorealistic product photography, neon saturation, excessive particles, ornate border, clutter",
  },
  "consumable/consumables-arcane-consumables": {
    primaryRequest:
      "one palm-sized sealed crystal phial with a wax stopper and a narrow rune-etched silver band, holding a restrained violet-blue magical glow",
    constraints: "exactly one primary item",
    avoid:
      "photorealistic product photography, neon saturation, excessive particles, ornate border, clutter",
  },
  "loot/sundries-adventuring-gear-general-loot": {
    primaryRequest:
      "one compact weathered leather utility satchel, buckled shut, with a short coil of cord and the handle of a small practical tool tucked neatly beneath the flap",
    constraints: "one unified primary object; no loose treasure pile; no coins",
    avoid:
      "photorealistic product photography, neon saturation, excessive particles, ornate border, clutter",
  },
  "container/container": {
    primaryRequest:
      "one sturdy weathered leather travel backpack with a buckled flap, reinforced seams, compact bedroll straps, and a practical adventurer-made silhouette",
    constraints:
      "exactly one primary container; no contents spilling out; no modern hiking pack",
    avoid:
      "photorealistic product photography, neon saturation, excessive particles, ornate border, clutter",
  },
  "equipment/sundries-wondrous-items-apparel-accessories": {
    primaryRequest:
      "one ornate silver cloak clasp shaped as a restrained interlocking knot, set with a small deep-blue gemstone and a faint protective magical glow",
    constraints:
      "exactly one primary wearable accessory; no clothing mannequin; no crown",
    avoid:
      "photorealistic jewelry photography, neon saturation, excessive particles, ornate border, clutter",
  },
  "weapon/weapons-magic-weapons-martial-melee": {
    primaryRequest:
      "one elegant battle-worn enchanted longsword with a broad readable silhouette, weathered steel, a practical leather grip, and a restrained line of cool-blue runic light along the fuller",
    constraints:
      "exactly one weapon; no shield, scabbard, blood, or cropped blade",
    avoid:
      "oversized anime weapon, neon saturation, excessive particles, ornate border, clutter",
  },
});

const BASIC_FOLDER_PATTERNS = [
  /adventuring-gear/,
  /ammunition/,
  /containers-packs/,
  /food-provisions/,
  /gemstones/,
  /jewelry-tokens/,
  /mundane-weapons/,
  /tools/,
  /trade-goods/,
];

const REUSABLE_NAME_PATTERNS = [
  /\+\d\b/,
  /\[[^\]]+\]/,
  /^adamantine\b/i,
  /^mithral\b/i,
  /^silvered?\b/i,
  /^spell scroll\b/i,
  /^vicious\b/i,
  /armor of resistance/i,
  /healing potion/i,
  /potion of .*healing/i,
  /weapon of warning/i,
];

const NAMED_FAMILY_PATTERNS = [
  "defender",
  "flame tongue",
  "frost brand",
  "giant slayer",
  "holy avenger",
  "ioun stone",
  "luck blade",
  "nine lives stealer",
  "ring of",
  "staff of",
  "wand of",
  "weapon of",
];

const RARITY_RANK = new Map([
  ["common", 1],
  ["uncommon", 2],
  ["rare", 3],
  ["very-rare", 4],
  ["veryRare", 4],
  ["legendary", 5],
  ["artifact", 6],
]);

function slugify(value) {
  return String(value ?? "")
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/\([^)]*\)/g, " ")
    .replace(/\[[^\]]*\]/g, " ")
    .replace(/\+\d\b/g, " ")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 90);
}

function packFlags(item) {
  const legacy = item.flags?.["party-operations"] ?? {};
  const native = item.flags?.["infinity-dnd5e"] ?? {};
  return {
    ...legacy,
    ...native,
    keywords: native.keywords ?? legacy.keywords,
    folder: native.folder ?? legacy.folder,
    details: native.details ?? legacy.details,
    lootType: native.lootType ?? legacy.lootType,
    rarityNormalized: native.rarityNormalized ?? legacy.rarityNormalized,
    gpValue: native.gpValue ?? legacy.gpValue,
    lootWeight: native.lootWeight ?? legacy.lootWeight,
    maxRecommendedQty: native.maxRecommendedQty ?? legacy.maxRecommendedQty,
    lootEligible: native.lootEligible ?? legacy.lootEligible,
  };
}

function keywords(item) {
  return packFlags(item).keywords ?? [];
}

function keywordValue(item, prefix) {
  return keywords(item)
    .find((keyword) => keyword.startsWith(prefix))
    ?.slice(prefix.length);
}

function folderPath(item) {
  return (
    packFlags(item).folder?.pathKey ??
    keywordValue(item, "folder.path.")?.replaceAll(".", "/") ??
    ""
  );
}

function lootType(item) {
  return (
    packFlags(item).lootType ??
    keywordValue(item, "loot.") ??
    item.type ??
    "item"
  );
}

function sourceClass(item) {
  return keywordValue(item, "source.class.") ?? "";
}

function rarity(item) {
  return (
    packFlags(item).rarityNormalized ?? item.system?.rarity ?? item.rarity ?? ""
  );
}

function rarityRank(item) {
  return RARITY_RANK.get(rarity(item)) ?? 0;
}

function gpValue(item) {
  return Number(packFlags(item).gpValue ?? item.system?.price?.value ?? 0) || 0;
}

function baseItem(item) {
  return (
    keywordValue(item, "base.") ??
    item.system?.type?.baseItem ??
    item.system?.type?.value ??
    item.type ??
    "item"
  );
}

function stripHtml(html) {
  return String(html ?? "")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&#39;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/\s+/g, " ")
    .trim();
}

function itemDescription(item) {
  const text = stripHtml(
    item.system?.description?.chat || item.system?.description?.value,
  );
  if (!text) return "";
  return text.length > 220 ? `${text.slice(0, 217).trim()}...` : text;
}

function hasReusableName(item) {
  return REUSABLE_NAME_PATTERNS.some((pattern) => pattern.test(item.name));
}

function namedFamily(item) {
  const normalized = item.name.toLowerCase();
  return (
    NAMED_FAMILY_PATTERNS.find((pattern) => normalized.includes(pattern)) ?? ""
  );
}

function gemFamily(item) {
  const normalized = item.name.toLowerCase();
  if (/ruby|garnet/.test(normalized)) return "red-gemstone";
  if (/emerald|alexandrite/.test(normalized)) return "green-gemstone";
  if (/sapphire|azurite/.test(normalized)) return "blue-gemstone";
  if (/amethyst/.test(normalized)) return "purple-gemstone";
  if (/diamond/.test(normalized)) return "clear-diamond";
  if (/topaz|amber/.test(normalized)) return "gold-gemstone";
  if (/opal/.test(normalized)) return "opal-gemstone";
  if (/agate/.test(normalized)) return "banded-agate";
  if (/aquamarine/.test(normalized)) return "aqua-gemstone";
  return "mixed-gemstone";
}

function foodFamily(item) {
  const normalized = item.name.toLowerCase();
  if (/ale|wine|beer|drink/.test(normalized)) return "drink";
  if (/fish/.test(normalized)) return "fish";
  if (/meat|brined/.test(normalized)) return "meat";
  if (/stew|soup/.test(normalized)) return "stew";
  if (/meal|ration|food/.test(normalized)) return "meal";
  return "provisions";
}

function reusableKey(item) {
  const folder = folderPath(item);
  const type = item.type ?? "item";
  const family = namedFamily(item);

  if (/gemstones/.test(folder)) return `gemstone/${gemFamily(item)}`;
  if (/jewelry-tokens/.test(folder))
    return `jewelry/${slugify(baseItem(item) || item.name)}`;
  if (/food-provisions/.test(folder)) return `food/${foodFamily(item)}`;
  if (/containers-packs/.test(folder))
    return `container/${slugify(baseItem(item) || folder)}`;
  if (/tools/.test(folder))
    return `tool/${slugify(baseItem(item) || item.name)}`;
  if (/ammunition/.test(folder))
    return `ammunition/${slugify(baseItem(item) || "ammunition")}`;
  if (/mundane-weapons|magic-weapons/.test(folder) && hasReusableName(item)) {
    return `weapon/${slugify(family || baseItem(item))}`;
  }
  if (/armor|magic-armor-shields/.test(folder) && hasReusableName(item)) {
    return `armor/${slugify(baseItem(item))}`;
  }
  if (/potions/.test(folder)) {
    return `potion/${slugify(item.name.replace(/\b(greater|superior|supreme)\b/gi, ""))}`;
  }
  if (item.type === "spell") {
    const school =
      item.system?.school ?? keywordValue(item, "spell.school.") ?? "spell";
    const level =
      item.system?.level ?? keywordValue(item, "spell.level.") ?? "unknown";
    return `spell/${slugify(`${school}-level-${level}`)}`;
  }
  if (family && !isBespokeCandidate(item))
    return `named-family/${slugify(family)}`;
  return `${type}/${slugify(folder || lootType(item) || type)}`;
}

function isBespokeCandidate(item) {
  if (isArtworkAbsent(item)) return true;
  const reusableFolder = BASIC_FOLDER_PATTERNS.some((pattern) =>
    pattern.test(folderPath(item)),
  );
  if (reusableFolder || hasReusableName(item)) return false;
  if (item.name.startsWith("(DOEF)")) return true;
  if (
    sourceClass(item) === "curated" &&
    (rarityRank(item) >= 3 || gpValue(item) >= 1000)
  ) {
    return true;
  }
  if (rarityRank(item) >= 5 || gpValue(item) >= 10000) return true;
  return false;
}

function assetPrompt({ label, item, mode }) {
  const subject = mode === "bespoke" ? `"${item.name}"` : label;
  const details = item ? itemDescription(item) : "";
  const detailLine = details ? ` Defining details: ${details}` : "";
  return [
    "Use case: stylized-concept",
    "Asset type: Foundry VTT item icon, square inventory art",
    `Primary request: Create a polished fantasy RPG item icon for ${subject}.`,
    "Style/medium: hand-painted fantasy inventory icon, crisp silhouette, high-detail object render.",
    "Composition/framing: centered single item, three-quarter view or readable flat lay, generous padding, readable at 64px.",
    "Lighting/mood: soft dramatic rim light, subtle magical glow only when appropriate.",
    "Background: dark neutral vignette or parchment-toned tabletop, not transparent.",
    "Constraints: no text, no numbers, no watermark, no UI frame, no character hands, no logo.",
    `Context: item type ${item?.type ?? "item"}, rarity ${rarity(item) || "common"}, folder ${folderPath(item) || "general"}.${detailLine}`,
  ].join("\n");
}

function sharedAssetPrompt({ key, label, item }) {
  const spec = SHARED_ICON_SPECS[key] ?? {
    primaryRequest: `one representative ${label.toLowerCase()} item`,
    constraints: "exactly one primary item",
    avoid:
      "photorealistic product photography, neon saturation, excessive particles, ornate border, clutter",
  };
  return [
    "Use case: stylized-concept",
    "Asset type: Foundry VTT item icon, square game UI inventory art",
    `Primary request: Create a polished shared fantasy RPG icon representing ${label.toLowerCase()}: ${spec.primaryRequest}.`,
    "Style/medium: premium hand-painted fantasy inventory icon; crisp silhouette; richly textured but uncluttered; consistent with a serious D&D compendium.",
    "Composition/framing: centered single object in three-quarter view, generous padding, fully visible, unmistakable at 64px.",
    "Lighting/mood: soft dramatic rim light, restrained highlights or magical glow when appropriate, high local contrast around the silhouette.",
    "Scene/backdrop: dark neutral charcoal-brown vignette, opaque and quiet.",
    `Constraints: ${spec.constraints}; no text, letters, numbers, watermark, logo, UI frame, hands, characters, creatures, scenery, or cropped edges.`,
    `Avoid: ${spec.avoid}.`,
    `Context: item type ${item?.type ?? "item"}, rarity ${rarity(item) || "common"}, folder ${folderPath(item) || "general"}.`,
  ].join("\n");
}

function sharedLabel(assetId) {
  return assetId
    .replace(/^shared\//, "")
    .replace(/[/-]/g, " ")
    .replace(/\b\w/g, (letter) => letter.toUpperCase());
}

async function main() {
  const raw = await readFile(PACK_PATH, "utf8");
  const items = raw
    .split(/\r?\n/)
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line));

  const absentItems = items.filter(isArtworkAbsent);
  const existingArtItems = items.length - absentItems.length;
  const itemById = new Map(items.map((item) => [item._id, item]));
  const sharedCandidateMap = new Map();
  const uniqueAssets = [];
  const assignments = [];

  for (const item of absentItems) {
    const absenceReason = artworkAbsenceReason(item);
    const currentImg = existingCompendiumArtPath(item);
    const mode = "bespoke";
    const assetId = `unique/${slugify(item.name)}-${item._id}`;
    const assetPath = `${UNIQUE_ROOT}/${slugify(item.name)}-${item._id}.webp`;
    uniqueAssets.push({
      id: assetId,
      itemId: item._id,
      itemName: item.name,
      path: assetPath,
      prompt: assetPrompt({ label: item.name, item, mode }),
    });
    assignments.push({
      itemId: item._id,
      name: item.name,
      mode,
      assetId,
      path: assetPath,
      currentImg,
      absenceReason,
    });
  }

  for (const item of items) {
    if (isArtworkAbsent(item) || isBespokeCandidate(item)) continue;
    const key = reusableKey(item);
    const slug = slugify(key);
    const assetId = `shared/${slug}-${SHARED_BATCH.fileSuffix}`;
    if (!sharedCandidateMap.has(assetId)) {
      sharedCandidateMap.set(assetId, {
        id: assetId,
        key,
        label: sharedLabel(`shared/${slug}`),
        path: `${SHARED_ROOT}/${slug}-${SHARED_BATCH.fileSuffix}.webp`,
        assignedItemIds: [],
        prompt: sharedAssetPrompt({
          key,
          label: sharedLabel(`shared/${slug}`),
          item,
        }),
      });
    }
    sharedCandidateMap.get(assetId).assignedItemIds.push(item._id);
  }

  const sharedAssets = [...sharedCandidateMap.values()]
    .sort(
      (a, b) =>
        b.assignedItemIds.length - a.assignedItemIds.length ||
        a.id.localeCompare(b.id),
    )
    .slice(0, SHARED_BATCH.maxAssets)
    .map((asset, index) => ({
      ...asset,
      batchId: SHARED_BATCH.id,
      priority: index + 1,
      impact: asset.assignedItemIds.length,
    }));

  for (const asset of sharedAssets) {
    for (const itemId of asset.assignedItemIds) {
      const item = itemById.get(itemId);
      assignments.push({
        itemId,
        name: item.name,
        mode: "reusable",
        assetId: asset.id,
        path: asset.path,
        currentImg: existingCompendiumArtPath(item),
        absenceReason: "",
        replaceExisting: true,
        batchId: SHARED_BATCH.id,
      });
    }
  }

  uniqueAssets.sort((a, b) => a.id.localeCompare(b.id));

  const plan = {
    schema: "infinity-dnd5e-item-art-plan-v3",
    styleGuide:
      "Square hand-painted fantasy inventory icons, single readable object, no text, no watermark, dark neutral background.",
    paths: {
      sharedRoot: SHARED_ROOT,
      uniqueRoot: UNIQUE_ROOT,
    },
    sharedBatch: {
      id: SHARED_BATCH.id,
      sequence: SHARED_BATCH.sequence,
      selection: SHARED_BATCH.selection,
      maxAssets: SHARED_BATCH.maxAssets,
      assignedItems: assignments.filter(
        (entry) => entry.batchId === SHARED_BATCH.id,
      ).length,
    },
    counts: {
      packItems: items.length,
      existingArtworkItems: existingArtItems,
      absentArtworkItems: absentItems.length,
      items: assignments.length,
      reusableAssignments: assignments.filter(
        (entry) => entry.mode === "reusable",
      ).length,
      bespokeAssignments: assignments.filter(
        (entry) => entry.mode === "bespoke",
      ).length,
      sharedAssets: sharedAssets.length,
      uniqueAssets: uniqueAssets.length,
      totalAssetsToGenerate: sharedAssets.length + uniqueAssets.length,
    },
    sharedAssets,
    uniqueAssets,
    assignments,
  };

  await mkdir(path.dirname(PLAN_PATH), { recursive: true });
  await writeFile(PLAN_PATH, `${JSON.stringify(plan, null, 2)}\n`, "utf8");
  await writeFile(SUMMARY_PATH, `${buildSummary(plan)}\n`, "utf8");

  console.log(
    `Planned ${plan.counts.totalAssetsToGenerate} generated art assets for ${assignments.length} item assignment(s).`,
  );
  console.log(`  scanned: ${items.length} pack items`);
  console.log(`  preserved: ${existingArtItems} existing artwork items`);
  console.log(
    `  shared: ${plan.counts.sharedAssets} assets for ${plan.counts.reusableAssignments} items`,
  );
  console.log(
    `  unique: ${plan.counts.uniqueAssets} assets for ${plan.counts.bespokeAssignments} items`,
  );
}

function buildSummary(plan) {
  const topShared = [...plan.sharedAssets]
    .sort((a, b) => b.assignedItemIds.length - a.assignedItemIds.length)
    .slice(0, 12);
  return [
    "# Infinity D&D5e Item Art Plan",
    "",
    "Selective generated-art plan. Shared impact batch 1 explicitly replaces source icons for its assigned items; all other existing compendium icons remain protected. Missing-source items retain bespoke assignments.",
    "",
    "## Counts",
    "",
    `- Pack items scanned: ${plan.counts.packItems}`,
    `- Existing artwork preserved: ${plan.counts.existingArtworkItems}`,
    `- Items missing source artwork: ${plan.counts.absentArtworkItems}`,
    `- Shared impact batch: ${plan.sharedBatch.id}`,
    `- Shared batch item assignments: ${plan.sharedBatch.assignedItems}`,
    `- Reusable assignments: ${plan.counts.reusableAssignments}`,
    `- Bespoke assignments: ${plan.counts.bespokeAssignments}`,
    `- Shared assets to generate: ${plan.counts.sharedAssets}`,
    `- Unique assets to generate: ${plan.counts.uniqueAssets}`,
    `- Total generated assets: ${plan.counts.totalAssetsToGenerate}`,
    "",
    "## Shared Impact Batch 1",
    "",
    ...(topShared.length > 0
      ? topShared.map(
          (asset) =>
            `- Priority ${asset.priority}: ${asset.id}: ${asset.assignedItemIds.length} items -> ${asset.path}`,
        )
      : ["- None"]),
    "",
    "## Absent Items",
    "",
    ...(plan.assignments.some((assignment) => assignment.absenceReason)
      ? plan.assignments
          .filter((assignment) => assignment.absenceReason)
          .map(
            (assignment) =>
              `- ${assignment.name} (${assignment.itemId}): ${assignment.absenceReason}`,
          )
      : ["- None"]),
    "",
    "## Generation Style",
    "",
    plan.styleGuide,
    "",
    "The full machine-readable queue lives in `assets/item-art-plan.json`.",
  ].join("\n");
}

main().catch((error) => {
  console.error(error?.stack ?? error?.message ?? String(error));
  process.exitCode = 1;
});
