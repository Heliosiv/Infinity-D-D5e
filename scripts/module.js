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
import { computeLootBudget } from "./loot/budget.js";
import {
  distributeItemsToActor,
  promptDistributeItems,
} from "./loot/distribute.js";
import { loadCompendiumItems } from "./loot/pack.js";
import { filterCandidates, rollLoot } from "./loot/roller.js";
import { getItemRarity } from "./loot/tag-vocabulary.js";

const MODULE_ID = "infinity-dnd5e";
const PACK_ID = `${MODULE_ID}.infinity-dnd5e-items`;

// Very first thing we do — log that the ESM was evaluated at all. If
// this line never appears in the console, the import chain failed
// before our code ran (usually a top-level evaluation error in one of
// the imported files).
console.log(`${MODULE_ID} | module.js evaluating…`);

/* ------------------------------------------------------------------ *
 * Eager API assignment
 *
 * Foundry exposes a per-module API object via game.modules.get(id).api.
 * The traditional pattern is to set it inside `ready`, but if anything
 * else in `ready` throws first, the API never gets set — and macros,
 * Shift+I, and console probing all silently fail.
 *
 * Assigning here, at top-level evaluation, gives us a stable API as
 * long as the ESM loads at all, independent of any hook outcome.
 * ------------------------------------------------------------------ */

function buildApi() {
  return {
    openDashboard: () => InfinityDashboardApp.open(),
    openPerEncounterLoot: () => PerEncounterLootApp.open(),
    openHoardLoot: () => HoardLootApp.open(),
    openPerCreatureLoot: () => PerCreatureLootApp.open(),

    rollLootBundle: async (opts = {}) => {
      const budget = computeLootBudget({
        tier: opts.tier ?? "t2",
        scale: opts.scale ?? "standard",
        generosity: opts.generosity ?? "balanced",
        partySize: opts.partySize ?? 4,
        override: opts.budgetOverride ?? 0,
      });
      const items = await loadCompendiumItems({
        packId: opts.packId ?? PACK_ID,
      });
      const candidates = filterCandidates(items, {
        tiers: [opts.tier ?? "t2"],
        rarities: opts.rarities ?? ["uncommon", "rare"],
        lootTypes: opts.lootTypes ?? [],
        requireEligible: true,
      });
      const raw = rollLoot(candidates, {
        count: opts.count ?? 0,
        budgetGp: budget,
      });
      return {
        ...raw,
        items: raw.items.map((entry) => ({
          ...entry,
          uuid: entry.item?.uuid ?? null,
          rarity: getItemRarity(entry.item) || "common",
        })),
      };
    },

    distributeBundle: (actorId, uuids) =>
      distributeItemsToActor(actorId, uuids),

    promptDistribute: (uuids, options) =>
      promptDistributeItems(uuids, options),
  };
}

try {
  const eagerMod = globalThis.game?.modules?.get?.(MODULE_ID);
  if (eagerMod) {
    eagerMod.api = buildApi();
    console.log(`${MODULE_ID} | api set eagerly at module-load time`);
  } else {
    console.log(
      `${MODULE_ID} | game.modules not ready at load — will retry at init/ready`,
    );
  }
} catch (error) {
  console.warn(`${MODULE_ID} | eager api assignment failed`, error);
}

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
  console.log(`${MODULE_ID} | init hook firing`);
  // Re-set the api here too in case eager assignment ran before
  // game.modules existed.
  try {
    const mod = game.modules?.get?.(MODULE_ID);
    if (mod && !mod.api) {
      mod.api = buildApi();
      console.log(`${MODULE_ID} | api set during init`);
    }
  } catch (error) {
    console.warn(`${MODULE_ID} | init api assignment failed`, error);
  }
  try {
    registerSettings();
  } catch (error) {
    console.error(`${MODULE_ID} | registerSettings failed`, error);
  }
  try {
    registerKeybindings();
  } catch (error) {
    console.error(`${MODULE_ID} | registerKeybindings failed`, error);
  }
  try {
    registerBuiltinTools();
  } catch (error) {
    console.error(`${MODULE_ID} | registerBuiltinTools failed`, error);
  }
  console.log(`${MODULE_ID} | init hook complete`);
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
  try {
    const version = game.modules?.get?.(MODULE_ID)?.version ?? "?";
    const foundryGen = globalThis.foundry?.utils?.foundryVersion?.generation;
    const foundryVersion = globalThis.game?.release?.version ?? "?";
    console.log(
      `%c${MODULE_ID} %cready · module v${version} · Foundry v${foundryVersion} (gen ${foundryGen ?? "?"}) · system ${game.system?.id}@${game.system?.version}`,
      "color: #ffb15d; font-weight: bold",
      "color: inherit",
    );
    console.log(
      `${MODULE_ID} | dashboard access: sidebar Items tab d20 button, left scene-controls, Shift+I keybind, or game.modules.get("${MODULE_ID}").api.openDashboard()`,
    );
    // Final api set — always safe, idempotent.
    const mod = game.modules?.get?.(MODULE_ID);
    if (mod && !mod.api) mod.api = buildApi();
  } catch (error) {
    console.error(`${MODULE_ID} | ready hook failed`, error);
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
    toggle: false,
    onClick: () => InfinityDashboardApp.open(),
    onChange: () => InfinityDashboardApp.open(),
  };

  // Diagnostic: log what shape we got so a missing launcher can be
  // traced from the console rather than guessed at.
  const shape = Array.isArray(controls)
    ? `Array(${controls.length})`
    : controls && typeof controls === "object"
      ? `Record(${Object.keys(controls).length})`
      : typeof controls;
  console.log(`${MODULE_ID} | scene-controls hook fired, shape=${shape}`);

  try {
    if (Array.isArray(controls)) {
      /* ---------- V12 shape: controls is an Array ---------- */
      controls.push({
        name: "infinity-dnd5e",
        title: "Infinity D&D5e",
        icon: "fa-solid fa-dice-d20",
        visible: true,
        activeTool: launcherToolName,
        order: 99,
        tools: [{ ...baseTool, name: launcherToolName }],
      });
      const tokenControl =
        controls.find((c) => c?.name === "token") ?? controls[0];
      if (tokenControl && Array.isArray(tokenControl.tools)) {
        tokenControl.tools.push({
          ...baseTool,
          name: dashboardToolName,
          title: "Infinity D&D5e",
        });
      }
      console.log(
        `${MODULE_ID} | registered V12 controls (category + tools fallback)`,
      );
    } else if (controls && typeof controls === "object") {
      /* ---------- V13+ shape: controls is a Record ---------- */
      controls["infinity-dnd5e"] = {
        name: "infinity-dnd5e",
        title: "Infinity D&D5e",
        icon: "fa-solid fa-dice-d20",
        visible: true,
        activeTool: launcherToolName,
        order: 99,
        tools: {
          [launcherToolName]: { ...baseTool, name: launcherToolName },
        },
      };
      const tokenControl =
        controls.tokens ?? controls.token ?? Object.values(controls)[0];
      if (tokenControl && typeof tokenControl.tools === "object") {
        tokenControl.tools[dashboardToolName] = {
          ...baseTool,
          name: dashboardToolName,
          title: "Infinity D&D5e",
        };
      }
      console.log(
        `${MODULE_ID} | registered V13 controls (category + tools fallback)`,
      );
    } else {
      console.warn(
        `${MODULE_ID} | scene-controls payload was neither Array nor Object (got ${typeof controls}); skipping launcher registration`,
      );
    }
  } catch (error) {
    console.error(`${MODULE_ID} | scene-controls registration failed`, error);
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
    "Infinity D&D5e is ready. Launch from the d20 button at the top of the Items sidebar, the left scene-controls toolbar, or Shift+I.",
    { permanent: true },
  );
  // Mark the flag in-memory so we don't double-fire if ready runs twice.
  if (mod.flags) mod.flags.welcomeSeen = true;
});

