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
import {
  beginDragFromResult,
  promptDistributeItems,
} from "./loot/distribute.js";
import { loadCompendiumItems } from "./loot/pack.js";
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
const SETTING_FORM_STATE = "lootForgeFormState";

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
      distributeOne: LootForgeApp._onDistributeOne,
      distributeBundle: LootForgeApp._onDistributeBundle,
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
    rarities: ["uncommon", "rare"],
    lootTypes: [], // empty = all types
    postToChat: false,
  });

  constructor(options = {}) {
    super(options);
    this._form = LootForgeApp._restoreForm();
    this._lastResult = null;
    this._loadingItems = false;
    this._cachedItems = null;
    this._cachedItemsAt = 0;
  }

  /**
   * Merge the persisted form state (if any) over the defaults so a
   * stale persisted shape can't pollute the live form when keys are
   * added in later versions.
   */
  static _restoreForm() {
    const fallback = { ...LootForgeApp.DEFAULT_FORM };
    try {
      const stored = game.settings?.get(MODULE_ID, SETTING_FORM_STATE);
      if (!stored || typeof stored !== "object") return fallback;
      const merged = { ...fallback };
      for (const key of Object.keys(fallback)) {
        if (stored[key] === undefined) continue;
        if (Array.isArray(fallback[key])) {
          merged[key] = Array.isArray(stored[key])
            ? [...stored[key]]
            : fallback[key];
        } else {
          merged[key] = stored[key];
        }
      }
      return merged;
    } catch (error) {
      console.warn(`${MODULE_ID} | could not restore form state`, error);
      return fallback;
    }
  }

  _persistForm() {
    try {
      game.settings?.set(MODULE_ID, SETTING_FORM_STATE, { ...this._form });
    } catch (error) {
      console.warn(`${MODULE_ID} | could not persist form state`, error);
    }
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
      hasWarnings: Boolean(
        this._lastResult &&
          Array.isArray(this._lastResult.warnings) &&
          this._lastResult.warnings.length > 0,
      ),
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

    // Wire drag-and-drop on result tiles so they can be dropped onto
    // a sheet or canvas the way native Foundry items can. The result
    // section is re-rendered each generate, so re-wire on every render.
    for (const tile of root.querySelectorAll("[data-draggable-uuid]")) {
      tile.addEventListener("dragstart", beginDragFromResult);
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
    this._persistForm();
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

  /** @this {LootForgeApp} */
  static async _onDistributeOne(_event, target) {
    const uuid = target?.dataset?.uuid;
    if (!uuid) return;
    await promptDistributeItems([uuid]);
  }

  /** @this {LootForgeApp} */
  static async _onDistributeBundle(_event, _target) {
    const uuids = (this._lastResult?.items ?? [])
      .map((entry) => entry?.item?.uuid)
      .filter(Boolean);
    if (uuids.length === 0) return;
    await promptDistributeItems(uuids, {
      title: `Distribute Bundle (${uuids.length} items)`,
      hint: "Choose one character to receive the entire bundle.",
    });
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
      case "rarity":
        next.rarities = readMultiCheckGroup(this.element, "rarity");
        break;
      case "lootType":
        next.lootTypes = readMultiCheckGroup(this.element, "lootType");
        break;
      case "postToChat":
        next.postToChat = Boolean(target.checked);
        break;
      default:
        return;
    }
    this._form = next;
    this._updateProjectedBudgetLabel();
    this._persistForm();
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
    this._loadingItems = true;
    try {
      const budget = computeLootBudget(this._formForBudget());
      const items = await loadCompendiumItems({ packId: PACK_ID });
      const candidates = filterCandidates(items, {
        tiers: [this._form.tier],
        rarities: this._form.rarities,
        lootTypes: this._form.lootTypes,
        requireEligible: true,
      });
      const raw = rollLoot(candidates, {
        count: this._form.count,
        budgetGp: budget,
      });
      // Decorate each entry with template-ready fields so the .hbs
      // stays free of Handlebars helpers / data-shape gymnastics.
      this._lastResult = {
        ...raw,
        items: raw.items.map((entry) => ({
          ...entry,
          rarity: getItemRarity(entry.item) || "common",
          quantityLabel: entry.quantity > 1 ? `×${entry.quantity} · ` : "",
        })),
      };

      if (this._form.postToChat && this._lastResult.items.length > 0) {
        await this._postBundleToChat(this._lastResult);
      }
    } finally {
      this._loadingItems = false;
    }
    await this.render();
  }

  /**
   * Post the bundle to chat as a styled card. Item names are wrapped
   * in `@UUID[...]{name}` so Foundry's enricher turns them into
   * clickable links that open the item sheet on click.
   */
  async _postBundleToChat(result) {
    if (typeof ChatMessage === "undefined") return;
    const items = Array.isArray(result?.items) ? result.items : [];
    if (items.length === 0) return;

    const rows = items
      .map((entry) => {
        const uuid = entry?.item?.uuid ?? "";
        const name = String(entry?.item?.name ?? "Item");
        const qty =
          entry?.quantity > 1 ? `<span class="qty">×${entry.quantity}</span> ` : "";
        const gpTotal = Number(entry?.gpTotal ?? 0);
        const rarity = entry?.rarity ?? "common";
        const link = uuid
          ? `@UUID[${uuid}]{${escapeHtml(name)}}`
          : escapeHtml(name);
        return `<li class="loot-row loot-row--${rarity}">${qty}${link} <span class="meta">${rarity} · ${gpTotal} gp</span></li>`;
      })
      .join("");

    const budgetTag = result.budgetGp
      ? ` / ${result.budgetGp} gp budget`
      : "";
    const content = `
      <div class="infinity-dnd5e-loot-card">
        <header class="lc-head">
          <strong>Loot Bundle</strong>
          <span class="lc-total">${result.totalGp} gp${budgetTag}</span>
        </header>
        <ul class="lc-list">${rows}</ul>
      </div>
    `.trim();

    try {
      await ChatMessage.create({
        content,
        speaker: ChatMessage.getSpeaker
          ? ChatMessage.getSpeaker({ alias: "Loot Forge" })
          : { alias: "Loot Forge" },
      });
    } catch (error) {
      console.warn(`${MODULE_ID} | could not post bundle to chat`, error);
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

function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
