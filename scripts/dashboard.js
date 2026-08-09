/**
 * Infinity D&D5e — role-aware Home
 *
 * `InfinityDashboardApp` remains the compatibility class name, but the window
 * is now safe and useful for every role. Full GMs see registered GM tools;
 * players and Assistant GMs see only fixed, permission-scoped local surfaces.
 */

import { SOUND_EVENTS, playModuleSound } from "./audio.js";
import { isFullGM } from "./permissions.js";
import {
  getPlayerSurfaceAvailability,
  getPlayerSurfaceStatus,
  openPlayerSurface,
  PLAYER_SURFACE_LABELS,
  PLAYER_SURFACES,
} from "./player-surface.js";
import * as settingsApi from "./settings.js";
import { getTool, getTools, TOOL_INTENTS } from "./tool-registry.js";
import {
  dismissQuickStart as dismissStoredQuickStart,
  getUiPreferences as getStoredUiPreferences,
  restoreQuickStarts as restoreStoredQuickStarts,
} from "./ui-preferences.js";
import { prettyCategory, notify } from "./ui-util.js";
import { bindFullGmWindowGuard, openSingleton } from "./infinity-app.js";

const MODULE_ID = "infinity-dnd5e";
const TEMPLATE_PATH = `modules/${MODULE_ID}/templates/dashboard.hbs`;
const { SETTING_KEYS, getSetting, setSetting } = settingsApi;

const { ApplicationV2, HandlebarsApplicationMixin } = foundry.applications.api;

const HOME_INTENTS = Object.freeze([
  {
    id: TOOL_INTENTS.PREPARE,
    label: "Prepare",
    description: "Set up the people, places, and supplies the session needs.",
    icon: "fa-solid fa-list-check",
  },
  {
    id: TOOL_INTENTS.RUN_SESSION,
    label: "Run the Session",
    description: "Open the tools you use while play is moving.",
    icon: "fa-solid fa-dice-d20",
  },
  {
    id: TOOL_INTENTS.TRACK_CAMPAIGN,
    label: "Track the Campaign",
    description: "Review persistent party state and longer-term progress.",
    icon: "fa-solid fa-map-location-dot",
  },
]);

const PLAYER_HOME_DESTINATIONS = Object.freeze([
  {
    surface: PLAYER_SURFACES.SHOPS,
    intent: TOOL_INTENTS.PREPARE,
    icon: "fa-solid fa-store",
    description: "Browse shops currently available to your account.",
  },
  {
    surface: PLAYER_SURFACES.DOWNTIME,
    intent: TOOL_INTENTS.RUN_SESSION,
    icon: "fa-solid fa-hourglass-half",
    description: "Review your active downtime block and queue activities.",
  },
  {
    surface: PLAYER_SURFACES.CALENDAR,
    intent: TOOL_INTENTS.RUN_SESSION,
    icon: "fa-solid fa-calendar-days",
    description: "Open the campaign calendar when Simple Calendar is active.",
  },
  {
    surface: PLAYER_SURFACES.PARTY_SUPPLIES,
    intent: TOOL_INTENTS.TRACK_CAMPAIGN,
    icon: "fa-solid fa-campground",
    description:
      "Check the food, water, and light outlook the GM has made available.",
  },
  {
    surface: PLAYER_SURFACES.REPUTATION,
    intent: TOOL_INTENTS.TRACK_CAMPAIGN,
    icon: "fa-solid fa-handshake",
    description: "Review faction standings the GM has revealed to players.",
  },
  {
    surface: PLAYER_SURFACES.CRITICAL_INJURIES,
    intent: TOOL_INTENTS.TRACK_CAMPAIGN,
    icon: "fa-solid fa-heart-pulse",
    description:
      "Review your controlled character's injuries and treatment status.",
  },
]);

const PLAYER_HOME_SURFACE_SET = new Set(
  PLAYER_HOME_DESTINATIONS.map((entry) => entry.surface),
);

const QUICK_STARTS = Object.freeze({
  gm: Object.freeze({
    id: "home-gm:v1",
    version: 1,
    title: "Quick start for a Game Master",
    body: "Prepare what the group needs, keep one session tool open during play, then record the lasting result.",
    steps: Object.freeze([
      "Prepare a merchant or review Quartermaster supplies before play.",
      "Use Run the Session for loot and active downtime.",
      "Use Track the Campaign for supplies, factions, and lasting changes.",
    ]),
  }),
  player: Object.freeze({
    id: "home-player:v1",
    version: 1,
    title: "Quick start",
    body: "Everything here is already limited to information and actions available to you.",
    steps: Object.freeze([
      "Open Shops or Downtime when the GM makes them available.",
      "Check Calendar during play.",
      "Review Party Supplies, Factions, and Injuries between turns.",
    ]),
  }),
});

