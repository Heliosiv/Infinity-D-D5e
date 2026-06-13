import assert from "node:assert/strict";

import {
  RESOURCE_CONFIG_VERSION,
  DRAW_FROM_SELF,
  normalizeResource,
  normalizeResourceConfig,
  normalizeRoster,
  resolveDrawSourceId,
  normalizeRunState,
  createDefaultResourceConfig,
  loadResourceConfig,
  loadRunState,
} from "./resource/store.js";

/* ------------------------------------------------------------------ *
 * normalizeResource — defaults + drop malformed
 * ------------------------------------------------------------------ */
{
  assert.equal(normalizeResource(null), null);
  assert.equal(normalizeResource({}), null, "no id → dropped");

  const r = normalizeResource({ id: "food", scope: "bogus", perDay: -3 });
  assert.equal(r.id, "food");
  assert.equal(r.scope, "per-character", "bad scope → per-character");
  assert.equal(r.perDay, 0, "negative perDay clamps to 0");
  assert.deepEqual(r.matching, {
    nameKeywords: [],
    flagTag: "",
    itemUuids: [],
  });
  assert.equal(r.forageYields, null);

  const party = normalizeResource({
    id: "light",
    scope: "party",
    perDay: 2,
    forageYields: "food",
    matching: {
      nameKeywords: ["torch"],
      flagTag: "light",
      itemUuids: ["x", "x"],
    },
  });
  assert.equal(party.scope, "party");
  assert.equal(party.forageYields, "food");
  assert.deepEqual(party.matching.itemUuids, ["x"], "dedupes uuids");
}

/* ------------------------------------------------------------------ *
 * normalizeResourceConfig — fills defaults, idempotent
 * ------------------------------------------------------------------ */
{
  const cfg = normalizeResourceConfig({});
  assert.equal(cfg.version, RESOURCE_CONFIG_VERSION);
  assert.equal(cfg.forageMode, "each");
  assert.equal(cfg.halfRations, false);
  assert.equal(cfg.waterEnabled, true);
  assert.equal(cfg.maxCatchUpDays, 7);
  assert.ok(cfg.resources.length >= 3, "seeds food/water/light");
  assert.ok(cfg.environments.length >= 3, "seeds environments");

  // Idempotent.
  const again = normalizeResourceConfig(cfg);
  assert.deepEqual(again, cfg);

  // Bad values corrected.
  const fixed = normalizeResourceConfig({
    forageMode: "nonsense",
    maxCatchUpDays: 0,
    resources: [{ junk: true }], // all malformed → fall back to defaults
  });
  assert.equal(fixed.forageMode, "each");
  assert.equal(fixed.maxCatchUpDays, 1, "min clamp 1");
  assert.ok(fixed.resources.length >= 3, "all-malformed list → defaults");

  // waterEnabled:false respected.
  assert.equal(
    normalizeResourceConfig({ waterEnabled: false }).waterEnabled,
    false,
  );
}

