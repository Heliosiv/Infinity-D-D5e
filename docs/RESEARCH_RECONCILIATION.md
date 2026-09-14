# Research integration and daily-living verification

2026-09-13. Starting checkout: `c9fecd6`, clean, on
`codex/downtime-expansion-assessment`. Local source work only.

## Integration inventory

Compared the common ancestor `f4a7ce0`, the research-only range
`5103492^..7735622`, and the current checkout. Applied that range as a three-way
patch, inspected conflicts, and resolved them around current behavior.
No whole-branch merge or blind cherry-pick was used.

| Candidate                                                         | Classification                              | Resolution                                                                                                                                                                          |
| ----------------------------------------------------------------- | ------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Research rules, seeds, cases, review and follow-up (`5103492`)    | Missing, reusable with adaptation           | Integrated the three research modules, GM/player controls, projections and regression coverage.                                                                                     |
| Research safeguards (`2cc1d64`, `dd08d71`)                        | Missing, compatible                         | Retained private seed snapshots, frozen results, hidden-subject rejection, current document permission checks and safe pending results.                                             |
| Cancelled workspace guard (`3a71013`)                             | Missing, compatible                         | Cancelled reviews do not reload deleted private cases.                                                                                                                              |
| Partial review preservation (`7735622`)                           | Missing, compatible                         | Omitted review fields preserve authored content; retained links are checked again.                                                                                                  |
| Time helper and research source availability                      | Required dependency                         | Added Day/Night as **Research time** on new blocks. It affects research only; it does not move the calendar.                                                                        |
| Thievery/shop-stock and hunting reward changes preceding research | Separate work                               | Excluded. Current thievery, hunting yields and ammunition behavior are preserved.                                                                                                   |
| Newer field ammunition and UI draft fixes                         | Already present; conflicting source context | Retained while adding research controls and draft handling.                                                                                                                         |
| Current campaign record store                                     | Already present                             | Research shared workflow uses the existing campaign store. Private research seeds/cases retain their original browser-local boundary; no record migration.                          |
| Legacy Research template upgrade                                  | Unsafe original matching rule               | Replaced description-only matching with exact normalized stock matching. Added `researchVersion: 1` to new templates so old/custom activity snapshots keep their original workflow. |

## Daily living

The focused daily-living and calendar checks passed. They cover mixed supply
policies, previews, payments, exceptions, receipt recovery and authority guards.
The wider repository suite also includes the resource lifecycle tests.

Native acceptance is still open: no disposable `downtime-gauntlet` world or
server listening on localhost port 32173 was available. Only campaign worlds
were present in the inspected local data directory. No campaign world was
started or changed to substitute for the missing test environment.

To close this gate, use a disposable Foundry world with two GM clients and a
player, running this source: verify supplies/lifestyle/covered members, manual
settlement, skip, pause, insufficient funds, large jumps, reload after a charge,
and GM handoff. Read back inventory, currency and receipts. Preserve this as a
separate acceptance record from the source checks.

## Research acceptance scope

The local browser journey exercises questions, known subjects, open discovery,
changing outlooks, GM review, draft recovery, approval, player results and GM
follow-up completion at 1040, 720 and 380 pixels. It also checks Research time
survives a background refresh. Domain/UI regressions cover customized template
preservation and the discovery checkbox; the authoritative service covers
customized legacy research, hidden material, cancellation and revoked links.

These checks use local harnesses and in-memory Foundry substitutes. They are
not an actual authenticated-player transport audit. Before installation, verify
the research journey and inspect player frames/documents in a disposable native
world alongside the vault acceptance checks.

### Recorded source checks

- Full `npm run check`: 190 of 191 test files passed initially; the sole failure
  expected the old new-block payload without Research time. Its expectation was
  updated and passed on rerun. All 20 focused downtime files then passed, plus
  the final authoritative service suite with the new legacy-activity regression.
- `npm run format:check` and Git diff checks passed.
- Downtime, hunting and workbench browser journeys passed. Research tests cover
  1040/720/380-pixel widths and accessibility, including draft restoration.
- Full layout audit passed all 14 standard scenarios, including compact/touch
  sizes, short windows, 200% zoom, reduced motion and forced colors.
- All 108 isolated accessibility fixtures and the keyboard journeys passed.
- `node scripts/build-release.mjs` built and verified the local ZIP. The version
  remains 0.3.38; this development artifact is not a published release and must
  not be confused with the installed 0.3.38 build.

Research seed and case records remain in the originating GM browser. Preserve
that site's data and finish pending cases there. Browser-to-store migration and
cross-browser recovery remain a later continuity milestone, together with hunting.

## Rollback

Revert the integration commit locally to remove this feature. Do not reinterpret
new research blocks with older runtime code: finish/cancel test blocks first or
restore the matching pre-install world backup. Browser research data is separate
from that world backup and must be preserved separately. This task performs no
installation, migration, push or publication.

## Continuity follow-up (September 13, 2026)

The browser-local statements above describe the integration commit `e69163d`.
The next source slice moves hunting and Research private records into encrypted
vault schema 9. See [continuity acceptance](DOWNTIME_CONTINUITY.md) for the import
contract, native evidence and remaining acceptance boundaries.
