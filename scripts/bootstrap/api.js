/**
 * Build the stable public module API from explicit runtime bindings.
 *
 * Keeping this factory free of Foundry imports makes the compatibility
 * contract executable in unit tests without evaluating every ApplicationV2
 * class in the module.
 */
export function createModuleApi(bindings) {
  const {
    packId,
    openHub,
    LootStudioApp,
    InfinitySettingsApp,
    MerchantWorkspaceApp,
    MerchantSessionApp,
    ShopPickerApp,
    ResourceManagerApp,
    ResourceOverviewApp,
    ForagePromptApp,
    CriticalInjuryApp,
    CriticalInjuryHudApp,
    ReputationWorkspaceApp,
    ReputationViewApp,
    DowntimeWorkspaceApp,
    DowntimeActivitiesApp,
    CRITICAL_INJURY_TABLE,
    CRITICAL_INJURY_TABLE_VERSION,
    SOUND_EVENTS,
    SOUND_REGISTRY,
    playSoundEvent,
    getPlayerSurfaceStatus,
    getPrivateStateStatus,
    openCalendar,
    getUiPreferences,
    updateUiPreferences,
    advanceDayNow,
    computeLootBudget,
    distributeItemsToActor,
    promptDistributeItems,
    loadCompendiumItems,
    filterCandidates,
    getEffectiveRarity,
    rollLoot,
    getLootBundleBalanceOptions,
    tierWindow,
    isFullGM,
    runAsFullGM,
  } = bindings;

  return {
    openHub: () => openHub(),
    openDashboard: () => runAsFullGM(() => openHub()),
    openLootStudio: (options = {}) =>
      runAsFullGM(() => LootStudioApp.open(options)),
    openPerEncounterLoot: () =>
      runAsFullGM(() => LootStudioApp.open({ mode: "encounter" })),
    openHoardLoot: () =>
      runAsFullGM(() => LootStudioApp.open({ mode: "hoard" })),
    openPerCreatureLoot: () =>
      runAsFullGM(() => LootStudioApp.open({ mode: "creature" })),
    openMerchantWorkspace: () => runAsFullGM(() => MerchantWorkspaceApp.open()),
    openShops: () => ShopPickerApp.open(),
    openResourceManager: () => runAsFullGM(() => ResourceManagerApp.open()),
    openPartySupplies: () => ResourceOverviewApp.open(),
    openCriticalInjuries: () => CriticalInjuryApp.openForCurrentUser(),
    openCriticalInjuryHud: () => CriticalInjuryHudApp.reconcile(),
    openReputation: () => runAsFullGM(() => ReputationWorkspaceApp.open()),
    openReputationView: () => ReputationViewApp.open(),
    openDowntimeWorkspace: () => runAsFullGM(() => DowntimeWorkspaceApp.open()),
    openDowntimeActivities: (options = {}) =>
      DowntimeActivitiesApp.open(options),
    openCalendar: () => openCalendar(),
    openSettings: () => InfinitySettingsApp.open(),
    getUiPreferences: () => getUiPreferences(),
    updateUiPreferences: (patch) => updateUiPreferences(patch),
    getPlayerSurfaceStatus,
    getPrivateStateStatus: () => getPrivateStateStatus(),
    advanceDay: () => runAsFullGM(() => advanceDayNow()),
    MerchantSessionApp,
    ForagePromptApp,
    CriticalInjuryApp,
    CriticalInjuryHudApp,
    criticalInjuries: {
      tableVersion: CRITICAL_INJURY_TABLE_VERSION,
      table: CRITICAL_INJURY_TABLE,
    },
    SOUND_EVENTS,
    SOUND_REGISTRY,
    playSoundEvent: (eventKey, options = {}) =>
      playSoundEvent(eventKey, {
        ...options,
        audience: isFullGM() ? options.audience : "local",
      }),

    rollLootBundle: async (opts = {}) => {
      if (!isFullGM()) throw new Error("PermissionDenied: GM-only loot API");
      const tier = opts.tier ?? "t2";
      const lootTypes = opts.lootTypes ?? [];
      const budget = computeLootBudget({
        tier,
        scale: opts.scale ?? "standard",
        generosity: opts.generosity ?? "balanced",
        partySize: opts.partySize ?? 4,
        override: opts.budgetOverride ?? 0,
      });
      const items = await loadCompendiumItems({
        packId: opts.packId ?? packId,
      });
      const candidates = filterCandidates(items, {
        tiers: tierWindow(tier),
        rarities: opts.rarities ?? [],
        lootTypes,
        requireEligible: true,
      });
      const balanceOptions = getLootBundleBalanceOptions({ tier, lootTypes });
      const raw = rollLoot(candidates, {
        count: opts.count ?? 0,
        budgetGp: budget,
        magicBias: opts.magicBias ?? 0,
        artVariants: opts.artVariants === true,
        ...balanceOptions,
        rarityWeights: opts.rarityWeights ?? balanceOptions.rarityWeights,
      });
      return {
        ...raw,
        items: raw.items.map((entry) => ({
          ...entry,
          uuid: entry.item?.uuid ?? null,
          rarity: getEffectiveRarity(entry.item),
        })),
      };
    },

    distributeBundle: (actorId, uuids) =>
      runAsFullGM(() => distributeItemsToActor(actorId, uuids)),

    promptDistribute: (uuids, options) =>
      runAsFullGM(() => promptDistributeItems(uuids, options)),
  };
}

/**
 * Install the public API on Foundry's module record.
 *
 * Evaluation deliberately replaces a stale object. Init and ready use the
 * fallback-only mode so macros holding the eager object keep the same identity.
 */
export function installModuleApi(bindings, { replace = false } = {}) {
  const game = bindings.getGame?.();
  const mod = game?.modules?.get?.(bindings.moduleId);
  if (!mod || (!replace && mod.api)) return false;
  mod.api = createModuleApi(bindings);
  return true;
}
