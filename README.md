# Infinity D&D5e

Loot, commerce, downtime, party-resource, reputation, and critical-injury tools
for D&D 5e on Foundry VTT.

## What This Module Is

A focused rewrite of the Foundry workflows formerly bundled inside `party-operations`. It ships a curated 1,636-item compendium, pre-tagged with rarity, tier, value band, magic type, and folder taxonomy under the `po-loot-v3` schema. The GM dashboard launches seven dedicated tools, while players receive permission-scoped shops, downtime, reputation, party-supplies, forage, and Critical Injury Table V2 workflows.

Three ways to open the dashboard:

1. Left scene-controls toolbar: the d20 icon labeled **Infinity D&D5e**.
2. Token Controls fallback: a second d20 icon for GMs who look there first.
3. Keyboard shortcut: `Shift + I`, rebindable in Foundry's Configure Controls.

## Status

**v0.2.71 (unreleased)** - Hardens downtime planning, handoff recovery, item writes, and player-safe results, and adds authenticated player-hub launchers.

- GM dashboard with seven dedicated tools and scene-control launchers.
- Privileged dashboard, loot, merchant, reputation, and GM-preview windows require a full GM and close if that user is demoted; Assistant GMs use the player-scoped launchers.
- **Per-Encounter Loot**: slider-driven controls for encounter scale, generosity, party size, optional item limit, and magic bias; tier buttons; filter-aware rarity and loot-type chips that disable zero-match choices; live pack-grounded candidate counts; quick-fight presets; locked results; re-roll unlocked; send to chat; drag/drop or send results to actors.
- **Hoard Loot**: a single treasure cache with threat tier, hoard scale, pile bias, coin breakdown, scale-shaped rarity defaults, and filter-aware chips while preserving valid coin-only rolls.
- **Per-Creature Loot**: a roster of defeated creatures, each with its own bundle and reroll action; chip availability names partial coverage across mixed roster tiers.
- Saved loot presets, roll history, and session state restore through bounded current schemas so legacy or damaged values cannot break a loot window.
- **Merchant Workspace**: GM-curated inventories, markup, bargain checks, player access, self-service shops, and authoritative buy/sell transactions with canonical item, wallet, and merchant read-back, verified compensation, and request-bound replay protection.
- **Downtime & City Actions**: the GM assigns the same hour budget to each eligible character; players queue several routine, commerce, and crime activities; the GM locks an immutable hidden-roll preview before applying exact receipts. Local Heat and stolen-goods provenance persist by settlement.
- **Quartermaster**: source-aware party food, water, light, and custom-resource tracking with calendar-aware daily consumption, player forage prompts, and a read-only player **Party Supplies** outlook.
- **Reputation & Factions**: logged faction standing changes with selective player reveals and a read-only player view.
- **Critical Injuries V2**: when a PC gets up from 0 HP or the dead state, the GM approves or declines a player-triggered, GM-authoritative d100 roll; approved results apply Actor effects, roll their duration, schedule recovery, and appear on a body-silhouette HUD with durable Healer's Kit treatment and replay-safe Infection checks after long rests.
- **Player launchers**: `Shift + D` opens Downtime Activities, `Shift + O` opens available shops, `Shift + Q` opens Party Supplies, `Shift + R` opens revealed faction reputation, and `Shift + J` opens the character's Critical Injuries.
- **Interactive player hubs**: with the reviewed Monk's Active Tiles 13.06 runtime enabled, its action list includes **Open Infinity player window**. The action can open Party Supplies, Shops, Factions, Downtime, Simple Calendar Reborn, or Critical Injuries only for the player who triggered the tile; it carries no campaign projection and performs no world write.
- **Art Rolls**: reusable art-object bases can roll unique generated names, summaries, appraised values, and item data without mutating the base compendium item.
- **Publishable release pipeline**: `npm run release` can inject manifest/download URLs from `INFINITY_RELEASE_REPO=owner/repo` or per-field URL overrides.

### Magic Bias

The Per-Encounter window includes a single -100% mundane to +100% magic slider. Each item is classified as `magic`, `mundane`, or `neutral`; the slider applies a per-item weight multiplier and can fully exclude the opposite side at either extreme. Most categories resolve directly from `lootType`. The mixed `loot.consumable` bucket also considers rarity and explicit dnd5e magic signals, so ordinary ammunition, food, rope, lanterns, and similar gear are weighted as mundane while magic consumables remain magic. The classifier lives in [scripts/loot/tag-vocabulary.js](scripts/loot/tag-vocabulary.js).

### Loot Roll Balance and Chances

