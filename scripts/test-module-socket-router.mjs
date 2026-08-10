import assert from "node:assert/strict";

import { registerSoundSocket } from "./audio.js";
import { registerDowntimeSocket } from "./downtime/socket.js";
import { registerCriticalInjurySocket } from "./injury/socket.js";
import { registerMerchantSocket } from "./merchant/socket.js";
import { registerReputationSocket } from "./reputation/socket.js";
import { registerResourceSocket } from "./resource/socket.js";
import {
  MODULE_SOCKET_NAME,
  emitModuleSocketPayload,
  registerModuleSocketRoute,
} from "./socket-router.js";

const saved = Object.fromEntries(
  ["game", "CONST", "Hooks", "localStorage"].map((key) => [
    key,
    globalThis[key],
  ]),
);
const savedWarn = console.warn;

try {
  const gm = { id: "gm-1", isGM: true, role: 4, active: true };
  const player = { id: "player-1", isGM: false, role: 1, active: true };
  const users = new Map([
    [gm.id, gm],
    [player.id, player],
  ]);
  users.activeGM = gm;

  const registeredListeners = [];
  const emissions = [];
  const warnings = [];
  console.warn = (...args) => warnings.push(args);
  globalThis.CONST = { USER_ROLES: { GAMEMASTER: 4 } };
  globalThis.Hooks = { on() {} };
  globalThis.localStorage = {
    getItem: () => null,
    setItem() {},
    removeItem() {},
  };
  globalThis.game = {
    user: gm,
    users,
    world: { id: "socket-router-test" },
    actors: new Map(),
    socket: {
      on(channel, handler) {
        registeredListeners.push({ channel, handler });
      },
      emit(...args) {
        emissions.push(args);
      },
    },
  };

  assert.equal(registerSoundSocket(), true);
  assert.equal(
    registerSoundSocket(),
    false,
    "sound keeps its public semantics",
  );
  for (const register of [
    registerDowntimeSocket,
    registerMerchantSocket,
    registerReputationSocket,
    registerResourceSocket,
    registerCriticalInjurySocket,
  ]) {
    assert.equal(register(), true);
    assert.equal(register(), true, "feature registration remains idempotent");
  }
  assert.equal(
    registeredListeners.length,
    1,
    "all six raw protocols share one physical Foundry listener",
  );
  assert.equal(registeredListeners[0].channel, MODULE_SOCKET_NAME);

  const received = [];
  const alphaReceiver = (payload, senderId) =>
    received.push({ payload, senderId });
  assert.equal(
    registerModuleSocketRoute({
      id: "test-alpha",
      eventTypes: ["test:alpha", "test:alpha-two"],
      receive: alphaReceiver,
    }),
    true,
  );
  assert.equal(
    registerModuleSocketRoute({
      id: "test-alpha",
      eventTypes: ["test:alpha-two", "test:alpha"],
      receive: alphaReceiver,
    }),
    true,
    "equivalent route registration is order-insensitive and idempotent",
  );
  assert.equal(registeredListeners.length, 1);

  const callback = registeredListeners[0].handler;
  const flatPayload = {
    type: "test:alpha",
    originUserId: player.id,
    domainValue: { untouched: true },
  };
  assert.equal(callback(flatPayload, player.id), true);
  assert.equal(received.length, 1);
  assert.equal(
    received[0].payload,
    flatPayload,
    "the wire payload is not wrapped",
  );
  assert.equal(received[0].senderId, player.id);
  assert.deepEqual(received[0].payload.domainValue, { untouched: true });

  assert.equal(callback(flatPayload), false, "transport identity is mandatory");
  assert.equal(
    callback(flatPayload, "other-user"),
    false,
    "a claimed origin cannot override transport identity",
  );
  assert.equal(callback({ type: "test:unknown" }, player.id), false);
  assert.equal(callback([], player.id), false);
  assert.equal(received.length, 1, "rejected frames reach no feature receiver");

  assert.equal(
    registerModuleSocketRoute({
      id: "test-conflict",
      eventTypes: ["test:alpha"],
      receive() {},
    }),
    false,
    "an exact event type can have only one owner",
  );
  assert.equal(
    registerModuleSocketRoute({
      id: "test-alpha",
      eventTypes: ["test:alpha"],
      receive() {},
    }),
    false,
    "an existing route cannot be silently replaced",
  );

  assert.equal(
    registerModuleSocketRoute({
      id: "test-async-failure",
      eventTypes: ["test:async-failure"],
      async receive() {
        throw new Error("expected route failure");
      },
    }),
    true,
  );
  assert.equal(
    callback(
      { type: "test:async-failure", originUserId: player.id },
      player.id,
    ),
    true,
  );
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.ok(
    warnings.some((args) => args[0]?.includes("socket route failed")),
    "a rejected async receiver is contained and audited",
  );

  emissions.length = 0;
  const outbound = { type: "test:flat", value: 42 };
  assert.equal(emitModuleSocketPayload(outbound), true);
  assert.deepEqual(emissions[0], [MODULE_SOCKET_NAME, outbound]);
  assert.equal(
    emissions[0][1],
    outbound,
    "broadcast preserves object identity",
  );

  assert.equal(
    emitModuleSocketPayload(outbound, {
      recipients: [" player-1 ", "player-1", "gm-1"],
    }),
    true,
  );
  assert.deepEqual(emissions[1], [
    MODULE_SOCKET_NAME,
    outbound,
    {
      recipients: ["player-1", "gm-1"],
    },
  ]);
  assert.equal(
    emitModuleSocketPayload(outbound, { recipients: [] }),
    false,
    "an explicit empty recipient list never becomes a broadcast",
  );
  assert.equal(emissions.length, 2);

  process.stdout.write("module socket compatibility router passed\n");
} finally {
  console.warn = savedWarn;
  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) delete globalThis[key];
    else globalThis[key] = value;
  }
}
