const MONKS_TOKENBAR_ID = "monks-tokenbar";
const PATCH_MARKER = "__infinityDnd5ePlayerActorPatchV2";

let tokenEntryBuilder = null;

export async function registerMonksTokenbarCompat({
  importModule = (path) => import(path),
} = {}) {
  if (!globalThis.game?.modules?.get?.(MONKS_TOKENBAR_ID)?.active) return;

  let module;
  try {
    module = await importModule("/modules/monks-tokenbar/apps/savingthrow.js");
  } catch (error) {
    console.warn(
      "infinity-dnd5e | failed to load Monk's TokenBar request-roll compat",
      error,
    );
    return;
  }

  const SavingThrowApp = module?.SavingThrowApp;
  if (!SavingThrowApp || SavingThrowApp[PATCH_MARKER]) return;

  try {
    const tokenbarModule = await importModule(
      "/modules/monks-tokenbar/monks-tokenbar.js",
    );
    tokenEntryBuilder = tokenbarModule?.MonksTokenBar?.getTokenEntries ?? null;
  } catch {
    tokenEntryBuilder = globalThis.game?.MonksTokenBar?.getTokenEntries ?? null;
  }

  const originalPrepareBodyContext =
    SavingThrowApp.prototype._prepareBodyContext;
  const originalDoRequestRoll = SavingThrowApp.prototype.doRequestRoll;
  const originalGetData = SavingThrowApp.prototype.getData;
  const originalRequestRoll = SavingThrowApp.prototype.requestRoll;
  const originalChangeTokens = SavingThrowApp.prototype.changeTokens;

  if (typeof originalPrepareBodyContext === "function") {
    SavingThrowApp.prototype._prepareBodyContext = function (context, options) {
      ensurePlayerActorEntries(this);
      return originalPrepareBodyContext.call(this, context, options);
    };
  }

  if (typeof originalDoRequestRoll === "function") {
    SavingThrowApp.prototype.doRequestRoll = function (event, roll) {
      ensurePlayerActorEntries(this);
      return originalDoRequestRoll.call(this, event, roll);
    };
  }

  if (typeof originalGetData === "function") {
    SavingThrowApp.prototype.getData = function (options) {
      ensurePlayerActorEntries(this);
      return originalGetData.call(this, options);
    };
  }

  if (typeof originalRequestRoll === "function") {
    SavingThrowApp.prototype.requestRoll = function (...args) {
      ensurePlayerActorEntries(this);
      return originalRequestRoll.apply(this, args);
    };
  }

  if (typeof originalChangeTokens === "function") {
    SavingThrowApp.prototype.changeTokens = function (event) {
      const type = event?.target?.dataset?.type;
      if (type === "player") {
        const applied = ensurePlayerActorEntries(this, { force: true });
        if (applied) {
          this.render?.(true);
          globalThis.window?.setTimeout?.(() => {
            this.setPosition?.({ height: "auto" });
          }, 100);
          return undefined;
        }
      }
      if (type === "tokenbar") {
        const applied = appendTokenbarEntries(this);
        if (applied) {
          this.render?.(true);
          globalThis.window?.setTimeout?.(() => {
            this.setPosition?.({ height: "auto" });
          }, 100);
          return undefined;
        }
      }
      return originalChangeTokens.call(this, event);
    };
  }

  const originalAddPlayers = SavingThrowApp.addPlayers;
  if (typeof originalAddPlayers === "function") {
    const patchedAddPlayers = function (...args) {
      const applied = ensurePlayerActorEntries(this, { force: true });
      if (applied) {
        this.render?.(true);
        globalThis.window?.setTimeout?.(() => {
          this.setPosition?.({ height: "auto" });
        }, 100);
        return undefined;
      }
      return originalAddPlayers.apply(this, args);
    };

    SavingThrowApp.addPlayers = patchedAddPlayers;
    if (SavingThrowApp.DEFAULT_OPTIONS?.actions?.addPlayers) {
      SavingThrowApp.DEFAULT_OPTIONS.actions.addPlayers = patchedAddPlayers;
    }
  }

  Object.defineProperty(SavingThrowApp, PATCH_MARKER, {
    value: true,
    configurable: false,
  });
}

function ensurePlayerActorEntries(app, { force = false } = {}) {
  if (!app) return false;
  const entries = buildPlayerActorEntries();
  if (entries.length === 0) return false;
  if (
    force ||
    !Array.isArray(app.entries) ||
    app.entries.length === 0 ||
    isDefaultScenePlayerEntryList(app.entries)
  ) {
    app.entries = entries;
    return true;
  }
  return false;
}

