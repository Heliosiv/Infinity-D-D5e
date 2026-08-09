import {
  ensureCurrency,
  planCurrencyDeduction,
  readWalletStrict,
  updateCurrencyVerified,
  walletsEqual,
} from "../merchant/currency.js";
import {
  createActorItemVerified,
  deleteActorItemVerified,
  findActorItem,
  merchantItemId,
  updateActorItemQuantityVerified,
} from "../merchant/write-verification.js";

const MODULE_ID = "infinity-dnd5e";
const PACK = `Compendium.${MODULE_ID}.infinity-dnd5e-items.Item`;

export const AMMUNITION_RECIPES = Object.freeze({
  arrows: Object.freeze({
    id: "arrows",
    label: "Arrows",
    stackNameAliases: Object.freeze(["Arrow"]),
    uuid: `${PACK}.3c7JXOzsv55gqJS5`,
    itemId: "3c7JXOzsv55gqJS5",
    batchSize: 20,
    unitMarketCp: 5,
    toolKeys: Object.freeze(["woodcarver", "smith"]),
  }),
  bolts: Object.freeze({
    id: "bolts",
    label: "Crossbow Bolts",
    stackNameAliases: Object.freeze(["Crossbow Bolt"]),
    uuid: `${PACK}.SItCnYBqhzqBoaWG`,
    itemId: "SItCnYBqhzqBoaWG",
    batchSize: 20,
    unitMarketCp: 2,
    toolKeys: Object.freeze(["woodcarver", "smith"]),
  }),
  needles: Object.freeze({
    id: "needles",
    label: "Blowgun Needles",
    stackNameAliases: Object.freeze(["Blowgun Needle"]),
    uuid: `${PACK}.gBQ8xqTA5f8wP5iu`,
    itemId: "gBQ8xqTA5f8wP5iu",
    batchSize: 20,
    unitMarketCp: 2,
    toolKeys: Object.freeze(["smith", "tinker"]),
  }),
  "sling-bullets": Object.freeze({
    id: "sling-bullets",
    label: "Sling Bullets",
    stackNameAliases: Object.freeze(["Sling Bullet"]),
    uuid: `${PACK}.z9SbsMIBZzuhZOqT`,
    itemId: "z9SbsMIBZzuhZOqT",
    batchSize: 20,
    unitMarketCp: 0.2,
    toolKeys: Object.freeze(["smith", "tinker"]),
  }),
});

export const PICKPOCKET_CURATED_ITEMS = Object.freeze([
  Object.freeze({
    uuid: `${PACK}.kdkpSZMUHGXGM15H`,
    name: "Signet Ring",
    valueCp: 500,
  }),
  Object.freeze({
    uuid: `${PACK}.uuh4UH3Jx5CsFjdA`,
    name: "Perfume",
    valueCp: 500,
  }),
  Object.freeze({
    uuid: `${PACK}.3OXueEpvDDCVfGFA`,
    name: "Fine Clothes",
    valueCp: 1500,
  }),
  Object.freeze({
    uuid: `${PACK}.BYkgCthEmzwE1sN6`,
    name: "Silver Ring",
    valueCp: 3000,
  }),
]);

const TOOL_MATCHERS = Object.freeze({
  woodcarver: Object.freeze(["woodcarver's tools", "woodcarvers tools"]),
  smith: Object.freeze(["smith's tools", "smiths tools"]),
  tinker: Object.freeze(["tinker's tools", "tinkers tools"]),
  thieves: Object.freeze(["thieves' tools", "thieves tools"]),
  whetstone: Object.freeze(["whetstone"]),
});

function sourceOf(document) {
  return document?.toObject?.() ?? document ?? {};
}

export function collectionValues(collection) {
  if (!collection) return [];
  if (Array.isArray(collection.contents)) return collection.contents;
  if (Array.isArray(collection)) return collection;
  if (typeof collection.values === "function") return [...collection.values()];
  return Array.from(collection ?? []);
}

function quantityOf(item) {
  const quantity = Number(sourceOf(item).system?.quantity ?? 1);
  return Number.isInteger(quantity) && quantity >= 0 ? quantity : 0;
}

