/**
 * Player-side downtime adapter.
 *
 * The Application owns display only. This adapter keeps local, reorderable
 * drafts; translates them into the narrow authoritative queue payload; and
 * resolves socket request/reply pairs without caching any GM-only fields.
 */

import { isAuthoritativeGM } from "../socket-authority.js";
import {
  getPlayerProjectionForUser,
  recallSubmissionAuthoritatively,
  submitQueueAuthoritatively,
} from "./service.js";
import {
  DOWNTIME_EVENTS,
  newDowntimeRequestId,
  recallDowntimeSubmission,
  registerDowntimeSocket,
  requestDowntimeSnapshot,
  submitDowntimeQueue,
  subscribeDowntime,
} from "./socket.js";

const MODULE_ID = "infinity-dnd5e";
const MAX_ID_LENGTH = 160;
const MAX_DRAFT_ACTIONS = 64;
const DEFAULT_REQUEST_TIMEOUT_MS = 15_000;
const DEFAULT_CACHE_MAX_AGE_MS = 5_000;
const LAY_LOW_ACTIVITY_ID = "lay-low";
const HEAT_BLOCKED_ACTIVITY_IDS = new Set([
  "pickpocket",
  "shoplift",
  "fence-stolen-goods",
]);

function clone(value) {
  if (value == null) return value;
  return (
    globalThis.foundry?.utils?.deepClone?.(value) ?? structuredClone(value)
  );
}

function cleanId(value) {
  const id = String(value ?? "").trim();
  return id && id.length <= MAX_ID_LENGTH ? id : "";
}

function cleanText(value, maximum = 500) {
  return String(value ?? "")
    .trim()
    .slice(0, maximum);
}

function safeInteger(value, minimum = 0, maximum = Number.MAX_SAFE_INTEGER) {
  const integer = Math.floor(Number(value));
  return Number.isSafeInteger(integer)
    ? Math.max(minimum, Math.min(maximum, integer))
    : minimum;
}

function safeNumber(value, minimum = 0, maximum = Number.MAX_SAFE_INTEGER) {
  const number = Number(value);
  return Number.isFinite(number)
    ? Math.max(minimum, Math.min(maximum, number))
    : minimum;
}

function safeIcon(value) {
  const icon = cleanText(value, 80);
  return /^fa-(?:solid|regular) fa-[a-z0-9-]+$/i.test(icon)
    ? icon
    : "fa-solid fa-hourglass-half";
}

