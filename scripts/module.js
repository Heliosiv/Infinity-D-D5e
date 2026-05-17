/**
 * Infinity D&D5e — Foundry entry point.
 *
 * Registers the GM-only Dashboard window plus its scene-control
 * launcher button, and seeds the tool registry with every available
 * (and "coming soon") tool. The Dashboard reads the registry at
 * render time so adding a new tool only requires a registerTool()
 * call — no UI plumbing.
 */

import { InfinityDashboardApp } from "./dashboard.js";
import { PerEncounterLootApp } from "./app.js";
import { HoardLootApp } from "./hoard-loot.js";
import { PerCreatureLootApp } from "./per-creature-loot.js";
import { SETTINGS } from "./settings.js";
import { registerTool } from "./tool-registry.js";

const MODULE_ID = "infinity-dnd5e";

/* ------------------------------------------------------------------ *
 * Settings registration
 * ------------------------------------------------------------------ */

function registerSettings() {
  if (!game?.settings?.register) return;
  for (const entry of SETTINGS) {
    const opts = {
      name: entry.name,
      hint: entry.hint,
      scope: entry.scope,
      config: entry.config,
      type: entry.type,
      default: entry.default,
    };
    if (entry.choices) opts.choices = entry.choices;
    if (entry.range) opts.range = entry.range;
    if (entry.onChange) opts.onChange = entry.onChange;
    try {
      game.settings.register(MODULE_ID, entry.key, opts);
    } catch (error) {
      console.warn(
        `${MODULE_ID} | failed to register setting "${entry.key}"`,
        error,
      );
    }
  }
}

/* ------------------------------------------------------------------ *
 * Tool registration
 * ------------------------------------------------------------------ */

function registerBuiltinTools() {
  registerTool({
    id: "per-encounter-loot",
    title: "Per-Encounter Loot",
    description:
      "Roll a single treasure bundle for one encounter, sized by tier, scale, and party.",
    icon: "fa-solid fa-coins",
    category: "loot",
    status: "available",
    open: () => PerEncounterLootApp.open(),
  });

  registerTool({
    id: "hoard-loot",
    title: "Hoard Loot",
    description:
      "A treasure cache — tier × scale sets the budget, Pile Bias trades raw coin for items.",
    icon: "fa-solid fa-sack-dollar",
    category: "loot",
    status: "available",
    open: () => HoardLootApp.open(),
  });

  registerTool({
    id: "per-creature-loot",
    title: "Per-Creature Loot",
    description:
      "Build a roster of defeated creatures; each rolls its own small bundle, totals stack at the bottom.",
    icon: "fa-solid fa-skull",
    category: "loot",
    status: "available",
    open: () => PerCreatureLootApp.open(),
  });
}

/* ------------------------------------------------------------------ *
 * Foundry lifecycle hooks
 * ------------------------------------------------------------------ */

Hooks.once("init", () => {
  console.log(`${MODULE_ID} | init`);
  registerSettings();
  registerKeybindings();
  registerBuiltinTools();
});

/* ------------------------------------------------------------------ *
 * Keybindings
 *
 * Registers Shift+I (default — user-rebindable from Configure Controls)
 * to open the dashboard from anywhere in the game. GM-only.
 * ------------------------------------------------------------------ */

function registerKeybindings() {
  if (!game?.keybindings?.register) return;
  try {
    game.keybindings.register(MODULE_ID, "openDashboard", {
      name: "Open Infinity D&D5e Dashboard",
      hint: "Toggle the GM tool hub from anywhere in the game.",
      editable: [{ key: "KeyI", modifiers: ["Shift"] }],
      onDown: () => {
        InfinityDashboardApp.open();
        return true; // consume the event
      },
      restricted: true, // GM-only
      precedence: globalThis.CONST?.KEYBINDING_PRECEDENCE?.NORMAL,
    });
  } catch (error) {
    console.warn(`${MODULE_ID} | failed to register keybindings`, error);
  }
}

/**
 * Foundry ready — log the boot line and expose the module API.
 * Combined into a single handler so external code never has to guess
 * which ready pass owns which side effect.
 */
