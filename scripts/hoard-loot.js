/**
 * Infinity D&D5e — HoardLootApp
 *
 * GM-only window for rolling a treasure cache. A "hoard" is a single
 * pile (a chest, a dragon's stash, a defeated boss's stockpile), so
 * the gp budget is driven by *tier × scale*, not by a creature count.
 *
 *   tier         — segmented row, T1..T5
 *   hoard scale  — segmented row, Small / Standard / Large / Massive
 *   pile bias    — slider, splits the budget between a raw coin pile
 *                  and the item bundle (the unique hoard control)
 *   magic bias   — same dial as the other windows
 *   rarity       — chips, default all selected
 *   loot types   — chips, default all selected
 *   max items    — small numeric input, soft ceiling on the item count
 *
 * Reuses the shared roller, pack stats, and settings reads.
 */

import {
  HOARD_DEFAULT_ITEM_CEILING,
  HOARD_SCALE_PRESETS,
  PILE_BIAS_PRESETS,
  PILE_BIAS_RANGE,
  coinDenominationBreakdown,
  computeHoardBudget,
  formatCoinBreakdown,
  getDefaultRarities,
  getScaleFlavor,
  splitCoinPile,
} from "./loot/hoard-budget.js";
import { nearestPreset } from "./loot/budget.js";
import { promptDistributeItems } from "./loot/distribute.js";
import { loadCompendiumItems } from "./loot/pack.js";
import {
  computePackStats,
  computeTierFilteredStats,
} from "./loot/pack-stats.js";
import { MAGIC_BIAS_RANGE, filterCandidates, rollLoot } from "./loot/roller.js";
import {
  LOOT_TYPES,
  RARITIES,
  TIERS,
  getItemRarity,
  tierWindow,
} from "./loot/tag-vocabulary.js";
import { SETTING_KEYS, getSetting } from "./settings.js";
import {
  clampFloat,
  clampInt,
  escapeHtml,
  formatGp,
  formatMagicBias,
  prettyLootType,
  titleCase,
} from "./ui-util.js";

const MODULE_ID = "infinity-dnd5e";
const PACK_ID = `${MODULE_ID}.infinity-dnd5e-items`;
const TEMPLATE_PATH = `modules/${MODULE_ID}/templates/hoard-loot.hbs`;

const MAX_ITEMS_RANGE = Object.freeze({ min: 1, max: 30 });

const SLIDER_LABELS = Object.freeze({
  pileBias: "Pile Bias",
  magicBias: "Magic Bias",
});

const SCALE_ORDER = Object.freeze(["small", "standard", "large", "massive"]);

/* ------------------------------------------------------------------ *
 * Application V2 host
 * ------------------------------------------------------------------ */

const { ApplicationV2, HandlebarsApplicationMixin } = foundry.applications.api;

export class HoardLootApp extends HandlebarsApplicationMixin(ApplicationV2) {
  static _instance = null;
  static _persistedState = null;

  static DEFAULT_OPTIONS = {
    id: "infinity-dnd5e-hoard-loot",
    tag: "section",
    classes: ["infinity-dnd5e", "hoard-loot"],
    window: {
      title: "Infinity D&D5e — Hoard Loot",
      icon: "fa-solid fa-sack-dollar",
      resizable: true,
    },
    position: { width: 760, height: 720 },
    actions: {
      generate: HoardLootApp._onGenerate,
      reset: HoardLootApp._onReset,
      clear: HoardLootApp._onClear,
      openItem: HoardLootApp._onOpenItem,
      sendToChat: HoardLootApp._onSendToChat,
      depositHaul: HoardLootApp._onDepositHaul,
      snap: HoardLootApp._onSnap,
      tierSelect: HoardLootApp._onTierSelect,
      scaleSelect: HoardLootApp._onScaleSelect,
      chipAll: HoardLootApp._onChipAll,
      chipNone: HoardLootApp._onChipNone,
    },
    form: {
      handler: undefined,
      closeOnSubmit: false,
      submitOnChange: false,
    },
  };

