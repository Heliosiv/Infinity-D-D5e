import { DOWNTIME_ACTIVITY_IDS, getDowntimeActivity } from "./catalog.js";
import { DOWNTIME_OUTCOME_TIERS, getFencingValueCapCp } from "./math.js";
import {
  createDowntimeOpportunitySecretBundle,
  deterministicDowntimeRoll,
} from "./opportunities.js";
import {
  DOWNTIME_SUBMISSION_MAX_ACTIONS,
  buildDowntimeOperationId,
  normalizeDowntimeQueue,
  normalizeDowntimeSkill,
  resolveDowntimeQueue,
  validateDowntimeQueue,
} from "./planner.js";
import {
  createNonSettlementDowntimeContext,
  createSettlementIdFromName,
  getDowntimeHeat,
  normalizeDowntimeConfig,
  normalizeSettlementProfile,
  setDowntimeHeat,
} from "./settlements.js";
import {
  GUIDED_DOWNTIME_MODE,
  guidedDowntimeSkillLabel,
  guidedTemplateById,
  normalizeGuidedDowntimeSelection,
  projectGuidedDowntimeTemplate,
} from "./dispatch.js";
import {
  guidedProjectById,
  normalizeGuidedDowntimeProject,
  projectGuidedDowntimeProject,
} from "./projects.js";
import {
  beginDowntimeApplication,
  cancelDowntimeBlock,
  claimDowntimeOperation,
  completeDowntimeBlock,
  createDowntimeBlock,
  ensureDowntimeWorkflowAuthority,
  getActiveDowntimeBlock,
  getDowntimeWorkflowRevision,
  initializeDowntimePlanningDraft,
  loadDowntimeConfig,
  loadDowntimeWorkflowStore,
  lockDowntimeBlock,
  markDowntimeNeedsReview,
  markDowntimePlanningDraftNeedsReview,
  persistDowntimePlan,
  registerDowntimeWorkflowObserver,
  resolveDowntimeOperation,
  resolveRecoveredDowntimeOperation,
  resolveDowntimePlanningRoll,
  saveDowntimeConfig,
  claimDowntimePlanningRoll,
  updateDowntimeConfig,
  updateCollectingDowntimeBlock,
  updateGuidedDowntimePlan,
} from "./store.js";
import {
  applyAmmoCraftOperation,
  applyFenceOperation,
  applyStolenItemDelivery,
  ammoCraftDeliveryItemMatches,
  actorHasAnyTool,
  ammoCraftCostCp,
  buildAmmoCraftOperation,
  buildStolenCoinPurse,
  cleanAmmoStack,
  collectionValues,
  markStolenSnapshot,
  PICKPOCKET_CURATED_ITEMS,
  planWalletDeltaCp,
  resolveItemSnapshot,
  stolenProvenance,
} from "./items.js";
import {
  applySharpeningEffect,
  clearSharpeningOnLongRest,
  consumeSharpeningCharge,
  hasSharpening,
  isSharpenableWeapon,
  sharpenDamageType,
  sharpeningEffects,
} from "./effects.js";
import {
  completeSharpeningLifecycleEvent,
  enqueueSharpeningLifecycleEvent,
  failSharpeningLifecycleEvent,
} from "./sharpening-lifecycle.js";
import { buildActorDowntimeContext } from "./targets.js";
import {
  activeStolenGoodsRecord,
  buildStolenGoodsConsumption,
  buildStolenGoodsIssuance,
  consumeStolenGoodsRecord,
  issueStolenGoodsRecord,
  stolenGoodsRecord,
  stolenGoodsRecordsEqual,
} from "./stolen-ledger.js";

const GUIDED_PROJECT_OUTCOMES = Object.freeze([
  {
    label: "Steady work",
    report: "You made careful, useful progress on the project.",
  },
  {
    label: "Focused progress",
    report: "Your focused work moved the project forward cleanly.",
  },
  {
    label: "Breakthrough",
    report: "A breakthrough clarified the next stage of the project.",
  },
]);
import { rollSkillTotal } from "../dnd5e-roll.js";
import {
  readWalletStrict,
  totalWalletCp,
  updateCurrencyVerified,
  walletsEqual,
} from "../merchant/currency.js";
import {
  findMerchant,
  loadMerchants,
  updateMerchant,
} from "../merchant/store.js";
import {
  findActorItem,
  merchantItemId,
} from "../merchant/write-verification.js";
import {
  runWithActorMutex,
  runWithMerchantActorMutex,
} from "../merchant/session-state.js";
import {
  HISTORY_CAP,
  clampStanding,
  normalizeFaction,
} from "../reputation/standing.js";
import { loadFactions, updateFaction } from "../reputation/store.js";
import { isFullGM } from "../permissions.js";
import {
  normalizeInfinityItemUuid,
  sameInfinityItemUuid,
} from "../item-uuid-compat.js";
import { isAuthoritativeGM } from "../socket-authority.js";
import {
  DOWNTIME_EVENTS,
  emitSharpeningLifecycleAck,
  emitDowntimeEvent,
  newDowntimeRequestId,
  subscribeDowntime,
} from "./socket.js";

const MODULE_ID = "infinity-dnd5e";
const MAX_BLOCK_HOURS = 8 * 30;
const MAX_REQUEST_RECEIPTS = 200;
const CHECKED_ACTIVITIES = new Set([
  DOWNTIME_ACTIVITY_IDS.MARKET_TRADING,
  DOWNTIME_ACTIVITY_IDS.PICKPOCKET,
  DOWNTIME_ACTIVITY_IDS.SHOPLIFT,
  DOWNTIME_ACTIVITY_IDS.FENCE_STOLEN_GOODS,
]);
const SKILL_IDS = Object.freeze({
  persuasion: "per",
  deception: "dec",
  "sleight-of-hand": "slt",
});
const QUEUE_INPUT_KEYS = new Set([
  "id",
  "queueEntryId",
  "activityId",
  "activity",
  "hours",
  "skill",
  "skillId",
  "stakeCp",
  "stakeGp",
  "stake",
  "targetId",
  "target",
  "ammunitionType",
  "recipeId",
  "weaponId",
  "itemId",
  "bundleId",
  "targetIds",
]);
const TARGET_ALIAS_KEYS = Object.freeze([
  "targetId",
  "target",
  "ammunitionType",
  "recipeId",
  "weaponId",
  "itemId",
  "bundleId",
]);
const SHARPENING_TOOL_KEYS = Object.freeze(["whetstone", "smith"]);

let serviceRegistered = false;
let serviceMutationChain = Promise.resolve();
let sharpeningLifecycleRetryTimer = null;
let sharpeningLifecycleAuthorityHooksRegistered = false;
const serviceListeners = new Set();

function runServiceMutation(operation) {
  const result = serviceMutationChain.then(operation, operation);
  serviceMutationChain = result.catch(() => {});
  return result;
}

function notifyServiceChanged(reason = "state-update") {
  for (const listener of serviceListeners) {
    try {
      listener({ reason });
    } catch (error) {
      console.warn(`${MODULE_ID} | downtime service listener`, error);
    }
  }
}

export function subscribeDowntimeService(listener) {
  if (typeof listener !== "function") return () => {};
  serviceListeners.add(listener);
  return () => serviceListeners.delete(listener);
}

function assertAuthority() {
  if (!isAuthoritativeGM()) throw new Error("An active full GM is required.");
}

function now() {
  const serverTime = Number(globalThis.game?.time?.serverTime);
  return Number.isSafeInteger(serverTime) && serverTime >= 0
    ? serverTime
    : Date.now();
}

function newId(prefix) {
  const random = globalThis.foundry?.utils?.randomID?.(16);
  return `${prefix}-${String(
    random ??
      globalThis.crypto?.randomUUID?.() ??
      Math.random().toString(36).slice(2),
  )
    .replace(/[^A-Za-z0-9]/g, "")
    .slice(0, 24)}`;
}

function actorById(actorId) {
  return globalThis.game?.actors?.get?.(String(actorId ?? "")) ?? null;
}

function userById(userId) {
  return globalThis.game?.users?.get?.(String(userId ?? "")) ?? null;
}

function actorsArray() {
  const actors = globalThis.game?.actors;
  if (!actors) return [];
  if (Array.isArray(actors.contents)) return actors.contents;
  if (typeof actors.values === "function") return [...actors.values()];
  return Array.from(actors ?? []);
}

function usersArray() {
  const users = globalThis.game?.users;
  if (!users) return [];
  if (Array.isArray(users.contents)) return users.contents;
  if (typeof users.values === "function") return [...users.values()];
  const result = [];
  users.forEach?.((user) => result.push(user));
  return result;
}

export function userOwnsDowntimeActor(user, actor) {
  if (!user || !actor) return false;
  if (isFullGM(user)) return true;
  const owner = globalThis.CONST?.DOCUMENT_OWNERSHIP_LEVELS?.OWNER ?? 3;
  const ownership = actor.ownership ?? {};
  // An explicit Actor permission is authoritative. In particular, a stale
  // User.character assignment must not bypass an ownership level that was
  // deliberately lowered after the character was assigned.
  if (Object.hasOwn(ownership, user.id)) {
    return Number(ownership[user.id]) >= Number(owner);
  }
  if (userAssignedToDowntimeActor(user, actor)) return true;
  // Foundry grants Assistant GMs effective access to every Actor. That role
  // bypass must not make every downtime queue theirs; assistants may act only
  // through an explicitly assigned or explicitly owned character.
  if (user.isGM === true) return false;
  return Number(ownership.default) >= Number(owner);
}

function userAssignedToDowntimeActor(user, actor) {
  const assignedId =
    typeof user?.character === "string" ? user.character : user?.character?.id;
  return Boolean(
    assignedId && actor?.id && String(assignedId) === String(actor.id),
  );
}

function ownerUsers(actor) {
  return usersArray().filter(
    (user) => !isFullGM(user) && userOwnsDowntimeActor(user, actor),
  );
}

function ownerUserIds(actor) {
  return ownerUsers(actor).map((user) => String(user.id));
}

function projectWorkspaceActor(actor) {
  const owners = ownerUsers(actor).map((user) => ({
    id: String(user.id),
    name: String(user.name ?? user.id ?? "Player"),
    active: user.active === true,
    assigned: userAssignedToDowntimeActor(user, actor),
  }));
  const playerOwned = owners.length > 0;
  const folder = workspaceActorFolder(actor);
  return {
    id: actor.id,
    name: actor.name,
    img: actor.img,
    eligible: true,
    checked: playerOwned,
    playerOwned,
    control: playerOwned ? "player-owned" : "other-character",
    assigned: owners.some((owner) => owner.assigned),
    owners,
    folderId: folder.id,
    folderName: folder.name,
  };
}

function workspaceActorFolder(actor) {
  const source = actor?.folder;
  const id = String(
    (typeof source === "string" ? source : (source?.id ?? source?._id)) ??
      actor?._source?.folder ??
      "",
  ).trim();
  const resolved =
    source && typeof source === "object"
      ? source
      : id
        ? globalThis.game?.folders?.get?.(id)
        : null;
  return {
    id,
    name: String(resolved?.name ?? "").trim(),
  };
}

function participantFor(block, actorId) {
  return (block?.participants ?? []).find(
    (entry) => String(entry.actorId) === String(actorId),
  );
}

function settlementForBlock(block, config = loadDowntimeConfig()) {
  if (block?.settlementSnapshot) {
    return normalizeSettlementProfile(block.settlementSnapshot);
  }
  return (
    config.settlements.find(
      (settlement) => settlement.id === block?.settlementId,
    ) ?? null
  );
}

function queueDigest(queue) {
  return JSON.stringify(normalizeDowntimeQueue(queue));
}

/**
 * Convert UI-friendly aliases into the only queue shape accepted by the
 * authoritative planner. Conflicting aliases and unexpected fields are
 * rejected instead of being silently ignored.
 */
export function canonicalizeDowntimeQueueSubmission(rawQueue) {
  const errors = [];
  if (!Array.isArray(rawQueue)) {
    return {
      ok: false,
      errors: [{ code: "queue-not-array", index: -1 }],
      queue: [],
    };
  }
  if (rawQueue.length > DOWNTIME_SUBMISSION_MAX_ACTIONS) {
    errors.push({
      code: "too-many-actions",
      index: DOWNTIME_SUBMISSION_MAX_ACTIONS,
      maximum: DOWNTIME_SUBMISSION_MAX_ACTIONS,
    });
  }

  const canonical = rawQueue
    .slice(0, DOWNTIME_SUBMISSION_MAX_ACTIONS)
    .map((entry, index) => {
      const source =
        entry && typeof entry === "object" && !Array.isArray(entry)
          ? entry
          : {};
      if (source !== entry) errors.push({ code: "action-not-object", index });
      const unexpected = Object.keys(source).filter(
        (key) => !QUEUE_INPUT_KEYS.has(key),
      );
      if (unexpected.length > 0) {
        errors.push({
          code: "unsupported-action-field",
          index,
          fields: unexpected.sort(),
        });
      }

      const activityId = String(source.activityId ?? source.activity ?? "")
        .trim()
        .toLowerCase();
      const allowedTargetAliases = targetAliasesForActivity(activityId);
      const suppliedTargetAliases = TARGET_ALIAS_KEYS.filter((key) =>
        String(source[key] ?? "").trim(),
      );
      const unexpectedTargetAliases = suppliedTargetAliases.filter(
        (key) => !allowedTargetAliases.includes(key),
      );
      if (unexpectedTargetAliases.length > 0) {
        errors.push({
          code: "unexpected-target-alias",
          index,
          fields: unexpectedTargetAliases,
        });
      }
      if (
        source.targetIds != null &&
        activityId !== DOWNTIME_ACTIVITY_IDS.FENCE_STOLEN_GOODS
      ) {
        errors.push({
          code: "unexpected-target-ids",
          index,
        });
      }
      if (
        source.targetIds != null &&
        activityId === DOWNTIME_ACTIVITY_IDS.FENCE_STOLEN_GOODS &&
        suppliedTargetAliases.length > 0
      ) {
        errors.push({
          code: "conflicting-target-fields",
          index,
        });
      }
      const targetValues = [
        ...new Set(
          allowedTargetAliases
            .map((key) => String(source[key] ?? "").trim())
            .filter(Boolean),
        ),
      ];
      if (targetValues.length > 1) {
        errors.push({ code: "conflicting-target-aliases", index });
      }

      const skillValues = [
        ...new Set(
          [source.skill, source.skillId]
            .map(normalizeDowntimeSkill)
            .filter(Boolean),
        ),
      ];
      if (skillValues.length > 1) {
        errors.push({ code: "conflicting-skill-aliases", index });
      }

      const stake = canonicalStakeCp(source, index, errors);
      return {
        id: source.id ?? source.queueEntryId,
        activityId,
        hours: source.hours,
        skill: skillValues[0] ?? "",
        stakeCp: stake,
        targetId: targetValues[0] ?? "",
        ...(activityId === DOWNTIME_ACTIVITY_IDS.FENCE_STOLEN_GOODS
          ? { targetIds: source.targetIds }
          : {}),
      };
    });

  return {
    ok: errors.length === 0,
    errors,
    queue: normalizeDowntimeQueue(canonical),
  };
}

/**
 * Check actor-owned resources whose truth is not represented by player IDs.
 * The conservative trade loss reserve makes every accepted crafting queue
 * affordable even if an earlier hidden trade has its worst result.
 */
export function validateDowntimeServicePrerequisites(
  queue,
  { actor, context } = {},
) {
  const actions = normalizeDowntimeQueue(queue);
  const errors = [];
  const wallet = readWalletStrict(actor?.system?.currency);
  let projectedWalletCp = wallet.ok ? totalWalletCp(wallet.wallet) : null;
  if (!wallet.ok) errors.push({ code: "invalid-wallet", index: -1 });

  for (let index = 0; index < actions.length; index += 1) {
    const action = actions[index];
    if (action.activityId === DOWNTIME_ACTIVITY_IDS.CRAFT_AMMUNITION) {
      const costCp = ammoCraftCostCp(action.targetId);
      const allowed = new Set(
        context?.allowedTargetIds?.[DOWNTIME_ACTIVITY_IDS.CRAFT_AMMUNITION] ??
          [],
      );
      if (costCp === null || !allowed.has(action.targetId)) {
        errors.push({
          code: "craft-prerequisite-missing",
          index,
          actionId: action.id,
        });
      } else if (projectedWalletCp !== null && projectedWalletCp < costCp) {
        errors.push({
          code: "insufficient-crafting-funds",
          index,
          actionId: action.id,
          requiredCp: costCp,
        });
      } else if (projectedWalletCp !== null) {
        projectedWalletCp -= costCp;
      }
    }

    if (action.activityId === DOWNTIME_ACTIVITY_IDS.SHARPEN_WEAPON) {
      const weapon = findActorItem(actor, action.targetId);
      if (!actorHasAnyTool(actor, SHARPENING_TOOL_KEYS)) {
        errors.push({
          code: "sharpening-tool-required",
          index,
          actionId: action.id,
        });
      }
      if (!weapon || !isSharpenableWeapon(weapon) || hasSharpening(weapon)) {
        errors.push({
          code: "weapon-ineligible",
          index,
          actionId: action.id,
        });
      }
    }

    if (action.activityId === DOWNTIME_ACTIVITY_IDS.MARKET_TRADING) {
      const stakeCp = Number(action.stakeCp);
      if (
        projectedWalletCp !== null &&
        Number.isSafeInteger(stakeCp) &&
        stakeCp > projectedWalletCp
      ) {
        errors.push({
          code: "insufficient-trading-stake",
          index,
          actionId: action.id,
          requiredCp: stakeCp,
        });
      } else if (
        projectedWalletCp !== null &&
        Number.isSafeInteger(stakeCp) &&
        stakeCp > 0
      ) {
        projectedWalletCp -= Math.round(stakeCp * 0.25);
      }
    }
  }

  return { ok: errors.length === 0, errors, projectedWalletCp };
}

