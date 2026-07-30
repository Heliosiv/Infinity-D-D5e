/**
 * Infinity D&D5e — Merchant Transactions
 *
 * Player-side buy and sell. Both flows mutate the player's own actor
 * (item create/delete + currency adjust) because the player owns it —
 * a GM round-trip would add latency without adding safety. The
 * authoritative merchant stock lives on the GM client and is updated
 * via `socket.js` after this module reports a successful transaction.
 *
 * The bargain seal (when present) is forwarded to the GM so it can be
 * verified + burned. Without a seal, the merchant's `defaultMarkup` /
 * `sellRatio` apply at face value.
 */

import {
  applyBargainDelta,
  computeBuyPriceGp,
  computeSellPriceGp,
  roundGp,
} from "./store.js";
import { itemMatchesBuyFilter } from "./buy-filter.js";
import {
  deductCurrency,
  ensureCurrency,
  isSafeGpAmount,
  planCurrencyDeduction,
  readWalletStrict,
  updateCurrencyVerified,
} from "./currency.js";
import {
  createActorItemVerified,
  deleteActorItemVerified,
  ensureActorItemAbsent,
  ensureActorItemPresent,
  ensureActorItemsAbsent,
  merchantItemId,
  updateActorItemQuantityVerified,
} from "./write-verification.js";
import {
  currencyAddFromBreakdown,
  formatCoinBreakdown,
} from "../loot/hoard-budget.js";
import { SETTING_KEYS, getSetting } from "../settings.js";
import { escapeHtml, prettyBargainTier } from "../ui-util.js";

const MODULE_ID = "infinity-dnd5e";

const NON_SELLABLE_ITEM_TYPES = new Set([
  "class",
  "subclass",
  "race",
  "background",
  "feat",
  "spell",
]);

/* ------------------------------------------------------------------ *
 * Sell-eligibility
 * ------------------------------------------------------------------ */

/**
 * Whether the player can sell this item to a merchant. Defaults to
 * permissive — only blocks well-defined non-physical types, items
 * flagged as quest items, and items the module has explicitly marked
 * `flags.infinity-dnd5e.unsellable`.
 */
export function isSellable(item) {
  if (!item) return false;
  const data = item.toObject?.() ?? item;
  if (NON_SELLABLE_ITEM_TYPES.has(data.type)) return false;
  const flags = data.flags ?? {};
  if (flags?.["infinity-dnd5e"]?.unsellable === true) return false;
  if (flags?.dnd5e?.questItem === true) return false;
  // Equipped + attuned magic items: still sellable, but caller may want
  // to warn the player. We don't block here.
  return true;
}

/* ------------------------------------------------------------------ *
 * Pricing helpers
 * ------------------------------------------------------------------ */

/**
 * Resolve the per-unit gp price the buyer will pay for one of this
 * inventory row. An active bargain seal supersedes the always-on passive
 * haggle nudge (`passivePct`); both use the seal deltaPct convention
 * (negative = cheaper for the buyer).
 */
export function resolveUnitBuyPrice({
  merchant,
  row,
  item,
  seal = null,
  passivePct = 0,
}) {
  const base = computeBuyPriceGp(merchant, row, item);
  if (base <= 0) return 0;
  const delta =
    seal && Number.isFinite(seal.deltaPct)
      ? seal.deltaPct
      : Number(passivePct) || 0;
  if (delta) return roundGp(applyBargainDelta(base, delta));
  return roundGp(base);
}

/**
 * Resolve the per-unit gp price the merchant will pay the seller for one
 * of this item. As with buying, an active seal supersedes the passive
 * nudge; the sign is flipped so a "−20%" delta (phrased as "price down")
 * becomes a "+20%" payout to the seller.
 */
export function resolveUnitSellPrice({
  merchant,
  item,
  seal = null,
  passivePct = 0,
}) {
  const base = computeSellPriceGp(merchant, item);
  if (base <= 0) return 0;
  const delta =
    seal && Number.isFinite(seal.deltaPct)
      ? seal.deltaPct
      : Number(passivePct) || 0;
  if (delta) return roundGp(applyBargainDelta(base, -delta));
  return roundGp(base);
}

