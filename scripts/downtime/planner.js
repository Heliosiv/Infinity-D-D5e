import {
  buildFenceBundleTargetId,
  DOWNTIME_ACTIVITY_IDS,
  getDowntimeActivity,
  isAllowedActivityDuration,
  normalizeFenceBundleItemIds,
  normalizeDowntimeActivityId,
} from "./catalog.js";
import {
  DOWNTIME_OUTCOME_TIERS,
  applyCrimeHeatOutcome,
  calculateCrimeDc,
  calculateFencingResult,
  calculateMarketTradingResult,
  classifyDowntimeCheck,
  clampDowntimeHeat,
  getDowntimeTimeBonus,
  getFencingValueCapCp,
  getMarketStakeCapCp,
  getPickpocketValueCapCp,
  isSeriousCrimeFailure,
  reduceDowntimeHeat,
} from "./math.js";
import {
  getSettlementSecurityDc,
  normalizeSettlementProfile,
} from "./settlements.js";

export const DOWNTIME_SUBMISSION_MAX_ACTIONS = 64;
export const DOWNTIME_MAX_CRIME_ATTEMPTS = 3;
export const DOWNTIME_MAX_LAY_LOW_ACTIONS = 2;

const CHECKED_ACTIVITY_IDS = new Set([
  DOWNTIME_ACTIVITY_IDS.MARKET_TRADING,
  DOWNTIME_ACTIVITY_IDS.PICKPOCKET,
  DOWNTIME_ACTIVITY_IDS.SHOPLIFT,
  DOWNTIME_ACTIVITY_IDS.FENCE_STOLEN_GOODS,
]);

/**
 * Strip a player queue down to the fields they are allowed to submit. Derived
 * DCs, rolls, rewards, costs, and modifiers never survive this normalization.
 */
export function normalizeDowntimeQueue(rawQueue = []) {
  if (!Array.isArray(rawQueue)) return [];
  return rawQueue
    .slice(0, DOWNTIME_SUBMISSION_MAX_ACTIONS)
    .map((raw, index) => normalizeDowntimeAction(raw, index));
}

export function normalizeDowntimeAction(raw = {}, index = 0) {
  const source = isPlainObject(raw) ? raw : {};
  const activityId = normalizeDowntimeActivityId(
    source.activityId ?? source.activity,
  );
  const activity = getDowntimeActivity(activityId);
  const suppliedSkill = normalizeDowntimeSkill(source.skill);
  const skill = activity?.forcedSkill ?? suppliedSkill;
  const targetIds =
    activityId === DOWNTIME_ACTIVITY_IDS.FENCE_STOLEN_GOODS
      ? normalizeFenceBundleItemIds(source.targetIds)
      : [];
  const suppliedTargetId = cleanId(
    typeof (source.targetId ?? source.target) === "string"
      ? (source.targetId ?? source.target)
      : "",
  );
  const targetId =
    targetIds.length > 0
      ? buildFenceBundleTargetId(targetIds)
      : suppliedTargetId;

  return {
    id: cleanId(source.id) || `action-${index + 1}`,
    activityId,
    hours: normalizeInteger(source.hours),
    skill,
    stakeCp: normalizeInteger(source.stakeCp ?? source.stake),
    targetId,
    ...(targetIds.length > 0 ? { targetIds } : {}),
    targetType: activity?.targetType ?? "",
  };
}

/**
 * Validate one character's complete queue against its full personal budget.
 * Unused time is valid. Starting Heat is projected through deterministic Lay
 * Low rows; outcome-driven Heat is applied later by `resolveDowntimeQueue`.
 */
