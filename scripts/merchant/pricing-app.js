/** GM-only city and multi-merchant pricing macro workspace. */

import { SOUND_EVENTS, playModuleSound } from "../audio.js";
import { confirmInfinityDialog } from "../dialog-contract.js";
import {
  applyVisualPrefs,
  bindFullGmWindowGuard,
  openSingleton,
} from "../infinity-app.js";
import { runAsFullGM } from "../permissions.js";
import { isAuthoritativeGM } from "../socket-authority.js";
import { notify } from "../ui-util.js";
import {
  applyMerchantPricingMacro,
  merchantPricingMacroSignature,
  planMerchantPricingMacro,
} from "./pricing-macros.js";
import { locationDirectory } from "./locations.js";
import { loadMerchants } from "./store.js";
import {
  ensureMerchantTabLeadership,
  hasMerchantTabLeadership,
} from "./tab-leadership.js";

const MODULE_ID = "infinity-dnd5e";
const TEMPLATE_PATH = `modules/${MODULE_ID}/templates/merchant-pricing.hbs`;
const ALL_MERCHANTS_SCOPE = "all";
const FALLBACK_ART = "icons/svg/chest.svg";

const { ApplicationV2, HandlebarsApplicationMixin } = foundry.applications.api;

export class MerchantPricingApp extends HandlebarsApplicationMixin(
  ApplicationV2,
) {
  static _instance = null;

  static DEFAULT_OPTIONS = {
    id: "infinity-dnd5e-merchant-pricing",
    tag: "section",
    classes: ["infinity-dnd5e", "infinity-merchant-pricing"],
    window: {
      title: "Infinity D&D5e — City Pricing",
      icon: "fa-solid fa-coins",
      resizable: true,
    },
    position: { width: 840, height: 720 },
    actions: {
      selectAll: MerchantPricingApp._onSelectAll,
      selectNone: MerchantPricingApp._onSelectNone,
      preview: MerchantPricingApp._onPreview,
      apply: MerchantPricingApp._onApply,
    },
  };

  static PARTS = {
    body: { template: TEMPLATE_PATH },
  };

  static open(options = {}) {
    return runAsFullGM(() => {
      playModuleSound(SOUND_EVENTS.UI_OPEN);
      const existing = MerchantPricingApp._instance;
      const app = openSingleton(
        MerchantPricingApp,
        () => new MerchantPricingApp(options),
      );
      if (existing && options.locationId != null) {
        app._requestedScopeId = cleanId(options.locationId);
        app._draft = null;
        app._preview = null;
        app.render(false);
      }
      return app;
    }, "City Pricing is available to full GMs only.");
  }

  constructor(options = {}) {
    super(options);
    this._unbindFullGmWindowGuard = bindFullGmWindowGuard(this);
    this._requestedScopeId = cleanId(options.locationId);
    this._draft = null;
    this._preview = null;
    this._status = "Choose a city or merchants, then preview the changes.";
    this._statusTone = "neutral";
    this._cityTargetMap = new Map();
  }

  _onClose(options) {
    super._onClose?.(options);
    this._unbindFullGmWindowGuard?.();
    this._unbindFullGmWindowGuard = null;
    MerchantPricingApp._instance = null;
  }

  async _prepareContext() {
    await ensureMerchantTabLeadership();
    const merchants = loadMerchants();
    const locations = locationDirectory(merchants);
    this._cityTargetMap = new Map([
      [ALL_MERCHANTS_SCOPE, merchants.map((merchant) => merchant.id)],
      ...locations.map((location) => [
        location.id,
        merchants
          .filter(
            (merchant) =>
              cleanId(merchant.shop?.locationId) === cleanId(location.id),
          )
          .map((merchant) => merchant.id),
      ]),
    ]);

    if (!this._draft) {
      const requested = this._cityTargetMap.has(this._requestedScopeId)
        ? this._requestedScopeId
        : "";
      const firstCity = locations.find(
        (location) =>
          cleanId(location.id) &&
          (this._cityTargetMap.get(location.id)?.length ?? 0) > 0,
      );
      const scopeId = requested || firstCity?.id || ALL_MERCHANTS_SCOPE;
      this._draft = defaultDraft(
        scopeId,
        this._cityTargetMap.get(scopeId) ?? [],
      );
    }

    const canManage = isAuthoritativeGM() && hasMerchantTabLeadership();
    const selectedIds = new Set(this._draft.merchantIds);
    const scopeId = this._draft.scopeId;
    const cityOptions = [
      {
        id: ALL_MERCHANTS_SCOPE,
        name: "All merchants",
        merchantCount: merchants.length,
        merchantCountIsOne: merchants.length === 1,
        selected: scopeId === ALL_MERCHANTS_SCOPE,
      },
      ...locations.map((location) => ({
        id: location.id,
        name: location.name,
        merchantCount: this._cityTargetMap.get(location.id)?.length ?? 0,
        merchantCountIsOne:
          (this._cityTargetMap.get(location.id)?.length ?? 0) === 1,
        selected: scopeId === location.id,
      })),
    ];

    return {
      moduleId: MODULE_ID,
      cityOptions,
      hasCities: locations.length > 0,
      hasMerchants: merchants.length > 0,
      merchants: merchants.map((merchant) => ({
        id: merchant.id,
        name: merchant.name,
        art: merchant.art || FALLBACK_ART,
        defaultMarkup: Number(merchant.defaultMarkup).toFixed(2),
        sellRatio: Number(merchant.sellRatio).toFixed(2),
        bargainDC: merchant.bargainDC,
        checked: selectedIds.has(merchant.id),
      })),
      draft: this._draft,
      selectedCount: selectedIds.size,
      selectedCountIsOne: selectedIds.size === 1,
      preview: this._preview,
      hasPreview: Boolean(this._preview),
      canApply:
        canManage && Boolean(this._preview) && this._preview.changedCount > 0,
      canManage,
      authorityReason: canManage
        ? ""
        : isAuthoritativeGM()
          ? "Another tab for this GM account owns Merchant changes. Close it or wait for control to transfer."
          : "Only the active full GM can apply city pricing.",
      status: this._status,
      statusTone: this._statusTone,
    };
  }

  _onRender(context, options) {
    super._onRender?.(context, options);
    applyVisualPrefs(this.element, "mp-");
    const form = this._form();
    if (!form) return;
    form
      .querySelector('[name="scopeId"]')
      ?.addEventListener("change", (event) => {
        this._selectScope(event.target?.value, { updateDom: true });
      });
    form.addEventListener("input", () => this._markPreviewStale());
    form.addEventListener("change", (event) => {
      if (event.target?.name !== "scopeId") this._markPreviewStale();
      this._refreshSelectedCount();
    });
  }

  _form() {
    return this.element?.querySelector?.("[data-merchant-pricing-form]");
  }

  _selectScope(value, { updateDom = false } = {}) {
    const scopeId = this._cityTargetMap.has(cleanId(value))
      ? cleanId(value)
      : ALL_MERCHANTS_SCOPE;
    const merchantIds = [...(this._cityTargetMap.get(scopeId) ?? [])];
    this._requestedScopeId = scopeId;
    this._draft = { ...(this._draft ?? defaultDraft()), scopeId, merchantIds };
    this._preview = null;
    this._status = `${merchantIds.length} merchant${merchantIds.length === 1 ? "" : "s"} selected from this group.`;
    this._statusTone = "neutral";
    if (!updateDom) return;
    const selected = new Set(merchantIds);
    for (const checkbox of this._form()?.querySelectorAll?.(
      'input[name="merchantIds"]',
    ) ?? []) {
      checkbox.checked = selected.has(checkbox.value);
    }
    this._updateStatusDom();
    this._refreshSelectedCount();
  }

  _markPreviewStale() {
    if (!this._preview) return;
    this._status = "Selections changed. Preview again before applying.";
    this._statusTone = "attention";
    const apply = this.element?.querySelector?.('[data-action="apply"]');
    if (apply) apply.disabled = true;
    this._updateStatusDom();
  }

  _refreshSelectedCount() {
    const count =
      this._form()?.querySelectorAll?.('input[name="merchantIds"]:checked')
        .length ?? 0;
    const label = this.element?.querySelector?.("[data-selected-count]");
    if (label) label.textContent = `${count} selected`;
  }

  _updateStatusDom() {
    const status = this.element?.querySelector?.("[data-pricing-status]");
    if (!status) return;
    status.textContent = this._status;
    status.dataset.tone = this._statusTone;
  }

  /** @this {MerchantPricingApp} */
  static _onSelectAll() {
    for (const checkbox of this._form()?.querySelectorAll?.(
      'input[name="merchantIds"]',
    ) ?? []) {
      checkbox.checked = true;
    }
    this._markPreviewStale();
    this._refreshSelectedCount();
  }

  /** @this {MerchantPricingApp} */
  static _onSelectNone() {
    for (const checkbox of this._form()?.querySelectorAll?.(
      'input[name="merchantIds"]',
    ) ?? []) {
      checkbox.checked = false;
    }
    this._markPreviewStale();
    this._refreshSelectedCount();
  }

  /** @this {MerchantPricingApp} */
  static async _onPreview() {
    const form = this._form();
    if (!form?.reportValidity?.()) return;
    try {
      const draft = readPricingDraft(form);
      const plan = planMerchantPricingMacro(loadMerchants(), {
        merchantIds: draft.merchantIds,
        patch: draft.patch,
      });
      this._draft = draft;
      this._preview = {
        ...plan,
        signature: merchantPricingMacroSignature({
          merchantIds: draft.merchantIds,
          patch: draft.patch,
        }),
      };
      this._status =
        plan.changedCount > 0
          ? `Review ${plan.changedCount} merchant change${plan.changedCount === 1 ? "" : "s"} below.`
          : "Every selected merchant already matches these rules.";
      this._statusTone = plan.changedCount > 0 ? "attention" : "success";
      playModuleSound(SOUND_EVENTS.PRESET_APPLY);
      this.render(false);
    } catch (error) {
      this._status = pricingErrorMessage(error);
      this._statusTone = "danger";
      this._updateStatusDom();
      notify("warn", this._status);
    }
  }

  /** @this {MerchantPricingApp} */
  static async _onApply() {
    const form = this._form();
    if (!form?.reportValidity?.() || !this._preview) return;
    try {
      const draft = readPricingDraft(form);
      const signature = merchantPricingMacroSignature({
        merchantIds: draft.merchantIds,
        patch: draft.patch,
      });
      if (signature !== this._preview.signature) {
        throw new Error("Selections changed. Preview again before applying.");
      }
      if (
        !isAuthoritativeGM() ||
        (await ensureMerchantTabLeadership()) !== true ||
        !hasMerchantTabLeadership()
      ) {
        throw new Error(
          "Merchant control moved to another GM tab. Nothing changed.",
        );
      }

      const confirmed = await confirmInfinityDialog({
        window: {
          title: "Apply city pricing?",
          icon: "fa-solid fa-coins",
        },
        content: `<p>Apply the reviewed pricing rules to <strong>${this._preview.changedCount}</strong> merchant${this._preview.changedCount === 1 ? "" : "s"}? Individual merchants can still be edited afterward.</p>`,
        rejectClose: false,
      });
      if (!confirmed) return;

      this._status = "Applying and verifying merchant pricing…";
      this._statusTone = "attention";
      this._updateStatusDom();
      const result = await applyMerchantPricingMacro({
        merchantIds: draft.merchantIds,
        patch: draft.patch,
      });
      this._draft = draft;
      this._preview = null;
      this._status = `${result.changedCount} merchant${result.changedCount === 1 ? "" : "s"} updated and verified.`;
      this._statusTone = "success";
      playModuleSound(SOUND_EVENTS.LOCK_TOGGLE);
      notify("info", this._status);
      this.render(false);
    } catch (error) {
      this._status = pricingErrorMessage(error);
      this._statusTone = "danger";
      this._updateStatusDom();
      notify("error", this._status);
    }
  }
}