/* ------------------------------------------------------------------ *
 * Buy
 * ------------------------------------------------------------------ */

/**
 * Execute a purchase on the authoritative GM:
 *   1. validates funds against the resolved unit price × qty,
 *   2. creates the item on the actor with the rolled quantity,
 *   3. deducts the currency.
 *
 * The caller owns the merchant stock decrement and seal burn. This function
 * returns enough information to persist the shop and surface a receipt.
 */
export async function executeBuy({
  actor,
  merchant,
  row,
  item,
  qty = 1,
  seal = null,
  passivePct = 0,
  notify = true,
  operationId = null,
} = {}) {
  if (!actor || typeof actor.update !== "function") {
    return { ok: false, reason: "no-actor" };
  }
  if (!merchant || !row || !item) {
    return { ok: false, reason: "no-target" };
  }
  const count = Number(qty);
  if (!Number.isInteger(count) || count < 1 || count > 9999) {
    return { ok: false, reason: "invalid-quantity" };
  }
  if (!row.unlimited && Number(row.qty) < count) {
    return { ok: false, reason: "out-of-stock", available: row.qty };
  }
  const unitGp = resolveUnitBuyPrice({ merchant, row, item, seal, passivePct });
  if (unitGp === 0) {
    return { ok: false, reason: "no-price" };
  }
  if (!isSafeGpAmount(unitGp)) {
    return { ok: false, reason: "invalid-price" };
  }
  const rawTotalGp = unitGp * count;
  if (!isSafeGpAmount(rawTotalGp)) {
    return { ok: false, reason: "invalid-price" };
  }
  const totalGp = roundGp(rawTotalGp);
  if (!isSafeGpAmount(totalGp)) {
    return { ok: false, reason: "no-price" };
  }

  // 1. Funds check.
  const initialWallet = readWalletStrict(actor.system?.currency);
  if (!initialWallet.ok) {
    return { ok: false, reason: "invalid-wallet" };
  }
  const before = initialWallet.wallet;
  const planned = planCurrencyDeduction(before, totalGp);
  if (!planned) {
    if (notify) {
      ui.notifications?.warn(
        `${MODULE_ID}: insufficient funds (${totalGp.toFixed(2)} gp).`,
      );
    }
    return { ok: false, reason: "insufficient-funds", totalGp };
  }

  // 2. Item create.
  const snapshot = cloneItemSnapshot(item);
  if (!snapshot) {
    return { ok: false, reason: "bad-item" };
  }
  delete snapshot._id;
  delete snapshot.id;
  const resolvedOperationId =
    String(operationId ?? "").trim() || newMerchantOperationId();
  const createdItemId = merchantItemId(resolvedOperationId);
  snapshot._id = createdItemId;
  if (snapshot.flags == null) snapshot.flags = {};
  if (snapshot.flags[MODULE_ID] == null) snapshot.flags[MODULE_ID] = {};
  snapshot.flags[MODULE_ID].purchasedFromMerchant = {
    merchantId: merchant.id,
    pricePaidGp: totalGp,
    bargainTier: seal?.tier ?? null,
    timestamp: null,
    operationId: resolvedOperationId,
  };
  const supportsQuantity = setItemQuantity(snapshot, count);
  if (count > 1 && !supportsQuantity) {
    return { ok: false, reason: "not-stackable" };
  }

  const created = await createActorItemVerified(actor, snapshot, {
    expectedQuantity: snapshot.system?.quantity ?? null,
    expectedItemId: createdItemId,
  });
  if (!created.ok) {
    const compensated = await ensureActorItemsAbsent(actor, created.itemIds);
    const reason = compensated.ok ? created.reason : "compensation-failed";
    if (created.error) {
      console.error(`${MODULE_ID} | item create failed`, created.error);
    }
    if (notify) {
      ui.notifications?.error(
        reason === "compensation-failed"
          ? `${MODULE_ID}: item delivery could not be confirmed or restored — ask the GM to reconcile the transaction.`
          : `${MODULE_ID}: item delivery could not be confirmed — you were not charged.`,
      );
    }
    return {
      ok: false,
      reason,
      error: created.error ?? compensated.error,
    };
  }

  // 3. Deduct currency.
  const deduct = await deductCurrency(actor, totalGp);
  if (!deduct.ok) {
    // A rejected or hook-altered payment may still have partially changed the
    // wallet. Restore both sides and verify their canonical final state.
    const rolledBack = await compensateBuyActorState(actor, {
      itemIds: created.itemIds,
      itemSnapshot: snapshot,
      expectedQuantity: snapshot.system?.quantity ?? null,
      currencyBefore: deduct.before ?? before,
      currencyAfter: deduct.expectedAfter ?? planned,
    });
    if (notify) {
      ui.notifications?.error(
        rolledBack
          ? `${MODULE_ID}: payment failed — purchase rolled back.`
          : `${MODULE_ID}: payment and item rollback failed — ask the GM to reconcile the transaction.`,
      );
    }
    return {
      ok: false,
      reason: rolledBack
        ? deduct.reason === "update-unconfirmed"
          ? "payment-unconfirmed"
          : "payment-failed"
        : "compensation-failed",
      error: deduct.error,
    };
  }

  const itemName = snapshot.name ?? "item";
  if (notify) {
    ui.notifications?.info(
      `Bought ${count}× ${itemName} for ${totalGp.toFixed(2)} gp.`,
    );
  }

  return {
    ok: true,
    side: "buy",
    actorId: actor.id,
    merchantId: merchant.id,
    itemUuid: row.uuid,
    itemName,
    qty: count,
    unitGp,
    totalGp,
    sealId: seal?.sealId ?? null,
    createdItemIds: created.itemIds,
    createdItemSnapshot: snapshot,
    createdItemQuantity: snapshot.system?.quantity ?? null,
    currencyBefore: deduct.before,
    currencyAfter: deduct.after,
  };
}

