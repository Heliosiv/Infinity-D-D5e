/**
 * Infinity D&D5e — MerchantSessionApp
 *
 * Player-facing buy/sell window. The GM opens a session for a player
 * via the Merchant Workspace; the player's client receives a
 * `session-open` event and pops this window with the merchant snapshot.
 *
 * Mutations to the player's own actor (item create/delete + currency
 * adjust) run here on the player client — the player owns their actor.
 * Stock decrements + bargain seal issuance route to the GM via the
 * socket layer.
 */

import { normalizeMerchant, roundGp } from "./merchant/store.js";
import {
  resolveUnitBuyPrice,
  resolveUnitSellPrice,
  isSellable,
  executeBuy,
  executeSell,
  postTransactionReceipt,
} from "./merchant/transaction.js";
import {
  MERCHANT_EVENTS,
  emitMerchantEvent,
  subscribe,
} from "./merchant/socket.js";
import { runBargain } from "./merchant/bargain.js";
import { totalWalletGp, sanitizeWallet } from "./merchant/currency.js";
import { formatCoinBreakdown } from "./loot/hoard-budget.js";
import { getItemRarity } from "./loot/tag-vocabulary.js";
import { SOUND_EVENTS, playModuleSound } from "./audio.js";
import { SETTING_KEYS, getSetting } from "./settings.js";

const MODULE_ID = "infinity-dnd5e";
const TEMPLATE_PATH = `modules/${MODULE_ID}/templates/merchant-session.hbs`;
const FALLBACK_ART = "icons/svg/shop.svg";
const FALLBACK_ITEM_IMAGE = "icons/svg/item-bag.svg";

const { ApplicationV2, HandlebarsApplicationMixin } = foundry.applications.api;

/** Map<sessionId, MerchantSessionApp> */
const instances = new Map();

