# Infinity D&D5e

Loot, commerce, downtime, party-resource, reputation, and critical-injury tools
for D&D 5e on Foundry VTT.

**GM injury table (next release):** Open **Injuries → Injury table** to browse
all **30 d100 outcomes**, recovery rules, and automation/GM follow-up notes.
The [V3 expansion](docs/INJURY_TABLE_EXPANSION.md) adds 12 temporary injuries
with automatic penalties while preserving permanent-injury odds and saved V2
injuries. The [original audit](docs/INJURY_TABLE_AUDIT.md) still identifies
manual effects and recovery mismatches in the older outcomes.

**Daily supplies (next release):** With Auto-run off, day changes ask the GM
which supplies to use or skip. **Use Daily Supplies** also offers independent
food, water, and light/torch choices. Only checked supplies are consumed and
assessed for shortages. See the [resource guide](docs/RESOURCE_SYSTEM.md).

**Downtime locations (next release):** New blocks offer Adventuring, Wilderness
camp, Village, Town/city, and Custom presets. Select a saved settlement to use
its own editable activity list and linked shops. Activities unavailable at the
location cannot be included. See the [Downtime guide](docs/DOWNTIME_SYSTEM.md).

**Shops organization (next release):** Delete shops directly from the directory,
or select several to move or delete together. **Manage location** renames or
removes a city/location; removal keeps its shops in **Unassigned shops**. Find
locations by name, filter shops by Open/Closed/Empty inventory, and sort by name,
opening status, or item types. See the [Shops guide](docs/MERCHANT_SESSIONS.md).

**v0.3.27 — current-PC injuries and compendium cleanup:** The landing-page
injury picker now follows each non-GM player's assigned character, including
offline players, and excludes spare owned characters and copies. **New injury
roll** explains that Start review queues approval, Send roll prompts the player,
and the completed roll applies and logs the injury. Injury integration status
recognizes Simple Calendar Reborn. The compendium keeps one Greater Healing
Potion at its canonical 150 gp price. All fixes and features through v0.3.26
are retained. See the [injury guide](docs/CRITICAL_INJURIES.md).

**v0.3.26 — live player-hub supplies:** The landing-page Party Supplies button
now uses the same live food and water coverage as the Supplies window. Inventory,
party roster, supply settings, and completed upkeep changes refresh its text;
startup, canvas readiness, and GM authority recovery repair stale labels. This
does not consume supplies, advance time, or enable automatic daily consumption.
Only the authoritative GM writes the uniquely marked label; its layout and tile
action are preserved, and unchanged totals do not create redundant writes.

**v0.3.25 — clearer reusable item art:** The curated compendium now uses
purpose-built icons for Crowbar, Tinderbox, Viol, and Brewer's Supplies. Lance,
Grappling Hook, Climber's Kit, Manacles, and Dimensional Shackles now use
specific existing artwork instead of misleading generic images. Deer Hide and
Scarlet Token retain their already-correct curated artwork.

**v0.3.24 — protected Wizard spellbooks:** Add **Learn Spell — Copy into
Spellbook** to downtime. The GM selects a discovered Wizard spell and its
written/scroll source in the activity editor. Players allocate one-hour blocks,
carry their configured spellbook, and pay copying costs as work progresses.
Completed learning delivers an unprepared, usable Wizard spell and a permanent
campaign receipt. **Wizard Notes** in the character sheet's header controls
provides the log, missing-spell recovery, and GM-only Forget/relink actions.
DDB reimports preserve protected spells; missing ones are reconciled after
import completion by the active GM. This does not add spells to the DDB website.
See [spellbook learning and DDB](docs/WIZARD_SPELLBOOK.md).

**Selectable crafting tools:** In Downtime → Activities → Costs, supplies &
crafting, select the kits a character must carry. Craft Arrows defaults to
Fletcher's Tools, a reusable campaign kit included in the Items compendium and
tool-shop catalog. Missing kits prevent allocation, and inventory is checked
again before costs or rewards are applied. Existing open blocks keep their
original recipes. See the [crafting guide](docs/DOWNTIME_SYSTEM.md).

Ordinary materials can be covered by GP: Craft Arrows keeps its 0.5 gp materials
cost and requires Fletcher's Tools. For activities needing physical supplies,
the optional **Material name** picker offers existing compendium items and a
custom inventory name. Required quantities must be carried and are consumed
when the reviewed work is applied; tools are kept.

**v0.3.23 — live player-hub calendar:** The landing-page Calendar button now
refreshes from Simple Calendar Reborn when the world loads, the canvas becomes
ready, or campaign time changes. Only the authoritative GM persists the public
label, and same-date clock ticks do not create redundant scene updates.

**v0.3.22 — flexible downtime hours:** Players can split each assigned
downtime budget among multiple activities and projects, using the saved hourly
block for each choice. Unallocated hours are forfeited at submission, and every
skill-based allocation records its own player roll for GM review. Existing
campaign libraries migrate to eight-hour work blocks, while Rest & Reflect uses
a one-hour narrative block.

