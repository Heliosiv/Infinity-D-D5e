# Downtime

## Guided downtime (default)

The default GM flow is intentionally small and has no settlement, faction,
Heat, theft, or escalation data. Open **Workbench → Downtime**,
enter a location and a productive-hour budget, choose the player
characters, then tick the saved activity templates that apply. Each player
chooses exactly one activity and an applicable skill, then clicks **Roll &
submit**. This makes the check on the player's controlled Actor and records its
total with the submission; the assigned hours are used as one downtime
activity. Choosing a different activity replaces the previous choice. All
assigned hours are retained, including blocks up to 240 hours.

The GM's unfinished setup survives in-window refreshes and switching workspace
tabs. Invalid hours are highlighted before a request is sent. Selecting an
activity moves keyboard focus to **Roll & submit**. On narrow windows, the
submission panel stays in the page flow so it cannot cover activity buttons.

If a submission reply is interrupted, **Retry submission** reuses the exact
check and request from that window. Repeated clicks share one pending roll.
After a submission is accepted, use **Recall and edit** to change it; another
request cannot silently replace an accepted check. A full browser reload does
not preserve an unacknowledged local check, so refresh and inspect the saved
submission before starting another roll.
If the GM goes offline, the current window keeps and displays the player's
last choice with submissions disabled. Refresh after the GM returns to continue.

Once everyone has submitted, the GM clicks **Review results**. This closes
submissions and prepares the reports from the recorded player checks. The GM
lands on the reports to review them, chooses from the possible outcomes, can rewrite the player report, then clicks
**Apply results & send reports**. Changing an outcome loads its matching report.
**Save report** saves an edit separately; applying also saves any visible report
edits first and stops if a report cannot be saved. Unsaved report edits survive
an in-window refresh. Player rolls and project hours stay fixed, and results
cannot be changed after application begins. A configured coin reward is deposited
into the character's currency and verified before the player receives an
updated Downtime Activities report with the activity art, narrative, and award.
Players who own multiple participating characters can use the character tabs
to switch between their latest completed reports. Each character receives its
own state update, and report access follows current Actor ownership.

The shipped templates are **Paid Work**, **Research & Rumors**, and
**Thievery**. They are intentionally a safe starting set. No campaign time is
advanced by this workflow.

### Edit the activity library

Open **Downtime → Activities** to edit a saved activity or click **New activity**
to create one. Set the player description, optional image, applicable skills,
and three possible results with their player reports and rewards. Existing
templates with up to six results retain all of them in the editor. Result
rewards apply once per assigned block; they are not multiplied by its hours.
Put the results in order from least to most successful. The GM can choose any
result during review.

Leave all skills unchecked for work that needs no roll. Players then see
**Submit activity**, and the GM review identifies **No skill check**. For
skill-based work, players see **Roll & submit**. The result options remain
hidden in the player interface until the GM delivers the selected report. See
the transport privacy limitation below before storing confidential material.

Activity drafts survive in-window refreshes and switching tabs or activities.
**Save activity** updates the library for future blocks. An open block keeps
the descriptions, skills, and rewards assigned when it began. The library
supports 24 saved activities.

### Crafting, scribing, and resource costs

In **Downtime → Activities**, use **Add arrow crafting** or **Add scroll
scribing**, adjust the recipe, and **Save activity**. These buttons prepare a new
editable activity; they never overwrite your existing library. Include the saved
activity when opening the next block. Ordinary activities can also use the
**Costs, supplies & crafting** section without producing an item.

- **Fee per block** is charged once per submitted block.
- **Additional cost per workday** scales with productive time: eight hours is
  one day. Costs round up to copper, and earlier rounding is credited in later
  blocks of the same recipe. Splitting a day does not increase its total cost.
- **Base materials cost per batch** is paid as the character works, on top of
  any block or daily fee. Set it to zero when inventory materials replace that
  GP cost; otherwise the two are additional costs.
- **Required tool** matches an inventory name and is kept. Ammunition also
  checks for the appropriate smith's, woodcarver's, or tinker's tools. The GM
  confirms proficiency and access to the workspace before applying the result.
- Up to four **inventory materials** match names on the character sheet, combining
  matching stacks. Consume them per block, per workday, or per finished batch.
  Whole materials round up; prior daily consumption is credited in later blocks.
  Depleted stacks remain at quantity zero. Required tools and the original
  scribing source are kept.

