import { AMMUNITION_RECIPES, planWalletDeltaCp } from "./items.js";
import { merchantItemId } from "../merchant/write-verification.js";
import { readWalletStrict } from "../merchant/currency.js";
import { identity, matchMaterial } from "./work.js";
import {
  FIELD_RECIPES,
  FIELD_METHODS,
  fieldChoice,
  fieldGatheringAllowed,
  fieldGatheringResult,
  fieldResolution,
  fieldRiskPercent,
} from "./field-ammunition.js";

const money = (cp) => `${Number((cp / 100).toFixed(2))} gp`;
const quantity = (item) => Number(item.system?.quantity ?? 0);

/** Builds the same typed inventory plan as existing crafting. Materials are funded
 * separately from progress so a near miss cannot charge for retained inputs twice. */
export function quoteFieldAmmunition({
  actor,
  activity,
  hours,
  targetId,
  progress = {},
  locationPresetId = "custom",
  checkTotal,
  gatheringTotal,
  complicationRoll,
}) {
  const { recipe, method, gatheringHours } = fieldChoice(targetId);
  if (!Number.isInteger(hours) || hours <= gatheringHours || hours > 240)
    throw new Error(
      "Allocate at least one crafting hour, plus one hour when gathering.",
    );
  const problems = [];
  if (gatheringHours && !fieldGatheringAllowed(locationPresetId))
    problems.push(
      "Gathering for this recipe requires an adventuring or wilderness location.",
    );
  const craftHours = hours - gatheringHours;
  const key = merchantItemId(`drakmor-field-v1:${actor.id}:${recipe.id}`);
  const materialKey = merchantItemId(
    `drakmor-field-material-v1:${actor.id}:${recipe.id}`,
  );
  const roundingKey = merchantItemId(
    `drakmor-field-rounding-v1:${actor.id}:${recipe.id}`,
  );
  const before = Number(progress[key] ?? 0);
  const fundedBefore = Number(progress[materialKey] ?? 0);
  const roundingBefore = Number(progress[roundingKey] ?? 0);
  if (
    ![before, fundedBefore].every(
      (v) => Number.isSafeInteger(v * 2) && v >= 0,
    ) ||
    !Number.isSafeInteger(roundingBefore) ||
    roundingBefore < 0 ||
    roundingBefore > 15
  )
    throw new Error("Saved field crafting progress could not be verified.");
  const resolved = checkTotal !== undefined;
  const result = resolved
    ? fieldResolution(checkTotal, recipe.difficulty)
    : null;
  const gathering =
    gatheringHours && resolved ? fieldGatheringResult(gatheringTotal) : null;
  const contributedHours = craftHours * (result?.factor ?? 1);
  const after = before + contributedHours;
  const missingHours = Math.max(0, craftHours - fundedBefore);
  const tools = recipe.tools
    .flatMap((name) => matchMaterial(actor, name))
    .slice(0, 1);
  if (!tools.length)
    problems.push(
      `Carry ${recipe.tools.join(" or ")} (kept). The GM confirms proficiency.`,
    );
  const supplies = matchMaterial(actor, recipe.supplies);
  const availableBundles = supplies.reduce(
    (sum, item) => sum + quantity(item),
    0,
  );
  const useBundles = ["materials", "mixed"].includes(method);
  const neededBundles = Math.ceil(missingHours / recipe.hours);
  const bundleCount = useBundles
    ? Math.min(neededBundles, availableBundles)
    : 0;
  if (method === "materials" && bundleCount < neededBundles)
    problems.push(
      `Carry ${neededBundles} × ${recipe.supplies}; each bundle funds ${recipe.hours}h of work.`,
    );
  const boughtHours =
    method === "materials"
      ? 0
      : Math.max(0, missingHours - bundleCount * recipe.hours);
  // Sixteenth-copper units are exact for half-hour progress and quarter discounts.
  // Keep rounding credit so splitting identical work does not add copper charges.
  const rawSixteenthCp = Math.round(
    ((boughtHours * recipe.costCp) / recipe.hours) *
      (1 - (gathering?.discount ?? 0)) *
      16,
  );
  const costCp = Math.max(0, Math.ceil((rawSixteenthCp - roundingBefore) / 16));
  const roundingAfter = roundingBefore + costCp * 16 - rawSixteenthCp;
  const fundedTotal = fundedBefore + bundleCount * recipe.hours + boughtHours;
  const fundedAfter =
    fundedTotal - (result?.factor === 0 ? craftHours : contributedHours);
  const materials = [];
  let remaining = bundleCount;
  for (const item of supplies) {
    const take = Math.min(remaining, quantity(item));
    if (take > 0)
      materials.push({
        itemId: item.id,
        name: item.name,
        before: quantity(item),
        after: quantity(item) - take,
        identity: identity(item),
      });
    remaining -= take;
  }
  const wallet = readWalletStrict(actor.system?.currency);
  if (!wallet.ok || !planWalletDeltaCp(wallet.wallet, -costCp))
    problems.push(`You need ${money(costCp)} available for this attempt.`);
  const batches =
    Math.floor(after / recipe.hours) - Math.floor(before / recipe.hours);
  const risk = fieldRiskPercent(activity.work.fieldRiskPercent, gatheringHours);
  const complication =
    resolved && gatheringHours
      ? {
          chance: risk,
          roll: complicationRoll,
          triggered:
            Number.isInteger(complicationRoll) &&
            complicationRoll <= Math.round(risk * 100),
        }
      : null;
  if (
    complication &&
    (!Number.isInteger(complication.roll) ||
      complication.roll < 1 ||
      complication.roll > 10000)
  )
    throw new Error("The saved complication roll is missing.");
  if (complication?.triggered) {
    const prompts = [
      "Fresh tracks cross your search area. The GM describes a nearby creature or a lead worth following.",
      "An unexpected traveller notices you. The GM introduces the visitor and their intentions.",
      "Unstable ground interrupts the search. The GM describes the hazard and decides whether it changes the remaining schedule.",
      "A hungry creature follows your movements toward camp. The GM decides its approach and whether an encounter begins.",
    ];
    complication.prompt =
      prompts[
        Math.min(
          3,
          Math.floor(
            ((complication.roll - 1) / Math.max(1, Math.round(risk * 100))) *
              prompts.length,
          ),
        )
      ];
  }
  const detail = [
    `${recipe.name}: ${hours}h allocated (${gatheringHours}h gathering, ${craftHours}h crafting).`,
    `Spend ${money(costCp)}${resolved ? "" : " maximum"}; ${bundleCount} × ${recipe.supplies}.`,
    `Crafting: ${recipe.difficulty}; gathering: Easy.`,
    `Complication chance: ${Number(risk.toFixed(2))}% total (${activity.work.fieldRiskPercent}% per hour outside camp).`,
    resolved
      ? `${result.label}: ${contributedHours}h progress. Receive ${batches * recipe.quantity} × ${recipe.name}; ${after % recipe.hours}/${recipe.hours}h toward the next batch. ${fundedAfter}h of unused funded materials retained.`
      : `On success: ${batches * recipe.quantity} finished; ${after % recipe.hours}/${recipe.hours}h toward next batch. Near miss: ${craftHours / 2}h progress. Failure by 5+: no progress and the attempt's materials lost.`,
    gathering
      ? `Gathering reduced new abstract material cost by ${gathering.discount * 100}%.`
      : gatheringHours
        ? "Gathering may reduce new abstract material cost by 0%, 25%, 50% or 75%; prepared components are never completely waived."
        : "",
    complication?.triggered
      ? `Complication: ${complication.prompt}`
      : complication
        ? "No complication occurred."
        : "",
  ]
    .filter(Boolean)
    .join(" ");
  return {
    key,
    contributedHours,
    progressBeforeHours: before,
    progressAfterHours: after,
    requiredHours: recipe.hours,
    batches,
    outputQuantity: batches * recipe.quantity,
    outputName: recipe.name,
    remainingHours: after % recipe.hours,
    costCp,
    materials,
    tools: tools.map((item) => ({ itemId: item.id, identity: identity(item) })),
    source: null,
    config: {
      output: "item",
      itemUuid: AMMUNITION_RECIPES[recipe.id].uuid,
      materials: [],
      batchHours: recipe.hours,
      quantity: recipe.quantity,
    },
    field: {
      version: 1,
      recipeId: recipe.id,
      method,
      allocatedHours: hours,
      craftHours,
      gatheringHours,
      materialKey,
      fundedBefore,
      fundedAfter,
      roundingKey,
      roundingBefore,
      roundingAfter,
      result,
      gathering,
      complication,
    },
    detail,
    ok: !problems.length,
    problems,
  };
}

