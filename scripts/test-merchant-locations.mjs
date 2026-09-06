import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  createShopLocation,
  addShopToLocation,
  applyLocationOperation,
  locationDirectory,
  LOCATION_TEMPLATES,
} from "./merchant/locations.js";
import { applyMerchantPricingMacro } from "./merchant/pricing-macros.js";
import {
  loadMerchantAccessState,
  saveMerchantAccessState,
} from "./merchant/global-access.js";
import {
  loadMerchants,
  normalizeMerchant,
  canSelfOpen,
  sanitizeMerchantForList,
  shopSetup,
} from "./merchant/store.js";
import {
  commitMerchantWrite,
  pushOpenSession,
  receiveMerchantPayload,
  subscribe,
  MERCHANT_EVENTS,
} from "./merchant/socket.js";
import {
  listSessions,
  runWithMerchantMutex,
} from "./merchant/session-state.js";
import { projectMerchantForSession } from "./merchant/projection.js";

const gm = { id: "gm", name: "GM", isGM: true, role: 4, active: true };
const players = ["p1", "p2"].map((id) => ({
  id,
  name: id,
  role: 1,
  isGM: false,
  active: true,
}));
const users = [gm, ...players];
users.activeGM = gm;
users.get = (id) => users.find((row) => row.id === id);
let writes = 0;
const settings = new Map([
  ["merchants", []],
  ["soundsEnabled", false],
]);
globalThis.CONST = { USER_ROLES: { GAMEMASTER: 4 } };
globalThis.game = {
  ready: false,
  user: gm,
  users,
  settings: {
    get: (_scope, key) => settings.get(key),
    set: async (_scope, key, value) => {
      writes++;
      settings.set(key, structuredClone(value));
      return value;
    },
  },
  socket: { emit() {} },
};
globalThis.ui = { notifications: { info() {}, warn() {}, error() {} } };
const items = readFileSync("packs/infinity-dnd5e-items.db", "utf8")
  .split(/\r?\n/)
  .filter(Boolean)
  .map(JSON.parse)
  .filter((row) => row._id && !row.$$deleted)
  .map((row) => ({
    ...row,
    uuid: `Compendium.infinity-dnd5e.infinity-dnd5e-items.Item.${row._id}`,
  }));
const legacy = normalizeMerchant({
  id: "legacy",
  name: "Existing contact",
  goldOnHand: 75,
  allowedUserIds: ["p1"],
  selfServiceMode: "knock",
  items: [{ uuid: "Item.legacy", qty: 2, startingQty: 5 }],
});
settings.set("merchants", [legacy]);
assert.equal(
  Object.hasOwn(legacy, "shop"),
  false,
  "legacy durable checkpoints retain their original shape",
);
assert.equal(locationDirectory()[0].name, "Unassigned shops");

const created = [];
for (const template of LOCATION_TEMPLATES) {
  const location = await createShopLocation({
    name: template.id,
    templateId: template.id,
    items,
  });
  created.push(location);
  const shops = loadMerchants().filter(
    (row) => row.shop?.locationId === location.id,
  );
  assert.equal(shops.length, template.shops.length);
  for (const shop of shops) {
    assert.ok(
      shop.items.length > 0,
      `${shop.name} must stock real shipped items`,
    );
    assert.equal(shop.goldOnHand, template.gold);
    assert.equal(shop.shop.startingGold, template.gold);
    assert.equal(shop.shop.open, false);
    assert.equal(shop.shop.access, "all");
  }
}
assert.deepEqual(
  loadMerchants()[0],
  legacy,
  "creating locations leaves existing merchants untouched",
);
const [village, town, city, empty] = created;
const ids = (location) =>
  loadMerchants()
    .filter((row) => row.shop?.locationId === location.id)
    .map((row) => row.id);
const act = (location, operation, extra = {}) =>
  applyLocationOperation({
    locationId: location.id,
    operation,
    expectedIds: ids(location),
    items,
    ...extra,
  });

const pricingTargets = ids(village).slice(0, 2);
const pricingResult = await applyMerchantPricingMacro({
  merchantIds: pricingTargets,
  patch: { defaultMarkup: 1.37, sellRatio: 0.42 },
});
assert.equal(pricingResult.changedCount, 2);
assert.equal(pricingResult.verified, true);
for (const merchantId of pricingTargets) {
  const merchant = loadMerchants().find((row) => row.id === merchantId);
  assert.equal(merchant.defaultMarkup, 1.37);
  assert.equal(merchant.sellRatio, 0.42);
}

