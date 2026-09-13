import assert from "node:assert/strict";

const saved = Object.fromEntries(
  ["game", "CONST", "localStorage", "fromUuid"].map((key) => [
    key,
    globalThis[key],
  ]),
);

try {
  const gm = { id: "gm-research", isGM: true, role: 4, active: true };
  const player = {
    id: "player-research",
    isGM: false,
    role: 1,
    active: true,
  };
  const users = new Map([
    [gm.id, gm],
    [player.id, player],
  ]);
  users.activeGM = gm;
  const storage = new Map();
  globalThis.localStorage = {
    getItem: (key) => storage.get(String(key)) ?? null,
    setItem: (key, value) => storage.set(String(key), String(value)),
    removeItem: (key) => storage.delete(String(key)),
  };
  globalThis.CONST = {
    DOCUMENT_OWNERSHIP_LEVELS: { NONE: 0, OBSERVER: 2, OWNER: 3 },
    USER_ROLES: { GAMEMASTER: 4 },
  };
  const privateSettings = new Map();
  globalThis.game = {
    settings: {
      get: (_module, key) => privateSettings.get(key),
      set: async (_module, key, value) =>
        privateSettings.set(key, structuredClone(value)),
    },
    user: gm,
    users,
    world: { id: "research-test-world" },
  };

  const rules = await import("./downtime/research.js");
  const store = await import("./downtime/research-store.js");
  const workflow = await import("./downtime/research-workflow.js");
  const { sanitizePlayerDowntimeSnapshot } =
    await import("./downtime/ui-adapter.js");

  assert.deepEqual(
    rules.RESEARCH_CATEGORIES.map(({ id }) => id),
    [
      "anything",
      "creature",
      "person",
      "place",
      "faction",
      "event",
      "object",
      "lead",
      "hideout",
    ],
    "every supported research category remains available",
  );

  assert.deepEqual(
    rules.normalizeResearchRequest({
      request: "Surprise me.",
      category: "creature",
      subjectId: "Actor.secret",
      subjectText: "Secret creature",
      discoverNew: true,
    }),
    {
      request: "Surprise me.",
      category: "creature",
      subjectId: "",
      subjectText: "",
      discoverNew: true,
      mode: "explore",
    },
    "open discovery ignores conflicting named-subject fields",
  );

  const hiddenSeed = await store.saveResearchSeed({
    id: "salt-stalker",
    title: "The Salt Stalker",
    category: "creature",
    gmSummary: "A homebrew predator that follows brine trails.",
    playerKnown: false,
    discoverable: true,
    difficulty: "Hard",
    dc: 16,
    risk: 0,
    times: ["day", "night"],
    skills: ["inv", "nat"],
    factCards: [
      { id: "tracks", tier: 1, text: "Its footprints crystallize at dawn" },
      { id: "sense", tier: 2, text: "It hunts by tasting salt in the air" },
      { id: "weakness", tier: 3, text: "Fresh water blinds it briefly" },
    ],
    actionableDiscovery: "Flood its lair before entering.",
    complicationText: "A collector hears that the party is asking.",
  });
  const knownSeed = await store.saveResearchSeed({
    id: "ashen-knives",
    title: "The Ashen Knives",
    category: "faction",
    playerKnown: true,
    discoverable: true,
    dc: 14,
    risk: 12,
    times: ["night"],
    skills: ["per", "ins"],
    factCards: [{ tier: 1, text: "They mark paid informants with grey cord" }],
  });
  const closedKnownSeed = await store.saveResearchSeed({
    id: "sealed-ledger",
    title: "The Sealed Ledger",
    category: "event",
    playerKnown: true,
    discoverable: false,
    dc: 14,
    risk: 8,
    times: ["night"],
    skills: ["his"],
    factCards: [{ tier: 1, text: "Its first page bears the reeve's cipher" }],
  });
  assert.equal(rules.publicResearchSubject(hiddenSeed, "day"), null);
  const publicKnown = rules.publicResearchSubject(knownSeed, "night");
  assert.equal(publicKnown.label, "The Ashen Knives");
  assert.equal(Object.hasOwn(publicKnown, "dc"), false);
  assert.equal(publicKnown.profiles.length, 4);
  assert.equal(
    publicKnown.profiles.every(
      (profile) =>
        !Object.hasOwn(profile, "dc") &&
        [4, 8].includes(profile.hours) &&
        ["per", "ins"].includes(profile.skill),
    ),
    true,
    "known-subject outlooks expose labels and percentages without DCs",
  );
  assert.doesNotMatch(JSON.stringify(publicKnown), /grey cord|factCards/);
  assert.equal(
    rules.researchSeedEligible(
      closedKnownSeed,
      {
        category: "event",
        subjectId: "research-seed:sealed-ledger",
      },
      "night",
      "his",
    ),
    true,
    "a known subject remains researchable when closed to random discovery",
  );
  assert.equal(
    rules.researchSeedEligible(
      closedKnownSeed,
      { category: "event", discoverNew: true },
      "night",
      "his",
    ),
    false,
  );

  const dayChallenge = rules.researchChallenge({
    seed: hiddenSeed,
    timeOfDay: "day",
    skill: "inv",
    hours: 8,
  });
  const nightChallenge = rules.researchChallenge({
    seed: hiddenSeed,
    timeOfDay: "night",
    skill: "inv",
    hours: 8,
  });
  assert.notEqual(dayChallenge.risk, nightChallenge.risk);
  assert.equal(
    Object.hasOwn(rules.publicResearchSubject(knownSeed, "night"), "dc"),
    false,
  );
  for (const { id: skill } of rules.RESEARCH_APPROACHES) {
    for (const timeOfDay of ["day", "night"]) {
      for (const hours of [4, 8]) {
        const challenge = rules.researchChallenge({
          timeOfDay,
          skill,
          hours,
        });
        assert.equal(Number.isInteger(challenge.dc), true);
        assert.equal(challenge.risk >= 0 && challenge.risk <= 100, true);
        assert.equal(Object.hasOwn(challenge, "difficulty"), true);
      }
    }
  }

  const actor = {
    id: "researcher-1",
    name: "Mira",
    ownership: { default: 0, [player.id]: 3 },
  };
  const block = {
    id: "research-block-1",
    settlementId: "haven",
    locationName: "Haven Archives",
    timeOfDay: "day",
  };
  await store.saveResearchBlock(block.id, block);
  const openQueue = [
    {
      id: "research-choice-1",
      activityId: rules.RESEARCH_ID,
      hours: 8,
      skill: "inv",
      research: {
        request: "Find a creature we have overlooked.",
        category: "creature",
        discoverNew: true,
      },
      guidedRoll: { total: 10, formula: "1d20 + 4" },
    },
  ];
  const openAttempt = await workflow.prepareResearchAttempt(
    block,
    actor,
    openQueue,
  );
  assert.equal(openAttempt.tier, 1);
  assert.equal(openAttempt.subject, "The Salt Stalker");
  assert.equal(openAttempt.revealedFactCards.length, 1);
  assert.match(openAttempt.revealedFactCards[0].text, /crystallize/);
  assert.doesNotMatch(
    JSON.stringify(openAttempt),
    /tasting salt|Fresh water|gmSummary|dc/,
  );
  assert.match(
    workflow.researchSummary(openAttempt),
    /Difficulty: Challenging\./,
  );
  assert.match(
    workflow.researchSummary(openAttempt),
    /Complication chance: 0%\./,
  );
  const preparedOperation = await workflow.buildResearchOperation({
    block,
    actor,
    operationId: "research-operation-1",
    createdAt: 100,
  });
  assert.equal(preparedOperation.researchApproved, true);
  assert.equal(preparedOperation.selectedOutcomeIndex, 1);
  assert.equal(preparedOperation.researchResult.factCards.length, 1);
  assert.doesNotMatch(
    JSON.stringify(preparedOperation),
    /Fresh water|seedSnapshot|gmSummary/,
  );

  const incompleteHiddenSeed = await store.saveResearchSeed({
    id: "sealed-lens",
    title: "The Sealed Lens",
    category: "object",
    gmSummary: "A homebrew relic that must remain private until approval.",
    playerKnown: false,
    discoverable: true,
    dc: 5,
    risk: 0,
    times: ["day"],
    skills: ["arc"],
    factCards: [
      { tier: 1, text: "The brass rim is warm" },
      { tier: 2, text: "The glass remembers faces" },
      { tier: 3, text: "The lens opens the sealed observatory" },
    ],
  });
  const incompleteBlock = { ...block, id: "research-block-private" };
  await store.saveResearchBlock(incompleteBlock.id, incompleteBlock);
  const incompleteQueue = [
    {
      id: "research-choice-private",
      activityId: rules.RESEARCH_ID,
      hours: 4,
      skill: "arc",
      research: {
        category: "object",
        discoverNew: true,
      },
      guidedRoll: { total: 10, formula: "1d20 + 5" },
    },
  ];
  const incompleteAttempt = await workflow.prepareResearchAttempt(
    incompleteBlock,
    actor,
    incompleteQueue,
  );
  assert.equal(incompleteAttempt.status, "needs-preparation");
  assert.equal(incompleteAttempt.subject, "Unresolved lead");
  assert.deepEqual(incompleteAttempt.revealedFactCards, []);
  assert.doesNotMatch(
    JSON.stringify(incompleteAttempt),
    /Sealed Lens|brass rim|remembers faces|sealed observatory|homebrew relic/,
    "unprepared hidden seed material stays out of shared player state",
  );
  const incompleteOperation = await workflow.buildResearchOperation({
    block: incompleteBlock,
    actor,
    operationId: "research-operation-private",
    createdAt: 150,
  });
  assert.equal(incompleteOperation.researchApproved, false);
  assert.equal(incompleteOperation.researchResult.subject, "Unresolved lead");
  assert.deepEqual(incompleteOperation.researchResult.factCards, []);
  assert.doesNotMatch(
    JSON.stringify(incompleteOperation),
    /Sealed Lens|brass rim|remembers faces|sealed observatory|homebrew relic/,
  );
  assert.equal(
    workflow.researchCaseForWorkspace(incompleteBlock.id, actor.id).dc,
    5,
    "the GM sees the exact frozen Research DC",
  );
  await assert.rejects(
    async () =>
      await workflow.prepareResearchAttempt(incompleteBlock, actor, [
        {
          ...incompleteQueue[0],
          guidedRoll: { total: 11, formula: "1d20 + 6" },
        },
      ]),
    /roll cannot be changed/,
    "a changed roll cannot reuse an already frozen case",
  );

  globalThis.fromUuid = async () => ({
    documentName: "Item",
    testUserPermission: () => true,
  });
  await assert.rejects(
    workflow.buildResearchOperation({
      block: incompleteBlock,
      actor,
      operationId: "research-operation-private",
      createdAt: 150,
      review: {
        subject: incompleteHiddenSeed.title,
        factCards: incompleteHiddenSeed.factCards,
        actionableDiscovery: "Carry it to the observatory door.",
        canonicalUuid: "Compendium.world.items.Item.sealed-lens",
        shareCanonicalLink: true,
      },
    }),
    /Only an Actor or Journal/,
    "permission alone cannot make a non-Actor or non-Journal link eligible",
  );
  globalThis.fromUuid = async () => ({
    documentName: "JournalEntry",
    testUserPermission: () => true,
  });
  const linkedOperation = await workflow.buildResearchOperation({
    block: incompleteBlock,
    actor,
    operationId: "research-operation-private",
    createdAt: 150,
    review: {
      subject: incompleteHiddenSeed.title,
      factCards: incompleteHiddenSeed.factCards,
      actionableDiscovery: "Carry it to the observatory door.",
      canonicalUuid: "JournalEntry.sealed-lens",
      canonicalLabel: "Recovered observatory notes",
      shareCanonicalLink: true,
    },
  });
  assert.equal(
    linkedOperation.researchResult.canonicalUuid,
    "JournalEntry.sealed-lens",
  );
  const authoredReview = {
    subject: "The restored lens",
    factCards: incompleteHiddenSeed.factCards.map((card) => ({
      ...card,
      text: `GM revision: ${card.text}`,
    })),
    actionableDiscovery: "Take the restored lens to the keeper.",
    complicationText: "The keeper requires a favor.",
    canonicalUuid: "JournalEntry.restored-lens",
    canonicalLabel: "The keeper's notes",
    shareCanonicalLink: true,
    needsWorldBuilding: true,
    worldBuildingNotes: "Prepare the keeper.",
  };
  await workflow.buildResearchOperation({
    block: incompleteBlock,
    actor,
    operationId: "research-operation-private",
    createdAt: 150,
    review: authoredReview,
    report: "The keeper recognizes the lens. Bring it to his workshop.",
  });
  await workflow.buildResearchOperation({
    block: incompleteBlock,
    actor,
    operationId: "research-operation-private",
    createdAt: 150,
    review: { worldBuildingNotes: "Prepare the keeper and workshop." },
  });
  const preservedReview = workflow.researchCaseForWorkspace(
    incompleteBlock.id,
    actor.id,
  );
  for (const key of Object.keys(authoredReview)) {
    if (key === "worldBuildingNotes") continue;
    assert.deepEqual(
      preservedReview[key],
      authoredReview[key],
      `a partial review preserves authored ${key}`,
    );
  }
  assert.equal(
    preservedReview.worldBuildingNotes,
    "Prepare the keeper and workshop.",
  );
  assert.equal(
    preservedReview.playerDossier,
    "The keeper recognizes the lens. Bring it to his workshop.",
    "editing only private notes preserves the authored player dossier",
  );
  let observerAllowed = false;
  const linkedJournal = {
    documentName: "JournalEntry",
    ownership: { default: 2 },
    testUserPermission: () => observerAllowed,
  };
  assert.equal(
    workflow.researchDocumentVisibleToUser(linkedJournal, player),
    false,
    "an explicit Foundry permission denial overrides raw ownership data",
  );
  observerAllowed = true;
  assert.equal(
    workflow.researchDocumentVisibleToUser(linkedJournal, player),
    true,
  );
  assert.equal(
    workflow.researchDocumentVisibleToUser(
      { documentName: "Item", ownership: { default: 3 } },
      player,
    ),
    false,
    "Research links accept only Actor and Journal documents",
  );
  globalThis.fromUuid = async () => linkedJournal;
  assert.equal(
    await workflow.researchUuidVisibleToUser("JournalEntry.safe", player),
    true,
  );
  observerAllowed = false;
  assert.equal(
    await workflow.researchUuidVisibleToUser("JournalEntry.safe", player),
    false,
    "permission revocation is observed when a saved link is projected again",
  );
  await assert.rejects(
    workflow.buildResearchOperation({
      block: incompleteBlock,
      actor,
      operationId: "research-operation-private",
      createdAt: 150,
      review: { worldBuildingNotes: "Must not bypass link permissions." },
    }),
    /permission|Observer|visible/i,
    "a retained shared link is checked again during partial review",
  );
  const linkedCase = workflow.researchCaseForWorkspace(
    incompleteBlock.id,
    actor.id,
  );
  const switchedSeedOperation = await workflow.buildResearchOperation({
    block: incompleteBlock,
    actor,
    operationId: "research-operation-private",
    createdAt: 150,
    report: linkedCase.playerDossier,
    review: {
      seedId: "salt-stalker",
      subject: linkedCase.subject,
      factCards: linkedCase.factCards,
      actionableDiscovery: linkedCase.actionableDiscovery,
      complicationText: linkedCase.complicationText,
      canonicalUuid: linkedCase.canonicalUuid,
      canonicalLabel: linkedCase.canonicalLabel,
      shareCanonicalLink: false,
    },
  });
  assert.equal(
    switchedSeedOperation.researchResult.subject,
    "The Salt Stalker",
  );
  assert.match(
    switchedSeedOperation.researchResult.actionableDiscovery,
    /Flood its lair/,
  );
  assert.equal(
    Object.hasOwn(switchedSeedOperation.researchResult, "canonicalUuid"),
    false,
    "switching seeds cannot retain a stale canonical link",
  );
  assert.doesNotMatch(
    JSON.stringify(switchedSeedOperation.researchResult),
    /Sealed Lens|brass rim|remembers faces|sealed observatory/,
    "choosing a different frozen seed cannot silently retain prior material",
  );
  const switchedCase = workflow.researchCaseForWorkspace(
    incompleteBlock.id,
    actor.id,
  );
  await assert.rejects(
    workflow.buildResearchOperation({
      block: incompleteBlock,
      actor,
      operationId: "research-operation-private",
      createdAt: 150,
      review: {
        seedId: "",
        subject: "A deliberately custom lead",
        factCards: switchedCase.factCards,
        actionableDiscovery: "",
        shareCanonicalLink: false,
      },
    }),
    /actionable discovery earned by this Breakthrough/,
    "a Breakthrough cannot be approved without its earned action",
  );
  const detachedOperation = await workflow.buildResearchOperation({
    block: incompleteBlock,
    actor,
    operationId: "research-operation-private",
    createdAt: 150,
    review: {
      seedId: "",
      subject: "A deliberately custom lead",
      factCards: switchedCase.factCards,
      actionableDiscovery: "Follow the custom lead into the old ward.",
      canonicalUuid: "",
      canonicalLabel: "",
      shareCanonicalLink: false,
    },
  });
  assert.equal(
    detachedOperation.researchResult.subject,
    "A deliberately custom lead",
  );
  assert.equal(
    workflow.researchCaseForWorkspace(incompleteBlock.id, actor.id).seedId,
    "",
    "Custom subject detaches the case from its prior frozen seed",
  );
  await assert.rejects(
    workflow.buildResearchOperation({
      block: incompleteBlock,
      actor,
      operationId: "research-operation-private",
      createdAt: 151,
      report: detachedOperation.report,
      review: {
        seedId: "",
        subject: detachedOperation.researchResult.subject,
        factCards: detachedOperation.researchResult.factCards,
        actionableDiscovery:
          detachedOperation.researchResult.actionableDiscovery,
        canonicalUuid: "Item.not-a-research-link",
        shareCanonicalLink: false,
      },
    }),
    /valid Actor or Journal UUID/,
    "an invalid explicit link cannot silently become an empty UUID",
  );

  const customBlock = {
    ...block,
    id: "research-block-2",
    timeOfDay: "night",
  };
  await store.saveResearchBlock(customBlock.id, customBlock);
  const customQueue = [
    {
      id: "research-choice-2",
      activityId: rules.RESEARCH_ID,
      hours: 4,
      skill: "his",
      research: {
        request: "Who ordered the old bridge sealed?",
        category: "event",
        subjectText: "The sealing of the old bridge",
      },
      guidedRoll: { total: 16, formula: "1d20 + 5" },
    },
  ];
  const customAttempt = await workflow.prepareResearchAttempt(
    customBlock,
    actor,
    customQueue,
  );
  assert.equal(customAttempt.status, "needs-preparation");
  const pendingOperation = await workflow.buildResearchOperation({
    block: customBlock,
    actor,
    operationId: "research-operation-2",
    createdAt: 200,
  });
  assert.equal(pendingOperation.researchApproved, false);
  assert.match(pendingOperation.report, /GM is preparing/i);

  const reviewedOperation = await workflow.buildResearchOperation({
    block: customBlock,
    actor,
    operationId: "research-operation-2",
    createdAt: 200,
    review: {
      subject: "The sealing of the old bridge",
      factCards: [
        { tier: 1, text: "The order used the reeve's private cipher" },
        { tier: 2, text: "A ferryman named Cale witnessed the exchange" },
        { tier: 3, text: "The original order is beneath the east tollhouse" },
      ],
      actionableDiscovery: "Question Cale at the river market.",
      complicationText: "A clerk copied the researcher's name.",
      needsWorldBuilding: true,
      worldBuildingNotes: "Create Cale and the tollhouse journal.",
    },
  });
  assert.equal(reviewedOperation.researchApproved, true);
  assert.equal(reviewedOperation.researchResult.needsWorldBuilding, true);
  assert.equal(
    Object.hasOwn(reviewedOperation.researchResult, "dc"),
    false,
    "numeric Research DC never enters the player-delivered result",
  );
  assert.equal(
    reviewedOperation.researchResult.factCards.every(
      (card) => card.tier <= reviewedOperation.selectedOutcomeIndex,
    ),
    true,
  );
  assert.doesNotMatch(
    JSON.stringify(reviewedOperation.researchResult),
    /original order is beneath/,
    "facts above the frozen tier stay hidden",
  );
  assert.match(reviewedOperation.report, /reeve's private cipher/);
  assert.match(reviewedOperation.report, /ferryman named Cale/);

  const deadEndBlock = { ...block, id: "research-block-3" };
  await store.saveResearchBlock(deadEndBlock.id, deadEndBlock);
  const deadEndQueue = [
    {
      id: "research-choice-3",
      activityId: rules.RESEARCH_ID,
      hours: 4,
      skill: "inv",
      research: {
        request: "Who carried the unsigned letter?",
        category: "person",
        subjectText: "The unsigned letter's courier",
      },
      guidedRoll: { total: 1, formula: "1d20" },
    },
  ];
  const deadEndAttempt = await workflow.prepareResearchAttempt(
    deadEndBlock,
    actor,
    deadEndQueue,
  );
  assert.equal(deadEndAttempt.tier, 0);
  assert.equal(deadEndAttempt.status, "needs-preparation");
  await assert.rejects(
    workflow.buildResearchOperation({
      block: deadEndBlock,
      actor,
      operationId: "research-operation-3",
      createdAt: 300,
      review: {
        subject: "The unsigned letter's courier",
        complicationText: "A clerk demands an explanation for the inquiry.",
      },
    }),
    /useful player-facing dead-end dossier/,
  );
  const approvedDeadEnd = await workflow.buildResearchOperation({
    block: deadEndBlock,
    actor,
    operationId: "research-operation-3",
    createdAt: 300,
    report:
      "The courier's name remains hidden, but the river customs ledger is the strongest next source.",
    review: {
      subject: "The unsigned letter's courier",
      complicationText: "A clerk demands an explanation for the inquiry.",
    },
  });
  assert.equal(approvedDeadEnd.researchApproved, true);
  assert.match(approvedDeadEnd.report, /river customs ledger/);

  const sanitized = sanitizePlayerDowntimeSnapshot({
    researchHistory: [
      {
        blockId: customBlock.id,
        research: {
          ...reviewedOperation.researchResult,
          seedSnapshot: hiddenSeed,
          dc: 99,
          privateNotes: "never deliver",
          factCards: [
            ...reviewedOperation.researchResult.factCards,
            { tier: 3, text: "Unrevealed sanitizer fact" },
          ],
          actionableDiscovery: "Unrevealed sanitizer action",
          complication: false,
          complicationText: "Untriggered sanitizer complication",
        },
      },
    ],
  });
  assert.doesNotMatch(
    JSON.stringify(sanitized),
    /seedSnapshot|privateNotes|"dc"|Fresh water|Unrevealed sanitizer/,
  );
  const failClosed = workflow.publicResearchAttempt({
    tier: 1,
    subject: "Private fallback subject",
    playerDossier: "Private fallback dossier",
    publicAttempt: {
      tier: 1,
      tierId: "interesting-thread",
      tierLabel: "Interesting Thread",
      status: "needs-preparation",
      revealedFactCards: [{ tier: 1, text: "Private fallback fact" }],
      actionableDiscovery: "Private fallback action",
      complicationText: "Private fallback complication",
    },
  });
  assert.equal(failClosed.subject, "Unresolved lead");
  assert.deepEqual(failClosed.revealedFactCards, []);
  assert.equal(failClosed.actionableDiscovery, "");
  assert.equal(failClosed.complicationText, "");
  const followUp = store
    .listResearchCases()
    .find((entry) => entry.blockId === customBlock.id);
  assert.equal(followUp.needsWorldBuilding, true);
  assert.match(followUp.worldBuildingNotes, /tollhouse/);
  const completedFollowUp = await store.completeResearchFollowUp(
    customBlock.id,
    actor.id,
  );
  assert.equal(completedFollowUp.needsWorldBuilding, false);
  assert.ok(completedFollowUp.worldBuildingCompletedAt > 0);
  const cancelledPrivateBlock = { ...block, id: "research-block-cancelled" };
  await store.saveResearchBlock(
    cancelledPrivateBlock.id,
    cancelledPrivateBlock,
  );
  assert.equal(await store.deleteResearchBlock(cancelledPrivateBlock.id), true);
  assert.equal(
    await store.deleteResearchBlock(cancelledPrivateBlock.id),
    false,
  );
  assert.throws(
    () => store.loadResearchBlock(cancelledPrivateBlock.id),
    /GM browser that opened it/,
    "cancellation cleanup removes abandoned confidential block state",
  );
} finally {
  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) delete globalThis[key];
    else globalThis[key] = value;
  }
}

process.stdout.write(
  "research requests, private seeds, frozen tiers, approval and player privacy passed\n",
);