  static PARTS = {
    body: { template: TEMPLATE_PATH },
  };

  /** Open (or focus) the singleton instance. */
  static open() {
    if (!HoardLootApp._instance) HoardLootApp._instance = new HoardLootApp();
    if (HoardLootApp._instance.rendered) HoardLootApp._instance.bringToFront();
    else HoardLootApp._instance.render(true);
    return HoardLootApp._instance;
  }

  /* ------------------- state ------------------- */

  static buildDefaultForm() {
    const tier = getSetting(SETTING_KEYS.DEFAULT_TIER) ?? "t2";
    const scale = "standard";
    return {
      tier,
      scale,
      pileBias: 0,
      magicBias: getSetting(SETTING_KEYS.DEFAULT_MAGIC_BIAS) ?? 0,
      maxItems: HOARD_DEFAULT_ITEM_CEILING[scale] ?? 8,
      // Art variants on by default — a treasure hoard is the most
      // thematic place for rolled appraisals ("Signed Marble Bust @ 1.9×
      // base value"). Toggleable via the form input.
      artVariants: true,
      // Rarity narrows with the scale's narrative shape; the chips
      // remain editable and stay sticky across tier/scale clicks
      // until the GM customizes them away from the table default.
      rarities: getDefaultRarities(tier, scale),
      // Loot types stay all-selected by default — orthogonal to scale.
      lootTypes: [...LOOT_TYPES],
    };
  }

  constructor(options = {}) {
    super(options);
    const persistEnabled = getSetting(SETTING_KEYS.PERSIST_STATE) !== false;
    const persisted = persistEnabled ? HoardLootApp._persistedState : null;
    const defaults = HoardLootApp.buildDefaultForm();
    this._form = persisted?.form
      ? { ...defaults, ...persisted.form }
      : defaults;
    this._lastResult = persisted?.lastResult ?? null;
    this._loadingItems = false;
    this._cachedItems = null;
    this._cachedItemsAt = 0;
    this._packStats = null;
  }

  /* ------------------- context ------------------- */

  async _prepareContext() {
    const totalBudget = computeHoardBudget(this._formForBudget());
    const { coinPileGp, itemBudget } = splitCoinPile(
      totalBudget,
      this._form.pileBias,
    );
    const stats = this._packStats ?? computePackStats([]);
    const candidates = this._countCandidates();
    // Tier-aware chip counts: when items are loaded, count rarities and
    // loot types ONLY within the current tier window — so the chip the
    // user sees reflects what they'll actually roll, not the pack-wide
    // total. Falls back to pack-wide stats before the compendium loads.
    const tierStats = this._cachedItems
      ? computeTierFilteredStats(this._cachedItems, tierWindow(this._form.tier))
      : null;
    return {
      form: this._form,
      moduleId: MODULE_ID,
      totalBudgetLabel: formatGp(totalBudget),
      coinPileLabel: formatGp(coinPileGp),
      itemBudgetLabel: formatGp(itemBudget),
      candidateLabel: this._candidateLabel(candidates, stats.totalItems),
      loadingItems: this._loadingItems,

      tierOptions: TIERS.map((tier) => ({
        value: tier,
        label: tierLabel(tier),
        shortLabel: tier.toUpperCase(),
        selected: tier === this._form.tier,
        count: stats.byTier?.[tier] ?? 0,
      })),

      scaleOptions: SCALE_ORDER.map((key) => ({
        value: key,
        label: humanizeKey(key),
        multiplier: HOARD_SCALE_PRESETS[key],
        flavor: getScaleFlavor(key),
        selected: key === this._form.scale,
      })),

      maxItems: this._form.maxItems,
      maxItemsMin: MAX_ITEMS_RANGE.min,
      maxItemsMax: MAX_ITEMS_RANGE.max,

      pileBias: this._sliderContext({
        name: "pileBias",
        value: this._form.pileBias,
        range: PILE_BIAS_RANGE,
        presets: PILE_BIAS_PRESETS,
        valueLabel: formatPileBias(this._form.pileBias),
      }),
      magicBias: this._sliderContext({
        name: "magicBias",
        value: this._form.magicBias,
        range: MAGIC_BIAS_RANGE,
        presets: { neutral: 0 },
        valueLabel: formatMagicBias(this._form.magicBias),
      }),

      rarityOptions: RARITIES.map((rarity) => ({
        value: rarity,
        label: titleCase(rarity),
        count: tierStats?.byRarity?.[rarity] ?? stats.byRarity?.[rarity] ?? 0,
        selected: this._form.rarities.includes(rarity),
      })),
      lootTypeOptions: LOOT_TYPES.map((lootType) => ({
        value: lootType,
        label: prettyLootType(lootType),
        count:
          tierStats?.byLootType?.[lootType] ??
          stats.byLootType?.[lootType] ??
          0,
        selected: this._form.lootTypes.includes(lootType),
      })),

      hasResult: Boolean(this._lastResult && this._lastResult.items?.length),
      hasCoinPile: Boolean(this._lastResult?.coinPileGp),
      result: this._lastResult,
    };
  }

