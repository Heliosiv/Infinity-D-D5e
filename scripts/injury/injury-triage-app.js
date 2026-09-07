import { CRITICAL_INJURY_TABLE_VERSION } from "./table.js";
/** GM-only Critical Injury review and party-status workspace. */

import { isFullGM } from "../permissions.js";
import { PRIVATE_STATE_CHANGED_HOOK } from "../private-state.js";
import { isAuthoritativeGM } from "../socket-authority.js";
import {
  bindFullGmWindowGuard,
  bindFocusRestoration,
  openSingleton,
} from "../infinity-app.js";
import { GM_WORKBENCH_TEMPLATE_PATH, GmWorkbenchApp } from "../gm-workbench.js";
import {
  formatInjuryTimestamp,
  injuryRecoveryLabel,
  isSimpleCalendarAvailable,
  openInjuryCalendar,
} from "./calendar.js";
import { syncCriticalInjuryCalendar } from "./calendar-sync.js";
import { buildCriticalInjuryTableReference } from "./table-reference.js";
import { getCriticalInjuryLogRows } from "./injury-log.js";
import { CriticalInjuryApp } from "./injury-app.js";
import { isAssignedPlayerCharacter } from "./actors.js";
import { getStandaloneRecordedInjuryRows } from "./recorded-injuries.js";
import {
  getActorCriticalInjuryEffects,
  getCriticalInjuryData,
} from "./effects.js";
import {
  dismissCriticalInjuryReview,
  getCriticalInjuryTriageRecords,
  sendCriticalInjuryReview,
  startCriticalInjuryReview,
} from "./service.js";

const MODULE_ID = "infinity-dnd5e";
const TEMPLATE_PATH = `modules/${MODULE_ID}/templates/critical-injury-triage.hbs`;
export class CriticalInjuryTriageApp extends GmWorkbenchApp {
  static _instance = null;
  static WORKBENCH_ROUTE = "injuries";

  static DEFAULT_OPTIONS = {
    id: "infinity-dnd5e-critical-injury-triage",
    tag: "section",
    classes: ["infinity-dnd5e", "infinity-critical-injury-triage"],
    window: {
      title: "Critical Injury Triage",
      icon: "fa-solid fa-heart-pulse",
      resizable: true,
    },
    position: { width: 760, height: 640 },
    actions: {
      startReview: CriticalInjuryTriageApp._onStartReview,
      sendReview: CriticalInjuryTriageApp._onSendReview,
      dismissReview: CriticalInjuryTriageApp._onDismissReview,
      refresh: CriticalInjuryTriageApp._onRefresh,
      openCharacter: CriticalInjuryTriageApp._onOpenCharacter,
      openSheet: CriticalInjuryTriageApp._onOpenSheet,
      openCalendar: CriticalInjuryTriageApp._onOpenCalendar,
      syncCalendar: CriticalInjuryTriageApp._onSyncCalendar,
      showView: CriticalInjuryTriageApp._onShowView,
      startManualReview: CriticalInjuryTriageApp._onStartManualReview,
      navigateGmWorkbench: GmWorkbenchApp._onNavigate,
      openGmWorkbenchUtility: GmWorkbenchApp._onOpenUtility,
    },
  };

  static PARTS = {
    workbench: { template: GM_WORKBENCH_TEMPLATE_PATH },
    body: { template: TEMPLATE_PATH },
  };

  static open(options = {}) {
    if (!isFullGM()) {
      globalThis.ui?.notifications?.warn?.(
        "Critical Injury Triage is available to full Game Masters only.",
      );
      return null;
    }
    const app = openSingleton(
      CriticalInjuryTriageApp,
      () => new CriticalInjuryTriageApp(options),
    );
    if (options.workbench) app.setWorkbenchTarget(options.workbench);
    CriticalInjuryTriageApp._instance = app;
    return app;
  }

  constructor(options = {}) {
    super(options);
    bindFocusRestoration(this);
    this._message = "";
    this._tone = "ready";
    this._actionInFlight = false;
    this._view = "triage";
    this._manualActorId = "";
    this._manualRecipientId = "";
    this._manualOpen = false;
    this._search = "";
    this._unbindFullGmWindowGuard = bindFullGmWindowGuard(this);
    this._refreshHookIds = [
      [
        "updateActor",
        globalThis.Hooks?.on?.("updateActor", () => this._refresh()),
      ],
      [
        "createActiveEffect",
        globalThis.Hooks?.on?.("createActiveEffect", () => this._refresh()),
      ],
      [
        "updateActiveEffect",
        globalThis.Hooks?.on?.("updateActiveEffect", () => this._refresh()),
      ],
      [
        "deleteActiveEffect",
        globalThis.Hooks?.on?.("deleteActiveEffect", () => this._refresh()),
      ],
      [
        PRIVATE_STATE_CHANGED_HOOK,
        globalThis.Hooks?.on?.(PRIVATE_STATE_CHANGED_HOOK, () =>
          this._refresh(),
        ),
      ],
      [
        "updateUser",
        globalThis.Hooks?.on?.("updateUser", () => this._refresh()),
      ],
      [
        "updateWorldTime",
        globalThis.Hooks?.on?.("updateWorldTime", () => this._refresh()),
      ],
    ].filter(([, id]) => id != null);
  }