export function validateDowntimeQueue(rawQueue, options = {}) {
  if (!Array.isArray(rawQueue) && isPlainObject(rawQueue)) {
    options = rawQueue;
    rawQueue = options.queue;
  }

  const queueWasArray = Array.isArray(rawQueue);
  const sourceLength = queueWasArray ? rawQueue.length : 0;
  const queue = normalizeDowntimeQueue(rawQueue);
  const budgetHours = normalizeBudgetHours(options.budgetHours);
  const settlement = normalizeSettlementProfile(options.settlement);
  const startingHeat = clampDowntimeHeat(options.startingHeat);
  const enabled = new Set(settlement.enabledActivityIds);
  const errors = [];
  const actionCounts = new Map();
  const actionIds = new Set();
  const crimeTargets = new Set();
  const sharpenTargets = new Set();
  const alreadySharpened = toIdSet(options.existingSharpenedWeaponIds);
  let usedHours = 0;
  let crimeAttempts = 0;
  let layLowActions = 0;
  let minimumProjectedHeat = startingHeat;

  if (!queueWasArray) {
    errors.push(errorRecord("queue-not-array", -1));
  }
  if (sourceLength > DOWNTIME_SUBMISSION_MAX_ACTIONS) {
    errors.push(
      errorRecord("too-many-actions", DOWNTIME_SUBMISSION_MAX_ACTIONS, {
        maximum: DOWNTIME_SUBMISSION_MAX_ACTIONS,
      }),
    );
  }
  if (budgetHours === null) {
    errors.push(errorRecord("invalid-budget", -1));
  }

  for (let index = 0; index < queue.length; index += 1) {
    const action = queue[index];
    const activity = getDowntimeActivity(action.activityId);
    const identity = {
      actionId: action.id,
      activityId: action.activityId,
    };

    if (actionIds.has(action.id)) {
      errors.push(errorRecord("duplicate-action-id", index, identity));
    }
    actionIds.add(action.id);

    if (!activity) {
      errors.push(errorRecord("unknown-activity", index, identity));
      continue;
    }

    const count = (actionCounts.get(activity.id) ?? 0) + 1;
    actionCounts.set(activity.id, count);
    if (activity.maxPerBlock && count > activity.maxPerBlock) {
      errors.push(
        errorRecord("activity-repeat-limit", index, {
          ...identity,
          maximum: activity.maxPerBlock,
        }),
      );
    }
    if (!enabled.has(activity.id)) {
      errors.push(errorRecord("activity-disabled", index, identity));
    }
    if (activity.requiresSettlement && !settlement.hasSettlement) {
      errors.push(errorRecord("settlement-required", index, identity));
    }
    if (!isAllowedActivityDuration(activity.id, action.hours)) {
      errors.push(
        errorRecord("invalid-hours", index, {
          ...identity,
          allowedHours: [...activity.allowedHours],
        }),
      );
    } else {
      usedHours += action.hours;
    }

    const suppliedRawSkill = normalizeDowntimeSkill(
      isPlainObject(rawQueue?.[index]) ? rawQueue[index].skill : "",
    );
    if (
      activity.forcedSkill &&
      suppliedRawSkill &&
      suppliedRawSkill !== activity.forcedSkill
    ) {
      errors.push(
        errorRecord("invalid-skill", index, {
          ...identity,
          allowedSkills: [activity.forcedSkill],
        }),
      );
    }
    if (
      activity.requiresSkill &&
      !activity.allowedSkills.includes(action.skill)
    ) {
      errors.push(
        errorRecord("invalid-skill", index, {
          ...identity,
          allowedSkills: [...activity.allowedSkills],
        }),
      );
    }

    if (activity.requiresTarget && !action.targetId) {
      errors.push(errorRecord("target-required", index, identity));
    }
    const targetAllowlist = getTargetAllowlist(options, activity.id);
    if (
      targetAllowlist &&
      action.targetId &&
      !targetAllowlist.has(action.targetId)
    ) {
      errors.push(errorRecord("target-ineligible", index, identity));
    }

    if (activity.requiresStake) {
      const stakeCapCp = getMarketStakeCapCp(
        settlement.wealthTier,
        action.hours,
      );
      if (
        !Number.isSafeInteger(action.stakeCp) ||
        action.stakeCp <= 0 ||
        action.stakeCp > stakeCapCp
      ) {
        errors.push(
          errorRecord("invalid-stake", index, {
            ...identity,
            maximumCp: stakeCapCp,
          }),
        );
      }
    }

    if (activity.id === DOWNTIME_ACTIVITY_IDS.FENCE_STOLEN_GOODS) {
      const fact = getTargetFact(options.targetFacts, action.targetId);
      const valueCp = normalizeInteger(fact?.valueCp);
      const capacityCp = getFencingValueCapCp(
        settlement.wealthTier,
        action.hours,
      );
      if (valueCp !== null && (valueCp <= 0 || valueCp > capacityCp)) {
        errors.push(
          errorRecord("target-over-capacity", index, {
            ...identity,
            valueCp,
            maximumCp: capacityCp,
          }),
        );
      }
    }

    if (activity.isCrime) {
      crimeAttempts += 1;
      if (crimeAttempts > DOWNTIME_MAX_CRIME_ATTEMPTS) {
        errors.push(
          errorRecord("crime-attempt-limit", index, {
            ...identity,
            maximum: DOWNTIME_MAX_CRIME_ATTEMPTS,
          }),
        );
      }
      if (minimumProjectedHeat >= 5) {
        errors.push(errorRecord("heat-max", index, identity));
      }
      if (
        [
          DOWNTIME_ACTIVITY_IDS.PICKPOCKET,
          DOWNTIME_ACTIVITY_IDS.SHOPLIFT,
        ].includes(activity.id) &&
        action.targetId
      ) {
        const targetKey = `${activity.id}:${action.targetId}`;
        if (crimeTargets.has(targetKey)) {
          errors.push(errorRecord("duplicate-crime-target", index, identity));
        }
        crimeTargets.add(targetKey);
      }
    }

    if (activity.id === DOWNTIME_ACTIVITY_IDS.LAY_LOW) {
      layLowActions += 1;
      minimumProjectedHeat = reduceDowntimeHeat(minimumProjectedHeat);
    }

    if (activity.id === DOWNTIME_ACTIVITY_IDS.SHARPEN_WEAPON) {
      if (alreadySharpened.has(action.targetId)) {
        errors.push(errorRecord("weapon-already-sharpened", index, identity));
      }
      if (sharpenTargets.has(action.targetId)) {
        errors.push(errorRecord("weapon-sharpen-repeat", index, identity));
      }
      if (action.targetId) sharpenTargets.add(action.targetId);
    }
  }

  if (budgetHours !== null && usedHours > budgetHours) {
    errors.push(
      errorRecord("hours-over-budget", -1, {
        budgetHours,
        usedHours,
      }),
    );
  }

  return {
    ok: errors.length === 0,
    errors,
    normalizedQueue: queue,
    budgetHours,
    usedHours,
    remainingHours:
      budgetHours === null ? null : Math.max(0, budgetHours - usedHours),
    startingHeat,
    minimumProjectedHeat,
    stats: {
      actionCount: queue.length,
      crimeAttempts,
      layLowActions,
      activityCounts: Object.fromEntries(actionCounts),
    },
    settlement,
  };
}

