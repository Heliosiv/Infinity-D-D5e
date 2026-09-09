# Drakmor downtime: active hunting

Discussion draft, 2026-09-08. This is a rules design, not an implementation.
It supersedes the earlier hunting candidate in
[the expansion design](DOWNTIME_NON_AMMUNITION_DESIGN.md).
Campcraft is withdrawn. Other activities are deferred while hunting is discussed.

## Direction supplied by the user

- The GM selects a wilderness area such as forest or swamp when opening downtime.
  Presets determine available activities; custom areas support GM-assigned custom
  activities. The GM controls hunting difficulty within that area.
- Active hunting spends dedicated downtime. Ordinary gathering remains available
  during walking/travel under its own rules; hunting supplements that activity.
- Four hours is the minimum and uses the base Survival DC. The user confirmed
  that eight hours reduces that DC by four.
- Beating the adjusted DC by five or more increases the chance of larger game.
  It does not guarantee a large animal.
- The user chose two checks: Survival finds game; a separate ranged attack
  secures it.
- The user confirmed that a missed shot ends the hunt. There is no second shot
  or resumed search within that outing, and its committed time remains spent.
- Hunting requires a ranged weapon and compatible ammunition. The weapon remains
  in inventory; ammunition may be expended. Fishing and trapping are separate
  activities with their own checks, not hunting methods.
- Shared confirmed principles still apply: individual character budgets, hidden
  exact DCs with visible difficulty labels, and independent complications whose
  final percentage players can see before committing.

The probability weights, attack details, ammunition quantities, meat output and
any extra restrictions below are suggestions or pending decisions, not approvals.

## GM setup and player flow

The GM opens downtime, selects the participating characters and their productive
hours, chooses **Forest** (or another saved area), and reviews the area's offered
activities. Hunting appears only if the area allows it. The GM can adjust the
base hunting DC, label, game table and complication rate for this block without
rewriting the preset. A forest might use DC 8 or DC 10 depending on the GM's
assessment; neither value is a mandatory rule for every forest.

An area's hunting profile should contain:

| Setting                                     | Purpose                                                                 |
| ------------------------------------------- | ----------------------------------------------------------------------- |
| Allowed activity IDs                        | Offer hunting and any selected existing/custom activities.              |
| Base hunting DC and player difficulty label | GM controls availability of game and difficulty; players see the label. |
| Game entries and size categories            | Restrict results to animals appropriate to this area.                   |
| Ordinary and exceptional probability tables | Weight game selection by the check's success margin.                    |
| Final complication percentage               | Disclose the independent risk for the chosen outing.                    |

Copying a preset creates an editable custom area. For example, **Old Marsh** can
offer hunting and one GM-authored activity with its own hunting DC and animals.
An empty activity list offers nothing; it must not revert to allowing everything.
Do not assign defaults to existing custom activities or change travel-gathering
DCs when editing hunting difficulty.

The player chooses Hunting, a duration, a carried ranged weapon and a compatible
ammunition stack. Before submission, show time, difficulty label, ammunition
requirement/cost rule, game possibilities and final complication percentage.
Save the selected duration and quoted rules before rolling. Report the resolved
animal and supplies only after the GM's review and any required follow-up.

## Duration and hunting check

First candidate: one outing of **four or eight hours**, with one Survival check
and, if it finds game, one ranged attack. Do not extrapolate discounts at 12, 16
or more hours yet.

| Chosen duration | Survival DC       | Survival checks for that outing |
| --------------- | ----------------- | ------------------------------- |
| 4 hours         | Area's base DC    | 1                               |
| 8 hours         | Area's base DC −4 | 1                               |

Use Wisdom (Survival) to track and approach game. A successful check selects an
animal from the appropriate probability table, followed by an attack using the
chosen ranged weapon. The four-point DC reduction for an eight-hour outing applies
only to Survival; it neither lowers the animal's defence nor grants an attack
bonus. Exact attack targets and the treatment of dangerous game remain proposed
below, not confirmed combat rules.

A deliberate eight-hour hunt gets one improved opportunity, not two ordinary
checks plus the reduction. Editing, splitting or resubmitting its form cannot
create extra rolls. Whether the player may instead choose two separate four-hour
outings is still open; if permitted, it must be an explicit choice with two time
charges, ammunition commitments and complication rolls. Do not carry forward the
previous draft's shared one-outing-per-area restriction without approval.

Compare the check total to the **adjusted** DC:

- Below the DC: candidate outcome is no shootable game, no attack and no ammunition
  spent. Even a near miss does not automatically give food. A narrative sign/trail
  can appear in the report.
- Meet the DC through DC +4: use the ordinary game table.
- DC +5 or more: use the exceptional game table.

The game result means an animal found, with delivery waiting for the attack
outcome. Game selection is one saved random result, not an extra player skill
check. A successful Survival roll alone never awards meat.

## Candidate forest game table

These percentages are a concrete starting proposal for discussion, not inferred
campaign settings. They apply **after** a successful hunting check.

| Game category | Example profile entries                            | Ordinary success | Beat DC by 5+ |
| ------------- | -------------------------------------------------- | ---------------: | ------------: |
| Small         | Rabbit, game bird                                  |              60% |           25% |
| Medium        | Fox-sized game or a small wild pig, where suitable |              30% |           40% |
| Large         | Deer; bear only where specifically offered         |              10% |           35% |

