/**
 * Infinity D&D5e — Merchant Currency Helpers
 *
 * Subtracts a gp-denominated amount from a dnd5e actor's wallet,
 * preserving high-denomination coins where possible and only "breaking
 * change" when forced to.
 *
 * The planner (`planCurrencyDeduction`) is pure — given a wallet and a
 * gp amount, it returns the resulting wallet shape, or null when funds
 * are insufficient. The Foundry-touching `deductCurrency` reads/writes
 * `actor.system.currency` and uses the planner under the hood.
 *
 * Pairs with `currencyAddFromBreakdown()` in loot/hoard-budget.js,
 * which handles the inverse (adding coins after a sale).
 */

const MODULE_ID = "infinity-dnd5e";

/** Copper value of one coin of each denomination. */
const COIN_VALUE_CP = Object.freeze({
  pp: 1000,
  gp: 100,
  ep: 50,
  sp: 10,
  cp: 1,
});

/** Denominations from highest to lowest. */
const DENOM_HIGH_TO_LOW = Object.freeze(["pp", "gp", "ep", "sp", "cp"]);

/**
 * Adjacent-denom step used when breaking a coin to make change. We
 * skip ep on the gp→lower path so a player who didn't have electrum
 * doesn't suddenly grow some.
 */
const NEXT_LOWER = Object.freeze({
  pp: "gp",
  gp: "sp",
  ep: "sp",
  sp: "cp",
  cp: null,
});

/* ------------------------------------------------------------------ *
 * Pure planning
 * ------------------------------------------------------------------ */

/** Coerce a wallet input to a clean integer pool. Missing keys → 0. */
export function sanitizeWallet(wallet) {
  const pool = { pp: 0, gp: 0, ep: 0, sp: 0, cp: 0 };
  if (!wallet || typeof wallet !== "object") return pool;
  for (const denom of DENOM_HIGH_TO_LOW) {
    const n = Math.floor(Number(wallet[denom]));
    pool[denom] = Number.isFinite(n) && n > 0 ? n : 0;
  }
  return pool;
}

/** Total wallet value in copper pieces. */
export function totalWalletCp(wallet) {
  const pool = sanitizeWallet(wallet);
  return DENOM_HIGH_TO_LOW.reduce(
    (sum, denom) => sum + pool[denom] * COIN_VALUE_CP[denom],
    0,
  );
}

/** Total wallet value in gp (decimal). */
export function totalWalletGp(wallet) {
  return totalWalletCp(wallet) / 100;
}

/**
 * Plan a deduction from a wallet. Pure; returns a new wallet shape or
 * null when the wallet can't cover the amount.
 *
 * @param {object} wallet         { pp, gp, ep, sp, cp }
 * @param {number} gpAmount       amount to deduct, in gp (decimal allowed)
 * @returns {object|null}         new wallet, or null on insufficient funds
 */
export function planCurrencyDeduction(wallet, gpAmount) {
  const owedCp = Math.round(Number(gpAmount) * 100);
  if (!Number.isFinite(owedCp) || owedCp <= 0) {
    return sanitizeWallet(wallet);
  }
  const pool = sanitizeWallet(wallet);
  if (totalWalletCp(pool) < owedCp) return null;

  let owe = owedCp;
  let safetyCounter = 0;
  while (owe > 0 && safetyCounter < 64) {
    safetyCounter++;

    // Pay greedy: any denom whose value fits in what we owe, take it.
    let paid = false;
    for (const denom of DENOM_HIGH_TO_LOW) {
      const value = COIN_VALUE_CP[denom];
      if (pool[denom] <= 0 || value > owe) continue;
      const coins = Math.min(pool[denom], Math.floor(owe / value));
      if (coins > 0) {
        pool[denom] -= coins;
        owe -= coins * value;
        paid = true;
      }
    }
    if (owe <= 0) break;

    // Need to break change. Find the smallest higher denom with stock.
    let broke = false;
    for (let i = DENOM_HIGH_TO_LOW.length - 1; i >= 0; i--) {
      const denom = DENOM_HIGH_TO_LOW[i];
      if (pool[denom] <= 0 || COIN_VALUE_CP[denom] <= owe) continue;
      const lower = NEXT_LOWER[denom];
      if (!lower) continue;
      const ratio = COIN_VALUE_CP[denom] / COIN_VALUE_CP[lower];
      pool[denom] -= 1;
      pool[lower] += ratio;
      broke = true;
      break;
    }
    if (!broke && !paid) return null;
  }

  return pool;
}

/* ------------------------------------------------------------------ *
 * Foundry-side wrappers
 * ------------------------------------------------------------------ */

/**
 * Deduct a gp amount from an actor's wallet. Returns:
 *  - { ok: true, before, after, gpAmount } on success
 *  - { ok: false, reason: "insufficient", before, gpAmount } on insufficient funds
 *  - { ok: false, reason: "no-actor" } if the actor isn't usable
 *
 * Throws nothing — caller decides how to surface failures.
 */
export async function deductCurrency(actor, gpAmount) {
  if (!actor || typeof actor.update !== "function") {
    return { ok: false, reason: "no-actor" };
  }
  const before = sanitizeWallet(actor.system?.currency);
  const after = planCurrencyDeduction(before, gpAmount);
  if (!after) return { ok: false, reason: "insufficient", before, gpAmount };

  try {
    await actor.update({
      "system.currency.pp": after.pp,
      "system.currency.gp": after.gp,
      "system.currency.ep": after.ep,
      "system.currency.sp": after.sp,
      "system.currency.cp": after.cp,
    });
    return { ok: true, before, after, gpAmount };
  } catch (error) {
    console.error(`${MODULE_ID} | currency deduction failed`, error);
    return { ok: false, reason: "update-failed", error, before, gpAmount };
  }
}

/**
 * Difference between two wallets (after − before) as a positive delta
 * map. Useful for rendering "you spent ..." receipts.
 */
export function diffWallets(before, after) {
  const b = sanitizeWallet(before);
  const a = sanitizeWallet(after);
  const out = {};
  for (const denom of DENOM_HIGH_TO_LOW) {
    const delta = a[denom] - b[denom];
    if (delta !== 0) out[denom] = delta;
  }
  return out;
}
