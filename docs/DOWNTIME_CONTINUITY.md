# Private downtime continuity

Source follow-up to research integration `e69163d`, September 13, 2026.
This is a local development change, not an installed or published release.

## What changes

Encrypted vault schema 9 adds `downtimeSecrets`. Hunting areas, frozen hunting
rules and random seeds, Research Seeds, frozen libraries, cases and follow-up
state now persist with the world. A replacement full GM unlocks the same vault
and resumes the same records. Writes require the authoritative full GM and the
existing vault tab-leadership fence. Players receive only existing safe projections.

All private writes are awaited before a dependent workflow update or success
message. Locked or missing records stop the operation; a missing old record does
not silently substitute new rules or generate a replacement roll.

## Import older browser records

1. Unlock the vault on the original GM account and browser, in the same world.
2. Open Downtime and select **Import saved browser records**.
3. Review the hunting area/hunt/Research Seed/block counts and confirm.
4. Verify the records, then test an unlocked replacement GM before relying on it.

Import is additive and preserves the exact frozen rules, seeds and cases. A
conflicting ID or changed preview stops the entire import. A fingerprint binds
the preview to the canonical vault and source browser data. The write uses the
vault's existing authority, encryption and read-back checks. Original browser
copies remain intact. An import ledger prevents an old preserved copy from
resurrecting deleted seeds or replacing newer cases. A changed already-imported
browser copy requires GM recovery rather than a forced overwrite.

Repeat for each originating GM/browser. A world backup includes encrypted records;
the vault passphrase must be retained separately. The world cannot reconstruct
browser records that were deleted before import.

## Acceptance

The disposable `downtime-gauntlet` world was recovered from the earlier UI worktree
and copied into ignored `output/foundry-continuity`. Foundry 13.351 and dnd5e 5.3.3
ran the current checkout on localhost. No campaign world was changed.

- Unit coverage: additive import, unchanged-source retention, conflicting IDs,
  stale previews, deletion without resurrection, authority loss, malformed source,
  replacement-GM reads, player denial, and encrypted-transport secrecy.
- Existing hunting coverage retains two-stage Survival/attack, ammunition spending,
  hit/miss outcomes and no rerolls. Research coverage retains frozen requests and
  tiers, GM approval, safe dossiers and follow-up completion.
- Native continuity: real encrypted writes, locked reload/unlock, exact frozen
  record restoration, second-GM continuation, and authenticated-player documents
  and WebSocket frames checked for secret canaries.
- Native daily living: a mixed roster consumes supplies OR pays a modest lifestyle
  OR receives a covered exemption. Duplicate dates are refused across GM handoff;
  stale skip requests are refused and current skip requests succeed. A paused
  30-day interval charges nobody; an unpaused 30-day jump opens the real GM
  preview and Skip ignores the entire interval. Insufficient funds stay unresolved.
  A simulated lost reply after a real Actor update persists the receipt and a
  retry does not charge again. This simulates the response-loss boundary, not a
  physical server/network outage.

Native command: `node scripts/audit-downtime-continuity-foundry.mjs --test-world=downtime-gauntlet`.
Evidence: `output/playwright/continuity/native.json` (local, ignored).
This command deliberately writes synthetic Actors and records in that disposable
world; it refuses an omitted test-world argument and a mismatched world.

The final combined native run passed all eight recorded checks, including a
Research question through GM review/application and a receipt fetched by the
real authenticated player adapter. Secret canaries were absent from player
WebSocket frames, initial documents and the delivered projection.

The recovered fixture initially rendered its old canvas heavily and exceeded
combined-run timeouts. The runner now verifies the established no-canvas setup.
The optional `--research-only` mode resets synthetic downtime history/checkpoints
in this disposable world before running the isolated receipt journey; it also
proves that a locked client cannot read a private family. Neither runner accesses
campaign worlds. Evidence includes `native-research.json` in the same directory.

Source validation: 188 of 192 checks passed on the full run. Four schema fixtures
were updated for schema 9, including a new preservation migration assertion, and
all four passed on rerun. Focused private-record, vault and UI checks passed.
Formatting, the three-size browser journey (with import confirmation), and 14
layout scenarios across two workspace fixtures passed. Native acceptance here is
bounded to these synthetic journeys; deployment and campaign acceptance remain
separate steps. The local package build and final ESM import check passed;
`release/module.zip` is a development artifact (version remains 0.3.38), not a
published or installed release.

## Rollback

Use `git revert <continuity-commit>` to undo source changes locally. An older
runtime cannot read schema 9 or recover post-import progress from preserved old
browser copies. Before any installation, retain a matching world backup and
vault passphrase; restoring an older runtime requires its matching backup.
No deployment or campaign import is included in this task.
