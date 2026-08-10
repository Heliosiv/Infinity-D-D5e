import assert from "node:assert/strict";

const saved = {
  CONST: globalThis.CONST,
  foundry: globalThis.foundry,
  game: globalThis.game,
  ui: globalThis.ui,
  Hooks: globalThis.Hooks,
  ChatMessage: globalThis.ChatMessage,
};
const originalConsoleError = console.error;

async function waitFor(predicate, message) {
  for (let attempt = 0; attempt < 2000; attempt += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  assert.fail(message);
}

const gm = { id: "gm-a", isGM: true, role: 4, active: true };
const otherGm = { id: "gm-b", isGM: true, role: 4, active: true };
const users = [gm, otherGm];
users.activeGM = gm;
users.get = (id) => users.find((user) => user.id === id) ?? null;

const ration = {
  id: "ration-stack",
  name: "Rations (1 day)",
  type: "consumable",
  system: { quantity: 20 },
  flags: {},
};
let updateCalls = 0;
let rejectInventoryWrites = false;
const hero = {
  id: "hero",
  name: "Aria",
  type: "character",
  hasPlayerOwner: true,
  ownership: {},
  system: { attributes: { exhaustion: 0 } },
  items: {
    contents: [ration],
    get(id) {
      return id === ration.id ? ration : null;
    },
  },
  async updateEmbeddedDocuments(_type, updates) {
    updateCalls += 1;
    if (rejectInventoryWrites) return [];
    for (const update of updates) {
      if (update._id === ration.id) {
        ration.system.quantity = update["system.quantity"];
      }
    }
    return [ration];
  },
  async deleteEmbeddedDocuments() {
    throw new Error("unexpected delete");
  },
};
const stash = {
  id: "stash",
  name: "Party Mule",
  type: "npc",
  hasPlayerOwner: false,
  ownership: {},
  system: { attributes: { exhaustion: 0 } },
  items: {
    contents: [],
    get() {
      return null;
    },
  },
};
const actors = [hero, stash];
actors.get = (id) => actors.find((actor) => actor.id === id) ?? null;

const resourceConfig = {
  version: 4,
  resources: [
    {
      id: "food",
      label: "Food (Rations)",
      scope: "per-character",
      perDay: 1,
      forageYields: "food",
      matching: {
        nameKeywords: ["rations"],
        excludeNameKeywords: ["water ration"],
        flagTag: "food",
        itemUuids: [],
      },
    },
  ],
  roster: [
    {
      actorId: "hero",
      isStash: false,
      consumes: true,
      drawFrom: "self",
    },
    {
      actorId: "stash",
      isStash: true,
      consumes: false,
      drawFrom: "self",
    },
  ],
  partyStashId: "",
  environments: [
    {
      id: "settlement",
      label: "Settlement",
      dc: 0,
      forageable: false,
      yieldFood: "0",
      yieldWater: "0",
    },
  ],
};
const settings = new Map([
  ["resourceConfig", resourceConfig],
  [
    "resourceRunState",
    {
      lastSeenDay: 10,
      currentEnvironmentId: "settlement",
      lastUpkeepResult: null,
      activeUpkeep: null,
    },
  ],
  ["resourceAutoTrigger", true],
  ["resourceForageMode", "each"],
  ["resourceWaterEnabled", false],
  ["resourceHalfRations", false],
  ["resourceMaxCatchUpDays", 7],
  ["resourceDefaultEnvironment", "settlement"],
  ["resourceReportMode", "whisper-gm"],
]);

const hookCallbacks = new Map();
let errorCount = 0;
let exhaustionPromptCount = 0;
const chatMessages = [];

try {
  globalThis.CONST = {
    USER_ROLES: { GAMEMASTER: 4 },
    DOCUMENT_OWNERSHIP_LEVELS: { OWNER: 3 },
  };
  globalThis.foundry = {
    utils: {
      deepClone(value) {
        return structuredClone(value);
      },
    },
    applications: {
      api: {
        DialogV2: {
          async confirm() {
            exhaustionPromptCount += 1;
            return false;
          },
        },
      },
    },
  };
  globalThis.Hooks = {
    on(name, callback) {
      const callbacks = hookCallbacks.get(name) ?? [];
      callbacks.push(callback);
      hookCallbacks.set(name, callbacks);
      return callbacks.length;
    },
  };
  globalThis.ChatMessage = {
    getSpeaker({ alias } = {}) {
      return { alias };
    },
    async create(message) {
      chatMessages.push(message);
      return message;
    },
  };
  globalThis.game = {
    ready: false,
    user: gm,
    users,
    actors,
    time: { worldTime: 10 * 86400, secondsPerDay: 86400 },
    settings: {
      get(_moduleId, key) {
        return settings.get(key);
      },
      async set(_moduleId, key, value) {
        settings.set(key, structuredClone(value));
        return value;
      },
    },
  };
  globalThis.ui = {
    notifications: {
      info() {},
      warn() {},
      error() {
        errorCount += 1;
      },
    },
  };
  console.error = () => {
    errorCount += 1;
  };

  const [{ registerResourceCalendarWatcher }, { clearUpkeepClaim }] =
    await Promise.all([
      import("./resource/calendar-watcher.js"),
      import("./resource/store.js"),
    ]);
  registerResourceCalendarWatcher();
  await new Promise((resolve) => setTimeout(resolve, 0));
  const onWorldTime = hookCallbacks.get("updateWorldTime")?.[0];
  assert.equal(typeof onWorldTime, "function");

  // A failed lease write occurs before any Actor mutation.
  const normalSet = globalThis.game.settings.set;
  let failNextRunStateWrite = true;
  globalThis.game.settings.set = async (_moduleId, key, value) => {
    if (key === "resourceRunState" && failNextRunStateWrite) {
      failNextRunStateWrite = false;
      throw new Error("synthetic claim persistence failure");
    }
    settings.set(key, structuredClone(value));
    return value;
  };
  globalThis.game.time.worldTime = 11 * 86400;
  const errorsBeforeClaim = errorCount;
  onWorldTime();
  await waitFor(
    () => errorCount > errorsBeforeClaim,
    "claim persistence failure was not observed",
  );
  assert.equal(updateCalls, 0);
  assert.equal(ration.system.quantity, 20);
  assert.equal(settings.get("resourceRunState").lastSeenDay, 10);

  // A clean retry claims, consumes once, and atomically closes.
  globalThis.game.settings.set = normalSet;
  onWorldTime();
  await waitFor(
    () =>
      settings.get("resourceRunState").lastSeenDay === 11 &&
      settings.get("resourceRunState").activeUpkeep === null,
    "the recovered run did not close",
  );
  assert.equal(updateCalls, 1);
  assert.equal(ration.system.quantity, 19);
  assert.equal(settings.get("resourceRunState").recentRuns.length, 1);
  assert.equal(
    settings.get("resourceRunState").recentRuns[0].status,
    "complete",
  );
  assert.equal(
    settings.get("resourceRunState").recentRuns[0].initiator.userId,
    "gm-a",
  );
  assert.equal(
    settings.get("resourceRunState").recentRuns[0].environment.label,
    "Settlement",
  );
  assert.deepEqual(
    settings.get("resourceRunState").recentRuns[0].actors.map((actor) => ({
      actorId: actor.actorId,
      name: actor.name,
    })),
    [{ actorId: "hero", name: "Aria" }],
  );

  // A rejected inventory write closes the claimed day exactly once as a
  // needs-review result. The pre-write inventory was sufficient, so the write
  // failure must not manufacture a shortage or an exhaustion suggestion.
  rejectInventoryWrites = true;
  const chatsBeforeRejectedWrite = chatMessages.length;
  globalThis.game.time.worldTime = 12 * 86400;
  onWorldTime();
  await waitFor(
    () =>
      settings.get("resourceRunState").lastSeenDay === 12 &&
      settings.get("resourceRunState").activeUpkeep === null &&
      chatMessages.length === chatsBeforeRejectedWrite + 1,
    "the rejected inventory run did not close and report",
  );
  rejectInventoryWrites = false;
  const rejectedWriteState = settings.get("resourceRunState");
  const rejectedWriteResult = rejectedWriteState.lastUpkeepResult;
  const rejectedWriteReceipt = rejectedWriteState.recentRuns[0];
  assert.equal(updateCalls, 2);
  assert.equal(ration.system.quantity, 19);
  assert.equal(rejectedWriteResult.status, "partial");
  assert.equal(rejectedWriteResult.hasErrors, true);
  assert.equal(rejectedWriteResult.perActor[0].shortfalls.food, 0);
  assert.equal(rejectedWriteResult.perActor[0].canonicalShortfalls.food, 0);
  assert.deepEqual(rejectedWriteResult.suggestions, []);
  assert.equal(rejectedWriteReceipt.status, "partial");
  assert.equal(rejectedWriteReceipt.actors[0].errors.length, 1);
  assert.deepEqual(rejectedWriteReceipt.exhaustionSuggestions, []);
  assert.equal(exhaustionPromptCount, 0);
  assert.match(chatMessages.at(-1).content, /Daily Supplies[^<]*Needs review/);

  const writesAfterRejectedRun = updateCalls;
  const receiptsAfterRejectedRun = rejectedWriteState.recentRuns.length;
  const chatsAfterRejectedRun = chatMessages.length;
  onWorldTime();
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(
    updateCalls,
    writesAfterRejectedRun,
    "same-day re-entry never retries a rejected inventory write",
  );
  assert.equal(
    settings.get("resourceRunState").recentRuns.length,
    receiptsAfterRejectedRun,
  );
  assert.equal(chatMessages.length, chatsAfterRejectedRun);

  // If completion persistence fails after consumption, the claimed day stays
  // reserved. Same-day hooks never replay the Actor mutation.
  let runStateWrites = 0;
  globalThis.game.settings.set = async (_moduleId, key, value) => {
    if (key === "resourceRunState") {
      runStateWrites += 1;
      if (runStateWrites === 2) {
        throw new Error("synthetic completion persistence failure");
      }
    }
    settings.set(key, structuredClone(value));
    return value;
  };
  globalThis.game.time.worldTime = 13 * 86400;
  const errorsBeforeCompletion = errorCount;
  onWorldTime();
  await waitFor(
    () => errorCount > errorsBeforeCompletion,
    "completion persistence failure was not observed",
  );
  assert.equal(updateCalls, 3);
  assert.equal(ration.system.quantity, 18);
  assert.equal(settings.get("resourceRunState").lastSeenDay, 13);
  assert.ok(settings.get("resourceRunState").activeUpkeep?.runId);
  assert.equal(
    settings.get("resourceRunState").recentRuns.length,
    2,
    "a failed completion appends no receipt",
  );
  onWorldTime();
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(updateCalls, 3, "a claimed day is never consumed twice");
  assert.equal(ration.system.quantity, 18);

  globalThis.game.settings.set = normalSet;
  await clearUpkeepClaim(settings.get("resourceRunState").activeUpkeep.runId);
  assert.equal(settings.get("resourceRunState").activeUpkeep, null);
  assert.equal(settings.get("resourceRunState").recentRuns.length, 3);
  assert.equal(
    settings.get("resourceRunState").recentRuns[0].outcomeUnknown,
    true,
  );
  assert.equal(settings.get("resourceRunState").recentRuns[0].day, 13);
  assert.equal(
    settings.get("resourceRunState").recentRuns[0].environment.label,
    "Settlement",
  );
  assert.deepEqual(
    settings
      .get("resourceRunState")
      .recentRuns[0].actors.map(({ actorId, name, role }) => ({
        actorId,
        name,
        role,
      })),
    [
      {
        actorId: "hero",
        name: "Aria",
        role: "participant-inventory",
      },
      { actorId: "stash", name: "Party Mule", role: "inventory" },
    ],
    "interrupted review retains participants and possible inventory targets without outcomes",
  );

  // A competing client that becomes canonical during the post-claim
  // stabilization window stops this run before its first Actor write.
  let replaceClaimDuringStabilization = true;
  globalThis.game.settings.set = async (_moduleId, key, value) => {
    settings.set(key, structuredClone(value));
    if (key === "resourceRunState" && replaceClaimDuringStabilization) {
      replaceClaimDuringStabilization = false;
      setTimeout(() => {
        const competing = structuredClone(settings.get("resourceRunState"));
        competing.activeUpkeep = {
          runId: "competing-client-run",
          trigger: "calendar",
          day: 14,
          days: 1,
          claimedAt: Date.now(),
          authorityId: competing.authorityId,
          authorityEpoch: competing.authorityEpoch,
          leadershipGeneration: 0,
        };
        settings.set("resourceRunState", competing);
      }, 25);
    }
    return value;
  };
  globalThis.game.time.worldTime = 14 * 86400;
  const errorsBeforeCompetingClaim = errorCount;
  onWorldTime();
  await waitFor(
    () => errorCount > errorsBeforeCompetingClaim,
    "a competing canonical claim was not observed during stabilization",
  );
  assert.equal(updateCalls, 3);
  assert.equal(ration.system.quantity, 18);
  assert.equal(
    settings.get("resourceRunState").activeUpkeep?.runId,
    "competing-client-run",
  );

  globalThis.game.settings.set = normalSet;
  await clearUpkeepClaim("competing-client-run");
  assert.equal(settings.get("resourceRunState").activeUpkeep, null);
  assert.equal(settings.get("resourceRunState").recentRuns.length, 4);
  assert.equal(
    settings.get("resourceRunState").recentRuns[0].runId,
    "competing-client-run",
  );

  // An authority change during lease persistence invalidates the old client
  // before its first Actor write.
  let switchAuthorityAfterClaim = true;
  globalThis.game.settings.set = async (_moduleId, key, value) => {
    settings.set(key, structuredClone(value));
    if (key === "resourceRunState" && switchAuthorityAfterClaim) {
      switchAuthorityAfterClaim = false;
      users.activeGM = otherGm;
    }
    return value;
  };
  globalThis.game.time.worldTime = 15 * 86400;
  const errorsBeforeHandoff = errorCount;
  onWorldTime();
  await waitFor(
    () => errorCount > errorsBeforeHandoff,
    "authority handoff was not observed",
  );
  assert.equal(updateCalls, 3);
  assert.equal(ration.system.quantity, 18);
  assert.equal(
    settings.get("resourceRunState").recentRuns.length,
    4,
    "authority loss before Actor writes creates no receipt",
  );
} finally {
  console.error = originalConsoleError;
  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) delete globalThis[key];
    else globalThis[key] = value;
  }
}

process.stdout.write("resource upkeep lease validation passed\n");
