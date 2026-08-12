import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import Handlebars from "handlebars";

const read = (file) => readFileSync(file, "utf8");
const merchantTemplate = read("templates/merchant-workspace.hbs");
const merchantStyle = read("styles/merchant-workspace.css");
const merchantScript = read("scripts/merchant-workspace.js");
const resourceTemplate = read("templates/resource-manager.hbs");
const resourceStyle = read("styles/resource-manager.css");
const resourceScript = read("scripts/resource-manager.js");
const reputationTemplate = read("templates/reputation-workspace.hbs");
const reputationStyle = read("styles/reputation-workspace.css");
const reputationScript = read("scripts/reputation-workspace.js");
const lootStudioTemplate = read("templates/loot-studio.hbs");
const lootStudioScript = read("scripts/loot/loot-app-base.js");
const downtimeTemplate = read("templates/downtime-workspace.hbs");
const settingsTemplate = read("templates/settings.hbs");
const settingsAppScript = read("scripts/settings-app.js");

for (const [name, template] of [
  ["merchant", merchantTemplate],
  ["quartermaster", resourceTemplate],
  ["reputation", reputationTemplate],
  ["loot studio", lootStudioTemplate],
  ["downtime", downtimeTemplate],
  ["settings", settingsTemplate],
]) {
  assert.doesNotThrow(
    () => Handlebars.precompile(template),
    `${name} workspace template must compile`,
  );
}

function actionSet(template) {
  return new Set(
    [...template.matchAll(/data-action="([^"]+)"/g)].map((match) => match[1]),
  );
}

function assertActions(template, expected, label) {
  const actions = actionSet(template);
  for (const action of expected) {
    assert.ok(actions.has(action), `${label} preserves data-action=${action}`);
  }
}

function assertOrdered(source, needles, label) {
  let previous = -1;
  for (const needle of needles) {
    const index = source.indexOf(needle);
    assert.ok(index >= 0, `${label} includes ${needle}`);
    assert.ok(index > previous, `${label} keeps ${needle} in intended order`);
    previous = index;
  }
}