function targetAliasesForActivity(activityId) {
  const shared = ["targetId", "target"];
  switch (activityId) {
    case DOWNTIME_ACTIVITY_IDS.CRAFT_AMMUNITION:
      return [...shared, "ammunitionType", "recipeId"];
    case DOWNTIME_ACTIVITY_IDS.SHARPEN_WEAPON:
      return [...shared, "weaponId", "itemId"];
    case DOWNTIME_ACTIVITY_IDS.FENCE_STOLEN_GOODS:
      return [...shared, "bundleId"];
    case DOWNTIME_ACTIVITY_IDS.PICKPOCKET:
    case DOWNTIME_ACTIVITY_IDS.SHOPLIFT:
      return shared;
    default:
      return [];
  }
}

function canonicalStakeCp(source, index, errors) {
  const cpValues = [];
  for (const value of [source.stakeCp, source.stake]) {
    if (value === undefined || value === null || value === "") continue;
    const numeric = Number(value);
    if (!Number.isSafeInteger(numeric) || numeric < 0) {
      errors.push({ code: "invalid-stake", index });
      continue;
    }
    cpValues.push(numeric);
  }
  if (source.stakeGp !== undefined && source.stakeGp !== null) {
    const gp = Number(source.stakeGp);
    const cp = Math.round(gp * 100);
    if (
      !Number.isFinite(gp) ||
      gp < 0 ||
      !Number.isSafeInteger(cp) ||
      Math.abs(cp / 100 - gp) > 1e-9
    ) {
      errors.push({ code: "invalid-stake", index });
    } else {
      cpValues.push(cp);
    }
  }
  const unique = [...new Set(cpValues)];
  if (unique.length > 1) {
    errors.push({ code: "conflicting-stake-aliases", index });
  }
  return unique[0] ?? null;
}

function boundedRequests(requests, requestId, record) {
  const entries = Object.entries(
    requests && typeof requests === "object" ? requests : {},
  );
  entries.push([requestId, record]);
  return Object.fromEntries(entries.slice(-MAX_REQUEST_RECEIPTS));
}

export function registerDowntimeService() {
  if (serviceRegistered) return true;
  registerDowntimeWorkflowObserver();
  subscribeDowntime(DOWNTIME_EVENTS.SNAPSHOT_REQUEST, handleSnapshotRequest);
  subscribeDowntime(DOWNTIME_EVENTS.SUBMIT_QUEUE, handleQueueRequest);
  subscribeDowntime(DOWNTIME_EVENTS.RECALL_SUBMISSION, handleRecallRequest);
  subscribeDowntime(DOWNTIME_EVENTS.SHARPEN_DAMAGE, handleSharpenDamage);
  subscribeDowntime(DOWNTIME_EVENTS.LONG_REST, handleLongRest);
  registerSharpeningLifecycleAuthorityHooks();
  serviceRegistered = true;
  if (isAuthoritativeGM()) {
    void ensureDowntimeWorkflowAuthority()
      .then(() => scheduleSharpeningLifecycleReconciliation(0))
      .catch((error) =>
        console.warn(`${MODULE_ID} | downtime workflow authority`, error),
      );
  }
  return true;
}

export async function saveSettlementProfile(payload = {}) {
  return runServiceMutation(async () => {
    assertAuthority();
    const id =
      String(payload.id ?? "").trim() ||
      createSettlementIdFromName(payload.name);
    const merchants = new Set(loadMerchants().map((merchant) => merchant.id));
    const factions = new Set(loadFactions().map((faction) => faction.id));
    const settlement = normalizeSettlementProfile({
      id,
      name: payload.name,
      wealthTier: payload.wealthTier,
      securityTier: payload.securityTier,
      marketDc: payload.marketDc,
      linkedFactionId: factions.has(payload.factionId) ? payload.factionId : "",
      linkedMerchantIds: (payload.merchantIds ?? []).filter((merchantId) =>
        merchants.has(merchantId),
      ),
      enabledActivityIds: payload.enabledActivities,
    });
    await updateDowntimeConfig((current) => {
      const settlements = [...current.settlements];
      const index = settlements.findIndex(
        (entry) => entry.id === settlement.id,
      );
      if (index >= 0) settlements[index] = settlement;
      else settlements.push(settlement);
      return { ...current, settlements };
    });
    notifyServiceChanged("settlement-save");
    return settlement;
  });
}

export async function deleteSettlementProfile(settlementId) {
  return runServiceMutation(async () => {
    assertAuthority();
    const active = getActiveDowntimeBlock();
    if (active?.settlementId === settlementId) {
      throw new Error("The active downtime block is using that settlement.");
    }
    const config = loadDowntimeConfig();
    if (
      !config.settlements.some((entry) => entry.id === String(settlementId))
    ) {
      return false;
    }
    await updateDowntimeConfig((current) => ({
      ...current,
      settlements: current.settlements.filter(
        (settlement) => settlement.id !== String(settlementId),
      ),
    }));
    notifyServiceChanged("settlement-delete");
    return true;
  });
}

export async function saveGuidedDowntimeProject(payload = {}) {
  return runServiceMutation(async () => {
    assertAuthority();
    const project = normalizeGuidedDowntimeProject(payload, {
      fallbackId: payload.id || newId("project"),
    });
    if (!project || project.skills.length === 0) {
      throw new Error(
        "Enter a project name, total work hours, and at least one applicable skill.",
      );
    }
    await updateDowntimeConfig((current) => {
      const projects = [...current.guidedProjects];
      const index = projects.findIndex((entry) => entry.id === project.id);
      if (index >= 0) projects[index] = project;
      else projects.push(project);
      return { ...current, guidedProjects: projects };
    });
    notifyServiceChanged("guided-project-save");
    return project;
  });
}

export async function openDowntimeBlock({
  settlementId,
  locationName,
  hours,
  actorIds,
  mode = "",
  templateIds = [],
  projectIds = [],
} = {}) {
  return runServiceMutation(async () => {
    assertAuthority();
    await ensureDowntimeWorkflowAuthority();
    const config = loadDowntimeConfig();
    if (mode === GUIDED_DOWNTIME_MODE) {
      return openGuidedDowntimeBlock({
        config,
        locationName,
        hours,
        actorIds,
        templateIds,
        projectIds,
      });
    }
    const requestedSettlementId = String(settlementId ?? "").trim();
    const savedSettlement = config.settlements.find(
      (entry) => entry.id === requestedSettlementId,
    );
    if (requestedSettlementId && !savedSettlement) {
      throw new Error("Choose a valid saved settlement or no settlement.");
    }
    const settlement =
      savedSettlement ?? createNonSettlementDowntimeContext(locationName);
    const budgetHours = Math.floor(Number(hours));
    if (
      !Number.isSafeInteger(budgetHours) ||
      budgetHours < 1 ||
      budgetHours > MAX_BLOCK_HOURS
    ) {
      throw new Error(
        `Downtime must be between 1 and ${MAX_BLOCK_HOURS} hours.`,
      );
    }
    const eligible = [...new Set(Array.isArray(actorIds) ? actorIds : [])]
      .map(actorById)
      .filter((actor) => actor?.type === "character");
    if (eligible.length === 0)
      throw new Error("Choose at least one character.");
    const createdAt = now();
    const block = await createDowntimeBlock({
      id: newId("downtime"),
      opportunitySecret: createDowntimeOpportunitySecretBundle(),
      settlementId: settlement.id,
      settlementName: settlement.name,
      locationName: settlement.name,
      hasSettlement: settlement.hasSettlement,
      settlementSnapshot: settlement,
      budgetHours,
      hours: budgetHours,
      participants: eligible.map((actor) => ({
        actorId: String(actor.id),
        actorName: String(actor.name ?? "Character"),
        actorImg: String(actor.img ?? "icons/svg/mystery-man.svg"),
        userIds: ownerUserIds(actor),
        budgetHours,
        queue: [],
        submitted: false,
        submittedAt: 0,
        submittedBy: null,
      })),
      requests: {},
      createdAt,
    });
    notifyServiceChanged("block-create");
    await broadcastPlayerState(block);
    return block;
  });
}

async function openGuidedDowntimeBlock({
  config,
  locationName,
  hours,
  actorIds,
  templateIds,
  projectIds,
}) {
  const budgetHours = Math.floor(Number(hours));
  if (
    !Number.isSafeInteger(budgetHours) ||
    budgetHours < 1 ||
    budgetHours > MAX_BLOCK_HOURS
  ) {
    throw new Error(`Downtime must be between 1 and ${MAX_BLOCK_HOURS} hours.`);
  }
  const selectedIds = [
    ...new Set(Array.isArray(templateIds) ? templateIds.map(String) : []),
  ];
  const templates = selectedIds
    .map((templateId) => guidedTemplateById(config.guidedTemplates, templateId))
    .filter(Boolean);
  const completedProjectHours = guidedProjectProgressFromStore(
    loadDowntimeWorkflowStore(),
  );
  const projects = [...new Set(Array.isArray(projectIds) ? projectIds : [])]
    .map((projectId) => guidedProjectById(config.guidedProjects, projectId))
    .filter(
      (project) =>
        project &&
        projectProgressHours(completedProjectHours, project.id) <
          project.requiredHours,
    );
  if (templates.length === 0 && projects.length === 0)
    throw new Error("Choose at least one activity template.");
  const eligible = [...new Set(Array.isArray(actorIds) ? actorIds : [])]
    .map(actorById)
    .filter((actor) => actor?.type === "character");
  if (eligible.length === 0) throw new Error("Choose at least one character.");
  const createdAt = now();
  const block = await createDowntimeBlock({
    id: newId("downtime"),
    mode: GUIDED_DOWNTIME_MODE,
    locationName: cleanGuidedLocation(locationName),
    settlementName: cleanGuidedLocation(locationName),
    settlementId: "guided-downtime",
    hasSettlement: false,
    budgetHours,
    hours: budgetHours,
    guidedTemplates: templates,
    guidedProjects: projects,
    participants: eligible.map((actor) => ({
      actorId: String(actor.id),
      actorName: String(actor.name ?? "Character"),
      actorImg: String(actor.img ?? "icons/svg/mystery-man.svg"),
      userIds: ownerUserIds(actor),
      budgetHours,
      queue: [],
      submitted: false,
      submittedAt: 0,
      submittedBy: null,
    })),
    requests: {},
    createdAt,
  });
  notifyServiceChanged("guided-block-create");
  await broadcastPlayerState(block);
  return block;
}

export async function openBlockForPlayers(blockId) {
  assertAuthority();
  const block = getActiveDowntimeBlock();
  if (!block || block.id !== String(blockId) || block.state !== "collecting") {
    throw new Error("That downtime block is not collecting submissions.");
  }
  const sent = new Set();
  for (const participant of block.participants ?? []) {
    for (const userId of participant.userIds ?? []) {
      if (
        sent.has(userId) ||
        userById(userId)?.active === false ||
        !userOwnsDowntimeActor(userById(userId), actorById(participant.actorId))
      ) {
        continue;
      }
      sent.add(userId);
      emitDowntimeEvent(DOWNTIME_EVENTS.AUTO_OPEN, {
        targetUserId: userId,
        actorId: participant.actorId,
        blockId: block.id,
      });
    }
  }
  return { sent: sent.size };
}

export async function lockActiveDowntimeBlock(blockId) {
  return runServiceMutation(async () => {
    assertAuthority();
    const block = getActiveDowntimeBlock();
    if (!block || block.id !== String(blockId))
      throw new Error("Block not found.");
    const locked = await lockDowntimeBlock(block.id);
    notifyServiceChanged("block-lock");
    await broadcastPlayerState(locked);
    return locked;
  });
}

function shopliftStockKey(fact) {
  const merchantId = String(fact?.merchantId ?? "").trim();
  const itemUuid = normalizeInfinityItemUuid(fact?.itemUuid);
  return merchantId && itemUuid ? `${merchantId}\u0000${itemUuid}` : "";
}

/**
 * Reserve every queued merchant row before any hidden checks are rolled.
 * Reservations are deliberately conservative: an attempt consumes capacity
 * even when its later hidden check may fail. This prevents a failed planning
 * pass from becoming a way to reroll checks and guarantees the immutable plan
 * can never promise more finite units than existed at preview time.
 */
function reserveShopliftPlanStock(preparedCharacters) {
  const liveStock = new Map();
  for (const merchant of loadMerchants()) {
    for (const row of merchant.items ?? []) {
      if (row.unlimited === true || !row.uuid) continue;
      liveStock.set(`${merchant.id}\u0000${row.uuid}`, {
        merchantId: merchant.id,
        itemUuid: row.uuid,
        quantity: Math.max(0, Math.floor(Number(row.qty) || 0)),
        reserved: 0,
      });
    }
  }

  for (const prepared of preparedCharacters) {
    for (const action of prepared.validation.normalizedQueue) {
      if (action.activityId !== DOWNTIME_ACTIVITY_IDS.SHOPLIFT) continue;
      const fact = prepared.context.targetFacts[action.targetId];
      const key = shopliftStockKey(fact);
      const stock = liveStock.get(key);
      if (!stock || stock.reserved >= stock.quantity) {
        throw new Error(
          `${prepared.participant.actorName}'s shoplifting target has no unreserved finite stock.`,
        );
      }
      stock.reserved += 1;
    }
  }

  return new Map(
    [...liveStock.entries()]
      .filter(([, stock]) => stock.reserved > 0)
      .map(([key, stock]) => [key, { ...stock }]),
  );
}

function buildDowntimePlanningManifest(block, settlement, preparedCharacters) {
  const checkedRows = [];
  const participants = preparedCharacters.map(({ actor, validation }) => {
    validation.normalizedQueue.forEach((action, index) => {
      if (!CHECKED_ACTIVITIES.has(action.activityId)) return;
      checkedRows.push({
        rowId: buildDowntimeOperationId({
          blockId: block.id,
          actorId: actor.id,
          actionId: action.id,
          index,
        }),
        actorId: String(actor.id),
        actionId: action.id,
        activityId: action.activityId,
        order: index,
      });
    });
    return {
      actorId: String(actor.id),
      queue: validation.normalizedQueue,
    };
  });
  return {
    version: 1,
    blockId: block.id,
    settlementId: settlement.id,
    budgetHours: block.budgetHours,
    participants,
    checkedRows,
  };
}

function interruptedPlanningMessage(participant, action) {
  return `${participant.actorName}'s hidden ${action.skill} check was interrupted after its roll slot was reserved. This locked block will not reroll it; cancel the block and create a new one.`;
}

async function markPlanningReviewBestEffort(blockId, reason) {
  try {
    const active = getActiveDowntimeBlock();
    if (
      active?.id === blockId &&
      active.state === "locked" &&
      active.planningDraft?.state !== "needs-review"
    ) {
      await markDowntimePlanningDraftNeedsReview(blockId, reason, {
        at: now(),
      });
    }
  } catch {
    // A lost authority fence leaves the durable in-flight row for the new GM
    // to classify during handoff reconciliation.
  }
}

