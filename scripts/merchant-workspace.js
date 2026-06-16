/**
 * Infinity D&D5e — MerchantWorkspaceApp
 *
 * GM-only singleton window for curating merchant records and pushing
 * sessions to players. Merchant data lives in the MERCHANTS world
 * setting via `merchant/store.js`; this app is the editor on top.
 */

import {
  BARGAIN_SKILLS,
  clearInventory,
  computeBuyPriceGp,
  createBlankMerchant,
  createInventoryRow,
  deleteMerchant,
  duplicateMerchant,
  findMerchant,
  getSelfServiceMode,
  loadMerchants,
  normalizeInventoryRow,
  normalizeMerchant,
  promoteSelfServiceMode,
  removeInventoryRow,
  resolveStockQty,
  restockAll,
  SELF_SERVICE_MODES,
  upsertInventoryRow,
  upsertMerchant,
} from "./merchant/store.js";
import { rollMerchantStock } from "./merchant/pool.js";
import { MerchantSessionApp } from "./merchant-session.js";
import {
  captureScroll,
  restoreScroll,
  bindScrollTracking,
} from "./merchant/scroll.js";
import {
  RARITY_BALANCE_CUSTOM_KEY,
  RARITY_BALANCE_DEFAULT_KEY,
  getRarityBalancePresetWeights,
  normalizeRarityBalanceKey,
  rarityBalanceOptions,
  rarityWeightRows,
  resolveRarityWeights,
} from "./loot/rarity-balance.js";
import { LOOT_TYPES, RARITIES, getItemRarity } from "./loot/tag-vocabulary.js";
import { formatValueRange, marketTierOptions } from "./loot/value-filter.js";
import {
  escapeHtml,
  formatMultiplier,
  prettyLootType,
  prettyRarity,
  notify,
} from "./ui-util.js";
import {
  commitMerchantWrite,
  MERCHANT_EVENTS,
  pushCloseAllSessionsFor,
  pushCloseSession,
  pushOpenSession,
  subscribe,
} from "./merchant/socket.js";
import { listSessions } from "./merchant/session-state.js";
import { loadCompendiumItems } from "./loot/pack.js";
import {
  bindRowDoubleClickOpen,
  openItemByUuid,
  wireBackgroundImageFallback,
} from "./loot/loot-app-shared.js";
import { SOUND_EVENTS, playModuleSound } from "./audio.js";
import { SETTING_KEYS, getSetting } from "./settings.js";

const MODULE_ID = "infinity-dnd5e";
const TEMPLATE_PATH = `modules/${MODULE_ID}/templates/merchant-workspace.hbs`;
const FALLBACK_ART = "icons/svg/shop.svg";
const FALLBACK_ITEM_IMAGE = "icons/svg/item-bag.svg";

/** Plain-language labels for the self-service access modes (matches the order
 *  of SELF_SERVICE_MODES). */
const SELF_SERVICE_LABELS = {
  off: "Off — only the GM opens it",
  open: "Open — allowed players walk in",
  knock: "Knock — players ask, you approve",
};

/** Scroll panes whose position survives action re-renders. */
const SCROLL_TARGETS = [
  { key: "list", selector: ".mw-list" },
  { key: "edit", selector: ".mw-edit" },
];

const { ApplicationV2, HandlebarsApplicationMixin } = foundry.applications.api;

