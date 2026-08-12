/**
 * Infinity D&D5e - Downtime Workspace (full-GM interface)
 *
 * This application intentionally knows nothing about rolls or document writes.
 * It consumes an authoritative workspace projection and sends bounded commands
 * through an adapter supplied by the downtime subsystem during module setup.
 */

import {
  applyVisualPrefs,
  bindFullGmWindowGuard,
  openSingleton,
} from "./infinity-app.js";
import { confirmInfinityDialog } from "./dialog-contract.js";
import { runAsFullGM } from "./permissions.js";
import { dismissQuickStart, getUiPreferences } from "./ui-preferences.js";

const MODULE_ID = "infinity-dnd5e";
const TEMPLATE_PATH = `modules/${MODULE_ID}/templates/downtime-workspace.hbs`;
export const DOWNTIME_WORKSPACE_QUICK_START_ID = "downtime-workspace:v0.3.0";
const DEFAULT_VIEW = "current";
const WORKSPACE_VIEWS = new Set([
  "current",
  "projects",
  "settlements",
  "history",
]);
const GUIDED_PROJECT_SKILLS = Object.freeze([
  ["arc", "Arcana"],
  ["ath", "Athletics"],
  ["his", "History"],
  ["ins", "Insight"],
  ["inv", "Investigation"],
  ["nat", "Nature"],
  ["per", "Performance"],
  ["rel", "Religion"],
  ["slt", "Sleight of Hand"],
  ["sur", "Survival"],
]);
const ACTOR_SELECTOR_SCOPES = new Set([
  "player-owned",
  "other",
  "selected",
  "all",
]);
const ACTOR_SELECTOR_SORTS = new Set([
  "name-asc",
  "name-desc",
  "owner",
  "folder",
  "selected-first",
]);
const DEFAULT_ACTIVITY_IDS = [
  "craft-ammunition",
  "sharpen-weapon",
  "market-trading",
  "pickpocket",
  "shoplift",
  "fence-stolen-goods",
  "lay-low",
];
const WORKFLOW_STEPS = Object.freeze([
  {
    id: "create",
    label: "Create",
    description: "Set the location, productive hours, and eligible characters.",
  },
  {
    id: "collect",
    label: "Collect",
    description: "Players build and submit their activity queues.",
  },
  {
    id: "lock",
    label: "Lock",
    description: "Close submissions so queued activities cannot change.",
  },
  {
    id: "preview",
    label: "Preview",
    description: "Generate and review the immutable write plan.",
  },
  {
    id: "apply",
    label: "Apply",
    description: "Execute the exact saved plan without rerolling.",
  },
  {
    id: "complete",
    label: "Complete",
    description: "Review the receipt, then start the next block.",
  },
]);
const PRIMARY_ACTION_COPY = Object.freeze({
  createBlock: {
    label: "Open block",
    description: "Create the block so players can prepare their queues.",
  },
  openForPlayers: {
    label: "Open for players",
    description: "Invite assigned players to review and submit their queues.",
  },
  lockBlock: {
    label: "Lock submissions",
    description: "Close queue editing and move this block toward preview.",
  },
  planBlock: {
    label: "Generate preview",
    description: "Build the immutable plan for GM review.",
  },
  applyBlock: {
    label: "Apply exact plan",
    description: "Apply the reviewed saved plan without rerolling.",
  },
  recoverBlock: {
    label: "Verify and recover",
    description:
      "Verify saved operations before retrying only proven-unapplied work.",
  },
  beginNextBlock: {
    label: "Start next block",
    description: "Keep this receipt and prepare a new downtime block.",
  },
});

const { ApplicationV2, HandlebarsApplicationMixin } = foundry.applications.api;

/**
 * Adapter expected by {@link DowntimeWorkspaceApp}.
 *
 * Required read method:
 * - getWorkspaceProjection({ view, settlementId })
 *
 * Optional command methods mirror the data-action names below. Every command
 * receives a plain ID/value payload; the adapter must derive authority, rolls,
 * costs, DCs, rewards, and document mutations itself.
 */
