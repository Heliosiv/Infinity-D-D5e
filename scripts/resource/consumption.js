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

import { normalizeInfinityItemUuid } from "../item-uuid-compat.js";

const MODULE_ID = "infinity-dnd5e";

function toQty(value) {
  const n = Math.floor(Number(value));
  return Number.isFinite(n) && n > 0 ? n : 0;
}

/** Lowercased item name, safe for substring matching. */
function lower(value) {
  return String(value ?? "").toLowerCase();
}

function isWordCharacter(value) {
  return Boolean(value) && /[\p{L}\p{N}]/u.test(value);
}

/**
 * Match a configured phrase on whole word boundaries. A singular final word
 * also accepts a simple trailing "s" ("water ration" -> "Water Rations").
 * This avoids accidental substring matches such as "rations" in
 * "Preparations" or "Decorations".
 */
function nameMatchesKeyword(itemName, keyword) {
  const name = lower(itemName);
  const phrase = lower(keyword).trim();
  if (!name || !phrase) return false;
  let offset = 0;
  while (offset <= name.length - phrase.length) {
    const index = name.indexOf(phrase, offset);
    if (index < 0) return false;
    const before = index > 0 ? name[index - 1] : "";
    let afterIndex = index + phrase.length;
    if (
      !phrase.endsWith("s") &&
      name[afterIndex] === "s" &&
      !isWordCharacter(name[afterIndex + 1])
    ) {
      afterIndex += 1;
    }
    const after = name[afterIndex] ?? "";
    if (!isWordCharacter(before) && !isWordCharacter(after)) return true;
    offset = index + 1;
  }
  return false;
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
  if (stats) out.push(normalizeInfinityItemUuid(stats));
  const legacy = item?.flags?.core?.sourceId;
  if (legacy) out.push(normalizeInfinityItemUuid(legacy));
  if (item?.uuid) out.push(normalizeInfinityItemUuid(item.uuid));
  return out;
}

function text(value) {
  return String(value ?? "").trim();
}

function uniqueValues(values, { lowerCase = false } = {}) {
  const seen = new Set();
  const out = [];
  for (const value of Array.isArray(values) ? values : []) {
    const normalized = lowerCase ? lower(value).trim() : text(value);
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    out.push(normalized);
  }
  return out;
}

function describeResources(resourceDefs) {
  return (Array.isArray(resourceDefs) ? resourceDefs : [])
    .filter((resource) => resource && typeof resource === "object")
    .map((resource, index) => {
      const id = text(resource.id) || `resource-${index + 1}`;
      const matching =
        resource.matching && typeof resource.matching === "object"
          ? resource.matching
          : {};
      return {
        source: resource,
        id,
        label: text(resource.label) || id,
        forageYields:
          resource.forageYields === "food" || resource.forageYields === "water"
            ? resource.forageYields
            : null,
        itemUuids: uniqueValues(matching.itemUuids).map(
          normalizeInfinityItemUuid,
        ),
        flagTag: text(matching.flagTag),
        keywords: uniqueValues(matching.nameKeywords, { lowerCase: true }),
        excludedKeywords: uniqueValues(matching.excludeNameKeywords, {
          lowerCase: true,
        }),
      };
    });
}

function diagnosticResult(conflicts) {
  const list = Array.isArray(conflicts) ? conflicts : [];
  return {
    ok: list.length === 0,
    conflicts: list,
    blockingConflicts: list.filter((entry) => entry.blocking === true),
    warningConflicts: list.filter((entry) => entry.blocking !== true),
  };
}

function groupedValues(resources, valuesForResource) {
  const groups = new Map();
  for (const resource of resources) {
    const values = valuesForResource(resource);
    for (const value of Array.isArray(values) ? values : []) {
      const group = groups.get(value) ?? [];
      group.push(resource);
      groups.set(value, group);
    }
  }
  return groups;
}

function sharedMatcherConflict({ code, matcherType, value, resources, noun }) {
  const labels = resources.map((resource) => resource.label);
  return {
    code,
    severity: "warning",
    blocking: false,
    matcherType,
    value,
    resourceIds: resources.map((resource) => resource.id),
    resourceLabels: labels,
    message: `${labels.join(", ")} share the ${noun} "${value}".`,
  };
}

/**
 * Diagnose structural resource ambiguity without reading Foundry documents.
 *
 * Duplicate food/water forage channels are blocking because runtime deposits
 * otherwise select only the first definition. Shared matcher declarations are
 * warnings: they become blocking only when a live Item actually matches more
 * than one resource (see diagnoseResourceItemOverlaps).
 */
