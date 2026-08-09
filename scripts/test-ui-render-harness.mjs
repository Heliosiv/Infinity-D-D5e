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
  34,
  "harness covers all UI windows, overlays, merchant tabs, resource states, and downtime states",
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
  "resource-manager-recent-runs",
  "resource-manager-custom-environment",
  "resource-overview",
  "resource-overview-offline",
  "downtime-workspace-empty",
  "downtime-workspace-collecting",
  "downtime-workspace-locked",
  "downtime-workspace-preview",
  "downtime-workspace-recovery",
  "downtime-workspace-applying",
  "downtime-workspace-history-completed",
  "downtime-activities-available",
  "downtime-activities-pending",
  "downtime-activities-locked",
  "downtime-activities-applying",
  "downtime-activities-resolved",
  "downtime-activities-no-gm",
  "forage-prompt",
  "critical-injury",
  "critical-injury-hud",
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

const dashboardView = views.find((view) => view.id === "dashboard");
assert.ok(dashboardView, "harness includes the GM dashboard");
assert.match(dashboardView.html, /Downtime Workspace/);

const merchantSellView = views.find(
  (view) => view.id === "merchant-session-sell",
);
assert.ok(merchantSellView, "harness includes the merchant sell tab");
assert.match(merchantSellView.html, /Stolen Signet Ring/);
assert.match(merchantSellView.html, /require fencing during downtime/);
assert.match(merchantSellView.html, /Fencing only/);

const downtimeEmptyView = views.find(
  (view) => view.id === "downtime-workspace-empty",
);
assert.ok(downtimeEmptyView, "harness includes empty GM downtime state");
assert.match(downtimeEmptyView.html, /Open a downtime block/);
assert.match(downtimeEmptyView.html, /data-action="createBlock"/);
assert.match(downtimeEmptyView.html, /8 productive hours per day/);

const downtimeCollectingView = views.find(
  (view) => view.id === "downtime-workspace-collecting",
);
assert.ok(
  downtimeCollectingView,
  "harness includes collecting GM downtime state",
);
assert.match(downtimeCollectingView.html, /Player queues/);
assert.match(downtimeCollectingView.html, /1 \/ 2 submitted/);
assert.match(downtimeCollectingView.html, /data-action="lockBlock"/);

const downtimeLockedView = views.find(
  (view) => view.id === "downtime-workspace-locked",
);
assert.ok(downtimeLockedView, "harness includes locked GM downtime state");
assert.match(downtimeLockedView.html, /2 \/ 2 submitted/);
const lockedPlanButton = downtimeLockedView.html.match(
  /<button\b[^>]*data-action="planBlock"[^>]*>/,
)?.[0];
assert.ok(lockedPlanButton, "locked state renders the preview action");
assert.doesNotMatch(lockedPlanButton, /\bdisabled\b/);

const downtimePreviewView = views.find(
  (view) => view.id === "downtime-workspace-preview",
);
assert.ok(downtimePreviewView, "harness includes immutable GM preview");
assert.match(downtimePreviewView.html, /Immutable write plan/);
assert.match(downtimePreviewView.html, /GM Preview/);
assert.match(downtimePreviewView.html, /never rerolls/);
assert.match(downtimePreviewView.html, /data-action="applyBlock"/);
assert.match(downtimePreviewView.html, /margin \+5/);

const downtimeRecoveryView = views.find(
  (view) => view.id === "downtime-workspace-recovery",
);
assert.ok(downtimeRecoveryView, "harness includes downtime recovery state");
assert.match(downtimeRecoveryView.html, /Recovery checkpoint available/);
assert.match(downtimeRecoveryView.html, /external inventory drift/);
assert.match(downtimeRecoveryView.html, /data-action="recoverBlock"/);

const downtimeApplyingView = views.find(
  (view) => view.id === "downtime-workspace-applying",
);
assert.ok(downtimeApplyingView, "harness includes applying GM downtime state");
assert.match(downtimeApplyingView.html, /aria-busy="true"/);
assert.match(downtimeApplyingView.html, /Applying the saved operation plan/);
for (const action of ["applyBlock", "cancelBlock"]) {
  const button = downtimeApplyingView.html.match(
    new RegExp(`<button\\b[^>]*data-action="${action}"[^>]*>`),
  )?.[0];
  assert.ok(button, `applying state renders ${action}`);
  assert.match(button, /\bdisabled\b/);
}

const downtimeHistoryView = views.find(
  (view) => view.id === "downtime-workspace-history-completed",
);
assert.ok(downtimeHistoryView, "harness includes completed GM history");
assert.match(downtimeHistoryView.html, /Downtime History/);
assert.match(downtimeHistoryView.html, /1 receipts/);
assert.match(downtimeHistoryView.html, /2 character receipts applied/);
assert.match(downtimeHistoryView.html, /Completed/);

