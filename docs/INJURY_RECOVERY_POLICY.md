# Treatment-dependent recovery proposal

Status: assessed locally on 2026-09-13 against `a92e1fa`; proposed rules await
campaign approval. This document changes no runtime rules or saved injuries.

## Reproduced behavior

Run `node scripts/audit-injury-recovery-policy.mjs` from the repository root.
The synthetic Node audit calls the real resolution builder, effect builder,
Tend the Sick planner and expiry service for each injury under both V2 and V3.
All eight cases remain before their deadline, are deleted untreated at the
deadline, and do not process again after deletion. Each also has an Active Effect
seconds duration. Tend the Sick can shorten each untreated injury by one day;
its planner can complete Deep Cut in one successful care session.

| Injury            | Untreated automatic expiry | Printed recovery requirement                                  |
| ----------------- | -------------------------- | ------------------------------------------------------------- |
| Internal Bleeding | 3 days                     | 3 kit charges and DC 15 Medicine, or suitable magical healing |
| Deep Cut          | 1 day                      | 1 kit charge, or 1 hour of rest and DC 13 Medicine            |
| Infection         | 3 days                     | 2 kit charges                                                 |
| Nightmares        | 7 days                     | Remove Curse, or 4 kit charges to ease mental symptoms        |

Additional source findings: `buildCriticalInjuryTreatmentOutcome` in
`scripts/injury/service.js` stabilizes successful kit treatment and halves the
remaining calendar recovery time, with a minimum of one day. It does not
immediately cure these injuries. Deep Cut's definition supplies DC 13 Medicine
to the kit path as well; the printed rest alternative has no dedicated action.
V3 inherits these four definitions from V2 with some roll-band changes.

The audit uses core-time fallback days and synthetic effects without calendar
entries. It does not establish native Foundry, Simple Calendar or Times Up
acceptance. Treatment outcome findings above are source inspection, not a new
end-to-end treatment reproduction. The audit is deliberately separate from the
desired-behavior regression suite: update or retire its expectations when the
approved policy is implemented.

Local validation passed: the eight-case audit, injury table, expansion, effects,
treatment-authority and calendar-range suites, plus formatting and diff checks.
No runtime code changed, so no module build or native UI acceptance was run.

## Recommended campaign policy

For newly resolved injuries under a new rules version, all four persist until
their specified treatment succeeds. Time, ordinary rest and Tend the Sick do
not cure or shorten them. They are treatable conditions, not permanent injuries.

| Injury            | Proposed cure                                                                                                                                                                                                                             |
| ----------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Internal Bleeding | Spend 3 kit charges and succeed on DC 15 Medicine, or obtain GM-confirmed suitable magical healing. Either success cures immediately. A failed kit attempt spends its charges and leaves the injury active.                               |
| Deep Cut          | Spend 1 kit charge with no check, **or** complete 1 hour of rest and succeed on DC 13 Medicine. Either success cures immediately. Failed rest treatment leaves the injury active and consumes no kit charges.                             |
| Infection         | Spend 2 kit charges with no check to cure immediately. Remove the injury's accumulated maximum-HP penalty. Its existing long-rest checks continue while untreated.                                                                        |
| Nightmares        | Remove Curse or 4 kit charges cures immediately, with no Medicine check. This deliberately interprets “ease the mental symptoms” as a full cure; it needs campaign approval because the current wording does not settle that distinction. |

Removing a maximum-HP penalty does not grant current HP. Magical treatment must
be explicitly confirmed by the GM; an arbitrary healing event is not proof of
suitable magic or Remove Curse. For Deep Cut, the GM confirms the hour of rest
and the selected treating character makes Medicine. No automatic new retry
limit is proposed; each rest attempt requires its own completed hour.

Approval requested: adopt these four policies for new injuries, including the
Nightmares full-cure interpretation, while preserving existing V2/V3 injuries.

## Implementation boundary after approval

1. Add a new table/rules version with explicit treatment-dependent recovery.
   Preserve V2/V3 definitions, saved resolutions, treatment receipts and replay
   behavior. New version dispatch must keep all three versions available.
   Unresolved requests without a saved resolution use the new active table;
   already resolved requests retain their recorded version. Do not silently
   migrate active injuries; any later conversion needs a separate reviewed plan.
2. Model treatment-dependent recovery explicitly throughout resolution storage,
   validation, effects, treatment, expiry and care eligibility. Merely setting
   `recoveryDueTs` to null is unsafe: existing expiry and effect code coerce null
   to zero. Omit timed duration and show “Requires treatment”; never substitute
   `permanent: true`. Keep timed injuries and untreated permanence deadlines intact.
3. Add reviewed rest and magical-treatment actions alongside kit treatment.
   Persist the approved method, roll, charges and cure result before applying
   effects. Reuse authority/lease and resource receipts so retries and GM handoff
   cannot repeat consumption or cure a different injury. Preserve the receipt
   after removing the effect and reconcile an uncertain deletion response.
4. Keep an untreated injury's calendar entry open without a fabricated recovery
   date. Complete it at the confirmed cure time. Preserve the existing retry
   boundary when the calendar write fails, and distinguish manual removal from
   recovery. Player-facing prompts describe the method and difficulty; numeric
   check DCs remain GM-only.
5. Verify each successful, failed and unaffordable method; elapsed time and care
   must not bypass treatment. Cover max-HP penalty removal without HP grants,
   missing/invalid dates, duplicate requests, lost replies, GM handoff, calendar
   failure/retry and V2/V3 replay. Then exercise player/GM workflows in the
   disposable native world, including an authenticated-player transport check.

Deferred: durable Bleeding damage with temporary HP and disabled-effect handling,
Nightmares mechanical enforcement, Nerve Damage permanence wording, Broken Arm
recovery arithmetic, crafting, release and live installation. These are separate
roadmap slices, not implied by approving this recovery policy.
