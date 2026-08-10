import assert from "node:assert/strict";

/**
 * Multi-client socket ECONOMY integration harness.
 *
 * The existing test-merchant-socket.mjs covers routing (echo-suppression,
 * targeting, resume, malformed-frame rejection). This file covers the
 * money-moving COMMIT loop end-to-end by wiring a *fake transport* between
 * simulated GM and player clients: a player `emit()` is recipient-routed into
 * the GM's real `receiveMerchantPayload`, which runs the REAL handlers
 * (handleCommitPurchase / handleCommitSale / handleBargainResult), the REAL
 * per-merchant mutex, and the REAL store reducers (decrementInventory,
 * adjustMerchantGold, normalizeMerchant, upsertMerchant). Only the socket
 * transport and the Foundry game/actors/settings/fromUuid globals are mocked —
 * the handlers and pricing are the production code, so this exercises the
 * commit loop, not a re-implementation of it.
 *
 * Invariants asserted:
 *  - buy commit converges: the player's session view receives the exact
 *    player-safe projection of the GM record, while a bystander sees no frame;
 *  - no double-charge / no oversell when two buys race the last unit (mutex);
 *  - one actor cannot spend the same wallet balance concurrently at two shops;
 *  - a GM edit racing a player purchase loses neither write (mutex, no
 *    lost-update);
 *  - the authoritative-GM lowest-id tiebreaker means a two-GM table decrements
 *    stock exactly once, not twice;
 *  - bargain seals land on the correct side of the ledger (a success seal makes
 *    the buyer pay less / the seller receive more) and are burned after one use.
 */

import {
  MERCHANT_EVENTS,
  emitMerchantEvent,
  receiveMerchantPayload,
  commitMerchantWrite,
} from "./merchant/socket.js";
import {
  openSession,
  closeSession,
  clearAllSessions,
} from "./merchant/session-state.js";
import {
  MERCHANT_SETTING_KEY,
  findMerchant,
  normalizeMerchant,
  upsertMerchant,
} from "./merchant/store.js";
import { projectMerchantForSession } from "./merchant/projection.js";

/* ------------------------------------------------------------------ *
 * Fake transport + world fixture
 * ------------------------------------------------------------------ */

const savedGame = globalThis.game;
const savedUi = globalThis.ui;
const savedFromUuid = globalThis.fromUuid;

/** A world-scoped in-memory MERCHANTS setting, shared by every client in a
 *  world (mirrors Foundry's world-scoped setting all clients can read). */
function makeWorld(merchants = []) {
  let store = merchants.map(normalizeMerchant);
  let failAfterNextSet = false;
  let alterNextSet = false;
  return {
    get: (_module, key) => (key === MERCHANT_SETTING_KEY ? store : undefined),
    set: (_module, key, value) => {
      if (key === MERCHANT_SETTING_KEY) {
        store = structuredClone(value);
        if (alterNextSet) {
          alterNextSet = false;
          store[0].goldOnHand = Number(store[0].goldOnHand ?? 0) + 1;
        }
      }
      if (failAfterNextSet) {
        failAfterNextSet = false;
        throw new Error("injected apply-then-throw setting failure");
      }
    },
    failNextSetAfterApply() {
      failAfterNextSet = true;
    },
    alterNextSet() {
      alterNextSet = true;
    },
  };
}

function makeUserDirectory({
  activeGMId = "gm",
  users = [
    { id: "gm", isGM: true, active: true, name: "GM" },
    { id: "p1", isGM: false, active: true, name: "p1" },
    { id: "p2", isGM: false, active: true, name: "p2" },
  ],
} = {}) {
  const records = new Map(
    users.map((user) => [
      user.id,
      {
        active: true,
        isGM: false,
        name: user.id,
        ...user,
      },
    ]),
  );
  return {
    get activeGM() {
      return activeGMId ? (records.get(activeGMId) ?? null) : null;
    },
    get: (id) => records.get(id) ?? null,
    forEach: (callback) => records.forEach(callback),
    filter: (predicate) => [...records.values()].filter(predicate),
  };
}

/** A recipient-aware wire matching Foundry's scoped socket transport. */
function makeWire(users = makeUserDirectory()) {
  const clients = new Map();
  const log = [];
  let failNextType = null;
  return {
    users,
    register(client) {
      clients.set(client.id, client);
    },
    failNext(type) {
      failNextType = type;
    },
    deliver(fromId, name, payload, options = {}) {
      if (failNextType === payload?.type) {
        failNextType = null;
        throw new Error(`injected ${payload.type} transport failure`);
      }
      const recipientIds = Array.isArray(options?.recipients)
        ? new Set(options.recipients.map(String))
        : null;
      const deliveredTo = [];
      for (const [id, client] of clients) {
        if (id === fromId) continue;
        if (recipientIds && !recipientIds.has(id)) continue;
        client.inbox.push(payload);
        deliveredTo.push(id);
      }
      log.push({ fromId, name, payload, options, deliveredTo });
    },
    log,
  };
}

let embeddedSeed = 0;

function makeOwnedItem(actor, data) {
  const item = {
    ...structuredClone(data),
    id: data.id,
    parent: actor,
    toObject() {
      return structuredClone({
        ...data,
        id: this.id,
        system: this.system,
      });
    },
    async update(changes) {
      if ("system.quantity" in changes) {
        this.system.quantity = Number(changes["system.quantity"]);
      }
      return this;
    },
  };
  return item;
}

function makeActor(ownerId) {
  const itemMap = new Map();
  const actor = {
    id: `actor-${ownerId}`,
    name: `${ownerId} Hero`,
    type: "character",
    system: { currency: { pp: 0, gp: 10000, ep: 0, sp: 0, cp: 0 } },
    items: {
      get: (id) => itemMap.get(id) ?? null,
      get contents() {
        return [...itemMap.values()];
      },
    },
    testUserPermission: (user) => user?.id === ownerId,
    async rollSkill() {
      this.rollCalls = (this.rollCalls ?? 0) + 1;
      return { total: 25 };
    },
    async update(changes) {
      for (const [path, value] of Object.entries(changes ?? {})) {
        const match = /^system\.currency\.(pp|gp|ep|sp|cp)$/.exec(path);
        if (match) this.system.currency[match[1]] = Number(value) || 0;
      }
      return this;
    },
    async createEmbeddedDocuments(_type, snapshots) {
      return snapshots.map((snapshot) => {
        const id = snapshot._id ?? `created-${++embeddedSeed}`;
        const item = makeOwnedItem(actor, {
          ...structuredClone(snapshot),
          id,
          system: structuredClone(snapshot.system ?? {}),
        });
        itemMap.set(id, item);
        return item;
      });
    },
    async deleteEmbeddedDocuments(_type, ids) {
      const deleted = [];
      for (const id of ids) {
        const item = itemMap.get(id);
        if (item) deleted.push(item);
        itemMap.delete(id);
      }
      return deleted;
    },
  };
  const sword = makeOwnedItem(actor, {
    id: "owned-sword",
    name: "Longsword",
    type: "weapon",
    system: {
      quantity: 10,
      price: { value: 100, denomination: "gp" },
    },
    flags: {},
  });
  itemMap.set(sword.id, sword);
  return actor;
}

