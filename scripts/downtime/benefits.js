/** Typed benefit plans and durable Actor receipts survive expiry and retries. */
import { merchantItemId } from "../merchant/write-verification.js";
import { persistedValuesEqual } from "../utils/persisted-data.js";
import {
  planDowntimeCare,
  inspectDowntimeCare,
  applyDowntimeCare,
} from "../injury/downtime-care.js";
import { normalizeDowntimeBenefit } from "./benefit-rules.js";
import { runWithActorMutex } from "../merchant/session-state.js";
import {
  activeDowntimeBenefitEffect,
  downtimeBenefitEffectData,
  downtimeBenefitEffectMatches,
  downtimeBenefitIntegrationError,
  downtimeEffectBenefitDefinition,
  downtimeOperationEffect,
  isDowntimeEffectBenefit,
} from "./benefit-effects.js";

const MODULE_ID = "infinity-dnd5e";
const FLAG = "downtimeBenefits";
const receiptKey = (operation) =>
  merchantItemId(`${operation.operationId}:benefit`);
const receipt = (actor, operation) =>
  actor.getFlag?.(MODULE_ID, FLAG)?.[receiptKey(operation)] ??
  actor.flags?.[MODULE_ID]?.[FLAG]?.[receiptKey(operation)];

export function buildDowntimeBenefitPlan({
  actor,
  benefit,
  hours,
  blockHours = hours,
  operationId,
  target = "",
}) {
  const type = normalizeDowntimeBenefit(benefit);
  if (!type) return null;
  if (type === "injury-care") {
    if (hours < 8)
      return {
        type: "none",
        detail:
          "No recovery reduction: at least eight hours of care are required.",
      };
    if (!target)
      return {
        type,
        needsTarget: true,
        detail: "Select one patient and timed injury before applying.",
      };
    const care = planDowntimeCare(target, operationId);
    return { type, care, detail: care.detail };
  }
  const definition = downtimeEffectBenefitDefinition(type);
  if (!definition) throw new Error("Choose a supported downtime benefit.");
  const active = activeDowntimeBenefitEffect(actor, type);
  if (active)
    return {
      type: "none",
      detail: `Already has ${definition.label}; this benefit does not stack or refresh.`,
    };
  return {
    type,
    effectId: merchantItemId(`${operationId}:${type}`),
    blockHours: Math.max(
      1,
      Math.ceil(Number(blockHours) || Number(hours) || 8),
    ),
    detail: definition.detail,
  };
}

export function sparringEffectData(operation) {
  return downtimeBenefitEffectData(operation);
}

// Actor flags are player-readable. Keep clinical snapshots in the private plan.
function receiptIdentity(operation) {
  const plan = operation.benefit;
  return {
    operationId: operation.operationId,
    type: plan.type,
    effectId: plan.effectId ?? plan.care?.effectId ?? "",
    targetActorId: plan.care?.actorId ?? operation.actorId,
    injuryId: plan.care?.injuryId ?? "",
    dueTimestamp: plan.care?.after?.recoveryDueTs ?? null,
  };
}

export function inspectDowntimeBenefit(actor, operation) {
  const plan = operation.benefit;
  if (!plan || plan.type === "none") return "applied";
  if (plan.needsTarget) return "uncertain";
  const saved = receipt(actor, operation);
  if (saved && !persistedValuesEqual(saved.plan, receiptIdentity(operation)))
    return "uncertain";
  if (saved?.state === "applied") return "applied";
  if (saved) return "uncertain"; // An expired/consumed effect must never be regranted.
  if (isDowntimeEffectBenefit(plan.type))
    return downtimeOperationEffect(actor, operation) ||
      activeDowntimeBenefitEffect(actor, plan.type)
      ? "uncertain"
      : "unapplied";
  return inspectDowntimeCare(plan.care) === "unapplied"
    ? "unapplied"
    : "uncertain";
}

async function writeReceipt(actor, operation, state, authorizeWrite) {
  if (!authorizeWrite()) throw new Error("Downtime authority changed.");
  const value = { state, plan: receiptIdentity(operation) };
  try {
    await actor.update({
      [`flags.${MODULE_ID}.${FLAG}.${receiptKey(operation)}`]: value,
    });
  } catch (error) {
    if (!persistedValuesEqual(receipt(actor, operation), value)) throw error;
  }
  if (!persistedValuesEqual(receipt(actor, operation), value))
    throw new Error("Downtime benefit receipt did not save.");
}

export async function applyDowntimeBenefit(actor, operation, options) {
  const ids = [
    ...new Set([actor?.id, operation.benefit?.care?.actorId].filter(Boolean)),
  ].sort();
  const lock = (index) =>
    index < ids.length
      ? runWithActorMutex(ids[index], () => lock(index + 1))
      : applyBenefitLocked(actor, operation, options);
  return lock(0);
}

async function applyBenefitLocked(actor, operation, { authorizeWrite }) {
  const plan = operation.benefit;
  if (!plan || plan.type === "none") return { ok: true, noWrite: true };
  try {
    if (plan.needsTarget)
      throw new Error("Choose a patient and injury before applying.");
    let saved = receipt(actor, operation);
    if (saved && !persistedValuesEqual(saved.plan, receiptIdentity(operation)))
      throw new Error("Downtime benefit receipt conflict.");
    if (saved?.state === "applied") return { ok: true, alreadyApplied: true };
    if (!saved) {
      if (inspectDowntimeBenefit(actor, operation) !== "unapplied")
        throw new Error("The reviewed benefit target changed.");
      const integrationError = downtimeBenefitIntegrationError(plan.type);
      if (integrationError) throw new Error(integrationError);
      await writeReceipt(actor, operation, "applying", authorizeWrite);
      if (isDowntimeEffectBenefit(plan.type)) {
        if (!authorizeWrite()) throw new Error("Downtime authority changed.");
        try {
          await actor.createEmbeddedDocuments(
            "ActiveEffect",
            [downtimeBenefitEffectData(operation)],
            { keepId: true },
          );
        } catch (error) {
          if (
            !downtimeBenefitEffectMatches(
              downtimeOperationEffect(actor, operation),
              operation,
            )
          )
            throw error;
        }
      }
    }
    if (isDowntimeEffectBenefit(plan.type)) {
      if (
        !downtimeBenefitEffectMatches(
          downtimeOperationEffect(actor, operation),
          operation,
        )
      )
        throw new Error(
          "The timed benefit is absent or changed after application began. It will not be granted again automatically.",
        );
    } else
      await applyDowntimeCare(plan.care, operation.operationId, authorizeWrite);
    await writeReceipt(actor, operation, "applied", authorizeWrite);
    return { ok: true };
  } catch (error) {
    return { ok: false, reason: error.message, provenUnapplied: false };
  }
}
