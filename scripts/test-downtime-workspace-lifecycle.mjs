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
    normalizeActorSelectorState,
    normalizeDowntimeActors,
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

  const selectorActors = [
    {
      id: "borin",
      name: "Borin 10",
      img: "borin.webp",
      checked: true,
      playerOwned: true,
      control: "player-owned",
      owners: [
        {
          id: "owner-zara",
          name: "Zara",
          active: true,
          assigned: false,
        },
      ],
      folderId: "folder-zulu",
      folderName: "Zulu Lodge",
    },
    {
      id: "aria",
      name: "Aria 2",
      img: "aria.webp",
      checked: true,
      playerOwned: true,
      control: "player-owned",
      assigned: true,
      owners: [
        {
          id: "owner-ada",
          name: "Ada",
          active: false,
          assigned: true,
        },
      ],
      folderId: "folder-alpha",
      folderName: "Alpha Lodge",
    },
    {
      id: "elodie",
      name: "Élodie",
      img: "elodie.webp",
      checked: false,
      playerOwned: false,
      control: "other-character",
      owners: [],
      folderId: "folder-zulu",
      folderName: "Zulu Lodge",
    },
    {
      id: "cass",
      name: "Cass",
      img: "cass.webp",
      checked: false,
      playerOwned: false,
      control: "other-character",
      owners: [],
      folderId: "",
      folderName: "No folder",
    },
  ];

  const defaultSelector = normalizeDowntimeActors(selectorActors);
  assert.deepEqual(
    selectedIds(defaultSelector),
    ["aria", "borin"],
    "only player-controlled PCs start selected",
  );
  assert.deepEqual(
    visibleIds(defaultSelector),
    ["aria", "borin"],
    "the initial scope shows the concise player-controlled group",
  );
  assert.equal(defaultSelector.selector.playerOwnedCount, 2);
  assert.equal(defaultSelector.selector.otherCount, 2);
  assert.equal(defaultSelector.selector.selectedCount, 2);
  assert.equal(defaultSelector.selector.hasUnowned, true);
  assert.equal(defaultSelector.selector.hasUnfiled, true);
  assert.deepEqual(
    defaultSelector.selector.ownerOptions.map((owner) => owner.id),
    ["owner-ada", "owner-zara"],
  );
  assert.deepEqual(
    defaultSelector.selector.folderOptions.map((folder) => folder.id),
    ["folder-alpha", "folder-zulu"],
  );

  const scopeExpectations = {
    "player-owned": ["aria", "borin"],
    other: ["cass", "elodie"],
    selected: ["borin", "cass"],
    all: ["aria", "borin", "cass", "elodie"],
  };
  for (const [scope, expected] of Object.entries(scopeExpectations)) {
    const selectedActorIds =
      scope === "selected" ? new Set(["cass", "borin"]) : undefined;
    assert.deepEqual(
      visibleIds(
        normalizeDowntimeActors(selectorActors, { scope, selectedActorIds }),
      ),
      expected,
      `${scope} exposes only its requested Actor group`,
    );
  }

  const queryByName = normalizeDowntimeActors(selectorActors, {
    scope: "all",
    query: "elodie",
  });
  assert.deepEqual(
    visibleIds(queryByName),
    ["elodie"],
    "Actor search is case- and accent-insensitive",
  );
  assert.deepEqual(
    visibleIds(
      normalizeDowntimeActors(selectorActors, {
        scope: "all",
        query: "zara",
      }),
    ),
    ["borin"],
    "Actor search includes owner names",
  );
  assert.deepEqual(
    visibleIds(
      normalizeDowntimeActors(selectorActors, {
        scope: "all",
        query: "alpha lodge",
      }),
    ),
    ["aria"],
    "Actor search includes folder names",
  );
  assert.deepEqual(
    visibleIds(
      normalizeDowntimeActors(selectorActors, {
        scope: "all",
        ownerId: "owner-ada",
      }),
    ),
    ["aria"],
    "the owner filter matches canonical owner IDs",
  );
  assert.deepEqual(
    visibleIds(
      normalizeDowntimeActors(selectorActors, {
        scope: "all",
        ownerId: "unowned",
      }),
    ),
    ["cass", "elodie"],
    "the unowned filter isolates optional PCs",
  );
  assert.deepEqual(
    visibleIds(
      normalizeDowntimeActors(selectorActors, {
        scope: "all",
        folderId: "folder-zulu",
      }),
    ),
    ["borin", "elodie"],
    "the folder filter uses canonical Folder IDs",
  );
  assert.deepEqual(
    visibleIds(
      normalizeDowntimeActors(selectorActors, {
        scope: "all",
        folderId: "unfiled",
      }),
    ),
    ["cass"],
    "the unfiled filter remains distinct from a named folder",
  );
  const staleFilters = normalizeDowntimeActors(selectorActors, {
    scope: "all",
    ownerId: "deleted-owner",
    folderId: "deleted-folder",
  });
  assert.equal(staleFilters.selector.ownerId, "all");
  assert.equal(staleFilters.selector.folderId, "all");
  assert.deepEqual(visibleIds(staleFilters), [
    "aria",
    "borin",
    "cass",
    "elodie",
  ]);

  const explicitSelection = new Set(["borin", "cass"]);
  const filteredSelection = normalizeDowntimeActors(selectorActors, {
    scope: "all",
    query: "zara",
    selectedActorIds: explicitSelection,
  });
  assert.deepEqual(visibleIds(filteredSelection), ["borin"]);
  assert.deepEqual(
    selectedIds(filteredSelection),
    ["borin", "cass"],
    "filtering never clears a selected Actor that is temporarily hidden",
  );
  const selectionAfterRerender = normalizeDowntimeActors(selectorActors, {
    scope: "all",
    selectedActorIds: new Set(selectedIds(filteredSelection)),
  });
  assert.deepEqual(
    selectedIds(selectionAfterRerender),
    ["borin", "cass"],
    "an explicit selection overrides projection defaults across rerenders",
  );

  const seededSelectorApp = {
    _actorSelectorState: { selectedActorIds: null },
  };
  DowntimeWorkspaceApp.prototype._reconcileActorSelector.call(
    seededSelectorApp,
    defaultSelector.actors,
  );
  assert.deepEqual(
    [...seededSelectorApp._actorSelectorState.selectedActorIds].sort(),
    ["aria", "borin"],
    "the first canonical read seeds the in-memory selection from PC defaults",
  );
  seededSelectorApp._actorSelectorState.selectedActorIds.add("deleted-actor");
  seededSelectorApp._actorSelectorState.selectedActorIds.add("cass");
  DowntimeWorkspaceApp.prototype._reconcileActorSelector.call(
    seededSelectorApp,
    defaultSelector.actors.filter((actor) => actor.id !== "cass"),
  );
  assert.deepEqual(
    [...seededSelectorApp._actorSelectorState.selectedActorIds].sort(),
    ["aria", "borin"],
    "a rerender retains valid selections and drops only Actors no longer available",
  );

  const projectionApp = ({
    selectedActorIds = null,
    ownerId = "all",
    folderId = "all",
    readProjection,
  }) => ({
    _adapter: { getWorkspaceProjection: readProjection },
    _view: "current",
    _selectedSettlementId: null,
    _creatingSettlement: false,
    _newBlockMode: false,
    _busy: false,
    _statusMessage: "",
    _errorMessage: "",
    _projectionErrorMessage: "",
    _actorSelectorState: {
      scope: "all",
      query: "",
      ownerId,
      folderId,
      sort: "name-asc",
      selectedActorIds,
    },
    _adoptActorSelectorProjection:
      DowntimeWorkspaceApp.prototype._adoptActorSelectorProjection,
    _reconcileActorSelector:
      DowntimeWorkspaceApp.prototype._reconcileActorSelector,
  });
  const savedConsoleError = console.error;
  const unavailableApp = projectionApp({
    readProjection: async () => {
      throw new Error("temporary projection failure");
    },
  });
  let unavailable;
  try {
    console.error = () => {};
    unavailable =
      await DowntimeWorkspaceApp.prototype._prepareContext.call(unavailableApp);
    assert.equal(unavailable.dataAvailable, false);
  } finally {
    console.error = savedConsoleError;
  }
  assert.equal(
    unavailableApp._actorSelectorState.selectedActorIds,
    null,
    "a temporary projection failure does not replace uninitialized PC defaults with an empty selection",
  );
  unavailableApp.element = {
    querySelector() {
      assert.fail(
        "an unavailable render must not bind an empty actor selector",
      );
    },
  };
  DowntimeWorkspaceApp.prototype._bindActorSelector.call(
    unavailableApp,
    unavailable,
  );
  assert.equal(
    unavailableApp._actorSelectorState.selectedActorIds,
    null,
    "the unavailable render lifecycle preserves uninitialized PC defaults",
  );
  unavailableApp._adapter.getWorkspaceProjection = async () => ({
    actors: selectorActors,
    canCreateBlock: true,
  });
  const recoveredProjection =
    await DowntimeWorkspaceApp.prototype._prepareContext.call(unavailableApp);
  assert.deepEqual(
    recoveredProjection.actors
      .filter((actor) => actor.checked)
      .map((actor) => actor.id)
      .sort(),
    ["aria", "borin"],
    "player-owned defaults recover after a temporary projection failure",
  );

  const retainedSelection = new Set(["borin"]);
  const selectedErrorApp = projectionApp({
    selectedActorIds: retainedSelection,
    readProjection: async () => {
      throw new Error("temporary projection failure");
    },
  });
  try {
    console.error = () => {};
    await DowntimeWorkspaceApp.prototype._prepareContext.call(selectedErrorApp);
  } finally {
    console.error = savedConsoleError;
  }
  assert.deepEqual(
    [...selectedErrorApp._actorSelectorState.selectedActorIds],
    ["borin"],
    "a temporary projection failure preserves an explicit selection",
  );

  const emptyActorApp = {
    _actorSelectorState: {
      scope: "player-owned",
      query: "",
      ownerId: "all",
      folderId: "all",
      sort: "name-asc",
      selectedActorIds: null,
    },
  };
  DowntimeWorkspaceApp.prototype._reconcileActorSelector.call(
    emptyActorApp,
    [],
  );
  DowntimeWorkspaceApp.prototype._bindActorSelector.call(emptyActorApp, {
    dataAvailable: true,
    hasActors: false,
  });
  assert.equal(
    emptyActorApp._actorSelectorState.selectedActorIds,
    null,
    "an empty world keeps the selector ready to default-select a newly added player-owned PC",
  );
  assert.deepEqual(
    selectedIds(
      normalizeDowntimeActors(
        selectorActors,
        emptyActorApp._actorSelectorState,
      ),
    ),
    ["aria", "borin"],
    "new player-owned PCs receive defaults after an empty-world refresh",
  );

  const staleProjectionApp = projectionApp({
    selectedActorIds: new Set(["borin"]),
    ownerId: "deleted-owner",
    folderId: "deleted-folder",
    readProjection: async () => ({
      actors: selectorActors,
      canCreateBlock: true,
    }),
  });
  const repairedProjection =
    await DowntimeWorkspaceApp.prototype._prepareContext.call(
      staleProjectionApp,
    );
  assert.equal(repairedProjection.actorSelector.ownerId, "all");
  assert.equal(repairedProjection.actorSelector.folderId, "all");
  assert.equal(staleProjectionApp._actorSelectorState.ownerId, "all");
  assert.equal(staleProjectionApp._actorSelectorState.folderId, "all");
  assert.deepEqual(
    repairedProjection.actors
      .filter((actor) => actor.visible)
      .map((actor) => actor.id),
    ["aria", "borin", "cass", "elodie"],
    "deleted owner and folder filters fall back to all without hiding the character list on rerender",
  );

  const busySelectorApp = {
    _busy: true,
    _actorSelectorState: { scope: "player-owned" },
  };
  for (const action of [
    "setActorScope",
    "selectShownActors",
    "clearShownActors",
    "restoreActorDefaults",
  ]) {
    DowntimeWorkspaceApp.DEFAULT_OPTIONS.actions[action].call(
      busySelectorApp,
      null,
      { dataset: { actorScope: "all" } },
    );
  }
  assert.equal(
    busySelectorApp._actorSelectorState.scope,
    "player-owned",
    "selector actions cannot change the displayed selection while a command is busy",
  );

  const sortExpectations = {
    "name-asc": ["aria", "borin", "cass", "elodie"],
    "name-desc": ["elodie", "cass", "borin", "aria"],
    owner: ["aria", "cass", "elodie", "borin"],
    folder: ["aria", "cass", "borin", "elodie"],
    "selected-first": ["aria", "borin", "cass", "elodie"],
  };
  for (const [sort, expected] of Object.entries(sortExpectations)) {
    assert.deepEqual(
      normalizeDowntimeActors(selectorActors, {
        scope: "all",
        sort,
      }).actors.map((actor) => actor.id),
      expected,
      `${sort} produces a deterministic Actor order`,
    );
  }
  assert.deepEqual(
    normalizeActorSelectorState({
      scope: "unsafe-scope",
      sort: "unsafe-sort",
      selectedActorIds: [" aria ", "", "cass"],
    }),
    {
      scope: "player-owned",
      query: "",
      ownerId: "all",
      folderId: "all",
      sort: "name-asc",
      selectedActorIds: new Set(["aria", "cass"]),
    },
    "malformed selector controls normalize without widening the default scope",
  );

  const savedFormData = globalThis.FormData;
  let createPayload = null;
  try {
    globalThis.FormData = class {
      constructor(form) {
        this.form = form;
      }

      get(field) {
        return this.form.fields[field] ?? null;
      }
    };
    const checkedInputsInVisibleOrder = [
      { value: "cass", dataset: { actorOrder: "3" } },
      { value: "borin", dataset: { actorOrder: "0" } },
      { value: "", dataset: { actorOrder: "4" } },
      { value: "aria", dataset: { actorOrder: "1" } },
    ];
    const newBlockForm = {
      fields: {
        settlementId: "haven",
        locationName: "Ignored when settled",
        hours: "16",
      },
      querySelectorAll: (selector) => {
        assert.equal(selector, 'input[name="actorIds"]:checked');
        return checkedInputsInVisibleOrder;
      },
    };
    const createApp = {
      element: {
        querySelector: (selector) =>
          selector === '[data-form="new-block"]' ? newBlockForm : null,
      },
      _newBlockMode: true,
      _actorSelectorState: {},
      rendered: false,
      async _runCommand(method, payload) {
        assert.equal(method, "createBlock");
        createPayload = payload;
        return { id: "created-block" };
      },
    };
    await DowntimeWorkspaceApp.DEFAULT_OPTIONS.actions.createBlock.call(
      createApp,
    );
  } finally {
    if (savedFormData === undefined) delete globalThis.FormData;
    else globalThis.FormData = savedFormData;
  }
  assert.deepEqual(
    createPayload,
    {
      settlementId: "haven",
      locationName: "Ignored when settled",
      hours: 16,
      mode: "guided",
      templateIds: [],
      projectIds: [],
      actorIds: ["borin", "aria", "cass"],
    },
    "visual sorting never changes the canonical Actor order submitted to the service",
  );

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
  assert.match(idleHtml, /Restore this guide from Infinity Settings/);
  assert.match(idleHtml, /data-step-state="current"[^>]+aria-current="step"/);
  assert.match(idleHtml, /data-step-state="pending"/);
  assert.match(template(locked), /data-step-state="completed"/);
  assert.match(template(recovering), /data-step-state="interrupted"/);

  const usedActions = new Set(
    [
      ...`${readFileSync("templates/gm-workbench-nav.hbs", "utf8")}\n${templateSource}`.matchAll(
        /\bdata-action="([^"]+)"/g,
      ),
    ].map((match) => match[1]),
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
  assert.match(dismissingApp._statusMessage, /Infinity Settings/);
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

function selectedIds(projection) {
  return projection.actors
    .filter((actor) => actor.checked)
    .map((actor) => actor.id);
}

function visibleIds(projection) {
  return projection.actors
    .filter((actor) => actor.visible)
    .map((actor) => actor.id);
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
