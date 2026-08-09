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
  87,
  "harness covers all UI windows, overlays, merchant tabs, resource states, and downtime states",
);

for (const view of views) {
  if (view.requiresActions !== false) {
    assert.ok(
      view.html.includes("data-action="),
      `${view.id}: renders actions`,
    );
  }
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
  "home-player",
  "settings-gm",
  "settings-player",
  "settings-dirty",
  "settings-saved",
  "settings-save-error",
  "search-picker",
  "shared-dialog",
  "shared-dialog-busy",
  "shared-dialog-error",
  "shared-dialog-interrupted",
  "chat-card",
  "chat-card-pending",
  "chat-card-interrupted",
  "chat-card-error",
  "per-encounter",
  "per-encounter-loading",
  "per-encounter-unavailable",
  "hoard",
  "hoard-loading",
  "hoard-unavailable",
  "per-creature",
  "per-creature-loading",
  "per-creature-unavailable",
  "merchant-workspace",
  "merchant-workspace-closed",
  "merchant-workspace-save-error",
  "merchant-session-buy",
  "merchant-session-sell",
  "merchant-session-pending",
  "merchant-session-completed",
  "merchant-session-uncertain",
  "merchant-session-offline",
  "merchant-session-no-actor",
  "shop-picker",
  "shop-picker-empty",
  "shop-picker-closed",
  "shop-picker-loading",
  "shop-picker-offline",
  "shop-picker-error",
  "shop-picker-choose-actor",
  "resource-manager",
  "resource-manager-locked",
  "resource-manager-recent-runs",
  "resource-manager-custom-environment",
  "resource-overview",
  "resource-overview-offline",
  "resource-overview-loading",
  "resource-overview-error",
  "resource-overview-empty",
  "resource-overview-disabled",
  "downtime-workspace-empty",
  "downtime-workspace-load-error",
  "downtime-workspace-collecting",
  "downtime-workspace-locked",
  "downtime-workspace-preview",
  "downtime-workspace-recovery",
  "downtime-workspace-applying",
  "downtime-workspace-history-completed",
  "downtime-activities-available",
  "downtime-activities-camp",
  "downtime-activities-pending",
  "downtime-activities-locked",
  "downtime-activities-applying",
  "downtime-activities-resolved",
  "downtime-activities-no-gm",
  "forage-prompt",
  "forage-waiting",
  "forage-timeout",
  "forage-success",
  "forage-offline",
  "critical-injury",
  "critical-injury-offline",
  "critical-injury-treating",
  "critical-injury-treatment-outcome",
  "critical-injury-uncertain",
  "critical-injury-character-unavailable",
  "critical-injury-hud",
  "critical-injury-hud-offline",
  "critical-injury-hud-uncertain",
  "reputation-workspace",
  "reputation-view",
  "reputation-view-empty",
  "reputation-view-loading",
  "reputation-view-offline",
  "reputation-view-error",
]) {
  assert.ok(
    documentHtml.includes(`data-harness-window="${expectedId}"`),
    `full harness includes ${expectedId}`,
  );
}

const dialogView = views.find((view) => view.id === "shared-dialog");
assert.match(dialogView.html, /autofocus>Cancel/);
assert.match(dialogView.html, /data-action="confirm"/);
assert.match(
  views.find((view) => view.id === "shared-dialog-busy").html,
  /aria-busy="true"[\s\S]*Do not submit the change again/i,
);
assert.match(
  views.find((view) => view.id === "shared-dialog-error").html,
  /role="alert"[\s\S]*data-action="retry"/,
);
assert.match(
  views.find((view) => view.id === "shared-dialog-interrupted").html,
  /Do not repeat the action[\s\S]*Check saved record/i,
);
const chatCardView = views.find((view) => view.id === "chat-card");
for (const section of ["Outcome", "Audience", "Details", "Next action"]) {
  assert.match(chatCardView.html, new RegExp(`>${section}<`));
}
assert.match(
  views.find((view) => view.id === "chat-card-pending").html,
  /waiting for GM confirmation[\s\S]*do not submit the trade again/i,
);
assert.match(
  views.find((view) => view.id === "chat-card-interrupted").html,
  /outcome is uncertain[\s\S]*Do not repeat it/i,
);
assert.match(
  views.find((view) => view.id === "chat-card-error").html,
  /Nothing changed[\s\S]*retry the same request once/i,
);

