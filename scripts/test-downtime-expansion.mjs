import assert from "node:assert/strict";
import fs from "node:fs";
import { DOWNTIME_RECIPES, guidedRewardCp } from "./downtime/recipes.js";
import { collectDowntimeJournal } from "./downtime/journal.js";
import { normalizeGuidedDowntimeProject } from "./downtime/projects.js";
import {
  normalizeGuidedDowntimeLibrary,
  normalizeGuidedDowntimeTemplate,
} from "./downtime/dispatch.js";
import {
  trainingFieldState,
  validateTrainingProject,
} from "./downtime/training-rules.js";

const items = fs
  .readFileSync("packs/infinity-dnd5e-items.db", "utf8")
  .trim()
  .split("\n")
  .map(JSON.parse);
assert.equal(DOWNTIME_RECIPES.length, 8);
for (const raw of DOWNTIME_RECIPES) {
  const recipe = normalizeGuidedDowntimeTemplate(raw);
  assert.ok(
    items.some((i) => recipe.work.itemUuid.endsWith(`.Item.${i._id}`)),
    raw.name,
  );
  assert.equal(recipe.category, "crafting");
  assert.ok(recipe.work.requiredTools.length);
  assert.ok(recipe.work.batchGp > 0);
}
assert.equal(
  guidedRewardCp({ rewardBasis: "workday" }, { rewardGp: 2 }, 24),
  600,
);
assert.equal(
  guidedRewardCp({}, { rewardGp: 2 }, 24),
  200,
  "old open snapshots keep allocation rewards",
);
assert.equal(
  guidedRewardCp({ rewardBasis: "workday" }, { rewardGp: 2 }, 8) * 3,
  guidedRewardCp({ rewardBasis: "workday" }, { rewardGp: 2 }, 24),
);
const custom = normalizeGuidedDowntimeTemplate({
  ...DOWNTIME_RECIPES[0],
  work: { ...DOWNTIME_RECIPES[0].work, batchGp: 41 },
});
assert.equal(
  normalizeGuidedDowntimeLibrary([custom]).find((t) => t.id === custom.id).work
    .batchGp,
  41,
);
const history = Array.from({ length: 205 }, (_, i) => ({
  id: `b${i}`,
  locationName: "Camp",
  result: {
    playerReceipts: {
      alice: {
        completedAt: i,
        activities: [{ label: `Work ${i}`, report: "Public result" }],
      },
    },
  },
}));
const archive = collectDowntimeJournal({ history });
assert.equal(archive.alice.length, 200);
assert.equal(archive.alice[0].blockId, "b5");
assert.deepEqual(
  collectDowntimeJournal({ journal: archive, history: history.slice(-2) }),
  archive,
  "replay does not duplicate journal reports",
);
assert.deepEqual(
  collectDowntimeJournal({ journal: archive, history: [] }),
  archive,
  "journal survives recovery history rotation",
);

const saved = Object.fromEntries(
  ["game", "foundry", "CONST", "CONFIG", "JournalEntry", "fromUuid"].map(
    (k) => [k, globalThis[k]],
  ),
);
const settings = new Map();
const gm = { id: "gm", isGM: true, role: 4, active: true };
let nextId = 0,
  writes = 0,
  creations = 0,
  interrupt = false;
