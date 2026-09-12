# Party Supplies assessment and improvement backlog

## Implementation follow-up (unreleased)

The authorized follow-up implements PS-01 through PS-11 in source. PS-03 uses
prepaid fractional portions, so daily and batched runs agree across reloads;
PS-05 uses player difficulty labels. PS-04 is an explicit, backup-gated v5
upgrade in Quartermaster, keeping existing worlds on the v4 path by default.
The original findings below describe the pre-change baseline. Native Foundry
multi-client acceptance remains pending; local integration tests do not
constitute a deployment or live-world migration.

Regression coverage includes repeated sanitization, threshold boundaries,
fractional carry across reloads, guarded v4-to-v5 activation, interrupted writes,
receipt delivery, prompt replay and burst refresh invalidation. The resource
guide documents manual exhaustion review in recovery mode and rollback by
restoring the pre-upgrade backup.

Source verification for this follow-up:

- `npm run check`: all 188 test files passed. The later daily-preview test and
  final related changes passed in a 32-file focused rerun; the scroll-container
  assertion and shared-stash/selection credit tests were rerun after final edits.
- `npm run format:check`: passed.
- Layout: seven relevant fixtures passed all 14 standard scenarios; four Supplies
  fixtures also passed the opt-in `supplies-320` stress scenario.
- `npm run ui:audit:a11y`: all 108 isolated fixtures passed after fixing the
  refreshing view's keyboard focus target.
- `npm run ui:audit:keyboard`: passed, including supply selection with Space and
  the background-refresh button with Enter.

The module consists of native ES modules; no runtime transpilation is required.
No release package, push, installation, world migration or live inventory write
was performed. Native Foundry multi-client acceptance remains outstanding.

### Original assessment baseline

Reviewed 2026-09-11 against source commit `b7f1ebb` (module 0.3.37), on
`codex/downtime-expansion-assessment`. This is an assessment, not an implemented
change or a live-world acceptance report. No campaign settings or inventory were
changed. The pre-existing `.codex-remote-attachments/` directory is outside scope.

## Scope and assessment

Reviewed the player Party Supplies window and hub label, their snapshot service,
Quartermaster's daily selection dialog, supply outlook calculations, consumption,
calendar integration, and associated tests. The foundation is substantial:
source-aware accounting, sanitized player projections, request correlation,
authority fencing, inventory readback, and explicit partial outcomes already exist.
Improve the accuracy and explanation of the player outlook first, then address
rounding policy and interrupted-run integration.

### Prioritized improvements

