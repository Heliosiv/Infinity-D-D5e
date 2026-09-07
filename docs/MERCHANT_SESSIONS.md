# Shops and Merchant Trading

## Location-first quick start

Open **Shops** from the GM Workbench or the Landing Page. The left side lists
cities and locations. Select one to see all of its merchants and five controls:

| Control | Result for the selected location |
| --- | --- |
| **Open All** | Makes every merchant available to its allowed players. Players enter and trade automatically. Other locations can remain open. |
| **Close All** | Closes only these shops and their player windows. |
| **Restock All** | Resets existing item quantities to their starting quantities and restores each merchant's restock gold. |
| **Generate All** | Replaces every shop's shelves from its saved stock settings and restores its restock gold. |
| **Clear All Inventory** | Removes every stock row and restores each merchant's restock gold. |

Generate and Clear ask once before replacing a whole location's inventories.
Opening, closing, and restocking need no extra prompt. Stock changes are prepared
before one campaign write; a failed generation cannot leave half the city empty.
They wait for active trades and do not overwrite unresolved trade checkpoints.
Open/Close stay above the list. Expand **Stock & add shops** below the merchants
for stock resets and adding shops; **Manage location** is beside these setup tools.

Choose **Add a city or location**, enter its name, and choose a starter set:

- **Village:** three everyday shops; 250 gp purchasing gold per merchant.
- **Town:** five shops; 1,000 gp per merchant.
- **City:** seven shops including arcane supplies and fine goods; 5,000 gp per merchant.
- **Empty location:** add only the merchants you want.

Template merchants arrive stocked from the module's curated item library, with
ordinary prices, standard sell-back pricing, and all players allowed. New shops
start closed. Use **Open All** when the party arrives. **Add shop** creates a
stocked template or an empty **Custom Merchant** inside the selected location.
Opening a location makes shops available in the players' Shops menu; it does not
force a separate window for every merchant onto every player's screen.

Click a merchant for four tabs:

- **Setup:** name, art, description, location, and **Gold after restock**. Blank gold
  means unlimited; zero means no purchasing funds. Current gold is shown separately
  and changes with trades. Saving settings never replaces it with an older form value.
- **Inventory:** inspect, edit, generate, restock, clear, or add individual items.
- **Access:** open or close this shop, allow all players, or select specific players.
  All-player access includes new player accounts. Explicit restrictions survive
  bulk opening, closing, stock resets, and moving between locations.
- **Advanced:** optional prices, bargaining, charm, stock filters, purchase filters,
  player-window controls, duplication, and deletion.

Edits save automatically. **Save now** retries a failed save. Left/Right arrows and
Home/End move between tabs; multiple merchant windows can remain open.

## Organize and clean up shops

- **Find a location** searches the location list, which is alphabetized with
  **Unassigned shops** first. **Manage location → Rename** changes a location's
  name without touching its shops or prices, including recovered imported locations.
- **Find a merchant** searches the selected location. **Show** filters All, Open,
  Closed, or Empty inventory (no stock rows). **Sort** offers Name A–Z, Name Z–A,
  Open first, and Most item types. Filters and sorting survive shop refreshes while
  this directory is open. They do not change the saved merchant order.
- Check one or more shops, or use **Select shown**, then choose a destination and
  **Move selected**. **Unassigned shops** is available as a destination. Moving
  preserves stock, current and restock gold, prices, and player access restrictions.
  **Move all shops** still moves the entire location, regardless of search filters.
- Use the **Delete** button beside a shop, including an unassigned shop, or
  **Delete selected** for a checked group. The confirmation lists the exact shops.
  Deletion permanently removes their shop stock, gold, and settings and closes
  their shopping sessions and local editors. Compendium items, character inventories,
  and unrelated shops are untouched. Cancel leaves everything intact.
- **Manage location → Remove location** removes the location entry and keeps all
  its shops in **Unassigned shops**. To delete a whole city and its shops, first
  clear the shop filters, select all shown shops, delete them, then remove the
  empty location. The Unassigned group disappears automatically when empty.