const downtimeAvailableView = views.find(
  (view) => view.id === "downtime-activities-available",
);
assert.ok(
  downtimeAvailableView,
  "harness includes available player downtime activities",
);
assert.match(downtimeAvailableView.html, /Time budget/);
assert.match(downtimeAvailableView.html, /Local Heat/);
assert.match(downtimeAvailableView.html, /Distracted pilgrim/);
assert.match(downtimeAvailableView.html, /No eligible finite merchant stock/);
assert.match(downtimeAvailableView.html, /data-action="submitQueue"/);
assert.match(downtimeAvailableView.html, /name="targetIds" multiple/);
assert.match(downtimeAvailableView.html, /Ctrl or Cmd/);
assert.match(downtimeAvailableView.html, /name="stakeGp" min="0\.01"/);

const downtimePendingView = views.find(
  (view) => view.id === "downtime-activities-pending",
);
assert.ok(downtimePendingView, "harness includes pending player downtime");
assert.match(downtimePendingView.html, /GM reviewing preview/);
assert.match(downtimePendingView.html, /Your queue is submitted/);

const downtimePlayerLockedView = views.find(
  (view) => view.id === "downtime-activities-locked",
);
assert.ok(
  downtimePlayerLockedView,
  "harness includes locked player downtime state",
);
assert.match(downtimePlayerLockedView.html, /Submissions locked/);
assert.match(downtimePlayerLockedView.html, /Your queue is submitted/);

const downtimePlayerApplyingView = views.find(
  (view) => view.id === "downtime-activities-applying",
);
assert.ok(
  downtimePlayerApplyingView,
  "harness includes applying player downtime state",
);
assert.match(downtimePlayerApplyingView.html, /aria-busy="true"/);
assert.match(downtimePlayerApplyingView.html, /Resolving/);

const downtimeResolvedView = views.find(
  (view) => view.id === "downtime-activities-resolved",
);
assert.ok(downtimeResolvedView, "harness includes resolved player downtime");
assert.match(downtimeResolvedView.html, /Latest Results/);
assert.match(downtimeResolvedView.html, /Spent 5 sp and added 20 arrows/);
assert.match(
  downtimeResolvedView.html,
  /Quartermaster upkeep were not advanced/,
);
assert.match(downtimeResolvedView.html, /No active downtime block/);
assert.doesNotMatch(
  downtimeResolvedView.html,
  /Character downtime summary|Your Queue/,
  "a completed history receipt is not presented as a still-active block",
);

const downtimeNoGmView = views.find(
  (view) => view.id === "downtime-activities-no-gm",
);
assert.ok(downtimeNoGmView, "harness includes no-GM player downtime state");
assert.match(downtimeNoGmView.html, /No full GM is online/);
assert.match(downtimeNoGmView.html, /Latest Results/);
assert.match(downtimeNoGmView.html, /Spent 5 sp and added 20 arrows/);
assert.doesNotMatch(downtimeNoGmView.html, /Character downtime summary/);

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
assert.match(injuryView.html, /active GM securely rolls and applies/i);
assert.match(injuryView.html, /data-action="requestTreatment"/);
assert.match(injuryView.html, /Shattered Knee/);
assert.match(injuryView.html, /12 Eleasis, 1492 DR/);

