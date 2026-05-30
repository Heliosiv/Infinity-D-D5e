const MONKS_TOKENBAR_ID = "monks-tokenbar";
const PATCH_MARKER = "__infinityDnd5ePlayerActorPatch";

export async function registerMonksTokenbarCompat() {
  if (!globalThis.game?.modules?.get?.(MONKS_TOKENBAR_ID)?.active) return;

  let module;
  try {
    module = await import("/modules/monks-tokenbar/apps/savingthrow.js");
  } catch (error) {
    console.warn(
      "infinity-dnd5e | failed to load Monk's TokenBar request-roll compat",
      error,
    );
    return;
  }

  const SavingThrowApp = module?.SavingThrowApp;
  if (!SavingThrowApp || SavingThrowApp[PATCH_MARKER]) return;

  const originalPrepareBodyContext =
    SavingThrowApp.prototype._prepareBodyContext;
  const originalDoRequestRoll = SavingThrowApp.prototype.doRequestRoll;
  const originalAddPlayers = SavingThrowApp.addPlayers;

  SavingThrowApp.prototype._prepareBodyContext = function (context, options) {
    ensurePlayerActorEntries(this);
    return originalPrepareBodyContext.call(this, context, options);
  };

  SavingThrowApp.prototype.doRequestRoll = function (event, roll) {
    ensurePlayerActorEntries(this);
    return originalDoRequestRoll.call(this, event, roll);
  };

  const patchedAddPlayers = function (...args) {
    const entries = buildPlayerActorEntries();
    if (entries.length > 0) {
      this.entries = entries;
      this.render(true);
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

  Object.defineProperty(SavingThrowApp, PATCH_MARKER, {
    value: true,
    configurable: false,
  });
}

function ensurePlayerActorEntries(app) {
  if (!app || (Array.isArray(app.entries) && app.entries.length > 0)) return;
  const entries = buildPlayerActorEntries();
  if (entries.length > 0) app.entries = entries;
}

function buildPlayerActorEntries() {
  const targets = collectPlayerRequestTargets();
  const monksApi = globalThis.game?.MonksTokenBar;
  const tokenTargets = targets.filter((target) => !isActorDocument(target));
  const actorTargets = targets.filter(isActorDocument);
  const tokenEntries =
    tokenTargets.length > 0 && monksApi?.getTokenEntries
      ? monksApi.getTokenEntries(tokenTargets)
      : [];

  return [
    ...tokenEntries,
    ...actorTargets.map((actor) => createActorRequestEntry(actor)),
  ];
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

function isDefaultPlayerToken(token) {
  const include = normalizeIncludeFlag(getTokenIncludeFlag(token));
  return (
    token?.actor &&
    ((token.actor.hasPlayerOwner &&
      token.document?.disposition === 1 &&
      include !== "exclude") ||
      include === "include")
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
  if (!actor || actor.type !== "character") return false;
  if (actor.hasPlayerOwner) return true;
  if (
    Object.entries(actor.ownership ?? {}).some(
      ([userId, level]) =>
        userId !== "default" &&
        Number(level) >= ownerLevel &&
        gameRef?.users?.get?.(userId)?.isGM === false,
    )
  ) {
    return true;
  }
  return Array.from(gameRef?.users ?? []).some(
    (user) => !user?.isGM && user?.character?.id === actor.id,
  );
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

function isActorDocument(target) {
  const ActorClass = globalThis.Actor;
  if (ActorClass && target instanceof ActorClass) return true;
  return (
    target?.documentName === "Actor" || target?.constructor?.name === "Actor"
  );
}
