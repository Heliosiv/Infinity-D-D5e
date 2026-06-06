/**
 * Infinity D&D5e — Pack Loader
 *
 * Single source of truth for fetching the bundled item compendium.
 * Shared by {@link LootForgeApp} and the module-level macro API so
 * both pay the same one-time fetch cost and benefit from the same
 * in-memory cache.
 *
 * Cache is keyed by compendium id and time-bounded; if the user
 * edits the pack at runtime (rare — the shipped pack is read-only
 * on Forge) the next call after the TTL picks up the new state.
 */

const DEFAULT_TTL_MS = 5 * 60 * 1000;
export const DEFAULT_ITEM_PACK_ID = "infinity-dnd5e.infinity-dnd5e-items";

const cache = new Map(); // packId → { items, fetchedAt }

export function buildCompendiumItemUuid(
  packId = DEFAULT_ITEM_PACK_ID,
  itemId,
  documentName = "Item",
) {
  const cleanPackId = String(packId ?? "").trim() || DEFAULT_ITEM_PACK_ID;
  const cleanItemId = String(itemId ?? "").trim();
  const cleanDocumentName = String(documentName ?? "").trim() || "Item";
  return cleanItemId
    ? `Compendium.${cleanPackId}.${cleanDocumentName}.${cleanItemId}`
    : "";
}

export function isFullCompendiumDocumentUuid(value) {
  const parts = String(value ?? "")
    .trim()
    .split(".");
  return parts.length >= 5 && parts[0] === "Compendium" && parts.every(Boolean);
}

/**
 * Load the bundled item compendium as plain JS objects, decorated
 * with `uuid` so callers can hand them off to `fromUuid` / drag-drop
 * payloads without rebuilding the address.
 *
 * Uses `getDocuments()` (not `getIndex`) because Foundry's index
 * loader strips data under namespaced flag keys like
 * `flags.party-operations` on some versions — the roller depends on
 * those flags for tier/rarity/value-band/weight, and stripped flags
 * collapse the candidate pool to empty. The shipped pack is small
 * (~1500 small documents, ~few MB once parsed) so the full fetch is
 * cheap and cached for 5 minutes thereafter.
 *
 * @param {object} [opts]
 * @param {string} [opts.packId]  - "<moduleId>.<packName>". Defaults
 *                                  to this module's curated items pack.
 * @param {boolean} [opts.refresh] - bypass the cache.
 * @returns {Promise<Array<object>>} item-shaped POJOs (uuid + .toObject()).
 */
export async function loadCompendiumItems(opts = {}) {
  if (typeof globalThis.game === "undefined") {
    throw new Error(
      "NotInFoundry: loadCompendiumItems requires Foundry runtime",
    );
  }
  const packId = String(opts.packId ?? "").trim() || DEFAULT_ITEM_PACK_ID;
  const refresh = Boolean(opts.refresh);

  const cached = cache.get(packId);
  const now = Date.now();
  if (!refresh && cached && now - cached.fetchedAt < DEFAULT_TTL_MS) {
    return cached.items;
  }

  const pack = game.packs?.get(packId);
  if (!pack) {
    ui.notifications?.warn(`infinity-dnd5e: compendium ${packId} not found.`);
    cache.set(packId, { items: [], fetchedAt: now });
    return [];
  }

  let documents;
  try {
    documents = await pack.getDocuments();
  } catch (err) {
    console.error(`infinity-dnd5e | failed to load compendium ${packId}`, err);
    ui.notifications?.error(
      `infinity-dnd5e: could not load compendium ${packId}. See the console (F12) for details.`,
    );
    // Cache an empty sentinel so callers degrade to an empty pool (a clear
    // "no items match" warning) instead of a rejected promise that leaves the
    // loading UI stuck — and so the first-render prime guard doesn't re-fire
    // on every subsequent render.
    cache.set(packId, { items: [], fetchedAt: now });
    return [];
  }
  const items = documents.map((doc) => {
    const data =
      typeof doc.toObject === "function" ? doc.toObject() : { ...doc };
    const itemId = data._id ?? data.id ?? doc.id;
    const documentName =
      doc.documentName ?? pack.documentName ?? pack.metadata?.type ?? "Item";
    const uuid = isFullCompendiumDocumentUuid(doc.uuid)
      ? doc.uuid
      : buildCompendiumItemUuid(packId, itemId, documentName);
    return {
      ...data,
      uuid,
    };
  });
  cache.set(packId, { items, fetchedAt: now });
  console.log(
    `infinity-dnd5e | loaded ${items.length} items from ${packId} (tagged: ${items.filter((it) => it?.flags?.["infinity-dnd5e"]?.tier || it?.flags?.["party-operations"]?.tier).length})`,
  );
  return items;
}

/** Drop the cached items for one pack (or all packs). Test/dev hook. */
export function invalidatePackCache(packId) {
  if (typeof packId === "string" && packId) cache.delete(packId);
  else cache.clear();
}