Every random loot workflow chooses a category first and then an item inside that category, so a large compendium folder cannot dominate merely because it contains more documents. Per-Encounter, Hoard, Per-Creature, and merchant stock each use a distinct percentage profile: encounters follow their threat tier, hoards favor treasure-cache categories, creature drops favor plausible carried goods, and merchants normalize shelf variety while retaining the GM's rarity controls. Repeated categories are reduced within a bundle.

Mixed Per-Encounter and individual Per-Creature bundles can contain at most one spell scroll. Small and standard hoards allow one, while large and massive hoards allow at most two; merchant shelves have no bundle cap. Selecting only the Scroll chip intentionally removes a loot-bundle cap. These rules apply to fresh rolls and single-item rerolls; Per-Creature limits are counted independently for each creature.

Open **Roll Chances** in the Per-Encounter window to see the calculated item-type, rarity, and magic/mundane percentages for the first item of a fresh **Generate** under the current tier, budget, filters, and Magic Bias. Later bundle picks change as the budget fills and the diversity adjustment takes effect.

### Spell Scrolls

Loot rolls use only spell-specific scrolls such as **Spell Scroll: Fireball**. The generic level documents supplied by dnd5e remain in the compendium solely as pricing, rarity, and item-shape templates and are never roll candidates. Each level template's original loot weight is divided among the named spells at that level, so providing hundreds of predetermined spell choices does not make scrolls dominate mixed loot.

### Keyboard

Inside the Per-Encounter window, **Enter** or **R** triggers Generate. Shortcuts are guarded so they do not fire while the cursor is in a text or number input. Toggleable in settings.

### Settings

Every default the loot tools ship with is editable from Foundry's Game Settings -> Configure Settings -> Module Settings -> Infinity D&D5e. The dashboard footer has a **Configure Defaults** button that opens the same settings surface.

Registered settings live in [scripts/settings.js](scripts/settings.js).

### Monk's Active Tiles integration

Infinity registers `infinity-dnd5e.open-player-surface` through Monk's Active
Tiles' `setupTileActions` extension hook. The action is intended for a
player-facing landing Scene and accepts only these stored `surface` values:
`party-supplies`, `shops`, `reputation`, `downtime`, `calendar`, and
`critical-injuries`.

The player-hub path is intentionally pinned to Monk's Active Tiles 13.06. During
`setupTileActions`, before MATT registers its ready-phase socket listener,
Infinity installs an idempotent sender guard for all eleven canonical hub
controls. The guard replaces MATT's client-claimed trigger identity with
Foundry's authenticated transport sender and rejects missing, inactive,
full-Gamemaster, non-click, unresolved, or malformed hub triggers. Non-hub MATT
messages retain their normal behavior.

The authoritative GM then routes Infinity window requests to that exact active
player through the required SocketLib 1.1.4+ transport. The recipient rechecks
SocketLib's authenticated GM sender and exact target, then opens the same
permission-scoped Infinity window available from its normal toolbar or
keybinding. The socket message contains only the fixed surface key and user IDs;
purchases, downtime submissions, resource changes, and other writes remain
inside their existing guarded workflows. Calendar uses Simple Calendar
Reborn's public `showCalendar()` API. An active legacy Simple Calendar
installation is supported as a fallback, while inactive packages are ignored;
the launcher fails closed when neither active module exposes the API.

Installed-world checks can call
`game.modules.get("infinity-dnd5e").api.getPlayerSurfaceStatus()`. It returns
only
`{ ready, transport: "socketlib", handlerRegistered, mattSenderGuardReady, mattVersion }`.
`ready` is true only when SocketLib and the exact MATT 13.06 sender guard are
both registered and active.

### Downtime and city actions

The full GM opens **Downtime Workspace** from the dashboard. Create or select a
settlement, choose eligible characters, and assign a shared productive-hour
budget. Each selected character receives that full budget independently. Day
presets use eight productive hours per day, unused hours are allowed, and a
character can queue several activities before submitting. This workflow does
not advance Foundry's clock or run Quartermaster upkeep.

Players open **Downtime Activities** from scene controls or `Shift + D`. The
window explains unmet prerequisites, shows remaining hours and local Heat, and
supports a reorderable queue. The built-in catalog includes ammunition
crafting, weapon sharpening, market trading, pickpocketing, finite-stock
shoplifting, fencing stolen goods, and laying low. Routine activities repeat in
fixed batches; commerce and crime offer bounded extra time where the rules
allow it.

When submissions are ready, the GM locks the block and generates a durable,
immutable preview. All hidden checks, DCs, consequences, rewards, operation
IDs, and projected writes are persisted before anything changes. Apply uses
that exact plan, continues independent characters if one character's state has
drifted, and exposes recovery instead of guessing whether an uncertain write
succeeded. Players receive only their own safe receipt; hidden settlement
security, other queues, unrevealed factions, and merchant internals remain
private.