export class DowntimeWorkspaceApp extends HandlebarsApplicationMixin(
  ApplicationV2,
) {
  static _instance = null;
  static _adapterFactory = null;

  static DEFAULT_OPTIONS = {
    id: "infinity-dnd5e-downtime-workspace",
    tag: "section",
    classes: ["infinity-dnd5e", "infinity-downtime-workspace"],
    window: {
      title: "Infinity D&D5e - Downtime Workspace",
      icon: "fa-solid fa-hourglass-half",
      resizable: true,
    },
    position: { width: 1040, height: 760 },
    actions: {
      setView: DowntimeWorkspaceApp._onSetView,
      refresh: DowntimeWorkspaceApp._onRefresh,
      dismissQuickStart: DowntimeWorkspaceApp._onDismissQuickStart,
      setHourPreset: DowntimeWorkspaceApp._onSetHourPreset,
      setActorScope: DowntimeWorkspaceApp._onSetActorScope,
      selectShownActors: DowntimeWorkspaceApp._onSelectShownActors,
      clearShownActors: DowntimeWorkspaceApp._onClearShownActors,
      restoreActorDefaults: DowntimeWorkspaceApp._onRestoreActorDefaults,
      beginNextBlock: DowntimeWorkspaceApp._onBeginNextBlock,
      createBlock: DowntimeWorkspaceApp._onCreateBlock,
      openForPlayers: DowntimeWorkspaceApp._onOpenForPlayers,
      lockBlock: DowntimeWorkspaceApp._onLockBlock,
      planBlock: DowntimeWorkspaceApp._onPlanBlock,
      chooseGuidedOutcome: DowntimeWorkspaceApp._onChooseGuidedOutcome,
      applyBlock: DowntimeWorkspaceApp._onApplyBlock,
      cancelBlock: DowntimeWorkspaceApp._onCancelBlock,
      recoverBlock: DowntimeWorkspaceApp._onRecoverBlock,
      newSettlement: DowntimeWorkspaceApp._onNewSettlement,
      selectSettlement: DowntimeWorkspaceApp._onSelectSettlement,
      saveSettlement: DowntimeWorkspaceApp._onSaveSettlement,
      deleteSettlement: DowntimeWorkspaceApp._onDeleteSettlement,
      saveGuidedProject: DowntimeWorkspaceApp._onSaveGuidedProject,
    },
  };

  static PARTS = {
    body: { template: TEMPLATE_PATH },
  };

  /** Configure the authoritative adapter without coupling this UI to storage. */
  static configure({ adapterFactory } = {}) {
    this._adapterFactory =
      typeof adapterFactory === "function" ? adapterFactory : null;
  }

  /** Open or focus the singleton full-GM workspace. */
  static open({ adapter = null, view = DEFAULT_VIEW } = {}) {
    return runAsFullGM(() => {
      const resolvedAdapter = adapter ?? this._adapterFactory?.() ?? null;
      const app = openSingleton(
        DowntimeWorkspaceApp,
        () => new DowntimeWorkspaceApp({ adapter: resolvedAdapter, view }),
      );
      if (resolvedAdapter && app._adapter !== resolvedAdapter) {
        app._replaceAdapter(resolvedAdapter);
      }
      if (WORKSPACE_VIEWS.has(view) && app._view !== view) {
        app._view = view;
        if (app.rendered) app.render(false);
      }
      return app;
    }, "Downtime Workspace is available to full GMs only.");
  }

  constructor(options = {}) {
    const {
      adapter = null,
      view = DEFAULT_VIEW,
      ...applicationOptions
    } = options;
    super(applicationOptions);
    this._adapter = adapter;
    this._view = WORKSPACE_VIEWS.has(view) ? view : DEFAULT_VIEW;
    this._selectedSettlementId = null;
    this._activeBlockId = "";
    this._creatingSettlement = false;
    this._newBlockMode = false;
    this._busy = false;
    this._statusMessage = "";
    this._errorMessage = "";
    this._projectionErrorMessage = "";
    this._pendingFocus = null;
    this._actorSelectorState = createActorSelectorState();
    this._unsubscribe = null;
    this._unbindFullGmWindowGuard = bindFullGmWindowGuard(this);
    this._bindAdapter();
  }

  _onClose(options) {
    super._onClose?.(options);
    this._unsubscribe?.();
    this._unsubscribe = null;
    this._unbindFullGmWindowGuard?.();
    this._unbindFullGmWindowGuard = null;
    DowntimeWorkspaceApp._instance = null;
  }

  _replaceAdapter(adapter) {
    this._unsubscribe?.();
    this._unsubscribe = null;
    this._adapter = adapter;
    this._bindAdapter();
  }

  _bindAdapter() {
    if (typeof this._adapter?.subscribe !== "function") return;
    const unsubscribe = this._adapter.subscribe(
      () => {
        if (this.rendered && !this._busy) this.render(false);
      },
      { scope: "gm-workspace" },
    );
    if (typeof unsubscribe === "function") this._unsubscribe = unsubscribe;
  }

  async _prepareContext() {
    let projection = null;
    let dataAvailable = false;
    try {
      const readProjection = this._adapter?.getWorkspaceProjection;
      if (typeof readProjection !== "function") {
        throw new Error("DowntimeWorkspaceAdapterUnavailable");
      }
      projection = await readProjection.call(this._adapter, {
        view: this._view,
        settlementId: this._selectedSettlementId,
      });
      if (!projection || typeof projection !== "object") {
        throw new Error("DowntimeWorkspaceProjectionUnavailable");
      }
      dataAvailable = true;
      this._projectionErrorMessage = "";
    } catch (error) {
      console.error(
        `${MODULE_ID} | downtime workspace projection failed`,
        error,
      );
      this._projectionErrorMessage = workspaceProjectionErrorMessage(error);
      projection = {
        workflowStatus: "unavailable",
        canCreateBlock: false,
        createBlockReason:
          "Downtime data must load before anything can change.",
      };
    }

    this._actorSelectorState ??= createActorSelectorState();
    const context = normalizeWorkspaceProjection(projection, {
      view: this._view,
      selectedSettlementId: this._selectedSettlementId,
      creatingSettlement: this._creatingSettlement,
      newBlockMode: this._newBlockMode,
      actorSelector: this._actorSelectorState,
    });
    if (dataAvailable) {
      this._adoptActorSelectorProjection?.(context.actorSelector);
      this._reconcileActorSelector?.(context.actors);
    }
    this._selectedSettlementId = context.selectedSettlement?.id ?? null;
    this._activeBlockId = cleanId(context.currentBlock?.id);

    const errorMessage = this._projectionErrorMessage || this._errorMessage;
    const uiPreferences = getUiPreferences();
    return {
      ...context,
      dataAvailable,
      busy: this._busy,
      statusMessage: this._statusMessage,
      errorMessage,
      hasError: Boolean(errorMessage),
      showQuickStart: !uiPreferences.dismissedQuickStarts.includes(
        DOWNTIME_WORKSPACE_QUICK_START_ID,
      ),
    };
  }

  _onRender(context, options) {
    super._onRender?.(context, options);
    applyVisualPrefs(this.element, "dt-");
    this._bindActorSelector(context);
    this._restoreFocus();
  }

  _reconcileActorSelector(actors) {
    const available = new Set(array(actors).map((actor) => actor.id));
    if (available.size === 0) {
      this._actorSelectorState.selectedActorIds = null;
      return;
    }
    if (!(this._actorSelectorState?.selectedActorIds instanceof Set)) {
      this._actorSelectorState.selectedActorIds = new Set(
        array(actors)
          .filter((actor) => actor.checked)
          .map((actor) => actor.id),
      );
      return;
    }
    this._actorSelectorState.selectedActorIds = new Set(
      [...this._actorSelectorState.selectedActorIds].filter((id) =>
        available.has(id),
      ),
    );
  }

  _adoptActorSelectorProjection(selector) {
    const source = selector && typeof selector === "object" ? selector : {};
    const normalized = normalizeActorSelectorState({
      ...this._actorSelectorState,
      scope: source.scope ?? this._actorSelectorState?.scope,
      query: source.query ?? this._actorSelectorState?.query,
      ownerId: source.ownerId ?? this._actorSelectorState?.ownerId,
      folderId: source.folderId ?? this._actorSelectorState?.folderId,
      sort: source.sort ?? this._actorSelectorState?.sort,
    });
    Object.assign(this._actorSelectorState, normalized);
  }

  _bindActorSelector(context) {
    if (context?.dataAvailable === false || context?.hasActors === false)
      return;
    const root = this.element?.querySelector?.("[data-actor-selector]");
    if (!root) return;
    this._adoptActorSelectorProjection(context?.actorSelector);
    this._actorSelectorState.selectedActorIds = new Set(
      array(context?.actors)
        .filter((actor) => actor.checked)
        .map((actor) => actor.id),
    );

    root
      .querySelector?.("[data-actor-query]")
      ?.addEventListener?.("input", (event) => {
        if (this._busy) return;
        this._actorSelectorState.query = String(
          event.target?.value ?? "",
        ).slice(0, 200);
        this._applyActorSelector();
      });
    root
      .querySelector?.("[data-actor-owner-filter]")
      ?.addEventListener?.("change", (event) => {
        if (this._busy) return;
        this._actorSelectorState.ownerId =
          cleanId(event.target?.value) || "all";
        this._applyActorSelector();
      });
    root
      .querySelector?.("[data-actor-folder-filter]")
      ?.addEventListener?.("change", (event) => {
        if (this._busy) return;
        this._actorSelectorState.folderId =
          cleanId(event.target?.value) || "all";
        this._applyActorSelector();
      });
    root
      .querySelector?.("[data-actor-sort]")
      ?.addEventListener?.("change", (event) => {
        if (this._busy) return;
        const sort = cleanId(event.target?.value);
        this._actorSelectorState.sort = ACTOR_SELECTOR_SORTS.has(sort)
          ? sort
          : "name-asc";
        this._applyActorSelector();
      });
    root.addEventListener?.("change", (event) => {
      if (this._busy) return;
      if (!event.target?.matches?.('input[name="actorIds"]')) return;
      this._syncSelectedActorsFromDom();
      this._applyActorSelector();
    });
    this._applyActorSelector();
  }

  _actorCards() {
    return [...(this.element?.querySelectorAll?.("[data-actor-option]") ?? [])];
  }

  _actorRowFromCard(card) {
    const checkbox = card?.querySelector?.('input[name="actorIds"]');
    return {
      id: cleanId(checkbox?.value),
      name: String(card?.dataset?.actorName ?? ""),
      ownerIds: String(card?.dataset?.actorOwnerIds ?? "")
        .split("|")
        .map(cleanId)
        .filter(Boolean),
      ownerLabel: String(card?.dataset?.actorOwnerLabel ?? ""),
      folderId: cleanId(card?.dataset?.actorFolderId),
      folderName: String(card?.dataset?.actorFolderName ?? ""),
      searchText: String(card?.dataset?.actorSearch ?? ""),
      playerOwned: card?.dataset?.actorPlayerOwned === "true",
      checked: checkbox?.checked === true,
      order: positiveInteger(checkbox?.dataset?.actorOrder, 0),
      card,
      checkbox,
    };
  }

  _syncSelectedActorsFromDom() {
    this._actorSelectorState.selectedActorIds = new Set(
      this._actorCards()
        .map((card) => this._actorRowFromCard(card))
        .filter((row) => row.checked)
        .map((row) => row.id),
    );
  }

  _applyActorSelector() {
    const root = this.element?.querySelector?.("[data-actor-selector]");
    const grid = root?.querySelector?.("[data-actor-grid]");
    if (!root || !grid) return;
    const state = normalizeActorSelectorState(this._actorSelectorState);
    Object.assign(this._actorSelectorState, state);

    const query = root.querySelector?.("[data-actor-query]");
    if (query && query.value !== state.query) query.value = state.query;
    const owner = root.querySelector?.("[data-actor-owner-filter]");
    if (owner && owner.value !== state.ownerId) owner.value = state.ownerId;
    const folder = root.querySelector?.("[data-actor-folder-filter]");
    if (folder && folder.value !== state.folderId)
      folder.value = state.folderId;
    const sort = root.querySelector?.("[data-actor-sort]");
    if (sort && sort.value !== state.sort) sort.value = state.sort;
    for (const button of root.querySelectorAll?.("[data-actor-scope]") ?? []) {
      button.setAttribute(
        "aria-pressed",
        button.dataset.actorScope === state.scope ? "true" : "false",
      );
    }

    const rows = this._actorCards().map((card) => this._actorRowFromCard(card));
    rows.sort((left, right) => compareDowntimeActors(left, right, state.sort));
    let visibleCount = 0;
    for (const row of rows) {
      const visible = downtimeActorMatchesSelector(row, state);
      row.card.hidden = !visible;
      if (visible) visibleCount += 1;
      grid.append(row.card);
    }
    this._syncSelectedActorsFromDom();
    const selectedCount = this._actorSelectorState.selectedActorIds.size;
    const selected = root.querySelector?.("[data-actor-selected-count]");
    if (selected) selected.textContent = `${selectedCount} selected`;
    const shown = root.querySelector?.("[data-actor-visible-count]");
    if (shown) {
      shown.textContent = `${visibleCount} shown of ${rows.length} characters`;
    }
    const empty = root.querySelector?.("[data-actor-filter-empty]");
    if (empty) empty.hidden = visibleCount > 0;

    const create = this.element?.querySelector?.(
      '[data-action="createBlock"][data-requires-actor-selection]',
    );
    if (create) {
      const baseEnabled = create.dataset.createEnabled === "true";
      const busy = create.dataset.createBusy === "true";
      create.disabled = busy || !baseEnabled || selectedCount === 0;
      create.title =
        !busy && baseEnabled && selectedCount === 0
          ? "Select at least one character."
          : String(create.dataset.baseTitle ?? "");
    }
  }

  _restoreFocus() {
    if (!this._pendingFocus || !this.element) return;
    const selector = this._pendingFocus;
    this._pendingFocus = null;
    globalThis.requestAnimationFrame?.(() => {
      this.element?.querySelector?.(selector)?.focus?.();
    });
  }

  async _runCommand(method, payload = {}, options = {}) {
    if (this._busy) return null;
    const command = this._adapter?.[method];
    if (typeof command !== "function") {
      this._errorMessage =
        "Downtime commands are not available on this client.";
      this.render(false);
      return null;
    }

    this._busy = true;
    this._errorMessage = "";
    this._statusMessage = options.pending ?? "Working...";
    if (this.rendered) this.render(false);
    try {
      const result = await command.call(this._adapter, payload);
      this._statusMessage = options.success ?? "Downtime updated.";
      this._pendingFocus = options.focus ?? null;
      return result;
    } catch (error) {
      console.error(`${MODULE_ID} | downtime command ${method} failed`, error);
      this._errorMessage =
        String(error?.message ?? "").trim() ||
        "The downtime command failed. No new outcome was generated.";
      this._statusMessage = "Downtime was not changed.";
      return null;
    } finally {
      this._busy = false;
      if (this.rendered) this.render(false);
    }
  }

  static _onSetView(_event, target) {
    const view = String(target?.dataset?.view ?? "");
    if (!WORKSPACE_VIEWS.has(view)) return;
    if (view === this._view) {
      if (view === "current" && this._newBlockMode) {
        this._newBlockMode = false;
        this._pendingFocus = '[data-action="beginNextBlock"]';
        this.render(false);
      }
      return;
    }
    this._view = view;
    this._creatingSettlement = false;
    this._pendingFocus = `[data-view="${view}"]`;
    this.render(false);
  }

  static _onRefresh() {
    this._errorMessage = "";
    this._statusMessage = "Downtime refreshed.";
    this.render(false);
  }

  static async _onDismissQuickStart() {
    try {
      await dismissQuickStart(DOWNTIME_WORKSPACE_QUICK_START_ID);
      this._statusMessage =
        "Downtime quick start dismissed. Restore it from Infinity Settings.";
    } catch (error) {
      console.warn(
        `${MODULE_ID} | could not dismiss downtime quick start`,
        error,
      );
      this._statusMessage =
        "The quick start could not be dismissed. Nothing else changed; try again.";
    }
    this._pendingFocus = '[data-action="refresh"]';
    if (this.rendered) this.render(false);
  }

  static _onBeginNextBlock() {
    this._newBlockMode = true;
    this._actorSelectorState = createActorSelectorState();
    this._statusMessage = "Choose the location, time budget, and characters.";
    this._pendingFocus = '[data-form="new-block"] select[name="settlementId"]';
    this.render(false);
  }

  static _onSetHourPreset(_event, target) {
    if (this._busy) return;
    const hours = positiveInteger(target?.dataset?.hours, 0);
    const input = this.element?.querySelector?.(
      '[data-form="new-block"] input[name="hours"]',
    );
    if (!input || hours <= 0) return;
    input.value = String(hours);
    input.dispatchEvent(new Event("input", { bubbles: true }));
    input.focus();
  }

  static _onSetActorScope(_event, target) {
    if (this._busy) return;
    const scope = cleanId(target?.dataset?.actorScope);
    if (!ACTOR_SELECTOR_SCOPES.has(scope)) return;
    this._actorSelectorState.scope = scope;
    this._applyActorSelector();
  }

  static _onSelectShownActors() {
    if (this._busy) return;
    for (const row of this._actorCards().map((card) =>
      this._actorRowFromCard(card),
    )) {
      if (!row.card.hidden && !row.checkbox?.disabled) {
        row.checkbox.checked = true;
      }
    }
    this._syncSelectedActorsFromDom();
    this._applyActorSelector();
  }

  static _onClearShownActors() {
    if (this._busy) return;
    for (const row of this._actorCards().map((card) =>
      this._actorRowFromCard(card),
    )) {
      if (!row.card.hidden && !row.checkbox?.disabled) {
        row.checkbox.checked = false;
      }
    }
    this._syncSelectedActorsFromDom();
    this._applyActorSelector();
  }

  static _onRestoreActorDefaults() {
    if (this._busy) return;
    this._actorSelectorState = createActorSelectorState();
    for (const row of this._actorCards().map((card) =>
      this._actorRowFromCard(card),
    )) {
      if (!row.checkbox?.disabled) row.checkbox.checked = row.playerOwned;
    }
    this._syncSelectedActorsFromDom();
    this._applyActorSelector();
  }

  static async _onCreateBlock() {
    const form = this.element?.querySelector?.('[data-form="new-block"]');
    if (!form) return;
    const data = new FormData(form);
    const payload = {
      settlementId: cleanId(data.get("settlementId")),
      locationName: String(data.get("locationName") ?? "").trim(),
      hours: positiveInteger(data.get("hours"), 0),
      actorIds: [
        ...(form.querySelectorAll?.('input[name="actorIds"]:checked') ?? []),
      ]
        .sort(
          (left, right) =>
            positiveInteger(left.dataset?.actorOrder, 0) -
            positiveInteger(right.dataset?.actorOrder, 0),
        )
        .map((input) => cleanId(input.value))
        .filter(Boolean),
      mode: "guided",
      templateIds:
        typeof data.getAll === "function"
          ? data.getAll("templateIds").map(cleanId).filter(Boolean)
          : [],
      projectIds:
        typeof data.getAll === "function"
          ? data.getAll("projectIds").map(cleanId).filter(Boolean)
          : [],
    };
    const result = await this._runCommand("createBlock", payload, {
      pending: "Creating downtime block...",
      success: "Downtime block opened for submissions.",
      focus: '[data-action="openForPlayers"]',
    });
    if (result !== null) {
      this._newBlockMode = false;
      this._actorSelectorState = createActorSelectorState();
      if (this.rendered) this.render(false);
    }
  }

  static async _onOpenForPlayers() {
    await this._runCommand(
      "openForPlayers",
      {
        blockId: this._currentBlockId(),
      },
      {
        pending: "Opening activities for eligible players...",
        success: "Downtime Activities sent to eligible players.",
        focus: '[data-action="lockBlock"]',
      },
    );
  }

  static async _onLockBlock() {
    await this._runCommand(
      "lockBlock",
      {
        blockId: this._currentBlockId(),
      },
      {
        pending: "Locking submissions...",
        success: "Submissions locked. The block is ready to plan.",
        focus: '[data-action="planBlock"]',
      },
    );
  }

  static async _onPlanBlock() {
    await this._runCommand(
      "planBlock",
      {
        blockId: this._currentBlockId(),
      },
      {
        pending: "Rolling hidden checks and building the immutable preview...",
        success: "Immutable preview generated. Review it before applying.",
        focus: '[data-action="applyBlock"]',
      },
    );
  }

  static async _onApplyBlock() {
    await this._runCommand(
      "applyBlock",
      {
        blockId: this._currentBlockId(),
      },
      {
        pending: "Applying the saved downtime plan...",
        success: "Downtime application finished.",
        focus: '[data-action="refresh"]',
      },
    );
  }

  static async _onChooseGuidedOutcome(_event, target) {
    const operationId = cleanId(target?.dataset?.operationId);
    const outcomeIndex = positiveInteger(target?.dataset?.outcomeIndex, -1);
    if (!operationId || outcomeIndex < 0) return;
    const report = String(
      target
        ?.closest?.("[data-operation-id]")
        ?.querySelector?.("[data-guided-report]")?.value ?? "",
    );
    await this._runCommand(
      "chooseGuidedOutcome",
      { blockId: this._currentBlockId(), operationId, outcomeIndex, report },
      {
        pending: "Updating the GM-selected result...",
        success: "Result selected. Apply when the reports are ready.",
        focus: `[data-operation-id="${cssEscape(operationId)}"]`,
      },
    );
  }

  static async _onCancelBlock() {
    await this._runCommand(
      "cancelBlock",
      {
        blockId: this._currentBlockId(),
      },
      {
        pending: "Cancelling downtime block...",
        success: "Downtime block cancelled without advancing campaign time.",
        focus: '[data-action="createBlock"]',
      },
    );
  }

  static async _onRecoverBlock() {
    await this._runCommand(
      "recoverBlock",
      {
        blockId: this._currentBlockId(),
      },
      {
        pending: "Checking saved operations and recovering safely...",
        success:
          "Recovery check finished. Only proven-unapplied operations were retried.",
        focus: '[data-action="refresh"]',
      },
    );
  }

  static _onNewSettlement() {
    this._view = "settlements";
    this._creatingSettlement = true;
    this._selectedSettlementId = null;
    this._pendingFocus = '[data-form="settlement-edit"] input[name="name"]';
    this.render(false);
  }

  static _onSelectSettlement(_event, target) {
    const settlementId = cleanId(target?.dataset?.settlementId);
    if (!settlementId) return;
    this._creatingSettlement = false;
    this._selectedSettlementId = settlementId;
    this._pendingFocus = `[data-settlement-id="${cssEscape(settlementId)}"]`;
    this.render(false);
  }

  static async _onSaveSettlement() {
    const form = this.element?.querySelector?.('[data-form="settlement-edit"]');
    if (!form) return;
    const data = new FormData(form);
    const payload = {
      id: cleanId(data.get("id")),
      name: String(data.get("name") ?? "").trim(),
      wealthTier: cleanId(data.get("wealthTier")),
      securityTier: cleanId(data.get("securityTier")),
      marketDc: positiveInteger(data.get("marketDc"), 0),
      factionId: cleanId(data.get("factionId")),
      merchantIds: data.getAll("merchantIds").map(cleanId).filter(Boolean),
      enabledActivities: data
        .getAll("enabledActivities")
        .map(cleanId)
        .filter(Boolean),
    };
    const saved = await this._runCommand("saveSettlement", payload, {
      pending: "Saving settlement...",
      success: "Settlement saved.",
      focus: '[data-action="saveSettlement"]',
    });
    const savedId = cleanId(saved?.id ?? saved?.settlementId);
    if (saved !== null) {
      if (savedId) this._selectedSettlementId = savedId;
      this._creatingSettlement = false;
      if (this.rendered) this.render(false);
    }
  }

  static async _onDeleteSettlement() {
    const settlementId = cleanId(
      this.element?.querySelector?.(
        '[data-form="settlement-edit"] input[name="id"]',
      )?.value,
    );
    if (!settlementId) return;
    const confirmed = await confirmSettlementDelete();
    if (!confirmed) return;
    const result = await this._runCommand(
      "deleteSettlement",
      {
        settlementId,
      },
      {
        pending: "Deleting settlement...",
        success: "Settlement deleted.",
        focus: '[data-action="newSettlement"]',
      },
    );
    if (result !== null) {
      this._selectedSettlementId = null;
      if (this.rendered) this.render(false);
    }
  }

  static async _onSaveGuidedProject() {
    const form = this.element?.querySelector?.('[data-form="guided-project"]');
    if (!form) return;
    const data = new FormData(form);
    const result = await this._runCommand(
      "saveGuidedProject",
      {
        name: String(data.get("name") ?? "").trim(),
        description: String(data.get("description") ?? "").trim(),
        requiredHours: positiveInteger(data.get("requiredHours"), 0),
        skills:
          typeof data.getAll === "function"
            ? data.getAll("skills").map(cleanId).filter(Boolean)
            : [],
      },
      {
        pending: "Saving long-term project...",
        success:
          "Project saved. Select it when you open the next downtime block.",
        focus: '[data-action="saveGuidedProject"]',
      },
    );
    if (result !== null && this.rendered) this.render(false);
  }

  _currentBlockId() {
    return (
      cleanId(
        this.element?.querySelector?.("[data-block-id]")?.dataset?.blockId,
      ) || this._activeBlockId
    );
  }
}