export class InfinityDashboardApp extends HandlebarsApplicationMixin(
  ApplicationV2,
) {
  static _instance = null;
  static _recentToolIds = [];
  static _recentsHydrated = false;
  static _sessionDismissedQuickStarts = new Set();
  static RECENT_LIMIT = 3;

  static _hydrateRecents() {
    if (InfinityDashboardApp._recentsHydrated) return;
    const stored = getSetting(SETTING_KEYS.RECENT_TOOLS);
    InfinityDashboardApp._recentToolIds = Array.isArray(stored)
      ? stored.map((value) => String(value)).filter(Boolean)
      : [];
    InfinityDashboardApp._recentsHydrated = true;
  }

  static _recordRecent(id) {
    if (!id) return;
    InfinityDashboardApp._hydrateRecents();
    const next = InfinityDashboardApp._recentToolIds.filter(
      (entry) => entry !== id,
    );
    next.unshift(id);
    InfinityDashboardApp._recentToolIds = next.slice(
      0,
      InfinityDashboardApp.RECENT_LIMIT,
    );
    void setSetting(SETTING_KEYS.RECENT_TOOLS, [
      ...InfinityDashboardApp._recentToolIds,
    ]);
  }

  static DEFAULT_OPTIONS = {
    id: "infinity-dnd5e-dashboard",
    tag: "section",
    classes: ["infinity-dnd5e", "infinity-dashboard"],
    window: {
      title: "Infinity D&D5e — Home",
      icon: "fa-solid fa-dice-d20",
      resizable: true,
    },
    position: { width: 760, height: 640 },
    actions: {
      launch: InfinityDashboardApp._onLaunch,
      openSettings: InfinityDashboardApp._onOpenSettings,
      help: InfinityDashboardApp._onHelp,
      copyDiagnostics: InfinityDashboardApp._onCopyDiagnostics,
      dismissQuickStart: InfinityDashboardApp._onDismissQuickStart,
      restoreQuickStarts: InfinityDashboardApp._onRestoreQuickStarts,
    },
  };

  static PARTS = {
    body: { template: TEMPLATE_PATH },
  };

  /** Open or focus Home for the current role. */
  static open() {
    playModuleSound(SOUND_EVENTS.UI_OPEN);
    const shouldRefresh = Boolean(InfinityDashboardApp._instance?.rendered);
    const app = openSingleton(
      InfinityDashboardApp,
      () => new InfinityDashboardApp(),
    );
    if (shouldRefresh) void app.render(false);
    return app;
  }

  constructor(options = {}) {
    super(options);
    // A Home opened with privileged GM tiles closes on demotion so those tiles
    // never remain in the DOM. Reopening immediately yields the player Home.
    this._unbindFullGmWindowGuard = isFullGM()
      ? bindFullGmWindowGuard(this)
      : bindPlayerHomePromotionGuard(this);
    this._focusAfterRender = null;
  }

  async _prepareContext() {
    InfinityDashboardApp._hydrateRecents();
    const fullGm = isFullGM();
    const assistantGm = Boolean(globalThis.game?.user?.isGM && !fullGm);
    const moduleVersion = String(
      globalThis.game?.modules?.get?.(MODULE_ID)?.version ?? "0.0.0",
    );
    const registeredTools = fullGm ? getTools() : [];
    const actions = fullGm
      ? registeredTools.map(normalizeRegisteredTool)
      : buildPlayerHomeActions();
    const groups = groupHomeActionsByIntent(actions);
    const recentActions = resolveRecentActions(actions);
    const preferences = await readUiPreferences();
    const quickStart = fullGm ? QUICK_STARTS.gm : QUICK_STARTS.player;
    const dismissedQuickStarts = readDismissedQuickStarts(preferences);
    const quickStartDismissed = isQuickStartDismissed(
      quickStart,
      dismissedQuickStarts,
    );
    const diagnostics = buildDiagnostics({ moduleVersion });

    return {
      moduleId: MODULE_ID,
      moduleVersion,
      isFullGm: fullGm,
      isAssistantGm: assistantGm,
      roleLabel: fullGm
        ? "Game Master Home"
        : assistantGm
          ? "Assistant GM Home"
          : "Player Home",
      headingHint: fullGm
        ? "Prepare the session, run active workflows, and track what changes."
        : "Open the campaign tools and information currently available to you.",
      hasActions: actions.length > 0,
      groups,
      recentTools: recentActions,
      hasRecentTools: recentActions.length > 0,
      quickStart: quickStartDismissed ? null : quickStart,
      hasDismissedQuickStarts:
        quickStartDismissed || dismissedQuickStarts.size > 0,
      helpSteps: fullGm
        ? [
            "Start in Prepare before the session.",
            "Keep the relevant Run the Session tool open during play.",
            "Record lasting changes under Track the Campaign.",
          ]
        : [
            "Only destinations available to your role appear here.",
            "A grey destination explains what needs to become available.",
            "Direct shortcuts still open their matching player windows.",
          ],
      shortcuts: buildShortcuts({ fullGm }),
      diagnostics,

      // Compatibility context for existing harnesses and extensions that still
      // call this surface a dashboard.
      hasTools: actions.length > 0,
      tools: registeredTools.map(normalizeRegisteredTool),
      categories: groupByCategory(registeredTools),
    };
  }

  _onRender(context, options) {
    super._onRender?.(context, options);
    const selector = this._focusAfterRender;
    this._focusAfterRender = null;
    if (!selector) return;
    globalThis.queueMicrotask?.(() => {
      this.element?.querySelector?.(selector)?.focus?.();
    });
  }

  _onClose(options) {
    super._onClose?.(options);
    this._unbindFullGmWindowGuard?.();
    this._unbindFullGmWindowGuard = null;
    InfinityDashboardApp._instance = null;
  }

  /** @this {InfinityDashboardApp} */
  static async _onOpenSettings() {
    const moduleApi = globalThis.game?.modules?.get?.(MODULE_ID)?.api;
    if (typeof moduleApi?.openSettings === "function") {
      try {
        await moduleApi.openSettings();
        playModuleSound(SOUND_EVENTS.ITEM_OPEN);
        return;
      } catch (error) {
        console.warn(`${MODULE_ID} | Infinity Settings did not open`, error);
      }
    }
    try {
      const SettingsConfig =
        globalThis.foundry?.applications?.settings?.SettingsConfig ??
        globalThis.SettingsConfig;
      if (typeof SettingsConfig === "function") {
        renderSettingsConfig(SettingsConfig);
        playModuleSound(SOUND_EVENTS.ITEM_OPEN);
        return;
      }
    } catch (error) {
      playModuleSound(SOUND_EVENTS.WARNING_MUTED);
      console.warn(`${MODULE_ID} | could not open SettingsConfig`, error);
    }
    globalThis.ui?.notifications?.info?.(
      "Open Game Settings, then Module Settings, to edit Infinity D&D5e options.",
    );
  }

  /** @this {InfinityDashboardApp} */
  static _onHelp(_event, target) {
    const root = this.element ?? target?.closest?.(".id-shell");
    const panel = root?.querySelector?.("[data-home-help]");
    if (!panel) return;
    panel.open = true;
    panel.querySelector?.("summary")?.focus?.();
  }

  /** @this {InfinityDashboardApp} */
  static async _onCopyDiagnostics() {
    const moduleVersion = String(
      globalThis.game?.modules?.get?.(MODULE_ID)?.version ?? "0.0.0",
    );
    const text = buildPrivacySafeDiagnosticsText(
      buildDiagnostics({ moduleVersion }),
    );
    const writeText = globalThis.navigator?.clipboard?.writeText;
    if (typeof writeText !== "function") {
      globalThis.ui?.notifications?.info?.(
        "Clipboard access is unavailable. Select the diagnostics text and copy it manually.",
      );
      return;
    }
    try {
      await writeText.call(globalThis.navigator.clipboard, text);
      globalThis.ui?.notifications?.info?.(
        "Infinity diagnostics copied. No character, campaign, or user data was included.",
      );
    } catch (error) {
      console.warn(`${MODULE_ID} | could not copy diagnostics`, error);
      globalThis.ui?.notifications?.warn?.(
        "Diagnostics were not copied. Select the text and copy it manually.",
      );
    }
  }

  /** @this {InfinityDashboardApp} */
  static async _onDismissQuickStart(_event, target) {
    const quickStart = isFullGM() ? QUICK_STARTS.gm : QUICK_STARTS.player;
    if (
      target?.dataset?.quickStartId !== quickStart.id ||
      Number(target?.dataset?.quickStartVersion) !== quickStart.version
    ) {
      return;
    }

    InfinityDashboardApp._sessionDismissedQuickStarts.add(quickStart.id);
    await persistDismissedQuickStart(quickStart);
    this._focusAfterRender = '[data-action="help"]';
    await this.render(false);
  }

  /** @this {InfinityDashboardApp} */
  static async _onRestoreQuickStarts() {
    InfinityDashboardApp._sessionDismissedQuickStarts.clear();
    await restoreDismissedQuickStarts();
    this._focusAfterRender = '[data-action="dismissQuickStart"]';
    await this.render(false);
  }

  /** @this {InfinityDashboardApp} */
  static async _onLaunch(_event, target) {
    const launchKind = String(target?.dataset?.launchKind ?? "");
    const launchId = String(
      target?.dataset?.launchId ?? target?.dataset?.toolId ?? "",
    ).trim();
    if (!launchId) return;

    if (launchKind === "surface") {
      await InfinityDashboardApp._launchPlayerSurface.call(this, launchId);
      return;
    }

    if (launchKind && launchKind !== "tool") return;
    if (!isFullGM()) {
      playModuleSound(SOUND_EVENTS.WARNING_MUTED);
      globalThis.ui?.notifications?.warn?.(
        "Only a Game Master can open that campaign-management tool.",
      );
      return;
    }

    const tool = getTool(launchId);
    if (!tool) {
      playModuleSound(SOUND_EVENTS.WARNING_MUTED);
      notify(
        "warn",
        "That Home destination is no longer available. Nothing changed; refresh Home and choose another destination.",
      );
      return;
    }
    if (tool.status !== "available") {
      playModuleSound(SOUND_EVENTS.WARNING_MUTED);
      globalThis.ui?.notifications?.info?.(
        `${tool.title} is not available in this release yet. Nothing changed.`,
      );
      return;
    }

    try {
      await tool.open();
      InfinityDashboardApp._recordRecent(tool.id);
      void this.render(false);
    } catch (error) {
      console.error(`${MODULE_ID} | failed to open tool "${tool.id}"`, error);
      globalThis.ui?.notifications?.error?.(
        `${tool.title} did not open. Nothing changed; try again.`,
      );
    }
  }

  /** @this {InfinityDashboardApp} */
  static async _launchPlayerSurface(surface) {
    if (!PLAYER_HOME_SURFACE_SET.has(surface)) return;
    const availability = getPlayerSurfaceAvailability(surface);
    if (!availability.available) {
      playModuleSound(SOUND_EVENTS.WARNING_MUTED);
      globalThis.ui?.notifications?.warn?.(availability.reason);
      return;
    }

    const opened = await openPlayerSurface(surface);
    if (!opened) return;
    InfinityDashboardApp._recordRecent(`surface:${surface}`);
    void this.render(false);
  }
}

