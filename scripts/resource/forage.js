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
  const wantsFood = !env || String(env.yieldFood ?? "1d6") !== "0";
  const wantsWater =
    waterEnabled && (!env || String(env.yieldWater ?? "1d6") !== "0");
  const food = wantsFood ? Math.max(0, Math.floor(Number(foodDie) || 0) + mod) : 0;
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
