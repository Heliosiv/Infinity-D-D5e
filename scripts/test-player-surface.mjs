import assert from "node:assert/strict";

import {
  emitPlayerSurfaceOpen,
  getPlayerSurfaceAvailability,
  getPlayerSurfaceStatus,
  openCalendar,
  openPlayerSurface,
  PLAYER_SURFACE_EVENT,
  PLAYER_SURFACE_LABELS,
  PLAYER_SURFACES,
  receivePlayerSurfacePayload,
  registerPlayerSurfaceSocket,
  SUPPORTED_MATT_VERSION,
  validatePlayerSurfacePayload,
} from "./player-surface.js";
import {
  buildPlayerSurfaceAction,
  PLAYER_SURFACE_ACTION_ID,
  registerMonksActiveTilesCompat,
  setupMonksActiveTilesActions,
} from "./compat/monks-active-tiles.js";

const savedGlobals = Object.fromEntries(
  [
    "CONST",
    "fromUuidSync",
    "game",
    "Hooks",
    "SimpleCalendar",
    "socketlib",
    "ui",
  ].map((key) => [key, globalThis[key]]),
);
const originalWarn = console.warn;

const gm = { id: "gm-1", active: true, isGM: true, role: 4 };
const secondGm = { id: "gm-2", active: true, isGM: true, role: 4 };
const player = { id: "player-1", active: true, isGM: false, role: 1 };
const otherPlayer = {
  id: "player-2",
  active: true,
  isGM: false,
  role: 1,
};

function makeUsers(entries, activeGM = gm) {
  const users = new Map(entries.map((user) => [user.id, user]));
  users.activeGM = activeGM;
  return users;
}

function installGame({
  currentUser = gm,
  calendarApi = null,
  criticalInjuriesEnabled = true,
  infinityApi = null,
  legacyCalendarActive = false,
  mattActive = true,
  mattVersion = SUPPORTED_MATT_VERSION,
  rebornCalendarActive = true,
  resourcePlayerView = true,
  scenes = new Map(),
  socket = null,
  socketlibActive = true,
} = {}) {
  const users = makeUsers([gm, secondGm, player, otherPlayer]);
  const infinity = { active: true, api: infinityApi };
  const matt = { active: mattActive, version: mattVersion };
  const socketlibModule = { active: socketlibActive };
  const legacyCalendar = {
    active: legacyCalendarActive,
    api: calendarApi,
  };
  const rebornCalendar = {
    active: rebornCalendarActive,
    api: calendarApi,
  };
  globalThis.CONST = { USER_ROLES: { GAMEMASTER: 4 } };
  globalThis.game = {
    user: currentUser,
    users,
    scenes,
    modules: {
      get(id) {
        if (id === "infinity-dnd5e") return infinity;
        if (id === "monks-active-tiles") return matt;
        if (id === "socketlib") return socketlibModule;
        if (id === "foundryvtt-simple-calendar-reborn") {
          return rebornCalendar;
        }
        if (id === "foundryvtt-simple-calendar") return legacyCalendar;
        return undefined;
      },
    },
    settings: {
      get(moduleId, key) {
        if (moduleId !== "infinity-dnd5e") return undefined;
        if (key === "criticalInjuriesEnabled") {
          return criticalInjuriesEnabled;
        }
        if (key === "resourcePlayerView") return resourcePlayerView;
        return undefined;
      },
    },
    socket,
  };
  return {
    infinity,
    legacyCalendar,
    matt,
    rebornCalendar,
    socketlibModule,
    users,
  };
}

const HUB_CONTROL_KEYS = Object.freeze([
  "continue-adventure",
  "character",
  "party",
  "party-stash",
  "player-guide",
  "party-supplies",
  "shops",
  "factions",
  "downtime",
  "calendar",
  "injuries",
]);
const HUB_LABELS = Object.freeze({
  home: "Infinity Home",
  "continue-adventure": "Continue Adventure",
  character: "Character",
  party: "Party",
  "party-stash": "Party Stash",
  "player-guide": "Player Guide",
  "party-supplies": "Party Supplies",
  shops: "Shops",
  factions: "Factions",
  downtime: "Downtime",
  calendar: "Calendar",
  injuries: "Injuries",
});

