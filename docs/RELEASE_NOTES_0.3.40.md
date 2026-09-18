# Infinity D&D5e v0.3.40

This maintenance release completes the one finished historical fix that was
not included in v0.3.39. It retains the full v0.3.39 Research, daily-living,
private-continuity, injury, merchant, and trusted-table feature set.

## Crafted-scroll recovery

- Recovery now treats Foundry-generated version and timestamp changes inside a
  crafted item's embedded Active Effects as bookkeeping rather than gameplay
  drift.
- A paid, already-delivered crafted scroll can therefore be recognized after
  Foundry rewrites that metadata, without charging the character or creating
  the item again.
- Recovery remains fail-closed when effect identity, duration, mechanical
  changes, provenance, quantity, payment, or other useful item data differs.

## Upgrade check

After updating, confirm Infinity D&D5e v0.3.40 is active. Existing campaign
records and world data require no migration for this release.
