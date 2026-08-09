import {
  buildFenceBundleTargetId,
  DOWNTIME_ACTIVITY_CATALOG,
  DOWNTIME_ACTIVITY_IDS,
  normalizeFenceBundleItemIds,
} from "./catalog.js";
import {
  getFencingValueCapCp,
  getMarketStakeCapCp,
  getPickpocketValueCapCp,
} from "./math.js";
import {
  buildPickpocketOpportunitySeed,
  buildPickpocketRewardSeed,
  generatePickpocketOpportunities,
} from "./opportunities.js";
import { getDowntimeHeat } from "./settlements.js";
import {
  AMMUNITION_RECIPES,
  actorHasAnyTool,
  actorHasTool,
  collectionValues,
  resolveItemSnapshot,
} from "./items.js";
import { activeStolenGoodsRecord } from "./stolen-ledger.js";
import { hasSharpening, isSharpenableWeapon } from "./effects.js";
import {
  findMerchant,
  loadMerchants,
  resolveItemBasePriceGp,
} from "../merchant/store.js";
import { merchantItemId } from "../merchant/write-verification.js";
import { totalWalletCp } from "../merchant/currency.js";

const ACTIVITY_COPY = Object.freeze({
  [DOWNTIME_ACTIVITY_IDS.CRAFT_AMMUNITION]: Object.freeze({
    description:
      "Spend four productive hours and half the finished market value to make 20 standard ammunition.",
    icon: "fa-solid fa-feather-pointed",
  }),
  [DOWNTIME_ACTIVITY_IDS.SHARPEN_WEAPON]: Object.freeze({
    description:
      "Give a nonmagical melee weapon +1 damage for its next three damage rolls or until your next long rest.",
    icon: "fa-solid fa-khanda",
  }),
  [DOWNTIME_ACTIVITY_IDS.MARKET_TRADING]: Object.freeze({
    description:
      "Stake coin on city trading. More time improves the hidden Persuasion or Deception check.",
    icon: "fa-solid fa-scale-balanced",
  }),
  [DOWNTIME_ACTIVITY_IDS.PICKPOCKET]: Object.freeze({
    description:
      "Choose one generated city mark. Four hours grants +2, while Heat makes the attempt harder.",
    icon: "fa-solid fa-hand",
  }),
  [DOWNTIME_ACTIVITY_IDS.SHOPLIFT]: Object.freeze({
    description:
      "Try to take one finite stock item from a linked merchant. Eight hours grants +2.",
    icon: "fa-solid fa-mask-face",
  }),
  [DOWNTIME_ACTIVITY_IDS.FENCE_STOLEN_GOODS]: Object.freeze({
    description:
      "Convert a selected bundle of provenanced stolen goods into coin through a hidden social check.",
    icon: "fa-solid fa-sack-dollar",
  }),
  [DOWNTIME_ACTIVITY_IDS.LAY_LOW]: Object.freeze({
    description:
      "Spend four hours to reduce local Heat by one, without a roll.",
    icon: "fa-solid fa-user-secret",
  }),
});

function itemId(item) {
  return String(item?.id ?? item?._id ?? "").trim();
}

function actorName(actor) {
  return String(actor?.name ?? "Unknown character");
}

function formatGp(cp) {
  const value = Math.max(0, Number(cp) || 0) / 100;
  return `${value.toFixed(value % 1 === 0 ? 0 : 2)} gp`;
}

function activityTargetKey(activityId) {
  switch (activityId) {
    case DOWNTIME_ACTIVITY_IDS.CRAFT_AMMUNITION:
      return "ammunitionType";
    case DOWNTIME_ACTIVITY_IDS.SHARPEN_WEAPON:
      return "weaponId";
    case DOWNTIME_ACTIVITY_IDS.FENCE_STOLEN_GOODS:
      return "bundleId";
    default:
      return "targetId";
  }
}

/**
 * Resolve all actor-owned and settlement-linked options. `playerActivities`
 * is safe to send to the owner; `targetFacts` remains restricted to the GM.
 */
