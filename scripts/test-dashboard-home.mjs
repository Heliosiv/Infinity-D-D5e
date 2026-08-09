import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import Handlebars from "handlebars";

let helpDialogOptions = null;
globalThis.foundry = {
  applications: {
    api: {
      ApplicationV2: class {},
      HandlebarsApplicationMixin: (Base) => class extends Base {},
      DialogV2: {
        prompt(options) {
          helpDialogOptions = options;
          return null;
        },
      },
    },
  },
};
globalThis.CONST = { USER_ROLES: { GAMEMASTER: 4 } };
globalThis.Hooks = { on: () => 1, off: () => {} };

const notifications = [];
globalThis.ui = {
  notifications: {
    error: (message) => notifications.push(message),
    info: (message) => notifications.push(message),
    warn: (message) => notifications.push(message),
  },
};

const settings = new Map([
  ["criticalInjuriesEnabled", true],
  ["recentTools", []],
  ["resourcePlayerView", true],
]);
const moduleApi = {
  openCriticalInjuries: () => {},
  openDowntimeActivities: () => {},
  openHub: () => {},
  openPartySupplies: () => {},
  openReputationView: () => {},
  openShops: () => {},
};
const modules = new Map([
  ["infinity-dnd5e", { active: true, version: "0.3.0", api: moduleApi }],
  ["socketlib", { active: true, version: "1.1.4" }],
  ["monks-active-tiles", { active: false, version: "13.06" }],
  [
    "foundryvtt-simple-calendar-reborn",
    {
      active: true,
      version: "2.4.1",
      api: { showCalendar: () => {} },
    },
  ],
]);

const fullGm = { id: "gm-secret-id", active: true, isGM: true, role: 4 };
globalThis.game = {
  user: fullGm,
  modules,
  version: "13.351",
  release: { version: "13.351" },
  system: { version: "5.1.4" },
  settings: {
    get: (_moduleId, key) => settings.get(key),
    set: async (_moduleId, key, value) => settings.set(key, value),
  },
};
globalThis.SimpleCalendar = {
  api: modules.get("foundryvtt-simple-calendar-reborn").api,
};

const {
  buildHomeHelpDialogContent,
  buildPlayerHomeActions,
  groupHomeActionsByIntent,
  InfinityDashboardApp,
  openHub,
} = await import("./dashboard.js");
const { clearTools, registerTool, TOOL_INTENTS } =
  await import("./tool-registry.js");

assert.equal(
  typeof openHub,
  "function",
  "dashboard exports the openHub API hook",
);

clearTools();
let privilegedOpenCalls = 0;
registerTool({
  id: "merchant-workspace",
  title: "Merchant Workspace",
  category: "merchants",
  status: "available",
  open: () => {
    privilegedOpenCalls += 1;
  },
});
registerTool({
  id: "per-encounter-loot",
  title: "Per-Encounter Loot",
  category: "loot",
  status: "available",
});
registerTool({
  id: "reputation",
  title: "Reputation & Factions",
  category: "party",
  status: "available",
});

InfinityDashboardApp._recentsHydrated = false;
InfinityDashboardApp._recentToolIds = [];
const app = Object.create(InfinityDashboardApp.prototype);
const gmContext = await app._prepareContext();
assert.equal(gmContext.isFullGm, true);
assert.deepEqual(
  gmContext.groups.map((group) => group.label),
  ["Prepare", "Run the Session", "Track the Campaign"],
);
assert.deepEqual(
  gmContext.groups.flatMap((group) => group.actions.map((action) => action.id)),
  ["merchant-workspace", "per-encounter-loot", "reputation"],
  "full GM Home contains only registered GM tools grouped by intent",
);
const renderHome = Handlebars.compile(
  readFileSync("templates/dashboard.hbs", "utf8"),
);
const homeTemplateSource = readFileSync("templates/dashboard.hbs", "utf8");
const templateActions = new Set(
  [...homeTemplateSource.matchAll(/data-action="([^"]+)"/g)].map(
    (match) => match[1],
  ),
);
assert.deepEqual(
  templateActions,
  new Set(Object.keys(InfinityDashboardApp.DEFAULT_OPTIONS.actions)),
  "every Home template action has exactly one registered handler",
);
const gmHtml = renderHome(gmContext);
assert.match(gmHtml, /Merchant Workspace/);
assert.match(gmHtml, /Per-Encounter Loot/);
assert.match(gmHtml, /Reputation &amp; Factions/);
assert.match(gmHtml, /data-action="help"/);
assert.match(gmHtml, /aria-haspopup="dialog"/);
assert.doesNotMatch(gmHtml, /aria-controls="infinity-home-help"/);
assert.doesNotMatch(
  gmHtml,
  /id-quick-start|data-home-help|Help &amp; Diagnostics/,
);
await InfinityDashboardApp._onHelp();
assert.equal(helpDialogOptions.window.title, "Infinity D&D5e — Home Help");
assert.ok(helpDialogOptions.classes.includes("infinity-dialog"));
assert.match(helpDialogOptions.content, /Prepare:/);
assert.match(helpDialogOptions.content, /Shift\+I/);
assert.equal(helpDialogOptions.ok.label, "Close");
assert.doesNotMatch(buildHomeHelpDialogContent(), /Prepare:/);

