/**
 * Tests for the shared loot-app helpers, plus a stubbed smoke-import of
 * all three loot windows. The windows destructure
 * `foundry.applications.api` at module-evaluation time, so we install a
 * minimal Foundry stub before importing them — this proves the modules
 * still load, the classes construct, and every shared helper they import
 * actually resolves after the Phase-0 dedup.
 */

import assert from "node:assert/strict";

import {
  humanizeKey,
  livePartySize,
  readMultiCheckGroup,
  renderAfterAction,
  resolveChatRecipients,
  resultImageForEntry,
  sameSet,
  selectedTokenActorIds,
  setText,
  tierLabel,
  toDistributableEntry,
} from "./loot/loot-app-shared.js";
import { tierWindow } from "./loot/tag-vocabulary.js";
import { fakeItem } from "./test-utils/fixtures.mjs";

/* ------------------------------------------------------------------ *
 * Pure helpers
 * ------------------------------------------------------------------ */

// resultImageForEntry: bundled art paths rewrite to module-relative URLs.
assert.equal(
  resultImageForEntry({ item: { img: "icons/weapons/sword.webp" } }),
  "icons/weapons/sword.webp",
);
assert.equal(
  resultImageForEntry({ imageSrc: "assets/item-art/unique/amber.webp" }),
  "modules/infinity-dnd5e/assets/item-art/unique/amber.webp",
);
assert.equal(resultImageForEntry({}), "icons/svg/item-bag.svg");
assert.equal(
  resultImageForEntry({ itemData: { img: "icons/x.webp" } }),
  "icons/x.webp",
);

// tierLabel
assert.equal(tierLabel("t3"), "T3 — Lvl 11–16");
assert.equal(tierLabel("nope"), "nope");

// sameSet — order/duplicate insensitive
assert.ok(sameSet(["a", "b"], ["b", "a"]));
assert.ok(sameSet(["a", "a", "b"], ["b", "a"]));
assert.ok(!sameSet(["a"], ["a", "b"]));
assert.ok(!sameSet("a", ["a"]));

// humanizeKey
assert.equal(humanizeKey("coinHeavy"), "Coin Heavy");
assert.equal(humanizeKey("very-rare"), "Very Rare");
assert.equal(humanizeKey(""), "");

// toDistributableEntry — displayName wins, quantity floored to >=1.
assert.deepEqual(
  toDistributableEntry({
    item: { uuid: "U" },
    displayName: "Sword",
    quantity: 3,
  }),
  { uuid: "U", name: "Sword", quantity: 3 },
);
assert.deepEqual(
  toDistributableEntry({ itemData: { name: "Gem" }, quantity: 0 }),
  { itemData: { name: "Gem" }, name: "Gem", quantity: 1 },
);
assert.equal(toDistributableEntry({ item: {} }), null);
assert.equal(toDistributableEntry(null), null);

// selectedTokenActorIds — dedupes, keeps only world actors, degrades to [].
{
  const savedCanvas = globalThis.canvas;
  const savedGame = globalThis.game;
  const worldActors = new Map([
    ["a1", {}],
    ["a2", {}],
  ]);
  globalThis.game = { actors: { get: (id) => worldActors.get(id) ?? null } };
  globalThis.canvas = {
    tokens: {
      controlled: [
        { actor: { id: "a1" } },
        { actor: { id: "a1" } }, // duplicate → deduped
        { actor: { id: "a2" } },
        { actor: { id: "synthetic" } }, // not a world actor → skipped
        { actor: null }, // no actor → skipped
        {}, // no token.actor → skipped
      ],
    },
  };
  assert.deepEqual(selectedTokenActorIds(), ["a1", "a2"]);

  globalThis.canvas = { tokens: { controlled: [] } };
  assert.deepEqual(selectedTokenActorIds(), [], "no selection → empty");

  delete globalThis.canvas;
  assert.deepEqual(selectedTokenActorIds(), [], "no canvas → empty");

  if (savedCanvas !== undefined) globalThis.canvas = savedCanvas;
  else delete globalThis.canvas;
  if (savedGame !== undefined) globalThis.game = savedGame;
  else delete globalThis.game;
}

// renderAfterAction — swallows sync throw and async rejection. Silence
// the expected console.warn so the test output stays clean.
{
  const realWarn = console.warn;
  console.warn = () => {};
  try {
    renderAfterAction(() => {
      throw new Error("boom");
    }, "sync");
    renderAfterAction(() => Promise.reject(new Error("async")), "async");
  } finally {
    // Restore after a tick so the async rejection's .catch is swallowed too.
    await Promise.resolve();
    console.warn = realWarn;
  }
}

