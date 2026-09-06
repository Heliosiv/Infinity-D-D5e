# Infinity D&D5e UI Quick Start

This guide covers the v0.3.14-preview.3 source interface. The preview retains the established game rules, permissions, campaign records, and authoritative-GM workflow.

## Open the primary launcher

- Select the single **Infinity D&D5e** d20 category in scene controls.
- Or press `Shift+I` from anywhere in Foundry.
- A full GM enters the remembered Infinity Game Master Workbench route.
- Players and Assistant GMs see only player destinations already authorized for them.

The full-GM Workbench keeps these destinations in one persistent header:

- **Merchants**, **Quartermaster**, **Downtime**, **Factions**, and **Injuries** switch the active Workbench route.
- **Loot** opens the focused Loot Studio.
- **Settings** opens Infinity Settings.

There is no full-GM intro screen, Session Focus card, Continue list, or Campaign Data panel. Workspace-specific quick-start cards, such as Downtime's, can still be dismissed and restored from **Infinity Settings**.

The player/Assistant launcher remains intentionally separate and contains only permission-scoped player destinations. Opening it never changes campaign data.

## Use two GM profiles

For profiles such as **Gamemaster** and **Test GM**, select **Gamemaster** for
both in Foundry's **User Management**. This is the full GM role (4);
**Assistant Gamemaster** (3) intentionally opens Infinity's player launcher.
Infinity checks the current role, not the profile name or which profile was
created first. Drakemore's full-GM actions use the same role requirement.

Foundry may sign the changed profile out after saving its new role. Sign it
back in, then press `Shift+I` to open the GM Workbench. This does not require
restarting the world.

Both full GMs can open and browse the Workbench. Campaign editing still uses
one authoritative GM at a time to prevent conflicting writes. A browsing-only
status therefore does not mean that the second profile lacks GM permissions.
Use the existing editing handoff when switching between connected GM profiles.

Foundry world profiles are separate from GitHub accounts. Repository access
is managed for the actual GitHub identity, not the Foundry display name.

## Use Loot Studio

Full GMs open **Loot Studio** from the Workbench **Loot** utility. Choose Encounter, Hoard, or Creature with the mode tabs. Left/Right Arrow moves between tabs; Home/End selects the first or last mode.

Each mode keeps its own form, result, undo stack, presets, and history. The common entry restores this client's last mode. Existing macros that open Per-Encounter, Hoard, or Per-Creature loot still open the matching mode, and existing preset exports remain compatible.

The main scenario, tier, party or roster, estimated outcome, and **Generate** action stay visible. Open **Advanced** for exact budgets, rarity/type/value filters, weighting, art options, presets, import/export, and history.

If the item library is loading, wait before generating. If current filters have no matching items, adjust those filters first; neither state creates loot.

## Use GM workspaces

Full GMs use the persistent **GM Workbench** bar to move between Merchants, Quartermaster, Downtime, Factions, and Injury Triage. Switching routes keeps the Workbench position and remembers the last safe route on this browser. Invalid or stale links fall back to Merchants, and a role demotion closes the privileged surface. Loot Studio and Infinity Settings remain separate so their focused keyboard and lifecycle behavior does not compete with campaign management.

