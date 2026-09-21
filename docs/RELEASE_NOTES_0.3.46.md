# Infinity D&D5e v0.3.46

This update lets a GM safely clear unfinished trades that the table already
settled manually, while preventing the original request from running later.

## What changed

- Each pinned trade has a **Discard manually settled trade** action with an
  explicit confirmation. It removes the actionable recovery plan and unlocks
  that shop without changing character coins or items, merchant gold, or stock.
- A compact denial receipt remains after discard. A delayed retry or reconnect
  receives a manually-settled result instead of recreating the transaction.
- A stale review card, changed review checkpoint, lost GM authority, or failed
  campaign-record write leaves the original review record intact.
- Recovery now accepts Foundry-added runtime item defaults that cannot be
  represented in strict JSON only after every saved purchase field, quantity,
  identity, and purchase marker is proven unchanged. Changed planned data still
  remains pinned for review.
- Player-side saved review warnings resolve when the exact manually-settled
  receipt is received, without retrying the purchase or sale.

## Upgrade check

Create a Forge Save Point before installing. After restarting the target world,
confirm Infinity D&D5e v0.3.46 is active. In **Shops**, inspect each pinned
transaction. Use **Discard manually settled trade** only for work the table has
already completed by hand. Confirm that its review card and red shop warning
disappear and that the displayed character and merchant values do not change.
Use **Recheck** instead only when the module should continue an unfinished plan
from its saved checkpoints. Reinstalling an older module cannot restore a
discarded recovery plan; use the pre-upgrade Save Point for rollback.