/**
 * Build a client context. Every client on a wire shares the same authoritative
 * world-user directory; callers can still override actors for focused cases.
 */
function makeClient({ id, isGM, world, wire, users, actors }) {
  const actorList = [makeActor("p1"), makeActor("p2")];
  const actorCollection = actors ?? {
    get: (actorId) => actorList.find((actor) => actor.id === actorId) ?? null,
    find: (predicate) => actorList.find(predicate) ?? null,
  };
  const client = {
    id,
    inbox: [],
    actors: actorCollection,
    game: {
      user: { id, isGM: Boolean(isGM) },
      users: users ?? wire.users,
      actors: actorCollection,
      settings: world,
      socket: {
        emit: (name, payload, options) =>
          wire.deliver(id, name, payload, options),
        on() {},
      },
    },
  };
  wire.register(client);
  return client;
}

/** Run `fn` synchronously with `globalThis.game` swapped to a client. */
function asClient(client, fn) {
  const prev = globalThis.game;
  globalThis.game = client.game;
  try {
    return fn();
  } finally {
    globalThis.game = prev;
  }
}

const lastOf = (inbox, type) =>
  [...inbox].reverse().find((p) => p.type === type) ?? null;
const allOf = (inbox, type) => inbox.filter((p) => p.type === type);

/** A dnd5e-ish item snapshot the GM's fromUuid returns for repricing. */
function makeItem(uuid, gpValue, { name = "Test Item", type = "loot" } = {}) {
  return {
    _uuid: uuid,
    name,
    type,
    system: { price: { value: gpValue, denomination: "gp" }, quantity: 1 },
  };
}

/** Base merchant with passive haggle OFF so seal/base math is unambiguous. */
function makeMerchant(overrides = {}) {
  return normalizeMerchant({
    id: "m-1",
    name: "Test Stall",
    defaultMarkup: 1.0,
    sellRatio: 0.5,
    bargainDC: 15,
    bargainSuccessPct: 10,
    bargainFailPct: 10,
    passiveHaggle: false,
    goldOnHand: 500,
    allowedUserIds: ["p1", "p2"],
    selfServiceMode: "open",
    items: [],
    ...overrides,
  });
}

let passed = 0;
function ok(label) {
  passed += 1;
  process.stdout.write(`  ✓ ${label}\n`);
}

