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
  buildForageAcknowledgement,
  computeForageYield,
  combineYields,
  forageTargetChannels,
  FORAGE_TARGETS,
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
  RESOURCE_EVENTS,
  emitResourceEvent,
  subscribe,
  isAuthoritativeGM,
  validateResourcePayloadShape,
} from "./socket.js";
import { SETTING_KEYS, getSetting } from "../settings.js";
import { escapeHtml, prettyEnvironment, prettyResource } from "../ui-util.js";
import { isFullGM } from "../permissions.js";

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
      // Auto-upkeep off: keep the baseline current so the GM's manual Advance
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
 * Manual "Advance Day" — runs one day of upkeep immediately, independent of the
 * world clock and the auto-trigger setting. GM-only.
 */
export async function advanceDayNow() {
  if (!isAuthoritativeGM()) {
    globalThis.ui?.notifications?.warn(
      `${MODULE_ID}: only the active GM can run daily upkeep.`,
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

/** Manual Advance Day is consumption-only; calendar upkeep may still forage. */
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
  const roster = getPartyRoster(cfg);
  return {
    defaultDc: Number.isFinite(dc) && dc > 0 ? dc : 15,
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
 * water sources and adding rations to the designated stash. Unlike Advance Day
 * this is gather-only: it consumes nothing and doesn't tick the day. GM-only.
 *
 * @param {object} args
 * @param {number} args.dc - the Survival DC the GM set for this drive.
 * @param {string[]} args.targetActorIds - roster actor ids to send the check to.
 * @param {"food-water"|"food"|"water"} args.forageTarget - supplies to gather.
 */
export async function runForageDrive({
  dc,
  targetActorIds,
  forageTarget,
} = {}) {
  if (!isAuthoritativeGM()) {
    globalThis.ui?.notifications?.warn(
      `${MODULE_ID}: only the active GM can run a forage drive.`,
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
    return await runForageDriveInner({ dc, targetActorIds, forageTarget });
  } finally {
    upkeepInFlight = false;
  }
}

async function runForageDriveInner({ dc, targetActorIds, forageTarget }) {
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
  const wanted = new Set(
    (Array.isArray(targetActorIds) ? targetActorIds : []).map((id) =>
      String(id),
    ),
  );
  let selected = roster.filter(
    (member) => member.consumes && wanted.has(member.actor.id),
  );
  if (selected.length === 0) {
    globalThis.ui?.notifications?.info(
      `${MODULE_ID}: no foragers selected for the drive.`,
    );
    return null;
  }
  const party = selected.map((r) => r.actor);
  const channels = forageTargetChannels(forageTarget);
  const configuredFood = cfg.resources.some((r) => r.forageYields === "food");
  const configuredWater =
    cfg.waterEnabled !== false &&
    cfg.resources.some((r) => r.forageYields === "water");
  if (
    (channels.food && !configuredFood) ||
    (channels.water && !configuredWater)
  ) {
    globalThis.ui?.notifications?.warn(
      `${MODULE_ID}: the selected forage supplies are not enabled and configured.`,
    );
    return null;
  }

  // Build the drive environment: the GM-set DC overrides the region DC, but keep
  // the current region's yield dice (defaulting to 1d6 when the party is somewhere
  // that normally can't be foraged — the GM is explicitly overriding that here).
  const baseEnv = resolveCurrentEnvironment(cfg, state);
  const baseForageable = isForageable(baseEnv);
  const gmDc = Math.floor(Number(dc));
  const driveEnv = {
    id: baseEnv?.id ?? "forage-drive",
    label: baseEnv?.label ?? "Foraging drive",
    dc: Number.isFinite(gmDc) && gmDc >= 0 ? gmDc : (baseEnv?.dc ?? 15),
    forageable: true,
    yieldFood: channels.food
      ? baseForageable
        ? baseEnv.yieldFood
        : "1d6"
      : "0",
    yieldWater: channels.water
      ? baseForageable
        ? baseEnv.yieldWater
        : "1d6"
      : "0",
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

  const foragedByActor = await runForagingWindow({
    env: driveEnv,
    party,
    cfg,
    forageTarget: channels.target,
    allowGmRolls: true,
  });

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

  const foodRes = channels.food
    ? cfg.resources.find((r) => r.forageYields === "food")
    : null;
  const waterRes = channels.water
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
      food: y.food,
      water: y.water,
      success: y.success,
      suppressed: y.suppressed,
    })),
    partyStashId: cfg.partyStashId,
    foodEnabled: channels.food && Boolean(foodRes),
    waterEnabled:
      channels.water && cfg.waterEnabled !== false && Boolean(waterRes),
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
      })),
      writeTargets: depositTargets.map((actor) => ({
        actorId: actor.id,
        name: actor.name,
      })),
    }),
    forageTarget: channels.target,
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
      const applied = await depositResource(sink, foodRes, dep.food, {
        templateItem: proposedPreflight.templatesByResourceId.get(foodRes.id),
        assertWriteAllowed,
      });
      landedFood += applied;
      if (applied < dep.food)
        depositErrors.push(`${sink.name}: food deposit failed`);
    }
    if (waterRes && dep.water > 0) {
      const applied = await depositResource(sink, waterRes, dep.water, {
        templateItem: proposedPreflight.templatesByResourceId.get(waterRes.id),
        assertWriteAllowed,
      });
      landedWater += applied;
      if (applied < dep.water)
        depositErrors.push(`${sink.name}: water deposit failed`);
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
    forageTarget: channels.target,
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
  emitResourceEvent(RESOURCE_EVENTS.STATE_UPDATE, {});
  await postForageDriveReport({
    env: driveEnv,
    perForager: plan.perForager,
    stashActor,
    totalFood: landedFood,
    totalWater: landedWater,
    depositErrors,
    forageTarget: channels.target,
  });
  return {
    runId,
    dc: driveEnv.dc,
    perForager: plan.perForager,
    totalFood: landedFood,
    totalWater: landedWater,
    depositErrors,
    stashActor,
    forageTarget: channels.target,
  };
}

