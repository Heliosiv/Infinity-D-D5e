# Infinity D&D5e

Tag-driven loot generator for D&D 5e on Foundry VTT.

## What this module is

A focused, ground-up rewrite of the loot generation tooling formerly bundled inside `party-operations`. Ships a curated 1,456-item compendium (every item pre-tagged with rarity, tier, value band, magic-type, and folder taxonomy under the `po-loot-v3` schema) plus a small GM window that rolls loot tables against those tags.

## Status

**v0.2.0** — Generate + Display + Distribute + Announce.

- GM-only window — opens via the coin button in the Tokens toolbar, the global keybinding `Ctrl+Shift+L`, or `game.modules.get("infinity-dnd5e").api.openLootForge()`
- Budget, rarity, tier, count controls — filter state persists across reopen
- Roll a single loot table at a time
- Results show name, image, rarity, gp value, source
- **Distribute:** drag a result tile onto a character sheet, click the per-row "Send" button, or use the "Distribute Bundle" header button to push the whole roll onto one actor
- **Announce in chat:** toggle on the form posts each bundle as a styled chat card with clickable `@UUID[]` item links
- **Macro API:** `game.modules.get("infinity-dnd5e").api` exposes `openLootForge()`, `rollLootBundle({...})`, `distributeBundle(actorId, uuids)`, `promptDistribute(uuids, opts)`
- **Publishable release pipeline:** `npm run release` with `INFINITY_RELEASE_REPO=owner/repo` (or per-field URL overrides) produces a manifest Foundry / Forge can auto-update from
- No claim board, no player UI, no merchant flow (yet)

Later milestones (claim board, player hub, merchant integration) will be cut as separate releases once the v0.2 surface stabilizes.

### Macro examples

```js
// One-liner roll + post to chat
const api = game.modules.get("infinity-dnd5e").api;
const bundle = await api.rollLootBundle({ tier: "t3", count: 8, rarities: ["rare", "very-rare"] });
ChatMessage.create({ content: `Rolled ${bundle.items.length} items — ${bundle.totalGp} gp` });

// Roll, then ask which PC gets the loot
const bundle = await api.rollLootBundle({ tier: "t2" });
await api.promptDistribute(bundle.items.map(e => e.uuid));
```

## Install

This module is in active development. There is no public release manifest yet — install from a local zip or symlink the folder into your Foundry `Data/modules/infinity-dnd5e/` while developing.

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

1. Tag the commit (`git tag v0.2.0 && git push --tags`).
2. Run `npm run release` with `INFINITY_RELEASE_REPO` set.
3. Create a GitHub Release named `v0.2.0` and upload both `release/module.zip` and `release/module.json` as assets.
4. The `manifest` URL points at `releases/latest/download/module.json`, so Foundry's auto-updater picks up future releases automatically.

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
├── packs/
│   └── infinity-dnd5e-items.db
├── scripts/
│   ├── module.js          # Foundry entry point
│   ├── app.js             # LootForgeApp (ApplicationV2)
│   ├── loot/
│   │   ├── tag-vocabulary.js   # tag enums + helpers
│   │   ├── budget.js           # control values → numeric budget
│   │   └── roller.js           # weighted random selection
│   └── test-utils/        # test helpers (jsdom-style)
├── templates/
│   └── loot-forge.hbs
├── styles/
│   └── loot-forge.css
└── scripts/test-*.mjs     # unit tests (run with npm test)
```

## Development

```powershell
npm install        # devDeps only (handlebars, prettier)
npm run check      # run all *.mjs tests
npm run lint       # not configured yet in v0.1
npm run format     # prettier
```

## Provenance

This module reuses the curated item compendium from [party-operations](../party-operations/) (1,456 items, `po-loot-v3` tag schema, ~3 years of curation). No code from the previous module's UI / runtime layer was carried forward; the v0.1.0 build is a clean rewrite.
