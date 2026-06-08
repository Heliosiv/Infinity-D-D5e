/**
 * Infinity D&D5e — Consumption & matching (pure)
 *
 * Decides which items on a character represent a tracked resource (food /
 * water / light), how to draw the daily amount from them (decrement stacks,
 * delete at zero), where to deposit foraged yield, and what exhaustion the GM
 * should be prompted to apply when a character comes up short.
 *
 * Every function here is pure: callers pass plain item snapshots
 * (`actor.items.map(i => i.toObject())`) and apply the returned plans against
 * real actors in the Foundry-touching layer (calendar-watcher.js).
 */

const MODULE_ID = "infinity-dnd5e";

function toQty(value) {
  const n = Math.floor(Number(value));
  return Number.isFinite(n) && n > 0 ? n : 0;
}

/** Lowercased item name, safe for substring matching. */
function lower(value) {
  return String(value ?? "").toLowerCase();
}

/** The module resource tag on an item snapshot, if any. */
function itemResourceTag(item) {
  return item?.flags?.[MODULE_ID]?.resourceTag ?? null;
}

/**
 * Candidate compendium-source uuid(s) for an item snapshot, used to match
 * against a resource's explicit `itemUuids` list. dnd5e stores the source on
 * `_stats.compendiumSource` (v3+) or the legacy `flags.core.sourceId`.
 */
function itemSourceUuids(item) {
  const out = [];
  const stats = item?._stats?.compendiumSource;
  if (stats) out.push(String(stats));
  const legacy = item?.flags?.core?.sourceId;
  if (legacy) out.push(String(legacy));
  if (item?.uuid) out.push(String(item.uuid));
  return out;
}

/**
 * Match a character's items against a resource definition. Priority, highest
 * first: explicit source UUID > module flag tag > name keyword. Name matching
 * is skipped entirely when `nameKeywords` is empty, so a resource can rely
 * solely on tags/UUIDs to avoid false positives ("Holy Water" vs water).
 *
 * @param {Array<object>} itemSnapshots - plain item objects (id, name, type, system, flags)
 * @param {object} resourceDef - { matching:{ nameKeywords[], flagTag, itemUuids[] } }
 * @returns {Array<{ id, name, quantity, priority }>} matches, highest priority first
 */
export function matchResourceItems(itemSnapshots, resourceDef) {
  const items = Array.isArray(itemSnapshots) ? itemSnapshots : [];
  const matching = resourceDef?.matching ?? {};
  const uuidSet = new Set(
    (Array.isArray(matching.itemUuids) ? matching.itemUuids : [])
      .map((u) => String(u ?? "").trim())
      .filter(Boolean),
  );
  const flagTag = String(matching.flagTag ?? "").trim();
  const keywords = (Array.isArray(matching.nameKeywords) ? matching.nameKeywords : [])
    .map((k) => lower(k).trim())
    .filter(Boolean);

  const out = [];
  for (const item of items) {
    if (!item || typeof item !== "object") continue;
    const id = item.id ?? item._id;
    if (!id) continue;
    const quantity = toQty(item.system?.quantity ?? 1);

    let priority = 0;
    if (uuidSet.size > 0 && itemSourceUuids(item).some((u) => uuidSet.has(u))) {
      priority = 3;
    } else if (flagTag && itemResourceTag(item) === flagTag) {
      priority = 2;
    } else if (keywords.length > 0) {
      const name = lower(item.name);
      if (keywords.some((kw) => name.includes(kw))) priority = 1;
    }
    if (priority > 0) {
      out.push({ id: String(id), name: item.name ?? "item", quantity, priority });
    }
  }
  // Highest priority first; within a tier, larger stacks first (drain big piles).
  out.sort((a, b) => b.priority - a.priority || b.quantity - a.quantity);
  return out;
}

