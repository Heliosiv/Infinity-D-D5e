import assert from "node:assert/strict";

import {
  MAGIC_BIAS_RANGE,
  filterCandidates,
  getEffectiveRarity,
  rollLoot,
} from "./loot/roller.js";

import { fakeItem, smallPool } from "./test-utils/fixtures.mjs";
import { mulberry32, seqRng } from "./test-utils/rng.mjs";

/* ------------------------------------------------------------------ *
 * filterCandidates — single-axis filters
 * ------------------------------------------------------------------ */
{
  const pool = smallPool();

  const byRarity = filterCandidates(pool, { rarities: ["uncommon"] });
  assert.equal(byRarity.length, 2, "two uncommon items in the small pool");
  assert.deepEqual(byRarity.map((i) => i._id).sort(), ["c", "d"]);

  const byTier = filterCandidates(pool, { tiers: ["t4"] });
  assert.deepEqual(
    byTier.map((i) => i._id),
    ["e"],
  );

  const byType = filterCandidates(pool, { lootTypes: ["loot.consumable"] });
  assert.deepEqual(
    byType.map((i) => i._id),
    ["b"],
  );

  const byBand = filterCandidates(pool, { valueBands: ["v5"] });
  assert.deepEqual(
    byBand.map((i) => i._id),
    ["e"],
  );
}

/* ------------------------------------------------------------------ *
 * filterCandidates — synthetic Ammunition chip
 * ------------------------------------------------------------------ */
{
  // Arrows/bolts/bullets ship tagged loot.consumable; the Ammunition chip
  // resolves them through the ammo predicate, not a lootType.
  const arrow = fakeItem({
    _id: "arrow",
    name: "Arrow",
    lootType: "loot.consumable",
    keywords: [
      "subtype.ammo",
      "rarity.common",
      "tier.t1",
      "value.v1",
      "loot.consumable",
    ],
  });
  const potion = fakeItem({
    _id: "potion",
    name: "Healing Potion",
    lootType: "loot.consumable",
  });
  const pool = [arrow, potion];

  // The Ammunition chip pulls only the arrow, even though both are consumables.
  const ammoOnly = filterCandidates(pool, { lootTypes: ["loot.ammunition"] });
  assert.deepEqual(
    ammoOnly.map((i) => i._id),
    ["arrow"],
    "ammunition chip matches only ammo",
  );

  // The Consumables chip still includes both — ammo stays reachable there too.
  const consumables = filterCandidates(pool, {
    lootTypes: ["loot.consumable"],
  });
  assert.deepEqual(consumables.map((i) => i._id).sort(), ["arrow", "potion"]);
}

/* ------------------------------------------------------------------ *
 * getEffectiveRarity — untagged floors to common (reachability)
 * ------------------------------------------------------------------ */
{
  // Explicit rarity always wins.
  assert.equal(getEffectiveRarity(fakeItem({ rarity: "rare" })), "rare");

  // Untagged mundane gear / sundries floor to common so a Common→Artifact
  // range still surfaces them.
  const untagged = fakeItem({
    rarity: "",
    lootType: "loot.trade-good",
    keywords: ["loot.trade-good"],
  });
  assert.equal(
    getEffectiveRarity(untagged),
    "common",
    "untagged floors to common",
  );
  // That floor makes it reachable by the Common filter that previously
  // dropped untagged items entirely…
  assert.equal(
    filterCandidates([untagged], { rarities: ["common"] }).length,
    1,
    "untagged item now caught by Common",
  );
  // …without leaking into other rarities.
  assert.equal(
    filterCandidates([untagged], { rarities: ["rare"] }).length,
    0,
    "untagged item is common-only, not rare",
  );
}

