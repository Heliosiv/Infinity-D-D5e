import assert from "node:assert/strict";

import {
  clampFloat,
  clampInt,
  escapeHtml,
  formatGp,
  formatMagicBias,
  formatMultiplier,
  prettyLootType,
  titleCase,
} from "./ui-util.js";

/* titleCase */
assert.equal(titleCase("uncommon"), "Uncommon");
assert.equal(titleCase(""), "");
assert.equal(titleCase(null), "");

/* prettyLootType */
assert.equal(prettyLootType("loot.weapon.magic"), "Weapon · Magic");
assert.equal(prettyLootType("loot.consumable"), "Consumable");
assert.equal(prettyLootType(""), "");

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

console.log("ui-util validation passed");