/** Public role-aware opener; module.js exposes this as api.openHub(). */
export function openHub() {
  return InfinityDashboardApp.open();
}

/** Build the fixed player/Assistant-GM destinations without campaign data. */
export function buildPlayerHomeActions(options = {}) {
  return PLAYER_HOME_DESTINATIONS.map((destination) => {
    const availability = getPlayerSurfaceAvailability(
      destination.surface,
      options,
    );
    return Object.freeze({
      id: `surface:${destination.surface}`,
      recentId: `surface:${destination.surface}`,
      launchId: destination.surface,
      launchKind: "surface",
      surface: destination.surface,
      title: PLAYER_SURFACE_LABELS[destination.surface] ?? destination.surface,
      description: destination.description,
      icon: destination.icon,
      intent: destination.intent,
      status: availability.available ? "available" : "unavailable",
      isAvailable: availability.available,
      isComingSoon: false,
      ariaDisabled: availability.available ? "false" : "true",
      statusDescriptionId: `infinity-home-status-surface-${destination.surface}`,
      statusLabel: availability.available ? "" : "Unavailable",
      statusReason: availability.reason,
    });
  });
}

/** Group Home actions into the stable, task-oriented navigation model. */
export function groupHomeActionsByIntent(actions) {
  return HOME_INTENTS.map((intent) => ({
    ...intent,
    actions: actions.filter((action) => action.intent === intent.id),
  })).filter((group) => group.actions.length > 0);
}

