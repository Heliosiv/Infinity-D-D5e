import assert from "node:assert/strict";

import {
  MERCHANT_EVENTS,
  subscribe,
  emitMerchantEvent,
  receiveMerchantPayload,
  pushOpenSession,
  pushCloseSession,
  requestMerchantSessionResume,
} from "./merchant/socket.js";
import {
  openSession,
  getSession,
  clearAllSessions,
} from "./merchant/session-state.js";
import { formatMerchantCommitId } from "./merchant/transaction-ledger.js";
import { normalizeDowntimeConfig } from "./downtime/settlements.js";

/**
 * The socket receive→dispatch path is what makes a GM-pushed session pop on the
 * player's client (registerMerchantSessionAutoOpen subscribes to SESSION_OPEN).
 * It was previously untested; these lock in the behavior that a broken player
 * shop-open would violate.
 */

const savedGame = globalThis.game;

function makeTransactionActor(itemData = null) {
  const items = new Map();
  const actor = {
    id: "actor-player1",
    name: "Player One",
    type: "character",
    system: { currency: { pp: 0, gp: 1000, ep: 0, sp: 0, cp: 0 } },
    items: { get: (id) => items.get(id) ?? null },
    testUserPermission: (user) => user?.id === "player1",
    async update(changes) {
      for (const [path, value] of Object.entries(changes ?? {})) {
        const match = /^system\.currency\.(pp|gp|ep|sp|cp)$/.exec(path);
        if (match) this.system.currency[match[1]] = Number(value) || 0;
      }
      return this;
    },
    async createEmbeddedDocuments() {
      return [];
    },
    async deleteEmbeddedDocuments(_type, ids) {
      for (const id of ids) items.delete(id);
      return ids;
    },
  };
  if (itemData) {
    const item = {
      ...structuredClone(itemData),
      parent: actor,
      toObject() {
        return structuredClone(itemData);
      },
      async update(changes) {
        if ("system.quantity" in changes) {
          this.system.quantity = Number(changes["system.quantity"]);
        }
        return this;
      },
    };
    items.set(item.id, item);
  }
  return actor;
}

function actorAccess(actor) {
  return {
    users: {
      activeGM: { id: "gm", isGM: true },
      get: (id) => ({ id, name: id, active: true, character: actor }),
    },
    actors: {
      get: (id) => (id === actor.id ? actor : null),
      find: (predicate) => (predicate(actor) ? actor : null),
    },
  };
}

