/**
 * Infinity D&D5e — ResourceManagerApp (Quartermaster)
 *
 * GM-only singleton for configuring party resources (what counts as food /
 * water / light, daily rates, matching), setting the party's environment, and
 * running the daily upkeep on demand. Resource data lives in the world settings
 * via resource/store.js; this window is the editor + control panel on top.
 *
 * Mirrors MerchantWorkspaceApp's scaffolding (singleton, GM guard, socket-driven
 * re-render, drop-to-tag).
 */

import {
  loadResourceConfig,
  saveResourceConfig,
  loadRunState,
  setCurrentEnvironment,
  createDefaultResourceConfig,
  normalizeResource,
} from "./resource/store.js";
import { advanceDayNow, discoverPartyActors } from "./resource/calendar-watcher.js";
import { matchResourceItems } from "./resource/consumption.js";
import {
  RESOURCE_EVENTS,
  subscribe,
  isAuthoritativeGM,
} from "./resource/socket.js";
import { SETTING_KEYS, getSetting, setSetting } from "./settings.js";
import { prettyEnvironment } from "./ui-util.js";
import { SOUND_EVENTS, playModuleSound } from "./audio.js";

const MODULE_ID = "infinity-dnd5e";
const TEMPLATE_PATH = `modules/${MODULE_ID}/templates/resource-manager.hbs`;

const { ApplicationV2, HandlebarsApplicationMixin } = foundry.applications.api;

