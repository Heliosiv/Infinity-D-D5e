/**
 * Infinity D&D5e — HordeLootApp
 *
 * GM-only window for rolling treasure for a defeated mob:
 *  - Mob Size slider drives the gp budget (scales linearly per
 *    creature based on the threat tier)
 *  - Pile Bias slider splits the budget between a raw coin pile and
 *    the item bundle (the unique horde control)
 *  - Magic Bias + standard tier / rarity / loot-type filters mirror
 *    Per-Encounter so the visual language stays consistent
 *
 * Shares the underlying roller, budget multipliers, and pack stats
 * with Per-Encounter Loot. The horde-specific gp math lives in
 * loot/horde-budget.js and is fully unit tested.
 */

import {
  MOB_SIZE_RANGE,
  PILE_BIAS_PRESETS,
  PILE_BIAS_RANGE,
  coinDenominationBreakdown,
  computeHordeBudget,
  formatCoinBreakdown,
  splitCoinPile,
} from "./loot/horde-budget.js";
import { nearestPreset } from "./loot/budget.js";
import { computePackStats } from "./loot/pack-stats.js";
import { MAGIC_BIAS_RANGE, filterCandidates, rollLoot } from "./loot/roller.js";
import {
  LOOT_TYPES,
  RARITIES,
  TIERS,
  getItemRarity,
} from "./loot/tag-vocabulary.js";
import { SETTING_KEYS, getSetting } from "./settings.js";

const MODULE_ID = "infinity-dnd5e";
const PACK_ID = `${MODULE_ID}.infinity-dnd5e-items`;
const TEMPLATE_PATH = `modules/${MODULE_ID}/templates/horde-loot.hbs`;

const COUNT_RANGE = Object.freeze({ min: 1, max: 24, step: 1 });

/** Slider labels — central so the template stays mute. */
const SLIDER_LABELS = Object.freeze({
  mobSize: "Mob Size",
  count: "Item Count",
  pileBias: "Pile Bias",
  magicBias: "Magic Bias",
});

/* ------------------------------------------------------------------ *
 * Application V2 host
 * ------------------------------------------------------------------ */

const { ApplicationV2, HandlebarsApplicationMixin } = foundry.applications.api;

export class HordeLootApp extends HandlebarsApplicationMixin(ApplicationV2) {
  static _instance = null;
  static _persistedState = null;