/** Convert already-sanitized diagnostic metadata into copyable plain text. */
export function buildPrivacySafeDiagnosticsText(diagnostics) {
  const versions = (diagnostics?.versions ?? []).map(
    (entry) => `${entry.label}: ${entry.value}`,
  );
  const integrations = (diagnostics?.integrations ?? []).map(
    (entry) => `${entry.label}: ${entry.status} — ${entry.detail}`,
  );
  return [
    "Infinity D&D5e diagnostics",
    ...versions,
    "Integrations",
    ...integrations,
  ].join("\n");
}

function normalizeRegisteredTool(tool) {
  return {
    ...tool,
    recentId: tool.id,
    launchId: tool.id,
    launchKind: "tool",
    isAvailable: tool.status === "available",
    isComingSoon: tool.status === "coming-soon",
    ariaDisabled: tool.status === "available" ? "false" : "true",
    statusDescriptionId: `infinity-home-status-tool-${tool.id}`,
    statusLabel: tool.status === "coming-soon" ? "Coming Soon" : "",
    statusReason:
      tool.status === "coming-soon"
        ? "This tool is planned for a later release."
        : "",
  };
}

function resolveRecentActions(actions) {
  const byId = new Map(actions.map((action) => [action.recentId, action]));
  return InfinityDashboardApp._recentToolIds
    .map((id) => byId.get(id))
    .filter((action) => action?.isAvailable)
    .slice(0, InfinityDashboardApp.RECENT_LIMIT);
}

