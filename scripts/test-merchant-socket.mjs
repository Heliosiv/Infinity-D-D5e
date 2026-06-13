import assert from "node:assert/strict";

import {
  MERCHANT_EVENTS,
  subscribe,
  emitMerchantEvent,
  receiveMerchantPayload,
  pushOpenSession,
} from "./merchant/socket.js";

/**
 * The socket receive→dispatch path is what makes a GM-pushed session pop on the
 * player's client (registerMerchantSessionAutoOpen subscribes to SESSION_OPEN).
 * It was previously untested; these lock in the behavior that a broken player
 * shop-open would violate.
 */

const savedGame = globalThis.game;

try {
  // Pretend to be the player "player1"; the socket emit is a no-op sink.
  const emitted = [];
  globalThis.game = {
    user: { id: "player1", isGM: false },
    users: { activeGM: { id: "gm" } },
    socket: {
      emit: (name, payload) => emitted.push({ name, payload }),
      on() {},
    },
  };

  /* A GM-originated SESSION_OPEN targeted at this user reaches subscribers. */
  {
    const seen = [];
    const off = subscribe(MERCHANT_EVENTS.SESSION_OPEN, (p) => seen.push(p));
    await receiveMerchantPayload({
      type: MERCHANT_EVENTS.SESSION_OPEN,
      originUserId: "gm",
      targetUserId: "player1",
      sessionId: "s-1",
      merchantId: "m-1",
    });
    off();
    assert.equal(seen.length, 1, "player receives the GM's SESSION_OPEN");
    assert.equal(seen[0].targetUserId, "player1");
    assert.equal(seen[0].sessionId, "s-1");
  }

  /* Echo-suppression: a payload this client originated is NOT re-dispatched on
     receive (it was already dispatched locally at emit time). */
  {
    const seen = [];
    const off = subscribe(MERCHANT_EVENTS.SESSION_OPEN, (p) => seen.push(p));
    await receiveMerchantPayload({
      type: MERCHANT_EVENTS.SESSION_OPEN,
      originUserId: "player1", // same as game.user.id
      targetUserId: "player1",
      sessionId: "s-echo",
    });
    off();
    assert.equal(seen.length, 0, "own echo is suppressed on receive");
  }

  /* Unknown event types are ignored (the socket name is shared with audio). */
  {
    const seen = [];
    const off = subscribe(MERCHANT_EVENTS.SHOP_LIST_REPLY, (p) => seen.push(p));
    await receiveMerchantPayload({ type: "sound-event", id: "x" });
    await receiveMerchantPayload({ type: "not-a-merchant-event" });
    off();
    assert.equal(seen.length, 0, "non-merchant payloads dispatch nothing");
  }

  /* emitMerchantEvent dispatches to local subscribers (optimistic local echo)
     AND writes to the socket so other clients receive it. */
  {
    emitted.length = 0;
    const seen = [];
    const off = subscribe(MERCHANT_EVENTS.SHOP_LIST_REQUEST, (p) =>
      seen.push(p),
    );
    const payload = emitMerchantEvent(MERCHANT_EVENTS.SHOP_LIST_REQUEST, {});
    off();
    assert.equal(seen.length, 1, "local subscriber sees the emitted event");
    assert.equal(payload.originUserId, "player1", "stamps the sender id");
    assert.equal(emitted.length, 1, "broadcast over the socket");
    assert.equal(emitted[0].payload.type, MERCHANT_EVENTS.SHOP_LIST_REQUEST);
  }

  /* A SESSION_OPEN aimed at a DIFFERENT user still dispatches locally — the
     per-app handlers (auto-open / shop picker) are responsible for filtering by
     targetUserId, which keeps the routing rule in one place. */
  {
    const seen = [];
    const off = subscribe(MERCHANT_EVENTS.SESSION_OPEN, (p) => seen.push(p));
    await receiveMerchantPayload({
      type: MERCHANT_EVENTS.SESSION_OPEN,
      originUserId: "gm",
      targetUserId: "someone-else",
      sessionId: "s-2",
    });
    off();
    assert.equal(
      seen.length,
      1,
      "dispatch is target-agnostic; handlers filter",
    );
    assert.equal(seen[0].targetUserId, "someone-else");
  }
  /* pushOpenSession emits SESSION_OPEN for every ALLOWED target — including a
     player who holds an elevated (assistant-GM) role — and skips users who
     aren't on the merchant's allow-list. Regression: it used to drop any
     GM-role user, so an assistant-GM player silently received nothing. */
  {
    emitted.length = 0;
    const seen = [];
    const off = subscribe(MERCHANT_EVENTS.SESSION_OPEN, (p) => seen.push(p));
    const merchant = {
      id: "m-shop",
      name: "Sundries",
      allowedUserIds: ["player1", "assistant-gm"],
      items: [],
    };
    const opened = pushOpenSession({
      merchant,
      targetUserIds: ["player1", "assistant-gm", "stranger"],
    });
    off();
    assert.deepEqual(
      opened.map((d) => d.viewerUserId).sort(),
      ["assistant-gm", "player1"],
      "opens for allowed users (incl. assistant-GM); skips the non-allowed stranger",
    );
    assert.deepEqual(
      seen.map((p) => p.targetUserId).sort(),
      ["assistant-gm", "player1"],
      "emits exactly one SESSION_OPEN per opened target",
    );
    assert.ok(
      seen.every((p) => p.merchantId === "m-shop"),
      "each SESSION_OPEN carries the merchant id",
    );
  }
} finally {
  if (savedGame === undefined) delete globalThis.game;
  else globalThis.game = savedGame;
}

process.stdout.write("merchant-socket validation passed\n");
