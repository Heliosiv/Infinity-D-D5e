/** Small, explicit campaign rewards; no arbitrary effect paths or macros. */
import { DOWNTIME_EFFECT_BENEFITS } from "./benefit-effects.js";

export const DOWNTIME_BENEFITS = Object.freeze([
  Object.freeze({ id: "", label: "No extra benefit" }),
  ...DOWNTIME_EFFECT_BENEFITS.map(({ id, label }) =>
    Object.freeze({ id, label }),
  ),
  Object.freeze({
    id: "injury-care",
    label: "Reduce one injury by 1 day (8 hours of care)",
  }),
]);

export function normalizeDowntimeBenefit(value) {
  const id = String(value ?? "");
  if (!DOWNTIME_BENEFITS.some((entry) => entry.id === id))
    throw new Error("Choose a supported downtime benefit.");
  return id;
}

export function downtimeBenefitLabel(value) {
  return DOWNTIME_BENEFITS.find((entry) => entry.id === value)?.label ?? "";
}
