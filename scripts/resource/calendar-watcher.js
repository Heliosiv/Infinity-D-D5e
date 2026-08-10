/**
 * Infinity D&D5e — Resource calendar watcher (GM-authoritative orchestrator)
 *
 * Detects whole in-game day rollover (Simple Calendar / Reborn when present,
 * else core world time), then runs the daily upkeep: prompt each player to
 * forage (Survival), deposit the gathered food/water, consume the day's
 * supplies off every character, and report shortfalls + suggested exhaustion.
 *
 * All decisions defer to the pure modules in this folder; this file is the only
 * Foundry-touching glue (Hooks, Roll, ChatMessage, actor writes). Everything
 * here runs only on the authoritative GM.
 */

import {
  computeAbsoluteDay,
  diffDays,
  clampElapsedForUpkeep,
  resolveSecondsPerDay,
} from "./calendar.js";
import {
  loadResourceConfig,
  loadRunState,
  resolveDrawSourceId,
  assertUpkeepClaimCurrent,
  claimUpkeepRun,
  completeUpkeepRun,
  setLastSeenDay,
} from "./store.js";
import { findEnvironment, isForageable } from "./environment.js";
import {
  buildForageRunReceipt,
  buildRunActorSnapshots,
  buildUpkeepRunReceipt,
} from "./history.js";
import {
  aggregateForageAssignments,
  buildForageAcknowledgement,
  computeForageYield,
  combineYields,
  forageTargetChannels,
  FORAGE_TARGETS,
  normalizeForagerAssignments,
  planForageDriveDeposits,
} from "./forage.js";
import { getWisMod, rollSurvivalTotal } from "./roll.js";
import {
  diagnoseResourceConfiguration,
  diagnoseResourceItemOverlaps,
  matchResourceItems,
  planConsumption,
  planDeposit,
  suggestExhaustion,
} from "./consumption.js";
import {
  classifyResourceOutcome,
  RESOURCE_OUTCOMES,
  resourceOutcomeLabel,
} from "./outcome.js";
import {
  RESOURCE_EVENTS,
  emitResourceEvent,
  subscribe,
  isAuthoritativeGM,
  validateResourcePayloadShape,
} from "./socket.js";
import { SETTING_KEYS, getSetting } from "../settings.js";
import { escapeHtml, prettyEnvironment, prettyResource } from "../ui-util.js";
import { isFullGM } from "../permissions.js";
import {
  confirmInfinityDialog,
  isInfinityDialogAvailable,
} from "../dialog-contract.js";
import {
  buildInfinityChatCard,
  describeChatAudience,
  markTrustedChatHtml,
} from "../chat-card.js";

const MODULE_ID = "infinity-dnd5e";
const UPKEEP_CLAIM_STABILIZATION_MS = 500;

let registered = false;
let upkeepInFlight = false;

/** Active foraging windows, keyed by runId. */
const pendingRuns = new Map();

/* ------------------------------------------------------------------ *
 * Registration + day detection
 * ------------------------------------------------------------------ */

/** Wire the rollover hooks + the GM-side forage-result handler. Idempotent. */
export function registerResourceCalendarWatcher() {
  if (registered) return;
  registered = true;

  subscribe(RESOURCE_EVENTS.FORAGE_RESULT, (payload) => {
    if (!isAuthoritativeGM()) return;
    handleForageResult(payload).catch((error) =>
      console.error(`${MODULE_ID} | forage-result handler`, error),
    );
  });

  try {
    Hooks.on("updateWorldTime", () => void onTimeMaybeChanged("core"));
    const dtcHook = globalThis.SimpleCalendar?.Hooks?.DateTimeChange;
    if (dtcHook) Hooks.on(dtcHook, () => void onTimeMaybeChanged("sc"));
  } catch (error) {
    console.warn(`${MODULE_ID} | failed to register time hooks`, error);
  }

  // One-time sync at startup so a fresh world seeds its baseline without
  // retro-charging, and a world that advanced while no GM was online catches up.
  void onTimeMaybeChanged("ready-sync");
}

/**
 * Re-run the idempotent day reconciliation after this client gains resource
 * authority. Player clients install the socket/time listeners at startup, so a
 * later promotion must not depend on registering those listeners a second time.
 */
export function reconcileResourceCalendarWatcher(
  reason = "authority-recovery",
) {
  if (!registered || !isAuthoritativeGM()) return false;
  void onTimeMaybeChanged(String(reason ?? "authority-recovery"));
  return true;
}

/** Compute the current absolute day from SC (preferred) or core time. */
function currentAbsoluteDay() {
  const SC = globalThis.SimpleCalendar;
  if (typeof SC?.api?.timestamp === "function") {
    try {
      const ts = Number(SC.api.timestamp());
      if (Number.isFinite(ts)) {
        return computeAbsoluteDay({
          scTimestamp: ts,
          scSecondsPerDay: secondsPerDayFromSC(SC),
        });
      }
    } catch (error) {
      console.warn(
        `${MODULE_ID} | Simple Calendar read failed; using core time`,
        error,
      );
    }
  }
  const t = globalThis.game?.time;
  if (t) {
    return computeAbsoluteDay({
      worldTime: Number(t.worldTime ?? 0),
      secondsPerDay: resolveSecondsPerDay(t),
    });
  }
  return null;
}

/** Seconds per day according to Simple Calendar's active calendar, else 86400. */
function secondsPerDayFromSC(SC) {
  try {
    const cal = SC?.api?.getCurrentCalendar?.();
    const time = cal?.time;
    const h = Number(time?.hoursInDay);
    const m = Number(time?.minutesInHour);
    const s = Number(time?.secondsInMinute);
    if ([h, m, s].every((n) => Number.isFinite(n) && n > 0)) return h * m * s;
  } catch {
    /* fall through */
  }
  return 86400;
}

/**
 * The day-change reactor. Seeds on first run, re-baselines on backward travel,
 * dedupes same-day fires, and runs (capped) upkeep on a forward jump. Honors the
 * auto-trigger setting (keeping lastSeenDay in sync even when off, so enabling
 * it later doesn't replay a huge backlog).
 */
async function onTimeMaybeChanged(reason) {
  try {
    if (!isAuthoritativeGM() || upkeepInFlight) return;
    const current = currentAbsoluteDay();
    if (current == null) return;
    const state = loadRunState();
    if (state.activeUpkeep) {
      blockActiveResourceRun("automatic upkeep", state.activeUpkeep);
      return;
    }
    const { elapsed, direction } = diffDays(state.lastSeenDay, current);
    if (direction === "seed" || direction === "backward") {
      await setLastSeenDay(current);
      return;
    }
    if (elapsed <= 0) return;

    if (getSetting(SETTING_KEYS.RESOURCE_AUTO_TRIGGER) === false) {
      // Auto-upkeep off: keep the baseline current so the GM's manual supplies
      // Day stays the only path, without a backlog building up silently.
      await setLastSeenDay(current);
      return;
    }

    const config = loadResourceConfig();
    const days = clampElapsedForUpkeep(elapsed, config.maxCatchUpDays);
    upkeepInFlight = true;
    try {
      const result = await runDailyUpkeep({
        elapsedDays: days,
        config,
        day: current,
      });
      // A conflict is recoverable configuration work, not a completed upkeep
      // day. Keep the previous baseline so fixing the conflict can safely retry
      // the missed day instead of silently skipping it.
      if (!result?.blocked && loadRunState().lastSeenDay !== current) {
        await setLastSeenDay(current);
      }
    } finally {
      upkeepInFlight = false;
    }
  } catch (error) {
    upkeepInFlight = false;
    console.error(`${MODULE_ID} | day-change upkeep failed (${reason})`, error);
  }
}

/**
 * Manual "Use Daily Supplies" — runs one day of upkeep immediately, independent of the
 * world clock and the auto-trigger setting. GM-only.
 */
export async function advanceDayNow() {
  if (!isAuthoritativeGM()) {
    globalThis.ui?.notifications?.warn(
      "Only the active full GM can run daily upkeep. No supplies were changed.",
    );
    return null;
  }
  const activeUpkeep = loadRunState().activeUpkeep;
  if (activeUpkeep) {
    return blockActiveResourceRun("daily upkeep", activeUpkeep);
  }
  if (upkeepInFlight) return null;
  upkeepInFlight = true;
  try {
    return await runDailyUpkeep({
      elapsedDays: 1,
      manual: true,
      day: currentAbsoluteDay(),
    });
  } finally {
    upkeepInFlight = false;
  }
}

/** Manual Use Daily Supplies is consumption-only; calendar upkeep may still forage. */
export function shouldRunUpkeepForaging({ manual = false, environment } = {}) {
  return manual !== true && isForageable(environment);
}

/* ------------------------------------------------------------------ *
 * Forage drive (GM-pushed Survival check, gather-only)
 * ------------------------------------------------------------------ */

/**
 * Describe a forage drive for the dialog: the suggested DC (the current
 * environment's, falling back to 15) and the roster members that can be sent the
 * check, each flagged with whether an owner is online to actually roll. GM-side.
 */
export function describeForageDrive(config = null) {
  const cfg = config ?? loadResourceConfig();
  const state = loadRunState();
  const env = resolveCurrentEnvironment(cfg, state);
  const dc = Number(env?.dc);
  const foodDc = Number(env?.foodDc ?? env?.dc);
  const waterDc = Number(env?.waterDc ?? env?.dc);
  const roster = getPartyRoster(cfg);
  return {
    defaultDc: Number.isFinite(dc) && dc > 0 ? dc : 15,
    defaultFoodDc: Number.isFinite(foodDc) && foodDc >= 0 ? foodDc : 15,
    defaultWaterDc: Number.isFinite(waterDc) && waterDc >= 0 ? waterDc : 15,
    environmentLabel:
      String(
        env?.label ?? prettyEnvironment(env?.id) ?? "Current environment",
      ).trim() || "Current environment",
    forageable: isForageable(env),
    stashName: resolveDriveStashActor(cfg, roster)?.name ?? null,
    canForageFood: cfg.resources.some((r) => r.forageYields === "food"),
    canForageWater:
      cfg.waterEnabled !== false &&
      cfg.resources.some((r) => r.forageYields === "water"),
    candidates: roster
      .filter((member) => member.consumes)
      .map(({ actor }) => ({
        actorId: actor.id,
        name: actor.name,
        online: Boolean(owningOnlineUserId(actor)),
      })),
  };
}

/**
 * The single actor a forage drive deposits the whole haul onto: the explicitly
 * configured party stash. Merely flagging an actor as an available per-member
 * stash must not collapse several independent draw sources into one pile.
 */
function resolveDriveStashActor(cfg, roster) {
  const byId = new Map(roster.map((r) => [r.actor.id, r.actor]));
  const partyStashId = String(cfg.partyStashId ?? "").trim();
  if (partyStashId && byId.has(partyStashId)) return byId.get(partyStashId);
  return null;
}

/**
 * Run a GM-initiated forage drive: push a Survival check at a GM-set DC to the
 * selected party members, then deposit what they gather — filling the party's
 * water sources and adding rations to the designated stash. Unlike Use Daily Supplies
 * this is gather-only: it consumes nothing and doesn't tick the day. GM-only.
 *
 * @param {object} args
 * @param {Array<{actorId:string,forageTarget:string}>} args.foragers - canonical per-actor assignments.
 * @param {number} args.foodDc - food Survival DC for this drive.
 * @param {number} args.waterDc - water Survival DC for this drive.
 * @param {number} [args.dc] - legacy shared Survival DC.
 * @param {string[]} [args.targetActorIds] - legacy selected actor ids.
 * @param {"food-water"|"food"|"water"} [args.forageTarget] - legacy shared target.
 */
export async function runForageDrive({
  foragers,
  foodDc,
  waterDc,
  dc,
  targetActorIds,
  forageTarget,
} = {}) {
  if (!isAuthoritativeGM()) {
    globalThis.ui?.notifications?.warn(
      "Only the active full GM can run a forage drive. Nothing changed.",
    );
    return null;
  }
  const activeUpkeep = loadRunState().activeUpkeep;
  if (activeUpkeep) {
    return blockActiveResourceRun("forage drive", activeUpkeep);
  }
  if (upkeepInFlight) return null;
  upkeepInFlight = true;
  try {
    return await runForageDriveInner({
      foragers,
      foodDc,
      waterDc,
      dc,
      targetActorIds,
      forageTarget,
    });
  } finally {
    upkeepInFlight = false;
  }
}