let settingsOpenCalls = 0;
moduleApi.openSettings = () => {
  settingsOpenCalls += 1;
};
await InfinityDashboardApp._onOpenSettings();
assert.equal(
  settingsOpenCalls,
  1,
  "Home prefers the role-aware Infinity Settings API",
);

const playerActions = buildPlayerHomeActions({
  moduleApi,
  calendarApi: globalThis.SimpleCalendar.api,
  gameRef: globalThis.game,
});
assert.equal(
  playerActions.length,
  6,
  "all existing player destinations remain",
);
assert.ok(
  playerActions.some((action) => action.surface === "calendar"),
  "Calendar appears in player Home",
);
assert.ok(playerActions.every((action) => action.launchKind === "surface"));
assert.deepEqual(
  groupHomeActionsByIntent(playerActions).map((group) => group.id),
  [TOOL_INTENTS.PREPARE, TOOL_INTENTS.RUN_SESSION, TOOL_INTENTS.TRACK_CAMPAIGN],
);

globalThis.game.user = {
  id: "assistant-secret-id",
  active: true,
  isGM: true,
  role: 3,
};
settings.set("criticalInjuriesEnabled", false);
settings.set("resourcePlayerView", false);
const assistantContext = await app._prepareContext();
assert.equal(assistantContext.isFullGm, false);
assert.equal(assistantContext.isAssistantGm, true);
assert.equal(assistantContext.roleLabel, "Assistant GM Home");
const assistantActions = assistantContext.groups.flatMap(
  (group) => group.actions,
);
assert.deepEqual(
  assistantActions
    .filter((action) =>
      ["critical-injuries", "party-supplies"].includes(action.surface),
    )
    .map((action) => ({
      surface: action.surface,
      available: action.isAvailable,
      reason: action.statusReason,
    })),
  [
    {
      surface: "party-supplies",
      available: false,
      reason: "Party Supplies is not available in this world.",
    },
    {
      surface: "critical-injuries",
      available: false,
      reason: "Critical Injuries are not enabled in this world.",
    },
  ],
  "player Home reflects world feature gates with generic reasons",
);
assert.doesNotMatch(
  JSON.stringify(assistantActions),
  /assistant-secret-id|gm-secret-id/,
  "unavailable Home actions do not expose user or campaign identifiers",
);
assert.ok(
  assistantContext.groups
    .flatMap((group) => group.actions)
    .every((action) => action.launchKind === "surface"),
  "Assistant GM receives only permission-scoped player destinations",
);
const playerHelp = buildHomeHelpDialogContent({ fullGm: false });
assert.match(playerHelp, /player-safe tools/);
assert.doesNotMatch(playerHelp, /assistant-secret-id|gm-secret-id/);
const assistantHtml = renderHome(assistantContext);
assert.doesNotMatch(
  assistantHtml,
  /Merchant Workspace|Per-Encounter Loot/,
  "player markup does not contain privileged GM destinations",
);
assert.match(assistantHtml, /Shops/);
assert.match(assistantHtml, /Calendar/);
const renderedIds = [...assistantHtml.matchAll(/\sid="([^"]+)"/g)].map(
  (match) => match[1],
);
assert.equal(
  new Set(renderedIds).size,
  renderedIds.length,
  "role-aware Home renders no duplicate ids",
);

const homeCss = readFileSync("styles/dashboard.css", "utf8");
assert.match(homeCss, /container:\s*infinity-home\s*\/\s*inline-size/);
for (const width of [720, 520, 380]) {
  assert.match(
    homeCss,
    new RegExp(`@container infinity-home \\(max-width: ${width}px\\)`),
  );
}
assert.doesNotMatch(
  homeCss,
  /(?:100vw|100vh)/,
  "Home has no viewport coupling",
);
assert.match(homeCss, /@media \(pointer: coarse\)[\s\S]*min-height:\s*44px/);

await InfinityDashboardApp._onLaunch.call({ render: async () => {} }, null, {
  dataset: { launchKind: "tool", launchId: "merchant-workspace" },
});
assert.equal(
  privilegedOpenCalls,
  0,
  "a non-full-GM cannot launch a registered GM tool through a changed DOM",
);
assert.match(notifications.at(-1), /Only a Game Master/);

let playerOpenCalls = 0;
moduleApi.openShops = () => {
  playerOpenCalls += 1;
};
await InfinityDashboardApp._onLaunch.call({ render: async () => {} }, null, {
  dataset: { launchKind: "surface", launchId: "shops" },
});
assert.equal(playerOpenCalls, 1, "player Home opens a fixed local surface");

clearTools();
delete globalThis.SimpleCalendar;
delete globalThis.game;
delete globalThis.Hooks;
delete globalThis.CONST;
delete globalThis.foundry;
delete globalThis.ui;

process.stdout.write("role-aware dashboard Home validation passed\n");
