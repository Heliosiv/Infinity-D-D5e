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

  const previewWorkspace = workspaceModule.normalizeWorkspaceProjection(
    {
      settlements: [{ id: "haven", name: "Haven" }],
      workflow: { id: "block-2", status: "planned", hours: 8 },
    },
    { view: "current" },
  );
  assert.equal(
    previewWorkspace.currentBlock.canCancel,
    true,
    "a full GM may cancel an immutable preview before application begins",
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
  assert.equal(player.remainingHours, 8);
  assert.equal(player.activities[0].targets[0].label, "Distracted pilgrim");
  assert.equal(JSON.stringify(player).includes("hiddenDc"), false);
  assert.equal(JSON.stringify(player).includes("hiddenRoll"), false);
  assert.equal(JSON.stringify(player).includes("secret"), false);

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
  const source = readFileSync(templatePath, "utf8");
  const used = new Set(
    [...source.matchAll(/\bdata-action="([^"]+)"/g)].map((match) => match[1]),
  );
  assert.deepEqual(
    [...used].sort(),
    Object.keys(actions).sort(),
    `${templatePath} and its ApplicationV2 action map must stay in sync`,
  );
}