/** Exact quote table contains only player-facing text. It updates immediately
 * when the player changes hours or recipe, without trusting client-side prices. */
export function projectFieldAmmunition(
  actor,
  activity,
  budgetHours,
  progress,
  locationPresetId,
) {
  const targets = [];
  for (const recipe of FIELD_RECIPES)
    for (const method of FIELD_METHODS) {
      if (
        method.id === "gather" &&
        (!fieldGatheringAllowed(locationPresetId) || budgetHours < 2)
      )
        continue;
      const id = `${recipe.id}:${method.id}`;
      const quotes = [];
      for (
        let hours = method.id === "gather" ? 2 : 1;
        hours <= budgetHours;
        hours++
      ) {
        const quote = quoteFieldAmmunition({
          actor,
          activity,
          hours,
          targetId: id,
          progress,
          locationPresetId,
        });
        quotes.push({
          hours,
          detail: `${quote.detail} ${quote.problems.join(" ")}`.trim(),
          available: quote.ok,
        });
      }
      targets.push({
        id,
        label: `${recipe.name} — ${method.name}`,
        detail: `${recipe.quantity} per ${recipe.hours}h; ${money(recipe.costCp)} per batch. Gather ${recipe.gather}.`,
        quotes,
        disabled: !quotes.some((q) => q.available),
      });
    }
  return {
    available: targets.some((t) => !t.disabled),
    targets,
    targetLabel: "Recipe and materials",
    targetField: "targetId",
    fieldAmmunition: true,
    unavailableReason:
      "No field ammunition recipe meets your carried tools and material requirements.",
    costLabel:
      "Select a recipe and hours for its exact maximum cost, expected output and complication percentage.",
    limitLabel:
      "Drakmor rules v1. Sleight of Hand or Survival; carry the recipe's tools. One crafting check per allocation, plus Survival when gathering. GM confirms proficiency and workspace.",
  };
}