  /* ------------------- lifecycle ------------------- */

  async _onRender(context, options) {
    super._onRender?.(context, options);
    const root = this.element;
    if (!root) return;

    root.classList.toggle(
      "lf-no-anim",
      getSetting(SETTING_KEYS.ANIMATIONS) === false,
    );
    root.classList.toggle(
      "lf-no-glow",
      getSetting(SETTING_KEYS.RARITY_GLOW) === false,
    );

    const form = root.querySelector("[data-form='hoard-loot']");
    if (form) {
      form.addEventListener("input", (event) => this._onFormInput(event));
      form.addEventListener("change", (event) => this._onFormInput(event));
    }

    if (!this._packStats && !this._loadingItems) {
      this._primePackStats();
    }
  }

  _onClose(options) {
    super._onClose?.(options);
    if (getSetting(SETTING_KEYS.PERSIST_STATE) !== false) {
      HoardLootApp._persistedState = {
        form: { ...this._form },
        lastResult: this._lastResult,
      };
    } else {
      HoardLootApp._persistedState = null;
    }
    HoardLootApp._instance = null;
  }

  /* ------------------- actions ------------------- */

  /** @this {HoardLootApp} */
  static async _onGenerate(_event, _target) {
    await this._generate();
  }

  /** @this {HoardLootApp} */
  static async _onReset(_event, _target) {
    this._form = HoardLootApp.buildDefaultForm();
    await this.render();
  }

  /** @this {HoardLootApp} */
  static async _onClear(_event, _target) {
    this._lastResult = null;
    await this.render();
  }

  /** @this {HoardLootApp} */
  static async _onOpenItem(event, target) {
    const uuid = target?.dataset?.uuid;
    if (!uuid) return;
    try {
      const doc = await fromUuid(uuid);
      if (doc?.sheet) doc.sheet.render(true);
    } catch (error) {
      console.warn(`${MODULE_ID} | failed to open item`, { uuid, error });
    }
  }

  /** @this {HoardLootApp} */
  static async _onSendToChat(_event, _target) {
    if (!this._lastResult) {
      ui.notifications?.info("Nothing to send — roll a hoard first.");
      return;
    }
    const html = buildHoardChatHtml(this._lastResult);
    const messageData = {
      content: html,
      speaker: ChatMessage.getSpeaker({ alias: "Hoard Loot" }),
    };
    const whispers = resolveChatRecipients(
      getSetting(SETTING_KEYS.CHAT_MODE) ?? "public",
    );
    if (whispers !== null) messageData.whisper = whispers;
    try {
      await ChatMessage.create(messageData);
    } catch (error) {
      console.error(`${MODULE_ID} | failed to send hoard to chat`, error);
      ui.notifications?.error("Failed to send loot to chat. See console.");
    }
  }

