/** Focused compatibility tests for the unified Loot Studio shell. */

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

import Handlebars from "handlebars";

import { fakeItem } from "./test-utils/fixtures.mjs";

function inspectTopLevelElements(html) {
  const voidTags = new Set([
    "area",
    "base",
    "br",
    "col",
    "embed",
    "hr",
    "img",
    "input",
    "link",
    "meta",
    "param",
    "source",
    "track",
    "wbr",
  ]);
  const stack = [];
  let count = 0;
  for (const match of html.matchAll(
    /<\/?([a-z][\w:-]*)(?:\s[^<>]*?)?\s*\/?>/gi,
  )) {
    const token = match[0];
    const tag = match[1].toLowerCase();
    if (token.startsWith("</")) {
      assert.equal(stack.pop(), tag, `balanced closing tag for ${tag}`);
      continue;
    }
    if (stack.length === 0) count += 1;
    if (!token.endsWith("/>") && !voidTags.has(tag)) stack.push(tag);
  }
  return { count, unclosed: stack };
}

const renderLog = [];
const closeLog = [];

globalThis.foundry = {
  applications: {
    api: {
      ApplicationV2: class {
        constructor(options = {}) {
          this.options = options;
          this.rendered = false;
          this.element = null;
        }

        render() {
          this.rendered = true;
          renderLog.push(this.constructor.name);
          return this;
        }

        bringToFront() {
          this.broughtToFront = true;
          return this;
        }

        close() {
          if (!this._closePromise) {
            this._closePromise = (async () => {
              await this._testCloseGate;
              this.rendered = false;
              closeLog.push(this.constructor.name);
              this._onClose?.();
              return this;
            })();
          }
          return this._closePromise;
        }
      },
      HandlebarsApplicationMixin: (Base) => class extends Base {},
    },
  },
};

globalThis.CONST = { USER_ROLES: { GAMEMASTER: 4 } };
let uiPreferences = {
  version: 1,
  density: "comfortable",
  lastLootStudioMode: "encounter",
  dismissedQuickStarts: [],
  advancedDisclosures: {},
};
const persistState = false;
globalThis.game = {
  user: { id: "gm", isGM: true, role: 4 },
  settings: {
    get(_moduleId, key) {
      if (key === "uiPreferences") return uiPreferences;
      if (key === "persistState") return persistState;
      return undefined;
    },
    async set(_moduleId, key, value) {
      if (key === "uiPreferences") uiPreferences = value;
      return value;
    },
  },
};

const { LootStudioApp, LOOT_STUDIO_MODE_CLASSES, openLootStudio } =
  await import("./loot-studio.js");
const { PerEncounterLootApp } = await import("./app.js");
const { HoardLootApp } = await import("./hoard-loot.js");
const { PerCreatureLootApp } = await import("./per-creature-loot.js");
const { BaseLootApp, normalizeLootStudioMode } =
  await import("./loot/loot-app-base.js");

assert.equal(normalizeLootStudioMode("encounter"), "encounter");
assert.equal(normalizeLootStudioMode(" HOARD "), "hoard");
assert.equal(normalizeLootStudioMode("creature"), "creature");
assert.equal(normalizeLootStudioMode("unknown"), "encounter");
assert.equal(normalizeLootStudioMode(null), "encounter");

{
  const calls = [];
  const tabs = ["encounter", "hoard", "creature"].map((mode) => ({
    mode,
    focus: () => calls.push(`focus:${mode}`),
    click: () => calls.push(`click:${mode}`),
  }));
  const tabList = { querySelectorAll: () => tabs };
  for (const tab of tabs) tab.closest = () => tabList;
  const keyboardHost = new PerEncounterLootApp();
  const press = (key, currentTarget) => {
    calls.length = 0;
    keyboardHost._onLootStudioTabKeyDown({
      key,
      currentTarget,
      preventDefault: () => calls.push("preventDefault"),
    });
    return [...calls];
  };
  assert.deepEqual(press("ArrowRight", tabs[0]), [
    "preventDefault",
    "focus:hoard",
    "click:hoard",
  ]);
  assert.deepEqual(press("ArrowLeft", tabs[0]), [
    "preventDefault",
    "focus:creature",
    "click:creature",
  ]);
  assert.deepEqual(press("Home", tabs[2]), [
    "preventDefault",
    "focus:encounter",
    "click:encounter",
  ]);
  assert.deepEqual(press("End", tabs[0]), [
    "preventDefault",
    "focus:creature",
    "click:creature",
  ]);
  assert.deepEqual(press("Tab", tabs[0]), [], "Tab keeps native focus order");
}

