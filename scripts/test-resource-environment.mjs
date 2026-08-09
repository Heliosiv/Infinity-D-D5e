import assert from "node:assert/strict";

import {
  DEFAULT_ENVIRONMENTS,
  ENVIRONMENT_DC_MAX,
  ENVIRONMENT_ID_MAX_LENGTH,
  LEGACY_BUILT_IN_ENVIRONMENT_IDS,
  YIELD_FORMULA_LIMITS,
  createUniqueEnvironmentId,
  duplicateEnvironment,
  getDefaultEnvironments,
  findEnvironment,
  isForageable,
  isCustomEnvironment,
  mergeBuiltInEnvironments,
  normalizeEnvironment,
  normalizeEnvironmentCatalog,
  updateEnvironmentFields,
  validateEnvironmentDraft,
  validateYieldFormula,
} from "./resource/environment.js";

/* ------------------------------------------------------------------ *
 * Default catalog — DMG-aligned DCs
 * ------------------------------------------------------------------ */
{
  const byId = Object.fromEntries(DEFAULT_ENVIRONMENTS.map((e) => [e.id, e]));
  assert.deepEqual(LEGACY_BUILT_IN_ENVIRONMENT_IDS, [
    "abundant",
    "limited",
    "sparse",
    "settlement",
    "underground",
  ]);
  assert.equal(byId.abundant.dc, 10);
  assert.equal(byId.limited.dc, 15);
  assert.equal(byId.sparse.dc, 20);
  assert.equal(byId.abundant.forageable, true);
  assert.equal(byId.settlement.forageable, false);
  assert.equal(byId.underground.forageable, false);
  assert.ok(DEFAULT_ENVIRONMENTS.every((entry) => entry.builtIn === true));

  for (const [id, foodDc, waterDc, yieldFood, yieldWater] of [
    ["biome-forest", 10, 10, "1d6", "1d6"],
    ["biome-rainforest", 10, 15, "1d8", "1d8"],
    ["biome-grassland", 10, 15, "1d6", "1d4"],
    ["biome-coast", 10, 15, "1d6", "1d4"],
    ["biome-hills", 15, 15, "1d6", "1d4"],
    ["biome-mountains", 20, 15, "1d4", "1d4"],
    ["biome-swamp", 15, 20, "1d4", "1d4"],
    ["biome-desert", 20, 25, "1d4", "1d2"],
    ["biome-tundra", 20, 15, "1d4", "1d4"],
    ["biome-riverlands", 10, 10, "1d6", "1d8"],
  ]) {
    assert.equal(byId[id].foodDc, foodDc, `${id} food DC`);
    assert.equal(byId[id].waterDc, waterDc, `${id} water DC`);
    assert.equal(byId[id].dc, Math.max(foodDc, waterDc), `${id} shared DC`);
    assert.equal(byId[id].yieldFood, yieldFood, `${id} food yield`);
    assert.equal(byId[id].yieldWater, yieldWater, `${id} water yield`);
  }

  // getDefaultEnvironments returns a mutable copy (not frozen).
  const copy = getDefaultEnvironments();
  copy[0].dc = 99;
  assert.equal(DEFAULT_ENVIRONMENTS[0].dc, 10, "defaults are not mutated");
}

