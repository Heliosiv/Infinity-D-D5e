/** Pure presentation mapping from Critical Injury V2 data to body regions. */

const freezeRegion = (region) => Object.freeze(region);

export const CRITICAL_INJURY_BODY_REGIONS = Object.freeze([
  freezeRegion({ key: "head", label: "Head", kind: "head", side: null }),
  freezeRegion({ key: "torso", label: "Torso", kind: "torso", side: null }),
  freezeRegion({
    key: "left-arm",
    label: "Left arm",
    kind: "arm",
    side: "left",
  }),
  freezeRegion({
    key: "right-arm",
    label: "Right arm",
    kind: "arm",
    side: "right",
  }),
  freezeRegion({
    key: "left-leg",
    label: "Left leg",
    kind: "leg",
    side: "left",
  }),
  freezeRegion({
    key: "right-leg",
    label: "Right leg",
    kind: "leg",
    side: "right",
  }),
  freezeRegion({
    key: "whole-body",
    label: "Whole body",
    kind: "whole-body",
    side: null,
  }),
  freezeRegion({ key: "mind", label: "Mind", kind: "mind", side: null }),
]);

export const CRITICAL_INJURY_BODY_REGION_KEYS = Object.freeze(
  CRITICAL_INJURY_BODY_REGIONS.map((region) => region.key),
);

const BODY_PART_REGIONS = Object.freeze({
  "left-arm": Object.freeze(["left-arm"]),
  "right-arm": Object.freeze(["right-arm"]),
  "left-leg": Object.freeze(["left-leg"]),
  "right-leg": Object.freeze(["right-leg"]),
});

const BOTH_ARMS = Object.freeze(["left-arm", "right-arm"]);
const BOTH_LEGS = Object.freeze(["left-leg", "right-leg"]);
const ALL_LIMBS = Object.freeze([
  "left-arm",
  "right-arm",
  "left-leg",
  "right-leg",
]);

const INJURY_DEFAULTS = Object.freeze({
  concussion: Object.freeze({
    regionKeys: Object.freeze(["head"]),
    locationLabel: "Head",
    specificity: "exact",
  }),
  "broken-arm": Object.freeze({
    regionKeys: BOTH_ARMS,
    locationLabel: "Arm (side unspecified)",
    specificity: "unspecified-side",
  }),
  "fractured-ribs": Object.freeze({
    regionKeys: Object.freeze(["torso"]),
    locationLabel: "Torso",
    specificity: "exact",
  }),
  "internal-bleeding": Object.freeze({
    regionKeys: Object.freeze(["torso"]),
    locationLabel: "Torso",
    specificity: "exact",
  }),
  "deep-cut": Object.freeze({
    regionKeys: Object.freeze(["whole-body"]),
    locationLabel: "Location unspecified",
    specificity: "general",
  }),
  "loss-of-eye": Object.freeze({
    regionKeys: Object.freeze(["head"]),
    locationLabel: "Head",
    specificity: "exact",
  }),
  "loss-of-hearing": Object.freeze({
    regionKeys: Object.freeze(["head"]),
    locationLabel: "Head",
    specificity: "exact",
  }),
  "shattered-knee": Object.freeze({
    regionKeys: BOTH_LEGS,
    locationLabel: "Leg (side unspecified)",
    specificity: "unspecified-side",
  }),
  "dislocated-shoulder": Object.freeze({
    regionKeys: BOTH_ARMS,
    locationLabel: "Arm (side unspecified)",
    specificity: "unspecified-side",
  }),
  infection: Object.freeze({
    regionKeys: Object.freeze(["whole-body"]),
    locationLabel: "Whole body",
    specificity: "general",
  }),
  "minor-injury": Object.freeze({
    regionKeys: Object.freeze(["whole-body"]),
    locationLabel: "Location unspecified",
    specificity: "general",
  }),
  "deep-scar": Object.freeze({
    regionKeys: Object.freeze(["whole-body"]),
    locationLabel: "Location unspecified",
    specificity: "general",
  }),
  "psychic-trauma": Object.freeze({
    regionKeys: Object.freeze(["mind"]),
    locationLabel: "Mind",
    specificity: "general",
  }),
  nightmares: Object.freeze({
    regionKeys: Object.freeze(["mind"]),
    locationLabel: "Mind",
    specificity: "general",
  }),
  "soul-shaken": Object.freeze({
    regionKeys: Object.freeze(["mind"]),
    locationLabel: "Mind",
    specificity: "general",
  }),
});

const PHYSICAL_ABILITIES = new Set(["str", "dex", "con"]);
const MENTAL_ABILITIES = new Set(["int", "wis", "cha"]);
const LIMB_INJURIES = new Set([
  "lost-limb",
  "crippling-injury",
  "broken-arm",
  "shattered-knee",
  "dislocated-shoulder",
]);

