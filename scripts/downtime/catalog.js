/**
 * Infinity D&D5e — Downtime activity catalog.
 *
 * This module contains only immutable rule metadata. It deliberately has no
 * Foundry dependencies so both the authoritative workflow and the UI can use
 * one definition of legal activity durations and repeat limits.
 */

export const DOWNTIME_ACTIVITY_IDS = Object.freeze({
  CRAFT_AMMUNITION: "craft-ammunition",
  SHARPEN_WEAPON: "sharpen-weapon",
  MARKET_TRADING: "market-trading",
  PICKPOCKET: "pickpocket",
  SHOPLIFT: "shoplift",
  FENCE_STOLEN_GOODS: "fence-stolen-goods",
  LAY_LOW: "lay-low",
});

const ACTIVITY_DEFINITIONS = [
  {
    id: DOWNTIME_ACTIVITY_IDS.CRAFT_AMMUNITION,
    label: "Craft Ammunition",
    category: "craft",
    allowedHours: [4],
    repeatable: true,
    requiresTarget: true,
    targetType: "ammunition-kind",
  },
  {
    id: DOWNTIME_ACTIVITY_IDS.SHARPEN_WEAPON,
    label: "Sharpen Weapon",
    category: "maintenance",
    allowedHours: [1],
    repeatable: true,
    requiresTarget: true,
    targetType: "weapon",
  },
  {
    id: DOWNTIME_ACTIVITY_IDS.MARKET_TRADING,
    label: "Market Trading",
    category: "commerce",
    allowedHours: [2, 4, 6, 8],
    repeatable: false,
    maxPerBlock: 1,
    requiresSkill: true,
    allowedSkills: ["persuasion", "deception"],
    requiresStake: true,
    requiresSettlement: true,
  },
  {
    id: DOWNTIME_ACTIVITY_IDS.PICKPOCKET,
    label: "Pickpocket",
    category: "crime",
    allowedHours: [2, 4],
    repeatable: true,
    isCrime: true,
    requiresTarget: true,
    targetType: "generated-mark",
    forcedSkill: "sleight-of-hand",
    requiresSettlement: true,
  },
  {
    id: DOWNTIME_ACTIVITY_IDS.SHOPLIFT,
    label: "Shoplift",
    category: "crime",
    allowedHours: [4, 8],
    repeatable: true,
    isCrime: true,
    requiresTarget: true,
    targetType: "merchant-stock",
    forcedSkill: "sleight-of-hand",
    requiresSettlement: true,
  },
  {
    id: DOWNTIME_ACTIVITY_IDS.FENCE_STOLEN_GOODS,
    label: "Fence Stolen Goods",
    category: "crime",
    allowedHours: [2, 4, 6, 8],
    repeatable: false,
    maxPerBlock: 1,
    isCrime: true,
    requiresTarget: true,
    targetType: "stolen-bundle",
    requiresSkill: true,
    allowedSkills: ["persuasion", "deception"],
    requiresSettlement: true,
  },
  {
    id: DOWNTIME_ACTIVITY_IDS.LAY_LOW,
    label: "Lay Low",
    category: "recovery",
    allowedHours: [4],
    repeatable: true,
    maxPerBlock: 2,
    requiresSettlement: true,
  },
];

export const DOWNTIME_ACTIVITY_CATALOG = Object.freeze(
  ACTIVITY_DEFINITIONS.map((definition) =>
    Object.freeze({
      ...definition,
      allowedHours: Object.freeze([...definition.allowedHours]),
      allowedSkills: definition.allowedSkills
        ? Object.freeze([...definition.allowedSkills])
        : undefined,
    }),
  ),
);

const ACTIVITY_BY_ID = new Map(
  DOWNTIME_ACTIVITY_CATALOG.map((activity) => [activity.id, activity]),
);

export const DOWNTIME_ACTIVITY_ID_LIST = Object.freeze(
  DOWNTIME_ACTIVITY_CATALOG.map((activity) => activity.id),
);

/** Return an immutable activity definition, or null for an unknown id. */
export function getDowntimeActivity(activityId) {
  return ACTIVITY_BY_ID.get(normalizeDowntimeActivityId(activityId)) ?? null;
}

/** Normalize an activity id without accepting display labels as authority. */
export function normalizeDowntimeActivityId(activityId) {
  return String(activityId ?? "")
    .trim()
    .toLowerCase();
}

/** Whether `hours` is one of the exact durations permitted by the catalog. */
export function isAllowedActivityDuration(activityId, hours) {
  const activity = getDowntimeActivity(activityId);
  const numeric = Number(hours);
  return Boolean(
    activity &&
    Number.isSafeInteger(numeric) &&
    activity.allowedHours.includes(numeric),
  );
}

/** List catalog entries enabled by a normalized settlement profile. */
export function listEnabledDowntimeActivities(enabledActivityIds = null) {
  if (!Array.isArray(enabledActivityIds)) {
    return [...DOWNTIME_ACTIVITY_CATALOG];
  }
  const enabled = new Set(
    enabledActivityIds.map((id) => normalizeDowntimeActivityId(id)),
  );
  return DOWNTIME_ACTIVITY_CATALOG.filter((activity) =>
    enabled.has(activity.id),
  );
}

/**
 * Canonicalize the owned Item ids that make up one fencing bundle. The list
 * is intentionally bounded because it travels through the authenticated
 * player request envelope.
 */
export function normalizeFenceBundleItemIds(values, maximum = 64) {
  if (!Array.isArray(values)) return [];
  const limit = Math.max(1, Math.min(64, Math.floor(Number(maximum) || 64)));
  return [
    ...new Set(
      values
        .slice(0, limit)
        .map((value) => String(value ?? "").trim())
        .filter(
          (value) => value.length <= 160 && /^[A-Za-z0-9_.:-]+$/.test(value),
        )
        .filter(Boolean),
    ),
  ].sort();
}

/** Stable opaque target id for an arbitrary selected bundle of owned goods. */
export function buildFenceBundleTargetId(itemIds) {
  const ids = normalizeFenceBundleItemIds(itemIds);
  if (ids.length === 0) return "";
  return `fence-${stableHashHex(ids.join("|"))}`;
}

function stableHashHex(value) {
  return `${stableHashChunk(value, 0x811c9dc5)}${stableHashChunk(
    value,
    0x9e3779b9,
  )}`;
}

function stableHashChunk(value, seed) {
  let hash = seed >>> 0;
  for (const character of String(value ?? "")) {
    hash ^= character.codePointAt(0);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}
