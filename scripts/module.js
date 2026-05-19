/**
 * Infinity D&D5e — Foundry entry point.
 *
 * Registers the GM-only Loot Forge window and the scene-control
 * button that opens it. Keeps top-level glue minimal so each
 * feature owns its own bootstrap inside scripts/<feature>/.
 */

import { LootForgeApp } from "./app.js";
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

/** Client setting: serialized form state, restored on window open. */
const SETTING_FORM_STATE = "lootForgeFormState";

/** Foundry init — register settings, keybindings, and the scene control. */
Hooks.once("init", () => {
  console.log(`${MODULE_ID} | init`);
  game.settings?.register(MODULE_ID, SETTING_FORM_STATE, {
    name: "Loot Forge form state",
    hint: "Saved filter values so the Loot Forge reopens to your last setup.",
    scope: "client",
    config: false,
    type: Object,
    default: {},
  });

  // Global keybinding — ALWAYS works, even when a UI overhaul
  // module hides our scene-control button.
  game.keybindings?.register(MODULE_ID, "openLootForge", {
    name: "Open Loot Forge",
    hint: "Toggle the GM-only Loot Forge window.",
    editable: [{ key: "KeyL", modifiers: ["Control", "Shift"] }],
    restricted: true, // GM-only
    onDown: () => {
      LootForgeApp.open();
      return true;
    },
  });
});

/** Foundry ready — instances are now safe to construct. */
Hooks.once("ready", () => {
  console.log(
    `${MODULE_ID} | ready (game.system: ${game.system?.id}@${game.system?.version})`,
  );
});

/**
 * Add a GM-only scene-control button under the tokens toolbar.
 *
 * Two Foundry control shapes in the wild:
 *  - V12: controls is `Array<{ name: "token", tools: Array<...> }>`.
 *    Each tool needs `onClick`.
 *  - V13: controls is `Record<name, { tools: Record<name, ...> }>`.
 *    Each tool needs `order` (for sort), `onChange`, and a string
 *    `name` matching its record key — anything missing those gets
 *    silently dropped by the renderer.
 *
 * UI-overhaul modules (Minimal UI, Tidy etc.) may filter unknown
 * tools regardless; the global keybinding registered in `init` is
 * the reliable fallback.
 */
Hooks.on("getSceneControlButtons", (controls) => {
  if (!game.user?.isGM) return;

  const toolName = "infinity-dnd5e-loot-forge";
  const tool = {
    name: toolName,
    title: "Infinity D&D5e — Loot Forge",
    icon: "fa-solid fa-coins",
    button: true,
    visible: true,
    toggle: false,
    order: 999,
    onClick: () => LootForgeApp.open(),
    onChange: (_event, _active) => LootForgeApp.open(),
  };

  // V12 shape: top-level array.
  if (Array.isArray(controls)) {
    const tokenControl =
      controls.find((c) => c?.name === "token") ?? controls[0];
    if (tokenControl && Array.isArray(tokenControl.tools)) {
      tokenControl.tools.push(tool);
    }
    return;
  }

  // V13 shape: record keyed by category name.
  if (controls && typeof controls === "object") {
    const tokenControl =
      controls.tokens ?? controls.token ?? Object.values(controls)[0];
    if (!tokenControl) return;

    if (Array.isArray(tokenControl.tools)) {
      tokenControl.tools.push(tool);
      return;
    }
    if (tokenControl.tools && typeof tokenControl.tools === "object") {
      tokenControl.tools[toolName] = tool;
    }
  }
});

/** Expose macro / console hooks on `game.modules.get('infinity-dnd5e').api`. */
Hooks.once("ready", () => {
  const mod = game.modules?.get?.(MODULE_ID);
  if (!mod) return;
  mod.api = {
    /** Open (or focus) the GM-only Loot Forge window. */
    openLootForge: () => LootForgeApp.open(),

    /**
     * Roll a loot bundle without opening the UI. Returns the same
     * shape the in-window roll produces, with each entry decorated
     * with `uuid` + `rarity` for downstream distribute calls.
     *
     * @param {object} [opts]
     * @param {string} [opts.tier="t2"]
     * @param {string} [opts.scale="standard"]
     * @param {string} [opts.generosity="balanced"]
     * @param {number} [opts.partySize=4]
     * @param {number} [opts.count=6]
     * @param {string[]} [opts.rarities=["uncommon","rare"]]
     * @param {string[]} [opts.lootTypes=[]]      // empty = all
     * @param {number} [opts.budgetOverride=0]   // > 0 skips the curve
     * @param {string} [opts.packId]
     * @returns {Promise<object>} { items, totalGp, budgetGp, droppedForBudget, warnings }
     */
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
        count: opts.count ?? 6,
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

    /**
     * Send pre-resolved UUIDs to a specific actor. Skips the picker.
     * @param {string} actorId
     * @param {string[]} uuids
     */
    distributeBundle: (actorId, uuids) =>
      distributeItemsToActor(actorId, uuids),

    /** Open the actor picker for the supplied UUIDs. */
    promptDistribute: (uuids, options) =>
      promptDistributeItems(uuids, options),
  };
});
