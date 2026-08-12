import assert from "node:assert/strict";

const saved = Object.fromEntries(
  ["game", "foundry", "CONST", "JournalEntry", "Hooks", "fromUuid"].map(
    (key) => [key, globalThis[key]],
  ),
);

const MODULE_ID = "infinity-dnd5e";
const settings = new Map();
let settingWrites = 0;
let randomId = 0;

function clone(value) {
  return value == null ? value : structuredClone(value);
}

function ownedItem(actor, source) {
  const item = {
    ...clone(source),
    id: String(source.id ?? source._id),
    parent: actor,
    toObject() {
      return clone({
        ...source,
        _id: this.id,
        id: this.id,
        system: this.system,
        flags: this.flags,
      });
    },
    async update(changes) {
      if (Object.hasOwn(changes, "system.quantity")) {
        this.system.quantity = Number(changes["system.quantity"]);
      }
      return this;
    },
  };
  return item;
}

function makeActor({ id = "actor-1", ownerId = "player-1", currency } = {}) {
  const items = new Map();
  const actor = {
    id,
    name: "Mira",
    img: "icons/svg/mystery-man.svg",
    type: "character",
    ownership: { default: 0, [ownerId]: 3 },
    system: {
      currency: clone(currency ?? { pp: 0, gp: 1, ep: 0, sp: 0, cp: 0 }),
    },
    items,
    async update(changes) {
      for (const [path, value] of Object.entries(changes ?? {})) {
        const match = /^system\.currency\.(pp|gp|ep|sp|cp)$/.exec(path);
        if (match) this.system.currency[match[1]] = Number(value) || 0;
      }
      return this;
    },
    async createEmbeddedDocuments(type, sources) {
      assert.equal(type, "Item");
      return sources.map((source) => {
        const item = ownedItem(actor, source);
        items.set(item.id, item);
        return item;
      });
    },
    async deleteEmbeddedDocuments(type, ids) {
      assert.equal(type, "Item");
      return ids.flatMap((itemId) => {
        const item = items.get(itemId);
        if (!item) return [];
        items.delete(itemId);
        return [item];
      });
    },
  };
  actor.addItem = (source) => {
    const item = ownedItem(actor, source);
    items.set(item.id, item);
    return item;
  };
  return actor;
}

