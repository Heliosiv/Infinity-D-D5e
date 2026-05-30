import assert from "node:assert/strict";

import { collectPlayerRequestTargets } from "./compat/monks-tokenbar.js";

function makeUsers(entries) {
  const users = [...entries];
  users.get = (id) => users.find((user) => user.id === id);
  return users;
}

function makeToken(actor, overrides = {}) {
  return {
    actor,
    document: {
      disposition: overrides.disposition ?? 1,
      getFlag: () => overrides.include,
    },
    id: overrides.id ?? `token-${actor.id}`,
    name: overrides.name ?? actor.name,
  };
}

{
  const actors = [
    { id: "b", name: "Beta", type: "character", hasPlayerOwner: true },
    {
      id: "a",
      name: "Alpha",
      type: "character",
      hasPlayerOwner: false,
      ownership: { u1: 3 },
    },
    { id: "npc", name: "Bandit", type: "npc", hasPlayerOwner: true },
  ];
  const targets = collectPlayerRequestTargets({
    gameRef: {
      actors,
      users: makeUsers([{ id: "u1", isGM: false }]),
    },
    canvasRef: { tokens: { placeables: [] } },
    ownerLevel: 3,
  });

  assert.deepEqual(
    targets.map((target) => target.id),
    ["a", "b"],
    "player-owned character actors fill the request list when no scene tokens are available",
  );
}

{
  const alpha = {
    id: "a",
    name: "Alpha",
    type: "character",
    hasPlayerOwner: true,
  };
  const beta = {
    id: "b",
    name: "Beta",
    type: "character",
    hasPlayerOwner: true,
  };
  const betaToken = makeToken(beta);
  const targets = collectPlayerRequestTargets({
    gameRef: {
      actors: [alpha, beta],
      users: makeUsers([]),
    },
    canvasRef: { tokens: { placeables: [betaToken] } },
    ownerLevel: 3,
  });

  assert.equal(targets[0], betaToken, "eligible scene tokens stay first");
  assert.deepEqual(
    targets.map((target) => target.id),
    ["token-b", "a"],
    "actors already represented by an eligible scene token are not duplicated",
  );
}

{
  const alpha = {
    id: "a",
    name: "Alpha",
    type: "character",
    hasPlayerOwner: true,
  };
  const excludedToken = makeToken(alpha, { include: "exclude" });
  const targets = collectPlayerRequestTargets({
    gameRef: {
      actors: [alpha],
      users: makeUsers([]),
    },
    canvasRef: { tokens: { placeables: [excludedToken] } },
    ownerLevel: 3,
  });

  assert.equal(
    targets.length,
    0,
    "an explicit Monk's TokenBar exclude flag suppresses actor fallback",
  );
}