| ID    | Priority / evidence                        | Improvement and user impact                                                                                                                                                                                                                                                                                                                                                                                                                                           | Acceptance test                                                                                                                                                                                                                                                                       |
| ----- | ------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| PS-01 | P1, reproduced defect                      | Preserve safe source metadata through the complete GM-to-player snapshot round trip. A second sanitization replaces `2 supply sources; lowest coverage shown` with `Individual packs`, and replaces a party pool's `2 supply sources` with `0 supply sources`. Players lose the explanation for apparently contradictory totals. Add bounded `sourceCount` and a coverage-basis enum; derive text from these safe fields rather than preserving arbitrary GM strings. | Build a canonical snapshot, sanitize on the GM, deliver through the player's reply handler, and inspect the rendered labels. Test individual packs, shared stash, party pool, and zero sources. Assert no actor names, item evidence, or matching rules enter these fields.           |
| PS-02 | P1, reproduced defect                      | Classify coverage using the unrounded ratio. The current calculation rounds to two decimals before deciding Critical/Low/Ready. Stock 199 with demand 200 becomes `1 day` instead of less than a day; 599/200 becomes `3 days` and Ready. Display rounding must not upgrade readiness.                                                                                                                                                                                | Test just below, exactly at, and just above one and three days, including large rosters/custom daily demand. Under one complete day must remain Critical and display `<1 day`.                                                                                                        |
| PS-03 | P1, reproduced policy inconsistency        | Define one half-ration and fractional-demand policy shared by outlook, preview, and consumption. With food at 1/day and half rations, two separate one-day runs request 2 units, while one two-day run requests 1. The code explicitly permits savings across a multi-day advance, but this makes the calendar step size affect cost; ordinary daily runs do not stretch a 1/day ration. Choose daily rounding or durable fractional carry before implementation.     | Compare one N-day run with N one-day runs for rates 1, 2, 3 and fractional custom rates, with half rations on/off. If equivalence is intended, preserve it across reloads and GM handoff. If batching is intentional, explain it in the preview and outlook.                          |
| PS-04 | P1, integration/test gap                   | Complete and verify durable operation recovery in the actual upkeep flow before promising resumable runs. Ledger, inventory-operation, delivery, and coordinator modules exist, but the production calendar watcher still calls the lease-based consumption pipeline; no production caller of `createResourceOperationCoordinator` was found. Reuse the existing foundation.                                                                                          | In an isolated Foundry world, interrupt before/after an item write and before/after a receipt checkpoint; reconnect as the same GM, another GM, and a second tab. Verify quantities and receipts, no repeated deposits/charges, and clear Needs review handling for ambiguous writes. |
| PS-05 | P2, observed disclosure / product decision | Decide whether foraging DCs should be player-visible. The current player projection includes numeric `dc`, `foodDc`, and `waterDc`, and the template displays them. If Party Supplies should follow the campaign's GM-only numeric difficulty convention, replace them with approved difficulty labels at the projection boundary, including forage prompts. This is current intentional/tested behavior, not an authentication bypass.                               | Inspect actual player socket payloads as well as rendered text for common/split DCs, water disabled, and no-foraging environments. GM previews retain the appropriate privileged details in Quartermaster.                                                                            |
| PS-06 | P2, usability improvement                  | Preview the actual selected consumption before confirmation: total days charged, consumer count, effective half-ration demand, available stock, and predicted shortfall per resource. The dialog currently shows base per-day rates and says half-ration rules apply, leaving the GM to calculate the result. Recompute/revalidate before applying.                                                                                                                   | Food-only, water-only, light-only, mixed/custom selections; zero-rate resources; no consumers; 3-day catch-up; shortage; and inventory/roster/settings changes while the dialog is open. Cancel changes nothing; Skip and Use remain distinct.                                        |
| PS-07 | P2, usability improvement                  | Make the cause of limited coverage actionable without revealing hidden inventory. After fixing PS-01, show a safe explanation such as `At least one assigned supply source is empty; ask the GM to review distribution`. Available stock is aggregated, while per-character coverage uses the lowest source coverage, so redistribution may solve a shortage.                                                                                                         | One actor has 10 rations and another has zero; compare independent packs with a shared stash. Explain zero coverage despite positive stock, with no hidden actor/source identities in the player payload.                                                                             |
| PS-08 | P2, observed display gap                   | Show the last upkeep's date, number of days, and selected resources. The safe projection already carries `day`, `days`, and `ranAt`, but the template only displays the result and rows. A food-only run can show `Supplied` without explaining that water was not assessed. Add safe selected-resource metadata and distinguish `Supplied for selected resources`.                                                                                                   | Food-only followed by water-only, multi-day catch-up, renamed/deleted resource definitions, and manual upkeep without clock movement. Historical labels must survive later settings changes.                                                                                          |
| PS-09 | P2, performance/UX improvement             | Coalesce background refreshes and avoid repeatedly replacing the whole outlook with a loading screen during inventory bursts. Every new player request clears the current snapshot. Consider keeping a visibly stale snapshot during routine refresh with one queued follow-up; immediately clear it on sharing disable, permission loss, or authority loss.                                                                                                          | Burst item updates under a delayed connection; no request starvation, bounded renders, preserved keyboard focus/scroll, and eventual latest totals. A stale view must never imply freshness or survive a privacy transition.                                                          |
| PS-10 | P2, documentation defect                   | Reconcile the resource guide with current code and clearly separate implemented features, planned recovery, and live acceptance. It still says custom environment import/export is unavailable, although Quartermaster has both handlers. Its interrupted-run journey promises resumption while its Current limits section describes in-memory pending forage. Its restricted-Journal privacy language also needs review against the current encrypted-vault guide.   | Trace each availability claim to a production call path and test; label future journeys explicitly. Link current vault setup/recovery rather than repeating obsolete privacy guarantees.                                                                                              |
| PS-11 | P3, usability/test improvement             | Add long-label, large-roster, keyboard, and stale-hub fixtures specific to Party Supplies. Include meaningful unit names for custom supplies and an explanation of coverage status thresholds. The hub is persisted scene text, so its last values can remain visible after the GM goes offline while the Supplies window correctly reports offline.                                                                                                                  | 320px view, 200% zoom, long localized resource/environment names, many resource cards, screen-reader status announcements, and no GM online. Explain hub freshness without implying players can mutate scene data.                                                                    |

P1 means address before relying on the affected behavior; P2 means the next
product-quality pass; P3 is polish after the correctness work. PS-03 and PS-05
require an explicit rules/product decision, not an assumed change to house rules.

## Evidence and reproduction

### Snapshot round trip

Relevant code: `scripts/resource/overview.js:127` and `:476`,
`scripts/resource/overview-service.js`, and
`scripts/resource-overview.js:196`.

A local Node probe called the production pure functions in sequence:
`buildResourceOverview` → `sanitizeResourceOverview` →
`sanitizeResourceOverview`, matching the GM and player boundary behavior.
With two independent sources, food 10/0 and torches 4/0:

| Field                     | GM's safe outbound value                | After player sanitization |
| ------------------------- | --------------------------------------- | ------------------------- |
| Food source summary       | 2 supply sources; lowest coverage shown | Individual packs          |
| Light source summary      | 2 supply sources                        | 0 supply sources          |
| Food available / coverage | 10 / Empty                              | 10 / Empty                |