await act(village, "open");
await act(town, "open");
assert.equal(
  locationDirectory().find((row) => row.id === village.id).status,
  "Open",
);
assert.equal(
  locationDirectory().find((row) => row.id === town.id).status,
  "Open",
);
const villageShop = loadMerchants().find(
  (row) => row.shop?.locationId === village.id,
);
assert.equal(
  canSelfOpen(villageShop, "p2"),
  true,
  "new template shops require no player checklist",
);
assert.equal(canSelfOpen(villageShop, "gm"), false);
const latePlayer = { id: "late", role: 1, active: true, isGM: false };
users.push(latePlayer);
assert.equal(
  canSelfOpen(villageShop, "late"),
  true,
  "all-players access includes later accounts",
);
assert.equal(sanitizeMerchantForList(villageShop).shop, undefined);
assert.equal(
  projectMerchantForSession(villageShop).shop,
  undefined,
  "private location/setup data is not sent with trades",
);
pushOpenSession({ merchant: villageShop, targetUserIds: ["p1"] });
const townShop = loadMerchants().find(
  (row) => row.shop?.locationId === town.id,
);
pushOpenSession({ merchant: townShop, targetUserIds: ["p2"] });
await act(village, "close");
assert.equal(
  listSessions().some((row) => row.merchantId === villageShop.id),
  false,
);
assert.equal(
  listSessions().some((row) => row.merchantId === townShop.id),
  true,
  "closing a location preserves another location's sessions",
);
assert.equal(
  canSelfOpen(
    loadMerchants().find((row) => row.id === villageShop.id),
    "p1",
  ),
  false,
);

// A scoped shop keeps its restriction through Close/Open and cannot be entered
// by another player using a forged request.
await commitMerchantWrite(villageShop.id, (row) => ({
  ...row,
  allowedUserIds: ["p1"],
  shop: { ...row.shop, access: "selected" },
}));
await act(village, "open");
const restricted = loadMerchants().find((row) => row.id === villageShop.id);
assert.equal(canSelfOpen(restricted, "p2"), false);
assert.equal(canSelfOpen(restricted, "p1"), true);
const replies = [];
const unsubscribe = subscribe(MERCHANT_EVENTS.SHOP_REQUEST_RESULT, (reply) =>
  replies.push(reply),
);
await receiveMerchantPayload(
  {
    type: MERCHANT_EVENTS.SHOP_REQUEST,
    originUserId: "p2",
    merchantId: restricted.id,
  },
  "p2",
);
assert.equal(
  listSessions().some(
    (row) => row.merchantId === restricted.id && row.viewerUserId === "p2",
  ),
  false,
);
unsubscribe();

await commitMerchantWrite(villageShop.id, (row) => ({
  ...row,
  goldOnHand: 3,
  items: row.items.map((item) => ({ ...item, qty: 0 })),
}));
const otherBefore = loadMerchants().filter(
  (row) => row.shop?.locationId !== village.id,
);
const beforeRestockWrites = writes;
await act(village, "restock");
assert.equal(
  writes,
  beforeRestockWrites + 1,
  "all shelves and purses commit in one write",
);
let current = loadMerchants().find((row) => row.id === villageShop.id);
assert.equal(current.goldOnHand, 250);
assert.ok(
  current.items.every((row) => row.unlimited || row.qty === row.startingQty),
);
assert.deepEqual(
  loadMerchants().filter((row) => row.shop?.locationId !== village.id),
  otherBefore,
);
await act(village, "clear");
assert.ok(
  loadMerchants()
    .filter((row) => row.shop?.locationId === village.id)
    .every((row) => row.items.length === 0 && row.goldOnHand === 250),
);
await act(village, "generate");
assert.ok(
  loadMerchants()
    .filter((row) => row.shop?.locationId === village.id)
    .every((row) => row.items.length > 0 && row.goldOnHand === 250),
);

const beforeBadGeneration = structuredClone(loadMerchants());
await assert.rejects(
  act(village, "generate", { items: [] }),
  /No inventories were changed/,
);
assert.deepEqual(
  loadMerchants(),
  beforeBadGeneration,
  "failed bulk generation changes no shop",
);
await assert.rejects(
  act(village, "clear", { expectedIds: [villageShop.id] }),
  /shops in this location changed/,
);
assert.deepEqual(
  loadMerchants(),
  beforeBadGeneration,
  "stale location membership cannot clear a different set of shops",
);

// Restocking queues behind an in-progress transaction, using its latest state.
let release;
let started;
const startedPromise = new Promise((resolve) => {
  started = resolve;
});
const releasePromise = new Promise((resolve) => {
  release = resolve;
});
const trade = runWithMerchantMutex(villageShop.id, async () => {
  started();
  await releasePromise;
});
await startedPromise;
let done = false;
const waiting = act(village, "restock").then(() => {
  done = true;
});
await new Promise((resolve) => setImmediate(resolve));
assert.equal(
  done,
  false,
  "bulk writes wait for the same merchant transaction lock",
);
release();
await Promise.all([trade, waiting]);

