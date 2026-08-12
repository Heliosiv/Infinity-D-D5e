/**
 * Infinity D&D5e - Downtime Activities (player interface)
 *
 * The adapter must return a player-safe projection. This application copies
 * only display fields and submits only IDs, hours, skill choice, stake, and
 * target IDs; hidden DCs, rolls, rewards, and merchant internals have no UI
 * path back to the authoritative GM.
 */

import { applyVisualPrefs, openSingleton } from "./infinity-app.js";

const MODULE_ID = "infinity-dnd5e";
const TEMPLATE_PATH = `modules/${MODULE_ID}/templates/downtime-activities.hbs`;
const DEFAULT_CATEGORY = "all";
const REQUEST_FIELDS = new Set([
  "hours",
  "skill",
  "stakeGp",
  "targetId",
  "targetIds",
  "itemId",
  "weaponId",
  "bundleId",
  "ammunitionType",
]);

const { ApplicationV2, HandlebarsApplicationMixin } = foundry.applications.api;

export class DowntimeActivitiesApp extends HandlebarsApplicationMixin(
  ApplicationV2,
) {
  static _instance = null;
  static _adapterFactory = null;

  static DEFAULT_OPTIONS = {
    id: "infinity-dnd5e-downtime-activities",
    tag: "section",
    classes: ["infinity-dnd5e", "infinity-downtime-activities"],
    window: {
      title: "Downtime Activities",
      icon: "fa-solid fa-moon",
      resizable: true,
    },
    position: { width: 780, height: 720 },
    actions: {
      refresh: DowntimeActivitiesApp._onRefresh,
      selectActor: DowntimeActivitiesApp._onSelectActor,
      selectCategory: DowntimeActivitiesApp._onSelectCategory,
      addActivity: DowntimeActivitiesApp._onAddActivity,
      moveActivityUp: DowntimeActivitiesApp._onMoveActivityUp,
      moveActivityDown: DowntimeActivitiesApp._onMoveActivityDown,
      removeActivity: DowntimeActivitiesApp._onRemoveActivity,
      submitQueue: DowntimeActivitiesApp._onSubmitQueue,
      recallSubmission: DowntimeActivitiesApp._onRecallSubmission,
    },
  };

  static PARTS = {
    body: { template: TEMPLATE_PATH },
  };

  /** Configure a client adapter factory during module initialization. */
  static configure({ adapterFactory } = {}) {
    this._adapterFactory =
      typeof adapterFactory === "function" ? adapterFactory : null;
  }

  /**
   * Open or focus the player window. Passing actorId supports targeted socket
   * auto-open without creating duplicate windows.
   */
  static open({ adapter = null, actorId = "" } = {}) {
    const resolvedAdapter = adapter ?? this._adapterFactory?.() ?? null;
    const app = openSingleton(
      DowntimeActivitiesApp,
      () => new DowntimeActivitiesApp({ adapter: resolvedAdapter, actorId }),
    );
    if (resolvedAdapter && app._adapter !== resolvedAdapter) {
      app._replaceAdapter(resolvedAdapter);
    }
    const cleanActorId = cleanId(actorId);
    if (cleanActorId && app._actorId !== cleanActorId) {
      app._actorId = cleanActorId;
      app._pendingFocus = "[data-activity-list]";
      if (app.rendered) app.render(false);
    }
    return app;
  }

  constructor(options = {}) {
    const { adapter = null, actorId = "", ...applicationOptions } = options;
    super(applicationOptions);
    this._adapter = adapter;
    this._actorId = cleanId(actorId);
    this._category = DEFAULT_CATEGORY;
    this._busy = false;
    this._statusMessage = "";
    this._errorMessage = "";
    this._pendingFocus = null;
    this._unsubscribe = null;
    this._bindAdapter();
  }

  _onClose(options) {
    super._onClose?.(options);
    this._unsubscribe?.();
    this._unsubscribe = null;
    DowntimeActivitiesApp._instance = null;
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
      { scope: "player-activities" },
    );
    if (typeof unsubscribe === "function") this._unsubscribe = unsubscribe;
  }

  async _prepareContext() {
    let projection = null;
    try {
      projection = await this._adapter?.getPlayerProjection?.({
        actorId: this._actorId,
      });
    } catch (error) {
      console.error(`${MODULE_ID} | downtime player projection failed`, error);
      this._errorMessage =
        "Downtime Activities could not be refreshed. Your saved submission was not changed.";
    }

    const context = normalizePlayerDowntimeProjection(projection, {
      actorId: this._actorId,
      category: this._category,
    });
    this._actorId = context.actor?.id ?? this._actorId;
    if (!context.categories.some((category) => category.selected)) {
      this._category = DEFAULT_CATEGORY;
    }
    return {
      ...context,
      busy: this._busy,
      ariaBusy: this._busy || context.status === "applying",
      statusMessage: this._statusMessage,
      errorMessage: this._errorMessage,
      hasError: Boolean(this._errorMessage),
    };
  }

  _onRender(context, options) {
    super._onRender?.(context, options);
    applyVisualPrefs(this.element, "dt-");
    this._wireActivityInputs();
    this._restoreFocus();
  }

  _wireActivityInputs() {
    const root = this.element?.querySelector?.("[data-activity-list]");
    if (!root) return;
    root.addEventListener("change", (event) => {
      const input = event.target;
      if (!(input instanceof HTMLElement)) return;
      const card = input.closest?.("[data-activity-id]");
      if (!card) return;
      updateActivityCardSummary(card);
    });
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
        "An active full GM is required to change downtime activities.";
      this.render(false);
      return null;
    }
    this._busy = true;
    this._errorMessage = "";
    this._statusMessage = options.pending ?? "Sending request...";
    if (this.rendered) this.render(false);
    try {
      const result = await command.call(this._adapter, payload);
      this._statusMessage = options.success ?? "Downtime queue updated.";
      this._pendingFocus = options.focus ?? null;
      return result;
    } catch (error) {
      console.error(
        `${MODULE_ID} | downtime player command ${method} failed`,
        error,
      );
      this._errorMessage =
        String(error?.message ?? "").trim() ||
        "The GM could not accept that change. Your prior queue is unchanged.";
      this._statusMessage = "Downtime was not changed.";
      return null;
    } finally {
      this._busy = false;
      if (this.rendered) this.render(false);
    }
  }

  static async _onRefresh() {
    this._errorMessage = "";
    await this._runCommand(
      "refreshPlayerProjection",
      { actorId: this._actorId },
      {
        pending: "Refreshing downtime...",
        success: "Downtime refreshed.",
        focus: '[data-action="refresh"]',
      },
    );
  }

  static _onSelectActor(_event, target) {
    const actorId = cleanId(target?.dataset?.actorId);
    if (!actorId || actorId === this._actorId) return;
    this._actorId = actorId;
    this._category = DEFAULT_CATEGORY;
    this._pendingFocus = `[data-actor-id="${cssEscape(actorId)}"]`;
    this.render(false);
  }

  static _onSelectCategory(_event, target) {
    const category = cleanId(target?.dataset?.category) || DEFAULT_CATEGORY;
    if (category === this._category) return;
    this._category = category;
    this._pendingFocus = `[data-category="${cssEscape(category)}"]`;
    this.render(false);
  }

  static async _onAddActivity(_event, target) {
    const card = target?.closest?.("[data-activity-id]");
    const activityId = cleanId(card?.dataset?.activityId);
    if (!card || !activityId || target?.disabled) return;
    const values = readAllowedActivityInputs(card);
    await this._runCommand(
      "queueActivity",
      {
        actorId: this._actorId,
        activityId,
        ...values,
      },
      {
        pending: "Adding activity...",
        success: "Activity added to your queue.",
        focus: "[data-queue-list]",
      },
    );
  }

  static async _onMoveActivityUp(_event, target) {
    const queueEntryId = cleanId(target?.dataset?.queueEntryId);
    if (!queueEntryId) return;
    await this._runCommand(
      "reorderActivity",
      {
        actorId: this._actorId,
        queueEntryId,
        direction: "up",
      },
      {
        pending: "Reordering activity...",
        success: "Activity moved earlier.",
        focus: `[data-queue-entry-id="${cssEscape(queueEntryId)}"]`,
      },
    );
  }

  static async _onMoveActivityDown(_event, target) {
    const queueEntryId = cleanId(target?.dataset?.queueEntryId);
    if (!queueEntryId) return;
    await this._runCommand(
      "reorderActivity",
      {
        actorId: this._actorId,
        queueEntryId,
        direction: "down",
      },
      {
        pending: "Reordering activity...",
        success: "Activity moved later.",
        focus: `[data-queue-entry-id="${cssEscape(queueEntryId)}"]`,
      },
    );
  }

  static async _onRemoveActivity(_event, target) {
    const queueEntryId = cleanId(target?.dataset?.queueEntryId);
    if (!queueEntryId) return;
    await this._runCommand(
      "removeActivity",
      {
        actorId: this._actorId,
        queueEntryId,
      },
      {
        pending: "Removing activity...",
        success: "Activity removed from your queue.",
        focus: "[data-activity-list]",
      },
    );
  }

  static async _onSubmitQueue() {
    await this._runCommand(
      "submitQueue",
      { actorId: this._actorId },
      {
        pending: "Submitting your downtime queue...",
        success: "Downtime submitted. The GM can now lock the block.",
        focus: '[data-action="recallSubmission"]',
      },
    );
  }

  static async _onRecallSubmission() {
    await this._runCommand(
      "recallSubmission",
      { actorId: this._actorId },
      {
        pending: "Reopening your downtime queue...",
        success: "Submission reopened for editing.",
        focus: "[data-activity-list]",
      },
    );
  }
}

