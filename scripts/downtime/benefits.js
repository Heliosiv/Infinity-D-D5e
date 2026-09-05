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

const MODULE_ID = "infinity-dnd5e";
const FLAG = "downtimeBenefits";
const effectSource = (effect) => effect?.toObject?.() ?? effect;
const effects = (actor) =>
  Array.from(
    actor?.effects?.contents ??
      actor?.effects?.values?.() ??
      actor?.effects ??
      [],
  );
const receiptKey = (operation) =>
  merchantItemId(`${operation.operationId}:benefit`);
const receipt = (actor, operation) =>
  actor.getFlag?.(MODULE_ID, FLAG)?.[receiptKey(operation)] ??
  actor.flags?.[MODULE_ID]?.[FLAG]?.[receiptKey(operation)];
const sparEffect = (actor, plan) =>
  effects(actor).find((effect) => (effect.id ?? effect._id) === plan.effectId);
const activeSparringEffect = (actor) =>
  effects(actor).find((effect) => {
    const data = effectSource(effect);
    return (
      !data.disabled &&
      !effect.isSuppressed &&
      data.flags?.[MODULE_ID]?.downtimeSparring &&
      Number(data.duration?.startTime ?? 0) +
        Number(data.duration?.seconds ?? 43200) >
        Number(globalThis.game?.time?.worldTime ?? 0)
    );
  });

export function buildDowntimeBenefitPlan({
  actor,
  benefit,
  hours,
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
  const active = activeSparringEffect(actor);
  if (active)
    return {
      type: "none",
      detail:
        "Already ready from sparring; this bonus does not stack or refresh.",
    };
  return {
    type,
    effectId: merchantItemId(`${operationId}:sparring`),
    detail:
      "+1 to the first attack roll, expiring on that attack or after 12 in-game hours.",
  };
}

export function sparringEffectData(operation) {
  return {
    _id: operation.benefit.effectId,
    name: "Sparring — Ready for the Fight",
    img: "icons/skills/melee/weapons-crossed-swords-yellow.webp",
    disabled: false,
    transfer: false,
    description:
      "+1 to the first attack roll within 12 in-game hours. Does not stack.",
    duration: {
      seconds: 43200,
      startTime: Number(globalThis.game?.time?.worldTime ?? 0),
    },
    changes: ["mwak", "rwak", "msak", "rsak"].map((kind) => ({
      key: `system.bonuses.${kind}.attack`,
      mode: 2,
      value: "1",
      priority: 20,
    })),
    flags: {
      [MODULE_ID]: { downtimeSparring: { operationId: operation.operationId } },
      dae: {
        specialDuration: ["1Attack"],
        stackable: "noneName",
        showIcon: true,
      },
      "times-up": { isPassive: false },
    },
  };
}

function sparMatches(effect, operation) {
  const data = effectSource(effect);
  const expected = sparringEffectData(operation);
  return Boolean(
    data &&
    data.flags?.[MODULE_ID]?.downtimeSparring?.operationId ===
      operation.operationId &&
    data.duration?.seconds === 43200 &&
    !data.disabled &&
    persistedValuesEqual(data.changes, expected.changes) &&
    persistedValuesEqual(data.flags?.dae?.specialDuration, ["1Attack"]),
  );
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
  if (plan.type === "sparring")
    return sparEffect(actor, plan) || activeSparringEffect(actor)
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
      if (
        plan.type === "sparring" &&
        !["dae", "midi-qol", "times-up"].every(
          (id) => globalThis.game?.modules?.get?.(id)?.active,
        )
      )
        throw new Error(
          "Sparring requires active DAE, Midi QOL and Times Up to expire after one attack or 12 hours.",
        );
      await writeReceipt(actor, operation, "applying", authorizeWrite);
      if (plan.type === "sparring") {
        if (!authorizeWrite()) throw new Error("Downtime authority changed.");
        try {
          await actor.createEmbeddedDocuments(
            "ActiveEffect",
            [sparringEffectData(operation)],
            { keepId: true },
          );
        } catch (error) {
          if (!sparMatches(sparEffect(actor, plan), operation)) throw error;
        }
      }
    }
    if (plan.type === "sparring") {
      if (!sparMatches(sparEffect(actor, plan), operation))
        throw new Error(
          "The sparring effect is absent or changed after application began. It will not be granted again automatically.",
        );
    } else
      await applyDowntimeCare(plan.care, operation.operationId, authorizeWrite);
    await writeReceipt(actor, operation, "applied", authorizeWrite);
    return { ok: true };
  } catch (error) {
    return { ok: false, reason: error.message, provenUnapplied: false };
  }
}