export class MerchantSessionApp extends HandlebarsApplicationMixin(
  ApplicationV2,
) {
  static DEFAULT_OPTIONS = {
    id: "infinity-dnd5e-merchant-session",
    tag: "section",
    classes: ["infinity-dnd5e", "infinity-merchant-session"],
    window: {
      title: "Merchant",
      icon: "fa-solid fa-store",
      resizable: true,
    },
    position: { width: 720, height: 600 },
    actions: {
      tab: MerchantSessionApp._onTab,
      buyOne: MerchantSessionApp._onBuyOne,
      buyN: MerchantSessionApp._onBuyN,
      sellOne: MerchantSessionApp._onSellOne,
      sellN: MerchantSessionApp._onSellN,
      bargainBuy: MerchantSessionApp._onBargainBuy,
      bargainSell: MerchantSessionApp._onBargainSell,
    },
  };

  static PARTS = {
    body: { template: TEMPLATE_PATH },
  };

  /**
   * Open a session window. If one is already open for this sessionId,
   * focus it.
   */
  static open({ sessionId, merchant }) {
    if (!sessionId) return null;
    let app = instances.get(sessionId);
    if (!app) {
      app = new MerchantSessionApp({
        // Unique DOM id per session so a player can have two different
        // merchants open at once without an element-id collision.
        id: `infinity-dnd5e-merchant-session-${sessionId}`,
        sessionId,
        merchant: normalizeMerchant(merchant),
      });
      instances.set(sessionId, app);
    } else {
      app._merchant = normalizeMerchant(merchant);
    }
    if (app.rendered) app.bringToFront();
    else app.render(true);
    return app;
  }

  /** Close every open session window. Used on logout / merchant delete. */
  static closeSession(sessionId) {
    const app = instances.get(sessionId);
    if (!app) return false;
    app._closingFromExternal = true;
    app.close();
    return true;
  }

  constructor(options = {}) {
    super(options);
    this._sessionId = options.sessionId;
    this._merchant = normalizeMerchant(options.merchant);
    this._activeTab = "buy";
    this._seals = new Map(); // `${itemRefId}::${side}` → seal
    this._buyQty = new Map(); // uuid → qty input value
    this._sellQty = new Map(); // itemId → qty input value
    this._log = []; // session-only transaction log
    this._bargainPending = new Set();
    this._closingFromExternal = false;

    this._title = `${this._merchant?.name ?? "Merchant"} — Shop`;

    this._unsubscribers = [];
    this._unsubscribers.push(
      subscribe(MERCHANT_EVENTS.STATE_UPDATE, (payload) =>
        this._onStateUpdate(payload),
      ),
    );
    this._unsubscribers.push(
      subscribe(MERCHANT_EVENTS.BARGAIN_SEAL, (payload) =>
        this._onBargainSeal(payload),
      ),
    );
    this._unsubscribers.push(
      subscribe(MERCHANT_EVENTS.SESSION_CLOSE, (payload) => {
        if (payload?.sessionId !== this._sessionId) return;
        if (payload.targetUserId && payload.targetUserId !== globalThis.game?.user?.id) {
          return;
        }
        this._closingFromExternal = true;
        this.close();
      }),
    );
  }

  get title() {
    return this._title ?? "Merchant";
  }

  _onClose(options) {
    super._onClose?.(options);
    for (const fn of this._unsubscribers) {
      try {
        fn();
      } catch {}
    }
    this._unsubscribers = [];
    instances.delete(this._sessionId);
  }

  _onStateUpdate(payload) {
    if (!payload || payload.merchantId !== this._merchant.id) return;
    this._merchant = normalizeMerchant(payload.merchant);
    this.render(false);
  }

  _onBargainSeal(payload) {
    if (!payload || payload.sessionId !== this._sessionId) return;
    if (payload.targetUserId && payload.targetUserId !== globalThis.game?.user?.id) {
      return;
    }
    const key = `${payload.itemUuid}::${payload.side}`;
    this._seals.set(key, {
      sealId: payload.sealId,
      tier: payload.tier,
      deltaPct: Number(payload.deltaPct) || 0,
      rollTotal: payload.rollTotal,
      dc: payload.dc,
    });
    this._bargainPending.delete(key);
    if (payload.deltaPct <= 0) {
      playModuleSound(SOUND_EVENTS.MERCHANT_BARGAIN_WIN);
    } else {
      playModuleSound(SOUND_EVENTS.MERCHANT_BARGAIN_FAIL);
    }
    this._appendLog(
      "bargain",
      `Bargain ${payload.tier?.id ?? "result"} · ${formatDelta(payload.deltaPct)}`,
    );
    // Flag the row for a one-shot celebration on the next render.
    this._justBargained = {
      refId: payload.itemUuid,
      side: payload.side,
      win: Number(payload.deltaPct) <= 0,
    };
    this.render(false);
  }

  /* -------------------- context -------------------- */

  async _prepareContext() {
    const actor = resolvePlayerActor();
    const wallet = sanitizeWallet(actor?.system?.currency);
    const walletLabel =
      formatCoinBreakdown(wallet) ||
      `${totalWalletGp(wallet).toFixed(2)} gp`;

    const itemMap = await this._resolveMerchantItems();

    const buyRows = await Promise.all(
      this._merchant.items.map((row) =>
        this._buildBuyRow(row, itemMap.get(row.uuid) ?? null, wallet),
      ),
    );

    const sellRows = actor
      ? actor.items
          .filter(isSellable)
          .map((doc) => this._buildSellRow(doc))
          .filter(Boolean)
      : [];

    return {
      merchant: {
        ...this._merchant,
        art: this._merchant.art || FALLBACK_ART,
      },
      walletLabel,
      buyActive: this._activeTab === "buy",
      sellActive: this._activeTab === "sell",
      buyRows,
      sellRows,
      log: this._log.slice(-30),
    };
  }

  async _resolveMerchantItems() {
    const map = new Map();
    for (const row of this._merchant.items) {
      try {
        const doc = await fromUuid(row.uuid);
        if (!doc) {
          map.set(row.uuid, null);
          continue;
        }
        const snapshot =
          typeof doc.toObject === "function" ? doc.toObject() : { ...doc };
        if (!snapshot.uuid) snapshot.uuid = doc.uuid ?? row.uuid;
        map.set(row.uuid, snapshot);
      } catch (error) {
        console.warn(`${MODULE_ID} | failed to resolve ${row.uuid}`, error);
        map.set(row.uuid, null);
      }
    }
    return map;
  }

  _buildBuyRow(row, item, wallet) {
    const sealKey = `${row.uuid}::buy`;
    const seal = this._seals.get(sealKey) ?? null;
    const rarity = item ? getItemRarity(item) : "";
    const baseGp = roundGp(resolveUnitBuyPrice({ merchant: this._merchant, row, item, seal: null }));
    const finalGp = roundGp(resolveUnitBuyPrice({ merchant: this._merchant, row, item, seal }));
    const outOfStock = !row.unlimited && row.qty <= 0;
    const walletGp = walletGpFromObject(wallet);
    const cannotBuy = outOfStock || finalGp > walletGp || !item;
    const maxQty = row.unlimited ? 99 : Math.max(1, row.qty);
    const stockLabel = row.unlimited
      ? "Unlimited stock"
      : `Stock: ${row.qty}`;
    const showDelta = seal && Math.abs(seal.deltaPct) > 0;
    return {
      uuid: row.uuid,
      name: item?.name ?? "(missing item)",
      img: item?.img ?? FALLBACK_ITEM_IMAGE,
      rarity,
      rarityLabel: prettyRarity(rarity),
      stockLabel,
      baseLabel: `${baseGp.toFixed(2)} gp`,
      finalLabel: `${finalGp.toFixed(2)} gp`,
      priceDeltaLabel: showDelta ? formatDelta(seal.deltaPct) : "",
      deltaClass: seal && seal.deltaPct < 0 ? "down" : "up",
      bargainLocked: Boolean(seal) || this._bargainPending.has(sealKey),
      sealLabel: seal ? sealLabel(seal) : "",
      cannotBuy,
      maxQty,
      outOfStock,
      missing: !item,
    };
  }

  _buildSellRow(doc) {
    const data = doc.toObject?.() ?? doc;
    const ownedQty = Math.max(1, Math.floor(Number(data.system?.quantity ?? 1)));
    const sealKey = `${doc.id}::sell`;
    const seal = this._seals.get(sealKey) ?? null;
    const rarity = getItemRarity(data);
    const baseGp = roundGp(
      resolveUnitSellPrice({ merchant: this._merchant, item: data, seal: null }),
    );
    const finalGp = roundGp(
      resolveUnitSellPrice({ merchant: this._merchant, item: data, seal }),
    );
    if (baseGp <= 0) return null; // hide free items
    const showDelta = seal && Math.abs(seal.deltaPct) > 0;
    return {
      itemId: doc.id,
      name: data.name ?? "(item)",
      img: data.img ?? FALLBACK_ITEM_IMAGE,
      rarity,
      rarityLabel: prettyRarity(rarity),
      ownedQty,
      baseLabel: `${baseGp.toFixed(2)} gp`,
      finalLabel: `${finalGp.toFixed(2)} gp`,
      priceDeltaLabel: showDelta ? formatDelta(-seal.deltaPct) : "",
      deltaClass: seal && seal.deltaPct < 0 ? "down" : "up",
      bargainLocked: Boolean(seal) || this._bargainPending.has(sealKey),
      sealLabel: seal ? sealLabel(seal) : "",
    };
  }

  _onRender(context, options) {
    super._onRender?.(context, options);

    // Honor the shared visual prefs (animations + rarity glow), mirroring
    // the workspace and loot tools.
    const root = this.element;
    if (root) {
      root.classList.toggle(
        "mw-no-anim",
        getSetting(SETTING_KEYS.ANIMATIONS) === false,
      );
      root.classList.toggle(
        "mw-no-glow",
        getSetting(SETTING_KEYS.RARITY_GLOW) === false,
      );
    }

    // Play the one-shot bargain celebration if a result just landed.
    this._playBargainCelebration();

    // Snap stored qty inputs back into the inputs after re-render.
    for (const [uuid, qty] of this._buyQty) {
      const input = this.element?.querySelector(
        `[data-role="buyQty"][data-uuid="${cssEscape(uuid)}"]`,
      );
      if (input) input.value = qty;
    }
    for (const [itemId, qty] of this._sellQty) {
      const input = this.element?.querySelector(
        `[data-role="sellQty"][data-item-id="${cssEscape(itemId)}"]`,
      );
      if (input) input.value = qty;
    }

    this._wireQtyInputs();
  }

  _wireQtyInputs() {
    const buyInputs =
      this.element?.querySelectorAll?.('[data-role="buyQty"]') ?? [];
    for (const input of buyInputs) {
      input.addEventListener("change", () => {
        const uuid = input.dataset.uuid;
        const qty = Math.max(1, Math.floor(Number(input.value) || 1));
        this._buyQty.set(uuid, qty);
        input.value = qty;
      });
    }
    const sellInputs =
      this.element?.querySelectorAll?.('[data-role="sellQty"]') ?? [];
    for (const input of sellInputs) {
      input.addEventListener("change", () => {
        const itemId = input.dataset.itemId;
        const qty = Math.max(1, Math.floor(Number(input.value) || 1));
        this._sellQty.set(itemId, qty);
        input.value = qty;
      });
    }
  }

  /**
   * One-shot bargain celebration: flash the just-bargained row green
   * (favorable) or red (unfavorable). Consumes the transient
   * `_justBargained` marker set in `_onBargainSeal`. Respects mw-no-anim.
   */
  _playBargainCelebration() {
    const mark = this._justBargained;
    this._justBargained = null;
    if (!mark || !mark.refId) return;
    const root = this.element;
    if (!root || root.classList.contains("mw-no-anim")) return;
    const selector =
      mark.side === "sell"
        ? `.ms-row[data-item-id="${cssEscape(mark.refId)}"]`
        : `.ms-row[data-uuid="${cssEscape(mark.refId)}"]`;
    const rowEl = root.querySelector(selector);
    if (!rowEl) return;
    const cls = mark.win ? "ms-row--bargain-win" : "ms-row--bargain-fail";
    rowEl.classList.remove("ms-row--bargain-win", "ms-row--bargain-fail");
    void rowEl.offsetWidth; // reflow so re-adding restarts the animation
    rowEl.classList.add(cls);
    globalThis.setTimeout?.(() => rowEl.classList.remove(cls), 1000);
  }

  _appendLog(kind, text) {
    this._log.push({ kind, text });
    if (this._log.length > 100) this._log.splice(0, this._log.length - 100);
  }

  /* -------------------- actions -------------------- */

  static _onTab(_event, target) {
    const tab = target?.dataset?.tab;
    if (!tab) return;
    this._activeTab = tab;
    this.render(false);
  }

  static _onBuyOne(_event, target) {
    return this._performBuy(target?.dataset?.uuid, 1);
  }

  static _onBuyN(_event, target) {
    const uuid = target?.dataset?.uuid;
    const qty = Math.max(1, Math.floor(Number(this._buyQty.get(uuid) ?? 1)));
    return this._performBuy(uuid, qty);
  }

  async _performBuy(uuid, qty) {
    if (!uuid) return;
    const row = this._merchant.items.find((r) => r.uuid === uuid);
    if (!row) return;
    const item = await fromUuid(uuid).catch(() => null);
    if (!item) {
      ui.notifications?.warn(`${MODULE_ID}: item no longer available.`);
      return;
    }
    const actor = resolvePlayerActor();
    if (!actor) {
      ui.notifications?.warn(`${MODULE_ID}: no character assigned.`);
      return;
    }
    const sealKey = `${uuid}::buy`;
    const seal = this._seals.get(sealKey) ?? null;
    const result = await executeBuy({
      actor,
      merchant: this._merchant,
      row,
      item: item.toObject?.() ?? item,
      qty,
      seal,
    });
    if (!result.ok) {
      this._appendLog("fail", `Buy failed: ${result.reason}`);
      this.render(false);
      return;
    }
    // Tell the GM to update stock + burn seal.
    emitMerchantEvent(MERCHANT_EVENTS.COMMIT_PURCHASE, {
      sessionId: this._sessionId,
      itemUuid: uuid,
      qty,
      sealId: result.sealId,
    });
    this._seals.delete(sealKey);
    playModuleSound(SOUND_EVENTS.MERCHANT_PURCHASE);
    this._appendLog(
      "buy",
      `Bought ${result.qty}× ${result.itemName} for ${result.totalGp.toFixed(2)} gp`,
    );
    await postTransactionReceipt({
      side: "buy",
      actor,
      merchant: this._merchant,
      itemName: result.itemName,
      qty: result.qty,
      unitGp: result.unitGp,
      totalGp: result.totalGp,
      bargainTier: seal?.tier ?? null,
      rollTotal: seal?.rollTotal ?? null,
      dc: seal?.dc ?? null,
    });
    this.render(false);
  }

  static _onSellOne(_event, target) {
    return this._performSell(target?.dataset?.itemId, 1);
  }

  static _onSellN(_event, target) {
    const itemId = target?.dataset?.itemId;
    const qty = Math.max(
      1,
      Math.floor(Number(this._sellQty.get(itemId) ?? 1)),
    );
    return this._performSell(itemId, qty);
  }

  async _performSell(itemId, qty) {
    const actor = resolvePlayerActor();
    if (!actor || !itemId) return;
    const ownedItem = actor.items?.get?.(itemId);
    if (!ownedItem) {
      ui.notifications?.warn(`${MODULE_ID}: item not on your sheet.`);
      return;
    }
    const sealKey = `${itemId}::sell`;
    const seal = this._seals.get(sealKey) ?? null;
    const result = await executeSell({
      actor,
      merchant: this._merchant,
      ownedItem,
      qty,
      seal,
    });
    if (!result.ok) {
      this._appendLog("fail", `Sell failed: ${result.reason}`);
      this.render(false);
      return;
    }
    emitMerchantEvent(MERCHANT_EVENTS.COMMIT_SALE, {
      sessionId: this._sessionId,
      itemUuid: itemId,
      qty,
      sealId: result.sealId,
    });
    this._seals.delete(sealKey);
    playModuleSound(SOUND_EVENTS.MERCHANT_SALE);
    this._appendLog(
      "sell",
      `Sold ${result.qty}× ${result.itemName} for ${result.totalGp.toFixed(2)} gp`,
    );
    await postTransactionReceipt({
      side: "sell",
      actor,
      merchant: this._merchant,
      itemName: result.itemName,
      qty: result.qty,
      unitGp: result.unitGp,
      totalGp: result.totalGp,
      bargainTier: seal?.tier ?? null,
      rollTotal: seal?.rollTotal ?? null,
      dc: seal?.dc ?? null,
    });
    this.render(false);
  }

  static async _onBargainBuy(_event, target) {
    return this._performBargain(target?.dataset?.uuid, "buy");
  }

  static async _onBargainSell(_event, target) {
    return this._performBargain(target?.dataset?.itemId, "sell");
  }

  async _performBargain(refId, side) {
    if (!refId) return;
    const sealKey = `${refId}::${side}`;
    if (this._seals.has(sealKey) || this._bargainPending.has(sealKey)) return;
    const actor = resolvePlayerActor();
    if (!actor) {
      ui.notifications?.warn(`${MODULE_ID}: no character assigned.`);
      return;
    }
    const skillId = await promptSkillPicker(this._merchant.allowedSkills);
    if (!skillId) return;
    this._bargainPending.add(sealKey);
    this.render(false);
    const outcome = await runBargain({
      actor,
      skillId,
      dc: this._merchant.bargainDC,
      advantage: this._merchant.bargainAdvantage,
      chatMessage: false,
    });
    if (!outcome.ok) {
      this._bargainPending.delete(sealKey);
      ui.notifications?.warn(
        `${MODULE_ID}: bargain ${outcome.reason ?? "cancelled"}.`,
      );
      this.render(false);
      return;
    }
    emitMerchantEvent(MERCHANT_EVENTS.BARGAIN_RESULT, {
      sessionId: this._sessionId,
      itemUuid: refId,
      side,
      skillId,
      rollTotal: outcome.rollTotal,
    });
    // Seal will arrive on the bargain-seal event handler.
  }
}

