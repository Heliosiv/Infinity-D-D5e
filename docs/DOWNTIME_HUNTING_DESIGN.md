# Active hunting

Implemented for local development, 2026-09-08. This replaces the hunting discussion
in the [non-ammunition design](DOWNTIME_NON_AMMUNITION_DESIGN.md). Fishing and
trapping remain separate future activities; campcraft is withdrawn.

## Open a hunt

1. In the GM Downtime workspace, open a guided block and select Forest, Swamp or
   another named wilderness area from **Location preset**.
2. Expand **Hunting rules and custom area**. Review the base Survival DC, public
   difficulty label, independent complication percentage and animal rows. Each row
   has a hunting AC, food portions, ordinary chance and exceptional chance. Each
   chance column must total 100%.
3. Assign allowed activities, including any existing custom activity. **Save area
   and activities** updates that area; changing its name first creates a custom
   area. An empty allowed list offers nothing. Selecting an area resets the
   block's activity selection so the GM can explicitly choose what to offer.
4. Select Hunting, participating characters and their individual hour budgets,
   then open the block. Unsaved hunting-rule edits apply to this block only;
   saving the area is required to change its allowed activities permanently.
5. The player allocates Hunting for four or eight hours and chooses a carried
   ranged weapon and compatible ammunition together. Submit rolls Survival. If
   game is found, the saved screen names it and offers **Take hunting shot**.
6. After the shot, the GM reviews and applies the result. The recorded outcome
   is fixed; the GM can add narrative consequences to the report. Food is delivered
   and ammunition deducted through the existing recoverable inventory transaction.

Configure a Food item UUID in Quartermaster before applying a successful hunt.
Hunted meat is copied from that food item, named for the animal and tagged for
normal Quartermaster supplies consumption. It goes into the hunter's inventory.

## Confirmed hunting rules

| Duration    | Survival DC             | Opportunities                                      |
| ----------- | ----------------------- | -------------------------------------------------- |
| Four hours  | Area base DC            | One Survival check, then one shot if game is found |
| Eight hours | Area base DC minus four | One Survival check, then one shot if game is found |

Below the adjusted DC, no shootable game is found and no ammunition is spent.
Meeting it through DC +4 selects the ordinary table. Beating it by five or more
selects the exceptional table, increasing the default odds of larger game.
The selected animal and complication are saved separately from the player rolls.
A hit secures the animal. A missed shot ends the hunt: no food, second shot,
resumed search or time refund. The eight-hour reduction applies only to Survival.

For example, with base DC 10, Survival 11 is ordinary at four hours. At eight
hours the adjusted DC is 6, so the same total is exceptional.

## Editable starting values

These are implementation defaults for campaign tuning, not published creature
statistics. Forest starts at DC 10 (Favorable); other areas start at DC 12
(Standard). The independent complication chance starts at 10% for either duration.

| Category | Forest animal | Hunting AC | Food portions | Ordinary | Exceptional |
| -------- | ------------- | ---------: | ------------: | -------: | ----------: |
| Small    | Rabbit        |         13 |             2 |      60% |         25% |
| Medium   | Wild pig      |         12 |             6 |      30% |         40% |
| Large    | Deer          |         12 |            20 |      10% |         35% |

The GM can rename the three animal rows and edit their yields, ACs and weights.
Categories describe hunting yields, not Foundry creature sizes. Dangerous-game
encounters are not automated; bears are not included by default.

The shot uses one d20 and the selected D&D5e weapon's prepared attack modifiers,
including the chosen ammunition. A natural 1 misses and a natural 20 hits.
This is an abstract hunt, not combat damage against creature hit points. Extra
Attack, automatic ammunition recovery, advantage/disadvantage dialogs and
consumable attack resources beyond one ammunition are not part of this activity.

Every attempted shot costs exactly one selected ammunition, hit or miss. No GP
fee is charged and the weapon remains owned. Failed tracking costs no ammunition.
Complications remain independent of finding and securing game: the GM adds any
consequence to the report without replacing the recorded result.

## Persistence and limits

- Exact hunting DCs and hunting ACs are excluded from shared Foundry documents
  and player projections. They and the frozen random seed live in versioned,
  world/user-scoped storage in the originating GM browser. Custom hunting areas
  also live there. Keep that browser's site data and finish the block there;
  switching GM/browser or clearing site data cannot silently substitute defaults.
- Starting the hunt locks the whole allocation, duration, equipment and Survival
  result. Refreshing or retrying keeps the selected animal. Once rolled, the shot
  is cached on the player's browser and reused on retries. An interrupted roll
  without a saved result stops for GM review rather than generating another shot.
- Inventory changes wait for GM application. Weapons and ammunition are rechecked
  against the reviewed plan; conflicting changes stop for review. A repeated
  application uses the existing transaction receipt to prevent duplicate delivery
  or spending. The player should keep the selected equipment available meanwhile.
- One Hunting allocation per character per block, with four or eight hours only.
  No additional duration discount or second outing within that block is offered.
  Another block can offer another hunt. Hunting cannot share a submission with
  another activity that spends item materials, because those inventories require
  separate review. Other compatible activities can use the remaining hours.
- Food quantity is editable; transport, dressing and spoilage remain GM-managed.
  Hunting does not advance the calendar or trigger travel gathering. Existing
  gathering, custom activity libraries, prior blocks and reports keep their rules.
- These privacy protections are specific to hunting. They do not change the
  legacy project-data storage limitations documented in the downtime guide.

## Verification

`node scripts/test-downtime-hunting.mjs` covers duration thresholds, weighted game,
private rules, custom areas, equipment compatibility, both checks, hit/miss,
failed tracking, food matching, ammunition spending, saved retries and reports.
`npm run ui:audit:hunting` exercises actual UI controllers and services with
isolated Foundry documents: custom-area authoring, eight-hour selection, Survival,
refreshing the player app before the shot, GM application and the report at
1040, 720 and 380 pixel widths. Screenshots are saved in
`output/playwright/hunting/`. The general check suite discovers the hunting test.

Browser fixtures do not substitute for an installed-world acceptance pass with
real system documents. This development change has not been deployed to Forge.