function workspaceProjectionErrorMessage(error) {
  const message = String(error?.message ?? "");
  if (message.includes("An active full GM is required")) {
    return "Downtime is controlled by another active GM session. Open this workspace from the active full GM.";
  }
  if (
    message.includes("DowntimeWorkflowStoreUnavailable") ||
    message.includes("PrivateStateUnavailable")
  ) {
    return "Private downtime data is not available yet. Wait a moment; if the private-data warning remains, resolve it, then refresh.";
  }
  return "Downtime data could not be verified. Refresh before making any downtime changes.";
}

/**
 * Shape data for Handlebars without letting templates infer workflow rules.
 * Exported for the UI harness and small, Foundry-free projection tests.
 */
export function normalizeWorkspaceProjection(raw, uiState = {}) {
  const source = raw && typeof raw === "object" ? raw : {};
  const view = WORKSPACE_VIEWS.has(uiState.view) ? uiState.view : DEFAULT_VIEW;
  const workflow = source.workflow ?? source.activeBlock ?? null;
  const workflowStatus = cleanId(
    workflow?.status ?? source.workflowStatus ?? "idle",
  );
  const settlements = array(source.settlements).map(normalizeSettlementListRow);
  const guidedTemplates = array(source.guidedTemplates)
    .map((template) => ({
      id: cleanId(template?.id),
      name: String(template?.name ?? "Activity"),
      description: String(template?.description ?? ""),
      image: String(template?.image ?? "icons/svg/d20.svg"),
    }))
    .filter((template) => template.id);
  const guidedProjects = array(source.guidedProjects)
    .map((project) => ({
      id: cleanId(project?.id),
      name: String(project?.name ?? "Project"),
      description: String(project?.description ?? ""),
      requiredHours: positiveInteger(project?.requiredHours, 1),
      progressHours: Math.max(0, positiveInteger(project?.progressHours, 0)),
      remainingHours: Math.max(0, positiveInteger(project?.remainingHours, 0)),
      progressLabel: String(project?.progressLabel ?? ""),
      complete: project?.complete === true,
    }))
    .filter((project) => project.id);
  let selectedSettlementId = cleanId(uiState.selectedSettlementId);
  if (!selectedSettlementId && !uiState.creatingSettlement) {
    selectedSettlementId = cleanId(
      source.selectedSettlementId ?? settlements[0]?.id,
    );
  }
  for (const settlement of settlements) {
    settlement.selected = settlement.id === selectedSettlementId;
  }
  const storedSettlement = settlements.find(
    (settlement) => settlement.id === selectedSettlementId,
  );
  const selectedSource = uiState.creatingSettlement
    ? null
    : source.selectedSettlement?.id === selectedSettlementId
      ? source.selectedSettlement
      : storedSettlement?.source;
  const selectedSettlement = normalizeSettlementEditor(selectedSource, source, {
    creating: Boolean(uiState.creatingSettlement),
  });
  if (selectedSettlement && !selectedSettlement.id && selectedSettlementId) {
    selectedSettlement.id = selectedSettlementId;
  }

  const normalizedCurrentBlock = normalizeCurrentBlock(workflow, source);
  const currentBlock = uiState.newBlockMode ? null : normalizedCurrentBlock;
  const history = array(source.history).map(normalizeHistoryEntry);
  const needsRecovery =
    workflowStatus === "needs-review" || Boolean(source.recovery?.available);
  const recoveryMessage =
    String(source.recovery?.message ?? "").trim() ||
    "A prior application needs review. Recovery verifies each saved operation before retrying it.";
  const canCreateBlock =
    source.canCreateBlock !== false &&
    !currentBlock &&
    (!normalizedCurrentBlock ||
      ["completed", "cancelled"].includes(normalizedCurrentBlock.status));
  const lifecycle = buildDowntimeLifecycle({
    status: currentBlock?.status ?? workflowStatus,
    hasCurrentBlock: Boolean(currentBlock),
    currentBlock,
    canCreateBlock,
    needsRecovery,
    recoveryMessage,
  });
  const actorProjection = normalizeDowntimeActors(
    source.actors ?? source.actorOptions,
    uiState.actorSelector,
  );

  return {
    dataAvailable: source.dataAvailable !== false,
    view,
    viewCurrent: view === "current",
    viewProjects: view === "projects",
    viewSettlements: view === "settlements",
    viewHistory: view === "history",
    hasCurrentBlock: Boolean(currentBlock),
    currentBlock,
    workflowStatus,
    workflowStatusLabel: workflowLabel(workflowStatus),
    workflowTone: workflowTone(workflowStatus),
    needsRecovery,
    recoveryMessage,
    lifecycleSteps: lifecycle.steps,
    lifecycleRecovery: lifecycle.recovery,
    primaryAction: lifecycle.primaryAction,
    settlements,
    guidedTemplates,
    hasGuidedTemplates: guidedTemplates.length > 0,
    guidedProjects,
    hasGuidedProjects: guidedProjects.length > 0,
    projectSkillOptions: GUIDED_PROJECT_SKILLS.map(([id, label]) => ({
      id,
      label,
    })),
    hasSettlements: settlements.length > 0,
    selectedSettlement,
    hasSelectedSettlement: Boolean(selectedSettlement),
    actors: actorProjection.actors,
    actorSelector: actorProjection.selector,
    hasActors: actorProjection.actors.length > 0,
    canCreateBlock,
    createBlockReason:
      String(source.createBlockReason ?? "").trim() ||
      (currentBlock ? "Finish or cancel the current block first." : ""),
    history,
    hasHistory: history.length > 0,
    recovery: source.recovery ?? null,
  };
}

