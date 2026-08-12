import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import Handlebars from "handlebars";

let helpDialogOptions = null;
let recoveryDialogOptions = null;
let recoveryDialogResult = false;
let recoveryDialogHook = null;
globalThis.foundry = {
  applications: {
    api: {
      ApplicationV2: class {},
      HandlebarsApplicationMixin: (Base) => class extends Base {},
      DialogV2: {
        confirm(options) {
          recoveryDialogOptions = options;
          recoveryDialogHook?.();
          return recoveryDialogResult;
        },
        prompt(options) {
          helpDialogOptions = options;
          return null;
        },
      },
    },
  },
};
globalThis.CONST = { USER_ROLES: { GAMEMASTER: 4 } };
let nextHookId = 1;
const hookListeners = new Map();
const removedHooks = [];
globalThis.Hooks = {
  on(name, callback) {
    const id = nextHookId++;
    hookListeners.set(id, { name, callback });
    return id;
  },
  off(name, id) {
    removedHooks.push([name, id]);
    hookListeners.delete(id);
  },
};

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
const users = [fullGm];
users.activeGM = fullGm;
users.get = (id) => users.find((user) => user.id === id) ?? null;
globalThis.game = {
  user: fullGm,
  users,
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
  presentPrivateStateRecoveryOverview,
  resolveSessionFocus,
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
const recoveryCalls = [];
let recoveryOverview = {
  status: {
    state: "blocked",
    code: "missing-store",
    supportedSchema: 7,
    observedSchema: null,
  },
  fullGm: true,
  authoritative: true,
  canonicalId: "missing-canonical-id",
  canonicalState: "unresolved",
  candidates: [
    {
      id: "candidate-journal-id",
      canonical: false,
      createdTime: 1_720_000_000_000,
      modifiedTime: 1_720_000_100_000,
      schemaState: "current",
      observedSchema: 7,
      payloadState: "complete",
      ownershipState: "private",
      eligible: true,
      reason: null,
    },
  ],
  snapshotAvailable: true,
  canMutate: true,
  canRecoverSnapshot: true,
  canCreateEmpty: true,
  blockedReason: "missing-store",
};
app._privateStateRecoveryService = {
  getOverview: () => structuredClone(recoveryOverview),
  previewCandidate: async (id) => {
    recoveryCalls.push(["preview-candidate", id]);
    return {
      token: "candidate-token",
      candidate: { id },
      canonicalId: recoveryOverview.canonicalId,
    };
  },
  applyCandidate: async (payload) => {
    recoveryCalls.push(["apply-candidate", payload]);
    return { ok: true, kind: "candidate", canonicalId: "candidate-journal-id" };
  },
  previewSnapshot: async () => {
    recoveryCalls.push(["preview-snapshot"]);
    return {
      token: "snapshot-token",
      confirmationToken: "snapshot-confirmation",
      sourceId: "verified-source-id",
      canonicalId: recoveryOverview.canonicalId,
    };
  },
  applySnapshot: async (payload) => {
    recoveryCalls.push(["apply-snapshot", payload]);
    return { ok: true, kind: "snapshot", canonicalId: "recovered-store-id" };
  },
  previewEmpty: async () => {
    recoveryCalls.push(["preview-empty"]);
    return {
      token: "empty-token",
      confirmationToken: "empty-confirmation",
      canonicalId: recoveryOverview.canonicalId,
    };
  },
  applyEmpty: async (payload) => {
    recoveryCalls.push(["apply-empty", payload]);
    return { ok: true, kind: "empty", canonicalId: "empty-store-id" };
  },
};
app._privateStateRecoveryInFlight = false;
app._privateStateRecoveryMessage = "";
app._privateStateRecoveryTone = "neutral";
app.render = async () => {};
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
assert.equal(gmContext.privateStateRecovery.open, true);
assert.equal(gmContext.privateStateRecovery.stateLabel, "Recovery needed");
assert.equal(gmContext.privateStateRecovery.statusRole, "alert");
assert.equal(gmContext.privateStateRecovery.canMutate, true);
assert.equal(gmContext.privateStateRecovery.candidates[0].canAdopt, true);
assert.equal(
  gmContext.privateStateRecovery.canonicalStateLabel,
  "Selected store unresolved",
);
assert.equal(
  presentPrivateStateRecoveryOverview({
    status: { state: "blocked", code: "opaque-secret-reason" },
    blockedReason: "opaque-secret-reason",
  }).reason.includes("opaque-secret-reason"),
  false,
  "unknown service reasons never reach Home verbatim",
);
const readyRecovery = presentPrivateStateRecoveryOverview({
  ...recoveryOverview,
  status: { ...recoveryOverview.status, state: "ready", code: "ready" },
  canonicalState: "resolved",
  canRecoverSnapshot: false,
  canCreateEmpty: false,
  blockedReason: null,
});
assert.equal(readyRecovery.open, false);
assert.equal(readyRecovery.statusRole, "status");
assert.equal(readyRecovery.canMutate, false);
assert.equal(
  readyRecovery.candidates[0].canAdopt,
  false,
  "verified campaign data exposes no recovery mutation",
);
assert.match(readyRecovery.reason, /passed its privacy and schema checks/);
const pendingRecovery = presentPrivateStateRecoveryOverview({
  ...recoveryOverview,
  status: {
    ...recoveryOverview.status,
    state: "pending",
    code: "initializing",
  },
  canMutate: false,
});
assert.equal(pendingRecovery.canMutate, false);
assert.match(pendingRecovery.mutationReason, /still being checked/);
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
assert.match(gmHtml, /Campaign data/);
assert.match(gmHtml, /candidate-journal-id/);
assert.match(gmHtml, /Review snapshot recovery/);
assert.match(gmHtml, /Review empty replacement/);
assert.match(gmHtml, /data-campaign-data-recovery open/);
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

const subscribedApp = new InfinityDashboardApp({
  privateStateRecoveryService: app._privateStateRecoveryService,
});
let recoveryRenders = 0;
subscribedApp.rendered = true;
subscribedApp.render = async () => {
  recoveryRenders += 1;
};
const privateStateHook = [...hookListeners.entries()].find(
  ([, entry]) => entry.name === "infinity-dnd5e.privateStateChanged",
);
assert.ok(privateStateHook, "full-GM Home subscribes to private-state changes");
privateStateHook[1].callback({ reason: "recovery-status" });
assert.equal(
  recoveryRenders,
  1,
  "private-state status changes refresh open Home",
);
subscribedApp._onClose();
assert.ok(
  removedHooks.some(
    ([name, id]) =>
      name === "infinity-dnd5e.privateStateChanged" &&
      id === privateStateHook[0],
  ),
  "closing Home removes the private-state listener",
);

recoveryDialogResult = false;
await InfinityDashboardApp._onReviewPrivateStateCandidate.call(app, null, {
  dataset: { candidateId: "candidate-journal-id" },
});
assert.deepEqual(recoveryCalls, [
  ["preview-candidate", "candidate-journal-id"],
]);
assert.match(recoveryDialogOptions.content, /normal migration path/);
assert.match(recoveryDialogOptions.content, /Other Journals remain untouched/);

recoveryDialogResult = true;
await InfinityDashboardApp._onReviewPrivateStateCandidate.call(app, null, {
  dataset: { candidateId: "candidate-journal-id" },
});
assert.deepEqual(recoveryCalls.slice(-2), [
  ["preview-candidate", "candidate-journal-id"],
  ["apply-candidate", { token: "candidate-token" }],
]);

await InfinityDashboardApp._onRecoverPrivateStateSnapshot.call(app);
assert.deepEqual(recoveryCalls.slice(-2), [
  ["preview-snapshot"],
  [
    "apply-snapshot",
    {
      token: "snapshot-token",
      confirmationToken: "snapshot-confirmation",
    },
  ],
]);
assert.match(recoveryDialogOptions.content, /Old Journals remain untouched/);

await InfinityDashboardApp._onCreateEmptyPrivateState.call(app);
assert.deepEqual(recoveryCalls.slice(-2), [
  ["preview-empty"],
  [
    "apply-empty",
    { token: "empty-token", confirmationToken: "empty-confirmation" },
  ],
]);
assert.match(
  recoveryDialogOptions.content,
  /merchant, faction, resource, downtime, and critical-injury data will not be copied/,
);

const applyCandidate = app._privateStateRecoveryService.applyCandidate;
app._privateStateRecoveryService.applyCandidate = async () => {
  const error = new Error("authority changed during readback");
  error.code = "PRIVATE_STATE_RECOVERY_AUTHORITY_CHANGED";
  throw error;
};
await InfinityDashboardApp._onReviewPrivateStateCandidate.call(app, null, {
  dataset: { candidateId: "candidate-journal-id" },
});
app._privateStateRecoveryService.applyCandidate = applyCandidate;
assert.match(notifications.at(-1), /Could not confirm the recovery result/);
assert.doesNotMatch(
  notifications.at(-1),
  /Nothing was changed/,
  "a post-write authority failure is reported as uncertain",
);

const callsBeforeAuthorityLoss = recoveryCalls.length;
recoveryDialogHook = () => {
  users.activeGM = {
    id: "other-full-gm",
    active: true,
    isGM: true,
    role: 4,
  };
};
await InfinityDashboardApp._onReviewPrivateStateCandidate.call(app, null, {
  dataset: { candidateId: "candidate-journal-id" },
});
recoveryDialogHook = null;
users.activeGM = fullGm;
assert.equal(
  recoveryCalls.filter(([name]) => name === "apply-candidate").length,
  1,
  "authority loss while confirmation is open performs no apply",
);
assert.equal(recoveryCalls.length, callsBeforeAuthorityLoss + 1);
assert.match(notifications.at(-1), /Active Game Master control changed/);

const callsBeforeBusy = recoveryCalls.length;
app._privateStateRecoveryInFlight = true;
await InfinityDashboardApp._onCreateEmptyPrivateState.call(app);
app._privateStateRecoveryInFlight = false;
assert.equal(recoveryCalls.length, callsBeforeBusy);
assert.match(notifications.at(-1), /already being checked/);

const secondaryFullGm = {
  id: "secondary-full-gm",
  active: true,
  isGM: true,
  role: 4,
};
globalThis.game.user = secondaryFullGm;
recoveryOverview = {
  ...recoveryOverview,
  authoritative: false,
  canMutate: false,
  canRecoverSnapshot: false,
  canCreateEmpty: false,
};
const secondaryContext = await app._prepareContext();
assert.equal(secondaryContext.isFullGm, true);
assert.equal(secondaryContext.privateStateRecovery.canMutate, false);
assert.equal(
  secondaryContext.privateStateRecovery.candidates[0].canAdopt,
  false,
);
const secondaryHtml = renderHome(secondaryContext);
assert.match(secondaryHtml, /candidate-journal-id/);
assert.match(secondaryHtml, /active Game Master must confirm/);
assert.equal(
  secondaryContext.privateStateRecovery.snapshotReason,
  "Only the active Game Master can change campaign data.",
);
assert.match(
  secondaryHtml,
  /data-action="reviewPrivateStateCandidate"[\s\S]*?disabled/,
);

globalThis.game.user = fullGm;
recoveryOverview = {
  ...recoveryOverview,
  authoritative: true,
  canMutate: true,
  canRecoverSnapshot: true,
  canCreateEmpty: true,
};

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

const focusedSessionAction = resolveSessionFocus(playerActions, [
  playerActions.find((action) => action.surface === "shops"),
]);
assert.equal(
  focusedSessionAction.title,
  "Shops",
  "Home foregrounds a recent role-safe destination",
);
assert.match(focusedSessionAction.label, /^Continue with /);
assert.equal(
  resolveSessionFocus([], []),
  null,
  "Home leaves the focus card out when no destination is available",
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
assert.equal(assistantContext.privateStateRecovery, null);
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
  /Merchant Workspace|Per-Encounter Loot|candidate-journal-id|Campaign data/,
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