  static DEFAULT_OPTIONS = {
    id: "infinity-dnd5e-horde-loot",
    tag: "section",
    classes: ["infinity-dnd5e", "horde-loot"],
    window: {
      title: "Infinity D&D5e — Horde Loot",
      icon: "fa-solid fa-sack-dollar",
      resizable: true,
    },
    position: { width: 760, height: 760 },
    actions: {
      generate: HordeLootApp._onGenerate,
      reset: HordeLootApp._onReset,
      clear: HordeLootApp._onClear,
      openItem: HordeLootApp._onOpenItem,
      sendToChat: HordeLootApp._onSendToChat,
      snap: HordeLootApp._onSnap,
      tierSelect: HordeLootApp._onTierSelect,
      chipAll: HordeLootApp._onChipAll,
      chipNone: HordeLootApp._onChipNone,
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
    if (!HordeLootApp._instance) HordeLootApp._instance = new HordeLootApp();
    if (HordeLootApp._instance.rendered) HordeLootApp._instance.bringToFront();
    else HordeLootApp._instance.render(true);
    return HordeLootApp._instance;
  }

  /* ------------------- state ------------------- */

  static buildDefaultForm() {
    return {
      tier: getSetting(SETTING_KEYS.DEFAULT_TIER) ?? "t2",
      mobSize: 8,
      count: 6,
      pileBias: 0,
      magicBias: getSetting(SETTING_KEYS.DEFAULT_MAGIC_BIAS) ?? 0,
      // Horde rolls tend to read better with the lower-rarity bulk —
      // common + uncommon by default. GM can widen via the chips.
      rarities: ["common", "uncommon"],
      lootTypes: [], // empty = all
    };
  }

  constructor(options = {}) {
    super(options);
    const persistEnabled = getSetting(SETTING_KEYS.PERSIST_STATE) !== false;
    const persisted = persistEnabled ? HordeLootApp._persistedState : null;
    const defaults = HordeLootApp.buildDefaultForm();
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
    const totalBudget = computeHordeBudget(this._formForBudget());
    const { coinPileGp, itemBudget } = splitCoinPile(
      totalBudget,
      this._form.pileBias,
    );
    const stats = this._packStats ?? computePackStats([]);
    const candidates = this._countCandidates();
    return {
      form: this._form,
      moduleId: MODULE_ID,
      totalBudgetLabel: formatGp(totalBudget),
      coinPileLabel: formatGp(coinPileGp),
      itemBudgetLabel: formatGp(itemBudget),
      coinPileBreakdown: formatCoinBreakdown(
        coinDenominationBreakdown(coinPileGp),
      ),
      candidateLabel: this._candidateLabel(candidates, stats.totalItems),
      loadingItems: this._loadingItems,

      tierOptions: TIERS.map((tier) => ({
        value: tier,
        label: tierLabel(tier),
        shortLabel: tier.toUpperCase(),
        selected: tier === this._form.tier,
        count: stats.byTier?.[tier] ?? 0,
      })),

      mobSize: this._sliderContext({
        name: "mobSize",
        value: this._form.mobSize,
        range: MOB_SIZE_RANGE,
        presets: null,
        valueLabel: `${this._form.mobSize} mob${this._form.mobSize === 1 ? "" : "s"}`,
      }),
      count: this._sliderContext({
        name: "count",
        value: this._form.count,
        range: COUNT_RANGE,
        presets: null,
        valueLabel: `${this._form.count} item${this._form.count === 1 ? "" : "s"}`,
      }),
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
        count: stats.byRarity?.[rarity] ?? 0,
        selected: this._form.rarities.includes(rarity),
      })),
      lootTypeOptions: LOOT_TYPES.map((lootType) => ({
        value: lootType,
        label: prettyLootType(lootType),
        count: stats.byLootType?.[lootType] ?? 0,
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

    const form = root.querySelector("[data-form='horde-loot']");
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
      HordeLootApp._persistedState = {
        form: { ...this._form },
        lastResult: this._lastResult,
      };
    } else {
      HordeLootApp._persistedState = null;
    }
    HordeLootApp._instance = null;
  }

  /* ------------------- actions ------------------- */

  /** @this {HordeLootApp} */
  static async _onGenerate(_event, _target) {
    await this._generate();
  }

  /** @this {HordeLootApp} */
  static async _onReset(_event, _target) {
    this._form = HordeLootApp.buildDefaultForm();
    await this.render();
  }

  /** @this {HordeLootApp} */
  static async _onClear(_event, _target) {
    this._lastResult = null;
    await this.render();
  }

  /** @this {HordeLootApp} */
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

  /** @this {HordeLootApp} */
  static async _onSendToChat(_event, _target) {
    if (!this._lastResult) {
      ui.notifications?.info("Nothing to send — generate a roll first.");
      return;
    }
    const html = buildHordeChatHtml(this._lastResult);
    const messageData = {
      content: html,
      speaker: ChatMessage.getSpeaker({ alias: "Horde Loot" }),
    };
    const whispers = resolveChatRecipients(
      getSetting(SETTING_KEYS.CHAT_MODE) ?? "public",
    );
    if (whispers !== null) messageData.whisper = whispers;
    try {
      await ChatMessage.create(messageData);
    } catch (error) {
      console.error(`${MODULE_ID} | failed to send horde to chat`, error);
      ui.notifications?.error("Failed to send loot to chat. See console.");
    }
  }

  /** @this {HordeLootApp} */
  static async _onSnap(_event, target) {
    const name = target?.dataset?.target;
    const raw = Number(target?.dataset?.value);
    if (!name || !Number.isFinite(raw)) return;
    this._form = { ...this._form, [name]: raw };
    await this.render();
  }

  /** @this {HordeLootApp} */
  static async _onTierSelect(_event, target) {
    const tier = target?.dataset?.value;
    if (!tier) return;
    this._form = { ...this._form, tier };
    await this.render();
  }

  /** @this {HordeLootApp} */
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

  /** @this {HordeLootApp} */
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
      case "mobSize":
        next.mobSize = clampInt(
          target.value,
          MOB_SIZE_RANGE.min,
          MOB_SIZE_RANGE.max,
          8,
        );
        break;
      case "count":
        next.count = clampInt(
          target.value,
          COUNT_RANGE.min,
          COUNT_RANGE.max,
          6,
        );
        break;
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
    const totalBudget = computeHordeBudget(this._formForBudget());
    const { coinPileGp, itemBudget } = splitCoinPile(
      totalBudget,
      this._form.pileBias,
    );

    setText(root, "[data-total-budget]", formatGp(totalBudget));
    setText(root, "[data-coin-pile-projected]", formatGp(coinPileGp));
    setText(root, "[data-item-budget]", formatGp(itemBudget));
    setText(
      root,
      "[data-coin-breakdown-projected]",
      formatCoinBreakdown(coinDenominationBreakdown(coinPileGp)),
    );

    setText(
      root,
      "[data-readout='mobSize']",
      `${this._form.mobSize} mob${this._form.mobSize === 1 ? "" : "s"}`,
    );
    setText(
      root,
      "[data-readout='count']",
      `${this._form.count} item${this._form.count === 1 ? "" : "s"}`,
    );
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
    return {
      tier: this._form.tier,
      mobSize: this._form.mobSize,
      generosityMultiplier: 1,
    };
  }

