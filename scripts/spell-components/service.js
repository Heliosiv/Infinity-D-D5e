const MODULE_ID = "infinity-dnd5e";

export const SPELL_COMPONENT_SOURCE = Object.freeze({
  POUCH: "pouch",
  LOOSE: "loose",
});

const POUCH_IDENTIFIERS = new Set(["component-pouch"]);
const LOOSE_IDENTIFIERS = new Set(["spell-components"]);

/**
 * Resolve the number of one-gp component units owed for this cast.
 * Cantrips and non-spell item activities do not use the generic component pool.
 */
export function spellComponentCost(activity, usageConfig = {}) {
  const item = itemFromActivity(activity);
  if (item?.type !== "spell" || isComponentExempt(item)) return 0;

  const baseLevel = nonNegativeInteger(item.system?.level);
  if (baseLevel === 0) return 0;

  let castLevel = baseLevel;
  const scaling = numericScaling(usageConfig?.scaling);
  if (scaling != null) castLevel = Math.max(castLevel, baseLevel + scaling);

  const slot = String(usageConfig?.spell?.slot ?? "").trim();
  const slotMatch = /^spell(\d+)$/.exec(slot);
  if (slotMatch) castLevel = Math.max(castLevel, Number(slotMatch[1]));
  if (slot === "pact") {
    castLevel = Math.max(
      castLevel,
      nonNegativeInteger(item.actor?.system?.spells?.pact?.level),
    );
  }

  return Math.min(9, nonNegativeInteger(castLevel));
}

/** Identify a supported generic component source on an Actor. */
export function spellComponentSourceKind(item) {
  if (!item || typeof item !== "object") return null;
  const explicit = readFlag(item, "spellComponentSource");
  if (explicit === SPELL_COMPONENT_SOURCE.POUCH) {
    return pouchMaximum(item) > 0 ? SPELL_COMPONENT_SOURCE.POUCH : null;
  }
  if (explicit === SPELL_COMPONENT_SOURCE.LOOSE) {
    return SPELL_COMPONENT_SOURCE.LOOSE;
  }

  const identifier = normalizeIdentifier(
    item.system?.identifier ?? item.identifier ?? item.name,
  );
  if (POUCH_IDENTIFIERS.has(identifier) && pouchMaximum(item) > 0) {
    return SPELL_COMPONENT_SOURCE.POUCH;
  }
  if (LOOSE_IDENTIFIERS.has(identifier)) return SPELL_COMPONENT_SOURCE.LOOSE;
  return null;
}

/** Return the spendable one-gp units represented by one source item. */
export function availableSpellComponentUnits(item, kind) {
  if (kind === SPELL_COMPONENT_SOURCE.POUCH) {
    const maximum = pouchMaximum(item);
    const quantity = nonNegativeInteger(item?.system?.quantity);
    const spent = Math.min(
      maximum,
      nonNegativeInteger(item?.system?.uses?.spent),
    );
    if (maximum <= 0 || quantity <= 0) return 0;
    return Math.max(0, quantity * maximum - spent);
  }
  if (kind === SPELL_COMPONENT_SOURCE.LOOSE) {
    return nonNegativeInteger(item?.system?.quantity);
  }
  return 0;
}

/**
 * Plan and append component changes to dnd5e's native activity-consumption
 * update bundle. Nothing is mutated when the combined inventory is short.
 */
export function applySpellComponentConsumption({
  activity,
  usageConfig = {},
  updates,
}) {
  const cost = spellComponentCost(activity, usageConfig);
  if (cost <= 0) {
    return { applies: false, ok: true, cost: 0, reason: "no-cost" };
  }

  const item = itemFromActivity(activity);
  const actor = item?.actor ?? activity?.actor;
  const sources = actorItems(actor)
    .map((source, index) => ({
      item: source,
      index,
      kind: spellComponentSourceKind(source),
    }))
    .filter((source) => source.kind)
    .sort((a, b) => sourceOrder(a) - sourceOrder(b));

  const safeUpdates = normalizeUpdates(updates);
  const states = sources.map((source) => {
    const before = availableSpellComponentUnits(source.item, source.kind);
    const projected = projectedSourceState(source, safeUpdates);
    return {
      ...source,
      before,
      projected,
      alreadyConsumed: Math.max(0, before - projected.available),
    };
  });
  const alreadyConsumed = Math.min(
    cost,
    states.reduce((total, state) => total + state.alreadyConsumed, 0),
  );
  const available = states.reduce(
    (total, state) => total + state.projected.available,
    0,
  );
  const stillOwed = cost - alreadyConsumed;

  if (available < stillOwed) {
    return {
      applies: true,
      ok: false,
      actor,
      item,
      cost,
      available: available + alreadyConsumed,
      missing: stillOwed - available,
      reason: "insufficient-components",
    };
  }

  let remaining = stillOwed;
  const operations = [];
  for (const state of states) {
    if (remaining <= 0 || state.projected.available <= 0) continue;
    const amount = Math.min(remaining, state.projected.available);
    operations.push({ ...state, amount });
    remaining -= amount;
  }

  for (const operation of operations) {
    appendSourceConsumption(safeUpdates, operation);
  }

  return {
    applies: true,
    ok: true,
    actor,
    item,
    cost,
    castLevel: cost,
    alreadyConsumed,
    operations,
    remaining: available - stillOwed,
  };
}

