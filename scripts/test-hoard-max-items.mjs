import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const source = readFileSync("scripts/hoard-loot.js", "utf8");
const template = readFileSync("templates/hoard-loot.hbs", "utf8");
const harness = readFileSync("scripts/ui-harness.mjs", "utf8");

assert.ok(
  source.includes("const MAX_ITEMS_RANGE = Object.freeze({ min: 0, max: 30 })"),
  "hoard max-items range should allow 0 for no ceiling",
);
assert.ok(
  source.includes("count: clampInt(") && source.includes("this._form.maxItems"),
  "hoard generation should clamp maxItems before passing count to the roller",
);
assert.ok(
  template.includes("Max items <small>(0 = no max)</small>"),
  "hoard max-items label should document the no-ceiling value",
);
assert.ok(
  template.includes('title="Set to 0 for no item-count ceiling."'),
  "hoard max-items input should explain the no-ceiling value",
);
assert.ok(
  harness.includes("maxItemsMin: 0"),
  "ui harness should render the hoard no-ceiling minimum",
);

process.stdout.write("hoard max-items validation passed\n");
