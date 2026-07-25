import assert from "node:assert/strict";

const saved = {
  foundry: globalThis.foundry,
  game: globalThis.game,
  Hooks: globalThis.Hooks,
  CONST: globalThis.CONST,
};

function makeHooks() {
  let nextId = 0;
  const listeners = new Map();
  return {
    on(event, handler) {
      const id = ++nextId;
      if (!listeners.has(event)) listeners.set(event, new Map());
      listeners.get(event).set(id, handler);
      return id;
    },
    off(event, id) {
      listeners.get(event)?.delete(id);
    },
    call(event, ...args) {
      for (const handler of listeners.get(event)?.values() ?? []) {
        handler(...args);
      }
    },
  };
}

try {
  globalThis.CONST = {
    USER_ROLES: { GAMEMASTER: 4 },
    DOCUMENT_OWNERSHIP_LEVELS: { OWNER: 3 },
  };
  globalThis.foundry = {
    applications: {
      api: {
        ApplicationV2: class {
          constructor() {
            this.rendered = true;
            this.renderCount = 0;
          }

          render() {
            this.renderCount += 1;
          }

          _onClose() {}
        },
        HandlebarsApplicationMixin: (Base) => class extends Base {},
      },
    },
  };
  globalThis.Hooks = makeHooks();

  const viewer = {
    id: "viewer",
    isGM: true,
    role: 4,
    active: true,
  };
  const authority = {
    id: "gm-authority",
    isGM: true,
    role: 4,
    active: true,
  };
  const users = [viewer, authority];
  users.activeGM = authority;
  users.get = (id) => users.find((user) => user.id === id) ?? null;
  const actors = [];
  actors.get = () => null;
  const emitted = [];
  globalThis.game = {
    ready: false,
    user: viewer,
    users,
    actors,
    settings: { get: () => undefined },
    socket: {
      emit(_channel, payload, options) {
        emitted.push({ payload, options });
      },
    },
  };

  const { ResourceOverviewApp } = await import("./resource-overview.js");
  const app = new ResourceOverviewApp();
  assert.ok(app._overview, "a full GM starts with a local sanitized preview");
  assert.equal(app._requestId, null);

  /* Demotion clears the privileged preview before requesting player data. */
  viewer.isGM = false;
  viewer.role = 1;
  globalThis.Hooks.call("updateUser", viewer);
  assert.equal(app._overview, null);
  assert.equal(typeof app._requestId, "string");
  assert.ok(app._requestId.length > 0);
  const playerRequestId = app._requestId;
  assert.equal(emitted.at(-1)?.payload?.type, "resource:overview-request");

  app._onOverviewReply({
    targetUserId: viewer.id,
    requestId: "unsolicited-request",
    enabled: true,
    overview: { partySize: 99 },
  });
  assert.equal(
    app._overview,
    null,
    "a reply with the wrong correlation id is ignored",
  );
  app._onOverviewReply({
    requestId: playerRequestId,
    enabled: true,
    overview: { partySize: 99 },
  });
  assert.equal(
    app._overview,
    null,
    "a reply without an exact target is ignored",
  );

  app._onOverviewReply({
    targetUserId: viewer.id,
    requestId: playerRequestId,
    enabled: true,
    overview: {
      generatedAt: Date.now(),
      partySize: 2,
      resources: [],
    },
  });
  assert.equal(app._overview.partySize, 2);
  assert.equal(
    app._requestId,
    null,
    "an accepted reply consumes the request id",
  );

  app._onOverviewReply({
    targetUserId: viewer.id,
    requestId: playerRequestId,
    enabled: true,
    overview: { partySize: 88 },
  });
  assert.equal(
    app._overview.partySize,
    2,
    "a duplicate reply is ignored after the request is consumed",
  );

  /* Promotion invalidates an in-flight player request and rejects its late reply. */
  app._requestOverview();
  const lateRequestId = app._requestId;
  viewer.isGM = true;
  viewer.role = 4;
  users.activeGM = viewer;
  globalThis.Hooks.call("updateUser", viewer);
  assert.equal(app._requestId, null);
  const promotedPreview = app._overview;
  assert.ok(promotedPreview);
  app._onOverviewReply({
    targetUserId: viewer.id,
    requestId: lateRequestId,
    enabled: true,
    overview: { partySize: 77 },
  });
  assert.equal(
    app._overview,
    promotedPreview,
    "a late player reply cannot replace the promoted GM preview",
  );

  app._onClose();
  process.stdout.write("resource overview app validation passed\n");
} finally {
  if (saved.foundry === undefined) delete globalThis.foundry;
  else globalThis.foundry = saved.foundry;
  if (saved.game === undefined) delete globalThis.game;
  else globalThis.game = saved.game;
  if (saved.Hooks === undefined) delete globalThis.Hooks;
  else globalThis.Hooks = saved.Hooks;
  if (saved.CONST === undefined) delete globalThis.CONST;
  else globalThis.CONST = saved.CONST;
}
