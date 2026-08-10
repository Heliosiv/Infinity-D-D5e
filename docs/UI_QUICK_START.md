# Infinity D&D5e UI Quick Start

This guide covers the v0.3.2 interface. It does not change any game rule, permission, stored campaign record, or authoritative-GM workflow.

## Open Home

- Select the single **Infinity D&D5e** d20 category in scene controls.
- Or press `Shift+I` from anywhere in Foundry.
- A full GM sees campaign-management workspaces. Players and Assistant GMs see only player destinations already authorized for them.

Home groups destinations by intent:

- **Prepare** for setup such as merchants and available shops.
- **Run the Session** for active loot, downtime, and calendar work.
- **Track the Campaign** for Quartermaster supplies, factions, and injuries.

Home keeps its short guide and keyboard shortcuts behind the **Help** button in the header. Workspace-specific quick-start cards, such as Downtime's, can still be dismissed and restored from **Infinity Settings**.

## Use Loot Studio

Full GMs open **Loot Studio** from Home. Choose Encounter, Hoard, or Creature with the mode tabs. Left/Right Arrow moves between tabs; Home/End selects the first or last mode.

Each mode keeps its own form, result, undo stack, presets, and history. The common entry restores this client's last mode. Existing macros that open Per-Encounter, Hoard, or Per-Creature loot still open the matching mode, and existing preset exports remain compatible.

The main scenario, tier, party or roster, estimated outcome, and **Generate** action stay visible. Open **Advanced** for exact budgets, rarity/type/value filters, weighting, art options, presets, import/export, and history.

## Use GM workspaces

- **Merchant Workspace** separates Basics, Pricing & Bargaining, Stock, Access, and Sessions. The current save state and live-session consequence remain visible. Search the full allowlisted compendium rather than paging through a capped list.
- **Quartermaster** starts with Today, the recommended next action, supply outlook, and safety warnings. Use Recent Runs for read-only receipts and Setup & Rules for configuration, including creating, copying, ordering, and removing custom regions. Exact resource matches default to a searchable item picker; **Paste an Item UUID** remains available for items from other world or compendium sources.
- **Downtime Workspace** follows Create, Collect, Lock, Preview, Apply, and Complete. Recovery appears as a separate branch when the authoritative result is uncertain.
- **Reputation** uses a faction list and detail workspace. Standing changes require the new standing and a reason before the existing authoritative write runs.

## Player context and shortcuts

Actor-dependent windows identify the active character and wallet or inventory context. A character switcher, when shown, lists only legitimately controlled characters.

- `Shift+O`: Shops
- `Shift+D`: Downtime Activities
- `Shift+Q`: Party Supplies
- `Shift+R`: revealed Reputation
- `Shift+J`: Critical Injuries

Primary actions remain visible in sticky action areas. On narrow layouts, long queues and lists become contained drawers or stacked sections rather than forcing horizontal scrolling.

## Keyboard, touch, and accessibility

- Use Tab and Shift+Tab to move through controls, Enter or Space to activate buttons, and Escape to cancel safe dialogs or unpin the injury HUD.
- Item rows that open on double-click also expose a keyboard button or action.
- Comfortable density and coarse pointers use at least 44px action targets. Compact density uses 32px controls on a fine pointer and automatically returns to 44px for touch.
- The interface supports visible focus, 200% zoom, reduced motion, forced colours, and status announcements.

Change density and other personal preferences in **Infinity Settings → Appearance & Accessibility**.

## Understand status and recovery messages

Status messages answer three questions: what happened, whether anything changed, and what to do next.

- **Loading or busy:** wait for the current authoritative request; duplicate actions stay disabled.
- **GM offline:** no campaign write was attempted. Reconnect or ask a full GM to sign in, then retry.
- **Interrupted or uncertain:** do not repeat the action blindly. The window requests canonical state and exposes the existing recovery path when one is available.
- **Validation error:** nothing changed. Correct the named field and submit again.
- **Success:** the message names the confirmed result and the next available action.

Technical identifiers remain in Advanced details where a workflow provides them. If a problem persists, give the GM the exact status message without adding private character or campaign details.

## Monk's Active Tiles

The allowlisted `home` destination opens the same role-aware Home for the triggering player. Existing destination IDs remain valid. The tile message still carries only the fixed surface key and user IDs; it does not add campaign data or grant a new permission.
