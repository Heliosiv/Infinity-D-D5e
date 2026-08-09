/**
 * Infinity D&D5e — Foraging yield math (pure)
 *
 * Decides whether a Wisdom (Survival) gather check succeeds and, if so, how
 * much food / water it turns up. The dice themselves (the d20 Survival roll and
 * the yield dice) are rolled Foundry-side and passed in as already-resolved
 * numbers, keeping this module deterministic and node-testable.
 *
 * Yield convention: 1 "food" = one day's rations, 1 "water" = one day's water
 * (DMG pounds→days, gallons→days, 1:1), so a successful forager who rolls a 4
 * with +2 Wis nets 6 days of that resource added to their own sheet.
 */

export const FORAGE_TARGETS = Object.freeze({
  BOTH: "food-water",
  FOOD: "food",
  WATER: "water",
});

/** Normalize caller/UI input to one of the three supported forage targets. */
export function normalizeForageTarget(value) {
  return Object.values(FORAGE_TARGETS).includes(value)
    ? value
    : FORAGE_TARGETS.BOTH;
}

/** Resolve the resource channels enabled by a normalized forage target. */
export function forageTargetChannels(value) {
  const target = normalizeForageTarget(value);
  return {
    target,
    food: target !== FORAGE_TARGETS.WATER,
    water: target !== FORAGE_TARGETS.FOOD,
  };
}

/**
 * Normalize a forage-drive selection to one target per actor.
 *
 * New callers submit `foragers`, while legacy callers may continue to submit
 * `targetActorIds` plus one shared `forageTarget`. Canonical rows win when at
 * least one is valid; otherwise the legacy selection is expanded. Duplicate
 * actor ids are deterministic (first valid row wins).
 *
 * @param {object} input
 * @param {Array<{actorId:string,forageTarget:string}>} [input.foragers]
 * @param {string[]} [input.targetActorIds]
 * @param {string} [input.forageTarget]
 * @returns {Array<{actorId:string,forageTarget:"food-water"|"food"|"water"}>}
 */
export function normalizeForagerAssignments({
  foragers = [],
  targetActorIds = [],
  forageTarget = FORAGE_TARGETS.BOTH,
} = {}) {
  const allowedTargets = new Set(Object.values(FORAGE_TARGETS));
  const normalizeRows = (rows, resolveTarget) => {
    const seen = new Set();
    const out = [];
    for (const row of Array.isArray(rows) ? rows : []) {
      const actorId = String(
        row && typeof row === "object" ? (row.actorId ?? "") : (row ?? ""),
      ).trim();
      const target = resolveTarget(row);
      if (!actorId || seen.has(actorId) || !allowedTargets.has(target))
        continue;
      seen.add(actorId);
      out.push({ actorId, forageTarget: target });
    }
    return out;
  };

  const canonical = normalizeRows(foragers, (row) => row?.forageTarget);
  if (canonical.length > 0) return canonical;

  const legacyTarget = normalizeForageTarget(forageTarget);
  return normalizeRows(targetActorIds, () => legacyTarget);
}

/**
 * Summarize normalized per-forager targets for drive-level validation.
 * `target` represents the union of requested channels; `individualTargets`
 * retains the exact actor choices so mixed drives remain distinguishable.
 *
 * @returns {{target:"food-water"|"food"|"water"|null,food:boolean,
 *            water:boolean,individualTargets:Record<string,string>}}
 */
export function aggregateForageAssignments(assignments = []) {
  const normalized = normalizeForagerAssignments({ foragers: assignments });
  let food = false;
  let water = false;
  for (const assignment of normalized) {
    const channels = forageTargetChannels(assignment.forageTarget);
    food ||= channels.food;
    water ||= channels.water;
  }
  const target =
    food && water
      ? FORAGE_TARGETS.BOTH
      : food
        ? FORAGE_TARGETS.FOOD
        : water
          ? FORAGE_TARGETS.WATER
          : null;
  return {
    target,
    food,
    water,
    individualTargets: Object.fromEntries(
      normalized.map(({ actorId, forageTarget }) => [actorId, forageTarget]),
    ),
  };
}

