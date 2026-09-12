import assert from "node:assert/strict";
import {
  createPlayerHubSuppliesSync,
  formatPlayerHubSuppliesLabel,
  syncPlayerHubSuppliesLabels,
} from "./player-hub-supplies-sync.js";
import {
  buildResourceOverview,
  sanitizeResourceOverview,
} from "./resource/overview.js";
import { RESOURCE_EVENTS } from "./resource/socket.js";

const resource = (id) => ({
  id,
  label: id,
  scope: "per-character",
  perDay: 1,
  matching: { nameKeywords: [id], itemUuids: [] },
});
const config = { resources: [resource("food"), resource("water")] };
const roster = [
  {
    actorId: "stash",
    name: "Stash",
    isStash: true,
    consumes: false,
    items: [
      { id: "food-item", name: "food", system: { quantity: 50 } },
      { id: "water-item", name: "water", system: { quantity: 19 } },
    ],
  },
  ...Array.from({ length: 5 }, (_, i) => ({
    actorId: `pc-${i}`,
    name: `PC ${i}`,
    consumes: true,
    drawFromId: "stash",
    items: [],
  })),
];
let reads = 0;
const readOverview = () => {
  reads += 1;
  return sanitizeResourceOverview(
    buildResourceOverview({ config, roster, autoTrigger: false }),
  );
};
const initialInventory = JSON.stringify(roster);
const flags = (type, key) => ({
  "drakemore-foundry": { [type]: { version: 1, key } },
});
const drawing = {
  id: "supplies",
  x: 2880,
  y: 380,
  shape: { width: 820, height: 300 },
  text: "Party Supplies\nStale",
  flags: flags("playerHubLabel", "party-supplies"),
};
const other = {
  id: "calendar",
  text: "Calendar\nPreserve this",
  flags: flags("playerHubLabel", "calendar"),
};
const tile = {
  id: "supplies-tile",
  x: 2880,
  y: 380,
  width: 820,
  height: 300,
  flags: flags("playerHubControl", "party-supplies"),
};
const writes = [];
const scene = {
  id: "hub",
  width: 3840,
  height: 2160,
  flags: {
    "drakemore-foundry": {
      playerHub: { kind: "interactive-player-hub", version: 1 },
    },
  },
  drawings: [drawing, other],
  tiles: [tile],
  async updateEmbeddedDocuments(type, changes) {
    assert.equal(type, "Drawing");
    assert.deepEqual(Object.keys(changes[0]).sort(), ["_id", "text"]);
    assert.equal(changes[0]._id, drawing.id);
    writes.push(changes);
    drawing.text = changes[0].text;
  },
};
const options = {
  gameRef: { scenes: [scene] },
  readOverview,
  isWriteAuthority: () => true,
  isPlayerViewEnabled: () => true,
};
assert.equal(
  formatPlayerHubSuppliesLabel(readOverview()),
  "Party Supplies\nFood 10 days · Water 3.8 days",
);
assert.deepEqual(await syncPlayerHubSuppliesLabels(options), {
  updated: 1,
  unchanged: 0,
  skipped: 0,
});
assert.equal(
  JSON.stringify(roster),
  initialInventory,
  "display never consumes or changes inventory",
);
assert.equal(
  readOverview().autoTrigger,
  false,
  "manual consumption remains manual",
);
assert.deepEqual(await syncPlayerHubSuppliesLabels(options), {
  updated: 0,
  unchanged: 1,
  skipped: 0,
});
assert.equal(writes.length, 1);
assert.equal(other.text, "Calendar\nPreserve this");

const listeners = new Map();
let subscribeCount = 0;
const service = createPlayerHubSuppliesSync({
  ...options,
  hooks: { on: (event, callback) => listeners.set(event, callback) },
  subscribeToResources: (event, callback) => {
    subscribeCount += 1;
    listeners.set(event, callback);
  },
});
service.start();
assert.equal(service.start(), false, "no duplicate subscriptions");
assert.equal(subscribeCount, 1);
await service.refresh();
roster[0].items[0].system.quantity = 40;
await listeners.get(RESOURCE_EVENTS.STATE_UPDATE)({ reason: "inventory" });
assert.equal(drawing.text, "Party Supplies\nFood 8 days · Water 3.8 days");
roster[0].items[1].system.quantity = 9;
await listeners.get(RESOURCE_EVENTS.STATE_UPDATE)({ reason: "private-state" });
assert.equal(drawing.text, "Party Supplies\nFood 8 days · Water 1.8 days");
roster.pop();
await listeners.get(RESOURCE_EVENTS.STATE_UPDATE)({ reason: "users" });
assert.equal(drawing.text, "Party Supplies\nFood 10 days · Water 2.2 days");
config.waterEnabled = false;
await listeners.get(RESOURCE_EVENTS.STATE_UPDATE)({ reason: "settings" });
assert.equal(drawing.text, "Party Supplies\nFood 10 days · Water Not tracked");
drawing.text = "Party Supplies\nStale again";
await listeners.get("canvasReady")();
assert.equal(drawing.text, "Party Supplies\nFood 10 days · Water Not tracked");

