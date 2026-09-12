import { buildResourceInventoryPlan } from "./operation-inventory.js";
import { buildResourceOverview } from "./overview.js";

/** GM-only preview. Reuse the inventory planner; never write documents. */
export async function buildDailySupplyPreview({
  config = {},
  roster = [],
  days = 1,
} = {}) {
  const overview = buildResourceOverview({ config, roster });
  const plan = await buildResourceInventoryPlan({
    runId: "daily-supply-preview",
    roster,
    resources: overview.partySize ? config.resources : [],
    days,
    halfRations: config.halfRations,
    supplyCredits: config.supplyCredits,
    waterEnabled: config.waterEnabled,
    partyStashId: config.partyStashId,
  });
  return {
    consumerCount: overview.partySize,
    resources: overview.resources.map((resource) => {
      const rows = plan.accounting.perActor;
      const consumed =
        resource.scope === "party"
          ? (plan.accounting.party[resource.id]?.consumed ?? 0)
          : rows.reduce(
              (sum, row) => sum + (row.consumed[resource.id] ?? 0),
              0,
            );
      const shortfall =
        resource.scope === "party"
          ? (plan.accounting.party[resource.id]?.shortfall ?? 0)
          : rows.reduce(
              (sum, row) => sum + (row.shortfalls[resource.id] ?? 0),
              0,
            );
      return {
        id: resource.id,
        available: resource.available,
        required: consumed + shortfall,
        shortfall,
      };
    }),
  };
}

/** Exact preview fence includes inventory, routing and rules. */
export function dailySupplyContextFingerprint(context) {
  return JSON.stringify(context);
}
