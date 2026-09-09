# Drakmor downtime: camp, exploration, herbalism and personal goals

Design draft, 2026-09-08. Reviewed against source `a83482c` (v0.3.35).
This document proposes house rules for discussion. It changes no gameplay and
does not authorize implementation. Ammunition crafting belongs to the separate
task and is outside this document's scope.

## Decisions already confirmed

- The GM creates a block for selected individual characters, with select-all
  and subset selection. Each character has their own productive-hour budget.
- Location presets restrict activities and modify opportunities. Players choose
  their methods and allocate time. Productive work does not advance the calendar.
- Players see a difficulty label and the final complication percentage. Exact
  DCs remain GM-only. Complications resolve independently from activity success.
- Crafting success earns full progress; failure by 1–4 earns half progress with
  materials retained in work in progress; failure by 5+ loses that attempt's
  time/materials. Earlier completed progress remains intact.
- Gathering can discount eligible ordinary materials: success 50%, exceptional
  success 75%, near miss 25%, failure by 5+ none. Special or irreplaceable
  components cannot be waived.
- Preserve completed reports, custom activities, ongoing work and earned rewards.
  Use Drakmor house rules, not the 2024 rules baseline.

Everything below, including durations, yields, costs, thresholds, risk rates and
temporary bonuses, is a **candidate**, unless described as current source behavior.

## What exists now, and what would change

The [earlier assessment](DOWNTIME_EXPANSION_ASSESSMENT.md) is historical. Several
of its recommendations have since shipped in source:

| Area             | Current source                                                                                                                            | Remaining design work                                                                                                                           |
| ---------------- | ----------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| Training         | Personal plans bind one character to one project ID; bounded language, tool, skill, feat and technique grants require GM approval.        | Agree pacing, methods and milestone cadence. Prerequisites are GM-confirmed text, not automatically inferred.                                   |
| Recipes          | Eight Drakmor recipes, including healing potions, antitoxin and healer's kits; all currently use eight-hour batches with no recipe check. | Gathering credits, smaller work increments, checked progress and material retention are new behavior.                                           |
| Camp/exploration | Scout & Map supplies GM-authored narrative results. Quartermaster already has food/water Forage Drive.                                    | Add precise camp benefits and discoveries; reuse supply delivery rather than creating a second consumption system.                              |
| Projects         | Hours and costs accumulate; each allocation can add one success regardless of duration. Shared and personal plans exist.                  | Checks by fixed work unit, typed completion benefits, and explicit contributor/payment/delivery rules.                                          |
| Reports          | Latest, ongoing work and searchable past reports exist; archive retains 200 reports per character.                                        | Add method, risk, supplies, reservations and benefit expiry to the existing receipt. Preserve retained entries; do not claim unlimited history. |
| Locations        | Presets and settlement allowlists are checked in setup and service.                                                                       | Add opportunity conditions and family-specific access. Town/custom currently allow all library entries unless restricted.                       |
| Hidden DCs       | Project projection and report formatting currently include exact DCs. The guide records a transport privacy limitation.                   | Remove DCs from player projections, reports and transport before claiming this requirement is met. Hiding a field is insufficient.              |

Evidence: [recipes](../scripts/downtime/recipes.js),
[training rules](../scripts/downtime/training-rules.js),
[training delivery](../scripts/downtime/training.js),
[projects](../scripts/downtime/projects.js),
[resolution and reports](../scripts/downtime/service.js),
[journal](../scripts/downtime/journal.js),
[location rules](../scripts/downtime/location-presets.js),
[resource guide](RESOURCE_SYSTEM.md), and
[current downtime guide](DOWNTIME_SYSTEM.md).

## Shared candidate resolution rules

Each activity declares its own increment, check interval and reward basis.
An eight-hour allocation to a two-hour scouting activity means four checks and
four paid time units. Four separately submitted two-hour units give the same
opportunities and risk. Display the check count before submission; retain every
resolved check on refresh or retry. A method changes the named skill and what
the character can accomplish, not just the description of an identical roll.

For checked candidates, use four bands: exceptional at DC +5 or more; success
at DC through DC +4; near miss at DC −1 through DC −4; failure at DC −5 or less.
Natural 1/20 does not override these margins. Training has its own rule below.
GM difficulty choices might read **Favorable**, **Standard**, **Demanding** and
**Severe**. Do not publish a fixed label-to-DC lookup as part of the player UI.

Roll complications once per completed check interval, independently of the skill
result: d100 at or below the displayed percentage triggers one. Candidate base
rates appear below. Add 5 percentage points for adverse conditions and 10 for a
known hazardous area; both can apply, capped at 50%. If conditions make the work
impossible, disable it instead of increasing risk. Show the reasons and final
rate before commitment, with no undisclosed risk modifiers.

