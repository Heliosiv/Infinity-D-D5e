/**
 * Infinity D&D5e — Dashboard
 *
 * GM-only hub window. Surfaces every registered tool as a launcher
 * tile so adding a new tool is "register it; appears in the hub" —
 * no UI plumbing required. The dashboard itself owns no domain
 * logic; tile clicks defer to the tool's own `open()` callback.
 *
 * Lifecycle mirrors LootForgeApp: a singleton instance is created
 * on first open, focused on subsequent opens, and cleared on close
 * so the next session starts fresh.
 */

import { SOUND_EVENTS, playModuleSound } from "./audio.js";
import { getTool, getTools } from "./tool-registry.js";

const MODULE_ID = "infinity-dnd5e";
const TEMPLATE_PATH = `modules/${MODULE_ID}/templates/dashboard.hbs`;

const { ApplicationV2, HandlebarsApplicationMixin } = foundry.applications.api;

export class InfinityDashboardApp extends HandlebarsApplicationMixin(
  ApplicationV2,
) {
  static _instance = null;

  /** Session-scoped most-recently-launched tool ids (newest first). */
  static _recentToolIds = [];
  /** How many recent tools to pin above the category grid. */
  static RECENT_LIMIT = 3;

  /** Record a tool launch; moves it to the front, dedupes, caps the list. */
  static _recordRecent(id) {
    if (!id) return;
    const next = InfinityDashboardApp._recentToolIds.filter((x) => x !== id);
    next.unshift(id);
    InfinityDashboardApp._recentToolIds = next.slice(
      0,
      InfinityDashboardApp.RECENT_LIMIT,
    );
  }

  static DEFAULT_OPTIONS = {
    id: "infinity-dnd5e-dashboard",
    tag: "section",
    classes: ["infinity-dnd5e", "infinity-dashboard"],
    window: {
      title: "Infinity D&D5e",
      icon: "fa-solid fa-dice-d20",
      resizable: true,
    },
    position: { width: 720, height: 540 },
    actions: {
      launch: InfinityDashboardApp._onLaunch,
      openSettings: InfinityDashboardApp._onOpenSettings,
    },
  };

  static PARTS = {
    body: { template: TEMPLATE_PATH },
  };

  /** Open (or focus) the singleton dashboard instance. */
  static open() {
    playModuleSound(SOUND_EVENTS.UI_OPEN);
    if (!InfinityDashboardApp._instance) {
      InfinityDashboardApp._instance = new InfinityDashboardApp();
    }
    if (InfinityDashboardApp._instance.rendered) {
      InfinityDashboardApp._instance.bringToFront();
    } else {
      InfinityDashboardApp._instance.render(true);
    }
    return InfinityDashboardApp._instance;
  }

  async _prepareContext() {
    const tools = getTools();
    const moduleVersion = String(
      game.modules?.get?.(MODULE_ID)?.version ?? "0.0.0",
    );
    const recentTools = InfinityDashboardApp._recentToolIds
      .map((id) => getTool(id))
      .filter((tool) => tool && tool.status === "available")
      .map((tool) => ({
        ...tool,
        isAvailable: true,
        isComingSoon: false,
        statusLabel: "",
      }));

    return {
      moduleId: MODULE_ID,
      moduleVersion,
      hasTools: tools.length > 0,
      tools: tools.map((tool) => ({
        ...tool,
        isAvailable: tool.status === "available",
        isComingSoon: tool.status === "coming-soon",
        statusLabel: tool.status === "coming-soon" ? "Coming Soon" : "",
      })),
      recentTools,
      hasRecentTools: recentTools.length > 0,
      categories: groupByCategory(tools),
    };
  }

  _onClose(options) {
    super._onClose?.(options);
    InfinityDashboardApp._instance = null;
  }

  /** @this {InfinityDashboardApp} */
  static _onOpenSettings(_event, _target) {
    // Foundry's Configure Settings dialog scrolled to the Module
    // Settings tab. Best-effort across V12/V13 — both ship a
    // `SettingsConfig` form application. Fall back to a notification
    // if we can't reach it.
    try {
      const SC =
        globalThis.foundry?.applications?.settings?.SettingsConfig ??
        globalThis.SettingsConfig;
      if (typeof SC === "function") {
        renderSettingsConfig(SC);
        playModuleSound(SOUND_EVENTS.ITEM_OPEN);
        return;
      }
    } catch (error) {
      playModuleSound(SOUND_EVENTS.WARNING_MUTED);
      console.warn(`${MODULE_ID} | could not open SettingsConfig`, error);
    }
    ui.notifications?.info(
      "Open Foundry's Game Settings → Configure Settings → Module Settings to edit Infinity D&D5e defaults.",
    );
  }

  /** @this {InfinityDashboardApp} */
  static _onLaunch(_event, target) {
    const id = target?.dataset?.toolId;
    if (!id) return;
    const tool = getTool(id);
    if (!tool) {
      playModuleSound(SOUND_EVENTS.WARNING_MUTED);
      ui.notifications?.warn(`${MODULE_ID}: tool "${id}" is not registered.`);
      return;
    }
    if (tool.status !== "available") {
      playModuleSound(SOUND_EVENTS.WARNING_MUTED);
      ui.notifications?.info(`${tool.title} — coming in a later release.`);
      return;
    }
    try {
      tool.open();
      InfinityDashboardApp._recordRecent(id);
      // Refresh so the Recently Used row reflects this launch next time the
      // dashboard is glanced at. render(false) doesn't steal focus from the
      // tool window that just opened.
      void this.render(false);
    } catch (error) {
      console.error(`${MODULE_ID} | failed to open tool "${id}"`, error);
      ui.notifications?.error(`Failed to open ${tool.title}. See console.`);
    }
  }
}

function renderSettingsConfig(SettingsConfigClass) {
  const app = new SettingsConfigClass();
  let renderResult;
  try {
    renderResult = app.render({ force: true });
  } catch (error) {
    renderResult = app.render(true);
  }
  if (typeof renderResult?.catch === "function") {
    renderResult.catch((error) => {
      console.warn(`${MODULE_ID} | SettingsConfig render failed`, error);
      ui.notifications?.info(
        "Open Foundry's Game Settings -> Configure Settings -> Module Settings to edit Infinity D&D5e defaults.",
      );
    });
  }
}

/**
 * Group tools by category preserving registration order within each
 * category. Lets the template render section headers if we ever
 * outgrow a single flat tile grid.
 */
function groupByCategory(tools) {
  const order = [];
  const buckets = new Map();
  for (const tool of tools) {
    if (!buckets.has(tool.category)) {
      buckets.set(tool.category, []);
      order.push(tool.category);
    }
    buckets.get(tool.category).push({
      ...tool,
      isAvailable: tool.status === "available",
      isComingSoon: tool.status === "coming-soon",
      statusLabel: tool.status === "coming-soon" ? "Coming Soon" : "",
    });
  }
  return order.map((category) => ({
    category,
    label: prettyCategory(category),
    tools: buckets.get(category),
  }));
}

function prettyCategory(value) {
  const raw = String(value ?? "").trim();
  if (!raw) return "Tools";
  return raw.charAt(0).toUpperCase() + raw.slice(1);
}
