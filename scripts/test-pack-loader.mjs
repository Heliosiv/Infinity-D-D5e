import assert from "node:assert/strict";

import {
  buildCompendiumItemUuid,
  invalidatePackCache,
  isFullCompendiumDocumentUuid,
  loadCompendiumItems,
} from "./loot/pack.js";

{
  assert.equal(
    buildCompendiumItemUuid(
      "infinity-dnd5e.infinity-dnd5e-items",
      "aRt16Scn4Rs0Ht7",
    ),
    "Compendium.infinity-dnd5e.infinity-dnd5e-items.Item.aRt16Scn4Rs0Ht7",
    "fallback UUID includes the Item document type",
  );
  assert.equal(
    isFullCompendiumDocumentUuid(
      "Compendium.infinity-dnd5e.infinity-dnd5e-items.Item.aRt16Scn4Rs0Ht7",
    ),
    true,
  );
  assert.equal(
    isFullCompendiumDocumentUuid(
      "Compendium.infinity-dnd5e.infinity-dnd5e-items.aRt16Scn4Rs0Ht7",
    ),
    false,
    "legacy missing-document-type UUIDs are not accepted",
  );
}

{
  const originalGame = globalThis.game;
  const originalUi = globalThis.ui;
  const packId = "infinity-dnd5e.test-items";
  invalidatePackCache(packId);

  globalThis.ui = { notifications: { warn() {}, error() {} } };
  globalThis.game = {
    packs: new Map([
      [
        packId,
        {
          metadata: { type: "Item" },
          async getDocuments() {
            return [
              {
                id: "fallback-id",
                documentName: "Item",
                toObject() {
                  return { _id: "fallback-id", name: "Fallback Item" };
                },
              },
              {
                id: "native-id",
                uuid: "Compendium.infinity-dnd5e.test-items.Item.native-id",
                documentName: "Item",
                toObject() {
                  return { _id: "native-id", name: "Native UUID Item" };
                },
              },
            ];
          },
        },
      ],
    ]),
  };

  try {
    const items = await loadCompendiumItems({ packId, refresh: true });
    assert.equal(
      items[0].uuid,
      "Compendium.infinity-dnd5e.test-items.Item.fallback-id",
      "documents without native uuid get a full compendium Item UUID",
    );
    assert.equal(
      items[1].uuid,
      "Compendium.infinity-dnd5e.test-items.Item.native-id",
      "valid native UUIDs are preserved",
    );

    let loads = 0;
    const expiringPackId = "infinity-dnd5e.expiring-items";
    globalThis.game.packs.set(expiringPackId, {
      metadata: { type: "Item" },
      async getDocuments() {
        loads += 1;
        return [
          { id: `item-${loads}`, toObject: () => ({ _id: `item-${loads}` }) },
        ];
      },
    });
    const realNow = Date.now;
    try {
      Date.now = () => 1000;
      await loadCompendiumItems({ packId: expiringPackId, ttlMs: 100 });
      Date.now = () => 1050;
      await loadCompendiumItems({ packId: expiringPackId, ttlMs: 100 });
      assert.equal(loads, 1, "cache remains fresh inside the configured TTL");
      Date.now = () => 1101;
      await loadCompendiumItems({ packId: expiringPackId, ttlMs: 100 });
      assert.equal(loads, 2, "cache expires at the caller-configured TTL");
    } finally {
      Date.now = realNow;
      invalidatePackCache(expiringPackId);
    }
  } finally {
    invalidatePackCache(packId);
    if (originalGame === undefined) delete globalThis.game;
    else globalThis.game = originalGame;
    if (originalUi === undefined) delete globalThis.ui;
    else globalThis.ui = originalUi;
  }
}

process.stdout.write("pack loader validation passed\n");
