/** Typed DAE effects for reviewed downtime rewards. */

import { persistedValuesEqual } from "../utils/persisted-data.js";

const MODULE_ID = "infinity-dnd5e";
const FALLBACK_SECONDS_PER_HOUR = 3_600;
const FALLBACK_SECONDS_PER_DAY = 86_400;
const PRODUCTIVE_HOURS_PER_DAY = 8;
const ADD = 2;
const SIMPLE_CALENDAR_IDS = Object.freeze([
  "foundryvtt-simple-calendar-reborn",
  "foundryvtt-simple-calendar",
]);

const definitions = [
  {
    id: "sparring",
    label: "+1 first attack (12 hours)",
    name: "Sparring — Ready for the Fight",
    img: "icons/skills/melee/weapons-crossed-swords-yellow.webp",
    description: "+1 to the first weapon or spell attack roll. Does not stack.",
    detail:
      "+1 to the first attack roll, expiring on that attack or 12 in-game hours after this downtime block ends.",
    durationHours: 12,
    requiredModules: ["dae", "midi-qol", "times-up"],
    specialDuration: ["1Attack"],
    changes: ["mwak", "rwak", "msak", "rsak"].map((kind) => ({
      key: `system.bonuses.${kind}.attack`,
      mode: ADD,
      value: "1",
      priority: 20,
    })),
  },
  {
    id: "focused-study",
    label: "+1 ability and skill checks (8 hours)",
    name: "Focused Study — Prepared Mind",
    img: "icons/sundries/books/book-open-purple.webp",
    description: "+1 to ability checks and skill checks. Does not stack.",
    detail:
      "+1 to ability and skill checks for 8 in-game hours after this downtime block ends.",
    durationHours: 8,
    requiredModules: ["dae", "times-up"],
    specialDuration: [],
    changes: [
      {
        key: "system.bonuses.abilities.check",
        mode: ADD,
        value: "1",
        priority: 20,
      },
    ],
  },
  {
    id: "blessed-resolve",
    label: "+1 saving throws (8 hours)",
    name: "Blessed Resolve",
    img: "icons/magic/holy/prayer-hands-glowing-yellow.webp",
    description: "+1 to saving throws. Does not stack.",
    detail:
      "+1 to saving throws for 8 in-game hours after this downtime block ends.",
    durationHours: 8,
    requiredModules: ["dae", "times-up"],
    specialDuration: [],
    changes: [
      {
        key: "system.bonuses.abilities.save",
        mode: ADD,
        value: "1",
        priority: 20,
      },
    ],
  },
  {
    id: "guarded-drills",
    label: "+1 Armour Class (8 hours)",
    name: "Defensive Drills — Guarded",
    img: "icons/equipment/shield/heater-steel-sword-yellow-black.webp",
    description: "+1 Armour Class. Does not stack.",
    detail:
      "+1 Armour Class for 8 in-game hours after this downtime block ends.",
    durationHours: 8,
    requiredModules: ["dae", "times-up"],
    specialDuration: [],
    changes: [
      {
        key: "system.attributes.ac.bonus",
        mode: ADD,
        value: "1",
        priority: 20,
      },
    ],
  },
  {
    id: "trail-ready",
    label: "+5 ft. walking speed (8 hours)",
    name: "Trail Ready",
    img: "icons/skills/movement/feet-winged-boots-blue.webp",
    description: "+5 feet to walking speed. Does not stack.",
    detail:
      "+5 feet to walking speed for 8 in-game hours after this downtime block ends.",
    durationHours: 8,
    requiredModules: ["dae", "times-up"],
    specialDuration: [],
    changes: [
      {
        key: "system.attributes.movement.walk",
        mode: ADD,
        value: "5",
        priority: 20,
      },
    ],
  },
];

export const DOWNTIME_EFFECT_BENEFITS = Object.freeze(
  definitions.map((definition) =>
    Object.freeze({
      ...definition,
      requiredModules: Object.freeze([...definition.requiredModules]),
      specialDuration: Object.freeze([...definition.specialDuration]),
      changes: Object.freeze(
        definition.changes.map((change) => Object.freeze({ ...change })),
      ),
    }),
  ),
);

