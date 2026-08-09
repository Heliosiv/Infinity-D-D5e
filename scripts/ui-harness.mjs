import { readFileSync } from "node:fs";

import Handlebars from "handlebars";

import { formatValueRange, marketTierOptions } from "./loot/value-filter.js";
import { escapeHtml } from "./ui-util.js";

/** Market-filter context (mirrors BaseLootApp._marketContext) for the harness. */
function marketContext(minItemGp = 0, maxItemGp = 0) {
  return {
    minItemGp,
    maxItemGp,
    valueRangeLabel: formatValueRange(minItemGp, maxItemGp),
    marketTiers: marketTierOptions(minItemGp, maxItemGp),
  };
}

const CSS_FILES = [
  "styles/tokens.css",
  "styles/dashboard.css",
  "styles/loot-forge.css",
  "styles/hoard-loot.css",
  "styles/per-creature-loot.css",
  "styles/merchant-workspace.css",
  "styles/merchant-session.css",
  "styles/shop-picker.css",
  "styles/resource-manager.css",
  "styles/resource-overview.css",
  "styles/forage-prompt.css",
  "styles/critical-injury.css",
  "styles/critical-injury-hud.css",
  "styles/reputation-workspace.css",
  "styles/reputation-view.css",
  "styles/downtime.css",
];

const MODULE_VERSION = JSON.parse(readFileSync("package.json", "utf8")).version;

const COMMON_RARITIES = [
  ["common", "Common", 298],
  ["uncommon", "Uncommon", 266],
  ["rare", "Rare", 311],
  ["very-rare", "Very Rare", 209],
  ["legendary", "Legendary", 84],
  ["artifact", "Artifact", 12],
];

const COMMON_LOOT_TYPES = [
  ["loot.weapon.magic", "Magic Weapons", 9],
  ["loot.weapon.mundane", "Weapons", 18],
  ["loot.armor.magic", "Magic Armor", 83],
  ["loot.armor.mundane", "Armor & Shields", 16],
  ["loot.equipment.magic", "Magic Equipment", 171],
  ["loot.equipment", "Adventuring Gear", 17],
  ["loot.consumable", "Potions & Consumables", 64],
  ["loot.potion", "Potions", 22],
  ["loot.reagent", "Alchemical Supplies", 28],
  ["loot.scroll", "Scrolls", 44],
  ["loot.ammunition", "Ammunition", 18],
  ["loot.tool", "Tools", 39],
  ["loot.gem", "Gems", 34],
  ["loot.art", "Art Objects", 42],
  ["loot.trade-good", "Trade Goods", 20],
  ["loot.container", "Containers", 8],
];

export function buildHarnessViews() {
  return [
    view(
      "dashboard",
      "Dashboard",
      "infinity-dashboard",
      "templates/dashboard.hbs",
      dashboardContext(),
      {
        width: 720,
        height: 540,
      },
    ),
    view(
      "per-encounter",
      "Per-Encounter Loot",
      "loot-forge",
      "templates/loot-forge.hbs",
      perEncounterContext(),
      { width: 860, height: 760 },
    ),
    view(
      "hoard",
      "Hoard Loot",
      "hoard-loot",
      "templates/hoard-loot.hbs",
      hoardContext(),
      {
        width: 820,
        height: 720,
      },
    ),
    view(
      "per-creature",
      "Per-Creature Loot",
      "per-creature-loot",
      "templates/per-creature-loot.hbs",
      perCreatureContext(),
      { width: 820, height: 760 },
    ),
    view(
      "merchant-workspace",
      "Merchant Workspace",
      "infinity-merchant-workspace",
      "templates/merchant-workspace.hbs",
      merchantWorkspaceContext(),
      { width: 1000, height: 720 },
    ),
    view(
      "merchant-session-buy",
      "Merchant Session — Buy",
      "infinity-merchant-session",
      "templates/merchant-session.hbs",
      merchantSessionContext("buy"),
      { width: 720, height: 600 },
    ),
    view(
      "merchant-session-sell",
      "Merchant Session — Sell",
      "infinity-merchant-session",
      "templates/merchant-session.hbs",
      merchantSessionContext("sell"),
      { width: 720, height: 600 },
    ),
    view(
      "shop-picker",
      "Shops (player)",
      "infinity-shop-picker",
      "templates/shop-picker.hbs",
      shopPickerContext(),
      { width: 440, height: 560 },
    ),
    view(
      "shop-picker-empty",
      "Shops (empty)",
      "infinity-shop-picker",
      "templates/shop-picker.hbs",
      shopPickerEmptyContext(),
      { width: 440, height: 560 },
    ),
    view(
      "resource-manager",
      "Quartermaster",
      "infinity-resource-manager",
      "templates/resource-manager.hbs",
      resourceManagerContext(),
      { width: 880, height: 700 },
    ),
    view(
      "resource-manager-locked",
      "Quartermaster (interrupted run)",
      "infinity-resource-manager",
      "templates/resource-manager.hbs",
      resourceManagerLockedContext(),
      { width: 880, height: 700 },
    ),
    view(
      "resource-manager-custom-environment",
      "Quartermaster (custom region)",
      "infinity-resource-manager",
      "templates/resource-manager.hbs",
      resourceManagerCustomEnvironmentContext(),
      { width: 880, height: 700 },
    ),
    view(
      "resource-overview",
      "Party Supplies (player)",
      "infinity-resource-overview",
      "templates/resource-overview.hbs",
      resourceOverviewContext(),
      { width: 540, height: 620 },
    ),
    view(
      "resource-overview-offline",
      "Party Supplies (GM offline)",
      "infinity-resource-overview",
      "templates/resource-overview.hbs",
      resourceOverviewOfflineContext(),
      { width: 540, height: 420 },
    ),
    view(
      "downtime-workspace-empty",
      "Downtime Workspace (empty)",
      "infinity-downtime-workspace",
      "templates/downtime-workspace.hbs",
      downtimeWorkspaceEmptyContext(),
      { width: 1040, height: 760 },
    ),
    view(
      "downtime-workspace-collecting",
      "Downtime Workspace (collecting)",
      "infinity-downtime-workspace",
      "templates/downtime-workspace.hbs",
      downtimeWorkspaceCollectingContext(),
      { width: 1040, height: 760 },
    ),
    view(
      "downtime-workspace-locked",
      "Downtime Workspace (locked)",
      "infinity-downtime-workspace",
      "templates/downtime-workspace.hbs",
      downtimeWorkspaceLockedContext(),
      { width: 1040, height: 760 },
    ),
    view(
      "downtime-workspace-preview",
      "Downtime Workspace (immutable preview)",
      "infinity-downtime-workspace",
      "templates/downtime-workspace.hbs",
      downtimeWorkspacePreviewContext(),
      { width: 1040, height: 760 },
    ),
    view(
      "downtime-workspace-recovery",
      "Downtime Workspace (recovery)",
      "infinity-downtime-workspace",
      "templates/downtime-workspace.hbs",
      downtimeWorkspaceRecoveryContext(),
      { width: 1040, height: 760 },
    ),
    view(
      "downtime-workspace-applying",
      "Downtime Workspace (applying)",
      "infinity-downtime-workspace",
      "templates/downtime-workspace.hbs",
      downtimeWorkspaceApplyingContext(),
      { width: 1040, height: 760 },
    ),
    view(
      "downtime-workspace-history-completed",
      "Downtime Workspace (completed history)",
      "infinity-downtime-workspace",
      "templates/downtime-workspace.hbs",
      downtimeWorkspaceCompletedHistoryContext(),
      { width: 1040, height: 760 },
    ),
    view(
      "downtime-activities-available",
      "Downtime Activities (available)",
      "infinity-downtime-activities",
      "templates/downtime-activities.hbs",
      downtimeActivitiesAvailableContext(),
      { width: 780, height: 720 },
    ),
    view(
      "downtime-activities-pending",
      "Downtime Activities (pending)",
      "infinity-downtime-activities",
      "templates/downtime-activities.hbs",
      downtimeActivitiesPendingContext(),
      { width: 780, height: 650 },
    ),
    view(
      "downtime-activities-locked",
      "Downtime Activities (locked)",
      "infinity-downtime-activities",
      "templates/downtime-activities.hbs",
      downtimeActivitiesLockedContext(),
      { width: 780, height: 650 },
    ),
    view(
      "downtime-activities-applying",
      "Downtime Activities (applying)",
      "infinity-downtime-activities",
      "templates/downtime-activities.hbs",
      downtimeActivitiesApplyingContext(),
      { width: 780, height: 650 },
    ),
    view(
      "downtime-activities-resolved",
      "Downtime Activities (resolved)",
      "infinity-downtime-activities",
      "templates/downtime-activities.hbs",
      downtimeActivitiesResolvedContext(),
      { width: 780, height: 680 },
    ),
    view(
      "downtime-activities-no-gm",
      "Downtime Activities (GM offline)",
      "infinity-downtime-activities",
      "templates/downtime-activities.hbs",
      downtimeActivitiesNoGmContext(),
      { width: 620, height: 500 },
    ),
    view(
      "forage-prompt",
      "Forage Prompt (player)",
      "infinity-forage-prompt",
      "templates/forage-prompt.hbs",
      foragePromptContext(),
      { width: 460, height: 400 },
    ),
    view(
      "critical-injury",
      "Critical Injuries (player)",
      "infinity-critical-injury",
      "templates/critical-injury.hbs",
      criticalInjuryContext(),
      { width: 520, height: 700 },
    ),
    view(
      "critical-injury-hud",
      "Critical Injury Body HUD (player overlay)",
      "infinity-critical-injury-hud",
      "templates/critical-injury-hud.hbs",
      criticalInjuryHudContext(),
      { width: 700, height: 620, overlay: true },
    ),
    view(
      "reputation-workspace",
      "Reputation Workspace",
      "infinity-reputation-workspace",
      "templates/reputation-workspace.hbs",
      reputationWorkspaceContext(),
      { width: 940, height: 720 },
    ),
    view(
      "reputation-view",
      "Reputation (player)",
      "infinity-reputation-view",
      "templates/reputation-view.hbs",
      reputationViewContext(),
      { width: 420, height: 560 },
    ),
    view(
      "reputation-view-empty",
      "Reputation (empty)",
      "infinity-reputation-view",
      "templates/reputation-view.hbs",
      reputationViewEmptyContext(),
      { width: 420, height: 560 },
    ),
  ];
}