For example, a 5% activity in adverse conditions shows **10% per attempt**.
Four attempts have a 34.39% chance of at least one complication; show the
per-attempt rate prominently and optionally the combined chance. Complications
can coexist with exceptional success. They do not silently cancel earned output:
the report records the result and the separate consequence. Injury, combat or
extra spending requires GM adjudication through the appropriate existing system.

## First candidate rules

### Campcraft: prepare shelter or secure the perimeter

- **Time/check:** two-hour increments; one check per two hours. No GP fee for
  ordinary site preparation. Carry shelter/bedroll supplies and suitable tools;
  found branches do not conjure a tent or permanent structure.
- **Methods:** Survival arranges weather protection; Perception chooses watch
  positions and warning lines. The player selects one purpose before work.
- **Benefit:** success creates one preparation for this named camp: either +2
  to one check against environmental exposure while resting there, or +2 to one
  watch Perception check there. Exceptional success gives two uses; near miss
  gives one +1 use; failure gives no preparation. The acting character declares
  a use before rolling. GM records manual use until a supported effect exists.
- **Limit:** preparations are shared among the named camp occupants, expire on
  departure or after 24 campaign hours, and do not stack with another preparation
  on the same roll. Repeated work replaces a weaker preparation; it cannot add
  unlimited charges or restart expiry for an unchanged preparation.
- **Risk:** 5% base. Example complication: runoff threatens the sleeping area,
  creating a new relocation decision while the earned preparation remains usable
  at the current camp until departure. Preparation does not grant a rest,
  remove exhaustion, or consume food/water automatically.
- **Report:** purpose, camp, roll band, eligible occupants, remaining uses,
  expiry and any separate unresolved consequence.

### Scouting: survey a route or observe a feature

- **Time/check:** two-hour increments; one check per two-hour survey. No GP fee.
  Name a reachable route, landmark or question; travel out and back is included.
  Writing a durable map requires carried writing/cartography supplies.
- **Methods:** Survival surveys passability and route hazards; Perception
  observes activity at a named feature from a reachable vantage. Neither method
  automatically reveals hidden rooms, enemy statistics or distant terrain.
- **Benefit:** success earns one actionable, GM-authored finding answering the
  chosen question, with a landmark and next step. Exceptional success adds one
  corroborating detail or alternate approach. Near miss identifies the specific
  remaining uncertainty and a place to investigate. Failure produces no finding.
  Uncertain observations are labelled; failure does not invent false certainty.
- **Limit:** each location offers a finite set of questions. An answered question
  cannot be farmed for more findings without new terrain, evidence or changed
  conditions. A second scout can address another question or corroborate one.
- **Risk:** 10% base. Example: signs indicate someone noticed the scout; the GM
  decides whether and how that develops after the report.
- **Report:** question, method, route/feature, confirmed finding, uncertainty and
  next action. No automatic travel-speed or encounter-avoidance bonus is implied.

### Herbalism: gather ingredients, then brew

**Gather ingredients:** two-hour increments, one Nature or Survival check per
two hours, 5% base risk, no GP fee. Nature identifies useful plants; Survival
locates and safely harvests a suitable patch. Require a herbalism kit, GM-confirmed
proficiency and an offered habitat. The player names one known recipe batch.

The confirmed discount ladder applies to that batch's eligible ordinary material
cost only. One patch provides one attempt per batch; additional attempts require
a genuinely different offered patch. Credits replace a lower credit rather than
stack, have no cash value, and cannot be applied after materials were purchased.
An ingredient credit stays with its character and batch until used or abandoned;
its expiry, if any, must be stated before gathering. No arbitrary discount cap
is introduced here; the GM limits which recipes and patches are available.

For a 25 GP potion with entirely eligible ordinary materials, the remaining cost
is **12.50 GP on success, 6.25 GP on exceptional success, 18.75 GP on a near miss,
and 25 GP on failure**. If 5 GP is a mandatory special component, apply discounts
only to the other 20 GP, leaving totals of 15, 10, 20 and 25 GP respectively.
Gathering does not grant brewing progress or produce a potion.

**Brew an existing recipe:** first candidates are the existing Potion of Healing
and Antitoxin, each with an eight-hour progress target and 25 GP base materials.
Propose two-hour increments and one check per two-hour attempt, using Nature
with a herbalism kit and confirmed proficiency. Require a safe workspace, heat
and clean water; quote any finite supplies separately. Base risk is 5%.