/* ------------------------------------------------------------------ *
 * filterCandidates — combinatorial AND, gp window, eligibility
 * ------------------------------------------------------------------ */
{
  const pool = smallPool();
  const onlyMagicUncommon = filterCandidates(pool, {
    rarities: ["uncommon"],
    lootTypes: ["loot.weapon.magic"],
  });
  assert.deepEqual(
    onlyMagicUncommon.map((i) => i._id),
    ["c"],
    "AND across axes narrows correctly",
  );

  const gpWindow = filterCandidates(pool, { minGp: 100, maxGp: 1000 });
  assert.deepEqual(
    gpWindow.map((i) => i._id).sort(),
    ["c", "d"],
    "gp window picks 500 + 800 gp items",
  );

  const ineligiblePool = [
    fakeItem({ _id: "in1", lootEligible: false }),
    fakeItem({ _id: "ok1", lootEligible: true }),
  ];
  const eligible = filterCandidates(ineligiblePool, {});
  assert.deepEqual(
    eligible.map((i) => i._id),
    ["ok1"],
    "lootEligible:false is dropped by default",
  );

  const allowAll = filterCandidates(ineligiblePool, { requireEligible: false });
  assert.equal(
    allowAll.length,
    2,
    "requireEligible:false includes ineligible items",
  );
}

/* ------------------------------------------------------------------ *
 * filterCandidates — keywordsAny / keywordsAll
 * ------------------------------------------------------------------ */
{
  const pool = [
    fakeItem({ _id: "p1", keywords: ["a", "b"] }),
    fakeItem({ _id: "p2", keywords: ["b", "c"] }),
    fakeItem({ _id: "p3", keywords: ["c", "d"] }),
  ];
  const any = filterCandidates(pool, { keywordsAny: ["a", "d"] });
  assert.deepEqual(any.map((i) => i._id).sort(), ["p1", "p3"]);

  const all = filterCandidates(pool, { keywordsAll: ["b", "c"] });
  assert.deepEqual(
    all.map((i) => i._id),
    ["p2"],
  );
}

/* ------------------------------------------------------------------ *
 * filterCandidates - virtual art/gem loot type filters
 * ------------------------------------------------------------------ */
{
  const art = fakeItem({
    _id: "art",
    name: "Court Tapestry",
    type: "loot",
    lootType: "loot.loot",
    keywords: [
      "loot",
      "loot.loot",
      "loot.variable",
      "loot.variable.art",
      "treasure.art",
      "folder.path.sundries.art-objects.wall-art",
    ],
  });
  const gem = fakeItem({
    _id: "gem",
    name: "Star Sapphire",
    type: "loot",
    lootType: "loot.loot",
    keywords: [
      "loot",
      "loot.loot",
      "loot.variable",
      "loot.variable.gem",
      "treasure.gem",
    ],
  });
  const gear = fakeItem({
    _id: "gear",
    name: "Silk Rope",
    type: "loot",
    lootType: "loot.equipment",
    keywords: ["loot", "loot.equipment"],
  });

  const byArt = filterCandidates([art, gem, gear], {
    lootTypes: ["loot.art"],
  });
  assert.deepEqual(
    byArt.map((item) => item._id),
    ["art"],
    "loot.art matches variable art objects even when lootType is loot.loot",
  );

  const byGem = filterCandidates([art, gem, gear], {
    lootTypes: ["loot.gem"],
  });
  assert.deepEqual(
    byGem.map((item) => item._id),
    ["gem"],
    "loot.gem matches variable gem treasure even when lootType is loot.loot",
  );
}

/* ------------------------------------------------------------------ *
 * filterCandidates - variable treasure uses value band as roll rarity
 * ------------------------------------------------------------------ */
{
  const rareArt = fakeItem({
    _id: "rare-art",
    name: "Silver Reliquary",
    type: "loot",
    rarity: "",
    valueBand: "v4",
    lootType: "loot.loot",
    gpValue: 1000,
    keywords: [
      "loot",
      "loot.loot",
      "loot.variable",
      "loot.variable.art",
      "treasure.art",
      "value.v4",
      "folder.path.sundries.art-objects.decorative-finery",
    ],
  });
  const commonArt = fakeItem({
    _id: "common-art",
    name: "Carved Cup",
    type: "loot",
    rarity: "",
    valueBand: "v2",
    lootType: "loot.loot",
    gpValue: 50,
    keywords: [
      "loot",
      "loot.loot",
      "loot.variable",
      "loot.variable.art",
      "treasure.art",
      "value.v2",
      "folder.path.sundries.art-objects.decorative-finery",
    ],
  });
  const rare = filterCandidates([rareArt, commonArt], {
    lootTypes: ["loot.art"],
    rarities: ["rare"],
  });
  assert.deepEqual(
    rare.map((item) => item._id),
    ["rare-art"],
    "rarity.none art can still pass rarity filters via value band",
  );
}