export function normalizeDowntimeActors(rawActors, rawSelectorState = {}) {
  const state = normalizeActorSelectorState(rawSelectorState);
  const hasSelectionOverride = state.selectedActorIds instanceof Set;
  const actors = array(rawActors)
    .map((rawActor, order) => {
      const actor = rawActor && typeof rawActor === "object" ? rawActor : {};
      const id = cleanId(actor.id ?? actor.actorId);
      if (!id) return null;
      const eligible = actor.eligible !== false;
      const owners = array(actor.owners)
        .map((owner) => {
          const ownerId = cleanId(owner?.id ?? owner?.userId);
          if (!ownerId) return null;
          return {
            id: ownerId,
            name: String(owner?.name ?? owner?.label ?? "Player"),
            active: owner?.active !== false,
            assigned: owner?.assigned === true,
          };
        })
        .filter(Boolean);
      const hasOwnershipMetadata =
        Object.hasOwn(actor, "playerOwned") ||
        Object.hasOwn(actor, "control") ||
        Object.hasOwn(actor, "owners");
      const playerOwned =
        actor.playerOwned === true ||
        actor.control === "player-owned" ||
        (!hasOwnershipMetadata && actor.checked !== false);
      const checked =
        eligible &&
        (hasSelectionOverride
          ? state.selectedActorIds.has(id)
          : actor.checked === undefined
            ? playerOwned
            : actor.checked !== false);
      const folderId = cleanId(actor.folderId ?? actor.folder?.id);
      const folderName = String(
        actor.folderName ?? actor.folder?.name ?? "No folder",
      );
      const ownerLabel = String(
        actor.ownerLabel ??
          (owners.length > 0
            ? owners.map((owner) => owner.name).join(", ")
            : "No player owner"),
      );
      const name = String(actor.name ?? "Unknown character");
      return {
        id,
        name,
        img: String(actor.img ?? "icons/svg/mystery-man.svg"),
        checked,
        eligible,
        reason: String(actor.reason ?? actor.unavailableReason ?? ""),
        playerOwned,
        assigned:
          actor.assigned === true || owners.some((owner) => owner.assigned),
        owners,
        ownerIds: owners.map((owner) => owner.id),
        ownerIdsValue: owners.map((owner) => owner.id).join("|"),
        ownerLabel,
        folderId,
        folderName,
        searchText: normalizeActorSearchText(
          `${name} ${ownerLabel} ${folderName}`,
        ),
        order,
      };
    })
    .filter(Boolean);

  const ownerMap = new Map();
  const folderMap = new Map();
  for (const actor of actors) {
    for (const owner of actor.owners) ownerMap.set(owner.id, owner.name);
    if (actor.folderId) folderMap.set(actor.folderId, actor.folderName);
  }
  if (
    !["all", "unowned"].includes(state.ownerId) &&
    !ownerMap.has(state.ownerId)
  ) {
    state.ownerId = "all";
  }
  if (
    !["all", "unfiled"].includes(state.folderId) &&
    !folderMap.has(state.folderId)
  ) {
    state.folderId = "all";
  }

  actors.sort((left, right) => compareDowntimeActors(left, right, state.sort));
  for (const actor of actors) {
    actor.visible = downtimeActorMatchesSelector(actor, state);
  }
  const selectedCount = actors.filter((actor) => actor.checked).length;
  const visibleCount = actors.filter((actor) => actor.visible).length;
  const playerOwnedCount = actors.filter((actor) => actor.playerOwned).length;
  const otherCount = actors.length - playerOwnedCount;
  const selectedPlayerOwnedCount = actors.filter(
    (actor) => actor.checked && actor.playerOwned,
  ).length;

  return {
    actors,
    selector: {
      scope: state.scope,
      scopePlayerOwned: state.scope === "player-owned",
      scopeOther: state.scope === "other",
      scopeSelected: state.scope === "selected",
      scopeAll: state.scope === "all",
      query: state.query,
      ownerId: state.ownerId,
      ownerAll: state.ownerId === "all",
      ownerUnowned: state.ownerId === "unowned",
      ownerOptions: [...ownerMap.entries()]
        .map(([id, name]) => ({
          id,
          name,
          selected: state.ownerId === id,
        }))
        .sort((left, right) => compareActorText(left.name, right.name)),
      hasUnowned: actors.some((actor) => actor.ownerIds.length === 0),
      folderId: state.folderId,
      folderAll: state.folderId === "all",
      folderUnfiled: state.folderId === "unfiled",
      folderOptions: [...folderMap.entries()]
        .map(([id, name]) => ({
          id,
          name,
          selected: state.folderId === id,
        }))
        .sort((left, right) => compareActorText(left.name, right.name)),
      hasUnfiled: actors.some((actor) => !actor.folderId),
      sort: state.sort,
      sortNameAsc: state.sort === "name-asc",
      sortNameDesc: state.sort === "name-desc",
      sortOwner: state.sort === "owner",
      sortFolder: state.sort === "folder",
      sortSelectedFirst: state.sort === "selected-first",
      totalCount: actors.length,
      selectedCount,
      visibleCount,
      playerOwnedCount,
      otherCount,
      selectedPlayerOwnedCount,
      selectedOtherCount: selectedCount - selectedPlayerOwnedCount,
      hasSelection: selectedCount > 0,
    },
  };
}