/* ------------------------------------------------------------------ *
 * Sell
 * ------------------------------------------------------------------ */

/**
 * Execute a sale on the authoritative GM:
 *   1. validates the owned item is sellable + has enough quantity,
 *   2. removes the requested quantity (deletes or decrements the stack),
 *   3. credits the currency.
 *
 * Sold goods are not added to merchant stock; the caller persists the payout.
 */
export async function executeSell({
  actor,
  merchant,
  ownedItem,
  qty = 1,
  seal = null,
  passivePct = 0,
  notify = true,
} = {}) {
  if (!actor || typeof actor.update !== "function") {
    return { ok: false, reason: "no-actor" };
  }
  if (!merchant || !ownedItem) {
    return { ok: false, reason: "no-target" };
  }
  if (!isSellable(ownedItem)) {
    return { ok: false, reason: "not-sellable" };
  }
  const itemData = ownedItem.toObject?.() ?? ownedItem;
  // Honor the merchant's "Buys From Players" filter — a stale window must not
  // sell an item this merchant won't purchase.
  if (!itemMatchesBuyFilter(merchant.buyFilter, itemData)) {
    return { ok: false, reason: "not-bought-here" };
  }
  const inStack = Number(itemData.system?.quantity ?? 1);
  if (!Number.isInteger(inStack) || inStack < 0) {
    return { ok: false, reason: "invalid-quantity" };
  }
  const count = Number(qty);
  if (!Number.isInteger(count) || count < 1 || count > 9999) {
    return { ok: false, reason: "invalid-quantity" };
  }
  // A genuinely empty stack (qty 0) must not sell — the old `inStack > 0`
  // guard let a 0-quantity item through and pay out coin for nothing.
  if (inStack < count) {
    return { ok: false, reason: "not-enough", available: inStack };
  }
  const unitGp = resolveUnitSellPrice({
    merchant,
    item: itemData,
    seal,
    passivePct,
  });
  if (unitGp === 0) {
    return { ok: false, reason: "no-value" };
  }
  if (!isSafeGpAmount(unitGp)) {
    return { ok: false, reason: "invalid-price" };
  }
  const rawTotalGp = unitGp * count;
  if (!isSafeGpAmount(rawTotalGp)) {
    return { ok: false, reason: "invalid-price" };
  }
  const totalGp = roundGp(rawTotalGp);
  if (!isSafeGpAmount(totalGp)) {
    return { ok: false, reason: "no-value" };
  }

  const initialWallet = readWalletStrict(actor.system?.currency);
  if (!initialWallet.ok) {
    return { ok: false, reason: "invalid-wallet" };
  }
  const cpTotal = Math.round(totalGp * 100);
  const add = currencyAddFromBreakdown({
    gp: Math.floor(cpTotal / 100),
    sp: Math.floor((cpTotal % 100) / 10),
    cp: cpTotal % 10,
  });
  const initialPayout = readWalletStrict({
    pp: initialWallet.wallet.pp + add.pp,
    gp: initialWallet.wallet.gp + add.gp,
    ep: initialWallet.wallet.ep + add.ep,
    sp: initialWallet.wallet.sp + add.sp,
    cp: initialWallet.wallet.cp + add.cp,
  });
  if (!initialPayout.ok) {
    return { ok: false, reason: "invalid-wallet" };
  }

  // Snapshot the pre-sale item so a failed payout can be rolled back —
  // otherwise a payout error would delete the player's item for free.
  const preSaleSnapshot = cloneItemSnapshot(ownedItem) ?? itemData;
  const removedWholeStack = Math.max(0, inStack - count) <= 0;
  const soldQuantity = Math.max(0, inStack - count);

  // 1. Remove the requested quantity and confirm the exact canonical result.
  const removal = removedWholeStack
    ? await deleteActorItemVerified(actor, ownedItem.id, {
        expectedBeforeQuantity: inStack,
      })
    : await updateActorItemQuantityVerified(actor, ownedItem, soldQuantity, {
        expectedBeforeQuantity: inStack,
      });
  if (!removal.ok) {
    const restored = await restoreSaleItem(actor, {
      itemId: ownedItem.id,
      itemSnapshot: preSaleSnapshot,
      removedWholeStack,
      previousQuantity: inStack,
    });
    if (removal.error) {
      console.error(`${MODULE_ID} | sell removal failed`, removal.error);
    }
    if (notify) {
      ui.notifications?.error(
        restored
          ? `${MODULE_ID}: item removal could not be confirmed — no payout was recorded.`
          : `${MODULE_ID}: item removal and restoration could not be confirmed — ask the GM to reconcile the transaction.`,
      );
    }
    return {
      ok: false,
      reason: restored
        ? removal.reason === "delete-unconfirmed" ||
          removal.reason === "quantity-unconfirmed"
          ? "remove-unconfirmed"
          : "remove-failed"
        : "compensation-failed",
      error: removal.error,
    };
  }

  // 2. Credit currency. Derive every denomination from integer copper so none
  //    can overflow its valid range — the old `floor(fractional*10)` / rounded
  //    remainder split leaked a malformed cp:10 (with a short sp) for ~40% of
  //    fractional gp totals (e.g. 2.4 gp). Total value is preserved either way.
  const currentWallet = readWalletStrict(actor.system?.currency);
  if (!currentWallet.ok) {
    const restored = await restoreSaleItem(actor, {
      itemId: ownedItem.id,
      itemSnapshot: preSaleSnapshot,
      removedWholeStack,
      previousQuantity: inStack,
    });
    return {
      ok: false,
      reason: restored ? "invalid-wallet" : "compensation-failed",
    };
  }
  const cur = currentWallet.wallet;
  const expectedCurrencyRead = readWalletStrict({
    pp: (cur.pp ?? 0) + add.pp,
    gp: (cur.gp ?? 0) + add.gp,
    ep: (cur.ep ?? 0) + add.ep,
    sp: (cur.sp ?? 0) + add.sp,
    cp: (cur.cp ?? 0) + add.cp,
  });
  if (!expectedCurrencyRead.ok) {
    const restored = await restoreSaleItem(actor, {
      itemId: ownedItem.id,
      itemSnapshot: preSaleSnapshot,
      removedWholeStack,
      previousQuantity: inStack,
    });
    return {
      ok: false,
      reason: restored ? "invalid-wallet" : "compensation-failed",
    };
  }
  const expectedCurrency = expectedCurrencyRead.wallet;
  const payout = await updateCurrencyVerified(actor, expectedCurrency);
  if (!payout.ok) {
    // A rejected or hook-altered payout may still have partially changed the
    // wallet. Restore and verify both currency and item state.
    const rolledBack = await compensateSaleActorState(actor, {
      currencyBefore: cur,
      itemId: ownedItem.id,
      itemSnapshot: preSaleSnapshot,
      removedWholeStack,
      previousQuantity: inStack,
      soldQuantity,
      currencyAfter: expectedCurrency,
    });
    if (payout.error) {
      console.error(`${MODULE_ID} | sell payout failed`, payout.error);
    }
    if (notify) {
      ui.notifications?.error(
        rolledBack
          ? `${MODULE_ID}: payout failed — item restored, sale cancelled.`
          : `${MODULE_ID}: payout and item rollback failed — ask the GM to reconcile the transaction.`,
      );
    }
    return {
      ok: false,
      reason: rolledBack
        ? payout.reason === "update-unconfirmed"
          ? "payout-unconfirmed"
          : "payout-failed"
        : "compensation-failed",
      error: payout.error,
    };
  }

  const itemName = itemData.name ?? "item";
  if (notify) {
    ui.notifications?.info(
      `Sold ${count}× ${itemName} for ${totalGp.toFixed(2)} gp.`,
    );
  }

  return {
    ok: true,
    side: "sell",
    actorId: actor.id,
    merchantId: merchant.id,
    itemId: ownedItem.id,
    itemName,
    qty: count,
    unitGp,
    totalGp,
    sealId: seal?.sealId ?? null,
    coinBreakdown: add,
    // Minimal pricing snapshot of the sold item so the GM can recompute the
    // payout server-side (the embedded item is gone from the sheet by now).
    itemSnapshot: {
      name: itemData.name,
      type: itemData.type,
      system: { price: itemData.system?.price ?? {} },
      flags: itemData.flags ?? {},
    },
    rollback: {
      currencyBefore: cur,
      itemSnapshot: preSaleSnapshot,
      removedWholeStack,
      previousQuantity: inStack,
      soldQuantity,
      currencyAfter: payout.actual,
    },
  };
}