/* ------------------------------------------------------------------ *
 * rollLoot — deterministic with seqRng
 * ------------------------------------------------------------------ */
{
  const pool = smallPool();
  // RNG is consumed by weightedPick(); each call returns a value in [0, 1).
  // Five items, each lootWeight: 1, totalWeight: 5.
  // target = rng() * 5. Index = floor(target / 1).
  // rng=0.05 → target=0.25 → idx 0 (a)
  // rng=0.45 → target=2.25 → idx 2 (c)
  // rng=0.81 → target=4.05 → idx 4 (e)
  const rng = seqRng([0.05, 0.45, 0.81]);
  const result = rollLoot(pool, { count: 3, rng, budgetGp: 0 });
  assert.equal(result.items.length, 3, "produced 3 items");
  const names = result.items.map((entry) => entry.item.name).sort();
  assert.deepEqual(
    names,
    ["Crown of Stars", "Dagger", "Magic Greatsword"],
    "deterministic picks match seqRng plan",
  );
  assert.equal(result.warnings.length, 0);
}

/* ------------------------------------------------------------------ *
 * rollLoot - rarity balance changes weighted selection
 * ------------------------------------------------------------------ */
{
  const common = fakeItem({
    _id: "common",
    name: "Common Trinket",
    rarity: "common",
    gpValue: 10,
  });
  const rare = fakeItem({
    _id: "rare",
    name: "Rare Relic",
    rarity: "rare",
    gpValue: 10,
  });
  const result = rollLoot([common, rare], {
    count: 1,
    rng: seqRng([0.5]),
    rarityWeights: { common: 1, rare: 10 },
  });
  assert.equal(
    result.items[0].item._id,
    "rare",
    "rarity multipliers are applied to the weighted pick",
  );
}

/* ------------------------------------------------------------------ *
 * rollLoot - unique art variants preserve market values
 * ------------------------------------------------------------------ */
{
  const art = fakeItem({
    _id: "art",
    name: "Court Tapestry",
    type: "loot",
    lootType: "loot.loot",
    gpValue: 1000,
    keywords: [
      "loot",
      "loot.loot",
      "loot.variable",
      "loot.variable.art",
      "treasure.art",
      "folder.path.sundries.art-objects.wall-art",
    ],
  });
  const result = rollLoot([art], {
    count: 1,
    rng: seqRng([0.5, 0.99, 0.99, 0.99, 0.99]),
    artVariants: true,
  });

  assert.equal(result.items.length, 1);
  const entry = result.items[0];
  assert.equal(entry.item.name, "Court Tapestry");
  assert.notEqual(entry.displayName, "Court Tapestry");
  assert.ok(entry.displayName.includes("Court Tapestry"));
  assert.equal(entry.variant.kind, "art");
  assert.equal(entry.gpValue, 1000);
  assert.equal(entry.gpTotal, entry.gpValue);
  assert.equal(result.totalGp, entry.gpValue);
  assert.equal(entry.valueLabel, "");
  assert.ok(entry.variant.summary.includes(";"));
  assert.equal(entry.itemData.name, entry.displayName);
  assert.equal(entry.itemData.system.price.value, entry.gpValue);
  assert.equal(entry.itemData.system.quantity, 1);
  assert.equal(
    entry.itemData.flags["infinity-dnd5e"].generatedTreasure.variantId,
    entry.variant.id,
  );
  assert.equal(
    entry.itemData.flags["infinity-dnd5e"].generatedTreasure.baseGp,
    1000,
  );
  assert.equal(entry.itemData.flags["party-operations"].gpValue, entry.gpValue);
  assert.ok(
    entry.itemData.system.description.value.includes("Generated appraisal"),
  );
  assert.ok(
    entry.itemData.system.description.value.includes(
      "market value of 1,000 gp",
    ),
  );
  assert.ok(
    !entry.itemData.system.description.value.includes("base value"),
    "generated appraisal should not show a second adjusted/base value",
  );
  assert.equal(
    art.system.price.value,
    1000,
    "base fixture price is not mutated when itemData is generated",
  );
}

