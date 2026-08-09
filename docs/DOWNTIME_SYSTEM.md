# Downtime, Locations, City Actions, and Theft

## v0.3.0 interface quick start

The GM workspace visualizes **Create → Collect → Lock → Preview → Apply → Complete**, with Recovery shown as an explicit branch rather than another forward step. Only the next valid primary action is emphasized. Players always see their controlled character, remaining hours, queue order, submission state, and the reason an action is unavailable. Keyboard queue controls remain available alongside pointer reordering.

Infinity D&D5e downtime is a GM-authoritative planning block for activities
that take hours rather than combat turns. It is intentionally separate from
Foundry world time and Quartermaster upkeep.

## Running a downtime block

1. A full GM opens **Home → Run the Session → Downtime Workspace**.
2. In **Current Block**, optionally select a saved settlement. If the party is
   at camp, in the wilderness, aboard a ship, on the road, or somewhere else,
   leave the settlement unset and enter an **Other location** name instead.
3. Select the eligible characters and set the productive hours. One day equals
   eight productive hours.
4. Start the block and optionally open **Downtime Activities** for the owning
   players.
5. Each character queues any allowed combination that fits their personal
   budget, then submits. Unused hours are valid.
6. Lock submissions and generate the preview. The preview fixes all hidden
   rolls and exact results; it cannot be rerolled or edited.
7. Apply the preview. Review each character's receipt or use recovery if an
   external write was interrupted.

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
On the target D&D5e 4.0.4 baseline, the module keeps the enchantment embedded on
the weapon but supplies its typed +1 through the damage-roll hook. This avoids
the system's Foundry 13 damage-part enchantment bug without changing the
weapon's permanent source. D&D5e 4.4.3 and newer use the fixed native locked
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

Only the active full GM can optionally configure settlements, create or
transition a block, roll hidden checks, or apply results. A player can view and
submit only directly owned or assigned eligible Actors. Socket requests are authenticated,
targeted to the active GM, and re-derived from IDs, hours, skill choice, stake,
and target IDs; player-supplied DCs, rolls, modifiers, costs, and rewards are
ignored.

Player projections contain their eligible Actors, location, safe opportunity
labels, prerequisite explanations, own queue and (when a settlement is
selected) local Heat, and completed receipts. They do
not contain hidden DCs or rolls, another character's queue, unrevealed faction
data, or merchant internals.

## Current compatibility

This version targets Foundry VTT 13.351 and D&D5e 4.0.4. Sharpening uses a
module-owned Active Effect embedded on the weapon and listens to D&D5e's
`preRollDamageV2`, `rollDamageV2`, and `restCompleted` hooks for the 4.0.4
compatibility bonus, charge consumption, and long-rest removal. The fallback is
disabled automatically on D&D5e 4.4.3 and newer, where the native locked damage
part is safe.
