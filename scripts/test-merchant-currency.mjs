import assert from "node:assert/strict";

import {
  deductCurrency,
  diffWallets,
  ensureCurrency,
  planCurrencyDeduction,
  readWalletStrict,
  sanitizeWallet,
  totalWalletCp,
  totalWalletGp,
  updateCurrencyVerified,
} from "./merchant/currency.js";

function cloneWallet(wallet) {
  return structuredClone(wallet);
}

function applyCurrencyUpdate(actor, update) {
  for (const [path, value] of Object.entries(update)) {
    const match = /^system\.currency\.(pp|gp|ep|sp|cp)$/.exec(path);
    if (match) actor.system.currency[match[1]] = value;
  }
}

function makeCurrencyActor({
  id = "synthetic-hero",
  wallet = { pp: 0, gp: 10, ep: 0, sp: 0, cp: 0 },
  mode = "apply",
  returnValue = "actor",
} = {}) {
  const actor = {
    id,
    system: { currency: cloneWallet(wallet) },
    updateCalls: [],
    async update(update) {
      this.updateCalls.push(structuredClone(update));
      if (mode === "throw") throw new Error("currency update denied");
      if (mode === "apply") applyCurrencyUpdate(this, update);
      if (mode === "alter") {
        applyCurrencyUpdate(this, update);
        this.system.currency.gp += 1;
      }
      if (mode === "invalid-after") {
        applyCurrencyUpdate(this, update);
        this.system.currency.gp = -1;
      }
      if (returnValue === "undefined") return undefined;
      if (returnValue === "other-id") {
        return { id: "different-actor", system: this.system };
      }
      if (returnValue === "same-id-copy") {
        return { id: this.id, system: this.system };
      }
      return this;
    },
  };
  return actor;
}

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
  assert.equal(
    totalWalletCp({ pp: 1, gp: 2, ep: 1, sp: 3, cp: 4 }),
    1000 + 200 + 50 + 30 + 4,
  );
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

for (const amount of [
  Number.POSITIVE_INFINITY,
  Number.NaN,
  Number.MAX_VALUE,
  -1,
  0.001,
]) {
  assert.equal(
    planCurrencyDeduction({ gp: 10 }, amount),
    null,
    `unsafe deduction ${String(amount)} is rejected`,
  );
}

/* ------------------------------------------------------------------ *
 * diffWallets
 * ------------------------------------------------------------------ */
{
  const before = { gp: 100, sp: 5 };
  const after = { gp: 90, sp: 0 };
  assert.deepEqual(diffWallets(before, after), { gp: -10, sp: -5 });
}

/* ------------------------------------------------------------------ *
 * Strict canonical wallet reads
 * ------------------------------------------------------------------ */
{
  const result = readWalletStrict({ gp: "5", sp: 3 });
  assert.equal(result.ok, true);
  assert.deepEqual(result.wallet, {
    pp: 0,
    gp: 5,
    ep: 0,
    sp: 3,
    cp: 0,
  });
}

for (const [label, wallet] of [
  ["negative", { gp: -1 }],
  ["fractional", { gp: 1.5 }],
  ["not numeric", { gp: "five" }],
  ["not finite", { gp: Number.POSITIVE_INFINITY }],
  ["NaN", { gp: Number.NaN }],
  ["null denomination", { gp: null }],
  ["blank denomination", { gp: "" }],
  ["boolean denomination", { gp: false }],
  ["unsafe denomination", { gp: Number.MAX_SAFE_INTEGER }],
  ["missing wallet object", null],
]) {
  const result = readWalletStrict(wallet);
  assert.equal(result.ok, false, `${label} canonical wallet is invalid`);
  assert.equal(result.reason, "invalid-wallet");
}

/* ------------------------------------------------------------------ *
 * Verified currency writes
 * ------------------------------------------------------------------ */
{
  const actor = makeCurrencyActor();
  const result = await updateCurrencyVerified(actor, { gp: 4, sp: 2 });
  assert.equal(result.ok, true);
  assert.deepEqual(actor.system.currency, {
    pp: 0,
    gp: 4,
    ep: 0,
    sp: 2,
    cp: 0,
  });
  assert.equal(actor.updateCalls.length, 1);
}

