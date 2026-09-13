# Research & Rumors downtime

Integrated into the current branch on 2026-09-13. See the
[reconciliation and acceptance record](RESEARCH_RECONCILIATION.md) for source
provenance, preserved behavior and native acceptance limits.

Research & Rumors turns downtime questions into campaign discoveries without
letting automation invent hidden canon. A player may ask a precise question,
name a broad topic, choose a known subject, or simply ask the GM to surprise
them with something useful.

## Player flow

When the GM includes **Research & Rumors** in a guided downtime block, the
player chooses four or eight productive hours and one approach:

| Approach      | Typical sources                     |
| ------------- | ----------------------------------- |
| Arcana        | Arcane and occult sources           |
| History       | Archives and histories              |
| Investigation | Records and careful inquiry         |
| Nature        | Field notes and natural lore        |
| Religion      | Temples and sacred records          |
| Persuasion    | Experts, witnesses and contacts     |
| Insight       | Rumor comparison and motive reading |

The request itself is deliberately flexible. Every structured field is
optional:

- **What are you trying to learn?** accepts a direct question, broad topic, or
  casual prompt.
- **Topic** can narrow the search to Creature, Person, Place, Faction, Event,
  Object, Lead, or Hideout. **Anything** leaves it open.
- **Known subject** contains only Actors, Journals, and prepared subjects that
  the player is already permitted to know.
- **Typed name or description** supports subjects that are not represented by
  a Foundry document.
- **Discover something new** asks for a campaign-curated random discovery and
  ignores conflicting named-subject fields.

Blank fields are valid. With no direction, the request becomes “Surprise me
with something useful.” The player rolls the chosen approach and submits the
request once. The accepted request, time, approach, hours, and check are frozen;
they cannot be edited or rerolled after research begins.

Players see the difficulty as a word and the complication chance as a
percentage. The numeric DC remains GM-only. The current outlook updates when the
player changes hours, approach, or a known subject; known subjects that do not
support the selected approach are removed from the available choices. Eight
hours gives a stronger inquiry than four hours. The block's **Day** or **Night**
choice changes both difficulty and complication risk: formal archives and
officials favor the day, while street contacts, taverns, and occult inquiry may
favor the night. Open discovery shows the general outlook until its hidden
subject is earned.

## Result ladder

The check margin freezes one of four results:

| Margin       | Result               | Information earned                         |
| ------------ | -------------------- | ------------------------------------------ |
| Below DC−4   | Dead End             | A useful next source or revised direction  |
| DC−4 to −1   | Interesting Thread   | Tier 1 fact cards                          |
| DC to DC+4   | Meaningful Discovery | Tier 1 and tier 2 fact cards               |
| DC+5 or more | Breakthrough         | Tier 1–3 facts and an actionable discovery |

The complication roll is separate from success. A strong discovery can still
attract attention, create an obligation, expose the researcher, or introduce a
dangerous source. Likewise, a weak result is not required to carry a
complication.

If a prepared Research Seed contains everything earned at the frozen tier, the
module can prepare the dossier immediately. Otherwise the player receives a
meaningful interim result and the block stops at GM review. It cannot be
applied until the GM finishes and approves the dossier. An incomplete hidden
seed contributes no subject name, fact card, action, complication text, or
canonical link to the shared workflow while it waits for that approval.

## GM Research Seeds

Open **Workbench → Downtime → Research**. A Research Seed is confidential,
campaign-authored source material for open discovery. Each seed records:

- a canonical subject and category;
- a private GM summary;
- a player-facing difficulty label and GM-only numeric DC;
- base complication percentage;
- Day/Night availability and useful approaches;
- up to eight fiction-first fact cards assigned to result tiers 1–3;
- an optional breakthrough action or lead;
- a complication result;
- an optional exact Actor or Journal UUID and player-facing link label.

**Eligible for open-ended discovery** allows the seed to answer broad or random
requests. **Show this subject by name in player choices** exposes only its safe
label, category, difficulty, risk, and approaches. It never exposes the numeric
DC, private summary, fact cards, complication, or linked document.

Seeds are stored only in the originating full GM's browser. Opening a Research
block freezes a private copy of the current library. Later seed edits cannot
change that block's eligible discoveries or earned facts. Finish the block in
the same GM browser.

No default seed is campaign canon. If no seed matches, the system creates an
unprepared case instead of generating an answer.

## GM dossier review

Partial review updates preserve previously authored facts, subject, links, and
world-building fields when those fields are omitted. Retained shared links are
permission-checked again; choosing a different seed still replaces unchanged
seed-derived content and does not implicitly share the new seed's link.

The result tier and player check are immutable. During review the GM can:

1. choose one of the Research Seeds frozen into that block, or keep a custom
   subject;
2. name the canonical subject;
3. author or revise tiered fact cards;
4. add the breakthrough action and any triggered complication;
5. optionally attach an exact Actor or Journal;
6. edit the final player-facing dossier;
7. mark the discovery as needing more world building; and
8. approve the dossier.

Changing the Frozen Research Seed replaces unchanged values from the prior seed
with the newly selected frozen material; choosing **Custom subject / no prepared
seed** detaches the case. Any fields the GM explicitly authors remain under GM
control. Unsaved review fields are retained if the workspace refreshes, and
Apply saves those edits before delivering results.

For a result above Dead End, at least one fact card must exist at the exact
earned tier. A triggered complication needs authored text. Higher-tier facts
remain hidden. The player receives only the final dossier, the facts earned at
or below the frozen tier, and any explicitly shared link.

An Actor or Journal link is shared only when **Share the verified Actor or
Journal link** is checked. Before approval, the module verifies both the
document type and that every owner of the researching character has Observer
access. An Item, Scene, Roll Table, or other document cannot be substituted even
when its permissions would otherwise pass. Changing Foundry permissions remains
a separate GM action. Saved links are checked again whenever player history is
projected; removing permission removes the link from that player's view without
deleting the dossier.

**Needs World Building** creates a private follow-up in the Research tab. Use it
for a newly discovered hideout, contact, faction detail, encounter site, or
journal that should be authored before the lead appears in play. The research
result itself does not create that world content automatically. After preparing
the content, use **Mark world building complete** on that private case to remove
it from the follow-up queue. Cancelling an unapplied downtime block discards its
abandoned private Research cases while leaving the canceled GM workspace
readable without those confidential details.

## Player history and privacy

Approved dossiers appear in a dedicated **Research history** section in
Downtime Activities. The history keeps the player-facing question, subject,
tier, dossier, optional verified content link, and a brief follow-up indicator.
Private GM notes, hidden seeds, unearned fact cards, numeric DCs, and unpublished
document UUIDs are excluded.

This browser-local design is retained from the original implementation. Foundry can send raw flags
from hidden world Journals to authenticated clients, so confidential Research
Seeds and unrevealed cases are not stored in the shared downtime Journal. The
ordinary downtime receipt contains only already revealed material. The current
campaign store uses the encrypted vault; this integration does not migrate
browser-local research records into it.

The GM selects **Research time** when opening a new block; this does not advance
the calendar or change hunting/thievery rules. New enhanced templates carry a
version marker. Only the exact untouched legacy stock template upgrades
automatically; customized templates and old block snapshots retain their prior
hours, rewards and review flow. Newly created worlds receive enhanced research
by default.
