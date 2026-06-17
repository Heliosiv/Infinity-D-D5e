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
import { prettyCategory, notify, escapeHtml } from "./ui-util.js";
import { SETTING_KEYS, getSetting, setSetting } from "./settings.js";
import { openSingleton } from "./infinity-app.js";

const MODULE_ID = "infinity-dnd5e";
const TEMPLATE_PATH = `modules/${MODULE_ID}/templates/dashboard.hbs`;

const { ApplicationV2, HandlebarsApplicationMixin } = foundry.applications.api;

export class InfinityDashboardApp extends HandlebarsApplicationMixin(
  ApplicationV2,
) {
  static _instance = null;

  /** Most-recently-launched tool ids (newest first). Persisted client-side so
   *  the quick-launch row survives reloads (hydrated once per session). */
  static _recentToolIds = [];
  static _recentsHydrated = false;
  /** How many recent tools to pin above the category grid. */
  static RECENT_LIMIT = 3;

  /** Load the persisted recents once (after a reload the static array is empty). */
  static _hydrateRecents() {
    if (InfinityDashboardApp._recentsHydrated) return;
    const stored = getSetting(SETTING_KEYS.RECENT_TOOLS);
    InfinityDashboardApp._recentToolIds = Array.isArray(stored)
      ? stored.map((x) => String(x)).filter(Boolean)
      : [];
    InfinityDashboardApp._recentsHydrated = true;
  }

  /** Record a tool launch; moves it to the front, dedupes, caps, persists. */
  static _recordRecent(id) {
    if (!id) return;
    InfinityDashboardApp._hydrateRecents();
    const next = InfinityDashboardApp._recentToolIds.filter((x) => x !== id);
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
      title: "Infinity D&D5e",
      icon: "fa-solid fa-dice-d20",
      resizable: true,
    },
    position: { width: 720, height: 540 },
    actions: {
      launch: InfinityDashboardApp._onLaunch,
      openSettings: InfinityDashboardApp._onOpenSettings,
      help: InfinityDashboardApp._onHelp,
    },
  };

  static PARTS = {
    body: { template: TEMPLATE_PATH },
  };

  /** Open (or focus) the singleton dashboard instance. */
  static open() {
    playModuleSound(SOUND_EVENTS.UI_OPEN);
    return openSingleton(InfinityDashboardApp, () => new InfinityDashboardApp());
  }

  async _prepareContext() {
    InfinityDashboardApp._hydrateRecents();
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
    // Open Foundry's Configure Settings dialog (the module's options live under
    // its Module Settings section). Best-effort across V12/V13 — both ship a
    // `SettingsConfig` form application. Fall back to a notification if we
    // can't reach it.
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
  static _onHelp(_event, _target) {
    // Plain-language quick-start for non-technical GMs. Best-effort: if
    // DialogV2 isn't reachable (older core), fall back to a notification.
    const DialogV2 = globalThis.foundry?.applications?.api?.DialogV2;
    const content = buildHelpHtml();
    if (typeof DialogV2?.prompt !== "function") {
      ui.notifications?.info(
        "Pick a tool tile to roll treasure, run a shop, or track travel supplies. Reopen this hub anytime with Shift+I.",
      );
      return;
    }
    playModuleSound(SOUND_EVENTS.UI_OPEN);
    try {
      void DialogV2.prompt({
        window: {
          title: "Infinity D&D5e — Help",
          icon: "fa-solid fa-circle-question",
        },
        position: { width: 480 },
        content,
        ok: { label: "Close", icon: "fa-solid fa-check" },
        rejectClose: false,
      });
    } catch (error) {
      console.warn(`${MODULE_ID} | could not open help dialog`, error);
      ui.notifications?.info(
        "Pick a tool tile to roll treasure, run a shop, or track travel supplies. Reopen this hub anytime with Shift+I.",
      );
    }
  }

  /** @this {InfinityDashboardApp} */
  static _onLaunch(_event, target) {
    const id = target?.dataset?.toolId;
    if (!id) return;
    const tool = getTool(id);
    if (!tool) {
      playModuleSound(SOUND_EVENTS.WARNING_MUTED);
      notify("warn", `tool "${id}" is not registered.`);
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
 * Build the plain-language help dialog body. Static copy, but routed through
 * escapeHtml so the few interpolated labels can never break the markup.
 */
function buildHelpHtml() {
  const tools = [
    [
      "Per-Encounter Loot",
      "Roll a quick pile of treasure for a single fight — coins and a few items scaled to the party.",
    ],
    [
      "Hoard Loot",
      "Build a bigger stash for a dragon's lair, vault, or milestone — more coin plus rarer finds.",
    ],
    [
      "Per-Creature Loot",
      "Roll drops creature-by-creature, so each monster's body has its own pickings.",
    ],
  ];
  const toolItems = tools
    .map(
      ([name, desc]) =>
        `<li><strong>${escapeHtml(name)}</strong> — ${escapeHtml(desc)}</li>`,
    )
    .join("");
  return `
    <div class="id-help">
      <p>Pick a tool tile to get started. Here's what each one does:</p>
      <h4>Treasure &amp; Loot</h4>
      <ul>${toolItems}</ul>
      <h4>Shops &amp; Merchants</h4>
      <p>The Merchant tools let you set up a shop and open a buy/sell window for a player, with optional haggling.</p>
      <h4>Keyboard shortcuts</h4>
      <ul>
        <li><strong>Shift+I</strong> — open this dashboard anytime.</li>
        <li><strong>Enter</strong> or <strong>R</strong> — roll inside a loot window.</li>
      </ul>
    </div>
  `;
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
