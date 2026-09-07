/** Canonical material names from the shipped Item pack, plus custom campaign items. */
export const CUSTOM_MATERIAL_VALUE = "__custom__";
export const CRAFTING_MATERIAL_OPTIONS = Object.freeze([
  "Copper",
  "Gold",
  "Ink Bottle",
  "Iron",
  "Paper",
  "Parchment",
  "Powdered Silver",
  "Sealing Wax",
  "Silver",
]);

export function materialPickerOptions(name = "") {
  const custom = Boolean(name && !CRAFTING_MATERIAL_OPTIONS.includes(name));
  return [
    { name: "", label: "No material required", selected: !name },
    ...CRAFTING_MATERIAL_OPTIONS.map((value) => ({
      name: value,
      label: value,
      selected: name === value,
    })),
    {
      name: CUSTOM_MATERIAL_VALUE,
      label: "Custom inventory item…",
      selected: custom,
    },
  ];
}
