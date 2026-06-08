# Infinity D&D5e — Full Compendium Audit

**Scope:** all 1,741 items in `packs/infinity-dnd5e-items.db`
**Method:** deterministic field-integrity sweep (every item) + a 17-section semantic audit by LLM agents, each finding adversarially re-verified against the real item JSON, plus a 6-lens forward-looking design panel. 106 agents, 61 verified item-specific findings, 45 design proposals.

---

## 1. Executive summary

The pack is in **good structural health**. Field-level integrity is excellent: zero price↔gpValue drift, zero rarity-flag drift, zero foundryType/subtype keyword drift, no leftover `party-operations` legacy flags. The generated tagging pipeline is internally consistent, and the loot vocabulary is coherent.

The problems are concentrated in four areas, in priority order:

1. **One pervasive content leak** — a build-pipeline dev-note (`Planned icon: …`) renders inside the **player-visible** card on *all 1,741 items*.
2. **~30 genuine item-specific miscategorizations / rarity / price errors** — most notably several Wondrous Items mis-typed as **light armor** (they wrongly occupy the AC slot), mundane spell-foci flagged as **magic weapons**, and decks/poisons in the wrong buckets.
3. **108 accidental duplicate copies** (~6% of the pack) that silently skew loot rolls and merchant stock.
4. **~31 text/typo/encoding errors** in player-visible descriptions (mojibake minus-signs, misspellings, copy-paste flavor).

Plus a set of **forward-looking structural improvements** (CI validators, a dedup/re-tag migration script, rarity-policy unification, tag-schema centralization) that would prevent this class of issue from recurring.

**Severity counts (item-specific, verified):** 11 high · 20 medium · 30 low.

> ## ✅ Remediation status — COMPLETE (Phases 1–3)
> All systemic issues and all 61 verified item-specific findings have been fixed in the working tree.
> - **Phase 1:** dev-note + empty-label strip (1,741), de-dup (1,741 → **1,636**, −105 copies; 3 genuine variants kept), phantom activities stripped (300 loot/container), buy-filter heuristic fixed, 28 mojibake + ~60 typo fixes.
> - **Phase 2:** rarity format canonicalized (69 `very-rare` → `veryRare`) + mundane-rarity policy applied (25 → common, 54 loot cleared).
> - **Phase 3:** 17 miscategorizations re-typed/re-tagged, 7 price corrections, 5 rarity fixes, 17 gems re-tiered by value, 6 renames, 6 named-pack + Shield-spell + Inconspicuous-Box rewrites.
> - **Guardrails:** 7 new CI checks (`test-pack-{duplicates,descriptions,pricing,activities,rarity,loottype}` + `test-merchant-buy-filter`). **All 45 checks pass.**
> - **Remaining (optional, §4 Phase 4):** the larger architectural enhancements (tag-schema centralization, virtual-chip unification, gem/art chip counts, merchant-flag wire-up, market-tier coupling) are intentionally out of this remediation scope.

---

## 2. Systemic issues (whole-pack)