/**
 * Build the strictly player-safe Handlebars context. Unknown projection fields
 * are discarded so accidental server additions do not surface in the window.
 */
export function normalizePlayerDowntimeProjection(raw, uiState = {}) {
  const source = raw && typeof raw === "object" ? raw : {};
  const status = cleanId(source.status ?? source.workflowStatus ?? "idle");
  const actors = array(source.actors ?? source.actorOptions).map((actor) => ({
    id: cleanId(actor?.id ?? actor?.actorId),
    name: String(actor?.name ?? actor?.actorName ?? "Unknown character"),
    img: String(actor?.img ?? "icons/svg/mystery-man.svg"),
    eligible: actor?.eligible !== false,
    reason: String(actor?.reason ?? actor?.unavailableReason ?? ""),
  }));
  const requestedActorId = cleanId(uiState.actorId);
  const actor =
    actors.find((entry) => entry.id === requestedActorId && entry.eligible) ??
    actors.find((entry) => entry.eligible) ??
    null;
  for (const row of actors) row.selected = row.id === actor?.id;

  const requestedCategory = cleanId(uiState.category) || DEFAULT_CATEGORY;
  const activities = array(source.activities).map(normalizeActivity);
  const categoryIds = [
    DEFAULT_CATEGORY,
    ...new Set(activities.map((activity) => activity.category)),
  ];
  const selectedCategory = categoryIds.includes(requestedCategory)
    ? requestedCategory
    : DEFAULT_CATEGORY;
  const categories = categoryIds.map((id) => ({
    id,
    label: id === DEFAULT_CATEGORY ? "All" : titleCase(id),
    selected: id === selectedCategory,
  }));
  const visibleActivities = activities.filter(
    (activity) =>
      selectedCategory === DEFAULT_CATEGORY ||
      activity.category === selectedCategory,
  );

  const queue = array(source.queue ?? source.submission?.queue).map(
    (entry, index, all) => normalizeQueueEntry(entry, index, all.length),
  );
  const budgetHours = positiveInteger(source.budgetHours ?? source.hours, 0);
  const usedHours = positiveInteger(
    source.usedHours ?? queue.reduce((sum, entry) => sum + entry.hours, 0),
    0,
  );
  const remainingHours = Math.max(
    0,
    positiveInteger(source.remainingHours, budgetHours - usedHours),
  );
  const submitted =
    source.submitted === true || source.submission?.submitted === true;
  const hasActiveBlock = Boolean(
    source.hasActiveBlock ??
    source.blockId ??
    source.locationName ??
    source.settlementName,
  );
  const noGm = source.noGm === true;
  const needsRecovery =
    status === "needs-review" || source.needsRecovery === true;
  const editable =
    hasActiveBlock &&
    !noGm &&
    status === "collecting" &&
    actor &&
    !submitted &&
    !needsRecovery;
  const withinBudget = usedHours <= budgetHours;
  const canSubmit =
    editable && withinBudget && Boolean(source.canSubmit ?? true);
  const progressPercent =
    budgetHours > 0
      ? Math.min(100, Math.round((usedHours / budgetHours) * 100))
      : 0;
  const receipt = normalizeReceipt(source.receipt ?? source.latestReceipt);
  const heat = clamp(source.heat, 0, 5);

  return {
    status,
    guided: cleanId(source.mode) === "guided",
    statusLabel: playerStatusLabel(status, submitted),
    statusTone: playerStatusTone(status),
    hasActiveBlock,
    noGm,
    needsRecovery,
    recoveryMessage:
      String(source.recoveryMessage ?? "").trim() ||
      "The GM is reviewing an interrupted application. Your saved queue and receipt remain available.",
    settlementName: String(source.settlementName ?? "Settlement"),
    locationName: String(
      source.locationName ?? source.settlementName ?? "Camp or wilderness",
    ),
    hasSettlement: source.hasSettlement !== false,
    blockId: cleanId(source.blockId),
    actors,
    hasActors: actors.length > 0,
    hasMultipleActors: actors.filter((entry) => entry.eligible).length > 1,
    actor,
    heat,
    heatPips: [0, 1, 2, 3, 4].map((index) => ({
      active: index < heat,
    })),
    heatBlocked: source.heatBlocked ?? heat >= 5,
    heatMessage: String(source.heatMessage ?? ""),
    budgetHours,
    usedHours,
    remainingHours,
    progressPercent,
    categories,
    activities: visibleActivities,
    hasActivities: visibleActivities.length > 0,
    queue,
    hasQueue: queue.length > 0,
    submitted,
    editable,
    canSubmit: Boolean(canSubmit),
    submitReason:
      String(source.submitReason ?? "").trim() ||
      (!editable
        ? submitted
          ? "Your queue is already submitted."
          : "Submissions are not open."
        : usedHours > budgetHours
          ? "Your queue exceeds the time budget."
          : ""),
    canRecall:
      hasActiveBlock &&
      status === "collecting" &&
      submitted &&
      !noGm &&
      Boolean(source.canRecall ?? true),
    receipt,
    hasReceipt: Boolean(receipt),
    completionMessage: String(source.completionMessage ?? ""),
  };
}