**v0.3.20 — stable merchant editing:** Auto-saving merchant settings no
longer rebuilds the same editor window. Expanded sections, keyboard focus, and
the current scroll position stay in place while adjusting stock generation,
pricing, access, and other merchant controls.

**v0.3.19 — direct city pricing:** Multi-merchant pricing now applies without
the read-only-array crash. The separate **Preview changes** action is gone;
the exact merchant changes update automatically while editing, followed by one
**Apply pricing** action and the existing final confirmation.

**v0.3.18 — directory-first Shops:** Opening or returning to **Shops** now
shows the location and merchant directory without automatically reopening the
first highlighted merchant. Clicking a merchant still opens its focused editor,
and explicit merchant links remain supported.

**v0.3.17 — city-wide pricing:** **City Pricing** can now set shared customer
markups, merchant sell-back ratios, bargaining rules, and charm pricing for
every shop in one location—or any hand-picked merchant group. Every change is
shown automatically before one atomic save, and item-specific price overrides
remain untouched unless the GM explicitly clears them.

**v0.3.16 — simpler shops by location:** Choose a city or location,
then **Open All**, **Close All**, **Restock All**, **Generate All**, or **Clear All
Inventory** for its merchants. Several locations can stay open at once. Village,
town, and city templates include stock, prices, and purchasing gold; custom
shops keep optional player restrictions. Every stock reset restores the merchant
purses too. Existing merchants appear under **Unassigned shops** until moved.
Purchases and sales process automatically, including optional D&D5e Item fields,
partial-stack sales, and safe retries. Settings saves preserve current trading
gold. See the [Shops guide](docs/MERCHANT_SESSIONS.md).

**Quicker injury care:** The injury board now puts character
recovery beside pending rolls, with search, direct character and sheet buttons,
and a separate saved injury log. Manual reviews and detailed rules expand only
when needed. Linked character tokens show a clickable red injury-count badge
to the GM and character owners. Missing Simple Calendar Reborn entries can be
repaired with **Sync injuries**. See the
[injury guide](docs/CRITICAL_INJURIES.md) for visibility and logging details.

**Focused merchant windows:** Click a merchant inside a location to open its
own window with four tabs: **Setup**, **Inventory**, **Access**, and **Advanced**.
Normal setup needs only a name, location, and restock gold amount. Edits save
automatically; Save now retries a failed save. Advanced rules expand only when
needed. Multiple merchant windows can remain open. **City Pricing** opens a
separate reviewed batch tool that can copy buy, sell-back, bargain, and charm
rules to every shop in a location or to a hand-picked set of merchants.

**Campaign Atlas UI preview:** Original map artwork and nine custom emblems give
the GM Workbench, player launcher, and focused windows a shared visual identity.
Compact navigation, readable supply cards, and continuous shop scrolling improve
smaller windows. All art ships with the module; see
[UI artwork and provenance](assets/ui/PROVENANCE.md).

**Campaign downtime benefits:** Reviewed results can now create automatic,
calendar-timed DAE effects for attacks, checks, saves, Armour Class, and walking
speed. Times Up expires them against campaign time; Midi QOL consumes the
sparring bonus after its first attack. Their expiry window begins after the
whole downtime block's expected calendar passage, so resolving reports before
advancing the day does not spend the reward. Tend the Sick can still shorten a
selected timed injury. See the [downtime guide](docs/DOWNTIME_SYSTEM.md).

