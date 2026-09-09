import { defaultHuntingRegions } from "./hunting.js";
/** Shared location rules for setup and authoritative block creation. */
export const DOWNTIME_LOCATION_PRESETS = Object.freeze([
  {
    id: "adventuring",
    label: "Adventuring / on the road",
    activityIds: [
      "guided-reflection",
      "guided-scouting",
      "guided-animal-care",
      "guided-trail-conditioning",
    ],
  },
  {
    id: "wilderness",
    label: "Wilderness camp / forest",
    activityIds: [
      "guided-reflection",
      "guided-scouting",
      "guided-animal-care",
      "guided-trail-conditioning",
      "guided-training",
      "guided-train-spar",
      "guided-care",
      "guided-tend-sick",
      "guided-craft-arrows",
      "guided-scribe-scroll",
      "guided-focused-study",
      "guided-defensive-drills",
    ],
  },
  {
    id: "village",
    label: "Village / small settlement",
    activityIds: [
      "guided-labor",
      "guided-performance",
      "guided-training",
      "guided-train-spar",
      "guided-contacts",
      "guided-scouting",
      "guided-care",
      "guided-tend-sick",
      "guided-service",
      "guided-animal-care",
      "guided-reflection",
      "guided-craft-arrows",
      "guided-trail-conditioning",
      "guided-defensive-drills",
    ],
  },
  { id: "town", label: "Town / city", activityIds: null },
  { id: "custom", label: "Custom - choose activities", activityIds: null },
]);

export function downtimeLocationActivityIds(
  library,
  presetId = "custom",
  settlement = null,
  regions = defaultHuntingRegions(),
) {
  const region = regions.find((entry) => entry.id === presetId);
  const preset = region
    ? { activityIds: region.activityIds }
    : DOWNTIME_LOCATION_PRESETS.find((entry) => entry.id === presetId);
  if (!preset) throw new Error("Choose a valid location preset.");
  const allowed = settlement?.guidedTemplateIds ?? preset.activityIds;
  return library
    .filter((entry) => !allowed || allowed.includes(entry.id))
    .map((entry) => entry.id);
}