assert.deepEqual(
  [
    PerEncounterLootApp.TOOL_ID,
    HoardLootApp.TOOL_ID,
    PerCreatureLootApp.TOOL_ID,
  ],
  ["per-encounter-loot", "hoard-loot", "per-creature-loot"],
  "existing preset/history store identifiers remain unchanged",
);

for (const [mode, Cls] of Object.entries(LOOT_STUDIO_MODE_CLASSES)) {
  assert.equal(
    Cls.LOOT_STUDIO_MODE,
    mode,
    `${Cls.name} advertises its routed mode`,
  );
  assert.equal(
    Cls.DEFAULT_OPTIONS.id,
    "infinity-dnd5e-loot-studio",
    `${Cls.name} uses the one shared window identity`,
  );
  assert.equal(
    Cls.DEFAULT_OPTIONS.PARTS,
    undefined,
    "Application parts stay on the class, not mutable options",
  );
  assert.match(Cls.PARTS.studio.template, /templates\/loot-studio\.hbs$/);
  assert.equal(
    LOOT_STUDIO_MODE_CLASSES[mode].prototype._primaryGenerate,
    Cls.prototype._primaryGenerate,
    `${mode} routing delegates to the established generation method`,
  );
}

assert.equal(
  LootStudioApp.prototype instanceof BaseLootApp,
  true,
  "LootStudioApp is the one real ApplicationV2 host",
);
assert.match(
  LootStudioApp.PARTS.body.template,
  /templates\/loot-studio-body\.hbs$/,
);
assert.deepEqual(
  new Set(LootStudioApp.PARTS.body.templates),
  new Set([
    "modules/infinity-dnd5e/templates/loot-forge.hbs",
    "modules/infinity-dnd5e/templates/hoard-loot.hbs",
    "modules/infinity-dnd5e/templates/per-creature-loot.hbs",
    "modules/infinity-dnd5e/templates/loot-result-item.hbs",
  ]),
  "ApplicationV2 preloads every mode and nested result partial",
);

const encounterHost = openLootStudio({ mode: "encounter" });
assert.ok(encounterHost instanceof LootStudioApp);
assert.equal(LootStudioApp.instance, encounterHost);
assert.equal(LootStudioApp.mode, "encounter");
assert.ok(encounterHost.controller instanceof PerEncounterLootApp);
assert.equal(encounterHost.rendered, true);

const encounterController = encounterHost.controller;
encounterHost._form = { ...encounterHost._form, partySize: 7 };
encounterHost._lastResult = { items: [{ entryId: "encounter-result" }] };
encounterHost._undoStack = [
  { items: [{ entryId: "undo-1" }] },
  { items: [{ entryId: "undo-2" }] },
];

const hoardHost = await HoardLootApp.open();
assert.equal(hoardHost, encounterHost, "legacy Hoard open reuses the host");
assert.ok(hoardHost.controller instanceof HoardLootApp);
assert.equal(LootStudioApp.mode, "hoard");
assert.equal(encounterHost.rendered, true, "the host remains rendered");
assert.deepEqual(closeLog, [], "tab switching never closes an application");

const hoardController = hoardHost.controller;
hoardHost._form = { ...hoardHost._form, scale: "large" };
hoardHost._lastResult = { items: [{ entryId: "hoard-result" }] };
hoardHost._undoStack = [{ items: [{ entryId: "hoard-undo" }] }];

const creatureHost = await LootStudioApp.open({ mode: "creature" });
assert.equal(creatureHost, encounterHost);
assert.ok(creatureHost.controller instanceof PerCreatureLootApp);
assert.equal(closeLog.length, 0);

const restoredEncounter = await PerEncounterLootApp.open();
assert.equal(restoredEncounter, encounterHost);
assert.equal(restoredEncounter.controller, encounterController);
assert.equal(restoredEncounter._form.partySize, 7);
assert.equal(
  restoredEncounter._lastResult.items[0].entryId,
  "encounter-result",
);
assert.deepEqual(
  restoredEncounter._undoStack.map((entry) => entry.items[0].entryId),
  ["undo-1", "undo-2"],
  "each live controller retains its bounded undo stack",
);

