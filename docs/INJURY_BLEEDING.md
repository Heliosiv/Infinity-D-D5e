# Durable Internal Bleeding

Implemented locally on 2026-09-13. No campaign installation or release.

The authoritative GM vault must be unlocked when combat starts.
At combat start, enabled and unsuppressed Internal Bleeding injuries roll 1d6;
on a 1, they deal 1d4 damage. Temporary HP absorbs damage first, then current HP
falls to a minimum of zero. Each injury rolls once per Combat document. Repeated
hooks, duplicate combatants for one Actor and restarting that Combat do not
repeat it. Distinct unlinked Token Actors are handled separately.

The existing encrypted injury workflow and checkpoint store the combat plans,
saved dice, before/after HP, application leases and completion receipts. Combat
flags are not authoritative. The HP update also writes an Actor receipt in the
same document operation. A replacement GM can recognize completed damage even
if HP subsequently changed. The public chat message has a saved document ID,
so a lost reply cannot duplicate it. Deleting a completed chat message does not
recreate it on startup.

Disabled/suppressed effects at the start are excluded. An effect removed or
disabled before an unapplied HP write is skipped. If its damage already saved,
later disabling or curing does not undo that damage. Historical combats without
a stored plan are not processed retroactively. V2/V3/V4 recovery rules are
unchanged by this work.

## Interrupted work

Reloading/reconnecting the authoritative GM with the vault unlocked resumes
saved plans. A same-GM session lease can delay recovery for up to one minute.
Missing Actors or conflicting current HP stop an unapplied event; the system
does not overwrite newer HP or reroll its saved dice.

For a reviewed HP conflict, the GM can explicitly skip the unapplied event
without changing HP. In the browser console, substitute the actual Combat ID
and pending event ID from the private ledger:

```js
const workflow =
  await import("/modules/infinity-dnd5e/scripts/injury/workflow-store.js");
workflow.readCriticalInjuryBleeding("COMBAT_ID"); // Inspect the saved event first.
const bleeding =
  await import("/modules/infinity-dnd5e/scripts/injury/bleeding.js");
await bleeding.skipPendingCombatBleeding(
  game.combats.get("COMBAT_ID"),
  "EVENT_ID",
);
```

Skipping refuses active leases, completed events and an Actor receipt showing
damage already applied. Applied damage should resume completion, not be skipped.
Keep pending combats available until recovery finishes. Receipts are retained;
this change does not add an automatic archival or deletion policy.

## Evidence and limits

- `node scripts/test-critical-injury-bleeding.mjs`: temporary HP, HP floor,
  disabled/suppressed effects, duplicate delivery, synthetic Token Actor identity,
  no-damage roll, saved dice, lost Actor reply, replacement GM, newer HP after
  applied damage, HP conflict, explicit skip, cure during the damage roll,
  non-GM refusal, historical combat refusal and chat replay.
- All 25 injury suites pass, including workflow/checkpoint, Infection rest,
  treatment authority, calendar and V2/V3 preservation tests.
- `node scripts/audit-bleeding-foundry.mjs --test-world=downtime-gauntlet`:
  disposable Foundry 13.351/D&D5e 5.3.3, actual Actor/Combat/private-ledger/chat
  writes, temporary HP, disabled effect, interrupted completion, replacement GM,
  reload and rejected player Combat write. Dice and the interruption are
  deterministic fixture substitutions. Evidence: `output/playwright/bleeding/`.

This is a direct HP update, not D&D5e/Midi-QOL's complete damage workflow. It does
not add resistance, immunity, damage reactions or extra death-save handling.
Player-owned HP/Actor flags remain player-editable; the private ledger determines
the approved plan. Native testing used canvas-disabled linked Actors; unlinked
Token identity and suppressed effects were exercised in the source fixture.

Formatting, diff checks and the local development ZIP build passed. The broader
non-injury suite was not repeated for this slice.