export class MerchantWorkspaceApp extends HandlebarsApplicationMixin(
  ApplicationV2,
) {
  static _instance = null;

  static DEFAULT_OPTIONS = {
    id: "infinity-dnd5e-merchant-workspace",
    tag: "section",
    classes: ["infinity-dnd5e", "infinity-merchant-workspace"],
    window: {
      title: "Infinity D&D5e — Merchant Workspace",
      icon: "fa-solid fa-store",
      resizable: true,
    },
    position: { width: 1000, height: 720 },
    actions: {
      newMerchant: MerchantWorkspaceApp._onNewMerchant,
      selectMerchant: MerchantWorkspaceApp._onSelectMerchant,
      save: MerchantWorkspaceApp._onSave,
      deleteMerchant: MerchantWorkspaceApp._onDeleteMerchant,
      duplicateMerchant: MerchantWorkspaceApp._onDuplicateMerchant,
      addFromPack: MerchantWorkspaceApp._onAddFromPack,
      marketTier: MerchantWorkspaceApp._onMarketTier,
      generateStock: MerchantWorkspaceApp._onGenerateStock,
      regenerateStock: MerchantWorkspaceApp._onRegenerateStock,
      copyStockToBuyFilter: MerchantWorkspaceApp._onCopyStockToBuyFilter,
      clearInventory: MerchantWorkspaceApp._onClearInventory,
      restock: MerchantWorkspaceApp._onRestock,
      pickArt: MerchantWorkspaceApp._onPickArt,
      previewSession: MerchantWorkspaceApp._onPreviewSession,
      openSession: MerchantWorkspaceApp._onOpenSession,
      closeSession: MerchantWorkspaceApp._onCloseSession,
      invRemove: MerchantWorkspaceApp._onInvRemove,
    },
  };

  static PARTS = {
    body: { template: TEMPLATE_PATH },
  };

  static open() {
    if (!globalThis.game?.user?.isGM) {
      notify("warn", `Merchant Workspace is GM-only.`);
      return null;
    }
    playModuleSound(SOUND_EVENTS.UI_OPEN);
    if (!MerchantWorkspaceApp._instance) {
      MerchantWorkspaceApp._instance = new MerchantWorkspaceApp();
    }
    if (MerchantWorkspaceApp._instance.rendered) {
      MerchantWorkspaceApp._instance.bringToFront();
    } else {
      MerchantWorkspaceApp._instance.render(true);
    }
    return MerchantWorkspaceApp._instance;
  }

  constructor(options = {}) {
    super(options);
    this._selectedId = null;
    this._itemCache = new Map(); // uuid → resolved item snapshot
    // Re-render on stock changes AND on session open/close so the "Active
    // Sessions" list stays accurate even when a player closes their own window.
    this._unsubs = [
      subscribe(MERCHANT_EVENTS.STATE_UPDATE, () => this.render(false)),
      subscribe(MERCHANT_EVENTS.SESSION_OPEN, () => this.render(false)),
      subscribe(MERCHANT_EVENTS.SESSION_CLOSE, () => this.render(false)),
    ];
  }

  _onClose(options) {
    super._onClose?.(options);
    for (const fn of this._unsubs ?? []) {
      try {
        fn();
      } catch {}
    }
    this._unsubs = [];
    MerchantWorkspaceApp._instance = null;
  }

  /* -------------------- context -------------------- */

  async _prepareContext() {
    const merchants = loadMerchants();
    // Resolve the selection, re-anchoring to the first merchant when the stored
    // id no longer exists (e.g. another GM client / external settings edit
    // deleted the selected merchant, then an unrelated broadcast re-rendered
    // this workspace). Without this, a dangling _selectedId stays truthy, so the
    // auto-select guard never fires again and the editor is permanently blank.
    let selected = this._selectedId
      ? (merchants.find((m) => m.id === this._selectedId) ?? null)
      : null;
    if (!selected && merchants.length > 0) {
      selected = merchants[0];
      this._selectedId = selected.id;
    } else if (!selected) {
      this._selectedId = null;
    }

    await this._refreshItemCache(merchants);

    const merchantList = merchants.map((m) => ({
      id: m.id,
      name: m.name,
      art: m.art || FALLBACK_ART,
      itemCount: m.items.length,
      itemCountIsOne: m.items.length === 1,
      allowedCount: m.allowedUserIds.length,
      allowedCountIsOne: m.allowedUserIds.length === 1,
      selected: m.id === this._selectedId,
    }));

    const players = listActivePlayerUsers();
    const skillOptions = Object.entries(BARGAIN_SKILLS).map(([id, label]) => ({
      id,
      label,
      checked: selected ? selected.allowedSkills.includes(id) : false,
    }));

    const playerOptions = players.map((u) => ({
      id: u.id,
      name: u.name,
      checked: selected ? selected.allowedUserIds.includes(u.id) : false,
    }));

    const selfServiceMode = selected ? getSelfServiceMode(selected) : "off";
    const selfServiceOptions = SELF_SERVICE_MODES.map((value) => ({
      value,
      label: SELF_SERVICE_LABELS[value] ?? value,
      selected: value === selfServiceMode,
    }));
    // Warn when a shop has allowed players but is still GM-pull-only ("off"):
    // those players will NOT see it in their Shops door. Surfaces the silent
    // "players can't open any shops" state on existing shops.
    const selfServiceOffWithPlayers =
      Boolean(selected) &&
      selfServiceMode === "off" &&
      selected.allowedUserIds.length > 0;

    const pool = selected?.pool ?? {
      lootTypes: [],
      rarities: [],
      count: 6,
      budgetGp: 0,
      rarityBalance: RARITY_BALANCE_DEFAULT_KEY,
      rarityWeights: getRarityBalancePresetWeights(RARITY_BALANCE_DEFAULT_KEY),
      minGp: 0,
      maxGp: 0,
    };
    const poolMinGp = Math.max(0, Number(pool.minGp) || 0);
    const poolMaxGp = Math.max(0, Number(pool.maxGp) || 0);
    const poolBudgetGp = Math.max(0, Number(pool.budgetGp) || 0);
    const poolRarityBalance = normalizeRarityBalanceKey(pool.rarityBalance);
    const poolRarityWeights = resolveRarityWeights(
      poolRarityBalance,
      pool.rarityWeights,
    );
    const poolLootTypeSet = new Set(pool.lootTypes);
    const poolRaritySet = new Set(pool.rarities);
    const poolLootTypeOptions = LOOT_TYPES.map((value) => ({
      value,
      label: prettyLootType(value),
      checked: poolLootTypeSet.has(value),
    }));
    const poolRarityOptions = RARITIES.map((value) => ({
      value,
      label: prettyRarity(value),
      checked: poolRaritySet.has(value),
    }));

    // "Buys From Players" — mirror of the stock pool, applied to the sell side.
    const buyFilter = selected?.buyFilter ?? { lootTypes: [], rarities: [] };
    const buyFilterLootTypeSet = new Set(buyFilter.lootTypes);
    const buyFilterRaritySet = new Set(buyFilter.rarities);
    const buyFilterLootTypeOptions = LOOT_TYPES.map((value) => ({
      value,
      label: prettyLootType(value),
      checked: buyFilterLootTypeSet.has(value),
    }));
    const buyFilterRarityOptions = RARITIES.map((value) => ({
      value,
      label: prettyRarity(value),
      checked: buyFilterRaritySet.has(value),
    }));
    const buysAnything =
      buyFilter.lootTypes.length === 0 && buyFilter.rarities.length === 0;

    const inventoryRows = selected
      ? selected.items.map((row) => this._buildInventoryViewRow(selected, row))
      : [];

    const activeSessions = selected
      ? listSessions()
          .filter((s) => s.merchantId === selected.id)
          .map((s) => ({
            sessionId: s.sessionId,
            userLabel: lookupUserName(s.viewerUserId),
          }))
      : [];

    return {
      moduleId: MODULE_ID,
      hasMerchants: merchants.length > 0,
      merchants: merchantList,
      selected: selected
        ? {
            ...selected,
            art: selected.art || FALLBACK_ART,
            itemCountIsOne: selected.items.length === 1,
          }
        : null,
      hasPlayers: players.length > 0,
      playerOptions,
      selfServiceOptions,
      selfServiceOffWithPlayers,
      skillOptions,
      poolLootTypeOptions,
      poolRarityOptions,
      poolRarityBalanceOptions: rarityBalanceOptions(poolRarityBalance),
      poolRarityWeightRows: rarityWeightRows(poolRarityWeights),
      // Blank when there's no line cap (0 = fill toward the stock budget).
      poolCount: Number(pool.count) > 0 ? pool.count : "",
      poolBudgetGp: poolBudgetGp > 0 ? poolBudgetGp : "",
      poolMinGp,
      poolMaxGp,
      poolValueRangeLabel: formatValueRange(poolMinGp, poolMaxGp),
      poolMarketTiers: marketTierOptions(poolMinGp, poolMaxGp),
      buyFilterLootTypeOptions,
      buyFilterRarityOptions,
      buysAnything,
      inventoryRows,
      activeSessions,
      canOpenSession:
        Boolean(selected) &&
        selected.allowedUserIds.length > 0 &&
        Boolean(globalThis.game?.users?.activeGM),
      // Why the Open Session button is disabled, so the button can say so.
      openSessionReason: !selected
        ? "Select a merchant first."
        : selected.allowedUserIds.length === 0
          ? "Add at least one Allowed Player to open a session."
          : !globalThis.game?.users?.activeGM
            ? "An active GM must be online to host."
            : "",
    };
  }

  _buildInventoryViewRow(merchant, row) {
    const item = this._itemCache.get(row.uuid) ?? null;
    const basePrice = computeBuyPriceGp(merchant, row, item);
    const outOfStock = !row.unlimited && row.qty <= 0;
    const rarity = item ? getItemRarity(item) : "";
    return {
      uuid: row.uuid,
      name: item?.name ?? "(unknown item)",
      img: item?.img ?? FALLBACK_ITEM_IMAGE,
      rarity,
      rarityLabel: prettyRarity(rarity),
      basePriceLabel: basePrice > 0 ? `${basePrice.toFixed(2)} gp` : "—",
      qtyDisplay: row.unlimited ? "∞" : row.qty,
      startingQty: row.startingQty,
      priceOverrideDisplay:
        row.priceOverrideGp == null ? "" : row.priceOverrideGp,
      unlimited: row.unlimited,
      missing: !item,
      outOfStock,
    };
  }

  async _refreshItemCache(merchants) {
    const allUuids = new Set();
    for (const merchant of merchants) {
      for (const row of merchant.items) allUuids.add(row.uuid);
    }
    for (const uuid of allUuids) {
      if (this._itemCache.has(uuid)) continue;
      try {
        const doc = await fromUuid(uuid);
        if (!doc) {
          this._itemCache.set(uuid, null);
          continue;
        }
        const snapshot =
          typeof doc.toObject === "function" ? doc.toObject() : { ...doc };
        if (!snapshot.uuid) snapshot.uuid = doc.uuid ?? uuid;
        this._itemCache.set(uuid, snapshot);
      } catch (error) {
        console.warn(`${MODULE_ID} | failed to resolve item ${uuid}`, error);
        this._itemCache.set(uuid, null);
      }
    }
  }

  _onRender(context, options) {
    super._onRender?.(context, options);

    // Honor the existing animation + rarity-glow client settings.
    const animations = getSetting(SETTING_KEYS.ANIMATIONS) !== false;
    this.element?.classList?.toggle("mw-no-anim", !animations);
    this.element?.classList?.toggle(
      "mw-no-glow",
      getSetting(SETTING_KEYS.RARITY_GLOW) === false,
    );

    this._wireFormChange();
    this._wireInventoryInputs();
    this._wireDropZone();
    this._wireInventorySearch();

    // Enter = primary action (Generate Stock — a safe, deduped append), matching
    // the loot tools' Enter/R. Bound once; skips form fields + honors the setting.
    if (this.element && this.element.dataset.idxKeydownBound !== "true") {
      this.element.dataset.idxKeydownBound = "true";
      this.element.addEventListener("keydown", (event) => {
        if (getSetting(SETTING_KEYS.KEYBOARD_SHORTCUTS) === false) return;
        if (event.key !== "Enter" || event.defaultPrevented) return;
        const tag = event.target?.tagName?.toLowerCase();
        if (tag === "input" || tag === "select" || tag === "textarea") return;
        event.preventDefault();
        void this.constructor._onGenerateStock.call(this);
      });
    }

    if (this.element) {
      // Recover broken inventory thumbnails (background-image, no onerror).
      wireBackgroundImageFallback(this.element, ".mw-inv__icon");
      // Repo-wide standard: double-click an inventory row to open its sheet.
      bindRowDoubleClickOpen(this.element, {
        rowSelector: ".mw-inv__row",
        onOpen: (uuid) =>
          openItemByUuid(uuid, {
            onOpened: () => playModuleSound(SOUND_EVENTS.ITEM_OPEN),
          }),
      });
    }

    // Preserve scroll position across action re-renders (select merchant,
    // edit a row, generate stock…) so the view never snaps to the top.
    const root = this.element;
    if (root) {
      bindScrollTracking(root, SCROLL_TARGETS, () => {
        this._scroll = captureScroll(root, SCROLL_TARGETS);
      });
      restoreScroll(root, SCROLL_TARGETS, this._scroll);
    }
  }

  _wireFormChange() {
    const form = this.element?.querySelector?.('[data-form="merchant-edit"]');
    if (!form) return;
    form.addEventListener("change", async (event) => {
      const target = event.target;
      if (!(target instanceof HTMLElement)) return;
      const name = target.getAttribute?.("name");
      if (!name) return;
      // Inventory rows carry data-role and are saved by their own
      // delegated handler — skip them here so we don't double-write
      // (and clobber the row change with stale inventory).
      if (target.dataset?.action || target.dataset?.role) return;
      if (name === "poolRarityBalance") {
        applyRarityBalancePresetToForm(form, target.value);
      } else if (name.startsWith("poolRarityWeight.")) {
        const select = form.querySelector('[name="poolRarityBalance"]');
        if (select) select.value = RARITY_BALANCE_CUSTOM_KEY;
      }
      // Auto-save on change for top-level fields.
      try {
        await this._saveFromForm();
      } catch (error) {
        console.warn(`${MODULE_ID} | merchant auto-save failed`, error);
      }
    });
  }

  /**
   * Wire the per-row inventory inputs. ApplicationV2's `data-action`
   * dispatch is click-based, so number inputs (which change on
   * blur/enter) are handled with an explicit delegated `change`
   * listener instead — mirroring the loot app's form wiring.
   */
  _wireInventoryInputs() {
    const drop = this.element?.querySelector?.('[data-drop-zone="inventory"]');
    if (!drop) return;
    drop.addEventListener("change", async (event) => {
      const target = event.target;
      if (!(target instanceof HTMLElement)) return;
      const role = target.dataset?.role;
      const uuid = target.dataset?.uuid;
      if (!role || !uuid) return;
      // Don't let inventory edits bubble to the form-level auto-save.
      event.stopPropagation();
      try {
        if (role === "invUnlimited") {
          await this._mutateInventoryRow(uuid, (row) => ({
            ...row,
            unlimited: target.checked === true,
          }));
          // Re-render: toggling unlimited changes the qty field's
          // disabled state and the price readout.
          this.render(false);
        } else if (role === "invQty") {
          const value = Math.max(0, Math.floor(Number(target.value) || 0));
          await this._mutateInventoryRow(uuid, (row) => ({
            ...row,
            qty: value,
          }));
        } else if (role === "invStartQty") {
          const value = Math.max(0, Math.floor(Number(target.value) || 0));
          await this._mutateInventoryRow(uuid, (row) => ({
            ...row,
            startingQty: value,
          }));
        } else if (role === "invPriceOverride") {
          const raw = target.value;
          const value =
            raw === "" || raw == null ? null : Math.max(0, Number(raw));
          await this._mutateInventoryRow(uuid, (row) => ({
            ...row,
            priceOverrideGp: Number.isFinite(value) ? value : null,
          }));
        }
      } catch (error) {
        console.warn(`${MODULE_ID} | inventory row update failed`, error);
      }
    });
  }

  /**
   * Client-side filter over the inventory rows by item name / rarity. Hides
   * non-matching rows in place without a re-render — mirrors the loot
   * windows' result-search box.
   */
  _wireInventorySearch() {
    const search = this.element?.querySelector?.("[data-inv-search]");
    if (!search) return;
    search.addEventListener("input", (event) =>
      this._applyInventorySearch(String(event.target?.value ?? "")),
    );
  }

  _applyInventorySearch(query) {
    const root = this.element;
    if (!root) return;
    const needle = query.trim().toLowerCase();
    let shown = 0;
    for (const row of root.querySelectorAll(".mw-inv__row")) {
      const hay = (
        row.dataset.searchText ??
        row.textContent ??
        ""
      ).toLowerCase();
      const match = !needle || hay.includes(needle);
      row.toggleAttribute("hidden", !match);
      if (match) shown += 1;
    }
    const count = root.querySelector("[data-inv-search-count]");
    if (count) count.textContent = needle ? `${shown} shown` : "";
  }

  _wireDropZone() {
    const drop = this.element?.querySelector?.('[data-drop-zone="inventory"]');
    if (!drop) return;
    drop.addEventListener("dragover", (event) => {
      event.preventDefault();
      drop.classList.add("is-drop-target");
    });
    drop.addEventListener("dragleave", () => {
      drop.classList.remove("is-drop-target");
    });
    drop.addEventListener("drop", async (event) => {
      event.preventDefault();
      drop.classList.remove("is-drop-target");
      const uuid = extractDroppedItemUuid(event);
      if (!uuid) return;
      await this._addUuidToInventory(uuid);
    });
  }

  async _addUuidToInventory(uuid) {
    if (!this._selectedId) return;
    const merchant = findMerchant(this._selectedId);
    if (!merchant) return;
    const exists = merchant.items.some((r) => r.uuid === uuid);
    if (exists) {
      notify("info", `already in inventory.`);
      return;
    }
    // Ammunition always stocks as a full stack of 20; everything else as 1.
    const item = await this._resolveItem(uuid);
    const qty = resolveStockQty(item, 1);
    await commitMerchantWrite(
      this._selectedId,
      (fresh) =>
        fresh.items.some((r) => r.uuid === uuid)
          ? null
          : upsertInventoryRow(
              fresh,
              createInventoryRow(uuid, { qty, startingQty: qty }),
            ),
      { broadcast: true },
    );
    playModuleSound(SOUND_EVENTS.ROSTER_ADD);
    this.render(false);
  }

  /** Resolve an item snapshot by uuid, using the render cache when warm. */
  async _resolveItem(uuid) {
    if (this._itemCache.has(uuid)) return this._itemCache.get(uuid);
    try {
      const doc = await fromUuid(uuid);
      const snapshot = doc?.toObject?.() ?? (doc ? { ...doc } : null);
      if (snapshot && !snapshot.uuid) snapshot.uuid = doc?.uuid ?? uuid;
      this._itemCache.set(uuid, snapshot);
      return snapshot;
    } catch {
      this._itemCache.set(uuid, null);
      return null;
    }
  }

  async _saveFromForm() {
    if (!this._selectedId) return;
    const form = this.element?.querySelector?.('[data-form="merchant-edit"]');
    if (!form) return;
    const merchant = findMerchant(this._selectedId);
    if (!merchant) return;
    const data = readFormFields(form);
    // Build the next record from the FRESH merchant inside the per-merchant
    // mutex so a concurrent player purchase (which decrements stock under the
    // same lock) isn't clobbered back by this config save's stale snapshot.
    await commitMerchantWrite(
      this._selectedId,
      (fresh) =>
        normalizeMerchant({
          ...fresh,
          name: data.name ?? fresh.name,
          art: data.art ?? fresh.art,
          description: data.description ?? fresh.description,
          defaultMarkup: Number(data.defaultMarkup ?? fresh.defaultMarkup),
          sellRatio: Number(data.sellRatio ?? fresh.sellRatio),
          bargainDC: Number(data.bargainDC ?? fresh.bargainDC),
          bargainAdvantage: data.bargainAdvantage === "on",
          bargainSuccessPct: Number(
            data.bargainSuccessPct ?? fresh.bargainSuccessPct,
          ),
          bargainFailPct: Number(data.bargainFailPct ?? fresh.bargainFailPct),
          passiveHaggle: data.passiveHaggle === "on",
          passivePctPerPoint: Number(
            data.passivePctPerPoint ?? fresh.passivePctPerPoint,
          ),
          passiveCapPct: Number(data.passiveCapPct ?? fresh.passiveCapPct),
          goldOnHand: data.goldOnHand,
          allowedSkills: data.allowedSkills,
          allowedUserIds: data.allowedUserIds,
          // First time a shop gains an allowed player, flip it from the default
          // "off" to "open" so it appears in that player's Shops door — else GMs
          // tick a player, see nothing, and conclude "players can't open shops".
          // Only auto-promote on the no-players → has-players step; a GM who
          // wants a GM-pull-only shop can still set "off"/"knock".
          selfServiceMode: promoteSelfServiceMode(
            data.selfServiceMode,
            (fresh.allowedUserIds?.length ?? 0) > 0,
            (data.allowedUserIds?.length ?? 0) > 0,
          ),
          pool: {
            lootTypes: data.poolLootTypes,
            rarities: data.poolRarities,
            // Blank "Max lines" → 0 (no cap, fill toward the budget instead).
            count: data.poolCount === "" ? 0 : Number(data.poolCount ?? 6),
            budgetGp:
              data.poolBudgetGp === "" ? 0 : Number(data.poolBudgetGp ?? 0),
            rarityBalance: data.poolRarityBalance,
            rarityWeights: data.poolRarityWeights,
            minGp: Number(data.poolMinGp ?? fresh.pool?.minGp ?? 0),
            maxGp: Number(data.poolMaxGp ?? fresh.pool?.maxGp ?? 0),
          },
          buyFilter: {
            lootTypes: data.buyFilterLootTypes,
            rarities: data.buyFilterRarities,
          },
        }),
      { broadcast: true },
    );
  }

  /* -------------------- actions -------------------- */

  static async _onNewMerchant() {
    const blank = createBlankMerchant({ name: "New Merchant" });
    await upsertMerchant(blank);
    this._selectedId = blank.id;
    playModuleSound(SOUND_EVENTS.PRESET_APPLY);
    this.render(false);
  }

  static async _onDuplicateMerchant() {
    if (!this._selectedId) return;
    const merchant = findMerchant(this._selectedId);
    if (!merchant) return;
    const copy = duplicateMerchant(merchant);
    await upsertMerchant(copy);
    this._selectedId = copy.id;
    playModuleSound(SOUND_EVENTS.PRESET_APPLY);
    ui.notifications?.info(
      `${MODULE_ID}: duplicated ${merchant.name} (inventory left empty).`,
    );
    this.render(false);
  }

  static _onSelectMerchant(_event, target) {
    const id = target?.dataset?.merchantId;
    if (!id) return;
    this._selectedId = id;
    playModuleSound(SOUND_EVENTS.ITEM_OPEN);
    this.render(false);
  }

  static async _onSave() {
    try {
      await this._saveFromForm();
      playModuleSound(SOUND_EVENTS.LOCK_TOGGLE);
      notify("info", `merchant saved.`);
    } catch (error) {
      console.error(`${MODULE_ID} | save failed`, error);
      notify("error", `save failed. See console.`);
    }
  }

  static async _onDeleteMerchant() {
    if (!this._selectedId) return;
    const merchant = findMerchant(this._selectedId);
    if (!merchant) return;
    const DialogV2 = foundry?.applications?.api?.DialogV2;
    if (!DialogV2) return;
    const confirmed = await DialogV2.confirm({
      window: {
        title: `Delete "${merchant.name}"?`,
        icon: "fa-solid fa-trash",
      },
      content: `<p>This will remove <strong>${escapeHtml(merchant.name)}</strong> and close any open sessions for them. Item compendium entries are untouched.</p>`,
      rejectClose: false,
    });
    if (!confirmed) return;
    pushCloseAllSessionsFor(this._selectedId);
    await deleteMerchant(this._selectedId);
    this._selectedId = null;
    playModuleSound(SOUND_EVENTS.CLEAR_RESET);
    this.render(false);
  }

  static async _onAddFromPack() {
    if (!this._selectedId) return;
    const merchant = findMerchant(this._selectedId);
    if (!merchant) return;
    const items = await loadCompendiumItems().catch(() => []);
    if (items.length === 0) {
      notify("warn", `no items in compendium.`);
      return;
    }
    const DialogV2 = foundry?.applications?.api?.DialogV2;
    if (!DialogV2) return;

    // Build options sorted by name; filter out duplicates already on the merchant.
    const existing = new Set(merchant.items.map((r) => r.uuid));
    const candidates = items
      .filter((item) => !existing.has(item.uuid))
      .sort((a, b) => String(a.name).localeCompare(String(b.name)));

    if (candidates.length === 0) {
      notify("info", `every pack item already stocked.`);
      return;
    }

    const options = candidates
      .slice(0, 300)
      .map(
        (item) =>
          `<option value="${escapeHtml(item.uuid)}">${escapeHtml(item.name)}</option>`,
      )
      .join("");

    let pickedUuid = null;
    try {
      pickedUuid = await DialogV2.prompt({
        window: { title: "Add Item to Merchant", icon: "fa-solid fa-box-open" },
        content: `
          <div class="mw-pick">
            <label style="display:grid;gap:4px;">
              <span>Item</span>
              <select name="uuid" size="14" style="height:240px;width:100%;">${options}</select>
            </label>
            <p style="opacity:0.7;font-size:0.85rem;">Showing up to 300 items not yet on this merchant.</p>
          </div>
        `,
        ok: {
          label: "Add",
          icon: "fa-solid fa-plus",
          callback: (_event, button) =>
            button?.form?.elements?.uuid?.value ?? null,
        },
        rejectClose: false,
      });
    } catch {
      pickedUuid = null;
    }
    if (!pickedUuid) return;
    await this._addUuidToInventory(pickedUuid);
  }

  static async _onMarketTier(_event, target) {
    if (!this._selectedId) return;
    const form = this.element?.querySelector?.('[data-form="merchant-edit"]');
    if (!form) return;
    const min = Math.max(0, Math.floor(Number(target?.dataset?.min) || 0));
    const max = Math.max(0, Math.floor(Number(target?.dataset?.max) || 0));
    const minInput = form.querySelector('[name="poolMinGp"]');
    const maxInput = form.querySelector('[name="poolMaxGp"]');
    if (minInput) minInput.value = String(min);
    if (maxInput) maxInput.value = String(max);
    try {
      await this._saveFromForm();
    } catch {}
    playModuleSound(SOUND_EVENTS.PRESET_APPLY);
    this.render(false);
  }

  static async _onGenerateStock() {
    return this._generateStock({ replace: false });
  }

  static async _onRegenerateStock() {
    return this._generateStock({ replace: true });
  }

  /**
   * Roll the pool into inventory. `replace: true` clears all existing
   * stock first (Re-Generate); `false` appends deduped (Generate).
   */
  async _generateStock({ replace }) {
    if (!this._selectedId) return;
    // Persist pending form edits (e.g. just-toggled pool chips) so we roll
    // against the latest config, not the last-saved one.
    try {
      await this._saveFromForm();
    } catch {}
    let merchant = findMerchant(this._selectedId);
    if (!merchant) return;
    const pool = merchant.pool ?? { lootTypes: [], rarities: [], count: 6 };
    if (
      (pool.lootTypes?.length ?? 0) === 0 &&
      (pool.rarities?.length ?? 0) === 0
    ) {
      ui.notifications?.warn(
        `${MODULE_ID}: pick at least one item type or rarity for the pool.`,
      );
      return;
    }
    const items = await loadCompendiumItems().catch(() => []);
    if (items.length === 0) {
      ui.notifications?.warn("No items found in the compendium.");
      return;
    }
    // Re-Generate clears the whole shelf first — confirm if there's curated
    // stock to lose (Generate, which appends, never needs this).
    if (replace && merchant.items.length > 0) {
      const DialogV2 = foundry?.applications?.api?.DialogV2;
      const confirmed = DialogV2
        ? await DialogV2.confirm({
            window: {
              title: "Replace all stock?",
              icon: "fa-solid fa-arrows-rotate",
            },
            content: `<p>Clear all <strong>${merchant.items.length}</strong> current item(s) from <strong>${escapeHtml(merchant.name)}</strong> and roll a fresh shelf? (Use <em>Generate</em> instead to add without clearing.)</p>`,
            rejectClose: false,
          })
        : true;
      if (!confirmed) return;
    }
    if (replace) merchant = clearInventory(merchant);
    const exclude = new Set(merchant.items.map((r) => r.uuid));
    // Also exclude by name so an append can't add a different library entry
    // that happens to share a display name with something already on the shelf.
    const nameByUuid = new Map(items.map((it) => [it.uuid, it.name]));
    const excludeNames = new Set();
    for (const r of merchant.items) {
      const name = nameByUuid.get(r.uuid) ?? this._itemCache.get(r.uuid)?.name;
      if (name) excludeNames.add(name);
    }
    const { rows, warnings } = rollMerchantStock(pool, items, {
      exclude,
      excludeNames,
    });
    if (rows.length === 0) {
      ui.notifications?.warn(
        `${MODULE_ID}: ${warnings[0] ?? "nothing generated."}`,
      );
      return;
    }
    await commitMerchantWrite(
      this._selectedId,
      (fresh) => {
        let next = fresh;
        for (const row of rows) next = upsertInventoryRow(next, row);
        return next;
      },
      { broadcast: true },
    );
    playModuleSound(SOUND_EVENTS.ROLL_START);
    ui.notifications?.info(
      `${MODULE_ID}: ${replace ? "re-stocked" : "generated"} ${rows.length} item(s) for ${merchant.name}.`,
    );
    this.render(false);
  }

  /** Copy the Random Stock item-types + rarities into the Buys-From-Players
   *  filter, so a merchant buys back the same kinds of goods it sells. */
  static async _onCopyStockToBuyFilter() {
    if (!this._selectedId) return;
    // Persist pending form edits so we copy the latest pool selections.
    try {
      await this._saveFromForm();
    } catch {}
    const merchant = findMerchant(this._selectedId);
    if (!merchant) return;
    await commitMerchantWrite(
      this._selectedId,
      (fresh) =>
        normalizeMerchant({
          ...fresh,
          buyFilter: {
            lootTypes: [...fresh.pool.lootTypes],
            rarities: [...fresh.pool.rarities],
          },
        }),
      { broadcast: true },
    );
    playModuleSound(SOUND_EVENTS.PRESET_APPLY);
    ui.notifications?.info(
      `${MODULE_ID}: copied stock types & rarities into the buy filter.`,
    );
    this.render(false);
  }

  static async _onClearInventory() {
    if (!this._selectedId) return;
    const merchant = findMerchant(this._selectedId);
    if (!merchant || merchant.items.length === 0) return;
    const DialogV2 = foundry?.applications?.api?.DialogV2;
    const confirmed = DialogV2
      ? await DialogV2.confirm({
          window: { title: "Clear inventory?", icon: "fa-solid fa-trash" },
          content: `<p>Remove all <strong>${merchant.items.length}</strong> item(s) from <strong>${escapeHtml(merchant.name)}</strong>? Compendium entries are untouched.</p>`,
          rejectClose: false,
        })
      : true;
    if (!confirmed) return;
    await commitMerchantWrite(
      this._selectedId,
      (fresh) => clearInventory(fresh),
      { broadcast: true },
    );
    playModuleSound(SOUND_EVENTS.CLEAR_RESET);
    this.render(false);
  }

  static async _onPickArt() {
    const input = this.element?.querySelector?.('input[name="art"]');
    const FP =
      foundry?.applications?.apps?.FilePicker?.implementation ??
      globalThis.FilePicker;
    if (!FP) {
      notify("warn", `file picker unavailable.`);
      return;
    }
    const picker = new FP({
      type: "image",
      current: input?.value || "",
      callback: async (path) => {
        if (input) input.value = path;
        try {
          await this._saveFromForm();
        } catch {}
        this.render(false);
      },
    });
    picker.render(true);
  }

  static async _onRestock() {
    if (!this._selectedId) return;
    const merchant = findMerchant(this._selectedId);
    if (!merchant) return;
    // Confirm before overwriting hand-tuned quantities (mirrors Clear All).
    const finiteRows = merchant.items.filter((r) => !r.unlimited);
    if (finiteRows.length > 0) {
      const DialogV2 = foundry?.applications?.api?.DialogV2;
      const confirmed = DialogV2
        ? await DialogV2.confirm({
            window: {
              title: "Restock all items?",
              icon: "fa-solid fa-boxes-stacked",
            },
            content: `<p>Reset every item's current quantity back to its starting amount for <strong>${escapeHtml(merchant.name)}</strong>? This discards any current-stock changes.</p>`,
            rejectClose: false,
          })
        : true;
      if (!confirmed) return;
    }
    await commitMerchantWrite(this._selectedId, (fresh) => restockAll(fresh), {
      broadcast: true,
    });
    playModuleSound(SOUND_EVENTS.ROLL_START);
    ui.notifications?.info(`${merchant.name} restocked.`);
    this.render(false);
  }

  static async _onPreviewSession() {
    if (!this._selectedId) return;
    const merchant = findMerchant(this._selectedId);
    if (!merchant) return;
    const choice = await promptPreviewActor();
    if (!choice) return; // cancelled
    MerchantSessionApp.open({
      sessionId: `preview-${merchant.id}`,
      merchant,
      previewMode: true,
      previewActor: choice.actor,
    });
    playModuleSound(SOUND_EVENTS.MERCHANT_SESSION_OPEN);
    ui.notifications?.info(
      `${MODULE_ID}: opened a preview of ${merchant.name} — nothing real changes.`,
    );
  }

  static async _onOpenSession() {
    if (!this._selectedId) return;
    const merchant = findMerchant(this._selectedId);
    if (!merchant) return;
    if (!merchant.allowedUserIds.length) {
      ui.notifications?.warn(
        "Tag at least one Allowed Player before opening a session.",
      );
      return;
    }
    if (!globalThis.game?.users?.activeGM) {
      ui.notifications?.warn("An active GM must be online to host a session.");
      return;
    }
    // Single allowed player: skip the redundant re-pick (mirrors the skill
    // picker's single-option short-circuit).
    const picked =
      merchant.allowedUserIds.length === 1
        ? [merchant.allowedUserIds[0]]
        : await promptPlayerPicker(merchant);
    if (!picked || picked.length === 0) return;
    // Report what ACTUALLY happened, not just that we tried. pushOpenSession
    // silently skips users it can't open for (not on the allow-list, or a
    // GM/assistant — who use Preview, not a live session), so a blanket
    // "opened for N" toast would claim success when the player sees nothing.
    const opened = pushOpenSession({ merchant, targetUserIds: picked });
    playModuleSound(SOUND_EVENTS.MERCHANT_SESSION_OPEN);
    if (opened.length === 0) {
      ui.notifications?.warn(
        `${MODULE_ID}: couldn't open ${merchant.name} for anyone — the picked player(s) aren't on the allow-list, or are a GM/assistant (use Preview for those).`,
      );
      this.render(false);
      return;
    }
    const users = globalThis.game?.users;
    const names = opened.map((d) => lookupUserName(d.viewerUserId));
    ui.notifications?.info(
      `${MODULE_ID}: opened ${merchant.name} for ${names.join(", ")}.`,
    );
    // A session pushed to an offline player won't pop until they reconnect —
    // call that out so it doesn't read as "pushed but broken".
    const offline = opened
      .filter((d) => users?.get?.(d.viewerUserId)?.active !== true)
      .map((d) => lookupUserName(d.viewerUserId));
    if (offline.length > 0) {
      ui.notifications?.warn(
        `${MODULE_ID}: ${offline.join(", ")} ${offline.length === 1 ? "is" : "are"} offline — the shop opens for them when they reconnect.`,
      );
    }
    if (opened.length < picked.length) {
      ui.notifications?.warn(
        `${MODULE_ID}: skipped ${picked.length - opened.length} picked player(s) — not on the allow-list or a GM/assistant.`,
      );
    }
    this.render(false);
  }

  static _onCloseSession(_event, target) {
    const sessionId = target?.dataset?.sessionId;
    if (!sessionId) return;
    pushCloseSession(sessionId);
    playModuleSound(SOUND_EVENTS.LOCK_TOGGLE);
    this.render(false);
  }

  static async _onInvRemove(_event, target) {
    if (!this._selectedId) return;
    const uuid = target?.dataset?.uuid;
    if (!uuid) return;
    await commitMerchantWrite(
      this._selectedId,
      (fresh) => removeInventoryRow(fresh, uuid),
      { broadcast: true },
    );
    playModuleSound(SOUND_EVENTS.ROSTER_REMOVE);
    this.render(false);
  }

  async _mutateInventoryRow(uuid, mutator) {
    if (!uuid || !this._selectedId) return;
    await commitMerchantWrite(
      this._selectedId,
      (fresh) => {
        const idx = fresh.items.findIndex((r) => r.uuid === uuid);
        if (idx < 0) return null;
        const updated = normalizeInventoryRow(mutator(fresh.items[idx]));
        if (!updated) return null;
        return upsertInventoryRow(fresh, updated);
      },
      { broadcast: true },
    );
  }
}