| # | Issue | Scope | Recommended fix | Effort |
|---|-------|-------|-----------------|--------|
| S1 | **"Planned icon: shared/bespoke asset" dev-note in the player-visible Item State block** | 1,741 / 1,741 (1,447 "shared" + 294 "bespoke") | Strip the `<li>Planned icon …</li>` from every description; remove the emitter in `generate-spell-scrolls.mjs` (line ~616) and from the external enrichment pass; add a CI linter (see D-T3). | **High value / Low effort** |
| S2 | **Accidental duplicates** | 82 name-clusters / 108 extra copies (Waterskin ×6, Rations ×6, Tinderbox ×5, Candle ×4, Hempen Rope ×4, Backpack/Bedroll/Crowbar/Alms Box/Ink Bottle/Ink Pen/Oil Flask/Piton/Torch/Hammer ×3, …). 51 are trade-goods, 26 consumables. | De-dup to one canonical doc per (name+type). Review genuine variants separately: **Incense** (consumable/potion 1gp vs loot 150gp), **Amethyst** (10 vs 20 gp). Add a duplicate-guard test. | **High / Med** |
| S3 | **Inconsistent mundane-rarity policy** | Base SRD weapons/armor/clothing carry `system.rarity:"common"`; 251 items (trade goods, containers, treasure, most food) carry none — and containers split 19 common / 30 none *within the same type*. | Adopt one rule: mundane physical items (weapon/armor/equipment/tool/container) = `common`; pure `type:loot` treasure/gems/art = no rarity. Apply pack-wide in the generator. | **High / Med** |
| S4 | **Rarity stored in two formats** | 207 items `veryRare` (camelCase) vs 69 `very-rare` (hyphen) for the same logical rarity (incl. 2 real magic items: Wand of the War Mage +3, Mirror of Life Trapping). `normalizeRarity()` papers over it at read-time. | Canonicalize to one form in the data; add a rarity-format CI guard. | **Med / Med** |
| S5 | **Phantom "Use X" utility activities on inert loot** | All 243 `type:loot` items (gems, art, trade goods) carry a fabricated `utility` activity → a meaningless clickable button + an "Activities: Utility" line on the card. ~300 loot/containers total. | Never emit `system.activities` for `type:loot`; strip from existing docs; assert 0 in CI. | **High / Low–Med** |
| S6 | **Buy-filter magic heuristic is wrong for this pack** | `buy-filter.js:56` treats any non-empty `system.rarity` as magic — but mundane base gear carries `rarity:"common"`, so a player's mundane Longsword classifies as `loot.weapon.magic` on the sell side. | When `getItemLootType()` returns a value, trust it and skip the dnd5e fallback; reuse `getItemMagicNature()`. Add `test-merchant-buy-filter.mjs`. | **High / Low** |

