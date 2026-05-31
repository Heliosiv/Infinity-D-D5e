/**
 * Infinity D&D5e — PerCreatureLootApp
 *
 * GM-only window for rolling a small bundle of drops *per creature*
 * in an encounter. Concept: build a roster (Goblin, Goblin, Orc Captain,
 * Hobgoblin), pick a tier per row, and click Roll — each creature gets
 * its own micro-bundle and the totals stack at the bottom.
 *
 * Differs from Horde Loot:
 *  - Loot is grouped per-creature so the GM can hand specific drops to
 *    specific bodies in the fiction.
 *  - No coin pile — that's a Horde concept.
 *  - Lock + reroll is *per creature*; the GM can iterate one creature
 *    without disturbing the rest of the roster.
 *
 * Reuses the existing roller + computeLootBudget (trivial scale) for
 * each creature's share.
 */

import { computeLootBudget, nearestPreset } from "./loot/budget.js";
import { promptDistributeItems } from "./loot/distribute.js";
import { SOUND_EVENTS, playModuleSound, playResultSound } from "./audio.js";
import { loadCompendiumItems } from "./loot/pack.js";
import { computePackStats } from "./loot/pack-stats.js";
import { MAGIC_BIAS_RANGE, filterCandidates, rollLoot } from "./loot/roller.js";
import {
  LOOT_TYPES,
  RARITIES,
  TIERS,
  getItemRarity,
  isAmmunitionItem,
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
const TEMPLATE_PATH = `modules/${MODULE_ID}/templates/per-creature-loot.hbs`;
const FALLBACK_ITEM_IMAGE = "icons/svg/item-bag.svg";

const ITEMS_PER_CREATURE_RANGE = Object.freeze({ min: 1, max: 5, step: 1 });
const ROSTER_LIMIT = 30; // soft cap to keep the window from becoming unmanageable

const SLIDER_LABELS = Object.freeze({
  itemsPerCreature: "Items per Creature",
  magicBias: "Magic Bias",
});

/* ------------------------------------------------------------------ *
 * Application V2 host
 * ------------------------------------------------------------------ */

const { ApplicationV2, HandlebarsApplicationMixin } = foundry.applications.api;

export class PerCreatureLootApp extends HandlebarsApplicationMixin(
  ApplicationV2,
) {
  static _instance = null;
  static _persistedState = null;

  static DEFAULT_OPTIONS = {
    id: "infinity-dnd5e-per-creature-loot",
    tag: "section",
    classes: ["infinity-dnd5e", "per-creature-loot"],
    window: {
      title: "Infinity D&D5e — Per-Creature Loot",
      icon: "fa-solid fa-skull",
      resizable: true,
    },
    position: { width: 820, height: 800 },
    actions: {
      generate: PerCreatureLootApp._onGenerate,
      reset: PerCreatureLootApp._onReset,
      clear: PerCreatureLootApp._onClear,
      addCreature: PerCreatureLootApp._onAddCreature,
      addFive: PerCreatureLootApp._onAddFive,
      removeCreature: PerCreatureLootApp._onRemoveCreature,
      clearRoster: PerCreatureLootApp._onClearRoster,
      setCreatureTier: PerCreatureLootApp._onSetCreatureTier,
      rerollCreature: PerCreatureLootApp._onRerollCreature,
      openItem: PerCreatureLootApp._onOpenItem,
      sendToChat: PerCreatureLootApp._onSendToChat,
      depositHaul: PerCreatureLootApp._onDepositHaul,
      snap: PerCreatureLootApp._onSnap,
      chipAll: PerCreatureLootApp._onChipAll,
      chipNone: PerCreatureLootApp._onChipNone,
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
    playModuleSound(SOUND_EVENTS.UI_OPEN);
    if (!PerCreatureLootApp._instance)
      PerCreatureLootApp._instance = new PerCreatureLootApp();
    if (PerCreatureLootApp._instance.rendered)
      PerCreatureLootApp._instance.bringToFront();
    else PerCreatureLootApp._instance.render(true);
    return PerCreatureLootApp._instance;
  }

  /* ------------------- state ------------------- */

  static buildDefaultForm() {
    const defaultTier = getSetting(SETTING_KEYS.DEFAULT_TIER) ?? "t2";
    return {
      defaultTier,
      itemsPerCreature: 2,
      magicBias: getSetting(SETTING_KEYS.DEFAULT_MAGIC_BIAS) ?? 0,
      rarities: ["common", "uncommon"],
      lootTypes: [],
      roster: [
        makeCreature({ name: "Creature 1", tier: defaultTier }),
        makeCreature({ name: "Creature 2", tier: defaultTier }),
      ],
    };
  }

  constructor(options = {}) {
    super(options);
    const persistEnabled = getSetting(SETTING_KEYS.PERSIST_STATE) !== false;
    const persisted = persistEnabled
      ? PerCreatureLootApp._persistedState
      : null;
    const defaults = PerCreatureLootApp.buildDefaultForm();
    this._form = persisted?.form
      ? {
          ...defaults,
          ...persisted.form,
          roster: persisted.form.roster ?? defaults.roster,
        }
      : defaults;
    this._lastResult = persisted?.lastResult ?? null;
    this._loadingItems = false;
    this._cachedItems = null;
    this._cachedItemsAt = 0;
    this._packStats = null;
  }

  /* ------------------- context ------------------- */

  async _prepareContext() {
    const stats = this._packStats ?? computePackStats([]);
    const candidates = this._countCandidates();
    return {
      form: this._form,
      moduleId: MODULE_ID,
      loadingItems: this._loadingItems,
      candidateLabel: this._candidateLabel(candidates, stats.totalItems),
      rosterTotalBudgetLabel: formatGp(this._rosterTotalBudget()),
      rosterFull: this._form.roster.length >= ROSTER_LIMIT,

      tiers: TIERS,

      rosterRows: this._form.roster.map((c) => ({
        id: c.id,
        name: c.name,
        tier: c.tier,
        budgetLabel: formatGp(
          computeLootBudget({ tier: c.tier, scale: "trivial", partySize: 4 }),
        ),
        tierOptions: TIERS.map((tier) => ({
          value: tier,
          label: tier.toUpperCase(),
          selected: tier === c.tier,
        })),
      })),

      itemsPerCreature: this._sliderContext({
        name: "itemsPerCreature",
        value: this._form.itemsPerCreature,
        range: ITEMS_PER_CREATURE_RANGE,
        presets: null,
        valueLabel: `${this._form.itemsPerCreature} per creature`,
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

      hasResult: Boolean(this._lastResult?.creatures?.length),
      result: resultContext(this._lastResult),
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

    const form = root.querySelector("[data-form='per-creature-loot']");
    if (form) {
      form.addEventListener("input", (event) => this._onFormInput(event));
      form.addEventListener("change", (event) => this._onFormInput(event));
    }

    for (const image of root.querySelectorAll("[data-result-image]")) {
      image.addEventListener("error", onResultImageError, { once: true });
      if (image.complete && image.naturalWidth === 0) {
        onResultImageError({ currentTarget: image });
      }
    }

    if (!this._packStats && !this._loadingItems) {
      this._primePackStats();
    }
  }

  _onClose(options) {
    super._onClose?.(options);
    if (getSetting(SETTING_KEYS.PERSIST_STATE) !== false) {
      PerCreatureLootApp._persistedState = {
        form: { ...this._form, roster: [...this._form.roster] },
        lastResult: this._lastResult,
      };
    } else {
      PerCreatureLootApp._persistedState = null;
    }
    PerCreatureLootApp._instance = null;
  }

  /* ------------------- actions ------------------- */

  /** @this {PerCreatureLootApp} */
  static async _onGenerate(_event, _target) {
    if (this._loadingItems) return;
    if (this._form.roster.length > 0) {
      playModuleSound(SOUND_EVENTS.ROLL_START);
    }
    await this._generateAll();
  }

  /** @this {PerCreatureLootApp} */
  static _onReset(_event, _target) {
    this._form = PerCreatureLootApp.buildDefaultForm();
    playModuleSound(SOUND_EVENTS.CLEAR_RESET);
    renderAfterAction(() => this.render(), "reset");
  }

  /** @this {PerCreatureLootApp} */
  static async _onClear(_event, _target) {
    this._lastResult = null;
    playModuleSound(SOUND_EVENTS.CLEAR_RESET);
    await this.render();
  }

  /** @this {PerCreatureLootApp} */
  static async _onAddCreature(_event, _target) {
    if (this._form.roster.length >= ROSTER_LIMIT) {
      playModuleSound(SOUND_EVENTS.WARNING_MUTED);
      return;
    }
    const next = makeCreature({
      name: `Creature ${this._form.roster.length + 1}`,
      tier: this._form.defaultTier,
    });
    this._form = { ...this._form, roster: [...this._form.roster, next] };
    playModuleSound(SOUND_EVENTS.ROSTER_ADD);
    await this.render();
  }

  /** @this {PerCreatureLootApp} */
  static async _onAddFive(_event, _target) {
    const remaining = ROSTER_LIMIT - this._form.roster.length;
    if (remaining <= 0) {
      playModuleSound(SOUND_EVENTS.WARNING_MUTED);
      return;
    }
    const adds = [];
    for (let i = 0; i < Math.min(5, remaining); i += 1) {
      adds.push(
        makeCreature({
          name: `Creature ${this._form.roster.length + i + 1}`,
          tier: this._form.defaultTier,
        }),
      );
    }
    this._form = { ...this._form, roster: [...this._form.roster, ...adds] };
    playModuleSound(SOUND_EVENTS.ROSTER_ADD);
    await this.render();
  }

  /** @this {PerCreatureLootApp} */
  static async _onRemoveCreature(_event, target) {
    const id = target?.dataset?.creatureId;
    if (!id) return;
    this._form = {
      ...this._form,
      roster: this._form.roster.filter((c) => c.id !== id),
    };
    playModuleSound(SOUND_EVENTS.ROSTER_REMOVE);
    // Also drop any result for this creature so the UI stays consistent.
    if (this._lastResult?.creatures) {
      this._lastResult = {
        ...this._lastResult,
        creatures: this._lastResult.creatures.filter((c) => c.id !== id),
      };
      this._recomputeGrandTotal();
    }
    await this.render();
  }

  /** @this {PerCreatureLootApp} */
  static async _onClearRoster(_event, _target) {
    this._form = { ...this._form, roster: [] };
    this._lastResult = null;
    playModuleSound(SOUND_EVENTS.CLEAR_RESET);
    await this.render();
  }

  /** @this {PerCreatureLootApp} */
  static async _onSetCreatureTier(_event, target) {
    const id = target?.dataset?.creatureId;
    const tier = target?.dataset?.value;
    if (!id || !tier) return;
    this._form = {
      ...this._form,
      roster: this._form.roster.map((c) => (c.id === id ? { ...c, tier } : c)),
    };
    await this.render();
  }

  /** @this {PerCreatureLootApp} */
  static async _onRerollCreature(_event, target) {
    const id = target?.dataset?.creatureId;
    if (!id) return;
    const creature = this._form.roster.find((c) => c.id === id);
    if (!creature) {
      playModuleSound(SOUND_EVENTS.WARNING_MUTED);
      return;
    }
    if (this._loadingItems) return;

    playModuleSound(SOUND_EVENTS.ROLL_START);
    const items = await this._loadItems();
    const rolled = this._rollForCreature(creature, items);
    this._lastResult = {
      ...(this._lastResult ?? {
        creatures: [],
        grandTotal: 0,
        grandTotalLabel: formatGp(0),
      }),
      creatures: (this._lastResult?.creatures ?? []).some((c) => c.id === id)
        ? this._lastResult.creatures.map((c) => (c.id === id ? rolled : c))
        : [...(this._lastResult?.creatures ?? []), rolled],
    };
    this._recomputeGrandTotal();
    await this.render();
    playResultSound({ items: rolled.items }, { kind: "per-creature" });
  }

  /** @this {PerCreatureLootApp} */
  static async _onOpenItem(event, target) {
    const uuid = target?.dataset?.uuid;
    if (!uuid) return;
    try {
      const doc = await fromUuid(uuid);
      if (doc?.sheet) {
        doc.sheet.render(true);
        playModuleSound(SOUND_EVENTS.ITEM_OPEN);
      }
    } catch (error) {
      console.warn(`${MODULE_ID} | failed to open item`, { uuid, error });
    }
  }

  /** @this {PerCreatureLootApp} */
  static async _onSendToChat(_event, _target) {
    if (!this._lastResult?.creatures?.length) {
      playModuleSound(SOUND_EVENTS.WARNING_MUTED);
      ui.notifications?.info("Nothing to send — roll the roster first.");
      return;
    }
    const html = buildPerCreatureChatHtml(this._lastResult);
    const messageData = {
      content: html,
      speaker: ChatMessage.getSpeaker({ alias: "Per-Creature Loot" }),
    };
    const whispers = resolveChatRecipients(
      getSetting(SETTING_KEYS.CHAT_MODE) ?? "public",
    );
    if (whispers !== null) messageData.whisper = whispers;
    try {
      await ChatMessage.create(messageData);
      playModuleSound(SOUND_EVENTS.CHAT_SEND);
    } catch (error) {
      playModuleSound(SOUND_EVENTS.WARNING_MUTED);
      console.error(`${MODULE_ID} | failed to send loot to chat`, error);
      ui.notifications?.error("Failed to send loot to chat. See console.");
    }
  }

  /** @this {PerCreatureLootApp} */
  static async _onDepositHaul(_event, _target) {
    if (!this._lastResult?.creatures?.length) {
      playModuleSound(SOUND_EVENTS.WARNING_MUTED);
      ui.notifications?.info("Nothing to deposit — roll the roster first.");
      return;
    }
    const items = this._lastResult.creatures
      .flatMap((creature) => creature.items ?? [])
      .map(toDistributableEntry)
      .filter(Boolean);
    if (items.length === 0) {
      playModuleSound(SOUND_EVENTS.WARNING_MUTED);
      ui.notifications?.info("No drops to deposit.");
      return;
    }
    const result = await promptDistributeItems(items, {
      title: `Deposit All Drops (${items.length} items)`,
      hint: "Choose one character to receive every creature's drops.",
    });
    if (result) playModuleSound(SOUND_EVENTS.DEPOSIT);
  }

  /** @this {PerCreatureLootApp} */
  static async _onSnap(_event, target) {
    const name = target?.dataset?.target;
    const raw = Number(target?.dataset?.value);
    if (!name || !Number.isFinite(raw)) return;
    this._form = { ...this._form, [name]: raw };
    await this.render();
  }

  /** @this {PerCreatureLootApp} */
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

  /** @this {PerCreatureLootApp} */
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
      case "itemsPerCreature":
        next.itemsPerCreature = clampInt(
          target.value,
          ITEMS_PER_CREATURE_RANGE.min,
          ITEMS_PER_CREATURE_RANGE.max,
          2,
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
      case "creatureName":
        // Per-row text inputs carry their id on a data attribute.
        if (target.dataset?.creatureId) {
          next.roster = this._form.roster.map((c) =>
            c.id === target.dataset.creatureId
              ? { ...c, name: target.value }
              : c,
          );
        }
        break;
      default:
        return;
    }
    this._form = next;
    if (target.type === "checkbox") {
      target
        .closest(".lf-chip")
        ?.classList.toggle("is-checked", target.checked);
    }
    this._patchLiveReadouts();
  }

  _patchLiveReadouts() {
    if (!this.element) return;
    const root = this.element;
    setText(
      root,
      "[data-readout='itemsPerCreature']",
      `${this._form.itemsPerCreature} per creature`,
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
    setText(root, "[data-roster-budget]", formatGp(this._rosterTotalBudget()));
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

  _filterSpec() {
    return {
      rarities: this._form.rarities,
      lootTypes: this._form.lootTypes,
      requireEligible: true,
    };
  }

  _countCandidates() {
    if (!this._cachedItems) return 0;
    // Per-creature filter spec doesn't pin a tier (each creature
    // contributes its own), so candidate count reflects the rarity +
    // loot-type filters alone.
    return filterCandidates(this._cachedItems, this._filterSpec()).length;
  }

  _candidateLabel(count, totalItems) {
    if (!this._packStats) return "—";
    if (count === 0) {
      return `0 items match · pack has ${totalItems.toLocaleString()}`;
    }
    return `${count.toLocaleString()} item${count === 1 ? "" : "s"} match current filters`;
  }

  _rosterTotalBudget() {
    const partySize = livePartySize() || 4;
    return this._form.roster.reduce(
      (sum, c) =>
        sum + computeLootBudget({ tier: c.tier, scale: "trivial", partySize }),
      0,
    );
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

  async _generateAll() {
    if (this._loadingItems) return;
    let generatedResult = null;
    if (!this._form.roster.length) {
      playModuleSound(SOUND_EVENTS.WARNING_MUTED);
      ui.notifications?.info(
        "Add at least one creature to the roster before rolling.",
      );
      return;
    }
    const needsLoad = !this._isItemCacheFresh();
    if (needsLoad) {
      this._loadingItems = true;
      playModuleSound(SOUND_EVENTS.LOADING_SHIMMER);
      await this.render();
    }
    try {
      const items = await this._loadItems();
      const creatures = this._form.roster.map((c) =>
        this._rollForCreature(c, items),
      );
      const grandTotal = creatures.reduce((sum, c) => sum + c.totalGp, 0);
      this._lastResult = {
        creatures,
        grandTotal,
        grandTotalLabel: formatGp(grandTotal),
      };
      generatedResult = this._lastResult;
    } finally {
      this._loadingItems = false;
      await this.render();
      if (generatedResult) {
        playResultSound(generatedResult, { kind: "per-creature" });
      }
    }
  }

  /** Roll a single creature's bundle and return a decorated entry. */
  _rollForCreature(creature, items) {
    // Per-Creature uses a tier window — the creature's tier AND one tier
    // below — so a T2 mook can also drop T1 commons (arrows, daggers,
    // torches). Without this, the candidate pool is restricted to that
    // tier's curated magic items and corpses never carry mundane junk.
    const filter = {
      ...this._filterSpec(),
      tiers: tierWindow(creature.tier),
    };
    const candidates = filterCandidates(items, filter);
    // Auto-detect party size from the live player count so a 6-PC party
    // gets proportionally bigger per-corpse drops than a 2-PC party.
    // Falls back to 4 (the canonical baseline) when no live count is
    // available — e.g. during initial load or in tests.
    const partySize = livePartySize() || 4;
    const budget = computeLootBudget({
      tier: creature.tier,
      scale: "trivial",
      partySize,
    });
    const raw = rollLoot(candidates, {
      count: this._form.itemsPerCreature,
      budgetGp: budget,
      magicBias: this._form.magicBias,
    });
    const decoratedItems = raw.items.map((entry) => ({
      ...entry,
      rarity: getItemRarity(entry.item) || "common",
      quantityLabel:
        entry.quantity > 1 || isAmmunitionItem(entry.item)
          ? `×${entry.quantity} · `
          : "",
      gpTotalLabel: formatGp(entry.gpTotal),
    }));
    return {
      id: creature.id,
      name: creature.name,
      tier: creature.tier,
      tierLabel: creature.tier.toUpperCase(),
      items: decoratedItems,
      totalGp: raw.totalGp,
      totalGpLabel: formatGp(raw.totalGp),
      budgetLabel: formatGp(budget),
      warnings: raw.warnings ?? [],
    };
  }

  _recomputeGrandTotal() {
    if (!this._lastResult) return;
    const grandTotal = this._lastResult.creatures.reduce(
      (sum, c) => sum + c.totalGp,
      0,
    );
    this._lastResult.grandTotal = grandTotal;
    this._lastResult.grandTotalLabel = formatGp(grandTotal);
  }

  async _primePackStats() {
    this._loadingItems = true;
    playModuleSound(SOUND_EVENTS.LOADING_SHIMMER);
    try {
      await this._loadItems();
    } catch (error) {
      this._packStats = computePackStats([]);
      console.error(
        `${MODULE_ID} | failed to preload per-creature pack stats`,
        error,
      );
      ui.notifications?.warn(
        "Infinity D&D5e could not preload per-creature pack stats. Rolls can be retried after the compendium is available.",
      );
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
 * Map a per-creature result entry to the distribute helper's accepted
 * shape, preserving the rolled stack quantity. Per-creature rolls never
 * use art variants, so entries are plain UUID-bearing compendium items;
 * the `itemData` branch is kept for symmetry with the other tools.
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

function resultContext(result) {
  if (!result) return null;
  return {
    ...result,
    creatures: (result.creatures ?? []).map((creature) => ({
      ...creature,
      items: (creature.items ?? []).map((entry) => ({
        ...entry,
        imageSrc: resultImageForEntry(entry),
      })),
    })),
  };
}

function resultImageForEntry(entry) {
  const image = String(
    entry?.imageSrc ?? entry?.itemData?.img ?? entry?.item?.img ?? "",
  ).trim();
  if (!image) return FALLBACK_ITEM_IMAGE;
  if (image.startsWith("assets/item-art/")) {
    return `modules/${MODULE_ID}/${image}`;
  }
  return image;
}

function onResultImageError(event) {
  const image = event.currentTarget;
  if (!image || image.dataset.fallbackApplied === "true") return;
  const fallbackSrc = image.dataset.fallbackSrc || FALLBACK_ITEM_IMAGE;
  image.dataset.fallbackApplied = "true";
  image.classList.add("is-fallback");
  if (image.getAttribute("src") !== fallbackSrc) image.src = fallbackSrc;
}

function renderAfterAction(callback, action) {
  try {
    const result = callback();
    if (typeof result?.catch === "function") {
      result.catch((error) =>
        console.warn(`${MODULE_ID} | ${action} render failed`, error),
      );
    }
  } catch (error) {
    console.warn(`${MODULE_ID} | ${action} render failed`, error);
  }
}

/**
 * Read the live player-character count from Foundry. Returns 0 when the
 * game isn't initialized (tests) so callers can fall back gracefully.
 * Mirrors the same helper in app.js — kept module-local to avoid coupling
 * pure ui-util.js to Foundry globals.
 */
function livePartySize() {
  const users = globalThis.game?.users;
  if (!users) return 0;
  let count = 0;
  for (const user of users.values?.() ?? users) {
    if (user?.character && user?.active !== false) count += 1;
  }
  return count;
}

function makeCreature({ name, tier }) {
  return {
    id:
      globalThis.crypto?.randomUUID?.() ??
      `c-${Math.random().toString(36).slice(2, 10)}`,
    name: String(name ?? "Creature"),
    tier: String(tier ?? "t2"),
  };
}

function buildPerCreatureChatHtml(result) {
  const sections = result.creatures
    .map((c) => {
      const lines = c.items
        .map((entry) => {
          const link = entry.item?.uuid
            ? `@UUID[${entry.item.uuid}]{${escapeHtml(entry.item.name)}}`
            : escapeHtml(entry.item?.name ?? "?");
          const qty =
            entry.quantity > 1 || isAmmunitionItem(entry.item)
              ? `${entry.quantity}× `
              : "";
          const rarity = escapeHtml(entry.rarity ?? "");
          return `<li>${qty}${link} <span style="opacity:0.7">— ${rarity} · ${formatGp(entry.gpTotal)}</span></li>`;
        })
        .join("");
      const head = `<p style="margin: 6px 0 2px;"><strong>${escapeHtml(c.name)}</strong> <span style="opacity:0.7">— ${escapeHtml(c.tierLabel)} · ${formatGp(c.totalGp)}</span></p>`;
      const body = c.items.length
        ? `<ul style="margin: 0; padding-left: 18px;">${lines}</ul>`
        : `<p style="margin: 0 0 4px; opacity: 0.65;">No drops.</p>`;
      return head + body;
    })
    .join("");
  return `
<div class="infinity-loot-chat">
  <h3 style="margin: 0 0 4px;">Per-Creature Loot</h3>
  <p style="margin: 0 0 6px; opacity: 0.85;">
    Total across ${result.creatures.length} creature(s): ${formatGp(result.grandTotal)}
  </p>
  ${sections}
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