async function compensateBuyActorState(
  actor,
  {
    itemIds = [],
    itemSnapshot = null,
    expectedQuantity = null,
    currencyBefore = null,
    currencyAfter = null,
  } = {},
) {
  const ids = [
    ...new Set([...(Array.isArray(itemIds) ? itemIds : []), itemSnapshot?._id]),
  ].filter(Boolean);
  const itemResults = await Promise.all(
    ids.map((itemId) =>
      itemSnapshot && itemId === itemSnapshot._id
        ? ensureActorItemAbsent(actor, itemId, {
            expectedIdentity: itemSnapshot,
          })
        : ensureActorItemsAbsent(actor, [itemId]),
    ),
  );
  const itemRemoved = {
    ok: itemResults.every((result) => result.ok),
  };
  if (!itemRemoved.ok) {
    if (itemSnapshot) {
      await ensureActorItemPresent(actor, itemSnapshot, {
        expectedItemId: itemSnapshot._id,
        expectedQuantity,
      });
    }
    if (currencyAfter) await ensureCurrency(actor, currencyAfter);
    return false;
  }

  const currencyRestored = currencyBefore
    ? await ensureCurrency(actor, currencyBefore)
    : { ok: false };
  if (currencyRestored.ok) return true;

  // The item was removed but the refund did not settle. Recreate the exact
  // transaction-owned item and reapply the completed wallet so the actor ends
  // in one confirmed state instead of a hybrid.
  if (itemSnapshot) {
    await ensureActorItemPresent(actor, itemSnapshot, {
      expectedItemId: itemSnapshot._id,
      expectedQuantity,
    });
  }
  if (currencyAfter) await ensureCurrency(actor, currencyAfter);
  return false;
}