/* ------------------------------------------------------------------ *
 * normalizeEnvironment
 * ------------------------------------------------------------------ */
{
  assert.equal(normalizeEnvironment(null), null);
  assert.equal(normalizeEnvironment({}), null, "no id → dropped");

  const env = normalizeEnvironment({ id: "swamp", label: "Swamp", dc: 12 });
  assert.equal(env.id, "swamp");
  assert.equal(env.label, "Swamp");
  assert.equal(env.dc, 12);
  assert.equal(env.foodDc, 12);
  assert.equal(env.waterDc, 12);
  assert.equal(env.forageable, true);
  assert.equal(env.yieldFood, "1d6");
  assert.equal(env.builtIn, false);

  const splitDc = normalizeEnvironment({
    id: "dry-valley",
    dc: 15,
    foodDc: 20,
    waterDc: 25,
  });
  assert.equal(splitDc.foodDc, 20);
  assert.equal(splitDc.waterDc, 25);
  assert.equal(splitDc.dc, 25, "legacy dc exposes the harder channel");

  const provenance = normalizeEnvironment({
    id: "preset",
    builtIn: true,
  });
  assert.equal(provenance.builtIn, true);

  // forageable:false zeroes yields by default.
  const town = normalizeEnvironment({ id: "town", forageable: false });
  assert.equal(town.forageable, false);
  assert.equal(town.yieldFood, "0");
  assert.equal(town.dc, 0);
  assert.equal(town.foodDc, 0);
  assert.equal(town.waterDc, 0);

  // Junk die strings fall back; valid ones pass through.
  assert.equal(
    normalizeEnvironment({ id: "x", yieldFood: "2d6+1" }).yieldFood,
    "2d6+1",
  );
  assert.equal(
    normalizeEnvironment({ id: "y", yieldFood: "drop tables;" }).yieldFood,
    "1d6",
  );
}

/* ------------------------------------------------------------------ *
 * normalizeEnvironmentCatalog — dedupe, fallback to defaults
 * ------------------------------------------------------------------ */
{
  assert.equal(
    normalizeEnvironmentCatalog([]).length,
    DEFAULT_ENVIRONMENTS.length,
  );
  assert.equal(
    normalizeEnvironmentCatalog("not array").length,
    DEFAULT_ENVIRONMENTS.length,
  );
  const deduped = normalizeEnvironmentCatalog([
    { id: "a", label: "A" },
    { id: "a", label: "A dup" },
    { id: "b", label: "B" },
  ]);
  assert.equal(deduped.length, 2);
  assert.equal(deduped[0].label, "A", "first occurrence wins");
}

/* ------------------------------------------------------------------ *
 * Built-in merge/migration — preserve custom collisions and order
 * ------------------------------------------------------------------ */
{
  const source = [
    { id: "campaign-first", label: "Campaign First", dc: 14 },
    { id: "limited", label: "Limited (legacy save)", dc: 15 },
    { id: "sparse", label: "Sparse custom override", dc: 19 },
    {
      id: "BIOME-FOREST",
      label: "Old Custom Forest",
      dc: 18,
      yieldFood: "1d4",
      yieldWater: "1d4",
    },
  ];
  const before = structuredClone(source);
  const merged = mergeBuiltInEnvironments(source, {
    legacyBuiltInIds: new Set(["limited", "biome-forest"]),
  });

  assert.deepEqual(source, before, "merge does not mutate saved configuration");
  assert.deepEqual(
    merged.slice(0, source.length).map((entry) => entry.id),
    source.map((entry) => entry.id),
    "saved order stays ahead of appended presets",
  );
  assert.equal(findEnvironment(merged, "limited").builtIn, true);
  assert.equal(
    findEnvironment(merged, "sparse").builtIn,
    false,
    "an unclaimed legacy id is not inferred as built-in",
  );
  assert.equal(
    findEnvironment(merged, "BIOME-FOREST").builtIn,
    false,
    "a biome id collision remains custom even when requested as legacy",
  );
  assert.equal(
    findEnvironment(merged, "BIOME-FOREST").label,
    "Old Custom Forest",
    "a shipped preset never replaces a custom collision",
  );
  assert.equal(
    merged.filter((entry) => entry.id.toLowerCase() === "biome-forest").length,
    1,
    "case-insensitive collisions are not appended",
  );

  const existingIds = new Set(source.map((entry) => entry.id.toLowerCase()));
  assert.deepEqual(
    merged.slice(source.length).map((entry) => entry.id),
    DEFAULT_ENVIRONMENTS.filter(
      (entry) => !existingIds.has(entry.id.toLowerCase()),
    ).map((entry) => entry.id),
    "missing built-ins append in shipped order",
  );
  assert.ok(
    merged.slice(source.length).every((entry) => entry.builtIn === true),
  );
}

/* ------------------------------------------------------------------ *
 * findEnvironment / isForageable
 * ------------------------------------------------------------------ */
{
  const catalog = getDefaultEnvironments();
  assert.equal(findEnvironment(catalog, "limited").dc, 15);
  assert.equal(findEnvironment(catalog, "nope"), null);
  assert.equal(findEnvironment(catalog, ""), null);
  assert.equal(isForageable(findEnvironment(catalog, "abundant")), true);
  assert.equal(isForageable(findEnvironment(catalog, "settlement")), false);
  assert.equal(isForageable(null), false);
}

