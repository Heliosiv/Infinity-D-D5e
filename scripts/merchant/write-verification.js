/**
 * Infinity D&D5e — Merchant Actor write verification
 *
 * Foundry document hooks may cancel or alter create, update, and delete
 * operations without throwing. Merchant transactions require a confirming
 * return value and canonical read-back before they advance.
 */

const MODULE_ID = "infinity-dnd5e";

function documentId(document) {
  if (typeof document === "string") return document.trim();
  return String(document?.id ?? document?._id ?? "").trim();
}

function itemSource(item) {
  return item?.toObject?.() ?? item ?? null;
}

function itemQuantity(item) {
  const raw = itemSource(item)?.system?.quantity;
  if (raw === null || raw === undefined || raw === "") return null;
  const quantity = Number(raw);
  return Number.isFinite(quantity) &&
    Number.isInteger(quantity) &&
    quantity >= 0
    ? quantity
    : null;
}

function actorItems(actor) {
  const collection = actor?.items;
  if (!collection) return [];
  if (Array.isArray(collection.contents)) return collection.contents;
  if (Array.isArray(collection)) return collection;
  if (typeof collection.values === "function") {
    return Array.from(collection.values());
  }
  if (typeof collection[Symbol.iterator] === "function") {
    return Array.from(collection);
  }
  return [];
}

function hasActorItemLookup(actor) {
  return Boolean(
    actor?.items &&
    (typeof actor.items.get === "function" ||
      Array.isArray(actor.items.contents) ||
      Array.isArray(actor.items) ||
      typeof actor.items.values === "function" ||
      typeof actor.items[Symbol.iterator] === "function"),
  );
}

function operationMarker(item) {
  return String(
    itemSource(item)?.flags?.[MODULE_ID]?.purchasedFromMerchant?.operationId ??
      itemSource(item)?.flags?.[MODULE_ID]?.stolen?.operationId ??
      itemSource(item)?.flags?.[MODULE_ID]?.downtimeCraft?.operationId ??
      "",
  ).trim();
}

const VOLATILE_ROOT_IDENTITY_FIELDS = new Set([
  "_id",
  "id",
  "sort",
  "folder",
  "ownership",
  "_stats",
]);

function stableIdentityValue(value, path = []) {
  if (Array.isArray(value)) {
    return value.map((entry, index) =>
      stableIdentityValue(entry, [...path, String(index)]),
    );
  }
  if (!value || typeof value !== "object") return value;
  const cleaned = {};
  for (const key of Object.keys(value).sort()) {
    if (path.length === 0 && VOLATILE_ROOT_IDENTITY_FIELDS.has(key)) continue;
    if (path.length === 1 && path[0] === "system" && key === "quantity") {
      continue;
    }
    cleaned[key] = stableIdentityValue(value[key], [...path, key]);
  }
  return cleaned;
}

function stableItemIdentity(item) {
  const source = itemSource(item);
  return source ? JSON.stringify(stableIdentityValue(source)) : "";
}

function itemIdentityMatches(actual, expected) {
  const actualSource = itemSource(actual);
  const expectedSource = itemSource(expected);
  if (!actualSource || !expectedSource) return false;
  if (String(actualSource.name ?? "") !== String(expectedSource.name ?? "")) {
    return false;
  }
  if (String(actualSource.type ?? "") !== String(expectedSource.type ?? "")) {
    return false;
  }
  const actualPrice = actualSource.system?.price ?? null;
  const expectedPrice = expectedSource.system?.price ?? null;
  if (JSON.stringify(actualPrice) !== JSON.stringify(expectedPrice)) {
    return false;
  }
  const expectedMarker = operationMarker(expectedSource);
  if (expectedMarker) {
    return operationMarker(actualSource) === expectedMarker;
  }
  return (
    stableItemIdentity(actualSource) === stableItemIdentity(expectedSource)
  );
}