const definitionById = new Map(
  DOWNTIME_EFFECT_BENEFITS.map((definition) => [definition.id, definition]),
);

export function downtimeEffectBenefitDefinition(type) {
  return definitionById.get(String(type ?? "")) ?? null;
}

export function isDowntimeEffectBenefit(type) {
  return definitionById.has(String(type ?? ""));
}

function activeSimpleCalendarApi() {
  for (const id of SIMPLE_CALENDAR_IDS) {
    const module = globalThis.game?.modules?.get?.(id);
    if (module?.active !== true) continue;
    return globalThis.SimpleCalendar?.api ?? module.api ?? null;
  }
  return null;
}

function currentCampaignTimestamp() {
  const calendar = activeSimpleCalendarApi();
  if (typeof calendar?.timestamp === "function") {
    try {
      const timestamp = Number(calendar.timestamp());
      if (Number.isFinite(timestamp)) return timestamp;
    } catch {
      // Fall through to the core Foundry clock.
    }
  }
  const worldTime = Number(globalThis.game?.time?.worldTime);
  return Number.isFinite(worldTime) ? worldTime : 0;
}

function calendarTimeParts() {
  try {
    return activeSimpleCalendarApi()?.getCurrentCalendar?.()?.time ?? null;
  } catch {
    return null;
  }
}

function secondsPerHour() {
  const time = calendarTimeParts();
  const minutes = Number(time?.minutesInHour);
  const seconds = Number(time?.secondsInMinute);
  return [minutes, seconds].every(
    (value) => value > 0 && Number.isFinite(value),
  )
    ? minutes * seconds
    : FALLBACK_SECONDS_PER_HOUR;
}

function addCalendarDays(timestamp, days) {
  const start = Number(timestamp);
  const amount = Math.max(1, Math.ceil(Number(days) || 1));
  const calendar = activeSimpleCalendarApi();
  if (typeof calendar?.timestampPlusInterval === "function") {
    try {
      const result = Number(
        calendar.timestampPlusInterval(start, { day: amount }),
      );
      if (Number.isFinite(result)) return result;
    } catch {
      // Use the calendar-shape fallback below.
    }
  }
  const time = calendarTimeParts();
  const hours = Number(time?.hoursInDay);
  const daySeconds =
    Number.isFinite(hours) && hours > 0
      ? hours * secondsPerHour()
      : FALLBACK_SECONDS_PER_DAY;
  return start + amount * daySeconds;
}

export function downtimeBenefitTiming({ blockHours, durationHours } = {}) {
  const grantedAt = currentCampaignTimestamp();
  const productiveDays = Math.max(
    1,
    Math.ceil(
      Number(blockHours || PRODUCTIVE_HOURS_PER_DAY) / PRODUCTIVE_HOURS_PER_DAY,
    ),
  );
  const startsAt = addCalendarDays(grantedAt, productiveDays);
  const durationSeconds =
    Math.max(1, Number(durationHours) || 1) * secondsPerHour();
  return {
    grantedAt,
    startsAt,
    expiresAt: startsAt + durationSeconds,
    durationSeconds,
    productiveDays,
    productiveHoursPerDay: PRODUCTIVE_HOURS_PER_DAY,
  };
}

const sourceOf = (effect) => effect?.toObject?.() ?? effect ?? {};
const actorEffects = (actor) =>
  Array.from(
    actor?.effects?.contents ??
      actor?.effects?.values?.() ??
      actor?.effects ??
      [],
  );

function markerOf(effect) {
  return sourceOf(effect).flags?.[MODULE_ID]?.downtimeBenefit ?? null;
}

export function downtimeOperationEffect(actor, operation) {
  return actorEffects(actor).find((effect) => {
    const marker = markerOf(effect);
    return (
      (effect.id ?? effect._id) === operation.benefit?.effectId ||
      marker?.operationId === operation.operationId
    );
  });
}