> **False positives to ignore** (flagged by the mechanical pass, confirmed *not* real): the 62 "category-suspect" weapon/armor entries (that's the S3 mundane-rarity heuristic, not a miscategorization) and the 319 "unknown-loottype" entries (intentional `loot.spell` for spell source docs).

---

## 3. Item-specific findings (61 verified)

### 3a. Miscategorizations — highest impact (17)

**Wondrous Items mis-typed as Light Armor** (high — these wrongly occupy the dnd5e armor slot / grant an armor AC base, and file under Armor in loot + merchant):

| Item | id | Fix |
|------|----|----|
| Amulet of the Planes | `8ABk0XV76Hzq8Qul` | `system.type.value` `light`→clear/`trinket`; lootType `loot.armor.magic`→`loot.equipment.magic`; move out of armor folder; regenerate unidentified text ("Jewelry Armor"). |
| Helm of Comprehending Languages | `rY9sRFQp5CFSfsat` | Same pattern (it's a helm, not armor). |
| Helm of Teleportation | `DEQkJiQdGyfmSNkV` | Same pattern. |

**Mundane spell-foci flagged as Magic Weapons** (high — common 1–10 gp foci carrying the `mgc` property → `loot.weapon.magic`, magic folder, merchant.magic):

| Item | id | Fix |
|------|----|----|
| Sprig of Mistletoe | `xDK9GQd2iqOGH8Sd` | Drop `mgc` property (keep `foc`); retag mundane; non-magic folder/merchant. |
| Yew Wand | `t5yP0d7YaKwuKKiH` | Same (mundane druidic focus, 10 gp, no attunement). |
| Rod | `OojyyGfh91iViuMF` | Same (mundane arcane focus, 10 gp). |

> A broader sweep (design lens) found **9 spellcasting foci** total carrying this pattern — worth a single batch fix.

**Other category fixes:**

| Item | id | Sev | Fix |
|------|----|-----|----|
| Silver Dagger | `mNKCedEElfCGWjJj` | high | Silvered ≠ magic. Retag `loot.weapon.mundane`, clear uncommon rarity, leave `sil` property + 100 gp. |
| inconspicuous Box | `GUgSvlEeG7ownaX0` | high | Capitalize name; fix `inconspicous` typo; pick one noun (Box/Coffer/case drift); set magic rarity; fix tier/value + merchant tags. |
| Book of Shadows | `CwWbeQ6XyqFzbMYw` | high | `loot.loot`→`loot.equipment.magic` (very-rare 12,000 gp implement currently routes to mundane Trade Goods chip). |
| Airship Supplies | `H95wzHKsLXrU92Hk` | med | `consumable/ammo`→trade good/gear; move out of weapons/ammunition (it's ship-repair supplies; its own tags say "tradegood"). |
| Component Pouch | `eZGmdOhaTWMicXPW` | med | `consumable/ammo`→adventuring gear; move out of weapons/ammunition (it's a spellcasting focus pouch). |
| Deck of Many Things | `oSarKEU8x1AupB6z` | med | `consumable/potion`→`trinket`/wondrous; out of Potions folder; `autoDestroy:false`. |
| Deck of Illusions | `Wk7EOYoY3b2tgGoS` | med | Same — it's a Wondrous item, not a potion. |
| Military Saddle | `PLkzJ310FzBnRrI5` | med | `clothing` subtype + Clothing folder → mount tack / adventuring-gear. |
| Spirit Guardians | `uCud2s4TjMfjiXUb` | med | Strip `art`/`treasure`/`luxury` merchant pollution from a spell source → `[arcana,magic,spell]`, `sale.standard`. |
| Reliquary | `gP1URGq3kVIIFHJ7` | low | Move from art-objects/decorative-finery → adventuring-gear/general-gear (it's a holy-symbol focus like Amulet/Emblem). |
| Incense | `TniiNAWSasgVGZ5V` | low | `potion` subtype → `trinket`; out of Potions folder (mundane temple incense). |
| Ring of Feather Falling | `JyYwliYiWEw2g0yJ` | (Other) | Remove stray `herb`/`ingredient` merchant tags from a magic ring. |

### 3b. Pricing sanity (7)

| Item | id | Current | Suggested |
|------|----|---------|-----------|
| Ring of Telekinesis | `hxfOtvFrY1PXHQN1` | 80,000 gp (very-rare) | ~13,000 (peer very-rare rings 12–14k). |
| Amulet of the Planes | `8ABk0XV76Hzq8Qul` | 100,000 gp (very-rare) | 25–50,000 (2× over the very-rare band ceiling). |
| Ring of Spell Storing | `9cIlRtKDtDXQtElf` | 20,000 gp (rare) | ~6,000 (matches rare-ring ceiling; 20k is legendary money). |
| Adamantine Bar | `GgQkUMbwLoiMzlXn` | 7.69 gp | ~50–60 (should exceed Mithril Bar 46 gp; 7.69 is a conversion artifact). |
| Incense | `jsR8i4HOjATQ1EwI` | 150 gp | ~1 (peer incense is 0.2–1 gp; 150 is art-object money). |
| Robe of Useful Items | `2ksm2KXCY3vBHTAx` | 140 gp (uncommon) | ~2,000 (uncommon wondrous band; also fix the embedded "Value: 140 gp" line). |
| Mason's Tools (Dwarven) | `gLe5f61hybkMmOZF` | 150 gp (common) | ~10 (duplicates base Mason's Tools text, no special props; 15× the base). |

### 3c. Rarity sanity (5)

| Item | id | Fix |
|------|----|----|
| Dust of Dryness | `eMR6B4bIoJPUDJG8` | Set rarity `uncommon` (currently none, but it's a 1,200 gp wondrous item). |
| Wand of the War Mage +2 | `k3T7tpcdzDyVKlF4` | `uncommon`→`rare` (it sits in the +1's band; +1 uncommon, +3 very-rare). |
| Rod of Absorption | `6pjaQzbtxQTuQ4RW` | `legendary`→`veryRare` (canonical DMG; matches Rod of Security/Alertness). |
| Black Opal & 11 other gems | `0BIXYULR7r7Uguhv` (+11) | 250–1,000 gp gems default to **tier t1** because rarity is empty — derive gem tier from value band instead. |
| Potion of Giants Size | `9HEjizGE5QOmkGh9` | Name→"Potion of Giant Size"; reconcile rarity (field says legendary, header says "Potion, Rare"). |

### 3d. Text / naming / encoding (31)

- **Mojibake (UTF-8 corruption) in player text** — minus signs and fractions rendered as `âˆ’` / `â…•`: **Ring of Spell Storing**, **Ring of Warmth**, **Boots of the Winterlands**, **Ioun Stone of Reserve**, **Pouch** ("1/5 cubic foot"). Fix to ASCII `-` / `1/5` or proper U+2212.
- **Possessive/apostrophe drift** (the pack is correct ~40× elsewhere): **Angel's Trumpet** (`BhfuI7UoZntTMH9a`), **Eagle's Fern** (`PubrFxRC2UE5Ynhs`), **Potion of Giant Size** (`9HEjizGE5QOmkGh9`).
- **Wrong-noun flavor (copy-paste)**: **Flute** described as "a lute"; **Shield** (the *spell*, `z1mx84ONwkXKUZd7`) carries mundane-shield flavor instead of the Shield spell text; **6 named adventuring packs** (Burglar's/Diplomat's/etc.) share generic Backpack boilerplate.
- **Misspellings** (most duplicated across "Vicious" weapon variants, so batch-fix): `provies`→provides (Glaive ×2), `stright`→straight (Longsword ×3), `feathres`→feathers (Dart ×2), `treshing`→threshing (Sickle ×2), `mouted`→mounted (Spear ×2), `guerrila`→guerrilla (Blowgun ×2), `hammer metal`→hammered (Arrow), `wielders`→wielder's (Blowgun Needle), `versaility`→versatility (Pepper ×2), `abundence`→abundance (Iron ×2), `tumeric`→turmeric (Ginger ×2), `climtes`→climates (Linen ×2), `all many of`→manner (Cotton + ~8 textiles, 16×), `acarbonate`→carbonate (Chalk), `psaage`→passage (Hourglass), stray "you" (Periapt of Health), `'range'`→range (Creation spell).
- **Wrong real-world names**: **Taurine** (`85mRD0d5phAfu2XN`) is a biochemical, not a gem → "Tourmaline"; **Berryl Gemstone** (`1aGgIFK8tOBzhk8X`) → "Beryl"; **Red Ammonita** (`ENxfOsfB50KNcblA`) → "Red Amanita" (the mushroom genus).

> Full per-item detail (current state, exact ids, verifier notes, refined fix) for all 61 is in `confirmed.json` produced by the audit.

---

## 4. Forward-looking improvements (45 proposals, 6 lenses)

Top picks by impact/effort:

### Tag schema
- **(high/med) One virtual-chip classifier table.** The "chip that resolves by predicate" concept (gem/art/ammo) is implemented 3 different ways across `roller.js`, `pack-stats.js`, `buy-filter.js`. Unify into one `itemLootChips(item)` in `tag-vocabulary.js`.
- **(high/low) Gems & Art chips always show 0.** All 96 gems / 166 art canonicalize to `loot.loot`→trade-good, so their dedicated chips never count. Increment `byLootType['loot.gem'/'loot.art']` via the variable-detectors (same pattern ammo already uses).
- **(high/med) `variableTreasureKind` leaks onto magic items** (Pearl of Power, Gem of Seeing, Figurine of Wondrous Power tagged as "gem"). Restrict the gem/art detectors to genuinely mundane treasure.
- **(med/low) Finish wiring `loot.reagent`** — add it to `MUNDANE_LOOT_TYPES` + an `isReagentItem()` predicate so the new chip is classified, not half-wired.
- **(med/med) Centralize the dnd5e-type→lootType derivation** into one `deriveLootTypeFromDnd5e()` so curators tag from one rule.

### Loot balance
- **(high/med) Rarity and tier are collinear** — t1 is 100% common, t2 100% uncommon, t3 100% rare, t4 very-rare+legendary. The two filter dials aren't independent; high-tier + common resolves to ~20 items (no magic chip has any). Re-tier so rarities span multiple tiers, and/or add tier-agnostic "staples."
- **(high/med) `getEffectiveRarity()` floors 251 untagged items to "common"** (incl. genuinely magic ones). Backfill real rarities; make the floor conservative.
- **(med/med) `maxRecommendedQty` is inert for 640/649 items** — only ammunition honors it. Either honor it for stackable consumables/trade-goods or drop the flag.
- **(low/low) "Artifact" is a dead chip** — zero artifact items, yet it has UI presence + preset weights. Add content or hide it.

### Merchant
- **(high/low) Fix the buy-filter magic heuristic** (S6) and **add `test-merchant-buy-filter.mjs`** (the only untested merchant module).
- **(med/med) `merchantCategories`/`saleLiquidity`/`sellValueGp` are dead flags** — on all 1,741 items but read by zero runtime code. Wire up `sellValueGp` as the sell authority, or delete them. The 42-value taxonomy also has redundant twins (tool/tools, container/storage).
- **(med/med) Couple market-tier presets to rarity/lootType**, not just a gp ceiling.

### Content quality
- **(high/low) Strip the `Planned icon` dev-note** (S1) + suppress empty `Rarity:` lines (251 items render `Rarity: ` with nothing after).
- **(high/med) Spell *source* docs shouldn't carry identify/Use machinery** — the 319 spell docs get the full lootable-item UI.
- **(med/med) The "Value:" line mixes magnitude and unit** — Piton renders "Value: 0.05 cp" (should be "5 cp"). Render from `system.price` directly.

### dnd5e correctness
- **(high/low) Strip phantom utility activities from all 243 loot items** (S5).
- **(med/low) Fix swapped poison/potion subtypes** — Basic Poison is under `potion`; Potion of Poison is under `poison`. Also consider a real **Poison chip** (currently `loot.poison`→folds into consumable).
- **(med/med) Decide consumable-vs-loot for reusable gear** — rope/torch/lamp/piton are `consumable/trinket` with `uses.max:1` while crowbar/bedroll/bell are `type:loot`; unify.
- **(low/low) Promote named gems/art to native dnd5e `gem`/`art` loot subtypes**; clamp sub-copper prices (Ball Bearings 0.1 cp → 1 gp/bag).

### Tooling / regression prevention (the durable win)
Add these `scripts/test-*.mjs` (auto-discovered by `run-checks.mjs`):
- **`test-pack-duplicates.mjs`** — fail on true duplicate (name+type) clusters.
- **`test-pack-loottype.mjs`** — assert each item's canonical lootType is valid for its dnd5e type, reusing `getItemLootType`/`getItemMagicNature`.
- **`test-pack-descriptions.mjs`** — deny-list scan for `Planned icon`, `TODO`, mojibake, empty labels, unresolved `{{handlebars}}`.
- **`test-pack-rarity.mjs`** — canonical rarity format + magic-needs-rarity + mundane-policy.
- **`test-pack-pricing.mjs`** — `price`↔`gpValue`↔`valueBand` consistency.
- **`migrate-pack-dedup.mjs`** — a repeatable, idempotent dedup + re-tag migration (modeled on the existing `migrate-pack-namespace.mjs`), gated by `--dedup`/`--retag`/`--rarity` flags.

---

## 5. Recommended action plan

**Phase 1 — safe to automate now (mechanical, high value):**
1. Strip the `Planned icon` dev-note from all descriptions (S1) + suppress empty `Rarity:` lines.
2. De-dupe the 108 accidental copies (S2), holding Incense/Amethyst variants for human review.
3. Strip phantom utility activities from `type:loot` items (S5).
4. Fix the buy-filter magic heuristic (S6) + add its test.
5. Fix mojibake + batch misspellings (3d) — pure find/replace.
6. Land the 6 CI validators + the dedup migration script (so none of the above can regress).

**Phase 2 — needs a rule decision, then automate:**
7. Pick + apply the mundane-rarity policy (S3) and canonical rarity format (S4).
8. Backfill rarities on the 251 floored items; address tier↔rarity collinearity.

**Phase 3 — human judgment per item:**
9. The 17 miscategorizations (wondrous-as-armor, foci-as-magic-weapons, decks, Component Pouch/Airship Supplies) — each is a small, well-specified edit; the re-tag migration can cascade folder/keyword changes once the root `system.type.value`/`lootType` is set.
10. The 12 pricing/rarity corrections (3b/3c).
11. The copy-paste flavor fixes (Flute, Shield-spell, 6 named packs) + real-world-name renames (Taurine, Berryl, Red Ammonita).

**Phase 4 — strategic (optional, larger):**
12. Tag-schema centralization (one classifier table + `deriveLootTypeFromDnd5e`), gem/art chip counts, merchant-flag wire-up-or-delete, loot-balance re-tiering.

---

*Generated by a multi-agent audit workflow. Per-item raw data alongside this report: `confirmed.json` (61 findings with verifier notes), `designs.json` (45 design proposals), `summary.json` (full distributions + duplicate list).*
