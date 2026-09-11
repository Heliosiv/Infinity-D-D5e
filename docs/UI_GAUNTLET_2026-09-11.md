# UI gauntlet — September 11, 2026

Local UI pass on `codex/downtime-expansion-assessment`. The attachment directory
present at the start was left untouched. No push, release, Forge installation,
world reload, or campaign-data writes were performed.

## Fixes

- Background refreshes no longer take keyboard focus from another window.
  Restoration checks again when its animation frame runs, so newer clicks win.
- Text-field refreshes preserve selection start, end, and direction. Disabled
  controls and removed windows are ignored by pending restoration.
- Search picker selection updates the existing controls, selected styling,
  accessible state, and confirmation button without rebuilding the list.
- Narrow merchant inventory cards retain visible labels for Qty, Restock to,
  Custom gp, and Unlimited after the table headers disappear.

## Verification

Completed results:

- All 104 fixtures passed across the 14 layout scenarios: 17,612 action clicks
  and 504 row double-clicks, with no layout/click audit issues.
- The four affected inventory fixtures passed an additional 14-scenario sweep.
- All 104 fixtures passed accessibility again after the changes.
- Keyboard, workbench, downtime, focused unit checks, and formatting passed.
- The full source check has the one pre-existing version failure described below.

The layout harness contains 104 states spanning the dashboard, settings,
dialogs, loot modes, shop directory and editors, trading, supplies, downtime,
injuries, and reputation. It includes loading, empty, offline, pending, recovery,
and error states. Layout checks click rendered controls and check reachability;
they do not prove every control's business behavior.

The matrix includes window widths of 1040, 720, 520, and 380 pixels, comfortable
and compact density, coarse pointers, 500-pixel height, 200% CSS zoom, reduced
motion, and forced colors. This pass adds actual 1920×1080, 1366×768, and 412×740
browser viewports. CSS zoom is not native browser zoom or operating-system DPI.

Real-controller browser journeys use in-memory campaign storage. They cover
shop organization, independent merchant editors, autosave focus/disclosures and
scrolling, failed saves, draft recovery, retries, pending requests, faction
navigation, downtime setup/allocation/review/apply, and receipts at three widths.
The changed merchant workflow was rerun after adding inventory labels.

Keyboard regression coverage uses the production focus hooks and picker actions
in Chromium, including competing windows, selection, queued focus races,
disabled controls, removed windows, and repeated picker selection/deselection.
Representative narrow-screen screenshots were also visually inspected.

Run the same gates with:

```powershell
npm run check
npm run format:check
npm run ui:audit
npm run ui:audit:a11y
npm run ui:audit:keyboard
npm run ui:audit:workbench
npm run ui:audit:downtime
```

## Existing release limitation

The full source run passed 181 of 182 check scripts. `test-manifest-compat.mjs`
fails because the branch declares 0.3.27 while the latest local tag is v0.3.36.
These version files were unchanged by this pass. A release needs reconciliation
with the intended release source; bumping the number alone does not establish
that this branch contains the released changes.

This is browser-harness verification, not acceptance in a running Foundry world.
Native Foundry window lifecycle, installed-module interactions, multiplayer
latency, and user acceptance remain unverified. No claim is made that every
possible edge case is covered or that a release is ready.
