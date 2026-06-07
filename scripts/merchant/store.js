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

import {
  RARITY_BALANCE_CUSTOM_KEY,
  RARITY_BALANCE_DEFAULT_KEY,
  normalizeRarityBalanceKey,
  resolveRarityWeights,
} from "../loot/rarity-balance.js";
import { isAmmunitionItem } from "../loot/tag-vocabulary.js";

const MODULE_ID = "infinity-dnd5e";
export const MERCHANT_SETTING_KEY = "merchants";
export const MERCHANT_RECORD_VERSION = 1;

const DEFAULT_MARKUP = 1.0;
const DEFAULT_SELL_RATIO = 0.5;
const DEFAULT_BARGAIN_DC = 15;
const DEFAULT_BARGAIN_SUCCESS_PCT = 10;
const DEFAULT_BARGAIN_FAIL_PCT = 10;
const DEFAULT_ALLOWED_SKILLS = Object.freeze(["per", "dec"]);
const DEFAULT_POOL_COUNT = 6;

/** Always-on passive haggle: a charismatic shopper nudges prices before any
 *  roll. Defaults below shift the price 2% per point of passive skill away
 *  from the "average commoner" baseline of 10, capped at ±20%. */
const DEFAULT_PASSIVE_PCT_PER_POINT = 2;
const DEFAULT_PASSIVE_CAP_PCT = 20;

/** Passive haggle anchors against this "average person" passive score: a
 *  passive of 10 yields no nudge; higher helps the shopper, lower hurts. */
export const PASSIVE_HAGGLE_BASELINE = 10;

/** Legacy bargain skill ids → their corrected dnd5e ids. `prf` (Performance)
 *  was historically mislabeled "Persuasion"; Persuasion's real id is `per`. */
const LEGACY_SKILL_ALIASES = Object.freeze({ prf: "per" });

/**
 * Self-service shop-access modes — whether an allowed player can open a session
 * on their own initiative (vs. the GM pulling them in via the workspace):
 *   - "off"   : GM-pull only. The kill switch; the shop never appears in a
 *               player's Shops picker.
 *   - "open"  : any allowed player can walk in and open a live session.
 *   - "knock" : allowed players request entry; the GM approves each one.
 */
export const SELF_SERVICE_MODES = Object.freeze(["off", "open", "knock"]);
const DEFAULT_SELF_SERVICE_MODE = "off";

/** A full stack of ammunition (arrows, bolts, bullets, needles). Merchants
 *  always stock ammo in this unit so quivers come full. */
export const AMMO_STACK_SIZE = 20;

const DEFAULT_BARGAIN_TIERS = Object.freeze([
  Object.freeze({ id: "crit-success", minMargin: 10, deltaPct: -20 }),
  Object.freeze({ id: "success", minMargin: 0, deltaPct: -10 }),
  Object.freeze({ id: "failure", minMargin: -9, deltaPct: 10 }),
  Object.freeze({ id: "crit-failure", minMargin: -Infinity, deltaPct: 20 }),
]);

/** Skills the GM can allow for bargaining. Display labels for the UI.
 *  Ids are dnd5e skill keys — `per` is Persuasion (NOT `prf`, which is
 *  Performance). Legacy `prf` records are migrated in dedupeAllowedSkills. */