Changing a merchant search/filter or location clears the checked selection;
sorting keeps it. A refresh drops checked shops that are no longer shown.
Renamed, moved, or deleted shops invalidate a pending confirmation rather than
silently targeting a different set. Moving and deletion wait for active trades
and refuse to change shops with unresolved trade checkpoints.

Location removal saves retained shops before deleting the empty location entry.
If the final location save fails, the shops are safe in **Unassigned shops**;
the error explains that the remaining location can be removed again.

## Existing campaigns

Existing merchants appear in **Unassigned shops** with their current stock,
gold, and access restrictions intact. Create a location, then move the group
using **Move these shops to another location**, or change one merchant's location
in **Setup**. Existing purchasing gold becomes its first restock baseline; adjust
**Gold after restock** as needed. Empty locations stay available after their last
merchant is removed.

If an older version left a world-wide shop closure active, **Open All** on one
location resumes only that location. Other shops remain closed, and old suspended
windows are not forced open. Normal location controls are independent afterward.
Legacy global APIs remain for compatibility with existing macros.

The active full GM window processes trades automatically in the background.
Other full-GM windows can browse, but only the authoritative Merchant tab writes.
Within one browser, a shared tab lock hands control over when the leader tab
closes. Use separate GM accounts across browsers/devices so Foundry can elect
one authority.

## Durable purchases and sales

Purchases and sales complete automatically. The connected GM client processes
them in the background; the GM does not approve individual trades. Stock,
prices, funds, and character ownership are still checked. New shops and location **Open All** use automatic entry, with no approval prompt.
Legacy Knock entry remains only until that shop is configured or its location opened.

Unfilled optional D&D5e Item fields are omitted from transaction snapshots,
matching their saved JSON representation. A failure while preparing a new
transaction returns a clear rejection before any character or shop write,
rather than leaving the player waiting for a result that cannot arrive.

Before a buy or sell request leaves the player's browser, Infinity D&D5e saves
the exact request locally. The active GM then stores an exact transaction plan
in the restricted campaign Journal before changing the character sheet or the
merchant. Item, wallet, and merchant updates have stable checkpoints, so a GM
reload, player reconnect, or authority handoff can resume only the parts that
canonical read-back proves are still unapplied.

The same request ID is safe to resend. A completed transaction replays its saved
result without charging or granting anything twice. If the observed character
or merchant no longer matches either expected boundary, the transaction is
pinned for GM review and the player is told not to retry it. The module never
guesses at an ambiguous write and never automatically rolls one back.

Old detailed replay receipts are eventually compacted. If an ancient request
arrives after its exact receipt is gone, the module does not guess whether that
request is a genuine replay or a newly reused old ID. It reports the outcome as
uncertain and tells the player not to retry until the GM reviews the character
and shop.

### Recheck a pinned transaction

The active Merchant Workspace lists each pinned trade with its reason, player,
Actor, merchant, quoted total, last canonical state, and concise saved
before-to-after values for the Actor wallet/item and Merchant gold/stock. The
current values appear beside those checkpoints. Secondary GM windows can read
the cards but cannot run recovery.

After correcting campaign data to one exact saved checkpoint, choose
**Recheck**. The active Merchant tab reacquires its authority fence and the
merchant/Actor lock, reads both documents again, and resumes the normal durable
flow only for these exact safe mappings:

- Actor before or partly applied with Merchant before/unchanged;
- Actor after with Merchant before; or
- Actor after with Merchant after/unchanged.

Any third state or unsafe order stays pinned. Recheck never resets, deletes,
rolls back, or force-completes a record. If the player was offline when a safe
recheck completed, their saved review sends a status-only fingerprint probe on
reconnect and moves to the receipt outbox only when the exact terminal result
returns.

Players can always see saved review warnings in **Shops** (`Shift+O`), including
old-history uncertainty. **Reviewed with GM…** requires confirmation and only
removes that exact warning from the current device after verified read-back. It
changes no Actor, wallet, inventory, or shop data and never retries the trade.
