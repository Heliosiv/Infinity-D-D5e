/** Keep the hub's food/water text aligned with the read-only Supplies window. */
import { syncPlayerHubLabel } from "./player-hub-labels.js";
import { buildPlayerResourceOverview } from "./resource/overview-service.js";
import {
  isAuthoritativeGM,
  RESOURCE_EVENTS,
  subscribe,
} from "./resource/socket.js";
import { getSetting, SETTING_KEYS } from "./settings.js";

let service = null;

export function registerPlayerHubSuppliesSync() {
  if (service) return true;
  service = createPlayerHubSuppliesSync();
  service.start();
  return true;
}

/** Separate instance state keeps event coalescing and lifecycle testable. */
export function createPlayerHubSuppliesSync({
  hooks = globalThis.Hooks,
  subscribeToResources = subscribe,
  ...options
} = {}) {
  let started = false;
  let inFlight = null;
  let queued = false;

  function refresh() {
    queued = true;
    if (inFlight) return inFlight;
    // Start in a microtask so synchronous bursts share one fresh projection.
    inFlight = Promise.resolve().then(async () => {
      let result;
      try {
        while (queued) {
          queued = false;
          result = await syncPlayerHubSuppliesLabels(options);
        }
      } catch (error) {
        console.warn("infinity-dnd5e | player-hub supplies sync failed", error);
      } finally {
        inFlight = null;
      }
      return result;
    });
    return inFlight;
  }

  function start() {
    if (started) return false;
    started = true;
    // Existing service invalidates after inventory, roster, config and upkeep
    // changes. Authority recovery also emits this event after its cache is ready.
    subscribeToResources(RESOURCE_EVENTS.STATE_UPDATE, refresh);
    hooks?.on?.("canvasReady", refresh);
    void refresh();
    return true;
  }

  return { start, refresh };
}

export async function syncPlayerHubSuppliesLabels({
  gameRef = globalThis.game,
  readOverview = buildPlayerResourceOverview,
  isWriteAuthority = isAuthoritativeGM,
  isPlayerViewEnabled = () =>
    getSetting(SETTING_KEYS.RESOURCE_PLAYER_VIEW) !== false,
} = {}) {
  // This authority includes full GM, tab leadership and resource cache readiness.
  if (isWriteAuthority() !== true)
    return { updated: 0, unchanged: 0, skipped: 1 };
  const text = isPlayerViewEnabled()
    ? formatPlayerHubSuppliesLabel(await readOverview())
    : "Party Supplies\nUnavailable";
  if (!text) return { updated: 0, unchanged: 0, skipped: 1 };
  return syncPlayerHubLabel({
    gameRef,
    key: "party-supplies",
    title: "Party Supplies",
    text,
    isWriteAuthority,
  });
}

export function formatPlayerHubSuppliesLabel(overview) {
  if (overview?.schemaVersion !== 1 || !Array.isArray(overview?.resources))
    return null;
  const coverage = (id) => {
    const rows = overview.resources.filter((resource) => resource?.id === id);
    if (rows.length > 1) return null;
    if (!rows.length) return "Not configured";
    const label = rows[0].coverageLabel;
    return typeof label === "string" &&
      label.trim() &&
      label.length <= 40 &&
      !/[\r\n]/.test(label)
      ? label.trim()
      : null;
  };
  const food = coverage("food");
  const water =
    overview.waterEnabled === false ? "Not tracked" : coverage("water");
  return food && water ? `Party Supplies\nFood ${food} · Water ${water}` : null;
}
