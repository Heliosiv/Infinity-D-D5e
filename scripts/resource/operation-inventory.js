/**
 * Infinity D&D5e - durable Quartermaster inventory planning/execution
 *
 * Planning works only with plain snapshots. It resolves every create template,
 * reserves every embedded Item id, and returns one globally ordered ledger plan
 * before callers persist or apply anything. Execution touches exactly one
 * persisted boundary and always classifies canonical state through the durable
 * operation ledger.
 */

import {
  matchResourceItems,
  planConsumption,
  planDeposit,
} from "./consumption.js";
import { planForageDriveDeposits } from "./forage.js";
import {
  classifyResourceInventoryOperation,
  createResourceInventoryOperation,
  normalizeResourceOperation,
} from "./operation-ledger.js";

const MODULE_ID = "infinity-dnd5e";
const EMBEDDED_ID_LENGTH = 16;
const ID_ALPHABET =
  "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";

export class ResourceOperationInventoryError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "ResourceOperationInventoryError";
    this.code = code;
  }
}

/**
 * Build the exact global Item write order for one Resource operation.
 *
 * `roster` rows are immutable snapshots shaped as
 * `{actorId,name,isStash,consumes,drawFromId,items}`. `forage`, when present,
 * uses the existing forage planner's selectedIds/foraged/forageTargets shape.
 * The returned operations are ready for `transitionResourceOperation(...,
 * "planned")`; all async template work is already complete.
 */
