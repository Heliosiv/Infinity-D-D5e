# Shops and Merchant Trading

## Location-first quick start

Open **Shops** from the GM Workbench or the Landing Page. The left side lists
cities and locations. Select one to see all of its merchants and five controls:

The command-center summary shows the number of saved locations and shops,
currently open shops, empty shelves, and active shoppers. **Find anywhere**
matches either a location name or a shop inside it, so you can reach a merchant
without remembering its city. A selected location has its own Open, Closed,
Empty, and Shopping now summary. Use **Show → Needs attention** to isolate shops
that are closed or have no inventory.

| Control                 | Result for the selected location                                                                                               |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| **Open All**            | Makes every merchant available to its allowed players. Players enter and trade automatically. Other locations can remain open. |
| **Close All**           | Closes only these shops and their player windows.                                                                              |
| **Restock All**         | Resets existing item quantities to their starting quantities and restores each merchant's restock gold.                        |
| **Generate All**        | Replaces every shop's shelves from its saved stock settings and restores its restock gold.                                     |
| **Clear All Inventory** | Removes every stock row and restores each merchant's restock gold.                                                             |

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

Template stock targets are 250 gp per village shop, 1,000 gp per town shop,
and 5,000 gp per city shop. These are stock-value targets, not 8/12/16-item
limits, and are separate from the merchant's purchasing gold. In a merchant's
**Advanced → Stock generation settings**, use a standard value button or enter
any custom **Target stock value (gp)**; leave **Max item types** blank to let the
number of distinct items float. Alternatively, clear the value and enter a
maximum item count. Both fields can be set to enforce both limits. Existing
shops retain their saved stock settings until you change them. A value target
may undershoot when eligible items reach their recommended quantity limits;
repeated draws add to one inventory row rather than creating duplicate rows.
With two or more item types selected, **Stock value by item type** assigns each
type a share of the target value. Change one percentage and the others adjust
to total 100%; **Split evenly** resets the allocation. For example, 10% Magic
Equipment and 90% Scrolls on a 6,000 gp target assigns up to 600 gp and
5,400 gp respectively. The allocation applies when a value target is set;
selected types with no affordable item may undershoot their share. Budget
generation tries distinct items before increasing permitted quantities.

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

Generated stock can contain several of the same item in one inventory row.
The item library's recommended quantity limits bound each draw: common healing
potions can appear in multiple bottles, and ammunition appears in 20-piece
stacks. Stock value targets count the full quantity, and **Restock** restores
that generated starting quantity.

## Organize and clean up shops

- **Find anywhere** searches location and merchant names, while the location
  list remains alphabetized with
  **Unassigned shops** first. The **Location name** field directly below the heading
  and **Rename** button change a location's
  name without touching its shops or prices, including recovered imported locations.
- For **Unassigned shops**, enter a name in that same visible field and click
  **Name location**. This creates a real named location and moves all currently
  unassigned shops into it, preserving their stock, gold, and access settings.
  New unassigned shops can still appear separately in the future.
- **Find a merchant** searches the selected location. **Show** filters All,
  Needs attention (closed or empty), Open, Closed, or Empty inventory (no stock
  rows). **Sort** offers Name A–Z, Name Z–A,
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

The card separates the historical reason and states from a fresh, read-only
comparison. When the displayed wallet, quantity, gold, and stock look right but
the full checkpoint does not, it names up to three differing field paths per
Actor wallet, Actor item, or Merchant record. These hints show paths, not a
license to overwrite data: other item details or shop settings may have changed.

Choose **Recheck** after correcting campaign data to a saved checkpoint. The
active Merchant tab reacquires its authority fence and the merchant/Actor lock,
then reads both documents again. A bought item may have extra Foundry-generated
default fields if every planned item field, quantity, ID, and purchase marker
is unchanged; changed planned values still require GM review. A merchant's
newer stock-mix setting may also be absent from an older transaction plan; it
is preserved when the merchant update is applied. Recovery resumes only for
these order-safe mappings:

- Actor before or partly applied with Merchant before/unchanged;
- Actor after with Merchant before; or
- Actor after with Merchant after/unchanged.

Any other third state or unsafe order stays pinned. Recheck never resets, deletes,
rolls back, or force-completes a record. If the player was offline when a safe
recheck completed, their saved review sends a status-only fingerprint probe on
reconnect and moves to the receipt outbox only when the exact terminal result
returns.

### Discard a trade already settled manually

If the GM and players have already handled an unfinished trade outside the
module, use **Discard manually settled trade** on that exact review card. Read
the character and shop values first, then confirm the action in the active GM
Merchant workspace. It removes the actionable recovery plan and unlocks shop
edits; it does **not** pay, refund, grant, remove, or restock anything. A small
denial receipt remains so the original player request cannot be replayed as a
new purchase or sale. This is not an automatic reconciliation of the manual
work. Do not use **Recheck** for a trade already settled by hand, because
Recheck may safely finish remaining planned writes if the checkpoints match.

The player receives an exact manually-settled result if connected. Their saved
review warning also probes that receipt on reconnect and clears after the
result is presented. A stale card or lost GM authority makes the discard fail
without changing the ledger; refresh and inspect it again.

Players can always see saved review warnings in **Shops** (`Shift+O`), including
old-history uncertainty. **Reviewed with GM…** requires confirmation and only
removes that exact warning from the current device after verified read-back. It
changes no Actor, wallet, inventory, or shop data and never retries the trade.
