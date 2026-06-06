import assert from "node:assert/strict";

import {
  clampFloat,
  clampInt,
  escapeHtml,
  formatGp,
  formatMagicBias,
  formatMultiplier,
  plainTextLootSummary,
  prettyLootType,
  prettyRarity,
  LOOT_TYPE_LABELS,
  titleCase,
} from "./ui-util.js";
import { LOOT_TYPES } from "./loot/tag-vocabulary.js";

/* titleCase */
assert.equal(titleCase("uncommon"), "Uncommon");
assert.equal(titleCase(""), "");
assert.equal(titleCase(null), "");

/* prettyLootType — friendly plain-noun labels */
assert.equal(prettyLootType("loot.weapon.magic"), "Magic Weapons");
assert.equal(prettyLootType("loot.weapon.mundane"), "Weapons");
assert.equal(prettyLootType("loot.consumable"), "Potions & Consumables");
assert.equal(prettyLootType("loot.ammunition"), "Ammunition");
assert.equal(prettyLootType("loot.trade-good"), "Trade Goods");
assert.equal(prettyLootType(""), "");
// Unmapped keys fall back to the generic "Category · Subtype" transform.
assert.equal(prettyLootType("loot.mystery.box"), "Mystery · Box");

/* every canonical loot type has a friendly label (guards against drift) */
for (const key of LOOT_TYPES) {
  assert.ok(
    LOOT_TYPE_LABELS[key],
    `LOOT_TYPE_LABELS is missing a label for ${key}`,
  );
}

/* prettyRarity */
assert.equal(prettyRarity("very-rare"), "Very Rare");
assert.equal(prettyRarity("uncommon"), "Uncommon");
assert.equal(prettyRarity(""), "");
assert.equal(prettyRarity(null), "");

/* formatGp — locale-robust (compare against the same toLocaleString) */
assert.equal(formatGp(0), "0 gp");
assert.equal(formatGp(-5), "0 gp", "non-positive collapses to 0 gp");
assert.equal(formatGp(NaN), "0 gp");
assert.equal(formatGp(1234.6), `${(1235).toLocaleString()} gp`, "rounds");
assert.equal(
  formatGp("500"),
  `${(500).toLocaleString()} gp`,
  "coerces strings",
);

/* formatMultiplier */
assert.equal(formatMultiplier(1.5), "1.50");
assert.equal(formatMultiplier(0.65), "0.65");
assert.equal(formatMultiplier("nope"), "1.00");

/* formatMagicBias */
assert.equal(formatMagicBias(0), "Neutral");
assert.equal(formatMagicBias(0.01), "Neutral", "deadzone near zero");
assert.equal(formatMagicBias(0.5), "+50% Magic");
assert.equal(formatMagicBias(-0.5), "+50% Mundane");
assert.equal(formatMagicBias(NaN), "Neutral");

/* clampFloat / clampInt */
assert.equal(clampFloat(5, 0, 10, 1), 5);
assert.equal(clampFloat(-3, 0, 10, 1), 0, "clamps to min");
assert.equal(clampFloat(99, 0, 10, 1), 10, "clamps to max");
assert.equal(clampFloat("nope", 0, 10, 7), 7, "non-numeric uses fallback");
assert.equal(clampInt(5.9, 0, 10, 1), 5, "floors");
assert.equal(clampInt(99, 0, 10, 1), 10);
assert.equal(clampInt("nope", 0, 10, 3), 3);

/* escapeHtml */
assert.equal(
  escapeHtml(`<a href="x">&</a>`),
  "&lt;a href=&quot;x&quot;&gt;&amp;&lt;/a&gt;",
);
assert.equal(escapeHtml(null), "");

/* plainTextLootSummary */
{
  // null / non-object → empty string (nothing to copy)
  assert.equal(plainTextLootSummary(null), "");
  assert.equal(plainTextLootSummary(undefined), "");
  assert.equal(plainTextLootSummary("nope"), "");

  // Flat bundle (Per-Encounter shape)
  const flat = plainTextLootSummary(
    {
      items: [
        {
          displayName: "Flame Tongue",
          quantity: 1,
          rarity: "rare",
          gpTotal: 5000,
        },
        { displayName: "Arrows", quantity: 20, rarity: "common", gpTotal: 1 },
      ],
      totalGpLabel: "5,001 gp",
    },
    { title: "Loot Forge" },
  );
  const flatLines = flat.split("\n");
  assert.equal(flatLines[0], "Loot Forge", "title heads the summary");
  assert.ok(
    flatLines.includes("- Flame Tongue (Rare · 5,000 gp)"),
    "single item line, no qty prefix",
  );
  assert.ok(
    flatLines.includes("- 20× Arrows (Common · 1 gp)"),
    "stacked item shows ×N",
  );
  assert.equal(flatLines.at(-1), "Total: 5,001 gp", "total closes the summary");

  // Hoard shape — coin pile line before total
  const hoard = plainTextLootSummary(
    {
      items: [
        { displayName: "Ruby", quantity: 1, rarity: "uncommon", gpTotal: 100 },
      ],
      coinPileGp: 250,
      coinPileLabel: "250 gp",
      coinBreakdownLabel: "2pp, 5gp",
      totalGpLabel: "350 gp",
    },
    { title: "Hoard Loot" },
  );
  assert.ok(
    hoard.includes("Coin pile: 250 gp (2pp, 5gp)"),
    "coin pile rendered with breakdown",
  );
  assert.ok(hoard.endsWith("Total: 350 gp"));

  // Per-Creature shape — grouped by creature, empty creature noted
  const perCreature = plainTextLootSummary({
    creatures: [
      {
        name: "Goblin",
        totalGpLabel: "10 gp",
        items: [
          { displayName: "Dagger", quantity: 1, rarity: "common", gpTotal: 10 },
        ],
      },
      { name: "Orc", totalGpLabel: "0 gp", items: [] },
    ],
    grandTotalLabel: "10 gp",
  });
  assert.ok(perCreature.includes("Goblin — 10 gp"), "creature heading + total");
  assert.ok(
    perCreature.includes("  - Dagger (Common · 10 gp)"),
    "indented drop",
  );
  assert.ok(perCreature.includes("Orc — 0 gp"));
  assert.ok(perCreature.includes("  - (no drops)"), "empty creature noted");
  assert.ok(perCreature.endsWith("Total: 10 gp"));

  // Falls back to formatGp when label fields are absent
  const noLabels = plainTextLootSummary({ items: [], totalGp: 0 });
  assert.ok(noLabels.endsWith("Total: 0 gp"));
}

console.log("ui-util validation passed");