/* ------------------------------------------------------------------ *
 * Bounded yield-formula validation
 * ------------------------------------------------------------------ */
{
  for (const [input, expected] of [
    ["0", "0"],
    ["2", "2"],
    ["2d6+1", "2d6+1"],
    [" d8 - 2 ", "1d8-2"],
    ["2D10 + 1d4 - 3", "2d10+1d4-3"],
    ["+01D006", "1d6"],
  ]) {
    assert.deepEqual(validateYieldFormula(input), {
      ok: true,
      value: expected,
      error: null,
    });
  }

  for (const input of [
    "",
    "drop tables;",
    "1d",
    "0d6",
    "1d0",
    "1d6*2",
    "1d6++1",
    "-1d6",
    `${YIELD_FORMULA_LIMITS.maxDicePerTerm + 1}d6`,
    `1d${YIELD_FORMULA_LIMITS.maxSides + 1}`,
    `${YIELD_FORMULA_LIMITS.maxConstant + 1}`,
  ]) {
    const result = validateYieldFormula(input);
    assert.equal(
      result.ok,
      false,
      `${JSON.stringify(input)} should be rejected`,
    );
    assert.equal(result.value, null);
    assert.ok(result.error, "unsafe formulas return an explicit error");
  }

  const tooManyDice = Array.from(
    { length: Math.ceil(YIELD_FORMULA_LIMITS.maxTotalDice / 10) + 1 },
    () => "10d6",
  ).join("+");
  assert.equal(validateYieldFormula(tooManyDice).ok, false);

  const tooManyTerms = Array.from(
    { length: YIELD_FORMULA_LIMITS.maxTerms + 1 },
    () => "1",
  ).join("+");
  assert.equal(validateYieldFormula(tooManyTerms).ok, false);

  const tooLong = "1+".repeat(YIELD_FORMULA_LIMITS.maxLength) + "1";
  assert.equal(validateYieldFormula(tooLong).ok, false);

  // Storage normalization remains backwards-compatible. The explicit editor
  // validator is the boundary that rejects an expensive legacy-shaped value.
  assert.equal(
    normalizeEnvironment({ id: "legacy", yieldFood: "999d9999" }).yieldFood,
    "999d9999",
  );
  assert.equal(validateYieldFormula("999d9999").ok, false);
}

/* ------------------------------------------------------------------ *
 * Built-in/custom identity and collision-free custom IDs
 * ------------------------------------------------------------------ */
{
  assert.equal(isCustomEnvironment("limited"), false);
  assert.equal(
    isCustomEnvironment(
      findEnvironment(getDefaultEnvironments(), "underground"),
    ),
    false,
  );
  assert.equal(
    isCustomEnvironment({ id: "limited", builtIn: false }),
    true,
    "explicit custom provenance wins a legacy id collision",
  );
  assert.equal(
    isCustomEnvironment({ id: "biome-forest" }),
    true,
    "an unmarked old biome collision remains editable",
  );
  assert.equal(isCustomEnvironment("storm-coast"), true);
  assert.equal(isCustomEnvironment({ id: "legacy-region" }), true);
  assert.equal(isCustomEnvironment(""), false);
  assert.equal(isCustomEnvironment(null), false);

  const catalog = [
    ...getDefaultEnvironments(),
    { id: "storm-coast", label: "Storm Coast" },
    { id: "storm-coast-2", label: "Storm Coast 2" },
    { id: "CUSTOM-ENVIRONMENT", label: "Legacy custom" },
  ];
  assert.equal(
    createUniqueEnvironmentId(catalog, "  Storm Coast!  "),
    "storm-coast-3",
  );
  assert.equal(createUniqueEnvironmentId(catalog, ""), "custom-environment-2");
  assert.equal(createUniqueEnvironmentId([], "Île de Brume"), "ile-de-brume");

  const longId = createUniqueEnvironmentId([], "x".repeat(200));
  assert.equal(longId.length, ENVIRONMENT_ID_MAX_LENGTH);
  const longCollision = createUniqueEnvironmentId(
    [{ id: longId }],
    "x".repeat(200),
  );
  assert.ok(longCollision.endsWith("-2"));
  assert.equal(longCollision.length, ENVIRONMENT_ID_MAX_LENGTH);
}

