# Merchant Sessions and Global Access

## v0.3.2 interface quick start

Open **Home → Prepare → Merchant Workspace**. Select a merchant in the master list, then work through Basics, Pricing & Bargaining, Stock, Access, and Sessions. The save state and any live-session consequence remain visible. **Add from compendium** searches the full allowlisted library and revalidates the selected item before the existing merchant write runs. Players see their active character, wallet, transaction total, and progress in Shops and Merchant Session.

The **Merchant Workspace** gives the active full GM one world-wide merchant
access control in its header. Other full-GM windows are read-only: they can
inspect shops and open a safe Preview, but cannot save merchant or transaction
state while the active GM is writing it.

Within one browser, a shared tab lock also makes a second tab for the same GM
account read-only and hands control over when the leader tab closes. Do not run
the same full-GM account concurrently on different browsers or devices during
Merchant trades: Foundry does not provide a cross-device compare-and-swap or a
connection identity that can make that topology safe. Use separate GM accounts
so the normal active-GM election can choose one authority.

## Durable purchases and sales

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

## Close every shop

Choose **Close All** and confirm the prompt. Infinity D&D5e then:

- closes every live player buy/sell window;
- blocks GM-pushed sessions and player self-service entry;
- updates connected players' **Shops** windows to show that the GM temporarily
  closed all shops;
- remembers each active merchant/player session; and
- leaves every merchant's individual **Open**, **Knock**, or **Off** setting
  unchanged.

The lock and the saved session list live in the restricted world state, so a GM
reload does not accidentally reopen the shops. Choosing **Close All** again is
safe and does not replace the saved list with an empty snapshot.

If a disconnected or stale player window remains after the global lock is
already active, **Close Stale** dismisses those remaining windows and refreshes
the players' Shops view without changing the saved lock or reopening access.

## Reopen globally

Choose **Reopen All** to lift the world-wide lock. Each self-service merchant
immediately returns according to its preserved **Open**, **Knock**, or **Off**
setting. Infinity D&D5e also recreates the player sessions that were active when
the shops closed, including sessions for offline players that will resume when
they reconnect.

A saved session is skipped if its merchant was deleted or that player was
removed from the merchant's allowed-player list while access was closed. The GM
notification reports how many sessions reopened and how many were skipped.
If reopening is interrupted after global access is lifted but saved sessions
remain, the header shows **Resume restoring (N)** instead of **Close All**. Finish
that restore first so a new close cannot overwrite the saved session snapshot.