export async function planActiveDowntimeBlock(blockId) {
  return runServiceMutation(async () => {
    assertAuthority();
    const block = getActiveDowntimeBlock();
    if (!block || block.id !== String(blockId)) {
      throw new Error("Lock submissions before generating the preview.");
    }
    if (block.state === "planned" && block.plan) return block;
    if (block.state !== "locked") {
      throw new Error("Lock submissions before generating the preview.");
    }
    if (block.mode === GUIDED_DOWNTIME_MODE) {
      return planGuidedDowntimeBlock(block);
    }
    if (block.plan) return block;
    const config = loadDowntimeConfig();
    const settlement = settlementForBlock(block, config);
    if (!settlement)
      throw new Error("The block's settlement snapshot is missing.");
    const createdAt = now();
    const characterPlans = [];
    const operations = [];
    const projectedFactionStandings = new Map(
      loadFactions().map((faction) => [faction.id, faction.standing]),
    );
    const preparedCharacters = [];
    for (const participant of block.participants ?? []) {
      const actor = actorById(participant.actorId);
      if (!actor)
        throw new Error(`${participant.actorName}'s Actor is missing.`);
      const context = await buildActorDowntimeContext({
        block,
        actor,
        settlement,
        config,
        queue: participant.queue ?? [],
      });
      const validation = validateDowntimeQueue(participant.queue ?? [], {
        budgetHours: block.budgetHours,
        settlement,
        startingHeat: context.heat,
        targetFacts: context.targetFacts,
        allowedTargetIds: context.allowedTargetIds,
        existingSharpenedWeaponIds: context.existingSharpenedWeaponIds,
      });
      if (!validation.ok) {
        throw new Error(
          `${participant.actorName}'s queue is no longer valid: ${validation.errors[0]?.code ?? "invalid queue"}.`,
        );
      }
      const prerequisites = validateDowntimeServicePrerequisites(
        validation.normalizedQueue,
        { actor, context },
      );
      if (!prerequisites.ok) {
        throw new Error(
          `${participant.actorName}'s queue prerequisites changed: ${prerequisites.errors[0]?.code ?? "prerequisite missing"}.`,
        );
      }
      preparedCharacters.push({ actor, participant, context, validation });
    }

    // Complete every deterministic validation and finite-stock reservation
    // before the first hidden roll. A rejected preview can therefore never be
    // retried to fish for different outcomes.
    const projectedMerchantStock = reserveShopliftPlanStock(preparedCharacters);
    const planningManifest = buildDowntimePlanningManifest(
      block,
      settlement,
      preparedCharacters,
    );
    if (planningManifest.checkedRows.length > 0) {
      const draft = await initializeDowntimePlanningDraft(
        block.id,
        planningManifest,
        { at: createdAt },
      );
      if (draft.state === "needs-review") {
        throw new Error(
          draft.reviewReason ||
            "A hidden roll was interrupted. Cancel this locked block; its checks will not be rerolled.",
        );
      }
    }

    for (const prepared of preparedCharacters) {
      const { actor, participant, context, validation } = prepared;
      const rolls = {};
      for (
        let actionIndex = 0;
        actionIndex < validation.normalizedQueue.length;
        actionIndex += 1
      ) {
        const action = validation.normalizedQueue[actionIndex];
        if (!CHECKED_ACTIVITIES.has(action.activityId)) continue;
        const rowId = buildDowntimeOperationId({
          blockId: block.id,
          actorId: actor.id,
          actionId: action.id,
          index: actionIndex,
        });
        let draftRow =
          getActiveDowntimeBlock()?.planningDraft?.rows?.[rowId] ?? null;
        if (draftRow?.state === "completed") {
          rolls[action.id] = draftRow.roll;
          continue;
        }
        const interruptionMessage = interruptedPlanningMessage(
          participant,
          action,
        );
        if (draftRow?.state === "in-flight") {
          await markPlanningReviewBestEffort(block.id, interruptionMessage);
          throw new Error(interruptionMessage);
        }
        assertAuthority();
        const claim = await claimDowntimePlanningRoll(block.id, rowId, {
          at: now(),
        });
        if (claim.claimedNow !== true) {
          if (claim.row?.state === "completed") {
            rolls[action.id] = claim.row.roll;
            continue;
          }
          await markPlanningReviewBestEffort(block.id, interruptionMessage);
          throw new Error(interruptionMessage);
        }
        const skillId = SKILL_IDS[action.skill];
        let rolled;
        try {
          rolled = await rollSkillTotal(actor, skillId, {
            chatMessage: false,
            fastForward: true,
          });
          if (!rolled.ok) throw new Error("hidden-roll-did-not-complete");
        } catch {
          await markPlanningReviewBestEffort(block.id, interruptionMessage);
          throw new Error(interruptionMessage);
        }
        const dieResult = Number(
          rolled.roll?.dice?.[0]?.total ?? rolled.roll?.terms?.[0]?.total,
        );
        const completedRoll = {
          total: rolled.total,
          dieResult: Number.isFinite(dieResult) ? dieResult : null,
          skillModifier: Number.isFinite(dieResult)
            ? rolled.total - dieResult
            : null,
          formula: String(rolled.roll?.formula ?? ""),
        };
        try {
          draftRow = await resolveDowntimePlanningRoll(
            block.id,
            rowId,
            completedRoll,
            { at: now() },
          );
        } catch (error) {
          const canonical =
            getActiveDowntimeBlock()?.planningDraft?.rows?.[rowId] ?? null;
          if (canonical?.state === "completed") {
            draftRow = canonical;
          } else {
            await markPlanningReviewBestEffort(block.id, interruptionMessage);
            throw new Error(interruptionMessage, { cause: error });
          }
        }
        rolls[action.id] = draftRow.roll;
      }
      const domainPlan = resolveDowntimeQueue({
        blockId: block.id,
        actorId: actor.id,
        queue: validation.normalizedQueue,
        budgetHours: block.budgetHours,
        settlement,
        startingHeat: context.heat,
        rolls,
        targetFacts: context.targetFacts,
        allowedTargetIds: context.allowedTargetIds,
        existingSharpenedWeaponIds: context.existingSharpenedWeaponIds,
      });
      if (!domainPlan.ok) {
        throw new Error(
          `${participant.actorName}'s plan could not be generated: ${domainPlan.errors[0]?.code ?? "planning failed"}.`,
        );
      }
      const enriched = await enrichCharacterOperations({
        block,
        actor,
        participant,
        settlement,
        context,
        domainPlan,
        createdAt,
        projectedFactionStandings,
        projectedMerchantStock,
      });
      operations.push(...enriched.operations);
      characterPlans.push({
        actorId: actor.id,
        actorName: actor.name,
        usedHours: domainPlan.usedHours,
        remainingHours: domainPlan.remainingHours,
        startingHeat: domainPlan.startingHeat,
        finalHeat: domainPlan.finalHeat,
        operations: enriched.operations,
      });
    }
    const plan = {
      id: newId("plan"),
      blockId: block.id,
      createdAt,
      settlement,
      characters: characterPlans,
      operations,
    };
    const planned = await persistDowntimePlan(block.id, plan, {
      at: createdAt,
    });
    notifyServiceChanged("block-plan");
    await broadcastPlayerState(planned);
    return planned;
  });
}

async function planGuidedDowntimeBlock(block) {
  const createdAt = now();
  const operations = [];
  const characters = [];
  const projectProgress = guidedProjectProgressFromStore(
    loadDowntimeWorkflowStore(),
  );
  for (const participant of block.participants ?? []) {
    const actor = actorById(participant.actorId);
    const selection = normalizeGuidedActivitySelection(
      participant.guidedSelection,
      block.guidedTemplates,
      block.guidedProjects,
    );
    if (!actor || !selection) {
      throw new Error(
        `${participant.actorName}'s activity choice is missing or invalid.`,
      );
    }
    const activity = guidedActivityById(
      block.guidedTemplates,
      block.guidedProjects,
      selection.templateId,
    );
    const roll = selection.skill
      ? normalizeGuidedPlayerRoll(participant.guidedRoll)
      : { ok: true, total: 0, formula: "" };
    if (!roll.ok) {
      throw new Error(`${participant.actorName}'s player check is missing.`);
    }
    const selectedOutcomeIndex = guidedOutcomeIndex(
      roll.total,
      activity.outcomes.length,
    );
    const operation = buildGuidedDowntimeOperation({
      block,
      actor,
      activity,
      skill: selection.skill,
      roll,
      selectedOutcomeIndex,
      createdAt,
      projectProgress,
    });
    if (operation.project) {
      projectProgress.set(
        operation.project.id,
        operation.project.progressAfterHours,
      );
    }
    operations.push(operation);
    characters.push({
      actorId: actor.id,
      actorName: actor.name,
      usedHours: block.budgetHours,
      remainingHours: 0,
      operations: [operation],
    });
  }
  const planned = await persistDowntimePlan(
    block.id,
    {
      id: newId("guided-plan"),
      blockId: block.id,
      mode: GUIDED_DOWNTIME_MODE,
      createdAt,
      characters,
      operations,
    },
    { at: createdAt },
  );
  notifyServiceChanged("guided-block-plan");
  await broadcastPlayerState(planned);
  return planned;
}

export async function chooseGuidedDowntimeOutcome({
  blockId,
  operationId,
  outcomeIndex,
  report = "",
} = {}) {
  return runServiceMutation(async () => {
    assertAuthority();
    const block = getActiveDowntimeBlock();
    if (
      !block ||
      block.id !== String(blockId) ||
      block.mode !== GUIDED_DOWNTIME_MODE ||
      block.state !== "planned"
    ) {
      throw new Error(
        "Choose a result before applying this guided downtime block.",
      );
    }
    const index = Math.floor(Number(outcomeIndex));
    const operations = (block.plan?.operations ?? []).map((operation) => {
      if (operation.operationId !== String(operationId)) return operation;
      const activity = guidedActivityById(
        block.guidedTemplates,
        block.guidedProjects,
        operation.activityId,
      );
      if (!activity || index < 0 || index >= activity.outcomes.length) {
        throw new Error("Choose one of this activity's available results.");
      }
      const actor = actorById(operation.actorId);
      if (!actor) throw new Error("That character is no longer available.");
      return buildGuidedDowntimeOperation({
        block,
        actor,
        activity,
        skill: operation.check?.skill ?? "",
        roll: {
          ok: true,
          total: operation.check?.total ?? 0,
          formula: operation.check?.formula ?? "",
        },
        selectedOutcomeIndex: index,
        createdAt: operation.createdAt ?? now(),
        operationId: operation.operationId,
        reportOverride: cleanGuidedReport(report) || operation.report,
        projectProgress: operation.project
          ? new Map([
              [operation.project.id, operation.project.progressBeforeHours],
            ])
          : null,
      });
    });
    if (
      !operations.some(
        (operation) => operation.operationId === String(operationId),
      )
    ) {
      throw new Error("That downtime result no longer exists.");
    }
    const byActor = new Map(
      operations.map((operation) => [operation.actorId, operation]),
    );
    const plan = {
      ...block.plan,
      operations,
      characters: (block.plan.characters ?? []).map((character) => ({
        ...character,
        operations: [byActor.get(character.actorId)].filter(Boolean),
      })),
    };
    const updated = await updateGuidedDowntimePlan(block.id, plan);
    notifyServiceChanged("guided-outcome-select");
    await broadcastPlayerState(updated);
    return updated;
  });
}

async function enrichCharacterOperations({
  block,
  actor,
  settlement,
  context,
  domainPlan,
  createdAt,
  projectedFactionStandings,
  projectedMerchantStock,
}) {
  const walletRead = readWalletStrict(actor.system?.currency);
  if (!walletRead.ok) throw new Error(`${actor.name}'s wallet is invalid.`);
  let projectedWallet = walletRead.wallet;
  const projectedAmmo = new Map();
  const operations = [];
  for (const operation of domainPlan.operations) {
    const fact = context.targetFacts[operation.targetId] ?? null;
    let exact = {
      ...operation,
      settlementId: settlement.id,
      createdAt,
    };
    if (operation.kind === "noop" || operation.status === "blocked") {
      exact.kind = "noop";
      exact.summary = operationSummary(exact);
      operations.push(exact);
      continue;
    }
    switch (operation.activityId) {
      case DOWNTIME_ACTIVITY_IDS.CRAFT_AMMUNITION: {
        const existingProjection = projectedAmmo.get(operation.targetId);
        const actualStack = cleanAmmoStack(actor, operation.targetId);
        const built = await buildAmmoCraftOperation({
          actor,
          recipeId: operation.targetId,
          operationId: operation.operationId,
          projectedWallet,
          projectedQuantity: existingProjection?.quantity ?? null,
          projectedStackId:
            existingProjection?.itemId ??
            (String(actualStack?.id ?? "") || null),
        });
        if (!built.ok) {
          throw new Error(
            `${actor.name} cannot craft that ammunition: ${built.reason}.`,
          );
        }
        exact = { ...operation, ...built.operation };
        projectedWallet = built.operation.walletAfter;
        projectedAmmo.set(operation.targetId, {
          itemId: built.operation.delivery.itemId,
          quantity: built.operation.delivery.quantityAfter,
        });
        exact.activityLabel = "Craft Ammunition";
        exact.itemName = built.operation.delivery.snapshot.name;
        break;
      }
      case DOWNTIME_ACTIVITY_IDS.SHARPEN_WEAPON: {
        const weapon = findActorItem(actor, operation.targetId);
        const damageType = sharpenDamageType(weapon);
        if (
          !actorHasAnyTool(actor, SHARPENING_TOOL_KEYS) ||
          !weapon ||
          !isSharpenableWeapon(weapon) ||
          !damageType ||
          hasSharpening(weapon)
        ) {
          throw new Error(
            `${actor.name}'s selected weapon is no longer eligible.`,
          );
        }
        exact = {
          ...operation,
          kind: "sharpen-weapon",
          weaponId: weapon.id,
          weaponName: String(weapon.name ?? "Weapon"),
          damageType,
          toolKeys: [...SHARPENING_TOOL_KEYS],
          activityLabel: "Sharpen Weapon",
        };
        break;
      }
      case DOWNTIME_ACTIVITY_IDS.MARKET_TRADING: {
        if (
          totalWalletCp(projectedWallet) < Number(operation.resolution?.stakeCp)
        ) {
          throw new Error(
            `${actor.name} does not have the selected trading stake.`,
          );
        }
        const walletAfter = planWalletDeltaCp(
          projectedWallet,
          operation.resolution?.deltaCp,
        );
        if (!walletAfter)
          throw new Error(
            `${actor.name}'s trade cannot be represented in coin.`,
          );
        exact = {
          ...operation,
          kind: "currency",
          walletBefore: projectedWallet,
          walletAfter,
          currencyDeltaCp: operation.resolution.deltaCp,
          activityLabel: "Market Trading",
        };
        projectedWallet = walletAfter;
        break;
      }
      case DOWNTIME_ACTIVITY_IDS.PICKPOCKET: {
        const stolenItemSnapshot = operation.resolution?.rewardEligible
          ? await buildPickpocketReward({
              operation,
              fact,
              settlement,
              createdAt,
            })
          : null;
        exact = {
          ...operation,
          kind: "pickpocket",
          activityLabel: "Pickpocket",
          markLabel: String(fact?.label ?? "City mark"),
          stolenItemSnapshot,
          stolenIssuance: stolenItemSnapshot
            ? buildStolenGoodsIssuance({
                actorId: actor.id,
                snapshot: stolenItemSnapshot,
              })
            : null,
        };
        if (stolenItemSnapshot && !exact.stolenIssuance) {
          throw new Error(`${actor.name}'s theft issuance plan is invalid.`);
        }
        break;
      }
      case DOWNTIME_ACTIVITY_IDS.SHOPLIFT: {
        if (!fact?.merchantId || !fact?.itemSnapshot) {
          throw new Error(
            `${actor.name}'s shoplifting target is no longer available.`,
          );
        }
        const stock = projectedMerchantStock.get(shopliftStockKey(fact));
        const transfersStock = operation.resolution?.transferStock === true;
        if (!stock || (transfersStock && stock.quantity < 1)) {
          throw new Error(
            `${actor.name}'s shoplifting target has no projected finite stock.`,
          );
        }
        const quantityBefore = stock.quantity;
        const quantityAfter = transfersStock
          ? quantityBefore - 1
          : quantityBefore;
        const stolenItemSnapshot = transfersStock
          ? markStolenSnapshot(fact.itemSnapshot, {
              settlementId: settlement.id,
              targetType: "merchant-stock",
              sourceId: operation.targetId,
              merchantId: fact.merchantId,
              operationId: operation.operationId,
              timestamp: createdAt,
              appraisedValueCp: fact.valueCp,
            })
          : null;
        exact = {
          ...operation,
          kind: "shoplift",
          activityLabel: "Shoplift",
          merchantId: fact.merchantId,
          merchantName: fact.merchantName,
          itemUuid: fact.itemUuid,
          itemName: fact.itemName,
          quantityBefore,
          quantityAfter,
          stolenItemSnapshot,
          stolenIssuance: stolenItemSnapshot
            ? buildStolenGoodsIssuance({
                actorId: actor.id,
                snapshot: stolenItemSnapshot,
              })
            : null,
        };
        if (stolenItemSnapshot && !exact.stolenIssuance) {
          throw new Error(
            `${actor.name}'s shoplifting issuance plan is invalid.`,
          );
        }
        stock.quantity = quantityAfter;
        break;
      }
      case DOWNTIME_ACTIVITY_IDS.FENCE_STOLEN_GOODS: {
        if (!fact?.itemSnapshots?.length) {
          throw new Error(
            `${actor.name}'s stolen bundle is no longer available.`,
          );
        }
        const capacity = getFencingValueCapCp(
          settlement.wealthTier,
          operation.hours,
        );
        if (fact.valueCp > capacity) {
          throw new Error(
            `${actor.name}'s stolen bundle exceeds the fencing capacity.`,
          );
        }
        const walletAfter = planWalletDeltaCp(
          projectedWallet,
          operation.resolution?.payoutCp ?? 0,
        );
        if (!walletAfter)
          throw new Error(`${actor.name}'s fencing payout is invalid.`);
        exact = {
          ...operation,
          kind: "fence-stolen-goods",
          activityLabel: "Fence Stolen Goods",
          itemSnapshots: fact.itemSnapshots,
          stolenIssuanceRecords: fact.issuanceRecords,
          stolenConsumptionRecords: (fact.issuanceRecords ?? []).map(
            (issuance) =>
              buildStolenGoodsConsumption(issuance, {
                fenceOperationId: operation.operationId,
                consumedAt: createdAt,
              }),
          ),
          bundleValueCp: fact.valueCp,
          payoutCp: operation.resolution?.payoutCp ?? 0,
          goodsTransferred: operation.resolution?.goodsTransferred === true,
          walletBefore: projectedWallet,
          walletAfter,
        };
        if (
          exact.stolenConsumptionRecords.length !==
            exact.stolenIssuanceRecords.length ||
          exact.stolenConsumptionRecords.some((record) => !record)
        ) {
          throw new Error(`${actor.name}'s fencing ledger plan is invalid.`);
        }
        if (exact.goodsTransferred) projectedWallet = walletAfter;
        break;
      }
      case DOWNTIME_ACTIVITY_IDS.LAY_LOW:
        exact = { ...operation, kind: "heat", activityLabel: "Lay Low" };
        break;
      default:
        exact = { ...operation, kind: "noop" };
        break;
    }
    exact.settlementId = settlement.id;
    exact.createdAt = createdAt;
    if (Number(exact.factionDelta) < 0 && exact.linkedFactionId) {
      const standingBefore = projectedFactionStandings.get(
        exact.linkedFactionId,
      );
      if (!Number.isFinite(Number(standingBefore))) {
        throw new Error(
          `${actor.name}'s linked faction is no longer available for the planned consequence.`,
        );
      }
      const standingAfter = clampStanding(Number(standingBefore) - 1);
      exact.factionWrite = {
        factionId: exact.linkedFactionId,
        delta: standingAfter - Number(standingBefore),
        standingBefore: Number(standingBefore),
        standingAfter,
        historyId: `dt-${merchantItemId(`${exact.operationId}:faction`)}`,
        at: createdAt,
        reason: `Downtime serious failure [${exact.operationId}]`,
      };
      projectedFactionStandings.set(exact.linkedFactionId, standingAfter);
    }
    exact.summary = operationSummary(exact);
    operations.push(exact);
  }
  return { operations, projectedWallet };
}

