/**
 * Infinity D&D5e — PerCreatureLootApp
 *
 * GM-only window for rolling a small bundle of drops *per creature* in
 * an encounter. Build a roster (Goblin, Goblin, Orc Captain), pick a
 * tier per row, and click Roll — each creature gets its own micro-bundle
 * and the totals stack at the bottom.
 *
 * Extends {@link BaseLootApp} for the shared lifecycle; this file owns
 * the roster model and per-creature generation.
 */

import { computeLootBudget } from "./loot/budget.js";
import { promptDistributeItems } from "./loot/distribute.js";
import { SOUND_EVENTS, playModuleSound, playResultSound } from "./audio.js";
import { computePackStats } from "./loot/pack-stats.js";
import { MAGIC_BIAS_RANGE, filterCandidates, rollLoot } from "./loot/roller.js";
import {
  LOOT_TYPES,
  RARITIES,
  TIERS,
  isAmmunitionItem,
  tierWindow,
} from "./loot/tag-vocabulary.js";
import { SETTING_KEYS, getSetting } from "./settings.js";
import { BaseLootApp } from "./loot/loot-app-base.js";
import {
  livePartySize,
  resultImageForEntry,
  setText,
  tierLabel,
  toDistributableEntry,
} from "./loot/loot-app-shared.js";
import {
  clampFloat,
  clampInt,
  escapeHtml,
  formatGp,
  formatMagicBias,
  prettyLootType,
  prettyRarity,
} from "./ui-util.js";

const MODULE_ID = "infinity-dnd5e";
const TEMPLATE_PATH = `modules/${MODULE_ID}/templates/per-creature-loot.hbs`;

const ITEMS_PER_CREATURE_RANGE = Object.freeze({ min: 1, max: 5, step: 1 });
const ROSTER_LIMIT = 30; // soft cap to keep the window manageable

const SLIDER_LABELS = Object.freeze({
  itemsPerCreature: "Items per Creature",
  magicBias: "Magic vs. Mundane",
});

export class PerCreatureLootApp extends BaseLootApp {
  static _instance = null;
  static _persistedState = null;