function hashChunk(input, seed) {
  let hash = seed >>> 0;
  for (let index = 0; index < input.length; index++) {
    hash ^= input.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  hash ^= hash >>> 16;
  hash = Math.imul(hash, 0x7feb352d);
  hash ^= hash >>> 15;
  return (hash >>> 0).toString(36).padStart(7, "0");
}

/** Deterministic Foundry-compatible 16-character embedded Item id. */
export function merchantItemId(operationId) {
  const input = String(operationId ?? "").trim() || "local-merchant-write";
  return (
    hashChunk(input, 0x811c9dc5) +
    hashChunk(input, 0x9e3779b9) +
    hashChunk(input, 0x85ebca6b)
  )
    .replace(/[^a-z0-9]/gi, "")
    .slice(0, 16)
    .padEnd(16, "0");
}

export function findActorItem(actor, itemId) {
  const id = String(itemId ?? "").trim();
  if (!id || !hasActorItemLookup(actor)) return null;
  if (typeof actor.items.get === "function") {
    return actor.items.get(id) ?? null;
  }
  return actorItems(actor).find((item) => documentId(item) === id) ?? null;
}

function actorWriteAuthorized(authorizeWrite) {
  if (authorizeWrite == null) return true;
  if (typeof authorizeWrite !== "function") return false;
  try {
    return authorizeWrite() === true;
  } catch {
    return false;
  }
}

function actorItemAuthorityLostResult(
  actor,
  itemId,
  { expectedQuantity = null, provenUnapplied = false, error = null } = {},
) {
  const id = String(itemId ?? "").trim();
  const canonical = findActorItem(actor, id);
  return {
    ok: false,
    reason: "authority-lost",
    ...(error ? { error } : {}),
    itemId: id,
    itemIds: canonical ? [id] : [],
    expectedQuantity,
    actualQuantity: canonical ? itemQuantity(canonical) : null,
    provenUnapplied: provenUnapplied === true,
  };
}

/**
 * Create one exact embedded Item id and confirm its returned document,
 * identity, quantity, and canonical Actor collection state.
 */
export async function createActorItemVerified(
  actor,
  snapshot,
  {
    expectedQuantity = itemQuantity(snapshot),
    expectedItemId = documentId(snapshot),
    authorizeWrite = null,
  } = {},
) {
  const itemId = String(expectedItemId ?? "").trim();
  if (
    !itemId ||
    !actor ||
    typeof actor.createEmbeddedDocuments !== "function" ||
    !hasActorItemLookup(actor)
  ) {
    return { ok: false, reason: "create-unconfirmed", itemIds: [] };
  }
  if (findActorItem(actor, itemId)) {
    return {
      ok: false,
      reason: "create-conflict",
      itemId,
      itemIds: [],
      preexisting: true,
    };
  }

  let returned;
  let error = null;
  try {
    if (!actorWriteAuthorized(authorizeWrite)) {
      return actorItemAuthorityLostResult(actor, itemId, {
        expectedQuantity,
        provenUnapplied: true,
      });
    }
    returned = await actor.createEmbeddedDocuments("Item", [snapshot], {
      keepId: true,
      keepEmbeddedIds: true,
    });
    if (!actorWriteAuthorized(authorizeWrite)) {
      return actorItemAuthorityLostResult(actor, itemId, {
        expectedQuantity,
      });
    }
  } catch (caught) {
    if (!actorWriteAuthorized(authorizeWrite)) {
      return actorItemAuthorityLostResult(actor, itemId, {
        expectedQuantity,
        error: caught,
      });
    }
    error = caught;
  }

  const returnedDocs = Array.isArray(returned) ? returned : [];
  const returnedIds = returnedDocs.map(documentId).filter(Boolean);
  const canonical = findActorItem(actor, itemId);
  const quantityMatches =
    expectedQuantity === null ||
    itemQuantity(canonical) ===
      Math.max(0, Math.floor(Number(expectedQuantity) || 0));
  const returnConfirmed =
    returnedDocs.length === 1 && returnedIds[0] === itemId;
  const canonicalConfirmed =
    Boolean(canonical) &&
    itemIdentityMatches(canonical, snapshot) &&
    quantityMatches;
  const ok = !error && returnConfirmed && canonicalConfirmed;

  return {
    ok,
    reason: ok ? "" : error ? "create-failed" : "create-unconfirmed",
    error,
    item: ok ? canonical : null,
    itemId: ok ? itemId : null,
    itemIds: canonical ? [itemId] : [],
    expectedQuantity,
    actualQuantity: canonical ? itemQuantity(canonical) : null,
    returnConfirmed,
    canonicalConfirmed,
  };
}

/** Delete one exact embedded Item and confirm canonical absence. */
export async function deleteActorItemVerified(
  actor,
  itemId,
  { expectedBeforeQuantity = null, authorizeWrite = null } = {},
) {
  const id = String(itemId ?? "").trim();
  const before = findActorItem(actor, id);
  if (
    !id ||
    !before ||
    !actor ||
    typeof actor.deleteEmbeddedDocuments !== "function" ||
    !hasActorItemLookup(actor)
  ) {
    return { ok: false, reason: "delete-unconfirmed", itemId: id };
  }
  if (
    expectedBeforeQuantity !== null &&
    itemQuantity(before) !==
      Math.max(0, Math.floor(Number(expectedBeforeQuantity) || 0))
  ) {
    return {
      ok: false,
      reason: "delete-precondition-failed",
      itemId: id,
      actualQuantity: itemQuantity(before),
    };
  }

  let returned;
  let error = null;
  try {
    if (!actorWriteAuthorized(authorizeWrite)) {
      return actorItemAuthorityLostResult(actor, id, {
        expectedQuantity: expectedBeforeQuantity,
        provenUnapplied: true,
      });
    }
    returned = await actor.deleteEmbeddedDocuments("Item", [id]);
    if (!actorWriteAuthorized(authorizeWrite)) {
      return actorItemAuthorityLostResult(actor, id, {
        expectedQuantity: expectedBeforeQuantity,
      });
    }
  } catch (caught) {
    if (!actorWriteAuthorized(authorizeWrite)) {
      return actorItemAuthorityLostResult(actor, id, {
        expectedQuantity: expectedBeforeQuantity,
        error: caught,
      });
    }
    error = caught;
  }
  const confirmedIds = (Array.isArray(returned) ? returned : [])
    .map(documentId)
    .filter(Boolean);
  const stillPresent = Boolean(findActorItem(actor, id));
  const returnConfirmed = confirmedIds.includes(id);
  const canonicalConfirmed = !stillPresent;
  const ok = !error && returnConfirmed && canonicalConfirmed;
  return {
    ok,
    reason: ok ? "" : error ? "delete-failed" : "delete-unconfirmed",
    error,
    itemId: id,
    confirmedIds,
    stillPresent,
    returnConfirmed,
    canonicalConfirmed,
  };
}

/** Update the canonical embedded Item to one exact quantity. */
export async function updateActorItemQuantityVerified(
  actor,
  item,
  quantity,
  { expectedBeforeQuantity = null, authorizeWrite = null } = {},
) {
  const itemId = documentId(item);
  const expectedQuantity = Math.max(0, Math.floor(Number(quantity) || 0));
  const canonicalBefore = findActorItem(actor, itemId);
  if (
    !itemId ||
    !canonicalBefore ||
    typeof canonicalBefore.update !== "function" ||
    !hasActorItemLookup(actor)
  ) {
    return {
      ok: false,
      reason: "quantity-unconfirmed",
      itemId,
      expectedQuantity,
    };
  }
  if (
    expectedBeforeQuantity !== null &&
    itemQuantity(canonicalBefore) !==
      Math.max(0, Math.floor(Number(expectedBeforeQuantity) || 0))
  ) {
    return {
      ok: false,
      reason: "quantity-precondition-failed",
      itemId,
      expectedQuantity,
      actualQuantity: itemQuantity(canonicalBefore),
    };
  }

  let returned;
  let error = null;
  try {
    if (!actorWriteAuthorized(authorizeWrite)) {
      return actorItemAuthorityLostResult(actor, itemId, {
        expectedQuantity,
        provenUnapplied: true,
      });
    }
    returned = await canonicalBefore.update({
      "system.quantity": expectedQuantity,
    });
    if (!actorWriteAuthorized(authorizeWrite)) {
      return actorItemAuthorityLostResult(actor, itemId, {
        expectedQuantity,
      });
    }
  } catch (caught) {
    if (!actorWriteAuthorized(authorizeWrite)) {
      return actorItemAuthorityLostResult(actor, itemId, {
        expectedQuantity,
        error: caught,
      });
    }
    error = caught;
  }
  const canonical = findActorItem(actor, itemId);
  const actualQuantity = itemQuantity(canonical);
  const returnConfirmed = documentId(returned) === itemId;
  const canonicalConfirmed =
    Boolean(canonical) && actualQuantity === expectedQuantity;
  const ok = !error && returnConfirmed && canonicalConfirmed;
  return {
    ok,
    reason: ok ? "" : error ? "quantity-failed" : "quantity-unconfirmed",
    error,
    itemId,
    expectedQuantity,
    actualQuantity,
    returnConfirmed,
    canonicalConfirmed,
  };
}

/** Compensation helper: make exact item ids canonically absent. */
export async function ensureActorItemsAbsent(actor, itemIds) {
  const ids = [...new Set((Array.isArray(itemIds) ? itemIds : []).map(String))]
    .map((id) => id.trim())
    .filter(Boolean);
  if (!hasActorItemLookup(actor)) {
    return { ok: false, reason: "delete-unconfirmed", remainingIds: ids };
  }
  const present = ids.filter((id) => findActorItem(actor, id));
  let error = null;
  if (present.length > 0) {
    if (typeof actor?.deleteEmbeddedDocuments !== "function") {
      return {
        ok: false,
        reason: "delete-unconfirmed",
        remainingIds: present,
      };
    }
    try {
      await actor.deleteEmbeddedDocuments("Item", present);
    } catch (caught) {
      error = caught;
    }
  }
  const remainingIds = ids.filter((id) => findActorItem(actor, id));
  return {
    ok: remainingIds.length === 0,
    reason: remainingIds.length === 0 ? "" : "delete-unconfirmed",
    error,
    remainingIds,
  };
}

/**
 * Compensation helper for a known item identity. An absent id is success; a
 * different item occupying the id is a conflict and is never deleted.
 */
export async function ensureActorItemAbsent(
  actor,
  itemId,
  { expectedIdentity = null } = {},
) {
  const id = String(itemId ?? "").trim();
  const existing = findActorItem(actor, id);
  if (!existing) {
    return { ok: true, reason: "", remainingIds: [] };
  }
  if (expectedIdentity && !itemIdentityMatches(existing, expectedIdentity)) {
    return {
      ok: false,
      reason: "delete-conflict",
      itemId: id,
      remainingIds: [id],
    };
  }
  return ensureActorItemsAbsent(actor, [id]);
}

/** Compensation helper: restore one canonical item stack quantity. */
export async function ensureActorItemQuantity(
  actor,
  itemId,
  expectedQuantity,
  { expectedIdentity = null } = {},
) {
  const id = String(itemId ?? "").trim();
  const expected = Math.max(0, Math.floor(Number(expectedQuantity) || 0));
  let item = findActorItem(actor, id);
  if (
    !id ||
    !item ||
    (expectedIdentity && !itemIdentityMatches(item, expectedIdentity))
  ) {
    return {
      ok: false,
      reason: "quantity-unconfirmed",
      itemId: id,
      expectedQuantity: expected,
      actualQuantity: itemQuantity(item),
    };
  }
  if (itemQuantity(item) === expected) {
    return {
      ok: true,
      reason: "",
      itemId: id,
      expectedQuantity: expected,
      actualQuantity: expected,
    };
  }
  let error = null;
  try {
    await item.update({ "system.quantity": expected });
  } catch (caught) {
    error = caught;
  }
  item = findActorItem(actor, id);
  const actualQuantity = itemQuantity(item);
  const identityMatches =
    !expectedIdentity || itemIdentityMatches(item, expectedIdentity);
  return {
    ok: actualQuantity === expected && identityMatches,
    reason:
      actualQuantity === expected && identityMatches
        ? ""
        : "quantity-unconfirmed",
    error,
    itemId: id,
    expectedQuantity: expected,
    actualQuantity,
  };
}

/**
 * Compensation helper: make one exact embedded Item canonically present.
 *
 * Unlike a primary write, compensation accepts a correct canonical read-back
 * even when the create/update API return was cancelled or lost. Its contract is
 * the final state, and it never mutates a different item occupying the id.
 */
export async function ensureActorItemPresent(
  actor,
  snapshot,
  {
    expectedItemId = documentId(snapshot),
    expectedQuantity = itemQuantity(snapshot),
  } = {},
) {
  const itemId = String(expectedItemId ?? "").trim();
  if (!itemId || !snapshot || !hasActorItemLookup(actor)) {
    return {
      ok: false,
      reason: "create-unconfirmed",
      itemId,
    };
  }

  let existing = findActorItem(actor, itemId);
  if (existing && !itemIdentityMatches(existing, snapshot)) {
    return {
      ok: false,
      reason: "create-conflict",
      itemId,
      preexisting: true,
    };
  }
  if (!existing) {
    await createActorItemVerified(actor, snapshot, {
      expectedItemId: itemId,
      expectedQuantity,
    });
    existing = findActorItem(actor, itemId);
  }
  if (!existing || !itemIdentityMatches(existing, snapshot)) {
    return {
      ok: false,
      reason: existing ? "create-conflict" : "create-unconfirmed",
      itemId,
    };
  }
  if (expectedQuantity !== null) {
    const quantity = await ensureActorItemQuantity(
      actor,
      itemId,
      expectedQuantity,
      { expectedIdentity: snapshot },
    );
    return {
      ...quantity,
      reason: quantity.ok ? "" : quantity.reason,
    };
  }
  return { ok: true, reason: "", itemId, item: existing };
}