/* ------------------------------------------------------------------ *
 * Player-side auto-open wiring
 * ------------------------------------------------------------------ */

let autoOpenRegistered = false;

/**
 * Subscribe to SESSION_OPEN events for this client. When the GM opens
 * a session targeted at this user, open the session window
 * automatically.
 */
export function registerMerchantSessionAutoOpen() {
  if (autoOpenRegistered) return;
  autoOpenRegistered = true;
  subscribe(MERCHANT_EVENTS.SESSION_OPEN, (payload) => {
    if (!payload) return;
    if (
      payload.targetUserId &&
      payload.targetUserId !== globalThis.game?.user?.id
    ) {
      return;
    }
    MerchantSessionApp.open({
      sessionId: payload.sessionId,
      merchant: payload.merchant,
    });
  });
}

/* ------------------------------------------------------------------ *
 * Helpers
 * ------------------------------------------------------------------ */

function resolvePlayerActor() {
  const assigned = globalThis.game?.user?.character;
  if (assigned) return assigned;
  // Fall back: first character actor the user owns.
  const actors = globalThis.game?.actors;
  if (!actors) return null;
  return (
    actors.find?.(
      (a) =>
        a?.type === "character" &&
        a?.testUserPermission?.(globalThis.game?.user, "OWNER"),
    ) ?? null
  );
}