try {
  globalThis.ui = {
    notifications: { info() {}, warn() {}, error() {} },
  };

  /* ============================================================== *
   * 1. Buy commit end-to-end: convergence + ack
   * ============================================================== */
  {
    clearAllSessions();
    const wire = makeWire();
    const item = makeItem("Compendium.x.Item.sword", 100);
    globalThis.fromUuid = async (uuid) => (uuid === item._uuid ? item : null);
    const world = makeWorld([
      makeMerchant({
        items: [{ uuid: item._uuid, qty: 5, startingQty: 5, unlimited: false }],
      }),
    ]);
    const gm = makeClient({ id: "gm", isGM: true, world, wire });
    const player = makeClient({ id: "p1", isGM: false, world, wire });
    const bystander = makeClient({ id: "p2", isGM: false, world, wire });
    globalThis.game = gm.game;

    const sess = openSession({ merchantId: "m-1", viewerUserId: "p1" });
    const frame = asClient(player, () =>
      emitMerchantEvent(MERCHANT_EVENTS.COMMIT_PURCHASE, {
        sessionId: sess.sessionId,
        itemUuid: item._uuid,
        qty: 2,
        totalGp: 200,
        commitId: "c-buy-1",
      }),
    );
    await receiveMerchantPayload(frame, "p1");

    const stored = asClient(gm, () => findMerchant("m-1"));
    assert.equal(stored.items[0].qty, 3, "stock 5 - 2 = 3 after buy");
    const buyer = gm.actors.get("actor-p1");
    assert.equal(
      buyer.system.currency.gp,
      9800,
      "GM deducted the buyer's funds",
    );
    assert.equal(
      buyer.items.contents.filter((owned) => owned.id !== "owned-sword").length,
      1,
      "GM added one purchased item stack to the buyer",
    );
    assert.equal(stored.goldOnHand, 700, "merchant gained 200 gp (base 100×2)");

    const stateUpdate = lastOf(player.inbox, MERCHANT_EVENTS.STATE_UPDATE);
    assert.ok(stateUpdate, "player received a targeted STATE_UPDATE");
    assert.deepEqual(
      stateUpdate.merchant,
      projectMerchantForSession(stored),
      "player session view converges with the safe projection of GM state",
    );

    const ack = lastOf(player.inbox, MERCHANT_EVENTS.COMMIT_RESULT);
    assert.ok(ack && ack.ok === true, "buyer acked ok:true");
    assert.equal(ack.commitId, "c-buy-1", "ack correlates by commitId");
    assert.deepEqual(
      bystander.inbox,
      [],
      "an unrelated player receives neither the request, state, nor result",
    );
    assert.ok(
      wire.log.every((entry) => !entry.deliveredTo.includes("p2")),
      "the transport never delivers this private transaction to the bystander",
    );
    ok("buy commit projects only to the buyer, preserves privacy, and acks");
  }

  /* ============================================================== *
   * 2. No double-charge / no oversell: two buys race the last unit
   * ============================================================== */
  {
    clearAllSessions();
    const wire = makeWire();
    const item = makeItem("Compendium.x.Item.last", 100);
    globalThis.fromUuid = async (uuid) => (uuid === item._uuid ? item : null);
    const world = makeWorld([
      makeMerchant({
        goldOnHand: 0,
        items: [{ uuid: item._uuid, qty: 1, startingQty: 1, unlimited: false }],
      }),
    ]);
    const gm = makeClient({ id: "gm", isGM: true, world, wire });
    const p1 = makeClient({ id: "p1", isGM: false, world, wire });
    const p2 = makeClient({ id: "p2", isGM: false, world, wire });
    globalThis.game = gm.game;

    const s1 = openSession({ merchantId: "m-1", viewerUserId: "p1" });
    const s2 = openSession({ merchantId: "m-1", viewerUserId: "p2" });
    const f1 = asClient(p1, () =>
      emitMerchantEvent(MERCHANT_EVENTS.COMMIT_PURCHASE, {
        sessionId: s1.sessionId,
        itemUuid: item._uuid,
        qty: 1,
        totalGp: 100,
        commitId: "race-1",
      }),
    );
    const f2 = asClient(p2, () =>
      emitMerchantEvent(MERCHANT_EVENTS.COMMIT_PURCHASE, {
        sessionId: s2.sessionId,
        itemUuid: item._uuid,
        qty: 1,
        totalGp: 100,
        commitId: "race-2",
      }),
    );
    // Deliver both to the GM concurrently — the per-merchant mutex must
    // serialize them so only the first sees stock.
    await Promise.all([
      receiveMerchantPayload(f1, "p1"),
      receiveMerchantPayload(f2, "p2"),
    ]);

    const stored = asClient(gm, () => findMerchant("m-1"));
    assert.equal(
      stored.items[0].qty,
      0,
      "exactly one unit sold; stock floored at 0",
    );
    assert.equal(
      stored.goldOnHand,
      100,
      "merchant charged for ONE unit, not two",
    );
    const chargedPlayers = ["actor-p1", "actor-p2"].filter(
      (id) => gm.actors.get(id).system.currency.gp === 9900,
    );
    assert.equal(
      chargedPlayers.length,
      1,
      "only the successful buyer was charged",
    );

    const results = allOf(
      wire.log.map((e) => e.payload),
      MERCHANT_EVENTS.COMMIT_RESULT,
    );
    const successes = results.filter((r) => r.ok === true);
    const oos = results.filter(
      (r) => r.ok === false && r.reason === "out-of-stock",
    );
    assert.equal(successes.length, 1, "exactly one buy succeeds");
    assert.equal(
      oos.length,
      1,
      "the loser is rejected out-of-stock (no double-charge)",
    );
    ok(
      "racing buys serialize: one sells, one out-of-stock, merchant charged once",
    );
  }

  /* ============================================================== *
   * 2b. One actor cannot double-spend across different shops
   * ============================================================== */
  {
    clearAllSessions();
    const wire = makeWire();
    const itemA = makeItem("Compendium.x.Item.shop-a", 100, { name: "A" });
    const itemB = makeItem("Compendium.x.Item.shop-b", 100, { name: "B" });
    globalThis.fromUuid = async (uuid) =>
      [itemA, itemB].find((item) => item._uuid === uuid) ?? null;
    const world = makeWorld([
      makeMerchant({
        id: "m-a",
        name: "Shop A",
        items: [
          { uuid: itemA._uuid, qty: 1, startingQty: 1, unlimited: false },
        ],
      }),
      makeMerchant({
        id: "m-b",
        name: "Shop B",
        items: [
          { uuid: itemB._uuid, qty: 1, startingQty: 1, unlimited: false },
        ],
      }),
    ]);
    const gm = makeClient({ id: "gm", isGM: true, world, wire });
    const player = makeClient({ id: "p1", isGM: false, world, wire });
    globalThis.game = gm.game;

    const actor = gm.actors.get("actor-p1");
    actor.system.currency.gp = 150;
    const originalUpdate = actor.update.bind(actor);
    let updateCalls = 0;
    let releaseFirstUpdate;
    let signalFirstUpdate;
    const firstUpdateStarted = new Promise((resolve) => {
      signalFirstUpdate = resolve;
    });
    const firstUpdateGate = new Promise((resolve) => {
      releaseFirstUpdate = resolve;
    });
    actor.update = async (changes) => {
      updateCalls += 1;
      if (updateCalls === 1) {
        signalFirstUpdate();
        await firstUpdateGate;
      }
      return originalUpdate(changes);
    };

    const sessionA = openSession({
      merchantId: "m-a",
      viewerUserId: "p1",
    });
    const sessionB = openSession({
      merchantId: "m-b",
      viewerUserId: "p1",
    });
    const commits = Promise.all([
      receiveMerchantPayload(
        {
          type: MERCHANT_EVENTS.COMMIT_PURCHASE,
          originUserId: "p1",
          sessionId: sessionA.sessionId,
          itemUuid: itemA._uuid,
          qty: 1,
          totalGp: 100,
          commitId: "cross-shop-a",
        },
        "p1",
      ),
      receiveMerchantPayload(
        {
          type: MERCHANT_EVENTS.COMMIT_PURCHASE,
          originUserId: "p1",
          sessionId: sessionB.sessionId,
          itemUuid: itemB._uuid,
          qty: 1,
          totalGp: 100,
          commitId: "cross-shop-b",
        },
        "p1",
      ),
    ]);
    await firstUpdateStarted;
    releaseFirstUpdate();
    await commits;

    assert.equal(actor.system.currency.gp, 50, "the wallet is charged once");
    assert.equal(
      updateCalls,
      1,
      "only the affordable purchase updates currency",
    );
    assert.equal(
      actor.items.contents.filter((item) => item.id !== "owned-sword").length,
      1,
      "only one purchased item is created",
    );
    const merchants = [findMerchant("m-a"), findMerchant("m-b")];
    assert.equal(
      merchants.filter((merchant) => merchant.items[0].qty === 0).length,
      1,
      "only one shop loses stock",
    );
    const results = allOf(
      wire.log.map((entry) => entry.payload),
      MERCHANT_EVENTS.COMMIT_RESULT,
    ).filter((result) =>
      ["cross-shop-a", "cross-shop-b"].includes(result.commitId),
    );
    assert.equal(results.filter((result) => result.ok).length, 1);
    assert.equal(
      results.filter(
        (result) => !result.ok && result.reason === "insufficient-funds",
      ).length,
      1,
      "the second shop receives an explicit insufficient-funds result",
    );
    assert.ok(
      lastOf(player.inbox, MERCHANT_EVENTS.COMMIT_RESULT),
      "the player receives transaction results",
    );
    ok("cross-shop purchases serialize one actor wallet");
  }

  /* ============================================================== *
   * 3. No lost update: a GM edit races a player purchase
   * ============================================================== */
  {
    clearAllSessions();
    const wire = makeWire();
    const item = makeItem("Compendium.x.Item.potion", 100);
    globalThis.fromUuid = async (uuid) => (uuid === item._uuid ? item : null);
    const world = makeWorld([
      makeMerchant({
        items: [{ uuid: item._uuid, qty: 4, startingQty: 4, unlimited: false }],
      }),
    ]);
    const gm = makeClient({ id: "gm", isGM: true, world, wire });
    const player = makeClient({ id: "p1", isGM: false, world, wire });
    globalThis.game = gm.game;

    const sess = openSession({ merchantId: "m-1", viewerUserId: "p1" });
    const buyFrame = asClient(player, () =>
      emitMerchantEvent(MERCHANT_EVENTS.COMMIT_PURCHASE, {
        sessionId: sess.sessionId,
        itemUuid: item._uuid,
        qty: 1,
        totalGp: 100,
        commitId: "lu-buy",
      }),
    );
    // GM renames + re-describes the merchant (a config edit through the same
    // mutex) at the same time the player buys. Neither write may clobber the
    // other. Name/description don't affect buy price, so the outcome is
    // order-independent.
    await Promise.all([
      receiveMerchantPayload(buyFrame, "p1"),
      commitMerchantWrite(
        "m-1",
        (fresh) => ({ ...fresh, name: "Restocked", description: "edited" }),
        { broadcast: true },
      ),
    ]);

    const stored = asClient(gm, () => findMerchant("m-1"));
    assert.equal(
      stored.name,
      "Restocked",
      "GM rename survived the concurrent buy",
    );
    assert.equal(
      stored.description,
      "edited",
      "GM edit survived the concurrent buy",
    );
    assert.equal(
      stored.items[0].qty,
      3,
      "player decrement survived the concurrent GM edit",
    );
    assert.equal(
      stored.goldOnHand,
      600,
      "player payment survived the concurrent GM edit",
    );
    ok("GM edit and player buy both persist — no lost update");
  }

  /* ============================================================== *
   * 4. Authoritative-GM lowest-id tiebreaker: two GMs, one decrement
   * ============================================================== */
  {
    clearAllSessions();
    const users = makeUserDirectory({
      activeGMId: null,
      users: [
        { id: "gm1", isGM: true, active: true, name: "GM 1" },
        { id: "gm2", isGM: true, active: true, name: "GM 2" },
        { id: "p1", isGM: false, active: true, name: "p1" },
      ],
    });
    const wire = makeWire(users);
    const item = makeItem("Compendium.x.Item.gem", 100);
    globalThis.fromUuid = async (uuid) => (uuid === item._uuid ? item : null);
    const world = makeWorld([
      makeMerchant({
        items: [{ uuid: item._uuid, qty: 3, startingQty: 3, unlimited: false }],
      }),
    ]);
    // No designated active GM (the connect/disconnect-churn window): the
    // shared directory deterministically elects the lowest active full-GM id.
    const gm1 = makeClient({ id: "gm1", isGM: true, world, wire });
    const gm2 = makeClient({ id: "gm2", isGM: true, world, wire });
    const player = makeClient({ id: "p1", isGM: false, world, wire });

    globalThis.game = gm1.game; // openSession is GM-side state
    const sess = openSession({ merchantId: "m-1", viewerUserId: "p1" });
    const frame = asClient(player, () =>
      emitMerchantEvent(MERCHANT_EVENTS.COMMIT_PURCHASE, {
        sessionId: sess.sessionId,
        itemUuid: item._uuid,
        qty: 1,
        totalGp: 100,
        commitId: "tie-1",
      }),
    );
    const purchaseDelivery = wire.log.find((entry) => entry.payload === frame);
    assert.deepEqual(
      purchaseDelivery?.deliveredTo,
      ["gm1"],
      "the request transport targets only the elected authoritative GM",
    );

    // Also offer the authenticated frame directly to the peer GM to retain the
    // defense-in-depth tiebreak assertion even with recipient-scoped delivery.
    globalThis.game = gm1.game;
    await receiveMerchantPayload(frame, "p1");
    globalThis.game = gm2.game;
    await receiveMerchantPayload(frame, "p1");

    globalThis.game = gm1.game;
    const stored = findMerchant("m-1");
    assert.equal(
      stored.items[0].qty,
      2,
      "stock decremented exactly once across two GMs",
    );
    assert.equal(
      stored.goldOnHand,
      600,
      "merchant charged exactly once (500 + 100)",
    );
    const results = allOf(
      wire.log.map((e) => e.payload),
      MERCHANT_EVENTS.COMMIT_RESULT,
    );
    assert.equal(results.length, 1, "exactly one GM emitted a COMMIT_RESULT");
    const peerState = lastOf(gm2.inbox, MERCHANT_EVENTS.STATE_UPDATE);
    assert.ok(peerState, "the authoritative GM invalidates the active peer GM");
    assert.equal(
      peerState.targetUserId,
      "gm2",
      "peer invalidation names only the intended GM",
    );
    assert.deepEqual(
      peerState.merchant,
      projectMerchantForSession(stored),
      "peer invalidation carries only the shared safe projection",
    );
    const peerDelivery = wire.log.find((entry) => entry.payload === peerState);
    assert.deepEqual(
      peerDelivery?.deliveredTo,
      ["gm2"],
      "peer invalidation is recipient-scoped at the transport",
    );
    ok("lowest-id GM writes once and targets a peer-GM invalidation");
  }

  /* ============================================================== *
   * 5a. Bargain seal on a BUY: buyer pays less; seal is burned
   * ============================================================== */
  {
    clearAllSessions();
    const wire = makeWire();
    const item = makeItem("Compendium.x.Item.cloak", 100);
    globalThis.fromUuid = async (uuid) => (uuid === item._uuid ? item : null);
    const world = makeWorld([
      makeMerchant({
        items: [{ uuid: item._uuid, qty: 5, startingQty: 5, unlimited: false }],
      }),
    ]);
    const gm = makeClient({ id: "gm", isGM: true, world, wire });
    const player = makeClient({ id: "p1", isGM: false, world, wire });
    globalThis.game = gm.game;

    const sess = openSession({ merchantId: "m-1", viewerUserId: "p1" });

    // Player rolls a bargain that clears the DC (25 vs DC 15, margin +10 →
    // success tier, deltaPct −10). GM arbitrates and issues a seal.
    const bargainFrame = asClient(player, () =>
      emitMerchantEvent(MERCHANT_EVENTS.BARGAIN_RESULT, {
        sessionId: sess.sessionId,
        itemUuid: item._uuid,
        side: "buy",
        rollTotal: 25,
        skillId: "per",
      }),
    );
    await receiveMerchantPayload(bargainFrame, "p1");
    const seal = lastOf(player.inbox, MERCHANT_EVENTS.BARGAIN_SEAL);
    assert.ok(seal && seal.sealId, "GM issued a bargain seal to the player");
    assert.equal(
      seal.deltaPct,
      -10,
      "success seal lowers the buy price by 10%",
    );
    const bargainActor = gm.game.actors.get("actor-p1");
    assert.equal(bargainActor.rollCalls, 1);
    await receiveMerchantPayload(bargainFrame, "p1");
    const replayedSeal = lastOf(player.inbox, MERCHANT_EVENTS.BARGAIN_SEAL);
    assert.equal(replayedSeal.sealId, seal.sealId);
    assert.equal(
      bargainActor.rollCalls,
      1,
      "a duplicate bargain frame replays its seal without another roll/chat",
    );

    // Player commits the purchase WITH the seal → pays 90, not 100.
    const buyFrame = asClient(player, () =>
      emitMerchantEvent(MERCHANT_EVENTS.COMMIT_PURCHASE, {
        sessionId: sess.sessionId,
        itemUuid: item._uuid,
        qty: 1,
        totalGp: 90,
        sealId: seal.sealId,
        commitId: "seal-buy-1",
      }),
    );
    await receiveMerchantPayload(buyFrame, "p1");
    let stored = asClient(gm, () => findMerchant("m-1"));
    assert.equal(
      stored.goldOnHand,
      590,
      "buy seal applied: merchant gained 90, not 100",
    );

    // Re-using the burned seal reprices at base (100) — the seal is one-shot.
    const buyFrame2 = asClient(player, () =>
      emitMerchantEvent(MERCHANT_EVENTS.COMMIT_PURCHASE, {
        sessionId: sess.sessionId,
        itemUuid: item._uuid,
        qty: 1,
        totalGp: 90,
        sealId: seal.sealId,
        commitId: "seal-buy-2",
      }),
    );
    await receiveMerchantPayload(buyFrame2, "p1");
    stored = asClient(gm, () => findMerchant("m-1"));
    assert.equal(
      stored.goldOnHand,
      690,
      "burned seal no longer discounts: +100 at base",
    );
    ok("buy bargain seal discounts the buyer and burns after one use");
  }

  /* ============================================================== *
   * 5b. Bargain seal on a SELL: seller receives more (sign flip)
   * ============================================================== */
  {
    clearAllSessions();
    const wire = makeWire();
    const world = makeWorld([makeMerchant({ goldOnHand: 1000 })]);
    const gm = makeClient({ id: "gm", isGM: true, world, wire });
    const player = makeClient({ id: "p1", isGM: false, world, wire });
    globalThis.game = gm.game;

    const sess = openSession({ merchantId: "m-1", viewerUserId: "p1" });

    // Success bargain on the sell side → seal deltaPct −10.
    const bargainFrame = asClient(player, () =>
      emitMerchantEvent(MERCHANT_EVENTS.BARGAIN_RESULT, {
        sessionId: sess.sessionId,
        itemUuid: "owned-sword",
        side: "sell",
        rollTotal: 25,
        skillId: "per",
      }),
    );
    await receiveMerchantPayload(bargainFrame, "p1");
    const seal = lastOf(player.inbox, MERCHANT_EVENTS.BARGAIN_SEAL);
    assert.ok(seal && seal.sealId, "GM issued a sell-side seal");

    // base sell = 100 × sellRatio 0.5 = 50. A −10% seal on the SELL side flips
    // sign → +10% payout = 55. Merchant pays out the HIGHER figure.
    const sellFrame = asClient(player, () =>
      emitMerchantEvent(MERCHANT_EVENTS.COMMIT_SALE, {
        sessionId: sess.sessionId,
        itemUuid: "owned-sword",
        qty: 1,
        totalGp: 55,
        sealId: seal.sealId,
        commitId: "seal-sell-1",
        itemSnapshot: {
          name: "Longsword",
          type: "weapon",
          system: { price: { value: 100, denomination: "gp" } },
        },
      }),
    );
    await receiveMerchantPayload(sellFrame, "p1");
    const stored = asClient(gm, () => findMerchant("m-1"));
    const seller = gm.actors.get("actor-p1");
    assert.equal(seller.items.get("owned-sword").system.quantity, 9);
    assert.equal(seller.system.currency.gp, 10055);
    assert.equal(
      stored.goldOnHand,
      945,
      "sell seal raises the payout: merchant paid 55 (1000 − 55), not 45 or 50",
    );
    const ack = lastOf(player.inbox, MERCHANT_EVENTS.COMMIT_RESULT);
    assert.ok(
      ack && ack.ok === true && ack.side === "sell",
      "seller acked ok:true",
    );
    ok("sell bargain seal raises the seller's payout (sign flips correctly)");
  }

  /* ============================================================== *
   * 6. Authenticated sender defeats a forged originUserId
   * ============================================================== */
  {
    clearAllSessions();
    const wire = makeWire();
    const item = makeItem("Compendium.x.Item.auth", 100);
    globalThis.fromUuid = async () => item;
    const world = makeWorld([
      makeMerchant({
        items: [{ uuid: item._uuid, qty: 2, startingQty: 2, unlimited: false }],
      }),
    ]);
    const gm = makeClient({ id: "gm", isGM: true, world, wire });
    makeClient({ id: "p1", isGM: false, world, wire });
    makeClient({ id: "p2", isGM: false, world, wire });
    globalThis.game = gm.game;
    const session = openSession({ merchantId: "m-1", viewerUserId: "p1" });

    await receiveMerchantPayload(
      {
        type: MERCHANT_EVENTS.COMMIT_PURCHASE,
        originUserId: "p1",
        sessionId: session.sessionId,
        itemUuid: item._uuid,
        qty: 1,
        totalGp: 100,
        commitId: "forged-origin",
      },
      "p2",
    );

    const stored = findMerchant("m-1");
    assert.equal(
      stored.items[0].qty,
      2,
      "forged sender cannot decrement stock",
    );
    assert.equal(
      stored.goldOnHand,
      500,
      "forged sender cannot change merchant gold",
    );
    ok("transport-authenticated sender defeats forged originUserId");
  }

  /* ============================================================== *
   * 6a. Invalid quantities fail closed instead of being coerced
   * ============================================================== */
  {
    clearAllSessions();
    const wire = makeWire();
    const item = makeItem("Compendium.x.Item.invalid-quantity", 100);
    globalThis.fromUuid = async () => item;
    const world = makeWorld([
      makeMerchant({
        items: [{ uuid: item._uuid, qty: 5, startingQty: 5, unlimited: false }],
      }),
    ]);
    const gm = makeClient({ id: "gm", isGM: true, world, wire });
    const player = makeClient({ id: "p1", isGM: false, world, wire });
    globalThis.game = gm.game;
    const session = openSession({ merchantId: "m-1", viewerUserId: "p1" });

    const invalidQuantities = [undefined, 0, -1, 1.5, 10000];
    for (const [index, qty] of invalidQuantities.entries()) {
      const frame = {
        type: MERCHANT_EVENTS.COMMIT_PURCHASE,
        originUserId: "p1",
        sessionId: session.sessionId,
        itemUuid: item._uuid,
        totalGp: 100,
        commitId: `invalid-qty-${index}`,
      };
      if (qty !== undefined) frame.qty = qty;
      await receiveMerchantPayload(frame, "p1");
    }

    await receiveMerchantPayload(
      {
        type: MERCHANT_EVENTS.COMMIT_PURCHASE,
        originUserId: "p1",
        sessionId: session.sessionId,
        itemUuid: item._uuid,
        qty: 0,
        totalGp: 100,
        commitId: "invalid-then-valid",
      },
      "p1",
    );
    await receiveMerchantPayload(
      {
        type: MERCHANT_EVENTS.COMMIT_PURCHASE,
        originUserId: "p1",
        sessionId: session.sessionId,
        itemUuid: item._uuid,
        qty: 1,
        totalGp: 100,
        commitId: "invalid-then-valid",
      },
      "p1",
    );
    await receiveMerchantPayload(
      {
        type: MERCHANT_EVENTS.COMMIT_SALE,
        originUserId: "p1",
        sessionId: session.sessionId,
        itemUuid: "owned-sword",
        qty: 1.5,
        totalGp: 50,
        commitId: "invalid-sell-quantity",
      },
      "p1",
    );

    const stored = findMerchant("m-1");
    assert.equal(stored.items[0].qty, 5, "invalid quantities change no stock");
    assert.equal(stored.goldOnHand, 500, "invalid quantities change no gold");
    assert.equal(
      gm.actors.get("actor-p1").system.currency.gp,
      10000,
      "invalid quantities cannot charge the actor",
    );
    const invalidResults = allOf(
      player.inbox,
      MERCHANT_EVENTS.COMMIT_RESULT,
    ).filter((result) => result.reason === "invalid-quantity");
    assert.equal(
      invalidResults.length,
      invalidQuantities.length + 2,
      "each invalid request receives invalid-quantity",
    );
    assert.equal(
      allOf(player.inbox, MERCHANT_EVENTS.COMMIT_RESULT)
        .filter((result) => result.commitId === "invalid-then-valid")
        .at(-1)?.reason,
      "commit-id-conflict",
      "a valid request cannot reuse an invalid request's commitId",
    );
    ok("zero, negative, fractional, missing, and oversized quantities reject");
  }

  /* ============================================================== *
   * 6b. Overflow prices reject before actor or merchant mutation
   * ============================================================== */
  {
    clearAllSessions();
    const wire = makeWire();
    const item = makeItem("Compendium.x.Item.overflow-price", Number.MAX_VALUE);
    globalThis.fromUuid = async () => item;
    const world = makeWorld([
      makeMerchant({
        items: [{ uuid: item._uuid, qty: 2, startingQty: 2, unlimited: false }],
      }),
    ]);
    const gm = makeClient({ id: "gm", isGM: true, world, wire });
    const player = makeClient({ id: "p1", isGM: false, world, wire });
    globalThis.game = gm.game;
    const actor = gm.actors.get("actor-p1");
    actor.items.get("owned-sword").system.price.value = Number.MAX_VALUE;
    const session = openSession({ merchantId: "m-1", viewerUserId: "p1" });

    await receiveMerchantPayload(
      {
        type: MERCHANT_EVENTS.COMMIT_PURCHASE,
        originUserId: "p1",
        sessionId: session.sessionId,
        itemUuid: item._uuid,
        qty: 1,
        totalGp: 1,
        commitId: "overflow-buy-price",
      },
      "p1",
    );
    await receiveMerchantPayload(
      {
        type: MERCHANT_EVENTS.COMMIT_SALE,
        originUserId: "p1",
        sessionId: session.sessionId,
        itemUuid: "owned-sword",
        qty: 1,
        totalGp: 1,
        commitId: "overflow-sell-price",
      },
      "p1",
    );

    const stored = findMerchant("m-1");
    assert.equal(stored.items[0].qty, 2, "overflow changes no stock");
    assert.equal(stored.goldOnHand, 500, "overflow changes no merchant gold");
    assert.equal(actor.system.currency.gp, 10000, "overflow changes no wallet");
    assert.equal(
      actor.items.get("owned-sword").system.quantity,
      10,
      "overflow changes no inventory",
    );
    assert.equal(
      allOf(player.inbox, MERCHANT_EVENTS.COMMIT_RESULT).filter(
        (result) => result.reason === "invalid-price",
      ).length,
      2,
      "buy and sell both report invalid-price",
    );
    ok("overflow buy and sell prices reject before mutation");
  }

  /* ============================================================== *
   * 7. Commit IDs are replay-safe
   * ============================================================== */
  {
    clearAllSessions();
    const wire = makeWire();
    const item = makeItem("Compendium.x.Item.replay", 100);
    globalThis.fromUuid = async () => item;
    const world = makeWorld([
      makeMerchant({
        items: [{ uuid: item._uuid, qty: 2, startingQty: 2, unlimited: false }],
      }),
    ]);
    const gm = makeClient({ id: "gm", isGM: true, world, wire });
    makeClient({ id: "p1", isGM: false, world, wire });
    globalThis.game = gm.game;
    const session = openSession({ merchantId: "m-1", viewerUserId: "p1" });
    const frame = {
      type: MERCHANT_EVENTS.COMMIT_PURCHASE,
      originUserId: "p1",
      sessionId: session.sessionId,
      itemUuid: item._uuid,
      qty: 1,
      totalGp: 100,
      commitId: "same-commit",
    };

    await receiveMerchantPayload(frame, "p1");
    await receiveMerchantPayload(frame, "p1");

    const stored = findMerchant("m-1");
    assert.equal(stored.items[0].qty, 1, "replayed commit decrements once");
    assert.equal(stored.goldOnHand, 600, "replayed commit credits once");
    ok(
      "duplicate commitId returns the cached result without a second mutation",
    );
  }

  /* ============================================================== *
   * 7a. A commitId cannot be reused for a different request
   * ============================================================== */
  {
    clearAllSessions();
    const wire = makeWire();
    const item = makeItem("Compendium.x.Item.replay-conflict", 100);
    globalThis.fromUuid = async () => item;
    const world = makeWorld([
      makeMerchant({
        items: [{ uuid: item._uuid, qty: 4, startingQty: 4, unlimited: false }],
      }),
    ]);
    const gm = makeClient({ id: "gm", isGM: true, world, wire });
    const player = makeClient({ id: "p1", isGM: false, world, wire });
    globalThis.game = gm.game;
    const session = openSession({ merchantId: "m-1", viewerUserId: "p1" });
    const base = {
      type: MERCHANT_EVENTS.COMMIT_PURCHASE,
      originUserId: "p1",
      sessionId: session.sessionId,
      itemUuid: item._uuid,
      qty: 1,
      totalGp: 100,
      commitId: "reused-for-different-payload",
    };

    await receiveMerchantPayload(base, "p1");
    await receiveMerchantPayload({ ...base, qty: 2, totalGp: 200 }, "p1");

    const stored = findMerchant("m-1");
    assert.equal(stored.items[0].qty, 3, "conflicting replay changes no stock");
    assert.equal(stored.goldOnHand, 600, "conflicting replay changes no gold");
    assert.equal(
      gm.actors.get("actor-p1").system.currency.gp,
      9900,
      "conflicting replay does not charge the actor",
    );
    assert.equal(
      lastOf(player.inbox, MERCHANT_EVENTS.COMMIT_RESULT)?.reason,
      "commit-id-conflict",
      "the player receives an explicit commit-id conflict",
    );
    ok("commitId reuse with a different payload fails closed");
  }

  /* ============================================================== *
   * 7b. A broadcast failure cannot make a durable commit replayable
   * ============================================================== */
  {
    clearAllSessions();
    const wire = makeWire();
    const item = makeItem("Compendium.x.Item.broadcast-replay", 100);
    globalThis.fromUuid = async () => item;
    const world = makeWorld([
      makeMerchant({
        items: [{ uuid: item._uuid, qty: 2, startingQty: 2, unlimited: false }],
      }),
    ]);
    const gm = makeClient({ id: "gm", isGM: true, world, wire });
    const player = makeClient({ id: "p1", isGM: false, world, wire });
    globalThis.game = gm.game;
    const session = openSession({ merchantId: "m-1", viewerUserId: "p1" });
    const frame = {
      type: MERCHANT_EVENTS.COMMIT_PURCHASE,
      originUserId: "p1",
      sessionId: session.sessionId,
      itemUuid: item._uuid,
      qty: 1,
      totalGp: 100,
      commitId: "broadcast-failure-replay",
    };

    wire.failNext(MERCHANT_EVENTS.STATE_UPDATE);
    await receiveMerchantPayload(frame, "p1");
    await receiveMerchantPayload(frame, "p1");

    const stored = findMerchant("m-1");
    assert.equal(stored.items[0].qty, 1, "stock is decremented only once");
    assert.equal(stored.goldOnHand, 600, "merchant is credited only once");
    assert.equal(
      gm.actors.get("actor-p1").system.currency.gp,
      9900,
      "the actor is charged only once",
    );
    assert.equal(
      gm.actors
        .get("actor-p1")
        .items.contents.filter((owned) => owned.id !== "owned-sword").length,
      1,
      "the actor receives only one purchased stack",
    );
    assert.equal(
      allOf(player.inbox, MERCHANT_EVENTS.COMMIT_RESULT).length,
      2,
      "the original result and cached replay both reach the player",
    );
    ok("successful result is cached before a best-effort state broadcast");
  }

  /* ============================================================== *
   * 7c. Canonical merchant read-back wins over apply-then-throw
   * ============================================================== */
  {
    clearAllSessions();
    const wire = makeWire();
    const item = makeItem("Compendium.x.Item.applied-write", 100);
    globalThis.fromUuid = async () => item;
    const world = makeWorld([
      makeMerchant({
        items: [{ uuid: item._uuid, qty: 2, startingQty: 2, unlimited: false }],
      }),
    ]);
    const gm = makeClient({ id: "gm", isGM: true, world, wire });
    const player = makeClient({ id: "p1", isGM: false, world, wire });
    globalThis.game = gm.game;
    const session = openSession({ merchantId: "m-1", viewerUserId: "p1" });

    world.failNextSetAfterApply();
    await receiveMerchantPayload(
      {
        type: MERCHANT_EVENTS.COMMIT_PURCHASE,
        originUserId: "p1",
        sessionId: session.sessionId,
        itemUuid: item._uuid,
        qty: 1,
        totalGp: 100,
        commitId: "merchant-applied-then-threw",
      },
      "p1",
    );

    const stored = findMerchant("m-1");
    assert.equal(stored.items[0].qty, 1, "applied stock decrement is retained");
    assert.equal(stored.goldOnHand, 600, "applied merchant credit is retained");
    assert.equal(
      gm.actors.get("actor-p1").system.currency.gp,
      9900,
      "the matching canonical merchant write does not trigger actor rollback",
    );
    assert.equal(
      lastOf(player.inbox, MERCHANT_EVENTS.COMMIT_RESULT)?.ok,
      true,
      "the canonically applied transaction is acknowledged as successful",
    );
    ok("canonical read-back accepts an applied merchant write that threw");
  }

  /* ============================================================== *
   * 7d. Altered merchant writes restore both sides of the transaction
   * ============================================================== */
  {
    clearAllSessions();
    const wire = makeWire();
    const item = makeItem("Compendium.x.Item.altered-write", 100);
    globalThis.fromUuid = async () => item;
    const world = makeWorld([
      makeMerchant({
        items: [{ uuid: item._uuid, qty: 2, startingQty: 2, unlimited: false }],
      }),
    ]);
    const gm = makeClient({ id: "gm", isGM: true, world, wire });
    const player = makeClient({ id: "p1", isGM: false, world, wire });
    globalThis.game = gm.game;
    const session = openSession({ merchantId: "m-1", viewerUserId: "p1" });

    world.alterNextSet();
    await receiveMerchantPayload(
      {
        type: MERCHANT_EVENTS.COMMIT_PURCHASE,
        originUserId: "p1",
        sessionId: session.sessionId,
        itemUuid: item._uuid,
        qty: 1,
        totalGp: 100,
        commitId: "merchant-write-altered",
      },
      "p1",
    );

    const stored = findMerchant("m-1");
    assert.equal(stored.items[0].qty, 2, "merchant stock is restored exactly");
    assert.equal(stored.goldOnHand, 500, "merchant gold is restored exactly");
    assert.equal(
      gm.actors.get("actor-p1").system.currency.gp,
      10000,
      "the actor wallet is restored exactly",
    );
    assert.equal(
      gm.actors
        .get("actor-p1")
        .items.contents.filter((owned) => owned.id !== "owned-sword").length,
      0,
      "the delivered item is removed during compensation",
    );
    assert.equal(
      lastOf(player.inbox, MERCHANT_EVENTS.COMMIT_RESULT)?.reason,
      "merchant-write-failed",
      "the player receives a clean restored-write failure",
    );
    ok("altered merchant persistence restores actor and merchant state");
  }

  /* ============================================================== *
   * 7e. Session and authority are revalidated after lock acquisition
   * ============================================================== */
  {
    clearAllSessions();
    const wire = makeWire();
    const item = makeItem("Compendium.x.Item.closed-session", 100);
    globalThis.fromUuid = async () => item;
    const world = makeWorld([
      makeMerchant({
        items: [{ uuid: item._uuid, qty: 2, startingQty: 2, unlimited: false }],
      }),
    ]);
    const gm = makeClient({ id: "gm", isGM: true, world, wire });
    makeClient({ id: "p1", isGM: false, world, wire });
    globalThis.game = gm.game;
    const session = openSession({ merchantId: "m-1", viewerUserId: "p1" });
    let releaseLock;
    let lockEntered;
    const entered = new Promise((resolve) => {
      lockEntered = resolve;
    });
    const hold = new Promise((resolve) => {
      releaseLock = resolve;
    });
    const blocker = commitMerchantWrite("m-1", async () => {
      lockEntered();
      await hold;
      return null;
    });
    await entered;
    const pending = receiveMerchantPayload(
      {
        type: MERCHANT_EVENTS.COMMIT_PURCHASE,
        originUserId: "p1",
        sessionId: session.sessionId,
        itemUuid: item._uuid,
        qty: 1,
        totalGp: 100,
        commitId: "closed-while-queued",
      },
      "p1",
    );
    closeSession(session.sessionId);
    releaseLock();
    await Promise.all([blocker, pending]);

    let stored = findMerchant("m-1");
    assert.equal(stored.items[0].qty, 2, "closed session changes no stock");
    assert.equal(stored.goldOnHand, 500, "closed session changes no gold");
    assert.equal(
      gm.actors.get("actor-p1").system.currency.gp,
      10000,
      "closed session cannot charge after waiting for a lock",
    );

    const authoritySession = openSession({
      merchantId: "m-1",
      viewerUserId: "p1",
    });
    let releaseAuthorityLock;
    let authorityLockEntered;
    const authorityEntered = new Promise((resolve) => {
      authorityLockEntered = resolve;
    });
    const authorityHold = new Promise((resolve) => {
      releaseAuthorityLock = resolve;
    });
    const authorityBlocker = commitMerchantWrite("m-1", async () => {
      authorityLockEntered();
      await authorityHold;
      return null;
    });
    await authorityEntered;
    const authorityPending = receiveMerchantPayload(
      {
        type: MERCHANT_EVENTS.COMMIT_PURCHASE,
        originUserId: "p1",
        sessionId: authoritySession.sessionId,
        itemUuid: item._uuid,
        qty: 1,
        totalGp: 100,
        commitId: "authority-lost-while-queued",
      },
      "p1",
    );
    gm.game.user.isGM = false;
    releaseAuthorityLock();
    await Promise.all([authorityBlocker, authorityPending]);
    gm.game.user.isGM = true;

    stored = findMerchant("m-1");
    assert.equal(stored.items[0].qty, 2, "lost authority changes no stock");
    assert.equal(stored.goldOnHand, 500, "lost authority changes no gold");
    assert.equal(
      gm.actors.get("actor-p1").system.currency.gp,
      10000,
      "lost authority cannot charge after waiting for a lock",
    );
    ok("queued commits revalidate their live session and GM authority");
  }

  /* ============================================================== *
   * 8. Different-shop writes share a store-wide queue
   * ============================================================== */
  {
    clearAllSessions();
    const wire = makeWire();
    const world = makeWorld([
      makeMerchant({ id: "m-a", name: "A", goldOnHand: 10 }),
      makeMerchant({ id: "m-b", name: "B", goldOnHand: 20 }),
    ]);
    const gm = makeClient({ id: "gm", isGM: true, world, wire });
    globalThis.game = gm.game;
    const a = findMerchant("m-a");
    const b = findMerchant("m-b");
    await Promise.all([
      upsertMerchant({ ...a, goldOnHand: 11 }),
      upsertMerchant({ ...b, goldOnHand: 21 }),
    ]);
    assert.equal(findMerchant("m-a").goldOnHand, 11);
    assert.equal(findMerchant("m-b").goldOnHand, 21);
    ok("store-wide queue preserves concurrent writes to different shops");
  }

  /* ============================================================== *
   * 9. Missing authoritative price fails closed
   * ============================================================== */
  {
    clearAllSessions();
    const wire = makeWire();
    const itemUuid = "Compendium.x.Item.missing";
    globalThis.fromUuid = async () => null;
    const world = makeWorld([
      makeMerchant({
        items: [{ uuid: itemUuid, qty: 1, startingQty: 1, unlimited: false }],
      }),
    ]);
    const gm = makeClient({ id: "gm", isGM: true, world, wire });
    const player = makeClient({ id: "p1", isGM: false, world, wire });
    globalThis.game = gm.game;
    const session = openSession({ merchantId: "m-1", viewerUserId: "p1" });
    await receiveMerchantPayload(
      {
        type: MERCHANT_EVENTS.COMMIT_PURCHASE,
        originUserId: "p1",
        sessionId: session.sessionId,
        itemUuid,
        qty: 1,
        totalGp: 100,
        commitId: "missing-price",
      },
      "p1",
    );
    assert.equal(
      findMerchant("m-1").items[0].qty,
      1,
      "stock remains available",
    );
    assert.equal(
      lastOf(player.inbox, MERCHANT_EVENTS.COMMIT_RESULT)?.reason,
      "no-price",
    );
    ok(
      "purchase repricing failure leaves stock untouched and reports no-price",
    );
  }

  process.stdout.write(
    `merchant-socket-economy validation passed (${passed} invariants)\n`,
  );
} finally {
  if (savedGame === undefined) delete globalThis.game;
  else globalThis.game = savedGame;
  if (savedUi === undefined) delete globalThis.ui;
  else globalThis.ui = savedUi;
  if (savedFromUuid === undefined) delete globalThis.fromUuid;
  else globalThis.fromUuid = savedFromUuid;
}