function renderSettingsConfig(SettingsConfigClass) {
  const app = new SettingsConfigClass();
  let renderResult;
  try {
    renderResult = app.render({ force: true });
  } catch {
    renderResult = app.render(true);
  }
  if (typeof renderResult?.catch === "function") {
    renderResult.catch((error) => {
      console.warn(`${MODULE_ID} | SettingsConfig render failed`, error);
      globalThis.ui?.notifications?.info?.(
        "Open Game Settings, then Module Settings, to edit Infinity D&D5e options.",
      );
    });
  }
}

/** Close a player Home before a promotion could leave stale role markup open. */
function bindPlayerHomePromotionGuard(application) {
  const hooks = globalThis.Hooks;
  if (!application || typeof hooks?.on !== "function") return () => {};
  const eventName = "updateUser";
  let bound = true;
  const hookId = hooks.on(eventName, (user) => {
    if (
      !bound ||
      String(user?.id ?? "") !== String(globalThis.game?.user?.id ?? "") ||
      !isFullGM(user)
    ) {
      return;
    }
    void Promise.resolve(application.close?.()).catch((error) => {
      console.warn(
        `${MODULE_ID} | could not refresh Home after role change`,
        error,
      );
    });
  });
  return () => {
    if (!bound) return;
    bound = false;
    hooks.off?.(eventName, hookId);
  };
}

async function readUiPreferences() {
  const moduleApi = globalThis.game?.modules?.get?.(MODULE_ID)?.api;
  const readers = [
    [moduleApi, moduleApi?.getUiPreferences],
    [null, getStoredUiPreferences],
  ];
  for (const [owner, reader] of readers) {
    if (typeof reader !== "function") continue;
    try {
      const value = await reader.call(owner);
      if (value && typeof value === "object" && !Array.isArray(value)) {
        return value;
      }
    } catch (error) {
      console.warn(`${MODULE_ID} | could not read UI preferences`, error);
    }
  }
  return null;
}

async function persistDismissedQuickStart(quickStart) {
  try {
    await dismissStoredQuickStart(quickStart.id);
    return true;
  } catch (error) {
    console.warn(`${MODULE_ID} | could not dismiss Home quick start`, error);
    return false;
  }
}

async function restoreDismissedQuickStarts() {
  try {
    await restoreStoredQuickStarts();
    return true;
  } catch (error) {
    console.warn(`${MODULE_ID} | could not restore Home quick starts`, error);
    return false;
  }
}

