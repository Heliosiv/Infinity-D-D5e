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
  "loot.reagent": "Alchemical Supplies",
  "loot.scroll": "Scrolls",
  "loot.ammunition": "Ammunition",
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

/**
 * Plain-language labels for the Quartermaster's default resources and
 * environments, keyed by the stable internal ids in scripts/resource/*. As with
 * loot types, display text lives here (node-testable) and any unmapped id falls
 * back to a generic title-case transform.
 */
export const RESOURCE_LABELS = Object.freeze({
  food: "Food",
  water: "Water",
  light: "Light",
});

export const ENVIRONMENT_LABELS = Object.freeze({
  abundant: "Abundant",
  limited: "Limited",
  sparse: "Sparse",
  settlement: "Settlement",
  underground: "Underground",
});

/** Plain-English label for a resource id. Empty in -> empty out. */
export function prettyResource(value) {
  const key = String(value ?? "").trim();
  if (!key) return "";
  return RESOURCE_LABELS[key] ?? titleCase(key.replace(/[-_]/g, " "));
}

/** Plain-English label for an environment id. Empty in -> empty out. */
export function prettyEnvironment(value) {
  const key = String(value ?? "").trim();
  if (!key) return "";
  return ENVIRONMENT_LABELS[key] ?? titleCase(key.replace(/[-_]/g, " "));
}

/**
 * Plain-language outcome name for an internal bargain tier id. Internal ids
 * (success/failure/crit-*) stay stable; this is display-only. Unknown/empty in
 * -> "Bargained" so a raw key never reaches a player.
 */
export const BARGAIN_TIER_LABELS = Object.freeze({
  "crit-success": "Great deal",
  success: "Good deal",
  failure: "No luck",
  "crit-failure": "Bad deal",
});

export function prettyBargainTier(value) {
  const key = String(value ?? "").trim();
  return BARGAIN_TIER_LABELS[key] ?? "Bargained";
}

/**
 * Plain-language label for a dashboard tool category. Unknown keys fall back to
 * title-case so the registry keys stay stable.
 */
export const CATEGORY_LABELS = Object.freeze({
  loot: "Treasure & Loot",
  merchants: "Shops & Merchants",
  party: "Travel & Supplies",
});

export function prettyCategory(value) {
  const key = String(value ?? "").trim();
  if (!key) return "Tools";
  return CATEGORY_LABELS[key] ?? titleCase(key.replace(/[-_]/g, " "));
}

/**
 * Friendly, plain-English message for an internal transaction / bargain reason
 * code, so a player never sees a raw dev slug. Falls back to a generic sentence.
 */
export const TRANSACTION_ERROR_MESSAGES = Object.freeze({
  "no-actor": "Pick a character first.",
  "no-target": "That item isn't available anymore.",
  "out-of-stock": "That item just sold out.",
  "no-price": "That item has no price set.",
  "no-value": "That item has no resale value.",
  "bad-item": "That item couldn't be added — try again.",
  "create-failed": "That item couldn't be added to your sheet.",
  "payment-failed": "Payment didn't go through — nothing was charged.",
  "payout-failed": "The payout didn't go through — your item was kept.",
  "remove-failed": "That item couldn't be removed from your sheet.",
  "insufficient-funds": "You can't afford that.",
  "not-sellable": "That item can't be sold.",
  "not-bought-here": "This merchant won't buy that.",
  "not-enough": "You don't have that many to sell.",
  "no-skill": "Pick a skill to haggle with.",
  "skill-roll-failed": "The haggle roll didn't go through — try again.",
  cancelled: "Cancelled.",
});

export function friendlyTransactionError(reason) {
  const key = String(reason ?? "").trim();
  return (
    TRANSACTION_ERROR_MESSAGES[key] ?? "That didn't go through — try again."
  );
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

/**
 * Render a single decorated result entry as a plain-text bullet line, e.g.
 * "- 20× Arrows (Common · 1 gp)". Pure; used by {@link plainTextLootSummary}.
 */
function plainTextEntryLine(entry, indent = "") {
  const name = entry?.displayName || entry?.item?.name || "Unknown item";
  const quantity = Math.max(1, Math.floor(Number(entry?.quantity) || 1));
  const qty = quantity > 1 ? `${quantity}× ` : "";
  const meta = [
    entry?.rarity ? prettyRarity(entry.rarity) : "",
    formatGp(entry?.gpTotal),
  ]
    .filter(Boolean)
    .join(" · ");
  return `${indent}- ${qty}${name}${meta ? ` (${meta})` : ""}`;
}

/**
 * Build a plain-text summary of a rolled loot result, suitable for copying
 * to the clipboard and pasting into Discord, session notes, or a wiki.
 *
 * Handles all three loot-window result shapes: a flat `items` bundle
 * (Per-Encounter), an `items` bundle plus a coin pile (Hoard), and a
 * `creatures[].items` roster (Per-Creature). Pure and dependency-free so it
 * stays node-testable alongside the other formatters.
 *
 * @param {object|null} result - the tool's `_lastResult`
 * @param {object} [opts]
 * @param {string} [opts.title] - heading line (usually the tool's chat alias)
 * @returns {string} multi-line summary, or "" when there is nothing to show
 */
export function plainTextLootSummary(result, { title = "Loot" } = {}) {
  if (!result || typeof result !== "object") return "";
  const lines = [String(title)];

  if (Array.isArray(result.creatures)) {
    for (const creature of result.creatures) {
      const total = creature?.totalGpLabel ?? formatGp(creature?.totalGp);
      lines.push(`${creature?.name ?? "Creature"} — ${total}`);
      const items = Array.isArray(creature?.items) ? creature.items : [];
      if (items.length === 0) lines.push("  - (no drops)");
      else
        for (const entry of items) lines.push(plainTextEntryLine(entry, "  "));
    }
    lines.push(
      `Total: ${result.grandTotalLabel ?? formatGp(result.grandTotal)}`,
    );
    return lines.join("\n");
  }

  const items = Array.isArray(result.items) ? result.items : [];
  for (const entry of items) lines.push(plainTextEntryLine(entry));
  if (result.coinPileGp) {
    const coin = result.coinPileLabel ?? formatGp(result.coinPileGp);
    const breakdown = result.coinBreakdownLabel
      ? ` (${result.coinBreakdownLabel})`
      : "";
    lines.push(`Coin pile: ${coin}${breakdown}`);
  }
  lines.push(`Total: ${result.totalGpLabel ?? formatGp(result.totalGp)}`);
  return lines.join("\n");
}