export async function buildActorDowntimeContext({
  block,
  actor,
  settlement,
  config,
  queue = [],
} = {}) {
  const actorId = String(actor?.id ?? "");
  const hasSettlement = settlement?.hasSettlement !== false;
  const heat = getDowntimeHeat(config, settlement?.id, actorId);
  const opportunitySeed = buildPickpocketOpportunitySeed({
    blockId: block?.id,
    settlementId: settlement?.id,
    actorId,
    secret: block?.opportunitySecret,
  });
  const pickpocketMarks = hasSettlement
    ? generatePickpocketOpportunities({
        seed: opportunitySeed,
        settlementId: settlement?.id,
      })
    : [];
  const walletCp = totalWalletCp(actor?.system?.currency);

  const sharpenTool =
    actorHasTool(actor, "whetstone") || actorHasTool(actor, "smith");
  const weapons = collectionValues(actor?.items)
    .filter(isSharpenableWeapon)
    .map((item) => ({
      id: itemId(item),
      label: String(item.name ?? "Weapon"),
      detail: hasSharpening(item)
        ? "Already sharpened; the benefit cannot stack."
        : "Eligible nonmagical melee weapon.",
      disabled: hasSharpening(item),
    }));
  const existingSharpenedWeaponIds = collectionValues(actor?.items)
    .filter(hasSharpening)
    .map(itemId);

  const ammoTargets = Object.values(AMMUNITION_RECIPES).map((recipe) => {
    const hasTool = actorHasAnyTool(actor, recipe.toolKeys);
    const costCp = Math.ceil((recipe.unitMarketCp * recipe.batchSize) / 2);
    const canAfford = walletCp >= costCp;
    return {
      id: recipe.id,
      label: recipe.label,
      detail: `20 per batch; materials cost ${formatGp(costCp)}.`,
      hasTool,
      canAfford,
      disabled: !hasTool || !canAfford,
      reason: !hasTool
        ? "You do not own an appropriate tool."
        : canAfford
          ? ""
          : `You need ${formatGp(costCp)} for materials.`,
    };
  });

  const merchantTargets = await buildMerchantTargets(settlement);
  const fenceTargets = buildFenceTargets(actor, settlement, config, queue);
  const targetFacts = {};
  for (const mark of pickpocketMarks) {
    targetFacts[mark.id] = {
      ...mark,
      sourceId: mark.id,
      valueCapCp: getPickpocketValueCapCp(settlement?.wealthTier),
      rewardSeed: buildPickpocketRewardSeed({
        blockId: block?.id,
        settlementId: settlement?.id,
        actorId: actor?.id,
        markId: mark.id,
        secret: block?.opportunitySecret,
      }),
    };
  }
  for (const target of merchantTargets.hidden) targetFacts[target.id] = target;
  for (const target of fenceTargets.hidden) targetFacts[target.id] = target;

  const allowedTargetIds = {
    [DOWNTIME_ACTIVITY_IDS.CRAFT_AMMUNITION]: ammoTargets
      .filter((target) => !target.disabled)
      .map((target) => target.id),
    [DOWNTIME_ACTIVITY_IDS.SHARPEN_WEAPON]: sharpenTool
      ? weapons.filter((target) => !target.disabled).map((target) => target.id)
      : [],
    [DOWNTIME_ACTIVITY_IDS.PICKPOCKET]: pickpocketMarks.map(
      (target) => target.id,
    ),
    [DOWNTIME_ACTIVITY_IDS.SHOPLIFT]: merchantTargets.safe.map(
      (target) => target.id,
    ),
    [DOWNTIME_ACTIVITY_IDS.FENCE_STOLEN_GOODS]: fenceTargets.hidden.map(
      (target) => target.id,
    ),
  };

  const enabled = new Set(settlement?.enabledActivityIds ?? []);
  const playerActivities = DOWNTIME_ACTIVITY_CATALOG.filter((activity) =>
    enabled.has(activity.id),
  ).map((activity) => {
    const targetOptions =
      activity.id === DOWNTIME_ACTIVITY_IDS.CRAFT_AMMUNITION
        ? ammoTargets
        : activity.id === DOWNTIME_ACTIVITY_IDS.SHARPEN_WEAPON
          ? weapons
          : activity.id === DOWNTIME_ACTIVITY_IDS.PICKPOCKET
            ? pickpocketMarks
            : activity.id === DOWNTIME_ACTIVITY_IDS.SHOPLIFT
              ? merchantTargets.safe
              : activity.id === DOWNTIME_ACTIVITY_IDS.FENCE_STOLEN_GOODS
                ? fenceTargets.safe
                : [];
    const reason = unavailableReason(activity.id, {
      heat,
      sharpenTool,
      weapons,
      ammoTargets,
      merchantTargets: merchantTargets.safe,
      fenceTargets: fenceTargets.safe,
      walletCp,
      hasSettlement,
    });
    const copy = ACTIVITY_COPY[activity.id] ?? {};
    return {
      id: activity.id,
      label: activity.label,
      category: activity.category,
      description: copy.description ?? "",
      icon: copy.icon ?? "fa-solid fa-hourglass",
      available: !reason,
      unavailableReason: reason,
      hourOptions: activity.allowedHours.map((hours, index) => ({
        value: hours,
        label: `${hours} ${hours === 1 ? "hour" : "hours"}`,
        selected: index === 0,
      })),
      fixedHours:
        activity.allowedHours.length === 1 ? activity.allowedHours[0] : 0,
      skills: (activity.allowedSkills ?? []).map((skill, index) => ({
        id: skill,
        label: skill === "persuasion" ? "Persuasion" : "Deception",
        selected: index === 0,
      })),
      targets: targetOptions,
      targetField: activityTargetKey(activity.id),
      multiTarget: activity.id === DOWNTIME_ACTIVITY_IDS.FENCE_STOLEN_GOODS,
      stakeAllowed: activity.requiresStake === true,
      maxStakeGp:
        activity.id === DOWNTIME_ACTIVITY_IDS.MARKET_TRADING
          ? Math.min(walletCp, getMarketStakeCapCp(settlement?.wealthTier, 8)) /
            100
          : 0,
      stakeStepGp: 0.01,
      stakeValueGp:
        activity.id === DOWNTIME_ACTIVITY_IDS.MARKET_TRADING && walletCp > 0
          ? 0.01
          : 0,
      costLabel:
        activity.id === DOWNTIME_ACTIVITY_IDS.CRAFT_AMMUNITION
          ? "Materials: half finished market value"
          : activity.id === DOWNTIME_ACTIVITY_IDS.FENCE_STOLEN_GOODS
            ? fencingCapacityLabel(settlement?.wealthTier)
            : "",
      limitLabel: activityLimitLabel(activity.id),
    };
  });

  return {
    actorId,
    actorName: actorName(actor),
    heat,
    walletCp,
    playerActivities,
    allowedTargetIds,
    targetFacts,
    existingSharpenedWeaponIds,
    pickpocketMarks,
  };
}