/* ------------------------------------------------------------------ *
 * Helpers
 * ------------------------------------------------------------------ */

function listActivePlayerUsers() {
  const users = globalThis.game?.users;
  if (!users) return [];
  // Exclude only FULL Game Masters (role 4), not every isGM user: an Assistant
  // GM (role 3) is a common co-DM/helper who plays a PC, and the session push
  // layer already supports them — so they must be tickable on a merchant's
  // allow-list (the old `!u.isGM` dropped them, leaving that path dead).
  const GM_ROLE = globalThis.CONST?.USER_ROLES?.GAMEMASTER ?? 4;
  return users
    .filter((u) => Number(u.role) < GM_ROLE)
    .sort((a, b) => String(a.name).localeCompare(String(b.name)));
}

function lookupUserName(userId) {
  return (
    globalThis.game?.users?.get?.(userId)?.name ?? userId ?? "Unknown User"
  );
}

function readFormFields(form) {
  const formData = new FormData(form);
  const out = {};
  for (const [key, value] of formData.entries()) {
    if (key in out) {
      const prev = out[key];
      out[key] = Array.isArray(prev) ? [...prev, value] : [prev, value];
    } else {
      out[key] = value;
    }
  }
  // Normalize fields we expect as arrays even when only one selected.
  for (const arrayKey of [
    "allowedSkills",
    "allowedUserIds",
    "poolLootTypes",
    "poolRarities",
    "buyFilterLootTypes",
    "buyFilterRarities",
  ]) {
    if (!(arrayKey in out)) out[arrayKey] = [];
    else if (!Array.isArray(out[arrayKey])) out[arrayKey] = [out[arrayKey]];
  }
  out.poolRarityBalance = normalizeRarityBalanceKey(out.poolRarityBalance);
  out.poolRarityWeights = resolveRarityWeights(
    out.poolRarityBalance,
    readPrefixedFields(out, "poolRarityWeight."),
  );
  return out;
}

