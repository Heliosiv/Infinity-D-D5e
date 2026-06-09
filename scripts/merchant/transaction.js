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
import { deductCurrency, planCurrencyDeduction } from "./currency.js";
import {
  currencyAddFromBreakdown,
  formatCoinBreakdown,
} from "../loot/hoard-budget.js";
import { SETTING_KEYS, getSetting } from "../settings.js";
import { prettyBargainTier } from "../ui-util.js";

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
 * Execute a purchase. The player client:
 *   1. validates funds against the resolved unit price × qty,
 *   2. creates the item on the actor with the rolled quantity,
 *   3. deducts the currency.
 *
 * The merchant stock decrement + seal burn are the GM's job — see
 * `socket.js`. This function returns enough information to surface a
 * receipt and to emit the commit-purchase event.
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
} = {}) {
  if (!actor || typeof actor.update !== "function") {
    return { ok: false, reason: "no-actor" };
  }
  if (!merchant || !row || !item) {
    return { ok: false, reason: "no-target" };
  }
  const count = Math.max(1, Math.floor(Number(qty) || 1));
  if (!row.unlimited && Number(row.qty) < count) {
    return { ok: false, reason: "out-of-stock", available: row.qty };
  }
  const unitGp = resolveUnitBuyPrice({ merchant, row, item, seal, passivePct });
  const totalGp = roundGp(unitGp * count);
  if (totalGp <= 0) {
    return { ok: false, reason: "no-price" };
  }

  // 1. Funds check.
  const before = actor.system?.currency ?? {};
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
  if (snapshot.flags == null) snapshot.flags = {};
  if (snapshot.flags[MODULE_ID] == null) snapshot.flags[MODULE_ID] = {};
  snapshot.flags[MODULE_ID].purchasedFromMerchant = {
    merchantId: merchant.id,
    pricePaidGp: totalGp,
    bargainTier: seal?.tier ?? null,
    timestamp: null,
  };
  setItemQuantity(snapshot, count);

  let created = [];
  try {
    created = await actor.createEmbeddedDocuments("Item", [snapshot]);
  } catch (error) {
    console.error(`${MODULE_ID} | item create failed`, error);
    if (notify) {
      ui.notifications?.error(
        `${MODULE_ID}: could not add item to ${actor.name}. See console.`,
      );
    }
    return { ok: false, reason: "create-failed", error };
  }

  // 3. Deduct currency.
  const deduct = await deductCurrency(actor, totalGp);
  if (!deduct.ok) {
    // Roll back the created item so the player doesn't get a freebie.
    try {
      const ids = (Array.isArray(created) ? created : [])
        .map((doc) => doc?.id)
        .filter(Boolean);
      if (ids.length > 0) {
        await actor.deleteEmbeddedDocuments("Item", ids);
      }
    } catch (rollbackError) {
      console.warn(`${MODULE_ID} | buy rollback failed`, rollbackError);
    }
    if (notify) {
      ui.notifications?.error(
        `${MODULE_ID}: payment failed — purchase rolled back.`,
      );
    }
    return { ok: false, reason: "payment-failed" };
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
    createdItemIds: (Array.isArray(created) ? created : [])
      .map((doc) => doc?.id)
      .filter(Boolean),
  };
}

/* ------------------------------------------------------------------ *
 * Sell
 * ------------------------------------------------------------------ */

/**
 * Execute a sale. The player client:
 *   1. validates the owned item is sellable + has enough quantity,
 *   2. removes the requested quantity (deletes or decrements the stack),
 *   3. credits the currency.
 *
 * The GM doesn't track sold goods as merchant stock — sales just emit
 * a `commit-sale` so the GM can log the receipt.
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
  const inStack = Math.max(
    0,
    Math.floor(Number(itemData.system?.quantity ?? 1)),
  );
  const count = Math.max(1, Math.floor(Number(qty) || 1));
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
  const totalGp = roundGp(unitGp * count);
  if (totalGp <= 0) {
    return { ok: false, reason: "no-value" };
  }

  // Snapshot the pre-sale item so a failed payout can be rolled back —
  // otherwise a payout error would delete the player's item for free.
  const preSaleSnapshot = cloneItemSnapshot(ownedItem) ?? itemData;
  const removedWholeStack = Math.max(0, inStack - count) <= 0;

  // 1. Remove the requested quantity.
  try {
    if (removedWholeStack) {
      await actor.deleteEmbeddedDocuments("Item", [ownedItem.id]);
    } else {
      await ownedItem.update({ "system.quantity": inStack - count });
    }
  } catch (error) {
    console.error(`${MODULE_ID} | sell removal failed`, error);
    if (notify) {
      ui.notifications?.error(
        `${MODULE_ID}: could not remove item from ${actor.name}.`,
      );
    }
    return { ok: false, reason: "remove-failed", error };
  }

  // 2. Credit currency. Sales are flat-gp so we add it to the gp column.
  const add = currencyAddFromBreakdown({ gp: Math.floor(totalGp) });
  const fractional = totalGp - Math.floor(totalGp);
  if (fractional > 0) {
    add.sp = Math.floor(fractional * 10);
    add.cp = Math.round(fractional * 100 - add.sp * 10);
  }
  const cur = actor.system?.currency ?? {};
  try {
    await actor.update({
      "system.currency.pp": (cur.pp ?? 0) + add.pp,
      "system.currency.gp": (cur.gp ?? 0) + add.gp,
      "system.currency.ep": (cur.ep ?? 0) + add.ep,
      "system.currency.sp": (cur.sp ?? 0) + add.sp,
      "system.currency.cp": (cur.cp ?? 0) + add.cp,
    });
  } catch (error) {
    // Roll the removal back so the player doesn't lose the item for nothing.
    try {
      if (removedWholeStack) {
        const restore = cloneItemSnapshot(preSaleSnapshot);
        if (restore) {
          delete restore._id;
          await actor.createEmbeddedDocuments("Item", [restore]);
        }
      } else {
        await ownedItem.update({ "system.quantity": inStack });
      }
    } catch (rollbackError) {
      console.warn(`${MODULE_ID} | sell rollback failed`, rollbackError);
    }
    console.error(`${MODULE_ID} | sell payout failed`, error);
    if (notify) {
      ui.notifications?.error(
        `${MODULE_ID}: payout failed — item restored, sale cancelled.`,
      );
    }
    return { ok: false, reason: "payout-failed", error };
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
  };
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
    ? `<div class="mw-receipt__bargain">${escapeText(prettyBargainTier(bargainTier.id))} (${rollTotal} vs DC ${dc})</div>`
    : "";
  const subtotal = `${qty}× @ ${unitGp.toFixed(2)} gp = ${totalGp.toFixed(2)} gp`;
  const content = `
    <div class="mw-receipt">
      <div class="mw-receipt__head"><strong>${escapeText(merchant?.name ?? "Merchant")}</strong> · ${verb}</div>
      <div class="mw-receipt__body">${escapeText(itemName)}</div>
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
  if (!snapshot) return;
  const n = Math.max(1, Math.floor(Number(qty) || 1));
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
  }
}

function escapeText(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}