const restoredHoard = await openLootStudio("hoard");
assert.equal(restoredHoard, encounterHost);
assert.equal(restoredHoard.controller, hoardController);
assert.equal(restoredHoard._form.scale, "large");
assert.equal(restoredHoard._lastResult.items[0].entryId, "hoard-result");
assert.equal(restoredHoard._undoStack[0].items[0].entryId, "hoard-undo");
await new Promise((resolve) => setTimeout(resolve, 0));
assert.equal(uiPreferences.lastLootStudioMode, "hoard");
assert.deepEqual(
  Object.keys(uiPreferences).sort(),
  [
    "advancedDisclosures",
    "density",
    "dismissedQuickStarts",
    "lastLootStudioMode",
    "version",
  ],
  "preference writes pass through the sanitized v1 schema",
);

const rapidCreature = LootStudioApp.open({ mode: "creature" });
const rapidEncounter = LootStudioApp.open({ mode: "encounter" });
assert.equal(rapidCreature, encounterHost);
assert.equal(rapidEncounter, encounterHost);
assert.equal(LootStudioApp.mode, "encounter");
assert.equal(closeLog.length, 0);
assert.ok(
  renderLog.every((name) => name === "LootStudioApp"),
  "only the unified ApplicationV2 host renders",
);

let delayedReadoutCalls = 0;
encounterController._debounce(
  "mode-switch-test",
  () => {
    delayedReadoutCalls += 1;
  },
  0,
);
LootStudioApp.open({ mode: "hoard" });
await new Promise((resolve) => setTimeout(resolve, 5));
assert.equal(
  delayedReadoutCalls,
  0,
  "delayed work from an inactive controller cannot patch the active panel",
);
hoardController._debounce(
  "active-mode-test",
  () => {
    delayedReadoutCalls += 1;
  },
  0,
);
await new Promise((resolve) => setTimeout(resolve, 5));
assert.equal(delayedReadoutCalls, 1, "the active controller still runs work");

/* A real close ends the tab session when Persist Last Result is disabled. */
await encounterHost.close();
assert.equal(LootStudioApp.instance, null);
assert.deepEqual(closeLog, ["LootStudioApp"]);
const reopenedCreature = openLootStudio({ mode: "creature" });
assert.ok(reopenedCreature instanceof LootStudioApp);
assert.notEqual(reopenedCreature, encounterHost);
const freshEncounter = await LootStudioApp.open({ mode: "encounter" });
assert.equal(freshEncounter, reopenedCreature);
assert.equal(
  freshEncounter._form.partySize,
  4,
  "a prior mode's form does not survive a genuine Studio close",
);
assert.equal(freshEncounter._lastResult, null);
assert.deepEqual(freshEncounter._undoStack, []);
await freshEncounter.close();

/* Deterministic business-outcome equivalence for every compatibility route. */
const equivalencePool = [
  fakeItem({
    _id: "eq-dagger",
    name: "Dagger",
    tier: "t1",
    gpValue: 5,
    lootType: "loot.weapon.mundane",
  }),
  fakeItem({
    _id: "eq-rope",
    name: "Silk Rope",
    tier: "t1",
    gpValue: 10,
    lootType: "loot.equipment",
    type: "equipment",
  }),
  fakeItem({
    _id: "eq-gem",
    name: "Moonstone",
    tier: "t1",
    gpValue: 15,
    lootType: "loot.gem",
    type: "loot",
  }),
  fakeItem({
    _id: "eq-potion",
    name: "Healing Draught",
    tier: "t1",
    gpValue: 20,
    lootType: "loot.potion",
    type: "consumable",
  }),
  fakeItem({
    _id: "eq-mail",
    name: "Chain Shirt",
    tier: "t2",
    rarity: "uncommon",
    gpValue: 75,
    lootType: "loot.armor.mundane",
    type: "equipment",
  }),
  fakeItem({
    _id: "eq-blade",
    name: "Amber Blade",
    tier: "t2",
    rarity: "uncommon",
    gpValue: 125,
    lootType: "loot.weapon.magic",
    properties: ["mgc"],
  }),
  fakeItem({
    _id: "eq-elixir",
    name: "Elixir of Vigor",
    tier: "t2",
    rarity: "uncommon",
    gpValue: 175,
    lootType: "loot.consumable",
    type: "consumable",
    properties: ["mgc"],
  }),
  fakeItem({
    _id: "eq-art",
    name: "Silver Icon",
    tier: "t2",
    gpValue: 50,
    lootType: "loot.art",
    type: "loot",
  }),
];

const equivalenceCases = [
  ["encounter", PerEncounterLootApp, 0x31f00d],
  ["hoard", HoardLootApp, 0x42f00d],
  ["creature", PerCreatureLootApp, 0x53f00d],
];

