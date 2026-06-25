import assert from "node:assert/strict";

import {
  HISTORY_CAP,
  PER_CHARACTER_CAP,
  STANDING_MAX,
  STANDING_MIN,
  clampStanding,
  generateId,
  getDefaultFactions,
  normalizeFaction,
  normalizeHistoryEntry,
  normalizePerCharacter,
  standingBand,
  standingCssClass,
  standingTier,
} from "./reputation/standing.js";
import {
  addPerCharacter,
  applyStandingChange,
  createBlankFaction,
  listRevealedForPlayers,
  loadFactions,
  removePerCharacter,
  sanitizeFactionForPlayers,
  updatePerCharacter,
} from "./reputation/store.js";
import { prettyStanding } from "./ui-util.js";

/* ------------------------------------------------------------------ *
 * Scale: clamp / tier / band
 * ------------------------------------------------------------------ */
{
  assert.equal(STANDING_MIN, -5);
  assert.equal(STANDING_MAX, 5);

  assert.equal(clampStanding(-10), -5, "clamps below floor");
  assert.equal(clampStanding(10), 5, "clamps above ceiling");
  assert.equal(clampStanding(2.4), 2, "rounds to integer");
  assert.equal(clampStanding("3"), 3, "coerces string");
  assert.equal(clampStanding("nope"), 0, "non-numeric → 0");
  assert.equal(clampStanding(undefined), 0, "undefined → 0");

  assert.equal(standingTier(-5), "Nemesis");
  assert.equal(standingTier(0), "Neutral");
  assert.equal(standingTier(2), "Friendly");
  assert.equal(standingTier(5), "Exalted");
  assert.equal(standingTier(99), "Exalted", "out-of-range clamps first");

  const bands = {
    "-5": "hostile",
    "-3": "hostile",
    "-2": "cold",
    "-1": "cold",
    0: "neutral",
    1: "warm",
    2: "warm",
    3: "allied",
    5: "allied",
  };
  for (const [score, band] of Object.entries(bands)) {
    assert.equal(standingBand(Number(score)), band, `band for ${score}`);
    assert.equal(
      standingCssClass(Number(score)),
      band,
      `cssClass mirrors band for ${score}`,
    );
  }
}

/* ------------------------------------------------------------------ *
 * Normalization
 * ------------------------------------------------------------------ */
{
  const f = normalizeFaction({});
  assert.ok(f.id, "id assigned");
  assert.equal(f.name, "New Faction");
  assert.equal(f.category, "");
  assert.equal(f.standing, 0);
  assert.equal(f.revealed, false);
  assert.deepEqual(f.history, []);
  assert.deepEqual(f.perCharacter, []);

  const clamped = normalizeFaction({ standing: 42, revealed: "yes" });
  assert.equal(clamped.standing, 5, "standing clamps");
  assert.equal(clamped.revealed, false, "revealed only true on strict true");
  assert.equal(normalizeFaction({ revealed: true }).revealed, true);

  // History + per-character caps.
  const bigHistory = Array.from({ length: HISTORY_CAP + 20 }, (_, i) => ({
    id: `h${i}`,
    at: i,
    delta: 1,
    fromStanding: 0,
    toStanding: 1,
  }));
  const bigPc = Array.from({ length: PER_CHARACTER_CAP + 5 }, (_, i) => ({
    id: `pc${i}`,
    actorId: `a${i}`,
  }));
  const capped = normalizeFaction({ history: bigHistory, perCharacter: bigPc });
  assert.equal(capped.history.length, HISTORY_CAP, "history capped");
  assert.equal(
    capped.perCharacter.length,
    PER_CHARACTER_CAP,
    "per-character capped",
  );

  assert.equal(normalizeHistoryEntry(null), null, "non-object history → null");
  assert.equal(normalizePerCharacter(7), null, "non-object pc → null");
  assert.equal(
    normalizePerCharacter({ delta: 99 }).delta,
    5,
    "pc delta clamps",
  );

  assert.deepEqual(getDefaultFactions(), [], "default list is empty");

  const blank = createBlankFaction();
  assert.ok(blank.id);
  assert.equal(blank.name, "New Faction");
  assert.equal(blank.standing, 0);

  assert.ok(generateId().length > 3, "generateId returns a string");
}

