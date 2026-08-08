import { DOWNTIME_ACTIVITY_IDS } from "./catalog.js";
import { SETTLEMENT_WEALTH_TIERS, normalizeWealthTier } from "./settlements.js";

export const DOWNTIME_OUTCOME_TIERS = Object.freeze({
  EXCEPTIONAL_SUCCESS: "exceptional-success",
  SUCCESS: "success",
  SETBACK: "setback",
  FAILURE: "failure",
  SERIOUS_FAILURE: "serious-failure",
});

export const MARKET_TRADING_RETURN_RATES = Object.freeze({
  [DOWNTIME_OUTCOME_TIERS.EXCEPTIONAL_SUCCESS]: 0.25,
  [DOWNTIME_OUTCOME_TIERS.SUCCESS]: 0.1,
  [DOWNTIME_OUTCOME_TIERS.SETBACK]: 0,
  [DOWNTIME_OUTCOME_TIERS.FAILURE]: -0.1,
  [DOWNTIME_OUTCOME_TIERS.SERIOUS_FAILURE]: -0.25,
});

export const FENCING_PAYOUT_RATES = Object.freeze({
  [DOWNTIME_OUTCOME_TIERS.EXCEPTIONAL_SUCCESS]: 0.6,
  [DOWNTIME_OUTCOME_TIERS.SUCCESS]: 0.4,
  [DOWNTIME_OUTCOME_TIERS.SETBACK]: 0.25,
  [DOWNTIME_OUTCOME_TIERS.FAILURE]: 0,
  [DOWNTIME_OUTCOME_TIERS.SERIOUS_FAILURE]: 0,
});

/** Pickpocket reward ceilings in whole copper pieces (1/5/25/100 gp). */
export const PICKPOCKET_VALUE_CAP_CP = Object.freeze({
  [SETTLEMENT_WEALTH_TIERS.POOR]: 100,
  [SETTLEMENT_WEALTH_TIERS.MODEST]: 500,
  [SETTLEMENT_WEALTH_TIERS.PROSPEROUS]: 2_500,
  [SETTLEMENT_WEALTH_TIERS.WEALTHY]: 10_000,
});

/** Maximum market stake by settlement wealth tier, in whole copper pieces. */
export const MARKET_STAKE_CAP_CP = Object.freeze({
  [SETTLEMENT_WEALTH_TIERS.POOR]: 1_000,
  [SETTLEMENT_WEALTH_TIERS.MODEST]: 5_000,
  [SETTLEMENT_WEALTH_TIERS.PROSPEROUS]: 25_000,
  [SETTLEMENT_WEALTH_TIERS.WEALTHY]: 100_000,
});

/** Maximum eight-hour fencing value; fencing can move twice the trade stake. */
export const FENCING_VALUE_CAP_CP = Object.freeze({
  [SETTLEMENT_WEALTH_TIERS.POOR]: 2_000,
  [SETTLEMENT_WEALTH_TIERS.MODEST]: 10_000,
  [SETTLEMENT_WEALTH_TIERS.PROSPEROUS]: 50_000,
  [SETTLEMENT_WEALTH_TIERS.WEALTHY]: 200_000,
});

const TIME_CAPACITY_FACTORS = Object.freeze({
  2: 0.25,
  4: 0.5,
  6: 0.75,
  8: 1,
});

/** Apply the shared margin table to a check total and DC. */
export function classifyDowntimeCheck(total, dc) {
  const numericTotal = Number(total);
  const numericDc = Number(dc);
  if (!Number.isFinite(numericTotal) || !Number.isFinite(numericDc)) {
    return null;
  }
  const margin = Math.trunc(numericTotal) - Math.trunc(numericDc);
  return {
    total: Math.trunc(numericTotal),
    dc: Math.trunc(numericDc),
    margin,
    outcomeTier: classifyDowntimeMargin(margin),
  };
}

/** Classify a signed margin using the system's five consistent tiers. */
export function classifyDowntimeMargin(margin) {
  const numeric = Number(margin);
  if (!Number.isFinite(numeric)) return null;
  if (numeric >= 10) return DOWNTIME_OUTCOME_TIERS.EXCEPTIONAL_SUCCESS;
  if (numeric >= 0) return DOWNTIME_OUTCOME_TIERS.SUCCESS;
  if (numeric >= -4) return DOWNTIME_OUTCOME_TIERS.SETBACK;
  if (numeric >= -9) return DOWNTIME_OUTCOME_TIERS.FAILURE;
  return DOWNTIME_OUTCOME_TIERS.SERIOUS_FAILURE;
}

/** Extra roll bonus granted by spending longer on a scalable activity. */
export function getDowntimeTimeBonus(activityId, hours) {
  const duration = Number(hours);
  switch (activityId) {
    case DOWNTIME_ACTIVITY_IDS.MARKET_TRADING:
    case DOWNTIME_ACTIVITY_IDS.FENCE_STOLEN_GOODS:
      return [2, 4, 6, 8].includes(duration)
        ? Math.min(3, Math.max(0, (duration - 2) / 2))
        : 0;
    case DOWNTIME_ACTIVITY_IDS.PICKPOCKET:
      return duration === 4 ? 2 : 0;
    case DOWNTIME_ACTIVITY_IDS.SHOPLIFT:
      return duration === 8 ? 2 : 0;
    default:
      return 0;
  }
}

/** Hidden crime DC after persistent Heat and same-block attempt pressure. */
export function calculateCrimeDc({
  baseDc,
  heat = 0,
  earlierCrimeAttempts = 0,
} = {}) {
  const base = boundedInteger(baseDc, 1, 40, 10);
  const localHeat = clampDowntimeHeat(heat);
  const attempts = boundedInteger(earlierCrimeAttempts, 0, 100, 0);
  return base + localHeat * 2 + attempts * 2;
}