/* Merchant: same bindings, clearer master/detail sections. */
assertOrdered(
  merchantTemplate,
  [
    'id="mw-section-basics"',
    'id="mw-section-pricing"',
    'id="mw-section-stock"',
    'id="mw-section-access"',
    'id="mw-section-sessions"',
  ],
  "merchant sections",
);
assertActions(
  merchantTemplate,
  [
    "newMerchant",
    "selectMerchant",
    "save",
    "deleteMerchant",
    "duplicateMerchant",
    "addFromPack",
    "marketTier",
    "generateStock",
    "regenerateStock",
    "copyStockToBuyFilter",
    "clearInventory",
    "restock",
    "pickArt",
    "previewSession",
    "openSession",
    "closeSession",
    "closeAllSessions",
    "reopenSessions",
    "invRemove",
    "openInventoryItem",
    "recheckTransaction",
    "selectSection",
  ],
  "merchant workspace",
);
for (const field of [
  "name",
  "art",
  "description",
  "defaultMarkup",
  "sellRatio",
  "bargainDC",
  "allowedUserIds",
  "selfServiceMode",
  "poolLootTypes",
  "poolRarities",
  "buyFilterLootTypes",
  "buyFilterRarities",
]) {
  assert.match(
    merchantTemplate,
    new RegExp(`name="${field}"`),
    `merchant preserves ${field} form binding`,
  );
}
assert.match(merchantTemplate, /data-save-status/);
assert.match(merchantTemplate, /Workspace guide:/);
assert.match(merchantTemplate, /Live shoppers use the canonical saved stock/);
assert.match(merchantTemplate, /Open Session is unavailable:/);
assert.match(
  merchantTemplate,
  /unless canManageMerchants[\s\S]*?merchantAuthorityReason/,
  "secondary full GMs see an explicit read-only Merchant notice",
);
assert.match(merchantTemplate, /Transactions needing review/);
assert.match(merchantTemplate, /Actor wallet, saved/);
assert.match(merchantTemplate, /Merchant stock, saved/);
assert.match(merchantTemplate, /data-action="recheckTransaction"/);
assert.match(
  merchantScript,
  /recheckDurableMerchantTransaction[\s\S]*?deliverDurableMerchantTerminalResult/,
  "safe review completion is delivered through the durable result path",
);
assert.match(
  merchantTemplate,
  /merchantReopenInterrupted[\s\S]*?Resume restoring/,
  "an interrupted global reopen remains resumable instead of offering Close All",
);
assert.match(
  merchantScript,
  /!current\.closed && current\.suspendedSessions\.length === 0/,
  "open access with saved sessions continues the restore path",
);
assert.match(
  merchantScript,
  /requireMerchantWriteAuthority[\s\S]*?active full GM window/,
  "every Merchant workspace mutation is authority-gated",
);
assert.match(
  merchantScript,
  /MERCHANT_WRITE_ACTIONS[\s\S]*?control\.disabled = true/,
  "secondary full GMs receive disabled Merchant mutation controls",
);
assert.match(
  merchantTemplate,
  /<input(?=[^>]*name="poolBudgetGp")(?=[^>]*aria-label="Stock value budget in gold pieces")[^>]*>/,
  "blank stock budgets retain an explicit accessible name",
);
assert.doesNotMatch(
  merchantTemplate,
  /<span(?=[^>]*mw-inv__search-count)(?=[^>]*aria-label=)[^>]*>/,
  "inventory search status does not use aria-label on a generic span",
);
assert.match(merchantStyle, /container-name:\s*merchant-workspace/);
assert.match(merchantStyle, /@container merchant-workspace/);
assert.doesNotMatch(merchantStyle, /@media\s*\(max-width/);
assert.match(
  merchantScript,
  /if \(current\.closed\)[\s\S]*?await pushCloseAllMerchantSessions\(\)/,
  "an already-closed global gate still closes stale merchant windows",
);
assert.doesNotMatch(
  merchantScript,
  /idxKeydownBound|\.key\s*!==\s*["']Enter["'][\s\S]*?_onGenerateStock/,
  "Merchant stock generation requires an explicit button action",
);

/* Quartermaster: routine, receipts, and setup remain distinct. */
assertOrdered(
  resourceTemplate,
  ['id="rm-today"', 'id="rm-runs-heading"', 'id="rm-setup"'],
  "Quartermaster sections",
);
assertActions(
  resourceTemplate,
  [
    "advanceDay",
    "forageDrive",
    "clearInterruptedRun",
    "addResource",
    "removeResource",
    "addTag",
    "addTagByUuid",
    "removeTag",
    "addRosterMember",
    "removeRosterMember",
    "copyEnvironment",
    "resetConfig",
    "refresh",
    "selectSection",
  ],
  "Quartermaster",
);
assert.match(resourceTemplate, /Recommended next action/);
assert.match(resourceTemplate, /Workspace guide:/);
assert.match(resourceTemplate, /First setup/);
assert.match(resourceTemplate, /Campaign readiness/);
assert.match(resourceTemplate, /rm-resource-write-reason/);
assert.match(resourceTemplate, /Quartermaster will not replay the run/);
assert.match(
  resourceTemplate,
  /data-action="clearInterruptedRun"[\s\S]*?unless isAuthoritative[\s\S]*?disabled aria-disabled="true"/,
  "Quartermaster disables interrupted-run recovery in a follower tab",
);
assert.match(
  resourceTemplate,
  /rm-setup__content" \{\{#unless isAuthoritative\}\}aria-disabled="true"/,
  "Quartermaster marks setup read-only outside the campaign-leading tab",
);
assert.match(
  resourceScript,
  /CAMPAIGN_TAB_LEADERSHIP_HOOK/,
  "Quartermaster refreshes when same-browser campaign leadership changes",
);
assert.match(
  resourceScript,
  /data-drop-resource[\s\S]*?if \(!context\?\.isAuthoritative\)[\s\S]*?aria-disabled/,
  "Quartermaster does not bind drop mutations in a follower tab",
);
assert.doesNotMatch(resourceTemplate, /data-action="(?:retry|replay|rollback)/);
assert.match(resourceTemplate, /Advanced receipt details/);
assert.equal(
  (resourceTemplate.match(/\{\{runId\}\}/g) ?? []).length,
  1,
  "technical receipt IDs appear only inside Advanced details",
);
assert.ok(
  resourceTemplate.indexOf("Advanced receipt details") <
    resourceTemplate.indexOf("{{runId}}"),
  "receipt IDs are confined to the Advanced disclosure",
);
assert.match(resourceStyle, /container-name:\s*quartermaster/);
assert.match(resourceStyle, /@container quartermaster/);
assert.doesNotMatch(resourceStyle, /@media\s*\(max-width/);
assert.doesNotMatch(
  resourceScript,
  /idxKeydownBound|\.key\s*!==\s*["']Enter["'][\s\S]*?_onAdvanceDay/,
  "Quartermaster consumption requires an explicit button action",
);

/* Reputation: one visible value+reason flow, same authoritative write. */
assertOrdered(
  reputationTemplate,
  [
    'id="rw-section-overview"',
    'id="rw-section-visibility"',
    'id="rw-section-history"',
  ],
  "reputation sections",
);
assertActions(
  reputationTemplate,
  [
    "newFaction",
    "selectFaction",
    "changeStanding",
    "logNote",
    "pickImage",
    "addCharacterNote",
    "removeCharacterNote",
    "selectSection",
    "save",
    "deleteFaction",
  ],
  "reputation workspace",
);
assert.doesNotMatch(
  reputationTemplate,
  /data-action="(?:raiseStanding|lowerStanding|setStanding)"/,
  "legacy scattered standing controls are removed from the UI",
);
assert.match(
  reputationTemplate,
  /<input(?=[^>]*data-role="standing-change-value")(?=[^>]*required)(?=[^>]*aria-required="true")[^>]*>/,
);
assert.match(
  reputationTemplate,
  /<textarea(?=[^>]*data-role="standing-change-reason")(?=[^>]*required)(?=[^>]*aria-required="true")(?=[^>]*aria-label="Reason for standing change")[^>]*>/,
);
assert.match(reputationTemplate, /Reason <small>\(required\)<\/small>/);
assert.equal(
  (reputationTemplate.match(/data-action="changeStanding"/g) ?? []).length,
  1,
  "one visible standing-change submission",
);
assert.doesNotMatch(reputationTemplate, /Legacy (?:lower|raise|set)/);
assert.match(reputationTemplate, /Workspace guide:/);
assert.match(lootStudioTemplate, /infinity-workspace-context/);
assert.match(lootStudioTemplate, /mode is active/);
assert.match(lootStudioTemplate, /lootStudio\.loadingItems/);
assert.match(lootStudioTemplate, /lootStudio\.generationBlocked/);
assert.match(lootStudioTemplate, /No loot has been generated/);
assert.match(
  lootStudioScript,
  /generationBlocked: generation\.disabled && !generation\.loading/,
);
assert.match(
  downtimeTemplate,
  /dt-next-action infinity-workspace-context/,
  "Downtime keeps its lifecycle next action as the shared workspace guide",
);
assert.match(settingsTemplate, /Settings state:/);
assert.match(settingsTemplate, /hasPartialSaveError/);
assert.match(
  settingsAppScript,
  /hasPartialSaveError: this\._dirty && this\._statusTone === "danger"/,
);

const changeStart = reputationScript.indexOf("static async _onChangeStanding");
const changeEnd = reputationScript.indexOf("/** Log a note", changeStart);
assert.ok(changeStart >= 0 && changeEnd > changeStart);
const changeMethod = reputationScript.slice(changeStart, changeEnd);
assert.ok(
  changeMethod.indexOf("if (!reason)") <
    changeMethod.indexOf("await setStanding"),
  "reason is required before the authoritative standing write",
);
assert.match(changeMethod, /await setStanding\(this\._selectedId, value/);
assert.doesNotMatch(changeMethod, /adjustStanding\(/);
assert.match(reputationStyle, /container-name:\s*reputation-workspace/);
assert.match(reputationStyle, /@container reputation-workspace/);
assert.doesNotMatch(reputationStyle, /@media\s*\(max-width/);

console.log("GM workspace UI redesign validation passed");