const dirtySettingsView = views.find((view) => view.id === "settings-dirty");
assert.match(dirtySettingsView.html, /Changes are ready to save/);
assert.doesNotMatch(
  dirtySettingsView.html.match(/<button\b[^>]*data-action="save"[^>]*>/)?.[0] ??
    "",
  /\bdisabled\b/,
);
assert.match(
  views.find((view) => view.id === "settings-saved").html,
  /2 changes saved/,
);
assert.match(
  views.find((view) => view.id === "settings-save-error").html,
  /Some changes were not saved[\s\S]*try again/i,
);

const encounterView = views.find((view) => view.id === "per-encounter");
assert.ok(encounterView, "harness includes Per-Encounter Loot");
assert.match(encounterView.html, /Roll Chances/);
assert.match(encounterView.html, /First item of a fresh Generate/);
assert.match(encounterView.html, /data-chance-group="category"/);
assert.match(encounterView.html, /mixed bundles stop at one spell scroll/i);

for (const id of [
  "per-encounter-loading",
  "hoard-loading",
  "per-creature-loading",
]) {
  const html = views.find((view) => view.id === id)?.html ?? "";
  assert.match(html, /Loading items/i, `${id}: exposes item-library loading`);
  assert.match(
    html.match(/<button\b[^>]*data-action="generate"[^>]*>/)?.[0] ?? "",
    /\bdisabled\b[\s\S]*aria-busy="true"|aria-busy="true"[\s\S]*\bdisabled\b/,
    `${id}: disables and marks Generate busy while items load`,
  );
}

for (const id of [
  "per-encounter-unavailable",
  "hoard-unavailable",
  "per-creature-unavailable",
]) {
  const html = views.find((view) => view.id === id)?.html ?? "";
  assert.match(
    html,
    /No items are available for the current filters/i,
    `${id}: explains why generation is unavailable`,
  );
  assert.match(
    html.match(/<button\b[^>]*data-action="generate"[^>]*>/)?.[0] ?? "",
    /\bdisabled\b[\s\S]*aria-disabled="true"|aria-disabled="true"[\s\S]*\bdisabled\b/,
    `${id}: disables Generate when no items are available`,
  );
}

const dashboardView = views.find((view) => view.id === "dashboard");
assert.ok(dashboardView, "harness includes the GM dashboard");
assert.match(dashboardView.html, /Downtime Workspace/);

const merchantWorkspaceView = views.find(
  (view) => view.id === "merchant-workspace",
);
assert.ok(
  merchantWorkspaceView,
  "harness includes the open merchant workspace",
);
assert.match(merchantWorkspaceView.html, /Global access open/);
assert.match(merchantWorkspaceView.html, /data-action="closeAllSessions"/);

const closedMerchantWorkspaceView = views.find(
  (view) => view.id === "merchant-workspace-closed",
);
assert.ok(
  closedMerchantWorkspaceView,
  "harness includes the globally closed merchant workspace",
);
assert.match(closedMerchantWorkspaceView.html, /All shops closed/);
assert.match(closedMerchantWorkspaceView.html, /data-action="reopenSessions"/);
assert.match(closedMerchantWorkspaceView.html, /2 saved sessions/);

const merchantWorkspaceSaveErrorView = views.find(
  (view) => view.id === "merchant-workspace-save-error",
);
assert.ok(
  merchantWorkspaceSaveErrorView,
  "harness includes the Merchant Workspace retryable save error",
);
assert.match(
  merchantWorkspaceSaveErrorView.html,
  /role="status"[\s\S]*Save failed[\s\S]*retry with Save now/i,
);
assert.match(
  merchantWorkspaceSaveErrorView.html,
  /data-action="save"[\s\S]*Save now/i,
);