export async function buildResourceInventoryPlan({
  runId,
  roster = [],
  resources = [],
  days = 1,
  halfRations = false,
  waterEnabled = true,
  partyStashId = "",
  forage = null,
  includeConsumption = true,
  templatesByResourceId = null,
  resolveTemplate = null,
} = {}) {
  const normalizedRunId = requiredId(runId, "runId");
  const normalizedResources = normalizeResources(resources);
  const actors = normalizeRoster(roster, partyStashId);
  const actorById = new Map(actors.map((actor) => [actor.actorId, actor]));
  const templateCache = new Map();
  const operations = [];
  const targetResource = new Map();

  const append = (input) => {
    const target = JSON.stringify([input.actorId, input.itemId]);
    const priorResource = targetResource.get(target);
    if (priorResource && priorResource !== input.resourceId) {
      throw new ResourceOperationInventoryError(
        "RESOURCE_INVENTORY_AMBIGUOUS_ITEM",
        `Item ${input.itemId} on Actor ${input.actorId} was planned for both ${priorResource} and ${input.resourceId}`,
      );
    }
    targetResource.set(target, input.resourceId);
    const operation = createResourceInventoryOperation({
      runId: normalizedRunId,
      sequence: operations.length,
      ...input,
    });
    operations.push(operation);
    applyVirtualOperation(actorById.get(operation.actorId), operation);
    return operation;
  };

  const resolveCreateTemplate = async (resource) => {
    if (!templateCache.has(resource.id)) {
      templateCache.set(
        resource.id,
        Promise.resolve(
          collectionValue(templatesByResourceId, resource.id) ??
            (typeof resolveTemplate === "function"
              ? resolveTemplate(resource)
              : null),
        ).then(
          (value) =>
            cloneItemSnapshot(documentSnapshot(value)) ??
            defaultResourceTemplate(resource),
        ),
      );
    }
    return cloneItemSnapshot(await templateCache.get(resource.id));
  };

  const appendDeposit = async (actorId, resource, amount) => {
    const actor = requiredActor(actorById, actorId);
    const effective = withEffectiveResourceTag(resource);
    const quantity = wholeAmount(amount);
    if (quantity <= 0) return;

    const matches = matchResourceItems(actor.items, effective);
    let deposit = planDeposit({ matches, amount: quantity });
    if (deposit.op === "none") {
      deposit = planDeposit({
        matches,
        amount: quantity,
        templateItem: await resolveCreateTemplate(resource),
      });
    }

    if (deposit.op === "bump") {
      const before = quantityForMatch(matches, deposit.id);
      append({
        action: "update",
        actorId: actor.actorId,
        itemId: deposit.id,
        resourceId: resource.id,
        beforeQuantity: before,
        afterQuantity: wholeAmount(deposit.to),
        itemSnapshot: null,
      });
      return;
    }
    if (deposit.op !== "create") {
      throw new ResourceOperationInventoryError(
        "RESOURCE_INVENTORY_TEMPLATE_UNAVAILABLE",
        `No safe create template was available for Resource ${resource.id}`,
      );
    }

    const itemId = reserveDeterministicItemId({
      runId: normalizedRunId,
      actor,
      resourceId: resource.id,
      sequence: operations.length,
    });
    const itemSnapshot = buildCreatedResourceSnapshot({
      template: deposit.from,
      resource,
      quantity: deposit.quantity,
      itemId,
    });
    append({
      action: "create",
      actorId: actor.actorId,
      itemId,
      resourceId: resource.id,
      beforeQuantity: 0,
      afterQuantity: wholeAmount(deposit.quantity),
      itemSnapshot,
    });
  };

  let foragePlan = null;
  if (forage && typeof forage === "object") {
    const foodResource = normalizedResources.find(
      (resource) => resource.forageYields === "food",
    );
    const waterResource = normalizedResources.find(
      (resource) => resource.forageYields === "water",
    );
    foragePlan = planForageDriveDeposits({
      roster: actors.map(rosterPlannerSnapshot),
      selectedIds:
        forage.selectedIds ??
        (Array.isArray(forage.foraged)
          ? forage.foraged.map((entry) => entry?.actorId)
          : []),
      foraged: forage.foraged ?? [],
      forageTargets: forage.forageTargets ?? {},
      partyStashId: forage.partyStashId ?? partyStashId,
      foodEnabled: forage.foodEnabled !== false && Boolean(foodResource),
      waterEnabled:
        forage.waterEnabled !== false &&
        waterEnabled !== false &&
        Boolean(waterResource),
    });

    // Existing Resource semantics are deposit-major. Within each destination,
    // configured Resource order replaces the old hard-coded food/water order.
    for (const deposit of foragePlan.deposits) {
      for (const resource of normalizedResources) {
        if (resource !== foodResource && resource !== waterResource) continue;
        const channel = resource.forageYields;
        await appendDeposit(deposit.actorId, resource, deposit[channel]);
      }
    }
  }

  const accounting = createAccounting(actors);
  if (includeConsumption !== false) {
    planConsumptionOperations({
      actors,
      actorById,
      resources: normalizedResources,
      days,
      halfRations,
      waterEnabled,
      accounting,
      append,
    });
    addLegacyAccountingAliases(accounting, normalizedResources);
  }

  return deepFreeze({
    operations: [...operations],
    forage: foragePlan,
    accounting,
  });
}

/** A stable, Foundry-compatible 16-character embedded Item id. */
export function buildDeterministicResourceItemId({
  runId,
  actorId,
  resourceId,
  sequence,
  attempt = 0,
} = {}) {
  const seed = JSON.stringify([
    "resource-created-item-v1",
    requiredId(runId, "runId"),
    requiredId(actorId, "actorId"),
    requiredId(resourceId, "resourceId"),
    safeIndex(sequence, "sequence"),
    safeIndex(attempt, "attempt"),
  ]);
  const words = hashWords(seed);
  let state = words[0] ^ words[1] ^ words[2] ^ words[3];
  let id = "";
  for (let index = 0; index < EMBEDDED_ID_LENGTH; index += 1) {
    state = xorshift32(state + words[index % words.length] + index);
    id += ID_ALPHABET[state % ID_ALPHABET.length];
  }
  return id;
}