function normalizeActivity(activity) {
  const source = activity && typeof activity === "object" ? activity : {};
  const id = cleanId(source.id ?? source.activityId);
  const category = cleanId(source.category ?? "routine") || "routine";
  const available = source.available !== false;
  const hourOptions = array(source.hourOptions ?? source.allowedHours).map(
    (entry) => {
      const value = positiveInteger(entry?.value ?? entry?.hours ?? entry, 0);
      return {
        value,
        label: String(entry?.label ?? `${value} hours`),
        selected:
          entry?.selected === true ||
          value === positiveInteger(source.hours, -1),
      };
    },
  );
  const catalogSkills = source.forcedSkill
    ? [source.forcedSkill]
    : source.allowedSkills;
  const skills = array(
    source.skillOptions ?? source.skills ?? catalogSkills,
  ).map((entry) => ({
    id: cleanId(entry?.id ?? entry?.value ?? entry),
    label: String(entry?.label ?? titleCase(entry?.id ?? entry)),
    selected:
      entry?.selected === true ||
      cleanId(entry) === cleanId(source.forcedSkill),
  }));
  const targets = array(source.targetOptions ?? source.targets).map(
    (entry) => ({
      id: cleanId(entry?.id ?? entry?.targetId ?? entry?.value),
      label: String(entry?.label ?? entry?.name ?? "Target"),
      detail: String(entry?.detail ?? entry?.description ?? ""),
      selected: entry?.selected === true,
      disabled: entry?.disabled === true,
    }),
  );
  const items = array(source.itemOptions ?? source.items).map((entry) => ({
    id: cleanId(entry?.id ?? entry?.itemId ?? entry?.value),
    label: String(entry?.label ?? entry?.name ?? "Item"),
    detail: String(entry?.detail ?? entry?.description ?? ""),
    selected: entry?.selected === true,
    disabled: entry?.disabled === true,
  }));
  const fixedHours = positiveInteger(source.fixedHours ?? source.hours, 0);
  const stakeAllowed =
    source.stakeAllowed === true || source.requiresStake === true;
  const maxStakeGp = Math.max(0, Number(source.maxStakeGp) || 0);
  const stakeStepGp = Math.max(0.01, Number(source.stakeStepGp) || 0.01);
  const requestedStakeGp = Number(source.stakeValueGp);
  const stakeValueGp =
    stakeAllowed && maxStakeGp >= stakeStepGp
      ? Math.min(
          maxStakeGp,
          Math.max(
            stakeStepGp,
            Number.isFinite(requestedStakeGp) ? requestedStakeGp : stakeStepGp,
          ),
        )
      : 0;
  return {
    id,
    label: String(source.label ?? titleCase(id)),
    description: String(source.description ?? ""),
    category,
    categoryLabel: titleCase(category),
    icon: safeIcon(source.icon),
    available,
    unavailableReason: String(
      source.unavailableReason ?? source.reason ?? "Prerequisites are not met.",
    ),
    hourOptions,
    hasHourOptions: hourOptions.length > 0,
    fixedHours,
    selectedHoursLabel:
      fixedHours > 0
        ? `${fixedHours} ${fixedHours === 1 ? "hour" : "hours"}`
        : ((hourOptions.find((option) => option.selected) ?? hourOptions[0])
            ?.label ?? ""),
    skills,
    hasSkills: skills.length > 0,
    targets,
    hasTargets: targets.length > 0,
    items,
    hasItems: items.length > 0,
    targetField: cleanId(source.targetField ?? "targetId") || "targetId",
    multiTarget: source.multiTarget === true,
    stakeAllowed,
    maxStakeGp,
    stakeStepGp,
    stakeValueGp,
    costLabel: String(source.costLabel ?? ""),
    limitLabel: String(source.limitLabel ?? ""),
  };
}