async function restoreSaleItem(
  actor,
  {
    itemId,
    itemSnapshot,
    removedWholeStack = false,
    previousQuantity = 0,
  } = {},
) {
  const restore = cloneItemSnapshot(itemSnapshot);
  if (!restore) return false;
  delete restore.id;
  restore._id = itemId;
  setItemQuantity(restore, previousQuantity);
  const restored = await ensureActorItemPresent(actor, restore, {
    expectedItemId: itemId,
    expectedQuantity: previousQuantity,
  });
  return restored.ok;
}

async function ensureSaleCompletedState(
  actor,
  { itemId, itemSnapshot, removedWholeStack = false, soldQuantity = 0 } = {},
) {
  if (removedWholeStack) {
    return ensureActorItemAbsent(actor, itemId, {
      expectedIdentity: itemSnapshot,
    });
  }
  const sold = cloneItemSnapshot(itemSnapshot);
  if (!sold) return { ok: false, reason: "quantity-unconfirmed" };
  delete sold.id;
  sold._id = itemId;
  setItemQuantity(sold, soldQuantity);
  return ensureActorItemPresent(actor, sold, {
    expectedItemId: itemId,
    expectedQuantity: soldQuantity,
  });
}

async function compensateSaleActorState(
  actor,
  {
    currencyBefore = {},
    itemId,
    itemSnapshot,
    removedWholeStack = false,
    previousQuantity = 0,
    soldQuantity = 0,
    currencyAfter = null,
  } = {},
) {
  const currencyRestore = await ensureCurrency(actor, currencyBefore);
  if (!currencyRestore.ok) {
    await ensureSaleCompletedState(actor, {
      itemId,
      itemSnapshot,
      removedWholeStack,
      soldQuantity,
    });
    if (currencyAfter) await ensureCurrency(actor, currencyAfter);
    return false;
  }

  const itemRestored = await restoreSaleItem(actor, {
    itemId,
    itemSnapshot,
    removedWholeStack,
    previousQuantity,
  });
  if (itemRestored) return true;

  // Currency was reversed but the item could not be restored. Reapply the
  // payout and the sold inventory state to avoid leaving a hybrid.
  if (currencyAfter) await ensureCurrency(actor, currencyAfter);
  await ensureSaleCompletedState(actor, {
    itemId,
    itemSnapshot,
    removedWholeStack,
    soldQuantity,
  });
  return false;
}

