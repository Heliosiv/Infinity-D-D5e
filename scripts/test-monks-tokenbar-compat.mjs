import assert from "node:assert/strict";

import {
  collectPlayerRequestTargets,
  registerMonksTokenbarCompat,
} from "./compat/monks-tokenbar.js";

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

function makeTokenEntry(token) {
  const entry = {
    fastForward: undefined,
    keys: {},
    request: undefined,
    token,
  };
  Object.defineProperty(entry, "id", {
    get() {
      return this.token.id;
    },
  });
  return entry;
}

function installFoundryGlobals({ actors, users, tokens, controlled = [] }) {
  globalThis.CONST = { DOCUMENT_OWNERSHIP_LEVELS: { OWNER: 3 } };
  globalThis.game = {
    actors,
    modules: {
      get: (id) => (id === "monks-tokenbar" ? { active: true } : undefined),
    },
    users,
  };
  globalThis.canvas = {
    tokens: {
      controlled,
      placeables: tokens,
    },
  };
  globalThis.window = {
    setTimeout: (callback) => callback(),
  };
}

async function registerTestCompat(SavingThrowApp) {
  await registerMonksTokenbarCompat({
    importModule: async (path) => {
      if (path.endsWith("/apps/savingthrow.js")) return { SavingThrowApp };
      if (path.endsWith("/monks-tokenbar.js")) {
        return {
          MonksTokenBar: {
            getTokenEntries: (tokens) => tokens.map(makeTokenEntry),
          },
        };
      }
      throw new Error(`Unexpected import ${path}`);
    },
  });
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

{
  class SavingThrowApp {
    constructor(entries = []) {
      this.entries = entries;
    }

    getData() {
      return { entries: this.entries };
    }
  }

  const actors = [
    {
      id: "a",
      img: "alpha.webp",
      name: "Alpha",
      type: "character",
      hasPlayerOwner: true,
      uuid: "Actor.a",
    },
  ];
  installFoundryGlobals({
    actors,
    users: makeUsers([]),
    tokens: [],
  });
  await registerTestCompat(SavingThrowApp);

  const app = new SavingThrowApp([]);
  app.getData();

  assert.deepEqual(
    app.entries.map((entry) => entry.id),
    ["a"],
    "V12 getData fills an empty request dialog from player-owned actors",
  );
}

{
  class SavingThrowApp {
    constructor(entries = []) {
      this.entries = entries;
    }

    getData() {
      return { entries: this.entries };
    }
  }

  const alpha = {
    id: "a",
    img: "alpha.webp",
    name: "Alpha",
    type: "character",
    hasPlayerOwner: true,
    uuid: "Actor.a",
  };
  const beta = {
    id: "b",
    img: "beta.webp",
    name: "Beta",
    type: "character",
    hasPlayerOwner: true,
    uuid: "Actor.b",
  };
  const betaToken = makeToken(beta);
  installFoundryGlobals({
    actors: [alpha, beta],
    users: makeUsers([]),
    tokens: [betaToken],
  });
  await registerTestCompat(SavingThrowApp);

  const app = new SavingThrowApp([makeTokenEntry(betaToken)]);
  app.getData();

  assert.deepEqual(
    app.entries.map((entry) => entry.id),
    ["token-b", "a"],
    "V12 getData extends Monk's default scene-player list with actor fallbacks",
  );
}

{
  class SavingThrowApp {
    constructor(entries = []) {
      this.entries = entries;
    }

    getData() {
      return { entries: this.entries };
    }
  }

  const alpha = {
    id: "a",
    img: "alpha.webp",
    name: "Alpha",
    type: "character",
    hasPlayerOwner: true,
    uuid: "Actor.a",
  };
  const beta = {
    id: "b",
    img: "beta.webp",
    name: "Beta",
    type: "character",
    hasPlayerOwner: true,
    uuid: "Actor.b",
  };
  const betaToken = makeToken(beta);
  installFoundryGlobals({
    actors: [alpha, beta],
    users: makeUsers([]),
    tokens: [betaToken],
    controlled: [betaToken],
  });
  await registerTestCompat(SavingThrowApp);

  const app = new SavingThrowApp([makeTokenEntry(betaToken)]);
  app.getData();

  assert.deepEqual(
    app.entries.map((entry) => entry.id),
    ["token-b"],
    "V12 getData leaves explicit selected-token requests scoped",
  );
}

{
  class SavingThrowApp {
    constructor(entries = []) {
      this.entries = entries;
      this.rendered = false;
      this.position = null;
    }

    changeTokens() {
      throw new Error("original player handler should be bypassed");
    }

    render() {
      this.rendered = true;
    }

    setPosition(position) {
      this.position = position;
    }
  }

  const actors = [
    {
      id: "a",
      img: "alpha.webp",
      name: "Alpha",
      type: "character",
      hasPlayerOwner: true,
      uuid: "Actor.a",
    },
  ];
  installFoundryGlobals({
    actors,
    users: makeUsers([]),
    tokens: [],
  });
  await registerTestCompat(SavingThrowApp);

  const app = new SavingThrowApp([]);
  app.changeTokens({ target: { dataset: { type: "player" } } });

  assert.deepEqual(
    app.entries.map((entry) => entry.id),
    ["a"],
    "the V12 Players button uses actor fallback entries",
  );
  assert.equal(app.rendered, true);
  assert.deepEqual(app.position, { height: "auto" });
}