export function activeDowntimeBenefitEffect(actor, type) {
  const now = currentCampaignTimestamp();
  return actorEffects(actor).find((effect) => {
    const data = sourceOf(effect);
    const marker = markerOf(effect);
    if (data.disabled || effect?.isSuppressed) return false;
    const legacySparring =
      type === "sparring" &&
      data.flags?.[MODULE_ID]?.downtimeSparring &&
      !marker;
    if (marker?.type !== type && !legacySparring) return false;
    const expiresAt = Number(
      marker?.timing?.expiresAt ??
        Number(data.duration?.startTime ?? 0) +
          Number(data.duration?.seconds ?? 0),
    );
    return Number.isFinite(expiresAt) && expiresAt > now;
  });
}

export function downtimeBenefitEffectData(operation) {
  const definition = downtimeEffectBenefitDefinition(operation.benefit?.type);
  if (!definition) throw new Error("Choose a supported timed benefit.");
  const timing = downtimeBenefitTiming({
    blockHours: operation.benefit.blockHours ?? operation.hours,
    durationHours: definition.durationHours,
  });
  return {
    _id: operation.benefit.effectId,
    name: definition.name,
    img: definition.img,
    disabled: false,
    transfer: false,
    description: `${definition.description} The expiry clock begins after the downtime block's expected calendar passage.`,
    duration: {
      seconds: timing.durationSeconds,
      startTime: timing.startsAt,
    },
    changes: definition.changes.map((change) => ({ ...change })),
    flags: {
      [MODULE_ID]: {
        downtimeBenefit: {
          schema: 1,
          operationId: operation.operationId,
          type: definition.id,
          timing,
        },
        ...(definition.id === "sparring"
          ? { downtimeSparring: { operationId: operation.operationId } }
          : {}),
      },
      dae: {
        specialDuration: [...definition.specialDuration],
        stackable: "noneName",
        showIcon: true,
      },
      "times-up": { isPassive: false },
    },
  };
}

export function downtimeBenefitEffectMatches(effect, operation) {
  const data = sourceOf(effect);
  const marker = markerOf(effect);
  const definition = downtimeEffectBenefitDefinition(operation.benefit?.type);
  return Boolean(
    data &&
    definition &&
    marker?.schema === 1 &&
    marker.operationId === operation.operationId &&
    marker.type === definition.id &&
    marker.timing?.productiveDays ===
      Math.max(
        1,
        Math.ceil(
          Number(operation.benefit.blockHours ?? operation.hours ?? 8) /
            PRODUCTIVE_HOURS_PER_DAY,
        ),
      ) &&
    Number(marker.timing?.durationSeconds) > 0 &&
    Number(data.duration?.startTime) === Number(marker.timing?.startsAt) &&
    Number(data.duration?.seconds) === Number(marker.timing?.durationSeconds) &&
    !data.disabled &&
    persistedValuesEqual(data.changes, definition.changes) &&
    persistedValuesEqual(
      data.flags?.dae?.specialDuration ?? [],
      definition.specialDuration,
    ),
  );
}

export function missingDowntimeBenefitModules(type, game = globalThis.game) {
  const definition = downtimeEffectBenefitDefinition(type);
  if (!definition) return [];
  return definition.requiredModules.filter(
    (id) => game?.modules?.get?.(id)?.active !== true,
  );
}

export function downtimeBenefitIntegrationError(type, game = globalThis.game) {
  const missing = missingDowntimeBenefitModules(type, game);
  if (missing.length === 0) return "";
  const definition = downtimeEffectBenefitDefinition(type);
  const moduleNames = {
    dae: "DAE",
    "midi-qol": "Midi QOL",
    "times-up": "Times Up",
  };
  const names = missing.map((id) => moduleNames[id] ?? id);
  const list =
    names.length === 1
      ? names[0]
      : `${names.slice(0, -1).join(", ")} and ${names.at(-1)}`;
  return `${definition.label} requires active ${list}.`;
}
