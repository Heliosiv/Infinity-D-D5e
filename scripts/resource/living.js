import {
  planCurrencyDeduction,
  readWalletStrict,
} from "../merchant/currency.js";

const MODULE_ID = "infinity-dnd5e";
export const LIVING_CHOICES = Object.freeze([
  { value: "supplies", label: "Use supplies", gp: 0 },
  { value: "squalid", label: "Squalid · 1 sp/day", gp: 0.1 },
  { value: "poor", label: "Poor · 2 sp/day", gp: 0.2 },
  { value: "modest", label: "Modest · 1 gp/day", gp: 1 },
  { value: "comfortable", label: "Comfortable · 2 gp/day", gp: 2 },
  { value: "wealthy", label: "Wealthy · 4 gp/day", gp: 4 },
  { value: "aristocratic", label: "Aristocratic · 10 gp/day", gp: 10 },
  { value: "covered", label: "GM-covered (reason required)", gp: 0 },
]);

export function normalizeLiving(value) {
  return LIVING_CHOICES.some((choice) => choice.value === value)
    ? value
    : "supplies";
}

export function livingPolicy(config, actorId) {
  const entry =
    config?.dailyLiving === true
      ? config.roster?.find((row) => row.actorId === actorId)
      : null;
  return {
    mode: normalizeLiving(entry?.living),
    reason: String(entry?.livingReason ?? "")
      .trim()
      .slice(0, 200),
  };
}

export function isLivingResource(resource) {
  return (
    ["food", "water"].includes(resource?.id) ||
    ["food", "water"].includes(resource?.forageYields)
  );
}

export function suppliesRequired(member, resource) {
  return (
    !isLivingResource(resource) || normalizeLiving(member.living) === "supplies"
  );
}

export function livingRoster(roster, config) {
  return roster.map((member) => ({
    ...member,
    living: livingPolicy(config, member.actorId ?? member.actor?.id).mode,
  }));
}

/** Currency and its receipt are one Actor update. A resumed run reads that
 * receipt before charging again. Uncertain writes stop the run for review. */
export async function settleLiving({
  config,
  rows,
  runId,
  days,
  actors,
  assertWriteAllowed,
}) {
  if (!config.dailyLiving) return;
  if (!runId || !Number.isSafeInteger(days) || days < 1)
    throw new Error("Invalid living settlement period");
  for (const row of rows) {
    const policy = livingPolicy(config, row.actorId);
    if (policy.mode === "supplies") continue;
    const choice = LIVING_CHOICES.find((entry) => entry.value === policy.mode);
    const cost = Math.round(choice.gp * days * 100) / 100;
    const actor = actors?.get?.(row.actorId);
    if (!actor)
      throw new Error("A living-cost actor is missing; review daily upkeep");
    await assertWriteAllowed?.();
    const prior = actor.flags?.[MODULE_ID]?.livingReceipt;
    if (prior?.runId === runId) {
      if (
        prior.version !== 1 ||
        prior.mode !== policy.mode ||
        prior.cost !== cost ||
        prior.days !== days ||
        prior.reason !== policy.reason
      )
        throw new Error(
          "Living receipt does not match this run; review daily upkeep",
        );
      if (
        prior.covered &&
        cost > 0 &&
        JSON.stringify(readWalletStrict(actor.system?.currency).wallet) !==
          JSON.stringify(prior.walletAfter)
      )
        throw new Error(
          "Wallet changed since the pending living payment; review the receipt before recovery",
        );
      row.living = { ...prior };
    } else {
      const wallet = readWalletStrict(actor.system?.currency);
      const next =
        cost > 0 && wallet.ok
          ? planCurrencyDeduction(wallet.wallet, cost)
          : null;
      const covered =
        policy.mode === "covered" ? Boolean(policy.reason) : Boolean(next);
      const receipt = {
        version: 1,
        runId,
        mode: policy.mode,
        cost,
        days,
        reason: policy.reason,
        covered,
        walletAfter: covered && cost > 0 ? next : null,
      };
      const update = { [`flags.${MODULE_ID}.livingReceipt`]: receipt };
      if (covered && cost > 0) update["system.currency"] = next;
      await assertWriteAllowed?.();
      if (
        JSON.stringify(readWalletStrict(actor.system?.currency)) !==
        JSON.stringify(wallet)
      )
        throw new Error(
          "Wallet changed before living payment; review daily upkeep",
        );
      try {
        await actor.update(update);
      } catch (error) {
        if (actor.flags?.[MODULE_ID]?.livingReceipt?.runId !== runId)
          throw error;
      }
      if (
        JSON.stringify(actor.flags?.[MODULE_ID]?.livingReceipt) !==
        JSON.stringify(receipt)
      )
        throw new Error(
          "Living payment could not be verified; do not rerun upkeep",
        );
      if (
        covered &&
        cost > 0 &&
        JSON.stringify(readWalletStrict(actor.system?.currency).wallet) !==
          JSON.stringify(next)
      )
        throw new Error(
          "Living wallet write needs review; do not rerun upkeep",
        );
      row.living = receipt;
    }
    if (!row.living.covered) {
      row.errors ??= [];
      row.errors.push(
        policy.mode === "covered"
          ? "Living unresolved: a GM-covered reason is required."
          : `Living unresolved: could not pay ${cost} gp. Food and water were not consumed.`,
      );
    }
  }
}

export function livingSummary(value) {
  if (!value) return "";
  if (!value.covered) return "Living costs unresolved";
  return value.mode === "covered"
    ? `GM-covered: ${value.reason}`
    : `${value.mode}: paid ${value.cost} gp for ${value.days} day(s)`;
}
