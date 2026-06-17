/**
 * Infinity D&D5e — Tag Vocabulary
 *
 * Single source of truth for the enum values used by the curated
 * compendium tag schema `po-loot-v3`. The roller, budget, and UI
 * all import from here so renames or additions happen in one place.
 *
 * Items in packs/infinity-dnd5e-items.db carry these tags under
 * `flags["infinity-dnd5e"].keywords`. The accessors below still read the
 * legacy `flags["party-operations"]` namespace as a fallback so items in
 * existing player worlds that were imported before the migration keep their
 * tags; the shipped pack itself is 100% on the native namespace.
 */

/** Rarity bucket — matches dnd5e's `system.rarity` after normalization. */
export const RARITIES = Object.freeze([
  "common",
  "uncommon",
  "rare",
  "very-rare",
  "legendary",
  "artifact",
]);

/** Power-tier bucket. Maps to APL bands; t1 = lvl 1–4, t2 = 5–10, t3 = 11–16, t4 = 17+, t5 = epic. */
export const TIERS = Object.freeze(["t1", "t2", "t3", "t4", "t5"]);

/**
 * Build the inclusive tier window for a roll at `tier`: the tier itself
 * plus the one directly below. Used by every loot tool so a T2 roll can
 * also pick up T1 commons (arrows, daggers, torches) — the curated pack
 * tags real common gear at T1 only, so a strict single-tier filter at T2
 * surfaces zero commons even when the user has the common rarity chip
 * checked. T1 stays alone (no tier below). Unknown tiers fall back to
 * themselves so malformed inputs don't silently empty the pool.
 *
 * Returns a fresh array each call; safe for callers to mutate.
 */
export function tierWindow(tier) {
  const key = String(tier ?? "")
    .trim()
    .toLowerCase();
  const idx = TIERS.indexOf(key);
  if (idx < 0) return [tier];
  if (idx === 0) return [TIERS[0]];
  return [TIERS[idx - 1], TIERS[idx]];
}

/** GP-value band. v1 = trivial, v5 = legendary-tier price. */
export const VALUE_BANDS = Object.freeze(["v1", "v2", "v3", "v4", "v5"]);

/**
 * Canonical loot-type buckets surfaced as UI filter chips. The roller
 * matches a candidate's canonical lootType (see `getItemLootType`, which
 * applies `LOOT_TYPE_ALIASES`) first, then falls back to a keyword scan.
 *
 * Keep this list curated under one rule: every chip must resolve to real
 * items in the shipped pack (directly or via an alias), AND every shipped
 * lootType must map onto one of these chips, so no item is unreachable.
 * Buckets the pack folds into broader ones (wand/rod/staff/ring/wondrous →
 * consumable & equipment.magic) are intentionally NOT chips; they live only
 * in `MAGIC_LOOT_TYPES` for magic-bias classification.
 *
 * `loot.ammunition` is a *synthetic* chip: the pack tags every arrow / bolt /
 * bullet as `loot.consumable`, so there is no `loot.ammunition` lootType on
 * any item. The roller resolves this chip through `isAmmunitionItem()` (and
 * the stats counter does the same), giving the GM a dedicated lever to pull
 * ammunition into a roll or shop without dredging the whole consumable pool —
 * the same "virtual chip" pattern as the variable gem/art detectors.
 */
export const LOOT_TYPES = Object.freeze([
  "loot.weapon.magic",
  "loot.weapon.mundane",
  "loot.armor.magic",
  "loot.armor.mundane",
  "loot.equipment.magic",
  "loot.equipment",
  "loot.consumable",
  "loot.potion",
  // Raw alchemical ingredients (herbs, fungi, reagents) — surfaced as the
  // "Alchemical Supplies" chip. Distinct from finished potions so the GM can
  // stock a herbalist/apothecary without dredging the magic-potion pool.
  "loot.reagent",
  "loot.scroll",
  "loot.ammunition",
  "loot.tool",
  "loot.gem",
  "loot.art",
  "loot.trade-good",
  "loot.container",
]);