async function runForageDriveInner({
  foragers,
  foodDc,
  waterDc,
  dc,
  targetActorIds,
  forageTarget,
}) {
  let cfg = loadResourceConfig();
  const state = loadRunState();
  const runId = generateRunId();
  const startedAt = Date.now();
  let roster = getPartyRoster(cfg);
  const operationFingerprint = resourceOperationFingerprint({
    config: cfg,
    state,
    roster,
    environmentId: resolveCurrentEnvironment(cfg, state)?.id ?? null,
  });

  // The drive only forages tracked members; resolve the GM's selection to them.
  const requestedAssignments = normalizeForagerAssignments({
    foragers,
    targetActorIds,
    forageTarget,
  });
  const requestedTargetByActor = new Map(
    requestedAssignments.map((assignment) => [
      assignment.actorId,
      assignment.forageTarget,
    ]),
  );
  const wanted = new Set(requestedTargetByActor.keys());
  let selected = roster.filter(
    (member) => member.consumes && wanted.has(member.actor.id),
  );
  if (selected.length === 0) {
    globalThis.ui?.notifications?.info(
      "No foragers were selected. Choose at least one character and try again.",
    );
    return null;
  }
  const forageAssignments = selected.map(({ actor }) => ({
    actorId: actor.id,
    forageTarget: requestedTargetByActor.get(actor.id),
  }));
  const assignmentSummary = aggregateForageAssignments(forageAssignments);
  const party = selected.map((r) => r.actor);
  const configuredFood = cfg.resources.some((r) => r.forageYields === "food");
  const configuredWater =
    cfg.waterEnabled !== false &&
    cfg.resources.some((r) => r.forageYields === "water");
  if (
    (assignmentSummary.food && !configuredFood) ||
    (assignmentSummary.water && !configuredWater)
  ) {
    globalThis.ui?.notifications?.warn(
      "The selected forage supplies are not enabled and configured. Review Setup & Rules; nothing changed.",
    );
    return null;
  }

  // Keep the selected region's yield rules. A non-forageable environment fails
  // closed instead of allowing a manual drive to invent wilderness supplies.
  const baseEnv = resolveCurrentEnvironment(cfg, state);
  if (!isForageable(baseEnv)) {
    globalThis.ui?.notifications?.warn(
      "The current environment does not allow foraging. Choose a forageable area in Quartermaster; nothing changed.",
    );
    return null;
  }
  const resolveDriveDc = (channelValue, environmentValue) => {
    for (const candidate of [channelValue, dc, environmentValue, baseEnv?.dc]) {
      if (candidate == null || String(candidate).trim() === "") continue;
      const normalized = Math.floor(Number(candidate));
      if (Number.isFinite(normalized) && normalized >= 0) return normalized;
    }
    return 15;
  };
  const resolvedFoodDc = resolveDriveDc(foodDc, baseEnv?.foodDc);
  const resolvedWaterDc = resolveDriveDc(waterDc, baseEnv?.waterDc);
  const requestedDcs = [
    ...(assignmentSummary.food ? [resolvedFoodDc] : []),
    ...(assignmentSummary.water ? [resolvedWaterDc] : []),
  ];
  const driveEnv = {
    id: baseEnv?.id ?? "forage-drive",
    label: baseEnv?.label ?? "Foraging drive",
    builtIn: baseEnv?.builtIn === true,
    dc: requestedDcs.length > 0 ? Math.max(...requestedDcs) : baseEnv.dc,
    foodDc: resolvedFoodDc,
    waterDc: resolvedWaterDc,
    forageable: true,
    yieldFood: assignmentSummary.food ? baseEnv.yieldFood : "0",
    yieldWater: assignmentSummary.water ? baseEnv.yieldWater : "0",
  };

  let actorById = new Map(roster.map((r) => [r.actor.id, r.actor]));
  let driveStash = resolveDriveStashActor(cfg, roster);
  let depositTargets = driveStash
    ? [driveStash]
    : selected.map(
        (member) => actorById.get(member.drawFromId) ?? member.actor,
      );
  const conflict = blockConflictedResourceWrite({
    config: cfg,
    actors: depositTargets,
    operation: "forage drive",
  });
  if (conflict) return conflict;

  const forageWindow = await runForagingWindow({
    env: driveEnv,
    party,
    cfg,
    forageAssignments,
    allowGmRolls: true,
  });
  const foragedByActor = forageWindow.foragedByActor;

  // Player rolls can leave this client waiting long enough for inventory,
  // rules, the environment, or roster routing to change. Reload the canonical
  // inputs and fail closed when the original roll no longer matches them.
  const currentCfg = loadResourceConfig();
  const currentState = loadRunState();
  const currentRoster = getPartyRoster(currentCfg);
  if (
    resourceOperationFingerprint({
      config: currentCfg,
      state: currentState,
      roster: currentRoster,
      environmentId:
        resolveCurrentEnvironment(currentCfg, currentState)?.id ?? null,
    }) !== operationFingerprint
  ) {
    return blockChangedResourceContext("forage drive");
  }
  cfg = currentCfg;
  roster = currentRoster;
  selected = roster.filter(
    (member) => member.consumes && wanted.has(member.actor.id),
  );
  actorById = new Map(roster.map((r) => [r.actor.id, r.actor]));
  driveStash = resolveDriveStashActor(cfg, roster);
  depositTargets = driveStash
    ? [driveStash]
    : selected.map(
        (member) => actorById.get(member.drawFromId) ?? member.actor,
      );

  // Re-snapshot live inventory immediately before planning the first write.
  const lateConflict = blockConflictedResourceWrite({
    config: cfg,
    actors: depositTargets,
    operation: "forage drive",
  });
  if (lateConflict) return lateConflict;

  const foodRes = assignmentSummary.food
    ? cfg.resources.find((r) => r.forageYields === "food")
    : null;
  const waterRes = assignmentSummary.water
    ? cfg.resources.find((r) => r.forageYields === "water")
    : null;

  // Decide where every haul lands with the pure planner (no Foundry objects):
  // one communal pile when a stash is set (rations to the stash; water tops up —
  // "fills" — its water source), else each forager keeps their own haul on their
  // draw source. Water only counts when both the toggle is on and a water
  // resource exists to receive it.
  const plan = planForageDriveDeposits({
    roster: roster.map((r) => ({
      actorId: r.actor.id,
      name: r.actor.name,
      isStash: r.isStash,
      consumes: r.consumes,
      drawFromId: r.drawFromId,
    })),
    selectedIds: selected.map((r) => r.actor.id),
    foraged: [...foragedByActor.entries()].map(([actorId, y]) => ({
      actorId,
      ...y,
    })),
    forageTargets: assignmentSummary.individualTargets,
    partyStashId: cfg.partyStashId,
    foodEnabled: assignmentSummary.food && Boolean(foodRes),
    waterEnabled:
      assignmentSummary.water &&
      cfg.waterEnabled !== false &&
      Boolean(waterRes),
  });

  const proposedDeposits = [];
  for (const dep of plan.deposits) {
    const sink = actorById.get(dep.actorId);
    if (!sink) continue;
    if (foodRes && dep.food > 0) {
      proposedDeposits.push({
        actor: sink,
        resource: foodRes,
        amount: dep.food,
      });
    }
    if (waterRes && dep.water > 0) {
      proposedDeposits.push({
        actor: sink,
        resource: waterRes,
        amount: dep.water,
      });
    }
  }
  let proposedPreflight = await blockConflictedProposedResourceWrite({
    resources: runtimeResourceDefinitions(cfg),
    deposits: proposedDeposits,
    operation: "forage drive",
  });
  if (proposedPreflight.blockedResult) {
    return proposedPreflight.blockedResult;
  }

  // Template resolution is asynchronous. Revalidate the complete context after
  // it settles, then rerun the proposal simulation against the latest inventory
  // using only the already-approved templates.
  const writeCfg = loadResourceConfig();
  const writeState = loadRunState();
  const writeRoster = getPartyRoster(writeCfg);
  if (
    resourceOperationFingerprint({
      config: writeCfg,
      state: writeState,
      roster: writeRoster,
      environmentId:
        resolveCurrentEnvironment(writeCfg, writeState)?.id ?? null,
    }) !== operationFingerprint
  ) {
    return blockChangedResourceContext("forage drive");
  }
  cfg = writeCfg;
  roster = writeRoster;
  selected = roster.filter(
    (member) => member.consumes && wanted.has(member.actor.id),
  );
  actorById = new Map(roster.map((r) => [r.actor.id, r.actor]));
  driveStash = resolveDriveStashActor(cfg, roster);
  depositTargets = driveStash
    ? [driveStash]
    : selected.map(
        (member) => actorById.get(member.drawFromId) ?? member.actor,
      );
  const reboundDeposits = rebindProposedResourceDeposits(
    proposedDeposits,
    actorById,
    cfg.resources,
  );
  proposedPreflight = await blockConflictedProposedResourceWrite({
    resources: runtimeResourceDefinitions(cfg),
    deposits: reboundDeposits,
    operation: "forage drive",
    templatesByResourceId: proposedPreflight.templatesByResourceId,
  });
  if (proposedPreflight.blockedResult) {
    return proposedPreflight.blockedResult;
  }
  const finalCfg = loadResourceConfig();
  const finalState = loadRunState();
  const finalRoster = getPartyRoster(finalCfg);
  if (
    resourceOperationFingerprint({
      config: finalCfg,
      state: finalState,
      roster: finalRoster,
      environmentId:
        resolveCurrentEnvironment(finalCfg, finalState)?.id ?? null,
    }) !== operationFingerprint
  ) {
    return blockChangedResourceContext("forage drive");
  }
  cfg = finalCfg;
  roster = finalRoster;
  selected = roster.filter(
    (member) => member.consumes && wanted.has(member.actor.id),
  );
  actorById = new Map(roster.map((r) => [r.actor.id, r.actor]));
  driveStash = resolveDriveStashActor(cfg, roster);
  depositTargets = driveStash
    ? [driveStash]
    : selected.map(
        (member) => actorById.get(member.drawFromId) ?? member.actor,
      );
  const finalConflict = blockConflictedResourceWrite({
    config: cfg,
    actors: depositTargets,
    operation: "forage drive",
  });
  if (finalConflict) return finalConflict;

  const claimConflict = await claimResourceRun({
    runId,
    trigger: "forage",
    day: currentAbsoluteDay(),
    days: 1,
    operation: "forage drive",
    startedAt,
    environment: driveEnv,
    actors: buildRunActorSnapshots({
      participants: selected.map(({ actor }) => ({
        actorId: actor.id,
        name: actor.name,
        forageTarget: assignmentSummary.individualTargets[actor.id],
      })),
      writeTargets: depositTargets.map((actor) => ({
        actorId: actor.id,
        name: actor.name,
      })),
    }),
    forageTarget: assignmentSummary.target,
    forageAssignments,
    forageDestination: driveStash
      ? {
          mode: "party-stash",
          actorId: driveStash.id,
          name: driveStash.name,
        }
      : { mode: "draw-sources" },
  });
  if (claimConflict) return claimConflict;
  const assertWriteAllowed = () => assertResourceRunWriteAllowed(runId);

  // Apply the planned deposits against the real actors.
  let landedFood = 0;
  let landedWater = 0;
  const depositErrors = [];
  for (const dep of plan.deposits) {
    const sink = actorById.get(dep.actorId);
    if (!sink) continue;
    if (foodRes && dep.food > 0) {
      const deposit = await applyResourceDeposit(sink, foodRes, dep.food, {
        templateItem: proposedPreflight.templatesByResourceId.get(foodRes.id),
        assertWriteAllowed,
      });
      const applied = deposit.deposited;
      landedFood += applied;
      if (deposit.error)
        depositErrors.push(`${sink.name}: food ${deposit.error}`);
    }
    if (waterRes && dep.water > 0) {
      const deposit = await applyResourceDeposit(sink, waterRes, dep.water, {
        templateItem: proposedPreflight.templatesByResourceId.get(waterRes.id),
        assertWriteAllowed,
      });
      const applied = deposit.deposited;
      landedWater += applied;
      if (deposit.error)
        depositErrors.push(`${sink.name}: water ${deposit.error}`);
    }
  }

  const stashActor = plan.stashActorId
    ? (actorById.get(plan.stashActorId) ?? null)
    : null;
  const receipt = buildForageRunReceipt({
    runId,
    day: currentAbsoluteDay(),
    environment: driveEnv,
    perForager: plan.perForager,
    forageTarget: assignmentSummary.target,
    forageAssignments,
    forageMode: cfg.forageMode,
    destination: stashActor
      ? {
          mode: "party-stash",
          actorId: stashActor.id,
          name: stashActor.name,
        }
      : { mode: "draw-sources" },
    totalFood: landedFood,
    totalWater: landedWater,
    depositErrors,
  });
  await completeUpkeepRun({ runId, receipt, persistResult: false });
  emitForageAcknowledgements(forageWindow.afterCommitAcknowledgements);
  emitResourceEvent(RESOURCE_EVENTS.STATE_UPDATE, {});
  await postForageDriveReport({
    env: driveEnv,
    perForager: plan.perForager,
    stashActor,
    totalFood: landedFood,
    totalWater: landedWater,
    depositErrors,
    forageTarget: assignmentSummary.target,
    forageAssignments,
  });
  return {
    runId,
    dc: driveEnv.dc,
    foodDc: driveEnv.foodDc,
    waterDc: driveEnv.waterDc,
    perForager: plan.perForager,
    totalFood: landedFood,
    totalWater: landedWater,
    depositErrors,
    stashActor,
    forageTarget: assignmentSummary.target,
    forageAssignments,
  };
}

