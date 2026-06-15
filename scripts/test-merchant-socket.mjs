import assert from "node:assert/strict";

import {
  MERCHANT_EVENTS,
  subscribe,
  emitMerchantEvent,
  receiveMerchantPayload,
  pushOpenSession,
  requestMerchantSessionResume,
} from "./merchant/socket.js";
import { openSession, clearAllSessions } from "./merchant/session-state.js";

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

  /* requestMerchantSessionResume: a player asks the GM to re-send open sessions
     (covers the reload/relog case where the one-shot SESSION_OPEN was missed).
     Silent when no GM is online to answer. */
  {
    emitted.length = 0;
    const seen = [];
    const off = subscribe(MERCHANT_EVENTS.SESSION_RESUME_REQUEST, (p) =>
      seen.push(p),
    );
    requestMerchantSessionResume(); // player1 + activeGM present → requests
    assert.equal(seen.length, 1, "player with a GM online requests a resume");
    assert.equal(
      emitted.at(-1)?.payload?.type,
      MERCHANT_EVENTS.SESSION_RESUME_REQUEST,
      "resume request is broadcast to the GM",
    );

    const savedUsers = globalThis.game.users;
    globalThis.game.users = { activeGM: null };
    seen.length = 0;
    requestMerchantSessionResume();
    assert.equal(seen.length, 0, "no GM online → no resume request");
    globalThis.game.users = savedUsers;
    off();
  }

  /* SESSION_RESUME_REQUEST (GM side): the authoritative GM re-emits SESSION_OPEN
     for ONLY the requesting user's still-open sessions, and drops a session whose
     merchant has been deleted rather than resurrecting a dead window. */
  {
    clearAllSessions();
    openSession({ merchantId: "m-shop", viewerUserId: "player1" });
    openSession({ merchantId: "m-shop", viewerUserId: "player2" }); // other user
    openSession({ merchantId: "gone", viewerUserId: "player1" }); // deleted shop
    const merchants = [
      {
        id: "m-shop",
        name: "Sundries",
        allowedUserIds: ["player1", "player2"],
        items: [],
      },
    ];
    const savedInner = globalThis.game;
    globalThis.game = {
      user: { id: "gm", isGM: true },
      users: {
        activeGM: { id: "gm" },
        get: (id) => ({ id, active: true, isGM: false, name: id }),
      },
      settings: { get: () => merchants },
      socket: { emit() {}, on() {} },
    };
    const seen = [];
    const off = subscribe(MERCHANT_EVENTS.SESSION_OPEN, (p) => seen.push(p));
    await receiveMerchantPayload({
      type: MERCHANT_EVENTS.SESSION_RESUME_REQUEST,
      originUserId: "player1",
    });
    off();
    globalThis.game = savedInner;
    assert.equal(
      seen.length,
      1,
      "resume re-emits exactly one SESSION_OPEN for the requester's live session",
    );
    assert.equal(seen[0].targetUserId, "player1");
    assert.equal(
      seen[0].merchantId,
      "m-shop",
      "only the existing-merchant session resumes; the orphaned one is dropped",
    );
    clearAllSessions();
  }
  /* COMMIT ack: a buy/sell whose session is gone (e.g. the GM reloaded the world
     and the in-memory session map was wiped) must tell the buyer via COMMIT_RESULT
     ok:false — not silently swallow it, leaving the actor changed but the shop not. */
  {
    clearAllSessions();
    const savedInner = globalThis.game;
    globalThis.game = {
      user: { id: "gm", isGM: true },
      users: { activeGM: { id: "gm" }, get: (id) => ({ id, name: id }) },
      socket: { emit() {}, on() {} },
    };
    for (const type of [
      MERCHANT_EVENTS.COMMIT_PURCHASE,
      MERCHANT_EVENTS.COMMIT_SALE,
    ]) {
      const seen = [];
      const off = subscribe(MERCHANT_EVENTS.COMMIT_RESULT, (p) => seen.push(p));
      await receiveMerchantPayload({
        type,
        originUserId: "player1",
        sessionId: "ghost-session",
        commitId: "cx1",
        itemUuid: "Compendium.x.Item.y",
        qty: 1,
        totalGp: 5,
      });
      off();
      assert.equal(seen.length, 1, `${type}: a no-session commit is acked`);
      assert.equal(seen[0].ok, false, "ack reports failure");
      assert.equal(seen[0].reason, "no-session");
      assert.equal(seen[0].targetUserId, "player1", "acked to the buyer");
      assert.equal(seen[0].commitId, "cx1", "correlates by commitId");
    }
    globalThis.game = savedInner;
  }

  /* COMMIT_SALE recompute: the GM ignores the client's claimed totalGp and
     re-derives the payout from the item snapshot, then spends merchant gold by
     the SERVER figure — so a buggy/forged client can't set the coffer wrong. */
  {
    clearAllSessions();
    const rec = openSession({ merchantId: "m-sell", viewerUserId: "player1" });
    let savedList = [
      {
        id: "m-sell",
        name: "Pawn",
        sellRatio: 0.5,
        goldOnHand: 1000,
        allowedUserIds: ["player1"],
        items: [],
      },
    ];
    const savedInner = globalThis.game;
    globalThis.game = {
      user: { id: "gm", isGM: true },
      users: { activeGM: { id: "gm" }, get: (id) => ({ id, name: id }) },
      settings: {
        get: () => savedList,
        set: (_m, _k, v) => {
          savedList = v;
        },
      },
      socket: { emit() {}, on() {} },
    };
    const acks = [];
    const off = subscribe(MERCHANT_EVENTS.COMMIT_RESULT, (p) => acks.push(p));
    await receiveMerchantPayload({
      type: MERCHANT_EVENTS.COMMIT_SALE,
      originUserId: "player1",
      sessionId: rec.sessionId,
      commitId: "cs1",
      itemUuid: "owned-item-id",
      qty: 1,
      totalGp: 9999, // forged/wrong — must be ignored
      itemSnapshot: {
        name: "Longsword",
        type: "weapon",
        system: { price: { value: 100, denomination: "gp" } },
      },
    });
    off();
    const merchant = savedList.find((m) => m.id === "m-sell");
    // base 100 gp × sellRatio 0.5 = 50 server payout → 1000 − 50 = 950 (NOT 0).
    assert.equal(
      merchant.goldOnHand,
      950,
      "merchant gold spent by the SERVER-recomputed payout, not the client's 9999",
    );
    assert.ok(
      acks.some((a) => a.commitId === "cs1" && a.ok === true),
      "a successful sale is acked ok:true",
    );
    globalThis.game = savedInner;
    clearAllSessions();
  }

  /* OVERSELL: a finite item with 1 in stock hit by a 2-unit buy (a concurrent
     buyer took the last unit) is REJECTED with ok:false reason:"out-of-stock"
     and the merchant's gold is left untouched — not charged for a phantom unit. */
  {
    clearAllSessions();
    const rec = openSession({ merchantId: "m-buy", viewerUserId: "player1" });
    let savedList = [
      {
        id: "m-buy",
        name: "Stall",
        goldOnHand: 100,
        allowedUserIds: ["player1"],
        items: [{ uuid: "Compendium.x.Item.last", qty: 1, unlimited: false }],
      },
    ];
    const savedInner = globalThis.game;
    globalThis.game = {
      user: { id: "gm", isGM: true },
      users: { activeGM: { id: "gm" }, get: (id) => ({ id, name: id }) },
      settings: {
        get: () => savedList,
        set: (_m, _k, v) => {
          savedList = v;
        },
      },
      socket: { emit() {}, on() {} },
    };
    const acks = [];
    const off = subscribe(MERCHANT_EVENTS.COMMIT_RESULT, (p) => acks.push(p));
    await receiveMerchantPayload({
      type: MERCHANT_EVENTS.COMMIT_PURCHASE,
      originUserId: "player1",
      sessionId: rec.sessionId,
      commitId: "co1",
      itemUuid: "Compendium.x.Item.last",
      qty: 2,
      totalGp: 10,
    });
    off();
    assert.ok(
      acks.some(
        (a) => a.commitId === "co1" && a.ok === false && a.reason === "out-of-stock",
      ),
      "an oversell is rejected with out-of-stock, not silently charged",
    );
    const merchant = savedList.find((m) => m.id === "m-buy");
    assert.equal(
      merchant.goldOnHand,
      100,
      "merchant gold is untouched on a rejected oversell",
    );
    globalThis.game = savedInner;
    clearAllSessions();
  }

  /* PAYLOAD VALIDATION: a COMMIT_PURCHASE missing its required sessionId is a
     malformed/forged frame and is dropped before any handler runs — no ack. */
  {
    clearAllSessions();
    const savedInner = globalThis.game;
    globalThis.game = {
      user: { id: "gm", isGM: true },
      users: { activeGM: { id: "gm" }, get: (id) => ({ id, name: id }) },
      socket: { emit() {}, on() {} },
    };
    const acks = [];
    const off = subscribe(MERCHANT_EVENTS.COMMIT_RESULT, (p) => acks.push(p));
    await receiveMerchantPayload({
      type: MERCHANT_EVENTS.COMMIT_PURCHASE,
      originUserId: "player1",
      commitId: "cbad",
      itemUuid: "Compendium.x.Item.y",
      qty: 1,
      // sessionId omitted → invalid shape
    });
    off();
    assert.equal(
      acks.length,
      0,
      "a malformed commit (no sessionId) is dropped, not acked",
    );
    globalThis.game = savedInner;
    clearAllSessions();
  }
} finally {
  if (savedGame === undefined) delete globalThis.game;
  else globalThis.game = savedGame;
}

process.stdout.write("merchant-socket validation passed\n");
