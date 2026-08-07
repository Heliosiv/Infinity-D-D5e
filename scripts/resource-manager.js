/**
 * Infinity D&D5e — ResourceManagerApp (Quartermaster)
 *
 * GM-only singleton for configuring party resources (what counts as food /
 * water / light, daily rates, matching), setting the party's environment, and
 * running the daily upkeep on demand. Visible rules live in Foundry settings;
 * GM-only structure and run state live in the restricted private store.
 *
 * Mirrors MerchantWorkspaceApp's scaffolding (singleton, GM guard, socket-driven
 * re-render, drop-to-tag).
 */

import {
  loadResourceConfig,
  saveResourceConfig,
  loadRunState,
  clearUpkeepClaim,
  setCurrentEnvironment,
  createDefaultResourceConfig,
  isCanonicalPerCharacterResource,
  normalizeResource,
  resetResourceRules,
  setResourceRule,
} from "./resource/store.js";
import {
  actorItemSnapshots,
  advanceDayNow,
  describeForageDrive,
  discoverAllActors,
  discoverPartyActors,
  discoverPlayerCharacters,
  getPartyRoster,
  runForageDrive,
} from "./resource/calendar-watcher.js";
import { buildResourceOverview } from "./resource/overview.js";
import {
  duplicateEnvironment,
  findEnvironment,
  isCustomEnvironment,
  updateEnvironmentFields,
} from "./resource/environment.js";
import {
  diagnoseResourceConfiguration,
  diagnoseResourceItemOverlaps,
} from "./resource/consumption.js";
import {
  RESOURCE_EVENTS,
  subscribe,
  isAuthoritativeGM,
} from "./resource/socket.js";
import { SETTING_KEYS, getSetting, setSetting } from "./settings.js";
import {
  escapeHtml,
  prettyEnvironment,
  notify,
  isInteractiveKeyboardTarget,
  confirmDestructive,
} from "./ui-util.js";
import { SOUND_EVENTS, playModuleSound } from "./audio.js";
import { isFullGM } from "./permissions.js";