function appendSourceConsumption(updates, operation) {
  const { item, kind, projected, amount } = operation;
  const nextAvailable = projected.available - amount;

  if (kind === SPELL_COMPONENT_SOURCE.POUCH) {
    const maximum = projected.maximum;
    if (nextAvailable === 0 && item.system?.uses?.autoDestroy === true) {
      addDelete(updates, item.id);
      removeItemUpdate(updates, item.id);
      return;
    }

    const quantity = Math.max(1, Math.ceil(nextAvailable / maximum));
    const spent = Math.min(maximum, quantity * maximum - nextAvailable);
    mergeItemUpdate(updates, item.id, {
      "system.quantity": quantity,
      "system.uses.spent": spent,
    });
    return;
  }

  mergeItemUpdate(updates, item.id, {
    "system.quantity": nextAvailable,
  });
}

function projectedSourceState(source, updates) {
  const { item, kind } = source;
  if (updates.delete.includes(item.id)) {
    return { available: 0, maximum: pouchMaximum(item) };
  }

  const itemUpdate = updates.item.find((entry) => entry?._id === item.id);
  const quantity = nonNegativeInteger(
    readUpdateValue(itemUpdate, "system.quantity", item.system?.quantity),
  );

  if (kind === SPELL_COMPONENT_SOURCE.POUCH) {
    const maximum = pouchMaximum(item);
    const spent = Math.min(
      maximum,
      nonNegativeInteger(
        readUpdateValue(
          itemUpdate,
          "system.uses.spent",
          item.system?.uses?.spent,
        ),
      ),
    );
    return {
      available: Math.max(0, quantity * maximum - spent),
      maximum,
      quantity,
      spent,
    };
  }

  return { available: quantity, maximum: 0, quantity, spent: 0 };
}

function normalizeUpdates(updates) {
  if (!updates || typeof updates !== "object") {
    throw new TypeError("Spell component consumption requires update data.");
  }
  updates.item ??= [];
  updates.delete ??= [];
  return updates;
}

function mergeItemUpdate(updates, itemId, change) {
  let entry = updates.item.find((candidate) => candidate?._id === itemId);
  if (!entry) {
    entry = { _id: itemId };
    updates.item.push(entry);
  }
  Object.assign(entry, change);
}

function removeItemUpdate(updates, itemId) {
  updates.item = updates.item.filter((entry) => entry?._id !== itemId);
}

function addDelete(updates, itemId) {
  if (!updates.delete.includes(itemId)) updates.delete.push(itemId);
}

function readUpdateValue(update, keyPath, fallback) {
  if (!update || typeof update !== "object") return fallback;
  if (Object.hasOwn(update, keyPath)) return update[keyPath];
  let value = update;
  for (const key of keyPath.split(".")) {
    if (!value || typeof value !== "object" || !Object.hasOwn(value, key)) {
      return fallback;
    }
    value = value[key];
  }
  return value;
}

function sourceOrder(source) {
  const kindOrder = source.kind === SPELL_COMPONENT_SOURCE.POUCH ? 0 : 1;
  return kindOrder * 100_000 + source.index;
}

function actorItems(actor) {
  const items = actor?.items;
  if (!items) return [];
  if (Array.isArray(items)) return items;
  if (Array.isArray(items.contents)) return items.contents;
  if (typeof items.values === "function") return [...items.values()];
  if (typeof items[Symbol.iterator] === "function") return [...items];
  return [];
}

function itemFromActivity(activity) {
  return activity?.item ?? activity?.parent ?? null;
}

function isComponentExempt(item) {
  return readFlag(item, "spellComponentsExempt") === true;
}

function readFlag(item, key) {
  try {
    const value = item?.getFlag?.(MODULE_ID, key);
    if (value !== undefined) return value;
  } catch {
    // Raw flags remain usable in tests and imported documents.
  }
  return item?.flags?.[MODULE_ID]?.[key];
}

function pouchMaximum(item) {
  return nonNegativeInteger(item?.system?.uses?.max);
}

function numericScaling(value) {
  if (Number.isFinite(Number(value))) return nonNegativeInteger(value);
  if (value && typeof value === "object") {
    for (const candidate of [value.value, value.amount, value.level]) {
      if (Number.isFinite(Number(candidate))) {
        return nonNegativeInteger(candidate);
      }
    }
  }
  return null;
}

function nonNegativeInteger(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return 0;
  return Math.max(0, Math.trunc(number));
}

function normalizeIdentifier(value) {
  return String(value ?? "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}