async function buildMerchantTargets(settlement) {
  const merchants = loadMerchants();
  const linked = new Set(settlement?.linkedMerchantIds ?? []);
  const safe = [];
  const hidden = [];
  for (const merchant of merchants) {
    if (!linked.has(merchant.id)) continue;
    for (const row of merchant.items ?? []) {
      if (row.unlimited === true || Number(row.qty) < 1 || !row.uuid) continue;
      const snapshot = await resolveItemSnapshot(row.uuid);
      if (!snapshot) continue;
      if (
        snapshot.flags?.dnd5e?.questItem === true ||
        snapshot.flags?.["infinity-dnd5e"]?.unsellable === true
      ) {
        continue;
      }
      const valueCp = Math.max(
        0,
        Math.round(resolveItemBasePriceGp(snapshot) * 100),
      );
      const id = `shop-${merchantItemId(`${merchant.id}|${row.uuid}`)}`;
      safe.push({
        id,
        label: `${merchant.name} — ${snapshot.name ?? "Item"}`,
        detail: "One finite stock unit is available as a target.",
      });
      hidden.push({
        id,
        merchantId: merchant.id,
        merchantName: merchant.name,
        itemUuid: row.uuid,
        itemName: String(snapshot.name ?? "Item"),
        itemSnapshot: snapshot,
        quantityBefore: Number(row.qty),
        quantityAfter: Math.max(0, Number(row.qty) - 1),
        valueCp,
      });
    }
  }
  return { safe, hidden };
}

function buildFenceTargets(actor, settlement, config, queue = []) {
  const cap = getFencingValueCapCp(settlement?.wealthTier, 8);
  const eligible = new Map();
  for (const item of collectionValues(actor?.items)) {
    const id = itemId(item);
    if (!id || Number(item?.system?.quantity ?? 1) !== 1) continue;
    const issuance = activeStolenGoodsRecord(config, {
      actorId: actor?.id,
      itemId: id,
      item,
    });
    if (!issuance || issuance.provenance.appraisedValueCp <= 0) continue;
    if (issuance.provenance.appraisedValueCp > cap) continue;
    eligible.set(id, { item, issuance });
  }
  const safe = [...eligible.values()].map(({ item, issuance }) => ({
    id: issuance.itemId,
    label: String(item.name ?? "Stolen item"),
    detail: `Appraised value ${formatGp(issuance.provenance.appraisedValueCp)}; requires at least ${minimumFencingHours(settlement?.wealthTier, issuance.provenance.appraisedValueCp)} hours.`,
  }));
  const hidden = [];
  for (const action of Array.isArray(queue) ? queue : []) {
    if (action?.activityId !== DOWNTIME_ACTIVITY_IDS.FENCE_STOLEN_GOODS) {
      continue;
    }
    const ids = normalizeFenceBundleItemIds(action.targetIds);
    if (ids.length === 0 || ids.some((id) => !eligible.has(id))) continue;
    const id = buildFenceBundleTargetId(ids);
    if (
      !id ||
      id !== action.targetId ||
      hidden.some((entry) => entry.id === id)
    ) {
      continue;
    }
    const bundle = ids.map((itemId) => eligible.get(itemId));
    const valueCp = bundle.reduce(
      (sum, entry) => sum + entry.issuance.provenance.appraisedValueCp,
      0,
    );
    if (valueCp <= 0 || valueCp > cap) continue;
    hidden.push({
      id,
      valueCp,
      itemIds: ids,
      itemSnapshots: bundle.map(({ item }) => item.toObject?.() ?? item),
      issuanceRecords: bundle.map(({ issuance }) => issuance),
    });
  }
  return { safe, hidden };
}