export class ResourceManagerApp extends HandlebarsApplicationMixin(
  ApplicationV2,
) {
  static _instance = null;

  static DEFAULT_OPTIONS = {
    id: "infinity-dnd5e-resource-manager",
    tag: "section",
    classes: ["infinity-dnd5e", "infinity-resource-manager"],
    window: {
      title: "Infinity D&D5e — Quartermaster",
      icon: "fa-solid fa-campground",
      resizable: true,
    },
    position: { width: 880, height: 700 },
    actions: {
      advanceDay: ResourceManagerApp._onAdvanceDay,
      addResource: ResourceManagerApp._onAddResource,
      removeResource: ResourceManagerApp._onRemoveResource,
      removeTag: ResourceManagerApp._onRemoveTag,
      resetConfig: ResourceManagerApp._onResetConfig,
      refresh: ResourceManagerApp._onRefresh,
    },
  };

  static PARTS = {
    body: { template: TEMPLATE_PATH },
  };

  static open() {
    if (!globalThis.game?.user?.isGM) {
      ui.notifications?.warn(`${MODULE_ID}: the Quartermaster is GM-only.`);
      return null;
    }
    playModuleSound(SOUND_EVENTS.UI_OPEN);
    if (!ResourceManagerApp._instance) {
      ResourceManagerApp._instance = new ResourceManagerApp();
    }
    if (ResourceManagerApp._instance.rendered) {
      ResourceManagerApp._instance.bringToFront();
    } else {
      ResourceManagerApp._instance.render(true);
    }
    return ResourceManagerApp._instance;
  }

  constructor(options = {}) {
    super(options);
    this._unsubs = [
      subscribe(RESOURCE_EVENTS.STATE_UPDATE, () => this.render(false)),
      subscribe(RESOURCE_EVENTS.UPKEEP_REPORT, () => this.render(false)),
    ];
  }

  _onClose(options) {
    super._onClose?.(options);
    for (const fn of this._unsubs ?? []) {
      try {
        fn();
      } catch {
        /* ignore */
      }
    }
    this._unsubs = [];
    ResourceManagerApp._instance = null;
  }

  async _prepareContext() {
    const config = loadResourceConfig();
    const state = loadRunState();
    const currentEnvId =
      state.currentEnvironmentId ||
      getSetting(SETTING_KEYS.RESOURCE_DEFAULT_ENVIRONMENT) ||
      "limited";

    const environments = config.environments.map((env) => ({
      ...env,
      selected: env.id === currentEnvId,
    }));
    const currentEnv =
      config.environments.find((e) => e.id === currentEnvId) ?? null;

    const party = discoverPartyActors();
    const partyRows = party.map((actor) => {
      const snaps = actorItemSnapshots(actor);
      const counts = config.resources.map((res) => ({
        id: res.id,
        label: res.label,
        total: sumMatches(matchResourceItems(snaps, res)),
      }));
      return {
        actorId: actor.id,
        name: actor.name,
        exhaustion: Number(actor.system?.attributes?.exhaustion) || 0,
        counts,
      };
    });

    const resources = config.resources.map((res) => ({
      id: res.id,
      label: res.label,
      perDay: res.perDay,
      scopeIsParty: res.scope === "party",
      keywords: (res.matching.nameKeywords ?? []).join(", "),
      flagTag: res.matching.flagTag ?? "",
      itemUuids: res.matching.itemUuids ?? [],
    }));

    return {
      resources,
      environments,
      currentEnvLabel: currentEnv
        ? prettyEnvironment(currentEnv.id) || currentEnv.label
        : "—",
      currentEnvForageable: currentEnv ? currentEnv.forageable !== false : false,
      currentEnvDc: currentEnv?.dc ?? null,
      forageMode: config.forageMode,
      forageModeEach: config.forageMode === "each",
      halfRations: config.halfRations,
      waterEnabled: config.waterEnabled,
      autoTrigger: getSetting(SETTING_KEYS.RESOURCE_AUTO_TRIGGER) !== false,
      isAuthoritative: isAuthoritativeGM(),
      partyRows,
      hasParty: partyRows.length > 0,
      report: summarizeReport(state.lastUpkeepResult),
    };
  }

  _onRender(context, options) {
    super._onRender?.(context, options);
    const root = this.element;
    if (!root) return;

    root.classList.toggle(
      "rm-no-anim",
      getSetting(SETTING_KEYS.ANIMATIONS) === false,
    );

    // Environment select.
    const envSelect = root.querySelector("[data-role='environment']");
    if (envSelect) {
      envSelect.addEventListener("change", async (event) => {
        await setCurrentEnvironment(String(event.target.value ?? ""));
        this.render(false);
      });
    }

    // Generic config-path inputs (toggles + per-resource fields).
    for (const input of root.querySelectorAll("[data-config-path]")) {
      input.addEventListener("change", (event) =>
        this._onConfigInput(event.currentTarget),
      );
    }

    // Drop-to-tag zones — drop an item to bind it to a resource by UUID.
    for (const zone of root.querySelectorAll("[data-drop-resource]")) {
      zone.addEventListener("dragover", (event) => event.preventDefault());
      zone.addEventListener("drop", (event) =>
        this._onDropItem(event, zone.dataset.dropResource),
      );
    }
  }

  async _onConfigInput(input) {
    const path = input?.dataset?.configPath;
    if (!path) return;
    const config = loadResourceConfig();
    const value =
      input.type === "checkbox" ? input.checked : String(input.value ?? "");

    if (path === "forageMode") config.forageMode = value === "best" ? "best" : "each";
    else if (path === "halfRations") config.halfRations = Boolean(value);
    else if (path === "waterEnabled") config.waterEnabled = Boolean(value);
    else if (path === "autoTrigger") {
      await setSetting(SETTING_KEYS.RESOURCE_AUTO_TRIGGER, Boolean(value));
      this.render(false);
      return;
    } else if (path.startsWith("resource:")) {
      const [, id, field] = path.split(":");
      const res = config.resources.find((r) => r.id === id);
      if (res) applyResourceField(res, field, value);
    }

    await saveResourceConfig(config);
    playModuleSound(SOUND_EVENTS.PRESET_APPLY);
    this.render(false);
  }

  async _onDropItem(event, resourceId) {
    event.preventDefault();
    const uuid = extractDroppedItemUuid(event);
    if (!uuid || !resourceId) return;
    const config = loadResourceConfig();
    const res = config.resources.find((r) => r.id === resourceId);
    if (!res) return;
    const uuids = new Set(res.matching.itemUuids ?? []);
    uuids.add(uuid);
    res.matching.itemUuids = [...uuids];
    await saveResourceConfig(config);
    playModuleSound(SOUND_EVENTS.DEPOSIT);
    ui.notifications?.info(`${MODULE_ID}: tagged an item as ${res.label}.`);
    this.render(false);
  }

  /* -------------------- actions -------------------- */

  /** @this {ResourceManagerApp} */
  static async _onAdvanceDay(_event, _target) {
    playModuleSound(SOUND_EVENTS.ROLL_START);
    await advanceDayNow();
    this.render(false);
  }

  /** @this {ResourceManagerApp} */
  static async _onAddResource(_event, _target) {
    const config = loadResourceConfig();
    const used = new Set(config.resources.map((r) => r.id));
    let n = config.resources.length + 1;
    let id = `resource-${n}`;
    while (used.has(id)) id = `resource-${++n}`;
    config.resources.push(
      normalizeResource({
        id,
        label: "New Resource",
        scope: "per-character",
        perDay: 1,
        matching: { nameKeywords: [], flagTag: id, itemUuids: [] },
      }),
    );
    await saveResourceConfig(config);
    this.render(false);
  }

  /** @this {ResourceManagerApp} */
  static async _onRemoveResource(_event, target) {
    const id = target?.dataset?.resourceId;
    if (!id) return;
    const config = loadResourceConfig();
    config.resources = config.resources.filter((r) => r.id !== id);
    await saveResourceConfig(config);
    playModuleSound(SOUND_EVENTS.CLEAR_RESET);
    this.render(false);
  }

  /** @this {ResourceManagerApp} */
  static async _onRemoveTag(_event, target) {
    const id = target?.dataset?.resourceId;
    const uuid = target?.dataset?.uuid;
    if (!id || !uuid) return;
    const config = loadResourceConfig();
    const res = config.resources.find((r) => r.id === id);
    if (!res) return;
    res.matching.itemUuids = (res.matching.itemUuids ?? []).filter(
      (u) => u !== uuid,
    );
    await saveResourceConfig(config);
    this.render(false);
  }

  /** @this {ResourceManagerApp} */
  static async _onResetConfig(_event, _target) {
    const DialogV2 = foundry?.applications?.api?.DialogV2;
    let ok = true;
    if (typeof DialogV2?.confirm === "function") {
      ok = await DialogV2.confirm({
        window: { title: "Reset Quartermaster?", icon: "fa-solid fa-rotate-left" },
        content:
          "<p>Reset all resource definitions and environments to the defaults? Your day-tracking is kept.</p>",
        rejectClose: false,
      }).catch(() => false);
    }
    if (!ok) return;
    await saveResourceConfig(createDefaultResourceConfig());
    playModuleSound(SOUND_EVENTS.CLEAR_RESET);
    this.render(false);
  }

  /** @this {ResourceManagerApp} */
  static _onRefresh(_event, _target) {
    this.render(false);
  }
}