async function postForageDriveReport({
  env,
  perForager,
  stashActor,
  totalFood,
  totalWater,
  depositErrors = [],
  forageTarget = FORAGE_TARGETS.BOTH,
}) {
  if (typeof globalThis.ChatMessage?.create !== "function") return null;
  const channels = forageTargetChannels(forageTarget);
  const formatYield = (food, water) => {
    if (channels.food && channels.water)
      return `+${food} food / +${water} water`;
    if (channels.food) return `+${food} food`;
    return `+${water} water`;
  };
  const rows = perForager
    .map((f) => {
      const name = `<strong>${escapeHtml(f.name)}</strong>`;
      if (!f.attempted) {
        return `<li>${name} — <span style="opacity:0.7;">no online owner to roll</span></li>`;
      }
      if (f.suppressed) {
        return `<li>${name} — <span style="opacity:0.7;">gathered, but the best haul was kept</span></li>`;
      }
      if (!f.success) {
        return `<li>${name} — <span style="color:#ef6f74;">found nothing</span></li>`;
      }
      return `<li>${name} — <span style="color:#6dd5a2;">${formatYield(f.food, f.water)}</span></li>`;
    })
    .join("");
  const dest = stashActor
    ? `Added to <strong>${escapeHtml(stashActor.name)}</strong>'s stash`
    : "Added to each forager's pack";
  const errorLine = depositErrors.length
    ? `<div style="color:#f2bd61;">Some deposits failed: ${escapeHtml(depositErrors.join("; "))}</div>`
    : "";
  const content = `
    <div class="infinity-dnd5e infinity-quartermaster-receipt">
      <h3 style="margin:0 0 4px;">Forage Drive — DC ${escapeHtml(env.dc)}</h3>
      <ul style="margin:4px 0; padding-left:18px;">${rows}</ul>
      <div>${dest}: <strong>${formatYield(totalFood, totalWater)}</strong> total.</div>
      ${errorLine}
    </div>`;
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
    `${MODULE_ID}: ${label} paused because the resource rules or roster changed while players were responding. Review Quartermaster and retry.`,
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
    `${MODULE_ID}: ${label} paused because an earlier resource run did not finish cleanly. Review Quartermaster and clear the interrupted-run lock before trying again.`,
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
    `${MODULE_ID}: ${label} skipped because day ${day} was already reserved by another GM client. No supplies were changed.`,
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
    `${MODULE_ID}: ${label} paused. ${first.message}${more} Open Quartermaster to fix the resource rules.`,
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
    `${MODULE_ID}: ${label} paused before depositing supplies. ${first.message}${more} Open Quartermaster to fix the resource rules.`,
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
      `${MODULE_ID}: no player characters found for daily upkeep.`,
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
  //    Manual Advance Day is deliberately consumption-only; the separate
  //    Forage Drive owns all GM-initiated gathering.
  let foragedByActor = new Map();
  if (shouldRunUpkeepForaging({ manual, environment: env })) {
    foragedByActor = await runForagingWindow({ env, party, cfg });
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
      yld.landedFood = await depositResource(sink, foodRes, yld.food, {
        templateItem: proposedPreflight.templatesByResourceId.get(foodRes.id),
        assertWriteAllowed,
      });
      if (yld.landedFood < yld.food)
        yld.depositErrors.push("food deposit failed");
    }
    if (waterRes && yld.water > 0 && cfg.waterEnabled) {
      yld.landedWater = await depositResource(sink, waterRes, yld.water, {
        templateItem: proposedPreflight.templatesByResourceId.get(waterRes.id),
        assertWriteAllowed,
      });
      if (yld.landedWater < yld.water)
        yld.depositErrors.push("water deposit failed");
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
  emitResourceEvent(RESOURCE_EVENTS.STATE_UPDATE, {});
  emitResourceEvent(RESOURCE_EVENTS.UPKEEP_REPORT, {
    day: result.day,
    environmentId: result.environmentId,
  });
  await postUpkeepReport({ env, result, resources: cfg.resources });
  if (hasErrors) {
    globalThis.ui?.notifications?.error(
      `${MODULE_ID}: upkeep completed with inventory write failures. Review the Quartermaster report before continuing.`,
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
  { allowGmRolls = false, resolveOnlineUserId = owningOnlineUserId } = {},
) {
  return (Array.isArray(party) ? party : [])
    .filter((actor) => actor?.id)
    .map((actor) => {
      const userId = resolveOnlineUserId(actor);
      return { actor, userId, gmRoll: !userId };
    })
    .filter((target) => target.userId || allowGmRolls);
}

async function runForagingWindow({
  env,
  party,
  cfg,
  forageTarget = FORAGE_TARGETS.BOTH,
  allowGmRolls = false,
}) {
  const requested = forageTargetChannels(forageTarget);
  const effectiveTarget =
    requested.food && requested.water && cfg.waterEnabled === false
      ? FORAGE_TARGETS.FOOD
      : requested.target;
  const channels = forageTargetChannels(effectiveTarget);
  const out = new Map();
  const targets = resolveForageRollTargets(party, { allowGmRolls });
  if (targets.length === 0) return out; // no eligible online or GM-rolled target
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
        dc: env.dc,
        forageable: true,
      },
      forageTarget: channels.target,
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
    const r = results.get(t.actor.id);
    if (!r || r.skipped) {
      perForager.push({
        actorId: t.actor.id,
        name: t.actor.name,
        food: 0,
        water: 0,
        success: false,
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
      wisMod: r.wisMod,
      foodDie,
      waterDie,
      env,
      foodEnabled: channels.food,
      waterEnabled: channels.water && cfg.waterEnabled !== false,
    });
    perForager.push({ actorId: t.actor.id, name: t.actor.name, ...yld });
  }

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
      // `noResponse` distinguishes a GM timeout from an active skip.
      emitResourceEvent(RESOURCE_EVENTS.FORAGE_ACK, acknowledgement);
    }
  }
  return out;
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
      for (const member of consumers) {
        const res = await consumeFromActor(
          sourceFor(member),
          resource,
          amount,
          { assertWriteAllowed },
        );
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
    shortfall: Math.max(0, Math.floor(Number(amount) || 0) - applied.consumed),
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
  for (const actor of order) {
    if (remaining <= 0) break;
    const res = await consumeFromActor(actor, resourceDef, remaining, {
      assertWriteAllowed,
    });
    consumed += res.consumed;
    remaining -= res.consumed;
    if (res.error) errors.push(`${actor.name}: ${res.error}`);
  }
  return {
    consumed,
    shortfall: Math.max(0, remaining),
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
  const deletes = ops.filter((o) => o.op === "delete").map((o) => o.id);
  const updates = ops
    .filter((o) => o.op === "decrement")
    .map((o) => ({ _id: o.id, "system.quantity": o.to }));
  let consumed = 0;
  const failures = [];
  if (updates.length > 0) {
    assertWriteAllowed?.();
    try {
      const updatedDocuments = await actor.updateEmbeddedDocuments(
        "Item",
        updates,
      );
      const updatedById = new Map(
        (Array.isArray(updatedDocuments) ? updatedDocuments : [])
          .map((document) => [documentId(document), document])
          .filter(([id]) => id),
      );
      for (const update of updates) {
        const id = String(update._id);
        const document = updatedById.get(id);
        const after = documentQuantity(document);
        if (!document || after == null) {
          failures.push(new Error(`update for Item ${id} was not confirmed`));
          continue;
        }
        const before = quantities.get(id) ?? 0;
        const expected = Math.max(0, Number(update["system.quantity"]) || 0);
        const planned = Math.max(0, before - expected);
        const observed = Math.max(0, before - after);
        consumed += Math.min(planned, observed);
        if (after !== expected) {
          failures.push(
            new Error(
              `update for Item ${id} ended at ${after}, expected ${expected}`,
            ),
          );
        }
      }
    } catch (error) {
      failures.push(error);
      console.error(
        `${MODULE_ID} | consumption update failed on ${actor?.name}`,
        error,
      );
    }
  }
  if (deletes.length > 0) {
    assertWriteAllowed?.();
    try {
      const deletedDocuments = await actor.deleteEmbeddedDocuments(
        "Item",
        deletes,
      );
      const deletedIds = new Set(
        (Array.isArray(deletedDocuments) ? deletedDocuments : [])
          .map(documentId)
          .filter(Boolean),
      );
      for (const idValue of deletes) {
        const id = String(idValue);
        if (!deletedIds.has(id)) {
          failures.push(new Error(`delete for Item ${id} was not confirmed`));
          continue;
        }
        consumed += quantities.get(id) ?? 0;
      }
    } catch (error) {
      failures.push(error);
      console.error(
        `${MODULE_ID} | consumption delete failed on ${actor?.name}`,
        error,
      );
    }
  }
  return {
    consumed,
    error:
      failures.length > 0 ? `${failures.length} inventory write(s) failed` : "",
  };
}

export async function depositResource(
  actor,
  resourceDef,
  amount,
  { templateItem = null, assertWriteAllowed = null } = {},
) {
  if (!amount || amount <= 0) return 0;
  const matches = matchResourceItems(actorItemSnapshots(actor), resourceDef);
  let plan = planDeposit({ matches, amount });
  if (plan.op === "none") {
    const template =
      cloneSnapshot(templateItem) ??
      (await resolveResourceDepositTemplate(resourceDef));
    plan = planDeposit({ matches, amount, templateItem: template });
  }
  if (plan.op === "bump" || plan.op === "create") {
    assertWriteAllowed?.();
  }
  try {
    if (plan.op === "bump") {
      const target = actor.items?.get?.(plan.id);
      if (!target || typeof target.update !== "function") return 0;
      const before =
        matches.find((match) => String(match.id) === String(plan.id))
          ?.quantity ?? 0;
      const updated = await target.update({ "system.quantity": plan.to });
      if (!updated) return 0;
      const after = documentQuantity(updated) ?? documentQuantity(target);
      return after == null
        ? wholeAmount(amount)
        : Math.min(
            wholeAmount(amount),
            Math.max(0, after - wholeAmount(before)),
          );
    }
    if (plan.op === "create") {
      const snap = buildCreatedResourceSnapshot({
        template: plan.from,
        resourceDef,
        quantity: plan.quantity,
      });
      if (!snap) return 0;
      const created = await actor.createEmbeddedDocuments("Item", [snap]);
      if (!Array.isArray(created) || created.length === 0) return 0;
      const quantity = documentQuantity(created[0]);
      return quantity == null
        ? wholeAmount(amount)
        : Math.min(wholeAmount(amount), quantity);
    }
  } catch (error) {
    console.error(`${MODULE_ID} | deposit failed on ${actor?.name}`, error);
  }
  return 0; // op "none": no existing stack and no template to create from
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
    resourceTag: resourceDef?.matching?.flagTag || resourceDef?.id,
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
  return String(document?.id ?? document?._id ?? "").trim();
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

  const rows = (result.perActor ?? [])
    .map((row) => {
      const shortages = individualResources
        .map((resource) => {
          const amount = wholeAmount(row?.shortfalls?.[resource.id]);
          if (amount <= 0) return null;
          return `${amount} ${escapeHtml(resourceDisplayLabel(resource))}`;
        })
        .filter(Boolean);
      const shortLabel =
        shortages.length > 0
          ? `<span style="color:#ef6f74;">short ${shortages.join(", ")}</span>`
          : `<span style="color:#6dd5a2;">supplied</span>`;
      const forageLabel = buildForageReportLabel(row?.foraged);
      const errorLabel = row?.errors?.length
        ? ` · <span style="color:#f2bd61;">write failed: ${escapeHtml(row.errors.join("; "))}</span>`
        : "";
      return `<li><strong>${escapeHtml(row?.name ?? "Unknown")}</strong> — ${shortLabel}${forageLabel}${errorLabel}</li>`;
    })
    .join("");

  const partyLines = Object.entries(result.party ?? {})
    .filter(([, entry]) => wholeAmount(entry?.shortfall) > 0 || entry?.error)
    .map(([id, entry]) => {
      const definition = byId.get(String(id)) ?? { id, label: null };
      const label = escapeHtml(resourceDisplayLabel(definition));
      const shortfall = wholeAmount(entry?.shortfall);
      const shortage =
        shortfall > 0
          ? `<span style="color:#ef6f74;">${label}: ${shortfall} short.</span>`
          : "";
      const separator = shortage && entry?.error ? " · " : "";
      const error = entry?.error
        ? `<span style="color:#f2bd61;">${label}: ${escapeHtml(entry.error)}.</span>`
        : "";
      return `<div>${shortage}${separator}${error}</div>`;
    })
    .join("");
  const days = Math.max(1, wholeAmount(result.days));
  const daysLabel = days > 1 ? ` (${days} days)` : "";
  return `
    <div class="infinity-dnd5e infinity-quartermaster-receipt">
      <h3 style="margin:0 0 4px;">Daily Supplies — ${escapeHtml(envLabel)}${daysLabel}</h3>
      <ul style="margin:4px 0; padding-left:18px;">${rows}</ul>
      ${partyLines}
    </div>`;
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
  const DialogV2 = globalThis.foundry?.applications?.api?.DialogV2;
  const names = suggestions
    .map((s) => `${escapeHtml(s.name)} (+${s.suggestDelta})`)
    .join(", ");
  if (typeof DialogV2?.confirm !== "function") {
    globalThis.ui?.notifications?.warn(
      `${MODULE_ID}: ${names} should gain exhaustion (apply manually).`,
    );
    return;
  }
  let ok = false;
  try {
    ok = await DialogV2.confirm({
      window: { title: "Apply Exhaustion?", icon: "fa-solid fa-face-tired" },
      content: `<p>The following characters went without food or water and should gain exhaustion:</p><p><strong>${names}</strong></p><p>Apply it now?</p>`,
      rejectClose: false,
    });
  } catch {
    ok = false;
  }
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
