import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  LOOT_STUDIO_MODES,
  UI_DENSITIES,
  UI_DENSITY_ATTRIBUTE,
  UI_PREFERENCES_SCHEMA_VERSION,
  UI_PREFERENCES_SETTING_KEY,
  applyUiDensity,
  createDefaultUiPreferences,
  createUiPreferencesSettingDefinition,
  dismissQuickStart,
  getUiPreferences,
  normalizeUiPreferences,
  registerUiPreferencesSetting,
  restoreQuickStarts,
  setAdvancedDisclosure,
  setUiPreferences,
  updateUiPreferences,
} from "./ui-preferences.js";
import { GM_WORKBENCH_ROUTES } from "./gm-workbench-routes.js";

const MODULE_ID = "infinity-dnd5e";

/* Schema defaults and normalization ------------------------------- */

{
  const first = createDefaultUiPreferences();
  const second = createDefaultUiPreferences();
  assert.deepEqual(first, {
    version: 2,
    density: "comfortable",
    lastLootStudioMode: "encounter",
    lastGmWorkbenchRoute: "merchants",
    dismissedQuickStarts: [],
    advancedDisclosures: {},
  });
  assert.equal(UI_PREFERENCES_SCHEMA_VERSION, 2);
  assert.equal(UI_PREFERENCES_SETTING_KEY, "uiPreferences");
  assert.deepEqual(UI_DENSITIES, ["comfortable", "compact"]);
  assert.deepEqual(LOOT_STUDIO_MODES, ["encounter", "hoard", "creature"]);
  assert.deepEqual(GM_WORKBENCH_ROUTES, [
    "merchants",
    "quartermaster",
    "downtime",
    "factions",
    "injuries",
  ]);
  assert.notEqual(first.dismissedQuickStarts, second.dismissedQuickStarts);
  assert.notEqual(first.advancedDisclosures, second.advancedDisclosures);
}

{
  const normalized = normalizeUiPreferences({
    version: 999,
    density: "compact",
    lastLootStudioMode: "hoard",
    lastGmWorkbenchRoute: "factions",
    dismissedQuickStarts: [
      "home:v1",
      "home:v1",
      " quartermaster.first-run ",
      "contains spaces",
      "<script>",
      42,
    ],
    advancedDisclosures: Object.fromEntries([
      ["loot-studio:encounter", true],
      ["merchant.stock", false],
      ["contains spaces", true],
      ["wrong-type", "true"],
      ["__proto__", true],
    ]),
    privateWorldState: { mustNotPersist: true },
  });

  assert.deepEqual(normalized, {
    version: 2,
    density: "compact",
    lastLootStudioMode: "hoard",
    lastGmWorkbenchRoute: "factions",
    dismissedQuickStarts: ["home:v1", "quartermaster.first-run"],
    advancedDisclosures: {
      "loot-studio:encounter": true,
      "merchant.stock": false,
    },
  });
  assert.deepEqual(Object.keys(normalized).sort(), [
    "advancedDisclosures",
    "density",
    "dismissedQuickStarts",
    "lastGmWorkbenchRoute",
    "lastLootStudioMode",
    "version",
  ]);
}

{
  assert.deepEqual(normalizeUiPreferences(null), createDefaultUiPreferences());
  assert.deepEqual(
    normalizeUiPreferences({
      density: "tiny",
      lastLootStudioMode: "everything",
      lastGmWorkbenchRoute: "secrets",
      dismissedQuickStarts: "home:v1",
      advancedDisclosures: [],
    }),
    createDefaultUiPreferences(),
  );
  assert.equal(
    normalizeUiPreferences({ lastLootMode: "creature" }).lastLootStudioMode,
    "creature",
    "legacy lastLootMode reads into the canonical field",
  );
  assert.deepEqual(
    normalizeUiPreferences({ dismissedQuickStartVersions: ["home:v2"] })
      .dismissedQuickStarts,
    ["home:v2"],
    "early quick-start field spelling remains readable",
  );

  const manyQuickStarts = Array.from(
    { length: 80 },
    (_, index) => `guide:${index}`,
  );
  assert.equal(
    normalizeUiPreferences({ dismissedQuickStarts: manyQuickStarts })
      .dismissedQuickStarts.length,
    64,
    "quick-start persistence is bounded",
  );

  const manyDisclosures = Object.fromEntries(
    Array.from({ length: 160 }, (_, index) => [`section:${index}`, true]),
  );
  assert.equal(
    Object.keys(
      normalizeUiPreferences({ advancedDisclosures: manyDisclosures })
        .advancedDisclosures,
    ).length,
    128,
    "Advanced disclosure persistence is bounded",
  );
}

