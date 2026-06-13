import assert from "node:assert/strict";

const savedFoundry = globalThis.foundry;
const savedGame = globalThis.game;
const savedUi = globalThis.ui;
const savedHooks = globalThis.Hooks;
const savedSetTimeout = globalThis.setTimeout;
const savedClearTimeout = globalThis.clearTimeout;

const timers = new Map();
let nextTimerId = 1;
const emitted = [];

globalThis.setTimeout = (fn, ms) => {
  const id = nextTimerId++;
  timers.set(id, { fn, ms });
  return id;
};
globalThis.clearTimeout = (id) => {
  timers.delete(id);
};

globalThis.foundry = {
  applications: {
    api: {
      ApplicationV2: class {
        constructor(options = {}) {
          this.options = options;
          this.rendered = false;
          this.renderCount = 0;
        }

        render() {
          this.rendered = true;
          this.renderCount += 1;
          return this;
        }

        _onClose() {}
      },
      HandlebarsApplicationMixin: (Base) => class extends Base {},
    },
  },
};

globalThis.game = {
  user: { id: "p1", isGM: false },
  users: {
    activeGM: { id: "gm-1", active: true },
  },
  socket: {
    emit: (_socketName, payload) => emitted.push(payload),
  },
  settings: {
    get: () => true,
  },
};

globalThis.ui = { notifications: { info() {}, warn() {} } };
globalThis.Hooks = { on: () => 1, off() {} };

try {
  const { ShopPickerApp } = await import("./shop-picker.js");
  const { MERCHANT_EVENTS, receiveMerchantPayload } =
    await import("./merchant/socket.js");

  const app = new ShopPickerApp();
  app.rendered = true;

  assert.equal(emitted.length, 1, "opening the picker requests a shop list");
  assert.equal(emitted[0].type, MERCHANT_EVENTS.SHOP_LIST_REQUEST);
  assert.ok(emitted[0].requestId, "shop-list requests carry a request id");
  assert.equal(app._loading, true);
  assert.equal(app._requestFailed, false);
  assert.equal(timers.size, 1, "shop-list request starts one timeout");

  const pendingTimer = [...timers.values()][0];
  assert.equal(pendingTimer.ms, 5000);
  pendingTimer.fn();

  assert.equal(app._loading, false, "timeout leaves loading state");
  assert.equal(app._requestFailed, true, "timeout exposes the failed state");
  assert.deepEqual(app._shops, []);
  assert.equal(app.renderCount, 1, "timeout re-renders a visible picker");

  const contextAfterTimeout = await app._prepareContext();
  assert.equal(contextAfterTimeout.loading, false);
  assert.equal(contextAfterTimeout.requestFailed, true);

  await receiveMerchantPayload({
    type: MERCHANT_EVENTS.SHOP_LIST_REPLY,
    originUserId: "gm-1",
    targetUserId: "p1",
    requestId: emitted[0].requestId,
    shops: [{ id: "shop-1", name: "Open Shop" }],
  });

  assert.equal(app._loading, false);
  assert.equal(app._requestFailed, false, "a matching reply clears failure");
  assert.equal(app._shops.length, 1);
  assert.equal(app._shops[0].name, "Open Shop");

  app._onClose();
} finally {
  globalThis.setTimeout = savedSetTimeout;
  globalThis.clearTimeout = savedClearTimeout;
  if (savedFoundry === undefined) delete globalThis.foundry;
  else globalThis.foundry = savedFoundry;
  if (savedGame === undefined) delete globalThis.game;
  else globalThis.game = savedGame;
  if (savedUi === undefined) delete globalThis.ui;
  else globalThis.ui = savedUi;
  if (savedHooks === undefined) delete globalThis.Hooks;
  else globalThis.Hooks = savedHooks;
}

process.stdout.write("shop-picker timeout validation passed\n");