/** Compensate a completed buy when the merchant-side persistence fails. */
export async function rollbackBuyTransaction(actor, result) {
  if (!actor || !result?.ok) return false;
  return compensateBuyActorState(actor, {
    itemIds: result.createdItemIds,
    itemSnapshot: result.createdItemSnapshot,
    expectedQuantity: result.createdItemQuantity,
    currencyBefore: result.currencyBefore,
    currencyAfter: result.currencyAfter,
  });
}

/** Compensate a completed sale when the merchant-side persistence fails. */
export async function rollbackSellTransaction(actor, result) {
  if (!actor || !result?.ok || !result.rollback) return false;
  return compensateSaleActorState(actor, {
    currencyBefore: result.rollback.currencyBefore,
    itemId: result.itemId,
    itemSnapshot: result.rollback.itemSnapshot,
    removedWholeStack: result.rollback.removedWholeStack,
    previousQuantity: result.rollback.previousQuantity,
    soldQuantity: result.rollback.soldQuantity,
    currencyAfter: result.rollback.currencyAfter,
  });
}

/* ------------------------------------------------------------------ *
 * Chat receipts
 * ------------------------------------------------------------------ */

/**
 * Post a transaction receipt to chat, honoring MERCHANT_CHAT_MODE.
 * The buyer is whispered along with the GM when the mode whispers.
 */
