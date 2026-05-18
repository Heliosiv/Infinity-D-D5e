/**
 * Infinity D&D5e — Foundry entry point.
 *
 * Registers the GM-only Loot Forge window and the scene-control
 * button that opens it. Keeps top-level glue minimal so each
 * feature owns its own bootstrap inside scripts/<feature>/.
 */

import { LootForgeApp } from "./app.js";

const MODULE_ID = "infinity-dnd5e";

/** Client setting: serialized form state, restored on window open. */
const SETTING_FORM_STATE = "lootForgeFormState";

/** Foundry init — register settings + the scene control. */
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
});

/** Foundry ready — instances are now safe to construct. */
Hooks.once("ready", () => {
  console.log(
    `${MODULE_ID} | ready (game.system: ${game.system?.id}@${game.system?.version})`,
  );
});

/**
 * Add a GM-only scene-control button under the "tokens" toolbar.
 * Foundry V12 uses `getSceneControlButtons`; V13+ keeps the same hook
 * but the structure of the controls object differs slightly. The
 * normalization below tolerates both shapes.
 */
Hooks.on("getSceneControlButtons", (controls) => {
  if (!game.user?.isGM) return;

  const tools = {
    name: "infinity-dnd5e-loot-forge",
    title: "Infinity D&D5e — Loot Forge",
    icon: "fa-solid fa-coins",
    button: true,
    visible: true,
    onClick: () => LootForgeApp.open(),
    onChange: () => LootForgeApp.open(),
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

/** Expose a single opener on the module for macro / console use. */
Hooks.once("ready", () => {
  const mod = game.modules?.get?.(MODULE_ID);
  if (mod) {
    mod.api = {
      openLootForge: () => LootForgeApp.open(),
    };
  }
});