The full GM may cancel while a block is collecting, locked, or awaiting
application. Once application starts, cancellation closes and the saved
recovery flow takes over.

Sharpening grants +1 damage—not attack—for the next three eligible damage rolls
or until the next long rest. Stolen goods keep settlement and source
provenance, remain separate from clean stacks, and cannot be sold through an
ordinary merchant; they must be fenced during downtime. See
[docs/DOWNTIME_SYSTEM.md](docs/DOWNTIME_SYSTEM.md) for the complete activity
rules, settlement setup, Heat behavior, recovery model, and automation
boundaries.

### Critical injuries

Enable or disable **Critical Injury Table V2** in module settings. When an owned
player character recovers from 0 HP or a dead/unconscious state, the active full
GM gets a Yes/No approval prompt. Approval pushes a d100 button to the assigned
or owning player. Clicking it sends an authenticated request only to the active
GM. The GM verifies the restricted approval record, rolls and persists the d100,
injury detail, and exact V2 recovery formula, then applies the Actor effect,
whispers the result, and creates a Simple Calendar recovery interval when that
module is active. Safe retries reuse the same stored dice and completed result;
a redundant private checkpoint, server-clock application lease claimed before
the first die, deterministic effect ID, and discoverable calendar marker protect
those receipts and external changes during an active-GM handoff. The active GM
can roll any approved result as a fallback. Invalid legacy buttons are cleared
with a GM warning, and failed or duplicate roll requests return an immediate
status to the requester instead of silently timing out.

The player window lists every active injury and can request rules-based
Healer's Kit treatment. The GM chooses the healer, sees the inventory charges
that will be consumed, and resolves any Medicine, Insight, or Constitution
check. Treatment requests are sent only to the active GM and carry no chosen
healer, roll, inventory plan, or outcome. Before changing an Item, Active
Effect, or calendar entry, the GM persists the exact treatment plan in the
restricted recovery record. A reconnect, timeout, or active-GM handoff then
resumes that plan instead of rolling again or spending another kit charge.
Exact character penalties use core Active Effects and Midi-QOL flags;
conditional narrative restrictions stay in the effect description for GM
adjudication. See [docs/CRITICAL_INJURIES.md](docs/CRITICAL_INJURIES.md) for the
full d100 table, treatment behavior, integration details, and automation
boundaries.

When the assigned or directly owned character has an active injury, a compact
translucent body silhouette appears automatically on that player's screen.
Wound markers follow the stored body-part detail when the table rolled one and
use honest multi-limb or whole-body fallbacks when the rules did not record a
side. Hovering or keyboard-focusing a marker previews the wound; clicking or
tapping pins its details and offers the same authoritative Healer's Kit action
as the full window. Players can disable **Critical Injury Body HUD** in their
client settings without disabling injury automation.

### Party resources

GMs configure resources, the tracked roster, draw sources, a shared stash,
environment, and automation in **Quartermaster**. Players can open **Party
Supplies** from scene controls or `Shift + Q`; the active GM sends a sanitized
snapshot without item-matching rules or raw actor inventory details.

Roster actors can be marked as daily consumers or inventory-only sources, so a
mule or NPC stash does not consume an extra ration. Quartermaster also warns
about overlapping resource matchers and blocks unsafe inventory writes when a
live item is claimed by more than one resource. The built-in food and water
rules are distinct, including whole-word ration names for food and disposable
day-unit names such as `water ration` for water. Reusable Waterskins are not
spent or multiplied as day-unit inventory. Advance Day and Forage Drive accept
only one prompt and one authority-fenced resource run at a time. A persisted
safety lease reserves an automatic calendar day before Actor inventory changes.
After a short cross-client stabilization check, an interrupted run is locked for
GM review instead of replaying consumption.

Campaign-specific regions can be created directly in Quartermaster: select the
closest built-in environment, choose **Copy as custom**, then edit its name,
forage availability, Survival DC, and food/water yield formulas. Built-in
presets remain unchanged, custom IDs are collision-safe, and new yield formulas
are validated and bounded before they are saved.

The complete current-state map, data ownership rules, automation contract,
test matrix, and phased hardening plan live in
[docs/RESOURCE_SYSTEM.md](docs/RESOURCE_SYSTEM.md).

### Custom Item Art

The generated-art queue lives in [assets/item-art-plan.json](assets/item-art-plan.json). Existing compendium icons are protected by default. The plan can explicitly opt a bounded shared-impact batch into replacement; all other source icons remain untouched. Missing-source items keep bespoke assignments. Use `art:restore` to put pack item images back on their source compendium icons, and `art:absent` to list items whose fallback art is still a placeholder.

