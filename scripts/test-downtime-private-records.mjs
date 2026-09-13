import assert from "node:assert/strict";
const gm = { id: "gm", role: 4, isGM: true, active: true };
const gm2 = { id: "gm2", role: 4, isGM: true, active: true };
const values = new Map(),
  local = new Map();
globalThis.game = {
  user: gm,
  users: { activeGM: gm },
  world: { id: "test" },
  settings: {
    get: (_, k) => values.get(k),
    set: async (_, k, v) => values.set(k, structuredClone(v)),
  },
};
globalThis.localStorage = {
  getItem: (k) => local.get(k) ?? null,
  setItem: (k, v) => local.set(k, v),
};
const records = await import("./downtime/private-records.js");
const { defaultHuntingRegions } = await import("./downtime/hunting.js");
const hunting = await import("./downtime/hunting-store.js");
const research = await import("./downtime/research-store.js");
const hk = "infinity-dnd5e.hunting.v1.test.gm",
  rk = "infinity-dnd5e.research.v1.test.gm";
const oldHunt = {
  version: 1,
  regions: {},
  blocks: {
    old: { seed: "fixed-secret", region: { id: "woods", survivalDc: 17 } },
  },
};
local.set(hk, JSON.stringify(oldHunt));
local.set(
  rk,
  JSON.stringify({
    version: 1,
    seeds: [{ id: "seed", title: "Hidden canary" }],
    blocks: {
      old: {
        id: "old",
        secret: "frozen",
        cases: { actor: { queueKey: "fixed", dc: 19, approved: true } },
      },
    },
  }),
);
const preview = await records.previewPrivateDowntimeImport();
assert.deepEqual(preview.counts, {
  huntingAreas: 0,
  hunts: 1,
  researchSeeds: 1,
  researchBlocks: 1,
});
assert.equal(values.size, 0, "preview writes nothing");
await records.applyPrivateDowntimeImport(preview);
assert.equal(local.get(hk), JSON.stringify(oldHunt), "original preserved");
assert.equal(hunting.loadHuntingBlock("old").seed, "fixed-secret");
assert.equal(research.loadResearchCase("old", "actor").dc, 19);
await research.deleteResearchSeed("seed");
await records.applyPrivateDowntimeImport(
  await records.previewPrivateDowntimeImport(),
);
assert.deepEqual(
  research.loadResearchSeeds(),
  [],
  "old browser cannot resurrect deletion",
);
const stale = await records.previewPrivateDowntimeImport();
await hunting.saveHuntingRegion({
  ...defaultHuntingRegions()[0],
  id: "new",
  name: "New area",
});
await assert.rejects(
  records.applyPrivateDowntimeImport(stale),
  /Preview.*again/i,
);
local.set(
  hk,
  JSON.stringify({ ...oldHunt, regions: { changed: { id: "changed" } } }),
);
const conflict = await records.previewPrivateDowntimeImport();
assert.equal(conflict.conflicts.length, 1);
await assert.rejects(
  records.applyPrivateDowntimeImport(conflict),
  /Conflicting/,
);
game.user = gm2;
assert.equal(
  hunting.loadHuntingBlock("old").seed,
  "fixed-secret",
  "another GM reads canonical state without browser copy",
);
await assert.rejects(
  hunting.saveHuntingRegion({ id: "blocked" }),
  /active full GM/,
);
game.users.activeGM = gm2;
await research.saveResearchSeed({ id: "new", title: "Second GM" });
assert.equal(research.loadResearchSeeds()[0].title, "Second GM");
const write = game.settings.set;
game.settings.set = async () => {
  throw Error("synthetic write failure");
};
await assert.rejects(
  research.saveResearchSeed({ id: "failed", title: "Must not persist" }),
  /synthetic write failure/,
);
assert.ok(!research.loadResearchSeeds().some((seed) => seed.id === "failed"));
game.settings.set = write;
game.user = { id: "player", role: 1, isGM: false };
assert.throws(() => research.loadResearchSeeds(), /full GM/);
await assert.rejects(records.applyPrivateDowntimeImport(preview), /full GM/);
game.user = gm2;
local.set("infinity-dnd5e.research.v1.test.gm2", "broken");
await assert.rejects(records.previewPrivateDowntimeImport(), /recovery/);
console.log(
  "Private downtime: additive import, frozen cases, stale previews, conflict refusal, preserved copies, no resurrection, GM handoff and player denial passed.",
);