  static FORM_NAME = "per-creature-loot";
  static TOOL_ID = "per-creature-loot";
  static CHAT_ALIAS = "Per-Creature Loot";
  static SLIDER_LABELS = SLIDER_LABELS;
  static SCROLL_TARGETS = Object.freeze([
    { key: "shell", selector: ".pc-shell" },
    { key: "windowContent", selector: ".window-content" },
  ]);

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
      ...BaseLootApp.sharedActionsExcept("toggleLock"),
      generate: PerCreatureLootApp._onGenerate,
      addCreature: PerCreatureLootApp._onAddCreature,
      addFive: PerCreatureLootApp._onAddFive,
      removeCreature: PerCreatureLootApp._onRemoveCreature,
      clearRoster: PerCreatureLootApp._onClearRoster,
      setCreatureTier: PerCreatureLootApp._onSetCreatureTier,
      rerollCreature: PerCreatureLootApp._onRerollCreature,
      depositHaul: PerCreatureLootApp._onDepositHaul,
    },
    form: { handler: undefined, closeOnSubmit: false, submitOnChange: false },
  };

  static PARTS = {
    body: { template: TEMPLATE_PATH },
  };

  /* ------------------- state ------------------- */

  static buildDefaultForm() {
    const defaultTier = getSetting(SETTING_KEYS.DEFAULT_TIER) ?? "t2";
    return {
      defaultTier,
      itemsPerCreature: 2,
      magicBias: getSetting(SETTING_KEYS.DEFAULT_MAGIC_BIAS) ?? 0,
      rarities: ["common", "uncommon"],
      lootTypes: [],
      minItemGp: 0,
      maxItemGp: 0,
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
  }

  /* ------------------- base hooks ------------------- */

  _primaryGenerate() {
    return this._generateAll();
  }

  _chipUniverse(group) {
    if (group === "rarity") return RARITIES;
    if (group === "lootType") return LOOT_TYPES;
    return null;
  }

  _buildChatHtml(result) {
    return buildPerCreatureChatHtml(result);
  }

  _hasChatResult() {
    return Boolean(this._lastResult?.creatures?.length);
  }

  /** Item lists for the shared item-level handlers — one per creature. */
  _eachEntryList() {
    return (this._lastResult?.creatures ?? []).map((c) => c.items ?? []);
  }

  /** Recompute each creature's total and the grand total after a mutation. */
  _recomputeTotals() {
    if (!this._lastResult?.creatures) return;
    for (const creature of this._lastResult.creatures) {
      const total = (creature.items ?? []).reduce(
        (sum, entry) => sum + (entry.gpTotal ?? 0),
        0,
      );
      creature.totalGp = total;
      creature.totalGpLabel = formatGp(total);
    }
    this._recomputeGrandTotal();
  }

  _snapshotState() {
    return {
      form: { ...this._form, roster: [...this._form.roster] },
      lastResult: this._lastResult,
    };
  }

  /* ------------------- context ------------------- */

  async _prepareContext() {
    const stats = this._packStats ?? computePackStats([]);
    const candidates = this._countCandidates();
    return {
      ...this._basePresetContext(),
      ...this._marketContext(),
      form: this._form,
      moduleId: MODULE_ID,
      loadingItems: this._loadingItems,
      candidateLabel: this._candidateLabel(candidates, stats.totalItems),
      noCandidates: candidates === 0 && !this._loadingItems,
      rosterTotalBudgetLabel: formatGp(this._rosterTotalBudget()),
      rosterFull: this._form.roster.length >= ROSTER_LIMIT,

      tiers: TIERS,

      rosterRows: this._form.roster.map((c) => ({
        id: c.id,
        name: c.name,
        tier: c.tier,
        budgetLabel: formatGp(
          computeLootBudget({
            tier: c.tier,
            scale: "trivial",
            partySize: livePartySize() || 4,
          }),
        ),
        tierOptions: TIERS.map((tier) => ({
          value: tier,
          // Show the level band (e.g. "T2 — Lvl 5–10") for parity with the
          // other two tools, not a bare "T2".
          label: tierLabel(tier),
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
        label: prettyRarity(rarity),
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
    await this._renderPreservingScroll();
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
    await this._renderPreservingScroll();
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
    if (this._lastResult?.creatures) {
      this._lastResult = {
        ...this._lastResult,
        creatures: this._lastResult.creatures.filter((c) => c.id !== id),
      };
      this._recomputeGrandTotal();
    }
    await this._renderPreservingScroll();
  }

  /** @this {PerCreatureLootApp} */
  static async _onClearRoster(_event, _target) {
    this._form = { ...this._form, roster: [] };
    this._lastResult = null;
    playModuleSound(SOUND_EVENTS.CLEAR_RESET);
    await this._renderPreservingScroll();
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
    await this._renderPreservingScroll();
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
    await this._renderPreservingScroll();
    playResultSound({ items: rolled.items }, { kind: "per-creature" });
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
      case "minItemGp":
        next.minItemGp = clampInt(target.value, 0, Number.MAX_SAFE_INTEGER, 0);
        break;
      case "maxItemGp":
        next.maxItemGp = clampInt(target.value, 0, Number.MAX_SAFE_INTEGER, 0);
        break;
      case "rarity":
        next.rarities = this._readChipGroup("rarity");
        break;
      case "lootType":
        next.lootTypes = this._readChipGroup("lootType");
        break;
      case "creatureName":
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
    setText(root, "[data-value-range]", this._valueRangeLabel());
    setText(root, "[data-roster-budget]", formatGp(this._rosterTotalBudget()));
    this._syncSnapStates(root, "magicBias", this._form.magicBias);
  }

  /** Read a chip group's checked values off the live form. */
  _readChipGroup(group) {
    if (!this.element) return [];
    return [
      ...this.element.querySelectorAll(
        `input[type='checkbox'][name='${group}']:checked`,
      ),
    ].map((el) => el.value);
  }

  _filterSpec() {
    return {
      rarities: this._form.rarities,
      lootTypes: this._form.lootTypes,
      requireEligible: true,
      ...this._valueFilter(),
    };
  }

  _rosterTotalBudget() {
    const partySize = livePartySize() || 4;
    return this._form.roster.reduce(
      (sum, c) =>
        sum + computeLootBudget({ tier: c.tier, scale: "trivial", partySize }),
      0,
    );
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
    // Make a fresh roll undoable (protects a hand-edited roster haul from Enter/R).
    if (this._lastResult) this._pushUndo();
    const needsLoad = !this._isItemCacheFresh();
    if (needsLoad) {
      this._loadingItems = true;
      playModuleSound(SOUND_EVENTS.LOADING_SHIMMER);
      await this._renderPreservingScroll();
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
      await this._renderPreservingScroll();
      if (generatedResult) {
        playResultSound(generatedResult, { kind: "per-creature" });
        this._recordRoll(generatedResult);
      }
    }
  }

  /** Roll a single creature's bundle and return a decorated entry. */
  _rollForCreature(creature, items) {
    const filter = {
      ...this._filterSpec(),
      tiers: tierWindow(creature.tier),
    };
    const candidates = filterCandidates(items, filter);
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
    const decoratedItems = raw.items.map((entry) => this._decorateEntry(entry));
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
}

/* ------------------------------------------------------------------ *
 * Helpers
 * ------------------------------------------------------------------ */

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