  _refresh() {
    if (this.rendered) void this.render(false);
  }

  _onRender(context, options) {
    super._onRender?.(context, options);
    this._wireManualRecipient(this.element);
    const search = this.element?.querySelector?.('[data-role="injury-search"]');
    if (search) {
      search.value = this._search;
      search.addEventListener("input", () => {
        this._search = search.value;
        this._filterRows();
      });
      this._filterRows();
    }
    const manual = this.element?.querySelector?.(".ci-triage-manual");
    if (manual) {
      manual.open = this._manualOpen;
      manual.addEventListener("toggle", () => {
        this._manualOpen = manual.open;
      });
    }
    if (this._focusSearchAfterRender) {
      this._focusSearchAfterRender = false;
      search?.focus?.();
    }
    if (this._focusManualAfterRender) {
      this._focusManualAfterRender = false;
      manual?.querySelector?.('[name="actorId"]')?.focus?.();
    }
  }

  async _prepareContext() {
    if (!isFullGM()) {
      return {
        workbench: this.prepareWorkbenchContext?.() ?? null,
        accessDenied: true,
      };
    }
    const canMutate = isAuthoritativeGM();
    const records = getCriticalInjuryTriageRecords();
    const rows = records
      .map((record) => {
        const row = buildTriageRow(record);
        return row
          ? {
              ...row,
              canMutate,
              actionInFlight: this._actionInFlight,
            }
          : null;
      })
      .filter(Boolean)
      .sort(compareTriageRows);
    const playerCharacters = (globalThis.game?.actors?.contents ?? [])
      .filter((actor) => isAssignedPlayerCharacter(actor))
      .map((actor) => ({
        id: String(actor.id ?? ""),
        name: String(actor.name ?? "Character"),
        img: actor.img ?? "icons/svg/mystery-man.svg",
        owners: eligibleOwners(actor),
        recordedInjuries: getStandaloneRecordedInjuryRows(actor),
        injuries: getActorCriticalInjuryEffects(actor)
          .map((effect) => getCriticalInjuryData(effect))
          .filter(Boolean)
          .map((injury) => ({
            name: String(injury.injuryName ?? "Critical injury"),
            recovery: injuryRecoveryLabel(injury),
            dueLabel: injury.permanent
              ? ""
              : formatInjuryTimestamp(injury.recoveryDueTs),
            calendarLinked: Boolean(injury.calendarEntryId),
            effect: injury.effect,
          })),
      }))
      .filter((actor) => actor.id && actor.owners.length > 0)
      .sort(
        (left, right) =>
          right.injuries.length - left.injuries.length ||
          left.name.localeCompare(right.name),
      );
    this._manualOwnersByActor = new Map(
      playerCharacters.map((actor) => [
        actor.id,
        new Set(actor.owners.map((owner) => owner.id)),
      ]),
    );
    const playerUsers = (globalThis.game?.users?.contents ?? [])
      .filter((user) => user && !isFullGM(user))
      .map((user) => ({
        id: String(user.id ?? ""),
        name: String(user.name ?? "Player"),
      }));
    const pendingReviewCount = rows.filter(
      (row) => row.state === "review",
    ).length;
    const reviewCount =
      pendingReviewCount +
      playerCharacters.reduce(
        (count, actor) =>
          count +
          actor.recordedInjuries.filter((record) => record.status === "review")
            .length,
        0,
      );
    const logRows = getCriticalInjuryLogRows();
    return {
      workbench: this.prepareWorkbenchContext?.() ?? null,
      rows,
      hasRows: rows.length > 0,
      reviewCount,
      pendingCount: rows.length - pendingReviewCount,
      playerCharacters,
      hasPlayerCharacters: playerCharacters.length > 0,
      playerUsers,
      hasPlayerUsers: playerUsers.length > 0,
      partyRows: playerCharacters,
      activeCount: playerCharacters.reduce(
        (total, actor) =>
          total +
          actor.injuries.length +
          actor.recordedInjuries.filter(
            (record) =>
              record.status === "active" || record.status === "permanent",
          ).length,
        0,
      ),
      calendarMissingCount: playerCharacters.reduce(
        (total, actor) =>
          total +
          actor.injuries.filter((injury) => !injury.calendarLinked).length,
        0,
      ),
      calendarActive: isSimpleCalendarAvailable(),
      showLog: this._view === "history",
      showTable: this._view === "table",
      tableRows: buildCriticalInjuryTableReference(),
      tableVersion: CRITICAL_INJURY_TABLE_VERSION,
      midiActive: globalThis.game?.modules?.get?.("midi-qol")?.active === true,
      logRows,
      hasLogRows: logRows.length > 0,
      logCount: logRows.length,
      canMutate,
      actionInFlight: this._actionInFlight,
      message: this._message,
      tone: this._tone,
    };
  }