function finiteNumberOrNull(value) {
  if (value == null || String(value).trim() === "") return null;
  const normalized = Number(value);
  return Number.isFinite(normalized) ? normalized : null;
}

function resolveChannelDc({ explicit, common, env, channel }) {
  const capitalized = `${channel[0].toUpperCase()}${channel.slice(1)}`;
  for (const candidate of [
    explicit,
    common,
    env?.[`${channel}Dc`],
    env?.[`dc${capitalized}`],
    env?.dc,
  ]) {
    const normalized = finiteNumberOrNull(candidate);
    if (normalized !== null) return normalized;
  }
  return 0;
}

/**
 * Resolve a single forager's yield.
 *
 * @param {object} args
 * @param {number} args.rollTotal       - the Survival check total
 * @param {number} args.dc              - the environment DC
 * @param {number} [args.foodDc]         - food-specific DC (falls back to dc/environment)
 * @param {number} [args.waterDc]        - water-specific DC (falls back to dc/environment)
 * @param {number} [args.wisMod=0]      - the forager's Wisdom modifier
 * @param {number} [args.foodDie=0]     - the pre-rolled food die (e.g. a 1d6 result)
 * @param {number} [args.waterDie=0]    - the pre-rolled water die
 * @param {object} [args.env]           - the environment ({ forageable, yieldFood, yieldWater })
 * @param {boolean} [args.foodEnabled=true] - whether this check gathers food
 * @param {boolean} [args.waterEnabled=true] - global water toggle
 * @returns {{ success:boolean, food:number, water:number, margin:number }}
 */
export function computeForageYield({
  rollTotal,
  dc,
  foodDc,
  waterDc,
  wisMod = 0,
  foodDie = 0,
  waterDie = 0,
  env = null,
  foodEnabled = true,
  waterEnabled = true,
} = {}) {
  const total = Number(rollTotal);
  const mod = Number(wisMod) || 0;
  const resolvedFoodDc = resolveChannelDc({
    explicit: foodDc,
    common: dc,
    env,
    channel: "food",
  });
  const resolvedWaterDc = resolveChannelDc({
    explicit: waterDc,
    common: dc,
    env,
    channel: "water",
  });
  const requestedDcs = [
    ...(foodEnabled ? [resolvedFoodDc] : []),
    ...(waterEnabled ? [resolvedWaterDc] : []),
  ];
  const legacyDc =
    finiteNumberOrNull(dc) ??
    finiteNumberOrNull(env?.dc) ??
    (requestedDcs.length > 0 ? Math.min(...requestedDcs) : 0);
  const resolvedTotal = Number.isFinite(total) ? total : 0;
  const margin = resolvedTotal - legacyDc;
  const foodMargin = resolvedTotal - resolvedFoodDc;
  const waterMargin = resolvedTotal - resolvedWaterDc;
  const forageable = !env || env.forageable !== false;
  const foodSuccess =
    foodEnabled &&
    forageable &&
    Number.isFinite(total) &&
    total >= resolvedFoodDc;
  const waterSuccess =
    waterEnabled &&
    forageable &&
    Number.isFinite(total) &&
    total >= resolvedWaterDc;
  const success = foodSuccess || waterSuccess;
  if (!success) {
    return {
      success: false,
      foodSuccess,
      waterSuccess,
      food: 0,
      water: 0,
      margin,
      foodDc: resolvedFoodDc,
      waterDc: resolvedWaterDc,
      foodMargin,
      waterMargin,
    };
  }
  const wantsFood =
    foodSuccess && (!env || String(env.yieldFood ?? "1d6") !== "0");
  const wantsWater =
    waterSuccess && (!env || String(env.yieldWater ?? "1d6") !== "0");
  const food = wantsFood
    ? Math.max(0, Math.floor(Number(foodDie) || 0) + mod)
    : 0;
  const water = wantsWater
    ? Math.max(0, Math.floor(Number(waterDie) || 0) + mod)
    : 0;
  return {
    success: true,
    foodSuccess,
    waterSuccess,
    food,
    water,
    margin,
    foodDc: resolvedFoodDc,
    waterDc: resolvedWaterDc,
    foodMargin,
    waterMargin,
  };
}