/** Rarity buckets that mean "magic-rare or better" — useful for tier filtering. */
export const ELEVATED_RARITIES = Object.freeze([
  "rare",
  "very-rare",
  "legendary",
  "artifact",
]);

/**
 * Loot types that are inherently magic in the curated pack.
 * Used by `getItemMagicNature()` and the Magic Bias slider in the
 * Per-Encounter Loot window.
 */
export const MAGIC_LOOT_TYPES = Object.freeze(
  new Set([
    "loot.weapon.magic",
    "loot.armor.magic",
    "loot.equipment.magic", // wondrous magic gear: rings, ioun stones, robes
    "loot.scroll",
    "loot.consumable", // potions / elixirs / consumed magic items
    "loot.potion",
    // Retained for classification though no longer surfaced as chips: the
    // shipped pack folds these into consumable / equipment.magic, so they
    // never appear as a primary lootType. Keeping them here means any future
    // item tagged this way is still treated as magic by the bias dial.
    "loot.wand",
    "loot.rod",
    "loot.staff",
    "loot.ring",
    "loot.wondrous",
  ]),
);

/** Loot types that are inherently mundane in the curated pack. */
export const MUNDANE_LOOT_TYPES = Object.freeze(
  new Set([
    "loot.weapon.mundane",
    "loot.armor.mundane",
    "loot.gem",
    "loot.art",
    "loot.tool",
    "loot.trade-good",
  ]),
);

/** Keywords used by the curated pack to identify consumable ammunition. */
const AMMUNITION_KEYWORDS = Object.freeze(
  new Set([
    "subtype.ammo",
    "subtype.ammunition",
    "folder.section.ammunition",
    "folder.path.weapons.ammunition",
  ]),
);

/* ------------------------------------------------------------------ *
 * Token helpers
 * ------------------------------------------------------------------ */

/** Build a `tier.tN` keyword from a tier id. */
export function tierKeyword(tier) {
  return `tier.${String(tier ?? "")
    .trim()
    .toLowerCase()}`;
}

/** Build a `value.vN` keyword from a band id. */
export function valueKeyword(band) {
  return `value.${String(band ?? "")
    .trim()
    .toLowerCase()}`;
}

/** Build a `rarity.<bucket>` keyword. Normalizes legacy `veryRare` → `very-rare`. */
export function rarityKeyword(rarity) {
  return `rarity.${normalizeRarity(rarity)}`;
}

/** Normalize a free-form rarity string into one of the RARITIES enum values. */
export function normalizeRarity(value) {
  const raw = String(value ?? "")
    .trim()
    .toLowerCase();
  if (!raw) return "";
  if (raw === "veryrare") return "very-rare";
  if (raw === "very_rare") return "very-rare";
  if (RARITIES.includes(raw)) return raw;
  return "";
}

/* ------------------------------------------------------------------ *
 * Filter primitives
 * ------------------------------------------------------------------ */

/**
 * Get the keyword array off a raw compendium item entry.
 * Reads the native `infinity-dnd5e` namespace first and falls back to
 * the legacy `party-operations` one, so older-tagged items (e.g. copies
 * already sitting on a character sheet) still resolve.
 */
export function getItemKeywords(item) {
  const pre = item?.__inf;
  if (pre && Array.isArray(pre.keywords)) return pre.keywords;
  const native = item?.flags?.["infinity-dnd5e"]?.keywords;
  if (Array.isArray(native)) return native;
  const legacy = item?.flags?.["party-operations"]?.keywords;
  if (Array.isArray(legacy)) return legacy;
  return [];
}

/**
 * Loot-type aliases that canonicalize the source compendium's coarse buckets
 * onto curated chips, so every shipped item is reachable by exactly one chip:
 *
 *   - The pack tags non-magic weapons/armour as plain `loot.weapon` /
 *     `loot.armor` (only the magic variants carry a suffix); the vocabulary
 *     uses the explicit `.mundane` suffix.
 *   - Generic treasure & sundries (`loot.loot`: gems, art, hammers, chalk)
 *     fold onto the Trade Goods chip. Variable gems/art are still independently
 *     reachable via the Gem/Art chips through the variable-treasure detector.
 *   - Poisons (`loot.poison`) fold onto Consumable.
 *
 * Canonicalizing on read keeps the data lined up with LOOT_TYPES /
 * MUNDANE_LOOT_TYPES in one place, instead of every call site exact-matching a
 * string the pack never carries. A Map (not a plain object) so a stray
 * lootType like "toString" can't resolve to an inherited prototype member.
 */