function normalizeQueueEntry(entry, index, total) {
  const source = entry && typeof entry === "object" ? entry : {};
  return {
    id: cleanId(source.id ?? source.queueEntryId ?? index),
    position: index + 1,
    label: String(source.label ?? source.activityLabel ?? "Activity"),
    icon: safeIcon(source.icon),
    hours: positiveInteger(source.hours, 0),
    detail: String(source.detail ?? source.summary ?? ""),
    canMoveUp: source.canMoveUp ?? index > 0,
    canMoveDown: source.canMoveDown ?? index < total - 1,
  };
}

function normalizeReceipt(receipt) {
  if (!receipt || typeof receipt !== "object") return null;
  const activities = array(receipt.activities ?? receipt.results).map(
    (entry) => ({
      id: cleanId(entry?.id ?? entry?.operationId),
      label: String(entry?.label ?? entry?.activityLabel ?? "Activity"),
      summary: String(entry?.summary ?? entry?.outcome ?? ""),
      tone: safeReceiptTone(entry?.tone ?? entry?.outcomeTier),
      image: String(entry?.image ?? ""),
      hasImage: Boolean(entry?.image),
      report: String(entry?.report ?? ""),
      rewardLabel: String(entry?.rewardLabel ?? ""),
    }),
  );
  return {
    settlementName: String(receipt.settlementName ?? "Settlement"),
    completedAt: formatDate(receipt.completedAt ?? receipt.createdAt),
    activities,
    hasActivities: activities.length > 0,
    summary: String(receipt.summary ?? ""),
  };
}