function makeHubAction(key) {
  const infinitySurfaces = {
    home: PLAYER_SURFACES.HOME,
    "party-supplies": PLAYER_SURFACES.PARTY_SUPPLIES,
    shops: PLAYER_SURFACES.SHOPS,
    factions: PLAYER_SURFACES.REPUTATION,
    downtime: PLAYER_SURFACES.DOWNTIME,
    calendar: PLAYER_SURFACES.CALENDAR,
    injuries: PLAYER_SURFACES.CRITICAL_INJURIES,
  };
  if (infinitySurfaces[key]) {
    return {
      id: `hub-${key}`,
      action: PLAYER_SURFACE_ACTION_ID,
      data: { surface: infinitySurfaces[key] },
    };
  }
  if (key === "continue-adventure") {
    return {
      id: `hub-${key}`,
      action: "scene",
      data: {
        sceneid: { id: "Scene.destination" },
        activate: false,
        for: "trigger",
      },
    };
  }
  if (key === "character") {
    return {
      id: `hub-${key}`,
      action: "openactor",
      data: { entity: { id: "players" }, showto: "trigger" },
    };
  }
  if (key === "party" || key === "party-stash") {
    return {
      id: `hub-${key}`,
      action: "openactor",
      data: { entity: { id: "Actor.party" }, showto: "trigger" },
    };
  }
  return {
    id: `hub-${key}`,
    action: "openjournal",
    data: {
      entity: { id: "JournalEntry.guide" },
      showto: "trigger",
      permission: "true",
    },
  };
}

function makeHubScene() {
  const scene = {
    id: "hub-scene",
    flags: {
      "drakemore-foundry": {
        playerHub: {
          version: 1,
          kind: "interactive-player-hub",
          width: 3840,
          height: 2160,
          controlKeys: [...HUB_CONTROL_KEYS],
        },
      },
    },
    tiles: new Map(),
  };
  for (const key of HUB_CONTROL_KEYS) {
    const id = `tile-${key}`;
    const tile = {
      id,
      uuid: `Scene.${scene.id}.Tile.${id}`,
      parent: scene,
      flags: {
        "drakemore-foundry": {
          playerHubControl: {
            version: 1,
            key,
            label: HUB_LABELS[key],
            interaction: { type: "bounded-hub-interaction" },
          },
        },
        "monks-active-tiles": {
          active: true,
          controlled: "all",
          allowpaused: true,
          trigger: ["click"],
          actions: [makeHubAction(key)],
        },
      },
    };
    scene.tiles.set(id, tile);
  }
  return scene;
}

function triggerPacket(tile, overrides = {}) {
  return {
    action: "trigger",
    senderId: otherPlayer.id,
    userId: otherPlayer.id,
    tileid: tile.uuid,
    tokens: [],
    method: "click",
    pt: { x: 10, y: 20 },
    options: {},
    ...overrides,
  };
}

function validPayload(surface = PLAYER_SURFACES.SHOPS) {
  return {
    type: PLAYER_SURFACE_EVENT,
    originUserId: gm.id,
    targetUserId: player.id,
    surface,
  };
}

