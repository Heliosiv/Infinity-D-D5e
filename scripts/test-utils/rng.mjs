/**
 * Tiny seeded RNG helpers for tests.
 * Produces deterministic [0, 1) sequences so roller output is
 * stable between runs.
 */

/** Returns a function that emits the supplied numbers in order, looping. */
export function seqRng(values) {
  if (!Array.isArray(values) || values.length === 0) {
    throw new Error("seqRng: must provide at least one value");
  }
  let index = 0;
  return () => {
    const value = values[index % values.length];
    index += 1;
    return value;
  };
}

/**
 * Mulberry32 — small, fast, decent-quality seeded PRNG.
 * Returns [0, 1) like Math.random.
 */
export function mulberry32(seed = 1) {
  let state = seed >>> 0 || 1;
  return () => {
    state |= 0;
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