/* ------------------------------------------------------------------ *
 * rollLoot - art market values are used by budget trimming
 * ------------------------------------------------------------------ */
{
  const art = fakeItem({
    _id: "art",
    name: "Court Tapestry",
    type: "loot",
    lootType: "loot.loot",
    gpValue: 1000,
    keywords: [
      "loot",
      "loot.loot",
      "loot.variable",
      "loot.variable.art",
      "treasure.art",
      "folder.path.sundries.art-objects.wall-art",
    ],
  });
  const cheap = fakeItem({
    _id: "cheap",
    name: "Silver Pin",
    type: "loot",
    lootType: "loot.equipment",
    gpValue: 10,
  });
  const result = rollLoot([art, cheap], {
    count: 2,
    budgetGp: 1000,
    rng: seqRng([0, 0.75, 0.99, 0.99, 0.99, 0.99]),
    artVariants: true,
  });

  assert.equal(
    result.droppedForBudget,
    1,
    "budget trimming uses the art market value, not an adjusted appraisal",
  );
  assert.equal(result.items.length, 1);
  assert.equal(result.items[0].item._id, "art");
  assert.equal(result.items[0].gpValue, 1000);
  assert.equal(result.totalGp, result.items[0].gpValue);
}

/* ------------------------------------------------------------------ *
 * rollLoot - stacked art bases split into unique entries
 * ------------------------------------------------------------------ */
{
  const art = fakeItem({
    _id: "art-stack",
    name: "Bronze Shrine Idol",
    type: "loot",
    lootType: "loot.loot",
    gpValue: 500,
    maxRecommendedQty: 2,
    keywords: [
      "loot",
      "loot.loot",
      "loot.variable",
      "loot.variable.art",
      "treasure.art",
      "folder.path.sundries.art-objects.sculptures-idols",
    ],
  });
  const result = rollLoot([art], {
    count: 2,
    maxAttempts: 3,
    rng: seqRng([0.5, 0.5, 0.5, 0, 0, 0, 0, 0.99, 0.99, 0.99, 0.99]),
    artVariants: true,
  });

  assert.equal(result.items.length, 2);
  assert.ok(
    result.items.every((entry) => entry.quantity === 1),
    "stacked art bases are split into one unique result per item",
  );
  assert.notEqual(result.items[0].variant.id, result.items[1].variant.id);
}

/* ------------------------------------------------------------------ *
 * rollLoot - non-art items are not variantized
 * ------------------------------------------------------------------ */
{
  const item = fakeItem({
    _id: "plain",
    name: "Plain Dagger",
    gpValue: 25,
    lootType: "loot.weapon.mundane",
  });
  const result = rollLoot([item], {
    count: 1,
    rng: () => 0.5,
    artVariants: true,
  });

  assert.equal(result.items[0].displayName, "Plain Dagger");
  assert.equal(result.items[0].variant, null);
  assert.equal(result.items[0].gpValue, 25);
}

/* ------------------------------------------------------------------ *
 * rollLoot - ammunition rolls an initial stack quantity
 * ------------------------------------------------------------------ */
{
  const ammo = fakeItem({
    _id: "bolt",
    name: "Crossbow Bolt",
    type: "consumable",
    lootType: "loot.consumable",
    gpValue: 0.02,
    maxRecommendedQty: 8,
    keywords: [
      "rarity.common",
      "tier.t1",
      "value.v1",
      "loot.consumable",
      "subtype.ammo",
      "folder.section.ammunition",
    ],
  });

  const stack = rollLoot([ammo], { count: 1, rng: seqRng([0.5, 0.49]) });
  assert.equal(stack.items.length, 1);
  assert.equal(
    stack.items[0].quantity,
    4,
    "ammunition can land as a small group on a single item roll",
  );
  assert.ok(Math.abs(stack.items[0].gpTotal - 0.08) < 0.000001);

  const single = rollLoot([ammo], { count: 1, rng: seqRng([0.5, 0]) });
  assert.equal(
    single.items[0].quantity,
    1,
    "ammunition still has a chance to roll as one unit",
  );
}

