# Infinity D&D5e improvement roadmap

Assessed 2026-09-13 against `dcd391f` on
`codex/downtime-expansion-assessment` (manifest/package version 0.3.38).
This is the current planning entry point. Older assessments remain historical
evidence; their proposed work must be checked against current source before use.
This assessment does not certify the installed world or authorize a release.

**Implementation follow-up, 2026-09-13:** Research & Rumors is now integrated
locally, including its earlier safeguards and compatibility fixes. Daily-living
source checks pass; native multi-client acceptance remains open because the
disposable local test world is unavailable. See the
[integration inventory and acceptance record](RESEARCH_RECONCILIATION.md).
The assessment table below retains the starting-checkout findings.

## Assessment

The module already has a substantial playable foundation. The best next work is
to finish continuity and recovery across existing workflows, then add one useful
campaign activity at a time. A broad rewrite or another visual redesign is not
justified by this review.

| Area                        | Current source evidence                                                                                                      | Roadmap consequence                                                                                                                                     |
| --------------------------- | ---------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Crafting, training, reports | `recipes.js`, `training.js`, `journal.js`; downtime guide documents recipe selection, personal grants and searchable history | These are implemented foundations, not new milestones from the September 6 assessment.                                                                  |
| Party Supplies              | PS-01 through PS-11 have source follow-ups; resource guide and dedicated tests cover previews and recovery                   | Close native multi-client acceptance before claiming full operational readiness.                                                                        |
| Daily living                | `232115e` and `dcd391f` add lifestyle payments, manual settlement, skipping and pausing                                      | Verify this complete session workflow before expanding upkeep further. Version 0.3.38 alone does not prove these commits are installed.                 |
| Hunting                     | `hunting-store.js` stores frozen rules and custom areas in the originating GM browser                                        | GM/browser continuity is a concrete remaining limitation.                                                                                               |
| Private data                | `private-state.js` integrates the encrypted vault                                                                            | The old plaintext-storage assessment is historical. Encryption still needs actual player-transport and locked-vault acceptance.                         |
| Research & Rumors           | This checkout has the simple `guided-research` activity; the expanded research workflow files are absent                     | Reconcile prior work before commissioning a replacement. Local commit `7735622` contains a research-review fix but is not an ancestor of this checkout. |
| Injuries                    | V3 has 30 outcomes; the older audit records recovery contradictions and partial automation                                   | Reproduce the specific gaps, settle recovery intent, then fix bounded behavior. Do not treat the historical audit as a fresh defect reproduction.       |

## Prioritized delivery plan

Effort is relative, not a calendar estimate. Each row is a separate reviewable
slice. Implementation and local verification do not imply installation or live
campaign changes.

