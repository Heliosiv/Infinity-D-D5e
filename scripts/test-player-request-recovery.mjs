import assert from "node:assert/strict";

const player = { id: "player", role: 1, isGM: false, active: true };
const gm = { id: "gm", role: 4, isGM: true, active: true };
const actor = {
  id: "hero",
  name: "Hero",
  type: "character",
  ownership: { player: 3 },
};
player.character = actor;
const users = [player, gm];
users.activeGM = gm;
users.get = (id) => users.find((user) => user.id === id);
globalThis.CONST = {
  USER_ROLES: { GAMEMASTER: 4 },
  DOCUMENT_OWNERSHIP_LEVELS: { OWNER: 3 },
};
globalThis.foundry = {
  applications: {
    api: {
      ApplicationV2: class {},
      HandlebarsApplicationMixin: (Base) => class extends Base {},
    },
  },
};
const notices = [];
globalThis.ui = {
  notifications: Object.fromEntries(
    ["warn", "info", "error"].map((type) => [
      type,
      (message) => notices.push(message),
    ]),
  ),
};
let send = () => {};
globalThis.game = {
  ready: false,
  user: player,
  users,
  actors: { contents: [actor] },
  settings: { get: () => undefined },
  socket: { emit: (_channel, payload) => send(payload) },
};
const { ShopPickerApp } = await import("./shop-picker.js");
const { ResourceOverviewApp } = await import("./resource-overview.js");
const realSetTimeout = globalThis.setTimeout;
const realClearTimeout = globalThis.clearTimeout;
const timers = new Map();
let nextTimer = 0;
globalThis.setTimeout = (callback) => {
  const id = ++nextTimer;
  timers.set(id, callback);
  return id;
};
globalThis.clearTimeout = (id) => timers.delete(id);
const failures = [];
async function check(label, run) {
  timers.clear();
  notices.length = 0;
  try {
    await run();
  } catch (error) {
    failures.push(`${label}: ${error.message}`);
  }
}
function shop() {
  const app = Object.create(ShopPickerApp.prototype);
  return Object.assign(app, {
    rendered: true,
    _shops: [{ id: "shop", name: "Shop", selfServiceMode: "open" }],
    _pending: new Set(),
    _loadTimer: null,
    _loading: false,
    render() {},
  });
}
function supplies() {
  const app = Object.create(ResourceOverviewApp.prototype);
  return Object.assign(app, {
    rendered: true,
    _requestTimer: null,
    _requestId: null,
    _overview: null,
    _loading: false,
    render() {},
  });
}
try {
  for (const [label, create, request, timerKey] of [
    ["shops", shop, "_requestList", "_loadTimer"],
    ["supplies", supplies, "_requestOverview", "_requestTimer"],
  ]) {
    await check(`${label} send failure`, () => {
      const app = create();
      send = () => {
        throw new Error("Connection interrupted");
      };
      assert.doesNotThrow(() => app[request]());
      assert.equal(app._loading, false);
      assert.equal(app._requestFailed, true);
      assert.equal(timers.size, 0);
    });
    await check(`${label} quick reply and refresh`, () => {
      const app = create();
      send = (payload) => {
        if (label === "shops")
          app._onShopList({
            targetUserId: player.id,
            shops: [{ id: "shop", name: "Shop" }],
          });
        else
          app._onOverviewReply({
            targetUserId: player.id,
            requestId: payload.requestId,
            enabled: true,
            overview: { partySize: 2, resources: [] },
          });
      };
      app[request]();
      assert.equal(app._loading, false);
      assert.equal(app._requestFailed, false);
      assert.equal(
        timers.size,
        0,
        "an accepted reply must not leave a timeout that erases the result",
      );
      assert.equal(app[timerKey], null);
      app[request]();
      assert.equal(timers.size, 0);
    });
    await check(`${label} timeout and retry`, () => {
      const app = create();
      send = () => {};
      app[request]();
      assert.equal(app._loading, true);
      const timeout = timers.get(app[timerKey]);
      timers.delete(app[timerKey]);
      timeout();
      assert.equal(app._loading, false);
      assert.equal(app._requestFailed, true);
      app[request]();
      assert.equal(app._loading, true);
      assert.equal(app._requestFailed, false);
    });
  }
  await check("shop entry send failure", () => {
    const app = shop();
    send = () => {
      throw new Error("Connection interrupted");
    };
    assert.doesNotThrow(() =>
      ShopPickerApp.DEFAULT_OPTIONS.actions.openShop.call(app, null, {
        dataset: { merchantId: "shop" },
      }),
    );
    assert.equal(app._pending.size, 0);
    assert.match(notices.at(-1) ?? "", /retry|again|refresh/i);
  });
  await check("quick shop result is not overwritten by pending state", () => {
    const app = shop();
    send = (payload) => {
      if (payload.type === "merchant:shop-request")
        app._onShopResult({
          targetUserId: player.id,
          merchantId: "shop",
          outcome: "denied",
        });
      else app._onShopList({ targetUserId: player.id, shops: [] });
    };
    ShopPickerApp.DEFAULT_OPTIONS.actions.openShop.call(app, null, {
      dataset: { merchantId: "shop" },
    });
    assert.equal(app._pending.size, 0);
    assert.match(notices.at(-1), /turned you away/);
  });
  await check("duplicate shop entry sends once", () => {
    const app = shop();
    let sent = 0;
    send = () => {
      sent++;
    };
    for (let i = 0; i < 2; i++)
      ShopPickerApp.DEFAULT_OPTIONS.actions.openShop.call(app, null, {
        dataset: { merchantId: "shop" },
      });
    assert.equal(sent, 1);
    assert.equal(app._pending.size, 1);
  });
} finally {
  globalThis.setTimeout = realSetTimeout;
  globalThis.clearTimeout = realClearTimeout;
}
assert.deepEqual(failures, [], failures.join("\n"));
console.log(
  "Player request failure, quick reply, timeout, and retry journeys passed",
);
