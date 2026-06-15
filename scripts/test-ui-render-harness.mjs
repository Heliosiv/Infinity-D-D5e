import assert from "node:assert/strict";

import { buildUiHarnessDocument, renderHarnessViews } from "./ui-harness.mjs";

const views = renderHarnessViews();
assert.equal(views.length, 11, "harness covers all UI windows");

for (const view of views) {
  assert.ok(view.html.includes("data-action="), `${view.id}: renders actions`);
  assert.ok(
    !view.html.includes("{{"),
    `${view.id}: rendered output should not contain unresolved Handlebars`,
  );
  assert.ok(
    !/\bundefined\b|\bnull\b/.test(view.html),
    `${view.id}: rendered output should not leak null/undefined values`,
  );

  const buttonCount = countMatches(view.html, /<button\b/g);
  const actionCount = countMatches(view.html, /\bdata-action="/g);
  const closeButtonCount = countMatches(view.html, /class="window-close"/g);
  assert.equal(
    buttonCount,
    actionCount + closeButtonCount,
    `${view.id}: every rendered button except window chrome should expose data-action`,
  );

  const actionNames = [...view.html.matchAll(/\bdata-action="([^"]+)"/g)].map(
    (match) => match[1],
  );
  assert.ok(
    actionNames.every((action) => action && !action.includes("{{")),
    `${view.id}: all action names render to literal values`,
  );
}

const documentHtml = buildUiHarnessDocument();
assert.ok(
  !/>Loot\./i.test(documentHtml),
  "rendered chip labels should not leak raw loot.* keys",
);
for (const retiredLabel of [
  "Wands",
  "Rods",
  "Staves",
  "Rings",
  "Wondrous Items",
]) {
  assert.ok(
    !documentHtml.includes(retiredLabel),
    `retired stock-pool chip should not render: ${retiredLabel}`,
  );
}
for (const friendlyLabel of [
  "Magic Weapons",
  "Magic Equipment",
  "Potions &amp; Consumables",
  "Containers",
  "Rarity Balance",
  "Shop Stock",
  "Treasure Hoard",
]) {
  assert.ok(
    documentHtml.includes(friendlyLabel),
    `friendly loot chip should render: ${friendlyLabel}`,
  );
}
for (const expectedId of [
  "dashboard",
  "per-encounter",
  "hoard",
  "per-creature",
  "merchant-workspace",
  "merchant-session",
  "shop-picker",
  "shop-picker-empty",
  "reputation-workspace",
  "reputation-view",
  "reputation-view-empty",
]) {
  assert.ok(
    documentHtml.includes(`data-harness-window="${expectedId}"`),
    `full harness includes ${expectedId}`,
  );
}

process.stdout.write("ui render harness validation passed\n");

function countMatches(value, pattern) {
  return [...value.matchAll(pattern)].length;
}