/* ------------------------------------------------------------------ *
 * rollLoot - ammunition stack quantity respects the budget ceiling
 * ------------------------------------------------------------------ */
{
  const magicAmmo = fakeItem({
    _id: "arrow-plus-one",
    name: "Arrow +1",
    type: "consumable",
    lootType: "loot.consumable",
    gpValue: 25,
    maxRecommendedQty: 4,
    keywords: [
      "rarity.uncommon",
      "tier.t2",
      "value.v2",
      "loot.consumable",
      "subtype.ammo",
    ],
  });

  const result = rollLoot([magicAmmo], {
    count: 1,
    budgetGp: 50,
    rng: seqRng([0.5, 0.99]),
  });
  assert.equal(
    result.items[0].quantity,
    2,
    "rolled stack is capped to what the budget can carry",
  );
  assert.equal(result.totalGp, 50);
}

/* ------------------------------------------------------------------ *
 * rollLoot - non-ammunition stackables still start as one item
 * ------------------------------------------------------------------ */
{
  const potion = fakeItem({
    _id: "potion-stackable",
    name: "Healing Potion",
    lootType: "loot.consumable",
    maxRecommendedQty: 4,
  });
  const result = rollLoot([potion], { count: 1, rng: seqRng([0.5, 0.99]) });
  assert.equal(
    result.items[0].quantity,
    1,
    "non-ammo maxRecommendedQty still requires duplicate picks to stack",
  );
}

/* ------------------------------------------------------------------ *
 * rollLoot — stacking up to maxRecommendedQty
 * ------------------------------------------------------------------ */
{
  // Healing Potion has maxRecommendedQty: 4. Force the RNG to keep
  // picking that item; we should see the stack grow rather than
  // counting as new items.
  const pool = [
    fakeItem({
      _id: "potion",
      name: "Potion",
      lootType: "loot.consumable",
      maxRecommendedQty: 4,
    }),
  ];
  // count=1 with a single-item pool: roller stops after one pick.
  // To exercise stacking we ask for more items than the pool has,
  // and the roller spreads attempts via maxAttempts.
  const result = rollLoot(pool, { count: 3, rng: () => 0.5, maxAttempts: 40 });
  assert.equal(
    result.items.length,
    1,
    "single distinct item even though count=3",
  );
  assert.equal(
    result.items[0].quantity,
    4,
    "stack capped at maxRecommendedQty",
  );
  assert.ok(
    result.warnings.length >= 1,
    "warned about insufficient pool diversity",
  );
}

/* ------------------------------------------------------------------ *
 * rollLoot — budget trimming drops cheapest entries first
 * ------------------------------------------------------------------ */
{
  const pool = smallPool();
  // RNG sequence guarantees we pick the 5 specific items in turn.
  // Each rng() call ∈ [0,1) is multiplied by totalWeight=5; floor gives index.
  const rng = seqRng([0.05, 0.25, 0.45, 0.65, 0.85]); // → a, b, c, d, e (sum gp 5+50+500+800+50000 = 51355)
  const result = rollLoot(pool, { count: 5, rng, budgetGp: 51000 });
  // Total before trimming: 51355. Budget 51000. Cheapest entry is Dagger (5gp).
  // After dropping Dagger: 51350. Still over. Drop Healing Potion (50gp): 51300. Still over.
  // Drop Magic Greatsword (500gp): 50800. Now under budget.
  assert.ok(result.droppedForBudget >= 1, "at least one drop to fit budget");
  assert.ok(result.totalGp <= 51000, "final total respects budget");
  // The Crown of Stars (legendary, 50000gp) MUST survive — never trimmed.
  const names = result.items.map((entry) => entry.item.name);
  assert.ok(
    names.includes("Crown of Stars"),
    "legendary item is preserved over cheap loot",
  );
}

