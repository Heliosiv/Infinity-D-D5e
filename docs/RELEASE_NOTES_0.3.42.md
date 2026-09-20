# Infinity D&D5e v0.3.42

This release adds value allocation across merchant stock types and improves
variety when generating a shop's inventory.

## Merchant stock

- Select two or more item types under **Stock generation settings** to assign
  each a percentage of the target stock value. Changing one percentage adjusts
  the others to total 100%; **Split evenly** resets the allocation. The editor
  shows the corresponding GP amount for each selected type.
- Generated stock respects each type's GP allowance, even when item types
  overlap (for example, Consumables and Ammunition). Existing merchants default
  to equal shares for their selected types when they next generate budgeted
  stock. A line count without a GP target keeps its existing behavior.
- Budget generation tries distinct eligible items before adding more copies of
  the same item. Potions and ammunition can still appear in multiples within
  their recommended quantity and budget limits.
- The editor warns when a share can afford only one eligible item. In the
  current curated library, a 6,000 gp target with 10% Magic Equipment has a
  600 gp equipment allowance that fits only Helm of Comprehending Languages.
  Increase the equipment percentage if you want rings or stones to be eligible.

## Upgrade check

After updating, confirm Infinity D&D5e v0.3.42 is active. In an Arcane
Supplier, select Magic Equipment and Scrolls, set 6,000 gp, and enter 10% for
Magic Equipment. Confirm Scrolls adjusts to 90%, then regenerate to see the
saved allocation and variety of scrolls. Campaign data requires no migration.