const LOOT_TYPE_ALIASES = new Map([
  ["loot.weapon", "loot.weapon.mundane"],
  ["loot.armor", "loot.armor.mundane"],
  ["loot.loot", "loot.trade-good"],
  ["loot.poison", "loot.consumable"],
]);

/** Get the canonical lootType bucket off an item, or "" if not tagged. */
export function getItemLootType(item) {
  const pre = item?.__inf;
  if (pre && typeof pre.lootType === "string") return pre.lootType;
  const raw =
    String(
      item?.flags?.["infinity-dnd5e"]?.lootType ??
        item?.flags?.["party-operations"]?.lootType ??
        "",
    ).trim() || "";
  return LOOT_TYPE_ALIASES.get(raw) ?? raw;
}

/**
 * True for source spell documents that are not inventory loot by themselves.
 * Generated spell scrolls are consumable items with `loot.scroll`, so they do
 * not match this guard.
 */
export function isBareSpellLootItem(item) {
  return item?.type === "spell" || getItemLootType(item) === "loot.spell";
}

/** Get the tier id (`t1`-`t5`) off an item, or "" if not tagged. */
export function getItemTier(item) {
  const pre = item?.__inf;
  if (pre && typeof pre.tier === "string") return pre.tier;
  const raw = String(
    item?.flags?.["infinity-dnd5e"]?.tier ??
      item?.flags?.["party-operations"]?.tier ??
      "",
  ).trim();
  // Tag may arrive as `tier.t2` or just `t2`; strip the prefix.
  if (raw.startsWith("tier.")) return raw.slice("tier.".length);
  return raw;
}

/** Get the value band (`v1`-`v5`) off an item, or "" if not tagged. */
export function getItemValueBand(item) {
  const pre = item?.__inf;
  if (pre && typeof pre.valueBand === "string") return pre.valueBand;
  const raw = String(
    item?.flags?.["infinity-dnd5e"]?.valueBand ??
      item?.flags?.["party-operations"]?.valueBand ??
      "",
  ).trim();
  if (raw.startsWith("value.")) return raw.slice("value.".length);
  return raw;
}

/** Get the normalized rarity off an item. */
export function getItemRarity(item) {
  const pre = item?.__inf;
  if (pre && typeof pre.rarity === "string") return pre.rarity;
  return normalizeRarity(
    item?.flags?.["infinity-dnd5e"]?.rarityNormalized ??
      item?.flags?.["party-operations"]?.rarityNormalized ??
      item?.system?.rarity ??
      "",
  );
}

/** Get the gp value off an item. Returns 0 when not tagged. */
export function getItemGpValue(item) {
  const pre = item?.__inf;
  if (pre && typeof pre.gpValue === "number") return pre.gpValue;
  const raw = Number(
    item?.flags?.["infinity-dnd5e"]?.gpValue ??
      item?.flags?.["party-operations"]?.gpValue ??
      0,
  );
  return Number.isFinite(raw) && raw > 0 ? raw : 0;
}

/** Get the loot weight (probability multiplier) off an item. Defaults to 1.0. */
export function getItemLootWeight(item) {
  const pre = item?.__inf;
  if (pre && typeof pre.lootWeight === "number") return pre.lootWeight;
  const raw = Number(
    item?.flags?.["infinity-dnd5e"]?.lootWeight ??
      item?.flags?.["party-operations"]?.lootWeight ??
      1,
  );
  return Number.isFinite(raw) && raw > 0 ? raw : 1;
}

/** Get the max recommended quantity for one bundle. Defaults to 1. */
export function getItemMaxQty(item) {
  const raw = Number(
    item?.flags?.["infinity-dnd5e"]?.maxRecommendedQty ??
      item?.flags?.["party-operations"]?.maxRecommendedQty ??
      1,
  );
  return Number.isFinite(raw) && raw >= 1 ? Math.floor(raw) : 1;
}