Apply the confirmed crafting bands: two progress hours on success or exceptional
success, one on a near miss, none on failure by 5+. Cap credited progress at the
remaining recipe target. Exceptional success does not create extra potions.
Reserve materials for the attempted work; a near miss leaves the unused portion
attached to this batch, which subsequent work uses before buying more. A severe
failure loses only the material committed to that attempt, including reused
reserved material, never earlier credited work or the rest of the character's
inventory. Completion delivers exactly one existing usable compendium Item.

Implementation must track credited, reserved and lost material separately with
cumulative copper rounding. For an undiscounted two-hour potion attempt, 6.25 GP
is committed. A near miss credits one hour and retains the other hour's material;
the next two-hour attempt reuses that hour and buys only one new hour's material.
The cumulative ledger, not independent rounding of each half, determines charges.
Optional GP gathering discounts never substitute for a required physical component.

Reports show patch/recipe, discount and eligible basis, time spent versus progress
earned, GP paid, materials reserved/lost, required special components, output and
next step. A contamination complication can require GM follow-up without secretly
turning a successfully delivered potion into an unusable item.

### Hunting: obtain food

- **Time/check:** four-hour increments; one Survival check per outing. No GP fee.
  Require an offered hunting ground, suitable weapon or reusable trapping gear,
  and equipment to dress the catch. Weapon ammunition accounting remains outside
  this design and must be resolved by the owning ammunition workflow if needed.
- **Methods:** stalk game for a fresh catch, or set and check traps for small game.
  Both return within the paid interval; traps do not create free later harvests.
  The GM offers only methods supported by the location's available game.
- **Benefit:** success yields four food units; exceptional six; near miss one;
  failure zero. One unit means enough edible food for one standard configured
  daily food portion, mapped to a verified existing supply item before offering.
  A rich ground adds two units on success/exceptional; a sparse ground halves
  positive yields, rounding up. Show the resulting yield table before commitment.
- **Limit:** default one outing per hunting opportunity, shared across participants;
  the GM offers further grounds when justified. Fresh yield expires after the next
  daily upkeep opportunity or 24 campaign hours, whichever comes first. A first
  implementation must support that expiry or obtain approval for shelf-stable
  output instead; ordinary permanent ration stacks cannot silently represent it.
- **Risk:** 10% base. Example: predator signs near the return route create a GM
  encounter decision. No automatic combat or injury is resolved by the check.
- **Report:** ground, method, yield, destination, expiry and complication. Deliver
  to one nominated supply inventory, count it once in Quartermaster, and leave
  actual daily consumption to the existing supplies workflow. Do not also award
  Forage Drive output for the same four hours or automatically create saleable hides.

### Personal training: learn a defined reward

Use existing personal plans and the existing final GM grant. Each plan belongs
to one character, with an exact reward, prerequisites, instructor/study source,
productive-hour target and quoted tuition before assignment.

- **First candidate:** learn one language or one tool proficiency, 80 productive
  hours, 50 GP total tuition, two-hour increments. This reuses the existing
  preset's hours/cost as a proposal, not an approved price for every reward.
- **Methods:** guided practice requires access to the named instructor; independent
  study requires a GM-approved source and plan. Solo repetition of an unfamiliar
  subject without a source is unavailable. Both earn steady hours and spend the
  same quoted total; no paid lesson is retroactively refunded for failure.
- **Cadence:** first language/tool candidate uses zero required successes and no
  mechanical training check or complication (display **0%**). At 20/40/60/80 hours
  the report records a practiced task or demonstrated lesson; these are narrative
  milestones and grant no partial proficiency. This avoids roll-count advantages
  from splitting sessions and is already supported by the current time-based plan.
- **Completion:** 80 hours makes the plan ready for GM approval; only approval
  grants the one named proficiency. Costs stop at the quoted total. Already-owned
  proficiency does not become expertise. Preserve the existing duplicate-safe
  grant and import-restoration behavior.
- **Skills, feats and techniques:** remain valid GM-approved goals, but have no
  universal duration or price in this proposal. Each needs a specific reward and
  power/pacing review before offering. Any checked version must specify fixed
  milestone intervals and retry costs rather than inheriting one roll per allocation.
- **Report:** owner, exact goal, source used, hours before/after, paid/remaining
  tuition, next milestone and approval status. Casual Train & Spar keeps its
  existing temporary benefit and does not automatically advance this plan too.

### Projects: shared work with an explicit destination

First candidate: **build a field workbench**, shared, 16 person-hours, 10 GP of
ordinary materials, two-hour increments. Require a fixed camp, carpenter's tools,
GM-confirmed proficiency and access to timber. One contributor per named station
works at a time; the GM may authorize parallel independent sections. Every
contributor spends their own time and pays their quoted material share. A helper
does not grant both free advantage and duplicate productive hours.