// livePartySize / resolveChatRecipients degrade gracefully with no game.
const savedGame = globalThis.game;
delete globalThis.game;
assert.equal(livePartySize(), 0);
assert.equal(resolveChatRecipients("public"), null);
assert.equal(resolveChatRecipients("whisper-gm"), null);
if (savedGame !== undefined) globalThis.game = savedGame;

// resolveChatRecipients with a fake game splits by role.
globalThis.game = {
  users: [
    { id: "gm", active: true, isGM: true },
    { id: "p1", active: true, isGM: false },
    { id: "p2", active: false, isGM: false },
  ],
};
assert.deepEqual(resolveChatRecipients("whisper-gm"), ["gm"]);
assert.deepEqual(resolveChatRecipients("whisper-players"), ["p1"]);
delete globalThis.game;

// setText / readMultiCheckGroup against a tiny DOM stub.
const checks = [
  { value: "common", checked: true },
  { value: "rare", checked: false },
  { value: "epic", checked: true },
];
const fakeRoot = {
  _text: "",
  querySelector() {
    return { set textContent(v) {} };
  },
  querySelectorAll(sel) {
    return sel.includes("checked") ? checks.filter((c) => c.checked) : [];
  },
};
assert.deepEqual(readMultiCheckGroup(fakeRoot, "rarity"), ["common", "epic"]);
assert.deepEqual(readMultiCheckGroup(null, "rarity"), []);
setText(null, "x", "y"); // no throw on null root

/* ------------------------------------------------------------------ *
 * Stubbed smoke-import of the three windows
 * ------------------------------------------------------------------ */

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

const { PerEncounterLootApp } = await import("./app.js");
const { HoardLootApp } = await import("./hoard-loot.js");
const { PerCreatureLootApp } = await import("./per-creature-loot.js");

for (const [name, Cls] of [
  ["PerEncounterLootApp", PerEncounterLootApp],
  ["HoardLootApp", HoardLootApp],
  ["PerCreatureLootApp", PerCreatureLootApp],
]) {
  assert.equal(typeof Cls, "function", `${name} should export a class`);
  const form = Cls.buildDefaultForm();
  assert.ok(form && typeof form === "object", `${name}.buildDefaultForm()`);
  const instance = new Cls();
  assert.ok(instance._form, `${name} constructs with a form`);
  // Shared lifecycle is inherited from BaseLootApp.
  for (const method of [
    "_renderPreservingScroll",
    "_loadItems",
    "_onKeyDown",
    "_decorateEntry",
    "_countCandidates",
    "_candidateAvailability",
    "_patchCandidateAvailability",
    "_canStartPrimaryGeneration",
    "_sliderContext",
  ]) {
    assert.equal(
      typeof instance[method],
      "function",
      `${name} should inherit ${method} from BaseLootApp`,
    );
  }
  // Every action referenced in DEFAULT_OPTIONS must resolve to a function,
  // including the spread-in shared handlers.
  const actions = Cls.DEFAULT_OPTIONS.actions ?? {};
  for (const shared of ["reset", "clear", "rerollOne", "deleteItem"]) {
    assert.equal(
      typeof actions[shared],
      "function",
      `${name} must inherit shared action "${shared}"`,
    );
  }
  // Lock only does something on Per-Encounter (its Re-roll Unlocked path);
  // Hoard and Per-Creature deliberately omit the otherwise no-op control.
  if (name === "PerEncounterLootApp") {
    assert.equal(
      typeof actions.toggleLock,
      "function",
      `${name} should keep the working toggleLock action`,
    );
  } else {
    assert.equal(
      actions.toggleLock,
      undefined,
      `${name} should omit the no-op toggleLock action`,
    );
  }
  for (const [action, handler] of Object.entries(actions)) {
    assert.equal(
      typeof handler,
      "function",
      `${name} action "${action}" must be a function`,
    );
  }
  // The full render-context path must build without throwing.
  const context = await instance._prepareContext();
  assert.ok(
    context && context.form,
    `${name}._prepareContext() returns context`,
  );
}