/* ------------------------------------------------------------------ *
 * applyStandingChange — history + clamping (pure, no game)
 * ------------------------------------------------------------------ */
{
  const base = normalizeFaction({ id: "f1", name: "Guild", standing: 0 });

  // Raise by 1 logs an entry and doesn't mutate the input.
  const up = applyStandingChange(base, { delta: 1, by: "GM" });
  assert.equal(up.standing, 1);
  assert.equal(up.history.length, 1);
  assert.equal(up.history[0].delta, 1);
  assert.equal(up.history[0].fromStanding, 0);
  assert.equal(up.history[0].toStanding, 1);
  assert.equal(up.history[0].by, "GM");
  assert.equal(base.standing, 0, "input not mutated");
  assert.equal(base.history.length, 0, "input history not mutated");

  // Absolute set logs the real swing.
  const set = applyStandingChange(base, { toStanding: -3, reason: "betrayal" });
  assert.equal(set.standing, -3);
  assert.equal(set.history[0].delta, -3);
  assert.equal(set.history[0].reason, "betrayal");

  // Newest-first ordering.
  const twice = applyStandingChange(up, { delta: -1, reason: "slight" });
  assert.equal(twice.standing, 0);
  assert.equal(twice.history.length, 2);
  assert.equal(twice.history[0].reason, "slight", "newest entry first");

  // No-op: raising at the ceiling with no reason changes nothing.
  const maxed = normalizeFaction({ standing: 5 });
  const noop = applyStandingChange(maxed, { delta: 1 });
  assert.equal(noop.standing, 5);
  assert.equal(noop.history.length, 0, "clamped no-reason change is a no-op");

  // But a reason at the ceiling logs a delta-0 note.
  const cappedNote = applyStandingChange(maxed, {
    delta: 1,
    reason: "tried to impress them",
  });
  assert.equal(cappedNote.standing, 5);
  assert.equal(cappedNote.history.length, 1);
  assert.equal(cappedNote.history[0].delta, 0, "clamped change logs delta 0");

  // Plain note (delta 0 + reason) is kept; delta 0 + no reason is dropped.
  const note = applyStandingChange(base, { delta: 0, reason: "rumor heard" });
  assert.equal(note.history.length, 1);
  assert.equal(note.standing, 0);
  assert.equal(
    applyStandingChange(base, { delta: 0 }).history.length,
    0,
    "empty no-op dropped",
  );

  // History cap holds under repeated logging.
  let churn = normalizeFaction({ standing: 0 });
  for (let i = 0; i < HISTORY_CAP + 30; i += 1) {
    churn = applyStandingChange(churn, {
      delta: i % 2 === 0 ? 1 : -1,
      reason: `change ${i}`,
    });
  }
  assert.equal(churn.history.length, HISTORY_CAP, "logging respects the cap");
}

/* ------------------------------------------------------------------ *
 * Per-character helpers (pure)
 * ------------------------------------------------------------------ */
{
  let f = normalizeFaction({ id: "f2", name: "House" });
  f = addPerCharacter(f, { actorId: "a1", delta: 2, note: "patron" });
  assert.equal(f.perCharacter.length, 1);
  const rowId = f.perCharacter[0].id;
  assert.equal(f.perCharacter[0].actorId, "a1");

  f = updatePerCharacter(f, rowId, { note: "rival", delta: -1 });
  assert.equal(f.perCharacter[0].note, "rival");
  assert.equal(f.perCharacter[0].delta, -1);
  assert.equal(f.perCharacter[0].id, rowId, "id preserved on update");

  f = removePerCharacter(f, rowId);
  assert.equal(f.perCharacter.length, 0);

  // Cap holds when adding beyond the limit.
  let many = normalizeFaction({ id: "f3" });
  for (let i = 0; i < PER_CHARACTER_CAP + 4; i += 1) {
    many = addPerCharacter(many, { actorId: `a${i}` });
  }
  assert.equal(many.perCharacter.length, PER_CHARACTER_CAP);
}

/* ------------------------------------------------------------------ *
 * Player projection — privacy guard
 * ------------------------------------------------------------------ */
{
  const full = normalizeFaction({
    id: "f4",
    name: "The Veil",
    category: "Guild",
    img: "icons/svg/eye.svg",
    standing: 2,
    revealed: true,
    gmNotes: "secret leverage",
    description: "GM-only background",
    playerNote: "they like you",
    history: [{ id: "h", at: 1, delta: 1, fromStanding: 1, toStanding: 2 }],
    perCharacter: [{ id: "pc", actorId: "a1", delta: 1, note: "spy" }],
  });
  const safe = sanitizeFactionForPlayers(full);

  assert.deepEqual(
    Object.keys(safe).sort(),
    [
      "band",
      "category",
      "id",
      "img",
      "name",
      "playerNote",
      "standing",
      "tier",
    ].sort(),
    "projection exposes exactly the safe fields",
  );
  assert.equal(safe.tier, "Friendly");
  assert.equal(safe.band, "warm");
  assert.equal(safe.playerNote, "they like you");
  for (const leaked of [
    "gmNotes",
    "description",
    "history",
    "perCharacter",
    "revealed",
  ]) {
    assert.ok(!(leaked in safe), `projection must not leak ${leaked}`);
  }

  // Without a live game, the Foundry-backed reads degrade to empty.
  assert.deepEqual(loadFactions(), [], "loadFactions degrades to []");
  assert.deepEqual(
    listRevealedForPlayers(),
    [],
    "revealed list degrades to []",
  );
}

/* ------------------------------------------------------------------ *
 * prettyStanding label (ui-util)
 * ------------------------------------------------------------------ */
{
  assert.equal(prettyStanding(2), "+2 — Friendly");
  assert.equal(prettyStanding(0), "0 — Neutral");
  assert.equal(prettyStanding(-3), "−3 — Hostile");
  assert.equal(prettyStanding(99), "+5 — Exalted", "clamps high input");
}

process.stdout.write("reputation store + standing validation passed\n");