export const BARGAIN_SKILLS = Object.freeze({
  per: "Persuasion",
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
  const stamp = Math.floor(Math.random() * 0x100000)
    .toString(16)
    .padStart(5, "0");
  const tail = Math.floor(Math.random() * 0x100000)
    .toString(16)
    .padStart(5, "0");
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
    overrideRaw == null ||
    overrideRaw === "" ||
    !Number.isFinite(Number(overrideRaw))
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
  const allowedUserIds = toStrArray(raw.allowedUserIds);
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
    bargainSuccessPct: Math.max(
      0,
      toNumber(raw.bargainSuccessPct, DEFAULT_BARGAIN_SUCCESS_PCT),
    ),
    bargainFailPct: Math.max(
      0,
      toNumber(raw.bargainFailPct, DEFAULT_BARGAIN_FAIL_PCT),
    ),
    // Always-on passive haggle. Default ON so a charismatic shopper sees
    // baseline price movement without rolling; the GM can disable per merchant.
    passiveHaggle: raw.passiveHaggle !== false,
    passivePctPerPoint: Math.max(
      0,
      toNumber(raw.passivePctPerPoint, DEFAULT_PASSIVE_PCT_PER_POINT),
    ),
    passiveCapPct: Math.max(
      0,
      toNumber(raw.passiveCapPct, DEFAULT_PASSIVE_CAP_PCT),
    ),
    goldOnHand: normalizeGold(raw.goldOnHand),
    allowedSkills: dedupeAllowedSkills(raw.allowedSkills),
    allowedUserIds,
    // Whether allowed players can self-open this shop. Cold-start: a legacy
    // record with allowed players but no explicit mode upgrades to "open" so
    // the feature isn't invisible on first run; shops with no allowed players
    // stay "off". Once saved, the explicit value sticks (idempotent).
    selfServiceMode: normalizeSelfServiceMode(
      raw.selfServiceMode,
      allowedUserIds,
    ),
    chatHidden: raw.chatHidden === true,
    pool: normalizeStockPool(raw.pool),
    buyFilter: normalizeBuyFilter(raw.buyFilter),
    // mergeStockRows keeps the invariant "one row per uuid" — self-heals any
    // legacy data that ever doubled an item onto two rows.
    items: mergeStockRows(inventory.map(normalizeInventoryRow).filter(Boolean)),
  };
}

/**
 * Normalize a merchant's "Buys From Players" filter — the mirror of the
 * stock pool that gates which items the merchant will purchase. Empty
 * lists (the default) mean "buys anything sellable".
 */
export function normalizeBuyFilter(raw) {
  const f = raw && typeof raw === "object" ? raw : {};
  return {
    lootTypes: toStrArray(f.lootTypes),
    rarities: toStrArray(f.rarities),
  };
}

/**
 * Collapse inventory rows that point to the same library item (uuid) into a
 * single row, summing quantity + starting quantity. Keeps the first row's
 * price override / notes / unlimited flag. Pure: returns a new array.
 */
export function mergeStockRows(rows) {
  const list = Array.isArray(rows) ? rows : [];
  const byUuid = new Map();
  for (const row of list) {
    const normalized = normalizeInventoryRow(row);
    if (!normalized) continue;
    const existing = byUuid.get(normalized.uuid);
    if (!existing) {
      byUuid.set(normalized.uuid, { ...normalized });
      continue;
    }
    // Merge: unlimited stays unlimited; otherwise sum the stacks.
    existing.unlimited = existing.unlimited || normalized.unlimited;
    existing.qty = existing.unlimited
      ? existing.qty
      : existing.qty + normalized.qty;
    existing.startingQty += normalized.startingQty;
    if (
      existing.priceOverrideGp == null &&
      normalized.priceOverrideGp != null
    ) {
      existing.priceOverrideGp = normalized.priceOverrideGp;
    }
    if (!existing.notes && normalized.notes) existing.notes = normalized.notes;
  }
  return [...byUuid.values()];
}

/**
 * Normalize a merchant's randomized stock pool config. Lenient: the
 * workspace UI only submits known loot-type / rarity values, so this
 * just dedupes strings and clamps the count.
 */
export function normalizeStockPool(raw) {
  const p = raw && typeof raw === "object" ? raw : {};
  const rarityBalance = normalizeRarityBalanceKey(
    p.rarityBalance ??
      (p.rarityWeights
        ? RARITY_BALANCE_CUSTOM_KEY
        : RARITY_BALANCE_DEFAULT_KEY),
  );
  return {
    lootTypes: toStrArray(p.lootTypes),
    rarities: toStrArray(p.rarities),
    // 0 = no line cap (an explicit blank "How many" → fill toward budgetGp).
    // A missing field still defaults to DEFAULT_POOL_COUNT for back-compat.
    count: Math.min(50, Math.max(0, toInt(p.count, DEFAULT_POOL_COUNT))),
    // Total stock value to fill toward; 0 = no budget (use count instead).
    budgetGp: Math.max(0, toInt(p.budgetGp, 0)),
    rarityBalance,
    rarityWeights: resolveRarityWeights(rarityBalance, p.rarityWeights),
    // Per-item gp value band; 0 = no floor / no ceiling. A value cap doubles
    // as a market-realism dial (cheap = common, pricey = rare).
    minGp: Math.max(0, toInt(p.minGp, 0)),
    maxGp: Math.max(0, toInt(p.maxGp, 0)),
  };
}