export function buildForageDriveReportContent({
  env,
  perForager = [],
  stashActor,
  totalFood,
  totalWater,
  depositErrors = [],
  forageTarget = FORAGE_TARGETS.BOTH,
  forageAssignments = [],
}) {
  const assignmentTargetByActor = new Map(
    normalizeForagerAssignments({ foragers: forageAssignments }).map(
      (assignment) => [assignment.actorId, assignment.forageTarget],
    ),
  );
  const targetForRow = (row) => {
    if (Object.values(FORAGE_TARGETS).includes(row?.forageTarget)) {
      return row.forageTarget;
    }
    return forageTargetChannels(
      assignmentTargetByActor.get(String(row?.actorId ?? "")) ?? forageTarget,
    ).target;
  };
  const reportAssignments = [
    ...(Array.isArray(forageAssignments) ? forageAssignments : []),
    ...perForager.map((row) => ({
      actorId: row?.actorId,
      forageTarget: targetForRow(row),
    })),
  ];
  const summary = aggregateForageAssignments(reportAssignments);
  const reportTarget =
    summary.target ?? forageTargetChannels(forageTarget).target;
  const formatYield = (food, water, target = reportTarget) => {
    const channels = forageTargetChannels(target);
    if (channels.food && channels.water)
      return `+${food} food / +${water} water`;
    if (channels.food) return `+${food} food`;
    return `+${water} water`;
  };
  const finiteDc = (value) => {
    if (value == null || String(value).trim() === "") return null;
    const normalized = Number(value);
    return Number.isFinite(normalized) ? normalized : null;
  };
  const sharedDc = finiteDc(env?.dc);
  const foodDc = finiteDc(env?.foodDc) ?? sharedDc;
  const waterDc = finiteDc(env?.waterDc) ?? sharedDc;
  const formatDc = (target) => {
    const channels = forageTargetChannels(target);
    if (channels.food && !channels.water) return String(foodDc ?? "—");
    if (channels.water && !channels.food) return String(waterDc ?? "—");
    if (foodDc !== null && waterDc !== null) {
      return foodDc === waterDc
        ? String(foodDc)
        : `Food ${foodDc} / Water ${waterDc}`;
    }
    return String(sharedDc ?? foodDc ?? waterDc ?? "—");
  };
  const targetLabel = (target) => {
    const channels = forageTargetChannels(target);
    if (channels.food && channels.water) return "food and water";
    return channels.food ? "food only" : "water only";
  };
  const rows = perForager
    .map((f) => {
      const rowTarget = targetForRow(f);
      const channels = forageTargetChannels(rowTarget);
      const name = `<strong>${escapeHtml(f.name)}</strong>`;
      const assignment = `<span style="opacity:0.7;">(${escapeHtml(targetLabel(rowTarget))}, DC ${escapeHtml(formatDc(rowTarget))})</span>`;
      if (!f.attempted) {
        return `<li>${name} ${assignment} — <span style="opacity:0.7;">no online owner to roll</span></li>`;
      }
      if (f.suppressed) {
        return `<li>${name} ${assignment} — <span style="opacity:0.7;">gathered, but the best haul was kept</span></li>`;
      }
      const foodSuccess =
        channels.food &&
        (typeof f.foodSuccess === "boolean"
          ? f.foodSuccess
          : f.success === true);
      const waterSuccess =
        channels.water &&
        (typeof f.waterSuccess === "boolean"
          ? f.waterSuccess
          : f.success === true);
      if (!foodSuccess && !waterSuccess) {
        return `<li>${name} ${assignment} — <span style="color:#ef6f74;">found nothing</span></li>`;
      }
      const foodSuppressed = foodSuccess && f.foodSuppressed === true;
      const waterSuppressed = waterSuccess && f.waterSuppressed === true;
      if (
        channels.food &&
        channels.water &&
        foodSuccess &&
        waterSuccess &&
        !foodSuppressed &&
        !waterSuppressed
      ) {
        return `<li>${name} ${assignment} — <span style="color:#6dd5a2;">gathered ${escapeHtml(formatYield(f.food, f.water, rowTarget))}</span></li>`;
      }
      const outcomes = [];
      if (channels.food) {
        outcomes.push(
          foodSuppressed
            ? "food haul replaced by the best result"
            : foodSuccess
              ? `gathered +${f.food} food`
              : "found no food",
        );
      }
      if (channels.water) {
        outcomes.push(
          waterSuppressed
            ? "water haul replaced by the best result"
            : waterSuccess
              ? `gathered +${f.water} water`
              : "found no water",
        );
      }
      return `<li>${name} ${assignment} — <span style="color:#6dd5a2;">${escapeHtml(outcomes.join("; "))}</span></li>`;
    })
    .join("");
  const dest = stashActor
    ? `Added to <strong>${escapeHtml(stashActor.name)}</strong>'s stash`
    : "Added to each forager's pack";
  const errorLine = depositErrors.length
    ? `<div style="color:#f2bd61;">Some inventory deposits need review in Quartermaster.</div>`
    : "";
  const details = `
    <ul>${rows}</ul>
    <div>${dest}: <strong>${escapeHtml(formatYield(totalFood, totalWater, reportTarget))}</strong> applied.</div>
    ${errorLine}`;
  return buildInfinityChatCard({
    title: `Forage Drive — DC ${formatDc(reportTarget)}`,
    outcome: depositErrors.length
      ? "Foraging finished; some inventory deposits need review."
      : "Foraging finished and the confirmed yield was applied.",
    audience: describeChatAudience(
      getSetting(SETTING_KEYS.RESOURCE_REPORT_MODE) ?? "whisper-gm",
    ),
    details: markTrustedChatHtml(details),
    nextAction: depositErrors.length
      ? "Open Quartermaster and review the flagged inventory deposits."
      : "No further action is needed.",
    tone: depositErrors.length ? "warning" : "success",
    classes: ["infinity-quartermaster-receipt", "infinity-forage-receipt"],
  });
}

async function postForageDriveReport(options) {
  if (typeof globalThis.ChatMessage?.create !== "function") return null;
  const content = buildForageDriveReportContent(options);
  const perForager = Array.isArray(options?.perForager)
    ? options.perForager
    : [];
  const speaker = globalThis.ChatMessage.getSpeaker?.({
    alias: "Quartermaster",
  });
  const messageData = { content, speaker };
  const whisper = resolveWhisperForActors(
    perForager
      .map((f) => f.actorId)
      .filter((id) => typeof id === "string" && id),
  );
  if (whisper !== null) messageData.whisper = whisper;
  try {
    return await globalThis.ChatMessage.create(messageData);
  } catch (error) {
    console.warn(`${MODULE_ID} | forage-drive report failed`, error);
    return null;
  }
}

/* ------------------------------------------------------------------ *
 * Resource write preflight
 * ------------------------------------------------------------------ */

/**
 * Diagnose the resource definitions and concrete inventories that a pending
 * operation may write. This stays callable in node-only tests and by the
 * Quartermaster without mutating Foundry state.
 *
 * Water definitions are inactive when water tracking is disabled unless an
 * explicit resource list is supplied. The explicit form lets callers preview
 * the complete saved configuration, including rules that are currently off.
 */
export function diagnoseResourceWritePreflight({
  config = {},
  actors = [],
  resources = null,
} = {}) {
  const configuredResources = Array.isArray(resources)
    ? resources
    : runtimeResourceDefinitions(config);
  const actorList = Array.isArray(actors) ? actors : Array.from(actors ?? []);
  const seenActorIds = new Set();
  const inventories = [];

  for (const [index, actor] of actorList.entries()) {
    if (!actor || typeof actor !== "object") continue;
    const actorId = String(actor.actorId ?? actor.id ?? "").trim();
    if (actorId && seenActorIds.has(actorId)) continue;
    if (actorId) seenActorIds.add(actorId);
    inventories.push({
      actorId: actorId || `actor-${index + 1}`,
      actorName: String(actor.actorName ?? actor.name ?? actorId ?? "").trim(),
      items: actorItemSnapshots(actor),
    });
  }

  const configuration = diagnoseResourceConfiguration(configuredResources);
  const inventory = diagnoseResourceItemOverlaps({
    inventories,
    resources: configuredResources,
  });
  const conflicts = [...configuration.conflicts, ...inventory.conflicts];
  const blockingConflicts = conflicts.filter(
    (entry) => entry.blocking === true,
  );

  return {
    ok: conflicts.length === 0,
    blocked: blockingConflicts.length > 0,
    conflicts,
    blockingConflicts,
    warningConflicts: conflicts.filter((entry) => entry.blocking !== true),
    configuration,
    inventory,
  };
}

function runtimeResourceDefinitions(config = {}) {
  return (Array.isArray(config?.resources) ? config.resources : []).filter(
    (resource) =>
      config?.waterEnabled !== false ||
      (resource?.id !== "water" && resource?.forageYields !== "water"),
  );
}

/**
 * Stable snapshot of the rules and resolved roster that determine one upkeep
 * operation. Inventory is deliberately excluded because the late conflict
 * preflight re-reads live Actor Items separately.
 */
export function resourceOperationFingerprint({
  config = {},
  state = {},
  roster = [],
  environmentId = null,
} = {}) {
  return JSON.stringify({
    config: {
      forageMode: config.forageMode,
      halfRations: config.halfRations,
      waterEnabled: config.waterEnabled,
      maxCatchUpDays: config.maxCatchUpDays,
      forageTimeoutSeconds: config.forageTimeoutSeconds,
      resources: config.resources,
      roster: config.roster,
      partyStashId: config.partyStashId,
      environments: config.environments,
    },
    currentEnvironmentId: environmentId ?? state.currentEnvironmentId ?? null,
    lastSeenDay:
      state.lastSeenDay == null || !Number.isFinite(Number(state.lastSeenDay))
        ? null
        : Math.floor(Number(state.lastSeenDay)),
    roster: (Array.isArray(roster) ? roster : []).map((member) => ({
      actorId: String(member?.actor?.id ?? member?.actorId ?? ""),
      isStash: member?.isStash === true,
      consumes: member?.consumes === true,
      drawFromId: String(member?.drawFromId ?? ""),
    })),
  });
}

function blockChangedResourceContext(operation) {
  const label = String(operation ?? "resource automation").trim();
  globalThis.ui?.notifications?.warn?.(
    `${label} paused because the resource rules or roster changed while players were responding. No new supplies were changed; review Quartermaster and retry.`,
  );
  return {
    blocked: true,
    status: "blocked",
    reason: "resource-context-changed",
    operation: label,
  };
}

function blockActiveResourceRun(operation, activeUpkeep) {
  const label = String(operation ?? "resource automation").trim();
  const runId = String(activeUpkeep?.runId ?? "").trim();
  globalThis.ui?.notifications?.error?.(
    `${label} paused because an earlier resource run did not finish cleanly. Do not repeat it; review Quartermaster and clear the interrupted-run lock before trying again.`,
  );
  return {
    blocked: true,
    status: "blocked",
    reason: "active-resource-run",
    operation: label,
    runId,
  };
}

function blockReservedCalendarDay(operation, day, lastSeenDay) {
  const label = String(operation ?? "resource automation").trim();
  globalThis.ui?.notifications?.info?.(
    `${label} skipped because day ${day} was already reserved by another GM client. No supplies were changed.`,
  );
  return {
    blocked: true,
    status: "blocked",
    reason: "calendar-day-already-reserved",
    operation: label,
    day,
    lastSeenDay,
  };
}

function assertResourceRunWriteAllowed(runId) {
  if (!isAuthoritativeGM()) {
    throw new Error("ResourceUpkeepAuthorityChanged");
  }
  return assertUpkeepClaimCurrent(runId);
}

async function claimResourceRun({
  runId,
  trigger,
  day,
  days,
  operation,
  startedAt = null,
  environment = null,
  actors = [],
  forageTarget = null,
  forageAssignments = [],
  forageDestination = null,
}) {
  const user = globalThis.game?.user;
  try {
    await claimUpkeepRun({
      runId,
      trigger,
      day,
      days,
      startedAt,
      claimedAt: Date.now(),
      environment,
      initiator: user?.id ? { userId: user.id, name: user.name } : null,
      actors,
      forageTarget,
      forageAssignments,
      forageDestination,
    });
  } catch (error) {
    if (
      String(error?.message ?? error).includes("ResourceUpkeepAlreadyActive")
    ) {
      return blockActiveResourceRun(operation, loadRunState().activeUpkeep);
    }
    if (
      trigger === "calendar" &&
      String(error?.message ?? error).includes(
        "ResourceUpkeepCalendarDayReserved",
      )
    ) {
      return blockReservedCalendarDay(
        operation,
        day,
        loadRunState().lastSeenDay,
      );
    }
    throw error;
  }
  // Foundry Journal updates are unconditional. Give simultaneous GM clients a
  // short propagation window, then prove this run still owns the canonical
  // claim before the first Actor mutation. Per-write assertions below keep
  // fencing authority/claim changes throughout the operation.
  await wait(UPKEEP_CLAIM_STABILIZATION_MS);
  assertResourceRunWriteAllowed(runId);
  return null;
}

/**
 * Return a typed blocked result when the preflight is unsafe, else null.
 * Callers return this result before any prompts, inventory writes, or run-state
 * writes so the GM can repair the configuration and retry deterministically.
 */
function blockConflictedResourceWrite({ config, actors, operation }) {
  const diagnostics = diagnoseResourceWritePreflight({ config, actors });
  if (!diagnostics.blocked) return null;

  const first = diagnostics.blockingConflicts[0];
  const remaining = diagnostics.blockingConflicts.length - 1;
  const more =
    remaining > 0 ? ` ${remaining} more conflict(s) need review.` : "";
  const label = String(operation ?? "resource automation").trim();
  globalThis.ui?.notifications?.error?.(
    `${label} paused. ${first.message}${more} Open Quartermaster to fix the resource rules before retrying.`,
  );
  console.warn(
    `${MODULE_ID} | ${label} blocked by resource conflicts`,
    diagnostics,
  );
  return {
    blocked: true,
    status: "blocked",
    reason: "resource-conflicts",
    operation: label,
    diagnostics,
  };
}

/**
 * Simulate the exact sequence of pending deposits against cloned inventory.
 * Newly created stacks are stamped exactly as the live write path stamps them,
 * so a template that would be claimed by another resource is caught before the
 * first Actor Item is changed.
 */
