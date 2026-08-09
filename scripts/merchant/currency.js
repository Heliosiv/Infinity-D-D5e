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

/**
 * Read a canonical wallet without repairing malformed values.
 *
 * Missing denominations are valid and normalize to zero. A denomination that
 * is present must be a finite, non-negative integer; merchant write
 * verification must never let the lenient planning sanitizer hide corruption.
 */
export function readWalletStrict(wallet) {
  const pool = { pp: 0, gp: 0, ep: 0, sp: 0, cp: 0 };
  if (!wallet || typeof wallet !== "object") {
    return { ok: false, reason: "invalid-wallet", wallet: pool };
  }
  for (const denom of DENOM_HIGH_TO_LOW) {
    const raw = wallet[denom];
    if (raw === undefined) continue;
    if (raw === null || raw === "" || typeof raw === "boolean") {
      return {
        ok: false,
        reason: "invalid-wallet",
        denomination: denom,
        value: raw,
        wallet: pool,
      };
    }
    const value = Number(raw);
    if (!Number.isSafeInteger(value) || value < 0) {
      return {
        ok: false,
        reason: "invalid-wallet",
        denomination: denom,
        value: raw,
        wallet: pool,
      };
    }
    pool[denom] = value;
  }
  let totalCopper = 0;
  for (const denom of DENOM_HIGH_TO_LOW) {
    const copper = pool[denom] * COIN_VALUE_CP[denom];
    if (
      !Number.isSafeInteger(copper) ||
      !Number.isSafeInteger(totalCopper + copper)
    ) {
      return {
        ok: false,
        reason: "invalid-wallet",
        denomination: denom,
        value: pool[denom],
        wallet: pool,
      };
    }
    totalCopper += copper;
  }
  return { ok: true, reason: "", wallet: pool };
}

