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
  findMerchant,
  loadMerchants,
  normalizeInventoryRow,
  normalizeMerchant,
  removeInventoryRow,
  resolveStockQty,
  restockAll,
  upsertInventoryRow,
  upsertMerchant,
} from "./merchant/store.js";
import { rollMerchantStock } from "./merchant/pool.js";
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
import { formatMultiplier, prettyLootType, prettyRarity } from "./ui-util.js";
import {
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
      addFromPack: MerchantWorkspaceApp._onAddFromPack,
      generateStock: MerchantWorkspaceApp._onGenerateStock,
      regenerateStock: MerchantWorkspaceApp._onRegenerateStock,
      clearInventory: MerchantWorkspaceApp._onClearInventory,
      restock: MerchantWorkspaceApp._onRestock,
      pickArt: MerchantWorkspaceApp._onPickArt,
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
      ui.notifications?.warn(`${MODULE_ID}: Merchant Workspace is GM-only.`);
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
    this._stateUnsub = subscribe(MERCHANT_EVENTS.STATE_UPDATE, () =>
      this.render(false),
    );
  }

  _onClose(options) {
    super._onClose?.(options);
    try {
      this._stateUnsub?.();
    } catch {}
    MerchantWorkspaceApp._instance = null;
  }

  /* -------------------- context -------------------- */

  async _prepareContext() {
    const merchants = loadMerchants();
    if (!this._selectedId && merchants.length > 0) {
      this._selectedId = merchants[0].id;
    }
    const selected = this._selectedId
      ? (merchants.find((m) => m.id === this._selectedId) ?? null)
      : null;

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

    const pool = selected?.pool ?? {
      lootTypes: [],
      rarities: [],
      count: 6,
      rarityBalance: RARITY_BALANCE_DEFAULT_KEY,
      rarityWeights: getRarityBalancePresetWeights(RARITY_BALANCE_DEFAULT_KEY),
    };
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
      skillOptions,
      poolLootTypeOptions,
      poolRarityOptions,
      poolRarityBalanceOptions: rarityBalanceOptions(poolRarityBalance),
      poolRarityWeightRows: rarityWeightRows(poolRarityWeights),
      poolCount: pool.count,
      inventoryRows,
      activeSessions,
      canOpenSession:
        Boolean(selected) &&
        selected.allowedUserIds.length > 0 &&
        Boolean(globalThis.game?.users?.activeGM),
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
      ui.notifications?.info(`${MODULE_ID}: already in inventory.`);
      return;
    }
    // Ammunition always stocks as a full stack of 20; everything else as 1.
    const item = await this._resolveItem(uuid);
    const qty = resolveStockQty(item, 1);
    const next = upsertInventoryRow(
      merchant,
      createInventoryRow(uuid, { qty, startingQty: qty }),
    );
    await upsertMerchant(next);
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
    const next = normalizeMerchant({
      ...merchant,
      name: data.name ?? merchant.name,
      art: data.art ?? merchant.art,
      description: data.description ?? merchant.description,
      defaultMarkup: Number(data.defaultMarkup ?? merchant.defaultMarkup),
      sellRatio: Number(data.sellRatio ?? merchant.sellRatio),
      bargainDC: Number(data.bargainDC ?? merchant.bargainDC),
      bargainAdvantage: data.bargainAdvantage === "on",
      bargainSuccessPct: Number(
        data.bargainSuccessPct ?? merchant.bargainSuccessPct,
      ),
      bargainFailPct: Number(data.bargainFailPct ?? merchant.bargainFailPct),
      goldOnHand: data.goldOnHand,
      allowedSkills: data.allowedSkills,
      allowedUserIds: data.allowedUserIds,
      pool: {
        lootTypes: data.poolLootTypes,
        rarities: data.poolRarities,
        count: Number(data.poolCount ?? merchant.pool?.count ?? 6),
        rarityBalance: data.poolRarityBalance,
        rarityWeights: data.poolRarityWeights,
      },
    });
    await upsertMerchant(next);
  }

  /* -------------------- actions -------------------- */

  static async _onNewMerchant() {
    const blank = createBlankMerchant({ name: "New Merchant" });
    await upsertMerchant(blank);
    this._selectedId = blank.id;
    playModuleSound(SOUND_EVENTS.PRESET_APPLY);
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
      ui.notifications?.info(`${MODULE_ID}: merchant saved.`);
    } catch (error) {
      console.error(`${MODULE_ID} | save failed`, error);
      ui.notifications?.error(`${MODULE_ID}: save failed. See console.`);
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
      content: `<p>This will remove <strong>${escapeText(merchant.name)}</strong> and close any open sessions for them. Item compendium entries are untouched.</p>`,
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
      ui.notifications?.warn(`${MODULE_ID}: no items in compendium.`);
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
      ui.notifications?.info(`${MODULE_ID}: every pack item already stocked.`);
      return;
    }

    const options = candidates
      .slice(0, 300)
      .map(
        (item) =>
          `<option value="${escapeAttr(item.uuid)}">${escapeText(item.name)}</option>`,
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
      ui.notifications?.warn(`${MODULE_ID}: no items in compendium.`);
      return;
    }
    if (replace) merchant = clearInventory(merchant);
    const exclude = new Set(merchant.items.map((r) => r.uuid));
    const { rows, warnings } = rollMerchantStock(pool, items, { exclude });
    if (rows.length === 0) {
      ui.notifications?.warn(
        `${MODULE_ID}: ${warnings[0] ?? "nothing generated."}`,
      );
      return;
    }
    let next = merchant;
    for (const row of rows) next = upsertInventoryRow(next, row);
    await upsertMerchant(next);
    playModuleSound(SOUND_EVENTS.ROLL_START);
    ui.notifications?.info(
      `${MODULE_ID}: ${replace ? "re-stocked" : "generated"} ${rows.length} item(s) for ${next.name}.`,
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
          content: `<p>Remove all <strong>${merchant.items.length}</strong> item(s) from <strong>${escapeText(merchant.name)}</strong>? Compendium entries are untouched.</p>`,
          rejectClose: false,
        })
      : true;
    if (!confirmed) return;
    await upsertMerchant(clearInventory(merchant));
    playModuleSound(SOUND_EVENTS.CLEAR_RESET);
    this.render(false);
  }

  static async _onPickArt() {
    const input = this.element?.querySelector?.('input[name="art"]');
    const FP =
      foundry?.applications?.apps?.FilePicker?.implementation ??
      globalThis.FilePicker;
    if (!FP) {
      ui.notifications?.warn(`${MODULE_ID}: file picker unavailable.`);
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
    const next = restockAll(merchant);
    await upsertMerchant(next);
    playModuleSound(SOUND_EVENTS.ROLL_START);
    ui.notifications?.info(`${MODULE_ID}: ${merchant.name} restocked.`);
    this.render(false);
  }

  static async _onOpenSession() {
    if (!this._selectedId) return;
    const merchant = findMerchant(this._selectedId);
    if (!merchant) return;
    if (!merchant.allowedUserIds.length) {
      ui.notifications?.warn(`${MODULE_ID}: tag at least one allowed player.`);
      return;
    }
    if (!globalThis.game?.users?.activeGM) {
      ui.notifications?.warn(`${MODULE_ID}: needs an active GM to host.`);
      return;
    }
    const picked = await promptPlayerPicker(merchant);
    if (!picked || picked.length === 0) return;
    pushOpenSession({ merchant, targetUserIds: picked });
    playModuleSound(SOUND_EVENTS.MERCHANT_SESSION_OPEN);
    ui.notifications?.info(
      `${MODULE_ID}: opened ${merchant.name} for ${picked.length} player(s).`,
    );
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
    const merchant = findMerchant(this._selectedId);
    if (!merchant) return;
    const next = removeInventoryRow(merchant, uuid);
    await upsertMerchant(next);
    playModuleSound(SOUND_EVENTS.ROSTER_REMOVE);
    this.render(false);
  }

  async _mutateInventoryRow(uuid, mutator) {
    if (!uuid || !this._selectedId) return;
    const merchant = findMerchant(this._selectedId);
    if (!merchant) return;
    const idx = merchant.items.findIndex((r) => r.uuid === uuid);
    if (idx < 0) return;
    const updated = normalizeInventoryRow(mutator(merchant.items[idx]));
    if (!updated) return;
    const next = upsertInventoryRow(merchant, updated);
    await upsertMerchant(next);
  }
}

/* ------------------------------------------------------------------ *
 * Helpers
 * ------------------------------------------------------------------ */

function listActivePlayerUsers() {
  const users = globalThis.game?.users;
  if (!users) return [];
  return users
    .filter((u) => !u.isGM)
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

async function promptPlayerPicker(merchant) {
  const DialogV2 = foundry?.applications?.api?.DialogV2;
  if (!DialogV2) return null;
  const options = merchant.allowedUserIds
    .map((id) => {
      const name = lookupUserName(id);
      return `<label class="mw-pick__opt"><input type="checkbox" name="userIds" value="${escapeAttr(id)}" checked /> ${escapeText(name)}</label>`;
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

function escapeText(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function escapeAttr(value) {
  return escapeText(value).replace(/"/g, "&quot;");
}
