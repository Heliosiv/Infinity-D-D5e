/**
 * Infinity D&D5e — MerchantWorkspaceApp
 *
 * GM-only singleton window for curating merchant records and pushing
 * sessions to players. Merchant data lives in the MERCHANTS world
 * setting via `merchant/store.js`; this app is the editor on top.
 */

import {
  BARGAIN_SKILLS,
  allowedMerchantUserIds,
  clearInventory,
  computeBuyPriceGp,
  createInventoryRow,
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
  resetMerchantPurse,
  shopSetup,
  SELF_SERVICE_MODES,
  upsertInventoryRow,
  upsertMerchant,
} from "./merchant/store.js";
import { rollMerchantStock } from "./merchant/pool.js";
import { MerchantSessionApp } from "./merchant-session.js";
import { MerchantPricingApp } from "./merchant/pricing-app.js";
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
  deliverDurableMerchantTerminalResult,
  MERCHANT_EVENTS,
  pushCloseAllSessionsFor,
  pushCloseSession,
  pushOpenSession,
  pushMerchantAccessRefresh,
  runMerchantAccessOperation,
  subscribe,
} from "./merchant/socket.js";
import {
  listDurableMerchantTransactionsNeedingReview,
  recheckDurableMerchantTransaction,
} from "./merchant/transaction-coordinator.js";
import { listSessions } from "./merchant/session-state.js";
import { readMerchantActorBoundary } from "./merchant/transaction.js";
import { loadMerchantAccessState } from "./merchant/global-access.js";
import {
  SHOP_TEMPLATES,
  LOCATION_TEMPLATES,
  locationDirectory,
  createShopLocation,
  addShopToLocation,
  applyLocationOperation,
} from "./merchant/locations.js";
import {
  assertShopLocation,
  deleteDirectoryShops,
  filterDirectoryShops,
  moveDirectoryShops,
  nameUnassignedShopLocation,
  removeShopLocation,
  renameShopLocation,
} from "./merchant/directory.js";
import { loadCompendiumItems } from "./loot/pack.js";
import {
  bindRowDoubleClickOpen,
  openItemByUuid,
  resolveItemSnapshot,
  wireBackgroundImageFallback,
} from "./loot/loot-app-shared.js";
import { SOUND_EVENTS, playModuleSound } from "./audio.js";
import { pickSearchOption } from "./search-picker.js";
import { confirmInfinityDialog } from "./dialog-contract.js";
import {
  applyVisualPrefs,
  bindFullGmWindowGuard,
  bindFocusRestoration,
  openSingleton,
} from "./infinity-app.js";
import {
  GM_WORKBENCH_TEMPLATE_PATH,
  GmWorkbenchApp,
  canContinueWorkbenchAction,
} from "./gm-workbench.js";
import { runAsFullGM } from "./permissions.js";
import { isAuthoritativeGM } from "./socket-authority.js";
import {
  ensureMerchantTabLeadership,
  hasMerchantTabLeadership,
  MERCHANT_TAB_LEADERSHIP_HOOK,
} from "./merchant/tab-leadership.js";
import {
  PRIVATE_STATE_CHANGED_HOOK,
  onPrivateStateChanged,
} from "./private-state.js";
import {
  merchantTabContext,
  selectMerchantTab,
  bindMerchantTabKeys,
} from "./merchant/editor-tabs.js";

const MODULE_ID = "infinity-dnd5e";
const TEMPLATE_PATH = `modules/${MODULE_ID}/templates/merchant-workspace.hbs`;
const FALLBACK_ART = "icons/svg/chest.svg";
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
  { key: "edit", selector: ".mw-tab-content" },
];
const MERCHANT_WRITE_ACTIONS = new Set([
  "createLocation",
  "addLocationShop",
  "locationOperation",
  "assignLocation",
  "moveSelectedShops",
  "deleteSelectedShops",
  "renameLocation",
  "removeLocation",
  "save",
  "deleteMerchant",
  "duplicateMerchant",
  "addFromPack",
  "marketTier",
  "generateStock",
  "regenerateStock",
  "copyStockToBuyFilter",
  "clearInventory",
  "restock",
  "pickArt",
  "openSession",
  "closeSession",
  "invRemove",
  "recheckTransaction",
]);

function requireMerchantWriteAuthority(action) {
  return function (...args) {
    if (!isAuthoritativeGM() || !hasMerchantTabLeadership()) {
      globalThis.ui?.notifications?.warn?.(
        "This Merchant workspace is read-only here. Use the active full GM window to make changes.",
      );
      if (this?.rendered) this.render(false);
      return null;
    }
    return action.apply(this, args);
  };
}

async function confirmMerchantWriteAuthority(app) {
  if (
    !isAuthoritativeGM() ||
    (await ensureMerchantTabLeadership()) !== true ||
    !hasMerchantTabLeadership()
  ) {
    globalThis.ui?.notifications?.warn?.(
      "Merchant control moved to another GM window while this prompt was open. Nothing changed here.",
    );
    if (app?.rendered) app.render(false);
    return false;
  }
  return true;
}

function isCurrentMerchantAction(app, merchantId) {
  if (
    app._selectedId === merchantId &&
    canContinueWorkbenchAction(app) &&
    findMerchant(merchantId)
  )
    return true;
  globalThis.ui?.notifications?.warn?.(
    "The selected merchant changed or closed. Nothing changed; start the action again for the current merchant.",
  );
  return false;
}

async function saveBeforeMerchantAction(app, merchantId) {
  try {
    await app._saveFromForm();
  } catch (error) {
    console.warn(
      `${MODULE_ID} | merchant action stopped after save failure`,
      error,
    );
    notify(
      "error",
      "Merchant changes could not be saved. Your edits are still here; use Save now, then retry the action.",
    );
    return false;
  }
  return isCurrentMerchantAction(app, merchantId);
}

export class MerchantWorkspaceApp extends GmWorkbenchApp {
  static _instance = null;
  static _editors = new Map();
  static WORKBENCH_ROUTE = "merchants";

  static DEFAULT_OPTIONS = {
    id: "infinity-dnd5e-merchant-workspace",
    tag: "section",
    classes: ["infinity-dnd5e", "infinity-merchant-workspace"],
    window: {
      title: "Infinity D&D5e — Shops",
      icon: "fa-solid fa-store",
      resizable: true,
    },
    position: { width: 720, height: 600 },
    actions: {
      selectLocation: MerchantWorkspaceApp._onSelectLocation,
      createLocation: requireMerchantWriteAuthority(
        MerchantWorkspaceApp._onCreateLocation,
      ),
      addLocationShop: requireMerchantWriteAuthority(
        MerchantWorkspaceApp._onAddLocationShop,
      ),
      locationOperation: requireMerchantWriteAuthority(
        MerchantWorkspaceApp._onLocationOperation,
      ),
      assignLocation: requireMerchantWriteAuthority(
        MerchantWorkspaceApp._onAssignLocation,
      ),
      moveSelectedShops: requireMerchantWriteAuthority(
        MerchantWorkspaceApp._onMoveSelectedShops,
      ),
      deleteSelectedShops: requireMerchantWriteAuthority(
        MerchantWorkspaceApp._onDeleteSelectedShops,
      ),
      renameLocation: requireMerchantWriteAuthority(
        MerchantWorkspaceApp._onRenameLocation,
      ),
      removeLocation: requireMerchantWriteAuthority(
        MerchantWorkspaceApp._onRemoveLocation,
      ),
      openPricingMacros: MerchantWorkspaceApp._onOpenPricingMacros,
      selectMerchant: MerchantWorkspaceApp._onSelectMerchant,
      save: requireMerchantWriteAuthority(MerchantWorkspaceApp._onSave),
      deleteMerchant: requireMerchantWriteAuthority(
        MerchantWorkspaceApp._onDeleteMerchant,
      ),
      duplicateMerchant: requireMerchantWriteAuthority(
        MerchantWorkspaceApp._onDuplicateMerchant,
      ),
      addFromPack: requireMerchantWriteAuthority(
        MerchantWorkspaceApp._onAddFromPack,
      ),
      marketTier: requireMerchantWriteAuthority(
        MerchantWorkspaceApp._onMarketTier,
      ),
      generateStock: requireMerchantWriteAuthority(
        MerchantWorkspaceApp._onGenerateStock,
      ),
      regenerateStock: requireMerchantWriteAuthority(
        MerchantWorkspaceApp._onRegenerateStock,
      ),
      copyStockToBuyFilter: requireMerchantWriteAuthority(
        MerchantWorkspaceApp._onCopyStockToBuyFilter,
      ),
      clearInventory: requireMerchantWriteAuthority(
        MerchantWorkspaceApp._onClearInventory,
      ),
      restock: requireMerchantWriteAuthority(MerchantWorkspaceApp._onRestock),
      pickArt: requireMerchantWriteAuthority(MerchantWorkspaceApp._onPickArt),
      previewSession: MerchantWorkspaceApp._onPreviewSession,
      openSession: requireMerchantWriteAuthority(
        MerchantWorkspaceApp._onOpenSession,
      ),
      closeSession: requireMerchantWriteAuthority(
        MerchantWorkspaceApp._onCloseSession,
      ),
      invRemove: requireMerchantWriteAuthority(
        MerchantWorkspaceApp._onInvRemove,
      ),
      openInventoryItem: MerchantWorkspaceApp._onOpenInventoryItem,
      recheckTransaction: requireMerchantWriteAuthority(
        MerchantWorkspaceApp._onRecheckTransaction,
      ),
      selectSection: MerchantWorkspaceApp._onSelectSection,
      navigateGmWorkbench: GmWorkbenchApp._onNavigate,
      openGmWorkbenchUtility: GmWorkbenchApp._onOpenUtility,
    },
  };