export async function postTransactionReceipt({
  side,
  actor,
  merchant,
  itemName,
  qty,
  totalGp,
  unitGp,
  bargainTier = null,
  rollTotal = null,
  dc = null,
} = {}) {
  if (typeof globalThis.ChatMessage?.create !== "function") return null;
  const mode = String(
    getSetting(SETTING_KEYS.MERCHANT_CHAT_MODE) ?? "whisper-gm-buyer",
  );

  const verb = side === "sell" ? "Sold" : "Bought";
  const bargainLine = bargainTier
    ? `<div class="mw-receipt__bargain">${escapeHtml(prettyBargainTier(bargainTier.id))} (${rollTotal} vs DC ${dc})</div>`
    : "";
  const subtotal = `${qty}× @ ${unitGp.toFixed(2)} gp = ${totalGp.toFixed(2)} gp`;
  const content = `
    <div class="mw-receipt">
      <div class="mw-receipt__head"><strong>${escapeHtml(merchant?.name ?? "Merchant")}</strong> · ${verb}</div>
      <div class="mw-receipt__body">${escapeHtml(itemName)}</div>
      <div class="mw-receipt__total">${subtotal}</div>
      ${bargainLine}
    </div>
  `;

  const speaker = globalThis.ChatMessage?.getSpeaker?.({
    alias: merchant?.name ?? "Merchant",
  });
  const messageData = { content, speaker };

  const whisperTargets = resolveWhisperTargets(mode, actor);
  if (whisperTargets !== null) {
    messageData.whisper = whisperTargets;
  }
  try {
    return await globalThis.ChatMessage.create(messageData);
  } catch (error) {
    console.warn(`${MODULE_ID} | chat receipt failed`, error);
    return null;
  }
}

function resolveWhisperTargets(mode, actor) {
  if (mode === "public") return null;
  const users = globalThis.game?.users;
  if (!users) return [];
  if (mode === "whisper-gm") {
    return users.filter((u) => u.isGM).map((u) => u.id);
  }
  // whisper-gm-buyer (default)
  const buyerId = resolveOwningUserId(actor);
  const gmIds = users.filter((u) => u.isGM).map((u) => u.id);
  const out = new Set(gmIds);
  if (buyerId) out.add(buyerId);
  return [...out];
}

function resolveOwningUserId(actor) {
  if (!actor) return null;
  const users = globalThis.game?.users;
  if (!users) return null;
  const owners = users.filter(
    (u) => !u.isGM && actor.testUserPermission?.(u, "OWNER"),
  );
  return owners[0]?.id ?? globalThis.game?.user?.id ?? null;
}

/* ------------------------------------------------------------------ *
 * Internal helpers
 * ------------------------------------------------------------------ */

function cloneItemSnapshot(item) {
  if (!item) return null;
  if (typeof item.toObject === "function") return item.toObject();
  if (typeof item === "object") {
    if (typeof structuredClone === "function") return structuredClone(item);
    return JSON.parse(JSON.stringify(item));
  }
  return null;
}

function setItemQuantity(snapshot, qty) {
  if (!snapshot) return false;
  const raw = Number(qty);
  const n = Number.isInteger(raw) && raw >= 0 ? raw : 1;
  snapshot.system = snapshot.system ?? {};
  const PHYSICAL = [
    "weapon",
    "equipment",
    "consumable",
    "tool",
    "loot",
    "container",
    "backpack",
  ];
  if (PHYSICAL.includes(snapshot.type) || "quantity" in snapshot.system) {
    snapshot.system.quantity = n;
    return true;
  }
  return false;
}

function newMerchantOperationId() {
  return (
    globalThis.crypto?.randomUUID?.() ??
    `merchant-${Date.now()}-${Math.random().toString(36).slice(2)}`
  );
}