export function normalizeActorSelectorState(raw = {}) {
  const source = raw && typeof raw === "object" ? raw : {};
  const scope = cleanId(source.scope);
  const sort = cleanId(source.sort);
  const rawSelection = source.selectedActorIds;
  const selectedActorIds =
    rawSelection instanceof Set || Array.isArray(rawSelection)
      ? new Set([...rawSelection].map(cleanId).filter(Boolean))
      : null;
  return {
    scope: ACTOR_SELECTOR_SCOPES.has(scope) ? scope : "player-owned",
    query: String(source.query ?? "").slice(0, 200),
    ownerId: cleanId(source.ownerId) || "all",
    folderId: cleanId(source.folderId) || "all",
    sort: ACTOR_SELECTOR_SORTS.has(sort) ? sort : "name-asc",
    selectedActorIds,
  };
}

export function downtimeActorMatchesSelector(actor, rawState = {}) {
  const state = normalizeActorSelectorState(rawState);
  if (state.scope === "player-owned" && actor?.playerOwned !== true) {
    return false;
  }
  if (state.scope === "other" && actor?.playerOwned === true) return false;
  if (state.scope === "selected" && actor?.checked !== true) return false;
  const ownerIds = array(actor?.ownerIds).map(cleanId).filter(Boolean);
  if (state.ownerId === "unowned" && ownerIds.length > 0) return false;
  if (
    !["all", "unowned"].includes(state.ownerId) &&
    !ownerIds.includes(state.ownerId)
  ) {
    return false;
  }
  const folderId = cleanId(actor?.folderId);
  if (state.folderId === "unfiled" && folderId) return false;
  if (
    !["all", "unfiled"].includes(state.folderId) &&
    folderId !== state.folderId
  ) {
    return false;
  }
  const needle = normalizeActorSearchText(state.query);
  return (
    !needle ||
    normalizeActorSearchText(
      actor?.searchText ??
        `${actor?.name ?? ""} ${actor?.ownerLabel ?? ""} ${actor?.folderName ?? ""}`,
    ).includes(needle)
  );
}