/**
 * Build the exact pure-domain portion of an authoritative character plan.
 * The caller supplies GM-generated raw check totals and canonical target facts.
 */
export function resolveDowntimeQueue({
  blockId,
  actorId,
  queue,
  budgetHours,
  settlement,
  startingHeat = 0,
  rolls = {},
  targetFacts = {},
  allowedTargetIds,
  existingSharpenedWeaponIds,
} = {}) {
  const validation = validateDowntimeQueue(queue, {
    budgetHours,
    settlement,
    startingHeat,
    targetFacts,
    allowedTargetIds,
    existingSharpenedWeaponIds,
  });
  if (!validation.ok) {
    return {
      ok: false,
      errors: validation.errors,
      validation,
      actorId: cleanId(actorId),
      actions: [],
      operations: [],
    };
  }

  const normalizedActorId = cleanId(actorId);
  const normalizedBlockId = cleanId(blockId);
  const identityErrors = [];
  if (!normalizedBlockId) {
    identityErrors.push(errorRecord("block-id-required", -1));
  }
  if (!normalizedActorId) {
    identityErrors.push(errorRecord("actor-id-required", -1));
  }
  if (identityErrors.length > 0) {
    return {
      ok: false,
      errors: identityErrors,
      validation,
      actorId: normalizedActorId,
      actions: [],
      operations: [],
    };
  }
  const profile = validation.settlement;
  const actions = [];
  const operations = [];
  const planningErrors = [];
  let heat = validation.startingHeat;
  let earlierCrimeAttempts = 0;
  let factionConsequenceApplied = false;

  for (let index = 0; index < validation.normalizedQueue.length; index += 1) {
    const action = validation.normalizedQueue[index];
    const activity = getDowntimeActivity(action.activityId);
    const operationId = buildDowntimeOperationId({
      blockId: normalizedBlockId,
      actorId: normalizedActorId,
      actionId: action.id,
      index,
    });
    const base = {
      operationId,
      actorId: normalizedActorId,
      settlementId: profile.id,
      actionId: action.id,
      activityId: action.activityId,
      order: index,
      hours: action.hours,
      targetId: action.targetId,
      targetType: action.targetType,
    };

    if (activity.isCrime && heat >= 5) {
      const blocked = {
        ...base,
        status: "blocked",
        reason: "heat-max",
        heatBefore: heat,
        heatAfter: heat,
      };
      actions.push(blocked);
      operations.push({ ...blocked, kind: "noop" });
      continue;
    }

    if (activity.id === DOWNTIME_ACTIVITY_IDS.LAY_LOW) {
      const heatBefore = heat;
      heat = reduceDowntimeHeat(heat);
      const resolved = {
        ...base,
        status: "resolved",
        heatBefore,
        heatAfter: heat,
      };
      actions.push(resolved);
      operations.push({ ...resolved, kind: "heat" });
      continue;
    }

    if (!CHECKED_ACTIVITY_IDS.has(activity.id)) {
      const resolution = getRoutineResolution(activity.id);
      const resolved = {
        ...base,
        status: "resolved",
        resolution,
      };
      actions.push(resolved);
      operations.push({ ...resolved, kind: routineOperationKind(activity.id) });
      continue;
    }

    const roll = getAuthoritativeRoll(rolls, action.id, index);
    if (!roll) {
      planningErrors.push(
        errorRecord("missing-authoritative-roll", index, {
          actionId: action.id,
          activityId: action.activityId,
        }),
      );
      continue;
    }

    const targetFact = getTargetFact(targetFacts, action.targetId);
    const timeBonus = getDowntimeTimeBonus(action.activityId, action.hours);
    const heatBefore = heat;
    const crimeAttemptNumber = activity.isCrime
      ? earlierCrimeAttempts + 1
      : null;
    const dc = activity.isCrime
      ? calculateCrimeDc({
          baseDc: getSettlementSecurityDc(profile.securityTier),
          heat,
          earlierCrimeAttempts,
        })
      : profile.marketDc;
    const check = classifyDowntimeCheck(roll.total + timeBonus, dc);

    if (activity.isCrime) {
      earlierCrimeAttempts += 1;
      heat = applyCrimeHeatOutcome(heat, check.outcomeTier);
    }

    let factionDelta = 0;
    if (
      activity.isCrime &&
      profile.linkedFactionId &&
      !factionConsequenceApplied &&
      isSeriousCrimeFailure(check.outcomeTier)
    ) {
      factionDelta = -1;
      factionConsequenceApplied = true;
    }

    const resolution = getCheckedResolution({
      action,
      check,
      settlement: profile,
      targetFact,
    });
    if (resolution?.error) {
      planningErrors.push(
        errorRecord(resolution.error, index, {
          actionId: action.id,
          activityId: action.activityId,
        }),
      );
      continue;
    }

    const resolved = {
      ...base,
      status: "resolved",
      skill: action.skill,
      check: {
        dieResult: roll.dieResult,
        skillModifier: roll.skillModifier,
        rawTotal: roll.total,
        timeBonus,
        total: check.total,
        dc: check.dc,
        margin: check.margin,
        outcomeTier: check.outcomeTier,
      },
      resolution,
      heatBefore: activity.isCrime ? heatBefore : undefined,
      heatAfter: activity.isCrime ? heat : undefined,
      crimeAttemptNumber,
      linkedFactionId: factionDelta ? profile.linkedFactionId : "",
      factionDelta,
    };
    actions.push(resolved);
    operations.push({ ...resolved, kind: checkedOperationKind(activity.id) });
  }

  if (planningErrors.length > 0) {
    return {
      ok: false,
      errors: planningErrors,
      validation,
      actorId: normalizedActorId,
      actions,
      operations: [],
    };
  }

  return {
    ok: true,
    errors: [],
    validation,
    blockId: normalizedBlockId,
    actorId: normalizedActorId,
    settlementId: profile.id,
    budgetHours: validation.budgetHours,
    usedHours: validation.usedHours,
    remainingHours: validation.remainingHours,
    startingHeat: validation.startingHeat,
    finalHeat: heat,
    crimeAttempts: earlierCrimeAttempts,
    factionConsequenceApplied,
    actions,
    operations,
  };
}