  /** @this {HoardLootApp} */
  static async _onDepositHaul(_event, _target) {
    if (!this._lastResult) {
      ui.notifications?.info("Nothing to deposit — roll a hoard first.");
      return;
    }
    const items = (this._lastResult.items ?? [])
      .map(toDistributableEntry)
      .filter(Boolean);
    const currency = this._lastResult.coinPileGp
      ? this._lastResult.coinBreakdown
      : null;
    if (items.length === 0 && !currency) {
      ui.notifications?.info("This hoard has no items or coins to deposit.");
      return;
    }
    await promptDistributeItems(items, {
      title: "Deposit Hoard to Actor",
      hint: `Choose a character to receive the hoard's ${items.length} item(s).`,
      currency,
      coinLabel: this._lastResult.coinBreakdownLabel,
    });
  }

  /** @this {HoardLootApp} */
  static async _onSnap(_event, target) {
    const name = target?.dataset?.target;
    const raw = Number(target?.dataset?.value);
    if (!name || !Number.isFinite(raw)) return;
    this._form = { ...this._form, [name]: raw };
    await this.render();
  }

  /** @this {HoardLootApp} */
  static async _onTierSelect(_event, target) {
    const newTier = target?.dataset?.value;
    if (!newTier || newTier === this._form.tier) return;
    // Sticky rarity update: if the GM hasn't customized rarities
    // away from the (prev tier, scale) default, slide them to the
    // (new tier, scale) default. Otherwise leave their tweaks alone.
    const prevDefaults = getDefaultRarities(this._form.tier, this._form.scale);
    const customizedRarities = !sameSet(this._form.rarities, prevDefaults);
    const nextRarities = customizedRarities
      ? this._form.rarities
      : getDefaultRarities(newTier, this._form.scale);
    this._form = { ...this._form, tier: newTier, rarities: nextRarities };
    await this.render();
  }

  /** @this {HoardLootApp} */
  static async _onScaleSelect(_event, target) {
    const newScale = target?.dataset?.value;
    if (!newScale || newScale === this._form.scale) return;
    const prevScale = this._form.scale;

    // Sticky max-items update.
    const prevCeilingDefault = HOARD_DEFAULT_ITEM_CEILING[prevScale];
    const customizedMaxItems = this._form.maxItems !== prevCeilingDefault;
    const nextMaxItems = customizedMaxItems
      ? this._form.maxItems
      : (HOARD_DEFAULT_ITEM_CEILING[newScale] ?? this._form.maxItems);

    // Sticky rarity update.
    const prevRarityDefaults = getDefaultRarities(this._form.tier, prevScale);
    const customizedRarities = !sameSet(
      this._form.rarities,
      prevRarityDefaults,
    );
    const nextRarities = customizedRarities
      ? this._form.rarities
      : getDefaultRarities(this._form.tier, newScale);

    this._form = {
      ...this._form,
      scale: newScale,
      maxItems: nextMaxItems,
      rarities: nextRarities,
    };
    await this.render();
  }

  /** @this {HoardLootApp} */
  static async _onChipAll(_event, target) {
    const group = target?.dataset?.group;
    if (group === "rarity") {
      this._form = { ...this._form, rarities: [...RARITIES] };
    } else if (group === "lootType") {
      this._form = { ...this._form, lootTypes: [...LOOT_TYPES] };
    } else {
      return;
    }
    await this.render();
  }

  /** @this {HoardLootApp} */
  static async _onChipNone(_event, target) {
    const group = target?.dataset?.group;
    if (group === "rarity") {
      this._form = { ...this._form, rarities: [] };
    } else if (group === "lootType") {
      this._form = { ...this._form, lootTypes: [] };
    } else {
      return;
    }
    await this.render();
  }

  /* ------------------- form handling ------------------- */