/* ------------------------------------------------------------------ *
 * Sidebar launcher — bulletproof against UI-overhaul modules.
 *
 * Scene-control registration sometimes gets filtered by UI overhauls
 * (Minimal UI, Tidy, etc.). The Foundry sidebar, on the other hand,
 * is rendered by the core code and almost always survives those
 * overrides. We inject a small button at the top of any directory
 * tab the GM might open — Items, Compendium, Actors — so at least
 * one entry point is visible no matter what skin is loaded.
 * ------------------------------------------------------------------ */

const SIDEBAR_LAUNCHER_FLAG = "data-infinity-dnd5e-launcher";

function injectSidebarLauncher(rendered, hookName = "?") {
  if (!game.user?.isGM) return;
  // Foundry V12 hooks pass jQuery as `html`; V13+ pass a raw HTMLElement
  // or an ApplicationV2 instance that has `.element`.
  const root =
    rendered instanceof HTMLElement
      ? rendered
      : (rendered?.[0] ??
        rendered?.element?.[0] ??
        rendered?.element ??
        (rendered?.querySelector ? rendered : null));
  if (!root || typeof root.querySelector !== "function") {
    console.debug(
      `${MODULE_ID} | sidebar launcher (${hookName}): no root element to inject into`,
    );
    return;
  }
  if (root.querySelector(`[${SIDEBAR_LAUNCHER_FLAG}]`)) return;

  // V11/V12/V13 have all used slightly different sidebar headers. Try
  // every plausible target in order, fall back to the root itself so
  // the button always lands somewhere visible.
  const HEADER_SELECTORS = [
    ".directory-header",
    "header.directory-header",
    "section > header",
    ".action-buttons",
    "header",
    ".window-header",
  ];
  let target = null;
  for (const sel of HEADER_SELECTORS) {
    target = root.querySelector(sel);
    if (target) break;
  }
  target = target ?? root;

  const btn = document.createElement("button");
  btn.type = "button";
  btn.setAttribute(SIDEBAR_LAUNCHER_FLAG, "true");
  btn.className = "infinity-dnd5e-sidebar-launcher";
  btn.title = "Open Infinity D&D5e Dashboard (Shift+I)";
  btn.innerHTML =
    '<i class="fa-solid fa-dice-d20" aria-hidden="true"></i><span>Infinity D&D5e</span>';
  btn.addEventListener("click", (event) => {
    event.preventDefault();
    event.stopPropagation();
    InfinityDashboardApp.open();
  });

  // Insert above the rest of the header so it can't be hidden behind
  // a search box.
  target.prepend(btn);
  console.log(
    `${MODULE_ID} | sidebar launcher injected via ${hookName} into <${target.tagName.toLowerCase()}${target.className ? "." + target.className.split(" ").join(".") : ""}>`,
  );
}

// Cover every hook Foundry has ever fired for directory rendering.
// `renderApplicationV2` catches the V13 generic pass for sidebar tabs
// that don't have their own named hook.
for (const hookName of [
  "renderItemDirectory",
  "renderCompendiumDirectory",
  "renderCompendiumSidebar",
  "renderActorDirectory",
  "renderSidebarTab",
  "renderSidebar",
]) {
  Hooks.on(hookName, (app, html) => injectSidebarLauncher(html, hookName));
}
Hooks.on("renderApplicationV2", (app, html) => {
  const name = app?.constructor?.name ?? "";
  if (/Directory|Sidebar/i.test(name)) {
    injectSidebarLauncher(html, `renderApplicationV2/${name}`);
  }
});