export function getCrimeHeatDelta(outcomeTier) {
  switch (outcomeTier) {
    case DOWNTIME_OUTCOME_TIERS.SETBACK:
      return 1;
    case DOWNTIME_OUTCOME_TIERS.FAILURE:
      return 2;
    case DOWNTIME_OUTCOME_TIERS.SERIOUS_FAILURE:
      return 3;
    default:
      return 0;
  }
}

export function applyCrimeHeatOutcome(currentHeat, outcomeTier) {
  return clampDowntimeHeat(
    clampDowntimeHeat(currentHeat) + getCrimeHeatDelta(outcomeTier),
  );
}

export function reduceDowntimeHeat(currentHeat, amount = 1) {
  const reduction = boundedInteger(amount, 0, 5, 1);
  return clampDowntimeHeat(clampDowntimeHeat(currentHeat) - reduction);
}

export function clampDowntimeHeat(value) {
  return boundedInteger(value, 0, 5, 0);
}

/** Whether this tier causes the once-per-character faction consequence. */
export function isSeriousCrimeFailure(outcomeTier) {
  return outcomeTier === DOWNTIME_OUTCOME_TIERS.SERIOUS_FAILURE;
}

/** Market stake ceiling for this wealth tier at any legal trading duration. */
export function getMarketStakeCapCp(wealthTier, hours) {
  const duration = Number(hours);
  if (!Object.hasOwn(TIME_CAPACITY_FACTORS, duration)) return 0;
  return MARKET_STAKE_CAP_CP[normalizeWealthTier(wealthTier)];
}

/** Fencing value capacity for this wealth tier and exact legal duration. */
export function getFencingValueCapCp(wealthTier, hours) {
  return scaleCapacity(FENCING_VALUE_CAP_CP, wealthTier, hours);
}

export function getPickpocketValueCapCp(wealthTier) {
  return PICKPOCKET_VALUE_CAP_CP[normalizeWealthTier(wealthTier)];
}

/** Resolve market profit/loss in indivisible copper pieces. */
export function calculateMarketTradingResult({ stakeCp, outcomeTier } = {}) {
  const stake = positiveWholeCp(stakeCp);
  const rate = MARKET_TRADING_RETURN_RATES[outcomeTier];
  if (stake === null || !Number.isFinite(rate)) return null;
  const deltaCp = signedRoundedCp(stake * rate);
  return {
    stakeCp: stake,
    rate,
    deltaCp,
    finalCp: Math.max(0, stake + deltaCp),
  };
}

/** Resolve a fencing payout; failed attempts retain the selected goods. */
export function calculateFencingResult({
  goodsValueCp,
  outcomeTier,
  valueCapacityCp = Number.MAX_SAFE_INTEGER,
} = {}) {
  const goodsValue = positiveWholeCp(goodsValueCp);
  const capacity = nonnegativeWholeCp(valueCapacityCp);
  const rate = FENCING_PAYOUT_RATES[outcomeTier];
  if (goodsValue === null || capacity === null || !Number.isFinite(rate)) {
    return null;
  }
  if (goodsValue > capacity) {
    return {
      goodsValueCp: goodsValue,
      valueCapacityCp: capacity,
      eligibleValueCp: 0,
      rate,
      payoutCp: 0,
      goodsTransferred: false,
      retainsGoods: true,
      overCapacity: true,
    };
  }
  const eligibleValueCp = Math.min(goodsValue, capacity);
  const payoutCp =
    rate > 0 && eligibleValueCp > 0
      ? Math.max(1, Math.round(eligibleValueCp * rate))
      : 0;
  const goodsTransferred = rate > 0 && eligibleValueCp >= goodsValue;
  return {
    goodsValueCp: goodsValue,
    valueCapacityCp: capacity,
    eligibleValueCp,
    rate,
    payoutCp,
    goodsTransferred,
    retainsGoods: !goodsTransferred,
    overCapacity: goodsValue > capacity,
  };
}

/** Half finished market value, rounded upward to a whole copper piece. */
export function calculateAmmunitionCraftCostCp({
  unitMarketValueCp,
  quantity = 20,
} = {}) {
  const unitValue = Number(unitMarketValueCp);
  const units = Number(quantity);
  if (
    !Number.isFinite(unitValue) ||
    unitValue < 0 ||
    !Number.isSafeInteger(units) ||
    units <= 0
  ) {
    return null;
  }
  return Math.ceil((unitValue * units) / 2);
}

function scaleCapacity(table, wealthTier, hours) {
  const duration = Number(hours);
  const factor = TIME_CAPACITY_FACTORS[duration];
  if (!Number.isFinite(factor)) return 0;
  return Math.floor(table[normalizeWealthTier(wealthTier)] * factor);
}

function positiveWholeCp(value) {
  const numeric = Number(value);
  if (
    !Number.isSafeInteger(numeric) ||
    numeric <= 0 ||
    numeric > Number.MAX_SAFE_INTEGER
  ) {
    return null;
  }
  return numeric;
}

function nonnegativeWholeCp(value) {
  const numeric = Number(value);
  if (
    !Number.isSafeInteger(numeric) ||
    numeric < 0 ||
    numeric > Number.MAX_SAFE_INTEGER
  ) {
    return null;
  }
  return numeric;
}

function signedRoundedCp(value) {
  if (value === 0) return 0;
  return Math.sign(value) * Math.round(Math.abs(value));
}

function boundedInteger(value, minimum, maximum, fallback) {
  if (value === null || value === undefined || value === "") return fallback;
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return fallback;
  return Math.max(minimum, Math.min(maximum, Math.trunc(numeric)));
}
