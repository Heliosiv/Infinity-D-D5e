# Infinity D&D5e v0.3.48

This maintenance update restores the safe cleanup path for a pinned Shop trade
after merchant control briefly moves between full-GM windows.

## What changed

- A full-GM window that regains campaign-write leadership now starts a fresh
  authority epoch and reclaims the durable merchant ledger from canonical
  state. The previous lost fence no longer remains stuck until a world reload.
- **Discard manually settled trade** can therefore remove the exact recovery
  plan after an interrupted recheck, provided the same review checkpoint is
  still current.
- Discard continues to write only the terminal replay-denial receipt. It does
  not change character coins or items, merchant gold or stock, or try to finish
  the abandoned transaction.
- The affected merchant is no longer pinned after that receipt is saved, so its
  ordinary Shop controls—including closing its location—work again.
- Regression coverage reproduces a leadership loss during recheck, proves the
  review remains pinned at that point, restores leadership, discards it, and
  verifies the Actor and merchant snapshots stayed unchanged.

## Upgrade check

Create a Forge Save Point before installing. After restarting the target world,
confirm Infinity D&D5e v0.3.48 is active. In **Shops**, use **Discard manually
settled trade** on the exact review only when the table has already handled it.
Confirm the review card disappears, the character and merchant values do not
change, and **Close All** works for that location. This release does not migrate
or rewrite Shops, Downtime, or other campaign records.
