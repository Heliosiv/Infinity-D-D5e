# Infinity D&D5e

Tag-driven GM tools for D&D 5e on Foundry VTT, surfaced through a single dashboard.

## What This Module Is

A focused, ground-up rewrite of the GM tooling formerly bundled inside `party-operations`. It ships a curated 1,424-item compendium, pre-tagged with rarity, tier, value band, magic type, and folder taxonomy under the `po-loot-v3` schema. The GM dashboard launches each tool in its own window and new tools can be registered with `registerTool(...)`.

Three ways to open the dashboard:

1. Left scene-controls toolbar: the d20 icon labeled **Infinity D&D5e**.
2. Token Controls fallback: a second d20 icon for GMs who look there first.
3. Keyboard shortcut: `Shift + I`, rebindable in Foundry's Configure Controls.

## Status

**v0.2.4** - Dashboard, Per-Encounter Loot, Hoard Loot, Per-Creature Loot, settings, obvious launchers, and art-object variant rolls.

- GM-only dashboard with a tile grid of tools.
- **Per-Encounter Loot**: slider-driven controls for encounter scale, generosity, party size, item count, and magic bias; tier buttons; rarity and loot-type chips; live pack-grounded candidate counts; quick-fight presets; locked results; re-roll unlocked; send to chat.
- **Hoard Loot**: a single treasure cache with threat tier, hoard scale, pile bias, coin breakdown, and scale-shaped rarity defaults.
- **Per-Creature Loot**: a roster of defeated creatures, each with its own bundle and reroll action.
- **Art Rolls**: reusable art-object bases can roll unique generated names, summaries, appraised values, and item data without mutating the base compendium item.
- No claim board, player UI, or merchant flow yet.

### Magic Bias

The Per-Encounter window includes a single -100% mundane to +100% magic slider. Each item is classified by its `lootType` as `magic`, `mundane`, or `neutral`; the slider applies a per-item weight multiplier and can fully exclude the opposite side at either extreme. The classifier lives in [scripts/loot/tag-vocabulary.js](scripts/loot/tag-vocabulary.js).

### Keyboard

Inside the Per-Encounter window, **Enter** or **R** triggers Generate. Shortcuts are guarded so they do not fire while the cursor is in a text or number input. Toggleable in settings.

### Settings

Every default the loot tools ship with is editable from Foundry's Game Settings -> Configure Settings -> Module Settings -> Infinity D&D5e. The dashboard footer has a **Configure Defaults** button that opens the same settings surface.

Registered settings live in [scripts/settings.js](scripts/settings.js).

## Install

This module is in active development. There is no public release manifest yet.

- **Local zip**: `npm run release` builds `release/module.zip` with `module.json` at the zip root, ready for Foundry's Install Module file picker or Forge Bazaar upload. The script also writes `release/module.json`, `release/module.zip.sha256.txt`, and short release notes.
- **Dev symlink**: link or copy this folder into your Foundry user data as `Data/modules/infinity-dnd5e/`. Foundry will pick up file changes on reload.

### Publishing a release

`npm run release` produces `release/module.zip` from the current tree. To publish a build that Foundry / Forge can auto-update from, set one of the URL env vars before running release:

```powershell
# Shortcut: GitHub Releases convention.
# Derives `manifest` (stable) + `download` (versioned) + `url` (homepage).
$env:INFINITY_RELEASE_REPO = "OWNER/infinity-dnd5e"
npm run release

# Fine-grained overrides (any combination):
$env:INFINITY_RELEASE_URL          = "https://example.com/infinity-dnd5e"
$env:INFINITY_RELEASE_MANIFEST_URL = "https://example.com/.../module.json"
$env:INFINITY_RELEASE_DOWNLOAD_URL = "https://example.com/.../v{version}/module.zip"
npm run release
```

`{version}` in `INFINITY_RELEASE_DOWNLOAD_URL` is substituted at build time. The source `module.json` is never modified; injection happens only on the staged copy that goes into `release/module.zip` and `release/module.json`.

For a GitHub-Releases workflow:

1. Tag the commit (`git tag v0.2.4 && git push --tags`).
2. Run `npm run release` with `INFINITY_RELEASE_REPO` set.
3. Create a GitHub Release named `v0.2.4` and upload both `release/module.zip` and `release/module.json` as assets.
4. The `manifest` URL points at `releases/latest/download/module.json`, so Foundry's auto-updater picks up future releases automatically.

## Tag Schema

Items carry `flags["infinity-dnd5e"]` and legacy `flags["party-operations"]` for back-compat with the source compendium.

- `keywords`: dotted-path tags used by the roller.
- `lootType`: canonical loot bucket string.
- `tier`, `rarityNormalized`, `gpValue`, `valueBand`: fast-access derived fields.
- `lootWeight`: probability weight for the roller.
- `maxRecommendedQty`: max copies to drop in one bundle.
- `tagSchema`: `"po-loot-v3"`.

The roller routes through this tag layer instead of inspecting raw upstream fields directly.

## Folder Layout

```text
infinity-dnd5e/
  module.json
  README.md
  package.json
  assets/
    item-art-plan.*
  scripts/
    module.js
    dashboard.js
    tool-registry.js
    app.js
    hoard-loot.js
    per-creature-loot.js
    settings.js
    loot/
      tag-vocabulary.js
      budget.js
      roller.js
      art-variants.js
      pack-stats.js
      hoard-budget.js
    test-*.mjs
    run-checks.mjs
    build-release.mjs
  templates/
    dashboard.hbs
    loot-forge.hbs
    hoard-loot.hbs
    per-creature-loot.hbs
  styles/
    dashboard.css
    loot-forge.css
    hoard-loot.css
    per-creature-loot.css
  packs/
    infinity-dnd5e-items.db
```

## Adding a Tool

1. Build the tool's `ApplicationV2` subclass in `scripts/<your-tool>.js`.
2. In `module.js`'s `init` hook, add a `registerTool({ id, title, description, icon, category, status, open })` call.
3. Ship templates under `templates/` and styles under `styles/`, then add both paths to `module.json`.

## Development

```powershell
npm install
npm run check
npm run format
npm run format:check
npm run release
npm run release:nocheck
```

## Provenance

This module reuses the curated item compendium from [party-operations](../party-operations/) with the `po-loot-v3` tag schema and several years of curation. The v0.x runtime and UI are a clean rewrite.
