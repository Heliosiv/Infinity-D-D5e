import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import Handlebars from "handlebars";

import {
  buildHarnessViews,
  buildUiHarnessDocument,
  renderHarnessViews,
} from "./ui-harness.mjs";

const views = renderHarnessViews();
assert.equal(
  views.length,
  14,
  "harness covers all UI windows and both merchant tabs",
);

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
  "merchant-session-buy",
  "merchant-session-sell",
  "shop-picker",
  "shop-picker-empty",
  "resource-manager",
  "forage-prompt",
  "reputation-workspace",
  "reputation-view",
  "reputation-view-empty",
]) {
  assert.ok(
    documentHtml.includes(`data-harness-window="${expectedId}"`),
    `full harness includes ${expectedId}`,
  );
}

// Availability edge states are not part of the visual gallery's normal-result
// fixtures, so render them directly and assert the primary-button contract.
const lootFixtures = new Map(
  buildHarnessViews()
    .filter((view) =>
      ["per-encounter", "hoard", "per-creature"].includes(view.id),
    )
    .map((view) => [view.id, view]),
);
for (const id of ["per-encounter", "per-creature"]) {
  const reason = `No items match the current filters for ${id}.`;
  const html = renderFixture(lootFixtures.get(id), {
    candidateLabel: `0 items match; ${id} unavailable`,
    noCandidates: true,
    candidateUnavailableReason: reason,
    generateDisabled: true,
    generateDisabledReason: reason,
  });
  const generateButton = html.match(
    /<button\b[^>]*data-action="generate"[^>]*>/,
  )?.[0];
  assert.ok(generateButton, `${id}: renders a primary generate button`);
  assert.match(generateButton, /\bdisabled\b/);
  assert.match(generateButton, /aria-disabled="true"/);
  assert.ok(
    generateButton.includes(`title="${reason}"`),
    `${id}: blocked reason is exposed as the button tooltip`,
  );
  assert.match(
    html,
    /class="[^"]*budget-sub[^"]*is-empty[^"]*"[^>]*data-candidates/,
    `${id}: zero-match readout receives warning styling`,
  );
}

{
  const html = renderFixture(lootFixtures.get("hoard"), {
    candidateLabel: "0 items match; this roll will create a coin-only hoard",
    noCandidates: true,
    candidateUnavailableReason: "",
    generateDisabled: false,
    generateDisabledReason: "",
  });
  const generateButton = html.match(
    /<button\b[^>]*data-action="generate"[^>]*>/,
  )?.[0];
  assert.ok(generateButton, "hoard: renders a primary generate button");
  assert.doesNotMatch(
    generateButton,
    /\sdisabled(?:\s|>)/,
    "hoard: an empty item pool must not block its coin-only roll",
  );
  assert.match(html, /coin-only hoard/);
}

process.stdout.write("ui render harness validation passed\n");

function countMatches(value, pattern) {
  return [...value.matchAll(pattern)].length;
}

function renderFixture(fixture, overrides) {
  assert.ok(fixture, "requested UI harness fixture exists");
  const source = readFileSync(fixture.template, "utf8");
  return Handlebars.compile(source, {
    strict: true,
    preventIndent: true,
  })({ ...fixture.context, ...overrides });
}