  _captureWorkbenchTarget() {
    return {
      route: CriticalInjuryTriageApp.WORKBENCH_ROUTE,
      subview: this._view ?? "triage",
    };
  }

  _applyWorkbenchTarget(target) {
    this._view = ["history", "table"].includes(target.subview)
      ? target.subview
      : "triage";
  }

  _filterRows() {
    const query = String(this._search ?? "")
      .trim()
      .toLocaleLowerCase();
    const rows = [
      ...(this.element?.querySelectorAll?.("[data-injury-search]") ?? []),
    ];
    let visible = 0;
    for (const row of rows) {
      row.hidden = !String(row.dataset.injurySearch)
        .toLocaleLowerCase()
        .includes(query);
      if (!row.hidden) visible++;
    }
    const empty = this.element?.querySelector?.(
      '[data-role="injury-no-matches"]',
    );
    if (empty) empty.hidden = !query || visible > 0;
  }

  static _onShowView(_event, target) {
    this._view = ["history", "table"].includes(target?.dataset?.view)
      ? target.dataset.view
      : "triage";
    this._search = "";
    this._focusSearchAfterRender = true;
    return this.render(false);
  }

  static _onStartManualReview() {
    if (!isAuthoritativeGM()) return;
    this._view = "triage";
    this._manualOpen = true;
    this._focusManualAfterRender = true;
    return this.render(false);
  }

  static _onOpenCharacter(_event, target) {
    if (!isFullGM()) return;
    return CriticalInjuryApp.open({ actorId: target?.dataset?.actorId });
  }

  static _onOpenSheet(_event, target) {
    if (!isFullGM()) return;
    const actor = globalThis.game?.actors?.get?.(target?.dataset?.actorId);
    if (isAssignedPlayerCharacter(actor)) return actor.sheet?.render?.(true);
  }

  static async _onOpenCalendar() {
    try {
      await openInjuryCalendar();
    } catch (error) {
      this._message = error.message;
      this._tone = "warning";
      await this.render(false);
    }
  }

  static async _onSyncCalendar() {
    return this._run(async () => {
      const result = await syncCriticalInjuryCalendar();
      if (result.failed || result.skipped) {
        throw new Error(
          `${result.linked} calendar link(s) saved; ${result.failed} could not sync and ${result.skipped} need their pending work or saved receipt checked. No injury rolls were repeated.`,
        );
      }
    }, "Calendar checked. All eligible active injuries have calendar entries.");
  }

  async _run(action, successMessage) {
    if (this._actionInFlight) return;
    this._actionInFlight = true;
    void this.render(false);
    try {
      await action();
      this._message = successMessage;
      this._tone = "success";
    } catch (error) {
      this._message = String(
        error?.message ?? "The injury action could not be completed.",
      );
      this._tone = "warning";
    } finally {
      this._actionInFlight = false;
    }
    await this.render(false);
  }

  _wireManualRecipient(root) {
    const form = root?.querySelector?.(".ci-triage-start");
    const actorSelect = form?.elements?.actorId;
    const recipientSelect = form?.elements?.targetUserId;
    if (!actorSelect || !recipientSelect) return;
    if (this._manualOwnersByActor?.has(this._manualActorId))
      actorSelect.value = this._manualActorId;
    if (this._manualRecipientId)
      recipientSelect.value = this._manualRecipientId;
    const syncRecipient = () => {
      const ownerIds =
        this._manualOwnersByActor?.get(String(actorSelect.value ?? "")) ??
        new Set();
      for (const option of recipientSelect.options) {
        const eligible = ownerIds.has(String(option.value ?? ""));
        option.disabled = !eligible;
        option.hidden = !eligible;
      }
      if (!ownerIds.has(String(recipientSelect.value ?? ""))) {
        const firstEligible = [...recipientSelect.options].find(
          (option) => !option.disabled,
        );
        if (firstEligible) recipientSelect.value = firstEligible.value;
      }
      this._manualActorId = actorSelect.value;
      this._manualRecipientId = recipientSelect.value;
    };
    actorSelect.addEventListener("change", syncRecipient);
    recipientSelect.addEventListener("change", () => {
      this._manualRecipientId = recipientSelect.value;
    });
    syncRecipient();
  }