export function renderHarnessViews() {
  return buildHarnessViews().map((entry) => ({
    ...entry,
    html: renderTemplate(entry.template, entry.context),
  }));
}

export function buildUiHarnessDocument() {
  const css = CSS_FILES.map((file) => readFileSync(file, "utf8")).join("\n\n");
  const windows = renderHarnessViews()
    .map((entry) => renderHarnessWindow(entry))
    .join("\n");
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Infinity D&amp;D5e UI Harness</title>
  <style>
    ${css}

    :root {
      color-scheme: dark;
      font-family: "Inter", "Segoe UI", system-ui, sans-serif;
      background: #95a9ab;
    }

    body {
      margin: 0;
      min-height: 100vh;
      background:
        linear-gradient(90deg, rgba(255,255,255,0.12) 1px, transparent 1px),
        linear-gradient(rgba(255,255,255,0.12) 1px, transparent 1px),
        #95a9ab;
      background-size: 32px 32px;
      color: #e7ecf6;
    }

    .ui-harness {
      display: grid;
      gap: 22px;
      padding: 18px;
      box-sizing: border-box;
    }

    .ui-harness__label {
      margin: 0 0 6px;
      font-size: 12px;
      font-weight: 700;
      letter-spacing: 0.08em;
      text-transform: uppercase;
      color: #172033;
    }

    .ui-harness__window {
      display: grid;
      grid-template-rows: 34px minmax(0, 1fr);
      width: min(var(--harness-width), calc(100vw - 36px));
      height: min(var(--harness-height), calc(100vh - 76px));
      max-width: calc(100vw - 36px);
      min-width: 0;
      min-height: 360px;
      overflow: hidden;
      border: 1px solid rgba(7, 13, 25, 0.9);
      border-radius: 8px;
      box-shadow: 0 18px 36px rgba(7, 13, 25, 0.38);
    }

    .window-header {
      display: flex;
      align-items: center;
      gap: 8px;
      padding: 0 10px;
      background: #0d111a;
      color: #f6f7fb;
      box-sizing: border-box;
    }

    .window-title {
      margin: 0;
      min-width: 0;
      flex: 1 1 auto;
      font-size: 13px;
      font-weight: 700;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }

    .window-close {
      width: 22px;
      height: 22px;
      border: 0;
      background: transparent;
      color: inherit;
      font-size: 20px;
      line-height: 1;
    }

    .window-content {
      min-height: 0;
      box-sizing: border-box;
    }

    .ui-harness__overlay-stage {
      position: relative;
      width: min(var(--harness-width), calc(100vw - 36px));
      height: min(var(--harness-height), calc(100vh - 76px));
      min-height: 560px;
      overflow: hidden;
      border: 1px dashed rgba(23, 32, 51, 0.5);
      border-radius: 8px;
      background: rgba(23, 32, 51, 0.08);
    }

    .ui-harness__overlay-stage .infinity-critical-injury-hud {
      position: absolute !important;
      right: 16px !important;
      bottom: 16px !important;
    }

    .ui-harness__overlay-stage .ci-hud-card {
      position: absolute;
      right: 54px;
      bottom: -33px;
    }

    @media (max-width: 520px) {
      .ui-harness__overlay-stage .infinity-critical-injury-hud {
        right: 8px !important;
        bottom: 16px !important;
      }

      .ui-harness__overlay-stage .ci-hud-card {
        right: 40px;
        bottom: 88px;
        left: auto;
        width: min(260px, calc(100vw - 40px));
      }
    }
  </style>
</head>
<body>
  <main class="ui-harness">
    ${windows}
  </main>
  <script>
    window.__uiClicks = [];
    document.addEventListener("click", (event) => {
      const button = event.target.closest("button[data-action]");
      if (!button) return;
      event.preventDefault();
      window.__uiClicks.push({
        action: button.dataset.action,
        window: button.closest("[data-harness-window]")?.dataset.harnessWindow ?? "",
        label: button.textContent.trim().replace(/\\s+/g, " "),
      });
    });

    // Mirror the production double-click-to-open contract so the audit can
    // verify it: ignore interactive children, require a [data-uuid] row.
    window.__uiDblclicks = [];
    document.addEventListener("dblclick", (event) => {
      if (event.target.closest("input,select,textarea,button,a,[contenteditable],[data-action]")) return;
      const row = event.target.closest("[data-uuid]");
      if (!row) return;
      window.__uiDblclicks.push({
        uuid: row.dataset.uuid,
        window: row.closest("[data-harness-window]")?.dataset.harnessWindow ?? "",
      });
    });
  </script>
</body>
</html>`;
}

function view(id, label, rootClass, template, context, size) {
  return { id, label, rootClass, template, context, ...size };
}

function renderHarnessWindow(entry) {
  if (entry.overlay) {
    return `<section data-harness-section="${escapeHtml(entry.id)}">
      <h2 class="ui-harness__label">${escapeHtml(entry.label)}</h2>
      <section
        class="ui-harness__overlay-stage"
        style="--harness-width: ${entry.width}px; --harness-height: ${entry.height}px;"
      >
        <aside
          class="application infinity-dnd5e ${escapeHtml(entry.rootClass)}"
          data-harness-window="${escapeHtml(entry.id)}"
        >
          <section class="window-content">
            ${entry.html}
          </section>
        </aside>
      </section>
    </section>`;
  }
  return `<section data-harness-section="${escapeHtml(entry.id)}">
    <h2 class="ui-harness__label">${escapeHtml(entry.label)}</h2>
    <section
      class="window-app application infinity-dnd5e ${escapeHtml(entry.rootClass)} ui-harness__window"
      data-harness-window="${escapeHtml(entry.id)}"
      style="--harness-width: ${entry.width}px; --harness-height: ${entry.height}px;"
    >
      <header class="window-header">
        <h3 class="window-title">Infinity D&amp;D5e - ${escapeHtml(entry.label)}</h3>
        <button type="button" class="window-close" aria-label="Close">&times;</button>
      </header>
      <section class="window-content">
        ${entry.html}
      </section>
    </section>
  </section>`;
}

function renderTemplate(templatePath, context) {
  const source = readFileSync(templatePath, "utf8");
  const template = Handlebars.compile(source, {
    strict: true,
    preventIndent: true,
  });
  return template(context);
}

function dashboardContext() {
  const tools = [
    {
      id: "per-encounter-loot",
      title: "Per-Encounter Loot",
      description:
        "Roll one fight's treasure with budgeted rarity and type filters.",
      icon: "fa-solid fa-coins",
      category: "loot",
      status: "available",
    },
    {
      id: "merchant-workspace",
      title: "Merchant Workspace",
      description: "Build shops, inventory, pricing, and player sessions.",
      icon: "fa-solid fa-store",
      category: "merchants",
      status: "available",
    },
    {
      id: "resource-manager",
      title: "Quartermaster",
      description: "Track travel supplies, foraging, and daily upkeep.",
      icon: "fa-solid fa-campground",
      category: "party",
      status: "available",
    },
    {
      id: "reputation-workspace",
      title: "Faction Reputation",
      description: "Track party standing and player-facing faction notes.",
      icon: "fa-solid fa-handshake",
      category: "party",
      status: "available",
    },
    {
      id: "downtime-workspace",
      title: "Downtime Workspace",
      description:
        "Assign productive hours, collect activity queues, and apply one immutable plan.",
      icon: "fa-solid fa-hourglass-half",
      category: "party",
      status: "available",
    },
    {
      id: "hoard-loot",
      title: "Hoard Loot",
      description: "Build a treasure cache with coin and item budget controls.",
      icon: "fa-solid fa-sack-dollar",
      category: "loot",
      status: "available",
    },
    {
      id: "per-creature-loot",
      title: "Per-Creature Loot",
      description: "Roll small drops for a roster of defeated creatures.",
      icon: "fa-solid fa-skull",
      category: "loot",
      status: "available",
    },
  ];
  const decorated = tools.map((tool) => ({
    ...tool,
    isAvailable: true,
    isComingSoon: false,
    statusLabel: "",
  }));
  return {
    moduleVersion: MODULE_VERSION,
    hasTools: true,
    recentTools: decorated.slice(0, 2),
    hasRecentTools: true,
    categories: [
      {
        category: "loot",
        label: "Loot",
        tools: decorated.filter((tool) => tool.category === "loot"),
      },
      {
        category: "merchants",
        label: "Merchants",
        tools: decorated.filter((tool) => tool.category === "merchants"),
      },
      {
        category: "party",
        label: "Party",
        tools: decorated.filter((tool) => tool.category === "party"),
      },
    ],
  };
}

function menuContext() {
  return {
    presets: [
      { id: "preset-1", name: "Boss Vault" },
      { id: "preset-2", name: "Humanoid Mooks" },
    ],
    hasPresets: true,
    history: [
      { id: "hist-1", label: "8 items · 450 gp" },
      { id: "hist-2", label: "5 items · 1,200 gp" },
    ],
    hasHistory: true,
    canUndo: true,
  };
}

function perEncounterContext() {
  return {
    ...menuContext(),
    ...marketContext(0, 5000),
    moduleId: "infinity-dnd5e",
    form: {
      itemLimitEnabled: true,
      artVariants: true,
      budgetOverride: 0,
    },
    projectedBudgetLabel: "450 gp",
    rollChances: encounterChanceContext(),
    candidateLabel: "644 items match current filters",
    noCandidates: false,
    candidateUnavailableReason: "",
    generateDisabled: false,
    generateDisabledReason: "",
    quickPresets: [
      ["easy", "Easy", "fa-solid fa-feather"],
      ["standard", "Standard", "fa-solid fa-shield"],
      ["hard", "Hard", "fa-solid fa-fire"],
      ["hoard", "Hoard", "fa-solid fa-suitcase-medical"],
    ].map(([key, label, icon]) => ({
      key,
      label,
      icon,
      active: key === "standard",
    })),
    tierOptions: tierOptions("t2"),
    scale: slider("scaleMultiplier", "Encounter Scale", 1, "x1.00", [
      ["trivial", "Trivial", 0.5],
      ["standard", "Standard", 1],
      ["hard", "Hard", 1.5],
      ["deadly", "Deadly", 2],
      ["hoard", "Hoard", 4],
    ]),
    generosity: slider("generosityMultiplier", "Generosity", 1, "x1.00", [
      ["stingy", "Stingy", 0.75],
      ["balanced", "Balanced", 1],
      ["generous", "Generous", 1.35],
    ]),
    partySize: {
      ...slider("partySize", "Party Size", 3, "3 PCs", null, {
        min: 1,
        max: 8,
        step: 1,
      }),
      extra: {
        action: "useParty",
        label: "Use Party",
        title: "Set to 3 (live player count)",
        icon: "fa-solid fa-users",
      },
    },
    itemLimit: slider("count", "Item Count", 6, "6 items", null, {
      min: 1,
      max: 20,
      step: 1,
    }),
    itemLimitLabel: "6 items",
    magicBias: slider("magicBias", "Magic vs. Mundane", 0, "Neutral", [
      ["neutral", "Neutral", 0],
      ["lean-magic", "More Magic", 0.5],
      ["heavy-magic", "Arcane", 1],
    ]),
    rarityOptions: rarityOptions(["common", "uncommon", "rare"]),
    lootTypeOptions: lootTypeOptions([
      "loot.weapon.magic",
      "loot.armor.magic",
      "loot.consumable",
      "loot.tool",
    ]),
    loadingItems: false,
    hasResult: true,
    result: {
      items: resultItems(),
      totalGpLabel: "260 gp",
      budgetGp: 450,
      budgetGpLabel: "450 gp",
      droppedForBudget: 0,
      warnings: [],
      lockedCount: 1,
    },
  };
}

function hoardContext() {
  return {
    ...menuContext(),
    ...marketContext(0, 1000),
    form: { artVariants: true },
    totalBudgetLabel: "2,400 gp",
    coinPileLabel: "900 gp",
    itemBudgetLabel: "1,500 gp",
    candidateLabel: "711 items match current filters",
    noCandidates: false,
    candidateUnavailableReason: "",
    generateDisabled: false,
    generateDisabledReason: "",
    tierOptions: tierOptions("t3"),
    scaleOptions: [
      ["cache", "Cache", "0.5", false],
      ["standard", "Standard", "1.0", true],
      ["vault", "Vault", "2.0", false],
      ["dragon", "Dragon", "4.0", false],
    ].map(([value, label, multiplier, selected]) => ({
      value,
      label,
      multiplier,
      selected,
      flavor: `${label} sized treasure haul`,
    })),
    pileBias: slider("pileBias", "Coin vs. Items", 0.45, "Balanced", [
      ["coin", "Coin", 0.15],
      ["balanced", "Balanced", 0.45],
      ["items", "Items", 0.8],
    ]),
    magicBias: slider(
      "magicBias",
      "Magic vs. Mundane",
      0.25,
      "Slightly Magical",
      [
        ["mundane", "Mundane", -0.5],
        ["neutral", "Neutral", 0],
        ["magic", "Magical", 0.5],
      ],
    ),
    rarityOptions: rarityOptions(["common", "uncommon", "rare", "very-rare"]),
    rarityBalanceOptions: rarityBalanceOptions("hoard"),
    rarityWeightRows: rarityWeightRows({
      common: 0.8,
      uncommon: 1.1,
      rare: 1.4,
      "very-rare": 0.9,
      legendary: 0.35,
      artifact: 0.1,
    }),
    lootTypeOptions: lootTypeOptions([
      "loot.gem",
      "loot.art",
      "loot.equipment.magic",
      "loot.consumable",
    ]),
    maxItemsMin: 0,
    maxItemsMax: 20,
    maxItems: 8,
    loadingItems: false,
    hasResult: true,
    hasCoinPile: true,
    result: {
      totalGpLabel: "2,345 gp",
      coinPileLabel: "900 gp in mixed coin",
      coinBreakdownLabel: "400 gp, 3,000 sp, 20,000 cp",
      items: resultItems().slice(0, 5),
      warnings: [],
    },
  };
}

function perCreatureContext() {
  const rows = [
    { id: "wolf-1", name: "Veteran Bandit", tier: "t1", budgetLabel: "18 gp" },
    { id: "mage-1", name: "Cult Adept", tier: "t2", budgetLabel: "75 gp" },
    { id: "boss-1", name: "Ogre Boss", tier: "t3", budgetLabel: "210 gp" },
  ];
  return {
    ...menuContext(),
    ...marketContext(),
    rosterRows: rows.map((row) => ({
      ...row,
      tierOptions: tierOptions(row.tier),
    })),
    rosterFull: false,
    rosterTotalBudgetLabel: "303 gp",
    candidateLabel: "644 items match current filters",
    noCandidates: false,
    candidateUnavailableReason: "",
    generateDisabled: false,
    generateDisabledReason: "",
    itemsPerCreature: slider(
      "itemsPerCreature",
      "Items Per Creature",
      2,
      "2 each",
      [
        ["one", "1", 1],
        ["two", "2", 2],
        ["three", "3", 3],
      ],
    ),
    magicBias: slider("magicBias", "Magic vs. Mundane", 0, "Neutral", [
      ["mundane", "Mundane", -0.5],
      ["neutral", "Neutral", 0],
      ["magic", "Magical", 0.5],
    ]),
    rarityOptions: rarityOptions(["common", "uncommon"]),
    lootTypeOptions: lootTypeOptions([
      "loot.weapon.mundane",
      "loot.equipment",
      "loot.tool",
      "loot.trade-good",
    ]),
    loadingItems: false,
    hasResult: true,
    result: {
      grandTotalLabel: "284 gp",
      creatures: rows.map((row, index) => ({
        id: row.id,
        name: row.name,
        tierLabel: row.tier.toUpperCase(),
        totalGpLabel: `${[35, 84, 165][index]} gp`,
        items: resultItems().slice(index, index + 2),
      })),
    },
  };
}

function merchantWorkspaceContext() {
  const selected = {
    id: "m-curios",
    name: "Yannick's Curios",
    art: "icons/svg/shop.svg",
    description: "A cramped stall of oddments and salvaged gear.",
    defaultMarkup: 1.2,
    sellRatio: 0.5,
    bargainDC: 15,
    bargainAdvantage: false,
    goldOnHand: 320,
    bargainSuccessPct: 10,
    bargainFailPct: 10,
    passiveHaggle: true,
    passivePctPerPoint: 2,
    passiveCapPct: 20,
    items: [{}, {}, {}],
    itemCountIsOne: false,
  };
  return {
    moduleId: "infinity-dnd5e",
    hasMerchants: true,
    merchants: [
      {
        id: "m-curios",
        name: "Yannick's Curios",
        art: "icons/svg/shop.svg",
        itemCount: 3,
        itemCountIsOne: false,
        allowedCount: 2,
        allowedCountIsOne: false,
        selected: true,
      },
      {
        id: "m-smith",
        name: "The Iron Rest",
        art: "icons/svg/anvil.svg",
        itemCount: 1,
        itemCountIsOne: true,
        allowedCount: 1,
        allowedCountIsOne: true,
        selected: false,
      },
    ],
    selected,
    hasPlayers: true,
    playerOptions: [
      { id: "u-alice", name: "Alice", checked: true },
      { id: "u-bob", name: "Bob", checked: false },
    ],
    skillOptions: [
      { id: "per", label: "Persuasion", checked: true },
      { id: "dec", label: "Deception", checked: true },
      { id: "itm", label: "Intimidation", checked: false },
    ],
    selfServiceOptions: [
      { value: "off", label: "Off — only the GM opens it", selected: false },
      {
        value: "open",
        label: "Open — allowed players walk in",
        selected: true,
      },
      {
        value: "knock",
        label: "Knock — players ask, you approve",
        selected: false,
      },
    ],
    poolLootTypeOptions: [
      { value: "loot.weapon.magic", label: "Magic Weapons", checked: true },
      {
        value: "loot.consumable",
        label: "Potions & Consumables",
        checked: false,
      },
      { value: "loot.gem", label: "Gems", checked: true },
    ],
    poolRarityOptions: [
      { value: "common", label: "Common", checked: true },
      { value: "uncommon", label: "Uncommon", checked: false },
      { value: "rare", label: "Rare", checked: false },
    ],
    poolRarityBalanceOptions: rarityBalanceOptions("shop"),
    poolRarityWeightRows: rarityWeightRows({
      common: 3,
      uncommon: 1.75,
      rare: 0.75,
      "very-rare": 0.35,
      legendary: 0.12,
      artifact: 0.05,
    }),
    poolCount: 6,
    poolBudgetGp: "",
    poolMinGp: 0,
    poolMaxGp: 500,
    poolValueRangeLabel: formatValueRange(0, 500),
    poolMarketTiers: marketTierOptions(0, 500),
    buyFilterLootTypeOptions: [
      { value: "loot.weapon.magic", label: "Magic Weapons", checked: true },
      { value: "loot.weapon.mundane", label: "Weapons", checked: true },
      { value: "loot.gem", label: "Gems", checked: false },
    ],
    buyFilterRarityOptions: [
      { value: "common", label: "Common", checked: true },
      { value: "uncommon", label: "Uncommon", checked: true },
      { value: "rare", label: "Rare", checked: false },
    ],
    buysAnything: false,
    inventoryRows: [
      {
        uuid: "Compendium.infinity-dnd5e-items.Item.potion",
        name: "Potion of Healing",
        img: iconDataUri("#7a2f2f", "PO"),
        rarity: "uncommon",
        rarityLabel: "Uncommon",
        basePriceLabel: "60.00 gp",
        qtyDisplay: 5,
        startingQty: 5,
        priceOverrideDisplay: "",
        unlimited: false,
        missing: false,
        outOfStock: false,
      },
      {
        uuid: "Compendium.infinity-dnd5e-items.Item.rope",
        name: "Silk Rope",
        img: iconDataUri("#6b5a2f", "RO"),
        rarity: "common",
        rarityLabel: "Common",
        basePriceLabel: "12.00 gp",
        qtyDisplay: "∞",
        startingQty: 1,
        priceOverrideDisplay: 10,
        unlimited: true,
        missing: false,
        outOfStock: false,
      },
      {
        uuid: "Compendium.infinity-dnd5e-items.Item.gone",
        name: "(unknown item)",
        img: "icons/svg/item-bag.svg",
        rarity: "",
        rarityLabel: "",
        basePriceLabel: "—",
        qtyDisplay: 0,
        startingQty: 2,
        priceOverrideDisplay: "",
        unlimited: false,
        missing: true,
        outOfStock: true,
      },
    ],
    activeSessions: [{ sessionId: "s-1", userLabel: "Alice" }],
    canOpenSession: true,
    saveStatus: "Saved",
  };
}

function merchantSessionContext(activeTab = "buy") {
  return {
    domId: `harness-${activeTab}`,
    merchant: {
      id: "m-curios",
      name: "Yannick's Curios",
      art: "icons/svg/shop.svg",
      description: "A cramped stall of oddments and salvaged gear.",
    },
    walletLabel: "42 gp · 5 sp",
    merchantGoldLabel: "320 gp",
    passiveHaggleLabel: "Your haggling: better prices (-10%)",
    previewMode: true,
    previewNoActor: false,
    noActor: false,
    buyActive: activeTab === "buy",
    sellActive: activeTab === "sell",
    buyRows: [
      {
        uuid: "Compendium.infinity-dnd5e-items.Item.potion",
        name: "Potion of Healing",
        img: iconDataUri("#7a2f2f", "PO"),
        rarity: "rare",
        rarityLabel: "Rare",
        stockLabel: "Stock: 5",
        baseLabel: "60.00 gp",
        finalLabel: "48.00 gp",
        priceDeltaLabel: "-20%",
        deltaClass: "down",
        // Harness shows the sealed-price markup but keeps the bargain
        // button enabled so the layout audit can exercise every control.
        bargainLocked: false,
        bargainPending: false,
        sealLabel: "Great deal -20%",
        haggleLabel: "Charm discount",
        cannotBuy: false,
        cannotBuyReason: "",
        maxQty: 5,
        outOfStock: false,
        missing: false,
      },
      {
        uuid: "Compendium.infinity-dnd5e-items.Item.rope",
        name: "Silk Rope",
        img: iconDataUri("#6b5a2f", "RO"),
        rarity: "common",
        rarityLabel: "Common",
        stockLabel: "Unlimited stock",
        baseLabel: "12.00 gp",
        finalLabel: "10.80 gp",
        // Passive haggle (no seal): the always-on nudge from social skill.
        priceDeltaLabel: "-10%",
        deltaClass: "down",
        passiveActive: true,
        bargainLocked: false,
        bargainPending: false,
        sealLabel: "",
        haggleLabel: "Charm discount",
        cannotBuy: false,
        cannotBuyReason: "",
        maxQty: 99,
        outOfStock: false,
        missing: false,
      },
    ],
    sellRows: [
      {
        itemId: "Item.longsword",
        uuid: "Actor.harness.Item.longsword",
        name: "Longsword",
        img: iconDataUri("#54616b", "LO"),
        rarity: "common",
        rarityLabel: "Common",
        ownedQty: 1,
        maxSellQty: 1,
        cannotSell: false,
        goldLimited: false,
        affordLabel: "",
        baseLabel: "7.50 gp",
        finalLabel: "9.00 gp",
        priceDeltaLabel: "+20%",
        deltaClass: "down",
        bargainLocked: false,
        bargainPending: false,
        sealLabel: "Great deal +20%",
        haggleLabel: "Charm bonus",
      },
      {
        itemId: "Item.stolen-ring",
        uuid: "Actor.harness.Item.stolen-ring",
        name: "Stolen Signet Ring",
        img: iconDataUri("#5f4a72", "SR"),
        rarity: "common",
        rarityLabel: "Common",
        ownedQty: 1,
        maxSellQty: 1,
        cannotSell: true,
        cannotSellReason: "Stolen goods require fencing during downtime.",
        stolen: true,
        goldLimited: false,
        affordLabel: "",
        baseLabel: "5.00 gp",
        finalLabel: "2.50 gp",
        priceDeltaLabel: "",
        deltaClass: "",
        bargainLocked: true,
        bargainPending: false,
        sealLabel: "",
        haggleLabel: "",
      },
    ],
    log: [
      { kind: "buy", text: "Bought 1× Potion of Healing for 48.00 gp" },
      { kind: "bargain", text: "Bargain: Great deal · -20%" },
    ],
    sessionSpentLabel: "48.00 gp",
    sessionEarnedLabel: "9.00 gp",
  };
}

function shopPickerContext() {
  return {
    noGm: false,
    loading: false,
    hasShops: true,
    shops: [
      {
        id: "m-brundle",
        name: "Brundle's Wares",
        art: iconDataUri("#5a7a3f", "BW"),
        description: "Dusty oddments and salvaged gear.",
        knock: false,
        pending: false,
      },
      {
        id: "m-iron",
        name: "The Iron Rest",
        art: iconDataUri("#6b7480", "IR"),
        description: "Arms & armor, fairly priced.",
        knock: true,
        pending: true,
      },
      {
        id: "m-arc",
        name: "Arcanum Sundries",
        art: iconDataUri("#7a4f8c", "AS"),
        description: "",
        knock: false,
        pending: false,
      },
    ],
  };
}

function shopPickerEmptyContext() {
  return { noGm: false, loading: false, hasShops: false, shops: [] };
}

function resourceManagerContext() {
  const resources = [
    {
      id: "food",
      label: "Food (Rations)",
      perDay: 1,
      scopeIsParty: false,
      keywords:
        "rations, trail ration, iron ration, emergency ration, field ration, food ration",
      flagTag: "food",
      tags: [],
    },
    {
      id: "water",
      label: "Water",
      perDay: 1,
      scopeIsParty: false,
      keywords: "water ration, water (1 day)",
      flagTag: "water",
      tags: [],
    },
    {
      id: "light",
      label: "Light (Torches)",
      perDay: 2,
      scopeIsParty: true,
      keywords: "torch, torches",
      flagTag: "light",
      tags: [
        {
          uuid: "Compendium.dnd5e.items.Item.torch0000000001",
          name: "Torch",
          missing: false,
        },
      ],
    },
  ];
  const counts = (food, water, light) => [
    {
      id: "food",
      label: "Food (Rations)",
      total: food,
      detail: "Rations ×" + food,
      shared: false,
    },
    {
      id: "water",
      label: "Water",
      total: water,
      detail: "Water Rations ×" + water,
      shared: false,
    },
    {
      id: "light",
      label: "Light (Torches)",
      total: light,
      detail: "Torch ×" + light,
      shared: false,
    },
  ];
  return {
    isAuthoritative: true,
    canRunResourceWrites: true,
    hasResourceConflictWarnings: false,
    hasBlockingResourceConflicts: false,
    resourceConflictWarnings: [],
    environments: [
      { id: "abundant", optionLabel: "Abundant", selected: false },
      { id: "limited", optionLabel: "Limited", selected: true },
      { id: "sparse", optionLabel: "Sparse", selected: false },
      { id: "settlement", optionLabel: "Settlement", selected: false },
      { id: "underground", optionLabel: "Underground", selected: false },
    ],
    currentEnvironment: {
      id: "limited",
      label: "Limited (hills, farmland, woods)",
      dc: 15,
      forageable: true,
      yieldFood: "1d6",
      yieldWater: "1d6",
      isCustom: false,
    },
    canCopyEnvironment: true,
    currentEnvLabel: "Limited",
    currentEnvForageable: true,
    currentEnvDc: 15,
    forageMode: "each",
    forageModeEach: true,
    halfRations: false,
    waterEnabled: true,
    autoTrigger: true,
    maxCatchUpDays: 7,
    hasOverviewResources: true,
    overviewResources: [
      {
        id: "food",
        label: "Food (Rations)",
        icon: "fa-solid fa-bread-slice",
        status: "low",
        statusLabel: "Low",
        scopeLabel: "Per character",
        sourceSummary: "2 supply sources; lowest coverage shown",
        available: 6,
        dailyUse: 2,
        coverageLabel: "3 days",
      },
      {
        id: "water",
        label: "Water",
        icon: "fa-solid fa-droplet",
        status: "ready",
        statusLabel: "Ready",
        scopeLabel: "Per character",
        sourceSummary: "2 supply sources; lowest coverage shown",
        available: 6,
        dailyUse: 2,
        coverageLabel: "3 days",
      },
      {
        id: "light",
        label: "Light (Torches)",
        icon: "fa-solid fa-fire-flame-simple",
        status: "critical",
        statusLabel: "Critical",
        scopeLabel: "Party pool",
        sourceSummary: "2 supply sources",
        available: 3,
        dailyUse: 2,
        coverageLabel: "1.5 days",
      },
    ],
    resources,
    rosterIsImplicit: false,
    hasRosterMembers: true,
    partyStashOptions: [
      { value: "", label: "No party stash", selected: true },
      { value: "a1", label: "Aric the Ranger", selected: false },
    ],
    partyStashActive: false,
    partyStashName: "",
    hasParty: true,
    partyRows: [
      {
        actorId: "a1",
        name: "Aric the Ranger",
        exhaustion: 0,
        counts: counts(6, 4, 3),
        consumes: true,
        isStash: true,
        canDrawFromStash: false,
        drawFromOptions: [],
      },
      {
        actorId: "a2",
        name: "Mira Quickstep",
        exhaustion: 1,
        counts: counts(0, 2, 0),
        consumes: true,
        isStash: false,
        canDrawFromStash: true,
        drawFromOptions: [
          { value: "self", label: "Self", selected: true },
          {
            value: "a1",
            label: "Aric the Ranger (stash)",
            selected: false,
          },
        ],
      },
    ],
    hasAvailableToAdd: true,
    availableToAdd: [{ id: "a3", name: "Brother Calder", kindLabel: " (NPC)" }],
    report: {
      days: 1,
      environmentLabel: "Limited",
      hasErrors: false,
      rows: [
        {
          name: "Aric the Ranger",
          ok: true,
          supplied: true,
          shortages: [],
          forageNote: "foraged +5 food / +4 water",
          hasErrors: false,
        },
        {
          name: "Mira Quickstep",
          ok: false,
          supplied: false,
          shortages: [{ label: "Food (Rations)", amount: 1 }],
          forageNote: "foraged nothing",
          hasErrors: false,
        },
      ],
      partyShortages: [
        {
          label: "Light (Torches)",
          amount: 2,
          hasError: false,
        },
      ],
    },
  };
}

function resourceManagerLockedContext() {
  return {
    ...resourceManagerContext(),
    canRunResourceWrites: false,
    hasActiveUpkeep: true,
    activeUpkeep: {
      triggerLabel: "automatic upkeep",
      dayLabel: "day 42",
    },
  };
}

function resourceManagerCustomEnvironmentContext() {
  const context = resourceManagerContext();
  const custom = {
    id: "custom-ashen-march",
    label: "Ashen March",
    dc: 18,
    forageable: true,
    yieldFood: "1d4",
    yieldWater: "1d6-1",
    isCustom: true,
  };
  return {
    ...context,
    environments: [
      ...context.environments.map((environment) => ({
        ...environment,
        selected: false,
      })),
      { ...custom, optionLabel: custom.label, selected: true },
    ],
    currentEnvironment: custom,
    currentEnvLabel: custom.label,
    currentEnvDc: custom.dc,
  };
}

function resourceOverviewContext() {
  return {
    isGmPreview: false,
    updatedLabel: "Jul 25, 2026, 2:14 PM",
    sharingDisabled: false,
    disabled: false,
    noGm: false,
    loading: false,
    requestFailed: false,
    hasOverview: true,
    hasParty: true,
    partySize: 2,
    autoTrigger: true,
    halfRations: false,
    environment: {
      id: "limited",
      label: "Limited",
      forageable: true,
      dc: 15,
    },
    hasResources: true,
    resources: [
      {
        id: "food",
        label: "Food (Rations)",
        icon: "fa-solid fa-bread-slice",
        status: "low",
        statusLabel: "Low",
        scopeLabel: "Per character",
        sourceSummary: "2 supply sources; lowest coverage shown",
        available: 6,
        dailyUse: 2,
        coverageLabel: "3 days",
      },
      {
        id: "water",
        label: "Water",
        icon: "fa-solid fa-droplet",
        status: "ready",
        statusLabel: "Ready",
        scopeLabel: "Per character",
        sourceSummary: "2 supply sources; lowest coverage shown",
        available: 8,
        dailyUse: 2,
        coverageLabel: "4 days",
      },
      {
        id: "light",
        label: "Light (Torches)",
        icon: "fa-solid fa-fire-flame-simple",
        status: "critical",
        statusLabel: "Critical",
        scopeLabel: "Party pool",
        sourceSummary: "2 supply sources",
        available: 1,
        dailyUse: 2,
        coverageLabel: "<1 day",
      },
    ],
    lastUpkeep: {
      status: "partial",
      rows: [
        {
          name: "Aric the Ranger",
          supplied: true,
          ok: true,
          shortages: [],
          forageNote: "Foraged +5 food / +4 water.",
          hasErrors: false,
        },
        {
          name: "Mira Quickstep",
          supplied: false,
          ok: false,
          shortages: [{ label: "Food (Rations)", amount: 1 }],
          forageNote: "Foraged nothing.",
          hasErrors: false,
        },
      ],
      partyShortages: [
        {
          label: "Light (Torches)",
          amount: 1,
          hasError: false,
        },
      ],
    },
  };
}

function resourceOverviewOfflineContext() {
  return {
    isGmPreview: false,
    updatedLabel: "",
    sharingDisabled: false,
    disabled: false,
    noGm: true,
    loading: false,
    requestFailed: false,
    hasOverview: false,
    hasParty: false,
    partySize: 0,
    autoTrigger: true,
    halfRations: false,
    environment: null,
    hasResources: false,
    resources: [],
    lastUpkeep: null,
  };
}

function downtimeWorkspaceEmptyContext() {
  return downtimeWorkspaceBaseContext({
    workflowStatus: "idle",
    workflowStatusLabel: "No active block",
    workflowTone: "neutral",
    hasCurrentBlock: false,
    currentBlock: null,
    canCreateBlock: true,
  });
}

function downtimeWorkspaceCollectingContext() {
  return downtimeWorkspaceBaseContext({
    workflowStatus: "collecting",
    workflowStatusLabel: "Collecting",
    workflowTone: "neutral",
    hasCurrentBlock: true,
    currentBlock: downtimeBlockContext("collecting"),
    canCreateBlock: false,
    createBlockReason: "Finish or cancel the current block first.",
  });
}

function downtimeWorkspaceLockedContext() {
  const block = downtimeBlockContext("locked");
  for (const participant of block.participants) {
    participant.submitted = true;
    participant.submissionLabel = "Submitted";
  }
  block.submittedCount = block.participants.length;
  return downtimeWorkspaceBaseContext({
    workflowStatus: "locked",
    workflowStatusLabel: "Locked",
    workflowTone: "neutral",
    hasCurrentBlock: true,
    currentBlock: block,
    canCreateBlock: false,
    createBlockReason: "Finish or cancel the current block first.",
  });
}

function downtimeWorkspacePreviewContext() {
  const block = downtimeBlockContext("planned");
  block.planId = "plan-haven-001";
  block.plannedAt = "Aug 8, 2026, 3:20 PM";
  block.hasPlan = true;
  block.planCharacters = [
    {
      actorId: "actor-aric",
      name: "Aric the Ranger",
      status: "planned",
      operations: [
        {
          id: "operation-aric-ammo",
          label: "Craft Ammunition",
          hours: 4,
          rollLabel: "",
          hasRoll: false,
          outcome: "Spend 5 sp and add 20 arrows.",
          tone: "success",
        },
        {
          id: "operation-aric-trade",
          label: "Market Trading",
          hours: 4,
          rollLabel: "18 total vs. DC 13 (margin +5)",
          hasRoll: true,
          outcome: "Success: return 55 gp from a 50 gp stake.",
          tone: "success",
        },
      ],
    },
    {
      actorId: "actor-mira",
      name: "Mira Quickstep",
      status: "planned",
      operations: [
        {
          id: "operation-mira-pickpocket",
          label: "Pickpocket",
          hours: 4,
          rollLabel: "11 total vs. DC 13 (margin -2)",
          hasRoll: true,
          outcome: "Setback: no goods and local Heat rises to 2.",
          tone: "setback",
        },
      ],
    },
  ];
  return downtimeWorkspaceBaseContext({
    workflowStatus: "planned",
    workflowStatusLabel: "Preview ready",
    workflowTone: "accent",
    hasCurrentBlock: true,
    currentBlock: block,
    canCreateBlock: false,
    createBlockReason: "Finish or cancel the current block first.",
  });
}

function downtimeWorkspaceRecoveryContext() {
  const block = downtimeBlockContext("needs-review");
  block.participants[0].resultStatus = "applied";
  block.participants[0].receipt = "Ammunition write verified.";
  block.participants[0].hasReceipt = true;
  block.participants[1].resultStatus = "needs-review";
  block.participants[1].receipt =
    "Merchant stock changed while applying; dependent operations stopped.";
  block.participants[1].hasReceipt = true;
  return downtimeWorkspaceBaseContext({
    workflowStatus: "needs-review",
    workflowStatusLabel: "Needs review",
    workflowTone: "danger",
    hasCurrentBlock: true,
    currentBlock: block,
    canCreateBlock: false,
    createBlockReason: "Recover the current block first.",
    needsRecovery: true,
    recoveryMessage:
      "One character encountered external inventory drift. Recovery will verify saved operation IDs before retrying anything.",
    recovery: { available: true },
  });
}

function downtimeWorkspaceApplyingContext() {
  const context = downtimeWorkspacePreviewContext();
  context.workflowStatus = "applying";
  context.workflowStatusLabel = "Applying";
  context.workflowTone = "accent";
  context.busy = true;
  context.statusMessage = "Applying the saved operation plan…";
  context.currentBlock.status = "applying";
  context.currentBlock.statusLabel = "Applying";
  context.currentBlock.statusTone = "accent";
  context.currentBlock.canApply = false;
  context.currentBlock.canCancel = false;
  context.currentBlock.canRecover = false;
  context.currentBlock.applyReason = "Application is already in progress.";
  context.currentBlock.cancelReason =
    "This block can no longer be cancelled after application begins.";
  return context;
}

function downtimeWorkspaceCompletedHistoryContext() {
  return downtimeWorkspaceBaseContext({
    view: "history",
    viewCurrent: false,
    viewSettlements: false,
    viewHistory: true,
    workflowStatus: "idle",
    workflowStatusLabel: "No active block",
    workflowTone: "neutral",
    hasCurrentBlock: false,
    currentBlock: null,
    history: [
      {
        id: "downtime-block-haven",
        settlementName: "Haven",
        hours: 8,
        characterCount: 2,
        when: "Aug 8, 2026, 3:24 PM",
        summary: "2 character receipts applied from the immutable plan.",
        statusLabel: "Completed",
        statusTone: "success",
      },
    ],
    hasHistory: true,
  });
}

function downtimeWorkspaceBaseContext(overrides = {}) {
  return {
    view: "current",
    viewCurrent: true,
    viewSettlements: false,
    viewHistory: false,
    hasCurrentBlock: false,
    currentBlock: null,
    workflowStatus: "idle",
    workflowStatusLabel: "No active block",
    workflowTone: "neutral",
    needsRecovery: false,
    recoveryMessage: "",
    settlements: [
      {
        id: "settlement-haven",
        name: "Haven",
        wealthLabel: "Prosperous",
        securityLabel: "Guarded",
        merchantCount: 2,
        selected: true,
      },
      {
        id: "settlement-dustfall",
        name: "Dustfall",
        wealthLabel: "Modest",
        securityLabel: "Secure",
        merchantCount: 1,
        selected: false,
      },
    ],
    hasSettlements: true,
    selectedSettlement: null,
    hasSelectedSettlement: false,
    actors: [
      {
        id: "actor-aric",
        name: "Aric the Ranger",
        img: iconDataUri("#496f4e", "AR"),
        checked: true,
        eligible: true,
        reason: "",
      },
      {
        id: "actor-mira",
        name: "Mira Quickstep",
        img: iconDataUri("#6f496c", "MQ"),
        checked: true,
        eligible: true,
        reason: "",
      },
    ],
    hasActors: true,
    canCreateBlock: true,
    createBlockReason: "",
    history: [],
    hasHistory: false,
    recovery: null,
    busy: false,
    statusMessage: "",
    errorMessage: "",
    hasError: false,
    ...overrides,
  };
}

function downtimeBlockContext(status) {
  const labels = {
    collecting: "Collecting",
    locked: "Locked",
    planned: "Preview ready",
    applying: "Applying",
    "needs-review": "Needs review",
  };
  const tones = {
    collecting: "neutral",
    locked: "neutral",
    planned: "accent",
    applying: "accent",
    "needs-review": "danger",
  };
  return {
    id: "downtime-block-haven",
    status,
    statusLabel: labels[status] ?? status,
    statusTone: tones[status] ?? "neutral",
    settlementId: "settlement-haven",
    settlementName: "Haven",
    hours: 8,
    dayLabel: "1 productive day",
    participants: [
      {
        actorId: "actor-aric",
        name: "Aric the Ranger",
        img: iconDataUri("#496f4e", "AR"),
        submitted: true,
        submissionLabel: "Submitted",
        usedHours: 8,
        budgetHours: 8,
        remainingHours: 0,
        queue: [
          {
            id: "queue-aric-ammo",
            label: "Craft Ammunition",
            hours: 4,
            detail: "20 arrows",
            outcome: "",
            hasOutcome: false,
            tone: "neutral",
          },
          {
            id: "queue-aric-trade",
            label: "Market Trading",
            hours: 4,
            detail: "Persuasion · 50 gp stake",
            outcome: "",
            hasOutcome: false,
            tone: "neutral",
          },
        ],
        hasQueue: true,
        resultStatus: "",
        receipt: "",
        hasReceipt: false,
      },
      {
        actorId: "actor-mira",
        name: "Mira Quickstep",
        img: iconDataUri("#6f496c", "MQ"),
        submitted: false,
        submissionLabel: "Draft",
        usedHours: 4,
        budgetHours: 8,
        remainingHours: 4,
        queue: [
          {
            id: "queue-mira-pickpocket",
            label: "Pickpocket",
            hours: 4,
            detail: "Distracted pilgrim",
            outcome: "",
            hasOutcome: false,
            tone: "neutral",
          },
        ],
        hasQueue: true,
        resultStatus: "",
        receipt: "",
        hasReceipt: false,
      },
    ],
    hasParticipants: true,
    submittedCount: 1,
    planCharacters: [],
    hasPlan: false,
    planId: "",
    plannedAt: "",
    completedAt: "",
    canOpenForPlayers: status === "collecting",
    canLock: status === "collecting",
    canPlan: status === "locked",
    canApply: status === "planned",
    canCancel: ["collecting", "locked", "planned"].includes(status),
    canRecover: status === "needs-review",
    canStartNext: false,
    lockReason: status === "collecting" ? "" : "Submissions are closed.",
    planReason:
      status === "planned"
        ? "Preview already generated."
        : "Lock submissions first.",
    applyReason:
      status === "planned" ? "" : "Generate the immutable preview first.",
    cancelReason: ["collecting", "locked", "planned"].includes(status)
      ? ""
      : "This block can no longer be cancelled.",
  };
}

function downtimeActivitiesAvailableContext() {
  return downtimeActivitiesBaseContext({
    status: "collecting",
    statusLabel: "Planning",
    statusTone: "neutral",
    hasActiveBlock: true,
    editable: true,
    canSubmit: true,
    submitReason: "",
    activities: downtimeActivityCards(),
    hasActivities: true,
    queue: [
      {
        id: "queue-aric-ammo",
        position: 1,
        label: "Craft Ammunition",
        icon: "fa-solid fa-arrows-left-right-to-line",
        hours: 4,
        detail: "20 arrows",
        canMoveUp: false,
        canMoveDown: false,
      },
    ],
    hasQueue: true,
    usedHours: 4,
    remainingHours: 4,
    progressPercent: 50,
  });
}

function downtimeActivitiesPendingContext() {
  return downtimeActivitiesBaseContext({
    status: "planned",
    statusLabel: "GM reviewing preview",
    statusTone: "accent",
    hasActiveBlock: true,
    submitted: true,
    editable: false,
    canSubmit: false,
    submitReason: "Your queue is already submitted.",
    canRecall: false,
    activities: [],
    hasActivities: false,
    queue: downtimeSubmittedQueue(),
    hasQueue: true,
    usedHours: 8,
    remainingHours: 0,
    progressPercent: 100,
  });
}

function downtimeActivitiesLockedContext() {
  return downtimeActivitiesBaseContext({
    status: "locked",
    statusLabel: "Submissions locked",
    statusTone: "neutral",
    hasActiveBlock: true,
    submitted: true,
    editable: false,
    canSubmit: false,
    submitReason: "Submissions are locked while the GM generates the preview.",
    canRecall: false,
    activities: [],
    hasActivities: false,
    queue: downtimeSubmittedQueue(),
    hasQueue: true,
    usedHours: 8,
    remainingHours: 0,
    progressPercent: 100,
  });
}

function downtimeActivitiesApplyingContext() {
  return downtimeActivitiesBaseContext({
    status: "applying",
    statusLabel: "Resolving",
    statusTone: "accent",
    hasActiveBlock: true,
    submitted: true,
    editable: false,
    canSubmit: false,
    submitReason: "The GM is applying the saved plan.",
    canRecall: false,
    activities: [],
    hasActivities: false,
    queue: downtimeSubmittedQueue(),
    hasQueue: true,
    usedHours: 8,
    remainingHours: 0,
    progressPercent: 100,
    busy: true,
    ariaBusy: true,
    statusMessage: "Applying the immutable downtime plan…",
  });
}

function downtimeActivitiesResolvedContext() {
  return downtimeActivitiesBaseContext({
    status: "completed",
    statusLabel: "Completed",
    statusTone: "success",
    hasActiveBlock: false,
    submitted: false,
    actor: null,
    actors: [],
    hasActors: false,
    hasMultipleActors: false,
    editable: false,
    canSubmit: false,
    submitReason: "This downtime block is complete.",
    canRecall: false,
    activities: [],
    hasActivities: false,
    queue: [],
    hasQueue: false,
    budgetHours: 0,
    usedHours: 0,
    remainingHours: 0,
    progressPercent: 0,
    receipt: downtimeReceiptContext(),
    hasReceipt: true,
    completionMessage: "Your downtime has been applied.",
  });
}

function downtimeActivitiesNoGmContext() {
  return downtimeActivitiesBaseContext({
    status: "idle",
    statusLabel: "No active downtime",
    statusTone: "neutral",
    hasActiveBlock: false,
    noGm: true,
    actor: null,
    actors: [],
    hasActors: false,
    hasMultipleActors: false,
    editable: false,
    canSubmit: false,
    submitReason: "An active full GM is required.",
    activities: [],
    hasActivities: false,
    queue: [],
    hasQueue: false,
    usedHours: 0,
    remainingHours: 0,
    progressPercent: 0,
    receipt: downtimeReceiptContext(),
    hasReceipt: true,
  });
}

function downtimeActivitiesBaseContext(overrides = {}) {
  const aric = {
    id: "actor-aric",
    name: "Aric the Ranger",
    img: iconDataUri("#496f4e", "AR"),
    eligible: true,
    reason: "",
    selected: true,
  };
  const mira = {
    id: "actor-mira",
    name: "Mira Quickstep",
    img: iconDataUri("#6f496c", "MQ"),
    eligible: true,
    reason: "",
    selected: false,
  };
  return {
    status: "collecting",
    statusLabel: "Planning",
    statusTone: "neutral",
    hasActiveBlock: true,
    noGm: false,
    needsRecovery: false,
    recoveryMessage: "",
    settlementName: "Haven",
    blockId: "downtime-block-haven",
    actors: [aric, mira],
    hasActors: true,
    hasMultipleActors: true,
    actor: aric,
    heat: 1,
    heatPips: [true, false, false, false, false].map((active) => ({
      active,
    })),
    heatBlocked: false,
    heatMessage: "",
    budgetHours: 8,
    usedHours: 0,
    remainingHours: 8,
    progressPercent: 0,
    categories: [
      { id: "all", label: "All", selected: true },
      { id: "crafting", label: "Crafting", selected: false },
      { id: "commerce", label: "Commerce", selected: false },
      { id: "crime", label: "Crime", selected: false },
    ],
    activities: [],
    hasActivities: false,
    queue: [],
    hasQueue: false,
    submitted: false,
    editable: false,
    canSubmit: false,
    submitReason: "Add at least one activity.",
    canRecall: false,
    receipt: null,
    hasReceipt: false,
    completionMessage: "",
    busy: false,
    ariaBusy: false,
    statusMessage: "",
    errorMessage: "",
    hasError: false,
    ...overrides,
  };
}

function downtimeActivityCards() {
  return [
    {
      id: "craft-ammunition",
      label: "Craft Ammunition",
      description:
        "Use appropriate tools and materials worth half the finished market value to make 20 standard arrows.",
      category: "crafting",
      categoryLabel: "Crafting",
      icon: "fa-solid fa-arrows-left-right-to-line",
      available: true,
      unavailableReason: "",
      hourOptions: [],
      hasHourOptions: false,
      fixedHours: 4,
      selectedHoursLabel: "4 hours",
      skills: [],
      hasSkills: false,
      targets: [],
      hasTargets: false,
      items: [
        {
          id: "arrow",
          label: "Arrows",
          detail: "20 per batch",
          selected: true,
          disabled: false,
        },
      ],
      hasItems: true,
      targetField: "ammunitionType",
      stakeAllowed: false,
      maxStakeGp: 0,
      stakeStepGp: 0.01,
      stakeValueGp: 0,
      costLabel: "5 sp in materials",
      limitLabel: "Repeatable while time, tools, and coin remain",
    },
    {
      id: "market-trading",
      label: "Market Trading",
      description:
        "Stake coin and negotiate through the settlement market. More time improves the check.",
      category: "commerce",
      categoryLabel: "Commerce",
      icon: "fa-solid fa-scale-balanced",
      available: true,
      unavailableReason: "",
      hourOptions: [2, 4, 6, 8].map((value) => ({
        value,
        label: `${value} hours`,
        selected: value === 4,
      })),
      hasHourOptions: true,
      fixedHours: 0,
      selectedHoursLabel: "4 hours",
      skills: [
        { id: "persuasion", label: "Persuasion", selected: true },
        { id: "deception", label: "Deception", selected: false },
      ],
      hasSkills: true,
      targets: [],
      hasTargets: false,
      items: [],
      hasItems: false,
      targetField: "targetId",
      stakeAllowed: true,
      maxStakeGp: 250,
      stakeStepGp: 0.01,
      stakeValueGp: 50,
      costLabel: "Stake up to 250 gp",
      limitLabel: "One trade per character this block",
    },
    {
      id: "pickpocket",
      label: "Pickpocket",
      description:
        "Choose one generated city mark. The GM resolves Sleight of Hand against hidden settlement security.",
      category: "crime",
      categoryLabel: "Crime",
      icon: "fa-solid fa-hand",
      available: true,
      unavailableReason: "",
      hourOptions: [2, 4].map((value) => ({
        value,
        label: `${value} hours${value === 4 ? " (+2)" : ""}`,
        selected: value === 2,
      })),
      hasHourOptions: true,
      fixedHours: 0,
      selectedHoursLabel: "2 hours",
      skills: [
        { id: "sleight-of-hand", label: "Sleight of Hand", selected: true },
      ],
      hasSkills: true,
      targets: [
        {
          id: "mark-pilgrim",
          label: "Distracted pilgrim",
          detail: "mundane purse",
          selected: true,
          disabled: false,
        },
        {
          id: "mark-courier",
          label: "Hurried courier",
          detail: "sealed satchel",
          selected: false,
          disabled: false,
        },
        {
          id: "mark-gambler",
          label: "Celebrating gambler",
          detail: "heavy pockets",
          selected: false,
          disabled: false,
        },
      ],
      hasTargets: true,
      items: [],
      hasItems: false,
      targetField: "targetId",
      stakeAllowed: false,
      maxStakeGp: 0,
      stakeStepGp: 0.01,
      stakeValueGp: 0,
      costLabel: "",
      limitLabel: "Crime attempt 1 of 3 · Heat 1",
    },
    {
      id: "fence-stolen-goods",
      label: "Fence Stolen Goods",
      description:
        "Choose any bundle of provenanced stolen goods that fits the value capacity, then negotiate a discreet sale.",
      category: "crime",
      categoryLabel: "Crime",
      icon: "fa-solid fa-sack-dollar",
      available: true,
      unavailableReason: "",
      hourOptions: [2, 4, 6, 8].map((value) => ({
        value,
        label: `${value} hours`,
        selected: value === 4,
      })),
      hasHourOptions: true,
      fixedHours: 0,
      selectedHoursLabel: "4 hours",
      skills: [
        { id: "persuasion", label: "Persuasion", selected: true },
        { id: "deception", label: "Deception", selected: false },
      ],
      hasSkills: true,
      targets: [
        {
          id: "stolen-brooch",
          label: "Silver brooch",
          detail: "15 gp",
          selected: true,
          disabled: false,
        },
        {
          id: "stolen-comb",
          label: "Ivory comb",
          detail: "8 gp",
          selected: true,
          disabled: false,
        },
        {
          id: "stolen-ring",
          label: "Signet ring",
          detail: "25 gp",
          selected: false,
          disabled: false,
        },
      ],
      hasTargets: true,
      multiTarget: true,
      items: [],
      hasItems: false,
      targetField: "targetIds",
      stakeAllowed: false,
      maxStakeGp: 0,
      stakeStepGp: 0.01,
      stakeValueGp: 0,
      costLabel: "Selected goods must fit the 50 gp capacity",
      limitLabel: "One fencing attempt per character this block",
    },
    {
      id: "shoplift",
      label: "Shoplift",
      description:
        "Steal one finite stock unit from a merchant linked to this settlement.",
      category: "crime",
      categoryLabel: "Crime",
      icon: "fa-solid fa-bag-shopping",
      available: false,
      unavailableReason:
        "No eligible finite merchant stock is currently available in Haven.",
      hourOptions: [],
      hasHourOptions: false,
      fixedHours: 4,
      selectedHoursLabel: "4 hours",
      skills: [],
      hasSkills: false,
      targets: [],
      hasTargets: false,
      items: [],
      hasItems: false,
      targetField: "itemId",
      stakeAllowed: false,
      maxStakeGp: 0,
      stakeStepGp: 0.01,
      stakeValueGp: 0,
      costLabel: "",
      limitLabel: "Requires finite linked-merchant stock",
    },
  ];
}

function downtimeSubmittedQueue() {
  return [
    {
      id: "queue-aric-ammo",
      position: 1,
      label: "Craft Ammunition",
      icon: "fa-solid fa-arrows-left-right-to-line",
      hours: 4,
      detail: "20 arrows",
      canMoveUp: false,
      canMoveDown: true,
    },
    {
      id: "queue-aric-trade",
      position: 2,
      label: "Market Trading",
      icon: "fa-solid fa-scale-balanced",
      hours: 4,
      detail: "Persuasion · 50 gp stake",
      canMoveUp: true,
      canMoveDown: false,
    },
  ];
}

function downtimeReceiptContext() {
  return {
    settlementName: "Haven",
    completedAt: "Aug 8, 2026, 3:26 PM",
    activities: [
      {
        id: "operation-aric-ammo",
        label: "Craft Ammunition",
        summary: "Spent 5 sp and added 20 arrows.",
        tone: "success",
      },
      {
        id: "operation-aric-trade",
        label: "Market Trading",
        summary: "Returned 55 gp from a 50 gp stake.",
        tone: "success",
      },
    ],
    hasActivities: true,
    summary:
      "All saved operations were verified. Campaign time and Quartermaster upkeep were not advanced.",
  };
}

function foragePromptContext() {
  return {
    environmentLabel: "Limited (hills, farmland, woods)",
    dc: 15,
    noActor: false,
    isPrompt: true,
    isWaiting: false,
    isDone: false,
    actorName: "Aric the Ranger",
    passiveLabel: "Your passive Survival is 14",
    wisLabel: "Wisdom +2",
    result: { success: false, food: 0, water: 0 },
  };
}

function criticalInjuryContext() {
  return {
    actorName: "Aric the Ranger",
    actorImg: iconDataUri("#8a3f43", "AR"),
    noActor: false,
    pending: {
      id: "pending-aric",
      actorId: "a-aric",
      actorName: "Aric the Ranger",
    },
    hasPending: true,
    pendingCount: 1,
    waitingForRoll: false,
    latestResult: {
      injuryRoll: 47,
      injuryName: "Shattered Knee",
      detailLabel: "Left knee",
      effect: "Cannot Dash. Speed is halved and movement is painful.",
      recoveryLabel: "7 recovery day(s)",
      dueLabel: "12 Eleasis, 1492 DR",
    },
    hasLatestResult: true,
    activeInjuries: [
      {
        id: "injury-knee",
        name: "Shattered Knee",
        roll: 47,
        detailLabel: "Left knee",
        effect: "Cannot Dash. Speed is halved and movement is painful.",
        recoveryLabel: "7 recovery day(s)",
        dueLabel: "12 Eleasis, 1492 DR",
        recoveryRule:
          "1 week or 3 Healer's Kit charges. It becomes permanent if untreated.",
        permanent: false,
        stabilized: false,
        kitCharges: 3,
        treatmentCheck: "No check",
        canTreat: true,
        treating: false,
        automatedChanges: 1,
      },
      {
        id: "injury-scar",
        name: "Deep Scar",
        roll: 74,
        detailLabel: "Visible facial scar",
        effect: "+1 Intimidation and -1 Persuasion while the scar is visible.",
        recoveryLabel: "Permanent",
        dueLabel: "",
        recoveryRule: "Permanent.",
        permanent: true,
        stabilized: false,
        kitCharges: 0,
        treatmentCheck: "No check",
        canTreat: false,
        treating: false,
        automatedChanges: 2,
      },
    ],
    hasActiveInjuries: true,
    statusMessage: "The injury was applied and added to the calendar.",
    integrations: {
      midiActive: true,
      daeActive: true,
      calendarActive: true,
      automationReady: true,
    },
  };
}

function criticalInjuryHudContext() {
  return {
    actorName: "Aric the Ranger",
    injuryCount: 3,
    statusMessage: "The active GM is ready to review treatment.",
    animationsEnabled: true,
    markers: [
      {
        key: "head",
        label: "Head",
        count: 1,
        accessibleLabel: "Head: 1 active injury — Concussion",
        pinned: false,
        injuries: [
          {
            id: "injury-concussion",
            name: "Concussion",
            effect: "Disadvantage on Intelligence checks.",
            recoveryLabel: "4 recovery day(s)",
            dueLabel: "9 Eleasis, 1492 DR",
            locationLabel: "Head",
            canTreat: true,
            treating: false,
            kitCharges: 1,
            treatmentCheck: "DC 12 Medicine",
            treatmentMessage: "",
            permanent: false,
            stabilized: false,
          },
        ],
      },
      {
        key: "left-leg",
        label: "Left leg",
        count: 2,
        accessibleLabel:
          "Left leg: 2 active injuries — Shattered Knee, Lost Limb",
        pinned: true,
        injuries: [
          {
            id: "injury-knee",
            name: "Shattered Knee",
            effect: "Speed is halved and the character cannot Dash.",
            recoveryLabel: "7 recovery day(s)",
            dueLabel: "12 Eleasis, 1492 DR",
            locationLabel: "Left leg",
            canTreat: true,
            treating: false,
            kitCharges: 3,
            treatmentCheck: "No check",
            treatmentMessage: "The active GM is ready to review treatment.",
            permanent: false,
            stabilized: false,
          },
          {
            id: "injury-lost-leg",
            name: "Lost Limb",
            effect: "The left leg is lost.",
            recoveryLabel: "Permanent",
            dueLabel: "",
            locationLabel: "Left leg",
            canTreat: false,
            treating: false,
            kitCharges: 0,
            treatmentCheck: "No check",
            treatmentMessage: "",
            permanent: true,
            stabilized: false,
          },
        ],
      },
    ],
  };
}

function reputationWorkspaceContext() {
  const selected = {
    id: "f-veil",
    name: "The Silver Veil",
    category: "Thieves' Guild",
    description:
      "A discreet network of fences and informants working the harbor district.",
    gmNotes: "Owes the party a favor after the warehouse job.",
    playerNote: "They remember you fondly after the warehouse job.",
    img: iconDataUri("#6b5a8a", "SV"),
    revealed: true,
    standing: 2,
    tier: "Friendly",
    band: "warm",
    standingLabel: "+2 — Friendly",
    canRaise: true,
    canLower: true,
    meterPercent: 70,
    hasHistory: true,
    history: [
      {
        id: "h1",
        reason: "Returned the stolen ledger",
        by: "GM",
        when: "Today 7:14 PM",
        deltaLabel: "+1",
        deltaTone: "up",
        swing: "Noticed → Friendly",
        changed: true,
      },
      {
        id: "h2",
        reason: "First contact at the Drowned Rat",
        by: "GM",
        when: "Today 6:02 PM",
        deltaLabel: "note",
        deltaTone: "flat",
        swing: "Neutral → Neutral",
        changed: false,
      },
    ],
    hasPerCharacter: true,
    perCharacter: [
      {
        id: "pc1",
        actorId: "a-thia",
        delta: 1,
        note: "Thia grew up in the guild",
        unknownActor: false,
        characterOptions: [
          { id: "a-thia", name: "Thia", selected: true },
          { id: "a-bram", name: "Bram", selected: false },
        ],
      },
    ],
  };
  return {
    moduleId: "infinity-dnd5e",
    saveStatus: "Saved",
    hasFactions: true,
    total: 2,
    revealedCount: 1,
    hasCharacters: true,
    factions: [
      {
        id: "f-veil",
        name: "The Silver Veil",
        img: iconDataUri("#6b5a8a", "SV"),
        tier: "Friendly",
        band: "warm",
        standingLabel: "+2 — Friendly",
        revealed: true,
        selected: true,
      },
      {
        id: "f-crown",
        name: "The Iron Crown",
        img: iconDataUri("#7a3b3b", "IC"),
        tier: "Hostile",
        band: "hostile",
        standingLabel: "−3 — Hostile",
        revealed: false,
        selected: false,
      },
    ],
    selected,
  };
}

function reputationViewContext() {
  return {
    isGmPreview: false,
    noGm: false,
    loading: false,
    requestFailed: false,
    hasFactions: true,
    factions: [
      {
        id: "f-veil",
        name: "The Silver Veil",
        category: "Thieves' Guild",
        img: iconDataUri("#6b5a8a", "SV"),
        tier: "Friendly",
        band: "warm",
        standingLabel: "+2 — Friendly",
        playerNote: "They remember you fondly after the warehouse job.",
      },
      {
        id: "f-crown",
        name: "The Iron Crown",
        category: "Ruling House",
        img: iconDataUri("#7a3b3b", "IC"),
        tier: "Hostile",
        band: "hostile",
        standingLabel: "−3 — Hostile",
        playerNote:
          "Word of your deeds has reached the throne — and they are not pleased.",
      },
    ],
  };
}

function reputationViewEmptyContext() {
  return {
    isGmPreview: false,
    noGm: false,
    loading: false,
    requestFailed: false,
    hasFactions: false,
    factions: [],
  };
}

function tierOptions(selectedTier) {
  return [
    ["t1", "T1 - Lvl 1-4", "T1", 408],
    ["t2", "T2 - Lvl 5-10", "T2", 300],
    ["t3", "T3 - Lvl 11-16", "T3", 328],
    ["t4", "T4 - Lvl 17-20", "T4", 287],
    ["t5", "T5 - Epic", "T5", 99],
  ].map(([value, label, shortLabel, count]) => ({
    value,
    label,
    shortLabel,
    count,
    selected: value === selectedTier,
  }));
}

function rarityOptions(selected) {
  const selectedSet = new Set(selected);
  return COMMON_RARITIES.map(([value, label, count]) => ({
    value,
    label,
    count,
    countKnown: true,
    selected: selectedSet.has(value),
    unavailable: false,
    partial: false,
    selectedUnavailable: false,
    disabled: false,
    availabilityTitle: `${count} matching items with the other current filters.`,
  }));
}

function rarityBalanceOptions(selected = "even") {
  return [
    ["even", "Even"],
    ["shop", "Shop Stock"],
    ["hoard", "Treasure Hoard"],
    ["highMagic", "High Magic"],
    ["custom", "Custom"],
  ].map(([value, label]) => ({ value, label, selected: value === selected }));
}

function rarityWeightRows(weights = {}) {
  return COMMON_RARITIES.map(([rarity, label]) => ({
    rarity,
    label,
    weight: Number(weights[rarity] ?? 1).toFixed(2),
    min: 0,
    max: 10,
    step: 0.05,
  }));
}

function lootTypeOptions(selected) {
  const selectedSet = new Set(selected);
  return COMMON_LOOT_TYPES.map(([value, label, count]) => ({
    value,
    label,
    count,
    countKnown: true,
    selected: selectedSet.has(value),
    unavailable: false,
    partial: false,
    selectedUnavailable: false,
    disabled: false,
    availabilityTitle: `${count} matching items with the other current filters.`,
  }));
}

function encounterChanceContext() {
  const categoryPercents = new Map([
    ["loot.weapon.magic", 4.9],
    ["loot.weapon.mundane", 8.2],
    ["loot.armor.magic", 2.3],
    ["loot.armor.mundane", 4.0],
    ["loot.equipment.magic", 6.4],
    ["loot.equipment", 7.5],
    ["loot.consumable", 12.4],
    ["loot.potion", 8.4],
    ["loot.reagent", 7.3],
    ["loot.scroll", 1.3],
    ["loot.ammunition", 6.1],
    ["loot.tool", 7.3],
    ["loot.gem", 10.8],
    ["loot.art", 7.9],
    ["loot.trade-good", 9.9],
    ["loot.container", 3.3],
  ]);
  const chanceRow = (group, key, label, percent) => ({
    group,
    key,
    label,
    percentLabel: `${Number(percent).toFixed(percent >= 10 ? 1 : 2)}%`,
    available: percent > 0,
  });
  return {
    available: true,
    expanded: true,
    status:
      "644 selectable candidates · recalculated from the current tier, filters, and Magic Bias.",
    categoryRows: COMMON_LOOT_TYPES.map(([key, label]) =>
      chanceRow("category", key, label, categoryPercents.get(key) ?? 0),
    ),
    rarityRows: [
      chanceRow("rarity", "common", "Common", 77.5),
      chanceRow("rarity", "uncommon", "Uncommon", 22.5),
      chanceRow("rarity", "rare", "Rare", 0),
      chanceRow("rarity", "very-rare", "Very Rare", 0),
      chanceRow("rarity", "legendary", "Legendary", 0),
      chanceRow("rarity", "artifact", "Artifact", 0),
    ],
    magicRows: [
      chanceRow("magic", "mundane", "Mundane", 69.6),
      chanceRow("magic", "neutral", "Neutral", 11.4),
      chanceRow("magic", "magic", "Magic", 19),
    ],
  };
}

function slider(name, label, value, valueLabel, snaps, range = {}) {
  return {
    name,
    label,
    value,
    valueLabel,
    min: range.min ?? -1,
    max: range.max ?? 4,
    step: range.step ?? 0.05,
    presetLabel: name === "magicBias" ? "Balanced" : "",
    snaps: snaps?.map(([key, snapLabel, snapValue]) => ({
      key,
      label: snapLabel,
      value: snapValue,
      active: snapValue === value,
    })),
  };
}

function resultItems() {
  return [
    item("pe-1", "common", "Hand Crossbow", "Common", "75 gp", "#b8753a"),
    item("pe-2", "common", "Bane", "Common", "50 gp", "#6223bd"),
    item("pe-3", "common", "Entangle", "Common", "50 gp", "#285f1d"),
    item("pe-4", "common", "Light", "Common", "25 gp", "#dcecff"),
    item("pe-5", "common", "Halberd", "Common", "20 gp", "#44a6ac"),
    item(
      "pe-6",
      "uncommon",
      "Smoke-Darkened Reliquary",
      "Uncommon",
      "120 gp",
      "#854c19",
      "All matching pieces are still present; minor noble provenance adds prestige; court inventory seal remains intact.",
      "Infinity D&D5e Curated Items / Art Objects",
    ),
    item("pe-7", "rare", "Amethyst", "Rare", "10 gp", "#7e4ec4"),
    item("pe-8", "common", "Herbalism Kit", "Common", "5 gp", "#4f8a44"),
    item("pe-9", "common", "Backpack", "Common", "2 gp", "#b77b2c"),
    item("pe-10", "common", "Dart", "Common", "0 gp", "#c83b25"),
  ];
}

function item(
  id,
  rarity,
  displayName,
  rarityLabel,
  gpTotalLabel,
  color,
  variantSummary = "",
  sourceLabel = "",
) {
  return {
    resultId: id,
    entryId: id,
    variant: variantSummary ? { id, summary: variantSummary } : null,
    rarity,
    displayName,
    variantSummary,
    sourceLabel,
    imageSrc: iconDataUri(color, displayName.slice(0, 2)),
    quantityLabel: "",
    gpTotalLabel,
    valueLabel: "",
    locked: id === "pe-2",
    item: {
      uuid: `Compendium.infinity-dnd5e-items.Item.${id}`,
      name: displayName,
      img: iconDataUri(color, rarityLabel.slice(0, 2)),
    },
  };
}

function iconDataUri(color, label) {
  const safeLabel = escapeHtml(label.toUpperCase());
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><rect width="64" height="64" rx="10" fill="${color}"/><circle cx="48" cy="16" r="18" fill="rgba(255,255,255,.16)"/><text x="32" y="38" text-anchor="middle" font-family="Arial" font-size="18" font-weight="700" fill="white">${safeLabel}</text></svg>`;
  return `data:image/svg+xml,${encodeURIComponent(svg)}`;
}
