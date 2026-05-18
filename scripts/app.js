/**
 * Infinity D&D5e — LootForgeApp
 *
 * Single GM-only window:
 * - Form controls (tier, scale, generosity, rarity, count, loot types)
 * - "Generate" button rolls a bundle against the bundled compendium
 * - Results list shows name, image, rarity, gp value, source link
 *
 * Built on Foundry's ApplicationV2 + HandlebarsApplicationMixin so
 * we get free part-based re-rendering, action wiring, and form
 * serialization. No business logic lives here — the roller and
 * budget modules are pure functions and stay testable in node.
 */

import { computeLootBudget, getBudgetCurves } from "./loot/budget.js";
import { filterCandidates, rollLoot } from "./loot/roller.js";
import {
  LOOT_TYPES,
  RARITIES,
  TIERS,
  getItemRarity,
} from "./loot/tag-vocabulary.js";

const MODULE_ID = "infinity-dnd5e";
const PACK_ID = `${MODULE_ID}.infinity-dnd5e-items`;
const TEMPLATE_PATH = `modules/${MODULE_ID}/templates/loot-forge.hbs`;

/* ------------------------------------------------------------------ *
 * Application V2 host
 * ------------------------------------------------------------------ */

const { ApplicationV2, HandlebarsApplicationMixin } = foundry.applications.api;

export class LootForgeApp extends HandlebarsApplicationMixin(ApplicationV2) {
  /** Single shared instance — `open()` reuses an existing window. */
  static _instance = null;

