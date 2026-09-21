# Infinity D&D5e v0.3.49

This maintenance update completes the Shop recovery repair for campaigns whose
merchant records predate newer normalized schema defaults.

## What changed

- Recovery fencing now reads the same normalized merchant view that the guarded
  write lane supplies to a transaction mutation.
- A harmless difference between raw stored records and their normalized defaults
  no longer looks like a concurrent merchant edit.
- Exact concurrency, authority, Actor, ledger, and read-back checks remain in
  place. Recovery still fails closed when campaign data actually changes.
- Regression coverage reproduces a legacy raw merchant snapshot, verifies the
  guarded discard succeeds against its normalized canonical view, and confirms
  the durable replay-denial receipt is stored.

## Upgrade check

After restarting the target world, confirm Infinity D&D5e v0.3.49 is active.
In **Shops**, Recheck a review only when the card shows an exact safe checkpoint.
Use **Discard manually settled trade** only for transactions already handled by
the table. Confirm the intended cards disappear and the location can be closed.
This release does not migrate or rewrite Shops, Downtime, or unrelated campaign
records.