export function compareDowntimeActors(left, right, sort = "name-asc") {
  let compared = 0;
  if (sort === "name-desc") {
    compared = compareActorText(right?.name, left?.name);
  } else if (sort === "owner") {
    compared = compareActorText(
      left?.ownerLabel || "\uffff",
      right?.ownerLabel || "\uffff",
    );
  } else if (sort === "folder") {
    compared = compareActorText(
      left?.folderName || "\uffff",
      right?.folderName || "\uffff",
    );
  } else if (sort === "selected-first") {
    compared = Number(right?.checked === true) - Number(left?.checked === true);
  } else {
    compared = compareActorText(left?.name, right?.name);
  }
  if (compared !== 0) return compared;
  const byName = compareActorText(left?.name, right?.name);
  if (byName !== 0) return byName;
  return positiveInteger(left?.order, 0) - positiveInteger(right?.order, 0);
}

/**
 * Build the GM-only workflow presentation from normalized authoritative gates.
 * This helper never advances state or enables an action the projection denied.
 */
export function buildDowntimeLifecycle({
  status = "idle",
  hasCurrentBlock = false,
  currentBlock = null,
  canCreateBlock = false,
  needsRecovery = false,
  recoveryMessage = "",
} = {}) {
  const normalizedStatus = cleanId(status) || "idle";
  let completedThrough = -1;
  let currentIndex = -1;
  let interruptedIndex = -1;
  let stoppedIndex = -1;

  if (needsRecovery || normalizedStatus === "needs-review") {
    completedThrough = 3;
    interruptedIndex = 4;
  } else if (!hasCurrentBlock || normalizedStatus === "idle") {
    currentIndex = 0;
  } else {
    switch (normalizedStatus) {
      case "collecting":
        completedThrough = 0;
        currentIndex = 1;
        break;
      case "locked":
        completedThrough = 1;
        currentIndex = 2;
        break;
      case "planned":
        completedThrough = 2;
        currentIndex = 3;
        break;
      case "applying":
        completedThrough = 3;
        currentIndex = 4;
        break;
      case "completed":
        completedThrough = WORKFLOW_STEPS.length - 1;
        break;
      case "cancelled":
        completedThrough = 0;
        stoppedIndex = 1;
        break;
      default:
        completedThrough = 0;
        currentIndex = 1;
        break;
    }
  }

  const steps = WORKFLOW_STEPS.map((step, index) => {
    let state = "pending";
    if (index <= completedThrough) state = "completed";
    if (index === currentIndex) state = "current";
    if (index === interruptedIndex) state = "interrupted";
    if (index === stoppedIndex) state = "stopped";
    return {
      ...step,
      state,
      stateLabel: lifecycleStateLabel(state),
      icon: lifecycleStateIcon(state),
      current: state === "current",
      completed: state === "completed",
      pending: state === "pending",
    };
  });
  const recoveryCurrent =
    Boolean(needsRecovery) || normalizedStatus === "needs-review";
  const primaryActionId = resolvePrimaryActionId({
    status: normalizedStatus,
    hasCurrentBlock,
    currentBlock,
    canCreateBlock,
    needsRecovery: recoveryCurrent,
  });

  return {
    steps,
    recovery: {
      id: "recovery",
      label: "Recovery",
      state: recoveryCurrent ? "current" : "pending",
      stateLabel: recoveryCurrent ? "Current" : "Standby",
      icon: recoveryCurrent ? "fa-life-ring" : "fa-shield-halved",
      current: recoveryCurrent,
      pending: !recoveryCurrent,
      description: recoveryCurrent
        ? String(recoveryMessage).trim() ||
          "Verify the interrupted application before continuing."
        : "Branches from Apply only when an interrupted write needs verification.",
    },
    primaryAction: buildPrimaryAction(primaryActionId, normalizedStatus),
  };
}

