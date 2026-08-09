import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const source = readFileSync("scripts/module.js", "utf8");

assert.doesNotMatch(
  source,
  /\bonClick\s*:/,
  "scene-control tools should not use Foundry 13's deprecated onClick callback",
);

assert.match(
  source,
  /const onCategoryChange = \(_event, active\) => \{\s*if \(active\) openHub\(\);/s,
  "the single scene-control category should open role-aware Home",
);

assert.match(
  source,
  /controls\.push\(\{[\s\S]*?onChange: onCategoryChange,[\s\S]*?tools: \[buildTool\(launcherToolName,/,
  "V12 scene-control category should carry the launcher onChange handler",
);

assert.match(
  source,
  /controls\["infinity-dnd5e"\] = \{[\s\S]*?onChange: onCategoryChange,[\s\S]*?\[launcherToolName\]: buildTool\(launcherToolName,/,
  "V13 scene-control category should carry the launcher onChange handler",
);

assert.doesNotMatch(
  source,
  /injectSidebarLauncher|renderSidebarTab|infinity-dnd5e-sidebar-launcher/,
  "sidebar launcher injection should stay removed",
);

/* ---- One role-aware launcher + compatibility APIs ---- */

assert.match(
  source,
  /Hooks\.on\("getSceneControlButtons", \(controls\) => \{[\s\S]*?registerInfinitySceneControls\(controls\);/,
  "every role should receive the same Infinity Home scene-control category",
);

assert.match(
  source,
  /function registerInfinitySceneControls\(controls\) \{/,
  "a unified scene-control builder should exist",
);

assert.doesNotMatch(
  source,
  /registerPlayerSceneControls|registerGmSceneControls|infinity-dnd5e-dashboard|infinity-dnd5e-shops-tool/,
  "duplicate GM fallback and fragmented player scene controls should stay removed",
);

assert.match(
  source,
  /openHub: \(\) => openHub\(\)/,
  "the module API should expose role-aware Home",
);

assert.match(
  source,
  /openDashboard: \(\) => runAsFullGM\(\(\) => openHub\(\)\)/,
  "the existing openDashboard alias should remain full-GM gated",
);

assert.match(
  source,
  /openLootStudio: \(options = \{\}\) =>\s*runAsFullGM\(\(\) => LootStudioApp\.open\(options\)\)/,
  "the API should expose the unified Loot Studio",
);

for (const [apiName, mode] of [
  ["openPerEncounterLoot", "encounter"],
  ["openHoardLoot", "hoard"],
  ["openPerCreatureLoot", "creature"],
]) {
  assert.match(
    source,
    new RegExp(
      `${apiName}: \\(\\) =>\\s*runAsFullGM\\(\\(\\) => LootStudioApp\\.open\\(\\{ mode: "${mode}" \\}\\)\\)`,
    ),
    `${apiName} should route to ${mode} mode`,
  );
}

assert.match(
  source,
  /game\.keybindings\.register\(MODULE_ID, "openDashboard"[\s\S]*?openHub\(\);[\s\S]*?restricted: false/,
  "Shift+I should open Home for every role",
);

assert.match(
  source,
  /openShops: \(\) => ShopPickerApp\.open\(\)/,
  "the module API should expose openShops",
);

assert.match(
  source,
  /game\.keybindings\.register\(MODULE_ID, "openShops"/,
  "a player Shops keybinding should be registered",
);

assert.match(
  source,
  /game\.keybindings\.register\(MODULE_ID, "openPartySupplies"/,
  "a player and Assistant-GM Party Supplies keybinding should be registered",
);

assert.match(
  source,
  /openCriticalInjuries: \(\) => CriticalInjuryApp\.openForCurrentUser\(\)/,
  "the module API should expose the player Critical Injuries window",
);

assert.match(
  source,
  /\bgetPlayerSurfaceStatus,\s*\n/,
  "the module API should expose bounded player-surface readiness metadata",
);

assert.match(
  source,
  /openCriticalInjuryHud: \(\) => CriticalInjuryHudApp\.reconcile\(\)/,
  "the module API should expose compact injury HUD reconciliation",
);

assert.match(
  source,
  /game\.keybindings\.register\(MODULE_ID, "openCriticalInjuries"/,
  "a player Critical Injuries keybinding should be registered",
);

/* ---- Downtime GM workspace + player activities launchers ---- */

assert.match(
  source,
  /openDowntimeWorkspace: \(\) =>\s*runAsFullGM\(\(\) => DowntimeWorkspaceApp\.open\(\)\)/,
  "the module API should expose the full-GM Downtime Workspace",
);

assert.match(
  source,
  /openDowntimeActivities: \(options = \{\}\) =>\s*DowntimeActivitiesApp\.open\(options\)/,
  "the module API should expose the player Downtime Activities window",
);

const publicApiSource = source.slice(
  source.indexOf("function buildApi()"),
  source.indexOf("function registerBuiltinTools()"),
);
assert.doesNotMatch(
  publicApiSource,
  /\b(?:create|lock|plan|apply|cancel|recover)Downtime(?:Block|Workflow)?\s*:/i,
  "the first downtime API should expose launchers, not public mutation methods",
);
assert.doesNotMatch(
  publicApiSource,
  /\bdowntime\s*:\s*\{/i,
  "the first downtime API should not expose a nested mutable service",
);

assert.match(
  source,
  /id: "downtime-workspace"[\s\S]*?open: \(\) => DowntimeWorkspaceApp\.open\(\)/,
  "the full-GM dashboard should register the Downtime Workspace tile",
);

assert.match(
  source,
  /game\.keybindings\.register\(MODULE_ID, "openDowntimeActivities"[\s\S]*?KeyD[\s\S]*?DowntimeActivitiesApp\.open\(\)/,
  "Shift+D should be registered as a rebindable downtime launcher",
);

assert.match(
  source,
  /function registerPrivateDependentServices\(\)[\s\S]*?"downtime service"[\s\S]*?registerDowntimeService/,
  "the authoritative downtime service should wait for restricted private state",
);

assert.match(
  source,
  /"downtime socket"[\s\S]*?registerDowntimeSocket[\s\S]*?"downtime player auto-open"[\s\S]*?configureDowntimePlayerAutoOpen/,
  "the player downtime socket and targeted auto-open should initialize independently",
);

assert.match(
  source,
  /registerSharpeningHooks\(\{[\s\S]*?notifySharpenDamage[\s\S]*?notifyLongRest/,
  "D&D5e damage and long-rest hooks should route sharpening changes authoritatively",
);

assert.match(
  source,
  /function registerPrivateDependentServices\(\)[\s\S]*?"critical injury service"[\s\S]*?registerCriticalInjuryService/,
  "the authority service should wait for the restricted private workflow store",
);

assert.match(
  source,
  /"critical injury socket"[\s\S]*?registerCriticalInjurySocket[\s\S]*?"critical injury player app"[\s\S]*?registerCriticalInjuryApp/,
  "the socket and player app should initialize while private-state recovery is pending",
);

assert.match(
  source,
  /"critical injury body HUD"[\s\S]*?registerCriticalInjuryHud/,
  "the compact body HUD should initialize independently of private-state recovery",
);

assert.doesNotMatch(
  source,
  /safeInitializeSubsystem\([\s\S]{0,100}"critical injury body HUD"[\s\S]{0,160}CriticalInjuryApp\.open/,
  "HUD startup must not automatically open the large injury window",
);

/* ---- Private-state recovery and promoted-GM resource authority ---- */

assert.match(
  source,
  /function recoverPrivateStateAndServices\(\)[\s\S]*?await initializePrivateState\(\)[\s\S]*?await migrateResourceConfig\(\)[\s\S]*?registerPrivateDependentServices\(\)/,
  "late private-state recovery should migrate resources before enabling dependent services",
);

assert.match(
  source,
  /reason === "role-promotion"[\s\S]*?reason === "store-ready"[\s\S]*?reason === "journal-create"[\s\S]*?reason === "authority-change"[\s\S]*?requestRecoveryAfterHooks\(\)/,
  "role promotion and late Journal arrival should recover without a client reload",
);

assert.match(
  source,
  /observeResourceAuthorityTransition\(\)[\s\S]*?Hooks\?\.on\?\.\("updateUser", onAuthorityCandidateChanged\)[\s\S]*?Hooks\?\.on\?\.\("userConnected", onAuthorityCandidateChanged\)/,
  "role and connection changes should observe deterministic GM handoffs",
);

assert.match(
  source,
  /onPrivateStateChanged\([\s\S]*?isSharedAuthoritativeGM\(\) && !isResourceAutomationReady\(\)[\s\S]*?requestRecoveryAfterHooks\(\)/,
  "a stale run-state Journal update should lock readiness and trigger automatic reassertion",
);

assert.match(
  source,
  /!privateStateAvailable && isFullGM\(\)[\s\S]*?retry automatically[\s\S]*?schedulePrivateStateRecovery\(\)/,
  "a failed ready-time private load should schedule an automatic retry",
);

process.stdout.write("module launcher validation passed\n");