export function diagnoseResourceConfiguration(resourceDefs = []) {
  const resources = describeResources(resourceDefs);
  const conflicts = [];

  const forageGroups = groupedValues(resources, (resource) =>
    resource.forageYields ? [resource.forageYields] : [],
  );
  for (const [channel, group] of forageGroups) {
    if (group.length < 2) continue;
    const labels = group.map((resource) => resource.label);
    conflicts.push({
      code: "duplicate-forage-channel",
      severity: "error",
      blocking: true,
      channel,
      resourceIds: group.map((resource) => resource.id),
      resourceLabels: labels,
      message: `${labels.join(", ")} all receive foraged ${channel}; choose one ${channel} resource.`,
    });
  }

  const uuidGroups = groupedValues(resources, (resource) => resource.itemUuids);
  for (const [uuid, group] of uuidGroups) {
    if (group.length < 2) continue;
    conflicts.push(
      sharedMatcherConflict({
        code: "overlapping-item-uuid",
        matcherType: "itemUuid",
        value: uuid,
        resources: group,
        noun: "exact item UUID",
      }),
    );
  }

  const flagGroups = groupedValues(resources, (resource) =>
    resource.flagTag ? [resource.flagTag] : [],
  );
  for (const [flagTag, group] of flagGroups) {
    if (group.length < 2) continue;
    conflicts.push(
      sharedMatcherConflict({
        code: "overlapping-flag-tag",
        matcherType: "flagTag",
        value: flagTag,
        resources: group,
        noun: "item flag tag",
      }),
    );
  }

  for (let leftIndex = 0; leftIndex < resources.length; leftIndex += 1) {
    const left = resources[leftIndex];
    for (
      let rightIndex = leftIndex + 1;
      rightIndex < resources.length;
      rightIndex += 1
    ) {
      const right = resources[rightIndex];
      const overlaps = new Map();
      for (const leftKeyword of left.keywords) {
        for (const rightKeyword of right.keywords) {
          if (
            !leftKeyword.includes(rightKeyword) &&
            !rightKeyword.includes(leftKeyword)
          ) {
            continue;
          }
          const pair = [leftKeyword, rightKeyword].sort();
          overlaps.set(`${pair[0]}\u0000${pair[1]}`, {
            left: leftKeyword,
            right: rightKeyword,
          });
        }
      }
      if (overlaps.size === 0) continue;
      const keywordPairs = [...overlaps.values()];
      const preview = keywordPairs
        .slice(0, 3)
        .map(({ left: leftKeyword, right: rightKeyword }) =>
          leftKeyword === rightKeyword
            ? `"${leftKeyword}"`
            : `"${leftKeyword}" / "${rightKeyword}"`,
        )
        .join(", ");
      const more =
        keywordPairs.length > 3 ? ` (+${keywordPairs.length - 3} more)` : "";
      conflicts.push({
        code: "overlapping-name-keyword",
        severity: "warning",
        blocking: false,
        matcherType: "nameKeyword",
        keywordPairs,
        resourceIds: [left.id, right.id],
        resourceLabels: [left.label, right.label],
        message: `${left.label} and ${right.label} have overlapping name keywords: ${preview}${more}.`,
      });
    }
  }

  return diagnosticResult(conflicts);
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
      .map(normalizeInfinityItemUuid)
      .filter(Boolean),
  );
  const flagTag = String(matching.flagTag ?? "").trim();
  const keywords = (
    Array.isArray(matching.nameKeywords) ? matching.nameKeywords : []
  )
    .map((k) => lower(k).trim())
    .filter(Boolean);
  const excludedKeywords = (
    Array.isArray(matching.excludeNameKeywords)
      ? matching.excludeNameKeywords
      : []
  )
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
      const excluded = excludedKeywords.some((keyword) =>
        nameMatchesKeyword(item.name, keyword),
      );
      if (
        !excluded &&
        keywords.some((keyword) => nameMatchesKeyword(item.name, keyword))
      ) {
        priority = 1;
      }
    }
    if (priority > 0) {
      out.push({
        id: String(id),
        name: item.name ?? "item",
        quantity,
        priority,
      });
    }
  }
  // Highest priority first; within a tier, larger stacks first (drain big piles).
  out.sort((a, b) => b.priority - a.priority || b.quantity - a.quantity);
  return out;
}

/**
 * Find concrete Actor Items claimed by multiple resource definitions.
 *
 * @param {object} args
 * @param {Array<{actorId?:string,actorName?:string,items?:Array<object>}>} args.inventories
 * @param {Array<object>} args.resources
 */
export function diagnoseResourceItemOverlaps({
  inventories = [],
  resources: resourceDefs = [],
} = {}) {
  const resources = describeResources(resourceDefs);
  const conflicts = [];

  for (const [inventoryIndex, inventory] of (Array.isArray(inventories)
    ? inventories
    : []
  ).entries()) {
    if (!inventory || typeof inventory !== "object") continue;
    const actorId =
      text(inventory.actorId ?? inventory.id) || `actor-${inventoryIndex + 1}`;
    const actorName = text(inventory.actorName ?? inventory.name) || actorId;
    const claimsByItem = new Map();

    for (const resource of resources) {
      const matches = matchResourceItems(inventory.items, resource.source);
      for (const match of matches) {
        const itemId = text(match.id);
        if (!itemId) continue;
        const claim = claimsByItem.get(itemId) ?? {
          itemId,
          itemName: text(match.name) || itemId,
          resources: new Map(),
        };
        claim.resources.set(resource.id, {
          id: resource.id,
          label: resource.label,
          priority: match.priority,
        });
        claimsByItem.set(itemId, claim);
      }
    }

    for (const claim of claimsByItem.values()) {
      const claimedResources = [...claim.resources.values()];
      if (claimedResources.length < 2) continue;
      const labels = claimedResources.map((resource) => resource.label);
      conflicts.push({
        code: "overlapping-live-item",
        severity: "error",
        blocking: true,
        actorId,
        actorName,
        itemId: claim.itemId,
        itemName: claim.itemName,
        resources: claimedResources,
        resourceIds: claimedResources.map((resource) => resource.id),
        resourceLabels: labels,
        message: `${actorName}'s ${claim.itemName} matches multiple resources: ${labels.join(", ")}.`,
      });
    }
  }

  return diagnosticResult(conflicts);
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
    return {
      op: "bump",
      id: String(target.id),
      to: toQty(target.quantity) + qty,
    };
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