/**
 * Resolve the starting quantity for a newly-stocked item. Ammunition is
 * always stocked as a full stack of 20 (a full quiver); everything else
 * uses the requested quantity, defaulting to 1.
 */
export function resolveStockQty(item, requested = 1) {
  if (isAmmunitionItem(item)) return AMMO_STACK_SIZE;
  const n = Math.floor(Number(requested));
  return Number.isFinite(n) && n >= 1 ? n : 1;
}

function dedupeAllowedSkills(raw) {
  // Migrate legacy ids (prf→per) before validating, then drop unknowns and
  // any duplicate the migration produced.
  const migrated = toStrArray(raw).map((s) => LEGACY_SKILL_ALIASES[s] ?? s);
  const list = [...new Set(migrated)];
  if (list.length === 0) return [...DEFAULT_ALLOWED_SKILLS];
  const valid = list.filter((skill) => BARGAIN_SKILLS[skill]);
  return valid.length > 0 ? valid : [...DEFAULT_ALLOWED_SKILLS];
}

/**
 * Resolve the self-service mode. A recognized explicit value always wins. When
 * the field is absent/unknown, apply the cold-start rule: a record that already
 * has allowed players upgrades to "open" (so a just-upgraded world isn't a wall
 * of empty pickers), otherwise it stays "off".
 */
function normalizeSelfServiceMode(raw, allowedUserIds) {
  const v = toStr(raw).toLowerCase();
  if (SELF_SERVICE_MODES.includes(v)) return v;
  // A present-but-unrecognized value (corruption / external edit) fails CLOSED
  // to "off" rather than cold-starting to "open" — only a genuinely absent
  // field gets the cold-start upgrade below.
  if (v) return DEFAULT_SELF_SERVICE_MODE;
  const allowed = Array.isArray(allowedUserIds) ? allowedUserIds : [];
  return allowed.length > 0 ? "open" : DEFAULT_SELF_SERVICE_MODE;
}

/** Gold-on-hand normalizer: blank / undefined → null (unlimited). A real
 *  0 means a broke merchant that can't buy anything. */
