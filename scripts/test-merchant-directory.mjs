import assert from "node:assert/strict";
import {
  deleteDirectoryShops,
  filterDirectoryShops,
  moveDirectoryShops,
  nameUnassignedShopLocation,
  removeShopLocation,
  renameShopLocation,
} from "./merchant/directory.js";
import {
  createShopLocation,
  addShopToLocation,
  locationDirectory,
} from "./merchant/locations.js";
import {
  loadMerchants,
  normalizeMerchant,
  shopSetup,
} from "./merchant/store.js";
import { loadMerchantAccessState } from "./merchant/global-access.js";
import { commitMerchantWrite, pushOpenSession } from "./merchant/socket.js";
import {
  listSessions,
  runWithMerchantMutex,
} from "./merchant/session-state.js";

const gm = { id: "gm", role: 4, isGM: true, active: true };
const player = { id: "player", role: 1, isGM: false, active: true };
const users = [gm, player];
users.activeGM = gm;
users.get = (id) => users.find((row) => row.id === id);
const settings = new Map([["soundsEnabled", false]]);
let failCatalogue = false;
let failMerchants = false;
globalThis.CONST = { USER_ROLES: { GAMEMASTER: 4 } };
globalThis.game = {
  ready: false,
  user: gm,
  users,
  settings: {
    get: (_scope, key) => settings.get(key),
    set: async (_scope, key, value) => {
      if (key === "merchantAccess" && failCatalogue)
        throw new Error("Catalogue save failed");
      if (key === "merchants" && failMerchants)
        throw new Error("Shop save failed");
      settings.set(key, structuredClone(value));
      return value;
    },
  },
  socket: { emit() {} },
};
globalThis.ui = { notifications: { info() {}, warn() {}, error() {} } };
const harbor = await createShopLocation({
  name: "Harbor",
  templateId: "empty",
});
const hill = await createShopLocation({ name: "Hill", templateId: "empty" });
settings.set(
  "merchants",
  ["a", "b", "c"].map((id) =>
    normalizeMerchant({
      id,
      name: `Shop ${id}`,
      goldOnHand: 73,
      allowedUserIds: [player.id],
      selfServiceMode: "open",
      shop: {
        locationId: id === "c" ? "" : harbor.id,
        open: true,
        access: "selected",
        startingGold: 100,
      },
      items: [{ uuid: `Item.${id}`, qty: 2, startingQty: 7, priceGp: 9 }],
    }),
  ),
);
const find = (id) => loadMerchants().find((row) => row.id === id);
const before = loadMerchants();
await moveDirectoryShops({ expectedShops: [find("a")], destination: hill.id });
assert.deepEqual(find("a"), {
  ...before[0],
  shop: { ...before[0].shop, locationId: hill.id },
});
assert.deepEqual(find("b"), before[1]);
assert.deepEqual(find("c"), before[2]);
await assert.rejects(
  moveDirectoryShops({ expectedShops: [before[0]], destination: "" }),
  /renamed, moved, or deleted/,
);
await assert.rejects(
  moveDirectoryShops({ expectedShops: [find("a")], destination: "missing" }),
  /no longer exists/,
);
await renameShopLocation({
  locationId: hill.id,
  expectedName: "Hill",
  name: "  High Hill  ",
});
assert.equal(
  locationDirectory().find((row) => row.id === hill.id).name,
  "High Hill",
);
await assert.rejects(
  renameShopLocation({
    locationId: hill.id,
    expectedName: "High Hill",
    name: "harbor",
  }),
  /already exists/,
);
await assert.rejects(
  renameShopLocation({
    locationId: hill.id,
    expectedName: "High Hill",
    name: "  ",
  }),
  /Enter/,
);
await assert.rejects(
  removeShopLocation({
    locationId: hill.id,
    expectedName: "Hill",
    expectedShops: [find("a")],
  }),
  /location changed/,
);
await assert.rejects(
  removeShopLocation({
    locationId: hill.id,
    expectedName: "High Hill",
    expectedShops: [],
  }),
  /shops in this location changed/,
);
const aBeforeRemove = find("a");
failCatalogue = true;
await assert.rejects(
  removeShopLocation({
    locationId: hill.id,
    expectedName: "High Hill",
    expectedShops: [find("a")],
  }),
  /shops already moved are safe/,
);
assert.deepEqual(find("a"), {
  ...aBeforeRemove,
  shop: { ...aBeforeRemove.shop, locationId: "" },
});
assert.ok(locationDirectory().some((row) => row.id === hill.id));
failCatalogue = false;
await removeShopLocation({
  locationId: hill.id,
  expectedName: "High Hill",
  expectedShops: [],
});
assert.ok(!locationDirectory().some((row) => row.id === hill.id));
await assert.rejects(
  addShopToLocation({ locationId: hill.id, templateId: "custom" }),
  /no longer exists/,
);
await assert.rejects(
  removeShopLocation({
    locationId: "",
    expectedName: "Unassigned shops",
    expectedShops: [],
  }),
  /location changed/,
);

