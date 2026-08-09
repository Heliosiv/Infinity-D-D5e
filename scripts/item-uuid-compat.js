/**
 * Backward-compatible identities for bundled compendium items whose legacy
 * document ids were too short for Foundry 13. Keep this map narrow: it repairs
 * saved Infinity UUIDs without rewriting unrelated compendium or Actor items.
 */

const ITEM_PACK_PREFIX = "Compendium.infinity-dnd5e.infinity-dnd5e-items.Item.";

export const LEGACY_INFINITY_ITEM_ID_ALIASES = Object.freeze({
  aRt06Tps7Ef0Xe7: "aRt06Tpsy7Ef0Xe7",
  aRt16Scn4Rs0Ht7: "aRt16Scrn4Rs0Ht7",
  aRt25Map3Ab9Rc6: "aRt25Maps3Ab9Rc6",
});

/** Return a valid current id for one of the three legacy bundled items. */
export function normalizeInfinityItemId(value) {
  const id = String(value ?? "").trim();
  return LEGACY_INFINITY_ITEM_ID_ALIASES[id] ?? id;
}

/**
 * Canonicalize an Infinity item UUID while leaving every other UUID untouched.
 * This is intentionally a pure read-time shim; campaign settings and stored
 * loot histories do not require a migration.
 */
export function normalizeInfinityItemUuid(value) {
  const uuid = String(value ?? "").trim();
  if (!uuid.startsWith(ITEM_PACK_PREFIX)) return uuid;
  const id = uuid.slice(ITEM_PACK_PREFIX.length);
  if (!id || id.includes(".")) return uuid;
  const normalizedId = normalizeInfinityItemId(id);
  return normalizedId === id ? uuid : `${ITEM_PACK_PREFIX}${normalizedId}`;
}

/** Compare current and legacy Infinity item UUIDs as the same item. */
export function sameInfinityItemUuid(left, right) {
  return normalizeInfinityItemUuid(left) === normalizeInfinityItemUuid(right);
}

/**
 * Register Foundry's native compendium redirects before `ready`. Core then
 * resolves legacy UUIDs in historical chat/journal links, Item source links,
 * and external macros without rewriting any stored campaign content.
 */
export function registerInfinityItemUuidRedirects(
  configRef = globalThis.CONFIG,
) {
  const redirects = configRef?.compendium?.uuidRedirects;
  if (!redirects || typeof redirects !== "object") return 0;
  for (const [legacyId, currentId] of Object.entries(
    LEGACY_INFINITY_ITEM_ID_ALIASES,
  )) {
    redirects[`${ITEM_PACK_PREFIX}${legacyId}`] =
      `${ITEM_PACK_PREFIX}${currentId}`;
  }
  return Object.keys(LEGACY_INFINITY_ITEM_ID_ALIASES).length;
}
