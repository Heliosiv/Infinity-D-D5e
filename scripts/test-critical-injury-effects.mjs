import assert from "node:assert/strict";

const savedConst = globalThis.CONST;
globalThis.CONST = {
  ACTIVE_EFFECT_MODES: { MULTIPLY: 1, ADD: 2, OVERRIDE: 5 },
};

try {
  const { createCriticalInjuryEffect, getCriticalInjuryData } =
    await import("./injury/effects.js");
  const injury = {
    id: "injury-1",
    pendingId: "pending-1",
    actorId: "actor-1",
    injuryKey: "deep-scar",
    injuryName: "Deep Scar",
    injuryRoll: 74,
    remainingDays: 0,
    permanent: true,
  };
  const actor = createActor("actor-1", {
    applyThenThrow: true,
  });
  const recovered = await createCriticalInjuryEffect(actor, injury, {
    documentId: "effectdoc0000001",
  });
  assert.equal(actor.effects.contents.length, 1);
  assert.equal(recovered.id, "effectdoc0000001");
  assert.equal(getCriticalInjuryData(recovered).id, injury.id);
  assert.equal(getCriticalInjuryData(recovered).pendingId, injury.pendingId);

  const collision = createEffect({
    id: "effectdoc0000002",
    injuryId: "injury-other",
    pendingId: "pending-other",
  });
  const collisionActor = createActor("actor-2", {
    existing: [collision],
    throwBeforeApply: true,
  });
  await assert.rejects(
    createCriticalInjuryEffect(collisionActor, injury, {
      documentId: collision.id,
    }),
    /documentcollision/i,
    "a deterministic document ID with different injury flags fails closed",
  );
  assert.equal(collisionActor.effects.contents.length, 1);
  assert.equal(getCriticalInjuryData(collision).id, "injury-other");
} finally {
  if (savedConst === undefined) delete globalThis.CONST;
  else globalThis.CONST = savedConst;
}

function createActor(id, { existing = [], applyThenThrow, throwBeforeApply }) {
  const actor = {
    id,
    uuid: `Actor.${id}`,
    effects: { contents: [...existing] },
    async createEmbeddedDocuments(type, rows, options) {
      assert.equal(type, "ActiveEffect");
      assert.deepEqual(options, { keepId: true });
      if (throwBeforeApply) throw new Error("duplicate document id");
      const created = rows.map((row) =>
        createEffect({
          id: row._id,
          flags: row.flags,
        }),
      );
      this.effects.contents.push(...created);
      if (applyThenThrow) throw new Error("duplicate response after apply");
      return created;
    },
  };
  return actor;
}

function createEffect({ id, flags = null, injuryId = "", pendingId = "" }) {
  return {
    id,
    flags: flags ?? {
      "infinity-dnd5e": {
        criticalInjury: { id: injuryId, pendingId },
      },
    },
    getFlag(moduleId, key) {
      return this.flags?.[moduleId]?.[key];
    },
  };
}

process.stdout.write("critical injury effect idempotency passed\n");
