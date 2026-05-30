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

/** "loot.weapon.magic" -> "Weapon · Magic". */
export function prettyLootType(value) {
  return String(value ?? "")
    .replace(/^loot\./, "")
    .replace(/\./g, " · ")
    .replace(/\b\w/g, (c) => c.toUpperCase());
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