function readDismissedQuickStarts(preferences) {
  const dismissed = new Set();
  const stored = preferences?.dismissedQuickStarts;
  if (Array.isArray(stored)) {
    for (const id of stored) {
      if (typeof id === "string" && id.trim()) dismissed.add(id.trim());
    }
  }
  for (const id of InfinityDashboardApp._sessionDismissedQuickStarts) {
    dismissed.add(id);
  }
  return dismissed;
}

function isQuickStartDismissed(quickStart, dismissed) {
  return dismissed.has(quickStart.id);
}

function buildShortcuts({ fullGm }) {
  const shortcuts = [
    { keys: "Shift+I", label: "Open Infinity Home" },
    { keys: "Shift+D", label: "Open Downtime Activities" },
    { keys: "Shift+O", label: "Open Shops" },
    { keys: "Shift+Q", label: "Open Party Supplies" },
    { keys: "Shift+R", label: "Open revealed Factions" },
    { keys: "Shift+J", label: "Open Critical Injuries" },
  ];
  if (fullGm) {
    shortcuts.push({
      keys: "Enter or R",
      label: "Generate while a loot form has focus",
    });
  }
  return shortcuts;
}

function buildDiagnostics({ moduleVersion, gameRef = globalThis.game }) {
  const playerBridge = getPlayerSurfaceStatus(gameRef);
  const socketlib = gameRef?.modules?.get?.("socketlib");
  const matt = gameRef?.modules?.get?.("monks-active-tiles");
  const calendars = [
    gameRef?.modules?.get?.("foundryvtt-simple-calendar-reborn"),
    gameRef?.modules?.get?.("foundryvtt-simple-calendar"),
  ].filter(Boolean);
  const calendar = calendars.find((entry) => entry.active === true) ?? null;
  const calendarAvailability = getPlayerSurfaceAvailability(
    PLAYER_SURFACES.CALENDAR,
    { gameRef },
  );

  return {
    versions: [
      { label: "Infinity D&D5e", value: moduleVersion },
      {
        label: "Foundry",
        value: String(
          gameRef?.version ?? gameRef?.release?.version ?? "Unknown",
        ),
      },
      {
        label: "D&D5e system",
        value: String(gameRef?.system?.version ?? "Unknown"),
      },
    ],
    integrations: [
      {
        label: "Simple Calendar",
        status: calendarAvailability.available ? "Ready" : "Not available",
        ready: calendarAvailability.available,
        className: calendarAvailability.available ? "is-ready" : "is-not-ready",
        icon: calendarAvailability.available
          ? "fa-circle-check"
          : "fa-circle-minus",
        detail: calendarAvailability.available
          ? `Active${calendar?.version ? ` · v${calendar.version}` : ""}`
          : calendarAvailability.reason,
      },
      {
        label: "Monk's Active Tiles launcher",
        status: playerBridge.mattSenderGuardReady ? "Ready" : "Not ready",
        ready: playerBridge.mattSenderGuardReady,
        className: playerBridge.mattSenderGuardReady
          ? "is-ready"
          : "is-not-ready",
        icon: playerBridge.mattSenderGuardReady
          ? "fa-circle-check"
          : "fa-circle-minus",
        detail: matt?.active
          ? `Installed${playerBridge.mattVersion ? ` · v${playerBridge.mattVersion}` : ""}`
          : "Monk's Active Tiles is not active.",
      },
      {
        label: "Player-window transport",
        status:
          socketlib?.active && playerBridge.handlerRegistered
            ? "Ready"
            : "Not ready",
        ready: Boolean(socketlib?.active && playerBridge.handlerRegistered),
        className:
          socketlib?.active && playerBridge.handlerRegistered
            ? "is-ready"
            : "is-not-ready",
        icon:
          socketlib?.active && playerBridge.handlerRegistered
            ? "fa-circle-check"
            : "fa-circle-minus",
        detail: socketlib?.active
          ? `SocketLib active${socketlib.version ? ` · v${socketlib.version}` : ""}`
          : "SocketLib is not active; remote tile launches are unavailable.",
      },
    ],
  };
}

/** Legacy category grouping retained for dashboard context compatibility. */
function groupByCategory(tools) {
  const order = [];
  const buckets = new Map();
  for (const tool of tools) {
    if (!buckets.has(tool.category)) {
      buckets.set(tool.category, []);
      order.push(tool.category);
    }
    buckets.get(tool.category).push(normalizeRegisteredTool(tool));
  }
  return order.map((category) => ({
    category,
    label: prettyCategory(category),
    tools: buckets.get(category),
  }));
}