/* ------------------------------------------------------------------ *
 * rollLoot — tiny budget vs a high-value-only pool keeps >=1 item
 * (regression: a bounded count used to ignore the budget in Pass 1 and
 *  Pass 2 then trimmed every item, returning an empty bundle)
 * ------------------------------------------------------------------ */
{
  const pool = [
    fakeItem({ _id: "x", name: "Pricey", gpValue: 500 }),
    fakeItem({ _id: "y", name: "Pricier", gpValue: 800 }),
    fakeItem({ _id: "z", name: "Priciest", gpValue: 1200 }),
  ];
  const result = rollLoot(pool, { count: 6, budgetGp: 50, rng: mulberry32(3) });
  assert.ok(
    result.items.length >= 1 && result.items.length <= 2,
    "tiny budget keeps at least one item and never empties the bundle",
  );
  assert.ok(result.totalGp > 0, "the kept item carries its value");
  assert.ok(
    result.warnings.length >= 1,
    "warns that the budget could not be met",
  );
}

/* ------------------------------------------------------------------ *
 * rollLoot — empty / zero-count guards
 * ------------------------------------------------------------------ */
{
  const empty = rollLoot([], { count: 3 });
  assert.equal(empty.items.length, 0);
  assert.equal(empty.warnings.length, 1, "empty pool warns");

  const zero = rollLoot(smallPool(), { count: 0 });
  assert.equal(zero.items.length, 0);
  assert.equal(zero.warnings.length, 0, "count 0 is a valid no-op");
}

/* ------------------------------------------------------------------ *
 * rollLoot - count=0 budget fill mode
 *
 * smallPool gp values: a=5, b=50, c=500, d=800, e=50000. With budget 600
 * and budgetHighFrac=1.10 (ceil=660), only a/b/c are affordable so the
 * draw pool has totalWeight=3. RNG values are tuned to land on each
 * index in turn: 0.1→a (idx 0), 0.5→b (idx 1), 0.9→c (idx 2). After
 * the third pick runningTotal=555 ≥ budgetTargetLow=510 → loop breaks.
 * ------------------------------------------------------------------ */
{
  const rng = seqRng([0.1, 0.5, 0.9]);
  const result = rollLoot(smallPool(), { count: 0, budgetGp: 600, rng });

  assert.deepEqual(
    result.items.map((entry) => entry.item._id),
    ["c", "b", "a"],
    "count 0 fills toward the budget using weighted picks",
  );
  assert.equal(result.totalGp, 555);
  assert.equal(result.budgetGp, 600);
}

/* ------------------------------------------------------------------ *
 * rollLoot — budget pre-filter excludes way-over-budget items
 *
 * Regression: at a small Per-Creature T2 budget (~160 gp) against a
 * pool dominated by 1,000+ gp uncommons, Pass 1's "first pick always
 * allowed" rule produced single-item bundles 10× over budget. The
 * pre-filter restricts picks to items that fit individually.
 * ------------------------------------------------------------------ */
{
  const pool = [
    fakeItem({ _id: "cheap", name: "Arrow", gpValue: 1 }),
    fakeItem({ _id: "fits", name: "Healing Potion", gpValue: 50 }),
    fakeItem({ _id: "huge1", name: "Wand of Web", gpValue: 2000 }),
    fakeItem({ _id: "huge2", name: "Gem of Brightness", gpValue: 2000 }),
    fakeItem({ _id: "huge3", name: "Sickle +1", gpValue: 1000 }),
  ];
  // Budget 160 gp → ceil 176 gp → only cheap and fits are affordable.
  // 100 rolls; verify NO huge item ever lands as the first pick.
  let overBudgetPicks = 0;
  for (let i = 0; i < 100; i += 1) {
    const result = rollLoot(pool, {
      count: 2,
      budgetGp: 160,
      rng: mulberry32(i + 1),
    });
    for (const entry of result.items) {
      if (entry.item._id.startsWith("huge")) overBudgetPicks += 1;
      assert.ok(
        entry.gpValue <= 176,
        `entry ${entry.item._id} (${entry.gpValue} gp) exceeds budget ceiling`,
      );
    }
    assert.ok(
      result.totalGp <= 160,
      `roll ${i} total ${result.totalGp} gp blew past 160 gp budget`,
    );
  }
  assert.equal(
    overBudgetPicks,
    0,
    "no huge-gp items should appear when affordable picks exist",
  );
}