/**
 * Combine per-forager yields into what actually lands.
 *   - "each" (default): every forager keeps their own yield (returned as-is).
 *   - "best": only the single largest food+water haul counts for the party.
 *
 * Each entry is `{ actorId, name, food, water, success }`. Returns a new array.
 *
 * @param {Array<object>} perForager
 * @param {"each"|"best"} [mode="each"]
 * @returns {Array<object>}
 */
export function combineYields(perForager, mode = "each") {
  const list = (Array.isArray(perForager) ? perForager : []).filter(Boolean);
  if (mode !== "best") return list.map((entry) => ({ ...entry }));

  const targetFor = (entry) => normalizeForageTarget(entry?.forageTarget);
  const channelSuccess = (entry, channel) => {
    const channels = forageTargetChannels(targetFor(entry));
    if (!channels[channel]) return false;
    const explicit = entry?.[`${channel}Success`];
    return typeof explicit === "boolean" ? explicit : entry?.success === true;
  };
  const homogeneousBoth = list.every(
    (entry) => targetFor(entry) === FORAGE_TARGETS.BOTH,
  );
  const hasSplitChannelOutcomes = list.some(
    (entry) => channelSuccess(entry, "food") !== channelSuccess(entry, "water"),
  );

  // Preserve the legacy "one combined haul wins" rule when every forager was
  // gathering both channels and every check resolved both channels together.
  // Split-DC partial successes need one deterministic winner per resource or a
  // valid food/water success can disappear behind the other channel's winner.
  if (homogeneousBoth && !hasSplitChannelOutcomes) {
    const successes = list.filter((entry) => entry.success);
    if (successes.length === 0) return list.map((entry) => ({ ...entry }));
    let best = successes[0];
    let bestScore = (best.food ?? 0) + (best.water ?? 0);
    for (const entry of successes.slice(1)) {
      const score = (entry.food ?? 0) + (entry.water ?? 0);
      if (score > bestScore) {
        best = entry;
        bestScore = score;
      }
    }
    return list.map((entry) => {
      if (entry === best) {
        return {
          ...entry,
          foodSuppressed: false,
          waterSuppressed: false,
          suppressed: false,
        };
      }
      const foodSuppressed = channelSuccess(entry, "food");
      const waterSuppressed = channelSuccess(entry, "water");
      return {
        ...entry,
        food: 0,
        water: 0,
        foodSuppressed,
        waterSuppressed,
        suppressed: foodSuppressed || waterSuppressed,
      };
    });
  }

  const firstBestFor = (channel) => {
    let winner = null;
    let winnerAmount = -Infinity;
    for (const entry of list) {
      if (!channelSuccess(entry, channel)) continue;
      const candidate = Math.max(0, Number(entry?.[channel]) || 0);
      if (candidate > winnerAmount) {
        winner = entry;
        winnerAmount = candidate;
      }
    }
    return winner;
  };
  const foodWinner = firstBestFor("food");
  const waterWinner = firstBestFor("water");

  return list.map((entry) => {
    const foodGathered = channelSuccess(entry, "food");
    const waterGathered = channelSuccess(entry, "water");
    const foodSuppressed = foodGathered && entry !== foodWinner;
    const waterSuppressed = waterGathered && entry !== waterWinner;
    const gatheredChannels = Number(foodGathered) + Number(waterGathered);
    const suppressedChannels = Number(foodSuppressed) + Number(waterSuppressed);
    return {
      ...entry,
      food: foodGathered && !foodSuppressed ? Math.max(0, entry.food ?? 0) : 0,
      water:
        waterGathered && !waterSuppressed ? Math.max(0, entry.water ?? 0) : 0,
      foodSuppressed,
      waterSuppressed,
      suppressed:
        gatheredChannels > 0 && suppressedChannels === gatheredChannels,
    };
  });
}

