# Infinity D&D5e v0.3.41

This release improves merchant stock generation and workspace stability, and
includes the player loading bars and confirmation-window layering added since
v0.3.40.

## Merchants

- **What this merchant buys** stays open while changing item types or rarities
  and through workspace refreshes.
- Generated stock can contain multiple copies of eligible items, including
  potions. Repeated draws combine into one shelf row. Ammunition draws use
  20-piece stacks, and the stock budget accounts for the full quantity.
- Village, town, and city presets now aim for 250, 1,000, and 5,000 gp of
  stock. A custom stock-value control is available in the merchant editor.
  Stock value and the merchant's purchasing purse remain separate settings.

## Windows

- Player Shops, Party Supplies, and Reputation show a loading bar while
  waiting for a response. Party Supplies also shows it during refreshes.
- Module confirmations and prompts open above workbench windows and retain
  focus until answered or dismissed.

## Upgrade check

After updating, confirm Infinity D&D5e v0.3.41 is active. Open a merchant's
**What this merchant buys** section and change several selections; the section
should stay open. Generate a potion shop several times and check that quantities
can exceed one. Existing campaign records and world data require no migration.