async function buildPickpocketReward({
  operation,
  fact,
  settlement,
  createdAt,
}) {
  const outcome = operation.check?.outcomeTier;
  const scale = {
    [DOWNTIME_OUTCOME_TIERS.EXCEPTIONAL_SUCCESS]: 1,
    [DOWNTIME_OUTCOME_TIERS.SUCCESS]: 0.65,
    [DOWNTIME_OUTCOME_TIERS.SETBACK]: 0.35,
  }[outcome];
  const cap = Math.max(1, Number(operation.resolution?.valueCapCp) || 1);
  const rewardSeed = `${String(fact?.rewardSeed ?? "")}|${operation.operationId}`;
  const random = deterministicDowntimeRoll(rewardSeed, "value");
  const valueCp = Math.max(1, Math.floor(cap * scale * (0.55 + random * 0.45)));
  const candidates = PICKPOCKET_CURATED_ITEMS.filter(
    (item) => item.valueCp <= valueCp,
  );
  if (
    candidates.length &&
    deterministicDowntimeRoll(rewardSeed, "kind") >= 0.5
  ) {
    const index = Math.floor(
      deterministicDowntimeRoll(rewardSeed, "item") * candidates.length,
    );
    const candidate = candidates[Math.min(index, candidates.length - 1)];
    const snapshot = await resolveItemSnapshot(candidate.uuid);
    if (snapshot) {
      return markStolenSnapshot(snapshot, {
        settlementId: settlement.id,
        targetType: "generated-mark",
        sourceId: operation.targetId,
        operationId: operation.operationId,
        timestamp: createdAt,
        appraisedValueCp: candidate.valueCp,
      });
    }
  }
  return buildStolenCoinPurse({
    settlementId: settlement.id,
    sourceId: operation.targetId,
    operationId: operation.operationId,
    timestamp: createdAt,
    valueCp,
  });
}

function buildGuidedDowntimeOperation({
  block,
  actor,
  activity,
  skill,
  roll,
  selectedOutcomeIndex,
  createdAt,
  operationId = "",
  reportOverride = "",
  projectProgress = null,
}) {
  const outcome = activity.outcomes[selectedOutcomeIndex];
  const report = cleanGuidedReport(reportOverride) || outcome.report;
  const total = Number(roll?.total) || 0;
  if (activity.kind === "project") {
    const progressBeforeHours = projectProgressHours(
      projectProgress,
      activity.id,
    );
    const contributedHours = block.budgetHours;
    const progressAfterHours = progressBeforeHours + contributedHours;
    const completed = progressAfterHours >= activity.requiredHours;
    const project = {
      id: activity.id,
      name: activity.name,
      requiredHours: activity.requiredHours,
      progressBeforeHours,
      contributedHours,
      progressAfterHours,
      completed,
    };
    const projectProgressLabel = formatGuidedProjectProgress(project);
    return {
      operationId: operationId || `guided-${block.id}-${actor.id}`,
      kind: "noop",
      mode: GUIDED_DOWNTIME_MODE,
      actorId: actor.id,
      settlementId: "guided-downtime",
      activityId: activity.id,
      activityLabel: activity.name,
      activityImage: activity.image,
      hours: block.budgetHours,
      createdAt,
      selectedOutcomeIndex,
      outcomeLabel: outcome.label,
      report,
      project,
      currencyDeltaCp: 0,
      summary: `${outcome.label}: ${report} ${projectProgressLabel}`,
      check: {
        skill,
        total,
        formula: String(roll?.formula ?? roll?.roll?.formula ?? ""),
        outcomeTier: "neutral",
      },
    };
  }
  const walletRead = readWalletStrict(actor.system?.currency);
  if (!walletRead.ok)
    throw new Error(`${actor.name}'s currency could not be verified.`);
  const currencyDeltaCp = Math.round(outcome.rewardGp * 100);
  const walletAfter = planWalletDeltaCp(walletRead.wallet, currencyDeltaCp);
  if (!walletAfter)
    throw new Error(`${actor.name}'s reward could not be prepared.`);
  return {
    operationId: operationId || `guided-${block.id}-${actor.id}`,
    kind: "currency",
    mode: GUIDED_DOWNTIME_MODE,
    actorId: actor.id,
    settlementId: "guided-downtime",
    activityId: activity.id,
    activityLabel: activity.name,
    activityImage: activity.image,
    hours: block.budgetHours,
    createdAt,
    selectedOutcomeIndex,
    outcomeLabel: outcome.label,
    report,
    currencyDeltaCp,
    walletBefore: walletRead.wallet,
    walletAfter,
    summary: `${outcome.label}: ${report}${currencyDeltaCp > 0 ? ` ${formatCp(currencyDeltaCp)} was added to ${actor.name}.` : ""}`,
    check: {
      skill,
      total,
      formula: String(roll?.formula ?? roll?.roll?.formula ?? ""),
      outcomeTier: "neutral",
    },
  };
}

function guidedActivityById(templates, projects, activityId) {
  const template = guidedTemplateById(templates, activityId);
  if (template) return { ...template, kind: "template" };
  const project = guidedProjectById(projects, activityId);
  return project
    ? { ...project, kind: "project", outcomes: GUIDED_PROJECT_OUTCOMES }
    : null;
}

function normalizeGuidedActivitySelection(raw, templates, projects) {
  const templateSelection = normalizeGuidedDowntimeSelection(raw, templates);
  if (templateSelection) return templateSelection;
  const project = guidedProjectById(projects, raw?.templateId);
  const skill = String(raw?.skill ?? "").trim();
  if (
    !project ||
    (project.skills.length > 0 && !project.skills.includes(skill))
  ) {
    return null;
  }
  return {
    templateId: project.id,
    skill: project.skills.length > 0 ? skill : "",
  };
}

function guidedProjectProgressFromStore(store) {
  const progress = new Map();
  for (const [projectId, hours] of Object.entries(
    store?.projectProgress ?? {},
  )) {
    progress.set(projectId, Math.max(0, Math.floor(Number(hours) || 0)));
  }
  if (Object.keys(store?.projectProgress ?? {}).length > 0) return progress;
  for (const block of store?.history ?? []) {
    if (block?.state !== "completed") continue;
    for (const operation of block.plan?.operations ?? []) {
      const project = operation?.project;
      const id = String(project?.id ?? "").trim();
      const contributedHours = Math.max(
        0,
        Math.floor(Number(project?.contributedHours) || 0),
      );
      if (id && contributedHours) {
        progress.set(id, projectProgressHours(progress, id) + contributedHours);
      }
    }
  }
  return progress;
}

function projectProgressHours(progress, projectId) {
  const value = progress instanceof Map ? progress.get(projectId) : 0;
  return Math.max(0, Math.floor(Number(value) || 0));
}

function formatGuidedProjectProgress(project) {
  const complete = project.completed ? " Project complete." : "";
  const applied = Math.min(project.progressAfterHours, project.requiredHours);
  return `${project.contributedHours}h contributed — ${applied}/${project.requiredHours}h.${complete}`;
}

function guidedOutcomeIndex(total, count) {
  if (count <= 1) return 0;
  if (total >= 20) return count - 1;
  if (total >= 12) return Math.min(count - 1, 1);
  return 0;
}

function normalizeGuidedPlayerRoll(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return { ok: false };
  }
  const total = Number(raw.total);
  if (!Number.isFinite(total) || total < -100 || total > 1_000) {
    return { ok: false };
  }
  return {
    ok: true,
    total,
    formula: String(raw.formula ?? "").slice(0, 160),
  };
}

function cleanGuidedLocation(value) {
  const location = String(value ?? "")
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 120);
  return location || "Downtime";
}

function cleanGuidedReport(value) {
  return String(value ?? "")
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 800);
}

export async function applyActiveDowntimeBlock(blockId) {
  return runServiceMutation(() => applyBlockInternal(blockId));
}

async function applyBlockInternal(blockId) {
  assertAuthority();
  let block = getActiveDowntimeBlock();
  if (!block || block.id !== String(blockId)) {
    const completed = loadDowntimeWorkflowStore().history.find(
      (entry) => entry.id === String(blockId) && entry.state === "completed",
    );
    if (completed) return completed;
  }
  if (!block || block.id !== String(blockId) || !block.plan) {
    throw new Error("Generate the immutable preview before applying downtime.");
  }
  if (block.state === "planned") {
    block = await beginDowntimeApplication(block.id);
  } else if (block.state === "needs-review") {
    throw new Error("Run recovery before retrying a block that needs review.");
  } else if (block.state !== "applying") {
    throw new Error("That downtime block is not ready to apply.");
  }
  notifyServiceChanged("block-applying");
  await broadcastPlayerState(block);
  let needsReview = false;
  const blockedActors = new Set();
  for (const operation of block.plan.operations ?? []) {
    if (blockedActors.has(operation.actorId)) continue;
    block = getActiveDowntimeBlock();
    const record = block?.operationLedger?.[operation.operationId];
    if (!record) {
      needsReview = true;
      blockedActors.add(operation.actorId);
      continue;
    }
    if (["applied", "skipped", "compensated"].includes(record.state)) continue;
    if (["applying", "needs-review"].includes(record.state)) {
      needsReview = true;
      blockedActors.add(operation.actorId);
      continue;
    }
    const attemptId = newDowntimeRequestId("apply");
    const claim = await claimDowntimeOperation(
      block.id,
      operation.operationId,
      {
        attemptId,
        at: now(),
      },
    );
    if (claim?.claimedNow !== true) {
      if (
        ["applied", "skipped", "compensated"].includes(claim?.record?.state)
      ) {
        continue;
      }
      needsReview = true;
      blockedActors.add(operation.actorId);
      continue;
    }
    const writeAuthority = () =>
      hasCurrentDowntimeWriteAuthority({
        blockId: block.id,
        operationId: operation.operationId,
        attemptId,
        authorityEpoch: claim.record?.authorityEpoch,
        userId: claim.record?.claimedBy,
      });
    let outcome;
    try {
      outcome = await applyPlannedOperation(operation, {
        // Previously ambiguous attempts are reconciled before application.
        // Every operation reaching this path is a newly claimed before-state
        // write and may not accept a coincidental projected post-state.
        allowAlreadyApplied: false,
        authorizeWrite: writeAuthority,
      });
    } catch (error) {
      outcome = {
        ok: false,
        reason: String(error?.message ?? "operation-failed"),
        provenUnapplied: false,
      };
    }
    if (outcome.ok) {
      await resolveDowntimeOperation(block.id, operation.operationId, {
        state: operation.kind === "noop" ? "skipped" : "applied",
        attemptId,
        receipt: {
          summary: operation.summary,
          alreadyApplied: outcome.alreadyApplied === true,
        },
        at: now(),
      });
      continue;
    }
    await resolveDowntimeOperation(block.id, operation.operationId, {
      state: outcome.provenUnapplied ? "verified-unapplied" : "needs-review",
      attemptId,
      reason: outcome.reason,
      receipt: outcome.receipt ?? null,
      at: now(),
    });
    needsReview = true;
    blockedActors.add(operation.actorId);
  }
  block = getActiveDowntimeBlock();
  const unfinished = Object.values(block?.operationLedger ?? {}).some(
    (record) => !["applied", "skipped", "compensated"].includes(record.state),
  );
  if (needsReview || unfinished) {
    if (block?.state !== "needs-review") {
      block = await markDowntimeNeedsReview(
        block.id,
        "At least one character has an unapplied or uncertain operation. Independent characters were continued.",
      );
    }
    notifyServiceChanged("block-needs-review");
    await broadcastPlayerState(block);
    return block;
  }
  const result = buildCompletedResult(block);
  const completed = await completeDowntimeBlock(block.id, {
    result,
    at: result.completedAt,
  });
  notifyServiceChanged("block-complete");
  await broadcastCompletedState(completed);
  return completed;
}

async function applyPlannedOperation(
  operation,
  {
    allowAlreadyApplied = false,
    authorizeWrite = hasCurrentDowntimeWriteAuthority,
  } = {},
) {
  if (
    !String(operation?.operationId ?? "").trim() ||
    !String(operation?.actorId ?? "").trim() ||
    !String(operation?.settlementId ?? "").trim()
  ) {
    return {
      ok: false,
      reason: "invalid-operation-schema",
      provenUnapplied: true,
    };
  }
  const actor = actorById(operation.actorId);
  if (!actor)
    return { ok: false, reason: "actor-missing", provenUnapplied: false };
  const consequencePreconditions = verifyConsequencePreconditions(operation, {
    allowAlreadyApplied,
  });
  if (!consequencePreconditions.ok) return consequencePreconditions;
  const applyFreshGuard = (apply) => {
    if (!allowAlreadyApplied) {
      const precondition = verifyFreshDowntimeOperationPreconditions(
        actor,
        operation,
      );
      if (!precondition.ok) return precondition;
    }
    return apply();
  };
  let primary;
  switch (operation.kind) {
    case "craft-ammunition":
      primary = await runWithActorMutex(actor.id, () =>
        applyFreshGuard(() =>
          applyAmmoCraftOperation(actor, operation, {
            authorizeWrite,
          }),
        ),
      );
      break;
    case "sharpen-weapon":
      primary = await runWithActorMutex(actor.id, () =>
        applyFreshGuard(() =>
          applySharpenOperation(actor, operation, { authorizeWrite }),
        ),
      );
      break;
    case "currency":
      primary = await runWithActorMutex(actor.id, () =>
        applyFreshGuard(() =>
          applyWalletOperation(actor, operation, { authorizeWrite }),
        ),
      );
      break;
    case "pickpocket":
      primary = operation.stolenItemSnapshot
        ? await runWithActorMutex(actor.id, () =>
            applyFreshGuard(() =>
              applyPickpocketOperation(actor, operation, { authorizeWrite }),
            ),
          )
        : { ok: true, noWrite: true };
      break;
    case "shoplift":
      primary = operation.stolenItemSnapshot
        ? await runWithMerchantActorMutex(operation.merchantId, actor.id, () =>
            applyFreshGuard(() =>
              applyShopliftOperation(actor, operation, { authorizeWrite }),
            ),
          )
        : { ok: true, noWrite: true };
      break;
    case "fence-stolen-goods":
      primary = operation.goodsTransferred
        ? await runWithActorMutex(actor.id, () => {
            const fresh = allowAlreadyApplied
              ? { ok: true }
              : verifyFreshDowntimeOperationPreconditions(actor, operation);
            if (!fresh.ok) return fresh;
            const precondition = verifyStolenBundlePrecondition(
              actor,
              operation,
            );
            if (!precondition.ok) return precondition;
            return applyFenceAndConsumeOperation(actor, operation, {
              authorizeWrite,
            });
          })
        : { ok: true, noWrite: true };
      break;
    case "heat":
    case "noop":
      primary = { ok: true, noWrite: true };
      break;
    default:
      return { ok: false, reason: "unknown-operation", provenUnapplied: true };
  }
  if (!primary.ok) return primary;
  const consequences = await applyOperationConsequences(operation, {
    allowAlreadyApplied,
    authorizeWrite,
  });
  if (!consequences.ok) {
    return {
      ...consequences,
      receipt: { primaryApplied: !primary.noWrite },
      provenUnapplied: primary.noWrite && consequences.provenUnapplied,
    };
  }
  return {
    ok: true,
    alreadyApplied:
      primary.alreadyApplied === true && consequences.alreadyApplied === true,
  };
}

export function verifyStolenBundlePrecondition(actor, operation) {
  const snapshots = Array.isArray(operation?.itemSnapshots)
    ? operation.itemSnapshots
    : [];
  const issuances = Array.isArray(operation?.stolenIssuanceRecords)
    ? operation.stolenIssuanceRecords
    : [];
  if (snapshots.length === 0 || issuances.length !== snapshots.length) {
    return {
      ok: false,
      reason: "stolen-bundle-missing",
      provenUnapplied: false,
    };
  }
  const current = snapshots.map((snapshot) =>
    findActorItem(actor, snapshot?._id),
  );
  if (current.some((item) => !item)) {
    return {
      ok: false,
      reason: "stolen-bundle-drift",
      provenUnapplied: false,
    };
  }
  const config = loadDowntimeConfig();
  for (let index = 0; index < snapshots.length; index += 1) {
    const expected = stolenProvenance(snapshots[index]);
    const actual = stolenProvenance(current[index]);
    if (
      Number(current[index]?.system?.quantity ?? 1) !== 1 ||
      !sameStolenProvenance(actual, expected) ||
      !stolenGoodsRecordsEqual(
        activeStolenGoodsRecord(config, {
          actorId: actor?.id,
          itemId: snapshots[index]?._id,
          item: current[index],
        }),
        issuances[index],
      )
    ) {
      return {
        ok: false,
        reason: "stolen-bundle-drift",
        provenUnapplied: false,
      };
    }
  }
  return { ok: true };
}

function operationItemQuantity(actor, itemId) {
  const item = findActorItem(actor, itemId);
  if (!item) return { item: null, quantity: 0 };
  return {
    item,
    quantity: Math.max(
      0,
      Math.floor(
        Number(
          item.system?.quantity ?? item.toObject?.()?.system?.quantity ?? 1,
        ) || 0,
      ),
    ),
  };
}

function freshOperationDrift(reason) {
  return {
    ok: false,
    reason,
    // A matching projected post-state without a durable prior attempt is
    // ambiguous: it may be unrelated drift or a stale external write. Do not
    // credit it and do not automatically retry it.
    provenUnapplied: false,
  };
}