const actor = {
  id: "alice",
  type: "character",
  name: "Alice",
  flags: {},
  system: {
    skills: { arc: { value: 0 } },
    tools: { alchemist: { value: 0 } },
    traits: { languages: { value: ["common"] } },
  },
  items: new Map(),
  async update(patch) {
    for (const [path, value] of Object.entries(patch)) {
      const keys = path.split(".");
      let target = this;
      for (const k of keys.slice(0, -1)) target = target[k] ??= {};
      target[keys.at(-1)] = structuredClone(value);
    }
    writes++;
    if (interrupt) {
      interrupt = false;
      throw Error("Interrupted after write");
    }
  },
  async createEmbeddedDocuments(_type, sources) {
    return sources.map((source) => {
      const item = {
        ...structuredClone(source),
        id: source._id,
        toObject() {
          const { toObject, id, ...data } = this;
          return structuredClone(data);
        },
      };
      this.items.set(item.id, item);
      creations++;
      return item;
    });
  },
};
try {
  delete globalThis.JournalEntry;
  globalThis.CONST = { USER_ROLES: { GAMEMASTER: 4 } };
  globalThis.CONFIG = {
    DND5E: {
      skills: { arc: { label: "Arcana" } },
      tools: { alchemist: { label: "Alchemist's Supplies" } },
      languages: {
        standard: { children: { common: "Common", draconic: "Draconic" } },
      },
    },
  };
  globalThis.foundry = {
    utils: {
      deepClone: structuredClone,
      randomID: () => String(++nextId).padStart(16, "0"),
    },
  };
  const users = new Map([[gm.id, gm]]);
  users.activeGM = gm;
  globalThis.game = {
    ready: false,
    user: gm,
    users,
    actors: new Map([[actor.id, actor]]),
    time: { serverTime: 1000 },
    settings: {
      get: (_m, k) => settings.get(k),
      set: async (_m, k, v) => {
        settings.set(k, structuredClone(v));
        return v;
      },
    },
  };
  const store = await import("./downtime/store.js");
  const training = await import("./downtime/training.js");
  const project = normalizeGuidedDowntimeProject({
    id: "arcana",
    name: "Study Arcana",
    scope: "personal",
    actorId: actor.id,
    prerequisites: "Library and tutor",
    requiredHours: 16,
    requiredSuccesses: 0,
    reward: { kind: "skill", key: "arc" },
  });
  await validateTrainingProject(project, actor);
  await assert.rejects(
    validateTrainingProject({ ...project, scope: "shared" }, actor),
    /personal plan/,
  );
  await assert.rejects(
    validateTrainingProject(
      { ...project, reward: { kind: "skill", key: "currency.gp" } },
      actor,
    ),
    /supported training/,
  );
  await store.saveDowntimeConfig({ guidedProjects: [project] });
  await assert.rejects(
    training.approveTrainingReward(project.id),
    /required hours/,
  );
  const fund = (id) => {
    for (const key of ["downtimeWorkflow", "downtimeWorkflowCheckpoint"]) {
      const slot = settings.get(key);
      const w = slot.workflow ?? slot;
      w.projectProgress[id] = 16;
    }
    store.resetDowntimeWorkflowStoreForTests();
  };
  fund(project.id);
  interrupt = true;
  await assert.rejects(
    training.approveTrainingReward(project.id),
    /Interrupted after write/,
  );
  assert.ok(
    store.loadDowntimeWorkflowStore().trainingAwards[project.id],
    "approval persists before sheet write",
  );
  await training.approveTrainingReward(project.id);
  assert.equal(writes, 1, "retry after uncertain write does not grant twice");
  assert.equal(actor.system.skills.arc.value, 1);
  actor.system.skills.arc.value = 2;
  await training.reconcileTraining(actor.id);
  assert.equal(
    actor.system.skills.arc.value,
    2,
    "later expertise is preserved",
  );
  actor.system.skills.arc.value = 0;
  await training.reconcileTraining(actor.id);
  assert.equal(
    actor.system.skills.arc.value,
    1,
    "import reconciliation restores earned proficiency",
  );
  assert.deepEqual(
    trainingFieldState(actor, { kind: "language", key: "draconic" }).value,
    ["common", "draconic"],
  );
  const feat = normalizeGuidedDowntimeProject({
    ...project,
    id: "technique",
    reward: {
      kind: "technique",
      itemUuid: "Item.ApprovedFeat0001",
      snapshot: {
        _id: "ApprovedFeat0001",
        name: "Guarded Step",
        type: "feat",
        system: {
          description: { value: "A reviewed technique" },
          activities: {},
        },
        effects: [],
        flags: {},
      },
    },
  });
  await store.saveDowntimeConfig({ guidedProjects: [project, feat] });
  fund(feat.id);
  await training.approveTrainingReward(feat.id);
  await training.approveTrainingReward(feat.id);
  assert.equal(creations, 1);
  actor.items.clear();
  await training.reconcileTraining(actor.id);
  assert.equal(
    creations,
    2,
    "missing approved technique restored after import",
  );
  game.user = { id: "player", isGM: false, role: 1, active: true };
  await assert.rejects(training.approveTrainingReward(project.id), /full GM/);
  assert.equal(creations, 2);
} finally {
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete globalThis[k];
    else globalThis[k] = v;
  }
}
console.log(
  "Downtime expansion: recipe provenance, reward scaling, journal retention, personal training, authority, retry and import recovery passed",
);