const closedShopPickerView = views.find(
  (view) => view.id === "shop-picker-closed",
);
assert.ok(
  closedShopPickerView,
  "harness includes the globally closed Shops door",
);
assert.match(closedShopPickerView.html, /GM has paused merchant access/);

const merchantSellView = views.find(
  (view) => view.id === "merchant-session-sell",
);
assert.ok(merchantSellView, "harness includes the merchant sell tab");
assert.match(merchantSellView.html, /Stolen Signet Ring/);
assert.match(merchantSellView.html, /require fencing during downtime/);
assert.match(merchantSellView.html, /Fencing only/);

const merchantCompletedView = views.find(
  (view) => view.id === "merchant-session-completed",
);
assert.match(merchantCompletedView.html, /Trade confirmed/);
assert.match(
  merchantCompletedView.html,
  /wallet, inventory, and the shop stock/i,
);

const resourceLoadingView = views.find(
  (view) => view.id === "resource-overview-loading",
);
assert.match(resourceLoadingView.html, /Loading the party's supplies/);
assert.match(
  resourceLoadingView.html.match(
    /<button\b[^>]*data-action="refresh"[^>]*>/,
  )?.[0] ?? "",
  /\bdisabled\b/,
);
assert.match(
  views.find((view) => view.id === "resource-overview-error").html,
  /snapshot did not arrive[\s\S]*Try again/i,
);
assert.match(
  views.find((view) => view.id === "resource-overview-empty").html,
  /No supply snapshot is available yet/i,
);
assert.match(
  views.find((view) => view.id === "resource-overview-disabled").html,
  /has not shared the Party Supplies view/i,
);

const criticalInjuryView = views.find((view) => view.id === "critical-injury");
assert.match(criticalInjuryView.html, /Active character/);
assert.match(criticalInjuryView.html, /data-role="critical-injury-actor"/);
assert.match(
  views.find((view) => view.id === "critical-injury-character-unavailable")
    .html,
  /no longer available to you[\s\S]*Choose a controlled character/i,
);

assert.match(
  views.find((view) => view.id === "reputation-view-loading").html,
  /Loading reputations/,
);
assert.match(
  views.find((view) => view.id === "reputation-view-offline").html,
  /Reputation is offline[\s\S]*Try again/i,
);
assert.match(
  views.find((view) => view.id === "reputation-view-error").html,
  /standings did not arrive[\s\S]*Try again/i,
);

const downtimeEmptyView = views.find(
  (view) => view.id === "downtime-workspace-empty",
);
assert.ok(downtimeEmptyView, "harness includes empty GM downtime state");
assert.match(downtimeEmptyView.html, /Open a downtime block/);
assert.match(downtimeEmptyView.html, /data-action="createBlock"/);
assert.match(downtimeEmptyView.html, /8 productive hours per day/);
assert.match(downtimeEmptyView.html, /Settlement \(optional\)/);
assert.match(downtimeEmptyView.html, /No settlement · camp, wilderness/);
assert.match(downtimeEmptyView.html, /name="locationName"/);

const downtimeLoadErrorView = views.find(
  (view) => view.id === "downtime-workspace-load-error",
);
assert.ok(
  downtimeLoadErrorView,
  "harness includes fail-closed downtime load errors",
);
assert.match(downtimeLoadErrorView.html, /Downtime data could not be verified/);
assert.equal(
  downtimeLoadErrorView.html.match(/Downtime data could not be verified/g)
    ?.length,
  1,
  "the load failure is exposed through one live-region announcement",
);
assert.doesNotMatch(downtimeLoadErrorView.html, /data-form="new-block"/);
assert.match(downtimeLoadErrorView.html, /data-view="current"[^>]*disabled/);

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

const downtimeCampView = views.find(
  (view) => view.id === "downtime-activities-camp",
);
assert.ok(downtimeCampView, "harness includes camp or wilderness downtime");
assert.match(downtimeCampView.html, /Pinewood camp/);
assert.match(downtimeCampView.html, /Outside a settlement/);
assert.match(downtimeCampView.html, /Requires a selected settlement/);
assert.doesNotMatch(downtimeCampView.html, /Local Heat/);

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
assert.match(
  suppliesView.html,
  /ro-run-status--needs-review">Needs review<\/span>/,
  "the player badge describes the supply outcome instead of the run mechanics",
);
const suppliesReviewRow = suppliesView.html.match(
  /<li class="is-review">[\s\S]*?Brother Calder[\s\S]*?<\/li>/,
)?.[0];
assert.ok(suppliesReviewRow, "player supplies renders the review-only fixture");
assert.match(suppliesReviewRow, /Needs review/);
assert.doesNotMatch(
  suppliesReviewRow,
  /Supplied/,
  "a player row never presents supplied beside an inventory warning",
);

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
assert.match(suppliesOfflineView.html, /No full GM is online/);

const routineManagerView = views.find((view) => view.id === "resource-manager");
assert.ok(
  routineManagerView,
  "harness includes the routine Quartermaster view",
);
assert.match(routineManagerView.html, /Last upkeep - Needs review/);
assert.match(routineManagerView.html, /Environment: Limited/);
const managerReviewRow = routineManagerView.html.match(
  /<li class="is-review">[\s\S]*?Brother Calder[\s\S]*?<\/li>/,
)?.[0];
assert.ok(managerReviewRow, "Quartermaster renders the review-only fixture");
assert.match(managerReviewRow, /needs review/);
assert.doesNotMatch(
  managerReviewRow,
  /supplied/,
  "a GM row never presents supplied beside an inventory warning",
);
const routineSetupTag = routineManagerView.html.match(
  /<details\b[^>]*class="[^"]*\brm-setup\b[^"]*"[^>]*>/,
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
assert.match(routineHeader, /data-action="refresh"/);
assert.doesNotMatch(
  routineHeader,
  /data-action="resetConfig"/,
  "Reset is no longer a daily header action",
);
const routineToday = routineManagerView.html.match(
  /<section\b[^>]*id="rm-today"[^>]*>[\s\S]*?<\/section>/,
)?.[0];
assert.ok(routineToday, "routine Quartermaster renders its Today workspace");
assert.match(routineToday, /data-action="advanceDay"/);
assert.match(routineToday, /data-action="forageDrive"/);
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
for (const summaryText of ["Limited", "Day 42", "2 affected actors"]) {
  assert.match(
    interruptedSummary,
    new RegExp(summaryText),
    `collapsed receipt identifies ${summaryText}`,
  );
}
assert.doesNotMatch(
  interruptedSummary,
  /run-interrupted-calendar-0042/,
  "technical receipt IDs stay out of the ordinary collapsed summary",
);
assert.match(
  recentRunsView.html,
  /Advanced receipt details[\s\S]*?run-interrupted-calendar-0042/,
  "technical receipt IDs remain available inside Advanced details",
);
assert.match(
  recentRunsView.html,
  /class="[^"\n]*is-error[^"\n]*"[^>]*>[\s\S]*?Torch stack update needs review/,
  "party write errors are visibly warned even without a shortage",
);
const historyMarkup = recentRunsView.html.match(
  /<section class="[^"]*\brm-runs\b[^"]*"[\s\S]*?<details[^>]*class="[^"]*\brm-setup\b/,
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
  /<details\b[^>]*class="[^"]*\brm-setup\b[^"]*"[^>]*\sopen(?:\s|=|>)/,
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
    /<details\b[^>]*class="[^"]*\brm-setup\b[^"]*"[^>]*\sopen(?:\s|=|>)/,
    "blocking conflicts render setup expanded",
  );
  for (const action of ["advanceDay", "forageDrive"]) {
    const button = html.match(
      new RegExp(`<button\\b[^>]*data-action="${action}"[^>]*>`),
    )?.[0];
    assert.ok(button, `resource manager: renders ${action}`);
    assert.match(button, /\bdisabled\b/);
    assert.match(button, /aria-disabled="true"/);
    assert.match(button, /Fix blocking resource conflicts/);
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