function normalizeGold(raw) {
  if (raw == null || raw === "") return null;
  const n = Number(raw);
  return Number.isFinite(n) ? Math.max(0, n) : null;
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
 * Build a duplicate of an existing merchant — same configuration (markup,
 * sell ratio, bargain settings, allowed skills/players, stock pool, gold),
 * a fresh id, an empty inventory, and a "(Copy)" suffixed name. Pure: never
 * mutates the source. Used by the workspace "Duplicate" button so a curated
 * merchant can serve as a template for the next one.
 */
export function duplicateMerchant(merchant, overrides = {}) {
  const source = normalizeMerchant(merchant);
  return normalizeMerchant({
    ...source,
    id: generateId(),
    name: overrides.name ?? `${source.name} (Copy)`,
    items: [],
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
  return Math.max(
    0,
    basePrice * Math.max(0, merchant?.sellRatio ?? DEFAULT_SELL_RATIO),
  );
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

/** Remove every inventory row (keeps the merchant and its config). */
export function clearInventory(merchant) {
  const m = normalizeMerchant(merchant);
  m.items = [];
  return m;
}

/**
 * Adjust a merchant's gold-on-hand by `deltaGp` (positive = gains, e.g. a
 * player buying from it; negative = spends, e.g. buying a player's goods).
 * Unlimited merchants (goldOnHand == null) are returned unchanged.
 * Result is clamped to >= 0 and rounded to the nearest copper.
 */
export function adjustMerchantGold(merchant, deltaGp) {
  const m = normalizeMerchant(merchant);
  if (m.goldOnHand == null) return m; // unlimited purse
  const next = Math.max(0, m.goldOnHand + (Number(deltaGp) || 0));
  m.goldOnHand = Math.round(next * 100) / 100;
  return m;
}

/** Whether the merchant can pay `gp` for a player's goods (unlimited → always). */
export function merchantCanAfford(merchant, gp) {
  const g = merchant?.goldOnHand;
  if (g == null) return true;
  return g >= (Number(gp) || 0);
}

/**
 * Build the merchant's two-tier bargain schedule from its success / fail
 * percentages (no critical distinction — a crit behaves like a normal
 * success/failure). Success yields a negative delta (lowers a buy price;
 * the sell path inverts it into a higher payout); failure raises it.
 */
export function buildMerchantBargainTiers(merchant) {
  const success = Math.max(
    0,
    toNumber(merchant?.bargainSuccessPct, DEFAULT_BARGAIN_SUCCESS_PCT),
  );
  const fail = Math.max(
    0,
    toNumber(merchant?.bargainFailPct, DEFAULT_BARGAIN_FAIL_PCT),
  );
  return [
    { id: "success", minMargin: 0, deltaPct: -success },
    { id: "failure", minMargin: -Infinity, deltaPct: fail },
  ];
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

/** True when `userId` resolves to a GM user. Lazy game read; false in node. */
function isUserIdGM(userId) {
  try {
    return globalThis.game?.users?.get?.(userId)?.isGM === true;
  } catch {
    return false;
  }
}

/**
 * Whether a given user id may open a *player* session for this merchant. GMs
 * are never "allowed" players — they use the GM Preview path, not the live
 * player session — so a stray GM id in `allowedUserIds` can't auto-open a
 * real (data-mutating) session on the GM's own client.
 */
export function isUserAllowed(merchant, userId) {
  if (!merchant || !userId) return false;
  if (isUserIdGM(userId)) return false;
  const list = Array.isArray(merchant.allowedUserIds)
    ? merchant.allowedUserIds
    : [];
  return list.includes(userId);
}

/** The shop's self-service mode ("off" | "open" | "knock"), validated. */
export function getSelfServiceMode(merchant) {
  const m = toStr(merchant?.selfServiceMode).toLowerCase();
  return SELF_SERVICE_MODES.includes(m) ? m : DEFAULT_SELF_SERVICE_MODE;
}

/**
 * Whether allowed players can reach this shop on their own — true for both
 * "open" (walk in) and "knock" (request entry). "off" shops are GM-pull only
 * and never surface in a player's Shops picker.
 */
export function isSelfServiceReachable(merchant) {
  return getSelfServiceMode(merchant) !== "off";
}

/**
 * The single authority gate for player-initiated shop access — used by BOTH
 * the Shops list reply and an inbound shop-open request. A user may self-open a
 * shop only if they are an allowed (non-GM) player AND the shop is self-service
 * reachable (open or knock). Never trust the client; the GM re-checks this.
 */
export function canSelfOpen(merchant, userId) {
  return isUserAllowed(merchant, userId) && isSelfServiceReachable(merchant);
}

/**
 * Project a merchant to the minimal, safe shape a player may see in the Shops
 * picker. The MERCHANTS setting is world-scoped (every client can read the raw
 * records), so the GM-side list reply MUST strip economy + permission internals
 * — goldOnHand, markups, priceOverrideGp, buyFilter, other players' allow-lists
 * — leaving only what's needed to render and pick a storefront.
 */
export function sanitizeMerchantForList(merchant) {
  const m = normalizeMerchant(merchant);
  return {
    id: m.id,
    name: m.name,
    art: m.art,
    description: m.description,
    selfServiceMode: m.selfServiceMode,
  };
}

/* ------------------------------------------------------------------ *
 * GM Preview (sandbox) math
 *
 * Pure: apply a simulated buy/sell to an in-memory merchant clone so the GM
 * can drive the shop window without touching real data. Reuses the same
 * stock + gold primitives the live path uses.
 * ------------------------------------------------------------------ */

/** Preview a buy: decrement finite stock + the merchant gains `totalGp`. */
export function applyPreviewBuy(merchant, uuid, qty, totalGp) {
  let m = normalizeMerchant(merchant);
  const row = m.items.find((r) => r.uuid === uuid);
  const count = Math.max(1, Math.floor(Number(qty) || 1));
  if (row && !row.unlimited && row.qty >= count) {
    try {
      m = decrementInventory(m, uuid, count);
    } catch {
      // leave stock alone if the decrement can't apply
    }
  }
  return adjustMerchantGold(m, Math.max(0, Number(totalGp) || 0));
}

/** Preview a sell: the merchant pays out `totalGp` (clamped at 0). */
export function applyPreviewSell(merchant, totalGp) {
  return adjustMerchantGold(
    normalizeMerchant(merchant),
    -Math.max(0, Number(totalGp) || 0),
  );
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
    const raw = globalThis.game?.settings?.get?.(
      MODULE_ID,
      MERCHANT_SETTING_KEY,
    );
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
  await globalThis.game.settings.set(MODULE_ID, MERCHANT_SETTING_KEY, cleaned);
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
