import assert from "node:assert/strict";

import {
  DEFAULT_ENVIRONMENTS,
  getDefaultEnvironments,
  normalizeEnvironment,
  normalizeEnvironmentCatalog,
  findEnvironment,
  isForageable,
} from "./resource/environment.js";

/* ------------------------------------------------------------------ *
 * Default catalog — DMG-aligned DCs
 * ------------------------------------------------------------------ */
{
  const byId = Object.fromEntries(DEFAULT_ENVIRONMENTS.map((e) => [e.id, e]));
  assert.equal(byId.abundant.dc, 10);
  assert.equal(byId.limited.dc, 15);
  assert.equal(byId.sparse.dc, 20);
  assert.equal(byId.abundant.forageable, true);
  assert.equal(byId.settlement.forageable, false);
  assert.equal(byId.underground.forageable, false);

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
  assert.equal(env.forageable, true);
  assert.equal(env.yieldFood, "1d6");

  // forageable:false zeroes yields by default.
  const town = normalizeEnvironment({ id: "town", forageable: false });
  assert.equal(town.forageable, false);
  assert.equal(town.yieldFood, "0");
  assert.equal(town.dc, 0);

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
  assert.equal(normalizeEnvironmentCatalog([]).length, DEFAULT_ENVIRONMENTS.length);
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

process.stdout.write("resource-environment validation passed\n");