{
  const actor = makeCurrencyActor({ mode: "noop" });
  const result = await updateCurrencyVerified(actor, { gp: 4 });
  assert.equal(result.ok, false);
  assert.equal(result.reason, "update-unconfirmed");
  assert.equal(result.actual.gp, 10, "canonical no-op is detected");
}

{
  const actor = makeCurrencyActor({
    mode: "apply",
    returnValue: "undefined",
  });
  const result = await updateCurrencyVerified(actor, { gp: 4 });
  assert.equal(result.ok, false);
  assert.equal(result.reason, "update-unconfirmed");
  assert.equal(
    actor.system.currency.gp,
    4,
    "canonical mutation alone does not satisfy primary write confirmation",
  );
}

{
  const actor = makeCurrencyActor({ mode: "alter" });
  const result = await updateCurrencyVerified(actor, { gp: 4 });
  assert.equal(result.ok, false);
  assert.equal(result.reason, "update-unconfirmed");
  assert.equal(result.actual.gp, 5, "hook-altered read-back is reported");
}

{
  const actor = makeCurrencyActor({
    mode: "apply",
    returnValue: "other-id",
  });
  const result = await updateCurrencyVerified(actor, { gp: 4 });
  assert.equal(result.ok, false);
  assert.equal(
    result.reason,
    "update-unconfirmed",
    "another Actor cannot confirm this Actor's write",
  );
}

{
  const actor = makeCurrencyActor({ mode: "invalid-after" });
  const result = await updateCurrencyVerified(actor, { gp: 4 });
  assert.equal(result.ok, false);
  assert.equal(
    result.reason,
    "invalid-wallet",
    "negative canonical read-back is distinguished from an ordinary mismatch",
  );
}

{
  const actor = makeCurrencyActor({ mode: "throw" });
  const result = await updateCurrencyVerified(actor, { gp: 4 });
  assert.equal(result.ok, false);
  assert.equal(result.reason, "update-failed");
  assert.match(result.error.message, /denied/);
}

{
  const actor = makeCurrencyActor();
  const result = await updateCurrencyVerified(
    actor,
    { gp: 4 },
    { authorizeWrite: () => false },
  );
  assert.equal(result.ok, false);
  assert.equal(result.reason, "authority-lost");
  assert.equal(result.provenUnapplied, true);
  assert.equal(
    actor.updateCalls.length,
    0,
    "lost authority prevents the write",
  );
  assert.equal(actor.system.currency.gp, 10);
}

{
  const actor = makeCurrencyActor();
  let authorized = true;
  const update = actor.update.bind(actor);
  actor.update = async (...args) => {
    const returned = await update(...args);
    authorized = false;
    return returned;
  };
  const result = await updateCurrencyVerified(
    actor,
    { gp: 4 },
    { authorizeWrite: () => authorized },
  );
  assert.equal(result.ok, false);
  assert.equal(result.reason, "authority-lost");
  assert.equal(result.provenUnapplied, false);
  assert.equal(
    actor.system.currency.gp,
    4,
    "a post-await authority loss reports the possibly applied canonical state",
  );
  assert.equal(
    actor.updateCalls.length,
    1,
    "post-write authority loss never attempts an unguarded second write",
  );
}

{
  const actor = makeCurrencyActor();
  const result = await updateCurrencyVerified(
    actor,
    { gp: 4 },
    {
      authorizeWrite() {
        throw new Error("stale epoch");
      },
    },
  );
  assert.equal(result.reason, "authority-lost");
  assert.equal(result.provenUnapplied, true);
  assert.equal(actor.updateCalls.length, 0, "a throwing fence fails closed");
}

/* ------------------------------------------------------------------ *
 * Deduction rejects invalid canonical state before writing
 * ------------------------------------------------------------------ */
for (const wallet of [{ gp: -1 }, { gp: 1.5 }, { gp: Number.NaN }]) {
  const actor = makeCurrencyActor({ wallet });
  const result = await deductCurrency(actor, 1);
  assert.equal(result.ok, false);
  assert.equal(result.reason, "invalid-wallet");
  assert.equal(actor.updateCalls.length, 0);
}