These are hunting yield categories, not Foundry creature-size statistics. A
region can choose different animals and weights; every offered table totals
100%. For the first candidate, choose uniformly among the explicitly listed
animals within the rolled category. Never invent an animal for an empty category:
the GM must correct that profile before offering it. Species weights can be
added later if the GM needs them.

Example: the GM sets Forest to DC 10. A total of 11 on a four-hour hunt is an
ordinary success, giving a 10% chance of large game. The same total on an
eight-hour hunt beats adjusted DC 6 by five, giving a 35% chance of large game.
This makes extra time improve both success and the chance of a larger result.

Bear is an example the user raised, not an automatic hostile encounter. Whether
dangerous game resolves through the same abstraction or needs a separate scene
is unresolved; do not offer it for automatic delivery until that policy is set.

## Candidate ranged attack and ammunition rule

After game selection, make one normal attack with the chosen ranged weapon
against that animal entry's GM-defined hunting AC. Use the character's actual
weapon attack modifiers. A hit secures that animal; a miss lets it escape and
ends the hunt, with no food awarded and no retry within the outing. The proposed
ammunition rule spends the weapon's configured ammunition cost once per shot.
This is an abstract hunting outcome, not a claim that one hit would remove a
creature's combat hit points. Critical hits do not create extra animals.

An ordinary bow/crossbow would therefore require one compatible arrow/bolt:
failed Survival spends zero; a hit or miss spends one. No extra attack from Extra
Attack, multiattack or eight-hour duration is assumed. No automatic ammunition
recovery is included in this candidate. Ammunition cost and recovery still need
user review; ending the hunt after a miss is confirmed. Game hunting ACs must be
defined before the table is usable;
do not invent published creature statistics or resolve a bear as an ordinary
one-hit catch without settling dangerous game first.

## Equipment validation and later output decisions

Validate a usable carried ranged weapon that uses ammunition and a compatible
carried ammunition stack. A melee weapon, a spell or a thrown weapon without
ammunition does not satisfy this particular activity's stated requirement.
The ranged weapon is never consumed. Recheck possession, compatibility and
quantity before applying a reviewed result. Keep any paid access fee separate
from ammunition; no default GP entry fee is proposed.

The one-shot cost above is a proposal, not an approved rule. Reserve enough
ammunition for the quoted attack before commitment, spend it only if that shot
occurs, and release the reservation if Survival fails. If a random-cost rule is
chosen later, disclose and reserve its maximum, record the actual cost once and
release the unused reservation. Never inherit ammunition crafting batch sizes.
Selecting special ammunition must be explicit. Coordinate inventory spending
with the existing transaction service without changing ammunition crafting.

Meat quantities by species/category, dressing and transport requirements,
destination inventory and spoilage are also unresolved. Withdraw the previous
flat four/six/one food-unit yield and automatic expiry proposal. Once approved,
output should use a verified existing resource/item representation, deposit once
and be consumed later by the normal supplies workflow. A hunting result does
not also trigger a gathering roll or advance the campaign clock. Independently
earned travel-gathering output remains valid.

One complication roll per outing is the suggested cadence, independent of the
hunting and game-selection rolls. The GM supplies the final percentage for the
selected duration; no default rate or duration multiplier is approved yet.
Report success/failure and complication separately. Do not silently replace a
successful large-game result with failure because a complication also triggered.

## Existing source and later implementation needs

The [resource guide](RESOURCE_SYSTEM.md) documents forest, swamp and other biome
presets plus custom regions with distinct food/water gathering DCs. The existing
[downtime location rules](../scripts/downtime/location-presets.js) instead use a
broad Wilderness camp/forest option, settlements and custom activity allowlists.
Prefer a link to the existing region catalogue plus downtime-specific profiles,
rather than maintaining two conflicting lists of biome names. Region identity
can be shared while hunting DCs, gathering DCs and activity lists remain separate.
The selected region and hunting rules must be snapshotted for the opened block.

The previous source review identified exact project DCs in player-facing data
and documented transport privacy limits. Hidden hunting DCs need verified player
projections and storage, not merely a hidden control. Existing custom libraries,
open blocks and completed reports must remain intact; this draft changes none.

The hunt/attack structure, four-point DC reduction at eight hours, and hunt ending
after a missed shot are confirmed. Before implementation, define hunting ACs,
review ammunition cost/recovery, then define species outputs. A later acceptance
pass should cover:

1. Forest and custom-area activity selection, GM overrides and unchanged
   travel-gathering rules.
2. Four/eight-hour time charges, the four-point DC reduction and the exceptional
   boundary in the base DC 10 / total 11 example (adjusted DC 6 at eight hours).
3. Valid habitat tables, recorded weighted game selection and independent risk.
4. Wrong weapon/ammunition rejection, no shot after failed Survival, a hit versus
   a miss after successful Survival, no second shot/search or refunded time after
   a miss, and duplicate-safe inventory spending.
5. Concrete food delivery and reports, saved rolls across retries, and no exact
   DC in player-readable state or receipts.

There is no gameplay implementation, ammunition-crafting edit, push, deployment
or live-world change in this discussion draft.