/** Whether a positive gp amount is exactly representable to the nearest cp. */
export function isSafeGpAmount(value, { allowZero = false } = {}) {
  const gp = Number(value);
  if (!Number.isFinite(gp) || gp < 0 || (!allowZero && gp === 0)) return false;
  const copper = Math.round(gp * 100);
  return (
    Number.isSafeInteger(copper) && (allowZero ? copper >= 0 : copper >= 1)
  );
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

/** Whether two wallets have the exact same normalized denominations. */
export function walletsEqual(left, right) {
  const a = sanitizeWallet(left);
  const b = sanitizeWallet(right);
  return DENOM_HIGH_TO_LOW.every((denom) => a[denom] === b[denom]);
}

/** Build the flattened dnd5e Actor update for one normalized wallet. */
export function currencyUpdate(wallet) {
  const target = sanitizeWallet(wallet);
  return Object.fromEntries(
    DENOM_HIGH_TO_LOW.map((denom) => [
      `system.currency.${denom}`,
      target[denom],
    ]),
  );
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
  const amount = Number(gpAmount);
  if (!Number.isFinite(amount) || amount < 0) return null;
  const owedCp = Math.round(amount * 100);
  if (!Number.isSafeInteger(owedCp)) return null;
  if (owedCp === 0 && amount === 0) {
    return sanitizeWallet(wallet);
  }
  if (owedCp < 1) return null;
  const pool = sanitizeWallet(wallet);
  const availableCp = DENOM_HIGH_TO_LOW.reduce(
    (sum, denom) => sum + pool[denom] * COIN_VALUE_CP[denom],
    0,
  );
  if (!Number.isSafeInteger(availableCp) || availableCp < owedCp) return null;

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
  const read = readWalletStrict(actor.system?.currency);
  if (!read.ok) {
    return {
      ok: false,
      reason: "invalid-wallet",
      before: null,
      actual: actor.system?.currency ?? null,
      gpAmount,
    };
  }
  const before = read.wallet;
  if (!isSafeGpAmount(gpAmount)) {
    return { ok: false, reason: "invalid-amount", before, gpAmount };
  }
  const after = planCurrencyDeduction(before, gpAmount);
  if (!after) return { ok: false, reason: "insufficient", before, gpAmount };

  const update = await updateCurrencyVerified(actor, after);
  if (!update.ok) {
    if (update.error) {
      console.error(`${MODULE_ID} | currency deduction failed`, update.error);
    }
    return {
      ok: false,
      reason: update.reason,
      error: update.error,
      before,
      after: update.actual,
      expectedAfter: after,
      gpAmount,
    };
  }
  return { ok: true, before, after: update.actual, gpAmount };
}

/**
 * Write an exact wallet and require both a confirming Actor return value and
 * canonical actor.system.currency read-back.
 */
export async function updateCurrencyVerified(
  actor,
  wallet,
  { authorizeWrite = null } = {},
) {
  const expectedRead = readWalletStrict(wallet);
  const expected = expectedRead.wallet;
  if (!expectedRead.ok) {
    return {
      ok: false,
      reason: "invalid-wallet",
      expected,
      actual: actor?.system?.currency ?? null,
    };
  }
  if (!actor || typeof actor.update !== "function") {
    return {
      ok: false,
      reason: "update-unconfirmed",
      expected,
      actual: actor?.system?.currency ?? null,
    };
  }
  if (!currencyWriteAuthorized(authorizeWrite)) {
    return currencyAuthorityLostResult(actor, expected, true);
  }
  let returned;
  try {
    returned = await actor.update(currencyUpdate(expected));
  } catch (error) {
    if (!currencyWriteAuthorized(authorizeWrite)) {
      return currencyAuthorityLostResult(actor, expected, false, error);
    }
    return {
      ok: false,
      reason: "update-failed",
      error,
      expected,
      actual: readWalletStrict(actor.system?.currency).wallet,
    };
  }
  // Actor.update yields to Foundry hooks and the server. Recheck the caller's
  // epoch fence before treating any canonical state as this authority's write.
  // A post-await loss is necessarily ambiguous: the update may have landed.
  if (!currencyWriteAuthorized(authorizeWrite)) {
    return currencyAuthorityLostResult(actor, expected, false);
  }
  const actualRead = readWalletStrict(actor.system?.currency);
  const actual = actualRead.wallet;
  const returnedActor =
    Boolean(returned) &&
    (returned === actor ||
      (actor.id &&
        String(returned?.id ?? returned?._id ?? "") === String(actor.id)));
  const ok =
    returnedActor &&
    actualRead.ok &&
    DENOM_HIGH_TO_LOW.every((denom) => actual[denom] === expected[denom]);
  return {
    ok,
    reason: ok ? "" : actualRead.ok ? "update-unconfirmed" : "invalid-wallet",
    expected,
    actual,
  };
}

function currencyWriteAuthorized(authorizeWrite) {
  if (authorizeWrite == null) return true;
  if (typeof authorizeWrite !== "function") return false;
  try {
    return authorizeWrite() === true;
  } catch {
    return false;
  }
}

function currencyAuthorityLostResult(
  actor,
  expected,
  provenUnapplied,
  error = null,
) {
  const actual = readWalletStrict(actor?.system?.currency).wallet;
  return {
    ok: false,
    reason: "authority-lost",
    expected,
    actual,
    provenUnapplied: provenUnapplied === true,
    ...(error ? { error } : {}),
  };
}

/**
 * Compensation helper. Exact canonical read-back is the success condition,
 * including when a cancelled operation already left the desired wallet intact.
 */
export async function ensureCurrency(actor, wallet) {
  const expectedRead = readWalletStrict(wallet);
  const expected = expectedRead.wallet;
  if (!expectedRead.ok) {
    return {
      ok: false,
      reason: "invalid-wallet",
      expected,
      actual: actor?.system?.currency ?? null,
    };
  }
  if (!actor || typeof actor.update !== "function") {
    return {
      ok: false,
      reason: "update-unconfirmed",
      expected,
      actual: actor?.system?.currency ?? null,
    };
  }
  let actualRead = readWalletStrict(actor.system?.currency);
  let actual = actualRead.wallet;
  if (
    actualRead.ok &&
    DENOM_HIGH_TO_LOW.every((denom) => actual[denom] === expected[denom])
  ) {
    return { ok: true, reason: "", expected, actual };
  }
  let error = null;
  try {
    await actor.update(currencyUpdate(expected));
  } catch (caught) {
    error = caught;
  }
  actualRead = readWalletStrict(actor.system?.currency);
  actual = actualRead.wallet;
  const ok =
    actualRead.ok &&
    DENOM_HIGH_TO_LOW.every((denom) => actual[denom] === expected[denom]);
  return {
    ok,
    reason: ok ? "" : actualRead.ok ? "update-unconfirmed" : "invalid-wallet",
    error,
    expected,
    actual,
  };
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