/** Read only the player-authorized activity fields from one activity card. */
export function readAllowedActivityInputs(card) {
  const result = {};
  for (const input of card?.querySelectorAll?.("[data-activity-input]") ?? []) {
    const field = cleanId(input?.name ?? input?.dataset?.field);
    if (!REQUEST_FIELDS.has(field)) continue;
    const raw = input.value;
    if (field === "targetIds") {
      result.targetIds = [
        ...new Set(
          Array.from(input.selectedOptions ?? [])
            .map((option) => cleanId(option?.value))
            .filter(Boolean),
        ),
      ].sort();
    } else if (field === "hours") result.hours = positiveInteger(raw, 0);
    else if (field === "stakeGp") {
      result.stakeGp = Math.max(0, Number(raw) || 0);
    } else {
      result[field] = cleanId(raw);
    }
  }
  return result;
}

function updateActivityCardSummary(card) {
  const hours = positiveInteger(
    card.querySelector?.('[name="hours"]')?.value ?? card.dataset?.fixedHours,
    0,
  );
  const summary = card.querySelector?.("[data-selected-hours]");
  if (summary)
    summary.textContent = `${hours} ${hours === 1 ? "hour" : "hours"}`;
}

function playerStatusLabel(status, submitted) {
  if (status === "collecting") return submitted ? "Submitted" : "Planning";
  const labels = {
    idle: "No active downtime",
    locked: "Submissions locked",
    planned: "GM reviewing preview",
    applying: "Resolving",
    completed: "Completed",
    cancelled: "Cancelled",
    "needs-review": "GM review needed",
  };
  return labels[status] ?? titleCase(status || "unknown");
}

function playerStatusTone(status) {
  if (status === "completed") return "success";
  if (status === "needs-review") return "danger";
  if (["planned", "applying"].includes(status)) return "accent";
  if (status === "cancelled") return "muted";
  return "neutral";
}

function safeReceiptTone(value) {
  const tone = cleanId(value);
  if (["exceptional", "exceptional-success"].includes(tone)) {
    return "exceptional";
  }
  if (["serious", "serious-failure"].includes(tone)) return "serious";
  if (["success", "setback", "failure"].includes(tone)) return tone;
  return "neutral";
}

function safeIcon(value) {
  const icon = String(value ?? "").trim();
  return /^fa-(?:solid|regular) fa-[a-z0-9-]+$/i.test(icon)
    ? icon
    : "fa-solid fa-hourglass-half";
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

function titleCase(value) {
  return String(value ?? "")
    .replace(/[-_]+/g, " ")
    .replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function positiveInteger(value, fallback = 0) {
  const numeric = Math.floor(Number(value));
  return Number.isFinite(numeric) && numeric >= 0 ? numeric : fallback;
}

function clamp(value, min, max) {
  const numeric = Math.floor(Number(value));
  return Math.min(max, Math.max(min, Number.isFinite(numeric) ? numeric : min));
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
