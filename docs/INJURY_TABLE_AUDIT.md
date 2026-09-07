# Critical Injury Table V2 — automation audit and expansion proposal

**Historical audit of the original 18 outcomes.** The subsequent
[V3 expansion](INJURY_TABLE_EXPANSION.md) adds 12 temporary outcomes with
numeric automation, bringing the current chart to 30. Those additions are
implemented; the older effect and recovery gaps below remain unchanged.

Audit date: 2026-09-07. Scope: the local Infinity D&D5e source, its existing tests,
and the GM reference viewer. The combat rules audited were present at commit
3535f84. This is not verification of the installed Forge world or its module
versions. No injury rules, roll probabilities, Actor data, or live world data
were changed in this pass.

## Finding

**The table is not fully automatic.** All 18 outcomes cover d100 1–100 without
gaps or overlapping ranges. Eight entries have a supported penalty/trigger,
five have partial or overly broad enforcement, four leave their mechanical
effect to the GM, and one intentionally has no combat penalty. Supported means
there is an implementation; it does not mean the entire injury, its recovery,
or the installed integrations have passed live acceptance.

The new **Injuries → Injury table** view reads names, roll bands, descriptions,
detail rolls, and recovery data directly from the same table used for rolls.
Its audit notes distinguish existing behavior from rules requiring attention.

## Priority findings

1. **Recovery contradicts the table for four treatment-dependent injuries.**
   Internal Bleeding and Infection expire after 3 days, Deep Cut after 1 day,
   and Nightmares after 7 days. Their written recovery requires treatment or
   magic. The roll service assigns those deadlines and expiry processing removes
   them. Decide whether to remove those timers or explicitly rewrite the rules.
2. **Four mechanical effects have no enforcement:** Broken Arm restrictions,
   sound-only Perception for Loss of Hearing, fear/charm-only saves for Psychic
   Trauma, and both Nightmares rules. Fractured Ribs lacks Dash damage and
   Shattered Knee does not prevent Dash. Equipment, hand use, scar visibility,
   and contextual rolls need a defined GM/player choice before automation can
   apply the right consequence without penalizing unrelated actions.
3. **Treatment behavior needs a rules decision.** Successful kit use normally
   stabilizes and doubles recovery speed; it does not immediately cure an injury.
   Broken Arm additionally halves the remaining days, producing approximately
   one-quarter of the original time. Deep Cut's kit path requires DC 13 Medicine
   even though its wording attaches that check to the one-hour rest alternative;
   that alternative has no dedicated action. Untreated Nerve Damage becomes
   permanent on day 7, although its entry only names a failed treatment save.
4. **Some enforcement is too broad.** Crippling Injury applies disadvantage to
   all weapon attacks for an injured arm, regardless of the limb used. Deep Scar
   applies its social modifiers even when hidden. Leg penalties change walking
   speed only. Concussion and Dislocated Shoulder emit ability-check flags;
   propagation to related skill rolls needs verification in the installed system.
5. **Internal Bleeding is implemented but weaker than the other durable workflows.**
   It subtracts current HP directly rather than using the system damage workflow,
   bypassing temporary HP. Its combat guard is a session-local Set populated
   before rolls/writes, with no saved damage receipt: reload/handoff loses the
   guard, and failure during a combat pass leaves that session marked processed.
   Replaying a start after reload can reapply damage; a new GM does not have a
   stored pending damage result to recover. Disabled injury effects are not
   filtered out by the shared injury-effect lookup used by these custom handlers.

## Entry-by-entry audit

Status applies to the injury's mechanical effect. Recovery and GM follow-up are
separate; every entry still uses the existing approval/roll/record workflow.

