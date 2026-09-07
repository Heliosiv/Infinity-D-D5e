/** Keep Campaign Pulse calendar labels aligned with Simple Calendar. */

const MODULE_ID = "infinity-dnd5e";
const DRAKEMORE_FLAG_SCOPE = "drakemore-foundry";
const PLAYER_HUB_KIND = "interactive-player-hub";
const PLAYER_HUB_VERSION = 1;
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

  let updated = 0;
  let unchanged = 0;
  let skipped = 0;
  for (const scene of collectionValues(gameRef?.scenes)) {
    if (!isCanonicalPlayerHub(scene)) continue;
    const target = findCalendarDrawing(scene);
    if (!target) {
      skipped += 1;
      continue;
    }
    if (String(target.text ?? "") === label) {
      unchanged += 1;
      continue;
    }
    if (typeof scene?.updateEmbeddedDocuments !== "function") {
      skipped += 1;
      continue;
    }
    const drawingId = String(target.id ?? target._id ?? "").trim();
    if (!drawingId) {
      skipped += 1;
      continue;
    }
    try {
      await scene.updateEmbeddedDocuments("Drawing", [
        { _id: drawingId, text: label },
      ]);
      updated += 1;
    } catch (error) {
      skipped += 1;
      console.warn(`${MODULE_ID} | player-hub calendar Drawing update failed`, {
        sceneId: scene.id ?? null,
        drawingId,
        error,
      });
    }
  }
  return { updated, unchanged, skipped };
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

function isCanonicalPlayerHub(scene) {
  const hub = scene?.flags?.[DRAKEMORE_FLAG_SCOPE]?.playerHub;
  return Boolean(
    hub?.kind === PLAYER_HUB_KIND &&
    hub?.version === PLAYER_HUB_VERSION &&
    Number(scene?.width ?? hub?.width) === 3840 &&
    Number(scene?.height ?? hub?.height) === 2160,
  );
}

function findCalendarDrawing(scene) {
  const calendarTiles = collectionValues(scene?.tiles).filter((tile) => {
    const control = tile?.flags?.[DRAKEMORE_FLAG_SCOPE]?.playerHubControl;
    return (
      control?.version === PLAYER_HUB_VERSION && control?.key === "calendar"
    );
  });
  if (calendarTiles.length !== 1) return null;

  const matches = collectionValues(scene?.drawings).filter((drawing) => {
    const label =
      drawing?.flags?.[DRAKEMORE_FLAG_SCOPE]?.playerHubLabel ?? null;
    return (
      label?.version === PLAYER_HUB_VERSION &&
      label?.key === "calendar" &&
      /^Calendar(?:\r?\n|$)/.test(String(drawing?.text ?? "")) &&
      substantiallyOverlaps(drawingRect(drawing), drawingRect(calendarTiles[0]))
    );
  });
  return matches.length === 1 ? matches[0] : null;
}

function substantiallyOverlaps(first, second) {
  if (!first || !second) return false;
  const width = Math.max(
    0,
    Math.min(first.right, second.right) - Math.max(first.left, second.left),
  );
  const height = Math.max(
    0,
    Math.min(first.bottom, second.bottom) - Math.max(first.top, second.top),
  );
  const intersection = width * height;
  const smallerArea = Math.min(first.area, second.area);
  return smallerArea > 0 && intersection / smallerArea >= 0.8;
}

function drawingRect(document) {
  const left = finiteNumber(document?.x);
  const top = finiteNumber(document?.y);
  const width = finiteNumber(document?.width ?? document?.shape?.width);
  const height = finiteNumber(document?.height ?? document?.shape?.height);
  if ([left, top, width, height].some((value) => value === null)) return null;
  if (width <= 0 || height <= 0) return null;
  return {
    left,
    top,
    right: left + width,
    bottom: top + height,
    area: width * height,
  };
}

function collectionValues(collection) {
  if (Array.isArray(collection)) return collection;
  if (Array.isArray(collection?.contents)) return collection.contents;
  if (collection && typeof collection.values === "function") {
    return [...collection.values()];
  }
  return [];
}

function boundedLine(value, maximumLength) {
  if (typeof value !== "string") return "";
  const line = value.replace(/[\r\n]+/g, " ").trim();
  return line.length > 0 && line.length <= maximumLength ? line : "";
}

function finiteNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}