| Priority | Milestone and value                                                                                              | First bounded slice                                                                                                                                             | Done when                                                                                                                                                                                                                                                                                                     | Effort / dependency                                                                                   |
| -------- | ---------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| 1        | **Finish daily living acceptance.** Make normal calendar use trustworthy.                                        | Exercise supplies, paid lifestyle and GM-covered members together, including manual settlement, skip and pause.                                                 | Preview matches charges; duplicate events and reloads do not charge twice; insufficient funds and interrupted writes give recoverable outcomes; large jumps and paused intervals behave as documented. Include two GM clients in an isolated Foundry world.                                                   | Medium; current source and isolated native test environment.                                          |
| 2        | **Reconcile Research & Rumors.** Give players useful questions and discoveries without rebuilding existing work. | Locate the complete prior implementation, compare its dependencies and tests to this branch, and produce an integration inventory before changing runtime code. | Every candidate change is classified as already present, compatible, conflicting or obsolete; the smallest integration scope and its tests are identified. Then prove question/topic/open discovery through GM review and a player receipt, with no hidden subjects, facts or numeric DCs in player payloads. | Medium investigation; potentially large integration, dependent on current vault compatibility.        |
| 3        | **Make hunting survive GM/browser changes.** Preserve an unfinished hunt and custom areas.                       | Design migration of browser-local rules into the existing private vault, preserving frozen block rules.                                                         | An unlocked replacement GM resumes the same hunt; locked/missing state stops safely; one shot spends ammunition once and a miss ends the hunt; migration preserves source data until verified; actual player payloads contain no secret rules.                                                                | Medium–large; migration design and isolated vault acceptance.                                         |
| 4        | **Align injury recovery and enforcement.** Reduce surprise cures and manual combat bookkeeping.                  | Reproduce the four treatment-dependent expiry cases and present one explicit recovery policy per injury for campaign approval.                                  | New rules agree with displayed text; old injury records retain their intended version; expiry, treatment and calendar replay tests pass. Follow with a separate durable Bleeding damage slice covering temporary HP, disabled effects and GM handoff.                                                         | Medium per slice; campaign recovery decisions required before behavior changes.                       |
| 5        | **Add one complete crafting family.** Give downtime another tangible reward.                                     | Propose Healing Potion and Antitoxin as the initial herbalism pair, reusing usable existing items and recipe infrastructure.                                    | Approved tools, access, time and cost are quoted; partial progress and held/lost materials balance; interrupted delivery cannot duplicate output; the journal explains progress and the next step.                                                                                                            | Medium–large; approve campaign recipe terms first. Gathering discounts can be a later separate slice. |

Next gate: close native acceptance for daily living and integrated research in
a disposable world. Then tackle private hunting/research continuity across GM
browsers, preserving saved cases and rules. If current native acceptance
evidence already exists, attach it instead of repeating the same checks.

## Campaign direction and deferred ideas

- Preserve Drakmor house rules, readable player difficulty labels, GM-only
  numeric DCs, and useful completed reports.
- Research should allow a precise question, a broad topic, or discovering
  something new. Unknown discoveries create GM preparation work rather than
  invented campaign canon. Reconfirm this contract against the recovered design.
- Keep hunting's Survival-then-ranged-attack flow and no second shot after a miss.
- Add activity families individually. Campcraft remains excluded. Animal
  training, shared commissions and location benefits stay deferred until their
  exact recipients, persistence and usable outcomes are defined.
- Do not add generic training prices or permanently grant skills/feats without
  an approved individual plan. Existing training is not a reason to rebuild it.
- Do not replace current custom activities, unfinished recipes, or historical
  reports with new defaults.

## Verification and completion rules

For runtime slices, use focused regression tests first, then the applicable
repository source/UI gates. Exercise changed player and GM journeys at narrow
widths, with keyboard use, background rerenders, unsaved drafts and failed saves.
Confidentiality requires inspecting actual authenticated-player payloads in
addition to the visible interface. Source harness success is not native acceptance.

Track each milestone separately as: proposed, implemented locally, source
verified, native accepted, released, installed. Record the commit and evidence
for each transition. Release/install actions and live migrations require their
own explicit authorization; completing this plan does not activate them.

This assessment read repository docs and relevant source, checked Git history,
and ran `node scripts/test-resource-living.mjs` successfully. It did not run a
full runtime regression suite or inspect the live world. The initial checkout
was clean. No new runtime defects are claimed from unexecuted historical cases.

## Supporting plans

- [Original downtime assessment](DOWNTIME_EXPANSION_ASSESSMENT.md)
- [Non-ammunition proposals](DOWNTIME_NON_AMMUNITION_DESIGN.md)
- [Party Supplies assessment](PARTY_SUPPLIES_ASSESSMENT.md)
- [Resource and daily living guide](RESOURCE_SYSTEM.md)
- [Hunting design and implemented boundaries](DOWNTIME_HUNTING_DESIGN.md)
- [Injury audit](INJURY_TABLE_AUDIT.md)
- [Private vault guide](PRIVATE_VAULT.md)
