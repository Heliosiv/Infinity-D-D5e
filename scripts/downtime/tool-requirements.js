/** Selectable inventory prerequisites. These are kept, never spent by crafting. */
export const FLETCHERS_TOOLS_NAME = "Fletcher's Tools";
export const FLETCHERS_TOOLS_ID = "InfFletcherTools";

export const CRAFTING_TOOL_OPTIONS = Object.freeze([
  "Alchemist's Supplies",
  "Brewer's Supplies",
  "Calligrapher's Supplies",
  "Carpenter's Tools",
  "Cartographer's Tools",
  "Cobbler's Tools",
  "Cook's Utensils",
  "Disguise Kit",
  FLETCHERS_TOOLS_NAME,
  "Forgery Kit",
  "Glassblower's Tools",
  "Herbalism Kit",
  "Jeweler's Tools",
  "Leatherworker's Tools",
  "Mason's Tools",
  "Navigator's Tools",
  "Painter's Supplies",
  "Poisoner's Kit",
  "Potter's Tools",
  "Smith's Tools",
  "Thieves' Tools",
  "Tinker's Tools",
  "Weaver's Tools",
  "Woodcarver's Tools",
]);

export function normalizeRequiredTools(value) {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > 8)
    throw new Error("Choose up to eight required tools.");
  if (value.some((name) => !CRAFTING_TOOL_OPTIONS.includes(name)))
    throw new Error(
      "Choose required tools from the tool list; use the custom field for another item.",
    );
  return [...new Set(value)].sort();
}

export function requiredToolNames(config) {
  return [
    ...(config.requiredTools ?? []),
    ...(config.tool ? [config.tool] : []),
  ];
}
