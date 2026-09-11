# Downtime expansion assessment

Assessed 2026-09-06 (America/Vancouver) against Infinity D&D5e v0.3.27, source commit 83cf956. This is an assessment and proposed plan, not an implemented expansion.

Later source includes personal training, recipes and report history. See the
[non-ammunition Drakmor design](DOWNTIME_NON_AMMUNITION_DESIGN.md) for the
2026-09-08 source review and deferred activity candidates. The user has since
rejected campcraft and selected [active hunting](DOWNTIME_HUNTING_DESIGN.md) for
step-by-step rules discussion. These drafts describe no implemented changes.

The user wants more activities, crafting, and training while preserving the completed activity reports they already enjoy.

## Overall judgment

Keep the current player flow: choose how to spend available hours, submit any checks, receive a GM-reviewed result. The transaction and progress foundation is substantial. The next investment should make more activities complete and useful, give personal training a clear destination, and make finished work easy to revisit.

The shipped library currently normalizes to 18 activities, including spellbook learning. The guide still says seventeen. These are shipped defaults; the live campaign may have customized them.

## What is already implemented

| Area        | Current behavior                                                                                                                                                    |
| ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Planning    | Players split a 1–240-hour budget among activities using each activity's configured increment. Unused hours are explicitly forfeited.                               |
| Resolution  | One check per skill-based allocation; no-roll activities supported. The GM selects and edits outcomes, then applies each character's report.                        |
| Crafting    | GP costs, carried tools, consumed materials, ammunition, scrolls, configured Item outputs, multiple batches, and carried progress. Quotes appear before commitment. |
| Spellbooks  | Copying a selected discovered spell, gradual costs, usable spell delivery, and a protected learning record.                                                         |
| Projects    | Configurable hours, GP, checks and DC; cumulative shared progress survives normal history rotation.                                                                 |
| Benefits    | Limited automatic effects and injury care with expiry and duplicate-safe recovery.                                                                                  |
| Reports     | Activity narrative, reward/item information, and the latest completed report for each accessible character.                                                         |
| Reliability | Saved application plans, verified writes, ownership checks, retries and recovery protect spending and delivery.                                                     |

## Findings to resolve before expansion

### 1. Personal training needs personal progress and explicit completion

Projects store progress by project ID, shared across contributing characters. There is no project owner/scope or typed training completion reward in the current project schema. This is useful for a party commission but unsuitable for reusing one “Learn a language” project independently across several characters.

Add explicit **Personal** and **Shared** project scopes. Personal progress belongs to an Actor and an agreed goal. A training plan needs its target, prerequisite, instructor or study source where appropriate, hours, costs, milestone policy, and exact completion reward. Show “ready for GM approval” before any permanent sheet change. Retrying completion must not grant a reward twice.

Confirmed user preference: include GM-approved skill proficiencies, feats and special techniques as well as languages and tools. Each plan must identify the exact reward before work starts, validate its prerequisites, and require final GM approval before granting it once. A feat or technique should use an approved usable Item or narrowly defined mechanic, not arbitrary effect code. Expertise and ability-score increases are not implicitly authorized by this choice. These are campaign advancement choices, not a claim that existing presets implement official training rules.

Evidence: `scripts/downtime/projects.js:48`, `scripts/downtime/projects.js:97`, `scripts/downtime/store.js:2374`.

### 2. Time, pay and success frequency need an explicit policy

Guided outcome rewards apply once per allocation. Some fees scale per eight hours. Consequently, assigning 24 hours to Paid Work can produce the same configured wage as eight hours; a longer project contribution still provides one chance to add a success. This is documented behavior, not a newly reproduced defect.

Give each reward a clearly displayed basis: **per allocation**, **per workday**, **per finished batch**, or **on project completion**. Prefer workday-based wages for ordinary employment and batch-based crafted output. Define whether extra training time gives steady progress, additional milestone opportunities, or only one check. Splitting identical work into smaller submissions should not create extra pay, cheaper costs, or unintended extra advancement.

Keep productive hours separate from calendar passage and supply consumption. Preserve the current deliberate GM control of time.

Evidence: `scripts/downtime/service.js:2219`, `docs/DOWNTIME_SYSTEM.md` (activity editing, costs, and projects).

### 3. Crafting needs a recipe catalogue, not dozens of separate activity cards

Configured-item delivery already exists, but setup requires an Item UUID and manual recipe details. A good expansion should offer a **Craft something** activity with a searchable recipe picker, readable output preview, tool/workspace requirements, time, cost, and quantity.

The activity library has a 28-entry limit; adding one activity per recipe would consume its remaining space quickly. Categories and search should be part of catalogue growth, and any limit changes must preserve existing custom activities.

Tools and materials currently match inventory names, and tool possession does not establish proficiency or access to a suitable workshop. Prefer stable item identity for curated recipes with an explicit custom-name fallback. Clearly distinguish an automatically checked requirement from a GM-confirmed one. Choose whether shared stores or another character's tools may be used; currently the character must carry them.

Changing a recipe starts separate progress. Make old in-progress recipes discoverable and resumable before offering convenient recipe editing.

Evidence: `scripts/downtime/dispatch.js:15`, `scripts/downtime/work.js:44`, `docs/DOWNTIME_SYSTEM.md` (crafting).

### 4. Expand the report into a personal downtime journal

Keep the narrative report cards. Add **Latest**, **Ongoing work**, and **Past downtime**, with campaign date, location, hours spent, costs, items gained, progress before/after, and the next useful action.

