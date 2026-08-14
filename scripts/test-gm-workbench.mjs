import assert from "node:assert/strict";

import {
  buildGmWorkbenchNavigationContext,
  GM_WORKBENCH_ROUTES,
  normalizeGmWorkbenchTarget,
  sanitizeGmWorkbenchEntityId,
  sanitizeGmWorkbenchRoute,
  sanitizeGmWorkbenchSubView,
} from "./gm-workbench-routes.js";

assert.deepEqual(GM_WORKBENCH_ROUTES, [
  "merchants",
  "quartermaster",
  "downtime",
  "factions",
  "injuries",
]);
assert.equal(sanitizeGmWorkbenchRoute("factions"), "factions");
assert.equal(sanitizeGmWorkbenchRoute("private-state"), "merchants");
assert.equal(sanitizeGmWorkbenchSubView("downtime", "history"), "history");
assert.equal(sanitizeGmWorkbenchSubView("downtime", "secrets"), "");
assert.equal(
  sanitizeGmWorkbenchEntityId("faction:church.last-light"),
  "faction:church.last-light",
);
assert.equal(sanitizeGmWorkbenchEntityId("<script>"), "");
assert.deepEqual(
  normalizeGmWorkbenchTarget({
    route: "downtime",
    subview: "projects",
    entityId: "project:keep",
    actorIds: ["private-actor"],
    hiddenState: { campaign: true },
  }),
  {
    route: "downtime",
    subview: "projects",
    entityId: "project:keep",
  },
  "the public route contract drops private and unknown fields",
);

const context = buildGmWorkbenchNavigationContext({ route: "injuries" });
assert.equal(context.route, "injuries");
assert.equal(context.routes.length, 5);
assert.equal(context.routes.filter((route) => route.active).length, 1);
assert.equal(context.routes.find((route) => route.active)?.route, "injuries");
assert.deepEqual(
  context.utilities.map((utility) => utility.utility),
  ["loot-studio", "settings"],
  "the Workbench chrome includes every focused GM utility displaced from Home",
);

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
globalThis.CONST = { USER_ROLES: { GAMEMASTER: 4 } };

let storedPreferences = {
  version: 2,
  density: "comfortable",
  lastLootStudioMode: "encounter",
  lastGmWorkbenchRoute: "merchants",
  dismissedQuickStarts: [],
  advancedDisclosures: {},
};
globalThis.game = {
  user: { id: "gm", isGM: true, role: 4 },
  settings: {
    get: () => storedPreferences,
    async set(_moduleId, _key, value) {
      storedPreferences = value;
    },
  },
};
const warnings = [];
globalThis.ui = {
  notifications: {
    warn: (message) => warnings.push(message),
    error: (message) => warnings.push(message),
  },
};

const {
  configureGmWorkbench,
  GmWorkbenchApp,
  getActiveGmWorkbenchApplication,
  openGmWorkbench,
} = await import("./gm-workbench.js");

const opened = [];
const utilityCalls = [];
function routeAdapter(route) {
  return {
    open(options) {
      const app = {
        route,
        openOptions: options,
        rendered: true,
        position: { left: 120, top: 80, width: 900, height: 700 },
        targets: [],
        renderCalls: [],
        closeCalls: 0,
        bringCalls: 0,
        setPositionCalls: [],
        setWorkbenchTarget(target) {
          this.target = target;
          this.targets.push(target);
        },
        captureWorkbenchTarget() {
          return this.target ?? { route };
        },
        render(force) {
          this.renderCalls.push(force);
        },
        bringToFront() {
          this.bringCalls += 1;
        },
        close() {
          this.closeCalls += 1;
          this.rendered = false;
          return Promise.resolve();
        },
        setPosition(position) {
          this.setPositionCalls.push(position);
        },
      };
      app.setWorkbenchTarget(options.workbench);
      opened.push(app);
      return app;
    },
  };
}

assert.equal(
  configureGmWorkbench(
    Object.fromEntries(
      GM_WORKBENCH_ROUTES.map((route) => [route, routeAdapter(route)]),
    ),
    {
      "loot-studio": { open: () => utilityCalls.push("loot-studio") },
      settings: { open: () => utilityCalls.push("settings") },
    },
  ),
  5,
);

await GmWorkbenchApp._onOpenUtility.call(
  {},
  { preventDefault() {} },
  { dataset: { workbenchUtility: "loot-studio" } },
);
assert.deepEqual(utilityCalls, ["loot-studio"]);
await GmWorkbenchApp._onOpenUtility.call(
  {},
  { preventDefault() {} },
  { dataset: { workbenchUtility: "private-state" } },
);
assert.match(warnings.at(-1), /not available/);

const factions = openGmWorkbench({
  route: "factions",
  subview: "visibility",
  entityId: "faction:one",
});
assert.equal(factions.route, "factions");
assert.deepEqual(factions.target, {
  route: "factions",
  subview: "visibility",
  entityId: "faction:one",
});
assert.equal(getActiveGmWorkbenchApplication(), factions);

const focused = openGmWorkbench({ route: "factions", entityId: "faction:two" });
assert.equal(
  focused,
  factions,
  "opening the active route focuses one instance",
);
assert.equal(factions.target.entityId, "faction:two");
assert.deepEqual(factions.renderCalls, [false]);
assert.equal(factions.bringCalls, 1);

const downtime = openGmWorkbench({ route: "downtime", subview: "history" });
assert.equal(
  factions.closeCalls,
  1,
  "switching routes closes the prior surface",
);
assert.equal(
  factions._gmWorkbenchSwitching,
  true,
  "the prior route rejects delayed rerenders while it closes",
);
assert.equal(downtime.route, "downtime");
assert.deepEqual(downtime.openOptions.position, {
  left: 120,
  top: 80,
  width: 900,
  height: 700,
});
assert.deepEqual(
  downtime.setPositionCalls,
  [],
  "an unrendered ApplicationV2 receives its initial position through options",
);

const fallback = openGmWorkbench({ route: "private-state" });
assert.equal(
  fallback.route,
  "merchants",
  "invalid routes fail to the first route",
);

globalThis.game.user = { id: "assistant", isGM: true, role: 3 };
assert.equal(openGmWorkbench({ route: "injuries" }), null);
assert.match(warnings.at(-1), /full Game Masters only/);

delete globalThis.foundry;
delete globalThis.CONST;
delete globalThis.game;
delete globalThis.ui;

console.log("GM Workbench route and lifecycle validation passed");
