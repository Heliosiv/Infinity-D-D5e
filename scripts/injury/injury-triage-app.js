/** GM-only Critical Injury review and party-status workspace. */

import { isFullGM } from "../permissions.js";
import {
  bindFullGmWindowGuard,
  bindFocusRestoration,
  openSingleton,
} from "../infinity-app.js";
import { formatInjuryTimestamp } from "./calendar.js";
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
const { ApplicationV2, HandlebarsApplicationMixin } = foundry.applications.api;

export class CriticalInjuryTriageApp extends HandlebarsApplicationMixin(
  ApplicationV2,
) {
  static _instance = null;

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
    },
  };

  static PARTS = { body: { template: TEMPLATE_PATH } };

  static open() {
    if (!isFullGM()) {
      globalThis.ui?.notifications?.warn?.(
        "Critical Injury Triage is available to full Game Masters only.",
      );
      return null;
    }
    const app = openSingleton(
      CriticalInjuryTriageApp,
      () => new CriticalInjuryTriageApp(),
    );
    CriticalInjuryTriageApp._instance = app;
    return app;
  }

  constructor(options = {}) {
    super(options);
    bindFocusRestoration(this);
    this._message = "";
    this._tone = "ready";
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
        "infinityDnd5ePrivateStateChanged",
        globalThis.Hooks?.on?.("infinityDnd5ePrivateStateChanged", () =>
          this._refresh(),
        ),
      ],
    ].filter(([, id]) => id != null);
  }

  _refresh() {
    if (this.rendered) void this.render(false);
  }

  _onRender(context, options) {
    super._onRender?.(context, options);
    this._wireManualRecipient(this.element);
  }

  async _prepareContext() {
    if (!isFullGM()) return { accessDenied: true };
    const records = getCriticalInjuryTriageRecords();
    const rows = records
      .map((record) => buildTriageRow(record))
      .filter(Boolean)
      .sort(compareTriageRows);
    const playerCharacters = (globalThis.game?.actors?.contents ?? [])
      .filter((actor) => actor?.type === "character")
      .map((actor) => ({
        id: String(actor.id ?? ""),
        name: String(actor.name ?? "Character"),
        img: actor.img ?? "icons/svg/mystery-man.svg",
        owners: eligibleOwners(actor),
        injuries: getActorCriticalInjuryEffects(actor)
          .map((effect) => getCriticalInjuryData(effect))
          .filter(Boolean)
          .map((injury) => ({
            name: String(injury.injuryName ?? "Critical injury"),
            recovery: injury.permanent
              ? "Permanent"
              : `${Math.max(0, Number(injury.remainingDays) || 0)} day(s) remaining`,
          })),
      }))
      .filter((actor) => actor.id && actor.owners.length > 0)
      .sort((left, right) => left.name.localeCompare(right.name));
    this._manualOwnersByActor = new Map(
      playerCharacters.map((actor) => [
        actor.id,
        new Set(actor.owners.map((owner) => owner.id)),
      ]),
    );
    const playerUsers = (globalThis.game?.users?.contents ?? [])
      .filter((user) => user?.active && !user?.isGM)
      .map((user) => ({
        id: String(user.id ?? ""),
        name: String(user.name ?? "Player"),
      }));
    const reviewCount = rows.filter((row) => row.state === "review").length;
    return {
      rows,
      hasRows: rows.length > 0,
      reviewCount,
      pendingCount: rows.length - reviewCount,
      playerCharacters,
      hasPlayerCharacters: playerCharacters.length > 0,
      playerUsers,
      hasPlayerUsers: playerUsers.length > 0,
      partyRows: playerCharacters,
      message: this._message,
      tone: this._tone,
    };
  }

  async _run(action, successMessage) {
    try {
      await action();
      this._message = successMessage;
      this._tone = "success";
    } catch (error) {
      this._message = String(
        error?.message ?? "The injury action could not be completed.",
      );
      this._tone = "warning";
    }
    await this.render(false);
  }

  _wireManualRecipient(root) {
    const form = root?.querySelector?.(".ci-triage-start");
    const actorSelect = form?.elements?.actorId;
    const recipientSelect = form?.elements?.targetUserId;
    if (!actorSelect || !recipientSelect) return;
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
    };
    actorSelect.addEventListener("change", syncRecipient);
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
      "Manual injury review added. Send the roll when the table is ready.",
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
  if (!actor) return null;
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
    createdLabel: formatInjuryTimestamp(record.approvedAt),
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

function eligibleOwners(actor) {
  return (globalThis.game?.users?.contents ?? []).filter(
    (user) =>
      user?.active &&
      !user?.isGM &&
      (actor?.testUserPermission?.(user, "OWNER") === true ||
        Number(actor?.ownership?.[user.id] ?? 0) >= 3),
  );
}