function humanizeIdentifier(value) {
  return cleanId(value)
    .replace(/[-_]+/g, " ")
    .replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function selectedOptionLabel(activity, targetId) {
  const option = [...array(activity?.targets), ...array(activity?.items)].find(
    (entry) => entry.id === targetId,
  );
  return cleanText(option?.label, 200) || "Selected target";
}

function selectedBundleLabel(activity, targetIds) {
  const labels = array(targetIds)
    .map((targetId) => selectedOptionLabel(activity, targetId))
    .filter(Boolean);
  return labels.length > 0
    ? `Bundle: ${labels.join(" + ")}`
    : "Selected bundle";
}

function sanitizeTargetIds(values) {
  return [...new Set(array(values).map(cleanId).filter(Boolean))]
    .sort()
    .slice(0, MAX_DRAFT_ACTIONS);
}

function stakeLabel(stakeCp) {
  const amount = (stakeCp / 100)
    .toFixed(2)
    .replace(/\.00$/, "")
    .replace(/(\.\d)0$/, "$1");
  return `${amount} gp stake`;
}

function unlockCrimeAfterLayLow(activities, queue, heat) {
  const layLowQueued = queue.some(
    (entry) => entry.activityId === LAY_LOW_ACTIVITY_ID,
  );
  if (heat < 5 || !layLowQueued) {
    return {
      activities,
      heatBlocked: heat >= 5,
      heatMessage: "",
    };
  }

  return {
    activities: activities.map((activity) => {
      if (
        activity.available ||
        !HEAT_BLOCKED_ACTIVITY_IDS.has(activity.id) ||
        !/^Heat is 5\b/i.test(activity.unavailableReason)
      ) {
        return activity;
      }
      const hasTarget = [
        ...array(activity.targets),
        ...array(activity.items),
      ].some((option) => !option.disabled);
      return hasTarget
        ? { ...activity, available: true, unavailableReason: "" }
        : activity;
    }),
    heatBlocked: false,
    heatMessage: "Lay Low is queued; new crime can follow it.",
  };
}

function plainObject(value) {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function array(value) {
  return Array.isArray(value) ? value : [];
}

function sanitizeOption(raw) {
  if (!plainObject(raw)) return null;
  const id = cleanId(raw.id ?? raw.value ?? raw.targetId ?? raw.itemId);
  if (!id) return null;
  return {
    id,
    label: cleanText(raw.label ?? raw.name ?? "Option", 200),
    detail: cleanText(raw.detail ?? raw.description, 500),
    selected: raw.selected === true,
    disabled: raw.disabled === true,
    reason: cleanText(raw.reason, 300),
  };
}

function sanitizeActivity(raw) {
  if (!plainObject(raw)) return null;
  const id = cleanId(raw.id ?? raw.activityId);
  if (!id) return null;
  const hourOptions = array(raw.hourOptions ?? raw.allowedHours)
    .map((entry) => {
      const source = plainObject(entry) ? entry : { value: entry };
      const value = safeInteger(source.value ?? source.hours, 0, 80);
      return value > 0
        ? {
            value,
            label: cleanText(source.label ?? `${value} hours`, 100),
            selected: source.selected === true,
          }
        : null;
    })
    .filter(Boolean);
  const skills = array(raw.skills ?? raw.skillOptions ?? raw.allowedSkills)
    .map((entry) => {
      const source = plainObject(entry) ? entry : { id: entry };
      const skillId = cleanId(source.id ?? source.value);
      return skillId
        ? {
            id: skillId,
            label: cleanText(source.label ?? skillId, 100),
            selected: source.selected === true,
          }
        : null;
    })
    .filter(Boolean);
  const stakeAllowed = raw.stakeAllowed === true || raw.requiresStake === true;
  const maxStakeGp = safeNumber(raw.maxStakeGp, 0);
  const stakeStepGp = Math.max(0.01, safeNumber(raw.stakeStepGp, 0.01));
  const requestedStakeGp = safeNumber(raw.stakeValueGp, stakeStepGp);
  const stakeValueGp =
    stakeAllowed && maxStakeGp >= stakeStepGp
      ? Math.min(maxStakeGp, Math.max(stakeStepGp, requestedStakeGp))
      : 0;
  return {
    id,
    label: cleanText(raw.label ?? id, 200),
    description: cleanText(raw.description, 1_000),
    category: cleanId(raw.category) || "routine",
    icon: safeIcon(raw.icon),
    available: raw.available !== false,
    unavailableReason: cleanText(raw.unavailableReason ?? raw.reason, 500),
    hourOptions,
    fixedHours: safeInteger(raw.fixedHours, 0, 80),
    skills,
    forcedSkill: cleanId(raw.forcedSkill),
    targets: array(raw.targets ?? raw.targetOptions)
      .map(sanitizeOption)
      .filter(Boolean),
    items: array(raw.items ?? raw.itemOptions)
      .map(sanitizeOption)
      .filter(Boolean),
    targetField: cleanId(raw.targetField) || "targetId",
    multiTarget: raw.multiTarget === true,
    stakeAllowed,
    maxStakeGp,
    stakeStepGp,
    stakeValueGp,
    costLabel: cleanText(raw.costLabel, 300),
    limitLabel: cleanText(raw.limitLabel, 300),
  };
}

function sanitizeCanonicalEntry(raw, index = 0) {
  if (!plainObject(raw)) return null;
  const activityId = cleanId(raw.activityId ?? raw.activity);
  const hours = safeInteger(raw.hours, 0, 80);
  if (!activityId || hours < 1) return null;
  const entry = {
    id: cleanId(raw.id ?? raw.queueEntryId) || `action-${index + 1}`,
    activityId,
    hours,
  };
  const skill = cleanId(raw.skill ?? raw.skillId);
  const targetId = cleanId(raw.targetId ?? raw.target);
  const targetIds = sanitizeTargetIds(raw.targetIds);
  const stakeCp = safeInteger(raw.stakeCp ?? raw.stake, 0);
  if (skill) entry.skill = skill;
  if (targetId) entry.targetId = targetId;
  if (targetIds.length > 0) entry.targetIds = targetIds;
  if (stakeCp > 0) entry.stakeCp = stakeCp;
  return entry;
}

export function sanitizeDowntimeSubmissionQueue(rawQueue) {
  return array(rawQueue)
    .slice(0, MAX_DRAFT_ACTIONS)
    .map(sanitizeCanonicalEntry)
    .filter(Boolean);
}

function sanitizeDisplayQueue(rawQueue) {
  return array(rawQueue)
    .slice(0, MAX_DRAFT_ACTIONS)
    .map((raw, index) => {
      if (!plainObject(raw)) return null;
      const canonical = sanitizeCanonicalEntry(raw, index);
      const id = cleanId(raw.id ?? raw.queueEntryId) || canonical?.id;
      if (!id) return null;
      return {
        ...(canonical ?? { id, activityId: "", hours: 0 }),
        id,
        label: cleanText(raw.label ?? raw.activityLabel ?? "Activity", 200),
        icon: safeIcon(raw.icon),
        detail: cleanText(raw.detail ?? raw.summary, 500),
      };
    })
    .filter(Boolean);
}

function sanitizeReceipt(raw) {
  if (!plainObject(raw)) return null;
  return {
    settlementName: cleanText(raw.settlementName, 200),
    completedAt:
      Number.isSafeInteger(Number(raw.completedAt)) &&
      Number(raw.completedAt) >= 0
        ? Number(raw.completedAt)
        : null,
    summary: cleanText(raw.summary, 1_000),
    activities: array(raw.activities ?? raw.results)
      .slice(0, MAX_DRAFT_ACTIONS)
      .map((entry) => ({
        id: cleanId(entry?.id ?? entry?.operationId),
        label: cleanText(
          entry?.label ?? entry?.activityLabel ?? "Activity",
          200,
        ),
        summary: cleanText(entry?.summary ?? entry?.outcome, 1_000),
        tone: cleanId(entry?.tone ?? entry?.outcomeTier) || "neutral",
      })),
  };
}

/** Strip every field that is not part of the player projection contract. */
export function sanitizePlayerDowntimeSnapshot(raw) {
  const source = plainObject(raw) ? raw : {};
  const actors = array(source.actors ?? source.actorOptions)
    .map((actor) => {
      const id = cleanId(actor?.id ?? actor?.actorId);
      return id
        ? {
            id,
            name: cleanText(
              actor?.name ?? actor?.actorName ?? "Character",
              200,
            ),
            img: cleanText(actor?.img ?? "icons/svg/mystery-man.svg", 500),
            eligible: actor?.eligible !== false,
            reason: cleanText(actor?.reason ?? actor?.unavailableReason, 500),
          }
        : null;
    })
    .filter(Boolean);
  const rawQueue = sanitizeDowntimeSubmissionQueue(
    source.rawQueue ?? source.submission?.queue ?? source.queue,
  );
  return {
    status: cleanId(source.status ?? source.workflowStatus) || "idle",
    hasActiveBlock: Boolean(source.hasActiveBlock),
    noGm: source.noGm === true,
    settlementName: cleanText(source.settlementName ?? "Settlement", 200),
    blockId: cleanId(source.blockId),
    selectedActorId: cleanId(source.selectedActorId ?? source.actorId),
    actors,
    heat: safeInteger(source.heat, 0, 5),
    budgetHours: safeInteger(source.budgetHours ?? source.hours, 0, 8 * 30),
    usedHours: safeInteger(source.usedHours, 0, 8 * 30),
    remainingHours: safeInteger(source.remainingHours, 0, 8 * 30),
    activities: array(source.activities).map(sanitizeActivity).filter(Boolean),
    queue: sanitizeDisplayQueue(source.queue),
    rawQueue,
    submitted:
      source.submitted === true || source.submission?.submitted === true,
    canSubmit: source.canSubmit === true,
    canRecall: source.canRecall === true,
    needsRecovery: source.needsRecovery === true,
    recoveryMessage: cleanText(source.recoveryMessage, 1_000),
    submitReason: cleanText(source.submitReason, 500),
    receipt: sanitizeReceipt(source.receipt ?? source.latestReceipt),
    completionMessage: cleanText(source.completionMessage, 1_000),
  };
}

function queuesEqual(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function currentUserId() {
  return cleanId(globalThis.game?.user?.id);
}

function emptyProjection({ noGm = false } = {}) {
  return sanitizePlayerDowntimeSnapshot({ noGm });
}

export class DowntimePlayerAdapter {
  constructor(options = {}) {
    this._subscribeSocket = options.subscribeSocket ?? subscribeDowntime;
    this._registerSocket = options.registerSocket ?? registerDowntimeSocket;
    this._requestSnapshot = options.requestSnapshot ?? requestDowntimeSnapshot;
    this._submitTransport = options.submitTransport ?? submitDowntimeQueue;
    this._recallTransport = options.recallTransport ?? recallDowntimeSubmission;
    this._isAuthority = options.isAuthority ?? isAuthoritativeGM;
    this._getDirectProjection =
      options.getDirectProjection ?? getPlayerProjectionForUser;
    this._submitDirect = options.submitDirect ?? submitQueueAuthoritatively;
    this._recallDirect =
      options.recallDirect ?? recallSubmissionAuthoritatively;
    this._requestIdFactory = options.requestIdFactory ?? newDowntimeRequestId;
    this._getCurrentUserId = options.getCurrentUserId ?? currentUserId;
    this._setTimeout = options.setTimeout ?? globalThis.setTimeout;
    this._clearTimeout = options.clearTimeout ?? globalThis.clearTimeout;
    const requestedTimeout = Number(options.requestTimeoutMs);
    this._requestTimeoutMs = Number.isFinite(requestedTimeout)
      ? Math.max(100, Math.min(120_000, Math.floor(requestedTimeout)))
      : DEFAULT_REQUEST_TIMEOUT_MS;
    const requestedCacheAge = Number(options.cacheMaxAgeMs);
    this._cacheMaxAgeMs = Number.isFinite(requestedCacheAge)
      ? Math.max(0, Math.min(60_000, Math.floor(requestedCacheAge)))
      : DEFAULT_CACHE_MAX_AGE_MS;
    this._onAutoOpen =
      typeof options.onAutoOpen === "function" ? options.onAutoOpen : null;
    this._listeners = new Set();
    this._socketUnsubscribers = [];
    this._cache = new Map();
    this._drafts = new Map();
    this._pending = new Map();
    this._refreshing = new Map();
    this._destroyed = false;
    this._bindSocketEvents();
    this._registerSocket?.();
  }

  _bindSocketEvents() {
    this._socketUnsubscribers.push(
      this._subscribeSocket(DOWNTIME_EVENTS.SNAPSHOT_REPLY, (payload) =>
        this._handleSnapshotReply(payload),
      ),
      this._subscribeSocket(DOWNTIME_EVENTS.SUBMIT_RESULT, (payload) =>
        this._handleCommandResult(payload),
      ),
      this._subscribeSocket(DOWNTIME_EVENTS.STATE_UPDATE, (payload) =>
        this._handleStateUpdate(payload),
      ),
      this._subscribeSocket(DOWNTIME_EVENTS.AUTO_OPEN, (payload) =>
        this._handleAutoOpen(payload),
      ),
    );
  }

  subscribe(listener) {
    if (typeof listener !== "function") return () => {};
    this._listeners.add(listener);
    return () => this._listeners.delete(listener);
  }

  setAutoOpenHandler(callback) {
    this._onAutoOpen = typeof callback === "function" ? callback : null;
    return this;
  }

  destroy() {
    if (this._destroyed) return;
    this._destroyed = true;
    for (const unsubscribe of this._socketUnsubscribers.splice(0)) {
      unsubscribe?.();
    }
    for (const pending of this._pending.values()) {
      this._clearTimeout?.(pending.timer);
      pending.reject(new Error("Downtime adapter closed."));
    }
    this._pending.clear();
    this._listeners.clear();
    this._cache.clear();
    this._drafts.clear();
  }

  invalidate(actorId = "") {
    const actor = cleanId(actorId);
    if (!actor) {
      this._cache.clear();
      return;
    }
    for (const [key, cached] of this._cache) {
      if (key === actor || cached.projection.selectedActorId === actor) {
        this._cache.delete(key);
      }
    }
  }

  async getPlayerProjection({ actorId = "", force = false } = {}) {
    const actor = cleanId(actorId);
    const cached =
      this._cache.get(actor) ??
      (!actor ? this._cache.values().next().value : null);
    if (!force && cached) {
      if (
        Date.now() - cached.receivedAt > this._cacheMaxAgeMs &&
        !this._refreshing.has(actor)
      ) {
        void this._refreshProjection(actor).catch(() => {});
      }
      return this._projectDraft(actor, cached.projection);
    }
    try {
      const projection = await this._refreshProjection(actor);
      return this._projectDraft(actor, projection);
    } catch (error) {
      if (String(error?.message ?? "").includes("no active GM")) {
        const projection = emptyProjection({ noGm: true });
        const prior = cached?.projection;
        const receiptActorId =
          actor ||
          cleanId(prior?.selectedActorId) ||
          cleanId(prior?.actors?.[0]?.id);
        if (prior?.receipt) {
          projection.selectedActorId = receiptActorId;
          projection.receipt = sanitizeReceipt(prior.receipt);
          projection.completionMessage = cleanText(
            prior.completionMessage,
            1_000,
          );
        }
        const offline = this._cacheProjection(projection, actor, {
          replaceDraft: false,
        });
        return this._projectDraft(actor, offline);
      }
      throw error;
    }
  }

  refreshPlayerProjection({ actorId = "" } = {}) {
    return this.getPlayerProjection({ actorId, force: true });
  }

  async queueActivity(payload = {}) {
    const actorId = cleanId(payload.actorId);
    const projection = await this.getPlayerProjection({ actorId });
    this._assertEditable(projection, actorId);
    const key = this._draftKey(projection.blockId, actorId);
    const draft = this._ensureDraft(key, projection.rawQueue);
    if (draft.queue.length >= MAX_DRAFT_ACTIONS) {
      throw new Error("A downtime queue can contain at most 64 activities.");
    }
    const activityId = cleanId(payload.activityId);
    const hours = safeInteger(payload.hours, 0, 80);
    if (!activityId || hours < 1)
      throw new Error("Choose a valid activity and time.");
    const activity = projection.activities.find(
      (candidate) => candidate.id === activityId,
    );
    const targetIds = activity?.multiTarget
      ? sanitizeTargetIds(payload.targetIds)
      : [];
    if (activity?.multiTarget && targetIds.length === 0) {
      throw new Error("Choose at least one item for the fencing bundle.");
    }
    const targetId = cleanId(
      payload.targetId ??
        payload.ammunitionType ??
        payload.weaponId ??
        payload.bundleId ??
        payload.itemId,
    );
    const entry = {
      id: cleanId(payload.id) || cleanId(this._requestIdFactory("action")),
      activityId,
      hours,
    };
    const skill = cleanId(payload.skill ?? payload.skillId);
    const stakeCp = Number.isFinite(Number(payload.stakeGp))
      ? Math.round(Math.max(0, Number(payload.stakeGp)) * 100)
      : safeInteger(payload.stakeCp, 0);
    if (skill) entry.skill = skill;
    if (targetId) entry.targetId = targetId;
    if (targetIds.length > 0) entry.targetIds = targetIds;
    if (stakeCp > 0) entry.stakeCp = stakeCp;
    draft.queue.push(entry);
    draft.dirty = true;
    this._notify("draft-change", actorId);
    return clone(entry);
  }

  async reorderActivity({ actorId = "", queueEntryId, direction } = {}) {
    const actor = cleanId(actorId);
    const projection = await this.getPlayerProjection({ actorId: actor });
    this._assertEditable(projection, actor);
    const draft = this._ensureDraft(
      this._draftKey(projection.blockId, actor),
      projection.rawQueue,
    );
    const index = draft.queue.findIndex(
      (entry) => entry.id === cleanId(queueEntryId),
    );
    if (index < 0) throw new Error("That queued activity no longer exists.");
    const offset = direction === "up" ? -1 : direction === "down" ? 1 : 0;
    const nextIndex = index + offset;
    if (!offset || nextIndex < 0 || nextIndex >= draft.queue.length) {
      return clone(draft.queue);
    }
    [draft.queue[index], draft.queue[nextIndex]] = [
      draft.queue[nextIndex],
      draft.queue[index],
    ];
    draft.dirty = true;
    this._notify("draft-change", actor);
    return clone(draft.queue);
  }

  async removeActivity({ actorId = "", queueEntryId } = {}) {
    const actor = cleanId(actorId);
    const projection = await this.getPlayerProjection({ actorId: actor });
    this._assertEditable(projection, actor);
    const draft = this._ensureDraft(
      this._draftKey(projection.blockId, actor),
      projection.rawQueue,
    );
    const before = draft.queue.length;
    draft.queue = draft.queue.filter(
      (entry) => entry.id !== cleanId(queueEntryId),
    );
    if (draft.queue.length === before) {
      throw new Error("That queued activity no longer exists.");
    }
    draft.dirty = true;
    this._notify("draft-change", actor);
    return clone(draft.queue);
  }

  async submitQueue({ actorId = "" } = {}) {
    const actor = cleanId(actorId);
    const projection = await this.getPlayerProjection({ actorId: actor });
    this._assertEditable(projection, actor);
    const draft = this._ensureDraft(
      this._draftKey(projection.blockId, actor),
      projection.rawQueue,
    );
    const queue = sanitizeDowntimeSubmissionQueue(draft.queue);
    const requestId = cleanId(this._requestIdFactory("submit"));
    if (this._isAuthority()) {
      await this._submitDirect({
        userId: this._getCurrentUserId(),
        requestId,
        blockId: projection.blockId,
        actorId: actor,
        queue,
      });
      const fresh = await this._getDirectProjection({
        userId: this._getCurrentUserId(),
        actorId: actor,
      });
      this._cacheProjection(fresh, actor, { replaceDraft: true });
      return this._projectDraft(actor, sanitizePlayerDowntimeSnapshot(fresh));
    }
    const result = await this._sendRequest(
      requestId,
      { kind: "submit", actorId: actor, replaceDraft: true },
      () =>
        this._submitTransport({
          requestId,
          blockId: projection.blockId,
          actorId: actor,
          queue,
        }),
    );
    return this._projectDraft(actor, result.projection);
  }

  async recallSubmission({ actorId = "" } = {}) {
    const actor = cleanId(actorId);
    const projection = await this.getPlayerProjection({ actorId: actor });
    if (
      !projection.blockId ||
      projection.status !== "collecting" ||
      projection.submitted !== true
    ) {
      throw new Error("That downtime submission cannot be recalled now.");
    }
    const requestId = cleanId(this._requestIdFactory("recall"));
    if (this._isAuthority()) {
      await this._recallDirect({
        userId: this._getCurrentUserId(),
        requestId,
        blockId: projection.blockId,
        actorId: actor,
      });
      const fresh = await this._getDirectProjection({
        userId: this._getCurrentUserId(),
        actorId: actor,
      });
      this._cacheProjection(fresh, actor, { replaceDraft: true });
      return this._projectDraft(actor, sanitizePlayerDowntimeSnapshot(fresh));
    }
    const result = await this._sendRequest(
      requestId,
      { kind: "recall", actorId: actor, replaceDraft: true },
      () =>
        this._recallTransport({
          requestId,
          blockId: projection.blockId,
          actorId: actor,
        }),
    );
    return this._projectDraft(actor, result.projection);
  }

  _assertEditable(projection, actorId) {
    if (
      !projection?.blockId ||
      projection.noGm ||
      projection.status !== "collecting" ||
      projection.submitted ||
      !projection.actors.some(
        (actor) => actor.id === actorId && actor.eligible !== false,
      )
    ) {
      throw new Error("Downtime submissions are not open for that character.");
    }
  }

  _refreshProjection(actorId) {
    if (this._refreshing.has(actorId)) return this._refreshing.get(actorId);
    const refresh = (async () => {
      if (this._destroyed) throw new Error("Downtime adapter closed.");
      this._registerSocket?.();
      if (this._isAuthority()) {
        const projection = await this._getDirectProjection({
          userId: this._getCurrentUserId(),
          actorId,
        });
        return this._cacheProjection(projection, actorId);
      }
      const requestId = cleanId(this._requestIdFactory("snapshot"));
      const result = await this._sendRequest(
        requestId,
        { kind: "snapshot", actorId, replaceDraft: false },
        () => this._requestSnapshot(actorId || null, { requestId }),
      );
      return result.projection;
    })().finally(() => this._refreshing.delete(actorId));
    this._refreshing.set(actorId, refresh);
    return refresh;
  }

  _sendRequest(requestId, metadata, send) {
    if (!requestId || this._pending.has(requestId)) {
      return Promise.reject(
        new Error("Could not create a unique downtime request."),
      );
    }
    return new Promise((resolve, reject) => {
      const timer = this._setTimeout?.(() => {
        this._pending.delete(requestId);
        reject(new Error("The active GM did not answer the downtime request."));
      }, this._requestTimeoutMs);
      this._pending.set(requestId, {
        ...metadata,
        resolve,
        reject,
        timer,
      });
      let sent;
      try {
        sent = send();
      } catch (error) {
        this._settlePending(requestId, { error });
        return;
      }
      if (!sent?.ok) {
        const reason =
          sent?.reason === "no-gm"
            ? "There is no active GM available for downtime."
            : "The downtime request was rejected before it was sent.";
        this._settlePending(requestId, { error: new Error(reason) });
      }
    });
  }

  _handleSnapshotReply(payload) {
    const pending = this._pending.get(cleanId(payload?.requestId));
    if (!pending || pending.kind !== "snapshot") return;
    const projection = this._cacheProjection(
      payload.projection,
      pending.actorId,
      {
        replaceDraft: false,
      },
    );
    this._settlePending(payload.requestId, {
      value: { ok: true, projection },
    });
  }

  _handleCommandResult(payload) {
    const pending = this._pending.get(cleanId(payload?.requestId));
    if (!pending || !["submit", "recall"].includes(pending.kind)) return;
    if (payload.ok !== true) {
      this._settlePending(payload.requestId, {
        error: new Error(
          cleanText(payload.reason, 500) ||
            "The GM rejected the downtime request.",
        ),
      });
      return;
    }
    const projection = this._cacheProjection(
      payload.projection,
      pending.actorId,
      {
        replaceDraft: pending.replaceDraft,
      },
    );
    this._settlePending(payload.requestId, {
      value: { ok: true, projection },
    });
  }

  _handleStateUpdate(payload) {
    const projection = sanitizePlayerDowntimeSnapshot(payload?.projection);
    const actorId =
      projection.selectedActorId || projection.actors[0]?.id || "";
    this._cacheProjection(projection, actorId, { replaceDraft: false });
  }

  _handleAutoOpen(payload) {
    const actorId = cleanId(payload?.actorId);
    const blockId = cleanId(payload?.blockId);
    if (!actorId || !blockId) return;
    this.invalidate(actorId);
    this._notify("auto-open", actorId);
    if (!this._onAutoOpen) return;
    try {
      const result = this._onAutoOpen({ actorId, blockId, adapter: this });
      if (typeof result?.catch === "function") {
        result.catch((error) =>
          console.warn(`${MODULE_ID} | downtime auto-open callback`, error),
        );
      }
    } catch (error) {
      console.warn(`${MODULE_ID} | downtime auto-open callback`, error);
    }
  }

  _settlePending(requestId, { value, error } = {}) {
    const id = cleanId(requestId);
    const pending = this._pending.get(id);
    if (!pending) return false;
    this._pending.delete(id);
    this._clearTimeout?.(pending.timer);
    if (error) pending.reject(error);
    else pending.resolve(value);
    return true;
  }

  _cacheProjection(raw, actorHint = "", { replaceDraft = false } = {}) {
    const projection = sanitizePlayerDowntimeSnapshot(raw);
    const actorId =
      cleanId(actorHint) ||
      projection.selectedActorId ||
      projection.actors[0]?.id ||
      "";
    projection.selectedActorId = actorId;
    const prior = this._cache.get(actorId)?.projection;
    this._cache.set(actorId, {
      projection,
      receivedAt: Date.now(),
    });
    if (!cleanId(actorHint)) {
      this._cache.set("", {
        projection,
        receivedAt: Date.now(),
      });
    }
    for (const [cachedActorId, cached] of this._cache) {
      if (
        cachedActorId !== actorId &&
        cached.projection.blockId &&
        cached.projection.blockId !== projection.blockId
      ) {
        this._cache.delete(cachedActorId);
      }
    }

    if (projection.blockId && actorId) {
      const key = this._draftKey(projection.blockId, actorId);
      const draft = this._drafts.get(key);
      if (!draft || replaceDraft || projection.submitted || !draft.dirty) {
        this._drafts.set(key, {
          queue: sanitizeDowntimeSubmissionQueue(projection.rawQueue),
          dirty: false,
        });
      }
    }
    if (!prior || !queuesEqual(prior, projection)) {
      this._notify("state-update", actorId);
    }
    return projection;
  }

  _projectDraft(actorId, rawProjection) {
    const projection = clone(sanitizePlayerDowntimeSnapshot(rawProjection));
    const selectedActorId =
      cleanId(actorId) ||
      projection.selectedActorId ||
      projection.actors[0]?.id ||
      "";
    projection.selectedActorId = selectedActorId;
    const key = this._draftKey(projection.blockId, selectedActorId);
    const draft = projection.blockId
      ? this._ensureDraft(key, projection.rawQueue)
      : { queue: [], dirty: false };
    const queue = sanitizeDowntimeSubmissionQueue(draft.queue);
    const heatState = unlockCrimeAfterLayLow(
      projection.activities,
      queue,
      projection.heat,
    );
    projection.activities = heatState.activities;
    projection.heatBlocked = heatState.heatBlocked;
    projection.heatMessage = heatState.heatMessage;
    const activities = new Map(
      projection.activities.map((activity) => [activity.id, activity]),
    );
    projection.rawQueue = clone(queue);
    projection.queue = queue.map((entry) => {
      const activity = activities.get(entry.activityId);
      const detail = [];
      if (entry.skill) {
        const skill = array(activity?.skills).find(
          (option) => option.id === entry.skill,
        );
        detail.push(skill?.label || humanizeIdentifier(entry.skill));
      }
      if (entry.stakeCp) detail.push(stakeLabel(entry.stakeCp));
      if (entry.targetIds?.length > 0) {
        detail.push(selectedBundleLabel(activity, entry.targetIds));
      } else if (entry.targetId) {
        detail.push(selectedOptionLabel(activity, entry.targetId));
      }
      return {
        ...entry,
        label: activity?.label ?? entry.activityId,
        icon: activity?.icon ?? "fa-solid fa-hourglass-half",
        detail: detail.join(" · "),
      };
    });
    projection.usedHours = queue.reduce((sum, entry) => sum + entry.hours, 0);
    projection.remainingHours = Math.max(
      0,
      projection.budgetHours - projection.usedHours,
    );
    projection.canSubmit = Boolean(
      projection.blockId &&
      !projection.noGm &&
      projection.status === "collecting" &&
      !projection.submitted &&
      projection.usedHours <= projection.budgetHours,
    );
    return projection;
  }

  _ensureDraft(key, initialQueue) {
    let draft = this._drafts.get(key);
    if (!draft) {
      draft = {
        queue: sanitizeDowntimeSubmissionQueue(initialQueue),
        dirty: false,
      };
      this._drafts.set(key, draft);
    }
    return draft;
  }

  _draftKey(blockId, actorId) {
    return `${cleanId(blockId)}:${cleanId(actorId)}`;
  }

  _notify(reason, actorId = "") {
    for (const listener of this._listeners) {
      try {
        listener({ reason, actorId });
      } catch (error) {
        console.warn(`${MODULE_ID} | downtime adapter listener`, error);
      }
    }
  }
}

export function createDowntimePlayerAdapter(options = {}) {
  return new DowntimePlayerAdapter(options);
}

let defaultAdapter = null;

/** Return the one normal player adapter used by launchers and auto-open. */
export function getDowntimePlayerAdapter(options = {}) {
  if (!defaultAdapter) defaultAdapter = createDowntimePlayerAdapter(options);
  else if (typeof options.onAutoOpen === "function") {
    defaultAdapter.setAutoOpenHandler(options.onAutoOpen);
  }
  return defaultAdapter;
}

/** Register or replace the targeted auto-open callback on the singleton. */
export function configureDowntimePlayerAutoOpen(callback) {
  return getDowntimePlayerAdapter().setAutoOpenHandler(callback);
}

export function resetDowntimePlayerAdapterForTests() {
  defaultAdapter?.destroy();
  defaultAdapter = null;
}