function minimumFencingHours(wealthTier, valueCp) {
  return (
    [2, 4, 6, 8].find(
      (hours) => valueCp <= getFencingValueCapCp(wealthTier, hours),
    ) ?? 8
  );
}

function fencingCapacityLabel(wealthTier) {
  return [2, 4, 6, 8]
    .map(
      (hours) =>
        `${hours}h ${formatGp(getFencingValueCapCp(wealthTier, hours))}`,
    )
    .join("; ");
}

function unavailableReason(activityId, facts) {
  const activity = DOWNTIME_ACTIVITY_CATALOG.find(
    (entry) => entry.id === activityId,
  );
  if (activity?.requiresSettlement && !facts.hasSettlement) {
    return "Requires a selected settlement; this activity is not available at camp or in the wilderness.";
  }
  if (
    facts.heat >= 5 &&
    [
      DOWNTIME_ACTIVITY_IDS.PICKPOCKET,
      DOWNTIME_ACTIVITY_IDS.SHOPLIFT,
      DOWNTIME_ACTIVITY_IDS.FENCE_STOLEN_GOODS,
    ].includes(activityId)
  ) {
    return "Heat is 5. Lay Low before attempting more crime.";
  }
  switch (activityId) {
    case DOWNTIME_ACTIVITY_IDS.CRAFT_AMMUNITION:
      if (facts.ammoTargets.some((target) => !target.disabled)) return "";
      if (facts.ammoTargets.some((target) => target.hasTool)) {
        return "You do not have enough coin for ammunition materials.";
      }
      return "You do not own an appropriate ammunition-crafting tool.";
    case DOWNTIME_ACTIVITY_IDS.SHARPEN_WEAPON:
      if (!facts.sharpenTool) return "Requires a Whetstone or Smith's Tools.";
      return facts.weapons.some((target) => !target.disabled)
        ? ""
        : "No eligible unsharpened melee weapon is owned.";
    case DOWNTIME_ACTIVITY_IDS.MARKET_TRADING:
      return facts.walletCp > 0 ? "" : "Requires coin to stake.";
    case DOWNTIME_ACTIVITY_IDS.SHOPLIFT:
      return facts.merchantTargets.length
        ? ""
        : "No finite eligible stock is available from linked merchants.";
    case DOWNTIME_ACTIVITY_IDS.FENCE_STOLEN_GOODS:
      return facts.fenceTargets.length
        ? ""
        : "No stolen bundle fits this settlement's value capacity.";
    case DOWNTIME_ACTIVITY_IDS.LAY_LOW:
      return facts.heat > 0 ? "" : "You have no local Heat to reduce.";
    default:
      return "";
  }
}

function activityLimitLabel(activityId) {
  if (activityId === DOWNTIME_ACTIVITY_IDS.MARKET_TRADING) {
    return "Once per character per block";
  }
  if (activityId === DOWNTIME_ACTIVITY_IDS.FENCE_STOLEN_GOODS) {
    return "Once per character; counts toward three crime attempts";
  }
  if (activityId === DOWNTIME_ACTIVITY_IDS.LAY_LOW) {
    return "At most twice per character per block";
  }
  if (
    [DOWNTIME_ACTIVITY_IDS.PICKPOCKET, DOWNTIME_ACTIVITY_IDS.SHOPLIFT].includes(
      activityId,
    )
  ) {
    return "At most three total crime attempts; target cannot repeat";
  }
  return "";
}

export function findLinkedMerchantTarget(targetFacts, targetId) {
  const fact = targetFacts?.[String(targetId ?? "")];
  if (!fact?.merchantId || !findMerchant(fact.merchantId)) return null;
  return fact;
}
