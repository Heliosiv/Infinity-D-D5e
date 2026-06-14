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
import {
  advanceDayNow,
  discoverAllActors,
  discoverPartyActors,
  discoverPlayerCharacters,
  getPartyRoster,
} from "./resource/calendar-watcher.js";
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
      addTag: ResourceManagerApp._onAddTag,
      removeTag: ResourceManagerApp._onRemoveTag,
      addRosterMember: ResourceManagerApp._onAddRosterMember,
      removeRosterMember: ResourceManagerApp._onRemoveRosterMember,
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
      // Plain short name for the dropdown; the status pill carries forageability.
      optionLabel: prettyEnvironment(env.id) || env.label,
      selected: env.id === currentEnvId,
    }));
    const currentEnv =
      config.environments.find((e) => e.id === currentEnvId) ?? null;

    const roster = getPartyRoster(config);
    const rosterIsImplicit = (config.roster ?? []).length === 0;
    const nameById = new Map(roster.map((r) => [r.actor.id, r.actor.name]));
    const stashRows = roster.filter((r) => r.isStash);
    const partyRows = roster.map(({ actor, isStash, drawFromId }) => {
      const snaps = actorItemSnapshots(actor);
      const counts = config.resources.map((res) => {
        const matches = matchResourceItems(snaps, res);
        // Tooltip: which items were counted (helps debug a 0 or an over-match).
        const detail =
          matches.length > 0
            ? matches.map((m) => `${m.name} ×${m.quantity}`).join(", ")
            : "No items match this resource";
        return {
          id: res.id,
          label: res.label,
          total: sumMatches(matches),
          detail,
        };
      });
      const drawsFromSelf = drawFromId === actor.id;
      // A member can draw from itself or any OTHER nominated stash.
      const drawFromOptions = [
        { value: "self", label: "Self", selected: drawsFromSelf },
        ...stashRows
          .filter((s) => s.actor.id !== actor.id)
          .map((s) => ({
            value: s.actor.id,
            label: s.actor.name,
            selected: !drawsFromSelf && drawFromId === s.actor.id,
          })),
      ];
      return {
        actorId: actor.id,
        name: actor.name,
        isStash,
        drawsFromSelf,
        drawFromLabel: drawsFromSelf
          ? "Self"
          : (nameById.get(drawFromId) ?? "Self"),
        drawFromOptions,
        canDrawFromStash: drawFromOptions.length > 1,
        exhaustion: Number(actor.system?.attributes?.exhaustion) || 0,
        counts,
      };
    });
    const onRoster = new Set(roster.map((r) => r.actor.id));
    // The Add picker offers EVERY actor (NPCs, vehicles, group, unowned) — not
    // just player characters — so the GM can track any actor for food/water.
    // Player characters sort first; others get a kind tag so they're distinct.
    const kindRank = { character: 0, group: 1, vehicle: 2, npc: 3 };
    const availableToAdd = discoverAllActors()
      .filter((actor) => !onRoster.has(actor.id))
      .map((actor) => {
        const type = String(actor.type ?? "");
        return {
          id: actor.id,
          name: actor.name,
          kindLabel:
            type && type !== "character" ? ` (${titleCaseWord(type)})` : "",
          rank: kindRank[type] ?? 4,
        };
      })
      .sort((a, b) => a.rank - b.rank || String(a.name).localeCompare(b.name));

    // Single party-wide food & water stash. When set, every member draws those
    // supplies from one pile (see getPartyRoster), so the per-row "Draws from"
    // is overridden — the dropdown below is the one control.
    const partyStashId = String(config.partyStashId ?? "").trim();
    const partyStashActive =
      partyStashId !== "" && roster.some((r) => r.actor.id === partyStashId);
    const partyStashName = partyStashActive
      ? (nameById.get(partyStashId) ?? "")
      : "";
    const partyStashOptions = [
      {
        value: "",
        label: "Each carries their own pack",
        selected: !partyStashActive,
      },
      ...roster.map((r) => ({
        value: r.actor.id,
        label: r.actor.name,
        selected: partyStashActive && r.actor.id === partyStashId,
      })),
    ];

    // Resolve each bound item UUID to a readable name (falls back to the raw
    // UUID, flagged, when it no longer resolves) so the GM can see what's tagged.
    const resources = await Promise.all(
      config.resources.map(async (res) => {
        const tags = await Promise.all(
          (res.matching.itemUuids ?? []).map(async (uuid) => {
            let name = uuid;
            let missing = true;
            try {
              const doc = await fromUuid(uuid);
              if (doc?.name) {
                name = doc.name;
                missing = false;
              }
            } catch {
              /* keep raw uuid + missing flag */
            }
            return { uuid, name, missing };
          }),
        );
        return {
          id: res.id,
          label: res.label,
          perDay: res.perDay,
          scopeIsParty: res.scope === "party",
          keywords: (res.matching.nameKeywords ?? []).join(", "),
          flagTag: res.matching.flagTag ?? "",
          tags,
        };
      }),
    );

    return {
      resources,
      environments,
      currentEnvLabel: currentEnv
        ? prettyEnvironment(currentEnv.id) || currentEnv.label
        : "—",
      currentEnvForageable: currentEnv
        ? currentEnv.forageable !== false
        : false,
      currentEnvDc: currentEnv?.dc ?? null,
      forageMode: config.forageMode,
      forageModeEach: config.forageMode === "each",
      halfRations: config.halfRations,
      waterEnabled: config.waterEnabled,
      autoTrigger: getSetting(SETTING_KEYS.RESOURCE_AUTO_TRIGGER) !== false,
      isAuthoritative: isAuthoritativeGM(),
      partyRows,
      hasParty: partyRows.length > 0,
      rosterIsImplicit,
      availableToAdd,
      hasAvailableToAdd: availableToAdd.length > 0,
      partyStashOptions,
      partyStashActive,
      partyStashName,
      hasRosterMembers: roster.length > 0,
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

    // Enter = primary action (Advance Day), matching the loot tools. Bound once;
    // skips form fields and respects the keyboard-shortcuts setting. Advance Day
    // confirms first, so an accidental Enter can't blow through.
    if (root.dataset.idxKeydownBound !== "true") {
      root.dataset.idxKeydownBound = "true";
      root.addEventListener("keydown", (event) => {
        if (getSetting(SETTING_KEYS.KEYBOARD_SHORTCUTS) === false) return;
        if (event.key !== "Enter" || event.defaultPrevented) return;
        const tag = event.target?.tagName?.toLowerCase();
        if (tag === "input" || tag === "select" || tag === "textarea") return;
        event.preventDefault();
        void this.constructor._onAdvanceDay.call(this);
      });
    }

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

    if (path === "forageMode")
      config.forageMode = value === "best" ? "best" : "each";
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
    } else if (path === "partyStashId") {
      // The single party food/water stash. References a tracked actor (or "" to
      // turn it off) — no roster seeding needed; getPartyRoster resolves it
      // against the live/auto-discovered party.
      config.partyStashId = String(value || "");
    } else if (path.startsWith("roster:")) {
      // Editing any roster row materializes the implicit "all PCs" roster first,
      // so a stash/draw toggle turns auto-tracking into an explicit roster.
      const [, actorId, field] = path.split(":");
      seedRosterIfEmpty(config);
      const entry = config.roster.find((r) => r.actorId === actorId);
      if (entry) {
        if (field === "isStash") entry.isStash = Boolean(value);
        else if (field === "drawFrom") entry.drawFrom = String(value || "self");
      }
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
    // Advancing a day consumes real supplies off character sheets and prompts
    // players to forage — confirm first (it's separate from the world clock).
    const party = discoverPartyActors();
    const DialogV2 = foundry?.applications?.api?.DialogV2;
    if (party.length > 0 && typeof DialogV2?.confirm === "function") {
      const ok = await DialogV2.confirm({
        window: { title: "Advance a day?", icon: "fa-solid fa-forward-step" },
        content: `<p>Consume one day of supplies for <strong>${party.length}</strong> character(s) and prompt online players to forage?</p><p style="opacity:0.8;">This is a manual day tick — it doesn't change the world clock, and runs even if auto-upkeep is off.</p>`,
        rejectClose: false,
      }).catch(() => false);
      if (!ok) return;
    }
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
  /** Keyboard-friendly alternative to drag-to-tag: paste an item UUID. */
  static async _onAddTag(_event, target) {
    const id = target?.dataset?.resourceId;
    if (!id) return;
    const DialogV2 = foundry?.applications?.api?.DialogV2;
    if (typeof DialogV2?.prompt !== "function") return;
    let uuid = null;
    try {
      uuid = await DialogV2.prompt({
        window: { title: "Add item by UUID", icon: "fa-solid fa-link" },
        content:
          "<p>Paste an item's UUID to match it exactly (right-click an item, then Copy Document UUID).</p>" +
          '<label style="display:grid;gap:4px;"><span>Item UUID</span><input type="text" name="uuid" placeholder="Compendium.…Item.…" /></label>',
        ok: {
          label: "Add",
          callback: (_e, button) =>
            button?.form?.elements?.uuid?.value?.trim() ?? null,
        },
        rejectClose: false,
      });
    } catch {
      uuid = null;
    }
    if (!uuid) return;
    const config = loadResourceConfig();
    const res = config.resources.find((r) => r.id === id);
    if (!res) return;
    const uuids = new Set(res.matching.itemUuids ?? []);
    uuids.add(uuid);
    res.matching.itemUuids = [...uuids];
    await saveResourceConfig(config);
    playModuleSound(SOUND_EVENTS.DEPOSIT);
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
  static async _onAddRosterMember(_event, _target) {
    const select = this.element?.querySelector("[data-role='add-roster']");
    const actorId = String(select?.value ?? "").trim();
    if (!actorId) return;
    // Any real actor is eligible — the GM may add NPCs / unowned actors as
    // supply sources, not just player characters.
    if (!discoverAllActors().some((a) => a.id === actorId)) return;
    const config = loadResourceConfig();
    seedRosterIfEmpty(config);
    if (!config.roster.some((r) => r.actorId === actorId)) {
      config.roster.push({ actorId, isStash: false, drawFrom: "self" });
    }
    await saveResourceConfig(config);
    playModuleSound(SOUND_EVENTS.ROSTER_ADD);
    this.render(false);
  }

  /** @this {ResourceManagerApp} */
  static async _onRemoveRosterMember(_event, target) {
    const actorId = target?.dataset?.actorId;
    if (!actorId) return;
    const config = loadResourceConfig();
    seedRosterIfEmpty(config);
    config.roster = config.roster.filter((r) => r.actorId !== actorId);
    await saveResourceConfig(config);
    playModuleSound(SOUND_EVENTS.ROSTER_REMOVE);
    this.render(false);
  }

  /** @this {ResourceManagerApp} */
  static async _onResetConfig(_event, _target) {
    const DialogV2 = foundry?.applications?.api?.DialogV2;
    let ok = true;
    if (typeof DialogV2?.confirm === "function") {
      ok = await DialogV2.confirm({
        window: {
          title: "Reset Quartermaster?",
          icon: "fa-solid fa-rotate-left",
        },
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

/**
 * Materialize the implicit "auto-track every player character" roster into an
 * explicit one so a per-row edit (stash / draws-from / remove) has a concrete
 * entry to change. No-op once the roster is already curated.
 */
function seedRosterIfEmpty(config) {
  if (Array.isArray(config.roster) && config.roster.length > 0) return;
  // Auto-seed stays player-characters-only by design (least surprise); the GM
  // then explicitly adds NPCs / other actors through the Add picker.
  config.roster = discoverPlayerCharacters().map((actor) => ({
    actorId: actor.id,
    isStash: false,
    drawFrom: "self",
  }));
}

/** "npc" -> "Npc", "vehicle" -> "Vehicle" for the Add-picker kind tag. */
function titleCaseWord(value) {
  const s = String(value ?? "");
  return s ? s.charAt(0).toUpperCase() + s.slice(1) : s;
}

function applyResourceField(res, field, value) {
  if (field === "label") res.label = String(value ?? "").trim() || res.id;
  else if (field === "perDay") res.perDay = Math.max(0, Number(value) || 0);
  else if (field === "scope")
    res.scope = value === "party" ? "party" : "per-character";
  else if (field === "flagTag")
    res.matching.flagTag = String(value ?? "").trim();
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
  return list.map((i) =>
    typeof i?.toObject === "function" ? i.toObject() : i,
  );
}

/** Plain-language foraging note for a per-actor report row. Distinguishes
 *  "foraged nothing" (was prompted, no haul) from "" (never foraged). */
function forageNote(foraged) {
  const f = foraged ?? {};
  if (!f.attempted) return "";
  const food = Number(f.food) || 0;
  const water = Number(f.water) || 0;
  if (f.success && (food > 0 || water > 0)) {
    const parts = [];
    if (food > 0) parts.push(`+${food} food`);
    if (water > 0) parts.push(`+${water} water`);
    return `foraged ${parts.join(" / ")}`;
  }
  return "foraged nothing";
}

function summarizeReport(result) {
  if (!result || typeof result !== "object") return null;
  const perActor = Array.isArray(result.perActor) ? result.perActor : [];
  const lightShortfall = Math.max(
    0,
    Number(result.party?.light?.shortfall) || 0,
  );
  return {
    days: result.days ?? 1,
    environmentLabel: result.environmentId
      ? prettyEnvironment(result.environmentId) || result.environmentId
      : "—",
    rows: perActor.map((r) => ({
      name: r.name,
      shortFood: r.shortfalls?.food ?? 0,
      shortWater: r.shortfalls?.water ?? 0,
      forageNote: forageNote(r.foraged),
      ok: !(r.shortfalls?.food > 0 || r.shortfalls?.water > 0),
    })),
    lightShortfall,
    hasSuggestions:
      Array.isArray(result.suggestions) && result.suggestions.length > 0,
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
