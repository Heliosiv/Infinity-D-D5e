# Infinity D&D5e v0.3.39

This release brings all reviewed work since v0.3.38 into the live release line.
It adds Research & Rumors, automatic or GM-directed daily living, world-backed
private downtime continuity, treatment-dependent V4 injuries, durable Internal
Bleeding damage, and passphrase-free campaign records for trusted tables.

## Trusted-table campaign records

Full GMs no longer create, save, or repeatedly enter an Infinity campaign-record
passphrase. Worlds that did not complete the earlier custom-passphrase setup open
and migrate automatically. A world that already encrypted records with its own
v0.3.37/v0.3.38 passphrase keeps a fail-closed legacy unlock path so those records
are never replaced.

Normal module screens and sockets still provide permission-scoped player views.
The automatic key is a trusted-table convenience, not a confidentiality boundary
against an authenticated player deliberately inspecting Foundry traffic or module
code.

## Downtime and daily living

- Research supports precise questions, broad known subjects, and discovering
  something unknown. Hidden subjects stay undiscoverable. Unprepared locations or
  leads create a GM preparation prompt instead of inventing campaign canon.
- Research Seeds, cases, follow-ups, hunting areas, frozen rules, and random seeds
  now persist with the world for replacement-GM continuity. Older browser records
  remain untouched until a GM reviews **Import saved browser records** in Downtime.
- Hunting areas can use ten terrain tables with eight animals each. GMs can edit
  the animal rows and meat ranges, then adjust a successful hunt's delivered meat
  and player report during review. Existing areas and open hunts keep their saved
  rules.
- Daily upkeep uses either party supplies or a character's selected lifestyle,
  never both. GM-covered exceptions, manual settlement, skip, pause, large-jump
  review, insufficient-funds handling, and replay-safe receipts are included.

## Critical injuries

- New V4 Internal Bleeding, Deep Cut, Infection, and Nightmares injuries remain
  until their stated treatment succeeds. Existing V2/V3 injuries keep their saved
  rules and are not silently converted.
- Treatment supports kit, reviewed rest, and GM-confirmed magic as appropriate,
  with recorded results and retry-safe spending.
- Internal Bleeding now rolls once per combat, spends temporary HP before current
  HP, ignores disabled or suppressed effects, and survives GM handoff or an
  interrupted completion without applying the same damage twice.

## Upgrade and rollback

Create a complete Forge Save Point or world backup before installing. Campaign
record schema advances to version 9. If rollback is needed, restore the matching
pre-upgrade world backup and reinstall v0.3.38; reinstalling the older module by
itself cannot reverse migrated records, currency, inventory, injuries, or
downtime progress.

After updating, confirm Infinity D&D5e v0.3.39 is active, open the GM Workbench,
and verify that campaign records open without the old Protect/Unlock setup screen.