  static PARTS = {
    workbench: { template: GM_WORKBENCH_TEMPLATE_PATH },
    body: { template: TEMPLATE_PATH },
  };

  _configureRenderParts(options) {
    const parts = { ...super._configureRenderParts(options) };
    // Foundry requires a root element for each rendered part. Omit the chrome
    // part entirely in an editor instead of rendering an empty template.
    if (this._isMerchantEditor) delete parts.workbench;
    return parts;
  }

  static open(options = {}) {
    return runAsFullGM(() => {
      playModuleSound(SOUND_EVENTS.UI_OPEN);
      const app = openSingleton(
        MerchantWorkspaceApp,
        () => new MerchantWorkspaceApp(options),
      );
      if (options.workbench) app.setWorkbenchTarget(options.workbench);
      return app;
    }, "Merchant Workspace is available to full GMs only.");
  }

  static openMerchant(merchantId) {
    return runAsFullGM(() => {
      const merchant = findMerchant(merchantId);
      if (!merchant) return null;
      let app = MerchantWorkspaceApp._editors.get(merchantId);
      if (!app) {
        app = new MerchantWorkspaceApp({
          merchantId,
          workbench: false,
          id: `infinity-merchant-${merchantId}`,
          window: { title: merchant.name },
          position: {
            width: Math.min(820, (globalThis.innerWidth || 1024) - 40),
            height: Math.min(640, (globalThis.innerHeight || 768) - 60),
          },
        });
        MerchantWorkspaceApp._editors.set(merchantId, app);
        bindFocusRestoration(app);
      }
      if (app.rendered) app.bringToFront?.();
      else app.render(true);
      return app;
    }, "Merchant editing is available to full GMs only.");
  }

  constructor(options = {}) {
    super(options);
    this._unbindFullGmWindowGuard = bindFullGmWindowGuard(this);
    this._isMerchantEditor = Boolean(options.merchantId);
    this._selectedId =
      options.merchantId ||
      String(options.workbench?.entityId ?? "").trim() ||
      null;
    this._activeMerchantTab = "basics";
    this._merchantSearch = "";
    this._merchantFilter = "all";
    this._merchantSort = "name";
    this._selectedShopIds = new Set();
    this._locationSearch = "";
    this._selectedLocationId = null;
    this._locationBusy = false;
    this._saveStatus = "All changes saved";
    this._formSaveDepth = 0;
    this._reviewIdentities = new Map();
    this._itemCache = new Map(); // uuid → resolved item snapshot
    // Re-render on stock changes AND on session open/close so the "Active
    // Sessions" list stays accurate even when a player closes their own window.
    this._unsubs = [
      subscribe(MERCHANT_EVENTS.STATE_UPDATE, (payload) => {
        // The current form already contains the values it just saved. Replacing
        // that same DOM would collapse open disclosures, drop focus, and move
        // the GM away from the field after every number/checkbox change.
        if (
          this._formSaveDepth > 0 &&
          payload?.merchantId === this._selectedId
        ) {
          return;
        }
        this.render(false);
      }),
      subscribe(MERCHANT_EVENTS.SESSION_OPEN, () => this.render(false)),
      subscribe(MERCHANT_EVENTS.SESSION_CLOSE, () => this.render(false)),
    ];
    this._privateStateHookId = onPrivateStateChanged((payload) => {
      if (
        !payload?.keys?.includes?.("merchants") &&
        !payload?.keys?.includes?.("merchantAccess") &&
        !payload?.keys?.includes?.("merchantTransactions")
      ) {
        return;
      }
      if (this._formSaveDepth > 0 && payload?.reason === "local-write") return;
      if (this.rendered) this.render(false);
    });
    this._tabLeadershipHookId = globalThis.Hooks?.on?.(
      MERCHANT_TAB_LEADERSHIP_HOOK,
      () => {
        if (this.rendered) this.render(false);
      },
    );
  }

  _captureWorkbenchTarget() {
    // A selected row is only a directory highlight. Remembering it as an
    // entity target would reopen that merchant whenever Shops is revisited.
    return {
      route: MerchantWorkspaceApp.WORKBENCH_ROUTE,
    };
  }

  _applyWorkbenchTarget(target) {
    if (target?.entityId) {
      this._selectedId = target.entityId;
      MerchantWorkspaceApp.openMerchant(target.entityId);
    }
  }

  async _beforeWorkbenchNavigate() {
    if (!this._selectedId || !this.rendered) return true;
    // Browsing a follower window must not enter the campaign write path.
    // Its form is disabled, so there are no editable fields to flush.
    if (!isAuthoritativeGM() || !hasMerchantTabLeadership()) return true;
    await this._saveFromForm();
    return true;
  }

  _onClose(options) {
    super._onClose?.(options);
    this._unbindFullGmWindowGuard?.();
    this._unbindFullGmWindowGuard = null;
    for (const fn of this._unsubs ?? []) {
      try {
        fn();
      } catch {}
    }
    this._unsubs = [];
    if (this._privateStateHookId != null) {
      globalThis.Hooks?.off?.(
        PRIVATE_STATE_CHANGED_HOOK,
        this._privateStateHookId,
      );
      this._privateStateHookId = null;
    }
    if (this._tabLeadershipHookId != null) {
      globalThis.Hooks?.off?.(
        MERCHANT_TAB_LEADERSHIP_HOOK,
        this._tabLeadershipHookId,
      );
      this._tabLeadershipHookId = null;
    }
    if (this._isMerchantEditor) {
      if (MerchantWorkspaceApp._editors.get(this._selectedId) === this) {
        MerchantWorkspaceApp._editors.delete(this._selectedId);
      }
    } else if (MerchantWorkspaceApp._instance === this) {
      MerchantWorkspaceApp._instance = null;
    }
  }

  /* -------------------- context -------------------- */