const injuryHudView = views.find((view) => view.id === "critical-injury-hud");
assert.ok(injuryHudView, "harness includes the player injury body HUD");
assert.match(injuryHudView.html, /class="ci-hud-shell/);
assert.match(injuryHudView.html, /ci-hud-region--left-leg is-pinned/);
assert.match(injuryHudView.html, /Left leg: 2 active injuries/);
assert.match(injuryHudView.html, /data-action="pinRegion"/);
assert.match(injuryHudView.html, /data-action="closeRegion"/);
assert.match(injuryHudView.html, /data-action="openInjuries"/);
assert.match(injuryHudView.html, /data-action="requestTreatment"/);
assert.match(injuryHudView.html, /Treat with Healer's Kit/);
assert.match(injuryHudView.html, /Lost Limb/);
assert.match(injuryHudView.html, /Permanent/);
assert.match(
  documentHtml,
  /class="ui-harness__overlay-stage"[\s\S]*?data-harness-window="critical-injury-hud"/,
  "the HUD renders as a frameless overlay rather than a large application window",
);

const suppliesOfflineView = views.find(
  (view) => view.id === "resource-overview-offline",
);
assert.ok(suppliesOfflineView, "harness includes Party Supplies offline state");
assert.match(suppliesOfflineView.html, /No GM is online right now/);

const routineManagerView = views.find((view) => view.id === "resource-manager");
assert.ok(
  routineManagerView,
  "harness includes the routine Quartermaster view",
);
const routineSetupTag = routineManagerView.html.match(
  /<details\b[^>]*class="rm-setup"[^>]*>/,
)?.[0];
assert.ok(routineSetupTag, "routine Quartermaster renders Setup & rules");
assert.doesNotMatch(
  routineSetupTag,
  /\sopen(?:\s|=|>)/,
  "routine Quartermaster starts with setup collapsed",
);
const routineHeader = routineManagerView.html.match(
  /<header\b[^>]*class="rm-head"[^>]*>[\s\S]*?<\/header>/,
)?.[0];
assert.ok(routineHeader, "routine Quartermaster renders its daily header");
assert.match(routineHeader, /data-action="advanceDay"/);
assert.match(routineHeader, /data-action="forageDrive"/);
assert.match(routineHeader, /data-action="refresh"/);
assert.doesNotMatch(
  routineHeader,
  /data-action="resetConfig"/,
  "Reset is no longer a daily header action",
);
const setupIndex = routineManagerView.html.indexOf("Setup &amp; rules");
for (const routineLabel of [
  "Where is the party?",
  "Supply outlook",
  "Last upkeep",
  "Recent runs",
]) {
  const routineIndex = routineManagerView.html.indexOf(routineLabel);
  assert.ok(routineIndex >= 0, `${routineLabel} remains in the routine view`);
  assert.ok(
    routineIndex < setupIndex,
    `${routineLabel} renders outside the setup disclosure`,
  );
}
assert.match(
  routineManagerView.html,
  /No resource runs have been recorded yet\./,
  "a migrated or fresh world shows an honest empty-history state",
);
assert.ok(
  routineManagerView.html.indexOf("Last upkeep") <
    routineManagerView.html.indexOf("Recent runs"),
  "the latest upkeep report remains ahead of the bounded history",
);
for (const setupLabel of [
  "Environment setup",
  "Rules",
  "Tracked resources",
  "Party supplies",
  "Reset to defaults",
]) {
  assert.ok(
    routineManagerView.html.indexOf(setupLabel, setupIndex + 1) > setupIndex,
    `${setupLabel} renders inside Setup & rules`,
  );
}

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

const recentRunsView = views.find(
  (view) => view.id === "resource-manager-recent-runs",
);
assert.ok(recentRunsView, "harness includes detailed Quartermaster receipts");
assert.match(
  recentRunsView.html,
  /<details\b[^>]*class="rm-runs__disclosure"[^>]*\sopen(?:\s|=|>)/,
  "recent-runs fixture opens the bounded history for responsive auditing",
);
assert.equal(
  countMatches(recentRunsView.html, /<details\b[^>]*class="rm-run\s/g),
  4,
  "history fixture includes complete, partial, interrupted, and write-error receipts",
);
for (const expectedText of [
  "Interrupted automatic upkeep",
  "Forage Drive",
  "Advance Day",
  "Complete",
  "Partial",
  "Interrupted",
  "Inventory outcome unknown",
  "Participant and inventory",
  "Inventory to review",
  "Food and water",
  "Aric the Ranger",
  "Exhaustion suggestions",
  "Torch stack update needs review",
  "run-interrupted-calendar-0042",
]) {
  assert.match(
    recentRunsView.html,
    new RegExp(expectedText),
    `recent receipts render ${expectedText}`,
  );
}
const interruptedSummary = recentRunsView.html.match(
  /<details class="rm-run rm-run--unknown"[^>]*>[\s\S]*?<summary>([\s\S]*?)<\/summary>/,
)?.[1];
assert.ok(interruptedSummary, "interrupted receipt has a collapsed summary");
for (const summaryText of [
  "Limited",
  "Day 42",
  "2 affected actors",
  "run-interrupted-calendar-0042",
]) {
  assert.match(
    interruptedSummary,
    new RegExp(summaryText),
    `collapsed receipt identifies ${summaryText}`,
  );
}
assert.match(
  recentRunsView.html,
  /class="[^"\n]*is-error[^"\n]*"[^>]*>[\s\S]*?Torch stack update needs review/,
  "party write errors are visibly warned even without a shortage",
);
const historyMarkup = recentRunsView.html.match(
  /<section class="rm-section rm-runs"[\s\S]*?<details class="rm-setup"/,
)?.[0];
assert.ok(historyMarkup, "history renders immediately before Setup & rules");
assert.doesNotMatch(
  historyMarkup,
  /data-action=/,
  "run history is inspection-only with no retry, replay, rollback, or clear action",
);

const customEnvironmentView = views.find(
  (view) => view.id === "resource-manager-custom-environment",
);
assert.ok(
  customEnvironmentView,
  "harness includes the Quartermaster custom-region editor",
);
assert.match(
  customEnvironmentView.html,
  /<details\b[^>]*class="rm-setup"[^>]*\sopen(?:\s|=|>)/,
  "custom-region fixture keeps setup expanded",
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
    setupExpanded: true,
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
  const conflictSetupIndex = html.indexOf("Setup &amp; rules");
  assert.ok(
    html.indexOf("Resource rules need attention") < conflictSetupIndex,
    "authoritative conflict warning stays outside Setup & rules",
  );
  assert.match(
    html,
    /<details\b[^>]*class="rm-setup"[^>]*\sopen(?:\s|=|>)/,
    "blocking conflicts render setup expanded",
  );
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