/** Read one exact persisted boundary from canonical Actor Item state. */
export function observeResourceInventoryOperation(
  operation,
  { actors, resources } = {},
) {
  if (!operation || typeof operation !== "object") {
    throw new ResourceOperationInventoryError(
      "RESOURCE_INVENTORY_OPERATION_REQUIRED",
      "A persisted inventory operation is required",
    );
  }
  const actor = collectionValue(actors, operation.actorId);
  if (!actor) {
    throw new ResourceOperationInventoryError(
      "RESOURCE_INVENTORY_ACTOR_MISSING",
      `Actor ${operation.actorId} is unavailable for canonical observation`,
    );
  }
  const resource = collectionValue(resources, operation.resourceId);
  if (!resource) {
    throw new ResourceOperationInventoryError(
      "RESOURCE_INVENTORY_RESOURCE_MISSING",
      `Resource ${operation.resourceId} is unavailable for canonical observation`,
    );
  }
  const item = findActorItem(actor, operation.itemId);
  if (!item) {
    return { exists: false, quantity: null, matchesResource: null };
  }
  const snapshot = documentSnapshot(item);
  const itemId = documentId(item);
  return {
    exists: true,
    quantity: documentQuantity(item),
    matchesResource:
      itemId === operation.itemId &&
      matchResourceItems([snapshot], withEffectiveResourceTag(resource)).some(
        (match) => match.id === operation.itemId,
      ),
  };
}

/**
 * Reconcile and, only from the exact before-state, apply one Item operation.
 *
 * The authority callback is awaited immediately before the single Foundry
 * write. A canonical readback follows even when Foundry throws, which turns an
 * applied-then-threw crash into `mark-applied` instead of a duplicate write.
 */
export async function executeResourceInventoryOperation({
  record,
  operationId = null,
  guard,
  actors,
  resources,
  assertWriteAllowed,
} = {}) {
  const current = normalizeResourceOperation(record);
  const operation = operationId
    ? current.plan.find((entry) => entry.opId === operationId)
    : current.plan[current.appliedOperationIds.length];
  if (!operation) {
    throw new ResourceOperationInventoryError(
      "RESOURCE_INVENTORY_OPERATION_MISSING",
      "The requested inventory operation does not belong to this record",
    );
  }

  if (current.appliedOperationIds.includes(operation.opId)) {
    return deepFreeze({
      action: "already-applied",
      reason: "durable-marker-present",
      operationId: operation.opId,
      operation,
      before: null,
      after: null,
      writeAttempted: false,
      writeError: null,
    });
  }

  const before = observeResourceInventoryOperation(operation, {
    actors,
    resources,
  });
  const classification = classifyResourceInventoryOperation(
    current,
    operation.opId,
    before,
    { guard },
  );
  if (classification.action !== "apply") {
    return executionResult({
      classification,
      operation,
      before,
      after: before,
      writeAttempted: false,
      writeError: null,
    });
  }
  if (typeof assertWriteAllowed !== "function") {
    throw new ResourceOperationInventoryError(
      "RESOURCE_INVENTORY_AUTHORITY_REQUIRED",
      "An authority callback is required immediately before an inventory write",
    );
  }

  const actor = collectionValue(actors, operation.actorId);
  assertActorWriteMethod(actor, operation.action);
  await assertWriteAllowed({ record: current, guard, operation });

  let writeError = null;
  try {
    await applyOneFoundryWrite(actor, operation);
  } catch (error) {
    writeError = error;
  }

  const after = observeResourceInventoryOperation(operation, {
    actors,
    resources,
  });
  const afterClassification = classifyResourceInventoryOperation(
    current,
    operation.opId,
    after,
    { guard },
  );
  return executionResult({
    classification: afterClassification,
    operation,
    before,
    after,
    writeAttempted: true,
    writeError,
  });
}