/* Node-safe Foundry setting integration --------------------------- */

{
  assert.deepEqual(getUiPreferences(null), createDefaultUiPreferences());
  assert.deepEqual(
    await setUiPreferences({ density: "compact" }, null),
    normalizeUiPreferences({ density: "compact" }),
  );
  assert.equal(registerUiPreferencesSetting(null), false);
}

{
  const definition = createUiPreferencesSettingDefinition();
  assert.equal(definition.scope, "client");
  assert.equal(definition.config, false);
  assert.equal(definition.type, Object);
  assert.deepEqual(definition.default, createDefaultUiPreferences());

  const calls = [];
  const gameInstance = {
    settings: {
      register(moduleId, key, options) {
        calls.push({ moduleId, key, options });
      },
    },
  };
  assert.equal(registerUiPreferencesSetting(gameInstance), true);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].moduleId, MODULE_ID);
  assert.equal(calls[0].key, UI_PREFERENCES_SETTING_KEY);
  assert.equal(calls[0].options.scope, "client");
}

{
  let stored = {
    density: "compact",
    lastLootStudioMode: "creature",
    lastGmWorkbenchRoute: "downtime",
    dismissedQuickStarts: ["home:v1"],
    advancedDisclosures: { "loot-studio:creature": true },
    leaked: "drop me",
  };
  const calls = [];
  const gameInstance = {
    settings: {
      get(moduleId, key) {
        assert.equal(moduleId, MODULE_ID);
        assert.equal(key, UI_PREFERENCES_SETTING_KEY);
        return stored;
      },
      async set(moduleId, key, value) {
        calls.push({ moduleId, key, value });
        stored = value;
      },
    },
  };

  assert.deepEqual(getUiPreferences(gameInstance), {
    version: 2,
    density: "compact",
    lastLootStudioMode: "creature",
    lastGmWorkbenchRoute: "downtime",
    dismissedQuickStarts: ["home:v1"],
    advancedDisclosures: { "loot-studio:creature": true },
  });

  const updated = await updateUiPreferences(
    {
      density: "comfortable",
      advancedDisclosures: { "loot-studio:hoard": false },
      ignoredPrivateData: { actorIds: ["secret"] },
    },
    gameInstance,
  );
  assert.deepEqual(updated.advancedDisclosures, {
    "loot-studio:creature": true,
    "loot-studio:hoard": false,
  });
  assert.equal(updated.density, "comfortable");
  assert.equal("ignoredPrivateData" in updated, false);

  await dismissQuickStart("home:v2", gameInstance);
  await dismissQuickStart("home:v2", gameInstance);
  assert.deepEqual(stored.dismissedQuickStarts, ["home:v1", "home:v2"]);

  await setAdvancedDisclosure("loot-studio:encounter", true, gameInstance);
  assert.equal(stored.advancedDisclosures["loot-studio:encounter"], true);
  assert.equal(stored.advancedDisclosures["loot-studio:creature"], true);

  await updateUiPreferences({ lastLootMode: "hoard" }, gameInstance);
  assert.equal(stored.lastLootStudioMode, "hoard");
  assert.equal("lastLootMode" in stored, false);

  await updateUiPreferences({ lastGmWorkbenchRoute: "injuries" }, gameInstance);
  assert.equal(stored.lastGmWorkbenchRoute, "injuries");
  await updateUiPreferences(
    { lastGmWorkbenchRoute: "private-state" },
    gameInstance,
  );
  assert.equal(
    stored.lastGmWorkbenchRoute,
    "merchants",
    "unknown Workbench routes fail back to the safe first route",
  );

  await restoreQuickStarts(gameInstance);
  assert.deepEqual(stored.dismissedQuickStarts, []);
  assert.ok(calls.length >= 6, "writes use the mocked client setting service");
  for (const call of calls) {
    assert.equal(call.moduleId, MODULE_ID);
    assert.equal(call.key, UI_PREFERENCES_SETTING_KEY);
    assert.equal(call.value.version, 2);
  }
}