  _onFormInput(event) {
    const target = event.target;
    if (!target?.name) return;
    const next = { ...this._form };
    switch (target.name) {
      case "pileBias":
        next.pileBias = clampFloat(
          target.value,
          PILE_BIAS_RANGE.min,
          PILE_BIAS_RANGE.max,
          0,
        );
        break;
      case "magicBias":
        next.magicBias = clampFloat(
          target.value,
          MAGIC_BIAS_RANGE.min,
          MAGIC_BIAS_RANGE.max,
          0,
        );
        break;
      case "artVariants":
        next.artVariants = Boolean(target.checked);
        break;
      case "maxItems":
        next.maxItems = clampInt(
          target.value,
          MAX_ITEMS_RANGE.min,
          MAX_ITEMS_RANGE.max,
          HOARD_DEFAULT_ITEM_CEILING[this._form.scale] ?? 8,
        );
        break;
      case "rarity":
        next.rarities = readMultiCheckGroup(this.element, "rarity");
        break;
      case "lootType":
        next.lootTypes = readMultiCheckGroup(this.element, "lootType");
        break;
      default:
        return;
    }
    this._form = next;
    this._patchLiveReadouts();
  }

  _patchLiveReadouts() {
    if (!this.element) return;
    const root = this.element;
    const totalBudget = computeHoardBudget(this._formForBudget());
    const { coinPileGp, itemBudget } = splitCoinPile(
      totalBudget,
      this._form.pileBias,
    );

    setText(root, "[data-total-budget]", formatGp(totalBudget));
    setText(root, "[data-coin-pile-projected]", formatGp(coinPileGp));
    setText(root, "[data-item-budget]", formatGp(itemBudget));

    setText(
      root,
      "[data-readout='pileBias']",
      formatPileBias(this._form.pileBias),
    );
    setText(
      root,
      "[data-readout='magicBias']",
      formatMagicBias(this._form.magicBias),
    );

    const candidates = this._countCandidates();
    setText(
      root,
      "[data-candidates]",
      this._candidateLabel(candidates, this._packStats?.totalItems ?? 0),
    );

    this._syncSnapStates(root, "pileBias", this._form.pileBias);
    this._syncSnapStates(root, "magicBias", this._form.magicBias);
  }

  _syncSnapStates(root, target, value) {
    const snaps = root.querySelectorAll(
      `.lf-slider__snap[data-target="${target}"]`,
    );
    for (const snap of snaps) {
      const snapValue = Number(snap.dataset.value);
      snap.classList.toggle(
        "is-active",
        Number.isFinite(snapValue) && Math.abs(snapValue - value) < 0.01,
      );
    }
  }

  _formForBudget() {
    return { tier: this._form.tier, scale: this._form.scale };
  }

  _filterSpec() {
    // Tier window — pull from the chosen tier AND one tier below so a T2
    // hoard can include T1 commons (arrows, daggers, torches, gold). The
    // curated pack tags all real common gear at T1, so a strict single-
    // tier filter at T2 surfaces zero commons even when the user has the
    // common rarity chip selected. Matches the Per-Creature/Per-Encounter
    // behavior.
    return {
      tiers: tierWindow(this._form.tier),
      rarities: this._form.rarities,
      lootTypes: this._form.lootTypes,
      requireEligible: true,
    };
  }

  _countCandidates() {
    if (!this._cachedItems) return 0;
    return filterCandidates(this._cachedItems, this._filterSpec()).length;
  }

  _candidateLabel(count, totalItems) {
    if (!this._packStats) return "—";
    if (count === 0) {
      return `0 items match · pack has ${totalItems.toLocaleString()}`;
    }
    return `${count.toLocaleString()} item${count === 1 ? "" : "s"} match current filters`;
  }

  _sliderContext({ name, value, range, presets, valueLabel }) {
    const presetLabel = presets
      ? humanizeKey(nearestPreset(value, presets))
      : "";
    return {
      name,
      label: SLIDER_LABELS[name] ?? name,
      value,
      min: range.min,
      max: range.max,
      step: range.step,
      valueLabel,
      // Avoid echoing the primary label as a secondary tag.
      presetLabel: presetLabel === valueLabel ? "" : presetLabel,
      snaps: presets
        ? Object.entries(presets).map(([key, target]) => ({
            key,
            label: humanizeKey(key),
            value: target,
            active: Math.abs(value - target) < 0.01,
          }))
        : null,
    };
  }

