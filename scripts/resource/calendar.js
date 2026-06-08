/**
 * Infinity D&D5e — Resource calendar math (pure)
 *
 * The pure core of the day-rollover detector. It owns no Foundry globals:
 * the Foundry-touching extraction (reading `SimpleCalendar` / `game.time`)
 * lives in `calendar-watcher.js`, which hands these helpers already-extracted
 * primitives. Keeping the math here makes the tricky bits — multi-day jumps,
 * backward time travel, dedupe — node-testable.
 *
 * "Absolute day" means a monotonically increasing integer day index derived
 * from world seconds, NOT the calendar's day-of-month (which resets). We only
 * ever compare absolute day numbers.
 */

/** Foundry's default day length when nothing better is available. */
export const SECONDS_PER_DAY_FALLBACK = 86400;

/**
 * Derive seconds-per-day from an injected time-ish object. Tries, in order,
 * a Simple Calendar seconds-per-day, a core `earth`/calendar hint, then the
 * 86400 fallback. Always returns a positive finite number.
 *
 * @param {object} [timeApi] - a shape like `{ secondsPerDay, earth:{ secondsPerDay } }`
 * @returns {number}
 */
export function resolveSecondsPerDay(timeApi) {
  const candidates = [
    timeApi?.secondsPerDay,
    timeApi?.earth?.secondsPerDay,
    timeApi?.calendar?.secondsPerDay,
    timeApi?.components?.secondsPerDay,
  ];
  for (const candidate of candidates) {
    const n = Number(candidate);
    if (Number.isFinite(n) && n > 0) return n;
  }
  return SECONDS_PER_DAY_FALLBACK;
}

/**
 * Compute an absolute (monotonic) day number from extracted inputs. Prefers a
 * Simple Calendar timestamp when present (so a custom calendar's day length is
 * honored), otherwise falls back to core world time. Returns `null` when no
 * usable time source was provided.
 *
 * @param {object} inputs
 * @param {number} [inputs.scTimestamp]      - Simple Calendar world seconds
 * @param {number} [inputs.scSecondsPerDay]  - SC seconds per day
 * @param {number} [inputs.worldTime]        - core `game.time.worldTime` seconds
 * @param {number} [inputs.secondsPerDay]    - core seconds per day
 * @returns {number|null}
 */
export function computeAbsoluteDay({
  scTimestamp,
  scSecondsPerDay,
  worldTime,
  secondsPerDay,
} = {}) {
  const scTs = Number(scTimestamp);
  if (Number.isFinite(scTs)) {
    const spd =
      Number.isFinite(Number(scSecondsPerDay)) && Number(scSecondsPerDay) > 0
        ? Number(scSecondsPerDay)
        : SECONDS_PER_DAY_FALLBACK;
    return Math.floor(scTs / spd);
  }
  const wt = Number(worldTime);
  if (Number.isFinite(wt)) {
    const spd =
      Number.isFinite(Number(secondsPerDay)) && Number(secondsPerDay) > 0
        ? Number(secondsPerDay)
        : SECONDS_PER_DAY_FALLBACK;
    return Math.floor(wt / spd);
  }
  return null;
}

/**
 * Diff two absolute day numbers.
 *   - forward  : current > last  (elapsed = current - last)
 *   - same     : current === last (elapsed 0)
 *   - backward : current < last  (elapsed 0 — never negative)
 *
 * `lastSeenDay` of null/undefined (a fresh world) reports `direction: "seed"`
 * so the caller seeds the baseline without charging upkeep.
 *
 * @param {number|null} lastSeenDay
 * @param {number} currentDay
 * @returns {{ elapsed:number, direction:"seed"|"forward"|"same"|"backward" }}
 */
export function diffDays(lastSeenDay, currentDay) {
  const current = Number(currentDay);
  if (!Number.isFinite(current)) {
    return { elapsed: 0, direction: "same" };
  }
  if (lastSeenDay == null || !Number.isFinite(Number(lastSeenDay))) {
    return { elapsed: 0, direction: "seed" };
  }
  const last = Number(lastSeenDay);
  if (current > last) return { elapsed: current - last, direction: "forward" };
  if (current < last) return { elapsed: 0, direction: "backward" };
  return { elapsed: 0, direction: "same" };
}

/**
 * Cap how many days of upkeep a single jump applies, so advancing the clock by
 * a year doesn't cascade 365 days of starvation. Always returns an integer in
 * `[0, max]` (max clamped to ≥ 1). A non-positive `elapsed` returns 0.
 *
 * @param {number} elapsed
 * @param {number} maxCatchUpDays
 * @returns {number}
 */
export function clampElapsedForUpkeep(elapsed, maxCatchUpDays) {
  const e = Math.floor(Number(elapsed));
  if (!Number.isFinite(e) || e <= 0) return 0;
  const max = Math.max(1, Math.floor(Number(maxCatchUpDays) || 1));
  return Math.min(e, max);
}
