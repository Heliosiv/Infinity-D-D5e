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
  setLastSeenDay,
  setLastUpkeepResult,
} from "./store.js";
import { findEnvironment, isForageable } from "./environment.js";
import {
  computeForageYield,
  combineYields,
  planForageDriveDeposits,
} from "./forage.js";
import { getWisMod } from "./roll.js";
import {
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
} from "./socket.js";
import { SETTING_KEYS, getSetting } from "../settings.js";
import { prettyEnvironment } from "../ui-util.js";

const MODULE_ID = "infinity-dnd5e";

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
      await runDailyUpkeep({ elapsedDays: days, config });
      await setLastSeenDay(current);
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
  if (upkeepInFlight) return null;
  upkeepInFlight = true;
  try {
    return await runDailyUpkeep({ elapsedDays: 1, manual: true });
  } finally {
    upkeepInFlight = false;
  }
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
    candidates: roster.map(({ actor }) => ({
      actorId: actor.id,
      name: actor.name,
      online: Boolean(owningOnlineUserId(actor)),
    })),
  };
}

/**
 * The single actor a forage drive deposits the whole haul onto: the configured
 * party food/water stash, else the first roster member flagged as a stash, else
 * null (meaning "no shared pile — give each forager their own haul"). Mirrors the
 * draw-source model the daily upkeep already uses.
 */
function resolveDriveStashActor(cfg, roster) {
  const byId = new Map(roster.map((r) => [r.actor.id, r.actor]));
  const partyStashId = String(cfg.partyStashId ?? "").trim();
  if (partyStashId && byId.has(partyStashId)) return byId.get(partyStashId);
  return roster.find((r) => r.isStash)?.actor ?? null;
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
 */
export async function runForageDrive({ dc, targetActorIds } = {}) {
  if (!isAuthoritativeGM()) {
    globalThis.ui?.notifications?.warn(
      `${MODULE_ID}: only the active GM can run a forage drive.`,
    );
    return null;
  }
  if (upkeepInFlight) return null;
  upkeepInFlight = true;
  try {
    return await runForageDriveInner({ dc, targetActorIds });
  } finally {
    upkeepInFlight = false;
  }
}

async function runForageDriveInner({ dc, targetActorIds }) {
  const cfg = loadResourceConfig();
  const state = loadRunState();
  const roster = getPartyRoster(cfg);

  // The drive only forages tracked members; resolve the GM's selection to them.
  const wanted = new Set(
    (Array.isArray(targetActorIds) ? targetActorIds : []).map((id) =>
      String(id),
    ),
  );
  const selected = roster.filter((r) => wanted.has(r.actor.id));
  if (selected.length === 0) {
    globalThis.ui?.notifications?.info(
      `${MODULE_ID}: no foragers selected for the drive.`,
    );
    return null;
  }
  const party = selected.map((r) => r.actor);

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
    yieldFood: baseForageable ? baseEnv.yieldFood : "1d6",
    yieldWater: baseForageable ? baseEnv.yieldWater : "1d6",
  };

  const foragedByActor = await runForagingWindow({
    env: driveEnv,
    party,
    cfg,
  });

  const foodRes = cfg.resources.find((r) => r.forageYields === "food");
  const waterRes = cfg.resources.find((r) => r.forageYields === "water");

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
    waterEnabled: cfg.waterEnabled && Boolean(waterRes),
  });

  // Apply the planned deposits against the real actors.
  const actorById = new Map(roster.map((r) => [r.actor.id, r.actor]));
  for (const dep of plan.deposits) {
    const sink = actorById.get(dep.actorId);
    if (!sink) continue;
    if (foodRes && dep.food > 0) await depositResource(sink, foodRes, dep.food);
    if (waterRes && dep.water > 0) {
      await depositResource(sink, waterRes, dep.water);
    }
  }

  const stashActor = plan.stashActorId
    ? (actorById.get(plan.stashActorId) ?? null)
    : null;
  emitResourceEvent(RESOURCE_EVENTS.STATE_UPDATE, {});
  await postForageDriveReport({
    env: driveEnv,
    perForager: plan.perForager,
    stashActor,
    totalFood: plan.totalFood,
    totalWater: plan.totalWater,
  });
  return {
    dc: driveEnv.dc,
    perForager: plan.perForager,
    totalFood: plan.totalFood,
    totalWater: plan.totalWater,
    stashActor,
  };
}

