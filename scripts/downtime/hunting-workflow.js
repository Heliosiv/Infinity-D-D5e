/** Hunting integrates with guided submission and the existing inventory ledger. */
import {
  HUNTING_ID,
  findHuntingGame,
  huntingHit,
  huntingSummary,
  huntingYield,
} from "./hunting.js";
import { loadHuntingBlock } from "./hunting-store.js";
import { requireHuntingEquipment } from "./hunting-equipment.js";
import { deterministicDowntimeRoll } from "./opportunities.js";
import { guidedWorkItemIdentity, buildGuidedWorkPlan } from "./work.js";
import { loadResourceConfig } from "../resource/store.js";
const MODULE_ID = "infinity-dnd5e";
export function huntingQueueKey(queue) {
  return JSON.stringify(queue.map(({ guidedAttack, ...entry }) => entry));
}
export function prepareHuntingAttempt(block, actor, queue) {
  const entry = queue.find((e) => e.activityId === HUNTING_ID);
  const previous = block.participants.find((p) => p.actorId === actor.id)?.hunt;
  if (previous && previous.queueKey !== huntingQueueKey(queue))
    throw new Error(
      "This hunt has started. Its time, equipment, checks and allocation cannot be changed.",
    );
  if (!entry) return null;
  if (!block.huntingProfile)
    throw new Error(
      "The GM must choose a hunting area before offering Hunting.",
    );
  const { region, seed } = loadHuntingBlock(block.id);
  const equipment = requireHuntingEquipment(actor, entry.targetId);
  let hunt = previous;
  if (!hunt) {
    if (entry.guidedAttack)
      throw new Error("Find game before rolling the ranged attack.");
    const percentile = (salt) =>
      1 +
      Math.floor(deterministicDowntimeRoll(seed, `${actor.id}:${salt}`) * 100);
    const result = findHuntingGame(
      region,
      entry.hours,
      entry.guidedRoll.total,
      percentile("game"),
      percentile("complication"),
    );
    hunt = {
      ...result,
      hours: entry.hours,
      targetId: entry.targetId,
      queueKey: huntingQueueKey(queue),
      game:
        result.gameIndex < 0
          ? null
          : {
              ...block.huntingProfile.game[result.gameIndex],
              food: huntingYield(
                region.game[result.gameIndex],
                deterministicDowntimeRoll(seed, `${actor.id}:meat`),
              ),
            },
      stage: result.gameIndex < 0 ? "done" : "attack",
      hit: false,
      survival: entry.guidedRoll,
      risk: region.risk,
    };
  }
  if (entry.guidedAttack) {
    const attack = entry.guidedAttack;
    if (
      !Number.isFinite(attack.total) ||
      attack.total < -100 ||
      attack.total > 1000 ||
      !Number.isInteger(attack.natural) ||
      attack.natural < 1 ||
      attack.natural > 20
    )
      throw new Error("Submit a valid ranged attack.");
    if (hunt.stage === "done") {
      if (JSON.stringify(hunt.attack) !== JSON.stringify(attack))
        throw new Error(
          "This hunt is already resolved. A second shot is not allowed.",
        );
      return hunt;
    }
    hunt = {
      ...hunt,
      stage: "done",
      attack,
      hit: huntingHit(
        attack.total,
        attack.natural,
        region.game[hunt.gameIndex].ac,
      ),
      weapon: {
        itemId: equipment.weapon.id,
        identity: guidedWorkItemIdentity(equipment.weapon),
      },
      ammunition: {
        itemId: equipment.ammo.id,
        name: equipment.ammo.name,
        identity: guidedWorkItemIdentity(equipment.ammo),
        before: equipment.ammo.system.quantity,
        after: equipment.ammo.system.quantity - 1,
      },
    };
  }
  return hunt;
}
export async function buildHuntingOperation({
  block,
  actor,
  operationId,
  createdAt,
  wallet,
  report,
  existingWork,
  foodQuantity,
  existingHuntingDelivery,
}) {
  const hunt = block.participants.find((p) => p.actorId === actor.id)?.hunt;
  if (!hunt || hunt.stage !== "done")
    throw new Error(
      "Finish the hunting check and ranged shot before GM review.",
    );
  const quantity =
    foodQuantity === undefined
      ? (existingWork?.outputQuantity ?? (hunt.hit ? hunt.game.food : 0))
      : Number(foodQuantity);
  if (
    foodQuantity === "" ||
    !Number.isSafeInteger(quantity) ||
    quantity < 0 ||
    quantity > 1000 ||
    (!hunt.hit && quantity !== 0)
  )
    throw new Error(
      "Enter 0–1000 meat portions for a successful hunt; failed hunts yield no meat.",
    );
  const reviewedHunt = hunt.hit
    ? { ...hunt, game: { ...hunt.game, food: quantity } }
    : hunt;
  const work = structuredClone(
    existingWork ?? (await huntingWork(actor, hunt, operationId)),
  );
  const huntingDelivery = existingHuntingDelivery ?? work.delivery;
  const summary = huntingSummary(reviewedHunt);
  work.outputQuantity = quantity;
  work.detail = summary;
  if (quantity > 0) {
    if (!huntingDelivery)
      throw new Error(
        "The saved meat delivery is missing. Reprepare this hunt before applying.",
      );
    work.delivery = structuredClone(huntingDelivery);
    work.delivery.quantity = quantity;
    work.delivery.snapshot.system.quantity = quantity;
  } else delete work.delivery;
  return {
    operationId,
    kind: "guided-work",
    mode: "guided",
    actorId: actor.id,
    settlementId: "guided-downtime",
    activityId: HUNTING_ID,
    activityLabel: "Hunting",
    activityImage: "icons/skills/ranged/arrow-flying-brown.webp",
    hours: hunt.hours,
    createdAt,
    targetId: hunt.targetId,
    hunting: true,
    ...(huntingDelivery ? { huntingDelivery } : {}),
    huntingGeneratedReport: summary,
    huntingAnimal: hunt.game?.name ?? "",
    huntingSuggestedFood: hunt.hit ? hunt.game.food : 0,
    work,
    walletBefore: wallet,
    walletAfter: wallet,
    currencyDeltaCp: 0,
    selectedOutcomeIndex: !hunt.game ? 0 : hunt.hit ? 2 : 1,
    outcomeLabel: !hunt.game
      ? "No game found"
      : hunt.hit
        ? "Game secured"
        : "Game escaped",
    report: report || summary,
    summary: report && report !== summary ? `${summary} ${report}` : summary,
    check: {
      skill: "sur",
      total: hunt.survival.total,
      formula: hunt.survival.formula,
      outcomeTier: hunt.hit ? "success" : "neutral",
    },
  };
}
async function huntingWork(actor, hunt, operationId) {
  let work = {
    config: { output: "none" },
    costCp: 0,
    tools: [],
    materials: [],
    outputQuantity: 0,
  };
  if (hunt.hit && hunt.game.food > 0) {
    const food = loadResourceConfig().resources.find(
      (r) => r.forageYields === "food" && r.scope === "per-character",
    );
    const itemUuid = food?.matching?.itemUuids?.[0];
    if (!itemUuid)
      throw new Error(
        "Configure a Food item UUID in Quartermaster before delivering hunting food.",
      );
    work = await buildGuidedWorkPlan({
      actor,
      operationId,
      hours: 1,
      progress: {},
      activity: {
        id: operationId,
        name: `${hunt.game.name} food`,
        work: {
          output: "item",
          itemUuid,
          batchHours: 1,
          batchGp: 0,
          quantity: hunt.game.food,
        },
      },
    });
    work.delivery.snapshot.name = `${hunt.game.name} meat — ${work.delivery.snapshot.name}`;
    work.delivery.snapshot.flags ??= {};
    work.delivery.snapshot.flags.core ??= {};
    work.delivery.snapshot.flags.core.sourceId = itemUuid;
    if (food.matching.flagTag) {
      work.delivery.snapshot.flags[MODULE_ID] ??= {};
      work.delivery.snapshot.flags[MODULE_ID].resourceTag =
        food.matching.flagTag;
    }
  }
  work.tools = hunt.weapon ? [hunt.weapon] : [];
  work.materials = hunt.ammunition ? [hunt.ammunition] : [];
  work.detail = huntingSummary(hunt);
  return work;
}