  /** @this {CriticalInjuryTriageApp} */
  static async _onStartReview(_event, target) {
    const form = target?.closest?.("form");
    const actorId = String(form?.elements?.actorId?.value ?? "");
    const targetUserId = String(form?.elements?.targetUserId?.value ?? "");
    if (!actorId || !targetUserId) {
      this._message =
        "Choose a player character and its player before starting a review.";
      this._tone = "warning";
      return this.render(false);
    }
    return this._run(
      () => startCriticalInjuryReview({ actorId, targetUserId }),
      "Review queued; no injury added. Choose Send roll to prompt the player, or No injury to cancel.",
    );
  }

  /** @this {CriticalInjuryTriageApp} */
  static async _onSendReview(_event, target) {
    const pendingId = String(target?.dataset?.pendingId ?? "");
    if (!pendingId) return;
    return this._run(
      () => sendCriticalInjuryReview(pendingId),
      "Roll prompt sent. The player can now open Critical Injuries and roll d100.",
    );
  }

  /** @this {CriticalInjuryTriageApp} */
  static async _onDismissReview(_event, target) {
    const pendingId = String(target?.dataset?.pendingId ?? "");
    if (!pendingId) return;
    return this._run(
      () => dismissCriticalInjuryReview(pendingId),
      "Review dismissed. No injury was added to the character.",
    );
  }

  /** @this {CriticalInjuryTriageApp} */
  static _onRefresh() {
    this._message = "";
    this._tone = "ready";
    return this.render(false);
  }

  _onClose(options) {
    super._onClose?.(options);
    this._unbindFullGmWindowGuard?.();
    this._unbindFullGmWindowGuard = null;
    for (const [event, id] of this._refreshHookIds ?? []) {
      globalThis.Hooks?.off?.(event, id);
    }
    this._refreshHookIds = [];
    if (CriticalInjuryTriageApp._instance === this) {
      CriticalInjuryTriageApp._instance = null;
    }
  }
}

function buildTriageRow(record) {
  const actor = globalThis.game?.actors?.get?.(record.actorId);
  if (!isAssignedPlayerCharacter(actor)) return null;
  const injuries = getActorCriticalInjuryEffects(actor)
    .map((effect) => getCriticalInjuryData(effect))
    .filter(Boolean)
    .map((injury) => ({
      name: String(injury.injuryName ?? "Critical injury"),
      permanent: injury.permanent === true,
      recovery: injury.permanent
        ? "Permanent"
        : `${Math.max(0, Number(injury.remainingDays) || 0)} day(s) remaining${injury.recoveryDueTs ? ` · due ${formatInjuryTimestamp(injury.recoveryDueTs)}` : ""}`,
    }));
  return {
    actorId: record.actorId,
    pendingId: record.pendingId,
    actorName: String(actor.name ?? "Character"),
    actorImg: actor.img ?? "icons/svg/mystery-man.svg",
    state: record.state,
    stateLabel:
      record.state === "review"
        ? "Needs GM review"
        : record.state === "resolving"
          ? "Result applying"
          : "Player roll pending",
    sent: record.state !== "review",
    targetName:
      globalThis.game?.users?.get?.(record.targetUserId)?.name ??
      "Assigned player",
    createdLabel: new Date(record.approvedAt).toLocaleString(),
    injuries,
    hasInjuries: injuries.length > 0,
    injuryCount: injuries.length,
  };
}

function compareTriageRows(left, right) {
  const rank = { review: 0, approved: 1, resolving: 2 };
  return (
    (rank[left.state] ?? 3) - (rank[right.state] ?? 3) ||
    left.actorName.localeCompare(right.actorName)
  );
}

export function eligibleOwners(actor) {
  const ownerLevel = globalThis.CONST?.DOCUMENT_OWNERSHIP_LEVELS?.OWNER ?? 3;
  return (globalThis.game?.users?.contents ?? []).filter(
    (user) =>
      user &&
      !isFullGM(user) &&
      (assignedCharacterId(user) === String(actor?.id ?? "") ||
        actor?.testUserPermission?.(user, ownerLevel, { exact: false }) ===
          true ||
        Number(
          Object.hasOwn(actor?.ownership ?? {}, user.id)
            ? actor.ownership[user.id]
            : actor?.ownership?.default,
        ) >= Number(ownerLevel)),
  );
}

function assignedCharacterId(user) {
  return String(
    typeof user?.character === "string"
      ? user.character
      : (user?.character?.id ?? ""),
  );
}