/**
 * Build the GM-to-player acknowledgement for one resolved forage attempt.
 *
 * Keeping this projection pure makes the player-visible result explicit and
 * prevents "best haul" losers from being flattened into an ordinary +0 result.
 *
 * @param {object} args
 * @param {string} args.runId
 * @param {string} args.actorId
 * @param {object} args.entry
 * @param {string} args.targetUserId
 * @param {boolean} [args.noResponse=false]
 * @returns {{runId:string,actorId:string,food:number,water:number,success:boolean,
 *            foodSuccess:boolean,waterSuccess:boolean,foodSuppressed:boolean,
 *            waterSuppressed:boolean,suppressed:boolean,noResponse:boolean,
 *            targetUserId:string}}
 */
export function buildForageAcknowledgement({
  runId,
  actorId,
  entry = {},
  targetUserId,
  noResponse = false,
} = {}) {
  return {
    runId: String(runId ?? ""),
    actorId: String(actorId ?? ""),
    food: Math.max(0, Math.floor(Number(entry?.food) || 0)),
    water: Math.max(0, Math.floor(Number(entry?.water) || 0)),
    success: entry?.success === true,
    foodSuccess: entry?.foodSuccess === true,
    waterSuccess: entry?.waterSuccess === true,
    foodSuppressed: entry?.foodSuppressed === true,
    waterSuppressed: entry?.waterSuppressed === true,
    suppressed: entry?.suppressed === true,
    noResponse: noResponse === true,
    targetUserId: String(targetUserId ?? ""),
  };
}

/**
 * Plan a forage drive's deposits (pure). Given the curated roster, the GM's
 * selection, and the foragers' resolved yields, decide where each haul lands:
 *   - the explicitly configured party stash receives the whole party's food
 *     and water, OR
 *   - with no party stash, each successful forager's haul goes to that
 *     member's own resolved draw source.
 * Failed/offline foragers contribute nothing; either resource can be zeroed
 * when that channel is excluded from the drive. Returns the report rows plus
 * the merged deposit list.
 *
 * @param {object} args
 * @param {Array<{actorId,name,isStash,drawFromId}>} args.roster
 * @param {string[]} args.selectedIds  - actor ids the GM sent the check to
 * @param {Array<{actorId,food,water,success,forageTarget}>} args.foraged - online foragers' results
 * @param {Record<string,string>|Map<string,string>} [args.forageTargets] - targets for selected actors, including missing responses
 * @param {string} [args.partyStashId] - the configured single stash id ("" = none)
 * @param {boolean} [args.foodEnabled=true]
 * @param {boolean} [args.waterEnabled=true]
 * @returns {{ stashActorId:string|null,
 *             perForager:Array<{actorId,name,attempted,success,food,water}>,
 *             deposits:Array<{actorId,food,water}>,
 *             totalFood:number, totalWater:number }}
 */
