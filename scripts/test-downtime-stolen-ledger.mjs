import assert from "node:assert/strict";

import {
  activeStolenGoodsRecord,
  buildStolenGoodsConsumption,
  buildStolenGoodsIssuance,
  consumeStolenGoodsRecord,
  hasActiveStolenGoodsIssuance,
  hasStolenGoodsIssuance,
  issueStolenGoodsRecord,
  normalizeStolenGoodsLedger,
  stolenGoodsRecordsEqual,
} from "./downtime/stolen-ledger.js";

const snapshot = {
  _id: "stolen-item-1",
  name: "Silver Ring",
  system: { quantity: 1 },
  flags: {
    "infinity-dnd5e": {
      stolen: {
        settlementId: "greyhaven",
        targetType: "generated-mark",
        sourceId: "mark-1",
        merchantId: null,
        operationId: "theft-operation-1",
        timestamp: 1_000,
        appraisedValueCp: 3_000,
      },
    },
  },
};
const issuance = buildStolenGoodsIssuance({ actorId: "actor-1", snapshot });
assert.ok(issuance);

const issued = issueStolenGoodsRecord({}, issuance);
assert.equal(issued.ok, true);
assert.equal(issued.alreadyIssued, false);
assert.equal(
  hasActiveStolenGoodsIssuance(issued.ledger, "actor-1", snapshot._id),
  true,
);
assert.ok(
  activeStolenGoodsRecord(issued.ledger, {
    actorId: "actor-1",
    itemId: snapshot._id,
    item: snapshot,
  }),
);

const replay = issueStolenGoodsRecord(issued.ledger, issuance);
assert.equal(replay.ok, true);
assert.equal(replay.alreadyIssued, true);

const copied = { ...issuance, itemId: "copied-item" };
assert.equal(
  activeStolenGoodsRecord(issued.ledger, {
    actorId: "actor-1",
    itemId: copied.itemId,
    item: { ...snapshot, _id: copied.itemId },
  }),
  null,
  "a copied item ID has no issuance proof",
);
assert.equal(
  activeStolenGoodsRecord(issued.ledger, {
    actorId: "actor-2",
    itemId: snapshot._id,
    item: snapshot,
  }),
  null,
  "an issuance cannot move to another Actor",
);

const valueTamper = structuredClone(snapshot);
valueTamper.flags["infinity-dnd5e"].stolen.appraisedValueCp = 99_999;
assert.equal(
  activeStolenGoodsRecord(issued.ledger, {
    actorId: "actor-1",
    itemId: snapshot._id,
    item: valueTamper,
  }),
  null,
  "a client-writable value change invalidates the exact issuance proof",
);

const consumption = buildStolenGoodsConsumption(issuance, {
  fenceOperationId: "fence-operation-1",
  consumedAt: 2_000,
});
assert.ok(consumption);
const consumed = consumeStolenGoodsRecord(issued.ledger, consumption);
assert.equal(consumed.ok, true);
assert.equal(consumed.alreadyConsumed, false);
assert.equal(
  hasActiveStolenGoodsIssuance(consumed.ledger, "actor-1", snapshot._id),
  false,
);
assert.equal(
  hasStolenGoodsIssuance(consumed.ledger, "actor-1", snapshot._id),
  true,
  "consumed deterministic IDs remain reserved against ordinary resale",
);
assert.equal(
  consumeStolenGoodsRecord(consumed.ledger, consumption).alreadyConsumed,
  true,
);
assert.equal(
  issueStolenGoodsRecord(consumed.ledger, issuance).ok,
  false,
  "a consumed deterministic item ID cannot be reissued",
);
assert.equal(
  stolenGoodsRecordsEqual(
    normalizeStolenGoodsLedger(consumed.ledger)[snapshot._id],
    consumption,
  ),
  true,
);

process.stdout.write("downtime stolen-goods issuance ledger passed\n");