/* ------------------------------------------------------------------ *
 * normalizeRoster — dedupe, drop malformed, validate drawFrom
 * ------------------------------------------------------------------ */
{
  assert.deepEqual(normalizeRoster(undefined), [], "no roster → empty");
  assert.deepEqual(
    normalizeRoster([null, {}, { actorId: "" }]),
    [],
    "malformed dropped",
  );

  const roster = normalizeRoster([
    { actorId: "a", isStash: true },
    { actorId: "a", isStash: false }, // duplicate id → dropped
    { actorId: "b", drawFrom: "a" }, // draws from stash a → kept
    { actorId: "c", drawFrom: "ghost" }, // unknown target → self
    { actorId: "d", drawFrom: "d" }, // self-reference → self
  ]);
  assert.deepEqual(
    roster.map((e) => e.actorId),
    ["a", "b", "c", "d"],
    "deduped, order preserved",
  );
  assert.equal(roster[0].isStash, true);
  assert.equal(
    roster[0].drawFrom,
    DRAW_FROM_SELF,
    "a stash always draws from self",
  );
  assert.equal(roster[1].drawFrom, "a", "member draws from a real stash");
  assert.equal(
    roster[2].drawFrom,
    DRAW_FROM_SELF,
    "unknown target falls back to self",
  );
  assert.equal(
    roster[3].drawFrom,
    DRAW_FROM_SELF,
    "self-reference falls back to self",
  );

  // A member can't draw from a non-stash member.
  const nonStash = normalizeRoster([
    { actorId: "x", isStash: false },
    { actorId: "y", drawFrom: "x" },
  ]);
  assert.equal(
    nonStash[1].drawFrom,
    DRAW_FROM_SELF,
    "can't draw from a non-stash",
  );

  // resolveDrawSourceId
  assert.equal(resolveDrawSourceId({ actorId: "b", drawFrom: "a" }), "a");
  assert.equal(
    resolveDrawSourceId({ actorId: "b", drawFrom: DRAW_FROM_SELF }),
    "b",
  );
  assert.equal(
    resolveDrawSourceId({ actorId: "b" }),
    "b",
    "missing drawFrom → self",
  );
  assert.equal(resolveDrawSourceId(null), null);

  // Config carries a normalized roster and stays idempotent with it.
  const cfg = normalizeResourceConfig({
    roster: [
      { actorId: "a", isStash: true },
      { actorId: "b", drawFrom: "a" },
    ],
  });
  assert.equal(cfg.roster.length, 2);
  assert.deepEqual(
    normalizeResourceConfig(cfg).roster,
    cfg.roster,
    "roster idempotent",
  );
  assert.deepEqual(
    normalizeResourceConfig({}).roster,
    [],
    "default roster empty",
  );
}

/* ------------------------------------------------------------------ *
 * createDefaultResourceConfig
 * ------------------------------------------------------------------ */
{
  const cfg = createDefaultResourceConfig();
  const ids = cfg.resources.map((r) => r.id);
  assert.ok(ids.includes("food"));
  assert.ok(ids.includes("water"));
  assert.ok(ids.includes("light"));
  // Water keyword guard: no bare "water" that would snag Holy Water.
  const water = cfg.resources.find((r) => r.id === "water");
  assert.ok(!water.matching.nameKeywords.includes("water"));
}

/* ------------------------------------------------------------------ *
 * normalizeRunState
 * ------------------------------------------------------------------ */
{
  const fresh = normalizeRunState({});
  assert.equal(fresh.lastSeenDay, null);
  assert.equal(fresh.currentEnvironmentId, null);
  assert.equal(fresh.lastUpkeepResult, null);

  const live = normalizeRunState({
    lastSeenDay: 12.9,
    currentEnvironmentId: " limited ",
    lastUpkeepResult: { day: 12 },
  });
  assert.equal(live.lastSeenDay, 12, "floored");
  assert.equal(live.currentEnvironmentId, "limited", "trimmed");
  assert.deepEqual(live.lastUpkeepResult, { day: 12 });

  assert.equal(normalizeRunState({ lastSeenDay: "x" }).lastSeenDay, null);
}

/* ------------------------------------------------------------------ *
 * load* — degrade gracefully when game.settings is absent
 * ------------------------------------------------------------------ */
{
  const originalGame = globalThis.game;
  try {
    delete globalThis.game;
    const cfg = loadResourceConfig();
    assert.ok(cfg.resources.length >= 3, "no game → normalized defaults");
    const state = loadRunState();
    assert.equal(state.lastSeenDay, null);
  } finally {
    if (originalGame === undefined) delete globalThis.game;
    else globalThis.game = originalGame;
  }
}

/* ------------------------------------------------------------------ *
 * loadResourceConfig — honors a mocked game.settings.get
 * ------------------------------------------------------------------ */
{
  const originalGame = globalThis.game;
  try {
    globalThis.game = {
      settings: {
        get(moduleId, key) {
          if (moduleId !== "infinity-dnd5e") return undefined;
          if (key === "resourceConfig")
            return { forageMode: "best", waterEnabled: false };
          return undefined;
        },
      },
    };
    const cfg = loadResourceConfig();
    assert.equal(cfg.forageMode, "best");
    assert.equal(cfg.waterEnabled, false);
    assert.ok(cfg.resources.length >= 3, "still seeds resources");
  } finally {
    if (originalGame === undefined) delete globalThis.game;
    else globalThis.game = originalGame;
  }
}

process.stdout.write("resource-store validation passed\n");
