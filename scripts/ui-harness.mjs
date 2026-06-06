import { readFileSync } from "node:fs";

import Handlebars from "handlebars";

const CSS_FILES = [
  "styles/tokens.css",
  "styles/dashboard.css",
  "styles/loot-forge.css",
  "styles/hoard-loot.css",
  "styles/per-creature-loot.css",
  "styles/merchant-workspace.css",
  "styles/merchant-session.css",
];

const MODULE_VERSION = JSON.parse(readFileSync("package.json", "utf8")).version;

const COMMON_RARITIES = [
  ["common", "Common", 298],
  ["uncommon", "Uncommon", 266],
  ["rare", "Rare", 311],
  ["very-rare", "Very-rare", 209],
  ["legendary", "Legendary", 84],
  ["artifact", "Artifact", 12],
];

const COMMON_LOOT_TYPES = [
  ["weapon-magic", "Weapon - Magic", 9],
  ["weapon-mundane", "Weapon - Mundane", 18],
  ["armor-magic", "Armor - Magic", 83],
  ["armor-mundane", "Armor - Mundane", 16],
  ["equipment", "Equipment", 17],
  ["consumable", "Consumable", 64],
  ["scroll", "Scroll", 44],
  ["wand", "Wand", 22],
  ["rod", "Rod", 11],
  ["staff", "Staff", 8],
  ["ring", "Ring", 18],
  ["wondrous", "Wondrous", 171],
  ["gem", "Gem", 34],
  ["art", "Art", 42],
  ["tool", "Tool", 39],
  ["trade-good", "Trade-Good", 20],
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
      "merchant-session",
      "Merchant Session",
      "infinity-merchant-session",
      "templates/merchant-session.hbs",
      merchantSessionContext(),
      { width: 720, height: 600 },
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
  return `<section data-harness-section="${escapeAttr(entry.id)}">
    <h2 class="ui-harness__label">${escapeHtml(entry.label)}</h2>
    <section
      class="window-app application infinity-dnd5e ${escapeAttr(entry.rootClass)} ui-harness__window"
      data-harness-window="${escapeAttr(entry.id)}"
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
  return {
    moduleVersion: MODULE_VERSION,
    hasTools: true,
    categories: [
      {
        category: "loot",
        label: "Loot",
        tools: tools.map((tool) => ({
          ...tool,
          isAvailable: true,
          isComingSoon: false,
          statusLabel: "",
        })),
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
    moduleId: "infinity-dnd5e",
    form: {
      itemLimitEnabled: true,
      artVariants: true,
      budgetOverride: 0,
    },
    projectedBudgetLabel: "450 gp",
    candidateLabel: "644 items match current filters",
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
    magicBias: slider("magicBias", "Magic Bias", 0, "Neutral", [
      ["neutral", "Neutral", 0],
      ["lean-magic", "More Magic", 0.5],
      ["heavy-magic", "Arcane", 1],
    ]),
    rarityOptions: rarityOptions(["common", "uncommon", "rare"]),
    lootTypeOptions: lootTypeOptions([
      "weapon-magic",
      "armor-magic",
      "consumable",
      "tool",
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
    },
  };
}

function hoardContext() {
  return {
    ...menuContext(),
    form: { artVariants: true },
    totalBudgetLabel: "2,400 gp",
    coinPileLabel: "900 gp",
    itemBudgetLabel: "1,500 gp",
    candidateLabel: "711 items match current filters",
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
    pileBias: slider("pileBias", "Pile Bias", 0.45, "Balanced", [
      ["coin", "Coin", 0.15],
      ["balanced", "Balanced", 0.45],
      ["items", "Items", 0.8],
    ]),
    magicBias: slider("magicBias", "Magic Bias", 0.25, "Slightly Magical", [
      ["mundane", "Mundane", -0.5],
      ["neutral", "Neutral", 0],
      ["magic", "Magical", 0.5],
    ]),
    rarityOptions: rarityOptions(["common", "uncommon", "rare", "very-rare"]),
    lootTypeOptions: lootTypeOptions(["gem", "art", "wondrous", "consumable"]),
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
    rosterRows: rows.map((row) => ({
      ...row,
      tierOptions: tierOptions(row.tier),
    })),
    rosterFull: false,
    rosterTotalBudgetLabel: "303 gp",
    candidateLabel: "644 items match current filters",
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
    magicBias: slider("magicBias", "Magic Bias", 0, "Neutral", [
      ["mundane", "Mundane", -0.5],
      ["neutral", "Neutral", 0],
      ["magic", "Magical", 0.5],
    ]),
    rarityOptions: rarityOptions(["common", "uncommon"]),
    lootTypeOptions: lootTypeOptions([
      "weapon-mundane",
      "equipment",
      "tool",
      "trade-good",
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
      { id: "prf", label: "Persuasion", checked: true },
      { id: "dec", label: "Deception", checked: true },
      { id: "itm", label: "Intimidation", checked: false },
    ],
    poolLootTypeOptions: [
      { value: "weapon-magic", label: "Weapon Magic", checked: true },
      { value: "consumable", label: "Consumable", checked: false },
      { value: "gem", label: "Gem", checked: true },
    ],
    poolRarityOptions: [
      { value: "common", label: "Common", checked: true },
      { value: "uncommon", label: "Uncommon", checked: false },
      { value: "rare", label: "Rare", checked: false },
    ],
    poolCount: 6,
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
  };
}

function merchantSessionContext() {
  return {
    merchant: {
      id: "m-curios",
      name: "Yannick's Curios",
      art: "icons/svg/shop.svg",
      description: "A cramped stall of oddments and salvaged gear.",
    },
    walletLabel: "42 gp · 5 sp",
    merchantGoldLabel: "320 gp",
    buyActive: true,
    sellActive: true,
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
        sealLabel: "crit-success -20%",
        cannotBuy: false,
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
        finalLabel: "12.00 gp",
        priceDeltaLabel: "",
        deltaClass: "up",
        bargainLocked: false,
        sealLabel: "",
        cannotBuy: false,
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
        baseLabel: "7.50 gp",
        finalLabel: "9.00 gp",
        priceDeltaLabel: "+20%",
        deltaClass: "down",
        bargainLocked: false,
        sealLabel: "crit-success +20%",
      },
    ],
    log: [
      { kind: "buy", text: "Bought 1× Potion of Healing for 48.00 gp" },
      { kind: "bargain", text: "Bargain crit-success · -20%" },
    ],
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
    selected: selectedSet.has(value),
  }));
}

function lootTypeOptions(selected) {
  const selectedSet = new Set(selected);
  return COMMON_LOOT_TYPES.map(([value, label, count]) => ({
    value,
    label,
    count,
    selected: selectedSet.has(value),
  }));
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

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function escapeAttr(value) {
  return escapeHtml(value).replaceAll("'", "&#39;");
}