| d100  | Injury              | Effect status     | Existing automation                                                                                                        | Gaps and recovery review                                                                                                                                                                                                                      |
| ----- | ------------------- | ----------------- | -------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1–5   | Lost Limb           | Partly automated  | A rolled leg halves walking speed.                                                                                         | Arm equipment restrictions and restoration by magic require the GM. Other movement speeds are unchanged.                                                                                                                                      |
| 6–10  | Crippling Injury    | Partly automated  | A rolled leg halves walking speed. A rolled arm adds disadvantage to all weapon attacks. Disadvantage requires Midi-QOL.   | The penalty is not limited to the injured limb. Limb-dependent checks and shield protection are not enforced.                                                                                                                                 |
| 11–15 | Concussion          | Effect supported  | Intelligence/Wisdom check and save disadvantage; passive Perception −5. Disadvantage requires Midi-QOL.                    | Ability-linked skill rolls need installed-world verification; the effect emits ability-check flags, not individual skill flags.                                                                                                               |
| 16–20 | Broken Arm          | GM applies effect | Injury, recovery deadline, and kit downgrade are recorded.                                                                 | Weapon, shield, and somatic-component restrictions are not enforced. Kit treatment halves remaining days and then doubles recovery speed: roughly one quarter of the original remaining time, not simply half.                                |
| 21–25 | Fractured Ribs      | Partly automated  | Dexterity-save and Constitution-check disadvantage. Disadvantage requires Midi-QOL.                                        | The GM must apply the 1d4 damage from Dashing.                                                                                                                                                                                                |
| 26–30 | Internal Bleeding   | Effect supported  | Combat start rolls 1d6; on a 1, rolls 1d4 and subtracts it from current HP.                                                | Damage bypasses temporary HP and the system damage workflow. Combat duplicate protection lasts only for the current GM session. Automatically expires after 3 days even though the written rule requires treatment or magic.                  |
| 31–35 | Deep Cut            | Effect supported  | Rolled 1d6 maximum-HP reduction is applied through an Active Effect.                                                       | The one-hour rest plus Medicine alternative has no dedicated action. Automatically expires after 1 day despite 'until treated'. The kit path also requires DC 13 Medicine, although the text assigns that check to the rest alternative.      |
| 36–40 | Loss of Eye         | Effect supported  | Perception disadvantage and ranged weapon/spell attack disadvantage. Disadvantage requires Midi-QOL.                       | Magical restoration requires the GM to remove the injury.                                                                                                                                                                                     |
| 41–45 | Loss of Hearing     | GM applies effect | Permanent injury is recorded.                                                                                              | Sound-based Perception disadvantage and magical restoration require the GM.                                                                                                                                                                   |
| 46–50 | Shattered Knee      | Partly automated  | Walking speed is halved; untreated deadline converts the injury to permanent.                                              | Dash is not blocked. Other movement speeds are unchanged.                                                                                                                                                                                     |
| 51–55 | Dislocated Shoulder | Effect supported  | Strength-check and melee weapon/spell attack disadvantage. Disadvantage requires Midi-QOL.                                 | Strength-linked skill rolls need installed-world verification; only the ability-check flag is emitted.                                                                                                                                        |
| 56–60 | Infection           | Effect supported  | Long-rest DC 15 Constitution save; each failure adds 1 maximum-HP loss. Saved rest receipts prevent duplicate application. | A confirmed rest and active GM are required; interrupted work uses the existing recovery flow. Automatically expires after 3 days although the written recovery lists only 2 kit charges.                                                     |
| 61–70 | Minor Injury        | No combat penalty | Recovery is tracked; the table intentionally has no combat penalty.                                                        | Describe bruising, limping, or other cosmetic consequences.                                                                                                                                                                                   |
| 71–80 | Deep Scar           | Partly automated  | Intimidation +1 and Persuasion −1 are applied continuously.                                                                | Visibility is not checked. The GM must account for a concealed scar.                                                                                                                                                                          |
| 81–90 | Psychic Trauma      | GM applies effect | Injury and recovery are recorded.                                                                                          | Fear/charm-only save disadvantage is not implemented.                                                                                                                                                                                         |
| 91–95 | Nerve Damage        | Effect supported  | The rolled ability is reduced by 1. Failed treatment makes it permanent.                                                   | The GM still decides magical or narrative restoration. Also becomes permanent at the untreated 7-day deadline; the table text only specifies a failed Constitution treatment save.                                                            |
| 96–99 | Nightmares          | GM applies effect | Injury and recovery are recorded.                                                                                          | First daily initiative disadvantage and blocking exhaustion recovery on long rests are not implemented. Remove Curse is not detected. Automatically expires after 7 days even though the written rule requires Remove Curse or 4 kit charges. |
| 100   | Soul-Shaken         | Effect supported  | Wisdom saves receive a permanent −1 bonus.                                                                                 | Divine magic or quest resolution requires the GM to remove the injury.                                                                                                                                                                        |

