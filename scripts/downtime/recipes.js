/** Explicit Drakmor house recipes. Source IDs are shipped, usable Item documents. */
export const DOWNTIME_RECIPES = Object.freeze(
  [
    [
      "healing-potion",
      "Potion of Healing",
      "ytlsBjYsZ7OBSEBs",
      "Herbalism Kit",
      8,
      25,
    ],
    ["antitoxin", "Antitoxin", "Fc6UfFNOnW80XMzi", "Herbalism Kit", 8, 25],
    [
      "alchemists-fire",
      "Alchemist's Fire",
      "FvNOwWbh5FXyX4xe",
      "Alchemist's Supplies",
      8,
      25,
    ],
    [
      "acid",
      "Acid (vial)",
      "Sx5E6utixHdAbGNb",
      "Alchemist's Supplies",
      8,
      12.5,
    ],
    [
      "healers-kit",
      "Healer's Kit",
      "6rocoBx5jdzG1QQH",
      "Herbalism Kit",
      8,
      2.5,
    ],
    ["backpack", "Backpack", "7CPuXZHmyhoHolIm", "Leatherworker's Tools", 8, 1],
    [
      "leather-armor",
      "Leather Armor",
      "WwdpHLXGX5r8uZu5",
      "Leatherworker's Tools",
      8,
      5,
    ],
    [
      "torches",
      "Torches (10)",
      "BnOCLuNWhVvzHLjl",
      "Woodcarver's Tools",
      8,
      0.05,
      10,
    ],
  ].map(([id, name, itemId, tool, hours, gp, quantity = 1]) =>
    Object.freeze({
      id: `recipe-${id}`,
      name: `Craft ${name}`,
      category: "crafting",
      description: `Drakmor house recipe: ${hours} productive hours and ${gp} gp per batch. Carry ${tool}; the GM confirms proficiency and a suitable workspace when offering this recipe. Ordinary materials are included in the price.`,
      image: "icons/skills/trades/smithing-anvil-silver-red.webp",
      blockHours: 8,
      skills: [],
      work: {
        output: "item",
        itemUuid: `Compendium.infinity-dnd5e.infinity-dnd5e-items.Item.${itemId}`,
        batchHours: hours,
        batchGp: gp,
        quantity,
        requiredTools: [tool],
      },
      outcomes: ["Work recorded", "Careful work", "Fine workmanship"].map(
        (label) => ({
          label,
          report:
            "Your crafting progress and finished goods are recorded below.",
          rewardGp: 0,
        }),
      ),
    }),
  ),
);

/** Currency rewards scale from the saved policy, never the current library. */
export function guidedRewardCp(activity, outcome, hours) {
  const multiplier = activity.rewardBasis === "workday" ? hours / 8 : 1;
  return Math.round(Number(outcome.rewardGp || 0) * 100 * multiplier);
}
