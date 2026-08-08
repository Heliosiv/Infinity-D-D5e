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
  /const onCategoryChange = \(_event, active\) => \{\s*if \(active\) InfinityDashboardApp\.open\(\);/s,
  "scene-control category should open the dashboard when activated",
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

/* ---- Player-initiated Shops launcher (non-GM) ---- */

assert.match(
  source,
  /if \(isFullGM\(\)\) registerGmSceneControls\(controls\);\s*else registerPlayerSceneControls\(controls\);/s,
  "scene-controls hook should reserve the GM dashboard for full GMs",
);

assert.match(
  source,
  /function registerPlayerSceneControls\(controls\) \{/,
  "a dedicated non-GM scene-control registration should exist",
);

assert.match(
  source,
  /function registerPlayerSceneControls[\s\S]*?if \(active\) ShopPickerApp\.open\(\)/,
  "the player category should open the ShopPickerApp (never the GM dashboard)",
);

assert.match(
  source,
  /function registerPlayerSceneControls[\s\S]*?controls\.push\(categoryEntry\(/,
  "V12 player launcher should push a Shops category",
);

assert.match(
  source,
  /function registerPlayerSceneControls[\s\S]*?controls\[category\] = categoryEntry\(/,
  "V13 player launcher should add a Shops category record",
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
  /function registerPlayerSceneControls[\s\S]*?ResourceOverviewApp\.open\(\)/,
  "the non-full-GM scene controls should expose Party Supplies",
);

assert.match(
  source,
  /openCriticalInjuries: \(\) => CriticalInjuryApp\.openForCurrentUser\(\)/,
  "the module API should expose the player Critical Injuries window",
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

assert.match(
  source,
  /function registerPlayerSceneControls[\s\S]*?CriticalInjuryApp\.openForCurrentUser\(\)/,
  "the non-full-GM scene controls should expose Critical Injuries",
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
  /function registerPlayerSceneControls[\s\S]*?controls\.push\(downtimeCategoryEntry\(/,
  "V12 player controls should expose a Downtime Activities category",
);

assert.match(
  source,
  /function registerPlayerSceneControls[\s\S]*?controls\[downtimeCategory\] = downtimeCategoryEntry\(/,
  "V13 player controls should expose a Downtime Activities category",
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
  /private data could not be loaded yet[\s\S]*?schedulePrivateStateRecovery\(\)/,
  "a failed ready-time private load should schedule an automatic retry",
);

process.stdout.write("module launcher validation passed\n");
