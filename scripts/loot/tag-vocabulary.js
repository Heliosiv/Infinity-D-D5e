/**
 * Infinity D&D5e — Tag Vocabulary
 *
 * Single source of truth for the enum values used by the curated
 * compendium tag schema `po-loot-v3`. The roller, budget, and UI
 * all import from here so renames or additions happen in one place.
 *
 * Items in packs/infinity-dnd5e-items.db carry these tags under
 * `flags["party-operations"].keywords` (legacy from the source
 * compendium). v0.1 reads that flag namespace verbatim; a future
 * milestone migrates the pack to `flags["infinity-dnd5e"]`.
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
 * Canonical loot-type buckets. The roller filters candidates by
 * matching against `flags.party-operations.lootType` first and
 * falling back to keyword scan.
 *
 * Keep this list curated — only buckets that actually appear in the
 * shipped compendium belong here. Adding a bucket without items in
 * it leaves a phantom option in the UI.
 */
export const LOOT_TYPES = Object.freeze([
  "loot.weapon.magic",
  "loot.weapon.mundane",
  "loot.armor.magic",
  "loot.armor.mundane",
  "loot.equipment",
  "loot.consumable",
  "loot.scroll",
  "loot.wand",
  "loot.rod",
  "loot.staff",
  "loot.ring",
  "loot.wondrous",
  "loot.gem",
  "loot.art",
  "loot.tool",
  "loot.trade-good",
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
    "loot.scroll",
    "loot.wand",
    "loot.rod",
    "loot.staff",
    "loot.ring",
    "loot.wondrous",
    "loot.consumable", // potions / elixirs / consumed magic items
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
 * Supports both flag namespaces (party-operations legacy + future
 * infinity-dnd5e namespace) so future re-tagging is a no-op.
 */
export function getItemKeywords(item) {
  const legacy = item?.flags?.["party-operations"]?.keywords;
  if (Array.isArray(legacy)) return legacy;
  const native = item?.flags?.["infinity-dnd5e"]?.keywords;
  if (Array.isArray(native)) return native;
  return [];
}

/** Get the canonical lootType bucket off an item, or "" if not tagged. */
export function getItemLootType(item) {
  return (
    String(
      item?.flags?.["party-operations"]?.lootType ??
        item?.flags?.["infinity-dnd5e"]?.lootType ??
        "",
    ).trim() || ""
  );
}

/** Get the tier id (`t1`-`t5`) off an item, or "" if not tagged. */
export function getItemTier(item) {
  const raw = String(
    item?.flags?.["party-operations"]?.tier ??
      item?.flags?.["infinity-dnd5e"]?.tier ??
      "",
  ).trim();
  // Tag may arrive as `tier.t2` or just `t2`; strip the prefix.
  if (raw.startsWith("tier.")) return raw.slice("tier.".length);
  return raw;
}

/** Get the value band (`v1`-`v5`) off an item, or "" if not tagged. */
export function getItemValueBand(item) {
  const raw = String(
    item?.flags?.["party-operations"]?.valueBand ??
      item?.flags?.["infinity-dnd5e"]?.valueBand ??
      "",
  ).trim();
  if (raw.startsWith("value.")) return raw.slice("value.".length);
  return raw;
}

/** Get the normalized rarity off an item. */
export function getItemRarity(item) {
  return normalizeRarity(
    item?.flags?.["party-operations"]?.rarityNormalized ??
      item?.flags?.["infinity-dnd5e"]?.rarityNormalized ??
      item?.system?.rarity ??
      "",
  );
}

/** Get the gp value off an item. Returns 0 when not tagged. */
export function getItemGpValue(item) {
  const raw = Number(
    item?.flags?.["party-operations"]?.gpValue ??
      item?.flags?.["infinity-dnd5e"]?.gpValue ??
      0,
  );
  return Number.isFinite(raw) && raw > 0 ? raw : 0;
}

/** Get the loot weight (probability multiplier) off an item. Defaults to 1.0. */
export function getItemLootWeight(item) {
  const raw = Number(
    item?.flags?.["party-operations"]?.lootWeight ??
      item?.flags?.["infinity-dnd5e"]?.lootWeight ??
      1,
  );
  return Number.isFinite(raw) && raw > 0 ? raw : 1;
}

/** Get the max recommended quantity for one bundle. Defaults to 1. */
export function getItemMaxQty(item) {
  const raw = Number(
    item?.flags?.["party-operations"]?.maxRecommendedQty ??
      item?.flags?.["infinity-dnd5e"]?.maxRecommendedQty ??
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
  const lootType = getItemLootType(item);
  if (MAGIC_LOOT_TYPES.has(lootType)) return "magic";
  if (MUNDANE_LOOT_TYPES.has(lootType)) return "mundane";
  return "neutral";
}

/** Is the item eligible to appear in a loot roll at all? */
export function isLootEligible(item) {
  const eligible =
    item?.flags?.["party-operations"]?.lootEligible ??
    item?.flags?.["infinity-dnd5e"]?.lootEligible;
  if (eligible === false) return false;
  // Default: eligible unless tagged otherwise. Items missing the flag
  // are still rollable because the shipped compendium pre-dates the
  // flag's universal application.
  return true;
}
