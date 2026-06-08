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
  setLastSeenDay,
  setLastUpkeepResult,
} from "./store.js";
import { findEnvironment, isForageable } from "./environment.js";
import { computeForageYield, combineYields } from "./forage.js";
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
      console.warn(`${MODULE_ID} | Simple Calendar read failed; using core time`, error);
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
 * The upkeep pipeline
 * ------------------------------------------------------------------ */

async function runDailyUpkeep({ elapsedDays = 1, config = null } = {}) {
  const cfg = config ?? loadResourceConfig();
  const days = Math.max(1, Math.floor(Number(elapsedDays) || 1));
  const state = loadRunState();
  const env = resolveCurrentEnvironment(cfg, state);
  const party = discoverPartyActors();

  if (party.length === 0) {
    globalThis.ui?.notifications?.info(
      `${MODULE_ID}: no player characters found for daily upkeep.`,
    );
    return null;
  }

  // 1) Foraging window (only when the environment allows it).
  let foragedByActor = new Map();
  if (isForageable(env)) {
    foragedByActor = await runForagingWindow({ env, party, cfg });
  }

  // 2) Deposit foraged yield to each forager's sheet.
  const foodRes = cfg.resources.find((r) => r.forageYields === "food");
  const waterRes = cfg.resources.find((r) => r.forageYields === "water");
  for (const actor of party) {
    const yld = foragedByActor.get(actor.id);
    if (!yld || !yld.success) continue;
    if (foodRes && yld.food > 0) await depositResource(actor, foodRes, yld.food);
    if (waterRes && yld.water > 0 && cfg.waterEnabled) {
      await depositResource(actor, waterRes, yld.water);
    }
  }

  // 3) Consume the day's supplies across the party.
  const report = await applyConsumption({ party, cfg, days });

  // Fold foraging into the per-actor report.
  for (const row of report.perActor) {
    const yld = foragedByActor.get(row.actorId);
    row.foraged = yld
      ? { food: yld.food ?? 0, water: yld.water ?? 0, success: yld.success }
      : { food: 0, water: 0, success: false };
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
  const results = new Map();
  let resolveFn = () => {};
  const done = new Promise((res) => {
    resolveFn = res;
  });
  pendingRuns.set(runId, { expected, results, resolve: resolveFn });

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
    });
    const userId = targets.find((t) => t.actor.id === entry.actorId)?.userId;
    if (userId) {
      emitResourceEvent(RESOURCE_EVENTS.FORAGE_ACK, {
        runId,
        actorId: entry.actorId,
        food: entry.food ?? 0,
        water: entry.water ?? 0,
        success: Boolean(entry.success),
        targetUserId: userId,
      });
    }
  }
  return out;
}

/** GM-side: record a player's Survival total; resolve the window when complete. */
async function handleForageResult(payload) {
  const { runId, actorId } = payload ?? {};
  const run = pendingRuns.get(runId);
  if (!run || !run.expected.has(actorId)) return;
  const actor = globalThis.game?.actors?.get?.(actorId);
  const user = globalThis.game?.users?.get?.(payload.originUserId);
  // Trust the report only when the claiming user actually owns that character.
  if (!actor || !user || !actor.testUserPermission?.(user, "OWNER")) return;
  run.results.set(actorId, {
    rollTotal: Number(payload.rollTotal) || 0,
    wisMod: Number(payload.wisMod) || 0,
    skipped: payload.skipped === true,
  });
  if (run.results.size >= run.expected.size) run.resolve();
}

/* ------------------------------------------------------------------ *
 * Consumption + deposit
 * ------------------------------------------------------------------ */

async function applyConsumption({ party, cfg, days }) {
  const perActorMap = new Map();
  const ensureRow = (actor) => {
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

  const partyReport = {};

  for (const resource of cfg.resources) {
    if (resource.id === "water" && cfg.waterEnabled === false) continue;
    if (resource.forageYields === "water" && cfg.waterEnabled === false) continue;

    const base = Math.max(0, resource.perDay * days);
    // Half rations stretch food; savings accrue across multi-day advances.
    const isFood = resource.forageYields === "food" || resource.id === "food";
    const amount =
      isFood && cfg.halfRations ? Math.ceil(base / 2) : Math.round(base);
    if (amount <= 0) continue;

    if (resource.scope === "party") {
      const res = await consumePartyResource(party, resource, amount);
      partyReport[resource.id] = res;
    } else {
      for (const actor of party) {
        const res = await consumeFromActor(actor, resource, amount);
        const row = ensureRow(actor);
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

  // Make sure every party actor has a row even if they matched no resources.
  for (const actor of party) ensureRow(actor);

  return { perActor: [...perActorMap.values()], party: partyReport };
}

async function consumeFromActor(actor, resourceDef, amount) {
  const matches = matchResourceItems(actorItemSnapshots(actor), resourceDef);
  const plan = planConsumption({ matches, amount });
  await applyConsumptionOps(actor, plan.ops);
  return { consumed: plan.consumed, shortfall: plan.shortfall };
}

/** Party-scope draw (e.g. torches): drain from each carrier in turn. */
async function consumePartyResource(party, resourceDef, amount) {
  let remaining = amount;
  let consumed = 0;
  for (const actor of party) {
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
    console.error(`${MODULE_ID} | consumption write failed on ${actor?.name}`, error);
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
      await actor.items?.get?.(plan.id)?.update?.({ "system.quantity": plan.to });
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

  const speaker = globalThis.ChatMessage.getSpeaker?.({ alias: "Quartermaster" });
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
  const mode = String(getSetting(SETTING_KEYS.RESOURCE_REPORT_MODE) ?? "whisper-gm");
  if (mode === "public") return null;
  const users = globalThis.game?.users;
  if (!users) return [];
  const gmIds = users.filter((u) => u.isGM).map((u) => u.id);
  if (mode === "whisper-gm") return gmIds;
  // whisper-gm-owner: GMs + each affected character's owner.
  const out = new Set(gmIds);
  for (const row of result.perActor) {
    const actor = globalThis.game?.actors?.get?.(row.actorId);
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
    console.error(`${MODULE_ID} | exhaustion update failed on ${actor?.name}`, error);
  }
}

/* ------------------------------------------------------------------ *
 * Party discovery + small helpers
 * ------------------------------------------------------------------ */

/** Player-owned character actors (the party). */
export function discoverPartyActors() {
  const actors = globalThis.game?.actors;
  if (typeof actors?.filter !== "function") return [];
  return actors.filter(
    (actor) => actor?.type === "character" && actor?.hasPlayerOwner === true,
  );
}

/** The online non-GM user who owns this actor (assigned char first), or null. */
function owningOnlineUserId(actor) {
  const users = globalThis.game?.users;
  if (!users?.filter) return null;
  const online = users.filter((u) => u && !u.isGM && u.active);
  const assigned = online.find((u) => {
    const charId =
      typeof u.character === "string" ? u.character : u.character?.id ?? null;
    return charId === actor.id;
  });
  if (assigned) return assigned.id;
  const owner = online.find((u) => actor.testUserPermission?.(u, "OWNER"));
  return owner?.id ?? null;
}

function actorItemSnapshots(actor) {
  const items = actor?.items?.contents ?? actor?.items ?? [];
  const list = Array.isArray(items) ? items : Array.from(items ?? []);
  return list.map((i) => (typeof i?.toObject === "function" ? i.toObject() : i));
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