// Confirmation snapshots reject renamed/deleted shops, while newer stock and gold survive moves.
const stale = find("a");
await commitMerchantWrite("a", (row) => ({
  ...row,
  name: "Renamed",
  goldOnHand: 64,
}));
await assert.rejects(
  deleteDirectoryShops([stale, find("c")]),
  /renamed, moved, or deleted/,
);
assert.ok(find("c"));
const selected = find("a");
await commitMerchantWrite("a", (row) => ({ ...row, goldOnHand: 61 }));
await moveDirectoryShops({ expectedShops: [selected], destination: harbor.id });
assert.equal(find("a").goldOnHand, 61);
pushOpenSession({ merchant: find("a"), targetUserIds: [player.id] });
pushOpenSession({ merchant: find("b"), targetUserIds: [player.id] });
const bBefore = find("b");
await deleteDirectoryShops([find("a"), find("c")]);
assert.equal(find("a"), undefined);
assert.equal(find("c"), undefined);
assert.deepEqual(find("b"), bBefore);
assert.ok(!listSessions().some((row) => row.merchantId === "a"));
assert.ok(listSessions().some((row) => row.merchantId === "b"));

// A removal waiting behind a trade rechecks membership after acquiring the lock.
let release, started;
const waiting = new Promise((resolve) => {
  started = resolve;
});
const gate = new Promise((resolve) => {
  release = resolve;
});
const trade = runWithMerchantMutex("b", async () => {
  started();
  await gate;
});
await waiting;
const removal = removeShopLocation({
  locationId: harbor.id,
  expectedName: "Harbor",
  expectedShops: [find("b")],
});
await new Promise((resolve) => setImmediate(resolve));
settings.set("merchants", [
  ...loadMerchants(),
  normalizeMerchant({
    id: "new",
    name: "New shop",
    shop: { locationId: harbor.id },
  }),
]);
release();
await trade;
await assert.rejects(removal, /shops in this location changed/);
assert.equal(find("b").shop.locationId, harbor.id);
assert.ok(
  loadMerchantAccessState().locations.some((row) => row.id === harbor.id),
);

