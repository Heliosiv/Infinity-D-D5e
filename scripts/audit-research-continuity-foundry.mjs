import assert from "node:assert/strict";
/** Only synthetic localhost worlds may call this native service journey. */
export async function runResearchNative(gm, player) {
  assert.ok(["localhost", "127.0.0.1"].includes(new URL(gm.url()).hostname));
  assert.equal(await gm.evaluate(() => game.world.id), "downtime-gauntlet");
  const receipt = await gm.evaluate(async () => {
    const service =
      await import("/modules/infinity-dnd5e/scripts/downtime/service.js");
    const records =
      await import("/modules/infinity-dnd5e/scripts/downtime/private-records.js");
    const hunting =
      await import("/modules/infinity-dnd5e/scripts/downtime/hunting-store.js");
    const huntRules =
      await import("/modules/infinity-dnd5e/scripts/downtime/hunting.js");
    const key = `infinity-dnd5e.hunting.v1.${game.world.id}.${game.user.id}`;
    let id = "native-import-" + Date.now();
    const region = huntRules.defaultHuntingRegions()[0];
    let raw = JSON.stringify({
      version: 1,
      regions: {},
      blocks: { [id]: { region, seed: "native-migration-secret-canary" } },
    });
    const privateState =
      await import("/modules/infinity-dnd5e/scripts/private-state.js");
    const priorDigest =
      privateState.getPrivateState("downtimeSecrets")?.imports?.[key];
    if (priorDigest) {
      let recovered = false;
      for (const [savedId, saved] of Object.entries(
        records.readPrivateDowntimeFamily("hunting").blocks,
      )) {
        if (
          !savedId.startsWith("native-import-") ||
          saved.seed !== "native-migration-secret-canary"
        )
          continue;
        const candidate = JSON.stringify({
          version: 1,
          regions: {},
          blocks: { [savedId]: saved },
        });
        const digest = Array.from(
          new Uint8Array(
            await crypto.subtle.digest(
              "SHA-256",
              new TextEncoder().encode(JSON.stringify(candidate)),
            ),
          ),
          (b) => b.toString(16).padStart(2, "0"),
        ).join("");
        if (digest === priorDigest) {
          id = savedId;
          raw = candidate;
          recovered = true;
          break;
        }
      }
      if (!recovered) throw Error("Synthetic import fixture needs recovery");
    }
    localStorage.setItem(key, raw);
    const preview = await records.previewPrivateDowntimeImport();
    await records.applyPrivateDowntimeImport(preview);
    if (
      hunting.loadHuntingBlock(id).seed !== "native-migration-secret-canary" ||
      localStorage.getItem(key) !== raw
    )
      throw Error("Native import readback failed");
    const state = (
      await import("/modules/infinity-dnd5e/scripts/private-state.js")
    ).getPrivateState("downtimeWorkflow");
    if (state.activeBlock)
      await service.cancelActiveDowntimeBlock(state.activeBlock.id);
    const user = game.users.find((u) => u.name === "Gauntlet Player");
    const actor = await Actor.create({
      name: "Native Researcher",
      type: "character",
      system: { currency: { gp: 50 } },
      ownership: { default: 0, [user.id]: 3 },
    });
    let block = await service.openDowntimeBlock({
      mode: "guided",
      locationName: "Synthetic Records Office",
      timeOfDay: "night",
      hours: 4,
      actorIds: [actor.id],
      templateIds: ["guided-research"],
    });
    await service.submitQueueAuthoritatively({
      userId: user.id,
      requestId: id,
      blockId: block.id,
      actorId: actor.id,
      queue: [
        {
          activityId: "guided-research",
          hours: 4,
          skill: "his",
          research: {
            request: "Who closed the synthetic bridge?",
            category: "event",
            subjectText: "Synthetic bridge closure",
          },
          guidedRoll: { total: 16, formula: "1d20 + 5" },
        },
      ],
    });
    block = await service.prepareGuidedDowntimeParticipant({
      blockId: block.id,
      actorId: actor.id,
    });
    const operation = block.plan.operations[0];
    if (operation.researchApproved !== false)
      throw Error("Unprepared case must require approval");
    await service.chooseGuidedDowntimeOutcome({
      blockId: block.id,
      operationId: operation.operationId,
      outcomeIndex: operation.selectedOutcomeIndex,
      researchReview: {
        subject: "Synthetic bridge closure",
        factCards: [
          { tier: 1, text: "The synthetic clerk sealed the bridge." },
          { tier: 2, text: "A synthetic ferryman witnessed the order." },
        ],
        complicationText: "A synthetic clerk logged the inquiry.",
        needsWorldBuilding: true,
        worldBuildingNotes: "Native GM-only followup canary",
      },
    });
    block = await service.applyActiveDowntimeBlock(block.id);
    const projection = await service.getPlayerProjectionForUser({
      userId: user.id,
      actorId: actor.id,
    });
    return { state: block.state, actorId: actor.id, projection };
  });
  assert.equal(receipt.state, "completed");
  assert.match(
    JSON.stringify(receipt.projection),
    /synthetic clerk sealed the bridge/,
  );
  assert.doesNotMatch(
    JSON.stringify(receipt.projection),
    /"dc"|Native GM-only followup canary|native-migration-secret-canary/,
  );
  const delivered = await player.evaluate(async (actorId) => {
    const { getDowntimePlayerAdapter } =
      await import("/modules/infinity-dnd5e/scripts/downtime/ui-adapter.js");
    return JSON.stringify(
      await getDowntimePlayerAdapter().getPlayerProjection({
        actorId,
        force: true,
      }),
    );
  }, receipt.actorId);
  assert.match(delivered, /synthetic clerk sealed the bridge/);
  assert.doesNotMatch(
    delivered,
    /Native GM-only followup canary|native-migration-secret-canary/,
  );
  return receipt.actorId;
}
