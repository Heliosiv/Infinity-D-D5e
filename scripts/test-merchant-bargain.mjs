import assert from "node:assert/strict";

import {
  computeBargainOutcome,
  loadBargainTiers,
  rollSkillCompat,
} from "./merchant/bargain.js";

/* ------------------------------------------------------------------ *
 * computeBargainOutcome — default tiers
 *
 * Default schedule:
 *   crit-success → margin ≥ 10 → −20%
 *   success      → margin ≥ 0  → −10%
 *   failure      → margin ≥ -9 → +10%
 *   crit-failure → margin < -9 → +20%
 * ------------------------------------------------------------------ */
{
  const dc = 15;
  // Roll 25 → margin 10 → crit-success
  const crit = computeBargainOutcome(25, dc);
  assert.equal(crit.tier?.id, "crit-success");
  assert.equal(crit.deltaPct, -20);
  assert.equal(crit.margin, 10);
}
{
  // Roll exactly 15 → margin 0 → success
  const success = computeBargainOutcome(15, 15);
  assert.equal(success.tier?.id, "success");
  assert.equal(success.deltaPct, -10);
}
{
  // Roll 14 → margin -1 → failure
  const failure = computeBargainOutcome(14, 15);
  assert.equal(failure.tier?.id, "failure");
  assert.equal(failure.deltaPct, 10);
}
{
  // Roll 5 → margin -10 → crit-failure
  const critFail = computeBargainOutcome(5, 15);
  assert.equal(critFail.tier?.id, "crit-failure");
  assert.equal(critFail.deltaPct, 20);
}

/* ------------------------------------------------------------------ *
 * Custom tiers — narrow bands
 * ------------------------------------------------------------------ */
{
  const tiers = [
    { id: "amazing", minMargin: 20, deltaPct: -50 },
    { id: "ok", minMargin: 0, deltaPct: -5 },
    { id: "bad", minMargin: -Infinity, deltaPct: 25 },
  ];
  assert.equal(computeBargainOutcome(35, 15, tiers).tier.id, "amazing");
  assert.equal(computeBargainOutcome(15, 15, tiers).tier.id, "ok");
  assert.equal(computeBargainOutcome(1, 15, tiers).tier.id, "bad");
  assert.equal(computeBargainOutcome(1, 15, tiers).deltaPct, 25);
}

/* ------------------------------------------------------------------ *
 * Malformed input — falls back to defaults gracefully
 * ------------------------------------------------------------------ */
{
  const outcome = computeBargainOutcome(15, 15, "not an array");
  assert.equal(outcome.tier?.id, "success");
}

/* ------------------------------------------------------------------ *
 * loadBargainTiers — returns defaults when game.settings is absent
 * ------------------------------------------------------------------ */
{
  const originalGame = globalThis.game;
  try {
    delete globalThis.game;
    const tiers = loadBargainTiers();
    assert.ok(Array.isArray(tiers));
    assert.ok(tiers.length >= 4);
    assert.equal(tiers.find((t) => t.id === "crit-success")?.deltaPct, -20);
  } finally {
    if (originalGame === undefined) delete globalThis.game;
    else globalThis.game = originalGame;
  }
}

/* ------------------------------------------------------------------ *
 * loadBargainTiers — honors a sane setting
 * ------------------------------------------------------------------ */
{
  const originalGame = globalThis.game;
  try {
    globalThis.game = {
      settings: {
        get(moduleId, key) {
          if (key === "merchantBargainTiers") {
            return [
              { id: "score", minMargin: 5, deltaPct: -15 },
              { id: "miss", minMargin: -Infinity, deltaPct: 5 },
            ];
          }
          return undefined;
        },
      },
    };
    const tiers = loadBargainTiers();
    assert.equal(tiers.length, 2);
    assert.equal(tiers[0].id, "score");
  } finally {
    if (originalGame === undefined) delete globalThis.game;
    else globalThis.game = originalGame;
  }
}

/* ------------------------------------------------------------------ *
 * rollSkillCompat — dnd5e argument-shape compatibility
 *
 * dnd5e v4+/v5 removed the legacy (skillId, options) signature; the skill must
 * ride in a config object as `config.skill`. Passing a bare string on v5 rolls
 * with NO skill modifier (a silently broken haggle/forage roll). These tests
 * pin the per-version call shape so that regression can't return.
 * ------------------------------------------------------------------ */
function makeRollActor(returnValue) {
  const calls = [];
  return {
    calls,
    async rollSkill(...args) {
      calls.push(args);
      return returnValue;
    },
  };
}

// dnd5e v5: config object first, message.create controls the chat card.
{
  const originalGame = globalThis.game;
  try {
    globalThis.game = { system: { version: "5.3.3" } };
    const fakeRoll = { total: 18 };
    const actor = makeRollActor([fakeRoll]); // v4+ may return an Array<Roll>
    const result = await rollSkillCompat(actor, "per", {
      advantage: true,
      chatMessage: false,
    });
    assert.equal(
      result,
      fakeRoll,
      "array return is unwrapped to the first roll",
    );
    const [config, , message] = actor.calls[0];
    assert.equal(
      typeof config,
      "object",
      "v5 must pass a config object, not a bare skill string",
    );
    assert.equal(
      config.skill,
      "per",
      "skill rides in config.skill on dnd5e v5",
    );
    assert.equal(config.advantage, true, "advantage forwarded into the config");
    assert.deepEqual(
      message,
      { create: false },
      "chatMessage:false maps to message.create:false on v5",
    );
  } finally {
    if (originalGame === undefined) delete globalThis.game;
    else globalThis.game = originalGame;
  }
}

// dnd5e v3: legacy (skillId, options) signature, single Roll returned as-is.
{
  const originalGame = globalThis.game;
  try {
    globalThis.game = { system: { version: "3.3.1" } };
    const fakeRoll = { total: 12 };
    const actor = makeRollActor(fakeRoll);
    const result = await rollSkillCompat(actor, "per", {
      advantage: false,
      chatMessage: true,
    });
    assert.equal(result, fakeRoll, "a single roll is returned unchanged");
    const [skillId, options] = actor.calls[0];
    assert.equal(skillId, "per", "v3 passes the skill id as a string");
    assert.equal(options.chatMessage, true, "v3 options carry chatMessage");
  } finally {
    if (originalGame === undefined) delete globalThis.game;
    else globalThis.game = originalGame;
  }
}

process.stdout.write("merchant-bargain validation passed\n");