function buildPlayerActorEntries() {
  const targets = collectPlayerRequestTargets();
  return buildRequestEntries(targets);
}

function buildRequestEntries(targets) {
  const tokenTargets = targets.filter((target) => !isActorDocument(target));
  const actorTargets = targets.filter(isActorDocument);
  const tokenEntries = getTokenEntries(tokenTargets);

  return [
    ...tokenEntries,
    ...actorTargets.map((actor) => createActorRequestEntry(actor)),
  ];
}

function appendTokenbarEntries(app) {
  const entries = buildTokenbarEntries();
  if (entries.length === 0) return false;

  const existingEntries = Array.isArray(app.entries) ? app.entries : [];
  const existingActorIds = new Set(
    existingEntries.map((entry) => getEntryActorId(entry)).filter(Boolean),
  );
  const nextEntries = [...existingEntries];

  for (const entry of entries) {
    const actorId = getEntryActorId(entry);
    if (actorId && existingActorIds.has(actorId)) continue;
    nextEntries.push(entry);
    if (actorId) existingActorIds.add(actorId);
  }

  if (nextEntries.length === existingEntries.length) return false;
  app.entries = nextEntries;
  return true;
}

function buildTokenbarEntries() {
  const targets = collectTokenbarRequestTargets();
  return buildRequestEntries(targets);
}

function getTokenEntries(tokens) {
  if (tokens.length === 0) return [];
  if (typeof tokenEntryBuilder === "function") {
    return tokenEntryBuilder(tokens);
  }
  return tokens.map((token) => createTokenRequestEntry(token));
}

export function collectPlayerRequestTargets({
  gameRef = globalThis.game,
  canvasRef = globalThis.canvas,
  ownerLevel = globalThis.CONST?.DOCUMENT_OWNERSHIP_LEVELS?.OWNER ?? 3,
} = {}) {
  const tokens = Array.from(canvasRef?.tokens?.placeables ?? []);
  const includedTokens = uniqueByActor(
    tokens.filter((token) => isDefaultPlayerToken(token)),
  );
  const includedActorIds = new Set(
    includedTokens.map((token) => token?.actor?.id).filter(Boolean),
  );
  const excludedActorIds = new Set(
    tokens
      .filter(
        (token) =>
          normalizeIncludeFlag(getTokenIncludeFlag(token)) === "exclude",
      )
      .map((token) => token?.actor?.id)
      .filter(Boolean),
  );

  const actorFallbacks = getActorCollection(gameRef)
    .filter((actor) => isPlayerOwnedCharacter(actor, gameRef, ownerLevel))
    .filter((actor) => !includedActorIds.has(actor.id))
    .filter((actor) => !excludedActorIds.has(actor.id))
    .sort((a, b) => String(a.name ?? "").localeCompare(String(b.name ?? "")));

  return [...includedTokens, ...actorFallbacks];
}

function collectTokenbarRequestTargets({
  gameRef = globalThis.game,
  ownerLevel = globalThis.CONST?.DOCUMENT_OWNERSHIP_LEVELS?.OWNER ?? 3,
} = {}) {
  const tokenbarEntries = getMonksTokenbarEntries(gameRef);
  return uniqueTargetsByActor(
    tokenbarEntries
      .map((entry) => resolveTokenbarTarget(entry, gameRef, ownerLevel))
      .filter(Boolean),
  );
}

function getMonksTokenbarEntries(gameRef) {
  const tokenbar =
    gameRef?.MonksTokenBar?.TokenBar?.() ??
    gameRef?.MonksTokenBar?.tokenbar ??
    globalThis.MonksTokenBar?.tokenbar;
  return Array.from(tokenbar?.entries ?? []);
}

function resolveTokenbarTarget(entry, gameRef, ownerLevel) {
  const tokenObject = entry?.token?._object;
  if (isDisplayableToken(tokenObject)) return tokenObject;

  const actor = entry?.actor ?? entry?.token?.actor ?? tokenObject?.actor;
  if (isPlayerOwnedCharacter(actor, gameRef, ownerLevel)) return actor;

  return null;
}

function uniqueByActor(tokens) {
  const seen = new Set();
  const result = [];
  for (const token of tokens) {
    const actorId = token?.actor?.id;
    if (!actorId || seen.has(actorId)) continue;
    seen.add(actorId);
    result.push(token);
  }
  return result;
}

