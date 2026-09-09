/** Drakmor field ammunition v1. Public recipe facts; resolution runs on the GM. */
export const FIELD_AMMUNITION_ID = "guided-field-ammunition";
export const FIELD_OUTPUT = "field-ammunition";
export const FIELD_RECIPES = Object.freeze([
  {
    id: "arrows",
    name: "Arrows",
    hours: 2,
    quantity: 5,
    costCp: 15,
    tools: ["Fletcher's Tools", "Woodcarver's Tools"],
    difficulty: "Moderate",
    supplies: "Arrow Materials",
    gather:
      "straight shafts and fletching; prepared heads and binding remain part of the cost",
  },
  {
    id: "bolts",
    name: "Crossbow Bolts",
    hours: 2,
    quantity: 5,
    costCp: 10,
    tools: ["Fletcher's Tools", "Woodcarver's Tools"],
    difficulty: "Moderate",
    supplies: "Bolt Materials",
    gather:
      "short straight shafts; prepared heads and binding remain part of the cost",
  },
  {
    id: "needles",
    name: "Blowgun Needles",
    hours: 1,
    quantity: 5,
    costCp: 5,
    tools: ["Woodcarver's Tools", "Tinker's Tools"],
    difficulty: "Hard",
    supplies: "Needle Materials",
    gather: "thorns or bone blanks; finishing supplies remain part of the cost",
  },
  {
    id: "sling-bullets",
    name: "Sling Bullets",
    hours: 1,
    quantity: 5,
    costCp: 1,
    tools: ["Mason's Tools", "Tinker's Tools"],
    difficulty: "Easy",
    supplies: "Sling Bullet Materials",
    gather: "suitable stones; dressing supplies remain part of the cost",
  },
]);
export const FIELD_METHODS = Object.freeze([
  { id: "gp", name: "Pay abstract materials" },
  { id: "materials", name: "Use carried material bundles" },
  { id: "mixed", name: "Use bundles, pay the remainder" },
  { id: "gather", name: "Gather for 1 hour, pay the remainder" },
]);
export function fieldChoice(targetId) {
  const [recipeId, method, extra] = String(targetId ?? "").split(":");
  const recipe = FIELD_RECIPES.find((row) => row.id === recipeId);
  if (
    !recipe ||
    extra !== undefined ||
    !FIELD_METHODS.some((row) => row.id === method)
  )
    throw new Error("Choose a field ammunition recipe and material method.");
  return { recipe, method, gatheringHours: method === "gather" ? 1 : 0 };
}
export function fieldGatheringAllowed(locationPresetId) {
  return ["wilderness", "adventuring"].includes(locationPresetId);
}
export function fieldRiskPercent(hourlyPercent, exposureHours) {
  return 100 * (1 - (1 - hourlyPercent / 100) ** exposureHours);
}
export function fieldResolution(total, difficulty) {
  const dc = {
    "Very Easy": 8,
    Easy: 10,
    Moderate: 13,
    Hard: 16,
    "Very Hard": 19,
    Extreme: 22,
  }[difficulty];
  if (dc === undefined || !Number.isFinite(total))
    throw new Error("The crafting check is missing.");
  const margin = total - dc;
  return {
    dc,
    total,
    margin,
    factor: margin >= 0 ? 1 : margin > -5 ? 0.5 : 0,
    label:
      margin >= 0
        ? "Work completed"
        : margin > -5
          ? "Reduced progress"
          : "Materials lost",
  };
}
export function fieldGatheringResult(total) {
  const result = fieldResolution(total, "Easy");
  return {
    ...result,
    discount:
      result.margin >= 5
        ? 0.75
        : result.margin >= 0
          ? 0.5
          : result.margin > -5
            ? 0.25
            : 0,
  };
}
export function fieldTemplate() {
  return {
    id: FIELD_AMMUNITION_ID,
    name: "Craft Field Ammunition",
    blockHours: 1,
    description:
      "Make ammunition at camp using Drakmor house rules. Choose a recipe, materials and hours. A near miss gives half progress; failure by 5+ loses the attempt's time and materials. The GM confirms tool proficiency and a suitable working area.",
    image: "icons/weapons/ammunition/arrows-war-white.webp",
    skills: ["slt", "sur"],
    work: { output: FIELD_OUTPUT, fieldRiskPercent: 5 },
    outcomes: [
      {
        label: "Materials lost",
        report:
          "The attempt failed. Its materials and time were lost; earlier finished work is kept.",
        rewardGp: 0,
      },
      {
        label: "Reduced progress",
        report:
          "The work proved difficult. Half the crafting time became progress; unused materials remain committed to this recipe.",
        rewardGp: 0,
      },
      {
        label: "Work completed",
        report:
          "Your crafting time became useful progress. Finished ammunition and ongoing work are recorded below.",
        rewardGp: 0,
      },
    ],
  };
}