try {
  // Pretend to be the player "player1"; the socket emit is a no-op sink.
  const emitted = [];
  globalThis.game = {
    user: { id: "player1", isGM: false },
    users: { activeGM: { id: "gm", isGM: true } },
    socket: {
      emit: (name, payload, options) =>
        emitted.push({ name, payload, options }),
      on() {},
    },
  };

  /* A GM-originated SESSION_OPEN targeted at this user reaches subscribers. */
  {
    const seen = [];
    const off = subscribe(MERCHANT_EVENTS.SESSION_OPEN, (p) => seen.push(p));
    await receiveMerchantPayload(
      {
        type: MERCHANT_EVENTS.SESSION_OPEN,
        originUserId: "gm",
        targetUserId: "player1",
        sessionId: "s-1",
        merchantId: "m-1",
      },
      "gm",
    );
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
    await receiveMerchantPayload(
      {
        type: MERCHANT_EVENTS.SESSION_OPEN,
        originUserId: "player1", // same as game.user.id
        targetUserId: "player1",
        sessionId: "s-echo",
      },
      "player1",
    );
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
    const payload = emitMerchantEvent(MERCHANT_EVENTS.SHOP_LIST_REQUEST, {
      targetUserId: "someone-else",
    });
    off();
    assert.equal(seen.length, 1, "local subscriber sees the emitted event");
    assert.equal(payload.originUserId, "player1", "stamps the sender id");
    assert.equal(emitted.length, 1, "sends one socket frame");
    assert.equal(emitted[0].payload.type, MERCHANT_EVENTS.SHOP_LIST_REQUEST);
    assert.deepEqual(
      emitted[0].options,
      { recipients: ["gm"] },
      "player request is routed only to the authoritative GM",
    );
  }

  /* Defense in depth: even if transport routing is bypassed, a SESSION_OPEN
     aimed at a different user never reaches local subscribers. */
  {
    const seen = [];
    const off = subscribe(MERCHANT_EVENTS.SESSION_OPEN, (p) => seen.push(p));
    await receiveMerchantPayload(
      {
        type: MERCHANT_EVENTS.SESSION_OPEN,
        originUserId: "gm",
        targetUserId: "someone-else",
        sessionId: "s-2",
      },
      "gm",
    );
    off();
    assert.equal(
      seen.length,
      0,
      "receiver rejects a differently targeted frame",
    );
  }

  /* Transport identity is mandatory and must match any claimed origin. */
  {
    const seen = [];
    const off = subscribe(MERCHANT_EVENTS.SESSION_OPEN, (p) => seen.push(p));
    const frame = {
      type: MERCHANT_EVENTS.SESSION_OPEN,
      originUserId: "gm",
      targetUserId: "player1",
      sessionId: "s-auth",
    };
    await receiveMerchantPayload(frame);
    await receiveMerchantPayload(frame, "someone-else");
    await receiveMerchantPayload({ ...frame, targetUserId: null }, "gm");
    await receiveMerchantPayload(
      { ...frame, originUserId: "someone-else" },
      "someone-else",
    );
    off();
    assert.equal(
      seen.length,
      0,
      "missing or mismatched transport identity fails closed",
    );
  }

  /* pushOpenSession emits SESSION_OPEN for every ALLOWED target — including a
     player who holds an elevated (assistant-GM) role — and skips users who
     aren't on the merchant's allow-list. Regression: it used to drop any
     GM-role user, so an assistant-GM player silently received nothing. */
  {
    emitted.length = 0;
    const seen = [];
    const off = subscribe(MERCHANT_EVENTS.SESSION_OPEN, (p) => seen.push(p));
    const savedUser = globalThis.game.user;
    globalThis.game.user = { id: "gm", isGM: true };
    const merchant = {
      id: "m-shop",
      name: "Sundries",
      allowedUserIds: ["player1", "assistant-gm"],
      selfServiceMode: "open",
      chatHidden: true,
      pool: { mode: "secret-pool" },
      items: [
        {
          uuid: "Compendium.infinity-dnd5e.items.Item.safe",
          qty: 2,
          startingQty: 9,
          notes: "GM only",
        },
      ],
    };
    const opened = pushOpenSession({
      merchant,
      targetUserIds: ["player1", "assistant-gm", "stranger"],
    });
    globalThis.game.user = savedUser;
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
    assert.deepEqual(
      emitted.map((entry) => entry.options?.recipients),
      [["player1"], ["assistant-gm"]],
      "each open is transport-scoped to its intended viewer",
    );
    assert.ok(
      seen.every(
        ({ merchant: projection }) =>
          !("allowedUserIds" in projection) &&
          !("selfServiceMode" in projection) &&
          !("chatHidden" in projection) &&
          !("pool" in projection) &&
          !("startingQty" in projection.items[0]) &&
          !("notes" in projection.items[0]),
      ),
      "session opens carry only the player-safe merchant projection",
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
      "resume request is sent to the GM",
    );
    assert.deepEqual(emitted.at(-1)?.options, { recipients: ["gm"] });

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
        activeGM: { id: "gm", isGM: true },
        get: (id) => ({ id, active: true, isGM: false, name: id }),
      },
      settings: { get: () => merchants },
      socket: { emit() {}, on() {} },
    };
    const seen = [];
    const off = subscribe(MERCHANT_EVENTS.SESSION_OPEN, (p) => seen.push(p));
    await receiveMerchantPayload(
      {
        type: MERCHANT_EVENTS.SESSION_RESUME_REQUEST,
        originUserId: "player1",
      },
      "player1",
    );
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

  /* SESSION_CLOSE is duplex but never ambiguous: a player may close only their
     own recorded session, while a GM-forced close is delivered only to that
     session's viewer. */
  {
    clearAllSessions();
    const savedInner = globalThis.game;
    const closeEmitted = [];
    globalThis.game = {
      user: { id: "gm", isGM: true },
      users: {
        activeGM: { id: "gm", isGM: true },
        get: (id) => ({ id, active: true, isGM: id === "gm" }),
      },
      socket: {
        emit: (name, payload, options) =>
          closeEmitted.push({ name, payload, options }),
        on() {},
      },
    };

    const voluntary = openSession({
      merchantId: "m-close",
      viewerUserId: "player1",
    });
    await receiveMerchantPayload(
      {
        type: MERCHANT_EVENTS.SESSION_CLOSE,
        originUserId: "player1",
        targetUserId: "player1",
        sessionId: voluntary.sessionId,
      },
      "player1",
    );
    assert.equal(
      getSession(voluntary.sessionId),
      null,
      "player close removes that player's session",
    );

    const forced = openSession({
      merchantId: "m-close",
      viewerUserId: "player1",
    });
    await receiveMerchantPayload(
      {
        type: MERCHANT_EVENTS.SESSION_CLOSE,
        originUserId: "player1",
        targetUserId: "player2",
        sessionId: forced.sessionId,
      },
      "player1",
    );
    assert.ok(
      getSession(forced.sessionId),
      "a player cannot close a session under another claimed target",
    );

    assert.equal(pushCloseSession(forced.sessionId), true);
    const forcedFrame = closeEmitted.at(-1);
    assert.deepEqual(
      forcedFrame?.options,
      { recipients: ["player1"] },
      "GM close is transport-scoped to the viewer",
    );

    globalThis.game = savedInner;
    const intended = [];
    const offIntended = subscribe(MERCHANT_EVENTS.SESSION_CLOSE, (payload) =>
      intended.push(payload),
    );
    await receiveMerchantPayload(forcedFrame.payload, "gm");
    offIntended();
    assert.equal(intended.length, 1, "intended viewer receives the GM close");

    globalThis.game = {
      ...savedInner,
      user: { id: "player2", isGM: false },
    };
    const bystander = [];
    const offBystander = subscribe(MERCHANT_EVENTS.SESSION_CLOSE, (payload) =>
      bystander.push(payload),
    );
    await receiveMerchantPayload(forcedFrame.payload, "gm");
    offBystander();
    assert.equal(bystander.length, 0, "bystander rejects the GM close");

    globalThis.game = savedInner;
    clearAllSessions();
  }

  /* Authenticated shop/session control frames share one generous ingress
     budget before listener dispatch or response-producing work. Durable
     status/replay and SESSION_CLOSE remain available after that budget fills. */
  {
    clearAllSessions();
    const savedInner = globalThis.game;
    const savedConst = globalThis.CONST;
    globalThis.CONST = { USER_ROLES: { GAMEMASTER: 4 } };
    const savedNow = Date.now;
    let now = 50_000;
    Date.now = () => now;
    const merchants = [
      {
        id: "m-control",
        name: "Control Shop",
        allowedUserIds: ["control-player", "control-peer"],
        selfServiceMode: "open",
        items: [],
      },
    ];
    globalThis.game = {
      user: { id: "gm", isGM: true, role: 4 },
      users: {
        activeGM: { id: "gm", isGM: true, role: 4 },
        get: (id) => ({
          id,
          active: true,
          isGM: false,
          role: 1,
          name: id,
        }),
      },
      settings: {
        get: (_moduleId, key) => (key === "merchants" ? merchants : undefined),
      },
      socket: { emit() {}, on() {} },
    };

    const savedWarn = console.warn;
    let malformedWarnings = 0;
    let malformedStatusWarnings = 0;
    let malformedCloseWarnings = 0;
    console.warn = (...args) => {
      const message = String(args[0] ?? "");
      if (message.includes("dropped malformed merchant:shop-request")) {
        malformedWarnings += 1;
        return;
      }
      if (
        message.includes("dropped malformed merchant:commit-status-request")
      ) {
        malformedStatusWarnings += 1;
        return;
      }
      if (message.includes("dropped malformed merchant:session-close")) {
        malformedCloseWarnings += 1;
        return;
      }
      savedWarn(...args);
    };
    for (let index = 0; index < 25; index++) {
      await receiveMerchantPayload(
        {
          type: MERCHANT_EVENTS.SHOP_REQUEST,
          originUserId: "malformed-control",
          merchantId: "x".repeat(201),
        },
        "malformed-control",
      );
    }
    for (let index = 0; index < 45; index++) {
      await receiveMerchantPayload(
        {
          type: MERCHANT_EVENTS.COMMIT_STATUS_REQUEST,
          originUserId: "malformed-status",
          commitId: "missing-fingerprint",
        },
        "malformed-status",
      );
      await receiveMerchantPayload(
        {
          type: MERCHANT_EVENTS.SESSION_CLOSE,
          originUserId: "malformed-close",
          targetUserId: "malformed-close",
          sessionId: "x".repeat(201),
        },
        "malformed-close",
      );
    }
    console.warn = savedWarn;
    assert.equal(
      malformedWarnings,
      20,
      "malformed control frames share the bounded audit budget",
    );
    assert.equal(malformedStatusWarnings, 40);
    assert.equal(malformedCloseWarnings, 20);

    const seenControl = [];
    const offList = subscribe(MERCHANT_EVENTS.SHOP_LIST_REQUEST, (payload) =>
      seenControl.push(payload),
    );
    const offResume = subscribe(
      MERCHANT_EVENTS.SESSION_RESUME_REQUEST,
      (payload) => seenControl.push(payload),
    );
    for (let index = 0; index < 19; index++) {
      await receiveMerchantPayload(
        {
          type: MERCHANT_EVENTS.SHOP_LIST_REQUEST,
          originUserId: "control-player",
        },
        "control-player",
      );
    }
    await receiveMerchantPayload(
      {
        type: MERCHANT_EVENTS.SESSION_RESUME_REQUEST,
        originUserId: "control-player",
      },
      "control-player",
    );
    await receiveMerchantPayload(
      {
        type: MERCHANT_EVENTS.SHOP_LIST_REQUEST,
        originUserId: "control-player",
      },
      "control-player",
    );
    assert.equal(
      seenControl.length,
      20,
      "mixed control routes share one burst budget and the next frame is dropped before dispatch",
    );

    await receiveMerchantPayload(
      {
        type: MERCHANT_EVENTS.SHOP_LIST_REQUEST,
        originUserId: "control-peer",
      },
      "control-peer",
    );
    assert.equal(
      seenControl.length,
      21,
      "one player's control burst does not affect another player",
    );

    const statusSeen = [];
    const offStatus = subscribe(
      MERCHANT_EVENTS.COMMIT_STATUS_REQUEST,
      (payload) => statusSeen.push(payload),
    );
    await receiveMerchantPayload(
      {
        type: MERCHANT_EVENTS.COMMIT_STATUS_REQUEST,
        originUserId: "control-player",
        commitId: formatMerchantCommitId(
          50_000,
          "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        ),
        requestFingerprint: "control-status",
      },
      "control-player",
    );
    assert.equal(
      statusSeen.length,
      1,
      "durable status recovery is independent of the shop control budget",
    );

    const closeable = openSession({
      merchantId: "m-control",
      viewerUserId: "control-player",
    });
    await receiveMerchantPayload(
      {
        type: MERCHANT_EVENTS.SESSION_CLOSE,
        originUserId: "control-player",
        targetUserId: "control-player",
        sessionId: closeable.sessionId,
      },
      "control-player",
    );
    assert.equal(
      getSession(closeable.sessionId),
      null,
      "SESSION_CLOSE remains deliverable after control throttling",
    );

    now += 10_001;
    await receiveMerchantPayload(
      {
        type: MERCHANT_EVENTS.SHOP_LIST_REQUEST,
        originUserId: "control-player",
      },
      "control-player",
    );
    assert.equal(
      seenControl.length,
      22,
      "the same player can retry after the short burst window",
    );

    offList();
    offResume();
    offStatus();
    Date.now = savedNow;
    globalThis.game = savedInner;
    if (savedConst === undefined) delete globalThis.CONST;
    else globalThis.CONST = savedConst;
    clearAllSessions();
  }

  /* Foundry marks role-3 Assistants as isGM, but only full role-4 GMs are
     preview-only. An explicitly allowed Assistant sees and opens the player
     shop; a full GM does neither. */
  {
    clearAllSessions();
    const savedInner = globalThis.game;
    const savedConst = globalThis.CONST;
    globalThis.CONST = { USER_ROLES: { GAMEMASTER: 4 } };
    const assistant = {
      id: "assistant-shop",
      active: true,
      isGM: true,
      role: 3,
      name: "Assistant",
    };
    const fullGm = {
      id: "full-shop",
      active: true,
      isGM: true,
      role: 4,
      name: "Full GM",
    };
    const authority = {
      id: "gm",
      active: true,
      isGM: true,
      role: 4,
      name: "Authority",
    };
    const usersById = new Map([
      [assistant.id, assistant],
      [fullGm.id, fullGm],
      [authority.id, authority],
    ]);
    const shops = [
      {
        id: "assistant-shop-merchant",
        name: "Assistant Shop",
        allowedUserIds: [assistant.id, fullGm.id],
        selfServiceMode: "open",
        items: [],
      },
    ];
    globalThis.game = {
      user: authority,
      users: {
        activeGM: authority,
        get: (id) => usersById.get(id) ?? null,
      },
      settings: {
        get: (_moduleId, key) => (key === "merchants" ? shops : undefined),
      },
      socket: { emit() {}, on() {} },
    };
    const listReplies = [];
    const sessionOpens = [];
    const offLists = subscribe(MERCHANT_EVENTS.SHOP_LIST_REPLY, (payload) =>
      listReplies.push(payload),
    );
    const offOpens = subscribe(MERCHANT_EVENTS.SESSION_OPEN, (payload) =>
      sessionOpens.push(payload),
    );
    await receiveMerchantPayload(
      {
        type: MERCHANT_EVENTS.SHOP_LIST_REQUEST,
        originUserId: assistant.id,
      },
      assistant.id,
    );
    await receiveMerchantPayload(
      {
        type: MERCHANT_EVENTS.SHOP_REQUEST,
        originUserId: assistant.id,
        merchantId: shops[0].id,
      },
      assistant.id,
    );
    await receiveMerchantPayload(
      {
        type: MERCHANT_EVENTS.SHOP_LIST_REQUEST,
        originUserId: fullGm.id,
      },
      fullGm.id,
    );
    await receiveMerchantPayload(
      {
        type: MERCHANT_EVENTS.SHOP_REQUEST,
        originUserId: fullGm.id,
        merchantId: shops[0].id,
      },
      fullGm.id,
    );
    offLists();
    offOpens();
    assert.deepEqual(
      listReplies.map((reply) => reply.targetUserId),
      [assistant.id],
      "the allowed Assistant receives a player shop list while a full GM does not",
    );
    assert.equal(listReplies[0].shops.length, 1);
    assert.deepEqual(
      sessionOpens.map((frame) => frame.targetUserId),
      [assistant.id],
      "the allowed Assistant can self-open while a full GM remains preview-only",
    );
    globalThis.game = savedInner;
    if (savedConst === undefined) delete globalThis.CONST;
    else globalThis.CONST = savedConst;
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
      ...actorAccess(makeTransactionActor()),
      socket: { emit() {}, on() {} },
    };
    for (const type of [
      MERCHANT_EVENTS.COMMIT_PURCHASE,
      MERCHANT_EVENTS.COMMIT_SALE,
    ]) {
      const seen = [];
      const off = subscribe(MERCHANT_EVENTS.COMMIT_RESULT, (p) => seen.push(p));
      await receiveMerchantPayload(
        {
          type,
          originUserId: "player1",
          sessionId: "ghost-session",
          commitId: "cx1",
          itemUuid: "Compendium.x.Item.y",
          qty: 1,
          totalGp: 5,
        },
        "player1",
      );
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
    const actor = makeTransactionActor({
      id: "owned-item-id",
      name: "Longsword",
      type: "weapon",
      system: { quantity: 1, price: { value: 100, denomination: "gp" } },
      flags: {},
    });
    globalThis.game = {
      user: { id: "gm", isGM: true },
      ...actorAccess(actor),
      settings: {
        get: (_moduleId, key) => (key === "merchants" ? savedList : undefined),
        set: (_moduleId, key, value) => {
          if (key === "merchants") savedList = value;
          return value;
        },
      },
      socket: { emit() {}, on() {} },
    };
    const acks = [];
    const off = subscribe(MERCHANT_EVENTS.COMMIT_RESULT, (p) => acks.push(p));
    await receiveMerchantPayload(
      {
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
      },
      "player1",
    );
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

  /* Private issuance is authoritative even if an Actor owner strips the
     visible stolen flag before attempting an ordinary merchant sale. */
  {
    clearAllSessions();
    const rec = openSession({
      merchantId: "m-ledger-sell",
      viewerUserId: "player1",
    });
    let savedList = [
      {
        id: "m-ledger-sell",
        name: "Pawn",
        sellRatio: 0.5,
        goldOnHand: 100,
        allowedUserIds: ["player1"],
        items: [],
      },
    ];
    const actor = makeTransactionActor({
      id: "issued-stolen-item",
      name: "Silver Ring",
      type: "loot",
      system: { quantity: 1, price: { value: 10, denomination: "gp" } },
      flags: {},
    });
    const downtimeConfig = normalizeDowntimeConfig({
      settlements: [],
      heat: {},
      stolenGoods: {
        "issued-stolen-item": {
          itemId: "issued-stolen-item",
          actorId: actor.id,
          operationId: "theft-ledger-operation",
          provenance: {
            settlementId: "greyhaven",
            targetType: "generated-mark",
            sourceId: "mark-ledger",
            merchantId: null,
            operationId: "theft-ledger-operation",
            timestamp: 1_000,
            appraisedValueCp: 1_000,
          },
          state: "issued",
          issuedAt: 1_000,
          consumedByOperationId: null,
          consumedAt: 0,
        },
      },
    });
    const savedInner = globalThis.game;
    globalThis.game = {
      user: { id: "gm", isGM: true },
      ...actorAccess(actor),
      settings: {
        get: (_moduleId, key) => {
          if (key === "merchants") return savedList;
          if (key === "downtimeConfig") return downtimeConfig;
          return undefined;
        },
        set: (_moduleId, key, value) => {
          if (key === "merchants") savedList = value;
          return value;
        },
      },
      socket: { emit() {}, on() {} },
    };
    const acks = [];
    const off = subscribe(MERCHANT_EVENTS.COMMIT_RESULT, (payload) =>
      acks.push(payload),
    );
    await receiveMerchantPayload(
      {
        type: MERCHANT_EVENTS.COMMIT_SALE,
        originUserId: "player1",
        sessionId: rec.sessionId,
        commitId: "issued-sale-attempt",
        itemUuid: "issued-stolen-item",
        qty: 1,
        totalGp: 5,
      },
      "player1",
    );
    assert.ok(
      acks.some(
        (ack) =>
          ack.commitId === "issued-sale-attempt" &&
          ack.ok === false &&
          ack.reason === "stolen-requires-fence",
      ),
      "the GM rejects a stripped-flag item that remains active in the private issuance ledger",
    );
    downtimeConfig.stolenGoods["issued-stolen-item"] = {
      ...downtimeConfig.stolenGoods["issued-stolen-item"],
      state: "consumed",
      consumedByOperationId: "fence-operation",
      consumedAt: 2_000,
    };
    await receiveMerchantPayload(
      {
        type: MERCHANT_EVENTS.COMMIT_SALE,
        originUserId: "player1",
        sessionId: rec.sessionId,
        commitId: "consumed-id-sale-attempt",
        itemUuid: "issued-stolen-item",
        qty: 1,
        totalGp: 5,
      },
      "player1",
    );
    off();
    assert.ok(
      acks.some(
        (ack) =>
          ack.commitId === "consumed-id-sale-attempt" &&
          ack.ok === false &&
          ack.reason === "stolen-requires-fence",
      ),
      "the GM also rejects a recreated item whose deterministic ID was already consumed by fencing",
    );
    assert.ok(actor.items.get("issued-stolen-item"));
    assert.equal(savedList[0].goldOnHand, 100);
    globalThis.game = savedInner;
    clearAllSessions();
  }

  /* A stale assigned-character pointer cannot bypass an explicit ownership
     downgrade when a player omits actorId from a forged sale frame. */
  {
    clearAllSessions();
    const rec = openSession({
      merchantId: "m-stale-character",
      viewerUserId: "player1",
    });
    let savedList = [
      {
        id: "m-stale-character",
        name: "Pawn",
        sellRatio: 0.5,
        goldOnHand: 100,
        allowedUserIds: ["player1"],
        items: [],
      },
    ];
    const actor = makeTransactionActor({
      id: "stale-owned-item",
      name: "Longsword",
      type: "weapon",
      system: { quantity: 1, price: { value: 10, denomination: "gp" } },
      flags: {},
    });
    actor.ownership = { player1: 0 };
    actor.testUserPermission = () => true;
    const savedInner = globalThis.game;
    globalThis.game = {
      user: { id: "gm", isGM: true },
      ...actorAccess(actor),
      settings: {
        get: (_moduleId, key) => (key === "merchants" ? savedList : undefined),
        set: (_moduleId, key, value) => {
          if (key === "merchants") savedList = value;
          return value;
        },
      },
      socket: { emit() {}, on() {} },
    };
    const acks = [];
    const off = subscribe(MERCHANT_EVENTS.COMMIT_RESULT, (payload) =>
      acks.push(payload),
    );
    await receiveMerchantPayload(
      {
        type: MERCHANT_EVENTS.COMMIT_SALE,
        originUserId: "player1",
        sessionId: rec.sessionId,
        commitId: "stale-character-sale",
        itemUuid: "stale-owned-item",
        qty: 1,
        totalGp: 5,
      },
      "player1",
    );
    actor.ownership = { default: 0 };
    actor.testUserPermission = () => false;
    await receiveMerchantPayload(
      {
        type: MERCHANT_EVENTS.COMMIT_SALE,
        originUserId: "player1",
        sessionId: rec.sessionId,
        commitId: "assigned-default-none-sale",
        itemUuid: "stale-owned-item",
        qty: 1,
        totalGp: 5,
      },
      "player1",
    );
    off();
    assert.ok(
      acks.some(
        (ack) =>
          ack.commitId === "stale-character-sale" &&
          ack.ok === false &&
          ack.reason === "no-actor",
      ),
    );
    assert.ok(actor.items.get("stale-owned-item"));
    assert.equal(savedList[0].goldOnHand, 100);
    assert.ok(
      acks.some(
        (ack) =>
          ack.commitId === "assigned-default-none-sale" &&
          ack.ok === false &&
          ack.reason === "no-actor",
      ),
      "an assigned-character pointer does not override default NONE ownership",
    );
    globalThis.game = savedInner;
    clearAllSessions();
  }

  /* Assistant GM role permissions must not turn every character into a valid
     self-service shop Actor when that character is not assigned or owned. */
  {
    clearAllSessions();
    const rec = openSession({
      merchantId: "m-assistant-boundary",
      viewerUserId: "assistant-gm",
    });
    const actor = makeTransactionActor({
      id: "assistant-target-item",
      name: "Longsword",
      type: "weapon",
      system: { quantity: 1, price: { value: 10, denomination: "gp" } },
      flags: {},
    });
    actor.ownership = { default: 0 };
    actor.testUserPermission = () => true;
    const assistant = {
      id: "assistant-gm",
      isGM: true,
      role: 3,
      active: true,
      character: null,
    };
    const gm = { id: "gm", isGM: true, role: 4, active: true };
    const users = new Map([
      [gm.id, gm],
      [assistant.id, assistant],
    ]);
    users.activeGM = gm;
    const savedInner = globalThis.game;
    const savedConst = globalThis.CONST;
    globalThis.CONST = {
      USER_ROLES: { GAMEMASTER: 4 },
      DOCUMENT_OWNERSHIP_LEVELS: { OWNER: 3 },
    };
    globalThis.game = {
      user: gm,
      users,
      actors: {
        get: (id) => (id === actor.id ? actor : null),
        find: (predicate) => (predicate(actor) ? actor : null),
      },
      settings: {
        get: (_moduleId, key) =>
          key === "merchants"
            ? [
                {
                  id: "m-assistant-boundary",
                  name: "Pawn",
                  sellRatio: 0.5,
                  goldOnHand: 100,
                  allowedUserIds: [assistant.id],
                  items: [],
                },
              ]
            : undefined,
      },
      socket: { emit() {}, on() {} },
    };
    const acks = [];
    const off = subscribe(MERCHANT_EVENTS.COMMIT_RESULT, (payload) =>
      acks.push(payload),
    );
    await receiveMerchantPayload(
      {
        type: MERCHANT_EVENTS.COMMIT_SALE,
        originUserId: assistant.id,
        sessionId: rec.sessionId,
        commitId: "assistant-unowned-sale",
        actorId: actor.id,
        itemUuid: "assistant-target-item",
        qty: 1,
        totalGp: 5,
      },
      assistant.id,
    );
    off();
    assert.ok(
      acks.some(
        (ack) =>
          ack.commitId === "assistant-unowned-sale" &&
          ack.ok === false &&
          ack.reason === "no-actor",
      ),
    );
    assert.ok(actor.items.get("assistant-target-item"));
    globalThis.game = savedInner;
    if (savedConst === undefined) delete globalThis.CONST;
    else globalThis.CONST = savedConst;
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
      ...actorAccess(makeTransactionActor()),
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
    await receiveMerchantPayload(
      {
        type: MERCHANT_EVENTS.COMMIT_PURCHASE,
        originUserId: "player1",
        sessionId: rec.sessionId,
        commitId: "co1",
        itemUuid: "Compendium.x.Item.last",
        qty: 2,
        totalGp: 10,
      },
      "player1",
    );
    off();
    assert.ok(
      acks.some(
        (a) =>
          a.commitId === "co1" && a.ok === false && a.reason === "out-of-stock",
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
      ...actorAccess(makeTransactionActor()),
      socket: { emit() {}, on() {} },
    };
    const acks = [];
    const off = subscribe(MERCHANT_EVENTS.COMMIT_RESULT, (p) => acks.push(p));
    await receiveMerchantPayload(
      {
        type: MERCHANT_EVENTS.COMMIT_PURCHASE,
        originUserId: "player1",
        commitId: "cbad",
        itemUuid: "Compendium.x.Item.y",
        qty: 1,
        // sessionId omitted → invalid shape
      },
      "player1",
    );
    off();
    assert.equal(
      acks.length,
      0,
      "a malformed commit (no sessionId) is dropped, not acked",
    );
    globalThis.game = savedInner;
    clearAllSessions();
  }

  /* COMMIT_SALE with no usable snapshot: the GM can't derive a server price, so
     it must REJECT (no-price) rather than debit the coffer by the client's
     claimed total. Regression: it used to fall back to the client figure and a
     forged 9999 would drain a finite-gold merchant to 0. */
  {
    clearAllSessions();
    const rec = openSession({ merchantId: "m-sell2", viewerUserId: "player1" });
    let savedList = [
      {
        id: "m-sell2",
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
      ...actorAccess(makeTransactionActor()),
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
    await receiveMerchantPayload(
      {
        type: MERCHANT_EVENTS.COMMIT_SALE,
        originUserId: "player1",
        sessionId: rec.sessionId,
        commitId: "cs2",
        itemUuid: "owned-item-id",
        qty: 1,
        totalGp: 9999, // forged — no snapshot to recompute against
        // itemSnapshot deliberately omitted
      },
      "player1",
    );
    off();
    const merchant = savedList.find((m) => m.id === "m-sell2");
    assert.equal(
      merchant.goldOnHand,
      1000,
      "coffer untouched when the server can't price the sale (no client fallback)",
    );
    assert.ok(
      acks.some(
        (a) =>
          a.commitId === "cs2" && a.ok === false && a.reason === "no-target",
      ),
      "a sale for a non-owned item is rejected with reason no-target",
    );
    globalThis.game = savedInner;
    clearAllSessions();
  }

  /* COMMIT_PURCHASE never credits the coffer by the client's claimed total when
     the server can't derive a price (here `fromUuid` is absent so the reprice
     throws → server total 0). A forged 9999 must NOT inflate the merchant gold. */
  {
    clearAllSessions();
    const rec = openSession({ merchantId: "m-buy", viewerUserId: "player1" });
    let savedList = [
      {
        id: "m-buy",
        name: "Shop",
        goldOnHand: 100,
        allowedUserIds: ["player1"],
        items: [
          {
            uuid: "Compendium.x.Item.free",
            unlimited: true,
            priceOverrideGp: 0,
          },
        ],
      },
    ];
    const savedInner = globalThis.game;
    globalThis.game = {
      user: { id: "gm", isGM: true },
      ...actorAccess(makeTransactionActor()),
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
    await receiveMerchantPayload(
      {
        type: MERCHANT_EVENTS.COMMIT_PURCHASE,
        originUserId: "player1",
        sessionId: rec.sessionId,
        commitId: "cb1",
        itemUuid: "Compendium.x.Item.free",
        qty: 1,
        totalGp: 9999, // forged — must not be credited to the coffer
      },
      "player1",
    );
    off();
    const merchant = savedList.find((m) => m.id === "m-buy");
    assert.equal(
      merchant.goldOnHand,
      100,
      "coffer not inflated by the client's claimed total when server price is 0",
    );
    globalThis.game = savedInner;
    clearAllSessions();
  }
} finally {
  if (savedGame === undefined) delete globalThis.game;
  else globalThis.game = savedGame;
}

process.stdout.write("merchant-socket validation passed\n");
