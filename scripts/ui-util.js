/**
 * Infinity D&D5e — shared pure UI helpers.
 *
 * Foundry-free, dependency-free formatting/clamping utilities used by the
 * loot windows. Kept in one place (and unit-tested in test-ui-util.mjs) so
 * the three Application windows can't drift, and so this logic is reachable
 * from Node tests — which the Application classes themselves are not, because
 * they reference `foundry.applications.api` at module load.
 */

/** Capitalize the first character. "uncommon" -> "Uncommon". */
export function titleCase(value) {
  const raw = String(value ?? "");
  return raw.charAt(0).toUpperCase() + raw.slice(1);
}

/**
 * Friendly, plain-English labels for the curated loot-type buckets, keyed by
 * the canonical keys in loot/tag-vocabulary.js. Display text lives here with
 * the other UI formatters (and stays node-testable) rather than in the enum
 * source. Any key missing from this map falls back to the generic transform in
 * `prettyLootType`, so a newly added bucket still renders legibly.
 */
export const LOOT_TYPE_LABELS = Object.freeze({
  "loot.weapon.magic": "Magic Weapons",
  "loot.weapon.mundane": "Weapons",
  "loot.armor.magic": "Magic Armor",
  "loot.armor.mundane": "Armor & Shields",
  "loot.equipment.magic": "Magic Equipment",
  "loot.equipment": "Adventuring Gear",
  "loot.consumable": "Potions & Consumables",
  "loot.potion": "Potions",
  "loot.scroll": "Scrolls",
  "loot.wand": "Wands",
  "loot.rod": "Rods",
  "loot.staff": "Staves",
  "loot.ring": "Rings",
  "loot.wondrous": "Wondrous Items",
  "loot.gem": "Gems",
  "loot.art": "Art Objects",
  "loot.tool": "Tools",
  "loot.trade-good": "Trade Goods",
  "loot.container": "Containers",
});

/**
 * Plain-English label for a loot-type key — e.g. "loot.weapon.magic" -> "Magic
 * Weapons". Unmapped keys fall back to a generic "Category · Subtype" transform
 * so an unrecognized bucket still reads sensibly. Empty in -> empty out.
 */
export function prettyLootType(value) {
  const key = String(value ?? "");
  if (LOOT_TYPE_LABELS[key]) return LOOT_TYPE_LABELS[key];
  return key
    .replace(/^loot\./, "")
    .replace(/\./g, " · ")
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

/** "very-rare" -> "Very Rare" for rarity badges. Empty in -> empty out. */
export function prettyRarity(value) {
  return String(value ?? "")
    .split("-")
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

/** Format an integer gp value with thousands separators and a "gp" suffix. */
export function formatGp(value) {
  const num = Number(value);
  if (!Number.isFinite(num) || num <= 0) return "0 gp";
  return `${Math.round(num).toLocaleString()} gp`;
}

/** Render a multiplier as a short fixed-width string ("1.50", "0.65"). */
export function formatMultiplier(value) {
  const num = Number(value);
  if (!Number.isFinite(num)) return "1.00";
  return num.toFixed(2);
}

/**
 * Map the magic-bias slider to a human label.
 * 0 -> "Neutral"; otherwise the percentage toward magic / mundane.
 */
export function formatMagicBias(value) {
  const num = Number(value);
  if (!Number.isFinite(num) || Math.abs(num) < 0.025) return "Neutral";
  const pct = Math.round(Math.abs(num) * 100);
  return num > 0 ? `+${pct}% Magic` : `+${pct}% Mundane`;
}

/**
 * Coerce a form value into a float in [min, max], with a fallback when the
 * user clears the field or types non-numeric input.
 */
export function clampFloat(raw, min, max, fallback) {
  const value = Number(raw);
  if (!Number.isFinite(value)) return fallback;
  return Math.max(min, Math.min(max, value));
}

/** Integer variant of clampFloat. */
export function clampInt(raw, min, max, fallback) {
  const value = Number(raw);
  if (!Number.isFinite(value)) return fallback;
  return Math.max(min, Math.min(max, Math.floor(value)));
}

/** Minimal HTML-escape for names spliced into chat HTML. */
export function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
