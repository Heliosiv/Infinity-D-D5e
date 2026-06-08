/**
 * Cross-check every window template against its application's registered
 * actions: every `data-action` in the template must have a handler, and
 * every registered handler must be used by the template (or be an
 * allow-listed dynamic action).
 *
 * Actions are read from the live class `DEFAULT_OPTIONS.actions` (via a
 * stubbed Foundry import) rather than parsed from source, so spread-in
 * shared handlers from BaseLootApp are counted correctly.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

// Minimal Foundry stub so the window modules evaluate under node.
globalThis.foundry = {
  applications: {
    api: {
      ApplicationV2: class {
        constructor(options = {}) {
          this.options = options;
        }
      },
      HandlebarsApplicationMixin: (Base) => class extends Base {},
    },
  },
};

const CHECKS = [
  {
    name: "dashboard",
    template: "templates/dashboard.hbs",
    script: "./dashboard.js",
  },
  {
    name: "per-encounter loot",
    template: "templates/loot-forge.hbs",
    script: "./app.js",
    dynamicActions: ["useParty"],
  },
  {
    name: "hoard loot",
    template: "templates/hoard-loot.hbs",
    script: "./hoard-loot.js",
  },
  {
    name: "per-creature loot",
    template: "templates/per-creature-loot.hbs",
    script: "./per-creature-loot.js",
  },
  {
    name: "merchant workspace",
    template: "templates/merchant-workspace.hbs",
    script: "./merchant-workspace.js",
  },
  {
    name: "merchant session",
    template: "templates/merchant-session.hbs",
    script: "./merchant-session.js",
  },
  {
    name: "shop picker",
    template: "templates/shop-picker.hbs",
    script: "./shop-picker.js",
  },
  {
    name: "resource manager",
    template: "templates/resource-manager.hbs",
    script: "./resource-manager.js",
  },
  {
    name: "forage prompt",
    template: "templates/forage-prompt.hbs",
    script: "./forage-prompt.js",
  },
];

for (const check of CHECKS) {
  const templateSource = readFileSync(check.template, "utf8");
  const templateActions = extractTemplateActions(templateSource);
  const dynamicTemplateActions = extractDynamicTemplateActions(templateSource);
  const registeredActions = await loadRegisteredActions(check);
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
}

delete globalThis.foundry;

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

async function loadRegisteredActions(check) {
  // Prefer the live class — it sees spread-in shared handlers (e.g. the
  // loot apps' ...BaseLootApp.SHARED_ACTIONS).
  try {
    const mod = await import(check.script);
    for (const exported of Object.values(mod)) {
      if (typeof exported === "function" && exported.DEFAULT_OPTIONS?.actions) {
        return new Set(Object.keys(exported.DEFAULT_OPTIONS.actions));
      }
    }
  } catch {
    // Module not importable under the node stub (e.g. extra globals) —
    // fall back to parsing the literal actions block from source.
  }
  const fsPath = `scripts/${check.script.replace(/^\.\//, "")}`;
  const source = readFileSync(fsPath, "utf8");
  const blockMatch = source.match(/\bactions:\s*\{([\s\S]*?)\n\s*\},/);
  if (!blockMatch) {
    throw new Error(
      `${check.script}: could not resolve actions (import + source-parse both failed)`,
    );
  }
  const actions = new Set();
  for (const m of blockMatch[1].matchAll(/^\s*([A-Za-z_$][\w$]*)\s*:/gm)) {
    actions.add(m[1]);
  }
  return actions;
}
