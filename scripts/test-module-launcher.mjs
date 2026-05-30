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

process.stdout.write("module launcher validation passed\n");
