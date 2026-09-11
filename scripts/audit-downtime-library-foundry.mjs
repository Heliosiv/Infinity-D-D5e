/** Real GM/player journeys; invoked only by the guarded disposable-world runner. */
import assert from "node:assert/strict";
import path from "node:path";
import { ADDITIONAL_GUIDED_ACTIVITIES } from "./downtime/activity-library.js";

export async function runActivityLibraryFoundryJourney({
  gm,
  player,
  actorIds,
  worldTime,
  output,
  record,
  openUiBlock,
  submitUiChoices,
  prepareParticipant,
  selectResult,
  waitCompleted,
  state,
  waitForParticipantReceipt,
}) {
  await gm.evaluate(async (ids) => {
    if (game.world.id !== "downtime-gauntlet") throw Error("Wrong test world");
    for (const id of ids) {
      const actor = game.actors.get(id);
      if (!actor.getFlag("infinity-dnd5e", "downtimeGauntletActor"))
        throw Error("Expected marked test character");
      await actor.update({
        "system.currency": { gp: 100, pp: 0, ep: 0, sp: 0, cp: 0 },
      });
    }
  }, actorIds);
  const characterState = () =>
    gm.evaluate(
      (ids) =>
        ids.map((id) => {
          const actor = game.actors.get(id);
          return {
            hp:
              actor.system.attributes.hp.toObject?.() ??
              actor.system.attributes.hp,
            skills: actor.toObject().system.skills,
            items: actor.items.map((item) => item.toObject()),
            effects: actor.effects.map((effect) => effect.toObject()),
          };
        }),
      actorIds,
    );
  const unchangedCharacters = await characterState();
  for (const [index, activity] of ADDITIONAL_GUIDED_ACTIVITIES.entries()) {
    console.log(`Testing installed activity: ${activity.name}`);
    const before = await state();
    // Respect released whole-block activity rules; cover one-hour reflection and the maximum allocation.
    const hours =
      activity.id === "guided-reflection"
        ? 1
        : activity.id === "guided-contacts"
          ? 240
          : 8;
    const outcomeIndex = index % 3;
    await openUiBlock(activity.id, `Gauntlet: ${activity.name}`, hours);
    await submitUiChoices(activity.id, activity.skills.length > 0);
    for (const actorId of actorIds) {
      await prepareParticipant(actorId);
      await selectResult(outcomeIndex);
      await gm.locator('[data-action="applyBlock"]').click();
      await waitForParticipantReceipt(
        actorId,
        new RegExp(
          activity.outcomes[outcomeIndex].report.replace(
            /[.*+?^${}()|[\]\\]/g,
            "\\$&",
          ),
        ),
      );
    }
    const completed = await waitCompleted();
    const costCp = Math.ceil(
      ((activity.work?.gpPerDay ?? 0) * 100 * hours) / 8,
    );
    const deltaCp = activity.outcomes[outcomeIndex].rewardGp * 100 - costCp;
    assert.deepEqual(
      completed.wallets,
      before.wallets.map((cp) => cp + deltaCp),
    );
    assert.equal(completed.time, worldTime);
    await gm.evaluate(async (id) => {
      const service =
        await import("/modules/infinity-dnd5e/scripts/downtime/service.js");
      await Promise.all([
        service.applyActiveDowntimeBlock(id),
        service.applyActiveDowntimeBlock(id),
      ]);
    }, completed.blockId);
    assert.deepEqual(
      (await state()).wallets,
      completed.wallets,
      "Repeated apply cannot charge or reward twice",
    );
    assert.deepEqual(
      await characterState(),
      unchangedCharacters,
      "Narrative activities never change HP, skills, inventory, or effects",
    );
    record(`installed activity: ${activity.name}`, {
      hours,
      outcomeIndex,
      deltaCp,
      noRoll: activity.skills.length === 0,
      duplicateApplySafe: true,
      wallets: completed.wallets,
    });
  }
  await player
    .locator(".infinity-downtime-activities")
    .screenshot({ path: path.join(output, "new-activity-receipt.png") });
}