**Resource-based downtime:** Activities now support GP per
workday, flat fees, required tools, consumed inventory materials, and crafted
items. Arrow and scroll presets include visible costs and progress across
blocks; the GM approves spending and item delivery together. See
[crafting and scribing](docs/DOWNTIME_SYSTEM.md#crafting-scribing-and-resource-costs).

## What This Module Is

A focused rewrite of the Foundry workflows formerly bundled inside `party-operations`. It ships a curated 1,636-item compendium, pre-tagged with rarity, tier, value band, magic type, and folder taxonomy under the `po-loot-v3` schema. Full GMs enter one persistent Infinity Game Master Workbench; players and Assistant GMs receive a separate permission-scoped launcher without widening any player data projection.

Version 0.3.26 targets Foundry VTT 13.351 and retains the v0.3.13 baseline's verified D&D5e 4.4.4 compatibility. The manifest keeps D&D5e 4.0.0 as its minimum for existing worlds; use a D&D5e release that declares Foundry 13 compatibility when creating a new Foundry 13 world. The baseline's installed downtime journeys were also exercised on D&D5e 5.3.3; each release requires its own installed-world acceptance.

Open the primary Infinity interface in either of these ways:

1. Left scene-controls toolbar: the d20 icon labeled **Infinity D&D5e**.
2. Keyboard shortcut: `Shift + I`, rebindable in Foundry's Configure Controls.

Full GMs open directly into the remembered Workbench route. Its chrome moves between Merchants, Quartermaster, Downtime, Factions, and Injuries, and launches the focused Loot Studio and Infinity Settings windows. Players and Assistant GMs see only permission-scoped player destinations. Existing direct player shortcuts remain available.

The former full-GM Home, Session Focus, Continue list, and Campaign Data panel are not part of normal navigation. If private campaign state is fail-closed, the same launcher opens a focused Campaign Recovery window instead of exposing normal campaign tools.

See the [UI quick start](docs/UI_QUICK_START.md) for role-based workflows, keyboard and touch use, settings, and recovery guidance.

If you run the game with multiple GM profiles, give each the **Gamemaster** role
in Foundry's User Management. **Gamemaster** and **Test GM** receive the same
Infinity access when both have that role. An **Assistant Gamemaster** receives
the player launcher; changing a display name does not grant GM access. See
[using two GM profiles](docs/UI_QUICK_START.md#use-two-gm-profiles).

## Status

**v0.3.15 — Injury care and release fixes** - Adds a searchable injury board, saved injury history, clickable token badges, and calendar repair while retaining recorded injuries and the preview fixes. Corrects prerelease ordering and exact-tag verification. On short screens, Factions uses a full-window scroll path so wrapped headers cannot hide the editor or Save button.

**v0.3.14-preview.10 — Existing injury reconciliation** - Adds a guarded read/preview/apply API for recording historical injuries in GM triage and Simple Calendar Reborn. Existing effects and mechanical penalties remain intact; records do not invent rolls or treatment receipts. Existing calendar dates are preserved. See [Critical Injuries](docs/CRITICAL_INJURIES.md).

**v0.3.14-preview.7 — Repeated navigation and budget validation** - Clicking
the current Workbench tool during a save refresh keeps the window open and
allows the next tool switch. Downtime setup rejects fractional or out-of-range
hour budgets rather than rounding them. The installed-world gauntlet covers
repeated leader/read-only navigation, editing handoff, and all eight new
activities; its temporary activity fixtures are restored after the run.
The documented Foundry transport privacy limitation remains unresolved.

**v0.3.14-preview.5 — More player downtime activities** - Adds performing,
training, local contacts, scouting and mapping, medical care, religious service,
animal care, and reflection. Each has three editable GM reports; reflection
needs no roll. Existing libraries offer the additions without overwriting saved
activities or changing an open block. See [the activity list and costs](docs/DOWNTIME_SYSTEM.md).

**v0.3.14-preview.4 — Read-only navigation fix** - A GM window that does
not own editing control can browse merchants and switch Workbench tools without
attempting a save. Its status explains that browsing is available instead of
showing a save failure. Editable windows still stop navigation when a real
save fails. Closing a duplicate GM tab transfers editing control to the remaining
tab. Factions also skips saving an unchanged form when switching tools. Successful
saves can refresh an open window without cancelling merchant selection or tool
navigation. The gauntlet covers these refreshes, read-only navigation, unchanged
factions, and failed editable drafts.

**v0.3.14-preview.3 — Merchant and player recovery gauntlet** - Switching
merchants saves pending edits first and stays on the current merchant if saving
fails. Delayed item lookups and library pickers cannot stock a newly selected
merchant, unavailable items are rejected, and failed lookups can be retried.
Shops and Party Supplies recover from request-send errors without getting stuck
loading. Quick replies clear their timeout before it can erase the result;
shop-entry replies also settle the waiting state correctly. The browser
gauntlet now covers these player recovery screens and merchant selection.

**v0.3.14-preview.2 — Functional gauntlet improvements** - Merchant stock,
filter, preset, and artwork actions stop when pending edits cannot be saved,
leaving those edits available for retry. Delayed delete, clear, restock, and
artwork prompts cannot affect a newly selected merchant. Artwork selection
survives a workspace refresh. Failed Workbench destinations leave the current
window open, repeated route clicks wait for the first save, and returning to a
tool restores its remembered section. A browser gauntlet exercises the real
controllers and templates with isolated campaign storage at three widths.

**v0.3.14-preview.1 — Local UI preview** - Carries the Campaign Atlas UI onto
the v0.3.13 tagged build, retaining its launcher fixes and downtime crafting,
project presets, and individual character resolution. This isolated preview
contains the UI changes from `adf62c5`; separate injury/calendar development on
`codex/simplify-harden-module` remains on that branch. Build locally with
`npm run verify` and inspect `release/module.zip`. The preview has not been
published or installed in a live world. Keep the reviewed v0.3.13 package for
an installation rollback; this UI update does not introduce a data migration.

**v0.3.13 — Custom deployment build** - Adds editable crafting, research, and training project presets with total hours, proportional GP costs, required successful checks, and configurable DCs. Guided blocks now resolve and report each submitted character independently, reopen for late players after every result, and can finish without waiting for characters who never submitted. Durable checkpoints prevent duplicate GP charges, hours, or successes during retry and recovery. This build extends the scoped v0.3.12 deployment and excludes unrelated unreleased work.

**v0.3.12 — Custom deployment build** - Adds resource-based downtime: arrow crafting, scroll scribing from owned spells or scrolls, GP per workday, flat fees, consumed inventory materials, required tools, and custom item recipes. Players and GMs review the same costs; approved work spends resources, delivers usable items, and retains partial progress across blocks. Interrupted writes recover without duplicate spending. Copying an owned scroll remains a GM-approved campaign option. This build extends the scoped v0.3.11 deployment and excludes unrelated unreleased work.

**v0.3.11 — Custom deployment build** - Improves the guided downtime workflow with editable activities, clearer reports, draft preservation, safe retries, per-character receipts, and recovery after interrupted reward saves. Built from published v0.3.10 plus the reviewed downtime changes; separate unreleased calendar changes are excluded. Functional installed-world testing also covers Foundry 13.351 with D&D5e 5.3.3. The existing hidden-state confidentiality limitation is documented in [Downtime System](docs/DOWNTIME_SYSTEM.md).

For a direct Forge installation, open **My Foundry → Summon Import Wizard**, turn off **Install found packages from the Bazaar**, select the reviewed `module.zip`, analyze and import it, then stop/start the game server. This custom upload does not publish a GitHub release; the packaged update links remain the canonical public release channel. Keep the previous v0.3.12 ZIP for rollback. Reinstalling the previous module does not undo GP, materials, items, project hours, or project successes already applied in a completed result.

**v0.3.10 — Released 2026-08-31** - Releases all pending Workbench and Quartermaster improvements: full Gamemasters now enter the persistent Workbench as the primary launcher, recovery remains fail-closed and focused, short layouts keep every control reachable, and custom Quartermaster environments can be previewed before activation and exported or safely imported through a complete versioned validation review.

**v0.3.9 — Released 2026-08-31** - Completes the Landing Page fix for full Gamemasters: Shops now opens the usable Merchant Workspace instead of stopping at the player-only Shops warning. Player clicks keep the existing permission-scoped SocketLib route.

**v0.3.8 — Released 2026-08-31** - Fixes the Landing Page's Infinity-backed Party Supplies, Factions, Downtime, Calendar, and Injuries sections for full Gamemasters, and restores a bounded local Shops response while preserving the existing permission-scoped SocketLib path for players.

**v0.3.7 — Released 2026-08-13** - Introduces the cinematic GM Workbench for Merchants, Quartermaster, Downtime, Factions, and Critical Injuries while preserving existing launchers and authoritative subsystem workflows. It also fixes Critical Injury recipient selection and faction-image persistence, strengthens privileged-route fallbacks and demotion cleanup, and clarifies responsive, accessible recovery states across module surfaces.

**v0.3.6 — Released 2026-08-12** - Guided downtime now has each player click and submit their own character check. The GM reviews the recorded total, chooses or edits the narrative outcome, and then applies each character's approved reward and receipt independently. GMs can also define long-term projects, include them in a block, and track concurrent character work in a durable cumulative ledger. Project progress survives history rotation, compensated work is excluded, and all 18 D&D5e skills are available with correct labels.

**v0.3.5 — Released 2026-08-12** - Fixes short-viewport Merchant Workspace navigation so every merchant row remains reachable in the stacked layout.

**v0.3.4 — Unreleased** - Adds a guided downtime handoff: the GM assigns a location, hours, characters, and applicable activity templates; each player picks one activity; the GM selects and can edit an illustrated result report before applying its configured reward. It also adds the durable Critical Injury triage workspace and a faster changed-surface UI validation path, while preserving the complete release gate.

**v0.3.3 — Released 2026-08-11** - Refines session-facing recovery guidance across player requests, transactions, downtime, party supplies, reputation, and Critical Injury HUD treatment. Loot Studio now names its generation readiness state, while GM workspaces and Settings make their next safe action clearer after loading, no-match, draft, and partial-save states. These clarity improvements preserve gameplay, campaign data, permissions, privacy boundaries, GM authority, settings contracts, and macro behavior.

**v0.3.2 — Released 2026-08-10** - Quartermaster now offers food, water, or both per selected forager; shows separate food and water DCs; ships forest, rainforest, grassland, coast, hills, mountains, swamp, desert, tundra, and riverlands presets; and labels manual consumption **Use Daily Supplies**. Existing worlds receive the missing built-in presets without overwriting custom regions. GMs can also create, copy, order, and safely remove custom regions while shipped presets remain protected. Merchant purchases and sales now use durable client requests and a private authoritative ledger, campaign data has an explicit fail-closed recovery workflow, same-account GM tabs share one campaign-mutation leader, and module sockets use one authenticated router. Home keeps one top Help button and removes the duplicate help panels.

**v0.3.1 — Released 2026-08-09** - Downtime setup now starts with player-owned PCs and adds searchable group, owner, folder, and sort controls for gradually including other characters. Reputation, Merchant, Quartermaster, and Settings section navigation now stays inside the current application window, and Loot preset downloads no longer trigger Foundry's external-link handler.

**v0.3.0 — Released 2026-08-09** - Coordinated UI/UX redesign with role-aware Home, one Loot Studio, grouped settings, shared accessibility foundations, responsive application layouts, and plain-language recovery states. Game rules, stored campaign data, permissions, privacy boundaries, and authoritative-GM behavior remain unchanged.

- One Home and one scene-control launcher for every role, with quick starts, compact recents, shortcuts, integration readiness, and privacy-safe diagnostics.
- Full GMs move between Merchants, Quartermaster, Downtime, Factions, and Injury Triage through one cinematic GM Workbench bar. Each route keeps its established authoritative controller and recovery model; Loot Studio, Settings, player windows, and live shop sessions remain focused standalone windows.
- Privileged loot, merchant, reputation, and GM-preview windows still require a full GM and close if that user is demoted; Assistant GMs use player-scoped Home destinations.
- **Loot Studio**: accessible Encounter, Hoard, and Creature mode tabs in one visible ApplicationV2 window. Each mode retains its own form, result, undo stack, preset tool ID, and history. Existing generation engines and outcomes are unchanged.
- **Per-Encounter Loot**: slider-driven controls for encounter scale, generosity, party size, optional item limit, and magic bias; tier buttons; filter-aware rarity and loot-type chips that disable zero-match choices; live pack-grounded candidate counts; quick-fight presets; locked results; re-roll unlocked; send to chat; drag/drop or send results to actors.
- **Hoard Loot**: a single treasure cache with threat tier, hoard scale, pile bias, coin breakdown, scale-shaped rarity defaults, and filter-aware chips while preserving valid coin-only rolls.
- **Per-Creature Loot**: a roster of defeated creatures, each with its own bundle and reroll action; chip availability names partial coverage across mixed roster tiers.
- Saved loot presets, roll history, and session state restore through bounded current schemas so legacy or damaged values cannot break a loot window.
- **Shops**: Locations with template or custom merchants, automatic buy/sell transactions, per-player access, and bulk stock/purse/open/close controls. Trades preserve durable checkpoints across reconnects and safe retries. See [Shops and Merchant Trading](docs/MERCHANT_SESSIONS.md).
- **Downtime & City Actions**: the GM assigns the same hour budget to each eligible character; players queue several routine, commerce, and crime activities; the GM locks an immutable hidden-roll preview before applying exact receipts. Local Heat and stolen-goods provenance persist by settlement.
- **Quartermaster**: source-aware party food, water, light, and custom-resource tracking with calendar-aware daily consumption, player forage prompts, private Recent Runs receipts, review-before-activation environment choices, and versioned custom-region export/import with a complete validation preview. Players retain a read-only **Party Supplies** outlook.
- **Reputation & Factions**: logged faction standing changes with selective player reveals and a read-only player view.
- **Critical Injuries V3**: recovery from 0 HP or the dead state creates a durable GM triage review. The GM can send a private player d100 roll, dismiss it, or start an exceptional-case review manually; approved results apply Actor effects, roll their duration, schedule recovery, and appear on a body-silhouette HUD with durable Healer's Kit treatment and replay-safe Infection checks after long rests.
- **Spell components**: every leveled spell cast spends one 1-gp component per cast level, including the chosen upcast level. Component Pouch charges are used before loose Spell Components; combined shortages block the cast before its native consumption updates are applied. Cantrips and spell-scroll item uses are exempt.
- **Player launchers**: `Shift + I` opens the Player Launcher, `Shift + D` opens Downtime Activities, `Shift + O` opens available shops, `Shift + Q` opens Party Supplies, `Shift + R` opens revealed faction reputation, and `Shift + J` opens the character's Critical Injuries.
- **Interactive player hubs**: with the reviewed Monk's Active Tiles 13.06 runtime enabled, its action list includes **Open Infinity player window**. The compatibility `home` action opens the Player Launcher; other allowlisted actions can open Party Supplies, Shops, Factions, Downtime, Simple Calendar Reborn, or Critical Injuries only for the player who triggered the tile. They carry no campaign projection and perform no world write.
- **Live player-hub calendar**: the authoritative GM refreshes the Campaign Pulse calendar label from Simple Calendar Reborn at startup, when the canvas becomes ready, and whenever campaign time changes. Same-date clock ticks are read-only, and ambiguous or non-canonical hub layouts fail closed.
- **Accessibility and responsive UI**: application-container layouts, comfortable/compact density, 44px touch targets, visible focus, reduced motion, forced colours, status announcements, and keyboard tab navigation.
- **Art Rolls**: reusable art-object bases can roll unique generated names, summaries, appraised values, and item data without mutating the base compendium item.
- **Publishable release pipeline**: `npm run release` can inject manifest/download URLs from `INFINITY_RELEASE_REPO=owner/repo` or per-field URL overrides.

### Loot Studio migration

The former Per-Encounter, Hoard, and Per-Creature launchers now open the corresponding Loot Studio mode. No preset or history migration is required: the established tool IDs remain the storage keys, and exported preset files keep their existing format. Opening Loot Studio without a mode restores this client's last mode, with Encounter as the fallback.

Macro compatibility is retained:

```js
const api = game.modules.get("infinity-dnd5e").api;
api.openHub(); // Workbench for full GMs; player launcher for other roles.
api.openLootStudio({ mode: "hoard" });
api.openDashboard(); // Existing full-GM alias; now opens the Workbench.
api.openGmWorkbench({ route: "quartermaster", subview: "setup" });
api.openPerEncounterLoot(); // Existing Encounter alias.
api.openHoardLoot(); // Existing Hoard alias.
api.openPerCreatureLoot(); // Existing Creature alias.
api.openMerchantPricing({ locationId: "haven" });
await api.applyMerchantPricingMacro({
  locationId: "haven", // Or use merchantIds: ["merchant-id"]
  patch: { defaultMarkup: 1.2, sellRatio: 0.5 },
});
```

Merchant pricing macros require a full GM and use the same authoritative,
verified merchant-write path as the UI. A settlement targets its currently
linked merchants. Omitted patch fields are preserved, and
`clearItemPriceOverrides: true` must be explicit before shared markup replaces
hand-priced stock.

### Magic Bias

The Per-Encounter window includes a single -100% mundane to +100% magic slider. Each item is classified as `magic`, `mundane`, or `neutral`; the slider applies a per-item weight multiplier and can fully exclude the opposite side at either extreme. Most categories resolve directly from `lootType`. The mixed `loot.consumable` bucket also considers rarity and explicit dnd5e magic signals, so ordinary ammunition, food, rope, lanterns, and similar gear are weighted as mundane while magic consumables remain magic. The classifier lives in [scripts/loot/tag-vocabulary.js](scripts/loot/tag-vocabulary.js).

### Loot Roll Balance and Chances

Every random loot workflow chooses a category first and then an item inside that category, so a large compendium folder cannot dominate merely because it contains more documents. Per-Encounter, Hoard, Per-Creature, and merchant stock each use a distinct percentage profile: encounters follow their threat tier, hoards favor treasure-cache categories, creature drops favor plausible carried goods, and merchants normalize shelf variety while retaining the GM's rarity controls. Repeated categories are reduced within a bundle.

Mixed Per-Encounter and individual Per-Creature bundles can contain at most one spell scroll. Small and standard hoards allow one, while large and massive hoards allow at most two; merchant shelves have no bundle cap. Selecting only the Scroll chip intentionally removes a loot-bundle cap. These rules apply to fresh rolls and single-item rerolls; Per-Creature limits are counted independently for each creature.

Open **Roll Chances** in the Per-Encounter window to see the calculated item-type, rarity, and magic/mundane percentages for the first item of a fresh **Generate** under the current tier, budget, filters, and Magic Bias. Later bundle picks change as the budget fills and the diversity adjustment takes effect.

### Spell Scrolls

Loot rolls use only spell-specific scrolls such as **Spell Scroll: Fireball**. The generic level documents supplied by dnd5e remain in the compendium solely as pricing, rarity, and item-shape templates and are never roll candidates. Each level template's original loot weight is divided among the named spells at that level, so providing hundreds of predetermined spell choices does not make scrolls dominate mixed loot.

### Keyboard

In Loot Studio, Left/Right Arrow moves between mode tabs and Home/End jumps to the first or last mode. In any mode, **Enter** or **R** triggers Generate. Shortcuts are guarded so they do not fire while the cursor is in a text or number input. Tabs, disclosures, item rows, HUD markers, and queue controls retain keyboard alternatives. Press Escape to dismiss dialogs and unpin the Critical Injury HUD card.

### Settings

Open **Infinity Settings** from the Workbench utility buttons or Foundry's Module Settings. Options are grouped under Appearance & Accessibility, Loot Studio, Merchants, Quartermaster, Automation, Audio, Injuries, and Advanced. Players see only client settings; full GMs also see world settings. Raw duplicate entries are hidden after automated parity coverage verifies every existing configurable key remains represented.

The client-scoped `uiPreferences` v2 setting stores only density, last Loot Studio mode, last GM Workbench route, dismissed quick-start versions, and remembered Advanced disclosures. Workbench routing accepts only `merchants`, `quartermaster`, `downtime`, `factions`, or `injuries`; an optional allowlisted subview and sanitized entity ID may deep-link inside that route. The setting is sanitized and does not contain character, user, campaign, permission, merchant, or other private world data.

Registered settings live in [scripts/settings.js](scripts/settings.js).

### Spell components

Enable or disable **Spell Component Consumption** in module settings. When it is enabled, an owned character casting a leveled spell must have component units equal to the level at which the spell is cast. A level 3 cast costs three units (3 gp), while an upcast at level 5 costs five units (5 gp).

The automation recognizes the module's **Component Pouch** as a 25-use source and **Spell Components** as 1-gp loose units. It spends pouch charges first, then loose stacks, even when those source items are nested inside a native dnd5e container. Several sources can cover one cast. If their combined balance is short, the spell is canceled without spending a spell slot or partially consuming components. Cantrips cost zero, and using a spell-scroll Item does not invoke this generic component rule.

### Monk's Active Tiles integration

Infinity registers `infinity-dnd5e.open-player-surface` through Monk's Active
Tiles' `setupTileActions` extension hook. The action is intended for a
player-facing landing Scene and accepts only these stored `surface` values:
`home`, `party-supplies`, `shops`, `reputation`, `downtime`, `calendar`, and
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

When the current full Gamemaster clicks one of these Landing Page controls, the
allowlisted surface opens locally for testing. Shops opens the Merchant Workspace
because the player Shops picker intentionally rejects full Gamemasters; the other
destinations keep their existing local view. That GM-only local path does not enter
SocketLib or weaken the authenticated player-targeting guard.

Installed-world checks can call
`game.modules.get("infinity-dnd5e").api.getPlayerSurfaceStatus()`. It returns
only
`{ ready, transport: "socketlib", handlerRegistered, mattSenderGuardReady, mattVersion }`.
`ready` is true only when SocketLib and the exact MATT 13.06 sender guard are
both registered and active.

### Downtime and city actions

The default guided flow is **Workbench → Downtime → Open block → Open for
players**. Each player splits their assigned hours among the available activity
and project time blocks, then clicks **Roll & submit**. Unallocated hours are
forfeited, and each skill-based allocation makes one character roll. As soon as any character
submits, the GM can click **Review** for that character, choose the outcome,
edit the report, and click **Apply results & send report**. That character gets
the receipt immediately and the same block reopens for everyone still
outstanding. **Finish without waiting** closes the block after at least one
result is resolved and no submitted character is awaiting review. Report edits
save before application, and **Save report** can save them separately. See the
[downtime guide](docs/DOWNTIME_SYSTEM.md) for projects, existing city-action
blocks, and the repeatable `npm run ui:audit:downtime` browser gauntlet.

Existing standard city-action blocks retain their shared productive-hour
budget and multi-activity queues. Player-owned character
Actors are selected by default; group scopes, search, owner and folder filters,
and sorting make it easy to add other characters deliberately. Filters change
only what is shown, so hidden selections remain selected. A settlement is
optional: select one for city-specific markets, crime, fencing, and local Heat,
or name a camp, wilderness, shipboard, roadside, or other location. Crafting
ammunition and sharpening remain available anywhere when their normal
prerequisites are met. Each selected character receives the full budget
independently. Day presets use eight productive hours per day, unused hours are
allowed, and a character can queue several activities before submitting. This
workflow does not advance Foundry's clock or run Quartermaster upkeep.

Players open **Downtime Activities** from scene controls or `Shift + D`. The
window explains unmet prerequisites, shows remaining hours and, when relevant,
local Heat, and supports a reorderable queue. The built-in catalog includes
ammunition crafting, weapon sharpening, market trading, pickpocketing, finite-stock
shoplifting, fencing stolen goods, and laying low. Routine activities repeat in
fixed batches; commerce and crime offer bounded extra time where the rules
allow it.

For a guided downtime block, a player can add multiple available activities or
projects, choose a permitted multiple of each saved hour block, reorder or
remove allocations, and submit any total up to their budget. Their controlled
Actor makes a visible Foundry check for each skill-based allocation; the saved
totals are what the GM reviews before choosing each report and approved reward.

The **Projects** tab provides editable presets for crafting or commissioning,
research, and training. A project defines its total productive hours, total GP
cost, required successful checks, check DC, and applicable skills. GP is charged
proportionally as hours are completed; a check at or above the DC adds one
success. Include the saved project when opening a guided block. Characters can
contribute at different times, and the shared hours and successes update after
each individual result is applied.

For standard city-action blocks, the GM locks submissions and generates a durable,
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

Enable or disable **Critical Injury Table V3** in module settings. When an owned
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

Quartermaster opens on the daily routine: Use Daily Supplies, Forage Drive, current
location, supply outlook, safety warnings, and the latest report. Expand
**Setup & rules** for environment authoring, automation, tracked-resource
definitions, roster and stash routing, or resetting the configuration.
Only the active GM browser tab may change this setup or run upkeep; other
full-GM tabs keep a read-only inspection view.

Roster actors can be marked as daily consumers or inventory-only sources, so a
mule or NPC stash does not consume an extra ration. Quartermaster also warns
about overlapping resource matchers and blocks unsafe inventory writes when a
live item is claimed by more than one resource. The built-in food and water
rules are distinct, including whole-word ration names for food and disposable
day-unit names such as `water ration` for water. Reusable Waterskins are not
spent or multiplied as day-unit inventory. **Use Daily Supplies** consumes one
day of configured resources without foraging or moving the world clock. **Forage
Drive** lets the GM assign food, water, or both separately to every selected
forager, then checks the one Survival roll against the relevant food and water
DCs. Quartermaster accepts only one authority-fenced resource
run at a time. A persisted safety lease reserves an automatic calendar day
before Actor inventory changes.
After a short cross-client stabilization check, an interrupted run is locked for
GM review instead of replaying consumption.

**Recent runs** keeps detailed, read-only receipts for the latest 20 automatic
upkeep, Use Daily Supplies, Forage Drive, and acknowledged interrupted runs. The
history is GM-private and fixed-size; it offers inspection only, with no retry,
replay, rollback, or player-socket projection. An acknowledged interruption is
recorded as an unknown inventory outcome rather than assuming nothing changed.

Campaign-specific regions can be created directly in Quartermaster. Choose
**New custom** for a fresh baseline, or activate the closest existing environment
and choose **Copy as custom**. Choosing a different active environment first
shows its forage availability, food and water DCs, and yields; the selection is
rechecked after confirmation. Custom regions can be renamed, ordered relative
to one another, and removed after confirmation. Removing the active custom
region activates the next catalog entry, or the nearest previous entry when it
was last. Edit forage availability, separate food and water Survival DCs, and
food/water yield formulas. Built-in scarcity tiers remain available alongside
forest, rainforest, grassland, coast, hills, mountains, swamp, desert, tundra,
and riverlands presets. Built-ins remain unchanged, custom IDs are
collision-safe, and new yield formulas are validated and bounded before they
are saved. **Export custom** downloads only the portable region rules. **Import
custom** validates the entire versioned file and previews every add, update, and
unchanged entry before one catalog save; it never changes the active environment
or imports roster, supply, rule, or run-history data.

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
npm run ui:audit:a11y
npm run ui:audit:keyboard
npm run verify
```

Live generation uses the installed Codex image CLI at `C:\Users\Kyle\.codex\skills\.system\imagegen\scripts\image_gen.py` with `gpt-image-2`, `quality=high`, `size=1024x1024`, `output_format=webp`, and `background=opaque`. `OPENAI_API_KEY` must be set before the live generation commands. If a batch partially fails, run `npm run art:jobs:missing` and rerun the matching generation command.

`npm run ui:harness` writes a static Foundry-window preview to `tmp/playwright/ui-harness.html`. `npm run ui:audit` checks every fixture at independent 1040, 720, 520, and 380px application widths across comfortable and compact density, coarse pointers, short heights, reduced motion, forced colours, and 200% zoom. `npm run ui:audit:changed` selects only the fixtures and risk viewports touched since the previous commit; shared UI foundations deliberately use the full audit. `npm run ui:audit:a11y` isolates each fixture and fails on serious Axe findings plus duplicate IDs, unnamed controls, broken labels, invalid tabs, inaccessible live states, and AA contrast. `npm run ui:audit:keyboard` scripts Tab and Shift+Tab focus order, Enter and Space activation, arrow-key/Home/End tabs, safe dialog focus restoration, Escape dismissal, and keyboard queue reordering. `npm run verify:source:fast` runs formatting, deterministic checks, and the changed UI audit. `npm run verify:source` remains the full UI, accessibility, and keyboard gate; `npm run verify:release-source` also requires an exact release-version tag. `npm run verify` adds release construction and verifies the actual ZIP root, manifest references, release URLs, and SHA-256; `npm run release` invokes that same strict complete gate and build.

Layout audits keep each run's HTML, screenshots, and summary in its own
`tmp/playwright/ui-layout-*` directory. Parallel runs cannot overwrite each
other's input, and an empty, incomplete, or duplicated window inventory fails
the audit before any click checks run. The standalone `ui:harness` preview keeps
its existing fixed path.

`npm run ui:audit:workbench` exercises merchant save failure and retry, preserved
drafts, merchant selection, stock-filter copying, stale confirmations, failed
route startup, and repeated navigation at 1040, 720, and 380px. Player journeys
also cover Shops and Party Supplies send failures, quick replies, refresh
recovery, shop-entry retries, and disabled pending controls. It uses the real controllers,
templates, and local artwork with in-memory campaign storage; it does not
connect to a Foundry world. Evidence is saved in a unique
`output/playwright/workbench-journey-*` directory. Both source verification
gates include this journey alongside the downtime gauntlet.

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

For the GitHub Releases workflow:

1. Read the source version and tag the commit (`$version = (Get-Content package.json | ConvertFrom-Json).version; git tag "v$version"; git push origin "refs/tags/v$version"`).
2. The tag workflow runs the complete source gate from a clean checkout and requires the tag, `module.json`, `package.json`, and both lockfile version fields to agree exactly.
3. It builds and independently inspects `module.zip`, verifies the ZIP-root manifest and every declared runtime reference, and confirms `module.zip.sha256.txt` against the archive bytes.
4. It creates or updates a **draft** GitHub Release and uploads `module.zip`, `module.json`, and the SHA-256 file. The workflow never publishes a release automatically.
5. Review the draft, complete the installed-world smoke check, and then publish it manually. The packaged `manifest` URL points at `releases/latest/download/module.json`, so Foundry's auto-updater sees it only after publication.

Ordinary branch and pull-request CI runs `npm run verify:source:fast`, selecting only the changed UI fixtures and risk viewports, then uses a separate clean checkout to build and inspect the same release artifact. The full UI, accessibility, and keyboard gate runs on release tags and in the weekday/manual **full UI gate** workflow. Packaging must not modify tracked source files.

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
