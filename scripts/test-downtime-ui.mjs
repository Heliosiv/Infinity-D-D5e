import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import Handlebars from "handlebars";

const savedFoundry = globalThis.foundry;

try {
  globalThis.foundry = {
    applications: {
      api: {
        ApplicationV2: class {},
        HandlebarsApplicationMixin: (Base) => class extends Base {},
      },
    },
  };

  const workspaceModule = await import("./downtime-workspace.js");
  const activitiesModule = await import("./downtime-activities.js");

  {
    const hours = {
      name: "hours",
      value: "16",
      options: [{ value: "8" }, { value: "16" }],
    };
    const skill = {
      name: "skill",
      value: "arc",
      options: [{ value: "arc" }, { value: "ins" }],
    };
    const card = { querySelectorAll: () => [hours, skill] };
    const draft = activitiesModule.readAllowedActivityInputs(card);
    hours.value = "8";
    skill.value = "ins";
    activitiesModule.restoreActivityInputDraft(card, draft);
    assert.equal(
      hours.value,
      "16",
      "refresh preserves unsubmitted allocation hours",
    );
    assert.equal(skill.value, "arc", "refresh preserves unsubmitted skill");
    hours.options = [{ value: "8" }];
    hours.value = "8";
    activitiesModule.restoreActivityInputDraft(card, draft);
    assert.equal(hours.value, "8", "a removed choice is not restored");
  }

  {
    const option = { value: "spell", dataset: {}, disabled: false };
    const select = {
      value: "spell",
      options: [option],
      selectedOptions: [option],
    };
    const detail = { textContent: "old quote" };
    const cost = { textContent: "old cost" };
    const button = { disabled: false };
    const nodes = {
      '[name="targetId"]': select,
      '[name="hours"]': { value: "16" },
      "[data-target-detail]": detail,
      ".dt-activity-card__cost": cost,
      '[data-action="addActivity"]': button,
    };
    activitiesModule.updateActivityCardSummary(
      { querySelector: (key) => nodes[key] },
      null,
      [
        {
          hours: 16,
          available: false,
          costLabel: "16-hour cost",
          targets: [
            {
              id: "spell",
              label: "Spell: 16-hour cost",
              detail: "16-hour materials",
              disabled: true,
            },
          ],
        },
      ],
    );
    assert.equal(cost.textContent, "16-hour cost");
    assert.equal(detail.textContent, "16-hour materials");
    assert.equal(option.textContent, "Spell: 16-hour cost");
    assert.equal(
      button.disabled,
      true,
      "selected allocation affordability controls submission",
    );
    activitiesModule.updateActivityCardSummary(
      { querySelector: (key) => nodes[key] },
      null,
      [{ hours: 16, available: true, costLabel: "ready", targets: [] }],
      true,
    );
    assert.equal(
      button.disabled,
      true,
      "quote refresh cannot re-enable an allocation while a command is busy",
    );
  }

  const cancelledCommand = {
    _busy: false,
    rendered: false,
    _errorMessage: "",
    _statusMessage: "",
    _adapter: {
      submitQueue: async () => {
        const error = new Error("Cancelled");
        error.code = "DOWNTIME_ROLL_CANCELLED";
        throw error;
      },
    },
  };
  await activitiesModule.DowntimeActivitiesApp.prototype._runCommand.call(
    cancelledCommand,
    "submitQueue",
  );
  assert.equal(cancelledCommand._busy, false);
  assert.equal(cancelledCommand._errorMessage, "");
  assert.match(cancelledCommand._statusMessage, /Roll cancelled/);
  assert.equal(cancelledCommand._pendingFocus, '[data-action="submitQueue"]');

  {
    const originalFrame = globalThis.requestAnimationFrame;
    let frame;
    let focused = false;
    const openingButton = {};
    const editedField = {};
    const root = {
      ownerDocument: { activeElement: openingButton },
      contains: (node) => node === editedField,
      querySelector: () => ({
        focus() {
          focused = true;
        },
      }),
    };
    globalThis.requestAnimationFrame = (callback) => {
      frame = callback;
    };
    workspaceModule.DowntimeWorkspaceApp.prototype._restoreFocus.call({
      element: root,
      _pendingFocus: "input",
    });
    root.ownerDocument.activeElement = editedField;
    frame();
    assert.equal(
      focused,
      false,
      "deferred form focus cannot steal typing from another field",
    );
    root.ownerDocument.activeElement = openingButton;
    workspaceModule.DowntimeWorkspaceApp.prototype._restoreFocus.call({
      element: root,
      _pendingFocus: "input",
    });
    frame();
    assert.equal(
      focused,
      true,
      "the intended field receives focus when the user has not moved it",
    );
    globalThis.requestAnimationFrame = originalFrame;
  }

  const workspace = workspaceModule.normalizeWorkspaceProjection(
    {
      settlements: [
        {
          id: "haven",
          name: "Haven",
          wealthTier: "prosperous",
          securityTier: "high",
          linkedFactionId: "watch",
          linkedMerchantIds: ["smith"],
          enabledActivityIds: ["craft-ammunition", "market-trading"],
        },
        {
          id: "quiet-hamlet",
          name: "Quiet Hamlet",
          wealthTier: "poor",
          securityTier: "low",
          enabledActivityIds: [],
        },
      ],
      factions: [{ id: "watch", name: "City Watch" }],
      merchants: [{ id: "smith", name: "North Gate Smithy" }],
      actors: [{ id: "ada", name: "Ada" }],
      workflow: {
        id: "block-1",
        status: "collecting",
        hours: 16,
        participants: [
          {
            actorId: "ada",
            name: "Ada",
            usedHours: 4,
            submitted: true,
            queue: [{ id: "q1", label: "Craft Ammunition", hours: 4 }],
          },
        ],
      },
    },
    { view: "current", selectedSettlementId: "haven" },
  );

  assert.equal(workspace.currentBlock.dayLabel, "2 productive days");
  assert.equal(workspace.currentBlock.locationName, "Camp or wilderness");
  assert.equal(workspace.currentBlock.participants[0].remainingHours, 12);
  assert.equal(workspace.currentBlock.canLock, true);
  assert.equal(
    workspace.selectedSettlement.factionOptions.find(
      (option) => option.id === "watch",
    ).selected,
    true,
  );
  assert.equal(workspace.selectedSettlement.merchantOptions[0].checked, true);
  assert.equal(
    workspace.selectedSettlement.securityOptions.find(
      (option) => option.value === "high",
    ).selected,
    true,
  );
  assert.deepEqual(
    workspace.selectedSettlement.activityOptions
      .filter((option) => option.checked)
      .map((option) => option.id),
    ["craft-ammunition", "market-trading"],
  );

  const disabledSettlementWorkspace =
    workspaceModule.normalizeWorkspaceProjection(
      {
        settlements: [
          {
            id: "quiet-hamlet",
            name: "Quiet Hamlet",
            wealthTier: "poor",
            securityTier: "low",
            enabledActivityIds: [],
          },
        ],
      },
      { view: "settlements", selectedSettlementId: "quiet-hamlet" },
    );
  assert.equal(
    disabledSettlementWorkspace.selectedSettlement.activityOptions.some(
      (option) => option.checked,
    ),
    false,
    "an intentionally disabled activity catalog must remain disabled when reopened",
  );

  const campWorkspace = workspaceModule.normalizeWorkspaceProjection(
    { settlements: [], actors: [{ id: "ada", name: "Ada" }] },
    { view: "current" },
  );
  assert.equal(campWorkspace.canCreateBlock, true);
  assert.equal(campWorkspace.createBlockReason, "");

  const projectsWorkspace = workspaceModule.normalizeWorkspaceProjection(
    {
      guidedProjects: [
        {
          id: "project-learn-draconic",
          name: "Learn Draconic",
          description: "Study the language together.",
          requiredHours: 160,
          progressHours: 32,
          remainingHours: 128,
          progressLabel: "32 / 160 hours",
        },
      ],
    },
    { view: "projects" },
  );
  assert.equal(projectsWorkspace.viewProjects, true);
  assert.equal(
    projectsWorkspace.guidedProjects[0].progressLabel,
    "32 / 160 hours",
  );
  assert.equal(projectsWorkspace.projectSkillOptions.length, 18);
  assert.deepEqual(
    projectsWorkspace.projectSkillOptions.find(({ id }) => id === "per"),
    { id: "per", label: "Persuasion", checked: false },
  );
  assert.deepEqual(
    projectsWorkspace.projectSkillOptions.find(({ id }) => id === "prf"),
    { id: "prf", label: "Performance", checked: false },
  );

  const workspaceAppState = {
    _adapter: {
      getWorkspaceProjection: async () => {
        throw new Error("DowntimeWorkflowStoreUnavailable");
      },
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
  };
  const prepareWorkspaceContext = async () => {
    const savedConsoleError = console.error;
    try {
      console.error = () => {};
      return await workspaceModule.DowntimeWorkspaceApp.prototype._prepareContext.call(
        workspaceAppState,
      );
    } finally {
      console.error = savedConsoleError;
    }
  };
  const loadErrorContext = await prepareWorkspaceContext();
  assert.equal(loadErrorContext.dataAvailable, false);
  assert.equal(loadErrorContext.workflowStatusLabel, "Unavailable");
  assert.equal(loadErrorContext.workflowTone, "danger");
  assert.equal(loadErrorContext.canCreateBlock, false);
  assert.equal(loadErrorContext.hasError, true);
  assert.match(loadErrorContext.errorMessage, /not available yet/i);
  const loadErrorHtml = Handlebars.compile(
    readFileSync("templates/downtime-workspace.hbs", "utf8"),
  )(loadErrorContext);
  assert.doesNotMatch(
    loadErrorHtml,
    /data-form="new-block"/,
    "a failed read must not render a synthetic empty-state mutation form",
  );
  assert.match(
    loadErrorHtml,
    /data-view="current"[^>]*disabled/,
    "workspace navigation stays fail-closed while canonical data is unavailable",
  );
  assert.equal(
    loadErrorHtml.match(/Private downtime data is not available yet/g)?.length,
    1,
    "the load failure is announced once through the assertive alert",
  );
  for (const action of [
    "beginNextBlock",
    "createBlock",
    "openForPlayers",
    "lockBlock",
    "planBlock",
    "applyBlock",
    "cancelBlock",
    "recoverBlock",
    "newSettlement",
    "saveSettlement",
    "deleteSettlement",
    "saveGuidedProject",
  ]) {
    assert.doesNotMatch(
      loadErrorHtml,
      new RegExp(`data-action="${action}"`),
      `${action} stays hidden while canonical data is unavailable`,
    );
  }

  workspaceAppState._adapter.getWorkspaceProjection = async () => {
    throw new Error("An active full GM is required.");
  };
  const authorityErrorContext = await prepareWorkspaceContext();
  assert.match(authorityErrorContext.errorMessage, /another active GM/i);

  workspaceAppState._adapter.getWorkspaceProjection = async () => {
    throw new Error("DowntimeWorkflowCheckpointMalformed");
  };
  const malformedErrorContext = await prepareWorkspaceContext();
  assert.match(malformedErrorContext.errorMessage, /could not be verified/i);

  workspaceAppState._adapter.getWorkspaceProjection = async () => ({
    settlements: [],
    actors: [{ id: "ada", name: "Ada" }],
    canCreateBlock: true,
  });
  const recoveredWorkspaceContext = await prepareWorkspaceContext();
  assert.equal(recoveredWorkspaceContext.dataAvailable, true);
  assert.equal(recoveredWorkspaceContext.hasError, false);
  assert.equal(recoveredWorkspaceContext.canCreateBlock, true);
  assert.equal(
    workspaceAppState._projectionErrorMessage,
    "",
    "a successful refresh clears the stale load error",
  );

  workspaceAppState._errorMessage = "A downtime command failed.";
  const commandErrorContext = await prepareWorkspaceContext();
  assert.equal(
    commandErrorContext.errorMessage,
    "A downtime command failed.",
    "a successful projection does not hide an unrelated command error",
  );

  const workspaceTemplateSource = readFileSync(
    "templates/downtime-workspace.hbs",
    "utf8",
  );
  assert.match(
    workspaceTemplateSource,
    /<input(?=[^>]*name="locationName")(?=[^>]*aria-label="Downtime location")[^>]*>/,
    "the guided downtime location retains an explicit accessible name",
  );
  assert.match(
    workspaceTemplateSource,
    /<input(?=[^>]*name="hours")(?=[^>]*aria-labelledby="dt-new-block-hours-label")[^>]*>/,
    "the productive-hours input references its visible label",
  );
  assert.match(
    workspaceTemplateSource,
    /name="projectIds"/,
    "guided blocks can include selected long-term projects",
  );
  assert.match(
    workspaceTemplateSource,
    /data-form="guided-project"/,
    "the GM has a dedicated project creation form",
  );

  const activitiesTemplateSource = readFileSync(
    "templates/downtime-activities.hbs",
    "utf8",
  );
  assert.match(
    activitiesTemplateSource,
    /<div(?=[^>]*class="dt-heat__pips")(?=[^>]*role="img")(?=[^>]*aria-label="Heat \{\{heat\}\} out of 5")[^>]*>/,
    "the visual Heat meter exposes a valid image label",
  );
  const renderPlayer = Handlebars.compile(activitiesTemplateSource);
  const offlineDraftContext =
    activitiesModule.normalizePlayerDowntimeProjection({
      mode: "guided",
      status: "collecting",
      noGm: true,
      hasActiveBlock: true,
      actors: [{ id: "ada", name: "Ada" }],
      selectedActorId: "ada",
      budgetHours: 8,
      queue: [
        {
          id: "choice",
          activityId: "guided-labor",
          label: "Paid Work",
          hours: 8,
          skill: "ath",
        },
      ],
    });
  assert.equal(offlineDraftContext.canSubmit, false);
  const offlineDraftHtml = renderPlayer(offlineDraftContext);
  assert.match(offlineDraftHtml, /Last choice: Paid Work \(8h\)/);
  assert.doesNotMatch(offlineDraftHtml, /Your last receipt is still shown/);
  assert.doesNotMatch(offlineDraftHtml, /data-action="submitQueue"/);
  for (const [skill, buttonText] of [
    ["ath", "Roll &amp; submit"],
    ["", "Submit allocation"],
  ]) {
    const guidedPlayer = activitiesModule.normalizePlayerDowntimeProjection(
      {
        mode: "guided",
        status: "collecting",
        hasActiveBlock: true,
        blockId: "guided-ui",
        budgetHours: 8,
        actors: [{ id: "ada", name: "Ada" }],
        queue: [{ id: "choice", activityId: "custom", hours: 8, skill }],
      },
      { actorId: "ada" },
    );
    assert.equal(guidedPlayer.requiresRoll, Boolean(skill));
    assert.match(
      renderPlayer(guidedPlayer),
      new RegExp(`data-action="submitQueue"[^>]*>[\\s\\S]*?${buttonText}`),
    );
  }

  const { defaultGuidedDowntimeTemplates } =
    await import("./downtime/dispatch.js");
  const library = defaultGuidedDowntimeTemplates();
  const draft = {
    ...library[1],
    name: "Unfinished custom research",
    outcomes: library[1].outcomes.map((row) => ({
      ...row,
      report: "Unsaved report text",
    })),
  };
  const editorContext = workspaceModule.normalizeWorkspaceProjection(
    { guidedTemplates: library },
    {
      view: "activities",
      selectedTemplateId: library[1].id,
      templateDrafts: new Map([[library[1].id, draft]]),
    },
  );
  assert.equal(editorContext.templateEditor.name, draft.name);
  assert.equal(
    editorContext.templateEditor.outcomes[0].report,
    "Unsaved report text",
  );
  const editorHtml = Handlebars.compile(workspaceTemplateSource)(editorContext);
  assert.match(editorHtml, /data-form="guided-template"/);
  assert.match(editorHtml, /Unsaved report text/);
  assert.equal((editorHtml.match(/data-template-outcome/g) ?? []).length, 3);
  const newEditor = workspaceModule.normalizeWorkspaceProjection(
    { guidedTemplates: library },
    { view: "activities", creatingTemplate: true },
  );
  assert.equal(newEditor.templateEditor.id, "");
  assert.equal(newEditor.templateEditor.outcomes.length, 3);

  const previewWorkspace = workspaceModule.normalizeWorkspaceProjection(
    {
      settlements: [{ id: "haven", name: "Haven" }],
      workflow: {
        id: "block-2",
        status: "planned",
        hours: 8,
        plan: {
          characters: [
            {
              actorId: "ada",
              operations: [
                {
                  id: "exceptional-trade",
                  outcomeTier: "exceptional-success",
                },
                {
                  id: "serious-theft",
                  outcomeTier: "serious-failure",
                },
              ],
            },
          ],
        },
      },
    },
    { view: "current" },
  );
  assert.equal(
    previewWorkspace.currentBlock.canCancel,
    true,
    "a full GM may cancel an immutable preview before application begins",
  );
  assert.deepEqual(
    previewWorkspace.currentBlock.planCharacters[0].operations.map(
      (operation) => operation.tone,
    ),
    ["exceptional", "serious"],
    "canonical downtime outcome tiers retain their exceptional and serious UI tones",
  );
  assert.equal(
    workspaceModule.DowntimeWorkspaceApp.prototype._currentBlockId.call({
      _activeBlockId: "block-2",
      element: { querySelector: () => null },
    }),
    "block-2",
    "recovery should retain its active block target outside the Current Block tab",
  );

  const player = activitiesModule.normalizePlayerDowntimeProjection(
    {
      status: "collecting",
      blockId: "block-1",
      settlementName: "Haven",
      actors: [{ id: "ada", name: "Ada" }],
      budgetHours: 8,
      heat: 2,
      hiddenDc: 99,
      activities: [
        {
          id: "pickpocket",
          category: "crime",
          label: "Pickpocket",
          available: true,
          hourOptions: [2, 4],
          targets: [{ id: "mark-1", label: "Distracted pilgrim" }],
          hiddenRoll: 20,
          reward: "secret",
        },
      ],
      queue: [],
    },
    { actorId: "ada", category: "crime" },
  );

  assert.equal(player.editable, true);
  assert.equal(player.locationName, "Haven");
  assert.equal(player.hasSettlement, true);
  assert.equal(player.remainingHours, 8);
  assert.equal(player.activities[0].targets[0].label, "Distracted pilgrim");
  assert.equal(JSON.stringify(player).includes("hiddenDc"), false);
  assert.equal(JSON.stringify(player).includes("hiddenRoll"), false);
  assert.equal(JSON.stringify(player).includes("secret"), false);

  const emptyQueuePlayer = activitiesModule.normalizePlayerDowntimeProjection(
    {
      status: "collecting",
      hasActiveBlock: true,
      blockId: "block-empty",
      settlementName: "Haven",
      actors: [{ id: "ada", name: "Ada" }],
      budgetHours: 8,
      queue: [],
    },
    { actorId: "ada" },
  );
  assert.equal(
    emptyQueuePlayer.canSubmit,
    true,
    "a player may submit an empty queue and leave the entire budget unused",
  );
  assert.equal(emptyQueuePlayer.submitReason, "");

  const campPlayer = activitiesModule.normalizePlayerDowntimeProjection(
    {
      status: "collecting",
      hasActiveBlock: true,
      hasSettlement: false,
      blockId: "block-camp",
      locationName: "Pinewood camp",
      actors: [{ id: "ada", name: "Ada" }],
      budgetHours: 4,
      queue: [],
    },
    { actorId: "ada" },
  );
  assert.equal(campPlayer.locationName, "Pinewood camp");
  assert.equal(campPlayer.hasSettlement, false);

  const lockedPlayer = activitiesModule.normalizePlayerDowntimeProjection(
    {
      status: "locked",
      hasActiveBlock: true,
      blockId: "block-locked",
      actors: [{ id: "ada", name: "Ada" }],
      budgetHours: 8,
      submitted: true,
      canSubmit: true,
      canRecall: true,
    },
    { actorId: "ada" },
  );
  assert.equal(lockedPlayer.canSubmit, false);
  assert.equal(
    lockedPlayer.canRecall,
    false,
    "stale command flags cannot reopen a queue after submissions lock",
  );

  const receiptPlayer = activitiesModule.normalizePlayerDowntimeProjection({
    status: "completed",
    receipt: {
      activities: [
        { id: "great", tone: "exceptional-success" },
        { id: "bad", tone: "serious-failure" },
      ],
    },
  });
  assert.deepEqual(
    receiptPlayer.receipt.activities.map((activity) => activity.tone),
    ["exceptional", "serious"],
  );
  const multiReceiptContext =
    activitiesModule.normalizePlayerDowntimeProjection(
      {
        status: "completed",
        hasActiveBlock: false,
        selectedActorId: "rowan",
        actors: [
          { id: "ada", name: "Ada" },
          { id: "rowan", name: "Rowan" },
        ],
        receipt: { summary: "Rowan's result", activities: [] },
      },
      { actorId: "ada" },
    );
  assert.equal(
    multiReceiptContext.actor.id,
    "rowan",
    "receipt identity follows the returned character, not an obsolete request",
  );
  const multiReceiptHtml = Handlebars.compile(activitiesTemplateSource)(
    multiReceiptContext,
  );
  assert.match(multiReceiptHtml, /data-actor-id="ada"/);
  assert.match(multiReceiptHtml, /data-actor-id="rowan"/);
  assert.match(multiReceiptHtml, /GM-and-owner receipt · Rowan/);
  assert.doesNotMatch(
    multiReceiptHtml,
    /data-action="submitQueue"/,
    "completed reports never offer a new submission",
  );

  const allowed = activitiesModule.readAllowedActivityInputs({
    querySelectorAll() {
      return [
        { name: "hours", value: "4" },
        { name: "skill", value: "sleight-of-hand" },
        { name: "targetId", value: "mark-1" },
        {
          name: "targetIds",
          selectedOptions: [
            { value: "stolen-b" },
            { value: "stolen-a" },
            { value: "stolen-b" },
          ],
        },
        { name: "stakeGp", value: "12.5" },
        { name: "dc", value: "1" },
        { name: "reward", value: "1000000" },
      ];
    },
  });
  assert.deepEqual(allowed, {
    hours: 4,
    skill: "sleight-of-hand",
    targetId: "mark-1",
    targetIds: ["stolen-a", "stolen-b"],
    stakeGp: 12.5,
  });

  const commercePlayer = activitiesModule.normalizePlayerDowntimeProjection(
    {
      status: "collecting",
      blockId: "block-market",
      settlementName: "Haven",
      actors: [{ id: "ada", name: "Ada" }],
      budgetHours: 8,
      activities: [
        {
          id: "market-trading",
          category: "commerce",
          available: true,
          hourOptions: [2, 4, 6, 8],
          skills: [{ id: "persuasion", label: "Persuasion" }],
          stakeAllowed: true,
          maxStakeGp: 25,
          stakeStepGp: 0.01,
          stakeValueGp: 0,
        },
        {
          id: "fence-stolen-goods",
          category: "crime",
          available: true,
          hourOptions: [2, 4, 6, 8],
          targets: [
            { id: "stolen-a", label: "Silver brooch" },
            { id: "stolen-b", label: "Ivory comb" },
          ],
          multiTarget: true,
        },
      ],
      queue: [],
    },
    { actorId: "ada", category: "all" },
  );
  const marketActivity = commercePlayer.activities.find(
    (activity) => activity.id === "market-trading",
  );
  assert.equal(marketActivity.stakeValueGp, 0.01);
  const commerceHtml = Handlebars.compile(
    readFileSync("templates/downtime-activities.hbs", "utf8"),
  )(commercePlayer);
  assert.match(
    commerceHtml,
    /name="stakeGp" min="0\.01"[^>]*value="0\.01"[^>]*required/,
  );
  assert.match(commerceHtml, /name="targetIds" multiple size="5"[^>]*required/);
  assert.match(
    commerceHtml,
    /aria-describedby="dt-target-help-fence-stolen-goods"/,
  );

  let refreshCall = null;
  await activitiesModule.DowntimeActivitiesApp.DEFAULT_OPTIONS.actions.refresh.call(
    {
      _actorId: "ada",
      _errorMessage: "stale error",
      _runCommand: async (method, payload, options) => {
        refreshCall = { method, payload, options };
      },
    },
  );
  assert.equal(refreshCall.method, "refreshPlayerProjection");
  assert.deepEqual(refreshCall.payload, { actorId: "ada" });

  const applyingContext =
    await activitiesModule.DowntimeActivitiesApp.prototype._prepareContext.call(
      {
        _adapter: {
          getPlayerProjection: async () => ({
            status: "applying",
            hasActiveBlock: true,
            blockId: "block-applying",
            actors: [{ id: "ada", name: "Ada" }],
            submitted: true,
          }),
        },
        _actorId: "ada",
        _category: "all",
        _busy: false,
        _statusMessage: "",
        _errorMessage: "",
      },
    );
  assert.equal(
    applyingContext.ariaBusy,
    true,
    "the player window announces an applying workflow as busy after a state update",
  );

  assertActionCoverage(
    "templates/downtime-workspace.hbs",
    workspaceModule.DowntimeWorkspaceApp.DEFAULT_OPTIONS.actions,
  );
  assertActionCoverage(
    "templates/downtime-activities.hbs",
    activitiesModule.DowntimeActivitiesApp.DEFAULT_OPTIONS.actions,
  );
  assert.doesNotThrow(() =>
    Handlebars.compile(
      readFileSync("templates/downtime-workspace.hbs", "utf8"),
    )(workspace),
  );
  assert.doesNotThrow(() =>
    Handlebars.compile(
      readFileSync("templates/downtime-activities.hbs", "utf8"),
    )(player),
  );

  process.stdout.write("downtime UI validation passed\n");
} finally {
  if (savedFoundry === undefined) delete globalThis.foundry;
  else globalThis.foundry = savedFoundry;
}

function assertActionCoverage(templatePath, actions) {
  const source = [
    templatePath === "templates/downtime-workspace.hbs"
      ? readFileSync("templates/gm-workbench-nav.hbs", "utf8")
      : "",
    readFileSync(templatePath, "utf8"),
  ].join("\n");
  const used = new Set(
    [...source.matchAll(/\bdata-action="([^"]+)"/g)].map((match) => match[1]),
  );
  assert.deepEqual(
    [...used].sort(),
    Object.keys(actions).sort(),
    `${templatePath} and its ApplicationV2 action map must stay in sync`,
  );
}