export async function diagnoseProposedResourceDeposits({
  resources = [],
  deposits = [],
  templatesByResourceId: approvedTemplates = null,
} = {}) {
  const resourceDefs = Array.isArray(resources) ? resources : [];
  const resourceById = new Map(
    resourceDefs.map((resource) => [String(resource?.id ?? ""), resource]),
  );
  const inventoriesById = new Map();
  const templatesByResourceId =
    approvedTemplates instanceof Map
      ? new Map(approvedTemplates)
      : new Map(
          Object.entries(
            approvedTemplates && typeof approvedTemplates === "object"
              ? approvedTemplates
              : {},
          ),
        );
  const proposals = Array.isArray(deposits) ? deposits : [];
  let syntheticId = 0;

  // Approve one exact create template for every proposed resource up front,
  // even when the current inventory suggests a bump. If that stack disappears
  // before the write, depositResource must use this already-reviewed fallback.
  for (const proposal of proposals) {
    const resourceId = String(
      proposal?.resource?.id ?? proposal?.resourceId ?? "",
    ).trim();
    const resource = proposal?.resource ?? resourceById.get(resourceId);
    if (!resource || !resourceId || templatesByResourceId.has(resourceId)) {
      continue;
    }
    templatesByResourceId.set(
      resourceId,
      await resolveResourceDepositTemplate(resource),
    );
  }

  for (const proposal of proposals) {
    const actor = proposal?.actor;
    const actorId = String(actor?.id ?? proposal?.actorId ?? "").trim();
    const resourceId = String(
      proposal?.resource?.id ?? proposal?.resourceId ?? "",
    ).trim();
    const resource = proposal?.resource ?? resourceById.get(resourceId);
    const amount = wholeAmount(proposal?.amount);
    if (!actor || !actorId || !resource || amount <= 0) continue;

    let inventory = inventoriesById.get(actorId);
    if (!inventory) {
      inventory = {
        actorId,
        actorName: String(actor.name ?? actorId),
        items: actorItemSnapshots(actor)
          .map((item) => cloneSnapshot(item))
          .filter(Boolean),
      };
      inventoriesById.set(actorId, inventory);
    }

    const matches = matchResourceItems(inventory.items, resource);
    const plan = planDeposit({
      matches,
      amount,
      templateItem: templatesByResourceId.get(resourceId),
    });

    if (plan.op === "bump") {
      const index = inventory.items.findIndex(
        (item) => String(item?.id ?? item?._id ?? "") === String(plan.id),
      );
      if (index >= 0) {
        const updated = cloneSnapshot(inventory.items[index]);
        updated.system = updated.system ?? {};
        updated.system.quantity = plan.to;
        inventory.items[index] = updated;
      }
    } else if (plan.op === "create") {
      const created = buildCreatedResourceSnapshot({
        template: plan.from,
        resourceDef: resource,
        quantity: plan.quantity,
      });
      if (created) {
        created._id = `proposed-resource-${++syntheticId}`;
        inventory.items.push(created);
      }
    }
  }

  // Also validate the approved create fallback for every actor/resource pair.
  // Candidate snapshots do not participate in the simulated bump sequence; they
  // exist only to prove that a late bump-to-create switch remains unambiguous.
  const candidateKeys = new Set();
  for (const proposal of proposals) {
    const actor = proposal?.actor;
    const actorId = String(actor?.id ?? proposal?.actorId ?? "").trim();
    const resourceId = String(
      proposal?.resource?.id ?? proposal?.resourceId ?? "",
    ).trim();
    const resource = proposal?.resource ?? resourceById.get(resourceId);
    const template = templatesByResourceId.get(resourceId);
    const candidateKey = `${actorId}\u0000${resourceId}`;
    if (
      !actor ||
      !actorId ||
      !resource ||
      !template ||
      candidateKeys.has(candidateKey)
    ) {
      continue;
    }
    candidateKeys.add(candidateKey);
    const inventory = inventoriesById.get(actorId);
    if (!inventory) continue;
    const candidate = buildCreatedResourceSnapshot({
      template,
      resourceDef: resource,
      quantity: Math.max(1, wholeAmount(proposal?.amount)),
    });
    if (!candidate) continue;
    candidate._id = `proposed-resource-fallback-${++syntheticId}`;
    inventory.items.push(candidate);
  }

  const diagnostics = diagnoseResourceItemOverlaps({
    inventories: [...inventoriesById.values()],
    resources: resourceDefs,
  });
  return {
    ...diagnostics,
    blocked: diagnostics.blockingConflicts.length > 0,
    templatesByResourceId,
  };
}

async function blockConflictedProposedResourceWrite({
  resources,
  deposits,
  operation,
  templatesByResourceId = null,
}) {
  const diagnostics = await diagnoseProposedResourceDeposits({
    resources,
    deposits,
    templatesByResourceId,
  });
  if (!diagnostics.blocked) {
    return {
      blockedResult: null,
      templatesByResourceId: diagnostics.templatesByResourceId,
    };
  }

  const first = diagnostics.blockingConflicts[0];
  const remaining = diagnostics.blockingConflicts.length - 1;
  const more =
    remaining > 0 ? ` ${remaining} more conflict(s) need review.` : "";
  const label = String(operation ?? "resource automation").trim();
  globalThis.ui?.notifications?.error?.(
    `${label} paused before depositing supplies. ${first.message}${more} Open Quartermaster to fix the resource rules before retrying.`,
  );
  console.warn(
    `${MODULE_ID} | ${label} blocked by proposed resource conflicts`,
    diagnostics,
  );
  return {
    blockedResult: {
      blocked: true,
      status: "blocked",
      reason: "proposed-resource-conflicts",
      operation: label,
      diagnostics,
    },
    templatesByResourceId: diagnostics.templatesByResourceId,
  };
}

function rebindProposedResourceDeposits(deposits, actorById, resources = []) {
  const resourceById = new Map(
    (Array.isArray(resources) ? resources : []).map((resource) => [
      String(resource?.id ?? ""),
      resource,
    ]),
  );
  return (Array.isArray(deposits) ? deposits : [])
    .map((proposal) => ({
      actor: actorById.get(String(proposal?.actor?.id ?? "")),
      resource: resourceById.get(String(proposal?.resource?.id ?? "")),
      amount: wholeAmount(proposal?.amount),
    }))
    .filter(
      (proposal) => proposal.actor && proposal.resource && proposal.amount > 0,
    );
}

/* ------------------------------------------------------------------ *
 * The upkeep pipeline
 * ------------------------------------------------------------------ */

async function runDailyUpkeep({
  elapsedDays = 1,
  config = null,
  day = null,
  manual = false,
} = {}) {
  let cfg = config ?? loadResourceConfig();
  const days = Math.max(1, Math.floor(Number(elapsedDays) || 1));
  const state = loadRunState();
  const runId = generateRunId();
  const startedAt = Date.now();
  const env = resolveCurrentEnvironment(cfg, state);
  let roster = getPartyRoster(cfg);
  const operationFingerprint = resourceOperationFingerprint({
    config: cfg,
    state,
    roster,
    environmentId: env?.id ?? null,
  });
  let consumers = roster.filter((member) => member.consumes);
  let party = consumers.map((member) => member.actor);
  let inventoryActors = roster.map((member) => member.actor);

  if (party.length === 0) {
    globalThis.ui?.notifications?.info(
      "No player characters were found for daily upkeep. Add party members in Setup & Rules; no supplies were changed.",
    );
    return null;
  }

  // Resolve each member's draw source actor once (own sheet, or a nominated stash).
  let actorById = new Map(inventoryActors.map((actor) => [actor.id, actor]));
  let sourceForMember = new Map(
    consumers.map((member) => [
      member.actor.id,
      actorById.get(member.drawFromId) ?? member.actor,
    ]),
  );

  const conflict = blockConflictedResourceWrite({
    config: cfg,
    actors: inventoryActors,
    operation: "daily upkeep",
  });
  if (conflict) return conflict;

  // 1) Automatic calendar upkeep may forage when the environment allows it.
  //    Manual Use Daily Supplies is deliberately consumption-only; the separate
  //    Forage Drive owns all GM-initiated gathering.
  let foragedByActor = new Map();
  let afterCommitForageAcknowledgements = [];
  if (shouldRunUpkeepForaging({ manual, environment: env })) {
    const forageWindow = await runForagingWindow({ env, party, cfg });
    foragedByActor = forageWindow.foragedByActor;
    afterCommitForageAcknowledgements =
      forageWindow.afterCommitAcknowledgements;
  }

  // The foraging window may wait on remote players. Reload the canonical rules
  // and resolved routing, then fail closed if the roll belongs to an outdated
  // resource context.
  const currentCfg = loadResourceConfig();
  const currentState = loadRunState();
  const currentRoster = getPartyRoster(currentCfg);
  if (
    resourceOperationFingerprint({
      config: currentCfg,
      state: currentState,
      roster: currentRoster,
      environmentId:
        resolveCurrentEnvironment(currentCfg, currentState)?.id ?? null,
    }) !== operationFingerprint
  ) {
    return blockChangedResourceContext("daily upkeep");
  }
  cfg = currentCfg;
  roster = currentRoster;
  consumers = roster.filter((member) => member.consumes);
  party = consumers.map((member) => member.actor);
  inventoryActors = roster.map((member) => member.actor);
  actorById = new Map(inventoryActors.map((actor) => [actor.id, actor]));
  sourceForMember = new Map(
    consumers.map((member) => [
      member.actor.id,
      actorById.get(member.drawFromId) ?? member.actor,
    ]),
  );

  // Re-snapshot inventory immediately before planning the first write.
  const lateConflict = blockConflictedResourceWrite({
    config: cfg,
    actors: inventoryActors,
    operation: "daily upkeep",
  });
  if (lateConflict) return lateConflict;

  // 2) Deposit foraged yield onto each forager's DRAW SOURCE — the same sheet
  //    they consume from — so foraging actually tops up the stash they rely on.
  const foodRes = cfg.resources.find((r) => r.forageYields === "food");
  const waterRes = cfg.resources.find((r) => r.forageYields === "water");
  const proposedDeposits = [];
  for (const actor of party) {
    const yld = foragedByActor.get(actor.id);
    if (!yld || !yld.success) continue;
    const sink = sourceForMember.get(actor.id) ?? actor;
    if (foodRes && yld.food > 0) {
      proposedDeposits.push({
        actor: sink,
        resource: foodRes,
        amount: yld.food,
      });
    }
    if (waterRes && yld.water > 0 && cfg.waterEnabled) {
      proposedDeposits.push({
        actor: sink,
        resource: waterRes,
        amount: yld.water,
      });
    }
  }
  let proposedPreflight = await blockConflictedProposedResourceWrite({
    resources: runtimeResourceDefinitions(cfg),
    deposits: proposedDeposits,
    operation: "daily upkeep",
  });
  if (proposedPreflight.blockedResult) {
    return proposedPreflight.blockedResult;
  }

  const writeCfg = loadResourceConfig();
  const writeState = loadRunState();
  const writeRoster = getPartyRoster(writeCfg);
  if (
    resourceOperationFingerprint({
      config: writeCfg,
      state: writeState,
      roster: writeRoster,
      environmentId:
        resolveCurrentEnvironment(writeCfg, writeState)?.id ?? null,
    }) !== operationFingerprint
  ) {
    return blockChangedResourceContext("daily upkeep");
  }
  cfg = writeCfg;
  roster = writeRoster;
  consumers = roster.filter((member) => member.consumes);
  party = consumers.map((member) => member.actor);
  inventoryActors = roster.map((member) => member.actor);
  actorById = new Map(inventoryActors.map((actor) => [actor.id, actor]));
  sourceForMember = new Map(
    consumers.map((member) => [
      member.actor.id,
      actorById.get(member.drawFromId) ?? member.actor,
    ]),
  );
  const reboundDeposits = rebindProposedResourceDeposits(
    proposedDeposits,
    actorById,
    cfg.resources,
  );
  proposedPreflight = await blockConflictedProposedResourceWrite({
    resources: runtimeResourceDefinitions(cfg),
    deposits: reboundDeposits,
    operation: "daily upkeep",
    templatesByResourceId: proposedPreflight.templatesByResourceId,
  });
  if (proposedPreflight.blockedResult) {
    return proposedPreflight.blockedResult;
  }

  const finalCfg = loadResourceConfig();
  const finalState = loadRunState();
  const finalRoster = getPartyRoster(finalCfg);
  if (
    resourceOperationFingerprint({
      config: finalCfg,
      state: finalState,
      roster: finalRoster,
      environmentId:
        resolveCurrentEnvironment(finalCfg, finalState)?.id ?? null,
    }) !== operationFingerprint
  ) {
    return blockChangedResourceContext("daily upkeep");
  }
  cfg = finalCfg;
  roster = finalRoster;
  consumers = roster.filter((member) => member.consumes);
  party = consumers.map((member) => member.actor);
  inventoryActors = roster.map((member) => member.actor);
  actorById = new Map(inventoryActors.map((actor) => [actor.id, actor]));
  sourceForMember = new Map(
    consumers.map((member) => [
      member.actor.id,
      actorById.get(member.drawFromId) ?? member.actor,
    ]),
  );
  const finalConflict = blockConflictedResourceWrite({
    config: cfg,
    actors: inventoryActors,
    operation: "daily upkeep",
  });
  if (finalConflict) return finalConflict;

  const claimConflict = await claimResourceRun({
    runId,
    trigger: manual ? "manual" : "calendar",
    day,
    days,
    operation: "daily upkeep",
    startedAt,
    environment: env,
    actors: buildRunActorSnapshots({
      participants: consumers.map(({ actor }) => ({
        actorId: actor.id,
        name: actor.name,
      })),
      // Party-scope draws may walk the entire roster, while per-character
      // resources can draw from another member's nominated stash.
      writeTargets: inventoryActors.map((actor) => ({
        actorId: actor.id,
        name: actor.name,
      })),
    }),
  });
  if (claimConflict) return claimConflict;
  const assertWriteAllowed = () => assertResourceRunWriteAllowed(runId);

  for (const actor of party) {
    const yld = foragedByActor.get(actor.id);
    if (!yld || !yld.success) continue;
    const sink = sourceForMember.get(actor.id) ?? actor;
    yld.landedFood = 0;
    yld.landedWater = 0;
    yld.depositErrors = [];
    if (foodRes && yld.food > 0) {
      const deposit = await applyResourceDeposit(sink, foodRes, yld.food, {
        templateItem: proposedPreflight.templatesByResourceId.get(foodRes.id),
        assertWriteAllowed,
      });
      yld.landedFood = deposit.deposited;
      if (deposit.error) yld.depositErrors.push(`food ${deposit.error}`);
    }
    if (waterRes && yld.water > 0 && cfg.waterEnabled) {
      const deposit = await applyResourceDeposit(sink, waterRes, yld.water, {
        templateItem: proposedPreflight.templatesByResourceId.get(waterRes.id),
        assertWriteAllowed,
      });
      yld.landedWater = deposit.deposited;
      if (deposit.error) yld.depositErrors.push(`water ${deposit.error}`);
    }
  }

  // 3) Consume the day's supplies across the roster.
  const report = await applyConsumption({
    roster,
    consumers,
    sourceForMember,
    cfg,
    days,
    assertWriteAllowed,
  });

  // Fold foraging into the per-actor report. `attempted` is true for actors who
  // were actually prompted (online owners), so the report can tell "foraged
  // nothing" apart from "didn't forage".
  for (const row of report.perActor) {
    const yld = foragedByActor.get(row.actorId);
    row.foraged = yld
      ? {
          food: yld.landedFood ?? 0,
          water: yld.landedWater ?? 0,
          success: yld.success,
          attempted: true,
          suppressed: yld.suppressed === true,
          errors: yld.depositErrors ?? [],
        }
      : { food: 0, water: 0, success: false, attempted: false };
    if (yld?.depositErrors?.length) row.errors.push(...yld.depositErrors);
  }

  // 4) Suggest exhaustion from shortfalls (GM applies).
  const suggestions = suggestExhaustion({
    shortfalls: report.perActor.map((r) => ({
      actorId: r.actorId,
      name: r.name,
      food: r.canonicalShortfalls?.food ?? r.shortfalls.food ?? 0,
      water: r.canonicalShortfalls?.water ?? r.shortfalls.water ?? 0,
      light: report.party.light?.shortfall ?? 0,
    })),
    days,
  });

  // 5) Persist + broadcast + report.
  const hasErrors =
    report.perActor.some((row) => row.errors?.length > 0) ||
    Object.values(report.party ?? {}).some((entry) => Boolean(entry?.error));
  const result = {
    ...buildUpkeepAuditMetadata({
      day,
      fallbackDay: state.lastSeenDay,
      days,
      manual,
      runId,
    }),
    environmentId: env?.id ?? null,
    resourceSnapshot: cfg.resources.map((resource) => ({
      id: String(resource.id ?? ""),
      label: String(resource.label ?? resource.id ?? ""),
      scope: resource.scope === "party" ? "party" : "per-character",
    })),
    perActor: report.perActor,
    party: report.party,
    suggestions,
    status: hasErrors ? "partial" : "complete",
    hasErrors,
  };
  const receipt = buildUpkeepRunReceipt({ result, environment: env });
  await completeUpkeepRun({ runId, result, receipt });
  emitForageAcknowledgements(afterCommitForageAcknowledgements);
  emitResourceEvent(RESOURCE_EVENTS.STATE_UPDATE, {});
  emitResourceEvent(RESOURCE_EVENTS.UPKEEP_REPORT, {
    day: result.day,
    environmentId: result.environmentId,
  });
  await postUpkeepReport({ env, result, resources: cfg.resources });
  if (hasErrors) {
    globalThis.ui?.notifications?.error(
      "Upkeep completed with inventory write failures. Do not run it again; review the Quartermaster report before continuing.",
    );
  }
  if (suggestions.length > 0) await promptApplyExhaustion(suggestions);
  return result;
}