const beforeDenied = reads;
await syncPlayerHubSuppliesLabels({
  ...options,
  isWriteAuthority: () => false,
});
assert.equal(
  reads,
  beforeDenied,
  "no reading private-backed projection without ready authority",
);
let authority = true;
const priorWrites = writes.length;
await syncPlayerHubSuppliesLabels({
  ...options,
  isWriteAuthority: () => authority,
  readOverview: async () => {
    authority = false;
    return { schemaVersion: 1, resources: [] };
  },
});
assert.equal(
  writes.length,
  priorWrites,
  "authority loss during await stops the write",
);
await syncPlayerHubSuppliesLabels({
  ...options,
  isPlayerViewEnabled: () => false,
});
assert.equal(drawing.text, "Party Supplies\nUnavailable");

for (const mutate of [
  () => scene.drawings.push({ ...drawing, id: "duplicate", x: 0 }),
  () => scene.tiles.push({ ...tile, id: "duplicate-tile" }),
  () => {
    drawing.x = 0;
  },
  () => {
    scene.flags["drakemore-foundry"].playerHub.version = 2;
  },
]) {
  const before = writes.length;
  const saved = JSON.stringify({
    drawings: scene.drawings,
    tiles: scene.tiles,
    flags: scene.flags,
  });
  mutate();
  await syncPlayerHubSuppliesLabels(options);
  assert.equal(
    writes.length,
    before,
    "unknown or ambiguous layout fails closed",
  );
  const restore = JSON.parse(saved);
  Object.assign(drawing, restore.drawings[0]);
  scene.drawings = [drawing, other];
  scene.tiles = [tile];
  scene.flags = restore.flags;
}
assert.equal(formatPlayerHubSuppliesLabel(null), null);
assert.equal(
  formatPlayerHubSuppliesLabel({ schemaVersion: 2, resources: [] }),
  null,
);
assert.equal(
  formatPlayerHubSuppliesLabel({
    schemaVersion: 1,
    resources: [{ id: "food", coverageLabel: "bad\nlabel" }],
  }),
  null,
);
assert.equal(
  formatPlayerHubSuppliesLabel({
    schemaVersion: 1,
    resources: [{ id: "food" }, { id: "food" }],
  }),
  null,
);
assert.equal(
  formatPlayerHubSuppliesLabel({ schemaVersion: 1, resources: [] }),
  "Party Supplies\nFood Not configured · Water Not configured",
);

// An event during an async read must get a trailing fresh read, not be dropped.
let releaseRead;
let readCount = 0;
const queuedService = createPlayerHubSuppliesSync({
  ...options,
  readOverview: async () => {
    readCount += 1;
    if (readCount === 1)
      await new Promise((resolve) => {
        releaseRead = resolve;
      });
    return readOverview();
  },
});
const first = queuedService.refresh();
await Promise.resolve();
queuedService.refresh();
releaseRead();
await first;
assert.equal(readCount, 2);

let ready = false;
const recoveryListeners = new Map();
const recoveryService = createPlayerHubSuppliesSync({
  ...options,
  isWriteAuthority: () => ready,
  hooks: { on() {} },
  subscribeToResources: (event, callback) =>
    recoveryListeners.set(event, callback),
});
drawing.text = "Party Supplies\nBefore recovery";
recoveryService.start();
await recoveryService.refresh();
assert.equal(drawing.text, "Party Supplies\nBefore recovery");
ready = true;
await recoveryListeners.get(RESOURCE_EVENTS.STATE_UPDATE)({
  reason: "authority-recovery",
});
assert.equal(drawing.text, "Party Supplies\nFood 10 days · Water Not tracked");
console.log("player-hub supplies sync validation passed");
