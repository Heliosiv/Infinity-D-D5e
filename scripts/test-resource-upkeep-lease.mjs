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
const actors = [hero];
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
  };
  globalThis.Hooks = {
    on(name, callback) {
      const callbacks = hookCallbacks.get(name) ?? [];
      callbacks.push(callback);
      hookCallbacks.set(name, callbacks);
      return callbacks.length;
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
  globalThis.game.time.worldTime = 12 * 86400;
  const errorsBeforeCompletion = errorCount;
  onWorldTime();
  await waitFor(
    () => errorCount > errorsBeforeCompletion,
    "completion persistence failure was not observed",
  );
  assert.equal(updateCalls, 2);
  assert.equal(ration.system.quantity, 18);
  assert.equal(settings.get("resourceRunState").lastSeenDay, 12);
  assert.ok(settings.get("resourceRunState").activeUpkeep?.runId);
  onWorldTime();
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(updateCalls, 2, "a claimed day is never consumed twice");
  assert.equal(ration.system.quantity, 18);

  globalThis.game.settings.set = normalSet;
  await clearUpkeepClaim(settings.get("resourceRunState").activeUpkeep.runId);
  assert.equal(settings.get("resourceRunState").activeUpkeep, null);

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
          day: 13,
          days: 1,
          claimedAt: Date.now(),
        };
        settings.set("resourceRunState", competing);
      }, 25);
    }
    return value;
  };
  globalThis.game.time.worldTime = 13 * 86400;
  const errorsBeforeCompetingClaim = errorCount;
  onWorldTime();
  await waitFor(
    () => errorCount > errorsBeforeCompetingClaim,
    "a competing canonical claim was not observed during stabilization",
  );
  assert.equal(updateCalls, 2);
  assert.equal(ration.system.quantity, 18);
  assert.equal(
    settings.get("resourceRunState").activeUpkeep?.runId,
    "competing-client-run",
  );

  globalThis.game.settings.set = normalSet;
  await clearUpkeepClaim("competing-client-run");
  assert.equal(settings.get("resourceRunState").activeUpkeep, null);

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
  globalThis.game.time.worldTime = 14 * 86400;
  const errorsBeforeHandoff = errorCount;
  onWorldTime();
  await waitFor(
    () => errorCount > errorsBeforeHandoff,
    "authority handoff was not observed",
  );
  assert.equal(updateCalls, 2);
  assert.equal(ration.system.quantity, 18);
} finally {
  console.error = originalConsoleError;
  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) delete globalThis[key];
    else globalThis[key] = value;
  }
}

process.stdout.write("resource upkeep lease validation passed\n");