- **Merchant Workspace** separates Basics, Pricing & Bargaining, Stock, Access, and Sessions. **City Pricing** opens a separate batch window: choose a saved settlement or select merchants individually, set the shared buy, sell-back, bargain, and charm rules, preview every changed merchant, then apply the reviewed set. Individual merchant edits still override the copied values afterward. The active full GM can edit and host live trades; other full-GM windows are clearly read-only and may use Preview. Player trade requests and the GM's exact write plan survive reloads, with ambiguous outcomes pinned for review instead of retried blindly. Search the full allowlisted compendium rather than paging through a capped list.
- **Quartermaster** starts with Today, the recommended next action, supply outlook, and safety warnings. Choosing another environment previews its forage rules before activation. Use Recent Runs for read-only receipts and Setup & Rules for configuration, including creating, copying, ordering, removing, exporting, and importing custom regions. Import validates the whole versioned file and previews every catalog change before saving; it does not change the active environment or carry roster, supply, or history data. Only the active GM browser tab can change setup or run upkeep; other full-GM tabs stay read-only. Exact resource matches default to a searchable item picker; **Paste an Item UUID** remains available for items from other world or compendium sources.
- **Downtime Workspace** follows Set up, Player rolls, GM review, and Results. Each player chooses one activity (another choice replaces it), then clicks **Roll & submit**. Review and apply each submitted character as soon as they are ready; the block reopens for late players after every individual receipt. Use **Finish without waiting** after the ready characters are resolved. Report edits save before rewards are applied; **Save report** also saves them separately. The **Projects** tab offers editable crafting, research, and training presets with total hours, GP, successful checks, DC, and skills. Recovery appears when an interrupted result needs review.
- **Reputation** uses a faction list and detail workspace. Standing changes require the new standing and a reason before the existing authoritative write runs.
- **Critical Injury Triage** lists every player character's active recovery alongside unsent reviews and player-roll work. A recovery from 0 HP or the dead state appears as **Needs GM review** instead of interrupting the session with a dialog. Use **Send roll** to privately prompt the selected owner, **No injury** to dismiss it without changing the character, or expand **Log an injury** and use **Start review** for an exceptional case. Use **Party & rolls** for searchable recovery cards and one-click **View & treat** / **Sheet** actions. **Injury log** shows recent saved rolls after effects are removed. **Calendar** opens the connected calendar; **Sync injuries** repairs missing entries using saved GM receipts. The established roll, treatment, and recovery rules remain in control.

Most GM workspaces include a compact **Workspace guide** at the top. It identifies the active mode, selected record, authority state, or pending save/review before you work in the detailed sections.

Existing macros remain valid. `openMerchantWorkspace`, `openResourceManager`, `openDowntimeWorkspace`, `openReputation`, and `openCriticalInjuryTriage` now open the matching Workbench route. Advanced macros may call `openGmWorkbench({ route, subview, entityId })`; the route, subview, and entity identifier are sanitized before any surface opens.

## Player context and shortcuts

Actor-dependent windows identify the active character and wallet or inventory context. A character switcher, when shown, lists only legitimately controlled characters.

- `Shift+O`: Shops
- `Shift+D`: Downtime Activities
- `Shift+Q`: Party Supplies
- `Shift+R`: revealed Reputation
- `Shift+J`: Critical Injuries

Primary actions remain visible in sticky action areas. On narrow layouts, long queues and lists become contained drawers or stacked sections rather than forcing horizontal scrolling.

Player windows show pending or offline guidance when needed. Many begin with a compact **Safe next step** or read-only context. It explains whether to wait, refresh, select a controlled character, or use the next available action; it never retries a request for you.

Linked character tokens also show a clickable red **! count** badge for their GM and owners. It opens that character’s injuries directly and disappears when the last injury is removed.

When a controlled character has an active Critical Injury, the compact body HUD stays visible by default. Select a body marker for the affected region and treatment context, or use **Open Critical Injuries** to reach the full private window. The HUD can be disabled in **Infinity Settings â†’ Automation & Injuries**.

## Keyboard, touch, and accessibility

The Campaign Atlas presentation uses original map artwork and matching tool
emblems throughout the module. In narrow Workbench windows, the chest opens
**Loot Studio** and the astrolabe opens **Infinity Settings**; both retain named
tooltips and accessible labels. The five main routes always keep their text
labels, and a gold underline identifies the current route. Decorative artwork
is removed in forced-colour mode. All artwork ships with the module and requires
no external image service.

Party Supplies uses wider, responsive resource cards with wrapping names and
metric labels, so availability, daily use, and coverage remain readable in
smaller windows.
The Shops launcher scrolls as one page so its character controls, search, and
every shop remain reachable in short windows.

- Use Tab and Shift+Tab to move through controls, Enter or Space to activate buttons, and Escape to cancel safe dialogs or unpin the injury HUD.
- Item rows that open on double-click also expose a keyboard button or action.
- Comfortable density and coarse pointers use at least 44px action targets. Compact density uses 32px controls on a fine pointer and automatically returns to 44px for touch.
- The interface supports visible focus, 200% zoom, reduced motion, forced colours, and status announcements.

Change density and other personal preferences in **Infinity Settings → Appearance & Accessibility**.

If only some settings save, the status names them. Review those settings, then save once; settings that already saved remain active.