Today the player projection returns the most recent completed receipt per character; the workflow history retains the latest 100 blocks. A permanent character journal must have a separate retention policy rather than assuming those blocks are an unlimited archive. Do not fabricate campaign dates for older reports that only recorded a real-world completion timestamp.

The current receipt header repeats completion status several times. Consolidate that space when adding richer history so the results remain the focus.

Evidence: `scripts/downtime/service.js:5194`, `scripts/downtime/store.js:50`, `scripts/downtime-activities.js:790`, `templates/downtime-activities.hbs`.

### 5. Keep secrets out of the current storage design

The current source and guide still document a previously demonstrated Foundry 13.351 issue: restricted Journal flags can reach authenticated players despite hidden UI. GM write permissions and approval are separate from confidentiality. This assessment did not repeat that transport experiment.

Ordinary crafting and openly described training can be designed without secret data. Secret research outcomes, concealed complications, and unrevealed opportunities need a separately validated storage solution before relying on confidentiality.

Evidence: `scripts/private-state.js:1`, `docs/DOWNTIME_SYSTEM.md:574`.

## Proposed expansion catalogue

These are candidates, not approved costs, durations, or automatic character benefits.

| Family                   | First useful additions                                                                | What makes the activity complete                                                                                      |
| ------------------------ | ------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| Ammunition and equipment | Recipe choices for ammunition, basic equipment, leatherwork and tailoring             | Exact usable output, appropriate tools, materials, batch sizes and saved progress                                     |
| Alchemy and herbalism    | Healing remedies, antidotes and selected campaign potions                             | Approved recipes and source items, ingredient policy, realistic access and clear output                               |
| Campcraft                | Prepare supplies, maintain camp, map nearby routes                                    | Connect to actual tracked supplies or a clearly stated narrative benefit; avoid duplicating Quartermaster consumption |
| Training                 | Learn a language or tool, develop an approved skill, earn a feat or special technique | Individual progress, explicit prerequisites and reward, milestones and one GM-approved permanent completion           |
| Animal handling          | Train an agreed command, care for a mount                                             | Named animal, agreed behavior and progress; no automatic claim of control or new combat abilities                     |
| Craft commissions        | Commission or collaboratively create a larger item                                    | Shared ownership, who pays, who receives the output, and verified delivery                                            |
| Research and local work  | Focused leads, paid trades, performances and contacts                                 | Distinct useful reports, consistent pay, known next steps and campaign-specific outcomes                              |

Recipes producing new items can reuse the existing crafting machinery. Repairing an existing item, consuming tracked supplies, modifying an animal, and permanently granting proficiency each need their own explicit behavior; adding descriptive text alone would not implement them.

## Recommended delivery order

1. **Clarify and organize the foundation.** Set reward/time policies, distinguish personal and shared projects, define the campaign rules baseline, and design the recipe/history navigation. Correct stale guide counts.
2. **Ship a small complete recipe set.** Add recipe selection and approximately six to eight GM-reviewed recipes using existing usable compendium items. Include tools, materials, costs, outputs and interrupted-delivery checks. Keep ordinary materials payable in GP by default; use inventory ingredients when they matter to the campaign.
3. **Ship personal training.** Support the approved scope of languages, tools, skills, feats and special techniques through defined reward types. Add individual progress, instructor/source requirements, meaningful milestones, safe character-sheet delivery and a GM-approved completion receipt. Validate that earned rewards survive the campaign's character-import workflow, reusing the lessons from protected spellbook learning.
4. **Expand the player journal.** Add searchable previous reports and ongoing work, clear progress and a resume action. Establish retention and migration before removing or rotating existing history.
5. **Add campaign depth selectively.** Extend camp, animal, commission and research activities once their state changes and outcomes are defined. Gate secret content on the privacy work.

A first release should prove one character choosing among recipes, paying only reviewed costs, receiving a usable item, and seeing progress/report history survive reconnects. The next should prove two characters training toward the same type of goal without sharing progress accidentally.

## What is needed from the GM

The technical design, implementation choices, tests, migrations and UI details can be handled without asking the GM to specify them.

The meaningful campaign decisions are:

- Confirmed: languages, tools, and GM-approved skills, feats and special techniques. Specific rewards and prerequisites still need approval per plan.
- Should recipes follow a chosen rules edition closely, or use explicit Drakmor house rules? The current system already mixes cited rules and labeled campaign choices.
- Which six to eight craftable items would actually interest the current party? Existing character tools and goals can inform a proposed shortlist.
- Should ordinary materials stay abstracted into GP, with only special ingredients tracked? That is the recommended initial approach.
- How much productive downtime is normally available between adventures? This should inform pacing without inventing fixed prices or training durations now.

## Verification and limits

The actual local browser journey passed at 1040, 720 and 380 pixels, covering activity editing, three-way hour allocation, project presets, GM review, failed-save handling, application and player receipts. Fresh generated report/project screenshots were inspected.

Focused crafting, authoritative service, workflow-store and benefit checks all passed. The benefit suite deliberately simulates calendar failure to verify recovery. These checks establish the existing baseline; they do not validate the proposed features, which have not been implemented.

Live read-only status confirmed the Drakmor world and full-GM session. The canonical campaign-state Journal was identified, but its 265,222-byte document exceeds the MCP tool's 250,000-byte read limit. The full live customized activity library was therefore not inspected. No live submissions, reports, inventory, time, or settings were changed.

No new features were implemented or deployed by this assessment.