```powershell
npm run art:restore
npm run art:absent
npm run plan:images
npm run art:jobs
npm run art:generate:shared:dry
npm run art:generate:unique:dry
npm run art:generate:shared
npm run art:generate:unique
npm run art:validate
npm run art:validate:present
npm run art:apply
npm run art:apply:present
npm run check
npm run ui:audit
```

Live generation uses the installed Codex image CLI at `C:\Users\Kyle\.codex\skills\.system\imagegen\scripts\image_gen.py` with `gpt-image-2`, `quality=high`, `size=1024x1024`, `output_format=webp`, and `background=opaque`. `OPENAI_API_KEY` must be set before the live generation commands. If a batch partially fails, run `npm run art:jobs:missing` and rerun the matching generation command.

`npm run ui:harness` writes a static Foundry-window preview to `tmp/playwright/ui-harness.html`. `npm run ui:audit` renders every GM and player window at desktop, tablet, narrow, and phone widths, checks action wiring and row opening, and reports horizontal overflow or unreachable controls.

### Compendium pack

Foundry v11+ reads compendium packs from LevelDB **directories**, not the legacy NeDB single-file `.db`. Shipping a `.db` relies on Foundry's migrate-on-load path, which regressed on v12 ([foundryvtt#10681](https://github.com/foundryvtt/foundryvtt/issues/10681)) and is fragile on Forge — the symptom is an empty/flaky loot pool even though the tools open fine.

The editable source of truth stays the NeDB file at `packs/infinity-dnd5e-items.db` (the dev/test tooling reads it line-by-line). It is compiled into the shipped LevelDB directory `packs/infinity-dnd5e-items/` that `module.json` points at:

```powershell
npm run compile:packs
```

`npm run release` runs this automatically before staging. The generated LevelDB directory is a build artifact (gitignored — its internal file names churn on every compile), so after a fresh clone run `npm run compile:packs` once before loading the module in Foundry.

## Install

This module is in active development. The latest published build can be installed with:

```text
https://github.com/Heliosiv/Infinity-D-D5e/releases/latest/download/module.json
```

- **Local zip**: `npm run release` builds `release/module.zip` with `module.json` at the zip root, ready for Foundry's Install Module file picker or Forge Bazaar upload. The script also writes `release/module.json`, `release/module.zip.sha256.txt`, and short release notes.
- **Dev symlink**: link or copy this folder into your Foundry user data as `Data/modules/infinity-dnd5e/`. Run `npm run compile:packs` first so the LevelDB pack exists. Foundry will pick up file changes on reload.

### Publishing a release

`npm run release` produces `release/module.zip` from the current tree. To publish a build that Foundry / Forge can auto-update from, set one of the URL env vars before running release:

```powershell
# Shortcut: GitHub Releases convention.
# Derives `manifest` (stable) + `download` (versioned) + `url` (homepage).
$env:INFINITY_RELEASE_REPO = "Heliosiv/Infinity-D-D5e"
npm run release

# Fine-grained overrides (any combination):
$env:INFINITY_RELEASE_URL          = "https://example.com/infinity-dnd5e"
$env:INFINITY_RELEASE_MANIFEST_URL = "https://example.com/.../module.json"
$env:INFINITY_RELEASE_DOWNLOAD_URL = "https://example.com/.../v{version}/module.zip"
npm run release
```

`{version}` in `INFINITY_RELEASE_DOWNLOAD_URL` is substituted at build time. The source `module.json` is never modified; injection happens only on the staged copy that goes into `release/module.zip` and `release/module.json`.

For a GitHub-Releases workflow:

1. Tag the commit (`git tag v0.2.71 && git push origin refs/tags/v0.2.71`).
2. Run `npm run release` with `INFINITY_RELEASE_REPO` set.
3. Create a GitHub Release named `v0.2.71` and upload `release/module.zip`, `release/module.json`, and `release/module.zip.sha256.txt` as assets.
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
    merchant-workspace.js
    merchant-session.js
    resource-manager.js
    reputation-workspace.js
    reputation-view.js
    settings.js
    compat/
    injury/
    loot/
      tag-vocabulary.js
    merchant/
    reputation/
    resource/
    test-utils/
    test-*.mjs
    run-checks.mjs
    build-release.mjs
  templates/
    *.hbs
  styles/
    *.css
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

On Windows, npm lifecycle commands can misparse a checkout path containing `&`.
If a clean install fails from this folder, use an unused temporary drive letter:

```powershell
subst R: "$PWD"
Push-Location R:\
npm ci
Pop-Location
subst R: /d
```

## Provenance

This module reuses the curated item compendium from [party-operations](../party-operations/) with the `po-loot-v3` tag schema and several years of curation. The v0.x runtime and UI are a clean rewrite.
