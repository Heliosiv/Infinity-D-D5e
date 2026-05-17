# Infinity D&D5e

Tag-driven GM tools for D&D 5e on Foundry VTT, surfaced through a single dashboard.

## What this module is

A focused, ground-up rewrite of the GM tooling formerly bundled inside `party-operations`. Ships a curated 1,456-item compendium (every item pre-tagged with rarity, tier, value band, magic-type, and folder taxonomy under the `po-loot-v3` schema) plus a GM dashboard that launches each tool in its own window.

A single scene-control button (the d20 icon under Token Controls) opens the dashboard; tiles inside it open individual tools. New tools become available by calling `registerTool(...)` — the dashboard re-renders without any UI plumbing.

## Status

**v0.2.0 (in progress)** — Dashboard + Per-Encounter Loot.

- GM-only dashboard with a tile grid of tools
- **Per-Encounter Loot** (available) — slider-driven controls (encounter scale, generosity, party size, item count, magic bias), tier segmented buttons, multi-select rarity + loot-type chips with live per-bucket pack counts, and a live "X items match" candidate readout. Snap-buttons under each slider lock to canonical values (Trivial / Standard / Hard / Deadly / Hoard, Stingy / Balanced / Generous). Quick-fight macros (Easy / Standard / Hard / Hoard) stamp three sliders in one click. **Use Party** auto-fills party size from the live player list. **All / None** affordances on each chip row. Lock individual results to preserve them through **Re-roll Unlocked**. **Send to Chat** posts the bundle as a clickable chat card. Form + last result persist across window close until page reload.
- **Horde Loot** (available) — treasure for a defeated mob. Mob Size scales the gp budget linearly off the threat tier; a **Pile Bias** slider (Coin Heavy / Mixed / Item Heavy) trades raw coin for items. Result presents as a coin-pile card (with `pp / gp / sp / cp` breakdown) plus the item list. Same rarity / loot-type chips, same Magic Bias dial, same Send-to-Chat path.
- **Per-Creature Loot** (available) — build a roster of defeated creatures (each with a name + tier), click **Roll All**, and each creature gets its own small bundle. Per-creature reroll button regenerates one creature's drops without disturbing the rest. Result is grouped per creature with a grand total at the top. Send to Chat groups drops by creature.
- No claim board, no player UI, no merchant flow (yet)

### Magic Bias

The Per-Encounter window includes a single −100% (mundane) … 0 (neutral) … +100% (magic) slider. Each item is classified by its `lootType` as `magic`, `mundane`, or `neutral`; the slider applies a per-item weight multiplier of `(1 ± bias)`, clamped at 0. Set it to ±100% to exclude the opposite side entirely; the "Neutral" snap button hammers it back to center. The classifier lives in [tag-vocabulary.js](scripts/loot/tag-vocabulary.js) so the same lists drive any future tools.

### Keyboard

Inside the Per-Encounter window: **Enter** or **R** triggers Generate. Both are guarded so they don't fire while the cursor is in a text/number input. Toggleable in settings.

### Settings

Every default the loot tools ship with is editable from Foundry's _Game Settings → Configure Settings → Module Settings → Infinity D&D5e_. The dashboard has a **Configure Defaults** button in its footer that jumps straight there.

Registered settings ([scripts/settings.js](scripts/settings.js)):

| Setting                  | Scope  | Default         | What it controls                                |
| ------------------------ | ------ | --------------- | ----------------------------------------------- |
| Default Tier             | world  | T2              | Tier preselected on open                        |
| Default Party Size       | world  | 4               | Slider starting value (1–10)                    |
| Default Item Count       | world  | 6               | Slider starting value (1–20)                    |
| Default Rarities         | world  | `uncommon,rare` | Comma-separated rarity ids checked on open      |
| Default Magic Bias       | world  | 0               | Slider starting value (−1 … +1)                 |
| Default Encounter Scale  | world  | 1.0             | Slider starting value (0.4 … 6.0)               |
| Default Generosity       | world  | 1.0             | Slider starting value (0.4 … 2.0)               |
| Result Animations        | client | on              | Cascade-in animation on new rolls               |
| Rarity Glow              | client | on              | Tinted shadow on rare/legendary/artifact cards  |
| Loading Skeleton         | client | on              | Shimmering placeholder during pack load         |
| Keyboard Shortcuts       | client | on              | Enter / R trigger Generate                      |
| Persist Last Result      | client | on              | Remember form + last bundle across window close |
| Pack Cache TTL (minutes) | world  | 5               | How long the compendium index stays cached      |
| Send-to-Chat Mode        | world  | public          | Public / Whisper to GMs / Whisper to players    |

Settings registration uses Foundry's standard `game.settings.register()` API. World-scoped values apply to everyone in the world; client-scoped values are per-user.

