# Infinity D&D5e UI Quick Start

This guide covers the current v0.3.7 source interface. It does not change any game rule, permission, stored campaign record, or authoritative-GM workflow.

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

## Use Loot Studio

Full GMs open **Loot Studio** from the Workbench **Loot** utility. Choose Encounter, Hoard, or Creature with the mode tabs. Left/Right Arrow moves between tabs; Home/End selects the first or last mode.

Each mode keeps its own form, result, undo stack, presets, and history. The common entry restores this client's last mode. Existing macros that open Per-Encounter, Hoard, or Per-Creature loot still open the matching mode, and existing preset exports remain compatible.

The main scenario, tier, party or roster, estimated outcome, and **Generate** action stay visible. Open **Advanced** for exact budgets, rarity/type/value filters, weighting, art options, presets, import/export, and history.

If the item library is loading, wait before generating. If current filters have no matching items, adjust those filters first; neither state creates loot.

## Use GM workspaces

Full GMs use the persistent **GM Workbench** bar to move between Merchants, Quartermaster, Downtime, Factions, and Injury Triage. Switching routes keeps the Workbench position and remembers the last safe route on this browser. Invalid or stale links fall back to Merchants, and a role demotion closes the privileged surface. Loot Studio and Infinity Settings remain separate so their focused keyboard and lifecycle behavior does not compete with campaign management.

- **Merchant Workspace** separates Basics, Pricing & Bargaining, Stock, Access, and Sessions. The active full GM can edit and host live trades; other full-GM windows are clearly read-only and may use Preview. Player trade requests and the GM's exact write plan survive reloads, with ambiguous outcomes pinned for review instead of retried blindly. Search the full allowlisted compendium rather than paging through a capped list.
- **Quartermaster** starts with Today, the recommended next action, supply outlook, and safety warnings. Choosing another environment previews its forage rules before activation. Use Recent Runs for read-only receipts and Setup & Rules for configuration, including creating, copying, ordering, removing, exporting, and importing custom regions. Import validates the whole versioned file and previews every catalog change before saving; it does not change the active environment or carry roster, supply, or history data. Only the active GM browser tab can change setup or run upkeep; other full-GM tabs stay read-only. Exact resource matches default to a searchable item picker; **Paste an Item UUID** remains available for items from other world or compendium sources.
- **Downtime Workspace** follows Create, Collect, Lock, Preview, Apply, and Complete. In a guided block, each player clicks **Roll & submit** for their one selected activity; the GM reviews that recorded check before choosing the outcome. The **Projects** tab creates shared hour targets that several characters can advance in the same block. Recovery appears as a separate branch when the authoritative result is uncertain.
- **Reputation** uses a faction list and detail workspace. Standing changes require the new standing and a reason before the existing authoritative write runs.
- **Critical Injury Triage** lists every player character's active recovery alongside unsent reviews and player-roll work. A recovery from 0 HP or the dead state appears as **Needs GM review** instead of interrupting the session with a dialog. Use **Send roll** to privately prompt the selected owner, **No injury** to dismiss it without changing the character, or **Start review** for an exceptional case. The triage board never edits or removes injuries; the existing authoritative roll, treatment, and recovery workflow remains in control.

GM workspaces include a compact **Workspace guide** at the top. It identifies the active mode, selected record, authority state, or pending save/review before you work in the detailed sections.

Existing macros remain valid. `openMerchantWorkspace`, `openResourceManager`, `openDowntimeWorkspace`, `openReputation`, and `openCriticalInjuryTriage` now open the matching Workbench route. Advanced macros may call `openGmWorkbench({ route, subview, entityId })`; the route, subview, and entity identifier are sanitized before any surface opens.

## Player context and shortcuts

Actor-dependent windows identify the active character and wallet or inventory context. A character switcher, when shown, lists only legitimately controlled characters.

- `Shift+O`: Shops
- `Shift+D`: Downtime Activities
- `Shift+Q`: Party Supplies
- `Shift+R`: revealed Reputation
- `Shift+J`: Critical Injuries

Primary actions remain visible in sticky action areas. On narrow layouts, long queues and lists become contained drawers or stacked sections rather than forcing horizontal scrolling.

Player windows begin with a compact **Safe next step** or read-only context. It explains whether to wait, refresh, select a controlled character, or use the next available action; it never retries a request for you.

When a controlled character has an active Critical Injury, the compact body HUD stays visible by default. Select a body marker for the affected region and treatment context, or use **Open Critical Injuries** to reach the full private window. The HUD can be disabled in **Infinity Settings â†’ Automation & Injuries**.

## Keyboard, touch, and accessibility

- Use Tab and Shift+Tab to move through controls, Enter or Space to activate buttons, and Escape to cancel safe dialogs or unpin the injury HUD.
- Item rows that open on double-click also expose a keyboard button or action.
- Comfortable density and coarse pointers use at least 44px action targets. Compact density uses 32px controls on a fine pointer and automatically returns to 44px for touch.
- The interface supports visible focus, 200% zoom, reduced motion, forced colours, and status announcements.

Change density and other personal preferences in **Infinity Settings → Appearance & Accessibility**.

If only some settings save, the status names them. Review those settings, then save once; settings that already saved remain active.

## Understand status and recovery messages

Status messages answer three questions: what happened, whether anything changed, and what to do next.

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
