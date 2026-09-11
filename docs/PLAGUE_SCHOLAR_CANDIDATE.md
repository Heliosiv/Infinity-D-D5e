# Plague Scholar candidate 0.3.37

This local candidate combines the artwork commit `99df546` with the reconciled
UI candidate `1e198ac`, which includes released `v0.3.36`. It preserves active
hunting, recipes, personal training, journals, field ammunition, shop controls,
and the Settings and activity-draft fixes. Compared with `1e198ac`, gameplay
JavaScript and templates are unchanged; the additions are UI artwork, shared
presentation, the asset check, and documentation.

The two generated textures and nine revised emblems total 497,716 bytes.
They decorate the module's windows, headers, buttons, tabs and launcher cards.
See [asset provenance](../assets/ui/PROVENANCE.md).

## Package and verification

The installable local ZIP is `release/module.zip` in the candidate worktree.
It is version **0.3.37**, approximately **14.48 MiB**, with SHA-256:

```text
e332a71717d00797e240ca04fd175b2fcc1ad3fee759c9bac72b2aaee00eb114
```

Archive verification passed. All **240 runtime and UI asset files** matched
the source and the extracted package. The extracted ZIP passed **75 native
Foundry UI scenarios**, including GM/player windows at four screen sizes,
refreshes, drafts, picker selection and reconnect. All **11 active UI assets**
were also fetched from the test server and compared byte-for-byte with source.

Native testing used a separate copy of the disposable `downtime-gauntlet`
world, Foundry **13.351**, D&D5e **5.3.3**, and only this module enabled.
Canvas rendering was disabled. Foundry's own minimum-screen warning remains
at small sizes; scene rendering and third-party module compatibility are not
covered. The test server was stopped after verification.

All **184 source checks** and **106 accessibility fixtures** passed, as did
formatting and the keyboard, downtime, hunting and workbench journeys.
The full layout sweep passed **106 fixtures across 14 display scenarios**,
including **18,242 action clicks** and **504 row double-clicks**.

The native desktop preview is
`output/playwright/native-ui/plague-scholar-desktop.png`. Final source and layout
results and the completed commit are recorded in `release/CANDIDATE_EVIDENCE.json`.

## Remaining release boundary

This is a local candidate, not a published or deployed release. No remote tag,
push, public release, Forge installation or live campaign change is included.
The canonical download URLs in its manifest describe the future release;
they are not evidence that version 0.3.37 is publicly available.

The existing restricted-Journal privacy limitation remains: authenticated
players can inspect hidden workflow flags in the baseline candidate. This
artwork pass does not fix it or repeat that privacy test. See the baseline
[candidate report](UI_CANDIDATE_0.3.37.md) for evidence and limits. This package
must not be described as protecting hidden campaign data or as passing every
release gate.

Before public/live delivery, the exact-tag source gate, clean tagged CI,
public archive/hash comparison, campaign backup, Forge install and runtime
readback remain separate steps. Publishing and deployment require approval.

To undo the reconciliation on its branch, use `git revert -m 1 <merge-commit>`.
The first parent is the original artwork commit `99df546`.
