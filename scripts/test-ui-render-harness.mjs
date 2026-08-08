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
  19,
  "harness covers all UI windows, both merchant tabs, and resource states",
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
  "resource-manager-locked",
  "resource-manager-custom-environment",
  "resource-overview",
  "resource-overview-offline",
  "forage-prompt",
  "critical-injury",
  "reputation-workspace",
  "reputation-view",
  "reputation-view-empty",
]) {
  assert.ok(
    documentHtml.includes(`data-harness-window="${expectedId}"`),
    `full harness includes ${expectedId}`,
  );
}

const encounterView = views.find((view) => view.id === "per-encounter");
assert.ok(encounterView, "harness includes Per-Encounter Loot");
assert.match(encounterView.html, /Roll Chances/);
assert.match(encounterView.html, /First item of a fresh Generate/);
assert.match(encounterView.html, /data-chance-group="category"/);
assert.match(encounterView.html, /mixed bundles stop at one spell scroll/i);

const suppliesView = views.find((view) => view.id === "resource-overview");
assert.ok(suppliesView, "harness includes the player Party Supplies view");
assert.match(suppliesView.html, /Updated Jul 25, 2026, 2:14 PM/);
assert.match(suppliesView.html, /aria-live="polite"/);
assert.match(suppliesView.html, /Supply outlook/);
assert.match(suppliesView.html, /Last upkeep/);

const injuryView = views.find((view) => view.id === "critical-injury");
assert.ok(injuryView, "harness includes the player Critical Injuries view");
assert.match(injuryView.html, /Critical Injury Table V2/);
assert.match(injuryView.html, /data-action="rollInjury"/);
assert.match(injuryView.html, /data-action="requestTreatment"/);
assert.match(injuryView.html, /Shattered Knee/);
assert.match(injuryView.html, /12 Eleasis, 1492 DR/);

const suppliesOfflineView = views.find(
  (view) => view.id === "resource-overview-offline",
);
assert.ok(suppliesOfflineView, "harness includes Party Supplies offline state");
assert.match(suppliesOfflineView.html, /No GM is online right now/);

const lockedManagerView = views.find(
  (view) => view.id === "resource-manager-locked",
);
assert.ok(
  lockedManagerView,
  "harness includes the interrupted Quartermaster state",
);
assert.match(lockedManagerView.html, /did not finish cleanly/);
assert.match(lockedManagerView.html, /data-action="clearInterruptedRun"/);
assert.match(lockedManagerView.html, /Clear after review/);

const customEnvironmentView = views.find(
  (view) => view.id === "resource-manager-custom-environment",
);
assert.ok(
  customEnvironmentView,
  "harness includes the Quartermaster custom-region editor",
);
assert.match(customEnvironmentView.html, /Edit current custom environment/);
assert.match(customEnvironmentView.html, /data-environment-field="label"/);
assert.match(customEnvironmentView.html, /data-environment-field="yieldFood"/);
assert.match(customEnvironmentView.html, /Ashen March/);

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
  const fixture = lootFixtures.get(id);
  const rarityOptions = fixture.context.rarityOptions.map((option, index) =>
    index === 0
      ? {
          ...option,
          count: 0,
          selected: false,
          unavailable: true,
          selectedUnavailable: false,
          disabled: true,
          availabilityTitle: reason,
        }
      : option,
  );
  const html = renderFixture(lootFixtures.get(id), {
    candidateLabel: `0 items match; ${id} unavailable`,
    noCandidates: true,
    candidateUnavailableReason: reason,
    generateDisabled: true,
    generateDisabledReason: reason,
    rarityOptions,
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
  const unavailableChip = html.match(
    /<label\b[^>]*data-chip-value="common"[^>]*>[\s\S]*?<\/label>/,
  )?.[0];
  assert.ok(unavailableChip, `${id}: renders the unavailable rarity chip`);
  assert.match(unavailableChip, /\bis-unavailable\b/);
  assert.match(unavailableChip, /aria-disabled="true"/);
  assert.match(unavailableChip, /<input\b[^>]*\bdisabled\b/);
  assert.match(unavailableChip, /data-chip-count>0<\/em>/);
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

{
  const resourceFixture = buildHarnessViews().find(
    (view) => view.id === "resource-manager",
  );
  const defaultHtml = renderFixture(resourceFixture, {});
  assert.equal(
    countMatches(defaultHtml, /data-config-path="roster:[^"]+:consumes"/g),
    2,
    "resource manager exposes a daily-consumer toggle for every tracked actor",
  );
  const html = renderFixture(resourceFixture, {
    canRunResourceWrites: false,
    hasResourceConflictWarnings: true,
    hasBlockingResourceConflicts: true,
    resourceConflictWarnings: [
      {
        message:
          "Aric's Trail Rations matches multiple resources: Food, Meals.",
        isBlocking: true,
      },
    ],
  });
  assert.match(html, /role="alert"/);
  assert.match(html, /Resource rules need attention/);
  assert.match(html, /matches multiple resources: Food, Meals/);
  for (const action of ["advanceDay", "forageDrive"]) {
    const button = html.match(
      new RegExp(`<button\\b[^>]*data-action="${action}"[^>]*>`),
    )?.[0];
    assert.ok(button, `resource manager: renders ${action}`);
    assert.match(button, /\bdisabled\b/);
    assert.match(button, /aria-disabled="true"/);
    assert.match(button, /blocking resource conflicts are fixed/);
  }
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
