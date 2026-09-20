# Infinity D&D5e v0.3.44

This is the complete pending-work update from the live v0.3.41 installation.
It includes v0.3.42 merchant stock allocation, the v0.3.43 guarded merchant
recovery and scroll-preservation changes, and four-hour guided downtime setup.

## What changed

- Merchant stock generation supports percentage allocations across selected
  item types and prefers distinct eligible items before repeated copies.
- Pinned purchases can be rechecked when Foundry only added defaults to a
  delivered Item and all planned values and the purchase marker still match.
  Older transactions retain newer merchant stock-mix settings when settling.
  Other mismatches remain pinned and display bounded field-path hints.
- Merchant workspaces and sessions preserve their scroll positions on refresh.
- The GM can choose a four-hour guided downtime block. The setup deselects
  activities and projects needing more time, explains when none fit, and the
  service rejects an impossible block before writing campaign data.

## Upgrade check

Back up the world before installing. Verify Infinity D&D5e v0.3.44 is active
after the Forge restart. In the GM Merchant Workspace, inspect each pinned
trade's wallet, item, gold, stock, and mismatch hints before using Recheck.
Confirm stock percentages and scroll position survive an editor refresh. In
Downtime, choose **4 hours** and confirm only activities that fit can be
selected. Do not retry a pinned player purchase or reset its review record.
