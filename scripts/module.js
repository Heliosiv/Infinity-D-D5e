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
import { HordeLootApp } from "./horde-loot.js";
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
    id: "horde-loot",
    title: "Horde Loot",
    description:
      "Treasure for a defeated mob — mob size sets the budget, Pile Bias trades coin for items.",
    icon: "fa-solid fa-sack-dollar",
    category: "loot",
    status: "available",
    open: () => HordeLootApp.open(),
  });

  registerTool({
    id: "per-creature-loot",
    title: "Per-Creature Loot",
    description:
      "Generate individual drops per creature in an encounter, summed into one bundle.",
    icon: "fa-solid fa-skull",
    category: "loot",
    status: "coming-soon",
    open: () => {},
  });
}

/* ------------------------------------------------------------------ *
 * Foundry lifecycle hooks
 * ------------------------------------------------------------------ */

Hooks.once("init", () => {
  console.log(`${MODULE_ID} | init`);
  registerSettings();
  registerBuiltinTools();
});

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
      openHordeLoot: () => HordeLootApp.open(),
    };
  }
});

/**
 * Add a GM-only scene-control button under the "tokens" toolbar.
 * Clicking it opens the dashboard, which is the single entry point
 * for every tool. Foundry V12 uses `getSceneControlButtons`; V13+
 * keeps the same hook but the controls object shape differs — the
 * normalization below tolerates both.
 */
Hooks.on("getSceneControlButtons", (controls) => {
  if (!game.user?.isGM) return;

  const tools = {
    name: "infinity-dnd5e-dashboard",
    title: "Infinity D&D5e",
    icon: "fa-solid fa-dice-d20",
    button: true,
    visible: true,
    onClick: () => InfinityDashboardApp.open(),
    onChange: () => InfinityDashboardApp.open(),
  };

  // V12 shape: controls is an Array<{ name, tools: Array<...> }>
  if (Array.isArray(controls)) {
    const tokenControl =
      controls.find((c) => c?.name === "token") ?? controls[0];
    if (tokenControl && Array.isArray(tokenControl.tools)) {
      tokenControl.tools.push(tools);
    }
    return;
  }

  // V13+ shape: controls is a Record<name, { tools: Record<name, ...> }>
  if (controls && typeof controls === "object") {
    const tokenControl =
      controls.tokens ?? controls.token ?? Object.values(controls)[0];
    if (tokenControl && typeof tokenControl.tools === "object") {
      tokenControl.tools[tools.name] = tools;
    }
  }
});