/** Stable operation id for checkpointing, compensation, and replay. */
export function buildDowntimeOperationId({
  blockId,
  actorId,
  actionId,
  index = 0,
} = {}) {
  const seed = [blockId, actorId, actionId, index]
    .map((part) => String(part ?? "").trim())
    .join("|");
  return `downtime-${stableHashHex(seed)}`;
}

export function normalizeDowntimeSkill(value) {
  const skill = String(value ?? "")
    .trim()
    .toLowerCase()
    .replace(/[_\s]+/g, "-");
  const aliases = {
    per: "persuasion",
    persuasion: "persuasion",
    dec: "deception",
    deception: "deception",
    slt: "sleight-of-hand",
    sleight: "sleight-of-hand",
    "sleight-of-hand": "sleight-of-hand",
  };
  return aliases[skill] ?? skill;
}

function getRoutineResolution(activityId) {
  switch (activityId) {
    case DOWNTIME_ACTIVITY_IDS.CRAFT_AMMUNITION:
      return { quantity: 20, magical: false };
    case DOWNTIME_ACTIVITY_IDS.SHARPEN_WEAPON:
      return {
        damageBonus: 1,
        charges: 3,
        expiresOnLongRest: true,
        grantsAttackBonus: false,
        grantsMagicalStatus: false,
      };
    default:
      return {};
  }
}