const rows = [
  { id: "b", name: "Shop 10", status: "Closed", itemCount: 0 },
  { id: "a", name: "Shop 2", status: "Open", itemCount: 4 },
];
assert.deepEqual(
  filterDirectoryShops(rows).map((row) => row.id),
  ["a", "b"],
);
assert.deepEqual(
  filterDirectoryShops(rows, { filter: "empty" }).map((row) => row.id),
  ["b"],
);
assert.deepEqual(
  filterDirectoryShops(rows, { query: "SHOP", filter: "open" }).map(
    (row) => row.id,
  ),
  ["a"],
);
assert.deepEqual(
  filterDirectoryShops(rows, { sort: "name-desc" }).map((row) => row.id),
  ["b", "a"],
);
assert.equal(rows[0].id, "b", "view sorting never rewrites saved order");
// Orphaned imported locations remain manageable without dropping their shops.
settings.set("merchants", [
  ...loadMerchants(),
  normalizeMerchant({
    id: "imported-shop",
    name: "Imported shop",
    shop: { locationId: "imported" },
  }),
]);
await renameShopLocation({
  locationId: "imported",
  expectedName: "Imported location",
  name: "Recovered city",
});
assert.ok(
  loadMerchantAccessState().locations.some(
    (row) => row.id === "imported" && row.name === "Recovered city",
  ),
);
await removeShopLocation({
  locationId: "imported",
  expectedName: "Recovered city",
  expectedShops: [find("imported-shop")],
});
assert.equal(find("imported-shop").shop.locationId, "");
assert.ok(!locationDirectory().some((row) => row.id === "imported"));

const unassigned = [find("imported-shop")];
const beforeNaming = loadMerchants();
const catalogueBeforeNaming = loadMerchantAccessState();
await assert.rejects(
  nameUnassignedShopLocation({ name: "  ", expectedShops: unassigned }),
  /Enter/,
);
await assert.rejects(
  nameUnassignedShopLocation({ name: "harbor", expectedShops: unassigned }),
  /already exists/,
);
await assert.rejects(
  nameUnassignedShopLocation({ name: "Market", expectedShops: [find("b")] }),
  /unassigned shops changed/,
);
failCatalogue = true;
await assert.rejects(
  nameUnassignedShopLocation({ name: "Market", expectedShops: unassigned }),
  /Catalogue save failed/,
);
failCatalogue = false;
assert.deepEqual(loadMerchants(), beforeNaming);
failMerchants = true;
await assert.rejects(
  nameUnassignedShopLocation({ name: "Market", expectedShops: unassigned }),
  /Shop save failed/,
);
failMerchants = false;
assert.deepEqual(
  loadMerchantAccessState(),
  catalogueBeforeNaming,
  "failed moves remove the empty location",
);
assert.deepEqual(loadMerchants(), beforeNaming);

// Membership may change while waiting for a trade; no shops may be silently omitted.
let unlockNaming, signalNaming;
const namingGate = new Promise((resolve) => {
  unlockNaming = resolve;
});
const namingStarted = new Promise((resolve) => {
  signalNaming = resolve;
});
const namingTrade = runWithMerchantMutex("imported-shop", async () => {
  signalNaming();
  await namingGate;
});
await namingStarted;
const pendingName = nameUnassignedShopLocation({
  name: "Market",
  expectedShops: unassigned,
});
await new Promise((resolve) => setImmediate(resolve));
settings.set("merchants", [
  ...loadMerchants(),
  normalizeMerchant({ id: "late", name: "Late shop" }),
]);
unlockNaming();
await namingTrade;
await assert.rejects(pendingName, /shops in this location changed/);
assert.deepEqual(loadMerchantAccessState(), catalogueBeforeNaming);
const allBeforeNaming = loadMerchants();
const named = await nameUnassignedShopLocation({
  name: "  Xelethar's Market  ",
  expectedShops: allBeforeNaming.filter((row) => !row.shop?.locationId),
});
assert.equal(named.name, "Xelethar's Market");
assert.ok(named.id);
assert.ok(
  locationDirectory().some(
    (row) => row.id === named.id && row.name === named.name,
  ),
);
for (const before of allBeforeNaming)
  assert.deepEqual(
    find(before.id),
    before.shop?.locationId
      ? before
      : { ...before, shop: { ...shopSetup(before), locationId: named.id } },
  );
assert.ok(!locationDirectory().some((row) => row.id === ""));
await renameShopLocation({
  locationId: named.id,
  expectedName: named.name,
  name: "Market Square",
});
assert.equal(
  locationDirectory().find((row) => row.id === named.id).name,
  "Market Square",
);
console.log(
  "Shop organization: preserved data, exact selections, stale edits, safe removal retry, session cleanup, queued membership and filters passed.",
);
