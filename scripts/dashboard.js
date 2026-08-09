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
  openPlayerSurface,
  PLAYER_SURFACE_LABELS,
  PLAYER_SURFACES,
} from "./player-surface.js";
import { promptInfinityDialog } from "./dialog-contract.js";
import * as settingsApi from "./settings.js";
import { getTool, getTools, TOOL_INTENTS } from "./tool-registry.js";
import { escapeHtml, prettyCategory, notify } from "./ui-util.js";
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

export class InfinityDashboardApp extends HandlebarsApplicationMixin(
  ApplicationV2,
) {
  static _instance = null;
  static _recentToolIds = [];
  static _recentsHydrated = false;
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

      // Compatibility context for existing harnesses and extensions that still
      // call this surface a dashboard.
      hasTools: actions.length > 0,
      tools: registeredTools.map(normalizeRegisteredTool),
      categories: groupByCategory(registeredTools),
    };
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
  static async _onHelp() {
    const fullGm = isFullGM();
    await promptInfinityDialog({
      window: {
        title: "Infinity D&D5e — Home Help",
        icon: "fa-solid fa-circle-question",
      },
      content: buildHomeHelpDialogContent({ fullGm }),
      ok: {
        label: "Close",
        icon: "fa-solid fa-check",
        callback: () => true,
      },
      rejectClose: false,
    });
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

/** Build the concise, role-aware content opened by the Home header Help button. */
export function buildHomeHelpDialogContent({ fullGm = false } = {}) {
  const steps = fullGm
    ? [
        "Prepare: set up merchants and supplies before play.",
        "Run the Session: open loot, downtime, or the calendar while play is moving.",
        "Track the Campaign: review lasting supplies, faction, and injury changes.",
      ]
    : [
        "Open any available destination; Home only shows player-safe tools.",
        "Unavailable cards explain what the GM needs to enable.",
        "Use a shortcut below to reopen a familiar window.",
      ];
  const stepMarkup = steps
    .map((step) => `<li>${escapeHtml(step)}</li>`)
    .join("");
  const shortcutMarkup = buildShortcuts({ fullGm })
    .map(
      ({ keys, label }) =>
        `<div><dt><kbd>${escapeHtml(keys)}</kbd></dt><dd>${escapeHtml(label)}</dd></div>`,
    )
    .join("");
  return `<div class="id-help-dialog">
    <p>Choose a destination in Home. Disabled cards explain what is needed without changing campaign data.</p>
    <ol>${stepMarkup}</ol>
    <h3>Keyboard shortcuts</h3>
    <dl class="id-help-dialog__shortcuts">${shortcutMarkup}</dl>
    <p>Restore dismissed workspace guides from Infinity Settings.</p>
  </div>`;
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
