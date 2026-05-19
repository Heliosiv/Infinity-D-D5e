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

const DEFAULT_FIELDS = Object.freeze([
  "name",
  "img",
  "type",
  "system.rarity",
  "system.price",
  "flags.party-operations",
  "flags.infinity-dnd5e",
]);

const DEFAULT_TTL_MS = 5 * 60 * 1000;

const cache = new Map(); // packId → { items, fetchedAt }

/**
 * Load the index entries for a compendium pack as plain JS objects,
 * decorated with a `uuid` field so callers can hand them off to
 * `fromUuid` without rebuilding the address.
 *
 * @param {object} [opts]
 * @param {string} [opts.packId]  - "<moduleId>.<packName>". Defaults
 *                                  to this module's curated items pack.
 * @param {string[]} [opts.fields] - index fields to materialize.
 *                                   Defaults cover everything the
 *                                   roller and the result UI read.
 * @param {boolean} [opts.refresh] - bypass the cache.
 * @returns {Promise<Array<object>>} item-shaped POJOs (frozen list).
 */
export async function loadCompendiumItems(opts = {}) {
  if (typeof globalThis.game === "undefined") {
    throw new Error("NotInFoundry: loadCompendiumItems requires Foundry runtime");
  }
  const packId =
    String(opts.packId ?? "").trim() || "infinity-dnd5e.infinity-dnd5e-items";
  const fields =
    Array.isArray(opts.fields) && opts.fields.length > 0
      ? opts.fields.slice()
      : DEFAULT_FIELDS.slice();
  const refresh = Boolean(opts.refresh);

  const cached = cache.get(packId);
  const now = Date.now();
  if (!refresh && cached && now - cached.fetchedAt < DEFAULT_TTL_MS) {
    return cached.items;
  }

  const pack = game.packs?.get(packId);
  if (!pack) {
    ui.notifications?.warn(
      `infinity-dnd5e: compendium ${packId} not found.`,
    );
    cache.set(packId, { items: [], fetchedAt: now });
    return [];
  }

  const index = await pack.getIndex({ fields });
  const items = [...index.values()].map((entry) => ({
    ...entry,
    uuid: entry.uuid ?? `Compendium.${packId}.${entry._id}`,
  }));
  cache.set(packId, { items, fetchedAt: now });
  return items;
}

/** Drop the cached items for one pack (or all packs). Test/dev hook. */
export function invalidatePackCache(packId) {
  if (typeof packId === "string" && packId) cache.delete(packId);
  else cache.clear();
}