export function planForageDriveDeposits({
  roster = [],
  selectedIds = [],
  foraged = [],
  forageTargets = {},
  partyStashId = "",
  foodEnabled = true,
  waterEnabled = true,
} = {}) {
  const rosterById = new Map(
    (Array.isArray(roster) ? roster : []).map((r) => [
      String(r.actorId).trim(),
      r,
    ]),
  );
  const yieldById = new Map(
    (Array.isArray(foraged) ? foraged : []).map((y) => [
      String(y.actorId).trim(),
      y,
    ]),
  );
  const wantFood = foodEnabled !== false;
  const wantWater = waterEnabled !== false;
  const mappedTarget = (actorId) => {
    const value =
      forageTargets instanceof Map
        ? forageTargets.get(actorId)
        : forageTargets && typeof forageTargets === "object"
          ? forageTargets[actorId]
          : null;
    return Object.values(FORAGE_TARGETS).includes(value) ? value : null;
  };
  const finiteMetadataNumber = (value) => {
    if (value == null || String(value).trim() === "") return null;
    const normalized = Number(value);
    return Number.isFinite(normalized) ? normalized : null;
  };

  // A flagged stash is only an available per-member source. It becomes the one
  // communal forage destination only when selected as partyStashId.
  const configured = String(partyStashId ?? "").trim();
  const stashActorId =
    configured && rosterById.has(configured) ? configured : null;

  const perForager = [];
  let totalFood = 0;
  let totalWater = 0;
  const bySource = new Map();
  const addToSource = (sourceId, food, water) => {
    const prev = bySource.get(sourceId) ?? { food: 0, water: 0 };
    prev.food += food;
    prev.water += water;
    bySource.set(sourceId, prev);
  };

  for (const rawId of Array.isArray(selectedIds) ? selectedIds : []) {
    const actorId = String(rawId).trim();
    const entry = rosterById.get(actorId);
    if (!entry) continue; // a selection that isn't tracked — ignore
    const y = yieldById.get(actorId);
    const forageTarget =
      mappedTarget(actorId) ?? normalizeForageTarget(y?.forageTarget);
    const channels = forageTargetChannels(forageTarget);
    if (!y) {
      perForager.push({
        actorId,
        name: entry.name,
        forageTarget,
        attempted: false,
        success: false,
        foodSuccess: false,
        waterSuccess: false,
        foodDc: null,
        waterDc: null,
        foodMargin: null,
        waterMargin: null,
        foodSuppressed: false,
        waterSuppressed: false,
        suppressed: false,
        food: 0,
        water: 0,
      });
      continue;
    }
    const success = y.success === true;
    const foodSuccess =
      channels.food &&
      (typeof y.foodSuccess === "boolean" ? y.foodSuccess : success);
    const waterSuccess =
      channels.water &&
      (typeof y.waterSuccess === "boolean" ? y.waterSuccess : success);
    const food =
      foodSuccess && wantFood
        ? Math.max(0, Math.floor(Number(y.food) || 0))
        : 0;
    const water =
      waterSuccess && wantWater
        ? Math.max(0, Math.floor(Number(y.water) || 0))
        : 0;
    totalFood += food;
    totalWater += water;
    perForager.push({
      actorId,
      name: entry.name,
      forageTarget,
      attempted: true,
      success,
      foodSuccess,
      waterSuccess,
      foodDc: finiteMetadataNumber(y.foodDc),
      waterDc: finiteMetadataNumber(y.waterDc),
      foodMargin: finiteMetadataNumber(y.foodMargin),
      waterMargin: finiteMetadataNumber(y.waterMargin),
      // "best" mode: a successful forager whose haul lost to a bigger one — they
      // gathered but contribute nothing, so the report shouldn't trumpet "+0".
      suppressed: success && y.suppressed === true,
      foodSuppressed: foodSuccess && y.foodSuppressed === true,
      waterSuppressed: waterSuccess && y.waterSuppressed === true,
      food,
      water,
    });
    if ((foodSuccess || waterSuccess) && (food > 0 || water > 0)) {
      const sourceId = stashActorId ?? String(entry.drawFromId ?? actorId);
      addToSource(sourceId, food, water);
    }
  }

  const deposits = [...bySource.entries()]
    .map(([actorId, v]) => ({ actorId, food: v.food, water: v.water }))
    .filter((d) => d.food > 0 || d.water > 0);

  return { stashActorId, perForager, deposits, totalFood, totalWater };
}
