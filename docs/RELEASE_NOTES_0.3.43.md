# Infinity D&D5e v0.3.43

This update includes the v0.3.42 merchant stock-mix changes, scroll-position
preservation, and a guarded recovery correction for pinned merchant purchases.

## Merchant purchases

- A purchase can now pass its item checkpoint when Foundry only added default
  fields during Item creation. The saved item fields, quantity, ID, and
  transaction-specific purchase marker must still match. Changed values remain
  pinned for GM review.
- Pending transactions planned before stock-mix percentages were introduced can
  ignore that one additional merchant setting during checkpoint comparison.
  The current setting is kept when the merchant's gold and stock are updated.
- Review cards show the current mismatch paths and distinguish the original
  failure from a fresh Recheck result. Permanent player warnings are shorter.
- Merchant workspaces and sessions retain their scroll position on refresh.

## Upgrade check

Back up the world first. After installing, verify version 0.3.43 in Foundry.
Open the GM Merchant Workspace and review any pinned transactions. Use Recheck
only after confirming the Actor wallet/item and Merchant gold/stock shown on
each card. A transaction remains pinned if any other planned field changed;
do not retry the purchase or manually reset its review record.