function getCheckedResolution({ action, check, settlement, targetFact }) {
  const theftSucceeds = [
    DOWNTIME_OUTCOME_TIERS.EXCEPTIONAL_SUCCESS,
    DOWNTIME_OUTCOME_TIERS.SUCCESS,
    DOWNTIME_OUTCOME_TIERS.SETBACK,
  ].includes(check.outcomeTier);
  switch (action.activityId) {
    case DOWNTIME_ACTIVITY_IDS.MARKET_TRADING:
      return calculateMarketTradingResult({
        stakeCp: action.stakeCp,
        outcomeTier: check.outcomeTier,
      });
    case DOWNTIME_ACTIVITY_IDS.FENCE_STOLEN_GOODS: {
      const goodsValueCp = normalizeInteger(targetFact?.valueCp);
      if (!Number.isSafeInteger(goodsValueCp) || goodsValueCp <= 0) {
        return { error: "missing-target-value" };
      }
      return calculateFencingResult({
        goodsValueCp,
        outcomeTier: check.outcomeTier,
        valueCapacityCp: getFencingValueCapCp(
          settlement.wealthTier,
          action.hours,
        ),
      });
    }
    case DOWNTIME_ACTIVITY_IDS.PICKPOCKET:
      return {
        rewardEligible: theftSucceeds,
        valueCapCp: getPickpocketValueCapCp(settlement.wealthTier),
      };
    case DOWNTIME_ACTIVITY_IDS.SHOPLIFT:
      return {
        transferStock: theftSucceeds,
        stockValueCp: normalizeInteger(targetFact?.valueCp),
        stockQuantity: theftSucceeds ? 1 : 0,
      };
    default:
      return {};
  }
}