Later milestones (claim board, distribute-to-actor, player hub, merchant integration) will be cut as separate releases once the v0.x surface stabilizes.

## Install

This module is in active development. There is no public release manifest yet.

- **Local zip** — `npm run release` builds `release/module.zip` with `module.json` at the zip root, ready for Foundry's _Install Module_ file picker or Forge's Bazaar upload. The script also writes a `.sha256.txt` and short release notes.
- **Dev symlink** — link or copy this folder into your Foundry user data as `Data/modules/infinity-dnd5e/`. Foundry will pick up file changes on reload.

## Tag schema

Items carry `flags["infinity-dnd5e"]` (and legacy `flags["party-operations"]` for back-compat with the source compendium) with:

- `keywords`: array of dotted-path tags. The roller filters by these.
  - `loot.<family>.<subtype>` — e.g. `loot.weapon.magic`, `loot.armor.magic`, `loot.gem`, `loot.art`
  - `rarity.<bucket>` — `common`, `uncommon`, `rare`, `very-rare`, `legendary`, `artifact`
  - `tier.t1` .. `tier.t5` — APL-style power tier
  - `value.v1` .. `value.v5` — gp-value band
  - `merchant.<cat>` — secondary merchant routing tags
  - `folder.path.<...>` — full taxonomy path
- `lootType`: canonical loot bucket string (matches one of the `loot.*` keywords)
- `tier`, `rarityNormalized`, `gpValue`, `valueBand` — fast-access derived fields
- `lootWeight`: probability weight for the roller (`0.0–1.0` typically)
- `maxRecommendedQty`: max copies to drop in one bundle
- `tagSchema`: `"po-loot-v3"` — bumped when the vocabulary changes

The roller never inspects raw item fields; everything routes through this tag layer so the same logic works regardless of upstream system changes.

## Folder layout

```
infinity-dnd5e/
├── module.json
├── README.md
├── package.json           # dev/test only — not shipped
├── .gitignore
├── scripts/
│   ├── module.js          # Foundry entry point, registers tools + hooks
│   ├── dashboard.js       # InfinityDashboardApp — tile grid launcher
│   ├── tool-registry.js   # registerTool/getTools — used by dashboard
│   ├── app.js             # PerEncounterLootApp (ApplicationV2)
│   ├── horde-loot.js      # HordeLootApp (ApplicationV2)
│   ├── per-creature-loot.js  # PerCreatureLootApp (ApplicationV2)
│   ├── loot/
│   │   ├── tag-vocabulary.js   # tag enums + magic-nature classifier
│   │   ├── budget.js           # control values → numeric budget (numeric multipliers + named presets)
│   │   ├── roller.js           # weighted random selection + magic-bias dial
│   │   ├── pack-stats.js       # distribution snapshot over loaded items
│   │   └── horde-budget.js     # mob-size → gp + coin-pile split + denomination breakdown
│   ├── test-*.mjs         # unit tests (run with `npm run check`)
│   ├── test-utils/        # POJO item fixtures + seeded RNG helpers
│   ├── run-checks.mjs     # `npm run check` driver
│   └── build-release.mjs  # `npm run release` — stages + zips for Foundry
├── templates/
│   ├── dashboard.hbs
│   ├── loot-forge.hbs
│   ├── horde-loot.hbs
│   └── per-creature-loot.hbs
├── styles/
│   ├── dashboard.css
│   ├── loot-forge.css
│   ├── horde-loot.css
│   └── per-creature-loot.css
└── packs/
    └── infinity-dnd5e-items.db   # bundled 1,456-item compendium
```

## Adding a tool

1. Build the tool's `ApplicationV2` subclass in `scripts/<your-tool>.js` (mirror `app.js`).
2. Inside `module.js`'s `init` hook, add a `registerTool({ id, title, description, icon, category, status, open })` call. The dashboard picks it up automatically — `status: "coming-soon"` renders a muted tile that toasts a friendly "later release" notification instead of opening.
3. Ship templates under `templates/` and styles under `styles/`, and add both paths to `module.json`.

## Development

```powershell
npm install         # devDeps only (handlebars, prettier)
npm run check       # run every scripts/test-*.mjs in series
npm run format      # prettier — writes
npm run format:check  # prettier — read-only verify (lint substitute for v0.1)
npm run release     # full check + stage + zip → release/module.zip
npm run release:nocheck  # skip tests; for emergency local builds only
```

## Provenance

This module reuses the curated item compendium from [party-operations](../party-operations/) (1,456 items, `po-loot-v3` tag schema, ~3 years of curation). No code from the previous module's UI / runtime layer was carried forward; the v0.1.0 build is a clean rewrite.
