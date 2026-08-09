# Critical Injury Table V2

## v0.3.1 interface quick start

Players open **Home → Track the Campaign → Critical Injuries** or press `Shift+J`. The window and HUD identify the controlled character and share the same treatment status. HUD markers retain hover, focus, pin, touch, and Escape behavior with enlarged targets. Pending, offline, busy, successful, uncertain, and retry states explain whether the authoritative GM changed anything and what the player should do next.

Infinity D&D5e owns the full recovery workflow for player characters who get
back up after reaching 0 hit points or having their dead/unconscious state
removed.

## Player and GM flow

1. An owned `character` Actor moves from 0 HP to a positive HP value, or its
   dead/unconscious/defeated state is removed while it has positive HP.
2. The active full GM receives a **Critical Injury?** Yes/No prompt. No injury
   is created unless the GM approves it.
3. The canonical approval is stored in the restricted GM-only state. A
   sanitized pending button is mirrored to the Actor and sent to an
   assigned or owning player. The active GM also sees the approved roll as a
   fallback. If either user reconnects, the pending roll reopens for them.
4. The player clicks **Roll d100**. The request contains no dice result and is
   sent only to the active GM. That GM authenticates the socket sender and
   verifies the Actor against the private approval record.
5. The active GM rolls the d100, secondary detail, and recovery duration, then
   persists every value to a revisioned primary record and restricted recovery
   checkpoint. Before the first die, it claims a server-clock lease that is
   revalidated through the effect, calendar, and completion phases. A
   deterministic Active Effect ID and stable calendar marker let an interrupted
   retry adopt only the exact matching documents. The result is whispered to
   the player and GMs, and the recovery interval is added to Simple Calendar
   when available. Duplicate or retried requests reuse the same stored rolls
   and completed receipt, including across an active-GM handoff, without
   duplicating the public chat result.
6. When the due time arrives, temporary effects are removed. Shattered Knee
   and Nerve Damage become permanent if their required treatment was not
   completed in time.

Calendar replacements are written back to the injury before the prior note is
removed. Cleanup requires both the private completed receipt and the exact note
marker, so an owner-edited Actor flag cannot direct the GM to delete an
unrelated calendar entry.

The pending-button projection and applied injuries live on the Actor, not in
client-local state. The authorization and replay receipt live in the restricted
private-state Journal, which players cannot read or write. Actor, inventory,
Active Effect, private-state, and calendar writes are performed only by the
authoritative full GM.

On upgrade, old Actor-only pending buttons cannot prove that a GM approved the
roll. The active GM clears those unverified buttons and receives a warning so
the roll can be approved again if it is still needed. A rejected or failed
request sends a targeted explanation back to the requester; if a success
message is lost, the player window retains a safe receipt-retry button instead
of trusting an owner-writable effect as proof of completion. If the recorded
player no longer controls the Actor, the private approval and visible button
are moved to the active GM.

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

The player requests treatment from the injury window. The request is sent only
to the active GM and contains the Actor, injury, and a client-stable treatment
identifier. The player cannot choose the healer, dice result, inventory plan,
or outcome. The active GM verifies Actor ownership and the private completed
injury receipt, then sees the exact charge cost, inventory sources, required
check, and a healer selector. Charges can be drawn from Healer's Kit items
carried by owned player characters; the injured character's and selected
healer's kits are preferred.

Before the first Item, Active Effect, or calendar change, the module saves the
chosen healer, hidden treatment check, exact charge plan, starting injury, and
resulting injury in the restricted recovery record. Each charge change is read
back and marked with that private treatment receipt. If an update succeeds but
its response is lost, the retry adopts only the exact matching charge instead
of spending it again. Charges are consumed even when the treatment check fails.
Only one treatment can hold the planning lease at a time, and each persisted
Actor/kit Item source stays privately reserved until that treatment completes.
This prevents two different injuries from spending against the same starting
charge count while allowing an interrupted treatment that uses other kits to
be recovered independently.

The treatment identifier and a server-clock application lease keep timeouts,
reconnects, duplicate clicks, and active-GM handoffs on the same persisted
plan. A completed request replays its stored player result without another GM
prompt, check, kit spend, effect change, calendar note, or treatment chat
message. If the player starts a new request while their earlier one is still
unresolved, the player window is directed back to that earlier identifier so
the next click resumes it. Calendar retries use both the injury and treatment
markers, retain one deterministic recovery note, and remove only verified
marker-identical duplicates.

Run privileged Critical Injury work from one browser session per GM account.
Foundry does not provide an atomic compare-and-swap for the module's private
Journal replicas, so two simultaneous tabs logged in as the same active GM are
not a supported authority topology. Different-GM handoff and ordinary
same-session retries are covered by the persisted lease and receipts.

The private receipt and player retry path are the authoritative treatment
record. The whispered treatment summary is best-effort and deliberately
at-most-once: a browser closing after receipt completion but before chat
delivery can omit that convenience message, while reopening the injury window
and retrying still returns the stored treatment result.

A successful treatment stabilizes the injury, so its recovery progresses twice
as fast. Broken Arm also downgrades to Crippling Injury and halves its remaining
days. The kit action is unavailable for permanent injuries and table entries
that do not permit kit treatment.

## Player body HUD

An assigned or directly owned character with at least one active injury gets a
small translucent body silhouette on that player's Foundry screen. Each marker
is a real button: hover or keyboard focus previews the wounds at that location,
while click, touch, Enter, or Space pins the detail card. The card shows the
effect, recovery timing, treatment cost, and a **Treat with Healer's Kit**
button when the table permits treatment. Escape, the close button, or clicking
elsewhere dismisses the pinned card. The wound-count button opens the complete
Critical Injuries window.

The silhouette is an original geometric module graphic. Body locations are a
presentation projection of the verified injury record; the HUD never grants
authority. Treatment still sends only the Actor and injury identifiers through
the authenticated request path, and the active GM still chooses the healer,
rolls any check, persists the exact plan, and applies the result.

The table records an exact side only for Lost Limb and Crippling Injury. Those
results mark the rolled arm or leg. When a rule names an arm, shoulder, knee,
or limb type without recording left or right, both possible markers are shown
and labelled as side unspecified rather than inventing a location. Head,
torso, mind, and whole-body injuries use stable rule-based fallbacks. Multiple
wounds at one location share a numbered marker and remain individually
available in its card.

The HUD refreshes automatically as injury Active Effects are created, updated,
stabilized, or removed, and disappears when no injury effects remain. It is
enabled by default and can be hidden per client with **Critical Injury Body
HUD** in Module Settings without changing the world-level Critical Injury
automation setting.

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

Infection's long-rest save is triggered from the dnd5e rest-completed hook. The
client links that hook to D&D5e's persisted long-rest ChatMessage and sends only
its Actor and receipt identifiers to the active GM. The GM validates the
message author, speaker, and rest type, rolls every Constitution save privately,
and persists the complete set of outcomes before changing any Active Effect.

Each effect update uses the stored absolute maximum-HP loss and an exact private
rest marker. Replayed socket messages, an update that succeeds but reports an
error, reload recovery, and a different-GM handoff therefore reuse the same save
instead of rolling or applying the penalty again. Requests wait behind active
treatment/rest leases, retry through a targeted acknowledgement, and can be
recovered by the next active GM from the module-tagged rest ChatMessage if no GM
was online when the rest finished.

As with treatment, run privileged Critical Injury work from one browser session
per GM account. Different GM accounts are authority-fenced; simultaneous tabs
logged in as the same GM remain an unsupported Foundry authority topology.

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
