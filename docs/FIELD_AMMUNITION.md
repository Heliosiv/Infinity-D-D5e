# Drakmor field ammunition v1

Implemented locally for the next release. This is a campaign house-rule baseline,
independent of 2024 crafting rules. Existing custom crafting, scroll recipes,
open blocks and previous progress keep their original behavior.

## Run a four-hour camp

1. Open Workbench > Downtime. Choose Wilderness camp / forest, or Adventuring.
2. Set four hours and select the individual characters who can participate.
3. Include **Craft Field Ammunition** and any other activities. Open for players.
4. Each player selects a recipe and material method, an approach (Sleight of Hand
   or Survival), and whole hours. The card and allocation show a current quote.
5. **Roll & submit** rolls Survival first when gathering, then the chosen crafting
   skill. The GM reviews the calculated result and any complication, edits the
   report, and applies it. Only application spends currency/materials or creates
   ammunition. No campaign time or rest resources are automatically advanced.

Players choose one recipe/method per field-ammunition allocation. Unallocated
hours can go to another activity. A gathering method spends exactly one hour
searching and the remainder crafting. At least two allocated hours are required
for gathering; ordinary crafting starts at one hour. A later version can expand
gathering duration when additional time has an agreed benefit.

## Catalogue

| Recipe          | Finished batch | Crafting time | Abstract material cost | Required carried tools (one)     | Difficulty |
| --------------- | -------------- | ------------- | ---------------------- | -------------------------------- | ---------- |
| Arrows          | 5              | 2h            | 15 cp                  | Fletcher's or Woodcarver's Tools | Moderate   |
| Crossbow bolts  | 5              | 2h            | 10 cp                  | Fletcher's or Woodcarver's Tools | Moderate   |
| Blowgun needles | 5              | 1h            | 5 cp                   | Woodcarver's or Tinker's Tools   | Hard       |
| Sling bullets   | 5              | 1h            | 1 cp                   | Mason's or Tinker's Tools        | Easy       |

These are editable-in-source campaign starting rates. The GM confirms proficiency
and a suitable working area when assigning the activity. Wood/bone/thorn needles
and dressed stone sling bullets use the existing mundane ammunition Items and
their weapon compatibility. Arrows/bolts assume prepared heads and binding in
the abstract supply allowance; gathering wood does not require smelting iron.
Magic, poison, firearm cartridges, explosive ammunition and siege rounds are
outside this field catalogue. Darts and thrown weapons are equipment recipes.

## Materials

- **Pay abstract materials:** the quoted GP represents ordinary supplies already
  available under the campaign abstraction, rather than a purchase from a shop.
- **Use carried material bundles:** use inventory Items named `Arrow Materials`,
  `Bolt Materials`, `Needle Materials`, or `Sling Bullet Materials`. One bundle
  supplies one complete batch. A GM can name a mundane Loot item accordingly;
  these optional bundles are not automatically created or added to shops.
- **Use bundles, pay the remainder:** automatically use available matching bundles
  first, then cover the shortfall with abstract GP. The quote shows both amounts.
- **Gather for one hour, pay the remainder:** available in Wilderness and
  Adventuring presets. Gathering provides a recipe-specific credit against new
  abstract costs for this attempt. It never creates tradeable sticks or waives all
  prepared components. Gathered wood is useful for shafts; needles use thorns or
  bone, and sling ammunition uses appropriate stones.

Gathering is an Easy Survival check. A margin of +5 or more discounts new material
cost by 75%; success by 0–4 discounts 50%; failure by 1–4 discounts 25%; failure
by 5+ discounts nothing. A maximum 75% discount leaves a paid finishing/component
allowance. Players must be able to cover the quoted maximum before submission.
Special ingredients are never substituted by this system; they need another
explicitly authored recipe.

## Crafting result

Compare the total with the recipe's hidden DC: Easy 10, Moderate 13, Hard 16.
The UI shows only the difficulty label to players. The GM sees both checks and
their DCs. No automatic natural-1 or natural-20 override is added.
The three result tiers and zero extra rewards are fixed for this output type;
the GM may edit each narrative report without changing its mechanical result.

| Margin        | New progress            | Material consequence                                                  |
| ------------- | ----------------------- | --------------------------------------------------------------------- |
| 0 or higher   | All crafting hours      | Only progressed work uses funded materials                            |
| -1 through -4 | Half the crafting hours | Unused funded materials remain committed to this character and recipe |
| -5 or lower   | None                    | The current attempt's committed materials are lost                    |

All allocated time is spent. Existing progress and unrelated inventory are never
destroyed by the failure. A three-hour near miss adds 1.5h progress. Work remains
in half-hour increments; output is delivered only when a batch finishes.

Money and consumed bundles fund a separate material balance. A one-hour attempt
using a two-hour material bundle preserves the unused hour of material funding.
A near miss also preserves unused funding, so resumed work cannot charge it
again. A later severe failure consumes only the hours of funding committed to
that attempt. Credits follow the same character and recipe across payment
methods and activity copies. Fractional copper rounding credits prevent extra
charges caused by splitting equivalent work.

## Complications

In Downtime > Activities, edit Craft Field Ammunition and set **Gathering
complication chance per hour (%)**, from 0 to 100. The default is 5%.
An open block retains its assigned value. Players see the final percentage and
exposure basis before submission. Crafting inside camp has no exposure; one hour
of gathering at the default rate has a 5% chance. The probability helper supports
`1 - (1 - hourly chance)^hours` for future longer exposures.

The GM derives one saved result per character/activity in the block, independently
of both skill rolls. Review, report edits, retries and recovery keep that result.
The roll uses 1–10,000 to support hundredths of a percent. Triggered outcomes
provide one of four prompts: fresh tracks, a traveller, unstable ground, or an
approaching hungry creature. The GM supplies campaign-specific details and decides
whether an encounter or schedule change follows. Applying does not spawn enemies,
start combat, advance time or apply automatic hazard damage. The default crafting
result remains as rolled unless the GM handles an interruption before application.

## Persistence, compatibility and verification

The new field activity is offered alongside existing recipes; it does not silently
replace old Craft Arrows progress. Location activity restrictions and participant
ownership are rechecked by the authoritative GM. One resource-crafting activity
per character/block follows the existing inventory-conflict limit.

Player projections contain quote text, recipe/method IDs and player rolls, not
numeric DCs, write snapshots, hidden seeds or another character's work. This is
UI privacy: the shared Foundry storage confidentiality limitation documented in
`DOWNTIME_SYSTEM.md` still applies, and distributed module source is inspectable.
This release does not claim encrypted secret storage.

Tests cover all recipes, exact failure boundaries, discounts, mixed/bundle
payments, half-hour progress, retained materials, retry/cancellation behavior,
inventory drift, actual item delivery, duplicate application, and reload.
The browser journey exercises quotes, a two-stage submission and three widths.
Run `node scripts/test-downtime-field-ammunition.mjs`,
`node scripts/test-downtime-service.mjs`, and `npm run ui:audit:downtime`.

Before deployment, back up downtime state with the normal release procedure.
Older code rejects/discards half-hour progress, so a downgrade after using these
rules must pair the previous module with its pre-upgrade downtime backup.
Reverting only the code is appropriate before these rules are used in a world.