function walletGpFromObject(wallet) {
  return (
    (wallet.pp ?? 0) * 10 +
    (wallet.gp ?? 0) +
    (wallet.ep ?? 0) * 0.5 +
    (wallet.sp ?? 0) * 0.1 +
    (wallet.cp ?? 0) * 0.01
  );
}

function formatDelta(deltaPct) {
  const n = Number(deltaPct) || 0;
  if (n === 0) return "no change";
  return `${n > 0 ? "+" : ""}${n.toFixed(0)}%`;
}

function sealLabel(seal) {
  if (!seal) return "";
  const tierName = seal.tier?.id ?? "seal";
  return `${tierName} ${formatDelta(seal.deltaPct)}`;
}

/** "very-rare" → "Very Rare" for the rarity badge. Empty in → empty out. */
function prettyRarity(rarity) {
  return String(rarity ?? "")
    .split("-")
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

function cssEscape(value) {
  if (typeof CSS !== "undefined" && typeof CSS.escape === "function") {
    return CSS.escape(String(value ?? ""));
  }
  return String(value ?? "").replace(/[^a-zA-Z0-9_-]/g, "\\$&");
}

async function promptSkillPicker(allowedSkills) {
  const DialogV2 = foundry?.applications?.api?.DialogV2;
  const labels = {
    prf: "Persuasion",
    dec: "Deception",
    itm: "Intimidation",
  };
  const allowed = Array.isArray(allowedSkills) && allowedSkills.length > 0
    ? allowedSkills
    : ["prf", "dec"];
  if (allowed.length === 1) return allowed[0];
  if (!DialogV2) return allowed[0];
  const options = allowed
    .map(
      (id) =>
        `<option value="${id}">${labels[id] ?? id}</option>`,
    )
    .join("");
  let picked = null;
  try {
    picked = await DialogV2.prompt({
      window: { title: "Bargain — pick skill", icon: "fa-solid fa-comments-dollar" },
      content: `
        <p>Choose how you want to haggle:</p>
        <label style="display:grid;gap:4px;">
          <span>Skill</span>
          <select name="skillId">${options}</select>
        </label>
      `,
      ok: {
        label: "Roll",
        callback: (_event, button) =>
          button?.form?.elements?.skillId?.value ?? null,
      },
      rejectClose: false,
    });
  } catch {
    picked = null;
  }
  return picked;
}
