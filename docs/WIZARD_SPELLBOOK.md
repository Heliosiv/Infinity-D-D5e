# Wizard spellbooks and DDB reimports

## Use

1. GM: open Downtime → Activities → Learn Spell — Copy into Spellbook.
2. In Costs, supplies & crafting, copy a **spell document UUID** from a world
   item or compendium into the Wizard learning field. Do not use the scroll's UUID.
   Saving verifies the actual spell, level, school and 2014/2024 rules edition.
   Choosing it approves access to this discovered source and its Wizard-list eligibility.
3. Choose written notes/borrowed spellbook (kept), or a carried spell scroll.
   For a scroll, enter its exact inventory name and confirm that it contains the
   selected spell and edition. The carried scroll's recorded spell level must match.
4. Set the character's required spellbook inventory name. It defaults to Spellbook.
   Create separate learning activities for other available spells. Name activities
   after their spells to make player choices clear. Only assign approved sources.
5. Players allocate whole hours. Saving learning activities sets one-hour allocation
   blocks; partial progress carries forward for the same character and recipe.
   Allocations exceeding the remaining copying time are rejected, not charged.
6. The GM reviews and applies the report. Costs and delivery use the existing
   recoverable inventory transaction. No money or items are spent on submission.
7. Open a character sheet's header controls → **Wizard Notes**. Players see their
   learning log. The elected full GM can restore missing spells, forget a spell,
   or explicitly link a saved entry to a replacement Actor with the same DDB ID.

## Rules and limits

- Level 1–9 Wizard spells only; Wizard class level, not combined multiclass slots,
  determines eligibility. A spell already on the sheet is blocked for GM review,
  including ambiguous multiclass copies. Cantrip replacement is a different feature.
- Normal copying: 2 hours and 50 gp per spell level. A matching **2014 school
  Savant** feature halves both automatically. Other special copying abilities,
  sub-hour copying, backup-book discounts and homebrew rates need GM handling;
  they are not silently approximated.
- Copying from a scroll: final allocation's recorded Arcana roll vs DC 10 + spell
  level determines learning. One selected scroll is spent on completion whether
  the check succeeds or fails. Partial allocations do not consume it. The current
  downtime UI rolls each skill-based allocation; only the finishing roll matters.
- Written sources require no copying roll and are kept. Source access and spell-list
  membership are GM approvals, not inferred from an unrestricted compendium browse.
- The configured spellbook and any additional tools must be carried, not necessarily
  equipped. Ordinary ink/materials are covered by the GP charge. Additional physical
  ingredients are optional and additive. The book is not consumed.
- Learning creates a normal Wizard spell with its source's activities and effects,
  unprepared and using normal class spellcasting. It grants no extra slots and has
  no expiry. The receipt logs the calendar date when the GM resolves it; it does
  not move the clock or create a public calendar event.

Rules: [2024 Wizard spellbook copying](https://www.dndbeyond.com/sources/dnd/br-2024/character-classes#Wizard),
[Spell Scroll copying](https://www.dndbeyond.com/magic-items/9229085-spell-scroll),
[2014 Wizard](https://www.dndbeyond.com/classes/8-wizard).

## Import protection and recovery

The implementation targets the observed DDB Importer 7.1.35 / D&D5e 5.3.3 stack.
Learned spells carry DDB Importer's `ignoreItemImport` and `ignoreItemUpdate` flags.
The full spell snapshot and learning receipt also live in Infinity's checkpointed
campaign workflow, independently of embedded Items and the capped report history.
The player's Actor carries only a display summary, never the authoritative backup.

After `ddb-importer.characterProcessDataComplete`, the importing owner's client
signals completion through an Actor flag. The elected full GM reads its own trusted
records, serializes recovery per Actor, and restores missing spells without any GP
or scroll charge. Native matching spells are kept; multiple matches are flagged
for review, not deleted. Recovery also runs when the GM subsystem initializes and
after campaign-state changes. Pending applied/recovery plans defer reconciliation.
If no GM is connected, the individual importer protection still applies; backup
recovery waits for the GM. DDB authentication and imports remain player/GM-operated.

Matching respects spell level, rules edition, DDB definition identity when present,
and normalized names. Do not rename source spells or change editions to evade a
conflict. Wrong character IDs, duplicate copies, unavailable sources and changed
spell metadata stop the affected action for review. A newly created Actor is never
automatically linked just because its name matches. A full-GM confirmation plus
the same DDB character ID is required to move a saved record to a replacement.

**Forget** commits a permanent tombstone before removing the exact downtime-owned
spell. Retrying a failed deletion is safe. A matching DDB-owned spell is not deleted:
remove it in DDB separately if it must disappear from future imports. Deleting only
the Foundry spell item is not Forget and can be undone by recovery. A lost or stolen
physical spellbook also needs GM adjudication; a recovery backup is not an in-world
replacement book.

DDB Importer's current return-sync supports preparation and slots, not adding new
learned spells. Add spells to the DDB spellbook manually if both sheets must match.
Protecting a learned spell also preserves its local preparation/configuration;
manage that spell's preparation in Foundry. Other imported spells remain importer-owned.

Implementation references: [Importer retention](https://github.com/MrPrimate/ddb-importer/blob/7.1.35/src/muncher/DDBCharacterImporter.ts),
[item controls](https://github.com/MrPrimate/ddb-importer/blob/7.1.35/src/apps/DDBItemConfig.ts),
[return-sync](https://github.com/MrPrimate/ddb-importer/blob/7.1.35/src/updater/character.ts).

## Verification and rollback

`node scripts/test-spell-learning.mjs` covers costs, partial work, prerequisites,
2014 discounts, scroll success/failure, repeated apply, lost replies and rollback.
`node scripts/test-spellbook-ledger.mjs` covers missing-spell recovery, concurrent
events, duplicates, DDB identity, replacement linking, tombstones and GM authority.
The existing workflow-store suite verifies durable completion and history pruning.

`node scripts/audit-spellbook-foundry.mjs` runs only against localhost:32173 and the
disposable **downtime-gauntlet** world. It exercises real GM/player UI, actual
spell models, split-hour completion, simulated destructive imports, cross-client
completion signals, restart persistence and Forget. It never uses DDB credentials
or reimports a real player's character. A human-operated authenticated DDB reimport
remains a separate integration smoke check.

Configuration migrates to schema 10; existing assigned blocks retain their original
activities. Keep a pre-update world backup before production installation. Restoring
only older module code is not a safe downgrade after schema migration. A full backup
restore also discards play changes since that backup; prefer a forward fix when play
has continued. Git reverting the code alone does not undo GP, scrolls or learned spells.
