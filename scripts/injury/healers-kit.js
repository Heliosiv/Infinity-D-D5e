/** Healer's Kit discovery, planning, and verified charge consumption. */

const MODULE_ID = "infinity-dnd5e";
const TREATMENT_RECEIPT_FLAG = "criticalInjuryTreatmentReceipt";

export function normalizeHealersKitText(value) {
  return String(value ?? "")
    .toLowerCase()
    .replace(/['`’]/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

export function isHealersKitItem(item) {
  if (!item) return false;
  const name = normalizeHealersKitText(item.name);
  const identifier = normalizeHealersKitText(
    item.system?.identifier ?? item.system?.slug ?? item.id,
  );
  const combined = `${name} ${identifier}`.trim();
  if (!combined) return false;
  return (
    combined.includes("healers kit") ||
    combined.includes("healer kit") ||
    (combined.includes("healer") && combined.includes("kit"))
  );
}

export function getHealersKitAvailable(item) {
  const direct = Number(item?.system?.uses?.value);
  if (Number.isFinite(direct)) return Math.max(0, Math.floor(direct));
  const max = Number(item?.system?.uses?.max);
  const spent = Number(item?.system?.uses?.spent);
  if (Number.isFinite(max) && Number.isFinite(spent)) {
    return Math.max(0, Math.floor(max) - Math.max(0, Math.floor(spent)));
  }
  const quantity = Number(item?.system?.quantity);
  return Number.isFinite(quantity) ? Math.max(0, Math.floor(quantity)) : 0;
}

export function getActorHealersKits(actor, { includeDepleted = false } = {}) {
  const collection = actor?.items?.contents ?? actor?.items ?? [];
  return Array.from(collection ?? [])
    .filter((item) => isHealersKitItem(item))
    .map((item) => ({
      actor,
      actorId: String(actor?.id ?? ""),
      actorName: String(actor?.name ?? "Unknown Character"),
      item,
      itemId: String(item?.id ?? ""),
      itemName: String(item?.name ?? "Healer's Kit"),
      available: getHealersKitAvailable(item),
    }))
    .filter((entry) => includeDepleted || entry.available > 0)
    .sort(
      (a, b) =>
        b.available - a.available || a.itemName.localeCompare(b.itemName),
    );
}

/**
 * Plan consumption without mutating an Item. Preferred actors are considered
 * first, then the rest of the party in stable name/id order.
 */
export function buildHealersKitConsumptionPlan({
  actors = [],
  preferredActorIds = [],
  requiredCharges = 0,
} = {}) {
  const required = Math.max(0, Math.floor(Number(requiredCharges) || 0));
  const preference = new Map(
    preferredActorIds
      .map((id) => String(id ?? "").trim())
      .filter(Boolean)
      .map((id, index) => [id, index]),
  );
  const entries = actors
    .flatMap((actor) => getActorHealersKits(actor))
    .sort((a, b) => {
      const aRank = preference.get(a.actorId) ?? Number.MAX_SAFE_INTEGER;
      const bRank = preference.get(b.actorId) ?? Number.MAX_SAFE_INTEGER;
      return (
        aRank - bRank ||
        a.actorName.localeCompare(b.actorName) ||
        b.available - a.available ||
        a.itemName.localeCompare(b.itemName)
      );
    });

  let remaining = required;
  const steps = [];
  for (const entry of entries) {
    if (remaining <= 0) break;
    const spend = Math.min(entry.available, remaining);
    if (spend <= 0) continue;
    steps.push({ ...entry, spend, after: entry.available - spend });
    remaining -= spend;
  }
  return {
    ok: remaining === 0,
    required,
    available: entries.reduce((sum, entry) => sum + entry.available, 0),
    missing: remaining,
    steps,
  };
}

export async function consumeHealersKitPlan(plan) {
  if (!plan?.ok) {
    return {
      ok: false,
      consumed: 0,
      missing: Number(plan?.missing ?? plan?.required ?? 0),
      details: [],
      reason: "insufficient-charges",
    };
  }

  // Re-read every source before the first write so a stale plan does not begin
  // consuming from an inventory that can no longer satisfy the treatment.
  for (const step of plan.steps ?? []) {
    if (getHealersKitAvailable(step.item) < step.spend) {
      return {
        ok: false,
        consumed: 0,
        missing: step.spend,
        details: [],
        reason: "charges-changed",
      };
    }
  }

  const details = [];
  let consumed = 0;
  for (const step of plan.steps ?? []) {
    const before = getHealersKitAvailable(step.item);
    const wantedAfter = Math.max(0, before - step.spend);
    try {
      await setHealersKitAvailable(step.item, wantedAfter);
    } catch (error) {
      // A Foundry document update can commit and still reject when the client
      // loses the acknowledgement. Canonical read-back is the only safe way
      // to decide whether this individual write took effect.
      if (getHealersKitAvailable(step.item) !== wantedAfter) throw error;
    }
    const after = getHealersKitAvailable(step.item);
    const actual = Math.max(0, before - after);
    details.push({
      actorId: step.actorId,
      actorName: step.actorName,
      itemId: step.itemId,
      itemName: step.itemName,
      spent: actual,
      remaining: after,
    });
    consumed += actual;
    if (actual !== step.spend) {
      return {
        ok: false,
        consumed,
        missing: Math.max(0, plan.required - consumed),
        details,
        reason: "write-verification-failed",
      };
    }
  }
  return { ok: consumed === plan.required, consumed, missing: 0, details };
}

/**
 * Apply a previously persisted treatment plan exactly once.
 *
 * Each Item update stores a GM-generated receipt token in the same document
 * update as its absolute remaining-charge value. A retry may adopt the write
 * only when both the canonical value and the private token match; merely
 * observing the expected quantity is intentionally insufficient.
 */
export async function applyPersistedHealersKitPlan(
  plan,
  { treatmentId = "", receiptToken = "" } = {},
) {
  const id = normalizeReceiptId(treatmentId);
  const token = normalizeReceiptId(receiptToken);
  const required = Math.max(0, Math.floor(Number(plan?.required) || 0));
  const steps = Array.isArray(plan?.steps) ? plan.steps : [];
  if (!plan?.ok || !id || !token || required <= 0) {
    return failedApplication(required, "invalid-plan");
  }

  const expectedSpend = steps.reduce(
    (sum, step) => sum + Math.max(0, Math.floor(Number(step?.spend) || 0)),
    0,
  );
  if (expectedSpend !== required) {
    return failedApplication(required, "invalid-plan-total");
  }

  const details = [];
  let consumed = 0;
  for (const [index, step] of steps.entries()) {
    const item = step?.item;
    const before = Math.max(0, Math.floor(Number(step?.before) || 0));
    const spend = Math.max(0, Math.floor(Number(step?.spend) || 0));
    const after = Math.max(0, Math.floor(Number(step?.after) || 0));
    if (!item || !spend || before - spend !== after) {
      return failedApplication(required, "invalid-plan-step", {
        consumed,
        details,
      });
    }

    const expectedReceipt = {
      schema: 1,
      treatmentId: id,
      receiptToken: token,
      step: index,
      actorId: String(step?.actorId ?? ""),
      itemId: String(step?.itemId ?? item?.id ?? ""),
      before,
      spent: spend,
      after,
    };
    let current = getHealersKitAvailable(item);
    const existingReceipt = readTreatmentReceipt(item);
    let adopted = false;

    if (receiptMatches(existingReceipt, expectedReceipt)) {
      if (current !== after) {
        return failedApplication(required, "receipt-value-conflict", {
          consumed,
          details,
        });
      }
      adopted = true;
    } else {
      if (current !== before) {
        return failedApplication(required, "charges-changed", {
          consumed,
          details,
        });
      }
      try {
        await setHealersKitAvailable(item, after, {
          [`flags.${MODULE_ID}.${TREATMENT_RECEIPT_FLAG}`]: expectedReceipt,
        });
      } catch (error) {
        current = getHealersKitAvailable(item);
        const recoveredReceipt = readTreatmentReceipt(item);
        if (
          current !== after ||
          !receiptMatches(recoveredReceipt, expectedReceipt)
        ) {
          return failedApplication(required, "write-rejected", {
            consumed,
            details,
            error,
          });
        }
        adopted = true;
      }
    }

    current = getHealersKitAvailable(item);
    if (
      current !== after ||
      !receiptMatches(readTreatmentReceipt(item), expectedReceipt)
    ) {
      return failedApplication(required, "write-verification-failed", {
        consumed,
        details,
      });
    }
    consumed += spend;
    details.push({
      actorId: expectedReceipt.actorId,
      actorName: String(step?.actorName ?? "Unknown Character"),
      itemId: expectedReceipt.itemId,
      itemName: String(step?.itemName ?? "Healer's Kit"),
      spent: spend,
      remaining: after,
      adopted,
    });
  }

  return {
    ok: consumed === required,
    consumed,
    missing: Math.max(0, required - consumed),
    details,
    reason: consumed === required ? null : "write-verification-failed",
  };
}

function failedApplication(
  required,
  reason,
  { consumed = 0, details = [], error = null } = {},
) {
  return {
    ok: false,
    consumed,
    missing: Math.max(0, required - consumed),
    details,
    reason,
    ...(error ? { error } : {}),
  };
}

function normalizeReceiptId(value) {
  const id = String(value ?? "").trim();
  return id.length > 0 && id.length <= 160 ? id : "";
}

function readTreatmentReceipt(item) {
  return (
    item?.getFlag?.(MODULE_ID, TREATMENT_RECEIPT_FLAG) ??
    item?.flags?.[MODULE_ID]?.[TREATMENT_RECEIPT_FLAG] ??
    null
  );
}

function receiptMatches(actual, expected) {
  return Boolean(
    actual &&
    Number(actual.schema) === expected.schema &&
    String(actual.treatmentId ?? "") === expected.treatmentId &&
    String(actual.receiptToken ?? "") === expected.receiptToken &&
    Number(actual.step) === expected.step &&
    String(actual.actorId ?? "") === expected.actorId &&
    String(actual.itemId ?? "") === expected.itemId &&
    Number(actual.before) === expected.before &&
    Number(actual.spent) === expected.spent &&
    Number(actual.after) === expected.after,
  );
}

async function setHealersKitAvailable(item, available, extraUpdates = {}) {
  const next = Math.max(0, Math.floor(Number(available) || 0));
  const max = Number(item?.system?.uses?.max);
  if (Number.isFinite(max) && item?.system?.uses?.spent !== undefined) {
    const spent = Math.max(
      0,
      Math.min(Math.floor(max), Math.floor(max) - next),
    );
    await item.update({ "system.uses.spent": spent, ...extraUpdates });
    return;
  }
  if (item?.system?.uses?.value !== undefined) {
    await item.update({ "system.uses.value": next, ...extraUpdates });
    return;
  }
  if (item?.system?.quantity !== undefined) {
    await item.update({ "system.quantity": next, ...extraUpdates });
    return;
  }
  throw new Error("HealersKitChargesNotWritable");
}