export function readPricingDraft(form) {
  const data = new FormData(form);
  const patch = {};
  if (data.has("includePricing")) {
    patch.defaultMarkup = Number(data.get("defaultMarkup"));
    patch.sellRatio = Number(data.get("sellRatio"));
  }
  if (data.has("includeBargaining")) {
    patch.bargainDC = Number(data.get("bargainDC"));
    patch.bargainSuccessPct = Number(data.get("bargainSuccessPct"));
    patch.bargainFailPct = Number(data.get("bargainFailPct"));
  }
  if (data.has("includeCharm")) {
    patch.passiveHaggle = data.has("passiveHaggle");
    patch.passivePctPerPoint = Number(data.get("passivePctPerPoint"));
    patch.passiveCapPct = Number(data.get("passiveCapPct"));
  }
  if (data.has("clearItemPriceOverrides")) {
    patch.clearItemPriceOverrides = true;
  }
  return {
    scopeId: cleanId(data.get("scopeId")) || ALL_MERCHANTS_SCOPE,
    merchantIds: data.getAll("merchantIds").map(cleanId).filter(Boolean),
    includePricing: data.has("includePricing"),
    includeBargaining: data.has("includeBargaining"),
    includeCharm: data.has("includeCharm"),
    clearItemPriceOverrides: data.has("clearItemPriceOverrides"),
    defaultMarkup: numberValue(data.get("defaultMarkup"), 1),
    sellRatio: numberValue(data.get("sellRatio"), 0.5),
    bargainDC: numberValue(data.get("bargainDC"), 15),
    bargainSuccessPct: numberValue(data.get("bargainSuccessPct"), 10),
    bargainFailPct: numberValue(data.get("bargainFailPct"), 10),
    passiveHaggle: data.has("passiveHaggle"),
    passivePctPerPoint: numberValue(data.get("passivePctPerPoint"), 2),
    passiveCapPct: numberValue(data.get("passiveCapPct"), 20),
    patch,
  };
}

function defaultDraft(scopeId = ALL_MERCHANTS_SCOPE, merchantIds = []) {
  return {
    scopeId,
    merchantIds: [...merchantIds],
    includePricing: true,
    includeBargaining: true,
    includeCharm: true,
    clearItemPriceOverrides: false,
    defaultMarkup: 1,
    sellRatio: 0.5,
    bargainDC: 15,
    bargainSuccessPct: 10,
    bargainFailPct: 10,
    passiveHaggle: true,
    passivePctPerPoint: 2,
    passiveCapPct: 20,
    patch: {},
  };
}

function numberValue(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function cleanId(value) {
  return String(value ?? "").trim();
}

function pricingErrorMessage(error) {
  const message = String(error?.message ?? error ?? "").trim();
  if (message.startsWith("MerchantNotFound")) {
    return "A selected merchant changed or was removed. Reopen this window and preview again.";
  }
  if (message.startsWith("LocationNotFound")) {
    return "That city or location is no longer available. Choose another group.";
  }
  if (message === "MerchantPricingTargetsChanged") {
    return "The shops in that location changed. Preview the group again.";
  }
  return message || "Merchant pricing could not be changed.";
}
