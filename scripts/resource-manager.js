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
  createEnvironment,
  duplicateEnvironment,
  findEnvironment,
  isCustomEnvironment,
  moveCustomEnvironment,
  removeCustomEnvironment,
  updateEnvironmentFields,
} from "./resource/environment.js";
import { presentRecentRuns } from "./resource/history.js";
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
import { pickSearchOption } from "./search-picker.js";
import { loadCompendiumItems } from "./loot/pack.js";
import { bindFocusRestoration, navigateToAppSection } from "./infinity-app.js";
import { initializePrivateState } from "./private-state.js";
import { normalizeInfinityItemUuid } from "./item-uuid-compat.js";
import {
  confirmInfinityDialog,
  isInfinityDialogAvailable,
  promptInfinityDialog,
} from "./dialog-contract.js";
import { promptForageDriveDialog } from "./forage-drive-dialog.js";

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
      addTagByUuid: ResourceManagerApp._onAddTagByUuid,
      removeTag: ResourceManagerApp._onRemoveTag,
      addRosterMember: ResourceManagerApp._onAddRosterMember,
      removeRosterMember: ResourceManagerApp._onRemoveRosterMember,
      createEnvironment: ResourceManagerApp._onCreateEnvironment,
      copyEnvironment: ResourceManagerApp._onCopyEnvironment,
      moveEnvironment: ResourceManagerApp._onMoveEnvironment,
      removeEnvironment: ResourceManagerApp._onRemoveEnvironment,
      resetConfig: ResourceManagerApp._onResetConfig,
      refresh: ResourceManagerApp._onRefresh,
      selectSection: navigateToAppSection,
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
      bindFocusRestoration(ResourceManagerApp._instance);
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
    this._setupExpanded = false;
    this._unsubs = [
      subscribe(RESOURCE_EVENTS.STATE_UPDATE, () => this.render(false)),
      subscribe(RESOURCE_EVENTS.UPKEEP_REPORT, () => this.render(false)),
    ];
    this._userConnectionHook =
      globalThis.Hooks?.on?.("userConnected", () => {
        if (!this.rendered) return;
        void initializePrivateState()
          .then((ready) => {
            if (ready && this.rendered) this.render(false);
          })
          .catch(() => {
            // The central recovery loop will retry. Keep the existing verified
            // view in place rather than surfacing a transient render failure.
          });
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
    this._setupExpanded = false;
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
    const customEnvironmentIds = config.environments
      .filter((environment) => isCustomEnvironment(environment))
      .map((environment) => environment.id);
    const currentCustomIndex = currentEnv
      ? customEnvironmentIds.indexOf(currentEnv.id)
      : -1;

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
    if (hasBlockingResourceConflicts) this._setupExpanded = true;
    const isAuthoritative = isAuthoritativeGM();
    const activeUpkeep = state.activeUpkeep;
    const currentEnvForageable = Boolean(
      currentEnv && currentEnv.forageable !== false,
    );
    const currentEnvFoodDc = currentEnv?.foodDc ?? currentEnv?.dc ?? null;
    const currentEnvWaterDc = currentEnv?.waterDc ?? currentEnv?.dc ?? null;
    const canRunResourceWrites =
      isAuthoritative && !hasBlockingResourceConflicts && !activeUpkeep;
    const overview = buildResourceOverview({
      config,
      state,
      environment: currentEnv,
      autoTrigger,
      generatedAt: Date.now(),
      roster: rosterSnapshots,
    });
    const recentRuns = presentRecentRuns(state.recentRuns);
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
            const canonicalUuid = normalizeInfinityItemUuid(uuid);
            let name = canonicalUuid;
            let missing = true;
            try {
              const doc = await fromUuid(canonicalUuid);
              if (doc?.name) {
                name = doc.name;
                missing = false;
              }
            } catch {
              /* keep raw uuid + missing flag */
            }
            return { uuid: canonicalUuid, name, missing };
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
      canCreateEnvironment: isAuthoritative,
      canMoveEnvironmentEarlier: isFullGM() && currentCustomIndex > 0,
      canMoveEnvironmentLater:
        isFullGM() &&
        currentCustomIndex >= 0 &&
        currentCustomIndex < customEnvironmentIds.length - 1,
      canRemoveEnvironment:
        isAuthoritative && Boolean(currentEnv?.id) && currentCustomIndex >= 0,
      currentEnvLabel: currentEnv ? environmentDisplayLabel(currentEnv) : "—",
      currentEnvForageable: currentEnv ? currentEnvForageable : false,
      currentEnvDc: currentEnv?.dc ?? null,
      currentEnvFoodDc,
      currentEnvWaterDc,
      currentEnvDcsDiffer:
        currentEnvFoodDc !== null &&
        currentEnvWaterDc !== null &&
        currentEnvFoodDc !== currentEnvWaterDc,
      forageMode: config.forageMode,
      forageModeEach: config.forageMode === "each",
      halfRations: config.halfRations,
      waterEnabled: config.waterEnabled,
      maxCatchUpDays: config.maxCatchUpDays,
      autoTrigger,
      isAuthoritative,
      canRunResourceWrites,
      canRunForageDrive: canRunResourceWrites && currentEnvForageable,
      hasActiveUpkeep: Boolean(activeUpkeep),
      activeUpkeep: activeUpkeep
        ? {
            ...activeUpkeep,
            triggerLabel:
              activeUpkeep.trigger === "calendar"
                ? "automatic day change"
                : activeUpkeep.trigger === "forage"
                  ? "forage drive"
                  : "manual daily supplies",
            dayLabel:
              activeUpkeep.day == null
                ? "unknown day"
                : `day ${activeUpkeep.day}`,
          }
        : null,
      resourceConflictWarnings,
      hasResourceConflictWarnings: resourceConflictWarnings.length > 0,
      hasBlockingResourceConflicts,
      setupExpanded: this._setupExpanded === true,
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
      recentRuns,
      hasRecentRuns: recentRuns.length > 0,
      recentRunCountLabel: `${recentRuns.length} saved`,
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

    const setupDisclosure = root.querySelector(
      "[data-role='setup-disclosure']",
    );
    setupDisclosure?.addEventListener("toggle", (event) => {
      this._setupExpanded = event.currentTarget?.open === true;
    });

    // Enter = primary action (Use Daily Supplies), matching the loot tools.
    // Bound once; skips form fields and respects the keyboard-shortcuts setting.
    // The action confirms first, so an accidental Enter can't blow through.
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
      envSelect.addEventListener("change", (event) =>
        this._onEnvironmentSelection(event.currentTarget),
      );
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

  async _onEnvironmentSelection(input) {
    const environmentId = String(input?.value ?? "").trim();
    return await enqueueEnvironmentMutation(this, async () => {
      if (!isAuthoritativeGM()) {
        notify(
          "warn",
          "only the active GM can change the current environment.",
        );
        await this._renderPreservingFocus(input);
        return;
      }
      await setCurrentEnvironment(environmentId);
      await this._renderPreservingFocus(input);
    });
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
    return await enqueueEnvironmentMutation(this, async () => {
      if (!isFullGM()) {
        notify("warn", "only a full GM can edit custom environments.");
        await this._renderPreservingFocus(input);
        return;
      }
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
    });
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
      const ok = await confirmInfinityDialog({
        window: {
          title: "Use daily supplies?",
          icon: "fa-solid fa-utensils",
        },
        content: `<p>Consume one day of supplies for <strong>${party.length}</strong> character(s)?</p><p style="opacity:0.8;">This burns the configured daily resources without foraging or changing the world clock, and runs even if auto-upkeep is off.</p>`,
        rejectClose: false,
      });
      if (!ok) return;
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
      const {
        defaultDc,
        defaultFoodDc,
        defaultWaterDc,
        environmentLabel,
        forageable,
        stashName,
        candidates,
        canForageFood,
        canForageWater,
      } = describeForageDrive();
      if (candidates.length === 0) {
        ui.notifications?.info(
          "Add party members in Setup & Rules before starting a forage drive. Nothing changed.",
        );
        return;
      }
      if (!canForageFood && !canForageWater) {
        notify("warn", `enable and configure food or water before foraging.`);
        return;
      }
      if (!forageable) {
        notify(
          "warn",
          `${environmentLabel} does not allow foraging. Choose a forageable environment first; nothing changed.`,
        );
        return;
      }

      const result = await promptForageDriveDialog({
        defaultDc,
        defaultFoodDc,
        defaultWaterDc,
        environmentLabel,
        stashName,
        candidates,
        canForageFood,
        canForageWater,
      });
      if (!result) return;
      if (!Array.isArray(result.foragers) || result.foragers.length === 0) {
        notify("info", `select at least one forager.`);
        return;
      }
      playModuleSound(SOUND_EVENTS.ROLL_START);
      await runForageDrive({
        foodDc: result.foodDc,
        waterDc: result.waterDc,
        foragers: result.foragers,
      });
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
        "<p>Review the party's supplies first. Quartermaster will save a receipt that explicitly marks the inventory outcome as unknown.</p>",
      icon: "fa-solid fa-unlock",
    });
    if (!confirmed) return;
    await clearUpkeepClaim(activeUpkeep.runId);
    notify("info", `cleared the lock and recorded the interrupted run.`);
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
  /** Keyboard-friendly alternative to drag-to-tag using the shared item picker. */
  static async _onAddTag(_event, target) {
    const id = target?.dataset?.resourceId;
    if (!id) return;
    const initialConfig = loadResourceConfig();
    const initialResource = initialConfig.resources.find(
      (resource) => resource.id === id,
    );
    if (!initialResource) return;

    let compendiumItems = [];
    try {
      compendiumItems = await loadCompendiumItems();
    } catch {
      compendiumItems = [];
    }
    const itemCandidates = [];
    for (const item of compendiumItems) {
      if (!item?.uuid || !item?.name) continue;
      itemCandidates.push({
        uuid: item.uuid,
        name: item.name,
        type: item.type,
        img: item.img,
        source: "Infinity item library",
      });
    }
    for (const actor of discoverAllActors()) {
      for (const item of actorItemSnapshots(actor)) {
        if (!item?.uuid || !item?.name) continue;
        itemCandidates.push({
          uuid: item.uuid,
          name: item.name,
          type: item.type,
          img: item.img,
          source: actor.name ?? "Actor inventory",
        });
      }
    }
    const candidatesByUuid = new Map();
    for (const item of itemCandidates) {
      if (!candidatesByUuid.has(item.uuid))
        candidatesByUuid.set(item.uuid, item);
    }
    const existingUuids = new Set(initialResource.matching.itemUuids ?? []);
    const uuid = await pickSearchOption({
      title: `Match an item to ${initialResource.label ?? "resource"}`,
      hint: "Search the item library and Actor inventories. The item and resource are checked again before anything changes.",
      options: [...candidatesByUuid.values()]
        .filter((item) => !existingUuids.has(item.uuid))
        .map((item) => ({
          id: item.uuid,
          label: item.name,
          description: `${item.source}${item.type ? ` · ${item.type}` : ""}`,
          img: item.img,
          keywords: `${item.type ?? ""} ${item.source}`,
        })),
      confirmLabel: "Match item",
    });
    if (!uuid || !candidatesByUuid.has(uuid)) return;
    if (!(await saveExactItemMatch(id, uuid))) return;
    playModuleSound(SOUND_EVENTS.DEPOSIT);
    this.render(false);
  }

  /** @this {ResourceManagerApp} */
  /** Preserve exact matching for items outside the searchable local catalog. */
  static async _onAddTagByUuid(_event, target) {
    const id = target?.dataset?.resourceId;
    if (!id) return;
    const resource = loadResourceConfig().resources.find(
      (entry) => entry.id === id,
    );
    if (!resource) return;
    if (!isInfinityDialogAvailable("prompt")) {
      notify(
        "warn",
        "The UUID entry dialog could not open. Nothing changed; reload Foundry and try again.",
      );
      return;
    }

    const uuid = await promptInfinityDialog({
      window: {
        title: `Match an item to ${resource.label ?? "resource"}`,
        icon: "fa-solid fa-link",
      },
      content: `
        <div class="infinity-dnd5e">
          <p>Paste an Item UUID from any world or compendium source. Right-click the item and choose <strong>Copy Document UUID</strong>.</p>
          <label style="display:grid;gap:4px;">
            <span>Item UUID</span>
            <input type="text" name="uuid" autocomplete="off" spellcheck="false" maxlength="1000" required />
          </label>
        </div>`,
      ok: {
        label: "Match item",
        icon: "fa-solid fa-link",
        callback: (_event, button) =>
          button?.form?.elements?.uuid?.value?.trim() ?? null,
      },
    });
    if (!uuid || !(await saveExactItemMatch(id, uuid))) return;
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
    const initialConfig = loadResourceConfig();
    seedRosterIfEmpty(initialConfig);
    const existingActorIds = new Set(
      initialConfig.roster.map((entry) => String(entry.actorId ?? "").trim()),
    );
    const actorOptions = discoverAllActors()
      .filter((actor) => actor?.id && !existingActorIds.has(actor.id))
      .map((actor) => ({
        id: actor.id,
        label: actor.name ?? "Unnamed Actor",
        description: actor.type
          ? `Actor type: ${actor.type}`
          : "Available Actor",
        img: actor.img,
        keywords: `${actor.type ?? ""} ${actor.folder?.name ?? ""}`,
      }));
    const actorId = await pickSearchOption({
      title: "Add Actor to Quartermaster",
      hint: "Search the available Actors. The selection is checked again before the roster changes.",
      options: actorOptions,
      confirmLabel: "Add to roster",
    });
    if (!actorId) return;
    // Any real actor is eligible — the GM may add NPCs / unowned actors as
    // supply sources, not just player characters.
    const actor = discoverAllActors().find((entry) => entry.id === actorId);
    if (!actor) return;
    // The picker can remain open while another GM changes Quartermaster setup.
    // Merge into the latest canonical config instead of writing the snapshot
    // used only to build the picker options.
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
  static async _onCreateEnvironment() {
    return await enqueueEnvironmentMutation(this, async () => {
      if (!isAuthoritativeGM()) {
        notify(
          "warn",
          "only the active GM can create and activate an environment.",
        );
        return;
      }
      const config = loadResourceConfig();
      const created = createEnvironment(config.environments);
      if (!created.ok || !created.environment) {
        notify(
          "warn",
          created.errors?.environment ??
            Object.values(created.errors ?? {})[0] ??
            "a custom region could not be created.",
        );
        return;
      }

      config.environments = created.catalog;
      try {
        await saveResourceConfig(config);
      } catch {
        notify(
          "warn",
          "Quartermaster could not confirm that the new custom region was saved. Review the environment list before trying again.",
        );
        await renderAndFocusEnvironmentControl(
          this,
          "[data-role='environment']",
        );
        return;
      }
      try {
        await setCurrentEnvironment(created.environment.id);
      } catch {
        notify(
          "warn",
          `saved custom region ${created.environment.label}, but could not confirm it became active. Review the current selection instead of creating another copy.`,
        );
        await renderAndFocusEnvironmentControl(
          this,
          "[data-role='environment']",
        );
        return;
      }
      playModuleSound(SOUND_EVENTS.PRESET_APPLY);
      notify("info", `created custom region ${created.environment.label}.`);
      await renderAndFocusEnvironmentControl(
        this,
        `[data-environment-id="${cssEscape(created.environment.id)}"][data-environment-field="label"]`,
      );
    });
  }

  /** @this {ResourceManagerApp} */
  static async _onCopyEnvironment() {
    return await enqueueEnvironmentMutation(this, async () => {
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
      try {
        await saveResourceConfig(config);
      } catch {
        notify(
          "warn",
          "Quartermaster could not confirm that the copied region was saved. Review the environment list before trying again.",
        );
        await renderAndFocusEnvironmentControl(
          this,
          "[data-role='environment']",
        );
        return;
      }
      try {
        await setCurrentEnvironment(copied.environment.id);
      } catch {
        notify(
          "warn",
          `saved custom region ${copied.environment.label}, but could not confirm it became active. Review the current selection instead of creating another copy.`,
        );
        await renderAndFocusEnvironmentControl(
          this,
          "[data-role='environment']",
        );
        return;
      }
      playModuleSound(SOUND_EVENTS.PRESET_APPLY);
      notify("info", `created custom region ${copied.environment.label}.`);
      await renderAndFocusEnvironmentControl(
        this,
        `[data-environment-id="${cssEscape(copied.environment.id)}"][data-environment-field="label"]`,
      );
    });
  }

  /** @this {ResourceManagerApp} */
  static async _onMoveEnvironment(_event, target) {
    const environmentId = String(target?.dataset?.environmentId ?? "").trim();
    const direction = String(target?.dataset?.direction ?? "").trim();
    return await enqueueEnvironmentMutation(this, async () => {
      if (!isFullGM()) {
        notify("warn", "only a full GM can reorder environments.");
        return;
      }
      if (
        !environmentId ||
        (direction !== "earlier" && direction !== "later")
      ) {
        notify("warn", "choose a custom region and a direction to move it.");
        return;
      }

      const config = loadResourceConfig();
      const moved = moveCustomEnvironment(
        config.environments,
        environmentId,
        direction,
      );
      if (!moved.ok) {
        notify(
          "warn",
          moved.errors?.environment ??
            moved.errors?.direction ??
            Object.values(moved.errors ?? {})[0] ??
            "the custom region could not be moved.",
        );
        return;
      }

      config.environments = moved.catalog;
      try {
        await saveResourceConfig(config);
      } catch {
        notify(
          "warn",
          "Quartermaster could not confirm the new custom-region order. Review the environment list before trying again.",
        );
        await renderAndFocusEnvironmentControl(
          this,
          "[data-role='environment']",
        );
        return;
      }
      playModuleSound(SOUND_EVENTS.PRESET_APPLY);
      await renderAndFocusEnvironmentControl(this, "[data-role='environment']");
    });
  }

  /** @this {ResourceManagerApp} */
  static async _onRemoveEnvironment(_event, target) {
    const environmentId = String(target?.dataset?.environmentId ?? "").trim();
    return await enqueueEnvironmentMutation(this, async () => {
      if (!isAuthoritativeGM()) {
        notify("warn", "only the active GM can remove environments.");
        return;
      }
      const before = loadResourceConfig();
      const environment = findEnvironment(before.environments, environmentId);
      const activeEnvironment = resolveCurrentEnvironment(before);
      if (!environment || !isCustomEnvironment(environment)) {
        notify("warn", "only a custom region can be removed.");
        return;
      }
      if (activeEnvironment?.id !== environmentId) {
        notify("warn", "select the custom region before removing it.");
        return;
      }

      const preview = removeCustomEnvironment(
        before.environments,
        environmentId,
      );
      const previewFallback = preview.fallbackId
        ? findEnvironment(preview.catalog, preview.fallbackId)
        : null;
      if (!preview.ok || !previewFallback) {
        notify(
          "warn",
          preview.errors?.environment ??
            Object.values(preview.errors ?? {})[0] ??
            "the custom region could not be removed.",
        );
        return;
      }
      const targetFingerprint = environmentFingerprint(environment);
      const fallbackFingerprint = environmentFingerprint(previewFallback);

      const confirmed = await confirmDestructive({
        title: "Remove custom region?",
        content: `<p>Remove <strong>${escapeHtml(environmentDisplayLabel(environment))}</strong> from the saved environment list? Built-in regions are kept.</p><p>Quartermaster will switch to <strong>${escapeHtml(environmentDisplayLabel(previewFallback))}</strong>.</p>`,
        icon: "fa-solid fa-trash",
      });
      if (!confirmed) return;
      if (!isAuthoritativeGM()) {
        notify(
          "warn",
          "active GM control changed while the confirmation was open; nothing was removed.",
        );
        return;
      }

      // Re-read every value shown in the confirmation before committing it.
      const config = loadResourceConfig();
      const currentTarget = findEnvironment(config.environments, environmentId);
      const currentActiveEnvironment = resolveCurrentEnvironment(config);
      const removed = removeCustomEnvironment(
        config.environments,
        environmentId,
      );
      const currentFallback = removed.fallbackId
        ? findEnvironment(removed.catalog, removed.fallbackId)
        : null;
      const confirmationIsCurrent = Boolean(
        currentTarget &&
        isCustomEnvironment(currentTarget) &&
        currentActiveEnvironment?.id === environmentId &&
        environmentFingerprint(currentTarget) === targetFingerprint &&
        removed.ok &&
        removed.fallbackId === preview.fallbackId &&
        currentFallback &&
        environmentFingerprint(currentFallback) === fallbackFingerprint,
      );
      if (!confirmationIsCurrent) {
        notify(
          "warn",
          "the active region or removal fallback changed; review the current list and try again.",
        );
        await renderAndFocusEnvironmentControl(
          this,
          "[data-role='environment']",
        );
        return;
      }

      // Switch first: if run-state persistence fails, the active id still
      // points at an environment that remains in the saved catalog.
      try {
        await setCurrentEnvironment(removed.fallbackId);
      } catch {
        notify(
          "warn",
          "Quartermaster could not confirm the fallback environment, so the custom region was not removed. Review the current environment before trying again.",
        );
        await renderAndFocusEnvironmentControl(
          this,
          "[data-role='environment']",
        );
        return;
      }
      config.environments = removed.catalog;
      try {
        await saveResourceConfig(config);
      } catch {
        notify(
          "warn",
          `Quartermaster switched to ${environmentDisplayLabel(currentFallback)}, but could not confirm removal of ${environmentDisplayLabel(environment)}. Review the environment list before trying again.`,
        );
        await renderAndFocusEnvironmentControl(
          this,
          "[data-role='environment']",
        );
        return;
      }
      playModuleSound(SOUND_EVENTS.PRESET_APPLY);
      notify(
        "info",
        `removed custom region ${environmentDisplayLabel(environment)}.`,
      );
      await renderAndFocusEnvironmentControl(this, "[data-role='environment']");
    });
  }

  /** @this {ResourceManagerApp} */
  static async _onResetConfig(_event, _target) {
    const ok = await confirmInfinityDialog({
      window: {
        title: "Reset Quartermaster?",
        icon: "fa-solid fa-rotate-left",
      },
      content:
        "<p>Reset all resource definitions and environments to the defaults? Your day-tracking is kept.</p>",
      rejectClose: false,
    });
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

function enqueueEnvironmentMutation(app, operation) {
  const previous = app?._environmentMutationQueue ?? Promise.resolve();
  const task = previous.catch(() => {}).then(operation);
  if (app) app._environmentMutationQueue = task;
  return task.finally(() => {
    if (app?._environmentMutationQueue === task) {
      app._environmentMutationQueue = null;
    }
  });
}

function resolveCurrentEnvironment(config) {
  const requestedId =
    loadRunState().currentEnvironmentId ||
    getSetting(SETTING_KEYS.RESOURCE_DEFAULT_ENVIRONMENT) ||
    "limited";
  return (
    findEnvironment(config?.environments, requestedId) ??
    config?.environments?.[0] ??
    null
  );
}

function environmentFingerprint(environment) {
  if (!environment) return "";
  return JSON.stringify({
    id: environment.id,
    label: environment.label,
    dc: environment.dc,
    foodDc: environment.foodDc,
    waterDc: environment.waterDc,
    forageable: environment.forageable,
    yieldFood: environment.yieldFood,
    yieldWater: environment.yieldWater,
    builtIn: environment.builtIn,
  });
}

async function renderAndFocusEnvironmentControl(app, selector) {
  await app?.render?.(false);
  app?.element?.querySelector?.(selector)?.focus?.();
}

/** Resolve and persist one exact Item UUID against the latest resource config. */
async function saveExactItemMatch(resourceId, rawUuid) {
  const uuid = normalizeInfinityItemUuid(rawUuid);
  if (!uuid || uuid.length > 1000) {
    notify(
      "warn",
      "Enter a valid Item UUID. Nothing changed; copy the UUID from the item's context menu and try again.",
    );
    return false;
  }

  if (typeof globalThis.fromUuid !== "function") {
    notify(
      "warn",
      "The Item UUID could not be checked on this client. Nothing changed; reload Foundry and try again.",
    );
    return false;
  }

  let item = null;
  try {
    item = await globalThis.fromUuid(uuid);
  } catch {
    item = null;
  }
  const documentName = String(
    item?.documentName ?? item?.constructor?.documentName ?? "",
  );
  if (!item || documentName !== "Item") {
    notify(
      "warn",
      "That UUID does not resolve to an Item. Nothing changed; copy an Item UUID and try again.",
    );
    return false;
  }

  // The picker or dialog may remain open while another GM edits setup. Merge
  // into the latest canonical configuration immediately before the write.
  const config = loadResourceConfig();
  const resource = config.resources.find((entry) => entry.id === resourceId);
  if (!resource) {
    notify(
      "warn",
      "That resource no longer exists. Nothing changed; refresh Quartermaster and try again.",
    );
    return false;
  }
  const uuids = new Set(resource.matching.itemUuids ?? []);
  if (uuids.has(uuid)) {
    notify("info", "That item is already matched. Nothing changed.");
    return false;
  }
  uuids.add(uuid);
  resource.matching.itemUuids = [...uuids];
  await saveResourceConfig(config);
  return true;
}

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
      ok: row.outcome === "supplied",
      stateClass:
        row.outcome === "needs-review"
          ? "is-review"
          : row.supplied
            ? "is-ok"
            : "is-short",
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