for (const [mode, CompatibilityClass, seed] of equivalenceCases) {
  const legacyController = new CompatibilityClass();
  configureEquivalenceController(mode, legacyController, equivalencePool);
  await withSeed(seed, () => legacyController._primaryGenerate());
  const expected = projectBusinessOutcome(mode, legacyController._lastResult);
  assert.ok(
    projectedItemCount(mode, expected) > 0,
    `${mode} seeded baseline exercises generated item outcomes`,
  );

  const unifiedHost = openLootStudio({ mode });
  assert.equal(
    await CompatibilityClass.open(),
    unifiedHost,
    `${mode} compatibility API resolves to the unified host`,
  );
  const unifiedController = unifiedHost.controller;
  configureEquivalenceController(mode, unifiedController, equivalencePool);
  await withSeed(seed, () => unifiedController._primaryGenerate());
  const actual = projectBusinessOutcome(mode, unifiedController._lastResult);

  assert.deepEqual(
    actual,
    expected,
    `${mode} compatibility and unified routes preserve seeded business outcomes`,
  );
  await unifiedHost.close();
}

const studioTemplate = await readFile(
  new URL("../templates/loot-studio.hbs", import.meta.url),
  "utf8",
);
assert.match(studioTemplate, /role="tablist"/);
assert.match(studioTemplate, /role="tab"/);
assert.match(studioTemplate, /aria-selected=/);
assert.match(studioTemplate, /aria-controls=/);
assert.match(studioTemplate, /tabindex=/);
assert.match(studioTemplate, /data-loot-studio-switch/);

const renderedStudio = Handlebars.compile(studioTemplate)({
  lootStudio: {
    activeLabel: "Encounter",
    tabs: ["encounter", "hoard", "creature"].map((id) => ({
      id,
      label: id,
      icon: "fa-solid fa-coins",
      active: id === "encounter",
      tabId: `loot-studio-tab-${id}`,
      panelId: `loot-studio-panel-${id}`,
    })),
  },
});
assert.deepEqual(
  inspectTopLevelElements(renderedStudio),
  { count: 1, unclosed: [] },
  "the studio ApplicationV2 part renders one root element",
);
assert.equal(
  renderedStudio.match(/role="tabpanel"/g)?.length,
  2,
  "inactive mode tabs keep valid hidden tabpanel targets",
);
for (const mode of ["hoard", "creature"]) {
  assert.match(
    renderedStudio,
    new RegExp(
      `id="loot-studio-panel-${mode}"[\\s\\S]*?aria-labelledby="loot-studio-tab-${mode}"[\\s\\S]*?hidden`,
    ),
  );
}