try {
  const gm = {
    id: "gm-1",
    name: "Game Master",
    isGM: true,
    role: 4,
    active: true,
  };
  const player = {
    id: "player-1",
    name: "Player One",
    isGM: false,
    role: 1,
    active: true,
    character: null,
  };
  const assistant = {
    id: "assistant-1",
    name: "Assistant One",
    isGM: true,
    role: 3,
    active: true,
    character: null,
  };
  const users = new Map([
    [gm.id, gm],
    [player.id, player],
    [assistant.id, assistant],
  ]);
  users.activeGM = gm;
  const actor = makeActor();
  const actors = new Map([[actor.id, actor]]);
  const socketEmissions = [];

  globalThis.CONST = {
    ACTIVE_EFFECT_MODES: { ADD: 2 },
    DOCUMENT_OWNERSHIP_LEVELS: { NONE: 0, OWNER: 3 },
    USER_ROLES: { GAMEMASTER: 4 },
  };
  globalThis.foundry = {
    utils: {
      deepClone: clone,
      randomID: () => `service-${++randomId}`,
    },
  };
  delete globalThis.JournalEntry;
  globalThis.game = {
    ready: false,
    user: gm,
    users,
    actors,
    time: { serverTime: 1_000 },
    socket: {
      emit(...args) {
        socketEmissions.push(args);
      },
    },
    settings: {
      get(moduleId, key) {
        assert.equal(moduleId, MODULE_ID);
        return clone(settings.get(key));
      },
      async set(moduleId, key, value) {
        assert.equal(moduleId, MODULE_ID);
        settingWrites += 1;
        settings.set(key, clone(value));
        return value;
      },
    },
  };

  const privateState = await import("./private-state.js");
  const workflow = await import("./downtime/store.js");
  const service = await import("./downtime/service.js");
  const items = await import("./downtime/items.js");
  const effects = await import("./downtime/effects.js");
  const stolenLedger = await import("./downtime/stolen-ledger.js");
  const targets = await import("./downtime/targets.js");
  const merchantStore = await import("./merchant/store.js");
  const factionStore = await import("./reputation/store.js");
  privateState.resetPrivateStateForTests();
  workflow.resetDowntimeWorkflowStoreForTests();

  const canonical = service.canonicalizeDowntimeQueueSubmission([
    {
      queueEntryId: "craft-1",
      activity: "craft-ammunition",
      hours: 4,
      ammunitionType: "arrows",
    },
    {
      id: "sharpen-1",
      activityId: "sharpen-weapon",
      hours: 1,
      weaponId: "sword-1",
    },
    {
      id: "trade-1",
      activityId: "market-trading",
      hours: 2,
      skillId: "per",
      stakeGp: 1.25,
    },
    {
      id: "fence-1",
      activityId: "fence-stolen-goods",
      hours: 2,
      skill: "deception",
      bundleId: "bundle-1",
    },
  ]);
  assert.equal(canonical.ok, true);
  assert.equal(canonical.queue[0].targetId, "arrows");
  assert.equal(canonical.queue[1].targetId, "sword-1");
  assert.equal(canonical.queue[2].skill, "persuasion");
  assert.equal(canonical.queue[2].stakeCp, 125);
  assert.equal(canonical.queue[3].targetId, "bundle-1");
  assert.equal(
    service.canonicalizeDowntimeQueueSubmission([
      {
        id: "ambiguous-fence",
        activityId: "fence-stolen-goods",
        hours: 2,
        targetId: "forged-bundle-alias",
        targetIds: ["stolen-item-1"],
      },
    ]).ok,
    false,
    "a fence submission cannot combine an opaque bundle alias with item IDs",
  );
  assert.equal(
    service.canonicalizeDowntimeQueueSubmission([
      {
        id: "forged",
        activityId: "pickpocket",
        hours: 2,
        targetId: "mark-1",
        dc: 1,
      },
    ]).ok,
    false,
    "derived DC fields cannot survive authoritative submission",
  );
  assert.equal(
    service.canonicalizeDowntimeQueueSubmission([
      {
        id: "conflict",
        activityId: "sharpen-weapon",
        hours: 1,
        targetId: "sword-1",
        weaponId: "sword-2",
      },
    ]).ok,
    false,
  );

  assert.equal(service.userOwnsDowntimeActor(gm, actor), true);
  assert.equal(service.userOwnsDowntimeActor(player, actor), true);
  const originalOwnership = actor.ownership;
  actor.ownership = { default: 3, [player.id]: 0 };
  assert.equal(
    service.userOwnsDowntimeActor(player, actor),
    false,
    "an explicit player denial overrides default Actor ownership",
  );
  actor.ownership = originalOwnership;
  assert.equal(
    service.userOwnsDowntimeActor(assistant, actor),
    false,
    "Assistant role access is not treated as ownership",
  );
  actor.ownership[assistant.id] = 3;
  assert.equal(
    service.userOwnsDowntimeActor(assistant, actor),
    true,
    "an Assistant may still use an explicitly owned Actor",
  );
  delete actor.ownership[assistant.id];
  actor.ownership = { default: 3, [assistant.id]: 0 };
  assert.equal(
    service.userOwnsDowntimeActor(assistant, actor),
    false,
    "an explicit Assistant denial is not replaced by default ownership",
  );
  actor.ownership = originalOwnership;
  assistant.character = actor.id;
  assert.equal(service.userOwnsDowntimeActor(assistant, actor), true);
  actor.ownership[assistant.id] = 0;
  assert.equal(
    service.userOwnsDowntimeActor(assistant, actor),
    false,
    "an explicit denial overrides a stale assigned-character pointer",
  );
  delete actor.ownership[assistant.id];
  assistant.character = null;

  actor.folder = { id: "folder-party", name: "Player Characters" };
  const assignedPlayer = {
    id: "player-assigned",
    name: "Assigned Player",
    isGM: false,
    role: 1,
    active: true,
    character: "projection-assigned",
  };
  const inactivePlayer = {
    id: "player-inactive",
    name: "Offline Player",
    isGM: false,
    role: 1,
    active: false,
    character: null,
  };
  const deniedPlayer = {
    id: "player-denied",
    name: "Denied Player",
    isGM: false,
    role: 1,
    active: true,
    character: "projection-denied",
  };
  users.set(assignedPlayer.id, assignedPlayer);
  users.set(inactivePlayer.id, inactivePlayer);
  users.set(deniedPlayer.id, deniedPlayer);

  const projectionActors = [
    makeActor({ id: "projection-assigned", ownerId: "nobody" }),
    makeActor({ id: "projection-inactive", ownerId: inactivePlayer.id }),
    makeActor({ id: "projection-unowned", ownerId: "nobody" }),
    makeActor({ id: "projection-gm-only", ownerId: gm.id }),
    makeActor({ id: "projection-denied", ownerId: deniedPlayer.id }),
    makeActor({ id: "projection-assistant-explicit", ownerId: assistant.id }),
    makeActor({ id: "projection-assistant-assigned", ownerId: "nobody" }),
    makeActor({ id: "projection-npc", ownerId: player.id }),
  ];
  for (const projectionActor of projectionActors) {
    projectionActor.name = projectionActor.id;
    projectionActor.ownership.default = 0;
    actors.set(projectionActor.id, projectionActor);
  }
  projectionActors[0].ownership = { default: 0 };
  projectionActors[2].ownership = { default: 0 };
  projectionActors[4].ownership[deniedPlayer.id] = 0;
  projectionActors[6].ownership = { default: 0 };
  projectionActors[7].type = "npc";
  assistant.character = projectionActors[6].id;

  const workspaceActorRows = new Map(
    (await service.getWorkspaceProjection()).actors.map((entry) => [
      entry.id,
      entry,
    ]),
  );
  assert.deepEqual(
    workspaceActorRows.get(actor.id),
    {
      id: actor.id,
      name: actor.name,
      img: actor.img,
      eligible: true,
      checked: true,
      playerOwned: true,
      control: "player-owned",
      assigned: false,
      owners: [
        {
          id: player.id,
          name: player.name,
          active: true,
          assigned: false,
        },
      ],
      folderId: "folder-party",
      folderName: "Player Characters",
    },
    "the GM projection defaults a directly player-owned PC on and includes bounded owner/folder metadata",
  );
  assert.deepEqual(
    workspaceActorRows.get(projectionActors[0].id).owners,
    [
      {
        id: assignedPlayer.id,
        name: assignedPlayer.name,
        active: true,
        assigned: true,
      },
    ],
    "an assigned character uses the same downtime control semantics as player submission",
  );
  assert.equal(workspaceActorRows.get(projectionActors[0].id).assigned, true);
  assert.deepEqual(
    workspaceActorRows.get(projectionActors[1].id).owners,
    [
      {
        id: inactivePlayer.id,
        name: inactivePlayer.name,
        active: false,
        assigned: false,
      },
    ],
    "offline ownership remains visible and selected for advance downtime setup",
  );
  for (const projectionActor of [
    projectionActors[0],
    projectionActors[1],
    projectionActors[5],
    projectionActors[6],
  ]) {
    const row = workspaceActorRows.get(projectionActor.id);
    assert.equal(row.playerOwned, true);
    assert.equal(row.control, "player-owned");
    assert.equal(row.checked, true);
  }
  for (const projectionActor of [
    projectionActors[2],
    projectionActors[3],
    projectionActors[4],
  ]) {
    const row = workspaceActorRows.get(projectionActor.id);
    assert.equal(row.playerOwned, false);
    assert.equal(row.control, "other-character");
    assert.equal(row.checked, false);
    assert.equal(row.assigned, false);
    assert.deepEqual(row.owners, []);
  }
  assert.deepEqual(
    workspaceActorRows.get(projectionActors[5].id).owners,
    [
      {
        id: assistant.id,
        name: assistant.name,
        active: true,
        assigned: false,
      },
    ],
    "an explicitly owning Assistant retains player-surface control",
  );
  assert.deepEqual(
    workspaceActorRows.get(projectionActors[6].id).owners,
    [
      {
        id: assistant.id,
        name: assistant.name,
        active: true,
        assigned: true,
      },
    ],
    "an assigned Assistant retains player-surface control",
  );
  assert.equal(
    workspaceActorRows.has(projectionActors[7].id),
    false,
    "NPC Actors remain outside the downtime character pool",
  );

  assistant.character = null;
  for (const user of [assignedPlayer, inactivePlayer, deniedPlayer]) {
    users.delete(user.id);
  }
  for (const projectionActor of projectionActors) {
    actors.delete(projectionActor.id);
  }
  delete actor.folder;

  const missingSharpenTool = service.validateDowntimeServicePrerequisites(
    [
      {
        id: "sharpen",
        activityId: "sharpen-weapon",
        hours: 1,
        targetId: "missing-sword",
      },
    ],
    { actor, context: { allowedTargetIds: {} } },
  );
  assert.equal(
    missingSharpenTool.errors.some(
      (error) => error.code === "sharpening-tool-required",
    ),
    true,
  );
  const lowFundsActor = makeActor({
    id: "low-funds",
    currency: { pp: 0, gp: 0, ep: 0, sp: 7, cp: 5 },
  });
  const craftFunds = service.validateDowntimeServicePrerequisites(
    [
      {
        id: "craft-a",
        activityId: "craft-ammunition",
        hours: 4,
        targetId: "arrows",
      },
      {
        id: "craft-b",
        activityId: "craft-ammunition",
        hours: 4,
        targetId: "arrows",
      },
    ],
    {
      actor: lowFundsActor,
      context: { allowedTargetIds: { "craft-ammunition": ["arrows"] } },
    },
  );
  assert.equal(
    craftFunds.errors.some(
      (error) => error.code === "insufficient-crafting-funds",
    ),
    true,
  );
  const reservedTradeLoss = service.validateDowntimeServicePrerequisites(
    [
      {
        id: "trade",
        activityId: "market-trading",
        hours: 2,
        skill: "persuasion",
        stakeCp: 40,
      },
      {
        id: "craft",
        activityId: "craft-ammunition",
        hours: 4,
        targetId: "arrows",
      },
    ],
    {
      actor: makeActor({
        id: "trade-reserve",
        currency: { pp: 0, gp: 0, ep: 0, sp: 5, cp: 5 },
      }),
      context: { allowedTargetIds: { "craft-ammunition": ["arrows"] } },
    },
  );
  assert.equal(
    reservedTradeLoss.errors.some(
      (error) => error.code === "insufficient-crafting-funds",
    ),
    true,
  );

  await workflow.saveDowntimeConfig({
    settlements: [
      {
        id: "greyhaven",
        name: "Greyhaven",
        wealthTier: "modest",
        securityTier: "standard",
        marketDc: 13,
      },
    ],
    heat: { greyhaven: { [actor.id]: 2 } },
  });

  let campBlock = await service.openDowntimeBlock({
    settlementId: "",
    locationName: "Pinewood camp",
    hours: 4,
    actorIds: [actor.id],
  });
  assert.equal(campBlock.locationName, "Pinewood camp");
  assert.equal(campBlock.hasSettlement, false);
  assert.equal(campBlock.settlementSnapshot.hasSettlement, false);
  const campProjection = await service.getPlayerProjectionForUser({
    userId: player.id,
    actorId: actor.id,
  });
  assert.equal(campProjection.locationName, "Pinewood camp");
  assert.equal(campProjection.hasSettlement, false);
  assert.equal(
    campProjection.activities.find((entry) => entry.id === "market-trading")
      .unavailableReason,
    "Requires a selected settlement; this activity is not available at camp or in the wilderness.",
  );
  assert.doesNotMatch(
    campProjection.activities.find((entry) => entry.id === "craft-ammunition")
      .unavailableReason,
    /settlement/i,
    "routine activity availability remains based on its own prerequisites",
  );
  await service.submitQueueAuthoritatively({
    userId: player.id,
    requestId: "submit-camp-empty",
    blockId: campBlock.id,
    actorId: actor.id,
    queue: [],
  });
  campBlock = await service.lockActiveDowntimeBlock(campBlock.id);
  campBlock = await service.planActiveDowntimeBlock(campBlock.id);
  assert.equal(campBlock.state, "planned");
  assert.deepEqual(campBlock.plan.operations, []);
  campBlock = await service.applyActiveDowntimeBlock(campBlock.id);
  assert.equal(campBlock.state, "completed");

  actor.rollSkill = async () => {
    throw new Error("guided planning must not reroll a player check");
  };
  let guidedBlock = await service.openDowntimeBlock({
    mode: "guided",
    locationName: "The Lantern District",
    hours: 8,
    actorIds: [actor.id],
    templateIds: ["guided-labor"],
  });
  await assert.rejects(
    service.submitQueueAuthoritatively({
      userId: player.id,
      requestId: "guided-missing-roll",
      blockId: guidedBlock.id,
      actorId: actor.id,
      queue: [
        {
          id: "guided-choice",
          activityId: "guided-labor",
          hours: 8,
          skill: "ath",
        },
      ],
    }),
    /roll the selected downtime check/i,
  );
  await service.submitQueueAuthoritatively({
    userId: player.id,
    requestId: "guided-player-roll",
    blockId: guidedBlock.id,
    actorId: actor.id,
    queue: [
      {
        id: "guided-choice",
        activityId: "guided-labor",
        hours: 8,
        skill: "ath",
        guidedRoll: { total: 17, formula: "1d20 + 5" },
      },
    ],
  });
  guidedBlock = await service.lockActiveDowntimeBlock(guidedBlock.id);
  guidedBlock = await service.planActiveDowntimeBlock(guidedBlock.id);
  assert.equal(guidedBlock.plan.operations[0].check.total, 17);
  assert.equal(guidedBlock.plan.operations[0].check.formula, "1d20 + 5");
  assert.equal(
    guidedBlock.plan.operations[0].selectedOutcomeIndex,
    1,
    "the GM preview uses the player-clicked check as its suggested result",
  );
  guidedBlock = await service.applyActiveDowntimeBlock(guidedBlock.id);
  assert.equal(guidedBlock.state, "completed");
  delete actor.rollSkill;

  const projectPartner = makeActor({ id: "project-partner" });
  projectPartner.name = "Project Partner";
  actors.set(projectPartner.id, projectPartner);
  const languageProject = await service.saveGuidedDowntimeProject({
    name: "Learn Draconic",
    description: "Study the language together between adventures.",
    requiredHours: 16,
    skills: ["arc", "his"],
  });
  let projectBlock = await service.openDowntimeBlock({
    mode: "guided",
    locationName: "The Lantern District",
    hours: 8,
    actorIds: [actor.id, projectPartner.id],
    projectIds: [languageProject.id],
  });
  const projectPlayerProjection = await service.getPlayerProjectionForUser({
    userId: player.id,
    actorId: actor.id,
  });
  assert.deepEqual(
    projectPlayerProjection.activities.find(
      (activity) => activity.id === languageProject.id,
    ),
    {
      id: languageProject.id,
      label: "Learn Draconic",
      description:
        "Study the language together between adventures. 0 / 16 hours complete.",
      category: "project",
      icon: "fa-solid fa-compass",
      available: true,
      fixedHours: 8,
      skills: [
        { id: "arc", label: "Arcana", selected: false },
        { id: "his", label: "History", selected: false },
      ],
      hasSkills: true,
      image: languageProject.image,
      project: true,
    },
    "players receive a rollable project activity with the current shared progress",
  );
  for (const [index, projectActor] of [actor, projectPartner].entries()) {
    await service.submitQueueAuthoritatively({
      userId: player.id,
      requestId: `project-contributor-${index}`,
      blockId: projectBlock.id,
      actorId: projectActor.id,
      queue: [
        {
          id: "guided-choice",
          activityId: languageProject.id,
          hours: 8,
          skill: "arc",
          guidedRoll: { total: 14 + index, formula: "1d20 + 4" },
        },
      ],
    });
  }
  projectBlock = await service.lockActiveDowntimeBlock(projectBlock.id);
  projectBlock = await service.planActiveDowntimeBlock(projectBlock.id);
  assert.deepEqual(
    projectBlock.plan.operations.map((operation) => operation.project),
    [
      {
        id: languageProject.id,
        name: "Learn Draconic",
        requiredHours: 16,
        progressBeforeHours: 0,
        contributedHours: 8,
        progressAfterHours: 8,
        completed: false,
      },
      {
        id: languageProject.id,
        name: "Learn Draconic",
        requiredHours: 16,
        progressBeforeHours: 8,
        contributedHours: 8,
        progressAfterHours: 16,
        completed: true,
      },
    ],
    "two characters can contribute concurrently to one long-term project",
  );
  projectBlock = await service.applyActiveDowntimeBlock(projectBlock.id);
  assert.equal(projectBlock.state, "completed");
  const projectWorkspace = await service.getWorkspaceProjection();
  assert.deepEqual(
    projectWorkspace.guidedProjects.find(
      (project) => project.id === languageProject.id,
    ),
    {
      ...languageProject,
      progressHours: 16,
      remainingHours: 0,
      complete: true,
      progressLabel: "16 / 16 hours",
    },
    "completed project work is derived from durable operation receipts",
  );
  await assert.rejects(
    service.openDowntimeBlock({
      mode: "guided",
      locationName: "The Lantern District",
      hours: 8,
      actorIds: [actor.id],
      projectIds: [languageProject.id],
    }),
    /choose at least one activity/i,
    "a completed project cannot be reopened accidentally",
  );
  actors.delete(projectPartner.id);

  const reusableRollActor = makeActor({ id: "reusable-roll-actor" });
  reusableRollActor.name = "Reusable Roll Hero";
  actors.set(reusableRollActor.id, reusableRollActor);
  let reusableRollCalls = 0;
  reusableRollActor.rollSkill = async () => {
    reusableRollCalls += 1;
    reusableRollActor.system.currency.gp = 0;
    return {
      total: 18,
      dice: [{ total: 14 }],
      formula: "PRIVATE_REUSABLE_ROLL_1d20 + 4",
    };
  };
  let reusableRollBlock = await service.openDowntimeBlock({
    settlementId: "greyhaven",
    hours: 2,
    actorIds: [reusableRollActor.id],
  });
  await service.submitQueueAuthoritatively({
    userId: player.id,
    requestId: "submit-reusable-hidden-roll",
    blockId: reusableRollBlock.id,
    actorId: reusableRollActor.id,
    queue: [
      {
        id: "reusable-trade",
        activityId: "market-trading",
        hours: 2,
        skill: "persuasion",
        stakeCp: 100,
      },
    ],
  });
  reusableRollBlock = await service.lockActiveDowntimeBlock(
    reusableRollBlock.id,
  );
  await assert.rejects(
    service.planActiveDowntimeBlock(reusableRollBlock.id),
    /does not have the selected trading stake/,
    "a post-roll enrichment failure leaves the completed roll durably journaled",
  );
  assert.equal(reusableRollCalls, 1);
  reusableRollBlock = workflow.getActiveDowntimeBlock();
  assert.equal(reusableRollBlock.state, "locked");
  assert.equal(reusableRollBlock.planningDraft.state, "complete");
  const reusablePlayerProjection = await service.getPlayerProjectionForUser({
    userId: player.id,
    actorId: reusableRollActor.id,
  });
  assert.equal("planningDraft" in reusablePlayerProjection, false);
  assert.equal(
    JSON.stringify(reusablePlayerProjection).includes("PRIVATE_REUSABLE_ROLL"),
    false,
    "partial hidden-roll data is absent from the player projection",
  );
  reusableRollActor.system.currency.gp = 1;
  reusableRollBlock = await service.planActiveDowntimeBlock(
    reusableRollBlock.id,
  );
  assert.equal(reusableRollBlock.state, "planned");
  assert.equal(
    reusableRollCalls,
    1,
    "planning retry reuses the completed hidden check instead of rerolling",
  );
  await service.cancelActiveDowntimeBlock(reusableRollBlock.id);

  const orphanedRollActor = makeActor({ id: "orphaned-roll-actor" });
  orphanedRollActor.name = "Orphaned Roll Hero";
  actors.set(orphanedRollActor.id, orphanedRollActor);
  let orphanedRollCalls = 0;
  orphanedRollActor.rollSkill = async () => {
    orphanedRollCalls += 1;
    throw new Error("simulated roller interruption");
  };
  let orphanedRollBlock = await service.openDowntimeBlock({
    settlementId: "greyhaven",
    hours: 2,
    actorIds: [orphanedRollActor.id],
  });
  await service.submitQueueAuthoritatively({
    userId: player.id,
    requestId: "submit-orphaned-hidden-roll",
    blockId: orphanedRollBlock.id,
    actorId: orphanedRollActor.id,
    queue: [
      {
        id: "orphaned-trade",
        activityId: "market-trading",
        hours: 2,
        skill: "persuasion",
        stakeCp: 100,
      },
    ],
  });
  orphanedRollBlock = await service.lockActiveDowntimeBlock(
    orphanedRollBlock.id,
  );
  await assert.rejects(
    service.planActiveDowntimeBlock(orphanedRollBlock.id),
    /will not reroll it; cancel the block/,
  );
  orphanedRollBlock = workflow.getActiveDowntimeBlock();
  assert.equal(orphanedRollBlock.state, "locked");
  assert.equal(orphanedRollBlock.planningDraft.state, "needs-review");
  assert.equal(
    Object.values(orphanedRollBlock.planningDraft.rows)[0].state,
    "in-flight",
  );
  const orphanedWorkspace = await service.getWorkspaceProjection();
  assert.equal(orphanedWorkspace.workflow.canPlan, false);
  assert.match(orphanedWorkspace.workflow.planReason, /cancel the block/i);
  orphanedRollActor.rollSkill = async () => {
    orphanedRollCalls += 1;
    return { total: 20, dice: [{ total: 20 }], formula: "1d20" };
  };
  await assert.rejects(
    service.planActiveDowntimeBlock(orphanedRollBlock.id),
    /will not reroll|Cancel this locked block/,
    "an orphaned in-flight roll fails closed on every retry",
  );
  assert.equal(orphanedRollCalls, 1);
  await service.cancelActiveDowntimeBlock(orphanedRollBlock.id);

  const lifecycleEffectSource = effects.buildSharpeningEffect({
    operationId: "lifecycle-effect",
    actorId: actor.id,
    itemId: "lifecycle-weapon",
    damageType: "slashing",
    timestamp: 999,
    nativeDamagePart: false,
  });
  const lifecycleEffectData = clone(lifecycleEffectSource);
  let lifecycleUpdateFailures = 1;
  let lifecycleDeleteFailures = 1;
  const lifecycleEffect = {
    id: lifecycleEffectData._id,
    toObject: () => clone(lifecycleEffectData),
    async update(changes) {
      if (lifecycleUpdateFailures > 0) {
        lifecycleUpdateFailures -= 1;
        throw new Error("simulated effect update failure");
      }
      lifecycleEffectData.flags[MODULE_ID].downtimeSharpen.charges =
        changes[`flags.${MODULE_ID}.downtimeSharpen.charges`];
      lifecycleEffectData.flags[MODULE_ID].downtimeSharpen.rollIds =
        changes[`flags.${MODULE_ID}.downtimeSharpen.rollIds`];
      return lifecycleEffect;
    },
  };
  const lifecycleWeapon = {
    id: "lifecycle-weapon",
    parent: actor,
    effects: new Map([[lifecycleEffect.id, lifecycleEffect]]),
    async deleteEmbeddedDocuments(type, ids) {
      assert.equal(type, "ActiveEffect");
      if (lifecycleDeleteFailures > 0) {
        lifecycleDeleteFailures -= 1;
        throw new Error("simulated effect delete failure");
      }
      return ids.flatMap((id) => {
        const effect = this.effects.get(id);
        if (!effect) return [];
        this.effects.delete(id);
        return [effect];
      });
    },
  };
  actor.items.set(lifecycleWeapon.id, lifecycleWeapon);

  await service.recordSharpeningLifecycleEventAuthoritatively(
    {
      eventId: "lifecycle-damage-1",
      actorId: actor.id,
      itemId: lifecycleWeapon.id,
      effectId: lifecycleEffect.id,
      operationId: "lifecycle-effect",
      rollId: "damage-roll-1",
      originUserId: player.id,
    },
    "damage",
  );
  let lifecycleConfig = workflow.loadDowntimeConfig();
  assert.equal(lifecycleConfig.sharpeningLifecycle.pending.length, 1);
  assert.equal(lifecycleConfig.sharpeningLifecycle.pending[0].attempts, 1);
  assert.equal(lifecycleEffectData.flags[MODULE_ID].downtimeSharpen.charges, 3);
  assert.equal(
    socketEmissions.some(
      ([, payload]) =>
        payload.type === "downtime:sharpen-lifecycle-ack" &&
        payload.eventId === "lifecycle-damage-1",
    ),
    false,
    "a queued lifecycle write is not acknowledged before canonical mutation",
  );

  await service.reconcileSharpeningLifecycleQueue();
  lifecycleConfig = workflow.loadDowntimeConfig();
  assert.equal(lifecycleConfig.sharpeningLifecycle.pending.length, 0);
  assert.equal(
    lifecycleConfig.sharpeningLifecycle.completed.some(
      (entry) => entry.eventId === "lifecycle-damage-1",
    ),
    true,
  );
  assert.equal(lifecycleEffectData.flags[MODULE_ID].downtimeSharpen.charges, 2);
  assert.equal(
    socketEmissions.some(
      ([, payload]) =>
        payload.type === "downtime:sharpen-lifecycle-ack" &&
        payload.eventId === "lifecycle-damage-1",
    ),
    true,
    "the client is acknowledged only after the completed ledger is durable",
  );

  await service.recordSharpeningLifecycleEventAuthoritatively(
    {
      eventId: "lifecycle-damage-1",
      actorId: actor.id,
      itemId: lifecycleWeapon.id,
      effectId: lifecycleEffect.id,
      operationId: "lifecycle-effect",
      rollId: "damage-roll-1",
      originUserId: player.id,
    },
    "damage",
  );
  assert.equal(
    lifecycleEffectData.flags[MODULE_ID].downtimeSharpen.charges,
    2,
    "a completed lifecycle event is idempotent",
  );

  await service.recordSharpeningLifecycleEventAuthoritatively(
    {
      eventId: "lifecycle-rest-1",
      actorId: actor.id,
      itemId: lifecycleWeapon.id,
      effectId: lifecycleEffect.id,
      operationId: "lifecycle-effect",
      originUserId: player.id,
    },
    "long-rest",
  );
  lifecycleConfig = workflow.loadDowntimeConfig();
  assert.equal(lifecycleConfig.sharpeningLifecycle.pending.length, 1);
  assert.equal(lifecycleWeapon.effects.size, 1);
  await service.reconcileSharpeningLifecycleQueue();
  lifecycleConfig = workflow.loadDowntimeConfig();
  assert.equal(lifecycleConfig.sharpeningLifecycle.pending.length, 0);
  assert.equal(lifecycleWeapon.effects.size, 0);

  const replacementEffectSource = effects.buildSharpeningEffect({
    operationId: "replacement-effect",
    actorId: actor.id,
    itemId: lifecycleWeapon.id,
    damageType: "slashing",
    timestamp: 1_000,
    nativeDamagePart: false,
  });
  const replacementEffectData = clone(replacementEffectSource);
  const replacementEffect = {
    id: replacementEffectData._id,
    toObject: () => clone(replacementEffectData),
    async update() {
      throw new Error("a stale lifecycle event touched the replacement");
    },
  };
  lifecycleWeapon.effects.set(replacementEffect.id, replacementEffect);
  await service.recordSharpeningLifecycleEventAuthoritatively(
    {
      eventId: "stale-lifecycle-damage",
      actorId: actor.id,
      itemId: lifecycleWeapon.id,
      effectId: lifecycleEffect.id,
      operationId: "lifecycle-effect",
      rollId: "stale-damage-roll",
      originUserId: player.id,
    },
    "damage",
  );
  await service.recordSharpeningLifecycleEventAuthoritatively(
    {
      eventId: "stale-lifecycle-rest",
      actorId: actor.id,
      itemId: lifecycleWeapon.id,
      effectId: lifecycleEffect.id,
      operationId: "lifecycle-effect",
      originUserId: player.id,
    },
    "long-rest",
  );
  assert.equal(
    lifecycleWeapon.effects.has(replacementEffect.id),
    true,
    "delayed events for an old operation cannot consume or clear re-sharpening",
  );
  actor.items.delete(lifecycleWeapon.id);

  const serverTimeBefore = globalThis.game.time.serverTime;
  let block = await service.openDowntimeBlock({
    settlementId: "greyhaven",
    hours: 8,
    actorIds: [actor.id],
  });
  assert.match(block.opportunitySecret, /^[0-9a-f]{64}\.[0-9a-f]{64}$/);
  const playerProjection = await service.getPlayerProjectionForUser({
    userId: player.id,
    actorId: actor.id,
  });
  assert.equal("opportunitySecret" in playerProjection, false);
  assert.equal(
    JSON.stringify(playerProjection).includes(block.opportunitySecret),
    false,
    "the private opportunity secret never enters the owner projection",
  );
  await service.submitQueueAuthoritatively({
    userId: player.id,
    requestId: "submit-lay-low",
    blockId: block.id,
    actorId: actor.id,
    queue: [
      {
        id: "lay-low-1",
        activityId: "lay-low",
        hours: 4,
      },
    ],
  });
  block = await service.lockActiveDowntimeBlock(block.id);
  block = await service.planActiveDowntimeBlock(block.id);
  assert.equal(block.state, "planned");
  assert.equal(block.plan.operations.length, 1);
  assert.equal(block.plan.operations[0].settlementId, "greyhaven");
  const replayedPlan = await service.planActiveDowntimeBlock(block.id);
  assert.deepEqual(replayedPlan.plan, block.plan);
  const completed = await service.applyActiveDowntimeBlock(block.id);
  assert.equal(completed.state, "completed");
  assert.equal(
    workflow.loadDowntimeConfig().heat.greyhaven[actor.id],
    1,
    "Lay Low mutates only the character's local settlement Heat",
  );
  assert.equal(globalThis.game.time.serverTime, serverTimeBefore);
  assert.equal(workflow.getActiveDowntimeBlock(), null);
  const writesBeforeApplyReplay = settingWrites;
  assert.deepEqual(
    await service.applyActiveDowntimeBlock(block.id),
    completed,
    "a duplicate apply after a lost response replays the terminal receipt",
  );
  assert.equal(settingWrites, writesBeforeApplyReplay);

  assert.equal(
    await service.inspectDowntimeOperation(block.plan.operations[0]),
    "applied",
  );
  assert.equal(
    await service.inspectDowntimeOperation({
      ...block.plan.operations[0],
      operationId: "unapplied-heat",
      heatBefore: 1,
      heatAfter: 2,
    }),
    "unapplied",
    "a no-primary-write operation follows its Heat consequence during recovery",
  );
  const factionOperation = {
    operationId: "faction-consequence",
    actorId: actor.id,
    settlementId: "greyhaven",
    kind: "noop",
    factionWrite: {
      factionId: "faction-1",
      historyId: "downtime-history-1",
      standingBefore: 0,
      standingAfter: -1,
      delta: -1,
    },
  };
  settings.set("factions", [
    { id: "faction-1", name: "Watch", standing: 0, history: [] },
  ]);
  assert.equal(
    await service.inspectDowntimeOperation(factionOperation),
    "unapplied",
  );
  settings.set("factions", [
    { id: "faction-1", name: "Watch", standing: -2, history: [] },
  ]);
  assert.equal(
    await service.inspectDowntimeOperation(factionOperation),
    "uncertain",
    "standing drift is not misclassified as a safe retry",
  );
  settings.set("factions", [
    {
      id: "faction-1",
      name: "Watch",
      standing: -1,
      history: [{ id: "downtime-history-1", fromStanding: 0, toStanding: -1 }],
    },
  ]);
  assert.equal(
    await service.inspectDowntimeOperation(factionOperation),
    "applied",
  );

  const second = await service.openDowntimeBlock({
    settlementId: "greyhaven",
    hours: 4,
    actorIds: [actor.id],
  });
  assert.notEqual(
    second.opportunitySecret,
    block.opportunitySecret,
    "each downtime block receives a fresh private opportunity secret",
  );
  await service.lockActiveDowntimeBlock(second.id);
  const secondPlan = await service.planActiveDowntimeBlock(second.id);
  assert.equal(secondPlan.state, "planned");
  assert.equal(
    (await service.getWorkspaceProjection()).workflow.canCancel,
    true,
  );
  const cancelled = await service.cancelActiveDowntimeBlock(second.id);
  assert.equal(cancelled.state, "cancelled");
  const writesBeforeCancelReplay = settingWrites;
  assert.deepEqual(
    await service.cancelActiveDowntimeBlock(second.id),
    cancelled,
  );
  assert.equal(settingWrites, writesBeforeCancelReplay);

  const requestCollisionActor = makeActor({ id: "request-collision-actor" });
  actors.set(requestCollisionActor.id, requestCollisionActor);
  const requestCollisionBlock = await service.openDowntimeBlock({
    settlementId: "greyhaven",
    hours: 4,
    actorIds: [actor.id, requestCollisionActor.id],
  });
  const firstRecall = await service.recallSubmissionAuthoritatively({
    userId: player.id,
    requestId: "reused-recall-request",
    blockId: requestCollisionBlock.id,
    actorId: actor.id,
  });
  assert.deepEqual(
    await service.recallSubmissionAuthoritatively({
      userId: player.id,
      requestId: "reused-recall-request",
      blockId: requestCollisionBlock.id,
      actorId: actor.id,
    }),
    firstRecall,
    "an exact duplicate recall is idempotent",
  );
  await assert.rejects(
    service.recallSubmissionAuthoritatively({
      userId: player.id,
      requestId: "reused-recall-request",
      blockId: requestCollisionBlock.id,
      actorId: requestCollisionActor.id,
    }),
    /already used for another request/,
    "a request ID cannot be replayed against another Actor",
  );
  actor.ownership[assistant.id] = 3;
  await assert.rejects(
    service.recallSubmissionAuthoritatively({
      userId: assistant.id,
      requestId: "reused-recall-request",
      blockId: requestCollisionBlock.id,
      actorId: actor.id,
    }),
    /already used for another request/,
    "a request ID cannot be adopted by another owner",
  );
  delete actor.ownership[assistant.id];
  await assert.rejects(
    service.submitQueueAuthoritatively({
      userId: player.id,
      requestId: "reused-recall-request",
      blockId: requestCollisionBlock.id,
      actorId: actor.id,
      queue: [],
    }),
    /already used for another submission/,
    "a request ID cannot be reused across request kinds",
  );
  await service.cancelActiveDowntimeBlock(requestCollisionBlock.id);

  const explicitlyDeniedAssignedActor = makeActor({
    id: "explicitly-denied-assigned-actor",
  });
  explicitlyDeniedAssignedActor.ownership[player.id] = 0;
  actors.set(explicitlyDeniedAssignedActor.id, explicitlyDeniedAssignedActor);
  player.character = explicitlyDeniedAssignedActor.id;
  const deniedAssignmentBlock = await service.openDowntimeBlock({
    settlementId: "greyhaven",
    hours: 4,
    actorIds: [explicitlyDeniedAssignedActor.id],
  });
  const deniedProjection = await service.getPlayerProjectionForUser({
    userId: player.id,
    actorId: explicitlyDeniedAssignedActor.id,
  });
  assert.deepEqual(
    deniedProjection.actors,
    [],
    "an explicitly denied assigned character is absent from the player projection",
  );
  await assert.rejects(
    service.submitQueueAuthoritatively({
      userId: player.id,
      requestId: "denied-assignment-submit",
      blockId: deniedAssignmentBlock.id,
      actorId: explicitlyDeniedAssignedActor.id,
      queue: [],
    }),
    /do not own/,
    "an explicitly denied assigned character cannot submit a queue",
  );
  player.character = null;
  await service.cancelActiveDowntimeBlock(deniedAssignmentBlock.id);

  const reservedStockActorA = makeActor({ id: "reserved-stock-a" });
  const reservedStockActorB = makeActor({ id: "reserved-stock-b" });
  reservedStockActorA.name = "Ada";
  reservedStockActorB.name = "Bryn";
  actors.set(reservedStockActorA.id, reservedStockActorA);
  actors.set(reservedStockActorB.id, reservedStockActorB);
  const reservedItemUuid = "Compendium.test.items.Item.reserved-scarf";
  globalThis.fromUuid = async (uuid) =>
    uuid === reservedItemUuid
      ? {
          _id: "reserved-scarf",
          name: "Silk Scarf",
          type: "loot",
          system: {
            quantity: 1,
            rarity: "common",
            price: { value: 1, denomination: "gp" },
          },
          flags: {},
        }
      : null;
  const configWithMerchant = workflow.loadDowntimeConfig();
  await workflow.saveDowntimeConfig({
    ...configWithMerchant,
    settlements: configWithMerchant.settlements.map((settlement) =>
      settlement.id === "greyhaven"
        ? { ...settlement, linkedMerchantIds: ["reserved-stock-merchant"] }
        : settlement,
    ),
  });
  const setReservedStock = (quantity) =>
    merchantStore.saveMerchants([
      {
        id: "reserved-stock-merchant",
        name: "Market",
        items: [
          {
            uuid: reservedItemUuid,
            qty: quantity,
            startingQty: quantity,
            unlimited: false,
          },
        ],
      },
    ]);
  let hiddenShopliftRolls = 0;
  for (const reservedActor of [reservedStockActorA, reservedStockActorB]) {
    reservedActor.rollSkill = async () => {
      hiddenShopliftRolls += 1;
      return {
        total: 30,
        dice: [{ total: 20 }],
        formula: "1d20 + 10",
      };
    };
  }
  const queueBothShoplifts = async (downtimeBlock, targetId, requestPrefix) => {
    for (const [index, reservedActor] of [
      reservedStockActorA,
      reservedStockActorB,
    ].entries()) {
      await service.submitQueueAuthoritatively({
        userId: player.id,
        requestId: `${requestPrefix}-${index}`,
        blockId: downtimeBlock.id,
        actorId: reservedActor.id,
        queue: [
          {
            id: `shoplift-${index}`,
            activityId: "shoplift",
            hours: 4,
            targetId,
          },
        ],
      });
    }
  };

  await setReservedStock(1);
  let reservedStockBlock = await service.openDowntimeBlock({
    settlementId: "greyhaven",
    hours: 4,
    actorIds: [reservedStockActorA.id, reservedStockActorB.id],
  });
  let stockProjection = await service.getPlayerProjectionForUser({
    userId: player.id,
    actorId: reservedStockActorA.id,
  });
  const reservedTargetId = stockProjection.activities.find(
    (activity) => activity.id === "shoplift",
  ).targets[0].id;
  await queueBothShoplifts(reservedStockBlock, reservedTargetId, "reserve-one");
  reservedStockBlock = await service.lockActiveDowntimeBlock(
    reservedStockBlock.id,
  );
  await assert.rejects(
    service.planActiveDowntimeBlock(reservedStockBlock.id),
    /no unreserved finite stock/,
    "quantity one cannot be promised to two character queues",
  );
  assert.equal(
    hiddenShopliftRolls,
    0,
    "finite-stock conflicts are rejected before any hidden checks",
  );
  await service.cancelActiveDowntimeBlock(reservedStockBlock.id);

  await setReservedStock(2);
  reservedStockBlock = await service.openDowntimeBlock({
    settlementId: "greyhaven",
    hours: 4,
    actorIds: [reservedStockActorA.id, reservedStockActorB.id],
  });
  stockProjection = await service.getPlayerProjectionForUser({
    userId: player.id,
    actorId: reservedStockActorA.id,
  });
  await queueBothShoplifts(
    reservedStockBlock,
    stockProjection.activities.find((activity) => activity.id === "shoplift")
      .targets[0].id,
    "reserve-two",
  );
  reservedStockBlock = await service.lockActiveDowntimeBlock(
    reservedStockBlock.id,
  );
  reservedStockBlock = await service.planActiveDowntimeBlock(
    reservedStockBlock.id,
  );
  const plannedShoplifts = reservedStockBlock.plan.operations.filter(
    (operation) => operation.kind === "shoplift",
  );
  assert.equal(hiddenShopliftRolls, 2);
  assert.deepEqual(
    plannedShoplifts.map((operation) => [
      operation.quantityBefore,
      operation.quantityAfter,
    ]),
    [
      [2, 1],
      [1, 0],
    ],
    "quantity two produces one ordered finite-unit transfer per success",
  );
  await service.cancelActiveDowntimeBlock(reservedStockBlock.id);
  if (saved.fromUuid === undefined) delete globalThis.fromUuid;
  else globalThis.fromUuid = saved.fromUuid;

  const unchangedWalletActor = makeActor({ id: "unchanged-wallet" });
  const unchangedWallet = clone(unchangedWalletActor.system.currency);
  assert.equal(
    service.verifyFreshDowntimeOperationPreconditions(unchangedWalletActor, {
      kind: "currency",
      walletBefore: unchangedWallet,
      walletAfter: unchangedWallet,
    }).ok,
    true,
    "a genuine no-change currency outcome remains a valid fresh operation",
  );

  const ammoAfterActor = makeActor({
    id: "ammo-after-state",
    currency: { pp: 0, gp: 0, ep: 0, sp: 5, cp: 0 },
  });
  ammoAfterActor.addItem({
    _id: "crafted-arrows",
    name: "Arrow",
    type: "consumable",
    system: { quantity: 20 },
  });
  assert.equal(
    service.verifyFreshDowntimeOperationPreconditions(ammoAfterActor, {
      kind: "craft-ammunition",
      walletBefore: { pp: 0, gp: 1, ep: 0, sp: 0, cp: 0 },
      walletAfter: { pp: 0, gp: 0, ep: 0, sp: 5, cp: 0 },
      delivery: {
        itemId: "crafted-arrows",
        mode: "create",
        quantityBefore: 0,
        quantityAfter: 20,
      },
    }).ok,
    false,
    "fresh crafting cannot claim a coincidentally matching wallet/item post-state",
  );

  const wrongStackIdentityActor = makeActor({ id: "wrong-stack-identity" });
  wrongStackIdentityActor.addItem({
    _id: "planned-arrow-stack",
    name: "Arrow",
    type: "consumable",
    system: {
      quantity: 5,
      rarity: "common",
      properties: [],
      type: { value: "potion", subtype: "" },
    },
    flags: {},
  });
  const wrongStackOperation = {
    kind: "craft-ammunition",
    operationId: "wrong-stack-operation",
    actorId: wrongStackIdentityActor.id,
    recipeId: "arrows",
    walletBefore: clone(wrongStackIdentityActor.system.currency),
    walletAfter: { pp: 0, gp: 0, ep: 0, sp: 5, cp: 0 },
    delivery: {
      itemId: "planned-arrow-stack",
      mode: "stack",
      quantityBefore: 5,
      quantityAfter: 25,
    },
  };
  const freshWrongStack = service.verifyFreshDowntimeOperationPreconditions(
    wrongStackIdentityActor,
    wrongStackOperation,
  );
  assert.equal(freshWrongStack.ok, false);
  assert.equal(freshWrongStack.reason, "item-identity-drift");

  actors.set(wrongStackIdentityActor.id, wrongStackIdentityActor);
  assert.equal(
    await service.inspectDowntimeOperation(wrongStackOperation),
    "uncertain",
    "recovery cannot call a wrong-identity stack verified-unapplied from quantity alone",
  );
  wrongStackIdentityActor.system.currency = clone(
    wrongStackOperation.walletAfter,
  );
  wrongStackIdentityActor.items.get("planned-arrow-stack").system.quantity =
    wrongStackOperation.delivery.quantityAfter;
  assert.equal(
    await service.inspectDowntimeOperation(wrongStackOperation),
    "uncertain",
    "recovery cannot call a wrong-identity stack applied from wallet and quantity alone",
  );

  const preexistingPickpocketActor = makeActor({
    id: "pickpocket-after-state",
  });
  const preexistingPickpocketItem = items.markStolenSnapshot(
    {
      _id: "pickpocket-reward",
      name: "Coin Purse",
      type: "loot",
      system: { quantity: 1, price: { value: 1, denomination: "gp" } },
    },
    {
      settlementId: "greyhaven",
      targetType: "generated-mark",
      sourceId: "mark-race",
      operationId: "pickpocket-race",
      timestamp: 1_000,
      appraisedValueCp: 100,
    },
  );
  preexistingPickpocketActor.addItem(preexistingPickpocketItem);
  assert.equal(
    service.verifyFreshDowntimeOperationPreconditions(
      preexistingPickpocketActor,
      {
        kind: "pickpocket",
        operationId: "pickpocket-race",
        stolenItemSnapshot: preexistingPickpocketItem,
      },
    ).ok,
    false,
    "fresh pickpocketing cannot claim a preexisting deterministic reward",
  );

  const fenceAfterActor = makeActor({
    id: "fence-after-state",
    currency: { pp: 0, gp: 2, ep: 0, sp: 0, cp: 0 },
  });
  assert.equal(
    service.verifyFreshDowntimeOperationPreconditions(fenceAfterActor, {
      kind: "fence-stolen-goods",
      goodsTransferred: true,
      payoutCp: 100,
      walletBefore: { pp: 0, gp: 1, ep: 0, sp: 0, cp: 0 },
      walletAfter: { pp: 0, gp: 2, ep: 0, sp: 0, cp: 0 },
      itemSnapshots: [preexistingPickpocketItem],
    }).ok,
    false,
    "fresh fencing cannot claim absent goods plus a matching payout wallet",
  );

  const currencyRaceActor = makeActor({
    id: "currency-race-actor",
    currency: { pp: 0, gp: 0, ep: 0, sp: 5, cp: 0 },
  });
  actors.set(currencyRaceActor.id, currencyRaceActor);
  let currencyRaceWrites = 0;
  const updateCurrencyRaceActor =
    currencyRaceActor.update.bind(currencyRaceActor);
  currencyRaceActor.update = async (...args) => {
    currencyRaceWrites += 1;
    return updateCurrencyRaceActor(...args);
  };
  let replayGuardBlock = await workflow.createDowntimeBlock({
    id: "currency-race-block",
    settlementId: "greyhaven",
    budgetHours: 2,
    participants: [],
  });
  replayGuardBlock = await workflow.lockDowntimeBlock(replayGuardBlock.id);
  replayGuardBlock = await workflow.persistDowntimePlan(replayGuardBlock.id, {
    settlementId: "greyhaven",
    operations: [
      {
        operationId: "currency-race-operation",
        actorId: currencyRaceActor.id,
        settlementId: "greyhaven",
        kind: "currency",
        walletBefore: { pp: 0, gp: 1, ep: 0, sp: 0, cp: 0 },
        walletAfter: { pp: 0, gp: 0, ep: 0, sp: 5, cp: 0 },
        summary: "Coincidentally matching wallet",
      },
    ],
  });
  replayGuardBlock = await service.applyActiveDowntimeBlock(
    replayGuardBlock.id,
  );
  assert.equal(replayGuardBlock.state, "needs-review");
  assert.equal(
    replayGuardBlock.operationLedger["currency-race-operation"].state,
    "needs-review",
  );
  assert.equal(currencyRaceWrites, 0);
  await workflow.cancelDowntimeBlock(replayGuardBlock.id, {
    reason: "currency replay guard verified",
  });

  const shopliftRaceActor = makeActor({ id: "shoplift-race-actor" });
  actors.set(shopliftRaceActor.id, shopliftRaceActor);
  let shopliftRaceCreates = 0;
  const createShopliftRaceItem =
    shopliftRaceActor.createEmbeddedDocuments.bind(shopliftRaceActor);
  shopliftRaceActor.createEmbeddedDocuments = async (...args) => {
    shopliftRaceCreates += 1;
    return createShopliftRaceItem(...args);
  };
  const shopliftRaceSnapshot = items.markStolenSnapshot(
    {
      _id: "shoplift-race-reward",
      name: "Silk Scarf",
      type: "loot",
      system: { quantity: 1, price: { value: 1, denomination: "gp" } },
    },
    {
      settlementId: "greyhaven",
      targetType: "merchant-stock",
      sourceId: "Compendium.test.items.Item.silk-scarf",
      merchantId: "shoplift-race-merchant",
      operationId: "shoplift-race-operation",
      timestamp: 1_000,
      appraisedValueCp: 100,
    },
  );
  settings.set("merchants", [
    {
      id: "shoplift-race-merchant",
      name: "Market",
      items: [
        {
          uuid: "Compendium.test.items.Item.silk-scarf",
          qty: 0,
          startingQty: 1,
          unlimited: false,
        },
      ],
    },
  ]);
  replayGuardBlock = await workflow.createDowntimeBlock({
    id: "shoplift-race-block",
    settlementId: "greyhaven",
    budgetHours: 4,
    participants: [],
  });
  replayGuardBlock = await workflow.lockDowntimeBlock(replayGuardBlock.id);
  replayGuardBlock = await workflow.persistDowntimePlan(replayGuardBlock.id, {
    settlementId: "greyhaven",
    operations: [
      {
        operationId: "shoplift-race-operation",
        actorId: shopliftRaceActor.id,
        settlementId: "greyhaven",
        kind: "shoplift",
        merchantId: "shoplift-race-merchant",
        itemUuid: "Compendium.test.items.Item.silk-scarf",
        quantityBefore: 1,
        quantityAfter: 0,
        stolenItemSnapshot: shopliftRaceSnapshot,
        summary: "Stock already consumed by another transaction",
      },
    ],
  });
  replayGuardBlock = await service.applyActiveDowntimeBlock(
    replayGuardBlock.id,
  );
  assert.equal(replayGuardBlock.state, "needs-review");
  assert.equal(
    replayGuardBlock.operationLedger["shoplift-race-operation"].state,
    "needs-review",
  );
  assert.equal(shopliftRaceCreates, 0);
  assert.equal(shopliftRaceActor.items.has(shopliftRaceSnapshot._id), false);
  assert.equal(
    merchantStore.findMerchant("shoplift-race-merchant").items[0].qty,
    0,
  );
  await workflow.cancelDowntimeBlock(replayGuardBlock.id, {
    reason: "shoplift replay guard verified",
  });

  const recoveryActor = makeActor({
    id: "recovery-actor",
    currency: { pp: 0, gp: 0, ep: 0, sp: 5, cp: 0 },
  });
  actors.set(recoveryActor.id, recoveryActor);
  let recoveryWalletWrites = 0;
  const updateRecoveryActor = recoveryActor.update.bind(recoveryActor);
  recoveryActor.update = async (...args) => {
    recoveryWalletWrites += 1;
    return updateRecoveryActor(...args);
  };
  let recoveryBlock = await workflow.createDowntimeBlock({
    id: "applied-recovery-block",
    settlementId: "greyhaven",
    budgetHours: 2,
    participants: [],
  });
  recoveryBlock = await workflow.lockDowntimeBlock(recoveryBlock.id);
  recoveryBlock = await workflow.persistDowntimePlan(recoveryBlock.id, {
    settlementId: "greyhaven",
    operations: [
      {
        operationId: "applied-recovery-operation",
        actorId: recoveryActor.id,
        settlementId: "greyhaven",
        kind: "currency",
        walletBefore: { pp: 0, gp: 1, ep: 0, sp: 0, cp: 0 },
        walletAfter: { pp: 0, gp: 0, ep: 0, sp: 5, cp: 0 },
        summary: "Recovered wallet write",
      },
    ],
  });
  recoveryBlock = await workflow.beginDowntimeApplication(recoveryBlock.id);
  await workflow.claimDowntimeOperation(
    recoveryBlock.id,
    "applied-recovery-operation",
    { attemptId: "interrupted-attempt", at: 1_100 },
  );
  await workflow.resolveDowntimeOperation(
    recoveryBlock.id,
    "applied-recovery-operation",
    {
      state: "needs-review",
      attemptId: "interrupted-attempt",
      reason: "authority changed after canonical wallet write",
      at: 1_101,
    },
  );
  assert.equal(
    workflow.getActiveDowntimeBlock().state,
    "applying",
    "the interruption fixture stops after the operation review record but before the block transition",
  );
  const recoveredBlock = await service.recoverActiveDowntimeBlock(
    recoveryBlock.id,
  );
  assert.equal(recoveredBlock.state, "completed");
  assert.equal(
    recoveredBlock.operationLedger["applied-recovery-operation"].state,
    "applied",
  );
  assert.equal(
    recoveredBlock.operationLedger["applied-recovery-operation"].receipt
      .recovered,
    true,
  );
  assert.equal(
    recoveryWalletWrites,
    0,
    "recovery records canonical application without replaying the wallet write",
  );

  const stolenSnapshot = items.markStolenSnapshot(
    {
      _id: "source",
      name: "Silver Ring",
      type: "loot",
      system: { quantity: 1, price: { value: 30, denomination: "gp" } },
    },
    {
      settlementId: "greyhaven",
      targetType: "generated-mark",
      sourceId: "mark-1",
      operationId: "theft-1",
      timestamp: 1_000,
      appraisedValueCp: 3_000,
    },
  );
  const stolenIssuance = stolenLedger.buildStolenGoodsIssuance({
    actorId: actor.id,
    snapshot: stolenSnapshot,
  });
  assert.ok(stolenIssuance);
  await workflow.updateDowntimeConfig((config) => {
    const issued = stolenLedger.issueStolenGoodsRecord(
      config.stolenGoods,
      stolenIssuance,
    );
    assert.equal(issued.ok, true);
    return { ...config, stolenGoods: issued.ledger };
  });
  actor.addItem(stolenSnapshot);
  assert.equal(
    service.verifyStolenBundlePrecondition(actor, {
      itemSnapshots: [stolenSnapshot],
      stolenIssuanceRecords: [stolenIssuance],
    }).ok,
    true,
  );
  const normalizedFenceQueue = service.canonicalizeDowntimeQueueSubmission([
    {
      id: "ledger-fence",
      activityId: "fence-stolen-goods",
      hours: 8,
      skill: "deception",
      targetIds: [stolenSnapshot._id],
    },
  ]).queue;
  let fenceContext = await targets.buildActorDowntimeContext({
    block: {
      id: "ledger-target-block",
      opportunitySecret: `${"1".repeat(64)}.${"a".repeat(64)}`,
    },
    actor,
    settlement: workflow.loadDowntimeConfig().settlements[0],
    config: workflow.loadDowntimeConfig(),
    queue: normalizedFenceQueue,
  });
  assert.deepEqual(
    fenceContext.playerActivities
      .find((activity) => activity.id === "fence-stolen-goods")
      .targets.map((target) => target.id),
    [stolenSnapshot._id],
    "only privately issued goods are exposed as fencing choices",
  );
  assert.equal(
    fenceContext.targetFacts[normalizedFenceQueue[0].targetId].valueCp,
    3_000,
    "the authoritative bundle value comes from the issuance ledger",
  );

  const additionalIssuedSnapshots = [
    { source: "bronze-pin", operationId: "theft-2", valueCp: 400 },
    { source: "ivory-comb", operationId: "theft-3", valueCp: 600 },
  ].map(({ source, operationId, valueCp }) =>
    items.markStolenSnapshot(
      {
        _id: source,
        name: source === "bronze-pin" ? "Bronze Pin" : "Ivory Comb",
        type: "loot",
        system: {
          quantity: 1,
          price: { value: valueCp / 100, denomination: "gp" },
        },
      },
      {
        settlementId: "greyhaven",
        targetType: "generated-mark",
        sourceId: `${source}-mark`,
        operationId,
        timestamp: 1_000,
        appraisedValueCp: valueCp,
      },
    ),
  );
  const additionalIssuances = additionalIssuedSnapshots.map((snapshot) =>
    stolenLedger.buildStolenGoodsIssuance({ actorId: actor.id, snapshot }),
  );
  for (const snapshot of additionalIssuedSnapshots) actor.addItem(snapshot);
  await workflow.updateDowntimeConfig((config) => {
    let ledger = config.stolenGoods;
    for (const issuance of additionalIssuances) {
      const issued = stolenLedger.issueStolenGoodsRecord(ledger, issuance);
      assert.equal(issued.ok, true);
      ledger = issued.ledger;
    }
    return { ...config, stolenGoods: ledger };
  });
  const selectedBundleQueue = service.canonicalizeDowntimeQueueSubmission([
    {
      id: "ledger-selected-bundle",
      activityId: "fence-stolen-goods",
      hours: 8,
      skill: "deception",
      targetIds: [stolenSnapshot._id, additionalIssuedSnapshots[0]._id],
    },
  ]).queue;
  fenceContext = await targets.buildActorDowntimeContext({
    block: {
      id: "ledger-subset-block",
      opportunitySecret: `${"4".repeat(64)}.${"b".repeat(64)}`,
    },
    actor,
    settlement: workflow.loadDowntimeConfig().settlements[0],
    config: workflow.loadDowntimeConfig(),
    queue: selectedBundleQueue,
  });
  const selectedBundleFact =
    fenceContext.targetFacts[selectedBundleQueue[0].targetId];
  assert.equal(selectedBundleFact.valueCp, 3_400);
  assert.deepEqual(
    selectedBundleFact.itemSnapshots.map((snapshot) => snapshot._id),
    selectedBundleQueue[0].targetIds,
    "the authoritative fact contains exactly the selected two-item subset",
  );
  assert.deepEqual(
    selectedBundleFact.issuanceRecords.map((record) => record.itemId),
    selectedBundleQueue[0].targetIds,
  );
  assert.equal(
    selectedBundleFact.itemSnapshots.some(
      (snapshot) => snapshot._id === additionalIssuedSnapshots[1]._id,
    ),
    false,
    "an unselected issued item is not silently added to the bundle",
  );

  const copiedSnapshot = clone(stolenSnapshot);
  copiedSnapshot._id = "forged-stolen-copy";
  actor.addItem(copiedSnapshot);
  fenceContext = await targets.buildActorDowntimeContext({
    block: {
      id: "ledger-copy-block",
      opportunitySecret: `${"2".repeat(64)}.${"c".repeat(64)}`,
    },
    actor,
    settlement: workflow.loadDowntimeConfig().settlements[0],
    config: workflow.loadDowntimeConfig(),
    queue: service.canonicalizeDowntimeQueueSubmission([
      {
        id: "forged-copy-fence",
        activityId: "fence-stolen-goods",
        hours: 8,
        skill: "deception",
        targetIds: [copiedSnapshot._id],
      },
    ]).queue,
  });
  assert.equal(
    fenceContext.playerActivities
      .find((activity) => activity.id === "fence-stolen-goods")
      .targets.some((target) => target.id === copiedSnapshot._id),
    false,
    "copying visible stolen flags does not copy the private issuance proof",
  );
  assert.deepEqual(
    fenceContext.allowedTargetIds["fence-stolen-goods"],
    [],
    "a forged copy cannot materialize an authoritative bundle target",
  );

  actor.items.get(stolenSnapshot._id).flags[MODULE_ID].stolen.appraisedValueCp =
    99_999;
  fenceContext = await targets.buildActorDowntimeContext({
    block: {
      id: "ledger-value-block",
      opportunitySecret: `${"3".repeat(64)}.${"d".repeat(64)}`,
    },
    actor,
    settlement: workflow.loadDowntimeConfig().settlements[0],
    config: workflow.loadDowntimeConfig(),
    queue: normalizedFenceQueue,
  });
  assert.equal(
    fenceContext.allowedTargetIds["fence-stolen-goods"].length,
    0,
    "changing a client-writable appraised value invalidates the exact issuance proof",
  );
  actor.items.get(stolenSnapshot._id).flags[MODULE_ID].stolen.appraisedValueCp =
    3_000;
  actor.items.get(stolenSnapshot._id).flags[MODULE_ID].stolen.merchantId =
    "forged-merchant";
  assert.equal(
    service.verifyStolenBundlePrecondition(actor, {
      itemSnapshots: [stolenSnapshot],
      stolenIssuanceRecords: [stolenIssuance],
    }).reason,
    "stolen-bundle-drift",
  );
  actor.items.get(stolenSnapshot._id).flags[MODULE_ID].stolen.merchantId = null;

  const ledgerRecoveryActor = makeActor({ id: "ledger-recovery-actor" });
  actors.set(ledgerRecoveryActor.id, ledgerRecoveryActor);
  const ledgerRecoverySnapshot = items.markStolenSnapshot(
    {
      _id: "ledger-recovery-source",
      name: "Recovered Coin Purse",
      type: "loot",
      system: { quantity: 1, price: { value: 2, denomination: "gp" } },
    },
    {
      settlementId: "greyhaven",
      targetType: "generated-mark",
      sourceId: "ledger-recovery-mark",
      operationId: "ledger-recovery-operation",
      timestamp: 1_200,
      appraisedValueCp: 200,
    },
  );
  const ledgerRecoveryIssuance = stolenLedger.buildStolenGoodsIssuance({
    actorId: ledgerRecoveryActor.id,
    snapshot: ledgerRecoverySnapshot,
  });
  ledgerRecoveryActor.addItem(ledgerRecoverySnapshot);
  let ledgerRecoveryCreates = 0;
  const createLedgerRecoveryItem =
    ledgerRecoveryActor.createEmbeddedDocuments.bind(ledgerRecoveryActor);
  ledgerRecoveryActor.createEmbeddedDocuments = async (...args) => {
    ledgerRecoveryCreates += 1;
    return createLedgerRecoveryItem(...args);
  };
  let ledgerRecoveryBlock = await workflow.createDowntimeBlock({
    id: "ledger-recovery-block",
    settlementId: "greyhaven",
    budgetHours: 2,
    participants: [],
  });
  ledgerRecoveryBlock = await workflow.lockDowntimeBlock(
    ledgerRecoveryBlock.id,
  );
  ledgerRecoveryBlock = await workflow.persistDowntimePlan(
    ledgerRecoveryBlock.id,
    {
      settlementId: "greyhaven",
      operations: [
        {
          operationId: "ledger-recovery-operation",
          actorId: ledgerRecoveryActor.id,
          settlementId: "greyhaven",
          kind: "pickpocket",
          stolenItemSnapshot: ledgerRecoverySnapshot,
          stolenIssuance: ledgerRecoveryIssuance,
          summary: "Recover issued theft provenance",
        },
      ],
    },
  );
  ledgerRecoveryBlock = await workflow.beginDowntimeApplication(
    ledgerRecoveryBlock.id,
  );
  await workflow.claimDowntimeOperation(
    ledgerRecoveryBlock.id,
    "ledger-recovery-operation",
    { attemptId: "ledger-interrupted-attempt", at: 1_201 },
  );
  await workflow.resolveDowntimeOperation(
    ledgerRecoveryBlock.id,
    "ledger-recovery-operation",
    {
      state: "needs-review",
      attemptId: "ledger-interrupted-attempt",
      reason: "item delivery committed before issuance checkpoint",
      at: 1_202,
    },
  );
  ledgerRecoveryBlock = await service.recoverActiveDowntimeBlock(
    ledgerRecoveryBlock.id,
  );
  assert.equal(ledgerRecoveryBlock.state, "completed");
  assert.equal(ledgerRecoveryCreates, 0, "recovery never duplicates the item");
  assert.equal(
    stolenLedger.stolenGoodsRecordsEqual(
      stolenLedger.stolenGoodsRecord(
        workflow.loadDowntimeConfig(),
        ledgerRecoveryIssuance.itemId,
      ),
      ledgerRecoveryIssuance,
    ),
    true,
    "recovery checkpoints the issuance after observing the canonical delivery",
  );

  const fenceApplyActor = makeActor({
    id: "ledger-fence-actor",
    currency: { pp: 0, gp: 0, ep: 0, sp: 0, cp: 0 },
  });
  actors.set(fenceApplyActor.id, fenceApplyActor);
  const fenceApplySnapshot = items.markStolenSnapshot(
    {
      _id: "fence-apply-source",
      name: "Stamped Silver Brooch",
      type: "loot",
      system: { quantity: 1, price: { value: 2, denomination: "gp" } },
    },
    {
      settlementId: "greyhaven",
      targetType: "generated-mark",
      sourceId: "fence-apply-mark",
      operationId: "fence-source-operation",
      timestamp: 1_300,
      appraisedValueCp: 200,
    },
  );
  const fenceApplyIssuance = stolenLedger.buildStolenGoodsIssuance({
    actorId: fenceApplyActor.id,
    snapshot: fenceApplySnapshot,
  });
  const fenceApplyConsumption = stolenLedger.buildStolenGoodsConsumption(
    fenceApplyIssuance,
    { fenceOperationId: "fence-apply-operation", consumedAt: 1_301 },
  );
  fenceApplyActor.addItem(fenceApplySnapshot);
  await workflow.updateDowntimeConfig((config) => {
    const issued = stolenLedger.issueStolenGoodsRecord(
      config.stolenGoods,
      fenceApplyIssuance,
    );
    assert.equal(issued.ok, true);
    return { ...config, stolenGoods: issued.ledger };
  });
  let fenceApplyBlock = await workflow.createDowntimeBlock({
    id: "ledger-fence-apply-block",
    settlementId: "greyhaven",
    budgetHours: 2,
    participants: [],
  });
  fenceApplyBlock = await workflow.lockDowntimeBlock(fenceApplyBlock.id);
  fenceApplyBlock = await workflow.persistDowntimePlan(fenceApplyBlock.id, {
    settlementId: "greyhaven",
    operations: [
      {
        operationId: "fence-apply-operation",
        actorId: fenceApplyActor.id,
        settlementId: "greyhaven",
        kind: "fence-stolen-goods",
        itemSnapshots: [fenceApplySnapshot],
        stolenIssuanceRecords: [fenceApplyIssuance],
        stolenConsumptionRecords: [fenceApplyConsumption],
        bundleValueCp: 200,
        payoutCp: 100,
        goodsTransferred: true,
        walletBefore: { pp: 0, gp: 0, ep: 0, sp: 0, cp: 0 },
        walletAfter: { pp: 0, gp: 1, ep: 0, sp: 0, cp: 0 },
        summary: "Fence verified brooch",
      },
    ],
  });
  fenceApplyBlock = await service.applyActiveDowntimeBlock(fenceApplyBlock.id);
  assert.equal(fenceApplyBlock.state, "completed");
  assert.equal(fenceApplyActor.items.has(fenceApplySnapshot._id), false);
  assert.deepEqual(fenceApplyActor.system.currency, {
    pp: 0,
    gp: 1,
    ep: 0,
    sp: 0,
    cp: 0,
  });
  assert.equal(
    stolenLedger.stolenGoodsRecordsEqual(
      stolenLedger.stolenGoodsRecord(
        workflow.loadDowntimeConfig(),
        fenceApplyIssuance.itemId,
      ),
      fenceApplyConsumption,
    ),
    true,
    "verified fencing retires the private issuance without deleting its audit proof",
  );

  let itemCreates = 0;
  const guardedActor = {
    id: "guarded-actor",
    items: new Map(),
    async createEmbeddedDocuments() {
      itemCreates += 1;
      return [];
    },
  };
  const deniedDelivery = await items.applyStolenItemDelivery(
    guardedActor,
    stolenSnapshot,
    { authorizeWrite: () => false },
  );
  assert.equal(deniedDelivery.reason, "authority-lost");
  assert.equal(deniedDelivery.provenUnapplied, true);
  assert.equal(itemCreates, 0);
  const deleteGuardActor = makeActor({ id: "delete-guard" });
  deleteGuardActor.addItem(stolenSnapshot);
  let itemDeletes = 0;
  const deleteItems =
    deleteGuardActor.deleteEmbeddedDocuments.bind(deleteGuardActor);
  deleteGuardActor.deleteEmbeddedDocuments = async (...args) => {
    itemDeletes += 1;
    return deleteItems(...args);
  };
  const deniedDelete = await items.removeStolenItemDelivery(
    deleteGuardActor,
    stolenSnapshot,
    { authorizeWrite: () => false },
  );
  assert.equal(deniedDelete.reason, "authority-lost");
  assert.equal(deniedDelete.provenUnapplied, true);
  assert.equal(itemDeletes, 0);

  const currencyGuardActor = makeActor({ id: "currency-guard" });
  currencyGuardActor.addItem({
    _id: "woodcarver-tools",
    name: "Woodcarver's Tools",
    type: "tool",
    system: { quantity: 1 },
  });
  let currencyWrites = 0;
  const writeCurrency = currencyGuardActor.update.bind(currencyGuardActor);
  currencyGuardActor.update = async (...args) => {
    currencyWrites += 1;
    return writeCurrency(...args);
  };
  const deniedCurrency = await items.applyAmmoCraftOperation(
    currencyGuardActor,
    {
      toolKeys: ["woodcarver"],
      walletBefore: { pp: 0, gp: 1, ep: 0, sp: 0, cp: 0 },
      walletAfter: { pp: 0, gp: 0, ep: 0, sp: 5, cp: 0 },
      delivery: {
        itemId: "guarded-arrows",
        mode: "create",
        quantityBefore: 0,
        quantityAfter: 20,
        snapshot: {
          _id: "guarded-arrows",
          name: "Arrows",
          type: "consumable",
          system: { quantity: 20 },
        },
      },
    },
    { authorizeWrite: () => false },
  );
  assert.equal(deniedCurrency.reason, "authority-lost");
  assert.equal(deniedCurrency.provenUnapplied, true);
  assert.equal(currencyWrites, 0);

  let effectCreates = 0;
  const guardedWeapon = {
    id: "guarded-sword",
    name: "Longsword",
    type: "weapon",
    effects: new Map(),
    system: {
      rarity: "",
      properties: new Set(),
      activities: new Map([
        [
          "attack",
          {
            type: "attack",
            attack: { type: { value: "melee" } },
            damage: { parts: [{ types: new Set(["slashing"]) }] },
          },
        ],
      ]),
    },
    async createEmbeddedDocuments() {
      effectCreates += 1;
      return [];
    },
  };
  const deniedEffect = await effects.applySharpeningEffect(guardedWeapon, {
    operationId: "guarded-effect",
    actorId: guardedActor.id,
    timestamp: 1_000,
    authorizeWrite: () => false,
  });
  assert.equal(deniedEffect.reason, "authority-lost");
  assert.equal(effectCreates, 0);
  const effectSource = effects.buildSharpeningEffect({
    operationId: "guarded-existing-effect",
    actorId: guardedActor.id,
    itemId: guardedWeapon.id,
    damageType: "slashing",
    timestamp: 1_000,
  });
  let effectUpdates = 0;
  let effectDeletes = 0;
  const effectDocument = {
    id: effectSource._id,
    toObject: () => clone(effectSource),
    async update() {
      effectUpdates += 1;
      return effectDocument;
    },
  };
  guardedWeapon.effects.set(effectDocument.id, effectDocument);
  guardedWeapon.deleteEmbeddedDocuments = async () => {
    effectDeletes += 1;
    return [];
  };
  const deniedEffectUpdate = await effects.consumeSharpeningCharge(
    guardedWeapon,
    "damage-roll-1",
    { authorizeWrite: () => false },
  );
  assert.equal(deniedEffectUpdate.reason, "authority-lost");
  assert.equal(effectUpdates, 0);
  const deniedEffectDelete = await effects.clearSharpeningOnLongRest(
    { items: [guardedWeapon] },
    { authorizeWrite: () => false },
  );
  assert.equal(deniedEffectDelete.ok, false);
  assert.equal(effectDeletes, 0);

  settings.set("merchants", [
    { id: "merchant-1", name: "Market", items: [], playerAccess: true },
  ]);
  await assert.rejects(
    merchantStore.updateMerchant(
      "merchant-1",
      (merchant) => ({ ...merchant, name: "Forged" }),
      { authorizeWrite: () => false },
    ),
    /MerchantWriteAuthorityLost/,
  );
  assert.equal(merchantStore.findMerchant("merchant-1").name, "Market");

  settings.set("factions", [
    { id: "faction-1", name: "Watch", standing: 0, history: [] },
  ]);
  await assert.rejects(
    factionStore.updateFaction(
      "faction-1",
      (faction) => ({ ...faction, standing: -1 }),
      { authorizeWrite: () => false },
    ),
    /FactionWriteAuthorityLost/,
  );
  assert.equal(factionStore.loadFactions()[0].standing, 0);
} finally {
  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) delete globalThis[key];
    else globalThis[key] = value;
  }
}

process.stdout.write("downtime authoritative service passed\n");
