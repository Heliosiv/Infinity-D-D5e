/**
 * Foundry init-phase registrars.
 *
 * Each registrar is independently idempotent so a defensive second bootstrap
 * cannot duplicate settings, keybindings, tools, or app configuration.
 */
export function createModuleRegistrars(bindings) {
  let settingsRegistered = false;
  let reagentRegistered = false;
  let toolsRegistered = false;
  let keybindingsRegistered = false;
  let downtimeAppsConfigured = false;

  function registerSettings() {
    if (settingsRegistered) return false;
    const game = bindings.getGame?.();
    if (!game?.settings?.register) return false;
    settingsRegistered = true;

    for (const entry of bindings.SETTINGS) {
      const opts = {
        name: entry.name,
        hint: entry.hint,
        scope: entry.scope,
        // The role-aware Infinity Settings menu has source-tested parity with
        // every catalog entry; keep the duplicate raw controls out of Foundry's
        // flat module list while preserving every existing key and value.
        config: false,
        type: entry.type,
        default: entry.default,
      };
      if (entry.choices) opts.choices = entry.choices;
      if (entry.range) opts.range = entry.range;
      if (entry.onChange) opts.onChange = entry.onChange;
      try {
        game.settings.register(bindings.moduleId, entry.key, opts);
      } catch (error) {
        bindings.logger.warn(
          `${bindings.moduleId} | failed to register setting "${entry.key}"`,
          error,
        );
      }
    }

    bindings.registerUiPreferencesSetting(game, {
      onChange: (preferences) => {
        for (const root of bindings
          .getDocument?.()
          ?.querySelectorAll?.(".application.infinity-dnd5e") ?? []) {
          bindings.applyUiDensity(root, preferences);
        }
        bindings
          .getHooks?.()
          ?.callAll?.("infinityDnd5eUiPreferencesChanged", preferences);
      },
    });

    if (typeof game.settings.registerMenu === "function") {
      try {
        game.settings.registerMenu(bindings.moduleId, "infinitySettings", {
          name: "Infinity Settings",
          label: "Open Infinity Settings",
          hint: "Role-aware settings, accessibility preferences, quick starts, and campaign defaults.",
          icon: "fa-solid fa-sliders",
          type: bindings.InfinitySettingsApp,
          restricted: false,
        });
      } catch (error) {
        bindings.logger.warn(
          `${bindings.moduleId} | failed to register settings workspace`,
          error,
        );
      }
    }
    return true;
  }

  function registerReagentItemType() {
    if (reagentRegistered) return false;
    const dnd5e = bindings.getConfig?.()?.DND5E;
    if (!dnd5e) return false;
    reagentRegistered = true;
    const entry = { label: "Reagent" };
    if (dnd5e.consumableTypes && !dnd5e.consumableTypes.reagent) {
      dnd5e.consumableTypes.reagent = entry;
    }
    if (dnd5e.lootTypes && !dnd5e.lootTypes.reagent) {
      dnd5e.lootTypes.reagent = { ...entry };
    }
    return true;
  }

  function registerBuiltinTools() {
    if (toolsRegistered) return false;
    toolsRegistered = true;

    bindings.registerTool({
      id: "loot-studio",
      title: "Loot Studio",
      description:
        "Generate encounter rewards, treasure hoards, or creature drops in one workspace.",
      icon: "fa-solid fa-coins",
      category: "loot",
      status: "available",
      open: () => bindings.LootStudioApp.open(),
    });
    bindings.registerTool({
      id: "merchant-workspace",
      title: "Merchant Workspace",
      description:
        "Curate merchants — inventory, markup, bargain DC, allowed players — then open shopping sessions yourself, or mark shops self-service so players browse them from their own Shops door (Shift+O).",
      icon: "fa-solid fa-store",
      category: "merchants",
      status: "available",
      open: () => bindings.MerchantWorkspaceApp.open(),
    });
    bindings.registerTool({
      id: "resource-manager",
      title: "Quartermaster",
      description:
        "Track food, water, and light. As days pass, players forage (Survival) and the party's supplies are spent automatically.",
      icon: "fa-solid fa-campground",
      category: "party",
      status: "available",
      open: () => bindings.ResourceManagerApp.open(),
    });
    bindings.registerTool({
      id: "downtime-workspace",
      title: "Downtime Workspace",
      description:
        "Give every eligible character an hour budget, collect queued city activities, preview hidden outcomes, and apply exact receipts.",
      icon: "fa-solid fa-hourglass-half",
      category: "party",
      status: "available",
      open: () => bindings.DowntimeWorkspaceApp.open(),
    });
    bindings.registerTool({
      id: "reputation",
      title: "Reputation & Factions",
      description:
        "Track how each faction leans toward the party. Raise or lower standings with a logged reason, and reveal factions to players (Shift+R).",
      icon: "fa-solid fa-handshake",
      category: "party",
      status: "available",
      open: () => bindings.ReputationWorkspaceApp.open(),
    });
    return true;
  }

  function registerKeybindings() {
    if (keybindingsRegistered) return false;
    const game = bindings.getGame?.();
    if (!game?.keybindings?.register) return false;
    keybindingsRegistered = true;

    try {
      const precedence = bindings.getConst?.()?.KEYBINDING_PRECEDENCE?.NORMAL;
      game.keybindings.register(bindings.moduleId, "openDashboard", {
        name: "Open Infinity D&D5e Home",
        hint: "Open the role-aware Infinity Home from anywhere in the game.",
        editable: [{ key: "KeyI", modifiers: ["Shift"] }],
        onDown: () => {
          bindings.openHub();
          return true;
        },
        restricted: false,
        precedence,
      });
      game.keybindings.register(bindings.moduleId, "openShops", {
        name: "Open Infinity D&D5e Shops",
        hint: "Open the merchant shops you have access to (players).",
        editable: [{ key: "KeyO", modifiers: ["Shift"] }],
        onDown: () => {
          if (bindings.isFullGM()) return false;
          bindings.ShopPickerApp.open();
          return true;
        },
        precedence,
      });
      game.keybindings.register(bindings.moduleId, "openReputation", {
        name: "Open Infinity D&D5e Reputation",
        hint: "See the party's standing with revealed factions.",
        editable: [{ key: "KeyR", modifiers: ["Shift"] }],
        onDown: () => {
          bindings.ReputationViewApp.open();
          return true;
        },
        precedence,
      });
      game.keybindings.register(bindings.moduleId, "openPartySupplies", {
        name: "Open Infinity D&D5e Party Supplies",
        hint: "See the party's food, water, light, and supply outlook.",
        editable: [{ key: "KeyQ", modifiers: ["Shift"] }],
        onDown: () => {
          bindings.ResourceOverviewApp.open();
          return true;
        },
        precedence,
      });
      game.keybindings.register(bindings.moduleId, "openCriticalInjuries", {
        name: "Open Infinity D&D5e Critical Injuries",
        hint: "Roll an approved injury and review your character's active injuries.",
        editable: [{ key: "KeyJ", modifiers: ["Shift"] }],
        onDown: () => {
          bindings.CriticalInjuryApp.openForCurrentUser();
          return true;
        },
        precedence,
      });
      game.keybindings.register(bindings.moduleId, "openDowntimeActivities", {
        name: "Open Infinity D&D5e Downtime Activities",
        hint: "Plan activities for your eligible character during an active downtime block.",
        editable: [{ key: "KeyD", modifiers: ["Shift"] }],
        onDown: () => {
          bindings.DowntimeActivitiesApp.open();
          return true;
        },
        precedence,
      });
    } catch (error) {
      bindings.logger.warn(
        `${bindings.moduleId} | failed to register keybindings`,
        error,
      );
    }
    return true;
  }

  function configureDowntimeApps() {
    if (downtimeAppsConfigured) return false;
    downtimeAppsConfigured = true;
    bindings.DowntimeWorkspaceApp.configure({
      adapterFactory: () => bindings.downtimeWorkspaceAdapter,
    });
    bindings.DowntimeActivitiesApp.configure({
      adapterFactory: () => bindings.getDowntimePlayerAdapter(),
    });
    return true;
  }

  return {
    registerSettings,
    registerReagentItemType,
    registerBuiltinTools,
    registerKeybindings,
    configureDowntimeApps,
  };
}
