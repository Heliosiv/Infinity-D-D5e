/**
 * Infinity D&D5e — Merchant Store
 *
 * Persistence layer for merchant records. Merchants live as plain
 * objects in a single world-scoped Foundry setting (MERCHANTS), so the
 * GM curates them in the Merchant Workspace UI and they survive world
 * reloads without any actor or journal baggage.
 *
 * Pure data shaping (normalization, defaults, validation) is exported
 * for unit testing. Foundry-touching helpers (`load`, `save`) degrade
 * gracefully when `game.settings` is absent so tests can stub a store.
 */

const MODULE_ID = "infinity-dnd5e";
export const MERCHANT_SETTING_KEY = "merchants";
export const MERCHANT_RECORD_VERSION = 1;

const DEFAULT_MARKUP = 1.0;
const DEFAULT_SELL_RATIO = 0.5;
const DEFAULT_BARGAIN_DC = 15;
const DEFAULT_ALLOWED_SKILLS = Object.freeze(["prf", "dec"]);

const DEFAULT_BARGAIN_TIERS = Object.freeze([
  Object.freeze({ id: "crit-success", minMargin: 10, deltaPct: -20 }),
  Object.freeze({ id: "success", minMargin: 0, deltaPct: -10 }),
  Object.freeze({ id: "failure", minMargin: -9, deltaPct: 10 }),
  Object.freeze({ id: "crit-failure", minMargin: -Infinity, deltaPct: 20 }),
]);

/** Skills the GM can allow for bargaining. Display labels for the UI. */
export const BARGAIN_SKILLS = Object.freeze({
  prf: "Persuasion",
  dec: "Deception",
  itm: "Intimidation",
});

/** Shape a default tier list — fresh mutable copy so callers can edit. */
export function getDefaultBargainTiers() {
  return DEFAULT_BARGAIN_TIERS.map((tier) => ({ ...tier }));
}

/* ------------------------------------------------------------------ *
 * Normalization
 * ------------------------------------------------------------------ */

