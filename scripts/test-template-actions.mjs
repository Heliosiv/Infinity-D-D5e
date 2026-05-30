import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const CHECKS = [
  {
    name: "dashboard",
    template: "templates/dashboard.hbs",
    script: "scripts/dashboard.js",
  },
  {
    name: "per-encounter loot",
    template: "templates/loot-forge.hbs",
    script: "scripts/app.js",
    dynamicActions: ["useParty"],
  },
  {
    name: "hoard loot",
    template: "templates/hoard-loot.hbs",
    script: "scripts/hoard-loot.js",
  },
  {
    name: "per-creature loot",
    template: "templates/per-creature-loot.hbs",
    script: "scripts/per-creature-loot.js",
  },
];

for (const check of CHECKS) {
  const templateSource = readFileSync(check.template, "utf8");
  const scriptSource = readFileSync(check.script, "utf8");
  const templateActions = extractTemplateActions(templateSource);
  const dynamicTemplateActions = extractDynamicTemplateActions(templateSource);
  const registeredActions = extractRegisteredActions(scriptSource);
  const dynamicActions = new Set(check.dynamicActions ?? []);

  assert.ok(
    templateActions.size > 0,
    `${check.name}: template should expose data-action hooks`,
  );
  assert.ok(
    registeredActions.size > 0,
    `${check.name}: application should register action handlers`,
  );

  for (const action of templateActions) {
    assert.ok(
      registeredActions.has(action),
      `${check.name}: template action "${action}" is missing from DEFAULT_OPTIONS.actions`,
    );
  }

  for (const action of dynamicActions) {
    assert.ok(
      registeredActions.has(action),
      `${check.name}: dynamic action "${action}" is missing from DEFAULT_OPTIONS.actions`,
    );
    assert.ok(
      scriptSource.includes(`action: "${action}"`) ||
        scriptSource.includes(`action: '${action}'`),
      `${check.name}: dynamic action "${action}" should be provided by render context`,
    );
  }

  const templateOrDynamic = new Set([...templateActions, ...dynamicActions]);
  for (const action of registeredActions) {
    assert.ok(
      templateOrDynamic.has(action),
      `${check.name}: registered action "${action}" is not used by the template`,
    );
  }

  const unexpectedDynamic = [...dynamicTemplateActions].filter(
    (expression) => expression !== "extra.action",
  );
  assert.deepEqual(
    unexpectedDynamic,
    [],
    `${check.name}: unaccounted dynamic data-action expression(s)`,
  );

  for (const expression of dynamicTemplateActions) {
    assert.ok(
      dynamicActions.size > 0,
      `${check.name}: dynamic data-action "{{${expression}}}" needs an explicit test allow-list`,
    );
  }
}

process.stdout.write("template action coverage validation passed\n");

function extractTemplateActions(source) {
  const actions = new Set();
  for (const match of source.matchAll(/\bdata-action="([^"]+)"/g)) {
    const action = match[1].trim();
    if (!action || action.includes("{{")) continue;
    actions.add(action);
  }
  return actions;
}

function extractDynamicTemplateActions(source) {
  const actions = new Set();
  for (const match of source.matchAll(
    /\bdata-action="\{\{\s*([^}]+?)\s*\}\}"/g,
  )) {
    actions.add(match[1].trim());
  }
  return actions;
}

function extractRegisteredActions(source) {
  const blockMatch = source.match(/\bactions:\s*\{([\s\S]*?)\n\s*\},/);
  assert.ok(blockMatch, "application source should contain an actions block");
  const actions = new Set();
  for (const match of blockMatch[1].matchAll(/^\s*([A-Za-z_$][\w$]*)\s*:/gm)) {
    actions.add(match[1]);
  }
  return actions;
}