try {
  console.warn = () => {};
  const notificationWarnings = [];
  globalThis.ui = {
    notifications: {
      error: (message) => notificationWarnings.push(message),
      warn: (message) => notificationWarnings.push(message),
    },
  };

  /* Fixed protocol enum and data-minimizing envelope. */
  for (const surface of Object.values(PLAYER_SURFACES)) {
    assert.deepEqual(validatePlayerSurfacePayload(validPayload(surface)), {
      ok: true,
      reason: null,
    });
  }
  assert.equal(
    validatePlayerSurfacePayload(validPayload("gm-dashboard")).reason,
    "invalid-surface",
  );
  assert.equal(
    validatePlayerSurfacePayload({
      ...validPayload(),
      projection: { hiddenFaction: "secret" },
    }).reason,
    "unexpected-payload-data",
    "campaign data has no player-surface socket path",
  );
  assert.equal(
    validatePlayerSurfacePayload({ ...validPayload(), targetUserId: "" })
      .reason,
    "invalid-target-user-id",
  );

  /* Every allowlisted surface opens only its existing local application. */
  const opened = [];
  const infinityApi = {
    openHub: () => opened.push(PLAYER_SURFACES.HOME),
    openPartySupplies: () => opened.push(PLAYER_SURFACES.PARTY_SUPPLIES),
    openShops: () => opened.push(PLAYER_SURFACES.SHOPS),
    openReputationView: () => opened.push(PLAYER_SURFACES.REPUTATION),
    openDowntimeActivities: () => opened.push(PLAYER_SURFACES.DOWNTIME),
    openCriticalInjuries: () => opened.push(PLAYER_SURFACES.CRITICAL_INJURIES),
  };
  const calendarApi = {
    showCalendar: () => opened.push(PLAYER_SURFACES.CALENDAR),
  };
  installGame({ currentUser: player, infinityApi, calendarApi });
  for (const surface of Object.values(PLAYER_SURFACES)) {
    assert.equal(
      await openPlayerSurface(surface, { infinityApi, calendarApi }),
      true,
      `${surface} should open`,
    );
  }
  assert.deepEqual(opened, Object.values(PLAYER_SURFACES));
  assert.equal(await openPlayerSurface("unknown", { infinityApi }), false);
  assert.deepEqual(
    getPlayerSurfaceAvailability(PLAYER_SURFACES.HOME, {
      moduleApi: infinityApi,
    }),
    { available: true, reason: "" },
    "Home uses the local role-aware API opener",
  );
  assert.equal(
    getPlayerSurfaceAvailability(PLAYER_SURFACES.HOME, { moduleApi: {} })
      .available,
    false,
  );
  assert.equal(PLAYER_SURFACE_LABELS[PLAYER_SURFACES.HOME], "Infinity Home");

  installGame({
    currentUser: player,
    criticalInjuriesEnabled: false,
    infinityApi,
    resourcePlayerView: false,
  });
  const suppliesAvailability = getPlayerSurfaceAvailability(
    PLAYER_SURFACES.PARTY_SUPPLIES,
    { gameRef: globalThis.game },
  );
  const injuriesAvailability = getPlayerSurfaceAvailability(
    PLAYER_SURFACES.CRITICAL_INJURIES,
    { gameRef: globalThis.game },
  );
  assert.deepEqual(suppliesAvailability, {
    available: false,
    reason: "Party Supplies is not available in this world.",
  });
  assert.deepEqual(injuriesAvailability, {
    available: false,
    reason: "Critical Injuries are not enabled in this world.",
  });
  assert.doesNotMatch(
    JSON.stringify({ suppliesAvailability, injuriesAvailability }),
    /gm-1|player-1|resourcePlayerView|criticalInjuriesEnabled/,
    "setting gates return only generic availability copy",
  );
  globalThis.game.user = gm;
  assert.equal(
    getPlayerSurfaceAvailability(PLAYER_SURFACES.PARTY_SUPPLIES, {
      gameRef: globalThis.game,
    }).available,
    true,
    "the player-view setting does not hide the full-GM preview",
  );

  installGame({
    currentUser: player,
    calendarApi: null,
    legacyCalendarActive: false,
    rebornCalendarActive: true,
  });
  globalThis.SimpleCalendar = {
    api: { showCalendar: () => opened.push("reborn") },
  };
  assert.equal(
    await openCalendar(),
    true,
    "active Simple Calendar Reborn uses the global SimpleCalendar API while legacy is inactive",
  );
  assert.equal(opened.at(-1), "reborn");

  installGame({
    currentUser: player,
    calendarApi: null,
    legacyCalendarActive: true,
    rebornCalendarActive: false,
  });
  globalThis.SimpleCalendar = {
    api: { showCalendar: () => opened.push("legacy") },
  };
  assert.equal(
    await openCalendar(),
    true,
    "an active legacy Calendar module remains a guarded fallback",
  );
  assert.equal(opened.at(-1), "legacy");

  installGame({
    currentUser: player,
    legacyCalendarActive: false,
    rebornCalendarActive: false,
  });
  globalThis.SimpleCalendar = {
    api: { showCalendar: () => assert.fail() },
  };
  assert.equal(
    await openCalendar({ calendarApi: { showCalendar: () => assert.fail() } }),
    false,
    "inactive Calendar modules fail closed even when an API object is passed",
  );
  installGame({
    currentUser: player,
    calendarApi: null,
    legacyCalendarActive: false,
    rebornCalendarActive: true,
  });
  assert.equal(
    await openCalendar({ calendarApi: null }),
    false,
    "a missing Calendar API fails closed",
  );
  installGame({
    currentUser: player,
    calendarApi: null,
    legacyCalendarActive: false,
    rebornCalendarActive: true,
  });
  globalThis.SimpleCalendar = {
    api: {
      showCalendar: () => {
        throw new Error("calendar render failed");
      },
    },
  };
  assert.equal(
    await openCalendar(),
    false,
    "a Calendar rendering failure is contained on the recipient client",
  );
  delete globalThis.SimpleCalendar;

  /* Missing or inactive SocketLib fails closed before any raw socket use. */
  delete globalThis.socketlib;
  installGame({ currentUser: gm, socketlibActive: false });
  assert.equal(registerPlayerSurfaceSocket(), false);
  assert.deepEqual(getPlayerSurfaceStatus(), {
    ready: false,
    transport: "socketlib",
    handlerRegistered: false,
    mattSenderGuardReady: false,
    mattVersion: SUPPORTED_MATT_VERSION,
  });
  assert.equal(
    await emitPlayerSurfaceOpen({
      targetUserId: player.id,
      surface: PLAYER_SURFACES.SHOPS,
    }),
    null,
  );
  installGame({ currentUser: gm, socketlibActive: true });
  assert.equal(registerPlayerSurfaceSocket(), false);

  /* SocketLib registration is idempotent and retains its normal handler. */
  let registeredHandler = null;
  let registerModuleCalls = 0;
  let registerHandlerCalls = 0;
  let transportFailure = false;
  const socketlibExecutions = [];
  const socketlibSocket = {
    register(name, handler) {
      registerHandlerCalls += 1;
      assert.equal(name, PLAYER_SURFACE_EVENT);
      registeredHandler = handler;
    },
    async executeAsUser(...args) {
      socketlibExecutions.push(args);
      if (transportFailure) throw new Error("simulated SocketLib failure");
      return true;
    },
  };
  globalThis.socketlib = {
    registerModule(moduleId) {
      registerModuleCalls += 1;
      assert.equal(moduleId, "infinity-dnd5e");
      return socketlibSocket;
    },
  };
  assert.equal(registerPlayerSurfaceSocket(), true);
  assert.equal(registerPlayerSurfaceSocket(), true);
  assert.equal(registerModuleCalls, 1);
  assert.equal(registerHandlerCalls, 1);
  assert.equal(typeof registeredHandler, "function");
  assert.deepEqual(getPlayerSurfaceStatus(), {
    ready: false,
    transport: "socketlib",
    handlerRegistered: true,
    mattSenderGuardReady: false,
    mattVersion: SUPPORTED_MATT_VERSION,
  });
  installGame({ currentUser: gm, socketlibActive: false });
  assert.deepEqual(getPlayerSurfaceStatus(), {
    ready: false,
    transport: "socketlib",
    handlerRegistered: true,
    mattSenderGuardReady: false,
    mattVersion: SUPPORTED_MATT_VERSION,
  });

  /* Authoritative GM emission is exactly targeted and data-minimizing. */
  installGame({
    currentUser: gm,
    socket: { emit: () => assert.fail("raw module socket must not be used") },
  });
  for (const surface of Object.values(PLAYER_SURFACES)) {
    assert.ok(
      await emitPlayerSurfaceOpen({ targetUserId: player.id, surface }),
    );
  }
  assert.equal(
    socketlibExecutions.length,
    Object.values(PLAYER_SURFACES).length,
  );
  for (const [handlerName, targetUserId, payload] of socketlibExecutions) {
    assert.equal(handlerName, PLAYER_SURFACE_EVENT);
    assert.equal(targetUserId, player.id);
    assert.deepEqual(Object.keys(payload).sort(), [
      "originUserId",
      "surface",
      "targetUserId",
      "type",
    ]);
  }
  assert.equal(
    await emitPlayerSurfaceOpen({
      targetUserId: player.id,
      surface: "unknown",
    }),
    null,
  );
  player.active = false;
  assert.equal(
    await emitPlayerSurfaceOpen({
      targetUserId: player.id,
      surface: PLAYER_SURFACES.SHOPS,
    }),
    null,
    "inactive recipients are rejected",
  );
  player.active = true;
  globalThis.game.user = secondGm;
  assert.equal(
    await emitPlayerSurfaceOpen({
      targetUserId: player.id,
      surface: PLAYER_SURFACES.SHOPS,
    }),
    null,
    "a secondary GM cannot originate the event",
  );
  globalThis.game.user = gm;
  assert.equal(
    await emitPlayerSurfaceOpen({
      targetUserId: secondGm.id,
      surface: PLAYER_SURFACES.SHOPS,
    }),
    null,
    "full-GM recipients are not player-surface targets",
  );

  /* Receiver trusts the transport sender and exact recipient, not claims. */
  let receivedOpens = 0;
  installGame({
    currentUser: player,
    infinityApi: { openShops: () => (receivedOpens += 1) },
  });
  assert.equal(
    await registeredHandler.call(
      { socketdata: { userId: gm.id } },
      validPayload(),
    ),
    true,
    "the SocketLib handler authenticates from its call context",
  );
  assert.equal(receivedOpens, 1);
  assert.equal(
    await registeredHandler.call(
      { socketdata: { userId: gm.id } },
      { ...validPayload(), originUserId: secondGm.id },
    ),
    false,
    "a forged claimed sender is rejected",
  );
  assert.equal(
    await registeredHandler.call(
      { socketdata: { userId: secondGm.id } },
      validPayload(),
    ),
    false,
    "a non-authoritative GM is rejected",
  );
  assert.equal(
    await registeredHandler.call({}, validPayload()),
    false,
    "missing transport identity fails closed",
  );
  assert.equal(
    await receivePlayerSurfacePayload(
      { ...validPayload(), targetUserId: otherPlayer.id },
      gm.id,
    ),
    false,
    "a targeted packet never opens on a different player",
  );
  assert.equal(
    receivedOpens,
    1,
    "a wrong-recipient packet is a no-op on this client",
  );
  player.active = false;
  assert.equal(
    await receivePlayerSurfacePayload(validPayload(), gm.id),
    false,
    "an inactive recipient does not open a window",
  );
  player.active = true;
  globalThis.game.user = gm;
  assert.equal(
    await receivePlayerSurfacePayload(
      { ...validPayload(), targetUserId: gm.id },
      gm.id,
    ),
    false,
    "a full GM does not consume player launch requests",
  );
  assert.equal(receivedOpens, 1);

  /* MATT registration is idempotent. */
  const hookCallbacks = [];
  const hooks = {
    on(name, callback) {
      hookCallbacks.push({ callback, name });
    },
  };
  assert.equal(registerMonksActiveTilesCompat(hooks), true);
  assert.equal(registerMonksActiveTilesCompat(hooks), true);
  assert.equal(hookCallbacks.length, 1);
  assert.equal(hookCallbacks[0].name, "setupTileActions");

  const mattCalls = { action: 0, group: 0 };
  const mattMessages = [];
  const originalMattHandler = function (...args) {
    const [data] = args;
    const mergedContext =
      data?.action === "trigger"
        ? { userId: data.senderId, ...data.options }
        : null;
    mattMessages.push({ args, mergedContext, thisValue: this });
    return "forwarded";
  };
  const mattApi = Object.assign(function MockMonksActiveTiles() {}, {
    onMessage: originalMattHandler,
    triggerActions: {},
    triggerGroups: {},
    registerTileGroup(namespace, name) {
      mattCalls.group += 1;
      this.triggerGroups[namespace] = { name };
      return true;
    },
    registerTileAction(namespace, name, action) {
      mattCalls.action += 1;
      this.triggerActions[`${namespace}.${name}`] = action;
      return true;
    },
  });
  const inactiveMattGame = {
    modules: {
      get: () => ({ active: false, version: SUPPORTED_MATT_VERSION }),
    },
  };
  assert.equal(
    setupMonksActiveTilesActions(mattApi, inactiveMattGame),
    false,
    "missing or inactive MATT is a quiet no-op",
  );
  assert.deepEqual(mattCalls, { action: 0, group: 0 });

  installGame({ currentUser: gm, mattVersion: "13.05" });
  assert.equal(
    setupMonksActiveTilesActions(mattApi),
    false,
    "an unreviewed MATT runtime version fails closed",
  );
  assert.equal(mattApi.onMessage, originalMattHandler);
  assert.deepEqual(getPlayerSurfaceStatus(), {
    ready: false,
    transport: "socketlib",
    handlerRegistered: true,
    mattSenderGuardReady: false,
    mattVersion: "13.05",
  });

  const hubScene = makeHubScene();
  const nonHubScene = { id: "ordinary-scene", flags: {}, tiles: new Map() };
  const nonHubTile = {
    id: "ordinary-tile",
    uuid: "Scene.ordinary-scene.Tile.ordinary-tile",
    parent: nonHubScene,
    flags: {
      "monks-active-tiles": {
        active: true,
        controlled: "all",
        allowpaused: true,
        trigger: ["click"],
        actions: [{ id: "ordinary", action: "openactor", data: {} }],
      },
    },
  };
  nonHubScene.tiles.set(nonHubTile.id, nonHubTile);
  const documentByUuid = new Map(
    [...hubScene.tiles.values(), nonHubTile].map((tile) => [tile.uuid, tile]),
  );
  globalThis.fromUuidSync = (uuid) => documentByUuid.get(uuid) ?? null;
  installGame({
    currentUser: gm,
    scenes: new Map([
      [hubScene.id, hubScene],
      [nonHubScene.id, nonHubScene],
    ]),
  });
  globalThis.game.MonksActiveTiles = mattApi;
  assert.equal(setupMonksActiveTilesActions(mattApi), true);
  const guardedMattHandler = mattApi.onMessage;
  assert.notEqual(guardedMattHandler, originalMattHandler);
  assert.equal(setupMonksActiveTilesActions(mattApi), true);
  assert.equal(
    mattApi.onMessage,
    guardedMattHandler,
    "sender-guard installation is idempotent and ready captures the guard",
  );
  assert.deepEqual(mattCalls, { action: 1, group: 1 });
  assert.deepEqual(getPlayerSurfaceStatus(), {
    ready: true,
    transport: "socketlib",
    handlerRegistered: true,
    mattSenderGuardReady: true,
    mattVersion: SUPPORTED_MATT_VERSION,
  });
  mattApi.onMessage = originalMattHandler;
  assert.equal(
    getPlayerSurfaceStatus().ready,
    false,
    "readiness detects a guard replaced before MATT captures its listener",
  );
  mattApi.onMessage = guardedMattHandler;
  const registeredAction = mattApi.triggerActions[PLAYER_SURFACE_ACTION_ID];
  assert.equal(registeredAction.requiresGM, true);
  assert.deepEqual(
    Object.keys(registeredAction.values.surfaces),
    Object.values(PLAYER_SURFACES),
  );

  /* Every canonical hub control binds MATT's claims to the transport sender. */
  for (const tile of hubScene.tiles.values()) {
    const context = { tile: tile.id };
    const packet = triggerPacket(tile);
    const result = guardedMattHandler.call(context, packet, player.id);
    assert.equal(result, "forwarded", `${tile.id} should reach MATT`);
    const forwarded = mattMessages.at(-1);
    assert.equal(forwarded.thisValue, context, "MATT this is preserved");
    assert.notEqual(forwarded.args[0], packet, "protected data is cloned");
    assert.deepEqual(forwarded.args[0], {
      action: "trigger",
      tileid: tile.uuid,
      method: "click",
      senderId: player.id,
      userId: player.id,
      tokens: [],
      pt: null,
      options: {},
    });
    assert.equal(forwarded.args[1], player.id);
    assert.equal(
      forwarded.mergedContext.userId,
      player.id,
      "MATT's options merge cannot replace the authenticated sender",
    );
    assert.equal(
      packet.senderId,
      otherPlayer.id,
      "the client packet is not mutated",
    );
  }

  /* A Home-enabled hub remains canonical without invalidating v1 hub keys. */
  hubScene.flags["drakemore-foundry"].playerHub.controlKeys = [
    ...HUB_CONTROL_KEYS,
    "home",
  ];
  const homeTile = {
    id: "tile-home",
    uuid: `Scene.${hubScene.id}.Tile.tile-home`,
    parent: hubScene,
    flags: {
      "drakemore-foundry": {
        playerHubControl: {
          version: 1,
          key: "home",
          label: HUB_LABELS.home,
          interaction: { type: "bounded-hub-interaction" },
        },
      },
      "monks-active-tiles": {
        active: true,
        controlled: "all",
        allowpaused: true,
        trigger: ["click"],
        actions: [makeHubAction("home")],
      },
    },
  };
  hubScene.tiles.set(homeTile.id, homeTile);
  documentByUuid.set(homeTile.uuid, homeTile);
  assert.equal(
    guardedMattHandler(triggerPacket(homeTile), player.id),
    "forwarded",
    "the allowlisted Home surface can be used by a canonical hub control",
  );
  assert.equal(mattMessages.at(-1).args[0].senderId, player.id);

  const protectedPacket = triggerPacket(hubScene.tiles.get("tile-shops"));
  const protectedCallCount = mattMessages.length;
  assert.equal(
    guardedMattHandler(protectedPacket),
    false,
    "missing transport identity fails closed",
  );
  assert.equal(
    guardedMattHandler(protectedPacket, gm.id),
    false,
    "a full GM is not accepted as a player trigger sender",
  );
  player.active = false;
  assert.equal(
    guardedMattHandler(protectedPacket, player.id),
    false,
    "an inactive transport sender fails closed",
  );
  player.active = true;
  assert.equal(
    guardedMattHandler({ ...protectedPacket, method: "manual" }, player.id),
    false,
    "only a click can launch a protected hub control",
  );
  assert.equal(
    guardedMattHandler({ ...protectedPacket, options: null }, player.id),
    false,
    "a malformed protected trigger packet is dropped",
  );
  assert.equal(
    guardedMattHandler(
      { ...protectedPacket, options: { userId: otherPlayer.id } },
      player.id,
    ),
    false,
    "a nested forged userId never reaches MATT's context merge",
  );
  const prototypeKeyOptions = JSON.parse(
    `{"__proto__":{"userId":"${otherPlayer.id}"}}`,
  );
  assert.equal(
    guardedMattHandler(
      { ...protectedPacket, options: prototypeKeyOptions },
      player.id,
    ),
    false,
    "prototype-like option keys are rejected before reconstruction",
  );
  assert.equal(
    guardedMattHandler(
      { ...protectedPacket, tokens: ["Scene.x.Token.y"] },
      player.id,
    ),
    false,
    "protected hub launchers never accept client-selected token context",
  );
  assert.equal(
    guardedMattHandler(
      { ...protectedPacket, projection: { secret: true } },
      player.id,
    ),
    false,
    "extra protected trigger data is rejected rather than forwarded",
  );
  assert.equal(mattMessages.length, protectedCallCount);

  assert.equal(
    guardedMattHandler(
      {
        ...protectedPacket,
        tileid: `Scene.${hubScene.id}.Tile.missing-protected-tile`,
      },
      player.id,
    ),
    false,
    "failed resolution inside the protected hub Scene is dropped",
  );
  const shopsTile = hubScene.tiles.get("tile-shops");
  const originalShopActions = shopsTile.flags["monks-active-tiles"].actions;
  shopsTile.flags["monks-active-tiles"].actions = [
    ...originalShopActions,
    makeHubAction("calendar"),
  ];
  assert.equal(
    guardedMattHandler(triggerPacket(shopsTile), player.id),
    false,
    "malformed protected topology fails closed",
  );
  shopsTile.flags["monks-active-tiles"].actions = originalShopActions;

  const ordinaryPacket = triggerPacket(nonHubTile, {
    senderId: "untrusted-claim",
    userId: "untrusted-claim",
  });
  const ordinaryContext = { ordinary: true };
  assert.equal(
    guardedMattHandler.call(ordinaryContext, ordinaryPacket, otherPlayer.id),
    "forwarded",
    "non-hub MATT messages retain upstream behavior",
  );
  const ordinaryForward = mattMessages.at(-1);
  assert.equal(ordinaryForward.thisValue, ordinaryContext);
  assert.equal(ordinaryForward.args[0], ordinaryPacket);
  assert.equal(ordinaryForward.args[1], otherPlayer.id);

  const unmarkedInfinityTile = {
    id: "unmarked-infinity",
    uuid: "Scene.ordinary-scene.Tile.unmarked-infinity",
    parent: nonHubScene,
    flags: {
      "monks-active-tiles": {
        active: true,
        controlled: "all",
        allowpaused: true,
        trigger: ["click"],
        actions: [makeHubAction("shops")],
      },
    },
  };
  nonHubScene.tiles.set(unmarkedInfinityTile.id, unmarkedInfinityTile);
  documentByUuid.set(unmarkedInfinityTile.uuid, unmarkedInfinityTile);
  assert.equal(
    guardedMattHandler(triggerPacket(unmarkedInfinityTile), player.id),
    false,
    "the Infinity action is protected even when copied outside the canonical hub",
  );

  const nonTriggerPacket = { action: "playvideo", senderId: "unchanged" };
  assert.equal(guardedMattHandler(nonTriggerPacket, player.id), "forwarded");
  assert.equal(mattMessages.at(-1).args[0], nonTriggerPacket);

  /* The guard is installed even when the action was already registered. */
  const preRegisteredOriginal = () => "pre-registered";
  const preRegisteredApi = {
    onMessage: preRegisteredOriginal,
    triggerActions: { [PLAYER_SURFACE_ACTION_ID]: registeredAction },
    triggerGroups: { "infinity-dnd5e": { name: "Infinity D&D5e" } },
  };
  assert.equal(setupMonksActiveTilesActions(preRegisteredApi), true);
  assert.notEqual(preRegisteredApi.onMessage, preRegisteredOriginal);

  const directAction = buildPlayerSurfaceAction();
  let localGmOpens = 0;
  const socketlibExecutionsBeforeGmClick = socketlibExecutions.length;
  installGame({
    currentUser: gm,
    infinityApi: { openShops: () => (localGmOpens += 1) },
  });
  const successfulGmAction = await directAction.fn({
    action: { data: { surface: PLAYER_SURFACES.SHOPS } },
    userId: gm.id,
  });
  assert.deepEqual(successfulGmAction, { continue: true });
  assert.equal(localGmOpens, 1, "a full GM click opens the window locally");
  assert.equal(
    socketlibExecutions.length,
    socketlibExecutionsBeforeGmClick,
    "a full GM click never enters the player-targeted SocketLib path",
  );

  installGame({ currentUser: gm });
  const successfulAction = await directAction.fn({
    action: { data: { surface: PLAYER_SURFACES.SHOPS } },
    userId: player.id,
  });
  assert.deepEqual(successfulAction, { continue: true });
  const successfulHomeAction = await directAction.fn({
    action: { data: { surface: PLAYER_SURFACES.HOME } },
    userId: player.id,
  });
  assert.deepEqual(successfulHomeAction, { continue: true });
  transportFailure = true;
  const failedTransportAction = await directAction.fn({
    action: { data: { surface: PLAYER_SURFACES.SHOPS } },
    userId: player.id,
  });
  assert.deepEqual(failedTransportAction, { continue: false });
  transportFailure = false;
  const refusedAction = await directAction.fn({
    action: { data: { surface: "gm-dashboard" } },
    userId: player.id,
  });
  assert.deepEqual(refusedAction, { continue: false });
} finally {
  console.warn = originalWarn;
  player.active = true;
  for (const [key, value] of Object.entries(savedGlobals)) {
    if (value === undefined) delete globalThis[key];
    else globalThis[key] = value;
  }
}

process.stdout.write("player-surface MATT integration passed\n");