/** Coerce any input to a finite number, defaulting to `fallback`. */
function toNumber(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

/** Coerce to a non-negative integer. */
function toInt(value, fallback) {
  const n = Math.floor(Number(value));
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

/** Trim a string input; empty/undefined → fallback. */
function toStr(value, fallback = "") {
  const s = String(value ?? "").trim();
  return s || fallback;
}

/** Deduplicated array of trimmed strings; preserves first occurrence. */
function toStrArray(value) {
  if (!Array.isArray(value)) return [];
  const seen = new Set();
  const out = [];
  for (const entry of value) {
    const s = String(entry ?? "").trim();
    if (!s || seen.has(s)) continue;
    seen.add(s);
    out.push(s);
  }
  return out;
}

/** Generate a stable id without leaning on Foundry's randomID(). */
function generateId(prefix = "m") {
  const stamp = Math.floor(Math.random() * 0x100000).toString(16).padStart(5, "0");
  const tail = Math.floor(Math.random() * 0x100000).toString(16).padStart(5, "0");
  return `${prefix}-${stamp}${tail}`;
}

/**
 * Normalize a single inventory row. Drops malformed rows by returning
 * null; callers should filter the result.
 */
export function normalizeInventoryRow(row) {
  if (!row || typeof row !== "object") return null;
  const uuid = toStr(row.uuid);
  if (!uuid) return null;
  const startingQty = toInt(row.startingQty ?? row.qty, 1);
  const unlimited = row.unlimited === true;
  // Unlimited rows still carry a `qty` so the row shape is stable and
  // the editor UI can render a sensible value; the `unlimited` flag is
  // what gates stock checks. Default unlimited rows to startingQty.
  const qty = unlimited
    ? startingQty
    : toInt(row.qty ?? startingQty, startingQty);
  const overrideRaw = row.priceOverrideGp;
  const priceOverrideGp =
    overrideRaw == null || overrideRaw === "" || !Number.isFinite(Number(overrideRaw))
      ? null
      : Math.max(0, Number(overrideRaw));
  return {
    uuid,
    qty,
    startingQty,
    unlimited,
    priceOverrideGp,
    notes: toStr(row.notes),
  };
}

/** Normalize a tier entry; drops malformed entries. */
export function normalizeBargainTier(tier) {
  if (!tier || typeof tier !== "object") return null;
  const id = toStr(tier.id);
  if (!id) return null;
  const minMargin =
    tier.minMargin === -Infinity || tier.minMargin === "-Infinity"
      ? -Infinity
      : toNumber(tier.minMargin, 0);
  return {
    id,
    minMargin,
    deltaPct: toNumber(tier.deltaPct, 0),
  };
}

/**
 * Normalize a merchant record — fills missing fields, drops malformed
 * inventory rows, dedupes allowed lists. Idempotent; safe to apply on
 * already-normalized records.
 */
export function normalizeMerchant(input) {
  const raw = input && typeof input === "object" ? input : {};
  const id = toStr(raw.id) || generateId();
  const inventory = Array.isArray(raw.items) ? raw.items : [];
  return {
    id,
    version: MERCHANT_RECORD_VERSION,
    name: toStr(raw.name, "Unnamed Merchant"),
    art: toStr(raw.art),
    description: toStr(raw.description),
    defaultMarkup: Math.max(0, toNumber(raw.defaultMarkup, DEFAULT_MARKUP)),
    sellRatio: Math.max(0, toNumber(raw.sellRatio, DEFAULT_SELL_RATIO)),
    bargainDC: Math.max(0, toInt(raw.bargainDC, DEFAULT_BARGAIN_DC)),
    bargainAdvantage: raw.bargainAdvantage === true,
    allowedSkills: dedupeAllowedSkills(raw.allowedSkills),
    allowedUserIds: toStrArray(raw.allowedUserIds),
    chatHidden: raw.chatHidden === true,
    items: inventory.map(normalizeInventoryRow).filter(Boolean),
  };
}

function dedupeAllowedSkills(raw) {
  const list = toStrArray(raw);
  if (list.length === 0) return [...DEFAULT_ALLOWED_SKILLS];
  return list.filter((skill) => BARGAIN_SKILLS[skill]);
}

/**
 * Build a fresh merchant with sane defaults — used by the workspace
 * "New Merchant" button.
 */
export function createBlankMerchant(overrides = {}) {
  return normalizeMerchant({
    id: generateId(),
    name: "New Merchant",
    art: "icons/svg/shop.svg",
    description: "",
    defaultMarkup: DEFAULT_MARKUP,
    sellRatio: DEFAULT_SELL_RATIO,
    bargainDC: DEFAULT_BARGAIN_DC,
    allowedSkills: [...DEFAULT_ALLOWED_SKILLS],
    allowedUserIds: [],
    items: [],
    ...overrides,
  });
}

/**
 * Build a fresh inventory row from a compendium item UUID + optional
 * starting quantity / price override.
 */
export function createInventoryRow(uuid, opts = {}) {
  return normalizeInventoryRow({
    uuid,
    qty: opts.startingQty ?? opts.qty ?? 1,
    startingQty: opts.startingQty ?? opts.qty ?? 1,
    unlimited: opts.unlimited === true,
    priceOverrideGp: opts.priceOverrideGp ?? null,
    notes: opts.notes ?? "",
  });
}

/* ------------------------------------------------------------------ *
 * Pricing math
 * ------------------------------------------------------------------ */

/**
 * Resolve the base price of an inventory row using the merchant's
 * markup, the row override, and the resolved item's `system.price`.
 * Returns a positive gp number, or 0 when the item has no price data.
 */
export function computeBuyPriceGp(merchant, row, item) {
  if (!merchant || !row) return 0;
  if (row.priceOverrideGp != null) return Math.max(0, row.priceOverrideGp);
  const basePrice = resolveItemBasePriceGp(item);
  if (basePrice <= 0) return 0;
  return Math.max(0, basePrice * Math.max(0, merchant.defaultMarkup ?? 1));
}

/**
 * Resolve the sell-back price for an item the player owns. Independent
 * of stock — merchants buy anything sellable from the player.
 */
export function computeSellPriceGp(merchant, item) {
  const basePrice = resolveItemBasePriceGp(item);
  if (basePrice <= 0) return 0;
  return Math.max(0, basePrice * Math.max(0, merchant?.sellRatio ?? DEFAULT_SELL_RATIO));
}

/** Apply a bargain deltaPct (e.g. -20 for −20%) to a gp price. */
export function applyBargainDelta(basePriceGp, deltaPct) {
  const price = Math.max(0, Number(basePriceGp) || 0);
  const delta = Number(deltaPct) || 0;
  return Math.max(0, price * (1 + delta / 100));
}

/** Round a gp price to the nearest copper (2 decimal places). */
export function roundGp(gp) {
  const n = Math.max(0, Number(gp) || 0);
  return Math.round(n * 100) / 100;
}

/**
 * Extract the gp value of a dnd5e item snapshot. dnd5e stores
 * `system.price = { value, denomination }`. We coerce everything to gp.
 */
export function resolveItemBasePriceGp(item) {
  if (!item || typeof item !== "object") return 0;
  const price = item.system?.price ?? item.price ?? null;
  if (!price) return 0;
  const value = Number(price.value);
  if (!Number.isFinite(value) || value <= 0) return 0;
  const denom = String(price.denomination ?? "gp").toLowerCase();
  switch (denom) {
    case "pp":
      return value * 10;
    case "gp":
      return value;
    case "ep":
      return value * 0.5;
    case "sp":
      return value * 0.1;
    case "cp":
      return value * 0.01;
    default:
      return value;
  }
}

/* ------------------------------------------------------------------ *
 * Inventory mutations (pure)
 * ------------------------------------------------------------------ */

/**
 * Decrement an inventory row's quantity by `count`. Returns the
 * updated merchant record (new instance — never mutates input).
 *
 * Throws if the row doesn't exist or has insufficient stock and isn't
 * marked unlimited.
 */
export function decrementInventory(merchant, uuid, count = 1) {
  const m = normalizeMerchant(merchant);
  const idx = m.items.findIndex((row) => row.uuid === uuid);
  if (idx < 0) throw new Error(`item "${uuid}" not in merchant "${m.id}"`);
  const row = m.items[idx];
  const n = Math.max(1, toInt(count, 1));
  if (!row.unlimited && row.qty < n) {
    throw new Error(
      `out of stock: "${uuid}" has ${row.qty} but ${n} requested`,
    );
  }
  if (row.unlimited) return m;
  m.items[idx] = { ...row, qty: row.qty - n };
  return m;
}

/** Reset every row's qty back to its startingQty. */
export function restockAll(merchant) {
  const m = normalizeMerchant(merchant);
  m.items = m.items.map((row) =>
    row.unlimited ? row : { ...row, qty: row.startingQty },
  );
  return m;
}

/** Add or replace an inventory row by uuid. */
export function upsertInventoryRow(merchant, row) {
  const m = normalizeMerchant(merchant);
  const normalized = normalizeInventoryRow(row);
  if (!normalized) return m;
  const idx = m.items.findIndex((r) => r.uuid === normalized.uuid);
  if (idx < 0) m.items.push(normalized);
  else m.items[idx] = normalized;
  return m;
}

/** Remove an inventory row by uuid. */
export function removeInventoryRow(merchant, uuid) {
  const m = normalizeMerchant(merchant);
  m.items = m.items.filter((row) => row.uuid !== uuid);
  return m;
}

/** Whether a given user id may open a session for this merchant. */
export function isUserAllowed(merchant, userId) {
  if (!merchant || !userId) return false;
  const list = Array.isArray(merchant.allowedUserIds)
    ? merchant.allowedUserIds
    : [];
  return list.includes(userId);
}

/* ------------------------------------------------------------------ *
 * Foundry-backed CRUD
 *
 * Reads always degrade gracefully (return []). Writes throw if game
 * isn't available so callers learn about misuse early.
 * ------------------------------------------------------------------ */

/** Load every merchant record from the world setting. */
export function loadMerchants() {
  try {
    const raw = globalThis.game?.settings?.get?.(MODULE_ID, MERCHANT_SETTING_KEY);
    if (!Array.isArray(raw)) return [];
    return raw.map(normalizeMerchant);
  } catch {
    return [];
  }
}

/** Look up a merchant by id. */
export function findMerchant(id) {
  const want = toStr(id);
  if (!want) return null;
  return loadMerchants().find((m) => m.id === want) ?? null;
}

/** Persist the full merchant list. */
export async function saveMerchants(merchants) {
  if (!globalThis.game?.settings?.set) {
    throw new Error("NotInFoundry: saveMerchants requires game.settings");
  }
  const cleaned = (Array.isArray(merchants) ? merchants : []).map(
    normalizeMerchant,
  );
  await globalThis.game.settings.set(
    MODULE_ID,
    MERCHANT_SETTING_KEY,
    cleaned,
  );
  return cleaned;
}

/** Insert-or-replace a single merchant; returns the saved list. */
export async function upsertMerchant(merchant) {
  const normalized = normalizeMerchant(merchant);
  const list = loadMerchants();
  const idx = list.findIndex((m) => m.id === normalized.id);
  if (idx < 0) list.push(normalized);
  else list[idx] = normalized;
  return saveMerchants(list);
}

/** Delete a merchant by id; returns the saved list. */
export async function deleteMerchant(id) {
  const want = toStr(id);
  if (!want) return loadMerchants();
  const list = loadMerchants().filter((m) => m.id !== want);
  return saveMerchants(list);
}
