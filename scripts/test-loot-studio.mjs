/** Focused compatibility tests for the unified Loot Studio shell. */

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

import Handlebars from "handlebars";

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

function deferred() {
  let resolve;
  const promise = new Promise((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

const { LootStudioApp, LOOT_STUDIO_MODE_CLASSES, openLootStudio } =
  await import("./loot-studio.js");
const { PerEncounterLootApp } = await import("./app.js");
const { HoardLootApp } = await import("./hoard-loot.js");
const { PerCreatureLootApp } = await import("./per-creature-loot.js");
const { normalizeLootStudioMode } = await import("./loot/loot-app-base.js");

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

const encounter = openLootStudio({ mode: "encounter" });
assert.ok(encounter instanceof PerEncounterLootApp);
assert.equal(LootStudioApp.instance, encounter);
assert.equal(LootStudioApp.mode, "encounter");
assert.equal(encounter.rendered, true);

encounter._form = { ...encounter._form, partySize: 7 };
encounter._lastResult = { items: [{ entryId: "encounter-result" }] };
encounter._undoStack = [
  { items: [{ entryId: "undo-1" }] },
  { items: [{ entryId: "undo-2" }] },
];

const hoard = await HoardLootApp.open();
assert.ok(hoard instanceof HoardLootApp, "legacy Hoard open routes to Studio");
assert.equal(LootStudioApp.instance, hoard);
assert.equal(LootStudioApp.mode, "hoard");
assert.equal(encounter.rendered, false, "the prior mode closes before render");
assert.equal(hoard.rendered, true);
assert.deepEqual(closeLog, ["PerEncounterLootApp"]);

hoard._form = { ...hoard._form, scale: "large" };
hoard._lastResult = { items: [{ entryId: "hoard-result" }] };
hoard._undoStack = [{ items: [{ entryId: "hoard-undo" }] }];

const creature = await LootStudioApp.open({ mode: "creature" });
assert.ok(creature instanceof PerCreatureLootApp);
assert.equal(hoard.rendered, false);
assert.equal(creature.rendered, true);

const restoredEncounter = await PerEncounterLootApp.open();
assert.ok(restoredEncounter instanceof PerEncounterLootApp);
assert.notEqual(restoredEncounter, encounter, "closed mode gets a fresh host");
assert.equal(restoredEncounter._form.partySize, 7);
assert.equal(
  restoredEncounter._lastResult.items[0].entryId,
  "encounter-result",
);
assert.deepEqual(
  restoredEncounter._undoStack.map((entry) => entry.items[0].entryId),
  ["undo-1", "undo-2"],
  "tab switching restores a mode's bounded undo stack even when cross-close persistence is disabled",
);

const restoredHoard = await openLootStudio("hoard");
assert.equal(restoredHoard._form.scale, "large");
assert.equal(restoredHoard._lastResult.items[0].entryId, "hoard-result");
assert.equal(restoredHoard._undoStack[0].items[0].entryId, "hoard-undo");
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

/* A delayed close coalesces rapid requests and renders only the latest mode. */
const closeGate = deferred();
restoredHoard._testCloseGate = closeGate.promise;
const closeCountBeforeRace = closeLog.length;
const renderCountBeforeRace = renderLog.length;
const firstSwitch = LootStudioApp.open({ mode: "creature" });
const latestSwitch = LootStudioApp.open({ mode: "encounter" });
assert.equal(
  LootStudioApp.instance,
  restoredHoard,
  "the closing mode remains authoritative until its close finishes",
);
closeGate.resolve();
const [firstResolved, latestResolved] = await Promise.all([
  firstSwitch,
  latestSwitch,
]);
assert.ok(firstResolved instanceof PerEncounterLootApp);
assert.equal(latestResolved, firstResolved);
assert.equal(LootStudioApp.instance, firstResolved);
assert.equal(LootStudioApp.mode, "encounter");
assert.equal(
  closeLog.length,
  closeCountBeforeRace + 1,
  "one in-flight close serves every coalesced switch request",
);
assert.deepEqual(
  renderLog.slice(renderCountBeforeRace),
  ["PerEncounterLootApp"],
  "an intermediate requested mode never renders",
);

/* A real close ends the tab session when Persist Last Result is disabled. */
const activeCreature = await LootStudioApp.open({ mode: "creature" });
await activeCreature.close();
assert.equal(LootStudioApp.instance, null);
const reopenedCreature = openLootStudio({ mode: "creature" });
assert.ok(reopenedCreature instanceof PerCreatureLootApp);
const freshEncounter = await LootStudioApp.open({ mode: "encounter" });
assert.equal(
  freshEncounter._form.partySize,
  4,
  "a prior mode's form does not survive a genuine Studio close",
);
assert.equal(freshEncounter._lastResult, null);
assert.deepEqual(freshEncounter._undoStack, []);

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
}

const studioSource = await readFile(
  new URL("./loot-studio.js", import.meta.url),
  "utf8",
);
assert.doesNotMatch(
  studioSource,
  /rollLoot|computeLootBudget|computeHoardBudget|splitCoinPile/,
  "the Studio facade must not duplicate or alter loot engines",
);
assert.ok(renderLog.length >= 5, "every routed mode rendered through the host");

delete globalThis.game;
delete globalThis.CONST;
delete globalThis.foundry;

process.stdout.write("loot-studio compatibility validation passed\n");