function planConsumptionOperations({
  actors,
  actorById,
  resources,
  days,
  halfRations,
  waterEnabled,
  accounting,
  append,
}) {
  const consumers = actors.filter((actor) => actor.consumes !== false);
  const elapsedDays = Math.max(1, Math.floor(Number(days) || 1));

  for (const resource of resources) {
    if (
      waterEnabled === false &&
      (resource.id === "water" || resource.forageYields === "water")
    ) {
      continue;
    }
    const base = Math.max(0, Number(resource.perDay) * elapsedDays || 0);
    const isFood = resource.id === "food" || resource.forageYields === "food";
    const amount =
      isFood && halfRations ? Math.ceil(base / 2) : Math.round(base);
    if (amount <= 0) continue;

    if (resource.scope === "party") {
      let remaining = amount;
      for (const actor of stashFirstActors(actors)) {
        if (remaining <= 0) break;
        const result = appendActorConsumption(
          actor,
          resource,
          remaining,
          append,
        );
        remaining = result.shortfall;
      }
      accounting.party[resource.id] = {
        consumed: amount - remaining,
        shortfall: remaining,
        error: "",
      };
      continue;
    }

    for (const consumer of consumers) {
      const source =
        actorById.get(consumer.drawFromId) ??
        actorById.get(consumer.actorId) ??
        consumer;
      const result = appendActorConsumption(source, resource, amount, append);
      const row = accounting.perActor.find(
        (entry) => entry.actorId === consumer.actorId,
      );
      recordAccounting(row, resource, result);
    }
  }
}

function appendActorConsumption(actor, resource, amount, append) {
  const effective = withEffectiveResourceTag(resource);
  const matches = matchResourceItems(actor.items, effective);
  const plan = planConsumption({ matches, amount });
  for (const step of plan.ops) {
    const before = quantityForMatch(matches, step.id);
    append({
      action: step.op === "delete" ? "delete" : "update",
      actorId: actor.actorId,
      itemId: step.id,
      resourceId: resource.id,
      beforeQuantity: before,
      afterQuantity: step.op === "delete" ? 0 : wholeAmount(step.to),
      itemSnapshot: null,
    });
  }
  return {
    consumed: wholeAmount(plan.consumed),
    shortfall: wholeAmount(plan.shortfall),
  };
}

function recordAccounting(row, resource, result) {
  row.consumed[resource.id] = result.consumed;
  row.shortfalls[resource.id] = result.shortfall;
  if (resource.id === "food" || resource.forageYields === "food") {
    row.canonicalConsumed.food += result.consumed;
    row.canonicalShortfalls.food += result.shortfall;
  }
  if (resource.id === "water" || resource.forageYields === "water") {
    row.canonicalConsumed.water += result.consumed;
    row.canonicalShortfalls.water += result.shortfall;
  }
}

function addLegacyAccountingAliases(accounting, resources) {
  const ids = new Set(resources.map((resource) => resource.id));
  for (const row of accounting.perActor) {
    if (!ids.has("food")) {
      row.consumed.food = row.canonicalConsumed.food;
      row.shortfalls.food = row.canonicalShortfalls.food;
    }
    if (!ids.has("water")) {
      row.consumed.water = row.canonicalConsumed.water;
      row.shortfalls.water = row.canonicalShortfalls.water;
    }
  }
}

function createAccounting(actors) {
  return {
    perActor: actors
      .filter((actor) => actor.consumes !== false)
      .map((actor) => ({
        actorId: actor.actorId,
        name: actor.name,
        consumed: {},
        shortfalls: {},
        canonicalConsumed: { food: 0, water: 0 },
        canonicalShortfalls: { food: 0, water: 0 },
        errors: [],
      })),
    party: {},
  };
}

function normalizeResources(resources) {
  const list = Array.isArray(resources) ? resources : [];
  const seen = new Set();
  return list.map((resource, index) => {
    const snapshot = cloneItemSnapshot(resource);
    const id = requiredId(snapshot?.id, `resources[${index}].id`);
    if (seen.has(id)) {
      throw new ResourceOperationInventoryError(
        "RESOURCE_INVENTORY_DUPLICATE_RESOURCE",
        `Duplicate Resource id ${id}`,
      );
    }
    seen.add(id);
    return { ...snapshot, id };
  });
}