for (const templateName of [
  "loot-forge.hbs",
  "hoard-loot.hbs",
  "per-creature-loot.hbs",
]) {
  const source = await readFile(
    new URL(`../templates/${templateName}`, import.meta.url),
    "utf8",
  );
  assert.match(source, /role="tabpanel"/);
  assert.match(source, /data-loot-advanced/);
  assert.match(source, /no selection = Any/);
  assert.match(source, />Select all</);
  assert.match(source, />Clear selection</);
  assert.match(source, /templates\/loot-result-item\.hbs/);
  assert.doesNotMatch(source, /#\*inline "lootItem"/);
  Handlebars.registerPartial(
    `modules/infinity-dnd5e/templates/${templateName}`,
    source,
  );
}

const sharedResultItem = await readFile(
  new URL("../templates/loot-result-item.hbs", import.meta.url),
  "utf8",
);
const renderResultItem = Handlebars.compile(sharedResultItem);
Handlebars.registerPartial(
  "modules/infinity-dnd5e/templates/loot-result-item.hbs",
  sharedResultItem,
);
const resultItemContext = {
  entryId: "shared-row",
  rarity: "uncommon",
  item: { uuid: "Item.shared", name: "Shared Result" },
  displayName: "Shared Result",
  imageSrc: "icons/svg/item-bag.svg",
  quantityLabel: "",
  gpTotalLabel: "25 gp",
  locked: false,
};
assert.match(
  renderResultItem({ ...resultItemContext, showLockControl: true }),
  /data-action="toggleLock"/,
  "Encounter enables the mode-specific lock branch",
);
assert.doesNotMatch(
  renderResultItem(resultItemContext),
  /data-action="toggleLock"/,
  "Hoard and Creature reuse the row without Encounter lock controls",
);

const studioBodyTemplate = await readFile(
  new URL("../templates/loot-studio-body.hbs", import.meta.url),
  "utf8",
);
for (const templateName of [
  "loot-forge.hbs",
  "hoard-loot.hbs",
  "per-creature-loot.hbs",
]) {
  assert.match(
    studioBodyTemplate,
    new RegExp(templateName.replace(".", "\\.")),
  );
}

const renderStudioBody = Handlebars.compile(studioBodyTemplate);
for (const mode of ["encounter", "hoard", "creature"]) {
  const host = openLootStudio({ mode });
  const context = await host._prepareContext();
  const html = renderStudioBody(context);
  assert.match(
    html,
    new RegExp(`id="loot-studio-panel-${mode}"`),
    `${mode} renders inside the persistent host body`,
  );
  await host.close();
}

const studioSource = await readFile(
  new URL("./loot-studio.js", import.meta.url),
  "utf8",
);
assert.doesNotMatch(
  studioSource,
  /rollLoot|computeLootBudget|computeHoardBudget|splitCoinPile/,
  "the Studio host must not duplicate or alter loot engines",
);
assert.ok(renderLog.length >= 5, "every routed mode rendered through the host");

function configureEquivalenceController(mode, controller, items) {
  controller._cachedItems = items;
  controller._cachedItemsAt = Date.now();
  controller._packStats = { totalItems: items.length };
  controller._lastResult = null;
  controller._undoStack = [];

  if (mode === "encounter") {
    controller._form = {
      ...controller._form,
      tier: "t2",
      scaleMultiplier: 1,
      generosityMultiplier: 1,
      partySize: 4,
      itemLimitEnabled: true,
      count: 3,
      budgetOverride: 800,
      artVariants: false,
      magicBias: 0,
      rarities: [],
      lootTypes: [],
      minItemGp: 0,
      maxItemGp: 0,
    };
  } else if (mode === "hoard") {
    controller._form = {
      ...controller._form,
      tier: "t2",
      scale: "standard",
      pileBias: 0,
      maxItems: 3,
      artVariants: false,
      magicBias: 0,
      rarities: [],
      lootTypes: [],
      minItemGp: 0,
      maxItemGp: 0,
    };
  } else {
    controller._form = {
      ...controller._form,
      defaultTier: "t1",
      itemsPerCreature: 2,
      magicBias: 0,
      rarities: [],
      lootTypes: [],
      minItemGp: 0,
      maxItemGp: 0,
      roster: [
        { id: "eq-scout", name: "Scout", tier: "t1" },
        { id: "eq-brute", name: "Brute", tier: "t2" },
      ],
    };
  }
}

async function withSeed(seed, operation) {
  const originalRandom = Math.random;
  let state = seed >>> 0;
  Math.random = () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
  try {
    return await operation();
  } finally {
    Math.random = originalRandom;
  }
}

function projectBusinessOutcome(mode, result) {
  const projectEntry = (entry) => ({
    itemId: entry.item?.uuid ?? entry.item?._id ?? entry.item?.id ?? "",
    name: entry.displayName ?? entry.item?.name ?? "",
    quantity: entry.quantity,
    gpTotal: entry.gpTotal,
    rarity: entry.rarity,
    rollCategory: entry.rollCategory,
  });

  if (mode === "encounter") {
    return {
      totalGp: result?.totalGp,
      budgetGp: result?.budgetGp,
      droppedForBudget: result?.droppedForBudget,
      warnings: result?.warnings,
      items: (result?.items ?? []).map(projectEntry),
    };
  }
  if (mode === "hoard") {
    return {
      itemsTotalGp: result?.itemsTotalGp,
      itemBudget: result?.itemBudget,
      coinPileGp: result?.coinPileGp,
      coinBreakdown: result?.coinBreakdown,
      totalGp: result?.totalGp,
      droppedForBudget: result?.droppedForBudget,
      warnings: result?.warnings,
      items: (result?.items ?? []).map(projectEntry),
    };
  }
  return {
    grandTotal: result?.grandTotal,
    creatures: (result?.creatures ?? []).map((creature) => ({
      id: creature.id,
      name: creature.name,
      tier: creature.tier,
      budgetGp: creature.budgetGp,
      totalGp: creature.totalGp,
      warnings: creature.warnings,
      items: (creature.items ?? []).map(projectEntry),
    })),
  };
}

function projectedItemCount(mode, outcome) {
  if (mode === "creature") {
    return (outcome?.creatures ?? []).reduce(
      (total, creature) => total + (creature.items?.length ?? 0),
      0,
    );
  }
  return outcome?.items?.length ?? 0;
}

delete globalThis.game;
delete globalThis.CONST;
delete globalThis.foundry;

process.stdout.write("loot-studio compatibility validation passed\n");
