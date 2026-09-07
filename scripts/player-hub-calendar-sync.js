/** Keep Campaign Pulse calendar labels aligned with Simple Calendar. */
import { syncPlayerHubLabel } from "./player-hub-labels.js";

const MODULE_ID = "infinity-dnd5e";
const CALENDAR_MODULE_IDS = Object.freeze([
  "foundryvtt-simple-calendar-reborn",
  "foundryvtt-simple-calendar",
]);

let registered = false;
let syncInFlight = null;
let syncQueued = false;

/** Register date-change listeners and repair stale labels at startup. */
export function registerPlayerHubCalendarSync({
  hooks = globalThis.Hooks,
  gameRef = globalThis.game,
  isWriteAuthority = () => gameRef?.user?.isGM === true,
} = {}) {
  if (registered || typeof hooks?.on !== "function") return registered;
  registered = true;

  const requestSync = () =>
    queuePlayerHubCalendarSync({ gameRef, isWriteAuthority });
  hooks.on("updateWorldTime", requestSync);
  hooks.on("canvasReady", requestSync);
  const calendarHook = globalThis.SimpleCalendar?.Hooks?.DateTimeChange;
  if (typeof calendarHook === "string" && calendarHook) {
    hooks.on(calendarHook, requestSync);
  }

  void requestSync();
  return true;
}

/** Coalesce overlapping clock hooks while preserving one trailing refresh. */
export function queuePlayerHubCalendarSync(options = {}) {
  if (syncInFlight) {
    syncQueued = true;
    return syncInFlight;
  }

  syncInFlight = syncPlayerHubCalendarLabels(options)
    .catch((error) => {
      console.warn(`${MODULE_ID} | player-hub calendar sync failed`, error);
      return { updated: 0, unchanged: 0, skipped: 1 };
    })
    .finally(() => {
      syncInFlight = null;
      if (syncQueued) {
        syncQueued = false;
        void queuePlayerHubCalendarSync(options);
      }
    });
  return syncInFlight;
}

/** Update every canonical player-hub calendar Drawing through Foundry's API. */
export async function syncPlayerHubCalendarLabels({
  gameRef = globalThis.game,
  calendarApi = resolveCalendarApi(gameRef),
  isWriteAuthority = () => gameRef?.user?.isGM === true,
} = {}) {
  if (isWriteAuthority() !== true) {
    return { updated: 0, unchanged: 0, skipped: 1 };
  }

  const label = await readCalendarLabel(calendarApi);
  if (!label) return { updated: 0, unchanged: 0, skipped: 1 };

  return syncPlayerHubLabel({
    gameRef,
    key: "calendar",
    title: "Calendar",
    text: label,
    isWriteAuthority,
  });
}

export async function readCalendarLabel(calendarApi) {
  if (typeof calendarApi?.currentDateTimeDisplay !== "function") return null;
  const display = await calendarApi.currentDateTimeDisplay();
  const date = boundedLine(display?.date, 80);
  const postfix = boundedLine(display?.yearPostfix, 20);
  if (!date) return null;
  const dateWithPostfix =
    postfix && !date.endsWith(` ${postfix}`) ? `${date} ${postfix}` : date;
  return `Calendar\n${dateWithPostfix}`;
}

function resolveCalendarApi(gameRef) {
  for (const moduleId of CALENDAR_MODULE_IDS) {
    const calendarModule = gameRef?.modules?.get?.(moduleId);
    if (calendarModule?.active === true) {
      return globalThis.SimpleCalendar?.api ?? calendarModule.api ?? null;
    }
  }
  return null;
}

function boundedLine(value, maximumLength) {
  if (typeof value !== "string") return "";
  const line = value.replace(/[\r\n]+/g, " ").trim();
  return line.length > 0 && line.length <= maximumLength ? line : "";
}