/**
 * Resolve an injury record or table definition to one or more presentation
 * regions. Multiple regions mean the rules identify a limb type but not a
 * side; they do not mean that every highlighted limb is injured.
 */
export function resolveCriticalInjuryBodyLocation(injury = {}) {
  const record =
    injury && typeof injury === "object"
      ? injury
      : { injuryKey: String(injury ?? "") };
  const injuryKey = String(record.injuryKey ?? record.key ?? "")
    .trim()
    .toLowerCase();
  const detail =
    record.detail && typeof record.detail === "object" ? record.detail : null;

  if (LIMB_INJURIES.has(injuryKey)) {
    const detailLocation = resolveLimbDetail(injuryKey, detail);
    if (detailLocation) return detailLocation;
  }

  if (injuryKey === "lost-limb" || injuryKey === "crippling-injury") {
    return location(ALL_LIMBS, "Limb (location unavailable)", "fallback", {
      source: "missing-detail",
    });
  }

  if (injuryKey === "nerve-damage") {
    const ability = String(detail?.key ?? "")
      .trim()
      .toLowerCase();
    if (MENTAL_ABILITIES.has(ability)) {
      return location(["mind"], "Mind", "general", {
        source: "ability-detail",
      });
    }
    if (PHYSICAL_ABILITIES.has(ability)) {
      return location(["whole-body"], "Whole body", "general", {
        source: "ability-detail",
      });
    }
    return location(["whole-body"], "Whole body", "fallback", {
      source: "missing-detail",
    });
  }

  const configured = INJURY_DEFAULTS[injuryKey];
  if (configured) {
    return location(
      configured.regionKeys,
      configured.locationLabel,
      configured.specificity,
      { source: "injury-default" },
    );
  }

  return location(["whole-body"], "Whole body", "fallback", {
    source: "fallback",
  });
}

/**
 * Group injury records under every region where the presentation may expose
 * them. All region keys are present and input order is preserved. Repeated
 * records with the same injury id appear only once in each region.
 */
export function indexCriticalInjuriesByBodyRegion(injuries = []) {
  const index = Object.fromEntries(
    CRITICAL_INJURY_BODY_REGION_KEYS.map((key) => [key, []]),
  );
  const seenByRegion = new Map(
    CRITICAL_INJURY_BODY_REGION_KEYS.map((key) => [key, new Set()]),
  );
  const records = Array.isArray(injuries) ? injuries : [];

  for (const injury of records) {
    if (!injury || typeof injury !== "object") continue;
    const identity = String(injury.id ?? "").trim() || injury;
    const bodyLocation = resolveCriticalInjuryBodyLocation(injury);
    for (const regionKey of bodyLocation.regionKeys) {
      const seen = seenByRegion.get(regionKey);
      if (!seen || seen.has(identity)) continue;
      seen.add(identity);
      index[regionKey].push(injury);
    }
  }

  return index;
}

function resolveLimbDetail(injuryKey, detail) {
  if (!detail) return null;
  const detailKey = String(detail.key ?? "")
    .trim()
    .toLowerCase();
  const detailKind = String(detail.kind ?? "")
    .trim()
    .toLowerCase();
  const exactRegions = BODY_PART_REGIONS[detailKey];

  if (exactRegions) {
    const isArm = detailKey.endsWith("-arm");
    const isLeg = detailKey.endsWith("-leg");
    if (
      (injuryKey === "broken-arm" || injuryKey === "dislocated-shoulder") &&
      !isArm
    ) {
      return null;
    }
    if (injuryKey === "shattered-knee" && !isLeg) return null;
    return location(exactRegions, bodyPartLabel(detailKey), "exact", {
      source: "detail",
    });
  }

  if (detailKey === "injured-arm" || detailKind === "arm") {
    if (injuryKey === "shattered-knee") return null;
    return location(BOTH_ARMS, "Arm (side unspecified)", "unspecified-side", {
      source: "detail",
    });
  }
  if (detailKey === "injured-leg" || detailKind === "leg") {
    if (injuryKey === "broken-arm" || injuryKey === "dislocated-shoulder") {
      return null;
    }
    return location(BOTH_LEGS, "Leg (side unspecified)", "unspecified-side", {
      source: "detail",
    });
  }
  return null;
}

function location(regionKeys, locationLabel, specificity, { source }) {
  return Object.freeze({
    regionKeys: Object.freeze([...new Set(regionKeys)]),
    locationLabel,
    specificity,
    source,
  });
}

function bodyPartLabel(key) {
  const [side = "", kind = ""] = String(key).split("-");
  return `${side.charAt(0).toUpperCase()}${side.slice(1)} ${kind}`.trim();
}
