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
 * Resolve a single forager's yield.
 *
 * @param {object} args
 * @param {number} args.rollTotal       - the Survival check total
 * @param {number} args.dc              - the environment DC
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
  wisMod = 0,
  foodDie = 0,
  waterDie = 0,
  env = null,
  foodEnabled = true,
  waterEnabled = true,
} = {}) {
  const total = Number(rollTotal);
  const target = Number(dc) || 0;
  const mod = Number(wisMod) || 0;
  const margin = (Number.isFinite(total) ? total : 0) - target;
  const forageable = !env || env.forageable !== false;
  const success = forageable && Number.isFinite(total) && total >= target;
  if (!success) {
    return { success: false, food: 0, water: 0, margin };
  }
  const wantsFood =
    foodEnabled && (!env || String(env.yieldFood ?? "1d6") !== "0");
  const wantsWater =
    waterEnabled && (!env || String(env.yieldWater ?? "1d6") !== "0");
  const food = wantsFood
    ? Math.max(0, Math.floor(Number(foodDie) || 0) + mod)
    : 0;
  const water = wantsWater
    ? Math.max(0, Math.floor(Number(waterDie) || 0) + mod)
    : 0;
  return { success: true, food, water, margin };
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
  // Only the winner deposits; everyone else contributes nothing in "best" mode.
  return list.map((entry) =>
    entry === best
      ? { ...entry }
      : { ...entry, food: 0, water: 0, suppressed: entry.success },
  );
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
 *            suppressed:boolean,noResponse:boolean,targetUserId:string}}
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
 * @param {Array<{actorId,food,water,success}>} args.foraged - online foragers' results
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
  partyStashId = "",
  foodEnabled = true,
  waterEnabled = true,
} = {}) {
  const rosterById = new Map(
    (Array.isArray(roster) ? roster : []).map((r) => [String(r.actorId), r]),
  );
  const yieldById = new Map(
    (Array.isArray(foraged) ? foraged : []).map((y) => [String(y.actorId), y]),
  );
  const wantFood = foodEnabled !== false;
  const wantWater = waterEnabled !== false;

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
    const actorId = String(rawId);
    const entry = rosterById.get(actorId);
    if (!entry) continue; // a selection that isn't tracked — ignore
    const y = yieldById.get(actorId);
    if (!y) {
      perForager.push({
        actorId,
        name: entry.name,
        attempted: false,
        success: false,
        food: 0,
        water: 0,
      });
      continue;
    }
    const success = y.success === true;
    const food =
      success && wantFood ? Math.max(0, Math.floor(Number(y.food) || 0)) : 0;
    const water =
      success && wantWater ? Math.max(0, Math.floor(Number(y.water) || 0)) : 0;
    totalFood += food;
    totalWater += water;
    perForager.push({
      actorId,
      name: entry.name,
      attempted: true,
      success,
      // "best" mode: a successful forager whose haul lost to a bigger one — they
      // gathered but contribute nothing, so the report shouldn't trumpet "+0".
      suppressed: success && y.suppressed === true,
      food,
      water,
    });
    if (success && (food > 0 || water > 0)) {
      const sourceId = stashActorId ?? String(entry.drawFromId ?? actorId);
      addToSource(sourceId, food, water);
    }
  }

  const deposits = [...bySource.entries()]
    .map(([actorId, v]) => ({ actorId, food: v.food, water: v.water }))
    .filter((d) => d.food > 0 || d.water > 0);

  return { stashActorId, perForager, deposits, totalFood, totalWater };
}