/**
 * Verify that a newly claimed operation still starts from its immutable
 * before-state. This must run inside the same Actor/merchant mutex as the
 * corresponding writes so a coincidental projected post-state cannot be
 * mistaken for a replay.
 */
export function verifyFreshDowntimeOperationPreconditions(actor, operation) {
  const kind = String(operation?.kind ?? "");
  if (!actor) return freshOperationDrift("actor-missing");

  if (["craft-ammunition", "currency"].includes(kind)) {
    const wallet = readWalletStrict(actor.system?.currency);
    if (!wallet.ok || !walletsEqual(wallet.wallet, operation?.walletBefore)) {
      return freshOperationDrift("wallet-drift");
    }
  }

  if (kind === "craft-ammunition") {
    const delivery = operation?.delivery ?? {};
    const state = operationItemQuantity(actor, delivery.itemId);
    const createConflict = delivery.mode === "create" && Boolean(state.item);
    const stackIdentityDrift =
      delivery.mode === "stack" &&
      !ammoCraftDeliveryItemMatches(state.item, operation);
    if (
      createConflict ||
      stackIdentityDrift ||
      state.quantity !== Number(delivery.quantityBefore)
    ) {
      if (stackIdentityDrift) return freshOperationDrift("item-identity-drift");
      return freshOperationDrift("item-quantity-drift");
    }
  }

  if (kind === "pickpocket" && operation?.stolenItemSnapshot) {
    const itemId = String(operation.stolenItemSnapshot._id ?? "").trim();
    if (itemId && findActorItem(actor, itemId)) {
      return freshOperationDrift("stolen-item-already-present");
    }
    if (itemId && stolenGoodsRecord(loadDowntimeConfig(), itemId)) {
      return freshOperationDrift("stolen-issuance-already-present");
    }
  }

  if (kind === "shoplift" && operation?.stolenItemSnapshot) {
    const itemId = String(operation.stolenItemSnapshot._id ?? "").trim();
    if (itemId && findActorItem(actor, itemId)) {
      return freshOperationDrift("stolen-item-already-present");
    }
    if (itemId && stolenGoodsRecord(loadDowntimeConfig(), itemId)) {
      return freshOperationDrift("stolen-issuance-already-present");
    }
    const merchant = findMerchant(operation.merchantId);
    const row = merchant?.items?.find((entry) =>
      sameInfinityItemUuid(entry.uuid, operation.itemUuid),
    );
    if (
      !row ||
      row.unlimited ||
      Number(row.qty) !== Number(operation.quantityBefore)
    ) {
      return freshOperationDrift("merchant-stock-drift");
    }
  }

  if (kind === "fence-stolen-goods" && operation?.goodsTransferred) {
    const wallet = readWalletStrict(actor.system?.currency);
    if (!wallet.ok || !walletsEqual(wallet.wallet, operation?.walletBefore)) {
      return freshOperationDrift("wallet-drift");
    }
    const bundle = verifyStolenBundlePrecondition(actor, operation);
    if (!bundle.ok) return freshOperationDrift(bundle.reason);
  }

  if (kind === "sharpen-weapon") {
    const weapon = findActorItem(actor, operation.weaponId);
    const matching = sharpeningEffects(weapon).some(
      (effect) =>
        (effect.toObject?.() ?? effect)?.flags?.[MODULE_ID]?.downtimeSharpen
          ?.operationId === operation.operationId,
    );
    if (matching) return freshOperationDrift("weapon-already-sharpened");
  }

  return { ok: true };
}

function sameStolenProvenance(actual, expected) {
  if (!actual || !expected) return false;
  return [
    "settlementId",
    "targetType",
    "sourceId",
    "merchantId",
    "operationId",
    "timestamp",
    "appraisedValueCp",
  ].every((key) => String(actual[key] ?? "") === String(expected[key] ?? ""));
}

function verifyConsequencePreconditions(
  operation,
  { allowAlreadyApplied = false } = {},
) {
  if (
    Number.isInteger(operation.heatBefore) &&
    Number.isInteger(operation.heatAfter) &&
    operation.heatBefore !== operation.heatAfter
  ) {
    const current = getDowntimeHeat(
      loadDowntimeConfig(),
      operation.settlementId,
      operation.actorId,
    );
    if (
      current !== operation.heatBefore &&
      !(allowAlreadyApplied && current === operation.heatAfter)
    ) {
      return { ok: false, reason: "heat-drift", provenUnapplied: true };
    }
  }
  if (operation.factionWrite) {
    const write = operation.factionWrite;
    if (
      !Number.isFinite(Number(write.standingBefore)) ||
      !Number.isFinite(Number(write.standingAfter))
    ) {
      return {
        ok: false,
        reason: "faction-plan-invalid",
        provenUnapplied: true,
      };
    }
    const faction = loadFactions().find(
      (entry) => entry.id === write.factionId,
    );
    if (!faction) {
      return { ok: false, reason: "faction-missing", provenUnapplied: true };
    }
    const alreadyApplied = faction.history.some(
      (entry) => entry.id === write.historyId,
    );
    if (alreadyApplied && !allowAlreadyApplied) {
      return {
        ok: false,
        reason: "faction-history-drift",
        provenUnapplied: false,
      };
    }
    if (!alreadyApplied && faction.standing !== Number(write.standingBefore)) {
      return {
        ok: false,
        reason: "faction-standing-drift",
        provenUnapplied: true,
      };
    }
  }
  return { ok: true };
}

function actorItemMatchesStolenIssuance(actor, issuance) {
  const item = findActorItem(actor, issuance?.itemId);
  if (!item) return false;
  const observed = buildStolenGoodsIssuance({
    actorId: actor.id,
    snapshot: item,
  });
  return stolenGoodsRecordsEqual(observed, issuance);
}

async function persistStolenIssuance(
  actor,
  issuance,
  { authorizeWrite = hasCurrentDowntimeWriteAuthority } = {},
) {
  if (!issuance || !actorItemMatchesStolenIssuance(actor, issuance)) {
    return {
      ok: false,
      reason: "stolen-issuance-item-drift",
      provenUnapplied: false,
    };
  }
  const current = stolenGoodsRecord(loadDowntimeConfig(), issuance.itemId);
  if (current) {
    return stolenGoodsRecordsEqual(current, issuance)
      ? { ok: true, alreadyApplied: true }
      : {
          ok: false,
          reason: "stolen-issuance-collision",
          provenUnapplied: false,
        };
  }
  if (!authorizeWrite()) {
    return authorityLostOperationResult(false);
  }
  let error = null;
  try {
    await updateDowntimeConfig((config) => {
      if (!authorizeWrite()) throw new Error("authority-lost");
      const issued = issueStolenGoodsRecord(config.stolenGoods, issuance);
      if (!issued.ok) throw new Error(issued.reason);
      return { ...config, stolenGoods: issued.ledger };
    });
  } catch (caught) {
    error = caught;
  }
  const canonical = stolenGoodsRecord(loadDowntimeConfig(), issuance.itemId);
  if (stolenGoodsRecordsEqual(canonical, issuance)) {
    return { ok: true, alreadyApplied: false };
  }
  return {
    ok: false,
    reason: String(error?.message ?? "stolen-issuance-write-failed"),
    provenUnapplied: false,
  };
}

async function persistStolenConsumptions(
  actor,
  consumptions,
  { authorizeWrite = hasCurrentDowntimeWriteAuthority } = {},
) {
  const planned = Array.isArray(consumptions) ? consumptions : [];
  if (planned.length === 0) {
    return {
      ok: false,
      reason: "stolen-consumption-plan-missing",
      provenUnapplied: false,
    };
  }
  if (
    planned.some(
      (record) =>
        record?.actorId !== String(actor?.id ?? "") ||
        findActorItem(actor, record.itemId),
    )
  ) {
    return {
      ok: false,
      reason: "stolen-consumption-item-drift",
      provenUnapplied: false,
    };
  }
  const canonicalBefore = loadDowntimeConfig();
  const allConsumed = planned.every((record) =>
    stolenGoodsRecordsEqual(
      stolenGoodsRecord(canonicalBefore, record.itemId),
      record,
    ),
  );
  if (allConsumed) return { ok: true, alreadyApplied: true };
  if (!authorizeWrite()) {
    return authorityLostOperationResult(false);
  }
  let error = null;
  try {
    await updateDowntimeConfig((config) => {
      if (!authorizeWrite()) throw new Error("authority-lost");
      let ledger = config.stolenGoods;
      for (const consumption of planned) {
        const consumed = consumeStolenGoodsRecord(ledger, consumption);
        if (!consumed.ok) throw new Error(consumed.reason);
        ledger = consumed.ledger;
      }
      return { ...config, stolenGoods: ledger };
    });
  } catch (caught) {
    error = caught;
  }
  const canonical = loadDowntimeConfig();
  if (
    planned.every((record) =>
      stolenGoodsRecordsEqual(
        stolenGoodsRecord(canonical, record.itemId),
        record,
      ),
    )
  ) {
    return { ok: true, alreadyApplied: false };
  }
  return {
    ok: false,
    reason: String(error?.message ?? "stolen-consumption-write-failed"),
    provenUnapplied: false,
  };
}

async function applyPickpocketOperation(
  actor,
  operation,
  { authorizeWrite = hasCurrentDowntimeWriteAuthority } = {},
) {
  const delivered = await applyStolenItemDelivery(
    actor,
    operation.stolenItemSnapshot,
    { authorizeWrite },
  );
  if (!delivered.ok) return delivered;
  const issued = await persistStolenIssuance(actor, operation.stolenIssuance, {
    authorizeWrite,
  });
  if (!issued.ok) return issued;
  return {
    ok: true,
    alreadyApplied:
      delivered.alreadyApplied === true && issued.alreadyApplied === true,
  };
}

async function applyFenceAndConsumeOperation(
  actor,
  operation,
  { authorizeWrite = hasCurrentDowntimeWriteAuthority } = {},
) {
  const fenced = await applyFenceOperation(actor, operation, {
    authorizeWrite,
  });
  if (!fenced.ok) return fenced;
  const consumed = await persistStolenConsumptions(
    actor,
    operation.stolenConsumptionRecords,
    { authorizeWrite },
  );
  if (!consumed.ok) return consumed;
  return {
    ok: true,
    alreadyApplied:
      fenced.alreadyApplied === true && consumed.alreadyApplied === true,
  };
}

async function applyWalletOperation(
  actor,
  operation,
  { authorizeWrite = hasCurrentDowntimeWriteAuthority } = {},
) {
  const current = readWalletStrict(actor.system?.currency);
  if (!current.ok) return { ok: false, reason: "invalid-wallet" };
  if (walletsEqual(current.wallet, operation.walletAfter)) {
    return { ok: true, alreadyApplied: true };
  }
  if (!walletsEqual(current.wallet, operation.walletBefore)) {
    return { ok: false, reason: "wallet-drift", provenUnapplied: false };
  }
  if (!authorizeWrite()) {
    return authorityLostOperationResult(true);
  }
  const updated = await updateCurrencyVerified(actor, operation.walletAfter, {
    authorizeWrite,
  });
  return updated.ok
    ? { ok: true, alreadyApplied: false }
    : { ok: false, reason: updated.reason, provenUnapplied: false };
}

async function applySharpenOperation(
  actor,
  operation,
  { authorizeWrite = hasCurrentDowntimeWriteAuthority } = {},
) {
  const weapon = findActorItem(actor, operation.weaponId);
  if (!weapon)
    return { ok: false, reason: "weapon-missing", provenUnapplied: true };
  const matching = sharpeningEffects(weapon).find(
    (effect) =>
      (effect.toObject?.() ?? effect)?.flags?.[MODULE_ID]?.downtimeSharpen
        ?.operationId === operation.operationId,
  );
  if (matching) return { ok: true, alreadyApplied: true };
  if (
    !actorHasAnyTool(actor, operation.toolKeys ?? SHARPENING_TOOL_KEYS) ||
    !isSharpenableWeapon(weapon) ||
    hasSharpening(weapon) ||
    sharpenDamageType(weapon) !== operation.damageType
  ) {
    return { ok: false, reason: "weapon-drift", provenUnapplied: true };
  }
  const applied = await applySharpeningEffect(weapon, {
    operationId: operation.operationId,
    actorId: actor.id,
    timestamp: operation.createdAt ?? now(),
    authorizeWrite,
  });
  if (applied.ok) return { ok: true, alreadyApplied: false };
  const recovered = sharpeningEffects(weapon).some(
    (effect) =>
      (effect.toObject?.() ?? effect)?.flags?.[MODULE_ID]?.downtimeSharpen
        ?.operationId === operation.operationId,
  );
  return recovered
    ? { ok: true, alreadyApplied: true }
    : {
        ok: false,
        reason: applied.reason,
        provenUnapplied: applied.provenUnapplied === true,
      };
}

async function applyShopliftOperation(
  actor,
  operation,
  { authorizeWrite = hasCurrentDowntimeWriteAuthority } = {},
) {
  const delivered = await applyStolenItemDelivery(
    actor,
    operation.stolenItemSnapshot,
    { authorizeWrite },
  );
  if (!delivered.ok) return delivered;
  let updated = null;
  let updateError = null;
  try {
    updated = await updateMerchant(
      operation.merchantId,
      (merchant) => {
        const row = merchant.items.find((entry) =>
          sameInfinityItemUuid(entry.uuid, operation.itemUuid),
        );
        if (!row || row.unlimited) throw new Error("merchant-stock-drift");
        if (Number(row.qty) === Number(operation.quantityAfter))
          return merchant;
        if (Number(row.qty) !== Number(operation.quantityBefore)) {
          throw new Error("merchant-stock-drift");
        }
        return {
          ...merchant,
          items: merchant.items.map((entry) =>
            sameInfinityItemUuid(entry.uuid, operation.itemUuid)
              ? { ...entry, qty: operation.quantityAfter }
              : entry,
          ),
        };
      },
      { authorizeWrite },
    );
  } catch (error) {
    updateError = error;
  }
  const canonical = findMerchant(operation.merchantId);
  const row = canonical?.items?.find((entry) =>
    sameInfinityItemUuid(entry.uuid, operation.itemUuid),
  );
  const itemPresent = Boolean(
    findActorItem(actor, operation.stolenItemSnapshot._id),
  );
  if (Number(row?.qty) === Number(operation.quantityAfter) && itemPresent) {
    const issued = await persistStolenIssuance(
      actor,
      operation.stolenIssuance,
      {
        authorizeWrite,
      },
    );
    if (!issued.ok) return issued;
    return {
      ok: true,
      alreadyApplied:
        !updated &&
        delivered.alreadyApplied === true &&
        issued.alreadyApplied === true,
    };
  }
  const item = findActorItem(actor, operation.stolenItemSnapshot._id);
  let restored = !item;
  if (item) {
    if (!authorizeWrite()) {
      return authorityLostOperationResult(false);
    }
    try {
      const result = await actor.deleteEmbeddedDocuments("Item", [item.id]);
      restored =
        Array.isArray(result) &&
        result.some(
          (entry) => String(entry?.id ?? entry?._id) === String(item.id),
        ) &&
        !findActorItem(actor, item.id);
    } catch {
      restored = false;
    }
  }
  return {
    ok: false,
    reason: restored
      ? String(updateError?.message ?? "merchant-write-failed")
      : "compensation-failed",
    provenUnapplied:
      restored && Number(row?.qty) === Number(operation.quantityBefore),
  };
}

async function applyOperationConsequences(
  operation,
  {
    allowAlreadyApplied = false,
    authorizeWrite = hasCurrentDowntimeWriteAuthority,
  } = {},
) {
  let required = false;
  let alreadyApplied = true;
  let consequencePresent = false;
  if (
    Number.isInteger(operation.heatBefore) &&
    Number.isInteger(operation.heatAfter) &&
    operation.heatBefore !== operation.heatAfter
  ) {
    required = true;
    const settlementId = String(operation.settlementId ?? "").trim();
    if (!settlementId) {
      return {
        ok: false,
        reason: "settlement-id-missing",
        provenUnapplied: true,
      };
    }
    const config = loadDowntimeConfig();
    const current = getDowntimeHeat(config, settlementId, operation.actorId);
    if (current === operation.heatAfter) {
      if (!allowAlreadyApplied) {
        return {
          ok: false,
          reason: "heat-drift",
          provenUnapplied: false,
        };
      }
      // Already committed during a recoverable prior attempt with durable
      // claim evidence.
      consequencePresent = true;
    } else if (current === operation.heatBefore) {
      if (!authorizeWrite()) {
        return authorityLostOperationResult(true);
      }
      try {
        await updateDowntimeConfig((latest) => {
          if (!authorizeWrite()) throw new Error("authority-lost");
          if (
            getDowntimeHeat(latest, settlementId, operation.actorId) !==
            operation.heatBefore
          ) {
            throw new Error("heat-drift");
          }
          return {
            ...latest,
            heat: setDowntimeHeat(
              latest.heat,
              settlementId,
              operation.actorId,
              operation.heatAfter,
            ),
          };
        });
      } catch (error) {
        return {
          ok: false,
          reason: String(error?.message ?? "heat-write-failed"),
          provenUnapplied: false,
        };
      }
      consequencePresent = true;
      alreadyApplied = false;
    } else {
      return { ok: false, reason: "heat-drift", provenUnapplied: false };
    }
  }
  if (operation.factionWrite) {
    required = true;
    const write = operation.factionWrite;
    let status = "missing";
    const existingFaction = loadFactions().find(
      (faction) => faction.id === write.factionId,
    );
    if (
      existingFaction?.history?.some((entry) => entry.id === write.historyId)
    ) {
      if (!allowAlreadyApplied) {
        return {
          ok: false,
          reason: "faction-history-drift",
          provenUnapplied: false,
        };
      }
      status = "existing";
      consequencePresent = true;
    }
    if (status !== "existing" && !authorizeWrite()) {
      return authorityLostOperationResult(!consequencePresent);
    }
    let updated;
    try {
      if (status === "existing") updated = existingFaction;
      else
        updated = await updateFaction(
          write.factionId,
          (rawFaction) => {
            const faction = normalizeFaction(rawFaction);
            if (faction.history.some((entry) => entry.id === write.historyId)) {
              status = "existing";
              return faction;
            }
            const from = Number(write.standingBefore);
            const to = Number(write.standingAfter);
            if (
              faction.standing !== from ||
              !Number.isFinite(from) ||
              !Number.isFinite(to) ||
              clampStanding(to) !== to ||
              to - from !== Number(write.delta)
            ) {
              throw new Error("faction-standing-drift");
            }
            const entry = {
              id: write.historyId,
              at: write.at,
              by: "Downtime",
              delta: to - from,
              fromStanding: from,
              toStanding: to,
              reason: write.reason,
            };
            status = "created";
            return normalizeFaction({
              ...faction,
              standing: to,
              history: [entry, ...faction.history].slice(0, HISTORY_CAP),
            });
          },
          { authorizeWrite },
        );
    } catch (error) {
      return {
        ok: false,
        reason: String(error?.message ?? "faction-write-failed"),
        provenUnapplied: !consequencePresent,
      };
    }
    if (
      !updated ||
      !updated.history.some((entry) => entry.id === write.historyId)
    ) {
      return {
        ok: false,
        reason: "faction-write-failed",
        provenUnapplied: !consequencePresent,
      };
    }
    if (status === "created") {
      consequencePresent = true;
      alreadyApplied = false;
    }
  }
  return { ok: true, required, alreadyApplied };
}