Arrow crafting starts at **20 arrows per 8 hours, for 0.5 gp**. Other ammunition
types are in the crafting-result picker. For other equipment, select **Craft a
configured item**, paste its world or compendium Item UUID, and set hours, GP,
and quantity per batch. Finished items are added as separate usable inventory
stacks. Multiple batches can finish in one block; leftover hours carry forward.

Scribing offers spells and spell scrolls already on the selected character's
sheet. A source scroll must have recorded spell-level metadata. Scribing uses
the [2024 Basic Rules scroll time and base cost by level](https://www.dndbeyond.com/sources/dnd/br-2024/equipment#ScribingSpellScrolls),
charged gradually as work progresses. For example, a level-2 scroll takes 24
hours and 100 gp: an 8-hour block costs 33.34 gp, then 16 hours costs 66.66 gp.
The finished scroll retains its spell activity, and the original spell or scroll
is kept. Copying an owned scroll is a GM-approved campaign option, not an
automatic substitute for the rules' prepared-spell requirement. The GM checks
preparation, proficiency, and spell components; list consumed components as
additional inventory materials. These requirements are not inferred from spell
description text.

Before submitting, players see the block's cost, materials, finished quantity,
and remaining progress. A spell picker shows the figures for each source. A
choice with insufficient GP, missing supplies, or missing tools cannot be
submitted. Submitting and preparing a report do not spend anything. The GM
reviews the same quote, then **Apply results & send reports** spends the costs,
consumes the materials, delivers finished items, and sends the receipt. Costs
and work hours apply to every narrative outcome; any configured reward is
additional and cannot fund an otherwise unaffordable submission.

Paid hours belong to the individual character, activity recipe, and selected
spell or scroll. They survive reloads and history rotation; cancelled work adds
none. Changing a recipe's costs, supplies, duration, or output starts separate
progress. Existing blocks retain their original recipe. Complete ongoing work
before changing its recipe if you want to retain that progress.

If supplies or the scribing source change during GM review, restore the reviewed
supplies or cancel the block and submit again. Recovery checks every saved
wallet, material quantity, and crafted item. Exact partial writes can be restored
before retrying; changed or ambiguous inventory stops for GM review. A completed
operation is never charged or delivered twice.

### Interrupted application

If a character's currency changes during review, application pauses while the
report is still editable. Use **Save report** for that character, then apply
again. If application has already started, use **Verify and recover**. Recovery
checks saved operations before retrying work confirmed not to have happened;
it does not repeat verified rewards. Completed reports stay visible in the GM
workspace until **Start next block**.
After application or recovery, keyboard focus moves to the saved reports;
an interrupted application instead points to **Verify and recover**.

## Long-term projects

Use **Downtime Workspace → Projects** to name a project, set its total
productive-hour target, and choose the skills players may use. A good campaign
baseline is 160 hours (20 eight-hour days) for learning a language; choose a
smaller or larger target to suit the task and pace of the campaign. For actual
automatic ammunition delivery, add an **arrow crafting** activity in the Activities tab;
a project can instead track a larger commission or other multi-block goal.

Unfinished project details survive in-window refreshes and switching tabs.
Project targets must be whole numbers from 1 to 10,000 hours. Saving clears the
form only after the project was accepted. A full library (40 projects) rejects
another addition explicitly rather than reporting success and dropping it.

When opening a guided block, select any unfinished projects that characters may
work on. Each character can choose the same project, so concurrent effort is
added together. One assigned productive hour always adds one project-work hour;
the player roll and the GM-selected result shape the report, rather than making
the completion pace swing unpredictably. Progress is calculated from completed
operation receipts, so it remains accurate after reloads and does not count a
cancelled or interrupted block.

## Baseline reward balance

The built-in 8-hour templates are intentionally modest: **Paid Work** awards
1/2/4 gp, **Research & Rumors** awards information rather than currency, and
**Thievery** awards 0/2/6 gp before any GM story consequences. This keeps a
normal downtime day comparable to ordinary skilled work instead of becoming a
primary source of adventure-scale treasure. GMs can still set the selected
outcome and narrative, while custom templates remain the place for campaign-
specific rewards.

---

## Standard city-action workflow

Guided downtime displays **Set up → Player rolls → GM review → Results**. Existing standard city-action blocks retain **Create → Collect → Lock → Preview → Apply → Complete**, along with their activity queues and immutable plans. Recovery appears when an interrupted application needs review.

Infinity D&D5e downtime is a GM-authoritative planning block for activities
that take hours rather than combat turns. It is intentionally separate from
Foundry world time and Quartermaster upkeep.

## Running a downtime block

1. A full GM opens **Workbench → Downtime** to manage an existing standard block.
2. In **Current Block**, optionally select a saved settlement. If the party is
   at camp, in the wilderness, aboard a ship, on the road, or somewhere else,
   leave the settlement unset and enter an **Other location** name instead.
3. Confirm the character selection and set the productive hours. Player-owned
   character Actors are selected by default. Use the group scopes, search,
   owner and folder filters, or sorting to find and add other characters.
   Filters change only what is shown; hidden characters remain selected. Use
   **Restore player defaults** to return to the player-owned group. One day
   equals eight productive hours.
4. Start the block and optionally open **Downtime Activities** for the owning
   players.
5. Each character queues any allowed combination that fits their personal
   budget, then submits. Unused hours are valid.
6. Lock submissions and generate the preview. The preview fixes all hidden
   rolls and exact results; it cannot be rerolled or edited.
7. Apply the preview. Review each character's receipt or use recovery if an
   external write was interrupted.

Guided blocks use the same saved states, but each player chooses one allowed
activity and clicks **Roll & submit** instead of building a queue. The player's
normal Foundry skill roll is recorded with that submission; the GM does not
roll it again during preview. The GM still selects the final outcome, narrative,
and reward before application.

## Repeatable downtime gauntlet

Run `npm run ui:audit:downtime` for the browser journey through activity editing,
draft retention, invalid reward handling, setup, a changed
player choice, a 240-hour submission, GM review, report editing, a failed save,
application, and the player receipt. It uses the real screen controllers and
player adapter with isolated campaign doubles. It also checks review layout and
accessibility at 1040, 720, and 380 pixels. Screenshots are written to
`output/playwright/downtime/`. The regular `npm run check` suite covers the
authoritative service, storage, transport, and project-progress rules. These
checks do not establish installed-world multiplayer acceptance.

For the installed-world gauntlet, install a built module package, or run
`npm run compile:packs` before launching a source checkout. The item catalog
must be compiled for actual inventory delivery. Start a **disposable** local Foundry 13 world
whose ID is `downtime-gauntlet`, with D&D5e and this module enabled. Create a
GM named `Gamemaster` and a player named `Gauntlet Player`, both without test
passwords. Close other clients for those test users, then run:

```powershell
npm run ui:audit:downtime:foundry -- --test-world downtime-gauntlet --url http://127.0.0.1:32173
```

This command refuses other world IDs and non-local hosts. It creates/reuses
two marked test characters, resets only their test wallets, and creates a
test activity. It exercises real player skill rolls, GM report editing,
fractional rewards, interrupted writes, and GM/player reloads.
It also verifies that an unfinished player choice survives a GM disconnect.
Fault-injection blocks use explicitly marked deterministic check fixtures. Results and
screenshots are saved under `output/playwright/downtime/foundry/`.

The command also tests transport privacy and currently **fails that gate** on
Foundry 13.351, despite passing the functional journeys. Do not describe this
as a fully green multiplayer gauntlet; the observed limitation is below.

A full GM may cancel a block while it is collecting submissions, locked, or
showing its immutable preview. Once application begins, cancellation is closed;
use the saved recovery checkpoint instead.

Every eligible character receives the complete GM-assigned budget. For
example, a 16-hour block gives every selected character 16 hours; those hours
are not divided across the party.

Starting, planning, or applying a block never advances Foundry time and never
triggers Quartermaster consumption. The GM advances campaign time separately.
Only one downtime block may be active at once. A block stores an immutable
snapshot of its chosen settlement or its non-settlement location, so later
profile edits cannot change a queued or planned result.

## Locations and activity availability

A settlement is optional. **Craft Ammunition** and **Sharpen Weapon** can be
performed anywhere, including camp or the wilderness, as long as the character
meets the activity's own tool, item, material, and currency requirements.

**Market Trading**, **Pickpocket**, **Shoplift**, **Fence Stolen Goods**, and
**Lay Low** require a selected settlement because their rules depend on that
settlement's market, crowds, merchants, fencing capacity, security, or local
Heat. These activities stay visible in a non-settlement block but explain why
they are unavailable. Selecting a saved settlement enables only the activities
allowed by that settlement profile; it does not affect the base availability
of location-independent activities unless the GM explicitly disabled them in
that profile.

The **Settlements** tab is therefore optional campaign setup for city-specific
rules. It is not a prerequisite for opening or resolving a downtime block.

## Built-in activities

### Craft Ammunition — 4 hours per batch

Creates 20 standard arrows, crossbow bolts, blowgun needles, or sling bullets.
The character must own the matching tool. The GM-authoritative apply spends
half the finished market value, rounded up to a whole copper piece. Magical
ammunition is excluded. Batches can repeat while the character has time, tools,
and verified currency.

### Sharpen Weapon — 1 hour

Requires a Whetstone or Smith's Tools and a nonmagical melee weapon with
slashing or piercing damage. The selected weapon gains +1 damage for its next
three damage rolls or until the next long rest. It never gains an attack bonus,
does not become magical, and cannot stack with another downtime sharpening.
On D&D5e releases before 4.4.3, the module keeps the enchantment embedded on the
weapon but supplies its typed +1 through the damage-roll hook. This avoids the
older damage-part enchantment bug without changing the weapon's permanent
source. The verified D&D5e 4.4.4 baseline uses the fixed native locked
damage-part enchantment instead.

### Market Trading — 2, 4, 6, or 8 hours

Requires a selected settlement.

The character stakes coin and chooses Persuasion or Deception. Each additional
two hours after the first grants +1, up to +3. The settlement wealth tier caps
the stake. A character may trade once in a block.

The margin result changes the stake by +25%, +10%, 0%, -10%, or -25% from best
to worst tier.

### Pickpocket — 2 or 4 hours

Requires a selected settlement.

The player chooses one of three deterministic, player-safe marks generated for
the block. Four hours grants +2. The GM resolves Sleight of Hand against hidden
settlement security plus the character's current Heat and earlier crime in the
same block. A successful theft produces a bounded mundane item or a module
created **Stolen Coin Purse**.

### Shoplift — 4 or 8 hours

Requires a selected settlement.

The player chooses one eligible finite-stock row from a merchant explicitly
linked to the active settlement. Eight hours grants +2. Empty rows, unlimited
stock, and quest items are never valid targets. A successful result transfers
exactly one unit while holding the same merchant and Actor locks used by
purchases.

### Fence Stolen Goods — 2, 4, 6, or 8 hours

Requires a selected settlement.

The character selects any combination of their eligible stolen items that fits
the activity's value capacity, then chooses Persuasion or Deception. More time
improves the roll and the value capacity. Payouts are 60%, 40%, 25%, 0%, or 0%
of eligible value by margin tier. A positive payout rounds to at least one
copper because currency is indivisible; failed fencing keeps the goods. A
character may fence once per block.

### Lay Low — 4 hours

Requires a selected settlement because Heat is local to that settlement.

Deterministically reduces the character's Heat in the active settlement by one.
It may be used twice per block and never reduces Heat below zero.

## Checks, crime limits, and Heat

Hidden checks use five consistent margin tiers:

|      Margin | Result              |
| ----------: | ------------------- |
| +10 or more | Exceptional success |
|     0 to +9 | Success             |
|    -1 to -4 | Setback             |
|    -5 to -9 | Failure             |
| -10 or less | Serious failure     |

Default settlement security DCs are 10, 13, 16, and 19. Each point of personal
Heat adds +2 to crime DC, and every earlier crime attempt by that character in
the same block adds another +2. Crime, including fencing, is limited to three
attempts per character per block. The same generated mark or merchant stock row
cannot be targeted twice. Heat 5 disables more crime until the character Lays
Low.

Setback, failure, and serious failure add one, two, or three Heat respectively.
A serious failure also lowers the settlement's linked faction by one, at most
once for that character in the block. Heat is personal, settlement-specific,
persistent from 0 to 5, and never decays automatically.

## Stolen goods

Every stolen item records the source settlement, target type, source or
merchant ID, operation ID, and timestamp. Stolen items use deterministic IDs
and remain separate from clean inventory stacks. A private issuance record
binds each item ID to its character, operation, provenance, and appraised value;
fencing derives the bundle and payout from that authoritative record rather
than player-editable item flags. Ordinary merchant sales reject every issued
item ID with a fencing explanation, even if its visible stolen flag is removed.
Successful fencing deletes the verified bundle, credits verified currency, and
marks the private issuance records consumed.

Generated city marks are abstract opportunities, not NPC Actor inventories.
Actual NPC inventory theft, combat pickpocketing, burglary, laundering, and
custom activity authoring are outside this version.

## Safety and recovery

The authoritative state moves through **collecting → locked → planned →
applying → completed**, with explicit **cancelled** and **needs review** states.
Settlement configuration, the selected location snapshot, the active workflow,
and its recovery checkpoint are stored in the module's restricted private-state
Journal.

Configuration schema v3 migrates exact v2 configurations and checkpoints
created before saved settlements carried an explicit `hasSettlement` marker.
The authoritative GM upgrades the direct configuration and both workflow
replicas through the same fenced write-and-read-back sequence used for
recovery. Noncanonical legacy records remain rejected, and the workspace hides
every mutation control while canonical data is unavailable.

Before external mutation, the module persists the complete operation plan,
including hidden rolls, outcomes, projected state, and stable operation IDs.
Apply claims and verifies each operation. Actor and merchant mutations use
shared locks, strict currency math, canonical read-back, deterministic item
IDs, and compensation where a write can be safely reversed.

If current data no longer matches the preview, dependent actions for that
character stop while independent characters continue. Recovery retries only
operations proven not to have applied. Ambiguous writes move the block to
**Needs Review** rather than rolling again or applying a reward twice.

Sharpening damage-roll and long-rest events carry the exact effect and
downtime-operation references. When no authoritative GM is available, each
client keeps a deduplicated local event queue and retries after authority
returns. Pending events suppress further local bonuses after the third roll (or
after a pending long rest), while the GM records completed lifecycle events in
private state before acknowledging them.

## Permissions and privacy

**Known transport privacy limitation, observed 2026-09-03:** Foundry 13.351
sends the restricted Journal's raw flags to authenticated player clients,
even with `ownership.default = NONE` and `journal.visible = false`. The
disposable-world player could read the downtime configuration and workflow
history directly from its client document collection. Hiding the Journal and
returning sanitized module projections does not make the underlying payload
confidential. Synthetic tests of a NONE-owned compendium and a GM-only whisper
also returned their data to that player, so moving the same flags into either
container is not an established fix.

This predates the downtime UI changes and affects the shared private-state
storage design. The write guards and GM approval flow remain enforced by the
module, but campaign secrets must not rely on this storage for confidentiality.
Resolving it needs a separately validated storage/encryption design and a
reviewable migration; it is not fixed by this downtime pass.

Only the active full GM can optionally configure settlements, create projects,
create or transition a block, roll hidden checks, or apply results. A player can
view and submit only directly owned or assigned eligible Actors. Socket requests
are authenticated and targeted to the active GM. Player-supplied DCs,
modifiers, costs, and rewards are ignored. In a guided block, the player's
bounded visible Foundry roll total/formula accompanies their owned activity
submission for GM review; the GM remains the outcome and reward approval gate.

Player projections contain their eligible Actors, location, safe opportunity
labels, prerequisite explanations, own queue and (when a settlement is
selected) local Heat, and completed receipts. They do
not contain hidden DCs or rolls, another character's queue, unrevealed faction
data, or merchant internals.

## Current compatibility

This version targets Foundry VTT 13.351. The guided downtime journeys in this
pass were exercised with D&D5e 5.3.3; earlier compatibility work used 4.4.4.
Sharpening uses a module-owned Active Effect embedded on the weapon and listens
to D&D5e's `preRollDamageV2`, `rollDamageV2`, and `restCompleted` hooks for
charge consumption and long-rest removal. The compatibility damage hook remains
available for supported D&D5e versions before 4.4.3; 4.4.3 and newer use the
native locked damage part.
