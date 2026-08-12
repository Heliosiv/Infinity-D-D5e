/**
 * Infinity D&D5e — role-aware settings workspace.
 *
 * The existing settings catalog remains the source of truth. This application
 * groups those settings into task-oriented sections and keeps world-scoped
 * controls out of non-GM clients without changing any setting keys or values.
 */

import { SOUND_EVENTS, playModuleSound } from "./audio.js";
import { navigateToAppSection, openSingleton } from "./infinity-app.js";
import { isFullGM } from "./permissions.js";
import { SETTINGS, SETTING_KEYS, getSetting, setSetting } from "./settings.js";
import { getUiPreferences, updateUiPreferences } from "./ui-preferences.js";

const MODULE_ID = "infinity-dnd5e";
const TEMPLATE_PATH = `modules/${MODULE_ID}/templates/settings.hbs`;

const GROUPS = Object.freeze([
  {
    id: "appearance",
    label: "Appearance & Accessibility",
    description:
      "Choose comfortable or compact controls and tune local visual behavior.",
    keys: [
      SETTING_KEYS.ANIMATIONS,
      SETTING_KEYS.RARITY_GLOW,
      SETTING_KEYS.LOADING_SKELETON,
      SETTING_KEYS.KEYBOARD_SHORTCUTS,
      SETTING_KEYS.PERSIST_STATE,
      SETTING_KEYS.CRITICAL_INJURY_HUD_ENABLED,
    ],
  },
  {
    id: "loot",
    label: "Loot Studio",
    description: "Defaults used when Encounter, Hoard, or Creature mode opens.",
    keys: [
      SETTING_KEYS.DEFAULT_TIER,
      SETTING_KEYS.DEFAULT_PARTY_SIZE,
      SETTING_KEYS.DEFAULT_COUNT,
      SETTING_KEYS.DEFAULT_RARITIES,
      SETTING_KEYS.DEFAULT_MAGIC_BIAS,
      SETTING_KEYS.DEFAULT_SCALE,
      SETTING_KEYS.DEFAULT_GENEROSITY,
      SETTING_KEYS.CHAT_MODE,
    ],
  },
  {
    id: "merchants",
    label: "Merchants",
    description:
      "World defaults for prices, bargaining, confirmations, and receipts.",
    keys: [
      SETTING_KEYS.MERCHANT_DEFAULT_MARKUP,
      SETTING_KEYS.MERCHANT_DEFAULT_SELL_RATIO,
      SETTING_KEYS.MERCHANT_DEFAULT_BARGAIN_DC,
      SETTING_KEYS.MERCHANT_CHAT_MODE,
      SETTING_KEYS.MERCHANT_CONFIRM_TRANSACTIONS,
    ],
  },
  {
    id: "quartermaster",
    label: "Quartermaster",
    description:
      "Daily resource automation and the player-facing Party Supplies view.",
    keys: [
      SETTING_KEYS.RESOURCE_AUTO_TRIGGER,
      SETTING_KEYS.RESOURCE_PLAYER_VIEW,
      SETTING_KEYS.RESOURCE_DEFAULT_ENVIRONMENT,
      SETTING_KEYS.RESOURCE_FORAGE_MODE,
      SETTING_KEYS.RESOURCE_WATER_ENABLED,
      SETTING_KEYS.RESOURCE_HALF_RATIONS,
      SETTING_KEYS.RESOURCE_MAX_CATCHUP_DAYS,
      SETTING_KEYS.RESOURCE_REPORT_MODE,
    ],
  },
  {
    id: "automation",
    label: "Automation",
    description:
      "Enable or disable rules automation without changing existing campaign records.",
    keys: [SETTING_KEYS.SPELL_COMPONENTS_ENABLED],
  },
  {
    id: "injuries",
    label: "Injuries",
    description:
      "Control the Critical Injury workflow while preserving existing injury records.",
    keys: [SETTING_KEYS.CRITICAL_INJURIES_ENABLED],
  },
  {
    id: "audio",
    label: "Audio",
    description:
      "Local sound preferences, including optional combat and activity cues.",
    keys: [
      SETTING_KEYS.SOUNDS_ENABLED,
      SETTING_KEYS.AUTOMATION_SOUNDS_ENABLED,
      SETTING_KEYS.SOUND_VOLUME,
    ],
  },
  {
    id: "advanced",
    label: "Advanced",
    description:
      "Technical cache behavior for GMs maintaining compendium data during a session.",
    keys: [SETTING_KEYS.PACK_TTL_MINUTES],
  },
]);