  /* ------------------- generation pipeline ------------------- */

  async _generate() {
    if (this._loadingItems) return;
    const needsLoad = !this._isItemCacheFresh();
    if (needsLoad) {
      this._loadingItems = true;
      await this.render();
    }
    try {
      const totalBudget = computeHoardBudget(this._formForBudget());
      const { coinPileGp, itemBudget } = splitCoinPile(
        totalBudget,
        this._form.pileBias,
      );
      const items = await this._loadItems();
      const candidates = filterCandidates(items, this._filterSpec());
      const raw =
        itemBudget > 0
          ? rollLoot(candidates, {
              count: this._form.maxItems,
              budgetGp: itemBudget,
              magicBias: this._form.magicBias,
              artVariants: this._form.artVariants,
            })
          : { items: [], totalGp: 0, droppedForBudget: 0, warnings: [] };

      // Decorate with displayName / valueLabel so rolled art appraisals
      // ("Signed Marble Bust", "1.9× base value") render in the result
      // list. Non-art entries fall back to the source item name.
      const decoratedItems = raw.items.map((entry) => ({
        ...entry,
        rarity: getItemRarity(entry.item) || "common",
        displayName: entry.displayName || entry.item?.name || "",
        variantSummary: entry.variant?.summary ?? "",
        valueLabel: entry.valueLabel ?? "",
        quantityLabel: entry.quantity > 1 ? `×${entry.quantity} · ` : "",
        gpTotalLabel: formatGp(entry.gpTotal),
      }));

      this._lastResult = {
        items: decoratedItems,
        itemsTotalGp: raw.totalGp,
        itemsTotalGpLabel: formatGp(raw.totalGp),
        itemBudget,
        itemBudgetLabel: formatGp(itemBudget),
        coinPileGp,
        coinPileLabel: formatGp(coinPileGp),
        coinBreakdown: coinDenominationBreakdown(coinPileGp),
        coinBreakdownLabel: formatCoinBreakdown(
          coinDenominationBreakdown(coinPileGp),
        ),
        totalGp: raw.totalGp + coinPileGp,
        totalGpLabel: formatGp(raw.totalGp + coinPileGp),
        droppedForBudget: raw.droppedForBudget ?? 0,
        warnings: raw.warnings ?? [],
      };
    } finally {
      this._loadingItems = false;
      await this.render();
    }
  }

  async _primePackStats() {
    this._loadingItems = true;
    try {
      await this._loadItems();
    } finally {
      this._loadingItems = false;
      if (this.rendered) await this.render();
    }
  }

  _isItemCacheFresh() {
    const minutes = Number(getSetting(SETTING_KEYS.PACK_TTL_MINUTES) ?? 5);
    const ttlMs =
      Math.max(1, Number.isFinite(minutes) ? minutes : 5) * 60 * 1000;
    return Boolean(
      this._cachedItems && Date.now() - this._cachedItemsAt < ttlMs,
    );
  }

  async _loadItems() {
    if (this._isItemCacheFresh()) return this._cachedItems;
    this._cachedItems = await loadCompendiumItems({ packId: PACK_ID });
    this._cachedItemsAt = Date.now();
    this._packStats = computePackStats(this._cachedItems);
    return this._cachedItems;
  }
}

/* ------------------------------------------------------------------ *
 * Helpers
 * ------------------------------------------------------------------ */

/**
 * Map a hoard result entry to the distribute helper's accepted shape,
 * preserving the rolled stack quantity. Handles generated `itemData`
 * (art / gem variants) and plain UUID-bearing compendium entries.
 */
function toDistributableEntry(entry) {
  if (!entry) return null;
  const quantity = Math.max(1, Math.floor(Number(entry.quantity) || 1));
  if (entry.itemData) {
    return {
      itemData: entry.itemData,
      name: entry.itemData.name ?? entry.item?.name ?? "",
      quantity,
    };
  }
  const uuid = entry.item?.uuid;
  return uuid ? { uuid, name: entry.item?.name ?? "", quantity } : null;
}