{
  const gameInstance = {
    settings: {
      get() {
        throw new Error("setting is not registered yet");
      },
    },
  };
  assert.deepEqual(
    getUiPreferences(gameInstance),
    createDefaultUiPreferences(),
    "an early or unregistered read falls back without throwing",
  );
}

{
  const failed = new Error("client setting write rejected");
  const gameInstance = {
    settings: {
      get: () => createDefaultUiPreferences(),
      set: async () => {
        throw failed;
      },
    },
  };
  await assert.rejects(
    setUiPreferences({ density: "compact" }, gameInstance),
    failed,
    "a real Foundry write failure remains observable to the caller",
  );
  await assert.rejects(
    updateUiPreferences({ density: "compact" }, gameInstance),
    failed,
    "queued updates do not report failed persistence as success",
  );
}

{
  let stored = createDefaultUiPreferences();
  let attempts = 0;
  const gameInstance = {
    settings: {
      get: () => stored,
      async set(_moduleId, _key, value) {
        attempts += 1;
        if (attempts === 1) throw new Error("first write failed");
        stored = value;
      },
    },
  };
  await assert.rejects(
    updateUiPreferences({ density: "compact" }, gameInstance),
    /first write failed/,
  );
  await updateUiPreferences({ lastLootStudioMode: "creature" }, gameInstance);
  assert.equal(stored.lastLootStudioMode, "creature");
  assert.equal(
    attempts,
    2,
    "a rejected queue entry does not block the next preference write",
  );
}

{
  let stored = createDefaultUiPreferences();
  let firstWriteStarted;
  const started = new Promise((resolve) => {
    firstWriteStarted = resolve;
  });
  let releaseFirstWrite;
  const release = new Promise((resolve) => {
    releaseFirstWrite = resolve;
  });
  let writeCount = 0;
  const gameInstance = {
    settings: {
      get: () => stored,
      async set(_moduleId, _key, value) {
        writeCount += 1;
        if (writeCount === 1) {
          firstWriteStarted();
          await release;
        }
        stored = value;
      },
    },
  };

  const modeWrite = updateUiPreferences(
    { lastLootStudioMode: "hoard" },
    gameInstance,
  );
  await started;
  const disclosureWrite = updateUiPreferences(
    { advancedDisclosures: { "loot-studio:hoard": true } },
    gameInstance,
  );
  releaseFirstWrite();
  await Promise.all([modeWrite, disclosureWrite]);

  assert.equal(stored.lastLootStudioMode, "hoard");
  assert.equal(stored.advancedDisclosures["loot-studio:hoard"], true);
  assert.equal(writeCount, 2, "overlapping preference writes are serialized");
}

/* Root density data/class contract -------------------------------- */