/** Is the item a consumable ammunition entry such as arrows or bolts? */
export function isAmmunitionItem(item) {
  const systemType = String(
    item?.system?.type?.value ?? item?.system?.type?.subtype ?? "",
  )
    .trim()
    .toLowerCase();
  if (systemType === "ammo" || systemType === "ammunition") return true;

  const keywords = getItemKeywords(item);
  return keywords.some((keyword) =>
    AMMUNITION_KEYWORDS.has(
      String(keyword ?? "")
        .trim()
        .toLowerCase(),
    ),
  );
}

/**
 * Classify an item as inherently magic / mundane / neutral based on
 * its loot type. Equipment with no clear bucket falls through to
 * "neutral" so the Magic Bias dial leaves it alone.
 *
 * @returns {"magic"|"mundane"|"neutral"}
 */
export function getItemMagicNature(item) {
  const pre = item?.__inf;
  if (pre && typeof pre.magicNature === "string") return pre.magicNature;
  const lootType = getItemLootType(item);
  if (MAGIC_LOOT_TYPES.has(lootType)) return "magic";
  if (MUNDANE_LOOT_TYPES.has(lootType)) return "mundane";
  return "neutral";
}

/**
 * True only for genuine *mundane* treasure base items — the source compendium
 * uses the `loot` item type for every sundries gem / art object / trade good.
 *
 * This is the gate that keeps the variable-treasure detectors honest. The pack
 * over-applies the `variableTreasureKind` flag and the `treasure.gem` /
 * `treasure.art` keywords: magic consumables ("Pearl of Power", "Gem of
 * Seeing", lanterns, censers), magic equipment, and even a spell ("Spirit
 * Guardians") inherit those treasure-adjacent tags from their flavor. Those
 * items are NOT variable treasure — they must never be pulled onto the Gem /
 * Art filter chips, nor renamed into appraised art objects by the loot roller.
 * Gating on `type === "loot"` cleanly separates the two: every real gem/art
 * base is `loot`, every false positive is `consumable` / `equipment` / `spell`.
 */
export function isVariableTreasureBase(item) {
  return String(item?.type ?? "").trim() === "loot";
}

/** Is the item eligible to appear in a loot roll at all? */
export function isLootEligible(item) {
  const pre = item?.__inf;
  if (pre && typeof pre.eligible === "boolean") return pre.eligible;
  const eligible =
    item?.flags?.["infinity-dnd5e"]?.lootEligible ??
    item?.flags?.["party-operations"]?.lootEligible;
  if (eligible === false) return false;
  // Default: eligible unless tagged otherwise. Items missing the flag
  // are still rollable because the shipped compendium pre-dates the
  // flag's universal application.
  return true;
}

/* ------------------------------------------------------------------ *
 * Hot-path precompute
 * ------------------------------------------------------------------ */

/**
 * Build a normalized tag record for one item by parsing its flag
 * namespace ONCE. Stash the result under `item.__inf` and every getter
 * above will return the precomputed value instead of re-walking the
 * `flags["infinity-dnd5e"]` / `flags["party-operations"]` namespaces on
 * each call — the loot roller hits these getters thousands of times per
 * draw.
 *
 * Must run before `__inf` is set on the item, so the getters fall
 * through to their flag-parsing branches here and produce results
 * byte-identical to the un-cached path. Fields the record omits (e.g.
 * effectiveRarity, which lives in roller.js and would create a circular
 * import) keep flowing through their own getters unchanged.
 *
 * @param {object} item - item-shaped POJO (must NOT yet carry `__inf`)
 * @returns {object} the `__inf` record
 */
export function buildInfRecord(item) {
  return {
    tier: getItemTier(item),
    rarity: getItemRarity(item),
    lootType: getItemLootType(item),
    valueBand: getItemValueBand(item),
    gpValue: getItemGpValue(item),
    keywords: getItemKeywords(item),
    magicNature: getItemMagicNature(item),
    lootWeight: getItemLootWeight(item),
    eligible: isLootEligible(item),
  };
}