function normalizeRoster(roster, partyStashId) {
  const list = Array.isArray(roster) ? roster : [];
  const seen = new Set();
  const actors = list.map((entry, index) => {
    const actorId = requiredId(
      entry?.actorId ?? entry?.id,
      `roster[${index}].actorId`,
    );
    if (seen.has(actorId)) {
      throw new ResourceOperationInventoryError(
        "RESOURCE_INVENTORY_DUPLICATE_ACTOR",
        `Duplicate Actor id ${actorId}`,
      );
    }
    seen.add(actorId);
    const items = (Array.isArray(entry?.items) ? entry.items : [])
      .map((item) => cloneItemSnapshot(documentSnapshot(item)))
      .filter(Boolean);
    return {
      actorId,
      name: String(entry?.name ?? actorId),
      isStash: entry?.isStash === true,
      consumes: entry?.consumes !== false,
      drawFromId: String(entry?.drawFromId ?? actorId).trim() || actorId,
      items,
    };
  });
  const ids = new Set(actors.map((actor) => actor.actorId));
  const globalStash = String(partyStashId ?? "").trim();
  for (const actor of actors) {
    if (!ids.has(actor.drawFromId)) actor.drawFromId = actor.actorId;
    if (globalStash && ids.has(globalStash)) {
      actor.drawFromId = globalStash;
      if (actor.actorId === globalStash) actor.isStash = true;
    }
  }
  return actors;
}

function rosterPlannerSnapshot(actor) {
  return {
    actorId: actor.actorId,
    name: actor.name,
    isStash: actor.isStash,
    consumes: actor.consumes,
    drawFromId: actor.drawFromId,
  };
}

function stashFirstActors(actors) {
  const seen = new Set();
  const ordered = [];
  for (const actor of actors) {
    if (actor.isStash && !seen.has(actor.actorId)) {
      seen.add(actor.actorId);
      ordered.push(actor);
    }
  }
  for (const actor of actors) {
    if (!seen.has(actor.actorId)) {
      seen.add(actor.actorId);
      ordered.push(actor);
    }
  }
  return ordered;
}

function applyVirtualOperation(actor, operation) {
  if (!actor) {
    throw new ResourceOperationInventoryError(
      "RESOURCE_INVENTORY_ACTOR_MISSING",
      `Actor ${operation.actorId} disappeared during planning`,
    );
  }
  const index = actor.items.findIndex(
    (item) => documentId(item) === operation.itemId,
  );
  if (operation.action === "create") {
    if (index >= 0) {
      throw new ResourceOperationInventoryError(
        "RESOURCE_INVENTORY_ID_COLLISION",
        `Created Item id ${operation.itemId} is already present`,
      );
    }
    actor.items.push(cloneItemSnapshot(operation.itemSnapshot));
    return;
  }
  if (index < 0) {
    throw new ResourceOperationInventoryError(
      "RESOURCE_INVENTORY_ITEM_MISSING",
      `Item ${operation.itemId} disappeared during planning`,
    );
  }
  if (operation.action === "delete") {
    actor.items.splice(index, 1);
    return;
  }
  const updated = cloneItemSnapshot(actor.items[index]);
  updated.system = plainObject(updated.system) ? updated.system : {};
  updated.system.quantity = operation.afterQuantity;
  actor.items[index] = updated;
}

function reserveDeterministicItemId({ runId, actor, resourceId, sequence }) {
  const occupied = new Set(actor.items.map(documentId).filter(Boolean));
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const id = buildDeterministicResourceItemId({
      runId,
      actorId: actor.actorId,
      resourceId,
      sequence,
      attempt,
    });
    if (!occupied.has(id)) return id;
  }
  throw new ResourceOperationInventoryError(
    "RESOURCE_INVENTORY_ID_COLLISION",
    `Could not reserve an embedded Item id on Actor ${actor.actorId}`,
  );
}