/**
 * Build the stable audit envelope stored with every upkeep result.
 *
 * `null` is deliberately not coerced to day zero: a manual run without a
 * readable clock falls back to the last observed day instead.
 */
export function buildUpkeepAuditMetadata({
  day = null,
  fallbackDay = null,
  days = 1,
  manual = false,
  runId = null,
  ranAt = null,
} = {}) {
  const explicitDay = integerOrNull(day);
  const previousDay = integerOrNull(fallbackDay);
  const timestamp = integerOrNull(ranAt);
  const resolvedRunId = String(runId ?? "").trim() || generateRunId();
  return {
    runId: resolvedRunId,
    day: explicitDay ?? previousDay,
    days: Math.max(1, wholeAmount(days)),
    trigger: manual ? "manual" : "calendar",
    ranAt: timestamp ?? Date.now(),
  };
}

function resolveCurrentEnvironment(cfg, state) {
  const id =
    state.currentEnvironmentId ||
    getSetting(SETTING_KEYS.RESOURCE_DEFAULT_ENVIRONMENT) ||
    "limited";
  return findEnvironment(cfg.environments, id) ?? cfg.environments[0] ?? null;
}

/* ------------------------------------------------------------------ *
 * Foraging window
 * ------------------------------------------------------------------ */

export function resolveForageRollTargets(
  party,
  {
    allowGmRolls = false,
    resolveOnlineUserId = owningOnlineUserId,
    forageAssignments = [],
    forageTarget = FORAGE_TARGETS.BOTH,
    waterEnabled = true,
  } = {},
) {
  const actors = Array.isArray(party) ? party : [];
  const normalizedAssignments = normalizeForagerAssignments({
    foragers: forageAssignments,
    targetActorIds: actors.map((actor) => actor?.id).filter(Boolean),
    forageTarget,
  });
  const requestedTargetByActor = new Map(
    normalizedAssignments.map((assignment) => [
      assignment.actorId,
      assignment.forageTarget,
    ]),
  );
  return actors
    .filter((actor) => actor?.id)
    .map((actor) => {
      const userId = resolveOnlineUserId(actor);
      const requested = forageTargetChannels(
        requestedTargetByActor.get(actor.id) ?? forageTarget,
      );
      const effectiveTarget =
        requested.food && requested.water && waterEnabled === false
          ? FORAGE_TARGETS.FOOD
          : requested.target;
      return {
        actor,
        userId,
        gmRoll: !userId,
        forageTarget: effectiveTarget,
      };
    })
    .filter((target) => target.userId || allowGmRolls);
}

async function runForagingWindow({
  env,
  party,
  cfg,
  forageTarget = FORAGE_TARGETS.BOTH,
  forageAssignments = [],
  allowGmRolls = false,
}) {
  const foodDc = Number.isFinite(Number(env?.foodDc))
    ? Number(env.foodDc)
    : Number(env?.dc) || 0;
  const waterDc = Number.isFinite(Number(env?.waterDc))
    ? Number(env.waterDc)
    : Number(env?.dc) || 0;
  const promptDcForTarget = (target) => {
    const channels = forageTargetChannels(target);
    if (channels.food && !channels.water) return foodDc;
    if (channels.water && !channels.food) return waterDc;
    return Number.isFinite(Number(env?.dc))
      ? Number(env.dc)
      : Math.max(foodDc, waterDc);
  };
  const out = new Map();
  const targets = resolveForageRollTargets(party, {
    allowGmRolls,
    forageAssignments,
    forageTarget,
    waterEnabled: cfg.waterEnabled !== false,
  });
  if (targets.length === 0) {
    return { foragedByActor: out, afterCommitAcknowledgements: [] };
  }
  const playerTargets = targets.filter((target) => !target.gmRoll);
  const gmTargets = targets.filter((target) => target.gmRoll);

  const runId = generateRunId();
  const expected = new Set(playerTargets.map((t) => t.actor.id));
  // userId -> [expected actorIds]. Results must echo the exact user/actor pair
  // that received the prompt; ownership or a single pending entry never acts
  // as a fallback identity.
  const expectedByUser = new Map();
  for (const t of playerTargets) {
    const list = expectedByUser.get(t.userId) ?? [];
    list.push(t.actor.id);
    expectedByUser.set(t.userId, list);
  }
  const results = new Map();
  let resolveFn = () => {};
  const done = new Promise((res) => {
    resolveFn = res;
  });
  if (playerTargets.length > 0) {
    pendingRuns.set(runId, {
      expected,
      results,
      resolve: resolveFn,
      expectedByUser,
    });
  }

  const state = loadRunState();
  for (const t of playerTargets) {
    emitResourceEvent(RESOURCE_EVENTS.DAY_PROMPT, {
      runId,
      day: state.lastSeenDay,
      targetUserId: t.userId,
      actorId: t.actor.id,
      actorName: t.actor.name,
      environment: {
        id: env.id,
        label: env.label,
        builtIn: env?.builtIn === true,
        dc: promptDcForTarget(t.forageTarget),
        foodDc,
        waterDc,
        forageable: true,
      },
      forageTarget: t.forageTarget,
    });
  }

  // A one-off Forage Drive can be completed between sessions. The active GM
  // rolls selected offline characters locally while any online owners answer
  // their normal targeted prompts. Automatic upkeep never enables this path.
  for (const t of gmTargets) {
    const rolled = await rollSurvivalTotal(t.actor, { chatMessage: true });
    if (!rolled) continue;
    results.set(t.actor.id, {
      rollTotal: rolled.total,
      wisMod: getWisMod(t.actor),
      skipped: false,
    });
  }

  if (playerTargets.length > 0) {
    const timeoutMs = resolveForageTimeoutMs(cfg.forageTimeoutSeconds);
    await Promise.race([done, wait(timeoutMs)]);
    pendingRuns.delete(runId);
  }

  // Resolve each forager's yield (GM rolls the yield dice).
  const perForager = [];
  for (const t of targets) {
    const channels = forageTargetChannels(t.forageTarget);
    const r = results.get(t.actor.id);
    if (!r || r.skipped) {
      perForager.push({
        actorId: t.actor.id,
        name: t.actor.name,
        forageTarget: channels.target,
        food: 0,
        water: 0,
        success: false,
        foodSuccess: false,
        waterSuccess: false,
        foodDc,
        waterDc,
        foodMargin: null,
        waterMargin: null,
        noResponse: !r,
      });
      continue;
    }
    const foodDie = channels.food ? await rollDie(env.yieldFood) : 0;
    const waterDie =
      channels.water && cfg.waterEnabled !== false
        ? await rollDie(env.yieldWater)
        : 0;
    const yld = computeForageYield({
      rollTotal: r.rollTotal,
      dc: env.dc,
      foodDc,
      waterDc,
      wisMod: r.wisMod,
      foodDie,
      waterDie,
      env,
      foodEnabled: channels.food,
      waterEnabled: channels.water && cfg.waterEnabled !== false,
    });
    perForager.push({
      actorId: t.actor.id,
      name: t.actor.name,
      forageTarget: channels.target,
      ...yld,
    });
  }

  const acknowledgements = [];
  for (const entry of combineYields(perForager, cfg.forageMode)) {
    const userId = targets.find((t) => t.actor.id === entry.actorId)?.userId;
    const acknowledgement = buildForageAcknowledgement({
      runId,
      actorId: entry.actorId,
      entry,
      targetUserId: userId,
      noResponse: !results.has(entry.actorId),
    });
    if (!entry.noResponse) {
      out.set(entry.actorId, {
        ...entry,
        food: acknowledgement.food,
        water: acknowledgement.water,
        success: acknowledgement.success,
        // "best" mode zeroes the losing foragers but keeps success=true; carry the
        // suppressed marker so the report can say "gathered, best haul kept" rather
        // than greet a loser with a green "+0 food / +0 water".
        suppressed: acknowledgement.suppressed,
      });
    }
    if (userId) {
      acknowledgements.push(acknowledgement);
    }
  }
  const { immediate, afterCommit } =
    partitionForageAcknowledgements(acknowledgements);
  // Preserve timeout behavior: a player who never answered can close their
  // prompt immediately. Submitted roll outcomes wait until the enclosing drive
  // or upkeep receipt is durably committed.
  emitForageAcknowledgements(immediate);
  return {
    foragedByActor: out,
    afterCommitAcknowledgements: afterCommit,
  };
}

/** Separate neutral timeout acknowledgements from outcomes that imply success. */
export function partitionForageAcknowledgements(acknowledgements = []) {
  const immediate = [];
  const afterCommit = [];
  for (const acknowledgement of Array.isArray(acknowledgements)
    ? acknowledgements
    : []) {
    if (!acknowledgement || typeof acknowledgement !== "object") continue;
    if (acknowledgement.noResponse === true) immediate.push(acknowledgement);
    else afterCommit.push(acknowledgement);
  }
  return { immediate, afterCommit };
}

function emitForageAcknowledgements(acknowledgements = []) {
  for (const acknowledgement of Array.isArray(acknowledgements)
    ? acknowledgements
    : []) {
    if (!String(acknowledgement?.targetUserId ?? "").trim()) continue;
    emitResourceEvent(RESOURCE_EVENTS.FORAGE_ACK, acknowledgement);
  }
}

/**
 * Convert the stored forage-response timeout to milliseconds. Zero is an
 * intentional immediate-timeout value accepted by resource configuration;
 * only missing or non-numeric values fall back to two minutes.
 */
export function resolveForageTimeoutMs(value) {
  const seconds = Number(value);
  return Math.max(0, Number.isFinite(seconds) ? seconds : 120) * 1000;
}

/** GM-side: record a player's Survival total; resolve the window when complete. */
async function handleForageResult(payload) {
  const validation = validateForageResultPayload(payload);
  if (!validation.ok) {
    console.warn(`${MODULE_ID} | rejected forage result`, {
      type: payload?.type ?? null,
      reason: validation.reason,
      originUserId:
        typeof payload?.originUserId === "string"
          ? payload.originUserId.slice(0, 160)
          : null,
    });
    return;
  }
  const { runId } = payload ?? {};
  const run = pendingRuns.get(runId);
  if (!run) return;
  const actorId = resolveExpectedForageActorId(run, payload);
  if (!actorId) return;
  const actor = globalThis.game?.actors?.get?.(actorId);
  const user = globalThis.game?.users?.get?.(payload.originUserId);
  // `resolveExpectedForageActorId` proves this active user was sent this exact
  // actor prompt. A generic OWNER check here would let Assistant GMs through
  // Foundry's role-level permission bypass.
  if (!actor || !user || user.active === false) return;
  run.results.set(actorId, {
    rollTotal: payload.rollTotal,
    // Recompute the Wisdom modifier from the GM-owned actor — never trust the
    // client's self-reported wisMod (it feeds the yield + success margin).
    wisMod: getWisMod(actor),
    skipped: payload.skipped === true,
  });
  if (run.results.size >= run.expected.size) run.resolve();
}