/* ------------------------------------------------------------------ *
 * Complete draft validation
 * ------------------------------------------------------------------ */
{
  const catalog = getDefaultEnvironments();
  const valid = validateEnvironmentDraft(
    {
      id: "storm-coast",
      label: "  Storm Coast  ",
      dc: "18",
      forageable: true,
      yieldFood: " 2D4 + 1 ",
      yieldWater: "d6",
    },
    { catalog },
  );
  assert.equal(valid.ok, true);
  assert.deepEqual(valid.errors, {});
  assert.deepEqual(valid.value, {
    id: "storm-coast",
    label: "Storm Coast",
    dc: 18,
    foodDc: 18,
    waterDc: 18,
    forageable: true,
    yieldFood: "2d4+1",
    yieldWater: "1d6",
    builtIn: false,
  });

  const splitDc = validateEnvironmentDraft(
    {
      id: "salt-marsh",
      label: "Salt Marsh",
      foodDc: "15",
      waterDc: "20",
      forageable: true,
      yieldFood: "1d4",
      yieldWater: "1d4",
      builtIn: true,
    },
    { catalog },
  );
  assert.deepEqual(splitDc.value, {
    id: "salt-marsh",
    label: "Salt Marsh",
    dc: 20,
    foodDc: 15,
    waterDc: 20,
    forageable: true,
    yieldFood: "1d4",
    yieldWater: "1d4",
    builtIn: false,
  });

  const invalidSplitDc = validateEnvironmentDraft(
    {
      id: "bad-dcs",
      label: "Bad DCs",
      foodDc: ENVIRONMENT_DC_MAX + 1,
      waterDc: "not-a-number",
      forageable: true,
      yieldFood: "1d6",
      yieldWater: "1d6",
    },
    { catalog },
  );
  assert.ok(invalidSplitDc.errors.foodDc);
  assert.ok(invalidSplitDc.errors.waterDc);

  const invalid = validateEnvironmentDraft(
    {
      id: "limited",
      label: " ",
      dc: ENVIRONMENT_DC_MAX + 1,
      forageable: "yes",
      yieldFood: "1000d1000",
      yieldWater: "Roll(1d6)",
    },
    { catalog },
  );
  assert.equal(invalid.ok, false);
  assert.equal(invalid.value, null);
  for (const field of [
    "id",
    "label",
    "dc",
    "forageable",
    "yieldFood",
    "yieldWater",
  ]) {
    assert.ok(invalid.errors[field], `${field} has an explicit error`);
  }

  const blankId = validateEnvironmentDraft(
    {
      id: "",
      label: "Blank",
      dc: 10,
      forageable: true,
      yieldFood: "1d6",
      yieldWater: "1d6",
    },
    { catalog },
  );
  assert.match(blankId.errors.id, /enter/i);

  const existing = validateEnvironmentDraft(
    { ...catalog[0], label: "Renamed Abundant" },
    { catalog, originalId: "abundant" },
  );
  assert.equal(existing.ok, true, "the original id is not its own duplicate");
}