function readPrefixedFields(source, prefix) {
  const out = {};
  for (const [key, value] of Object.entries(source)) {
    if (!key.startsWith(prefix)) continue;
    out[key.slice(prefix.length)] = value;
  }
  return out;
}

function applyRarityBalancePresetToForm(form, balanceKey) {
  const normalized = normalizeRarityBalanceKey(balanceKey);
  if (normalized === RARITY_BALANCE_CUSTOM_KEY) return;
  const weights = getRarityBalancePresetWeights(normalized);
  for (const [rarity, weight] of Object.entries(weights)) {
    const input = form.querySelector(
      `input[name="poolRarityWeight.${rarity}"]`,
    );
    if (input) input.value = formatMultiplier(weight);
  }
}

function extractDroppedItemUuid(event) {
  const payload =
    event.dataTransfer?.getData?.("text/plain") ||
    event.dataTransfer?.getData?.("application/json");
  if (!payload) return null;
  try {
    const parsed = JSON.parse(payload);
    if (parsed?.type !== "Item") return null;
    return parsed?.uuid ?? null;
  } catch {
    return null;
  }
}

/**
 * Pick which character the GM "shops as" in a preview. Returns
 * `{ actor }` (actor may be null = browse-only) on confirm, or `null` when
 * the GM dismisses the dialog. Falls back to the GM's assigned character when
 * no picker is available.
 */