function routineOperationKind(activityId) {
  if (activityId === DOWNTIME_ACTIVITY_IDS.CRAFT_AMMUNITION) {
    return "item-create";
  }
  if (activityId === DOWNTIME_ACTIVITY_IDS.SHARPEN_WEAPON) {
    return "weapon-enchantment";
  }
  return "routine";
}

function checkedOperationKind(activityId) {
  switch (activityId) {
    case DOWNTIME_ACTIVITY_IDS.MARKET_TRADING:
      return "currency";
    case DOWNTIME_ACTIVITY_IDS.PICKPOCKET:
      return "theft-reward";
    case DOWNTIME_ACTIVITY_IDS.SHOPLIFT:
      return "merchant-transfer";
    case DOWNTIME_ACTIVITY_IDS.FENCE_STOLEN_GOODS:
      return "fencing";
    default:
      return "checked";
  }
}

function getAuthoritativeRoll(rolls, actionId, index) {
  let raw;
  if (rolls instanceof Map) {
    raw = rolls.get(actionId) ?? rolls.get(index);
  } else if (Array.isArray(rolls)) {
    raw = rolls[index];
  } else if (isPlainObject(rolls)) {
    raw = rolls[actionId] ?? rolls[index];
  }
  if (Number.isFinite(Number(raw))) {
    return {
      dieResult: null,
      skillModifier: null,
      total: Math.trunc(Number(raw)),
    };
  }
  if (!isPlainObject(raw) || !Number.isFinite(Number(raw.total))) return null;
  return {
    dieResult: Number.isFinite(Number(raw.dieResult))
      ? Math.trunc(Number(raw.dieResult))
      : null,
    skillModifier: Number.isFinite(Number(raw.skillModifier))
      ? Math.trunc(Number(raw.skillModifier))
      : null,
    total: Math.trunc(Number(raw.total)),
  };
}

function getTargetAllowlist(options, activityId) {
  let source = options.allowedTargetIds;
  if (
    activityId === DOWNTIME_ACTIVITY_IDS.PICKPOCKET &&
    options.pickpocketOpportunityIds
  ) {
    source = {
      ...(isPlainObject(source) ? source : {}),
      [activityId]: options.pickpocketOpportunityIds,
    };
  }
  let values;
  if (source instanceof Map) values = source.get(activityId);
  else if (isPlainObject(source)) values = source[activityId];
  if (values === undefined) return null;
  return toIdSet(values);
}

function getTargetFact(targetFacts, targetId) {
  if (!targetId) return null;
  if (targetFacts instanceof Map) return targetFacts.get(targetId) ?? null;
  if (isPlainObject(targetFacts)) return targetFacts[targetId] ?? null;
  return null;
}

function toIdSet(values) {
  if (values instanceof Set) {
    return new Set([...values].map(cleanId).filter(Boolean));
  }
  if (!Array.isArray(values)) return new Set();
  return new Set(values.map(cleanId).filter(Boolean));
}

function normalizeBudgetHours(value) {
  const numeric = Number(value);
  if (!Number.isSafeInteger(numeric) || numeric < 0 || numeric > 10_000) {
    return null;
  }
  return numeric;
}

function normalizeInteger(value) {
  const numeric = Number(value);
  if (!Number.isSafeInteger(numeric)) return null;
  return numeric;
}

function cleanId(value) {
  return String(value ?? "")
    .trim()
    .replace(/[^A-Za-z0-9_.:-]/g, "")
    .slice(0, 180);
}

function errorRecord(code, index, details = {}) {
  return { code, index, ...details };
}

function isPlainObject(value) {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
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