/**
 * Bind a response to the actor(s) that were actually targeted to its
 * transport-authenticated user. Shared ownership alone never lets one player
 * answer for another player's prompt, and the first accepted answer wins.
 */
export function resolveExpectedForageActorId(run, payload) {
  const userId = String(payload?.originUserId ?? "").trim();
  const mine = run?.expectedByUser?.get?.(userId) ?? [];
  const pending = mine.filter(
    (id) => run?.expected?.has?.(id) && !run?.results?.has?.(id),
  );
  const claimed = String(payload?.actorId ?? "").trim();
  return claimed && pending.includes(claimed) ? claimed : null;
}

/** Defense-in-depth for direct calls that bypass the resource socket router. */
export function validateForageResultPayload(payload) {
  if (payload?.type !== RESOURCE_EVENTS.FORAGE_RESULT) {
    return { ok: false, reason: "invalid-forage-result-type" };
  }
  return validateResourcePayloadShape(payload);
}

/* ------------------------------------------------------------------ *
 * Consumption + deposit
 * ------------------------------------------------------------------ */

export async function applyConsumption({
  roster,
  consumers = roster.filter((member) => member.consumes !== false),
  sourceForMember,
  cfg,
  days,
  assertWriteAllowed = null,
}) {
  const perActorMap = new Map();
  const ensureRow = (member) => {
    const actor = member.actor;
    let row = perActorMap.get(actor.id);
    if (!row) {
      row = {
        actorId: actor.id,
        name: actor.name,
        consumed: {},
        shortfalls: {},
        canonicalConsumed: { food: 0, water: 0 },
        canonicalShortfalls: { food: 0, water: 0 },
        errors: [],
      };
      perActorMap.set(actor.id, row);
    }
    return row;
  };
  const sourceFor = (member) =>
    sourceForMember?.get(member.actor.id) ?? member.actor;

  const partyReport = {};

  for (const resource of cfg.resources) {
    if (resource.id === "water" && cfg.waterEnabled === false) continue;
    if (resource.forageYields === "water" && cfg.waterEnabled === false)
      continue;

    const base = Math.max(0, resource.perDay * days);
    // Half rations stretch food; savings accrue across multi-day advances.
    const isFood = resource.forageYields === "food" || resource.id === "food";
    const amount =
      isFood && cfg.halfRations ? Math.ceil(base / 2) : Math.round(base);
    if (amount <= 0) continue;

    if (resource.scope === "party") {
      const res = await consumePartyResource(roster, resource, amount, {
        assertWriteAllowed,
      });
      partyReport[resource.id] = res;
    } else {
      // Each member draws from its nominated source (own sheet or a shared
      // stash). Sequential awaits mean members sharing a stash deplete it in
      // roster order — whoever's last comes up short if the stash runs dry.
      const blockedSources = new Map();
      const knownAvailableBySource = new Map();
      const knownShortfallsByActor = new Map();
      for (const member of consumers) {
        const source = sourceFor(member);
        if (!knownAvailableBySource.has(source)) {
          const available = matchResourceItems(
            actorItemSnapshots(source),
            resource,
          ).reduce((total, match) => total + wholeAmount(match.quantity), 0);
          knownAvailableBySource.set(source, available);
        }
        const available = knownAvailableBySource.get(source) ?? 0;
        const planned = Math.min(amount, available);
        knownAvailableBySource.set(source, Math.max(0, available - planned));
        knownShortfallsByActor.set(
          member.actor.id,
          Math.max(0, amount - planned),
        );
      }
      for (const member of consumers) {
        const source = sourceFor(member);
        const blockedError = blockedSources.get(source) ?? "";
        const knownShortfall =
          knownShortfallsByActor.get(member.actor.id) ?? amount;
        const res = blockedError
          ? { consumed: 0, shortfall: knownShortfall, error: blockedError }
          : await consumeFromActor(source, resource, amount, {
              assertWriteAllowed,
            });
        if (res.error) res.shortfall = knownShortfall;
        if (res.error && !blockedError) {
          blockedSources.set(
            source,
            `${source?.name ?? "Shared draw source"}: a prior inventory write needs review; this draw was skipped`,
          );
        }
        const row = ensureRow(member);
        recordConsumptionAccounting(row, resource, res);
      }
    }
  }

  // Make sure every roster member has a row even if they matched no resources.
  for (const member of consumers) ensureRow(member);

  // Legacy aliases remain available when a custom forage channel has no
  // literal food/water resource id. Default resources already own these keys.
  const resourceIds = new Set(cfg.resources.map((resource) => resource.id));
  for (const row of perActorMap.values()) {
    if (!resourceIds.has("food")) {
      row.consumed.food = row.canonicalConsumed.food;
      row.shortfalls.food = row.canonicalShortfalls.food;
    }
    if (!resourceIds.has("water")) {
      row.consumed.water = row.canonicalConsumed.water;
      row.shortfalls.water = row.canonicalShortfalls.water;
    }
  }

  return { perActor: [...perActorMap.values()], party: partyReport };
}

/**
 * Record one committed consumption result without mixing the configured
 * resource id with the canonical food/water rule channels.
 *
 * The configured values power generic reports while the canonical totals feed
 * exhaustion. Keeping them separate prevents the default `food` and `water`
 * resources from being counted twice.
 */
export function recordConsumptionAccounting(row, resource, result) {
  if (!row || !resource) return row;
  const resourceId = String(resource.id ?? "").trim();
  if (!resourceId) return row;

  const consumed = wholeAmount(result?.consumed);
  const shortfall = wholeAmount(result?.shortfall);
  row.consumed ??= {};
  row.shortfalls ??= {};
  row.canonicalConsumed ??= { food: 0, water: 0 };
  row.canonicalShortfalls ??= { food: 0, water: 0 };
  row.errors ??= [];

  row.consumed[resourceId] = consumed;
  row.shortfalls[resourceId] = shortfall;
  if (result?.error) {
    row.errors.push(
      `${resource.label ?? prettyResource(resourceId) ?? resourceId}: ${result.error}`,
    );
  }

  if (resource.forageYields === "food" || resourceId === "food") {
    row.canonicalConsumed.food += consumed;
    row.canonicalShortfalls.food += shortfall;
  }
  if (resource.forageYields === "water" || resourceId === "water") {
    row.canonicalConsumed.water += consumed;
    row.canonicalShortfalls.water += shortfall;
  }
  return row;
}

async function consumeFromActor(
  actor,
  resourceDef,
  amount,
  { assertWriteAllowed = null } = {},
) {
  const matches = matchResourceItems(actorItemSnapshots(actor), resourceDef);
  const plan = planConsumption({ matches, amount });
  const applied = await applyConsumptionOps(actor, plan.ops, matches, {
    assertWriteAllowed,
  });
  return {
    consumed: applied.consumed,
    // A rejected or uncertain write is not proof that supplies were absent.
    // Only the immutable pre-write plan can establish a real shortage.
    shortfall: wholeAmount(plan.shortfall),
    error: applied.error,
  };
}

/**
 * Party-scope draw (e.g. torches): drain from the nominated stash carriers
 * first, then everyone else, in turn. With no stash flagged this is just the
 * whole roster in order (the original behavior).
 */
async function consumePartyResource(
  roster,
  resourceDef,
  amount,
  { assertWriteAllowed = null } = {},
) {
  const seen = new Set();
  const order = [];
  for (const r of roster) {
    if (r.isStash && !seen.has(r.actor.id)) {
      seen.add(r.actor.id);
      order.push(r.actor);
    }
  }
  for (const r of roster) {
    if (!seen.has(r.actor.id)) {
      seen.add(r.actor.id);
      order.push(r.actor);
    }
  }
  let remaining = amount;
  let consumed = 0;
  const errors = [];
  let knownRemaining = wholeAmount(amount);
  for (const actor of order) {
    if (knownRemaining <= 0) break;
    const plan = planConsumption({
      matches: matchResourceItems(actorItemSnapshots(actor), resourceDef),
      amount: knownRemaining,
    });
    knownRemaining = wholeAmount(plan.shortfall);
  }
  for (const actor of order) {
    if (remaining <= 0) break;
    const res = await consumeFromActor(actor, resourceDef, remaining, {
      assertWriteAllowed,
    });
    consumed += res.consumed;
    remaining -= res.consumed;
    if (res.error) {
      errors.push(`${actor.name}: ${res.error}`);
      // The state is now uncertain. Do not charge a second Actor for the same
      // party requirement or continue a partially applied write sequence.
      break;
    }
  }
  return {
    consumed,
    shortfall:
      errors.length > 0 ? knownRemaining : Math.max(0, wholeAmount(remaining)),
    error: errors.join("; "),
  };
}

export async function applyConsumptionOps(
  actor,
  ops,
  matches = [],
  { assertWriteAllowed = null } = {},
) {
  const quantities = new Map(
    matches.map((match) => [
      String(match.id),
      Math.max(0, Number(match.quantity) || 0),
    ]),
  );
  const matchesById = new Map(
    matches.map((match) => [String(match.id), match]),
  );
  const deletes = ops.filter((o) => o.op === "delete").map((o) => o.id);
  const updatePlans = ops
    .filter((o) => o.op === "decrement")
    .map((operation) => {
      const id = String(operation.id);
      const before = quantities.get(id) ?? 0;
      const expected = wholeAmount(operation.to);
      return {
        id,
        before,
        expected,
        planned: Math.max(0, before - expected),
      };
    });
  let consumed = 0;
  const failures = [];
  if (updatePlans.length > 0) {
    assertWriteAllowed?.();
    let updatedDocuments = [];
    try {
      // Foundry normalizes embedded update objects in place. Keep the accounting
      // plan immutable and give the database backend a disposable payload.
      updatedDocuments = await actor.updateEmbeddedDocuments(
        "Item",
        updatePlans.map((plan) => ({
          _id: plan.id,
          "system.quantity": plan.expected,
        })),
      );
    } catch (error) {
      console.error(
        `${MODULE_ID} | consumption update failed on ${actor?.name}`,
        error,
      );
    }
    const updatedById = new Map(
      (Array.isArray(updatedDocuments) ? updatedDocuments : [])
        .map((document) => [documentId(document), document])
        .filter(([id]) => id),
    );
    const hasCanonicalItems = hasCanonicalActorItems(actor);
    for (const plan of updatePlans) {
      const { id, before, expected, planned } = plan;
      const canonicalDocument = hasCanonicalItems
        ? findActorItem(actor, id)
        : null;
      const document = hasCanonicalItems
        ? canonicalDocument
        : updatedById.get(id);
      const after = canonicalDocument
        ? documentQuantity(canonicalDocument)
        : hasCanonicalItems
          ? 0
          : documentQuantity(document);
      if (after != null) {
        const observed = Math.max(0, before - after);
        consumed += Math.min(planned, observed);
      }
      if (after !== expected) {
        failures.push({
          operation: "update",
          itemId: id,
          itemName: matchesById.get(id)?.name,
          before,
          expected,
          observed: after,
          reason: after == null ? "unconfirmed" : "unexpected-quantity",
        });
      }
    }
  }
  // The decrement is intentionally verified before destructive stack deletes.
  // If it diverges, stop: continuing could overburn resources while reporting
  // only the planned amount.
  if (deletes.length > 0 && failures.length === 0) {
    assertWriteAllowed?.();
    let deletedDocuments = [];
    try {
      deletedDocuments = await actor.deleteEmbeddedDocuments("Item", deletes);
    } catch (error) {
      console.error(
        `${MODULE_ID} | consumption delete failed on ${actor?.name}`,
        error,
      );
    }
    const deletedIds = new Set(
      (Array.isArray(deletedDocuments) ? deletedDocuments : [])
        .map(documentId)
        .filter(Boolean),
    );
    const hasCanonicalItems = hasCanonicalActorItems(actor);
    for (const idValue of deletes) {
      const id = String(idValue);
      const before = quantities.get(id) ?? 0;
      const canonicalDocument = hasCanonicalItems
        ? findActorItem(actor, id)
        : null;
      const confirmedDeleted = hasCanonicalItems
        ? !canonicalDocument
        : deletedIds.has(id);
      const after = confirmedDeleted ? 0 : documentQuantity(canonicalDocument);
      if (after != null) {
        consumed += Math.min(before, Math.max(0, before - after));
      }
      if (!confirmedDeleted) {
        failures.push({
          operation: "delete",
          itemId: id,
          itemName: matchesById.get(id)?.name,
          before,
          expected: 0,
          observed: after,
          reason: after == null ? "unconfirmed" : "not-deleted",
        });
      }
    }
  }
  return {
    consumed,
    error: summarizeInventoryWriteFailures(failures),
    failures,
  };
}

export async function depositResource(
  actor,
  resourceDef,
  amount,
  { templateItem = null, assertWriteAllowed = null } = {},
) {
  const result = await applyResourceDeposit(actor, resourceDef, amount, {
    templateItem,
    assertWriteAllowed,
  });
  return result.deposited;
}

