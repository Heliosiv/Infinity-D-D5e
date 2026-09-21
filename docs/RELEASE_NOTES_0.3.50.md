# Infinity D&D5e v0.3.50

This update redesigns Shop transaction recovery so it assists the GM without
turning a broken recovery reminder into a campaign-control lock.

## What changed

- Only transactions actively applying Actor or merchant values temporarily
  block overlapping shop changes.
- A transaction already moved to **needs review** is advisory. It no longer
  blocks closing, editing, moving, or deleting a shop, and it does not prevent a
  fresh trade from using the current campaign values.
- The exact old request remains replay-safe and cannot be applied again.
- **Dismiss warning** now updates only the durable transaction ledger. It does
  not read or write the Actor, merchant gold, stock, or shop setup, so a missing
  or unreadable merchant cannot trap the reminder.
- The workspace and player copy now explain that recovery is optional and
  non-blocking. The former permanent error toast is a normal warning.
- An actively applying transaction remains protected by the original mutex,
  authority, checkpoint, and write-fence safeguards.

## Verification

- Regression coverage proves a review reminder does not consume transaction
  capacity or collide with a fresh transaction for the same shop.
- Integration coverage closes and deletes a shop while its old review reminder
  remains durable.
- Recovery dismissal succeeds while merchant reads fail and changes neither the
  Actor nor merchant state.
- A prepared transaction still rejects overlapping shop edits.

## Upgrade check

After restarting the target world, confirm Infinity D&D5e v0.3.50 is active.
Open **Shops** and confirm normal location controls remain available. If a future
trade needs review, use **Try safe recovery** only when the saved checkpoint is
exact, or **Dismiss warning** to remove the reminder without changing campaign
values. Downtime rules and stored Downtime records are unchanged by this
release.