{
  const classes = new Set();
  const root = {
    dataset: {},
    classList: {
      toggle(name, enabled) {
        if (enabled) classes.add(name);
        else classes.delete(name);
      },
    },
  };
  assert.equal(applyUiDensity(root, "compact"), "compact");
  assert.equal(root.dataset.infinityDensity, "compact");
  assert.equal(classes.has("infinity-density--compact"), true);
  assert.equal(classes.has("infinity-density--comfortable"), false);

  assert.equal(applyUiDensity(root, { density: "comfortable" }), "comfortable");
  assert.equal(root.dataset.infinityDensity, "comfortable");
  assert.equal(classes.has("infinity-density--compact"), false);
  assert.equal(classes.has("infinity-density--comfortable"), true);

  let attribute = null;
  const rootWithoutDataset = {
    setAttribute(name, value) {
      attribute = [name, value];
    },
  };
  assert.equal(applyUiDensity(rootWithoutDataset, "invalid"), "comfortable");
  assert.deepEqual(attribute, [UI_DENSITY_ATTRIBUTE, "comfortable"]);
  assert.equal(applyUiDensity(null, "compact"), "compact");
}

/* CSS contract and semantic contrast ------------------------------ */

const here = path.dirname(fileURLToPath(import.meta.url));
const tokensCss = readFileSync(
  path.join(here, "..", "styles", "tokens.css"),
  "utf8",
);
const systemCss = readFileSync(
  path.join(here, "..", "styles", "ui-system.css"),
  "utf8",
);

function cssHexVariable(css, name) {
  const match = css.match(new RegExp(`--${name}:\\s*(#[0-9a-f]{6})`, "i"));
  assert.ok(match, `missing hex token --${name}`);
  return match[1];
}

function relativeLuminance(hex) {
  const channels = hex
    .slice(1)
    .match(/.{2}/g)
    .map((part) => Number.parseInt(part, 16) / 255)
    .map((channel) =>
      channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4,
    );
  return 0.2126 * channels[0] + 0.7152 * channels[1] + 0.0722 * channels[2];
}

function contrastRatio(foreground, background) {
  const first = relativeLuminance(foreground);
  const second = relativeLuminance(background);
  const light = Math.max(first, second);
  const dark = Math.min(first, second);
  return (light + 0.05) / (dark + 0.05);
}

for (const [foregroundName, backgroundName] of [
  ["lf-text", "lf-bg"],
  ["lf-muted", "lf-bg"],
  ["lf-accent-contrast", "lf-accent"],
  ["lf-info", "lf-info-bg"],
  ["lf-success", "lf-success-bg"],
  ["lf-warn", "lf-warn-bg"],
  ["lf-danger", "lf-danger-bg"],
]) {
  const foreground = cssHexVariable(tokensCss, foregroundName);
  const background = cssHexVariable(tokensCss, backgroundName);
  assert.ok(
    contrastRatio(foreground, background) >= 4.5,
    `${foregroundName} must meet WCAG AA against ${backgroundName}`,
  );
}

assert.match(tokensCss, /--lf-control-size:\s*44px/);
assert.match(tokensCss, /--lf-control-size:\s*32px/);
assert.match(tokensCss, /data-infinity-density="comfortable"/);
assert.match(tokensCss, /data-infinity-density="compact"/);
assert.match(tokensCss, /@media \(pointer: coarse\), \(any-pointer: coarse\)/);
assert.match(tokensCss, /@media \(prefers-reduced-motion: reduce\)/);
assert.match(tokensCss, /@media \(forced-colors: active\)/);
assert.match(tokensCss, /--lf-text-xs:\s*max\(0\.75rem,\s*12px\)/);

assert.match(systemCss, /container-name:\s*infinity-app/);
assert.match(systemCss, /container-type:\s*inline-size/);
for (const width of [1040, 720, 520, 380]) {
  assert.match(
    systemCss,
    new RegExp(`@container infinity-app \\(max-width: ${width}px\\)`),
  );
}
assert.match(systemCss, /\.infinity-sticky-actions/);
assert.match(systemCss, /\.infinity-master-detail/);
assert.match(systemCss, /\.infinity-field__error/);
assert.match(systemCss, /\.infinity-sr-only/);

console.log("UI preference and shared UI foundation validation passed");