## What already has strong protection

The authoritative GM owns approved injury rolls, effect creation, kit spending,
treatment outcomes, and Infection rest results. These workflows use saved
identities, authority checks, and replay receipts. Existing tests cover ordinary
retries and GM handoff. Injury expiry and calendar reconciliation have separate
checks. The combat-start Bleeding handler does not share the same saved receipt
boundary, and should not be described as equally durable.

## Proposed next work — not applied

First settle the recovery rules above, then fill gaps in bounded steps:

1. Add explicit Dash handling for Ribs and Knee, and a saved combat damage receipt
   for Bleeding, with temporary-HP and retry/handoff tests.
2. Implement Nightmares with a saved first-initiative marker per campaign day and
   a narrowly scoped long-rest exhaustion adjustment. Test duplicate initiative,
   canceled rolls/rests, day rollover, and competing exhaustion effects.
3. Add context choices for injured-hand use, hearing-only checks, fear/charm saves,
   and visible scars. Apply only the relevant restriction, with a clear GM override.
4. Verify all effect paths and real rolls in the supported D&D5e + Midi-QOL/DAE
   versions, with each integration both enabled and missing. Roll-level verification
   must include ability-linked skills, passive Perception, stacked injuries,
   temporary HP, disabled effects, and treatment/removal cleanup.

### Expansion proposal

Keep severe-outcome probabilities unchanged initially. Split the existing
**61–70 Minor Injury** result using a secondary d4, giving four equally likely
mild variants (2.5% of the overall table each):

| d4  | Proposed injury  | Proposed mechanical effect                     | Proposed recovery |
| --- | ---------------- | ---------------------------------------------- | ----------------- |
| 1   | Bruising         | Cosmetic only, preserving a no-penalty outcome | 1d3 days          |
| 2   | Rattled Nerves   | −1 initiative                                  | 1d3 days          |
| 3   | Blurred Vision   | −2 Perception checks                           | 1d3 days          |
| 4   | Drained Vitality | −1d4 maximum HP, minimum maximum HP of 1       | 1d3 days          |

These are proposed house rules, not approved additions. Decide whether one kit
charge cures a mild injury or only accelerates recovery, whether penalties stack,
and whether Blurred Vision also changes passive Perception before implementation.
All four can have narrowly defined numeric effects, but their installed data paths
still need verification. Version new rules separately and preserve the recorded
V2 result for every existing injury; do not reinterpret active records on upgrade.

## Evidence and verification

- [Canonical table and Active Effect changes](../scripts/injury/table.js).
- [Effect creation, updates, and lookup](../scripts/injury/effects.js).
- [Roll, treatment, expiry, and combat-start service](../scripts/injury/service.js).
- [Rest hook capture](../scripts/injury/injury-app.js) and
  [saved workflow receipts](../scripts/injury/workflow-store.js).
- [Full table reference and audit notes](../scripts/injury/table-reference.js).
- [Table reference regression test](../scripts/test-critical-injury-table-reference.mjs)
  checks complete coverage, all secondary-roll variants, explicit audit coverage,
  known no-change entries, and Workbench navigation.
- The browser journey exercises the actual view/search controller and expanded
  automation notes. The layout harness includes the full table.

Foundry's [ActiveEffect API](https://foundryvtt.com/api/v13/classes/foundry.documents.ActiveEffect.html)
describes Actor effect application; the official
[D&D5e hook reference](https://github.com/foundryvtt/dnd5e/wiki/Hooks)
documents rest completion hooks. These API references do not establish that all
installed Midi-QOL flags work correctly. Installed-world effect and roll
acceptance is still required before calling the table fully automatic.

### Results for this pass

- Full source suite: **179 of 180 passed**. The sole failure is the unchanged
  release metadata: manifest 0.3.27 is older than repository tag v0.3.34.
- Injury browser journey: passed, including opening/searching all 18 outcomes,
  expanding automation notes, returning to party/log views, and existing token
  badge behavior.
- Targeted injury layout audit: passed all 11 scenarios, including narrow,
  touch, zoom, reduced-motion, and forced-color layouts.
- Accessibility: all **104 fixtures passed**. Keyboard journeys and formatting
  passed. Installed Forge-world verification was not performed.