/**
 * Plan how to draw `amount` units from a set of matched item stacks. Drains in
 * the order given (caller pre-sorts via matchResourceItems). Returns the exact
 * embedded-document operations plus any shortfall that couldn't be covered.
 *
 * @param {object} args
 * @param {Array<{id,quantity}>} args.matches
 * @param {number} args.amount - units to consume (≥ 0)
 * @returns {{ ops: Array<{id, op:"decrement"|"delete", to?:number}>, consumed:number, shortfall:number }}
 */
export function planConsumption({ matches, amount } = {}) {
  const list = Array.isArray(matches) ? matches : [];
  let remaining = Math.max(0, Math.floor(Number(amount) || 0));
  const ops = [];
  let consumed = 0;
  for (const match of list) {
    if (remaining <= 0) break;
    const have = toQty(match.quantity);
    if (have <= 0) continue;
    if (have <= remaining) {
      ops.push({ id: String(match.id), op: "delete" });
      remaining -= have;
      consumed += have;
    } else {
      ops.push({ id: String(match.id), op: "decrement", to: have - remaining });
      consumed += remaining;
      remaining = 0;
    }
  }
  return { ops, consumed, shortfall: remaining };
}

/**
 * Plan how to deposit `amount` foraged units. Bumps the first existing matching
 * stack when one exists; otherwise signals a create from a template item.
 *
 * @param {object} args
 * @param {Array<{id,quantity}>} args.matches
 * @param {number} args.amount
 * @param {object|null} [args.templateItem] - snapshot to clone when creating
 * @returns {{ op:"bump", id:string, to:number } | { op:"create", from:object, quantity:number } | { op:"none" }}
 */
export function planDeposit({ matches, amount, templateItem = null } = {}) {
  const qty = Math.max(0, Math.floor(Number(amount) || 0));
  if (qty <= 0) return { op: "none" };
  const list = Array.isArray(matches) ? matches : [];
  const target = list.find((m) => toQty(m.quantity) >= 0 && m.id);
  if (target) {
    return { op: "bump", id: String(target.id), to: toQty(target.quantity) + qty };
  }
  if (templateItem && typeof templateItem === "object") {
    return { op: "create", from: templateItem, quantity: qty };
  }
  return { op: "none" };
}

/**
 * Suggest exhaustion deltas from per-actor shortfalls. Pure — never reads or
 * writes actor state; the GM applies the result with a confirm. A character who
 * fully missed food OR water on a day earns a suggested +1 exhaustion (per the
 * 5e starvation guidance); missing both, or missing across multiple catch-up
 * days, scales up. Light shortfalls are warnings only (no exhaustion).
 *
 * @param {object} args
 * @param {Array<object>} args.shortfalls - [{ actorId, name, food, water, light }]
 *        where each number is the count of UNITS that couldn't be consumed.
 * @param {number} [args.days=1] - days this upkeep covered (caps the suggestion)
 * @returns {Array<{ actorId, name, suggestDelta, reasons:string[] }>}
 */
export function suggestExhaustion({ shortfalls, days = 1 } = {}) {
  const list = Array.isArray(shortfalls) ? shortfalls : [];
  const cap = Math.max(1, Math.floor(Number(days) || 1));
  const out = [];
  for (const s of list) {
    if (!s || !s.actorId) continue;
    const food = Math.max(0, Math.floor(Number(s.food) || 0));
    const water = Math.max(0, Math.floor(Number(s.water) || 0));
    const reasons = [];
    let delta = 0;
    if (food > 0) {
      delta += Math.min(cap, food);
      reasons.push(`went without food (${food} short)`);
    }
    if (water > 0) {
      delta += Math.min(cap, water);
      reasons.push(`went without water (${water} short)`);
    }
    delta = Math.min(6, delta);
    if (delta > 0) {
      out.push({
        actorId: s.actorId,
        name: s.name ?? "Character",
        suggestDelta: delta,
        reasons,
      });
    }
  }
  return out;
}
