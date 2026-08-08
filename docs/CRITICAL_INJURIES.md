# Critical Injury Table V2

Infinity D&D5e owns the full recovery workflow for player characters who get
back up after reaching 0 hit points or having their dead/unconscious state
removed.

## Player and GM flow

1. An owned `character` Actor moves from 0 HP to a positive HP value, or its
   dead/unconscious/defeated state is removed while it has positive HP.
2. The active full GM receives a **Critical Injury?** Yes/No prompt. No injury
   is created unless the GM approves it.
3. The approved roll is stored on the Actor and sent only to an assigned or
   owning player. If that player reconnects, the pending roll reopens.
4. The player clicks **Roll d100**. The active GM authenticates the socket
   sender and verifies the Actor, pending approval, and d100 range before any
   mutation.
5. The result's secondary detail and recovery duration are rolled. An Active
   Effect is added to the character, the result is whispered to the player and
   GMs, and the recovery interval is added to Simple Calendar when available.
6. When the due time arrives, temporary effects are removed. Shattered Knee
   and Nerve Damage become permanent if their required treatment was not
   completed in time.

Pending rolls and applied injuries live on the Actor, not in client-local
state. Actor, inventory, Active Effect, and calendar writes are performed only
by the authoritative full GM.

## Version 2 table

| d100  | Injury              | Recovery or treatment                                                                    |
| ----- | ------------------- | ---------------------------------------------------------------------------------------- |
| 1–5   | Lost Limb           | Permanent; Regenerate or divine magic                                                    |
| 6–10  | Crippling Injury    | 1d4 days, or 2 kit charges + DC 12 Medicine                                              |
| 11–15 | Concussion          | 1d4 days, or 1 kit charge                                                                |
| 16–20 | Broken Arm          | 2d4 days, or 2 kit charges to downgrade to Crippling Injury with half the remaining days |
| 21–25 | Fractured Ribs      | 1d4+1 days, or 2 kit charges                                                             |
| 26–30 | Internal Bleeding   | 3 kit charges + DC 15 Medicine, or suitable magic                                        |
| 31–35 | Deep Cut            | 1 kit charge, or 1 hour + DC 13 Medicine                                                 |
| 36–40 | Loss of Eye         | Permanent unless magically restored                                                      |
| 41–45 | Loss of Hearing     | Permanent unless magically restored                                                      |
| 46–50 | Shattered Knee      | 1 week, or 3 kit charges; permanent if untreated                                         |
| 51–55 | Dislocated Shoulder | 1d6 days                                                                                 |
| 56–60 | Infection           | 2 kit charges                                                                            |
| 61–70 | Minor Injury        | 1 kit charge, or 1d3 days                                                                |
| 71–80 | Deep Scar           | Permanent                                                                                |
| 81–90 | Psychic Trauma      | 1 week, or 2 kit charges + DC 13 Insight                                                 |
| 91–95 | Nerve Damage        | 1 week, or 2 kit charges + DC 13 Constitution; a failed treatment makes it permanent     |
| 96–99 | Nightmares          | Remove Curse, or 4 kit charges                                                           |
| 100   | Soul-Shaken         | Permanent unless resolved by divine magic or a narrative quest                           |

The table also rolls the affected limb for Lost Limb and Crippling Injury,
maximum-HP loss for Deep Cut, and the affected ability for Nerve Damage.

## Healer's Kit treatment

The player requests treatment from the injury window. The active GM sees the
exact charge cost, inventory sources, required check, and a healer selector.
Charges can be drawn from Healer's Kit items carried by owned player
characters; the injured character's and selected healer's kits are preferred.

All required sources are checked before the first write, each charge change is
read back, and charges are consumed even when the treatment check fails. A
successful treatment stabilizes the injury, so its recovery progresses twice
as fast. Broken Arm also downgrades to Crippling Injury and halves its remaining
days. The kit action is unavailable for permanent injuries and table entries
that do not permit kit treatment.

## Automation boundaries

Core Active Effects plus Midi-QOL flags apply penalties that have exact data
paths: movement, maximum HP, ability/skill bonuses, saves, checks, and attack
disadvantage. Internal Bleeding runs its combat-start roll and damage, and
Infection runs its DC 15 Constitution save after each long rest.

Some table text is conditional or narrative and cannot be represented by one
safe blanket modifier. Examples include a lost arm's equipment restrictions,
Fractured Ribs damage only while Dashing, sound-only Perception, visible-scar
social context, first-initiative-of-the-day disadvantage, and magical or quest
recovery. Those rules remain clearly visible on the Actor effect and in the
player window for the GM to adjudicate. The GM can remove a permanent Active
Effect after the required magic or narrative resolution.

## Integrations

- **Midi-QOL**: disadvantage flags for attacks, checks, saves, and skills.
- **DAE**: persistent Active Effect handling and character-sheet visibility.
- **Simple Calendar**: player-visible recovery intervals and due dates.
- **Times Up**: removal of ordinary timed effects. Injuries that can become
  permanent are deliberately retained until this module resolves that state.

These modules are recommended, not hard requirements. Without Midi-QOL/DAE,
the injury record and core-compatible changes still exist; without Simple
Calendar, the recovery timestamp remains on the Actor and is processed from
Foundry world time.
