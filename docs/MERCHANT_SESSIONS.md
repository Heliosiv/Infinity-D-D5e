# Merchant Sessions and Global Access

The **Merchant Workspace** gives a full GM one world-wide merchant access
control in its header.

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

## Reopen globally

Choose **Reopen All** to lift the world-wide lock. Each self-service merchant
immediately returns according to its preserved **Open**, **Knock**, or **Off**
setting. Infinity D&D5e also recreates the player sessions that were active when
the shops closed, including sessions for offline players that will resume when
they reconnect.

A saved session is skipped if its merchant was deleted or that player was
removed from the merchant's allowed-player list while access was closed. The GM
notification reports how many sessions reopened and how many were skipped.
