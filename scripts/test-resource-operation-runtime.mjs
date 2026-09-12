import assert from "node:assert/strict";
import { createResourceOperationRuntime } from "./resource/operation-runtime.js";
import {
  createResourceOperationStoreV5Adapter,
  enableResourceOperationRecovery,
  resourceRecoveryUpgradePreview,
  loadRunState,
  skipResourceDaysThrough,
  resetResourceStoreForTests,
} from "./resource/store.js";
import { resetPrivateStateForTests } from "./private-state.js";
import { normalizeSupplyCredits } from "./resource/demand.js";

const savedGame = globalThis.game;
try {
  resetResourceStoreForTests();
  resetPrivateStateForTests();
  const gm = { id: "gm", name: "GM", active: true, isGM: true, role: 4 };
  const player = { id: "player", active: true, isGM: false, role: 1 };
  const users = [gm, player];
  users.get = (id) => users.find((user) => user.id === id);
  users.activeGM = gm;
  const item = {
    id: "ration",
    _id: "ration",
    name: "Rations",
    type: "loot",
    system: { quantity: 10 },
    flags: {},
  };
  const items = [item];
  items.get = (id) => items.find((entry) => entry.id === id);
  let inventoryWrites = 0;
  const actor = {
    id: "hero",
    name: "Hero",
    documentName: "Actor",
    items,
    system: { abilities: { wis: { mod: 1 } } },
    testUserPermission: () => true,
    async updateEmbeddedDocuments(_type, updates) {
      inventoryWrites++;
      for (const update of updates)
        items.get(update._id).system.quantity = update["system.quantity"];
    },
  };
  const actors = new Map([[actor.id, actor]]);
  const env = {
    id: "forest",
    label: "Forest",
    dc: 10,
    foodDc: 10,
    waterDc: 10,
    forageable: true,
    yieldFood: "1d6",
    yieldWater: "0",
  };
  const config = {
    resources: [
      {
        id: "food",
        label: "Rations",
        perDay: 1,
        scope: "per-character",
        forageYields: "food",
        matching: { nameKeywords: ["rations"], flagTag: "food", itemUuids: [] },
      },
    ],
    environments: [env],
    halfRations: true,
    waterEnabled: false,
    forageMode: "each",
    forageTimeoutSeconds: 120,
    partyStashId: "",
  };
  let state = {
    version: 4,
    revision: 0,
    authorityId: "gm",
    authorityEpoch: "epoch-1",
    lastSeenDay: 1,
    currentEnvironmentId: "forest",
    lastUpkeepResult: null,
    activeUpkeep: null,
    recentRuns: [],
  };
  let crashOnMarker = false;
  let crashOnLivingCompletion = false;
  globalThis.game = {
    user: gm,
    users,
    actors,
    settings: {
      get(_module, key) {
        if (key === "resourceRunState") return state;
        if (key === "resourceConfig") return config;
        return undefined;
      },
      async set(_module, key, value) {
        if (key === "resourceRunState") {
          if (
            crashOnLivingCompletion &&
            value.lastUpkeepResult?.perActor?.[0]?.living
          )
            throw new Error(
              "crash after living payment before terminal checkpoint",
            );
          if (
            crashOnMarker &&
            value.activeOperation?.appliedOperationIds.length
          )
            throw new Error("simulated crash before inventory checkpoint");
          state = JSON.parse(JSON.stringify(value));
        }
        return value;
      },
    },
  };
  const beforeUpgrade = resourceRecoveryUpgradePreview();
  await enableResourceOperationRecovery(beforeUpgrade);
  assert.equal(state.version, 5);
  assert.equal(state.lastSeenDay, 1);
  assert.equal(loadRunState().operationMode, true);
  const messages = new Map();
  let messageIndex = 0;
  const prompts = [];
  const createRuntime = () =>
    createResourceOperationRuntime({
      store: createResourceOperationStoreV5Adapter(),
      actors: () => actors,
      readContext: () => ({
        config,
        environmentId: "forest",
        supplyCredits: normalizeSupplyCredits(
          state.lastUpkeepResult?.supplyCredits,
        ),
        roster: [
          {
            actorId: actor.id,
            name: actor.name,
            consumes: true,
            isStash: false,
            drawFromId: actor.id,
          },
        ],
      }),
      resolveTargets: () => [
        { actor, userId: player.id, forageTarget: "food" },
      ],
      yieldDie: async () => 2,
      emitPrompt(payload) {
        prompts.push(payload);
        return payload;
      },
      deliveryBindings: {
        isAuthorityCurrent: () => true,
        allocateChatMessageId: () => String(++messageIndex).padStart(16, "0"),
        findChatMessage: (id) => messages.get(id) ?? null,
        createChatMessage: async (data) => {
          messages.set(data._id, structuredClone(data));
          return data;
        },
        emitResourceEvent: (_type, data) => data,
      },
    });
  crashOnMarker = true;
  await assert.rejects(
    () => createRuntime().start({ manual: true, day: 1 }),
    /checkpoint|readback|crash|candidate/i,
  );
  assert.equal(
    item.system.quantity,
    9,
    "one ration charged before the simulated crash",
  );
  assert.equal(state.activeOperation.appliedOperationIds.length, 0);
  crashOnMarker = false;
  await createRuntime().coordinator.recover();
  assert.equal(
    item.system.quantity,
    9,
    "recovery recognizes the post-write quantity instead of charging again",
  );
  assert.equal(inventoryWrites, 1);
  assert.equal(state.activeOperation, null);
  assert.equal(state.recentRuns.length, 1);
  assert.equal(messages.size, 1);
  await createRuntime().coordinator.recover();
  assert.equal(
    messages.size,
    1,
    "report delivery is not duplicated after reload",
  );
  await createRuntime().start({ manual: true, day: 2 });
  assert.equal(
    item.system.quantity,
    9,
    "the next day uses the persisted prepaid half",
  );
  assert.equal(state.recentRuns.length, 2);

  const forage = createRuntime();
  await forage.start({
    kind: "forage",
    day: 2,
    environment: env,
    forageAssignments: [{ actorId: "hero", forageTarget: "food" }],
  });
  assert.equal(state.activeOperation.phase, "prompting");
  const prompt = prompts.at(-1);
  assert.equal("foodDc" in prompt.environment, false);
  const resumed = createRuntime();
  await resumed.coordinator.recover();
  assert.equal(
    prompts.at(-1).promptId,
    prompt.promptId,
    "reload replays the same prompt identity",
  );
  await resumed.coordinator.acceptPromptResult({
    runId: prompt.runId,
    promptId: prompt.promptId,
    actorId: "hero",
    originUserId: "player",
    rollTotal: 15,
    skipped: false,
  });
  assert.equal(
    item.system.quantity,
    12,
    "forage adds the resolved food once without upkeep consumption",
  );
  assert.equal(state.activeOperation, null);
  assert.equal(state.recentRuns.length, 3);
  assert.equal(
    state.lastSeenDay,
    1,
    "manual and forage runs do not move calendar accounting",
  );
  assert.match([...messages.values()].at(-1).content, /Hero/);
  assert.doesNotMatch([...messages.values()].at(-1).content, /no online owner/);
  config.dailyLiving = true;
  config.roster = [{ actorId: "hero", living: "comfortable" }];
  actor.flags = {};
  actor.system.currency = { gp: 10 };
  let livingWrites = 0;
  actor.update = async (patch) => {
    livingWrites++;
    if (patch["system.currency"])
      actor.system.currency = structuredClone(patch["system.currency"]);
    actor.flags["infinity-dnd5e"] = {
      livingReceipt: structuredClone(
        patch["flags.infinity-dnd5e.livingReceipt"],
      ),
    };
    return actor;
  };
  crashOnLivingCompletion = true;
  await assert.rejects(
    createRuntime().start({ kind: "upkeep", manual: true, day: 3, days: 2 }),
    /crash|checkpoint|candidate/i,
  );
  assert.equal(actor.system.currency.gp, 6);
  assert.equal(livingWrites, 1);
  crashOnLivingCompletion = false;
  await createRuntime().coordinator.recover();
  assert.equal(
    livingWrites,
    1,
    "recovery after payment and before terminal checkpoint does not recharge",
  );
  assert.equal(actor.system.currency.gp, 6);
  assert.equal(
    item.system.quantity,
    12,
    "paid living leaves rations intact in durable mode",
  );
  assert.equal(state.lastUpkeepResult.perActor[0].living.covered, true);
  await createRuntime().coordinator.recover();
  assert.match(JSON.stringify(state.operationOutbox.at(-1)), /paid 4 gp/);
  assert.equal(
    livingWrites,
    1,
    "terminal recovery does not charge living again",
  );
  actor.system.currency = { gp: 0 };
  await createRuntime().start({ kind: "upkeep", manual: true, day: 4 });
  assert.equal(state.lastUpkeepResult.hasErrors, true);
  assert.equal(item.system.quantity, 12);
  await createRuntime().coordinator.recover();
  assert.match(
    JSON.stringify(state.operationOutbox.at(-1)),
    /Living costs unresolved/,
  );
  const beforeSkip = state.lastSeenDay;
  const writesBeforeSkip = livingWrites;
  await skipResourceDaysThrough(beforeSkip + 90, beforeSkip);
  assert.equal(state.lastSeenDay, beforeSkip + 90);
  assert.equal(livingWrites, writesBeforeSkip);
  await assert.rejects(
    skipResourceDaysThrough(beforeSkip + 91, beforeSkip),
    /changed/,
  );
  delete config.dailyLiving;
  delete config.roster;

  await createRuntime().start({
    kind: "forage",
    day: 2,
    environment: env,
    forageAssignments: [{ actorId: "hero", forageTarget: "food" }],
  });
  const changedPrompt = prompts.at(-1);
  await assert.rejects(
    () =>
      createRuntime().coordinator.acceptPromptResult({
        ...changedPrompt,
        originUserId: "gm",
        rollTotal: 15,
      }),
    /owner|prompted/,
  );
  assert.equal(state.activeOperation.prompts.responses.length, 0);
  config.halfRations = false;
  const stopped = await createRuntime().coordinator.recover();
  assert.equal(stopped.action, "needs-review");
  assert.equal(state.activeOperation.phase, "needs-review");
  await assert.rejects(
    skipResourceDaysThrough(state.lastSeenDay + 1, state.lastSeenDay),
    /changed/,
  );
  assert.equal(item.system.quantity, 12, "changed rules stop before any write");
  console.log(
    "Production resource runtime: guarded upgrade, crash recovery, exact-once charge/report, prepaid fractions and replayed forage prompt passed",
  );
} finally {
  resetResourceStoreForTests();
  resetPrivateStateForTests();
  globalThis.game = savedGame;
}