async function applyResourceDeposit(
  actor,
  resourceDef,
  amount,
  { templateItem = null, assertWriteAllowed = null } = {},
) {
  const requested = wholeAmount(amount);
  if (requested <= 0) return { deposited: 0, error: "" };
  const effectiveResourceDef = withEffectiveResourceTag(resourceDef);
  const matches = matchResourceItems(
    actorItemSnapshots(actor),
    effectiveResourceDef,
  );
  let plan = planDeposit({ matches, amount: requested });
  if (plan.op === "none") {
    const template =
      cloneSnapshot(templateItem) ??
      (await resolveResourceDepositTemplate(effectiveResourceDef));
    plan = planDeposit({ matches, amount: requested, templateItem: template });
  }
  if (plan.op === "bump" || plan.op === "create") {
    assertWriteAllowed?.();
  }
  if (plan.op === "bump") {
    const target = findActorItem(actor, plan.id);
    if (!target || typeof target.update !== "function") {
      return unconfirmedDeposit(requested, 0, "the target stack disappeared");
    }
    const before = wholeAmount(
      matches.find((match) => String(match.id) === String(plan.id))?.quantity,
    );
    let updated = null;
    try {
      updated = await target.update({ "system.quantity": plan.to });
    } catch (error) {
      console.error(`${MODULE_ID} | deposit failed on ${actor?.name}`, error);
    }
    const canonical = hasCanonicalActorItems(actor)
      ? findActorItem(actor, plan.id)
      : updated || target;
    const after = documentQuantity(canonical);
    const deposited =
      after == null ? 0 : Math.min(requested, Math.max(0, after - before));
    const identityConfirmed =
      documentId(canonical) === String(plan.id) &&
      resourceItemMatchesDefinition(canonical, effectiveResourceDef);
    if (
      identityConfirmed &&
      after === wholeAmount(plan.to) &&
      deposited === requested
    ) {
      return { deposited, error: "" };
    }
    const detail = !identityConfirmed
      ? "the target stack no longer matched this resource"
      : after == null
        ? "the final stack quantity could not be read"
        : `the stack ended at ${after}, expected ${wholeAmount(plan.to)}`;
    return unconfirmedDeposit(
      requested,
      identityConfirmed ? deposited : 0,
      detail,
    );
  }
  if (plan.op === "create") {
    const snap = buildCreatedResourceSnapshot({
      template: plan.from,
      resourceDef: effectiveResourceDef,
      quantity: plan.quantity,
    });
    if (!snap) {
      return unconfirmedDeposit(
        requested,
        0,
        "no safe item template was available",
      );
    }
    if (!hasCanonicalActorItems(actor)) {
      return unconfirmedDeposit(
        requested,
        0,
        "the Actor inventory could not be read canonically",
      );
    }
    const itemId = createResourceItemId(actor);
    if (!itemId) {
      return unconfirmedDeposit(
        requested,
        0,
        "a collision-safe item id could not be reserved",
      );
    }
    snap._id = itemId;
    try {
      await actor.createEmbeddedDocuments("Item", [snap], {
        keepId: true,
        keepEmbeddedIds: true,
      });
    } catch (error) {
      console.error(`${MODULE_ID} | deposit failed on ${actor?.name}`, error);
    }
    const confirmed = findActorItem(actor, itemId);
    const quantity = documentQuantity(confirmed);
    const deposited =
      quantity == null ? 0 : Math.min(requested, wholeAmount(quantity));
    const identityConfirmed =
      documentId(confirmed) === itemId &&
      resourceItemHasEffectiveTag(confirmed, effectiveResourceDef);
    if (
      identityConfirmed &&
      quantity === wholeAmount(plan.quantity) &&
      deposited === requested
    ) {
      return { deposited, error: "" };
    }
    const detail = !identityConfirmed
      ? "the created stack did not match this resource"
      : quantity == null
        ? "the created stack could not be identified in inventory"
        : `the created stack held ${quantity}, expected ${wholeAmount(plan.quantity)}`;
    return unconfirmedDeposit(
      requested,
      identityConfirmed ? deposited : 0,
      detail,
    );
  }
  return unconfirmedDeposit(
    requested,
    0,
    "no safe deposit operation was available",
  );
}

function unconfirmedDeposit(requested, deposited, detail) {
  const confirmed = Math.min(wholeAmount(requested), wholeAmount(deposited));
  return {
    deposited: confirmed,
    error: `deposit needs review (${confirmed} of ${wholeAmount(requested)} confirmed; ${detail})`,
  };
}

function summarizeInventoryWriteFailures(failures) {
  if (!Array.isArray(failures) || failures.length === 0) return "";
  const count = failures.length;
  const details = failures
    .slice(0, 3)
    .map((failure) => {
      const item =
        String(failure?.itemName ?? "").trim() ||
        `Item ${String(failure?.itemId ?? "unknown")}`;
      if (failure?.reason === "unconfirmed") {
        return `${item} was not confirmed`;
      }
      if (failure?.operation === "delete") {
        return `${item} remained at ${failure?.observed ?? "an unknown quantity"}`;
      }
      return `${item} ended at ${failure?.observed ?? "an unknown quantity"}, expected ${failure?.expected ?? "the planned quantity"}`;
    })
    .join("; ");
  const remainder = count > 3 ? `; ${count - 3} more` : "";
  return `${count} inventory write${count === 1 ? "" : "s"} need review: ${details}${remainder}`;
}

async function resolveResourceDepositTemplate(resourceDef) {
  const firstUuid = resourceDef?.matching?.itemUuids?.[0];
  if (firstUuid) {
    try {
      const doc = await globalThis.fromUuid?.(firstUuid);
      const template = doc?.toObject?.() ?? null;
      if (template) return template;
    } catch {
      // Fall through to the stable module-owned default.
    }
  }
  return defaultResourceTemplate(resourceDef);
}

function buildCreatedResourceSnapshot({ template, resourceDef, quantity }) {
  const snap = cloneSnapshot(template);
  if (!snap) return null;
  delete snap._id;
  delete snap.id;
  delete snap.uuid;
  snap.system = snap.system ?? {};
  snap.system.quantity = wholeAmount(quantity);
  snap.flags = snap.flags ?? {};
  snap.flags[MODULE_ID] = {
    ...(snap.flags[MODULE_ID] ?? {}),
    resourceTag: effectiveResourceTag(resourceDef),
  };
  return snap;
}

function documentQuantity(document) {
  const raw =
    document?.system?.quantity ?? document?._source?.system?.quantity ?? null;
  if (raw === null || raw === undefined || raw === "") return null;
  const quantity = Number(raw);
  return Number.isFinite(quantity) ? wholeAmount(quantity) : null;
}

function documentId(document) {
  if (typeof document === "string") return document.trim();
  return String(
    document?.id ?? document?._id ?? document?._source?._id ?? "",
  ).trim();
}

function effectiveResourceTag(resourceDef) {
  return (
    String(resourceDef?.matching?.flagTag ?? resourceDef?.id ?? "").trim() ||
    String(resourceDef?.id ?? "").trim()
  );
}

function withEffectiveResourceTag(resourceDef) {
  const tag = effectiveResourceTag(resourceDef);
  if (resourceDef?.matching?.flagTag === tag) return resourceDef;
  return {
    ...(resourceDef ?? {}),
    matching: {
      ...(resourceDef?.matching ?? {}),
      flagTag: tag,
    },
  };
}

function resourceItemHasEffectiveTag(document, resourceDef) {
  const expected = effectiveResourceTag(resourceDef);
  const observed = String(
    document?.flags?.[MODULE_ID]?.resourceTag ??
      document?._source?.flags?.[MODULE_ID]?.resourceTag ??
      "",
  ).trim();
  return Boolean(expected) && observed === expected;
}

function resourceItemMatchesDefinition(document, resourceDef) {
  if (!document) return false;
  const id = documentId(document);
  return matchResourceItems(
    actorItemSnapshots({ items: [document] }),
    resourceDef,
  ).some((match) => String(match.id) === id);
}

function createResourceItemId(actor) {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const foundryId = String(globalThis.foundry?.utils?.randomID?.() ?? "")
      .replace(/[^a-z0-9]/gi, "")
      .slice(0, 16);
    let candidate = foundryId;
    if (candidate.length !== 16) {
      const alphabet =
        "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
      candidate = "";
      for (let index = 0; index < 16; index += 1) {
        candidate += alphabet[Math.floor(Math.random() * alphabet.length)];
      }
    }
    if (!findActorItem(actor, candidate)) return candidate;
  }
  return "";
}

function actorItemDocuments(actor) {
  const items = actor?.items;
  if (Array.isArray(items)) return items;
  if (Array.isArray(items?.contents)) return items.contents;
  if (typeof items?.values === "function") return [...items.values()];
  return [];
}

function hasCanonicalActorItems(actor) {
  const items = actor?.items;
  return Boolean(
    items &&
    (Array.isArray(items) ||
      Array.isArray(items.contents) ||
      typeof items.get === "function" ||
      typeof items.values === "function"),
  );
}

function findActorItem(actor, idValue) {
  const id = String(idValue ?? "").trim();
  if (!id) return null;
  const direct = actor?.items?.get?.(id);
  if (direct) return direct;
  return (
    actorItemDocuments(actor).find((document) => documentId(document) === id) ??
    null
  );
}

function defaultResourceTemplate(resourceDef) {
  const label = String(
    resourceDef?.label ?? resourceDef?.id ?? "Supply",
  ).trim();
  return {
    name: label,
    type: "loot",
    img: "icons/containers/bags/sack-simple-leather-brown.webp",
    system: {
      quantity: 1,
      weight: { value: 0, units: "lb" },
      price: { value: 0, denomination: "gp" },
      description: { value: "Created by Infinity D&D5e Quartermaster." },
    },
  };
}

/* ------------------------------------------------------------------ *
 * Reporting + exhaustion
 * ------------------------------------------------------------------ */

async function postUpkeepReport({ env, result, resources = [] }) {
  if (typeof globalThis.ChatMessage?.create !== "function") return null;
  const content = buildUpkeepReportContent({ env, result, resources });
  const speaker = globalThis.ChatMessage.getSpeaker?.({
    alias: "Quartermaster",
  });
  const messageData = { content, speaker };
  const whisper = resolveReportWhisper(result);
  if (whisper !== null) messageData.whisper = whisper;
  try {
    return await globalThis.ChatMessage.create(messageData);
  } catch (error) {
    console.warn(`${MODULE_ID} | upkeep report failed`, error);
    return null;
  }
}

/**
 * Render an upkeep receipt from configured resources instead of assuming the
 * only individual supplies are food and water.
 */
export function buildUpkeepReportContent({
  env = null,
  result = {},
  resources = [],
} = {}) {
  const envLabel = env ? prettyEnvironment(env.id) || env.label : "—";
  const definitions = Array.isArray(resources) ? resources : [];
  const byId = new Map(
    definitions.map((resource) => [String(resource.id), resource]),
  );
  let individualResources = definitions.filter(
    (resource) => resource?.scope !== "party",
  );
  if (individualResources.length === 0) {
    const ids = new Set();
    for (const row of result.perActor ?? []) {
      for (const id of Object.keys(row?.shortfalls ?? {})) ids.add(id);
    }
    individualResources = [...ids].map((id) => ({ id, label: null }));
  }

  const actorReports = (result.perActor ?? []).map((row) => {
    const shortages = individualResources
      .map((resource) => {
        const amount = wholeAmount(row?.shortfalls?.[resource.id]);
        if (amount <= 0) return null;
        return `${amount} ${escapeHtml(resourceDisplayLabel(resource))}`;
      })
      .filter(Boolean);
    const hasErrors = Array.isArray(row?.errors) && row.errors.length > 0;
    const hasShortages = shortages.length > 0;
    const outcome = classifyResourceOutcome({ hasErrors, hasShortages });
    const statusLabel =
      outcome === RESOURCE_OUTCOMES.NEEDS_REVIEW
        ? `<span style="color:#f2bd61;">needs review</span>`
        : outcome === RESOURCE_OUTCOMES.SHORT
          ? `<span style="color:#ef6f74;">short ${shortages.join(", ")}</span>`
          : `<span style="color:#6dd5a2;">supplied</span>`;
    const knownShortage =
      outcome === RESOURCE_OUTCOMES.NEEDS_REVIEW && hasShortages
        ? ` · <span style="color:#ef6f74;">confirmed short ${shortages.join(", ")}</span>`
        : "";
    const forageLabel = buildForageReportLabel(row?.foraged);
    const errorLabel = hasErrors
      ? ` · <span style="color:#f2bd61;">inventory write needs review</span>`
      : "";
    return {
      hasErrors,
      hasShortages,
      html: `<li><strong>${escapeHtml(row?.name ?? "Unknown")}</strong> — ${statusLabel}${knownShortage}${forageLabel}${errorLabel}</li>`,
    };
  });
  const rows = actorReports.map((row) => row.html).join("");

  const partyReports = Object.entries(result.party ?? {})
    .filter(([, entry]) => wholeAmount(entry?.shortfall) > 0 || entry?.error)
    .map(([id, entry]) => {
      const definition = byId.get(String(id)) ?? { id, label: null };
      const label = escapeHtml(resourceDisplayLabel(definition));
      const shortfall = wholeAmount(entry?.shortfall);
      const hasErrors = Boolean(entry?.error);
      const hasShortages = shortfall > 0;
      const outcome = classifyResourceOutcome({ hasErrors, hasShortages });
      const status =
        outcome === RESOURCE_OUTCOMES.NEEDS_REVIEW
          ? `<span style="color:#f2bd61;">needs review</span>`
          : `<span style="color:#ef6f74;">${shortfall} short</span>`;
      const knownShortage =
        outcome === RESOURCE_OUTCOMES.NEEDS_REVIEW && hasShortages
          ? ` · <span style="color:#ef6f74;">confirmed ${shortfall} short</span>`
          : "";
      const error = hasErrors
        ? ` · <span style="color:#f2bd61;">inventory write needs review</span>`
        : "";
      return {
        hasErrors,
        hasShortages,
        html: `<div><strong>${label}:</strong> ${status}${knownShortage}${error}</div>`,
      };
    });
  const partyLines = partyReports.map((entry) => entry.html).join("");
  const hasErrors =
    result.hasErrors === true ||
    result.status === "partial" ||
    actorReports.some((row) => row.hasErrors) ||
    partyReports.some((entry) => entry.hasErrors);
  const hasShortages =
    actorReports.some((row) => row.hasShortages) ||
    partyReports.some((entry) => entry.hasShortages);
  const reportOutcome = classifyResourceOutcome({ hasErrors, hasShortages });
  const days = Math.max(1, wholeAmount(result.days));
  const daysLabel = days > 1 ? ` (${days} days)` : "";
  const title = `Daily Supplies — ${resourceOutcomeLabel(reportOutcome)}${daysLabel}`;
  const tone =
    reportOutcome === RESOURCE_OUTCOMES.NEEDS_REVIEW
      ? "warning"
      : reportOutcome === RESOURCE_OUTCOMES.SHORT
        ? "danger"
        : "success";
  const nextAction = hasErrors
    ? "Open Quartermaster and review the flagged inventory writes."
    : hasShortages
      ? "Review the shortages and follow the exhaustion prompt if one appears."
      : "No further action is needed.";
  return buildInfinityChatCard({
    title,
    outcome: `${resourceOutcomeLabel(reportOutcome)}${daysLabel}.`,
    audience: describeChatAudience(
      getSetting(SETTING_KEYS.RESOURCE_REPORT_MODE) ?? "whisper-gm",
    ),
    details: markTrustedChatHtml(`
      <div>Environment: ${escapeHtml(envLabel)}</div>
      <ul>${rows}</ul>
      ${partyLines}`),
    nextAction,
    tone,
    classes: ["infinity-quartermaster-receipt", "infinity-upkeep-receipt"],
  });
}