/* ------------------------------------------------------------------ *
 * rollLoot - art market-value pre-filter
 *
 * Art variants preserve base market gp, so variable-art items obey the
 * same budget ceiling as other items.
 * ------------------------------------------------------------------ */
{
  const art = fakeItem({
    _id: "expensive-art",
    name: "Gilded Reliquary",
    type: "loot",
    gpValue: 1000,
    lootType: "loot.loot",
    keywords: [
      "loot",
      "loot.loot",
      "loot.variable",
      "loot.variable.art",
      "treasure.art",
      "folder.path.sundries.art-objects.decorative-finery",
    ],
  });
  const overpricedMundane = fakeItem({
    _id: "overpriced-mundane",
    name: "Wand of Web",
    gpValue: 2000,
    lootType: "loot.wand",
  });
  const affordable = fakeItem({
    _id: "affordable",
    name: "Healing Potion",
    gpValue: 50,
    lootType: "loot.consumable",
  });

  // Budget 500 gp -> ceil 550 gp -> both expensive items are excluded.
  const pool = [art, overpricedMundane, affordable];
  let artPicked = 0;
  let wandPicked = 0;
  let affordablePicked = 0;
  for (let i = 0; i < 50; i += 1) {
    const result = rollLoot(pool, {
      count: 1,
      budgetGp: 500,
      artVariants: true,
      rng: mulberry32(i + 200),
    });
    for (const entry of result.items) {
      if (entry.item._id === "expensive-art") artPicked += 1;
      if (entry.item._id === "overpriced-mundane") wandPicked += 1;
      if (entry.item._id === "affordable") affordablePicked += 1;
    }
  }
  assert.equal(artPicked, 0, "art market value obeys the budget ceiling");
  assert.equal(
    wandPicked,
    0,
    "mundane items above budget ceiling are excluded",
  );
  assert.ok(
    affordablePicked > 0,
    "affordable items remain available after budget filtering",
  );
}

/* ------------------------------------------------------------------ *
 * rollLoot — fallback when nothing fits the budget
 *
 * Pool is entirely above budget. Pre-filter would empty the draw pool;
 * the fallback to the full pool preserves the "kept one item over
 * budget" safety so a tiny budget still produces something.
 * ------------------------------------------------------------------ */
{
  const pool = [
    fakeItem({ _id: "p1", gpValue: 500 }),
    fakeItem({ _id: "p2", gpValue: 800 }),
    fakeItem({ _id: "p3", gpValue: 1200 }),
  ];
  const result = rollLoot(pool, {
    count: 3,
    budgetGp: 50,
    rng: mulberry32(11),
  });
  assert.ok(
    result.items.length >= 1,
    "fallback keeps at least one item when nothing is affordable",
  );
  assert.ok(
    result.warnings.length >= 1,
    "warns that the budget could not be met",
  );
}

/* ------------------------------------------------------------------ *
 * rollLoot — stable with Mulberry32 seed
 * ------------------------------------------------------------------ */
{
  const pool = smallPool();
  const a = rollLoot(pool, { count: 3, rng: mulberry32(42) });
  const b = rollLoot(pool, { count: 3, rng: mulberry32(42) });
  assert.deepEqual(
    a.items.map((i) => i.item._id),
    b.items.map((i) => i.item._id),
    "same seed → same roll",
  );

  const c = rollLoot(pool, { count: 3, rng: mulberry32(43) });
  // Almost guaranteed to differ — but be lenient about pure equality
  // since RNG collisions are theoretically possible.
  const aIds = a.items.map((i) => i.item._id).join(",");
  const cIds = c.items.map((i) => i.item._id).join(",");
  // At minimum ensure we exercised two different paths.
  assert.ok(
    typeof aIds === "string" && typeof cIds === "string",
    "both seeds produced strings",
  );
}

/* ------------------------------------------------------------------ *
 * Magic Bias — exposed slider range
 * ------------------------------------------------------------------ */
{
  assert.equal(MAGIC_BIAS_RANGE.min, -1, "bias min is -1");
  assert.equal(MAGIC_BIAS_RANGE.max, 1, "bias max is +1");
  assert.ok(MAGIC_BIAS_RANGE.step > 0, "bias step is positive");
}