const SETTINGS_BY_KEY = new Map(SETTINGS.map((entry) => [entry.key, entry]));

const { ApplicationV2, HandlebarsApplicationMixin } = foundry.applications.api;

export class InfinitySettingsApp extends HandlebarsApplicationMixin(
  ApplicationV2,
) {
  static _instance = null;

  static DEFAULT_OPTIONS = {
    id: "infinity-dnd5e-settings",
    tag: "section",
    classes: ["infinity-dnd5e", "infinity-settings"],
    window: {
      title: "Infinity D&D5e — Settings",
      icon: "fa-solid fa-sliders",
      resizable: true,
    },
    position: { width: 760, height: 720 },
    actions: {
      save: InfinitySettingsApp._onSave,
      resetQuickStarts: InfinitySettingsApp._onResetQuickStarts,
      selectSection: navigateToAppSection,
    },
  };

  static PARTS = {
    body: { template: TEMPLATE_PATH },
  };

  static open() {
    playModuleSound(SOUND_EVENTS.UI_OPEN);
    return openSingleton(InfinitySettingsApp, () => new InfinitySettingsApp());
  }

  constructor(options = {}) {
    super(options);
    this._dirty = false;
    this._status = "No unsaved changes.";
    this._statusTone = "neutral";
  }

  async _prepareContext() {
    const fullGm = isFullGM();
    const preferences = getUiPreferences();
    const groups = buildSettingsGroups({ fullGm });
    return {
      moduleId: MODULE_ID,
      fullGm,
      groups,
      hasGroups: groups.length > 0,
      density: preferences.density,
      densityOptions: [
        {
          value: "comfortable",
          label: "Comfortable — larger controls and spacing",
          selected: preferences.density === "comfortable",
        },
        {
          value: "compact",
          label: "Compact — more information on fine-pointer screens",
          selected: preferences.density === "compact",
        },
      ],
      status: this._status,
      statusTone: this._statusTone,
      dirty: this._dirty,
      hasPartialSaveError: this._dirty && this._statusTone === "danger",
    };
  }

  _onRender(context, options) {
    super._onRender?.(context, options);
    const form = this.element?.querySelector?.("[data-infinity-settings-form]");
    if (!form) return;
    form.addEventListener("input", () => this._markDirty());
    form.addEventListener("change", () => this._markDirty());
  }

  _onClose(options) {
    super._onClose?.(options);
    InfinitySettingsApp._instance = null;
  }

  _markDirty() {
    this._dirty = true;
    this._status = "Changes are ready to save.";
    this._statusTone = "attention";
    const status = this.element?.querySelector?.("[data-settings-status]");
    if (status) {
      status.textContent = this._status;
      status.dataset.tone = this._statusTone;
    }
    const save = this.element?.querySelector?.('[data-action="save"]');
    if (save) save.disabled = false;
  }

  /** @this {InfinitySettingsApp} */
  static async _onSave(_event, _target) {
    const form = this.element?.querySelector?.("[data-infinity-settings-form]");
    if (!form) return;
    const values = collectSettingsForm(form, { fullGm: isFullGM() });
    let saved = 0;
    const failed = [];

    for (const { entry, value } of values.settings) {
      if (Object.is(getSetting(entry.key), value)) continue;
      const ok = await setSetting(entry.key, value);
      if (ok) saved += 1;
      else failed.push(entry.name);
    }

    try {
      const before = getUiPreferences();
      if (before.density !== values.density) {
        await updateUiPreferences({ density: values.density });
        saved += 1;
      }
    } catch (error) {
      console.warn(`${MODULE_ID} | could not save UI preferences`, error);
      failed.push("Interface density");
    }

    this._dirty = failed.length > 0;
    this._statusTone = failed.length > 0 ? "danger" : "success";
    this._status = failed.length
      ? `Some changes were not saved: ${failed.join(", ")}. Review them and try again.`
      : saved > 0
        ? `${saved} change${saved === 1 ? "" : "s"} saved. Open windows now use the updated preferences.`
        : "Everything is already up to date.";
    playModuleSound(
      failed.length > 0 ? SOUND_EVENTS.WARNING_MUTED : SOUND_EVENTS.DEPOSIT,
    );
    await this.render(false);
  }

  /** @this {InfinitySettingsApp} */
  static async _onResetQuickStarts(_event, _target) {
    try {
      await updateUiPreferences({ dismissedQuickStarts: [] });
      this._status =
        "Quick-start cards will appear again the next time each workspace opens.";
      this._statusTone = "success";
      this._dirty = false;
      await this.render(false);
    } catch (error) {
      console.warn(`${MODULE_ID} | could not restore quick starts`, error);
      this._status = "Quick-start cards were not changed. Try again.";
      this._statusTone = "danger";
      await this.render(false);
    }
  }
}