/* ------------------------------------------------------------------ *
 * Helpers
 * ------------------------------------------------------------------ */

function applyResourceField(res, field, value) {
  if (field === "label") res.label = String(value ?? "").trim() || res.id;
  else if (field === "perDay") res.perDay = Math.max(0, Number(value) || 0);
  else if (field === "scope")
    res.scope = value === "party" ? "party" : "per-character";
  else if (field === "flagTag") res.matching.flagTag = String(value ?? "").trim();
  else if (field === "keywords") {
    res.matching.nameKeywords = String(value ?? "")
      .split(",")
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean);
  }
}

function sumMatches(matches) {
  return (Array.isArray(matches) ? matches : []).reduce(
    (sum, m) => sum + (Number(m.quantity) || 0),
    0,
  );
}

function actorItemSnapshots(actor) {
  const items = actor?.items?.contents ?? actor?.items ?? [];
  const list = Array.isArray(items) ? items : Array.from(items ?? []);
  return list.map((i) => (typeof i?.toObject === "function" ? i.toObject() : i));
}

function summarizeReport(result) {
  if (!result || typeof result !== "object") return null;
  const perActor = Array.isArray(result.perActor) ? result.perActor : [];
  return {
    days: result.days ?? 1,
    environmentLabel: result.environmentId
      ? prettyEnvironment(result.environmentId) || result.environmentId
      : "—",
    rows: perActor.map((r) => ({
      name: r.name,
      shortFood: r.shortfalls?.food ?? 0,
      shortWater: r.shortfalls?.water ?? 0,
      foragedFood: r.foraged?.food ?? 0,
      foragedWater: r.foraged?.water ?? 0,
      ok: !(r.shortfalls?.food > 0 || r.shortfalls?.water > 0),
    })),
    hasSuggestions: Array.isArray(result.suggestions) && result.suggestions.length > 0,
  };
}

/** Parse an Item UUID from a Foundry drag-drop event. */
function extractDroppedItemUuid(event) {
  let raw = "";
  try {
    raw =
      event.dataTransfer?.getData("text/plain") ||
      event.dataTransfer?.getData("application/json") ||
      "";
  } catch {
    raw = "";
  }
  if (!raw) return null;
  try {
    const data = JSON.parse(raw);
    if (data?.type && data.type !== "Item") return null;
    return data?.uuid ?? null;
  } catch {
    return null;
  }
}