## Understand status and recovery messages

Status messages answer three questions: what happened, whether anything changed, and what to do next.

If merchant edits cannot be saved, stock generation, stock-filter copying,
market presets, and artwork selection stop and leave the edited fields visible.
Use **Save now**, then retry the action. A pending confirmation stops if its
merchant is changed or the workspace closes; start it again for the merchant
you want. If the workspace refreshes while the artwork picker is open, your
selection applies to the current form for that same merchant.

Choosing another merchant also waits for the current merchant's edits to save.
If that save fails, the current form stays open. Item drops and library choices
stop if you switch merchants before the item finishes loading. If an item
cannot be loaded, nothing is added; retry after the item becomes available.

If Shops or Party Supplies cannot send a request, the loading indicator clears
and **Try again** remains available. A shop-entry request stays disabled while
waiting for the GM, then becomes available again after a decline or send error.

Workbench navigation keeps the current window open if the destination cannot
start. Wait for a pending save before choosing another tool. Returning through
the route buttons restores that tool's remembered section.

When private campaign state is fail-closed, Shift+I and the scene-control launcher open a focused **Campaign Recovery** window instead of the normal Workbench. Secondary full GMs can inspect the same value-free status and Journal metadata, but only the active Game Master can confirm a recovery action. Campaign Recovery is exceptional and never appears in normal Workbench navigation.

- **Adopt a Journal** reviews an existing complete, privately owned current or known-legacy store before selecting it. Supported legacy data follows the normal migration path after adoption. Other Journals remain untouched.
- **Recover the verified snapshot** reviews the last complete snapshot available to this client before creating a verified recovery store. Other Journals remain untouched.
- **Start empty** creates a new canonical store without copying private merchant, faction, resource, downtime, or critical-injury data. This always requires a separate confirmation, and old Journals are not deleted.
- Closing or cancelling a recovery dialog changes nothing. If the review expires or active-GM control changes, refresh the Campaign Recovery window and review the current state again.

- **Loading or busy:** wait for the current authoritative request; duplicate actions stay disabled.
- **GM offline:** no campaign write was attempted. Reconnect or ask a full GM to sign in, then retry.
- **Interrupted or uncertain:** do not repeat the action blindly. The window requests canonical state and exposes the existing recovery path when one is available.
- **Merchant trade review:** the active GM uses the Merchant Workspace card to compare saved and current wallet, item, gold, and stock values, then chooses **Recheck** only after data matches an exact checkpoint. Players keep the warning in **Shops** until it has been reviewed with the GM; clearing that warning changes no campaign data and does not retry the trade.
- **Validation error:** nothing changed. Correct the named field and submit again.
- **Success:** the message names the confirmed result and the next available action.

Technical identifiers remain in Advanced details where a workflow provides them. If a problem persists, give the GM the exact status message without adding private character or campaign details.

## Monk's Active Tiles

The allowlisted `home` destination remains a compatibility ID and opens the permission-scoped player launcher for the triggering player. Existing destination IDs remain valid. A full Gamemaster who clicks the Landing Page's Shops control opens Merchant Workspace locally; player clicks still open only the permission-scoped Shops picker through the authenticated player route. The tile message still carries only the fixed surface key and user IDs; it does not add campaign data or grant a new permission.

### Shops by location

Open **Shops**, choose a city or location, and use **Open All**, **Close All**,
**Restock All**, **Generate All**, or **Clear All Inventory**. Stock operations
also reset the merchants' purchasing gold. Several locations may stay open.
Create a village, town, or city from a stocked template, or start empty and add
custom merchants. Existing merchants remain under **Unassigned shops** until moved.

Click a merchant for **Setup**, **Inventory**, **Access**, and optional
**Advanced** settings. Access can allow all players or selected players; ordinary
buying and selling are automatic. Edits save automatically, and **Save now**
retries a failed save. See the [Shops guide](MERCHANT_SESSIONS.md).

Use **City Pricing** for larger changes. Choosing a city or location selects all
of its shops, and the checklist can still be adjusted before previewing. Shared
buy/sell rules, bargaining, and charm pricing can be applied together or
independently. Individual item prices are preserved unless **Clear individual
item price overrides** is explicitly selected. The review shows the exact
before-and-after values for every changed merchant before anything is written.
