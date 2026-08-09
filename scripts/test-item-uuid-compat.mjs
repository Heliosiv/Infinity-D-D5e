import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  LEGACY_INFINITY_ITEM_ID_ALIASES,
  normalizeInfinityItemId,
  normalizeInfinityItemUuid,
  registerInfinityItemUuidRedirects,
  sameInfinityItemUuid,
} from "./item-uuid-compat.js";
import { normalizeDistributableItems } from "./loot/distribute.js";
import { openItemByUuid, resolveItemSnapshot } from "./loot/loot-app-shared.js";
import { buildCompendiumItemUuid } from "./loot/pack.js";
import { itemIdentity } from "./loot/roller.js";
import { normalizeInventoryRow, normalizeMerchant } from "./merchant/store.js";
import { matchResourceItems } from "./resource/consumption.js";
import { normalizeResource } from "./resource/store.js";

const packPrefix = "Compendium.infinity-dnd5e.infinity-dnd5e-items.Item.";
const [legacyId, currentId] = Object.entries(
  LEGACY_INFINITY_ITEM_ID_ALIASES,
)[0];
const legacyUuid = `${packPrefix}${legacyId}`;
const currentUuid = `${packPrefix}${currentId}`;

for (const [oldId, newId] of Object.entries(LEGACY_INFINITY_ITEM_ID_ALIASES)) {
  assert.match(newId, /^[A-Za-z0-9]{16}$/);
  assert.equal(normalizeInfinityItemId(oldId), newId);
  assert.equal(
    normalizeInfinityItemUuid(`${packPrefix}${oldId}`),
    `${packPrefix}${newId}`,
  );
}

assert.equal(normalizeInfinityItemUuid(currentUuid), currentUuid);
assert.equal(
  normalizeInfinityItemUuid(
    `Compendium.party-operations.party-operations-loot-manifest.Item.${legacyId}`,
  ),
  `Compendium.party-operations.party-operations-loot-manifest.Item.${legacyId}`,
  "external source provenance is not rewritten",
);
assert.equal(
  normalizeInfinityItemUuid(`Actor.actor.Item.${legacyId}`),
  `Actor.actor.Item.${legacyId}`,
  "embedded item UUIDs are not rewritten",
);
assert.equal(sameInfinityItemUuid(legacyUuid, currentUuid), true);

const redirectConfig = { compendium: { uuidRedirects: {} } };
assert.equal(registerInfinityItemUuidRedirects(redirectConfig), 3);
assert.deepEqual(
  redirectConfig.compendium.uuidRedirects,
  Object.fromEntries(
    Object.entries(LEGACY_INFINITY_ITEM_ID_ALIASES).map(([oldId, newId]) => [
      `${packPrefix}${oldId}`,
      `${packPrefix}${newId}`,
    ]),
  ),
  "Foundry core redirects every historical module UUID before ready",
);
assert.equal(registerInfinityItemUuidRedirects({}), 0);
const moduleSource = readFileSync("scripts/module.js", "utf8");
const initHookIndex = moduleSource.indexOf('Hooks.once("init"');
const redirectCallIndex = moduleSource.indexOf(
  "registerInfinityItemUuidRedirects();",
  initHookIndex,
);
const readyHookIndex = moduleSource.indexOf('Hooks.once("ready"');
assert.ok(initHookIndex >= 0 && readyHookIndex > initHookIndex);
assert.ok(
  redirectCallIndex > initHookIndex && redirectCallIndex < readyHookIndex,
  "Foundry UUID redirects are configured during init, before core parses them",
);
assert.equal(
  buildCompendiumItemUuid("infinity-dnd5e.infinity-dnd5e-items", legacyId),
  currentUuid,
);
assert.equal(normalizeInventoryRow({ uuid: legacyUuid })?.uuid, currentUuid);
const mergedMerchant = normalizeMerchant({
  id: "legacy-stock",
  items: [
    { uuid: legacyUuid, qty: 2, startingQty: 3 },
    { uuid: currentUuid, qty: 4, startingQty: 5 },
  ],
});
assert.deepEqual(
  mergedMerchant.items.map(({ uuid, qty, startingQty }) => ({
    uuid,
    qty,
    startingQty,
  })),
  [{ uuid: currentUuid, qty: 6, startingQty: 8 }],
  "legacy and current merchant rows merge without losing stock",
);
assert.equal(
  itemIdentity({ uuid: legacyUuid }),
  itemIdentity({ uuid: currentUuid }),
);
assert.equal(normalizeDistributableItems([legacyUuid])[0]?.uuid, currentUuid);

const resource = normalizeResource({
  id: "art",
  matching: { itemUuids: [legacyUuid, currentUuid] },
});
assert.deepEqual(
  resource.matching.itemUuids,
  [currentUuid],
  "saved exact-resource matches canonicalize and deduplicate",
);
assert.equal(
  matchResourceItems(
    [
      {
        _id: "actor-item-0001",
        name: "Court Tapestry",
        system: { quantity: 1 },
        flags: { core: { sourceId: currentUuid } },
      },
    ],
    { matching: { itemUuids: [legacyUuid] } },
  )[0]?.priority,
  3,
  "legacy resource references still match current embedded item sources",
);

const savedFromUuid = globalThis.fromUuid;
const observed = [];
let opened = 0;
globalThis.fromUuid = async (uuid) => {
  observed.push(uuid);
  return {
    uuid,
    name: "Court Tapestry",
    documentName: "Item",
    toObject: () => ({ _id: currentId, name: "Court Tapestry" }),
    sheet: { render: () => (opened += 1) },
  };
};

try {
  const snapshot = await resolveItemSnapshot(legacyUuid);
  assert.equal(snapshot?.uuid, currentUuid);
  assert.equal(await openItemByUuid(legacyUuid), true);
  assert.deepEqual(observed, [currentUuid, currentUuid]);
  assert.equal(opened, 1);
} finally {
  if (savedFromUuid === undefined) delete globalThis.fromUuid;
  else globalThis.fromUuid = savedFromUuid;
}

process.stdout.write("item UUID compatibility validation passed\n");