  async _prepareContext() {
    await ensureMerchantTabLeadership();
    const merchants = loadMerchants();
    const merchantAccess = loadMerchantAccessState();
    const locations = locationDirectory(merchants, merchantAccess).sort(
      (a, b) =>
        !a.id
          ? -1
          : !b.id
            ? 1
            : a.name.localeCompare(b.name, undefined, {
                numeric: true,
                sensitivity: "base",
              }),
    );
    if (
      !locations.some((location) => location.id === this._selectedLocationId)
    ) {
      this._selectedLocationId = locations[0]?.id ?? null;
    }
    const selectedLocation =
      locations.find((location) => location.id === this._selectedLocationId) ??
      null;
    const allActiveSessions = listSessions();
    // A focused editor stays bound to its merchant even after external deletion.
    // Never redirect its controls to another merchant during a refresh.
    let selected = this._selectedId
      ? (merchants.find((m) => m.id === this._selectedId) ?? null)
      : null;
    if (!selected && merchants.length > 0 && !this._isMerchantEditor) {
      selected = merchants[0];
      this._selectedId = selected.id;
    } else if (!selected && !this._isMerchantEditor) {
      this._selectedId = null;
    }

    await this._refreshItemCache(
      this._isMerchantEditor && selected ? [selected] : [],
    );

    const merchantList = merchants.map((m) => ({
      id: m.id,
      name: m.name,
      art: m.art || FALLBACK_ART,
      itemCount: m.items.length,
      itemCountIsOne: m.items.length === 1,
      allowedCount: m.allowedUserIds.length,
      allowedCountIsOne: m.allowedUserIds.length === 1,
      locationId: m.shop?.locationId ?? "",
      accessLabel:
        m.shop?.access === "all"
          ? "All players"
          : `${m.allowedUserIds.length} allowed players`,
      status:
        !merchantAccess.closed &&
        shopSetup(m).open &&
        m.selfServiceMode !== "off"
          ? "Open"
          : "Closed",
      purseLabel:
        m.goldOnHand == null ? "Unlimited gold" : `${m.goldOnHand} gp`,
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
      ? allActiveSessions
          .filter((s) => s.merchantId === selected.id)
          .map((s) => ({
            sessionId: s.sessionId,
            userLabel: lookupUserName(s.viewerUserId),
          }))
      : [];

    const canManageMerchants =
      isAuthoritativeGM() && hasMerchantTabLeadership();
    this._reviewIdentities.clear();
    const transactionReviews =
      listDurableMerchantTransactionsNeedingReview().map((record, index) => {
        const actionId = `review-${index}`;
        this._reviewIdentities.set(actionId, {
          originUserId: record.originUserId,
          commitId: record.commitId,
          requestFingerprint: record.requestFingerprint,
        });
        const actor = globalThis.game?.actors?.get?.(record.actor.actorId);
        const currentMerchant = findMerchant(record.merchant.merchantId);
        const actorRead = readMerchantActorBoundary(actor, record.actor.itemId);
        const merchantName =
          currentMerchant?.name ??
          record.merchant.before?.name ??
          record.merchant.merchantId;
        return {
          actionId,
          sideLabel: record.side === "sell" ? "Sale" : "Purchase",
          itemName: record.receipt.itemName,
          qty: record.receipt.qty,
          totalGp: Number(record.receipt.totalGp).toFixed(2),
          playerLabel: lookupUserName(record.originUserId),
          actorLabel: actor?.name ?? record.actor.actorId,
          merchantLabel: merchantName,
          reasonLabel: merchantReviewReasonLabel(record.review.reason),
          actorStateLabel: merchantReviewStateLabel(record.review.actorState),
          merchantStateLabel: merchantReviewStateLabel(
            record.review.merchantState,
          ),
          checkedAtLabel: formatReviewTimestamp(record.review.at),
          actorWalletPlanLabel: `${formatReviewWallet(record.actor.before.wallet)} → ${formatReviewWallet(record.actor.after.wallet)}`,
          actorItemPlanLabel: `${formatReviewItem(record.actor.before.item)} → ${formatReviewItem(record.actor.after.item)}`,
          actorCurrentLabel: actorRead?.ok
            ? `${formatReviewWallet(actorRead.boundary.wallet)}; ${formatReviewItem(actorRead.boundary.item)}`
            : "unavailable",
          merchantGoldPlanLabel: `${formatReviewGold(record.merchant.before)} → ${formatReviewGold(record.merchant.after)}`,
          merchantStockPlanLabel: `${formatReviewStock(record.merchant.before, record.request.itemUuid)} → ${formatReviewStock(record.merchant.after, record.request.itemUuid)}`,
          merchantCurrentLabel: currentMerchant
            ? `${formatReviewGold(currentMerchant)}; ${formatReviewStock(currentMerchant, record.request.itemUuid)}`
            : "unavailable",
          canRecheck: canManageMerchants,
        };
      });
    return {
      workbench: this._isMerchantEditor
        ? null
        : (this.prepareWorkbenchContext?.() ?? null),
      isMerchantEditor: this._isMerchantEditor,
      ...merchantTabContext(this._selectedId, this._activeMerchantTab),
      moduleId: MODULE_ID,
      hasMerchants: merchants.length > 0,
      merchants: merchantList,
      locations: locations.map((location) => ({
        ...location,
        selected: location.id === this._selectedLocationId,
      })),
      hasLocations: locations.length > 0,
      selectedLocation,
      locationMerchants: merchantList.filter(
        (merchant) => merchant.locationId === this._selectedLocationId,
      ),
      locationHasShops: Boolean(selectedLocation?.count),
      locationBusy: this._locationBusy,
      canEditLocation: Boolean(selectedLocation?.id),
      locationTemplates: LOCATION_TEMPLATES.map((row) => ({
        ...row,
        selected: row.id === (this._newLocationTemplate ?? "town"),
      })),
      newLocationName: this._newLocationName ?? "",
      shopTemplates: SHOP_TEMPLATES,
      locationOptions: [
        { id: "", name: "Unassigned shops" },
        ...locations.filter((location) => location.id),
      ].map((location) => ({
        ...location,
        selected: location.id === (selected?.shop?.locationId ?? ""),
      })),
      assignLocationOptions: [
        { id: "", name: "Unassigned shops" },
        ...locations.filter((row) => row.id),
      ].filter((location) => location.id !== this._selectedLocationId),
      selected: selected
        ? {
            ...selected,
            setup: shopSetup(selected),
            accessAll: selected.shop?.access === "all",
            currentGoldLabel:
              selected.goldOnHand == null
                ? "Unlimited"
                : `${selected.goldOnHand} gp`,
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
      transactionReviews,
      hasTransactionReviews: transactionReviews.length > 0,
      canManageMerchants,
      merchantAuthorityReason: canManageMerchants
        ? ""
        : isAuthoritativeGM()
          ? "This window is read-only because another tab for this GM account owns Merchant changes. You can browse and switch tools here; close the other tab to edit here."
          : "This window is read-only. Make Merchant changes from the active full GM window.",
      merchantAccessClosed: merchantAccess.closed,
      merchantAccessOpen: !merchantAccess.closed,
      merchantAccessStatusClass: merchantAccess.closed
        ? "is-closed"
        : "is-open",
      merchantAccessStatusIcon: merchantAccess.closed
        ? "fa-shop-lock"
        : "fa-door-open",
      merchantAccessStatusLabel: merchantAccess.closed
        ? "All shops closed"
        : "Global access open",
      globalActiveSessionCount: allActiveSessions.length,
      globalActiveSessionCountIsOne: allActiveSessions.length === 1,
      suspendedSessionCount: merchantAccess.suspendedSessions.length,
      suspendedSessionCountIsOne: merchantAccess.suspendedSessions.length === 1,
      merchantReopenInterrupted:
        !merchantAccess.closed && merchantAccess.suspendedSessions.length > 0,
      canOpenSession:
        Boolean(selected) &&
        !merchantAccess.closed &&
        shopSetup(selected).open &&
        allowedMerchantUserIds(selected).length > 0 &&
        Boolean(globalThis.game?.users?.activeGM) &&
        canManageMerchants,
      // Why the Open Session button is disabled, so the button can say so.
      openSessionReason: !selected
        ? "Select a merchant first."
        : merchantAccess.closed
          ? "Merchant access is globally closed. Reopen shops first."
          : !shopSetup(selected).open
            ? "Open this shop in Access, or open its location."
            : allowedMerchantUserIds(selected).length === 0
              ? "Add at least one Allowed Player to open a session."
              : !globalThis.game?.users?.activeGM
                ? "An active GM must be online to host."
                : !canManageMerchants
                  ? "Only the active full GM can host a live session."
                  : "",
      saveStatus: canManageMerchants
        ? this._saveStatus
        : "Read-only — browsing available",
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
    const missing = [...allUuids].filter((uuid) => !this._itemCache.has(uuid));
    await Promise.all(
      missing.map(async (uuid) => {
        this._itemCache.set(uuid, await resolveItemSnapshot(uuid));
      }),
    );
  }

  _onRender(context, options) {
    super._onRender?.(context, options);

    // Honor the existing animation + rarity-glow client settings.
    applyVisualPrefs(this.element, "mw-");
    bindMerchantTabKeys(this.element, (key) => this._selectMerchantTab(key));
    this._wireMerchantSearch();
    this.element
      ?.querySelector?.("[data-location-form]")
      ?.addEventListener("submit", (event) => event.preventDefault());
    if (this._locationBusy)
      for (const control of this.element?.querySelectorAll?.(
        "[data-location-control]",
      ) ?? [])
        control.disabled = true;

    if (context?.canManageMerchants) {
      this._wireFormChange();
      this._wireInventoryInputs();
      this._wireDropZone();
    } else {
      for (const control of this.element?.querySelectorAll?.(
        '[data-form="merchant-edit"] input, [data-form="merchant-edit"] textarea, [data-form="merchant-edit"] select',
      ) ?? []) {
        control.disabled = true;
      }
      for (const control of this.element?.querySelectorAll?.("[data-action]") ??
        []) {
        if (MERCHANT_WRITE_ACTIONS.has(control.dataset?.action)) {
          control.disabled = true;
        }
      }
    }
    this._wireInventorySearch();

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
        notify(
          "error",
          "Merchant changes could not be saved. Retry with Save now.",
        );
      }
    });
  }

  _wireMerchantSearch() {
    const locationSearch = this.element?.querySelector?.(
      "[data-location-search]",
    );
    if (locationSearch) {
      locationSearch.value = this._locationSearch ?? "";
      const searchLocations = () => {
        this._locationSearch = locationSearch.value;
        const query = locationSearch.value.trim().toLocaleLowerCase();
        let count = 0;
        for (const row of this.element.querySelectorAll(".mw-location")) {
          row.hidden = !row
            .querySelector("strong")
            .textContent.toLocaleLowerCase()
            .includes(query);
          if (!row.hidden) count++;
        }
        this.element.querySelector("[data-location-no-match]").hidden =
          count > 0;
      };
      locationSearch.addEventListener("input", searchLocations);
      searchLocations();
    }
    const input = this.element?.querySelector?.("[data-merchant-search]");
    if (!input) return;
    this._selectedShopIds ??= new Set();
    input.value = this._merchantSearch ?? "";
    const filterInput = this.element.querySelector("[data-merchant-filter]");
    const sortInput = this.element.querySelector("[data-merchant-sort]");
    filterInput.value = this._merchantFilter ?? "all";
    sortInput.value = this._merchantSort ?? "name";
    const filter = (clearSelection = false) => {
      if (clearSelection) this._selectedShopIds.clear();
      this._merchantSearch = input.value;
      this._merchantFilter = filterInput.value;
      this._merchantSort = sortInput.value;
      const rows = [...this.element.querySelectorAll(".mw-list__row")];
      const visible = filterDirectoryShops(
        rows.map((row) => ({
          id: row.dataset.shopId,
          name: row.querySelector(".mw-list__name").textContent,
          status: row.dataset.shopStatus,
          itemCount: Number(row.dataset.itemCount),
        })),
        {
          query: this._merchantSearch,
          filter: this._merchantFilter,
          sort: this._merchantSort,
        },
      );
      const visibleIds = new Set(visible.map((row) => row.id));
      for (const id of this._selectedShopIds) {
        if (!visibleIds.has(id)) this._selectedShopIds.delete(id);
      }
      for (const row of rows) {
        row.hidden = !visibleIds.has(row.dataset.shopId);
        row.querySelector("[data-shop-select]").checked =
          this._selectedShopIds.has(row.dataset.shopId);
      }
      const list = this.element.querySelector(".mw-list__items");
      for (const row of visible) {
        list.append(rows.find((element) => element.dataset.shopId === row.id));
      }
      this.element.querySelector("[data-merchant-no-match]").hidden =
        visible.length > 0;
      this.element.querySelector("[data-merchant-result-count]").textContent =
        `${visible.length} of ${rows.length} shops shown`;
      this._updateShopSelection();
    };
    input.addEventListener("input", () => filter(true));
    filterInput.addEventListener("change", () => filter(true));
    sortInput.addEventListener("change", () => filter());
    for (const checkbox of this.element.querySelectorAll(
      "[data-shop-select]",
    )) {
      checkbox.addEventListener("change", () => {
        if (checkbox.checked)
          this._selectedShopIds.add(checkbox.dataset.shopSelect);
        else this._selectedShopIds.delete(checkbox.dataset.shopSelect);
        this._updateShopSelection();
      });
    }
    this.element
      .querySelector("[data-select-visible]")
      .addEventListener("change", (event) => {
        for (const row of this.element.querySelectorAll(
          ".mw-list__row:not([hidden])",
        )) {
          const checkbox = row.querySelector("[data-shop-select]");
          checkbox.checked = event.target.checked;
          if (checkbox.checked)
            this._selectedShopIds.add(checkbox.dataset.shopSelect);
          else this._selectedShopIds.delete(checkbox.dataset.shopSelect);
        }
        this._updateShopSelection();
      });
    filter();
  }

  _updateShopSelection() {
    const count = this._selectedShopIds?.size ?? 0;
    const root = this.element;
    root.querySelector("[data-selection-count]").textContent =
      `${count} selected`;
    root.querySelector("[data-selection-actions]").hidden = count === 0;
    const visible = root.querySelectorAll(".mw-list__row:not([hidden])").length;
    const selectAll = root.querySelector("[data-select-visible]");
    selectAll.checked = visible > 0 && count === visible;
    selectAll.indeterminate = count > 0 && count < visible;
    for (const button of root.querySelectorAll("[data-selected-action]"))
      button.disabled =
        !count ||
        Boolean(this._locationBusy) ||
        !isAuthoritativeGM() ||
        !hasMerchantTabLeadership();
  }

  _selectMerchantTab(key) {
    if (selectMerchantTab(this.element, key)) this._activeMerchantTab = key;
  }

  static _onSelectSection(_event, target) {
    this._selectMerchantTab(target?.dataset?.merchantTab);
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
        this._setSaveStatus("Save failed — retry");
        notify("error", "Inventory changes could not be saved.");
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

  async _addUuidToInventory(uuid, merchantId = this._selectedId) {
    if (!merchantId || !isCurrentMerchantAction(this, merchantId)) return;
    const merchant = findMerchant(merchantId);
    if (!merchant) return;
    const exists = merchant.items.some((r) => r.uuid === uuid);
    if (exists) {
      notify("info", `already in inventory.`);
      return;
    }
    // Ammunition always stocks as a full stack of 20; everything else as 1.
    let item;
    try {
      item = await this._resolveItem(uuid);
    } catch (error) {
      console.warn(`${MODULE_ID} | inventory item could not be loaded`, error);
    }
    if (!item) {
      notify(
        "warn",
        "That item could not be loaded. Nothing was added; check the item and try again.",
      );
      return;
    }
    if (!(await confirmMerchantWriteAuthority(this))) return;
    if (!isCurrentMerchantAction(this, merchantId)) return;
    const qty = resolveStockQty(item, 1);
    await commitMerchantWrite(
      merchantId,
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
    const cached = this._itemCache.get(uuid);
    if (cached) return cached;
    const snapshot = await resolveItemSnapshot(uuid);
    if (snapshot) this._itemCache.set(uuid, snapshot);
    else this._itemCache.delete(uuid);
    return snapshot;
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
    this._setSaveStatus("Saving…");
    this._formSaveDepth = (Number(this._formSaveDepth) || 0) + 1;
    try {
      await runMerchantAccessOperation(() =>
        commitMerchantWrite(
          merchant.id,
          (fresh) => {
            assertShopLocation(
              data.shopLocationId ?? shopSetup(fresh).locationId,
            );
            return normalizeMerchant({
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
              bargainFailPct: Number(
                data.bargainFailPct ?? fresh.bargainFailPct,
              ),
              passiveHaggle: data.passiveHaggle === "on",
              passivePctPerPoint: Number(
                data.passivePctPerPoint ?? fresh.passivePctPerPoint,
              ),
              passiveCapPct: Number(data.passiveCapPct ?? fresh.passiveCapPct),
              // A settings save must never replay an older trading purse.
              shop: {
                ...shopSetup(fresh),
                locationId: data.shopLocationId ?? shopSetup(fresh).locationId,
                startingGold:
                  data.startingGold ?? shopSetup(fresh).startingGold,
                open:
                  data.shopOpen === undefined &&
                  !form.querySelector('[name="shopOpen"]')
                    ? shopSetup(fresh).open
                    : data.shopOpen === "on",
                access: data.accessAll === "on" ? "all" : "selected",
              },
              allowedSkills: data.allowedSkills,
              allowedUserIds: data.allowedUserIds,
              // First time a shop gains an allowed player, flip it from the default
              // "off" to "open" so it appears in that player's Shops door — else GMs
              // tick a player, see nothing, and conclude "players can't open shops".
              // Only auto-promote on the no-players → has-players step; a GM who
              // wants a GM-pull-only shop can still set "off"/"knock".
              selfServiceMode: form.querySelector('[name="shopOpen"]')
                ? "open"
                : promoteSelfServiceMode(
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
            });
          },
          { broadcast: true },
        ),
      );
      this._setSaveStatus("Saved");
      const saved = findMerchant(this._selectedId);
      if (saved?.shop?.open === false) pushCloseAllSessionsFor(saved.id);
      pushMerchantAccessRefresh();
    } catch (error) {
      this._setSaveStatus("Save failed — retry");
      throw error;
    } finally {
      this._formSaveDepth = Math.max(0, this._formSaveDepth - 1);
    }
  }

  _setSaveStatus(message) {
    this._saveStatus = String(message || "");
    const status = this.element?.querySelector?.("[data-save-status]");
    if (status) status.textContent = this._saveStatus;
  }

  /* -------------------- actions -------------------- */

  static _onSelectLocation(_event, target) {
    if (this._locationBusy || target?.dataset?.locationId == null) return;
    this._selectedLocationId = target.dataset.locationId;
    this._merchantSearch = "";
    this._selectedShopIds?.clear();
    this.render(false);
  }

  async _runLocationAction(operation) {
    if (this._locationBusy) return;
    this._locationBusy = true;
    for (const control of this.element?.querySelectorAll?.(
      "[data-location-control]",
    ) ?? [])
      control.disabled = true;
    const status = this.element?.querySelector?.("[data-location-status]");
    if (status) status.textContent = "Updating shops…";
    try {
      if (!(await confirmMerchantWriteAuthority(this))) return;
      await operation();
    } catch (error) {
      notify(
        "error",
        error?.message ?? "The shops could not be updated. Please try again.",
      );
    } finally {
      this._locationBusy = false;
      if (this.rendered) this.render(false);
    }
  }

  static async _onCreateLocation() {
    const form = this.element?.querySelector?.("[data-location-form]");
    if (!form?.reportValidity?.()) return;
    const name = form.querySelector('[name="locationName"]').value;
    const templateId = form.querySelector('[name="locationTemplate"]').value;
    this._newLocationName = name;
    this._newLocationTemplate = templateId;
    await this._runLocationAction(async () => {
      const items = templateId === "empty" ? [] : await loadCompendiumItems();
      if (
        !canContinueWorkbenchAction(this) ||
        !(await confirmMerchantWriteAuthority(this))
      )
        return;
      const created = await createShopLocation({ name, templateId, items });
      this._selectedLocationId = created.id;
      this._newLocationName = "";
      this._locationSearch = "";
      this._merchantSearch = "";
      this._merchantFilter = "all";
      this._selectedShopIds?.clear();
      notify(
        "info",
        `${created.name} is ready with ${created.count} shops. Open All when the party arrives.`,
      );
    });
  }

  static async _onAddLocationShop() {
    const locationId = this._selectedLocationId;
    if (locationId == null) return;
    const templateId =
      this.element?.querySelector?.('[name="shopTemplate"]')?.value ?? "custom";
    await this._runLocationAction(async () => {
      const items = templateId === "custom" ? [] : await loadCompendiumItems();
      if (
        !canContinueWorkbenchAction(this) ||
        this._selectedLocationId !== locationId ||
        !(await confirmMerchantWriteAuthority(this))
      )
        return;
      const merchant = await addShopToLocation({
        locationId,
        templateId,
        items,
      });
      if (templateId === "custom")
        MerchantWorkspaceApp.openMerchant(merchant.id);
      notify(
        "info",
        `${merchant.name} added. Use Open All to make it available.`,
      );
    });
  }

  static async _onLocationOperation(_event, target) {
    const locationId = this._selectedLocationId;
    const location = locationDirectory().find((row) => row.id === locationId);
    if (!location) return;
    const operation = target?.dataset?.operation;
    const expectedIds = loadMerchants()
      .filter((row) => (row.shop?.locationId ?? "") === locationId)
      .map((row) => row.id);
    await this._runLocationAction(async () => {
      if (["generate", "clear"].includes(operation)) {
        const confirmed = await confirmInfinityDialog({
          window: {
            title: `${operation === "generate" ? "Generate" : "Clear"} all — ${location.name}`,
          },
          content: `<p>${operation === "generate" ? "Replace the inventory" : "Remove the inventory"} in all ${expectedIds.length} shops in <strong>${escapeHtml(location.name)}</strong>? Each merchant's gold will reset to its restock amount.</p>`,
          yes: {
            label:
              operation === "generate" ? "Generate All" : "Clear All Inventory",
          },
          defaultYes: false,
        });
        if (!confirmed) return;
      }
      const items = operation === "generate" ? await loadCompendiumItems() : [];
      if (
        !canContinueWorkbenchAction(this) ||
        this._selectedLocationId !== locationId ||
        !(await confirmMerchantWriteAuthority(this))
      )
        return;
      const result = await applyLocationOperation({
        locationId,
        operation,
        expectedIds,
        items,
      });
      const messages = {
        open: "opened",
        close: "closed",
        restock: "restocked; merchant gold reset",
        generate: "generated; merchant gold reset",
        clear: "emptied; merchant gold reset",
      };
      notify(
        "info",
        `${location.name}: ${result.count} shops ${messages[operation]}.`,
      );
    });
  }

  static async _onAssignLocation() {
    const source = this._selectedLocationId;
    const destination = this.element?.querySelector?.(
      '[name="assignLocation"]',
    )?.value;
    if (destination == null) return;
    const expectedShops = loadMerchants().filter(
      (row) => (row.shop?.locationId ?? "") === source,
    );
    await this._runLocationAction(async () => {
      await moveDirectoryShops({ expectedShops, destination });
      this._selectedShopIds?.clear();
      this._selectedLocationId = destination;
      this._locationSearch = "";
    });
  }

  static async _onMoveSelectedShops() {
    const expectedShops = this._directorySelection();
    const destination = this.element?.querySelector?.(
      '[name="selectedDestination"]',
    )?.value;
    if (!expectedShops.length || destination == null) return;
    await this._runLocationAction(async () => {
      await moveDirectoryShops({ expectedShops, destination });
      this._selectedShopIds.clear();
      this._selectedLocationId = destination;
      this._merchantSearch = "";
      this._merchantFilter = "all";
      this._locationSearch = "";
      notify(
        "info",
        `${expectedShops.length} shops moved. Stock, gold, and access settings were kept.`,
      );
    });
  }

  _directorySelection() {
    return loadMerchants().filter(
      (row) =>
        this._selectedShopIds?.has(row.id) &&
        (row.shop?.locationId ?? "") === this._selectedLocationId,
    );
  }

  static async _onDeleteSelectedShops() {
    return this._deleteShops(this._directorySelection());
  }

  async _deleteShops(merchants) {
    if (!merchants.length) return;
    const selectedId = this._selectedId;
    const locationId = this._selectedLocationId;
    await this._runLocationAction(async () => {
      const confirmed = await confirmInfinityDialog({
        window: {
          title: `Delete ${merchants.length === 1 ? merchants[0].name : `${merchants.length} shops`}?`,
          icon: "fa-solid fa-trash",
        },
        content: `<p>Permanently delete these shops, their stock, gold, and settings?</p><ul>${merchants.map((row) => `<li>${escapeHtml(row.name)}</li>`).join("")}</ul><p>Their open shopping sessions will close. Compendium items and character inventories are untouched. This cannot be undone.</p>`,
        yes: { label: "Delete shops" },
        defaultYes: false,
      });
      if (
        !confirmed ||
        this._selectedId !== selectedId ||
        this._selectedLocationId !== locationId ||
        !canContinueWorkbenchAction(this) ||
        !(await confirmMerchantWriteAuthority(this))
      )
        return;
      const ids = await deleteDirectoryShops(merchants);
      this._selectedShopIds?.clear();
      for (const id of ids) {
        const editor = MerchantWorkspaceApp._editors.get(id);
        if (editor && editor !== this) await editor.close();
      }
      playModuleSound(SOUND_EVENTS.CLEAR_RESET);
      notify("info", `${ids.length} shops deleted.`);
      MerchantWorkspaceApp._instance?.render(false);
      if (this._isMerchantEditor) await this.close();
    });
  }

  static async _onRenameLocation() {
    const location = locationDirectory().find(
      (row) => row.id === this._selectedLocationId,
    );
    const name = this.element?.querySelector?.(
      '[name="renameLocation"]',
    )?.value;
    if (!location) return;
    const expectedShops = loadMerchants().filter(
      (row) => !row.shop?.locationId,
    );
    await this._runLocationAction(async () => {
      if (location.id) {
        await renameShopLocation({
          locationId: location.id,
          expectedName: location.name,
          name,
        });
      } else {
        const created = await nameUnassignedShopLocation({
          name,
          expectedShops,
        });
        this._selectedLocationId = created.id;
        this._selectedShopIds?.clear();
      }
      this._locationSearch = "";
      notify("info", "Location renamed.");
    });
  }

  static async _onRemoveLocation() {
    const location = locationDirectory().find(
      (row) => row.id === this._selectedLocationId,
    );
    if (!location?.id) return;
    const expectedShops = loadMerchants().filter(
      (row) => row.shop?.locationId === location.id,
    );
    await this._runLocationAction(async () => {
      const confirmed = await confirmInfinityDialog({
        window: { title: `Remove ${location.name}?` },
        content: `<p>Remove <strong>${escapeHtml(location.name)}</strong> from your locations?</p><p>${expectedShops.length ? `All ${expectedShops.length} shops will move to <strong>Unassigned shops</strong>, keeping their stock, gold, and access settings.` : "This location has no shops."} No shops will be deleted.</p>`,
        yes: { label: "Remove location" },
        defaultYes: false,
      });
      if (
        !confirmed ||
        !canContinueWorkbenchAction(this) ||
        !(await confirmMerchantWriteAuthority(this))
      )
        return;
      await removeShopLocation({
        locationId: location.id,
        expectedName: location.name,
        expectedShops,
      });
      this._selectedLocationId = expectedShops.length ? "" : null;
      this._selectedShopIds?.clear();
      this._merchantSearch = "";
      this._merchantFilter = "all";
      this._locationSearch = "";
      notify("info", "Location removed. Its shops were kept.");
    });
  }

  static _onOpenPricingMacros() {
    return MerchantPricingApp.open();
  }

  static async _onRecheckTransaction(_event, target) {
    if (!(await confirmMerchantWriteAuthority(this))) return;
    const identity = this._reviewIdentities.get(
      String(target?.dataset?.reviewActionId ?? ""),
    );
    if (!identity) {
      notify(
        "warn",
        "That recovery card is stale. The Merchant workspace has been refreshed.",
      );
      this.render(false);
      return;
    }
    const outcome = await recheckDurableMerchantTransaction(identity);
    if (outcome?.status === "terminal") {
      await deliverDurableMerchantTerminalResult(outcome);
      notify(
        "info",
        "The transaction matched a safe checkpoint and finished normally.",
      );
    } else if (outcome?.status === "needs-review") {
      notify(
        "warn",
        outcome.guidance ??
          "The canonical data still does not match a safe checkpoint. Correct it manually, then Recheck again.",
      );
    } else if (outcome?.status === "authority-lost") {
      notify(
        "warn",
        "Merchant control moved before the recheck finished. Nothing was forced; use the active Merchant window.",
      );
    } else {
      notify(
        "warn",
        "The transaction could not be safely rechecked yet. Its review record remains pinned.",
      );
    }
    this.render(false);
  }

  static async _onDuplicateMerchant() {
    if (!this._selectedId) return;
    const merchant = findMerchant(this._selectedId);
    if (!merchant) return;
    const copy = duplicateMerchant(merchant);
    await runMerchantAccessOperation(async () => {
      assertShopLocation(copy.shop?.locationId ?? "");
      await upsertMerchant(copy);
    });
    playModuleSound(SOUND_EVENTS.PRESET_APPLY);
    ui.notifications?.info(
      `Duplicated ${merchant.name}. The new merchant's inventory is empty.`,
    );
    this.render(false);
    MerchantWorkspaceApp._instance?.render(false);
    MerchantWorkspaceApp.openMerchant(copy.id);
  }

  static async _onSelectMerchant(_event, target) {
    const id = target?.dataset?.merchantId;
    if (!id || !canContinueWorkbenchAction(this)) return;
    playModuleSound(SOUND_EVENTS.ITEM_OPEN);
    return MerchantWorkspaceApp.openMerchant(id);
  }

  static async _onSave() {
    try {
      await this._saveFromForm();
      playModuleSound(SOUND_EVENTS.LOCK_TOGGLE);
      notify("info", `merchant saved.`);
    } catch (error) {
      console.error(`${MODULE_ID} | save failed`, error);
      notify(
        "error",
        "Nothing was saved. Review the merchant fields and try again; if it keeps failing, share this exact status message with the GM.",
      );
    }
  }

  static async _onDeleteMerchant(_event, target) {
    const id = target?.dataset?.merchantId ?? this._selectedId;
    const merchant = findMerchant(id);
    if (!merchant) return;
    if (
      target?.dataset?.merchantId &&
      !this._isMerchantEditor &&
      (merchant.shop?.locationId ?? "") !== this._selectedLocationId
    )
      return;
    return this._deleteShops([merchant]);
  }

  static async _onAddFromPack() {
    if (!this._selectedId) return;
    const merchant = findMerchant(this._selectedId);
    if (!merchant) return;
    const items = await loadCompendiumItems().catch(() => []);
    if (!isCurrentMerchantAction(this, merchant.id)) return;
    if (items.length === 0) {
      notify("warn", `no items in compendium.`);
      return;
    }
    // Build options sorted by name; filter out duplicates already on the merchant.
    const existing = new Set(merchant.items.map((r) => r.uuid));
    const candidates = items
      .filter((item) => !existing.has(item.uuid))
      .sort((a, b) => String(a.name).localeCompare(String(b.name)));

    if (candidates.length === 0) {
      notify("info", `every pack item already stocked.`);
      return;
    }

    let pickedUuid = null;
    try {
      pickedUuid = await pickSearchOption({
        title: "Add Item to Merchant",
        hint: "Search every available compendium item. Nothing changes until you choose Add item.",
        confirmLabel: "Add item",
        options: candidates.map((item) => {
          const rarity = prettyRarity(getItemRarity(item));
          const type = prettyLootType(item?.type);
          return {
            id: item.uuid,
            label: item.name,
            description: [rarity, type].filter(Boolean).join(" · "),
            keywords: `${item?.type ?? ""} ${getItemRarity(item) ?? ""}`,
            img: item.img,
          };
        }),
      });
    } catch {
      pickedUuid = null;
    }
    if (!pickedUuid) return;
    if (!isCurrentMerchantAction(this, merchant.id)) return;

    // The picker is intentionally presentation-only. Revalidate the canonical
    // candidate and the current merchant inventory immediately before writing.
    const stillAvailable = candidates.some((item) => item.uuid === pickedUuid);
    const currentMerchant = findMerchant(merchant.id);
    const alreadyStocked = currentMerchant?.items?.some(
      (row) => row.uuid === pickedUuid,
    );
    if (!stillAvailable || !currentMerchant || alreadyStocked) {
      notify(
        "warn",
        "That item is no longer available to add. Nothing changed; search again.",
      );
      return;
    }
    await this._addUuidToInventory(pickedUuid, merchant.id);
  }

  static async _onMarketTier(_event, target) {
    if (!this._selectedId) return;
    const merchantId = this._selectedId;
    const form = this.element?.querySelector?.('[data-form="merchant-edit"]');
    if (!form) return;
    const min = Math.max(0, Math.floor(Number(target?.dataset?.min) || 0));
    const max = Math.max(0, Math.floor(Number(target?.dataset?.max) || 0));
    const minInput = form.querySelector('[name="poolMinGp"]');
    const maxInput = form.querySelector('[name="poolMaxGp"]');
    if (minInput) minInput.value = String(min);
    if (maxInput) maxInput.value = String(max);
    if (!(await saveBeforeMerchantAction(this, merchantId))) return;
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
    const merchantId = this._selectedId;
    // Persist pending form edits (e.g. just-toggled pool chips) so we roll
    // against the latest config, not the last-saved one.
    if (!(await saveBeforeMerchantAction(this, merchantId))) return;
    let merchant = findMerchant(merchantId);
    if (!merchant) return;
    const pool = merchant.pool ?? { lootTypes: [], rarities: [], count: 6 };
    if (
      (pool.lootTypes?.length ?? 0) === 0 &&
      (pool.rarities?.length ?? 0) === 0
    ) {
      ui.notifications?.warn(
        "Choose at least one item type or rarity before generating stock. Nothing changed.",
      );
      return;
    }
    const items = await loadCompendiumItems().catch(() => []);
    if (!isCurrentMerchantAction(this, merchantId)) return;
    if (items.length === 0) {
      ui.notifications?.warn("No items found in the compendium.");
      return;
    }
    // Re-Generate clears the whole shelf first — confirm if there's curated
    // stock to lose (Generate, which appends, never needs this).
    if (replace && merchant.items.length > 0) {
      const confirmed = await confirmInfinityDialog({
        window: {
          title: "Replace all stock?",
          icon: "fa-solid fa-arrows-rotate",
        },
        content: `<p>Clear all <strong>${merchant.items.length}</strong> current item(s) from <strong>${escapeHtml(merchant.name)}</strong> and roll a fresh shelf? (Use <em>Generate</em> instead to add without clearing.)</p>`,
        rejectClose: false,
      });
      if (!confirmed) return;
    }
    if (!(await confirmMerchantWriteAuthority(this))) return;
    if (!isCurrentMerchantAction(this, merchantId)) return;
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
        warnings[0] ?? "No stock was generated. Adjust the pool and try again.",
      );
      return;
    }
    await commitMerchantWrite(
      merchantId,
      (fresh) => {
        let next = replace ? clearInventory(fresh) : fresh;
        for (const row of rows) next = upsertInventoryRow(next, row);
        return resetMerchantPurse(next);
      },
      { broadcast: true },
    );
    playModuleSound(SOUND_EVENTS.ROLL_START);
    ui.notifications?.info(
      `${replace ? "Re-stocked" : "Generated"} ${rows.length} item(s) for ${merchant.name}.`,
    );
    this.render(false);
  }

  /** Copy the Random Stock item-types + rarities into the Buys-From-Players
   *  filter, so a merchant buys back the same kinds of goods it sells. */
  static async _onCopyStockToBuyFilter() {
    if (!this._selectedId) return;
    const merchantId = this._selectedId;
    // Persist pending form edits so we copy the latest pool selections.
    if (!(await saveBeforeMerchantAction(this, merchantId))) return;
    const merchant = findMerchant(merchantId);
    if (!merchant) return;
    await commitMerchantWrite(
      merchantId,
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
      "Copied the stock item types and rarities into the buy filter.",
    );
    this.render(false);
  }

  static async _onClearInventory() {
    if (!this._selectedId) return;
    const merchant = findMerchant(this._selectedId);
    if (!merchant || merchant.items.length === 0) return;
    const confirmed = await confirmInfinityDialog({
      window: { title: "Clear inventory?", icon: "fa-solid fa-trash" },
      content: `<p>Remove all <strong>${merchant.items.length}</strong> item(s) from <strong>${escapeHtml(merchant.name)}</strong>? Compendium entries are untouched.</p>`,
      rejectClose: false,
    });
    if (!confirmed) return;
    if (!(await confirmMerchantWriteAuthority(this))) return;
    if (!isCurrentMerchantAction(this, merchant.id)) return;
    await commitMerchantWrite(
      merchant.id,
      (fresh) => resetMerchantPurse(clearInventory(fresh)),
      {
        broadcast: true,
      },
    );
    playModuleSound(SOUND_EVENTS.CLEAR_RESET);
    this.render(false);
  }

  static async _onPickArt() {
    const merchantId = this._selectedId;
    if (!merchantId) return;
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
        if (!isCurrentMerchantAction(this, merchantId)) return;
        const currentInput = this.element?.querySelector?.('input[name="art"]');
        if (!currentInput) return;
        currentInput.value = path;
        if (!(await saveBeforeMerchantAction(this, merchantId))) return;
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
      const confirmed = await confirmInfinityDialog({
        window: {
          title: "Restock all items?",
          icon: "fa-solid fa-boxes-stacked",
        },
        content: `<p>Reset every item's current quantity back to its starting amount for <strong>${escapeHtml(merchant.name)}</strong>? This discards any current-stock changes.</p>`,
        rejectClose: false,
      });
      if (!confirmed) return;
    }
    if (!(await confirmMerchantWriteAuthority(this))) return;
    if (!isCurrentMerchantAction(this, merchant.id)) return;
    await commitMerchantWrite(
      merchant.id,
      (fresh) => resetMerchantPurse(restockAll(fresh)),
      {
        broadcast: true,
      },
    );
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
      `Opened a preview of ${merchant.name}. Preview purchases and sales do not change campaign data.`,
    );
  }

  static async _onOpenSession() {
    if (!this._selectedId) return;
    const merchant = findMerchant(this._selectedId);
    if (!merchant) return;
    if (loadMerchantAccessState().closed) {
      ui.notifications?.warn(
        "Merchant access is globally closed. Reopen shops before starting a session.",
      );
      this.render(false);
      return;
    }
    const allowedIds = allowedMerchantUserIds(merchant);
    if (!allowedIds.length) {
      ui.notifications?.warn(
        "Tag at least one Allowed Player before opening a session.",
      );
      return;
    }
    if (!globalThis.game?.users?.activeGM) {
      ui.notifications?.warn("An active GM must be online to host a session.");
      return;
    }
    if (!isAuthoritativeGM()) {
      ui.notifications?.warn(
        "Only the active full GM can open live merchant sessions.",
      );
      this.render(false);
      return;
    }
    // Single allowed player: skip the redundant re-pick (mirrors the skill
    // picker's single-option short-circuit).
    const picked =
      allowedIds.length === 1
        ? [allowedIds[0]]
        : await promptPlayerPicker(merchant);
    if (!picked || picked.length === 0) return;
    if (!(await confirmMerchantWriteAuthority(this))) return;
    // A picker can remain open while another GM edits this merchant. Reload the
    // canonical record before opening anything so a revoked player never gets a
    // session (or a stale merchant projection) from the pre-picker snapshot.
    const currentMerchant = findMerchant(merchant.id);
    const currentAllowed = new Set(allowedMerchantUserIds(currentMerchant));
    const currentPicked = picked.filter(
      (id) => currentAllowed.has(id) && globalThis.game?.users?.get?.(id),
    );
    // Report what ACTUALLY happened, not just that we tried. pushOpenSession
    // silently skips users it can't open for (not on the allow-list, or a
    // GM/assistant — who use Preview, not a live session), so a blanket
    // "opened for N" toast would claim success when the player sees nothing.
    const opened = currentMerchant
      ? pushOpenSession({
          merchant: currentMerchant,
          targetUserIds: currentPicked,
        })
      : [];
    playModuleSound(SOUND_EVENTS.MERCHANT_SESSION_OPEN);
    if (opened.length === 0) {
      ui.notifications?.warn(
        `${merchant.name} did not open. Choose an authorized player; GMs and Assistant GMs should use Preview instead.`,
      );
      this.render(false);
      return;
    }
    const users = globalThis.game?.users;
    const names = opened.map((d) => lookupUserName(d.viewerUserId));
    ui.notifications?.info(`Opened ${merchant.name} for ${names.join(", ")}.`);
    // A session pushed to an offline player won't pop until they reconnect —
    // call that out so it doesn't read as "pushed but broken".
    const offline = opened
      .filter((d) => users?.get?.(d.viewerUserId)?.active !== true)
      .map((d) => lookupUserName(d.viewerUserId));
    if (offline.length > 0) {
      ui.notifications?.warn(
        `${offline.join(", ")} ${offline.length === 1 ? "is" : "are"} offline. The shop will open when they reconnect; do not send another session.`,
      );
    }
    if (opened.length < picked.length) {
      ui.notifications?.warn(
        `Skipped ${picked.length - opened.length} player(s) who were not authorized for this merchant or should use Preview.`,
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
    this._setSaveStatus("Saving…");
    try {
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
      this._setSaveStatus("Saved");
    } catch (error) {
      this._setSaveStatus("Save failed — retry");
      throw error;
    }
  }

  static async _onOpenInventoryItem(_event, target) {
    const uuid = target?.dataset?.uuid;
    if (!uuid) return;
    await openItemByUuid(uuid, {
      onOpened: () => playModuleSound(SOUND_EVENTS.ITEM_OPEN),
    });
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

function merchantReviewStateLabel(state) {
  return (
    {
      before: "planned before state",
      after: "planned after state",
      partial: "partly applied",
      both: "unchanged in this plan",
      "third-state": "does not match either checkpoint",
    }[state] ?? "unknown state"
  );
}

function merchantReviewReasonLabel(reason) {
  return (
    {
      "canonical-state-mismatch":
        "Campaign data does not match the saved before or after checkpoint.",
      "impossible-write-order":
        "The Actor and Merchant changes appear in an unsafe order.",
      "actor-state-regressed":
        "The Actor no longer matches the checkpoint already recorded.",
      "malformed-observation":
        "The canonical Actor or Merchant data could not be read safely.",
    }[reason] ?? `Recovery is pinned: ${String(reason || "unknown reason")}.`
  );
}

function formatReviewTimestamp(timestamp) {
  const value = Number(timestamp);
  if (!Number.isFinite(value) || value < 1) return "time unavailable";
  try {
    return new Date(value).toLocaleString();
  } catch {
    return "time unavailable";
  }
}

function formatReviewWallet(wallet) {
  const parts = ["pp", "gp", "ep", "sp", "cp"]
    .map((denomination) => [denomination, Number(wallet?.[denomination]) || 0])
    .filter(([, amount]) => amount > 0)
    .map(([denomination, amount]) => `${amount} ${denomination}`);
  return parts.length > 0 ? parts.join(", ") : "0 coins";
}

function formatReviewItem(item) {
  if (!item) return "item absent";
  const quantity = Number(item.system?.quantity);
  return Number.isFinite(quantity)
    ? `item present (qty ${quantity})`
    : "item present";
}

function formatReviewGold(merchant) {
  const value = merchant?.goldOnHand;
  return value == null || value === ""
    ? "unlimited merchant gold"
    : `${Number(value).toFixed(2)} gp merchant gold`;
}

function formatReviewStock(merchant, itemUuid) {
  const row = merchant?.items?.find?.(
    (candidate) => String(candidate?.uuid ?? "") === String(itemUuid ?? ""),
  );
  if (!row) return "stock row absent";
  return row.unlimited
    ? "stock unlimited"
    : `stock qty ${Math.max(0, Number(row.qty) || 0)}`;
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

/** Choose the character used by the non-writing GM preview. */
async function promptPreviewActor() {
  const characters = (
    globalThis.game?.actors?.filter?.((actor) => actor?.type === "character") ??
    []
  ).sort((a, b) => String(a.name).localeCompare(String(b.name)));
  if (characters.length === 0) {
    return { actor: globalThis.game?.user?.character ?? null };
  }

  const browseOnlyId = "browse-only";
  const assignedId = globalThis.game?.user?.character?.id;
  const picked = await pickSearchOption({
    title: "Preview Shop — choose a character",
    hint: "Previewing never changes items or coin. Choose a character to test wallet, selling, and bargaining, or browse without one.",
    confirmLabel: "Open preview",
    selectedIds: [assignedId || characters[0]?.id || browseOnlyId],
    options: [
      {
        id: browseOnlyId,
        label: "Browse without a character",
        description:
          "View stock only; selling and wallet context stay unavailable.",
        keywords: "none browse only",
      },
      ...characters.map((actor) => ({
        id: actor.id,
        label: actor.name,
        description:
          actor.id === assignedId ? "Your assigned character" : "Character",
        img: actor.img,
      })),
    ],
  });
  if (!picked) return null;
  if (picked === browseOnlyId) return { actor: null };

  // Revalidate against the canonical Actor collection after the picker closes.
  const actor = globalThis.game?.actors?.get?.(picked);
  return actor?.type === "character" ? { actor } : null;
}

/** Choose only users already allowlisted on this merchant. */
async function promptPlayerPicker(merchant) {
  const allowed = new Set(
    allowedMerchantUserIds(merchant)
      .map((id) => String(id))
      .filter(Boolean),
  );
  if (allowed.size === 0) return [];

  const picked = await pickSearchOption({
    title: `Open Session — ${merchant.name}`,
    hint: "Choose the allowed players who should receive this live session. No access permissions change here.",
    confirmLabel: "Open session",
    multiple: true,
    selectedIds: [...allowed],
    options: [...allowed].map((id) => {
      const user = globalThis.game?.users?.get?.(id);
      return {
        id,
        label: lookupUserName(id),
        description: user?.active
          ? "Online"
          : "Offline — the session can resume after reconnect",
        keywords: user?.active ? "online active" : "offline reconnect",
        img: user?.avatar,
      };
    }),
  });
  if (!Array.isArray(picked)) return [];

  // Revalidate the caller allowlist and current user collection immediately
  // before the existing socket/session workflow receives the selection.
  return picked.filter(
    (id) => allowed.has(id) && globalThis.game?.users?.get?.(id),
  );
}