/* ------------------------------------------------------------------ *
 * Immutable duplication and validated field updates
 * ------------------------------------------------------------------ */
{
  const catalog = getDefaultEnvironments();
  const before = structuredClone(catalog);
  const copied = duplicateEnvironment(catalog, "limited");
  assert.equal(copied.ok, true);
  assert.deepEqual(copied.errors, {});
  assert.equal(copied.catalog.length, catalog.length + 1);
  assert.equal(copied.environment.id, "limited-copy");
  assert.equal(copied.environment.label, `${catalog[1].label} Copy`);
  assert.equal(copied.environment.foodDc, 15);
  assert.equal(copied.environment.waterDc, 15);
  assert.equal(copied.environment.builtIn, false);
  assert.equal(isCustomEnvironment(copied.environment), true);
  assert.deepEqual(catalog, before, "duplication does not mutate its input");
  assert.notEqual(copied.environment, catalog[1]);

  const copiedAgain = duplicateEnvironment(copied.catalog, "limited");
  assert.equal(copiedAgain.environment.id, "limited-copy-2");

  const builtInUpdate = updateEnvironmentFields(catalog, "limited", {
    label: "Changed preset",
  });
  assert.equal(builtInUpdate.ok, false);
  assert.match(builtInUpdate.errors.environmentId, /copy a built-in/i);
  assert.deepEqual(builtInUpdate.catalog, catalog);

  const preExistingCustom = [
    ...catalog,
    {
      id: "legacy-region",
      label: "Legacy Region",
      dc: 12,
      forageable: true,
      yieldFood: "1d4",
      yieldWater: "1d4",
    },
  ];
  const legacyUpdate = updateEnvironmentFields(
    preExistingCustom,
    "legacy-region",
    { label: "Recovered Region" },
  );
  assert.equal(legacyUpdate.ok, true);
  assert.equal(legacyUpdate.environment.label, "Recovered Region");
  assert.equal(legacyUpdate.environment.foodDc, 12);
  assert.equal(legacyUpdate.environment.waterDc, 12);
  assert.equal(legacyUpdate.environment.builtIn, false);

  const missing = duplicateEnvironment(catalog, "missing");
  assert.equal(missing.ok, false);
  assert.match(missing.errors.sourceId, /choose/i);
  assert.deepEqual(missing.catalog, catalog);

  const unsafeCatalog = [
    {
      id: "legacy",
      label: "Legacy",
      dc: 15,
      forageable: true,
      yieldFood: "999d9999",
      yieldWater: "1d6",
    },
  ];
  const unsafeCopy = duplicateEnvironment(unsafeCatalog, "legacy");
  assert.equal(unsafeCopy.ok, false);
  assert.ok(unsafeCopy.errors.yieldFood);
  assert.deepEqual(unsafeCopy.catalog, unsafeCatalog);

  const updateInput = copied.catalog;
  const updateBefore = structuredClone(updateInput);
  const updated = updateEnvironmentFields(updateInput, "limited-copy", {
    label: "  Storm Coast  ",
    dc: "19",
    forageable: true,
    yieldFood: "2D6 + 1",
    yieldWater: "d8",
  });
  assert.equal(updated.ok, true);
  assert.deepEqual(updated.environment, {
    id: "limited-copy",
    label: "Storm Coast",
    dc: 19,
    foodDc: 19,
    waterDc: 19,
    forageable: true,
    yieldFood: "2d6+1",
    yieldWater: "1d8",
    builtIn: false,
  });
  assert.deepEqual(
    updateInput,
    updateBefore,
    "updates do not mutate their input",
  );
  assert.notEqual(updated.catalog, updateInput);

  const splitUpdated = updateEnvironmentFields(
    updated.catalog,
    "limited-copy",
    { foodDc: "12", waterDc: "18" },
  );
  assert.equal(splitUpdated.ok, true);
  assert.equal(splitUpdated.environment.foodDc, 12);
  assert.equal(splitUpdated.environment.waterDc, 18);
  assert.equal(
    splitUpdated.environment.dc,
    18,
    "the compatibility DC follows the harder channel",
  );

  const invalidUpdate = updateEnvironmentFields(updateInput, "limited-copy", {
    yieldFood: "1d6*100",
  });
  assert.equal(invalidUpdate.ok, false);
  assert.ok(invalidUpdate.errors.yieldFood);
  assert.deepEqual(invalidUpdate.catalog, updateInput);

  const idUpdate = updateEnvironmentFields(updateInput, "limited-copy", {
    id: "renamed-id",
  });
  assert.equal(idUpdate.ok, false);
  assert.match(idUpdate.errors.id, /cannot be changed/i);

  const missingUpdate = updateEnvironmentFields(updateInput, "missing", {
    label: "Nope",
  });
  assert.equal(missingUpdate.ok, false);
  assert.ok(missingUpdate.errors.environmentId);
}

process.stdout.write("resource-environment validation passed\n");