function uniqueTargetsByActor(targets) {
  const seen = new Set();
  const result = [];
  for (const target of targets) {
    const actorId = isActorDocument(target) ? target.id : target?.actor?.id;
    if (!actorId || seen.has(actorId)) continue;
    seen.add(actorId);
    result.push(target);
  }
  return result;
}

function isDefaultScenePlayerEntryList(entries) {
  if (Array.from(globalThis.canvas?.tokens?.controlled ?? []).length > 0) {
    return false;
  }
  const monkDefaultActorIds = uniqueByActor(
    Array.from(globalThis.canvas?.tokens?.placeables ?? []).filter((token) =>
      isMonksDefaultPlayerToken(token),
    ),
  ).map((token) => token?.actor?.id);
  if (
    monkDefaultActorIds.length === 0 ||
    monkDefaultActorIds.length !== entries.length
  ) {
    return false;
  }
  const currentActorIds = entries.map((entry) => getEntryActorId(entry));
  return currentActorIds.every(
    (actorId) => actorId && monkDefaultActorIds.includes(actorId),
  );
}

function getEntryActorId(entry) {
  if (entry?.token?.actor?.id) return entry.token.actor.id;
  if (isActorDocument(entry?.token)) return entry.token.id;
  if (entry?.actor?.id) return entry.actor.id;
  return null;
}

function isDefaultPlayerToken(token) {
  return isMonksDefaultPlayerToken(token) && isDisplayableToken(token);
}

function isMonksDefaultPlayerToken(token) {
  const include = normalizeIncludeFlag(getTokenIncludeFlag(token));
  return (
    token?.actor &&
    ((token.actor.hasPlayerOwner &&
      token.document?.disposition === 1 &&
      include !== "exclude") ||
      include === "include")
  );
}

function isDisplayableToken(token) {
  return (
    token?.actor &&
    isRequestableCharacterActor(token.actor) &&
    hasDisplayName(token.name)
  );
}

function getTokenIncludeFlag(token) {
  return token?.document?.getFlag?.(MONKS_TOKENBAR_ID, "include");
}

function normalizeIncludeFlag(include) {
  if (include === true) return "include";
  if (include === false) return "exclude";
  return include || "default";
}

function getActorCollection(gameRef) {
  const actors = gameRef?.actors;
  if (Array.isArray(actors)) return actors;
  if (Array.isArray(actors?.contents)) return actors.contents;
  if (typeof actors?.filter === "function") return actors.filter(() => true);
  return [];
}

function isPlayerOwnedCharacter(actor, gameRef, ownerLevel) {
  if (!isRequestableCharacterActor(actor)) return false;

  const users = getUserCollection(gameRef);
  if (
    users.some(
      (user) => !user?.isGM && getUserCharacterId(user) === actor.id,
    )
  ) {
    return true;
  }

  if (
    Object.entries(actor.ownership ?? {}).some(
      ([userId, level]) =>
        userId !== "default" &&
        Number(level) >= ownerLevel &&
        isNonGmUserId(userId, users, gameRef),
    )
  ) {
    return true;
  }

  return users.length === 0 && actor.hasPlayerOwner === true;
}

function isRequestableCharacterActor(actor) {
  return (
    actor?.type === "character" &&
    hasDisplayName(actor.name) &&
    hasDisplayName(actor.id)
  );
}

function hasDisplayName(value) {
  return String(value ?? "").trim().length > 0;
}

function getUserCollection(gameRef) {
  const users = gameRef?.users;
  if (Array.isArray(users)) return users;
  if (Array.isArray(users?.contents)) return users.contents;
  if (typeof users?.filter === "function") return users.filter(() => true);
  return Array.from(users ?? []);
}

function getUserCharacterId(user) {
  if (typeof user?.character === "string") return user.character;
  return user?.character?.id ?? null;
}

function isNonGmUserId(userId, users, gameRef) {
  const user =
    users.find((candidate) => candidate?.id === userId) ??
    gameRef?.users?.get?.(userId);
  return user?.isGM === false;
}

function createActorRequestEntry(actor) {
  const token = {
    actor,
    document: {
      hidden: false,
      texture: { src: actor.img },
      uuid: actor.uuid,
    },
    id: actor.id,
    img: actor.img,
    name: actor.name,
    uuid: actor.uuid,
  };
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

function createTokenRequestEntry(token) {
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

function isActorDocument(target) {
  const ActorClass = globalThis.Actor;
  if (ActorClass && target instanceof ActorClass) return true;
  return (
    target?.documentName === "Actor" ||
    target?.constructor?.name === "Actor" ||
    (target?.type === "character" && !target?.actor)
  );
}
