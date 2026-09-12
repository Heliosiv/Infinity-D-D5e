/** Whole inventory units with prepaid fractional portions, recorded per consumer. */
export function dailyResourceDemand(resource, config = {}) {
  const base = Number(resource?.perDay);
  if (!Number.isFinite(base) || base <= 0) return 0;
  const food = resource.id === "food" || resource.forageYields === "food";
  return base / (food && config.halfRations === true ? 2 : 1);
}

export function normalizeSupplyCredits(value) {
  const entries =
    value?.version === 1 && value.balances && typeof value.balances === "object"
      ? Object.entries(value.balances)
      : [];
  return {
    version: 1,
    balances: Object.fromEntries(
      entries
        .slice(0, 5000)
        .filter(
          ([key, amount]) =>
            key.length <= 512 &&
            typeof amount === "number" &&
            Number.isFinite(amount) &&
            amount > 0 &&
            amount < 1,
        ),
    ),
  };
}

export function supplyCredit(resource, actorId, credits) {
  return (
    normalizeSupplyCredits(credits).balances[creditKey(resource, actorId)] ?? 0
  );
}

export function resourceCharge(
  resource,
  config,
  days = 1,
  actorId = null,
  credits = null,
) {
  const demand =
    dailyResourceDemand(resource, config) *
    Math.max(1, Math.floor(Number(days) || 1));
  const prepaid = supplyCredit(resource, actorId, credits);
  return {
    demand,
    prepaid,
    amount: Math.max(0, Math.ceil(roundPortion(demand - prepaid))),
  };
}

export function recordSupplyCredit(credits, resource, actorId, charge, result) {
  const key = creditKey(resource, actorId);
  // Never create credit from an ambiguous write. A run requiring review retains
  // its lease/receipt evidence; only proven inventory charges fund future use.
  const consumed = result?.error
    ? 0
    : Math.max(0, Number(result?.consumed) || 0);
  const remaining = roundPortion(
    Math.max(0, charge.prepaid + consumed - charge.demand),
  );
  if (remaining > 0 && remaining < 1) credits.balances[key] = remaining;
  else delete credits.balances[key];
}

function creditKey(resource, actorId) {
  return JSON.stringify([
    String(resource.id),
    resource.scope === "party" ? null : String(actorId),
  ]);
}

function roundPortion(value) {
  return Math.round(value * 1e9) / 1e9;
}