function resolvePrimaryActionId({
  status,
  hasCurrentBlock,
  currentBlock,
  canCreateBlock,
  needsRecovery,
}) {
  if (needsRecovery) return "recoverBlock";
  if (!hasCurrentBlock) return canCreateBlock ? "createBlock" : "";
  if (status === "collecting") {
    const allSubmitted =
      currentBlock?.hasParticipants &&
      currentBlock.submittedCount >= currentBlock.participants.length;
    if (allSubmitted && currentBlock.canLock) return "lockBlock";
    if (currentBlock?.canOpenForPlayers && currentBlock.hasParticipants) {
      return "openForPlayers";
    }
    return currentBlock?.canLock ? "lockBlock" : "";
  }
  if (status === "locked" && currentBlock?.canPlan) return "planBlock";
  if (status === "planned" && currentBlock?.canApply) return "applyBlock";
  if (
    ["completed", "cancelled"].includes(status) &&
    currentBlock?.canStartNext
  ) {
    return "beginNextBlock";
  }
  return "";
}

function buildPrimaryAction(id, status) {
  const copy = PRIMARY_ACTION_COPY[id] ?? null;
  const waitingDescription =
    status === "applying"
      ? "Application is in progress. Wait for the authoritative result; use Recovery only if the workspace requests it."
      : "No primary action is available until the authoritative workflow state changes.";
  return {
    id,
    hasAction: Boolean(copy),
    label: copy?.label ?? "Waiting for workflow state",
    description: copy?.description ?? waitingDescription,
    createBlock: id === "createBlock",
    openForPlayers: id === "openForPlayers",
    lockBlock: id === "lockBlock",
    planBlock: id === "planBlock",
    applyBlock: id === "applyBlock",
    recoverBlock: id === "recoverBlock",
    beginNextBlock: id === "beginNextBlock",
  };
}

function lifecycleStateLabel(state) {
  const labels = {
    completed: "Completed",
    current: "Current",
    pending: "Pending",
    interrupted: "Interrupted",
    stopped: "Cancelled",
  };
  return labels[state] ?? titleCase(state);
}

function lifecycleStateIcon(state) {
  const icons = {
    completed: "fa-check",
    current: "fa-circle-dot",
    pending: "fa-circle",
    interrupted: "fa-triangle-exclamation",
    stopped: "fa-ban",
  };
  return icons[state] ?? "fa-circle";
}

function normalizeCurrentBlock(workflow, root) {
  if (!workflow || typeof workflow !== "object") return null;
  const status = cleanId(
    workflow.status ?? root.workflowStatus ?? "collecting",
  );
  const participants = array(
    workflow.participants ?? workflow.characters ?? workflow.submissions,
  ).map((row) => {
    const budgetHours = positiveInteger(
      row?.budgetHours ?? workflow.hours ?? workflow.budgetHours,
      0,
    );
    const usedHours = positiveInteger(row?.usedHours, 0);
    const queue = array(row?.queue).map((activity, index) => ({
      id: cleanId(activity?.id ?? activity?.operationId ?? index),
      label: String(activity?.label ?? activity?.activityLabel ?? "Activity"),
      hours: positiveInteger(activity?.hours, 0),
      detail: String(activity?.detail ?? activity?.summary ?? ""),
      outcome: String(activity?.outcome ?? activity?.resultLabel ?? ""),
      hasOutcome: Boolean(activity?.outcome ?? activity?.resultLabel),
      tone: cleanTone(activity?.tone ?? activity?.resultTone),
    }));
    return {
      actorId: cleanId(row?.actorId ?? row?.id),
      name: String(row?.name ?? row?.actorName ?? "Unknown character"),
      img: String(row?.img ?? "icons/svg/mystery-man.svg"),
      submitted: row?.submitted === true,
      submissionLabel: row?.submitted === true ? "Submitted" : "Draft",
      usedHours,
      budgetHours,
      remainingHours: Math.max(
        0,
        positiveInteger(row?.remainingHours, budgetHours - usedHours),
      ),
      queue,
      hasQueue: queue.length > 0,
      resultStatus: String(row?.resultStatus ?? row?.status ?? ""),
      receipt: String(row?.receipt ?? row?.receiptSummary ?? ""),
      hasReceipt: Boolean(row?.receipt ?? row?.receiptSummary),
    };
  });
  const planCharacters = array(
    workflow.plan?.characters ??
      workflow.preview?.characters ??
      root.plan?.characters,
  ).map((character) => ({
    actorId: cleanId(character?.actorId ?? character?.id),
    name: String(
      character?.name ?? character?.actorName ?? "Unknown character",
    ),
    status: String(character?.status ?? "planned"),
    operations: array(character?.operations ?? character?.activities).map(
      (operation, index) => ({
        id: cleanId(operation?.id ?? operation?.operationId ?? index),
        label: String(
          operation?.label ?? operation?.activityLabel ?? "Activity",
        ),
        hours: positiveInteger(operation?.hours, 0),
        rollLabel: String(operation?.rollLabel ?? operation?.roll ?? ""),
        hasRoll: Boolean(operation?.rollLabel ?? operation?.roll),
        outcome: String(
          operation?.outcome ??
            operation?.outcomeLabel ??
            operation?.summary ??
            "",
        ),
        tone: cleanTone(operation?.tone ?? operation?.outcomeTier),
        outcomeOptions: array(operation?.outcomeOptions).map((option) => ({
          index: positiveInteger(option?.index, 0),
          label: String(option?.label ?? "Result"),
          report: String(option?.report ?? ""),
          rewardLabel: String(option?.rewardLabel ?? ""),
          selected: option?.selected === true,
        })),
        hasOutcomeOptions: array(operation?.outcomeOptions).length > 0,
        report: String(operation?.report ?? ""),
      }),
    ),
  }));
  const canLock =
    workflow.canLock ?? (status === "collecting" && participants.length > 0);
  const canPlan = workflow.canPlan ?? status === "locked";
  const canApply = workflow.canApply ?? status === "planned";
  const canCancel =
    workflow.canCancel ?? ["collecting", "locked", "planned"].includes(status);
  const canRecover =
    workflow.canRecover ??
    (["applying", "needs-review"].includes(status) ||
      Boolean(root.recovery?.available));
  return {
    id: cleanId(workflow.id ?? workflow.blockId),
    status,
    statusLabel: workflowLabel(status),
    statusTone: workflowTone(status),
    settlementId: cleanId(workflow.settlementId ?? workflow.settlement?.id),
    settlementName: String(
      workflow.settlementName ?? workflow.settlement?.name ?? "Settlement",
    ),
    locationName: String(
      workflow.locationName ??
        workflow.settlementName ??
        workflow.settlement?.name ??
        "Camp or wilderness",
    ),
    hasSettlement: workflow.hasSettlement !== false,
    hours: positiveInteger(workflow.hours ?? workflow.budgetHours, 0),
    dayLabel: formatDays(workflow.hours ?? workflow.budgetHours),
    participants,
    hasParticipants: participants.length > 0,
    submittedCount: participants.filter((row) => row.submitted).length,
    planCharacters,
    hasPlan: planCharacters.length > 0,
    planId: cleanId(workflow.plan?.id ?? workflow.preview?.id),
    plannedAt: formatDate(
      workflow.plan?.createdAt ?? workflow.preview?.createdAt,
    ),
    completedAt: formatDate(workflow.completedAt),
    canOpenForPlayers: workflow.canOpenForPlayers ?? status === "collecting",
    canLock: Boolean(canLock),
    canPlan: Boolean(canPlan),
    canApply: Boolean(canApply),
    canCancel: Boolean(canCancel),
    canRecover: Boolean(canRecover),
    canStartNext: ["completed", "cancelled"].includes(status),
    lockReason: String(workflow.lockReason ?? ""),
    planReason: String(workflow.planReason ?? ""),
    applyReason: String(workflow.applyReason ?? ""),
    cancelReason: String(workflow.cancelReason ?? ""),
  };
}