export function hasCurrentDowntimeWriteAuthority(token = null) {
  if (!isAuthoritativeGM()) return false;
  if (!token) return true;
  try {
    const store = loadDowntimeWorkflowStore();
    const authorityMatches =
      store.authorityId === String(token.userId ?? "") &&
      store.authorityEpoch === String(token.authorityEpoch ?? "");
    if (!String(token.operationId ?? "")) return authorityMatches;
    const block = store.activeBlock;
    const record = block?.operationLedger?.[String(token.operationId ?? "")];
    return Boolean(
      block &&
      block.id === String(token.blockId ?? "") &&
      block.state === "applying" &&
      authorityMatches &&
      record?.state === "applying" &&
      record.attemptId === String(token.attemptId ?? "") &&
      record.claimedBy === String(token.userId ?? "") &&
      record.authorityEpoch === String(token.authorityEpoch ?? ""),
    );
  } catch {
    return false;
  }
}

function captureDowntimeAuthorityEpochGuard() {
  const store = loadDowntimeWorkflowStore();
  const token = {
    userId: String(globalThis.game?.user?.id ?? ""),
    authorityEpoch: String(store.authorityEpoch ?? ""),
  };
  return () => hasCurrentDowntimeWriteAuthority(token);
}

function authorityLostOperationResult(provenUnapplied) {
  return {
    ok: false,
    reason: "authority-lost",
    provenUnapplied: provenUnapplied === true,
  };
}

export async function recoverActiveDowntimeBlock(blockId) {
  return runServiceMutation(async () => {
    assertAuthority();
    let block = getActiveDowntimeBlock();
    if (
      !block ||
      block.id !== String(blockId) ||
      !["applying", "needs-review"].includes(block.state)
    ) {
      throw new Error("No interrupted downtime application is available.");
    }
    // An interrupted application can durably resolve one operation to
    // needs-review before the later block-level transition is committed. Move
    // that valid microstate onto the review branch before using the
    // recovery-only applied resolver, which intentionally requires both the
    // block and operation to be under review.
    if (
      block.state === "applying" &&
      Object.values(block.operationLedger ?? {}).some(
        (record) => record.state === "needs-review",
      )
    ) {
      block = await markDowntimeNeedsReview(
        block.id,
        "Recovery resumed after an operation entered review before the block transition completed.",
      );
    }
    let uncertain = false;
    for (const operation of block.plan?.operations ?? []) {
      block = getActiveDowntimeBlock();
      const record = block.operationLedger?.[operation.operationId];
      if (!record || !["applying", "needs-review"].includes(record.state))
        continue;
      const recoveryAuthority = captureDowntimeAuthorityEpochGuard();
      await reconcileInterruptedStolenLedgerWrite(operation, {
        authorizeWrite: recoveryAuthority,
      });
      const inspection = await inspectDowntimeOperation(operation);
      if (inspection === "applied") {
        if (record.state === "needs-review") {
          await resolveRecoveredDowntimeOperation(
            block.id,
            operation.operationId,
            {
              summary: operation.summary,
              at: now(),
            },
          );
        } else {
          await resolveDowntimeOperation(block.id, operation.operationId, {
            state: "applied",
            attemptId: record.attemptId,
            receipt: { summary: operation.summary, recovered: true },
            at: now(),
          });
        }
      } else if (inspection === "unapplied") {
        await resolveDowntimeOperation(block.id, operation.operationId, {
          state: "verified-unapplied",
          attemptId: record.state === "applying" ? record.attemptId : "",
          reason: "Canonical state proves this operation was not applied.",
          at: now(),
        });
      } else {
        uncertain = true;
        if (record.state === "applying") {
          await resolveDowntimeOperation(block.id, operation.operationId, {
            state: "needs-review",
            attemptId: record.attemptId,
            reason: "Canonical state is partially applied or has drifted.",
            at: now(),
          });
        }
      }
    }
    block = getActiveDowntimeBlock();
    uncertain ||= Object.values(block.operationLedger ?? {}).some(
      (record) =>
        record.state === "needs-review" || record.state === "applying",
    );
    if (uncertain) {
      if (block.state !== "needs-review") {
        block = await markDowntimeNeedsReview(
          block.id,
          "Recovery found a partial or drifted operation that needs manual review.",
        );
      }
      notifyServiceChanged("recovery-review");
      await broadcastPlayerState(block);
      return block;
    }
    if (block.state === "needs-review") {
      block = await beginDowntimeApplication(block.id);
    }
    return applyBlockInternal(block.id);
  });
}

async function reconcileInterruptedStolenLedgerWrite(
  operation,
  { authorizeWrite = hasCurrentDowntimeWriteAuthority } = {},
) {
  const actor = actorById(operation?.actorId);
  if (!actor) return false;
  if (operation?.stolenIssuance) {
    const itemPresent = actorItemMatchesStolenIssuance(
      actor,
      operation.stolenIssuance,
    );
    const shopStockApplied =
      operation.kind !== "shoplift" ||
      Number(
        findMerchant(operation.merchantId)?.items?.find((row) =>
          sameInfinityItemUuid(row.uuid, operation.itemUuid),
        )?.qty,
      ) === Number(operation.quantityAfter);
    if (itemPresent && shopStockApplied) {
      const issued = await persistStolenIssuance(
        actor,
        operation.stolenIssuance,
        { authorizeWrite },
      );
      return issued.ok;
    }
  }
  if (
    operation?.kind === "fence-stolen-goods" &&
    operation.goodsTransferred === true
  ) {
    const wallet = readWalletStrict(actor.system?.currency);
    const primaryApplied =
      wallet.ok &&
      walletsEqual(wallet.wallet, operation.walletAfter) &&
      (operation.itemSnapshots ?? []).every(
        (snapshot) => !findActorItem(actor, snapshot._id),
      );
    if (primaryApplied) {
      const consumed = await persistStolenConsumptions(
        actor,
        operation.stolenConsumptionRecords,
        { authorizeWrite },
      );
      return consumed.ok;
    }
  }
  return false;
}

export async function inspectDowntimeOperation(operation) {
  const actor = actorById(operation.actorId);
  if (!actor) return "uncertain";
  let primary = "applied";
  let primaryRequired = true;
  switch (operation.kind) {
    case "currency": {
      const wallet = readWalletStrict(actor.system?.currency);
      if (!wallet.ok) return "uncertain";
      primary = walletsEqual(wallet.wallet, operation.walletAfter)
        ? "applied"
        : walletsEqual(wallet.wallet, operation.walletBefore)
          ? "unapplied"
          : "uncertain";
      break;
    }
    case "craft-ammunition": {
      const wallet = readWalletStrict(actor.system?.currency);
      const item = findActorItem(actor, operation.delivery?.itemId);
      const quantity = Number(item?.system?.quantity ?? 0);
      const itemMatches = ammoCraftDeliveryItemMatches(item, operation);
      const after =
        wallet.ok &&
        walletsEqual(wallet.wallet, operation.walletAfter) &&
        itemMatches &&
        quantity === operation.delivery.quantityAfter;
      const beforeItem =
        operation.delivery.mode === "create"
          ? !item && Number(operation.delivery.quantityBefore) === 0
          : itemMatches && quantity === operation.delivery.quantityBefore;
      const before =
        wallet.ok &&
        walletsEqual(wallet.wallet, operation.walletBefore) &&
        beforeItem;
      primary = after ? "applied" : before ? "unapplied" : "uncertain";
      break;
    }
    case "sharpen-weapon": {
      const weapon = findActorItem(actor, operation.weaponId);
      if (!weapon) return "uncertain";
      const owned = sharpeningEffects(weapon).some(
        (effect) =>
          (effect.toObject?.() ?? effect)?.flags?.[MODULE_ID]?.downtimeSharpen
            ?.operationId === operation.operationId,
      );
      primary = owned
        ? "applied"
        : !hasSharpening(weapon)
          ? "unapplied"
          : "uncertain";
      break;
    }
    case "pickpocket":
      if (operation.stolenItemSnapshot) {
        const item = findActorItem(actor, operation.stolenItemSnapshot._id);
        const ledgerRecord = stolenGoodsRecord(
          loadDowntimeConfig(),
          operation.stolenIssuance?.itemId,
        );
        const applied =
          item &&
          actorItemMatchesStolenIssuance(actor, operation.stolenIssuance) &&
          stolenGoodsRecordsEqual(ledgerRecord, operation.stolenIssuance);
        const unapplied = !item && !ledgerRecord;
        primary = applied ? "applied" : unapplied ? "unapplied" : "uncertain";
      } else primaryRequired = false;
      break;
    case "shoplift":
      if (operation.stolenItemSnapshot) {
        const item = findActorItem(actor, operation.stolenItemSnapshot._id);
        const merchant = findMerchant(operation.merchantId);
        const row = merchant?.items?.find((entry) =>
          sameInfinityItemUuid(entry.uuid, operation.itemUuid),
        );
        const ledgerRecord = stolenGoodsRecord(
          loadDowntimeConfig(),
          operation.stolenIssuance?.itemId,
        );
        primary =
          item &&
          Number(row?.qty) === Number(operation.quantityAfter) &&
          actorItemMatchesStolenIssuance(actor, operation.stolenIssuance) &&
          stolenGoodsRecordsEqual(ledgerRecord, operation.stolenIssuance)
            ? "applied"
            : !item &&
                !ledgerRecord &&
                Number(row?.qty) === Number(operation.quantityBefore)
              ? "unapplied"
              : "uncertain";
      } else primaryRequired = false;
      break;
    case "fence-stolen-goods":
      if (operation.goodsTransferred) {
        const wallet = readWalletStrict(actor.system?.currency);
        const absent = operation.itemSnapshots.every(
          (snapshot) => !findActorItem(actor, snapshot._id),
        );
        const present = operation.itemSnapshots.every((snapshot) =>
          findActorItem(actor, snapshot._id),
        );
        const config = loadDowntimeConfig();
        const consumed = (operation.stolenConsumptionRecords ?? []).every(
          (record) =>
            stolenGoodsRecordsEqual(
              stolenGoodsRecord(config, record.itemId),
              record,
            ),
        );
        const issued = (operation.stolenIssuanceRecords ?? []).every((record) =>
          stolenGoodsRecordsEqual(
            activeStolenGoodsRecord(config, {
              actorId: actor.id,
              itemId: record.itemId,
              item: findActorItem(actor, record.itemId),
            }),
            record,
          ),
        );
        primary =
          wallet.ok &&
          absent &&
          walletsEqual(wallet.wallet, operation.walletAfter) &&
          consumed
            ? "applied"
            : wallet.ok &&
                present &&
                walletsEqual(wallet.wallet, operation.walletBefore) &&
                issued
              ? "unapplied"
              : "uncertain";
      } else primaryRequired = false;
      break;
    case "noop":
    case "heat":
      primaryRequired = false;
      break;
    default:
      return "uncertain";
  }
  const consequence = inspectDowntimeOperationConsequences(operation);
  if (!primaryRequired) {
    return consequence.required ? consequence.state : "applied";
  }
  if (!consequence.required) return primary;
  if (primary === "applied" && consequence.state === "applied")
    return "applied";
  if (primary === "unapplied" && consequence.state === "unapplied")
    return "unapplied";
  return "uncertain";
}

export function inspectDowntimeOperationConsequences(operation) {
  const heatRequired =
    Number.isInteger(operation.heatBefore) &&
    Number.isInteger(operation.heatAfter) &&
    operation.heatBefore !== operation.heatAfter;
  const factionRequired = Boolean(operation.factionWrite);
  if (!heatRequired && !factionRequired)
    return { required: false, state: "applied" };
  const states = [];
  if (heatRequired) {
    const config = loadDowntimeConfig();
    const current = getDowntimeHeat(
      config,
      operation.settlementId,
      operation.actorId,
    );
    states.push(
      current === operation.heatAfter
        ? "applied"
        : current === operation.heatBefore
          ? "unapplied"
          : "uncertain",
    );
  }
  if (factionRequired) {
    const faction = loadFactions().find(
      (entry) => entry.id === operation.factionWrite.factionId,
    );
    if (!faction) states.push("uncertain");
    else {
      const historyPresent = faction.history.some(
        (entry) => entry.id === operation.factionWrite.historyId,
      );
      states.push(
        historyPresent
          ? "applied"
          : Number.isFinite(Number(operation.factionWrite.standingBefore)) &&
              faction.standing === Number(operation.factionWrite.standingBefore)
            ? "unapplied"
            : "uncertain",
      );
    }
  }
  return {
    required: true,
    state: states.every((state) => state === states[0])
      ? states[0]
      : "uncertain",
  };
}

export async function cancelActiveDowntimeBlock(blockId) {
  return runServiceMutation(async () => {
    assertAuthority();
    const block = getActiveDowntimeBlock();
    if (!block || block.id !== String(blockId)) {
      const cancelled = loadDowntimeWorkflowStore().history.find(
        (entry) => entry.id === String(blockId) && entry.state === "cancelled",
      );
      if (cancelled) return cancelled;
      throw new Error("Block not found.");
    }
    if (!["collecting", "locked", "planned"].includes(block.state)) {
      throw new Error(
        "An applying or review block cannot be cancelled safely.",
      );
    }
    const cancelled = await cancelDowntimeBlock(block.id, {
      reason: "Cancelled by the GM without advancing campaign time.",
      at: now(),
    });
    notifyServiceChanged("block-cancel");
    await broadcastCompletedState(cancelled);
    return cancelled;
  });
}

export async function getWorkspaceProjection({ settlementId = "" } = {}) {
  assertAuthority();
  const config = loadDowntimeConfig();
  const store = loadDowntimeWorkflowStore();
  const active = store.activeBlock;
  const factions = loadFactions();
  const merchants = loadMerchants();
  const selected =
    config.settlements.find((entry) => entry.id === settlementId) ??
    config.settlements[0] ??
    null;
  const projectProgress = guidedProjectProgressFromStore(store);
  return {
    workflowStatus: active?.state ?? "idle",
    workflow: active ? projectWorkspaceBlock(active) : null,
    settlements: config.settlements.map(projectSettlementForWorkspace),
    guidedTemplates: config.guidedTemplates.map((template) => ({
      id: template.id,
      name: template.name,
      description: template.description,
      image: template.image,
    })),
    guidedProjects: config.guidedProjects.map((project) => {
      const progressHours = projectProgressHours(projectProgress, project.id);
      const requiredHours = project.requiredHours;
      return {
        ...projectGuidedDowntimeProject(project),
        progressHours,
        remainingHours: Math.max(0, requiredHours - progressHours),
        complete: progressHours >= requiredHours,
        progressLabel: `${Math.min(progressHours, requiredHours)} / ${requiredHours} hours`,
      };
    }),
    selectedSettlement: selected
      ? projectSettlementForWorkspace(selected)
      : null,
    selectedSettlementId: selected?.id ?? "",
    actors: actorsArray()
      .filter((actor) => actor?.type === "character")
      .map(projectWorkspaceActor),
    factions: factions.map((faction) => ({
      id: faction.id,
      name: faction.name,
    })),
    merchants: merchants.map((merchant) => ({
      id: merchant.id,
      name: merchant.name,
    })),
    history: store.history.map((block) => ({
      id: block.id,
      status: block.state,
      settlementName: block.settlementName,
      locationName: block.locationName ?? block.settlementName,
      hasSettlement: block.hasSettlement !== false,
      hours: block.budgetHours,
      characterCount: block.participants?.length ?? 0,
      completedAt: block.completedAt,
      cancelledAt: block.cancelledAt,
      updatedAt: block.updatedAt,
      summary: block.result?.summary ?? block.reason ?? "",
    })),
    recovery: ["applying", "needs-review"].includes(active?.state)
      ? {
          available: true,
          message:
            active.state === "needs-review"
              ? active.reason
              : "Application was interrupted. Verify saved operations before retrying.",
        }
      : null,
    canCreateBlock: !active,
  };
}