// An old world-wide closure is lifted for just the chosen location.
await saveMerchantAccessState({ closed: true, suspendedSessions: [] });
await act(city, "open");
assert.equal(loadMerchantAccessState().closed, false);
assert.equal(
  locationDirectory().find((row) => row.id === town.id).status,
  "Closed",
);
assert.equal(
  locationDirectory().find((row) => row.id === city.id).status,
  "Open",
);
assert.equal(
  loadMerchantAccessState().locations.length,
  4,
  "legacy global writes preserve the location catalogue",
);
await act(town, "open");
assert.equal(
  locationDirectory().find((row) => row.id === city.id).status,
  "Open",
);

const custom = await addShopToLocation({
  locationId: empty.id,
  templateId: "custom",
});
assert.equal(custom.items.length, 0);
assert.equal(custom.shop.locationId, empty.id);
assert.equal(custom.shop.access, "all");
assert.equal(shopSetup(legacy).startingGold, 75);
assert.equal(locationDirectory().find((row) => row.id === empty.id).count, 1);
const countBeforeDuplicate = loadMerchants().length;
await assert.rejects(
  createShopLocation({ name: "VILLAGE", templateId: "village", items }),
  /already exists/,
);
assert.equal(loadMerchants().length, countBeforeDuplicate);

// Exercise the real editor save with a stale form purse after a player trade.
globalThis.foundry = {
  applications: {
    api: {
      ApplicationV2: class {},
      HandlebarsApplicationMixin: (Base) => class extends Base {},
    },
  },
  utils: { deepClone: structuredClone },
};
const { MerchantWorkspaceApp } = await import("./merchant-workspace.js");
const editor = Object.create(MerchantWorkspaceApp.prototype);
const form = {
  querySelector: (selector) => (selector === '[name="shopOpen"]' ? {} : null),
};
editor._selectedId = townShop.id;
editor.element = {
  querySelector: (selector) =>
    selector === '[data-form="merchant-edit"]' ? form : null,
};
const originalFormData = globalThis.FormData;
globalThis.FormData = class {
  entries() {
    return [
      ["name", "Updated name"],
      ["goldOnHand", "1000"],
      ["startingGold", "600"],
      ["shopLocationId", town.id],
      ["shopOpen", "on"],
      ["accessAll", "on"],
      ["poolRarities", "common"],
      ["poolCount", "12"],
    ];
  }
};
await commitMerchantWrite(townShop.id, (merchant) => ({
  ...merchant,
  goldOnHand: 987,
}));
try {
  await editor._saveFromForm();
} finally {
  globalThis.FormData = originalFormData;
}
const afterSave = loadMerchants().find((row) => row.id === townShop.id);
assert.equal(
  afterSave.goldOnHand,
  987,
  "editing a name never restores stale gold from the form",
);
assert.equal(
  afterSave.shop.startingGold,
  600,
  "the next restock purse saves separately",
);
assert.equal(afterSave.name, "Updated name");

// Exercise the actual directory action handlers, including cancel, double-click
// suppression, and selecting the newly created location.
let confirms = 0;
let allowConfirm = false;
globalThis.foundry.applications.api.DialogV2 = {
  confirm: async () => {
    confirms++;
    return allowConfirm;
  },
};
globalThis.game.packs = { get: () => ({ getDocuments: async () => items }) };
const directory = Object.create(MerchantWorkspaceApp.prototype);
Object.assign(directory, {
  rendered: true,
  _selectedLocationId: town.id,
  _locationBusy: false,
  render() {},
  element: {
    querySelectorAll: () => [],
    querySelector: (selector) =>
      selector === "[data-location-form]"
        ? {
            reportValidity: () => true,
            querySelector: (field) => ({
              value: field === '[name="locationName"]' ? "New capital" : "city",
            }),
          }
        : null,
  },
});
const actions = MerchantWorkspaceApp.DEFAULT_OPTIONS.actions;
const beforeCancel = structuredClone(loadMerchants());
await actions.locationOperation.call(directory, null, {
  dataset: { operation: "clear" },
});
assert.equal(
  confirms,
  1,
  "a destructive location action asks once for the entire location",
);
assert.deepEqual(loadMerchants(), beforeCancel);
await actions.locationOperation.call(directory, null, {
  dataset: { operation: "open" },
});
assert.equal(confirms, 1, "opening needs no approval dialog");
directory._locationBusy = true;
await actions.locationOperation.call(directory, null, {
  dataset: { operation: "restock" },
});
assert.equal(
  directory._locationBusy,
  true,
  "a repeated action cannot finish the first action's busy state",
);
directory._locationBusy = false;
await actions.createLocation.call(directory);
assert.equal(
  locationDirectory().find((row) => row.id === directory._selectedLocationId)
    .name,
  "New capital",
);
assert.equal(ids({ id: directory._selectedLocationId }).length, 7);
console.log(
  "Location templates use the real library; two-location access, atomic stock/gold resets, restrictions, stale membership, transaction locking, and legacy migration passed",
);