function tierLabel(tier) {
  const map = {
    t1: "T1 — Lvl 1–4",
    t2: "T2 — Lvl 5–10",
    t3: "T3 — Lvl 11–16",
    t4: "T4 — Lvl 17–20",
    t5: "T5 — Epic",
  };
  return map[tier] ?? tier;
}

/**
 * Convert a key like "coinHeavy" or "very-rare" into a human label
 * with spaces: "Coin Heavy", "Very Rare". Empty input → "".
 */
function humanizeKey(value) {
  const raw = String(value ?? "").trim();
  if (!raw) return "";
  return raw
    .replace(/[-_]+/g, " ")
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

function formatPileBias(value) {
  const num = Number(value);
  if (!Number.isFinite(num) || Math.abs(num) < 0.025) return "Mixed";
  const pct = Math.round(Math.abs(num) * 100);
  return num > 0 ? `+${pct}% Items` : `+${pct}% Coins`;
}

function buildHoardChatHtml(result) {
  const lines = result.items
    .map((entry) => {
      // Art variants display their rolled name ("Signed Marble Bust");
      // chat link still points at the base compendium item via uuid so
      // clicking opens the source sheet.
      const displayName =
        entry.displayName ?? entry.item?.name ?? "?";
      const link = entry.item?.uuid
        ? `@UUID[${entry.item.uuid}]{${escapeHtml(displayName)}}`
        : escapeHtml(displayName);
      const qty = entry.quantity > 1 ? `${entry.quantity}× ` : "";
      const rarity = escapeHtml(entry.rarity ?? "");
      const valueLabel = entry.valueLabel
        ? ` · ${escapeHtml(entry.valueLabel)}`
        : "";
      return `<li><strong>${qty}${link}</strong> <span style="opacity:0.7">— ${rarity} · ${formatGp(entry.gpTotal)}${valueLabel}</span></li>`;
    })
    .join("");
  const coinLine = result.coinPileGp
    ? `<p style="margin: 0 0 6px;"><strong>Coin pile:</strong> ${formatGp(result.coinPileGp)}${result.coinBreakdownLabel ? ` <span style="opacity:0.7">(${escapeHtml(result.coinBreakdownLabel)})</span>` : ""}</p>`
    : "";
  return `
<div class="infinity-loot-chat">
  <h3 style="margin: 0 0 4px;">Hoard Loot</h3>
  <p style="margin: 0 0 6px; opacity: 0.85;">
    Total: ${formatGp(result.totalGp)}
  </p>
  ${coinLine}
  ${result.items.length ? `<ul style="margin: 0; padding-left: 18px;">${lines}</ul>` : ""}
</div>`;
}

function resolveChatRecipients(mode) {
  if (mode === "public") return null;
  const users = globalThis.game?.users;
  if (!users) return null;
  const list = users.values?.() ?? users;
  const out = [];
  for (const user of list) {
    if (!user?.active) continue;
    const isGM = user.isGM === true || user.role >= 4;
    if (mode === "whisper-gm" && isGM) out.push(user.id);
    if (mode === "whisper-players" && !isGM) out.push(user.id);
  }
  return out;
}

/**
 * Treat two arrays as unordered sets — order doesn't matter, duplicates
 * collapse. Used by the sticky-defaults logic in tier/scale handlers.
 */
function sameSet(a, b) {
  if (!Array.isArray(a) || !Array.isArray(b)) return false;
  const setA = new Set(a);
  if (setA.size !== new Set(b).size) return false;
  for (const item of b) if (!setA.has(item)) return false;
  return true;
}

function setText(root, selector, text) {
  const el = root.querySelector(selector);
  if (el) el.textContent = String(text ?? "");
}

function readMultiCheckGroup(root, group) {
  if (!root) return [];
  return [
    ...root.querySelectorAll(`input[type='checkbox'][name='${group}']:checked`),
  ].map((el) => el.value);
}
