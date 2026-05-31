import assert from "node:assert/strict";

import {
  diffWallets,
  planCurrencyDeduction,
  sanitizeWallet,
  totalWalletCp,
  totalWalletGp,
} from "./merchant/currency.js";

/* ------------------------------------------------------------------ *
 * sanitizeWallet
 * ------------------------------------------------------------------ */
{
  assert.deepEqual(sanitizeWallet({ gp: 5, sp: 3 }), {
    pp: 0,
    gp: 5,
    ep: 0,
    sp: 3,
    cp: 0,
  });
  assert.deepEqual(sanitizeWallet(null), { pp: 0, gp: 0, ep: 0, sp: 0, cp: 0 });
  assert.deepEqual(sanitizeWallet({ gp: -1, sp: NaN, cp: "5" }), {
    pp: 0,
    gp: 0,
    ep: 0,
    sp: 0,
    cp: 5,
  });
}

/* ------------------------------------------------------------------ *
 * Totals
 * ------------------------------------------------------------------ */
{
  assert.equal(totalWalletCp({ pp: 1, gp: 2, ep: 1, sp: 3, cp: 4 }),
    1000 + 200 + 50 + 30 + 4);
  assert.equal(totalWalletGp({ gp: 5, sp: 5 }), 5.5);
}

/* ------------------------------------------------------------------ *
 * planCurrencyDeduction — exact pays
 * ------------------------------------------------------------------ */
{
  const wallet = { pp: 0, gp: 100, ep: 0, sp: 0, cp: 0 };
  const after = planCurrencyDeduction(wallet, 10);
  assert.deepEqual(after, { pp: 0, gp: 90, ep: 0, sp: 0, cp: 0 });
}

{
  // Mixed denoms, exact amount drains exactly: 5 gp + 5 sp = 5.5 gp.
  const wallet = { pp: 0, gp: 5, ep: 0, sp: 5, cp: 0 };
  const after = planCurrencyDeduction(wallet, 5.5);
  assert.deepEqual(after, { pp: 0, gp: 0, ep: 0, sp: 0, cp: 0 });
}

/* ------------------------------------------------------------------ *
 * Insufficient funds → null
 * ------------------------------------------------------------------ */
{
  const wallet = { pp: 0, gp: 5, ep: 0, sp: 0, cp: 0 };
  assert.equal(planCurrencyDeduction(wallet, 6), null);
}

/* ------------------------------------------------------------------ *
 * Breaks change down: 1 pp → 10 gp → 10 sp → 10 cp
 * ------------------------------------------------------------------ */
{
  const wallet = { pp: 1, gp: 0, ep: 0, sp: 0, cp: 0 };
  const after = planCurrencyDeduction(wallet, 0.05); // 5 cp owed
  assert.ok(after, "result not null");
  const totalAfter = totalWalletCp(after);
  assert.equal(totalAfter, 995, "wallet drained by exactly 5 cp");
}

{
  // Break a single gp down to make 7 cp change.
  const wallet = { pp: 0, gp: 1, ep: 0, sp: 0, cp: 0 };
  const after = planCurrencyDeduction(wallet, 0.07);
  assert.ok(after);
  assert.equal(totalWalletCp(after), 93);
}

/* ------------------------------------------------------------------ *
 * Prefers larger denominations first
 * ------------------------------------------------------------------ */
{
  const wallet = { pp: 2, gp: 5, ep: 0, sp: 0, cp: 0 };
  // Spend 15 gp: should take 1 pp (10) + 5 gp (5) and leave 1 pp, 0 gp.
  const after = planCurrencyDeduction(wallet, 15);
  assert.deepEqual(after, { pp: 1, gp: 0, ep: 0, sp: 0, cp: 0 });
}

/* ------------------------------------------------------------------ *
 * Zero amount is a no-op (returns a clean wallet)
 * ------------------------------------------------------------------ */
{
  const wallet = { gp: 5, sp: 3 };
  const after = planCurrencyDeduction(wallet, 0);
  assert.deepEqual(after, sanitizeWallet(wallet));
}

/* ------------------------------------------------------------------ *
 * diffWallets
 * ------------------------------------------------------------------ */
{
  const before = { gp: 100, sp: 5 };
  const after = { gp: 90, sp: 0 };
  assert.deepEqual(diffWallets(before, after), { gp: -10, sp: -5 });
}

process.stdout.write("merchant-currency validation passed\n");