const MODULE_ID = "infinity-dnd5e";
const TEMPLATE_PATH = `modules/${MODULE_ID}/templates/resource-manager.hbs`;
let manualAdvanceRequestInFlight = false;
let manualForageRequestInFlight = false;

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
      forageDrive: ResourceManagerApp._onForageDrive,
      clearInterruptedRun: ResourceManagerApp._onClearInterruptedRun,
      addResource: ResourceManagerApp._onAddResource,
      removeResource: ResourceManagerApp._onRemoveResource,
      addTag: ResourceManagerApp._onAddTag,
      removeTag: ResourceManagerApp._onRemoveTag,
      addRosterMember: ResourceManagerApp._onAddRosterMember,
      removeRosterMember: ResourceManagerApp._onRemoveRosterMember,
      copyEnvironment: ResourceManagerApp._onCopyEnvironment,
      resetConfig: ResourceManagerApp._onResetConfig,
      refresh: ResourceManagerApp._onRefresh,
    },
  };

  static PARTS = {
    body: { template: TEMPLATE_PATH },
  };

  static open() {
    if (!isFullGM()) {
      notify("warn", `the Quartermaster is available to full GMs only.`);
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
    this._userConnectionHook =
      globalThis.Hooks?.on?.("userConnected", () => {
        if (this.rendered) this.render(false);
      }) ?? null;
    this._userRoleHook =
      globalThis.Hooks?.on?.("updateUser", (user) => {
        if (user?.id !== globalThis.game?.user?.id) return;
        if (!isFullGM()) {
          if (this.rendered) void this.close();
          return;
        }
        if (this.rendered) this.render(false);
      }) ?? null;
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
    if (this._userConnectionHook != null) {
      try {
        globalThis.Hooks?.off?.("userConnected", this._userConnectionHook);
      } catch {
        // Best effort during Foundry shutdown.
      }
      this._userConnectionHook = null;
    }
    if (this._userRoleHook != null) {
      try {
        globalThis.Hooks?.off?.("updateUser", this._userRoleHook);
      } catch {
        // Best effort during Foundry shutdown.
      }
      this._userRoleHook = null;
    }
    ResourceManagerApp._instance = null;
  }

  async _prepareContext() {
    const config = loadResourceConfig();
    const state = loadRunState();
    const currentEnvId =
      state.currentEnvironmentId ||
      getSetting(SETTING_KEYS.RESOURCE_DEFAULT_ENVIRONMENT) ||
      "limited";

    const currentEnv =
      findEnvironment(config.environments, currentEnvId) ??
      config.environments[0] ??
      null;
    const environments = config.environments.map((env) => ({
      ...env,
      // Plain short name for the dropdown; the status pill carries forageability.
      optionLabel: environmentDisplayLabel(env),
      selected: env.id === currentEnv?.id,
    }));

    const roster = getPartyRoster(config);
    const rosterIsImplicit = (config.roster ?? []).length === 0;
    const nameById = new Map(roster.map((r) => [r.actor.id, r.actor.name]));
    const stashRows = roster.filter((r) => r.isStash);
    const autoTrigger =
      getSetting(SETTING_KEYS.RESOURCE_AUTO_TRIGGER) !== false;
    const rosterSnapshots = roster.map(
      ({ actor, isStash, consumes, drawFromId }) => ({
        actorId: actor.id,
        name: actor.name,
        isStash,
        consumes,
        drawFromId,
        exhaustion: Number(actor.system?.attributes?.exhaustion) || 0,
        items: actorItemSnapshots(actor),
      }),
    );
    const configurationDiagnostics = diagnoseResourceConfiguration(
      config.resources,
    );
    const inventoryDiagnostics = diagnoseResourceItemOverlaps({
      inventories: rosterSnapshots,
      resources: config.resources,
    });
    const resourceConflictWarnings = [
      ...configurationDiagnostics.conflicts,
      ...inventoryDiagnostics.conflicts,
    ]
      .map((conflict) => ({
        ...conflict,
        isBlocking: conflict.blocking === true,
      }))
      .sort(
        (left, right) => Number(right.isBlocking) - Number(left.isBlocking),
      );
    const hasBlockingResourceConflicts = resourceConflictWarnings.some(
      (conflict) => conflict.isBlocking,
    );
    const isAuthoritative = isAuthoritativeGM();
    const activeUpkeep = state.activeUpkeep;
    const overview = buildResourceOverview({
      config,
      state,
      environment: currentEnv,
      autoTrigger,
      generatedAt: Date.now(),
      roster: rosterSnapshots,
    });
    // The inventory table always mirrors every configured resource, including
    // water while water consumption is disabled. Its columns therefore stay
    // aligned with the resource editor while the operational outlook omits
    // disabled resources.
    const inventoryOverview =
      config.waterEnabled === false
        ? buildResourceOverview({
            config: { ...config, waterEnabled: true },
            state,
            environment: currentEnv,
            autoTrigger,
            generatedAt: overview.generatedAt,
            roster: rosterSnapshots,
          })
        : overview;
    const overviewMemberById = new Map(
      inventoryOverview.members.map((member) => [member.actorId, member]),
    );
    const partyRows = roster.map(({ actor, isStash, consumes, drawFromId }) => {
      const counts = overviewMemberById.get(actor.id)?.resources ?? [];
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
        consumes,
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

    // Single party-wide per-character supply stash. When set, every consuming
    // member draws those resources from one pile (see getPartyRoster), so the
    // per-row "Draws from" is overridden — the dropdown below is the one control.
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
          scopeLocked: isCanonicalPerCharacterResource(res),
          keywords: (res.matching.nameKeywords ?? []).join(", "),
          flagTag: res.matching.flagTag ?? "",
          tags,
        };
      }),
    );

    return {
      resources,
      environments,
      currentEnvironment: currentEnv
        ? {
            ...currentEnv,
            isCustom: isCustomEnvironment(currentEnv),
          }
        : null,
      canCopyEnvironment: isAuthoritative && Boolean(currentEnv),
      currentEnvLabel: currentEnv ? environmentDisplayLabel(currentEnv) : "—",
      currentEnvForageable: currentEnv
        ? currentEnv.forageable !== false
        : false,
      currentEnvDc: currentEnv?.dc ?? null,
      forageMode: config.forageMode,
      forageModeEach: config.forageMode === "each",
      halfRations: config.halfRations,
      waterEnabled: config.waterEnabled,
      maxCatchUpDays: config.maxCatchUpDays,
      autoTrigger,
      isAuthoritative,
      canRunResourceWrites:
        isAuthoritative && !hasBlockingResourceConflicts && !activeUpkeep,
      hasActiveUpkeep: Boolean(activeUpkeep),
      activeUpkeep: activeUpkeep
        ? {
            ...activeUpkeep,
            triggerLabel:
              activeUpkeep.trigger === "calendar"
                ? "automatic day change"
                : activeUpkeep.trigger === "forage"
                  ? "forage drive"
                  : "manual Advance Day",
            dayLabel:
              activeUpkeep.day == null
                ? "unknown day"
                : `day ${activeUpkeep.day}`,
          }
        : null,
      resourceConflictWarnings,
      hasResourceConflictWarnings: resourceConflictWarnings.length > 0,
      hasBlockingResourceConflicts,
      partyRows,
      hasParty: partyRows.length > 0,
      rosterIsImplicit,
      availableToAdd,
      hasAvailableToAdd: availableToAdd.length > 0,
      partyStashOptions,
      partyStashActive,
      partyStashName,
      hasRosterMembers: roster.length > 0,
      overviewResources: overview.resources.map((resource) => ({
        ...resource,
        icon: resourceIcon(resource.id),
      })),
      hasOverviewResources: overview.resources.length > 0,
      report: presentOverviewReport(overview.lastUpkeep, config.environments),
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
        if (isInteractiveKeyboardTarget(event.target)) return;
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
        if (!isAuthoritativeGM()) {
          notify(
            "warn",
            "only the active GM can change the current environment.",
          );
          await this._renderPreservingFocus(event.target);
          return;
        }
        await setCurrentEnvironment(String(event.target.value ?? ""));
        await this._renderPreservingFocus(event.target);
      });
    }

    // Generic config-path inputs (toggles + per-resource fields).
    for (const input of root.querySelectorAll("[data-config-path]")) {
      input.addEventListener("change", (event) =>
        this._onConfigInput(event.currentTarget),
      );
    }

    // Built-in environments are immutable presets. A copied custom region is
    // edited through the validated pure catalog helpers.
    for (const input of root.querySelectorAll("[data-environment-field]")) {
      input.addEventListener("change", (event) =>
        this._onEnvironmentInput(event.currentTarget),
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

    if (
      path === "forageMode" ||
      path === "halfRations" ||
      path === "waterEnabled" ||
      path === "maxCatchUpDays"
    ) {
      await setResourceRule(path, value);
      await this._renderPreservingFocus(input);
      return;
    } else if (path === "autoTrigger") {
      await setSetting(SETTING_KEYS.RESOURCE_AUTO_TRIGGER, Boolean(value));
      await this._renderPreservingFocus(input);
      return;
    } else if (path.startsWith("resource:")) {
      const [, id, field] = path.split(":");
      const res = config.resources.find((r) => r.id === id);
      if (res) applyResourceField(res, field, value);
    } else if (path === "partyStashId") {
      // The single party stash for every per-character resource. References a
      // tracked actor (or "" to turn it off) — no roster seeding needed;
      // getPartyRoster resolves it against the live/auto-discovered party.
      config.partyStashId = String(value || "");
    } else if (path.startsWith("roster:")) {
      // Editing any roster row materializes the implicit "all PCs" roster first,
      // so a stash/draw toggle turns auto-tracking into an explicit roster.
      const [, actorId, field] = path.split(":");
      seedRosterIfEmpty(config);
      const entry = config.roster.find((r) => r.actorId === actorId);
      if (entry) {
        if (field === "isStash") {
          entry.isStash = Boolean(value);
          // The selected party stash is forced on at runtime. Treat unchecking
          // its row as an explicit request to stop using the party-wide stash.
          if (!entry.isStash && config.partyStashId === actorId) {
            config.partyStashId = "";
          }
        } else if (field === "consumes") entry.consumes = Boolean(value);
        else if (field === "drawFrom") entry.drawFrom = String(value || "self");
      }
    }

    await saveResourceConfig(config);
    playModuleSound(SOUND_EVENTS.PRESET_APPLY);
    await this._renderPreservingFocus(input);
  }

  async _onEnvironmentInput(input) {
    const environmentId = String(input?.dataset?.environmentId ?? "").trim();
    const field = String(input?.dataset?.environmentField ?? "").trim();
    if (!environmentId || !field) return;

    const editor = input.closest?.(".rm-environment-editor");
    const controls = Array.from(
      editor?.querySelectorAll?.("[data-environment-field]") ?? [input],
    ).filter(
      (control) =>
        String(control?.dataset?.environmentId ?? "").trim() === environmentId,
    );
    const patch = Object.fromEntries(
      controls.map((control) => [
        String(control.dataset.environmentField),
        control.type === "checkbox"
          ? control.checked
          : String(control.value ?? ""),
      ]),
    );
    const config = loadResourceConfig();
    const updated = updateEnvironmentFields(
      config.environments,
      environmentId,
      patch,
    );
    if (!updated.ok) {
      for (const control of controls) {
        const controlField = String(control.dataset.environmentField);
        control.setCustomValidity?.(updated.errors?.[controlField] ?? "");
      }
      const firstInvalid = controls.find(
        (control) => updated.errors?.[control.dataset.environmentField],
      );
      const fallbackMessage =
        updated.errors?.environment ??
        updated.errors?.environmentId ??
        Object.values(updated.errors ?? {})[0] ??
        "This environment value is not valid.";
      if (!firstInvalid) input.setCustomValidity?.(fallbackMessage);
      (firstInvalid ?? input).reportValidity?.();
      return;
    }

    for (const control of controls) control.setCustomValidity?.("");
    config.environments = updated.catalog;
    await saveResourceConfig(config);
    playModuleSound(SOUND_EVENTS.PRESET_APPLY);
    await this._renderPreservingFocus(input);
  }

  async _renderPreservingFocus(activeElement) {
    const configPath = activeElement?.dataset?.configPath;
    const role = activeElement?.dataset?.role;
    const environmentId = activeElement?.dataset?.environmentId;
    const environmentField = activeElement?.dataset?.environmentField;
    const selector = configPath
      ? `[data-config-path="${cssEscape(configPath)}"]`
      : environmentId && environmentField
        ? `[data-environment-id="${cssEscape(environmentId)}"][data-environment-field="${cssEscape(environmentField)}"]`
        : role
          ? `[data-role="${cssEscape(role)}"]`
          : null;
    const start = activeElement?.selectionStart;
    const end = activeElement?.selectionEnd;
    await this.render(false);
    if (!selector) return;
    const restored = this.element?.querySelector?.(selector);
    restored?.focus?.();
    if (
      restored &&
      typeof restored.setSelectionRange === "function" &&
      Number.isInteger(start) &&
      Number.isInteger(end)
    ) {
      restored.setSelectionRange(start, end);
    }
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
    notify("info", `tagged an item as ${res.label}.`);
    this.render(false);
  }

  /* -------------------- actions -------------------- */

  /** @this {ResourceManagerApp} */
  static async _onAdvanceDay(_event, target) {
    if (!isAuthoritativeGM()) {
      notify("warn", `only the active GM can run daily upkeep.`);
      return;
    }
    if (manualAdvanceRequestInFlight) return;

    manualAdvanceRequestInFlight = true;
    try {
      setActionBusy(target, true);
      // Acquire the request guard before opening the dialog. Otherwise repeated
      // clicks can queue multiple confirmations that resume one at a time after
      // the service-level upkeep guard has already been released.
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
    } finally {
      manualAdvanceRequestInFlight = false;
      try {
        setActionBusy(target, false);
      } catch {
        // The request lock must still reset if a malformed action target throws.
      }
    }
  }

  /** @this {ResourceManagerApp} */
  static async _onForageDrive(_event, target) {
    if (!isAuthoritativeGM()) {
      notify("warn", `only the active GM can run a forage drive.`);
      return;
    }
    if (manualForageRequestInFlight) return;
    manualForageRequestInFlight = true;
    try {
      setActionBusy(target, true);
      // Push a one-off Survival check (GM-set DC) to chosen party members and
      // deposit what they gather — no consumption, no day tick.
      const { defaultDc, stashName, candidates } = describeForageDrive();
      if (candidates.length === 0) {
        ui.notifications?.info(
          `${MODULE_ID}: add party members before running a forage drive.`,
        );
        return;
      }
      const DialogV2 = foundry?.applications?.api?.DialogV2;
      if (typeof DialogV2?.prompt !== "function") return;

      const anyOnline = candidates.some((c) => c.online);
      const rows = candidates
        .map((c) => {
          const dis = c.online ? "" : " disabled";
          const tag = c.online
            ? ""
            : ' <span style="opacity:0.6;">(offline)</span>';
          return `<label style="display:flex; align-items:center; gap:6px;">
          <input type="checkbox" name="forager" value="${escapeHtml(c.actorId)}" ${c.online ? "checked" : ""}${dis} />
          <span>${escapeHtml(c.name)}${tag}</span>
        </label>`;
        })
        .join("");
      const destLine = stashName
        ? `Gathered supplies go to <strong>${escapeHtml(stashName)}</strong>'s stash.`
        : `No party stash set — each forager keeps their own haul.`;
      const content = `
      <p>Send a Wisdom (Survival) check to the selected players. Those who meet the DC add food &amp; water to the party's supplies.</p>
      <label class="rm-field" style="display:grid; gap:4px; margin-bottom:8px;">
        <span>Survival DC</span>
        <input type="number" name="dc" min="1" step="1" value="${Number(defaultDc) || 15}" />
      </label>
      <fieldset style="border:1px solid var(--color-border-light-tertiary,#5553); border-radius:6px; padding:6px 10px;">
        <legend>Foragers</legend>
        ${rows || "<p>No party members.</p>"}
      </fieldset>
      <p style="opacity:0.8; margin:8px 0 0;">${destLine}</p>
      ${anyOnline ? "" : '<p style="color:#ef6f74; margin:6px 0 0;">No selected player is online to roll right now.</p>'}`;

      let result = null;
      try {
        result = await DialogV2.prompt({
          window: { title: "Forage Drive", icon: "fa-solid fa-wheat-awn" },
          content,
          ok: {
            label: "Send check",
            icon: "fa-solid fa-paper-plane",
            callback: (_e, button) => {
              const form = button?.form;
              if (!form) return null;
              const dc = Math.max(1, Number(form.elements?.dc?.value) || 0);
              const ids = Array.from(
                form.querySelectorAll('input[name="forager"]:checked'),
              ).map((el) => el.value);
              return { dc, ids };
            },
          },
          rejectClose: false,
        });
      } catch {
        result = null;
      }
      if (!result) return;
      if (!Array.isArray(result.ids) || result.ids.length === 0) {
        notify("info", `select at least one forager.`);
        return;
      }
      playModuleSound(SOUND_EVENTS.ROLL_START);
      await runForageDrive({ dc: result.dc, targetActorIds: result.ids });
      this.render(false);
    } finally {
      manualForageRequestInFlight = false;
      try {
        setActionBusy(target, false);
      } catch {
        // Keep the request lock recoverable even with a malformed target.
      }
    }
  }

  /** @this {ResourceManagerApp} */
  static async _onClearInterruptedRun() {
    if (!isAuthoritativeGM()) {
      notify("warn", `only the active GM can clear an interrupted run.`);
      return;
    }
    const activeUpkeep = loadRunState().activeUpkeep;
    if (!activeUpkeep?.runId) return;
    const confirmed = await confirmDestructive({
      title: "Clear interrupted resource run?",
      content:
        "<p>This releases the safety lock only. It will not restore inventory or replay the interrupted run.</p>" +
        "<p>Review the party's supplies first, then clear the lock to resume Quartermaster automation.</p>",
      icon: "fa-solid fa-unlock",
    });
    if (!confirmed) return;
    await clearUpkeepClaim(activeUpkeep.runId);
    notify("info", `cleared the interrupted resource-run lock.`);
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
    const resource = config.resources.find((entry) => entry.id === id);
    const confirmed = await confirmDestructive({
      title: "Remove tracked resource?",
      content: `<p>Stop tracking <strong>${escapeHtml(resource?.label ?? id)}</strong>? Existing actor items will not be deleted.</p>`,
      icon: "fa-solid fa-trash",
    });
    if (!confirmed) return;
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
    const actor = discoverAllActors().find((entry) => entry.id === actorId);
    if (!actor) return;
    const config = loadResourceConfig();
    seedRosterIfEmpty(config);
    if (!config.roster.some((r) => r.actorId === actorId)) {
      config.roster.push({
        actorId,
        isStash: false,
        consumes: discoverPlayerCharacters().some(
          (character) => character.id === actorId,
        ),
        drawFrom: "self",
      });
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
    const actorName = globalThis.game?.actors?.get?.(actorId)?.name ?? actorId;
    const confirmed = await confirmDestructive({
      title: "Remove party member?",
      content: `<p>Remove <strong>${escapeHtml(actorName)}</strong> from Quartermaster tracking?</p>`,
      icon: "fa-solid fa-user-minus",
    });
    if (!confirmed) return;
    config.roster = config.roster.filter((r) => r.actorId !== actorId);
    if (config.partyStashId === actorId) config.partyStashId = "";
    await saveResourceConfig(config);
    playModuleSound(SOUND_EVENTS.ROSTER_REMOVE);
    this.render(false);
  }

  /** @this {ResourceManagerApp} */
  static async _onCopyEnvironment() {
    if (!isAuthoritativeGM()) {
      notify(
        "warn",
        "only the active GM can copy and activate an environment.",
      );
      return;
    }
    const config = loadResourceConfig();
    const state = loadRunState();
    const requestedEnvironmentId =
      state.currentEnvironmentId ||
      getSetting(SETTING_KEYS.RESOURCE_DEFAULT_ENVIRONMENT) ||
      "limited";
    const sourceEnvironment =
      findEnvironment(config.environments, requestedEnvironmentId) ??
      config.environments[0] ??
      null;
    const copied = duplicateEnvironment(
      config.environments,
      sourceEnvironment?.id,
    );
    if (!copied.ok || !copied.environment) {
      notify(
        "warn",
        copied.errors?.environment ??
          Object.values(copied.errors ?? {})[0] ??
          "the current environment could not be copied.",
      );
      return;
    }

    config.environments = copied.catalog;
    await saveResourceConfig(config);
    await setCurrentEnvironment(copied.environment.id);
    playModuleSound(SOUND_EVENTS.PRESET_APPLY);
    notify("info", `created custom region ${copied.environment.label}.`);
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
    const defaults = createDefaultResourceConfig();
    await Promise.all([saveResourceConfig(defaults), resetResourceRules()]);
    const currentEnvironmentId = loadRunState().currentEnvironmentId;
    if (
      isAuthoritativeGM() &&
      !findEnvironment(defaults.environments, currentEnvironmentId)
    ) {
      const configuredDefault = getSetting(
        SETTING_KEYS.RESOURCE_DEFAULT_ENVIRONMENT,
      );
      const fallback =
        findEnvironment(defaults.environments, configuredDefault) ??
        defaults.environments[0] ??
        null;
      await setCurrentEnvironment(fallback?.id ?? "limited");
    }
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
    consumes: true,
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

function setActionBusy(target, busy) {
  if (!target || typeof target !== "object") return;
  target.disabled = busy;
  if (busy) target.setAttribute?.("aria-busy", "true");
  else target.removeAttribute?.("aria-busy");
}

/** Plain-language foraging note for a per-actor report row. Distinguishes
 *  "foraged nothing" (was prompted, no haul) from "" (never foraged). */
function forageNote(foraged) {
  const f = foraged ?? {};
  if (!f.attempted) return "";
  if (f.suppressed) return "gathered; best party haul kept";
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

function presentOverviewReport(report, environments = []) {
  if (!report || typeof report !== "object") return null;
  const reportEnvironment = findEnvironment(environments, report.environmentId);
  return {
    ...report,
    environmentLabel: report.environmentId
      ? reportEnvironment
        ? environmentDisplayLabel(reportEnvironment)
        : prettyEnvironment(report.environmentId) || report.environmentId
      : "—",
    rows: report.rows.map((row) => ({
      ...row,
      forageNote: forageNote(row.forage),
      ok: row.supplied && !row.hasErrors,
    })),
  };
}

function environmentDisplayLabel(environment) {
  if (!environment) return "";
  if (isCustomEnvironment(environment)) {
    return String(environment.label ?? environment.id ?? "").trim();
  }
  return (
    prettyEnvironment(environment.id) || environment.label || environment.id
  );
}

function resourceIcon(id) {
  if (id === "food") return "fa-solid fa-bread-slice";
  if (id === "water") return "fa-solid fa-droplet";
  if (id === "light") return "fa-solid fa-fire-flame-simple";
  return "fa-solid fa-box";
}

/** Parse an Item UUID from a Foundry drag-drop event. */
function cssEscape(value) {
  const text = String(value ?? "");
  return globalThis.CSS?.escape?.(text) ?? text.replace(/["\\]/g, "\\$&");
}

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