/* ------------------------------------------------------------------ *
 * Primary generation availability stays live and tool-aware.
 * ------------------------------------------------------------------ */
{
  const t1Common = fakeItem({
    _id: "t1-common",
    rarity: "common",
    tier: "t1",
    lootType: "loot.weapon.mundane",
  });
  const t4Legendary = fakeItem({
    _id: "t4-legendary",
    rarity: "legendary",
    tier: "t4",
    lootType: "loot.equipment.magic",
  });

  const pendingEncounter = new PerEncounterLootApp();
  let state = pendingEncounter._primaryGenerationState();
  assert.equal(state.loading, true, "first render waits for the pack preload");
  assert.equal(state.disabled, true);
  pendingEncounter._packStats = { totalItems: 0 };
  state = pendingEncounter._primaryGenerationState();
  assert.equal(
    state.disabled,
    false,
    "a failed preload leaves Generate available for a retry",
  );

  const encounter = new PerEncounterLootApp();
  encounter._cachedItems = [t1Common];
  encounter._packStats = { totalItems: 1 };
  encounter._form = {
    ...encounter._form,
    tier: "t5",
    rarities: ["common"],
    lootTypes: [],
    minItemGp: 0,
    maxItemGp: 0,
  };

  state = encounter._primaryGenerationState();
  assert.equal(state.candidateEmpty, true);
  assert.equal(
    state.disabled,
    true,
    "encounter blocks an empty candidate pool",
  );
  assert.match(state.reason, /No items match/);

  // A Hoard preserves its documented coin-only fallback when filters match no
  // items. The zero-match readout remains visible, but generation is allowed.
  const hoard = new HoardLootApp();
  hoard._cachedItems = [t1Common];
  hoard._packStats = { totalItems: 1 };
  hoard._form = {
    ...hoard._form,
    tier: "t5",
    rarities: ["common"],
    lootTypes: [],
    minItemGp: 0,
    maxItemGp: 0,
  };
  state = hoard._primaryGenerationState();
  assert.equal(state.candidateEmpty, true);
  assert.equal(state.disabled, false, "empty hoard pool still rolls coins");
  assert.match(state.label, /coin-only hoard/);

  // Per-Creature evaluates every distinct roster tier, not a tier-less global
  // count. T1 has a valid common, while T5's T4/T5 window does not.
  const perCreature = new PerCreatureLootApp();
  perCreature._cachedItems = [t1Common, t4Legendary];
  perCreature._packStats = { totalItems: 2 };
  perCreature._form = {
    ...perCreature._form,
    rarities: ["common"],
    lootTypes: [],
    minItemGp: 0,
    maxItemGp: 0,
    roster: [
      { id: "c1", name: "Scout", tier: "t1" },
      { id: "c2", name: "Champion", tier: "t5" },
    ],
  };
  state = perCreature._primaryGenerationState();
  assert.equal(state.count, 1, "candidate count is scoped to roster tiers");
  assert.equal(state.candidateEmpty, true);
  assert.equal(state.disabled, true, "one empty roster tier blocks Roll All");
  assert.match(state.label, /no matches for T5/);
  assert.match(state.reason, /for T5/);

  perCreature._form = {
    ...perCreature._form,
    roster: [{ id: "c1", name: "Scout", tier: "t1" }],
  };
  state = perCreature._primaryGenerationState();
  assert.equal(state.candidateEmpty, false);
  assert.equal(state.disabled, false);

  perCreature._form = { ...perCreature._form, roster: [] };
  state = perCreature._primaryGenerationState();
  assert.equal(state.disabled, true, "empty roster blocks Roll All");
  assert.equal(state.notificationLevel, "info");
  assert.match(state.reason, /Add at least one creature/);

  // Live patching disables immediately after the debounced candidate scan and
  // restores both the enabled state and the original tooltip when filters
  // recover.
  const readoutClasses = new Set();
  const readoutAttributes = new Map();
  const readout = {
    textContent: "",
    classList: {
      toggle(name, enabled) {
        if (enabled) readoutClasses.add(name);
        else readoutClasses.delete(name);
      },
    },
    setAttribute(name, value) {
      readoutAttributes.set(name, String(value));
    },
    removeAttribute(name) {
      readoutAttributes.delete(name);
    },
  };
  const buttonAttributes = new Map([
    ["title", "Generate (Enter or R)"],
    ["data-ready-title", "Generate (Enter or R)"],
  ]);
  const generateButton = {
    dataset: { readyTitle: "Generate (Enter or R)" },
    disabled: false,
    getAttribute(name) {
      return buttonAttributes.get(name) ?? null;
    },
    setAttribute(name, value) {
      buttonAttributes.set(name, String(value));
    },
    removeAttribute(name) {
      buttonAttributes.delete(name);
    },
  };
  encounter.element = {
    querySelector(selector) {
      return selector === "[data-candidates]" ? readout : null;
    },
    querySelectorAll(selector) {
      return selector === "[data-action='generate']" ? [generateButton] : [];
    },
  };

  encounter._patchCandidateAvailability();
  assert.equal(generateButton.disabled, true);
  assert.equal(buttonAttributes.get("aria-disabled"), "true");
  assert.match(buttonAttributes.get("title"), /No items match/);
  assert.ok(readoutClasses.has("is-empty"));

  encounter._form = { ...encounter._form, tier: "t1" };
  encounter._patchCandidateAvailability();
  assert.equal(generateButton.disabled, false);
  assert.equal(buttonAttributes.get("aria-disabled"), "false");
  assert.equal(buttonAttributes.get("title"), "Generate (Enter or R)");
  assert.ok(!readoutClasses.has("is-empty"));

  // Keyboard shortcuts perform the same synchronous guard as the button, so
  // they cannot exploit the 120 ms live-readout debounce window.
  const savedUi = globalThis.ui;
  const warnings = [];
  globalThis.ui = {
    notifications: {
      warn: (message) => warnings.push(message),
      info: (message) => warnings.push(message),
    },
  };
  let primaryCalls = 0;
  encounter._primaryGenerate = () => {
    primaryCalls += 1;
  };
  encounter._form = { ...encounter._form, tier: "t5" };
  const keyEvent = {
    key: "R",
    target: { tagName: "DIV" },
    defaultPrevented: false,
    ctrlKey: false,
    metaKey: false,
    preventDefault() {},
  };
  encounter._onKeyDown(keyEvent);
  assert.equal(primaryCalls, 0, "R cannot bypass an empty candidate guard");
  assert.equal(warnings.length, 1);

  encounter._form = { ...encounter._form, tier: "t1" };
  encounter._onKeyDown(keyEvent);
  assert.equal(primaryCalls, 1, "R rolls once candidates recover");

  if (savedUi !== undefined) globalThis.ui = savedUi;
  else delete globalThis.ui;

  // A direct generation call is guarded too: invalid filters preserve both
  // the current result and the Undo stack.
  const previousResult = { items: [{ entryId: "keep-me" }], totalGp: 10 };
  let undoPushes = 0;
  encounter._lastResult = previousResult;
  encounter._pushUndo = () => {
    undoPushes += 1;
  };
  encounter._form = { ...encounter._form, tier: "t5" };
  await encounter._generate();
  assert.equal(encounter._lastResult, previousResult);
  assert.equal(undoPushes, 0);
}