function resourceDisplayLabel(resource) {
  const id = String(resource?.id ?? "").trim();
  return (
    String(resource?.label ?? "").trim() || prettyResource(id) || id || "Supply"
  );
}

function buildForageReportLabel(forage) {
  if (!forage?.attempted) return "";
  if (forage.suppressed) {
    return ` · <span style="opacity:0.7;">gathered; best haul kept</span>`;
  }
  if (!forage.success) {
    return ` · <span style="opacity:0.7;">foraged; found nothing</span>`;
  }
  const gathered = [];
  const food = wholeAmount(forage.food);
  const water = wholeAmount(forage.water);
  if (food > 0) gathered.push(`+${food} food`);
  if (water > 0) gathered.push(`+${water} water`);
  const summary =
    gathered.length > 0 ? `foraged ${gathered.join(" / ")}` : "foraged";
  return ` · <span style="color:#6dd5a2;">${summary}</span>`;
}

function resolveReportWhisper(result) {
  return resolveWhisperForActors(
    (result?.perActor ?? []).map((r) => r.actorId),
  );
}

/** Whisper recipient ids for the configured report mode, over a set of affected
 *  actors. Returns null for the public mode (no whisper). */
function resolveWhisperForActors(actorIds) {
  const mode = String(
    getSetting(SETTING_KEYS.RESOURCE_REPORT_MODE) ?? "whisper-gm",
  );
  if (mode === "public") return null;
  const users = globalThis.game?.users;
  // null = public (no whisper); an empty array would whisper to NOBODY (Foundry
  // does not treat whisper:[] as public), hiding the report from everyone.
  if (!users) return null;
  const gmIds = users.filter((user) => isFullGM(user)).map((user) => user.id);
  if (mode === "whisper-gm") return gmIds;
  // whisper-gm-owner: GMs + each affected character's owner.
  const out = new Set(gmIds);
  for (const actorId of actorIds ?? []) {
    const actor = globalThis.game?.actors?.get?.(actorId);
    if (!actor) continue;
    for (const u of users) {
      if (!isFullGM(u) && actor.testUserPermission?.(u, "OWNER")) out.add(u.id);
    }
  }
  return [...out];
}

async function promptApplyExhaustion(suggestions) {
  const names = suggestions
    .map((s) => `${escapeHtml(s.name)} (+${s.suggestDelta})`)
    .join(", ");
  if (!isInfinityDialogAvailable("confirm")) {
    globalThis.ui?.notifications?.warn(
      `${names} should gain exhaustion. Apply it manually, then record that the recovery step is complete.`,
    );
    return;
  }
  const ok = await confirmInfinityDialog({
    window: { title: "Apply Exhaustion?", icon: "fa-solid fa-face-tired" },
    content: `<p>The following characters went without food or water and should gain exhaustion:</p><p><strong>${names}</strong></p><p>Apply it now?</p>`,
  });
  if (!ok) return;
  for (const s of suggestions) {
    const actor = globalThis.game?.actors?.get?.(s.actorId);
    if (!actor) continue;
    await applyExhaustion(actor, s.suggestDelta);
  }
}

async function applyExhaustion(actor, delta) {
  try {
    const current = Number(actor.system?.attributes?.exhaustion) || 0;
    const next = Math.max(0, Math.min(6, current + (Number(delta) || 0)));
    if (next === current) return;
    await actor.update({ "system.attributes.exhaustion": next });
  } catch (error) {
    console.error(
      `${MODULE_ID} | exhaustion update failed on ${actor?.name}`,
      error,
    );
  }
}

/* ------------------------------------------------------------------ *
 * Party discovery + small helpers
 * ------------------------------------------------------------------ */

/** The non-full-GM user whose assigned character is this actor, or any such user
 *  holding an explicit OWNER permission on it — the real "a player owns this"
 *  test. Bare `hasPlayerOwner` misses characters owned only by an Assistant-GM
 *  (user.isGM is true for role 3) and is the kept-as-fallback last resort. */
export function isPlayerOwnedCharacter(actor) {
  if (actor?.type !== "character") return false;
  const users = globalThis.game?.users;
  const list =
    typeof users?.filter === "function"
      ? users.filter(() => true)
      : Array.from(users ?? []);
  const charId = (u) =>
    typeof u?.character === "string" ? u.character : (u?.character?.id ?? null);
  // (a) a non-GM user has this as their assigned character.
  if (list.some((u) => u && !isFullGM(u) && charId(u) === actor.id))
    return true;
  // (b) a non-GM user holds an explicit per-user OWNER permission.
  const OWNER = globalThis.CONST?.DOCUMENT_OWNERSHIP_LEVELS?.OWNER ?? 3;
  const ownerById = (id) =>
    list.find((u) => u?.id === id) ?? users?.get?.(id) ?? null;
  const ownership = actor?.ownership ?? {};
  for (const [userId, level] of Object.entries(ownership)) {
    if (userId === "default") continue;
    if (Number(level) >= OWNER && !isFullGM(ownerById(userId))) return true;
  }
  // (c) fallback — UNCONDITIONAL, so default-owned PCs still count (do NOT gate
  //     this on users.length === 0 the way the TokenBar compat does).
  return actor?.hasPlayerOwner === true;
}

/** Player-owned character actors (the roster's auto-discovery default). */
export function discoverPlayerCharacters() {
  const actors = globalThis.game?.actors;
  if (typeof actors?.filter !== "function") return [];
  return actors.filter((actor) => isPlayerOwnedCharacter(actor));
}

/** Every actor in the world — the pool the GM can manually add to the roster
 *  (NPCs, vehicles, group actors, unowned actors), not just player characters. */
export function discoverAllActors() {
  const actors = globalThis.game?.actors;
  if (typeof actors?.filter !== "function") return [];
  return actors.filter((actor) => actor && typeof actor.id === "string");
}

/**
 * The tracked party as roster entries with their resolved draw source:
 * `[{ actor, isStash, consumes, drawFromId }]`, where `drawFromId` is the actor
 * id each consuming member's per-character supplies are drawn from. A tracked
 * actor may be inventory-only (`consumes:false`), which lets a mule, vehicle,
 * or NPC stash hold supplies without becoming another mouth to feed. Legacy
 * rows infer consumption from player-character ownership until the GM makes an
 * explicit choice. Missing actors are dropped, and a stale draw source falls
 * back to self.
 */
export function getPartyRoster(config = null) {
  const cfg = config ?? loadResourceConfig();
  const roster = Array.isArray(cfg.roster) ? cfg.roster : [];
  // Auto-discovery (no curated roster) defaults to player-owned characters for
  // least surprise; a CURATED roster resolves against every actor, so the GM
  // can pin NPCs / unowned / non-player actors as supply sources too.
  const byId = new Map(discoverAllActors().map((actor) => [actor.id, actor]));

  let entries;
  if (roster.length === 0) {
    entries = discoverPlayerCharacters().map((actor) => ({
      actor,
      isStash: false,
      consumes: true,
      drawFromId: actor.id,
    }));
  } else {
    const resolved = roster
      .map((entry) => ({ entry, actor: byId.get(entry.actorId) }))
      .filter((r) => r.actor);
    const presentStash = new Set(
      resolved.filter((r) => r.entry.isStash).map((r) => r.actor.id),
    );
    entries = resolved.map(({ entry, actor }) => {
      const wanted = resolveDrawSourceId(entry);
      const drawFromId =
        wanted !== actor.id && presentStash.has(wanted) ? wanted : actor.id;
      const consumes =
        entry.consumes === true
          ? true
          : entry.consumes === false
            ? false
            : isPlayerOwnedCharacter(actor);
      return {
        actor,
        isStash: entry.isStash === true,
        consumes,
        drawFromId,
      };
    });
  }

  // Single shared party stash: when it's set to a tracked actor, the WHOLE
  // party draws every per-character supply from that one pile — overriding
  // every per-member nomination — and it counts as a stash for party-scope
  // pooling too. An unset/stale id leaves per-member draws.
  const partyStashId = String(cfg.partyStashId ?? "").trim();
  if (partyStashId && entries.some((e) => e.actor.id === partyStashId)) {
    for (const e of entries) {
      e.drawFromId = partyStashId;
      if (e.actor.id === partyStashId) e.isStash = true;
    }
  }

  return entries;
}

/** Tracked party actors (honors the curated roster). */
export function discoverPartyActors() {
  return getPartyRoster()
    .filter((member) => member.consumes)
    .map((member) => member.actor);
}

/** The online user who owns this actor (assigned char first), or null. An
 *  Assistant GM may forage only as their explicitly assigned character; GM-role
 *  permission bypass never makes an unassigned character theirs. */
export function owningOnlineUserId(actor) {
  const users = globalThis.game?.users;
  if (!users?.filter) return null;
  const localId = globalThis.game?.user?.id ?? null;
  const online = users.filter((u) => u && u.active && u.id !== localId);
  const assigned = online.find((u) => {
    const charId =
      typeof u.character === "string" ? u.character : (u.character?.id ?? null);
    return charId === actor.id;
  });
  if (assigned) return assigned.id;
  const owner = online.find(
    (u) => u.isGM !== true && hasDirectActorOwnerPermission(actor, u.id),
  );
  return owner?.id ?? null;
}

function hasDirectActorOwnerPermission(actor, userId) {
  const id = String(userId ?? "").trim();
  if (!id) return false;
  const ownership = actor?.ownership ?? {};
  const level = Object.hasOwn(ownership, id)
    ? ownership[id]
    : ownership.default;
  const OWNER = globalThis.CONST?.DOCUMENT_OWNERSHIP_LEVELS?.OWNER ?? 3;
  return Number(level) >= Number(OWNER);
}

export function actorItemSnapshots(actor) {
  const items = actor?.items?.contents ?? actor?.items ?? [];
  const list = Array.isArray(items) ? items : Array.from(items ?? []);
  return list.map((item) => {
    const snapshot =
      typeof item?.toObject === "function" ? item.toObject() : item;
    // Foundry's synthetic Document UUID is not guaranteed to survive
    // `toObject()`, but exact matcher rules intentionally accept embedded UUIDs.
    if (
      item?.uuid &&
      snapshot &&
      typeof snapshot === "object" &&
      !snapshot.uuid
    ) {
      return { ...snapshot, uuid: item.uuid };
    }
    return snapshot;
  });
}

/** Evaluate a yield die formula ("1d6", "0", "2") to a number; 0 on failure. */
async function rollDie(formula) {
  const f = String(formula ?? "0").trim();
  if (!f || f === "0") return 0;
  const Roll = globalThis.Roll;
  if (typeof Roll !== "function") {
    // No Foundry Roll available — degrade to the average so yields aren't zero.
    const m = /^(\d+)d(\d+)$/.exec(f);
    if (m) return Math.round((Number(m[1]) * (Number(m[2]) + 1)) / 2);
    const n = Number(f);
    return Number.isFinite(n) ? n : 0;
  }
  try {
    const roll = await new Roll(f).evaluate();
    const total = Number(roll.total);
    return Number.isFinite(total) ? total : 0;
  } catch {
    return 0;
  }
}

function wholeAmount(value) {
  return Math.max(0, Math.floor(Number(value) || 0));
}

function integerOrNull(value) {
  if (value === null || value === undefined || value === "") return null;
  const number = Number(value);
  return Number.isFinite(number) ? Math.floor(number) : null;
}

function cloneSnapshot(value) {
  if (!value || typeof value !== "object") return null;
  if (typeof structuredClone === "function") return structuredClone(value);
  return JSON.parse(JSON.stringify(value));
}

function wait(ms) {
  return new Promise((resolve) => {
    if (typeof globalThis.setTimeout === "function") {
      globalThis.setTimeout(resolve, Math.max(0, ms));
    } else {
      resolve();
    }
  });
}

function generateRunId() {
  const part = () =>
    Math.floor(Math.random() * 0x100000)
      .toString(16)
      .padStart(5, "0");
  return `qm-${part()}${part()}`;
}