  static DEFAULT_OPTIONS = {
    id: "infinity-dnd5e-loot-forge",
    tag: "section",
    classes: ["infinity-dnd5e", "loot-forge"],
    window: {
      title: "Infinity D&D5e — Loot Forge",
      icon: "fa-solid fa-coins",
      resizable: true,
    },
    position: { width: 720, height: 720 },
    actions: {
      generate: LootForgeApp._onGenerate,
      reset: LootForgeApp._onReset,
      openItem: LootForgeApp._onOpenItem,
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

  /** Opens (or focuses) the singleton instance. */
  static open() {
    if (!LootForgeApp._instance) LootForgeApp._instance = new LootForgeApp();
    if (LootForgeApp._instance.rendered) LootForgeApp._instance.bringToFront();
    else LootForgeApp._instance.render(true);
    return LootForgeApp._instance;
  }

  /* ------------------- state ------------------- */

  /** Form defaults — also reset to these via the Reset button. */
  static DEFAULT_FORM = Object.freeze({
    tier: "t2",
    scale: "standard",
    generosity: "balanced",
    partySize: 4,
    count: 6,
    budgetOverride: 0,
    artVariants: true,
    rarities: ["uncommon", "rare"],
    lootTypes: [], // empty = all types
  });

  constructor(options = {}) {
    super(options);
    this._form = { ...LootForgeApp.DEFAULT_FORM };
    this._lastResult = null;
    this._loadingItems = false;
    this._cachedItems = null;
    this._cachedItemsAt = 0;
  }

  /* ------------------- context ------------------- */

  async _prepareContext() {
    const curves = getBudgetCurves();
    const projectedBudget = computeLootBudget(this._formForBudget());
    return {
      form: this._form,
      tierOptions: TIERS.map((tier) => ({
        value: tier,
        label: tierLabel(tier),
        selected: tier === this._form.tier,
      })),
      scaleOptions: Object.keys(curves.scales).map((key) => ({
        value: key,
        label: titleCase(key),
        selected: key === this._form.scale,
      })),
      generosityOptions: Object.keys(curves.generosity).map((key) => ({
        value: key,
        label: titleCase(key),
        selected: key === this._form.generosity,
      })),
      rarityOptions: RARITIES.map((rarity) => ({
        value: rarity,
        label: titleCase(rarity),
        selected: this._form.rarities.includes(rarity),
      })),
      lootTypeOptions: LOOT_TYPES.map((lootType) => ({
        value: lootType,
        label: prettyLootType(lootType),
        selected: this._form.lootTypes.includes(lootType),
      })),
      projectedBudget,
      hasResult: Boolean(this._lastResult && this._lastResult.items.length > 0),
      result: this._lastResult,
      loadingItems: this._loadingItems,
      moduleId: MODULE_ID,
    };
  }

  /* ------------------- lifecycle ------------------- */

  _onRender(context, options) {
    super._onRender?.(context, options);
    const root = this.element;
    if (!root) return;

    // Wire the form so changes update `_form` without triggering
    // a re-render (only the projected-budget label is dynamic).
    const form = root.querySelector("[data-form='loot-forge']");
    if (form) {
      form.addEventListener("input", (event) => this._onFormInput(event));
      form.addEventListener("change", (event) => this._onFormInput(event));
    }
  }

  _onClose(options) {
    super._onClose?.(options);
    LootForgeApp._instance = null;
  }

  /* ------------------- actions ------------------- */

  /** @this {LootForgeApp} */
  static async _onGenerate(_event, _target) {
    await this._generate();
  }

  /** @this {LootForgeApp} */
  static async _onReset(_event, _target) {
    this._form = { ...LootForgeApp.DEFAULT_FORM };
    this._lastResult = null;
    await this.render();
  }

  /** @this {LootForgeApp} */
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

  /* ------------------- form handling ------------------- */

  _onFormInput(event) {
    const target = event.target;
    if (!target?.name) return;
    const name = target.name;
    const next = { ...this._form };

    switch (name) {
      case "tier":
      case "scale":
      case "generosity":
        next[name] = target.value;
        break;
      case "partySize":
      case "count":
      case "budgetOverride":
        next[name] = Math.max(0, Math.floor(Number(target.value) || 0));
        break;
      case "artVariants":
        next.artVariants = Boolean(target.checked);
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
    this._updateProjectedBudgetLabel();
  }

  _updateProjectedBudgetLabel() {
    const label = this.element?.querySelector("[data-projected-budget]");
    if (!label) return;
    label.textContent = `${computeLootBudget(this._formForBudget()).toLocaleString()} gp`;
  }

  _formForBudget() {
    return {
      tier: this._form.tier,
      scale: this._form.scale,
      generosity: this._form.generosity,
      partySize: this._form.partySize,
      override: this._form.budgetOverride,
    };
  }

  /* ------------------- generation pipeline ------------------- */

  async _generate() {
    const budget = computeLootBudget(this._formForBudget());
    const items = await this._loadItems();
    const candidates = filterCandidates(items, {
      tiers: [this._form.tier],
      rarities: this._form.rarities,
      lootTypes: this._form.lootTypes,
      requireEligible: true,
    });
    const raw = rollLoot(candidates, {
      count: this._form.count,
      budgetGp: budget,
      artVariants: this._form.artVariants,
    });
    // Decorate each entry with template-ready fields so the .hbs
    // stays free of Handlebars helpers / data-shape gymnastics.
    this._lastResult = {
      ...raw,
      items: raw.items.map((entry) => ({
        ...entry,
        displayName: entry.displayName || entry.item.name,
        variantSummary: entry.variant?.summary ?? "",
        sourceLabel: entry.variant ? `Base: ${entry.variant.baseName}` : "",
        valueLabel: entry.valueLabel ?? "",
        rarity: getItemRarity(entry.item) || "common",
        quantityLabel: entry.quantity > 1 ? `×${entry.quantity} · ` : "",
      })),
    };
    await this.render();
  }

  /**
   * Load the bundled compendium index once and cache it per session.
   * `getIndex` is cheaper than `getDocuments` — we only need the
   * fields the roller and the result card actually read.
   */
  async _loadItems() {
    const now = Date.now();
    const ttlMs = 5 * 60 * 1000;
    if (this._cachedItems && now - this._cachedItemsAt < ttlMs) {
      return this._cachedItems;
    }
    this._loadingItems = true;
    try {
      const pack = game.packs?.get(PACK_ID);
      if (!pack) {
        ui.notifications?.warn(
          `${MODULE_ID}: compendium ${PACK_ID} not found.`,
        );
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
      this._cachedItemsAt = now;
      return this._cachedItems;
    } finally {
      this._loadingItems = false;
    }
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
    t4: "T4 — Lvl 17+",
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

/** Collect every checked input[name="<group>"] inside a form. */
function readMultiCheckGroup(root, group) {
  if (!root) return [];
  return [
    ...root.querySelectorAll(`input[type='checkbox'][name='${group}']:checked`),
  ].map((el) => el.value);
}
