/**
 * Infinity D&D5e — Item value filter + market tiers.
 *
 * A per-item gp value band ([min, max]) that restricts which items a roll or
 * shop can surface, plus named "market tier" presets that fill that band.
 *
 * Because price tracks rarity in the curated pack (cheap = common, pricey =
 * rare), a value ceiling doubles as a market-realism dial: a low cap yields
 * abundant general-store commons, a high one an emporium where real rares
 * start to appear. The roller already honors `minGp` / `maxGp` in
 * `filterCandidates`; this module is the pure, node-testable glue the loot
 * windows and the merchant stock pool share.
 */

/**
 * Named value-cap presets, low → high. `max: 0` means "no upper limit".
 * Tuned against the real pack distribution (half of items are < ~640 gp):
 *   General Store ≤200  → ~95% common/uncommon
 *   Town Market   ≤500  → mostly common/uncommon, a few rares
 *   City Bazaar   ≤1000 → rares start mixing in
 *   Emporium      ≤5000 → well-stocked, real rares appear
 *   Vault          none → everything, up to artifacts
 */
export const MARKET_TIERS = Object.freeze([
  Object.freeze({
    key: "general",
    label: "General Store",
    icon: "fa-solid fa-store",
    min: 0,
    max: 200,
  }),
  Object.freeze({
    key: "town",
    label: "Town Market",
    icon: "fa-solid fa-shop",
    min: 0,
    max: 500,
  }),
  Object.freeze({
    key: "bazaar",
    label: "City Bazaar",
    icon: "fa-solid fa-tents",
    min: 0,
    max: 1000,
  }),
  Object.freeze({
    key: "emporium",
    label: "Emporium",
    icon: "fa-solid fa-gem",
    min: 0,
    max: 5000,
  }),
  Object.freeze({
    key: "vault",
    label: "Vault",
    icon: "fa-solid fa-vault",
    min: 0,
    max: 0,
  }),
]);

/** Coerce a gp input to a non-negative integer; blank / invalid → fallback. */
export function clampGp(raw, fallback = 0) {
  const n = Math.floor(Number(raw));
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

/**
 * Build the `{ minGp, maxGp }` slice `filterCandidates` accepts from a form's
 * `minItemGp` / `maxItemGp`. A 0 (or blank) max means "no ceiling" (Infinity).
 * Pure — safe to spread into any tool's filter spec.
 */
export function valueFilterSpec(form = {}) {
  const min = clampGp(form?.minItemGp, 0);
  const max = clampGp(form?.maxItemGp, 0);
  return { minGp: min, maxGp: max > 0 ? max : Infinity };
}

/**
 * The market-tier key whose band matches [min, max] exactly, or "" when the
 * range is custom. Drives the active-state highlight on the preset buttons.
 */
export function activeMarketTier(minItemGp, maxItemGp) {
  const min = clampGp(minItemGp, 0);
  const max = clampGp(maxItemGp, 0);
  const hit = MARKET_TIERS.find((tier) => tier.min === min && tier.max === max);
  return hit ? hit.key : "";
}

/**
 * Human label for the active value band:
 *   no bounds        → "Any value"
 *   min only         → "≥ 100 gp"
 *   max only         → "≤ 500 gp"
 *   both             → "100–500 gp"
 *   min > max (junk) → "No items in range"
 */
export function formatValueRange(minItemGp, maxItemGp) {
  const min = clampGp(minItemGp, 0);
  const max = clampGp(maxItemGp, 0);
  if (min <= 0 && max <= 0) return "Any value";
  if (max > 0 && min > max) return "No items in range";
  if (min > 0 && max <= 0) return `≥ ${min.toLocaleString()} gp`;
  if (min <= 0 && max > 0) return `≤ ${max.toLocaleString()} gp`;
  return `${min.toLocaleString()}–${max.toLocaleString()} gp`;
}

/**
 * Decorate the market tiers for a template `{{#each}}`, flagging the one whose
 * band matches the current [min, max] so the UI can highlight it.
 */
export function marketTierOptions(minItemGp, maxItemGp) {
  const activeKey = activeMarketTier(minItemGp, maxItemGp);
  return MARKET_TIERS.map((tier) => ({
    key: tier.key,
    label: tier.label,
    icon: tier.icon,
    min: tier.min,
    max: tier.max,
    active: tier.key === activeKey,
  }));
}