/* ------------------------------------------------------------------ *
 * Per-Creature single-slot reroll stays inside the owning creature's
 * tier window and budget. Regression: the shared handler read a global
 * `_lastResult.budgetGp` (never set by Per-Creature → unbounded value)
 * and a tier-less `_filterSpec()` (→ any-tier swaps).
 * ------------------------------------------------------------------ */
{
  const app = new PerCreatureLootApp();
  const t1Entry = { entryId: "e1", item: { _id: "i1" }, gpTotal: 5 };
  const t4Entry = { entryId: "e2", item: { _id: "i2" }, gpTotal: 9000 };
  const t1List = [t1Entry];
  const t4List = [t4Entry];
  app._lastResult = {
    creatures: [
      { id: "c1", tier: "t1", items: t1List, budgetGp: 120 },
      { id: "c2", tier: "t4", items: t4List, budgetGp: 18000 },
    ],
  };

  // A reroll's candidate filter carries the OWNING creature's tier window.
  assert.deepEqual(
    app._rerollFilterSpec(t1Entry).tiers,
    tierWindow("t1"),
    "per-creature reroll filter uses the owning creature's tier window",
  );
  assert.deepEqual(app._rerollFilterSpec(t4Entry).tiers, tierWindow("t4"));

  // A reroll's budget = the owning creature's budget (resolved by list identity).
  assert.equal(app._rerollBudgetForList(t1List), 120);
  assert.equal(app._rerollBudgetForList(t4List), 18000);

  // Unknown entry / unowned list degrade safely: no tier window, zero budget.
  assert.equal(app._rerollFilterSpec({ entryId: "x" }).tiers, undefined);
  assert.equal(app._rerollBudgetForList([]), 0);
}

/* ------------------------------------------------------------------ *
 * Flat tools (Hoard / Per-Encounter) keep the original base behavior:
 * the single global `_lastResult.budgetGp` bounds the reroll.
 * ------------------------------------------------------------------ */
{
  const hoard = new HoardLootApp();
  hoard._lastResult = { items: [], budgetGp: 777 };
  assert.equal(
    hoard._rerollBudgetForList(hoard._lastResult.items),
    777,
    "flat tool reroll budget reads _lastResult.budgetGp",
  );
}

delete globalThis.foundry;

process.stdout.write("loot-app-shared validation passed\n");
