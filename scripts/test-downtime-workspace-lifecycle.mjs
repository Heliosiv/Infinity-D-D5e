import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import Handlebars from "handlebars";

const savedFoundry = globalThis.foundry;
const savedGame = globalThis.game;

try {
  globalThis.foundry = {
    applications: {
      api: {
        ApplicationV2: class {},
        HandlebarsApplicationMixin: (Base) => class extends Base {},
      },
    },
  };

  const {
    DOWNTIME_WORKSPACE_QUICK_START_ID,
    DowntimeWorkspaceApp,
    buildDowntimeLifecycle,
    normalizeWorkspaceProjection,
  } = await import("./downtime-workspace.js");
  const templateSource = readFileSync(
    "templates/downtime-workspace.hbs",
    "utf8",
  );
  const template = Handlebars.compile(templateSource);
  const workspaceFor = (status, workflow = {}) =>
    normalizeWorkspaceProjection(
      {
        workflow: {
          id: `block-${status}`,
          status,
          hours: 8,
          ...workflow,
        },
      },
      { view: "current" },
    );

  const idle = normalizeWorkspaceProjection(
    {
      actors: [{ id: "ada", name: "Ada" }],
      canCreateBlock: true,
    },
    { view: "current" },
  );
  assertLifecycle(idle, {
    states: ["current", "pending", "pending", "pending", "pending", "pending"],
    primaryAction: "createBlock",
  });

  const collecting = workspaceFor("collecting", {
    participants: [participant({ submitted: false })],
  });
  assertLifecycle(collecting, {
    states: [
      "completed",
      "current",
      "pending",
      "pending",
      "pending",
      "pending",
    ],
    primaryAction: "openForPlayers",
  });

  const readyToLock = workspaceFor("collecting", {
    participants: [participant({ submitted: true })],
  });
  assert.equal(readyToLock.primaryAction.id, "lockBlock");

  const locked = workspaceFor("locked");
  assertLifecycle(locked, {
    states: [
      "completed",
      "completed",
      "current",
      "pending",
      "pending",
      "pending",
    ],
    primaryAction: "planBlock",
  });

  const planned = workspaceFor("planned", {
    plan: { id: "plan-1", characters: [] },
  });
  assertLifecycle(planned, {
    states: [
      "completed",
      "completed",
      "completed",
      "current",
      "pending",
      "pending",
    ],
    primaryAction: "applyBlock",
  });

  const applyDenied = workspaceFor("planned", {
    canApply: false,
    applyReason: "The canonical preview is unavailable.",
  });
  assert.equal(
    applyDenied.primaryAction.hasAction,
    false,
    "presentation must not promote an action denied by the authoritative projection",
  );

  const applying = workspaceFor("applying");
  assertLifecycle(applying, {
    states: [
      "completed",
      "completed",
      "completed",
      "completed",
      "current",
      "pending",
    ],
    primaryAction: "",
  });
  assert.match(applying.primaryAction.description, /authoritative result/i);

  const recovering = normalizeWorkspaceProjection(
    {
      workflow: {
        id: "block-recovery",
        status: "needs-review",
        participants: [participant({ submitted: true })],
      },
      recovery: {
        available: true,
        message: "An interrupted application must be verified.",
      },
    },
    { view: "current" },
  );
  assert.deepEqual(
    recovering.lifecycleSteps.map((step) => step.state),
    [
      "completed",
      "completed",
      "completed",
      "completed",
      "interrupted",
      "pending",
    ],
  );
  assert.equal(recovering.lifecycleRecovery.state, "current");
  assert.equal(recovering.primaryAction.id, "recoverBlock");

  const completed = workspaceFor("completed");
  assertLifecycle(completed, {
    states: Array(6).fill("completed"),
    primaryAction: "beginNextBlock",
  });

  for (const context of [
    idle,
    collecting,
    readyToLock,
    locked,
    planned,
    recovering,
    completed,
  ]) {
    const html = template(context);
    assert.equal(
      html.match(/\bdt-button--next\b/g)?.length ?? 0,
      1,
      `${context.workflowStatus} should render exactly one emphasized next action`,
    );
  }
  assert.equal(
    template(applying).match(/\bdt-button--next\b/g)?.length ?? 0,
    0,
    "an in-progress authoritative Apply must not promote another action",
  );
  assert.equal(
    template(applyDenied).match(/\bdt-button--next\b/g)?.length ?? 0,
    0,
    "a denied action must remain secondary and disabled",
  );

  const idleHtml = template({ ...idle, showQuickStart: true });
  assertInOrder(
    idleHtml,
    ">Create<",
    ">Collect<",
    ">Lock<",
    ">Preview<",
    ">Apply<",
    ">Complete<",
  );
  assert.match(idleHtml, /<aside[^>]+data-step="recovery"/);
  assert.equal(
    idleHtml.match(/\bdt-lifecycle__arrow\b/g)?.length ?? 0,
    5,
    "the six-step lifecycle should show five directional connectors",
  );
  assert.match(idleHtml, /data-action="dismissQuickStart"/);
  assert.match(
    idleHtml,
    /Restore this guide from Help (?:&|&amp;) Diagnostics/,
  );
  assert.match(idleHtml, /data-step-state="current"[^>]+aria-current="step"/);
  assert.match(idleHtml, /data-step-state="pending"/);
  assert.match(template(locked), /data-step-state="completed"/);
  assert.match(template(recovering), /data-step-state="interrupted"/);

  const usedActions = new Set(
    [...templateSource.matchAll(/\bdata-action="([^"]+)"/g)].map(
      (match) => match[1],
    ),
  );
  assert.deepEqual(
    [...usedActions].sort(),
    Object.keys(DowntimeWorkspaceApp.DEFAULT_OPTIONS.actions).sort(),
    "the lifecycle presentation must preserve every existing ApplicationV2 action binding",
  );

  const css = readFileSync("styles/downtime.css", "utf8");
  assert.match(css, /container:\s*downtime-workspace\s*\/\s*inline-size/);
  assert.match(css, /@container downtime-workspace \(max-width: 820px\)/);
  assert.match(css, /@container downtime-workspace \(max-width: 620px\)/);
  assert.match(css, /@media \(forced-colors: active\)/);

  const standaloneRecovery = buildDowntimeLifecycle({
    status: "needs-review",
    needsRecovery: true,
    recoveryMessage: "Verify the checkpoint.",
  });
  assert.equal(
    standaloneRecovery.recovery.description,
    "Verify the checkpoint.",
  );
  assert.equal(standaloneRecovery.primaryAction.id, "recoverBlock");

  let storedPreferences = {
    version: 1,
    density: "comfortable",
    lastLootStudioMode: "encounter",
    dismissedQuickStarts: [],
    advancedDisclosures: {},
  };
  globalThis.game = {
    settings: {
      get: () => storedPreferences,
      set: async (_moduleId, _settingKey, value) => {
        storedPreferences = value;
        return value;
      },
    },
  };
  const dismissingApp = {
    _statusMessage: "",
    _pendingFocus: null,
    rendered: false,
  };
  await DowntimeWorkspaceApp.DEFAULT_OPTIONS.actions.dismissQuickStart.call(
    dismissingApp,
  );
  assert.deepEqual(storedPreferences.dismissedQuickStarts, [
    DOWNTIME_WORKSPACE_QUICK_START_ID,
  ]);
  assert.match(dismissingApp._statusMessage, /Help & Diagnostics/);
  assert.equal(dismissingApp._pendingFocus, '[data-action="refresh"]');
  const dismissedContext =
    await DowntimeWorkspaceApp.prototype._prepareContext.call({
      _adapter: {
        getWorkspaceProjection: async () => ({
          actors: [{ id: "ada", name: "Ada" }],
          canCreateBlock: true,
        }),
      },
      _view: "current",
      _selectedSettlementId: null,
      _creatingSettlement: false,
      _newBlockMode: false,
      _busy: false,
      _statusMessage: "",
      _errorMessage: "",
      _projectionErrorMessage: "",
      _activeBlockId: "",
    });
  assert.equal(
    dismissedContext.showQuickStart,
    false,
    "the guide dismissal must remain client-only and survive a workspace rerender",
  );

  process.stdout.write("downtime workspace lifecycle validation passed\n");
} finally {
  if (savedFoundry === undefined) delete globalThis.foundry;
  else globalThis.foundry = savedFoundry;
  if (savedGame === undefined) delete globalThis.game;
  else globalThis.game = savedGame;
}

function participant(overrides = {}) {
  return {
    actorId: "ada",
    name: "Ada",
    budgetHours: 8,
    queue: [],
    ...overrides,
  };
}

function assertLifecycle(context, { states, primaryAction }) {
  assert.deepEqual(
    context.lifecycleSteps.map((step) => step.state),
    states,
  );
  assert.equal(context.primaryAction.id, primaryAction);
  assert.equal(
    Object.entries(context.primaryAction)
      .filter(([key]) =>
        [
          "createBlock",
          "openForPlayers",
          "lockBlock",
          "planBlock",
          "applyBlock",
          "recoverBlock",
          "beginNextBlock",
        ].includes(key),
      )
      .filter(([, enabled]) => enabled).length,
    primaryAction ? 1 : 0,
    "only one primary action flag may be active",
  );
}

function assertInOrder(source, ...needles) {
  let previous = -1;
  for (const needle of needles) {
    const current = source.indexOf(needle);
    assert.ok(
      current > previous,
      `${needle} should follow the prior lifecycle step`,
    );
    previous = current;
  }
}