async function postForageDriveReport({
  env,
  perForager,
  stashActor,
  totalFood,
  totalWater,
}) {
  if (typeof globalThis.ChatMessage?.create !== "function") return null;
  const rows = perForager
    .map((f) => {
      const name = `<strong>${escapeText(f.name)}</strong>`;
      if (!f.attempted) {
        return `<li>${name} — <span style="opacity:0.7;">no online owner to roll</span></li>`;
      }
      if (f.suppressed) {
        return `<li>${name} — <span style="opacity:0.7;">gathered, but the best haul was kept</span></li>`;
      }
      if (!f.success) {
        return `<li>${name} — <span style="color:#ef6f74;">found nothing</span></li>`;
      }
      return `<li>${name} — <span style="color:#6dd5a2;">+${f.food} food / +${f.water} water</span></li>`;
    })
    .join("");
  const dest = stashActor
    ? `Added to <strong>${escapeText(stashActor.name)}</strong>'s stash`
    : "Added to each forager's pack";
  const content = `
    <div class="infinity-dnd5e infinity-quartermaster-receipt">
      <h3 style="margin:0 0 4px;">Forage Drive — DC ${escapeText(env.dc)}</h3>
      <ul style="margin:4px 0; padding-left:18px;">${rows}</ul>
      <div>${dest}: <strong>+${totalFood} food / +${totalWater} water</strong> total.</div>
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
 * The upkeep pipeline
 * ------------------------------------------------------------------ */

async function runDailyUpkeep({ elapsedDays = 1, config = null } = {}) {
  const cfg = config ?? loadResourceConfig();
  const days = Math.max(1, Math.floor(Number(elapsedDays) || 1));
  const state = loadRunState();
  const env = resolveCurrentEnvironment(cfg, state);
  const roster = getPartyRoster(cfg);
  const party = roster.map((r) => r.actor);

  if (party.length === 0) {
    globalThis.ui?.notifications?.info(
      `${MODULE_ID}: no player characters found for daily upkeep.`,
    );
    return null;
  }

  // Resolve each member's draw source actor once (own sheet, or a nominated stash).
  const actorById = new Map(party.map((a) => [a.id, a]));
  const sourceForMember = new Map(
    roster.map((r) => [r.actor.id, actorById.get(r.drawFromId) ?? r.actor]),
  );

  // 1) Foraging window (only when the environment allows it).
  let foragedByActor = new Map();
  if (isForageable(env)) {
    foragedByActor = await runForagingWindow({ env, party, cfg });
  }

  // 2) Deposit foraged yield onto each forager's DRAW SOURCE — the same sheet
  //    they consume from — so foraging actually tops up the stash they rely on.
  const foodRes = cfg.resources.find((r) => r.forageYields === "food");
  const waterRes = cfg.resources.find((r) => r.forageYields === "water");
  for (const actor of party) {
    const yld = foragedByActor.get(actor.id);
    if (!yld || !yld.success) continue;
    const sink = sourceForMember.get(actor.id) ?? actor;
    if (foodRes && yld.food > 0) await depositResource(sink, foodRes, yld.food);
    if (waterRes && yld.water > 0 && cfg.waterEnabled) {
      await depositResource(sink, waterRes, yld.water);
    }
  }

  // 3) Consume the day's supplies across the roster.
  const report = await applyConsumption({ roster, sourceForMember, cfg, days });

  // Fold foraging into the per-actor report. `attempted` is true for actors who
  // were actually prompted (online owners), so the report can tell "foraged
  // nothing" apart from "didn't forage".
  for (const row of report.perActor) {
    const yld = foragedByActor.get(row.actorId);
    row.foraged = yld
      ? {
          food: yld.food ?? 0,
          water: yld.water ?? 0,
          success: yld.success,
          attempted: true,
        }
      : { food: 0, water: 0, success: false, attempted: false };
  }

  // 4) Suggest exhaustion from shortfalls (GM applies).
  const suggestions = suggestExhaustion({
    shortfalls: report.perActor.map((r) => ({
      actorId: r.actorId,
      name: r.name,
      food: r.shortfalls.food ?? 0,
      water: r.shortfalls.water ?? 0,
      light: report.party.light?.shortfall ?? 0,
    })),
    days,
  });

  // 5) Persist + broadcast + report.
  const result = {
    day: state.lastSeenDay,
    days,
    environmentId: env?.id ?? null,
    perActor: report.perActor,
    party: report.party,
    suggestions,
    ranAt: null,
  };
  await setLastUpkeepResult(result);
  emitResourceEvent(RESOURCE_EVENTS.STATE_UPDATE, {});
  emitResourceEvent(RESOURCE_EVENTS.UPKEEP_REPORT, {
    day: result.day,
    environmentId: result.environmentId,
  });
  await postUpkeepReport({ env, result });
  if (suggestions.length > 0) await promptApplyExhaustion(suggestions);
  return result;
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

async function runForagingWindow({ env, party, cfg }) {
  const out = new Map();
  const targets = party
    .map((actor) => ({ actor, userId: owningOnlineUserId(actor) }))
    .filter((t) => t.userId);
  if (targets.length === 0) return out; // nobody online to forage

  const runId = generateRunId();
  const expected = new Set(targets.map((t) => t.actor.id));
  // userId -> [expected actorIds], so a result with a missing/mismatched actor
  // id (e.g. a skip after the forager lost their assigned char) can still be
  // attributed when the user has exactly one outstanding actor.
  const expectedByUser = new Map();
  for (const t of targets) {
    const list = expectedByUser.get(t.userId) ?? [];
    list.push(t.actor.id);
    expectedByUser.set(t.userId, list);
  }
  const results = new Map();
  let resolveFn = () => {};
  const done = new Promise((res) => {
    resolveFn = res;
  });
  pendingRuns.set(runId, {
    expected,
    results,
    resolve: resolveFn,
    expectedByUser,
  });

  const state = loadRunState();
  for (const t of targets) {
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
    });
  }

  const timeoutMs = Math.max(0, Number(cfg.forageTimeoutSeconds) || 120) * 1000;
  await Promise.race([done, wait(timeoutMs)]);
  pendingRuns.delete(runId);

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
      });
      continue;
    }
    const foodDie = await rollDie(env.yieldFood);
    const waterDie = await rollDie(env.yieldWater);
    const yld = computeForageYield({
      rollTotal: r.rollTotal,
      dc: env.dc,
      wisMod: r.wisMod,
      foodDie,
      waterDie,
      env,
      waterEnabled: cfg.waterEnabled,
    });
    perForager.push({ actorId: t.actor.id, name: t.actor.name, ...yld });
  }

  for (const entry of combineYields(perForager, cfg.forageMode)) {
    out.set(entry.actorId, {
      food: entry.food ?? 0,
      water: entry.water ?? 0,
      success: Boolean(entry.success),
      // "best" mode zeroes the losing foragers but keeps success=true; carry the
      // suppressed marker so the report can say "gathered, best haul kept" rather
      // than greet a loser with a green "+0 food / +0 water".
      suppressed: Boolean(entry.suppressed),
    });
    const userId = targets.find((t) => t.actor.id === entry.actorId)?.userId;
    if (userId) {
      emitResourceEvent(RESOURCE_EVENTS.FORAGE_ACK, {
        runId,
        actorId: entry.actorId,
        food: entry.food ?? 0,
        water: entry.water ?? 0,
        success: Boolean(entry.success),
        // The forager never answered (GM timed the run out) vs actively skipped —
        // lets their prompt say "wrapped up before you decided", not "empty-handed".
        noResponse: !results.has(entry.actorId),
        targetUserId: userId,
      });
    }
  }
  return out;
}

/** GM-side: record a player's Survival total; resolve the window when complete. */
async function handleForageResult(payload) {
  const { runId } = payload ?? {};
  const run = pendingRuns.get(runId);
  if (!run) return;
  let actorId = payload?.actorId;
  // Tolerate a missing/mismatched actor id (a skip after the forager lost their
  // assigned character, or an older client): if this user has exactly one actor
  // still outstanding, attribute the result to it rather than dropping it (which
  // would stall the whole run on the timeout).
  if (!actorId || !run.expected.has(actorId)) {
    const mine = run.expectedByUser?.get(payload?.originUserId) ?? [];
    const pending = mine.filter((id) => !run.results.has(id));
    if (pending.length === 1) actorId = pending[0];
    else return;
  }
  const actor = globalThis.game?.actors?.get?.(actorId);
  const user = globalThis.game?.users?.get?.(payload.originUserId);
  // Trust the report only when the claiming user actually owns that character.
  if (!actor || !user || !actor.testUserPermission?.(user, "OWNER")) return;
  run.results.set(actorId, {
    rollTotal: Number(payload.rollTotal) || 0,
    // Recompute the Wisdom modifier from the GM-owned actor — never trust the
    // client's self-reported wisMod (it feeds the yield + success margin).
    wisMod: getWisMod(actor),
    skipped: payload.skipped === true,
  });
  if (run.results.size >= run.expected.size) run.resolve();
}

/* ------------------------------------------------------------------ *
 * Consumption + deposit
 * ------------------------------------------------------------------ */

async function applyConsumption({ roster, sourceForMember, cfg, days }) {
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
      const res = await consumePartyResource(roster, resource, amount);
      partyReport[resource.id] = res;
    } else {
      // Each member draws from its nominated source (own sheet or a shared
      // stash). Sequential awaits mean members sharing a stash deplete it in
      // roster order — whoever's last comes up short if the stash runs dry.
      for (const member of roster) {
        const res = await consumeFromActor(sourceFor(member), resource, amount);
        const row = ensureRow(member);
        row.consumed[resource.id] = res.consumed;
        row.shortfalls[resource.id] = res.shortfall;
        // Normalize the canonical food/water keys the report/exhaustion expect.
        if (isFood) {
          row.consumed.food = res.consumed;
          row.shortfalls.food = res.shortfall;
        }
        if (resource.forageYields === "water" || resource.id === "water") {
          row.consumed.water = res.consumed;
          row.shortfalls.water = res.shortfall;
        }
      }
    }
  }

  // Make sure every roster member has a row even if they matched no resources.
  for (const member of roster) ensureRow(member);

  return { perActor: [...perActorMap.values()], party: partyReport };
}

async function consumeFromActor(actor, resourceDef, amount) {
  const matches = matchResourceItems(actorItemSnapshots(actor), resourceDef);
  const plan = planConsumption({ matches, amount });
  await applyConsumptionOps(actor, plan.ops);
  return { consumed: plan.consumed, shortfall: plan.shortfall };
}

/**
 * Party-scope draw (e.g. torches): drain from the nominated stash carriers
 * first, then everyone else, in turn. With no stash flagged this is just the
 * whole roster in order (the original behavior).
 */
async function consumePartyResource(roster, resourceDef, amount) {
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
  for (const actor of order) {
    if (remaining <= 0) break;
    const res = await consumeFromActor(actor, resourceDef, remaining);
    consumed += res.consumed;
    remaining -= res.consumed;
  }
  return { consumed, shortfall: Math.max(0, remaining) };
}

async function applyConsumptionOps(actor, ops) {
  const deletes = ops.filter((o) => o.op === "delete").map((o) => o.id);
  const updates = ops
    .filter((o) => o.op === "decrement")
    .map((o) => ({ _id: o.id, "system.quantity": o.to }));
  try {
    if (updates.length > 0) {
      await actor.updateEmbeddedDocuments("Item", updates);
    }
    if (deletes.length > 0) {
      await actor.deleteEmbeddedDocuments("Item", deletes);
    }
  } catch (error) {
    console.error(
      `${MODULE_ID} | consumption write failed on ${actor?.name}`,
      error,
    );
  }
}

async function depositResource(actor, resourceDef, amount) {
  if (!amount || amount <= 0) return 0;
  const matches = matchResourceItems(actorItemSnapshots(actor), resourceDef);
  let template = null;
  const firstUuid = resourceDef.matching?.itemUuids?.[0];
  if (firstUuid) {
    try {
      const doc = await fromUuid(firstUuid);
      template = doc?.toObject?.() ?? null;
    } catch {
      template = null;
    }
  }
  const plan = planDeposit({ matches, amount, templateItem: template });
  try {
    if (plan.op === "bump") {
      await actor.items
        ?.get?.(plan.id)
        ?.update?.({ "system.quantity": plan.to });
      return amount;
    }
    if (plan.op === "create") {
      const snap = cloneSnapshot(plan.from);
      if (!snap) return 0;
      delete snap._id;
      delete snap.id;
      delete snap.uuid;
      snap.system = snap.system ?? {};
      snap.system.quantity = plan.quantity;
      snap.flags = snap.flags ?? {};
      snap.flags[MODULE_ID] = {
        ...(snap.flags[MODULE_ID] ?? {}),
        resourceTag: resourceDef.matching?.flagTag || resourceDef.id,
      };
      await actor.createEmbeddedDocuments("Item", [snap]);
      return amount;
    }
  } catch (error) {
    console.error(`${MODULE_ID} | deposit failed on ${actor?.name}`, error);
  }
  return 0; // op "none": no existing stack and no template to create from
}

/* ------------------------------------------------------------------ *
 * Reporting + exhaustion
 * ------------------------------------------------------------------ */

async function postUpkeepReport({ env, result }) {
  if (typeof globalThis.ChatMessage?.create !== "function") return null;
  const envLabel = env ? prettyEnvironment(env.id) || env.label : "—";
  const rows = result.perActor
    .map((r) => {
      const parts = [];
      if (r.foraged?.success && (r.foraged.food || r.foraged.water)) {
        parts.push(
          `foraged +${r.foraged.food} food / +${r.foraged.water} water`,
        );
      }
      const short = [];
      if (r.shortfalls.food > 0) short.push(`${r.shortfalls.food} food`);
      if (r.shortfalls.water > 0) short.push(`${r.shortfalls.water} water`);
      const shortLabel =
        short.length > 0
          ? `<span style="color:#ef6f74;">short ${short.join(", ")}</span>`
          : `<span style="color:#6dd5a2;">supplied</span>`;
      const forageLabel = parts.length > 0 ? ` · ${parts.join(", ")}` : "";
      return `<li><strong>${escapeText(r.name)}</strong> — ${shortLabel}${forageLabel}</li>`;
    })
    .join("");
  const lightLine =
    result.party?.light && result.party.light.shortfall > 0
      ? `<div style="color:#ef6f74;">Light: ${result.party.light.shortfall} short of torches.</div>`
      : "";
  const daysLabel = result.days > 1 ? ` (${result.days} days)` : "";
  const content = `
    <div class="infinity-dnd5e infinity-quartermaster-receipt">
      <h3 style="margin:0 0 4px;">Daily Supplies — ${escapeText(envLabel)}${daysLabel}</h3>
      <ul style="margin:4px 0; padding-left:18px;">${rows}</ul>
      ${lightLine}
    </div>`;

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
  if (!users) return [];
  const gmIds = users.filter((u) => u.isGM).map((u) => u.id);
  if (mode === "whisper-gm") return gmIds;
  // whisper-gm-owner: GMs + each affected character's owner.
  const out = new Set(gmIds);
  for (const actorId of actorIds ?? []) {
    const actor = globalThis.game?.actors?.get?.(actorId);
    if (!actor) continue;
    for (const u of users) {
      if (!u.isGM && actor.testUserPermission?.(u, "OWNER")) out.add(u.id);
    }
  }
  return [...out];
}

async function promptApplyExhaustion(suggestions) {
  const DialogV2 = globalThis.foundry?.applications?.api?.DialogV2;
  const names = suggestions
    .map((s) => `${escapeText(s.name)} (+${s.suggestDelta})`)
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

/** The non-GM user whose assigned character is this actor, or any non-GM user
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
  if (list.some((u) => u && !u.isGM && charId(u) === actor.id)) return true;
  // (b) a non-GM user holds an explicit per-user OWNER permission.
  const OWNER = globalThis.CONST?.DOCUMENT_OWNERSHIP_LEVELS?.OWNER ?? 3;
  const ownerById = (id) =>
    list.find((u) => u?.id === id) ?? users?.get?.(id) ?? null;
  const ownership = actor?.ownership ?? {};
  for (const [userId, level] of Object.entries(ownership)) {
    if (userId === "default") continue;
    if (Number(level) >= OWNER && ownerById(userId)?.isGM === false)
      return true;
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
 * `[{ actor, isStash, drawFromId }]`, where `drawFromId` is the actor id each
 * member's per-character supplies are drawn from (its own id for "self"). When
 * the GM hasn't curated a roster, auto-tracks every player-owned character (each
 * drawing from self), so the feature degrades to the original behavior. Curated
 * entries that no longer resolve to a player character are dropped, and a draw
 * source that's gone (or no longer a stash) falls back to self.
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
      return { actor, isStash: entry.isStash === true, drawFromId };
    });
  }

  // Single shared party stash: when it's set to a tracked actor, the WHOLE
  // party draws its per-character supplies (food & water) from that one pile —
  // overriding every per-member nomination — and it counts as a stash for
  // party-scope pooling (light) too. An unset/stale id leaves per-member draws.
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
  return getPartyRoster().map((r) => r.actor);
}

/** The online user who owns this actor (assigned char first), or null. Includes
 *  Assistant-GMs (role 3) who play a PC — only the local driving GM is excluded,
 *  so we never pop a forage prompt on the GM running the upkeep. */
function owningOnlineUserId(actor) {
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
  const owner = online.find((u) => actor.testUserPermission?.(u, "OWNER"));
  return owner?.id ?? null;
}

function actorItemSnapshots(actor) {
  const items = actor?.items?.contents ?? actor?.items ?? [];
  const list = Array.isArray(items) ? items : Array.from(items ?? []);
  return list.map((i) =>
    typeof i?.toObject === "function" ? i.toObject() : i,
  );
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

function escapeText(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}