function normalizeSettlementListRow(settlement) {
  const source = settlement && typeof settlement === "object" ? settlement : {};
  return {
    id: cleanId(source.id),
    name: String(source.name ?? "Unnamed settlement"),
    wealthLabel: titleCase(source.wealthTier ?? source.wealth ?? "modest"),
    securityLabel: titleCase(
      source.securityTier ?? source.security ?? "standard",
    ),
    merchantCount: array(
      source.linkedMerchantIds ?? source.merchantIds ?? source.merchants,
    ).length,
    source,
  };
}

function normalizeSettlementEditor(source, root, { creating = false } = {}) {
  if (!creating && (!source || typeof source !== "object")) return null;
  const settlement = source && typeof source === "object" ? source : {};
  const wealthTier = cleanId(settlement.wealthTier ?? "modest");
  const securityTier = cleanId(settlement.securityTier ?? "standard");
  const storedEnabledActivities =
    settlement.enabledActivityIds ?? settlement.enabledActivities;
  const enabled = new Set(
    Array.isArray(storedEnabledActivities)
      ? storedEnabledActivities.map(cleanId)
      : DEFAULT_ACTIVITY_IDS,
  );
  const linkedMerchants = new Set(
    array(
      settlement.linkedMerchantIds ??
        settlement.merchantIds ??
        settlement.merchants,
    ).map((entry) => cleanId(entry?.id ?? entry)),
  );
  const linkedFactionId = cleanId(
    settlement.linkedFactionId ?? settlement.factionId,
  );
  return {
    id: cleanId(settlement.id),
    creating,
    name: String(settlement.name ?? ""),
    marketDc: positiveInteger(settlement.marketDc, 13),
    wealthOptions: optionRows(
      ["poor", "modest", "prosperous", "wealthy"],
      wealthTier,
    ),
    securityOptions: optionRows(
      ["low", "standard", "high", "extreme"],
      securityTier,
    ),
    factionOptions: [
      { id: "", label: "No linked faction", selected: !linkedFactionId },
      ...array(root.factions ?? root.factionOptions).map((faction) => ({
        id: cleanId(faction?.id),
        label: String(faction?.name ?? faction?.label ?? "Unknown faction"),
        selected: cleanId(faction?.id) === linkedFactionId,
      })),
    ],
    merchantOptions: array(root.merchants ?? root.merchantOptions).map(
      (merchant) => {
        const id = cleanId(merchant?.id ?? merchant?.merchantId);
        return {
          id,
          label: String(merchant?.name ?? merchant?.label ?? "Merchant"),
          checked: linkedMerchants.has(id),
        };
      },
    ),
    hasMerchants: array(root.merchants ?? root.merchantOptions).length > 0,
    activityOptions: DEFAULT_ACTIVITY_IDS.map((id) => ({
      id,
      label: activityLabel(id),
      checked: enabled.has(id),
    })),
  };
}

function normalizeHistoryEntry(entry) {
  const source = entry && typeof entry === "object" ? entry : {};
  const status = cleanId(source.status ?? "completed");
  return {
    id: cleanId(source.id ?? source.blockId),
    settlementName: String(
      source.settlementName ?? source.settlement?.name ?? "Settlement",
    ),
    locationName: String(
      source.locationName ??
        source.settlementName ??
        source.settlement?.name ??
        "Camp or wilderness",
    ),
    hasSettlement: source.hasSettlement !== false,
    status,
    statusLabel: workflowLabel(status),
    statusTone: workflowTone(status),
    hours: positiveInteger(source.hours ?? source.budgetHours, 0),
    characterCount: positiveInteger(
      source.characterCount ?? array(source.participants).length,
      0,
    ),
    when: formatDate(
      source.completedAt ?? source.cancelledAt ?? source.updatedAt,
    ),
    summary: String(source.summary ?? ""),
  };
}

function workflowLabel(status) {
  const labels = {
    idle: "No active block",
    collecting: "Collecting",
    locked: "Locked",
    planned: "Preview ready",
    applying: "Applying",
    completed: "Completed",
    cancelled: "Cancelled",
    "needs-review": "Needs review",
  };
  return labels[status] ?? titleCase(status || "unknown");
}

function workflowTone(status) {
  if (status === "completed") return "success";
  if (status === "needs-review" || status === "unavailable") return "danger";
  if (status === "applying" || status === "planned") return "accent";
  if (status === "cancelled") return "muted";
  return "neutral";
}

function cleanTone(value) {
  const tone = cleanId(value);
  if (["exceptional", "exceptional-success"].includes(tone)) {
    return "exceptional";
  }
  if (["serious", "serious-failure"].includes(tone)) return "serious";
  if (["success", "setback", "failure"].includes(tone)) return tone;
  return "neutral";
}

function activityLabel(id) {
  const labels = {
    "craft-ammunition": "Craft Ammunition",
    "sharpen-weapon": "Sharpen Weapon",
    "market-trading": "Market Trading",
    pickpocket: "Pickpocket",
    shoplift: "Shoplift",
    "fence-stolen-goods": "Fence Stolen Goods",
    "lay-low": "Lay Low",
  };
  return labels[id] ?? titleCase(id);
}

function optionRows(values, selected) {
  return values.map((value) => ({
    value,
    label: titleCase(value),
    selected: value === selected,
  }));
}

function titleCase(value) {
  return String(value ?? "")
    .replace(/[-_]+/g, " ")
    .replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function formatDays(hours) {
  const value = positiveInteger(hours, 0);
  if (value <= 0) return "";
  if (value % 8 !== 0) return `${value} productive hours`;
  const days = value / 8;
  return `${days} productive ${days === 1 ? "day" : "days"}`;
}

function formatDate(value) {
  if (value === null || value === undefined || value === "") return "";
  const numeric = Number(value);
  const date = new Date(Number.isFinite(numeric) ? numeric : value);
  if (!Number.isFinite(date.getTime())) return "";
  try {
    return new Intl.DateTimeFormat(undefined, {
      dateStyle: "medium",
      timeStyle: "short",
    }).format(date);
  } catch {
    return date.toLocaleString();
  }
}

async function confirmSettlementDelete() {
  return Boolean(
    await confirmInfinityDialog({
      window: {
        title: "Delete settlement?",
        icon: "fa-solid fa-trash",
      },
      content:
        "<p>This removes the saved settlement profile. Historical downtime receipts remain.</p>",
      rejectClose: false,
    }),
  );
}

function positiveInteger(value, fallback = 0) {
  const numeric = Math.floor(Number(value));
  return Number.isFinite(numeric) && numeric >= 0 ? numeric : fallback;
}

function createActorSelectorState() {
  return {
    scope: "player-owned",
    query: "",
    ownerId: "all",
    folderId: "all",
    sort: "name-asc",
    selectedActorIds: null,
  };
}

function normalizeActorSearchText(value) {
  return String(value ?? "")
    .toLocaleLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function compareActorText(left, right) {
  return String(left ?? "").localeCompare(String(right ?? ""), undefined, {
    sensitivity: "base",
    numeric: true,
  });
}

function cleanId(value) {
  return String(value ?? "").trim();
}

function array(value) {
  return Array.isArray(value) ? value : [];
}

function cssEscape(value) {
  return (
    globalThis.CSS?.escape?.(String(value)) ??
    String(value).replace(/["\\]/g, "\\$&")
  );
}