function projectSettlementForWorkspace(settlement) {
  return {
    id: settlement.id,
    name: settlement.name,
    wealthTier: settlement.wealthTier,
    securityTier: settlement.securityTier,
    marketDc: settlement.marketDc,
    factionId: settlement.linkedFactionId,
    linkedFactionId: settlement.linkedFactionId,
    merchantIds: [...settlement.linkedMerchantIds],
    linkedMerchantIds: [...settlement.linkedMerchantIds],
    enabledActivities: [...settlement.enabledActivityIds],
    enabledActivityIds: [...settlement.enabledActivityIds],
  };
}

function projectWorkspaceBlock(block) {
  const byActor = new Map(
    (block.plan?.characters ?? []).map((character) => [
      character.actorId,
      character,
    ]),
  );
  const planningNeedsReview =
    block.state === "locked" && block.planningDraft?.state === "needs-review";
  return {
    ...block,
    guided: block.mode === GUIDED_DOWNTIME_MODE,
    status: block.state,
    participants: (block.participants ?? []).map((participant) => {
      const plan = byActor.get(participant.actorId);
      return {
        actorId: participant.actorId,
        name: participant.actorName,
        img: participant.actorImg,
        submitted: participant.submitted,
        budgetHours: block.budgetHours,
        usedHours: sumHours(participant.queue),
        queue:
          block.mode === GUIDED_DOWNTIME_MODE
            ? decorateGuidedQueue(
                participant.queue,
                block.guidedTemplates,
                block.guidedProjects,
              )
            : decorateQueue(participant.queue),
        resultStatus: plan ? block.state : "",
        receipt:
          block.result?.playerReceipts?.[participant.actorId]?.summary ?? "",
      };
    }),
    plan: block.plan
      ? {
          ...block.plan,
          characters: (block.plan.characters ?? []).map((character) => ({
            actorId: character.actorId,
            name: character.actorName,
            status: block.state,
            operations: character.operations.map((operation) => ({
              id: operation.operationId,
              label: operation.activityLabel,
              hours: operation.hours,
              rollLabel: operation.check
                ? operation.mode === GUIDED_DOWNTIME_MODE
                  ? `${guidedDowntimeSkillLabel(operation.check.skill)} roll: ${operation.check.total}`
                  : `${operation.check.total} vs DC ${operation.check.dc}`
                : "",
              outcome: operation.summary,
              report: operation.report ?? "",
              tone: operation.check?.outcomeTier ?? "neutral",
              outcomeOptions:
                block.mode === GUIDED_DOWNTIME_MODE
                  ? (
                      guidedActivityById(
                        block.guidedTemplates,
                        block.guidedProjects,
                        operation.activityId,
                      )?.outcomes ?? []
                    ).map((outcome, index) => ({
                      index,
                      label: outcome.label,
                      report: outcome.report,
                      rewardLabel: operation.project
                        ? `${operation.project.contributedHours}h project work`
                        : outcome.rewardGp > 0
                          ? `${outcome.rewardGp} gp`
                          : "No currency",
                      selected: index === operation.selectedOutcomeIndex,
                    }))
                  : [],
            })),
          })),
        }
      : null,
    canLock: block.state === "collecting",
    canPlan: block.state === "locked" && !planningNeedsReview,
    planReason: planningNeedsReview
      ? block.planningDraft.reviewReason ||
        "A hidden roll was interrupted. Cancel this block; it cannot reroll that check."
      : "",
    canApply: block.state === "planned",
    canCancel: ["collecting", "locked", "planned"].includes(block.state),
    canRecover: ["applying", "needs-review"].includes(block.state),
    canOpenForPlayers: block.state === "collecting",
  };
}

export async function getPlayerProjectionForUser({
  userId,
  actorId = "",
} = {}) {
  const user =
    userById(userId) ??
    (String(globalThis.game?.user?.id) === String(userId)
      ? globalThis.game?.user
      : null);
  if (!user) return emptyPlayerProjection({ noGm: false });
  const config = loadDowntimeConfig();
  const store = loadDowntimeWorkflowStore();
  const active = store.activeBlock;
  if (!active) {
    const receipt = latestReceiptForUser(store.history, user, actorId);
    return {
      ...emptyPlayerProjection({ noGm: false }),
      status: receipt ? "completed" : "idle",
      receipt,
      completionMessage: receipt?.summary ?? "",
    };
  }
  const eligible = (active.participants ?? []).filter((participant) => {
    const actor = actorById(participant.actorId);
    return actor && userOwnsDowntimeActor(user, actor);
  });
  if (eligible.length === 0) {
    return {
      ...emptyPlayerProjection({ noGm: false }),
      status: active.state,
      hasActiveBlock: true,
      settlementName: active.settlementName,
      locationName: active.locationName ?? active.settlementName,
      hasSettlement: active.hasSettlement !== false,
      blockId: active.id,
    };
  }
  const selected =
    eligible.find((participant) => participant.actorId === actorId) ??
    eligible[0];
  const actor = actorById(selected.actorId);
  if (active.mode === GUIDED_DOWNTIME_MODE) {
    const queue = selected.queue ?? [];
    const projectProgress = guidedProjectProgressFromStore(store);
    return {
      status: active.state,
      mode: GUIDED_DOWNTIME_MODE,
      hasActiveBlock: true,
      settlementName: active.locationName,
      locationName: active.locationName,
      hasSettlement: false,
      blockId: active.id,
      actors: eligible.map((participant) => ({
        id: participant.actorId,
        name: participant.actorName,
        img: actorById(participant.actorId)?.img ?? participant.actorImg,
        eligible: true,
      })),
      budgetHours: active.budgetHours,
      usedHours: sumHours(queue),
      remainingHours: Math.max(0, active.budgetHours - sumHours(queue)),
      activities: [
        ...active.guidedTemplates.map((template) =>
          projectGuidedActivity(template, active.budgetHours),
        ),
        ...(active.guidedProjects ?? []).map((project) =>
          projectGuidedActivity(
            { ...project, kind: "project" },
            active.budgetHours,
            projectProgressHours(projectProgress, project.id),
          ),
        ),
      ],
      queue: decorateGuidedQueue(
        queue,
        active.guidedTemplates,
        active.guidedProjects,
      ),
      rawQueue: queue,
      submitted: selected.submitted === true,
      canSubmit: active.state === "collecting" && selected.submitted !== true,
      canRecall: active.state === "collecting" && selected.submitted === true,
      needsRecovery: active.state === "needs-review",
      receipt: active.result?.playerReceipts?.[selected.actorId] ?? null,
    };
  }
  const settlement = settlementForBlock(active, config);
  const context = await buildActorDowntimeContext({
    block: active,
    actor,
    settlement,
    config,
    queue: selected.queue ?? [],
  });
  const queue = selected.queue ?? [];
  const usedHours = sumHours(queue);
  return {
    status: active.state,
    hasActiveBlock: true,
    settlementName: active.settlementName,
    locationName: active.locationName ?? active.settlementName,
    hasSettlement: active.hasSettlement !== false,
    blockId: active.id,
    actors: eligible.map((participant) => {
      const participantActor = actorById(participant.actorId);
      return {
        id: participant.actorId,
        name: participant.actorName,
        img: participantActor?.img ?? participant.actorImg,
        eligible: true,
      };
    }),
    heat: context.heat,
    budgetHours: active.budgetHours,
    usedHours,
    remainingHours: Math.max(0, active.budgetHours - usedHours),
    activities: context.playerActivities,
    queue: decorateQueue(queue),
    rawQueue: queue,
    submitted: selected.submitted === true,
    canSubmit:
      active.state === "collecting" &&
      selected.submitted !== true &&
      usedHours <= active.budgetHours,
    canRecall: active.state === "collecting" && selected.submitted === true,
    needsRecovery: active.state === "needs-review",
    recoveryMessage:
      active.state === "needs-review"
        ? "The GM is reconciling an interrupted application. Your saved submission is unchanged."
        : "",
    receipt: active.result?.playerReceipts?.[selected.actorId] ?? null,
  };
}

function emptyPlayerProjection({ noGm }) {
  return {
    status: "idle",
    hasActiveBlock: false,
    hasSettlement: false,
    noGm,
    actors: [],
    activities: [],
    queue: [],
    budgetHours: 0,
    usedHours: 0,
    remainingHours: 0,
    heat: 0,
  };
}

async function handleSnapshotRequest(payload) {
  if (!isAuthoritativeGM()) return;
  const projection = await getPlayerProjectionForUser({
    userId: payload.originUserId,
    actorId: payload.actorId,
  });
  emitDowntimeEvent(DOWNTIME_EVENTS.SNAPSHOT_REPLY, {
    targetUserId: payload.originUserId,
    requestId: payload.requestId,
    projection,
  });
}

async function handleQueueRequest(payload) {
  if (!isAuthoritativeGM()) return;
  let result;
  try {
    const block = await submitQueueAuthoritatively({
      userId: payload.originUserId,
      requestId: payload.requestId,
      blockId: payload.blockId,
      actorId: payload.actorId,
      queue: payload.queue,
    });
    result = {
      ok: true,
      projection: await getPlayerProjectionForUser({
        userId: payload.originUserId,
        actorId: payload.actorId,
      }),
      blockRevision: block.updatedAt,
    };
  } catch (error) {
    result = {
      ok: false,
      reason: String(error?.message ?? "Submission failed."),
    };
  }
  emitDowntimeEvent(DOWNTIME_EVENTS.SUBMIT_RESULT, {
    targetUserId: payload.originUserId,
    requestId: payload.requestId,
    ...result,
  });
}

async function handleRecallRequest(payload) {
  if (!isAuthoritativeGM()) return;
  let result;
  try {
    await recallSubmissionAuthoritatively({
      userId: payload.originUserId,
      requestId: payload.requestId,
      blockId: payload.blockId,
      actorId: payload.actorId,
    });
    result = {
      ok: true,
      projection: await getPlayerProjectionForUser({
        userId: payload.originUserId,
        actorId: payload.actorId,
      }),
    };
  } catch (error) {
    result = { ok: false, reason: String(error?.message ?? "Recall failed.") };
  }
  emitDowntimeEvent(DOWNTIME_EVENTS.SUBMIT_RESULT, {
    targetUserId: payload.originUserId,
    requestId: payload.requestId,
    ...result,
  });
}

export async function submitQueueAuthoritatively({
  userId,
  requestId,
  blockId,
  actorId,
  queue,
}) {
  return runServiceMutation(async () => {
    assertAuthority();
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const revision = getDowntimeWorkflowRevision();
      const block = getActiveDowntimeBlock();
      if (
        !block ||
        block.id !== String(blockId) ||
        block.state !== "collecting"
      ) {
        throw new Error("Downtime submissions are closed.");
      }
      const actor = actorById(actorId);
      const user = userById(userId);
      const participant = participantFor(block, actorId);
      if (!actor || !participant || !userOwnsDowntimeActor(user, actor)) {
        throw new Error("You do not own that eligible character.");
      }
      if (block.mode === GUIDED_DOWNTIME_MODE) {
        return submitGuidedDowntimeChoice({
          block,
          actor,
          userId,
          requestId,
          queue,
          revision,
        });
      }
      const canonical = canonicalizeDowntimeQueueSubmission(queue);
      if (!canonical.ok) {
        throw new Error(
          `Queue rejected: ${canonical.errors[0]?.code ?? "invalid queue"}.`,
        );
      }
      const normalized = canonical.queue;
      const digest = queueDigest(normalized);
      const prior = block.requests?.[requestId];
      if (prior) {
        if (
          prior.kind !== "submit" ||
          prior.digest !== digest ||
          prior.actorId !== actor.id ||
          prior.userId !== user.id
        ) {
          throw new Error(
            "That request ID was already used for another submission.",
          );
        }
        return block;
      }
      const config = loadDowntimeConfig();
      const settlement = settlementForBlock(block, config);
      const context = await buildActorDowntimeContext({
        block,
        actor,
        settlement,
        config,
        queue: normalized,
      });
      const validation = validateDowntimeQueue(normalized, {
        budgetHours: block.budgetHours,
        settlement,
        startingHeat: context.heat,
        targetFacts: context.targetFacts,
        allowedTargetIds: context.allowedTargetIds,
        existingSharpenedWeaponIds: context.existingSharpenedWeaponIds,
      });
      if (!validation.ok) {
        throw new Error(
          `Queue rejected: ${validation.errors[0]?.code ?? "invalid queue"}.`,
        );
      }
      const prerequisites = validateDowntimeServicePrerequisites(
        validation.normalizedQueue,
        { actor, context },
      );
      if (!prerequisites.ok) {
        throw new Error(
          `Queue rejected: ${prerequisites.errors[0]?.code ?? "prerequisite missing"}.`,
        );
      }
      const participants = block.participants.map((entry) =>
        entry.actorId === actor.id
          ? {
              ...entry,
              queue: validation.normalizedQueue,
              submitted: true,
              submittedAt: now(),
              submittedBy: userId,
            }
          : entry,
      );
      try {
        const updated = await updateCollectingDowntimeBlock(
          block.id,
          {
            participants,
            requests: boundedRequests(block.requests, requestId, {
              actorId: actor.id,
              userId,
              digest,
              kind: "submit",
              at: now(),
            }),
          },
          { expectedRevision: revision },
        );
        notifyServiceChanged("queue-submit");
        await broadcastPlayerState(updated);
        return updated;
      } catch (error) {
        if (
          String(error?.message) === "DowntimeWorkflowRevisionMismatch" &&
          attempt < 2
        ) {
          continue;
        }
        throw error;
      }
    }
    throw new Error("The queue changed concurrently; refresh and retry.");
  });
}

async function submitGuidedDowntimeChoice({
  block,
  actor,
  userId,
  requestId,
  queue,
  revision,
}) {
  const source = Array.isArray(queue) ? queue : [];
  if (source.length !== 1) {
    throw new Error("Choose exactly one activity for this downtime block.");
  }
  const entry = source[0] ?? {};
  const selection = normalizeGuidedActivitySelection(
    {
      templateId: entry.activityId,
      skill: entry.skill,
    },
    block.guidedTemplates,
    block.guidedProjects,
  );
  if (!selection || Number(entry.hours) !== Number(block.budgetHours)) {
    throw new Error(
      "Choose one available activity and use the assigned downtime.",
    );
  }
  const guidedRoll = selection.skill
    ? normalizeGuidedPlayerRoll(entry.guidedRoll)
    : { ok: true, total: 0, formula: "" };
  if (!guidedRoll.ok) {
    throw new Error("Roll the selected downtime check before submitting.");
  }
  const digest = queueDigest([
    {
      id: "guided-choice",
      activityId: selection.templateId,
      hours: block.budgetHours,
      skill: selection.skill,
      guidedRoll: selection.skill
        ? { total: guidedRoll.total, formula: guidedRoll.formula }
        : undefined,
    },
  ]);
  const prior = block.requests?.[requestId];
  if (prior) {
    if (
      prior.kind !== "submit" ||
      prior.digest !== digest ||
      prior.actorId !== actor.id ||
      prior.userId !== userId
    ) {
      throw new Error(
        "That request ID was already used for another submission.",
      );
    }
    return block;
  }
  const activity = guidedActivityById(
    block.guidedTemplates,
    block.guidedProjects,
    selection.templateId,
  );
  const participants = block.participants.map((entry) =>
    entry.actorId === actor.id
      ? {
          ...entry,
          guidedSelection: selection,
          guidedRoll: selection.skill
            ? { total: guidedRoll.total, formula: guidedRoll.formula }
            : null,
          queue: [
            {
              id: "guided-choice",
              activityId: activity.id,
              hours: block.budgetHours,
              skill: selection.skill,
              guidedRoll: selection.skill
                ? { total: guidedRoll.total, formula: guidedRoll.formula }
                : undefined,
            },
          ],
          submitted: true,
          submittedAt: now(),
          submittedBy: userId,
        }
      : entry,
  );
  const updated = await updateCollectingDowntimeBlock(
    block.id,
    {
      participants,
      requests: boundedRequests(block.requests, requestId, {
        actorId: actor.id,
        userId,
        digest,
        kind: "submit",
        at: now(),
      }),
    },
    { expectedRevision: revision },
  );
  notifyServiceChanged("guided-choice-submit");
  await broadcastPlayerState(updated);
  return updated;
}

export async function recallSubmissionAuthoritatively({
  userId,
  requestId,
  blockId,
  actorId,
}) {
  return runServiceMutation(async () => {
    assertAuthority();
    const revision = getDowntimeWorkflowRevision();
    const block = getActiveDowntimeBlock();
    if (
      !block ||
      block.id !== String(blockId) ||
      block.state !== "collecting"
    ) {
      throw new Error("Downtime submissions are closed.");
    }
    const actor = actorById(actorId);
    const user = userById(userId);
    const participant = participantFor(block, actorId);
    if (!actor || !participant || !userOwnsDowntimeActor(user, actor)) {
      throw new Error("You do not own that eligible character.");
    }
    const prior = block.requests?.[requestId];
    if (prior) {
      if (
        prior.kind !== "recall" ||
        prior.digest !== "recall" ||
        prior.actorId !== actor.id ||
        prior.userId !== user.id
      ) {
        throw new Error(
          "That request ID was already used for another request.",
        );
      }
      return block;
    }
    const participants = block.participants.map((entry) =>
      entry.actorId === actor.id
        ? {
            ...entry,
            submitted: false,
            submittedAt: 0,
            submittedBy: null,
          }
        : entry,
    );
    const updated = await updateCollectingDowntimeBlock(
      block.id,
      {
        participants,
        requests: boundedRequests(block.requests, requestId, {
          actorId: actor.id,
          userId,
          digest: "recall",
          kind: "recall",
          at: now(),
        }),
      },
      { expectedRevision: revision },
    );
    notifyServiceChanged("queue-recall");
    await broadcastPlayerState(updated);
    return updated;
  });
}