export function normalizeItemName(value) {
  return String(value ?? "")
    .trim()
    .toLowerCase()
    .replace(/[’]/g, "'")
    .replace(/[^a-z0-9']+/g, " ")
    .replace(/\s+/g, " ");
}

export function actorHasTool(actor, toolKey) {
  const names = TOOL_MATCHERS[String(toolKey ?? "")] ?? [];
  return collectionValues(actor?.items).some((item) => {
    if (quantityOf(item) < 1) return false;
    const name = normalizeItemName(sourceOf(item).name);
    return names.some((candidate) => name === normalizeItemName(candidate));
  });
}

export function actorHasAnyTool(actor, toolKeys) {
  return (Array.isArray(toolKeys) ? toolKeys : []).some((key) =>
    actorHasTool(actor, key),
  );
}

export function ammoCraftCostCp(recipeId, batches = 1) {
  const recipe = AMMUNITION_RECIPES[String(recipeId ?? "")];
  if (!recipe) return null;
  const count = Math.max(1, Math.floor(Number(batches) || 1));
  return Math.ceil((recipe.unitMarketCp * recipe.batchSize * count) / 2);
}

export function isStolenItem(item) {
  return Boolean(sourceOf(item).flags?.[MODULE_ID]?.stolen);
}

function propertySet(item) {
  const raw = sourceOf(item).system?.properties;
  if (raw instanceof Set) return raw;
  if (Array.isArray(raw)) return new Set(raw);
  if (raw && typeof raw === "object") {
    return new Set(
      Object.entries(raw)
        .filter(([, enabled]) => enabled === true)
        .map(([key]) => key),
    );
  }
  return new Set();
}

function isMagicalItem(item) {
  const data = sourceOf(item);
  const properties = propertySet(data);
  if (properties.has("mgc") || properties.has("magic")) return true;

  const magicalBonus = data.system?.magicalBonus;
  if (
    magicalBonus !== null &&
    magicalBonus !== undefined &&
    magicalBonus !== "" &&
    Number(magicalBonus) !== 0
  ) {
    return true;
  }

  const rarity = String(data.system?.rarity ?? "")
    .trim()
    .toLowerCase();
  return Boolean(
    rarity && rarity !== "common" && rarity !== "none" && rarity !== "mundane",
  );
}

export function stolenProvenance(item) {
  const provenance = sourceOf(item).flags?.[MODULE_ID]?.stolen;
  return provenance && typeof provenance === "object"
    ? { ...provenance }
    : null;
}

function stolenProvenanceMatches(left, right) {
  const actual = stolenProvenance(left);
  const expected = stolenProvenance(right);
  if (!actual || !expected) return false;
  return [
    "settlementId",
    "targetType",
    "sourceId",
    "merchantId",
    "operationId",
    "timestamp",
    "appraisedValueCp",
  ].every((key) => String(actual[key] ?? "") === String(expected[key] ?? ""));
}

export function markStolenSnapshot(
  item,
  {
    settlementId,
    targetType,
    sourceId = null,
    merchantId = null,
    operationId,
    timestamp,
    appraisedValueCp,
  } = {},
) {
  const snapshot = structuredCloneSafe(sourceOf(item));
  delete snapshot._id;
  delete snapshot.id;
  snapshot._id = merchantItemId(`${operationId}:stolen-item`);
  snapshot.system ??= {};
  snapshot.system.quantity = 1;
  snapshot.flags ??= {};
  snapshot.flags[MODULE_ID] ??= {};
  snapshot.flags[MODULE_ID].stolen = {
    settlementId: String(settlementId ?? ""),
    targetType: String(targetType ?? "generated"),
    sourceId: sourceId == null ? null : String(sourceId),
    merchantId: merchantId == null ? null : String(merchantId),
    operationId: String(operationId ?? ""),
    timestamp: Number(timestamp) || 0,
    appraisedValueCp: Math.max(0, Math.floor(Number(appraisedValueCp) || 0)),
  };
  return snapshot;
}

export function buildStolenCoinPurse({
  settlementId,
  sourceId,
  operationId,
  timestamp,
  valueCp,
} = {}) {
  const cp = Math.max(1, Math.floor(Number(valueCp) || 1));
  return markStolenSnapshot(
    {
      name: "Stolen Coin Purse",
      type: "loot",
      img: "icons/containers/bags/coinpouch-simple-leather-brown.webp",
      system: {
        quantity: 1,
        price: { value: cp, denomination: "cp" },
        type: { value: "treasure" },
        description: {
          value:
            "A purse taken during downtime. Ordinary merchants will not buy it; it must be fenced.",
          chat: "",
        },
      },
      flags: {},
    },
    {
      settlementId,
      targetType: "generated-mark",
      sourceId,
      operationId,
      timestamp,
      appraisedValueCp: cp,
    },
  );
}

export function stolenItemValueCp(item) {
  const provenance = stolenProvenance(item);
  const appraised = Number(provenance?.appraisedValueCp);
  if (Number.isSafeInteger(appraised) && appraised >= 0) return appraised;
  const price = sourceOf(item).system?.price ?? {};
  const value = Number(price.value);
  if (!Number.isFinite(value) || value <= 0) return 0;
  const denomination = String(price.denomination ?? "gp").toLowerCase();
  const multiplier = { pp: 1000, gp: 100, ep: 50, sp: 10, cp: 1 }[denomination];
  return multiplier ? Math.max(0, Math.round(value * multiplier)) : 0;
}

export function cleanAmmoStack(actor, recipeId) {
  const recipe = AMMUNITION_RECIPES[String(recipeId ?? "")];
  if (!recipe) return null;
  return (
    collectionValues(actor?.items).find((item) =>
      isCleanAmmoRecipeStack(item, recipe.id),
    ) ?? null
  );
}

/**
 * Whether one embedded Item is a clean, mundane stack of the exact recipe's
 * D&D5e ammunition. A canonical source ID, when present, wins over a mutable
 * display name; name aliases are only a fallback for unsourced world items.
 */
export function isCleanAmmoRecipeStack(item, recipeId) {
  const recipe = AMMUNITION_RECIPES[String(recipeId ?? "")];
  if (!recipe || !item || isStolenItem(item) || isMagicalItem(item)) {
    return false;
  }
  const data = sourceOf(item);
  if (String(data.type ?? "").toLowerCase() !== "consumable") return false;
  if (String(data.system?.type?.value ?? "").toLowerCase() !== "ammo") {
    return false;
  }
  const sourceId = String(
    data.flags?.core?.sourceId ?? data._stats?.compendiumSource ?? "",
  ).trim();
  if (sourceId) {
    return (
      sourceId === recipe.uuid ||
      sourceId.endsWith(`.Item.${String(recipe.itemId)}`)
    );
  }
  const stackNames = new Set(
    [recipe.label, ...(recipe.stackNameAliases ?? [])].map(normalizeItemName),
  );
  return stackNames.has(normalizeItemName(data.name));
}

/** Match the exact item identity a persisted craft operation may mutate. */
export function ammoCraftDeliveryItemMatches(item, operation) {
  const delivery = operation?.delivery ?? {};
  if (
    !item ||
    String(item?.id ?? item?._id ?? "").trim() !==
      String(delivery.itemId ?? "").trim() ||
    !isCleanAmmoRecipeStack(item, operation?.recipeId)
  ) {
    return false;
  }
  if (delivery.mode !== "create") return delivery.mode === "stack";
  const marker = sourceOf(item).flags?.[MODULE_ID]?.downtimeCraft;
  return Boolean(
    marker?.operationId === String(operation?.operationId ?? "").trim() &&
    marker?.recipeId === String(operation?.recipeId ?? ""),
  );
}

export function planWalletDeltaCp(wallet, deltaCp) {
  const read = readWalletStrict(wallet);
  if (!read.ok) return null;
  const delta = Math.trunc(Number(deltaCp));
  if (!Number.isSafeInteger(delta)) return null;
  if (delta < 0) return planCurrencyDeduction(read.wallet, -delta / 100);
  const after = { ...read.wallet };
  after.gp += Math.floor(delta / 100);
  after.sp += Math.floor((delta % 100) / 10);
  after.cp += delta % 10;
  return readWalletStrict(after).ok ? after : null;
}

export async function resolveItemSnapshot(uuid) {
  const id = String(uuid ?? "").trim();
  if (!id || typeof globalThis.fromUuid !== "function") return null;
  try {
    const item = await globalThis.fromUuid(id);
    return item ? structuredCloneSafe(sourceOf(item)) : null;
  } catch {
    return null;
  }
}

export async function buildAmmoCraftOperation({
  actor,
  recipeId,
  operationId,
  projectedWallet = null,
  projectedQuantity = null,
  projectedStackId = null,
} = {}) {
  const recipe = AMMUNITION_RECIPES[String(recipeId ?? "")];
  if (!recipe) return { ok: false, reason: "unknown-ammunition" };
  if (!actorHasAnyTool(actor, recipe.toolKeys)) {
    return { ok: false, reason: "missing-tool" };
  }
  const walletRead = readWalletStrict(
    projectedWallet ?? actor?.system?.currency,
  );
  if (!walletRead.ok) return { ok: false, reason: "invalid-wallet" };
  const costCp = ammoCraftCostCp(recipe.id);
  const walletAfter = planWalletDeltaCp(walletRead.wallet, -costCp);
  if (!walletAfter) return { ok: false, reason: "insufficient-funds" };
  const source = await resolveItemSnapshot(recipe.uuid);
  if (!source) return { ok: false, reason: "ammunition-unavailable" };

  const existing = projectedStackId
    ? findActorItem(actor, projectedStackId)
    : cleanAmmoStack(actor, recipe.id);
  const existingQty =
    projectedQuantity == null
      ? existing
        ? quantityOf(existing)
        : 0
      : Math.max(0, Math.floor(Number(projectedQuantity) || 0));
  const stackId =
    projectedStackId ||
    (existing
      ? String(existing.id ?? existing._id)
      : merchantItemId(operationId));
  const snapshot = structuredCloneSafe(source);
  delete snapshot.id;
  delete snapshot._id;
  snapshot._id = stackId;
  snapshot.system ??= {};
  snapshot.system.quantity = existingQty + recipe.batchSize;
  snapshot.flags ??= {};
  snapshot.flags.core ??= {};
  snapshot.flags.core.sourceId ??= recipe.uuid;
  snapshot.flags[MODULE_ID] ??= {};
  snapshot.flags[MODULE_ID].downtimeCraft = {
    operationId: String(operationId ?? ""),
    recipeId: recipe.id,
  };
  return {
    ok: true,
    operation: {
      kind: "craft-ammunition",
      operationId: String(operationId ?? ""),
      actorId: String(actor?.id ?? ""),
      recipeId: recipe.id,
      costCp,
      toolKeys: [...recipe.toolKeys],
      walletBefore: walletRead.wallet,
      walletAfter,
      delivery: {
        itemId: stackId,
        mode: existing || projectedStackId ? "stack" : "create",
        quantityBefore: existingQty,
        quantityAfter: existingQty + recipe.batchSize,
        snapshot,
      },
    },
  };
}

function deliveryState(actor, delivery) {
  const item = findActorItem(actor, delivery?.itemId);
  if (!item) return { item: null, quantity: 0 };
  return { item, quantity: quantityOf(item) };
}

async function deliverExact(actor, operation, { authorizeWrite = null } = {}) {
  const delivery = operation?.delivery ?? {};
  const state = deliveryState(actor, delivery);
  if (delivery.mode === "create") {
    if (state.item) {
      return ammoCraftDeliveryItemMatches(state.item, operation) &&
        state.quantity === delivery.quantityAfter
        ? { ok: true, alreadyApplied: true, item: state.item }
        : { ok: false, reason: "item-create-conflict" };
    }
    if (!writeAuthorized(authorizeWrite)) return authorityLostResult(true);
    const created = await createActorItemVerified(actor, delivery.snapshot, {
      expectedItemId: delivery.itemId,
      expectedQuantity: delivery.quantityAfter,
    });
    if (created.ok && !ammoCraftDeliveryItemMatches(created.item, operation)) {
      return { ok: false, reason: "item-create-conflict" };
    }
    return created;
  }
  if (!state.item) return { ok: false, reason: "item-missing" };
  if (!ammoCraftDeliveryItemMatches(state.item, operation)) {
    return { ok: false, reason: "item-identity-drift" };
  }
  if (state.quantity === delivery.quantityAfter) {
    return { ok: true, alreadyApplied: true, item: state.item };
  }
  if (state.quantity !== delivery.quantityBefore) {
    return { ok: false, reason: "item-quantity-drift" };
  }
  if (!writeAuthorized(authorizeWrite)) return authorityLostResult(true);
  const updated = await updateActorItemQuantityVerified(
    actor,
    state.item,
    delivery.quantityAfter,
    { expectedBeforeQuantity: delivery.quantityBefore },
  );
  if (
    updated.ok &&
    !ammoCraftDeliveryItemMatches(
      findActorItem(actor, delivery.itemId),
      operation,
    )
  ) {
    return { ok: false, reason: "item-identity-drift" };
  }
  return updated;
}

async function restoreDelivery(
  actor,
  operation,
  { authorizeWrite = null } = {},
) {
  const delivery = operation?.delivery ?? {};
  const state = deliveryState(actor, delivery);
  if (delivery.mode === "create") {
    if (!state.item) return { ok: true };
    if (!ammoCraftDeliveryItemMatches(state.item, operation)) {
      return { ok: false, reason: "item-create-conflict" };
    }
    if (!writeAuthorized(authorizeWrite)) return authorityLostResult(false);
    return deleteActorItemVerified(actor, delivery.itemId, {
      expectedBeforeQuantity: delivery.quantityAfter,
    });
  }
  if (!state.item) return { ok: false, reason: "item-missing" };
  if (!ammoCraftDeliveryItemMatches(state.item, operation)) {
    return { ok: false, reason: "item-identity-drift" };
  }
  if (state.quantity === delivery.quantityBefore) return { ok: true };
  if (!writeAuthorized(authorizeWrite)) return authorityLostResult(false);
  return updateActorItemQuantityVerified(
    actor,
    state.item,
    delivery.quantityBefore,
    { expectedBeforeQuantity: delivery.quantityAfter },
  );
}

function validateAmmoCraftPlan(actor, operation) {
  const recipe = AMMUNITION_RECIPES[String(operation?.recipeId ?? "")];
  const delivery = operation?.delivery ?? {};
  const operationId = String(operation?.operationId ?? "").trim();
  const snapshot = sourceOf(delivery.snapshot);
  const craftMarker = snapshot.flags?.[MODULE_ID]?.downtimeCraft;
  const beforeQuantity = Number(delivery.quantityBefore);
  const afterQuantity = Number(delivery.quantityAfter);
  const expectedWallet = planWalletDeltaCp(
    operation?.walletBefore,
    -ammoCraftCostCp(recipe?.id),
  );
  const canonicalTools = recipe?.toolKeys ?? [];
  const plannedTools = Array.isArray(operation?.toolKeys)
    ? operation.toolKeys.map(String)
    : [];
  const sourceId = String(snapshot.flags?.core?.sourceId ?? "");
  const canonicalSourceSuffix = `.Item.${String(recipe?.itemId ?? "")}`;
  return Boolean(
    recipe &&
    operation?.kind === "craft-ammunition" &&
    operationId &&
    String(operation?.actorId ?? "") === String(actor?.id ?? "") &&
    Number(operation?.costCp) === ammoCraftCostCp(recipe.id) &&
    JSON.stringify(plannedTools) === JSON.stringify(canonicalTools) &&
    ["create", "stack"].includes(delivery.mode) &&
    String(delivery.itemId ?? "") &&
    String(snapshot._id ?? snapshot.id ?? "") ===
      String(delivery.itemId ?? "") &&
    Number.isSafeInteger(beforeQuantity) &&
    beforeQuantity >= 0 &&
    Number.isSafeInteger(afterQuantity) &&
    afterQuantity === beforeQuantity + recipe.batchSize &&
    Number(snapshot.system?.quantity) === afterQuantity &&
    String(snapshot.type ?? "").toLowerCase() === "consumable" &&
    String(snapshot.system?.type?.value ?? "").toLowerCase() === "ammo" &&
    (sourceId === recipe.uuid || sourceId.endsWith(canonicalSourceSuffix)) &&
    craftMarker?.operationId === operationId &&
    craftMarker?.recipeId === recipe.id &&
    expectedWallet &&
    walletsEqual(expectedWallet, operation?.walletAfter),
  );
}

/** Apply a preplanned craft without recomputing cost, target, or quantity. */
export async function applyAmmoCraftOperation(
  actor,
  operation,
  { authorizeWrite = null } = {},
) {
  if (!writeAuthorized(authorizeWrite)) return authorityLostResult(true);
  if (!validateAmmoCraftPlan(actor, operation)) {
    return { ok: false, reason: "invalid-craft-plan", provenUnapplied: true };
  }
  const recipe = AMMUNITION_RECIPES[operation.recipeId];
  if (!actorHasAnyTool(actor, recipe.toolKeys)) {
    return { ok: false, reason: "missing-tool", provenUnapplied: true };
  }
  const walletRead = readWalletStrict(actor?.system?.currency);
  if (!walletRead.ok) return { ok: false, reason: "invalid-wallet" };
  const itemState = deliveryState(actor, operation?.delivery);
  const itemMatches = itemState.item
    ? ammoCraftDeliveryItemMatches(itemState.item, operation)
    : false;
  if (
    walletsEqual(walletRead.wallet, operation.walletAfter) &&
    itemMatches &&
    itemState.quantity === operation.delivery.quantityAfter
  ) {
    return { ok: true, alreadyApplied: true };
  }
  const itemBefore =
    operation.delivery.mode === "create"
      ? !itemState.item
      : itemMatches && itemState.quantity === operation.delivery.quantityBefore;
  if (!walletsEqual(walletRead.wallet, operation.walletBefore) || !itemBefore) {
    return { ok: false, reason: "state-drift", provenUnapplied: false };
  }
  if (!writeAuthorized(authorizeWrite)) return authorityLostResult(true);
  const paid = await updateCurrencyVerified(actor, operation.walletAfter, {
    authorizeWrite,
  });
  if (!paid.ok) {
    return {
      ok: false,
      reason: paid.reason,
      provenUnapplied: paid.provenUnapplied === true,
    };
  }
  const delivered = await deliverExact(actor, operation, {
    authorizeWrite,
  });
  if (delivered.ok) return { ok: true, alreadyApplied: false };
  if (!writeAuthorized(authorizeWrite)) return authorityLostResult(false);
  const itemRestored = await restoreDelivery(actor, operation, {
    authorizeWrite,
  });
  if (!writeAuthorized(authorizeWrite)) return authorityLostResult(false);
  const walletRestored = await ensureCurrency(actor, operation.walletBefore);
  return {
    ok: false,
    reason:
      itemRestored.ok && walletRestored.ok
        ? delivered.reason
        : "compensation-failed",
    provenUnapplied: itemRestored.ok && walletRestored.ok,
  };
}

/** Deliver one preplanned generated or merchant-stolen item. */
export async function applyStolenItemDelivery(
  actor,
  snapshot,
  { authorizeWrite = null } = {},
) {
  const itemId = String(snapshot?._id ?? "").trim();
  if (!itemId) return { ok: false, reason: "bad-item" };
  const existing = findActorItem(actor, itemId);
  if (existing) {
    return stolenProvenanceMatches(existing, snapshot)
      ? { ok: true, alreadyApplied: true, itemId }
      : { ok: false, reason: "item-create-conflict" };
  }
  if (!writeAuthorized(authorizeWrite)) return authorityLostResult(true);
  const created = await createActorItemVerified(actor, snapshot, {
    expectedItemId: itemId,
    expectedQuantity: 1,
  });
  if (created.ok && !stolenProvenanceMatches(created.item, snapshot)) {
    return {
      ok: false,
      reason: "stolen-delivery-unconfirmed",
      itemId,
      provenUnapplied: false,
    };
  }
  return { ...created, alreadyApplied: false };
}

export async function removeStolenItemDelivery(
  actor,
  snapshot,
  { authorizeWrite = null } = {},
) {
  const itemId = String(snapshot?._id ?? "").trim();
  const existing = findActorItem(actor, itemId);
  if (!existing) return { ok: true, alreadyRemoved: true };
  if (!stolenProvenanceMatches(existing, snapshot)) {
    return { ok: false, reason: "stolen-item-conflict" };
  }
  if (!writeAuthorized(authorizeWrite)) return authorityLostResult(true);
  return deleteActorItemVerified(actor, itemId, { expectedBeforeQuantity: 1 });
}

/** Remove an exact stolen bundle and apply its exact preplanned payout. */
export async function applyFenceOperation(
  actor,
  operation,
  { authorizeWrite = null } = {},
) {
  const snapshots = Array.isArray(operation?.itemSnapshots)
    ? operation.itemSnapshots
    : [];
  if (operation?.goodsTransferred !== true) {
    return { ok: true, retained: true, alreadyApplied: false };
  }
  if (
    !Number.isSafeInteger(Number(operation?.payoutCp)) ||
    operation.payoutCp <= 0
  ) {
    return { ok: false, reason: "invalid-fencing-payout" };
  }
  const itemIds = snapshots.map((snapshot) =>
    String(snapshot?._id ?? "").trim(),
  );
  if (
    itemIds.length === 0 ||
    itemIds.some((itemId) => !itemId) ||
    new Set(itemIds).size !== itemIds.length
  ) {
    return {
      ok: false,
      reason: "invalid-fencing-bundle",
      provenUnapplied: true,
    };
  }
  const expectedWalletAfter = planWalletDeltaCp(
    operation?.walletBefore,
    Number(operation.payoutCp),
  );
  if (
    !expectedWalletAfter ||
    !walletsEqual(expectedWalletAfter, operation?.walletAfter)
  ) {
    return {
      ok: false,
      reason: "invalid-fencing-wallet-plan",
      provenUnapplied: true,
    };
  }
  const walletRead = readWalletStrict(actor?.system?.currency);
  if (!walletRead.ok) return { ok: false, reason: "invalid-wallet" };
  const allAbsent = snapshots.every(
    (snapshot) => !findActorItem(actor, snapshot._id),
  );
  if (allAbsent && walletsEqual(walletRead.wallet, operation.walletAfter)) {
    return { ok: true, alreadyApplied: true };
  }
  if (!walletsEqual(walletRead.wallet, operation.walletBefore)) {
    return { ok: false, reason: "wallet-drift", provenUnapplied: false };
  }
  for (const snapshot of snapshots) {
    const item = findActorItem(actor, snapshot._id);
    if (
      !item ||
      !isStolenItem(item) ||
      !stolenProvenanceMatches(item, snapshot) ||
      quantityOf(item) !== 1
    ) {
      return {
        ok: false,
        reason: "stolen-bundle-drift",
        provenUnapplied: false,
      };
    }
  }
  if (!writeAuthorized(authorizeWrite)) return authorityLostResult(true);
  const removed = [];
  for (const snapshot of snapshots) {
    const result = await removeStolenItemDelivery(actor, snapshot, {
      authorizeWrite,
    });
    if (!result.ok) {
      if (!writeAuthorized(authorizeWrite)) return authorityLostResult(false);
      const restored = await restoreSnapshots(actor, removed, {
        authorizeWrite,
      });
      return {
        ok: false,
        reason: restored ? result.reason : "compensation-failed",
        provenUnapplied: restored,
      };
    }
    removed.push(snapshot);
  }
  if (!writeAuthorized(authorizeWrite)) return authorityLostResult(false);
  const paid = await updateCurrencyVerified(actor, operation.walletAfter, {
    authorizeWrite,
  });
  if (paid.ok) return { ok: true, alreadyApplied: false };
  if (!writeAuthorized(authorizeWrite)) return authorityLostResult(false);
  const restored = await restoreSnapshots(actor, removed, { authorizeWrite });
  if (!writeAuthorized(authorizeWrite)) return authorityLostResult(false);
  const walletRestored = await ensureCurrency(actor, operation.walletBefore);
  return {
    ok: false,
    reason: restored && walletRestored.ok ? paid.reason : "compensation-failed",
    provenUnapplied: restored && walletRestored.ok,
  };
}

async function restoreSnapshots(
  actor,
  snapshots,
  { authorizeWrite = null } = {},
) {
  for (const snapshot of snapshots) {
    if (findActorItem(actor, snapshot._id)) continue;
    if (!writeAuthorized(authorizeWrite)) return false;
    const restored = await createActorItemVerified(actor, snapshot, {
      expectedItemId: snapshot._id,
      expectedQuantity: 1,
    });
    if (!restored.ok) return false;
  }
  return true;
}

function writeAuthorized(authorizeWrite) {
  if (typeof authorizeWrite !== "function") return true;
  try {
    return authorizeWrite() === true;
  } catch {
    return false;
  }
}

function authorityLostResult(provenUnapplied) {
  return {
    ok: false,
    reason: "authority-lost",
    provenUnapplied: provenUnapplied === true,
  };
}

function structuredCloneSafe(value) {
  if (typeof globalThis.structuredClone === "function") {
    try {
      return globalThis.structuredClone(value);
    } catch {
      // Fall through to a JSON clone for plain Foundry source objects.
    }
  }
  return JSON.parse(JSON.stringify(value ?? {}));
}
