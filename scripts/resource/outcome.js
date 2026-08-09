/** Shared, fail-closed outcome semantics for upkeep reports. */

export const RESOURCE_OUTCOMES = Object.freeze({
  SUPPLIED: "supplied",
  SHORT: "short",
  NEEDS_REVIEW: "needs-review",
});

/**
 * Inventory uncertainty outranks a known shortage. A row is only supplied when
 * it has neither, so every Quartermaster surface tells the same story.
 */
export function classifyResourceOutcome({
  hasErrors = false,
  hasShortages = false,
} = {}) {
  if (hasErrors) return RESOURCE_OUTCOMES.NEEDS_REVIEW;
  if (hasShortages) return RESOURCE_OUTCOMES.SHORT;
  return RESOURCE_OUTCOMES.SUPPLIED;
}

export function resourceOutcomeLabel(outcome) {
  if (outcome === RESOURCE_OUTCOMES.NEEDS_REVIEW) return "Needs review";
  if (outcome === RESOURCE_OUTCOMES.SHORT) return "Shortages";
  return "Complete";
}