Use one Athletics (assembly) or Investigation (fitting) check per two-hour attempt,
with the same full/half/zero crafting progress and retained-material rules as
brewing. Base complication risk is 5%. Methods require the same craftsmanship
prerequisites; a high skill alone cannot replace tools or knowledge. Gathering
discounts require an offered timber opportunity and apply only to eligible new
material shares, using the confirmed ladder without stacking.

Completion gives the named camp a usable workstation for approved portable crafts,
including herbalism only when heat and clean water are also available. It supplies
no tools, components, bonus output or unquoted discount. The benefit lasts while
the bench exists at that site; it does not travel with the party. GM confirms
completion and records the location benefit once. This needs a supported location
benefit record; the current shared project's narrative completion does not create
one automatically. Repairs or other commissions must name their own affected
item/site, output, recipient, requirements and completion action before opening.

Report each contribution and cumulative person-hours, payments, held/lost
materials, site, completed benefit and who can use it. A future new location
record must not alter old reports or silently extend the bench to other camps.

## Candidate location offering

Presets supply defaults; actual access and opportunities must also pass the
selected settlement/location rules. A town preset cannot manufacture a forest,
instructor or workbench. Show why a choice is unavailable.

| Preset             | Candidate offering and opportunity conditions                                                                                                                                                                     |
| ------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Adventuring / road | Scouting during a halt; campcraft at a named temporary camp. Hunting/herb gathering only if the GM offers a reachable ground/patch and enough stationary hours. No brewing or site construction while travelling. |
| Wilderness camp    | Campcraft, scouting, offered hunting/herb gathering; brewing with workspace; source-backed study; fixed-site projects. Adverse/known hazardous conditions modify disclosed risk.                                  |
| Village            | Local scouting, edge-of-village grounds/patches when offered, permitted campsite work, available instructors and borrowed/rented workspaces with quoted access costs.                                             |
| Town / city        | Urban observations, available instructors and workshops. Gathering/hunting requires a specific garden or reachable outlying opportunity; ordinary market access only allows buying materials.                     |
| Custom             | Explicit GM selections plus the same prerequisites, opportunity limits and disclosed modifiers.                                                                                                                   |

Snapshot offered methods, opportunity identity/capacity, conditions, check
cadence, prices, yields and benefit terms when the block opens. Shared patches,
grounds and workstations need reservations across characters and overlapping
blocks; offering the same location again does not replenish capacity. Changed
conditions require a visible revised plan before new commitment, not altered
terms after a saved roll. Respect existing per-character hour budgets and prevent
assigning those same hours to overlapping productive work.

## First implementation boundary, after a family is chosen

Recommend **campcraft and scouting** first: they make short wilderness downtime
useful and let players choose between a camp benefit and information. The slice
would include two-hour scheduling, fixed check cadence, disclosed risk, safe
player projections, GM-authored findings, camp benefit uses/expiry and complete
reports. It must not claim hidden DC confidentiality until the current projection
and transport issues are resolved; an interim GM-only external DC workflow would
need an explicit design decision before implementation.

Acceptance examples for whichever family is chosen:

1. Two selected characters each get six hours; one spends two on camp and four
   scouting, the other submits their own allocation. Unselected characters gain
   no budget. Six hours never becomes a shared party pool.
2. Four two-hour submissions and one eight-hour allocation generate identical
   check counts, charge bases and risk trials for the same offered work.
3. Success plus a complication preserves the successful benefit and separately
   reports the consequence. Reloading rerolls neither result.
4. Player UI, report history, socket replies and readable persisted state contain
   no exact DC or unrevealed GM finding. Final percentages and timing are visible.
5. Location restrictions and shared opportunity reservations are rechecked by the
   GM service; unavailable methods cannot be submitted through a stale window.
6. Brewing verifies 50/75/25/0 discounts, non-discountable components, near-miss
   reservations, severe failure loss, copper rounding and duplicate-safe output.
7. Hunting verifies one inventory delivery, expiry and later normal supply
   consumption; training verifies isolated plans and one approved grant.
8. Existing active-block snapshots, customized library entries, historical reports,
   personal grants and shared progress survive upgrade and interrupted application.

Adopt new defaults only for explicitly selected new activities/plans. Do not
rewrite customized entries or unfinished recipes to match these proposals.
Extend the existing journal; do not replace it or shorten retention. Future
reports add method, time spent/earned, outcome, risk result, costs/reservations,
benefit/output, expiry, progress and next action. Older reports remain readable
without inventing values they never recorded.

## Next discussion

Choose the first family: **campcraft and scouting**, **herbalism and hunting**, or
**personal training and projects**. Then tune the candidate benefits and pacing
for that family before implementation. No source changes, ammunition edits,
push, deployment or live-world mutation are included in this design task.
