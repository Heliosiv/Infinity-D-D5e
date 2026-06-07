import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const source = readFileSync("scripts/module.js", "utf8");

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
  /if \(game\.user\?\.isGM\) registerGmSceneControls\(controls\);\s*else registerPlayerSceneControls\(controls\);/s,
  "scene-controls hook should branch GM vs player",
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

process.stdout.write("module launcher validation passed\n");