function buildCreatedResourceSnapshot({
  template,
  resource,
  quantity,
  itemId,
}) {
  const snapshot = cloneItemSnapshot(template);
  if (!snapshot) {
    throw new ResourceOperationInventoryError(
      "RESOURCE_INVENTORY_TEMPLATE_UNAVAILABLE",
      `No safe create template was available for Resource ${resource.id}`,
    );
  }
  delete snapshot.id;
  delete snapshot.uuid;
  snapshot._id = itemId;
  snapshot.system = plainObject(snapshot.system) ? snapshot.system : {};
  snapshot.system.quantity = wholeAmount(quantity);
  snapshot.flags = plainObject(snapshot.flags) ? snapshot.flags : {};
  snapshot.flags[MODULE_ID] = {
    ...(plainObject(snapshot.flags[MODULE_ID])
      ? snapshot.flags[MODULE_ID]
      : {}),
    resourceTag: effectiveResourceTag(resource),
  };
  return snapshot;
}

function defaultResourceTemplate(resource) {
  const label = String(resource?.label ?? resource?.id ?? "Supply").trim();
  return {
    name: label,
    type: "loot",
    img: "icons/containers/bags/sack-simple-leather-brown.webp",
    system: {
      quantity: 1,
      weight: { value: 0, units: "lb" },
      price: { value: 0, denomination: "gp" },
      description: { value: "Created by Infinity D&D5e Quartermaster." },
    },
  };
}

function withEffectiveResourceTag(resource) {
  const tag = effectiveResourceTag(resource);
  if (resource?.matching?.flagTag === tag) return resource;
  return {
    ...resource,
    matching: {
      ...(plainObject(resource?.matching) ? resource.matching : {}),
      flagTag: tag,
    },
  };
}

function effectiveResourceTag(resource) {
  return (
    String(resource?.matching?.flagTag ?? resource?.id ?? "").trim() ||
    String(resource?.id ?? "").trim()
  );
}

async function applyOneFoundryWrite(actor, operation) {
  if (operation.action === "update") {
    await actor.updateEmbeddedDocuments("Item", [
      {
        _id: operation.itemId,
        "system.quantity": operation.afterQuantity,
      },
    ]);
    return;
  }
  if (operation.action === "create") {
    await actor.createEmbeddedDocuments(
      "Item",
      [cloneItemSnapshot(operation.itemSnapshot)],
      { keepId: true, keepEmbeddedIds: true },
    );
    return;
  }
  await actor.deleteEmbeddedDocuments("Item", [operation.itemId]);
}

function assertActorWriteMethod(actor, action) {
  const method =
    action === "update"
      ? "updateEmbeddedDocuments"
      : action === "create"
        ? "createEmbeddedDocuments"
        : "deleteEmbeddedDocuments";
  if (typeof actor?.[method] !== "function") {
    throw new ResourceOperationInventoryError(
      "RESOURCE_INVENTORY_WRITE_UNAVAILABLE",
      `Actor inventory does not support ${action} writes`,
    );
  }
}

function executionResult({
  classification,
  operation,
  before,
  after,
  writeAttempted,
  writeError,
}) {
  return {
    action: classification.action,
    reason: classification.reason,
    operationId: operation.opId,
    operation,
    before,
    after,
    writeAttempted,
    // Errors are intentionally returned to the coordinator for logging. They
    // are not persisted; canonical after-state is the durable decision input.
    writeError,
  };
}

function collectionValue(collection, idValue) {
  const id = String(idValue ?? "").trim();
  if (!id || collection == null) return null;
  if (typeof collection === "function") return collection(id) ?? null;
  if (typeof collection.get === "function") return collection.get(id) ?? null;
  if (Array.isArray(collection)) {
    return (
      collection.find(
        (entry) =>
          String(entry?.id ?? entry?.actorId ?? entry?.resourceId ?? "") === id,
      ) ?? null
    );
  }
  if (typeof collection === "object") return collection[id] ?? null;
  return null;
}

function requiredActor(actorById, idValue) {
  const id = requiredId(idValue, "actorId");
  const actor = actorById.get(id);
  if (!actor) {
    throw new ResourceOperationInventoryError(
      "RESOURCE_INVENTORY_ACTOR_MISSING",
      `Actor ${id} is unavailable for inventory planning`,
    );
  }
  return actor;
}

