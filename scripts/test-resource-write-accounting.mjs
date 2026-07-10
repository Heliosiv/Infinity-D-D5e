import assert from "node:assert/strict";

import {
  applyConsumptionOps,
  depositResource,
} from "./resource/calendar-watcher.js";

const savedFromUuid = globalThis.fromUuid;

try {
  const actor = {
    name: "Failure Fixture",
    async updateEmbeddedDocuments() {
      throw new Error("update denied");
    },
    async deleteEmbeddedDocuments() {
      return [];
    },
  };
  const result = await applyConsumptionOps(
    actor,
    [
      { id: "stack-a", op: "decrement", to: 3 },
      { id: "stack-b", op: "delete" },
    ],
    [
      { id: "stack-a", quantity: 5 },
      { id: "stack-b", quantity: 4 },
    ],
  );
  assert.equal(result.consumed, 4, "reports only the delete that actually landed");
  assert.match(result.error, /1 inventory write/);

  let created = null;
  const sink = {
    name: "Empty Pack",
    items: { contents: [], get: () => null },
    async createEmbeddedDocuments(_type, docs) {
      created = docs[0];
      return docs;
    },
  };
  globalThis.fromUuid = async () => null;
  const deposited = await depositResource(
    sink,
    {
      id: "food",
      label: "Food (Rations)",
      matching: { itemUuids: [], nameKeywords: ["ration"], flagTag: "food" },
    },
    3,
  );
  assert.equal(deposited, 3, "default resource template creates a new stack");
  assert.equal(created.system.quantity, 3);
  assert.equal(created.flags["infinity-dnd5e"].resourceTag, "food");

  process.stdout.write("resource write-accounting validation passed\n");
} finally {
  if (savedFromUuid === undefined) delete globalThis.fromUuid;
  else globalThis.fromUuid = savedFromUuid;
}