export function buildSettingsGroups({ fullGm = false } = {}) {
  const claimed = new Set();
  const groups = GROUPS.map((group) => {
    const fields = group.keys
      .map((key) => SETTINGS_BY_KEY.get(key))
      .filter(Boolean)
      .filter((entry) => entry.config === true)
      .filter((entry) => fullGm || entry.scope === "client")
      .map((entry) => {
        claimed.add(entry.key);
        return presentSetting(entry);
      });
    return { ...group, fields, hasFields: fields.length > 0 };
  }).filter((group) => group.hasFields);

  const ungrouped = SETTINGS.filter(
    (entry) =>
      entry.config === true &&
      !claimed.has(entry.key) &&
      (fullGm || entry.scope === "client"),
  ).map(presentSetting);
  if (ungrouped.length > 0) {
    groups.push({
      id: "other",
      label: "Other",
      description: "Additional module preferences.",
      fields: ungrouped,
      hasFields: true,
    });
  }
  return groups;
}

export function presentSetting(entry) {
  const value = getSetting(entry.key);
  const choices = entry.choices
    ? Object.entries(entry.choices).map(([choiceValue, label]) => ({
        value: choiceValue,
        label,
        selected: String(value) === String(choiceValue),
      }))
    : [];
  return {
    key: entry.key,
    name: entry.name,
    hint: entry.hint,
    scope: entry.scope,
    scopeLabel: entry.scope === "world" ? "World" : "This client",
    isWorld: entry.scope === "world",
    value,
    checked: value === true,
    isBoolean: entry.type === Boolean,
    isNumber: entry.type === Number,
    isText: entry.type === String && choices.length === 0,
    isChoice: choices.length > 0,
    choices,
    min: entry.range?.min,
    max: entry.range?.max,
    step: entry.range?.step,
  };
}

export function collectSettingsForm(form, { fullGm = false } = {}) {
  const settings = [];
  for (const control of form.querySelectorAll?.("[data-setting-key]") ?? []) {
    const key = String(control.dataset.settingKey ?? "");
    const entry = SETTINGS_BY_KEY.get(key);
    if (!entry || entry.config !== true) continue;
    if (entry.scope === "world" && !fullGm) continue;
    settings.push({
      entry,
      value: coerceSettingValue(entry, control),
    });
  }
  const densityControl = form.querySelector?.('[name="uiDensity"]');
  const density =
    String(densityControl?.value ?? "comfortable") === "compact"
      ? "compact"
      : "comfortable";
  return { settings, density };
}

export function coerceSettingValue(entry, control) {
  if (entry.type === Boolean) return control?.checked === true;
  if (entry.type === Number) {
    const value = Number(control?.value);
    const fallback = Number(entry.default) || 0;
    const finite = Number.isFinite(value) ? value : fallback;
    const min = Number(entry.range?.min);
    const max = Number(entry.range?.max);
    return Math.max(
      Number.isFinite(min) ? min : -Infinity,
      Math.min(Number.isFinite(max) ? max : Infinity, finite),
    );
  }
  return String(control?.value ?? "");
}

export const SETTINGS_GROUPS = GROUPS;