function findActorItem(actor, idValue) {
  const id = String(idValue ?? "").trim();
  if (!id) return null;
  const direct = actor?.items?.get?.(id);
  if (direct) return direct;
  return (
    actorItemDocuments(actor).find((item) => documentId(item) === id) ?? null
  );
}

function actorItemDocuments(actor) {
  const items = actor?.items;
  if (Array.isArray(items)) return items;
  if (Array.isArray(items?.contents)) return items.contents;
  if (typeof items?.values === "function") return [...items.values()];
  return [];
}

function documentSnapshot(document) {
  if (document == null) return null;
  return typeof document.toObject === "function"
    ? document.toObject()
    : document;
}

function documentId(document) {
  return String(
    document?.id ?? document?._id ?? document?._source?._id ?? "",
  ).trim();
}

function documentQuantity(document) {
  const raw =
    document?.system?.quantity ?? document?._source?.system?.quantity ?? null;
  if (raw === null || raw === undefined || raw === "") {
    throw new ResourceOperationInventoryError(
      "RESOURCE_INVENTORY_QUANTITY_INVALID",
      `Item ${documentId(document) || "unknown"} has no canonical quantity`,
    );
  }
  const quantity = Number(raw);
  if (!Number.isSafeInteger(quantity) || quantity < 0) {
    throw new ResourceOperationInventoryError(
      "RESOURCE_INVENTORY_QUANTITY_INVALID",
      `Item ${documentId(document) || "unknown"} has no canonical quantity`,
    );
  }
  return quantity;
}

function quantityForMatch(matches, itemId) {
  const match = matches.find((entry) => entry.id === String(itemId));
  if (!match) {
    throw new ResourceOperationInventoryError(
      "RESOURCE_INVENTORY_ITEM_MISSING",
      `Item ${itemId} is unavailable in the planning snapshot`,
    );
  }
  return wholeAmount(match.quantity);
}

function wholeAmount(value) {
  const number = Math.floor(Number(value));
  return Number.isSafeInteger(number) && number > 0 ? number : 0;
}

function requiredId(value, field) {
  const id = String(value ?? "").trim();
  if (!id) {
    throw new ResourceOperationInventoryError(
      "RESOURCE_INVENTORY_ID_REQUIRED",
      `${field} is required`,
    );
  }
  return id;
}

function safeIndex(value, field) {
  const index = Number(value);
  if (!Number.isSafeInteger(index) || index < 0) {
    throw new ResourceOperationInventoryError(
      "RESOURCE_INVENTORY_INDEX_INVALID",
      `${field} must be a non-negative safe integer`,
    );
  }
  return index;
}

function cloneItemSnapshot(value) {
  if (!plainObject(value)) return null;
  try {
    return structuredClone(value);
  } catch (error) {
    throw new ResourceOperationInventoryError(
      "RESOURCE_INVENTORY_SNAPSHOT_INVALID",
      `Item snapshot is not cloneable: ${error?.message ?? "unknown error"}`,
    );
  }
}

function plainObject(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function deepFreeze(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value))
    return value;
  Object.freeze(value);
  for (const child of Object.values(value)) deepFreeze(child);
  return value;
}

function hashWords(value) {
  let a = 0x243f6a88;
  let b = 0x85a308d3;
  let c = 0x13198a2e;
  let d = 0x03707344;
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    a = Math.imul(a ^ code, 0x9e3779b1);
    b = Math.imul(b ^ code, 0x85ebca77);
    c = Math.imul(c ^ code, 0xc2b2ae3d);
    d = Math.imul(d ^ code, 0x27d4eb2f);
  }
  a = xorshift32(a ^ (b >>> 1));
  b = xorshift32(b ^ (c >>> 1));
  c = xorshift32(c ^ (d >>> 1));
  d = xorshift32(d ^ (a >>> 1));
  return [a, b, c, d];
}

function xorshift32(value) {
  let state = value >>> 0;
  state ^= state << 13;
  state ^= state >>> 17;
  state ^= state << 5;
  return state >>> 0;
}