{
  const actor = makeCurrencyActor({ wallet: { gp: 10 } });
  const result = await deductCurrency(actor, 3);
  assert.equal(result.ok, true);
  assert.equal(result.before.gp, 10);
  assert.equal(result.after.gp, 7);
}

{
  const actor = makeCurrencyActor({ wallet: { gp: 10 } });
  const result = await deductCurrency(actor, 3, {
    authorizeWrite: () => false,
  });
  assert.equal(result.ok, false);
  assert.equal(result.reason, "authority-lost");
  assert.equal(result.provenUnapplied, true);
  assert.equal(actor.updateCalls.length, 0);
  assert.equal(actor.system.currency.gp, 10);
}

{
  const actor = makeCurrencyActor({ wallet: { gp: 10 } });
  let authorized = true;
  const update = actor.update.bind(actor);
  actor.update = async (...args) => {
    const returned = await update(...args);
    authorized = false;
    return returned;
  };
  const result = await deductCurrency(actor, 3, {
    authorizeWrite: () => authorized,
  });
  assert.equal(result.ok, false);
  assert.equal(result.reason, "authority-lost");
  assert.equal(result.provenUnapplied, false);
  assert.equal(actor.system.currency.gp, 7);
  assert.equal(
    actor.updateCalls.length,
    1,
    "deduction authority loss never attempts an unguarded second write",
  );
}

for (const amount of [Number.POSITIVE_INFINITY, Number.MAX_VALUE, 0.001]) {
  const actor = makeCurrencyActor({ wallet: { gp: 10 } });
  const result = await deductCurrency(actor, amount);
  assert.equal(result.ok, false);
  assert.equal(result.reason, "invalid-amount");
  assert.equal(actor.updateCalls.length, 0);
}

/* ------------------------------------------------------------------ *
 * Compensation is judged by exact canonical final state
 * ------------------------------------------------------------------ */
{
  const actor = makeCurrencyActor({
    wallet: { gp: 10 },
    mode: "apply",
    returnValue: "undefined",
  });
  const result = await ensureCurrency(actor, { gp: 7 });
  assert.equal(
    result.ok,
    true,
    "compensation can succeed despite a missing API return when read-back is exact",
  );
  assert.equal(actor.system.currency.gp, 7);
}

{
  const actor = makeCurrencyActor({ wallet: { gp: 10 }, mode: "noop" });
  const result = await ensureCurrency(actor, { gp: 7 });
  assert.equal(result.ok, false);
  assert.equal(result.reason, "update-unconfirmed");
  assert.equal(result.actual.gp, 10);
}

{
  const actor = makeCurrencyActor({
    wallet: { gp: -1 },
    mode: "noop",
  });
  const result = await ensureCurrency(actor, { gp: 0 });
  assert.equal(result.ok, false);
  assert.equal(
    result.reason,
    "invalid-wallet",
    "invalid canonical compensation state cannot masquerade as zero",
  );
}

/* ------------------------------------------------------------------ *
 * Synthetic Actors remain the canonical write target
 * ------------------------------------------------------------------ */
{
  const worldActor = makeCurrencyActor({
    id: "shared-actor-id",
    wallet: { gp: 99 },
  });
  const syntheticActor = makeCurrencyActor({
    id: "shared-actor-id",
    wallet: { gp: 10 },
  });
  const previousGame = globalThis.game;
  globalThis.game = {
    actors: {
      get: () => worldActor,
    },
  };
  try {
    const result = await updateCurrencyVerified(syntheticActor, { gp: 6 });
    assert.equal(result.ok, true);
    assert.equal(syntheticActor.system.currency.gp, 6);
    assert.equal(worldActor.system.currency.gp, 99);
    assert.equal(worldActor.updateCalls.length, 0);
  } finally {
    if (previousGame === undefined) delete globalThis.game;
    else globalThis.game = previousGame;
  }
}

process.stdout.write("merchant-currency validation passed\n");
