import assert from "node:assert/strict";

/**
 * Two-client socket ECONOMY integration harness.
 *
 * The existing test-merchant-socket.mjs covers routing (echo-suppression,
 * targeting, resume, malformed-frame rejection). This file covers the
 * money-moving COMMIT loop end-to-end by wiring a *fake transport* between a
 * simulated GM client and a player client: a player `emit()` is routed into the
 * GM's real `receiveMerchantPayload`, which runs the REAL handlers
 * (handleCommitPurchase / handleCommitSale / handleBargainResult), the REAL
 * per-merchant mutex, and the REAL store reducers (decrementInventory,
 * adjustMerchantGold, normalizeMerchant, upsertMerchant). Only the socket
 * transport and the Foundry game/actors/settings/fromUuid globals are mocked —
 * the handlers and pricing are the production code, so this exercises the
 * commit loop, not a re-implementation of it.
 *
 * Invariants asserted:
 *  - buy commit converges: GM stored merchant === the merchant the player's
 *    session view receives via STATE_UPDATE, and the buyer is acked ok:true;
 *  - no double-charge / no oversell when two buys race the last unit (mutex);
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
import { openSession, clearAllSessions } from "./merchant/session-state.js";
import {
  MERCHANT_SETTING_KEY,
  findMerchant,
  normalizeMerchant,
  upsertMerchant,
} from "./merchant/store.js";

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
  return {
    get: (_module, key) => (key === MERCHANT_SETTING_KEY ? store : undefined),
    set: (_module, key, value) => {
      if (key === MERCHANT_SETTING_KEY) store = value;
    },
  };
}

/** A broadcast wire: every emit is delivered into every OTHER client's inbox
 *  (Foundry sockets broadcast to all clients; each filters by target). */
function makeWire() {
  const clients = new Map();
  const log = [];
  return {
    register(client) {
      clients.set(client.id, client);
    },
    deliver(fromId, name, payload) {
      log.push({ fromId, name, payload });
      for (const [id, client] of clients) {
        if (id === fromId) continue;
        client.inbox.push(payload);
      }
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
      for (const id of ids) itemMap.delete(id);
      return ids;
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
 * Build a client context. `users`/`actors` default to a lone-GM world; callers
 * override for multi-GM or player contexts. The socket is the fake transport.
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
      users: users ?? {
        activeGM: { id },
        get: (uid) => ({
          id: uid,
          active: true,
          isGM: false,
          name: uid,
          character: actorList.find((actor) => actor.id === `actor-${uid}`) ?? null,
        }),
        forEach() {},
      },
      actors: actorCollection,
      settings: world,
      socket: {
        emit: (name, payload) => wire.deliver(id, name, payload),
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
    await receiveMerchantPayload(frame);

    const stored = asClient(gm, () => findMerchant("m-1"));
    assert.equal(stored.items[0].qty, 3, "stock 5 - 2 = 3 after buy");
    const buyer = gm.actors.get("actor-p1");
    assert.equal(buyer.system.currency.gp, 9800, "GM deducted the buyer's funds");
    assert.equal(
      buyer.items.contents.filter((owned) => owned.id !== "owned-sword").length,
      1,
      "GM added one purchased item stack to the buyer",
    );
    assert.equal(stored.goldOnHand, 700, "merchant gained 200 gp (base 100×2)");

    const stateUpdate = lastOf(player.inbox, MERCHANT_EVENTS.STATE_UPDATE);
    assert.ok(stateUpdate, "player received a STATE_UPDATE broadcast");
    assert.deepEqual(
      stateUpdate.merchant,
      stored,
      "player session view converges with GM stored merchant",
    );

    const ack = lastOf(player.inbox, MERCHANT_EVENTS.COMMIT_RESULT);
    assert.ok(ack && ack.ok === true, "buyer acked ok:true");
    assert.equal(ack.commitId, "c-buy-1", "ack correlates by commitId");
    ok("buy commit converges GM↔player state and acks the buyer");
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
    await Promise.all([receiveMerchantPayload(f1), receiveMerchantPayload(f2)]);

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
    assert.equal(chargedPlayers.length, 1, "only the successful buyer was charged");

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
      receiveMerchantPayload(buyFrame),
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
    const wire = makeWire();
    const item = makeItem("Compendium.x.Item.gem", 100);
    globalThis.fromUuid = async (uuid) => (uuid === item._uuid ? item : null);
    const world = makeWorld([
      makeMerchant({
        items: [{ uuid: item._uuid, qty: 3, startingQty: 3, unlimited: false }],
      }),
    ]);
    // No designated active GM (the connect/disconnect-churn window): both GMs
    // would otherwise both handle the frame and double-decrement.
    const gmUsers = () => ({
      activeGM: null,
      get: (uid) => ({
        id: uid,
        active: true,
        isGM: uid.startsWith("gm"),
        name: uid,
      }),
      forEach: (cb) => {
        cb({ id: "gm1", isGM: true, active: true });
        cb({ id: "gm2", isGM: true, active: true });
      },
    });
    const gm1 = makeClient({
      id: "gm1",
      isGM: true,
      world,
      wire,
      users: gmUsers(),
    });
    const gm2 = makeClient({
      id: "gm2",
      isGM: true,
      world,
      wire,
      users: gmUsers(),
    });
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
    // Broadcast delivers the frame to BOTH GM clients. Only the lowest id acts.
    globalThis.game = gm1.game;
    await receiveMerchantPayload(frame);
    globalThis.game = gm2.game;
    await receiveMerchantPayload(frame);

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
    ok("lowest-id GM tiebreaker prevents a double-write on a multi-GM table");
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
    await receiveMerchantPayload(bargainFrame);
    const seal = lastOf(player.inbox, MERCHANT_EVENTS.BARGAIN_SEAL);
    assert.ok(seal && seal.sealId, "GM issued a bargain seal to the player");
    assert.equal(
      seal.deltaPct,
      -10,
      "success seal lowers the buy price by 10%",
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
    await receiveMerchantPayload(buyFrame);
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
    await receiveMerchantPayload(buyFrame2);
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
    await receiveMerchantPayload(bargainFrame);
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
    await receiveMerchantPayload(sellFrame);
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
    assert.equal(stored.items[0].qty, 2, "forged sender cannot decrement stock");
    assert.equal(stored.goldOnHand, 500, "forged sender cannot change merchant gold");
    ok("transport-authenticated sender defeats forged originUserId");
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
    ok("duplicate commitId returns the cached result without a second mutation");
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
    assert.equal(findMerchant("m-1").items[0].qty, 1, "stock remains available");
    assert.equal(
      lastOf(player.inbox, MERCHANT_EVENTS.COMMIT_RESULT)?.reason,
      "no-price",
    );
    ok("purchase repricing failure leaves stock untouched and reports no-price");
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