The arithmetic is retained; the explanation is damaged. The second sanitizer
derives the source count from the raw `sources` array that the first sanitizer
correctly removed. Do not fix this by transmitting raw source evidence.

### Coverage thresholds

Relevant code: `scripts/resource/overview.js:537` and `:554`.
A Node probe built party-scoped food at 200 units/day:

| Stock | Exact coverage | Current reported coverage | Current status |
| ----- | -------------- | ------------------------- | -------------- |
| 199   | 0.995 days     | 1 day                     | Low            |
| 599   | 2.995 days     | 3 days                    | Ready          |

Both results were reproduced by calling the production overview builder. Large
custom daily demand is permitted by the current configuration normalizer.

### Half-ration partitioning

Relevant code: `scripts/resource/overview.js:516` and
`scripts/resource/calendar-watcher.js:2165`.
A Node probe called exported `applyConsumption` with a plain empty inventory
(no document writes), one consumer, food 1/day and half rations enabled:

| Days in one run | Requested units, measured as shortfall |
| --------------- | -------------------------------------- |
| 1               | 1                                      |
| 2               | 1                                      |
| 3               | 2                                      |

Thus two daily runs request 2 units and a two-day run requests 1. This is a
reproduced behavior with an explicit batching comment in source; deciding the
replacement semantics is part of PS-03, not a claim that fractional consumption
is necessarily the campaign's intended rule.

## Edge-testing plan

Keep the existing focused suites, adding assertions at the boundaries they do
not currently prove. Pure-function tests alone cannot prove a GM-to-player
round trip or native Foundry multi-client recovery.

| Area                          | Existing test files                                                                                     | Additional edge coverage                                                                                                     |
| ----------------------------- | ------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| Outlook and player projection | `test-resource-overview.mjs`, `test-resource-overview-app.mjs`, `test-resource-overview-service.mjs`    | Double sanitization, readiness thresholds, historical selected-resource labels, hidden actors after permission changes       |
| Stashes and roster            | `test-resource-roster.mjs`, `test-resource-manager-roster.mjs`, `test-resource-consumption.mjs`         | Uneven inventories, deleted source during confirmation, stash-only roster, repeated daily versus batched demand              |
| Calendar and selection        | `test-resource-calendar.mjs`, `test-resource-manager-advance.mjs`, `test-resource-upkeep-lease.mjs`     | Close versus Skip versus empty selection, capped jumps with pending dialog, backward time, resource removed while selecting  |
| Writes and recovery           | `test-resource-write-accounting.mjs`, `test-resource-operation-*.mjs`, `test-resource-run-state-v5.mjs` | Real caller integration, interruption at every write/checkpoint boundary, ambiguous partial writes, same-user competing tabs |
| Protocol and hub              | `test-resource-socket.mjs`, `test-forage-prompt-protocol.mjs`, `test-player-hub-supplies-sync.mjs`      | Permission changes during reply, delayed old replies, sustained invalidation bursts, offline persisted hub label             |
| Presentation                  | `test-ui-render-harness.mjs`, UI audit commands                                                         | Native player/GM roles, keyboard refresh/retry, narrow and zoomed layouts, long labels, late response after close            |

## Verification performed

- Local production-function probes reproduced PS-01, PS-02, and PS-03 without
  changing Foundry data.
- All 27 focused test files matching `test-resource-*`,
  `test-player-hub-supplies*`, and `test-forage-*` passed. These are test-file
  counts, not individual assertion counts. Existing green checks did not detect
  the three separately reproduced edge cases above.
- The layout audit passed for all six Party Supplies fixtures (normal, offline,
  loading, error, empty, disabled) across all 14 scenarios, including mobile,
  compact/coarse controls, short windows, 200% zoom, reduced motion, and forced
  colors. It exercised 98 action clicks. Local screenshots are in
  `tmp/playwright/ui-layout-3LeFoD/` (generated evidence, not committed).
- The broader `npm run check` and unfiltered `npm run ui:audit` were started,
  then intentionally stopped after narrowing verification to this assessment's
  scope. Neither is claimed as a complete passing module-wide run.
- The assessment passed Prettier and whitespace checks. Only this document is
  changed; no runtime fixes or regression tests have been implemented.
- No live Foundry session, player socket capture, network-partition experiment,
  deployment, or installed-version verification was performed. Native acceptance
  remains outstanding; synthetic layout success must not be described as live
  multiplayer proof.

## Suggested implementation order

1. Fix PS-01 and PS-02 with focused regression tests through the player boundary.
2. Resolve PS-03 rules, then share demand calculation with the PS-06 preview.
3. Implement PS-07 and PS-08 for clearer player decisions and upkeep receipts.
4. Resolve PS-05 and verify privacy transitions with PS-09.
5. Integrate PS-04 in a separate recovery-focused change with isolated-world
   failure injection; finish documentation reconciliation and PS-11 acceptance.

These are proposed improvements only. Each implementation should preserve the
existing authority, stale-clock, late-inventory, selection, and readback guards.
