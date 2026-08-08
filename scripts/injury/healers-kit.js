/** Healer's Kit discovery, planning, and verified charge consumption. */

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
    await setHealersKitAvailable(step.item, wantedAfter);
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

async function setHealersKitAvailable(item, available) {
  const next = Math.max(0, Math.floor(Number(available) || 0));
  const max = Number(item?.system?.uses?.max);
  if (Number.isFinite(max) && item?.system?.uses?.spent !== undefined) {
    const spent = Math.max(
      0,
      Math.min(Math.floor(max), Math.floor(max) - next),
    );
    await item.update({ "system.uses.spent": spent });
    return;
  }
  if (item?.system?.uses?.value !== undefined) {
    await item.update({ "system.uses.value": next });
    return;
  }
  if (item?.system?.quantity !== undefined) {
    await item.update({ "system.quantity": next });
    return;
  }
  throw new Error("HealersKitChargesNotWritable");
}
