import assert from "node:assert/strict";

import { normalizeResourceConfig } from "./resource/store.js";
import {
  discoverPlayerCharacters,
  discoverPartyActors,
  getPartyRoster,
} from "./resource/calendar-watcher.js";

/** Build a fake game world. `raw` is the un-normalized resourceConfig. */
function mockGame(actors, raw = {}) {
  return {
    actors,
    settings: {
      get(moduleId, key) {
        if (moduleId !== "infinity-dnd5e") return undefined;
        if (key === "resourceConfig") return raw;
        return undefined;
      },
    },
  };
}

const pc = (id, name) => ({
  id,
  name,
  type: "character",
  hasPlayerOwner: true,
});
const A = pc("A", "Aria");
const B = pc("B", "Brom");
const C = pc("C", "Cael");
const NPC = { id: "N", name: "Goblin", type: "npc", hasPlayerOwner: true };
const UNOWNED = {
  id: "U",
  name: "Wanderer",
  type: "character",
  hasPlayerOwner: false,
};

const savedGame = globalThis.game;

try {
  /* discoverPlayerCharacters — only player-owned characters */
  {
    globalThis.game = mockGame([A, B, C, NPC, UNOWNED]);
    assert.deepEqual(
      discoverPlayerCharacters().map((a) => a.id),
      ["A", "B", "C"],
      "NPCs and unowned characters are excluded",
    );
  }

  /* Empty roster → auto-tracks every PC, each drawing from self */
  {
    globalThis.game = mockGame([A, B, C], {});
    const roster = getPartyRoster(normalizeResourceConfig({}));
    assert.deepEqual(
      roster.map((r) => r.actor.id),
      ["A", "B", "C"],
    );
    assert.ok(
      roster.every((r) => r.drawFromId === r.actor.id && r.isStash === false),
      "auto roster draws from self, no stashes",
    );
    // discoverPartyActors (no arg) goes through loadResourceConfig → same set.
    assert.deepEqual(
      discoverPartyActors().map((a) => a.id),
      ["A", "B", "C"],
    );
  }

  /* Explicit roster — stash + draws-from resolution, missing actor dropped */
  {
    globalThis.game = mockGame([A, B, C]);
    const cfg = normalizeResourceConfig({
      roster: [
        { actorId: "A", isStash: true },
        { actorId: "B", drawFrom: "A" }, // draws from stash A
        { actorId: "C", drawFrom: "ghost" }, // not a stash → self
        { actorId: "Z", drawFrom: "self" }, // no live actor → dropped
      ],
    });
    const roster = getPartyRoster(cfg);
    assert.deepEqual(
      roster.map((r) => r.actor.id),
      ["A", "B", "C"],
      "Z (no live actor) dropped; order preserved",
    );
    const byId = Object.fromEntries(roster.map((r) => [r.actor.id, r]));
    assert.equal(byId.A.isStash, true);
    assert.equal(byId.A.drawFromId, "A", "a stash draws from itself");
    assert.equal(
      byId.B.drawFromId,
      "A",
      "member draws from the nominated stash",
    );
    assert.equal(byId.C.drawFromId, "C", "unknown target falls back to self");
    assert.deepEqual(
      discoverPartyActors().map((a) => a.id),
      ["A", "B", "C"],
    );
  }

  /* Draw source gone at runtime → member falls back to self */
  {
    globalThis.game = mockGame([B]); // A deleted since the roster was saved
    const cfg = normalizeResourceConfig({
      roster: [
        { actorId: "A", isStash: true },
        { actorId: "B", drawFrom: "A" },
      ],
    });
    const roster = getPartyRoster(cfg);
    assert.deepEqual(
      roster.map((r) => r.actor.id),
      ["B"],
      "missing stash dropped",
    );
    assert.equal(
      roster[0].drawFromId,
      "B",
      "draw source gone → falls back to self",
    );
  }

  /* Single party stash: the whole party draws food/water from one actor,
     overriding per-member draws; the stash actor is marked a stash. */
  {
    globalThis.game = mockGame([A, B, C]);
    const cfg = normalizeResourceConfig({
      roster: [
        { actorId: "A" },
        { actorId: "B", isStash: true }, // a per-member stash...
        { actorId: "C", drawFrom: "B" }, // ...C points at it
      ],
      partyStashId: "A", // ...but the party stash overrides everyone to A
    });
    const roster = getPartyRoster(cfg);
    const byId = Object.fromEntries(roster.map((r) => [r.actor.id, r]));
    assert.equal(byId.A.drawFromId, "A", "stash draws from itself");
    assert.equal(byId.A.isStash, true, "party stash is marked a stash");
    assert.equal(
      byId.B.drawFromId,
      "A",
      "everyone overridden to the party stash",
    );
    assert.equal(
      byId.C.drawFromId,
      "A",
      "overrides a per-member nomination too",
    );
  }

  /* Party stash works with an auto-discovered (uncurated) roster too. */
  {
    globalThis.game = mockGame([A, B, C]);
    const cfg = normalizeResourceConfig({ partyStashId: "B" });
    const roster = getPartyRoster(cfg);
    assert.ok(
      roster.every((r) => r.drawFromId === "B"),
      "auto roster honors the party stash",
    );
  }

  /* A stale party stash (actor not tracked) is ignored — per-member draws stand. */
  {
    globalThis.game = mockGame([A, B]);
    const cfg = normalizeResourceConfig({ partyStashId: "ghost" });
    const roster = getPartyRoster(cfg);
    assert.ok(
      roster.every((r) => r.drawFromId === r.actor.id),
      "unknown party stash falls back to per-member self",
    );
  }

  /* No game world → empty, no throw */
  {
    delete globalThis.game;
    assert.deepEqual(getPartyRoster(normalizeResourceConfig({})), []);
    assert.deepEqual(discoverPartyActors(), []);
  }
} finally {
  if (savedGame === undefined) delete globalThis.game;
  else globalThis.game = savedGame;
}

process.stdout.write("resource-roster validation passed\n");