async function promptPreviewActor() {
  const DialogV2 = foundry?.applications?.api?.DialogV2;
  const characters = (
    globalThis.game?.actors?.filter?.((a) => a?.type === "character") ?? []
  ).sort((a, b) => String(a.name).localeCompare(String(b.name)));
  if (!DialogV2 || characters.length === 0) {
    return { actor: globalThis.game?.user?.character ?? null };
  }
  // Default to the GM's assigned character, else the first one, so the Sell
  // tab is populated by default — "None" stays available but isn't the default.
  const assignedId = globalThis.game?.user?.character?.id ?? "";
  const defaultId = assignedId || characters[0]?.id || "";
  const options = [
    `<option value="">None — just browse the window</option>`,
    ...characters.map(
      (a) =>
        `<option value="${escapeHtml(a.id)}" ${a.id === defaultId ? "selected" : ""}>${escapeHtml(a.name)}</option>`,
    ),
  ].join("");
  let picked;
  try {
    picked = await DialogV2.prompt({
      window: { title: "Preview Shop — shop as…", icon: "fa-solid fa-eye" },
      content: `
        <div class="mw-pick">
          <p>Open a sandbox shop window. Buying, selling, and bargaining are simulated and logged — no real items or coin change hands. Pick a character to try selling + bargaining, or just browse.</p>
          <label style="display:grid;gap:4px;">
            <span>Shop as</span>
            <select name="actorId">${options}</select>
          </label>
        </div>
      `,
      ok: {
        label: "Open Preview",
        icon: "fa-solid fa-eye",
        callback: (_event, button) =>
          button?.form?.elements?.actorId?.value ?? "",
      },
      rejectClose: false,
    });
  } catch {
    return null;
  }
  if (picked === null || picked === undefined) return null; // dismissed
  if (picked === "") return { actor: null }; // browse-only
  return { actor: globalThis.game?.actors?.get?.(picked) ?? null };
}

async function promptPlayerPicker(merchant) {
  const DialogV2 = foundry?.applications?.api?.DialogV2;
  if (!DialogV2) return null;
  const options = merchant.allowedUserIds
    .map((id) => {
      const name = lookupUserName(id);
      return `<label class="mw-pick__opt"><input type="checkbox" name="userIds" value="${escapeHtml(id)}" checked /> ${escapeHtml(name)}</label>`;
    })
    .join("");
  let picked = [];
  try {
    picked = await DialogV2.prompt({
      window: {
        title: `Open Session — ${merchant.name}`,
        icon: "fa-solid fa-store",
      },
      content: `
        <div class="mw-pick" style="display:grid;gap:8px;">
          <p>Pick which players see the session window:</p>
          ${options}
        </div>
      `,
      ok: {
        label: "Open",
        icon: "fa-solid fa-store",
        callback: (_event, button) => {
          const form = button?.form;
          if (!form) return [];
          return Array.from(
            form.querySelectorAll('input[name="userIds"]:checked'),
          ).map((el) => el.value);
        },
      },
      rejectClose: false,
    });
  } catch {
    picked = [];
  }
  return picked;
}

