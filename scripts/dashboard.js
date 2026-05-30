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

import { getTool, getTools } from "./tool-registry.js";

const MODULE_ID = "infinity-dnd5e";
const TEMPLATE_PATH = `modules/${MODULE_ID}/templates/dashboard.hbs`;

const { ApplicationV2, HandlebarsApplicationMixin } = foundry.applications.api;

export class InfinityDashboardApp extends HandlebarsApplicationMixin(
  ApplicationV2,
) {
  static _instance = null;

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
      categories: groupByCategory(tools),
    };
  }

  _onClose(options) {
    super._onClose?.(options);
    InfinityDashboardApp._instance = null;
  }

  /** @this {InfinityDashboardApp} */
  static async _onOpenSettings(_event, _target) {
    // Foundry's Configure Settings dialog scrolled to the Module
    // Settings tab. Best-effort across V12/V13 — both ship a
    // `SettingsConfig` form application. Fall back to a notification
    // if we can't reach it.
    try {
      const SC =
        globalThis.foundry?.applications?.settings?.SettingsConfig ??
        globalThis.SettingsConfig;
      if (typeof SC === "function") {
        new SC().render(true);
        return;
      }
    } catch (error) {
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
      ui.notifications?.warn(`${MODULE_ID}: tool "${id}" is not registered.`);
      return;
    }
    if (tool.status !== "available") {
      ui.notifications?.info(`${tool.title} — coming in a later release.`);
      return;
    }
    try {
      tool.open();
    } catch (error) {
      console.error(`${MODULE_ID} | failed to open tool "${id}"`, error);
      ui.notifications?.error(`Failed to open ${tool.title}. See console.`);
    }
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