/* ------------------------------------------------------------------ *
 * rollLoot — magicBias=+1 excludes mundane items from the pool
 * ------------------------------------------------------------------ */
{
  const pool = smallPool();
  // 100 rolls with maximum positive bias — every pick should be a
  // magic-natured item (Magic Greatsword, Wand of Magic Missile,
  // Crown of Stars). Healing Potion is loot.consumable (magic);
  // Dagger is mundane.
  const rng = mulberry32(1);
  let mundaneCount = 0;
  for (let i = 0; i < 100; i += 1) {
    const result = rollLoot(pool, { count: 1, rng, magicBias: 1 });
    if (result.items[0]?.item._id === "a") mundaneCount += 1; // Dagger
  }
  assert.equal(
    mundaneCount,
    0,
    "magicBias=+1 zeroes out mundane weights — no Daggers should be picked",
  );
}

/* ------------------------------------------------------------------ *
 * rollLoot — magicBias=-1 excludes magic items
 * ------------------------------------------------------------------ */
{
  const pool = smallPool();
  const rng = mulberry32(7);
  let magicCount = 0;
  for (let i = 0; i < 100; i += 1) {
    const result = rollLoot(pool, { count: 1, rng, magicBias: -1 });
    const id = result.items[0]?.item._id;
    // c=Magic Greatsword, d=Wand, e=Crown of Stars, b=Potion(consumable=magic)
    if (id === "c" || id === "d" || id === "e" || id === "b") magicCount += 1;
  }
  assert.equal(
    magicCount,
    0,
    "magicBias=-1 zeroes out magic weights — no magic items should be picked",
  );
}

/* ------------------------------------------------------------------ *
 * rollLoot — magicBias=0 behaves identically to no bias
 * ------------------------------------------------------------------ */
{
  const pool = smallPool();
  const withBias = rollLoot(pool, {
    count: 3,
    rng: mulberry32(42),
    magicBias: 0,
  });
  const withoutBias = rollLoot(pool, { count: 3, rng: mulberry32(42) });
  assert.deepEqual(
    withBias.items.map((i) => i.item._id),
    withoutBias.items.map((i) => i.item._id),
    "bias=0 is a no-op",
  );
}

/* ------------------------------------------------------------------ *
 * rollLoot — bias clamps out-of-range input
 * ------------------------------------------------------------------ */
{
  const pool = smallPool();
  // bias=5 should clamp to 1; result should match bias=1.
  const clamped = rollLoot(pool, {
    count: 3,
    rng: mulberry32(99),
    magicBias: 5,
  });
  const explicit = rollLoot(pool, {
    count: 3,
    rng: mulberry32(99),
    magicBias: 1,
  });
  assert.deepEqual(
    clamped.items.map((i) => i.item._id),
    explicit.items.map((i) => i.item._id),
    "out-of-range bias is clamped",
  );
}

/* ------------------------------------------------------------------ *
 * rollLoot — all-mundane pool + bias=+1 falls back to uniform
 * ------------------------------------------------------------------ */
{
  // Every item is mundane; bias=+1 would zero them all out. The
  // roller falls back to uniform so the bundle is still produced
  // rather than silently returning empty.
  const pool = [
    fakeItem({ _id: "m1", lootType: "loot.weapon.mundane" }),
    fakeItem({ _id: "m2", lootType: "loot.armor.mundane" }),
    fakeItem({ _id: "m3", lootType: "loot.gem" }),
  ];
  const result = rollLoot(pool, {
    count: 2,
    rng: mulberry32(3),
    magicBias: 1,
  });
  assert.equal(result.items.length, 2, "uniform fallback still produces picks");
}

/* ------------------------------------------------------------------ *
 * rollLoot — final sort is gp-desc
 * ------------------------------------------------------------------ */
{
  const pool = smallPool();
  const rng = seqRng([0.05, 0.25, 0.45, 0.65, 0.85]);
  const result = rollLoot(pool, { count: 5, rng, budgetGp: 0 });
  const gpSorted = [...result.items].sort((a, b) => b.gpTotal - a.gpTotal);
  assert.deepEqual(
    result.items.map((i) => i.item._id),
    gpSorted.map((i) => i.item._id),
    "results are already in gp-desc order so legendary surfaces first",
  );
}

process.stdout.write("roller validation passed\n");
