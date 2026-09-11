# UI reconciliation candidate 0.3.37

This local candidate reconciles `7db7f7e` with the released `v0.3.36` line in an isolated worktree. It retains active hunting, recipes, personal training, journals, location and shop improvements, and the branch's field-ammunition workflow and UI stability fixes. The original checkout is unchanged.

## Behavior

- Search pickers retain their list, focus and scroll during repeated selections.
- Background refreshes respect the active window; text controls retain their selection.
- Settings retain unsaved values, focus and scroll through refreshes and Restore guides. Failed saves preserve drafts. Edits made while saving remain pending for another save.
- Player activity cards retain unsubmitted hours, skill and source selections across refreshes, scoped to the actor and downtime block. Removed options fall back to the current valid choices.
- Crafting previews follow the selected duration, including source-specific cost, materials and affordability, with the same quote shown in the queued summary. Refresh keeps allocation buttons disabled until the pending command finishes. The native 16-hour scroll case exposed both a draft reset and an eight-hour quote mismatch; both are covered by regression tests.
- Narrow shop inventory cards label their stock and price controls.

## Unresolved baseline limitation

The installed privacy gate still fails: Foundry 13.351 sends restricted Journal flags to authenticated player clients. The player can read downtime workflow history and activity outcomes even though the Journal is invisible. This is documented in `v0.3.36` and predates this pass; see [Permissions and privacy](DOWNTIME_SYSTEM.md#permissions-and-privacy). No storage migration or confidentiality fix is included. The failing gate remains enabled. This candidate must not be described as fully green or as protecting campaign secrets.

## Verification

- All 184 source checks passed, including regression tests for failed saves and edits during saves.
- Layout: 106 fixtures across 14 display scenarios; 18,242 action clicks and 504 row double-clicks.
- Accessibility: all 106 fixtures passed the automated audit.
- Keyboard, downtime, hunting and shop journeys passed.
- Installed core journeys passed: duplicate-GM navigation and handoff, cancelled rolls, retry without reroll, individual payments/receipts, custom activities, GM/player reconnect and payment recovery without duplicate rewards.
- Installed crafting passed: two half-days with GM reload, native scroll creation, source-preserving scroll copying, exact GP/material readback, and matching card/queue/GM quotes. Its final privacy gate still fails as described above.
- All eight installed library activities passed, including one-hour reflection, maximum 240-hour allocation and duplicate-apply protection. The overall command still exits unsuccessfully at its separately reported, pre-existing privacy gate.
- Native Foundry ApplicationV2: 11 GM and 7 player entry points across 1920x1080, 1366x768, 1024x600 and 412x740; 75 scenarios passed against the extracted candidate ZIP, including draft preservation, repeated picker selections and reconnect. The focused draft check additionally verifies Settings focus and scroll.

Native testing uses a copied disposable `downtime-gauntlet` world, Foundry V13 build 351 and D&D5e 5.3.3. The module is the only active module. Canvas rendering is disabled in the UI sweep; scene graphics and third-party module compatibility are not covered. Foundry's own minimum-screen warning remains on small viewports. Automated checks cannot establish every possible edge case or human acceptance.

## Repeat the native sweep

Use a disposable local world named `downtime-gauntlet`, with password-free test users `Gamemaster` and `Gauntlet Player`, at `http://127.0.0.1:32173`. Install this candidate and initialize its private state before testing. The script verifies the world and module version and writes screenshots/results beneath `output/playwright/native-ui`.

```powershell
npm run ui:audit:native -- --test-world=downtime-gauntlet
npm run ui:audit:downtime:foundry -- --test-world downtime-gauntlet --url http://127.0.0.1:32173
```

The downtime gauntlet creates and changes disposable test actors, blocks and items. Do not point it at a campaign. An interrupted run may leave a test block that must be completed before retrying. Untouched collecting blocks with the exact gauntlet location prefix and marked participants can be cancelled safely by the runner. Its UI selectors now distinguish current receipts from the journal and explicitly choose Custom when testing activities outside a location preset. The activity journey respects whole-block durations and explicitly selects the intended allocation hours.

## Release boundary

The 14.01 MB `release/module.zip` passed archive verification and the native sweep after extraction. All 228 runtime JavaScript, template and style files in the archive match the tested source. SHA-256: `5a0ab136b2a21af099a9da314905a0f4687f9aca156926383543375835f08c89`.

This is a local candidate, not a published release. Build with `node scripts/build-release.mjs` after the source checks pass, then verify the extracted package in the disposable Foundry installation. The exact-tag release gate, clean tagged CI, public artifact/hash comparison, campaign backup, Forge installation and runtime readback remain separate release steps. No push, public tag, release or live campaign installation is included.

To undo the local work, return to the original checkout, or revert the merge commit with `git revert -m 1 <merge-commit>` on this isolated branch.