Hooks.once("ready", () => {
  console.log(
    `${MODULE_ID} | ready (game.system: ${game.system?.id}@${game.system?.version})`,
  );
  const mod = game.modules?.get?.(MODULE_ID);
  if (mod) {
    mod.api = {
      openDashboard: () => InfinityDashboardApp.open(),
      openPerEncounterLoot: () => PerEncounterLootApp.open(),
      openHoardLoot: () => HoardLootApp.open(),
      openPerCreatureLoot: () => PerCreatureLootApp.open(),
    };
  }
});

/**
 * Add GM-only entry points to the scene-controls toolbar.
 *
 * Strategy: we register the dashboard *twice* so the user can't miss it.
 *  1. A new top-level category at the bottom of the left scene-controls
 *     column ("Infinity D&D5e", d20 icon). Clicking it opens the
 *     dashboard. This is the primary, most-discoverable launcher.
 *  2. A secondary tool button inside Token Controls — the conventional
 *     spot for module utilities and a familiar pattern for GMs who've
 *     used party-operations.
 *
 * Foundry V12 hands us an Array<{ name, tools: Array }>; V13+ hands us
 * a Record<name, { tools: Record }>. We handle both shapes.
 */
Hooks.on("getSceneControlButtons", (controls) => {
  if (!game.user?.isGM) return;

  const launcherToolName = "infinity-dnd5e-launcher";
  const dashboardToolName = "infinity-dnd5e-dashboard";

  const baseTool = {
    title: "Open Infinity D&D5e Dashboard",
    icon: "fa-solid fa-dice-d20",
    button: true,
    visible: true,
    onClick: () => InfinityDashboardApp.open(),
    onChange: () => InfinityDashboardApp.open(),
  };

  /* ---------- V12 shape: controls is an Array ---------- */
  if (Array.isArray(controls)) {
    // 1. Top-level category at the end of the left column.
    controls.push({
      name: "infinity-dnd5e",
      title: "Infinity D&D5e",
      icon: "fa-solid fa-dice-d20",
      visible: true,
      activeTool: launcherToolName,
      tools: [{ ...baseTool, name: launcherToolName }],
    });
    // 2. Fallback tool under Token Controls.
    const tokenControl =
      controls.find((c) => c?.name === "token") ?? controls[0];
    if (tokenControl && Array.isArray(tokenControl.tools)) {
      tokenControl.tools.push({
        ...baseTool,
        name: dashboardToolName,
        title: "Infinity D&D5e",
      });
    }
    return;
  }

  /* ---------- V13+ shape: controls is a Record ---------- */
  if (controls && typeof controls === "object") {
    // 1. Top-level category.
    controls["infinity-dnd5e"] = {
      name: "infinity-dnd5e",
      title: "Infinity D&D5e",
      icon: "fa-solid fa-dice-d20",
      visible: true,
      activeTool: launcherToolName,
      tools: {
        [launcherToolName]: { ...baseTool, name: launcherToolName },
      },
    };
    // 2. Fallback tool under Token Controls.
    const tokenControl =
      controls.tokens ?? controls.token ?? Object.values(controls)[0];
    if (tokenControl && typeof tokenControl.tools === "object") {
      tokenControl.tools[dashboardToolName] = {
        ...baseTool,
        name: dashboardToolName,
        title: "Infinity D&D5e",
      };
    }
  }
});

/**
 * One-time welcome notification on the first ready after install /
 * enable, telling the GM where to find the launcher. Suppressed once
 * acknowledged via the world-scoped "welcomeSeen" flag.
 */
Hooks.once("ready", () => {
  if (!game.user?.isGM) return;
  const mod = game.modules?.get?.(MODULE_ID);
  if (!mod) return;
  const seen = mod.flags?.welcomeSeen === true;
  if (seen) return;
  ui.notifications?.info(
    "Infinity D&D5e is ready. Open the dashboard from the d20 icon in the left toolbar, or press Shift+I.",
    { permanent: false },
  );
  // Mark the flag in-memory so we don't double-fire if ready runs twice.
  if (mod.flags) mod.flags.welcomeSeen = true;
});
