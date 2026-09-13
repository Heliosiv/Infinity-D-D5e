/** Player-visible time-of-day choices frozen into each downtime block. */
export const DOWNTIME_TIME_OF_DAY = Object.freeze({
  DAY: "day",
  NIGHT: "night",
});

export const DOWNTIME_TIME_OF_DAY_OPTIONS = Object.freeze([
  Object.freeze({ id: DOWNTIME_TIME_OF_DAY.DAY, label: "Day" }),
  Object.freeze({ id: DOWNTIME_TIME_OF_DAY.NIGHT, label: "Night" }),
]);

const IDS = new Set(DOWNTIME_TIME_OF_DAY_OPTIONS.map(({ id }) => id));
const LEGACY_ALIASES = Object.freeze({ dawn: "day", dusk: "night" });

export function normalizeDowntimeTimeOfDay(value, fallback = "day") {
  const id = String(value ?? "")
    .trim()
    .toLowerCase();
  if (IDS.has(id)) return id;
  if (LEGACY_ALIASES[id]) return LEGACY_ALIASES[id];
  const safeFallback = String(fallback ?? "day")
    .trim()
    .toLowerCase();
  return IDS.has(safeFallback)
    ? safeFallback
    : (LEGACY_ALIASES[safeFallback] ?? "day");
}

export function downtimeTimeOfDayLabel(value) {
  const id = normalizeDowntimeTimeOfDay(value);
  return DOWNTIME_TIME_OF_DAY_OPTIONS.find((entry) => entry.id === id).label;
}

export function normalizeTimeAvailability(values) {
  if (!Array.isArray(values))
    return DOWNTIME_TIME_OF_DAY_OPTIONS.map(({ id }) => id);
  const source = values;
  const selected = new Set(
    source
      .map((value) =>
        String(value ?? "")
          .trim()
          .toLowerCase(),
      )
      .map((value) => LEGACY_ALIASES[value] ?? value)
      .filter((value) => IDS.has(value)),
  );
  const result = DOWNTIME_TIME_OF_DAY_OPTIONS.map(({ id }) => id).filter((id) =>
    selected.has(id),
  );
  return result;
}