  _filterSpec() {
    return {
      tiers: [this._form.tier],
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
    const presetLabel = presets ? titleCase(nearestPreset(value, presets)) : "";
    return {
      name,
      label: SLIDER_LABELS[name] ?? name,
      value,
      min: range.min,
      max: range.max,
      step: range.step,
      valueLabel,
      presetLabel: presetLabel === valueLabel ? "" : presetLabel,
      snaps: presets
        ? Object.entries(presets).map(([key, target]) => ({
            key,
            label: titleCase(key),
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
      const totalBudget = computeHordeBudget(this._formForBudget());
      const { coinPileGp, itemBudget } = splitCoinPile(
        totalBudget,
        this._form.pileBias,
      );
      const items = await this._loadItems();
      const candidates = filterCandidates(items, this._filterSpec());
      const raw =
        itemBudget > 0
          ? rollLoot(candidates, {
              count: this._form.count,
              budgetGp: itemBudget,
              magicBias: this._form.magicBias,
            })
          : { items: [], totalGp: 0, droppedForBudget: 0, warnings: [] };

      const decoratedItems = raw.items.map((entry) => ({
        ...entry,
        rarity: getItemRarity(entry.item) || "common",
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
    const pack = game.packs?.get(PACK_ID);
    if (!pack) {
      ui.notifications?.warn(`${MODULE_ID}: compendium ${PACK_ID} not found.`);
      return [];
    }
    const index = await pack.getIndex({
      fields: [
        "name",
        "img",
        "type",
        "system.rarity",
        "system.price",
        "flags.party-operations",
        "flags.infinity-dnd5e",
      ],
    });
    this._cachedItems = [...index.values()].map((entry) => ({
      ...entry,
      uuid: entry.uuid ?? `Compendium.${PACK_ID}.${entry._id}`,
    }));
    this._cachedItemsAt = Date.now();
    this._packStats = computePackStats(this._cachedItems);
    return this._cachedItems;
  }
}

/* ------------------------------------------------------------------ *
 * Helpers
 * ------------------------------------------------------------------ */

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

function titleCase(value) {
  const raw = String(value ?? "");
  return raw.charAt(0).toUpperCase() + raw.slice(1);
}

function prettyLootType(value) {
  return String(value ?? "")
    .replace(/^loot\./, "")
    .replace(/\./g, " · ")
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

function formatGp(value) {
  const num = Number(value);
  if (!Number.isFinite(num) || num <= 0) return "0 gp";
  return `${Math.round(num).toLocaleString()} gp`;
}

/** Pile-bias label is unique to Horde Loot. */
function formatPileBias(value) {
  const num = Number(value);
  if (!Number.isFinite(num) || Math.abs(num) < 0.025) return "Mixed";
  const pct = Math.round(Math.abs(num) * 100);
  return num > 0 ? `+${pct}% Items` : `+${pct}% Coins`;
}

function formatMagicBias(value) {
  const num = Number(value);
  if (!Number.isFinite(num) || Math.abs(num) < 0.025) return "Neutral";
  const pct = Math.round(Math.abs(num) * 100);
  return num > 0 ? `+${pct}% Magic` : `+${pct}% Mundane`;
}

function buildHordeChatHtml(result) {
  const lines = result.items
    .map((entry) => {
      const link = entry.item?.uuid
        ? `@UUID[${entry.item.uuid}]{${escapeHtml(entry.item.name)}}`
        : escapeHtml(entry.item?.name ?? "?");
      const qty = entry.quantity > 1 ? `${entry.quantity}× ` : "";
      const rarity = escapeHtml(entry.rarity ?? "");
      return `<li><strong>${qty}${link}</strong> <span style="opacity:0.7">— ${rarity} · ${formatGp(entry.gpTotal)}</span></li>`;
    })
    .join("");
  const coinLine = result.coinPileGp
    ? `<p style="margin: 0 0 6px;"><strong>Coin pile:</strong> ${formatGp(result.coinPileGp)}${result.coinBreakdownLabel ? ` <span style="opacity:0.7">(${escapeHtml(result.coinBreakdownLabel)})</span>` : ""}</p>`
    : "";
  return `
<div class="infinity-loot-chat">
  <h3 style="margin: 0 0 4px;">Horde Loot</h3>
  <p style="margin: 0 0 6px; opacity: 0.85;">
    Total: ${formatGp(result.totalGp)}
  </p>
  ${coinLine}
  ${result.items.length ? `<ul style="margin: 0; padding-left: 18px;">${lines}</ul>` : ""}
</div>`;
}

function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
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

function clampInt(raw, min, max, fallback) {
  const value = Number(raw);
  if (!Number.isFinite(value)) return fallback;
  return Math.max(min, Math.min(max, Math.floor(value)));
}

function clampFloat(raw, min, max, fallback) {
  const value = Number(raw);
  if (!Number.isFinite(value)) return fallback;
  return Math.max(min, Math.min(max, value));
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