function registerSharpeningLifecycleAuthorityHooks() {
  if (
    sharpeningLifecycleAuthorityHooksRegistered ||
    typeof globalThis.Hooks?.on !== "function"
  ) {
    return;
  }
  sharpeningLifecycleAuthorityHooksRegistered = true;
  for (const event of ["updateUser", "userConnected"]) {
    globalThis.Hooks.on(event, () => {
      if (!isAuthoritativeGM()) return;
      void ensureDowntimeWorkflowAuthority()
        .then(() => scheduleSharpeningLifecycleReconciliation(0))
        .catch((error) => {
          console.warn(
            `${MODULE_ID} | sharpening lifecycle authority reconciliation`,
            error,
          );
          if (isAuthoritativeGM()) {
            scheduleSharpeningLifecycleReconciliation();
          }
        });
    });
  }
}

function scheduleSharpeningLifecycleReconciliation(delay = 5_000) {
  if (
    !isAuthoritativeGM() ||
    sharpeningLifecycleRetryTimer !== null ||
    typeof globalThis.setTimeout !== "function"
  ) {
    return;
  }
  sharpeningLifecycleRetryTimer = globalThis.setTimeout(
    () => {
      sharpeningLifecycleRetryTimer = null;
      void runServiceMutation(() =>
        reconcileSharpeningLifecycleQueueInternal(),
      ).catch((error) => {
        console.warn(`${MODULE_ID} | sharpening lifecycle retry`, error);
        scheduleSharpeningLifecycleReconciliation();
      });
    },
    Math.max(0, Number(delay) || 0),
  );
  sharpeningLifecycleRetryTimer?.unref?.();
}

function lifecycleEventFromPayload(payload, kind) {
  return {
    eventId: String(payload.eventId ?? ""),
    kind,
    actorId: String(payload.actorId ?? ""),
    itemId: String(payload.itemId ?? ""),
    effectId: String(payload.effectId ?? ""),
    operationId: String(payload.operationId ?? ""),
    rollId: kind === "damage" ? String(payload.rollId ?? "") : null,
    originUserId: String(payload.originUserId ?? ""),
    acceptedAt: now(),
    attempts: 0,
    lastAttemptAt: 0,
    lastError: null,
  };
}

async function applySharpeningLifecycleEvent(
  event,
  { authorizeWrite = hasCurrentDowntimeWriteAuthority } = {},
) {
  const actor = actorById(event.actorId);
  const user = userById(event.originUserId);
  if (!actor || !user || !userOwnsDowntimeActor(user, actor)) {
    return { ok: true, outcome: "discarded-invalid-owner" };
  }
  if (event.kind === "long-rest") {
    const result = await runWithActorMutex(actor.id, () =>
      clearSharpeningOnLongRest(actor, {
        authorizeWrite,
        references: [event],
      }),
    );
    return result.ok
      ? { ok: true, outcome: result.removed ? "removed" : "already-absent" }
      : result;
  }
  const item = findActorItem(actor, event.itemId);
  if (!item || !hasSharpening(item)) {
    return { ok: true, outcome: "already-absent" };
  }
  const result = await runWithActorMutex(actor.id, () =>
    consumeSharpeningCharge(item, event.rollId, {
      authorizeWrite,
      effectId: event.effectId,
      operationId: event.operationId,
    }),
  );
  return result.ok
    ? {
        ok: true,
        outcome: result.consumed ? "consumed" : result.reason || "duplicate",
      }
    : result;
}

async function persistSharpeningLifecycleEvent(payload, kind) {
  assertAuthority();
  const authorizeWrite = captureDowntimeAuthorityEpochGuard();
  const actor = actorById(payload.actorId);
  const user = userById(payload.originUserId);
  if (!actor || !userOwnsDowntimeActor(user, actor)) return false;
  const event = lifecycleEventFromPayload(payload, kind);
  let queueStatus = null;
  const config = await updateDowntimeConfig((current) => {
    if (!authorizeWrite()) throw new Error("authority-lost");
    const queued = enqueueSharpeningLifecycleEvent(
      current.sharpeningLifecycle,
      event,
    );
    queueStatus = queued.status;
    return queued.status === "queued"
      ? { ...current, sharpeningLifecycle: queued.state }
      : current;
  });
  if (queueStatus === "completed") {
    emitSharpeningLifecycleAck(event.originUserId, event.eventId);
    return true;
  }
  await reconcileSharpeningLifecycleQueueInternal(config, authorizeWrite);
  return true;
}

async function reconcileSharpeningLifecycleQueueInternal(
  initialConfig = null,
  authorizeWrite = captureDowntimeAuthorityEpochGuard(),
) {
  if (!isAuthoritativeGM()) return { ok: false, reason: "authority-lost" };
  let config = initialConfig ?? loadDowntimeConfig();
  const pending = [...(config.sharpeningLifecycle?.pending ?? [])];
  let failed = 0;
  let completed = 0;
  for (const event of pending) {
    if (!authorizeWrite()) {
      if (isAuthoritativeGM()) scheduleSharpeningLifecycleReconciliation();
      return { ok: false, reason: "authority-lost", completed, failed };
    }
    const result = await applySharpeningLifecycleEvent(event, {
      authorizeWrite,
    });
    if (!authorizeWrite()) {
      if (isAuthoritativeGM()) scheduleSharpeningLifecycleReconciliation();
      return { ok: false, reason: "authority-lost", completed, failed };
    }
    try {
      config = await updateDowntimeConfig((current) => {
        if (!authorizeWrite()) throw new Error("authority-lost");
        const lifecycle = result.ok
          ? completeSharpeningLifecycleEvent(
              current.sharpeningLifecycle,
              event.eventId,
              { at: now(), outcome: result.outcome },
            )
          : failSharpeningLifecycleEvent(
              current.sharpeningLifecycle,
              event.eventId,
              { at: now(), reason: result.reason },
            );
        return { ...current, sharpeningLifecycle: lifecycle };
      });
    } catch (error) {
      if (authorizeWrite()) scheduleSharpeningLifecycleReconciliation();
      throw error;
    }
    if (result.ok) {
      completed += 1;
      if (
        config.sharpeningLifecycle?.completed?.some(
          (entry) => entry.eventId === event.eventId,
        )
      ) {
        emitSharpeningLifecycleAck(event.originUserId, event.eventId);
      }
    } else {
      failed += 1;
      scheduleSharpeningLifecycleReconciliation();
    }
  }
  if (
    config.sharpeningLifecycle?.pending?.length === 0 &&
    sharpeningLifecycleRetryTimer !== null
  ) {
    globalThis.clearTimeout?.(sharpeningLifecycleRetryTimer);
    sharpeningLifecycleRetryTimer = null;
  }
  return { ok: failed === 0, completed, failed };
}

export function reconcileSharpeningLifecycleQueue() {
  return runServiceMutation(() => reconcileSharpeningLifecycleQueueInternal());
}

export function recordSharpeningLifecycleEventAuthoritatively(payload, kind) {
  if (!["damage", "long-rest"].includes(kind)) {
    return Promise.reject(new Error("DowntimeSharpeningLifecycleKindInvalid"));
  }
  return runServiceMutation(() =>
    persistSharpeningLifecycleEvent(payload, kind),
  );
}

async function handleSharpenDamage(payload) {
  if (!isAuthoritativeGM()) return;
  return recordSharpeningLifecycleEventAuthoritatively(payload, "damage");
}

async function handleLongRest(payload) {
  if (!isAuthoritativeGM()) return;
  return recordSharpeningLifecycleEventAuthoritatively(payload, "long-rest");
}

async function broadcastPlayerState(block = getActiveDowntimeBlock()) {
  if (!isAuthoritativeGM() || !block) return;
  const sent = new Set();
  for (const participant of block.participants ?? []) {
    for (const userId of participant.userIds ?? []) {
      if (
        sent.has(userId) ||
        !userOwnsDowntimeActor(userById(userId), actorById(participant.actorId))
      ) {
        continue;
      }
      sent.add(userId);
      const projection = await getPlayerProjectionForUser({
        userId,
        actorId: participant.actorId,
      });
      emitDowntimeEvent(DOWNTIME_EVENTS.STATE_UPDATE, {
        targetUserId: userId,
        projection,
      });
    }
  }
}

async function broadcastCompletedState(completed) {
  if (!isAuthoritativeGM() || !completed) return;
  const sent = new Set();
  for (const participant of completed.participants ?? []) {
    for (const userId of participant.userIds ?? []) {
      if (
        sent.has(userId) ||
        !userOwnsDowntimeActor(userById(userId), actorById(participant.actorId))
      ) {
        continue;
      }
      sent.add(userId);
      const receipt =
        completed.result?.playerReceipts?.[participant.actorId] ?? null;
      emitDowntimeEvent(DOWNTIME_EVENTS.STATE_UPDATE, {
        targetUserId: userId,
        projection: {
          ...emptyPlayerProjection({ noGm: false }),
          status: completed.state,
          settlementName: completed.settlementName,
          locationName: completed.locationName ?? completed.settlementName,
          hasSettlement: completed.hasSettlement !== false,
          receipt,
          completionMessage: receipt?.summary ?? completed.reason ?? "",
        },
      });
    }
  }
}

function latestReceiptForUser(history, user, actorId) {
  const blocks = [...(history ?? [])].reverse();
  for (const block of blocks) {
    if (block.state !== "completed") continue;
    const participants = block.participants ?? [];
    const candidates = actorId
      ? participants.filter((entry) => entry.actorId === actorId)
      : participants;
    for (const participant of candidates) {
      const actor = actorById(participant.actorId);
      if (!actor || !userOwnsDowntimeActor(user, actor)) continue;
      const receipt = block.result?.playerReceipts?.[participant.actorId];
      if (receipt) return receipt;
    }
  }
  return null;
}

function buildCompletedResult(block) {
  const completedAt = now();
  const playerReceipts = {};
  for (const character of block.plan?.characters ?? []) {
    const activities = character.operations.map((operation) => ({
      id: operation.operationId,
      label: operation.activityLabel ?? "Activity",
      summary: operation.summary,
      tone: operation.check?.outcomeTier ?? "neutral",
      image: operation.activityImage ?? "",
      report: operation.report ?? "",
      rewardLabel: operation.project
        ? `${operation.project.contributedHours} hours contributed to ${operation.project.name}.`
        : Number(operation.currencyDeltaCp) > 0
          ? `${formatCp(operation.currencyDeltaCp)} added to your character.`
          : "No currency was added.",
    }));
    playerReceipts[character.actorId] = {
      settlementName: block.settlementName,
      completedAt,
      activities,
      summary:
        block.mode === GUIDED_DOWNTIME_MODE
          ? "Your GM has delivered your downtime report. Campaign time was not advanced."
          : `${activities.length} downtime ${activities.length === 1 ? "activity" : "activities"} resolved without advancing campaign time.`,
    };
  }
  return {
    completedAt,
    playerReceipts,
    summary: `${Object.keys(playerReceipts).length} character ${Object.keys(playerReceipts).length === 1 ? "queue" : "queues"} resolved. Campaign time was not advanced.`,
  };
}

function projectGuidedActivity(activity, hours, progressHours = 0) {
  const project = activity.kind === "project";
  return {
    id: activity.id,
    label: activity.name,
    description: project
      ? `${activity.description || "Long-term project."} ${Math.min(progressHours, activity.requiredHours)} / ${activity.requiredHours} hours complete.`
      : activity.description,
    category: project ? "project" : "guided",
    icon: "fa-solid fa-compass",
    available: true,
    fixedHours: hours,
    skills: activity.skills.map((skill) => ({
      id: skill,
      label: guidedDowntimeSkillLabel(skill),
      selected: false,
    })),
    hasSkills: activity.skills.length > 0,
    image: activity.image,
    project,
  };
}

function decorateGuidedQueue(queue, templates, projects = []) {
  return (queue ?? []).map((entry) => {
    const activity = guidedActivityById(templates, projects, entry.activityId);
    return {
      ...entry,
      label: activity?.name ?? "Activity",
      icon: "fa-solid fa-compass",
      detail: [
        activity?.kind === "project" ? "Project work" : "",
        entry.skill ? guidedDowntimeSkillLabel(entry.skill) : "",
      ]
        .filter(Boolean)
        .join(" · "),
    };
  });
}

function sumHours(queue) {
  return (queue ?? []).reduce(
    (sum, entry) => sum + Math.max(0, Number(entry.hours) || 0),
    0,
  );
}

function decorateQueue(queue) {
  return (queue ?? []).map((entry) => {
    const activity = getDowntimeActivity(entry.activityId);
    const details = [];
    if (entry.skill) details.push(title(entry.skill));
    if (Number(entry.stakeCp) > 0) details.push(formatCp(entry.stakeCp));
    if (entry.targetId) details.push(`Target: ${entry.targetId}`);
    return {
      ...entry,
      label: activity?.label ?? entry.activityId,
      icon: activityIcon(entry.activityId),
      detail: details.join(" · "),
    };
  });
}

function operationSummary(operation) {
  if (operation.reason === "heat-max" || operation.status === "blocked") {
    return "Crime attempt blocked because Heat reached 5; the assigned time was spent.";
  }
  const tier = title(operation.check?.outcomeTier ?? "");
  switch (operation.activityId) {
    case DOWNTIME_ACTIVITY_IDS.CRAFT_AMMUNITION:
      return `Crafted 20 ${operation.itemName ?? "ammunition"}.`;
    case DOWNTIME_ACTIVITY_IDS.SHARPEN_WEAPON:
      return `${operation.weaponName ?? "Weapon"} gains +1 damage for its next three damage rolls or until the next long rest.`;
    case DOWNTIME_ACTIVITY_IDS.MARKET_TRADING: {
      const delta = Number(operation.currencyDeltaCp) || 0;
      return delta > 0
        ? `${tier}: earned ${formatCp(delta)} from the trading stake.`
        : delta < 0
          ? `${tier}: lost ${formatCp(-delta)} from the trading stake.`
          : `${tier}: the trading stake broke even.`;
    }
    case DOWNTIME_ACTIVITY_IDS.PICKPOCKET:
      return operation.stolenItemSnapshot
        ? `${tier}: took ${operation.stolenItemSnapshot.name}. Heat ${operation.heatBefore} → ${operation.heatAfter}.`
        : `${tier}: nothing was taken. Heat ${operation.heatBefore} → ${operation.heatAfter}.`;
    case DOWNTIME_ACTIVITY_IDS.SHOPLIFT:
      return operation.stolenItemSnapshot
        ? `${tier}: took one ${operation.itemName} from ${operation.merchantName}. Heat ${operation.heatBefore} → ${operation.heatAfter}.`
        : `${tier}: no stock was taken. Heat ${operation.heatBefore} → ${operation.heatAfter}.`;
    case DOWNTIME_ACTIVITY_IDS.FENCE_STOLEN_GOODS:
      return operation.goodsTransferred
        ? `${tier}: fenced the bundle for ${formatCp(operation.payoutCp)}. Heat ${operation.heatBefore} → ${operation.heatAfter}.`
        : `${tier}: the goods were retained with no payout. Heat ${operation.heatBefore} → ${operation.heatAfter}.`;
    case DOWNTIME_ACTIVITY_IDS.LAY_LOW:
      return `Laid low. Heat ${operation.heatBefore} → ${operation.heatAfter}.`;
    default:
      return "Activity resolved.";
  }
}

function activityIcon(activityId) {
  return (
    {
      [DOWNTIME_ACTIVITY_IDS.CRAFT_AMMUNITION]: "fa-solid fa-feather-pointed",
      [DOWNTIME_ACTIVITY_IDS.SHARPEN_WEAPON]: "fa-solid fa-khanda",
      [DOWNTIME_ACTIVITY_IDS.MARKET_TRADING]: "fa-solid fa-scale-balanced",
      [DOWNTIME_ACTIVITY_IDS.PICKPOCKET]: "fa-solid fa-hand",
      [DOWNTIME_ACTIVITY_IDS.SHOPLIFT]: "fa-solid fa-mask-face",
      [DOWNTIME_ACTIVITY_IDS.FENCE_STOLEN_GOODS]: "fa-solid fa-sack-dollar",
      [DOWNTIME_ACTIVITY_IDS.LAY_LOW]: "fa-solid fa-user-secret",
    }[activityId] ?? "fa-solid fa-hourglass"
  );
}

function formatCp(cp) {
  const value = Math.max(0, Number(cp) || 0) / 100;
  return `${value.toFixed(value % 1 === 0 ? 0 : 2)} gp`;
}

function title(value) {
  return String(value ?? "")
    .split("-")
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

export const downtimeWorkspaceAdapter = Object.freeze({
  subscribe: subscribeDowntimeService,
  getWorkspaceProjection,
  createBlock: openDowntimeBlock,
  openForPlayers: ({ blockId }) => openBlockForPlayers(blockId),
  lockBlock: ({ blockId }) => lockActiveDowntimeBlock(blockId),
  planBlock: ({ blockId }) => planActiveDowntimeBlock(blockId),
  chooseGuidedOutcome: (payload) => chooseGuidedDowntimeOutcome(payload),
  applyBlock: ({ blockId }) => applyActiveDowntimeBlock(blockId),
  cancelBlock: ({ blockId }) => cancelActiveDowntimeBlock(blockId),
  recoverBlock: ({ blockId }) => recoverActiveDowntimeBlock(blockId),
  saveSettlement: saveSettlementProfile,
  deleteSettlement: ({ settlementId }) => deleteSettlementProfile(settlementId),
  saveGuidedProject: saveGuidedDowntimeProject,
});
