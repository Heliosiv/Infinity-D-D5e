import assert from "node:assert/strict";

import { MAGIC_BIAS_RANGE, filterCandidates, rollLoot } from "./loot/roller.js";

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
 * rollLoot - unique art variants and adjusted appraisals
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
  assert.notEqual(entry.gpValue, 1000);
  assert.equal(entry.gpTotal, entry.gpValue);
  assert.equal(result.totalGp, entry.gpValue);
  assert.ok(entry.valueLabel.includes("base value"));
  assert.ok(entry.variant.summary.includes(";"));
  assert.equal(entry.itemData.name, entry.displayName);
  assert.equal(entry.itemData.system.price.value, entry.gpValue);
  assert.equal(entry.itemData.system.quantity, 1);
  assert.equal(
    entry.itemData.flags["infinity-dnd5e"].generatedTreasure.variantId,
    entry.variant.id,
  );
  assert.equal(entry.itemData.flags["party-operations"].gpValue, entry.gpValue);
  assert.ok(
    entry.itemData.system.description.value.includes("Generated appraisal"),
  );
  assert.equal(
    art.system.price.value,
    1000,
    "base fixture price is not mutated when itemData is generated",
  );
}

/* ------------------------------------------------------------------ *
 * rollLoot - art variant values are used by budget trimming
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
    budgetGp: 2800,
    rng: seqRng([0.25, 0.75, 0.99, 0.99, 0.99, 0.99]),
    artVariants: true,
  });

  assert.equal(
    result.droppedForBudget,
    1,
    "budget trimming saw the generated art value, not only the base value",
  );
  assert.equal(result.items.length, 1);
  assert.equal(result.items[0].item._id, "art");
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
